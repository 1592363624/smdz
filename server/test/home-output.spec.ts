import { HomeService } from '../src/modules/game/home.service';
import { StaticDataService } from '../src/modules/game/static-data.service';

/**
 * 兼容两种存储形态的 Json 列读取：生产已切到「Json 列 = 原生对象/数组」，
 * 读出即为解析好的结构，直接返回；仅历史字符串 fixture 才走 JSON.parse。
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

describe('家园产出复刻', () => {
  it('普通宠物的蛋和垃圾写入地图物品，玩家背包保持不变并持久化观测时间', async () => {
    const fixture = makeHomeFixture({
      summons: [{ 名称: '普通宠物', 活力: 1, 当前生命: 100 }],
    });

    await fixture.service.collectHomeOutput(7);

    const mapItems = parseJson<any[]>(fixture.map.items, []);
    expect(mapItems.find((item) => item.name === '蛋')?.quantity).toBeCloseTo(1);
    expect(mapItems.find((item) => item.name === '垃圾')?.quantity).toBeCloseTo(1 / 1440);
    expect(fixture.backpack).toEqual([{ name: '面包', quantity: 3 }]);
    expect(fixture.playerService.savePlayer).toHaveBeenCalled();
    // 生产 Json 列已切到「原生对象/数组落库」，写回的是真实结构而非 JSON 字符串
    expect(fixture.mapService.updateDynamicFields).toHaveBeenCalledWith(
      91,
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ name: '蛋' }),
        ]),
        markers: expect.objectContaining({ 观测时间: expect.any(Number) }),
      }),
    );
  });

  it('具现装置按每天一个未知物品写入地图物品，不直接污染玩家背包', async () => {
    const fixture = makeHomeFixture({
      buildings: [{ 名称: '具现装置', 数量: 1 }],
    });

    await fixture.service.collectHomeOutput(7);

    const mapItems = parseJson<any[]>(fixture.map.items, []);
    expect(mapItems.find((item) => item.name === '未知物品')?.quantity).toBeCloseTo(1);
    expect(fixture.backpack).toEqual([{ name: '面包', quantity: 3 }]);
  });

  it('世界模拟器按建筑运行时间推进 AI，完成训练后产出带 a 数据的核心', async () => {
    const fixture = makeHomeFixture({
      buildings: [
        { 名称: '工业电站', 数量: 52 },
        { 名称: '世界模拟器', 数量: 1 },
      ],
      summons: [{ 名称: '普通宠物', 活力: 1, 当前生命: 100 }],
      items: [{ 名称: '燃料', 数量: 500000 }],
    });
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);

    const result = await fixture.service.collectHomeOutput(7);

    const mapItems = parseJson<any[]>(fixture.map.items, []);
    const alpha = mapItems.find((item) => item.name === '硅基核心阿尔法');
    const mapMarkers = parseJson<Record<string, any>>(fixture.map.markers, {});
    expect(alpha?.quantity).toBe(1);
    expect(alpha?.data).toBe('a');
    expect(mapMarkers.AI).toBe(0);
    expect(result).toContain('正在训练硅基核心:0%');
    expect(randomSpy).toHaveBeenCalled();
  });

  it('特殊宠物的多产出共享消耗时间，生肉不足时不会凭空产出灵石', async () => {
    const fixture = makeHomeFixture({
      summons: [{ 名称: '小雨下', 活力: -18, 当前生命: 100 }],
      items: [],
    });

    await fixture.service.collectHomeOutput(7);

    const mapItems = parseJson<any[]>(fixture.map.items, []);
    expect(mapItems.find((item) => item.name === '灵石')).toBeUndefined();
  });

  it('地图字段使用中文/英文兼容结构，产出阶段按优先级写回地图仓储', async () => {
    const fixture = makeHomeFixture({
      buildings: [{ name: '具现装置', quantity: 1 }],
      items: [{ 名称: '面包', 数量: 2 }],
    });

    await fixture.service.collectHomeOutput(7);

    const mapItems = parseJson<any[]>(fixture.map.items, []);
    expect(mapItems.find((item) => item['名称'] === '面包')?.['数量']).toBe(2);
    expect(mapItems.find((item) => item.name === '未知物品')?.quantity).toBeCloseTo(1);
    expect(fixture.player.backpack).toBe(JSON.stringify([{ name: '面包', quantity: 3 }]));
    expect(fixture.mapService.updateDynamicFields).toHaveBeenCalledTimes(1);
  });
});
