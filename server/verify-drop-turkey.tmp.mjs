/**
 * 一次性脚本：火鸡（草原 mapId=10）击杀 → 掉落 → 入包 链路验证。
 * 火鸡有完整掉落表（钻石×8 100%、普通战利品×0.5 100%、生肉 50/20/5% 等），
 * 用于验证「有掉落表的怪」整条链路；野怪（无掉落表）走 30% 怪物材料 兜底分支，另行核对。
 * 运行后删除。
 */
const BASE = 'http://localhost:13443/api';
const { PrismaClient } = await import('@prisma/client');
const fs = await import('node:fs');
const p = new PrismaClient();

async function post(path, body, token) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
  return r.json();
}
async function cmd(command, token) {
  const res = await post('/commands/execute', { command }, token);
  return (res.content && String(res.content)) || JSON.stringify(res);
}
const short = (s, n = 300) => String(s).replace(/\n/g, ' | ').slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function bpMap(bp) {
  const arr = Array.isArray(bp) ? bp : [];
  const m = {};
  for (const it of arr) {
    if (!it?.name) continue;
    const key = it.type === '装备' ? `[装备]${it.name}` : it.name;
    m[key] = num(m[key]) + num(it.count ?? it.quantity ?? 1);
  }
  return m;
}

(async () => {
  const user = await p.user.findUnique({ where: { username: '路人甲' }, select: { id: true, role: true } });
  if (!user) { console.log('未找到用户 路人甲'); process.exit(1); }
  const uid = user.id;

  // 0. 基线快照（含备份文件，便于事后还原）
  const row0 = await p.player.findUnique({ where: { userId: uid } });
  fs.writeFileSync('verify-drop-baseline.tmp.json', JSON.stringify(row0, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  const base = {
    level: row0.level, exp: num(row0.exp), diamonds: num(row0.diamonds),
    vitality: num(row0.vitality), hp: num(row0.hp), maxHp: num(row0.maxHp),
    mapId: row0.mapId, backpack: bpMap(row0.backpack),
  };
  console.log('[基线]', `Lv=${base.level} exp=${base.exp} 钻石=${base.diamonds} 活力=${base.vitality.toFixed(2)} hp=${base.hp}/${base.maxHp} mapId=${base.mapId}`);
  console.log('[基线背包]', JSON.stringify(base.backpack));

  // 1. 登录
  const login = await post('/auth/dev/login', { username: '路人甲' });
  const token = login.data?.access_token;
  if (!token) { console.log('登录失败', JSON.stringify(login).slice(0, 200)); process.exit(1); }

  // 2. 保证草原(mapId=10)上有 3 只火鸡（克隆现有行，避免随机模板刷出别的怪）
  let src = await p.gameMonster.findFirst({ where: { name: '火鸡', isTemp: false } });
  if (!src) {
    // 没有火鸡实例：清掉 map10 常驻怪触发重生，最多等 3 轮
    for (let i = 0; i < 3 && !src; i++) {
      await p.gameMonster.deleteMany({ where: { mapId: 10, isTemp: false } });
      await sleep(15000);
      src = await p.gameMonster.findFirst({ where: { name: '火鸡', isTemp: false } });
    }
  }
  if (!src) { console.log('未能取得火鸡模板实例，终止'); await p.$disconnect(); process.exit(1); }
  const srcBonus = typeof src.bonus === 'string' ? JSON.parse(src.bonus) : src.bonus;
  console.log(`[模板火鸡] id=${src.id} mapId=${src.mapId} hp=${src.hp} 掉落表=${Array.isArray(srcBonus?.drops) ? srcBonus.drops.length + '项' : '无'}`);

  await p.gameMonster.deleteMany({ where: { mapId: 10, isTemp: false } });
  const { id: _id, createdAt: _c, updatedAt: _u, ...tpl } = src;
  for (let i = 0; i < 3; i++) {
    await p.gameMonster.create({ data: { ...tpl, mapId: 10, qq: `turkey_${i}_${Date.now()}`, isTemp: false, hp: src.maxHp } });
  }
  const spawned = await p.gameMonster.findMany({ where: { mapId: 10 }, select: { id: true, name: true, hp: true } });
  console.log('[草原已布置]', JSON.stringify(spawned));

  // 3. 传送 + 临时拉高血量（仅测试脚手架，结束还原）
  console.log('[传送]', short(await cmd('gm 修改玩家 路人甲 mapId 10', token), 60));
  console.log('[临时血量]', short(await cmd('gm 修改玩家 路人甲 maxHp 99999', token), 40), short(await cmd('gm 修改玩家 路人甲 hp 99999', token), 40));

  // 4. 连杀 3 只火鸡
  let kills = 0;
  const killLogs = [];
  for (let round = 1; round <= 3; round++) {
    let ok = false;
    for (let hit = 1; hit <= 20; hit++) {
      await sleep(5500);
      const out = await cmd('攻击', token);
      if (/击杀|被打死|倒下|死亡|死亡了/.test(out)) {
        kills++;
        killLogs.push(out);
        console.log(`[击杀#${kills}]`, short(out, 320));
        ok = true;
        break;
      }
      if (/附近没有|没有怪物|没有目标/.test(out)) { console.log('[无怪]', short(out, 120)); break; }
      if (/冷却/.test(out) || /冷却中/.test(out)) { continue; }
    }
    if (!ok) break;
    await sleep(2500); // 等 writeThrough 落库
    const mid = await p.player.findUnique({ where: { userId: uid }, select: { diamonds: true, exp: true, vitality: true } });
    console.log(`  └ 落库后: 钻石=${mid.diamonds} exp=${mid.exp} 活力=${Number(mid.vitality).toFixed(2)}`);
  }

  // 5. 终态核对
  await sleep(2000);
  const rowF = await p.player.findUnique({ where: { userId: uid } });
  const fin = {
    level: rowF.level, exp: num(rowF.exp), diamonds: num(rowF.diamonds),
    vitality: num(rowF.vitality), backpack: bpMap(rowF.backpack),
  };
  console.log('[终态]', `Lv=${fin.level} exp=${fin.exp} 钻石=${fin.diamonds} 活力=${fin.vitality.toFixed(2)}`);
  console.log('[终态背包]', JSON.stringify(fin.backpack));

  const delta = { ...fin.backpack };
  for (const k of Object.keys(base.backpack)) delta[k] = num(delta[k]) - num(base.backpack[k]);
  console.log('[背包增量]', JSON.stringify(delta));
  console.log('[数值增量]', JSON.stringify({
    'Δexp': fin.exp - base.exp,
    'Δ钻石': fin.diamonds - base.diamonds,
    'Δ活力': Number((fin.vitality - base.vitality).toFixed(3)),
  }));

  // 6. 期望校验（火鸡掉落表：钻石8/100%、普通战利品0.5/100%，其余按几率）
  const expDiamondPerKill = 8;          // 100% 必掉（活力倍率=1 时）
  const expectedDiamond = kills * expDiamondPerKill;
  const gotDiamond = fin.diamonds - base.diamonds;
  const gotLoot = num(delta['普通战利品']);
  const pass = kills >= 1 && gotDiamond >= expectedDiamond && gotLoot >= 0.5 * kills;
  console.log('[判定]', pass ? '✅ 通过' : '❌ 失败',
    `(击杀${kills}只，Δ钻石=${gotDiamond} 期望≥${expectedDiamond}，Δ普通战利品=${gotLoot} 期望≥${0.5 * kills})`);

  // 7. 还原：血量 / 地图 / 清掉克隆怪
  console.log('[还原血量]', short(await cmd(`gm 修改玩家 路人甲 maxHp ${base.maxHp}`, token), 40), short(await cmd(`gm 修改玩家 路人甲 hp ${base.hp}`, token), 40));
  console.log('[还原地图]', short(await cmd(`gm 修改玩家 路人甲 mapId ${base.mapId}`, token), 40));
  await p.gameMonster.deleteMany({ where: { mapId: 10, qq: { startsWith: 'turkey_' } } });
  const left = await p.gameMonster.count({ where: { mapId: 10 } });
  console.log('[清理克隆] 草原剩余怪物行数=', left, '（0 表示等下一次重生自动补齐）');

  await p.$disconnect();
})().catch(async (e) => { console.error('脚本异常', e); await p.$disconnect(); });
