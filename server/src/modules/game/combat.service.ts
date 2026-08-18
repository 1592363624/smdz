/**
 * 战斗系统服务
 * 对应原版易语言：战斗相关.ecode
 * 负责武器攻击、伤害计算、技能效果、怪物掉落等
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BonusService, BonusData, AttributeData } from './bonus.service';
import { AchievementService } from './achievement.service';
import { PlayerService } from './player.service';

/**
 * 攻击上下文参数
 */
export interface AttackContext {
  damageMultiplier?: number; // 伤害倍率，默认1
  mustHit?: boolean;         // 是否强制命中
  allAttack?: boolean;       // 是否全体攻击
  attackText?: string;       // 自定义攻击文本
}

/**
 * 伤害计算结果
 */
export interface DamageResult {
  damage: number;    // 最终伤害
  isHit: boolean;    // 是否命中
  isCrit: boolean;   // 是否暴击
}

/**
 * 武器攻击结果
 */
export interface WeaponAttackResult {
  result: string;          // 攻击结果文本
  killed: string[];        // 被击杀的怪物名称列表
  damageDealt: number;     // 造成的总伤害
}

/**
 * 怪物死亡结果
 */
export interface MonsterDeathResult {
  expGain: number;  // 获得的经验
  drops: any[];     // 掉落物品列表
}

/**
 * 单次伤害对象（用于分池伤害计算）
 */
interface DamagePool {
  hp: number;
  armor: number;
  shield: number;
}

@Injectable()
export class CombatService {
  private readonly logger = new Logger(CombatService.name);

  // 伤害类型常量
  static readonly DAMAGE_PHYS = 1;
  static readonly DAMAGE_FIRE = 2;
  static readonly DAMAGE_ICE = 3;
  static readonly DAMAGE_ELEC = 4;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bonusService: BonusService,
    private readonly achievementService: AchievementService,
    private readonly playerService: PlayerService,
  ) {}

  /**
   * 武器攻击
   * 对应原版：武器攻击()
   * 处理一次完整的武器攻击流程：遍历防御者、判定命中、计算伤害、处理击杀
   * @param attacker 攻击者数据
   * @param weaponIndex 武器索引（0=拳头）
   * @param defenders 防御者数组
   * @param mapMonsters 地图怪物列表
   * @param context 攻击上下文参数
   * @returns 攻击结果文本、击杀列表、总伤害
   */
  async weaponAttack(
    attacker: any,
    weaponIndex: number,
    defenders: any[],
    mapMonsters: any[],
    context: AttackContext = {},
  ): Promise<WeaponAttackResult> {
    const { damageMultiplier = 1, mustHit = false, allAttack = false, attackText } = context;

    let resultLines: string[] = [];
    const killed: string[] = [];
    let totalDamage = 0;

    // 确定攻击目标列表
    let targets = defenders;
    if (allAttack) {
      targets = mapMonsters; // 全体攻击时攻击所有怪物
    }

    // 如果没有目标，返回默认信息
    if (!targets || targets.length === 0) {
      return { result: '没有可以攻击的目标', killed, damageDealt: 0 };
    }

    // 遍历每个目标进行攻击
    for (const defender of targets) {
      // 获取攻击者的加成数据
      const attackerBonus: BonusData = attacker.bonus || {};

      // 获取防御者的加成数据
      const defenderBonus: BonusData = defender.bonus || {};

      // 获取武器数据
      const weapon = this.getWeaponData(attacker, weaponIndex);

      // 确定伤害类型：优先使用武器附带的伤害类型，默认物理
      const damageType = weapon?.damageType || CombatService.DAMAGE_PHYS;

      // 计算伤害
      const { damage, isHit, isCrit } = this.calcDamage(
        attackerBonus,
        defenderBonus,
        weapon,
        damageType,
      );

      if (!isHit && !mustHit) {
        resultLines.push(`${defender.name || '目标'} 闪避了攻击`);
        continue;
      }

      // 应用伤害倍率
      let finalDamage = Math.floor(damage * damageMultiplier);
      totalDamage += finalDamage;

      // 扣除防御者生命值
      if (defender.生命 !== undefined) {
        defender.生命 = Math.max(0, defender.生命 - finalDamage);
      }

      // 构建攻击文本
      const atkText = attackText || this.getAttackText(weapon, 0);
      const critText = isCrit ? '【暴击】' : '';
      resultLines.push(
        `${atkText} ${defender.name || '目标'}，造成 ${finalDamage} 点伤害${critText}`,
      );

      // 处理击杀
      if (defender.生命 !== undefined && defender.生命 <= 0) {
        killed.push(defender.name || '未知怪物');
        resultLines.push(`${defender.name || '目标'} 已被击杀`);

        // 处理怪物死亡掉落（如果防御者是怪物）
        if (defender.isMonster && defender.id) {
          const deathResult = await this.handleMonsterDeath(
            defender,
            attacker.id,
            defender.mapId,
          );
          if (deathResult.drops.length > 0) {
            resultLines.push(`掉落：${deathResult.drops.map((d) => d.name).join('、')}`);
          }
        }
      }

      // 生命偷取处理
      if (attackerBonus.吸生命 && finalDamage > 0) {
        const leechAmount = Math.floor(finalDamage * (attackerBonus.吸生命 / 100));
        if (attacker.生命 !== undefined) {
          attacker.生命 = (attacker.生命 || 0) + leechAmount;
        }
      }
    }

    return {
      result: resultLines.join('\n'),
      killed,
      damageDealt: totalDamage,
    };
  }

  /**
   * 计算伤害
   * 根据攻击方属性、防御方属性、武器属性计算最终伤害
   * 考虑：命中判定、暴击判定、防御减伤、抗性、穿透、伤害上限
   * @param attacker 攻击者加成
   * @param defender 防御者加成
   * @param weapon 武器数据
   * @param damageType 伤害类型
   * @returns 伤害计算结果
   */
  calcDamage(
    attacker: BonusData,
    defender: BonusData,
    weapon: any,
    damageType: number,
  ): DamageResult {
    // 命中判定
    const hitRate = (attacker.命中 || 0) + (attacker.命中2 || 0) + (attacker.必中 ? 100 : 0);
    const dodgeRate = (defender.闪避 || 0) + (defender.闪避2 || 0);
    const isHit = this.checkHit(hitRate, dodgeRate);

    if (!isHit) {
      return { damage: 0, isHit: false, isCrit: false };
    }

    // 暴击判定
    const critRate = (attacker.暴击 || 0) + (attacker.暴击伤害 || 0);
    const isCrit = this.checkCrit(critRate);
    const critMultiplier = isCrit ? 1.5 + (attacker.暴击伤害 || 0) / 100 : 1.0;

    // 基础攻击力 = 攻击力 + 武器伤害 + 元素伤害
    const baseAttack =
      (attacker.攻击 || 0) +
      (attacker.攻击2 || 0) +
      (weapon?.damage || 0);

    // 元素伤害加成
    const eleDmg = this.getElemenalDamage(attacker, damageType);

    // 总攻击力
    let rawDamage = (baseAttack + eleDmg) * critMultiplier;

    // 穿透计算：降低防御方对应抗性
    const penetration = this.getPenetration(attacker, damageType);
    const resistance = this.getResistance(defender, damageType, penetration);

    // 减伤系数 = 1 - 抗性百分比
    const resistFactor = Math.max(0, 1 - resistance / 100);
    rawDamage = rawDamage * resistFactor;

    // 分池伤害计算（HP / Armor / Shield 三个独立血条）
    const damagePool = this.distributeDamageToPools(rawDamage, attacker, defender);

    // 取最终伤害 = 三个池子总实际扣血量
    const finalDamage = damagePool.hp + damagePool.armor + damagePool.shield;

    // 应用伤害上限限制
    const cappedDamage = this.applyDamageCap(finalDamage, attacker, defender);

    return { damage: Math.max(1, Math.floor(cappedDamage)), isHit: true, isCrit };
  }

  /**
   * 处理怪物死亡
   * 掉落物品、经验分配等
   * @param monster 怪物数据
   * @param attackerId 攻击者ID
   * @param mapId 地图ID
   * @returns 经验和掉落
   */
  async handleMonsterDeath(
    monster: any,
    attackerId: number,
    mapId: number,
  ): Promise<MonsterDeathResult> {
    // 计算经验值
    const expGain = this.calcMonsterExp(monster);

    // 生成掉落物
    const drops = this.generateDrops(monster, 1);

    // 更新数据库：将怪物从地图移除
    try {
      // 给攻击者增加经验（通过 addExp 触发升级判定，避免"经验满足但不升级"）
      if (attackerId && expGain > 0) {
        try {
          await this.playerService.addExp(attackerId, expGain);
        } catch (e) {
          this.logger.warn(`击杀加经验失败: ${e.message}`);
        }

        // 击杀成就：每次击杀怪物增加"击杀"成就计数
        try {
          const player = await this.prisma.player.findUnique({
            where: { userId: attackerId },
          });
          if (player) {
            await this.achievementService.addAchievement(player, '击杀', 1, false);
          }
        } catch (e) {
          this.logger.warn(`击杀成就记录失败: ${e.message}`);
        }
      }

      // 处理掉落入库（添加到玩家背包 JSON）
      for (const drop of drops) {
        if (drop.name) {
          const player = await this.prisma.player.findUnique({
            where: { userId: attackerId },
          });
          if (player) {
            const backpack = JSON.parse(player.backpack || '[]');
            const existing = backpack.find((item: any) => item.name === drop.name);
            if (existing) {
              existing.count = (existing.count || 1) + (drop.quantity || 1);
            } else {
              backpack.push({
                name: drop.name,
                count: drop.quantity || 1,
              });
            }
            await this.prisma.player.update({
              where: { userId: attackerId },
              data: { backpack: JSON.stringify(backpack) },
            });
          }
        }
      }
    } catch (error) {
      this.logger.warn(`怪物死亡处理异常: ${error.message}`);
    }

    return { expGain, drops };
  }

  /**
   * 检查是否命中
   * 命中率 = 攻击方命中率 - 防御方闪避率，至少保留5%基础命中率
   * @param hitRate 攻击方命中率
   * @param dodgeRate 防御方闪避率
   * @returns 是否命中
   */
  checkHit(hitRate: number, dodgeRate: number): boolean {
    const effectiveHitRate = Math.max(5, Math.min(100, hitRate - dodgeRate));
    return Math.random() * 100 < effectiveHitRate;
  }

  /**
   * 检查是否暴击
   * @param critRate 暴击率
   * @returns 是否暴击
   */
  checkCrit(critRate: number): boolean {
    const effectiveCritRate = Math.max(0, Math.min(100, critRate));
    return Math.random() * 100 < effectiveCritRate;
  }

  /**
   * 生成随机掉落
   * 根据怪物配置的掉落表和掉落率生成掉落物品
   * @param monster 怪物数据
   * @param dropMultiplier 掉落倍率
   * @returns 掉落物品列表
   */
  generateDrops(monster: any, dropMultiplier: number): any[] {
    const drops: any[] = [];

    // 如果没有掉落表，直接返回空
    if (!monster.dropTable || monster.dropTable.length === 0) {
      return drops;
    }

    // 根据掉落率判定每个掉落项
    for (const dropEntry of monster.dropTable) {
      const dropRate = (dropEntry.rate || 0) * dropMultiplier;
      if (Math.random() * 100 < dropRate) {
        drops.push({
          itemId: dropEntry.itemId,
          name: dropEntry.name || '未知物品',
          quantity: dropEntry.quantity || 1,
        });
      }
    }

    return drops;
  }

  /**
   * 获取武器攻击文本
   * 根据武器信息和文本类型返回对应的攻击描述
   * @param weapon 武器数据
   * @param textType 文本类型（0=攻击，1=技能等）
   * @returns 攻击文本
   */
  getAttackText(weapon: any, textType: number): string {
    if (!weapon) return '拳头攻击';

    // 如果武器有自定义攻击文本，优先使用
    if (weapon.attackText) return weapon.attackText;

    // 根据伤害类型返回默认文本
    const attackTexts: Record<number, string> = {
      [CombatService.DAMAGE_PHYS]: '物理攻击',
      [CombatService.DAMAGE_FIRE]: '火焰攻击',
      [CombatService.DAMAGE_ICE]: '冰霜攻击',
      [CombatService.DAMAGE_ELEC]: '雷电攻击',
    };

    // 如果有武器名称，带上武器名
    const weaponName = weapon.name || '武器';
    return `${weaponName}${attackTexts[weapon.damageType] || ''}`;
  }

  // ==================== 私有辅助方法 ====================

  /**
   * 获取武器数据
   * 根据攻击者背包中的武器索引获取武器信息
   * 索引0代表拳头（无武器）
   */
  private getWeaponData(attacker: any, weaponIndex: number): any {
    if (weaponIndex === 0) {
      return { name: '拳头', damage: 1, damageType: CombatService.DAMAGE_PHYS };
    }

    // 从攻击者装备或背包中获取武器
    const weapons = attacker.weapons || attacker.equipment || [];
    return weapons[weaponIndex - 1] || { name: '拳头', damage: 1, damageType: CombatService.DAMAGE_PHYS };
  }

  /**
   * 获取元素伤害加成
   * 根据伤害类型返回对应的元素伤害值
   */
  private getElemenalDamage(bonus: BonusData, damageType: number): number {
    switch (damageType) {
      case CombatService.DAMAGE_FIRE:
        return (bonus.火伤 || 0) + (bonus.火伤2 || 0);
      case CombatService.DAMAGE_ICE:
        return (bonus.冰伤 || 0) + (bonus.冰伤2 || 0);
      case CombatService.DAMAGE_ELEC:
        return (bonus.电伤 || 0) + (bonus.电伤2 || 0);
      case CombatService.DAMAGE_PHYS:
      default:
        return (bonus.物伤 || 0) + (bonus.物伤2 || 0);
    }
  }

  /**
   * 获取穿透值
   * 通用穿透（penetrate）和对应属性的穿透之和
   */
  private getPenetration(bonus: BonusData, damageType: number): number {
    const basePen = bonus.贯穿 || 0;

    // 根据伤害类型获取对应的专项穿透
    switch (damageType) {
      case CombatService.DAMAGE_PHYS:
        return basePen + (bonus.生命穿透 || 0);
      case CombatService.DAMAGE_FIRE:
        return basePen + (bonus.生命穿透 || 0);
      case CombatService.DAMAGE_ICE:
        return basePen + (bonus.生命穿透 || 0);
      case CombatService.DAMAGE_ELEC:
        return basePen + (bonus.护盾穿透 || 0);
      default:
        return basePen;
    }
  }

  /**
   * 获取防御方对应伤害类型的抗性
   * 考虑通用抗性 + 专项抗性 - 穿透
   */
  private getResistance(defender: BonusData, damageType: number, penetration: number): number {
    // 基础抗性 = 全抗 + 对应元素抗
    let baseRes = 0;

    // 优先使用生命抗性（HP 抗性体系）
    switch (damageType) {
      case CombatService.DAMAGE_PHYS:
        baseRes = (defender.生命物抗 || 0) + (defender.生命全抗 || 0);
        break;
      case CombatService.DAMAGE_FIRE:
        baseRes = (defender.生命火抗 || 0) + (defender.生命全抗 || 0);
        break;
      case CombatService.DAMAGE_ICE:
        baseRes = (defender.生命冰抗 || 0) + (defender.生命全抗 || 0);
        break;
      case CombatService.DAMAGE_ELEC:
        baseRes = (defender.生命电抗 || 0) + (defender.生命全抗 || 0);
        break;
    }

    // 减去穿透值
    return Math.max(0, baseRes - penetration);
  }

  /**
   * 分池伤害计算
   * 将总伤害分配到 HP / Armor / Shield 三个独立血条
   * 伤害优先级：Shield -> Armor -> HP
   * 每个池子有独立的伤害上限百分比
   */
  private distributeDamageToPools(
    damage: number,
    attacker: BonusData,
    defender: BonusData,
  ): DamagePool {
    const pool: DamagePool = { hp: 0, armor: 0, shield: 0 };

    // 获取各池子的当前值
    const currentShield = defender.护盾 || 0;
    const currentArmor = defender.装甲 || 0;
    const currentHp = defender.生命 || 0;

    // 各池子伤害上限（百分比），默认100%
    const shieldCap = (defender.护盾伤害上限 || 100) / 100;
    const armorCap = (defender.装甲伤害上限 || 100) / 100;
    const hpCap = (defender.生命伤害上限 || 100) / 100;

    let remaining = damage;

    // 1. 先扣护盾 Shield
    if (currentShield > 0 && remaining > 0) {
      const maxShieldDmg = currentShield * shieldCap;
      pool.shield = Math.min(remaining, maxShieldDmg, currentShield);
      remaining -= pool.shield;
    }

    // 2. 再扣装甲 Armor
    if (currentArmor > 0 && remaining > 0) {
      const maxArmorDmg = currentArmor * armorCap;
      pool.armor = Math.min(remaining, maxArmorDmg, currentArmor);
      remaining -= pool.armor;
    }

    // 3. 最后扣生命 HP
    if (currentHp > 0 && remaining > 0) {
      const maxHpDmg = currentHp * hpCap;
      pool.hp = Math.min(remaining, maxHpDmg, currentHp);
      remaining -= pool.hp;
    }

    return pool;
  }

  /**
   * 应用伤害上限
   * 确保单次伤害不超过各池子允许的最大百分比
   */
  private applyDamageCap(
    damage: number,
    attacker: BonusData,
    defender: BonusData,
  ): number {
    // 攻击方伤害上限加成
    const atkShieldCap = (attacker.攻击护盾 || 0) / 100 + 1;
    const atkArmorCap = (attacker.攻击装甲 || 0) / 100 + 1;
    const atkHpCap = (attacker.攻击生命 || 0) / 100 + 1;

    // 防御方各池子当前值
    const shield = defender.护盾 || 0;
    const armor = defender.装甲 || 0;
    const hp = defender.生命 || 0;

    // 计算各池子理论最大可承受伤害
    const maxShieldDmg = shield * ((defender.护盾伤害上限 || 100) / 100) * atkShieldCap;
    const maxArmorDmg = armor * ((defender.装甲伤害上限 || 100) / 100) * atkArmorCap;
    const maxHpDmg = hp * ((defender.生命伤害上限 || 100) / 100) * atkHpCap;

    // 总伤害上限
    const totalCap = maxShieldDmg + maxArmorDmg + maxHpDmg;

    return Math.min(damage, totalCap);
  }

  /**
   * 计算怪物经验值
   * 根据怪物等级和配置计算击杀后获得的经验
   */
  private calcMonsterExp(monster: any): number {
    const baseExp = monster.exp || monster.baseExp || 10;
    const level = monster.level || 1;
    return Math.floor(baseExp * (1 + (level - 1) * 0.1));
  }
}