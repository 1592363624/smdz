/**
 * 加成计算服务
 * 对应原版易语言：加成计算.ecode
 *
 * 功能：
 * - 加成限制（递减收益）：当属性值超过阈值时，超出部分按比例衰减
 * - 计算增益效果（如铠甲、套装等）
 * - 计算Buff效果
 * - 计算装备加成
 * - 计算最终属性
 */

import { Injectable, Logger } from '@nestjs/common';
import { SECOND_MS, isActive, toExpireMs } from './expire-time.util';

/**
 * 加成属性接口，对应原版易语言的"加成"数据类型
 */
export interface BonusData {
  攻击?: number;           // 攻击 [attack]
  魅力?: number;           // 魅力 [charm]
  攻击加成?: number;       // 攻击加成% [attackBonus]
  生命?: number;           // 生命 [hp]
  护盾?: number;           // 护盾 [shield]
  装甲?: number;           // 装甲 [armor]
  闪避?: number;           // 闪避 [dodge]
  命中?: number;           // 命中 [hit]
  钻石?: number;           // 钻石 [diamond]
  速度?: number;           // 速度 [speed]
  生命回复?: number;       // 生命回复 [hpRegen]
  护盾回复?: number;       // 护盾回复 [shieldRegen]
  装甲回复?: number;       // 装甲回复 [armorRegen]
  掉落率?: number;         // 掉落率 [dropRate]
  掉落品质?: number;       // 掉落品质 [dropQuality]
  韧性?: number;           // 韧性 [tenacity]
  减益?: number;           // 减益 [debuff]
  全体攻击?: boolean;     // 全体攻击 [allAttack]
  治疗效果?: number;       // 治疗效果 [healEffect]
  冷却?: number;           // 冷却 [cooldown]
  世界等级差距?: number;   // 世界等级差距 [gap]
  防御?: number;           // 防御 [defense]
  全抗性?: number;         // 全抗性 [allResist]
  暴击?: number;           // 暴击率 [crit]
  暴击伤害?: number;       // 暴击伤害 [critDmg]
  生命伤害上限?: number;   // 生命伤害上限% [hpDmgCap]
  装甲伤害上限?: number;   // 装甲伤害上限% [armorDmgCap]
  护盾伤害上限?: number;   // 护盾伤害上限% [shieldDmgCap]
  生命火抗?: number;       // 生命火抗 [hpFireRes]
  生命冰抗?: number;       // 生命冰抗 [hpIceRes]
  生命物抗?: number;       // 生命物抗 [hpPhysRes]
  生命电抗?: number;       // 生命电抗 [hpElecRes]
  装甲火抗?: number;       // 装甲火抗 [armorFireRes]
  装甲冰抗?: number;       // 装甲冰抗 [armorIceRes]
  装甲物抗?: number;       // 装甲物抗 [armorPhysRes]
  装甲电抗?: number;       // 装甲电抗 [armorElecRes]
  护盾火抗?: number;       // 护盾火抗 [shieldFireRes]
  护盾冰抗?: number;       // 护盾冰抗 [shieldIceRes]
  护盾物抗?: number;       // 护盾物抗 [shieldPhysRes]
  护盾电抗?: number;       // 护盾电抗 [shieldElecRes]
  攻击护盾?: number;       // 攻击护盾 [atkShield]
  攻击装甲?: number;       // 攻击装甲 [atkArmor]
  攻击生命?: number;       // 攻击生命 [atkHp]
  电伤?: number;           // 电伤 [elecDmg]
  火伤?: number;           // 火伤 [fireDmg]
  物伤?: number;           // 物伤 [physDmg]
  冰伤?: number;           // 冰伤 [iceDmg]
  采集?: number;           // 采集 [gather]
  吸生命?: number;         // 吸生命 [leechHp]
  吸装甲?: number;         // 吸装甲 [leechArmor]
  吸护盾?: number;         // 吸护盾 [leechShield]
  生命全抗?: number;       // 生命全抗 [hpAllRes]
  装甲全抗?: number;       // 装甲全抗 [armorAllRes]
  护盾全抗?: number;       // 护盾全抗 [shieldAllRes]
  经验?: number;           // 经验 [exp]
  升级经验?: number;       // 升级经验 [upgradeExp]
  溅射?: number;           // 溅射 [splash]
  溅射数量?: number;       // 溅射数量 [splashCount]
  溅射2?: number;          // 溅射2 [splash2]，原版 L849/L1936/L3192
  生命穿透?: number;       // 生命穿透 [hpPenetration]
  装甲穿透?: number;       // 装甲穿透 [armorPenetration]
  护盾穿透?: number;       // 护盾穿透 [shieldPenetration]
  贯穿?: number;           // 贯穿几率 [penetrate]
  抗贯穿?: number;         // 抗贯穿 [antiPenetrate]
  攻击2?: number;          // 攻击2（受加成递减限制）[attack2]
  生命2?: number;          // 生命2 [hp2]
  护盾2?: number;          // 护盾2 [shield2]
  装甲2?: number;          // 装甲2 [armor2]
  闪避2?: number;          // 闪避2 [dodge2]
  命中2?: number;          // 命中2 [hit2]
  速度2?: number;          // 速度2 [speed2]
  生命回复2?: number;      // 生命回复2 [hpRegen2]
  护盾回复2?: number;      // 护盾回复2 [shieldRegen2]
  装甲回复2?: number;      // 装甲回复2 [armorRegen2]
  电伤2?: number;          // 电伤2 [elecDmg2]
  火伤2?: number;          // 火伤2 [fireDmg2]
  物伤2?: number;          // 物伤2 [physDmg2]
  冰伤2?: number;          // 冰伤2 [iceDmg2]
  吸生命2?: number;        // 吸生命2 [leechHp2]
  吸装甲2?: number;        // 吸装甲2 [leechArmor2]
  吸护盾2?: number;        // 吸护盾2 [leechShield2]
  反伤?: number;           // 反伤 [reflectDmg]
  麻醉?: number;           // 麻醉 [anesthesia]
  必中?: boolean;          // 必中 [mustHit]
  攻击次数?: number;       // 攻击次数 [attackCount]
  攻击文本?: string;       // 攻击文本 [attackText]
  生产力?: number;         // 生产力 [production]
  卷土重来?: number;       // 卷土重来 [comeback]
}

/**
 * 属性接口，对应原版易语言的"属性"数据类型
 */
export interface AttributeData {
  phys: number;  // 物理
  elec: number;  // 雷电
  fire: number;  // 火焰
  ice: number;   // 冰霜
}

/**
 * 套装信息
 */
export interface SetData {
  blackWedding?: number;      // 黑花嫁
  whiteWedding?: number;      // 白花嫁
  nanoSuit?: number;          // 纳米生化装
  lifeBless?: number;         // 生命祝福
  maid?: number;              // 女仆
  sakuraHits?: number;        // 小樱命中次数
  attackMode?: number;        // 攻击模式
  crown?: number;             // 皇冠
  legendaryRate?: number;     // 传说率
  takeVehicle?: string;       // 接管载具
  currentAnesthesia?: number; // 当前麻醉
  sixPaths?: any[];           // 六道轮回
  ranger?: number;            // 游骑兵
  wanderer?: number;          // 游侠
  power?: number;             // 动力
  antiExplosion?: number;     // 防爆
  fearless?: number;          // 无畏
  christmas?: number;         // 圣诞
  assault?: number;           // 强袭
  scientist?: number;         // 科学家
  sleepover?: number;         // 陪睡
  amplifier?: number;         // 增幅器
  implant?: number;           // 植入体
  onePunch?: number;          // 一拳
  white?: boolean;            // 白
  coil?: number;              // 线圈
  eveningGown?: number;       // 晚礼服
  lanMode?: number;           // 兰音模式
  reverseBunny?: number;      // 逆兔女郎
}

/**
 * 增益接口，对应原版易语言的"增益"数据类型（@Struct.ecode）
 * 用于记录玩家/地图上的持续效果，含名称、有效期、强度与叠加规则
 */
export interface BuffData {
  name: string;            // 名称
  expireAt?: number;       // 有效期至（毫秒时间戳；全项目统一口径，读取时兼容历史秒级数据）
  strength?: number;       // 强度
  stackTime?: boolean;     // 是否叠加时间
  bonus?: BonusData;       // 加成（增益列表里定义的效果）
  chance?: number;         // 几率
  duration?: number;       // 持续时间（秒）
  triggerText?: string;    // 触发文本
}

/**
 * 载具接口，对应原版易语言的"载具"数据类型（@Struct.ecode）
 */
export interface VehicleData {
  id?: string;             // 编号（八位文本id）
  name?: string;           // 名称
  bonus?: BonusData;       // 加成
  currentHp?: number;      // 当前生命
  hair?: boolean;          // 发丝（白的发丝加成）
}

/**
 * 地图增益上下文，用于获得地图增益()：描述地图上的建筑/召唤物/物品/标记
 */
export interface MapBonusContext {
  buildings?: any[];                // 地图建筑（如"花园猫窝"）
  summons?: any[];                  // 地图召唤物及其装备
  items?: any[];                    // 地图物品
  markers3?: BuffData[];            // 地图标记3（含有效期与强度的增益）
  /** 孵化完成后由地图/召唤物服务创建真实幼崽实例。 */
  onHatch?: (request: {
    type: string;
    ownerQQ: string;
    createdAt: number;
    growthSeconds: number;
  }) => void;
}

/**
 * 装备强化上下文，用于计算装备强化()：描述被强化的装备
 */
export interface EquipReinforceContext {
  type?: string;           // 装备类型（用于读取对应强化熟练度）
  name?: string;           // 装备名称（用于逆向熟练度判断）
  self?: BonusData;        // 装备自带属性
  bonus?: BonusData;       // 装备加成属性
}

@Injectable()
export class BonusService {
  private readonly logger = new Logger(BonusService.name);

  /**
   * 加成限制（递减收益）
   * 对应原版：加成限制()
   * 当数值超过阈值时，超出部分按比例衰减
   *
   * 原版逻辑（加成计算.ecode L3-L62）：
   * - 以“原始数值”判断落在哪个区间（而非剩余值）
   * - 每个区间先累加前一区间的固定封顶值，再对剩余部分按对应比例衰减
   *   <1000 不衰减；<2000 乘0.9；<3500 乘0.8；<5500 乘0.7；<8500 乘0.55；
   *   <12000 乘0.3；<16000 乘0.1；否则乘0.02
   *
   * @param value 原始数值
   * @returns 限制后的数值
   */
  applyDiminishingReturns(value: number): number {
    if (value < 1000) return value;

    let result = 1000;
    let remaining = value - 1000;

    // 注意：下方 if 判断全部基于“原始数值 value”，与剩余量 remaining 无关（对齐原版）
    if (value < 2000) {
      result += remaining * 0.9;
    } else {
      result += 900;
      remaining -= 1000;
      if (value < 3500) {
        result += remaining * 0.8;
      } else {
        result += 1200;
        remaining -= 1500;
        if (value < 5500) {
          result += remaining * 0.7;
        } else {
          result += 1400;
          remaining -= 2000;
          if (value < 8500) {
            result += remaining * 0.55;
          } else {
            result += 1650;
            remaining -= 3000;
            if (value < 12000) {
              result += remaining * 0.3;
            } else {
              result += 1050;
              remaining -= 3500;
              if (value < 16000) {
                result += remaining * 0.1;
              } else {
                result += 1600 + (remaining - 4000) * 0.02;
              }
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * 对加成对象的所有二阶属性应用递减收益
   * 对应原版：加成限制1()
   */
  applyAllDiminishingReturns(bonus: BonusData): void {
    if (bonus.攻击2) bonus.攻击2 = this.applyDiminishingReturns(bonus.攻击2);
    if (bonus.电伤2) bonus.电伤2 = this.applyDiminishingReturns(bonus.电伤2);
    if (bonus.物伤2) bonus.物伤2 = this.applyDiminishingReturns(bonus.物伤2);
    if (bonus.火伤2) bonus.火伤2 = this.applyDiminishingReturns(bonus.火伤2);
    if (bonus.冰伤2) bonus.冰伤2 = this.applyDiminishingReturns(bonus.冰伤2);
    if (bonus.闪避2) bonus.闪避2 = this.applyDiminishingReturns(bonus.闪避2);
    if (bonus.命中2) bonus.命中2 = this.applyDiminishingReturns(bonus.命中2);
    if (bonus.护盾2) bonus.护盾2 = this.applyDiminishingReturns(bonus.护盾2);
    if (bonus.装甲2) bonus.装甲2 = this.applyDiminishingReturns(bonus.装甲2);
    if (bonus.生命2) bonus.生命2 = this.applyDiminishingReturns(bonus.生命2);
    if (bonus.速度2) bonus.速度2 = this.applyDiminishingReturns(bonus.速度2);
    if (bonus.生命回复2) bonus.生命回复2 = this.applyDiminishingReturns(bonus.生命回复2);
    if (bonus.装甲回复2) bonus.装甲回复2 = this.applyDiminishingReturns(bonus.装甲回复2);
    if (bonus.护盾回复2) bonus.护盾回复2 = this.applyDiminishingReturns(bonus.护盾回复2);
  }

  /**
   * 合并两个加成对象
   * 将source的加成累加到target上
   */
  mergeBonus(target: BonusData, source: BonusData): BonusData {
    const result = { ...target };
    for (const key of Object.keys(source) as (keyof BonusData)[]) {
      const val = source[key];
      if (val === undefined || val === null) continue;
      if (typeof val === 'boolean') {
        (result as any)[key] = (result as any)[key] || val;
      } else if (typeof val === 'number') {
        (result as any)[key] = ((result as any)[key] || 0) + val;
      }
    }
    return result;
  }

  /**
   * 计算玩家最终属性
   * 将基础属性 + 装备加成 + 增益加成 + 套装加成 合并计算
   */
  calculateFinalStats(base: BonusData, equipment: BonusData, buffs: BonusData, sets: BonusData): BonusData {
    let final = this.mergeBonus({}, base);
    final = this.mergeBonus(final, equipment);
    final = this.mergeBonus(final, buffs);
    final = this.mergeBonus(final, sets);
    this.applyAllDiminishingReturns(final);
    return final;
  }

  /**
   * 增加穿透属性
   * 对应原版：增加穿透()
   */
  addPenetration(bonus: BonusData, value: number): void {
    bonus.生命穿透 = (bonus.生命穿透 || 0) + value;
    bonus.装甲穿透 = (bonus.装甲穿透 || 0) + value;
    bonus.护盾穿透 = (bonus.护盾穿透 || 0) + value;
  }

  /**
   * 增强器：按剩余最高伤害提升对应三层抗性。
   * 对应原版 加成计算.ecode L3453-L3574；类型注释：1护盾、2装甲、3生命。
   */
  enhancer(
    bonus: BonusData,
    type: 1 | 2 | 3,
    remainingPhysical: number,
    remainingFire: number,
    remainingIce: number,
    remainingElec: number,
    increase: number,
    effectText: string,
  ): string {
    let damageType = 0;
    if (remainingElec > remainingPhysical && remainingElec > remainingIce && remainingElec > remainingFire) {
      damageType = 1;
    }
    if (damageType === 0
      && remainingPhysical > remainingElec
      && remainingPhysical > remainingIce
      && remainingPhysical > remainingFire) {
      damageType = 2;
    }
    if (damageType === 0
      && remainingFire > remainingElec
      && remainingFire > remainingIce
      && remainingFire > remainingPhysical) {
      damageType = 3;
    }
    if (damageType === 0
      && remainingIce > remainingElec
      && remainingIce > remainingPhysical
      && remainingIce > remainingFire) {
      damageType = 4;
    }

    const layer = type === 1 ? '护盾' : type === 2 ? '装甲' : '生命';
    let nextEffectText = effectText;
    let kindKey = '冰抗';
    let kindField: '电抗' | '物抗' | '火抗' | '冰抗' = '冰抗';
    if (damageType === 1) {
      kindKey = '电抗';
      kindField = '电抗';
    } else if (damageType === 2) {
      kindKey = '物抗';
      kindField = '物抗';
    } else if (damageType === 3) {
      kindKey = '火抗';
      kindField = '火抗';
    }
    const fields = {
      护盾: {
        电抗: '护盾电抗', 物抗: '护盾物抗', 火抗: '护盾火抗', 冰抗: '护盾冰抗',
      },
      装甲: {
        电抗: '装甲电抗', 物抗: '装甲物抗', 火抗: '装甲火抗', 冰抗: '装甲冰抗',
      },
      生命: {
        电抗: '生命电抗', 物抗: '生命物抗', 火抗: '生命火抗', 冰抗: '生命冰抗',
      },
    } as const;
    const field = fields[layer][kindField];
    const current = (bonus[field] || 0) as number;
    bonus[field] = current + (1 - current / 100) * increase;
    nextEffectText += `(${kindKey}+${increase})`;
    return nextEffectText;
  }

  /**
   * 计算经验值升级所需经验（保留兼容签名，实际升级门槛计算统一走 PlayerService.calcUpgradeExp）
   * 对应原版升级经验公式（加成计算.ecode L1781-1794）：
   *   a2 = (c*c + 5) * (1 + 升级经验加成/100) * (1 - 风月入墨减益/100)
   * 注意：原版此处曾误用 100*1.15^(n-1) 近似，已修正为 1:1 公式，避免后续误用产生偏差。
   */
  calcUpgradeExp(level: number, upgradeExpBonus = 0, windMoonReduce = 0): number {
    const base = level * level + 5;
    return Math.floor(base * (1 + upgradeExpBonus / 100) * (1 - windMoonReduce / 100));
  }

  /**
   * 计算玩家战斗力
   * 对应原版：计算战斗力()（加成计算.ecode L653-L663）
   * 根据各项属性综合计算，公式如下：
   *
   * a1 = (生命/抗性分母 + 装甲/抗性分母 + 护盾/抗性分母) * 3
   * a1 += (电伤+物伤+冰伤+火伤 + 暴击/100*暴击伤害/100*(电伤+物伤+冰伤+火伤))
   *        * (1 + (攻击生命+攻击装甲+攻击护盾)/300) / (1 - (护盾穿透+装甲穿透+生命穿透)/300)
   * a1 += 各部位回复加成（生命回复*10 + 生命回复2/10*生命，等）
   * a1 += 速度*5 + 闪避*5 + 命中*5
   *
   * @param bonus 加成（属性）数据
   * @returns 战斗力数值
   */
  calcCombatPower(bonus: BonusData): number {
    const safe = (v: number | undefined) => this.safeNum(v);

    // 原版没有对分母做截断，按加成计算.ecode L653-L663 原样保留。
    const hpDenom =
      1 - (safe(bonus.生命火抗) + safe(bonus.生命冰抗) + safe(bonus.生命电抗) + safe(bonus.生命物抗)) / 500;
    const armorDenom =
      1 - (safe(bonus.装甲火抗) + safe(bonus.装甲冰抗) + safe(bonus.装甲电抗) + safe(bonus.装甲物抗)) / 500;
    const shieldDenom =
      1 - (safe(bonus.护盾火抗) + safe(bonus.护盾冰抗) + safe(bonus.护盾电抗) + safe(bonus.护盾物抗)) / 500;

    // 第一段：生命/装甲/护盾（经抗性放大后）* 3
    let a1 =
      (safe(bonus.生命) / hpDenom + safe(bonus.装甲) / armorDenom + safe(bonus.护盾) / shieldDenom) * 3;

    // 第二段：四种元素伤害 + 暴击期望伤害，再乘以攻击加成与穿透放大
    const elementDmg =
      safe(bonus.电伤) + safe(bonus.物伤) + safe(bonus.冰伤) + safe(bonus.火伤);
    const critBonus = (safe(bonus.暴击) / 100) * (safe(bonus.暴击伤害) / 100) * elementDmg;
    const atkBoost = 1 + (safe(bonus.攻击生命) + safe(bonus.攻击装甲) + safe(bonus.攻击护盾)) / 300;
    const penDenom = 1 - (safe(bonus.护盾穿透) + safe(bonus.装甲穿透) + safe(bonus.生命穿透)) / 300;
    a1 += ((elementDmg + critBonus) * atkBoost) / penDenom;

    // 第三段：三部位回复加成（含二阶回复按比例折算）
    a1 +=
      (safe(bonus.生命回复) * 10 + (safe(bonus.生命回复2) / 10) * safe(bonus.生命)) / hpDenom +
      (safe(bonus.装甲回复) * 10 + (safe(bonus.装甲回复2) / 10) * safe(bonus.装甲)) / armorDenom +
      (safe(bonus.护盾回复) * 10 + (safe(bonus.护盾回复2) / 10) * safe(bonus.护盾)) / shieldDenom;

    // 第四段：速度/闪避/命中
    a1 += safe(bonus.速度) * 5 + safe(bonus.闪避) * 5 + safe(bonus.命中) * 5;

    return a1;
  }

  /**
   * 获取递减收益的显示文本（仅在数值>500时显示）
   * 对应原版加成限制的返回值
   */
  getDiminishingText(originalValue: number, limitedValue: number): string {
    if (originalValue > 500) {
      return `(↓${Math.round(originalValue - limitedValue)})`;
    }
    return '';
  }

  /**
   * 安全取值：undefined/null/非有限数统一按 0 处理，避免 NaN 污染计算结果
   * @param v 数值
   * @returns 安全数值
   */
  private safeNum(v: number | string | undefined | null): number {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (typeof v === 'string' && v.trim() !== '') {
      const parsed = Number(v);
      return isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  /**
   * 增加全抗
   * 对应原版：增加全抗()（加成计算.ecode L1473-L1520）
   * 正数按堆叠公式累加到四抗；负数按百分比乘法削弱四抗
   * @param bonus 要修改的加成对象
   * @param lifeAllRes 生命全抗
   * @param shieldAllRes 护盾全抗
   * @param armorAllRes 装甲全抗
   */
  private addAllResistance(bonus: BonusData, lifeAllRes = 0, shieldAllRes = 0, armorAllRes = 0): void {
    if (lifeAllRes !== 0) {
      if (lifeAllRes > 0) {
        // 正数：按 (100 - 当前)/100 * 全抗 的堆叠公式累加
        bonus.生命火抗 = this.safeNum(bonus.生命火抗) + ((100 - this.safeNum(bonus.生命火抗)) / 100) * lifeAllRes;
        bonus.生命冰抗 = this.safeNum(bonus.生命冰抗) + ((100 - this.safeNum(bonus.生命冰抗)) / 100) * lifeAllRes;
        bonus.生命物抗 = this.safeNum(bonus.生命物抗) + ((100 - this.safeNum(bonus.生命物抗)) / 100) * lifeAllRes;
        bonus.生命电抗 = this.safeNum(bonus.生命电抗) + ((100 - this.safeNum(bonus.生命电抗)) / 100) * lifeAllRes;
      } else {
        // 负数：按百分比乘法削弱
        const f = 1 + lifeAllRes / 100;
        bonus.生命火抗 = this.safeNum(bonus.生命火抗) * f;
        bonus.生命冰抗 = this.safeNum(bonus.生命冰抗) * f;
        bonus.生命物抗 = this.safeNum(bonus.生命物抗) * f;
        bonus.生命电抗 = this.safeNum(bonus.生命电抗) * f;
      }
    }
    if (armorAllRes !== 0) {
      if (armorAllRes > 0) {
        bonus.装甲火抗 = this.safeNum(bonus.装甲火抗) + ((100 - this.safeNum(bonus.装甲火抗)) / 100) * armorAllRes;
        bonus.装甲冰抗 = this.safeNum(bonus.装甲冰抗) + ((100 - this.safeNum(bonus.装甲冰抗)) / 100) * armorAllRes;
        bonus.装甲物抗 = this.safeNum(bonus.装甲物抗) + ((100 - this.safeNum(bonus.装甲物抗)) / 100) * armorAllRes;
        bonus.装甲电抗 = this.safeNum(bonus.装甲电抗) + ((100 - this.safeNum(bonus.装甲电抗)) / 100) * armorAllRes;
      } else {
        const f = 1 + armorAllRes / 100;
        bonus.装甲火抗 = this.safeNum(bonus.装甲火抗) * f;
        bonus.装甲冰抗 = this.safeNum(bonus.装甲冰抗) * f;
        bonus.装甲物抗 = this.safeNum(bonus.装甲物抗) * f;
        bonus.装甲电抗 = this.safeNum(bonus.装甲电抗) * f;
      }
    }
    if (shieldAllRes !== 0) {
      if (shieldAllRes > 0) {
        bonus.护盾火抗 = this.safeNum(bonus.护盾火抗) + ((100 - this.safeNum(bonus.护盾火抗)) / 100) * shieldAllRes;
        bonus.护盾冰抗 = this.safeNum(bonus.护盾冰抗) + ((100 - this.safeNum(bonus.护盾冰抗)) / 100) * shieldAllRes;
        bonus.护盾物抗 = this.safeNum(bonus.护盾物抗) + ((100 - this.safeNum(bonus.护盾物抗)) / 100) * shieldAllRes;
        bonus.护盾电抗 = this.safeNum(bonus.护盾电抗) + ((100 - this.safeNum(bonus.护盾电抗)) / 100) * shieldAllRes;
      } else {
        const f = 1 + shieldAllRes / 100;
        bonus.护盾火抗 = this.safeNum(bonus.护盾火抗) * f;
        bonus.护盾冰抗 = this.safeNum(bonus.护盾冰抗) * f;
        bonus.护盾物抗 = this.safeNum(bonus.护盾物抗) * f;
        bonus.护盾电抗 = this.safeNum(bonus.护盾电抗) * f;
      }
    }
  }

  /** 供法宝加成2使用的增加全抗公开入口，公式与私有实现一致。 */
  private addAllResistancePublic(bonus: BonusData, lifeAllRes = 0, shieldAllRes = 0, armorAllRes = 0): void {
    this.addAllResistance(bonus, lifeAllRes, shieldAllRes, armorAllRes);
  }

  private normalizeEquip(item: any): any {
    return item && typeof item === 'object' ? item : {};
  }

  private normalizeWeapon(item: any): any {
    const weapon = item && typeof item === 'object' ? item : {};
    if (weapon.cooldown === undefined && weapon.冷却 !== undefined) weapon.cooldown = weapon.冷却;
    if (weapon.冷却 === undefined && weapon.cooldown !== undefined) weapon.冷却 = weapon.cooldown;
    return weapon;
  }

  /**
   * 全属性调整
   * 对应原版：全属性调整()（使魔技能.ecode L87-L124）
   * 将属性对象中的所有核心数值统一乘以调整系数（用于梦倾天下等百分比削弱/增强）
   * @param attributes 属性对象（会被原地修改）
   * @param factor 调整系数（如 0.9 表示整体降低10%）
   */
  adjustAllAttributes(attributes: BonusData, factor: number): void {
    attributes.护盾 = this.safeNum(attributes.护盾) * factor;
    attributes.装甲 = this.safeNum(attributes.装甲) * factor;
    attributes.生命 = this.safeNum(attributes.生命) * factor;
    attributes.护盾火抗 = this.safeNum(attributes.护盾火抗) * factor;
    attributes.护盾冰抗 = this.safeNum(attributes.护盾冰抗) * factor;
    attributes.护盾物抗 = this.safeNum(attributes.护盾物抗) * factor;
    attributes.护盾电抗 = this.safeNum(attributes.护盾电抗) * factor;
    attributes.装甲火抗 = this.safeNum(attributes.装甲火抗) * factor;
    attributes.装甲冰抗 = this.safeNum(attributes.装甲冰抗) * factor;
    attributes.装甲物抗 = this.safeNum(attributes.装甲物抗) * factor;
    attributes.装甲电抗 = this.safeNum(attributes.装甲电抗) * factor;
    attributes.生命火抗 = this.safeNum(attributes.生命火抗) * factor;
    attributes.生命冰抗 = this.safeNum(attributes.生命冰抗) * factor;
    attributes.生命物抗 = this.safeNum(attributes.生命物抗) * factor;
    attributes.生命电抗 = this.safeNum(attributes.生命电抗) * factor;
    attributes.闪避 = this.safeNum(attributes.闪避) * factor;
    attributes.命中 = this.safeNum(attributes.命中) * factor;
    attributes.电伤 = this.safeNum(attributes.电伤) * factor;
    attributes.火伤 = this.safeNum(attributes.火伤) * factor;
    attributes.冰伤 = this.safeNum(attributes.冰伤) * factor;
    attributes.物伤 = this.safeNum(attributes.物伤) * factor;
    attributes.暴击 = this.safeNum(attributes.暴击) * factor;
    attributes.暴击伤害 = this.safeNum(attributes.暴击伤害) * factor;
    attributes.护盾回复 = this.safeNum(attributes.护盾回复) * factor;
    attributes.装甲回复 = this.safeNum(attributes.装甲回复) * factor;
    attributes.生命回复 = this.safeNum(attributes.生命回复) * factor;
    attributes.护盾回复2 = this.safeNum(attributes.护盾回复2) * factor;
    attributes.装甲回复2 = this.safeNum(attributes.装甲回复2) * factor;
    attributes.生命回复2 = this.safeNum(attributes.生命回复2) * factor;
    attributes.贯穿 = this.safeNum(attributes.贯穿) * factor;
    attributes.抗贯穿 = this.safeNum(attributes.抗贯穿) * factor;
    attributes.攻击护盾 = this.safeNum(attributes.攻击护盾) * factor;
    attributes.攻击装甲 = this.safeNum(attributes.攻击装甲) * factor;
    attributes.攻击生命 = this.safeNum(attributes.攻击生命) * factor;
  }

  /**
   * 叠加加成（核心合并逻辑）
   * 对应原版：叠加加成()（加成计算.ecode L682-L1160）
   * 将 source 加成按规则累加到 target 加成上。规则摘要：
   * - 常规主属性（攻击/生命/护盾/装甲/闪避/命中/速度/回复）：源值>=0 直接累加
   *   （非增益时再乘增幅器对应二阶属性百分比放大）；源值<0 按 (1+源值/100)*韧性减免 乘法叠加
   * - 抗性类按 (100-当前)/100*源值 的堆叠公式累加
   * - 二阶属性（*2）在增益模式下按百分比乘到对应主属性上
   * @param target 目标加成（原地修改）
   * @param source 来源加成
   * @param opts 叠加选项
   */
  private mergeBonusTo(
    target: BonusData,
    source: BonusData,
    opts: {
      increaseValue?: number;    // 增加值（默认为1）
      isBuff?: boolean;          // 是否增益（叠加增益列表的属性用）
      amplifier?: BonusData;     // 增幅器
      noSplash?: boolean;        // 不叠加溅射
      noProduction?: boolean;    // 不叠加生产
      isEquipment?: boolean;     // 是否装备（叠加到属性上）
      equipmentAttrs?: BonusData; // 属性（装备专用）
    } = {},
  ): void {
    const inc = opts.increaseValue || 1;
    const isBuff = !!opts.isBuff;
    const z = opts.amplifier || {};
    const attrs = opts.equipmentAttrs;

    // 韧性减免值：影响负属性（百分比削弱）的减免程度
    const a1 = 1 - this.safeNum(target.韧性) / 100;

    // 生产（默认叠加）
    if (!opts.noProduction) {
      target.生产力 = this.safeNum(target.生产力) + this.safeNum(source.生产力) * inc;
    }
    // 魅力、攻击次数直接累加
    target.魅力 = this.safeNum(target.魅力) + this.safeNum(source.魅力) * inc;
    target.攻击次数 = this.safeNum(target.攻击次数) + this.safeNum(source.攻击次数) * inc;

    // 常规主属性（正加负乘）
    this.addPrimary(target, source, '攻击', '攻击2', inc, isBuff, a1, z);
    this.addPrimary(target, source, '生命', '生命2', inc, isBuff, a1, z);
    this.addPrimary(target, source, '护盾', '护盾2', inc, isBuff, a1, z);
    this.addPrimary(target, source, '装甲', '装甲2', inc, isBuff, a1, z);
    this.addPrimary(target, source, '闪避', '闪避2', inc, isBuff, a1, z);
    this.addPrimary(target, source, '命中', '命中2', inc, isBuff, a1, z);
    this.addPrimary(target, source, '速度', '速度2', inc, isBuff, a1, z);
    this.addPrimary(target, source, '生命回复', '生命回复2', inc, isBuff, a1, z);
    this.addPrimary(target, source, '护盾回复', '护盾回复2', inc, isBuff, a1, z);
    this.addPrimary(target, source, '装甲回复', '装甲回复2', inc, isBuff, a1, z);

    // 无条件累加字段
    this.addNum(target, source, '钻石', inc);
    this.addNum(target, source, '掉落率', inc);
    this.addNum(target, source, '掉落品质', inc);
    this.addNum(target, source, '治疗效果', inc);
    this.addNum(target, source, '世界等级差距', inc);
    this.addNum(target, source, '采集', inc);
    this.addNum(target, source, '吸生命', inc);
    this.addNum(target, source, '吸装甲', inc);
    this.addNum(target, source, '吸护盾', inc);
    this.addNum(target, source, '吸生命2', inc);
    this.addNum(target, source, '吸装甲2', inc);
    this.addNum(target, source, '吸护盾2', inc);
    this.addNum(target, source, '经验', inc);
    this.addNum(target, source, '升级经验', inc);
    this.addNum(target, source, '冷却', inc);
    this.addNum(target, source, '生命穿透', inc);
    this.addNum(target, source, '装甲穿透', inc);
    this.addNum(target, source, '护盾穿透', inc);
    this.addNum(target, source, '麻醉', inc);
    this.addNum(target, source, '反伤', inc);

    // 韧性：正加（带已方剩余韧性比例），负按百分比乘
    {
      const val = this.safeNum(source.韧性);
      if (val >= 0) {
        target.韧性 = this.safeNum(target.韧性) + (1 - this.safeNum(target.韧性) / 100) * val * inc;
      } else {
        target.韧性 = this.safeNum(target.韧性) * (1 + val / 100) * a1 * inc;
      }
    }
    // 减益：正加，负按百分比乘
    {
      const val = this.safeNum(source.减益);
      if (val >= 0) {
        target.减益 = this.safeNum(target.减益) + val * inc;
      } else {
        target.减益 = this.safeNum(target.减益) * (1 + val / 100) * a1 * inc;
      }
    }
    // 全体攻击：任一来源开启则开启
    if (source.全体攻击) target.全体攻击 = true;

    // 暴击/暴击伤害：正加，负按韧性减免后加
    this.addWithTenacity(target, source, '暴击', inc, a1);
    this.addWithTenacity(target, source, '暴击伤害', inc, a1);

    // 伤害上限：取最小值（未设置时默认100）
    this.applyDmgCap(target, '生命伤害上限', source.生命伤害上限);
    this.applyDmgCap(target, '护盾伤害上限', source.护盾伤害上限);
    this.applyDmgCap(target, '装甲伤害上限', source.装甲伤害上限);

    // 溅射2：正加（不叠加溅射时跳过），负按韧性减免后加
    {
      const val = this.safeNum(source.溅射数量);
      if (val >= 0) {
        if (!opts.noSplash) target.溅射数量 = this.safeNum(target.溅射数量) + val * inc;
      } else {
        target.溅射数量 = this.safeNum(target.溅射数量) + val * a1 * inc;
      }
    }

    // 各部位单抗（12项）：正负都按堆叠公式，负值再乘韧性减免
    this.addResist(target, source, '生命火抗', inc, a1);
    this.addResist(target, source, '生命冰抗', inc, a1);
    this.addResist(target, source, '生命物抗', inc, a1);
    this.addResist(target, source, '生命电抗', inc, a1);
    this.addResist(target, source, '护盾火抗', inc, a1);
    this.addResist(target, source, '护盾冰抗', inc, a1);
    this.addResist(target, source, '护盾物抗', inc, a1);
    this.addResist(target, source, '护盾电抗', inc, a1);
    this.addResist(target, source, '装甲火抗', inc, a1);
    this.addResist(target, source, '装甲冰抗', inc, a1);
    this.addResist(target, source, '装甲物抗', inc, a1);
    this.addResist(target, source, '装甲电抗', inc, a1);

    // 全抗（3项）：正按堆叠公式存字段，负走增加全抗（按韧性减免）
    this.addAllResistField(target, source, '生命全抗', inc, a1);
    this.addAllResistField(target, source, '护盾全抗', inc, a1);
    this.addAllResistField(target, source, '装甲全抗', inc, a1);

    // 攻击护盾/装甲/生命：正加，负按韧性减免后加
    this.addWithTenacity(target, source, '攻击护盾', inc, a1);
    this.addWithTenacity(target, source, '攻击装甲', inc, a1);
    this.addWithTenacity(target, source, '攻击生命', inc, a1);

    // 元素伤害：正加（非增益受增幅器二阶放大），负按韧性减免后加
    this.addElemDmg(target, source, '电伤', '电伤2', inc, isBuff, a1, z);
    this.addElemDmg(target, source, '火伤', '火伤2', inc, isBuff, a1, z);
    this.addElemDmg(target, source, '物伤', '物伤2', inc, isBuff, a1, z);
    this.addElemDmg(target, source, '冰伤', '冰伤2', inc, isBuff, a1, z);

    // 卷土重来、溅射（默认叠加）
    target.卷土重来 = this.safeNum(target.卷土重来) + this.safeNum(source.卷土重来);
    if (!opts.noSplash) {
      target.溅射 = this.safeNum(target.溅射) + this.safeNum(source.溅射) * inc;
    }

    // 贯穿/抗贯穿：正加（默认叠加），负按百分比乘
    this.addPenetrateChance(target, source, '贯穿', inc, a1, !!opts.noSplash);
    this.addPenetrateChance(target, source, '抗贯穿', inc, a1, !!opts.noSplash);

    // 二阶回复（生命回复2等）：正加，负按百分比乘到主回复与二阶回复
    this.addRegen2(target, source, '生命回复2', inc, a1);
    this.addRegen2(target, source, '护盾回复2', inc, a1);
    this.addRegen2(target, source, '装甲回复2', inc, a1);

    // 二阶属性（*2）：装备模式进属性对象，增益模式按百分比乘到主属性，否则累加
    this.addSecondOrder(target, source, '生命2', '生命', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, '护盾2', '护盾', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, '装甲2', '装甲', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, '闪避2', '闪避', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, '命中2', '命中', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, '电伤2', '电伤', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, '火伤2', '火伤', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, '物伤2', '物伤', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, '冰伤2', '冰伤', inc, isBuff, a1, !!opts.isEquipment, attrs);

    // 攻击2（特殊）：增益时按百分比乘到四种伤害上，否则累加/负乘
    this.addAttack2(target, source, '攻击2', inc, isBuff, a1);
  }

  /**
   * 常规主属性叠加：源值>=0 直接累加（非增益时乘增幅器二阶放大），源值<0 按百分比乘
   */
  private addPrimary(
    target: BonusData,
    source: BonusData,
    field: keyof BonusData,
    field2: keyof BonusData,
    inc: number,
    isBuff: boolean,
    a1: number,
    z: BonusData,
  ): void {
    const val = this.safeNum(source[field] as number);
    if (val >= 0) {
      if (isBuff) {
        (target[field] as number) = this.safeNum(target[field] as number) + val * inc;
      } else {
        (target[field] as number) =
          this.safeNum(target[field] as number) + val * (1 + this.safeNum(z[field2] as number) / 100) * inc;
      }
    } else {
      (target[field] as number) = this.safeNum(target[field] as number) * (1 + val / 100) * a1 * inc;
    }
  }

  /**
   * 元素伤害叠加：源值>=0 直接累加（非增益乘增幅器二阶放大），源值<0 按韧性减免后加
   */
  private addElemDmg(
    target: BonusData,
    source: BonusData,
    field: keyof BonusData,
    field2: keyof BonusData,
    inc: number,
    isBuff: boolean,
    a1: number,
    z: BonusData,
  ): void {
    const val = this.safeNum(source[field] as number);
    if (val >= 0) {
      if (isBuff) {
        (target[field] as number) = this.safeNum(target[field] as number) + val * inc;
      } else {
        (target[field] as number) =
          this.safeNum(target[field] as number) + val * (1 + this.safeNum(z[field2] as number) / 100) * inc;
      }
    } else {
      (target[field] as number) = this.safeNum(target[field] as number) + val * a1 * inc;
    }
  }

  /**
   * 简单累加：target[field] += source[field] * inc
   */
  private addNum(target: BonusData, source: BonusData, field: keyof BonusData, inc: number): void {
    (target[field] as number) = this.safeNum(target[field] as number) + this.safeNum(source[field] as number) * inc;
  }

  /**
   * 正加负乘（暴击/暴击伤害/攻击三系）：源值>=0 直接累加，源值<0 按韧性减免后加
   */
  private addWithTenacity(target: BonusData, source: BonusData, field: keyof BonusData, inc: number, a1: number): void {
    const val = this.safeNum(source[field] as number);
    if (val >= 0) {
      (target[field] as number) = this.safeNum(target[field] as number) + val * inc;
    } else {
      (target[field] as number) = this.safeNum(target[field] as number) + val * a1 * inc;
    }
  }

  /**
   * 伤害上限：未设置时默认100，然后取目标值与源值中的较小者
   */
  private applyDmgCap(target: BonusData, field: keyof BonusData, sourceVal: number | undefined): void {
    if (this.safeNum(target[field] as number) === 0) {
      (target[field] as number) = 100;
    }
    const sv = this.safeNum(sourceVal);
    if (sv < this.safeNum(target[field] as number)) {
      (target[field] as number) = sv;
    }
  }

  /**
   * 单抗叠加：按 (100-当前)/100 * 源值 堆叠，负值乘韧性减免
   */
  private addResist(target: BonusData, source: BonusData, field: keyof BonusData, inc: number, a1: number): void {
    const val = this.safeNum(source[field] as number);
    const cur = this.safeNum(target[field] as number);
    if (val >= 0) {
      (target[field] as number) = cur + ((100 - cur) / 100) * val * inc;
    } else {
      (target[field] as number) = cur + ((100 - cur) / 100) * val * a1 * inc;
    }
  }

  /**
   * 全抗叠加：正按堆叠公式存字段，负走增加全抗
   */
  private addAllResistField(target: BonusData, source: BonusData, field: keyof BonusData, inc: number, a1: number): void {
    const val = this.safeNum(source[field] as number);
    if (val >= 0) {
      const cur = this.safeNum(target[field] as number);
      (target[field] as number) = cur + ((100 - cur) / 100) * val * inc;
    } else {
      const resistVal = val * a1 * inc;
      if (field === '生命全抗') this.addAllResistance(target, resistVal, 0, 0);
      else if (field === '护盾全抗') this.addAllResistance(target, 0, resistVal, 0);
      else this.addAllResistance(target, 0, 0, resistVal);
    }
  }

  /**
   * 贯穿/抗贯穿叠加：正加（默认叠加），负按百分比乘
   */
  private addPenetrateChance(
    target: BonusData,
    source: BonusData,
    field: keyof BonusData,
    inc: number,
    a1: number,
    noSplash: boolean,
  ): void {
    const val = this.safeNum(source[field] as number);
    if (val >= 0) {
      if (!noSplash) (target[field] as number) = this.safeNum(target[field] as number) + val * inc;
    } else {
      (target[field] as number) = this.safeNum(target[field] as number) * (1 + (val * a1) / 100) * inc;
    }
  }

  /**
   * 二阶回复叠加：源值>=0 累加，源值<0 按百分比乘到二阶与主回复
   */
  private addRegen2(target: BonusData, source: BonusData, field: keyof BonusData, inc: number, a1: number): void {
    const val = this.safeNum(source[field] as number);
    if (val >= 0) {
      (target[field] as number) = this.safeNum(target[field] as number) + val * inc;
    } else {
      (target[field] as number) = this.safeNum(target[field] as number) * (1 + val / 100) * a1 * inc;
      // 同时按百分比乘到主回复
      const primaryField =
        field === '生命回复2' ? '生命回复' : field === '护盾回复2' ? '护盾回复' : '装甲回复';
      (target[primaryField] as number) = this.safeNum(target[primaryField] as number) * (1 + val / 100) * a1 * inc;
    }
  }

  /**
   * 二阶属性（*2）叠加：装备模式进属性对象；增益模式按百分比乘主属性；否则累加；负值按百分比乘
   */
  private addSecondOrder(
    target: BonusData,
    source: BonusData,
    field: keyof BonusData,
    primaryField: keyof BonusData,
    inc: number,
    isBuff: boolean,
    a1: number,
    isEquipment: boolean,
    attrs: BonusData | undefined,
  ): void {
    const val = this.safeNum(source[field] as number);
    if (isEquipment) {
      // 装备模式：直接累加到属性对象（不乘以增加值）
      if (attrs) (attrs[field] as number) = this.safeNum(attrs[field] as number) + val;
      return;
    }
    if (val >= 0) {
      if (isBuff) {
        (target[primaryField] as number) = this.safeNum(target[primaryField] as number) * (1 + (val * inc) / 100);
      } else {
        (target[field] as number) = this.safeNum(target[field] as number) + val * inc;
      }
    } else {
      (target[primaryField] as number) = this.safeNum(target[primaryField] as number) * (1 + (val * a1) / 100) * inc;
    }
  }

  /**
   * 攻击2特殊叠加：增益时按百分比乘四种伤害；否则累加；负值按百分比乘四种伤害
   */
  private addAttack2(target: BonusData, source: BonusData, field: keyof BonusData, inc: number, isBuff: boolean, a1: number): void {
    const val = this.safeNum(source[field] as number);
    if (val >= 0) {
      if (isBuff) {
        const mult = 1 + val / 100;
        target.电伤 = this.safeNum(target.电伤) * mult;
        target.火伤 = this.safeNum(target.火伤) * mult;
        target.物伤 = this.safeNum(target.物伤) * mult;
        target.冰伤 = this.safeNum(target.冰伤) * mult;
      } else {
        (target[field] as number) = this.safeNum(target[field] as number) + val * inc;
      }
    } else {
      const mult = (1 + (val * a1) / 100) * inc;
      target.电伤 = this.safeNum(target.电伤) * mult;
      target.火伤 = this.safeNum(target.火伤) * mult;
      target.物伤 = this.safeNum(target.物伤) * mult;
      target.冰伤 = this.safeNum(target.冰伤) * mult;
    }
  }

  /**
   * 获得增益
   * 对应原版：获得增益()（加成计算.ecode L1522-L1566）
   * 向增益列表添加/合并一个增益，返回该增益的最终强度。
   * - 已存在同名增益时：根据"是否叠加时间"叠加有效期；根据"是否叠加强度"叠加或取较大强度
   * - 不存在时新增一个增益
   * @param buffs 增益列表（原地修改）
   * @param name 增益名称
   * @param time 持续时间（秒）
   * @param stackTime 是否叠加时间
   * @param now 当前毫秒时间戳（全项目统一口径）
   * @param strength 强度（可空）
   * @param stackStrength 是否叠加强度（可空，默认取较大值）
   * @returns 最终强度
   */
  applyBuff(buffs: BuffData[], name: string, time: number, stackTime: boolean, now: number, strength?: number, stackStrength?: boolean): number {
    // 统一口径：now 与 expireAt 均为毫秒；入参 time 仍按原版语义以「秒」传入，此处换算
    const timeMs = time * SECOND_MS;
    for (let i = 0; i < buffs.length; i++) {
      const b = buffs[i];
      if (b && b.name === name) {
        if (stackTime) {
          // 叠加时间：在原有效期基础上增加（存量秒级有效期先归一化）
          b.expireAt = toExpireMs(b) + timeMs;
          // 增加后仍已过期则删除并返回0
          if (now - this.safeNum(b.expireAt) >= 0) {
            buffs.splice(i, 1);
            return 0;
          }
        } else if (time !== 0) {
          // 不叠加时间：直接覆盖有效期
          b.expireAt = now + timeMs;
        }
        b.stackTime = stackTime;
        // 强度：按是否叠加强度累加，否则取较大值
        if (stackStrength) {
          b.strength = this.safeNum(b.strength) + this.safeNum(strength);
        } else if (this.safeNum(b.strength) < this.safeNum(strength)) {
          b.strength = strength;
        }
        return this.safeNum(b.strength);
      }
    }
    // 不存在同名增益：新增
    buffs.push({
      name,
      expireAt: now + timeMs,
      stackTime,
      strength,
    });
    return this.safeNum(strength);
  }

  /**
   * 统计列表中指定名称物品的数量（数量缺省视为1）
   */
  private countItem(items: any[] | string | undefined, name: string): number {
    let list: any[] = [];
    if (Array.isArray(items)) list = items;
    else if (typeof items === 'string') {
      try {
        const parsed = JSON.parse(items);
        list = Array.isArray(parsed) ? parsed : [];
      } catch {
        list = [];
      }
    }
    return list
      .filter((item) => String(item?.name ?? item?.名称 ?? '') === name)
      .reduce((sum, item) => {
        const raw = item?.quantity ?? item?.数量 ?? item?.count;
        const quantity = raw === undefined || raw === null || raw === '' ? 1 : this.safeNum(raw);
        return sum + quantity;
      }, 0);
  }

  /** 原版“获得物品”的最小地图数组映射，兼容存量中英文数量字段。 */
  private adjustItemQuantity(items: any[] | undefined, name: string, delta: number): void {
    if (!Array.isArray(items) || !delta) return;
    const index = items.findIndex((item) => String(item?.name ?? item?.名称 ?? '') === name);
    if (index < 0) {
      if (delta > 0) items.push({ name, quantity: delta, count: delta, type: '资源' });
      return;
    }

    const item = items[index];
    const next = this.countItem([item], name) + delta;
    if (next <= 0) {
      items.splice(index, 1);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(item, '数量')) item.数量 = next;
    if (Object.prototype.hasOwnProperty.call(item, 'quantity')) item.quantity = next;
    if (Object.prototype.hasOwnProperty.call(item, 'count')) item.count = next;
    if (!('数量' in item) && !('quantity' in item) && !('count' in item)) item.quantity = next;
  }

  private hasEquipment(summon: any, name: string): boolean {
    const raw = summon?.equipment ?? summon?.装备 ?? summon?.equipments ?? summon?.装备列表 ?? [];
    let list: any[];
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        list = Array.isArray(parsed) ? parsed : raw.split(/\s+/);
      } catch {
        list = raw.split(/\s+/);
      }
    } else list = [];
    return list.some((item) => String(item?.name ?? item?.名称 ?? item ?? '') === name);
  }

  /**
   * 获得地图增益
   * 对应原版：获得地图增益()（加成计算.ecode L577-L652）
   * 根据地图上的建筑/召唤物/标记，将有效的标记增益转移到玩家增益列表，并清理过期标记。
   * 说明：神兽蛋孵化涉及召唤物系统，本框架中仅记录日志，由外部召唤系统接管。
   * @param playerBuffs 玩家增益列表（原地修改）
   * @param map 地图上下文（建筑/召唤物/物品/标记3）
   * @param now 当前毫秒时间戳（全项目统一口径）
   * @param originalTime 原始毫秒时间戳（用于地图标记有效期计算）
   */
  getMapBonus(playerBuffs: BuffData[], map: MapBonusContext, now: number, originalTime: number): void {
    const markers3 = map.markers3 || (map.markers3 = []);

    // 1. 花园猫窝建筑：每座提供 50+5*数量 强度的"啾啾猫猫"增益
    const catHouseCount = this.countItem(map.buildings, '花园猫窝');
    if (catHouseCount > 0) {
      this.applyBuff(markers3, '啾啾猫猫', 30, false, originalTime, 50 + 5 * catHouseCount);
    }

    // 2. 召唤物装备"叹息之墙"：提供60秒"叹息之墙"增益
    for (const summon of map.summons || []) {
      if (!summon) continue;
      if (this.hasEquipment(summon, '叹息之墙')) {
        this.applyBuff(markers3, '叹息之墙', 60, false, originalTime);
        break;
      }
    }

    // 3. 倒序遍历地图标记3：过期移除（含孵化处理），未过期转移到玩家增益
    for (let i = markers3.length - 1; i >= 0; i--) {
      const marker = markers3[i];
      if (!marker) continue;
      const markerName = String((marker as any).name ?? (marker as any).名称 ?? '');
      // 地图标记有效期统一按毫秒判定（存量秒级数据由 toExpireMs 归一化）
      const expireAtMs = toExpireMs(marker);
      if (now >= expireAtMs) {
        // 过期：若为"孵化中"且存在孵蛋鸡，原版会孵化神兽蛋（需召唤系统支持）
        if (markerName === '孵化中' && this.countItem(map.items, '孵蛋鸡') >= 1) {
          const eggs: Array<[string, string]> = [
            ['青龙蛋', '青龙'],
            ['白虎蛋', '白虎'],
            ['朱雀蛋', '朱雀'],
            ['玄武蛋', '玄武'],
            ['麒麟蛋', '麒麟'],
            ['心之守望蛋', '心之守望'],
          ];
          const selectedEgg = eggs.find(([eggName]) => this.countItem(map.items, eggName) >= 1);
          if (selectedEgg) {
            const [, summonType] = selectedEgg;
            const ownerQQ = String((marker as any).strength ?? (marker as any).强度 ?? '');
            this.adjustItemQuantity(map.items, '孵蛋鸡', -1);
            this.adjustItemQuantity(map.items, selectedEgg[0], -1);
            this.adjustItemQuantity(map.items, '合金', 10);
            map.onHatch?.({
              type: summonType,
              ownerQQ,
              createdAt: now,
              // 原版：86400*1.5 - (当前时间-有效期至)/#转秒。now/expireAt 已统一为毫秒，故换算回秒
              growthSeconds: 86400 * 1.5 - (now - expireAtMs) / SECOND_MS,
            });
            this.logger.log(`地图增益：孵蛋鸡孵化${summonType}蛋，生成${summonType}幼崽`);
          }
        }
        markers3.splice(i, 1);
      } else {
        // 未过期：将剩余时长转成秒后作为增益加到玩家身上
        this.applyBuff(
          playerBuffs,
          markerName,
          (expireAtMs - now) / SECOND_MS, // 剩余秒数（applyBuff 的 time 参数按秒）
          !!((marker as any).stackTime ?? (marker as any).是否叠加时间),
          now,
          this.safeNum((marker as any).strength ?? (marker as any).强度),
        );
      }
    }
  }

  /**
   * 计算buff（含debuff）
   * 对应原版：计算buff()（加成计算.ecode L3097-L3142）
   * 遍历玩家所有活跃增益，按名称执行特殊效果或叠加增益列表中定义的加成。
   * @param attributes 玩家属性（原地修改）
   * @param buffs 玩家增益列表
   * @param buffDefinitions 增益列表（名称→加成定义）
   * @param now 当前时间戳（秒）
   * @param context 额外上下文（当前麻醉量、特效文本、加成对象等）
   */
  calculateBuffs(
    attributes: BonusData,
    buffs: BuffData[],
    buffDefinitions: BuffData[],
    now: number,
    context?: { currentAnesthesia?: number; effectText?: string[]; bonus?: BonusData },
  ): void {
    const bonus = context && context.bonus ? context.bonus : attributes;
    for (const buff of buffs) {
      if (!buff) continue;
      // 跳过已过期增益（统一按毫秒判定，兼容历史秒级写入）
      if (!isActive(buff, now)) continue;
      const name = buff.name || '';
      const strength = this.safeNum(buff.strength);
      switch (name) {
        case 'mqtx': {
          // “梦倾天下”：下次攻击命中后降低目标所有属性
          if (this.safeNum(attributes.麻醉) > 0) {
            const adjust =
              1 - (this.safeNum(context && context.currentAnesthesia) / this.safeNum(attributes.麻醉)) * (strength / 100);
            this.adjustAllAttributes(attributes, adjust);
          }
          break;
        }
        case '湮灭': {
          // 湮灭：按强度(最高5)百分比削减生命/护盾/装甲
          const a1 = Math.min(strength, 5);
          attributes.生命 = this.safeNum(attributes.生命) * (1 - a1 * 0.05);
          attributes.护盾 = this.safeNum(attributes.护盾) * (1 - a1 * 0.05);
          attributes.装甲 = this.safeNum(attributes.装甲) * (1 - a1 * 0.05);
          if (context && context.effectText) context.effectText.push(`湮灭${a1}`);
          break;
        }
        case '削弱闪避':
          // 削弱闪避：按强度百分比削减闪避
          attributes.闪避 = this.safeNum(attributes.闪避) * (1 - strength / 10);
          break;
        case 'xla': {
          // 向量减抗（护盾系）
          const resist =
            -5 -
            (this.safeNum(attributes.护盾火抗) +
              this.safeNum(attributes.护盾冰抗) +
              this.safeNum(attributes.护盾电抗) +
              this.safeNum(attributes.护盾物抗)) /
              40;
          this.addAllResistance(bonus, 0, resist, 0);
          break;
        }
        case 'xlb': {
          // 向量减抗（装甲系）
          const resist =
            -5 -
            (this.safeNum(attributes.装甲火抗) +
              this.safeNum(attributes.装甲冰抗) +
              this.safeNum(attributes.装甲电抗) +
              this.safeNum(attributes.装甲物抗)) /
              40;
          this.addAllResistance(bonus, 0, 0, resist);
          break;
        }
        case 'xlc': {
          // 向量减抗（生命系，原版作用在加成上）
          const resist =
            -5 -
            (this.safeNum(attributes.生命火抗) +
              this.safeNum(attributes.生命冰抗) +
              this.safeNum(attributes.生命电抗) +
              this.safeNum(attributes.生命物抗)) /
              40;
          this.addAllResistance(bonus, resist, 0, 0);
          break;
        }
        default: {
          // 默认：在增益列表按名称查找，并按其加成进行叠加（增益模式）
          const def = (buffDefinitions || []).find((d) => d && d.name === name);
          if (def && def.bonus) {
            this.mergeBonusTo(bonus, def.bonus, { isBuff: true });
          } else {
            this.logger.warn(`计算buff：未在增益列表中找到"${name}"的定义`);
          }
        }
      }
    }
  }

  /**
   * 最终加成
   * 对应原版：最终加成()（加成计算.ecode L3233-L3333）
   * 将目标(目标加成)与来源(来源加成)合并计算最终属性，处理：
   * - 常规属性直接累加；韧性/抗性按堆叠公式；伤害上限取最小值
   * - 关键公式：最终伤害 = (伤害+攻击+来源攻击) * (1+来源伤害2/100) * (1+来源攻击2/100) * (1+自身攻击2/100)
   * - 速度/命中/闪避/护盾/装甲/生命按二阶百分比放大
   * @param target 目标加成（原地修改，为最终结果）
   * @param source 来源加成
   * @param debug 是否输出调试日志
   */
  calculateFinalBonus(target: BonusData, source: BonusData, debug = false): void {
    const safe = this.safeNum;
    target.魅力 = safe(target.魅力) + safe(source.魅力);
    target.生命 = safe(target.生命) + safe(source.生命);
    target.护盾 = safe(target.护盾) + safe(source.护盾);
    target.装甲 = safe(target.装甲) + safe(source.装甲);
    target.闪避 = safe(target.闪避) + safe(source.闪避);
    target.命中 = safe(target.命中) + safe(source.命中);
    target.速度 = safe(target.速度) + safe(source.速度);
    target.卷土重来 = safe(target.卷土重来) + safe(source.卷土重来);
    target.生命回复 = safe(target.生命回复) + safe(source.生命回复);
    target.护盾回复 = safe(target.护盾回复) + safe(source.护盾回复);
    target.装甲回复 = safe(target.装甲回复) + safe(source.装甲回复);
    target.掉落率 = safe(target.掉落率) + safe(source.掉落率);
    target.掉落品质 = safe(target.掉落品质) + safe(source.掉落品质);
    // 韧性：按 (1-当前韧性/100)*来源 堆叠
    target.韧性 = safe(target.韧性) + (1 - safe(target.韧性) / 100) * safe(source.韧性);
    target.减益 = safe(target.减益) + safe(source.减益);
    if (source.全体攻击) target.全体攻击 = true;
    target.治疗效果 = safe(target.治疗效果) + safe(source.治疗效果);
    target.暴击 = safe(target.暴击) + safe(source.暴击);
    target.暴击伤害 = safe(target.暴击伤害) + safe(source.暴击伤害);
    // 伤害上限：取最小值
    this.applyDmgCap(target, '生命伤害上限', source.生命伤害上限);
    this.applyDmgCap(target, '护盾伤害上限', source.护盾伤害上限);
    this.applyDmgCap(target, '装甲伤害上限', source.装甲伤害上限);
    // 各部位单抗堆叠
    this.stackResist(target, source, '生命火抗');
    this.stackResist(target, source, '生命冰抗');
    this.stackResist(target, source, '生命物抗');
    this.stackResist(target, source, '生命电抗');
    this.stackResist(target, source, '护盾火抗');
    this.stackResist(target, source, '护盾冰抗');
    this.stackResist(target, source, '护盾物抗');
    this.stackResist(target, source, '护盾电抗');
    this.stackResist(target, source, '装甲火抗');
    this.stackResist(target, source, '装甲冰抗');
    this.stackResist(target, source, '装甲物抗');
    this.stackResist(target, source, '装甲电抗');
    // 全抗堆叠
    this.stackResist(target, source, '生命全抗');
    this.stackResist(target, source, '护盾全抗');
    this.stackResist(target, source, '装甲全抗');
    // 攻击三系直接累加
    target.攻击护盾 = safe(target.攻击护盾) + safe(source.攻击护盾);
    target.攻击装甲 = safe(target.攻击装甲) + safe(source.攻击装甲);
    target.攻击生命 = safe(target.攻击生命) + safe(source.攻击生命);
    // 元素伤害累加
    target.电伤 = safe(target.电伤) + safe(source.电伤);
    target.火伤 = safe(target.火伤) + safe(source.火伤);
    target.物伤 = safe(target.物伤) + safe(source.物伤);
    target.冰伤 = safe(target.冰伤) + safe(source.冰伤);
    target.采集 = safe(target.采集) + safe(source.采集);
    target.吸生命 = safe(target.吸生命) + safe(source.吸生命);
    target.吸装甲 = safe(target.吸装甲) + safe(source.吸装甲);
    target.吸护盾 = safe(target.吸护盾) + safe(source.吸护盾);
    target.吸生命2 = safe(target.吸生命2) + safe(source.吸生命2);
    target.吸装甲2 = safe(target.吸装甲2) + safe(source.吸装甲2);
    target.吸护盾2 = safe(target.吸护盾2) + safe(source.吸护盾2);
    target.经验 = safe(target.经验) + safe(source.经验);
    target.升级经验 = safe(target.升级经验) + safe(source.升级经验);
    target.溅射 = safe(target.溅射) + safe(source.溅射);
    target.溅射数量 = safe(target.溅射数量) + safe(source.溅射数量);
    target.生命穿透 = safe(target.生命穿透) + safe(source.生命穿透);
    target.装甲穿透 = safe(target.装甲穿透) + safe(source.装甲穿透);
    target.护盾穿透 = safe(target.护盾穿透) + safe(source.护盾穿透);
    target.贯穿 = safe(target.贯穿) + safe(source.贯穿);
    target.抗贯穿 = safe(target.抗贯穿) + safe(source.抗贯穿);
    target.麻醉 = safe(target.麻醉) + safe(source.麻醉);
    target.生命回复2 = safe(target.生命回复2) + safe(source.生命回复2);
    target.护盾回复2 = safe(target.护盾回复2) + safe(source.护盾回复2);
    target.装甲回复2 = safe(target.装甲回复2) + safe(source.装甲回复2);

    // 关键公式：四种元素伤害 = (累加伤害 + 自身攻击 + 来源攻击) * 各百分比放大
    const atk = safe(target.攻击) + safe(source.攻击);
    target.电伤 =
      (safe(target.电伤) + atk) *
      (1 + safe(source.电伤2) / 100) *
      (1 + safe(source.攻击2) / 100) *
      (1 + safe(target.攻击2) / 100);
    target.火伤 =
      (safe(target.火伤) + atk) *
      (1 + safe(source.火伤2) / 100) *
      (1 + safe(source.攻击2) / 100) *
      (1 + safe(target.攻击2) / 100);
    target.冰伤 =
      (safe(target.冰伤) + atk) *
      (1 + safe(source.冰伤2) / 100) *
      (1 + safe(source.攻击2) / 100) *
      (1 + safe(target.攻击2) / 100);
    target.物伤 =
      (safe(target.物伤) + atk) *
      (1 + safe(source.物伤2) / 100) *
      (1 + safe(source.攻击2) / 100) *
      (1 + safe(target.攻击2) / 100);

    // 速度/命中/闪避/护盾/装甲/生命：按二阶百分比放大
    target.速度 = safe(target.速度) * (1 + safe(source.速度2) / 100) * (1 + safe(target.速度2) / 100);
    target.命中 = safe(target.命中) * (1 + safe(source.命中2) / 100) * (1 + safe(target.命中2) / 100);
    target.闪避 = safe(target.闪避) * (1 + safe(source.闪避2) / 100) * (1 + safe(target.闪避2) / 100);
    target.护盾 = safe(target.护盾) * (1 + safe(source.护盾2) / 100) * (1 + safe(target.护盾2) / 100);
    target.装甲 = safe(target.装甲) * (1 + safe(source.装甲2) / 100) * (1 + safe(target.装甲2) / 100);
    target.生命 = safe(target.生命) * (1 + safe(source.生命2) / 100) * (1 + safe(target.生命2) / 100);

    // 分发全抗到各部位
    this.addAllResistance(target, safe(target.生命全抗), safe(target.护盾全抗), safe(target.装甲全抗));

    // 攻击次数累加
    target.攻击次数 = safe(target.攻击次数) + safe(source.攻击次数);

    if (debug) {
      this.logger.log(`最终加成：生命=${target.生命} 护盾=${target.护盾} 装甲=${target.装甲} 电伤=${target.电伤}`);
    }
  }

  /**
   * 单抗/全抗堆叠（最终加成专用）：按 (100-当前)/100 * 源值 累加
   */
  private stackResist(target: BonusData, source: BonusData, field: keyof BonusData): void {
    const cur = this.safeNum(target[field] as number);
    (target[field] as number) = cur + ((100 - cur) / 100) * this.safeNum(source[field] as number);
  }

  /**
   * 获取标记中的熟练度等级
   */
  private getProficiency(markers: any, name: string): number {
    if (!markers) return 0;
    return this.safeNum(markers[name]);
  }

  /**
   * 时间间隔检查：指定名称的冷却标记未到期则返回false（在冷却中）
   */
  private timeIntervalOk(markers2: any[] | undefined, name: string, cooldownSeconds: number, now: number): boolean {
    if (!markers2) return true;
    const marker = markers2.find((m) => m && m.name === name);
    if (!marker) return true;
    // now 为毫秒；标记有效期归一化后比较（兼容存量秒级）
    return toExpireMs(marker) <= now;
  }

  /**
   * 获取当前武器名称
   * 非数字QQ（怪物/宠物）使用当前武器索引；数字QQ（玩家）使用第一把武器
   */
  private findCurrentWeaponName(player: { qq?: string; weapons?: Array<{ name?: string; 名称?: string; baseBonus?: any; 基础加成?: any; self?: any; 自带?: any }>; currentWeapon?: number }): string {
    const qq = String(player.qq || '');
    const weapons = player.weapons || [];
    if (/^\d+$/.test(qq)) {
      const w = weapons[0];
      return w ? (w.name ?? w.名称 ?? '') : '';
    }
      // 原版当前武器是 1-based 序号。
      const idx = Math.max(0, this.safeNum(player.currentWeapon) - 1);
      const w = weapons[idx];
      return w ? (w.name ?? w.名称 ?? '') : '';
  }

  /**
   * 套装判断
   * 对应原版：套装判断2()（加成计算.ecode L3381-L3444）
   * 根据玩家套装激活状态与当前战况计算特殊加成：
   * - 黑花嫁4件：死亡复活（90秒冷却）+ 残血增伤/闪避
   * - 白花嫁4件：韧性提升 + 满血增伤/命中
   * - 暴击熟练度转暴击伤害
   * - 特定武器等级加成（高斯步枪/追风者/琴弦/三叉戟/高斯狙击枪/奥丁/勒克斯之矛）
   * @param player 玩家上下文（属性/加成/套装/武器等，原地修改）
   * @param now 当前毫秒时间戳（全项目统一口径）
   */
  checkSetBonus(
    player: {
      currentHp?: number;
      currentShield?: number;
      currentArmor?: number;
      bonus?: BonusData;
      attributes?: BonusData;
      weapons?: Array<{ name?: string; 名称?: string; baseBonus?: any; 基础加成?: any; self?: any; 自带?: any }>;
      currentWeapon?: number;
      level?: number;
      qq?: string;
      markers?: any;
      markers2?: any[];
      sets?: SetData;
    },
    now: number,
  ): void {
    const attrs = player.attributes || (player.attributes = {});
    const bonus = player.bonus || (player.bonus = {});
    const sets = player.sets || {};
    const currentHp = this.safeNum(player.currentHp);
    const currentShield = this.safeNum(player.currentShield);
    const currentArmor = this.safeNum(player.currentArmor);
    const totalBonus = this.safeNum(bonus.生命) + this.safeNum(bonus.装甲) + this.safeNum(bonus.护盾);
    const totalCurrent = currentHp + currentShield + currentArmor;
    const ratio = totalBonus > 0 ? totalCurrent / totalBonus : 1;

    // 黑花嫁4件套
    if (sets.blackWedding === 4) {
      if (currentHp <= 0) {
        // 死亡时触发复活（90秒冷却，原版：时间间隔要求）
        if (this.timeIntervalOk(player.markers2, '黑花嫁复活', 90, now)) {
          player.currentHp = 1;
          this.logger.log(`套装判断：黑花嫁触发死亡复活`);
        }
      }
      // 残血状态：损失比例越高增伤/闪避越高
      attrs.攻击2 = this.safeNum(attrs.攻击2) + 15 * (1 - ratio);
      attrs.闪避2 = this.safeNum(attrs.闪避2) + 25 * (1 - ratio);
    } else if (sets.whiteWedding === 4) {
      // 白花嫁4件套：韧性提升 + 满血比例增伤/命中
      bonus.韧性 = this.safeNum(bonus.韧性) + (1 - this.safeNum(bonus.韧性) / 100) * 50;
      attrs.攻击2 = this.safeNum(attrs.攻击2) + 15 * ratio;
      attrs.命中2 = this.safeNum(attrs.命中2) + 25 * ratio;
    }

    // 暴击熟练度 → 暴击伤害
    bonus.暴击伤害 = this.safeNum(bonus.暴击伤害) + this.getProficiency(player.markers, '暴击');

    // 当前武器特有效果
    const weaponName = this.findCurrentWeaponName(player);
    if (weaponName) {
      const level = this.safeNum(player.level);
      const weaponIndex = Math.max(0, this.safeNum(player.currentWeapon) - 1);
      const weapon = (player.weapons || [])[weaponIndex] || {};
      const weaponSelf = weapon.self ?? weapon.自带 ?? weapon.baseBonus ?? weapon.基础加成 ?? {};
      const selfField = (field: '物伤' | '电伤' | '火伤' | '冰伤') => {
        const key = field === '电伤' ? '电伤'
          : field === '火伤' ? '火伤'
            : field === '冰伤' ? '冰伤' : '物伤';
        return this.safeNum(weaponSelf[key]);
      };
      switch (weaponName) {
        case '高斯步枪':
          attrs.物伤 = this.safeNum(attrs.物伤) + level * 2;
          weaponSelf.物伤 = selfField('物伤') + level * 2;
          break;
        case '追风者':
          attrs.电伤 = this.safeNum(attrs.电伤) + level * 2;
          weaponSelf.电伤 = selfField('电伤') + level * 2;
          break;
        case '琴弦':
          attrs.火伤 = this.safeNum(attrs.火伤) + level * 2;
          weaponSelf.火伤 = selfField('火伤') + level * 2;
          break;
        case '三叉戟':
          attrs.冰伤 = this.safeNum(attrs.冰伤) + level * 2;
          weaponSelf.冰伤 = selfField('冰伤') + level * 2;
          break;
        case '高斯狙击枪':
          attrs.物伤2 = this.safeNum(attrs.物伤2) + ratio * 25;
          break;
        case '奥丁':
          attrs.命中2 = this.safeNum(attrs.命中2) + this.safeNum(bonus.物伤) * 0.05;
          break;
        case '勒克斯之矛':
          attrs.攻击2 = this.safeNum(attrs.攻击2) + ratio * 25;
          break;
        default:
          break;
      }
    }
  }

  /**
   * 法宝加成
   * 对应原版：法宝加成()（加成计算.ecode L3143-L3232）
   * 法宝类型来自套装.小樱命中次数，等级来自套装.陪睡。
   */
  calculateTreasureBonus(attributes: BonusData, sets: SetData): void {
    const treasureType = this.safeNum(sets.sakuraHits);
    const level = this.safeNum(sets.sleepover);

    switch (treasureType) {
      case 1: { // 飞天独龙神女枪
        if (level > 0) attributes.电伤2 = this.safeNum(attributes.电伤2) + 5;
        if (level > 1) {
          attributes.护盾2 = this.safeNum(attributes.护盾2) + 10;
          attributes.生命2 = this.safeNum(attributes.生命2) + 10;
          attributes.装甲2 = this.safeNum(attributes.装甲2) + 10;
        }
        if (level > 5) attributes.电伤2 = this.safeNum(attributes.电伤2) + 8;
        if (level > 8) attributes.暴击伤害 = this.safeNum(attributes.暴击伤害) + 1000;
        break;
      }
      case 2: { // 镇岳
        if (level > 0) attributes.物伤2 = this.safeNum(attributes.物伤2) + 5;
        if (level > 4) {
          attributes.护盾2 = this.safeNum(attributes.护盾2) + 15;
          attributes.生命2 = this.safeNum(attributes.生命2) + 15;
          attributes.装甲2 = this.safeNum(attributes.装甲2) + 15;
        }
        if (level > 5) {
          attributes.贯穿 = this.safeNum(attributes.贯穿) + 15;
          attributes.抗贯穿 = this.safeNum(attributes.抗贯穿) + 10;
        }
        if (level > 8) attributes.物伤2 = this.safeNum(attributes.物伤2) + 15;
        break;
      }
      case 4: { // 惊鲵
        if (level > 0) attributes.火伤2 = this.safeNum(attributes.火伤2) + 3;
        if (level > 1) attributes.火伤2 = this.safeNum(attributes.火伤2) + 5;
        if (level > 7) {
          attributes.溅射2 = this.safeNum(attributes.溅射2) + 1;
          attributes.溅射 = this.safeNum(attributes.溅射) + 50;
        }
        if (level > 8) {
          attributes.火伤2 = this.safeNum(attributes.火伤2) + 10;
          attributes.暴击伤害 = this.safeNum(attributes.暴击伤害) + 200;
        }
        if (level > 9) {
          attributes.贯穿 = this.safeNum(attributes.贯穿) + 10;
          attributes.暴击伤害 = this.safeNum(attributes.暴击伤害) + 400;
        }
        break;
      }
      case 3: { // 凌虚
        if (level > 0) attributes.冰伤2 = this.safeNum(attributes.冰伤2) + 5;
        if (level > 1) attributes.抗贯穿 = this.safeNum(attributes.抗贯穿) + 10;
        if (level > 3) {
          attributes.攻击护盾 = this.safeNum(attributes.攻击护盾) + 20;
          attributes.攻击装甲 = this.safeNum(attributes.攻击装甲) + 20;
        }
        if (level > 5) {
          attributes.护盾2 = this.safeNum(attributes.护盾2) + 20;
          attributes.生命2 = this.safeNum(attributes.生命2) + 20;
          attributes.装甲2 = this.safeNum(attributes.装甲2) + 20;
        }
        if (level > 6) {
          attributes.抗贯穿 = this.safeNum(attributes.抗贯穿) + 15;
          attributes.韧性 =
            this.safeNum(attributes.韧性) +
            (1 - this.safeNum(attributes.韧性) / 100) * 20;
        }
        if (level > 8) {
          attributes.冰伤2 = this.safeNum(attributes.冰伤2) + 10;
          attributes.暴击伤害 = this.safeNum(attributes.暴击伤害) + 500;
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * 法宝加成2
   * 对应原版：法宝加成2()（加成计算.ecode L3053-L3096）
   * 法宝[含光]按最高防御层放大对应池，并追加全抗/回复/抗贯穿。
   */
  calculateHanGuangBonus(attributes: BonusData, sets: SetData): void {
    if (this.safeNum(sets.sakuraHits) !== 5) return;

    const level = this.safeNum(sets.sleepover);
    const shield = this.safeNum(attributes.护盾);
    const armor = this.safeNum(attributes.装甲);
    const life = this.safeNum(attributes.生命);
    const defenseType = shield > armor
      ? (shield > life ? 1 : 3)
      : (armor > life ? 2 : 3);
    let increaseValue = 1;
    if (level > 1) increaseValue += 1.5;
    if (level > 5) increaseValue += 2.5;
    if (level > 3) attributes.抗贯穿 = this.safeNum(attributes.抗贯穿) + 30;

    if (defenseType === 1) {
      if (level > 0) this.addAllResistancePublic(attributes, 0, 50, 0);
      if (level > 2) attributes.护盾回复2 = this.safeNum(attributes.护盾回复2) + 2;
      attributes.护盾 = this.safeNum(attributes.护盾) * increaseValue;
    } else if (defenseType === 2) {
      if (level > 0) this.addAllResistancePublic(attributes, 0, 0, 50);
      if (level > 2) attributes.装甲回复2 = this.safeNum(attributes.装甲回复2) + 2;
      attributes.装甲 = this.safeNum(attributes.装甲) * increaseValue;
    } else {
      if (level > 0) this.addAllResistancePublic(attributes, 50, 0, 0);
      if (level > 2) attributes.生命回复2 = this.safeNum(attributes.生命回复2) + 2;
      attributes.生命 = this.safeNum(attributes.生命) * increaseValue;
    }
  }

  /**
   * 反转童话 消费端（使魔技能.ecode L2631-2745 反转童话(g,s)，由 _初始化怪物尾段 L2879 调用）
   * 遍历防御方增益中的 fzth1~fzth10，把对应正值属性翻负：
   *   fzth1 护盾四抗 / fzth2 装甲四抗 / fzth3 生命四抗 / fzth4 闪避 / fzth5 装甲 /
   *   fzth6 护盾 / fzth7 三回复+三回复2 / fzth8 暴击+暴击伤害 / fzth9 命中 / fzth10 四伤。
   * @param bonus 防御方加成对象（就地修改）
   * @param buffs 防御方增益数组（fzthN 名称匹配）
   */
  consumeReverseFairytaleBuffs(bonus: Record<string, any>, buffs?: any[]): void {
    if (!buffs || buffs.length === 0) return;
    const flipIfPositive = (key: string) => {
      const v = Number(bonus[key]) || 0;
      if (v > 0) bonus[key] = -v;
    };
    for (const b of buffs) {
      if (!b) continue;
      const name = String(b.name ?? b.名称 ?? '');
      switch (name) {
        case 'fzth1':
          flipIfPositive('护盾电抗'); flipIfPositive('护盾火抗'); flipIfPositive('护盾冰抗'); flipIfPositive('护盾物抗');
          break;
        case 'fzth2':
          flipIfPositive('装甲电抗'); flipIfPositive('装甲火抗'); flipIfPositive('装甲冰抗'); flipIfPositive('装甲物抗');
          break;
        case 'fzth3':
          flipIfPositive('生命电抗'); flipIfPositive('生命火抗'); flipIfPositive('生命冰抗'); flipIfPositive('生命物抗');
          break;
        case 'fzth4': flipIfPositive('闪避'); break;
        case 'fzth5': flipIfPositive('装甲'); break;
        case 'fzth6': flipIfPositive('护盾'); break;
        case 'fzth7':
          flipIfPositive('护盾回复'); flipIfPositive('装甲回复'); flipIfPositive('生命回复');
          flipIfPositive('护盾回复2'); flipIfPositive('装甲回复2'); flipIfPositive('生命回复2');
          break;
        case 'fzth8': flipIfPositive('暴击'); flipIfPositive('暴击伤害'); break;
        case 'fzth9': flipIfPositive('命中'); break;
        case 'fzth10': flipIfPositive('电伤'); flipIfPositive('火伤'); flipIfPositive('冰伤'); flipIfPositive('物伤'); break;
        default:
          break;
      }
    }
  }

  /**
   * 计算增益
   * 对应原版：计算增益()（加成计算.ecode L81-L430）
   * 处理成就铠甲、活跃特殊增益和装备追加；攻击型转轮/sa依赖攻击目标，
   * 由战斗链路单独处理，不在此处实现。
   */
  calculateGameBonus(
    context: {
      bonus: BonusData;
      attributes?: BonusData;
      markers?: Record<string, number>;
      buffs?: any[];
      equipment?: any[];
      weapons?: any[];
      currentWeapon?: number;
      level?: number;
      skillLevel?: number;
      affinity?: number;
      sets?: SetData;
      currentHp?: number;
    },
    nowMs: number,
  ): void {
    const bonus = context.bonus;
    const attrs = context.attributes || bonus;
    const markers = context.markers || {};
    const buffs = context.buffs || [];
    const equips = (context.equipment || []).map((item) => this.normalizeEquip(item));
    const weapons = (context.weapons || []).map((item) => this.normalizeWeapon(item));
    const currentWeapon = this.safeNum(context.currentWeapon);
    const level = this.safeNum(context.level);
    const skillLevel = this.safeNum(context.skillLevel);
    const affinity = this.safeNum(context.affinity);
    const sets = context.sets || {};

    const hasBuff = (name: string): number | undefined => {
      const item = buffs.find((buff) => String(buff?.name ?? buff?.名称 ?? '') === name);
      if (!item) return undefined;
      // 统一毫秒判定（存量秒级有效期由 toExpireMs 归一化）
      if (!isActive(item, nowMs)) return undefined;
      return this.safeNum(item.strength ?? item.value ?? item.强度);
    };
    const hasEquipBySeq = (seq: number): boolean =>
      equips.some((item) => this.safeNum(item.specialSeq ?? item.特殊序号) === seq)
      || (currentWeapon > 0 && this.safeNum(weapons[currentWeapon - 1]?.specialSeq ?? weapons[currentWeapon - 1]?.特殊序号) === seq);
    const hasEquipByName = (name: string): boolean =>
      equips.some((item) => String(item.name ?? item.名称 ?? '') === name)
      || (currentWeapon > 0 && String(weapons[currentWeapon - 1]?.name ?? weapons[currentWeapon - 1]?.名称 ?? '') === name);
    const hasEquipOnlyBySeq = (seq: number): boolean =>
      equips.some((item) => this.safeNum(item.specialSeq ?? item.特殊序号) === seq);
    const addAllResist = (life = 0, shield = 0, armor = 0) => {
      this.addAllResistancePublic(bonus, life, shield, armor);
    };
    const addPenetration = (value: number) => {
      bonus.生命穿透 = this.safeNum(bonus.生命穿透) + value;
      bonus.装甲穿透 = this.safeNum(bonus.装甲穿透) + value;
      bonus.护盾穿透 = this.safeNum(bonus.护盾穿透) + value;
    };
    const addAttack = (attack2Percent: number) => {
      if (!attack2Percent) return;
      const atkBonus = this.safeNum(bonus.攻击) + this.safeNum(bonus.攻击加成);
      const factor = attack2Percent / 100;
      bonus.电伤 = this.safeNum(bonus.电伤) + (atkBonus + this.safeNum(bonus.电伤) + this.safeNum(bonus.电伤2)) * (1 + this.safeNum(bonus.电伤2) / 100)
        * (1 + this.safeNum(bonus.攻击2) / 100) * factor;
      bonus.物伤 = this.safeNum(bonus.物伤) + (atkBonus + this.safeNum(bonus.物伤) + this.safeNum(bonus.物伤2)) * (1 + this.safeNum(bonus.物伤2) / 100)
        * (1 + this.safeNum(bonus.攻击2) / 100) * factor;
      bonus.冰伤 = this.safeNum(bonus.冰伤) + (atkBonus + this.safeNum(bonus.冰伤) + this.safeNum(bonus.冰伤2)) * (1 + this.safeNum(bonus.冰伤2) / 100)
        * (1 + this.safeNum(bonus.攻击2) / 100) * factor;
      bonus.火伤 = this.safeNum(bonus.火伤) + (atkBonus + this.safeNum(bonus.火伤) + this.safeNum(bonus.火伤2)) * (1 + this.safeNum(bonus.火伤2) / 100)
        * (1 + this.safeNum(bonus.攻击2) / 100) * factor;
    };

    // L92-L128：成就铠甲。
    const armorType = this.safeNum(markers['铠甲']);
    if (armorType === 1) {
      bonus.攻击2 = this.safeNum(bonus.攻击2) + 10;
      addPenetration(6);
    } else if (armorType === 2) {
      bonus.护盾2 = this.safeNum(bonus.护盾2) + 12;
      bonus.生命2 = this.safeNum(bonus.生命2) + 12;
      bonus.装甲2 = this.safeNum(bonus.装甲2) + 12;
      addAllResist(15, 15, 15);
    } else if (armorType === 3 && currentWeapon > 0) {
      const weapon = weapons[currentWeapon - 1];
      weapon.cooldown = weapon.冷却 = this.safeNum(weapon.cooldown ?? weapon.冷却) * 0.85;
      bonus.贯穿 = this.safeNum(bonus.贯穿) + 5;
      bonus.暴击伤害 = this.safeNum(bonus.暴击伤害) + 33;
    } else if (armorType === 4) {
      bonus.物伤 = this.safeNum(bonus.物伤) * 1.15;
      if (currentWeapon > 0) {
        const weapon = weapons[currentWeapon - 1];
        weapon.cooldown = weapon.冷却 = this.safeNum(weapon.cooldown ?? weapon.冷却) * 1.2;
      }
      bonus.攻击生命 = this.safeNum(bonus.攻击生命) + 20;
    } else if (armorType === 5) {
      // markers.xa 是「触发时刻」型冷却标记（距上次触发的间隔上限 120 秒），统一毫秒
      const previous = toExpireMs({ expireAt: markers.xa }) || nowMs;
      const capped = nowMs - previous > 120 * SECOND_MS ? nowMs - 120 * SECOND_MS : Math.max(previous, nowMs);
      markers.xa = capped;
    }

    // L130-L138：xyhd2。
    const xyhdStrength = hasBuff('xyhd2');
    if (xyhdStrength !== undefined) {
      addAttack(Math.min(xyhdStrength, 5) * 10);
      bonus.贯穿 = this.safeNum(bonus.贯穿) + Math.min(xyhdStrength, 5) * 3;
      addPenetration(10);
    }

    // L140-L143：麻痹降低三层电抗。
    const paralyzed = buffs.some((buff) => String(buff?.name ?? buff?.名称 ?? '') === '麻痹'
      && isActive(buff, nowMs));
    if (paralyzed) {
      bonus.护盾电抗 = this.safeNum(bonus.护盾电抗) * 0.9;
      bonus.装甲电抗 = this.safeNum(bonus.装甲电抗) * 0.9;
      bonus.生命电抗 = this.safeNum(bonus.生命电抗) * 0.9;
    }

    // L145-L162：天神降、奶酪、蛋糕与冰系增益。
    if (hasBuff('降') !== undefined) {
      addAllResist(-10, -10, -10);
      (bonus as any).特效文本 = [...((bonus as any).特效文本 || []), '天神'];
    }
    if (hasBuff('降2') !== undefined) addAllResist(-10, -10, -10);
    if (hasBuff('奶酪') !== undefined) bonus.经验 = this.safeNum(bonus.经验) + 100;
    if (hasBuff('蛋糕') !== undefined) bonus.掉落率 = this.safeNum(bonus.掉落率) + 50;
    if (hasBuff('冰精灵') !== undefined) {
      bonus.冰伤2 = this.safeNum(bonus.冰伤2) + 30 + skillLevel;
      addPenetration(10);
      (bonus as any).特效文本 = [...((bonus as any).特效文本 || []), '冰精灵'];
    }
    if (hasBuff('冰凯') !== undefined) {
      bonus.冰伤 = this.safeNum(bonus.冰伤) + 50 + skillLevel;
      (bonus as any).特效文本 = [...((bonus as any).特效文本 || []), `冰凯${25 + skillLevel}%`];
    }

    // L167-L201：火系、猫猫、银龙。
    if (hasBuff('火精灵') !== undefined) {
      bonus.攻击2 = this.safeNum(bonus.攻击2) + 30 + skillLevel;
      (bonus as any).特效文本 = [...((bonus as any).特效文本 || []), '火精灵'];
    }
    if (hasBuff('燃烧') !== undefined) addAllResist(-this.safeNum(hasBuff('燃烧')), -this.safeNum(hasBuff('燃烧')), -this.safeNum(hasBuff('燃烧')));
    if (hasBuff('猫猫加油') !== undefined) {
      bonus.生命回复2 = this.safeNum(bonus.生命回复2) + 0.3;
      bonus.护盾回复2 = this.safeNum(bonus.护盾回复2) + 0.3;
      bonus.装甲回复2 = this.safeNum(bonus.装甲回复2) + 0.3;
    }
    const catCrit = hasBuff('猫猫暴击');
    if (catCrit !== undefined) {
      bonus.暴击 = this.safeNum(bonus.暴击) + 5 + catCrit / 2;
      bonus.暴击伤害 = this.safeNum(bonus.暴击伤害) + 25 + 2 * catCrit;
      (bonus as any).特效文本 = [...((bonus as any).特效文本 || []), `暴击+${catCrit}`];
    }
    const catBuff = hasBuff('啾啾猫猫');
    if (catBuff !== undefined) {
      bonus.护盾回复 = this.safeNum(bonus.护盾回复) * (1 + catBuff / 100);
      bonus.护盾回复2 = this.safeNum(bonus.护盾回复2) * (1 + catBuff / 100);
      bonus.装甲回复 = this.safeNum(bonus.装甲回复) * (1 + catBuff / 100);
      bonus.装甲回复2 = this.safeNum(bonus.装甲回复2) * (1 + catBuff / 100);
      bonus.生命回复 = this.safeNum(bonus.生命回复) * (1 + catBuff / 100);
      bonus.生命回复2 = this.safeNum(bonus.生命回复2) * (1 + catBuff / 100);
      bonus.攻击2 = this.safeNum(bonus.攻击2) + 40;
      (bonus as any).额外文本 = [...((bonus as any).额外文本 || []), '啾啾猫猫'];
    }
    const silverDragon = hasBuff('银龙附体');
    if (silverDragon !== undefined) {
      addPenetration(5);
      bonus.吸护盾2 = this.safeNum(bonus.吸护盾2) + 5;
      bonus.吸装甲2 = this.safeNum(bonus.吸装甲2) + 5;
      bonus.吸生命2 = this.safeNum(bonus.吸生命2) + 5;
      bonus.攻击2 = this.safeNum(bonus.攻击2) + silverDragon * 2 + 30;
      (bonus as any).额外文本 = [...((bonus as any).额外文本 || []), '银龙附体'];
    }

    // L202-L223：魔力类与封印解除。
    const kulo = hasBuff('库洛魔力');
    if (kulo !== undefined) {
      const strength = Math.min(kulo, 5 + skillLevel * 0.1);
      bonus.命中2 = this.safeNum(bonus.命中2) + strength * 10;
      bonus.暴击 = this.safeNum(bonus.暴击) + strength * 5;
      bonus.暴击伤害 = this.safeNum(bonus.暴击伤害) + strength * 10;
    }
    const sakuraMagic = hasBuff('小樱魔力');
    if (sakuraMagic !== undefined) {
      const strength = Math.min(sakuraMagic, 5 + skillLevel * 0.1);
      bonus.攻击2 = this.safeNum(bonus.攻击2) + strength * 10;
      (bonus as any).特效文本 = [...((bonus as any).特效文本 || []), `小樱魔力${strength}`];
    }
    if (hasBuff('封印解除') !== undefined) {
      bonus.护盾穿透 = this.safeNum(bonus.护盾穿透) + 20;
      bonus.生命穿透 = this.safeNum(bonus.生命穿透) + 20;
      bonus.装甲穿透 = this.safeNum(bonus.装甲穿透) + 20;
    }

    // L224-L236：命中/闪避/幸福。
    const hitX = hasBuff('鼓舞x');
    if (hitX !== undefined) bonus.命中 = this.safeNum(bonus.命中) + hitX;
    const dodgeX = hasBuff('闪避x');
    if (dodgeX !== undefined) bonus.闪避 = this.safeNum(bonus.闪避) + dodgeX;
    if (hasBuff('幸福') !== undefined) {
      bonus.吸护盾2 = this.safeNum(bonus.吸护盾2) + 2;
      bonus.吸装甲2 = this.safeNum(bonus.吸装甲2) + 2;
      bonus.吸生命2 = this.safeNum(bonus.吸生命2) + 2;
    }

    // L237-L255：叹息之墙、回充、修理、速度/装甲模式。
    if (hasBuff('叹息之墙') !== undefined && !hasEquipBySeq(12)) {
      bonus.护盾2 = this.safeNum(bonus.护盾2) + 20;
    }
    if (hasBuff('回充') !== undefined) bonus.护盾回复 = this.safeNum(bonus.护盾回复) + level;
    if (hasBuff('修理') !== undefined) bonus.装甲回复 = this.safeNum(bonus.装甲回复) + level;
    if (hasBuff('速度模式') !== undefined) {
      bonus.速度2 = this.safeNum(bonus.速度2) + 50;
      bonus.闪避2 = this.safeNum(bonus.闪避2) + 25;
    }
    if (hasBuff('装甲模式') !== undefined) addAllResist(0, 0, 50);

    // L256-L299：龙姬、长萌、灼烂歼鬼、五番、歼灭模式。
    const dragonDodge = hasBuff('龙姬闪避');
    if (dragonDodge !== undefined) {
      const stack = Math.min(dragonDodge, 5);
      bonus.暴击 = this.safeNum(bonus.暴击) + stack * (5 + skillLevel / 2);
    }
    if (hasBuff('长萌技能') !== undefined) {
      bonus.暴击 = this.safeNum(bonus.暴击) + 5 + skillLevel / 2;
      bonus.护盾穿透 = this.safeNum(bonus.护盾穿透) + 15;
      bonus.装甲穿透 = this.safeNum(bonus.装甲穿透) + 15;
    }
    const changmengBear = hasBuff('长萌承受');
    if (changmengBear !== undefined) {
      const stack = Math.min(changmengBear, 10);
      bonus.装甲回复 = this.safeNum(bonus.装甲回复) * (1 + stack / 40);
      bonus.护盾回复 = this.safeNum(bonus.护盾回复) * (1 + stack / 40);
      addAllResist(0, stack * 2.5, stack * 2.5);
    }
    if (hasBuff('灼烂歼鬼') !== undefined) {
      addPenetration(10 + skillLevel / 2);
      if (currentWeapon > 0) {
        const weapon = weapons[currentWeapon - 1];
        weapon.cooldown = weapon.冷却 = this.safeNum(weapon.cooldown ?? weapon.冷却) - 3;
      }
      if (sets.attackMode === 1) bonus.攻击2 = this.safeNum(bonus.攻击2) + 25 + skillLevel * 2;
      else {
        bonus.攻击2 = this.safeNum(bonus.攻击2) + 15 + skillLevel;
        bonus.命中2 = this.safeNum(bonus.命中2) + skillLevel;
      }
    }
    const fiveTimes = hasBuff('五番');
    if (fiveTimes !== undefined) {
      const stack = Math.min(fiveTimes, 5 + skillLevel);
      bonus.攻击2 = this.safeNum(bonus.攻击2) + 5 * stack;
      bonus.暴击 = this.safeNum(bonus.暴击) + stack;
      bonus.暴击伤害 = this.safeNum(bonus.暴击伤害) + stack * 5;
    }
    if (hasBuff('歼灭模式') !== undefined) bonus.攻击2 = this.safeNum(bonus.攻击2) + 30 + skillLevel;

    // L301-L346：启示录、兴奋、鱼雷b、安宝乖乖。
    if (hasBuff('启示录') !== undefined) {
      for (const field of ['护盾电抗', '护盾物抗', '护盾冰抗', '护盾火抗', '生命电抗', '生命物抗', '生命冰抗', '生命火抗', '装甲电抗', '装甲物抗', '装甲冰抗', '装甲火抗'] as const) {
        (bonus as any)[field] = (1 + Math.floor(Math.random() * 10000)) / 100;
      }
    }
    if (hasBuff('兴奋') !== undefined) {
      addAllResist(20, 20, 20);
      bonus.攻击2 = this.safeNum(bonus.攻击2) + 15;
      bonus.护盾2 = this.safeNum(bonus.护盾2) + 20;
      bonus.装甲2 = this.safeNum(bonus.装甲2) + 20;
      bonus.生命2 = this.safeNum(bonus.生命2) + 20;
      bonus.护盾回复2 = this.safeNum(bonus.护盾回复2) * 1.2 + 0.5;
      bonus.装甲回复2 = this.safeNum(bonus.装甲回复2) * 1.2 + 0.5;
      bonus.生命回复2 = this.safeNum(bonus.生命回复2) * 1.2 + 0.5;
      bonus.护盾回复 = this.safeNum(bonus.护盾回复) * 1.2;
      bonus.装甲回复 = this.safeNum(bonus.装甲回复) * 1.2;
      bonus.生命回复 = this.safeNum(bonus.生命回复) * 1.2;
      bonus.命中2 = this.safeNum(bonus.命中2) + 20;
      bonus.暴击 = this.safeNum(bonus.暴击) + 20;
      bonus.闪避2 = this.safeNum(bonus.闪避2) + 20;
      bonus.经验 = this.safeNum(bonus.经验) + 100;
      bonus.掉落率 = this.safeNum(bonus.掉落率) + 50;
      bonus.掉落品质 = this.safeNum(bonus.掉落品质) + 100;
      sets.legendaryRate = this.safeNum(sets.legendaryRate) + 2;
    }
    if (hasBuff('鱼雷b') !== undefined) {
      addAllResist(-10, -10, -10);
      bonus.闪避2 = this.safeNum(bonus.闪避2) - 20;
      bonus.命中2 = this.safeNum(bonus.命中2) - 20;
    }
    if (hasBuff('安宝乖乖') !== undefined) {
      bonus.生命回复2 = this.safeNum(bonus.生命回复2) + 2;
      addAllResist(20);
    }

    // L347-L396：xta、真火、苦行、清道夫、空间创造、灼烧、盾逆、甲逆。
    const xta = hasBuff('xta');
    if (xta !== undefined) {
      bonus.护盾回复 = this.safeNum(bonus.护盾回复) * (1 - xta);
      bonus.护盾回复2 = this.safeNum(bonus.护盾回复2) - xta * 100;
    }
    if (hasBuff('真火') !== undefined) {
      bonus.攻击2 = this.safeNum(bonus.攻击2) + 50;
      addAllResist(50, 50, 50);
      addPenetration(25);
      bonus.贯穿 = this.safeNum(bonus.贯穿) + 50;
      bonus.抗贯穿 = this.safeNum(bonus.抗贯穿) + 50;
      bonus.暴击伤害 = this.safeNum(bonus.暴击伤害) + 50;
      bonus.护盾2 = this.safeNum(bonus.护盾2) + 50;
      bonus.生命2 = this.safeNum(bonus.生命2) + 50;
      bonus.装甲2 = this.safeNum(bonus.装甲2) + 50;
      bonus.命中2 = this.safeNum(bonus.命中2) + 50;
      bonus.闪避2 = this.safeNum(bonus.闪避2) + 50;
    }
    const ascetic = hasBuff('苦行');
    if (ascetic !== undefined) bonus.攻击2 = this.safeNum(bonus.攻击2) + ascetic;
    const scavenger = hasBuff('清道夫');
    if (scavenger !== undefined) bonus.攻击2 = this.safeNum(bonus.攻击2) + scavenger / 2;
    if (hasBuff('空间创造') !== undefined) {
      const factor = 0.1 + skillLevel / 200;
      bonus.命中 = this.safeNum(bonus.命中) * (1 + factor);
      bonus.暴击 = this.safeNum(bonus.暴击) * (1 + factor);
      bonus.暴击伤害 = this.safeNum(bonus.暴击伤害) + factor * 200;
    }
    if (hasBuff('灼烧') !== undefined) {
      for (const field of ['护盾回复', '生命回复', '装甲回复', '护盾回复2', '生命回复2', '装甲回复2'] as const) {
        bonus[field] = this.safeNum(bonus[field]) / 2;
      }
    }
    if (hasBuff('盾逆') !== undefined) {
      bonus.护盾回复 = -this.safeNum(bonus.护盾回复);
      bonus.护盾回复2 = -this.safeNum(bonus.护盾回复2);
    }
    if (hasBuff('甲逆') !== undefined) {
      bonus.装甲回复 = -this.safeNum(bonus.装甲回复);
      bonus.装甲回复2 = -this.safeNum(bonus.装甲回复2);
    }

    // L398-L416：守护2与万象。
    const guard2 = hasBuff('守护2');
    if (guard2 !== undefined) bonus.攻击2 = this.safeNum(bonus.攻击2) + guard2 * 12;
    if (hasBuff('万象') !== undefined) {
      if (affinity >= 60) {
        bonus.贯穿 = this.safeNum(bonus.贯穿) + 20;
        addPenetration(15);
      }
      const currentType = String(weapons[currentWeapon - 1]?.type ?? weapons[currentWeapon - 1]?.类型 ?? '');
      if (currentWeapon === 0 || currentType === '近战武器') addAllResist(25);
    }

    // L427-L436：直接携带加成的增益、增幅器与皇冠。
    for (const buff of buffs) {
      if (!buff) continue;
      const source = buff.bonus ?? buff.加成;
      if (source) Object.assign(bonus, this.mergeBonus(bonus, source));
      if (source?.生命全抗 || source?.护盾全抗 || source?.装甲全抗) {
        addAllResist(
          this.safeNum(source.生命全抗),
          this.safeNum(source.护盾全抗),
          this.safeNum(source.装甲全抗),
        );
      }
    }
    if (sets.amplifier === 5) bonus.贯穿 = this.safeNum(bonus.贯穿) + 10;
    if (sets.crown === 3) sets.legendaryRate = this.safeNum(sets.legendaryRate) + 2;

    // L437-L443：叹息之墙装备、纳米注喷器。
    if (hasEquipBySeq(12)) bonus.护盾 = this.safeNum(bonus.护盾) * 1.2;
    else if (hasEquipBySeq(13)) bonus.装甲 = this.safeNum(bonus.装甲) * 1.25;

    // L444-L456：心形贴冷却、暴击熟练度。
    if (hasEquipBySeq(30)) {
      if (currentWeapon > 0) {
        const weapon = weapons[currentWeapon - 1];
        weapon.cooldown = weapon.冷却 = this.safeNum(weapon.cooldown ?? weapon.冷却) * 0.85;
      } else {
        weapons.forEach((weapon) => {
          weapon.cooldown = weapon.冷却 = this.safeNum(weapon.cooldown ?? weapon.冷却) * 0.85;
        });
      }
    }
    bonus.暴击伤害 = this.safeNum(bonus.暴击伤害) + this.safeNum(markers['暴击']);

    // L457-L464：超载核心（原版默认分支为武器×0.85，按原版保留）。
    if (hasEquipBySeq(24)) {
      if (currentWeapon > 0) {
        const weapon = weapons[currentWeapon - 1];
        weapon.cooldown = weapon.冷却 = this.safeNum(weapon.cooldown ?? weapon.冷却) * 1.25;
      } else {
        weapons.forEach((weapon) => {
          weapon.cooldown = weapon.冷却 = this.safeNum(weapon.cooldown ?? weapon.冷却) * 0.85;
        });
      }
    }

    // L467-L473：生命祝福。
    if (hasEquipByName('生命祝福')) {
      bonus.生命2 = this.safeNum(bonus.生命2) + 25;
      bonus.生命回复2 = this.safeNum(bonus.生命回复2)
        + this.safeNum(bonus.护盾回复2) * 0.99
        + this.safeNum(bonus.装甲回复2) * 0.99;
      bonus.生命回复 = this.safeNum(bonus.生命回复)
        + this.safeNum(bonus.护盾回复) * 0.99
        + this.safeNum(bonus.装甲回复) * 0.99;
      bonus.装甲回复 = this.safeNum(bonus.装甲回复) * 0.01;
      bonus.护盾回复 = this.safeNum(bonus.护盾回复) * 0.01;
    }

    // L474-L529：丝袜系列。
    const fourDamage = this.safeNum(bonus.物伤) + this.safeNum(bonus.冰伤)
      + this.safeNum(bonus.火伤) + this.safeNum(bonus.电伤);
    if (hasEquipByName('白色裤袜')) {
      bonus.命中 = this.safeNum(bonus.命中) + fourDamage * 0.0025;
    } else if (hasEquipOnlyBySeq(129)) {
      bonus.闪避 = this.safeNum(bonus.闪避) + fourDamage * 0.0025;
    } else if (hasEquipBySeq(62)) {
      if (this.safeNum(bonus.闪避) < this.safeNum(bonus.命中)) {
        attrs.闪避2 = this.safeNum(attrs.闪避2) + (1 - this.safeNum(bonus.闪避) / this.safeNum(bonus.命中)) * 100;
      }
    } else if (hasEquipBySeq(60)) {
      if (this.safeNum(bonus.命中) < this.safeNum(bonus.闪避)) {
        attrs.命中 = this.safeNum(attrs.命中2) + (1 - this.safeNum(bonus.命中) / this.safeNum(bonus.闪避)) * 100;
      }
    } else if (hasEquipBySeq(61)) {
      if (shieldPool(bonus) > armorPool(bonus)) {
        if (poolValue(bonus, '生命') < poolValue(bonus, '护盾')) attrs.生命2 = this.safeNum(attrs.生命2) + (1 - poolValue(bonus, '生命') / poolValue(bonus, '护盾')) * 100;
      } else if (poolValue(bonus, '生命') < poolValue(bonus, '装甲')) attrs.生命2 = this.safeNum(attrs.生命2) + (1 - poolValue(bonus, '生命') / poolValue(bonus, '装甲')) * 100;
    } else if (hasEquipBySeq(59)) {
      if (armorPool(bonus) > poolValue(bonus, '生命')) {
        if (poolValue(bonus, '护盾') < armorPool(bonus)) attrs.护盾2 = this.safeNum(attrs.护盾2) + (1 - poolValue(bonus, '护盾') / armorPool(bonus)) * 100;
      } else if (poolValue(bonus, '护盾') < poolValue(bonus, '生命')) attrs.护盾2 = this.safeNum(attrs.护盾2) + (1 - poolValue(bonus, '护盾') / poolValue(bonus, '生命')) * 100;
    } else if (hasEquipBySeq(118)) {
      if (poolValue(bonus, '护盾') > poolValue(bonus, '生命')) {
        if (armorPool(bonus) < poolValue(bonus, '护盾')) attrs.装甲2 = this.safeNum(attrs.装甲2) + (1 - armorPool(bonus) / poolValue(bonus, '护盾')) * 100;
      } else if (armorPool(bonus) < poolValue(bonus, '生命')) attrs.装甲2 = this.safeNum(attrs.装甲2) + (1 - armorPool(bonus) / poolValue(bonus, '生命')) * 100;
    }

    // L530-L555：神龙保佑/祥瑞。
    const dragonBless = hasEquipBySeq(36) ? 1 : 0;
    const dragonLuck = hasEquipBySeq(37) ? 1 : 0;
    if (dragonBless) attrs.命中2 = this.safeNum(attrs.命中2) + (dragonLuck ? 5 : 2.5);
    if (dragonLuck) {
      attrs.护盾2 = this.safeNum(attrs.护盾2) + (dragonBless ? 10 : 5);
      attrs.装甲2 = this.safeNum(attrs.装甲2) + (dragonBless ? 10 : 5);
    }

    // L556-L561：生命祝福套装与暴击钳制。
    if (sets.lifeBless === 5) bonus.攻击 = this.safeNum(bonus.攻击) + this.safeNum(context.currentHp) / 5;
    if (this.safeNum(bonus.暴击) > 100) bonus.暴击 = 100;

    // L562-L575：肩炮溅射。
    if (hasEquipBySeq(8)) {
      const currentSelfSplash = currentWeapon > 0
        ? this.safeNum((weapons[currentWeapon - 1].baseBonus ?? weapons[currentWeapon - 1].自带 ?? {})['溅射2'])
        : 0;
      if ((this.safeNum(bonus.溅射2) < 1 && currentSelfSplash < 1 && currentWeapon > 0)
        || (currentWeapon === 0 && this.safeNum(bonus.溅射2) < 1)) {
        bonus.溅射2 = 1;
      }
    }

    function shieldPool(source: BonusData) { return Math.max(poolValue(source, '护盾'), poolValue(source, '装甲')); }
    function armorPool(source: BonusData) { return poolValue(source, '装甲'); }
    function poolValue(source: BonusData, field: '护盾' | '装甲' | '生命') {
      return field === '护盾' ? safeNumber(source.护盾)
        : field === '装甲' ? safeNumber(source.装甲)
          : safeNumber(source.生命);
    }
    function safeNumber(value: unknown) { return typeof value === 'number' && isFinite(value) ? value : 0; }
  }
  /**
   * 载具加成
   * 对应原版：载具加成()（加成计算.ecode L3334-L3379）
   * 计算玩家当前驾驶载具提供的属性加成，并处理法宝（含光之外）的载具属性加成放大。
   * @param player 玩家上下文（属性/加成/基础加成/套装/载具编号，原地修改）
   * @param vehicles 地图上的载具列表
   * @param increaseValue 初始增加值（默认1）
   */
  calculateVehicleBonus(
    player: {
      attributes?: BonusData;
      bonus?: BonusData;
      baseBonus?: BonusData;
      sets?: SetData;
      vehicle?: string;
    },
    vehicles: VehicleData[],
    increaseValue = 1,
  ): void {
    const attrs = player.attributes || (player.attributes = {});
    const bonus = player.bonus || (player.bonus = {});
    const sets = player.sets || {};

    // 法宝（小樱命中次数 0<类型<5）且法宝等级（陪睡）>2：从载具获得的属性+5%
    const faBaoType = this.safeNum(sets.sakuraHits);
    const inc = faBaoType > 0 && faBaoType < 5 && this.safeNum(sets.sleepover) > 2 ? 1.05 : increaseValue || 1;

    // 未驾驶载具则直接返回
    if (!player.vehicle) return;

    const vehicle = (vehicles || []).find((v) => v && v.id === player.vehicle);
    if (!vehicle) return;
    // 载具已损坏则不提供加成
    if (this.safeNum(vehicle.currentHp) <= 0) return;

    const vBonus = vehicle.bonus || {};
    // 二阶攻击/闪避/命中按增加值累加到属性，并清零源值（防止重复叠加）
    attrs.攻击2 = this.safeNum(attrs.攻击2) + this.safeNum(vBonus.攻击2) * inc;
    attrs.闪避2 = this.safeNum(attrs.闪避2) + this.safeNum(vBonus.闪避2) * inc;
    attrs.命中2 = this.safeNum(attrs.命中2) + this.safeNum(vBonus.命中2) * inc;
    vBonus.攻击2 = 0;
    vBonus.闪避2 = 0;
    vBonus.命中2 = 0;

    // 其余载具加成按叠加加成规则并入玩家加成
    this.mergeBonusTo(bonus, vBonus, { increaseValue: inc });

    // 发丝（白的发丝加成）：掉落率/掉落品质固定为特殊值
    if (vehicle.hair) {
      bonus.掉落率 = 0;
      bonus.掉落品质 = 0;
      if (player.baseBonus) {
        player.baseBonus.掉落率 = 0;
        player.baseBonus.掉落品质 = 0;
      }
      attrs.掉落率 = 222;
      attrs.掉落品质 = 444;
    }

    this.logger.log(`载具加成：载具[${vehicle.name || vehicle.id}] 属性已叠加，增加系数=${inc}`);
  }

  /**
   * 计算装备强化
   * 对应原版：计算装备强化()（加成计算.ecode L1158-L1387）
   * 根据强化熟练度对装备自带属性进行强化，将暴击/暴击伤害/抗性/掉落/魅力等
   * 折算到对应主属性上。
   * @param equip 装备上下文（自带/加成属性，原地修改）
   * @param isWeapon 是否为武器（武器使用"武器强化"熟练度）
   * @param reinforceProficiency 强化熟练度（武器强化 或 装备类型+强化）
   * @param reverseProficiency 逆向熟练度（装备名）
   * @param mingYuLevel 冥鱼技能等级（强化放大系数）
   */
  calcEquipReinforce(
    equip: EquipReinforceContext,
    isWeapon: boolean,
    reinforceProficiency: number,
    reverseProficiency: number,
    mingYuLevel = 0,
  ): void {
    const self = equip.self || (equip.self = {});
    const bonus = equip.bonus || {};

    // 强化系数 = 强化熟练度 / 200
    let a1 = (reinforceProficiency || 0) / 200;
    // 逆向熟练度 >= 20 时强化效果额外 +25%
    if ((reverseProficiency || 0) >= 20) {
      a1 *= 1.25;
    }
    if (a1 <= 0) return;

    // 冥鱼技能提供的强化放大系数
    const mingYuFactor = 1.05 + mingYuLevel / 200;

    // 常规主属性：自带/加成 均按 a1 强化到自带属性
    const primaryFields = [
      '攻击', '生命', '装甲', '护盾', '命中', '闪避',
      '电伤', '物伤', '火伤', '冰伤',
      '速度', '生命回复', '装甲回复', '护盾回复',
    ] as const;
    for (const field of primaryFields) {
      if (this.safeNum(self[field]) > 0) {
        self[field] = this.safeNum(self[field]) + this.safeNum(self[field]) * a1;
      }
      if (this.safeNum(bonus[field]) > 0) {
        self[field] = this.safeNum(self[field]) + this.safeNum(bonus[field]) * a1;
      }
    }

    // 暴击/暴击伤害 → 折算为攻击
    if (this.safeNum(self.暴击) > 0) self.攻击 = this.safeNum(self.攻击) + this.safeNum(self.暴击) * a1 * mingYuFactor * 5.5556;
    if (this.safeNum(bonus.暴击) > 0) self.攻击 = this.safeNum(self.攻击) + this.safeNum(bonus.暴击) * a1 * mingYuFactor * 5.5556;
    if (this.safeNum(self.暴击伤害) > 0) self.攻击 = this.safeNum(self.攻击) + this.safeNum(self.暴击伤害) * a1 * mingYuFactor * 0.6;
    if (this.safeNum(bonus.暴击伤害) > 0) self.攻击 = this.safeNum(self.攻击) + this.safeNum(bonus.暴击伤害) * a1 * mingYuFactor * 0.6;

    // 各部位抗性 → 折算为对应部位主属性
    this.reinforceResist(self, bonus, '生命', '生命全抗', a1, mingYuFactor, 5.3333, 1.3333);
    this.reinforceResist(self, bonus, '装甲', '装甲全抗', a1, mingYuFactor, 5.926, 1.481);
    this.reinforceResist(self, bonus, '护盾', '护盾全抗', a1, mingYuFactor, 6.6667, 1.6667);

    // 掉落品质/掉落率 → 折算为经验
    if (this.safeNum(self.掉落品质) > 0) self.经验 = this.safeNum(self.经验) + (this.safeNum(self.掉落品质) * a1) / 10;
    if (this.safeNum(bonus.掉落品质) > 0) self.经验 = this.safeNum(self.经验) + (this.safeNum(bonus.掉落品质) * a1) / 10;
    if (this.safeNum(self.掉落率) > 0) self.经验 = this.safeNum(self.经验) + (this.safeNum(self.掉落率) * a1) / 5;
    if (this.safeNum(bonus.掉落率) > 0) self.经验 = this.safeNum(self.经验) + (this.safeNum(bonus.掉落率) * a1) / 5;

    // 减益强化
    if (this.safeNum(self.减益) > 0) self.减益 = this.safeNum(self.减益) + this.safeNum(self.减益) * a1;
    if (this.safeNum(bonus.减益) > 0) self.减益 = this.safeNum(self.减益) + this.safeNum(bonus.减益) * a1;

    // 魅力 → 折算为生命/装甲/护盾
    const charmBoost = (this.safeNum(self.魅力) + this.safeNum(bonus.魅力)) * a1 * mingYuFactor * 5.5556;
    if (charmBoost > 0) {
      self.生命 = this.safeNum(self.生命) + charmBoost;
      self.装甲 = this.safeNum(self.装甲) + charmBoost;
      self.护盾 = this.safeNum(self.护盾) + charmBoost;
    }

    this.logger.log(`计算装备强化：${equip.name || equip.type || '未知装备'} 强化系数=${a1.toFixed(4)}`);
  }

  /**
   * 抗性折算主属性（装备强化专用）
   * 全抗折算系数更大；单抗按部位对应系数折算
   */
  private reinforceResist(
    self: BonusData,
    bonus: BonusData,
    primaryField: keyof BonusData,
    allResField: keyof BonusData,
    a1: number,
    mingYuFactor: number,
    allResMult: number,
    singleResMult: number,
  ): void {
    // 全抗：×4 的折算系数
    const selfAll = this.safeNum(self[allResField] as number);
    if (selfAll > 0) {
      (self[primaryField] as number) = this.safeNum(self[primaryField] as number) + selfAll * a1 * 4 * mingYuFactor * allResMult;
    }
    const bonusAll = this.safeNum(bonus[allResField] as number);
    if (bonusAll > 0) {
      (self[primaryField] as number) = this.safeNum(self[primaryField] as number) + bonusAll * a1 * 4 * mingYuFactor * allResMult;
    }
    // 四种单抗
    const resFields = [
      `${primaryField}FireRes`,
      `${primaryField}IceRes`,
      `${primaryField}PhysRes`,
      `${primaryField}ElecRes`,
    ] as const;
    for (const rf of resFields) {
      const selfV = this.safeNum((self as any)[rf]);
      if (selfV > 0) {
        (self[primaryField] as number) = this.safeNum(self[primaryField] as number) + selfV * a1 * mingYuFactor * singleResMult;
      }
      const bonusV = this.safeNum((bonus as any)[rf]);
      if (bonusV > 0) {
        (self[primaryField] as number) = this.safeNum(self[primaryField] as number) + bonusV * a1 * mingYuFactor * singleResMult;
      }
    }
  }
}
