/**
 * GM 后台「背包管理」单元测试
 * 覆盖 AdminService.gmGetBackpack / gmSaveBackpack 的核心归一化逻辑：
 * 同名合并、quantity→count 统一、数量=0 删除、非法数量校验、无角色保护。
 * 通过 Stub 掉 PrismaService 与 PlayerService，只验证业务层行为。
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from '../src/modules/admin/admin.service';
import { parseJson } from './parse-json.util';

/** 组装 AdminService，仅 Stub 用到的依赖，其余传空桩 */
function buildService(dbPlayer: any, dbUser: any) {
  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }) => {
        return dbUser && where.id === dbUser.id ? { ...dbUser } : null;
      }),
    },
    player: {
      findUnique: jest.fn(async ({ where }) => {
        return dbPlayer && where.userId === dbPlayer.userId ? dbPlayer : null;
      }),
    },
  };

  const playerService: any = {
    // 与 PlayerService 真实实现等价：string → 数组
    getBackpackItems: (p: any) => {
      const b = p?.backpack;
      if (typeof b === 'string') {
        try {
          return JSON.parse(b);
        } catch {
          return [];
        }
      }
      return Array.isArray(b) ? b : [];
    },
    // 直接同步执行回调；回调内通过 getPlayerData 读共享对象、savePlayer 写回同一对象
    enqueueUserWrite: async (_uid: number, fn: () => Promise<unknown>) => fn(),
    // 与 PlayerService.getPlayerData 对齐：把独立货币列物化回背包数组
    // （真相源是 diamonds/tickets/dataCores 列，落库时背包 JSON 不含货币条目）
    // 直接改 dbPlayer 引用：savePlayer 桩为空实现，Object.assign 才能落到断言读的同一对象。
    getPlayerData: async () => {
      const player = dbPlayer;
      const raw = player.backpack;
      let items: any[] = [];
      if (typeof raw === 'string') {
        try { items = JSON.parse(raw); } catch { items = []; }
      } else if (Array.isArray(raw)) {
        items = raw.map((it: any) => ({ ...it }));
      }
      const upsert = (name: string, qty: number) => {
        if (!Number.isFinite(qty) || qty <= 0) return;
        const idx = items.findIndex((it: any) => it?.name === name);
        if (idx >= 0) {
          items[idx].quantity = qty;
          items[idx].count = qty;
        } else {
          items.push({ name, type: '资源', quantity: qty, count: qty });
        }
      };
      if (player.diamonds !== undefined) upsert('钻石', Number(player.diamonds ?? 0));
      if (player.tickets !== undefined) upsert('召唤券', Number(player.tickets ?? 0));
      if (player.dataCores !== undefined) upsert('数据核心', Number(player.dataCores ?? 0));
      player.backpack = items;
      (player as any)._currencyMirror = {
        钻石: Number(player.diamonds ?? 0),
        召唤券: Number(player.tickets ?? 0),
        数据核心: Number(player.dataCores ?? 0),
      };
      return { player };
    },
    savePlayer: async () => undefined,
  };

  // 其余依赖（chat/systemConfig/staticData/stats）在本测试使用的方法中不会触达，给空桩即可
  const chatService: any = {};
  const systemConfigService: any = {};
  const staticData: any = {};
  const statsService: any = {};

  const service = new AdminService(
    prisma,
    playerService,
    chatService,
    systemConfigService,
    staticData,
    statsService,
    {} as any,
  );
  return { service, dbPlayer };
}

describe('AdminService 背包管理', () => {
  it('gmGetBackpack 解析玩家背包全部物品', async () => {
    const dbPlayer = {
      userId: 5,
      backpack: JSON.stringify([
        { name: '水晶', count: 10 },
        { name: '石制工具', type: '装备', quantity: 1, durability: 0, data: 'e' },
      ]),
    };
    const { service } = buildService(dbPlayer, { id: 5, username: 'alice' });

    const items = await service.gmGetBackpack(5);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ name: '水晶', count: 10 });
    expect(items[1]).toMatchObject({ name: '石制工具', type: '装备', durability: 0 });
  });

  it('gmGetBackpack 对未创建角色的用户抛 NotFound', async () => {
    const { service } = buildService(null, { id: 9, username: 'bob' });
    await expect(service.gmGetBackpack(9)).rejects.toThrow(NotFoundException);
  });

  it('gmGetBackpack 物化独立货币列（钻石/召唤券/数据核心）回背包', async () => {
    // 落库态：背包 JSON 不含货币条目（savePlayer 会剥离），真相源在独立列
    const dbPlayer = {
      userId: 5,
      backpack: JSON.stringify([{ name: '水晶', count: 10 }]),
      diamonds: 1000,
      tickets: 3,
      dataCores: 0, // 0 不物化
    };
    const { service } = buildService(dbPlayer, { id: 5, username: 'alice' });

    const items = await service.gmGetBackpack(5);
    expect(items).toContainEqual(expect.objectContaining({ name: '水晶', count: 10 }));
    expect(items).toContainEqual(
      expect.objectContaining({ name: '钻石', count: 1000, quantity: 1000, type: '资源' }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({ name: '召唤券', count: 3, quantity: 3, type: '资源' }),
    );
    expect(items.some((i: any) => i.name === '数据核心')).toBe(false);
  });

  it('gmSaveBackpack 同名合并、quantity/count 统一为 count、数量0删除', async () => {
    const dbPlayer = { userId: 5, backpack: JSON.stringify([]) };
    const { service, dbPlayer: dp } = buildService(dbPlayer, { id: 5, username: 'alice' });

    const msg = await service.gmSaveBackpack(5, [
      { name: '水晶', quantity: 5 },
      { name: '水晶', quantity: 5 }, // 同名合并 → 10
      { name: '木头', count: 3 },
      { name: '面包', quantity: 0 }, // 0 → 删除
      { name: '石制工具', quantity: 1, type: '装备', durability: 0, data: 'e' },
    ]);

    expect(msg).toContain('3 种物品');
    const saved = parseJson(dp.backpack, []);
    expect(saved).toHaveLength(3);
    expect(saved).toContainEqual({ name: '水晶', count: 10 });
    expect(saved).toContainEqual({ name: '木头', count: 3 });
    // quantity 已被清理为 count，durability/data 保留
    expect(saved).toContainEqual(expect.objectContaining({ name: '石制工具', count: 1, durability: 0, data: 'e' }));
    expect(saved.some((i: any) => i.quantity !== undefined)).toBe(false);
  });

  it('gmSaveBackpack 拒绝非法（负数）数量', async () => {
    const dbPlayer = { userId: 5, backpack: JSON.stringify([]) };
    const { service } = buildService(dbPlayer, { id: 5, username: 'alice' });

    await expect(service.gmSaveBackpack(5, [{ name: '水晶', quantity: -3 }])).rejects.toThrow(
      BadRequestException,
    );
  });

  it('gmSaveBackpack 非数组数据拒绝', async () => {
    const dbPlayer = { userId: 5, backpack: JSON.stringify([]) };
    const { service } = buildService(dbPlayer, { id: 5, username: 'alice' });

    await expect(service.gmSaveBackpack(5, null as any)).rejects.toThrow(BadRequestException);
  });

  it('gmSaveBackpack 对未创建角色的用户抛 NotFound（不写入）', async () => {
    const { service } = buildService(null, { id: 9, username: 'bob' });
    await expect(service.gmSaveBackpack(9, [{ name: '水晶', quantity: 1 }])).rejects.toThrow(
      NotFoundException,
    );
  });
});