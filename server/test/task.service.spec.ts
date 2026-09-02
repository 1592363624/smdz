import { TaskService } from '../src/modules/game/task.service';
import { PlayerService } from '../src/modules/game/player.service';

interface FixtureOptions {
  tasks: any[];
  markers?: Record<string, number>;
  backpack?: any[];
  maps?: any[];
  vehicleRecipes?: any[];
}

function makeFixture(options: FixtureOptions) {
  const players: any[] = [{
    id: 1,
    userId: 42,
    level: 1,
    exp: 0,
    upgradeExp: 6,
    tasks: JSON.stringify(options.tasks),
    markers: JSON.stringify(options.markers || {}),
    backpack: JSON.stringify(options.backpack || []),
    recipes: '[]',
    markers2: '[]',
    affinity: 0,
    vitality: 0,
    hp: 52,
    maxHp: 52,
    shield: 22,
    maxShield: 22,
    armor: 32,
    maxArmor: 32,
    attack: 10,
    hit: 10,
    dodge: 10,
    speed: 10,
    crit: 3,
    critDmg: 150,
    regenHp: 0,
    regenShield: 0,
    regenArmor: 0,
  }];
  const maps = options.maps || [];
  const vehicleRecipes = options.vehicleRecipes || [];
  const definitions = new Map<string, any>();
  const equipmentNames = new Set<string>();

  const addDefinition = (definition: any) => {
    definitions.set(definition.name, {
      chance: 100,
      level: 1,
      publisher: '',
      nextTasks: '[]',
      restrictMarkers: '[]',
      ...definition,
    });
    for (const reward of JSON.parse(definition.rewards || '[]')) {
      if (reward.type === '装备') equipmentNames.add(reward.name);
    }
  };

  const staticData: any = {
    getTaskByName: jest.fn((name: string) => definitions.get(name)),
    getAllTasks: jest.fn(() => [...definitions.values()]),
    getVehicleRecipeByName: jest.fn((name: string) => vehicleRecipes.find((recipe) => recipe.name === name)),
    getAllVehicleRecipes: jest.fn(() => vehicleRecipes),
    getEquipmentByName: jest.fn((name: string) => equipmentNames.has(name) ? { name } : undefined),
  };
  const itemSystem: any = {
    generateRewardEquipment: jest.fn(async (name: string) => ({
      name,
      type: '装备',
      quantity: 1,
      durability: 0,
      data: 'e!bx0',
    })),
  };
  // 用真实 PlayerService 的共享用户级锁：本套件专门验证并发推进的串行化，
  // 直通 stub 会把锁语义抹掉（与生产行为不一致）。
  const lockOwner = new PlayerService({} as any, {} as any, {} as any);
  const playerService: any = {
    enqueueUserWrite: lockOwner.enqueueUserWrite.bind(lockOwner),
    calcUpgradeExp: jest.fn((level: number) => level * level + 5),
    recalcLevelStats: jest.fn(),
    getPlayerData: jest.fn(async () => ({ player: players[0] })),
    savePlayer: jest.fn(async (p: any) => p),
  };
  const prisma: any = {
    player: {
      findUnique: jest.fn(async () => players[0]),
      update: jest.fn(async ({ data }: any) => {
        Object.assign(players[0], data);
        return players[0];
      }),
    },
    gameMap: {
      findMany: jest.fn(async () => maps),
      update: jest.fn(async ({ where, data }: any) => {
        const map = maps.find((item) => item.id === where.id);
        if (map) Object.assign(map, data);
        return map;
      }),
    },
  };

  for (const task of options.tasks) addDefinition(task);
  const service = new TaskService(prisma, playerService, staticData, itemSystem);
  return { service, player: players[0], maps, itemSystem, prisma, addDefinition, staticData, equipmentNames };
}

describe('任务系统闭环', () => {
  afterEach(() => jest.restoreAllMocks());

  it('自动结算、奖励概率、后续任务和完成任务级联一次完成', async () => {
    const fixture = makeFixture({
      tasks: [
        {
          name: '任务A',
          requirements: JSON.stringify([{ name: '行动A', count: 1 }]),
          rewards: JSON.stringify([
            { name: '能量块', count: 10 },
            { name: '测试装备', count: 100, type: '装备' },
          ]),
          nextTasks: JSON.stringify(['任务B']),
        },
        {
          name: '任务B',
          requirements: JSON.stringify([{ name: '完成任务', count: 1 }]),
          rewards: JSON.stringify([{ name: '水晶', count: 1 }]),
        },
        {
          name: '任务C',
          requirements: JSON.stringify([{ name: '获得装备', count: 1 }]),
          rewards: JSON.stringify([{ name: '木头', count: 1 }]),
        },
      ],
    });
    fixture.addDefinition({
      name: '测试装备',
      requirements: '[]',
      rewards: '[]',
    });
    jest.spyOn(Math, 'random').mockReturnValue(0);

    const result = await fixture.service.advance(42, '行动A');
    const tasks = JSON.parse(fixture.player.tasks);
    const backpack = JSON.parse(fixture.player.backpack);

    expect(result).toContain('任务A');
    expect(result).toContain('任务B');
    expect(result).toContain('任务C');
    expect(tasks).toEqual([]);
    expect(backpack.find((item: any) => item.name === '测试装备')).toEqual(expect.objectContaining({
      type: '装备',
      quantity: 1,
      data: 'e!bx0',
    }));
    expect(backpack.find((item: any) => item.name === '能量块').count).toBeGreaterThan(10);
    expect(backpack.find((item: any) => item.name === '水晶').count).toBeGreaterThan(1);
    expect(backpack.find((item: any) => item.name === '木头').count).toBeGreaterThan(1);
    expect(JSON.parse(fixture.player.markers)['完成任务']).toBe(3);
    expect(JSON.parse(fixture.player.markers)['任务熟练度']).toBe(3);
    expect(fixture.itemSystem.generateRewardEquipment).toHaveBeenCalledWith('测试装备');
    expect(fixture.service.consumeNotifications(42)).toContain('任务A');
    expect(fixture.service.consumeNotifications(42)).toBe('');
  });

  it('装备奖励按概率判定，失败时不生成装备', async () => {
    const fixture = makeFixture({
      tasks: [{
        name: '低概率装备',
        requirements: JSON.stringify([{ name: '行动', count: 1 }]),
        rewards: JSON.stringify([{ name: '测试装备', count: 1, type: '装备' }]),
      }],
    });
    fixture.addDefinition({ name: '测试装备', requirements: '[]', rewards: '[]' });
    jest.spyOn(Math, 'random').mockReturnValue(0.5);

    await fixture.service.advance(42, '行动');
    expect(JSON.parse(fixture.player.backpack)).toEqual([]);
    expect(fixture.itemSystem.generateRewardEquipment).not.toHaveBeenCalled();
  });

  it('未标记装备类型的奖励按堆叠物品发放，不把数量当概率', async () => {
    const fixture = makeFixture({
      tasks: [{
        name: '堆叠奖励',
        requirements: JSON.stringify([{ name: '行动', count: 1 }]),
        rewards: JSON.stringify([{ name: '隐形披风', count: 100 }]),
      }],
    });
    fixture.equipmentNames.add('隐形披风');
    jest.spyOn(Math, 'random').mockReturnValue(0.99);

    await fixture.service.advance(42, '行动');
    const reward = JSON.parse(fixture.player.backpack).find((item: any) => item.name === '隐形披风');
    expect(reward).toEqual(expect.objectContaining({
      type: '资源',
      count: expect.any(Number),
      quantity: expect.any(Number),
    }));
    expect(reward.count).toBeGreaterThan(100);
    expect(fixture.itemSystem.generateRewardEquipment).not.toHaveBeenCalled();
  });

  it('发布人好感写入召唤物，达到100时清空其他玩家好感并更新归属', async () => {
    const maps = [{
      id: 7,
      summons: JSON.stringify([{
        qq: 'npc-1',
        name: '任务发布人',
        ownerQQ: 'old-owner',
        markers: JSON.stringify({ 好感42: 95, 好感99: 30 }),
      }]),
      npcs: '[]',
    }];
    const fixture = makeFixture({
      tasks: [{
        name: '好感任务',
        requirements: JSON.stringify([{ name: '行动', count: 1 }]),
        rewards: JSON.stringify([{ name: '好感', count: 5 }]),
      }],
      maps,
    });
    const task = JSON.parse(fixture.player.tasks)[0];
    task.publisher = 'npc-1';
    fixture.player.tasks = JSON.stringify([task]);
    jest.spyOn(Math, 'random').mockReturnValue(0);

    await fixture.service.advance(42, '行动');
    const summon = JSON.parse(maps[0].summons)[0];
    const markers = JSON.parse(summon.markers);
    expect(markers['好感42']).toBeGreaterThanOrEqual(100);
    expect(markers['好感99']).toBeUndefined();
    expect(summon.ownerQQ).toBe('42');
    expect(fixture.player.affinity).toBe(0);
  });

  it('同一玩家并发推进串行化且只发放一次奖励', async () => {
    const fixture = makeFixture({
      tasks: [{
        name: '并发任务',
        requirements: JSON.stringify([{ name: '行动', count: 2 }]),
        rewards: JSON.stringify([{ name: '木头', count: 1 }]),
      }],
    });

    await Promise.all([
      fixture.service.advance(42, '行动'),
      fixture.service.advance(42, '行动'),
    ]);

    expect(JSON.parse(fixture.player.tasks)).toEqual([]);
    const backpack = JSON.parse(fixture.player.backpack);
    expect(backpack.filter((item: any) => item.name === '木头')).toHaveLength(1);
    expect(backpack[0].count).toBeGreaterThan(1);
    expect(JSON.parse(fixture.player.markers)['完成任务']).toBe(1);
  });
});

describe('任务系统兼容入口', () => {
  it('旧的已完成任务可以通过提交入口结算，未完成任务不会提前发奖', async () => {
    const fixture = makeFixture({
      tasks: [{
        name: '旧任务',
        status: '已完成',
        requirements: JSON.stringify([]),
        rewards: JSON.stringify([{ name: '水晶', count: 2 }]),
      }],
    });

    const result = await fixture.service.completePendingTask(42, '旧任务');
    expect(result).toContain('旧任务');
    expect(JSON.parse(fixture.player.tasks)).toEqual([]);
    expect(JSON.parse(fixture.player.backpack)[0].name).toBe('水晶');
  });

  it('兼容原版反引号任务和#a#/#b#要求编码，并保留发布人', async () => {
    const fixture = makeFixture({ tasks: [] });
    fixture.addDefinition({
      name: '旧格式任务',
      requirements: JSON.stringify([{ name: '击败怪物', count: 2 }]),
      rewards: JSON.stringify([{ name: '水晶', count: 1 }]),
    });
    fixture.player.tasks = '旧格式任务!击败怪物#b#2!npc-1';

    await fixture.service.advance(42, '击败怪物');
    expect(JSON.parse(fixture.player.tasks)[0]).toEqual(expect.objectContaining({
      name: '旧格式任务',
      publisher: 'npc-1',
      requirements: [{ name: '击败怪物', count: 1 }],
    }));

    const result = await fixture.service.advance(42, '击败怪物');
    expect(result).toContain('旧格式任务');
    expect(JSON.parse(fixture.player.tasks)).toEqual([]);
  });

  it('负数要求按原版语义自动完成，不需要额外行动', async () => {
    const fixture = makeFixture({
      tasks: [{
        name: '自动任务',
        requirements: JSON.stringify([{ name: '自动完成', count: -1 }]),
        rewards: JSON.stringify([{ name: '水晶', count: 1 }]),
      }],
    });

    const result = await fixture.service.advance(42, '任意行动');
    expect(result).toContain('自动任务');
    expect(JSON.parse(fixture.player.tasks)).toEqual([]);
    expect(JSON.parse(fixture.player.backpack).some((item: any) => item.name === '水晶')).toBe(true);
  });

  it('领取任务会立即写入领取任务成就并支持领取即完成', async () => {
    const fixture = makeFixture({ tasks: [] });
    fixture.addDefinition({
      name: '领取即完成',
      requirements: JSON.stringify([{ name: '领取任务', count: 1 }]),
      rewards: JSON.stringify([{ name: '水晶', count: 1 }]),
    });

    const result = await fixture.service.acceptTask(42, '领取即完成', 'npc-1');
    expect(result).toContain('领取即完成');
    expect(JSON.parse(fixture.player.tasks)).toEqual([]);
    expect(JSON.parse(fixture.player.markers)['领取任务']).toBe(1);
  });

  it('查看任务和放弃任务支持1-based序号', async () => {
    const fixture = makeFixture({
      tasks: [
        {
          name: '任务一',
          requirements: JSON.stringify([{ name: '行动一', count: 2 }]),
          rewards: '[]',
        },
        {
          name: '任务二',
          requirements: JSON.stringify([{ name: '行动二', count: 1 }]),
          rewards: '[]',
        },
      ],
    });

    const details = await fixture.service.listTasks(42, '1');
    expect(details).toContain('任务一');
    expect(details).toContain('行动一');
    expect(details).not.toContain('任务二');

    const result = await fixture.service.abandonTask(42, '1');
    expect(result).toContain('任务一');
    expect(JSON.parse(fixture.player.tasks).map((task: any) => task.name)).toEqual(['任务二']);
  });

  it('查看任务按运行时召唤物解析发布人（白发布的任务不再显示对象已不存在）', async () => {
    const fixture = makeFixture({
      tasks: [
        {
          name: '矿工',
          publisher: '召唤物1788327197207784',
          requirements: JSON.stringify([{ name: '铁矿', count: 10 }]),
          rewards: '[]',
        },
      ],
      maps: [
        { id: 1, name: '干净医疗室', summons: [{ name: '白', qq: '召唤物1788327197207784' }], npcs: [] },
      ],
    });

    const detail = await fixture.service.listTasks(42, '1');
    expect(detail).toContain('·来自:白(干净医疗室)');

    const list = await fixture.service.listTasks(42);
    expect(list).toContain('1、矿工(白)');
  });

  it('发布人对应的召唤物不在任何地图时详情仍标注对象已不存在', async () => {
    const fixture = makeFixture({
      tasks: [
        {
          name: '矿工',
          publisher: '召唤物999',
          requirements: JSON.stringify([{ name: '铁矿', count: 10 }]),
          rewards: '[]',
        },
      ],
      maps: [{ id: 1, name: '干净医疗室', summons: [{ name: '白', qq: '召唤物111' }], npcs: [] }],
    });

    const detail = await fixture.service.listTasks(42, '1');
    expect(detail).toContain('·来自:召唤物999(对象已不存在)');
  });

  it('旧的已完成任务支持按序号提交并自动结算', async () => {
    const fixture = makeFixture({
      tasks: [
        {
          name: '普通任务',
          requirements: JSON.stringify([{ name: '行动', count: 1 }]),
          rewards: '[]',
        },
        {
          name: '旧序号任务',
          status: '已完成',
          requirements: '[]',
          rewards: JSON.stringify([{ name: '水晶', count: 2 }]),
        },
      ],
    });

    const result = await fixture.service.completePendingTask(42, '2');
    expect(result).toContain('旧序号任务');
    expect(JSON.parse(fixture.player.tasks).map((task: any) => task.name)).toEqual(['普通任务']);
    expect(JSON.parse(fixture.player.backpack).some((item: any) => item.name === '水晶')).toBe(true);
  });

  it('动态配方任务按等级和同时领取上限闭环解锁', async () => {
    const fixture = makeFixture({
      tasks: [],
      vehicleRecipes: [
        {
          name: '配方一',
          level: 1,
          unlockRequirements: JSON.stringify([{ name: '行动一', count: 1 }]),
        },
        {
          name: '配方二',
          level: 1,
          unlockRequirements: JSON.stringify([{ name: '行动二', count: 1 }]),
        },
        {
          name: '配方三',
          level: 2,
          unlockRequirements: JSON.stringify([{ name: '行动三', count: 1 }]),
        },
      ],
    });

    const first = await fixture.service.acceptRecipeUnlockTask(42, '配方一');
    expect(first).toContain('领取了');
    const limited = await fixture.service.acceptRecipeUnlockTask(42, '配方二');
    expect(limited).toContain('一次只能领取一个');

    await fixture.service.advance(42, '行动一');
    expect(JSON.parse(fixture.player.recipes)).toEqual(['配方一']);
    expect(JSON.parse(fixture.player.tasks)).toEqual([]);

    await fixture.service.acceptRecipeUnlockTask(42, '配方二');
    await fixture.service.advance(42, '行动二');
    expect(JSON.parse(fixture.player.recipes)).toEqual(['配方一', '配方二']);

    const levelTwo = await fixture.service.acceptRecipeUnlockTask(42, '配方三');
    expect(levelTwo).toContain('领取了');
    await fixture.service.advance(42, '行动三');
    expect(JSON.parse(fixture.player.recipes)).toEqual(['配方一', '配方二', '配方三']);
  });
});
