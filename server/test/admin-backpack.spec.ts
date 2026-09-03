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
    getPlayerData: async () => ({ player: dbPlayer }),
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

/**
 * 组装用于「发放物品私聊通知」测试的 AdminService
 * 提供带 Spy 的 chatService 与 staticData，并 Stub addToBackpack 成功
 */
function buildGiveNoticeService() {
  const sendPrivate: jest.Mock = jest.fn(async () => ({}));
  const chatService: any = { sendPrivateMessage: sendPrivate };
  const staticData: any = {
    getItemByName: jest.fn((name) =>
      name === '水晶' ? { description: '零号元素结晶', type: '物品' } : null,
    ),
    getEquipmentByName: jest.fn(() => null),
    getAllItems: jest.fn(() => [
      { name: '水晶' },
      { name: '铁矿石' },
      { name: '巧克力' },
    ]),
    getAllEquipments: jest.fn(() => [
      { name: '石剑', equipType: '装备' },
      { name: '铁剑', equipType: '武器' },
    ]),
  };
  const playerService: any = { addToBackpack: jest.fn(async () => true) };
  const prisma: any = { user: {}, player: {} };
  const service = new AdminService(
    prisma,
    playerService,
    chatService,
    { updateSystemConfig: jest.fn() } as any,
    staticData,
    {} as any,
    {} as any,
  );
  return { service, sendPrivate, addToBackpack: playerService.addToBackpack };
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

describe('AdminService 发放物品后私聊通知', () => {
  it('gmGiveItem 携带操作者时向目标玩家私聊推送操作与物品明细', async () => {
    const { service, sendPrivate, addToBackpack } = buildGiveNoticeService();
    await service.gmGiveItem(5, '水晶', 2, 999);

    expect(addToBackpack).toHaveBeenCalledWith(5, '水晶', 2);
    expect(sendPrivate).toHaveBeenCalledTimes(1);
    // 发送者=操作者999，接收者=目标5
    expect(sendPrivate.mock.calls[0][0]).toBe(999);
    expect(sendPrivate.mock.calls[0][1]).toBe(5);
    // 内容包含「操作」与「详细物品信息」（名称/数量/类型/描述）
    const content: string = sendPrivate.mock.calls[0][2];
    expect(content).toContain('GM 发放通知');
    expect(content).toContain('水晶 ×2（物品）');
    expect(content).toContain('零号元素结晶');
  });

  it('gmGiveItemBatch 携带操作者时私聊列表含全部物品明细', async () => {
    const { service, sendPrivate } = buildGiveNoticeService();
    await service.gmGiveItemBatch(5, [
      { itemName: '水晶', count: 3 },
      { itemName: '铁矿石', count: 5 },
    ], 999);

    expect(sendPrivate).toHaveBeenCalledTimes(1);
    const content: string = sendPrivate.mock.calls[0][2];
    expect(content).toContain('水晶 ×3（物品）');
    expect(content).toContain('铁矿石 ×5（物品）');
    expect(content).toContain('2 种物品');
  });

  it('未提供操作者时不发私聊通知（不干扰发放本身）', async () => {
    const { service, sendPrivate } = buildGiveNoticeService();
    await service.gmGiveItem(5, '水晶', 2);
    expect(sendPrivate).not.toHaveBeenCalled();
  });

  it('发放给自己时不发私聊通知', async () => {
    const { service, sendPrivate } = buildGiveNoticeService();
    await service.gmGiveItem(5, '水晶', 2, 5);
    expect(sendPrivate).not.toHaveBeenCalled();
  });
});