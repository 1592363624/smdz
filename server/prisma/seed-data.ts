/**
 * 使魔大战3 游戏固定数据导入脚本（来源: prisma/data/*.json）
 *
 * 设计说明：
 *  - 所有游戏固定配置（怪物/装备/地图/技能/任务/人物/物品等）已预先由
 *    convert-e-to-json.ts 从易语言原始配置（e/）转换为结构化 JSON，存放于 prisma/data/。
 *  - 本脚本只负责把 JSON 配置 upsert 进数据库，不再依赖 e/ 原始文件，
 *    从而解决 CI/CD 部署时 e/ 被 .gitignore 忽略导致的数据缺失（ENOENT）问题。
 *  - 以 JSON 为准：upsert 的 update 与 create 均写入完整数据，策划修改数值直接编辑 JSON 后重跑即可生效。
 *
 * 运行: npx ts-node prisma/seed-data.ts
 * 前置: 若 prisma/data/ 下无 JSON，请先运行 npx ts-node prisma/convert-e-to-json.ts
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

// ========== JSON 数据读取 ==========

/** 从 prisma/data/ 读取转换后的 JSON 配置（游戏固定数据单一来源） */
function loadData<T = any>(name: string): T[] {
  const file = path.resolve(__dirname, 'data', name);
  if (!fs.existsSync(file)) {
    console.warn(`⚠️ 未找到数据文件: ${name}（请先运行 npx ts-node prisma/convert-e-to-json.ts）`);
    return [];
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T[];
}

/**
 * 通用 upsert：以 JSON 为准，更新与新建均写入完整数据
 * @param model Prisma 模型委托（如 prisma.gameMonster）
 * @param rows  待写入的数据行数组
 * @param keyField 唯一键字段，默认为 name；商店等全局唯一表用 id
 */
async function upsertMany(
  model: any,
  rows: Array<Record<string, any>>,
  keyField: string = 'name'
): Promise<number> {
  let ok = 0;
  for (const row of rows) {
    const keyVal = (row as any)[keyField];
    if (keyVal === undefined || keyVal === null || keyVal === '') {
      console.warn(`⚠️ 跳过缺少 ${keyField} 的行`);
      continue;
    }
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

// ========== 主导入函数 ==========

async function importData() {
  console.log('🚀 开始导入游戏数据（来源: prisma/data/*.json）...\n');

  const counts = {
    weapon: 0, equipment: 0, monster: 0, item: 0,
    familiar: 0, map: 0, crafting: 0, title: 0,
    building: 0, vehicle: 0, attackText: 0, buff: 0,
    npc: 0, task: 0, effect: 0, resource: 0, shop: 0, update: 0,
    setEffect: 0, flavorText: 0,
  };

  // 套装效果文本与公共风味文本（来源: set-effects.json、flavor-texts.json）
  let setEffectCount = 0;
  let flavorTextCount = 0;
  try {
    const setEffects = loadData('set-effects.json');
    for (const row of setEffects) {
      await prisma.gameSetEffect.upsert({
        where: { name: row.name },
        update: { effectText: row.effectText, sourceFile: row.sourceFile },
        create: { name: row.name, effectText: row.effectText, sourceFile: row.sourceFile },
      });
      setEffectCount++;
    }
    const flavorTexts = loadData('flavor-texts.json');
    for (const row of flavorTexts) {
      await prisma.gameFlavorText.upsert({
        where: { name: row.name },
        update: { content: row.content },
        create: { name: row.name, content: row.content },
      });
      flavorTextCount++;
    }
  } catch (err) {
    console.error('⚠️ 导入套装/风味文本失败:', (err as Error).message);
  }

  // 逐文件读取 JSON 并 upsert 到对应表（以 JSON 配置为准）
  // 武器按 equipType 是否以"武器"结尾归类（原始配置中武器细分为 射弹/能量/近战/生体/制导/幽能 武器）
  const allEquip = loadData('equipments.json');
  const isWeapon = (e: any) => typeof e.equipType === 'string' && e.equipType.endsWith('武器');
  counts.weapon = await upsertMany(prisma.gameEquipment, allEquip.filter(isWeapon));
  counts.equipment = await upsertMany(prisma.gameEquipment, allEquip.filter((e: any) => !isWeapon(e)));
  counts.monster = await upsertMany(prisma.gameMonster, loadData('monsters.json'));
  counts.item = await upsertMany(prisma.gameItem, loadData('items.json'));
  counts.familiar = await upsertMany(prisma.gameFamiliar, loadData('familiars.json'));
  counts.map = await upsertMany(prisma.gameMap, loadData('maps.json'));
  counts.attackText = await upsertMany(prisma.gameAttackText, loadData('attack-texts.json'));
  counts.crafting = await upsertMany(prisma.gameCrafting, loadData('craftings.json'));
  counts.title = await upsertMany(prisma.gameTitle, loadData('titles.json'));
  counts.building = await upsertMany(prisma.gameBuilding, loadData('buildings.json'));
  counts.vehicle = await upsertMany(prisma.gameVehicle, loadData('vehicles.json'));
  counts.buff = await upsertMany(prisma.gameBuff, loadData('buffs.json'));
  counts.npc = await upsertMany(prisma.gameNpc, loadData('npcs.json'));
  counts.task = await upsertMany(prisma.gameTask, loadData('tasks.json'));
  counts.effect = await upsertMany(prisma.gameEffect, loadData('effects.json'));
  counts.resource = await upsertMany(prisma.gameResource, loadData('resources.json'));
  counts.shop = await upsertMany(prisma.gameShop, loadData('shops.json'), 'id');
  counts.update = await upsertMany(prisma.gameUpdateLog, loadData('update-logs.json'));

  counts.setEffect = setEffectCount;
  counts.flavorText = flavorTextCount;

  console.log('\n📊 导入结果:');
  console.log(`   ✅ 武器: ${counts.weapon}`);
  console.log(`   ✅ 装备: ${counts.equipment}`);
  console.log(`   ✅ 怪物: ${counts.monster}`);
  console.log(`   ✅ 物品: ${counts.item}`);
  console.log(`   ✅ 使魔: ${counts.familiar}`);
  console.log(`   ✅ 地图: ${counts.map}`);
  console.log(`   ✅ 制造: ${counts.crafting}`);
  console.log(`   ✅ 称号: ${counts.title}`);
  console.log(`   ✅ 建筑: ${counts.building}`);
  console.log(`   ✅ 载具: ${counts.vehicle}`);
  console.log(`   ✅ 攻击文本: ${counts.attackText}`);
  console.log(`   ✅ 增益: ${counts.buff}`);
  console.log(`   ✅ NPC对话: ${counts.npc}`);
  console.log(`   ✅ 任务: ${counts.task}`);
  console.log(`   ✅ 特效: ${counts.effect}`);
  console.log(`   ✅ 资源: ${counts.resource}`);
  console.log(`   ✅ 商店: ${counts.shop}`);
  console.log(`   ✅ 更新日志: ${counts.update}`);
  console.log(`   ✅ 套装效果文本: ${counts.setEffect}`);
  console.log(`   ✅ 公共风味文本: ${counts.flavorText}`);

  console.log('\n🎉 数据导入完成!');
}

// ========== 主入口 ==========

async function main() {
  try {
    await importData();
  } catch (e) {
    console.error('导入过程发生错误:', e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
