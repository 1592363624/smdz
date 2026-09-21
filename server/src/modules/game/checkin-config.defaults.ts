/**
 * 签到奖励配置：配置键、数据结构与默认值（纯常量模块，不依赖任何服务）。
 * 单独成文件是为了避开 system-config → game → system-config 的运行时循环依赖
 * （Nest 解析出的可能是 undefined）：配置中心与签到业务共用这一份默认值。
 * 数值全部可在后台「系统配置中心 → 游戏数据」在线调整，改完立即生效。
 */

/**
 * 奖励类型：item=背包物品 / exp=经验 / vitality=活力
 * / title=称号直发 / frame=头像框 / privilege=功能特权（后三类由竞技场赛季奖励引入，
 *   发放口统一走 CheckinRewardService.grantRewards → EntitlementService，配置即可用）。
 */
export type CheckinRewardType = 'item' | 'exp' | 'vitality' | 'title' | 'frame' | 'privilege';

/**
 * 单条奖励条目：
 * - type=item 时 name 为物品名；exp/vitality 时 name 无意义（留空）；
 * - type=title 时 name 为称号名、frame 时 name 为头像框键；
 * - type=privilege 时 name 为特权键（如 batchGather），quantity 为**有效天数**（0=永久）。
 */
export interface CheckinRewardEntry {
  type: CheckinRewardType;
  name: string;
  /** 奖励数量：规范键只有 quantity，读写 count 拿到 undefined */
  quantity: number;
}

/** 合法奖励类型白名单：配置里出现表外类型会被归一成 item（避免拼错键名导致静默不发） */
export const CHECKIN_REWARD_TYPES: ReadonlySet<CheckinRewardType> = new Set<CheckinRewardType>([
  'item', 'exp', 'vitality', 'title', 'frame', 'privilege',
]);

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

// ===== 默认值 =====

export const DEFAULT_CHECKIN_BASE_EXP = 50;
/** 连续奖励 = min(连续天数, 封顶天数) × 本值 */
export const DEFAULT_CHECKIN_CONSECUTIVE_EXP_PER_DAY = 5;
export const DEFAULT_CHECKIN_CONSECUTIVE_EXP_MAX_DAYS = 30;

/**
 * 默认奖励表：经验奖励见上方三个数值键，三张物品表刻意留空——
 * 「签到礼包/累计签到礼包」不在游戏道具表(items.json)中，不应作为默认配置，
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
 * 存量比对基准（非现行字段规范）：启动迁移时库里「恰好等于该 JSON」的行会被升级成
 * DEFAULT_CHECKIN_REWARDS，管理员自定义过的奖励表不受影响。
 * 必须与历史落库值**逐字一致**（故保留当时的旧键 count），否则迁移比对失配。
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
