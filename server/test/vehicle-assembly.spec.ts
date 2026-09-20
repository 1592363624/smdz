import { GameService } from '../src/modules/game/game.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { createGameServiceStub } from './helpers/game-service-stub.factory';

jest.mock('../src/modules/game/static-data.service', () => {
  const actual = jest.requireActual('../src/modules/game/static-data.service');
  const originalLoad = actual.StaticDataService.prototype.loadRaw;
  actual.StaticDataService.prototype.loadRaw = function(key: any) {
    if (key === 'craftings') {
      return [
        {
          name: '轻型足', noCraft: false, level: 1,
          outputs: JSON.stringify([{ name: '轻型足', quantity: 1 }]),
          requirements: JSON.stringify([{ name: '铁矿', quantity: 2 }]),
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
    gameVehicle: {
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 99, name: '新载具' })),
    },
  };

  const playerService: any = {
    getPlayerData: jest.fn(async () => ({ player, markers: parseValue(player.markers, {}) })),
    savePlayer: jest.fn(async (value: any) => { savedPlayers.push(value); }),
    safeJsonParse: jest.fn(parseValue),
    getBackpackItems: (value: any) => parseValue<any[]>(value.backpack, []),
    isPlayerDead: (value: any) => (value.hp || 0) <= 0,
    getCurrencyAmount: (player: any, name: string, backpack?: any[]) => {
      const items = backpack ?? parseValue<any[]>(player.backpack, []);
      const item = items.find((it: any) => it?.name === name);
      return Number(item?.quantity ?? 0) || 0;
    },
    setCurrencyAmount: (player: any, name: string, value: number, backpack?: any[]) => {
      const items = backpack ?? parseValue<any[]>(player.backpack, []);
      const idx = items.findIndex((it: any) => it?.name === name);
      const qty = Number(value) || 0;
      if (qty <= 0) {
        if (idx >= 0) items.splice(idx, 1);
      } else if (idx >= 0) {
        items[idx].quantity = qty;
        items[idx].count = qty;
      } else {
        items.push({ name, type: '资源', quantity: qty, count: qty });
      }
      if (!backpack) player.backpack = items;
    },
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
      vehicle.bonus = { 生命: 5 };
      return vehicle;
    }),
    produceVehicle: jest.fn((vehicle: any) => {
      vehicle.bonus = { 生命: 5 };
      return {
        productionDisplay: '0!0!0!100',
        productionSpeed: 1,
        byproductMultiplier: 1,
        consumptionMultiplier: 1,
        efficiency: 1,
        availableTime: 0,
        consumedProductivity: 0,
        elapsedMs: 0,
        outputPerMinute: [],
        consumptionPerMinute: [],
        combinedPerMinute: [],
        produced: [],
        consumed: [],
        stopped: false,
      };
    }),
    calculateVehicleProduction: jest.fn(() => ({
      productionDisplay: '0!0!0!100',
      productionSpeed: 1,
      byproductMultiplier: 1,
      consumptionMultiplier: 1,
      efficiency: 1,
      availableTime: 0,
      consumedProductivity: 0,
      elapsedMs: 0,
      outputPerMinute: [],
      consumptionPerMinute: [],
      combinedPerMinute: [],
      produced: [],
      consumed: [],
      stopped: false,
    })),
  };

  const taskService: any = { advance: jest.fn(async () => '') };

  const service = createGameServiceStub({
      prisma: prisma,
      playerService: playerService,
      bonusService: {} as any,
      combatSystem: combatSystem,
      itemService: {} as any,
      mapService: mapService,
      familiarService: {} as any,
      dungeonService: {} as any,
      adminService: {} as any,
      achievementService: achievementService,
      itemSystemService: {} as any,
      homeService: {} as any,
      familiarSystemService: {} as any,
      familiarSkillsService: {} as any,
      tutorialService: {} as any,
      staticData: new StaticDataService(),
      systemConfigService: {} as any,
      chatService: {} as any,
      feedbackService: {} as any,
      taskService: taskService,
      shortcutService: {} as any,
      statsService: {} as any,
      combatState: {} as any,
    });

  // movement/vehicle 域在子服务上，跨簇调用经门面引用——桩自挂门面
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
    const vehicles = parseValue<any[]>(map.vehicles, []);
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].name).toBe('甲的骑士');
    expect(vehicles[0].owner).toBe('qq10');
    expect(vehicles[0].currentHp).toBe(5);
    expect(parseValue<any[]>(vehicles[0].parts, []).map((part: any) => part.name))
      .toEqual(['骑士核心', '轻型足']);
    // 生产写回的是原生数组（Json 列不再落 JSON 字符串），断言对象而非子串
    expect(parseValue<any[]>(updateCalls[0].vehicles, []))
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: '甲的骑士' })]));

    const backpack = parseValue<any[]>(player.backpack, []);
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
    expect(parseValue<any[]>(player.backpack, [])).toEqual([{ name: '铁矿', type: '资源', quantity: 3 }]);
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

describe('组装双向物流（原版 L10203-L10269）', () => {
  function makeDrivingService(backpackItems: any[] = [], vehicleParts: any[] = []) {
    const vehicle = {
      名称: '白天鹅',
      name: '白天鹅',
      类型: '骑士',
      type: '骑士',
      编号: 'vehicle-1',
      vehicleId: 'vehicle-1',
      归属: 'qq10',
      owner: 'qq10',
      驾驶员: 'qq10',
      driver: 'qq10',
      当前生命: 100,
      currentHp: 100,
      生命: 100,
      maxHp: 100,
      零件: [
        { 名称: '骑士核心', name: '骑士核心', 类型: '资源', type: '资源', 数量: 1, quantity: 1, 耐久: 100, durability: 100 },
        ...vehicleParts,
      ],
      配方: [{ 名称: '1', name: '1', 数值: 0, value: 0 }],
      加成: {},
      标记2: [],
    };
    return makeService({
      player: {
        id: 1, userId: 10, name: '甲', level: 10, hp: 100, mapId: 7,
        vehicle: 'vehicle-1',
        sets: '{}', attackMode: 0, masterQQ: '',
        backpack: JSON.stringify(backpackItems),
        markers: JSON.stringify({}), markers2: JSON.stringify([]),
      },
      map: {
        id: 7, mapIndex: 7, name: '医疗室',
        vehicles: JSON.stringify([vehicle]),
        summons: '[]',
      },
    });
  }

  it('组装生肉100 把资源塞进载具零件', async () => {
    const { service, player, map } = makeDrivingService(
      [{ name: '生肉', type: '资源', quantity: 120 }],
      [],
    );

    const result = await service.handleAssembleVehicle(10, '生肉', 100);

    expect(result).toContain('把生肉x100塞到了白天鹅里面');
    const stored = parseValue<any[]>(map.vehicles, [])[0];
    const meat = parseValue<any[]>(stored.parts, []).find((p: any) => p.name === '生肉');
    expect(meat?.quantity).toBe(100);
    const bag = parseValue<any[]>(player.backpack, []).find((i: any) => i.name === '生肉');
    expect(bag?.quantity).toBe(20);
  });

  it('组装生肉-40 从载具取出资源回背包', async () => {
    const { service, player, map } = makeDrivingService(
      [],
      [{ 名称: '生肉', name: '生肉', 类型: '资源', type: '资源', 数量: 50, quantity: 50, 耐久: 100, durability: 100 }],
    );

    const result = await service.handleAssembleVehicle(10, '生肉', -40);

    expect(result).toContain('把生肉x40从白天鹅上取了出来');
    const stored = parseValue<any[]>(map.vehicles, [])[0];
    const meat = parseValue<any[]>(stored.parts, []).find((p: any) => p.name === '生肉');
    expect(meat?.quantity).toBe(10);
    const bag = parseValue<any[]>(player.backpack, []).find((i: any) => i.name === '生肉');
    expect(bag?.quantity).toBe(40);
  });

  it('背包不足时按现有数量尽量装入', async () => {
    const { service, player, map } = makeDrivingService(
      [{ name: '燃料', type: '资源', quantity: 3 }],
      [],
    );

    const result = await service.handleAssembleVehicle(10, '燃料', 10);

    expect(result).toContain('把燃料x3塞到了白天鹅里面');
    const stored = parseValue<any[]>(map.vehicles, [])[0];
    const fuel = parseValue<any[]>(stored.parts, []).find((p: any) => p.name === '燃料');
    expect(fuel?.quantity).toBe(3);
    expect(parseValue<any[]>(player.backpack, []).find((i: any) => i.name === '燃料')).toBeUndefined();
  });
});
