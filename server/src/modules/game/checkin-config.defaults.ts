/**
 * 签到奖励配置：配置键、数据结构与默认值（纯常量模块，不依赖任何服务）
 *
 * 单独成文件的原因：系统配置中心(system-config)需要「默认值」来补数据库行，
 * 签到业务服务需要「同一份默认值」做兜底。若把默认值放在业务服务里再由
 * system-config 反向 import，会形成 system-config → game → system-config 的
 * 运行时循环依赖（Nest 解析出的可能是 undefined）。因此抽成无依赖常量模块。
 *
 * 遵循"配置项抽取"原则：签到给多少经验、哪天给什么东西，全部可在后台
 * 「系统配置中心 → 游戏数据」在线调整，改完立即生效，无需改代码或重启。
 */

/** 签到奖励类型：item=背包物品 / exp=经验 / vitality=活力 */
export type CheckinRewardType = 'item' | 'exp' | 'vitality';

/** 单条奖励条目：type=item 时 name 为物品名；exp/vitality 时 name 无意义（留空） */
export interface CheckinRewardEntry {
  type: CheckinRewardType;
  name: string;
  count: number;
}

/** 一组奖励：days 为触发天数（每日表=连续第几天；连续表=连续签到天数；累计表=累计签到天数） */
export interface CheckinRewardGroup {
  days: number;
  rewards: CheckinRewardEntry[];
}

/** 三张奖励表 + 每日表的循环周期 */
export interface CheckinRewardsConfig {
  /** 每日奖励循环周期（天）；>0 时按周期取模轮转，0=不循环（只有精确匹配第 N 天才发） */
  dailyCycleDays: number;
  /** 每日签到奖励：按「连续签到第 N 天」发放 */
  daily: CheckinRewardGroup[];
  /** 连续签到里程碑奖励：连续签到满 N 天时发放一次 */
  consecutive: CheckinRewardGroup[];
  /** 累计签到里程碑奖励：累计签到满 N 天时发放一次 */
  total: CheckinRewardGroup[];
}

// ===== 配置键（SystemConfig 表 key） =====

/** 签到基础经验 */
export const CHECKIN_BASE_EXP_KEY = 'game.checkinBaseExp';
/** 每连续签到 1 天额外增加的经验 */
export const CHECKIN_CONSECUTIVE_EXP_PER_DAY_KEY = 'game.checkinConsecutiveExpPerDay';
/** 连续天数经验加成的封顶天数（0=不封顶） */
export const CHECKIN_CONSECUTIVE_EXP_MAX_DAYS_KEY = 'game.checkinConsecutiveExpMaxDays';
/** 签到奖励表（每日/连续/累计三张表，JSON） */
export const CHECKIN_REWARDS_KEY = 'game.checkinRewards';

// ===== 默认值：与改造前硬编码规则完全一致 =====

/** 原实现：baseExp = 50 */
export const DEFAULT_CHECKIN_BASE_EXP = 50;
/** 原实现：连续奖励 = min(连续天数, 30) * 5 */
export const DEFAULT_CHECKIN_CONSECUTIVE_EXP_PER_DAY = 5;
export const DEFAULT_CHECKIN_CONSECUTIVE_EXP_MAX_DAYS = 30;

/**
 * 默认奖励表（= 当前游戏真实存在的签到默认奖励）：
 * 默认只保留经验奖励（基础 50 + 每连续 1 天 +5，封顶 30 天，见上方三个数值键），
 * 三张物品奖励表默认留空——「签到礼包/累计签到礼包」并不在游戏道具表(items.json)中，
 * 属于历史残留规则，不应作为默认配置。
 * 「哪天给什么物品」由运营在后台按需配置（物品从目录中选择，保证一定存在）。
 */
export const DEFAULT_CHECKIN_REWARDS: CheckinRewardsConfig = {
  dailyCycleDays: 7,
  daily: [],
  consecutive: [],
  total: [],
};

/** 供 SystemConfig 表补默认行使用的 JSON 字符串 */
export const DEFAULT_CHECKIN_REWARDS_JSON = JSON.stringify(DEFAULT_CHECKIN_REWARDS);

/**
 * 历史版本的默认奖励表（含「签到礼包/累计签到礼包」）。
 * 仅用于启动时迁移：库里「恰好等于该值」的行会被升级为新默认（空表），
 * 管理员自定义过的奖励表不受影响。
 */
export const LEGACY_CHECKIN_REWARDS_JSON = JSON.stringify({
  dailyCycleDays: 7,
  daily: [],
  consecutive: [
    { days: 7, rewards: [{ type: 'item', name: '签到礼包', count: 1 }] },
    { days: 15, rewards: [{ type: 'item', name: '签到礼包', count: 2 }] },
    { days: 30, rewards: [{ type: 'item', name: '签到礼包', count: 3 }] },
  ],
  total: [
    { days: 30, rewards: [{ type: 'item', name: '累计签到礼包', count: 1 }] },
    { days: 100, rewards: [{ type: 'item', name: '累计签到礼包', count: 2 }] },
    { days: 365, rewards: [{ type: 'item', name: '累计签到礼包', count: 3 }] },
  ],
});
