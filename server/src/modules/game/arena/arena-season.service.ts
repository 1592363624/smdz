/**
 * 使魔竞技场 · 赛季服务（赛季轮转 + 到期结算 + 可配置名次奖励发放）。
 *
 * ## 奖励全部可配
 * 名次档 / 称号 / 头像框 / 资源 / 特权键与天数都来自 SystemConfig `arena.seasonRewards`，
 * 后台改完下一个赛季即生效，不需要发版。发放走签到同一出口
 * `CheckinRewardService.grantRewards`（本系统给它扩了 title/frame/privilege 三类）。
 *
 * ## 幂等
 * 结算先以 `status: ACTIVE → SETTLING` 的**条件更新**抢占，抢不到就直接退出；
 * 因此 cron 与管理员手工「竞技场管理 结算」并发也只会有一个真正发奖。
 * 头像框与称号本身也是可重入的（已拥有则跳过），特权按来源续期而非重复插行。
 *
 * ## 名次口径
 * 榜 = 镜像榜（`ArenaMirror` 按席位号降序 = 名次），只有挂了镜像的玩家才参与名次奖励。
 * 这条约束让「赛季第一名」必然是一个可被挑战的实靶子，而不是刷完分就撤镜像的隐身号。
 */
import { Cron, CronExpression } from '@nestjs/schedule';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { PlayerMutateService } from '../player-mutate.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { ChatService } from '../../chat/chat.service';
import { CheckinRewardService } from '../checkin-reward.service';
import { CheckinRewardEntry } from '../checkin-config.defaults';
import { EntitlementService } from '../entitlement.service';
import { ArenaService, ArenaRuntimeConfig } from './arena.service';
import {
  ARENA_CONFIG_KEYS,
  ARENA_PRIVILEGE_DEFS,
  DEFAULT_ARENA_SEASON_REWARDS,
  DEFAULT_ARENA_SEASON_REWARDS_JSON,
  PRIVILEGE_BATCH_GATHER,
  matchArenaRewardBands,
  normalizeArenaSeasonRewards,
  privilegeLabel,
  ArenaSeasonPrivilege,
  ArenaSeasonRewardBand,
  ArenaSeasonRewards,
} from '../../../config/arena.config';

/** 一行的结算结果（写进 ArenaSeason.settleInfo 供后台复盘） */
export interface SettleRow {
  rank: number;
  userId: number;
  name: string;
  /** 结算瞬间的席位号（审计用；对外只报名次） */
  seat: number;
  bands: string[];
  texts: string[];
}

@Injectable()
export class ArenaSeasonService {
  private readonly logger = new Logger(ArenaSeasonService.name);
  /** cron 重入保护：上一轮结算未完不再进（与 schedule.service 的 autoMineRunning 同一手法） */
  private settling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly arena: ArenaService,
    private readonly entitlement: EntitlementService,
    private readonly checkinReward: CheckinRewardService,
    @Optional() private readonly chat?: ChatService,
    /** 称号达成标记写入用（可选：测试桩按前六参构造本服务） */
    @Optional() private readonly mutate?: PlayerMutateService,
  ) {}

  // ==========================================================
  // 定时巡检
  // ==========================================================

  /** 每小时第 7 分钟：结算到期赛季并开下一赛季（与整点任务错开） */
  @Cron('7 * * * *')
  async hourlyTick(): Promise<void> {
    if (this.settling) return;
    this.settling = true;
    try {
      await this.settleExpiredSeasons();
      // 开榜初始名次（只在「全服零档案」时真的动手，平时就一条 COUNT）：
      // 放在巡检里而不是启动钩子——真实库套件与开发 watch 会反复 boot 整个应用，
      // 挂 OnModuleInit 等于每次重启都拿一遍全服扫描；上线要立刻生效可用「竞技场管理 初排」。
      const seeded = await this.arena.seedInitialSeats(true);
      if (seeded) this.logger.log(seeded);
    } catch (err: any) {
      this.logger.warn(`竞技场赛季巡检失败：${err?.message ?? err}`);
    } finally {
      this.settling = false;
    }
  }

  /**
   * 结算所有该结算的赛季：
   * 1. ACTIVE 且已到期；
   * 2. 卡在 SETTLING 超过 10 分钟的（进程在发放中途被杀/重启）——不救就会永久占着
   *    唯一 ACTIVE 位，所有指令一起瘫；救回来的代价是最多重发一次奖励
   *    （称号/头像框自带去重，特权按来源续期，只有资源类可能重复，故阈值取宽）。
   */
  async settleExpiredSeasons(now = new Date()): Promise<string[]> {
    const staleBefore = new Date(now.getTime() - 10 * 60 * 1000);
    const [expired, stranded] = await Promise.all([
      this.prisma.arenaSeason.findMany({
        where: { status: 'ACTIVE', endAt: { lte: now } },
        orderBy: { no: 'asc' },
      }),
      this.prisma.arenaSeason.findMany({
        where: { status: 'SETTLING', updatedAt: { lte: staleBefore } },
        orderBy: { no: 'asc' },
      }).catch(() => [] as any[]),
    ]);
    const texts: string[] = [];
    for (const season of [...expired, ...(stranded || [])]) {
      texts.push(await this.settleSeason(season));
    }
    return texts;
  }

  // ==========================================================
  // 结算
  // ==========================================================

  /**
   * 结算一个赛季：抢占状态位 → 按名次发奖 → 写复盘快照 → 开下一赛季。
   * @returns 面向管理员的结算摘要文案
   */
  async settleSeason(season: any): Promise<string> {
    // 抢占条件：ACTIVE；或「SETTLING 且已卡住 10 分钟以上」的残局。
    // 正在正常进行的 SETTLING（updatedAt 很新）抢不到 → cron 与管理员手工并发只有一路会发奖。
    const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
    const grabbed = await this.prisma.arenaSeason.updateMany({
      where: {
        id: Number(season.id),
        OR: [
          { status: 'ACTIVE' },
          { status: 'SETTLING', updatedAt: { lte: staleBefore } },
        ],
      },
      data: { status: 'SETTLING' },
    }).catch(() => ({ count: 0 }));
    if (!Number(grabbed?.count)) return `赛季 S${season.no} 已在结算或已结算，本次跳过。`;

    const cfg = await this.arena.getConfig();
    const rewards = await this.getRewardsConfig();
    const mirrors = await this.arena.rankedMirrors(season.id, 500);
    const rows: SettleRow[] = [];

    for (let i = 0; i < mirrors.length; i++) {
      const mirror = mirrors[i];
      const bands = matchArenaRewardBands(rewards, i + 1);
      if (bands.length === 0) continue;
      const texts: string[] = [];
      for (const band of bands) {
        texts.push(...await this.grantBand(Number(mirror.ownerId), band, `S${season.no} 第 ${i + 1} 名`));
      }
      rows.push({
        rank: i + 1,
        userId: Number(mirror.ownerId),
        name: String(mirror.ownerName ?? ''),
        seat: Number(mirror.rating) || 0,
        bands: bands.map((b) => b.label || `第${b.from}-${b.to}名`),
        texts,
      });
    }

    // 参与奖：按场次达标，与名次档并行发放（同一名玩家可能既拿冠军档又拿参与档）
    const participation = rewards.participation;
    if (participation && participation.minMatches > 0) {
      const profiles = await this.prisma.arenaProfile.findMany({
        where: { seasonId: Number(season.id) },
        take: 5000,
      }).catch(() => [] as any[]);
      for (const profile of profiles || []) {
        const matches = Number(profile.wins) + Number(profile.losses) + Number(profile.draws);
        if (matches < participation.minMatches) continue;
        const texts = await this.grantBand(Number(profile.userId), {
          from: 1, to: 1, label: `参与奖（${matches} 场）`,
          titles: participation.titles, frames: participation.frames, rewards: participation.rewards,
        }, `S${season.no} 参与奖`);
        if (texts.length > 0) {
          rows.push({
            rank: 0, userId: Number(profile.userId), name: '', seat: Number(profile.rating) || 0,
            bands: [`参与 ${matches} 场`], texts,
          });
        }
      }
    }

    const granted = rows.reduce((sum, row) => sum + row.texts.length, 0);
    await this.compactSeats(mirrors, Number(season.id));
    await this.prisma.arenaSeason.update({
      where: { id: Number(season.id) },
      data: {
        status: 'SETTLED',
        settledAt: new Date(),
        rewardSnapshot: rewards as any,
        settleInfo: {
          total: mirrors.length,
          granted,
          rows: rows.slice(0, 200),
        } as any,
      },
    }).catch((err: any) => this.logger.warn(`赛季结算写回失败（S${season.no}）：${err?.message ?? err}`));

    await this.openNextSeason(season, cfg);
    await this.announce(season, rows, cfg);

    const lines = [
      `🏆 竞技场 S${season.no} 赛季结算完成（榜上 ${mirrors.length} 个镜像，发出 ${granted} 项奖励）`,
      ...rows.filter((r) => r.rank > 0).slice(0, 10).map((r) => `第 ${r.rank} 名 ${r.name || r.userId}：${r.texts.join('、') || '无'}`),
    ];
    this.logger.log(lines[0]);
    return lines.join('\n');
  }

  /**
   * 发放一个名次档的全部奖励：资源/经验/活力 + 称号 + 头像框 + 特权，统一走发放出口。
   * @param label 授予理由文案（特权与日志用）
   */
  private async grantBand(userId: number, band: ArenaSeasonRewardBand, label: string): Promise<string[]> {
    const entries: CheckinRewardEntry[] = [];
    for (const reward of band.rewards ?? []) {
      entries.push({
        type: (reward.type || 'item') as CheckinRewardEntry['type'],
        name: String(reward.name ?? '').trim(),
        quantity: Number(reward.quantity) || 0,
      });
    }
    for (const title of band.titles ?? []) {
      entries.push({ type: 'title', name: title, quantity: 1 });
    }
    for (const frame of band.frames ?? []) {
      entries.push({ type: 'frame', name: frame, quantity: 1 });
    }
    for (const privilege of band.privileges ?? []) {
      entries.push({
        type: 'privilege',
        name: String(privilege.key ?? '').trim(),
        quantity: Math.max(0, Math.floor(Number(privilege.days) || 0)),
      });
    }
    if (entries.length === 0) return [];
    // 先把称号的「领取条件成就」写成已达成：titles.json 里这些条件只有赛季结算会写，
    // 既保证限定称号无法被普通「领取称号」白嫖，又避免已拥有者看到 0/1 的假缺失进度。
    await this.markSeasonTitles(userId, band.titles ?? []);
    const ctx = {
      source: 'arenaSeason',
      reason: band.privileges?.find((p) => p.reason)?.reason || label,
    };
    try {
      return await this.checkinReward.grantRewards(userId, entries, ctx);
    } catch (err: any) {
      this.logger.warn(`竞技场奖励发放失败（玩家 ${userId} / ${label}）：${err?.message ?? err}`);
      return [];
    }
  }

  /** 赛季限定称号 → 达成标记写入（玩家侧唯一写入点，走 PlayerMutateService 收口） */
  private async markSeasonTitles(userId: number, titles: string[]): Promise<void> {
    if (!this.mutate || !Array.isArray(titles) || titles.length === 0) return;
    const hit = titles.filter((title) => SEASON_TITLE_MARKERS[title]);
    if (hit.length === 0) return;
    await this.mutate.mutate(userId, (ctx) => {
      const markers = asJsonValue<Record<string, any>>(ctx.player?.markers, {});
      for (const title of hit) applySeasonTitleMarker(markers, title);
      ctx.player.markers = markers; // Json 列直接写对象
    }).catch((err: any) => this.logger.warn(`赛季称号成就写入失败（玩家 ${userId}）：${err?.message ?? err}`));
  }

  /** 结算公告（一次性、每赛季一次，可配 `arena.announceSeason` 关闭） */
  private async announce(season: any, rows: SettleRow[], cfg: { announceSeason?: boolean }): Promise<void> {
    if (!this.chat || cfg?.announceSeason === false) return;
    const top = rows.filter((r) => r.rank > 0).slice(0, 3);
    if (top.length === 0) return;
    const champion = top[0];
    const privilegeHint = await this.championPrivilegeHint();
    const lines = [
      `🏟️ 使魔竞技场 S${season.no} 赛季落幕`,
      `冠军：${champion.name || champion.userId}${privilegeHint}`,
      ...top.slice(1).map((r) => `亚军人：第 ${r.rank} 名 ${r.name || r.userId}`),
    ];
    await this.chat.broadcastSystem('世界频道', lines.join('\n')).catch(() => undefined);
  }

  /** 公告里顺带说明冠军拿到了什么特权（只提示配置里真的有的，避免文案吹牛） */
  private async championPrivilegeHint(): Promise<string> {
    const rewards = await this.getRewardsConfig();
    const first = (rewards.ranks || []).find((band) => band.from === 1);
    const keys = (first?.privileges ?? []).map((p: ArenaSeasonPrivilege) => privilegeLabel(p.key)).filter(Boolean);
    return keys.length > 0 ? `（获得特权：${keys.join('、')}）` : '';
  }

  /**
   * 赛季边界把席位号压成 N..1（按最终名次）。
   *
   * 席位只是排序键，新入榜者一律往后让，长期只减不增会一路走到负数；
   * 换季是唯一能安全重排的时机（此时榜单已冻结，没有人正在打）。
   * 顺带让 `arena.seasonCarry=keep` 的语义落成「按上季末名次继承席位」。
   * 只改**本季**的档案：一个玩家的档案可能同时存在好几季（补算卡住的赛季时下一季已在跑），
   * 少了 seasonId 条件就会把别的赛季席位一起覆盖掉。
   */
  private async compactSeats(mirrors: any[], seasonId: number): Promise<void> {
    const total = mirrors.length;
    for (let i = 0; i < total; i++) {
      const ownerId = Number(mirrors[i]?.ownerId);
      if (!ownerId) continue;
      await this.prisma.arenaProfile.updateMany({
        where: { userId: ownerId, seasonId: Number(seasonId) },
        data: { rating: total - i },
      }).catch(() => undefined);
    }
  }

  /** 开下一赛季：起点取 max(现在, 上季结束)，长度取当前配置 */
  async openNextSeason(prevSeason: any, cfgOverride?: ArenaRuntimeConfig): Promise<any> {
    const cfg = cfgOverride ?? await this.arena.getConfig();
    const now = new Date();
    const prevEnd = new Date(prevSeason?.endAt ?? now);
    const startAt = prevEnd.getTime() > now.getTime() ? prevEnd : now;
    const endAt = new Date(startAt.getTime() + Math.max(1, cfg.seasonLengthDays) * 24 * 3600 * 1000);
    const no = (Number(prevSeason?.no) || 0) + 1;
    const created = await this.prisma.arenaSeason.create({
      data: { no, name: `S${no}`, startAt, endAt, status: 'ACTIVE' },
    }).catch((err: any) => {
      this.logger.warn(`开启下一赛季失败（S${no}）：${err?.message ?? err}`);
      return null;
    });
    if (created) this.logger.log(`竞技场 S${created.no} 赛季开启，至 ${endAt.toISOString()}`);
    return created;
  }

  // ==========================================================
  // 配置读取
  // ==========================================================

  /** 赛季奖励配置（json 被改坏时回落内置默认，结算不会整体哑火） */
  async getRewardsConfig(): Promise<ArenaSeasonRewards> {
    try {
      const raw = await this.systemConfig.get<any>(ARENA_CONFIG_KEYS.seasonRewards, DEFAULT_ARENA_SEASON_REWARDS_JSON);
      return normalizeArenaSeasonRewards(raw);
    } catch {
      return normalizeArenaSeasonRewards(DEFAULT_ARENA_SEASON_REWARDS);
    }
  }

  /** 改本赛季截止时间（后台「改期」与管理员指令共用） */
  async setSeasonEndAt(seasonId: number, endAt: Date): Promise<any> {
    return this.prisma.arenaSeason.update({
      where: { id: Number(seasonId) },
      data: { endAt },
    });
  }

  // ==========================================================
  // 管理指令（指令「竞技场管理」，内部自鉴权）
  // ==========================================================

  /**
   * @param args 例：结算 / 初排 / 开季 / 改期 7 / 榜 10 / 预览 / 授特权 张三 batchGather 30 / 撤特权 张三 batchGather / 持权
   */
  async adminCommand(userId: number, args: string[]): Promise<string> {
    const role = await this.roleOf(userId);
    if (role !== 'ADMIN' && role !== 'SUPER_ADMIN') return '只有管理员可以使用「竞技场管理」。';
    const sub = String(args?.[0] ?? '').trim();
    const rest = args.slice(1);

    switch (sub) {
      case '结算':
      case 'settle': {
        const texts = await this.settleExpiredSeasons();
        return texts.length > 0 ? texts.join('\n') : '当前没有到期的赛季（可用「竞技场管理 改期 <天>」调整截止时刻）。';
      }
      case '初排':
      case 'seed':
        // 上线当天不想等下一次巡检：按当前战力把全服排一次初始名次（已有档案时为无操作）
        return await this.arena.seedInitialSeats();
      case '开季':
      case 'open': {
        const { season } = await this.arena.ensureActiveSeason();
        const next = await this.openNextSeason(season);
        return next ? `已开启 S${next.no}（至 ${next.endAt.toLocaleString()}）。` : '开启新赛季失败，见服务端日志。';
      }
      case '改期':
      case 'extend': {
        const days = Number(rest[0]);
        if (!Number.isFinite(days)) return '用法：竞技场管理 改期 <天数>（从今日起算，可为 0.5 的小数）。';
        const { season } = await this.arena.ensureActiveSeason();
        const endAt = new Date(Date.now() + Math.max(0, days) * 24 * 3600 * 1000);
        await this.setSeasonEndAt(season.id, endAt);
        return `赛季 S${season.no} 截止时间已改为 ${endAt.toLocaleString()}。`;
      }
      case '榜':
      case 'rank': {
        const limit = Math.max(1, Math.min(100, Number(rest[0]) || 20));
        const { season } = await this.arena.ensureActiveSeason();
        const mirrors = await this.arena.rankedMirrors(season.id, limit);
        if (mirrors.length === 0) return '本赛季还没有镜像。';
        return [
          `🏟️ S${season.no} 镜像榜（前 ${mirrors.length}）`,
          `名次  席位  段位        镜像主人`,
          ...mirrors.map((m: any, idx: number) => `${String(idx + 1).padStart(3, ' ')}  ${String(m.rating).padStart(5, ' ')}  ${String(m.tier).padEnd(8, ' ')}  ${m.ownerName} · Lv.${m.level} 战力 ${m.power} · 第 ${m.version} 版`),
        ].join('\n');
      }
      case '预览':
      case 'preview': {
        const rewards = await this.getRewardsConfig();
        const lines = ['🎁 当前赛季奖励配置'];
        for (const band of rewards.ranks || []) {
          lines.push(`第 ${band.from}-${band.to} 名${band.label ? `（${band.label}）` : ''}：`
            + `${(band.titles ?? []).map((t) => `称号「${t}」`).join(' ')}`
            + `${(band.frames ?? []).map((f) => `头像框 ${f}`).join(' ')}`
            + `${(band.privileges ?? []).map((p) => `${privilegeLabel(p.key)} ${p.days}天`).join(' ')}`
            + `${(band.rewards ?? []).map((r) => `${r.name || r.type}x${r.quantity}`).join(' ')}`.trim());
        }
        if (rewards.participation) {
          lines.push(`参与奖（打满 ${rewards.participation.minMatches} 场）：${JSON.stringify(rewards.participation)}`);
        }
        return lines.join('\n');
      }
      case '授特权':
      case 'grant': {
        const target = String(rest[0] ?? '').trim();
        const key = String(rest[1] ?? PRIVILEGE_BATCH_GATHER).trim();
        const days = Number(rest[2]);
        if (!target) return '用法：竞技场管理 授特权 <玩家名> <特权键> <天数>（天数为 0 表示永久）';
        const player = await this.prisma.player.findFirst({ where: { name: target }, select: { userId: true, name: true } });
        if (!player) return `找不到玩家「${target}」。`;
        const result = await this.entitlement.grantPrivilege(Number(player.userId), key, {
          source: 'admin',
          days: Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 30,
          permanent: Number(days) === 0,
          reason: `管理员授予（操作人 ${userId}）`,
          grantedBy: Number(userId),
        });
        return `${player.name}：${result.text}${result.ok ? '' : '（未生效）'}`;
      }
      case '撤特权':
      case 'revoke': {
        const target = String(rest[0] ?? '').trim();
        const key = String(rest[1] ?? PRIVILEGE_BATCH_GATHER).trim();
        const player = await this.prisma.player.findFirst({ where: { name: target }, select: { userId: true, name: true } });
        if (!player) return `找不到玩家「${target}」。`;
        const count = await this.entitlement.revokePrivilege(Number(player.userId), key);
        return count > 0 ? `${player.name} 的特权「${privilegeLabel(key)}」已撤销。` : `${player.name} 没有生效中的「${privilegeLabel(key)}」。`;
      }
      case '持权':
      case 'holders': {
        const key = String(rest[0] ?? PRIVILEGE_BATCH_GATHER).trim();
        const holders = await this.entitlement.listPrivilegeHolders(key, 50);
        const names = holders.length === 0 ? [] : await this.namesOf(holders.map((h) => h.userId));
        return [
          `🔑 特权「${privilegeLabel(key)}」持有者（${holders.length}）`,
          ...holders.map((h, idx) => `${names[idx] ?? h.userId} · 到期 ${h.expiresAt ? h.expiresAt.toLocaleString() : '永久'}${h.reason ? ` · ${h.reason}` : ''}`),
          `可授予的特权键：${ARENA_PRIVILEGE_DEFS.map((p) => p.key).join(' / ')}`,
        ].join('\n');
      }
      default:
        return [
          '🛠️ 竞技场管理：结算 / 初排 / 开季 / 改期 <天> / 榜 <N> / 预览',
          '　　授特权 <玩家> <键> <天>｜撤特权 <玩家> <键>｜持权 [键]',
          `　　可用特权键：${ARENA_PRIVILEGE_DEFS.map((p) => `${p.key}（${p.name}）`).join('、')}`,
        ].join('\n');
    }
  }

  private async roleOf(userId: number): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: Number(userId) }, select: { role: true } })
      .catch(() => null);
    return user?.role ?? '';
  }

  /** 批量取玩家名（后台/管理指令展示用，查不到留空由调用方回落 userId） */
  private async namesOf(userIds: number[]): Promise<(string | undefined)[]> {
    if (userIds.length === 0) return [];
    const rows = await this.prisma.player.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, name: true },
    }).catch(() => [] as any[]);
    const map = new Map<number, string>();
    for (const row of rows || []) map.set(Number(row.userId), String(row.name ?? ''));
    return userIds.map((id) => map.get(id));
  }
}

/**
 * 赛季限定称号 → 领取条件成就标记。
 *
 * titles.json 里这几个称号的条件写的就是这些标记名，条件本身只有赛季结算会写，
 * 因此「领取称号」指令拿不到限定称号（ exclusivity 由数据保证，不靠界面藏起来）。
 * 新增限定称号时：这里加一行 + titles.json 的条件用同一个标记名，
 * test/title-achievement-sources.spec.ts 会校验标记确实存在写入源。
 */
const SEASON_TITLE_MARKERS: Record<string, string> = {
  竞技场之王: '竞技场赛季冠军',
  角斗大师: '竞技场赛季前十',
  天梯常客: '竞技场赛季参与',
};

/**
 * 把一个赛季限定称号的达成标记置 1（成就=累加语义，这里按「是否达成」置位即可）。
 * 键写成字面量：既是给玩家看的可读标记，也是「称号条件写入源」静态扫描的识别点。
 */
function applySeasonTitleMarker(markers: Record<string, any>, titleName: string): void {
  if (titleName === '竞技场之王') markers['竞技场赛季冠军'] = 1;
  else if (titleName === '角斗大师') markers['竞技场赛季前十'] = 1;
  else if (titleName === '天梯常客') markers['竞技场赛季参与'] = 1;
}
