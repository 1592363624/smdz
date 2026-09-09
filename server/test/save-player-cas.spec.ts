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
 *    错误日志（log 模式，运维回退）或异常（strict 模式，默认），把静默覆盖变成
 *    可观测事件。
 *
 * version 由 Prisma $use 中间件中央自增（prisma.service.ts）；调用方已显式携带
 * version 时中间件不重复注入，保证 CAS 只推进一次。
 *
 * 模式由环境变量 PLAYER_WRITE_CAS 控制：off / log / strict（默认，RVW04 P1-3）。
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
  // CAS 模式是类静态字段（进程级）：用例改前保存原值、改后还原原值（而非硬编码
  // 某个模式）——默认值翻转（RVW04 P1-3：log→strict）时不会把旧默认值泄漏给同
  // 进程的其它套件。
  let casModeBefore: 'off' | 'log' | 'strict';
  beforeEach(() => {
    casModeBefore = (PlayerService as any).CAS_MODE;
  });
  afterEach(() => {
    (PlayerService as any).CAS_MODE = casModeBefore;
  });

  it('默认 CAS 模式必须是 strict（RVW04 P1-3，锁定默认值防静默回退）', () => {
    // CAS_MODE 在类定义时一次性求值（import 时读 env）。测试进程未设置
    // PLAYER_WRITE_CAS 时，字段值即代码内 fallback——锁定它，防止默认值再次
    // 静默回退到 log（2026-09-09 回归实证：无此断言时翻转改动丢失仍全绿）。
    expect(process.env.PLAYER_WRITE_CAS).toBeUndefined();
    expect((PlayerService as any).CAS_MODE).toBe('strict');
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
    // 默认值已翻转 strict（RVW04 P1-3）：「同一快照不重读连续写两次」在 strict 下
    // 会被 merge 层正确拦截为旧快照写（第二次改动丢弃），与本用例验证的「货币列化
    // + 列值回写 + 偏差判定」语义无关——显式声明 log，不随默认值漂移。
    (PlayerService as any).CAS_MODE = 'log';
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

  it('绕过邮箱的裸写撞上版本推进：merge 层拦截留痕，业务不中断', async () => {
    // 默认值已翻转 strict（RVW04 P1-3）：本用例锁定 log 模式「拦截留痕后照常
    // 合并落库」的运维回退行为，须显式声明，不随默认值漂移。
    (PlayerService as any).CAS_MODE = 'log';
    const row = makeRow({ version: 3 });
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    // 局部写对象显式携带 version=0 → 与活态 version 必然冲突。
    // 2026-09-08 起 savePlayer 基于 Actor 活态合并，旧快照防线前移到
    // mergeIntoLiveState（比 CAS 更早、发生在污染活态之前）。
    await service.savePlayer({ id: 1, version: 0, markers: JSON.stringify({ 清理: true }) } as any);

    expect(readJson<Record<string, any>>(row.markers, {})).toEqual({ 清理: true });
    // 冲突必须留痕（静默覆盖 → 显式可观测）
    expect((service as any).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('拦截到旧快照整包写入'),
    );
    // log 模式：照常合并落库，version 以活态为准推进
    expect(row.version).toBe(4);
  });

  it('log 模式：旧快照写回不抛错（拦截留痕后按活态继续）', async () => {
    // 默认值已翻转 strict（RVW04 P1-3）：本用例锁定 log 模式行为，显式声明。
    (PlayerService as any).CAS_MODE = 'log';
    const row = makeRow();
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    const stale = await service.getPlayerData(42);
    const fresh = await service.getPlayerData(42);
    fresh.player.hp = 88;
    await service.savePlayer(fresh.player); // 别人先写，版本推进

    // 旧快照再写：log 模式不阻断业务，旧快照字段不覆盖活态
    await expect(service.savePlayer(stale.player)).resolves.toBeUndefined();
    expect((service as any).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('拦截到旧快照整包写入'),
    );
    expect(row.hp).toBe(88);
  });

  it('strict 模式：旧快照写回被丢弃，绝不用旧快照覆盖活态', async () => {
    (PlayerService as any).CAS_MODE = 'strict';
    const row = makeRow();
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    const stale = await service.getPlayerData(42);
    const fresh = await service.getPlayerData(42);
    fresh.player.hp = 88;
    await service.savePlayer(fresh.player); // 别人先写，版本推进

    // 旧快照再写：strict 模式丢弃合并（保护活态），不再抛错阻断——活态本身
    // 就是权威态，丢弃即保护；库内值不被旧快照覆盖。
    await expect(service.savePlayer(stale.player)).resolves.toBeUndefined();
    expect(row.hp).toBe(88); // 库内值未被旧快照覆盖
  });

  it('CAS 兜底仍可观测：绕过 savePlayer 的旁路快照直撞版本推进（log 模式强制写）', async () => {
    // 依赖 log 模式「冲突仍强制写」旧行为：显式声明，不随默认值（strict）漂移
    (PlayerService as any).CAS_MODE = 'log';
    // savePlayer 路径的冲突已在 merge 层拦截；persistPlayer 的 CAS 是给
    // 「未来绕过邮箱的写路径/跨进程写」留的最后防线，这里直击它本身。
    const row = makeRow({ version: 3, hp: 77 });
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    // 旁路写入者的快照停留在 version=0（读取后库内已被推进到 3）
    const stale = { ...row, version: 0, markers: JSON.stringify({ 旁路: true }) };
    await (service as any).persistPlayer(stale);

    expect((service as any).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('玩家乐观锁冲突'),
    );
    // log 模式：强制写，version 以库内最新为基准推进
    expect(row.version).toBe(4);
    expect(readJson<Record<string, any>>(row.markers, {})).toEqual({ 旁路: true });
  });
});
