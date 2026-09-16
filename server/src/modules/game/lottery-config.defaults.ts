/**
 * 抽奖系统默认配置（纯常量模块，不依赖任何服务）
 *
 * 遵循「配置项抽取」原则：每日次数、消耗凭证、奖池排除名单等
 * 全部可在后台「系统配置中心」在线调整，无需改代码或重启。
 * 单独成文件的原因同 checkin-config.defaults：避免 system-config ↔ game 循环依赖。
 */

/** 每日抽奖次数上限配置键（0 = 当日关闭抽奖） */
export const LOTTERY_DAILY_LIMIT_KEY = 'game.lotteryDailyLimit';
/** 抽奖消耗的凭证物品名配置键 */
export const LOTTERY_TICKET_ITEM_KEY = 'game.lotteryTicketItem';
/** 单次抽奖消耗的凭证数量配置键 */
export const LOTTERY_TICKET_COST_KEY = 'game.lotteryTicketCost';
/** 奖池排除名单（JSON 数组）配置键 */
export const LOTTERY_POOL_EXCLUDE_KEY = 'game.lotteryPoolExclude';
/** 抽奖总开关配置键 */
export const LOTTERY_ENABLED_KEY = 'game.lotteryEnabled';

/** 原实现：每人每天 1 次 */
export const DEFAULT_LOTTERY_DAILY_LIMIT = 1;
/** 原实现：消耗「凭证」x1 */
export const DEFAULT_LOTTERY_TICKET_ITEM = '凭证';
export const DEFAULT_LOTTERY_TICKET_COST = 1;

/**
 * 默认奖池排除名单：
 * - 模板类物品只用于格式样板，不是真实可发放道具；
 * - 不排除「凭证」——允许中奖回本/多得，但每日上限锁死 1 次，不会刷穿。
 */
export const DEFAULT_LOTTERY_POOL_EXCLUDE: string[] = [
  '物品模板',
  '武器模板',
  '装备模板',
];

/** 供 SystemConfig 表补默认行使用的 JSON 字符串 */
export const DEFAULT_LOTTERY_POOL_EXCLUDE_JSON = JSON.stringify(
  DEFAULT_LOTTERY_POOL_EXCLUDE,
);

/** 抽奖结果：ok=是否成功；message=给玩家看的文案；reward=中奖条目（成功时） */
export interface LotteryDrawResult {
  ok: boolean;
  message: string;
  reward?: { name: string; count: number; type: string };
  /** 是否因今日已抽满而失败 */
  dailyLimitHit?: boolean;
  /** 是否因凭证不足而失败 */
  noTicket?: boolean;
}

/** 奖池条目（给前端滚动动画用） */
export interface LotteryPoolEntry {
  name: string;
  count: number;
  /** 资源 / 装备（武器） */
  kind: 'resource' | 'weapon';
}
