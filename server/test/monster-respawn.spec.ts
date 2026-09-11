/**
 * 怪物刷新链路回归测试
 *
 * 对应原版 后台运作.ecode L1626-1690（后台线程扫描地图「标记2」补怪）
 * + L1024-1038（击杀登记「刷新怪物」标记，+120 秒）
 * + L458-461（发放奖励：非关卡地图击杀才登记标记）。
 *
 * 本文件锁定的线上事故：
 *   旧实现 `ScheduleService.respawnMonsters` 为「每分钟只要常驻怪数量 < monsterCount
 *   就 refreshMapMonsters（deleteMany + createMany 整批重刷）」，等价于每分钟把场上
 *   残血怪替换成满血新怪 → 玩家永远打不完一场战斗。
 * 原版语义：击杀后**不立即刷新**，登记 120 秒标记 → 到期补 1 只 → **只增不删**，
 * 总量封顶 `monsterCount`，且绝不重置存活怪。
 */
import { MapService } from '../src/modules/game/map.service';

const MARKER = '刷新怪物';

const slimeDef = {
  name: '史莱姆',
  type: '怪物',
  // 配置等级 > 0 → 走 pickMonsterLevel 短路分支，等级确定（不依赖全局熟练度）
  level: 2,
  hp: 30,
  shield: 0,
  armor: 0,
  dodge: 10,
  hit: 10,
  speed: 100,
  attack: 10,
  bonus: {},
};

function makeFixture(options: {
  markers2?: any[];
  residentCount?: number;
  template?: string[];
  mapExtra?: Record<string, any>;
} = {}) {
  const created: any[] = [];
  const updates: any[] = [];
  const template = options.template ?? ['史莱姆'];

  const prisma: any = {
    gameMap: {
      findUnique: jest.fn(async () => ({ id: 7, markers2: options.markers2 ?? [] })),
      update: jest.fn(async ({ data }: any) => {
        updates.push(data);
        return data;
      }),
    },
    gameMonster: {
      count: jest.fn(async () => options.residentCount ?? 0),
      createMany: jest.fn(async ({ data }: any) => {
        created.push(...data);
        return { count: data.length };
      }),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async ({ data }: any) => {
        created.push(data);
        return data;
      }),
      findMany: jest.fn(async () => []),
    },
  };

  const staticData: any = {
    getMapByName: jest.fn(() => null),
    getAllMonsters: jest.fn(() => [slimeDef]),
    getAllBuffs: jest.fn(() => []),
  };
  // buildMonsterBonusFromDef 会调用若干加成/套装子过程：本用例只关心「生成/不生成」
  // 与「是否整批重刷」，故统一桩成空实现。
  const bonusService: any = {
    calcCombatPower: jest.fn(() => 0),
    calculateBuffs: jest.fn(),
    calculateTreasureBonus: jest.fn(),
    calculateHanGuangBonus: jest.fn(),
    consumeReverseFairytaleBuffs: jest.fn(),
  };
  const combatState: any = { setJudgment: jest.fn() };

  const service = new MapService(
    prisma,
    staticData,
    bonusService,
    combatState,
    { emit: jest.fn() } as any,
  );

  const mapRow = {
    id: 7,
    name: '测试地图',
    monsters: template,
    monsterCount: 3,
    level: 1,
    ...(options.mapExtra ?? {}),
  };
  jest.spyOn(service, 'getMapById').mockResolvedValue(mapRow as any);

  return { service, created, updates, prisma, mapRow };
}

describe('怪物刷新（原版 刷新标记 语义）', () => {
  it('标记2 为空 → 按原版 L1630 分支直接补足到 monsterCount', async () => {
    const { service, created } = makeFixture({ markers2: [], residentCount: 0 });

    const spawned = await service.refillResidentMonstersByMarker(7);

    expect(spawned).toBe(3);
    expect(created).toHaveLength(3);
  });

  it('未到期的「刷新怪物」标记不补怪（击杀后 120 秒内不刷新）', async () => {
    const marker = { name: MARKER, expireAt: Date.now() + 60_000 };
    const { service, created, prisma } = makeFixture({ markers2: [marker], residentCount: 2 });

    const spawned = await service.refillResidentMonstersByMarker(7);

    expect(spawned).toBe(0);
    expect(created).toHaveLength(0);
    // 关键回归：补怪路径绝不整批删除/重建存活怪
    expect(prisma.gameMonster.deleteMany).not.toHaveBeenCalled();
  });

  it('到期的「刷新怪物」标记 → 补 1 只并消费该标记', async () => {
    const expired = { name: MARKER, expireAt: Date.now() - 1000 };
    const { service, created, updates } = makeFixture({ markers2: [expired], residentCount: 2 });

    const spawned = await service.refillResidentMonstersByMarker(7);

    expect(spawned).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe('史莱姆');
    // 标记被消费（L1682）：写回的 markers2 不再含「刷新怪物」
    const written = updates[updates.length - 1]?.markers2 ?? [];
    expect(written.filter((m: any) => m?.name === MARKER)).toHaveLength(0);
  });

  it('已满员时仍消费到期标记，但不补怪（上限 monsterCount）', async () => {
    const expired = { name: MARKER, expireAt: Date.now() - 1000 };
    const { service, created, updates } = makeFixture({ markers2: [expired], residentCount: 3 });

    const spawned = await service.refillResidentMonstersByMarker(7);

    expect(spawned).toBe(0);
    expect(created).toHaveLength(0);
    const written = updates[updates.length - 1]?.markers2 ?? [];
    expect(written).toHaveLength(0);
  });

  it('多条到期标记：补怪数 = min(到期标记数, 空位)（原版每 tick 1 只的批量等价）', async () => {
    const now = Date.now();
    const markers2 = [
      { name: MARKER, expireAt: now - 3000 },
      { name: MARKER, expireAt: now - 2000 },
      { name: MARKER, expireAt: now - 1000 },
    ];
    const { service, created } = makeFixture({ markers2, residentCount: 1 });

    const spawned = await service.refillResidentMonstersByMarker(7);

    expect(spawned).toBe(2); // 空位 2 只（3 - 1），第 3 条标记无空位可补但同样被消费
    expect(created).toHaveLength(2);
  });

  it('关卡地图（isInstance）不参与后台补怪（原版 地图.关卡 == 真）', async () => {
    const expired = { name: MARKER, expireAt: Date.now() - 1000 };
    const { service, created } = makeFixture({
      markers2: [expired],
      residentCount: 0,
      mapExtra: { isInstance: true },
    });

    const spawned = await service.refillResidentMonstersByMarker(7);

    expect(spawned).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('空模板地图不生成怪物（原版 L1632 前置判断）', async () => {
    const { service, created } = makeFixture({ markers2: [], residentCount: 0, template: [] });

    const spawned = await service.refillResidentMonstersByMarker(7);

    expect(spawned).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('spawnResidentMonsters 只增不删（不触碰存活怪）', async () => {
    const { service, created, prisma } = makeFixture({ markers2: [], residentCount: 1 });

    const spawned = await service.spawnResidentMonsters(7, 2);

    expect(spawned).toBe(2);
    expect(created).toHaveLength(2);
    expect(prisma.gameMonster.deleteMany).not.toHaveBeenCalled();
  });
});

describe('击杀登记「刷新怪物」标记（原版 刷新标记 类型1）', () => {
  it('登记一条 120 秒后到期的标记，且不覆盖同期已有标记', async () => {
    const { service, updates } = makeFixture({ markers2: [{ name: '活动', expireAt: Date.now() + 1000 }] });

    const ok = await service.addMonsterRespawnMarker(7);

    expect(ok).toBe(true);
    const written = updates[updates.length - 1]?.markers2 ?? [];
    expect(written).toHaveLength(2);
    const marker = written.find((m: any) => m?.name === MARKER);
    expect(marker).toBeTruthy();
    const remaining = marker.expireAt - Date.now();
    expect(remaining).toBeGreaterThan(110_000);
    expect(remaining).toBeLessThanOrEqual(120_000);
  });

  it('关卡地图不登记标记（原版 发放奖励 L460：地图.关卡 == 假 才登记）', async () => {
    const { service, updates } = makeFixture({ markers2: [], mapExtra: { isInstance: true } });

    const ok = await service.addMonsterRespawnMarker(7);

    expect(ok).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('空模板 / 怪物数量为 0 的地图不登记标记（避免堆积无效标记）', async () => {
    const empty = makeFixture({ markers2: [], template: [] });
    expect(await empty.service.addMonsterRespawnMarker(7)).toBe(false);
    expect(empty.updates).toHaveLength(0);

    const noCount = makeFixture({ markers2: [], mapExtra: { monsterCount: 0 } });
    expect(await noCount.service.addMonsterRespawnMarker(7)).toBe(false);
    expect(noCount.updates).toHaveLength(0);
  });
});

describe('markers2 合并写回（防旧快照整组覆盖）', () => {
  it('锁内新增的「刷新怪物」标记不会被旧快照回写抹掉', async () => {
    const fresh = [{ name: MARKER, expireAt: Date.now() + 120_000 }];
    const { service, updates } = makeFixture({ markers2: fresh });

    // 调用方持有的是更早的快照（只有「活动」），且它并不知道有一条击杀登记
    await service.mergeMapMarkers2(7, [{ name: '活动', expireAt: Date.now() + 60_000 }]);

    const written = updates[updates.length - 1]?.markers2 ?? [];
    expect(written.filter((m: any) => m?.name === MARKER)).toHaveLength(1);
    expect(written.filter((m: any) => m?.name === '活动')).toHaveLength(1);
  });

  it('多条「刷新怪物」标记不被折叠，同名一般标记按名 upsert', async () => {
    const now = Date.now();
    const fresh = [
      { name: MARKER, expireAt: now + 1000 },
      { name: MARKER, expireAt: now + 2000 },
      { name: '活动', expireAt: now + 3000 },
    ];
    const { service, updates } = makeFixture({ markers2: fresh });

    const staleSnapshot = [
      { name: MARKER, expireAt: now + 9999 },
      { name: '活动', expireAt: now + 60000 },
    ];
    await service.mergeMapMarkers2(7, staleSnapshot);

    const written = updates[updates.length - 1]?.markers2 ?? [];
    // 刷新标记以锁内最新值为准（仍是 2 条），活动被覆盖为新值
    expect(written.filter((m: any) => m?.name === MARKER)).toHaveLength(2);
    expect(written.find((m: any) => m?.name === '活动')?.expireAt).toBe(now + 60000);
  });
});

describe('地图标记清理（pruneExpiredMapMarkers2）', () => {
  it('清理过期的一般标记，但保留「刷新怪物」/「刷新资源X」给专用消费者', async () => {
    const now = Date.now();
    const markers2 = [
      { name: '战斗', expireAt: now - 1000 },
      { name: MARKER, expireAt: now - 1000 },
      { name: '刷新资源铁矿', expireAt: now - 1000 },
      { name: '活动', expireAt: now + 60000 },
    ];
    const { service, updates } = makeFixture({ markers2 });

    const removed = await service.pruneExpiredMapMarkers2(7, now);

    expect(removed).toBe(1);
    const written = updates[updates.length - 1]?.markers2 ?? [];
    expect(written.map((m: any) => m.name)).toEqual([MARKER, '刷新资源铁矿', '活动']);
  });
});
