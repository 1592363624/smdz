/** 活力规则单测：先固定原版结算契约，再接入战斗和扫荡入口。 */
import { VitalityService } from '../src/modules/game/vitality.service';

describe('VitalityService', () => {
  function build(forceVitality = false) {
    const systemConfig: any = {
      get: jest.fn(async (_key: string, fallback: boolean) => forceVitality || fallback),
    };
    const playerService: any = {
      getMarkerValue: jest.fn((markers: Record<string, any>, key: string) => Number(markers?.[key] ?? 0)),
    };
    return new VitalityService(systemConfig, playerService);
  }

  it('管理员强制开启时覆盖玩家关闭设置，并在普通击杀消耗活力后启用双倍奖励', async () => {
    const service = build(true);
    const player = { vitality: 3 };
    const decision = await service.applyNormalKillCost(player, { 使用活力: 1 }, 1);

    expect(decision.forced).toBe(true);
    expect(decision.enabled).toBe(true);
    expect(decision.vitalityCost).toBe(1);
    expect(decision.rewardMultiplier).toBe(2);
    expect(player.vitality).toBe(2);
  });

  it('玩家关闭活力且管理员未强制时不扣除活力，也不触发双倍奖励', async () => {
    const service = build(false);
    const player = { vitality: 3 };
    const decision = await service.applyNormalKillCost(player, { 使用活力: 1 }, 1);

    expect(decision.enabled).toBe(false);
    expect(decision.vitalityCost).toBe(0);
    expect(decision.rewardMultiplier).toBe(1);
    expect(player.vitality).toBe(3);
  });

  it('活力不足时普通击杀只按实际可消耗数量决定倍率，扫荡永远不走双倍奖励', async () => {
    const service = build(true);
    const player = { vitality: 2 };
    const normal = await service.applyNormalKillCost(player, { 使用活力: 0 }, 3);

    expect(normal.vitalityCost).toBe(2);
    expect(normal.rewardMultiplier).toBe(2);
    expect(player.vitality).toBe(0);
    expect(service.getSweepCount(10, player.vitality)).toBe(0);

    const sweep = await service.decide({ vitality: 4 }, { 使用活力: 0 }, { mode: 'sweep', killedCount: 4 });
    expect(sweep.vitalityCost).toBe(0);
    expect(sweep.rewardMultiplier).toBe(1);
    expect(service.getSweepCount(10, 4)).toBe(4);
  });

  it('记录魅力使用历史最高值，活力恢复按原版20分钟基准并封顶', () => {
    const service = build();
    const markers: Record<string, any> = {};

    expect(service.recordHighestCharm(markers, 50)).toBe(150);
    expect(service.recordHighestCharm(markers, 10)).toBe(150);
    expect(service.getVitalityMax(markers)).toBe(150);
    expect(service.recover(0, 1200, 150)).toBe(1.25);
    expect(service.recover(149, 1200, 150)).toBe(150);
  });
});
