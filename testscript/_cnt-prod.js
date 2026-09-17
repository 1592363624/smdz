/**
 * 一次性诊断：正式库里「建筑/资源条目」的 count 与 quantity 是否同义（只读）
 * 用于判定 mapResource 域能否把 count 合并进 quantity。
 */
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient({
  datasources: { db: { url: 'mysql://smdz:EDzCnyba6HYnx5MT@52shell.ltd:3306/smdz?charset=utf8mb4&connection_limit=3' } },
});

const cols = ['items', 'resources', 'resources2', 'buildings'];
const stats = {};
const samples = [];

function asArr(v) {
  if (!v) return [];
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return Array.isArray(v) ? v : [];
}

(async () => {
  const maps = await prisma.gameMap.findMany({ select: { id: true, name: true, items: true, resources: true, resources2: true, buildings: true } });
  for (const m of maps) {
    for (const c of cols) {
      for (const e of asArr(m[c])) {
        if (!e || typeof e !== 'object') continue;
        const hasC = e.count !== undefined, hasQ = e.quantity !== undefined, hasCN = e['数量'] !== undefined;
        const key = `${c}|${hasC ? 'C' : '-'}${hasQ ? 'Q' : '-'}${hasCN ? 'N' : '-'}`;
        stats[key] = (stats[key] || 0) + 1;
        if (hasC && hasQ && Number(e.count) !== Number(e.quantity) && samples.length < 12) {
          samples.push(`map${m.id} ${c} ${e.name}: count=${e.count} quantity=${e.quantity}`);
        }
        if (hasCN && samples.length < 16) samples.push(`map${m.id} ${c} ${e.name}: 数量=${e['数量']} count=${e.count} quantity=${e.quantity}`);
      }
    }
  }
  console.log('键组合统计 (列|C=count Q=quantity N=数量):');
  for (const [k, v] of Object.entries(stats).sort((a, b) => b[1] - a[1])) console.log(`  ${k} = ${v}`);
  console.log('\ncount≠quantity 抽样 / 数量键抽样:');
  for (const s of samples) console.log('  ' + s);
  await prisma.$disconnect();
})();