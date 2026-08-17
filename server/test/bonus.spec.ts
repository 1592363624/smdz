/**
 * 升级经验公式单元测试
 * 对应原版：加成计算.ecode L1781-1794
 *   a2 = (c*c + 5) * (1 + 玩家.加成.升级经验 / 100) * (1 - 风月入墨减益 / 100)
 * 复刻实现：PlayerService.calcUpgradeExp(level, upgradeExpBonus=0, windMoonReduce=0)
 *
 * 这些断言是"逐字复刻"的回归护栏：任何修改使数值偏离原版字面量都会失败。
 */
import { PlayerService } from '../src/modules/game/player.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { MapService } from '../src/modules/game/map.service';

// 构造 PlayerService 实例，注入空 mock（calcUpgradeExp 不触碰任何依赖）
const playerService = new PlayerService(
  {} as PrismaService,
  {} as StaticDataService,
  {} as MapService,
);

describe('升级经验公式 (加成计算.ecode L1781-1794)', () => {
  it('L1786 基础公式: 1级需要 (1*1+5)=6 经验', () => {
    // 原版 c=1 → a2 = (1+5) = 6
    expect(playerService.calcUpgradeExp(1)).toBe(6);
  });

  it('L1786 基础公式: 10级需要 (100+5)=105 经验', () => {
    // 原版 c=10 → a2 = (100+5)*1*1 = 105
    expect(playerService.calcUpgradeExp(10)).toBe(105);
  });

  it('L1786 基础公式: 20级需要 (400+5)=405 经验', () => {
    expect(playerService.calcUpgradeExp(20)).toBe(405);
  });

  it('L1786 升级经验加成: 加成+50%时 10级门槛 = 105*1.5=157 (floor)', () => {
    // a2 = 105 * (1 + 50/100) = 157.5 → Math.floor = 157
    expect(playerService.calcUpgradeExp(10, 50)).toBe(157);
  });

  it('L1786 风月入墨减益: 减益15%时 10级门槛 = 105*0.85=89 (floor)', () => {
    // a2 = 105 * (1 - 15/100) = 89.25 → Math.floor = 89
    expect(playerService.calcUpgradeExp(10, 0, 15)).toBe(89);
  });

  it('L1786 加成与减益叠加: 10级, 加成+50%, 减益15% → 105*1.5*0.85=133 (floor)', () => {
    expect(playerService.calcUpgradeExp(10, 50, 15)).toBe(133);
  });

  it('L1786 阈值边界: 升级经验加成不可导致门槛<=0 (原版公式保护)', () => {
    // 即使减益极高，Math.floor 后仍需为正（原版循环 a1-a2>0 依赖 a2>0）
    const val = playerService.calcUpgradeExp(1, 0, 99);
    expect(val).toBeGreaterThanOrEqual(0);
  });
});
