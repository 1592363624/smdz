/**
 * 竞技场镜像对战结算器单测（无头、无库）。
 *
 * 关注点是「结算器契约」而非伤害数值本身——数值由 CombatSystemService 负责，
 * 这里用一份可控的战斗引擎替身验证：时间轴推进顺序、三池扣减次序、命中/暴击传参、
 * 世界等级差距清零、终局判定口径，以及最重要的一条：**绝不改动传入的镜像快照**。
 */
import { ArenaBattleService } from '../src/modules/game/arena/arena-battle.service';
import { MirrorSnapshot } from '../src/modules/game/arena/mirror-snapshot.util';

/** 战斗引擎替身：只实现结算器真正调用的方法，并记录调用参数供断言 */
function makeFakeCombat(overrides: Partial<Record<string, any>> = {}) {
  const calls: any[] = [];
  return {
    calls,
    buildAttackerBonus: jest.fn((player: any) => ({
      攻击: player?.__atk ?? 100,
      命中: 100,
      闪避: 10,
      暴击: 0,
      生命: 1000,
      装甲: 0,
      护盾: 0,
      世界等级差距: player?.__gap ?? 0.5,
      吸生命: 0,
    })),
    getWeaponData: jest.fn(() => ({ name: '铁剑', damage: 10, damageType: 0, cooldown: 5, properties: { phys: 100, fire: 0, ice: 0, elec: 0 } })),
    calcHitRate: jest.fn(() => 100),
    checkHit: jest.fn(() => true),
    checkCrit: jest.fn(() => false),
    calcLeech: jest.fn(() => 0),
    calcDamage: jest.fn((atk: any, def: any) => {
      calls.push({ atk, def });
      const hp = Number(def.生命) || 0;
      const shield = Number(def.护盾) || 0;
      const armor = Number(def.装甲) || 0;
      // 固定打掉 400：先护盾后装甲再生命，与引擎的三池次序一致
      const toShield = Math.min(shield, 400);
      const toArmor = Math.min(armor, 400 - toShield);
      const toHp = Math.min(hp, 400 - toShield - toArmor);
      return { damage: toShield + toArmor + toHp, isHit: true, isCrit: false, hitRate: 100, rating: '【正中】50%', poolDamage: { shield: toShield, armor: toArmor, hp: toHp } };
    }),
    ...overrides,
  };
}

function makeSnapshot(over: Partial<MirrorSnapshot> = {}): MirrorSnapshot {
  const userId = Number(over.userId ?? 1);
  const name = String(over.name ?? (userId === 1 ? '攻方' : '守方'));
  return {
    v: 1,
    capturedAt: Date.now(),
    userId,
    name,
    level: 100,
    familiarType: 'saber',
    equippedTitle: '',
    power: 1234,
    currentWeapon: 1,
    // 行内 player 与外层快照同源：战斗引擎读的是 player（userId/level/name 都在这里）
    player: { id: userId, userId, level: 100, name, type: 'saber', currentWeapon: 1, specialSeq: 0 },
    weapons: [{ name: '铁剑', damage: 10, data: 'e' }],
    equipment: [],
    markers: {},
    markers2: [],
    buffs: [],
    sets: {},
    bonus: { 攻击: 100, 生命: 1000 },
    ...over,
  } as MirrorSnapshot;
}

function makeService(combat: any) {
  return new ArenaBattleService(combat as any);
}

describe('ArenaBattleService · 无头镜像对战', () => {
  it('击倒即分胜负：三池按 护盾→装甲→生命 次序被扣', () => {
    const combat = makeFakeCombat();
    const svc = makeService(combat);
    const attacker = { side: 'attacker' as const, userId: 1, name: '甲', snapshot: makeSnapshot() };
    const defender = {
      side: 'defender' as const,
      userId: 2,
      name: '乙',
      snapshot: makeSnapshot({
        userId: 2,
        name: '乙',
        player: { id: 2, userId: 2, level: 100, name: '乙', type: 'saber', currentWeapon: 1, 护盾: 0 },
      }),
    };
    // 护盾 300 / 装甲 200 / 生命 1000：每击 400 → 第 4 击致死
    combat.buildAttackerBonus.mockImplementation((player: any) => ({
      攻击: 100, 命中: 100, 闪避: 0, 暴击: 0,
      生命: player?.userId === 2 ? 1000 : 100000,
      护盾: player?.userId === 2 ? 300 : 0,
      装甲: player?.userId === 2 ? 200 : 0,
      世界等级差距: 0, 吸生命: 0,
    }));
    combat.getWeaponData.mockImplementation(() => ({
      name: '铁剑', damage: 10, damageType: 0, cooldown: 5, properties: { phys: 100, fire: 0, ice: 0, elec: 0 },
    }));

    const result = svc.fight(attacker, defender, { timeLimitSec: 180, maxActions: 50 });

    expect(result.winner).toBe('attacker');
    expect(result.reason).toBe('ko');
    expect(result.sides.defender.pools.hp).toBe(0);
    // 第一击只吃护盾+装甲+部分生命：证明扣减顺序没有走偏
    const vsDefender = result.actionLog.filter((x) => x.side === 'attacker');
    expect(vsDefender[0].poolDamage).toEqual({ shield: 300, armor: 100, hp: 0 });
    expect(vsDefender[1].poolDamage).toEqual({ shield: 0, armor: 100, hp: 300 });
  });

  it('时间上限按剩余生命比例判定：完全对称记平局', () => {
    const combat = makeFakeCombat();
    combat.buildAttackerBonus.mockImplementation(() => ({
      攻击: 100, 命中: 100, 闪避: 0, 暴击: 0, 生命: 1500, 护盾: 0, 装甲: 0, 世界等级差距: 0, 吸生命: 0,
    }));
    const svc = makeService(combat);
    const a = { side: 'attacker' as const, userId: 1, name: '甲', snapshot: makeSnapshot() };
    const b = { side: 'defender' as const, userId: 2, name: '乙', snapshot: makeSnapshot({ userId: 2, name: '乙' }) };
    const result = svc.fight(a, b, { timeLimitSec: 12, maxActions: 500 });
    // 双方镜像同属性、同冷却 5s：t=0/5/10 各出手 3 次、各挨 1200，12 秒到点时剩余生命相同
    expect(result.reason).toBe('timeup');
    expect(result.durationSec).toBe(12);
    expect(result.winner).toBe('draw');
    expect(result.sides.attacker.pools.hp).toBe(result.sides.defender.pools.hp);
  });

  it('时间上限时血薄一侧判负（三池合计按上限比例比较）', () => {
    const combat = makeFakeCombat();
    combat.buildAttackerBonus.mockImplementation((player: any) => ({
      攻击: 100, 命中: 100, 闪避: 0, 暴击: 0,
      生命: player?.userId === 1 ? 1300 : 1600,
      护盾: 0, 装甲: 0, 世界等级差距: 0, 吸生命: 0,
    }));
    const svc = makeService(combat);
    const result = svc.fight(
      { side: 'attacker', userId: 1, name: '甲', snapshot: makeSnapshot() },
      { side: 'defender', userId: 2, name: '乙', snapshot: makeSnapshot({ userId: 2, name: '乙' }) },
      { timeLimitSec: 12, maxActions: 500 },
    );
    // 各挨 3 击 1200 伤害：攻方剩 100/1300、守方剩 400/1600，均未被击倒 → 按比例判守方胜
    expect(result.reason).toBe('timeup');
    expect(result.winner).toBe('defender');
  });

  it('冷却决定出手节奏：快武器在时限内出手更多', () => {
    const combat = makeFakeCombat({
      getWeaponData: jest.fn((actor: any) => ({
        name: '快剑', damage: 1, damageType: 0,
        cooldown: actor?.userId === 1 ? 2 : 8,
        properties: { phys: 100, fire: 0, ice: 0, elec: 0 },
      })),
      // 打不死的伤害，专门看节奏
      calcDamage: jest.fn(() => ({ damage: 1, poolDamage: { shield: 0, armor: 0, hp: 1 }, rating: '', isHit: true, isCrit: false, hitRate: 100 })),
    });
    const svc = makeService(combat);
    const result = svc.fight(
      { side: 'attacker', userId: 1, name: '甲', snapshot: makeSnapshot() },
      { side: 'defender', userId: 2, name: '乙', snapshot: makeSnapshot({ userId: 2 }) },
      { timeLimitSec: 20, maxActions: 500 },
    );
    const attackerActions = result.actionLog.filter((x) => x.side === 'attacker').length;
    const defenderActions = result.actionLog.filter((x) => x.side === 'defender').length;
    expect(attackerActions).toBeGreaterThan(defenderActions);
    expect(attackerActions).toBeGreaterThanOrEqual(7);
  });

  it('世界等级差距在竞技场被清零（新人保护不适用于玩家互殴）', () => {
    const combat = makeFakeCombat();
    combat.buildAttackerBonus.mockImplementation((player: any) => ({
      攻击: 100, 命中: 100, 闪避: 0, 暴击: 0, 生命: 500, 护盾: 0, 装甲: 0,
      世界等级差距: player?.__gap ?? 0.8, 吸生命: 0,
    }));
    const svc = makeService(combat);
    svc.fight(
      { side: 'attacker', userId: 1, name: '甲', snapshot: makeSnapshot() },
      { side: 'defender', userId: 2, name: '乙', snapshot: makeSnapshot({ userId: 2 }) },
      { timeLimitSec: 6, maxActions: 10 },
    );
    const first = combat.calls[0];
    expect(first.atk.世界等级差距).toBe(0);
    expect(first.def.世界等级差距).toBe(0);
  });

  it('未命中时不进入伤害计算，也不扣血', () => {
    const combat = makeFakeCombat({ checkHit: jest.fn(() => false) });
    const svc = makeService(combat);
    const result = svc.fight(
      { side: 'attacker', userId: 1, name: '甲', snapshot: makeSnapshot() },
      { side: 'defender', userId: 2, name: '乙', snapshot: makeSnapshot({ userId: 2 }) },
      { timeLimitSec: 20, maxActions: 5 },
    );
    expect(combat.calcDamage).not.toHaveBeenCalled();
    expect(result.actionLog.every((x) => !x.hit)).toBe(true);
    expect(result.sides.defender.pools.hp).toBe(1000);
    expect(result.reason).toBe('cap');
  });

  it('结算全程不改动传入的镜像快照（打的是副本，真实资产与榜上镜像都不受影响）', () => {
    const combat = makeFakeCombat();
    const svc = makeService(combat);
    const snapA = makeSnapshot();
    const snapB = makeSnapshot({ userId: 2, name: '乙' });
    const beforeA = JSON.stringify(snapA);
    const beforeB = JSON.stringify(snapB);
    svc.fight(
      { side: 'attacker', userId: 1, name: '甲', snapshot: snapA },
      { side: 'defender', userId: 2, name: '乙', snapshot: snapB },
      { timeLimitSec: 60, maxActions: 100 },
    );
    expect(JSON.stringify(snapA)).toBe(beforeA);
    expect(JSON.stringify(snapB)).toBe(beforeB);
  });

  it('战报包含双方信息、逐回合明细与终局统计', () => {
    const svc = makeService(makeFakeCombat());
    const result = svc.fight(
      { side: 'attacker', userId: 1, name: '甲', snapshot: makeSnapshot() },
      { side: 'defender', userId: 2, name: '乙', snapshot: makeSnapshot({ userId: 2, name: '乙' }) },
      { timeLimitSec: 12, maxActions: 20 },
    );
    expect(result.lines[0]).toContain('战报');
    expect(result.lines.some((line) => line.includes('甲 用 铁剑 命中 乙'))).toBe(true);
    expect(result.lines[result.lines.length - 1]).toContain('结果：');
  });

  it('三池按秒回复：肉盾构筑能靠回复把血补回上限再打赢', () => {
    const combat = makeFakeCombat();
    combat.buildAttackerBonus.mockImplementation((player: any) => ({
      攻击: 100, 命中: 100, 闪避: 0, 暴击: 0, 生命: 1000, 护盾: 0, 装甲: 0,
      世界等级差距: 0, 吸生命: 0,
      // 只有攻方带每秒回复，两侧伤害/冷却一致 → 终局血量差值即回复量
      生命回复: player?.userId === 1 ? 100 : 0,
    }));
    const svc = makeService(combat);
    const result = svc.fight(
      { side: 'attacker', userId: 1, name: '甲', snapshot: makeSnapshot() },
      { side: 'defender', userId: 2, name: '乙', snapshot: makeSnapshot({ userId: 2, name: '乙' }) },
      { timeLimitSec: 12, maxActions: 500 },
    );
    // t=0/5/10 各一次交手；攻方在第 3 回合前已被回满 → 击倒守方后自身回到上限
    expect(result.winner).toBe('attacker');
    expect(result.reason).toBe('ko');
    expect(result.sides.attacker.pools.hp).toBe(1000);
    expect(result.sides.defender.pools.hp).toBe(0);
  });

  it('缺少战斗引擎时显式抛错，而不是静默给一场假战斗', () => {
    const svc = new ArenaBattleService(undefined as any);
    expect(() => svc.fight(
      { side: 'attacker', userId: 1, name: '甲', snapshot: makeSnapshot() },
      { side: 'defender', userId: 2, name: '乙', snapshot: makeSnapshot({ userId: 2 }) },
    )).toThrow(/战斗引擎/);
  });
});
