/**
 * 命中率口径 + 击杀参与者结算 回归用例
 *
 * 背景（2026-09-07 玩家实测反馈「很难打得过、经常被怪闪避」）：
 * 1. calcHitRate 只读英文 dodge/dodge2，怪物反击玩家链路传入的中文 {闪避,闪避2}
 *    包装完全失效 → defDodge 恒 1 → 玩家被怪 95% 封顶近乎必中（原版 口径 L1607-1611）。
 * 2. defDodge < 1 分支漏乘 ×100（原版判定用 a1*100）。
 * 3. calcDamage 缺失防御方新人减伤 ×(1-防御差距)（原版 L3290-3297）。
 * 4. 击杀结算「参与者」名单（原版 后台运作.ecode L488-680）此前完全未实装。
 */
import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlayerService } from '../src/modules/game/player.service';
import { BonusService } from '../src/modules/game/bonus.service';
import { MapService } from '../src/modules/game/map.service';
import { AchievementService } from '../src/modules/game/achievement.service';
import { CombatStateService } from '../src/modules/game/combat-state.service';
import { StatsService } from '../src/modules/game/stats.service';
import { StaticDataService } from '../src/modules/game/static-data.service';

const combat = new CombatSystemService(
  {
    player: {
      findMany: jest.fn(async ({ where }: any) => {
        const ids: number[] = where?.userId?.in ?? [];
        const names: Record<number, string> = { 42: '伊卡洛斯' };
        return ids.map((id: number) => ({ userId: id, name: names[id] ?? `玩家${id}` }));
      }),
    },
  } as any,
  { safeJsonParse: (v: string, f: any) => { try { return JSON.parse(v); } catch { return f; } } } as unknown as PlayerService,
  new BonusService(),
  {} as MapService,
  {} as StaticDataService,
  {} as AchievementService,
  {} as any,
  {} as CombatStateService,
  {} as StatsService,
);

const plainWeapon = {
  name: '测试武器', damage: 100, damageType: 1,
  properties: { phys: 100, fire: 0, ice: 0, elec: 0 },
};

describe('命中率口径（原版 战斗相关.ecode L1607-1611）', () => {
  it('中文键闪避参与计算：命中85 vs 闪避3000 → 2.83%', () => {
    const rate = combat.calcHitRate({ 命中: 85 } as any, { 闪避: 3000, 闪避2: 0 });
    expect(rate).toBeCloseTo(2.83, 2);
  });

  it('英文键闪避保持兼容：dodge=3000 → 2.83%', () => {
    const rate = combat.calcHitRate({ 命中: 85 } as any, { dodge: 3000, dodge2: 0 });
    expect(rate).toBeCloseTo(2.83, 2);
  });

  it('闪避<1 分支：原版判定用 a1*100，命中30 → 100% 必中（修复前误返回 60）', () => {
    const rate = combat.calcHitRate({ 命中: 30 } as any, { 闪避: 0.5, 闪避2: 0 });
    expect(rate).toBe(100);
  });

  it('攻击方新人差距放大命中率：命中85、差距0.9、闪避3000 → 28.33%', () => {
    const rate = combat.calcHitRate({ 命中: 85, 世界等级差距: 0.9 } as any, { 闪避: 3000, 闪避2: 0 });
    expect(rate).toBeCloseTo(28.33, 2);
  });

  it('闪避与闪避2 累加', () => {
    const rate = combat.calcHitRate({ 命中: 85 } as any, { 闪避: 1500, 闪避2: 1500 });
    expect(rate).toBeCloseTo(2.83, 2);
  });
});

describe('伤害的防御方新人减伤（原版 加成计算.ecode L3290-3297）', () => {
  const atk = { 攻击: 0, 命中: 100 } as any;
  const noResistDef = {
    生命: 1e9, 护盾: 0, 装甲: 0,
    生命物抗: 0, 生命火抗: 0, 生命冰抗: 0, 生命电抗: 0,
    装甲物抗: 0, 护盾物抗: 0,
    生命伤害上限: 100, 装甲伤害上限: 100, 护盾伤害上限: 100,
  } as any;

  it('无防御差距：全额伤害', () => {
    const res = combat.calcDamage(atk, { ...noResistDef } as any, plainWeapon as any, 1, false, { dmgLower: 1, dmgUpper: 0 });
    expect(res.damage).toBeGreaterThan(0);
  });

  it('防御方差距 0.9 → 伤害 ×0.1', () => {
    const base = combat.calcDamage(atk, { ...noResistDef } as any, plainWeapon as any, 1, false, { dmgLower: 1, dmgUpper: 0 });
    const reduced = combat.calcDamage(
      atk,
      { ...noResistDef, 世界等级差距: 0.9 } as any,
      plainWeapon as any, 1, false, { dmgLower: 1, dmgUpper: 0 },
    );
    expect(reduced.damage).toBeCloseTo(base.damage * 0.1, 4);
  });

  it('攻击方与防御方差距同时生效（原版 /(1-攻) ×(1-防)）', () => {
    const base = combat.calcDamage(atk, { ...noResistDef } as any, plainWeapon as any, 1, false, { dmgLower: 1, dmgUpper: 0 });
    const both = combat.calcDamage(
      { ...atk, 世界等级差距: 0.5 } as any,
      { ...noResistDef, 世界等级差距: 0.5 } as any,
      plainWeapon as any, 1, false, { dmgLower: 1, dmgUpper: 0 },
    );
    // /(1-0.5) ×(1-0.5) = 净 ×1
    expect(both.damage).toBeCloseTo(base.damage, 4);
  });
});

describe('击杀结算「参与者」名单（原版 后台运作.ecode L488-680）', () => {
  const monster = {
    name: '史莱姆',
    level: 140,
    maxHp: 1000,
    maxShield: 2000,
    maxArmor: 87,
    markers: JSON.stringify({
      攻击者42: 2695.35,
      攻击者四: 396.06,
      攻击者打手龙: 0.001,
      承受者42: 337.5,
      击杀者四: 1,
    }),
  };

  it('输出原版格式：怪物行 + 参与者行（含击杀标注/承受段/两位小数）', async () => {
    const lines = await (combat as any).buildKillParticipantLines(monster, '四');
    expect(lines[0]).toBe('【分段】史莱姆被击败了,参与者:');
    // 怪物承受 = 2695.35+396.06+0.001 = 3091.41；三池 = 1000+2000+87 = 3087 → 100.14%
    expect(lines[1]).toBe('史莱姆[等级140]:337.5,承受3091.41(100.14%)');
    // 玩家行：输出占比 + 承受段（337.5/337.5 = 100%）
    expect(lines).toContain('伊卡洛斯:2695.35(87.31%),承受:337.5(100%)');
    expect(lines).toContain('四()(击杀):396.06(12.83%)');
    expect(lines).toContain('打手龙():0(0%)');
  });

  it('承受为 0 时不追加承受段', async () => {
    const m = {
      name: '木桩', level: 10, maxHp: 100, maxShield: 0, maxArmor: 0,
      markers: JSON.stringify({ 攻击者42: 50 }),
    };
    const lines = await (combat as any).buildKillParticipantLines(m, '42');
    expect(lines[1]).toBe('木桩[等级10]:0,承受50(50%)');
    expect(lines[2]).not.toContain('承受:');
  });
});
