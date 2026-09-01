/**
 * 野怪掉落链路验证 v2（修复旧快照覆盖后重跑）。
 * 流程：DB 基线 → 传送地图8 → 连杀史莱姆5只 → 查 DB 核对 exp/钻石/掉落。
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
const short = (s, n = 200) => String(s).replace(/\\n/g, ' | ').slice(0, n);

(async () => {
  const user = await p.user.findUnique({ where: { username: '路人甲' }, select: { id: true, role: true } });
  await p.user.update({ where: { id: user.id }, data: { role: 'SUPER_ADMIN' } });
  const login = await post('/auth/dev/login', { username: '路人甲' });
  const token = login.data?.access_token;
  if (!token) process.exit(1);
  const uid = user.id;

  // 0. 重置玩家为初始状态（干净基线）
  await p.player.updateMany({ where: { userId: uid }, data: { exp: 0, level: 1, diamonds: 0, tickets: 0, dataCores: 0, backpack: [], markers: {} } });
  const row0 = await p.player.findUnique({ where: { userId: uid }, select: { exp: true, level: true, diamonds: true, backpack: true } });
  console.log('[基线]', `Lv=${row0.level} exp=${row0.exp} diamonds=${row0.diamonds} bp=${JSON.stringify(row0.backpack).slice(0, 120)}`);

  // 1. 传送到地图3（史莱姆区）
  console.log('[传送]', short(await cmd('gm 修改玩家 路人甲 mapId 3', token), 60));

  // 2. 连杀 5 只史莱姆
  let kills = 0;
  for (let round = 1; round <= 5; round++) {
    let killed = false;
    for (let hit = 1; hit <= 8; hit++) {
      await new Promise((r) => setTimeout(r, 5500));
      const out = await cmd('攻击', token);
      if (/击杀|被打死|倒下|死亡/.test(out)) { kills++; console.log(`[击杀#${kills}]`, short(out, 100)); killed = true; break; }
      if (/附近没有|没有怪物|没有目标/.test(out)) { console.log('[无怪]'); break; }
      if (/冷却/.test(out)) continue;
    }
    if (!killed) continue;
    // 等 writeThrough 落库
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`[共击杀] ${kills} 只`);

  // 3. 最终核对
  const rowFinal = await p.player.findUnique({ where: { userId: uid }, select: { exp: true, level: true, diamonds: true, backpack: true } });
  console.log('[终态]', `Lv=${rowFinal.level} exp=${rowFinal.exp} diamonds=${rowFinal.diamonds}`);
  const bp = Array.isArray(rowFinal.backpack) ? rowFinal.backpack : [];
  for (const n of ['钻石', '生肉', '普通战利品']) {
    const items = bp.filter((i) => i?.name === n);
    console.log(`  ${n}:`, JSON.stringify(items));
  }
  // 预期：exp≥100, diamonds≥8, 至少有一只生肉/普通战利品
  const ok = rowFinal.exp >= 100 && rowFinal.diamonds >= 8;
  console.log('[链路验证]', ok ? '✅ 通过' : '❌ 失败', `(exp=${rowFinal.exp}≥100, diamonds=${rowFinal.diamonds}≥8)`);

  await p.user.update({ where: { id: uid }, data: { role: user.role } });
  console.log('已恢复角色');
  await p.$disconnect();
})();
