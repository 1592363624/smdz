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
}) {
  const player = options.player;
  const map = options.map;
  const otherPlayers = options.otherPlayers ?? [];
  const savedPlayers: any[] = [];
  const updates: any[] = [];
  const taskService = { advance: jest.fn(async () => '') };
  const playerService: any = {
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
    getMapById: jest.fn(async () => map),
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
  const service: any = Object.create(GameService.prototype);
  Object.assign(service, {
    prisma,
    playerService,
    mapService,
    taskService,
    rescueTimers: new Map<number, NodeJS.Timeout>(),
    chatService: { broadcastSystem: jest.fn(async () => undefined) },
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
  });
  return { service, player, map, taskService, playerService, updates, savedPlayers };
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
