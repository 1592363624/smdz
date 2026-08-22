import { GameService } from '../src/modules/game/game.service';
import { StaticDataService } from '../src/modules/game/static-data.service';

jest.mock('../src/modules/game/static-data.service', () => {
  const actual = jest.requireActual('../src/modules/game/static-data.service');
  const originalLoad = actual.StaticDataService.prototype.loadRaw;
  actual.StaticDataService.prototype.loadRaw = function(key: any) {
    if (key === 'craftings') {
      return [
        {
          name: '轻型足', noCraft: false, level: 1,
          outputs: JSON.stringify([{ name: '轻型足', count: 1 }]),
          requirements: JSON.stringify([{ name: '铁矿', count: 2 }]),
          gainMarkers: '[]',
        },
      ];
    }
    return originalLoad.call(this, key);
  };
  return actual;
});

function parseValue<T>(value: any, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    const parsed = JSON.parse(value);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function makeService(options: {
  player?: any;
  map?: any;
  allMaps?: any[];
  recalculate?: (vehicle: any) => any;
} = {}) {
  const user = { id: 10, qqNumber: 'qq10', externalId: null };
  const player = options.player || {
    id: 1,
    userId: user.id,
    name: '甲',
    level: 10,
    hp: 100,
    mapId: 7,
    vehicle: '',
    backpack: JSON.stringify([]),
    markers: JSON.stringify({}),
    markers2: JSON.stringify([]),
    sets: '{}',
    attackMode: 0,
    masterQQ: '',
  };
  const map = options.map || {
    id: 7,
    mapIndex: 7,
    name: '医疗室',
    vehicles: '[]',
    summons: '[]',
  };
  const updateCalls: any[] = [];
  const savedPlayers: any[] = [];

  const prisma: any = {
    user: { findUnique: jest.fn(async () => user) },
  };

  const playerService: any = {
    getPlayerData: jest.fn(async () => ({ player, markers: parseValue(player.markers, {}) })),
    savePlayer: jest.fn(async (value: any) => { savedPlayers.push(value); }),
    safeJsonParse: jest.fn(parseValue),
    getBackpackItems: (value: any) => parseValue<any[]>(value.backpack, []),
    isPlayerDead: (value: any) => (value.hp || 0) <= 0,
  };

  const mapService: any = {
    getMapById: jest.fn(async () => map),
    getAllMaps: jest.fn(async () => options.allMaps || [map]),
    updateDynamicFields: jest.fn(async (_mapId: number, data: any) => {
      updateCalls.push(data);
      Object.assign(map, data);
    }),
  };

  const achievementService: any = {
    addAchievement: jest.fn(async (_player: any, name: string, value: number) => {
      const markers = parseValue(player.markers, {});
      markers[name] = (markers[name] || 0) + value;
      player.markers = JSON.stringify(markers);
    }),
    getAchievement: jest.fn(() => 0),
    setAchievement: jest.fn(),
  };

  const combatSystem: any = {
    actionUnrestricted: jest.fn(() => ({ restricted: false, text: '' })),
    recalculateVehicle: options.recalculate || jest.fn((vehicle: any) => {
      vehicle.加成 = { 生命: 5 };
      return vehicle;
    }),
  };

  const taskService: any = { advance: jest.fn(async () => '') };

  const service = new GameService(
    prisma,
    playerService,
    {} as any,
    combatSystem,
    {} as any,
    mapService,
    {} as any,
    {} as any,
    {} as any,
    achievementService,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    new StaticDataService(),
    {} as any,
    {} as any,
    {} as any,
    taskService,
    {} as any,
    {} as any,
    {} as any,
  );

  return { service, player, map, updateCalls, savedPlayers, taskService, achievementService };
}

describe('多零件组装载具复刻', () => {
  it('已有零件直接扣料，缺失零件自动制造并写入地图载具', async () => {
    const { service, player, map, updateCalls, savedPlayers } = makeService({
      player: {
        id: 1, userId: 10, name: '甲', level: 10, hp: 100, mapId: 7, vehicle: '',
        sets: '{}', attackMode: 0, masterQQ: '',
        backpack: JSON.stringify([
          { name: '骑士核心', type: '资源', quantity: 1 },
          { name: '轻型足', type: '资源', quantity: 1 },
          { name: '铁矿', type: '资源', quantity: 3 },
        ]),
        markers: JSON.stringify({}),
        markers2: JSON.stringify([]),
      },
    });

    const result = await service.assembleVehicleFromParts(10, ['骑士核心', '轻型足2']);

    expect(result).toContain('甲组装了一个载具：甲的骑士');
    const vehicles = JSON.parse(map.vehicles);
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].名称).toBe('甲的骑士');
    expect(vehicles[0].归属).toBe('qq10');
    expect(vehicles[0].当前生命).toBe(5);
    expect(parseValue<any[]>(vehicles[0].零件, []).map((part: any) => part.名称))
      .toEqual(['骑士核心', '轻型足']);
    expect(updateCalls[0].vehicles).toContain('甲的骑士');

    const backpack = JSON.parse(player.backpack);
    expect(backpack.find((item: any) => item.name === '骑士核心')).toBeUndefined();
    expect(backpack.find((item: any) => item.name === '轻型足')).toBeUndefined();
    expect(savedPlayers).toContain(player);
  });

  it('缺少且无法制造的零件时中止，不写地图也不扣料', async () => {
    const { service, player, map, updateCalls } = makeService({
      player: {
        id: 1, userId: 10, name: '甲', level: 10, hp: 100, mapId: 7, vehicle: '',
        sets: '{}', attackMode: 0, masterQQ: '',
        backpack: JSON.stringify([{ name: '铁矿', type: '资源', quantity: 3 }]),
        markers: JSON.stringify({}), markers2: JSON.stringify([]),
      },
    });

    const result = await service.assembleVehicleFromParts(10, ['骑士核心', '不存在零件2']);

    expect(result).toContain('缺少这些物品，并且背包里面的数量不够/背包里面的资源不足以制造缺少的数量：骑士核心x1、不存在零件x2');
    expect(map.vehicles).toBe('[]');
    expect(updateCalls).toHaveLength(0);
    expect(JSON.parse(player.backpack)).toEqual([{ name: '铁矿', type: '资源', quantity: 3 }]);
  });

  it('生产类核心受唯一生产载具限制', async () => {
    const existingProduction = {
      名称: '旧工作台',
      name: '旧工作台',
      归属: 'qq10',
      owner: 'qq10',
      零件: [{ 名称: '工作台核心', name: '工作台核心' }],
      配方: [],
      加成: {},
    };
    const { service, map, updateCalls } = makeService({
      map: { id: 7, mapIndex: 7, name: '医疗室', vehicles: '[]', summons: '[]' },
      allMaps: [{ id: 8, name: '其他地图', vehicles: JSON.stringify([existingProduction]) }],
    });

    const result = await service.assembleVehicleFromParts(10, ['工作台核心', '轻型足1']);

    expect(result).toContain('一个玩家只能同时存在一个生产类载具');
    expect(map.vehicles).toBe('[]');
    expect(updateCalls).toHaveLength(0);
  });
});
