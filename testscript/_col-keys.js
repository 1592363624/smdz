/**
 * 逐列清点 DB 地图/怪物 JSON 的条目键名（一次性诊断）
 * 目的：确认每个列里的条目到底用哪套键，避免"一刀切改名"改错域。
 */
const { PrismaClient } = require('../server/node_modules/@prisma/client');
require('../server/node_modules/dotenv').config({ path: 'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/.env' });
const prisma = new PrismaClient();
const cn = (s) => /[\u4e00-\u9fa5]/.test(String(s));

function entryKeys(v, bag) {
  const items = Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);
  for (const it of items.slice(0, 200)) {
    if (!it || typeof it !== 'object') continue;
    for (const k of Object.keys(it)) bag.set(k, (bag.get(k) || 0) + 1);
  }
}

(async () => {
  const maps = await prisma.gameMap.findMany();
  const cols = ['items', 'buildings', 'vehicles', 'summons', 'resources', 'resources2', 'monsters', 'spawnMonsters', 'tempMonsters', 'markers', 'markers2', 'mapBuffs', 'npcs', 'connections'];
  console.log('===== GameMap 列条目键名（中文标 ★） =====');
  for (const c of cols) {
    const bag = new Map();
    for (const m of maps) entryKeys(m[c], bag);
    if (!bag.size) continue;
    const list = [...bag.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`[${c}] ` + list.map(([k, v]) => (cn(k) ? '★' : '') + `${k}:${v}`).join(' '));
  }

  const ms = await prisma.gameMonster.findMany();
  console.log('\n===== GameMonster 行内 JSON 列条目键名 =====');
  for (const c of ['backpack', 'equipments', 'weapons', 'equipmentPresets', 'markers', 'markers2', 'buffs', 'achievements', 'set', 'bonus', 'baseBonus', 'extraBonus']) {
    const bag = new Map();
    for (const m of ms) entryKeys(m[c], bag);
    if (!bag.size) continue;
    const list = [...bag.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`[${c}] ` + list.map(([k, v]) => (cn(k) ? '★' : '') + `${k}:${v}`).join(' '));
  }

  const vs = await prisma.gameVehicle.findMany();
  console.log('\n===== GameVehicle 行内 JSON 列条目键名 =====');
  for (const c of ['parts', 'builtinParts', 'markers', 'markers2', 'bonus', 'recipes']) {
    const bag = new Map();
    for (const v of vs) entryKeys(v[c], bag);
    if (!bag.size) continue;
    const list = [...bag.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`[${c}] ` + list.map(([k, v]) => (cn(k) ? '★' : '') + `${k}:${v}`).join(' '));
  }
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); });