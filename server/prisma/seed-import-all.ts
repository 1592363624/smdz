/**
 * 补充数据导入脚本
 * 处理 0.txt 蓝图数据、@Resource/ 套装效果和种子数据
 * 以及 使魔大战.txt 中跳过的类型（资源、特效、商店、更新）
 *
 * 运行: npx ts-node prisma/seed-import-all.ts
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

// 使用 iconv-lite 解码 GBK 编码
let iconv: any;
try {
  iconv = require('iconv-lite');
} catch {
  console.error('请先安装 iconv-lite: npm install iconv-lite');
  process.exit(1);
}

const prisma = new PrismaClient();

// ========== 文件路径 ==========

const ROOT_DIR = path.resolve(__dirname, '../../');
const BLUEPRINT_FILE = path.resolve(ROOT_DIR, 'e/0.txt');
const RESOURCE_DIR = path.resolve(ROOT_DIR, 'e/@Resource');
const DATA_FILE = path.resolve(ROOT_DIR, 'e/使魔大战.txt');

// ========== 通用解析函数 ==========

interface ConfigSection {
  name: string;
  type: string;
  fields: Record<string, string>;
}

/**
 * 读取并解析配置文件（通用格式）
 * 返回节数组，每个节包含名称、类型和字段键值对
 */
function parseConfigFile(filePath: string): ConfigSection[] {
  console.log(`📖 读取数据文件: ${filePath}`);
  const buf = fs.readFileSync(filePath);
  const txt = iconv.decode(buf, 'gbk');

  const sections: ConfigSection[] = [];
  const lines = txt.split(/\r?\n/);

  let currentSection: ConfigSection | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 匹配节头 [节名]
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      if (currentSection) {
        sections.push(currentSection);
      }
      currentSection = {
        name: sectionMatch[1],
        type: '',
        fields: {},
      };
      continue;
    }

    // 匹配键值对
    const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
    if (kvMatch && currentSection) {
      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();

      if (key === '类型') {
        currentSection.type = value;
      } else {
        currentSection.fields[key] = value;
      }
    }
  }

  if (currentSection) {
    sections.push(currentSection);
  }

  console.log(`📊 解析完成: 共 ${sections.length} 个节`);
  return sections;
}

// ========== 1. 蓝图数据导入 ==========

interface BlueprintData {
  name: string;
  type: string;
  type2: string;
  craftTime: number;
  cost: number;
  price: number;
  quantity: number;
  materials: Record<string, number>;
}

/**
 * 解析 0.txt 中的蓝图数据
 * 实际文件格式（注意：与任务描述中的字段名不同，实际文件使用 数据 和 属性）：
 *   1. 类型=蓝图 + 数据=... + 属性=...  → 完整蓝图
 *      - 数据=类型,制造时间,38个数值,名称,费用  （蓝图属性）
 *      - 属性=数量,价格,需求类型                （购买需求）
 *   2. 类型=数字,价格,类型（无数据字段） → 简单蓝图购买条目
 *   3. 类型=数字,价格,类型 + 类型=蓝图 + 数据=... → 同时有购买条目和蓝图
 *   4. 类型=队员 → 玩家数据，跳过
 */
function parseBlueprintSections(): BlueprintData[] {
  const buf = fs.readFileSync(BLUEPRINT_FILE);
  const txt = iconv.decode(buf, 'gbk');

  const blueprints: BlueprintData[] = [];
  const lines = txt.split(/\r?\n/);

  let currentSection: {
    name: string;
    fields: Record<string, string>;
    purchaseType: string | null;
  } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 匹配节头 [节名]
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      // 处理上一个节
      if (currentSection) {
        processBlueprintSection(currentSection, blueprints);
      }
      currentSection = {
        name: sectionMatch[1],
        fields: {},
        purchaseType: null,
      };
      continue;
    }

    // 匹配键值对
    const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
    if (kvMatch && currentSection) {
      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();

      if (key === '类型') {
        // 检查是否是购买条目（值以数字开头，包含逗号）
        if (/^\d+[,，]/.test(value)) {
          currentSection.purchaseType = value;
        } else {
          currentSection.fields['类型'] = value;
        }
      } else {
        currentSection.fields[key] = value;
      }
    }
  }

  // 处理最后一个节
  if (currentSection) {
    processBlueprintSection(currentSection, blueprints);
  }

  return blueprints;
}

/**
 * 处理单个蓝图节
 */
function processBlueprintSection(
  section: { name: string; fields: Record<string, string>; purchaseType: string | null },
  blueprints: BlueprintData[]
): void {
  const { name, fields, purchaseType } = section;
  const sectionType = fields['类型'] || '';

  // 类型=队员，跳过
  if (sectionType === '队员') {
    return;
  }

  // 有数据字段（蓝图属性） → 尝试解析为蓝图
  // 注意：实际文件用"数据"作为蓝图属性字段，用"属性"作为购买需求字段
  if (fields['数据']) {
    const bp = parseBlueprintData(name, fields['数据'], fields['属性']);
    if (bp) {
      // 如果有购买条目，且没有属性字段（购买需求），用购买条目的价格和数量
      if (purchaseType && !fields['属性']) {
        const purchase = parsePurchaseTypeValue(purchaseType);
        if (purchase) {
          bp.price = purchase.price;
          bp.quantity = purchase.quantity;
          if (purchase.type2 && !bp.type2) {
            bp.type2 = purchase.type2;
          }
        }
      }
      blueprints.push(bp);
    }
    return;
  }

  // 有购买条目但没有数据字段 → 简单购买条目
  if (purchaseType) {
    const bp = parsePurchaseTypeValue(purchaseType);
    if (bp) {
      bp.name = name;
      blueprints.push(bp);
    }
    return;
  }
}

/**
 * 解析 数据 字段（蓝图属性）
 * 格式: 类型,制造时间,38个逗号分隔数值,蓝图名称,费用
 * 38个数值对应各种材料消耗
 */
function parseBlueprintData(
  name: string,
  dataStr: string,
  attrStr?: string
): BlueprintData | null {
  try {
    const parts = dataStr.split(/[,，]/);
    // 格式: 类型(1) + 制造时间(1) + 36个材料数值 + 名称(1) + 费用(1) = 40
    if (parts.length < 40) {
      console.warn(`⚠️  数据字段格式异常: [${name}], 字段数=${parts.length}`);
      return null;
    }

    const bpType = parts[0].trim();
    const craftTime = parseInt(parts[1]) || 0;

    // 提取36个材料数值 (索引 2~37)
    const materialValues: number[] = [];
    for (let i = 2; i < 38 && i < parts.length; i++) {
      materialValues.push(parseFloat(parts[i]) || 0);
    }

    // 蓝图名称 (索引 38)
    const bpName = parts.length > 38 ? parts[38].trim() : name;

    // 费用 (最后一个)
    const cost = parseFloat(parts[parts.length - 1]) || 0;

    // 构建材料消耗对象（只保存非零值）
    const materials: Record<string, number> = {};
    materialValues.forEach((val, index) => {
      if (val > 0) {
        materials[`material_${index + 1}`] = val;
      }
    });

    // 解析属性字段（购买需求）
    let quantity = 1;
    let price = 0;
    let type2 = '';

    if (attrStr) {
      const attrParts = attrStr.split(/[,，]/);
      if (attrParts.length >= 3) {
        quantity = parseInt(attrParts[0]) || 1;
        price = parseFloat(attrParts[1]) || 0;
        type2 = attrParts[2].trim();
      } else if (attrParts.length >= 2) {
        quantity = parseInt(attrParts[0]) || 1;
        price = parseFloat(attrParts[1]) || 0;
      }
    }

    return {
      name: bpName || name,
      type: bpType,
      type2: type2,
      craftTime: craftTime,
      cost: cost,
      price: price,
      quantity: quantity,
      materials: materials,
    };
  } catch (err) {
    console.warn(`⚠️  解析蓝图数据失败: [${name}]`, (err as Error).message);
    return null;
  }
}

/**
 * 解析购买条目类型值
 * 格式: 数量,价格,需求类型
 */
function parsePurchaseTypeValue(typeStr: string): BlueprintData | null {
  try {
    const parts = typeStr.split(/[,，]/);
    if (parts.length < 3) {
      return null;
    }

    const quantity = parseInt(parts[0]) || 1;
    const price = parseFloat(parts[1]) || 0;
    const bpType = parts[2].trim();

    return {
      name: '',
      type: bpType,
      type2: '',
      craftTime: 0,
      cost: 0,
      price: price,
      quantity: quantity,
      materials: {},
    };
  } catch (err) {
    return null;
  }
}

/**
 * 导入蓝图数据到 GameBlueprint 表
 */
async function importBlueprints(): Promise<{ success: number; errors: number }> {
  console.log('\n📋 ====== 1. 导入蓝图数据 ======');
  const blueprints = parseBlueprintSections();
  console.log(`📊 解析到 ${blueprints.length} 条蓝图数据`);

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

// ========== 2. 套装效果导入 ==========

/**
 * 读取 @Resource/ 目录下的所有套装效果文件
 * 文件命名规则：文件名去掉"套装效果.txt"或"效果.txt"后缀就是套装名
 * 存储到 SystemConfig 中，key 为 "set_effect_套装名"
 */
async function importSetEffects(): Promise<{ success: number; errors: number }> {
  console.log('\n📋 ====== 2. 导入套装效果 ======');

  // 获取目录下所有 txt 文件
  let files: string[];
  try {
    files = fs.readdirSync(RESOURCE_DIR).filter(f => f.endsWith('.txt'));
  } catch (err) {
    console.error(`❌ 无法读取目录: ${RESOURCE_DIR}`, (err as Error).message);
    return { success: 0, errors: 0 };
  }

  // 筛选套装效果文件（匹配 "套装效果.txt" 或 "效果.txt"）
  const setEffectFiles = files.filter(f =>
    f.includes('套装效果') || f.endsWith('效果.txt')
  ).filter(f => f !== '种子等.txt'); // 排除种子文件

  console.log(`📊 找到 ${setEffectFiles.length} 个套装效果文件`);

  let success = 0;
  let errors = 0;

  for (const file of setEffectFiles) {
    try {
      const filePath = path.join(RESOURCE_DIR, file);
      const buf = fs.readFileSync(filePath);
      // 尝试用 UTF-8 解码，如果失败则用 GBK
      let effectText: string;
      try {
        effectText = iconv.decode(buf, 'utf-8');
        // 检查是否包含乱码
        if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(effectText)) {
          effectText = iconv.decode(buf, 'gbk');
        }
      } catch {
        effectText = iconv.decode(buf, 'gbk');
      }
      effectText = effectText.trim();

      // 提取套装名：去掉 "套装效果.txt" 或 "效果.txt" 后缀
      let setName = file;
      if (setName.endsWith('套装效果.txt')) {
        setName = setName.slice(0, -'套装效果.txt'.length);
      } else if (setName.endsWith('效果.txt')) {
        setName = setName.slice(0, -'效果.txt'.length);
      }

      const key = `set_effect_${setName}`;

      await prisma.systemConfig.upsert({
        where: { key },
        update: {
          value: effectText,
          label: `${setName}套装效果`,
          group: 'set_effects',
        },
        create: {
          key,
          value: effectText,
          label: `${setName}套装效果`,
          description: `${setName}套装效果`,
          type: 'string',
          group: 'set_effects',
        },
      });
      success++;
      console.log(`   ✅ [${setName}]: ${effectText.slice(0, 50)}${effectText.length > 50 ? '...' : ''}`);
    } catch (err) {
      errors++;
      console.error(`❌ 导入套装效果失败: [${file}]`, (err as Error).message);
    }
  }

  console.log(`   ✅ 成功: ${success}, ❌ 失败: ${errors}`);
  return { success, errors };
}

// ========== 3. 种子数据导入 ==========

/**
 * 读取 种子等.txt 并导入到 SystemConfig
 * 内容为逗号分隔的物品名称列表
 */
async function importSeedItems(): Promise<{ success: boolean }> {
  console.log('\n📋 ====== 3. 导入种子数据 ======');

  const seedFile = path.join(RESOURCE_DIR, '种子等.txt');

  try {
    const buf = fs.readFileSync(seedFile);
    let text: string;
    try {
      text = iconv.decode(buf, 'utf-8');
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
        text = iconv.decode(buf, 'gbk');
      }
    } catch {
      text = iconv.decode(buf, 'gbk');
    }
    text = text.trim();

    // 分割逗号分隔的物品列表
    const items = text.split(/[,，]/).map(s => s.trim()).filter(s => s.length > 0);
    const itemsJson = JSON.stringify(items);

    await prisma.systemConfig.upsert({
      where: { key: 'seed_items' },
      update: {
        value: itemsJson,
        label: '种子/物品列表',
      },
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
  } catch (err) {
    console.error('❌ 导入种子数据失败:', (err as Error).message);
    return { success: false };
  }
}

// ========== 4. 跳过类型数据导入 ==========

/**
 * 从 使魔大战.txt 中解析跳过的类型（资源、特效、商店、更新）
 * 并导入到 SystemConfig 表中
 */
async function importSkippedTypes(): Promise<{ success: number; errors: number }> {
  console.log('\n📋 ====== 4. 导入跳过的类型数据 ======');

  const sections = parseConfigFile(DATA_FILE);

  // 需要处理的跳过类型
  const SKIP_TYPES = ['资源', '特效', '商店', '更新'];

  // 统计各类型数量
  const typeCounts: Record<string, number> = {};
  for (const section of sections) {
    if (SKIP_TYPES.includes(section.type)) {
      typeCounts[section.type] = (typeCounts[section.type] || 0) + 1;
    }
  }
  console.log('📋 跳过类型分布:');
  for (const type of SKIP_TYPES) {
    console.log(`   ${type}: ${typeCounts[type] || 0}`);
  }

  let success = 0;
  let errors = 0;

  for (const section of sections) {
    if (!SKIP_TYPES.includes(section.type)) continue;

    try {
      // 构建配置 key
      const key = `${section.type}_${section.name}`;

      // 将字段序列化为 JSON
      const value = JSON.stringify({
        name: section.name,
        type: section.type,
        fields: section.fields,
      });

      // 构建描述文本
      const descFields = Object.entries(section.fields)
        .slice(0, 3) // 只取前3个字段作为预览
        .map(([k, v]) => `${k}=${v.slice(0, 30)}`)
        .join('; ');

      await prisma.systemConfig.upsert({
        where: { key },
        update: {
          value,
          label: `${section.type}: ${section.name}`,
        },
        create: {
          key,
          value,
          label: `${section.type}: ${section.name}`,
          description: descFields || '',
          type: 'json',
          group: section.type,
        },
      });
      success++;
    } catch (err) {
      errors++;
      console.error(`❌ 导入跳过类型失败: [${section.name}] (类型=${section.type})`, (err as Error).message);
    }
  }

  console.log(`   ✅ 成功: ${success}, ❌ 失败: ${errors}`);
  return { success, errors };
}

// ========== 常量映射解析 ==========

/**
 * 解析 @Constant.ecode 文件，建立名称到特殊序号的映射
 * 用于武器、使魔、装备的 specialSeq 字段
 */
interface ConstantMappings {
  weapons: Record<string, number>;   // 武器名 → 负序号
  familiars: Record<string, number>; // 使魔名 → 正序号
  equipment: Record<string, number>; // 装备名 → 正序号
}

/**
 * 解析 @Constant.ecode 文件
 */
function parseConstantEcode(): ConstantMappings {
  const constantFile = path.resolve(ROOT_DIR, 'e/@Constant.ecode');
  const buf = fs.readFileSync(constantFile);
  const txt = iconv.decode(buf, 'gbk');
  const lines = txt.split(/\r?\n/);

  const weapons: Record<string, number> = {};
  const familiars: Record<string, number> = {};
  const equipment: Record<string, number> = {};

  // 按行解析，根据顺序和值范围判断所属类别
  let section: 'initial' | 'equip' | 'weapon' | 'familiar' | 'pet' = 'initial';

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    // 空 .常量 行作为类别分隔符
    if (t === '.常量') {
      section = 'initial';
      continue;
    }

    // 匹配 .常量 NAME, "VALUE"
    const m = t.match(/^\.常量\s+(\S+)\s*,\s*"(-?\d+)"/);
    if (!m) continue;

    const name = m[1];
    const val = parseInt(m[2]);

    // 武器序号为负值（-1 ~ -40）
    if (val < 0 && val >= -100) {
      section = 'weapon';
      weapons[name] = val;
    } else if (val > 0 && val <= 100 && section === 'weapon') {
      // 武器段之后的正值属于使魔序号
      section = 'familiar';
      familiars[name] = val;
    } else if (val > 0 && val <= 100 && section === 'familiar') {
      // 继续使魔序号
      familiars[name] = val;
    } else if (val > 0 && val <= 200 && section === 'initial') {
      section = 'equip';
      equipment[name] = val;
    } else if (val > 0 && section === 'equip') {
      equipment[name] = val;
    }
  }

  console.log(`📊 常量解析完成: 武器 ${Object.keys(weapons).length} 个, 使魔 ${Object.keys(familiars).length} 个, 装备 ${Object.keys(equipment).length} 个`);
  return { weapons, familiars, equipment };
}

// ========== 5. 攻击文本导入 ==========

/**
 * 从 使魔大战.txt 解析 类型=文本 的节
 * 导入到 GameAttackText 表
 */
async function importAttackTexts(): Promise<{ success: number; errors: number }> {
  console.log('\n📋 ====== 5. 导入攻击文本 ======');
  const sections = parseConfigFile(DATA_FILE);
  const textSections = sections.filter(s => s.type === '文本');
  console.log(`📊 找到 ${textSections.length} 个攻击文本节`);

  let success = 0;
  let errors = 0;

  for (const section of textSections) {
    try {
      // 各字段用逗号分割后存为JSON数组
      const attackTexts = section.fields['攻击']
        ? section.fields['攻击'].split(/[,，]/).map(s => s.trim()).filter(s => s)
        : [];
      const shieldBreak = section.fields['破盾']
        ? section.fields['破盾'].split(/[,，]/).map(s => s.trim()).filter(s => s)
        : [];
      const armorBreak = section.fields['破甲']
        ? section.fields['破甲'].split(/[,，]/).map(s => s.trim()).filter(s => s)
        : [];
      const killTexts = section.fields['击杀']
        ? section.fields['击杀'].split(/[,，]/).map(s => s.trim()).filter(s => s)
        : [];

      await prisma.gameAttackText.upsert({
        where: { name: section.name },
        update: {
          attackTexts: JSON.stringify(attackTexts),
          shieldBreak: JSON.stringify(shieldBreak),
          armorBreak: JSON.stringify(armorBreak),
          killTexts: JSON.stringify(killTexts),
        },
        create: {
          name: section.name,
          attackTexts: JSON.stringify(attackTexts),
          shieldBreak: JSON.stringify(shieldBreak),
          armorBreak: JSON.stringify(armorBreak),
          killTexts: JSON.stringify(killTexts),
        },
      });
      success++;
    } catch (err) {
      errors++;
      console.error(`❌ 导入攻击文本失败: [${section.name}]`, (err as Error).message);
    }
  }

  console.log(`   ✅ 成功: ${success}, ❌ 失败: ${errors}`);
  return { success, errors };
}

// ========== 6. 武器导入 ==========

/**
 * 从 使魔大战.txt 解析 类型=武器 的节
 * 导入到 GameEquipment 表（equipType='武器'）
 */
async function importWeapons(
  constantMappings: ConstantMappings
): Promise<{ success: number; errors: number }> {
  console.log('\n📋 ====== 6. 导入武器 ======');
  const sections = parseConfigFile(DATA_FILE);
  const weaponSections = sections.filter(s => s.type === '武器');
  console.log(`📊 找到 ${weaponSections.length} 个武器节`);

  let success = 0;
  let errors = 0;

  for (const section of weaponSections) {
    try {
      // 特殊序号：从常量映射查找
      const specialSeq = constantMappings.weapons[section.name] || 0;

      // 解析伤害字段：如 "物90 火10" → 主伤害类型 + 属性系数
      const damageStr = section.fields['伤害'] || '';
      const damageTypes = parseDamageField(damageStr);

      // 解析属性字段：如 "随机攻击 随机防御 随机特殊"
      const affixStr = section.fields['属性'] || '';
      const affixes = affixStr.split(/\s+/).filter(s => s);

      // 攻击文本引用
      const attackTextName = section.fields['攻击文本'] || '';
      const attackTextJson = attackTextName ? JSON.stringify([attackTextName]) : '[]';

      // 冷却时间
      const cooldown = parseFloat(section.fields['冷却']) || 0;

      // 锁定时间
      const lockTime = parseInt(section.fields['锁定']) || 0;

      // 描述
      const description = section.fields['说明'] || '';

      await prisma.gameEquipment.upsert({
        where: { name: section.name },
        update: {
          description,
          equipType: '武器',
          specialSeq,
          damageType: damageTypes.primaryType,
          cooldown,
          lockTime,
          bonus: JSON.stringify(affixes),
          properties: JSON.stringify(damageTypes.properties),
          attackText: attackTextJson,
          buffs: '[]',
        },
        create: {
          name: section.name,
          description,
          equipType: '武器',
          specialSeq,
          damageType: damageTypes.primaryType,
          cooldown,
          lockTime,
          bonus: JSON.stringify(affixes),
          properties: JSON.stringify(damageTypes.properties),
          attackText: attackTextJson,
          buffs: '[]',
        },
      });
      success++;
    } catch (err) {
      errors++;
      console.error(`❌ 导入武器失败: [${section.name}]`, (err as Error).message);
    }
  }

  console.log(`   ✅ 成功: ${success}, ❌ 失败: ${errors}`);
  return { success, errors };
}

/**
 * 解析伤害字段
 * 格式: "物90 火10" 或 "电100" 等
 * 返回主伤害类型和属性系数JSON
 */
function parseDamageField(damageStr: string): { primaryType: string; properties: Record<string, number> } {
  // 伤害类型映射
  const TYPE_MAP: Record<string, string> = {
    '物': '物理',
    '火': '火焰',
    '冰': '冰冻',
    '电': '雷电',
  };

  const properties: Record<string, number> = {};
  let maxPercent = 0;
  let primaryType = '物理'; // 默认

  // 匹配 "物90" "火10" 等模式
  const parts = damageStr.split(/\s+/);
  for (const part of parts) {
    const m = part.match(/^([物火冰电])([\d.]+)$/);
    if (m) {
      const typeKey = m[1];
      const percent = parseFloat(m[2]);
      const typeName = TYPE_MAP[typeKey] || '物理';
      properties[typeName] = percent;

      if (percent > maxPercent) {
        maxPercent = percent;
        primaryType = typeName;
      }
    }
  }

  // 如果没有匹配到任何伤害类型，使用默认
  if (Object.keys(properties).length === 0) {
    properties['物理'] = 100;
  }

  return { primaryType, properties };
}

// ========== 7. 装备导入 ==========

/**
 * 从 使魔大战.txt 解析 类型=装备 的节
 * 导入到 GameEquipment 表
 */
async function importEquipment(
  constantMappings: ConstantMappings
): Promise<{ success: number; errors: number }> {
  console.log('\n📋 ====== 7. 导入装备 ======');
  const sections = parseConfigFile(DATA_FILE);
  const equipSections = sections.filter(s => s.type === '装备');
  console.log(`📊 找到 ${equipSections.length} 个装备节`);

  let success = 0;
  let errors = 0;

  for (const section of equipSections) {
    try {
      // 位置字段
      const equipType = section.fields['位置'] || '';

      // 描述
      const description = section.fields['说明'] || '';

      // 属性字段：词条列表
      const affixStr = section.fields['属性'] || '';
      const affixes = affixStr.split(/\s+/).filter(s => s);

      // 特殊序号
      const specialSeq = constantMappings.equipment[section.name] || 0;

      await prisma.gameEquipment.upsert({
        where: { name: section.name },
        update: {
          description,
          equipType,
          specialSeq,
          affixes: JSON.stringify(affixes),
        },
        create: {
          name: section.name,
          description,
          equipType,
          specialSeq,
          affixes: JSON.stringify(affixes),
        },
      });
      success++;
    } catch (err) {
      errors++;
      console.error(`❌ 导入装备失败: [${section.name}]`, (err as Error).message);
    }
  }

  console.log(`   ✅ 成功: ${success}, ❌ 失败: ${errors}`);
  return { success, errors };
}

// ========== 8. 怪物导入 ==========

/**
 * 从 使魔大战.txt 解析 类型=怪物 的节
 * 导入到 GameMonster 表
 */
async function importMonsters(): Promise<{ success: number; errors: number }> {
  console.log('\n📋 ====== 8. 导入怪物 ======');
  const sections = parseConfigFile(DATA_FILE);
  const monsterSections = sections.filter(s => s.type === '怪物');
  console.log(`📊 找到 ${monsterSections.length} 个怪物节`);

  let success = 0;
  let errors = 0;

  for (const section of monsterSections) {
    try {
      const hp = parseFloat(section.fields['生命']) || 0;
      const dodge = parseFloat(section.fields['闪避']) || 0;
      const hit = parseFloat(section.fields['命中']) || 0;
      const regenHp = parseFloat(section.fields['生命回复']) || 0;

      // 所有字段存为 bonus JSON
      const bonus: Record<string, any> = {};
      for (const [key, value] of Object.entries(section.fields)) {
        // 尝试解析数值
        const numVal = parseFloat(value);
        bonus[key] = isNaN(numVal) ? value : numVal;
      }

      await prisma.gameMonster.upsert({
        where: { name: section.name },
        update: {
          specialSeq: -1,
          type: '怪物',
          level: 1,
          hp,
          attack: 0,
          defense: 0,
          speed: 100,
          dodge,
          hit,
          bonus: JSON.stringify(bonus),
        },
        create: {
          name: section.name,
          specialSeq: -1,
          type: '怪物',
          level: 1,
          hp,
          attack: 0,
          defense: 0,
          speed: 100,
          dodge,
          hit,
          bonus: JSON.stringify(bonus),
        },
      });
      success++;
    } catch (err) {
      errors++;
      console.error(`❌ 导入怪物失败: [${section.name}]`, (err as Error).message);
    }
  }

  console.log(`   ✅ 成功: ${success}, ❌ 失败: ${errors}`);
  return { success, errors };
}

// ========== 9. 地图导入 ==========

/**
 * 从 使魔大战.txt 解析 类型=地图 的节
 * 导入到 GameMap 表
 */
async function importMaps(): Promise<{ success: number; errors: number }> {
  console.log('\n📋 ====== 9. 导入地图 ======');
  const sections = parseConfigFile(DATA_FILE);
  const mapSections = sections.filter(s => s.type === '地图');
  console.log(`📊 找到 ${mapSections.length} 个地图节`);

  let success = 0;
  let errors = 0;

  for (const section of mapSections) {
    try {
      const description = section.fields['说明'] || '';

      // 解析怪物列表：空格分隔的怪物名称
      const monsters = section.fields['怪物']
        ? section.fields['怪物'].split(/\s+/).filter(s => s)
        : [];

      // 解析资源列表：空格分隔的资源名称
      const resources = section.fields['资源']
        ? section.fields['资源'].split(/\s+/).filter(s => s)
        : [];

      // 解析可前往：格式 "地图名，距离 地图名，距离"
      const connections: Array<{ name: string; distance: number }> = [];
      const connStr = section.fields['可前往'] || '';
      if (connStr) {
        // 先按空格分割条目
        const connEntries = connStr.split(/\s+/);
        for (const entry of connEntries) {
          const parts = entry.split(/[,，]/);
          if (parts.length >= 2) {
            connections.push({
              name: parts[0].trim(),
              distance: parseInt(parts[1]) || 0,
            });
          }
        }
      }

      // 解析布尔/数值字段
      const noTeleport = section.fields['不可传送'] === '1';
      const isInstance = section.fields['关卡'] === '1';
      const requireMarkers = section.fields['标记要求'] || '';
      const failHint = section.fields['标记提示'] || '';
      const monsterCount = parseInt(section.fields['怪物数量']) || 3;

      await prisma.gameMap.upsert({
        where: { name: section.name },
        update: {
          description,
          monsters: JSON.stringify(monsters),
          resources: JSON.stringify(resources),
          connections: JSON.stringify(connections),
          noTeleport,
          isInstance,
          requireMarkers: JSON.stringify(requireMarkers ? [requireMarkers] : []),
          failHint,
          monsterCount,
        },
        create: {
          name: section.name,
          description,
          monsters: JSON.stringify(monsters),
          resources: JSON.stringify(resources),
          connections: JSON.stringify(connections),
          noTeleport,
          isInstance,
          requireMarkers: JSON.stringify(requireMarkers ? [requireMarkers] : []),
          failHint,
          monsterCount,
        },
      });
      success++;
    } catch (err) {
      errors++;
      console.error(`❌ 导入地图失败: [${section.name}]`, (err as Error).message);
    }
  }

  console.log(`   ✅ 成功: ${success}, ❌ 失败: ${errors}`);
  return { success, errors };
}

// ========== 10. 使魔导入 ==========

/**
 * 从 使魔大战.txt 解析 类型=使魔 的节
 * 导入到 GameFamiliar 表
 */
async function importFamiliars(
  constantMappings: ConstantMappings
): Promise<{ success: number; errors: number }> {
  console.log('\n📋 ====== 10. 导入使魔 ======');
  const sections = parseConfigFile(DATA_FILE);
  const familiarSections = sections.filter(s => s.type === '使魔');
  console.log(`📊 找到 ${familiarSections.length} 个使魔节`);

  let success = 0;
  let errors = 0;

  for (const section of familiarSections) {
    try {
      const description = section.fields['说明'] || '';
      const skillDesc = section.fields['技能说明'] || '';
      const uniqueSkill = section.fields['技能'] || '';
      const noSummon = section.fields['不可召唤'] === '1';

      // 特殊序号
      const specialSeq = constantMappings.familiars[section.name] || 0;

      // 好感度描述：好感1~好感5
      const affinityDesc: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const val = section.fields[`好感${i}`];
        if (val) {
          affinityDesc.push(val);
        }
      }

      await prisma.gameFamiliar.upsert({
        where: { name: section.name },
        update: {
          uniqueSkill,
          description,
          skillDesc,
          specialSeq,
          noSummon,
          affinityDesc: JSON.stringify(affinityDesc),
        },
        create: {
          name: section.name,
          uniqueSkill,
          description,
          skillDesc,
          specialSeq,
          noSummon,
          affinityDesc: JSON.stringify(affinityDesc),
        },
      });
      success++;
    } catch (err) {
      errors++;
      console.error(`❌ 导入使魔失败: [${section.name}]`, (err as Error).message);
    }
  }

  console.log(`   ✅ 成功: ${success}, ❌ 失败: ${errors}`);
  return { success, errors };
}

// ========== 11. 物品导入 (从资源节) ==========

/**
 * 从 使魔大战.txt 中 类型=资源 的节提取产出物品名
 * 注册到 GameItem 表
 */
async function importItems(): Promise<{ success: number; errors: number }> {
  console.log('\n📋 ====== 11. 导入物品(从资源节) ======');
  const sections = parseConfigFile(DATA_FILE);
  const resourceSections = sections.filter(s => s.type === '资源');
  console.log(`📊 找到 ${resourceSections.length} 个资源节`);

  // 收集所有物品名
  const itemNames = new Set<string>();

  for (const section of resourceSections) {
    const outputStr = section.fields['产出'] || '';
    if (!outputStr) continue;

    // 产出格式: "物品名，数量，概率 物品名，数量，概率"
    const entries = outputStr.split(/\s+/);
    for (const entry of entries) {
      const parts = entry.split(/[,，]/);
      if (parts.length >= 1) {
        const name = parts[0].trim();
        if (name) {
          itemNames.add(name);
        }
      }
    }
  }

  console.log(`📊 共收集到 ${itemNames.size} 个唯一物品名`);

  let success = 0;
  let errors = 0;

  for (const name of Array.from(itemNames)) {
    try {
      await prisma.gameItem.upsert({
        where: { name },
        update: {
          // 不覆盖已有数据，只确保存在
        },
        create: {
          name,
          description: '',
          type: '资源产出',
        },
      });
      success++;
    } catch (err) {
      errors++;
      console.error(`❌ 导入物品失败: [${name}]`, (err as Error).message);
    }
  }

  console.log(`   ✅ 成功: ${success}, ❌ 失败: ${errors}`);
  return { success, errors };
}

// ========== 主入口 ==========

async function main() {
  console.log('🚀 开始导入补充数据...\n');

  const results: Record<string, { success: number; errors: number } | { success: boolean }> = {};

  // 1. 导入蓝图数据
  results.blueprints = await importBlueprints();

  // 2. 导入套装效果
  results.setEffects = await importSetEffects();

  // 3. 导入种子数据
  results.seedItems = await importSeedItems();

  // 4. 导入跳过的类型数据
  results.skippedTypes = await importSkippedTypes();

  // 解析常量映射（用于武器、使魔、装备的特殊序号）
  const constantMappings = parseConstantEcode();

  // 5. 导入攻击文本
  results.attackTexts = await importAttackTexts();

  // 6. 导入武器
  results.weapons = await importWeapons(constantMappings);

  // 7. 导入装备
  results.equipment = await importEquipment(constantMappings);

  // 8. 导入怪物
  results.monsters = await importMonsters();

  // 9. 导入地图
  results.maps = await importMaps();

  // 10. 导入使魔
  results.familiars = await importFamiliars(constantMappings);

  // 11. 导入物品
  results.items = await importItems();

  // 汇总
  console.log('\n🎉 ====== 导入完成 ======');
  console.log(`   蓝图:      ${(results.blueprints as any).success} 成功, ${(results.blueprints as any).errors} 失败`);
  console.log(`   套装效果:  ${(results.setEffects as any).success} 成功, ${(results.setEffects as any).errors} 失败`);
  console.log(`   种子数据:  ${(results.seedItems as any).success ? '成功' : '失败'}`);
  console.log(`   跳过类型:  ${(results.skippedTypes as any).success} 成功, ${(results.skippedTypes as any).errors} 失败`);
  console.log(`   攻击文本:  ${(results.attackTexts as any).success} 成功, ${(results.attackTexts as any).errors} 失败`);
  console.log(`   武器:      ${(results.weapons as any).success} 成功, ${(results.weapons as any).errors} 失败`);
  console.log(`   装备:      ${(results.equipment as any).success} 成功, ${(results.equipment as any).errors} 失败`);
  console.log(`   怪物:      ${(results.monsters as any).success} 成功, ${(results.monsters as any).errors} 失败`);
  console.log(`   地图:      ${(results.maps as any).success} 成功, ${(results.maps as any).errors} 失败`);
  console.log(`   使魔:      ${(results.familiars as any).success} 成功, ${(results.familiars as any).errors} 失败`);
  console.log(`   物品:      ${(results.items as any).success} 成功, ${(results.items as any).errors} 失败`);
  console.log('');
}

main()
  .catch((e) => {
    console.error('导入过程发生错误:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });