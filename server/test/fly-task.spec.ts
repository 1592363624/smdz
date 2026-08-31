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
    isPlayerDead: jest.fn(() => false),
    savePlayer: jest.fn(async (value: any) => saved.push(value)),
    handlePlayerDeath: jest.fn(),
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
    combatSystem: { applyMapBuffs: jest.fn(async () => undefined) },
    achievementService: { addAchievement: jest.fn(async () => undefined) },
    chatService: { broadcastSystem: jest.fn(async () => undefined), emitToUser: jest.fn() },
    logger: { log: jest.fn(), warn: jest.fn() },
    scheduleArrival: jest.fn((userId: number, mapId: number, name: string, seconds: number) => {
      scheduled.push({ userId, mapId, name, seconds });
    }),
  });
  return { service, player, currentMap, targetMap, saved, scheduled, playerService, mapService: service.mapService };
}

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
    expect(JSON.parse(fixture.player.markers)['移动中']).toContain('飞行');
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
