/**
 * DB 存量数据键名清点（一次性诊断）
 * 目的：统计 Player / GameMonster / GameMap / GameVehicle 各 JSON 列里实际出现的键名，
 *      判断哪些"别名键"真的还有存量数据、哪些只剩代码里的兜底死代码。
 */
const { PrismaClient } = require('../server/node_modules/@prisma/client');
require('../server/node_modules/dotenv').config({ path: 'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/.env' });
const prisma = new PrismaClient();

const cn = (s) => /[\u4e00-\u9fa5]/.test(String(s));

function collect(value, bag, depth = 0) {
  if (depth > 3 || value == null) return;
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 200)) collect(v, bag, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      bag.set(k, (bag.get(k) || 0) + 1);
      if (v && typeof v === 'object') collect(v, bag, depth + 1);
    }
  }
}

async function main() {
  // 玩家
  const players = await prisma.player.findMany({ take: 300 });
  const cols = ['backpack', 'equipment', 'weapons', 'markers', 'markers2', 'buffs', 'tasks', 'safeBox', 'titles', 'skills', 'sets', 'bonus', 'baseBonus', 'equipmentPresets', 'reverse', 'recipes', 'stats'];
  console.log(`玩家总数(取样 ${players.length})`);
  const bagAll = new Map();
  for (const p of players) for (const c of cols) collect(p[c], bagAll);
  const cnKeys = [...bagAll.entries()].filter(([k]) => cn(k)).sort((a, b) => b[1] - a[1]);
  console.log('\n=== 玩家 JSON 中出现的「中文键」（键 -> 出现次数） ===');
  console.log(cnKeys.map(([k, v]) => `${k}=${v}`).join('  '));
  const enKeys = [...bagAll.entries()].filter(([k]) => !cn(k)).sort((a, b) => b[1] - a[1]).slice(0, 60);
  console.log('\n=== 玩家 JSON 中英文键 Top60 ===');
  console.log(enKeys.map(([k, v]) => `${k}=${v}`).join('  '));

  // 背包条目里 count/quantity 并存情况
  let both = 0, onlyCount = 0, onlyQty = 0, mismatch = 0;
  for (const p of players) {
    for (const it of (p.backpack || [])) {
      const hasQ = it && it.quantity !== undefined, hasC = it && it.count !== undefined;
      if (hasQ && hasC) { both++; if (Number(it.quantity) !== Number(it.count)) mismatch++; }
      else if (hasC) onlyCount++; else if (hasQ) onlyQty++;
    }
  }
  console.log(`\n背包条目 quantity/count：并存=${both}（不一致=${mismatch}） 仅count=${onlyCount} 仅quantity=${onlyQty}`);

  // 怪物
  const monsters = await prisma.gameMonster.findMany({ take: 300 });
  const mBag = new Map();
  for (const m of monsters) collect(m, mBag);
  console.log(`\n怪物样本 ${monsters.length}，字段：`, [...mBag.keys()].join(','));

  // 地图
  const maps = await prisma.gameMap.findMany({ take: 50 });
  const mapBag = new Map();
  for (const mp of maps) for (const k of ['monsters','spawnMonsters','tempMonsters','summons','resources','resources2','connections','npcs','items','buildings','vehicles','markers','markers2','mapBuffs']) collect(mp[k], mapBag);
  const mapCn = [...mapBag.entries()].filter(([k]) => cn(k)).sort((a, b) => b[1] - a[1]);
  console.log(`\n地图样本 ${maps.length}，JSON 中文键：`, mapCn.map(([k, v]) => `${k}=${v}`).join('  '));

  // 载具
  const vs = await prisma.gameVehicle.findMany({ take: 50 });
  const vBag = new Map();
  for (const v of vs) collect(v, vBag);
  console.log(`\n载具样本 ${vs.length}，字段：`, [...vBag.keys()].join(','));

  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e.message); await prisma.$disconnect(); });