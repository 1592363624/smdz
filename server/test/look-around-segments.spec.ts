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

function makeService(options: { markers?: Record<string, any>; map?: any } = {}) {
  const player: any = {
    id: 1, userId: 42, name: '冒险者', mapId: 7, level: 5, expBonus: 20,
    markers: JSON.stringify(options.markers ?? {}),
    markers2: '[]',
  };
  const map: any = options.map || {
    id: 7, name: '森林', isFrontier: false,
    monsters: '[]', resources: '[]', resources2: '[]',
    items: '[]', npcs: '[]', summons: '[]', markers2: '[]',
  };
  const service: any = Object.create(GameService.prototype);
  Object.assign(service, {
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
      getConnections: jest.fn(() => []),
    },
    combatState: {},
    combatSystem: {
      buildAttackerBonus: jest.fn(() => { throw new Error('no bonus'); }),
    },
    familiarSystemService: { checkAndUpdateGrowth: jest.fn(() => false) },
    shortcutService: { setTempInput: jest.fn(async () => undefined) },
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
          outputs: [{ name: '木材', count: 4, chance: 100 }],
        }]),
      },
    });

    const result = await fixture.service.handleLookAround(42);

    expect(result).toContain('附近资源:木头,自动采集每分钟:');
    expect(result).toContain('木材x');
  });
});
