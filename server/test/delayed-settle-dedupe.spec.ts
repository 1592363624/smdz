import { GameService } from '../src/modules/game/game.service';

/**
 * 延时任务（救援/采集）结算去重回归：
 * 进程内定时器与每5秒兜底扫描是两个并发结算入口，若同一到期标记被重入，
 * 会出现"感觉好一点了吗？恢复了N生命"/"收集到了…"重复广播刷屏。
 * 本套用例锁定：认领失败的调用不得产出、不得广播，恰好一次结算。
 */

function parseJson(value: any, fallback: any): any {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/** CAS 语义的 player.updateMany：库中快照与 where 不一致时返回 count=0 */
function makeCasUpdateMany(player: any) {
  return jest.fn(async ({ where, data }: any) => {
    for (const field of ['markers', 'markers2'] as const) {
      if (where[field] !== undefined && where[field] !== null && player[field] !== where[field]) {
        return { count: 0 };
      }
    }
    Object.assign(player, data);
    return { count: 1 };
  });
}

function makeRescueFixture(playerOverrides: Record<string, any> = {}) {
  const player: any = {
    id: 1,
    userId: 1,
    name: '冒险者',
    mapId: 7,
    hp: 0,
    maxHp: 88,
    markers: '{}',
    markers2: '[]',
    ...playerOverrides,
  };
  const map: any = { id: 7, name: '医疗室', summons: '[]', vehicles: '[]' };
  const taskService = { advance: jest.fn(async () => '') };
  const playerService: any = {
    getPlayerData: jest.fn(async () => ({
      player,
      markers: parseJson(player.markers, {}),
      markers2: parseJson(player.markers2, []),
    })),
    safeJsonParse: jest.fn(parseJson),
    isPlayerDead: jest.fn((target: any) => Number(target?.hp || 0) <= 0),
    savePlayer: jest.fn(async () => undefined),
  };
  const prisma: any = {
    player: {
      findMany: jest.fn(async () => [player]),
      updateMany: makeCasUpdateMany(player),
    },
  };
  const chatService = {
    broadcastSystem: jest.fn(async () => undefined),
    emitToUser: jest.fn(async () => undefined),
  };
  const service: any = Object.create(GameService.prototype);
  Object.assign(service, {
    prisma,
    playerService,
    taskService,
    chatService,
    mapService: {
      getMapById: jest.fn(async () => map),
      getAllMaps: jest.fn(async () => [map]),
    },
    rescueTimers: new Map<number, NodeJS.Timeout>(),
    gatherTimers: new Map<number, NodeJS.Timeout>(),
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    performArrival: jest.fn(async (_userId: number, _mapId: number, name: string) => `你来到了【${name}】`),
  });
  return { service, player, chatService, prisma, taskService };
}

function makeGatherFixture(options: { times?: number } = {}) {
  const resource = {
    name: '老树',
    times: options.times ?? 5,
    outputs: [{ name: '木头', count: 2, chance: 100 }],
    gatherCmd: '收集木头',
  };
  const player: any = {
    id: 42,
    userId: 42,
    name: '测试玩家',
    level: 10,
    mapId: 7,
    backpack: '[]',
    // 采集中状态 + 采集锁定标记（handleGatherResource 阶段1 的落库结果）
    markers: JSON.stringify({ 采集中: { target: '老树', cmd: '收集木头', count: 1, settleAt: Date.now() - 1000 } }),
    markers2: JSON.stringify([{ 名称: '采集', 有效期至: Date.now() / 1000 + 30 }]),
  };
  const map: any = {
    id: 7,
    name: '测试地图',
    resources: JSON.stringify([resource]),
    resources2: '[]',
    summons: '[]',
    vehicles: '[]',
    markers2: '[]',
  };
  const taskService = { advance: jest.fn(async () => ''), acceptTask: jest.fn(async () => '') };
  const playerService: any = {
    getPlayerData: jest.fn(async () => ({
      player,
      markers: parseJson(player.markers, {}),
      markers2: parseJson(player.markers2, []),
    })),
    safeJsonParse: jest.fn(parseJson),
    getBackpackItems: jest.fn((target: any) => parseJson(target.backpack, [])),
    savePlayer: jest.fn(async () => undefined),
    addExp: jest.fn(async () => ({ leveledUp: false, newLevel: 10 })),
  };
  const prisma: any = {
    player: {
      findMany: jest.fn(async () => [player]),
      updateMany: makeCasUpdateMany(player),
    },
    gameMap: {
      update: jest.fn(async ({ data }: any) => {
        Object.assign(map, data);
        return map;
      }),
    },
  };
  const itemSystemService = {
    generateRewardEquipment: jest.fn(async (name: string) => ({ name, type: '装备', data: 'e!bx0' })),
  };
  const combatSystem: any = {
    buildAttackerBonus: jest.fn(() => ({ 采集: 0, 掉落率: 0, 经验: 0 })),
    adminAttackMap: jest.fn(async () => '攻击'),
  };
  const chatService = {
    broadcastSystem: jest.fn(async () => undefined),
    emitToUser: jest.fn(async () => undefined),
  };
  const service: any = Object.create(GameService.prototype);
  Object.assign(service, {
    prisma,
    playerService,
    taskService,
    itemSystemService,
    combatSystem,
    chatService,
    mapService: { getMapById: jest.fn(async () => map), getMapMonsters: jest.fn(async () => []) },
    staticData: { getEquipmentByName: jest.fn(() => undefined) },
    gatherTimers: new Map<number, NodeJS.Timeout>(),
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    pushPlayerUpdate: jest.fn(async () => undefined),
    pushMapUpdate: jest.fn(async () => undefined),
  });
  return { service, player, map, chatService, taskService };
}

describe('延时结算去重（救援/采集恰好一次）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('定时器与兜底并发进入同一到期自救标记时，只有一方广播结算文本', async () => {
    const marker = { name: '复活', rescueType: 'self', expireAt: 900, token: 'tok-1' };
    const fixture = makeRescueFixture({ markers2: JSON.stringify([marker]) });

    const [first, second] = await Promise.all([
      (fixture.service as any).completeRescue(1, marker),
      (fixture.service as any).completeRescue(1, marker),
    ]);

    expect(first).toContain('感觉好一点了吗');
    expect(second).toBe('');
    expect(fixture.chatService.broadcastSystem).toHaveBeenCalledTimes(1);
    expect(fixture.player.hp).toBe(44);
    expect(JSON.parse(fixture.player.markers2)).toEqual([]);
  });

  it('兜底扫描在结算完成后再次进入同一标记时不再广播', async () => {
    const marker = { name: '复活', rescueType: 'self', expireAt: 900, token: 'tok-2' };
    const fixture = makeRescueFixture({ markers2: JSON.stringify([marker]) });

    await expect((fixture.service as any).completeRescue(1, marker)).resolves.toContain('感觉好一点了吗');
    await expect((fixture.service as any).completeRescue(1, marker)).resolves.toBe('');

    expect(fixture.chatService.broadcastSystem).toHaveBeenCalledTimes(1);
    expect(fixture.player.hp).toBe(44);
  });

  it('救援兜底熔断：60秒内连续触发超过3次后自愈清除标记且不广播', async () => {
    const fixture = makeRescueFixture({
      markers2: JSON.stringify([{ name: '复活', rescueType: 'self', expireAt: 900, token: 'tok-3' }]),
    });
    // 模拟此前已连续触发3次、最近一次在16秒前（超过15秒最小间隔、仍在60秒窗口内）
    (fixture.service as any).rescueFallbackAt = new Map([[1, Date.now() - 16_000]]);
    (fixture.service as any).rescueFallbackCount = new Map([[1, 3]]);

    await expect(fixture.service.settlePendingRescues()).resolves.toBe(1);

    expect(fixture.chatService.broadcastSystem).not.toHaveBeenCalled();
    expect(fixture.player.hp).toBe(0); // 未复活
    expect(JSON.parse(fixture.player.markers2)).toEqual([]); // 到期标记被清除
  });

  it('采集定时器与兜底并发进入同一次采集时，只产出并广播一次', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const fixture = makeGatherFixture();

    const [first, second] = await Promise.all([
      fixture.service.settleGatherResource(42),
      fixture.service.settleGatherResource(42),
    ]);

    const settledTexts = [first, second].filter((text: string) => text.includes('收集到了'));
    expect(settledTexts).toHaveLength(1);
    expect(fixture.chatService.broadcastSystem).toHaveBeenCalledTimes(1);
    const backpack = JSON.parse(fixture.player.backpack);
    expect(backpack).toEqual([expect.objectContaining({ name: '木头', count: 2 })]);
    // 资源次数只扣一次
    expect(JSON.parse(fixture.map.resources)[0].times).toBe(4);
    const advanceCalls = (fixture.taskService.advance as jest.Mock).mock.calls.filter(
      (call) => call[1] === '采集',
    );
    expect(advanceCalls).toHaveLength(1);
  });
});
