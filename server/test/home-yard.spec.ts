import { HomeYardService } from '../src/modules/game/home-yard.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { HOME_YARD_CONFIG } from '../src/modules/game/home-yard.config';

/**
 * 家园院子格子视图（GET /game/home/yard 数据源）回归：
 * 1) 纯只读——不写玩家档案、不写地图动态字段，只做投影；
 * 2) 聚合展开——建筑/作物按数量展开成一格一格，与「拆除1个」指令语义对齐；
 * 3) 作物与地面障碍以「产出2 是否为空」区分（原版口径）；
 * 4) 仓库只收录真正可种 / 可装的物品，普通物品不入列；
 * 5) 上限之外的地块渲染为待开垦（locked）并给出解锁提示。
 */

function parseJson<T>(value: any, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    const parsed = JSON.parse(value);
    return (parsed === null ? fallback : parsed) as T;
  } catch {
    return fallback;
  }
}

interface FixtureOptions {
  buildings?: any[];
  resources2?: any[];
  backpack?: any[];
  houseName?: string;
  currentMapName?: string;
  playerMarkers?: Record<string, any>;
  limit?: { cropLimit: number; buildingLimit: number };
}

function makeYardFixture(options: FixtureOptions = {}) {
  const map: any = {
    id: 91,
    name: options.houseName ?? '测试家园',
    items: JSON.stringify([{ name: '铁矿', quantity: 12 }]),
    buildings: JSON.stringify(options.buildings ?? []),
    resources2: JSON.stringify(options.resources2 ?? []),
    summons: '[]',
    markers: '{}',
  };
  const backpack = options.backpack ?? [];
  const player: any = {
    id: 7,
    name: '测试玩家',
    level: 10,
    houseName: options.houseName ?? '测试家园',
    mapId: 91,
    markers: JSON.stringify({ 家园进度: 4, ...(options.playerMarkers ?? {}) }),
    backpack: JSON.stringify(backpack),
  };

  const playerService: any = {
    getPlayerData: jest.fn(async () => ({ player, markers: parseJson(player.markers, {}) })),
    getBackpackItems: jest.fn((p: any) => parseJson(p.backpack, [])),
    getMarkerValue: jest.fn((markers: any, name: string) => Number(markers?.[name] ?? 0)),
    savePlayer: jest.fn(async (value: any) => value),
  };
  const mapService: any = {
    getMapByName: jest.fn(async () => map),
    // 玩家当前所在地图：默认与家园同名（在家）
    getMapById: jest.fn(async () => ({ id: 91, name: options.currentMapName ?? options.houseName ?? '测试家园' })),
    updateDynamicFields: jest.fn(async () => undefined),
  };
  const homeService: any = {
    getHomeOverview: jest.fn(async () => ({
      hasPower: true,
      overloaded: false,
      elapsedSeconds: 600,
      gains: [{ name: '铁矿', quantity: 3 }],
      storage: [{ name: '铁矿', quantity: 12 }],
      overview: {
        cropLimit: options.limit?.cropLimit ?? 5,
        buildingLimit: options.limit?.buildingLimit ?? 3,
        powerNet: 120,
        fuelStock: 8,
        fuelSeconds: 3600,
        fertilizerStock: 2,
        jobSupply: 2,
        jobDemand: 1,
        dailyDisplay: [],
      },
    })),
    getCropGrowthPlan: jest.fn(() => ({
      totalSeconds: 600,
      rewardScaleDivisor: 600,
      stageNames: ['播种', '发芽', '生长', '成熟'],
    })),
  };

  const service = new HomeYardService(
    playerService,
    mapService,
    new StaticDataService(),
    homeService,
  );
  return { service, map, player, backpack, playerService, mapService, homeService };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('家园院子格子视图', () => {
  it('纯只读：不写玩家档案、不写地图动态字段', async () => {
    const fixture = makeYardFixture({
      resources2: [{ name: '椰树', quantity: 1, outputs2: [{ name: '奶', quantity: 0.0007 }] }],
    });

    await fixture.service.getHomeYard(7);

    expect(fixture.playerService.savePlayer).not.toHaveBeenCalled();
    expect(fixture.mapService.updateDynamicFields).not.toHaveBeenCalled();
  });

  it('作物按数量展开成地块，地面障碍（产出2 为空）归入 obstacles', async () => {
    const fixture = makeYardFixture({
      resources2: [
        { name: '椰树', quantity: 2, outputs2: [{ name: '奶', quantity: 0.0007 }] },
        { name: '土堆', times: 3, outputs2: [] },
      ],
    });

    const yard = await fixture.service.getHomeYard(7);

    expect(yard.crop.used).toBe(2);
    expect(yard.crop.plots.filter((p) => p.state === 'occupied').map((p) => p.name)).toEqual(['椰树', '椰树']);
    // 同名聚合：每格都知道同名总数，便于「收获全部 ×N」
    expect(yard.crop.plots[0].total).toBe(2);
    expect(yard.obstacles).toHaveLength(1);
    expect(yard.obstacles[0].name).toBe('土堆');
    expect(yard.obstacles[0].quantity).toBe(3);
  });

  it('建筑按数量展开成地块，拆除返还按原版 50% 折算', async () => {
    const fixture = makeYardFixture({
      buildings: [{ name: '基础钻机', quantity: 2 }],
    });

    const yard = await fixture.service.getHomeYard(7);

    expect(yard.building.used).toBe(2);
    expect(yard.building.plots.filter((p) => p.state === 'occupied').map((p) => p.name)).toEqual([
      '基础钻机',
      '基础钻机',
    ]);
    // 基础钻机耗电 25，拆除不返还电力（正数项不返还）；耗电项 -25 的 50% 需向下取整
    const plot = yard.building.plots[0];
    expect(plot.outputs.some((o) => o.name === '电力' && o.quantity === -25)).toBe(true);
    expect(plot.harvest.every((h) => h.quantity > 0)).toBe(true);
  });

  it('上限之外渲染为待开垦地块并给出解锁提示', async () => {
    const fixture = makeYardFixture({ limit: { cropLimit: 2, buildingLimit: 1 } });

    const yard = await fixture.service.getHomeYard(7);

    const locked = yard.crop.plots.filter((p) => p.state === 'locked');
    expect(locked).toHaveLength(HOME_YARD_CONFIG.lockedPreviewPlots);
    // 等级 10 → 农田基础上限 ceil(10/5)=2，下一格需 11 级
    expect(locked[0].unlockHint).toContain('等级 11');
    expect(yard.crop.plots.filter((p) => p.state === 'empty')).toHaveLength(2);
  });

  it('仓库只收录可种植的种子与可安装的建筑，普通物品不入列', async () => {
    const fixture = makeYardFixture({
      backpack: [
        { name: '椰树种子', quantity: 3 },
        { name: '基础钻机', quantity: 1 },
        { name: '面包', quantity: 5 },
      ],
    });

    const yard = await fixture.service.getHomeYard(7);

    expect(yard.seeds.map((s) => s.name)).toEqual(['椰树种子']);
    expect(yard.seeds[0].target).toBe('椰树');
    expect(yard.seeds[0].quantity).toBe(3);
    expect(yard.buildings.map((b) => b.name)).toEqual(['基础钻机']);
  });

  it('materials 汇总背包资源存量（建造引导「已有 X」用），装备不计入', async () => {
    const fixture = makeYardFixture({
      backpack: [
        { name: '木头', type: '资源', quantity: 50 },
        { name: '木头', type: '资源', quantity: 30 },
        { name: '石头', type: '资源', quantity: 120 },
        { name: '铁矿', type: '资源', quantity: 12 },
        { name: '绳子', type: '资源', quantity: 0 },
        { name: '布帽', type: '装备', quantity: 1 },
      ],
    });

    const yard = await fixture.service.getHomeYard(7);

    expect(yard.materials['木头']).toBe(80);
    expect(yard.materials['石头']).toBe(120);
    expect(yard.materials['铁矿']).toBe(12);
    // 数量为 0 的不进 map
    expect(yard.materials['绳子']).toBeUndefined();
    // 装备不计入材料存量
    expect(yard.materials['布帽']).toBeUndefined();
  });

  it('atHome 反映玩家是否站在自己的院子里（种植/拆除的前置条件）', async () => {
    const inHouse = makeYardFixture();
    expect((await inHouse.service.getHomeYard(7)).atHome).toBe(true);

    const away = makeYardFixture({ currentMapName: '中央广场' });
    expect((await away.service.getHomeYard(7)).atHome).toBe(false);
  });

  it('未圈地时直接返回 blocked，不再查询院子数据', async () => {
    const fixture = makeYardFixture({ houseName: '' });

    const yard = await fixture.service.getHomeYard(7);

    expect(yard.blocked).toContain('还没有家园');
    expect(fixture.homeService.getHomeOverview).not.toHaveBeenCalled();
  });
});
