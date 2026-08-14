/**
 * 使魔大战3 数据导入脚本
 * 从 使魔大战.txt 解析游戏配置数据并导入到数据库
 * 运行: npx ts-node prisma/seed-data.ts
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

// 数据文件路径 (相对于 prisma 目录)
const DATA_FILE = path.resolve(__dirname, '../../e/使魔大战.txt');

// ========== 解析工具函数 ==========

/**
 * 解析掉落/产出格式字符串
 * 格式: "物品名，数量，概率 物品名，数量，概率"
 * 分隔符支持空格、中文顿号、逗号
 * 概率为 -1 表示必定掉落
 */
function parseDropString(str: string): Array<{ name: string; count: number; chance: number }> {
  if (!str || str.trim() === '') return [];
  const result: Array<{ name: string; count: number; chance: number }> = [];

  // 先按空格分割各组
  const groups = str.trim().split(/\s+/);
  for (const group of groups) {
    if (!group.trim()) continue;
    // 按逗号或中文逗号分割
    const parts = group.split(/[,，、]/).map((s: string) => s.trim()).filter((s: string) => s);
    if (parts.length >= 2) {
      const name = parts[0];
      const count = parseFloat(parts[1]) || 0;
      const chance = parts.length >= 3 ? parseFloat(parts[2]) : -1;
      result.push({ name, count, chance });
    }
  }
  return result;
}

/**
 * 解析物品数量格式字符串 (用于制造产出/需求、称号奖励/要求等)
 * 格式: "物品名，数量 物品名，数量"
 * 有些字段可能包含几率信息，只取前两个字段
 */
function parseItemCountString(str: string): Array<{ name: string; count: number }> {
  if (!str || str.trim() === '') return [];
  const result: Array<{ name: string; count: number }> = [];

  const groups = str.trim().split(/\s+/);
  for (const group of groups) {
    if (!group.trim()) continue;
    const parts = group.split(/[,，、]/).map((s: string) => s.trim()).filter((s: string) => s);
    if (parts.length >= 2) {
      result.push({ name: parts[0], count: parseFloat(parts[1]) || 0 });
    } else if (parts.length === 1) {
      // 只有名字没有数量，默认为1
      result.push({ name: parts[0], count: 1 });
    }
  }
  return result;
}

/**
 * 解析资源产出格式字符串 (用于 资源/作物 类型的「产出」「产出2」字段)
 * 格式: "物品名<数量>，<几率> 物品名<数量>，<几率>"
 * 例: "能量块1，50 载具零件0.1，50 信号枪，2 合金1，25"
 * 说明: 数量紧贴在名称后(如"能量块1")，逗号后为几率百分比；缺省数量=1，缺省几率=100
 */
function parseResourceOutput(str: string): Array<{ name: string; quantity: number; chance: number }> {
  if (!str || str.trim() === '') return [];
  const result: Array<{ name: string; quantity: number; chance: number }> = [];
  const groups = str.trim().split(/\s+/);
  for (const group of groups) {
    if (!group.trim()) continue;
    // 名称(非数字非逗号前缀) + 紧贴数量(可选) + [，几率](可选)
    const m = group.match(/^([^，,\d]+)(\d+(?:\.\d+)?)?(?:[，,](\d+(?:\.\d+)?))?$/);
    if (m && m[1]) {
      result.push({
        name: m[1].trim(),
        quantity: m[2] ? parseFloat(m[2]) : 1,
        chance: m[3] ? parseFloat(m[3]) : 100,
      });
    } else {
      // 无法解析时整组作为名称兜底
      result.push({ name: group, quantity: 1, chance: 100 });
    }
  }
  return result;
}

/**
 * 解析地图连接格式
 * 格式: "地图名，距离 地图名，距离"
 */
function parseConnectionString(str: string): Array<{ name: string; distance: number }> {
  if (!str || str.trim() === '') return [];
  const result: Array<{ name: string; distance: number }> = [];

  const groups = str.trim().split(/\s+/);
  for (const group of groups) {
    if (!group.trim()) continue;
    const parts = group.split(/[,，]/).map((s: string) => s.trim()).filter((s: string) => s);
    if (parts.length >= 1) {
      result.push({
        name: parts[0],
        distance: parts.length >= 2 ? parseFloat(parts[1]) || 0 : 0,
      });
    }
  }
  return result;
}

/**
 * 解析空格分隔的属性列表
 * 格式: "属性1 属性2 属性3"
 */
function parseSpaceSeparatedString(str: string): string[] {
  if (!str || str.trim() === '') return [];
  return str.trim().split(/\s+/).filter((s: string) => s);
}

/**
 * 解析分号分隔的文本列表
 * 格式: "文本1；文本2；文本3"
 */
function parseSemicolonString(str: string): string[] {
  if (!str || str.trim() === '') return [];
  return str.split(/[；;]/).map((s: string) => s.trim()).filter((s: string) => s);
}

/**
 * 解析伤害字符串为数值对象
 * 格式: "物100 火50" 或 "物100"
 */
function parseDamageString(str: string): Record<string, number> {
  if (!str || str.trim() === '') return {};
  const result: Record<string, number> = {};
  const parts = str.trim().split(/\s+/);
  for (const part of parts) {
    const match = part.match(/^([^\d]+)([\d.]+)$/);
    if (match) {
      result[match[1]] = parseFloat(match[2]) || 0;
    }
  }
  return result;
}

// ========== 解析配置文件 ==========

interface ConfigSection {
  name: string;
  type: string;
  fields: Record<string, string>;
}

/**
 * 读取并解析配置文件
 * 返回节数组，每个节包含名称、类型和字段键值对
 */
function parseConfigFile(): ConfigSection[] {
  console.log(`📖 读取数据文件: ${DATA_FILE}`);
  const buf = fs.readFileSync(DATA_FILE);
  const txt = iconv.decode(buf, 'gbk');

  const sections: ConfigSection[] = [];
  const lines = txt.split(/\r?\n/);

  let currentSection: ConfigSection | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // 跳过空行和注释
    if (!trimmed) continue;

    // 匹配节头 [节名]
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      // 保存上一个节
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

  // 保存最后一个节
  if (currentSection) {
    sections.push(currentSection);
  }

  console.log(`📊 解析完成: 共 ${sections.length} 个节`);
  return sections;
}

// ========== 数据映射函数 ==========

/**
 * 将 武器 类型数据映射到 GameEquipment
 */
function mapWeaponToEquipment(section: ConfigSection) {
  const fields = section.fields;

  // 解析伤害
  const damage = parseDamageString(fields['伤害'] || '');

  // 解析属性
  const properties = parseSpaceSeparatedString(fields['属性'] || '');

  // 构建 bonus 对象
  const bonus: Record<string, any> = {};

  // 基础数值字段
  const numericFields = ['冷却', '贯穿', '暴击', '命中', '范围', '溅射', '溅射数量',
    '锁定', '攻击次数', '攻击护盾', '攻击装甲', '攻击生命', '采集', '魅力',
    '命中2', '闪避2', '暴击伤害', '麻醉', 'aoe', '必中', '必中2',
    '冷却2', '护盾穿透', '装甲穿透', '生命穿透',
    '吸生命', '吸护盾', '吸装甲', '吸生命2', '吸护盾2', '吸装甲2',
    '攻击2', '物攻2', '火攻2', '冰攻2', '电攻2',
    '溅射2', '冷却2', '溅射数量2'];

  for (const key of numericFields) {
    if (fields[key] !== undefined) {
      bonus[key] = parseFloat(fields[key]) || 0;
    }
  }

  // 特殊字段
  if (fields['增益']) {
    const buffs = parseSpaceSeparatedString(fields['增益']);
    bonus['buffs'] = buffs;
  }

  // 攻击文本
  const attackTextObj: Record<string, any> = { name: fields['攻击文本'] || '' };

  // 构建属性对象
  const propertiesObj: Record<string, any> = {};
  if (properties.length > 0) {
    propertiesObj['attrs'] = properties;
  }
  // 合并伤害到属性
  if (Object.keys(damage).length > 0) {
    propertiesObj['damage'] = damage;
  }

  return {
    name: section.name,
    description: fields['说明'] || '',
    equipType: fields['分类'] || '武器',
    specialSeq: 0,
    specialEffect: 0,
    damageType: '物理',
    cooldown: parseFloat(fields['冷却']) || 5,
    lockTime: parseInt(fields['锁定']) || 0,
    forcedEffect: fields['必中'] === '1',
    vehicleForceDmg: false,
    bonus: JSON.stringify(bonus),
    baseBonus: '{}',
    properties: JSON.stringify(propertiesObj),
    affixes: '[]',
    attackText: JSON.stringify(attackTextObj),
    buffs: JSON.stringify(parseSpaceSeparatedString(fields['增益'] || '')),
    negativeType: 0,
  };
}

/**
 * 将 装备 类型数据映射到 GameEquipment
 */
function mapEquipmentToEquipment(section: ConfigSection) {
  const fields = section.fields;

  // 构建 bonus 对象
  const bonus: Record<string, any> = {};

  // 常见数值字段
  const numericFields = ['防御', '生命', '强化', '攻击', '闪避', '命中', '暴击',
    '暴击伤害', '速度', '护盾', '装甲', '魔力', '韧性', '魅力',
    '生命回复', '护盾回复', '装甲回复',
    '生命火抗', '生命冰抗', '生命物抗', '生命电抗',
    '装甲火抗', '装甲冰抗', '装甲物抗', '装甲电抗',
    '护盾火抗', '护盾冰抗', '护盾物抗', '护盾电抗',
    '火伤', '冰伤', '物伤', '电伤',
    '生命回复2', '护盾回复2', '装甲回复2',
    '闪避2', '命中2', '采集'];

  for (const key of numericFields) {
    if (fields[key] !== undefined) {
      bonus[key] = parseFloat(fields[key]) || 0;
    }
  }

  // 属性
  const properties = parseSpaceSeparatedString(fields['属性'] || '');
  const propertiesObj: Record<string, any> = {};
  if (properties.length > 0) {
    propertiesObj['attrs'] = properties;
  }

  // 攻击文本
  const attackTextObj: Record<string, any> = {};
  if (fields['攻击文本']) {
    attackTextObj['name'] = fields['攻击文本'];
  }

  return {
    name: section.name,
    description: fields['说明'] || '',
    equipType: fields['位置'] || '装备',
    specialSeq: 0,
    specialEffect: 0,
    damageType: '物理',
    cooldown: 5,
    lockTime: 0,
    forcedEffect: false,
    vehicleForceDmg: false,
    bonus: JSON.stringify(bonus),
    baseBonus: '{}',
    properties: JSON.stringify(propertiesObj),
    affixes: '[]',
    attackText: JSON.stringify(attackTextObj),
    buffs: '[]',
    negativeType: 0,
  };
}

/**
 * 将 怪物 类型数据映射到 GameMonster
 */
function mapMonsterToMonster(section: ConfigSection) {
  const fields = section.fields;

  const bonus: Record<string, any> = {};

  // 基础战斗属性
  const combatFields = ['武器', '闪避', '命中', '暴击', '暴击伤害', '速度',
    '生命回复', '护盾回复', '装甲回复', '经验', '麻醉', '韧性',
    '生命火抗', '生命冰抗', '生命物抗', '生命电抗',
    '装甲火抗', '装甲冰抗', '装甲物抗', '装甲电抗',
    '护盾火抗', '护盾冰抗', '护盾物抗', '护盾电抗',
    '火伤', '冰伤', '物伤', '电伤',
    '生命回复2', '护盾回复2', '装甲回复2',
    '闪避2', '命中2', '必中',
    '产奶量', '载具', '说明', '装备',
    '电伤', '火伤', '物伤', '冰伤',
    '护盾', '装甲'];

  for (const key of combatFields) {
    if (fields[key] !== undefined) {
      const val = fields[key];
      const num = parseFloat(val);
      bonus[key] = isNaN(num) ? val : num;
    }
  }

  // 解析掉落
  if (fields['掉落']) {
    bonus['drops'] = parseDropString(fields['掉落']);
  }

  // 解析武器列表
  if (fields['武器']) {
    bonus['weapons'] = parseSpaceSeparatedString(fields['武器']);
  }

  // 解析装备列表
  if (fields['装备']) {
    bonus['equipmentList'] = parseSpaceSeparatedString(fields['装备']);
  }

  const level = parseInt(fields['等级']) || 1;

  // 三层池：护盾 / 装甲（原版怪物有独立护盾与装甲，缺省视为0）
  const shield = parseFloat(fields['护盾']) || 0;
  const armor = parseFloat(fields['装甲']) || 0;

  return {
    name: section.name,
    specialSeq: -1,
    type: '怪物',
    description: fields['说明'] || '',
    level: level,
    hp: parseFloat(fields['生命']) || 100,
    maxHp: parseFloat(fields['生命']) || 100,
    attack: parseFloat(fields['攻击']) || 10,
    defense: parseFloat(fields['防御']) || 0,
    speed: parseFloat(fields['速度']) || 100,
    dodge: parseFloat(fields['闪避']) || 0,
    hit: parseFloat(fields['命中']) || 100,
    shield,
    maxShield: shield,
    armor,
    maxArmor: armor,
    bonus: JSON.stringify(bonus),
  };
}

/**
 * 将 物品 类型数据映射到 GameItem
 */
function mapItemToItem(section: ConfigSection) {
  const fields = section.fields;

  // 解析使用可得
  const useEffects: string[] = [];
  if (fields['使用可得']) {
    const items = parseItemCountString(fields['使用可得']);
    useEffects.push(...items.map(i => `${i.name} x${i.count}`));
  }

  // 解析使用可得标记
  const useMarkers = parseSpaceSeparatedString(fields['使用可得标记'] || '');

  return {
    name: section.name,
    description: fields['说明'] || '',
    value: parseFloat(fields['价值']) || 0,
    type: '物品',
    useEffects: JSON.stringify(useEffects),
    useMarkers: JSON.stringify(useMarkers),
  };
}

/**
 * 将 使魔 类型数据映射到 GameFamiliar
 */
function mapFamiliarToFamiliar(section: ConfigSection) {
  const fields = section.fields;

  // 好感度描述
  const affinityDesc: string[] = [];
  for (let i = 1; i <= 5; i++) {
    if (fields[`好感${i}`]) {
      affinityDesc.push(fields[`好感${i}`]);
    }
  }

  // 解析不可召唤
  const noSummon = fields['不可召唤'] === '1';

  return {
    name: section.name,
    uniqueSkill: fields['技能'] || '',
    description: fields['说明'] || '',
    description2: fields['简略说明'] || '',
    skillDesc: fields['技能说明'] || '',
    specialSeq: parseInt(fields['特殊序号']) || 0,
    noSummon: noSummon,
    hairDrop: '{}',
    affinityDesc: JSON.stringify(affinityDesc),
  };
}

/**
 * 资源类型定义映射
 * 由「资源」类型 section 收集，供地图资源关联产出数据（探测/牵引/采集使用）
 */
interface ResourceDef {
  times: number;        // 可采集次数
  outputs: Array<{ name: string; quantity: number; chance: number }>;   // 采集产出
  outputs2: Array<{ name: string; quantity: number; chance: number }>;  // 作物产出
  gatherCmd: string;    // 采集指令
}

/**
 * 将 地图 类型数据映射到 GameMap
 * @param section 地图配置节
 * @param resourceDefs 资源类型定义映射（用于把地图资源名关联到产出数据）
 */
function mapMapToMap(section: ConfigSection, resourceDefs?: Map<string, ResourceDef>) {
  const fields = section.fields;

  // 解析怪物列表
  const monsters = parseSpaceSeparatedString(fields['怪物'] || '');

  // 解析资源列表，关联资源类型定义（产出/次数/采集指令），供探测/牵引/采集使用
  const resourceNames = parseSpaceSeparatedString(fields['资源'] || '');
  const resources = resourceNames.map((name) => {
    const def = resourceDefs?.get(name);
    if (def) {
      return {
        name,
        type: '资源',
        times: def.times,
        outputs: def.outputs,
        outputs2: def.outputs2,
        gatherCmd: def.gatherCmd,
      };
    }
    // 找不到资源类型定义时保留名称（不阻断导入）
    return { name, type: '资源', times: 1, outputs: [], outputs2: [], gatherCmd: '' };
  });

  // 解析连接
  const connections = parseConnectionString(fields['可前往'] || '');

  // 解析关卡
  const isInstance = fields['关卡'] === '1';

  // 解析不可传送
  const noTeleport = fields['不可传送'] === '1';

  // 解析复活点
  const spawnMonsters: string[] = [];
  if (fields['复活点']) {
    spawnMonsters.push(fields['复活点']);
  }

  // 额外字段
  const extraFields: Record<string, any> = {};
  const extraKeys = ['复活要求', '复活提示', '不可搬迁', '等级'];
  for (const key of extraKeys) {
    if (fields[key] !== undefined) {
      extraFields[key] = fields[key];
    }
  }

  return {
    name: section.name,
    description: fields['说明'] || '',
    mapIndex: 0,
    level: parseInt(fields['等级']) || 1,
    isFrontier: false,
    noTeleport: noTeleport,
    noMove: false,
    isInstance: isInstance,
    requiredTravel: 0,
    monsters: JSON.stringify(monsters),
    spawnMonsters: JSON.stringify(spawnMonsters),
    tempMonsters: '[]',
    summons: '[]',
    resources: JSON.stringify(resources),
    resources2: '[]',
    connections: JSON.stringify(connections),
    npcs: '[]',
    items: '[]',
    buildings: '[]',
    vehicles: '[]',
    markers: '{}',
    markers2: '[]',
    mapBuffs: '[]',
    requireMarkers: JSON.stringify(parseSpaceSeparatedString(fields['复活要求'] || '')),
    failHint: fields['复活提示'] || '',
    clearMarkers: '',
    music: '',
    monsterCount: parseInt(fields['刷怪数量']) || 3,
    noSpecial: false,
  };
}

/**
 * 将 制造 类型数据映射到 GameCrafting
 */
function mapCraftingToCrafting(section: ConfigSection) {
  const fields = section.fields;

  const outputs = parseItemCountString(fields['产出'] || '');
  const requirements = parseItemCountString(fields['需求'] || '');

  return {
    name: section.name,
    description: fields['说明'] || '',
    noCraft: fields['不可制造'] === '1',
    level: 1,
    deconstructMul: parseFloat(fields['分解倍率']) || 5,
    expGain: parseFloat(fields['经验']) || 0,
    outputs: JSON.stringify(outputs),
    requirements: JSON.stringify(requirements),
    gainMarkers: '[]',
  };
}

/**
 * 将 称号 类型数据映射到 GameTitle
 */
function mapTitleToTitle(section: ConfigSection) {
  const fields = section.fields;

  const rewards = parseItemCountString(fields['奖励'] || '');
  const requirements = parseItemCountString(fields['要求'] || '');

  return {
    name: section.name,
    description: fields['升级经验'] || '',
    bonus: '{}',
    requirements: JSON.stringify(requirements),
    rewards: JSON.stringify(rewards),
  };
}

/**
 * 将 建筑 类型数据映射到 GameBuilding
 */
function mapBuildingToBuilding(section: ConfigSection) {
  const fields = section.fields;

  return {
    name: section.name,
    type: '建筑',
    description: fields['说明'] || '',
    storage: 0,
    materials: JSON.stringify(parseItemCountString(fields['产出'] || '')),
  };
}

/**
 * 将 载具 类型数据映射到 GameVehicle
 */
function mapVehicleToVehicle(section: ConfigSection) {
  const fields = section.fields;

  const bonus: Record<string, any> = {};
  const moveType = parseInt(fields['行走']) || 0;
  const weaponSlots = parseInt(fields['武器']) || 0;
  const defenseSlots = parseInt(fields['装甲']) || 0;

  // 额外字段
  if (fields['限制']) bonus['限制'] = fields['限制'];
  if (fields['说明']) bonus['说明'] = fields['说明'];

  return {
    name: section.name,
    vehicleId: '',
    type: fields['限制'] || '',
    owner: '',
    driver: '',
    moveType: moveType,
    maxHp: defenseSlots * 100 || 100,
    currentHp: defenseSlots * 100 || 100,
    mapIndex: 0,
    weaponSlots: weaponSlots,
    defenseSlots: defenseSlots,
    moveSlots: moveType,
    functionSlots: 0,
    maxWeapon: 5,
    maxDefense: 5,
    maxMove: 5,
    maxFunction: 5,
    slotStatus: 0,
    bonus: JSON.stringify(bonus),
    parts: '[]',
    markers: '{}',
    markers2: '[]',
    recipes: '[]',
    builtinParts: '[]',
    coating: 0,
    reverseField: false,
  };
}

/**
 * 将 文本 类型数据映射到 GameAttackText
 */
function mapTextToAttackText(section: ConfigSection) {
  const fields = section.fields;

  return {
    name: section.name,
    forMonster: false,
    attackTexts: JSON.stringify(parseSemicolonString(fields['攻击'] || '')),
    shieldBreak: JSON.stringify(parseSemicolonString(fields['破盾'] || '')),
    armorBreak: JSON.stringify(parseSemicolonString(fields['破甲'] || '')),
    killTexts: JSON.stringify(parseSemicolonString(fields['击杀'] || '')),
    missTexts: JSON.stringify(parseSemicolonString(fields['闪避'] || '')),
    lockTexts: JSON.stringify(parseSemicolonString(fields['锁定'] || '')),
  };
}

/**
 * 将 增益 类型数据映射到 GameBuff
 */
function mapBuffToBuff(section: ConfigSection) {
  const fields = section.fields;

  // 构建 bonus 对象，包含所有数值修改字段
  const bonus: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    // 排除已知的文本字段
    if (['文本', '几率', '持续时间'].includes(key)) continue;
    const num = parseFloat(value);
    bonus[key] = isNaN(num) ? value : num;
  }

  return {
    name: section.name,
    description: fields['文本'] || '',
    duration: parseInt(fields['持续时间']) || 0,
    chance: parseFloat(fields['几率']) || 100,
    stackTime: false,
    bonus: JSON.stringify(bonus),
    triggerText: fields['文本'] || '',
  };
}

/**
 * 将 对话 类型数据映射到 GameNpc
 */
function mapDialogueToNpc(section: ConfigSection) {
  const fields = section.fields;

  return {
    name: section.name,
    taskId: fields['任务'] || '',
    hostileChat: '[]',
    friendlyChat: JSON.stringify(parseSemicolonString(fields['聊天'] || '')),
    followText: JSON.stringify(parseSemicolonString(fields['跟随'] || '')),
    stopText: JSON.stringify(parseSemicolonString(fields['停下'] || '')),
    pickupText: '[]',
    milkText: '[]',
    killText: '[]',
    boostStart: '[]',
    boostEnd: '[]',
    captureText: '[]',
    lieDownText: '[]',
    wakeUpText: '[]',
    strengthenText: '[]',
  };
}

/**
 * 将 任务 类型数据映射到 GameTask
 */
function mapTaskToTask(section: ConfigSection) {
  const fields = section.fields;

  const rewards = parseItemCountString(fields['奖励'] || '');
  const requirements = parseItemCountString(fields['要求'] || '');

  return {
    name: section.name,
    description: fields['说明'] || '',
    chance: 100,
    level: 1,
    publisher: '',
    requirements: JSON.stringify(requirements),
    rewards: JSON.stringify(rewards),
    nextTasks: '[]',
    restrictMarkers: '[]',
  };
}

/**
 * 将 特效 类型数据映射到 GameEffect
 * 限制字段指明适用于 装备/武器；bonus 存储全部数值加成
 */
function mapEffectToEffect(section: ConfigSection) {
  const fields = section.fields;
  const bonus: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    // 排除文本字段
    if (['说明', '限制'].includes(key)) continue;
    const num = parseFloat(value);
    bonus[key] = isNaN(num) ? value : num;
  }
  return {
    name: section.name,
    description: fields['说明'] || '',
    limit: fields['限制'] || '',
    bonus: JSON.stringify(bonus),
  };
}

/**
 * 将 资源 类型数据映射到 GameResource
 * 含 产出/产出2/使用可得/标记/代发言/时间倍率/不可再生 等完整字段
 */
function mapResourceToResource(section: ConfigSection) {
  const fields = section.fields;
  return {
    name: section.name,
    description: fields['说明'] || '',
    times: parseInt(fields['次数'] || '1') || 1,
    gatherCmd: fields['采集指令'] || '',
    timeScale: parseFloat(fields['时间倍率'] || '1') || 1,
    renewable: fields['不可再生'] !== '1',
    gatherText: fields['采集文本'] || '',
    marker: fields['标记'] || '',
    proxySpeak: fields['代发言'] || '',
    outputs: JSON.stringify(parseResourceOutput(fields['产出'] || '')),
    outputs2: JSON.stringify(parseResourceOutput(fields['产出2'] || '')),
    useGet: JSON.stringify(parseItemCountString(fields['使用可得'] || '')),
    useMarkers: JSON.stringify(parseSpaceSeparatedString(fields['使用可得标记'] || '')),
  };
}

/**
 * 将 商店 类型数据映射到 GameShop
 * 商店节承载三大兑换商店 + 副本列表 + 图片库 + BGM
 */
function mapShopToShop(section: ConfigSection) {
  const fields = section.fields;
  const imgObj = (keys: string[]) => {
    const obj: Record<string, number> = {};
    for (const k of keys) {
      const v = fields[k];
      if (!v) continue;
      // 格式: "名称1 名称2 ..." 或 "名称数量"（如 流珠3）
      for (const tok of v.trim().split(/\s+/)) {
        const m = tok.match(/^([^\d]+)(\d+)?$/);
        if (m) obj[m[1]] = m[2] ? parseInt(m[2]) : 1;
      }
    }
    return JSON.stringify(obj);
  };
  return {
    // 单节 upsert，只取第一条（商店节全局唯一）
    shopActivity: JSON.stringify(parseItemCountString(fields['活跃度'] || '')),
    shopDiamond: JSON.stringify(parseItemCountString(fields['钻石'] || '')),
    shopData: JSON.stringify(parseItemCountString(fields['数据'] || '')),
    dungeons: JSON.stringify(parseSpaceSeparatedString(fields['副本'] || '')),
    dungeons2: JSON.stringify(parseSpaceSeparatedString(fields['副本2'] || '')),
    robotQQ: fields['机器人'] || '',
    familiarImg: imgObj(['使魔jpg', '使魔png']),
    characterImg: imgObj(['人物jpg', '人物png']),
    monsterImg: imgObj(['怪物jpg', '怪物png']),
    mapImg: imgObj(['地图jpg']),
    travelingEquip: JSON.stringify(parseItemCountString(fields['行商装备'] || '')),
    travelingItem: JSON.stringify(parseItemCountString(fields['行商物品'] || '')),
    bgm: JSON.stringify(fields['bgm'] ? fields['bgm'].split(';').map((s: string) => s.trim()).filter(Boolean) : []),
  };
}

/**
 * 将 更新 类型数据映射到 GameUpdateLog
 * 更新节内容多为多行文本，已拍平为 content 字段
 */
function mapUpdateToUpdateLog(section: ConfigSection) {
  const fields = section.fields;
  // 更新节通常无明确字段名，整体内容在 fields 中（key 可能为行号或文本）
  const content = Object.values(fields).join('\n').trim();
  return {
    name: section.name,
    content,
  };
}

// ========== 主导入函数 ==========

async function importData() {
  console.log('🚀 开始导入游戏数据...\n');

  const sections = parseConfigFile();

  // 先收集所有「资源」类型定义，供地图资源关联产出数据
  const resourceDefs = new Map<string, ResourceDef>();
  for (const section of sections) {
    if (section.type !== '资源') continue;
    resourceDefs.set(section.name, {
      times: parseInt(section.fields['次数'] || '1') || 1,
      outputs: parseResourceOutput(section.fields['产出'] || ''),
      outputs2: parseResourceOutput(section.fields['产出2'] || ''),
      gatherCmd: section.fields['采集指令'] || '',
    });
  }

  // 统计各类型数量
  const typeCounts: Record<string, number> = {};
  for (const section of sections) {
    typeCounts[section.type] = (typeCounts[section.type] || 0) + 1;
  }
  console.log('📋 数据类型分布:');
  for (const [type, count] of Object.entries(typeCounts)) {
    console.log(`   ${type}: ${count}`);
  }
  console.log('');

  // 导入 e/@Resource/ 下的套装效果文本与公共风味文本（原版独立资源文件）
  let setEffectCount = 0;
  let flavorTextCount = 0;
  try {
    const resDir = path.resolve(__dirname, '../../e/@Resource');
    if (fs.existsSync(resDir)) {
      const resFiles = fs.readdirSync(resDir).filter((f) => f.endsWith('.txt'));
      for (const f of resFiles) {
        const raw = fs.readFileSync(path.join(resDir, f));
        const content = new TextDecoder('gbk').decode(raw).trim();
        if (!content) continue;
        // 套装效果文件命名: "XX套装效果.txt" / "XX效果.txt"
        const setMatch = f.match(/^(.+?)(?:套装效果|效果)\.txt$/);
        if (setMatch) {
          const setName = setMatch[1].replace(/套装$/, '') + '套装';
          await prisma.gameSetEffect.upsert({
            where: { name: setName },
            update: { effectText: content, sourceFile: f },
            create: { name: setName, effectText: content, sourceFile: f },
          });
          setEffectCount++;
        } else {
          // 其他公共文本（文本前1/文本后1/种子等）
          const key = f.replace(/\.txt$/, '');
          await prisma.gameFlavorText.upsert({
            where: { name: key },
            update: { content },
            create: { name: key, content },
          });
          flavorTextCount++;
        }
      }
    }
  } catch (err) {
    console.error('⚠️ 导入 @Resource 文本失败:', (err as Error).message);
  }


  // 各类型导入计数器
  const counts = {
    weapon: 0, equipment: 0, monster: 0, item: 0,
    familiar: 0, map: 0, crafting: 0, title: 0,
    building: 0, vehicle: 0, attackText: 0, buff: 0,
    npc: 0, task: 0, effect: 0, resource: 0, shop: 0, update: 0,
    skipped: 0,
  };

  // 记录错误
  let errors = 0;

  for (const section of sections) {
    try {
      switch (section.type) {
        case '武器': {
          const data = mapWeaponToEquipment(section);
          await prisma.gameEquipment.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.weapon++;
          break;
        }

        case '装备': {
          const data = mapEquipmentToEquipment(section);
          await prisma.gameEquipment.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.equipment++;
          break;
        }

        case '怪物': {
          const data = mapMonsterToMonster(section);
          await prisma.gameMonster.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.monster++;
          break;
        }

        case '物品': {
          const data = mapItemToItem(section);
          await prisma.gameItem.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.item++;
          break;
        }

        case '使魔': {
          const data = mapFamiliarToFamiliar(section);
          await prisma.gameFamiliar.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.familiar++;
          break;
        }

        case '地图': {
          const data = mapMapToMap(section, resourceDefs);
          await prisma.gameMap.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.map++;
          break;
        }

        case '制造': {
          const data = mapCraftingToCrafting(section);
          await prisma.gameCrafting.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.crafting++;
          break;
        }

        case '称号': {
          const data = mapTitleToTitle(section);
          await prisma.gameTitle.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.title++;
          break;
        }

        case '建筑': {
          const data = mapBuildingToBuilding(section);
          await prisma.gameBuilding.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.building++;
          break;
        }

        case '载具': {
          const data = mapVehicleToVehicle(section);
          await prisma.gameVehicle.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.vehicle++;
          break;
        }

        case '文本': {
          const data = mapTextToAttackText(section);
          await prisma.gameAttackText.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.attackText++;
          break;
        }

        case '增益': {
          const data = mapBuffToBuff(section);
          await prisma.gameBuff.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.buff++;
          break;
        }

        case '对话': {
          const data = mapDialogueToNpc(section);
          await prisma.gameNpc.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.npc++;
          break;
        }

        case '任务': {
          const data = mapTaskToTask(section);
          await prisma.gameTask.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.task++;
          break;
        }

        // 特效：装备/武器特殊效果词缀
        case '特效': {
          const data = mapEffectToEffect(section);
          await prisma.gameEffect.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.effect++;
          break;
        }

        // 资源：地图采集节点（完整字段）
        case '资源': {
          const data = mapResourceToResource(section);
          await prisma.gameResource.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.resource++;
          break;
        }

        // 商店：三大兑换商店 + 图片库 + BGM（仅 1 个节，全局唯一）
        case '商店': {
          const data = mapShopToShop(section);
          // 商店全局唯一，用固定 id=1 保证单条记录 upsert
          await prisma.gameShop.upsert({
            where: { id: 1 },
            update: data,
            create: { id: 1, ...data },
          });
          counts.shop++;
          break;
        }

        // 更新：版本更新日志
        case '更新': {
          const data = mapUpdateToUpdateLog(section);
          await prisma.gameUpdateLog.upsert({
            where: { name: data.name },
            update: data,
            create: data,
          });
          counts.update++;
          break;
        }

        // 以下类型没有对应的 Prisma 模型，跳过
        default:
          // 没有类型字段的节（如 [使魔大战]）也跳过
          if (!section.type) {
            counts.skipped++;
          } else {
            console.warn(`⚠️  未知类型 "${section.type}": [${section.name}]`);
            counts.skipped++;
          }
          break;
      }
    } catch (err) {
      errors++;
      console.error(`❌ 导入失败: [${section.name}] (类型=${section.type})`, (err as Error).message);
    }
  }

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
  console.log(`   ✅ 套装效果文本: ${setEffectCount}`);
  console.log(`   ✅ 公共风味文本: ${flavorTextCount}`);
  console.log(`   ⏭️  跳过(无对应模型): ${counts.skipped}`);
  if (errors > 0) {
    console.log(`   ❌ 错误: ${errors}`);
  }

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