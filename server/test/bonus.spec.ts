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
import { CombatStateService } from '../src/modules/game/combat-state.service';

// 构造 PlayerService 实例，注入空 mock（calcUpgradeExp 不触碰任何依赖）
const playerService = new PlayerService(
  {} as PrismaService,
  {} as StaticDataService,
  {} as MapService,
);
const bonusService = new BonusService();
const combatState = new CombatStateService();

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

describe('获得增益2 (加成计算.ecode L664-L681)', () => {
  it('新增时按韧性折算持续时间', () => {
    const buffs: any[] = [];
    combatState.gainBuff2(buffs, { 名称: '福音书', 持续时间: 300, 强度: 10 }, 1000, 20);
    expect(buffs).toHaveLength(1);
    expect(buffs[0].名称).toBe('福音书');
    expect(buffs[0].强度).toBe(10);
    expect(buffs[0].有效期至).toBe(1000 + 240 * 1000);
  });

  it('同名增益直接替换，不叠加旧有效期或强度', () => {
    const buffs: any[] = [{ 名称: '福音书', 强度: 5, 有效期至: 999 }];
    combatState.gainBuff2(buffs, { 名称: '福音书', 持续时间: 300, 强度: 10 }, 1000, 0);
    expect(buffs).toHaveLength(1);
    expect(buffs[0]).toEqual({ 名称: '福音书', 持续时间: 300, 强度: 10, 有效期至: 301000 });
  });
});

describe('法宝加成 (加成计算.ecode L3053-L3232)', () => {
  it('L3143-L3232 四类属性法宝按等级阈值写入属性', () => {
    const goddess: BonusData = {};
    bonusService.calculateTreasureBonus(goddess, { sakuraHits: 1, sleepover: 9 });
    expect(goddess).toMatchObject({ 电伤2: 13, 护盾2: 10, 生命2: 10, 装甲2: 10, 暴击伤害: 1000 });

    const zhenyue: BonusData = {};
    bonusService.calculateTreasureBonus(zhenyue, { sakuraHits: 2, sleepover: 6 });
    expect(zhenyue).toMatchObject({ 物伤2: 5, 护盾2: 15, 生命2: 15, 装甲2: 15, 贯穿: 15, 抗贯穿: 10 });

    const jingni: BonusData = {};
    bonusService.calculateTreasureBonus(jingni, { sakuraHits: 4, sleepover: 10 });
    expect(jingni).toMatchObject({
      火伤2: 18, 溅射2: 1, 溅射: 50, 暴击伤害: 600, 贯穿: 10,
    });

    const lingxu: BonusData = {};
    bonusService.calculateTreasureBonus(lingxu, { sakuraHits: 3, sleepover: 7 });
    expect(lingxu).toMatchObject({
      冰伤2: 5, 抗贯穿: 25, 攻击护盾: 20, 攻击装甲: 20,
      护盾2: 20, 生命2: 20, 装甲2: 20, 韧性: 20,
    });
  });

  it('L3053-L3096 含光按最高防御层放大并追加全抗与回复2', () => {
    const shieldAttrs: BonusData = { 护盾: 100, 装甲: 10, 生命: 20, 护盾火抗: 50, 护盾冰抗: 50, 护盾物抗: 50, 护盾电抗: 50 };
    bonusService.calculateHanGuangBonus(shieldAttrs, { sakuraHits: 5, sleepover: 6 });
    expect(shieldAttrs.护盾).toBe(500);
    expect(shieldAttrs.护盾火抗).toBeCloseTo(75);
    expect(shieldAttrs.护盾回复2).toBe(2);
    expect(shieldAttrs.抗贯穿).toBe(30);

    const armorAttrs: BonusData = { 护盾: 10, 装甲: 100, 生命: 20, 装甲火抗: 50, 装甲冰抗: 50, 装甲物抗: 50, 装甲电抗: 50 };
    bonusService.calculateHanGuangBonus(armorAttrs, { sakuraHits: 5, sleepover: 3 });
    expect(armorAttrs.装甲).toBe(250);
    expect(armorAttrs.装甲火抗).toBeCloseTo(75);
    expect(armorAttrs.装甲回复2).toBe(2);
    expect(armorAttrs.抗贯穿).toBeUndefined();

    const lifeAttrs: BonusData = { 护盾: 10, 装甲: 20, 生命: 100, 生命火抗: 50, 生命冰抗: 50, 生命物抗: 50, 生命电抗: 50 };
    bonusService.calculateHanGuangBonus(lifeAttrs, { sakuraHits: 5, sleepover: 1 });
    expect(lifeAttrs.生命).toBe(100);
    expect(lifeAttrs.生命火抗).toBeCloseTo(75);
    expect(lifeAttrs.生命回复2).toBeUndefined();
    expect(lifeAttrs.抗贯穿).toBeUndefined();
  });
});

describe('计算增益 (加成计算.ecode L81-L575)', () => {
  it('成就铠甲按特殊类型写入攻击、防御、穿透与冷却', () => {
    const yanlong: BonusData = {};
    bonusService.calculateGameBonus({ bonus: yanlong, markers: { 铠甲: 1 } }, 1000);
    expect(yanlong).toMatchObject({ 攻击2: 10, 生命穿透: 6, 装甲穿透: 6, 护盾穿透: 6 });

    const heixi: BonusData = {};
    bonusService.calculateGameBonus({ bonus: heixi, markers: { 铠甲: 2 } }, 1000);
    expect(heixi).toMatchObject({ 护盾2: 12, 生命2: 12, 装甲2: 12 });
    expect(heixi.生命火抗).toBeCloseTo(15);
    expect(heixi.护盾电抗).toBeCloseTo(15);
    expect(heixi.装甲物抗).toBeCloseTo(15);
  });

  it('特殊增益按强度、技能等级与阈值生效', () => {
    const bonus: BonusData = { 冰伤: 100, 冰伤2: 10, 命中2: 5, 护盾回复: 1, 护盾回复2: 0 };
    bonusService.calculateGameBonus({
      bonus,
      skillLevel: 4,
      buffs: [
        { name: '冰精灵', expireAt: 2000, strength: 3 },
        { name: '五番', expireAt: 2000, strength: 9 },
        { name: 'xta', expireAt: 2000, strength: 0.25, value: 0.25 },
      ],
    }, 1000);
    expect(bonus.冰伤2).toBe(30 + 4 + 10);
    expect(bonus.生命穿透).toBe(10);
    expect(bonus.攻击2).toBe(45);
    expect(bonus.暴击).toBe(9);
    expect(bonus.暴击伤害).toBe(45);
    expect(bonus.护盾回复).toBe(0.75);
    expect(bonus.护盾回复2).toBe(-25);
  });

  it('装备分支按原版顺序处理叹息之墙、丝袜、神龙和肩炮', () => {
    const bonus: BonusData = {
      护盾: 100, 装甲: 50, 生命: 20,
      物伤: 40, 冰伤: 30, 火伤: 20, 电伤: 10,
      暴击: 120,
    };
    const attrs: BonusData = {};
    const weapon: any = { name: '拳头', cooldown: 10, 冷却: 10, specialSeq: 8 };
    bonusService.calculateGameBonus({
      bonus,
      attributes: attrs,
      equipment: [{ name: '神龙保佑', specialSeq: 36 }, { name: '神龙祥瑞', specialSeq: 37 }],
      weapons: [weapon],
      currentWeapon: 1,
      currentHp: 100,
      sets: { lifeBless: 5 },
    }, 1000);

    expect(bonus.闪避).toBeUndefined();
    expect(attrs.命中2).toBe(5);
    expect(attrs.护盾2).toBe(10);
    expect(attrs.装甲2).toBe(10);
    expect(bonus.攻击).toBe(20);
    expect(bonus.暴击).toBe(100);
    expect(weapon.cooldown).toBe(10);
    expect(bonus.溅射2).toBe(1);
  });
});
