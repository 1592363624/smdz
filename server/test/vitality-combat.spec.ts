/** 普通击杀活力奖励闭环回归测试。 */
import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { VitalityService } from '../src/modules/game/vitality.service';

describe('普通击杀活力奖励闭环', () => {
  it('强制开启覆盖个人关闭：扣1活力、经验和资源翻倍、装备不复制', async () => {
    const player = {
      userId: 7,
      vitality: 1,
      markers: JSON.stringify({ 使用活力: 1 }),
      equipment: '[]',
      backpack: '[]',
    };
    const playerData: any = {
      player,
      markers: { 使用活力: 1 },
      backpack: [],
      equipment: [],
      weapons: [],
      markers2: [],
      buffs: [],
      tasks: [],
      safeBox: [],
    };
    const playerService: any = {
      getMarkerValue: (markers: any, key: string) => Number(markers?.[key] ?? 0),
      safeJsonParse: (value: any, fallback: any) => {
        if (typeof value !== 'string') return value ?? fallback;
        try { return JSON.parse(value); } catch { return fallback; }
      },
      getBackpackItems: (target: any) => {
        if (Array.isArray(target.backpack)) return target.backpack;
        try { return JSON.parse(target.backpack || '[]'); } catch { return []; }
      },
      savePlayer: jest.fn(async () => undefined),
    };
    const systemConfig: any = {
      get: jest.fn(async () => true),
    };
    const vitality = new VitalityService(systemConfig, playerService);
    const itemSystem: any = {
      distributeLoot: jest.fn(async (_data: any, drops: any[], opts: any) => {
        for (const drop of drops) {
          if (drop.type !== '装备') opts?.onTaskProgress?.('采集资源', drop.quantity);
        }
        return drops.map((drop) => `${drop.name}×${drop.quantity}`).join('、');
      }),
    };
    const mapService: any = { removeMapMonster: jest.fn(async () => undefined) };
    const combat = new CombatSystemService(
      {} as any,
      playerService,
      {} as any,
      mapService,
      {} as any,
      { addAchievement: jest.fn(async () => undefined) } as any,
      itemSystem,
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      vitality,
    );
    jest.spyOn(combat, 'calcMonsterExp').mockReturnValue(10);
    jest.spyOn(combat, 'generateDrops').mockReturnValue([
      { name: '木头', type: '资源', quantity: 3 },
      { name: '铁剑', type: '装备', quantity: 1, data: 'e' },
    ]);
    jest.spyOn(combat, 'setDrop').mockReturnValue([]);

    const result = await combat.handleMonsterDeath(
      { id: 11, name: '史莱姆', markers: '[]' },
      7,
      1,
      playerData,
    );

    expect(player.vitality).toBe(0);
    expect(result.expGain).toBe(20);
    expect(itemSystem.distributeLoot).toHaveBeenCalledWith(
      playerData,
      [
        { name: '木头', type: '资源', quantity: 6 },
        { name: '铁剑', type: '装备', quantity: 1, data: 'e' },
      ],
      expect.any(Object),
    );
    expect(result.taskProgress).toContainEqual({ actionName: '消耗活力', count: 1 });
  });
});
