/**
 * 使魔大战3 数据转换工具（一次性/可重复运行）
 *
 * 功能：将易语言导出的原始配置文件（e/使魔大战.txt、e/0.txt、e/@Constant.ecode、e/@Resource/*.txt）
 * 解析并转换为结构化 JSON，存放到 prisma/data/ 目录。
 *
 * 转换后的 JSON 是「游戏固定配置数据」的**运行时单一数据源（single source of truth）**：
 *  - 架构改革后（2026-08-15），固定配置已从数据库表彻底移除，
 *    运行时由 StaticDataService（server/src/modules/game/static-data.service.ts）
 *    直接从 prisma/data/*.json 懒加载+缓存读取，**不再写入数据库**。
 *  - 因此本工具产出的 JSON 不仅是"seed 数据"，更是游戏逻辑运行的直接数据来源。
 *    策划改数值 = 直接编辑 JSON → 重启或调用 StaticDataService.refresh() 热重载即生效。
 *
 * 运行：npx ts-node prisma/convert-e-to-json.ts
 *
 * 设计要点：
 *  - 映射逻辑（map*To*）产出的对象结构，即 StaticDataService 读取后各 service 消费的数据结构，
 *    与改造前数据库 upsert 的字段保持一致，保证零漂移、平滑迁移。
 *  - seed-data.ts（动态数据 GameMap/GameVehicle）与 seed-import-all.ts（SystemConfig）仍会
 *    读取部分 JSON，但固定配置（怪物/物品/装备/使魔/配方/任务等）不再入库。
 *  - 本工具可重复运行：e/ 数据变更后重新执行即可重建 JSON。
 *  - 数据归属：`e/` 易语言源码已被 .gitignore 忽略、不进部署；`prisma/data/` 进版本控制并随部署分发。
 */

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

// 易语言源码实际位于 e/源码解析成为txt/ 子目录下（带中文目录名）
const ROOT_DIR = path.resolve(__dirname, '../../');
const ECODE_DIR = path.resolve(ROOT_DIR, 'e/源码解析成为txt');
// 原版主配置（GBK 编码）：易语言源码 e/源码解析成为txt/使魔大战.txt。
// 工作区根目录的 _decoded_original.txt 是当前完整 UTF-8 导出；旧版 GBK 文件是裁剪版，
// 缺少后续版本的使魔、载具和生产配置。存在完整导出时，所有静态数据都以它为准。
const COMPLETE_DATA_FILE = path.resolve(ROOT_DIR, '_decoded_original.txt');
const DATA_FILE = path.resolve(ECODE_DIR, '使魔大战.txt');
const RECIPE_DATA_FILE = fs.existsSync(COMPLETE_DATA_FILE) ? COMPLETE_DATA_FILE : DATA_FILE;
const BLUEPRINT_FILE = path.resolve(ECODE_DIR, '0.txt');
const CONSTANT_FILE = path.resolve(ECODE_DIR, '@Constant.ecode');
const RESOURCE_DIR = path.resolve(ECODE_DIR, '@Resource');
const OUT_DIR = path.resolve(__dirname, 'data');

// ========== 通用解析 ==========

interface ConfigSection {
  name: string;
  type: string;
  fields: Record<string, string>;
}

/** 读取并解析 [节头] + 键值对 格式的配置文件。
 *  兼容 GBK（原版使魔大战.txt）与 UTF-8(BOM)（完整导出 _decoded_original.txt）：
 *  检测 UTF-8 BOM(EF BB BF) 则用 utf-8 解码，否则用 gbk。 */
function parseConfigFile(filePath: string): ConfigSection[] {
  const buf = fs.readFileSync(filePath);
  let txt: string;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    txt = iconv.decode(buf, 'utf-8');
  } else {
    txt = iconv.decode(buf, 'gbk');
  }
  const sections: ConfigSection[] = [];
  const lines = txt.split(/\r?\n/);
  let current: ConfigSection | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sec = trimmed.match(/^\[(.+)\]$/);
    if (sec) {
      if (current) sections.push(current);
      current = { name: sec[1], type: '', fields: {} };
      continue;
    }
    const kv = trimmed.match(/^([^=]+)=(.*)$/);
    if (kv && current) {
      const key = kv[1].trim();
      const value = kv[2].trim();
      if (key === '类型') current.type = value;
      else current.fields[key] = value;
    }
  }
  if (current) sections.push(current);
  return sections;
}

// ========== 字段解析辅助 ==========

function parseSpaceSeparatedString(str: string): string[] {
  return str.split(/\s+/).map((s) => s.trim()).filter((s) => s);
}

function parseSemicolonString(str: string): string[] {
  return str.split(/[;；]/).map((s) => s.trim()).filter((s) => s);
}

function parseItemCountString(str: string): Array<{ name: string; count: number }> {
  if (!str || !str.trim()) return [];
  const result: Array<{ name: string; count: number }> = [];
  for (const group of str.trim().split(/\s+/)) {
    if (!group.trim()) continue;
    const parts = group.split(/[,，、]/).map((s) => s.trim()).filter((s) => s);
    if (parts.length >= 2) {
      result.push({ name: parts[0], count: parseFloat(parts[1]) || 0 });
    }
  }
  return result;
}

/**
 * 载具生产配方的物品格式：名称,数量[,耐久百分比]。
 * 耐久小于100的产出是副产物，消耗也按耐久比例扣除；缺省耐久为100。
 */
function parseVehicleRecipeItems(str: string): Array<{ name: string; quantity: number; durability: number }> {
  if (!str || !str.trim()) return [];
  const result: Array<{ name: string; quantity: number; durability: number }> = [];
  for (const group of str.trim().split(/\s+/)) {
    const parts = group.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    result.push({
      name: parts[0],
      quantity: parseFloat(parts[1]) || 0,
      durability: parts.length >= 3 ? (parseFloat(parts[2]) || 0) : 100,
    });
  }
  return result;
}

/**
 * 商店字段使用“名称+数字”格式（例如“优秀武器补给箱100”），
 * 与产出/奖励字段的“名称,数量”格式不同，不能共用 parseItemCountString。
 * 对应数据存取.ecode L805-824 的 去数字/取数字。
 */
function parseShopCostString(str: string): Array<{ name: string; count: number }> {
  if (!str || !str.trim()) return [];
  return str
    .trim()
    .split(/\s+/)
    .map((token) => {
      const match = token.match(/^(.+?)(\d+(?:\.\d+)?)$/);
      if (!match) return null;
      return { name: match[1], count: Number(match[2]) };
    })
    .filter((item): item is { name: string; count: number } => Boolean(item));
}

/** 行商池由逗号分隔，数字后缀是出售数量而不是名称的一部分。 */
function parseTravelingPoolString(str: string): Array<{ name: string; count: number }> {
  if (!str || !str.trim()) return [];
  return str
    .split(/[，,]/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const match = token.match(/^(.+?)(\d+(?:\.\d+)?)$/);
      return match
        ? { name: match[1], count: Number(match[2]) || 1 }
        : { name: token, count: 1 };
    });
}

function parseDropString(str: string): Array<{ name: string; count: number; chance: number }> {
  if (!str || !str.trim()) return [];
  const result: Array<{ name: string; count: number; chance: number }> = [];
  for (const group of str.trim().split(/\s+/)) {
    if (!group.trim()) continue;
    const parts = group.split(/[,，、]/).map((s) => s.trim()).filter((s) => s);
    if (parts.length >= 2) {
      result.push({
        name: parts[0],
        count: parseFloat(parts[1]) || 0,
        chance: parts.length >= 3 ? parseFloat(parts[2]) : -1,
      });
    }
  }
  return result;
}

function parseConnectionString(str: string): Array<{ name: string; distance: number }> {
  const result: Array<{ name: string; distance: number }> = [];
  if (!str) return result;
  for (const entry of str.split(/\s+/)) {
    const parts = entry.split(/[,，]/);
    if (parts.length >= 2) {
      result.push({ name: parts[0].trim(), distance: parseInt(parts[1]) || 0 });
    }
  }
  return result;
}

function parseResourceOutput(str: string): Array<{ name: string; count: number; chance: number }> {
  return parseDropString(str);
}

function parseDamageString(damageStr: string): Record<string, number> {
  const TYPE_MAP: Record<string, string> = { '物': '物理', '火': '火焰', '冰': '冰冻', '电': '雷电' };
  const properties: Record<string, number> = {};
  let maxPercent = 0;
  let primaryType = '物理';
  for (const part of damageStr.split(/\s+/)) {
    const m = part.match(/^([物火冰电])([\d.]+)$/);
    if (m) {
      const typeName = TYPE_MAP[m[1]] || '物理';
      const percent = parseFloat(m[2]);
      properties[typeName] = percent;
      if (percent > maxPercent) {
        maxPercent = percent;
        primaryType = typeName;
      }
    }
  }
  if (Object.keys(properties).length === 0) properties['物理'] = 100;
  return properties;
}

// ========== 常量映射（@Constant.ecode） ==========

interface ConstantMappings {
  weapons: Record<string, number>;
  familiars: Record<string, number>;
  equipment: Record<string, number>;
}

function parseConstantEcode(): ConstantMappings {
  const buf = fs.readFileSync(CONSTANT_FILE);
  // The checked-in export is UTF-8 with BOM, while older source dumps may be GBK.
  // Keep the same encoding detection used by parseConfigFile so constant names
  // continue to match the UTF-8 config sections (notably familiar specialSeq).
  const txt = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    ? iconv.decode(buf, 'utf-8')
    : iconv.decode(buf, 'gbk');
  const weapons: Record<string, number> = {};
  const familiars: Record<string, number> = {};
  const equipment: Record<string, number> = {};
  let section: 'initial' | 'equip' | 'weapon' | 'familiar' = 'initial';
  let sectionBreaks = 0;

  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t === '.常量') {
      sectionBreaks += 1;
      // @Constant.ecode uses a bare .常量 line as the boundary between
      // equipment, weapon and familiar constants. Numeric sign alone cannot
      // distinguish the first familiar (1) from an equipment constant.
      if (sectionBreaks === 1) section = 'equip';
      else if (sectionBreaks === 2) section = 'weapon';
      else if (sectionBreaks === 3) section = 'familiar';
      continue;
    }
    const m = t.match(/^\.常量\s+(\S+)\s*,\s*"(-?\d+)"/);
    if (!m) continue;
    const name = m[1];
    const val = parseInt(m[2]);
    if (section === 'weapon' && val < 0 && val >= -100) weapons[name] = val;
    else if (section === 'familiar' && val > 0 && val <= 100) familiars[name] = val;
    else if (section === 'equip' && val > 0) equipment[name] = val;
  }
  return { weapons, familiars, equipment };
}

// ========== 各类型映射（与 seed-data.ts 字段一致） ==========

function mapWeaponToEquipment(section: ConfigSection, specialSeq: number) {
  const fields = section.fields;
  const damage = parseDamageString(fields['伤害'] || '');
  const properties = parseSpaceSeparatedString(fields['属性'] || '');
  const bonus: Record<string, any> = {};
  const numericFields = ['冷却', '贯穿', '暴击', '命中', '范围', '溅射', '溅射数量',
    '锁定', '攻击次数', '攻击护盾', '攻击装甲', '攻击生命', '采集', '魅力',
    '命中2', '闪避2', '暴击伤害', '麻醉', 'aoe', '必中', '必中2',
    '冷却2', '护盾穿透', '装甲穿透', '生命穿透',
    '吸生命', '吸护盾', '吸装甲', '吸生命2', '吸护盾2', '吸装甲2',
    '攻击2', '物攻2', '火攻2', '冰攻2', '电攻2',
    '溅射2', '冷却2', '溅射数量2'];
  for (const key of numericFields) {
    if (fields[key] !== undefined) bonus[key] = parseFloat(fields[key]) || 0;
  }
  if (fields['增益']) bonus['buffs'] = parseSpaceSeparatedString(fields['增益']);
  const propertiesObj: Record<string, any> = {};
  if (properties.length > 0) propertiesObj['attrs'] = properties;
  if (Object.keys(damage).length > 0) propertiesObj['damage'] = damage;
  return {
    name: section.name,
    description: fields['说明'] || '',
    equipType: fields['分类'] || '武器',
    specialSeq,
    specialEffect: 0,
    damageType: '物理',
    cooldown: parseFloat(fields['冷却']) || 5,
    lockTime: parseInt(fields['锁定']) || 0,
    forcedEffect: fields['必中'] === '1',
    vehicleForceDmg: false,
    bonus: JSON.stringify(bonus),
    baseBonus: '{}',
    properties: JSON.stringify(propertiesObj),
    // 词条(affixes) 直接取自原版"属性"字段（空格分隔），对应原版 数据存取.ecode L513：
    //   z.词条 = 分割文本(读配置项3(p, w[a], "属性", "随机"), " ", )
    // 运行时 generateEquipment 会按词条随机展开(随机攻击→具体属性)并经 词条转换 赋随机值。
    affixes: JSON.stringify(parseSpaceSeparatedString(fields['属性'] || '')),
    attackText: JSON.stringify({ name: fields['攻击文本'] || '' }),
    buffs: JSON.stringify(parseSpaceSeparatedString(fields['增益'] || '')),
    negativeType: 0,
  };
}

function mapEquipmentToEquipment(section: ConfigSection, specialSeq: number) {
  const fields = section.fields;
  const bonus: Record<string, any> = {};
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
    if (fields[key] !== undefined) bonus[key] = parseFloat(fields[key]) || 0;
  }
  const properties = parseSpaceSeparatedString(fields['属性'] || '');
  const propertiesObj: Record<string, any> = {};
  if (properties.length > 0) propertiesObj['attrs'] = properties;
  const attackTextObj: Record<string, any> = {};
  // 原版非武器装备用“召唤”字段承载攻击时召唤配置；旧配置仍兼容“攻击文本”。
  const summonText = fields['召唤'] ?? fields['攻击文本'] ?? '';
  if (summonText) attackTextObj['name'] = summonText;
  return {
    name: section.name,
    description: fields['说明'] || '',
    equipType: fields['位置'] || '装备',
    specialSeq,
    specialEffect: 0,
    damageType: '物理',
    cooldown: 0,
    lockTime: 0,
    forcedEffect: false,
    vehicleForceDmg: false,
    bonus: JSON.stringify(bonus),
    baseBonus: '{}',
    properties: JSON.stringify(propertiesObj),
    // 词条(affixes) 直接取自原版"属性"字段（空格分隔），对应原版 数据存取.ecode L513：
    //   z.词条 = 分割文本(读配置项3(p, w[a], "属性", "随机"), " ", )
    affixes: JSON.stringify(parseSpaceSeparatedString(fields['属性'] || '')),
    attackText: JSON.stringify(attackTextObj),
    buffs: '[]',
    negativeType: 0,
  };
}

function mapMonsterToMonster(section: ConfigSection) {
  const fields = section.fields;
  const bonus: Record<string, any> = {};
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
      const num = parseFloat(fields[key]);
      bonus[key] = isNaN(num) ? fields[key] : num;
    }
  }
  if (fields['掉落']) bonus['drops'] = parseDropString(fields['掉落']);
  if (fields['武器']) bonus['weapons'] = parseSpaceSeparatedString(fields['武器']);
  if (fields['装备']) bonus['equipmentList'] = parseSpaceSeparatedString(fields['装备']);
  const shield = parseFloat(fields['护盾']) || 0;
  const armor = parseFloat(fields['装甲']) || 0;
  return {
    name: section.name,
    specialSeq: -1,
    type: '怪物',
    description: fields['说明'] || '',
    level: parseInt(fields['等级']) || 1,
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

function mapItemToItem(section: ConfigSection) {
  const fields = section.fields;
  const useEffects: string[] = [];
  if (fields['使用可得']) {
    useEffects.push(...parseItemCountString(fields['使用可得']).map((i) => `${i.name} x${i.count}`));
  }
  return {
    name: section.name,
    description: fields['说明'] || '',
    value: parseFloat(fields['价值']) || 0,
    type: '物品',
    useEffects: JSON.stringify(useEffects),
    useMarkers: JSON.stringify(parseSpaceSeparatedString(fields['使用可得标记'] || '')),
  };
}

function mapFamiliarToFamiliar(section: ConfigSection, specialSeq: number) {
  const fields = section.fields;
  const affinityDesc: string[] = [];
  for (let i = 1; i <= 5; i++) {
    if (fields[`好感${i}`]) affinityDesc.push(fields[`好感${i}`]);
  }
  return {
    name: section.name,
    uniqueSkill: fields['技能'] || '',
    description: fields['说明'] || '',
    description2: fields['简略说明'] || '',
    skillDesc: fields['技能说明'] || '',
    specialSeq,
    noSummon: fields['不可召唤'] === '1',
    hairDrop: '{}',
    affinityDesc: JSON.stringify(affinityDesc),
  };
}

function mapMapToMap(section: ConfigSection, resourceDefs: Map<string, any>) {
  const fields = section.fields;
  const monsters = parseSpaceSeparatedString(fields['怪物'] || '');
  const resourceNames = parseSpaceSeparatedString(fields['资源'] || '');
  const resources = resourceNames.map((name) => {
    const def = resourceDefs.get(name);
    if (def) {
      return { name, type: '资源', times: def.times, outputs: def.outputs, outputs2: def.outputs2, gatherCmd: def.gatherCmd };
    }
    return { name, type: '资源', times: 1, outputs: [], outputs2: [], gatherCmd: '' };
  });
  const spawnMonsters: string[] = [];
  if (fields['复活点']) spawnMonsters.push(fields['复活点']);
  const extraFields: Record<string, any> = {};
  for (const key of ['复活要求', '复活提示', '不可搬迁', '等级']) {
    if (fields[key] !== undefined) extraFields[key] = fields[key];
  }
  const travelRequirement = fields['前往需求'] || '';
  const requiredTravel = travelRequirement === '飞行'
    ? 1
    : travelRequirement === '传送'
      ? 2
      : travelRequirement === '跃迁'
        ? 3
        : 0;
  return {
    name: section.name,
    description: fields['说明'] || '',
    mapIndex: 0,
    level: parseInt(fields['等级']) || 1,
    isFrontier: fields['开拓地'] === '1',
    noTeleport: fields['不可传送'] === '1',
    noMove: fields['不可搬迁'] === '1',
    isInstance: fields['关卡'] === '1',
    requiredTravel,
    respawnPoint: fields['复活点'] || section.name,
    monsters: JSON.stringify(monsters),
    spawnMonsters: JSON.stringify(spawnMonsters),
    tempMonsters: '[]',
    summons: '[]',
    resources: JSON.stringify(resources),
    resources2: '[]',
    connections: JSON.stringify(parseConnectionString(fields['可前往'] || '')),
    npcs: '[]',
    items: '[]',
    buildings: '[]',
    vehicles: '[]',
    markers: '{}',
    markers2: '[]',
    mapBuffs: '[]',
    requireMarkers: JSON.stringify(parseSpaceSeparatedString(fields['标记要求'] || fields['复活要求'] || '')),
    failHint: fields['标记提示'] || fields['复活提示'] || '',
    clearMarkers: fields['删除标记'] || '',
    music: '',
    monsterCount: parseInt(fields['刷怪数量']) || 3,
    noSpecial: fields['不刷特殊'] === '1',
  };
}

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

/** 配置节自身的特殊序号优先于常量表，兼容名称别名和不可召唤条目。 */
function resolveSpecialSeq(section: ConfigSection, fallback: number): number {
  const raw = section.fields['特殊序号'];
  if (raw !== undefined && raw.trim() !== '') {
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function mapVehicleRecipeToRecipe(section: ConfigSection) {
  const fields = section.fields;
  const outputs = parseVehicleRecipeItems(fields['产出'] || fields['输出'] || '');
  const inputs = parseVehicleRecipeItems(fields['消耗'] || fields['需求'] || '');
  const name = section.name.replace(/配方/g, '');
  const production = parseFloat(fields['生产力消耗'] || fields['生产力'] || '1') || 1;
  const unlockRequirements = parseUnlockRequirements(fields['解锁需求'] || '');
  return {
    // 原版 数据存取.ecode L910：pf.名称=子文本替换(节名,"配方",...)
    name,
    description: fields['说明'] || '',
    level: parseInt(fields['等级']) || 1,
    production,
    生产力: production,
    unlockRequirements: JSON.stringify(unlockRequirements),
    解锁需求: unlockRequirements,
    outputs: JSON.stringify(outputs),
    inputs: JSON.stringify(inputs),
    // 保留中文别名，便于直接对照原版字段和兼容手工配置。
    产出: outputs,
    消耗: inputs,
  };
}

/** 原版解锁需求使用“行为+名称+数量”紧凑格式，例如“采集钻石10000”。 */
function parseUnlockRequirements(str: string): Array<{ name: string; count: number }> {
  if (!str || !str.trim()) return [];
  return str.trim().split(/\s+/).map((token) => {
    const match = token.match(/^(.*?)(-?\d+(?:\.\d+)?)$/);
    if (!match) return { name: token, count: 1 };
    return { name: match[1], count: parseFloat(match[2]) || 0 };
  });
}

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

function mapVehicleToVehicle(section: ConfigSection) {
  const fields = section.fields;
  const bonus: Record<string, any> = {};
  const moveType = parseInt(fields['行走']) || 0;
  const weaponSlots = parseInt(fields['武器']) || 0;
  const defenseSlots = parseInt(fields['装甲']) || 0;
  if (fields['限制']) bonus['限制'] = fields['限制'];
  if (fields['说明']) bonus['说明'] = fields['说明'];
  return {
    name: section.name,
    vehicleId: '',
    type: fields['限制'] || '',
    owner: '',
    driver: '',
    moveType,
    maxHp: defenseSlots * 100 || 100,
    currentHp: defenseSlots * 100 || 100,
    mapIndex: 0,
    weaponSlots,
    defenseSlots,
    moveSlots: moveType,
    functionSlots: 0,
    maxWeapon: 5, maxDefense: 5, maxMove: 5, maxFunction: 5,
    slotStatus: 0,
    bonus: JSON.stringify(bonus),
    parts: '[]', markers: '{}', markers2: '[]',
    recipes: '[]', builtinParts: '[]', coating: 0, reverseField: false,
  };
}

/** 原版「部件列表」规格，供计算载具和载具生产使用。 */
function mapVehiclePartSpec(section: ConfigSection) {
  const fields = section.fields;
  const partTypeMap: Record<string, number> = { 核心: 0, 防御: 1, 行走: 2, 武器: 3, 功能: 4 };
  // 原版 数据存取.ecode L608-620：坐地不是缺省值，明确写入 4；未填写才是 0。
  const moveTypeMap: Record<string, number> = { 坐地: 4, 陆地: 1, 飞行: 2, 跃迁: 3 };
  const numberField = (name: string, fallback = 0): number => {
    const value = Number.parseFloat(fields[name] || '');
    return Number.isFinite(value) ? value : fallback;
  };
  const compactItems = (value: string): Array<{ name: string; count: number }> => {
    if (!value) return [];
    return value.split(/[\s,，、]+/).filter(Boolean).map((token) => {
      const match = token.match(/^(.*?)(-?\d+(?:\.\d+)?)$/);
      if (!match) return { name: token, count: 1 };
      return { name: match[1], count: Number.parseFloat(match[2]) || 0 };
    });
  };
  const bonus: Record<string, number> = {};
  const structural = new Set([
    '说明', '限制', '上限', '行走方式', '内置零件', '限制2',
    // 这些是载具部件的插槽/超限字段，不属于加成对象。
    '行走', '防御', '武器', '功能',
  ]);
  for (const [key, raw] of Object.entries(fields)) {
    if (structural.has(key)) continue;
    const value = Number.parseFloat(raw);
    if (Number.isFinite(value)) bonus[key] = value;
  }
  return {
    name: section.name,
    description: fields['说明'] || '',
    limit: numberField('上限'),
    partType: partTypeMap[fields['限制'] || ''] ?? 1,
    moveType: fields['行走方式'] ? (moveTypeMap[fields['行走方式']] ?? 0) : 0,
    walk: numberField('行走'),
    defense: numberField('防御'),
    weapon: numberField('武器'),
    function: numberField('功能'),
    limit2: fields['限制2'] || '',
    builtinParts: compactItems(fields['内置零件'] || ''),
    bonus,
  };
}

function mapBuffToBuff(section: ConfigSection) {
  const fields = section.fields;
  const bonus: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
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

function mapDialogueToNpc(section: ConfigSection) {
  const fields = section.fields;
  return {
    name: section.name,
    taskId: fields['任务'] || '',
    hostileChat: '[]',
    friendlyChat: JSON.stringify(parseSemicolonString(fields['聊天'] || '')),
    followText: JSON.stringify(parseSemicolonString(fields['跟随'] || '')),
    stopText: JSON.stringify(parseSemicolonString(fields['停下'] || '')),
    pickupText: '[]', milkText: '[]', killText: '[]',
    boostStart: '[]', boostEnd: '[]', captureText: '[]',
    lieDownText: '[]', wakeUpText: '[]', strengthenText: '[]',
  };
}

function mapTaskToTask(section: ConfigSection) {
  const fields = section.fields;
  const rewards = parseItemCountString(fields['奖励'] || '');
  // 原版 数据存取.ecode L652~L656：要求字段按空格分割为「名称数量」紧挨格式（如 移动1 / 发送"观察附近"1），
  // 再用 去数字(取末尾文字) + 取数字(取末尾数字) 拆分成 名称 + 数值。
  // 注意：不能用 parseItemCountString（它按逗号「名称,数量」解析），否则会全部解析为空。
  const requirements = parseNameCountString(fields['要求'] || '');
  // 原版 数据存取.ecode L664：任务.任务 = 分割文本(读配置项3(p, w[a], "任务", ""), " ", )
  // 即完成本任务后自动激活的后续任务名（空格分隔），对应 GameTask.nextTasks。
  const nextTasks = parseSpaceSeparatedString(fields['任务'] || '');
  return {
    name: section.name,
    description: fields['说明'] || '',
    chance: 100, level: 1, publisher: '',
    requirements: JSON.stringify(requirements),
    rewards: JSON.stringify(rewards),
    nextTasks: JSON.stringify(nextTasks), restrictMarkers: '[]',
  };
}

/**
 * 解析原版「要求」「奖励」等字段的「名称数量」紧挨格式（空格分隔，名称与数字直接相连）。
 * 对应原版 数据存取.ecode L652~L656：
 *   w1 = 分割文本(读配置项3(p, w[a], "要求", ""), " ", )
 *   j.名称 = 去数字(w1[b])   ' 去掉末尾数字后的文字
 *   j.数值 = 到数值(取数字(w1[b]))  ' 取末尾连续数字
 * 示例：
 *   "移动1 前往森林出口1"           -> [{name:"移动",count:1},{name:"前往森林出口",count:1}]
 *   "发送"观察附近"1 使用优秀装备补给箱1" -> [{name:'发送"观察附近"',count:1},{name:"使用优秀装备补给箱",count:1}]
 */
function parseNameCountString(str: string): Array<{ name: string; count: number }> {
  if (!str || !str.trim()) return [];
  const result: Array<{ name: string; count: number }> = [];
  for (const group of str.trim().split(/\s+/)) {
    if (!group.trim()) continue;
    // 从右往左找到第一个非数字字符的位置，左边为名称，右边连续数字为数量
    let i = group.length - 1;
    while (i >= 0 && /\d/.test(group[i])) i--;
    if (i < 0) continue; // 整串都是数字，跳过
    const name = group.slice(0, i + 1).trim();
    const countStr = group.slice(i + 1).trim();
    if (!name) continue;
    const count = countStr ? parseInt(countStr, 10) : 1;
    result.push({ name, count: Number.isNaN(count) ? 1 : count });
  }
  return result;
}

function mapEffectToEffect(section: ConfigSection) {
  const fields = section.fields;
  const bonus: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
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

function mapShopToShop(section: ConfigSection) {
  const fields = section.fields;
  const imgObj = (keys: string[]) => {
    const obj: Record<string, number> = {};
    for (const k of keys) {
      const v = fields[k];
      if (!v) continue;
      for (const tok of v.trim().split(/\s+/)) {
        const m = tok.match(/^([^\d]+)(\d+)?$/);
        if (m) obj[m[1]] = m[2] ? parseInt(m[2]) : 1;
      }
    }
    return JSON.stringify(obj);
  };
  return {
    shopActivity: JSON.stringify(parseShopCostString(fields['活跃度'] || '')),
    shopDiamond: JSON.stringify(parseShopCostString(fields['钻石'] || '')),
    shopData: JSON.stringify(parseShopCostString(fields['数据'] || '')),
    dungeons: JSON.stringify(parseSpaceSeparatedString(fields['副本'] || '')),
    dungeons2: JSON.stringify(parseSpaceSeparatedString(fields['副本2'] || '')),
    robotQQ: fields['机器人'] || '',
    familiarImg: imgObj(['使魔jpg', '使魔png']),
    characterImg: imgObj(['人物jpg', '人物png']),
    monsterImg: imgObj(['怪物jpg', '怪物png']),
    mapImg: imgObj(['地图jpg']),
    travelingEquip: JSON.stringify(parseTravelingPoolString(fields['行商装备'] || '')),
    travelingItem: JSON.stringify(parseTravelingPoolString(fields['行商物品'] || '')),
    bgm: JSON.stringify(fields['bgm'] ? fields['bgm'].split(';').map((s: string) => s.trim()).filter(Boolean) : []),
  };
}

function mapUpdateToUpdateLog(section: ConfigSection) {
  const fields = section.fields;
  const content = Object.values(fields).join('\n').trim();
  return { name: section.name, content };
}

// ========== 蓝图（0.txt） ==========

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

function parseBlueprintSections(): { blueprints: BlueprintData[]; purchase: BlueprintData[] } {
  const buf = fs.readFileSync(BLUEPRINT_FILE);
  const txt = iconv.decode(buf, 'gbk');
  const blueprints: BlueprintData[] = [];
  const purchase: BlueprintData[] = [];
  const lines = txt.split(/\r?\n/);
  let cur: { name: string; fields: Record<string, string>; purchaseType: string | null } | null = null;

  const flush = (s: any) => {
    if (!s) return;
    if (s.fields['类型'] === '队员') return;
    if (s.fields['数据']) {
      const bp = parseBlueprintData(s.name, s.fields['数据'], s.fields['属性']);
      if (bp) {
        if (s.purchaseType && !s.fields['属性']) {
          const p = parsePurchaseTypeValue(s.purchaseType);
          if (p) { bp.price = p.price; bp.quantity = p.quantity; if (p.type2 && !bp.type2) bp.type2 = p.type2; }
        }
        blueprints.push(bp);
      }
      return;
    }
    if (s.purchaseType) {
      const bp = parsePurchaseTypeValue(s.purchaseType);
      if (bp) { bp.name = s.name; purchase.push(bp); }
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sec = trimmed.match(/^\[(.+)\]$/);
    if (sec) { flush(cur); cur = { name: sec[1], fields: {}, purchaseType: null }; continue; }
    const kv = trimmed.match(/^([^=]+)=(.*)$/);
    if (kv && cur) {
      const key = kv[1].trim();
      const value = kv[2].trim();
      if (key === '类型') {
        if (/^\d+[,，]/.test(value)) cur.purchaseType = value;
        else cur.fields['类型'] = value;
      } else cur.fields[key] = value;
    }
  }
  flush(cur);
  return { blueprints, purchase };
}

function parseBlueprintData(name: string, dataStr: string, attrStr?: string): BlueprintData | null {
  try {
    const parts = dataStr.split(/[,，]/);
    if (parts.length < 40) { console.warn(`⚠️ 蓝图数据字段异常: [${name}] 字段数=${parts.length}`); return null; }
    const bpType = parts[0].trim();
    const craftTime = parseInt(parts[1]) || 0;
    const materialValues: number[] = [];
    for (let i = 2; i < 38 && i < parts.length; i++) materialValues.push(parseFloat(parts[i]) || 0);
    const bpName = parts.length > 38 ? parts[38].trim() : name;
    const cost = parseFloat(parts[parts.length - 1]) || 0;
    const materials: Record<string, number> = {};
    materialValues.forEach((val, idx) => { if (val > 0) materials[`material_${idx + 1}`] = val; });
    let quantity = 1, price = 0, type2 = '';
    if (attrStr) {
      const a = attrStr.split(/[,，]/);
      if (a.length >= 3) { quantity = parseInt(a[0]) || 1; price = parseFloat(a[1]) || 0; type2 = a[2].trim(); }
      else if (a.length >= 2) { quantity = parseInt(a[0]) || 1; price = parseFloat(a[1]) || 0; }
    }
    return { name: bpName || name, type: bpType, type2, craftTime, cost, price, quantity, materials };
  } catch (err) {
    console.warn(`⚠️ 解析蓝图失败: [${name}]`, (err as Error).message);
    return null;
  }
}

function parsePurchaseTypeValue(typeStr: string): BlueprintData | null {
  try {
    const parts = typeStr.split(/[,，]/);
    if (parts.length < 3) return null;
    return {
      name: '',
      type: parts[2].trim(),
      type2: '',
      craftTime: 0,
      cost: 0,
      price: parseFloat(parts[1]) || 0,
      quantity: parseInt(parts[0]) || 1,
      materials: {},
    };
  } catch { return null; }
}

// ========== @Resource 文本 ==========

function readResourceTexts(): { setEffects: any[]; flavorTexts: any[]; seedItems: string[] } {
  const setEffects: any[] = [];
  const flavorTexts: any[] = [];
  let seedItems: string[] = [];
  if (!fs.existsSync(RESOURCE_DIR)) return { setEffects, flavorTexts, seedItems };
  const files = fs.readdirSync(RESOURCE_DIR).filter((f) => f.endsWith('.txt'));
  for (const f of files) {
    const raw = fs.readFileSync(path.join(RESOURCE_DIR, f));
    let content = iconv.decode(raw, 'utf-8');
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(content)) content = iconv.decode(raw, 'gbk');
    content = content.trim();
    if (!content) continue;
    const setMatch = f.match(/^(.+?)(?:套装效果|效果)\.txt$/);
    if (setMatch) {
      const setName = setMatch[1].replace(/套装$/, '') + '套装';
      setEffects.push({ name: setName, effectText: content, sourceFile: f });
    } else if (f === '种子等.txt') {
      seedItems = content.split(/[,，]/).map((s) => s.trim()).filter((s) => s);
    } else {
      const key = f.replace(/\.txt$/, '');
      flavorTexts.push({ name: key, content });
    }
  }
  return { setEffects, flavorTexts, seedItems };
}

// ========== 主流程 ==========

function writeJson(name: string, data: any) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  // 数组直接取 length；对象按首个数组字段或键值对计数
  const count = Array.isArray(data)
    ? data.length
    : (data && typeof data === 'object' ? Object.keys(data).length : 0);
  console.log(`✅ 写出 ${name} (${count} 条)`);
}

function main() {
  console.log('🚀 开始将 e/ 原始配置转换为 JSON...\n');
  const sections = parseConfigFile(RECIPE_DATA_FILE);
  const completeSections = sections;
  const recipeSections = completeSections.filter((section) => section.type === '配方');
  // 完整导出包含后续版本新增的生产核心/生产部件；旧版配置只有早期部件。
  const vehiclePartSections = (fs.existsSync(COMPLETE_DATA_FILE) ? completeSections : sections)
    .filter((section) => section.type === '载具');
  const constant = parseConstantEcode();

  // 资源类型定义（供地图资源关联）
  const resourceDefs = new Map<string, any>();
  for (const s of sections) {
    if (s.type !== '资源') continue;
    resourceDefs.set(s.name, {
      times: parseInt(s.fields['次数'] || '1') || 1,
      outputs: parseResourceOutput(s.fields['产出'] || ''),
      outputs2: parseResourceOutput(s.fields['产出2'] || ''),
      gatherCmd: s.fields['采集指令'] || '',
    });
  }

  const monsters: any[] = [];
  const equipments: any[] = [];
  const items: any[] = [];
  const familiars: any[] = [];
  const maps: any[] = [];
  const attackTexts: any[] = [];
  const craftings: any[] = [];
  const titles: any[] = [];
  const buildings: any[] = [];
  const vehicles: any[] = [];
  const vehicleRecipes: any[] = [];
  const buffs: any[] = [];
  const npcs: any[] = [];
  const tasks: any[] = [];
  const effects: any[] = [];
  const resources: any[] = [];
  const shops: any[] = [];
  const updateLogs: any[] = [];

  for (const s of sections) {
    switch (s.type) {
      case '武器': equipments.push(mapWeaponToEquipment(s, resolveSpecialSeq(s, constant.weapons[s.name] || 0))); break;
      case '装备': equipments.push(mapEquipmentToEquipment(s, resolveSpecialSeq(s, constant.equipment[s.name] || 0))); break;
      case '怪物': monsters.push(mapMonsterToMonster(s)); break;
      case '物品': items.push(mapItemToItem(s)); break;
      case '使魔': familiars.push(mapFamiliarToFamiliar(s, resolveSpecialSeq(s, constant.familiars[s.name] || 0))); break;
      case '地图': maps.push(mapMapToMap(s, resourceDefs)); break;
      case '文本': attackTexts.push(mapTextToAttackText(s)); break;
      case '制造': craftings.push(mapCraftingToCrafting(s)); break;
      case '称号': titles.push(mapTitleToTitle(s)); break;
      case '建筑': buildings.push(mapBuildingToBuilding(s)); break;
      case '载具': vehicles.push(mapVehicleToVehicle(s)); break;
      case '增益': buffs.push(mapBuffToBuff(s)); break;
      case '对话': npcs.push(mapDialogueToNpc(s)); break;
      case '任务': tasks.push(mapTaskToTask(s)); break;
      case '特效': effects.push(mapEffectToEffect(s)); break;
      case '资源': resources.push(mapResourceToResource(s)); break;
      case '商店': shops.push(mapShopToShop(s)); break;
      case '更新': updateLogs.push(mapUpdateToUpdateLog(s)); break;
    }
  }
  for (const s of recipeSections) vehicleRecipes.push(mapVehicleRecipeToRecipe(s));

  const { blueprints, purchase } = parseBlueprintSections();
  const { setEffects, flavorTexts, seedItems } = readResourceTexts() as any;

  writeJson('monsters.json', monsters);
  writeJson('equipments.json', equipments);
  writeJson('maps.json', maps);
  writeJson('familiars.json', familiars);
  writeJson('items.json', items);
  writeJson('attack-texts.json', attackTexts);
  writeJson('craftings.json', craftings);
  writeJson('titles.json', titles);
  writeJson('buildings.json', buildings);
  writeJson('vehicles.json', vehicles);
  writeJson('vehicle-parts.json', vehiclePartSections.map(mapVehiclePartSpec));
  writeJson('vehicle-recipes.json', vehicleRecipes);
  writeJson('buffs.json', buffs);
  writeJson('npcs.json', npcs);
  writeJson('tasks.json', tasks);
  writeJson('effects.json', effects);
  writeJson('resources.json', resources);
  // 商店全局唯一，固定 id=1 保证单条记录 upsert
  writeJson('shops.json', shops.map((s) => ({ id: 1, ...s })));
  writeJson('update-logs.json', updateLogs);
  writeJson('blueprints.json', blueprints);
  writeJson('blueprint-purchases.json', purchase);
  writeJson('set-effects.json', setEffects);
  writeJson('flavor-texts.json', flavorTexts);
  writeJson('seed-items.json', { items: seedItems });

  console.log('\n🎉 转换完成，JSON 已写入 prisma/data/');
}

main();
