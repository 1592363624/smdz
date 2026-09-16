import { PrismaClient } from '@prisma/client';

const url =
  'mysql://smdztest:smdztest@52shell.ltd:3306/smdztest?charset=utf8mb4&connection_limit=100';

function parseVehicles(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) || []; } catch { return []; }
  }
  return [];
}

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const map = await prisma.gameMap.findUnique({ where: { id: 52 } });
    const vehicles = parseVehicles(map.vehicles);
    const sealed = vehicles.filter((v) => v?.封印中 === true || v?.sealed === true || v?.归属 === '无主' || v?.owner === '无主');
    console.log('地图载具数:', vehicles.length);
    for (const v of vehicles) {
      console.log({
        名称: v.名称, 编号: v.编号, 归属: v.归属 ?? v.owner,
        封印中: v.封印中 ?? v.sealed,
        需求等级: v.需求等级 ?? v.requireLevel,
        守卫波数: v.守卫波数 ?? v.guardWaves,
        当前守卫波: v.当前守卫波 ?? v.sealWave,
        唤醒者: v.唤醒者 ?? v.sealWaker,
        献祭凭证: v.献祭凭证, 献祭活力: v.献祭活力,
      });
    }

    const monsters = await prisma.gameMonster.findMany({
      where: { mapId: 52, hp: { gt: 0 } },
      select: { id: true, name: true, qq: true, level: true, hp: true },
    });
    console.log('\n存活怪物:', monsters.length);
    for (const m of monsters) {
      console.log(`  #${m.id} ${m.name} lv${m.level} hp${m.hp} qq=${m.qq}`);
    }

    const player = await prisma.player.findUnique({ where: { userId: 4051 } });
    console.log('\n测试玩家 map=', player?.mapId, 'level=', player?.level, 'vitality=', player?.vitality);
    console.log('backpack=', JSON.stringify(player?.backpack)?.slice(0, 300));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
