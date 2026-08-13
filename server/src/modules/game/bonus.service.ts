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

/**
 * 加成属性接口，对应原版易语言的"加成"数据类型
 */
export interface BonusData {
  attack?: number;         // 攻击
  charm?: number;          // 魅力
  attackBonus?: number;    // 攻击加成%
  hp?: number;             // 生命
  shield?: number;         // 护盾
  armor?: number;          // 装甲
  dodge?: number;          // 闪避
  hit?: number;            // 命中
  diamond?: number;        // 钻石
  speed?: number;          // 速度
  hpRegen?: number;        // 生命回复
  shieldRegen?: number;    // 护盾回复
  armorRegen?: number;     // 装甲回复
  dropRate?: number;       // 掉落率
  dropQuality?: number;    // 掉落品质
  tenacity?: number;       // 韧性
  debuff?: number;         // 减益
  allAttack?: boolean;     // 全体攻击
  healEffect?: number;     // 治疗效果
  cooldown?: number;       // 冷却
  gap?: number;            // 世界等级差距
  defense?: number;        // 防御
  allResist?: number;      // 全抗性
  crit?: number;           // 暴击率
  critDmg?: number;        // 暴击伤害
  hpDmgCap?: number;       // 生命伤害上限%
  armorDmgCap?: number;    // 装甲伤害上限%
  shieldDmgCap?: number;   // 护盾伤害上限%
  hpFireRes?: number;      // 生命火抗
  hpIceRes?: number;       // 生命冰抗
  hpPhysRes?: number;      // 生命物抗
  hpElecRes?: number;      // 生命电抗
  armorFireRes?: number;   // 装甲火抗
  armorIceRes?: number;    // 装甲冰抗
  armorPhysRes?: number;   // 装甲物抗
  armorElecRes?: number;   // 装甲电抗
  shieldFireRes?: number;  // 护盾火抗
  shieldIceRes?: number;   // 护盾冰抗
  shieldPhysRes?: number;  // 护盾物抗
  shieldElecRes?: number;  // 护盾电抗
  atkShield?: number;      // 攻击护盾
  atkArmor?: number;       // 攻击装甲
  atkHp?: number;          // 攻击生命
  elecDmg?: number;        // 电伤
  fireDmg?: number;        // 火伤
  physDmg?: number;        // 物伤
  iceDmg?: number;         // 冰伤
  gather?: number;         // 采集
  leechHp?: number;        // 吸生命
  leechArmor?: number;     // 吸装甲
  leechShield?: number;    // 吸护盾
  hpAllRes?: number;       // 生命全抗
  armorAllRes?: number;    // 装甲全抗
  shieldAllRes?: number;   // 护盾全抗
  exp?: number;            // 经验
  upgradeExp?: number;     // 升级经验
  splash?: number;         // 溅射
  splashCount?: number;    // 溅射数量
  hpPenetration?: number;  // 生命穿透
  armorPenetration?: number; // 装甲穿透
  shieldPenetration?: number; // 护盾穿透
  penetrate?: number;      // 贯穿几率
  antiPenetrate?: number;  // 抗贯穿
  attack2?: number;        // 攻击2（受加成递减限制）
  hp2?: number;            // 生命2
  shield2?: number;        // 护盾2
  armor2?: number;         // 装甲2
  dodge2?: number;         // 闪避2
  hit2?: number;           // 命中2
  speed2?: number;         // 速度2
  hpRegen2?: number;       // 生命回复2
  shieldRegen2?: number;   // 护盾回复2
  armorRegen2?: number;    // 装甲回复2
  elecDmg2?: number;       // 电伤2
  fireDmg2?: number;       // 火伤2
  physDmg2?: number;       // 物伤2
  iceDmg2?: number;        // 冰伤2
  leechHp2?: number;       // 吸生命2
  leechArmor2?: number;    // 吸装甲2
  leechShield2?: number;   // 吸护盾2
  reflectDmg?: number;     // 反伤
  anesthesia?: number;     // 麻醉
  mustHit?: boolean;       // 必中
  attackCount?: number;    // 攻击次数
  attackText?: string;     // 攻击文本
  production?: number;     // 生产力
  comeback?: number;       // 卷土重来
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
  expireAt?: number;       // 有效期至（时间戳，本框架使用秒）
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
  buildings?: { name: string }[];   // 地图建筑（如"花园猫窝"）
  summons?: { equipment?: { name: string }[] }[]; // 地图召唤物及其装备
  items?: { name: string; quantity?: number }[];  // 地图物品
  markers3?: BuffData[];            // 地图标记3（含有效期与强度的增益）
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
    if (bonus.attack2) bonus.attack2 = this.applyDiminishingReturns(bonus.attack2);
    if (bonus.elecDmg2) bonus.elecDmg2 = this.applyDiminishingReturns(bonus.elecDmg2);
    if (bonus.physDmg2) bonus.physDmg2 = this.applyDiminishingReturns(bonus.physDmg2);
    if (bonus.fireDmg2) bonus.fireDmg2 = this.applyDiminishingReturns(bonus.fireDmg2);
    if (bonus.iceDmg2) bonus.iceDmg2 = this.applyDiminishingReturns(bonus.iceDmg2);
    if (bonus.dodge2) bonus.dodge2 = this.applyDiminishingReturns(bonus.dodge2);
    if (bonus.hit2) bonus.hit2 = this.applyDiminishingReturns(bonus.hit2);
    if (bonus.shield2) bonus.shield2 = this.applyDiminishingReturns(bonus.shield2);
    if (bonus.armor2) bonus.armor2 = this.applyDiminishingReturns(bonus.armor2);
    if (bonus.hp2) bonus.hp2 = this.applyDiminishingReturns(bonus.hp2);
    if (bonus.speed2) bonus.speed2 = this.applyDiminishingReturns(bonus.speed2);
    if (bonus.hpRegen2) bonus.hpRegen2 = this.applyDiminishingReturns(bonus.hpRegen2);
    if (bonus.armorRegen2) bonus.armorRegen2 = this.applyDiminishingReturns(bonus.armorRegen2);
    if (bonus.shieldRegen2) bonus.shieldRegen2 = this.applyDiminishingReturns(bonus.shieldRegen2);
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
    bonus.hpPenetration = (bonus.hpPenetration || 0) + value;
    bonus.armorPenetration = (bonus.armorPenetration || 0) + value;
    bonus.shieldPenetration = (bonus.shieldPenetration || 0) + value;
  }

  /**
   * 计算经验值升级所需经验
   * 对应原版升级经验公式
   */
  calcUpgradeExp(level: number): number {
    return Math.floor(100 * Math.pow(1.15, level - 1));
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
    const safe = (v: number | undefined) => v || 0;

    // 各部位抗性分母：1 - (该部位四抗之和 / 500)，避免除零取最小值保护
    const hpDenom = Math.max(
      0.1,
      1 - (safe(bonus.hpFireRes) + safe(bonus.hpIceRes) + safe(bonus.hpElecRes) + safe(bonus.hpPhysRes)) / 500,
    );
    const armorDenom = Math.max(
      0.1,
      1 - (safe(bonus.armorFireRes) + safe(bonus.armorIceRes) + safe(bonus.armorElecRes) + safe(bonus.armorPhysRes)) / 500,
    );
    const shieldDenom = Math.max(
      0.1,
      1 - (safe(bonus.shieldFireRes) + safe(bonus.shieldIceRes) + safe(bonus.shieldElecRes) + safe(bonus.shieldPhysRes)) / 500,
    );

    // 第一段：生命/装甲/护盾（经抗性放大后）* 3
    let a1 =
      (safe(bonus.hp) / hpDenom + safe(bonus.armor) / armorDenom + safe(bonus.shield) / shieldDenom) * 3;

    // 第二段：四种元素伤害 + 暴击期望伤害，再乘以攻击加成与穿透放大
    const elementDmg =
      safe(bonus.elecDmg) + safe(bonus.physDmg) + safe(bonus.iceDmg) + safe(bonus.fireDmg);
    const critBonus = (safe(bonus.crit) / 100) * (safe(bonus.critDmg) / 100) * elementDmg;
    const atkBoost = 1 + (safe(bonus.atkHp) + safe(bonus.atkArmor) + safe(bonus.atkShield)) / 300;
    const penDenom = Math.max(
      0.1,
      1 - (safe(bonus.shieldPenetration) + safe(bonus.armorPenetration) + safe(bonus.hpPenetration)) / 300,
    );
    a1 += ((elementDmg + critBonus) * atkBoost) / penDenom;

    // 第三段：三部位回复加成（含二阶回复按比例折算）
    a1 +=
      (safe(bonus.hpRegen) * 10 + (safe(bonus.hpRegen2) / 10) * safe(bonus.hp)) / hpDenom +
      (safe(bonus.armorRegen) * 10 + (safe(bonus.armorRegen2) / 10) * safe(bonus.armor)) / armorDenom +
      (safe(bonus.shieldRegen) * 10 + (safe(bonus.shieldRegen2) / 10) * safe(bonus.shield)) / shieldDenom;

    // 第四段：速度/闪避/命中
    a1 += safe(bonus.speed) * 5 + safe(bonus.dodge) * 5 + safe(bonus.hit) * 5;

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
  private safeNum(v: number | undefined | null): number {
    return typeof v === 'number' && isFinite(v) ? v : 0;
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
        bonus.hpFireRes = this.safeNum(bonus.hpFireRes) + ((100 - this.safeNum(bonus.hpFireRes)) / 100) * lifeAllRes;
        bonus.hpIceRes = this.safeNum(bonus.hpIceRes) + ((100 - this.safeNum(bonus.hpIceRes)) / 100) * lifeAllRes;
        bonus.hpPhysRes = this.safeNum(bonus.hpPhysRes) + ((100 - this.safeNum(bonus.hpPhysRes)) / 100) * lifeAllRes;
        bonus.hpElecRes = this.safeNum(bonus.hpElecRes) + ((100 - this.safeNum(bonus.hpElecRes)) / 100) * lifeAllRes;
      } else {
        // 负数：按百分比乘法削弱
        const f = 1 + lifeAllRes / 100;
        bonus.hpFireRes = this.safeNum(bonus.hpFireRes) * f;
        bonus.hpIceRes = this.safeNum(bonus.hpIceRes) * f;
        bonus.hpPhysRes = this.safeNum(bonus.hpPhysRes) * f;
        bonus.hpElecRes = this.safeNum(bonus.hpElecRes) * f;
      }
    }
    if (armorAllRes !== 0) {
      if (armorAllRes > 0) {
        bonus.armorFireRes = this.safeNum(bonus.armorFireRes) + ((100 - this.safeNum(bonus.armorFireRes)) / 100) * armorAllRes;
        bonus.armorIceRes = this.safeNum(bonus.armorIceRes) + ((100 - this.safeNum(bonus.armorIceRes)) / 100) * armorAllRes;
        bonus.armorPhysRes = this.safeNum(bonus.armorPhysRes) + ((100 - this.safeNum(bonus.armorPhysRes)) / 100) * armorAllRes;
        bonus.armorElecRes = this.safeNum(bonus.armorElecRes) + ((100 - this.safeNum(bonus.armorElecRes)) / 100) * armorAllRes;
      } else {
        const f = 1 + armorAllRes / 100;
        bonus.armorFireRes = this.safeNum(bonus.armorFireRes) * f;
        bonus.armorIceRes = this.safeNum(bonus.armorIceRes) * f;
        bonus.armorPhysRes = this.safeNum(bonus.armorPhysRes) * f;
        bonus.armorElecRes = this.safeNum(bonus.armorElecRes) * f;
      }
    }
    if (shieldAllRes !== 0) {
      if (shieldAllRes > 0) {
        bonus.shieldFireRes = this.safeNum(bonus.shieldFireRes) + ((100 - this.safeNum(bonus.shieldFireRes)) / 100) * shieldAllRes;
        bonus.shieldIceRes = this.safeNum(bonus.shieldIceRes) + ((100 - this.safeNum(bonus.shieldIceRes)) / 100) * shieldAllRes;
        bonus.shieldPhysRes = this.safeNum(bonus.shieldPhysRes) + ((100 - this.safeNum(bonus.shieldPhysRes)) / 100) * shieldAllRes;
        bonus.shieldElecRes = this.safeNum(bonus.shieldElecRes) + ((100 - this.safeNum(bonus.shieldElecRes)) / 100) * shieldAllRes;
      } else {
        const f = 1 + shieldAllRes / 100;
        bonus.shieldFireRes = this.safeNum(bonus.shieldFireRes) * f;
        bonus.shieldIceRes = this.safeNum(bonus.shieldIceRes) * f;
        bonus.shieldPhysRes = this.safeNum(bonus.shieldPhysRes) * f;
        bonus.shieldElecRes = this.safeNum(bonus.shieldElecRes) * f;
      }
    }
  }

  /**
   * 全属性调整
   * 对应原版：全属性调整()（使魔技能.ecode L87-L124）
   * 将属性对象中的所有核心数值统一乘以调整系数（用于梦倾天下等百分比削弱/增强）
   * @param attributes 属性对象（会被原地修改）
   * @param factor 调整系数（如 0.9 表示整体降低10%）
   */
  private adjustAllAttributes(attributes: BonusData, factor: number): void {
    attributes.shield = this.safeNum(attributes.shield) * factor;
    attributes.armor = this.safeNum(attributes.armor) * factor;
    attributes.hp = this.safeNum(attributes.hp) * factor;
    attributes.shieldFireRes = this.safeNum(attributes.shieldFireRes) * factor;
    attributes.shieldIceRes = this.safeNum(attributes.shieldIceRes) * factor;
    attributes.shieldPhysRes = this.safeNum(attributes.shieldPhysRes) * factor;
    attributes.shieldElecRes = this.safeNum(attributes.shieldElecRes) * factor;
    attributes.armorFireRes = this.safeNum(attributes.armorFireRes) * factor;
    attributes.armorIceRes = this.safeNum(attributes.armorIceRes) * factor;
    attributes.armorPhysRes = this.safeNum(attributes.armorPhysRes) * factor;
    attributes.armorElecRes = this.safeNum(attributes.armorElecRes) * factor;
    attributes.hpFireRes = this.safeNum(attributes.hpFireRes) * factor;
    attributes.hpIceRes = this.safeNum(attributes.hpIceRes) * factor;
    attributes.hpPhysRes = this.safeNum(attributes.hpPhysRes) * factor;
    attributes.hpElecRes = this.safeNum(attributes.hpElecRes) * factor;
    attributes.dodge = this.safeNum(attributes.dodge) * factor;
    attributes.hit = this.safeNum(attributes.hit) * factor;
    attributes.elecDmg = this.safeNum(attributes.elecDmg) * factor;
    attributes.fireDmg = this.safeNum(attributes.fireDmg) * factor;
    attributes.iceDmg = this.safeNum(attributes.iceDmg) * factor;
    attributes.physDmg = this.safeNum(attributes.physDmg) * factor;
    attributes.crit = this.safeNum(attributes.crit) * factor;
    attributes.critDmg = this.safeNum(attributes.critDmg) * factor;
    attributes.shieldRegen = this.safeNum(attributes.shieldRegen) * factor;
    attributes.armorRegen = this.safeNum(attributes.armorRegen) * factor;
    attributes.hpRegen = this.safeNum(attributes.hpRegen) * factor;
    attributes.shieldRegen2 = this.safeNum(attributes.shieldRegen2) * factor;
    attributes.armorRegen2 = this.safeNum(attributes.armorRegen2) * factor;
    attributes.hpRegen2 = this.safeNum(attributes.hpRegen2) * factor;
    attributes.penetrate = this.safeNum(attributes.penetrate) * factor;
    attributes.antiPenetrate = this.safeNum(attributes.antiPenetrate) * factor;
    attributes.atkShield = this.safeNum(attributes.atkShield) * factor;
    attributes.atkArmor = this.safeNum(attributes.atkArmor) * factor;
    attributes.atkHp = this.safeNum(attributes.atkHp) * factor;
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
    const a1 = 1 - this.safeNum(target.tenacity) / 100;

    // 生产（默认叠加）
    if (!opts.noProduction) {
      target.production = this.safeNum(target.production) + this.safeNum(source.production) * inc;
    }
    // 魅力、攻击次数直接累加
    target.charm = this.safeNum(target.charm) + this.safeNum(source.charm) * inc;
    target.attackCount = this.safeNum(target.attackCount) + this.safeNum(source.attackCount) * inc;

    // 常规主属性（正加负乘）
    this.addPrimary(target, source, 'attack', 'attack2', inc, isBuff, a1, z);
    this.addPrimary(target, source, 'hp', 'hp2', inc, isBuff, a1, z);
    this.addPrimary(target, source, 'shield', 'shield2', inc, isBuff, a1, z);
    this.addPrimary(target, source, 'armor', 'armor2', inc, isBuff, a1, z);
    this.addPrimary(target, source, 'dodge', 'dodge2', inc, isBuff, a1, z);
    this.addPrimary(target, source, 'hit', 'hit2', inc, isBuff, a1, z);
    this.addPrimary(target, source, 'speed', 'speed2', inc, isBuff, a1, z);
    this.addPrimary(target, source, 'hpRegen', 'hpRegen2', inc, isBuff, a1, z);
    this.addPrimary(target, source, 'shieldRegen', 'shieldRegen2', inc, isBuff, a1, z);
    this.addPrimary(target, source, 'armorRegen', 'armorRegen2', inc, isBuff, a1, z);

    // 无条件累加字段
    this.addNum(target, source, 'diamond', inc);
    this.addNum(target, source, 'dropRate', inc);
    this.addNum(target, source, 'dropQuality', inc);
    this.addNum(target, source, 'healEffect', inc);
    this.addNum(target, source, 'gap', inc);
    this.addNum(target, source, 'gather', inc);
    this.addNum(target, source, 'leechHp', inc);
    this.addNum(target, source, 'leechArmor', inc);
    this.addNum(target, source, 'leechShield', inc);
    this.addNum(target, source, 'leechHp2', inc);
    this.addNum(target, source, 'leechArmor2', inc);
    this.addNum(target, source, 'leechShield2', inc);
    this.addNum(target, source, 'exp', inc);
    this.addNum(target, source, 'upgradeExp', inc);
    this.addNum(target, source, 'cooldown', inc);
    this.addNum(target, source, 'hpPenetration', inc);
    this.addNum(target, source, 'armorPenetration', inc);
    this.addNum(target, source, 'shieldPenetration', inc);
    this.addNum(target, source, 'anesthesia', inc);
    this.addNum(target, source, 'reflectDmg', inc);

    // 韧性：正加（带已方剩余韧性比例），负按百分比乘
    {
      const val = this.safeNum(source.tenacity);
      if (val >= 0) {
        target.tenacity = this.safeNum(target.tenacity) + (1 - this.safeNum(target.tenacity) / 100) * val * inc;
      } else {
        target.tenacity = this.safeNum(target.tenacity) * (1 + val / 100) * a1 * inc;
      }
    }
    // 减益：正加，负按百分比乘
    {
      const val = this.safeNum(source.debuff);
      if (val >= 0) {
        target.debuff = this.safeNum(target.debuff) + val * inc;
      } else {
        target.debuff = this.safeNum(target.debuff) * (1 + val / 100) * a1 * inc;
      }
    }
    // 全体攻击：任一来源开启则开启
    if (source.allAttack) target.allAttack = true;

    // 暴击/暴击伤害：正加，负按韧性减免后加
    this.addWithTenacity(target, source, 'crit', inc, a1);
    this.addWithTenacity(target, source, 'critDmg', inc, a1);

    // 伤害上限：取最小值（未设置时默认100）
    this.applyDmgCap(target, 'hpDmgCap', source.hpDmgCap);
    this.applyDmgCap(target, 'shieldDmgCap', source.shieldDmgCap);
    this.applyDmgCap(target, 'armorDmgCap', source.armorDmgCap);

    // 溅射2：正加（不叠加溅射时跳过），负按韧性减免后加
    {
      const val = this.safeNum(source.splashCount);
      if (val >= 0) {
        if (!opts.noSplash) target.splashCount = this.safeNum(target.splashCount) + val * inc;
      } else {
        target.splashCount = this.safeNum(target.splashCount) + val * a1 * inc;
      }
    }

    // 各部位单抗（12项）：正负都按堆叠公式，负值再乘韧性减免
    this.addResist(target, source, 'hpFireRes', inc, a1);
    this.addResist(target, source, 'hpIceRes', inc, a1);
    this.addResist(target, source, 'hpPhysRes', inc, a1);
    this.addResist(target, source, 'hpElecRes', inc, a1);
    this.addResist(target, source, 'shieldFireRes', inc, a1);
    this.addResist(target, source, 'shieldIceRes', inc, a1);
    this.addResist(target, source, 'shieldPhysRes', inc, a1);
    this.addResist(target, source, 'shieldElecRes', inc, a1);
    this.addResist(target, source, 'armorFireRes', inc, a1);
    this.addResist(target, source, 'armorIceRes', inc, a1);
    this.addResist(target, source, 'armorPhysRes', inc, a1);
    this.addResist(target, source, 'armorElecRes', inc, a1);

    // 全抗（3项）：正按堆叠公式存字段，负走增加全抗（按韧性减免）
    this.addAllResistField(target, source, 'hpAllRes', inc, a1);
    this.addAllResistField(target, source, 'shieldAllRes', inc, a1);
    this.addAllResistField(target, source, 'armorAllRes', inc, a1);

    // 攻击护盾/装甲/生命：正加，负按韧性减免后加
    this.addWithTenacity(target, source, 'atkShield', inc, a1);
    this.addWithTenacity(target, source, 'atkArmor', inc, a1);
    this.addWithTenacity(target, source, 'atkHp', inc, a1);

    // 元素伤害：正加（非增益受增幅器二阶放大），负按韧性减免后加
    this.addElemDmg(target, source, 'elecDmg', 'elecDmg2', inc, isBuff, a1, z);
    this.addElemDmg(target, source, 'fireDmg', 'fireDmg2', inc, isBuff, a1, z);
    this.addElemDmg(target, source, 'physDmg', 'physDmg2', inc, isBuff, a1, z);
    this.addElemDmg(target, source, 'iceDmg', 'iceDmg2', inc, isBuff, a1, z);

    // 卷土重来、溅射（默认叠加）
    target.comeback = this.safeNum(target.comeback) + this.safeNum(source.comeback);
    if (!opts.noSplash) {
      target.splash = this.safeNum(target.splash) + this.safeNum(source.splash) * inc;
    }

    // 贯穿/抗贯穿：正加（默认叠加），负按百分比乘
    this.addPenetrateChance(target, source, 'penetrate', inc, a1, !!opts.noSplash);
    this.addPenetrateChance(target, source, 'antiPenetrate', inc, a1, !!opts.noSplash);

    // 二阶回复（生命回复2等）：正加，负按百分比乘到主回复与二阶回复
    this.addRegen2(target, source, 'hpRegen2', inc, a1);
    this.addRegen2(target, source, 'shieldRegen2', inc, a1);
    this.addRegen2(target, source, 'armorRegen2', inc, a1);

    // 二阶属性（*2）：装备模式进属性对象，增益模式按百分比乘到主属性，否则累加
    this.addSecondOrder(target, source, 'hp2', 'hp', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, 'shield2', 'shield', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, 'armor2', 'armor', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, 'dodge2', 'dodge', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, 'hit2', 'hit', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, 'elecDmg2', 'elecDmg', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, 'fireDmg2', 'fireDmg', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, 'physDmg2', 'physDmg', inc, isBuff, a1, !!opts.isEquipment, attrs);
    this.addSecondOrder(target, source, 'iceDmg2', 'iceDmg', inc, isBuff, a1, !!opts.isEquipment, attrs);

    // 攻击2（特殊）：增益时按百分比乘到四种伤害上，否则累加/负乘
    this.addAttack2(target, source, 'attack2', inc, isBuff, a1);
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
      if (field === 'hpAllRes') this.addAllResistance(target, resistVal, 0, 0);
      else if (field === 'shieldAllRes') this.addAllResistance(target, 0, resistVal, 0);
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
        field === 'hpRegen2' ? 'hpRegen' : field === 'shieldRegen2' ? 'shieldRegen' : 'armorRegen';
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
        target.elecDmg = this.safeNum(target.elecDmg) * mult;
        target.fireDmg = this.safeNum(target.fireDmg) * mult;
        target.physDmg = this.safeNum(target.physDmg) * mult;
        target.iceDmg = this.safeNum(target.iceDmg) * mult;
      } else {
        (target[field] as number) = this.safeNum(target[field] as number) + val * inc;
      }
    } else {
      const mult = (1 + (val * a1) / 100) * inc;
      target.elecDmg = this.safeNum(target.elecDmg) * mult;
      target.fireDmg = this.safeNum(target.fireDmg) * mult;
      target.physDmg = this.safeNum(target.physDmg) * mult;
      target.iceDmg = this.safeNum(target.iceDmg) * mult;
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
   * @param now 当前时间戳（秒）
   * @param strength 强度（可空）
   * @param stackStrength 是否叠加强度（可空，默认取较大值）
   * @returns 最终强度
   */
  applyBuff(buffs: BuffData[], name: string, time: number, stackTime: boolean, now: number, strength?: number, stackStrength?: boolean): number {
    // 本框架时间戳以秒为单位；原版为 时间 * #转秒(10000000)
    const timeScale = 1;
    for (let i = 0; i < buffs.length; i++) {
      const b = buffs[i];
      if (b && b.name === name) {
        if (stackTime) {
          // 叠加时间：在原有效期基础上增加
          b.expireAt = this.safeNum(b.expireAt) + time * timeScale;
          // 增加后仍已过期则删除并返回0
          if (now - this.safeNum(b.expireAt) >= 0) {
            buffs.splice(i, 1);
            return 0;
          }
        } else if (time !== 0) {
          // 不叠加时间：直接覆盖有效期
          b.expireAt = now + time * timeScale;
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
      expireAt: now + time * timeScale,
      stackTime,
      strength,
    });
    return this.safeNum(strength);
  }

  /**
   * 统计列表中指定名称物品的数量（数量缺省视为1）
   */
  private countItem(items: { name: string; quantity?: number }[] | undefined, name: string): number {
    if (!items) return 0;
    return items
      .filter((it) => it && it.name === name)
      .reduce((sum, it) => sum + (it.quantity || 1), 0);
  }

  /**
   * 获得地图增益
   * 对应原版：获得地图增益()（加成计算.ecode L577-L652）
   * 根据地图上的建筑/召唤物/标记，将有效的标记增益转移到玩家增益列表，并清理过期标记。
   * 说明：神兽蛋孵化涉及召唤物系统，本框架中仅记录日志，由外部召唤系统接管。
   * @param playerBuffs 玩家增益列表（原地修改）
   * @param map 地图上下文（建筑/召唤物/物品/标记3）
   * @param now 当前时间戳（秒）
   * @param originalTime 原始时间戳（用于地图标记有效期计算）
   */
  getMapBonus(playerBuffs: BuffData[], map: MapBonusContext, now: number, originalTime: number): void {
    const markers3 = map.markers3 || (map.markers3 = []);

    // 1. 花园猫窝建筑：每座提供 50+5*数量 强度的"啾啾猫猫"增益
    const catHouseCount = (map.buildings || []).filter((b) => b && b.name === '花园猫窝').length;
    if (catHouseCount > 0) {
      this.applyBuff(markers3, '啾啾猫猫', 30, false, originalTime, 50 + 5 * catHouseCount);
    }

    // 2. 召唤物装备"叹息之墙"：提供60秒"叹息之墙"增益
    for (const summon of map.summons || []) {
      if (!summon) continue;
      const equipList = summon.equipment || [];
      if (equipList.some((e) => e && e.name === '叹息之墙')) {
        this.applyBuff(markers3, '叹息之墙', 60, false, originalTime);
        break;
      }
    }

    // 3. 倒序遍历地图标记3：过期移除（含孵化处理），未过期转移到玩家增益
    for (let i = markers3.length - 1; i >= 0; i--) {
      const marker = markers3[i];
      if (!marker) continue;
      if (now >= this.safeNum(marker.expireAt)) {
        // 过期：若为"孵化中"且存在孵蛋鸡，原版会孵化神兽蛋（需召唤系统支持）
        if (marker.name === '孵化中' && this.countItem(map.items, '孵蛋鸡') >= 1) {
          this.logger.log(`地图增益：标记"孵化中"到期，触发孵蛋逻辑（需召唤系统支持）`);
        }
        markers3.splice(i, 1);
      } else {
        // 未过期：将剩余时长转成秒后作为增益加到玩家身上
        this.applyBuff(
          playerBuffs,
          marker.name,
          (this.safeNum(marker.expireAt) - now) / 1,
          !!marker.stackTime,
          now,
          this.safeNum(marker.strength),
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
      // 跳过已过期增益
      if (this.safeNum(buff.expireAt) < now) continue;
      const name = buff.name || '';
      const strength = this.safeNum(buff.strength);
      switch (name) {
        case 'mqtx': {
          // “梦倾天下”：下次攻击命中后降低目标所有属性
          if (this.safeNum(attributes.anesthesia) > 0) {
            const adjust =
              1 - (this.safeNum(context && context.currentAnesthesia) / this.safeNum(attributes.anesthesia)) * (strength / 100);
            this.adjustAllAttributes(attributes, adjust);
          }
          break;
        }
        case '湮灭': {
          // 湮灭：按强度(最高5)百分比削减生命/护盾/装甲
          const a1 = Math.min(strength, 5);
          attributes.hp = this.safeNum(attributes.hp) * (1 - a1 * 0.05);
          attributes.shield = this.safeNum(attributes.shield) * (1 - a1 * 0.05);
          attributes.armor = this.safeNum(attributes.armor) * (1 - a1 * 0.05);
          if (context && context.effectText) context.effectText.push(`湮灭${a1}`);
          break;
        }
        case '削弱闪避':
          // 削弱闪避：按强度百分比削减闪避
          attributes.dodge = this.safeNum(attributes.dodge) * (1 - strength / 10);
          break;
        case 'xla': {
          // 向量减抗（护盾系）
          const resist =
            -5 -
            (this.safeNum(attributes.shieldFireRes) +
              this.safeNum(attributes.shieldIceRes) +
              this.safeNum(attributes.shieldElecRes) +
              this.safeNum(attributes.shieldPhysRes)) /
              40;
          this.addAllResistance(bonus, 0, resist, 0);
          break;
        }
        case 'xlb': {
          // 向量减抗（装甲系）
          const resist =
            -5 -
            (this.safeNum(attributes.armorFireRes) +
              this.safeNum(attributes.armorIceRes) +
              this.safeNum(attributes.armorElecRes) +
              this.safeNum(attributes.armorPhysRes)) /
              40;
          this.addAllResistance(bonus, 0, 0, resist);
          break;
        }
        case 'xlc': {
          // 向量减抗（生命系，原版作用在加成上）
          const resist =
            -5 -
            (this.safeNum(attributes.hpFireRes) +
              this.safeNum(attributes.hpIceRes) +
              this.safeNum(attributes.hpElecRes) +
              this.safeNum(attributes.hpPhysRes)) /
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
    target.charm = safe(target.charm) + safe(source.charm);
    target.hp = safe(target.hp) + safe(source.hp);
    target.shield = safe(target.shield) + safe(source.shield);
    target.armor = safe(target.armor) + safe(source.armor);
    target.dodge = safe(target.dodge) + safe(source.dodge);
    target.hit = safe(target.hit) + safe(source.hit);
    target.speed = safe(target.speed) + safe(source.speed);
    target.comeback = safe(target.comeback) + safe(source.comeback);
    target.hpRegen = safe(target.hpRegen) + safe(source.hpRegen);
    target.shieldRegen = safe(target.shieldRegen) + safe(source.shieldRegen);
    target.armorRegen = safe(target.armorRegen) + safe(source.armorRegen);
    target.dropRate = safe(target.dropRate) + safe(source.dropRate);
    target.dropQuality = safe(target.dropQuality) + safe(source.dropQuality);
    // 韧性：按 (1-当前韧性/100)*来源 堆叠
    target.tenacity = safe(target.tenacity) + (1 - safe(target.tenacity) / 100) * safe(source.tenacity);
    target.debuff = safe(target.debuff) + safe(source.debuff);
    if (source.allAttack) target.allAttack = true;
    target.healEffect = safe(target.healEffect) + safe(source.healEffect);
    target.crit = safe(target.crit) + safe(source.crit);
    target.critDmg = safe(target.critDmg) + safe(source.critDmg);
    // 伤害上限：取最小值
    this.applyDmgCap(target, 'hpDmgCap', source.hpDmgCap);
    this.applyDmgCap(target, 'shieldDmgCap', source.shieldDmgCap);
    this.applyDmgCap(target, 'armorDmgCap', source.armorDmgCap);
    // 各部位单抗堆叠
    this.stackResist(target, source, 'hpFireRes');
    this.stackResist(target, source, 'hpIceRes');
    this.stackResist(target, source, 'hpPhysRes');
    this.stackResist(target, source, 'hpElecRes');
    this.stackResist(target, source, 'shieldFireRes');
    this.stackResist(target, source, 'shieldIceRes');
    this.stackResist(target, source, 'shieldPhysRes');
    this.stackResist(target, source, 'shieldElecRes');
    this.stackResist(target, source, 'armorFireRes');
    this.stackResist(target, source, 'armorIceRes');
    this.stackResist(target, source, 'armorPhysRes');
    this.stackResist(target, source, 'armorElecRes');
    // 全抗堆叠
    this.stackResist(target, source, 'hpAllRes');
    this.stackResist(target, source, 'shieldAllRes');
    this.stackResist(target, source, 'armorAllRes');
    // 攻击三系直接累加
    target.atkShield = safe(target.atkShield) + safe(source.atkShield);
    target.atkArmor = safe(target.atkArmor) + safe(source.atkArmor);
    target.atkHp = safe(target.atkHp) + safe(source.atkHp);
    // 元素伤害累加
    target.elecDmg = safe(target.elecDmg) + safe(source.elecDmg);
    target.fireDmg = safe(target.fireDmg) + safe(source.fireDmg);
    target.physDmg = safe(target.physDmg) + safe(source.physDmg);
    target.iceDmg = safe(target.iceDmg) + safe(source.iceDmg);
    target.gather = safe(target.gather) + safe(source.gather);
    target.leechHp = safe(target.leechHp) + safe(source.leechHp);
    target.leechArmor = safe(target.leechArmor) + safe(source.leechArmor);
    target.leechShield = safe(target.leechShield) + safe(source.leechShield);
    target.leechHp2 = safe(target.leechHp2) + safe(source.leechHp2);
    target.leechArmor2 = safe(target.leechArmor2) + safe(source.leechArmor2);
    target.leechShield2 = safe(target.leechShield2) + safe(source.leechShield2);
    target.exp = safe(target.exp) + safe(source.exp);
    target.upgradeExp = safe(target.upgradeExp) + safe(source.upgradeExp);
    target.splash = safe(target.splash) + safe(source.splash);
    target.splashCount = safe(target.splashCount) + safe(source.splashCount);
    target.hpPenetration = safe(target.hpPenetration) + safe(source.hpPenetration);
    target.armorPenetration = safe(target.armorPenetration) + safe(source.armorPenetration);
    target.shieldPenetration = safe(target.shieldPenetration) + safe(source.shieldPenetration);
    target.penetrate = safe(target.penetrate) + safe(source.penetrate);
    target.antiPenetrate = safe(target.antiPenetrate) + safe(source.antiPenetrate);
    target.anesthesia = safe(target.anesthesia) + safe(source.anesthesia);
    target.hpRegen2 = safe(target.hpRegen2) + safe(source.hpRegen2);
    target.shieldRegen2 = safe(target.shieldRegen2) + safe(source.shieldRegen2);
    target.armorRegen2 = safe(target.armorRegen2) + safe(source.armorRegen2);

    // 关键公式：四种元素伤害 = (累加伤害 + 自身攻击 + 来源攻击) * 各百分比放大
    const atk = safe(target.attack) + safe(source.attack);
    target.elecDmg =
      (safe(target.elecDmg) + atk) *
      (1 + safe(source.elecDmg2) / 100) *
      (1 + safe(source.attack2) / 100) *
      (1 + safe(target.attack2) / 100);
    target.fireDmg =
      (safe(target.fireDmg) + atk) *
      (1 + safe(source.fireDmg2) / 100) *
      (1 + safe(source.attack2) / 100) *
      (1 + safe(target.attack2) / 100);
    target.iceDmg =
      (safe(target.iceDmg) + atk) *
      (1 + safe(source.iceDmg2) / 100) *
      (1 + safe(source.attack2) / 100) *
      (1 + safe(target.attack2) / 100);
    target.physDmg =
      (safe(target.physDmg) + atk) *
      (1 + safe(source.physDmg2) / 100) *
      (1 + safe(source.attack2) / 100) *
      (1 + safe(target.attack2) / 100);

    // 速度/命中/闪避/护盾/装甲/生命：按二阶百分比放大
    target.speed = safe(target.speed) * (1 + safe(source.speed2) / 100) * (1 + safe(target.speed2) / 100);
    target.hit = safe(target.hit) * (1 + safe(source.hit2) / 100) * (1 + safe(target.hit2) / 100);
    target.dodge = safe(target.dodge) * (1 + safe(source.dodge2) / 100) * (1 + safe(target.dodge2) / 100);
    target.shield = safe(target.shield) * (1 + safe(source.shield2) / 100) * (1 + safe(target.shield2) / 100);
    target.armor = safe(target.armor) * (1 + safe(source.armor2) / 100) * (1 + safe(target.armor2) / 100);
    target.hp = safe(target.hp) * (1 + safe(source.hp2) / 100) * (1 + safe(target.hp2) / 100);

    // 分发全抗到各部位
    this.addAllResistance(target, safe(target.hpAllRes), safe(target.shieldAllRes), safe(target.armorAllRes));

    // 攻击次数累加
    target.attackCount = safe(target.attackCount) + safe(source.attackCount);

    if (debug) {
      this.logger.log(`最终加成：生命=${target.hp} 护盾=${target.shield} 装甲=${target.armor} 电伤=${target.elecDmg}`);
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
    return this.safeNum(marker.expireAt) <= now;
  }

  /**
   * 获取当前武器名称
   * 非数字QQ（怪物/宠物）使用当前武器索引；数字QQ（玩家）使用第一把武器
   */
  private findCurrentWeaponName(player: { qq?: string; weapons?: { name: string }[]; currentWeapon?: number }): string {
    const qq = String(player.qq || '');
    const weapons = player.weapons || [];
    if (/^\d+$/.test(qq)) {
      const w = weapons[0];
      return w ? w.name : '';
    }
    const idx = this.safeNum(player.currentWeapon);
    const w = weapons[idx];
    return w ? w.name : '';
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
   * @param now 当前时间戳（秒）
   */
  checkSetBonus(
    player: {
      currentHp?: number;
      currentShield?: number;
      currentArmor?: number;
      bonus?: BonusData;
      attributes?: BonusData;
      weapons?: { name: string }[];
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
    const totalBonus = this.safeNum(bonus.hp) + this.safeNum(bonus.armor) + this.safeNum(bonus.shield);
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
      attrs.attack2 = this.safeNum(attrs.attack2) + 15 * (1 - ratio);
      attrs.dodge2 = this.safeNum(attrs.dodge2) + 25 * (1 - ratio);
    } else if (sets.whiteWedding === 4) {
      // 白花嫁4件套：韧性提升 + 满血比例增伤/命中
      bonus.tenacity = this.safeNum(bonus.tenacity) + (1 - this.safeNum(bonus.tenacity) / 100) * 50;
      attrs.attack2 = this.safeNum(attrs.attack2) + 15 * ratio;
      attrs.hit2 = this.safeNum(attrs.hit2) + 25 * ratio;
    }

    // 暴击熟练度 → 暴击伤害
    bonus.critDmg = this.safeNum(bonus.critDmg) + this.getProficiency(player.markers, '暴击');

    // 当前武器特有效果
    const weaponName = this.findCurrentWeaponName(player);
    if (weaponName) {
      const level = this.safeNum(player.level);
      switch (weaponName) {
        case '高斯步枪':
          attrs.physDmg = this.safeNum(attrs.physDmg) + level * 2;
          break;
        case '追风者':
          attrs.elecDmg = this.safeNum(attrs.elecDmg) + level * 2;
          break;
        case '琴弦':
          attrs.fireDmg = this.safeNum(attrs.fireDmg) + level * 2;
          break;
        case '三叉戟':
          attrs.iceDmg = this.safeNum(attrs.iceDmg) + level * 2;
          break;
        case '高斯狙击枪':
          attrs.physDmg2 = this.safeNum(attrs.physDmg2) + ratio * 25;
          break;
        case '奥丁':
          attrs.hit2 = this.safeNum(attrs.hit2) + this.safeNum(bonus.physDmg) * 0.05;
          break;
        case '勒克斯之矛':
          attrs.attack2 = this.safeNum(attrs.attack2) + ratio * 25;
          break;
        default:
          break;
      }
    }
  }

  /**
   * 增强器
   * 对应原版：增强器()（加成计算.ecode L3453-L3556）
   * 根据剩余四种伤害中最高的一种，为指定部位（1护盾 2装甲 3生命）增加对应抗性。
   * @param attributes 属性对象（原地修改）
   * @param type 目标部位：1护盾 2装甲 3生命
   * @param remainingPhys 剩余物伤
   * @param remainingFire 剩余火伤
   * @param remainingIce 剩余冰伤
   * @param remainingElec 剩余电伤
   * @param increaseValue 增加值
   * @returns 特效文本（如"(电抗+5)"）
   */
  calculateEnhancer(
    attributes: BonusData,
    type: number,
    remainingPhys: number,
    remainingFire: number,
    remainingIce: number,
    remainingElec: number,
    increaseValue: number,
  ): string {
    // 判断剩余伤害最高类型：1电 2物 3火 4冰（默认冰）
    let b = 0;
    if (remainingElec > remainingPhys && remainingElec > remainingIce && remainingElec > remainingFire) b = 1;
    if (b === 0 && remainingPhys > remainingElec && remainingPhys > remainingIce && remainingPhys > remainingFire) b = 2;
    if (b === 0 && remainingFire > remainingElec && remainingFire > remainingIce && remainingFire > remainingPhys) b = 3;
    if (b === 0 && remainingIce > remainingElec && remainingIce > remainingPhys && remainingIce > remainingFire) b = 4;

    // 目标部位前缀：1护盾 2装甲 3生命
    const targetPrefix = type === 1 ? 'shield' : type === 2 ? 'armor' : 'hp';
    // 伤害类型 → 抗性后缀（0与4均落冰抗，对齐原版默认分支）
    const suffix = b === 1 ? 'Elec' : b === 2 ? 'Phys' : b === 3 ? 'Fire' : 'Ice';
    const resName = b === 1 ? '电' : b === 2 ? '物' : b === 3 ? '火' : '冰';
    const field = `${targetPrefix}${suffix}Res` as keyof BonusData;

    // 按堆叠公式增加对应抗性
    const cur = this.safeNum(attributes[field] as number);
    (attributes[field] as number) = cur + ((100 - cur) / 100) * increaseValue;

    const effectText = `(${resName}抗+${increaseValue})`;
    this.logger.log(`增强器：${targetPrefix}${suffix}Res 增加 ${increaseValue}`);
    return effectText;
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
    attrs.attack2 = this.safeNum(attrs.attack2) + this.safeNum(vBonus.attack2) * inc;
    attrs.dodge2 = this.safeNum(attrs.dodge2) + this.safeNum(vBonus.dodge2) * inc;
    attrs.hit2 = this.safeNum(attrs.hit2) + this.safeNum(vBonus.hit2) * inc;
    vBonus.attack2 = 0;
    vBonus.dodge2 = 0;
    vBonus.hit2 = 0;

    // 其余载具加成按叠加加成规则并入玩家加成
    this.mergeBonusTo(bonus, vBonus, { increaseValue: inc });

    // 发丝（白的发丝加成）：掉落率/掉落品质固定为特殊值
    if (vehicle.hair) {
      bonus.dropRate = 0;
      bonus.dropQuality = 0;
      if (player.baseBonus) {
        player.baseBonus.dropRate = 0;
        player.baseBonus.dropQuality = 0;
      }
      attrs.dropRate = 222;
      attrs.dropQuality = 444;
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
      'attack', 'hp', 'armor', 'shield', 'hit', 'dodge',
      'elecDmg', 'physDmg', 'fireDmg', 'iceDmg',
      'speed', 'hpRegen', 'armorRegen', 'shieldRegen',
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
    if (this.safeNum(self.crit) > 0) self.attack = this.safeNum(self.attack) + this.safeNum(self.crit) * a1 * mingYuFactor * 5.5556;
    if (this.safeNum(bonus.crit) > 0) self.attack = this.safeNum(self.attack) + this.safeNum(bonus.crit) * a1 * mingYuFactor * 5.5556;
    if (this.safeNum(self.critDmg) > 0) self.attack = this.safeNum(self.attack) + this.safeNum(self.critDmg) * a1 * mingYuFactor * 0.6;
    if (this.safeNum(bonus.critDmg) > 0) self.attack = this.safeNum(self.attack) + this.safeNum(bonus.critDmg) * a1 * mingYuFactor * 0.6;

    // 各部位抗性 → 折算为对应部位主属性
    this.reinforceResist(self, bonus, 'hp', 'hpAllRes', a1, mingYuFactor, 5.3333, 1.3333);
    this.reinforceResist(self, bonus, 'armor', 'armorAllRes', a1, mingYuFactor, 5.926, 1.481);
    this.reinforceResist(self, bonus, 'shield', 'shieldAllRes', a1, mingYuFactor, 6.6667, 1.6667);

    // 掉落品质/掉落率 → 折算为经验
    if (this.safeNum(self.dropQuality) > 0) self.exp = this.safeNum(self.exp) + (this.safeNum(self.dropQuality) * a1) / 10;
    if (this.safeNum(bonus.dropQuality) > 0) self.exp = this.safeNum(self.exp) + (this.safeNum(bonus.dropQuality) * a1) / 10;
    if (this.safeNum(self.dropRate) > 0) self.exp = this.safeNum(self.exp) + (this.safeNum(self.dropRate) * a1) / 5;
    if (this.safeNum(bonus.dropRate) > 0) self.exp = this.safeNum(self.exp) + (this.safeNum(bonus.dropRate) * a1) / 5;

    // 减益强化
    if (this.safeNum(self.debuff) > 0) self.debuff = this.safeNum(self.debuff) + this.safeNum(self.debuff) * a1;
    if (this.safeNum(bonus.debuff) > 0) self.debuff = this.safeNum(self.debuff) + this.safeNum(bonus.debuff) * a1;

    // 魅力 → 折算为生命/装甲/护盾
    const charmBoost = (this.safeNum(self.charm) + this.safeNum(bonus.charm)) * a1 * mingYuFactor * 5.5556;
    if (charmBoost > 0) {
      self.hp = this.safeNum(self.hp) + charmBoost;
      self.armor = this.safeNum(self.armor) + charmBoost;
      self.shield = this.safeNum(self.shield) + charmBoost;
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