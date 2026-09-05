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

function makeService(options: { role?: string; map3?: any } = {}) {
  const player: any = {
    id: 1, userId: 42, name: '冒险者', mapId: 7, markers: '{}', markers2: '[]', hp: 100,
  };
  const map: any = { id: 7, name: '当前地图', level: 5 };
  const map3: any = options.map3 || { id: 3, name: '新手村', level: 1 };
  const service: any = Object.create(GameService.prototype);
  Object.assign(service, {
    prisma: {
      user: { findUnique: jest.fn(async () => ({ id: 42, role: options.role ?? 'ADMIN' })) },
      player: { findFirst: jest.fn(async () => ({ id: 1, name: '归属者', masterQQ: '123' })) },
    },
    playerService: {
      getPlayerData: jest.fn(async () => ({
        player,
        markers: parseJson(player.markers, {}),
        markers2: parseJson(player.markers2, []),
        equipment: [], weapons: [],
      })),
      isPlayerDead: jest.fn(() => false),
      savePlayer: jest.fn(async () => undefined),
    },
    mapService: {
      getMapById: jest.fn(async (id: number) => Number(id) === 3 ? map3 : map),
      spawnMonsterByName: jest.fn(async () => ({ id: 99 })),
      createMapSummonByName: jest.fn(async () => ({ level: 3, hp: 500, maxHp: 500, markers: [] })),
      mutateSummons: jest.fn(async (_id: number, fn: (s: any[]) => any) => {
        const summons: any[] = [];
        await fn(summons);
        return summons;
      }),
    },
    logger: { log: jest.fn(), warn: jest.fn() },
  });
  return { service, map3, player };
}

describe('管理指令：刷新怪物 / 生成人物（原版 L6829-6881 复刻）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('刷新怪物：非管理员拒绝', async () => {
    const fixture = makeService({ role: 'USER' });

    const result = await fixture.service.handleRefreshMonster(42, '史莱姆');

    expect(result).toContain('权限不足');
    expect(fixture.service.mapService.spawnMonsterByName).not.toHaveBeenCalled();
  });

  it('刷新怪物：怪物列表未找到', async () => {
    const fixture = makeService();
    fixture.service.mapService.spawnMonsterByName.mockRejectedValue(new Error('怪物「不存在的怪」不存在'));

    const result = await fixture.service.handleRefreshMonster(42, '不存在的怪');

    expect(result).toContain('怪物列表未找到');
    expect(result).toContain('不存在的怪');
  });

  it('刷新怪物：在当前地图按静态定义刷新一只常驻怪物', async () => {
    const fixture = makeService();

    const result = await fixture.service.handleRefreshMonster(42, '史莱姆');

    expect(result).toBe('在当前地图刷新了一只史莱姆');
    expect(fixture.service.mapService.spawnMonsterByName).toHaveBeenCalledWith(7, '史莱姆', { isTemp: false });
  });

  it('生成人物：参数不为6个返回用法提示', async () => {
    const fixture = makeService();

    const result = await fixture.service.handleSpawnNpc(42, '@123 小白 白 npc 30');

    expect(result).toContain('生成人物@人 名称 类型 类型2(npc或宠物) 好感 宝宝(1或者0)');
  });

  it('生成人物：归属玩家不存在时拒绝', async () => {
    const fixture = makeService();
    fixture.service.prisma.player.findFirst.mockResolvedValue(null);

    const result = await fixture.service.handleSpawnNpc(42, '@999 小白 白 npc 30 0');

    expect(result).toContain('归属玩家不存在：999');
    expect(fixture.service.mapService.mutateSummons).not.toHaveBeenCalled();
  });

  it('生成人物：npc 类型生成剧情实体并写入好感/宝宝标记', async () => {
    const fixture = makeService();

    const result = await fixture.service.handleSpawnNpc(42, '@123 小白 白 npc 30 1');

    expect(result).toContain('在新手村生成了小白');
    expect(result).toContain('属于归属者,123');
    const [mapId, mutator] = fixture.service.mapService.mutateSummons.mock.calls[0];
    expect(mapId).toBe(3); // 原版固定 地图列表[3]
    const summons: any[] = [];
    await mutator(summons);
    const unit = summons[0];
    expect(unit.qq).toMatch(/^召唤物/);
    expect(unit.name).toBe('小白');
    expect(unit.type).toBe('白');
    expect(unit.标记).toEqual([
      { 名称: '好感123', 数值: 30 },
      { 名称: '宝宝', 数值: 1 },
    ]);
  });

  it('生成人物：宠物类型走完整怪物初始化并使用 怪物Ngg 编号', async () => {
    const fixture = makeService();

    const result = await fixture.service.handleSpawnNpc(42, '@123 小灰狼 灰狼 宠物 10 0');

    expect(result).toContain('生成了小灰狼');
    expect(fixture.service.mapService.createMapSummonByName).toHaveBeenCalledWith(
      3, '灰狼', expect.objectContaining({ ownerQQ: '123', qq: expect.stringMatching(/^怪物.+g$/) }),
    );
    const [, petMutator] = fixture.service.mapService.mutateSummons.mock.calls[0];
    const petSummons: any[] = [];
    await petMutator(petSummons);
    expect(petSummons[0].name).toBe('小灰狼');
    expect(petSummons[0].标记).toEqual([{ 名称: '好感123', 数值: 10 }]);
  });
});
