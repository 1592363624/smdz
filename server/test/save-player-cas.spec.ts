import { PlayerService } from '../src/modules/game/player.service';
import { StaticDataService } from '../src/modules/game/static-data.service';

/**
 * 纯 Actor 单写者回归：所有同用户写路径都已串行化（PlayerService 的 per-user
 * 串行邮箱，见 enqueueUserWrite），同用户不存在并发写，故 savePlayer 不再做
 * CAS 冲突判定、不再抛出「玩家数据并发冲突，请重试」。version 仅由 Prisma $use
 * 中间件自增，用于审计/增量重放。
 *
 * 旧快照覆盖类事故在 API 层被根除，靠的是「串行邮箱」而非 CAS：同一用户的写
 * 操作被串到前一个之后顺序执行（单进程内天然单线程、无竞态），后写者永远基于
 * 前写者的最新快照，不会用旧快照整包覆盖。
 */

/** 模拟真实 Prisma：(id) 定位 + $use 中间件自增 version */
function makePrismaWithCas(rows: any[]) {
  const prisma: any = {
    player: {
      findUnique: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) => r.userId === where?.userId);
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
    },
  };
  return prisma;
}

function makeService(prisma: any): PlayerService {
  const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  const service = new PlayerService(
    prisma,
    { getEquipmentByName: () => undefined } as unknown as StaticDataService,
    {} as any,
  );
  (service as any).logger = logger;
  return service;
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

describe('savePlayer 单写者串行化（纯 Actor，无 CAS）', () => {
  it('版本匹配时正常保存并推进版本号（中间件自增）', async () => {
    const row = makeRow();
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    const snapA = await service.getPlayerData(42);
    snapA.player.markers = JSON.stringify({ 活跃度: 5 });
    await service.savePlayer(snapA.player);

    expect(JSON.parse(row.markers)).toEqual({ 活跃度: 5 });
    expect(row.version).toBe(1);
  });

  it('同一快照连续保存两次都成功（内存版本回写生效）', async () => {
    const row = makeRow();
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    const snap = await service.getPlayerData(42);
    // 第一次保存：货币从背包提取到列（100→1980）
    snap.player.backpack = JSON.stringify([{ name: '钻石', type: '资源', quantity: 1980 }]);
    await service.savePlayer(snap.player);
    // 第二次保存：同一快照继续改（列值已回写内存，偏差判定以新列值为准）
    snap.player.backpack = JSON.stringify([{ name: '钻石', type: '资源', quantity: 1960 }]);
    await service.savePlayer(snap.player);

    expect(row.version).toBe(2);
    // P1 货币列化：背包中的货币落库时提取到列，JSON 中不再保留条目
    expect(row.diamonds).toBe(1960);
    expect(row.backpack).toBe('[]');
  });

  it('同一用户并发写经串行邮箱不丢失更新（不再靠 CAS 报错）', async () => {
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
    expect(JSON.parse(final.player.backpack)).toEqual([{ name: '木头', type: '资源', quantity: 5 }]);
    // 串行邮箱 + 重读快照：后写者基于前写者最新快照，两者改动都保留（无丢失更新）。
    // 注意：getPlayerData 读取时会补齐 活力2/使用活力 默认标记，故 player.markers 是
    // 已归一化的 JSON 字符串，需解析后做子集匹配，断言「活跃度」被正确写入而非被覆盖。
    expect(JSON.parse(final.player.markers)).toMatchObject({ 活跃度: 9 });
  });

  it('部分更新（无 version 字段）按主键落库，无 CAS', async () => {
    const row = makeRow({ version: 3 });
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    await service.savePlayer({ id: 1, markers: JSON.stringify({ 清理: true }) } as any);

    expect(JSON.parse(row.markers)).toEqual({ 清理: true });
    // $use 中央自增在生产环境会推进 version；本测试桩模拟了中间件，故断言 +1。
    expect(row.version).toBe(4);
  });

  it('savePlayer 不再因版本过期抛「并发冲突」（CAS 已移除，串行化兜底）', async () => {
    const row = makeRow();
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    // 模拟「绕过邮箱的裸写」：直接拿旧快照写回，不做串行化
    const stale = await service.getPlayerData(42);
    const fresh = await service.getPlayerData(42);
    fresh.player.hp = 88;
    await service.savePlayer(fresh.player); // 别人先写

    // 旧快照再写：纯 Actor 下应安静覆盖、不再抛错（旧快照在真实场景由串行化保证不会发生）
    await expect(service.savePlayer(stale.player)).resolves.toBeUndefined();
    // 串行化才是防丢失更新的真正手段；此处仅验证契约：无 CAS 报错
    const retry = await service.getPlayerData(42);
    expect(retry.player.hp).toBe(88);
  });
});
