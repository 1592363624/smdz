/**
 * 世界红包配置
 *
 * 配置项抽取原则：红包有效期、份数上限、可发放道具范围等都可能随运营调整，
 * 因此默认值集中在此文件，并由「系统配置中心」的 chat.redPacket 项覆盖
 * （管理员可在管理后台在线修改，无需改代码、无需重启）。
 *
 * 读取入口：SystemConfigService.getRedPacketConfig() → RedPacketService.getConfig()
 */

/** 世界红包生效配置 */
export interface RedPacketConfig {
  /** 红包有效期（小时）：到期后未被领完的份额自动退回发送者背包 */
  expireHours: number;
  /** 单个红包最多可放入的道具种类数 */
  maxItemKinds: number;
  /** 单个红包的最大总份数（= 各道具数量之和，1 份 = 1 个道具） */
  maxTotalCount: number;
  /** 单个红包的最小总份数 */
  minTotalCount: number;
  /** 祝福语最大字符数 */
  maxGreetingLength: number;
  /** 是否允许把装备类道具放入红包（装备为独立实例，按名发放会丢失词条，默认关闭） */
  allowEquipment: boolean;
  /** 是否允许把硬通货（钻石/召唤券/数据核心）放入红包（默认关闭，避免绕过货币审计） */
  allowCurrency: boolean;
  /** 前端可查询的红包历史时间窗（小时），超过则不再返回状态（消息本身仍在聊天记录里） */
  historyHours: number;
}

/** 代码内置默认值（系统配置缺失/损坏时兜底） */
export const DEFAULT_RED_PACKET_CONFIG: RedPacketConfig = {
  expireHours: 24,
  maxItemKinds: 10,
  maxTotalCount: 100,
  minTotalCount: 1,
  maxGreetingLength: 60,
  allowEquipment: false,
  allowCurrency: false,
  historyHours: 72,
};

/**
 * 硬通货名称：其真相源是 Player 的独立标量列（diamonds/tickets/dataCores），
 * 增减需走货币审计（CurrencyLog），因此默认禁止放入红包，避免绕过审计凭空造币。
 */
export const HARD_CURRENCY_NAMES = ['钻石', '召唤券', '数据核心'];

/** 系统配置中心键名（json 类型，管理员在线可改） */
export const RED_PACKET_CONFIG_KEY = 'chat.redPacket';

/** 默认配置的 JSON 文本：用于写入系统配置中心默认项 */
export const DEFAULT_RED_PACKET_CONFIG_JSON = JSON.stringify(DEFAULT_RED_PACKET_CONFIG, null, 2);

/**
 * 把任意来源（系统配置 JSON 字符串 / 对象 / 脏数据）归一化为合法配置。
 * 任何字段非法（缺失、非数字、越界）都回退默认值，保证调用方拿到的永远可用。
 */
export function normalizeRedPacketConfig(raw: any): RedPacketConfig {
  const base = DEFAULT_RED_PACKET_CONFIG;
  let src: any = raw;
  if (typeof src === 'string') {
    try {
      src = JSON.parse(src);
    } catch {
      src = null;
    }
  }
  if (!src || typeof src !== 'object') return { ...base };

  // 数值归一化：非法或小于下限时回退默认值
  const num = (value: any, fallback: number, min = 1): number => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  const bool = (value: any, fallback: boolean): boolean => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
  };

  return {
    expireHours: num(src.expireHours, base.expireHours),
    maxItemKinds: num(src.maxItemKinds, base.maxItemKinds),
    maxTotalCount: num(src.maxTotalCount, base.maxTotalCount),
    minTotalCount: num(src.minTotalCount, base.minTotalCount),
    maxGreetingLength: num(src.maxGreetingLength, base.maxGreetingLength, 1),
    allowEquipment: bool(src.allowEquipment, base.allowEquipment),
    allowCurrency: bool(src.allowCurrency, base.allowCurrency),
    historyHours: num(src.historyHours, base.historyHours),
  };
}
