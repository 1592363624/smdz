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

function makeService(options: { backpack?: any[]; mapResources?: any[]; inCooldown?: boolean } = {}) {
  const player: any = {
    id: 1,
    userId: 42,
    name: '冒险者',
    mapId: 7,
    markers: '{}',
    markers2: '[]',
    backpack: JSON.stringify(options.backpack ?? [{ name: '信号枪', quantity: 3 }]),
    hp: 100,
  };
  const map: any = {
    id: 7,
    name: '当前地图',
    resources: JSON.stringify(options.mapResources ?? []),
  };
  const scheduled: any[] = [];
  const savedPlayers: any[] = [];
  const mapMutations: any[] = [];
  const service: any = Object.create(GameService.prototype);
  const playerService: any = {
    getPlayerData: jest.fn(async () => ({
      player,
      markers: parseJson(player.markers, {}),
      markers2: parseJson(player.markers2, []),
      backpack: parseJson(player.backpack, []),
      equipment: [],
      weapons: [],
    })),
    isPlayerDead: jest.fn(() => false),
    savePlayer: jest.fn(async (value: any) => savedPlayers.push(value)),
    getMarkerValue: jest.fn((markers: any, key: string) => Number(markers?.[key] ?? 0)),
    enqueueUserWrite: jest.fn(async (_uid: number, fn: () => Promise<any>) => fn()),
  };
  Object.assign(service, {
    prisma: {},
    playerService,
    mapService: {
      getMapById: jest.fn(async () => map),
      mutateMapFields: jest.fn(async (_id: number, _fields: any, fn: (f: any) => any) => {
        const fields = { resources: parseJson(map.resources, []), markers2: [] };
        const changed = fn(fields);
        mapMutations.push({ fields, changed });
        map.resources = JSON.stringify(fields.resources);
        return changed;
      }),
    },
    combatState: {
      timeIntervalRequire: jest.fn((_name: string, _sec: number, _m: any, _n: number, text?: { value: string }) => {
        if (options.inCooldown && text) {
          text.value = '还需要9秒';
          return true;
        }
        return false;
      }),
    },
    taskService: { advance: jest.fn(async () => ''), consumeNotifications: jest.fn(() => '') },
    staticData: {
      getAllResources: jest.fn(() => [
        { name: '货舱', type: '资源', times: 1, gatherCmd: '打开货舱', renewable: false, outputs: [{ name: '能量块', count: 1, chance: 50 }] },
      ]),
    },
    delayedTaskService: {
      schedule: jest.fn(async (input: any) => {
        scheduled.push(input);
      }),
    },
    logger: { log: jest.fn(), warn: jest.fn() },
  });
  return { service, player, map, scheduled, savedPlayers, mapMutations, playerService };
}

describe('发射信号枪 → 召唤货舱延时链（原版 L6281-6333 复刻）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('数量<=0 返回用法提示，不消耗冷却也不排程', async () => {
    const fixture = makeService();

    const result = await fixture.service.handleSignalGun(42, '');

    expect(result).toContain('发射信号枪2');
    expect(fixture.scheduled).toHaveLength(0);
    expect(fixture.service.combatState.timeIntervalRequire).not.toHaveBeenCalled();
  });

  it('背包没有信号枪时拒绝', async () => {
    const fixture = makeService({ backpack: [{ name: '废铁', quantity: 2 }] });

    const result = await fixture.service.handleSignalGun(42, '2');

    expect(result).toContain('背包中需要有信号枪');
    expect(fixture.scheduled).toHaveLength(0);
  });

  it('10 秒冷却中不排程延时任务', async () => {
    const fixture = makeService({ inCooldown: true });

    const result = await fixture.service.handleSignalGun(42, '2');

    expect(result).toContain('还需要9秒');
    expect(fixture.scheduled).toHaveLength(0);
  });

  it('发射成功：推进召唤货舱成就、活跃度+1、6 秒后排程货舱结算', async () => {
    const fixture = makeService();

    const result = await fixture.service.handleSignalGun(42, '2');

    expect(result).toBe('冒险者发射了信号枪……');
    expect(fixture.service.taskService.advance).toHaveBeenCalledWith(42, '召唤货舱');
    const lastSaved = fixture.savedPlayers[fixture.savedPlayers.length - 1];
    expect(Number(parseJson(lastSaved.markers, {})['活跃度'])).toBe(1);
    expect(fixture.scheduled).toHaveLength(1);
    expect(fixture.scheduled[0]).toMatchObject({ type: 'cargo', userId: 42, payload: { count: 2 } });
    expect(fixture.scheduled[0].runAt).toBeLessThanOrEqual(Date.now() + 6 * 1000);
  });

  it('延时结算：扣除 2 把信号枪并在地图新增 6 个货舱', async () => {
    const fixture = makeService({ backpack: [{ name: '信号枪', quantity: 3 }] });

    await fixture.service.completeCargoSummon(42, 2);

    const lastSaved = fixture.savedPlayers[fixture.savedPlayers.length - 1];
    const backpack = parseJson(lastSaved.backpack, []);
    expect(backpack).toEqual([{ name: '信号枪', quantity: 1 }]);
    const resources = parseJson(fixture.map.resources, []);
    expect(resources).toHaveLength(1);
    expect(resources[0].name).toBe('货舱');
    expect(Number(resources[0].times)).toBe(6);
  });

  it('延时结算：地图已有货舱时叠加次数', async () => {
    const fixture = makeService({
      backpack: [{ name: '信号枪', quantity: 1 }],
      mapResources: [{ name: '货舱', times: 3 }],
    });

    await fixture.service.completeCargoSummon(42, 1);

    const resources = parseJson(fixture.map.resources, []);
    expect(resources).toHaveLength(1);
    expect(Number(resources[0].times)).toBe(6);
  });

  it('延时结算：背包没有信号枪时不生成货舱', async () => {
    const fixture = makeService({ backpack: [] });

    await fixture.service.completeCargoSummon(42, 2);

    expect(parseJson(fixture.map.resources, [])).toHaveLength(0);
  });
});
