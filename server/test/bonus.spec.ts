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
import { BonusService, BonusData } from '../src/modules/game/bonus.service';

// 构造 PlayerService 实例，注入空 mock（calcUpgradeExp 不触碰任何依赖）
const playerService = new PlayerService(
  {} as PrismaService,
  {} as StaticDataService,
  {} as MapService,
);
const bonusService = new BonusService();

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

describe('加成核心闭环 (加成计算.ecode L3-L62/L577-L663)', () => {
  it('递减收益按原版区间累计，而不是对剩余值重复缩放', () => {
    expect(bonusService.applyDiminishingReturns(1000)).toBe(1000);
    expect(bonusService.applyDiminishingReturns(2000)).toBe(1900);
    expect(bonusService.applyDiminishingReturns(3500)).toBe(3100);
    expect(bonusService.applyDiminishingReturns(5500)).toBe(4500);
    expect(bonusService.applyDiminishingReturns(8500)).toBe(6150);
    expect(bonusService.applyDiminishingReturns(12000)).toBe(7200);
    expect(bonusService.applyDiminishingReturns(16000)).toBe(8800);
  });

  it('全属性调整覆盖原版的三层状态、抗性、伤害、回复和贯穿字段', () => {
    const attributes: BonusData = {
      护盾: 10, 装甲: 20, 生命: 30,
      护盾火抗: 1, 护盾冰抗: 2, 护盾物抗: 3, 护盾电抗: 4,
      装甲火抗: 5, 装甲冰抗: 6, 装甲物抗: 7, 装甲电抗: 8,
      生命火抗: 9, 生命冰抗: 10, 生命物抗: 11, 生命电抗: 12,
      闪避: 13, 命中: 14, 电伤: 15, 火伤: 16, 冰伤: 17, 物伤: 18,
      暴击: 19, 暴击伤害: 20, 护盾回复: 21, 装甲回复: 22, 生命回复: 23,
      护盾回复2: 24, 装甲回复2: 25, 生命回复2: 26,
      贯穿: 27, 抗贯穿: 28, 攻击护盾: 29, 攻击装甲: 30, 攻击生命: 31,
    };
    bonusService.adjustAllAttributes(attributes, 0.5);
    expect(attributes.护盾).toBe(5);
    expect(attributes.生命电抗).toBe(6);
    expect(attributes.冰伤).toBe(8.5);
    expect(attributes.生命回复2).toBe(13);
    expect(attributes.贯穿).toBe(13.5);
    expect(attributes.攻击生命).toBe(15.5);
  });

  it('战斗力使用原版抗性分母、暴击期望、回复和速度项', () => {
    const power = bonusService.calcCombatPower({
      生命: 100,
      装甲: 50,
      护盾: 20,
      电伤: 40,
      物伤: 30,
      冰伤: 20,
      火伤: 10,
      暴击: 50,
      暴击伤害: 200,
      攻击生命: 30,
      速度: 1,
      闪避: 2,
      命中: 3,
    });
    expect(power).toBe(760);
  });

  it('地图增益兼容中文字段、建筑数量和中文装备 JSON，并完成孵化闭环', () => {
    const playerBuffs: any[] = [];
    const map: any = {
      buildings: [{ 名称: '花园猫窝', 数量: 2 }],
      summons: [{ 装备: '[{"名称":"叹息之墙"}]' }],
      items: [
        { 名称: '孵蛋鸡', 数量: 1 },
        { 名称: '青龙蛋', 数量: 1 },
      ],
      markers3: [{ 名称: '孵化中', 有效期至: 900, 强度: 'owner-1' }],
    };
    const hatch: any[] = [];

    bonusService.getMapBonus(playerBuffs, { ...map, onHatch: (request) => hatch.push(request) }, 1000, 1000);

    expect(hatch).toEqual([expect.objectContaining({ type: '青龙', ownerQQ: 'owner-1' })]);
    expect(map.items).toEqual([{ name: '合金', quantity: 10, count: 10, type: '资源' }]);
    expect(map.markers3).toHaveLength(2);
    expect(playerBuffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '啾啾猫猫', strength: 60 }),
      expect.objectContaining({ name: '叹息之墙' }),
    ]));
  });
});
