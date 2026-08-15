/**
 * 补充数据同步脚本（来源: prisma/data/*.json）
 * ------------------------------------------------------------------
 * 架构改革后职责：仅同步需要持久化的"配置型"数据到 SystemConfig。
 * 蓝图/种子等固定配置已 JSON 化，运行时由 StaticDataService 读取；
 * 此处仅将"种子/物品列表"同步到 SystemConfig（供需数据库配置的模块使用）。
 *
 * 运行: npx ts-node prisma/seed-import-all.ts
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

const DATA_DIR = path.resolve(__dirname, 'data');

async function syncSeedItems(): Promise<{ success: boolean }> {
  console.log('\n📋 ====== 同步种子数据到 SystemConfig ======');
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
  console.log(`   ✅ 同步 ${items.length} 个种子/物品条目`);
  return { success: true };
}

async function main() {
  console.log('🚀 开始同步补充数据（来源: prisma/data/*.json）...\n');
  await syncSeedItems();
  console.log('\n🎉 ====== 补充数据同步完成 ======\n');
}

main()
  .catch((e) => {
    console.error('同步过程发生错误:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
