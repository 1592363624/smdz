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
import { ItemSystemService } from '../src/modules/game/item-system.service';
import { CombatStateService } from '../src/modules/game/combat-state.service';

// 构造 CombatSystemService 实例，注入空 mock（calcDamage 不触碰这些依赖）
const combat = new CombatSystemService(
  {} as PrismaService,
  {} as PlayerService,
  {} as BonusService,
  {} as MapService,
  {} as StaticDataService,
  {} as AchievementService,
  {} as ItemSystemService,
  {} as any,
);

// ==================== 行动无限制 (战斗相关.ecode L5097-5172) ====================
describe('行动无限制 - 状态限制检查 (战斗相关.ecode L5097-5172)', () => {
  // actionUnrestricted 调用 playerService 的 safeJsonParse/getMarkerValue/setMarker（纯本地 JSON 操作，不依赖 Prisma）
  const playerService = new PlayerService({} as PrismaService, {} as StaticDataService, {} as MapService);
  const combat2 = new CombatSystemService(
    {} as PrismaService,
    playerService,
    {} as BonusService,
    {} as MapService,
    {} as StaticDataService,
    {} as AchievementService,
    {} as ItemSystemService,
    {} as any,
    );

  const basePlayer = () => ({
    name: '测试者',
    attackMode: 0,
    markers: JSON.stringify({}),
    markers2: JSON.stringify([]),
  });

  const nowSec = () => Math.floor(Date.now() / 1000);

  it('L5106 移动标记未过期 → 被限制(restricted=true)', () => {
    const p = basePlayer();
    p.markers2 = JSON.stringify([{ name: '移动', expireAt: nowSec() + 30 }]);
    const r = combat2.actionUnrestricted(p);
    expect(r.restricted).toBe(true);
    expect(r.text).toContain('移动中');
  });

  it('L5113 复活 / L5120 采集 / L5127 工作 标记 → 被限制', () => {
    const names = ['复活', '采集', '工作'];
    for (const n of names) {
      const p = basePlayer();
      p.markers2 = JSON.stringify([{ name: n, expireAt: nowSec() + 30 }]);
      const r = combat2.actionUnrestricted(p);
      expect(r.restricted).toBe(true);
    }
  });

  it('L5134 炮击模式(attackMode=1) 默认(cannonOk=true) → 可行动；cannonOk=false → 限制', () => {
    const p = basePlayer();
    p.attackMode = 1;
    expect(combat2.actionUnrestricted(p, { cannonOk: true }).restricted).toBe(false);
    expect(combat2.actionUnrestricted(p, { cannonOk: false }).restricted).toBe(true);
  });

  it('L5143 躺下(标记"躺下"=1) → 自动起床返回可行动(restricted=false) 并清空标记', () => {
    const p = basePlayer();
    p.markers = JSON.stringify({ 躺下: 1 });
    const r = combat2.actionUnrestricted(p);
    expect(r.restricted).toBe(false);
    expect(combat2.actionUnrestricted(p).restricted).toBe(false); // 二次已清躺下，仍不受限
  });

  it('L5151 自动开采(标记"自动开采"!=0) → 被限制；无视理由=6 则通过', () => {
    const p = basePlayer();
    p.markers = JSON.stringify({ 自动开采: 1 });
    expect(combat2.actionUnrestricted(p).restricted).toBe(true);
    expect(combat2.actionUnrestricted(p, { ignoreReason: 6 }).restricted).toBe(false);
  });

  it('L5158 长须鲸开采(标记"自动开采2"!=0, blueWhale=true) → 被限制', () => {
    const p = basePlayer();
    p.markers = JSON.stringify({ 自动开采2: 1 });
    expect(combat2.actionUnrestricted(p, { blueWhale: true }).restricted).toBe(true);
    expect(combat2.actionUnrestricted(p, { blueWhale: false }).restricted).toBe(false);
  });

  it('L5165 麻痹标记 → 被限制；无视理由=1 则通过', () => {
    const p = basePlayer();
    p.markers2 = JSON.stringify([{ name: '麻痹', expireAt: nowSec() + 30 }]);
    expect(combat2.actionUnrestricted(p).restricted).toBe(true);
    expect(combat2.actionUnrestricted(p, { ignoreReason: 1 }).restricted).toBe(false);
  });

  it('L5172 无任何限制标记 → 可行动(restricted=false)', () => {
    const r = combat2.actionUnrestricted(basePlayer());
    expect(r.restricted).toBe(false);
    expect(r.text).toBe('');
  });
});

// ==================== 玩家死亡 (战斗相关.ecode L5173-5231) ====================
describe('玩家死亡 - 复活豁免判定 (战斗相关.ecode L5173-5231)', () => {
  const playerService = new PlayerService({} as PrismaService, {} as StaticDataService, {} as MapService);
  // playerDeath 内部调用 avoidDeath，avoidDeath 兼容层依赖 combatState.normalizeBuffItem，须注入真实实例
  const combat3 = new CombatSystemService(
    {} as PrismaService,
    playerService,
    {} as BonusService,
    {} as MapService,
    {} as StaticDataService,
    {} as AchievementService,
    {} as ItemSystemService,
    new CombatStateService(),
    );

  const baseDeath = (over: any = {}) => ({
    player: {
      name: '测试者',
      currentHp: 0, 当前生命: 0,
      specialSeq: 0, type: '',
      属性: { 生命: 100 }, 生命上限: 100,
      markers2: JSON.stringify([]),
      额外文本: '',
    },
    buffs: [],
    equipment: [],
    map: { summons: JSON.stringify([]) },
    ...over,
  });

  it('L5182 卷土重来增益存在 → 不死(dead=false)', () => {
    const nowSec = Math.floor(Date.now() / 1000) + 100;
    const pd = baseDeath({ buffs: [{ name: '卷土重来', expireAt: nowSec }] });
    const r = combat3.playerDeath(pd);
    expect(r.dead).toBe(false);
    expect(r.extraText).toContain('卷土重来');
  });

  it('L5214 石中剑(specialSeq=-35) 冷却未触发 → 复活(dead=false)，二次进入冷却 → 真死', () => {
    const pd = baseDeath({ equipment: [{ name: '石中剑', specialSeq: -35 }] });
    const r1 = combat3.playerDeath(pd);
    expect(r1.dead).toBe(false);
    // 原版：复活后生命恢复，不会再次判死；此处模拟"再次濒死"前需重置生命为0
    pd.player.currentHp = 0; pd.player.当前生命 = 0;
    // 二次：冷却已写入，未过期 → 真死
    const r2 = combat3.playerDeath(pd);
    expect(r2.dead).toBe(true);
    expect(r2.deathText).toContain('已经死掉了');
  });

  it('L5204 死亡行者(specialSeq=16) 冷却未触发 → 复活(dead=false)', () => {
    const pd = baseDeath({ equipment: [{ name: '死亡行者', specialSeq: 16 }] });
    const r1 = combat3.playerDeath(pd);
    expect(r1.dead).toBe(false);
    pd.player.currentHp = 0; pd.player.当前生命 = 0;
    const r2 = combat3.playerDeath(pd);
    expect(r2.dead).toBe(true);
  });

  it('L5224 无豁免条件 → 真死(dead=true)', () => {
    const r = combat3.playerDeath(baseDeath());
    expect(r.dead).toBe(true);
    expect(r.deathText).toContain('已经死掉了');
  });

  it('L5185 军姬(specialSeq=16) 且有存活宠物 → 森罗万象复活(dead=false)', () => {
    const pd = baseDeath({
      player: {
        name: '军姬玩家', currentHp: 0, 当前生命: 0, specialSeq: 16, type: '军姬', qqNumber: 'testQQ',
        属性: { 生命: 100 }, 生命上限: 100, markers2: JSON.stringify([]), 额外文本: '',
      },
      map: { summons: JSON.stringify([{ userId: 'testQQ', hp: 50 }]) },
    });
    const r = combat3.playerDeath(pd);
    expect(r.dead).toBe(false);
    expect(r.extraText).toContain('森罗万象');
  });
});

// ==================== 置掉落 (战斗相关.ecode L5245-5317) ====================
describe('置掉落 - 怪物掉落记录 (战斗相关.ecode L5245-5317)', () => {
  const combat4 = new CombatSystemService(
    {} as PrismaService,
    {} as PlayerService,
    {} as BonusService,
    {} as MapService,
    {} as StaticDataService,
    {} as AchievementService,
    {} as ItemSystemService,
    {} as any,
    );

  const attacker = (over: any = {}) => ({
    qqNumber: 'testQQ',
    属性: { 掉落率: 0, 掉落品质: 0 },
    套装: { 传说率: 0 },
    equipment: [],
    ...over,
  });

  it('L5251 掉落率!=0 → 写入怪物标记 "dl"+QQ（取最高值）', () => {
    const a = attacker({ 属性: { 掉落率: 50, 掉落品质: 0 } });
    let mk = combat4.setDrop(a, []);
    const dl = mk.find((m: any) => m.name === 'dltestQQ');
    expect(dl).toBeDefined();
    expect(dl.数值).toBe(50);
    // 更高掉落率覆盖
    const a2 = attacker({ 属性: { 掉落率: 80, 掉落品质: 0 } });
    mk = combat4.setDrop(a2, mk);
    expect(mk.find((m: any) => m.name === 'dltestQQ').数值).toBe(80);
    // 更低掉落率不覆盖
    const a3 = attacker({ 属性: { 掉落率: 30, 掉落品质: 0 } });
    mk = combat4.setDrop(a3, mk);
    expect(mk.find((m: any) => m.name === 'dltestQQ').数值).toBe(80);
  });

  it('L5269 掉落品质!=0 → 写入 "dp"+QQ；L5287 传说率!=0 → 写入 "xy"+QQ', () => {
    const a = attacker({ 属性: { 掉落率: 0, 掉落品质: 20 }, 套装: { 传说率: 5 } });
    const mk = combat4.setDrop(a, []);
    expect(mk.find((m: any) => m.name === 'dptestQQ').数值).toBe(20);
    expect(mk.find((m: any) => m.name === 'xytestQQ').数值).toBe(5);
  });

  it('L5305 宝石缎带(specialSeq=98) → 写入 "ds"+QQ=1', () => {
    const a = attacker({ equipment: [{ name: '宝石缎带', specialSeq: 98 }] });
    const mk = combat4.setDrop(a, []);
    expect(mk.find((m: any) => m.name === 'dstestQQ')).toBeDefined();
    expect(mk.find((m: any) => m.name === 'dstestQQ').数值).toBe(1);
  });

  it('无条件(掉落率/品质/传说率=0且无缎带) → 不写入任何记录', () => {
    const mk = combat4.setDrop(attacker(), []);
    expect(mk.length).toBe(0);
  });
});

// ==================== 挑战怪物 (战斗相关.ecode L4726-4790) ====================
describe('挑战怪物 - 名字映射 (战斗相关.ecode L4726-4790)', () => {
  const combat5 = new CombatSystemService(
    {} as PrismaService,
    {} as PlayerService,
    {} as BonusService,
    {} as MapService,
    {} as StaticDataService,
    {} as AchievementService,
    {} as ItemSystemService,
    {} as any,
    );

  it('L4731 固定映射：a<100 b∈{1,6}=绿毛龟 / {2,7}=水元素 / {3,8}=巨齿鲨 / {4,9}=螳螂', () => {
    expect(combat5.challengeMonsterName(1)).toBe('绿毛龟');
    expect(combat5.challengeMonsterName(16)).toBe('绿毛龟');
    expect(combat5.challengeMonsterName(2)).toBe('水元素');
    expect(combat5.challengeMonsterName(7)).toBe('水元素');
    expect(combat5.challengeMonsterName(3)).toBe('巨齿鲨');
    expect(combat5.challengeMonsterName(8)).toBe('巨齿鲨');
    expect(combat5.challengeMonsterName(4)).toBe('螳螂');
    expect(combat5.challengeMonsterName(9)).toBe('螳螂');
  });

  it('L4745 a<200 分段映射', () => {
    expect(combat5.challengeMonsterName(101)).toBe('第四帝国火力手');
    expect(combat5.challengeMonsterName(112)).toBe('纳米战士');
    expect(combat5.challengeMonsterName(123)).toBe('钢铁之翼');
    expect(combat5.challengeMonsterName(134)).toBe('Doge');
  });

  it('L4758 a<300 分段映射', () => {
    expect(combat5.challengeMonsterName(201)).toBe('CELL直升机');
    expect(combat5.challengeMonsterName(212)).toBe('岩石巨人');
  });

  it('L4772 a>=300 且 b∈{1,6}：a>=900 随机(精英兔子/露娜)，否则 精英兔子', () => {
    // 精英兔子是固定返回值（a<900）
    for (let i = 0; i < 20; i++) {
      const name = combat5.challengeMonsterName(301);
      expect(['精英兔子', '精英兔子']).toContain(name); // 固定精英兔子
    }
    // a>=900：仅可能是 精英兔子 或 露娜
    for (let i = 0; i < 20; i++) {
      const name = combat5.challengeMonsterName(901);
      expect(['精英兔子', '露娜']).toContain(name);
    }
  });

  it('L4786 a>=300 默认分支从固定候选池返回', () => {
    const pool = ['熔岩巨人', '防御节点', '执行者', '洛', '海神龙', '鹭', '洛', '可畏', '柴郡', '机械降神'];
    for (let i = 0; i < 20; i++) {
      expect(pool).toContain(combat5.challengeMonsterName(300));
    }
  });
});

// ==================== 掉落残骸 (战斗相关.ecode L4947-4985) ====================
describe('掉落残骸 - 地精系列累加载具残骸 (战斗相关.ecode L4947-4985)', () => {
  const combat6 = new CombatSystemService(
    {} as PrismaService,
    {} as PlayerService,
    {} as BonusService,
    {} as MapService,
    {} as StaticDataService,
    {} as AchievementService,
    {} as ItemSystemService,
    {} as any,
    );

  it('L4954 各名称系数：地精=1 / 十夫长=1.5 / 百夫长=2 / 千夫长=2.5 / 将军=3', () => {
    expect(combat6.dropWreckage([], '地精').find((r: any) => r.名称 === '载具残骸').次数).toBe(1);
    expect(combat6.dropWreckage([], '地精十夫长').find((r: any) => r.名称 === '载具残骸').次数).toBe(1.5);
    expect(combat6.dropWreckage([], '地精百夫长').find((r: any) => r.名称 === '载具残骸').次数).toBe(2);
    expect(combat6.dropWreckage([], '地精千夫长').find((r: any) => r.名称 === '载具残骸').次数).toBe(2.5);
    expect(combat6.dropWreckage([], '地精将军').find((r: any) => r.名称 === '载具残骸').次数).toBe(3);
  });

  it('L4967 已存在载具残骸 → 累加次数', () => {
    const res = combat6.dropWreckage([{ 名称: '载具残骸', 次数: 2 }], '地精');
    expect(res.find((r: any) => r.名称 === '载具残骸').次数).toBe(3);
  });

  it('L4964 非地精系列 → 不修改（原版返回）', () => {
    const res = combat6.dropWreckage([{ 名称: '其他', 次数: 5 }], '史莱姆');
    expect(res.length).toBe(1);
    expect(res[0].名称).toBe('其他');
  });
});

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

// ==================== 选择高血量目标 (战斗相关.ecode L5423-5438) ====================
describe('选择高血量目标 - 最高血量索引 (战斗相关.ecode L5423-5438)', () => {
  it('L5429 返回总和(生命+装甲+护盾)最大者的索引', () => {
    const defenders = [
      { 当前生命: 10, 当前装甲: 0, 当前护盾: 0 },  // 10
      { 当前生命: 5, 当前装甲: 5, 当前护盾: 5 },   // 15
      { 当前生命: 100, 当前装甲: 0, 当前护盾: 0 }, // 100 → 最高
    ];
    expect(combat.selectHighHpTarget(defenders)).toBe(2);
  });

  it('L5429 支持 hp/armor/shield 字段别名', () => {
    const defenders = [
      { hp: 30, armor: 10, shield: 10 }, // 50
      { hp: 80, armor: 0, shield: 0 },   // 80 → 最高
    ];
    expect(combat.selectHighHpTarget(defenders)).toBe(1);
  });

  it('L5434 空数组 → 返回 0', () => {
    expect(combat.selectHighHpTarget([])).toBe(0);
    expect(combat.selectHighHpTarget(null as any)).toBe(0);
  });

  it('L5435 多目标同血量 → 返回排序末位索引', () => {
    const defenders = [
      { 当前生命: 50, 当前装甲: 0, 当前护盾: 0 },
      { 当前生命: 50, 当前装甲: 0, 当前护盾: 0 },
    ];
    // 升序排序末位=索引1
    expect(combat.selectHighHpTarget(defenders)).toBe(1);
  });
});

// ==================== 生成前线 (战斗相关.ecode L5319-5422) ====================
describe('生成前线 - 前线召唤物与阵地载具构造 (战斗相关.ecode L5319-5422)', () => {
  // 真实 PlayerService 提供 safeJsonParse（generateFrontline 用其解析地图 JSON 字段）
  const playerService = new PlayerService({} as PrismaService, {} as StaticDataService, {} as MapService);

  // mock StaticDataService：getBuildingByName 返回带 加成.攻击/生命/攻击文本 的战斗建筑，
  // getAllAttackTexts 返回含 "自动步枪" 的攻击文本列表（取攻击文本 命中/默认逻辑）
  const mockStatic = {
    getBuildingByName: (name: string) => {
      if (name === '防御炮台') {
        return { name: '防御炮台', 加成: { 攻击: 5, 生命: 3, 攻击文本: '轴炮a' }, 攻击文本: '轴炮a' };
      }
      return null;
    },
    getAllAttackTexts: () => [{ name: '自动步枪' }, { name: '轴炮a' }],
    getAllVehiclePartSpecs: () => [],
  } as any;

  // mock CombatStateService：记录 置成就熟练度 调用
  const profCalls: { name: string; value: number }[] = [];
  const mockCombatState = {
    setAchievementProficiency: (name: string, arr: any[], value: number) => {
      profCalls.push({ name, value });
      // 等价原版 setAchievementProficiency：非空则设置/新增，0则删除
      const idx = arr.findIndex((x) => x.名称 === name);
      if (value !== 0) {
        if (idx >= 0) arr[idx].数值 = value;
        else arr.push({ 名称: name, 数值: value });
      } else if (idx >= 0) arr.splice(idx, 1);
    },
  } as any;

  const makeCombat = () =>
    new CombatSystemService(
      {} as PrismaService,
      playerService,
      {} as BonusService,
      {} as MapService,
      mockStatic,
      {} as AchievementService,
      {} as ItemSystemService,
      mockCombatState,
    );

  const baseMap = (over: any = {}) => ({
    summons: JSON.stringify([]),
    vehicles: JSON.stringify([]),
    buildings: JSON.stringify([]),
    ...over,
  });

  it('L5336-5350 基础字段：名称/类型=前线、QQ=怪物前线+qq+sg、必中/生命/闪避/四伤=1、命中=等级+1、特殊序号=-2', () => {
    const c = makeCombat();
    const res = c.generateFrontline(baseMap(), '12345', 0, 3);
    const g = res.summon;
    expect(g.名称).toBe('前线');
    expect(g.类型).toBe('前线');
    expect(g.QQ).toBe('怪物前线12345sg');
    expect(g.归属).toBe('12345');
    expect(g.属性.必中).toBe(true);
    expect(g.属性.生命).toBe(1);
    expect(g.属性.闪避).toBe(1);
    expect(g.属性.物伤).toBe(1);
    expect(g.属性.冰伤).toBe(1);
    expect(g.属性.电伤).toBe(1);
    expect(g.属性.火伤).toBe(1);
    expect(g.属性.命中).toBe(4); // 前线等级3 + 1
    expect(g.特殊序号).toBe(-2);
  });

  it('L5372-5380 无建筑(加成.攻击均0) → 默认"火力"武器(属性26/25/25/25)，且攻击文本.名称清空', () => {
    const c = makeCombat();
    const res = c.generateFrontline(baseMap({ buildings: JSON.stringify([{ name: '基础发电机', count: 1 }]) }), '12345', 0, 0);
    expect(res.summon.武器.length).toBe(1);
    const z = res.summon.武器[0];
    expect(z.名称).toBe('火力');
    expect(z.类型).toBe('射弹武器');
    expect(z.载具强制伤害).toBe(true);
    expect(z.冷却).toBe(10);
    expect(z.属性.物).toBe(26);
    expect(z.属性.电).toBe(25);
    expect(z.属性.冰).toBe(25);
    expect(z.属性.火).toBe(25);
    // 原版 L5381：z.攻击文本.名称 = ""
    expect(z.攻击文本.name).toBe('');
  });

  it('L5356-5368 战斗建筑(加成.攻击!=0) → 加武器(属性=26/25/25/25×攻击×数量)，c累加生命×数量', () => {
    const c = makeCombat();
    const res = c.generateFrontline(
      baseMap({ buildings: JSON.stringify([{ name: '防御炮台', count: 2 }]) }),
      '12345', 0, 0,
    );
    expect(res.summon.武器.length).toBe(1);
    const z = res.summon.武器[0];
    expect(z.名称).toBe('防御炮台');
    // 攻击=5，数量=2 → 26*5*2=260
    expect(z.属性.物).toBe(260);
    expect(z.属性.电).toBe(250);
    expect(z.属性.冰).toBe(250);
    expect(z.属性.火).toBe(250);
    expect(z.加成.攻击).toBe(10); // 叠加载具加成：5×2
  });

  it('L5382-5399 阵地载具：零件=阵地核心×1 + 轻型装甲×(10+c+等级)，编号=g.QQ，载具生命由计算载具置0', () => {
    const c = makeCombat();
    // 带防御炮台(生命=3，数量2) → c = 3*2 = 6；前线等级=1 → 轻型装甲数量=10+6+1=17
    const res = c.generateFrontline(
      baseMap({ buildings: JSON.stringify([{ name: '防御炮台', count: 2 }]) }),
      '12345', 0, 1,
    );
    const v = res.vehicles.find((x: any) => x.名称 === '阵地');
    expect(v).toBeDefined();
    expect(v.编号).toBe('怪物前线12345sg');
    expect(v.归属).toBe('怪物前线12345sg');
    expect(v.驾驶员).toBe('怪物前线12345sg');
    const core = v.零件.find((p: any) => p.名称 === '阵地核心');
    const armor = v.零件.find((p: any) => p.名称 === '轻型装甲');
    expect(core.数量).toBe(1);
    expect(armor.数量).toBe(17);
    // 计算载具基础阶段：本场景零件为资源不贡献加成 → 载具.加成.生命=0
    expect(v.加成.生命).toBe(0);
    expect(v.当前生命).toBe(0);
  });

  it('L5401-5402 置成就熟练度 跟随/阵地 = 1', () => {
    profCalls.length = 0;
    const c = makeCombat();
    c.generateFrontline(baseMap(), '12345', 0, 0);
    const names = profCalls.map((p) => p.name);
    expect(names).toContain('跟随');
    expect(names).toContain('阵地');
    expect(profCalls.find((p) => p.name === '跟随')!.value).toBe(1);
    expect(profCalls.find((p) => p.name === '阵地')!.value).toBe(1);
  });

  it('L5403-5411 首次生成(g2.编号==0) → 新增召唤物到 summons，新增载具到 vehicles', () => {
    const c = makeCombat();
    const res = c.generateFrontline(baseMap(), '12345', 0, 0);
    expect(res.summons.length).toBe(1);
    expect(res.summons[0].QQ).toBe('怪物前线12345sg');
    expect(res.vehicles.length).toBe(1);
    expect(res.vehicles[0].名称).toBe('阵地');
  });

  it('L5412-5419 已存在召唤物(g2.编号!=0) → 更新而非新增，summons长度不变', () => {
    const c = makeCombat();
    // 既有前线召唤物放在 summons 下标1（前面放占位），使其编号写回=1（非0=已找到），当前生命=50
    const existing = baseMap({
      summons: JSON.stringify([
        { QQ: '占位', 编号: 0 },
        { QQ: '怪物前线12345sg', 编号: 0, 名称: '前线', 当前生命: 50 },
      ]),
    });
    const res = c.generateFrontline(existing, '12345', 0, 0);
    expect(res.summons.length).toBe(2); // 未新增（更新下标1处）
    expect(res.summons[1].当前生命).toBe(50); // 保留既有血量（L5343）
  });
});

// ==================== 计算载具 (加成计算.ecode L3556-3912) ====================
// 载入真实部件规格数据（vehicle-parts.json，由 e/源码解析成为txt/使魔大战.txt 类型=载具 节提取）
const partSpecs = require('../prisma/data/vehicle-parts.json');
describe('计算载具 - 载具属性计算 (加成计算.ecode L3556-3912)', () => {
  const realStatic = {
    getBuildingByName: () => null,
    getAllAttackTexts: () => [],
    getAllVehiclePartSpecs: () => partSpecs,
  } as any;
  const stubBonus = { addPenetration: () => {} } as any;
  const stubCombatState = { timeIntervalRequire: () => false } as any;

  const makeVehicle = () =>
    new CombatSystemService(
      {} as PrismaService,
      {} as PlayerService,
      {} as BonusService,
      {} as MapService,
      realStatic,
      {} as AchievementService,
      {} as ItemSystemService,
      stubCombatState,
    );

  it('L3581 空名称载具 → 直接返回不报错', () => {
    const v = makeVehicle();
    const veh: any = { 名称: '', 零件: [], 加成: {}, 当前生命: 100, 标记2: [] };
    expect(() => v['computeVehicle'](veh, 0)).not.toThrow();
  });

  it('L3580/L3591/L3647 核心部件(骑士核心 partType=0, 攻击=15/生命=1/闪避=10) → 加成叠加, 上限取自核心', () => {
    const v = makeVehicle();
    const veh: any = {
      名称: '测试载具',
      零件: [{ 名称: '骑士核心', 数量: 1 }],
      加成: {},
      当前生命: 0,
      行走上限: 0, 武器上限: 0, 防御上限: 0, 功能上限: 0, 行走方式: 0,
      标记2: [],
    };
    // s=null → 跳过回血，直接封顶逻辑（当前生命0 < 加成.生命 → 不改）
    v['computeVehicle'](veh, null);
    expect(veh.加成.攻击).toBe(15);     // 骑士核心 bonus.攻击=15
    expect(veh.加成.生命).toBe(1);       // bonus.生命=1
    expect(veh.加成.闪避).toBe(10);      // bonus.闪避=10
    expect(veh.行走上限).toBe(1);        // 核心 walk=1
    expect(veh.武器上限).toBe(1);        // 核心 weapon=1
    expect(veh.当前生命).toBe(0);        // s=null 不回血，保持初始0
  });

  it('L3719 白的发丝 部件 → vehicle.发丝=true', () => {
    const v = makeVehicle();
    const veh: any = {
      名称: '发丝载具',
      零件: [{ 名称: '白的发丝', 数量: 1 }],
      加成: {}, 当前生命: 0, 标记2: [],
    };
    v['computeVehicle'](veh, null);
    expect(veh.发丝).toBe(true);
  });

  it('L3752 逆转力场 + 攻击部件 → 攻击/攻击2/韧性 ×0.34', () => {
    // 骑士核心 bonus.攻击=15/攻击2=3/韧性无；逆转力场仅设标志，将已有攻击类加成×0.34
    const v = makeVehicle();
    const veh: any = {
      名称: '逆转载具',
      零件: [{ 名称: '骑士核心', 数量: 1 }, { 名称: '逆转力场', 数量: 1 }],
      加成: {},
      当前生命: 0, 标记2: [],
    };
    v['computeVehicle'](veh, null);
    expect(veh.逆转力场).toBe(true);
    expect(Math.round(veh.加成.攻击 * 100) / 100).toBe(5.1);    // 15*0.34
    expect(Math.round(veh.加成.攻击2 * 100) / 100).toBe(1.02);  // 3*0.34
  });

  it('L3836 行走超限(负行走部件累加超上限) → 当前生命=0, 行走方式=0', () => {
    // 原版 vehicle.行走 由 负行走部件(取绝对值)累加；骑士核心 行走上限=1，中型足 walk=-1×5 → 行走=5 > 1
    const v = makeVehicle();
    const veh: any = {
      名称: '超限载具',
      零件: [{ 名称: '骑士核心', 数量: 1 }, { 名称: '中型足', 数量: 5 }],
      加成: {},
      当前生命: 50,
      标记2: [],
    };
    v['computeVehicle'](veh, null);
    expect(veh.行走).toBe(5);   // 0 + 5*|-1|
    expect(veh.行走上限).toBe(1);
    expect(veh.当前生命).toBe(0);   // 超限 → 生命清零
    expect(veh.行走方式).toBe(0);
  });
});

// ==================== 免死 (战斗相关.ecode L5020-5096) ====================
// 构造带真实 PlayerService（getMarkerValue 纯JSON）/ CombatStateService（addBuff/timeIntervalRequire）的实例
const avoidPlayerService = new PlayerService({} as PrismaService, {} as StaticDataService, {} as MapService);
const avoidCombatState = new CombatStateService();
const avoidCombat = new CombatSystemService(
  {} as PrismaService,
  avoidPlayerService,
  {} as BonusService,
  {} as MapService,
  {} as StaticDataService,
  {} as AchievementService,
  {} as ItemSystemService,
  avoidCombatState,
);

describe('免死 - 使魔/装备/增益分支 (战斗相关.ecode L5020-5096)', () => {
  const nowMs = Date.now();
  const baseDef = (over: any = {}) => ({
    specialSeq: 0,
    活力: 0,
    currentHp: 100,
    skillLevel: 0,
    markers: JSON.stringify({}),
    buffs: [],
    markers2: [],
    equipment: [],
    ...over,
  });

  it('L5031-L5036 龙姬(specialSeq=12) 怒吼标记存在 → b=2（但被 L5072 默认覆盖为1，原版怒吼免死实际不生效，按原版保留）', () => {
    const d = baseDef({ specialSeq: 12, buffs: [{ 名称: '怒吼', 有效期至: nowMs + 60000 }], currentHp: 100 });
    const ok = avoidCombat['avoidDeath'](d, d.buffs, d.markers2, d.equipment, nowMs, nowMs, { value: 0 }, { value: '' });
    // ⚠️原版 L5072 独立判断的 默认 b=1 会覆盖 L5031 的 b=2，故龙姬怒吼实际不免死（原版疑似冗余分支，按原版保留）
    expect(ok).toBe(false);
  });

  it('L5031-L5036 龙姬 无怒吼 → b=1 不免死', () => {
    const d = baseDef({ specialSeq: 12, currentHp: 100 });
    const ok = avoidCombat['avoidDeath'](d, d.buffs, d.markers2, d.equipment, nowMs, nowMs, { value: 0 }, { value: '' });
    expect(ok).toBe(false);
  });

  it('L5038-L5042 伊芙利特(specialSeq=11) 五番冷却未过 → 获得增益 五番a 5秒', () => {
    const d = baseDef({ specialSeq: 11, currentHp: 50 });
    const ok = avoidCombat['avoidDeath'](d, d.buffs, d.markers2, d.equipment, nowMs, nowMs, { value: 0 }, { value: '' });
    expect(ok).toBe(true); // 五番a 增益已置 → L5072 b=3 免死返回真
    expect(d.buffs.some((b: any) => b.名称 === '五番a')).toBe(true);
  });

  it('L5072-L5078 伊芙利特 五番a 增益存在 → b=3 免死(生命-0)', () => {
    const d = baseDef({ specialSeq: 11, currentHp: 50, buffs: [{ 名称: '五番a', 有效期至: nowMs + 5000 }] });
    const txtRef = { value: '' };
    const ok = avoidCombat['avoidDeath'](d, d.buffs, d.markers2, d.equipment, nowMs, nowMs, { value: 0 }, txtRef);
    expect(ok).toBe(true);
    expect(txtRef.value).toContain('生命-0');
    expect(txtRef.value).toContain('神威灵装·五番');
  });

  it('L5043-L5049 战斗女仆(specialSeq=8) 守护3 熟练度!=0 → b=5（被 L5072 默认覆盖为1，原版实际不免死，按原版保留）', () => {
    const d = baseDef({ specialSeq: 8, currentHp: 80, markers: JSON.stringify({ 守护3: 1 }) });
    const ok = avoidCombat['avoidDeath'](d, d.buffs, d.markers2, d.equipment, nowMs, nowMs, { value: 0 }, { value: '' });
    // ⚠️原版 L5072 默认 b=1 覆盖 L5043 的 b=5，故战斗女仆守护3 实际不免死（原版疑似冗余分支）
    expect(ok).toBe(false);
  });

  it('L5043-L5049 战斗女仆 无守护3 → b=1 不免死', () => {
    const d = baseDef({ specialSeq: 8, currentHp: 80 });
    const ok = avoidCombat['avoidDeath'](d, d.buffs, d.markers2, d.equipment, nowMs, nowMs, { value: 0 }, { value: '' });
    expect(ok).toBe(false);
  });

  it('L5050-L5063 吸血姬(活力=-15) 场上有分身(活力=-16, 当前生命>0) → 互换生命免死', () => {
    const clone = { 活力: -16, currentHp: 200 };
    const d = baseDef({ 活力: -15, currentHp: 30 });
    const txtRef = { value: '' };
    const ok = avoidCombat['avoidDeath'](d, d.buffs, d.markers2, d.equipment, nowMs, nowMs, { value: 0 }, txtRef, [clone]);
    expect(ok).toBe(true);
    expect(d.currentHp).toBe(200);     // 本体获得分身生命
    expect(clone.currentHp).toBe(0);   // 分身生命清零
    expect(txtRef.value).toContain('与分身互换生命');
  });

  it('L5064-L5067 猫爪吊坠(specialSeq=23) 猫爪冷却未过 → 获得增益 猫爪 10秒', () => {
    const d = baseDef({ equipment: [{ specialSeq: 23 }], currentHp: 60 });
    const ok = avoidCombat['avoidDeath'](d, d.buffs, d.markers2, d.equipment, nowMs, nowMs, { value: 0 }, { value: '' });
    expect(ok).toBe(true); // 猫爪 增益已置 → L5072 b=4 免死返回真
    expect(d.buffs.some((b: any) => b.名称 === '猫爪')).toBe(true);
  });

  it('L5072-L5078 猫爪增益存在 → b=4 免死(生命-0)', () => {
    const d = baseDef({ currentHp: 60, buffs: [{ 名称: '猫爪', 有效期至: nowMs + 10000 }] });
    const txtRef = { value: '' };
    const ok = avoidCombat['avoidDeath'](d, d.buffs, d.markers2, d.equipment, nowMs, nowMs, { value: 0 }, txtRef);
    expect(ok).toBe(true);
    expect(txtRef.value).toContain('猫爪');
  });

  it('L5069-L5071 无特殊使魔/装备 → b=1 默认不免死', () => {
    const d = baseDef({ specialSeq: 0, currentHp: 100 });
    const ok = avoidCombat['avoidDeath'](d, d.buffs, d.markers2, d.equipment, nowMs, nowMs, { value: 0 }, { value: '' });
    expect(ok).toBe(false);
  });
});

// ==================== 计算反伤 (战斗相关.ecode L4791-4873) ====================
describe('计算反伤 - calcReflectDamage (战斗相关.ecode L4791-4873)', () => {
  const playerService = new PlayerService({} as PrismaService, {} as StaticDataService, {} as MapService);
  const combatState = new CombatStateService();
  const reflectCombat = new CombatSystemService(
    {} as PrismaService,
    playerService,
    {} as BonusService,
    {} as MapService,
    {} as StaticDataService,
    {} as AchievementService,
    {} as ItemSystemService,
    combatState,
  );

  const nowSec = () => Math.floor(Date.now() / 1000);
  const nowMs = () => Date.now();

  // 攻击方属性（z1 用攻击方武器属性）
  const atkBonus = { physDmg: 50, fireDmg: 0, iceDmg: 0, elecDmg: 0, crit: 5, critDmg: 150 };
  const z1Props = { phys: 100, fire: 0, ice: 0, elec: 0 };
  const defBonus = { physDmg: 40, fireDmg: 0, iceDmg: 0, elecDmg: 0, crit: 5, critDmg: 150 };

  // 基础防御方：无反伤来源
  const baseDefender = () => ({
    type: '普通',
    specialSeq: 0,
    affinity: 0,
    hp: 100,
    shield: 0,
    armor: 0,
    currentWeapon: 0,
    equipments: JSON.stringify([]),
    weapons: JSON.stringify([]),
    markers: JSON.stringify({}),
    markers2: JSON.stringify([]),
    buffs: JSON.stringify([]),
  });

  it('L4806 恶毒好感≥100 且 色欲(30s)未冷却 → 返回100', () => {
    const d = baseDefender();
    d.type = '恶毒';
    d.specialSeq = 6; // 原版 #恶毒 = 6
    d.affinity = 100;
    const r = reflectCombat['calcReflectDamage'](d, defBonus, atkBonus, z1Props, { phys: 100, fire: 0, ice: 0, elec: 0 }, 150, nowSec(), nowMs());
    expect(r).toBe(100);
  });

  it('L4815 军姬好感≥40 且有剑阵增益 → 返回100', () => {
    const d = baseDefender();
    d.type = '军姬';
    d.specialSeq = 16; // 原版 #军姬 = 16
    d.affinity = 40;
    // buffRequire 按中文 key 读取（名称/有效期至，毫秒时间戳），与原版战斗状态机一致
    d.buffs = JSON.stringify([{ 名称: '剑阵', 有效期至: nowMs() + 60000 }]);
    const r = reflectCombat['calcReflectDamage'](d, defBonus, atkBonus, z1Props, { phys: 100, fire: 0, ice: 0, elec: 0 }, 150, nowSec(), nowMs());
    expect(r).toBe(100);
  });

  it('L4824 装备荆棘之翼(#18) → 倍率+0.15 产生反伤值', () => {
    const d = baseDefender();
    d.equipments = JSON.stringify([{ 名称: '荆棘之翼', 特殊序号: 18 }]);
    const r = reflectCombat['calcReflectDamage'](d, defBonus, atkBonus, z1Props, { phys: 100, fire: 0, ice: 0, elec: 0 }, 150, nowSec(), nowMs());
    // 倍率=0.1+0.15=0.25；a2=50*1*150/100*5/100*150/100=5.625; a2*0.25=1.406; a1=40*1*150/100*5/100=3; pct=1.406/3*100≈46.875; 反伤=3*46.875/100≈1.406
    expect(r).toBeGreaterThan(0);
    expect(Math.abs(r - 1.40625)).toBeLessThan(0.01);
  });

  it('L4827 装备小鱼发饰(#35) 且 小鱼冷却(60s)未过 → 倍率+2', () => {
    const d = baseDefender();
    d.equipments = JSON.stringify([{ 名称: '小鱼发饰', 特殊序号: 35 }]);
    const r = reflectCombat['calcReflectDamage'](d, defBonus, atkBonus, z1Props, { phys: 100, fire: 0, ice: 0, elec: 0 }, 150, nowSec(), nowMs());
    // 倍率=0.1+2=2.1; a2*2.1=11.8125; a1=3; pct=11.8125/3*100=393.75; 反伤=3*3.9375≈11.8125
    expect(Math.abs(r - 11.8125)).toBeLessThan(0.01);
  });

  it('L4833 军姬2(#24) 当前生命>0 且 好感≥40 → 倍率+1+(2+技能×0.05) 并触发军姬倍率限制', () => {
    const d = baseDefender();
    d.type = '军姬2';
    d.specialSeq = 24; // 原版 #军姬2 = 24
    d.affinity = 40;
    d.hp = 50;
    d.markers = JSON.stringify({ 军姬2技能: 10 });
    d.equipments = JSON.stringify([]);
    const r = reflectCombat['calcReflectDamage'](d, { ...defBonus, hp: 200, armor: 0, shield: 0 }, atkBonus, z1Props, { phys: 100, fire: 0, ice: 0, elec: 0 }, 150, nowSec(), nowMs());
    // 倍率=0.1+1+(2+10*0.05)=3.6; 但军姬限制 cap=(2+10*0.05)*200=250; pct 受 cap 限制
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThanOrEqual(250);
  });

  it('L4803 无任何反伤来源 → 倍率默认0.1 产生基础反伤(原版 倍率 默认0.1)', () => {
    const d = baseDefender();
    // 原版 L4803 倍率 默认 0.1，故无装备/好感时仍按 10% 基础反伤结算：
    // a2=50*1.5*0.05*1.5=5.625; a1=40*1.5*0.05=3; pct=5.625*0.1/3*100=18.75; 反伤=3*0.1875=0.5625
    const r = reflectCombat['calcReflectDamage'](d, defBonus, atkBonus, z1Props, { phys: 100, fire: 0, ice: 0, elec: 0 }, 150, nowSec(), nowMs());
    expect(Math.abs(r - 0.5625)).toBeLessThan(0.001);
  });

  // ============ 运行时数据格式兼容层（中/英文 key + 秒/毫秒） ============
  it('兼容层：英文 key(name/expireAt,秒) 的 buff 也能被识别（运行时 game 层约定）', () => {
    const d = baseDefender();
    d.type = '军姬';
    d.specialSeq = 16;
    d.affinity = 40;
    // 运行时 game 层用 英文 key + 秒级时间戳（Date.now()/1000）写入
    d.buffs = JSON.stringify([{ name: '剑阵', expireAt: nowSec() + 60 }]);
    const r = reflectCombat['calcReflectDamage'](d, defBonus, atkBonus, z1Props, { phys: 100, fire: 0, ice: 0, elec: 0 }, 150, nowSec(), nowMs());
    expect(r).toBe(100);
  });

  it('兼容层：英文 key(name/expireAt,秒) 的 markers2 也能被 timeIntervalRequire 识别', () => {
    const d = baseDefender();
    d.type = '恶毒';
    d.specialSeq = 6;
    d.affinity = 100;
    // 情况A：运行时用 英文 key + 秒级时间戳 写入 markers2 的 色欲 刚写入30s内（仍在冷却）
    // 原版 L4806 逻辑：时间间隔要求(色欲,30) 返回 真(冷却中) → 不返回100 → 走基础反伤 0.5625
    d.markers2 = JSON.stringify([{ name: '色欲', expireAt: nowSec() + 30 }]);
    const rInCooldown = reflectCombat['calcReflectDamage'](d, defBonus, atkBonus, z1Props, { phys: 100, fire: 0, ice: 0, elec: 0 }, 150, nowSec(), nowMs());
    expect(Math.abs(rInCooldown - 0.5625)).toBeLessThan(0.001);

    // 情况B：空 markers2（色欲未冷却）→ timeIntervalRequire 返回 假 → 命中 返回100
    // 证明英文 key 格式的 markers2 被 timeIntervalRequire 正确读取（兼容层生效）
    const d2 = baseDefender();
    d2.type = '恶毒';
    d2.specialSeq = 6;
    d2.affinity = 100;
    d2.markers2 = JSON.stringify([]);
    const rNoCooldown = reflectCombat['calcReflectDamage'](d2, defBonus, atkBonus, z1Props, { phys: 100, fire: 0, ice: 0, elec: 0 }, 150, nowSec(), nowMs());
    expect(rNoCooldown).toBe(100);
  });
});

// ==================== 计算增益接入 (加成计算.ecode L3097-3142 计算buff 接入 buildAttackerBonus) ====================
// 验证 _计算玩家 末尾调用 计算buff 后，增益列表定义的加成在玩家属性中生效。
describe('计算增益接入 - buildAttackerBonus 调用 calculateBuffs', () => {
  // mock StaticDataService：返回含"网"(闪避2=-30)的增益列表定义
  const buffStatic = {
    getAllBuffs: () => [
      { name: '网', bonus: '{"闪避2":-30}' },
      { name: '破魔', bonus: '{"护盾全抗":-20}' },
    ],
  } as any;
  const buffPlayerService = new PlayerService({} as PrismaService, {} as StaticDataService, {} as MapService);
  const buffBonusService = new BonusService();
  const buffCombat = new CombatSystemService(
    {} as PrismaService,
    buffPlayerService,
    buffBonusService,
    {} as MapService,
    buffStatic,
    {} as AchievementService,
    {} as ItemSystemService,
    {} as any,
  );

  const basePlayerForBuff = () => ({
    userId: 1,
    type: '测试使魔',        // 非空的 type → 走使魔成长分支
    specialSeq: 8,           // 战斗女仆（仅取成长，避免其它使魔分支干扰）
    affinity: 0,
    level: 10,
    hp: 100, shield: 100, armor: 100,
    currentWeapon: 0,
    weapons: '[]', equipment: '[]', backpack: '[]', sets: '{}',
    markers: JSON.stringify({}), markers2: JSON.stringify([]),
  });

  const buffPlayerData = (buffs: any[]) => ({
    player: basePlayerForBuff(),
    markers: {},
    buffs,
    equipment: [],
    tasks: [],
    backpack: [],
    weapons: [],
    markers2: [],
    safeBox: [],
  });

  it('无增益 → dodge 为纯成长值（不叠加增益列表）', () => {
    const bonus = buffCombat.buildAttackerBonus(basePlayerForBuff(), buffPlayerData([]));
    // 战斗女仆 specialSeq=8 成长：闪避=10+(等级/2+防御/2)*(1+等级/100)，防御熟练=0
    // = 10 + (10/2+0)/1.1 = 10 + 5/1.1 ≈ 14.545，向下取整前为浮点
    const expected = 10 + (10 / 2) * (1 + 10 / 100);
    expect(Math.abs((bonus.dodge || 0) - expected)).toBeLessThan(0.001);
  });

  it('L3097-3142 default 分支：带"网"增益(未过期) → 闪避2=-30 按增益模式乘到闪避(×0.7)', () => {
    const buffs = [{ name: '网', expireAt: Date.now() / 1000 + 60, strength: 1 }];
    const bonus = buffCombat.buildAttackerBonus(basePlayerForBuff(), buffPlayerData(buffs));
    const base = 10 + (10 / 2) * (1 + 10 / 100);
    // 增益模式：dodge *= (1 + 闪避2/100) = (1 + (-30)/100) = 0.7
    expect(Math.abs((bonus.dodge || 0) - base * 0.7)).toBeLessThan(0.001);
  });

  it('过期增益 → 不参与叠加（闪避保持纯成长值）', () => {
    const buffs = [{ name: '网', expireAt: Date.now() / 1000 - 10, strength: 1 }];
    const bonus = buffCombat.buildAttackerBonus(basePlayerForBuff(), buffPlayerData(buffs));
    const base = 10 + (10 / 2) * (1 + 10 / 100);
    expect(Math.abs((bonus.dodge || 0) - base)).toBeLessThan(0.001);
  });
});
