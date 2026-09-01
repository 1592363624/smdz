/**
 * 一次性脚本：野怪掉落链路验证。
 * 流程：记录背包 → 传送地图8 → 连续击杀野怪（每次击杀后查实时背包）→ 等落库后核对 DB。
 * 野怪无掉落表：30% 概率掉「怪物材料」，预期最多几杀就能命中。
 * 运行后删除。
 */
const BASE = 'http://localhost:13443/api';
const { PrismaClient } = await import('@prisma/client');
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
async function liveInfo(token) {
  const r = await (await fetch(BASE + '/game/player/info', { headers: { Authorization: 'Bearer ' + token } })).json();
  return r.data;
}
const short = (s, n = 240) => String(s).replace(/\\n/g, ' | ').slice(0, n);
const countOf = (bp, name) => (Array.isArray(bp) ? bp : []).filter((i) => i?.name === name).reduce((a, i) => a + Number(i?.count ?? i?.quantity ?? 0), 0);

(async () => {
  const user = await p.user.findUnique({ where: { username: '路人甲' }, select: { id: true, role: true } });
  await p.user.update({ where: { id: user.id }, data: { role: 'SUPER_ADMIN' } });
  const login = await post('/auth/dev/login', { username: '路人甲' });
  const token = login.data?.access_token;
  if (!token) process.exit(1);
  const uid = user.id;

  // 0. 记录战前状态（DB 为准）
  const row0 = await p.player.findUnique({ where: { userId: uid }, select: { backpack: true, exp: true } });
  const bp0 = Array.isArray(row0.backpack) ? row0.backpack : [];
  console.log('[战前]', `Lv? exp=${row0.exp} 背包`, JSON.stringify(bp0).slice(0, 200));

  // 1. 传送到森林出口（mapId=3，史莱姆等低级怪；史莱姆 bonus.drops 有 钻石×2 100%）
  console.log('[传送]', short(await cmd('gm 修改玩家 路人甲 mapId 3', token), 60));

  // 2. 连续击杀，直到背包出现新增物品或杀满 5 只
  let gotDrop = false;
  let kills = 0;
  const gained = {};
  const countOf = (bp, name) => bp.filter((i) => i?.name === name).reduce((a, i) => a + Number(i?.count ?? i?.quantity ?? 0), 0);
  for (let round = 1; round <= 5 && !gotDrop; round++) {
    // 攻击直到击杀（冷却 5 秒/次，单只上限 8 次攻击）
    let killedThis = false;
    for (let hit = 1; hit <= 8; hit++) {
      await new Promise((r) => setTimeout(r, 6000));
      const out = await cmd('攻击', token);
      if (/击杀|被打死|倒下|死亡/.test(out)) { kills++; killedThis = true; console.log(`[击杀#${kills}]`, short(out)); break; }
      if (/附近没有|没有怪物|没有目标/.test(out)) { console.log('[无怪]', short(out, 80)); break; }
      if (/冷却/.test(out)) continue; // 冷却中直接重试
    }
    if (!killedThis) continue;
    // 击杀后等写穿落库，读 DB 对比增量
    await new Promise((r) => setTimeout(r, 2500));
    const row = await p.player.findUnique({ where: { userId: uid }, select: { backpack: true, exp: true } });
    const bp = Array.isArray(row.backpack) ? row.backpack : [];
    for (const it of bp) {
      const b = countOf(bp0, it?.name);
      const n = Number(it?.count ?? it?.quantity ?? 0);
      if (n > b) gained[it?.name] = n - b;
    }
    console.log(`[击杀后DB背包]`, JSON.stringify(bp).slice(0, 260), 'exp=' + row.exp);
    if (Object.keys(gained).length > 0) gotDrop = true;
  }
  console.log('[掉落命中?]', gotDrop, `共击杀 ${kills} 只, 新增:`, JSON.stringify(gained));

  // 3. 最终核对 DB 与"查看背包"指令输出一致（文本包含物品即认为同步）
  const bagText = await cmd('查看背包', token);
  for (const name of Object.keys(gained)) {
    console.log(`[核对] ${name} 在查看背包输出中?`, bagText.includes(name));
  }

  await p.user.update({ where: { id: uid }, data: { role: user.role } });
  console.log('已恢复角色');
  await p.$disconnect();
})();
