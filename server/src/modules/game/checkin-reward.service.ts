/**
 * 奖励发放服务：签到规则（基础经验、连续加成、三张奖励表）全部读自系统配置中心 SystemConfig，
 * 管理员后台改完立即生效、无需重启；发放走本服务唯一出口，
 * 支持背包物品 / 经验 / 活力 / 称号 / 头像框 / 功能特权六类
 * （后三类由竞技场赛季奖励引入，落库统一委托 EntitlementService）。
 * 所有解析均容错：配置被改成非法 JSON 或字段缺失时回落内置默认规则，签到不会整体不可用。
 * 依赖方向：SystemConfig（全局）+ PlayerService + EntitlementService（叶子权益账本）。
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { formatDisplayNumber } from '../../common/utils/game-text.util';
import { SystemConfigService } from '../system-config/system-config.service';
import { PlayerService } from './player.service';
import { PlayerMutateService } from './player-mutate.service';
import { EntitlementService } from './entitlement.service';
import {
  CHECKIN_BASE_EXP_KEY,
  CHECKIN_CONSECUTIVE_EXP_MAX_DAYS_KEY,
  CHECKIN_CONSECUTIVE_EXP_PER_DAY_KEY,
  CHECKIN_REWARDS_KEY,
  CHECKIN_REWARD_TYPES,
  CheckinRewardEntry,
  CheckinRewardGroup,
  CheckinRewardsConfig,
  DEFAULT_CHECKIN_BASE_EXP,
  DEFAULT_CHECKIN_CONSECUTIVE_EXP_MAX_DAYS,
  DEFAULT_CHECKIN_CONSECUTIVE_EXP_PER_DAY,
  DEFAULT_CHECKIN_REWARDS,
} from './checkin-config.defaults';

/** 完整签到配置：经验公式参数 + 三张奖励表 */
export interface CheckinConfig {
  /** 每次签到固定经验 */
  baseExp: number;
  /** 每连续 1 天额外经验 */
  consecutiveExpPerDay: number;
  /** 连续加成封顶天数（0 = 不封顶） */
  consecutiveExpMaxDays: number;
  rewards: CheckinRewardsConfig;
}

/** 发放奖励时的上下文：活力类奖励需要直接改玩家对象（随调用方统一落库） */
export interface CheckinGrantContext {
  player?: any;
  /** 权益类奖励（特权/头像框）的授予来源，默认按签到记 */
  source?: string;
  /** 特权授予理由文案 */
  reason?: string;
}

@Injectable()
export class CheckinRewardService {
  private readonly logger = new Logger(CheckinRewardService.name);

  constructor(
    private readonly systemConfig: SystemConfigService,
    private readonly playerService: PlayerService,
    /**
     * 称号 / 头像框 / 特权的落库账本。
     * 声明为可选：既有测试与桩工厂按两参构造本服务，只发物品/经验/活力时不需要它。
     */
    @Optional() private readonly entitlement?: EntitlementService,
    /** 无受管玩家对象时补发活力用的写锁收口（同样可选，见 grantRewards 的 vitality 分支） */
    @Optional() private readonly mutate?: PlayerMutateService,
  ) {}

  /**
   * 后台代发（手里没有玩家快照）时给玩家加活力：走 PlayerMutateService 单一快照写回。
   * 未注入该依赖（旧桩）时返回 false，由调用方决定不记这条文案。
   */
  private async addVitalityDirectly(userId: number, quantity: number): Promise<boolean> {
    if (!this.mutate) {
      this.logger.warn(`活力奖励 +${quantity} 需要 PlayerMutateService（玩家 ${userId}），当前未注入`);
      return false;
    }
    await this.mutate.mutate(userId, (ctx) => {
      if (!ctx?.player) return;
      ctx.player.vitality = Number(ctx.player.vitality || 0) + quantity;
    }).catch((err: any) => {
      this.logger.warn(`活力奖励发放失败（玩家 ${userId}）：${err?.message ?? err}`);
      return undefined;
    });
    return true;
  }

  /**
   * 读取并规范化签到配置（四项配置一次性批量读取）。
   * 单项读取失败不影响其它项，缺失或非法值回落到内置默认规则。
   */
  async getConfig(): Promise<CheckinConfig> {
    const [baseExp, perDay, maxDays, rewards] = await Promise.all([
      this.readNumber(CHECKIN_BASE_EXP_KEY, DEFAULT_CHECKIN_BASE_EXP),
      this.readNumber(CHECKIN_CONSECUTIVE_EXP_PER_DAY_KEY, DEFAULT_CHECKIN_CONSECUTIVE_EXP_PER_DAY),
      this.readNumber(CHECKIN_CONSECUTIVE_EXP_MAX_DAYS_KEY, DEFAULT_CHECKIN_CONSECUTIVE_EXP_MAX_DAYS),
      this.readRewards(),
    ]);
    return { baseExp, consecutiveExpPerDay: perDay, consecutiveExpMaxDays: maxDays, rewards };
  }

  /**
   * 计算本次签到的经验奖励：基础经验 + min(连续天数, 封顶天数) × 每天加成。
   * 封顶天数为 0（或负数）时表示不封顶。
   * @param consecutiveDays 本次签到后的连续天数
   * @param expFactor 全服经验加成系数（默认 1；世界事件 checkinExp buff 达成时传入 1+百分比/100）
   */
  calcExp(cfg: CheckinConfig, consecutiveDays: number, expFactor = 1): number {
    const days = Number(consecutiveDays) > 0 ? Number(consecutiveDays) : 1;
    const cap = Number(cfg.consecutiveExpMaxDays);
    const effectiveDays = cap > 0 ? Math.min(days, cap) : days;
    const exp = Number(cfg.baseExp || 0) + effectiveDays * Number(cfg.consecutiveExpPerDay || 0);
    const factor = Number.isFinite(expFactor) && expFactor > 0 ? expFactor : 1;
    return Math.max(0, Math.floor(exp * factor));
  }

  /**
   * 匹配「每日奖励」：按连续签到第 N 天取。
   * 循环周期 > 0 时按周期取模轮转（如 7 天一轮：第 8 天拿第 1 天的奖励）；
   * 周期 = 0 时不循环，只有精确命中表里天数才发。
   * @param consecutiveDays 本次签到后的连续天数
   * @returns 命中的奖励条目（可能来自同一天的多组配置，保持配置顺序）
   */
  matchDaily(cfg: CheckinConfig, consecutiveDays: number): CheckinRewardEntry[] {
    const cycle = Number(cfg.rewards?.dailyCycleDays) || 0;
    const days = Number(consecutiveDays) > 0 ? Number(consecutiveDays) : 1;
    // 周期轮转：第 1 天对应 day=1，故先 -1 再取模后 +1
    const day = cycle > 0 ? ((days - 1) % cycle) + 1 : days;
    return this.matchByDays(cfg.rewards?.daily, day);
  }

  /**
   * 匹配「连续签到里程碑」奖励：连续天数精确命中表里的天数才发（只发一次）。
   */
  matchConsecutive(cfg: CheckinConfig, consecutiveDays: number): CheckinRewardEntry[] {
    return this.matchByDays(cfg.rewards?.consecutive, Number(consecutiveDays));
  }

  /**
   * 匹配「累计签到里程碑」奖励：累计天数精确命中表里的天数才发（只发一次）。
   */
  matchTotal(cfg: CheckinConfig, totalDays: number): CheckinRewardEntry[] {
    return this.matchByDays(cfg.rewards?.total, Number(totalDays));
  }

  /**
   * 发放一组奖励条目，并返回用于回执展示的文案（每项一条，如「签到礼包x1」）。
   * - item：走背包唯一出口 addToBackpack（按名合并、类型以静态数据为准）；
   * - exp：走 addExp（内部处理升级）；
   * - vitality：直接累加到传入的 player 对象上，由调用方统一落库，避免多写覆盖；
   * - title / frame / privilege：委托 EntitlementService（会到期的玩法权益，非角色）；
   *   这三类与数量无关（privilege 的 quantity 表示天数），不被上面的「数量必须为正」拦掉。
   */
  async grantRewards(
    userId: number,
    entries: CheckinRewardEntry[],
    ctx: CheckinGrantContext = {},
  ): Promise<string[]> {
    const texts: string[] = [];
    if (!Array.isArray(entries) || entries.length === 0) return texts;

    for (const entry of entries) {
      const name = String(entry?.name ?? '').trim();
      // 权益类奖励：与「数量」无关（privilege 用 quantity 当有效天数，允许 0=永久）
      if (entry.type === 'title' || entry.type === 'frame' || entry.type === 'privilege') {
        texts.push(await this.grantEntitlement(userId, entry, name, ctx));
        continue;
      }
      // 数量只读规范键 quantity（normalizeRewards 出口已洗成标准结构）
      const quantity = Number(entry?.quantity);
      // 数量非正数视为无效配置，静默跳过（配置写错不该让签到整体失败）
      if (!Number.isFinite(quantity) || quantity <= 0) continue;

      if (entry.type === 'exp') {
        await this.playerService.addExp(userId, quantity);
        texts.push(`经验+${formatDisplayNumber(quantity)}`);
        continue;
      }
      if (entry.type === 'vitality') {
        if (ctx.player) {
          ctx.player.vitality = Number(ctx.player.vitality || 0) + quantity;
          texts.push(`活力+${formatDisplayNumber(quantity)}`);
          continue;
        }
        // 没有受管玩家对象（如赛季结算是后台代发的）时，走玩家写锁单独加活力；
        // 否则这一条会被静默丢掉，而后台却看到「活力+N」的发放记录 —— 那是假账。
        const applied = await this.addVitalityDirectly(userId, quantity);
        if (applied) texts.push(`活力+${formatDisplayNumber(quantity)}`);
        continue;
      }
      if (!name) continue;
      await this.playerService.addToBackpack(userId, name, quantity);
      texts.push(`${name}x${formatDisplayNumber(quantity)}`);
    }
    return texts;
  }

  /**
   * 权益类奖励发放（称号 / 头像框 / 功能特权）。
   * 账本缺失（未注入 EntitlementService 的旧桩）时只记告警不抛错，保证签到主流程不受影响。
   */
  private async grantEntitlement(
    userId: number,
    entry: CheckinRewardEntry,
    name: string,
    ctx: CheckinGrantContext = {},
  ): Promise<string> {
    if (!name) return '';
    if (!this.entitlement) {
      this.logger.warn(`奖励条目 ${entry.type}:${name} 需要 EntitlementService，当前未注入（玩家 ${userId}）`);
      return '';
    }
    const source = String(ctx?.source || 'reward');
    if (entry.type === 'title') {
      return (await this.entitlement.grantTitle(userId, name)).text;
    }
    if (entry.type === 'frame') {
      return (await this.entitlement.grantFrame(userId, name, source)).text;
    }
    const days = Number(entry.quantity);
    const grantDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
    const result = await this.entitlement.grantPrivilege(userId, name, {
      source,
      days: grantDays,
      // 天数非正数即「永久」是配置显式表达的意思（0=永久），不是漏填
      permanent: grantDays <= 0,
      reason: ctx?.reason || '',
    });
    return result.text;
  }

  /**
   * 读取数值型配置：非法值（NaN / 负数）回落默认值。
   * 负值无业务含义（经验、天数都不可能为负），统一视为未配置。
   */
  private async readNumber(key: string, fallback: number): Promise<number> {
    try {
      const raw = await this.systemConfig.get<number>(key, fallback);
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    } catch {
      return fallback;
    }
  }

  /** 读取奖励表配置；解析失败时回落内置默认规则并打日志 */
  private async readRewards(): Promise<CheckinRewardsConfig> {
    try {
      const raw = await this.systemConfig.get<any>(CHECKIN_REWARDS_KEY, DEFAULT_CHECKIN_REWARDS);
      return this.normalizeRewards(raw);
    } catch (err: any) {
      this.logger.warn(`读取签到奖励配置失败，回落默认规则: ${err?.message ?? err}`);
      return this.normalizeRewards(DEFAULT_CHECKIN_REWARDS);
    }
  }

  /**
   * 按天数在奖励表中取命中的条目（同一天数配置多组时全部命中）。
   * 天数非正数直接返回空，避免 0/NaN 误命中。
   */
  private matchByDays(
    groups: CheckinRewardGroup[] | undefined,
    days: number,
  ): CheckinRewardEntry[] {
    const target = Number(days);
    if (!Array.isArray(groups) || !Number.isFinite(target) || target <= 0) return [];
    const hit: CheckinRewardEntry[] = [];
    for (const group of groups) {
      if (!group) continue;
      if (Number(group.days) !== target) continue;
      for (const reward of group.rewards || []) {
        if (reward) hit.push(reward);
      }
    }
    return hit;
  }

  /**
   * 规范化奖励表：把数据库里可能被手改坏的结构洗成标准结构。
   * 兼容 item/exp/vitality 三种类型，未知类型按物品处理（name 为空会被发放时跳过）。
   * 数量只认规范键 quantity，业务侧不兜底旧键 count。
   */
  private normalizeRewards(raw: any): CheckinRewardsConfig {
    const source = typeof raw === 'string' ? this.safeJsonParse(raw) : raw;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return this.cloneDefaultRewards();
    }
    const cycle = Number(source.dailyCycleDays);
    return {
      dailyCycleDays: Number.isFinite(cycle) && cycle > 0 ? Math.floor(cycle) : 0,
      daily: this.normalizeGroups(source.daily),
      consecutive: this.normalizeGroups(source.consecutive),
      total: this.normalizeGroups(source.total),
    };
  }

  /** 规范化一组奖励（[{ days, rewards }]），丢弃天数/数量非法的条目 */
  private normalizeGroups(raw: any): CheckinRewardGroup[] {
    if (!Array.isArray(raw)) return [];
    const groups: CheckinRewardGroup[] = [];
    for (const item of raw) {
      if (!item) continue;
      const days = Number(item.days);
      if (!Number.isFinite(days) || days <= 0) continue;
      const rewards: CheckinRewardEntry[] = [];
      for (const r of Array.isArray(item.rewards) ? item.rewards : []) {
        if (!r) continue;
        const quantity = Number(r.quantity);
        const type = CHECKIN_REWARD_TYPES.has(r.type) ? r.type : 'item';
        const isEntitlement = type === 'title' || type === 'frame' || type === 'privilege';
        // 权益类只看 name（称号名/框键/特权键），quantity 仅 privilege 当天数用（0=永久）；
        // 其余类型仍要求正数数量——配置写错不该让一条空奖励混进发放队列。
        if (isEntitlement) {
          const name = String(r.name ?? '').trim();
          if (!name) continue;
          rewards.push({
            type, name,
            quantity: Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 0,
          });
          continue;
        }
        if (!Number.isFinite(quantity) || quantity <= 0) continue;
        rewards.push({ type, name: String(r.name ?? '').trim(), quantity });
      }
      // 整组奖励都无效时保留空组没有意义，直接丢弃
      if (rewards.length > 0) groups.push({ days: Math.floor(days), rewards });
    }
    return groups;
  }

  /** JSON 解析（失败返回 null） */
  private safeJsonParse(raw: string): any {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** 深拷贝内置默认规则，避免调用方改写污染模块级常量 */
  private cloneDefaultRewards(): CheckinRewardsConfig {
    return JSON.parse(JSON.stringify(DEFAULT_CHECKIN_REWARDS)) as CheckinRewardsConfig;
  }
}
