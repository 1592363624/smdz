/**
 * 游戏动态数据种子导入脚本（来源: prisma/data/*.json）
 * ------------------------------------------------------------------
 * 架构改革后职责：只负责把"需要持久化的动态数据"初始化进数据库。
 *   - GameMap（地图运行时状态表：spawnMonsters/resources2/markers 等动态字段在 DB）
 *   - GameVehicle（玩家载具实例）
 *
 * 固定配置（怪物/物品/装备/使魔/配方/任务/称号/建筑/NPC/载具部件/蓝图/增益/商店/
 * 资源/特效/攻击文本/套装效果/风味文本/更新日志）已全部 JSON 化，
 * 运行时由 StaticDataService 直接读取 server/prisma/data/*.json，不再入库。
 *
 * 运行: npx ts-node prisma/seed-data.ts
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

/** 从 prisma/data/ 读取 JSON 配置 */
function loadData<T = any>(name: string): T[] {
  const file = path.resolve(__dirname, 'data', name);
  if (!fs.existsSync(file)) {
    console.warn(`⚠️ 未找到数据文件: ${name}`);
    return [];
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T[];
}

/** 通用 upsert（以 JSON 为准） */
async function upsertMany(
  model: any,
  rows: Array<Record<string, any>>,
  keyField: string = 'name'
): Promise<number> {
  let ok = 0;
  for (const row of rows) {
    const keyVal = (row as any)[keyField];
    if (keyVal === undefined || keyVal === null || keyVal === '') continue;
    const where = keyField === 'id' ? { id: keyVal } : { [keyField]: keyVal };
    try {
      await model.upsert({ where, update: { ...row }, create: { ...row } });
      ok++;
    } catch (err) {
      console.error(`❌ 导入失败: [${keyVal}]`, (err as Error).message);
    }
  }
  return ok;
}

async function importDynamicData() {
  console.log('🚀 开始导入游戏动态数据（来源: prisma/data/*.json）...\n');

  // 1. 地图（动态状态表：spawnMonsters/resources2 等运行时刷新字段在 DB 持久化）
  const maps = loadData('maps.json');
  const mapCount = await upsertMany(prisma.gameMap, maps);
  console.log(`   ✅ 地图: ${mapCount}`);

  // 2. 载具（动态实例表：玩家拥有的载具 owner/driver/currentHp 在 DB 持久化）
  //    vehicles.json 含载具/部件模板，仅导入到 gameVehicle 作初始化模板
  const vehicles = loadData('vehicles.json');
  const vehicleCount = await upsertMany(prisma.gameVehicle, vehicles);
  console.log(`   ✅ 载具: ${vehicleCount}`);

  console.log('\n🎉 动态数据导入完成!');
}

async function main() {
  try {
    await importDynamicData();
  } catch (e) {
    console.error('导入过程发生错误:', e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
