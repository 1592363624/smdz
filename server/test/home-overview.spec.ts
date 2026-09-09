import { HomeService, HomeSettlement, renderHomeSettlementText } from '../src/modules/game/home.service';
import { StaticDataService } from '../src/modules/game/static-data.service';

/**
 * 家园只读总览（getHomeOverview / computeHomeSettlement preview）回归：
 * 1) 纯只读——不写观测时间/每日产出/AI 标记，不触碰存放地与玩家档案，零持久化；
 * 2) 投影一致——preview 与 settle 运行同一套公式，DTO 数值与 QQ 文本互为投影；
 * 3) blocked 早退投影。
 * 结算路径本身的行为回归由 home-output.spec.ts 覆盖。
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

function makeHomeFixture(options: {
  buildings?: any[];
  summons?: any[];
  items?: any[];
  markers?: Record<string, any>;
  playerMarkers?: Record<string, any>;
  nowSeconds?: number;
  lastObservedSeconds?: number;
} = {}) {
  const nowSeconds = options.nowSeconds ?? 172800;
  const lastObservedSeconds = options.lastObservedSeconds ?? nowSeconds - 86400;
  const map: any = {
    id: 91,
    name: '测试家园',
    items: JSON.stringify(options.items ?? []),
    buildings: JSON.stringify(options.buildings ?? []),
    summons: JSON.stringify(options.summons ?? []),
    resources2: '[]',
    markers: JSON.stringify({ 观测时间: lastObservedSeconds, ...(options.markers ?? {}) }),
  };
  const backpack = [{ name: '面包', quantity: 3 }];
  const player: any = {
    id: 7,
    name: '测试玩家',
    level: 10,
    houseName: '测试家园',
    mapId: 91,
    markers: JSON.stringify({ 家园进度: 4, ...(options.playerMarkers ?? {}) }),
    backpack: JSON.stringify(backpack),
  };
  const playerService: any = {
    getPlayerData: jest.fn(async () => ({ player, backpack })),
    safeJsonParse: jest.fn((value: any, fallback: any) => {
      if (value && typeof value === 'object') return value;
      return parseJson(value, fallback);
    }),
    getMarkerValue: jest.fn((markers: any, name: string) => Number(markers?.[name] ?? 0)),
    savePlayer: jest.fn(async (value: any) => {
      player.backpack = JSON.stringify(backpack);
      return value;
    }),
  };
  const mapService: any = {
    getMapByName: jest.fn(async () => map),
    updateDynamicFields: jest.fn(async (_mapId: number, fields: Record<string, any>) => {
      Object.assign(map, fields);
    }),
    getConnections: jest.fn(() => []),
  };
  const prisma: any = {
    gameMap: { update: jest.fn() },
  };
  const service = new HomeService(
    prisma,
    playerService,
    mapService,
    new StaticDataService(),
  );
  const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowSeconds * 1000);

  return { service, map, player, backpack, playerService, mapService, nowSpy };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('家园只读总览（preview 不结算）', () => {
  it('纯只读：不推进观测时间、不持久化、不触碰存放地/地图标记/玩家标记', async () => {
    const fixture = makeHomeFixture({
      summons: [{ 名称: '普通宠物', 活力: 1, 当前生命: 100 }],
    });
    const itemsBefore = fixture.map.items;
    const markersBefore = fixture.map.markers;
    const playerMarkersBefore = fixture.player.markers;

    const overview = await fixture.service.getHomeOverview(7);

    expect(fixture.mapService.updateDynamicFields).not.toHaveBeenCalled();
    expect(fixture.playerService.savePlayer).not.toHaveBeenCalled();
    // persistHomeMap 会把 map.items/markers 改写为对象，字符串原样即证明活态未被触碰
    expect(fixture.map.items).toBe(itemsBefore);
    expect(fixture.map.markers).toBe(markersBefore);
    expect(fixture.player.markers).toBe(playerMarkersBefore);
    // 观测时间投影不推进：仍是上次观测值
    expect(overview.elapsedSeconds).toBeCloseTo(86400);
  });

  it('投影一致：宠物蛋/垃圾进入 directOutput 与存放地快照，临时肥料结算后不残留', async () => {
    const fixture = makeHomeFixture({
      summons: [{ 名称: '普通宠物', 活力: 1, 当前生命: 100 }],
    });

    const overview = await fixture.service.getHomeOverview(7);

    expect(overview.blocked).toBeUndefined();
    expect(overview.playerName).toBe('测试玩家');
    const egg = overview.directOutput.find((item) => item.name === '蛋');
    expect(egg?.quantity).toBeCloseTo(1);
    const storageEgg = overview.storage.find((item) => item.name === '蛋');
    expect(storageEgg?.quantity).toBeCloseTo(1);
    expect(overview.storage.find((item) => item.name === '肥料')).toBeUndefined();
    expect(overview.gains.some((item) => item.name === '蛋')).toBe(true);
  });

  it('世界模拟器结构化投影：text 与结算文本同口径，核心名与概率快照一致', async () => {
    const fixture = makeHomeFixture({
      buildings: [
        { 名称: '工业电站', 数量: 52 },
        { 名称: '世界模拟器', 数量: 1 },
      ],
      summons: [{ 名称: '普通宠物', 活力: 1, 当前生命: 100 }],
      items: [{ 名称: '燃料', 数量: 500000 }],
    });
    jest.spyOn(Math, 'random').mockReturnValue(0);

    const overview: HomeSettlement = await fixture.service.getHomeOverview(7);

    expect(overview.hasPower).toBe(true);
    expect(overview.remainingFuelSeconds).toBeGreaterThan(0);
    expect(overview.worldSimulation).toBeDefined();
    expect(overview.worldSimulation!.text).toContain('正在训练硅基核心:');
    expect(overview.worldSimulation!.cores.length).toBeGreaterThan(0);
    expect(overview.worldSimulation!.cores.every((core) => core.name === '硅基核心阿尔法')).toBe(true);
    // preview 不写 AI 标记：克隆上的推进随函数返回丢弃
    expect(parseJson<Record<string, any>>(fixture.map.markers, {}).AI).toBeUndefined();

    // 双出口同源：同一结算的 QQ 文本包含同一状态行（渲染器纯投影）
    const settleText = await fixture.service.collectHomeOutput(7);
    expect(settleText).toContain(overview.worldSimulation!.text);
  });

  it('渲染器纯投影：gains→获得行、世界模拟器/宠物提示行序、空产出兜底、无电与早退短路', () => {
    const base: HomeSettlement = {
      playerName: '测试玩家',
      hasPower: true,
      overloaded: false,
      elapsedSeconds: 60,
      effectiveElapsedSeconds: 60,
      remainingFuelSeconds: 100,
      powerGeneration: 10,
      directOutput: [],
      gains: [{ name: '蛋', quantity: 1 }],
      dailyOutput: [],
      petBonusText: [],
      producers: [],
      storage: [],
    };
    expect(renderHomeSettlementText(base)).toBe('测试玩家的家园产出\n获得蛋x1');
    expect(renderHomeSettlementText({
      ...base,
      gains: [{ name: '蛋', quantity: 1 }, { name: '垃圾', quantity: 0.5 }],
      worldSimulation: { aiProgressPercent: 0, alphaChance: 35, betaChance: 50, text: '正在训练硅基核心:0%', cores: [] },
      petBonusText: ['螳螂:没有采集工具或装备'],
    })).toBe('测试玩家的家园产出\n获得蛋x1\n获得垃圾x0.5\n正在训练硅基核心:0%\n螳螂:没有采集工具或装备');
    expect(renderHomeSettlementText({ ...base, gains: [] })).toBe('测试玩家的家园产出\n本次没有产出任何物品');
    expect(renderHomeSettlementText({ ...base, hasPower: false })).toBe('测试玩家的家园产出\n电力不足，建筑生产停止');
    expect(renderHomeSettlementText({ ...base, blocked: '家园尚未建成，无法产出' })).toBe('家园尚未建成，无法产出');
  });

  it('家园未建成时 blocked 早退投影', async () => {
    const fixture = makeHomeFixture({ playerMarkers: { 家园进度: 0 } });

    const overview = await fixture.service.getHomeOverview(7);

    expect(overview.blocked).toBe('家园尚未建成，无法产出');
    expect(overview.hasPower).toBe(false);
    expect(overview.gains).toEqual([]);
  });
});
