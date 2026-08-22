/**
 * 物品/装备管理服务
 * 对应原版易语言：物品操作.ecode
 * 负责装备、物品和载具的管理
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StaticDataService } from './static-data.service';
import { CombatStateService } from './combat-state.service';

/**
 * 物品3接口，对应原版易语言的"物品3"数据类型
 * 表示背包/保险柜中的单个物品项
 */
export interface Item3 {
  name: string;
  type: string;       // 装备 / 资源 / 消耗品
  quantity: number;
  /** 兼容掉落物和旧存档使用的数量字段。 */
  count?: number;
  durability: number;  // 耐久，0=未锁定，1=已锁定
  data: string;       // 装备数据编码字符串（品质前缀 + 加成序列 + 特效）
  maker?: string;     // 制造者
  durabilityLevel?: number;  // 法宝耐久/等级（原版 数据分析.ecode L922 陪睡=法宝耐久），仅资源类法宝使用
}

/**
 * 装备接口，对应原版易语言的"装备"数据类型
 * 由 Item3.data 解析得来
 */
export interface Equipment {
  name: string;
  type: string;           // 部位：头部/武器/脚部/饰品/植入体/增幅器
  specialSeq: number;     // 特殊序号
  specialEffect: number;  // 特效序号
  damageType: string;     // 伤害类型：物理/火焰/冰霜/雷电
  cooldown: number;       // 攻击冷却
  forcedEffect: boolean;  // 必出特效
  vehicleForceDmg: boolean; // 无视载具伤害上限
  lockTime: number;       // 锁定时间

  bonus: Record<string, number>;      // 加成属性
  baseBonus: Record<string, number>;  // 自带加成
  properties: { phys: number; elec: number; fire: number; ice: number }; // 属性
  affixes: string[];      // 词条列表
  attackText: any;        // 攻击文本
  buffs: any[];           // 攻击造成的增益
  negativeType: number;   // 负面类型

  maker: string;          // 制造者
  durability: number;     // 耐久
  description: string;    // 说明文本
  data: string;           // 原始数据
}

/**
 * 品质等级枚举
 */
export enum QualityLevel {
  ORDINARY = '普通',
  GOOD = '良好',
  EXCELLENT = '优秀',
  SUPERB = '精良',
  EPIC = '史诗',
  LEGENDARY = '传说',
  MYTHIC = '神迹',
}

/**
 * 品质等级对应的数据前缀字符
 */
export const QUALITY_PREFIX_MAP: Record<string, string> = {
  e: QualityLevel.ORDINARY,
  d: QualityLevel.GOOD,
  c: QualityLevel.EXCELLENT,
  b: QualityLevel.SUPERB,
  a: QualityLevel.EPIC,
  s: QualityLevel.LEGENDARY,
};

/**
 * 品质等级对应的评分价值
 */
export const QUALITY_VALUE_MAP: Record<string, number> = {
  [QualityLevel.ORDINARY]: 15,
  [QualityLevel.GOOD]: 25,
  [QualityLevel.EXCELLENT]: 40,
  [QualityLevel.SUPERB]: 70,
  [QualityLevel.EPIC]: 120,
  [QualityLevel.LEGENDARY]: 200,
  [QualityLevel.MYTHIC]: 10000,
};

/**
 * 加成数据编码前缀对照表
 * 将2字符前缀映射到加成属性名
 */
export const BONUS_CODE_MAP: Record<string, string> = {
  aa: '护盾',
  ab: '装甲',
  ac: '生命',
  ad: '生命全抗',
  ae: '物伤',
  af: '电伤',
  ag: '火伤',
  ah: '冰伤',
  ai: '攻击',
  aj: '暴击',
  ak: '生命物抗',
  al: '生命火抗',
  am: '生命冰抗',
  an: '生命电抗',
  ao: '装甲物抗',
  ap: '装甲火抗',
  aq: '装甲冰抗',
  ar: '装甲电抗',
  as: '护盾物抗',
  at: '护盾火抗',
  au: '护盾冰抗',
  av: '护盾电抗',
  aw: '速度',
  ax: '命中',
  ay: '闪避',
  az: '掉落率',
  ba: '掉落品质',
  bb: '护盾回复',
  bc: '装甲回复',
  bd: '生命回复',
  be: '护盾全抗',
  bf: '装甲全抗',
  bg: '护盾2',
  bh: '装甲2',
  bi: '生命2',
  bj: '物伤2',
  bk: '电伤2',
  bl: '火伤2',
  bm: '冰伤2',
  bn: '攻击2',
  bo: '护盾回复2',
  bp: '装甲回复2',
  bq: '生命回复2',
  br: '速度2',
  bs: '命中2',
  bt: '闪避2',
  bu: '韧性',
  bv: '采集',
  bw: '暴击伤害',
  by: '魅力',
};

/**
 * 植入体属性名称列表（用于强化时判断）
 */
export const IMPLANT_STATS = [
  '生命', '装甲', '护盾', '攻击', '速度', '闪避', '命中',
  '生命恢复', '装甲修复', '护盾回复', '电攻', '火攻', '物攻', '冰攻',
];

/**
 * 植入体属性名到加成字段名的映射
 */
export const IMPLANT_STAT_MAP: Record<string, string> = {
  '生命': '生命',
  '装甲': '装甲',
  '护盾': '护盾',
  '攻击': '攻击',
  '速度': '速度',
  '闪避': '闪避',
  '命中': '命中',
  '生命恢复': '生命回复',
  '装甲修复': '装甲回复',
  '护盾回复': '护盾回复',
  '电攻': '电伤',
  '火攻': '火伤',
  '物攻': '物伤',
  '冰攻': '冰伤',
};

/**
 * 增幅器属性名称列表（用于强化时判断）
 */
export const AMPLIFIER_STATS = [
  '生命', '装甲', '护盾', '攻击', '速度', '闪避', '命中',
  '生命恢复', '装甲修复', '护盾回复', '电攻', '火攻', '物攻', '冰攻',
];

/**
 * 增幅器属性名到二阶加成字段名的映射
 */
export const AMPLIFIER_STAT_MAP: Record<string, string> = {
  '生命': '生命2',
  '装甲': '装甲2',
  '护盾': '护盾2',
  '攻击': '攻击2',
  '速度': '速度2',
  '闪避': '闪避2',
  '命中': '命中2',
  '生命恢复': '生命回复2',
  '装甲修复': '装甲回复2',
  '护盾回复': '护盾回复2',
  '电攻': '电伤2',
  '火攻': '火伤2',
  '物攻': '物伤2',
  '冰攻': '冰伤2',
};

@Injectable()
export class ItemService {
  private readonly logger = new Logger(ItemService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly staticData: StaticDataService,
    private readonly combatState: CombatStateService,
  ) {}

  /**
   * 计算物品价值
   * 对应原版：计算价值()
   * 遍历物品数组，根据物品类型（装备/资源）和品质计算总价值
   * @param items 物品数组
   * @returns 总价值
   */
  async calculateValue(items: Item3[]): Promise<number> {
    let totalValue = 0;

    // 从静态配置加载物品列表以获取物品基础价值（JSON 单一来源）
    const gameItems = this.staticData.getAllItems();

    for (const item of items) {
      let foundInList = false;

      // 在物品列表中查找匹配项
      for (const gi of gameItems) {
        if (gi.name === item.name) {
          totalValue += gi.value * item.quantity;
          foundInList = true;
          break;
        }
      }

      if (!foundInList) {
        // 未在物品列表中定义的物品，按装备处理
        if (item.type === '装备') {
          const equipment = this.parseEquipment(item);

          // 有特效时加值
          if (equipment.specialEffect !== 0) {
            totalValue += 100;
          }

          // 根据品质加值
          const quality = this.getEquipmentQuality(equipment);
          const qualityValue = QUALITY_VALUE_MAP[quality] || 15;
          totalValue += qualityValue;

          // 特殊序号物品加值
          if (equipment.specialSeq !== 0) {
            totalValue += 1000;
          }
        } else {
          // 非装备按基础价值5倍计算
          totalValue += 5 * item.quantity;
        }
      }
    }

    return totalValue;
  }

  /**
   * 解析装备数据
   * 将物品数据中的装备信息解析为装备对象
   * 对应原版：解析装备()
   * 从 Item3.data 编码串中提取品质前缀、加成属性和特效编号
   * @param item 物品数据
   * @returns 解析后的装备对象
   */
  parseEquipment(item: Item3): Equipment {
    const equipment: Equipment = {
      name: item.name || '',
      type: '',
      specialSeq: 0,
      specialEffect: 0,
      damageType: '物理',
      cooldown: 5,
      forcedEffect: false,
      vehicleForceDmg: false,
      lockTime: 0,
      bonus: {},
      baseBonus: {},
      properties: { phys: 0, elec: 0, fire: 0, ice: 0 },
      affixes: [],
      attackText: null,
      buffs: [],
      negativeType: 0,
      maker: '',
      durability: item.durability || 0,
      description: '',
      data: item.data || '',
    };

    if (!item.data) {
      return equipment;
    }

    // 先从静态装备表恢复原版“装备”结构；数据串只覆盖动态词条/特效/制造者。
    // 原版 解析装备() L1262-1511：先复制装备列表项，再解析数据串覆盖加成。
    const definition = typeof (this.staticData as any).getEquipmentByName === 'function'
      ? (this.staticData as any).getEquipmentByName(item.name)
      : undefined;
    const parseJson = <T>(value: any, fallback: T): T => {
      if (value === undefined || value === null || value === '') return fallback;
      if (typeof value === 'object') return value as T;
      try { return JSON.parse(String(value)) as T; } catch { return fallback; }
    };
    const addBonus = (target: Record<string, number>, source: any) => {
      if (!source || typeof source !== 'object') return;
      for (const [key, raw] of Object.entries(source)) {
        const value = Number(raw);
        if (Number.isFinite(value) && value !== 0) target[key] = (target[key] || 0) + value;
      }
    };
    if (definition) {
      equipment.type = String(definition.equipType ?? definition.type ?? definition.类型 ?? '');
      equipment.specialSeq = Number(definition.specialSeq ?? definition.特殊序号 ?? 0) || 0;
      equipment.damageType = String(definition.damageType ?? definition.伤害类型 ?? equipment.damageType);
      equipment.cooldown = Number(definition.cooldown ?? definition.冷却 ?? equipment.cooldown) || 0;
      equipment.forcedEffect = definition.forcedEffect === true || definition.forcedEffect === 'true' || definition.必出特效 === true;
      equipment.vehicleForceDmg = definition.vehicleForceDmg === true || definition.vehicleForceDmg === 'true' || definition.无视载具伤害上限 === true;
      equipment.lockTime = Number(definition.lockTime ?? definition.锁定 ?? 0) || 0;
      equipment.description = String(definition.description ?? definition.说明 ?? '');
      equipment.baseBonus = parseJson<Record<string, number>>(definition.baseBonus ?? definition.自带加成, {});
      equipment.affixes = parseJson<string[]>(definition.affixes ?? definition.词条, []);
      equipment.attackText = parseJson<any>(definition.attackText ?? definition.攻击文本, null);
      equipment.buffs = parseJson<any[]>(definition.buffs ?? definition.增益, []);
      const props = parseJson<any>(definition.properties ?? definition.属性, {});
      const damage = props?.damage ?? props?.伤害 ?? props;
      equipment.properties = {
        phys: Number(damage?.phys ?? damage?.物理 ?? 0) || 0,
        elec: Number(damage?.elec ?? damage?.雷电 ?? damage?.电 ?? 0) || 0,
        fire: Number(damage?.fire ?? damage?.火焰 ?? damage?.火 ?? 0) || 0,
        ice: Number(damage?.ice ?? damage?.冰冻 ?? damage?.冰霜 ?? damage?.冰 ?? 0) || 0,
      };
      equipment.bonus = {};
    }

    // 解析数据编码：格式为 "品质前缀!aa值!ab值!...!bx特效编号!@@制造者"
    const parts = item.data.split('!');
    if (parts.length === 0) return equipment;

    // 第一部分是品质前缀
    const qualityPrefix = parts[0];
    // 品质前缀 -> 品质等级，用于data重建时保留

    // 从数据库加载装备定义
    // 这里简化处理：遍历parts解析各编码段
    for (let i = 1; i < parts.length; i++) {
      const segment = parts[i];
      if (!segment || segment.length < 2) continue;

      const code = segment.substring(0, 2);
      const valueStr = segment.substring(2);

      if (code === 'bx') {
        // 特效编号
        equipment.specialEffect = parseInt(valueStr, 10) || 0;
      } else if (code === '@@') {
        // 制造者标记
        equipment.maker = segment.substring(2) || '';
      } else if (BONUS_CODE_MAP[code]) {
        // 加成属性
        const bonusKey = BONUS_CODE_MAP[code];
        const val = parseFloat(valueStr) || 0;
        equipment.bonus[bonusKey] = val;
      }
    }

    const isWeapon = definition
      ? (typeof (this.staticData as any).isWeapon === 'function'
        ? (this.staticData as any).isWeapon(definition)
        : equipment.specialSeq < 0 || /武器$|工具$/.test(equipment.type))
      : false;
    if (isWeapon) {
      // 原版 L1300-1332：按四属性最大值判定负面类型；相等时落入类型4。
      const { phys, fire, ice, elec } = equipment.properties;
      if (phys > fire && phys > ice && phys > elec) equipment.negativeType = 1;
      else if (fire > phys && fire > ice && fire > elec) equipment.negativeType = 2;
      else if (ice > phys && ice > fire && ice > elec) equipment.negativeType = 3;
      else equipment.negativeType = 4;
    }

    // bx 特效覆盖武器伤害属性，并把特效加成叠入“自带加成”（原版 L1430-1480）。
    if (equipment.specialEffect > 0) {
      if (isWeapon) {
        if (equipment.specialEffect === 37) {
          equipment.properties.phys *= 1.15; equipment.properties.fire *= 1.15;
          equipment.properties.ice *= 1.15; equipment.properties.elec *= 1.15;
        } else if (equipment.specialEffect === 38) equipment.properties.phys *= 1.25;
        else if (equipment.specialEffect === 39) equipment.properties.phys = equipment.properties.fire * 1.25; // 原版疑似笔误，按原版保留
        else if (equipment.specialEffect === 40) equipment.properties.phys = equipment.properties.ice * 1.25;
        else if (equipment.specialEffect === 41) equipment.properties.phys = equipment.properties.elec * 1.25;
      }
      const effect = typeof (this.staticData as any).getEffectById === 'function'
        ? (this.staticData as any).getEffectById(equipment.specialEffect, isWeapon)
        : (() => {
          const rows = typeof (this.staticData as any).getAllEffects === 'function'
            ? (this.staticData as any).getAllEffects().filter((row: any) => !row?.limit || row.limit === (isWeapon ? '武器' : '装备'))
            : [];
          return rows[equipment.specialEffect - 1];
        })();
      if (effect) {
        addBonus(equipment.baseBonus, parseJson<Record<string, number>>(effect.bonus ?? effect.加成, {}));
        if (effect.attackText || effect.攻击文本) equipment.attackText = parseJson<any>(effect.attackText ?? effect.攻击文本, equipment.attackText);
        if (effect.buffs || effect.增益) equipment.buffs = parseJson<any[]>(effect.buffs ?? effect.增益, equipment.buffs);
      }
    }

    equipment.data = item.data;

    return equipment;
  }

  /**
   * 获取装备品质
   * 根据装备数据字符串的第一个字符判断品质等级
   * 品质等级: 普通、良好、优秀、精良、史诗、传说、神迹
   * 对应原版：显示品质() 取品质部分
   * @param equipment 装备对象
   * @returns 品质等级文本
   */
  getEquipmentQuality(equipment: Equipment): string {
    if (!equipment.data) return QualityLevel.ORDINARY;

    const prefix = equipment.data.charAt(0);
    return QUALITY_PREFIX_MAP[prefix] || QualityLevel.MYTHIC;
  }

  /**
   * 获取装备的显示文本
   * 对应原版：显示品质()
   * 返回品质文本，如果装备有特效则附加特效名称
   * @param equipment 装备对象
   * @param showStats 是否显示详细属性（预留）
   * @returns 格式化后的品质显示文本
   */
  formatEquipmentDisplay(equipment: Equipment, showStats: boolean): string {
    const quality = this.getEquipmentQuality(equipment);

    if (equipment.specialEffect !== 0 && !showStats) {
      // 有特效时附加特效名称（此处简化，完整实现需查特效表）
      return `${quality}·特效${equipment.specialEffect}`;
    }

    return quality;
  }

  /**
   * 强化植入体
   * 对应原版：强化植入体()
   * 消耗材料强化植入体属性，支持随机强化和指定属性强化
   * @param userId 玩家ID
   * @param target 强化目标：空字符串=随机，属性名=指定属性
   * @param count 强化次数
   * @returns 操作结果文本
   */
  async upgradeImplant(userId: number, target: string, count: number): Promise<string> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) return `玩家不存在`;

    // 解析玩家装备
    const equipmentList: Item3[] = JSON.parse(player.equipment || '[]');
    const backpack: Item3[] = JSON.parse(player.backpack || '[]');

    // 查找植入体装备
    let implantIndex = -1;
    let implantItem: Item3 | null = null;
    for (let i = 0; i < equipmentList.length; i++) {
      if (equipmentList[i].name.includes('植入体')) {
        implantIndex = i;
        implantItem = equipmentList[i];
        break;
      }
    }

    if (!implantItem) {
      return `${player.name}你身上未装备植入体`;
    }

    if (count <= 0) {
      return `${player.name} 输入"强化植入体${3}"来随机强化3次，"强化植入体攻击3"来消耗史诗强化券来强化3次攻击`;
    }

    // 解析植入体装备
    const implant = this.parseEquipment(implantItem);

    // 检查目标属性是否有效
    const isValidTarget = target === '' || IMPLANT_STATS.includes(target);
    if (!isValidTarget) {
      return `${player.name},${target}不是可以强化的植入体属性`;
    }

    // 解析标记数据
    const markers = JSON.parse(player.markers || '{}');

    // 获取植入体等级（从成就熟练度）
    let implantLevel = 0;
    if (markers['植入体等级']) {
      implantLevel = typeof markers['植入体等级'] === 'number'
        ? markers['植入体等级']
        : markers['植入体等级'].level || 0;
    }

    // 计算已有材料数量
    let crystalCount = 0; // 水晶
    let couponCount = 0;  // 史诗强化券
    for (const item of backpack) {
      if (item.name === '水晶') crystalCount += item.quantity;
      if (item.name === '史诗强化券') couponCount += item.quantity;
    }

    let usedMaterial = 0;
    let upgradedCount = 0;
    const resultItems: Item3[] = [];

    // 执行强化循环
    for (let i = 0; i < count; i++) {
      if (crystalCount <= implantLevel) {
        break; // 水晶不足
      }

      usedMaterial += implantLevel;
      crystalCount -= implantLevel;
      upgradedCount++;
      implantLevel++;

      if (target === '') {
        // 随机强化：从有效属性中随机选一个
        const randomStat = IMPLANT_STATS[Math.floor(Math.random() * IMPLANT_STATS.length)];
        const statKey = IMPLANT_STAT_MAP[randomStat];
        if (statKey) {
          implant.bonus[statKey] = (implant.bonus[statKey] || 0) + 1;
          resultItems.push({ name: randomStat, type: '资源', quantity: 1, durability: 0, data: '' });
        }
      } else {
        // 指定属性强化
        if (couponCount < 1) {
          break; // 史诗强化券不足
        }
        couponCount--;
        const statKey = IMPLANT_STAT_MAP[target];
        if (statKey) {
          implant.bonus[statKey] = (implant.bonus[statKey] || 0) + 1;
          resultItems.push({ name: target, type: '资源', quantity: 1, durability: 0, data: '' });
        }
      }
    }

    if (usedMaterial === 0) {
      return `${player.name} 材料不足，无法强化植入体`;
    }

    // 消耗水晶
    // 更新背包：减少水晶和史诗强化券
    for (const item of backpack) {
      if (item.name === '水晶') {
        item.quantity -= usedMaterial;
      }
      if (item.name === '史诗强化券' && target !== '') {
        item.quantity -= upgradedCount;
      }
    }

    // 更新植入体装备数据
    const dataPrefix = implantItem.data ? implantItem.data.charAt(0) : 'e';
    implantItem.data = dataPrefix + this.bonusToDataString(implant.bonus);
    if (implant.specialEffect !== 0) {
      implantItem.data += `!bx${implant.specialEffect}`;
    }
    if (implant.maker) {
      implantItem.data += `!@@${implant.maker}`;
    }
    equipmentList[implantIndex] = implantItem;

    // 更新标记成就
    if (!markers['植入体等级']) markers['植入体等级'] = 0;
    markers['植入体等级'] = implantLevel;
    // 简化：更新成就
    if (!markers['强化植入体']) markers['强化植入体'] = 0;
    markers['强化植入体'] = (markers['强化植入体'] || 0) + upgradedCount;

    // 保存到数据库
    await this.prisma.player.update({
      where: { userId },
      data: {
        equipment: JSON.stringify(equipmentList),
        backpack: JSON.stringify(backpack),
        markers: JSON.stringify(markers),
      },
    });

    // 构建返回文本
    const resultText = resultItems.map(r => r.name).join('、');
    if (target === '') {
      return `${player.name}使用${usedMaterial}块水晶强化了${upgradedCount}次植入体：\n${resultText}`;
    } else {
      return `${player.name}使用${usedMaterial}块水晶和${upgradedCount}张史诗强化券强化了${upgradedCount}次植入体：\n${resultText}`;
    }
  }

  /**
   * 使用物品
   * 处理物品使用效果，包括开箱、恢复等
   * 对应原版：打开箱子() 和 使用物品相关逻辑
   * @param userId 玩家ID
   * @param itemName 物品名称
   * @param count 使用数量，默认1
   * @returns 使用结果文本
   */
  async useItem(userId: number, itemName: string, count: number = 1): Promise<string> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) return `玩家不存在`;

    const backpack: Item3[] = JSON.parse(player.backpack || '[]');

    // 检查物品是否存在
    let itemIndex = -1;
    for (let i = 0; i < backpack.length; i++) {
      if (backpack[i].name === itemName) {
        itemIndex = i;
        break;
      }
    }

    if (itemIndex === -1) {
      return `${player.name} 你的背包中没有${itemName}`;
    }

    const item = backpack[itemIndex];
    const available = Number(item.quantity ?? item.count ?? 0);
    if (!Number.isFinite(available) || available <= 0) {
      return `${player.name} 你的背包中没有可用的${itemName}`;
    }
    const requestedCount = Number(count);
    if (!Number.isFinite(requestedCount) || requestedCount === 0) {
      return '使用数量必须是正整数';
    }
    const actualCount = requestedCount < 0
      ? available
      : Math.min(Math.floor(requestedCount), available);
    if (actualCount <= 0) return '使用数量必须是正整数';

    // 从静态配置加载物品定义（JSON 单一来源）
    const gameItem = this.staticData.getItemByName(itemName);
    if (!gameItem) {
      return `${player.name},${itemName}在物品列表不存在`;
    }

    // 检查是否有使用效果。使用可得的每个数组元素是一个产出池，
    // 池内逗号分隔的重复候选项会自然形成原版随机权重。
    const parseJsonArray = <T>(value: any, fallback: T[]): T[] => {
      if (Array.isArray(value)) return value as T[];
      if (typeof value !== 'string' || !value.trim()) return fallback;
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed as T[] : fallback;
      } catch {
        return fallback;
      }
    };
    const useEffects = parseJsonArray<string>(gameItem.useEffects, []);
    const useMarkers = parseJsonArray<string>(gameItem.useMarkers, []);

    if (useEffects.length === 0) {
      return `${player.name},${itemName}不是可以直接使用的物品，或者暂时还无法使用`;
    }

    type UseCandidate = { name: string; count: number };
    const parseCandidate = (raw: string): UseCandidate | null => {
      let token = String(raw || '').trim();
      if (!token) return null;

      // 兼容旧版转换器曾生成的“名称 x0”格式；原始配置里的数量仍由
      // 名称末尾数字解析，例如“椰树种子1”应得到数量1。
      const legacyCount = token.match(/^(.*?)\s+x(-?\d+(?:\.\d+)?)$/i);
      if (legacyCount) token = legacyCount[1].trim();
      const match = token.match(/^(.+?)(-?\d+(?:\.\d+)?)$/);
      if (!match) return { name: token, count: 1 };
      const name = match[1].trim();
      const parsedCount = Number(match[2]);
      return name && Number.isFinite(parsedCount)
        ? { name, count: parsedCount }
        : { name: token, count: 1 };
    };

    const pools: UseCandidate[][] = [];
    for (const effect of useEffects) {
      const pool = String(effect || '')
        .split(/[，,、]/)
        .map(parseCandidate)
        .filter((candidate): candidate is UseCandidate => !!candidate);
      if (pool.length > 0) pools.push(pool);
    }

    const obtained: Array<{ name: string; count: number }> = [];
    for (const pool of pools) {
      if (pool.length === 1) {
        const candidate = pool[0];
        if (candidate.count > 0) obtained.push({ name: candidate.name, count: candidate.count * actualCount });
        continue;
      }
      for (let i = 0; i < actualCount; i++) {
        const candidate = pool[Math.floor(Math.random() * pool.length)];
        if (!candidate || candidate.count <= 0) continue;
        const existing = obtained.find((item) => item.name === candidate.name);
        if (existing) existing.count += candidate.count;
        else obtained.push({ name: candidate.name, count: candidate.count });
      }
    }

    const addObtained = (name: string, amount: number): void => {
      if (!name || !Number.isFinite(amount) || amount <= 0) return;
      if (this.staticData.getEquipmentByName(name)) {
        // 使用箱子的装备先按独立物品入包；装备系统会继续按静态定义处理它。
        const copies = Math.max(1, Math.floor(amount));
        for (let i = 0; i < copies; i++) {
          backpack.push({ name, type: '装备', quantity: 1, count: 1, durability: 0, data: 'e' });
        }
        return;
      }
      const existing = backpack.find((entry) => entry.name === name && entry.type !== '装备');
      const current = Number(existing?.quantity ?? existing?.count ?? 0);
      const next = current + amount;
      if (existing) {
        existing.quantity = next;
        existing.count = next;
      } else {
        backpack.push({ name, type: '资源', quantity: amount, count: amount, durability: 0, data: '' });
      }
    };
    for (const item of obtained) addObtained(item.name, item.count);

    // 解析玩家标记
    const markers = JSON.parse(player.markers || '{}');
    const markers2 = JSON.parse(player.markers2 || '[]');
    const buffs = JSON.parse(player.buffs || '[]');

    // 消耗物品
    const remaining = available - actualCount;
    if (item.quantity !== undefined) item.quantity = remaining;
    else item.count = remaining;
    if (remaining <= 0) {
      backpack.splice(itemIndex, 1);
    }

    // 添加使用标记
    for (const marker of useMarkers) {
      if (!markers[marker]) markers[marker] = 0;
      markers[marker] += actualCount;
    }

    // 更新成就
    if (!markers['使用' + itemName]) markers['使用' + itemName] = 0;
    markers['使用' + itemName] += actualCount;
    if (!markers['使用物品']) markers['使用物品'] = 0;
    markers['使用物品'] += actualCount;

    // 保存到数据库
    await this.prisma.player.update({
      where: { userId },
      data: {
        backpack: JSON.stringify(backpack),
        markers: JSON.stringify(markers),
        markers2: JSON.stringify(markers2),
        buffs: JSON.stringify(buffs),
      },
    });

    const obtainedText = obtained.length > 0
      ? `，获得${obtained.map((item) => `${item.name}×${item.count}`).join('、')}`
      : '';
    const resultText = `${player.name}使用了${actualCount}个${itemName}${obtainedText}`;

    return resultText;
  }

  /**
   * 制造物品
   * 检查材料是否足够，消耗材料并产出物品
   * 对应原版：制造()
   * @param userId 玩家ID
   * @param recipeName 配方名称
   * @param count 制造数量，默认1
   * @returns 制造结果文本
   */
  async craftItem(userId: number, recipeName: string, count: number = 1): Promise<string> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) return `玩家不存在`;

    const backpack: Item3[] = JSON.parse(player.backpack || '[]');

    // 从静态配置加载制造配方（JSON 单一来源）
    const recipes = this.staticData.getAllCraftings();
    let recipeIndex = -1;
    // 查找目标配方

    for (let i = 0; i < recipes.length; i++) {
      if (recipes[i].name === recipeName) {
        recipeIndex = i;
        break;
      }
    }

    if (recipeIndex === -1) {
      return `${player.name},【${recipeName}】在制造列表不存在`;
    }

    const recipe = recipes[recipeIndex];

    if (recipe.noCraft) {
      return `你输入了正确的名称，但是【${recipeName}】不是可以制造的项目`;
    }

    const requirements: Item3[] = JSON.parse(recipe.requirements || '[]');
    const outputs: Item3[] = JSON.parse(recipe.outputs || '[]');

    if (outputs.length === 0) {
      return `警告：制造项目${recipe.name}的制造产出为空`;
    }

    if (count < 1) {
      // 显示制造公式
      let info = `${player.name},${recipeName}(等级需求${recipe.level})\n制造需求:\n`;
      for (const req of requirements) {
        info += `${req.name}x${req.quantity} `;
      }
      info += `\n产出:\n`;
      for (const out of outputs) {
        info += `${out.name}x${out.quantity} `;
      }
      return info;
    }

    // 检查等级
    if (player.level < recipe.level) {
      return `需要等级${recipe.level}`;
    }

    // 限制制造数量
    const maxCount = Math.min(count, 1000000);

    // 检查材料是否足够
    const insufficientMaterials: string[] = [];
    for (const req of requirements) {
      let hasQuantity = 0;
      for (const bp of backpack) {
        if (bp.name === req.name) {
          hasQuantity += bp.quantity;
          break;
        }
      }
      if (hasQuantity < req.quantity * maxCount) {
        insufficientMaterials.push(
          `需要${req.name}x${req.quantity * maxCount}，你只有${hasQuantity}`,
        );
      }
    }

    if (insufficientMaterials.length > 0) {
      return insufficientMaterials.join('\n');
    }

    // 消耗材料
    const consumedItems: Item3[] = [];
    for (const req of requirements) {
      const needed = req.quantity * maxCount;
      let remaining = needed;
      for (const bp of backpack) {
        if (bp.name === req.name && remaining > 0) {
          const consume = Math.min(bp.quantity, remaining);
          bp.quantity -= consume;
          remaining -= consume;
          consumedItems.push({ ...req, quantity: consume });
          if (bp.quantity <= 0) {
            // 移除数量为0的物品项
          }
        }
      }
    }
    // 清理背包中数量为0的物品
    const cleanedBackpack = backpack.filter(bp => bp.quantity > 0 || bp.type === '装备');

    // 产出物品
    const producedItems: Item3[] = [];
    for (const out of outputs) {
      const produced: Item3 = {
        name: out.name,
        type: out.type,
        quantity: out.quantity * maxCount,
        durability: 0,
        data: '',
      };

      // 如果是装备，需要生成装备数据
      if (out.type === '装备') {
        // 简化处理：生成基础装备
        produced.data = 'e';
        produced.quantity = 1 * maxCount;
      }

      // 加入背包
      let existing = false;
      for (const bp of cleanedBackpack) {
        if (bp.name === produced.name && bp.type !== '装备') {
          bp.quantity += produced.quantity;
          existing = true;
          break;
        }
      }
      if (!existing) {
        cleanedBackpack.push(produced);
      }
      producedItems.push(produced);
    }

    // 更新成就
    const markers = JSON.parse(player.markers || '{}');
    if (!markers['制造']) markers['制造'] = 0;
    markers['制造'] += maxCount;
    if (!markers['制造' + recipeName]) markers['制造' + recipeName] = 0;
    markers['制造' + recipeName] += maxCount;

    // 标记获得
    const gainMarkers: string[] = JSON.parse(recipe.gainMarkers || '[]');
    for (const gm of gainMarkers) {
      if (gm) {
        if (!markers[gm]) markers[gm] = 0;
        markers[gm] += maxCount;
      }
    }

    // 保存到数据库
    await this.prisma.player.update({
      where: { userId },
      data: {
        backpack: JSON.stringify(cleanedBackpack),
        markers: JSON.stringify(markers),
      },
    });

    const consumedText = consumedItems.map(c => `${c.name}x${c.quantity}`).join('、');
    const producedText = producedItems.map(p => `${p.name}x${p.quantity}`).join('、');

    return `${player.name}用${consumedText}制造了${maxCount}个${recipeName}，得到了${producedText}`;
  }

  /**
   * 分解物品
   * 将物品分解为基础材料
   * 对应原版：分解装备()
   * @param userId 玩家ID
   * @param itemName 物品名称
   * @param count 分解数量，不传或小于0则全部
   * @returns 分解结果文本
   */
  async deconstructItem(userId: number, itemName: string, count?: number): Promise<string> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) return `玩家不存在`;

    const backpack: Item3[] = JSON.parse(player.backpack || '[]');

    // 查找物品
    let itemIndex = -1;
    for (let i = 0; i < backpack.length; i++) {
      if (backpack[i].name === itemName) {
        itemIndex = i;
        break;
      }
    }

    if (itemIndex === -1) {
      return `${player.name} 你的背包中没有${itemName}`;
    }

    const item = backpack[itemIndex];
    const actualCount = (count === undefined || count < 0) ? item.quantity : Math.min(count, item.quantity);

    if (item.type === '装备') {
      // 检查是否植入体或增幅器
      if (item.name.includes('植入体') || item.name.includes('增幅器')) {
        return '这个不是可以被分解的装备';
      }

      if (item.durability !== 0) {
        return '不能分解被锁定的装备';
      }

      // 装备分解：获得水晶和能量块
      const equipment = this.parseEquipment(item);
      const quality = this.getEquipmentQuality(equipment);

      // 根据品质计算分解价值
      const qualityValue = QUALITY_VALUE_MAP[quality] || 15;
      const crystalAmount = Math.floor(qualityValue * 0.5 * actualCount);
      const energyAmount = Math.floor(qualityValue * 0.3 * actualCount);

      // 添加产物到背包
      const crystalExists = backpack.find(bp => bp.name === '水晶');
      if (crystalExists) {
        crystalExists.quantity += crystalAmount;
      } else {
        backpack.push({ name: '水晶', type: '资源', quantity: crystalAmount, durability: 0, data: '' });
      }

      const energyExists = backpack.find(bp => bp.name === '能量块');
      if (energyExists) {
        energyExists.quantity += energyAmount;
      } else {
        backpack.push({ name: '能量块', type: '资源', quantity: energyAmount, durability: 0, data: '' });
      }

      // 移除原物品
      backpack.splice(itemIndex, 1);

      // 更新成就
      const markers = JSON.parse(player.markers || '{}');
      if (!markers['分解']) markers['分解'] = 0;
      markers['分解'] += actualCount;

      await this.prisma.player.update({
        where: { userId },
        data: {
          backpack: JSON.stringify(backpack),
          markers: JSON.stringify(markers),
        },
      });

      return `${player.name}分解了${item.name}，得到了${crystalAmount}水晶和${energyAmount}能量块`;
    } else {
      // 非装备分解：查找制造配方（静态配置 JSON 单一来源）
      const recipes = this.staticData.getAllCraftings();
      let recipeIndex = -1;

      for (let i = 0; i < recipes.length; i++) {
        if (recipes[i].name === item.name) {
          recipeIndex = i;
          break;
        }
      }

      if (recipeIndex === -1) {
        return `${item.name}还无法分解`;
      }

      const recipe = recipes[recipeIndex];
      const requirements: Item3[] = JSON.parse(recipe.requirements || '[]');

      // 返还材料（按比例）
      const deconstructMul = recipe.deconstructMul || 5;

      // 移除原物品
      backpack.splice(itemIndex, 1);

      // 加入分解产物
      const deconstructItems: Item3[] = [];
      for (const req of requirements) {
        const returnQty = Math.floor(req.quantity * actualCount * (1 / deconstructMul));
        if (returnQty > 0) {
          const existing = backpack.find(bp => bp.name === req.name);
          if (existing) {
            existing.quantity += returnQty;
          } else {
            backpack.push({ name: req.name, type: '资源', quantity: returnQty, durability: 0, data: '' });
          }
          deconstructItems.push({ name: req.name, type: '资源', quantity: returnQty, durability: 0, data: '' });
        }
      }

      await this.prisma.player.update({
        where: { userId },
        data: { backpack: JSON.stringify(backpack) },
      });

      const deconstructText = deconstructItems.map(d => `${d.name}x${d.quantity}`).join('、');
      return `分解了${actualCount}个${item.name}，得到了${deconstructText}`;
    }
  }

  /**
   * 装备物品
   * 将背包中的装备穿到对应部位
   * 对应原版：背包操作() 中的装备逻辑
   * @param userId 玩家ID
   * @param backpackIndex 背包中的物品索引
   * @returns 操作结果文本
   */
  async equipItem(userId: number, backpackIndex: number): Promise<string> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) return `玩家不存在`;

    const backpack: Item3[] = JSON.parse(player.backpack || '[]');
    const equipment: Item3[] = JSON.parse(player.equipment || '[]');
    const weapons: Item3[] = JSON.parse(player.weapons || '[]');

    if (backpackIndex < 1 || backpackIndex > backpack.length) {
      return '物品编号超出范围';
    }

    const item = backpack[backpackIndex - 1];

    if (item.type !== '装备') {
      return `${item.name}不是装备，无法穿戴`;
    }

    // 解析装备数据
    const equip = this.parseEquipment(item);

    // 判断是否为武器
    const isWeapon = this.isWeapon(equip.specialSeq, equip.type);

    // 从背包移除
    backpack.splice(backpackIndex - 1, 1);

    if (isWeapon) {
      // 加入武器列表
      weapons.push(item);
      // 设置当前武器为最新
      const currentWeapon = weapons.length - 1;
      // 重算套装判定（对应原版 _计算玩家 实时 套装判断 累加 玩家.套装）
      const sets = this.recomputeSets(equipment, weapons, this.getTreasuresFromPresets(player));
      await this.prisma.player.update({
        where: { userId },
        data: {
          backpack: JSON.stringify(backpack),
          weapons: JSON.stringify(weapons),
          currentWeapon,
          sets,
        },
      });
      return `${player.name}装备了${item.name}`;
    } else {
      // 加入装备列表
      equipment.push(item);
      // 重算套装判定
      const sets = this.recomputeSets(equipment, weapons, this.getTreasuresFromPresets(player));
      await this.prisma.player.update({
        where: { userId },
        data: {
          backpack: JSON.stringify(backpack),
          equipment: JSON.stringify(equipment),
          sets,
        },
      });
      return `${player.name}装备了${item.name}`;
    }
  }

  /**
   * 卸下装备
   * 从指定部位卸下装备放回背包
   * @param userId 玩家ID
   * @param slot 装备部位或名称
   * @returns 操作结果文本
   */
  async unequipItem(userId: number, slot: string): Promise<string> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) return `玩家不存在`;

    const backpack: Item3[] = JSON.parse(player.backpack || '[]');
    const equipment: Item3[] = JSON.parse(player.equipment || '[]');
    const weapons: Item3[] = JSON.parse(player.weapons || '[]');

    // 先在装备中查找
    for (let i = 0; i < equipment.length; i++) {
      if (equipment[i].name === slot || equipment[i].name.includes(slot)) {
        // 将装备放回背包
        backpack.push(equipment[i]);
        equipment.splice(i, 1);

        // 重算套装判定
        const sets = this.recomputeSets(equipment, weapons, this.getTreasuresFromPresets(player));
        await this.prisma.player.update({
          where: { userId },
          data: {
            backpack: JSON.stringify(backpack),
            equipment: JSON.stringify(equipment),
            sets,
          },
        });
        return `${player.name}卸下了${slot}`;
      }
    }

    // 在武器中查找
    for (let i = 0; i < weapons.length; i++) {
      if (weapons[i].name === slot || weapons[i].name.includes(slot)) {
        backpack.push(weapons[i]);
        weapons.splice(i, 1);

        // 如果卸下的是当前武器，重置当前武器索引
        let currentWeapon = player.currentWeapon || 0;
        if (currentWeapon >= weapons.length) {
          currentWeapon = weapons.length > 0 ? 0 : 0;
        }

        // 重算套装判定
        const sets = this.recomputeSets(equipment, weapons, this.getTreasuresFromPresets(player));
        await this.prisma.player.update({
          where: { userId },
          data: {
            backpack: JSON.stringify(backpack),
            weapons: JSON.stringify(weapons),
            currentWeapon,
            sets,
          },
        });
        return `${player.name}卸下了${slot}`;
      }
    }

    return `${player.name} 未找到名为${slot}的已装备物品`;
  }

  /**
   * 判断是否为武器
   * 根据特殊序号和装备类型判断
   * @param specialSeq 特殊序号
   * @param equipType 装备类型
   * @returns 是否为武器
   */
  private isWeapon(specialSeq: number, equipType: string): boolean {
    // 武器类型判断逻辑
    // 特殊序号 > 0 且类型为"武器" 或包含特定标记
    const weaponTypes = ['武器', '剑', '刀', '枪', '弓', '法杖', '杖', '盾', '斧', '锤'];
    for (const wt of weaponTypes) {
      if (equipType.includes(wt)) return true;
    }
    return specialSeq > 0 && specialSeq < 100;
  }

  /**
   * 重算玩家套装判定结果（对应原版 _计算玩家 实时调 套装判断 累加 玩家.套装）
   * 原版 _计算玩家 每次构建属性时遍历"玩家.装备"+本体特殊序号逐件 套装判断 累加写入 玩家.套装；
   * 本框架将结果持久化到 player.sets 字段（buildAttackerBonus 读取），
   * 故在任意装备/武器/植入体/增幅器/预设 变更后调用本方法重算写入。
   * @param equipment 已装备列表（Item3[]）
   * @param weapons 已装备武器列表（Item3[]）
   * @param treasures 法宝资源列表（Item3[]，对应原版 装备预设[2] 的"资源"类型装备）
   * @returns SetData 的 JSON 字符串
   */
  recomputeSets(equipment: Item3[], weapons: Item3[], treasures?: Item3[]): string {
    const setData: Record<string, any> = {};
    const judge = (item: Item3, durability?: number) => {
      if (!item || !item.name) return;
      // 优先取装备模板 specialSeq（@Constant 常量映射），缺失则按名称前缀判定（setJudgment 第二段）
      const def = this.staticData.getEquipmentByName(item.name);
      const seq = def?.specialSeq || 0;
      this.combatState.setJudgment(setData, item.name, seq, durability);
    };
    for (const eq of equipment || []) judge(eq);
    for (const wp of weapons || []) judge(wp);
    // 法宝（资源类）：对应原版 数据分析.ecode L907-923 扫描 装备预设[2] 的资源装备，写入 小樱命中次数/陪睡(=耐久)
    for (const tb of treasures || []) {
      if (tb && (tb.type === '资源' || tb.type === 'resource')) judge(tb, tb.durabilityLevel ?? 0);
    }
    return JSON.stringify(setData);
  }

  /**
   * 从玩家装备预设中提取"资源"类法宝（对应原版 装备预设[2] 的"资源"类型装备）
   * 原版 数据分析.ecode L907 扫描 玩家.装备预设[2].装备[a].类型=="资源"，本框架取预设数组中索引2（即第3个）。
   * @param player 玩家对象（含 equipmentPresets 字段）
   * @returns 法宝资源列表
   */
  private getTreasuresFromPresets(player: any): Item3[] {
    try {
      const presets: any[] = JSON.parse(player?.equipmentPresets || '[]');
      const preset2 = presets[2]; // 原版 装备预设[2]
      if (!preset2 || !Array.isArray(preset2.equipment)) return [];
      return (preset2.equipment as Item3[]).filter(
        (it: Item3) => it && (it.type === '资源' || it.type === 'resource'),
      );
    } catch {
      return [];
    }
  }

  /**
   * 将加成数据编码为字符串
   * 对应原版：加成转数据()
   * 将加成对象序列化为 "!aa值!ab值..." 格式
   * @param bonus 加成属性对象
   * @returns 编码后的字符串
   */
  bonusToDataString(bonus: Record<string, number>): string {
    // 反向映射：加成属性名 -> 编码前缀
    const reverseMap: Record<string, string> = {};
    for (const [code, key] of Object.entries(BONUS_CODE_MAP)) {
      reverseMap[key] = code;
    }

    let result = '';
    for (const [key, value] of Object.entries(bonus)) {
      if (value !== 0 && reverseMap[key]) {
        result += `!${reverseMap[key]}${value}`;
      }
    }
    return result;
  }
}
