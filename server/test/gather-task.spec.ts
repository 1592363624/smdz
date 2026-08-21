import { GatherHandler } from '../src/modules/command/handlers/gather.handler';
import { GameService } from '../src/modules/game/game.service';

function makeGatherFixture(resource: any, options: { equipmentNames?: string[]; markers2?: any[] } = {}) {
  const player: any = {
    userId: 42,
    mapId: 7,
    markers: '{}',
    markers2: JSON.stringify(options.markers2 || []),
    backpack: '[]',
  };
  const map: any = {
    id: 7,
    name: '测试地图',
    resources: JSON.stringify([resource]),
    resources2: '[]',
    markers2: '[]',
  };
  const taskService = {
    advance: jest.fn(async () => ''),
    acceptTask: jest.fn(async () => ''),
  };
  const prisma = {
    gameMap: {
      update: jest.fn(async ({ data }: any) => {
        Object.assign(map, data);
        return map;
      }),
    },
  };
  const playerService = {
    getPlayerData: jest.fn(async () => ({ player })),
    safeJsonParse: jest.fn((value: any, fallback: any) => {
      if (value === null || value === undefined) return fallback;
      if (typeof value !== 'string') return value;
      try {
        const parsed = JSON.parse(value);
        return parsed === null ? fallback : parsed;
      } catch {
        return fallback;
      }
    }),
    getBackpackItems: jest.fn((currentPlayer: any) => {
      try {
        return JSON.parse(currentPlayer.backpack || '[]');
      } catch {
        return [];
      }
    }),
    savePlayer: jest.fn(async () => undefined),
  };
  const itemSystemService = {
    generateRewardEquipment: jest.fn(async (name: string, quality?: string) => ({
      name,
      quality,
      type: '装备',
      data: 'e!bx0',
    })),
  };
  const service: any = Object.create(GameService.prototype);
  Object.assign(service, {
    prisma,
    playerService,
    mapService: { getMapById: jest.fn(async () => map) },
    combatSystem: {
      buildAttackerBonus: jest.fn(() => ({ 采集: 100, 掉落率: 0 })),
    },
    staticData: {
      getEquipmentByName: jest.fn((name: string) =>
        (options.equipmentNames || []).includes(name) ? { name } : undefined),
    },
    itemSystemService,
    taskService,
    logger: { log: jest.fn(), warn: jest.fn() },
  });
  return { service, player, map, taskService, prisma, itemSystemService };
}

describe('固定采集任务推进', () => {
  afterEach(() => jest.restoreAllMocks());

  it('采集冷却提示不推进采集任务', async () => {
    const taskService = {
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const handler = new GatherHandler(
      {
        handleGatherResource: jest.fn(async () => '【木头】还需要 299 秒才能再次采集'),
      } as any,
      taskService as any,
    );

    const result = await handler.handle({
      userId: 42,
      rawMessage: '收集木头',
      source: 'web',
    } as any);

    expect(result.success).toBe(false);
    expect(result.content).toContain('还需要');
    expect(taskService.advance).not.toHaveBeenCalled();
  });

  it('兼容旧 JSON：名称末尾数量、count 字段作为概率', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const fixture = makeGatherFixture({
      name: '旧箱子',
      times: 1,
      outputs: JSON.stringify([{ name: '木头3', count: 100 }]),
      gatherCmd: '打开旧箱子',
    });

    const result = await fixture.service.handleGatherResource(42, '打开旧箱子');
    const backpack = JSON.parse(fixture.player.backpack);

    expect(result).toContain('木头×3');
    expect(backpack).toEqual([expect.objectContaining({ name: '木头', count: 3, quantity: 3 })]);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '采集', 1);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '打开旧箱子', 1);
    expect(JSON.parse(fixture.map.markers2)).toEqual([
      expect.objectContaining({ name: '刷新资源旧箱子' }),
    ]);
  });

  it('兼容数组形式旧 JSON，并按名称末尾数量发放', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const fixture = makeGatherFixture({
      name: '数组旧箱子',
      times: -1,
      outputs: [{ name: '石头2', count: 100 }],
      gatherCmd: '打开数组旧箱子',
    });

    const result = await fixture.service.handleGatherResource(42, '打开数组旧箱子');

    expect(result).toContain('石头×2');
    expect(JSON.parse(fixture.player.backpack)).toEqual([
      expect.objectContaining({ name: '石头', count: 2, quantity: 2 }),
    ]);
  });

  it('采集成功写入资源标记，之后不能重复领取', async () => {
    const fixture = makeGatherFixture({
      name: '一次性资源',
      marker: '一次性资源标记',
      times: -1,
      outputs: [{ name: '水晶', count: 1, chance: 100 }],
      gatherCmd: '采集一次性资源',
    });

    const first = await fixture.service.handleGatherResource(42, '采集一次性资源');
    const second = await fixture.service.handleGatherResource(42, '采集一次性资源');

    expect(first).toContain('水晶×1');
    expect(second).toBe('');
    expect(JSON.parse(fixture.player.markers)).toEqual({ 一次性资源标记: 1 });
    expect(fixture.taskService.advance).toHaveBeenCalledTimes(5);
  });

  it('按实际采集次数发放产出并扣减次数，次数为-1时可连续采集', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const fixture = makeGatherFixture({
      name: '常驻树',
      times: -1,
      outputs: [{ name: '木头', count: 2, chance: 100 }],
      gatherCmd: '收集木头',
    });

    await fixture.service.handleGatherResource(42, '收集木头', 2);
    await fixture.service.handleGatherResource(42, '收集木头', 1);
    const backpack = JSON.parse(fixture.player.backpack);

    expect(backpack[0]).toEqual(expect.objectContaining({ name: '木头', count: 4, quantity: 4 }));
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '采集', 1);
    expect(fixture.taskService.advance).toHaveBeenCalledTimes(10);
    expect(fixture.prisma.gameMap.update).not.toHaveBeenCalled();
  });

  it('概率失败仍消耗一次采集动作，但不推进产出数量任务', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.9);
    const fixture = makeGatherFixture({
      name: '低概率草',
      times: -1,
      outputs: [{ name: '果实', count: 1, chance: 50 }],
      gatherCmd: '收集低概率草',
    });

    const result = await fixture.service.handleGatherResource(42, '收集低概率草');

    expect(result).toBe('采集了 低概率草');
    expect(JSON.parse(fixture.player.backpack)).toEqual([]);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '采集', 1);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '收集低概率草', 1);
    expect(fixture.taskService.advance).not.toHaveBeenCalledWith(42, '采集资源', expect.anything());
  });

  it('装备品质后缀和负数产出按原版分别生成装备、获得绝对数量', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const fixture = makeGatherFixture({
      name: '集装箱',
      times: -1,
      outputs: [
        { name: '寒风s', count: 0, chance: 100 },
        { name: '工业建筑箱-3', count: 0, chance: 100 },
      ],
      gatherCmd: '打开集装箱',
    }, { equipmentNames: ['寒风'] });

    await fixture.service.handleGatherResource(42, '打开集装箱');
    const backpack = JSON.parse(fixture.player.backpack);

    expect(fixture.itemSystemService.generateRewardEquipment).toHaveBeenCalledWith('寒风', 's');
    expect(backpack).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '寒风', type: '装备' }),
      expect.objectContaining({ name: '工业建筑箱', count: 3, quantity: 3 }),
    ]));
  });

  it('冷却未结束时不写背包、不推进任务', async () => {
    const fixture = makeGatherFixture({
      name: '冷却树',
      times: -1,
      outputs: [{ name: '木头', count: 1, chance: 100 }],
      gatherCmd: '收集冷却树',
    }, {
      markers2: [{ key: 'gather_7_冷却树', expireTime: Date.now() + 60000 }],
    });

    const result = await fixture.service.handleGatherResource(42, '收集冷却树');

    expect(result).toContain('还需要');
    expect(JSON.parse(fixture.player.backpack)).toEqual([]);
    expect(fixture.taskService.advance).not.toHaveBeenCalled();
    expect(fixture.prisma.gameMap.update).not.toHaveBeenCalled();
  });
});
