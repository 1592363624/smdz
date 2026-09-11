/**
 * 写模型止血回归：统一聚合键 / 逃逸回调防护 / 乐观锁 CAS
 *
 * 覆盖三类「旧快照覆盖 / 幽灵邮箱」事故根因：
 * 1. savePlayer 收到仅有行 id 的局部对象时，必须反查 userId 进邮箱，
 *    绝不允许以行 id 作为 Actor key（幽灵邮箱 + 幽灵建档外键冲突）。
 * 2. ALS 随定时器逃逸出的回调（run 已结束但 ALS key 残留）不得走邮箱内
 *    快捷分支，必须排队进邮箱基于活态落库。
 * 3. persistPlayer 乐观锁：version 冲突必须显式暴露（log 记录+强制写 /
 *    strict 抛错拒绝），不再静默覆盖。
 */

import { PlayerService } from '../src/modules/game/player.service';
import { ActorRuntime } from '../src/modules/actor/actor-runtime';
import { StaticDataService } from '../src/modules/game/static-data.service';

function makePrisma(rows: any[]) {
  const prisma: any = {
    player: {
      findUnique: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) =>
          (where?.userId !== undefined && r.userId === where.userId)
          || (where?.id !== undefined && r.id === where.id));
        return row ? { ...row } : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { version: 0, ...data };
        rows.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        // 真实 Prisma 支持 id/userId 两种 unique 定位（savePlayer 现按 userId 归属写库）
        const row = rows.find((r) =>
          (where?.id !== undefined && r.id === where.id)
          || (where?.userId !== undefined && r.userId === where.userId));
        if (!row) {
          const err: any = new Error('not found');
          err.code = 'P2025';
          throw err;
        }
        Object.assign(row, data);
        row.version = Number(row.version ?? 0) + 1; // 模拟 $use 中间件自增
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where?.id
          && Number(r.version ?? 0) === Number(where?.version));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    currencyLog: { create: jest.fn(async () => undefined) },
  };
  return prisma;
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
  return { prisma, runtime, playerService };
}

function makeRow(overrides: any = {}): any {
  return {
    id: 900,
    userId: 101,
    name: 'tester',
    level: 1,
    exp: 0,
    upgradeExp: 10,
    mapId: 1,
    hp: 100,
    maxHp: 100,
    version: 0,
    backpack: [],
    equipment: [],
    weapons: [],
    markers: {},
    markers2: [],
    titles: [],
    tasks: [],
    ...overrides,
  };
}

describe('写模型止血回归：统一聚合键 / 逃逸回调防护 / 乐观锁', () => {
  let rows: any[];
  let prisma: any;
  let playerService: PlayerService;

  // CAS 模式是类静态字段（进程级）：用例改前保存原值、改后还原原值（而非硬编码
  // 'log'）——默认值翻转（RVW04 P1-3：log→strict）后不会把旧默认值泄漏给同进程
  // 的其它套件。
  let casModeBefore: 'off' | 'log' | 'strict';
  beforeEach(() => {
    casModeBefore = (PlayerService as any).CAS_MODE;
    rows = [makeRow()];
    ({ prisma, playerService } = makeServices(rows));
  });

  afterEach(() => {
    (PlayerService as any).CAS_MODE = casModeBefore;
  });

  it('仅有行 id 的局部写：反查 userId 进邮箱落库，绝不以行 id 建档', async () => {
    await playerService.savePlayer({ id: 900, markers: { 医疗箱: 1 } });

    // 落库走的是 CAS（updateMany），且聚合在真实 userId 对应的邮箱内完成
    expect(prisma.player.updateMany).toHaveBeenCalled();
    const arg = prisma.player.updateMany.mock.calls[0][0];
    expect(arg.where.id).toBe(900);
    expect(arg.where.version).toBe(0);
    // 幽灵建档必须为 0：行 id 不是 userId，不允许 player.create({userId: 行id})
    expect(prisma.player.create).not.toHaveBeenCalled();
    // 改动落到真实行
    expect(rows[0].markers['医疗箱']).toBe(1);
  });

  it('行 id 无法解析（行不存在）：丢弃写库，不触发幽灵建档', async () => {
    await playerService.savePlayer({ id: 999999, markers: { x: 1 } });

    expect(prisma.player.updateMany).not.toHaveBeenCalled();
    expect(prisma.player.update).not.toHaveBeenCalled();
    expect(prisma.player.create).not.toHaveBeenCalled();
  });

  it('ALS 逃逸回调（run 已结束）：不得走邮箱内快捷分支，须排队按活态落库', async () => {
    // 默认值已翻转 strict（RVW04 P1-3）：本用例构造的逃逸回调携带旧快照
    // （version=0），验证的是「逃逸回调排队进邮箱落库」机制本身（与 CAS 模式
    // 解耦），须显式声明 log 让旧快照字段照常合并，不随默认值漂移。
    (PlayerService as any).CAS_MODE = 'log';
    // 先让活态版本推进到 1（一次正常写）
    await playerService.savePlayer({ userId: 101, hp: 88 });
    expect(rows[0].version).toBe(1);

    // 在 run 内注册一个 setTimeout 逃逸回调（ALS key 残留、run 已结束）
    let released: () => void = () => undefined;
    const gate = new Promise<void>((r) => { released = r; });
    void (playerService as any).actorRuntime.run('player', 101, async () => {
      setTimeout(async () => {
        try {
          // 逃逸回调携带旧快照（version=0 < 活态 1）
          await playerService.savePlayer({ userId: 101, version: 0, hp: 1, markers: { 逃逸: 1 } });
        } finally {
          released();
        }
      }, 5);
    });
    await gate;

    // 旧路径会直接 Object.assign 活态并 markDirty（静默、不落库）；
    // 新路径必须真正进入邮箱并落库（updateMany 被再次调用，version 前进）
    expect(prisma.player.updateMany.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].hp).toBe(1);
    expect(rows[0].markers['逃逸']).toBe(1);
    // 旧快照检测必须留痕
    expect((playerService as any).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('拦截到旧快照整包写入'),
    );
  });

  it('log 模式：旧快照整包写记录冲突后照常合并（行为兼容）', async () => {
    // 默认值已翻转 strict（RVW04 P1-3）：本用例锁定 log 模式行为，显式声明。
    (PlayerService as any).CAS_MODE = 'log';
    rows[0].version = 3; // 库内/活态版本已推进
    await playerService.savePlayer({ userId: 101, version: 1, hp: 77 });

    expect((playerService as any).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('拦截到旧快照整包写入'),
    );
    expect(rows[0].hp).toBe(77); // log 模式不丢字段
    expect(prisma.player.update).not.toHaveBeenCalled(); // CAS 命中（version=3 快照与库一致）
  });

  it('log 模式 CAS 冲突：记录堆栈后强制写库，业务不中断', async () => {
    // 显式设 log：本用例验证 log 模式语义，不依赖历史默认值
    (PlayerService as any).CAS_MODE = 'log';
    rows[0].version = 5; // 模拟其他写者已推进版本
    await (playerService as any).persistPlayer({ id: 900, userId: 101, version: 3, hp: 66 });

    expect((playerService as any).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('玩家乐观锁冲突'),
    );
    expect(prisma.player.update).toHaveBeenCalled(); // 强制写
    expect(rows[0].hp).toBe(66);
    expect(rows[0].version).toBe(6); // 以库内最新版本推进
  });

  it('strict 模式 CAS 冲突：抛错拒绝写入，绝不用旧快照覆盖', async () => {
    (PlayerService as any).CAS_MODE = 'strict';
    rows[0].version = 5;
    await expect(
      (playerService as any).persistPlayer({ id: 900, userId: 101, version: 3, hp: 66 }),
    ).rejects.toThrow('并发冲突');

    expect(prisma.player.update).not.toHaveBeenCalled();
    expect(rows[0].hp).toBe(100); // 库内值未被旧快照覆盖
  });

  // ========== 「读一次快照 → 连写多次」的自推进误判（2026-09-10 实测根因） ==========
  // 旧行为：每次成功写入都会推进活态 version，而调用方快照的 version 停在读取时刻，
  // 于是第 2 次起被判成旧快照、strict 下静默丢弃。实测形态为 handleDodge 连写三次
  // （成就「闪避」→ 成就「闪避熟练度」→ buffs+markers2），后两次丢失 → 冷却没写进去。
  it('同一份快照连续写多次：每次改动都必须落库，不得被判成旧快照', async () => {
    (PlayerService as any).CAS_MODE = 'strict';
    const snapshot: any = { userId: 101, version: 0, markers: {}, buffs: [], markers2: [] };

    snapshot.markers = { 闪避: 1 };
    await playerService.savePlayer(snapshot);

    snapshot.markers = { 闪避: 1, 闪避熟练度: 1 };
    await playerService.savePlayer(snapshot);

    snapshot.buffs = [{ name: '闪避', expireAt: 9999 }];
    snapshot.markers2 = [{ name: '闪避冷却', expireAt: 9999 }];
    await playerService.savePlayer(snapshot);

    expect(rows[0].markers['闪避熟练度']).toBe(1);
    expect(rows[0].buffs).toEqual([{ name: '闪避', expireAt: 9999 }]);
    expect(rows[0].markers2).toEqual([{ name: '闪避冷却', expireAt: 9999 }]);
    expect(rows[0].version).toBe(3); // 三次写入各自推进一次
    expect((playerService as any).logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining('拦截到旧快照整包写入'),
    );
    // 可观测性计数：正常收口路径必须零拦截
    const diag = playerService.getWriteModelDiagnostics();
    expect(diag.staleWriteBlocked).toBe(0);
    expect(diag.staleWriteMerged).toBe(0);
    expect(diag.casMode).toBe('strict');
  });

  it('真正陈旧的快照（从未被接受过）仍被 strict 拦截，本次修复不放宽该防线', async () => {
    (PlayerService as any).CAS_MODE = 'strict';
    rows[0].version = 5; // 其它写者已推进：本方快照 version=1 从未参与过写入

    await playerService.savePlayer({ userId: 101, version: 1, hp: 77 });

    expect((playerService as any).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('拦截到旧快照整包写入'),
    );
    expect(rows[0].hp).toBe(100); // 活态未被旧快照覆盖
    // 可观测性计数：拦截必须留痕，并记下调用方栈首帧（线上定位用）
    const diag = playerService.getWriteModelDiagnostics();
    expect(diag.staleWriteBlocked).toBe(1);
    expect(diag.staleWriteAt).toEqual(expect.any(Number));
    expect(diag.staleWriteCaller.length).toBeGreaterThan(0);
  });
});
