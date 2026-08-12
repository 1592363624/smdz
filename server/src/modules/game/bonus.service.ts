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

@Injectable()
export class BonusService {
  private readonly logger = new Logger(BonusService.name);

  /**
   * 加成限制（递减收益）
   * 对应原版：加成限制()
   * 当数值超过阈值时，超出部分按比例衰减
   * @param value 原始数值
   * @returns 限制后的数值
   */
  applyDiminishingReturns(value: number): number {
    if (value < 1000) return value;

    let result = 1000;
    let remaining = value - 1000;

    if (remaining <= 1000) {
      result += remaining * 0.9;
    } else {
      result += 900;
      remaining -= 1000;
      if (remaining <= 1500) {
        result += remaining * 0.8;
      } else {
        result += 1200;
        remaining -= 1500;
        if (remaining <= 2000) {
          result += remaining * 0.7;
        } else {
          result += 1400;
          remaining -= 2000;
          if (remaining <= 3000) {
            result += remaining * 0.55;
          } else {
            result += 1650;
            remaining -= 3000;
            if (remaining <= 3500) {
              result += remaining * 0.3;
            } else {
              result += 1050;
              remaining -= 3500;
              if (remaining <= 4000) {
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
   * 根据各项属性综合计算
   */
  calcCombatPower(bonus: BonusData): number {
    const atk = (bonus.attack || 0) + (bonus.attack2 || 0);
    const hp = (bonus.hp || 0) + (bonus.hp2 || 0);
    const def = (bonus.armor || 0) + (bonus.armor2 || 0);
    const spd = (bonus.speed || 0) + (bonus.speed2 || 0);
    return Math.floor(atk * 2 + hp * 0.5 + def * 1.5 + spd * 0.8);
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
}