import { AutoMineService } from '../src/modules/game/auto-mine.service';

function makeFixture(options: {
  parts?: string[];
  summons?: number;
  resources?: any[];
} = {}) {
  const player: any = {
    id: 1,
    userId: 42,
    name: '测试玩家',
    mapId: 7,
    vehicle: 'v1',
    markers: '{}',
    markers2: '[]',
    backpack: '[]',
    bonus: '{}',
  };
  const map: any = {
    id: 7,
    name: '测试地图',
    isInstance: false,
    resources: JSON.stringify(options.resources || [{
      name: '矿脉',
      marker: '',
      outputs: [{ name: '铁矿', count: 2, chance: 100 }],
    }]),
    vehicles: JSON.stringify([{
      id: 'v1',
      name: '采集车',
      currentHp: 100,
      parts: (options.parts || ['激光采集器']).map((name) => ({ name })),
    }]),
    summons: JSON.stringify(Array.from({ length: options.summons || 0 }, (_, index) => ({
      name: `使魔${index + 1}`,
      ownerQQ: '42',
      hp: 100,
    }))),
  };
  const taskService = { advance: jest.fn(async () => '') };
  const itemSystem = {
    distributeLoot: jest.fn(async (playerData: any, drops: any[], optionsArg: any) => {
      playerData.player.backpack = JSON.stringify(drops);
      for (const drop of drops) {
        if (drop.quantity > 0) optionsArg?.onTaskProgress?.('采集资源', drop.quantity);
        if (drop.quantity > 0) optionsArg?.onTaskProgress?.(`采集${drop.name}`, drop.quantity);
      }
      return drops.map((drop) => `${drop.name}×${drop.quantity}`).join('、');
    }),
  };
  const playerService = {
    getPlayerData: jest.fn(async () => ({
      player,
      markers: JSON.parse(player.markers),
      markers2: [],
    })),
    safeJsonParse: jest.fn((value: any, fallback: any) => {
      if (value === undefined || value === null) return fallback;
      if (typeof value !== 'string') return value;
      try {
        const parsed = JSON.parse(value);
        return parsed ?? fallback;
      } catch {
        return fallback;
      }
    }),
    savePlayer: jest.fn(async () => undefined),
  };
  const prisma = {
    player: {
      findMany: jest.fn(async () => [{ userId: 42 }]),
    },
  };
  const service = new AutoMineService(
    prisma as any,
    playerService as any,
    { getMapById: jest.fn(async () => map) } as any,
    { getEquipmentByName: jest.fn(() => undefined) } as any,
    { buildAttackerBonus: jest.fn(() => ({ 采集: 100 })) } as any,
    itemSystem as any,
    taskService as any,
  );
  return { service, player, map, playerService, itemSystem, taskService, prisma };
}

describe('自动开采闭环', () => {
  it('要求载具采集器，并写入自动开采开始时间', async () => {
    const missing = makeFixture({ parts: [] });
    await expect(missing.service.start(42, 1_000_000)).resolves.toContain('需要安装');
    expect(missing.player.markers).toBe('{}');

    const fixture = makeFixture({ summons: 1 });
    await expect(fixture.service.start(42, 1_000_000)).resolves.toContain('预计每小时产出');
    expect(JSON.parse(fixture.player.markers)['自动开采']).toBe(1000);
  });

  it('按每小时公式结算并推进采集任务', async () => {
    const fixture = makeFixture({ summons: 2 });
    await fixture.service.start(42, 1_000_000);
    const result = await fixture.service.stop(42, 4_600_000);

    // 2份基础产出 × 160 × (1+100/100) × (2名使魔+1) = 1920。
    expect(result).toContain('铁矿×1920');
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '采集资源', 1920);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '采集铁矿', 1920);
    expect(JSON.parse(fixture.player.markers)['自动开采']).toBeUndefined();
  });

  it('后台按分钟增量结算但保留进行中标记', async () => {
    const fixture = makeFixture();
    await fixture.service.start(42, 1_000_000);
    await expect(fixture.service.checkpointAll(1_060_000)).resolves.toBe(1);

    expect(JSON.parse(fixture.player.markers)['自动开采']).toBe(1060);
    expect(fixture.itemSystem.distributeLoot).toHaveBeenCalledTimes(1);
  });

  it('硅基核心阿尔法使用自动开采2标记', async () => {
    const fixture = makeFixture({ parts: ['激光采集器', '硅基核心阿尔法'] });
    await fixture.service.start(42, 1_000_000);
    const markers = JSON.parse(fixture.player.markers);
    expect(markers['自动开采2']).toBe(1000);
    expect(markers['自动开采']).toBeUndefined();
  });
});
