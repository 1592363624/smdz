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
  map?: any;
  inMapBattle?: boolean;
} = {}) {
  const player: any = options.player || {
    id: 1,
    userId: 42,
    name: '冒险者',
    mapId: 7,
    markers: '{}',
    markers2: '[]',
    vehicle: 'v1',
    hp: 100,
  };
  const map: any = options.map || {
    id: 7,
    name: '当前地图',
    markers2: '[]',
    monsters: '[]',
    vehicles: JSON.stringify([
      { id: 'v1', name: '越野车', type: '载具', 当前生命: 30, 加成: { 生命: 100 }, parts: [] },
    ]),
    summons: '[]',
  };
  const scheduled: any[] = [];
  const savedPlayers: any[] = [];
  const service: any = Object.create(GameService.prototype);
  Object.assign(service, {
    prisma: {},
    playerService: {
      getPlayerData: jest.fn(async () => ({
        player,
        markers: parseJson(player.markers, {}),
        markers2: parseJson(player.markers2, []),
        backpack: [],
        equipment: [],
        weapons: [],
      })),
      isPlayerDead: jest.fn(() => false),
      savePlayer: jest.fn(async (value: any) => savedPlayers.push(value)),
      handlePlayerDeath: jest.fn(() => '你死了'),
      enqueueUserWrite: jest.fn(async (_uid: number, fn: () => Promise<any>) => fn()),
    },
    mapService: {
      getMapById: jest.fn(async () => map),
      getMapMonsters: jest.fn(async () => []),
      updateDynamicFields: jest.fn(async (_id: number, patch: any) => {
        if (patch.vehicles) map.vehicles = JSON.stringify(patch.vehicles);
      }),
    },
    combatState: {
      buffRequire: jest.fn(() => options.inMapBattle ?? false),
      addMarker: jest.fn((name: string, seconds: number, markers: any[]) => {
        markers.push({ name, expireAt: Date.now() + seconds * 1000 });
      }),
    },
    combatSystem: {
      actionUnrestricted: jest.fn(() => ({ restricted: false })),
      recalculateVehicle: jest.fn((vehicle: any) => {
        vehicle.加成 = { 生命: 100 };
        return vehicle;
      }),
      triggerMapBattleLoop: jest.fn(async () => undefined),
    },
    taskService: { advance: jest.fn(async () => ''), consumeNotifications: jest.fn(() => '') },
    delayedTaskService: {
      schedule: jest.fn(async (input: any) => {
        scheduled.push(input);
      }),
    },
    chatService: { broadcastSystem: jest.fn(async () => undefined) },
    logger: { log: jest.fn(), warn: jest.fn() },
  });
  return { service, player, map, scheduled, savedPlayers };
}

describe('维修载具延时链（原版 L10397-10495 复刻）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('未驾驶载具时拒绝维修', async () => {
    const fixture = makeService({
      player: { id: 1, userId: 42, name: '冒险者', mapId: 7, markers: '{}', markers2: '[]', vehicle: '', hp: 100 },
    });

    const result = await fixture.service.handleRepairVehicle(42, '');

    expect(result).toContain('没有在驾驶载具');
    expect(fixture.scheduled).toHaveLength(0);
  });

  it('满血载具提示还不需要修', async () => {
    const fixture = makeService({
      map: {
        id: 7, name: '当前地图', markers2: '[]',
        vehicles: JSON.stringify([{ id: 'v1', name: '越野车', type: '载具', 当前生命: 100, 加成: { 生命: 100 }, parts: [] }]),
      },
    });

    const result = await fixture.service.handleRepairVehicle(42, '');

    expect(result).toContain('还不需要修');
    expect(fixture.scheduled).toHaveLength(0);
  });

  it('无减时部件：写工作20秒标记并排程维修延时', async () => {
    const fixture = makeService();

    const result = await fixture.service.handleRepairVehicle(42, '');

    expect(result).toContain('正在维修越野车,大概需要20秒');
    const markers2 = parseJson(fixture.player.markers2, []);
    expect(markers2.some((m: any) => m.name === '工作')).toBe(true);
    expect(fixture.scheduled).toHaveLength(1);
    expect(fixture.scheduled[0]).toMatchObject({ type: 'repair', userId: 42 });
    expect(fixture.service.taskService.advance).not.toHaveBeenCalled();
  });

  it('装齐小雫/小凰/小蓝/小粉：20-20=0 立即修好并推进维修载具成就', async () => {
    const fixture = makeService({
      map: {
        id: 7, name: '当前地图', markers2: '[]',
        vehicles: JSON.stringify([{
          id: 'v1', name: '越野车', type: '载具', 当前生命: 30, 加成: { 生命: 100 },
          parts: [{ name: '小雫', type: 4 }, { name: '小凰', type: 4 }, { name: '小蓝', type: 4 }, { name: '小粉', type: 4 }],
        }]),
      },
    });

    const result = await fixture.service.handleRepairVehicle(42, '');

    expect(result).toContain('用0载具零件修好了越野车（载具）');
    expect(fixture.service.taskService.advance).toHaveBeenCalledWith(42, '维修载具');
    expect(fixture.scheduled).toHaveLength(0);
    const vehicles = parseJson(fixture.map.vehicles, []);
    expect(Number(vehicles[0].当前生命)).toBe(100);
  });

  it('维修 wcc1 延时结算分支：修好当前驾驶的载具', async () => {
    const fixture = makeService();

    const result = await fixture.service.handleRepairVehicle(42, 'wcc1');

    expect(result).toContain('用0载具零件修好了越野车（载具）');
    expect(fixture.service.taskService.advance).toHaveBeenCalledWith(42, '维修载具');
  });

  it('地图战斗中且有怪时拦截维修', async () => {
    const fixture = makeService({ inMapBattle: true });
    fixture.service.mapService.getMapMonsters.mockResolvedValue([{ id: 1, name: '野怪' }]);

    const result = await fixture.service.handleRepairVehicle(42, '');

    expect(result).toContain('当前地图正在战斗中');
    expect(fixture.scheduled).toHaveLength(0);
  });
});
