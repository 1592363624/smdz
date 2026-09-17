/**
 * 打印地图载具/召唤物条目原文（一次性诊断，用于确认中英键的对应关系）
 */
const { PrismaClient } = require('../server/node_modules/@prisma/client');
require('../server/node_modules/dotenv').config({ path: 'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/.env' });
const prisma = new PrismaClient();
(async () => {
  const maps = await prisma.gameMap.findMany();
  let shown = 0;
  for (const m of maps) {
    for (const v of (m.vehicles || [])) {
      if (shown++ >= 1) break;
      console.log('=== 地图载具条目全文 ===');
      console.log(JSON.stringify(v, null, 1));
    }
  }
  shown = 0;
  for (const m of maps) {
    for (const s of (m.summons || [])) {
      if (s && s.当前生命 !== undefined && shown++ < 1) {
        console.log('\n=== 召唤物条目（含中文键）===');
        const { backpack, weapons, equipment, buffs, markers, markers2, ...rest } = s;
        console.log(JSON.stringify(rest, null, 1));
      }
    }
  }
  const veh = await prisma.gameVehicle.findFirst();
  if (veh) {
    console.log('\n=== GameVehicle 行 ===');
    console.log(JSON.stringify({ ...veh, parts: (veh.parts || []).slice(0, 1), builtinParts: (veh.builtinParts || []).slice(0, 1), bonus: veh.bonus, markers: veh.markers, markers2: (veh.markers2 || []).slice(0, 2) }, null, 1).slice(0, 2500));
  }
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); });