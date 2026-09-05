import { PlayerService } from '../src/modules/game/player.service';
import { StaticDataService } from '../src/modules/game/static-data.service';

/**
 * 玩家落库的两道防线回归：串行邮箱（主）+ 乐观锁 CAS（兜底）
 *
 * 1. **串行邮箱是主防线**：同一玩家的所有写操作被串到 per-user Promise 链上
 *    （见 PlayerService.enqueueUserWrite），单进程内天然单写者、无竞态，后写者
 *    永远基于前写者的最新活态，不会用旧快照整包覆盖。
 * 2. **乐观锁 CAS 是最后防线**：即便某条写路径绕过邮箱（旁路裸写、跨进程、未来
 *    的分布式邮箱），落库时按「读取快照时的 version」条件更新，冲突显式暴露为
 *    错误日志（log 模式，默认）或异常（strict 模式），把静默覆盖变成可观测事件。
 *
 * version 由 Prisma $use 中间件中央自增（prisma.service.ts）；调用方已显式携带
 * version 时中间件不重复注入，保证 CAS 只推进一次。
 *
 * 模式由环境变量 PLAYER_WRITE_CAS 控制：off / log（默认）/ strict。
 */

/** 模拟真实 Prisma：(id) 定位 + $use 中间件自增 version */
function makePrismaWithCas(rows: any[]) {
  const prisma: any = {
    player: {
      findUnique: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) =>
          (where?.userId !== undefined && r.userId === where.userId)
          || (where?.id !== undefined && r.id === where.id));
        return row ? { ...row } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const rowById = rows.find((r) => r.id === where?.id);
        if (!rowById) {
          const err: any = new Error('record not found');
          err.code = 'P2025';
          throw err;
        }
        // 模拟 $use 中间件：version 未显式携带时自增（与 prisma.service.ts 一致）
        if (data.version === undefined) data.version = (rowById.version ?? 0) + 1;
        Object.assign(rowById, data);
        return rowById;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) =>
          r.id === where?.id && Number(r.version ?? 0) === Number(where?.version));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
  return prisma;
}

function makeService(prisma: any) {
  const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  const service = new PlayerService(
    prisma,
    { getEquipmentByName: () => undefined } as unknown as StaticDataService,
    {} as any,
  );
  (service as any).logger = logger;
  return service;
}

/**
 * 容错读取落库值：Json 列已迁移为原生 JSON，落库的是真实对象/数组；
 * 历史字符串列仍是文本。断言统一走这里，不假设某一种存储形态。
 */
function readJson<T>(value: any, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value as T;
  if (value.trim() === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    return (parsed === null ? fallback : parsed) as T;
  } catch {
    return fallback;
  }
}

function makeRow(overrides: any = {}) {
  return {
    id: 1,
    userId: 42,
    name: '测试玩家',
    mapId: 7,
    version: 0,
    markers: '{}',
    backpack: JSON.stringify([
      { name: '钻石', type: '资源', quantity: 2000 },
      { name: '召唤券', type: '资源', count: 20 },
    ]),
    ...overrides,
  };
}

describe('savePlayer 落库：串行邮箱（主）+ 乐观锁 CAS（兜底）', () => {
  afterEach(() => {
    // CAS 模式是类静态字段（进程级），用例改过必须还原，避免污染同进程其它套件
    (PlayerService as any).CAS_MODE = 'log';
  });

  it('版本匹配时正常保存并推进版本号', async () => {
    const row = makeRow();
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    const snapA = await service.getPlayerData(42);
    snapA.player.markers = JSON.stringify({ 活跃度: 5 });
    await service.savePlayer(snapA.player);

    expect(readJson(row.markers, {})).toEqual({ 活跃度: 5 });
    expect(row.version).toBe(1);
    // CAS 命中：走的是 updateMany，而非无条件 update
    expect(prisma.player.update).not.toHaveBeenCalled();
  });

  it('同一快照连续保存两次都成功（内存版本回写生效）', async () => {
    // 行必须携带货币列：货币提取只信任经 materializeCurrencies 物化的对象
    // （_currencyMirror 存在）——无列的手工快照按「剥离条目+保留列原值」处理，
    // 这是「陈旧条目复活成权威余额」事故（正式库实锤）后的收紧不变量。
    const row = makeRow({ diamonds: 2000 });
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    const snap = await service.getPlayerData(42);
    // 第一次保存：货币从背包提取到列
    snap.player.backpack = JSON.stringify([{ name: '钻石', type: '资源', quantity: 1980 }]);
    await service.savePlayer(snap.player);
    // 第二次保存：同一快照继续改（列值已回写内存，偏差判定以新列值为准）
    snap.player.backpack = JSON.stringify([{ name: '钻石', type: '资源', quantity: 1960 }]);
    await service.savePlayer(snap.player);

    expect(row.version).toBe(2);
    // 货币列化：背包中的货币落库时提取到独立列，Json 中不再保留条目
    expect(row.diamonds).toBe(1960);
    expect(readJson<any[]>(row.backpack, [])).toEqual([]);
  });

  it('同一用户并发写经串行邮箱不丢失更新', async () => {
    const row = makeRow();
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    // 模拟两条并发请求（如「指令」+「后台结算」）同时进入同一用户邮箱
    const [r1, r2] = await Promise.all([
      service.enqueueUserWrite(42, async () => {
        const d = await service.getPlayerData(42);
        d.player.backpack = JSON.stringify([{ name: '木头', type: '资源', quantity: 5 }]);
        await service.savePlayer(d.player);
        return 'A';
      }),
      service.enqueueUserWrite(42, async () => {
        const d = await service.getPlayerData(42);
        d.player.markers = JSON.stringify({ 活跃度: 9 });
        await service.savePlayer(d.player);
        return 'B';
      }),
    ]);
    expect(r1).toBe('A');
    expect(r2).toBe('B');

    // 串行执行：后写者基于前写者的最新快照，两者改动都保留（无丢失更新）
    const final = await service.getPlayerData(42);
    expect(readJson<any[]>(final.player.backpack, [])).toEqual([
      { name: '木头', type: '资源', quantity: 5 },
    ]);
    // 串行邮箱 + 重读快照：两者改动都保留（无丢失更新）。
    // 注意：getPlayerData 读取时会补齐 活力2/使用活力 默认标记，故 markers 是已
    // 归一化的结构，需做子集匹配，断言「活跃度」被正确写入而非被覆盖。
    expect(readJson<Record<string, any>>(final.player.markers, {})).toMatchObject({ 活跃度: 9 });
  });

  it('绕过邮箱的裸写撞上版本推进：log 模式记录冲突后强制写库，业务不中断', async () => {
    const row = makeRow({ version: 3 });
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    // 局部写对象不带 version → 快照版本按 0 参与 CAS，与库内 3 必然冲突
    await service.savePlayer({ id: 1, markers: JSON.stringify({ 清理: true }) } as any);

    expect(readJson<Record<string, any>>(row.markers, {})).toEqual({ 清理: true });
    // 冲突必须留痕（静默覆盖 → 显式可观测）
    expect((service as any).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('玩家乐观锁冲突'),
    );
    // log 模式：强制写，version 以库内最新为基准推进
    expect(prisma.player.update).toHaveBeenCalled();
    expect(row.version).toBe(4);
  });

  it('log 模式：旧快照写回不抛错（记录冲突后按库内最新版本强制写）', async () => {
    const row = makeRow();
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    const stale = await service.getPlayerData(42);
    const fresh = await service.getPlayerData(42);
    fresh.player.hp = 88;
    await service.savePlayer(fresh.player); // 别人先写，版本推进

    // 旧快照再写：log 模式不阻断业务
    await expect(service.savePlayer(stale.player)).resolves.toBeUndefined();
    expect((service as any).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('玩家乐观锁冲突'),
    );
  });

  it('strict 模式：旧快照写回直接抛错拒绝，绝不用旧快照覆盖', async () => {
    (PlayerService as any).CAS_MODE = 'strict';
    const row = makeRow();
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    const stale = await service.getPlayerData(42);
    const fresh = await service.getPlayerData(42);
    fresh.player.hp = 88;
    await service.savePlayer(fresh.player); // 别人先写，版本推进

    // 旧快照再写：strict 模式必须拒绝，而不是静默覆盖
    await expect(service.savePlayer(stale.player)).rejects.toThrow('并发冲突');
    expect(row.hp).toBe(88); // 库内值未被旧快照覆盖
  });
});
