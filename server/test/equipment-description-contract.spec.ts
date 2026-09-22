/**
 * 装备/特效「描述文案 → 实现」契约回归
 *
 * 背景：特效与装备的 `description` 是玩家唯一能读到的规则说明。本套件把审计中确认过的
 * 几类「描述与实现不一致」固化为断言，防止再次漂移：
 *   1. effects.json 里 [方括号] 声明的元素伤害特效必须放大**对应元素**，
 *      而不是像原版那样把物理伤害覆写成另一元素（会把武器物伤清零）。
 *   2. 植入体 特殊序号 → 套装.植入体 的映射必须是 1物/2火/3冰/4电
 *      （@Struct.ecode L367），且按序号与按名称两条分支必须给出同一个编码。
 *   3. 静态装备 properties.damage（原版「伤害=物90 火10」）必须进入战斗侧的武器伤害配比，
 *      否则面板显示「物理90%/火焰10%」而实战按 100% 物理结算。
 *   4. titles.json 的 bonus 必须真的并入玩家加成（原版 加成计算.ecode L1625-1632）。
 *   5. 存档装备条目缺 specialSeq 时必须按静态定义补齐：战斗里绝大多数装备效果
 *      按序号判定（棒棒糖97、射爆核心29…），缺序号会让这些描述整体静默失效。
 */
import { BonusService } from '../src/modules/game/bonus.service';
import { SkillCommandService } from '../src/modules/game/commands/skill-command.service';
import { CombatStateService } from '../src/modules/game/combat-state.service';
import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { FamiliarSkillsService } from '../src/modules/game/familiar-skills.service';
import { MapService } from '../src/modules/game/map.service';
import { AchievementService } from '../src/modules/game/achievement.service';
import { PlayerService } from '../src/modules/game/player.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { StatsService } from '../src/modules/game/stats.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { applyEquipmentEffect, createEffectTarget } from '../src/modules/game/equipment-effect.util';
import {
  backfillSpecialSeq,
  lookupFromStaticData,
} from '../src/modules/game/item-normalize.util';

const GAUSS = {
  name: '高斯步枪',
  equipType: '射弹武器',
  specialSeq: -1,
  cooldown: 10,
  lockTime: 0,
  damageType: '物理',
  bonus: { 冷却: 10, 贯穿: 10 },
  baseBonus: {},
  // 原版 使魔大战.txt [高斯步枪] 伤害=物90 火10
  properties: { damage: { 物理: 90, 火焰: 10 } },
};

const buildCombatWith = (defs: any[]) => new CombatSystemService(
  {} as PrismaService,
  {
    safeJsonParse: <T>(v: any, fallback: T): T => {
      if (typeof v !== 'string') return (v ?? fallback) as T;
      try { return JSON.parse(v) as T; } catch { return fallback; }
    },
    getMarkerValue: () => 0,
  } as unknown as PlayerService,
  new BonusService(),
  {} as MapService,
  {
    getEquipmentByName: (name: string) => defs.find((d) => d.name === name),
    isWeapon: (def: any) => String(def?.equipType ?? '').endsWith('武器'),
    getEffectById: () => undefined,
  } as unknown as StaticDataService,
  {} as AchievementService,
  {} as any,
  {} as CombatStateService,
  {} as StatsService,
);

/**
 * 防御被动专用实例：combatState 用真实实例（冷却/成就熟练度/增益副作用都经由它），
 * 静态定义桩只用于 specialSeq 补齐（测试夹具自带 specialSeq，无需查表）。
 */
const buildGuardCombat = () => new CombatSystemService(
  {} as PrismaService,
  {
    safeJsonParse: <T>(v: any, fallback: T): T => {
      if (typeof v !== 'string') return (v ?? fallback) as T;
      try { return JSON.parse(v) as T; } catch { return fallback; }
    },
  } as unknown as PlayerService,
  new BonusService(),
  {} as MapService,
  { getEquipmentByName: () => undefined } as unknown as StaticDataService,
  {} as AchievementService,
  {} as any,
  new CombatStateService(),
  {} as StatsService,
);

const weaponPool: any[] = []; // 本套件只用编号，池条目传 undefined 即可（缩放发生在池判定之前）

const scale = (effectId: number) => {
  const target = createEffectTarget({ phys: 80, fire: 40, ice: 20, elec: 10 }, 10);
  applyEquipmentEffect(target, undefined, true, effectId);
  return target.properties;
};

describe('特效：元素伤害缩放按 effects.json 描述生效', () => {
  it('37 天行者：物/火/冰/电 全部 ×1.15', () => {
    const p = scale(37);
    expect(p.phys).toBeCloseTo(92, 6);
    expect(p.fire).toBeCloseTo(46, 6);
    expect(p.ice).toBeCloseTo(23, 6);
    expect(p.elec).toBeCloseTo(11.5, 6);
  });

  it('38 引力弹头：只有物理 ×1.25', () => {
    const p = scale(38);
    expect(p.phys).toBeCloseTo(100, 6);
    expect(p.fire).toBeCloseTo(40, 6);
  });

  it('39 龙之吐息：火焰 ×1.25，物理保持不变', () => {
    const p = scale(39);
    expect(p.fire).toBeCloseTo(50, 6);
    expect(p.phys).toBeCloseTo(80, 6);
  });

  it('40 灵魂之息：冰冻 ×1.25，物理保持不变', () => {
    const p = scale(40);
    expect(p.ice).toBeCloseTo(25, 6);
    expect(p.phys).toBeCloseTo(80, 6);
  });

  it('41 球状闪电：闪电 ×1.25，物理保持不变', () => {
    const p = scale(41);
    expect(p.elec).toBeCloseTo(12.5, 6);
    expect(p.phys).toBeCloseTo(80, 6);
  });

  it('非武器不套用元素缩放（装备池编号 37-41 与武器池各自独立）', () => {
    const target = createEffectTarget({ phys: 80, fire: 40, ice: 20, elec: 10 }, 10);
    applyEquipmentEffect(target, undefined, false, 39);
    expect(target.properties.fire).toBeCloseTo(40, 6);
  });
});

describe('植入体：套装编码 1物/2火/3冰/4电（@Struct.ecode L367）', () => {
  const combatState = new CombatStateService();
  const countOf = (名称: string, 特殊序号: number) => {
    const sets: any = {};
    combatState.setJudgment(sets, 名称, 特殊序号);
    return sets.implant;
  };

  it('按特殊序号：强攻76→1 / 烈火78→2 / 冰结79→3 / 雷霆77→4', () => {
    expect(countOf('植入体-强攻', 76)).toBe(1);
    expect(countOf('植入体-烈火', 78)).toBe(2);
    expect(countOf('植入体-冰结', 79)).toBe(3);
    expect(countOf('植入体-雷霆', 77)).toBe(4);
  });

  it('按名称与按序号两条分支必须给出同一编码（否则带序号的装备会吃到别的元素）', () => {
    for (const [名称, 序号] of [['植入体-强攻', 76], ['植入体-烈火', 78], ['植入体-冰结', 79], ['植入体-雷霆', 77]] as const) {
      expect(countOf(名称, 0)).toBe(countOf(名称, 序号));
    }
  });
});

describe('套装类型减伤：读取端键名必须与 套装判断 写入端一致', () => {
  const combatState = new CombatStateService();

  it('动力/防爆/无畏/游侠/游骑兵 计数落在 SetData 英文键上', () => {
    const sets: any = {};
    // 动力头盔(17) / 防爆上衣(40) / 无畏头盔(41) / 游侠披风(39) / 游骑兵头盔(38)
    combatState.setJudgment(sets, '动力头盔', 17);
    combatState.setJudgment(sets, '防爆上衣', 40);
    combatState.setJudgment(sets, '无畏头盔', 41);
    combatState.setJudgment(sets, '游侠披风', 39);
    combatState.setJudgment(sets, '游骑兵头盔', 38);
    expect({
      power: sets.power, antiExplosion: sets.antiExplosion, fearless: sets.fearless,
      wanderer: sets.wanderer, ranger: sets.ranger,
    }).toEqual({ power: 1, antiExplosion: 1, fearless: 1, wanderer: 1, ranger: 1 });
    // 战斗侧按这些英文键取件数；若写入端改回中文键，上面的断言会先炸。
    for (const 中文 of ['动力', '防爆', '无畏', '游侠', '游骑兵']) {
      expect(sets[中文]).toBeUndefined();
    }
  });
});

describe('称号加成：titles.json 的 bonus 必须并入玩家加成', () => {
  const bonusService = new BonusService();

  it('逐条叠加已拥有称号的加成，跳过 说明 与非数值键', () => {
    const bonus: any = { 暴击伤害: 150, 升级经验: 0 };
    bonusService.applyTitleBonuses(bonus, [
      { bonus: { 暴击伤害: '20' } },
      { bonus: { 说明: '描述文案', 升级经验: '-0.25' } },
      { bonus: {} },
      null,
    ]);
    expect(bonus.暴击伤害).toBeCloseTo(170, 6);
    expect(bonus.升级经验).toBeCloseTo(-0.25, 6);
    expect(bonus.说明).toBeUndefined();
  });

  it('空称号列表不改动加成', () => {
    const bonus: any = { 攻击: 100 };
    bonusService.applyTitleBonuses(bonus, []);
    expect(bonus.攻击).toBe(100);
  });
});

describe('武器伤害配比：静态 properties.damage 必须进入战斗侧', () => {
  const ratios = (weaponName: string) => {
    const combat = buildCombatWith([GAUSS]);
    const attacker = { name: '测试', weapons: [{ name: weaponName, data: 'S!aa30' }], currentWeapon: 1, specialSeq: 0 };
    return (combat.getWeaponData(attacker, 1).properties ?? {}) as Record<string, number>;
  };

  it('高斯步枪（原版 伤害=物90 火10）不再是 100% 物理', () => {
    expect(ratios('高斯步枪')).toEqual({ phys: 90, fire: 10, ice: 0, elec: 0 });
  });

  it('未配伤害数据的武器仍按纯物理 100 结算（拳头/怪物默认武器不受影响）', () => {
    const r = ratios('不存在的武器');
    expect(r.phys).toBe(100);
    expect(r.fire).toBe(0);
  });
});

describe('套装的武器级换算按次生效，不回写持久数据', () => {
  const weaponOf = (sets: any) => {
    const combat = buildCombatWith([GAUSS]);
    const attacker = { name: '测试', weapons: [{ name: '高斯步枪' }], sets, currentWeapon: 1, specialSeq: 0 };
    return { combat, first: combat.getWeaponData(attacker, 1), second: combat.getWeaponData(attacker, 1) };
  };

  it('增幅器-速射：冷却 10 → 9（-10%，最低 1 秒）', () => {
    const { first } = weaponOf({ amplifier: 1 });
    expect(first.cooldown).toBe(9);
  });

  it('一拳套装 4 件：锁定时间 +5 秒（高斯步枪本体锁定 0）', () => {
    const { first } = weaponOf({ onePunch: 4 });
    expect(first.lockTime).toBe(5);
    expect(weaponOf({ onePunch: 3 }).first.lockTime).toBe(0);
  });

  it('重复解析不得叠加（原实现改 player.weapons，重算一次就多一层）', () => {
    const both = weaponOf({ amplifier: 1, onePunch: 4 });
    expect(both.first.cooldown).toBe(both.second.cooldown);
    expect(both.first.lockTime).toBe(both.second.lockTime);
  });
});

describe('元素穿透：植入体/线圈/法宝只穿透描述那一系，不再四系全穿', () => {
  const combat = buildCombatWith([GAUSS]);

  it('addElementPenetration 写「层+元素+穿」组合键，getPenetration 能读回', () => {
    const bonus: any = {};
    (combat as any).addElementPenetration(bonus, 'phys', 10);
    expect(bonus.护盾物穿).toBe(10);
    expect(bonus.装甲物穿).toBe(10);
    expect(bonus.生命物穿).toBe(10);
    expect(bonus.护盾火穿).toBeUndefined();
    const pen = (combat as any).getPenetration(bonus);
    expect(pen.shieldElem.phys).toBe(10);
    expect(pen.armorElem.fire).toBe(0);
    expect(pen.life).toBe(0);
  });

  it('通用穿透与元素穿透互不串道', () => {
    const bonus: any = { 护盾穿透: 20 };
    (combat as any).addElementPenetration(bonus, 'elec', 40);
    const pen = (combat as any).getPenetration(bonus);
    expect(pen.shield).toBe(20);
    expect(pen.shieldElem.elec).toBe(40);
    expect(pen.shieldElem.phys).toBe(0);
  });
});

describe('装备条目「特殊序号」补齐（读档闸 + 战斗兜底）', () => {
  const 棒棒糖 = { name: '棒棒糖', equipType: '饰品', specialSeq: 97 };
  const 射爆核心 = { name: '射爆核心', equipType: '饰品', specialSeq: 29 };
  const combatWithGear = buildCombatWith([棒棒糖, 射爆核心, GAUSS]);

  it('backfillSpecialSeq：按静态定义补序号、尊重已有值、幂等且不换数组引用', () => {
    const list: any[] = [
      { name: '棒棒糖' },
      { name: '射爆核心' },
      { name: '圆盾', specialSeq: 0 }, // 已有显式序号（含 0）不得覆盖
      { name: '不存在的装备' },
      null,
    ];
    const lookup = lookupFromStaticData({
      getEquipmentByName: (n: string) => [棒棒糖, 射爆核心].find((d) => d.name === n),
    });
    const same = backfillSpecialSeq(list, lookup);
    expect(same).toBe(list);
    expect(list[0].specialSeq).toBe(97);
    expect(list[1].specialSeq).toBe(29);
    expect(list[2].specialSeq).toBe(0);
    expect(list[3].specialSeq).toBeUndefined();
    // 幂等：再跑一次结果不变（可重复挂在读档/战斗两侧）
    backfillSpecialSeq(list, lookup);
    expect(list[0].specialSeq).toBe(97);
    expect(list[2].specialSeq).toBe(0);
  });

  it('ensureSpecialSeqs：字符串形态的装备栏与 player 兜底都能补齐', () => {
    const playerData: any = { equipment: JSON.stringify([{ name: '棒棒糖', type: '装备' }]) };
    (combatWithGear as any).ensureSpecialSeqs(playerData, { weapons: [{ name: '高斯步枪' }] });
    expect(playerData.equipment[0].specialSeq).toBe(97);
    expect(playerData.weapons[0].specialSeq).toBe(-1);
    // 快照缺字段时不抛错（运行时召唤物等）
    (combatWithGear as any).ensureSpecialSeqs({}, undefined);
    (combatWithGear as any).ensureSpecialSeqs(null, null);
  });

  it('补齐后「按序号判定」的装备效果对真实条目成立（描述不再静默失效）', () => {
    const playerData: any = {
      equipment: [{ name: '棒棒糖', type: '装备', data: 'e' }],
      weapons: [],
      markers: {},
      markers2: [],
      buffs: [],
    };
    const player: any = {
      userId: 1, name: '测试', level: 1, equipment: playerData.equipment, weapons: [],
      markers: {}, markers2: [], buffs: [], bonus: {}, 属性: {},
    };
    (combatWithGear as any).ensureSpecialSeqs(playerData, player);
    const hasSeq = (seq: number) =>
      playerData.equipment.some((e: any) => Number(e?.specialSeq) === seq);
    expect(hasSeq(97)).toBe(true); // 战斗里 hasEquipSeqFx(97) 的等价判定
    expect(hasSeq(29)).toBe(false);
  });
});

describe('使魔防御被动（怪物攻击玩家方向，与描述一致）', () => {
  const guard = (defender: any, lines: string[] = []) =>
    (buildGuardCombat() as any).applyDefenderFamiliarPassives(defender, lines);

  it('战斗女仆：守护1 生效时免伤，次数转入守护2 且守护1 时长 -2 秒', () => {
    const nowMs = Date.now();
    const defender = {
      type: '战斗女仆', specialSeq: 8, affinity: 0, skillLevel: 10,
      buffs: [{ name: '守护1', expireAt: nowMs + 10_000 }],
      markers2: [], markers: {},
    };
    const lines: string[] = [];
    const r = guard(defender, lines);
    expect(r.immune).toBe(true);
    expect(lines.join('')).toContain('守护');
    const buffs = defender.buffs as any[];
    expect(buffs.find((b) => b.name === '守护2')?.strength).toBe(1);
    // 10 秒 → 8 秒（描述「被命中一次减少2秒」）
    expect(Math.round(((buffs.find((b) => b.name === '守护1').expireAt - nowMs) / 1000) * 10) / 10).toBe(8);
  });

  it('绝灭天使：每个光盾只抵挡一次（次数耗尽即不再免伤）', () => {
    const nowMs = Date.now();
    const make = (stacks: number) => ({
      type: '绝灭天使', specialSeq: 3, buffs: [{ name: '光盾', expireAt: nowMs + 30_000, strength: stacks }],
      markers2: [], markers: {},
    });
    const two = make(2);
    expect(guard(two).immune).toBe(true);
    expect(two.buffs[0].strength).toBe(1);
    const one = make(1);
    expect(guard(one).immune).toBe(true);
    expect(one.buffs.some((b: any) => b.name === '光盾')).toBe(false);
    expect(guard(make(0)).immune).toBe(false);
  });

  it('军姬X：jj2hg1 抵挡次数逐次消耗，好感<20 不触发', () => {
    const withAff = (aff: number) => ({
      type: '军姬X', specialSeq: 24, affinity: aff,
      buffs: [], markers2: [], markers: { jj2hg1: 2 },
    });
    const d = withAff(20);
    expect(guard(d).immune).toBe(true);
    expect(Number(d.markers.jj2hg1)).toBe(1);
    expect(guard(withAff(10)).immune).toBe(false);
  });

  it('恶毒：色欲 好感≥100 首次免伤、30 秒冷却内不再免伤', () => {
    const d: any = {
      type: '恶毒', specialSeq: 6, affinity: 100, buffs: [], markers2: [], markers: {},
    };
    expect(guard(d).immune).toBe(true);
    expect(guard(d).immune).toBe(false); // 色欲2 冷却已写入 markers2
    expect((d.markers2 as any[]).some((m: any) => m.name === '色欲2')).toBe(true);
  });

  it('好感门槛读的是标记权威值（affinity 列只在更换使魔时同步过，会长期偏旧）', () => {
    // 只写 恶毒好感=100、affinity 列仍是 0 → 色欲 必须照样触发
    const d: any = {
      type: '恶毒', specialSeq: 6, affinity: 0,
      buffs: [], markers2: [], markers: { 恶毒好感: 100 },
    };
    expect(guard(d).immune).toBe(true);
    // 军姬X 招架同理：好感只存在于标记里
    const j2: any = {
      type: '军姬X', specialSeq: 24, affinity: 0,
      buffs: [], markers2: [], markers: { 军姬X好感: 20, jj2hg1: 2 },
    };
    expect(guard(j2).immune).toBe(true);
  });

  it('四糸乃：好感≥80 被命中开冰凯，20 秒冷却内不再刷新 bk1', () => {
    const d: any = {
      type: '四糸乃', specialSeq: 15, affinity: 80, buffs: [], markers2: [], markers: {},
    };
    expect(guard(d).immune).toBe(true); // bk1 1 秒窗口内
    expect(d.buffs.some((b: any) => b.name === '冰凯')).toBe(true); // 加成侧据此给 冰伤+50+技等
    // 把 bk1 判定为已过期（模拟 1 秒后再次挨打）：冰凯 20 秒冷却未过 → 不再给 bk1 → 不免伤
    d.buffs.find((b: any) => b.name === 'bk1').expireAt = Date.now() - 1000;
    expect(guard(d).immune).toBe(false);
    expect(d.buffs.filter((b: any) => b.name === 'bk1')).toHaveLength(1);
    // 20 秒后冰凯冷却过期 → 再次触发
    d.buffs.find((b: any) => b.name === '冰凯').expireAt = Date.now() - 1000;
    expect(guard(d).immune).toBe(true);
  });

  it('剑阵增益对任何使魔都免伤；阿尔缇娜按好感与 a技能2 累加格挡', () => {
    const nowMs = Date.now();
    expect(guard({
      type: '四糸乃', specialSeq: 15, buffs: [{ name: '剑阵', expireAt: nowMs + 5000 }],
      markers2: [], markers: {},
    }).immune).toBe(true);
    const altina = {
      type: '阿尔缇娜', specialSeq: 7, affinity: 40, skillLevel: 10,
      buffs: [{ name: 'a技能2', expireAt: nowMs + 5000 }], markers2: [], markers: {},
    };
    const r = guard(altina);
    expect(r.immune).toBe(false);
    expect(r.blockBonus).toBe((15 + 5) * 2); // 好感档 + a技能2 档
  });

  it('怪物（特殊序号为负且无使魔类型）整段跳过，不改任何字段', () => {
    const monster = {
      type: '', specialSeq: -3, affinity: 100,
      buffs: [{ name: '光盾', expireAt: Date.now() + 5000, strength: 3 }], markers2: [], markers: {},
    };
    const before = JSON.stringify(monster);
    expect(guard(monster)).toEqual({ immune: false, blockBonus: 0 });
    expect(JSON.stringify(monster)).toBe(before);
  });
});

describe('防御方装备被动（命中阶段 + 伤害阶段，怪物攻击玩家方向）', () => {
  const hitPhase = (defender: any, lines: string[] = []) =>
    (buildGuardCombat() as any).applyDefenderGearHitPhase(defender, lines) as { fixedDodge: number; hitBonus: number };
  const damagePhase = (defender: any, lines: string[] = []) =>
    (buildGuardCombat() as any).applyDefenderGearDamagePhase(defender, lines) as { factor: number; immune: boolean };
  const grantMiss = (defender: any) => (buildGuardCombat() as any).grantDodgeStackOnMiss(defender);
  const grantShirt = (defender: any) => (buildGuardCombat() as any).grantShortShirtAfterHit(defender);
  const wearer = (equipment: any[], extra: any = {}) => ({
    type: '伊卡洛斯', specialSeq: 3, affinity: 0, skillLevel: 0,
    equipment, weapons: [], buffs: [], markers2: [], markers: {}, sets: '{}', ...extra,
  });

  it('风精灵(33)/雷精灵(132)「固定闪避几率+10%」计入本次命中判定，两件同装只加一次', () => {
    expect(hitPhase(wearer([{ name: '风精灵', specialSeq: 33 }])).fixedDodge).toBe(10);
    expect(hitPhase(wearer([{ name: '雷精灵', specialSeq: 132 }])).fixedDodge).toBe(10);
    expect(hitPhase(wearer([
      { name: '风精灵', specialSeq: 33 }, { name: '雷精灵', specialSeq: 132 },
    ])).fixedDodge).toBe(10);
    // 没穿就不加（原版这两件的第一句此前在 PVE 完全没实现）
    expect(hitPhase(wearer([]))).toEqual({ fixedDodge: 0, hitBonus: 0 });
  });

  it('心形贴(103)「被命中率+25%」计入最终命中率（冷却那一半已在 getWeaponData）', () => {
    expect(hitPhase(wearer([{ name: '心形贴', specialSeq: 103 }])).hitBonus).toBe(25);
    expect(hitPhase(wearer([{ name: '圆盾', specialSeq: 51 }])).hitBonus).toBe(0);
  });

  it('狐狸尾巴(93)：闪避未冷却时被命中自动释放闪避，15秒冷却内不重复，并记超频连接', () => {
    const p: any = wearer(
      [{ name: '狐狸尾巴', specialSeq: 93 }, { name: '超频连接', specialSeq: 49 }],
      { dodge: 20 },
    );
    const first = hitPhase(p);
    expect(first.fixedDodge).toBe(100); // 本次按进入闪避状态结算
    expect(p.buffs.some((b: any) => b.name === '闪避')).toBe(true);
    expect(p.markers2.some((m: any) => m.name === '闪避冷却')).toBe(true);
    expect(Number(p.markers['闪避击2'] || 0)).toBe(1); // 超频连接：下一击必中
    // 15 秒「狐尾」冷却内再次被命中 → 不再自动闪避
    expect(hitPhase(p).fixedDodge).toBe(0);
    // 闪避≤1 不能释放（原版 #闪避不大于1 分支）
    const lowDodge: any = wearer([{ name: '狐狸尾巴', specialSeq: 93 }], { dodge: 1 });
    expect(hitPhase(lowDodge).fixedDodge).toBe(0);
  });

  it('四糸奈(94)：固定闪避 = 5 + 层数；未命中叠层、5 秒冷却内不重复叠', () => {
    const p: any = wearer(
      [{ name: '四糸奈', specialSeq: 94 }],
      { buffs: [{ name: '四糸奈', expireAt: Date.now() + 60_000, strength: 3 }] },
    );
    expect(hitPhase(p).fixedDodge).toBe(8); // 5 + 3 层
    const fresh: any = wearer([{ name: '四糸奈', specialSeq: 94 }]);
    expect(hitPhase(fresh).fixedDodge).toBe(5); // 只有基础 5%
    grantMiss(fresh);
    expect(fresh.buffs.find((b: any) => b.name === '四糸奈').strength).toBe(1);
    grantMiss(fresh); // ssn 5 秒冷却内不再叠
    expect(fresh.buffs.filter((b: any) => b.name === '四糸奈')).toHaveLength(1);
    expect(hitPhase(fresh).fixedDodge).toBe(6);
  });

  it('神兽之力-祥瑞(116)：每次被攻击叠一层（封顶5），并把层数换成 攻击2+10%/层、贯穿+3%/层', () => {
    const p: any = wearer([{ name: '神兽之力-祥瑞', specialSeq: 116 }]);
    const lines: string[] = [];
    hitPhase(p, lines);
    expect(lines.join('')).toContain('祥瑞1');
    hitPhase(p, lines);
    hitPhase(p, lines);
    expect(p.buffs.find((b: any) => b.name === '祥瑞').strength).toBe(3);
    // 神龙祥瑞(37) 不能被误当成 神兽之力-祥瑞
    const wrong = wearer([{ name: '神龙祥瑞', specialSeq: 37 }]);
    expect(hitPhase(wrong).fixedDodge).toBe(0);
    expect(wrong.buffs).toHaveLength(0);
    // 消费端：3 层 → 攻击2 +30、贯穿 +9
    const bonus: any = { 攻击2: 0, 贯穿: 0 };
    new BonusService().calculateGameBonus(
      { bonus, buffs: [{ name: '祥瑞', strength: 3, expireAt: Date.now() / 1000 + 30 }], markers: {} },
      Math.floor(Date.now() / 1000),
    );
    expect(bonus.攻击2).toBe(30);
    expect(bonus.贯穿).toBe(9);
  });

  it('增幅器-敏锐(73)：被攻击先叠 1 层，到 5 层抵挡一次并扣 5 层（读取封顶 7）', () => {    const p: any = wearer([{ name: '增幅器-敏锐', specialSeq: 73 }], { sets: JSON.stringify({ amplifier: 2 }) });
    const combat = buildGuardCombat() as any;
    for (let i = 1; i <= 4; i++) {
      combat.applyDefenderGearHitPhase(p, []);
      expect(p.markers['s敏锐']).toBe(i);
      expect(combat.applyDefenderGearDamagePhase(p, []).immune).toBe(false); // 未满 5 层不抵挡
    }
    combat.applyDefenderGearHitPhase(p, []); // 第 5 层
    const r = combat.applyDefenderGearDamagePhase(p, []);
    expect(r.immune).toBe(true);
    expect(Number(p.markers['s敏锐'] || 0)).toBe(0); // 5 − 5 后条目清除
  });

  it('增幅器-坚毅(72)：每层 −10% 受伤（不再是"只有第5次才生效"），第 5 层归零', () => {
    const p: any = wearer([{ name: '增幅器-坚毅', specialSeq: 72 }], { sets: JSON.stringify({ amplifier: 4 }) });
    const combat = buildGuardCombat() as any;
    const first = combat.applyDefenderGearDamagePhase(p, []);
    expect(first.factor).toBeCloseTo(0.9, 6); // 1 层
    expect(p.markers['s坚毅']).toBe(1);
    combat.applyDefenderGearDamagePhase(p, []);
    expect(p.markers['s坚毅']).toBe(2);
    for (let i = 3; i < 5; i++) combat.applyDefenderGearDamagePhase(p, []);
    expect(p.markers['s坚毅']).toBe(4);
    const fifth = combat.applyDefenderGearDamagePhase(p, []);
    expect(fifth.factor).toBeCloseTo(0.5, 6); // 第 5 层仍享受 −50%
    expect(Number(p.markers['s坚毅'] || 0)).toBe(0); // 归零（条目清除）
  });

  it('永恒主宰(83)：首次被命中免疫一次，60 秒冷却内不再免疫', () => {
    const p: any = wearer([{ name: '永恒主宰', specialSeq: 83 }]);
    const combat = buildGuardCombat() as any;
    expect(combat.applyDefenderGearDamagePhase(p, []).immune).toBe(true);
    expect(p.markers2.some((m: any) => m.name === 'yzj')).toBe(true);
    expect(combat.applyDefenderGearDamagePhase(p, []).immune).toBe(false);
  });

  it('坚韧护盾(131)：护盾≥上限15%且被打穿时挡下本次后续扣减，15秒冷却内不重复', () => {
    const combat = buildGuardCombat() as any;
    const p: any = wearer([{ name: '坚韧护盾', specialSeq: 131 }], { shield: 60, maxShield: 100 });
    expect(combat.applyToughShieldStop(p, { 护盾: 100 }, 60, 60)).toBe(true);
    expect(p.markers2.some((m: any) => m.name === '坚韧hd')).toBe(true);
    expect(combat.applyToughShieldStop(p, { 护盾: 100 }, 60, 60)).toBe(false); // 15 秒冷却内
    // 护盾已低于上限 15% → 不挡
    const low: any = wearer([{ name: '坚韧护盾', specialSeq: 131 }], { shield: 10, maxShield: 100 });
    expect(combat.applyToughShieldStop(low, { 护盾: 100 }, 10, 10)).toBe(false);
    // 护盾没被打穿 → 不挡
    const keep: any = wearer([{ name: '坚韧护盾', specialSeq: 131 }], { shield: 80, maxShield: 100 });
    expect(combat.applyToughShieldStop(keep, { 护盾: 100 }, 20, 80)).toBe(false);
    // 没穿这件装备 → 不挡
    const none: any = wearer([{ name: '圆盾', specialSeq: 51 }], { shield: 60, maxShield: 100 });
    expect(combat.applyToughShieldStop(none, { 护盾: 100 }, 60, 60)).toBe(false);
  });

  it('排斥力场(34)：冷却就绪时弹开一次减益并进入 30 秒冷却', () => {
    const combat = buildGuardCombat() as any;
    const t: any = wearer([{ name: '排斥力场', specialSeq: 34 }]);
    expect(combat.tryRepulseDebuff(t, Date.now())).toBe(true);
    expect(t.markers2.some((m: any) => m.name === '排斥冷却')).toBe(true);
    expect(combat.tryRepulseDebuff(t, Date.now())).toBe(false); // 冷却内不再免疫
    // 没穿这件装备 → 不免疫，也不写冷却
    const none: any = wearer([{ name: '圆盾', specialSeq: 51 }]);
    expect(combat.tryRepulseDebuff(none, Date.now())).toBe(false);
    expect(none.markers2).toHaveLength(0);
  });

  it('龙之逆鳞(105)「受伤害+20%」按 1.2 倍计入本击伤害', () => {
    const scale = (equipment: any[]) =>
      (buildGuardCombat() as any).applyDefenderGearDamagePhase(wearer(equipment), []).factor;
    expect(scale([{ name: '龙之逆鳞', specialSeq: 105 }])).toBeCloseTo(1.2, 6);
    expect(scale([{ name: '圆盾', specialSeq: 51 }])).toBe(1);
  });

  it('短衬衫(107)：受伤后写 0.2 秒标记（不可叠加），下一击伤害 ×0.1', () => {
    const combat = buildGuardCombat() as any;
    // 读取端：带「短衬衫2」标记的那一击按 10% 计入（标记本身只活 0.2 秒，
    // 这里给足有效期，避免把断言绑在墙上时钟的 200 毫秒窗口上）。
    const p: any = wearer(
      [{ name: '短衬衫', specialSeq: 107 }],
      { markers2: [{ name: '短衬衫2', expireAt: Date.now() + 5000 }] },
    );
    expect(combat.applyDefenderGearDamagePhase(p, []).factor).toBeCloseTo(0.1, 6);
    // 写入端：受伤后写 0.2 秒、不可叠加、没穿这件装备不写。
    const fresh: any = wearer([{ name: '短衬衫', specialSeq: 107 }]);
    expect(combat.applyDefenderGearDamagePhase(fresh, []).factor).toBe(1);
    grantShirt(fresh);
    grantShirt(fresh);
    const written = fresh.markers2.filter((m: any) => m.name === '短衬衫2');
    expect(written).toHaveLength(1);
    const remain = Number(written[0].expireAt) - Date.now();
    expect(remain).toBeGreaterThan(0);
    expect(remain).toBeLessThanOrEqual(200 * 3); // 0.2 秒量级（放宽 3 倍容忍构建耗时）
    const other: any = wearer([{ name: '圆盾', specialSeq: 51 }]);
    grantShirt(other);
    expect(other.markers2).toHaveLength(0);
  });
});

describe('溅射与随机多武器出手（片翼天使100 / 战术目镜113 / 伊卡洛斯「无情」）', () => {
  const fighter = (equipment: any[], extra: any = {}) => ({
    userId: 1, name: '冒险者', type: '', specialSeq: 0, affinity: 0, skillLevel: 0,
    currentWeapon: 0, equipment, weapons: [], buffs: [], markers2: [] as any[],
    markers: {} as Record<string, any>, sets: '{}', ...extra,
  });
  const rounds = (p: any, lines: string[] = []) =>
    (buildGuardCombat() as any).consumeTacticalStrikeOpportunity(p, lines) as number;

  it('战术目镜(113)「随机2把未冷却武器同时攻击，冷却120秒」：计 2 次并写 zsmj 冷却，冷却内不再计次', () => {
    const p: any = fighter([{ name: '战术目镜', specialSeq: 113 }]);
    const lines: string[] = [];
    expect(rounds(p, lines)).toBe(2);
    expect(lines).toContain('【战术目镜】');
    expect(p.markers2.some((m: any) => m.name === 'zsmj')).toBe(true);
    // 120 秒冷却内不再触发（消耗是「查即写」，一次出手锁 120 秒）
    expect(rounds(p, [])).toBe(0);
    // 没穿这件装备 → 不计次，也不写冷却
    const none: any = fighter([{ name: '圆盾', specialSeq: 51 }]);
    expect(rounds(none, [])).toBe(0);
    expect(none.markers2).toHaveLength(0);
  });

  it('普拉娜「火力全开」：用熟练度换一次随机武器出手，次数按原版整数截断（20级1把/40级2把）', () => {
    const withLevel = (prof: number) => fighter([], {
      type: '普拉娜', specialSeq: 22, markers: { 火力全开: 1, 普拉娜技能熟练度: prof },
    });
    const weak: any = withLevel(400); // 熟练度400 → 技能20级 → floor(1+0.5)=1
    expect(rounds(weak, [])).toBe(1);
    expect(weak.markers['火力全开']).toBe(0); // 置成就熟练度(…,0)：用掉即清
    expect(rounds(weak, [])).toBe(0);
    const strong: any = withLevel(1600); // 40级 → floor(1+1)=2
    expect(rounds(strong, [])).toBe(2);
    // 别人的「火力全开」标记不算数（原版只在 攻击方.特殊序号==#普拉娜 分支里读）
    const other: any = fighter([], { type: '伊卡洛斯', specialSeq: 13, markers: { 火力全开: 1 } });
    expect(rounds(other, [])).toBe(0);
  });

  it('随机武器挑选：跳过「武器名+冷却」未过期的武器、取过即从池中删、同名武器各占一格', () => {
    const combat = buildGuardCombat() as any;
    const pick = (p: any, n: number) => (combat.pickTacticalWeaponIndexes(p, n) as number[]).sort();
    const now = Date.now();
    const p: any = fighter([], {
      weapons: [{ name: '铁剑' }, { name: '火枪' }, { name: '冰杖' }],
      markers2: [{ name: '火枪冷却', expireAt: now + 60_000 }],
    });
    expect(pick(p, 5)).toEqual([1, 3]); // 火枪在冷却 → 只有铁剑/冰杖可用
    expect(pick(p, 1)).toHaveLength(1); // 次数多于池子时只取到可用的那一个
    const dup: any = fighter([], { weapons: [{ name: '铁剑' }, { name: '铁剑' }] });
    expect(pick(dup, 2)).toEqual([1, 2]);
    expect(pick(fighter([], { weapons: [] }), 2)).toEqual([]);
  });

  it('伊卡洛斯好感≥60「需要锁定的武器，锁定时间变为0」：按次换算且不回写存档', () => {
    const combat = buildGuardCombat() as any;
    const gun: any[] = [{ name: '冰弓', damage: 1, cooldown: 5, lockTime: 3 }];
    const byMarker = { 伊卡洛斯好感: 60 };
    const hi: any = fighter([], { type: '伊卡洛斯', specialSeq: 13, weapons: gun, markers: byMarker });
    expect(combat.getWeaponData(hi, 1).lockTime).toBe(0);
    expect(hi.weapons[0].lockTime).toBe(3); // 只换算这一次出手，不抹存档
    const lo: any = fighter([], { type: '伊卡洛斯', specialSeq: 13, weapons: gun, markers: { 伊卡洛斯好感: 40 } });
    expect(combat.getWeaponData(lo, 1).lockTime).toBe(3);
    const other: any = fighter([], { type: '夜瞳', specialSeq: 14, weapons: gun, markers: byMarker });
    expect(combat.getWeaponData(other, 1).lockTime).toBe(3);
  });
});

describe('五件铠甲召唤器(87-91)：「发送X铠甲合体！」真的写入效果开关', () => {
  const buildSvc = (equipment: any[], markers: Record<string, any> = {}) => {
    const player: any = {
      userId: 9, name: '冒险者', equipment, markers, weapons: [], buffs: [], markers2: [],
    };
    const saved: any[] = [];
    const playerService: any = {
      getPlayerData: async () => ({ player, markers, equipment }),
      getMarkerValue: (m: any, k: string) => m?.[k] ?? 0,
      setMarker: (m: any, k: string, v: number) => { m[k] = v; },
      savePlayer: async (p: any) => { saved.push(p); },
    };
    const svc: any = new SkillCommandService(
      {} as any, {} as any, playerService, {} as any, {} as any,
      {} as any, {} as any, new CombatStateService(), {} as any,
    );
    return { svc, player, saved };
  };

  it('穿着召唤器 → 标记.铠甲 置成对应序号（炎龙1/黑犀2/飞影3/地虎4/雪獒5）并落库', async () => {
    const seqByName: Record<string, number> = { 炎龙: 1, 黑犀: 2, 飞影: 3, 地虎: 4, 雪獒: 5 };
    for (const [name, seq] of Object.entries(seqByName)) {
      const { svc, player, saved } = buildSvc([{ name: `${name}铠甲召唤器`, specialSeq: 86 + seq }]);
      const text = await svc.handleArmorCombine(9, name);
      expect(text).toContain(`${name}铠甲激活`);
      expect(player.markers['铠甲']).toBe(seq);
      expect(saved).toHaveLength(1);
    }
  });

  it('没穿对应召唤器 → 只提示需要装备，不写标记也不落库', async () => {
    const { svc, player, saved } = buildSvc([{ name: '炎龙铠甲召唤器', specialSeq: 87 }]);
    expect(await svc.handleArmorCombine(9, '雪獒')).toContain('需要装备“雪獒铠甲召唤器”');
    expect(player.markers['铠甲']).toBeUndefined();
    expect(saved).toHaveLength(0);
  });

  it('已激活过不再重复激活；未知铠甲名不放行', async () => {
    const once = buildSvc([{ name: '飞影铠甲召唤器', specialSeq: 89 }], { 铠甲: 0 });
    await once.svc.handleArmorCombine(9, '飞影');
    const twice = buildSvc([{ name: '飞影铠甲召唤器', specialSeq: 89 }], { 铠甲: 3 });
    expect(await twice.svc.handleArmorCombine(9, '飞影')).toContain('已经激活过了');
    expect(twice.player.markers['铠甲']).toBe(3);
    expect(await once.svc.handleArmorCombine(9, '麒麟')).toContain('没有对应的铠甲');
  });
});

describe('雪獒充能与 飞影/地虎 冷却换算（描述口径）', () => {
  it('重算加成不再把充能锚点推到当下（否则层数永远攒不到 60）', () => {
    const bonusService = new BonusService();
    const kept: any = { 铠甲: 5, xa: 910 };
    bonusService.calculateGameBonus({ bonus: {} as any, markers: kept } as any, 1000);
    expect(kept.xa).toBe(910); // 攒了 90 层，原实现会被推成 1000 → 层数恒 0
    const capped: any = { 铠甲: 5, xa: 800 };
    bonusService.calculateGameBonus({ bonus: {} as any, markers: capped } as any, 1000);
    expect(capped.xa).toBe(880); // 超过 120 秒才回拨，封顶 120 层
  });

  it('飞影「武器冷却-15%」/地虎「攻击冷却+20%」按次换算，只作用于当前武器且不写回存档', () => {
    const combat: any = buildGuardCombat();
    const carrier = (markers: any, cooldown = 10) => ({
      type: '', specialSeq: 0, currentWeapon: 1, markers,
      equipment: [], buffs: [], markers2: [], sets: '{}',
      weapons: [{ name: '铁剑', damage: 1, cooldown, lockTime: 0, properties: { phys: 100 } }],
    });
    expect(combat.getWeaponData(carrier({ 铠甲: 3 }), 1).cooldown).toBeCloseTo(8.5, 6);
    expect(combat.getWeaponData(carrier({ 铠甲: 4 }), 1).cooldown).toBeCloseTo(12, 6);
    expect(combat.getWeaponData(carrier({}), 1).cooldown).toBe(10);
    const p = carrier({ 铠甲: 3 });
    combat.getWeaponData(p, 1);
    combat.getWeaponData(p, 1);
    expect(p.weapons[0].cooldown).toBe(10); // 反复解析不叠乘
    // 原版两条都要求 当前武器 != 0：手里没拿武器时不该改冷却
    const fist = { ...carrier({ 铠甲: 3 }), currentWeapon: 0 };
    expect(combat.getWeaponData(fist, 1).cooldown).toBe(10);
  });

  it('装备特效「背水」(aoe) 接进攻击入口的全体攻击判定', () => {
    const combat: any = new CombatSystemService(
      {} as PrismaService,
      {
        safeJsonParse: <T>(v: any, fallback: T): T => {
          if (typeof v !== 'string') return (v ?? fallback) as T;
          try { return JSON.parse(v) as T; } catch { return fallback; }
        },
        getMarkerValue: () => 0,
      } as unknown as PlayerService,
      new BonusService(),
      {} as MapService,
      {
        getEquipmentByName: (name: string) => (name === '测试护腕' || name === '测试武器'
          ? { name, equipType: name === '测试武器' ? '射弹武器' : '手臂' } : undefined),
        isWeapon: (def: any) => String(def?.equipType ?? '').endsWith('武器'),
        getEffectById: (id: number) => (id === 41 ? { name: '背水', bonus: { aoe: 1 } } : undefined),
      } as unknown as StaticDataService,
      {} as AchievementService,
      {} as any,
      new CombatStateService(),
      {} as StatsService,
    );
    const wearer = (name: string, data: string) => ({ equipment: [{ name, data }], buffs: '[]' });
    expect(combat.checkAllAttackFlag(wearer('测试护腕', 'e!bx41'), {})).toBe(true);
    expect(combat.checkAllAttackFlag(wearer('测试护腕', 'e'), {})).toBe(false);
    // 武器条目由 getWeaponData 的 effectFlags.aoe 负责，这里不双计
    expect(combat.checkAllAttackFlag(wearer('测试武器', 'e!bx41'), {})).toBe(false);
    // 装备的 bonus 是 JSON 文本时也要认（存量兼容）
    expect(combat.checkAllAttackFlag(
      { equipment: [{ name: '测试护腕', bonus: '{"全体攻击":1}' }], buffs: '[]' }, {})).toBe(true);
    // 特效解析本身给出 aoe 标记（本方法两侧共用同一份 equipment-effect.util）
    const target = createEffectTarget();
    applyEquipmentEffect(target, { name: '背水', bonus: { aoe: 1 } }, false, 41);
    expect(target.flags.aoe).toBe(true);
  });
});

describe('使魔特性与好感描述（familiars.json）', () => {
  const atkBase = () => ({
    攻击: 100, 攻击2: 0, 命中: 100, 命中2: 0, 闪避: 0, 闪避2: 0, 暴击: 0, 暴击伤害: 150,
    生命: 100, 护盾: 0, 装甲: 0, 物伤: 0, 火伤: 0, 冰伤: 0, 电伤: 0,
    护盾物抗: 0, 护盾火抗: 0, 护盾冰抗: 0, 护盾电抗: 0, 护盾全抗: 0,
    装甲物抗: 0, 装甲火抗: 0, 装甲冰抗: 0, 装甲电抗: 0, 装甲全抗: 0,
    生命物抗: 0, 生命火抗: 0, 生命冰抗: 0, 生命电抗: 0, 生命全抗: 0,
    生命伤害上限: 100, 装甲伤害上限: 100, 护盾伤害上限: 100, 世界等级差距: 0, 减益: 0,
  } as any);
  const defBase = () => ({
    生命: 100000, 护盾: 0, 装甲: 0, 闪避: 0, 闪避2: 0, 世界等级差距: 0,
    护盾物抗: 0, 护盾火抗: 0, 护盾冰抗: 0, 护盾电抗: 0, 护盾全抗: 0,
    装甲物抗: 0, 装甲火抗: 0, 装甲冰抗: 0, 装甲电抗: 0, 装甲全抗: 0,
    生命物抗: 0, 生命火抗: 0, 生命冰抗: 0, 生命电抗: 0, 生命全抗: 0,
    生命伤害上限: 100, 装甲伤害上限: 100, 护盾伤害上限: 100,
  } as any);
  const weaponOf = (props: any) => ({
    name: '测试枪', damage: 0, damageType: 1, cooldown: 5, type: '射弹武器', properties: props,
  } as any);

  it('伊卡洛斯特性「造成冰属性以外的伤害时，扣除50%转换为75%的冰属性伤害」按四系结算', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // 固定伤害随机数，只比转换前后的差
    const combat: any = buildGuardCombat();
    const props = { phys: 100, fire: 0, ice: 0, elec: 0 };
    const plain = combat.calcDamage(atkBase(), defBase(), weaponOf(props), 1, false, {});
    const converted = combat.calcDamage(
      { ...atkBase(), 冰锋转换: 1 }, defBase(), weaponOf(props), 1, false, {},
    );
    expect(plain.damage).toBeGreaterThan(0);
    // 非冰 100% → 自身留 50% + 追加到冰系 75% ⇒ 总量约 ×1.25（四系各自取整，留 5% 容差）
    expect(converted.damage).toBeGreaterThan(plain.damage * 1.2);
    expect(converted.damage).toBeLessThan(plain.damage * 1.3);
    // 本来就是纯冰伤害时不产生任何变化（原版同一式子的自然结果）
    const iceProps = { phys: 0, fire: 0, ice: 100, elec: 0 };
    const icePlain = combat.calcDamage(atkBase(), defBase(), weaponOf(iceProps), 1, false, {});
    const iceConverted = combat.calcDamage(
      { ...atkBase(), 冰锋转换: 1 }, defBase(), weaponOf(iceProps), 1, false, {},
    );
    expect(iceConverted.damage).toBeCloseTo(icePlain.damage, 6);
  });

  it('普拉娜好感≥40「(快装)造成伤害时减少全部武器冷却5(+0.05技能等级)秒，冷却1秒」', () => {
    const combat: any = buildGuardCombat();
    const nowMs = Date.now();
    const pl = (affinity: number) => ({
      userId: 1, type: '普拉娜', specialSeq: 22, affinity, markers: { 普拉娜技能熟练度: 380 },
      weapons: [{ name: '铁剑' }, { name: '火枪' }],
      markers2: [
        { name: '铁剑冷却', expireAt: nowMs + 20_000 },
        { name: '未佩戴冷却', expireAt: nowMs + 5_000 },
      ],
    });
    // 熟练度380 → 技能20级（level² 的门槛算法）→ 5 + 20×0.05 = 6 秒
    const withAffinity = pl(40) as any;
    expect(combat.applyPranaQuickReload(withAffinity, { weapons: withAffinity.weapons, markers: withAffinity.markers })).toBeCloseTo(6, 6);
    const entries = (name: string) => withAffinity.markers2.filter((m: any) => m.name === name);
    expect(entries('铁剑冷却')[0].expireAt).toBeLessThan(nowMs + 20_000);
    expect(entries('铁剑冷却')[0].expireAt).toBeCloseTo(nowMs + 20_000 - 6_000, 0);
    // 1 秒冷却内不再触发（时间间隔要求：查即写）
    expect(combat.applyPranaQuickReload(withAffinity, { weapons: withAffinity.weapons, markers: withAffinity.markers })).toBe(0);
    // 好感不足 / 不是普拉娜 → 不动任何冷却，也不写冷却标记
    const lowAffinity = pl(20) as any;
    const before = lowAffinity.markers2.map((m: any) => m.expireAt);
    expect(combat.applyPranaQuickReload(lowAffinity, { weapons: lowAffinity.weapons, markers: lowAffinity.markers })).toBe(0);
    expect(lowAffinity.markers2.map((m: any) => m.expireAt)).toEqual(before);
    expect(lowAffinity.markers2.some((m: any) => m.name === '快装1')).toBe(false);
  });
});

describe('载具功能部件：索敌五件、追踪模块、损伤控制系统与故障的灭星者', () => {
  const seek = (parts: any[], weaponType: string) =>
    (buildGuardCombat() as any).vehicleSeekHitBonus(parts, weaponType) as number;
  const part = (name: string) => ({ name, type: '装备', quantity: 1 });

  it('每件只认自己那一类武器：命中对应类型 +20 固定命中', () => {
    expect(seek([part('制导索敌')], '制导武器')).toBe(20);
    expect(seek([part('射弹索敌')], '射弹武器')).toBe(20);
    expect(seek([part('能量索敌')], '能量武器')).toBe(20);
    expect(seek([part('幽能索敌')], '幽能武器')).toBe(20);
    // 近战索敌的说明覆盖两类：近战与生体都 +20（原版此处近战是 −20，判为笔误）
    expect(seek([part('近战索敌')], '近战武器')).toBe(20);
    expect(seek([part('近战索敌')], '生体武器')).toBe(20);
    expect(seek([part('射弹索敌')], '近战武器')).toBe(0);
    expect(seek([], '射弹武器')).toBe(0);
  });

  it('「效果唯一，组装多个不会有额外提升」，且按原版顺序只认第一条命中的索敌件', () => {
    expect(seek([part('射弹索敌'), part('射弹索敌')], '射弹武器')).toBe(20);
    // 近战索敌排在最前：只要装了它，本次就只看近战/生体，
    // 手里是制导武器时也不会再落到 制导索敌 那一条（原版 判断开始/判断 就是这个结构，
    // 与部件先后顺序无关）
    expect(seek([part('近战索敌'), part('制导索敌')], '制导武器')).toBe(0);
    expect(seek([part('制导索敌'), part('近战索敌')], '制导武器')).toBe(0);
  });

  it('损伤控制系统 A/B/C 的无敌冷却按说明是 40/50/60 秒，「损伤控制系统强化」对各 −25 秒', () => {
    const cd = (name: string, boosted = false) =>
      (buildGuardCombat() as any).damageControlInvulnerableCooldown(name, boosted) as number;
    expect(cd('损伤控制系统A')).toBe(40);
    expect(cd('损伤控制系统B')).toBe(50);
    expect(cd('损伤控制系统C')).toBe(60);
    expect(cd('损伤控制系统A', true)).toBe(15);
    expect(cd('损伤控制系统B', true)).toBe(25);
    expect(cd('损伤控制系统C', true)).toBe(35);
    expect(cd('标准火控')).toBe(0);
  });

  it('故障的灭星者「载具在攻击时会同时命中自己」：只有正驾驶且存活的这台载具装了它才算', () => {
    const combat: any = buildGuardCombat();
    const mapWith = (vehicles: any[]) => ({ id: 1, vehicles: JSON.stringify(vehicles) });
    const starBreaker = [{ name: '故障的灭星者', type: '装备' }];
    const driven = { id: 77, currentHp: 500, parts: starBreaker };
    expect(combat.findSelfHitVehicle({ vehicle: 77 }, mapWith([driven]))).toMatchObject({ vehicleIndex: 0 });
    // 没驾驶载具
    expect(combat.findSelfHitVehicle({ vehicle: 0 }, mapWith([driven]))).toBeNull();
    // 载具已被打爆（原版 载具2.当前生命 > 0）
    expect(combat.findSelfHitVehicle({ vehicle: 77 }, mapWith([{ ...driven, currentHp: 0 }]))).toBeNull();
    // 驾驶的不是这台 / 载具上没有这个部件
    expect(combat.findSelfHitVehicle({ vehicle: 88 }, mapWith([driven]))).toBeNull();
    expect(combat.findSelfHitVehicle({ vehicle: 77 }, mapWith([{ id: 77, currentHp: 500, parts: [{ name: '京兆巨炮' }] }]))).toBeNull();
    // 部件名允许出现在内置零件里（载具自带的组件同样算）
    expect(combat.findSelfHitVehicle({ vehicle: 77 },
      mapWith([{ id: 77, currentHp: 500, builtinParts: [{ name: '故障的灭星者' }] }]))).not.toBeNull();
  });
});

describe('使魔「龙姬」：特性与好感2/3/5 条按描述落地（原版 战斗相关.ecode L1089-1092/L1548-1556/L2403-2412/L3730-3740）', () => {
  const combat: any = buildGuardCombat();
  // 熟练度 400 → 技能等级 21（skillLevelFromMarkers 的 level*level 阈值表）
  const SKILL_PROF = 400;
  const SKILL_LEVEL = 21;
  const dragon = (over: any = {}) => ({
    userId: 1,
    name: '龙姬训练场',
    type: '龙姬',
    specialSeq: 12,
    skillLevel: 20,
    affinity: 0,
    hp: 100,
    markers: { 龙姬技能熟练度: SKILL_PROF },
    markers2: [] as any[],
    buffs: [] as any[],
    ...over,
  });
  const buffsNamed = (p: any, name: string) => p.buffs.filter((b: any) => b && b.name === name);
  const dodgeStack = (p: any) => Number((buffsNamed(p, '龙姬闪避')[0] || {}).strength || 0);
  const dodgeExpire = (p: any) => Number((buffsNamed(p, '龙姬闪避')[0] || {}).expireAt || 0);

  it('成功闪避敌人攻击：叠 1 层「龙姬闪避」，每层持续 5+技能等级/5 秒，最多 5 层', () => {
    const p = dragon();
    const before = Date.now();
    combat.applyDragonDodgeMark(p, []);
    expect(dodgeStack(p)).toBe(1);
    // 5 + 20/5 = 9 秒（原版 获得增益 第4参；文案已同步为 +【0.2技能等级】）
    expect(dodgeExpire(p)).toBeGreaterThanOrEqual(before + 9_000);
    expect(dodgeExpire(p)).toBeLessThanOrEqual(Date.now() + 9_000);
    for (let i = 0; i < 9; i += 1) combat.applyDragonDodgeMark(p, []);
    expect(dodgeStack(p)).toBe(5); // 描述「可叠加5次」：写入端同时封顶
    expect(buffsNamed(p, '龙姬闪避')).toHaveLength(1); // 叠在同一层容器里，不堆重复条目
  });

  it('非龙姬闪避成功时不写任何增益（描述是龙姬专属）', () => {
    const other = dragon({ type: '花园猫', specialSeq: 1 });
    const lines: string[] = [];
    combat.applyDragonDodgeMark(other, lines);
    expect(other.buffs).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('好感≥60 的「龙闪」：成功闪避额外提前 1 秒闪避冷却；不足 60 或本就无冷却时不写标记', () => {
    const t0 = Date.now();
    const hot = dragon({
      markers: { 龙姬好感: 60, 龙姬技能熟练度: SKILL_PROF },
      markers2: [{ name: '闪避冷却', expireAt: t0 + 10_000 }],
    });
    combat.applyDragonDodgeMark(hot, []);
    expect(hot.markers2[0].expireAt).toBeLessThanOrEqual(t0 + 9_000);
    const coldAffinity = dragon({
      markers: { 龙姬好感: 40, 龙姬技能熟练度: SKILL_PROF },
      markers2: [{ name: '闪避冷却', expireAt: t0 + 10_000 }],
    });
    combat.applyDragonDodgeMark(coldAffinity, []);
    expect(coldAffinity.markers2[0].expireAt).toBe(t0 + 10_000);
    const noCd = dragon({ markers: { 龙姬好感: 100, 龙姬技能熟练度: SKILL_PROF } });
    const lines: string[] = [];
    combat.applyDragonDodgeMark(noCd, lines);
    expect(noCd.markers2).toEqual([]);
    expect(lines.filter((l) => l.includes('龙闪'))).toHaveLength(0);
  });

  it('暴击才刷新「龙姬闪避」的持续时间，且只续时间不加层', () => {
    const p = dragon({ markers: { 龙姬好感: 20, 龙姬技能熟练度: SKILL_PROF } });
    p.buffs = [{ name: '龙姬闪避', strength: 3, expireAt: Date.now() + 2_000 }];
    const before = dodgeExpire(p);
    combat.applyDragonAttackerPhase(p, { markers: p.markers }, { 物伤: 100 }, false, []);
    expect(dodgeExpire(p)).toBe(before); // 未暴击：不刷新
    combat.applyDragonAttackerPhase(p, { markers: p.markers }, { 物伤: 100 }, true, []);
    expect(dodgeExpire(p)).toBeGreaterThan(before);
    expect(dodgeStack(p)).toBe(3); // 层数不变（原版 获得增益 第6/7参为空）
  });

  it('好感≥100 暴击时 8% 几率把物理攻击抬高 200+10×技能等级 %，未暴击/未中骰不抬', () => {
    const p = dragon({ markers: { 龙姬好感: 100, 龙姬技能熟练度: SKILL_PROF } });
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.01);
    try {
      const bonus: any = { 物伤: 100 };
      const lines: string[] = [];
      expect(combat.applyDragonAttackerPhase(p, { markers: p.markers }, bonus, true, lines)).toBe(true);
      // 等级 21 → +410% → 100 × 5.1 = 510
      expect(bonus.物伤).toBeCloseTo(510, 6);
      expect(lines.some((l) => l.includes('(驱魔410%)'))).toBe(true);
      const miss: any = { 物伤: 100 };
      spy.mockReturnValue(0.5);
      expect(combat.applyDragonAttackerPhase(p, { markers: p.markers }, miss, true, [])).toBe(false);
      expect(miss.物伤).toBe(100);
      const noCrit: any = { 物伤: 100 };
      spy.mockReturnValue(0.01);
      expect(combat.applyDragonAttackerPhase(p, { markers: p.markers }, noCrit, false, [])).toBe(false);
      expect(noCrit.物伤).toBe(100);
    } finally {
      spy.mockRestore();
    }
  });

  it('好感≥60 的「龙闪」按原版 c：命中提前 1 秒、暴击这次共提前 2 秒', () => {
    const t0 = Date.now();
    const mk = () => [{ name: '闪避冷却', expireAt: t0 + 20_000 }];
    const markers = { 龙姬好感: 60, 龙姬技能熟练度: SKILL_PROF };
    const hit = dragon({ markers, markers2: mk() });
    combat.applyDragonAttackerPhase(hit, { markers }, {}, false, []);
    expect(hit.markers2[0].expireAt).toBeLessThanOrEqual(t0 + 19_000);
    const crit = dragon({ markers, markers2: mk() });
    combat.applyDragonAttackerPhase(crit, { markers }, {}, true, []);
    expect(crit.markers2[0].expireAt).toBeLessThanOrEqual(t0 + 18_000);
  });

  it('非龙姬不进入命中/暴击侧（不刷新、不抬物伤、不写龙闪文本）', () => {
    const other = dragon({ type: '花园猫', specialSeq: 1 });
    other.buffs = [{ name: '龙姬闪避', strength: 2, expireAt: Date.now() + 2_000 }];
    const before = dodgeExpire(other);
    const bonus: any = { 物伤: 100 };
    const lines: string[] = [];
    expect(combat.applyDragonAttackerPhase(other, { markers: other.markers }, bonus, true, lines)).toBe(false);
    expect(dodgeExpire(other)).toBe(before);
    expect(bonus.物伤).toBe(100);
    expect(lines).toEqual([]);
  });

  it('好感≥40 挂「点燃」：强度 5+技能等级/2、持续 20 秒（原版第4参是秒数、第6参是强度，此前写反）', () => {
    const markers = { 龙姬好感: 40, 龙姬技能熟练度: SKILL_PROF };
    const out = combat.processDragonGirlEffects(
      dragon({ markers }), { markers }, {} as any, {} as any, { defenderBuffs: [] },
    );
    const ignite = out.defenderBuffs.find((b: any) => b.name === '点燃');
    expect(ignite.strength).toBeCloseTo(5 + SKILL_LEVEL / 2, 6); // 15.5
    expect(ignite.duration).toBe(20);
    const low = combat.processDragonGirlEffects(
      dragon({ markers: { ...markers, 龙姬好感: 20 } }),
      { markers: { ...markers, 龙姬好感: 20 } }, {} as any, {} as any, { defenderBuffs: [] },
    );
    expect(low.defenderBuffs).toEqual([]);
  });
});

describe('兰音：心无所扰/月落寸光 对宠物生效（特性末句，原版 使魔技能.ecode L2395-2421）', () => {
  /** 只装 applySummonNextAttack 用到的依赖：mapService + safeParse */
  const buildSkillService = (summons: any[]) => {
    const service: any = Object.create(FamiliarSkillsService.prototype);
    service.safeParse = (v: any, fb?: any) => {
      if (v == null) return fb ?? [];
      if (typeof v !== 'string') return v;
      try { return JSON.parse(v); } catch { return fb ?? []; }
    };
    service.mapService = {
      getMapById: async () => ({ id: 1, summons }),
      updateDynamicFields: async (_mapId: number, data: any) => {
        // 深拷贝回写：data.summons 与闭包里的 summons 是同一个数组引用，直接 push 会自我清空
        const next = JSON.parse(JSON.stringify(data.summons || []));
        summons.length = 0;
        summons.push(...next);
      },
    };
    return service;
  };
  const combat: any = buildGuardCombat();

  it('写入宠物身上的蓄势必须带 onceAttack 识别位，否则消费端整条读不到', async () => {
    const summons: any[] = [{ name: '宇航兔', buffs: [] }];
    const svc = buildSkillService(summons);
    await svc.applySummonNextAttack(1, '宇航兔', { mustHitNext: true, mustHitChance: 30 });
    await svc.applySummonNextAttack(1, '宇航兔', { nextPenetration: true, skillLevelForPen: 21 });
    expect(summons[0].buffs.map((b: any) => b.name)).toEqual(['心无所扰·蓄势', '月落寸光·蓄势']);
    expect(summons[0].buffs.every((b: any) => b.onceAttack === true)).toBe(true);

    const pet: any = { name: '宇航兔', buffs: summons[0].buffs };
    const consumed = combat.consumeNextAttackBuffs(pet);
    expect(consumed.mustHitNext).toBe(true);
    expect(consumed.mustHitChance).toBe(30);
    expect(consumed.nextPenetration).toBe(true);
    expect(consumed.skillLevelForPen).toBe(21);
    // 一次性：消费后身上不再留蓄势（宠物侧由调用方回写 buffs）
    expect(pet.buffs).toEqual([]);
  });

  it('同类蓄势重复施加只覆盖一条，不会在宠物身上堆叠', async () => {
    const summons: any[] = [{ name: '宇航兔', buffs: [] }];
    const svc = buildSkillService(summons);
    await svc.applySummonNextAttack(1, '宇航兔', { mustHitNext: true, mustHitChance: 30 });
    await svc.applySummonNextAttack(1, '宇航兔', { mustHitNext: true, mustHitChance: 45 });
    expect(summons[0].buffs).toHaveLength(1);
    expect(summons[0].buffs[0].mustHitChance).toBe(45);
  });

  it('穿透只在攻击方一侧被消费：月落寸光写在防御方身上等于没写', () => {
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.9);
    try {
      const def = () => ({
        生命: 1e6, 护盾: 1e6, 装甲: 1e6, 闪避: 0, 闪避2: 0,
        护盾物抗: 80, 装甲物抗: 80, 生命物抗: 80,
      } as any);
      const atk = (pen: number) => ({
        攻击: 1000, 攻击2: 0, 命中: 100, 命中2: 0,
        护盾穿透: pen, 装甲穿透: pen, 生命穿透: pen,
      } as any);
      const weapon = {
        name: '测试武器', damage: 0, damageType: 1,
        properties: { phys: 100, fire: 0, ice: 0, elec: 0 },
      } as any;
      const base = combat.calcDamage(atk(0), def(), weapon, 1, false).damage;
      const boosted = combat.calcDamage(atk(50), def(), weapon, 1, false).damage;
      expect(boosted).toBeGreaterThan(base);
      const onDefender = combat.calcDamage(
        atk(0), { ...def(), 护盾穿透: 50, 装甲穿透: 50, 生命穿透: 50 }, weapon, 1, false,
      ).damage;
      expect(onDefender).toBeCloseTo(base, 6);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('使魔「军姬X」好感5「(折磨)」：连续击中同一目标按次数追加（文案口径）', () => {
  const combat: any = buildGuardCombat();
  const MARKERS = { 军姬X技能熟练度: 400 }; // → 技能等级 21
  const junji = () => ({
    userId: 7, name: '甲', type: '军姬X', specialSeq: 24, affinity: 100, markers: { ...MARKERS },
  });
  const BASE = { 物伤: 1000, 火伤: 0, 电伤: 0, 冰伤: 0 };
  const PROPS = { phys: 100, fire: 0, ice: 0, elec: 0 };
  const COUNTER_KEY = 'jj2hg57'; // jj2hg5 + 攻击方 userId
  const swing = (target: any, bonus: any = {}) => {
    const lines: string[] = [];
    combat.applyJunjiTorture(
      junji(), { markers: MARKERS }, bonus, BASE, PROPS, target, target.markers, false, lines,
    );
    return lines.join('|');
  };

  it('第1次火焰29.2%、第2次雷电38.25%、第3次护盾/装甲+25.5%、第4次全带上并重置计数', () => {
    const target: any = { name: '怪', markers: {} };
    const b1: any = {};
    expect(swing(target, b1)).toContain('折磨1');
    expect(b1.火伤).toBeCloseTo(292, 6); // 1000 ×（25+21/5)%
    expect(target.markers[COUNTER_KEY]).toBe(1);
    const b2: any = {};
    expect(swing(target, b2)).toContain('折磨2');
    expect(b2.电伤).toBeCloseTo(382.5, 6); // 1000 ×（33+21/4)%
    expect(b2.火伤).toBeUndefined();
    expect(target.markers[COUNTER_KEY]).toBe(2);
    const b3: any = {};
    expect(swing(target, b3)).toContain('折磨3');
    expect(b3.攻击护盾).toBeCloseTo(25.5, 6); // 15+21/2
    expect(b3.攻击装甲).toBeCloseTo(25.5, 6);
    expect(target.markers[COUNTER_KEY]).toBe(3);
    const b4: any = {};
    expect(swing(target, b4)).toContain('折磨4');
    expect(b4.火伤).toBeCloseTo(292, 6);
    expect(b4.电伤).toBeCloseTo(382.5, 6);
    expect(b4.攻击护盾).toBeCloseTo(25.5, 6);
    expect(target.markers[COUNTER_KEY]).toBe(0); // 第4次后归零，重新开始数
  });

  it('换一个目标重新数：计数挂在目标身上而不是攻击方身上', () => {
    const a: any = { name: '怪A', markers: {} };
    const b: any = { name: '怪B', markers: {} };
    swing(a);
    const lines = swing(b);
    expect(lines).toContain('折磨1'); // 打另一只怪仍算第1次
    expect(a.markers[COUNTER_KEY]).toBe(1);
    expect(b.markers[COUNTER_KEY]).toBe(1);
  });

  it('好感不足100 / 非军姬X：不追加伤害也不推进计数', () => {
    const target: any = { name: '怪', markers: {} };
    const low = { ...junji(), affinity: 80 };
    combat.applyJunjiTorture(
      low, { markers: MARKERS }, {}, BASE, PROPS, target, target.markers, false, [],
    );
    expect(target.markers).toEqual({});
    const other = { userId: 8, name: '乙', type: '花园猫', specialSeq: 1, affinity: 100, markers: {} };
    combat.applyJunjiTorture(
      other, { markers: {} }, {}, BASE, PROPS, target, target.markers, false, [],
    );
    expect(target.markers).toEqual({});
  });

  it('基数取进入额外伤害段之前的四系属性快照，不吃同段效果的复利', () => {
    const target: any = { name: '怪', markers: {} };
    const bonus: any = {};
    combat.applyJunjiTorture(
      junji(), { markers: MARKERS }, bonus,
      { 物伤: 100, 火伤: 0, 电伤: 0, 冰伤: 0 }, PROPS, target, target.markers, false, [],
    );
    // 快照 100 ×（25+21/5)% = 29.2；若误用攻击方当前四系（此处为 0）会得到 0
    expect(bonus.火伤).toBeCloseTo(29.2, 6);
  });
});

describe('使魔「伊芙利特」：五番叠层与 EX！ 补击/削闪避（原版 战斗相关.ecode L1074-1079/L1686-1688/L2415-2419/L2462-2466）', () => {
  const combat: any = buildGuardCombat();
  const PROF = { 伊芙利特好感: 80, 伊芙利特技能熟练度: 400 }; // 等级 21
  const ifrit = (markers: any = PROF) => ({
    userId: 3, name: '伊芙', type: '伊芙利特', specialSeq: 11, affinity: 0,
    markers, buffs: [] as any[], markers2: [] as any[],
  });
  const ctx = (over: any = {}) => ({ ...over }) as any;

  it('每次出手给「五番」+1 层、持续 20 秒（原版第4参是秒数、第6参是层数，此前两参对调）', () => {
    const p = ifrit();
    const out = combat.processIfritEffects(p, { markers: p.markers }, {} as any, ctx(), { } as any);
    const five = out.attackerBuffs.find((b: any) => b.name === '五番');
    expect(five).toMatchObject({ strength: 1, duration: 20, stackStrength: true });
    // 原版这里只回显层数，自造的「本次攻击 +20%」必须拿掉
    expect(out.damageMultiplier ?? 0).toBe(0);
    expect(out.effectText).toContain('【五番1】');
    // 好感不足 40 时整条不成立
    const low = combat.processIfritEffects(
      ifrit({ 伊芙利特好感: 20, 伊芙利特技能熟练度: 400 }), { markers: { 伊芙利特好感: 20 } },
      {} as any, ctx(), {},
    );
    expect(low.attackerBuffs ?? []).toEqual([]);
  });

  it('暴击再叠一层，并按描述封顶在 5+技能等级 层', () => {
    const p = ifrit({ ...PROF, 伊芙利特好感: 40 });
    p.buffs = [{ name: '五番', strength: 3, expireAt: Date.now() + 5_000 }];
    const lines: string[] = [];
    expect(combat.applyIfritAttackerPhase(p, { markers: p.markers }, true, ctx(), lines)).toBe(0);
    expect(p.buffs.find((b: any) => b.name === '五番')!.strength).toBe(4);
    expect(lines.join('|')).toContain('【五番4】');
    // 封顶 5+21 = 26 层
    p.buffs = [{ name: '五番', strength: 26, expireAt: Date.now() + 5_000 }];
    combat.applyIfritAttackerPhase(p, { markers: p.markers }, true, ctx(), []);
    expect(p.buffs.find((b: any) => b.name === '五番')!.strength).toBe(26);
    // 未暴击不叠层
    const plain = ifrit({ ...PROF, 伊芙利特好感: 40 });
    plain.buffs = [{ name: '五番', strength: 2, expireAt: Date.now() + 5_000 }];
    combat.applyIfritAttackerPhase(plain, { markers: plain.markers }, false, ctx(), []);
    expect(plain.buffs.find((b: any) => b.name === '五番')!.strength).toBe(2);
  });

  it('好感≥80 命中送一次额外攻击，2 秒冷却内不再送；补击自身与连击不再递归', () => {
    const p = ifrit();
    const lines: string[] = [];
    expect(combat.applyIfritAttackerPhase(p, { markers: p.markers }, false, ctx(), lines)).toBe(1);
    expect(lines.join('|')).toContain('【EX!】');
    expect(p.markers2.some((m: any) => m.name === '琴里连击')).toBe(true);
    // 2 秒冷却内：不再补击
    expect(combat.applyIfritAttackerPhase(p, { markers: p.markers }, false, ctx(), [])).toBe(0);
    // 冷却已过：又可以补一次
    p.markers2 = p.markers2.map((m: any) => ({ ...m, expireAt: Date.now() - 1 }));
    expect(combat.applyIfritAttackerPhase(p, { markers: p.markers }, false, ctx(), [])).toBe(1);
    // 补击/连击/延时这些自身调用不再触发第二次补击
    p.markers2 = [];
    expect(combat.applyIfritAttackerPhase(p, { markers: p.markers }, false, ctx({ isExtraAttack: true }), [])).toBe(0);
    p.markers2 = [];
    expect(combat.applyIfritAttackerPhase(p, { markers: p.markers }, false, ctx({ isCombo: true }), [])).toBe(0);
    // 好感不足 80：没有补击，但五番照旧
    const low = ifrit({ ...PROF, 伊芙利特好感: 60 });
    expect(combat.applyIfritAttackerPhase(low, { markers: low.markers }, false, ctx(), [])).toBe(0);
    expect(low.markers2).toEqual([]);
  });

  it('未命中时给目标挂「削弱闪避」15秒、强度 10+技能等级/2（此前全仓只有消费端）', async () => {
    const p = ifrit();
    const target: any = { userId: 9, name: '对手', buffs: [], markers: {} };
    const lines: string[] = [];
    await combat.applyIfritDodgeDebuffOnMiss(p, { markers: p.markers }, target, { id: 1 }, lines);
    const debuff = target.buffs.find((b: any) => b.name === '削弱闪避');
    expect(debuff).toBeDefined();
    expect(debuff.strength).toBeCloseTo(20.5, 6); // 10 + 21/2
    expect(debuff.expireAt).toBeGreaterThanOrEqual(Date.now() + 15_000 - 50);
    expect(lines.join('|')).toContain('的闪避降低了21%');
    // 好感不足 / 非伊芙利特：什么都不写
    const low = ifrit({ ...PROF, 伊芙利特好感: 60 });
    const t2: any = { userId: 10, name: '丙', buffs: [], markers: {} };
    await combat.applyIfritDodgeDebuffOnMiss(low, { markers: low.markers }, t2, { id: 1 }, []);
    expect(t2.buffs).toEqual([]);
    const other = ifrit();
    other.type = '花园猫';
    other.specialSeq = 1;
    const t3: any = { userId: 11, name: '丁', buffs: [], markers: {} };
    await combat.applyIfritDodgeDebuffOnMiss(other, { markers: other.markers }, t3, { id: 1 }, []);
    expect(t3.buffs).toEqual([]);
  });

  it('打在怪物身上时要单独把减益写回地图：未命中分支本来不落库', async () => {
    const persist = jest.spyOn(combat, 'updateMonsterHpInMap').mockResolvedValue(undefined);
    try {
      const p = ifrit();
      const monster: any = { name: '怪', buffs: [], markers: {} };
      await combat.applyIfritDodgeDebuffOnMiss(p, { markers: p.markers }, monster, { id: 7 }, []);
      expect(monster.buffs.some((b: any) => b.name === '削弱闪避')).toBe(true);
      expect(persist).toHaveBeenCalledWith(7, monster);
    } finally {
      persist.mockRestore();
    }
  });

  it('空间震a 给目标挂 15 秒「空间震」标记2（好感5 的闪避双倍冷却才有数据来源）', () => {
    const target: any = { name: '怪', markers2: [] };
    const lines: string[] = [];
    combat.applySpaceQuakeMark(target, '空间震a', lines);
    const mark = target.markers2.find((m: any) => m.name === '空间震');
    expect(mark).toBeDefined();
    expect(mark.expireAt).toBeGreaterThanOrEqual(Date.now() + 15_000 - 50);
    expect(lines).toEqual(['【空间震】']);
    // 其它攻击文本一律不挂；缺 target 也不炸
    const other: any = { name: '怪2', markers2: [] };
    combat.applySpaceQuakeMark(other, '会心一击a', []);
    expect(other.markers2).toEqual([]);
    expect(() => combat.applySpaceQuakeMark(undefined, '空间震a', [])).not.toThrow();
  });
});

describe('使魔「绝灭天使」好感5「(救世魔王)」：地图死亡计数与转化（原版 _主程序.ecode L11974-11996）', () => {
  const buildIfritAngels = () => {
    const combat: any = buildGuardCombat();
    const merged: Array<{ mapId: number; markers: any[] }> = [];
    combat.mapService = {
      mergeMapMarkers2: async (mapId: number, markers: any[]) => {
        merged.push({ mapId, markers: JSON.parse(JSON.stringify(markers)) });
      },
    };
    return { combat, merged };
  };
  const origami = (aff: number, over: any = {}) => ({
    userId: 21, name: '折纸', type: '绝灭天使', specialSeq: 3, affinity: aff,
    markers: { 绝灭天使好感: aff }, markers2: [] as any[], buffs: [] as any[], ...over,
  });
  const mapWithDefeated = (deaths: number, remainMs = 30_000) => ({
    id: 5,
    markers2: deaths > 0
      ? [{ name: '被击败', strength: deaths, expireAt: Date.now() + remainMs, stackTime: false }]
      : [],
  });

  it('玩家或宠物被打倒 → 地图标记2「被击败」计层，30 秒窗口、再死一次只加层', async () => {
    const { combat, merged } = buildIfritAngels();
    const map: any = { id: 5, markers2: [] };
    await combat.markMapDefeated(map);
    const first = map.markers2.find((m: any) => m.name === '被击败');
    expect(first.strength).toBe(1);
    expect(first.expireAt).toBeGreaterThanOrEqual(Date.now() + 30_000 - 50);
    await combat.markMapDefeated(map);
    expect(map.markers2.filter((m: any) => m.name === '被击败')).toHaveLength(1);
    expect(map.markers2[0].strength).toBe(2);
    expect(merged.map((x) => x.mapId)).toEqual([5, 5]); // 按名合并落库，不整组覆盖
  });

  it('好感≥100 且地图有死亡计数时转化成 30 秒救世魔王，并写 3 分钟转化冷却', async () => {
    const { combat } = buildIfritAngels();
    const p: any = origami(100);
    const map: any = mapWithDefeated(1);
    const lines: string[] = [];
    const before = Date.now();
    expect(await combat.refreshSaviorForm(p, { markers: p.markers }, map, lines)).toBe(true);
    const savior = p.buffs.find((b: any) => b.name === '救世魔王');
    expect(savior).toBeDefined();
    expect(savior.expireAt).toBeGreaterThanOrEqual(before + 30_000 - 50);
    expect(p.markers2.some((m: any) => m.name === '转化1')).toBe(true);
    expect(lines.join('')).toContain('折纸转化成了救世魔王');
    // 原版 L11978：转化一次吃掉 30 秒窗口 → 单层计数被提前到已过期，整条被移除
    expect(map.markers2.find((m: any) => m.name === '被击败')).toBeUndefined();
  });

  it('友军死亡越多时长越长（30 + (N-1)×5 秒），但仍是每 3 分钟转化一次', async () => {
    const { combat } = buildIfritAngels();
    const p: any = origami(100);
    await combat.refreshSaviorForm(p, { markers: p.markers }, mapWithDefeated(1), []);
    // 已在救世魔王态：新死亡只按 层数×5 秒延长，不再重挂、也不吃转化冷却
    const firstExpire = p.buffs.find((b: any) => b.name === '救世魔王').expireAt;
    const before = Date.now();
    expect(await combat.refreshSaviorForm(
      p, { markers: p.markers }, mapWithDefeated(3, 60_000), [],
    )).toBe(true);
    expect(p.buffs.filter((b: any) => b.name === '救世魔王')).toHaveLength(1);
    expect(p.buffs.find((b: any) => b.name === '救世魔王').expireAt)
      .toBeGreaterThanOrEqual(firstExpire + 15_000 - 50);
    // 冷却内（未持有救世魔王）不再转化
    const q: any = origami(100, {
      markers: { 绝灭天使好感: 100 },
      markers2: [{ name: '转化1', expireAt: Date.now() + 60_000 }],
    });
    const map2: any = mapWithDefeated(1);
    expect(await combat.refreshSaviorForm(q, { markers: q.markers }, map2, [])).toBe(true);
    expect(q.buffs).toEqual([]);
  });

  it('首次转化按时长公式 30+(N-1)×5 秒（N 为地图死亡层数）', async () => {
    const { combat } = buildIfritAngels();
    const p: any = origami(100);
    const before = Date.now();
    await combat.refreshSaviorForm(p, { markers: p.markers }, mapWithDefeated(3, 60_000), []);
    const savior = p.buffs.find((b: any) => b.name === '救世魔王');
    expect(savior.expireAt).toBeGreaterThanOrEqual(before + 40_000 - 50); // 30 + 2×5
    expect(savior.expireAt).toBeLessThan(before + 45_000);
  });

  it('非绝灭天使 / 好感不足 / 地图没有死亡计数 → 一律不转化', async () => {
    const { combat, merged } = buildIfritAngels();
    const other: any = { ...origami(100), type: '花园猫', specialSeq: 1 };
    expect(await combat.refreshSaviorForm(other, { markers: other.markers }, mapWithDefeated(2), [])).toBe(false);
    const low: any = origami(80);
    expect(await combat.refreshSaviorForm(low, { markers: low.markers }, mapWithDefeated(2), [])).toBe(false);
    const noDeaths: any = origami(100);
    expect(await combat.refreshSaviorForm(
      noDeaths, { markers: noDeaths.markers }, mapWithDefeated(0), [],
    )).toBe(false);
    expect(noDeaths.buffs).toEqual([]);
    expect(merged).toEqual([]); // 什么都没改就不落库
  });
});

describe('四糸乃(15)「冰雪之心/冰精灵」与伊芙利特「火精灵」投放端（原版 战斗相关.ecode L2946-2965 / L3078-3083）', () => {
  const combat: any = buildGuardCombat();
  const PROF = 400; // → 技能等级 21
  const shisonae = (aff: number) => ({
    userId: 31, name: '四糸乃训练场', type: '四糸乃', specialSeq: 15, affinity: aff,
    markers: { 四糸乃好感: aff, 四糸乃技能熟练度: PROF }, buffs: [] as any[], markers2: [] as any[],
  });
  const ifritVictim = (aff: number) => ({
    userId: 32, name: '伊芙利特训练场', type: '伊芙利特', specialSeq: 11, affinity: aff,
    markers: { 伊芙利特好感: aff, 伊芙利特技能熟练度: PROF }, buffs: [] as any[], markers2: [] as any[],
  });
  const weapon = { damage: 0, properties: { phys: 0, fire: 0, ice: 100, elec: 0 } } as any;

  it('命中 33% 判定通过时追加 (25+技能等级)% 的冰冻伤害，并凝固目标 15 秒（同一目标 60 秒一次）', () => {
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.1); // <33%
    try {
      const p = shisonae(20);
      const bonus: any = { 攻击: 1000 };
      const target: any = { name: '怪', buffs: [], markers2: [] };
      const lines: string[] = [];
      combat.applyIceHeart(p, { markers: p.markers }, bonus, weapon, target, lines);
      expect(bonus.冰伤).toBeCloseTo(1000 * (25 + 21) / 100, 6); // 460
      expect(lines.join('')).toContain('(冰心460)');
      const frozen = target.buffs.find((b: any) => b.name === '幻时');
      expect(frozen).toBeDefined(); // 凝固 = 挂 15 秒「幻时」（消费端：怪物回合跳过）
      expect(frozen.expireAt).toBeGreaterThanOrEqual(Date.now() + 15_000 - 50);
      expect(target.markers2.some((m: any) => m.name === '凝固冷却')).toBe(true);
      expect(lines.join('')).toContain('(凝固)');
      // 同一目标 60 秒内不再凝固，但冰心照旧
      const bonus2: any = { 攻击: 1000 };
      const lines2: string[] = [];
      combat.applyIceHeart(p, { markers: p.markers }, bonus2, weapon, target, lines2);
      expect(bonus2.冰伤).toBeGreaterThan(0);
      expect(lines2.join('')).not.toContain('(凝固)');
    } finally {
      spy.mockRestore();
    }
  });

  it('33% 未通过、好感不足20、非四糸乃：都不追加也不挂凝固', () => {
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.9); // ≥33%
    try {
      const bonus: any = { 攻击: 1000 };
      const target: any = { name: '怪', buffs: [], markers2: [] };
      const p = shisonae(20);
      combat.applyIceHeart(p, { markers: p.markers }, bonus, weapon, target, []);
      expect(bonus.冰伤).toBeUndefined();
      expect(target.buffs).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    const lowBonus: any = { 攻击: 1000 };
    const low = shisonae(0);
    combat.applyIceHeart(low, { markers: low.markers }, lowBonus, weapon, { buffs: [], markers2: [] }, []);
    expect(lowBonus.冰伤).toBeUndefined();
    const otherBonus: any = { 攻击: 1000 };
    const other = { ...shisonae(100), type: '花园猫', specialSeq: 1 };
    combat.applyIceHeart(other, { markers: other.markers }, otherBonus, weapon, { buffs: [], markers2: [] }, []);
    expect(otherBonus.冰伤).toBeUndefined();
  });

  it('造成冰属性伤害后给自己挂 15 秒「冰精灵」；消费端按原版给 冰伤2+30+技等、穿透+15', () => {
    const p: any = shisonae(20);
    combat.applyIceSpiritMark(p, 12.5);
    const mark = p.buffs.find((b: any) => b.name === '冰精灵');
    expect(mark).toBeDefined();
    expect(mark.expireAt).toBeGreaterThanOrEqual(Date.now() + 15_000 - 50);
    const zero: any = shisonae(20);
    combat.applyIceSpiritMark(zero, 0);
    expect(zero.buffs).toEqual([]);
    const notHers: any = { ...shisonae(20), type: '花园猫', specialSeq: 1 };
    combat.applyIceSpiritMark(notHers, 99);
    expect(notHers.buffs).toEqual([]);

    // 消费端数值（原版 加成计算 L158-161：穿透是 +15，此前移植写成 10）
    const bonus: any = {};
    new BonusService().calculateGameBonus(
      { bonus, buffs: [{ name: '冰精灵', expireAt: Date.now() + 60_000 }], skillLevel: 21 },
      Math.floor(Date.now() / 1000),
    );
    expect(bonus.冰伤2).toBeCloseTo(51, 6);
    expect(bonus.护盾穿透).toBeGreaterThanOrEqual(15);
    expect(bonus.装甲穿透).toBeGreaterThanOrEqual(15);
    expect(bonus.生命穿透).toBeGreaterThanOrEqual(15);
  });

  it('伊芙利特受到火焰伤害时挂 15 秒「火精灵」（好感≥80，原版同档）', () => {
    const v: any = ifritVictim(80);
    const lines: string[] = [];
    combat.applyFireSpiritMark(v, 30, lines);
    const mark = v.buffs.find((b: any) => b.name === '火精灵');
    expect(mark).toBeDefined();
    expect(mark.expireAt).toBeGreaterThanOrEqual(Date.now() + 15_000 - 50);
    expect(lines.join('')).toContain('【火精灵】');
    const low: any = ifritVictim(60);
    combat.applyFireSpiritMark(low, 30, []);
    expect(low.buffs).toEqual([]);
    const noFire: any = ifritVictim(100);
    combat.applyFireSpiritMark(noFire, 0, []);
    expect(noFire.buffs).toEqual([]);
  });
});

describe('使魔「星尘」好感2「(脉冲星)」与好感5「(中子星)」投放端（原版 战斗相关.ecode L3602-3609）', () => {
  const combat: any = buildGuardCombat();
  const stardust = (aff: number, over: any = {}) => ({
    userId: 41, name: '星尘训练场', type: '星尘', specialSeq: 14, affinity: aff,
    markers: { 星尘好感: aff }, buffs: [] as any[], markers2: [] as any[],
    shield: 40, maxShield: 100, ...over,
  });
  const def = { 护盾: 100 } as any;
  const stacksOf = (v: any) => Number((v.buffs.find((b: any) => b.name === '中子星') || {}).strength || 0);
  const coolReady = (v: any) => {
    v.markers2 = v.markers2.map((m: any) => ({ ...m, expireAt: Date.now() - 1 }));
  };

  it('好感≥40：受到伤害后回复已损失护盾的15%', () => {
    const v: any = stardust(40);
    const lines: string[] = [];
    combat.applyStardustOnDamaged(v, def, lines);
    expect(v.shield).toBeCloseTo(40 + 60 * 0.15, 6);
    expect(lines.join('')).toContain('(脉冲星)回复了9护盾');
    // 护盾已满 → 没有"已损失"可回
    const full: any = stardust(40, { shield: 100 });
    const lines2: string[] = [];
    combat.applyStardustOnDamaged(full, def, lines2);
    expect(full.shield).toBe(100);
    expect(lines2.join('')).not.toContain('脉冲星');
    // 好感不足 40 不回复
    const low: any = stardust(20);
    combat.applyStardustOnDamaged(low, def, []);
    expect(low.shield).toBe(40);
  });

  it('好感≥100：每次受击叠 1 层「中子星」，5 秒冷却内不叠、封顶 200 层', () => {
    const v: any = stardust(100);
    combat.applyStardustOnDamaged(v, def, []);
    expect(stacksOf(v)).toBe(1);
    expect(v.buffs.find((b: any) => b.name === '中子星').expireAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(v.markers2.some((m: any) => m.name === 'dzx')).toBe(true);
    combat.applyStardustOnDamaged(v, def, []); // 冷却内
    expect(stacksOf(v)).toBe(1);
    coolReady(v);
    combat.applyStardustOnDamaged(v, def, []);
    expect(stacksOf(v)).toBe(2);
    // 已到 200 层：不再往上刷
    const maxed: any = stardust(100, {
      buffs: [{ name: '中子星', strength: 200, expireAt: Math.floor(Date.now() / 1000) + 3600 }],
    });
    combat.applyStardustOnDamaged(maxed, def, []);
    expect(stacksOf(maxed)).toBe(200);
    // 好感不到 100 一律不叠
    const low: any = stardust(80);
    combat.applyStardustOnDamaged(low, def, []);
    expect(stacksOf(low)).toBe(0);
  });
});

describe('装备「福音书」：伤害被定义为1、持续5分钟、触发10次后过载（equipments.json 说明）', () => {
  // 说明原文：「使目标受到的伤害(包括额外伤害)被定义为1，持续5分钟或者触发10次后过载。一天只能使用一次。」
  // 施放端（FamiliarSystemService.gospelBook）写 增益「福音书」300秒 强度10；
  // 消费端在 combat-system 的承伤结算里把四系剩余伤害压到 0.25（合计≈1）、清空额外三池，
  // 并把强度当剩余触发次数递减。原版只判断强度>0、从不递减，即「触发10次后过载」这半句
  // 在原版里未实装，本移植按说明补齐。
  const callResolve = (combat: any, victim: any, lines: string[]) => combat.resolveVehicleDamage({
    vehicle: undefined,
    vehicleIndex: -1,
    mapVehicles: [],
    map: { id: 1 },
    attacker: { name: '训练木桩', markers: {}, markers2: '[]' },
    attackerBonus: {},
    victim,
    damage: {
      poolDamage: { shield: 0, armor: 0, hp: 3000 },
      damageBreakdown: { physical: 3000, fire: 0, ice: 0, elec: 0 },
      penetrated: false,
    },
    baseDamage: 3000,
    altinaMultiplier: 1,
    lines,
  });

  const makeVictim = (strength: number): any => ({
    name: '冒险者',
    hp: 500, armor: 0, shield: 0,
    markers: {}, markers2: '[]',
    buffs: strength > 0
      ? [{ name: '福音书', strength, expireAt: Date.now() + 300_000 }]
      : [],
  });

  it('有余量时把伤害压到≈1、清空额外伤害，并消耗一次触发（不续时间）', async () => {
    const combat = buildGuardCombat();
    const victim = makeVictim(10);
    const before = victim.buffs[0].expireAt;
    const lines: string[] = [];
    const r = await callResolve(combat, victim, lines);

    expect(r.damageToPlayer).toBeLessThanOrEqual(2);
    expect(lines.join(' ')).toContain('福音书9');
    expect(victim.buffs[0].strength).toBe(9);
    expect(victim.buffs[0].expireAt).toBe(before); // 「持续5分钟」从施放起算，触发不续期
  });

  it('第10次触发后过载：之后按正常伤害结算', async () => {
    const combat = buildGuardCombat();
    const victim = makeVictim(1);
    const lines: string[] = [];
    await callResolve(combat, victim, lines);
    expect(lines.join(' ')).toContain('福音书过载');
    expect(victim.buffs[0].strength).toBe(0);

    lines.length = 0;
    const after = await callResolve(combat, victim, lines);
    expect(after.damageToPlayer).toBeGreaterThan(2); // 过载后不再免伤
    expect(lines.join(' ')).not.toContain('福音书');
  });

  it('对照：没挂福音书时同样的攻击正常造成 3000 点伤害', async () => {
    const combat = buildGuardCombat();
    const victim = makeVictim(0);
    const lines: string[] = [];
    const r = await callResolve(combat, victim, lines);
    expect(r.damageToPlayer).toBeGreaterThan(2000);
    expect(lines.join(' ')).not.toContain('福音书');
  });

  it('施放端只写「福音书」这一条增益，强度10、300秒（与消费端口径一致）', async () => {
    const written: any[] = [];
    const service: any = Object.create(FamiliarSkillsService.prototype);
    // 委托回归：使用技能入口与主指令入口必须落到同一个实现（FamiliarSystemService.gospelBook）
    service.familiarSystem = {
      gospelBook: jest.fn(async (_uid: number, target?: string) => {
        written.push(target ?? null);
        return '给自己使用了福音书';
      }),
      safetyAngel: jest.fn(async () => '给自己套上了行星护盾'),
    };
    service.playerService = { getPlayerData: jest.fn(async () => ({ player: {}, markers: {} })) };
    service.taskService = { advance: jest.fn(async () => undefined) };

    await service.routeSkill(1, '福音书', '队友');
    await service.routeSkill(1, '安乐天使', undefined);
    expect(service.familiarSystem.gospelBook).toHaveBeenCalledWith(1, '队友');
    expect(service.familiarSystem.safetyAngel).toHaveBeenCalledWith(1, undefined);
  });
});

describe('使魔「花园猫」好感1「(重伤)」投放端（familiars.json 好感第1条）', () => {
  // 描述：「(重伤)被猫猫击中的目标，被命中率和受到的伤害提高10(+【0.5技能等级】)%，
  //        持续10(+【0.5技能等级】)秒。」
  // 此前 processGardenCatEffects 是空实现（全仓没有 重伤 的写入点），消费端却按
  // 强度往 易伤 上累加，于是整条描述既不成立、又留着一个永远读不到的分支。
  const SKILL_PROF = 90; // 熟练度→技能等级：与 龙姬 用例同一档（skillLevelFromMarkers 口径）
  const cat = (markers: any) => ({ type: '花园猫', specialSeq: 1, markers });
  const catMarkers = (affinity: number) => ({ 花园猫好感: affinity, 花园猫技能熟练度: SKILL_PROF });

  it('好感≥20：命中后给目标挂 重伤，强度与持续同为 10+0.5技能等级', () => {
    const combat: any = buildGuardCombat();
    const markers = catMarkers(20);
    const out = combat.processGardenCatEffects(
      cat(markers), { markers }, {} as any, {} as any, { defenderBuffs: [] },
    );
    const heavy = out.defenderBuffs.find((b: any) => b.name === '重伤');
    const skillLevel = combat.skillLevelFromMarkers(markers, '花园猫');
    expect(heavy).toBeTruthy();
    expect(heavy.strength).toBeCloseTo(10 + skillLevel / 2, 6);
    expect(heavy.duration).toBeCloseTo(10 + skillLevel / 2, 6); // 原版：时长与强度同一个式子
    expect(out.effectText).toContain('重伤');
  });

  it('好感<20 / 非花园猫：不挂 重伤', () => {
    const combat: any = buildGuardCombat();
    const low = catMarkers(19);
    const out = combat.processGardenCatEffects(
      cat(low), { markers: low }, {} as any, {} as any, { defenderBuffs: [] },
    );
    expect(out.defenderBuffs).toEqual([]);
  });
});

describe('使魔「花园猫」四条地图级增益（猫猫加油/暴击/鼓舞/幸福，原版 _主程序 L12017-12029）', () => {
  // 四条的消费端一直在（bonus.service 的 猫猫加油/猫猫暴击/鼓舞x/幸福 四段），
  // 但全仓没有任何投放端 → 花园猫 特性里的「(加油)附近友军每秒恢复0.3%…」与
  // 好感2「(暴击+)」、好感4「(鼓舞)」、好感5「(幸福)」四条对真实玩家从不成立。
  const SKILL_PROF = 400; // → 技能等级 21
  const catPlayer = (affinity: number): any => ({
    type: '花园猫', specialSeq: 1,
    markers: { 花园猫好感: affinity, 花园猫技能熟练度: SKILL_PROF },
  });
  const nowSec = () => Math.floor(Date.now() / 1000);

  it('按好感档位写进地图标记3：加油恒有，暴击/鼓舞/幸福分别要 40/80/100', () => {
    const combat: any = buildGuardCombat();
    const write = (affinity: number) => {
      const list: any[] = [];
      combat.applyGardenCatMapBuffs(catPlayer(affinity), list, nowSec());
      return list;
    };
    expect(write(0).map((b: any) => b.name)).toEqual(['猫猫加油']);
    expect(write(40).map((b: any) => b.name)).toEqual(['猫猫加油', '猫猫暴击']);
    expect(write(80).map((b: any) => b.name)).toEqual(['猫猫加油', '猫猫暴击', '猫猫鼓舞']);
    const full = write(100);
    expect(full.map((b: any) => b.name))
      .toEqual(['猫猫加油', '猫猫暴击', '猫猫鼓舞', '幸福']);
    const cheer = full.find((b: any) => b.name === '猫猫加油');
    expect(cheer.strength).toBe(0.5); // 原版：获得增益(标记3,"猫猫加油",60,假,ts,0.5)
    expect(cheer.expireAt).toBeGreaterThanOrEqual(nowSec() + 59);
    // 后三条强度 = 技能等级（消费端按强度折算 5+强度/2 暴击、25+2×强度 暴伤）
    const skillLevel = combat.effectiveFamiliarSkillLevel(catPlayer(100), catPlayer(100).markers, '花园猫');
    expect(skillLevel).toBeGreaterThan(0);
    expect(full.find((b: any) => b.name === '猫猫鼓舞').strength).toBe(skillLevel);
  });

  it('非花园猫玩家：不写任何地图增益', () => {
    const combat: any = buildGuardCombat();
    const list: any[] = [];
    combat.applyGardenCatMapBuffs({ type: '史莱姆', specialSeq: 0, markers: {} }, list, nowSec());
    expect(list).toEqual([]);
  });

  it('鼓舞前半句：带 猫猫鼓舞 时 攻击力+(15+强度)、穿透+5，20 秒冷却内第二次不生效', () => {
    const combat: any = buildGuardCombat();
    const player: any = {
      name: '冒险者', type: '花园猫', specialSeq: 1, markers2: '[]',
      buffs: [{ name: '猫猫鼓舞', strength: 21, expireAt: Date.now() / 1000 + 60 }],
    };
    const bonus: any = { 物伤: 100, 火伤: 0, 冰伤: 0, 电伤: 0, 命中: 200, 攻击2: 0 };
    const lines: string[] = [];
    const before = bonus.物伤;
    combat.applyCatEncouragementBeforeDamage(player, bonus, lines);
    expect(bonus.物伤).toBeGreaterThan(before); // 战斗中增加攻击(15+21)
    expect(bonus.生命穿透 ?? 0).toBeGreaterThanOrEqual(5);
    expect(lines.join(' ')).toContain('鼓舞36');

    // 同一次攻击之后 20 秒内再来一次：时间间隔要求 已经写下冷却，不该再加
    const again: any = { 物伤: 100, 火伤: 0, 冰伤: 0, 电伤: 0, 命中: 200, 攻击2: 0 };
    combat.applyCatEncouragementBeforeDamage(player, again, []);
    expect(again.物伤).toBe(100);
  });

  it('鼓舞后半句：未命中/擦过/描边时叠 鼓舞x，强度 = |命中−闪避|÷10', () => {
    const combat: any = buildGuardCombat();
    const player: any = {
      name: '冒险者', markers2: '[]',
      buffs: [{ name: '猫猫鼓舞', strength: 10, expireAt: Date.now() / 1000 + 60 }],
    };
    const bonus: any = { 命中: 300 };
    const lines: string[] = [];
    combat.grantCatEncouragementStack(player, bonus, 100, lines);
    let stack = player.buffs.find((b: any) => b.name === '鼓舞x');
    expect(stack.strength).toBeCloseTo(20, 6); // |300-100|/10
    expect(lines.join(' ')).toContain('命中↑20');
    // 再来一次：按层累加（原版第7参"叠加强度"=真）
    combat.grantCatEncouragementStack(player, bonus, 100, []);
    stack = player.buffs.find((b: any) => b.name === '鼓舞x');
    expect(stack.strength).toBeCloseTo(40, 6);
    // 没有 猫猫鼓舞 的人不叠
    const plain: any = { name: '乙', buffs: [] };
    combat.grantCatEncouragementStack(plain, bonus, 100, []);
    expect(plain.buffs.find((b: any) => b.name === '鼓舞x')).toBeUndefined();
  });
});
