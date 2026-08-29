const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const maps = await p.gameMap.findMany({
    select: { id: true, name: true, level: true, monsterCount: true, monsters: true },
    orderBy: { id: 'asc' },
    take: 15,
  });
  console.log('=== 前15张地图 ===');
  for (const m of maps) {
    console.log(m.id, m.name, '| lv', m.level, '| count', m.monsterCount, '| tpl', (m.monsters || '').slice(0, 70));
  }
  console.log('地图总数', await p.gameMap.count());

  const ids = maps.map((m) => m.id);
  const mons = await p.gameMonster.findMany({
    where: { mapId: { in: ids } },
    select: {
      id: true, mapId: true, name: true, level: true, hp: true, maxHp: true,
      shield: true, armor: true, attack: true, defense: true, dodge: true, hit: true, isTemp: true,
    },
    orderBy: { mapId: 'asc' },
    take: 60,
  });
  console.log('\n=== 这些地图上的怪物实例 ===');
  for (const m of mons) {
    console.log(
      `map${m.mapId} #${m.id} ${m.name} lv${m.level} HP${m.hp}/${m.maxHp} 盾${m.shield} 甲${m.armor} 攻${m.attack} 防${m.defense} 闪${m.dodge} 命${m.hit}${m.isTemp ? ' [临时]' : ''}`,
    );
  }
  await p.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
