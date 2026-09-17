/**
 * 一次性诊断（只读）：打印测试库地图/怪物/载具条目的「键名清单」，用于核对字段规范收敛结果。
 */
const { PrismaClient } = require('../server/node_modules/@prisma/client');
require('../server/node_modules/dotenv').config({ path: 'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/.env' });
const prisma = new PrismaClient();

const asArr = (v) => (Array.isArray(v) ? v : (typeof v === 'string' ? (() => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } })() : []));
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).join(',') : String(o));

(async () => {
  const maps = await prisma.gameMap.findMany({ take: 3, orderBy: { id: 'asc' } });
  for (const m of maps) {
    console.log(`--- map#${m.id} ${m.name}`);
    for (const c of ['items', 'resources', 'resources2', 'buildings', 'vehicles', 'summons', 'markers2']) {
      const arr = asArr(m[c]);
      if (!arr.length) continue;
      console.log(`  ${c}[0] (共${arr.length}): ${keys(arr[0])}`);
    }
  }
  const mon = await prisma.gameMonster.findFirst({ where: { markers2: { not: null } }, orderBy: { id: 'asc' } });
  if (mon) console.log(`--- monster#${mon.id}: markers2[0]=${keys(asArr(mon.markers2)[0])} buffs[0]=${keys(asArr(mon.buffs)[0])} equipments[0]=${keys(asArr(mon.equipments)[0])}`);
  const veh = await prisma.gameVehicle.findFirst();
  if (veh) console.log(`--- vehicle#${veh.id}: parts[0]=${keys(asArr(veh.parts)[0])} markers2[0]=${keys(asArr(veh.markers2)[0])}`);
  const pl = await prisma.player.findFirst({ orderBy: { userId: 'asc' } });
  if (pl) console.log(`--- player#${pl.userId}: markers2[0]=${keys(asArr(pl.markers2)[0])} buffs[0]=${keys(asArr(pl.buffs)[0])} equipment[0]=${keys(asArr(pl.equipment)[0])} weapons[0]=${keys(asArr(pl.weapons)[0])} equipmentPresets[0]=${keys(asArr(pl.equipmentPresets)[0])}`);
  await prisma.$disconnect();
})();