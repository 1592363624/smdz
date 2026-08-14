/**
 * 战斗公式回归测试（可独立运行：npx ts-node test/combat-formula.test.ts）
 * 验证重构后的三层池串行穿透溢出 + 三层独立抗性/穿透模型
 * 对应原版：战斗相关.ecode 的 造成伤害() / 攻击目标() 子程序
 *
 * 注：本测试只验证 calcDamage 的纯计算逻辑（不触发 DB），
 * 通过为 CombatSystemService 构造最小 stub 依赖实现。
 */

// 允许直接 import 编译后的服务（ts-node 会按需编译）
import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { BonusData } from '../src/modules/game/bonus.service';
import { DamageBreakdown } from '../src/modules/game/combat-system.service';

// ============ 最小依赖 stub ============
const prismaStub: any = {};
const playerStub: any = { getPlayerData: async () => ({}) };
const bonusStub: any = { mergeBonus: (a: any, b: any) => ({ ...a, ...b }), applyAllDiminishingReturns: (b: any) => b };
const mapStub: any = {};

const svc = new CombatSystemService(prismaStub, playerStub, bonusStub, mapStub);

// ============ 测试工具 ============
let passed = 0;
let failed = 0;
const EPS = 1e-6;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function approx(a: number, b: number, msg: string, tol = 1e-3) {
  assert(Math.abs(a - b) <= tol, `${msg} (期望≈${b}, 实际=${a.toFixed(4)})`);
}

function makeWeapon(damage: number, props?: Partial<DamageBreakdown>): any {
  return {
    name: '测试武器',
    damage,
    damageType: 1,
    properties: { phys: 100, fire: 0, ice: 0, elec: 0, ...(props || {}) },
  };
}

// 固定随机数，保证可重复
const origRandom = Math.random;
function withRandom(val: number, fn: () => void) {
  Math.random = () => val;
  try { fn(); } finally { Math.random = origRandom; }
}

// ============ 用例 1：纯生命目标，无护盾/装甲 ============
console.log('\n[用例1] 纯生命目标（无护盾/装甲），全部伤害打生命');
withRandom(0, () => {
  const atk: BonusData = { attack: 100, hit: 100, critDmg: 50 };
  const def: BonusData = { hp: 1000, dodge: 1 };
  const res = svc.calcDamage(atk, def, makeWeapon(100), 1, false);
  // 生命为最底层：伤害5000超过当前生命1000，破生命层扣满1000（溢出即击杀，不再传递），符合原版
  approx(res.poolDamage.hp, 1000, '生命层破层扣满当前生命1000（溢出击杀）');
  approx(res.poolDamage.shield, 0, '护盾层为0');
  approx(res.poolDamage.armor, 0, '装甲层为0');
});

// ============ 用例 2：有护盾无装甲，破盾溢出打生命 ============
console.log('\n[用例2] 有护盾(500)无装甲，溢出按比例打生命');
withRandom(0, () => {
  const atk: BonusData = { attack: 100, hit: 100, critDmg: 50 };
  const def: BonusData = { hp: 5000, shield: 500, dodge: 1 };
  const res = svc.calcDamage(atk, def, makeWeapon(100), 1, false);
  // 护盾层伤害=5000，shieldDmgCap=100% → 扣满护盾500，溢出4500转生命
  approx(res.poolDamage.shield, 500, '护盾扣满500');
  approx(res.poolDamage.armor, 0, '无装甲层0');
  approx(res.poolDamage.hp, 4500, '生命层承受溢出4500');
});

// ============ 用例 3：三层全有 + 护盾物抗，验证各层独立抗减 ============
console.log('\n[用例3] 三层全有 + 护盾物抗50% + 装甲物抗30%');
withRandom(0, () => {
  const atk: BonusData = { attack: 100, hit: 100, critDmg: 50 };
  const def: BonusData = {
    hp: 100000, armor: 100000, shield: 100000,
    shieldPhysRes: 50, armorPhysRes: 30, hpPhysRes: 0,
    dodge: 1,
  };
  const res = svc.calcDamage(atk, def, makeWeapon(100), 1, false);
  // 护盾层：5000 * (1 - 50/100) = 2500 → 扣满护盾100000? 不，shieldDmgCap=100% 当前护盾100000，2500<100000 不破盾
  // 注意：护盾层伤害2500 < 当前护盾100000，不溢出，护盾层只扣2500，装甲/生命层为0
  approx(res.poolDamage.shield, 2500, '护盾层抗减后2500（50%物抗）');
  approx(res.poolDamage.armor, 0, '未破盾，装甲层0');
  approx(res.poolDamage.hp, 0, '未破盾，生命层0');
});

// ============ 用例 4：护盾穿透生效 ============
console.log('\n[用例4] 护盾物抗50% + 护盾穿透50% → 护盾层免抗');
withRandom(0, () => {
  const atk: BonusData = { attack: 100, hit: 100, critDmg: 50, shieldPenetration: 50 };
  const def: BonusData = {
    hp: 100000, shield: 100000,
    shieldPhysRes: 50, dodge: 1,
  };
  const res = svc.calcDamage(atk, def, makeWeapon(100), 1, false);
  // 穿透后护盾物抗 = max(0, 50 - 50) = 0 → 护盾层伤害=5000
  approx(res.poolDamage.shield, 5000, '护盾穿透抵消50%物抗，护盾层=5000');
});

// ============ 用例 5：暴击倍率 1.5 ============
console.log('\n[用例5] 暴击时伤害×1.5');
withRandom(0, () => {
  const atk: BonusData = { attack: 100, hit: 100, critDmg: 150 };
  const def: BonusData = { hp: 100000, dodge: 1 };
  const noCrit = svc.calcDamage(atk, def, makeWeapon(100), 1, false);
  const crit = svc.calcDamage(atk, def, makeWeapon(100), 1, true);
  // def hp=100000 不破层：非暴击 final=5000，暴击×1.5=7500
  approx(noCrit.poolDamage.hp, 5000, '非暴击生命层=5000（未破层）');
  approx(crit.poolDamage.hp, 7500, '暴击伤害=非暴击×1.5=7500');
});

// ============ 用例 6：攻击护盾加伤 atkShield ============
console.log('\n[用例6] atkShield=100% → 护盾层伤害翻倍');
withRandom(0, () => {
  const atk: BonusData = { attack: 100, hit: 100, critDmg: 50, atkShield: 100 };
  const def: BonusData = { hp: 100000, shield: 100000, dodge: 1 };
  const res = svc.calcDamage(atk, def, makeWeapon(100), 1, false);
  // 护盾层 = 5000 * (1 + 100/100) = 10000
  approx(res.poolDamage.shield, 10000, 'atkShield+100%使护盾层=10000');
});

// ============ 用例 7：非暴击随机区间 [0.25,1.0] 边界 ============
console.log('\n[用例7] 随机修正区间验证（下限0.25 / 上限1.0）');
{
  const atk: BonusData = { attack: 100, hit: 100, critDmg: 150 };
  const def: BonusData = { hp: 100000, dodge: 1 };
  let minD = Infinity, maxD = -Infinity;
  for (let i = 0; i < 200; i++) {
    const r = Math.random();
    const res = (() => { const o = Math.random; Math.random = () => r; try { return svc.calcDamage(atk, def, makeWeapon(100), 1, false); } finally { Math.random = o; } })();
    minD = Math.min(minD, res.poolDamage.hp);
    maxD = Math.max(maxD, res.poolDamage.hp);
  }
  // 下限 randomFactor=0.25 → 200*100*0.25=5000；上限1.0 → 200*100*1.0=20000
  assert(minD >= 5000 - 1e-6, `随机下限伤害≥5000 (实际=${minD.toFixed(1)})`);
  assert(maxD <= 20000 + 1e-6, `随机上限伤害≤20000 (实际=${maxD.toFixed(1)})`);
}

// ============ 结果 ============
console.log(`\n========== 测试结果 ==========`);
console.log(`通过: ${passed}  失败: ${failed}`);
if (failed > 0) {
  console.error('存在失败用例！');
  process.exit(1);
} else {
  console.log('全部通过 ✓');
  process.exit(0);
}
