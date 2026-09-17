/**
 * 核实：地图 items/summons 里的 count 字段语义（一次性诊断）
 */
const { PrismaClient } = require('../server/node_modules/@prisma/client');
require('../server/node_modules/dotenv').config({ path: 'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/.env' });
const prisma = new PrismaClient({ datasources: { db: { url: 'mysql://smdztest:smdztest@52shell.ltd:3306/smdztest?charset=utf8mb4&connection_limit=5' } } });
(async () => {
  const maps = await prisma.gameMap.findMany();
  console.log('=== 地图 items 中含 count 的条目全文 ===');
  for (const m of maps) {
    for (const it of (m.items || [])) {
      if (it && it.count !== undefined) console.log(`地图${m.id}(${m.name}):`, JSON.stringify(it));
    }
  }
  console.log('\n=== 地图 summons 中含 count 的条目（截断展示） ===');
  for (const m of maps) {
    for (const s of (m.summons || [])) {
      if (s && s.count !== undefined) {
        const { backpack, weapons, equipment, markers, markers2, buffs, set, bonus, baseBonus, extraBonus, ...rest } = s;
        console.log(`地图${m.id}(${m.name}) 主体:`, JSON.stringify(rest).slice(0, 400));
      }
    }
  }
  console.log('\n=== 地图 vehicles 中含 count/数量 的零件条目 ===');
  for (const m of maps) {
    for (const v of (m.vehicles || [])) {
      for (const p of (v.parts || [])) {
        if (p && (p.count !== undefined || p.数量 !== undefined)) console.log(`地图${m.id} 载具${v.name}:`, JSON.stringify(p));
      }
    }
  }
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); });