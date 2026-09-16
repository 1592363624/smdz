/**
 * 一次性/可重复执行：清理无主家园 GameMap + 宿主图上的幽灵开拓地连接。
 * 用法（在 server 目录）：
 *   node scripts/purge-orphan-homes.js
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function houseNames(houseName) {
  return [houseName, `${houseName}屋内`, `${houseName}前线`];
}

function parseConns(value) {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function main() {
  const players = await prisma.player.findMany({ select: { houseName: true } });
  const validNames = new Set();
  for (const p of players) {
    const name = String(p.houseName || '').trim();
    if (!name) continue;
    for (const n of houseNames(name)) validNames.add(n);
  }

  const allMaps = await prisma.gameMap.findMany({
    select: { id: true, name: true, isFrontier: true },
  });
  const orphanMaps = allMaps.filter((m) => {
    if (validNames.has(m.name)) return false;
    const name = m.name || '';
    return m.isFrontier === true || name.endsWith('屋内') || name.endsWith('前线');
  });

  if (orphanMaps.length > 0) {
    // 删幽灵家园图前把站在图上的玩家/载具迁到城镇广场（与服务端 removeHouseData 一致）
    const plaza =
      (await prisma.gameMap.findUnique({ where: { name: '城镇广场' } })) ||
      (await prisma.gameMap.findFirst({ orderBy: { mapIndex: 'asc' } }));
    if (plaza) {
      const orphanIds = orphanMaps.map((m) => m.id);
      const standing = await prisma.player.findMany({
        where: { mapId: { in: orphanIds } },
        select: { id: true, userId: true, markers: true, markers2: true },
      });
      for (const p of standing) {
        const markers = parseJson(p.markers, {}) || {};
        delete markers['移动中'];
        const markers2 = parseJson(p.markers2, []) || [];
        const kept2 = Array.isArray(markers2)
          ? markers2.filter((m) => String(m?.名称 ?? m?.name ?? '') !== '移动')
          : markers2;
        await prisma.player.update({
          where: { id: p.id },
          data: {
            mapId: plaza.id,
            location: plaza.name,
            markers,
            ...(Array.isArray(markers2) && kept2.length !== markers2.length ? { markers2: kept2 } : {}),
            version: { increment: 1 },
          },
        });
      }
      const vehicleUpdates = await prisma.gameVehicle.updateMany({
        where: { mapIndex: { in: orphanIds } },
        data: { mapIndex: plaza.id },
      }).catch(() => ({ count: 0 }));
      console.log(`清退孤儿家园：玩家 ${standing.length} 人、GameVehicle ${vehicleUpdates.count ?? 0} 台 → ${plaza.name}`);
    }
    await prisma.gameMap.deleteMany({ where: { id: { in: orphanMaps.map((m) => m.id) } } });
  }

  const liveMaps = await prisma.gameMap.findMany({
    select: { id: true, name: true, connections: true },
  });
  const aliveNames = new Set(liveMaps.map((m) => m.name));
  let removedConns = 0;
  for (const map of liveMaps) {
    const connections = parseConns(map.connections);
    const filtered = connections.filter((c) => {
      const name = String(c?.name || '');
      const isFrontier = c?.isFrontier === true || c?.开拓地 === true || c?.type === '开拓地';
      if (!isFrontier) return true;
      if (!name || !validNames.has(name)) return false;
      return aliveNames.has(name);
    });
    if (filtered.length === connections.length) continue;
    removedConns += connections.length - filtered.length;
    await prisma.gameMap.update({
      where: { id: map.id },
      data: { connections: filtered },
    });
  }

  console.log(JSON.stringify({
    activeHomes: [...validNames].filter((n) => !n.endsWith('屋内') && !n.endsWith('前线')),
    removedMaps: orphanMaps.length,
    removedMapNames: orphanMaps.map((m) => m.name).slice(0, 20),
    removedConnections: removedConns,
  }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
