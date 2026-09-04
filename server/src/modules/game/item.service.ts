/**
 * 物品/装备管理服务
 * 对应原版易语言：物品操作.ecode
 * 负责装备、物品和载具的管理
 */

import { Inject, Injectable, Logger, Optional, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StaticDataService } from './static-data.service';
import { CombatStateService } from './combat-state.service';
import { PlayerService } from './player.service';
import { MapService } from './map.service';

/**
 * 对齐原版「显示物品」(数据显示.ecode L1887-1929) 的资源数量展示规则：
 * 文本四舍取整（四舍五入保留 2 位并去尾零）；数量 < 1 时返回空串（不显示）。
 * 原版使用示例：普通战利品产出「普通武器补给箱0.03334」→ 取整≈0 → 不显示，
 * 而非把 0.03334 原样拼进结果文本。
 */
function formatLootQuantity(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (rounded < 1) return '';
  // 去尾零：toFixed(2) 后去掉多余 0 与小数点的 .
  return String(Number(rounded.toFixed(2)));
}
import { ItemSystemService } from './item-system.service';
import { asJsonValue } from '../../common/utils/json-value.util';
import { roundItemQuantity, formatDisplayNumber } from '../../common/utils/game-text.util';

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
 * 植入体随机强化池
 * 原版 物品操作.ecode L134：随机文本("生命,装甲,护盾,攻击,速度,闪避,命中,生命恢复,装甲修复,护盾回复,电攻,物攻,冰攻,火攻,攻击")
 * 注意：攻击出现2次（权重双倍），顺序与原文一致，禁止去重或重排
 */
export const IMPLANT_RANDOM_POOL = [
  '生命', '装甲', '护盾', '攻击', '速度', '闪避', '命中',
  '生命恢复', '装甲修复', '护盾回复', '电攻', '物攻', '冰攻', '火攻', '攻击',
];

/**
 * 增幅器随机强化池
 * 原版 物品操作.ecode L288：随机文本("生命,装甲,护盾,攻击,速度,闪避,命中,生命恢复,装甲修复,护盾回复,电攻,冰攻,火攻,攻击,物攻")
 * 与植入体池的差异：电攻后直接是冰攻/火攻，物攻移到末尾，攻击出现2次（权重双倍）
 */
export const AMPLIFIER_RANDOM_POOL = [
  '生命', '装甲', '护盾', '攻击', '速度', '闪避', '命中',
  '生命恢复', '装甲修复', '护盾回复', '电攻', '冰攻', '火攻', '攻击', '物攻',
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
    private readonly playerService: PlayerService,
    private readonly mapService: MapService,
    @Optional()
    @Inject(forwardRef(() => ItemSystemService))
    private readonly itemSystem?: ItemSystemService,
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

  /** 返回原版背包列表使用的品质大写代码（E/D/C/B/A/S）。 */
  getEquipmentQualityCode(equipment: Equipment): string {
    const prefix = String(equipment?.data || '').charAt(0);
    return /^[edcbas]$/i.test(prefix) ? prefix.toUpperCase() : '';
  }

  /** 读取装备实例的特效名称，编号仍按原版武器/装备分别计数。 */
  getEquipmentEffectName(equipment: Equipment): string {
    const effectId = Number(equipment?.specialEffect || 0);
    if (!Number.isInteger(effectId) || effectId <= 0) return '';

    const definition = typeof (this.staticData as any).getEquipmentByName === 'function'
      ? (this.staticData as any).getEquipmentByName(equipment.name)
      : undefined;
    const isWeapon = definition && typeof (this.staticData as any).isWeapon === 'function'
      ? Boolean((this.staticData as any).isWeapon(definition))
      : equipment.specialSeq < 0 || String(equipment.type || '').endsWith('武器') || equipment.type === '工具';

    let effect: any;
    if (typeof (this.staticData as any).getEffectById === 'function') {
      effect = (this.staticData as any).getEffectById(effectId, isWeapon);
    }
    if (!effect && typeof (this.staticData as any).getAllEffects === 'function') {
      const rows = (this.staticData as any).getAllEffects().filter((row: any) => {
        const limit = String(row?.limit ?? '').trim();
        return limit === '' || limit === (isWeapon ? '武器' : '装备');
      });
      effect = rows[effectId - 1];
    }
    return String(effect?.name || effect?.名称 || '');
  }

  /**
   * 原版「显示物品」中的装备列表格式：名称 + 品质大写代码 + 特效名称。
   * 装备不显示数量，因为背包中的每一条装备都是独立实例。
   */
  formatEquipmentInventoryDisplay(item: Item3): string {
    const equipment = this.parseEquipment(item);
    const qualityCode = this.getEquipmentQualityCode(equipment);
    const effectName = this.getEquipmentEffectName(equipment);
    const name = equipment.name || item.name || '未知装备';
    return `${name}${qualityCode}${effectName ? `·${effectName}` : ''}`;
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
    const equipmentList: Item3[] = asJsonValue<Item3[]>(player.equipment, []);
    const backpack: Item3[] = asJsonValue<Item3[]>(player.backpack, []);

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

    // 解析标记数据（DB Json 字段容错读取）
    const markers = asJsonValue<Record<string, any>>(player.markers, {});

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
    await this.playerService.enqueueUserWrite(userId, async () => {
      const _pd = await this.playerService.getPlayerData(userId);
      Object.assign(_pd.player, {
        equipment: equipmentList,
        backpack: backpack,
        markers: markers,
      });
      await this.playerService.savePlayer(_pd.player);
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
   * 使用物品（打开箱子）
   * 1:1 复刻 物品操作.ecode L2220-2458：
   * 开箱防重入锁(L2251-2255) → 特殊物品分支(L2284-2377) → 使用可得出货走战利品品质链路(L2379-2415) →
   * 成就与消耗(L2449-2457) → 文本格式对齐原版(L2434-2448)。
   * @param userId 玩家ID
   * @param itemName 物品名称
   * @param count 使用数量，默认1；-1 表示使用全部（原版 使用数量<0 分支）
   * @returns 使用结果文本
   */
  async useItem(
    userId: number,
    itemName: string,
    count: number = 1,
  ): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const player = playerData.player as any;
    if (!player) return `玩家不存在`;

    // 原版以 玩家.背包 为准；getPlayerData.backpack 是同一份解析数组
    const backpack: Item3[] = playerData.backpack;

    // 检查物品是否存在（L2258-2266 由背包定位物品列表编号的语义在本框架为直接查找）
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
    // L2245-2249：使用数量<0 → 使用全部，但必须先 取整(取物品数量(...))（原版 L2246，
    // 箱子奖励可能带小数如 优秀武器补给箱x1.0353，原版只使用整数部分，余量保留在背包）
    // 两侧都取整：使用量恒为整数（原版 物品.数量 是整数型），余量 0.106 这类不足 1 的
    // 碎数量不可使用（原版会连碎量一起吞掉并删除条目，属可利用偏差，此处有意收紧）。
    let actualCount = requestedCount < 0
      ? Math.max(0, Math.floor(available))
      : Math.min(Math.floor(requestedCount), Math.floor(available));
    if (actualCount <= 0) {
      return Math.floor(requestedCount) >= 1 || requestedCount < 0
        ? `${player.name}，${itemName}剩余不足1个，无法使用`
        : '使用数量必须是正整数';
    }

    // 从静态配置加载物品定义（JSON 单一来源）
    const gameItem = this.staticData.getItemByName(itemName);
    if (!gameItem) {
      // L2267-2270
      return `#错误：${itemName}在物品列表不存在(必须先在物品列表里面定义才可以被使用)`;
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

    if (useEffects.length === 0) {
      // L2272-2282：不可用文本 + 背包同类物品展示
      let notUsableText = `${player.name},${itemName}不是可以直接使用的物品，或者暂时还无法使用`;
      for (const entry of backpack) {
        if (entry.name === itemName) {
          notUsableText += `\n${entry.name}x${formatDisplayNumber(Number(entry.quantity ?? entry.count ?? 0))}`;
          break;
        }
      }
      return notUsableText;
    }

    const nowMs = Date.now();
    // 兼容层：把 markers2/buffs 归一化为中文 key + 毫秒，保证存量数据可读
    const rawMarkers2 = asJsonValue<any[]>(player.markers2, []);
    const rawBuffs = asJsonValue<any[]>(player.buffs, []);
    const markers2 = this.combatState.normalizeBuffItem
      ? rawMarkers2.map((it) => this.combatState.normalizeBuffItem(it))
      : rawMarkers2;
    const buffs = this.combatState.normalizeBuffItem
      ? rawBuffs.map((it) => this.combatState.normalizeBuffItem(it))
      : rawBuffs;
    const markers: Record<string, number> = asJsonValue<Record<string, number>>(player.markers, {});

    // L2251-2255：开箱防重入锁 a1=max(120, 数量*180/100000000)，处理完成后 L2458 移除（净零冷却，仅处理期生效）
    const lockSeconds = Math.max(120, Math.abs(actualCount) * 180 / 100000000);
    this.combatState.gainBuff(markers2, '开箱', lockSeconds, false, nowMs);

    const cdText = { value: '' };
    const remainRef = { value: 0 };
    const strengthRef = { value: 0 };

    /** 三池回复：按 属性.护盾(上限值)×比例×数量 加到当前生命/护盾/装甲（原版 L2289-2298 字面） */
    const restorePools = (ratio: number): void => {
      const base = Number(player.maxShield ?? player.shield ?? 0);
      player.hp = Number(player.hp ?? player.currentHp ?? 0) + base * ratio * actualCount;
      player.shield = Number(player.shield ?? 0) + base * ratio * actualCount;
      player.armor = Number(player.armor ?? 0) + base * ratio * actualCount;
    };

    /** 数字到时间（秒→分秒文本），格式沿用本框架 msToTimeText 约定 */
    const secondsToTimeText = (sec: number): string => {
      const totalSec = Math.max(0, Math.floor(sec));
      if (totalSec < 60) return `${totalSec}秒`;
      return `${Math.floor(totalSec / 60)}分${totalSec % 60}秒`;
    };

    /** 有效期当天：距今日午夜的剩余秒数（原版 有效期当天） */
    const secondsUntilMidnight = (): number => {
      const endOfDay = new Date(nowMs);
      endOfDay.setHours(24, 0, 0, 0);
      return Math.max(1, Math.floor((endOfDay.getTime() - nowMs) / 1000));
    };

    let w4 = '';
    let earlyReturn: string | null = null;
    // 特殊分支先行产出的物品（如凭证的改良建筑箱），随出货段一起走战利品链路
    const specialObtained: Array<{ name: string; count: number }> = [];
    const mergeObtained = (entry: { name: string; count: number }): void => {
      const existing = specialObtained.find((it) => it.name === entry.name);
      if (existing) existing.count += entry.count;
      else specialObtained.push({ ...entry });
    };

    /** 冷却检查：冷却中返回剩余文本（原版 时间间隔要求/标记要求 的 返回文本 语义） */
    const cooldownRemainText = (name: string, seconds: number): string | null => {
      if (this.combatState.markerRequire(name, markers2, cdText, nowMs)) return cdText.value;
      this.combatState.addMarker(name, seconds, markers2, nowMs);
      return null;
    };

    // ===== L2284-2377 特殊物品分支 =====
    if (itemName === '奶') {
      // L2284-2300：死亡状态可用（复活冷却120秒），恢复10%三池
      if (Number(player.hp ?? 0) <= 0) {
        const remain = cooldownRemainText('使用奶', 120);
        if (remain !== null) {
          w4 = `\n使用奶复活冷却${remain}`;
        } else {
          restorePools(0.1);
          w4 = `\n使用了${actualCount}的奶，恢复了${actualCount * 10}%的状态`;
        }
      } else {
        restorePools(0.1);
        w4 = `\n享用了${actualCount}的奶，恢复了${actualCount * 10}%的状态`;
      }
    } else if (itemName === '瓶装奶') {
      // L2302-2318：死亡状态可用（复活冷却30秒），恢复30%三池
      if (Number(player.hp ?? 0) <= 0) {
        const remain = cooldownRemainText('使用奶2', 30);
        if (remain !== null) {
          w4 = `\n使用瓶装奶复活冷却${remain}`;
        } else {
          restorePools(0.3);
          w4 = `\n使用了${actualCount}的瓶装奶，恢复了${actualCount * 30}%的状态`;
        }
      } else {
        restorePools(0.3);
        w4 = `\n享用了${actualCount}的瓶装奶，恢复了${actualCount * 30}%的状态`;
      }
    } else if (itemName === '凭证') {
      // L2320-2333：每日一次；冷却中不消耗直接返回
      const remain = cooldownRemainText('凭证', secondsUntilMidnight());
      if (remain !== null) {
        earlyReturn = `${player.name}${remain}`;
      } else {
        const boxCount = Math.floor(Number(player.level ?? 1) / 2);
        w4 = `\n得到了${boxCount}的改良建筑箱`;
        mergeObtained({ name: '改良建筑箱', count: boxCount });
        markers['凭证'] = (markers['凭证'] || 0) + 1;
        actualCount = 1;
      }
    } else if (itemName === '蛋糕') {
      // L2335-2339：掉落率+50% 增益，可叠加时间
      w4 = `\n享用了${actualCount}的蛋糕，掉落率+50%`;
      this.combatState.gainBuff(buffs, '蛋糕', 180 * actualCount, true, nowMs);
      this.combatState.buffRequire('蛋糕', buffs, strengthRef, nowMs, remainRef);
      w4 += `(${secondsToTimeText(remainRef.value)})`;
    } else if (itemName === '奶酪') {
      // L2340-2345：获得经验+100% 增益（经验加成在 bonus.service 计算增益 L152 已消费）
      w4 = `\n享用了${actualCount}的奶酪，获得经验+100%`;
      this.combatState.gainBuff(buffs, '奶酪', 180 * actualCount, true, nowMs);
      this.combatState.buffRequire('奶酪', buffs, strengthRef, nowMs, remainRef);
      w4 += `(${secondsToTimeText(remainRef.value)})`;
      // 原版此处调用 _计算玩家 重算属性；本框架按需重算，无需显式刷新
    } else if (itemName === '粽子') {
      // L2346-2350：使魔技能临时等级+10
      w4 = `\n享用了${actualCount}的粽子，使魔技能临时等级+10`;
      this.combatState.gainBuff(buffs, '粽子', 3600 * actualCount, true, nowMs);
      this.combatState.buffRequire('粽子', buffs, strengthRef, nowMs, remainRef);
      w4 += `(${secondsToTimeText(remainRef.value)})`;
    } else if (itemName === '奶油蛋糕') {
      // L2351-2354：技能经验获取翻倍（nydg 成就计数）
      w4 = `\n享用了${actualCount}的奶油蛋糕，技能经验获取翻倍`;
      markers['nydg'] = (markers['nydg'] || 0) + actualCount;
      w4 += `(${markers['nydg']}次)`;
    } else if (itemName === '至纯圣水') {
      // L2355-2373：家园时间加速 N 分钟
      const homeMap = player.houseName
        ? await this.mapService.getMapByName(player.houseName).catch(() => null)
        : null;
      if (!homeMap) {
        earlyReturn = `\n你还没有家园，无法使用这个`;
      } else {
        w4 = `\n享用了${actualCount}的至纯圣水，${player.houseName}的时间加速了${actualCount}分钟`;
        // mutateMapFields 锁内闭环：重读最新 markers → 平移时间键 → 差异落库
        await this.mapService.mutateMapFields(homeMap.id, ['markers'], (f) => {
          const fresh = f.markers as Record<string, number>;
          const shiftSeconds = actualCount * 60;
          for (const key of ['观测时间', '观测时间2']) {
            const current = Number(fresh[key] ?? 0);
            fresh[key] = current > 0 ? current - shiftSeconds : nowMs / 1000 - shiftSeconds;
          }
          for (const key of ['全部拾取', '拾取']) {
            const value = Number(fresh[key] ?? 0);
            if (value > 0) {
              const next = value - shiftSeconds;
              if (next <= 0) delete fresh[key];
              else fresh[key] = next;
            }
          }
        });
      }
    }

    if (earlyReturn !== null) {
      // L2321-2324 / L2357-2361：提前返回不消耗物品，但要把开箱锁一并移除
      //（原版 获得增益(标记2,"开箱",-a1) 净零回滚；否则锁会残留到过期，玩家被卡住）
      this.combatState.gainBuff(markers2, '开箱', -lockSeconds, false, nowMs);
      player.markers2 = markers2; // Json 列直接写数组
      player.buffs = buffs;
      await this.playerService.savePlayer(player);
      return earlyReturn;
    }

    // ===== 出货段 L2378-2415 =====
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

    const obtained: Array<{ name: string; count: number }> = specialObtained;
    for (const pool of pools) {
      if (pool.length === 1) {
        // L2402-2405：单候选池直接乘以数量
        const candidate = pool[0];
        if (candidate.count > 0) mergeObtained({ name: candidate.name, count: candidate.count * actualCount });
        continue;
      }
      // L2407-2410：多候选池每次使用随机取一
      for (let i = 0; i < actualCount; i++) {
        const candidate = pool[Math.floor(Math.random() * pool.length)];
        if (!candidate || candidate.count <= 0) continue;
        mergeObtained({ name: candidate.name, count: candidate.count });
      }
    }

    // L2415 战利品(玩家,,物品数组)：装备经生成装备获得品质/词条/特效；
    // 经验走 属性.经验 加成；资源叠加入包。
    let equipmentCount = 0;
    let newEquipmentItems: any[] = [];
    if (obtained.length > 0 && this.itemSystem) {
      const backpackLenBefore = this.playerService.getBackpackItems(player).length;
      await this.itemSystem.distributeLoot(playerData, obtained.map((o) => ({ name: o.name, quantity: o.count })));
      const afterBackpack = this.playerService.getBackpackItems(player);
      newEquipmentItems = afterBackpack.slice(backpackLenBefore).filter((it: any) => it.type === '装备');
      equipmentCount = newEquipmentItems.length;
    } else if (obtained.length > 0) {
      // 无 itemSystem（测试/轻量环境）兜底：直接入包，不入品质链路
      for (const o of obtained) {
        if (this.staticData.getEquipmentByName(o.name)) {
          for (let i = 0; i < Math.max(1, Math.floor(o.count)); i++) {
            backpack.push({ name: o.name, type: '装备', quantity: 1, count: 1, durability: 0, data: 'e' });
            equipmentCount++;
          }
        } else {
          const existing = backpack.find((entry) => entry.name === o.name && entry.type !== '装备');
          if (existing) {
            existing.quantity = roundItemQuantity(Number(existing.quantity ?? existing.count ?? 0) + o.count);
            existing.count = existing.quantity;
          } else {
            backpack.push({ name: o.name, type: '资源', quantity: roundItemQuantity(o.count), count: roundItemQuantity(o.count), durability: 0, data: '' });
          }
        }
      }
      player.backpack = backpack;
    }

    // ===== 文本段 L2416-2448 =====
    // w3 资源汇总（重新读包统计本次新增资源；distributeLoot 已写回 player.backpack）
    const finalBackpack = this.playerService.safeJsonParse<Item3[]>(player.backpack, []);
    const resourceSummary: string[] = [];
    for (const o of obtained) {
      if (!this.staticData.getEquipmentByName(o.name)) {
        const qty = formatLootQuantity(o.count);
        if (qty) resourceSummary.push(`${o.name}x${qty}`); // 数量<1 不显示（普通武器补给箱0.03334 → 不显示）
      }
    }
    const w3 = resourceSummary.join('、');

    // 装备清单（原版 显示物品(物品数组,,,真,)：[序号]名称+品质大写前缀+【特效】）
    const equipmentText = newEquipmentItems.map((eq: any, idx: number) => {
      const qualityLetter = String(eq.data || '').charAt(0).toUpperCase();
      let effectName = '';
      try {
        const parsed = this.parseEquipment(eq as Item3);
        if (parsed.specialEffect > 0) {
          const isWeapon = parsed.type === '武器';
          const effectRow = typeof (this.staticData as any).getEffectById === 'function'
            ? (this.staticData as any).getEffectById(parsed.specialEffect, isWeapon)
            : undefined;
          effectName = effectRow?.name || effectRow?.description || '';
        }
      } catch {
        effectName = '';
      }
      return `[${idx + 1}]${eq.name}${qualityLetter}${effectName ? `【${effectName}】` : ''}`;
    }).join('、');

    // 原版「打开箱子」(物品操作.ecode L2434-2446) 文本装配，已优化文案：
    //   量词：原版「使用了{数量}的{物品}」的「的」改为通顺的「个」；
    //   「和」仅在 w3 非空时挂接，避免 w3 为空时出现病句「得到了和N件装备」；
    //   装备名称：不超过50件时展开具体清单（含「使用全部」路径），超过才折叠为「N件装备」防刷屏。
    let resultText = `\n${player.name}使用了${actualCount}个${itemName},得到了${w3}`;
    if (equipmentCount > 0) {
      if (w3) resultText += '和'; // 仅当已有非装备产出时用「和」连接，避免孤立
      if (equipmentCount > 50) {
        resultText += `${equipmentCount}件装备`;
      } else {
        resultText += equipmentText;
      }
    }
    resultText += w4;

    // ===== 成就与消耗 L2449-2457 =====
    const useMarkers = parseJsonArray<string>(gameItem.useMarkers, []);
    for (const marker of useMarkers) {
      markers[marker] = (markers[marker] || 0) + 1;
    }
    // 注意：原版「使用物品」成就累加的是装备数量 a（非使用次数）
    markers['使用' + itemName] = (markers['使用' + itemName] || 0) + actualCount;
    if (equipmentCount > 0) markers['使用物品'] = (markers['使用物品'] || 0) + equipmentCount;

    // L2454-2457：从背包扣除已使用的物品（distributeLoot 之后重新扣除）
    const usedEntry = finalBackpack.find((entry) => entry.name === itemName && entry.type !== '装备')
      ?? finalBackpack.find((entry) => entry.name === itemName);
    if (usedEntry) {
      const remaining = Number(usedEntry.quantity ?? usedEntry.count ?? 0) - actualCount;
      const idx = finalBackpack.indexOf(usedEntry);
      if (remaining <= 0) finalBackpack.splice(idx, 1);
      else {
        usedEntry.quantity = remaining;
        usedEntry.count = remaining;
      }
    }

    player.backpack = finalBackpack;
    player.markers = markers;
    player.markers2 = markers2;
    player.buffs = buffs;

    // L2458：移除开箱锁（净零冷却）
    this.combatState.gainBuff(markers2, '开箱', -lockSeconds, false, nowMs);

    // 保存到数据库（hp/shield/armor 变更随 savePlayer 标量字段一并写入）
    await this.playerService.savePlayer(player);

    return resultText;
  }

  /**
   * 使用全部（模糊匹配关键词）
   * 复刻 _主程序.ecode L4508-4540「使用」指令的「全部」分支语义：
   * 倒序遍历背包，把名字包含关键词、数量≥1 且不是种子的物品逐一使用全部数量。
   * 与原文差异：装备数量少时展开具体名称（同「使用」），且各箱结果独立成行展示，
   * 不采用原版「#错误 覆盖已累计文本」的丢公告写法。
   * 原版更新日志：「使用全部xx」现在会屏蔽种子（数据分析.ecode 是否种子）。
   * @param userId 玩家ID
   * @param keyword 名称包含的关键词，如“箱”“补给箱”“资源箱”
   * @returns 使用结果文本（每箱类型一行）
   */
  async useAllItems(userId: number, keyword: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const player = playerData.player as any;
    if (!player) return `玩家不存在`;

    const key = String(keyword ?? '').trim();
    if (!key) {
      // L4519-4520：使用全部 后无关键词 → 用法提示
      return `${player.name}“使用全部补给箱”来全部使用名字中包含[补给箱]的物品`;
    }

    // L4522-4535：原版按索引倒序遍历以避免边开箱边增删背包导致错位；
    // 这里先对候选名称做快照再倒序逐一处理——开箱新产出的物品（如改良建筑箱）
    // 不在本轮重复处理，与原版“新物品只会追加在背包末尾、索引不超过初始长度”的语义一致。
    const backpack: Item3[] = playerData.backpack;
    const candidates: string[] = [];
    for (let i = backpack.length - 1; i >= 0; i--) {
      const entry = backpack[i];
      const name = String(entry?.name ?? '');
      const quantity = Number(entry?.quantity ?? entry?.count ?? 0);
      if (!name || !Number.isFinite(quantity) || quantity < 1) continue; // L4525 数量>=1
      if (!name.includes(key)) continue; // L4524 寻找文本(名称, 关键词) 模糊包含
      if (this.isSeedItem(name)) continue; // L4526 是否种子 屏蔽种子
      candidates.push(name);
    }

    if (candidates.length === 0) {
      // L4536-4537
      return `${player.name}没有匹配的物品`;
    }

    let lines: string[] = [];
    for (const name of candidates) {
      // L4528：打开箱子(名称, -1, …) → 使用该物品全部数量（原版 L2246 取整）
      const part = await this.useItem(userId, name, -1);
      if (!part) continue;
      // 优化：每箱结果独立成行保留。原版「#错误 赋值覆盖」会把之前成功箱的公告覆盖掉，
      // 改成不覆盖，让所有成功/错误分行展示，操作与消耗结果不变，只是观感更完整。
      const clean = part.replace(/^\n+/, '').replace(/\n+$/, '');
      if (clean) lines.push(clean);
    }
    return lines.join('\n');
  }

  /**
   * 是否种子（1:1 复刻 数据分析.ecode L3-21 是否种子）：
   * 物品的「使用可得」只有 1 个产出池，且该池去掉数字后能按名称命中资源列表 → 是种子。
   * 例：苹果树种子的使用可得为 ["苹果树"]，苹果树在资源列表 → 种子；
   * 种子箱的使用可得是多个候选（椰树种子1，打包的板1，…），去数字后不命中资源 → 不是种子。
   */
  private isSeedItem(itemName: string): boolean {
    const gameItem = this.staticData.getItemByName(itemName);
    if (!gameItem) return false;
    const rawUseEffects = (gameItem as any).useEffects;
    let useEffects: any[] = Array.isArray(rawUseEffects) ? rawUseEffects : [];
    if (typeof rawUseEffects === 'string' && rawUseEffects.trim()) {
      try {
        const parsed = JSON.parse(rawUseEffects);
        if (Array.isArray(parsed)) useEffects = parsed;
      } catch {
        useEffects = [];
      }
    }
    if (useEffects.length !== 1) return false;
    // 去数字：去掉池文本中的半角/全角数字（原版 去数字(使用可得[1])）
    const resourceKey = String(useEffects[0] ?? '').replace(/[0-9０-９]/g, '').trim();
    if (!resourceKey) return false;
    const resources = (this.staticData as any).getAllResources?.() ?? [];
    return (resources as any[]).some((r) => String(r?.name ?? '') === resourceKey);
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

    const backpack: Item3[] = asJsonValue<Item3[]>(player.backpack, []);

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

    const requirements = asJsonValue<Item3[]>(recipe.requirements, []);
    const outputs = asJsonValue<Item3[]>(recipe.outputs, []);

    if (outputs.length === 0) {
      return `警告：制造项目${recipe.name}的制造产出为空`;
    }

    if (count < 1) {
      // 显示制造公式
      let info = `${player.name},${recipeName}(等级需求${recipe.level})\n制造需求:\n`;
      for (const req of requirements) {
        info += `${req.name}x${formatDisplayNumber(req.quantity)} `;
      }
      info += `\n产出:\n`;
      for (const out of outputs) {
        info += `${out.name}x${formatDisplayNumber(out.quantity)} `;
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
          `需要${req.name}x${formatDisplayNumber(req.quantity * maxCount)}，你只有${formatDisplayNumber(hasQuantity)}`,
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
          bp.quantity = roundItemQuantity(bp.quantity - consume);
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
    const markers = asJsonValue<Record<string, any>>(player.markers, {});
    if (!markers['制造']) markers['制造'] = 0;
    markers['制造'] += maxCount;
    if (!markers['制造' + recipeName]) markers['制造' + recipeName] = 0;
    markers['制造' + recipeName] += maxCount;

    // 标记获得
    const gainMarkers = asJsonValue<string[]>(recipe.gainMarkers, []);
    for (const gm of gainMarkers) {
      if (gm) {
        if (!markers[gm]) markers[gm] = 0;
        markers[gm] += maxCount;
      }
    }

    // 保存到数据库
    await this.playerService.enqueueUserWrite(userId, async () => {
      const _pd = await this.playerService.getPlayerData(userId);
      Object.assign(_pd.player, {
        backpack: cleanedBackpack,
        markers: markers,
      });
      await this.playerService.savePlayer(_pd.player);
    });

    const consumedText = consumedItems.map(c => `${c.name}x${formatDisplayNumber(c.quantity)}`).join('、');
    const producedText = producedItems.map(p => `${p.name}x${formatDisplayNumber(p.quantity)}`).join('、');

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

    const backpack: Item3[] = asJsonValue<Item3[]>(player.backpack, []);

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
      const markers = asJsonValue<Record<string, any>>(player.markers, {});
      if (!markers['分解']) markers['分解'] = 0;
      markers['分解'] += actualCount;

      await this.playerService.enqueueUserWrite(userId, async () => {
        const _pd = await this.playerService.getPlayerData(userId);
        Object.assign(_pd.player, {
          backpack: backpack,
          markers: markers,
        });
        await this.playerService.savePlayer(_pd.player);
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
      const requirements = asJsonValue<Item3[]>(recipe.requirements, []);

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

      await this.playerService.enqueueUserWrite(userId, async () => {
        const _pd = await this.playerService.getPlayerData(userId);
        Object.assign(_pd.player, { backpack: backpack });
        await this.playerService.savePlayer(_pd.player);
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

    const backpack: Item3[] = asJsonValue<Item3[]>(player.backpack, []);
    const equipment: Item3[] = asJsonValue<Item3[]>(player.equipment, []);
    const weapons: Item3[] = asJsonValue<Item3[]>(player.weapons, []);

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
      // 对齐原版 #装备 L4255-4259：仅当前未持武器时自动拿起新武器（当前武器=1），
      // 已有武器时只"背到背上"不切换当前武器
      const tookUp = Number(player.currentWeapon || 0) === 0;
      const currentWeapon = tookUp ? weapons.length : Number(player.currentWeapon || 0);
      // 重算套装判定（对应原版 _计算玩家 实时 套装判断 累加 玩家.套装）
      const sets = this.recomputeSets(equipment, weapons, this.getTreasuresFromPresets(player));
      await this.playerService.enqueueUserWrite(userId, async () => {
        const _pd = await this.playerService.getPlayerData(userId);
        Object.assign(_pd.player, {
          backpack: backpack,
          weapons: weapons,
          currentWeapon,
          sets,
        });
        await this.playerService.savePlayer(_pd.player);
      });
      // 文案对齐原版：拿在手中 / 背到了背上（含品质中括号）
      const q = this.qualityPrefix(item.data);
      return tookUp
        ? `${player.name}把${item.name}${this.qualityBracket(q)}拿在手中`
        : `${player.name}把${item.name}${this.qualityBracket(q)}背到了背上`;
    } else {
      // 同部位自动替换：对齐原版 #装备 L4264-4282，按类型查找已穿戴装备，
      // 旧装备放回背包、新装备顶替；文案对齐"脱下X,换上了Y / 穿上了Y"
      const newType = String(equip.type || '');
      let replaced: Item3 | undefined;
      const equipTypeOf = (it: Item3): string => {
        const def = typeof (this.staticData as any).getEquipmentByName === 'function'
          ? (this.staticData as any).getEquipmentByName(it.name)
          : undefined;
        return String(def?.equipType ?? def?.type ?? '');
      };
      const oldIndex = equipment.findIndex((it) => {
        const t = equipTypeOf(it);
        if (!newType) return false;
        // 植入体/增幅器与其他部位互不冲突，仅在同类之间替换
        return t === newType;
      });
      if (oldIndex !== -1) {
        replaced = equipment.splice(oldIndex, 1)[0];
        backpack.push(replaced);
      }

      // 加入装备列表
      equipment.push(item);
      // 重算套装判定
      const sets = this.recomputeSets(equipment, weapons, this.getTreasuresFromPresets(player));
      await this.playerService.enqueueUserWrite(userId, async () => {
        const _pd = await this.playerService.getPlayerData(userId);
        Object.assign(_pd.player, {
          backpack: backpack,
          equipment: equipment,
          sets,
        });
        await this.playerService.savePlayer(_pd.player);
      });
      const q = this.qualityPrefix(item.data);
      // 文案对齐原版：有替换"脱下旧,换上新"，无替换"穿上了"
      return replaced
        ? `${player.name}脱下${replaced.name}${this.qualityBracket(this.qualityPrefix(replaced.data))},换上了${item.name}${this.qualityBracket(q)}`
        : `${player.name}穿上了${item.name}${this.qualityBracket(q)}`;
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

    const backpack: Item3[] = asJsonValue<Item3[]>(player.backpack, []);
    const equipment: Item3[] = asJsonValue<Item3[]>(player.equipment, []);
    const weapons: Item3[] = asJsonValue<Item3[]>(player.weapons, []);

    // 先在装备中查找
    for (let i = 0; i < equipment.length; i++) {
      if (equipment[i].name === slot || equipment[i].name.includes(slot)) {
        // 将装备放回背包
        backpack.push(equipment[i]);
        equipment.splice(i, 1);

        // 重算套装判定
        const sets = this.recomputeSets(equipment, weapons, this.getTreasuresFromPresets(player));
        await this.playerService.enqueueUserWrite(userId, async () => {
          const _pd = await this.playerService.getPlayerData(userId);
          Object.assign(_pd.player, {
            backpack: backpack,
            equipment: equipment,
            sets,
          });
          await this.playerService.savePlayer(_pd.player);
        });
        return `${player.name}卸下了${slot}`;
      }
    }

    // 在武器中查找
    for (let i = 0; i < weapons.length; i++) {
      if (weapons[i].name === slot || weapons[i].name.includes(slot)) {
        backpack.push(weapons[i]);
        weapons.splice(i, 1);

        // currentWeapon 收敛（1-based：有效范围 1..weapons.length，0=拳头）。
        // 有意与原版不同（原版 _主程序.ecode L4487-4489：length < 当前武器 → 归 0 赤手）：
        // 本实现收敛到当前武器的新索引，保证"卸下一把背上的武器，手上那把不变"。
        // 原版会连手上的武器一起收回（更保守），复刻时选择了体验更优的口径，勿改回。
        let currentWeapon = player.currentWeapon || 0;
        if (currentWeapon > weapons.length) {
          currentWeapon = weapons.length;
        }

        // 重算套装判定
        const sets = this.recomputeSets(equipment, weapons, this.getTreasuresFromPresets(player));
        await this.playerService.enqueueUserWrite(userId, async () => {
          const _pd = await this.playerService.getPlayerData(userId);
          Object.assign(_pd.player, {
            backpack: backpack,
            weapons: weapons,
            currentWeapon,
            sets,
          });
          await this.playerService.savePlayer(_pd.player);
        });
        return `${player.name}卸下了${slot}`;
      }
    }

    return `${player.name} 未找到名为${slot}的已装备物品`;
  }

  /**
   * 品质前缀（对齐原版 显示品质 L1591-1639）
   * 从装备数据串首字符还原品质文本
   * @param data 装备数据串（首字符为品质前缀 e/d/c/b/a/s）
   * @returns 品质文本（普通/良好/优秀/精良/史诗/传说/神迹）
   */
  qualityPrefix(data: string): string {
    const c = (data || '').charAt(0).toLowerCase();
    const map: Record<string, string> = { e: '普通', d: '良好', c: '优秀', b: '精良', a: '史诗', s: '传说' };
    return map[c] || '神迹';
  }

  /**
   * 品质中括号（对齐原版 加中括号）：品质为"普通"时不加括号，其余返回 [品质]
   * @param quality 品质文本
   * @returns 形如 [优秀] 的字符串，普通品质返回空串
   */
  qualityBracket(quality: string): string {
    return quality === '普通' ? '' : `[${quality}]`;
  }

  /**
   * 判断是否为武器
   * 根据特殊序号和装备类型判断
   * @param specialSeq 特殊序号
   * @param equipType 装备类型
   * @returns 是否为武器
   */
  private isWeapon(specialSeq: number, equipType: string): boolean {
    // 对齐原版 数据分析.ecode 规则（同 staticData.isWeapon）：
    // 特殊序号非 0 时，负数是武器、正数是普通装备；只有特殊序号为 0 时才按类型判断
    if (specialSeq !== 0) return specialSeq < 0;
    const type = String(equipType || '');
    return type.endsWith('武器') || type === '工具';
  }

  /**
   * 重算玩家套装判定结果（对应原版 _计算玩家 实时调 套装判断 累加 玩家.套装）
   * 原版 _计算玩家 每次构建属性时遍历"玩家.装备"+本体特殊序号逐件 套装判断 累加写入 玩家.套装；
   * 本框架将结果持久化到 player.sets 字段（buildAttackerBonus 读取），
   * 故在任意装备/武器/植入体/增幅器/预设 变更后调用本方法重算写入。
   * @param equipment 已装备列表（Item3[]）
   * @param weapons 已装备武器列表（Item3[]）
   * @param treasures 法宝资源列表（Item3[]，对应原版 装备预设[2] 的"资源"类型装备）
   * @returns SetData 对象（直接作为 Player.sets Json 字段落库，避免双重编码）
   */
  recomputeSets(equipment: Item3[], weapons: Item3[], treasures?: Item3[]): Record<string, any> {
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
    return setData;
  }

  /**
   * 从玩家装备预设中提取"资源"类法宝（对应原版 装备预设[2] 的"资源"类型装备）
   * 原版 数据分析.ecode L907 扫描 玩家.装备预设[2].装备[a].类型=="资源"，本框架取预设数组中索引2（即第3个）。
   * @param player 玩家对象（含 equipmentPresets 字段）
   * @returns 法宝资源列表
   */
  private getTreasuresFromPresets(player: any): Item3[] {
    try {
      const presets: any[] = asJsonValue<any[]>(player?.equipmentPresets, []);
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
