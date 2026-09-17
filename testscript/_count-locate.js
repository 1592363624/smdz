/**
 * 定位存量数据中残留的别名键位置（一次性诊断）
 * 目标：找出 Player / GameMonster / GameVehicle JSON 里 count / 装备 / 载具 / 说明 / 限制 等
 *      非规范键到底挂在哪个列、哪一层，便于决定迁移与代码收敛点。
 */
const { PrismaClient } = require('../server/node_modules/@prisma/client');
require('../server/node_modules/dotenv').config({ path: 'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/.env' });
const prisma = new PrismaClient();

const TARGETS = ['count', '装备', '载具', '说明', '限制', '名称', '数值', 'requirements'];

/** 深度遍历，返回 [路径, 值摘要] */
function walk(node, path, out, depth = 0) {
  if (depth > 6 || node == null) return;
  if (Array.isArray(node)) {
    node.slice(0, 50).forEach((v, i) => walk(v, `${path}[${i}]`, out, depth + 1));
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (TARGETS.includes(k)) {
        out.push(`${path}.${k} = ${typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : v}`);
      }
      walk(v, `${path}.${k}`, out, depth + 1);
    }
  }
}

async function main() {
  const players = await prisma.player.findMany();
  const pCols = ['backpack', 'equipment', 'weapons', 'markers', 'markers2', 'buffs', 'tasks', 'safeBox', 'titles', 'skills', 'sets', 'bonus', 'baseBonus', 'equipmentPresets', 'reverse', 'recipes', 'stats'];
  const pOut = [];
  for (const p of players) for (const c of pCols) walk(p[c], c, pOut);
  console.log('=== Player 命中 ===');
  console.log([...new Set(pOut)].slice(0, 40).join('\n'));

  const monsters = await prisma.gameMonster.findMany();
  const mOut = [];
  const mCols = ['backpack', 'equipment', 'weapons', 'markers', 'markers2', 'buffs', 'set', 'sets', 'bonus', 'baseBonus', 'extraBonus', 'equipments', 'equipmentPresets', 'achievements', 'drops'];
  for (const m of monsters) for (const c of mCols) walk(m[c], c, mOut);
  console.log('\n=== GameMonster 命中 ===');
  console.log([...new Set(mOut)].slice(0, 40).join('\n'));

  const vehicles = await prisma.gameVehicle.findMany();
  const vOut = [];
  const vCols = ['parts', 'builtinParts', 'recipes', 'markers', 'markers2', 'bonus', 'equipmentPresets'];
  for (const v of vehicles) for (const c of vCols) walk(v[c], c, vOut);
  console.log('\n=== GameVehicle 命中 ===');
  console.log([...new Set(vOut)].slice(0, 40).join('\n'));

  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e.message); await prisma.$disconnect(); });