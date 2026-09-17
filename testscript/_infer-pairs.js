/**
 * 用「值相等」推断中英键对应关系（一次性诊断）
 * 思路：同一条目里若中文键与英文键的值完全相同，则二者是同一语义的镜像写入。
 */
const { PrismaClient } = require('../server/node_modules/@prisma/client');
require('../server/node_modules/dotenv').config({ path: 'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/.env' });
const prisma = new PrismaClient();
const cn = (s) => /[\u4e00-\u9fa5]/.test(String(s));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function infer(obj, pairs) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (!cn(k)) continue;
    const v = obj[k];
    if (v && typeof v === 'object') continue;
    for (const ek of keys) {
      if (cn(ek)) continue;
      if (eq(v, obj[ek])) pairs.set(`${k} → ${ek}`, (pairs.get(`${k} → ${ek}`) || 0) + 1);
    }
  }
}

(async () => {
  const maps = await prisma.gameMap.findMany();
  const p1 = new Map();
  for (const m of maps) for (const v of (m.vehicles || [])) infer(v, p1);
  console.log('=== 地图载具条目：中文键 → 英文键（值相等推断） ===');
  console.log([...p1.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join('  '));

  const p2 = new Map();
  for (const m of maps) for (const s of (m.summons || [])) infer(s, p2);
  console.log('\n=== 地图召唤物条目 ===');
  console.log([...p2.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join('  '));

  const ms = await prisma.gameMonster.findMany();
  const p3 = new Map();
  for (const m of ms) { infer(m.markers2, p3); for (const b of (m.buffs || [])) infer(b, p3); }
  console.log('\n=== 怪物 markers2/buffs 条目 ===');
  console.log([...p3.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join('  '));

  const vs = await prisma.gameVehicle.findMany();
  const p4 = new Map();
  for (const v of vs) { infer(v.markers, p4); for (const b of (v.markers2 || [])) infer(b, p4); for (const pt of (v.parts || [])) infer(pt, p4); for (const pt of (v.builtinParts || [])) infer(pt, p4); }
  console.log('\n=== 载具行 markers/markers2/parts/builtinParts 条目 ===');
  console.log([...p4.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join('  '));

  const ps = await prisma.player.findMany();
  const p5 = new Map();
  for (const p of ps) {
    for (const it of (p.backpack || [])) infer(it, p5);
    for (const it of (p.equipment || [])) infer(it, p5);
    for (const it of (p.weapons || [])) infer(it, p5);
    for (const it of (p.safeBox || [])) infer(it, p5);
    for (const b of (p.buffs || [])) infer(b, p5);
    for (const b of (p.markers2 || [])) infer(b, p5);
    for (const pr of (p.equipmentPresets || [])) infer(pr, p5);
  }
  console.log('\n=== 玩家背包/装备/增益条目 ===');
  console.log([...p5.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join('  '));
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); });