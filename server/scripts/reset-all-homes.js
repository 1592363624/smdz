/**
 * 测试库家园系统归零：对所有玩家把家园进度/家园名/动态家园图/延时建造任务
 * 重置为「从未开始玩」的状态（等同清档后的家园维度，不动等级/背包/其他进度）。
 *
 * 用法（server 目录，确认 DATABASE_URL 指向测试库后再执行）：
 *   node scripts/reset-all-homes.js           # dry-run，只打印将改动的内容
 *   node scripts/reset-all-homes.js --apply   # 真正执行
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** 与 MapService.houseMapNames / removeHouseData 对齐 */
function houseNames(houseName) {
  return [houseName, `${houseName}屋内`, `${houseName}前线`];
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseConns(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

/** 家园相关永久标记（markers 对象键） */
const HOME_MARKER_KEYS = [
  '家园进度',
  '家园产出时间',
  '地基结算待发',
  '房子结算待发',
  '前线',
  '凭证',
];

/** 取起始图（优先「城镇广场」）：站在待删家园图上的玩家要挪到这里（与服务端 removeHouseData 一致，不丢医疗室） */
async function resolveStartMapId() {
  const startMap =
    (await prisma.gameMap.findUnique({ where: { name: '城镇广场' } })) ||
    (await prisma.gameMap.findFirst({ orderBy: { mapIndex: 'asc' } })) ||
    (await prisma.gameMap.findFirst({ orderBy: { id: 'asc' } }));
  if (!startMap) throw new Error('找不到任何起始地图');
  return { id: startMap.id, name: startMap.name };
}

async function collectHomePlayers() {
  const players = await prisma.player.findMany({
    select: {
      id: true,
      userId: true,
      name: true,
      houseName: true,
      mapId: true,
      markers: true,
      markers2: true,
      stats: true,
      version: true,
    },
  });

  return players.filter((p) => {
    const houseName = String(p.houseName || '').trim();
    if (houseName) return true;
    const markers = parseJson(p.markers, {}) || {};
    return HOME_MARKER_KEYS.some((k) => markers[k] !== undefined && markers[k] !== null && markers[k] !== 0 && markers[k] !== '');
  });
}

async function main() {
  const startMap = await resolveStartMapId();
  const players = await collectHomePlayers();

  console.log(`DATABASE=${prisma ? 'connected' : ''}`);
  console.log(`APPLY=${APPLY}`);
  console.log(`startMap=${startMap.id}/${startMap.name}`);
  console.log(`homePlayers=${players.length}`);

  const houseNamesSet = new Set();
  const allMapIdsToMaybeDelete = new Set();
  let relocated = 0;
  let playerUpdated = 0;
  let delayedDeleted = 0;

  for (const p of players) {
    const houseName = String(p.houseName || '').trim();
    const markers = parseJson(p.markers, {}) || {};
    const markers2 = parseJson(p.markers2, []) || [];
    const stats = parseJson(p.stats, {}) || {};

    for (const n of houseNames(houseName || '__none__')) {
      if (houseName) houseNamesSet.add(n);
    }
    if (houseName) {
      const maps = await prisma.gameMap.findMany({
        where: { name: { in: houseNames(houseName) } },
        select: { id: true, name: true },
      });
      for (const m of maps) allMapIdsToMaybeDelete.add(m.id);
    }

    const nextMarkers = { ...markers };
    const clearedKeys = [];
    for (const key of HOME_MARKER_KEYS) {
      if (nextMarkers[key] !== undefined && nextMarkers[key] !== null) {
        delete nextMarkers[key];
        clearedKeys.push(key);
      }
    }

    // 只摘掉家园建造打标的「工作」时限标记，避免误伤维修/抢救等同名「工作」
    const nextMarkers2 = Array.isArray(markers2)
      ? markers2.filter((m) => {
          const name = String(m?.name ?? m?.名称 ?? '');
          const homeBuild = m?.homeBuild === true;
          if (homeBuild && name === '工作') return false;
          return true;
        })
      : markers2;
    const removedMarkers2 = (Array.isArray(markers2) ? markers2.length : 0) - (Array.isArray(nextMarkers2) ? nextMarkers2.length : 0);

    const nextStats = { ...stats };
    let removedStats = 0;
    for (const key of ['家园原地图ID', '家园原地图']) {
      if (nextStats[key] !== undefined) {
        delete nextStats[key];
        removedStats += 1;
      }
    }

    let nextMapId = p.mapId;
    let nextLocation = undefined;
    if (houseName) {
      const homeMaps = await prisma.gameMap.findMany({
        where: { name: { in: houseNames(houseName) } },
        select: { id: true },
      });
      const homeIds = new Set(homeMaps.map((m) => m.id));
      if (homeIds.has(p.mapId)) {
        nextMapId = startMap.id;
        nextLocation = startMap.name;
      }
    }

    const willChangeHouse = Boolean(houseName);
    const willChangeMarkers = clearedKeys.length > 0;
    const willChangeMarkers2 = removedMarkers2 > 0;
    const willChangeStats = removedStats > 0;
    const willRelocate = nextMapId !== p.mapId;

    console.log(JSON.stringify({
      userId: p.userId,
      name: p.name,
      houseName: houseName || null,
      clearMarkers: clearedKeys,
      clearMarkers2: removedMarkers2,
      clearStats: removedStats,
      relocate: willRelocate ? { from: p.mapId, to: nextMapId } : null,
      version: p.version,
      willChange: willChangeHouse || willChangeMarkers || willChangeMarkers2 || willChangeStats || willRelocate,
    }));

    if (!APPLY) continue;

    const data = { version: { increment: 1 } };
    if (willChangeHouse) data.houseName = '';
    if (willChangeMarkers) data.markers = nextMarkers;
    if (willChangeMarkers2) data.markers2 = nextMarkers2;
    if (willChangeStats) data.stats = nextStats;
    if (willRelocate) {
      data.mapId = nextMapId;
      if (nextLocation !== undefined) data.location = nextLocation;
      relocated += 1;
    }

    // 只有真要改字段才写库，避免无意义 bump version
    if (willChangeHouse || willChangeMarkers || willChangeMarkers2 || willChangeStats || willRelocate) {
      await prisma.player.update({ where: { id: p.id }, data });
      playerUpdated += 1;
    }

    // 清理该玩家未完成的家园建造/货舱延时任务
    const del = await prisma.delayedTask.deleteMany({
      where: {
        userId: p.userId,
        type: { in: ['homeFoundation', 'homeConstruct', 'cargo'] },
      },
    });
    delayedDeleted += del.count;
  }

  // 汇总：玩家维度清零后再删动态家园图 + 宿主幽灵连接
  // 注意：valid 必须按「清零后仍存活的 Player.houseName」重算，
  // 不能用本次刚抹掉的 houseNamesSet（否则旧家园图会被误判为有效而漏删）。
  let removedMaps = 0;
  let removedConnections = 0;

  const remainingPlayers = await prisma.player.findMany({ select: { houseName: true } });
  const validNames = new Set();
  for (const p of remainingPlayers) {
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
    if (APPLY) {
      await prisma.gameMap.deleteMany({ where: { id: { in: orphanMaps.map((m) => m.id) } } });
    }
    removedMaps = orphanMaps.length;
  }

  const liveMaps = await prisma.gameMap.findMany({
    select: { id: true, name: true, connections: true },
  });
  const aliveNames = new Set(liveMaps.map((m) => m.name));
  // 与 purgeOrphanHomeData 一致：开拓地入口必须指向仍存在且仍被某玩家 houseName 拥有的家园。
  for (const map of liveMaps) {
    const connections = parseConns(map.connections);
    const filtered = connections.filter((c) => {
      const isFrontier = c?.isFrontier === true || c?.开拓地 === true || c?.type === '开拓地';
      if (!isFrontier) return true;
      const name = String(c?.name || '');
      if (!name || !validNames.has(name)) return false;
      return aliveNames.has(name);
    });
    const removed = connections.length - filtered.length;
    if (removed > 0) {
      if (APPLY) {
        await prisma.gameMap.update({
          where: { id: map.id },
          data: { connections: filtered },
        });
      }
      removedConnections += removed;
    }
  }

  console.log(JSON.stringify({
    APPLY,
    players: players.length,
    playerUpdated,
    relocated,
    delayedDeleted,
    removedMaps,
    removedMapNames: orphanMaps.map((m) => m.name).slice(0, 30),
    removedConnections,
    clearedHouseNames: [...houseNamesSet],
    remainingValidHomes: [...validNames],
  }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
