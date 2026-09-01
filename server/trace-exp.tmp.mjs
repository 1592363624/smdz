/**
 * 细致追踪 exp 变化：每杀后立即读 DB，观察逐杀 exp 走势。
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
const short = (s, n = 160) => String(s).replace(/\\n/g, ' | ').slice(0, n);

(async () => {
  const user = await p.user.findUnique({ where: { username: '路人甲' }, select: { id: true, role: true } });
  await p.user.update({ where: { id: user.id }, data: { role: 'SUPER_ADMIN' } });
  const login = await post('/auth/dev/login', { username: '路人甲' });
  const token = login.data?.access_token;
  if (!token) process.exit(1);
  const uid = user.id;

  // 重置为干净基线
  await p.player.updateMany({ where: { userId: uid }, data: { exp: 0, level: 1, diamonds: 0, backpack: [], markers: {} } });
  console.log('[基线]', (await p.player.findUnique({ where: { userId: uid }, select: { exp: true, level: true } })).exp);

  // 传送
  await cmd('gm 修改玩家 路人甲 mapId 3', token);
  await new Promise(r => setTimeout(r, 1000));

  // 逐杀并记录 DB exp
  for (let k = 1; k <= 5; k++) {
    let killed = false;
    for (let h = 1; h <= 8; h++) {
      await new Promise(r => setTimeout(r, 5500));
      const out = await cmd('攻击', token);
      if (/击杀|被打死|倒下|死亡/.test(out)) { killed = true; console.log(`[击杀#${k}]`, short(out, 80)); break; }
      if (/附近没有|没有怪物|没有目标/.test(out)) { console.log('[无怪]'); break; }
      if (/冷却/.test(out)) continue;
    }
    if (!killed) continue;
    // 等 writeThrough 落库
    await new Promise(r => setTimeout(r, 2500));
    const row = await p.player.findUnique({ where: { userId: uid }, select: { exp: true, level: true } });
    console.log(`  DB后: exp=${row.exp} level=${row.level}`);
  }

  console.log('[最终]', (await p.player.findUnique({ where: { userId: uid }, select: { exp: true, level: true } })).exp);
  await p.user.update({ where: { id: uid }, data: { role: user.role } });
  await p.$disconnect();
})();
