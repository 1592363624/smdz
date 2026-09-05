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
import { attachBeijingTimeMiddleware } from '../src/common/utils/beijing-time.middleware';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
attachBeijingTimeMiddleware(prisma);

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

/**
 * 只导入地图的动态字段到 DB（静态字段由 StaticDataService 从 maps.json 读取）
 * DB 中只存储 name（唯一键）、mapIndex（排序）和运行时动态字段。
 * 运行时动态字段包含：
 *   - 完全动态：spawnMonsters, tempMonsters, summons, markers, markers2
 *   - 半动态（JSON 初始值，运行时可变）：npcs, buildings, vehicles, items, monsters, connections, resources, resources2
 * 首次导入时，半动态字段从 JSON 取初始值；后续更新时保留 DB 中的运行时状态。
 */
async function seedMapDynamicFields(): Promise<number> {
  const maps = loadData('maps.json');
  let ok = 0;

  for (const row of maps) {
    const name = (row as any).name;
    if (!name) continue;

    // 从 JSON 中提取半动态字段的初始值（首次创建时使用）。
    // GameMap 表对应列已是原生 Json 类型，写库 data 直接传对象/数组，
    // 不能再 JSON.stringify（否则会双重编码成字符串存入）。
    const semiDynamicFields: Record<string, any> = {};
    for (const field of ['npcs', 'buildings', 'vehicles', 'items', 'monsters', 'connections', 'resources', 'resources2']) {
      if (row[field] !== undefined && row[field] !== null) {
        semiDynamicFields[field] = row[field];
      }
    }

    try {
      // 使用 upsert：create 时写入 name/mapIndex + 半动态字段初始值；update 时只更新 name/mapIndex
      await prisma.gameMap.upsert({
        where: { name },
        create: {
          name,
          mapIndex: (row as any).mapIndex ?? 0,
          // 完全动态字段初始化为空（原生 Json 列，直接传数组/对象字面量）
          spawnMonsters: [],
          tempMonsters: [],
          summons: [],
          markers: {},
          // 地图标记2容器与原版「标记2」一致为数组元素 {name, expireAt}
          markers2: [],
          // 其余必填列（schema 使用 dbgenerated 默认，Prisma Client 仍视为必填）显式给初值，
          // 避免创建时报 Null constraint violation；若 maps.json 带实际值则由 ...semiDynamicFields 覆盖。
          mapBuffs: [],
          requireMarkers: [],
          npcs: [],
          buildings: [],
          vehicles: [],
          items: [],
          monsters: [],
          connections: [],
          resources: [],
          resources2: [],
          description: (row as any).description ?? '',
          failHint: (row as any).failHint ?? '',
          clearMarkers: (row as any).clearMarkers ?? '',
          // 半动态字段从 JSON 取初始值
          ...semiDynamicFields,
        },
        // update 时同步 name/mapIndex 及"以代码为准"的固定配置字段（怪物模板/NPC/连接/资源/建筑等），
        // 保留纯运行时动态状态（spawnMonsters 当前怪物/tempMonsters/summons/markers/markers2）。
        // 这样修改 maps.json 的地图固定配置（如给医疗室补史莱姆怪物）后，存量数据库会同步生效。
        update: {
          name,
          mapIndex: (row as any).mapIndex ?? 0,
          ...semiDynamicFields,
        },
      });
      ok++;
    } catch (err) {
      console.error(`❌ 地图导入失败: [${name}]`, (err as Error).message);
    }
  }
  return ok;
}

async function importDynamicData() {
  console.log('🚀 开始导入游戏动态数据（来源: prisma/data/*.json）...\n');

  // 1. 地图（动态状态表：只写入 name/mapIndex + 动态字段初始值）
  const mapCount = await seedMapDynamicFields();
  console.log(`   ✅ 地图: ${mapCount}`);

  // 2. 载具（动态实例表：玩家拥有的载具 owner/driver/currentHp 在 DB 持久化）
  //    vehicles.json 含载具/部件模板，仅导入到 gameVehicle 作初始化模板。
  //    GameVehicle 表 JSON 字段（bonus/parts/markers/markers2/recipes/builtinParts）
  //    已是原生 Json 类型，写库 data 直接透传对象/数组，无需 stringify。
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
