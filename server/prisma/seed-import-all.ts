/**
 * 补充数据导入脚本（来源: prisma/data/*.json）
 *
 * 负责从转换后的 JSON 配置中导入「蓝图」「种子列表」等补充数据。
 * 武器/装备/怪物/地图/使魔/物品/攻击文本/套装效果/风味文本等已由 seed-data.ts 统一导入，
 * 本脚本仅处理蓝图与种子（避免重复导入同一张表）。
 *
 * 运行: npx ts-node prisma/seed-import-all.ts
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

// ========== 文件路径 ==========
const DATA_DIR = path.resolve(__dirname, 'data');

/** 读取 prisma/data/ 下的 JSON 文件 */
function loadData<T = any>(name: string): T[] {
  const file = path.join(DATA_DIR, name);
  if (!fs.existsSync(file)) {
    console.warn(`⚠️ 未找到数据文件: ${name}（请先运行 npx ts-node prisma/convert-e-to-json.ts）`);
    return [];
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T[];
}

// ========== 1. 蓝图数据导入 ==========

async function importBlueprints(): Promise<{ success: number; errors: number }> {
  console.log('\n📋 ====== 1. 导入蓝图数据 ======');
  const blueprints = loadData('blueprints.json');
  console.log(`📊 读取 ${blueprints.length} 条蓝图数据`);

  let success = 0;
  let errors = 0;
  for (const bp of blueprints) {
    try {
      await prisma.gameBlueprint.upsert({
        where: { name: bp.name },
        update: {
          type: bp.type,
          type2: bp.type2,
          craftTime: bp.craftTime,
          cost: bp.cost,
          price: bp.price,
          quantity: bp.quantity,
          materials: JSON.stringify(bp.materials),
        },
        create: {
          name: bp.name,
          type: bp.type,
          type2: bp.type2,
          craftTime: bp.craftTime,
          cost: bp.cost,
          price: bp.price,
          quantity: bp.quantity,
          materials: JSON.stringify(bp.materials),
        },
      });
      success++;
    } catch (err) {
      errors++;
      console.error(`❌ 导入蓝图失败: [${bp.name}]`, (err as Error).message);
    }
  }
  console.log(`   ✅ 成功: ${success}, ❌ 失败: ${errors}`);
  return { success, errors };
}

// ========== 2. 种子数据导入 ==========

async function importSeedItems(): Promise<{ success: boolean }> {
  console.log('\n📋 ====== 2. 导入种子数据 ======');
  // seed-items.json 结构为 { items: string[] }（对象而非数组）
  const file = path.join(DATA_DIR, 'seed-items.json');
  let items: string[] = [];
  if (fs.existsSync(file)) {
    const obj = JSON.parse(fs.readFileSync(file, 'utf-8'));
    items = obj.items || [];
  }
  if (items.length === 0) {
    console.warn('⚠️ 种子列表为空，跳过');
    return { success: false };
  }
  const itemsJson = JSON.stringify(items);
  await prisma.systemConfig.upsert({
    where: { key: 'seed_items' },
    update: { value: itemsJson, label: '种子/物品列表' },
    create: {
      key: 'seed_items',
      value: itemsJson,
      label: '种子/物品列表',
      description: '可种植的种子和可收集的物品列表',
      type: 'string-array',
      group: 'system',
    },
  });
  console.log(`   ✅ 导入 ${items.length} 个种子/物品条目`);
  return { success: true };
}

// ========== 主入口 ==========

async function main() {
  console.log('🚀 开始导入补充数据（来源: prisma/data/*.json）...\n');
  await importBlueprints();
  await importSeedItems();
  console.log('\n🎉 ====== 补充数据导入完成 ======\n');
}

main()
  .catch((e) => {
    console.error('导入过程发生错误:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
