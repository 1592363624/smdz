import { GameService } from '../src/modules/game/game.service';

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

function makeService(options: {
  player?: any;
  currentMap?: any;
  targetMap?: any;
  timeIntervalRequire?: (name: string, seconds: number, markers: any[], now: number, text: { value: string }) => boolean;
}) {
  const player = options.player || {
    id: 1,
    userId: 42,
    name: '冒险者',
    mapId: 7,
    markers: '{}',
    markers2: '[]',
    equipment: '[]',
    weapons: '[]',
    sets: '{}',
    vehicle: '',
    hp: 100,
  };
  const currentMap = options.currentMap || {
    id: 7,
    name: '当前地图',
    noTeleport: false,
    isFrontier: false,
    vehicles: '[]',
    summons: '[]',
  };
  const targetMap = options.targetMap || {
    id: 8,
    name: '目标地图',
    noTeleport: false,
    isFrontier: false,
    vehicles: '[]',
    summons: '[]',
  };
  const saved: any[] = [];
  const scheduled: any[] = [];
  const playerService: any = {
    getPlayerData: jest.fn(async () => ({
      player,
      markers: parseJson(player.markers, {}),
      markers2: parseJson(player.markers2, []),
      equipment: parseJson(player.equipment, []),
      weapons: parseJson(player.weapons, []),
    })),
    safeJsonParse: jest.fn(parseJson),
    getMarkerValue: jest.fn((markers: any, key: string) => Number(markers?.[key] ?? 0)),
    isPlayerDead: jest.fn(() => false),
    savePlayer: jest.fn(async (value: any) => saved.push(value)),
    handlePlayerDeath: jest.fn(),
    // performArrival 自串行（支柱二）：入口统一过用户级串行邮箱，桩直通
    enqueueUserWrite: jest.fn(async (_uid: number, fn: () => Promise<any>) => fn()),
  };
  const service: any = Object.create(GameService.prototype);
  Object.assign(service, {
    prisma: {},
    playerService,
    mapService: {
      getMapById: jest.fn(async (id: number) => Number(id) === currentMap.id ? currentMap : targetMap),
      getMapByName: jest.fn(async (name: string) => name === targetMap.name ? targetMap : null),
      getAllMaps: jest.fn(async () => [currentMap, targetMap]),
      getConnections: jest.fn((map: any) => parseJson(map?.connections, [])),
      calcTravelTime: jest.fn(() => 1),
      getMapMonsters: jest.fn(async () => []),
      checkCanTravel: jest.fn(() => ({ canTravel: true })),
    },
    combatState: {
      markerRequire: jest.fn(() => false),
      timeIntervalRequire: jest.fn(options.timeIntervalRequire || (() => false)),
    },
    taskService: { advance: jest.fn(async () => ''), consumeNotifications: jest.fn(() => '') },
    shortcutService: { setTempInput: jest.fn(async () => undefined) },
    systemConfigService: { get: jest.fn(async () => true) },
    combatSystem: {
      applyMapBuffs: jest.fn(async () => undefined),
      // 行动无限制（原版 L6514）：默认不受限
      actionUnrestricted: jest.fn(() => ({ restricted: false })),
    },
    achievementService: { addAchievement: jest.fn(async () => undefined) },
    chatService: { broadcastSystem: jest.fn(async () => undefined), emitToUser: jest.fn() },
    logger: { log: jest.fn(), warn: jest.fn() },
    scheduleArrival: jest.fn((userId: number, mapId: number, name: string, seconds: number) => {
      scheduled.push({ userId, mapId, name, seconds });
    }),
  });
  return { service, player, currentMap, targetMap, saved, scheduled, playerService, mapService: service.mapService };
}

describe('前往门禁（原版 _主程序.ecode L6514-6548 复刻）', () => {
  afterEach(() => jest.restoreAllMocks());

  function makeMoveService(options: { player?: any; currentMap?: any; mapMonsters?: any[] } = {}) {
    const fixture = makeService({
      player: options.player,
      currentMap: options.currentMap,
    });
    fixture.service.mapService.getMapMonsters = jest.fn(async () => options.mapMonsters || []);
    return fixture;
  }

  it('行动无限制受限时不发起移动', async () => {
    const fixture = makeMoveService({});
    fixture.service.combatSystem.actionUnrestricted.mockReturnValue({
      restricted: true, text: '冒险者复活中',
    });

    const result = await fixture.service.handleMove(42, '目标地图');

    expect(result).toContain('复活中');
    expect(fixture.scheduled).toHaveLength(0);
  });

  it('关卡图有怪时拦截前往', async () => {
    const fixture = makeMoveService({
      currentMap: {
        id: 7, name: '关卡地图', 关卡: 1, noTeleport: false, isFrontier: false,
        vehicles: '[]', summons: '[]',
      },
      mapMonsters: [{ id: 1, name: '守关怪' }],
    });

    const result = await fixture.service.handleMove(42, '目标地图');

    expect(result).toContain('需要清除附近的目标');
    expect(fixture.scheduled).toHaveLength(0);
  });

  it('关卡图有怪但目标为“出口”时不被关卡门禁拦截', async () => {
    const fixture = makeMoveService({
      currentMap: {
        id: 7, name: '关卡地图', 关卡: 1, noTeleport: false, isFrontier: false,
        vehicles: '[]', summons: '[]',
      },
      mapMonsters: [{ id: 1, name: '守关怪' }],
    });

    const result = await fixture.service.handleMove(42, '出口');

    expect(result).not.toContain('需要清除附近的目标');
  });

  it('空参返回编号菜单：家园房子首位+非开拓地地图+临时输入替换', async () => {
    const fixture = makeMoveService({
      player: {
        id: 1, userId: 42, name: '冒险者', mapId: 7, markers: '{"家园进度":1}',
        markers2: '[]', equipment: '[]', weapons: '[]', sets: '{}', vehicle: '',
        hp: 100, houseName: '我的房子',
      },
    });
    fixture.service.mapService.getAllMaps.mockResolvedValue([
      { id: 7, name: '当前地图', 开拓地: false },
      { id: 9, name: '别人家', 开拓地: true },
      { id: 8, name: '目标地图', 开拓地: false },
    ]);

    const result = await fixture.service.handleMove(42, '');

    expect(result).toContain('请选择地点');
    expect(result).toContain('1、我的房子');
    expect(result).toContain('3、目标地图');
    expect(result).not.toContain('别人家');
    const tempArg = fixture.service.shortcutService.setTempInput.mock.calls[0][1];
    expect(tempArg).toContain('1@前往我的房子');
    expect(tempArg).toContain('3@前往目标地图');
    expect(fixture.scheduled).toHaveLength(0);
  });

  it('战斗标记中且本图有怪时拦截前往', async () => {
    const fixture = makeMoveService({
      mapMonsters: [{ id: 1, name: '野怪' }],
    });
    fixture.service.combatState.markerRequire.mockImplementation((name: string, _m: any, text: any) => {
      if (name === '战斗') {
        text.value = '（战斗中）';
        return true;
      }
      return false;
    });

    const result = await fixture.service.handleMove(42, '目标地图');

    expect(result).toContain('战斗状态');
    expect(fixture.scheduled).toHaveLength(0);
  });
});

describe('飞行任务动作', () => {
  afterEach(() => jest.restoreAllMocks());

  it('成功起飞时记录移动状态并安排到达，不在业务层重复推进任务', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.99);
    const fixture = makeService({});

    const result = await fixture.service.handleFlyTo(42, '目标地图');

    expect(result).toContain('飞了起来');
    expect(fixture.service.taskService.advance).not.toHaveBeenCalled();
    expect(fixture.scheduled).toEqual([
      { userId: 42, mapId: 8, name: '目标地图', seconds: 10 },
    ]);
    expect(parseJson(fixture.player.markers, {})['移动中']).toContain('飞行');
    expect(fixture.saved).toHaveLength(1);
  });

  it('飞行冷却中不安排到达，也不留下新的移动状态', async () => {
    const fixture = makeService({
      timeIntervalRequire: (_name, _seconds, _markers, _now, text) => {
        text.value = '还需要9秒';
        return true;
      },
    });

    const result = await fixture.service.handleFlyTo(42, '目标地图');

    expect(result).toContain('还需要9秒');
    expect(fixture.scheduled).toHaveLength(0);
    expect(fixture.player.markers).toBe('{}');
  });

  it('驾驶只能前往的载具时拒绝飞行', async () => {
    const fixture = makeService({
      player: {
        id: 1,
        userId: 42,
        name: '冒险者',
        mapId: 7,
        markers: '{}',
        markers2: '[]',
        equipment: '[]',
        weapons: '[]',
        sets: '{}',
        vehicle: 'v1',
        hp: 100,
      },
      currentMap: {
        id: 7,
        name: '当前地图',
        noTeleport: false,
        isFrontier: false,
        vehicles: JSON.stringify([{ id: 'v1', name: '履带车', moveType: 1 }]),
        summons: '[]',
      },
    });

    const result = await fixture.service.handleFlyTo(42, '目标地图');

    expect(result).toContain('只能使用“前往”');
    expect(fixture.scheduled).toHaveLength(0);
    expect(fixture.saved).toHaveLength(0);
  });

  it('重复到达同一目标时只推进一次前往任务', async () => {
    const fixture = makeService({});
    fixture.player.markers = JSON.stringify({
      移动中: JSON.stringify({ targetMapId: 8, targetName: '目标地图', arriveAt: Date.now() - 1 }),
    });

    const first = await fixture.service.performArrival(42, 8, '目标地图');
    const second = await fixture.service.performArrival(42, 8, '目标地图');

    expect(first).toContain('目标地图');
    expect(second).toContain('已经在');
    expect(fixture.service.taskService.advance).toHaveBeenCalledTimes(1);
    expect(fixture.service.taskService.advance).toHaveBeenCalledWith(42, '前往目标地图');
  });

  it('普通移动在开始时按最短路径长度推进移动，到达时推进具体地图任务', async () => {
    const fixture = makeService({
      currentMap: {
        id: 7,
        name: '当前地图',
        noTeleport: false,
        isFrontier: false,
        connections: JSON.stringify([{ name: '中转地图', distance: 10 }]),
        vehicles: '[]',
        summons: '[]',
      },
      targetMap: {
        id: 8,
        name: '目标地图',
        noTeleport: false,
        isFrontier: false,
        connections: '[]',
        vehicles: '[]',
        summons: '[]',
      },
    });
    const relayMap = {
      id: 9,
      name: '中转地图',
      connections: JSON.stringify([{ name: '目标地图', distance: 10 }]),
    };
    fixture.mapService.getAllMaps.mockResolvedValue([fixture.currentMap, relayMap, fixture.targetMap]);

    const result = await fixture.service.handleMove(42, '目标地图');

    expect(result).toContain('开始前往');
    expect(fixture.service.taskService.advance).toHaveBeenCalledWith(42, '移动', 3);

    await fixture.service.performArrival(42, 8, '目标地图');
    expect(fixture.service.taskService.advance).toHaveBeenCalledWith(42, '前往目标地图');
    expect(fixture.service.taskService.advance.mock.calls.filter((call: any[]) => call[1] === '移动')).toHaveLength(1);
  });
});
