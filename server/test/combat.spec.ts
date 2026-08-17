/**
 * 造成伤害核心模型单元测试
 * 对应原版：战斗相关.ecode L2274-2379（造成伤害 子程序）
 *
 * 复刻实现：CombatSystemService.calcDamage(atkBonus, defBonus, weapon, damageType, isCrit, opts)
 *
 * 覆盖点（与原版字面量逐字对齐）：
 *  - L2274 总伤害倍率 = 攻击命中 / 防御闪避
 *  - L2289 倍率×下限 > 1 时（命中/闪避>4），无索敌计算机则强制归一为 1
 *  - L2317 随机区间 [倍率×伤害下限, 1+伤害上限]
 *  - L2309-2379 三段暴击评级（绝杀>1.2 / 完美≥1 / 致命>0.8 / 强力>0.6 / 正中>0.4 / 擦过>0.2 / 描边）
 *  - L2395 暴击伤害 = 倍率 × (暴击伤害/100)
 *
 * 注：calcDamage 返回 DamageResult（含 damage/rating/critMultiplier），
 * 不暴露内部 dmgMult 局部变量，故测试通过 damage/rating/critMultiplier 间接断言。
 */
import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlayerService } from '../src/modules/game/player.service';
import { BonusService } from '../src/modules/game/bonus.service';
import { MapService } from '../src/modules/game/map.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { AchievementService } from '../src/modules/game/achievement.service';

// 构造 CombatSystemService 实例，注入空 mock（calcDamage 不触碰这些依赖）
const combat = new CombatSystemService(
  {} as PrismaService,
  {} as PlayerService,
  {} as BonusService,
  {} as MapService,
  {} as StaticDataService,
  {} as AchievementService,
);

// 最小武器：100 物伤、无属性偏向
const plainWeapon = {
  damage: 100,
  properties: { phys: 100, fire: 0, ice: 0, elec: 0 },
};

// 防御方无抗性，但提供充足生命池（hp），使伤害能落到生命层并反映倍率
// （原版中防御方始终有生命池；缺少则 distributeDamageToPools 按 Math.min(dmg,0)=0 归零）
const noResistDef = { dodge: 100, hp: 1_000_000, shield: 0, armor: 0 } as any;

describe('造成伤害 - 总伤害倍率与归一 (战斗相关.ecode L2274, L2289)', () => {
  it('L2274 倍率 = 命中/闪避 (正常区间, 不归一)', () => {
    // 命中200 / 闪避100 = 2.0；下限0.25 → 2*0.25=0.5<1 不触发归一
    const res = combat.calcDamage(
      { attack: 0, hit: 200 } as any,
      noResistDef,
      plainWeapon as any,
      1, false,
      { dmgLower: 0.25, dmgUpper: 0 },
    );
    // 倍率未归一，minMult = 2.0*0.25 = 0.5；基础攻击100 → damage 下限 ≈ 50
    expect(res.damage).toBeGreaterThanOrEqual(50);
  });

  it('L2289 命中/闪避>4 且无索敌计算机 → 倍率强制归一为1', () => {
    // 命中500 / 闪避100 = 5.0；下限0.25 → 5*0.25=1.25>1 触发归一
    const res = combat.calcDamage(
      { attack: 0, hit: 500 } as any,
      noResistDef,
      plainWeapon as any,
      1, false,
      { dmgLower: 0.25, dmgUpper: 0, sniperComputer: false },
    );
    // 归一后倍率应 <= 1 → 基础100 → damage <= 100
    expect(res.damage).toBeLessThanOrEqual(100);
  });

  it('L2289 命中/闪避>4 且有索敌计算机 → 保留原始倍率', () => {
    const res = combat.calcDamage(
      { attack: 0, hit: 500 } as any,
      noResistDef,
      plainWeapon as any,
      1, false,
      { dmgLower: 0.25, dmgUpper: 0, sniperComputer: true },
    );
    // 索敌计算机保留倍率，minMult=5*0.25=1.25 → damage >= 125
    expect(res.damage).toBeGreaterThanOrEqual(125);
  });
});

describe('造成伤害 - 随机区间边界 (战斗相关.ecode L2317)', () => {
  const mockRandom = (v: number) => jest.spyOn(Math, 'random').mockReturnValue(v);
  afterEach(() => jest.restoreAllMocks());

  it('L2317 random=0 时取下限 = 倍率×伤害下限', () => {
    mockRandom(0);
    // 命中200/闪避100=2；下限0.25 → minMult=0.5；基础100 → damage=50
    const res = combat.calcDamage(
      { attack: 0, hit: 200 } as any,
      noResistDef,
      plainWeapon as any,
      1, false,
      { dmgLower: 0.25, dmgUpper: 0 },
    );
    expect(res.damage).toBe(50);
  });

  it('L2317 random=0.999 时趋近上限 = 1+伤害上限', () => {
    mockRandom(0.999);
    // 命中200/闪避100=2；区间[0.5,1.5] → ≈1.499；基础100 → ≈149.9 → floor 149
    const res = combat.calcDamage(
      { attack: 0, hit: 200 } as any,
      noResistDef,
      plainWeapon as any,
      1, false,
      { dmgLower: 0.25, dmgUpper: 0.5 },
    );
    expect(res.damage).toBeGreaterThan(140);
    expect(res.damage).toBeLessThanOrEqual(150);
  });
});

describe('造成伤害 - 三段暴击评级阈值 (战斗相关.ecode L2309-2379)', () => {
  const mockRandom = (v: number) => jest.spyOn(Math, 'random').mockReturnValue(v);
  afterEach(() => jest.restoreAllMocks());

  it('评级【描边】: 倍率<0.2 时', () => {
    mockRandom(0);
    // 命中100/闪避1000=0.1 → 下限0.25 → 0.1*0.25=0.025 → 评级<0.2
    const res = combat.calcDamage(
      { attack: 0, hit: 100 } as any,
      { dodge: 1000, hp: 1_000_000, shield: 0, armor: 0 } as any,
      plainWeapon as any,
      1, false,
      { dmgLower: 0.25, dmgUpper: 0 },
    );
    expect(res.rating).toContain('描边');
  });

  it('评级【绝杀】: 倍率>1.2 时 (索敌计算机保留高倍率)', () => {
    mockRandom(0);
    const res = combat.calcDamage(
      { attack: 0, hit: 500 } as any,
      noResistDef,
      plainWeapon as any,
      1, false,
      { dmgLower: 0.25, dmgUpper: 0, sniperComputer: true }, // minMult=1.25>1.2
    );
    expect(res.rating).toContain('绝杀');
  });

  it('评级始终落在七级之一 (绝杀/完美/致命/强力/正中/擦过/描边)', () => {
    mockRandom(0);
    const res = combat.calcDamage(
      { attack: 0, hit: 110 } as any,
      noResistDef,
      plainWeapon as any,
      1, false,
      { dmgLower: 0.25, dmgUpper: 0, sniperComputer: true },
    );
    // rating 形如 "【擦过】28%"，提取【】之间的评级名
    const m = res.rating.match(/【(.+?)】/);
    const ratingName = m ? m[1] : '';
    expect(['绝杀', '完美', '致命', '强力', '正中', '擦过', '描边']).toContain(ratingName);
  });
});

describe('造成伤害 - 暴击伤害 (战斗相关.ecode L2395)', () => {
  it('L2395 isCrit 时倍率 × 暴击伤害/100 (默认150%→1.5)', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const resNoCrit = combat.calcDamage(
      { attack: 0, hit: 200, critDmg: 150 } as any,
      noResistDef,
      plainWeapon as any,
      1, false,
      { dmgLower: 0.25, dmgUpper: 0 },
    );
    const resCrit = combat.calcDamage(
      { attack: 0, hit: 200, critDmg: 150 } as any,
      noResistDef,
      plainWeapon as any,
      1, true,
      { dmgLower: 0.25, dmgUpper: 0 },
    );
    // 暴击后 damage 应约为非暴击的 1.5 倍
    expect(resCrit.damage).toBeCloseTo(resNoCrit.damage * 1.5, 0);
    expect(resCrit.critMultiplier).toBeCloseTo(1.5, 5);
    jest.restoreAllMocks();
  });
});
