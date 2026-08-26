import { PlayerService } from '../src/modules/game/player.service';
import { StaticDataService } from '../src/modules/game/static-data.service';

/**
 * P0 乐观锁回归：savePlayer 按「读快照时的 version」做条件更新（CAS）。
 *
 * 场景复现：路径 A 与路径 B 同时读取玩家（version=N），A 先写回，
 * B 随后用旧快照写回——修复前 B 会静默覆盖 A 的数据（兑换的召唤券蒸发）；
 * 修复后 B 的 CAS 匹配不到 (id, version=N) 抛 P2025，转换为显式并发冲突错误。
 */

/** 模拟真实 Prisma：(id, version) 复合唯一键，匹配失败抛 P2025 */
function makePrismaWithCas(rows: any[]) {
  const prisma: any = {
    player: {
      // 每次查询返回独立快照对象（对齐真实 Prisma 行为），避免测试桩里
      // 「两个快照共享引用」导致 CAS 永远通过的假阳性。
      findUnique: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) => r.userId === where?.userId);
        return row ? { ...row } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const cv = where?.id_version;
        if (!cv) {
          // 部分更新路径：按主键定位，直接落库
          const rowById = rows.find((r) => r.id === where?.id);
          if (!rowById) {
            const err0: any = new Error('record not found');
            err0.code = 'P2025';
            throw err0;
          }
          Object.assign(rowById, data);
          return rowById;
        }
        const row = rows.find((r) => r.id === cv.id);
        if (!row || row.version !== cv.version) {
          const err: any = new Error('An operation failed because it depends on one or more records that were required but was not found.');
          err.code = 'P2025';
          throw err;
        }
        Object.assign(row, data);
        return row;
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

describe('savePlayer 乐观锁（CAS）', () => {
  it('版本匹配时正常保存并推进版本号', async () => {
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
    snap.player.backpack = JSON.stringify([{ name: '钻石', type: '资源', quantity: 1980 }]);
    await service.savePlayer(snap.player);
    snap.player.backpack = JSON.stringify([{ name: '钻石', type: '资源', quantity: 1960 }]);
    await service.savePlayer(snap.player);

    expect(row.version).toBe(2);
    // P1 货币列化：背包中的货币落库时提取到列，JSON 中不再保留条目
    expect(row.diamonds).toBe(1960);
    expect(row.backpack).toBe('[]');
  });

  it('旧快照写回被拒绝且不改库（丢失更新的根因被兜住）', async () => {
    const row = makeRow();
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    // 路径 A 与 B 各自读快照（此刻 version=0）
    const snapA = await service.getPlayerData(42);
    const snapB = await service.getPlayerData(42);

    // A 兑换成功先落库
    snapA.player.backpack = JSON.stringify([
      { name: '钻石', type: '资源', quantity: 960 },
      { name: '召唤券', type: '资源', count: 72 },
    ]);
    await service.savePlayer(snapA.player);

    // B 是后台结算，拿着旧快照整包写回——必须被拒绝
    await expect(service.savePlayer(snapB.player)).rejects.toThrow('并发冲突');
    // 库里仍是 A 的结果（货币在列上）
    expect(row.diamonds).toBe(960);
    expect(row.tickets).toBe(72);
    expect(row.backpack).toBe('[]');
    expect(row.version).toBe(1);
  });

  it('部分更新（无 version 字段）不走 CAS，按原路径落库', async () => {
    const row = makeRow({ version: 3 });
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    await service.savePlayer({ id: 1, markers: JSON.stringify({ 清理: true }) } as any);

    expect(JSON.parse(row.markers)).toEqual({ 清理: true });
    // $use 中央自增在生产环境会推进 version；本测试桩无拦截器，故断言不变。
    expect(row.version).toBe(3);
  });

  it('冲突后重读再保存即可恢复（调用方恢复路径）', async () => {
    const row = makeRow();
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    const stale = await service.getPlayerData(42);
    const fresh = await service.getPlayerData(42);
    fresh.player.hp = 88;
    await service.savePlayer(fresh.player); // 别人先写

    await expect(service.savePlayer(stale.player)).rejects.toThrow('并发冲突');
    // 冲突方重读最新状态后继续自己的业务
    const retry = await service.getPlayerData(42);
    retry.player.markers2 = JSON.stringify([{ name: '标记', expireAt: 1 }]);
    await service.savePlayer(retry.player);

    expect(retry.player.hp).toBe(88);
    expect(JSON.parse(row.markers2)).toEqual([{ name: '标记', expireAt: 1 }]);
  });
});
