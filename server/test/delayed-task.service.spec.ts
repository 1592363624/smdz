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

function makeDelayedTaskPrisma() {
  const rows: any[] = [];
  let nextId = 1;
  return {
    rows,
    findMany: jest.fn(async ({ where, take }: any) => rows
      .filter((r) => r.runAt.getTime() <= where.runAt.lte.getTime())
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .slice(0, take ?? 30)),
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
    expect(JSON.parse(db.rows[0].payload).attempts).toBe(1);
    expect(db.rows[0].runAt.getTime()).toBeGreaterThan(Date.now() + 20_000);

    // 重试仍失败直至耗尽（attempts=1→2→3 丢弃）
    db.rows[0].runAt = new Date(Date.now() - 1000);
    await service.tick();
    db.rows[0].runAt = new Date(Date.now() - 1000);
    await service.tick();
    expect(db.rows).toHaveLength(0);
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
