/**
 * 签到奖励服务
 *
 * 职责：把「签到奖励规则」从指令逻辑中抽离为可配置项，并提供统一的发放出口。
 * - 规则（基础经验、连续加成、三张奖励表）全部读自系统配置中心 SystemConfig 表，
 *   管理员在后台「系统配置中心 → 游戏数据」改完立即生效，无需重启；
 * - 奖励发放走唯一出口，支持三种奖励类型：背包物品 / 经验 / 活力；
 * - 所有解析都做容错：配置被改成非法 JSON 或字段缺失时回落到内置默认规则，
 *   保证签到功能不会因为配置写错而整体不可用。
 *
 * 依赖方向：SystemConfig（全局）+ PlayerService；不依赖任何指令域服务。
 */

import { Injectable, Logger } from '@nestjs/common';
import { formatDisplayNumber } from '../../common/utils/game-text.util';
import { SystemConfigService } from '../system-config/system-config.service';
import { PlayerService } from './player.service';
import {
  CHECKIN_BASE_EXP_KEY,
  CHECKIN_CONSECUTIVE_EXP_MAX_DAYS_KEY,
  CHECKIN_CONSECUTIVE_EXP_PER_DAY_KEY,
  CHECKIN_REWARDS_KEY,
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
  /** 奖励表 */
  rewards: CheckinRewardsConfig;
}

/** 发放奖励时的上下文：活力类奖励需要直接改玩家对象（随调用方统一落库） */
export interface CheckinGrantContext {
  player?: any;
}

@Injectable()
export class CheckinRewardService {
  private readonly logger = new Logger(CheckinRewardService.name);

  constructor(
    private readonly systemConfig: SystemConfigService,
    private readonly playerService: PlayerService,
  ) {}

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
   * @param cfg 签到配置
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
   * @param cfg 签到配置
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
   * - vitality：直接累加到传入的 player 对象上，由调用方统一落库，避免多写覆盖。
   * @param userId 玩家 ID
   * @param entries 奖励条目
   * @param ctx 发放上下文（活力类需要 player 对象）
   */
  async grantRewards(
    userId: number,
    entries: CheckinRewardEntry[],
    ctx: CheckinGrantContext = {},
  ): Promise<string[]> {
    const texts: string[] = [];
    if (!Array.isArray(entries) || entries.length === 0) return texts;

    for (const entry of entries) {
      // 数量只读规范键 quantity（旧键 count 已在 normalizeRewards 边界归一化）
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
        }
        texts.push(`活力+${formatDisplayNumber(quantity)}`);
        continue;
      }
      const name = String(entry?.name ?? '').trim();
      if (!name) continue;
      await this.playerService.addToBackpack(userId, name, quantity);
      texts.push(`${name}x${formatDisplayNumber(quantity)}`);
    }
    return texts;
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
   * 数量只认规范键 quantity（历史 count 已由 system-config 幂等升级收敛，业务侧不再兜底旧键）。
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
        if (!Number.isFinite(quantity) || quantity <= 0) continue;
        const type = r.type === 'exp' || r.type === 'vitality' ? r.type : 'item';
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
