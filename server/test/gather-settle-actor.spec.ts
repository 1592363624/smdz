/**
 * 回归：采集结算链（tick → dispatch → mutate → enqueueUserWrite → getPlayerData → savePlayer）
 * 必须把「采集中」标记的删除与产出落库。
 *
 * 线上实测（2026-09-12，超管批量"收集石头60"）：结算产出/经验/任务/熟练度全部落库，
 * 唯独 markers['采集中'] 的删除没写进库 → 前端读条（PendingActionBar gather 条）不消失。
 *
 * 本测试用真实 PlayerService + 真实 ActorRuntime + 真实 PlayerMutateService（内存 prisma），
 * 按生产同形复现两条链路：
 *   1) 结算链内 enqueueUserWrite → getPlayerData → 删采集中 → savePlayer；
 *   2) 结算链内「重读快照再写回」（对齐 applySettleGatherResource 的采集熟练度写入）。
 */

import { PlayerService } from '../src/modules/game/player.service';
import { PlayerMutateService } from '../src/modules/game/player-mutate.service';
import { PlayerMutateContextService } from '../src/modules/game/player-mutate-context.service';
import { ActorRuntime } from '../src/modules/actor/actor-runtime';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { AdminCommandService } from '../src/modules/game/commands/admin-command.service';
import { asJsonValue } from '../src/common/utils/json-value.util';

function makePrisma(rows: any[]) {
  const prisma: any = {
    player: {
      findUnique: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) => r.userId === where?.userId);
        return row ? { ...row } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) =>
          (where?.userId !== undefined && r.userId === where.userId)
          || (where?.id !== undefined && r.id === where.id));
        if (!row) {
          const err: any = new Error('not found'); err.code = 'P2025'; throw err;
        }
        Object.assign(row, data);
        row.version = Number(row.version ?? 0) + 1;
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where?.id && r.version === where?.version);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    currencyLog: { create: jest.fn(async () => undefined) },
  };
  return prisma;
}

function makeRow(overrides: any = {}) {
  return {
    id: 1, userId: 501, name: '测试者', level: 1, exp: 0, version: 0, mapId: 1,
    markers: JSON.stringify({ 活力2: 100 }),
    markers2: '[]', buffs: '[]', backpack: '[]', tasks: '[]', equipment: '[]',
    weapons: '[]', safeBox: '[]', titles: '[]', skills: '[]',
    diamonds: 0, tickets: 0, dataCores: 0,
    ...overrides,
  };
}

function makeServices(rows: any[]) {
  const prisma = makePrisma(rows);
  const runtime = new ActorRuntime({ flushIntervalMs: 0 });
  const playerService = new PlayerService(
    prisma,
    { getEquipmentByName: () => undefined } as unknown as StaticDataService,
    {} as any,
    undefined,
    runtime,
  );
  (playerService as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  const mutateContext = new PlayerMutateContextService();
  const mutate = new PlayerMutateService(prisma, playerService, mutateContext);
  (mutate as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  return { prisma, runtime, playerService, mutate, mutateContext };
}

function rowMarkers(rows: any[]): Record<string, any> {
  const row = rows.find((r) => r.userId === 501)!;
  return asJsonValue<Record<string, any>>(row.markers, {});
}

function rowBackpack(rows: any[]): any[] {
  const row = rows.find((r) => r.userId === 501)!;
  return asJsonValue<any[]>(row.backpack, []);
}

describe('采集结算在 Actor/mutate 链内的落库（线上读条残留回归）', () => {
  it('结算链内 enqueueUserWrite → 删采集中 + 产出 → 必须落库', async () => {
    const rows: any[] = [makeRow()];
    const { playerService, mutate } = makeServices(rows);

    // 1) 采集开始（mutate 内写采集中，模拟 handleGatherResource）
    await mutate.mutate(501, async (ctx: any) => {
      ctx.markers['采集中'] = {
        cmd: '收集石头', count: 60, target: '大石头',
        startedAt: Date.now(), settleAt: Date.now() + 5640 * 1000, adminBatch: true,
      };
    });
    expect(rowMarkers(rows)['采集中']).toBeDefined();

    // 2) 结算（模拟 tick → dispatch → mutate → settleGatherResource 的同形链路）
    await mutate.mutate(501, async () => {
      await playerService.enqueueUserWrite(501, async () => {
        const pd = await playerService.getPlayerData(501);
        const markers = asJsonValue<Record<string, any>>(pd.player.markers, {});
        delete markers['采集中'];
        markers['采集熟练度'] = Number(markers['采集熟练度'] ?? 0) + 60;
        pd.player.markers = markers;
        const backpack = asJsonValue<any[]>(pd.player.backpack, []);
        backpack.push({ name: '石头', type: '物品', count: 190.8, quantity: 190.8 });
        pd.player.backpack = backpack;
        await playerService.savePlayer(pd.player);
      });
    });

    // 3) 断言落库结果
    const markers = rowMarkers(rows);
    expect(markers['采集中']).toBeUndefined();
    expect(markers['采集熟练度']).toBe(60);
    expect(rowBackpack(rows)).toEqual([
      expect.objectContaining({ name: '石头' }),
    ]);
  });

  it('结算链内「重读快照再写回」（采集熟练度同形写法）不得复活已删除的采集中', async () => {
    const rows: any[] = [makeRow()];
    const { playerService, mutate } = makeServices(rows);

    await mutate.mutate(501, async (ctx: any) => {
      ctx.markers['采集中'] = {
        cmd: '收集石头', count: 60, target: '大石头',
        startedAt: Date.now(), settleAt: Date.now() + 5640 * 1000, adminBatch: true,
      };
    });
    expect(rowMarkers(rows)['采集中']).toBeDefined();

    // 清掉采集中（认领保存）
    await mutate.mutate(501, async () => {
      await playerService.enqueueUserWrite(501, async () => {
        const pd = await playerService.getPlayerData(501);
        const markers = asJsonValue<Record<string, any>>(pd.player.markers, {});
        delete markers['采集中'];
        pd.player.markers = markers;
        await playerService.savePlayer(pd.player);
      });
    });

    // 结算链后半段：重读快照 + 写熟练度（对齐 applySettleGatherResource L2540-2544 写法）
    await mutate.mutate(501, async () => {
      const fresh = (await playerService.getPlayerData(501)).player;
      const proficiencyMarkers = asJsonValue<Record<string, any>>(fresh.markers, {});
      proficiencyMarkers['采集熟练度'] = Number(proficiencyMarkers['采集熟练度'] ?? 0) + 60;
      fresh.markers = proficiencyMarkers;
      await playerService.savePlayer(fresh);
    });

    const markers = rowMarkers(rows);
    // 关键断言：重读写回不得把已删除的「采集中」带回来（否则前端读条永远不消失）
    expect(markers['采集中']).toBeUndefined();
    expect(markers['采集熟练度']).toBe(60);
  });
});

describe('「⚡完成」结算后复核：清理无任务行的残留采集标记', () => {
  function makeAdminFixture(tasks: any[]) {
    const player: any = {
      userId: 501,
      markers: { 采集中: { cmd: '收集木头', target: '巨树', settleAt: Date.now() + 4620_000 } },
      markers2: [{ 名称: '采集', 有效期至: Date.now() + 4620_000 }],
    };
    const support: any = {
      mutatePlayer: jest.fn(async (_uid: number, fn: any) => fn({ player })),
    };
    const prisma: any = {
      user: { findUnique: jest.fn(async () => ({ id: 501, role: 'SUPER_ADMIN' })) },
      delayedTask: { findMany: jest.fn(async () => tasks) },
    };
    const delayedTaskService: any = { completeNowForUser: jest.fn(async () => 0) };
    const svc = new AdminCommandService(support, prisma, {} as any, delayedTaskService);
    (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    return { svc, player, support };
  }

  it('无 gather 任务行 + 有残留「采集中」→ 复核补删（含 markers2 采集锁）', async () => {
    const { svc, player } = makeAdminFixture([]);
    const res = await svc.finishNowForUser(501);
    expect(res.ok).toBe(true);
    expect(player.markers['采集中']).toBeUndefined();
    expect((player.markers2 as any[]).some((m) => (m?.name ?? m?.名称) === '采集')).toBe(false);
  });

  it('仍有 gather 任务行（正在采集）→ 不动任何标记', async () => {
    const { svc, player } = makeAdminFixture([{ id: 1 }]);
    await svc.finishNowForUser(501);
    expect(player.markers['采集中']).toBeDefined();
    expect((player.markers2 as any[]).some((m) => (m?.name ?? m?.名称) === '采集')).toBe(true);
  });
});
