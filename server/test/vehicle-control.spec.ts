import { GameService } from '../src/modules/game/game.service';
import { normalizeMapRow } from '../src/modules/game/field-contract.util';
import { createGameServiceStub } from './helpers/game-service-stub.factory';

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
  user?: any;
  player?: any;
  map?: any;
  allMaps?: any[];
  dbVehicles?: any[];
  previousPlayers?: Map<number, any>;
}) {
  const user = options.user || { id: 10, qqNumber: 'qq10', externalId: null };
  const player = options.player || {
    id: 1,
    userId: user.id,
    name: '甲',
    mapId: 7,
    vehicle: '',
    sets: '{}',
    masterQQ: '',
  };
  const map = options.map || {
    id: 7,
    mapIndex: 7,
    name: '医疗室',
    vehicles: '[]',
    summons: '[]',
  };
  const dbVehicles = options.dbVehicles || [];
  const previousPlayers = options.previousPlayers || new Map<number, any>();
  const updateCalls: any[] = [];
  const dbUpdateCalls: any[] = [];
  const savedPlayers: any[] = [];
  const achievements: string[] = [];

  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id === user.id) return user;
        return [...previousPlayers.values()].find((value: any) => value.userId === where.id) || null;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const conditions = where?.OR || [];
        return [...previousPlayers.values()].find((value: any) => conditions.some((condition: any) =>
          (condition.qqNumber && condition.qqNumber === value.qqNumber) ||
          (condition.externalId && condition.externalId === value.externalId),
        )) || null;
      }),
    },
    player: {
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
    },
    gameVehicle: {
      findUnique: jest.fn(async ({ where }: any) =>
        dbVehicles.find((value: any) => value.id === where.id) || null),
      findFirst: jest.fn(async ({ where }: any) => {
        const conditions = where?.OR || [];
        return dbVehicles.find((value: any) => conditions.some((condition: any) =>
          (condition.name && condition.name === value.name) ||
          (condition.vehicleId && condition.vehicleId === value.vehicleId),
        )) || null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const value = dbVehicles.find((item: any) => item.id === where.id);
        if (value) Object.assign(value, data);
        dbUpdateCalls.push({ where, data });
        return value;
      }),
    },
  };

  const playerService: any = {
    getPlayerData: jest.fn(async (userId: number) => {
      if (userId === player.userId) return { player, markers: parseValue(player.markers, {}) };
      const previous = previousPlayers.get(userId);
      return previous ? { player: previous } : { player: null };
    }),
    savePlayer: jest.fn(async (value: any) => { savedPlayers.push(value); }),
    safeJsonParse: jest.fn(parseValue),
    getBackpackItems: (value: any) => parseValue<any[]>(value.backpack, []),
    getCurrencyAmount: (value: any, name: string, backpack?: any[]) => {
      const items = backpack ?? parseValue<any[]>(value.backpack, []);
      const item = items.find((it: any) => it?.name === name);
      return Number(item?.quantity ?? 0) || 0;
    },
    setCurrencyAmount: (value: any, name: string, qty: number, backpack?: any[]) => {
      const items = backpack ?? parseValue<any[]>(value.backpack, []);
      const idx = items.findIndex((it: any) => it?.name === name);
      const n = Number(qty) || 0;
      if (n <= 0) {
        if (idx >= 0) items.splice(idx, 1);
      } else if (idx >= 0) {
        items[idx].quantity = n;
        items[idx].count = n;
      } else {
        items.push({ name, type: '资源', quantity: n, count: n });
      }
      if (!backpack) value.backpack = items;
    },
    isPlayerDead: (value: any) => (value.hp || 0) <= 0,
  };
  const mapService: any = {
    getMapById: jest.fn(async (id?: number) => (id == null || map.id === id) ? map : null),
    getAllMaps: jest.fn(async () => options.allMaps || [map]),
    updateDynamicFields: jest.fn(async (_mapId: number, data: any) => {
      // 真实链路的 GameMap 落库会过 Prisma 字段规范中间件（normalizeMapRow），
      // 桩内同样归一化，保证持久层不再残留旧别名（名称/归属/驾驶员…）。
      const payload = { ...data };
      if (payload.vehicles) normalizeMapRow({ vehicles: payload.vehicles });
      updateCalls.push(payload);
      Object.assign(map, payload);
    }),
    mutateMapFields: jest.fn(async (mapId: number, _fields: string[], mutator: (f: any) => any) => {
      const targetMap = (options.allMaps || []).find((m: any) => m.id === mapId)
        || (map.id === mapId ? map : null)
        || map;
      const working: Record<string, any> = {};
      for (const key of ['resources', 'resources2', 'vehicles', 'summons', 'markers2']) {
        if (targetMap[key] !== undefined) {
          const raw = targetMap[key];
          working[key] = typeof raw === 'string' ? JSON.parse(raw) : raw;
        }
      }
      const result = await mutator(working);
      for (const key of Object.keys(working)) {
        targetMap[key] = JSON.stringify(working[key]);
      }
      return result;
    }),
    getMapMonsters: jest.fn(async () => []),
  };
  const achievementService: any = {
    addAchievement: jest.fn(async (_player: any, name: string) => { achievements.push(name); }),
    getAchievement: jest.fn(() => 0),
    setAchievement: jest.fn(),
  };
  const taskService: any = { advance: jest.fn(async () => '') };
  const placeholder = {} as any;

  const combatSystem: any = {
      recalculateVehicle: jest.fn((vehicle: any) => {
        vehicle.加成 = { ...(vehicle.加成 || {}), 生命: Number(vehicle.加成?.生命 ?? vehicle.maxHp ?? 100) };
        return vehicle;
      }),
      actionUnrestricted: jest.fn(() => ({ restricted: false, text: '' })),
    };
    const combatState: any = {
      timeIntervalRequire: jest.fn(() => false),
      addMarker: jest.fn(),
      buffRequire: jest.fn(() => false),
    };
    const staticData: any = {
      getVehiclePartSpecByName: jest.fn((name: string) =>
        name === '牵引光束' || name === '大型牵引光束' || name === '巡洋舰核心'
          ? { name, partType: name.endsWith('核心') ? 0 : 4, bonus: {} }
          : null),
      getBuildingByName: jest.fn(() => null),
      getVehiclePartByName: jest.fn((name: string) =>
        name.endsWith('核心') || name === '牵引光束' || name === '大型牵引光束' || name === '中型推进器'
          ? { name, partType: name.endsWith('核心') ? 0 : 4, bonus: { 生命: 100 } }
          : null),
      getAllCraftings: jest.fn(() => [
        { name: '牵引光束', requirements: [{ name: '铁矿', quantity: 2 }] },
        { name: '巡洋舰核心', requirements: [{ name: '铁矿', quantity: 10 }] },
      ]),
      getAllVehiclePartSpecs: jest.fn(() => []),
      // 远古遗迹残骸静态表（认领封印用，桩内无数据）
      loadRaw: jest.fn(() => []),
    };
    const gatherPanel: any = {
      collectVehiclePartNames: jest.fn((vehicle: any) => {
        const parts = Array.isArray(vehicle?.parts) ? vehicle.parts : [];
        return parts.map((p: any) => String(p?.name ?? ''));
      }),
    };
    const shortcutService: any = { setTempInput: jest.fn(async () => undefined) };

    const service = createGameServiceStub({
      prisma: prisma,
      playerService: playerService,
      bonusService: {} as any,
      combatSystem,
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
      staticData,
      // 封印/唤醒开关统一走 SystemConfigService.get（未指定时回落默认值）
      systemConfigService: { get: jest.fn(async (_key: string, fallback: any) => fallback) } as any,
      chatService: {} as any,
      feedbackService: {} as any,
      taskService: taskService,
      shortcutService,
      statsService: {} as any,
      combatState,
      gatherPanelService: gatherPanel,
    });
    (service.movementVehicleService as any).panel = gatherPanel;

  return { service, player, map, prisma, dbVehicles, previousPlayers, updateCalls, dbUpdateCalls, savedPlayers, achievements, staticData, combatSystem, combatState, shortcutService };
}

function vehicle(overrides: any = {}) {
  return {
    名称: '测试车',
    name: '测试车',
    类型: '战斗',
    type: '战斗',
    编号: 'vehicle-1',
    vehicleId: 'vehicle-1',
    归属: 'qq10',
    owner: 'qq10',
    驾驶员: '',
    driver: '',
    当前生命: 100,
    currentHp: 100,
    生命: 100,
    maxHp: 100,
    零件: [],
    配方: [],
    加成: {},
    标记2: [],
    ...overrides,
  };
}

describe('载具驾驶/脱出复刻', () => {
  it('驾驶只允许当前地图的本人或无主载具，并清除旧载具与接管状态', async () => {
    const { service, player, map, updateCalls, achievements } = makeService({
      player: {
        id: 1, userId: 10, name: '甲', mapId: 7, vehicle: 'old-vehicle',
        sets: JSON.stringify({ 接管载具: 'old-vehicle', takeVehicle: 'old-vehicle' }), masterQQ: '',
      },
      map: {
        id: 7, mapIndex: 7, name: '医疗室',
        vehicles: JSON.stringify([
          vehicle({ 名称: '旧车', name: '旧车', 编号: 'old-vehicle', vehicleId: 'old-vehicle', driver: 'qq10', 驾驶员: 'qq10' }),
          vehicle({ 名称: '无主车', name: '无主车', 编号: 'new-vehicle', vehicleId: 'new-vehicle', 归属: '无主', owner: '无主' }),
        ]),
        summons: '[]',
      },
    });

    const result = await service.handleDriveVehicle(10, '无主车');
    const vehicles = parseValue<any[]>(map.vehicles, []);

    expect(result).toContain('获取了无主车的权限');
    expect(player.vehicle).toBe('new-vehicle');
    expect(parseValue<any>(player.sets, {})).toEqual({ takeVehicle: '', 接管载具: '' });
    expect(vehicles[0].driver).toBe('');
    // 口径统一后地图载具只落英文规范键，不再写中文镜像（双存储已合并为单一存储）
    expect(vehicles[0].驾驶员).toBeUndefined();
    expect(vehicles[1].owner).toBe('qq10');
    expect(vehicles[1].归属).toBeUndefined();
    expect(vehicles[1].driver).toBe('qq10');
    expect(updateCalls).toHaveLength(1);
    expect(achievements).toEqual(expect.arrayContaining(['拾取载具', '驾驶载具']));
  });

  it('别人归属的当前地图载具不能驾驶', async () => {
    const { service, player, map, updateCalls, savedPlayers } = makeService({
      map: {
        id: 7, mapIndex: 7, name: '医疗室',
        vehicles: JSON.stringify([vehicle({ 归属: 'qq-other', owner: 'qq-other', 名称: '别人的车', name: '别人的车' })]),
        summons: '[]',
      },
    });

    const result = await service.handleDriveVehicle(10, '别人的车');

    expect(result).toBe('甲这是别人的别人的车，你不能驾驶');
    expect(player.vehicle).toBe('');
    expect(updateCalls).toHaveLength(0);
    expect(savedPlayers).toHaveLength(0);
  });

  it('切换载具会踢出目标载具原驾驶员，并清除其玩家状态', async () => {
    const previous = {
      id: 20, userId: 20, name: '乙', mapId: 7, vehicle: 'target-vehicle', sets: '{}',
    };
    const { service, player, map, previousPlayers } = makeService({
      previousPlayers: new Map([[20, { ...previous, qqNumber: 'qq20', externalId: null }]]),
      map: {
        id: 7, mapIndex: 7, name: '医疗室',
        vehicles: JSON.stringify([vehicle({
          名称: '目标车', name: '目标车', 编号: 'target-vehicle', vehicleId: 'target-vehicle',
          driver: 'qq20', 驾驶员: 'qq20', 归属: 'qq10', owner: 'qq10',
        })]),
        summons: '[]',
      },
    });

    await service.handleDriveVehicle(10, '目标车');

    const vehicles = parseValue<any[]>(map.vehicles, []);
    expect(vehicles[0].driver).toBe('qq10');
    expect(player.vehicle).toBe('target-vehicle');
    expect(previousPlayers.get(20).vehicle).toBe('');
  });

  it('数据库载具按当前地图与归属校验，并同步旧数据库载具驾驶员', async () => {
    const target = vehicle({ id: 42, 编号: 'db-target', vehicleId: 'db-target', 名称: '数据库车', name: '数据库车', mapIndex: 7 });
    const old = vehicle({ id: 41, 编号: 'db-old', vehicleId: 'db-old', 名称: '旧数据库车', name: '旧数据库车', driver: 'qq10', 驾驶员: 'qq10', mapIndex: 7 });
    const { service, player, dbVehicles, dbUpdateCalls, updateCalls } = makeService({
      player: { id: 1, userId: 10, name: '甲', mapId: 7, vehicle: '41', sets: '{}', masterQQ: '' },
      map: { id: 7, mapIndex: 7, name: '医疗室', vehicles: '[]', summons: '[]' },
      dbVehicles: [target, old],
    });

    await service.handleDriveVehicle(10, '42');

    expect(player.vehicle).toBe('42');
    expect(dbVehicles.find((item) => item.id === 42).driver).toBe('qq10');
    expect(dbVehicles.find((item) => item.id === 41).driver).toBe('');
    expect(dbUpdateCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ where: { id: 41 }, data: { driver: '' } }),
      expect.objectContaining({ where: { id: 42 }, data: expect.objectContaining({ driver: 'qq10', mapIndex: 7 }) }),
    ]));
    expect(updateCalls).toHaveLength(0);
  });

  it('脱出会清除地图载具驾驶员并清除玩家载具状态', async () => {
    const { service, player, map, achievements } = makeService({
      player: { id: 1, userId: 10, name: '甲', mapId: 7, vehicle: 'vehicle-1', sets: '{}', masterQQ: '' },
      map: { id: 7, mapIndex: 7, name: '医疗室', vehicles: JSON.stringify([vehicle()]), summons: '[]' },
    });

    const result = await service.handleExitVehicle(10);
    const vehicles = parseValue<any[]>(map.vehicles, []);

    expect(result).toBe('甲离开了测试车(战斗)');
    expect(player.vehicle).toBe('');
    expect(vehicles[0].driver).toBe('');
    // 同上：落库/写回地图只保留规范键
    expect(vehicles[0].驾驶员).toBeUndefined();
    expect(achievements).toContain('脱出');
  });
});

describe('载具状态/命名/架炮（地图 JSON 双存储统一）', () => {
  it('载具状态走地图载具而不是仅 DB parseInt', async () => {
    const { service } = makeService({
      player: { id: 1, userId: 10, name: '甲', mapId: 7, vehicle: 'vehicle-1', sets: '{}', masterQQ: '' },
      map: {
        id: 7, mapIndex: 7, name: '医疗室',
        vehicles: JSON.stringify([{
          名称: '测试车', name: '测试车', 类型: '战斗', type: '战斗',
          编号: 'vehicle-1', vehicleId: 'vehicle-1',
          归属: 'qq10', owner: 'qq10', 驾驶员: 'qq10', driver: 'qq10',
          当前生命: 80, currentHp: 80, 生命: 100, maxHp: 100,
          行走方式: 1, moveType: 1,
          零件: [{ 名称: '骑士核心', name: '骑士核心', 数量: 1, quantity: 1 }],
          配方: [], 加成: { 生命: 100, 攻击: 5 }, 标记: {},
        }]),
        summons: '[]',
      },
    });

    const result = await service.handleVehicleStatus(10);
    expect(result).toContain('测试车');
    expect(result).toContain('驾驶员加成:');
    expect(result).toContain('攻击+5');
  });

  it('载具命名按旧名+新名在当前地图改名', async () => {
    const { service, map, updateCalls } = makeService({
      map: {
        id: 7, mapIndex: 7, name: '医疗室',
        vehicles: JSON.stringify([{
          名称: '骑士', name: '骑士', 编号: 'vehicle-1', vehicleId: 'vehicle-1',
          归属: 'qq10', owner: 'qq10', 零件: [], 配方: [], 加成: {}, 标记2: [],
        }]),
        summons: '[]',
      },
    });

    const result = await service.handleNameVehicle(10, '骑士 坦克');
    expect(result).toBe('甲,骑士名称修改为坦克');
    const vehicles = parseValue<any[]>(map.vehicles, []);
    // 写回地图的载具只有规范键 name（中文镜像 名称 已随口径统一删除）
    expect(vehicles[0].名称).toBeUndefined();
    expect(vehicles[0].name).toBe('坦克');
    expect(updateCalls).toHaveLength(1);
  });

  it('非恶毒玩家不能架炮', async () => {
    const { service } = makeService({
      player: {
        id: 1, userId: 10, name: '甲', mapId: 7, vehicle: '', sets: '{}', masterQQ: '',
        type: '普拉娜',
      },
    });
    const result = await service.handleDeployCannon(10);
    expect(result).toBe('甲这是恶毒的技能');
  });

  it('恶毒架炮切换攻击模式并写回 sets', async () => {
    const { service, player } = makeService({
      player: {
        id: 1, userId: 10, name: '甲', mapId: 7, vehicle: '', sets: '{}', masterQQ: '',
        type: '恶毒', attackMode: 0,
      },
    });

    const deploy = await service.handleDeployCannon(10);
    expect(deploy).toContain('架好了炮击阵地');
    expect(player.attackMode).toBe(1);
    expect(parseValue<any>(player.sets, {}).attackMode).toBe(1);

    const stow = await service.handleDeployCannon(10);
    expect(stow).toContain('收好了炮击阵地');
    expect(player.attackMode).toBe(0);
  });

  it('findVehicleOverLimitPart 识别 partType 而不是 type', () => {
    const { service } = makeService({});
    const over = service.findVehicleOverLimitPart({
      maxFunction: 1,
      maxWeapon: 5,
      maxMove: 5,
      maxDefense: 5,
      parts: [
        { name: '功能A', partType: 4 },
        { name: '功能B', partType: 4 },
      ],
    });
    expect(over).toBe('功能部件');
  });
});

describe('牵引与载具模拟（原版对齐）', () => {
  it('无牵引光束时提示制造', async () => {
    const { service, shortcutService } = makeService({
      player: { id: 1, userId: 10, name: '甲', mapId: 7, vehicle: 'vehicle-1', sets: '{}', masterQQ: '' },
      map: {
        id: 7, mapIndex: 7, name: '医疗室',
        vehicles: JSON.stringify([{
          名称: '测试车', name: '测试车', 编号: 'vehicle-1', vehicleId: 'vehicle-1',
          归属: 'qq10', owner: 'qq10', 驾驶员: 'qq10', driver: 'qq10',
          当前生命: 100, currentHp: 100,
          零件: [{ 名称: '骑士核心', name: '骑士核心', 数量: 1, quantity: 1 }],
          配方: [], 加成: {}, 标记2: [],
        }]),
        summons: '[]',
      },
    });
    const result = await service.handleTractorBeam(10, '货舱');
    expect(result).toContain('需要安装牵引光束或大型牵引光束');
  });

  it('牵引货舱：有牵引光束时从目标地图拉取资源', async () => {
    const cargoMap = {
      id: 9, name: '荒野',
      resources: JSON.stringify([{ name: '货舱', times: 3, outputs: [{ name: '能量块', quantity: 2, chance: 100 }] }]),
      resources2: '[]',
      vehicles: '[]', summons: '[]',
    };
    const { service, player, map } = makeService({
      player: { id: 1, userId: 10, name: '甲', mapId: 7, vehicle: 'vehicle-1', sets: '{}', masterQQ: '', backpack: '[]', markers: '{}', markers2: '[]' },
      map: {
        id: 7, mapIndex: 7, name: '医疗室',
        vehicles: JSON.stringify([{
          名称: '测试车', name: '测试车', 编号: 'vehicle-1', vehicleId: 'vehicle-1',
          归属: 'qq10', owner: 'qq10', 驾驶员: 'qq10', driver: 'qq10',
          当前生命: 100, currentHp: 100,
          零件: [
            { 名称: '骑士核心', name: '骑士核心', 数量: 1, quantity: 1 },
            { 名称: '牵引光束', name: '牵引光束', 数量: 1, quantity: 1 },
          ],
          配方: [], 加成: {}, 标记2: [],
        }]),
        summons: '[]',
      },
      allMaps: [cargoMap, {
        id: 7, name: '医疗室', resources: [], resources2: [], vehicles: '[]', summons: '[]',
      }],
    });

    const result = await service.handleTractorBeam(10, '货舱');
    expect(result).toContain('牵引了货舱');
    const bag = parseValue<any[]>(player.backpack, []);
    expect(bag.find((i: any) => i.name === '能量块')?.quantity).toBeGreaterThan(0);
    // 原版循环直到预算用尽或世界无货舱：3 次货舱被普通光束拉完后资源移除
    const cargo = parseValue<any[]>(cargoMap.resources, []);
    expect(cargo).toHaveLength(0);
  });

  it('载具模拟输出整备详情与消耗材料', async () => {
    const { service } = makeService({});
    const result = await service.handleSimulateVehicle(10, '巡洋舰核心1 牵引光束1');
    expect(result).toContain('巡洋舰核心');
    expect(result).toContain('消耗材料:');
    expect(result).toContain('铁矿');
  });

  it('载具模拟提示核心必须在最前', async () => {
    const { service } = makeService({});
    const result = await service.handleSimulateVehicle(10, '牵引光束1 巡洋舰核心1');
    expect(result).toContain('核心必须在最前面');
  });

  it('载具模拟可一键组装：挂临时输入并提示', async () => {
    const { service, shortcutService } = makeService({});
    const result = await service.handleSimulateVehicle(10, '巡洋舰核心1');
    expect(result).toContain('消耗材料:');
    expect(shortcutService.setTempInput).toHaveBeenCalled();
    const temp = String(shortcutService.setTempInput.mock.calls[0][1]);
    expect(temp).toContain('组装');
    expect(temp).toContain('巡洋舰核心');
  });
});

describe('转换/模式转换（伊芙利特/阿尔缇娜）', () => {
  it('非伊芙利特转换提示专属技能', async () => {
    const { service } = makeService({
      player: {
        id: 1, userId: 10, name: '甲', mapId: 7, vehicle: '', sets: '{}', masterQQ: '',
        type: '普拉娜', specialSeq: 1, affinity: 100,
      },
    });
    const result = await (service as any).skillCommandService.handleTransform(10);
    expect(result).toContain('这是伊芙利特的技能');
  });

  it('伊芙利特好感不足时拦截', async () => {
    const { service } = makeService({
      player: {
        id: 1, userId: 10, name: '甲', mapId: 7, vehicle: '', sets: '{}', masterQQ: '',
        type: '伊芙利特', specialSeq: 11, affinity: 5,
      },
    });
    const result = await (service as any).skillCommandService.handleTransform(10);
    expect(result).toBe('甲需要好感大于等于20');
  });

  it('伊芙利特转换切换炮/斧形态与 attackMode', async () => {
    const { service, player } = makeService({
      player: {
        id: 1, userId: 10, name: '甲', mapId: 7, vehicle: '', sets: '{}', masterQQ: '',
        type: '伊芙利特', specialSeq: 11, affinity: 30, attackMode: 0,
      },
    });
    const cannon = await (service as any).skillCommandService.handleTransform(10);
    expect(cannon).toContain('切换成了炮形态');
    expect(player.attackMode).toBe(1);

    const axe = await (service as any).skillCommandService.handleTransform(10);
    expect(axe).toContain('切换成了斧形态');
    expect(player.attackMode).toBe(0);
  });

  it('模式转换带参数时提示阿尔缇娜专属', async () => {
    const { service } = makeService({
      player: {
        id: 1, userId: 10, name: '甲', mapId: 7, vehicle: '', sets: '{}', masterQQ: '',
        type: '普拉娜',
      },
    });
    const result = await (service as any).skillCommandService.handleModeChange(10, '战斗');
    expect(result).toContain('这是阿尔缇娜的技能');
  });

  it('转换文本查看他人背包条目', async () => {
    const { service, prisma } = makeService({});
    prisma.player.findFirst = jest.fn(async () => ({
      name: '乙',
      backpack: JSON.stringify([{ name: '生肉', type: '资源', quantity: 3 }]),
    }));
    const result = await (service as any).skillCommandService.handleTransformText(10, '乙 1');
    expect(result).toContain('生肉');
  });
});
