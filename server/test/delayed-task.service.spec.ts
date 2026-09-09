/**
 * DelayedTaskService（持久化延时任务）自检：
 * - schedule 同 (type,userId,dedupeKey) 先删后插（重排即覆盖）
 * - tick 认领即删行：到期任务恰好分发一次；未到期不分发
 * - 无 handler 的类型暂不认领（等业务注册），不丢任务
 * - handler 失败按 +30s 重试（带 attempts 计数），耗尽后丢弃
 * - GameService.recoverOrphanDelayedMarkers 启动迁移：把上一代实现遗留在
 *   markers/markers2 里的「采集中/移动中/救援」状态补建成任务行
 */

import { DelayedTaskService } from '../src/modules/game/delayed-task.service';
import { GameService } from '../src/modules/game/game.service';
import { parseJson } from './parse-json.util';

function makeDelayedTaskPrisma() {
  const rows: any[] = [];
  let nextId = 1;
  return {
    rows,
    findMany: jest.fn(async ({ where, take }: any) => {
      // 两种形态：tick 到期扫描 {runAt: {lte}}；completeNowForUser 待完成扫描 {userId, runAt: {gt}}
      const match = (r: any) => {
        if (where.id !== undefined) return false;
        if (where.userId !== undefined && r.userId !== where.userId) return false;
        if (where.runAt?.lte && r.runAt.getTime() > where.runAt.lte.getTime()) return false;
        if (where.runAt?.gt && r.runAt.getTime() <= where.runAt.gt.getTime()) return false;
        return true;
      };
      return rows.filter(match).sort((a, b) => a.runAt.getTime() - b.runAt.getTime()).slice(0, take ?? 30);
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const r of rows) {
        if (where.id?.in?.includes(r.id)) {
          r.runAt = new Date(data.runAt);
          count += 1;
        }
      }
      return { count };
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      // 两种形态：认领 {id, runAt<=lte}；排程覆盖 {type, userId, dedupeKey}
      const match = (r: any) => {
        if (where.id !== undefined) {
          if (r.id !== where.id) return false;
          if (where.runAt && r.runAt.getTime() > where.runAt.lte.getTime()) return false;
          return true;
        }
        if (where.type !== undefined && r.type !== where.type) return false;
        if (where.userId !== undefined && r.userId !== where.userId) return false;
        if (where.dedupeKey !== undefined && r.dedupeKey !== where.dedupeKey) return false;
        return true;
      };
      const idx = rows.findIndex(match);
      if (idx < 0) return { count: 0 };
      rows.splice(idx, 1);
      return { count: 1 };
    }),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: nextId++, createdAt: new Date(), ...data, runAt: new Date(data.runAt) };
      rows.push(row);
      return row;
    }),
  };
}

function makeService(prisma: any) {
  return new DelayedTaskService({ delayedTask: prisma } as any);
}

describe('DelayedTaskService：持久化延时任务', () => {
  it('同 (type,userId) 重复排程只保留一条（重排即覆盖）', async () => {
    const db = makeDelayedTaskPrisma();
    const service = makeService(db);
    await service.schedule({ type: 'gather', userId: 7, runAt: Date.now() + 10_000 });
    await service.schedule({ type: 'gather', userId: 7, runAt: Date.now() + 20_000 });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].runAt.getTime()).toBeGreaterThan(Date.now() + 15_000);
  });

  it('不同 userId / 不同类型互不覆盖；dedupeKey 参与去重', async () => {
    const db = makeDelayedTaskPrisma();
    const service = makeService(db);
    await service.schedule({ type: 'gather', userId: 7, runAt: Date.now() + 10_000 });
    await service.schedule({ type: 'gather', userId: 8, runAt: Date.now() + 10_000 });
    await service.schedule({ type: 'rescue', userId: 7, dedupeKey: 'tok-a', runAt: Date.now() + 10_000 });
    await service.schedule({ type: 'rescue', userId: 7, dedupeKey: 'tok-b', runAt: Date.now() + 10_000 });
    expect(db.rows).toHaveLength(4);
  });

  it('到期任务恰好分发一次；未到期不分发', async () => {
    const db = makeDelayedTaskPrisma();
    const service = makeService(db);
    const handled: any[] = [];
    service.registerHandler('gather', async (task) => { handled.push(task); });
    await service.schedule({ type: 'gather', userId: 7, runAt: Date.now() + 10_000 });

    // 未到期：不分发
    expect(await service.tick()).toBe(0);
    expect(handled).toHaveLength(0);

    // 到期：分发一次
    db.rows[0].runAt = new Date(Date.now() - 1000);
    expect(await service.tick()).toBe(1);
    expect(handled).toHaveLength(1);
    expect(handled[0].userId).toBe(7);

    // 认领即删行：重复 tick 不重复分发
    expect(await service.tick()).toBe(0);
    expect(handled).toHaveLength(1);
  });

  it('无 handler 的类型暂不认领，任务行保留待注册后再分发', async () => {
    const db = makeDelayedTaskPrisma();
    const service = makeService(db);
    await service.schedule({ type: 'move', userId: 7, runAt: Date.now() - 1000, payload: { targetMapId: 3 } });

    expect(await service.tick()).toBe(0);
    expect(db.rows).toHaveLength(1); // 任务未丢

    const handled: any[] = [];
    service.registerHandler('move', async (task) => { handled.push(task); });
    expect(await service.tick()).toBe(1);
    expect(handled[0].payload).toEqual({ targetMapId: 3 });
    expect(db.rows).toHaveLength(0);
  });

  it('handler 失败按 +30s 重排并带 attempts 计数，耗尽后丢弃', async () => {
    const db = makeDelayedTaskPrisma();
    const service = makeService(db);
    service.registerHandler('reload', async () => { throw new Error('boom'); });

    await service.schedule({ type: 'reload', userId: 7, runAt: Date.now() - 1000, payload: { mode: 'plana' } });
    await service.tick();
    // 第一次失败 → 重排 +30s，attempts=1
    expect(db.rows).toHaveLength(1);
    expect(parseJson(db.rows[0].payload, {}).attempts).toBe(1);
    expect(db.rows[0].runAt.getTime()).toBeGreaterThan(Date.now() + 20_000);

    // 重试仍失败直至耗尽（attempts=1→2→3 丢弃）
    db.rows[0].runAt = new Date(Date.now() - 1000);
    await service.tick();
    db.rows[0].runAt = new Date(Date.now() - 1000);
    await service.tick();
    expect(db.rows).toHaveLength(0);
  });

  // ===== 超管特权「立即完成」：只提前 runAt，结算语义全由 handler 链路承担 =====

  it('completeNowForUser：未到期任务被提前并立即分发恰好一次', async () => {
    const db = makeDelayedTaskPrisma();
    const service = makeService(db);
    const handled: any[] = [];
    service.registerHandler('gather', async (task) => { handled.push(task); });
    await service.schedule({ type: 'gather', userId: 7, runAt: Date.now() + 600_000 });

    expect(await service.completeNowForUser(7)).toBe(1);
    expect(handled).toHaveLength(1);
    expect(handled[0].userId).toBe(7);
    expect(db.rows).toHaveLength(0); // 认领即删行
  });

  it('completeNowForUser：无 pending 任务返回 0；只作用于目标玩家自己', async () => {
    const db = makeDelayedTaskPrisma();
    const service = makeService(db);
    service.registerHandler('gather', async () => undefined);
    await service.schedule({ type: 'gather', userId: 8, runAt: Date.now() + 600_000 });

    expect(await service.completeNowForUser(7)).toBe(0);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].userId).toBe(8); // 别人的任务未被动过
    expect(db.rows[0].runAt.getTime()).toBeGreaterThan(Date.now() + 500_000);
  });

  it('completeNowForUser：地图级任务（userId=null）不在玩家特权范围内', async () => {
    const db = makeDelayedTaskPrisma();
    const service = makeService(db);
    await service.schedule({ type: 'dungeonClose', userId: null, dedupeKey: '副本组', runAt: Date.now() + 600_000, payload: { group: '副本组' } });

    expect(await service.completeNowForUser(7)).toBe(0);
    expect(db.rows).toHaveLength(1);
  });
});

describe('GameService.recoverOrphanDelayedMarkers：启动迁移', () => {
  function makeGameFixture(playerRow: any) {
    const scheduled: any[] = [];
    const delayedTaskService = {
      schedule: jest.fn(async (input: any) => { scheduled.push(input); }),
    };
    const service: any = Object.create(GameService.prototype);
    Object.assign(service, {
      prisma: {
        player: { findMany: jest.fn(async () => [playerRow]) },
      },
      playerService: {
        safeJsonParse: (value: any, fallback: any) => {
          if (value === null || value === undefined) return fallback;
          if (typeof value !== 'string') return value;
          try {
            const parsed = JSON.parse(value);
            return parsed === null ? fallback : parsed;
          } catch {
            return fallback;
          }
        },
      },
      delayedTaskService,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    return { service, scheduled, delayedTaskService };
  }

  it('把遗留的「采集中」「移动中」「救援」标记补建成对应任务行', async () => {
    const playerRow = {
      userId: 9,
      markers: JSON.stringify({
        采集中: { target: '老树', cmd: '收集木头', settleAt: Date.now() + 5_000 },
        移动中: JSON.stringify({ targetName: '森林', targetMapId: 3, arriveAt: Date.now() + 8_000 }),
      }),
      markers2: JSON.stringify([
        { name: '复活', rescueType: 'self', expireAt: 900, token: 'tok-9' },
      ]),
    };
    const { service, scheduled } = makeGameFixture(playerRow);
    await (service as any).recoverOrphanDelayedMarkers();

    expect(scheduled).toEqual([
      expect.objectContaining({ type: 'gather', userId: 9 }),
      expect.objectContaining({
        type: 'move',
        userId: 9,
        payload: { targetMapId: 3, targetName: '森林' },
      }),
      expect.objectContaining({ type: 'rescue', userId: 9, dedupeKey: 'tok-9' }),
    ]);
  });

  it('已无进行中状态的玩家不产生任务行', async () => {
    const { service, scheduled } = makeGameFixture({
      userId: 9,
      markers: JSON.stringify({ 活力2: 100 }),
      markers2: '[]',
    });
    await (service as any).recoverOrphanDelayedMarkers();
    expect(scheduled).toHaveLength(0);
  });
});

describe('GameService.handleAdminFinishNow：超管「立即完成」指令', () => {
  function makeFinishFixture(role: string, pendingCount: number) {
    const completeNowForUser = jest.fn(async () => pendingCount);
    const service: any = Object.create(GameService.prototype);
    Object.assign(service, {
      prisma: { user: { findUnique: jest.fn(async () => ({ id: 7, role })) } },
      delayedTaskService: { completeNowForUser },
    });
    return { service, completeNowForUser };
  }

  it('SUPER_ADMIN 触发 completeNowForUser 并回执完成数量', async () => {
    const { service, completeNowForUser } = makeFinishFixture('SUPER_ADMIN', 2);
    const text = await (service as any).handleAdminFinishNow(7);
    expect(completeNowForUser).toHaveBeenCalledWith(7);
    expect(text).toContain('2 个进行中的延时操作已立即完成');
  });

  it('finishNowForUser 结构化返回：成功/权限不足/无任务三态', async () => {
    const ok = makeFinishFixture('SUPER_ADMIN', 2);
    const okRes = await (ok.service as any).finishNowForUser(7);
    expect(okRes).toEqual({ ok: true, completed: 2, message: expect.stringContaining('已立即完成') });

    const denied = makeFinishFixture('USER', 1);
    const deniedRes = await (denied.service as any).finishNowForUser(7);
    expect(deniedRes).toEqual({ ok: false, completed: 0, message: expect.stringContaining('权限不足') });
    expect(denied.completeNowForUser).not.toHaveBeenCalled();

    const empty = makeFinishFixture('SUPER_ADMIN', 0);
    const emptyRes = await (empty.service as any).finishNowForUser(7);
    expect(emptyRes).toEqual({ ok: true, completed: 0, message: expect.stringContaining('没有进行中的延时操作') });
  });

  it('ADMIN 同样可用', async () => {
    const { service, completeNowForUser } = makeFinishFixture('ADMIN', 1);
    expect(await (service as any).handleAdminFinishNow(7)).toContain('已立即完成');
    expect(completeNowForUser).toHaveBeenCalledTimes(1);
  });

  it('普通 USER 权限不足，不触达延时任务服务', async () => {
    const { service, completeNowForUser } = makeFinishFixture('USER', 1);
    const text = await (service as any).handleAdminFinishNow(7);
    expect(text).toContain('权限不足');
    expect(completeNowForUser).not.toHaveBeenCalled();
  });

  it('无进行中任务时给明确提示', async () => {
    const { service } = makeFinishFixture('SUPER_ADMIN', 0);
    expect(await (service as any).handleAdminFinishNow(7)).toContain('当前没有进行中的延时操作');
  });
});
