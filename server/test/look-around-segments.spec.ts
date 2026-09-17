import { GameService } from '../src/modules/game/game.service';
import { createGameServiceStub } from './helpers/game-service-stub.factory';
import { formatDungeonEntryRemaining } from '../src/modules/game/expire-time.util';

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

function makeService(options: {
  markers?: Record<string, any>;
  map?: any;
  houseName?: string;
  connections?: any[];
} = {}) {
  const player: any = {
    id: 1, userId: 42, name: '冒险者', mapId: 7, level: 5, expBonus: 20,
    houseName: options.houseName ?? '',
    markers: JSON.stringify(options.markers ?? {}),
    markers2: '[]',
  };
  const map: any = options.map || {
    id: 7, name: '森林', isFrontier: false,
    monsters: '[]', resources: '[]', resources2: '[]',
    items: '[]', npcs: '[]', summons: '[]', markers2: '[]',
  };
  const service: any = createGameServiceStub({
    prisma: {
      player: {
        findMany: jest.fn(async () => [
          { name: '冒险者2', user: { username: 'u2', nickname: '' } },
          { name: '', user: { username: 'u3', nickname: '小张' } },
        ]),
      },
    },
    playerService: {
      getPlayerData: jest.fn(async () => ({
        player, markers: parseJson(player.markers, {}), markers2: [], equipment: [], weapons: [],
      })),
      getMarkerValue: jest.fn((markers: any, key: string) => Number(markers?.[key] ?? 0)),
      savePlayer: jest.fn(async () => undefined),
    },
    mapService: {
      getMapById: jest.fn(async () => map),
      getMapMonsters: jest.fn(async () => []),
      getConnections: jest.fn(() => options.connections ?? []),
    },
    combatState: {},
    combatSystem: {
      buildAttackerBonus: jest.fn(() => { throw new Error('no bonus'); }),
    },
    familiarSystemService: { checkAndUpdateGrowth: jest.fn(() => false) },
    shortcutService: { setTempInput: jest.fn(async () => undefined) },
    // 自动采集段通过资源静态定义补全采集指令名（resolveGatherCmd）
    staticData: { getAllResources: () => require('../prisma/data/resources.json') },
    logger: { log: jest.fn(), warn: jest.fn() },
  });
  service.summonFollowDisplay = jest.fn(async () => ({ names: [], count: 0, indexes: [] }));
  return { service, player, map };
}

describe('观察附近五段展示（原版 地图操作.ecode L867-968 复刻）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('附近玩家：列出同地图全部玩家（含昵称回退）', async () => {
    const fixture = makeService();

    const result = await fixture.service.handleLookAround(42);

    expect(result).toContain('附近的玩家:冒险者2、小张');
  });

  it('当前地图增益：显示名称与剩余时间，过滤刷新资源内部标记', async () => {
    const fixture = makeService({
      map: {
        id: 7, name: '森林', isFrontier: false,
        monsters: '[]', resources: '[]', resources2: '[]', items: '[]', npcs: '[]', summons: '[]',
        markers2: JSON.stringify([
          { name: '战斗', expireAt: Date.now() + 60 * 1000 },
          { name: '刷新资源木头', expireAt: Date.now() + 1800 * 1000 },
        ]),
      },
    });

    const result = await fixture.service.handleLookAround(42);

    expect(result).toContain('当前地图增益:战斗（');
    expect(result).not.toContain('刷新资源');
  });

  it('躺下经验：躺下中显示每秒经验明细（等级/经验加成/陪睡/最终）', async () => {
    const fixture = makeService({ markers: { 躺下: 1 } });

    const result = await fixture.service.handleLookAround(42);

    expect(result).toContain('躺在床上');
    expect(result).toContain('每秒获得经验:0.05'); // 等级5 / 100
    expect(result).toContain('你的经验加成:20%');
    expect(result).toContain('陪睡NPC/宠物:0/2（+0%）');
    expect(result).toContain('最终每秒获得:');
  });

  it('自动开采显示：两个模式的时间戳折算为已开采时长', async () => {
    const fixture = makeService({
      markers: { 自动开采: Math.floor(Date.now() / 1000) - 120 },
    });

    const result = await fixture.service.handleLookAround(42);

    expect(result).toContain('已自动开采:2分');
  });

  it('自动采集资源文本：开启自动采集时显示附近资源与每分钟产出预估', async () => {
    const fixture = makeService({
      markers: { 自动采集: 1 },
      map: {
        id: 7, name: '森林', isFrontier: false,
        monsters: '[]', resources2: '[]', items: '[]', npcs: '[]', summons: '[]', markers2: '[]',
        resources: JSON.stringify([{
          name: '木头', times: 10, marker: '',
          outputs: [{ name: '木材', quantity: 4, chance: 100 }],
        }]),
      },
    });

    const result = await fixture.service.handleLookAround(42);

    expect(result).toContain('附近资源:木头,自动采集每分钟:');
    expect(result).toContain('木材x');
  });
});

describe('孤岛地图观察附近：提示「出口」为唯一出路（血族城堡/战舰坟场/太空/暗影岛）', () => {
  afterEach(() => jest.restoreAllMocks());

  function makeIsolatedService(isolated: boolean) {
    const fixture = makeService({
      map: {
        id: 88, name: '血族城堡', isFrontier: false,
        monsters: '[]', resources: '[]', resources2: '[]', items: '[]', npcs: '[]', summons: '[]',
        markers2: '[]',
        connections: JSON.stringify([{ name: '出口', distance: 100 }]),
      },
    });
    fixture.service.mapService.getConnections = jest.fn(() => [{ name: '出口', distance: 100 }]);
    fixture.service.mapService.isIsolatedMap = jest.fn(async () => isolated);
    return fixture;
  }

  it('孤岛地图：提示没有道路、出口为唯一出路，并把出口置顶为 1 号（不重复编号）', async () => {
    const fixture = makeIsolatedService(true);

    const result = await fixture.service.handleLookAround(42);

    expect(result).toContain('🚪 这里没有任何通往其它地图的道路');
    expect(result).toContain('唯一的出路是「出口」');
    expect(result).toContain('1、出口(唯一出路)');
    expect(result).not.toContain('2、出口');
  });

  it('非孤岛地图（有真实地图连接）不输出出口提示', async () => {
    const fixture = makeIsolatedService(false);

    const result = await fixture.service.handleLookAround(42);

    expect(result).not.toContain('这里没有任何通往其它地图的道路');
  });
});

describe('观察附近开拓地过滤（原版 地图操作.ecode L656-684 / L843-854）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('非自家开拓地不逐条列出，折叠为「家园(N个)」跳转查看家园', async () => {
    const fixture = makeService({
      houseName: '我家',
      connections: [
        { name: '城镇出口', distance: 100 },
        { name: '森林深处', distance: 130 },
        { name: '超新星10919494', distance: 10, isFrontier: true },
        { name: '桃花源', distance: 10, isFrontier: true },
        { name: '巅峰阁', distance: 10, isFrontier: true },
      ],
    });

    const result = await fixture.service.handleLookAround(42);

    expect(result).toContain('城镇出口');
    expect(result).toContain('森林深处');
    expect(result).toContain('家园(3个)');
    expect(result).not.toContain('超新星10919494');
    expect(result).not.toContain('桃花源');
    expect(result).not.toContain('巅峰阁');
  });

  it('自己的院子单独列出，且仍计入家园总数', async () => {
    const fixture = makeService({
      houseName: '我家',
      connections: [
        { name: '城镇出口', distance: 100 },
        { name: '我家', distance: 10, isFrontier: true },
        { name: '超新星999', distance: 10, isFrontier: true },
      ],
    });

    const result = await fixture.service.handleLookAround(42);

    expect(result).toContain('我家');
    expect(result).toContain('家园(2个)');
    expect(result).not.toContain('超新星999');
  });

  it('他人「xx屋内」开拓地入口单独列出；自家屋内不重复编号', async () => {
    const fixture = makeService({
      houseName: '我家',
      connections: [
        { name: '我家屋内', distance: 10, isFrontier: true },
        { name: '超新星888屋内', distance: 10, isFrontier: true },
        { name: '超新星777', distance: 10, isFrontier: true },
      ],
    });

    const result = await fixture.service.handleLookAround(42);

    expect(result).toContain('我家屋内');
    expect(result).toContain('超新星888屋内');
    expect(result).toContain('家园(3个)');
    expect(result).not.toContain('超新星777');
  });

  it('兼容开拓地字段名（isFrontier / 开拓地 / type）', async () => {
    const fixture = makeService({
      connections: [
        { name: 'A家园', distance: 10, 开拓地: true },
        { name: 'B家园', distance: 10, type: '开拓地' },
        { name: 'C家园', distance: 10, isFrontier: true },
        { name: '城镇出口', distance: 100 },
      ],
    });

    const result = await fixture.service.handleLookAround(42);

    expect(result).toContain('家园(3个)');
    expect(result).toContain('城镇出口');
    expect(result).not.toContain('A家园');
    expect(result).not.toContain('B家园');
    expect(result).not.toContain('C家园');
  });
});

describe('副本入口剩余时间展示（观察附近）', () => {
  afterEach(() => jest.restoreAllMocks());

  function makeEntryService(connections: any[]) {
    const fixture = makeService({
      map: {
        id: 7, name: '浅海', isFrontier: false,
        monsters: '[]', resources: '[]', resources2: '[]', items: '[]', npcs: '[]', summons: '[]',
        markers2: '[]',
      },
    });
    fixture.service.mapService.getConnections = jest.fn(() => connections);
    return fixture;
  }

  it('带 expireAt 的副本入口在编号列表附剩余时间，普通连接不附', async () => {
    const fixture = makeEntryService([
      { name: '沙滩', distance: 100 },
      { name: '扭曲深渊(副本)', mapId: 40, expireAt: Date.now() + 3 * 3600 * 1000 },
    ]);

    const result = await fixture.service.handleLookAround(42);

    expect(result).toContain('扭曲深渊(副本)(剩3小时)');
    expect(result).not.toContain('沙滩(剩');
  });

  it('无 expireAt 的存量入口不附剩余时间', async () => {
    const fixture = makeEntryService([
      { name: '灭绝之地(副本)', mapId: 41, distance: 100 },
    ]);

    const result = await fixture.service.handleLookAround(42);

    expect(result).toContain('灭绝之地(副本)');
    expect(result).not.toContain('(剩');
  });

  it('formatDungeonEntryRemaining 边界：无倒计时/已过期/分钟/小时/向上取整', () => {
    const now = Date.now();
    expect(formatDungeonEntryRemaining(0, now)).toBe('');
    expect(formatDungeonEntryRemaining(now - 1000, now)).toBe('已过期');
    expect(formatDungeonEntryRemaining(now + 30 * 1000, now)).toBe('剩1分钟');
    expect(formatDungeonEntryRemaining(now + 45 * 60 * 1000, now)).toBe('剩45分钟');
    expect(formatDungeonEntryRemaining(now + 3 * 3600 * 1000, now)).toBe('剩3小时');
    expect(formatDungeonEntryRemaining(now + 3 * 3600 * 1000 + 25 * 60 * 1000, now)).toBe('剩3小时25分');
    // 59分59秒 向上取整为「剩1小时」，避免临期显示误导性的「剩0分钟」
    expect(formatDungeonEntryRemaining(now + 3599 * 1000, now)).toBe('剩1小时');
  });
});
