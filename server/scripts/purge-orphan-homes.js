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
