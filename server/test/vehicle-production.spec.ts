import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { GameService } from '../src/modules/game/game.service';
import { StaticDataService } from '../src/modules/game/static-data.service';

type Recipe = {
  name: string;
  outputs?: any[];
  inputs?: any[];
  产出?: any[];
  消耗?: any[];
};

function makeCombat(recipes: Recipe[], options: { production?: number; functionSlots?: number } = {}) {
  const production = options.production ?? 100;
  const functionSlots = options.functionSlots ?? 5;
  const specs: any[] = [
    {
      name: '测试核心',
      partType: 0,
      moveType: 0,
      walk: 1,
      defense: 0,
      weapon: 0,
      function: functionSlots,
      limit: 0,
      bonus: { 生命: 100, 生产: production },
      builtinParts: [],
    },
    {
      name: '九尾狐核心',
      partType: 0,
      moveType: 0,
      walk: 1,
      defense: 0,
      weapon: 0,
      function: functionSlots,
      limit: 0,
      bonus: { 生命: 100, 生产: production },
      builtinParts: [],
    },
    { name: '生产调度系统', partType: 4, function: -1, limit: 0, bonus: {}, builtinParts: [] },
    { name: '生产调度系统II', partType: 4, function: -1, limit: 0, bonus: {}, builtinParts: [] },
    { name: '超限部件', partType: 4, function: -1, limit: 0, bonus: {}, builtinParts: [] },
  ];
  const staticData = {
    getAllVehiclePartSpecs: jest.fn(() => specs),
    getVehicleRecipeByName: jest.fn((name: string) => recipes.find((recipe) => recipe.name === name)),
  } as any;
  const combatState = {
    timeIntervalRequire: jest.fn(() => false),
  } as any;
  const bonusService = {
    addPenetration: jest.fn(),
  } as any;
  const combat = new CombatSystemService(
    {} as any,
    {} as any,
    bonusService,
    {} as any,
    staticData,
    {} as any,
    {} as any,
    combatState,
    {} as any,
  );
  return { combat, staticData, combatState };
}

function makeVehicle(
  recipeEntries: any[],
  parts: any[] = [],
  coreName = '测试核心',
): any {
  return {
    名称: '生产测试载具',
    类型: '',
    零件: [
      { 名称: coreName, 类型: '资源', 数量: 1, 耐久: 100 },
      ...parts,
    ],
    配方: recipeEntries,
    加成: {},
    当前生命: 100,
    上限: 0,
    标记2: [],
  };
}

function item(name: string, quantity: number, durability = 100): any {
  return { 名称: name, 类型: '资源', 数量: quantity, 耐久: durability };
}

function recipe(name: string, outputs: any[], inputs: any[] = []): Recipe {
  return { name, 产出: outputs, 消耗: inputs };
}

describe('载具生产复刻 - 静态配置与核心分支', () => {
  it('静态载具数据包含原版166个部件和95个配方，首次生产只写入读取时间', () => {
    const staticData = new StaticDataService();
    expect(staticData.getAllVehiclePartSpecs()).toHaveLength(166);
    expect(staticData.getAllVehicleRecipes()).toHaveLength(95);

    const { combat } = makeCombat([]);
    const vehicle = makeVehicle([]);
    const result = combat.produceVehicle(vehicle, 123456);

    expect(result.produced).toEqual([]);
    expect(vehicle.配方).toEqual([{ 名称: '1', 数值: 123456 }]);
  });

  it('生肉分解1按原版顺序结算，并保留耐久10%的副产物比例', () => {
    const recipes = [recipe(
      '生肉分解1',
      [item('生物质', 5, 100), item('生物质', 5, 10)],
      [item('生肉', 2.5, 100)],
    )];
    const { combat } = makeCombat(recipes);
    const vehicle = makeVehicle(
      [{ 名称: '1', 数值: 0 }, { 名称: '生肉分解1', 数值: 1 }],
      [item('生肉', 100)],
    );

    const result = combat.produceVehicle(vehicle, 60 * 1000);
    const produced = result.produced.find((value) => value.name === '生物质');
    const meat = vehicle.零件.find((value: any) => value.名称 === '生肉');

    expect(result.productionSpeed).toBe(1);
    expect(produced?.quantity).toBeCloseTo(5.5);
    expect(meat.数量).toBeCloseTo(97.5);
    expect(vehicle.零件.some((value: any) => value.名称 === 'undefined')).toBe(false);
    expect(result.produced.every((value) => Number.isFinite(value.quantity))).toBe(true);
  });

  it('九尾狐核心、副产物、消耗降低和兰音幼崽按原版倍率叠加', () => {
    const recipes = [recipe(
      '分解',
      [item('产品', 1, 100), item('副产品', 10, 10)],
      [item('材料', 2, 100)],
    )];
    const { combat } = makeCombat(recipes);
    const vehicle = makeVehicle(
      [{ 名称: '1', 数值: 0 }, { 名称: '分解', 数值: 1 }],
      [item('材料', 100), item('小凰', 1), item('小雫', 1)],
      '九尾狐核心',
    );

    const result = combat.produceVehicle(vehicle, 60 * 1000, 0, undefined, { lannBaby: true });

    expect(result.byproductMultiplier).toBe(2.25);
    expect(result.consumptionMultiplier).toBeCloseTo(0.93);
    expect(result.elapsedMs).toBeCloseTo(60 * 1000 * 1.05);
    expect(result.produced.find((value) => value.name === '产品')?.quantity).toBeCloseTo(1.05);
    expect(result.produced.find((value) => value.name === '副产品')?.quantity).toBeCloseTo(10 * 0.1 * 2.25 * 1.05);
    expect(vehicle.零件.find((value: any) => value.名称 === '材料').数量).toBeCloseTo(100 - 2 * 0.93 * 1.05);
  });
});

describe('载具生产复刻 - 调度、限制与顺序', () => {
  it('生产调度系统、生产调度系统II和生产加速8按优先级叠加', () => {
    const recipes = [
      recipe('生产加速8', []),
      recipe('产出', [item('产品', 1)], [item('材料', 1)]),
    ];
    const { combat } = makeCombat(recipes);
    const vehicle = makeVehicle(
      [
        { 名称: '1', 数值: 0 },
        { 名称: '生产加速8', 数值: 1 },
        { 名称: '产出', 数值: 1 },
      ],
      [item('生产调度系统', 3), item('生产调度系统II', 2), item('材料', 100)],
    );

    const result = combat.produceVehicle(vehicle, 60 * 1000);

    expect(result.productionSpeed).toBeCloseTo(1.58);
    expect(result.consumedProductivity).toBe(2);
    expect(result.produced.find((value) => value.name === '产品')?.quantity).toBeCloseTo(1.58);
  });

  it('生产力超限时按生产力比例降低效率', () => {
    const recipes = [recipe('产出', [item('产品', 1)], [item('材料', 1)])];
    const { combat } = makeCombat(recipes);
    const vehicle = makeVehicle([
      { 名称: '1', 数值: 0 },
      { 名称: '产出', 数值: 200 },
    ], [item('材料', 100)]);

    const result = combat.produceVehicle(vehicle, 60 * 1000);

    expect(result.consumedProductivity).toBe(200);
    expect(result.efficiency).toBeCloseTo(0.5);
    expect(result.produced.find((value) => value.name === '产品')?.quantity).toBeCloseTo(100);
  });

  it('生产限制会在达到上限时停止后续实际产出', () => {
    const recipes = [recipe('产出', [item('产品', 1)], [item('材料', 1)])];
    const { combat } = makeCombat(recipes);
    const vehicle = makeVehicle(
      [{ 名称: '1', 数值: 0 }, { 名称: '产出', 数值: 1 }],
      [item('材料', 100), item('生产限制产品', 2)],
    );

    const result = combat.produceVehicle(vehicle, 10 * 60 * 1000);

    expect(result.produced.find((value) => value.name === '产品')?.quantity).toBeCloseTo(2);
    expect(vehicle.零件.find((value: any) => value.名称 === '产品').数量).toBeCloseTo(2);
    expect(vehicle.零件.find((value: any) => value.名称 === '材料').数量).toBeCloseTo(98);
  });

  it('前置配方先生产时可立即为后置配方提供材料，反向排序则不能', () => {
    const recipes = [
      recipe('加工原料', [item('中间材料', 1)], [item('原料', 1)]),
      recipe('加工成品', [item('成品', 1)], [item('中间材料', 1)]),
    ];
    const { combat } = makeCombat(recipes);
    const forward = makeVehicle(
      [{ 名称: '1', 数值: 0 }, { 名称: '加工原料', 数值: 1 }, { 名称: '加工成品', 数值: 1 }],
      [item('原料', 1)],
    );
    const reverse = makeVehicle(
      [{ 名称: '1', 数值: 0 }, { 名称: '加工成品', 数值: 1 }, { 名称: '加工原料', 数值: 1 }],
      [item('原料', 1)],
    );

    const forwardResult = combat.produceVehicle(forward, 60 * 1000);
    const reverseResult = combat.produceVehicle(reverse, 60 * 1000);

    expect(forwardResult.produced.find((value) => value.name === '成品')?.quantity).toBeCloseTo(1);
    expect(reverseResult.produced.find((value) => value.name === '成品')).toBeUndefined();
    expect(reverse.零件.find((value: any) => value.名称 === '中间材料').数量).toBeCloseTo(1);
  });
});

describe('载具生产复刻 - 特殊状态和字段兼容', () => {
  it('无生产力时具现装置按每天一个未知物品产生', () => {
    const recipes = [recipe('产出', [item('产品', 1)])];
    const { combat } = makeCombat(recipes, { production: 0 });
    const vehicle = makeVehicle(
      [{ 名称: '1', 数值: 0 }, { 名称: '产出', 数值: 1 }],
      [item('具现装置', 1)],
    );

    const result = combat.produceVehicle(vehicle, 86400 * 1000);

    expect(result.produced).toEqual([]);
    expect(vehicle.零件.find((value: any) => value.名称 === '未知物品').数量).toBeCloseTo(1);
  });

  it('功能部件超出核心上限时不生产，并写回读取时间', () => {
    const recipes = [recipe('产出', [item('产品', 1)])];
    const { combat } = makeCombat(recipes, { functionSlots: 1 });
    const vehicle = makeVehicle(
      [{ 名称: '1', 数值: 0 }, { 名称: '产出', 数值: 1 }],
      [item('超限部件', 2)],
    );

    const result = combat.produceVehicle(vehicle, 60 * 1000);

    expect(result.stopped).toBe(true);
    expect(vehicle.上限).toBeGreaterThan(1);
    expect(vehicle.配方[0].数值).toBe(60 * 1000);
    expect(vehicle.零件.find((value: any) => value.名称 === '产品')).toBeUndefined();
  });

  it('数据库载具和地图JSON载具可互转并按各自存储层持久化', async () => {
    const prisma: any = { gameVehicle: { update: jest.fn() } };
    const playerService: any = {
      safeJsonParse: (value: any, fallback: any) => {
        if (value && typeof value === 'object') return value;
        try { return JSON.parse(value); } catch { return fallback; }
      },
      savePlayer: jest.fn(),
    };
    const mapService: any = { updateDynamicFields: jest.fn() };
    const game = new GameService(
      prisma, playerService, {} as any, {} as any, {} as any, mapService, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any,
    );
    const runtime = (game as any).toRuntimeVehicle({
      id: 7,
      name: '数据库载具',
      vehicleId: 'db-7',
      type: '九尾狐',
      currentHp: 8,
      maxHp: 100,
      bonus: JSON.stringify({ 生产: 100 }),
      parts: JSON.stringify([{ name: '材料', quantity: 3 }]),
      recipes: JSON.stringify([{ name: '产出', value: 2 }]),
      markers2: '[]',
    });

    expect(runtime.名称).toBe('数据库载具');
    expect(runtime.零件[0].名称).toBe('材料');
    expect(runtime.零件[0].数量).toBe(3);
    expect(runtime.配方[0].名称).toBe('产出');
    expect(runtime.配方[0].数值).toBe(2);

    await (game as any).persistRuntimeVehicle({ kind: 'db', db: { id: 7 } }, runtime);
    expect(prisma.gameVehicle.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 7 },
      data: expect.objectContaining({
        parts: expect.stringContaining('材料'),
        recipes: expect.stringContaining('产出'),
      }),
    }));

    const map = { id: 3, vehicles: '[{}]' };
    await (game as any).persistRuntimeVehicle({ kind: 'map', map, index: 0 }, runtime);
    expect(mapService.updateDynamicFields).toHaveBeenCalledWith(3, expect.objectContaining({
      vehicles: expect.stringContaining('数据库载具'),
    }));
  });
});
