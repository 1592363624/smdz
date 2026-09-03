import { GameService } from '../src/modules/game/game.service';

function parseJson(value: any, fallback: any): any {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function makeBaseService(): any {
  const service = Object.create(GameService.prototype) as any;
  service.logger = { log: jest.fn(), warn: jest.fn() };
  service.taskService = { advance: jest.fn(async () => '') };
  service.playerService = {
    safeJsonParse: parseJson,
    isPlayerDead: jest.fn(() => false),
    handlePlayerDeath: jest.fn(),
    addToBackpack: jest.fn(async () => undefined),
    getBackpackItems: jest.fn((player: any) => parseJson(player.backpack, [])),
    savePlayer: jest.fn(async () => undefined),
  };
  service.mapService = {
    getMapById: jest.fn(),
    getMapByName: jest.fn(),
    getAllMaps: jest.fn(async () => []),
    updateDynamicFields: jest.fn(async () => undefined),
    clearMapMonsters: jest.fn(async () => undefined),
    // 模拟生产 mutateMapFields 闭环：重读最新字段 → 跑 mutator → 把改动同步回地图对象
    mutateMapFields: jest.fn(async (mapId: number, fields: string[], mutator: (f: any) => any) => {
      const target: any = await service.mapService.getMapById(mapId);
      const f: any = {};
      for (const field of fields) {
        f[field] = parseJson(target?.[field], field === 'markers' ? {} : []);
      }
      const result = await mutator(f);
      if (target) for (const field of fields) target[field] = f[field];
      return result ?? {};
    }),
    mutateSummons: jest.fn(async (mapId: number, mutator: (summons: any[]) => any) =>
      service.mapService.mutateMapFields(mapId, ['summons'], (f: any) => mutator(f.summons))),
  };
  service.prisma = {
    gameMap: { update: jest.fn(async () => undefined) },
    user: { findUnique: jest.fn(async () => ({ id: 42 })) },
  };
  service.achievementService = {
    getAchievement: jest.fn(() => 0),
    setAchievement: jest.fn(),
  };
  service.combatState = {
    markerRequire: jest.fn(() => false),
    timeIntervalRequire: jest.fn(() => false),
  };
  service.familiarSystemService = {
    checkAndUpdateGrowth: jest.fn(() => false),
  };
  return service;
}

describe('任务动作服务层闭环', () => {
  it('拾取无参数只展示，全部拾取按资源数量和条目数推进', async () => {
    const service = makeBaseService();
    const player = { userId: 42, name: '冒险者', mapId: 1 };
    const map: any = {
      id: 1,
      name: '森林',
      items: JSON.stringify([
        { name: '木头', type: '资源', quantity: 3, data: '' },
        { name: '铁剑', type: '装备', quantity: 1, data: 'e' },
      ]),
    };
    service.playerService.getPlayerData = jest.fn(async () => ({ player }));
    service.mapService.getMapById.mockResolvedValue(map);

    const listing = await service.handlePickup(42);
    expect(listing).toContain('冒险者附近的地上有:');
    expect(service.playerService.addToBackpack).not.toHaveBeenCalled();
    expect(service.taskService.advance).not.toHaveBeenCalled();

    const result = await service.handlePickup(42, '全部');
    expect(result).toContain('木头 ×3');
    expect(service.playerService.addToBackpack).toHaveBeenNthCalledWith(1, 42, '木头', 3);
    expect(service.playerService.addToBackpack).toHaveBeenNthCalledWith(2, 42, '铁剑', 1);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '采集资源', 3);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '采集木头', 3);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '拾取', 2);
    expect(service.taskService.advance).not.toHaveBeenCalledWith(42, '拾取', 3);
  });

  it('剪毛成功按物种、剪毛、采集和产物数量推进，失败不推进', async () => {
    const service = makeBaseService();
    const player = { userId: 42, name: '冒险者', mapId: 1 };
    const map = {
      id: 1,
      summons: JSON.stringify([{
        name: '绵羊宝宝',
        type: '绵羊',
        ownerQQ: '42',
        hp: 100,
        hair: { name: '羊毛', quantity: 2 },
      }]),
    };
    service.playerService.getPlayerData = jest.fn(async () => ({ player }));
    service.mapService.getMapById.mockResolvedValue(map);

    await expect(service.handleShear(42, '绵羊宝宝')).resolves.toContain('羊毛×2');
    expect(service.playerService.addToBackpack).toHaveBeenCalledWith(42, '羊毛', 2);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '剪毛绵羊', 2);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '剪毛', 2);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '采集', 2);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '采集羊毛', 2);

    service.taskService.advance.mockClear();
    await expect(service.handleShear(42, '不存在的宠物')).resolves.toContain('没有名为');
    expect(service.taskService.advance).not.toHaveBeenCalled();
  });

  it('删除怪物成功清怪并推进，副本和冷却状态拒绝操作', async () => {
    const makeDeleteFixture = (isInstance = false) => {
      const service = makeBaseService();
      const player: any = { id: 7, userId: 42, name: '冒险者', mapId: 1, markers: '{}', markers2: '[]' };
      service.playerService.getPlayerData = jest.fn(async () => ({
        player,
        markers: {},
        markers2: [],
      }));
      service.mapService.getMapById.mockResolvedValue({
        id: 1,
        name: '森林',
        isInstance,
        markers2: '[]',
      });
      return service;
    };

    const success = makeDeleteFixture();
    await expect(success.handleDeleteMonster(42)).resolves.toContain('附近的怪物被清除了');
    expect(success.mapService.clearMapMonsters).toHaveBeenCalledWith(1);
    expect(success.achievementService.setAchievement).toHaveBeenCalledWith({}, '删除怪物', 1);
    expect(success.taskService.advance).toHaveBeenCalledWith(42, '删除怪物');

    const dungeon = makeDeleteFixture(true);
    await expect(dungeon.handleDeleteMonster(42)).resolves.toBe('冒险者副本不可以');
    expect(dungeon.mapService.clearMapMonsters).not.toHaveBeenCalled();
    expect(dungeon.taskService.advance).not.toHaveBeenCalled();

    const cooldown = makeDeleteFixture();
    cooldown.combatState.timeIntervalRequire.mockImplementation(
      (_name: string, _seconds: number, _markers: any[], _now: number, text: { value: string }) => {
        text.value = '还需要10分';
        return true;
      },
    );
    await expect(cooldown.handleDeleteMonster(42)).resolves.toBe('冒险者还需要10分');
    expect(cooldown.mapService.clearMapMonsters).not.toHaveBeenCalled();
    expect(cooldown.taskService.advance).not.toHaveBeenCalled();
  });

  it('呼叫行商按实际等级推进，免费等级0不推进', async () => {
    const service = makeBaseService();
    const now = new Date();
    const hour = now.getHours();
    const slotName = hour < 12 ? '通讯1' : hour >= 18 ? '通讯2' : '通讯3';
    const map: any = {
      id: 1,
      name: '家园',
      buildings: JSON.stringify([{ name: '通讯台' }]),
      vehicles: '[]',
      summons: '[]',
    };
    const player: any = {
      id: 7,
      userId: 42,
      name: '冒险者',
      mapId: 1,
      houseName: '家园',
      markers: '{}',
      markers2: JSON.stringify([{ name: slotName, expireAt: Date.now() / 1000 + 600 }]),
      backpack: JSON.stringify([{ name: '发带', type: '资源', quantity: 5 }]),
    };
    service.playerService.getPlayerData = jest.fn(async () => ({
      player,
      markers: {},
      markers2: parseJson(player.markers2, []),
    }));
    service.mapService.getMapById.mockResolvedValue(map);
    service.mapService.getMapByName.mockResolvedValue(map);
    service.mapService.getAllMaps.mockResolvedValue([map]);
    service.generateMerchantInventory = jest.fn(async () => []);

    await expect(service.handleCallVehicle(42, '行商')).resolves.toContain('行商来到了');
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '呼叫行商', 4);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '呼叫', 4);

    service.taskService.advance.mockClear();
    player.markers2 = '[]';
    player.backpack = '[]';
    await service.handleCallVehicle(42, '行商');
    expect(service.taskService.advance).not.toHaveBeenCalled();
  });

  it('普通宠物和载具呼叫在业务层只推进一次，并且同地图不会重复对象', async () => {
    const service = makeBaseService();
    const map: any = {
      id: 1,
      name: '森林',
      buildings: '[]',
      summons: JSON.stringify([{ name: '宠物甲', qq: 'pet-1', ownerQQ: '42', markers: '{}' }]),
      vehicles: JSON.stringify([{ name: '小车', id: 'vehicle-1', ownerQQ: '42', moveType: 1 }]),
    };
    const player: any = {
      id: 7,
      userId: 42,
      name: '冒险者',
      mapId: 1,
      markers: '{}',
      markers2: '[]',
    };
    service.playerService.getPlayerData = jest.fn(async () => ({
      player,
      markers: {},
      markers2: [],
    }));
    service.mapService.getMapById.mockResolvedValue(map);
    service.mapService.getAllMaps.mockResolvedValue([map]);

    await expect(service.handleCallVehicle(42, '宠物甲')).resolves.toContain('宠物甲跑到了森林');
    expect(parseJson(map.summons, [])).toHaveLength(1);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '呼叫');
    expect(service.achievementService.setAchievement).toHaveBeenCalledWith({}, '呼叫', 1);

    service.taskService.advance.mockClear();
    await expect(service.handleCallVehicle(42, '载具vehicle-1')).resolves.toContain('小车挪到了森林');
    expect(parseJson(map.vehicles, [])).toHaveLength(1);
    expect(service.taskService.advance).toHaveBeenCalledTimes(1);
  });

  it('安装全部按每种建筑的实际数量推进，忽略硅基核心和占位建筑', async () => {
    const service = makeBaseService();
    const player: any = {
      userId: 42,
      name: '冒险者',
      mapId: 1,
      houseName: '家园',
      backpack: JSON.stringify([
        { name: '高速生产器', type: '资源', quantity: 3 },
        { name: '普通建筑', type: '资源', quantity: 2 },
        { name: '硅基核心阿尔法', type: '资源', quantity: 5 },
      ]),
    };
    const map: any = {
      id: 1,
      name: '家园',
      buildings: '[]',
    };
    service.playerService.getPlayerData = jest.fn(async () => ({ player }));
    service.mapService.getMapById.mockResolvedValue(map);
    service.mapService.updateDynamicFields.mockImplementation(async (_mapId: number, data: any) => {
      Object.assign(map, data);
    });
    service.staticData = {
      getBuildingByName: jest.fn((name: string) => {
        if (name === '高速生产器') return { noOccupy: true };
        if (name === '普通建筑') return { noOccupy: false };
        if (name === '硅基核心阿尔法') return { noOccupy: true };
        return undefined;
      }),
    };

    const result = await service.handleInstallAll(42);

    expect(result).toContain('高速生产器x3');
    expect(parseJson(player.backpack, [])).toEqual([
      expect.objectContaining({ name: '普通建筑', quantity: 2 }),
      expect.objectContaining({ name: '硅基核心阿尔法', quantity: 5 }),
    ]);
    expect(parseJson(map.buildings, [])).toEqual([
      expect.objectContaining({ name: '高速生产器', quantity: 3 }),
    ]);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '安装', 3);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '安装高速生产器', 3);
    expect(service.taskService.advance).not.toHaveBeenCalledWith(42, '安装硅基核心阿尔法', expect.anything());
  });

  it('单体挤奶按静态产奶量结算，并按对象设置当天冷却', async () => {
    const service = makeBaseService();
    const player: any = {
      id: 7,
      userId: 42,
      name: '冒险者',
      mapId: 1,
      markers2: '[]',
      backpack: '[]',
      exp: 0,
      upgradeExp: 10,
    };
    const map: any = {
      id: 1,
      name: '森林',
      summons: JSON.stringify([
        {
          name: '斑点牛',
          qq: '怪物斑点牛1g',
          ownerQQ: '42',
          bonus: JSON.stringify({ 产奶量: 2 }),
          markers: '{}',
        },
      ]),
    };
    service.playerService.getPlayerData = jest.fn(async () => ({
      player,
      markers: {},
      markers2: parseJson(player.markers2, []),
    }));
    service.mapService.getMapById.mockResolvedValue(map);
    service.mapService.updateDynamicFields.mockImplementation(async (_mapId: number, data: any) => {
      Object.assign(map, data);
    });
    service.prisma.user.findUnique.mockResolvedValue({ id: 42, qqNumber: '42', externalId: null });
    service.combatState.normalizeBuffItem = jest.fn((entry: any) => ({
      名称: entry.名称 ?? entry.name ?? entry.key ?? '',
      强度: entry.强度 ?? entry.value ?? 0,
      有效期至: entry.有效期至 ?? entry.expireTime ?? entry.expireAt ?? 0,
    }));
    service.staticData = {
      getMonsterByName: jest.fn(() => undefined),
    };

    await expect(service.handleMilk(42, '斑点牛')).resolves.toContain('奶×2');
    expect(parseJson(player.backpack, [])).toEqual([
      expect.objectContaining({ name: '奶', quantity: 2 }),
    ]);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '挤奶');
    expect(parseJson(player.markers2, [])).toEqual([
      expect.objectContaining({ 名称: '挤奶怪物斑点牛1g' }),
    ]);

    service.taskService.advance.mockClear();
    await expect(service.handleMilk(42, '斑点牛')).resolves.toContain('还需要');
    expect(service.taskService.advance).not.toHaveBeenCalled();
  });

  it('全部挤奶合并产量，茸增加25%，青龙每天只奖励一次升级经验，任务按成功对象数推进', async () => {
    const service = makeBaseService();
    const player: any = {
      id: 7,
      userId: 42,
      name: '冒险者',
      mapId: 1,
      markers2: '[]',
      backpack: '[]',
      exp: 3,
      upgradeExp: 10,
    };
    const summons = [
      {
        name: '茸',
        qq: '怪物茸1g',
        ownerQQ: '42',
        bonus: JSON.stringify({ 产奶量: 0.8 }),
        markers: '{}',
      },
      {
        name: '斑点牛',
        qq: '怪物斑点牛2g',
        ownerQQ: '42',
        bonus: JSON.stringify({ 产奶量: 2 }),
        markers: '{}',
      },
      {
        name: '青龙',
        qq: '怪物青龙1g',
        ownerQQ: '42',
        bonus: JSON.stringify({ 产奶量: 0.6 }),
        markers: '{}',
      },
      {
        name: '临时宠物',
        qq: '怪物临时xg',
        ownerQQ: '42',
        bonus: JSON.stringify({ 产奶量: 9 }),
        markers: '{}',
      },
    ];
    const map: any = { id: 1, name: '森林', summons: JSON.stringify(summons) };
    service.playerService.getPlayerData = jest.fn(async () => ({
      player,
      markers: {},
      markers2: parseJson(player.markers2, []),
    }));
    service.mapService.getMapById.mockResolvedValue(map);
    service.mapService.updateDynamicFields.mockImplementation(async (_mapId: number, data: any) => {
      Object.assign(map, data);
    });
    service.prisma.user.findUnique.mockResolvedValue({ id: 42, qqNumber: '42', externalId: null });
    service.combatState.normalizeBuffItem = jest.fn((entry: any) => ({
      名称: entry.名称 ?? entry.name ?? entry.key ?? '',
      强度: entry.强度 ?? entry.value ?? 0,
      有效期至: entry.有效期至 ?? entry.expireTime ?? entry.expireAt ?? 0,
    }));
    service.staticData = { getMonsterByName: jest.fn(() => undefined) };

    await expect(service.handleAllMilk(42)).resolves.toContain('奶×4.25');
    expect(parseJson(player.backpack, [])).toEqual([
      expect.objectContaining({ name: '奶', quantity: 4.25 }),
    ]);
    expect(player.exp).toBe(13);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '挤奶', 3);
    expect(parseJson(player.markers2, [])).toEqual(expect.arrayContaining([
      expect.objectContaining({ 名称: 'zq' }),
    ]));
  });

  it('手动开采按资源库存量推进任务，货舱使用打开货舱动作', async () => {
    const service = makeBaseService();
    const player: any = {
      id: 7,
      userId: 42,
      name: '冒险者',
      mapId: 1,
      markers2: '[]',
      backpack: '[]',
    };
    const resources = [
      { name: '铁矿', amount: 3, respawnTime: 300, gatherCmd: '采集铁矿' },
      { name: '货舱', amount: 2, respawnTime: 300, gatherCmd: '打开货舱' },
    ];
    const map: any = { id: 1, name: '森林', resources2: JSON.stringify(resources) };
    service.playerService.getPlayerData = jest.fn(async () => ({
      player,
      markers: {},
      markers2: parseJson(player.markers2, []),
    }));
    service.mapService.getMapById.mockResolvedValue(map);
    service.prisma.gameMap.update.mockImplementation(async (_args: any) => undefined);

    await expect(service.handleMine(42, '铁矿')).resolves.toContain('铁矿 ×3');
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '开采');
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '采集资源', 3);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '采集铁矿', 3);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '奴役', 2);
    expect(parseJson(player.backpack, [])).toEqual([
      expect.objectContaining({ name: '铁矿', quantity: 3 }),
    ]);

    service.taskService.advance.mockClear();
    await expect(service.handleMine(42, '货舱')).resolves.toContain('货舱 ×2');
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '开采');
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '采集资源', 2);
    expect(service.taskService.advance).toHaveBeenCalledWith(42, '打开货舱');
    expect(service.taskService.advance).not.toHaveBeenCalledWith(42, '采集货舱', expect.anything());
  });
});
