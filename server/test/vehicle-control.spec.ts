import { GameService } from '../src/modules/game/game.service';

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
      if (userId === player.userId) return { player };
      const previous = previousPlayers.get(userId);
      return previous ? { player: previous } : { player: null };
    }),
    savePlayer: jest.fn(async (value: any) => { savedPlayers.push(value); }),
    safeJsonParse: jest.fn(parseValue),
  };
  const mapService: any = {
    getMapById: jest.fn(async () => map),
    updateDynamicFields: jest.fn(async (_mapId: number, data: any) => {
      updateCalls.push(data);
      Object.assign(map, data);
    }),
  };
  const achievementService: any = {
    addAchievement: jest.fn(async (_player: any, name: string) => { achievements.push(name); }),
    getAchievement: jest.fn(() => 0),
    setAchievement: jest.fn(),
  };
  const taskService: any = { advance: jest.fn(async () => '') };
  const placeholder = {} as any;

  const service = new GameService(
    prisma,
    playerService,
    {} as any,
    {} as any,
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
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    taskService,
    {} as any,
    {} as any,
    {} as any,
  );

  return { service, player, map, dbVehicles, previousPlayers, updateCalls, dbUpdateCalls, savedPlayers, achievements };
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
    const vehicles = JSON.parse(map.vehicles);

    expect(result).toContain('获取了无主车的权限');
    expect(player.vehicle).toBe('new-vehicle');
    expect(parseValue<any>(player.sets, {})).toEqual({ takeVehicle: '', 接管载具: '' });
    expect(vehicles[0].driver).toBe('');
    expect(vehicles[0].驾驶员).toBe('');
    expect(vehicles[1].owner).toBe('qq10');
    expect(vehicles[1].归属).toBe('qq10');
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

    const vehicles = JSON.parse(map.vehicles);
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
    const vehicles = JSON.parse(map.vehicles);

    expect(result).toBe('甲离开了测试车(战斗)');
    expect(player.vehicle).toBe('');
    expect(vehicles[0].driver).toBe('');
    expect(vehicles[0].驾驶员).toBe('');
    expect(achievements).toContain('脱出');
  });
});
