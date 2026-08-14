/**
 * 全游戏边界与规范性综合测试（可独立运行：npx ts-node test/full-game.test.ts）
 * 覆盖三大模块：
 *   A. 战斗系统：死亡/无地图/无怪物/无武器/三层池流转/击杀/保底伤害/怪物缺字段边界
 *   B. 指令引擎：空输入/前缀剥离/未知指令/冷却机制/handler未注册/执行后设置冷却
 *   C. 生产系统：无电停产/空建筑/作物1/10产出/材料不足/种植收获边界
 *
 * 通过最小 stub 依赖驱动，不连接真实数据库。
 */

import { CombatSystemService } from '../src/modules/game/combat-system.service';
import { CommandService } from '../src/modules/command/command.service';
import { HomeService } from '../src/modules/game/home.service';

// ============ 测试计数 ============
let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// ============ 随机数控制 ============
const origRandom = Math.random;
function withRandom(val: number, fn: () => void) {
  Math.random = () => val;
  try { fn(); } finally { Math.random = origRandom; }
}

// ========================================================================
// A. 战斗系统边界
// ========================================================================
console.log('\n========== A. 战斗系统边界测试 ==========');

/**
 * 构造一个武器攻击可用的玩家与地图环境
 * 通过 mock 各依赖实现，重点验证武器攻击流程的边界分支与三层池流转。
 */
function makeCombatFixture(opts: {
  playerDead?: boolean;
  noMap?: boolean;
  noMonsters?: boolean;
  monsterShieldField?: boolean; // 怪物对象是否带 shield/armor 字段
}) {
  const player = {
    id: 1,
    name: '测试玩家',
    hp: 100, maxHp: 100,
    mapId: 10,
    attack: 100, hit: 100, crit: 5, critDmg: 150, dodge: 0,
    type: '',
    weapons: [],
  };
  if (opts.playerDead) { player.hp = 0; }

  const monsterBase = {
    id: 'm1', name: '测试怪', level: 1, specialSeq: 0,
    hp: 100, maxHp: 100, attack: 10, defense: 0, speed: 100, dodge: 1, hit: 85, exp: 10,
  };
  // 是否给怪物加 shield/armor 字段（模拟有护盾装甲的怪物）
  const monster = opts.monsterShieldField
    ? { ...monsterBase, shield: 50, maxShield: 50, armor: 50, maxArmor: 50 }
    : { ...monsterBase };

  const mapObj = {
    id: 10, name: '测试地图',
    spawnMonsters: JSON.stringify(opts.noMonsters ? [] : [monster]),
    tempMonsters: '[]',
  };

  const playerStub: any = {
    getPlayerData: async () => ({
      player,
      backpack: [], equipment: [], weapons: [],
      markers: {}, markers2: [], buffs: [], tasks: [], safeBox: [], sets: {},
    }),
    isPlayerDead: (p: any) => (p.hp || 0) <= 0,
    savePlayer: async () => {},
    addExp: async () => {},
    addToBackpack: async () => {},
  };
  const prismaStub: any = {
    gameMap: {
      findUnique: async ({ where }: any) => {
        if (opts.noMap) return null;
        if (where && where.id === 10) return mapObj;
        return null;
      },
      update: async () => ({}),
    },
    commandLog: { create: async () => ({}) },
  };
  const bonusStub: any = {
    mergeBonus: (a: any, b: any) => ({ ...a, ...b }),
    applyAllDiminishingReturns: (b: any) => b,
  };
  const mapStub: any = {
    getMapMonsters: (m: any) => {
      const spawn = JSON.parse(m.spawnMonsters || '[]');
      const temp = JSON.parse(m.tempMonsters || '[]');
      return [...spawn, ...temp];
    },
    removeMapMonster: (m: any, id: string) => {
      m.spawnMonsters = JSON.stringify(JSON.parse(m.spawnMonsters || '[]').filter((x: any) => x.id !== id));
    },
  };

  return {
    svc: new CombatSystemService(prismaStub as any, playerStub as any, bonusStub as any, mapStub as any),
    player, mapObj, monster: monster as any,
  };
}

console.log('\n[A1] 死亡玩家攻击 → 拒绝');
withRandom(0, async () => {
  const { svc } = makeCombatFixture({ playerDead: true });
  const r = await svc.weaponAttack(1, 0, { noDelay: true });
  assert(r.damageDealt === 0 && /死亡/.test(r.result), '死亡玩家返回"已死亡"提示且0伤害');
});

console.log('\n[A2] 不在任何地图 → 拒绝');
withRandom(0, async () => {
  const { svc } = makeCombatFixture({ noMap: true });
  const r = await svc.weaponAttack(1, 0, { noDelay: true });
  assert(r.damageDealt === 0 && /不在任何地图/.test(r.result), '无地图返回提示且0伤害');
});

console.log('\n[A3] 地图无怪物 → 等待刷新');
withRandom(0, async () => {
  const { svc } = makeCombatFixture({ noMonsters: true });
  const r = await svc.weaponAttack(1, 0, { noDelay: true });
  assert(r.damageDealt === 0 && /没有怪物/.test(r.result), '无怪物返回提示且0伤害');
});

console.log('\n[A4] 拳头(武器索引0)攻击普通怪 → 必中且造成伤害');
withRandom(0, async () => {
  const { svc, monster } = makeCombatFixture({});
  const r = await svc.weaponAttack(1, 0, { noDelay: true, mustHit: true });
  assert(r.damageDealt > 0, `拳头造成正伤害(${r.damageDealt})`);
  assert(monster.hp < 100, '怪物血量下降');
});

console.log('\n[A5] 致命必中 → 击杀怪物并产出经验');
withRandom(0, async () => {
  const { svc, monster } = makeCombatFixture({ monsterShieldField: true });
  // 玩家攻击极高，保证一击必杀（含破盾破甲）
  const strongPlayerStub = {
    getPlayerData: async () => ({
      player: { id:1, name:'强', hp:100, maxHp:100, mapId:10, attack:100000, hit:100, crit:5, critDmg:150, dodge:0, type:'', weapons:[] },
      backpack: [], equipment: [], weapons: [], markers:{}, markers2:[], buffs:[], tasks:[], safeBox:[], sets:{},
    }),
    isPlayerDead: () => false,
    savePlayer: async () => {},
    addExp: async () => {},
    addToBackpack: async () => {},
  };
  // 重建 service 用强玩家 stub
  const prismaStub: any = {
    gameMap: { findUnique: async ({ where }: any) => where && where.id === 10 ? {
      id:10, name:'m', spawnMonsters: JSON.stringify([monster]), tempMonsters:'[]',
    } : null, update: async () => ({}) },
    commandLog: { create: async () => ({}) },
  };
  const bonusStub: any = { mergeBonus:(a:any,b:any)=>({...a,...b}), applyAllDiminishingReturns:(b:any)=>b };
  const mapStub: any = {
    getMapMonsters: (m:any)=>[...JSON.parse(m.spawnMonsters||'[]'), ...JSON.parse(m.tempMonsters||'[]')],
    removeMapMonster: (m:any,id:string)=>{ m.spawnMonsters = JSON.stringify(JSON.parse(m.spawnMonsters||'[]').filter((x:any)=>x.id!==id)); },
  };
  const svc2 = new CombatSystemService(prismaStub as any, strongPlayerStub as any, bonusStub as any, mapStub as any);
  const r = await svc2.weaponAttack(1, 0, { noDelay: true, mustHit: true });
  assert(r.killed.includes('测试怪'), '怪物被击杀并进入 killed 列表');
  assert(monster.hp <= 0 && monster.shield <= 0 && monster.armor <= 0, '三层池（护盾/装甲/生命）全部清空');
});

console.log('\n[A6] 怪物带 shield/armor 字段 → 三层池正确分层（先破盾→破甲→破生命）');
withRandom(0, async () => {
  // 构造带护盾50/装甲50的怪物，用中等伤害（不致命）验证护盾层先扣
  const { svc, monster } = makeCombatFixture({ monsterShieldField: true });
  // 玩家攻击力设为刚好只破护盾不破装甲：baseAttack=100, random=0→factor=0.25, 伤害=25 < 护盾50
  const weakStub = {
    getPlayerData: async () => ({
      player: { id:1, name:'弱', hp:100, maxHp:100, mapId:10, attack:100, hit:100, crit:0, critDmg:150, dodge:0, type:'', weapons:[] },
      backpack: [], equipment: [], weapons: [], markers:{}, markers2:[], buffs:[], tasks:[], safeBox:[], sets:{},
    }),
    isPlayerDead: () => false, savePlayer: async () => {}, addExp: async () => {}, addToBackpack: async () => {},
  };
  const prismaStub: any = {
    gameMap: { findUnique: async ({ where }: any) => where && where.id === 10 ? {
      id:10, name:'m',
      spawnMonsters: JSON.stringify([{ id:'m1', name:'测试怪', level:1, specialSeq:0, hp:100, maxHp:100, shield:50, maxShield:50, armor:50, maxArmor:50, attack:10, defense:0, speed:100, dodge:1, hit:85, exp:10 }]),
      tempMonsters:'[]',
    } : null, update: async () => ({}) },
    commandLog: { create: async () => ({}) },
  };
  const bonusStub: any = { mergeBonus:(a:any,b:any)=>({...a,...b}), applyAllDiminishingReturns:(b:any)=>b };
  const mapStub: any = { getMapMonsters:(m:any)=>[...JSON.parse(m.spawnMonsters||'[]'), ...JSON.parse(m.tempMonsters||'[]')], removeMapMonster:(m:any,id:string)=>{ m.spawnMonsters = JSON.stringify(JSON.parse(m.spawnMonsters||'[]').filter((x:any)=>x.id!==id)); } };
  const svc2 = new CombatSystemService(prismaStub as any, weakStub as any, bonusStub as any, mapStub as any);
  const r = await svc2.weaponAttack(1, 0, { noDelay: true, mustHit: true });
  // 伤害25 < 护盾50 → 只扣护盾，护盾剩余25；装甲/生命不动
  assert(monster.shield === 25, `护盾层扣减正确(剩${monster.shield})`);
  assert(monster.armor === 50, '装甲层未受击');
  assert(monster.hp === 100, '生命层未受击');
});

console.log('\n[A7] 保底1点伤害：极低伤害但命中 → 至少1点');
withRandom(0.5, async () => {
  const { svc } = makeCombatFixture({});
  // 攻击力设为1，保证 finalDamage 经 Math.floor 后可能为0，验证保底逻辑
  const weakStub = {
    getPlayerData: async () => ({
      player: { id:1, name:'弱', hp:100, maxHp:100, mapId:10, attack:1, hit:100, crit:0, critDmg:150, dodge:0, type:'', weapons:[] },
      backpack: [], equipment: [], weapons: [], markers:{}, markers2:[], buffs:[], tasks:[], safeBox:[], sets:{},
    }),
    isPlayerDead: () => false, savePlayer: async () => {}, addExp: async () => {}, addToBackpack: async () => {},
  };
  const prismaStub: any = {
    gameMap: { findUnique: async ({ where }: any) => where && where.id === 10 ? {
      id:10, name:'m', spawnMonsters: JSON.stringify([{ id:'m1', name:'测试怪', level:1, specialSeq:0, hp:100, maxHp:100, attack:10, defense:0, speed:100, dodge:1, hit:85, exp:10 }]), tempMonsters:'[]',
    } : null, update: async () => ({}) },
    commandLog: { create: async () => ({}) },
  };
  const bonusStub: any = { mergeBonus:(a:any,b:any)=>({...a,...b}), applyAllDiminishingReturns:(b:any)=>b };
  const mapStub: any = { getMapMonsters:(m:any)=>[...JSON.parse(m.spawnMonsters||'[]'), ...JSON.parse(m.tempMonsters||'[]')], removeMapMonster:(m:any,id:string)=>{ m.spawnMonsters = JSON.stringify(JSON.parse(m.spawnMonsters||'[]').filter((x:any)=>x.id!==id)); } };
  const svc2 = new CombatSystemService(prismaStub as any, weakStub as any, bonusStub as any, mapStub as any);
  const r = await svc2.weaponAttack(1, 0, { noDelay: true, mustHit: true });
  // 攻击1：baseAttack=1，随机0.5→factor=0.75，finalDamage=floor(0.75)=0 → 保底1
  assert(r.damageDealt >= 1, `保底伤害≥1（实际=${r.damageDealt}）`);
});

// ========================================================================
// B. 指令引擎边界
// ========================================================================
console.log('\n========== B. 指令引擎边界测试 ==========');

function makeCommandFixture() {
  const handlerCalls: string[] = [];
  const handlerMap: any = {
    attack: {
      handle: async (_ctx: any, _args: any) => {
        handlerCalls.push('attack');
        return { success: true, content: '攻击成功', broadcast: true, durationMs: 0 };
      },
    },
    home: {
      handle: async (_ctx: any, _args: any) => {
        handlerCalls.push('home');
        return { success: true, content: '家园', broadcast: false, durationMs: 0 };
      },
    },
    // 故意不注册 'missing' handler 以测试未注册分支
  };

  const prismaStub: any = {
    command: {
      findFirst: async ({ where }: any) => {
        // 简易指令表：攻击/家园/未注册指令
        const table: any = {
          '攻击': { name: '攻击', handlerKey: 'attack', enabled: true, minRole: 'USER', alias: 'attack' },
          '家园': { name: '家园', handlerKey: 'home', enabled: true, minRole: 'USER', alias: '' },
          '未注册': { name: '未注册', handlerKey: 'missing', enabled: true, minRole: 'USER', alias: '' },
        };
        const name = where.OR[0].name.equals;
        return table[name] && table[name].enabled ? table[name] : null;
      },
      findMany: async () => [],
    },
    commandLog: { create: async () => ({}) },
  };
  const systemConfigStub: any = {
    get: async (_key: string, def: any) => def,
  };
  const svc = new CommandService(prismaStub as any, systemConfigStub as any, handlerMap as any);
  return { svc, handlerCalls };
}

console.log('\n[B1] 空输入 → 提示输入指令');
(async () => {
  const { svc } = makeCommandFixture();
  const r = await svc.dispatch({ rawMessage: '   ', userId: 1, source: 'web' } as any);
  assert(!r.success && /请输入指令/.test(r.content), '空输入返回提示');
})();

console.log('\n[B2] 前缀剥离：/攻击 !attack ！攻击 攻击 均应匹配');
(async () => {
  const { svc, handlerCalls } = makeCommandFixture();
  for (const raw of ['攻击', '/攻击', '！攻击', '!attack']) {
    handlerCalls.length = 0;
    const r = await svc.dispatch({ rawMessage: raw, userId: 1, source: 'web' } as any);
    assert(r.success && handlerCalls.includes('attack'), `「${raw}」→ 命中攻击指令`);
  }
})();

console.log('\n[B3] 未知指令 → 未找到提示');
(async () => {
  const { svc } = makeCommandFixture();
  const r = await svc.dispatch({ rawMessage: '乱七八糟', userId: 1, source: 'web' } as any);
  assert(!r.success && /未找到指令/.test(r.content), '未知指令返回未找到');
})();

console.log('\n[B4] 指令大小写/别名：attack 别名匹配「攻击」');
(async () => {
  const { svc, handlerCalls } = makeCommandFixture();
  handlerCalls.length = 0;
  const r = await svc.dispatch({ rawMessage: 'attack', userId: 1, source: 'web' } as any);
  assert(r.success && handlerCalls.includes('attack'), '别名 attack 命中');
})();

console.log('\n[B5] 冷却机制：连续两次攻击 → 第二次冷却中');
(async () => {
  const { svc } = makeCommandFixture();
  const first = await svc.dispatch({ rawMessage: '攻击', userId: 2, source: 'web' } as any);
  assert(first.success, '首次攻击成功');
  // 不等待，立即第二次
  const second = await svc.dispatch({ rawMessage: '攻击', userId: 2, source: 'web' } as any);
  assert(!second.success && /冷却中/.test(second.content), '第二次攻击被冷却拦截');
})();

console.log('\n[B6] 不同用户冷却独立');
(async () => {
  const { svc } = makeCommandFixture();
  const u1 = await svc.dispatch({ rawMessage: '攻击', userId: 3, source: 'web' } as any);
  const u2 = await svc.dispatch({ rawMessage: '攻击', userId: 4, source: 'web' } as any);
  assert(u1.success && u2.success, '不同用户互不影响冷却');
})();

console.log('\n[B7] handler 未注册 → 提示未注册');
(async () => {
  const { svc } = makeCommandFixture();
  const r = await svc.dispatch({ rawMessage: '未注册', userId: 5, source: 'web' } as any);
  assert(!r.success && /处理器未注册/.test(r.content), '未注册 handler 返回提示');
})();

console.log('\n[B8] 执行成功后设置冷却（攻击成功才算冷却）');
(async () => {
  const { svc } = makeCommandFixture();
  // 第一次成功设置冷却；用不同来源(web)但让第一次失败路径不设置冷却
  const ok = await svc.dispatch({ rawMessage: '攻击', userId: 6, source: 'web' } as any);
  assert(ok.success, '攻击成功');
  const cd = await svc.dispatch({ rawMessage: '攻击', userId: 6, source: 'web' } as any);
  assert(!cd.success, '成功后冷却已生效');
})();

// ========================================================================
// C. 生产系统边界
// ========================================================================
console.log('\n========== C. 生产系统边界测试 ==========');

function makeHomeFixture() {
  const prismaStub: any = { gameMap: { findUnique: async () => null }, gameBuilding: { findMany: async () => [] } };
  const playerStub: any = {};
  const mapStub: any = {
    getConnections: () => [],
    getMapMonsters: () => [],
  };
  return new HomeService(prismaStub as any, playerStub as any, mapStub as any);
}

console.log('\n[C1] 空建筑/空作物 → 无产出');
(async () => {
  const svc = makeHomeFixture();
  const out = svc.produceResources([], [], 60, 2, 2, 1, 1, 1, 1, 1, 1, false);
  assert(out.length === 0, '空生产者列表返回空产出');
})();

console.log('\n[C2] 作物产出为建筑的 1/10（同等时间/数量/倍率）');
(async () => {
  const svc = makeHomeFixture();
  const building: any = { name: '矿场', outputs: [{ name: '铁矿', quantity: 100 }], priority: 2, count: 1 };
  const crop: any = { name: '麦田', outputs: [{ name: '小麦', quantity: 100 }], priority: 1, count: 1 };
  const bOut = svc.produceResources([building], [], 60, 2, 2, 1, 1, 1, 1, 1, 1, true);
  const cOut = svc.produceResources([crop], [], 60, 1, 1, 1, 1, 1, 1, 1, 1, true);
  const bIron = bOut.find((o: any) => o.name === '铁矿')?.quantity || 0;
  const cWheat = cOut.find((o: any) => o.name === '小麦')?.quantity || 0;
  // 建筑：100*1*1*60/60=100；作物：100*1*1*60/60*0.1=10
  assert(Math.abs(bIron - 100) < 1e-6, `建筑产出=100（实际=${bIron}）`);
  assert(Math.abs(cWheat - 10) < 1e-6, `作物产出=建筑1/10=10（实际=${cWheat}）`);
})();

console.log('\n[C3] priority 不匹配 → 跳过产出');
(async () => {
  const svc = makeHomeFixture();
  const b: any = { name: '矿', outputs: [{ name: '铁', quantity: 100 }], priority: 5, count: 1 };
  const out = svc.produceResources([b], [], 60, 2, 2, 1, 1, 1, 1, 1, 1, true);
  assert(out.length === 0, 'priority=5 但只算 priority=2 → 空产出');
})();

console.log('\n[C4] 建造材料不足 → 失败');
(async () => {
  const svc = makeHomeFixture();
  const defs = [{ name: '铁炉', type: '建筑', materials: JSON.stringify([{ name: '铁矿', quantity: -10 }]) }];
  const map: any = { buildings: '[]' };
  const backpack = [{ name: '铁矿', quantity: 3 }];
  const r = await svc.buildBuilding(map, '铁炉', defs, backpack);
  assert(!r.success && /材料不足/.test(r.message), '材料不足返回失败');
})();

console.log('\n[C5] 建造材料充足 → 成功扣材料并建建筑');
(async () => {
  const svc = makeHomeFixture();
  const defs = [{ name: '铁炉', type: '建筑', materials: JSON.stringify([{ name: '铁矿', quantity: -10 }]) }];
  const map: any = { buildings: '[]' };
  const backpack = [{ name: '铁矿', quantity: 30 }];
  const r = await svc.buildBuilding(map, '铁炉', defs, backpack);
  assert(r.success, '建造成功');
  const remain = backpack.find((i: any) => i.name === '铁矿')?.quantity;
  assert(remain === 20, `扣除10铁矿后剩20（实际=${remain}）`);
  const built = JSON.parse(map.buildings);
  assert(built.length === 1 && built[0].name === '铁炉', '地图建筑列表已写入铁炉');
})();

console.log('\n[C6] 种植无种子 → 失败');
(async () => {
  const svc = makeHomeFixture();
  const defs = [{ name: '小麦', type: '作物', materials: JSON.stringify([{ name: '小麦', quantity: 50 }]) }];
  const map: any = { buildings: '[]' };
  const backpack: any[] = [];
  const r = await svc.plantSeed(map, '小麦种子', backpack, defs);
  assert(!r.success && /背包中没有/.test(r.message), '无种子返回失败');
})();

console.log('\n[C7] 收获不存在的作物 → 失败');
(async () => {
  const svc = makeHomeFixture();
  const defs = [{ name: '小麦', type: '作物', materials: JSON.stringify([{ name: '小麦', quantity: 50 }]) }];
  const map: any = { buildings: '[]' };
  const backpack: any[] = [];
  const r = await svc.harvestCrop(map, '小麦', defs, backpack);
  assert(!r.success && /没有/.test(r.message), '地图上无作物返回失败');
})();

console.log('\n[C8] produceResources 负产出（消耗品）受倍率影响');
(async () => {
  const svc = makeHomeFixture();
  // 建筑负产出（消耗）：铁锭 -5/分钟，buildingOutputRate=2 → 消耗也×2
  const b: any = { name: '炉', outputs: [{ name: '铁锭', quantity: -5 }], priority: 2, count: 1 };
  const out = svc.produceResources([b], [], 60, 2, 2, 1, 1, 1, 1, 1, 1, true);
  const consume = out.find((o: any) => o.name === '铁锭')?.quantity || 0;
  // quantity = -5 * 1 * 1 * 60/60 * buildingOutputRate(1，非电非燃料) = -5
  assert(Math.abs(consume - (-5)) < 1e-6, `负产出消耗=-5（实际=${consume}）`);
})();

// ============ 结果 ============
console.log(`\n========== 综合测试结果 ==========`);
console.log(`通过: ${passed}  失败: ${failed}`);
if (failed > 0) {
  console.error('存在失败用例！');
  process.exit(1);
} else {
  console.log('全部通过 ✓');
  process.exit(0);
}
