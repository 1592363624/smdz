import { GameService } from '../src/modules/game/game.service';
import { MapService } from '../src/modules/game/map.service';
import { FamiliarSkillsService } from '../src/modules/game/familiar-skills.service';

function parseJson(value: any, fallback: any): any {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

describe('生成神之工匠/生成废弃载具 语义还原 + 耗时公式复核 + 掌控时间', () => {
  afterEach(() => jest.restoreAllMocks());

  function makeGameService(options: { role?: string; monsterDefs?: string[] } = {}) {
    const player: any = {
      id: 1, userId: 42, name: '冒险者', mapId: 7, markers: '{}', markers2: '[]', hp: 100,
    };
    const map: any = { id: 7, name: '工坊地图', markers2: '[]', summons: '[]' };
    const summonsStore: any[] = [];
    const wreckMapVehicles = { value: '[]' };
    const service: any = Object.create(GameService.prototype);
    Object.assign(service, {
      prisma: {
        user: { findUnique: jest.fn(async () => ({ id: 42, role: options.role ?? 'ADMIN' })) },
      },
      playerService: {
        getPlayerData: jest.fn(async () => ({
          player, markers: {}, markers2: [], equipment: [], weapons: [],
        })),
        savePlayer: jest.fn(async () => undefined),
        setMarker: jest.fn((markers: any, name: string, value: any) => {
          markers[name] = value;
        }),
        enqueueUserWrite: jest.fn(async (_uid: number, fn: () => any) => fn()),
      },
      mapService: {
        getMapById: jest.fn(async () => map),
        mutateMapFields: jest.fn(async (_mapId: number, _fields: string[], fn: (f: any) => any) => {
          const f: any = { vehicles: parseJson(wreckMapVehicles.value, []) };
          fn(f);
          wreckMapVehicles.value = JSON.stringify(f.vehicles);
          return true;
        }),
        createMapSummonByName: jest.fn(async (_mapId: number, name: string) => ({
          name, type: name, hp: 500, maxHp: 500, level: 3, markers: [],
        })),
        mutateSummons: jest.fn(async (_mapId: number, fn: (s: any[]) => any) => {
          const summons: any[] = summonsStore;
          await fn(summons);
          return summons;
        }),
      },
      combatSystem: {
        recalculateVehicle: jest.fn((vehicle: any) => {
          vehicle.加成 = { 生命: 300 };
          return vehicle;
        }),
      },
      staticData: {
        loadRaw: jest.fn((key: string) => key === 'wrecks' ? [
          { name: '废弃的骑士', chance: 2, parts: [{ name: '骑士核心', count: 1 }, { name: '残骸', count: 100 }] },
        ] : []),
      },
      logger: { log: jest.fn(), warn: jest.fn() },
    });
    return { service, player, map, wreckMapVehicles, summonsStore };
  }

  it('生成神之工匠：双怪物型召唤物（神之工匠/小雫，npc1g/npc2g，特殊序号-2）', async () => {
    const fixture = makeGameService();

    const result = await fixture.service.handleSpawnArtisan(42);

    expect(result).toContain('神之工匠来到了工坊地图');
    const [mapId] = fixture.service.mapService.mutateSummons.mock.calls[0];
    expect(mapId).toBe(7);
    // 两次 mutateSummons 共享累积数组：神之工匠 + 小雫
    expect(fixture.summonsStore).toHaveLength(2);
    expect(fixture.summonsStore[0]).toMatchObject({ name: '神之工匠', type: '粉狐狐', qq: 'npc1g', 特殊序号: -2, 归属: '1' });
    expect(fixture.summonsStore[1]).toMatchObject({ name: '小雫', type: '精英小雫', qq: 'npc2g', 特殊序号: -2, 归属: '1' });
  });

  it('生成神之工匠：非管理员拒绝', async () => {
    const fixture = makeGameService({ role: 'USER' });
    expect(await fixture.service.handleSpawnArtisan(42)).toContain('权限不足');
  });

  it('生成废弃载具：随机地图随机载具实体（归属无主，按几率加权抽取）', async () => {
    const fixture = makeGameService();
    const wreckMap: any = { id: 9, name: '废土', 开拓地: false, markers2: '[]', vehicles: '[]' };
    fixture.service.mapService.getMapById.mockImplementation(async (id: number) =>
      Number(id) === 9 ? wreckMap : fixture.map);
    fixture.service.mapService.getAllMaps = jest.fn(async () => [
      { id: 1, name: '新手村', 开拓地: false },
      { id: 9, name: '废土' },
    ]);

    const result = await fixture.service.handleSpawnWreck(42);

    expect(result).toContain('在废土生成了一个废弃载具');
    const vehicles = parseJson(fixture.wreckMapVehicles.value, []);
    expect(vehicles).toHaveLength(1);
    const vehicle = vehicles[0];
    expect(vehicle.名称).toBe('废弃的骑士'); // 原版 去数字
    expect(vehicle.归属).toBe('无主');
    expect(vehicle.零件[0].名称).toBe('骑士核心');
    expect(Number(vehicle.当前生命)).toBe(300); // recalculateVehicle 桩
    // 排除 id<3 / 开拓地 / 关卡
    expect(result).not.toContain('新手村');
  });

  it('耗时公式：b=距离/速度（整数截断），下限=路径节点数（原版 L6638-6644，×10 系数移除）', async () => {
    const service: any = Object.create(MapService.prototype);
    // 距离30/速度10 → 3 秒（原 ×10 会得 30）
    expect(service.calcTravelTime(30, 10)).toBe(3);
    // 距离130/速度100 → 1 秒（整数截断）
    expect(service.calcTravelTime(130, 100)).toBe(1);
    // 下限：路径节点数
    expect(service.calcTravelTime(30, 1000, 5)).toBe(5);
    // 最低 1 秒
    expect(service.calcTravelTime(10, 1000)).toBe(1);
  });

  it('掌控时间：时间主宰门禁、sjz 360秒自身冷却、递减技能冷却', async () => {
    const service: any = Object.create(FamiliarSkillsService.prototype);
    const player: any = {
      id: 1, userId: 42, name: '冒险者', type: '龙姬',
      markers: '{}',
      markers2: JSON.stringify([
        { name: '龙姬技能冷却', expireAt: Date.now() + 120 * 1000, kind: 'skill-cd' },
        { name: '采集', expireAt: Date.now() + 60 * 1000 }, // 非技能CD标记不误伤
      ]),
      buffs: '[]', equipment: '[]', sets: '{}',
    };
    service.playerService = {
      getPlayerData: jest.fn(async () => ({ player, markers: {}, markers2: parseJson(player.markers2, []), equipment: [] })),
      getMarkerValue: jest.fn((m: any, k: string) => Number(m?.[k] ?? 0)),
      savePlayer: jest.fn(async () => undefined),
    };
    service.logger = { log: jest.fn(), warn: jest.fn() };

    // 无时间主宰 → 门禁
    const noItem = await service.timeControl(42);
    expect(noItem).toContain('时间主宰');

    // 装备时间主宰 → 递减技能冷却并写 360 秒自身冷却
    player.equipment = JSON.stringify([{ name: '时间主宰' }]);
    const result = await service.timeControl(42);
    expect(result).toContain('清空了技能冷却');
    const markers2 = parseJson(player.markers2, []);
    // 技能冷却剩余 120-60=60 秒
    const skillCd = markers2.find((m: any) => m.name === '龙姬技能冷却');
    expect(skillCd.expireAt - Date.now()).toBeLessThanOrEqual(60 * 1000);
    expect(skillCd.expireAt - Date.now()).toBeGreaterThan(55 * 1000);
    // 采集标记不受影响
    expect(markers2.find((m: any) => m.name === '采集')).toBeTruthy();
    // 自身冷却键（沿用 sjz 语义，360 秒）
    const selfCd = markers2.find((m: any) => m.name === '掌控时间');
    expect(selfCd).toBeTruthy();
    expect(selfCd.expireAt - Date.now()).toBeLessThanOrEqual(360 * 1000);
  });
});
