/**
 * 一次性脚本：野怪（无掉落表，mapId=12 居民区）击杀 → 掉落 验证。
 * 对照火鸡（有掉落表）用例，观察无掉落表走 generateDrops 兜底分支（30% 怪物材料）的实际行为。
 * 运行后删除。
 */
const BASE = 'http://localhost:13443/api';
const { PrismaClient } = await import('@prisma/client');
const p = new PrismaClient();

async function post(path, body, token) {
  return (await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  })).json();
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
  const user = await p.user.findUnique({ where: { username: '路人甲' }, select: { id: true } });
  const uid = user.id;
  const login = await post('/auth/dev/login', { username: '路人甲' });
  const token = login.data?.access_token;
  if (!token) { console.log('登录失败'); process.exit(1); }

  const row0 = await p.player.findUnique({ where: { userId: uid } });
  const base = { mapId: row0.mapId, hp: num(row0.hp), maxHp: num(row0.maxHp), backpack: bpMap(row0.backpack) };
  console.log('[基线] mapId=', base.mapId, 'hp=', base.hp, '/', base.maxHp);
  console.log('[基线背包]', JSON.stringify(base.backpack));

  // 居民区(12) 现存 3 只野怪
  const wild = await p.gameMonster.findMany({ where: { mapId: 12 }, select: { id: true, name: true, hp: true, level: true } });
  console.log('[居民区怪物]', JSON.stringify(wild));

  console.log('[传送]', short(await cmd('gm 修改玩家 路人甲 mapId 12', token), 60));
  console.log('[临时血量]', short(await cmd('gm 修改玩家 路人甲 maxHp 99999', token), 40), short(await cmd('gm 修改玩家 路人甲 hp 99999', token), 40));

  let kills = 0;
  for (let round = 1; round <= 3; round++) {
    let ok = false;
    for (let hit = 1; hit <= 12; hit++) {
      await sleep(5500);
      const out = await cmd('攻击', token);
      if (/击杀|被打死|倒下|死亡/.test(out)) { kills++; console.log(`[击杀#${kills}]`, short(out, 300)); ok = true; break; }
      if (/附近没有|没有怪物|没有目标/.test(out)) { console.log('[无怪]', short(out, 120)); break; }
    }
    if (!ok) break;
    await sleep(2000);
  }

  const rowF = await p.player.findUnique({ where: { userId: uid } });
  const fin = bpMap(rowF.backpack);
  const delta = { ...fin };
  for (const k of Object.keys(base.backpack)) delta[k] = num(delta[k]) - num(base.backpack[k]);
  console.log('[终态背包]', JSON.stringify(fin));
  console.log('[背包增量]', JSON.stringify(delta));
  console.log('[是否出现怪物材料]', '怪物材料' in delta ? `是 (+${delta['怪物材料']})` : '否（3杀均未命中 30% 兜底）');

  console.log('[还原]', short(await cmd(`gm 修改玩家 路人甲 maxHp ${base.maxHp}`, token), 40), short(await cmd(`gm 修改玩家 路人甲 hp ${base.hp}`, token), 40));
  await p.$disconnect();
})().catch(async (e) => { console.error('脚本异常', e); await p.$disconnect(); });
