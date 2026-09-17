/**
 * 核对：DB 地图行 JSON 与静态 maps.json 的键名差异（一次性诊断）
 */
const { PrismaClient } = require('../server/node_modules/@prisma/client');
require('../server/node_modules/dotenv').config({ path: 'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/.env' });
const prisma = new PrismaClient();

(async () => {
  const maps = await prisma.gameMap.findMany({ take: 3, orderBy: { id: 'asc' } });
  for (const m of maps) {
    console.log(`\n===== GameMap id=${m.id} name=${m.name} =====`);
    for (const col of ['items', 'buildings', 'vehicles', 'summons', 'resources', 'monsters', 'markers2']) {
      const v = m[col];
      if (Array.isArray(v) && v.length) {
        console.log(`  [${col}] len=${v.length} 首条=`, JSON.stringify(v[0]).slice(0, 300));
      } else if (v) {
        console.log(`  [${col}] =`, JSON.stringify(v).slice(0, 200));
      }
    }
  }
  const staticMaps = JSON.parse(require('fs').readFileSync('d:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/prisma/data/maps.json', 'utf8'));
  console.log('\n===== 静态 maps.json 取样 =====');
  const arr = Array.isArray(staticMaps) ? staticMaps : Object.values(staticMaps);
  console.log('条目数', arr.length);
  const m0 = arr[0];
  console.log('顶层键:', Object.keys(m0).join(','));
  for (const col of ['items', 'buildings', 'vehicles', 'summons', 'resources', 'monsters', 'markers2']) {
    const v = m0[col];
    if (Array.isArray(v) && v.length) console.log(`  [${col}] 首条=`, JSON.stringify(v[0]).slice(0, 300));
    else if (v) console.log(`  [${col}] =`, JSON.stringify(v).slice(0, 200));
  }
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); });