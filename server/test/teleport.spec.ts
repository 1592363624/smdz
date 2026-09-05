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
  mapMonsters?: any[];
  timeIntervalRequire?: (name: string, seconds: number) => boolean;
}) {
  const player = options.player || {
    id: 1,
    userId: 42,
    name: '冒险者',
    mapId: 7,
    markers: '{}',
    markers2: '[]',
    equipment: JSON.stringify([{ name: '天蓝吊坠' }]),
    weapons: '[]',
    sets: '{}',
    vehicle: '',
    hp: 100,
    houseName: '',
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
    getMarkerValue: jest.fn((markers: any, key: string) => Number(markers?.[key] ?? 0)),
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
      getMapMonsters: jest.fn(async () => options.mapMonsters || []),
      checkCanTravel: jest.fn(() => ({ canTravel: true })),
    },
    combatState: {
      markerRequire: jest.fn(() => false),
      timeIntervalRequire: jest.fn((_name: string, _seconds: number) =>
        options.timeIntervalRequire ? options.timeIntervalRequire(_name, _seconds) : false),
    },
    combatSystem: {
      applyMapBuffs: jest.fn(async () => undefined),
      actionUnrestricted: jest.fn(() => ({ restricted: false })),
      triggerMapBattleLoop: jest.fn(async () => undefined),
      weaponAttack: jest.fn(async () => ({ result: '【旗舰跃迁】命中全体目标' })),
    },
    familiarSystemService: { canFreeTeleport: jest.fn(async () => false) },
    taskService: { advance: jest.fn(async () => ''), consumeNotifications: jest.fn(() => '') },
    shortcutService: { setTempInput: jest.fn(async () => undefined) },
    logger: { log: jest.fn(), warn: jest.fn() },
  });
  // 内部到达链打桩：观测地图/剪毛/资产迁移/观察附近/跟随显示均为独立重逻辑，
  // 本套件只验证传送自身的门禁与文本分支。
  service.applyArrivalTriggers = jest.fn(async () => '');
  service.migratePlayerAssetsOnMove = jest.fn(async () => undefined);
  service.handleLookAround = jest.fn(async () => '👀 【目标地图】附近情况');
  service.summonFollowDisplay = jest.fn(async () => ({ names: [], count: 0, indexes: [] }));
  return { service, player, currentMap, targetMap, saved, playerService };
}

describe('传送/跃迁（原版 L1676-1808 复刻）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('无载具+天蓝吊坠：立即落地、分子重组文本、推进前往/传送成就并加活跃度', async () => {
    const fixture = makeService({});

    const result = await fixture.service.handleTeleport(42, '目标地图');

    expect(result).toContain('在目标地图完成了分子重组');
    expect(fixture.service.taskService.advance).toHaveBeenCalledWith(42, '前往目标地图');
    expect(fixture.service.taskService.advance).toHaveBeenCalledWith(42, '传送');
    expect(fixture.service.migratePlayerAssetsOnMove).toHaveBeenCalled();
    const savedOnce = fixture.saved[fixture.saved.length - 1];
    expect(Number(parseJson(savedOnce.markers, {})['活跃度'])).toBe(1);
    expect(fixture.player.mapId).toBe(8);
  });

  it('无吊坠且军姬不可免费传送时拒绝', async () => {
    const fixture = makeService({
      player: {
        id: 1, userId: 42, name: '冒险者', mapId: 7, markers: '{}', markers2: '[]',
        equipment: '[]', weapons: '[]', sets: '{}', vehicle: '', hp: 100, houseName: '',
      },
    });
    fixture.service.familiarSystemService.canFreeTeleport.mockResolvedValue(false);

    const result = await fixture.service.handleTeleport(42, '目标地图');

    expect(result).toContain('需要装备“天蓝吊坠”');
    expect(fixture.service.taskService.advance).not.toHaveBeenCalled();
  });

  it('驾驶可跃运载具（行走方式3）时返回跃迁文本并推进跃迁成就', async () => {
    const fixture = makeService({
      player: {
        id: 1, userId: 42, name: '冒险者', mapId: 7, markers: '{}', markers2: '[]',
        equipment: '[]', weapons: '[]', sets: '{}', vehicle: 'v1', hp: 100, houseName: '',
      },
      currentMap: {
        id: 7, name: '当前地图', noTeleport: false, isFrontier: false,
        vehicles: JSON.stringify([{ id: 'v1', name: '跃迁艇', moveType: 3 }]),
        summons: '[]',
      },
    });

    const result = await fixture.service.handleTeleport(42, '目标地图');

    expect(result).toContain('跃迁到了目标地图');
    expect(fixture.service.taskService.advance).toHaveBeenCalledWith(42, '跃迁');
  });

  it('行走方式2的载具只能前往或飞到，不能传送', async () => {
    const fixture = makeService({
      player: {
        id: 1, userId: 42, name: '冒险者', mapId: 7, markers: '{}', markers2: '[]',
        equipment: '[]', weapons: '[]', sets: '{}', vehicle: 'v1', hp: 100, houseName: '',
      },
      currentMap: {
        id: 7, name: '当前地图', noTeleport: false, isFrontier: false,
        vehicles: JSON.stringify([{ id: 'v1', name: '两栖车', moveType: 2 }]),
        summons: '[]',
      },
    });

    const result = await fixture.service.handleTeleport(42, '目标地图');

    expect(result).toContain('只能使用“前往”或者“飞到”来移动');
  });

  it('本图有怪且处于战斗标记时拦截传送', async () => {
    const fixture = makeService({
      mapMonsters: [{ id: 1, name: '野怪' }],
    });
    fixture.service.combatState.markerRequire.mockImplementation((name: string, _m: any, text: any) => {
      if (name === '战斗') {
        text.value = '（战斗中）';
        return true;
      }
      return false;
    });

    const result = await fixture.service.handleTeleport(42, '目标地图');

    expect(result).toContain('战斗状态');
    expect(fixture.service.migratePlayerAssetsOnMove).not.toHaveBeenCalled();
  });

  it('空参返回编号菜单并把家园房子与地图写入临时输入替换', async () => {
    const fixture = makeService({
      player: {
        id: 1, userId: 42, name: '冒险者', mapId: 7, markers: '{"家园进度":1}', markers2: '[]',
        equipment: JSON.stringify([{ name: '天蓝吊坠' }]), weapons: '[]', sets: '{}',
        vehicle: '', hp: 100, houseName: '我的房子',
      },
    });

    const result = await fixture.service.handleTeleport(42, '');

    expect(result).toContain('1、我的房子');
    // 原版菜单不排除当前地图（L1716-1723 只过滤 不可传送/开拓地）
    expect(result).toContain('2、当前地图');
    expect(result).toContain('3、目标地图');
    const tempArg = fixture.service.shortcutService.setTempInput.mock.calls[0][1];
    expect(tempArg).toContain('1@传送我的房子');
    expect(tempArg).toContain('3@传送目标地图');
  });

  it('驾驶装有旗舰跃迁引擎的载具跃迁到有怪地图时触发200%倍率必中攻击', async () => {
    const fixture = makeService({
      player: {
        id: 1, userId: 42, name: '冒险者', mapId: 7, markers: '{}', markers2: '[]',
        equipment: '[]', weapons: '[]', sets: '{}', vehicle: 'v1', hp: 100, houseName: '',
        currentWeapon: 2,
      },
      currentMap: {
        id: 7, name: '当前地图', noTeleport: false, isFrontier: false,
        vehicles: JSON.stringify([{ id: 'v1', name: '旗舰', moveType: 3, parts: [{ name: '旗舰跃迁引擎' }] }]),
        summons: '[]',
      },
      targetMap: {
        id: 8, name: '目标地图', noTeleport: false, isFrontier: false,
        vehicles: '[]', summons: '[]',
      },
      mapMonsters: [],
    });
    // 目的地有怪（跃迁引擎分支读取的是目标地图怪物）
    fixture.service.mapService.getMapMonsters.mockImplementation(async (map: any) =>
      Number(map?.id) === 8 ? [{ id: 9, name: '据点怪' }] : []);

    const result = await fixture.service.handleTeleport(42, '目标地图');

    expect(result).toContain('跃迁到了目标地图');
    expect(fixture.service.combatSystem.weaponAttack).toHaveBeenCalledWith(42, 2, expect.objectContaining({
      damageMultiplier: 200,
      mustHit: true,
      allAttack: true,
      attackText: '旗舰跃迁a',
    }));
    expect(result).toContain('【旗舰跃迁】命中全体目标');
    expect(fixture.service.combatSystem.triggerMapBattleLoop).toHaveBeenCalledWith(42, 5, expect.anything());
  });
});
