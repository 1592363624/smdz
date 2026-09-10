import { CombatSystemService } from '../src/modules/game/combat-system.service';

function makeCombat() {
  const service: any = Object.create(CombatSystemService.prototype);
  const playerService: any = {
    safeJsonParse: (v: any, fb: any) => {
      if (v == null) return fb;
      if (typeof v !== 'string') return v;
      try { return JSON.parse(v); } catch { return fb; }
    },
    getMarkerValue: (markers: any, name: string) => Number(markers?.[name] ?? 0),
    getBackpackItems: () => [],
  };
  const logger = { log: jest.fn(), warn: jest.fn() };
  // buildAttackerBonus 收尾会走 bonusService（套装/法宝/增益/最终加成/递减收益/穿透）。
  // 这里给最小桩：只求流程走通，使 `bonus.倍率来源` 快照被写下（"2"族字段随后会被清零）。
  const bonusService: any = {
    checkSetBonus: jest.fn(),
    calculateTreasureBonus: jest.fn(),
    calculateGameBonus: jest.fn(),
    calculateFinalBonus: jest.fn(),
    applyAllDiminishingReturns: jest.fn(),
    addPenetration: jest.fn(),
  };
  Object.assign(service, { playerService, logger, bonusService });
  return service;
}

describe('掉落率/品质接入普通击杀（原版 后台运作 L846-857）', () => {
  it('generateDrops 按 1+掉落率/100 放大几率', () => {
    const combat = makeCombat();
    const monster = {
      bonus: JSON.stringify({
        drops: [{ name: '合金', chance: 100, quantity: 2, type: '资源' }],
      }),
    };
    // 倍率很大时必掉
    const drops = combat.generateDrops(monster, 10);
    expect(drops.length).toBe(1);
    expect(drops[0].name).toBe('合金');
  });

  it('reduceMarkers2Cooldown：剩余时间-N秒，减到当前以下即清空', () => {
    const combat = makeCombat();
    const now = Date.now();
    const markers2 = [{ name: '剑圣技能冷却', expireAt: now + 50 * 1000 }];
    combat.reduceMarkers2Cooldown(markers2, '剑圣技能冷却', 30);
    expect(markers2.length).toBe(1);
    expect(markers2[0].expireAt).toBeLessThanOrEqual(now + 21 * 1000);

    const markers2b = [{ name: '剑圣技能冷却', expireAt: now + 10 * 1000 }];
    combat.reduceMarkers2Cooldown(markers2b, '剑圣技能冷却', 30);
    expect(markers2b.length).toBe(0);
  });

  it('击杀被动：剑圣好感≥40叠苦行、≥80减技能/斩冷却', () => {
    const combat = makeCombat();
    const now = Date.now();
    const player: any = {
      specialSeq: 4,
      type: '剑圣',
      affinity: 80,
      markers: {},
      markers2: [
        { name: '剑圣技能冷却', expireAt: now + 50 * 1000 },
        { name: '斩冷却', expireAt: now + 40 * 1000 },
      ],
      buffs: [],
    };
    combat.applyKillPassives(player, { markers: {}, markers2: player.markers2 });
    const buffs = player.buffs;
    expect(buffs.find((b: any) => b.name === '苦行')?.value).toBe(1);
    const typeCd = player.markers2.find((m: any) => m.name === '剑圣技能冷却');
    expect(typeCd.expireAt).toBeLessThanOrEqual(now + 21 * 1000);
    const slashCd = player.markers2.find((m: any) => m.name === '斩冷却');
    expect(slashCd.expireAt).toBeLessThanOrEqual(now + 11 * 1000);
  });

  it('击杀被动：伊卡洛斯歼灭模式减主动冷却10秒，并回显提示文本', () => {
    const combat = makeCombat();
    const now = Date.now();
    const player: any = {
      specialSeq: 13,
      type: '伊卡洛斯',
      affinity: 0,
      name: '甲',
      markers: {},
      markers2: [{ name: '伊卡洛斯技能冷却', expireAt: now + 50 * 1000 }],
      buffs: [{ name: '歼灭模式', expireAt: now + 20 * 1000 }],
    };
    const lines: string[] = [];
    combat.applyKillPassives(player, { markers: {}, markers2: player.markers2 }, undefined, lines);
    const cd = player.markers2.find((m: any) => m.name === '伊卡洛斯技能冷却');
    expect(cd.expireAt).toBeLessThanOrEqual(now + 41 * 1000);
    // 原版 L3745-3751：把「减少了10秒(还有X)」写进 文本
    expect(lines.join('\n')).toContain('的主动技能冷却减少了10秒');
  });

  it('军姬2：仅 攻击文本=="万象a" 且 jj3==1 时清空主动技能冷却（原版 L3721-3728）', () => {
    const combat = makeCombat();
    const now = Date.now();
    const run = (attackText?: string) => {
      const player: any = {
        specialSeq: 24,
        type: '军姬2',
        affinity: 0, // 原版无好感门槛
        name: '甲',
        markers: { jj3: 1 },
        markers2: [{ name: '军姬2技能冷却', expireAt: now + 900 * 1000 }],
        buffs: [],
      };
      const lines: string[] = [];
      combat.applyKillPassives(
        player, { markers: { jj3: 1 }, markers2: player.markers2 }, attackText, lines,
      );
      return { player, lines };
    };

    // 普通攻击击杀（含好感为 0）→ 不得清冷却（此前实现误用 好感>=40 兜底，超模）
    expect(run('攻击b').player.markers2).toHaveLength(1);
    expect(run(undefined).player.markers2).toHaveLength(1);
    // 万象a 击杀 → 清空 + 回显
    const hit = run('万象a');
    expect(hit.player.markers2).toHaveLength(0);
    expect(hit.lines.join('\n')).toContain('的主动技能冷却完毕');
  });

  it('剑道：仅 当前武器!=0 且 武器类型=="近战武器" 时生效（原版 加成计算 L2010-2016）', () => {
    const combat = makeCombat();
    const melee = { name: '铁剑', type: '近战武器' };
    const ranged = { name: '长弓', type: '射弹武器' };
    const makePlayer = (currentWeapon: number) => ({
      specialSeq: 4, type: '剑圣', affinity: 20, name: '剑客',
      currentWeapon, level: 1, markers: {}, buffs: [], sets: {},
      hp: 100, armor: 0, shield: 0, maxHp: 100,
    });
    const pd = (weapons: any[]) => ({
      weapons, markers: {}, equipment: [], buffs: [], backpack: [],
    }) as any;

    const linesMelee: string[] = [];
    const bMelee = combat.buildAttackerBonus(makePlayer(1), pd([melee]), undefined, linesMelee);
    const linesFist: string[] = [];
    const bFist = combat.buildAttackerBonus(makePlayer(0), pd([melee]), undefined, linesFist);
    const linesRanged: string[] = [];
    const bRanged = combat.buildAttackerBonus(makePlayer(1), pd([ranged]), undefined, linesRanged);

    // 近战武器 → 攻击2 得到 +15+技能等级，且写 特效 (剑道)
    // 注：buildAttackerBonus 末尾会把 "2" 族字段清零并折算进 攻击，清零前快照留在 倍率来源
    const a2 = (b: any) => Number(b?.倍率来源?.攻击2 ?? 0);
    expect(a2(bMelee) - a2(bFist)).toBeGreaterThanOrEqual(15);
    expect(linesMelee).toContain('(剑道)');
    // 拳头(currentWeapon=0) / 非近战武器 → 无剑道加成、无 (剑道) 特效
    expect(linesFist).not.toContain('(剑道)');
    expect(linesRanged).not.toContain('(剑道)');
    expect(a2(bRanged)).toBe(0);
  });

  it('恶毒暴怒：三池回满用「计算上限」caps；未传 caps 时不得按基础上限回满（原版 L3773-3781）', () => {
    const combat = makeCombat();
    const makePlayer = () => ({
      specialSeq: 6, type: '恶毒', affinity: 80, name: '恶毒',
      markers: {}, markers2: [], buffs: [],
      currentWeapon: 1, weapons: [{ name: '弯刀' }],
      hp: 10, shield: 5, armor: 3,
      maxHp: 100, maxShield: 20, maxArmor: 30,
    });

    // 传 caps（= buildAttackerBonus 的 生命/护盾/装甲，含装备加成）→ 回满到计算上限
    const withCaps = makePlayer();
    combat.applyKillPassives(
      withCaps, { markers: {}, markers2: [] },
      undefined, undefined, { hp: 818, shield: 120, armor: 90 },
    );
    expect(withCaps.hp).toBe(818);
    expect(withCaps.shield).toBe(120);
    expect(withCaps.armor).toBe(90);

    // 取不到计算上限 → 跳过回满，绝不退化为基础上限（否则装备加成余量被削掉）
    const withoutCaps = makePlayer();
    combat.applyKillPassives(withoutCaps, { markers: {}, markers2: [] });
    expect(withoutCaps.hp).toBe(10);
    expect(withoutCaps.shield).toBe(5);
    expect(withoutCaps.armor).toBe(3);
  });

  it('恶毒暴怒：减的是「本次造成击杀武器」的冷却，而非恒用当前武器（原版 L3777 用 z1）', () => {
    const combat = makeCombat();
    const now = Date.now();
    const player: any = {
      specialSeq: 6, type: '恶毒', affinity: 80, name: '恶毒',
      markers: {}, markers2: [
        { name: '长弓冷却', expireAt: now + 60 * 1000 },
        { name: '弯刀冷却', expireAt: now + 60 * 1000 },
      ], buffs: [],
      currentWeapon: 1, weapons: [{ name: '弯刀' }],
      hp: 10, shield: 0, armor: 0, maxHp: 100,
    };
    combat.applyKillPassives(
      player, { markers: {}, markers2: player.markers2 },
      undefined, undefined, undefined, '长弓',
    );
    const now2 = Date.now();
    const bow = player.markers2.find((m: any) => m.name === '长弓冷却');
    const blade = player.markers2.find((m: any) => m.name === '弯刀冷却');
    // 击杀武器「长弓」被减 5 秒；当前武器「弯刀」不受影响（60s 起步基本未动）
    expect(bow.expireAt).toBeLessThanOrEqual(now2 + 56 * 1000);
    expect(blade.expireAt).toBeGreaterThanOrEqual(now2 + 59 * 1000);
  });
});
