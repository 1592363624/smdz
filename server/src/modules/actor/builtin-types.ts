import { ActorRuntime } from './actor-runtime';

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
export function registerBuiltinActorTypes(runtime: ActorRuntime, prisma: any): void {
  // 怪物运行时实例
  runtime.registerType('monster', {
    load: async (id) => {
      const row = await prisma.gameMonster.findUnique({ where: { id: Number(id) } });
      if (!row) throw new Error(`怪物 Actor 不存在: ${id}`);
      return row;
    },
    save: async (id, state) => {
      const { createdAt, ...rest } = state as any;
      await prisma.gameMonster.update({ where: { id: Number(id) }, data: rest });
    },
    persist: 'writeThrough',
  });

  // 地图（怪物/NPC 以 JSON 嵌在地图行内，地图 Actor 串行化地图级变更）
  runtime.registerType('map', {
    load: async (id) => {
      const row = await prisma.gameMap.findUnique({ where: { id: Number(id) } });
      if (!row) throw new Error(`地图 Actor 不存在: ${id}`);
      return row;
    },
    save: async (id, state) => {
      const { createdAt, ...rest } = state as any;
      await prisma.gameMap.update({ where: { id: Number(id) }, data: rest });
    },
    persist: 'writeThrough',
  });

  // 载具
  runtime.registerType('vehicle', {
    load: async (id) => {
      const row = await prisma.gameVehicle.findUnique({ where: { id: Number(id) } });
      if (!row) throw new Error(`载具 Actor 不存在: ${id}`);
      return row;
    },
    save: async (id, state) => {
      const { createdAt, ...rest } = state as any;
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
