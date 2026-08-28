/** 原版扫荡批量结算回归测试。 */
import { GameService } from '../src/modules/game/game.service';
import { VitalityService } from '../src/modules/game/vitality.service';

describe('扫荡活力批量结算', () => {
  function buildFixture() {
    const player: any = {
      userId: 42,
      id: 7,
      name: '扫荡测试者',
      mapId: 1,
      vitality: 3,
      type: '测试使魔',
      level: 1,
      currentWeapon: 0,
      markers: JSON.stringify({ 活力2: 100, 使用活力: 1, 击败史莱姆: 5 }),
      backpack: '[]',
      equipment: '[]',
      weapons: '[]',
      buffs: '[]',
      markers2: '[]',
      tasks: '[]',
      sets: '{}',
    };
    const playerData: any = {
      player,
      markers: { 活力2: 100, 使用活力: 1, 击败史莱姆: 5 },
      backpack: [],
      equipment: [],
      weapons: [],
      buffs: [],
      markers2: [],
      tasks: [],
      safeBox: [],
    };
    const playerService: any = {
      withUserLock: jest.fn((_userId: number, fn: () => Promise<any>) => fn()),
      getPlayerData: jest.fn(async () => playerData),
      savePlayer: jest.fn(async () => undefined),
      isPlayerDead: jest.fn(() => false),
      handlePlayerDeath: jest.fn(),
      safeJsonParse: (value: any, fallback: any) => {
        if (typeof value !== 'string') return value ?? fallback;
        try { return JSON.parse(value); } catch { return fallback; }
      },
      getMarkerValue: jest.fn((markers: any, key: string) => Number(markers?.[key] ?? 0)),
      getBackpackItems: jest.fn(() => []),
      addExp: jest.fn(async () => undefined),
    };
    const map = {
      id: 1,
      name: '森林',
      monsters: JSON.stringify(['史莱姆']),
      monsterCount: 2,
      markers3: JSON.stringify([]),
    };
    const mapService: any = {
      getMapById: jest.fn(async () => map),
      getMapMonsters: jest.fn(async () => [{ id: 99, name: '旧怪物', hp: 100 }]),
      clearMapMonsters: jest.fn(async () => undefined),
      createMapSummonByName: jest.fn(async () => ({
        name: '史莱姆',
        level: 1,
        exp: 10,
        bonus: JSON.stringify({ drops: [{ name: '木头', count: 2, chance: 100 }] }),
      })),
    };
    const combatSystem: any = {
      buildAttackerBonus: jest.fn(() => ({ 经验: 0, 掉落率: 0, 掉落品质: 0 })),
      generateDrops: jest.fn(() => [{ name: '木头', type: '资源', quantity: 2, chance: 100 }]),
      calcMonsterExp: jest.fn(() => 10),
    };
    const itemSystem: any = {
      distributeLoot: jest.fn(async (_data: any, drops: any[]) =>
        drops.map((drop) => `${drop.name}×${drop.quantity}`).join('、')),
    };
    const taskService: any = { advance: jest.fn(async () => undefined) };
    const systemConfig: any = { get: jest.fn(async (_key: string, fallback: any) => fallback) };
    const vitalityService = new VitalityService(systemConfig, playerService);
    const game = new GameService(
      {} as any,
      playerService,
      {} as any,
      combatSystem,
      {} as any,
      mapService,
      {} as any,
      {} as any,
      {} as any,
      { addAchievement: jest.fn(async () => undefined) } as any,
      itemSystem,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { getMonsterByName: jest.fn(() => ({ name: '史莱姆' })) } as any,
      systemConfig,
      {} as any,
      {} as any,
      taskService,
      {} as any,
      {} as any,
      {} as any,
      undefined,
    );
    (game as any).vitalityService = vitalityService;
    return { game, player, playerData, playerService, mapService, combatSystem, itemSystem, taskService };
  }

  it('扫荡10且当前活力为3时只结算3次，不触发普通击杀双倍或重复经验', async () => {
    const fixture = buildFixture();
    const result = await fixture.game.handleSweep(42, 10);

    expect(fixture.player.vitality).toBe(0);
    expect(fixture.mapService.clearMapMonsters).toHaveBeenCalledWith(1);
    expect(fixture.combatSystem.generateDrops).toHaveBeenCalledTimes(6);
    expect(fixture.itemSystem.distributeLoot).toHaveBeenCalledTimes(1);
    expect(fixture.itemSystem.distributeLoot.mock.calls[0][1]).toEqual([
      { name: '木头', type: '资源', quantity: 2, chance: 100 },
      { name: '木头', type: '资源', quantity: 2, chance: 100 },
      { name: '木头', type: '资源', quantity: 2, chance: 100 },
      { name: '木头', type: '资源', quantity: 2, chance: 100 },
      { name: '木头', type: '资源', quantity: 2, chance: 100 },
      { name: '木头', type: '资源', quantity: 2, chance: 100 },
    ]);
    expect(fixture.playerService.addExp).toHaveBeenCalledTimes(1);
    expect(fixture.playerService.addExp).toHaveBeenCalledWith(42, 60);
    expect(result).toContain('消耗3点活力');
    expect(result).toContain('得到了经验x60');
  });

  it('没有生命护盾装甲回复率时仍然结算活力恢复', async () => {
    const fixture = buildFixture();
    fixture.player.lastOpTime = BigInt(Date.now() - 1200 * 1000);
    fixture.player.readTime = BigInt(0);
    fixture.player.regenHp = 0;
    fixture.player.regenShield = 0;
    fixture.player.regenArmor = 0;
    fixture.player.vitality = 0;

    await fixture.game.calculateTimeElapsed(42);

    expect(fixture.player.vitality).toBeGreaterThan(0);
    expect(fixture.playerService.savePlayer).toHaveBeenCalled();
  });

  it('扫荡需求按地图怪物权重计算并限制在1到5次', () => {
    const fixture = buildFixture();
    const text = (fixture.game as any).buildSweepRequirementText(
      {
        markers: { 击败史莱姆: 5, 击败兔子: 1 },
      },
      ['史莱姆', '史莱姆', '史莱姆', '史莱姆', '史莱姆', '兔子'],
    );

    expect(text).toContain('史莱姆(5/5)');
    expect(text).toContain('兔子(1/4)');
  });
});
