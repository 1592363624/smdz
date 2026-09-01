import { ActorRuntime } from './actor-runtime';
import { asJsonValue } from '../../common/utils/json-value.util';

/**
 * 把「全部有状态实体」注册为 Actor 类型。
 *
 * 玩家（player）由 PlayerService 自行注册，因为要复用 getPlayerData/savePlayer 的
 * 货币列化、标记归一化、BigInt 转换等逻辑。这里注册其余实体：怪物/地图/载具/商店物品。
 * 它们各自有独立 Prisma 表，load 从表载入整行作为内存态，save 整行落库。
 *
 * 注册后这些实体即可通过 runtime.run/tell('monster', id, ...) 以 Actor 语义访问，
 * 天然串行、单激活、无锁无 CAS。游戏内具体调用点（战斗结算怪物 HP 等）迁移到 Actor
 * 是后续按调用点的渐进式改造，本步先把「实体即 Actor」的框架能力铺好。
 */

/**
 * 各实体 Json 列字段与空值形态（{} = 对象型、[] = 数组型）。
 * load/save 时按此清单归一化：Json 列读取已是真实对象；字符串形态（存量行）
 * 由 asJsonValue 容错解析，保证内存态与落库值均为真实结构（杜绝双重编码）。
 */
const JSON_FIELD_DEFAULTS: Record<string, Record<string, unknown>> = {
  // 怪物：加成/套装为对象，装备/武器/增益/背包/标记等为数组（markers 默认形态与 schema ('[]') 一致）
  monster: {
    bonus: {}, baseBonus: {}, extraBonus: {}, set: {},
    equipments: [], weapons: [], equipmentPresets: [], buffs: [],
    achievements: [], backpack: [], markers: [], markers2: [],
  },
  // 地图：标记为对象，怪物/NPC/资源/连接/建筑/载具/增益等为数组
  map: {
    markers: {},
    monsters: [], spawnMonsters: [], tempMonsters: [], summons: [],
    resources: [], resources2: [], connections: [], npcs: [], items: [],
    buildings: [], vehicles: [], markers2: [], mapBuffs: [], requireMarkers: [],
  },
  // 载具：加成/标记为对象，部件/配方/内置部件/标记2 为数组
  vehicle: {
    bonus: {}, markers: {},
    parts: [], markers2: [], recipes: [], builtinParts: [],
  },
};

/**
 * 把行/内存态中的 Json 字段归一化为真实对象/数组。
 * 仅处理 state 中已存在的键（不新增字段，保持 update 语义：缺省键不落库）。
 * @param type 实体类型键（JSON_FIELD_DEFAULTS 的键）
 * @param state 行对象或内存态
 * @returns 归一化后的同一对象引用
 */
function normalizeJsonFields(type: string, state: Record<string, any>): Record<string, any> {
  const defaults = JSON_FIELD_DEFAULTS[type];
  if (!defaults) return state;
  for (const [field, fallback] of Object.entries(defaults)) {
    // 仅归一化已存在的字段；undefined/null 也走 asJsonValue 回退到该字段的空值形态
    if (field in state) {
      state[field] = asJsonValue(state[field], fallback);
    }
  }
  return state;
}

export function registerBuiltinActorTypes(runtime: ActorRuntime, prisma: any): void {
  // 怪物运行时实例
  runtime.registerType('monster', {
    load: async (id) => {
      const row = await prisma.gameMonster.findUnique({ where: { id: Number(id) } });
      if (!row) throw new Error(`怪物 Actor 不存在: ${id}`);
      // Json 列归一化：保证内存态恒为对象/数组（存量字符串行兼容）
      return normalizeJsonFields('monster', row);
    },
    save: async (id, state) => {
      const { createdAt, ...rest } = normalizeJsonFields('monster', { ...state } as any);
      // Json 字段已是对象/数组，直接落库（stringify 会双重编码）
      await prisma.gameMonster.update({ where: { id: Number(id) }, data: rest });
    },
    persist: 'writeThrough',
  });

  // 地图（怪物/NPC 以 JSON 嵌在地图行内，地图 Actor 串行化地图级变更）
  runtime.registerType('map', {
    load: async (id) => {
      const row = await prisma.gameMap.findUnique({ where: { id: Number(id) } });
      if (!row) throw new Error(`地图 Actor 不存在: ${id}`);
      return normalizeJsonFields('map', row);
    },
    save: async (id, state) => {
      const { createdAt, ...rest } = normalizeJsonFields('map', { ...state } as any);
      await prisma.gameMap.update({ where: { id: Number(id) }, data: rest });
    },
    persist: 'writeThrough',
  });

  // 载具
  runtime.registerType('vehicle', {
    load: async (id) => {
      const row = await prisma.gameVehicle.findUnique({ where: { id: Number(id) } });
      if (!row) throw new Error(`载具 Actor 不存在: ${id}`);
      return normalizeJsonFields('vehicle', row);
    },
    save: async (id, state) => {
      const { createdAt, ...rest } = normalizeJsonFields('vehicle', { ...state } as any);
      await prisma.gameVehicle.update({ where: { id: Number(id) }, data: rest });
    },
    persist: 'writeThrough',
  });

  // 商店物品
  runtime.registerType('shopitem', {
    load: async (id) => {
      const row = await prisma.gameShopItem.findUnique({ where: { id: Number(id) } });
      if (!row) throw new Error(`商店物品 Actor 不存在: ${id}`);
      return row;
    },
    save: async (id, state) => {
      const { createdAt, ...rest } = state as any;
      await prisma.gameShopItem.update({ where: { id: Number(id) }, data: rest });
    },
    persist: 'writeThrough',
  });
}
