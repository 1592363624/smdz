/**
 * 地图聚合串行化闭环写（mutateMapFields / mutateSummons）行为验证。
 *
 * 背景：GameMap 的 summons/items/markers 等 Json 列是「读出数组 → 内存改 → 整组写回」
 * 的裸聚合。历史上 getMapById 合并快照（陈旧）做读改写，并发时互相覆盖
 * （白被地图写竞态清除即此类事故）。
 *
 * mutateMapFields 收敛为「锁内闭环」：withMapLock(mapId) → 重读 DB 最新行 →
 * 归一化字段 → mutator 改 → 逐字段 JSON diff，只写真正变了的列。
 * 本套用例用真实 withMapLock + 可观测的 prisma 桩验证：
 *  1. 并发追加（push）到同一 summons 时两条都保留（不丢更新）。
 *  2. mutator 返回 false / 未改时，不写库（diff 生效）。
 *  3. 只写变化的字段（未动字段不落库）。
 *  4. mutateSummons 是 mutateMapFields 的 summons 简写，行为一致。
 *  5. 死锁警示：mutator 内不得嵌套 withMapLock（这里验证不触发即可，靠文档约束）。
 */

import { MapService } from '../src/modules/game/map.service';

function makeDbRows(initial: any[]) {
  const rows = [...initial];
  return rows;
}

function makeFixture() {
  const db = {
    rows: [
      {
        id: 7,
        name: '测试地图',
        summons: [{ name: '白', ownerQQ: '1' }],
        items: [],
        markers2: [],
      },
    ],
    writes: [] as Array<Record<string, any>>,
  };
  const prisma: any = {
    gameMap: {
      findUnique: jest.fn(async ({ where }: any) => {
        const row = db.rows.find((r) => r.id === where?.id);
        // 返回深拷贝，模拟真实 Prisma 每次读到独立快照
        return row ? JSON.parse(JSON.stringify(row)) : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = db.rows.find((r) => r.id === where?.id);
        if (!row) throw new Error(`not found ${where?.id}`);
        // 逐字段合并（Prisma 只更新 data 里的列），记录本次写入
        db.writes.push({ data });
        for (const [field, value] of Object.entries(data)) {
          (row as any)[field] = JSON.parse(JSON.stringify(value));
        }
        return row;
      }),
    },
  };
  const staticData: any = { getMapByName: jest.fn(() => null) };
  const service = new MapService(
    prisma,
    staticData,
    {} as any,
    {} as any,
    { emit: jest.fn() } as any,
  );
  return { service, db, prisma };
}

describe('地图聚合串行化闭环写', () => {
  it('并发 push 到同一 summons：锁内重读使两次追加都保留（不丢更新）', async () => {
    const { service, db } = makeFixture();

    // 并发两个追加操作——每个 mutateSummons 都在锁内重读最新行，
    // 而非基于调用前的陈旧快照整组覆盖，因此两个新召唤物都保留。
    await Promise.all([
      service.mutateSummons(7, (summons) => {
        summons.push({ name: '白2', ownerQQ: '2' });
      }),
      service.mutateSummons(7, (summons) => {
        summons.push({ name: '麒麟', ownerQQ: '3' });
      }),
    ]);

    const names = db.rows[0].summons.map((s: any) => s.name);
    // 三个都在：初始白 + 白2 + 麒麟（若用陈旧快照整组覆盖，必丢其一）
    expect(names).toEqual(['白', '白2', '麒麟']);
  });

  it('mutator 改动被完整写回，未动字段不落库（逐字段 diff）', async () => {
    const { service, db } = makeFixture();

    await service.mutateMapFields(7, ['summons', 'items'], (f) => {
      f.items.push({ name: '木头', count: 2 });
      // summons 不改动
    });

    // 只写了 items 一列；summons 未变不应出现在 update data 里
    expect(db.writes).toHaveLength(1);
    expect(Object.keys(db.writes[0].data)).toEqual(['items']);
    expect(db.rows[0].items).toEqual([{ name: '木头', count: 2 }]);
    // 未动字段保持原值
    expect(db.rows[0].summons).toEqual([{ name: '白', ownerQQ: '1' }]);
  });

  it('mutator 未实际改动时不触发写库（避免无谓推进 version）', async () => {
    const { service, db, prisma } = makeFixture();

    const result = await service.mutateSummons(7, () => 42);

    expect(result).toBe(42);
    expect(prisma.gameMap.update).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(0);
  });

  it('mutator 返回 true 且做了改动 → 值透传且写库', async () => {
    const { service, db } = makeFixture();

    const found = await service.mutateSummons(7, (summons) => {
      const idx = summons.findIndex((s: any) => s.name === '白');
      if (idx === -1) return false;
      summons[idx].ownerQQ = '9';
      return true;
    });

    expect(found).toBe(true);
    expect(db.rows[0].summons[0].ownerQQ).toBe('9');
    expect(db.writes).toHaveLength(1);
    expect(Object.keys(db.writes[0].data)).toEqual(['summons']);
  });

  it('mutateMapFields 可同时闭环多个字段，字段间互不覆盖', async () => {
    const { service, db } = makeFixture();

    await service.mutateMapFields(7, ['summons', 'items', 'markers2'], (f) => {
      f.summons.push({ name: '新增', ownerQQ: 'x' });
      f.items.push({ name: '废铁', count: 1 });
      f.markers2.push({ name: '刷新资源木', expireAt: Date.now() + 1000 });
    });

    expect(db.rows[0].summons.map((s: any) => s.name)).toEqual(['白', '新增']);
    expect(db.rows[0].items).toEqual([{ name: '废铁', count: 1 }]);
    expect(db.rows[0].markers2).toHaveLength(1);
    expect(db.writes).toHaveLength(1);
    expect(Object.keys(db.writes[0].data).sort()).toEqual(['items', 'markers2', 'summons']);
  });
});
