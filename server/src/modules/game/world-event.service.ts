/**
 * 全服世界事件服务（Phase 1）。
 *
 * 玩法：按 day/week/month 开一个全服共同目标（可从任务池随机抽一条），进度取「世界熟练度」点数
 * 差值（复用 GlobalProficiencyService，零新增计数、零改战斗链路），跨 25/50/75/100% 里程碑逐级解锁
 * 全服 buff，达成后可领一次世界奖励。未达成世界等级照常涨（原有压力不变），只是拿不到额外奖励。
 *
 * 单一真相源约束：
 *  - 进度 = 当前世界熟练度点数 − 周期起始快照；本服务不另存进度。
 *  - 全服 buff 由「已达成里程碑 ∩ buff 配置」派生，缓存到内存供 4 个生效点同步读（见 getActiveBuffValues）。
 *
 * 零侵入 & 门禁：本文件与 world-event.util / config 均为新建，不触碰 combat-system（G9 零余量）、
 * game.service（G1/G6）、game-command.handler（G5）。
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { ChatService } from '../chat/chat.service';
import { GlobalProficiencyService, WORLD_PROFICIENCY_NAME } from './global-proficiency.service';
import { CheckinRewardService, } from './checkin-reward.service';
import type { CheckinRewardEntry } from './checkin-config.defaults';
import {
  WORLD_EVENT_CONFIG_KEYS as WEK,
  DEFAULT_WORLD_EVENT,
  DEFAULT_WORLD_EVENT_MILESTONES,
  DEFAULT_WORLD_EVENT_TASK_POOL,
  DEFAULT_WORLD_EVENT_REWARDS,
  DEFAULT_WORLD_EVENT_BUFFS,
  FALLBACK_KILL_TASK,
  pickWorldEventTask,
  type WorldEventPeriod,
  type WorldEventMetric,
  type WorldEventTaskDef,
  type WorldEventMilestoneReward,
  type WorldEventBuffDef,
} from '../../config/world-event.config';
import {
  computeCycleWindow,
  computeActiveBuffs,
  adjustGoal,
  asciiProgressBar,
  formatRemaining,
  type ActiveBuffValues,
} from './world-event.util';

/** 一个周期行（Prisma WorldEventCycle 的结构化视图，字段够用即可） */
type Cycle = {
  id: number;
  cycleId: string;
  period: string;
  taskKey: string;
  taskTitle: string;
  metric: string;
  startPoints: number;
  goalPoints: number;
  startAt: Date;
  endAt: Date;
  status: string;
  reached: any;
  lastStep: number;
  finalPoints: number | null;
  graceEndAt: Date | null;
  settledAt: Date | null;
};

/** 一次批量读取后的运行期配置 */
interface RuntimeConfig {
  enabled: boolean;
  period: WorldEventPeriod;
  cycleDays: number;
  autoStart: boolean;
  graceHours: number;
  taskSource: 'fixed' | 'pool';
  taskPool: WorldEventTaskDef[];
  randomPick: boolean;
  panelTitleOverride: string;
  metric: WorldEventMetric;
  baseGoal: number;
  goalAutoAdjust: boolean;
  goalAdjustMin: number;
  goalAdjustMax: number;
  milestones: number[];
  startPointsFallback: number;
  rewards: WorldEventMilestoneReward[];
  buffs: WorldEventBuffDef[];
  announceOnMilestone: boolean;
  announceOnStart: boolean;
  progressBroadcastStep: number;
  panelTitle: string;
  panelDesc: string;
}

@Injectable()
export class WorldEventService implements OnModuleInit {
  private readonly logger = new Logger(WorldEventService.name);
  /** cron 运行锁（单实例内防重入；跨实例靠数据库状态机 + updateMany 抢占） */
  private running = false;
  /** 全服 buff 同步缓存，供 schedule / checkin-reward / time-settle 生效点读取 */
  private buffCache: ActiveBuffValues = { cargoPods: 0, checkinExpPct: 0, vitalityRegenPct: 0, challengeBox: 0 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly chatService: ChatService,
    private readonly proficiency: GlobalProficiencyService,
    private readonly checkinReward: CheckinRewardService,
  ) {}

  async onModuleInit(): Promise<void> {
    // 启动预热 buff 缓存（失败不抛，按零 buff 运行，等下个 tick 修正）
    await this.refreshBuffCache().catch((err) =>
      this.logger.warn(`世界事件 buff 缓存预热失败（忽略）: ${err?.message ?? err}`),
    );
  }

  // ==================== 配置读取 ====================

  private async loadConfig(): Promise<RuntimeConfig> {
    const [
      enabled, periodRaw, cycleDays, autoStart, graceHours,
      taskSourceRaw, taskPoolRaw, randomPick, panelTitleOverride,
      metricRaw, baseGoal, goalAutoAdjust, goalAdjustMin, goalAdjustMax, milestonesRaw,
      startPointsFallback, rewardsRaw, buffsRaw,
      announceOnMilestone, announceOnStart, progressBroadcastStep, panelTitle, panelDesc,
    ] = await Promise.all([
      this.systemConfig.get(WEK.enabled, DEFAULT_WORLD_EVENT.enabled),
      this.systemConfig.get(WEK.period, DEFAULT_WORLD_EVENT.period),
      this.systemConfig.get(WEK.cycleDays, DEFAULT_WORLD_EVENT.cycleDays),
      this.systemConfig.get(WEK.autoStart, DEFAULT_WORLD_EVENT.autoStart),
      this.systemConfig.get(WEK.graceHours, DEFAULT_WORLD_EVENT.graceHours),
      this.systemConfig.get(WEK.taskSource, DEFAULT_WORLD_EVENT.taskSource),
      this.systemConfig.get(WEK.taskPool, { tasks: DEFAULT_WORLD_EVENT_TASK_POOL }),
      this.systemConfig.get(WEK.randomPick, DEFAULT_WORLD_EVENT.randomPick),
      this.systemConfig.get(WEK.panelTitleOverride, DEFAULT_WORLD_EVENT.panelTitleOverride),
      this.systemConfig.get(WEK.metric, DEFAULT_WORLD_EVENT.metric),
      this.systemConfig.get(WEK.baseGoal, DEFAULT_WORLD_EVENT.baseGoal),
      this.systemConfig.get(WEK.goalAutoAdjust, DEFAULT_WORLD_EVENT.goalAutoAdjust),
      this.systemConfig.get(WEK.goalAdjustMin, DEFAULT_WORLD_EVENT.goalAdjustMin),
      this.systemConfig.get(WEK.goalAdjustMax, DEFAULT_WORLD_EVENT.goalAdjustMax),
      this.systemConfig.get(WEK.milestones, DEFAULT_WORLD_EVENT_MILESTONES),
      this.systemConfig.get(WEK.startPointsFallback, DEFAULT_WORLD_EVENT.startPointsFallback),
      this.systemConfig.get(WEK.rewards, DEFAULT_WORLD_EVENT_REWARDS),
      this.systemConfig.get(WEK.buffs, DEFAULT_WORLD_EVENT_BUFFS),
      this.systemConfig.get(WEK.announceOnMilestone, DEFAULT_WORLD_EVENT.announceOnMilestone),
      this.systemConfig.get(WEK.announceOnStart, DEFAULT_WORLD_EVENT.announceOnStart),
      this.systemConfig.get(WEK.progressBroadcastStep, DEFAULT_WORLD_EVENT.progressBroadcastStep),
      this.systemConfig.get(WEK.panelTitle, DEFAULT_WORLD_EVENT.panelTitle),
      this.systemConfig.get(WEK.panelDesc, DEFAULT_WORLD_EVENT.panelDesc),
    ]);

    const period: WorldEventPeriod = ['day', 'week', 'month'].includes(String(periodRaw))
      ? (periodRaw as WorldEventPeriod)
      : DEFAULT_WORLD_EVENT.period;
    const tasks = Array.isArray((taskPoolRaw as any)?.tasks) ? (taskPoolRaw as any).tasks : DEFAULT_WORLD_EVENT_TASK_POOL;
    const milestones = Array.isArray(milestonesRaw) && milestonesRaw.length
      ? milestonesRaw.map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
      : [...DEFAULT_WORLD_EVENT_MILESTONES];

    return {
      enabled: enabled !== false,
      period,
      cycleDays: Number(cycleDays) || DEFAULT_WORLD_EVENT.cycleDays,
      autoStart: autoStart !== false,
      graceHours: Number.isFinite(graceHours) ? Number(graceHours) : DEFAULT_WORLD_EVENT.graceHours,
      taskSource: taskSourceRaw === 'fixed' ? 'fixed' : 'pool',
      taskPool: tasks,
      randomPick: randomPick !== false,
      panelTitleOverride: String(panelTitleOverride || ''),
      metric: (metricRaw as WorldEventMetric) || 'kill',
      baseGoal: Number(baseGoal) || DEFAULT_WORLD_EVENT.baseGoal,
      goalAutoAdjust: goalAutoAdjust !== false,
      goalAdjustMin: Number(goalAdjustMin) || DEFAULT_WORLD_EVENT.goalAdjustMin,
      goalAdjustMax: Number(goalAdjustMax) || DEFAULT_WORLD_EVENT.goalAdjustMax,
      milestones,
      startPointsFallback: Number(startPointsFallback) || 0,
      rewards: Array.isArray((rewardsRaw as any)?.milestones) ? (rewardsRaw as any).milestones : [],
      buffs: Array.isArray((buffsRaw as any)?.buffs) ? (buffsRaw as any).buffs : [],
      announceOnMilestone: announceOnMilestone !== false,
      announceOnStart: announceOnStart !== false,
      progressBroadcastStep: Number(progressBroadcastStep) || 0,
      panelTitle: String(panelTitle || DEFAULT_WORLD_EVENT.panelTitle),
      panelDesc: String(panelDesc || DEFAULT_WORLD_EVENT.panelDesc),
    };
  }

  // ==================== 周期查询 ====================

  private async getActiveCycle(): Promise<Cycle | null> {
    return (await this.prisma.worldEventCycle.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { id: 'asc' },
    })) as unknown as Cycle | null;
  }

  /** 可领奖周期：进行中的 ACTIVE，或已结算且领取窗口未关闭的最近 SETTLED */
  private async claimableCycle(now = Date.now()): Promise<Cycle | null> {
    const active = await this.getActiveCycle();
    if (active) return active;
    const settled = (await this.prisma.worldEventCycle.findFirst({
      where: { status: 'SETTLED', graceEndAt: { gt: new Date(now) } },
      orderBy: { settledAt: 'desc' },
    })) as unknown as Cycle | null;
    return settled;
  }

  // ==================== 进度 ====================

  /** 进度 = 世界熟练度当前点数 − 周期起始快照；点数被管理员下调时自愈重置基准 */
  async currentProgress(cycle: Cycle): Promise<{ current: number; goal: number; percent: number }> {
    const now = await this.proficiency.getPoints(WORLD_PROFICIENCY_NAME);
    const start = Number(cycle.startPoints) || 0;
    const goal = Number(cycle.goalPoints) || 1;
    if (now < start) {
      // replacePoints 整表替换 或 setWorldLevel 逆运算覆写都会让点数回退 → 重置基准，进度归零不报错
      this.logger.warn(`世界熟练度回退（${start} → ${now}），重置周期 ${cycle.cycleId} 基准`);
      await this.prisma.worldEventCycle.update({ where: { id: cycle.id }, data: { startPoints: now } });
      cycle.startPoints = now;
      return { current: 0, goal, percent: 0 };
    }
    const current = now - start;
    const percent = Math.max(0, Math.min(100, Math.floor((current / goal) * 100)));
    return { current, goal, percent };
  }

  // ==================== 周期流转 ====================

  /** 自动开启入口（cron 调用）：受 enabled + autoStart 双重门控 */
  private async ensureActiveCycle(cfg: RuntimeConfig): Promise<Cycle | null> {
    if (!cfg.enabled || !cfg.autoStart) return null;
    return this.startCycle(cfg);
  }

  /** 开启新周期（cron / 管理员共用）。返回新建或当前已存在的 ACTIVE 周期 */
  private async startCycle(cfg: RuntimeConfig): Promise<Cycle | null> {
    if (!cfg.enabled) return null;
    const nowMs = Date.now();
    const win = computeCycleWindow(cfg.period, nowMs);
    // 同一窗口只允许一条（防重复开、防结算后同窗口重开）
    const existing = (await this.prisma.worldEventCycle.findFirst({
      where: { cycleId: win.cycleId },
    })) as unknown as Cycle | null;
    if (existing) return existing.status === 'ACTIVE' ? existing : null;

    let task: WorldEventTaskDef | null = null;
    let metric: string;
    let baseGoal: number;
    let taskKey: string;
    if (cfg.taskSource === 'pool') {
      task = pickWorldEventTask(cfg.taskPool, win.cycleId, cfg.randomPick, FALLBACK_KILL_TASK);
      metric = task.metric;
      baseGoal = Math.max(1, Number(task.goalHint) || cfg.baseGoal);
      taskKey = task.key;
    } else {
      metric = cfg.metric;
      baseGoal = Math.max(1, cfg.baseGoal);
      taskKey = 'fixed';
    }
    const goalPoints = await this.resolveGoal(cfg, baseGoal);
    const startPoints = await this.proficiency.getPoints(WORLD_PROFICIENCY_NAME);
    const taskTitle = cfg.panelTitleOverride || task?.title || cfg.panelTitle;

    const created = (await this.prisma.worldEventCycle.create({
      data: {
        cycleId: win.cycleId,
        period: cfg.period,
        taskKey,
        taskTitle,
        metric,
        startPoints,
        goalPoints,
        startAt: win.startAt,
        endAt: win.endAt,
        status: 'ACTIVE',
        reached: {},
        lastStep: 0,
      },
    })) as unknown as Cycle;

    if (cfg.announceOnStart) {
      await this.chatService.broadcastSystem(
        '世界频道',
        `🌍 新的世界事件开启：${taskTitle}（第 ${win.cycleId} 周期）\n` +
          `目标：全服击杀累计 ${goalPoints.toLocaleString()}　周期：${cfg.period === 'day' ? '每日' : cfg.period === 'month' ? '每月' : '每周'}\n` +
          `达成里程碑即解锁全服增益，100% 达成有全员奖励。发送「世界事件」查看进度。`,
      );
    }
    await this.refreshBuffCache();
    return created;
  }

  /** 目标：baseGoal ×（上期完成度缩放因子，若开启）。取最近一条已结算周期做参考 */
  private async resolveGoal(cfg: RuntimeConfig, baseGoal: number): Promise<number> {
    if (!cfg.goalAutoAdjust) return Math.max(1, Math.floor(baseGoal));
    const prev = (await this.prisma.worldEventCycle.findFirst({
      where: { status: 'SETTLED', settledAt: { not: null } },
      orderBy: { settledAt: 'desc' },
    })) as unknown as Cycle | null;
    if (!prev || !prev.goalPoints) return Math.max(1, Math.floor(baseGoal));
    const actual = (Number(prev.finalPoints) || 0) - (Number(prev.startPoints) || 0);
    return adjustGoal(baseGoal, actual, cfg.goalAdjustMin, cfg.goalAdjustMax);
  }

  /** 解锁达成但未解锁的里程碑；返回是否发生变化 */
  private async checkMilestones(cycle: Cycle, cfg: RuntimeConfig): Promise<void> {
    const { percent } = await this.currentProgress(cycle);
    const reached: Record<string, string> =
      cycle.reached && typeof cycle.reached === 'object' ? { ...cycle.reached } : {};
    const newly = cfg.milestones.filter((m) => percent >= m && !(String(m) in reached));
    if (newly.length === 0) return;

    const iso = new Date().toISOString();
    for (const m of newly) reached[String(m)] = iso;
    await this.prisma.worldEventCycle.update({ where: { id: cycle.id }, data: { reached } });
    cycle.reached = reached;

    await this.refreshBuffCache();

    if (cfg.announceOnMilestone) {
      const { current, goal } = await this.currentProgress(cycle);
      for (const m of newly) {
        const buffLabel = this.buffLabelFor(cfg, m);
        const next = cfg.milestones.find((x) => x > m);
        const gap = next ? `距下一档 ${next}% 还差 ${Math.max(0, Math.ceil((goal * next) / 100 - current)).toLocaleString()}，继续推进！` : '已全部达成，感谢每一位使魔！';
        await this.chatService.broadcastSystem(
          '世界频道',
          `🌍 全服里程碑！世界进度突破 ${m}%\n${buffLabel ? `「${buffLabel}」已对全服生效，持续至本周期结束。\n` : ''}${gap}`,
        );
      }
    }
  }

  /** 到点结算（updateMany 条件抢占，保证多实例/重入只结算一次） */
  private async settleIfDue(cycle: Cycle, cfg: RuntimeConfig): Promise<void> {
    const now = new Date();
    if (cycle.status !== 'ACTIVE' || now < cycle.endAt) return;
    const finalPoints = await this.proficiency.getPoints(WORLD_PROFICIENCY_NAME);
    const graceEndAt = new Date(now.getTime() + Math.max(0, cfg.graceHours) * 3600_000);
    const acquired = await this.prisma.worldEventCycle.updateMany({
      where: { id: cycle.id, status: 'ACTIVE' },
      data: { status: 'SETTLED', settledAt: now, finalPoints, graceEndAt },
    });
    if (acquired.count === 0) return; // 已被别的实例结算

    cycle.status = 'SETTLED';
    cycle.finalPoints = finalPoints;
    await this.archiveHistory(cycle, cfg);
    await this.refreshBuffCache(); // 周期结束 → buff 归零

    const { percent } = await this.settledPercentView(cycle);
    await this.chatService.broadcastSystem(
      '世界频道',
      `🌍 世界事件「${cycle.taskTitle}」结算完成：最终进度 ${percent}%。` +
        `已解锁里程碑均可在 ${cfg.graceHours} 小时内领取，发送「领取世界奖励」。下一周期即将开启。`,
    );
  }

  private async settledPercentView(cycle: Cycle): Promise<{ percent: number }> {
    const goal = Number(cycle.goalPoints) || 1;
    const actual = (Number(cycle.finalPoints) || 0) - (Number(cycle.startPoints) || 0);
    return { percent: Math.max(0, Math.min(100, Math.floor((actual / goal) * 100))) };
  }

  /** 每跨过 progressBroadcastStep% 推一次公屏（progress socket 事件每 tick 都发，保持前端条实时） */
  private async maybeBroadcastProgress(cycle: Cycle, percent: number, cfg: RuntimeConfig): Promise<void> {
    const step = cfg.progressBroadcastStep;
    if (!step || step <= 0) return;
    const curStep = Math.floor(Math.min(100, percent) / step);
    const lastStep = Number(cycle.lastStep) || 0;
    if (curStep <= lastStep || curStep * step > 100) return;
    await this.prisma.worldEventCycle.update({ where: { id: cycle.id }, data: { lastStep: curStep } });
    cycle.lastStep = curStep;
    const crossed = curStep * step;
    await this.chatService.broadcastSystem(
      '世界频道',
      `🌍 世界进度 ${crossed}%（${cycle.taskTitle}）！当前 ${percent}%。发送「世界事件」查看里程碑。`,
    );
  }

  /** socket 进度事件（不落库、不进聊天流），供前端常驻细条实时刷新 */
  private async emitProgress(cycle: Cycle, percent: number): Promise<void> {
    const { current, goal } = await this.currentProgress(cycle);
    this.chatService.emitToChannel('世界频道', 'worldEvent:progress', {
      cycleId: cycle.cycleId,
      current,
      goal,
      percent,
    });
  }

  // ==================== buff 同步缓存 ====================

  /** 生效点（schedule / checkin-reward / time-settle）同步读取当前全服 buff，零 async、零环 */
  getActiveBuffValues(): ActiveBuffValues {
    return this.buffCache;
  }

  /** 由当前 ACTIVE 周期的 reached + buff 配置重算缓存 */
  private async refreshBuffCache(): Promise<void> {
    const active = await this.getActiveCycle();
    const buffs = await this.systemConfig.get(WEK.buffs, DEFAULT_WORLD_EVENT_BUFFS);
    const defs = Array.isArray((buffs as any)?.buffs) ? (buffs as any).buffs : [];
    this.buffCache = computeActiveBuffs(active?.reached, defs as WorldEventBuffDef[]);
  }

  private buffLabelFor(cfg: RuntimeConfig, percent: number): string {
    const hit = cfg.buffs.filter((b) => Number(b.percent) === percent);
    return hit.map((b) => b.label).join('、');
  }

  // ==================== cron ====================

  @Cron('0 */10 * * * *') // 每 10 分钟：开周期 / 里程碑 / 结算 / 进度推送
  async worldEventTick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cfg = await this.loadConfig();
      let cycle = await this.getActiveCycle();
      if (!cycle) {
        cycle = await this.ensureActiveCycle(cfg);
        if (!cycle) return; // 未开新周期（关闭 / autoStart=false / 同窗口已结算）
      }
      const { percent } = await this.currentProgress(cycle);
      await this.checkMilestones(cycle, cfg);
      await this.emitProgress(cycle, percent);
      await this.maybeBroadcastProgress(cycle, percent, cfg);
      await this.settleIfDue(cycle, cfg);
    } catch (err: any) {
      this.logger.error(`世界事件轮询失败: ${err?.message ?? err}`); // 只告警，绝不让 cron 抛出刷屏
    } finally {
      this.running = false;
    }
  }

  // ==================== 发奖 ====================

  private rewardEntriesFor(cfg: RuntimeConfig, percent: number): CheckinRewardEntry[] {
    const m = cfg.rewards.find((r) => Number(r.percent) === percent);
    if (!m || !Array.isArray(m.rewards)) return [];
    // 只保留 quantity 为正数的条目，字段直接透传（grantRewards 只认 quantity）
    return m.rewards
      .filter((e) => e && Number(e.quantity) > 0)
      .map((e) => ({ type: e.type, name: e.name || '', quantity: Number(e.quantity) }));
  }

  /** 领取世界奖励（幂等：唯一约束 + 先记账后发货 + 发货失败回滚记账）。返回回执文案 */
  async claimReward(userId: number, percent?: number): Promise<string> {
    if (!Number.isFinite(userId)) return '请先登录';
    const cycle = await this.claimableCycle();
    if (!cycle) return '当前没有进行中的世界事件，下一周期即将开启';

    const cfg = await this.loadConfig();
    const reached = cycle.reached && typeof cycle.reached === 'object' ? cycle.reached : {};
    const reachedTiers = cfg.milestones.filter((m) => String(m) in reached);

    let targets: number[];
    if (percent != null) {
      if (!reachedTiers.includes(percent)) return '该里程碑尚未达成，暂时无法领取';
      targets = [percent];
    } else {
      targets = reachedTiers;
    }
    if (targets.length === 0) return '暂时没有可领取的世界奖励，先把进度推上去吧';

    const claimedRows = await this.prisma.worldEventClaim.findMany({
      where: { cycleId: cycle.id, userId, percent: { in: targets } },
      select: { percent: true },
    });
    const claimedSet = new Set(claimedRows.map((r) => r.percent));
    const pending = targets.filter((t) => !claimedSet.has(t));
    if (pending.length === 0) return `这些奖励你已经领过了（第 ${cycle.cycleId} 周期）`;

    const lines: string[] = [];
    const okTiers: number[] = [];
    for (const t of pending) {
      // 先记账（唯一约束天然去重）
      let claimId: number;
      try {
        const claim = await this.prisma.worldEventClaim.create({ data: { cycleId: cycle.id, userId, percent: t } });
        claimId = claim.id;
      } catch {
        continue; // 并发重复领 → 唯一冲突 → 跳过
      }
      const entries = this.rewardEntriesFor(cfg, t);
      try {
        const texts = await this.checkinReward.grantRewards(userId, entries, {});
        lines.push(...texts.map((x) => `  · ${x}（${t}%）`));
        okTiers.push(t);
      } catch (err: any) {
        // 发货失败回滚记账，避免「领了但没到账」
        await this.prisma.worldEventClaim.delete({ where: { id: claimId } }).catch(() => {});
        this.logger.error(`世界事件发奖失败(cycle=${cycle.cycleId} user=${userId} ${t}%): ${err?.message ?? err}`);
      }
    }

    if (okTiers.length === 0) return '发放遇到问题，请稍后重试';
    return `✅ 领取成功！\n${lines.join('\n')}\n（第 ${cycle.cycleId} 周期 · ${okTiers.join(' / ')}% 里程碑）`;
  }

  // ==================== 面板 / API ====================

  /** 「世界事件」指令回执（纯文本，Q 群可读，字符进度条不依赖颜色） */
  async viewPanel(userId: number): Promise<string> {
    const cycle = await this.claimableCycle();
    if (!cycle) return '当前没有进行中的世界事件，下一周期即将开启';
    const cfg = await this.loadConfig();
    const { current, goal, percent } = await this.currentProgress(cycle);
    const reached = cycle.reached && typeof cycle.reached === 'object' ? cycle.reached : {};
    const remaining = formatRemaining(new Date(cycle.endAt).getTime() - Date.now());
    const statusTag = cycle.status === 'ACTIVE' ? `剩余 ${remaining}` : '已结算·领取窗口内';

    const claimedSet = new Set<number>();
    if (Number.isFinite(userId)) {
      const rows = await this.prisma.worldEventClaim.findMany({
        where: { cycleId: cycle.id, userId },
        select: { percent: true },
      });
      for (const r of rows) claimedSet.add(r.percent);
    }

    const lines: string[] = [];
    lines.push(`🌍 世界事件 · ${cycle.taskTitle || cfg.panelTitle}`);
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push(cfg.panelDesc);
    lines.push('');
    lines.push(`⏳ 周期：${cycle.cycleId}（${statusTag}）`);
    lines.push(`📊 进度：${current.toLocaleString()} / ${goal.toLocaleString()}（${percent}%）`);
    lines.push(`${asciiProgressBar(percent)} ${percent}%`);
    lines.push('');
    lines.push('🏆 里程碑');
    let claimableCount = 0;
    for (const m of cfg.milestones) {
      const reachedFlag = String(m) in reached;
      const buffLabel = this.buffLabelFor(cfg, m);
      if (reachedFlag && !claimedSet.has(m)) {
        claimableCount++;
        lines.push(`  🎁 ${m}%  可领取${buffLabel ? ` · ${buffLabel}` : ''}`);
      } else if (reachedFlag) {
        lines.push(`  ✅ ${m}%  已达成${buffLabel ? ` · ${buffLabel}` : ''}`);
      } else {
        const gap = Math.max(0, Math.ceil((goal * m) / 100 - current)).toLocaleString();
        lines.push(`  ⏳ ${m}%  未达成${buffLabel ? ` · ${buffLabel}` : ''}（还差 ${gap}）`);
      }
    }
    lines.push('');
    lines.push(claimableCount > 0 ? `🎁 可领取：${claimableCount} 项　→ 发送「领取世界奖励」` : '🎁 暂无可领取奖励');
    return lines.join('\n');
  }

  /** GET /api/game/world-event/current 只读视图（首屏；之后前端只听 worldEvent:progress） */
  async getCurrentView(userId: number) {
    const cycle = await this.claimableCycle();
    if (!cycle) return { cycleId: null, status: 'NONE' };
    const cfg = await this.loadConfig();
    const { current, goal, percent } = await this.currentProgress(cycle);
    const reached = cycle.reached && typeof cycle.reached === 'object' ? cycle.reached : {};

    const claimedSet = new Set<number>();
    if (Number.isFinite(userId)) {
      const rows = await this.prisma.worldEventClaim.findMany({
        where: { cycleId: cycle.id, userId },
        select: { percent: true },
      });
      for (const r of rows) claimedSet.add(r.percent);
    }

    const milestones = cfg.milestones.map((m) => {
      const reachedFlag = String(m) in reached;
      return {
        percent: m,
        reached: reachedFlag,
        reachedAt: reachedFlag ? reached[String(m)] : null,
        buffLabel: this.buffLabelFor(cfg, m),
        claimed: claimedSet.has(m),
        claimable: reachedFlag && !claimedSet.has(m),
      };
    });

    return {
      cycleId: cycle.cycleId,
      period: cycle.period,
      taskKey: cycle.taskKey,
      title: cycle.taskTitle,
      description: cfg.panelDesc,
      startAt: cycle.startAt,
      endAt: cycle.endAt,
      current,
      goal,
      percent,
      milestones,
      claimable: milestones.filter((m) => m.claimable).map((m) => m.percent),
      status: cycle.status,
    };
  }

  // ==================== 管理指令 ====================

  async adminCommand(userId: number, args: string[]): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return '用户不存在';
    if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
      return '权限不足，需要管理员权限（ADMIN 或 SUPER_ADMIN）';
    }
    const cfg = await this.loadConfig();
    const sub = args[0] || '';
    const subArgs = args.slice(1);
    switch (sub) {
      case '开启':
      case 'start': {
        const manualGoal = Number(subArgs[0]);
        const cycle = await this.getActiveCycle();
        if (cycle) return `已有进行中的周期（${cycle.cycleId}），无需重复开启`;
        const created = await this.startCycle(cfg);
        if (!created) return '未能开启周期（检查 worldEvent.enabled）';
        if (Number.isFinite(manualGoal) && manualGoal > 0 && created.status === 'ACTIVE') {
          await this.prisma.worldEventCycle.update({ where: { id: created.id }, data: { goalPoints: manualGoal } });
          created.goalPoints = manualGoal;
        }
        return `已开启周期 ${created.cycleId}，目标 ${created.goalPoints.toLocaleString()}`;
      }
      case '结算':
      case 'settle': {
        const cycle = await this.getActiveCycle();
        if (!cycle) return '当前没有进行中的周期可结算';
        await this.settleIfDue({ ...cycle, endAt: new Date(0) } as Cycle, cfg); // 强制到点
        return `已触发结算：${cycle.cycleId}`;
      }
      case '重置':
      case 'reset': {
        const cycle = await this.getActiveCycle();
        if (!cycle) return '当前没有进行中的周期可重置';
        await this.prisma.worldEventClaim.deleteMany({ where: { cycleId: cycle.id } });
        await this.prisma.worldEventCycle.delete({ where: { id: cycle.id } });
        await this.refreshBuffCache();
        return `已丢弃周期 ${cycle.cycleId}（不计入历史）`;
      }
      case '目标':
      case 'goal': {
        const next = Number(subArgs[0]);
        if (!Number.isFinite(next) || next <= 0) return '请提供正整数目标值，如：世界事件管理 目标 20000';
        const cycle = await this.getActiveCycle();
        if (!cycle) return '当前没有进行中的周期可调整目标';
        await this.prisma.worldEventCycle.update({ where: { id: cycle.id }, data: { goalPoints: next } });
        return `周期 ${cycle.cycleId} 目标已设为 ${next.toLocaleString()}`;
      }
      default:
        return [
          '世界事件管理 开启 [目标值]　手动开启新周期',
          '世界事件管理 结算　　　　　立即结算当前周期',
          '世界事件管理 重置　　　　　丢弃当前周期（不计入历史）',
          '世界事件管理 目标 20000　　调整当前周期目标',
        ].join('\n');
    }
  }

  // ==================== 历史归档（结算时追加，最多 20 条） ====================

  private async archiveHistory(cycle: Cycle, cfg: RuntimeConfig): Promise<void> {
    const goal = Number(cycle.goalPoints) || 1;
    const actual = (Number(cycle.finalPoints) || 0) - (Number(cycle.startPoints) || 0);
    const percent = Math.max(0, Math.min(100, Math.floor((actual / goal) * 100)));
    const reached = cycle.reached && typeof cycle.reached === 'object' ? cycle.reached : {};
    const [claimedUsers, historyRaw] = await Promise.all([
      this.prisma.worldEventClaim.count({ where: { cycleId: cycle.id }, distinct: ['userId'] } as any),
      this.systemConfig.get<any>(WEK.history, []),
    ]);
    const history = Array.isArray(historyRaw) ? historyRaw : [];
    history.push({
      cycleId: cycle.cycleId,
      period: cycle.period,
      taskKey: cycle.taskKey,
      goal,
      actual,
      percent,
      reachedMilestones: Object.keys(reached).map(Number).sort((a, b) => a - b),
      claimedUsers,
      settledAt: new Date().toISOString(),
    });
    while (history.length > 20) history.shift();
    await this.systemConfig.set(WEK.history, JSON.stringify(history));
  }
}
