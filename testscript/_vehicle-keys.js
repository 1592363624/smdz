/**
 * 载具存量数据键名核对（一次性诊断）
 * 目的：确认 DB GameVehicle 行 / 地图 vehicles 条目里实际出现的键名，
 *      判断收敛后哪些历史英文键（如 hp / 列表编号）真的还有存量数据。
 */
const { PrismaClient } = require('../server/node_modules/@prisma/client');
require('../server/node_modules/dotenv').config({ path: 'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/.env' });
const prisma = new PrismaClient();

(async () => {
  const vs = await prisma.gameVehicle.findMany({ take: 300 });
  const bag = new Map();
  for (const v of vs) for (const k of Object.keys(v)) bag.set(k, (bag.get(k) || 0) + 1);
  console.log(`GameVehicle 行数=${vs.length}`);
  console.log('行键:', [...bag.keys()].join(','));

  const maps = await prisma.gameMap.findMany({ take: 200 });
  const vb = new Map();
  const pb = new Map();
  let vehicleCount = 0;
  for (const m of maps) {
    const arr = Array.isArray(m.vehicles) ? m.vehicles : [];
    for (const v of arr) {
      vehicleCount++;
      for (const k of Object.keys(v || {})) vb.set(k, (vb.get(k) || 0) + 1);
      for (const p of (Array.isArray(v?.parts) ? v.parts : [])) for (const k of Object.keys(p || {})) pb.set(k, (pb.get(k) || 0) + 1);
    }
  }
  console.log(`\n地图载具条目数=${vehicleCount}`);
  console.log('条目键:', [...vb.entries()].map(([k, c]) => `${k}=${c}`).join('  '));
  console.log('零件键:', [...pb.entries()].map(([k, c]) => `${k}=${c}`).join('  '));

  // 配方条目键（DB 列 + 地图条目）
  const rb = new Map();
  const collect = (arr) => { for (const r of (Array.isArray(arr) ? arr : [])) for (const k of Object.keys(r || {})) rb.set(k, (rb.get(k) || 0) + 1); };
  for (const v of vs) collect(v.recipes);
  for (const m of maps) for (const v of (Array.isArray(m.vehicles) ? m.vehicles : [])) collect(v?.recipes);
  console.log('配方键:', [...rb.entries()].map(([k, c]) => `${k}=${c}`).join('  '));
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e.message); await prisma.$disconnect(); });