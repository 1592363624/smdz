import { GameService } from '../src/modules/game/game.service';

function parseJson(value: any, fallback: any): any {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function makeService(options: {
  player: any;
  map: any;
  otherPlayers?: any[];
  allMaps?: any[];
}) {
  const player = options.player;
  const map = options.map;
  const otherPlayers = options.otherPlayers ?? [];
  const allMaps = options.allMaps ?? [map];
  const savedPlayers: any[] = [];
  const updates: any[] = [];
  const taskService = { advance: jest.fn(async () => '') };
  const playerService: any = {
  enqueueUserWrite: jest.fn((userId: number, fn: () => any) => fn()),
    getPlayerData: jest.fn(async (userId: number) => {
      if (Number(userId) === Number(player.userId)) {
        return {
          player,
          markers2: parseJson(player.markers2, []),
          buffs: parseJson(player.buffs, []),
        };
      }
      const target = otherPlayers.find((item) => Number(item.userId) === Number(userId));
      return target
        ? { player: target, markers2: parseJson(target.markers2, []), buffs: parseJson(target.buffs, []) }
        : { player: null, markers2: [], buffs: [] };
    }),
    safeJsonParse: jest.fn(parseJson),
    isPlayerDead: jest.fn((target: any) => Number(target?.hp || 0) <= 0),
    savePlayer: jest.fn(async (target: any) => savedPlayers.push(target)),
  };
  const mapService: any = {
    getMapById: jest.fn(async (mapId: number) =>
      allMaps.find((item) => Number(item.id) === Number(mapId)) || null),
    getMapByName: jest.fn(async (name: string) =>
      allMaps.find((item) => item.name === name) || null),
    getAllMaps: jest.fn(async () => allMaps),
    updateDynamicFields: jest.fn(async (_mapId: number, data: any) => {
      updates.push(data);
      Object.assign(map, data);
    }),
  };
  const prisma: any = {
    player: {
      findMany: jest.fn(async () => [player, ...otherPlayers]),
    },
  };
  const chatService = { broadcastSystem: jest.fn(async () => undefined) };
  const service: any = Object.create(GameService.prototype);
  Object.assign(service, {
    prisma,
    playerService,
    mapService,
    taskService,
    rescueTimers: new Map<number, NodeJS.Timeout>(),
    chatService,
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
  });
  // 自救「白」传送用例只关心目标地图的选择；真实移动链路由移动相关测试覆盖。
  service.performArrival = jest.fn(async (_userId: number, targetMapId: number, targetMapName: string) => {
    player.mapId = Number(targetMapId);
    return `你来到了【${targetMapName}】`;
  });
  return { service, player, map, taskService, playerService, updates, savedPlayers, chatService };
}

describe('扶、救助、复活使魔社交救援流程', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('扶会锁定同地图卷土重来玩家，5秒后恢复半血并推进救助任务', async () => {
    const helper = {
      id: 1, userId: 1, name: '甲', mapId: 7, hp: 100, maxHp: 100, markers2: '[]', buffs: '[]',
    };
    const target = {
      id: 2, userId: 2, name: '乙', mapId: 7, hp: 100, maxHp: 100,
      buffs: JSON.stringify([{ name: '卷土重来', expireAt: 1100 }]),
    };
    const fixture = makeService({
      player: helper,
      otherPlayers: [target],
      map: { id: 7, name: '医疗室', summons: '[]', vehicles: '[]' },
    });

    await expect(fixture.service.handleHelpUp(1)).resolves.toContain('正在救助玩家');
    expect(fixture.taskService.advance).toHaveBeenCalledWith(1, '救助');
    expect(JSON.parse(helper.markers2)).toEqual([
      expect.objectContaining({ name: '工作', rescueType: 'player', expireAt: 1005 }),
    ]);

    await jest.advanceTimersByTimeAsync(5_000);

    expect(target.hp).toBe(50);
    expect(JSON.parse(target.buffs)).toEqual([{ name: '卷土重来', expireAt: 1070 }]);
    expect(JSON.parse(helper.markers2)).toEqual([]);
  });

  it('救助会复活倒地使魔并修复其绑定载具', async () => {
    const player = {
      id: 1, userId: 1, name: '甲', mapId: 7, hp: 100, maxHp: 100, markers2: '[]',
    };
    const map = {
      id: 7,
      name: '医疗室',
      summons: JSON.stringify([{ name: '小白', qq: 'pet-1', hp: 0, maxHp: 100, vehicle: 'v-1' }]),
      vehicles: JSON.stringify([{ id: 'v-1', name: '战车', currentHp: 20, maxHp: 100 }]),
    };
    const fixture = makeService({ player, map });

    await expect(fixture.service.handleRescue(1)).resolves.toContain('正在抢救小白');
    expect(fixture.taskService.advance).toHaveBeenCalledWith(1, '救助');

    await jest.advanceTimersByTimeAsync(30_000);

    const summons = JSON.parse(map.summons);
    const vehicles = JSON.parse(map.vehicles);
    expect(summons[0].hp).toBe(1);
    expect(vehicles[0].currentHp).toBe(100);
    expect(JSON.parse(player.markers2)).toEqual([]);
    expect(fixture.updates).toEqual([
      expect.objectContaining({ summons: expect.any(String), vehicles: expect.any(String) }),
    ]);
  });

  it('没有倒地使魔时，救助会维修绑定载具', async () => {
    const player = {
      id: 1, userId: 1, name: '甲', mapId: 7, hp: 100, maxHp: 100, markers2: '[]',
    };
    const map = {
      id: 7,
      name: '医疗室',
      summons: JSON.stringify([{ name: '小白', qq: 'pet-1', hp: 100, maxHp: 100, vehicle: 'v-1' }]),
      vehicles: JSON.stringify([{ id: 'v-1', name: '战车', currentHp: 0, maxHp: 100 }]),
    };
    const fixture = makeService({ player, map });

    await expect(fixture.service.handleRescue(1)).resolves.toContain('维修载具中');
    await jest.advanceTimersByTimeAsync(30_000);

    expect(JSON.parse(map.vehicles)[0].currentHp).toBe(100);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(1, '救助');
  });

  it('复活使魔只允许倒地玩家使用，30秒后恢复半血并清除救援标记', async () => {
    const player = {
      id: 1, userId: 1, name: '甲', mapId: 7, hp: 0, maxHp: 120, shield: 10, armor: 10, markers2: '[]',
    };
    const fixture = makeService({
      player,
      map: { id: 7, name: '医疗室', summons: '[]', vehicles: '[]' },
    });

    await expect(fixture.service.handleReviveFamiliar(1)).resolves.toContain('正在抢救中');
    expect(JSON.parse(player.markers2)).toEqual([
      expect.objectContaining({ name: '复活', rescueType: 'self', expireAt: 1030 }),
    ]);

    await jest.advanceTimersByTimeAsync(30_000);

    expect(player.hp).toBe(60);
    expect(player.shield).toBe(0);
    expect(player.armor).toBe(0);
    expect(JSON.parse(player.markers2)).toEqual([]);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(1, '复活');
  });

  it('救助在玩家自己倒地时退化为自救，30秒后恢复半血', async () => {
    const player = {
      id: 1, userId: 1, name: '甲', mapId: 7, hp: 0, maxHp: 120, shield: 5, armor: 5,
      markers2: '[]',
    };
    const fixture = makeService({
      player,
      map: { id: 7, name: '医疗室', summons: '[]', vehicles: '[]' },
    });

    // 死亡门禁引导玩家使用「救助」复活，必须能真正启动自救而不是提示没有宠物。
    await expect(fixture.service.handleRescue(1)).resolves.toContain('正在抢救中');
    expect(JSON.parse(player.markers2)).toEqual([
      expect.objectContaining({ name: '复活', rescueType: 'self', expireAt: 1030 }),
    ]);

    await jest.advanceTimersByTimeAsync(30_000);

    expect(player.hp).toBe(60);
    expect(player.shield).toBe(0);
    expect(player.armor).toBe(0);
    expect(JSON.parse(player.markers2)).toEqual([]);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(1, '复活');
  });

  it('倒地时地图上即使有死亡宠物，救助也优先自救', async () => {
    const player = {
      id: 1, userId: 1, name: '甲', mapId: 7, hp: 0, maxHp: 100, markers2: '[]',
    };
    const map = {
      id: 7,
      name: '医疗室',
      summons: JSON.stringify([{ name: '小白', qq: 'pet-1', hp: 0, maxHp: 100 }]),
      vehicles: '[]',
    };
    const fixture = makeService({ player, map });

    // 死亡提示引导玩家用「救助」复活自己，因此倒地时自救优先于抢救宠物。
    await expect(fixture.service.handleRescue(1)).resolves.toContain('正在抢救中');
    await jest.advanceTimersByTimeAsync(30_000);

    expect(player.hp).toBe(50);
    // 自救不顺带复活宠物，宠物需再次「救助」或由他人处理。
    expect(JSON.parse(map.summons)[0].hp).toBe(0);
  });

  it('存活状态下没有可抢救目标，救助仍提示没有需要抢救的宠物', async () => {
    const player = {
      id: 1, userId: 1, name: '甲', mapId: 7, hp: 100, maxHp: 100, markers2: '[]',
    };
    const fixture = makeService({
      player,
      map: { id: 7, name: '医疗室', summons: '[]', vehicles: '[]' },
    });

    await expect(fixture.service.handleRescue(1)).resolves.toContain('还没有需要抢救的宠物');
  });

  it('自救结算时同图有自己的白，复活后传送到该图复活点', async () => {
    const player = {
      id: 1, userId: 1, name: '甲', mapId: 7, hp: 0, maxHp: 100,
      qqNumber: '888', markers2: '[]',
    };
    const wildMap = {
      id: 7, name: '荒野', respawnPoint: '安全屋',
      summons: JSON.stringify([{ name: '白', ownerQQ: '888' }]),
      vehicles: '[]',
    };
    const safeMap = { id: 9, name: '安全屋', summons: '[]', vehicles: '[]' };
    const fixture = makeService({ player, map: wildMap, allMaps: [wildMap, safeMap] });

    await expect(fixture.service.handleReviveFamiliar(1)).resolves.toContain('正在抢救中');
    await jest.advanceTimersByTimeAsync(30_000);

    expect(player.hp).toBe(50);
    // 原版 L1303-1305：复活到附近复活点并提示。
    expect(player.mapId).toBe(9);
    expect(fixture.service.performArrival).toHaveBeenCalledWith(1, 9, '安全屋');
  });

  it('白在别的地图时，复活后传送到白身边', async () => {
    const player = {
      id: 1, userId: 1, name: '甲', mapId: 7, hp: 0, maxHp: 100,
      qqNumber: '888', markers2: '[]',
    };
    const wildMap = { id: 7, name: '荒野', summons: '[]', vehicles: '[]' };
    const whiteMap = {
      id: 11, name: '矿区',
      summons: JSON.stringify([{ name: '白', ownerQQ: '888' }]),
      vehicles: '[]',
    };
    const fixture = makeService({ player, map: wildMap, allMaps: [wildMap, whiteMap] });

    await expect(fixture.service.handleReviveFamiliar(1)).resolves.toContain('正在抢救中');
    await jest.advanceTimersByTimeAsync(30_000);

    expect(player.mapId).toBe(11);
  });

  it('别人的白不会触发传送，玩家原地复活', async () => {
    const player = {
      id: 1, userId: 1, name: '甲', mapId: 7, hp: 0, maxHp: 100,
      qqNumber: '888', markers2: '[]',
    };
    const wildMap = {
      id: 7, name: '荒野', respawnPoint: '安全屋',
      summons: JSON.stringify([{ name: '白', ownerQQ: '999' }]),
      vehicles: '[]',
    };
    const safeMap = { id: 9, name: '安全屋', summons: '[]', vehicles: '[]' };
    const fixture = makeService({ player, map: wildMap, allMaps: [wildMap, safeMap] });

    await expect(fixture.service.handleReviveFamiliar(1)).resolves.toContain('正在抢救中');
    await jest.advanceTimersByTimeAsync(30_000);

    expect(player.hp).toBe(50);
    expect(player.mapId).toBe(7);
    expect(fixture.service.performArrival).not.toHaveBeenCalled();
  });

  it('没有白时原地复活，并把结算文本广播到世界频道', async () => {
    const player = {
      id: 1, userId: 1, name: '甲', mapId: 7, hp: 0, maxHp: 120, shield: 10, armor: 10, markers2: '[]',
    };
    const fixture = makeService({
      player,
      map: { id: 7, name: '医疗室', summons: '[]', vehicles: '[]' },
    });

    await expect(fixture.service.handleReviveFamiliar(1)).resolves.toContain('正在抢救中');
    await jest.advanceTimersByTimeAsync(30_000);

    expect(player.hp).toBe(60);
    expect(player.shield).toBe(0);
    expect(player.armor).toBe(0);
    expect(JSON.parse(player.markers2)).toEqual([]);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(1, '复活');
    // 延时回调拿不到指令回复通道，结算文本必须走世界频道系统消息送达玩家。
    expect(fixture.chatService.broadcastSystem).toHaveBeenCalledWith(
      '世界频道',
      expect.stringContaining('恢复了60生命'),
      1,
    );
  });

  it('服务重启后，后台扫描会补结算已到期的自救标记', async () => {
    const player = {
      id: 1, userId: 1, name: '甲', mapId: 7, hp: 0, maxHp: 100, markers2: JSON.stringify([
        { name: '复活', rescueType: 'self', expireAt: 900, token: 'pending-self' },
      ]),
    };
    const fixture = makeService({
      player,
      map: { id: 7, name: '医疗室', summons: '[]', vehicles: '[]' },
    });

    await expect(fixture.service.settlePendingRescues()).resolves.toBe(1);
    expect(player.hp).toBe(50);
    expect(JSON.parse(player.markers2)).toEqual([]);
  });
});
