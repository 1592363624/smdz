/**
 * 一次性脚本：连续两次击杀（带插桩日志的服务器）。
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

(async () => {
  const user = await p.user.findUnique({ where: { username: '路人甲' }, select: { id: true, role: true } });
  await p.user.update({ where: { id: user.id }, data: { role: 'SUPER_ADMIN' } });
  const login = await post('/auth/dev/login', { username: '路人甲' });
  const token = login.data?.access_token;
  const uid = user.id;

  const row0 = await p.player.findUnique({ where: { userId: uid }, select: { level: true, exp: true } });
  console.log(`[DB战前] level=${row0.level} exp=${row0.exp}`);

  console.log('[传送]', String(await cmd('gm 修改玩家 路人甲 mapId 3', token)).slice(0, 50));

  for (let k = 1; k <= 2; k++) {
    for (let hit = 1; hit <= 8; hit++) {
      await new Promise((r) => setTimeout(r, 6000));
      const out = await cmd('攻击', token);
      if (/击杀|被打死|倒下|死亡/.test(out)) {
        console.log(`[击杀#${k}]`, String(out).replace(/\\n/g, ' | ').slice(0, 200));
        break;
      }
      if (/附近没有|没有怪物|没有目标/.test(out)) { console.log('[无怪]', String(out).slice(0, 60)); break; }
    }
    await new Promise((r) => setTimeout(r, 3000));
    const row = await p.player.findUnique({ where: { userId: uid }, select: { level: true, exp: true } });
    console.log(`[DB击杀${k}后] level=${row.level} exp=${row.exp}`);
  }

  await p.user.update({ where: { id: uid }, data: { role: user.role } });
  await p.$disconnect();
})();
