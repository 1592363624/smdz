/**
 * 战斗子系统
 * 对应原版：战斗相关.ecode
 * 完整实现：武器攻击、炮击、伤害计算、特效触发、怪物AI、掉落生成等
 *
 * 核心伤害模型：
 * - 四种伤害类型：物理(1)、火焰(2)、冰霜(3)、雷电(4)
 * - 三个独立血池：护盾(Shield) → 装甲(Armor) → 生命(HP)
 * - 伤害 = 攻击力 × 武器属性系数 × 暴击倍率 × 随机修正 × (1 - 抗性/100) × 易伤
 * - 命中率 = 攻击方命中 / 防御方闪避 (最低5%基础命中率)
 * - 等级差距修正：低等级打高等级伤害衰减，反之亦然
 * - 递减收益：二阶段属性超过阈值后按比例衰减
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService, PlayerData } from './player.service';
import { BonusService, BonusData } from './bonus.service';
import { MapService, MapMonster } from './map.service';

// ==================== 类型定义 ====================

/**
 * 攻击上下文参数
 * 对应原版 武器攻击() 的可选参数
 */
export interface AttackContext {
  damageMultiplier?: number; // 伤害倍率（百分比），默认100
  mustHit?: boolean;         // 是否强制命中
  allAttack?: boolean;       // 是否全体攻击
  attackText?: string;       // 自定义攻击文本，强制替换武器攻击文本
  noDelay?: boolean;         // 是否无视冷却/锁定时间
  originalTimestamp?: number; // 原始时间戳，用于冷却判定
  /** 是否由自动连击触发的攻击 */
  isCombo?: boolean;
  /** 是否由延时攻击触发的攻击 */
  isDelayed?: boolean;
  /** 是否由自动战斗循环触发的攻击 */
  isAutoCombat?: boolean;
}

/**
 * 使魔特效结果
 * 使魔专属战斗特效处理后返回的修改参数
 */
export interface FamiliarEffectResult {
  /** 修改后的伤害倍率 */
  damageMultiplier: number;
  /** 修改后的命中率修正（百分比） */
  hitRateModifier: number;
  /** 修改后的全体攻击标记 */
  allAttack: boolean;
  /** 修改后的溅射数量 */
  splashCount: number;
  /** 修改后的溅射伤害倍率 */
  splashDamageMultiplier: number;
  /** 溅射伤害是否必中 */
  splashMustHit: boolean;
  /** 额外攻击次数 */
  extraAttacks: number;
  /** 穿透加成（百分比） */
  extraPenetration: number;
  /** 特效文本 */
  effectText: string;
  /** 是否偷取目标的闪避状态 */
  stealDodge: boolean;
  /** 修改后的武器冷却时间（秒） */
  cooldownOverride: number;
  /** 是否触发自动连击 */
  triggerCombo: boolean;
  /** 是否触发全体攻击（强制覆盖） */
  forceAllAttack: boolean;
  /** 武器名显示（如普拉娜） */
  weaponDisplayName: string;
}

/**
 * 伤害计算结果（单次命中）
 */
export interface DamageResult {
  damage: number;       // 最终总伤害（三池合计）
  isHit: boolean;       // 是否命中
  isCrit: boolean;      // 是否暴击
  hitRate: number;      // 实际命中率
  damageBreakdown: DamageBreakdown; // 四属性分项伤害明细
  poolDamage: PoolDamage; // 三池分伤明细
  critMultiplier: number; // 暴击倍率
}

/**
 * 四属性伤害明细
 * 对应原版"属性"数据类型
 */
export interface DamageBreakdown {
  physical: number;  // 物理伤害
  fire: number;      // 火焰伤害
  ice: number;       // 冰霜伤害
  elec: number;      // 雷电伤害
}

/**
 * 三池分伤结果
 * 伤害优先级：护盾(Shield) → 装甲(Armor) → 生命(HP)
 * 每个池子独立计算抗性和穿透
 */
export interface PoolDamage {
  shield: number;     // 护盾扣减量
  armor: number;      // 装甲扣减量
  hp: number;         // 生命扣减量
}

/**
 * 武器攻击结果
 */
export interface WeaponAttackResult {
  result: string;       // 攻击结果文本（多行）
  killed: string[];     // 被击杀的怪物名称列表
  damageDealt: number;  // 造成的总伤害
  expGained: number;    // 获得的总经验
  drops: any[];         // 掉落物品列表
}

/**
 * 怪物死亡结果
 */
export interface MonsterDeathResult {
  expGain: number;
  drops: any[];
}

/**
 * 特效处理结果
 */
export interface SpecialEffectResult {
  bonusDmg: number;       // 额外伤害
  effectText: string;     // 特效文本
  extraBuffs: any[];      // 需要添加的增益
  hitRateModifier: number; // 命中率修正
  damageMultiplier: number; // 伤害倍率修正
  extraPenetration: number; // 额外穿透
}

/**
 * 武器数据结构（简化版，对应原版"装备"数据类型）
 */
export interface WeaponData {
  name: string;
  damage: number;
  damageType: number;
  attackText?: string;
  type?: string;          // 近战武器/射弹武器/能量武器等
  specialSeq?: number;    // 特殊序号（对应常量表）
  cooldown?: number;      // 冷却时间
  lockTime?: number;      // 锁定时间
  forcedEffect?: boolean; // 必出特效
  vehicleForceDmg?: boolean; // 无视载具伤害上限
  properties?: {          // 属性系数（物理/火焰/冰霜/雷电 百分比）
    phys: number;
    fire: number;
    ice: number;
    elec: number;
  };
  bonus?: BonusData;      // 武器自带加成
  baseBonus?: BonusData;  // 武器基础加成
  attackTexts?: string[]; // 攻击文本列表
  buffs?: any[];          // 攻击造成的增益
  negativeType?: number;  // 负面类型（1割裂/2灼烧/3深寒/4感电）
  specialEffect?: number; // 特效序号（47因果逆转/45斩首/44尖兵等）
}

@Injectable()
export class CombatSystemService {
  private readonly logger = new Logger(CombatSystemService.name);

  // 伤害类型常量
  static readonly DMG_PHYS = 1;
  static readonly DMG_FIRE = 2;
  static readonly DMG_ICE = 3;
  static readonly DMG_ELEC = 4;

  // 命中结果等级（用于攻击文本显示）
  private static readonly HIT_RESULT = {
    MISS: 0,        // 未命中
    NORMAL: 1,      // 普通命中
    SHIELD_BREAK: 2, // 破盾
    ARMOR_BREAK: 3,  // 破甲
    KILL: 4,         // 击杀
    LOCK: 5,         // 锁定
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly bonusService: BonusService,
    private readonly mapService: MapService,
  ) {}

  // ==================== 公开接口 ====================

  /**
   * 武器攻击 - 完整版
   * 对应原版：武器攻击()
   * 处理武器攻击完整流程：选择目标 → 命中判定 → 伤害计算 → 特效触发 → 击杀处理
   *
   * @param userId 攻击者用户ID
   * @param weaponIndex 武器索引（0=拳头）
   * @param context 攻击上下文参数
   */
  async weaponAttack(
    userId: number,
    weaponIndex: number,
    context: AttackContext = {},
  ): Promise<WeaponAttackResult> {
    const {
      damageMultiplier = 100,
      mustHit = false,
      allAttack = false,
      attackText = '',
      noDelay = false,
      originalTimestamp = Date.now(),
    } = context;

    // 1. 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查是否死亡
    if (this.playerService.isPlayerDead(player)) {
      return {
        result: '你已经死亡，无法攻击。请先使用"救助"命令复活。',
        killed: [],
        damageDealt: 0,
        expGained: 0,
        drops: [],
      };
    }

    // 2. 获取当前地图
    const map = await this.prisma.gameMap.findUnique({
      where: { id: player.mapId },
    });
    if (!map) {
      return { result: '你不在任何地图上！', killed: [], damageDealt: 0, expGained: 0, drops: [] };
    }

    // 3. 从地图获取怪物列表
    const monsters = this.mapService.getMapMonsters(map);
    if (monsters.length === 0) {
      return {
        result: '当前地图没有怪物，等待刷新...',
        killed: [],
        damageDealt: 0,
        expGained: 0,
        drops: [],
      };
    }

    // 4. 获取武器数据
    const weapon = this.getWeaponData(player, weaponIndex);

    // 5. 确定攻击目标列表
    let targets = this.selectTargets(monsters, player, allAttack, weapon);

    if (targets.length === 0) {
      return { result: '没有可以攻击的目标', killed: [], damageDealt: 0, expGained: 0, drops: [] };
    }

    // 6. 处理使魔专属战斗特效
    // 根据玩家的当前使魔类型，触发专属战斗特效（如战斗女仆随机效果、伊卡洛斯歼灭模式等）
    const familiarEffect = this.processFamiliarEffects(player, playerData, weapon, context);
    // 应用使魔特效修改后的参数
    const effectiveDamageMultiplier = familiarEffect.damageMultiplier; // 修改后的伤害倍率
    const effectiveAllAttack = familiarEffect.forceAllAttack || familiarEffect.allAttack; // 实际全体攻击标记
    const hitRateModifier = familiarEffect.hitRateModifier; // 命中率修正
    const extraPenetration = familiarEffect.extraPenetration; // 额外穿透
    const effectText = familiarEffect.effectText; // 特效文本

    // 如果使魔特效改变了全体攻击标记，重新选择目标
    // 例如：战斗女仆RPG!/机枪会取消全体攻击，云爆弹会强制全体攻击
    if (effectiveAllAttack !== allAttack) {
      targets = this.selectTargets(monsters, player, effectiveAllAttack, weapon);
    }

    // 7. 执行攻击循环
    const resultLines: string[] = [];
    const killed: string[] = [];
    let totalDamage = 0;
    let totalExp = 0;
    const allDrops: any[] = [];
    let attackCount = 0;

    // 构造攻击者加成数据（合并基础+装备+增益）
    const attackerBonus = this.buildAttackerBonus(player, playerData);

    // 读取并消费玩家"下次攻击"型标记 buff（兰音系 心无所扰/月落寸光/反转童话）
    // 这些标记由 familiar-skills 的 setNextAttackBuff 写入，此处命中时生效一次后清除
    const nextAttack = this.consumeNextAttackBuffs(player);

    // 如果有特效文本，先添加到结果中
    if (effectText) {
      resultLines.push(effectText);
    }

    for (const target of targets) {
      if (target.hp <= 0) continue;

      // 命中判定（应用使魔特效的命中率修正 + 心无所扰必中标记）
      let isHit: boolean;
      if (mustHit) {
        isHit = true;
      } else if (nextAttack.mustHitNext && Math.random() * 100 < (nextAttack.mustHitChance ?? 100)) {
        // 心无所扰：按几率无视闪避和闪避状态必中
        isHit = true;
        resultLines.push('【心无所扰】无视闪避，必定命中！');
      } else {
        const hitRate = this.calcHitRate(attackerBonus, target, false) + hitRateModifier;
        isHit = this.checkHit(hitRate);
      }

      if (!isHit) {
        resultLines.push(`${target.name} 闪避了攻击`);
        continue;
      }

      // 暴击判定
      const isCrit = this.checkCrit(attackerBonus.crit || 0);

      // 伤害随机区间修正（对应原版 伤害下限/上限，受装备特效影响）
      // 超载核心：伤害上限 +0.25；霰弹核心：伤害下限 -0.15；雷火剑(武器特殊序号)：伤害上限 +0.5
      let dmgLower = 0.25;
      let dmgUpper = 0;
      const hasEquip = (name: string): boolean => {
        const eqs = (playerData.equipment as any[]) || [];
        return eqs.some((e: any) => (e.name || '').includes(name));
      };
      if (hasEquip('超载核心')) dmgUpper += 0.25;
      if (hasEquip('霰弹核心')) dmgLower -= 0.15;
      if (weapon.specialSeq === 1001 || weapon.name?.includes('雷火剑')) dmgUpper += 0.5;

      // 伤害计算
      const defenderBonus = this.buildMonsterBonus(target);
      // 应用使魔特效的额外穿透（单层，原版震撼弹等）
      if (extraPenetration > 0) {
        defenderBonus.hpAllRes = (defenderBonus.hpAllRes || 0) - extraPenetration;
      }
      // 月落寸光：按目标三层平均抗性获得穿透增益(2~20)x(1+技能等级/100)%
      // 原版：平均值越高增益越高，分别注入护盾/装甲/生命三层穿透
      if (nextAttack.nextPenetration) {
        const pen = this.calcMoonlightPenetration(defenderBonus, nextAttack.skillLevelForPen || 0);
        defenderBonus.shieldPenetration = (defenderBonus.shieldPenetration || 0) + pen;
        defenderBonus.armorPenetration = (defenderBonus.armorPenetration || 0) + pen;
        defenderBonus.hpPenetration = (defenderBonus.hpPenetration || 0) + pen;
        resultLines.push(`【月落寸光】获得 ${pen.toFixed(1)}% 三层穿透`);
      }
      const damageResult = this.calcDamage(
        attackerBonus,
        defenderBonus,
        weapon,
        weapon.damageType || CombatSystemService.DMG_PHYS,
        isCrit,
        { dmgLower, dmgUpper },
      );

      // 应用伤害倍率（含使魔特效修改后的倍率）
      let finalDamage = Math.floor(damageResult.damage * effectiveDamageMultiplier / 100);
      if (finalDamage < 1 && isHit) finalDamage = 1; // 保底1点伤害
      totalDamage += finalDamage;

      // 扣除怪物血量（三池分伤）
      const appliedDamage = this.applyDamageToMonster(target, finalDamage, damageResult.poolDamage);

      // 反转童话：命中后按几率将目标某个属性正负符号反转（持续一定时间）
      if (nextAttack.reverseResist && Math.random() * 100 < (nextAttack.reverseChance ?? 0)) {
        this.reverseMonsterResistance(target, nextAttack.reverseDuration || 600);
        resultLines.push(`【反转童话】${target.name}的某个属性抗性被反转了！`);
      }

      // 构建攻击文本
      const atkText = attackText || this.getAttackText(weapon, weapon.damageType);
      const critText = isCrit ? '【暴击】' : '';
      const dmgText = this.formatDamageText(finalDamage, damageResult.poolDamage);
      resultLines.push(`${atkText} ${target.name}，造成 ${dmgText}${critText}`);

      attackCount++;

      // 处理击杀
      if (target.hp <= 0) {
        killed.push(target.name);
        resultLines.push(`${target.name} 已被击杀`);

        // 处理怪物死亡
        const deathResult = await this.handleMonsterDeath(target, userId, map.id);
        totalExp += deathResult.expGain;
        allDrops.push(...deathResult.drops);

        if (deathResult.drops.length > 0) {
          resultLines.push(`掉落：${deathResult.drops.map(d => d.name).join('、')}`);
        }
        if (deathResult.expGain > 0) {
          resultLines.push(`获得 ${deathResult.expGain} 点经验`);
        }
      } else {
        // 怪物还活着，更新地图数据库中的血量
        await this.updateMonsterHpInMap(map.id, target);
      }

      // 生命偷取处理
      if (attackerBonus.leechHp && finalDamage > 0) {
        const leechAmount = this.calcLeech(finalDamage, attackerBonus.leechHp);
        if (leechAmount > 0) {
          player.hp = Math.min(
            (player.hp || 0) + leechAmount,
            player.maxHp || 100,
          );
          resultLines.push(`生命偷取 ${leechAmount} 点`);
        }
      }
    }

    // 8. 保存玩家状态（血量变化）
    await this.playerService.savePlayer(player);

    // 9. 添加经验到玩家
    if (totalExp > 0) {
      await this.playerService.addExp(userId, totalExp);
    }

    return {
      result: resultLines.join('\n'),
      killed,
      damageDealt: totalDamage,
      expGained: totalExp,
      drops: allDrops,
    };
  }

  /**
   * 炮击 - 载具炮台攻击
   * 对应原版：炮击()
   * 使用载具的炮台攻击当前地图上的所有怪物
   */
  async cannonAttack(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查是否驾驶载具
    if (!player.vehicle) {
      return '你没有驾驶任何载具，无法使用炮击！';
    }

    // 获取地图
    const map = await this.prisma.gameMap.findUnique({
      where: { id: player.mapId },
    });
    if (!map) return '你不在任何地图上！';

    // 获取地图怪物
    const monsters = this.mapService.getMapMonsters(map);
    if (monsters.length === 0) {
      return '当前地图没有目标可以炮击';
    }

    // 简化版炮击：对所有怪物造成基于载具的攻击
    let totalDamage = 0;
    const killed: string[] = [];
    const lines: string[] = [];

    for (const monster of monsters) {
      if (monster.hp <= 0) continue;

      // 炮击基础伤害（载具攻击力 + 玩家攻击力）
      const baseDamage = (player.attack || 10) * 3;
      const damage = Math.max(1, baseDamage - (monster.defense || 0));

      monster.hp = Math.max(0, monster.hp - damage);
      totalDamage += damage;
      lines.push(`炮击命中 ${monster.name}，造成 ${damage} 点伤害`);

      if (monster.hp <= 0) {
        killed.push(monster.name);
        const deathResult = await this.handleMonsterDeath(monster, userId, map.id);
        lines.push(`${monster.name} 被摧毁了！获得 ${deathResult.expGain} 点经验`);
        if (deathResult.drops.length > 0) {
          lines.push(`掉落：${deathResult.drops.map(d => d.name).join('、')}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * 计算单次伤害
   * 对应原版 造成伤害() 子程序的核心计算逻辑
   *
   * 伤害公式：
   *   总伤害 = Σ(各属性伤害 × 武器属性系数 × 暴击倍率 × 随机修正)
   *   各属性伤害经过对应抗性减免后，分配到三池（护盾→装甲→生命）
   *
   * @param atkBonus 攻击方加成数据
   * @param defBonus 防御方加成数据
   * @param weapon 武器数据
   * @param damageType 伤害类型（物理/火焰/冰霜/雷电）
   * @param isCrit 是否暴击
   * @param opts 可选伤害修正：dmgLower/dmgUpper 对应原版 伤害下限/伤害上限（受霰弹核心/雷火剑/超载核心影响）
   */
  calcDamage(
    atkBonus: BonusData,
    defBonus: BonusData,
    weapon: WeaponData,
    damageType: number,
    isCrit: boolean,
    opts?: { dmgLower?: number; dmgUpper?: number },
  ): DamageResult {
    // 1. 计算基础攻击力 = 攻击力 + 武器伤害 + 元素伤害
    const baseAttack = (atkBonus.attack || 0) + (atkBonus.attack2 || 0) + (weapon.damage || 0);

    // 2. 各属性伤害 = 基础攻击力 × 武器属性系数
    const weaponProps = weapon.properties || { phys: 100, fire: 0, ice: 0, elec: 0 };
    const rawBreakdown: DamageBreakdown = {
      physical: baseAttack * weaponProps.phys / 100 + (atkBonus.physDmg || 0) + (atkBonus.physDmg2 || 0),
      fire: baseAttack * weaponProps.fire / 100 + (atkBonus.fireDmg || 0) + (atkBonus.fireDmg2 || 0),
      ice: baseAttack * weaponProps.ice / 100 + (atkBonus.iceDmg || 0) + (atkBonus.iceDmg2 || 0),
      elec: baseAttack * weaponProps.elec / 100 + (atkBonus.elecDmg || 0) + (atkBonus.elecDmg2 || 0),
    };

    // 3. 暴击倍率（对应原版 暴击倍率 = 暴击倍率 × 攻击方.属性.暴击伤害/100，暴击伤害默认150%即1.5倍）
    let critMultiplier = 1.0;
    if (isCrit) {
      critMultiplier = (atkBonus.critDmg || 150) / 100;
    }

    // 4. 命中/闪避比率（影响伤害倍率，对应原版 暴击倍率 = 命中/闪避）
    const hitRate = (atkBonus.hit || 0) + (atkBonus.hit2 || 0) || 100;
    const dodgeRate = (defBonus.dodge || 0) + (defBonus.dodge2 || 0) || 1;
    const hitRatio = Math.max(0.01, hitRate / Math.max(1, dodgeRate));

    // 5. 随机修正（对应原版取随机数，范围 伤害下限~1+伤害上限）
    // 原版默认 伤害下限=0.25；装备特效：霰弹核心 下限-0.15、超载核心 上限+0.25、雷火剑 上限+0.5
    const dmgLower = opts?.dmgLower ?? 0.25;  // 基础下限
    const dmgUpper = opts?.dmgUpper ?? 0;     // 基础上限
    const randomFactor = dmgLower + Math.random() * (1 + dmgUpper - dmgLower);

    // 6. 穿透计算（三层池独立穿透）
    const penetration = this.getPenetration(atkBonus);

    // 7. 等级差距修正（原版：剩余伤害 = 剩余伤害 / (1 - 攻击方.差距) * (1 - 防御方.差距)）
    // 此处攻击方差距 gap 为正表示"攻击方等级低于目标"，应降低伤害 → 用 1/(1-gap) 放大分母实现降伤
    const levelGap = (atkBonus.gap || 0);
    const levelFactor = levelGap >= 1 ? 0.1 : Math.max(0.1, 1 / (1 - levelGap));

    // 8. 易伤加成
    const vulnerability = (defBonus.debuff || 0) / 100 + 1;

    // 9. 应用所有修正，计算各属性最终伤害
    const finalBreakdown: DamageBreakdown = {
      physical: rawBreakdown.physical * critMultiplier * hitRatio * randomFactor * levelFactor * vulnerability,
      fire: rawBreakdown.fire * critMultiplier * hitRatio * randomFactor * levelFactor * vulnerability,
      ice: rawBreakdown.ice * critMultiplier * hitRatio * randomFactor * levelFactor * vulnerability,
      elec: rawBreakdown.elec * critMultiplier * hitRatio * randomFactor * levelFactor * vulnerability,
    };

    // 10. 三层池独立抗性减免（护盾/装甲/生命各自抗穿）
    const resistBreakdown = this.applyResistances(finalBreakdown, defBonus, penetration);

    // 11. 三池串行分伤（破盾溢出打装甲，破甲溢出打生命）
    const poolDamage = this.distributeDamageToPools(resistBreakdown, atkBonus, defBonus);

    // 12. 总伤害
    const totalDamage = poolDamage.shield + poolDamage.armor + poolDamage.hp;

    return {
      damage: Math.max(0, Math.floor(totalDamage)),
      isHit: true,
      isCrit,
      hitRate: hitRate / Math.max(1, dodgeRate) * 100,
      damageBreakdown: finalBreakdown,
      poolDamage,
      critMultiplier,
    };
  }

  /**
   * 命中判定
   * 对应原版：a1 = 攻击方.命中/(1-差距)/防御方.闪避；几率判断(a1×100 - 固定闪避 + 最终命中)
   * hitRate 入参已是百分比（由 calcHitRate 计算：atkHit/defDodge*100 + 特效修正），
   * 钳制 [5,95] 后做随机判定。
   */
  checkHit(hitRate: number, dodgeRate: number = 0): boolean {
    const effectiveHitRate = Math.max(5, Math.min(95, hitRate - (dodgeRate || 0)));
    return Math.random() * 100 < effectiveHitRate;
  }

  /**
   * 计算实际命中率
   * 对应原版：a1 = 攻击方.属性.命中 / 防御方.属性.闪避
   * 返回百分比值（0-100）
   */
  calcHitRate(attacker: BonusData, defender: any, mustHit: boolean = false): number {
    if (mustHit) return 100;
    const atkHit = (attacker.hit || 0) + (attacker.hit2 || 0) || 100;
    const defDodge = (defender.dodge || 0) + (defender.dodge2 || 0) || 1;

    if (defDodge < 1) {
      return Math.min(95, atkHit);
    }
    return Math.min(95, Math.max(5, atkHit / defDodge * 100));
  }

  /**
   * 暴击判定
   * 对应原版暴击率判断
   */
  checkCrit(critRate: number): boolean {
    const effectiveCritRate = Math.max(0, Math.min(100, critRate));
    return Math.random() * 100 < effectiveCritRate;
  }

  /**
   * 获取武器攻击文本
   * 对应原版：显示攻击文本()
   * 根据武器信息和伤害类型返回对应的攻击描述
   */
  getAttackText(weapon: WeaponData, damageType: number): string {
    if (!weapon) return '拳头攻击';

    // 如果武器有自定义攻击文本，优先使用
    if (weapon.attackText) return weapon.attackText;

    // 如果武器有攻击文本列表
    if (weapon.attackTexts && weapon.attackTexts.length > 0) {
      const idx = Math.floor(Math.random() * weapon.attackTexts.length);
      return weapon.attackTexts[idx];
    }

    // 根据伤害类型返回默认文本
    const attackTexts: Record<number, string> = {
      [CombatSystemService.DMG_PHYS]: '物理攻击',
      [CombatSystemService.DMG_FIRE]: '火焰攻击',
      [CombatSystemService.DMG_ICE]: '冰霜攻击',
      [CombatSystemService.DMG_ELEC]: '雷电攻击',
    };

    const weaponName = weapon.name || '武器';
    return `${weaponName}${attackTexts[damageType] || ''}`;
  }

  /**
   * 处理怪物死亡
   * 对应原版：怪物死亡后的掉落生成、经验分配、地图更新
   */
  async handleMonsterDeath(
    monster: any,
    userId: number,
    mapId: number,
  ): Promise<MonsterDeathResult> {
    // 计算经验值
    const expGain = this.calcMonsterExp(monster);

    // 生成掉落物
    const drops = this.generateDrops(monster, 1);

    // 从地图移除怪物
    try {
      const map = await this.prisma.gameMap.findUnique({ where: { id: mapId } });
      if (map) {
        this.mapService.removeMapMonster(map, monster.id);
        await this.prisma.gameMap.update({
          where: { id: mapId },
          data: {
            spawnMonsters: map.spawnMonsters,
            tempMonsters: map.tempMonsters,
          },
        });
      }
    } catch (error) {
      this.logger.warn(`从地图移除怪物失败: ${error.message}`);
    }

    // 将掉落物添加到玩家背包
    for (const drop of drops) {
      await this.playerService.addToBackpack(userId, drop.name, drop.quantity || 1);
    }

    return { expGain, drops };
  }

  /**
   * 生成怪物掉落
   * 对应原版掉落生成逻辑
   * 根据怪物配置的掉落表判定每个掉落项是否触发
   */
  generateDrops(monster: any, dropMultiplier: number): any[] {
    const drops: any[] = [];

    // 如果没有掉落表，使用默认掉落
    const dropTable = monster.dropTable || [];
    if (dropTable.length === 0) {
      // 基础掉落：根据怪物等级给一些基础材料
      if (Math.random() < 0.3 * dropMultiplier) {
        drops.push({
          name: '怪物材料',
          quantity: Math.floor(monster.level || 1) + 1,
        });
      }
      return drops;
    }

    // 根据掉落率判定每个掉落项
    for (const dropEntry of dropTable) {
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
   * 计算怪物经验
   * 对应原版经验计算
   * 公式：基础经验 × (1 + (等级-1) × 0.1)
   */
  calcMonsterExp(monster: any): number {
    const baseExp = monster.exp || monster.baseExp || 10;
    const level = monster.level || 1;
    return Math.floor(baseExp * (1 + (level - 1) * 0.1));
  }

  /**
   * 处理特殊装备特效
   * 对应原版200+种特殊装备效果
   * 这是一个框架方法，根据武器特殊序号和攻防双方状态触发特效
   */
  processSpecialEffects(
    attacker: any,
    defender: any,
    weapon: WeaponData,
    damage: number,
    damageType: number,
  ): SpecialEffectResult {
    const result: SpecialEffectResult = {
      bonusDmg: 0,
      effectText: '',
      extraBuffs: [],
      hitRateModifier: 0,
      damageMultiplier: 1.0,
      extraPenetration: 0,
    };

    // 根据武器特效序号触发不同效果
    switch (weapon.specialEffect) {
      case 45: // 斩首 - 目标状态低于30%时伤害×1.5
        if (defender) {
          const totalCurrent = (defender.hp || 0) + (defender.shield || 0) + (defender.armor || 0);
          const totalMax = (defender.maxHp || 100) + (defender.maxShield || 0) + (defender.maxArmor || 0);
          if (totalMax > 0 && totalCurrent / totalMax < 0.3) {
            result.damageMultiplier = 1.5;
            result.effectText = '【斩首】';
          }
        }
        break;

      case 44: // 尖兵 - 目标状态高于90%时伤害×1.5
        if (defender) {
          const totalCurrent = (defender.hp || 0) + (defender.shield || 0) + (defender.armor || 0);
          const totalMax = (defender.maxHp || 100) + (defender.maxShield || 0) + (defender.maxArmor || 0);
          if (totalMax > 0 && totalCurrent / totalMax >= 0.9) {
            result.damageMultiplier = 1.5;
            result.effectText = '【尖兵】';
          }
        }
        break;

      case 47: // 因果逆转 - 固定命中率+20%
        result.hitRateModifier = 20;
        result.effectText = '【因果逆转】';
        break;

      case 26: // 如梦似幻 - 60%概率伤害×2，40%概率伤害为0
        if (Math.random() < 0.6) {
          result.damageMultiplier = 2.0;
          result.effectText = '【如梦似幻+】';
        } else {
          result.damageMultiplier = 0;
          result.effectText = '【如梦似幻-】';
        }
        break;

      // 武器特殊序号特效
      default:
        if (weapon.specialSeq) {
          // 根据specialSeq触发对应使魔/武器特效
          // 此处为框架预留，具体特效由上层业务逻辑实现
          if (weapon.specialSeq === 1001) { // 示例：雷火剑 - 伤害上限+50%
            result.damageMultiplier = 1.5;
            result.effectText = '【雷火剑】';
          }
        }
        break;
    }

    return result;
  }

  /**
   * 计算生命偷取
   * 对应原版生命偷取逻辑
   */
  calcLeech(damage: number, leechRate: number): number {
    if (leechRate <= 0 || damage <= 0) return 0;
    return Math.floor(damage * leechRate / 100);
  }

  // ==================== 私有辅助方法 ====================

  /**
   * 获取武器数据
   * 根据攻击者背包中的武器索引获取武器信息
   * 索引0代表拳头（无武器）
   * 对应原版：z1 = 攻击方.武器[武器]
   */
  private getWeaponData(attacker: any, weaponIndex: number): WeaponData {
    if (weaponIndex === 0) {
      return {
        name: '拳头',
        damage: 1,
        damageType: CombatSystemService.DMG_PHYS,
        attackText: '拳头攻击',
        type: '近战武器',
        properties: { phys: 100, fire: 0, ice: 0, elec: 0 },
        cooldown: 5,
      };
    }

    // 从攻击者装备或背包中获取武器
    const weapons = attacker.weapons || attacker.equipment || [];
    const rawWeapon = weapons[weaponIndex - 1];
    if (!rawWeapon) {
      return {
        name: '拳头',
        damage: 1,
        damageType: CombatSystemService.DMG_PHYS,
        type: '近战武器',
        properties: { phys: 100, fire: 0, ice: 0, elec: 0 },
      };
    }

    // 解析武器属性
    const properties = rawWeapon.properties || rawWeapon.属性 || { phys: 100, fire: 0, ice: 0, elec: 0 };

    return {
      name: rawWeapon.name || '未知武器',
      damage: rawWeapon.damage || rawWeapon.伤害 || 0,
      damageType: this.resolveDamageType(rawWeapon.damageType || rawWeapon.伤害类型 || '物理'),
      attackText: rawWeapon.attackText || rawWeapon.攻击文本 || '',
      type: rawWeapon.type || rawWeapon.类型 || '近战武器',
      specialSeq: rawWeapon.specialSeq || rawWeapon.特殊序号 || 0,
      cooldown: rawWeapon.cooldown || rawWeapon.冷却 || 5,
      lockTime: rawWeapon.lockTime || rawWeapon.锁定 || 0,
      forcedEffect: rawWeapon.forcedEffect || rawWeapon.必出特效 || false,
      vehicleForceDmg: rawWeapon.vehicleForceDmg || rawWeapon.无视载具 || false,
      properties: {
        phys: properties.phys || properties.物 || 100,
        fire: properties.fire || properties.火 || 0,
        ice: properties.ice || properties.冰 || 0,
        elec: properties.elec || properties.电 || 0,
      },
      bonus: rawWeapon.bonus || rawWeapon.加成 || {},
      baseBonus: rawWeapon.baseBonus || rawWeapon.基础加成 || {},
      attackTexts: rawWeapon.attackTexts || rawWeapon.攻击文本列表 || [],
      buffs: rawWeapon.buffs || rawWeapon.增益 || [],
      negativeType: rawWeapon.negativeType || rawWeapon.负面类型 || 0,
      specialEffect: rawWeapon.specialEffect || rawWeapon.特效 || 0,
    };
  }

  /**
   * 解析伤害类型字符串为数字常量
   */
  private resolveDamageType(type: string | number): number {
    if (typeof type === 'number') return type;
    const map: Record<string, number> = {
      '物理': CombatSystemService.DMG_PHYS,
      '火焰': CombatSystemService.DMG_FIRE,
      '冰霜': CombatSystemService.DMG_ICE,
      '雷电': CombatSystemService.DMG_ELEC,
    };
    return map[type] || CombatSystemService.DMG_PHYS;
  }

  /**
   * 选择攻击目标
   * 对应原版目标选择逻辑
   * 非全体攻击时随机选择一个活着的怪物
   * 全体攻击时选择所有活着的怪物
   */
  private selectTargets(
    monsters: any[],
    player: any,
    allAttack: boolean,
    weapon: WeaponData,
  ): any[] {
    const alive = monsters.filter(m => (m.hp || 0) > 0);

    if (alive.length === 0) return [];

    if (allAttack) {
      return alive;
    }

    // 非全体攻击：随机选一个目标
    const targetIdx = Math.floor(Math.random() * alive.length);
    return [alive[targetIdx]];
  }

  /**
   * 构建攻击者加成数据
   * 合并玩家基础属性、装备加成、增益等
   */
  private buildAttackerBonus(player: any, playerData: PlayerData): BonusData {
    // 从玩家基础属性构建
    const bonus: BonusData = {
      attack: player.attack || 0,
      attack2: 0,
      hit: player.hit || 100,
      hit2: 0,
      dodge: player.dodge || 0,
      dodge2: 0,
      crit: player.crit || 5,
      critDmg: player.critDmg || 150,  // 暴击伤害默认150%（原版）
      hp: player.hp || 0,
      shield: player.shield || 0,
      armor: player.armor || 0,
      physDmg: 0,
      physDmg2: 0,
      fireDmg: 0,
      fireDmg2: 0,
      iceDmg: 0,
      iceDmg2: 0,
      elecDmg: 0,
      elecDmg2: 0,
      leechHp: 0,
      penetrate: 0,
      hpPenetration: 0,
      shieldPenetration: 0,
      armorPenetration: 0,
      gap: 0,
      debuff: 0,
    };

    // 尝试合并装备加成
    try {
      if (playerData.equipment && playerData.equipment.length > 0) {
        for (const equip of playerData.equipment) {
          if (equip.bonus) {
            Object.assign(bonus, this.bonusService.mergeBonus(bonus, equip.bonus));
          }
        }
      }
    } catch {
      // 忽略装备解析错误
    }

    // 应用递减收益
    this.bonusService.applyAllDiminishingReturns(bonus);

    return bonus;
  }

  /**
   * 构建怪物加成数据
   */
  private buildMonsterBonus(monster: any): BonusData {
    // 怪物三层抗性存于 bonus JSON（seed 解析进 GameMonster.bonus），需解析后读取
    let mb: any = {};
    try {
      mb = typeof monster.bonus === 'string' ? JSON.parse(monster.bonus || '{}') : (monster.bonus || {});
    } catch {
      mb = {};
    }
    // 读取辅助：优先顶层字段，回退到 bonus JSON
    const pick = (k: string) => (monster[k] !== undefined ? monster[k] : (mb[k] || 0));

    return {
      attack: monster.attack || 0,
      hit: monster.hit || 85,
      dodge: monster.dodge || 5,
      hp: monster.hp || 0,
      shield: (monster.shield !== undefined ? monster.shield : (monster.maxShield || 0)),
      armor: (monster.armor !== undefined ? monster.armor : (monster.maxArmor || 0)),
      // 三层池抗性（原版护盾/装甲/生命各自独立），来自 bonus JSON
      shieldPhysRes: pick('shieldPhysRes'),
      shieldFireRes: pick('shieldFireRes'),
      shieldIceRes: pick('shieldIceRes'),
      shieldElecRes: pick('shieldElecRes'),
      shieldAllRes: pick('shieldAllRes'),
      armorPhysRes: pick('armorPhysRes'),
      armorFireRes: pick('armorFireRes'),
      armorIceRes: pick('armorIceRes'),
      armorElecRes: pick('armorElecRes'),
      armorAllRes: pick('armorAllRes'),
      hpPhysRes: pick('hpPhysRes'),
      hpFireRes: pick('hpFireRes'),
      hpIceRes: pick('hpIceRes'),
      hpElecRes: pick('hpElecRes'),
      hpAllRes: pick('hpAllRes'),
      shieldDmgCap: pick('shieldDmgCap') || 100,
      armorDmgCap: pick('armorDmgCap') || 100,
      hpDmgCap: monster.hpDmgCap || 100,
    };
  }

  /**
   * 三层池穿透结构
   * 对应原版：攻击方.属性.护盾穿透 / 装甲穿透 / 生命穿透
   */
  private getPenetration(bonus: BonusData): {
    shield: number;  // 护盾穿透
    armor: number;   // 装甲穿透
    life: number;    // 生命穿透
  } {
    // 注：bonus.penetrate 为原版"贯穿几率"，不计入抗性穿透，三层穿透各自独立
    return {
      shield: bonus.shieldPenetration || 0,
      armor: bonus.armorPenetration || 0,
      life: bonus.hpPenetration || 0,
    };
  }

  /**
   * 单层池抗性减免计算
   * 对应原版（以护盾层为例，攻击目标() 子程序）：
   *   造成物伤 = 剩余物伤 * (1 - 防御方.护盾物抗/100 * (1 - (攻击方.护盾穿透 + 盾穿.物)/100))
   * 三层池各自独立使用自己的抗性与穿透，互不干扰
   *
   * @param breakdown 该层池入场前的四属性伤害
   * @param resPrefix 抗性字段前缀：'shield' | 'armor' | 'life'
   * @param allRes 该层全抗
   * @param pen 该层穿透值
   */
  private applyLayerResistances(
    breakdown: DamageBreakdown,
    defBonus: BonusData,
    resPrefix: 'shield' | 'armor' | 'life',
    allRes: number,
    pen: number,
  ): DamageBreakdown {
    const physRes = Math.max(0, (defBonus[`${resPrefix}PhysRes` as keyof BonusData] as number || 0) + allRes - pen);
    const fireRes = Math.max(0, (defBonus[`${resPrefix}FireRes` as keyof BonusData] as number || 0) + allRes - pen);
    const iceRes = Math.max(0, (defBonus[`${resPrefix}IceRes` as keyof BonusData] as number || 0) + allRes - pen);
    const elecRes = Math.max(0, (defBonus[`${resPrefix}ElecRes` as keyof BonusData] as number || 0) + allRes - pen);

    return {
      physical: breakdown.physical * (1 - physRes / 100),
      fire: breakdown.fire * (1 - fireRes / 100),
      ice: breakdown.ice * (1 - iceRes / 100),
      elec: breakdown.elec * (1 - elecRes / 100),
    };
  }

  /**
   * 应用各属性抗性减免（三层池串行模型入口）
   * 对应原版 攻击目标() 子程序：先算护盾层（含护盾抗+护盾穿透），
   * 溢出按比例转入装甲层（含装甲抗+装甲穿透），再溢出转入生命层。
   * 返回三层池各自"实际可造成"的伤害（已抗减、未扣当前池血量）。
   */
  private applyResistances(
    breakdown: DamageBreakdown,
    defBonus: BonusData,
    penetration: { shield: number; armor: number; life: number },
  ): { shield: DamageBreakdown; armor: DamageBreakdown; life: DamageBreakdown } {
    const shieldResisted = this.applyLayerResistances(
      breakdown, defBonus, 'shield', defBonus.shieldAllRes || 0, penetration.shield,
    );
    const armorResisted = this.applyLayerResistances(
      breakdown, defBonus, 'armor', defBonus.armorAllRes || 0, penetration.armor,
    );
    const lifeResisted = this.applyLayerResistances(
      breakdown, defBonus, 'life', defBonus.hpAllRes || 0, penetration.life,
    );

    return { shield: shieldResisted, armor: armorResisted, life: lifeResisted };
  }

  /**
   * 三池串行分伤（对应原版 攻击目标() 子程序）
   * 护盾层先吃满（含攻击护盾加伤），溢出部分按比例缩放剩余四属性伤害转入装甲层；
   * 装甲层同理，溢出转入生命层。三层各自独立抗性已在 applyResistances 处理。
   *
   * @param resisted 三层池各自已抗减的四属性伤害
   * @param atkBonus 攻击方加成（取 atkShield/atkArmor/atkHp 分池加伤）
   * @param defBonus 防御方加成（取当前护盾/装甲/生命值与伤害上限）
   */
  private distributeDamageToPools(
    resisted: { shield: DamageBreakdown; armor: DamageBreakdown; life: DamageBreakdown },
    atkBonus: BonusData,
    defBonus: BonusData,
  ): PoolDamage {
    const sum = (b: DamageBreakdown) => b.physical + b.fire + b.ice + b.elec;
    const scale = (b: DamageBreakdown, r: number): DamageBreakdown => ({
      physical: b.physical * r, fire: b.fire * r, ice: b.ice * r, elec: b.elec * r,
    });

    // 各池当前血量
    const currentShield = defBonus.shield || 0;
    const currentArmor = defBonus.armor || 0;
    const currentHp = defBonus.hp || 0;

    const pool: PoolDamage = { shield: 0, armor: 0, hp: 0 };

    // 单一"剩余四属性伤害"流转（对应原版 剩余物伤/火伤/冰伤/电伤 逐步缩放）
    // 三层共用同一份剩余伤害：每层先按本层抗穿算本层伤害，破层后缩放剩余伤害再入下一层
    let remaining: DamageBreakdown = {
      physical: resisted.shield.physical,
      fire: resisted.shield.fire,
      ice: resisted.shield.ice,
      elec: resisted.shield.elec,
    };

    // ---- 第一层：护盾 ----
    // resisted.shield 已是"完整 breakdown 经护盾层抗减"的结果；原版护盾层伤害 = Σ×(1+攻击护盾/100)
    const shieldDmgRaw = sum(resisted.shield) * (1 + (atkBonus.atkShield || 0) / 100);
    if (shieldDmgRaw > 0) {
      pool.shield = Math.min(shieldDmgRaw, currentShield);
      // 溢出比例（原版 剩余伤害 = (伤害 - 当前护盾) / 伤害），缩放"原始剩余四属性伤害"
      const overflowRatio = shieldDmgRaw > currentShield
        ? (shieldDmgRaw - currentShield) / shieldDmgRaw
        : 0;
      remaining = scale(remaining, overflowRatio);
    } else {
      remaining = { physical: 0, fire: 0, ice: 0, elec: 0 };
    }

    // ---- 第二层：装甲（承接护盾溢出后，对剩余伤害做装甲层抗减）----
    // 用 resisted.armor 相对 resisted.shield 的抗减比例，应用到 remaining（同一份剩余伤害）
    const armorLayer: DamageBreakdown = {
      physical: remaining.physical * (sum(resisted.armor) > 0 ? resisted.armor.physical / (resisted.shield.physical || 1) : 0),
      fire: remaining.fire * (sum(resisted.armor) > 0 ? resisted.armor.fire / (resisted.shield.fire || 1) : 0),
      ice: remaining.ice * (sum(resisted.armor) > 0 ? resisted.armor.ice / (resisted.shield.ice || 1) : 0),
      elec: remaining.elec * (sum(resisted.armor) > 0 ? resisted.armor.elec / (resisted.shield.elec || 1) : 0),
    };
    const armorDmgRaw = sum(armorLayer) * (1 + (atkBonus.atkArmor || 0) / 100);
    if (armorDmgRaw > 0) {
      pool.armor = Math.min(armorDmgRaw, currentArmor);
      const overflowRatio = armorDmgRaw > currentArmor
        ? (armorDmgRaw - currentArmor) / armorDmgRaw
        : 0;
      remaining = scale(remaining, overflowRatio);
    } else {
      remaining = { physical: 0, fire: 0, ice: 0, elec: 0 };
    }

    // ---- 第三层：生命（承接装甲溢出后，对剩余伤害做生命层抗减，最底层不再溢出）----
    const lifeLayer: DamageBreakdown = {
      physical: remaining.physical * (sum(resisted.life) > 0 ? resisted.life.physical / (resisted.shield.physical || 1) : 0),
      fire: remaining.fire * (sum(resisted.life) > 0 ? resisted.life.fire / (resisted.shield.fire || 1) : 0),
      ice: remaining.ice * (sum(resisted.life) > 0 ? resisted.life.ice / (resisted.shield.ice || 1) : 0),
      elec: remaining.elec * (sum(resisted.life) > 0 ? resisted.life.elec / (resisted.shield.elec || 1) : 0),
    };
    const hpDmgRaw = sum(lifeLayer) * (1 + (atkBonus.atkHp || 0) / 100);
    if (hpDmgRaw > 0) {
      // 生命为最底层：扣 min(伤害, 当前生命)，溢出（伤害>生命）即击杀，不再传递
      pool.hp = Math.min(hpDmgRaw, currentHp);
    }

    return pool;
  }

  /**
   * 对怪物应用伤害（三池扣血）
   * 更新怪物对象的hp/shield/armor字段
   */
  private applyDamageToMonster(
    monster: any,
    totalDamage: number,
    poolDamage: PoolDamage,
  ): PoolDamage {
    // 实际扣减
    const shieldDmg = Math.min(poolDamage.shield, monster.shield || monster.maxShield || 0);
    const armorDmg = Math.min(poolDamage.armor, monster.armor || monster.maxArmor || 0);
    const hpDmg = Math.min(poolDamage.hp, monster.hp || 0);

    // 更新怪物状态
    if (monster.shield !== undefined) {
      monster.shield = Math.max(0, (monster.shield || 0) - shieldDmg);
    }
    if (monster.armor !== undefined) {
      monster.armor = Math.max(0, (monster.armor || 0) - armorDmg);
    }
    monster.hp = Math.max(0, (monster.hp || 0) - hpDmg);

    return { shield: shieldDmg, armor: armorDmg, hp: hpDmg };
  }

  /**
   * 更新地图数据库中怪物的血量
   */
  private async updateMonsterHpInMap(mapId: number, monster: any): Promise<void> {
    try {
      const map = await this.prisma.gameMap.findUnique({ where: { id: mapId } });
      if (!map) return;

      const spawnMonsters = JSON.parse(map.spawnMonsters || '[]');
      const idx = spawnMonsters.findIndex((m: any) => m.id === monster.id);
      if (idx !== -1) {
        spawnMonsters[idx].hp = monster.hp;
        if (monster.shield !== undefined) spawnMonsters[idx].shield = monster.shield;
        if (monster.armor !== undefined) spawnMonsters[idx].armor = monster.armor;
        await this.prisma.gameMap.update({
          where: { id: mapId },
          data: { spawnMonsters: JSON.stringify(spawnMonsters) },
        });
      }
    } catch (error) {
      this.logger.warn(`更新怪物血量失败: ${error.message}`);
    }
  }

  /**
   * 格式化伤害文本
   * 显示三池各扣了多少
   */
  private formatDamageText(totalDamage: number, poolDamage: PoolDamage): string {
    const parts: string[] = [];
    if (poolDamage.shield > 0) parts.push(`护盾-${Math.floor(poolDamage.shield)}`);
    if (poolDamage.armor > 0) parts.push(`装甲-${Math.floor(poolDamage.armor)}`);
    if (poolDamage.hp > 0) parts.push(`生命-${Math.floor(poolDamage.hp)}`);
    return parts.join(' ') || `${Math.floor(totalDamage)}`;
  }

  /**
   * 安全解析 JSON 字符串
   * 解析失败时返回默认值，避免字段缺失导致异常。
   * @param v 待解析值（可能为字符串或已解析对象）
   * @param def 默认值
   * @returns 解析结果或默认值
   */
  private safeParseJson<T>(v: any, def: T): T {
    try {
      if (typeof v !== 'string') return (v as T) ?? def;
      return JSON.parse(v) as T;
    } catch {
      return def;
    }
  }

  /**
   * 读取并消费玩家的"下次攻击"型标记 buff（兰音系）
   * 对应原版 心无所扰(必中)/月落寸光(穿透蓄势)/反转童话(反转属性) 的一次性标记。
   * 调用后从玩家 buffs 中移除这些 onceAttack 标记，避免重复生效。
   * @param player 玩家对象（buff字段会被就地修改）
   * @returns 聚合后的下次攻击标记数据
   */
  private consumeNextAttackBuffs(player: any): {
    mustHitNext: boolean;
    mustHitChance: number;
    nextPenetration: boolean;
    skillLevelForPen: number;
    reverseResist: boolean;
    reverseChance: number;
    reverseDuration: number;
  } {
    const result = {
      mustHitNext: false,
      mustHitChance: 100,
      nextPenetration: false,
      skillLevelForPen: 0,
      reverseResist: false,
      reverseChance: 0,
      reverseDuration: 600,
    };
    const buffs: any[] = this.safeParseJson(player.buffs, []);
    const remain: any[] = [];
    for (const b of buffs) {
      if (b.onceAttack) {
        // 聚合标记数据
        if (b.mustHitNext) {
          result.mustHitNext = true;
          result.mustHitChance = b.mustHitChance ?? 100;
        }
        if (b.nextPenetration) {
          result.nextPenetration = true;
          result.skillLevelForPen = b.skillLevelForPen || 0;
        }
        if (b.reverseResist) {
          result.reverseResist = true;
          result.reverseChance = b.reverseChance ?? 0;
          result.reverseDuration = b.reverseDuration ?? 600;
        }
        // 消费：不保留该 buff
        continue;
      }
      remain.push(b);
    }
    player.buffs = JSON.stringify(remain);
    return result;
  }

  /**
   * 计算月落寸光穿透值
   * 对应原版 月落寸光子程序：输入目标平均抗性，返回 (2~20) x (1+技能等级/100)% 的穿透值。
   * 平均抗性分档：<10→2, <20→4, <30→6, <40→8, <50→10, <60→12, <70→14, <80→16, <90→18, ≥90→20。
   * @param defBonus 怪物三层抗性加成
   * @param skillLevel 兰音技能等级
   * @returns 穿透百分比（已含技能等级系数）
   */
  private calcMoonlightPenetration(defBonus: BonusData, skillLevel: number): number {
    const avgRes =
      ((defBonus.shieldPhysRes || 0) + (defBonus.armorPhysRes || 0) + (defBonus.hpPhysRes || 0)) / 3;
    let base: number;
    if (avgRes < 10) base = 2;
    else if (avgRes < 20) base = 4;
    else if (avgRes < 30) base = 6;
    else if (avgRes < 40) base = 8;
    else if (avgRes < 50) base = 10;
    else if (avgRes < 60) base = 12;
    else if (avgRes < 70) base = 14;
    else if (avgRes < 80) base = 16;
    else if (avgRes < 90) base = 18;
    else base = 20;
    return base * (1 + skillLevel / 100);
  }

  /**
   * 反转童话：反转怪物某项抗性的正负号
   * 对应原版 反转童话 子程序：按 fzth1/fzth2 标记反转目标的护盾/装甲/生命某属性抗性符号。
   * 这里随机挑选一项大于0的抗性将其变为负值，并写入怪物 buffs 让后续攻击享用反转后的抗性。
   * @param monster 怪物对象（bonus/抗性将就地反转）
   * @param duration 反转持续时间（秒）
   */
  private reverseMonsterResistance(monster: any, duration: number): void {
    const bonus = this.safeParseJson(monster.bonus, {});
    const resistKeys = [
      'shieldPhysRes', 'shieldFireRes', 'shieldIceRes', 'shieldElecRes',
      'armorPhysRes', 'armorFireRes', 'armorIceRes', 'armorElecRes',
      'hpPhysRes', 'hpFireRes', 'hpIceRes', 'hpElecRes',
    ];
    const positive = resistKeys.filter((k) => (bonus[k] || 0) > 0);
    if (positive.length === 0) return; // 无正抗性可反转
    const pick = positive[Math.floor(Math.random() * positive.length)];
    bonus[pick] = -Math.abs(bonus[pick] || 0); // 正负反转
    monster.bonus = JSON.stringify(bonus);
    // 记录反转buff（便于到期恢复，此处简化为持续时间内享受反转效果，超时由其他机制清理）
    const mbuffs: any[] = this.safeParseJson(monster.buffs, []);
    mbuffs.push({ name: '反转童话', expireAt: Math.floor(Date.now() / 1000) + duration });
    monster.buffs = JSON.stringify(mbuffs);
  }

  // ==================== 使魔专属战斗特效 ====================

  /**
   * 处理使魔专属战斗特效
   * 在武器攻击流程中，根据玩家的当前使魔类型，触发专属战斗特效
   * 对应原版：各种使魔的武器攻击特效处理
   *
   * @param player 玩家对象（含 type 字段标识当前使魔类型）
   * @param playerData 完整玩家数据（含 markers/buffs 等）
   * @param weapon 当前使用的武器数据
   * @param context 当前攻击上下文
   * @returns 特效处理结果，包含修改后的攻击参数
   */
  processFamiliarEffects(
    player: any,
    playerData: any,
    weapon: WeaponData,
    context: AttackContext,
  ): FamiliarEffectResult {
    // 默认返回值：所有参数保持原样
    const defaultResult: FamiliarEffectResult = {
      damageMultiplier: context.damageMultiplier || 100,
      hitRateModifier: 0,
      allAttack: context.allAttack || false,
      splashCount: 0,
      splashDamageMultiplier: 1.0,
      splashMustHit: false,
      extraAttacks: 0,
      extraPenetration: 0,
      effectText: '',
      stealDodge: false,
      cooldownOverride: 0,
      triggerCombo: false,
      forceAllAttack: false,
      weaponDisplayName: weapon.name || '',
    };

    // 获取当前使魔类型
    const familiarType = player.type || '';

    // 根据使魔类型分发到对应的特效处理
    switch (familiarType) {
      case '战斗女仆':
        return this.processBattleMaidEffects(player, playerData, weapon, context, defaultResult);
      case '伊卡洛斯':
        return this.processIcarusEffects(player, playerData, weapon, context, defaultResult);
      case '花园猫':
        return this.processGardenCatEffects(player, playerData, weapon, context, defaultResult);
      case '恶毒':
        return this.processMaliceEffects(player, playerData, weapon, context, defaultResult);
      case '普拉娜':
        return this.processPlanaEffects(player, playerData, weapon, context, defaultResult);
      default:
        return defaultResult;
    }
  }

  /**
   * 战斗女仆专属特效
   * 攻击时随机触发一种效果：RPG!/机枪/震撼弹/云爆弹
   * - RPG!：溅射数量+1，溅射伤害+25%，溅射伤害必中
   * - 机枪：命中提高15%，额外攻击一次
   * - 震撼弹：穿透+5%
   * - 云爆弹：攻击+33%，全体攻击，伤害分摊
   * 触发RPG!/机枪时，全体攻击失效
   */
  private processBattleMaidEffects(
    player: any,
    playerData: any,
    weapon: WeaponData,
    context: AttackContext,
    base: FamiliarEffectResult,
  ): FamiliarEffectResult {
    const result = { ...base };
    // 随机选择一种效果（4种等概率）
    const effects = ['rpg', 'machinegun', 'stun', 'fuelAir'];
    const chosen = effects[Math.floor(Math.random() * effects.length)];

    switch (chosen) {
      case 'rpg':
        // RPG!：溅射数量+1，溅射伤害+25%，溅射伤害必中
        result.splashCount = 1;
        result.splashDamageMultiplier = 1.25;
        result.splashMustHit = true;
        result.effectText = '【战斗女仆·RPG!】';
        // 触发RPG!时，全体攻击失效
        if (result.allAttack) {
          result.allAttack = false;
        }
        break;

      case 'machinegun':
        // 机枪：命中提高15%，额外攻击一次
        result.hitRateModifier = 15;
        result.extraAttacks = 1;
        result.effectText = '【战斗女仆·机枪】';
        // 触发机枪时，全体攻击失效
        if (result.allAttack) {
          result.allAttack = false;
        }
        break;

      case 'stun':
        // 震撼弹：穿透+5%
        result.extraPenetration = 5;
        result.effectText = '【战斗女仆·震撼弹】';
        break;

      case 'fuelAir':
        // 云爆弹：攻击+33%，全体攻击，伤害分摊
        result.damageMultiplier = result.damageMultiplier * 1.33;
        result.forceAllAttack = true;
        result.effectText = '【战斗女仆·云爆弹】';
        break;
    }

    return result;
  }

  /**
   * 伊卡洛斯歼灭模式特效
   * - 歼灭模式下，额外攻击次数+3
   * - 攻击闪避状态的目标时，偷取其闪避状态2秒
   */
  private processIcarusEffects(
    player: any,
    playerData: any,
    weapon: WeaponData,
    context: AttackContext,
    base: FamiliarEffectResult,
  ): FamiliarEffectResult {
    const result = { ...base };

    // 检查玩家是否有"歼灭模式"增益
    const buffs = playerData.buffs || [];
    const hasAnnihilationMode = buffs.some((b: any) => b.name === '歼灭模式');

    if (hasAnnihilationMode) {
      // 歼灭模式下，额外攻击次数+3
      result.extraAttacks = 3;
      result.effectText = '【伊卡洛斯·歼灭模式】';
    }

    // 攻击闪避状态的目标时，偷取其闪避状态2秒
    // 这个逻辑需要在攻击循环中判断目标是否有闪避增益，此处标记开启
    result.stealDodge = true;

    return result;
  }

  /**
   * 花园猫闪避反击特效
   * - 闪避后自动反击，且必中
   * 该效果在闪避判定时触发，由上层调用本方法检测
   */
  private processGardenCatEffects(
    player: any,
    playerData: any,
    weapon: WeaponData,
    context: AttackContext,
    base: FamiliarEffectResult,
  ): FamiliarEffectResult {
    // 花园猫的闪避反击逻辑在攻击循环中通过 checkHit 后的回调触发
    // 此处标记使魔类型，便于攻击循环中判断
    return { ...base };
  }

  /**
   * 恶毒好感度特效
   * - 好感≥60时，全体攻击变溅射（不丢失全体攻击效果）
   */
  private processMaliceEffects(
    player: any,
    playerData: any,
    weapon: WeaponData,
    context: AttackContext,
    base: FamiliarEffectResult,
  ): FamiliarEffectResult {
    const result = { ...base };
    const markers = playerData.markers || {};
    // 获取恶毒好感度，标记格式为"恶毒好感"
    const affinity = markers['恶毒好感'] || 0;

    if (affinity >= 60 && result.allAttack) {
      // 好感≥60时，全体攻击变溅射（不丢失全体攻击效果）
      // 保留 allAttack=true 的同时增加溅射标记
      result.splashCount = 1;
      result.effectText = '【恶毒·好感溅射】';
    }

    return result;
  }

  /**
   * 普拉娜武器显示特效
   * - 攻击时在文本中显示武器名
   */
  private processPlanaEffects(
    player: any,
    playerData: any,
    weapon: WeaponData,
    context: AttackContext,
    base: FamiliarEffectResult,
  ): FamiliarEffectResult {
    const result = { ...base };
    // 普拉娜攻击时显示武器名
    // 已有 weaponDisplayName 字段，保持武器名显示
    result.effectText = `【普拉娜·${weapon.name || '武器'}】`;
    return result;
  }

  /**
   * 处理武器特殊序号相关特效
   * 对应原版武器特殊序号的效果处理
   * - 机械触手(特殊序号90+): 武器冷却变为6秒
   * - 雷火剑(特殊序号1001): 冷却变为1/3
   * - 火神机枪: 冷却后自动再次攻击
   * - 三千世界: 冷却后自动再次攻击
   *
   * @param weapon 武器数据
   * @param baseCooldown 原始冷却时间
   * @returns 修改后的冷却时间和自动连击标记
   */
  processWeaponSpecialEffects(
    weapon: WeaponData,
    baseCooldown: number,
  ): { cooldown: number; triggerCombo: boolean; effectText: string } {
    const result = { cooldown: baseCooldown, triggerCombo: false, effectText: '' };

    // 机械触手：武器冷却变为6秒
    if (weapon.specialSeq === 90 || weapon.name?.includes('机械触手')) {
      result.cooldown = 6;
      result.effectText = '【机械触手·冷却缩短】';
    }

    // 雷火剑：冷却变为1/3
    if (weapon.specialSeq === 1001 || weapon.name?.includes('雷火剑')) {
      result.cooldown = Math.max(1, Math.floor(baseCooldown / 3));
      result.effectText = '【雷火剑·冷却极速】';
    }

    // 火神机枪：冷却后自动再次攻击
    if (weapon.name?.includes('火神机枪') || weapon.specialSeq === 1002) {
      // 标记触发自动连击
      result.triggerCombo = true;
      result.effectText = '【火神机枪·自动连击】';
    }

    // 三千世界：冷却后自动再次攻击
    if (weapon.name?.includes('三千世界') || weapon.specialSeq === 1003) {
      result.triggerCombo = true;
      result.effectText = '【三千世界·自动连击】';
    }

    return result;
  }

  /**
   * 检查玩家是否有全体攻击标记
   * 检查来源：装备加成、基础属性、增益状态
   *
   * @param player 玩家对象
   * @param playerData 玩家完整数据
   * @returns 是否有全体攻击标记
   */
  checkAllAttackFlag(player: any, playerData: any): boolean {
    // 1. 检查装备加成中是否有全体攻击
    if (playerData.equipment && playerData.equipment.length > 0) {
      for (const equip of playerData.equipment) {
        if (equip.bonus && equip.bonus.allAttack) {
          return true;
        }
        if (equip.baseBonus && equip.baseBonus.allAttack) {
          return true;
        }
      }
    }

    // 2. 检查玩家基础属性
    if (player.allAttack) {
      return true;
    }

    // 3. 检查增益状态
    if (playerData.buffs && playerData.buffs.length > 0) {
      for (const buff of playerData.buffs) {
        if (buff.allAttack) {
          return true;
        }
      }
    }

    return false;
  }

  // ==================== 延时攻击系统 ====================

  /**
   * 延时攻击任务映射
   * 记录每个用户的延时攻击定时器，key=userId
   */
  private delayedAttackTimers: Map<number, NodeJS.Timeout> = new Map();

  /**
   * 延时攻击锁定状态
   * 记录每个用户是否处于锁定状态，锁定期间不能执行其他操作
   */
  private lockStates: Map<number, boolean> = new Map();

  /**
   * 安排延时攻击
   * 武器有锁定时间时，在锁定时间结束后自动执行攻击
   * 锁定期间玩家不能执行其他操作
   *
   * @param userId 用户ID
   * @param weaponIndex 武器索引
   * @param lockTime 锁定时间（秒）
   * @returns 是否成功安排延时攻击
   */
  scheduleDelayedAttack(userId: number, weaponIndex: number, lockTime: number): boolean {
    if (lockTime <= 0) return false;

    // 设置锁定状态
    this.lockStates.set(userId, true);

    // 清除已有的延时攻击定时器
    this.clearDelayedAttack(userId);

    // 在锁定时间结束后自动执行攻击
    const timer = setTimeout(async () => {
      try {
        // 解除锁定状态
        this.lockStates.set(userId, false);

        // 执行延时攻击
        const result = await this.weaponAttack(userId, weaponIndex, {
          noDelay: true, // 延时攻击无视冷却
          isDelayed: true,
          damageMultiplier: 100,
        });

        this.logger.log(`延时攻击完成 userId=${userId}, 伤害=${result.damageDealt}`);
      } catch (error) {
        this.logger.error(`延时攻击执行失败 userId=${userId}: ${error.message}`);
        this.lockStates.set(userId, false);
      }
    }, lockTime * 1000);

    this.delayedAttackTimers.set(userId, timer);
    this.logger.log(`安排延时攻击 userId=${userId}, 锁定时间=${lockTime}秒`);
    return true;
  }

  /**
   * 清除用户的延时攻击
   *
   * @param userId 用户ID
   */
  clearDelayedAttack(userId: number): void {
    const existingTimer = this.delayedAttackTimers.get(userId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.delayedAttackTimers.delete(userId);
    }
    this.lockStates.set(userId, false);
  }

  /**
   * 检查用户是否处于锁定状态
   *
   * @param userId 用户ID
   * @returns 是否锁定中
   */
  isLocked(userId: number): boolean {
    return this.lockStates.get(userId) || false;
  }

  // ==================== 怪物自动战斗循环 ====================

  /**
   * 自动战斗定时器映射
   * key=userId，value=定时器对象
   */
  private autoCombatTimers: Map<number, NodeJS.Timeout> = new Map();

  /**
   * 开始自动战斗
   * 当玩家进入战斗状态后，每5秒自动攻击一次
   * 直到地图没有怪物或玩家退出战斗
   *
   * @param userId 用户ID
   * @param weaponIndex 武器索引
   * @returns 是否成功启动
   */
  startAutoCombat(userId: number, weaponIndex: number = 0): boolean {
    // 如果已有自动战斗，先停止
    this.stopAutoCombat(userId);

    // 每5秒自动攻击一次
    const timer = setInterval(async () => {
      try {
        // 检查玩家是否还在战斗状态
        const playerData = await this.playerService.getPlayerData(userId);
        const { player } = playerData;

        // 如果玩家死亡，停止自动战斗
        if (this.playerService.isPlayerDead(player)) {
          this.stopAutoCombat(userId);
          return;
        }

        // 获取地图怪物
        const map = await this.prisma.gameMap.findUnique({
          where: { id: player.mapId },
        });
        if (!map) {
          this.stopAutoCombat(userId);
          return;
        }

        const monsters = this.mapService.getMapMonsters(map);
        if (monsters.length === 0) {
          // 地图没有怪物了，停止自动战斗
          this.stopAutoCombat(userId);
          return;
        }

        // 执行自动攻击
        const result = await this.weaponAttack(userId, weaponIndex, {
          noDelay: true,
          isAutoCombat: true,
        });

        this.logger.log(`自动战斗 userId=${userId}, 伤害=${result.damageDealt}, 击杀=${result.killed.join(',')}`);
      } catch (error) {
        this.logger.error(`自动战斗执行失败 userId=${userId}: ${error.message}`);
        this.stopAutoCombat(userId);
      }
    }, 5000);

    this.autoCombatTimers.set(userId, timer);
    this.logger.log(`开始自动战斗 userId=${userId}`);
    return true;
  }

  /**
   * 停止自动战斗
   *
   * @param userId 用户ID
   */
  stopAutoCombat(userId: number): void {
    const existingTimer = this.autoCombatTimers.get(userId);
    if (existingTimer) {
      clearInterval(existingTimer);
      this.autoCombatTimers.delete(userId);
      this.logger.log(`停止自动战斗 userId=${userId}`);
    }
  }

  /**
   * 检查用户是否在自动战斗中
   *
   * @param userId 用户ID
   * @returns 是否在自动战斗中
   */
  isAutoCombatActive(userId: number): boolean {
    return this.autoCombatTimers.has(userId);
  }

  // ==================== 自动连击机制 ====================

  /**
   * 自动连击计数映射
   * key=userId，value={ weaponName, comboCount, timerId }
   * 最多连击3次
   */
  private comboState: Map<number, { weaponName: string; weaponIndex: number; comboCount: number; timer: NodeJS.Timeout | null }> = new Map();

  /**
   * 触发自动连击
   * 特定武器攻击后，在武器冷却结束时自动再次攻击
   * 最多连击3次
   *
   * @param userId 用户ID
   * @param weaponIndex 武器索引
   * @param cooldown 冷却时间（秒）
   * @param weaponName 武器名
   */
  triggerCombo(userId: number, weaponIndex: number, cooldown: number, weaponName: string): void {
    // 获取或创建连击状态
    let state = this.comboState.get(userId);

    if (!state || state.weaponName !== weaponName) {
      // 如果是新武器，重置连击计数
      state = { weaponName, weaponIndex, comboCount: 0, timer: null };
      this.comboState.set(userId, state);
    }

    // 清除旧的连击定时器
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    // 连击次数+1
    state.comboCount++;

    // 最多连击3次
    if (state.comboCount >= 3) {
      this.logger.log(`自动连击结束 userId=${userId}, weapon=${weaponName}, 连击次数=${state.comboCount}`);
      this.comboState.delete(userId);
      return;
    }

    // 在武器冷却结束后自动再次攻击
    const timer = setTimeout(async () => {
      try {
        const state = this.comboState.get(userId);
        if (!state) return;

        // 执行连击攻击
        const result = await this.weaponAttack(userId, weaponIndex, {
          noDelay: true,
          isCombo: true,
          damageMultiplier: 100,
        });

        this.logger.log(`自动连击 userId=${userId}, weapon=${weaponName}, combo=${state.comboCount}, 伤害=${result.damageDealt}`);
      } catch (error) {
        this.logger.error(`自动连击失败 userId=${userId}: ${error.message}`);
        this.comboState.delete(userId);
      }
    }, cooldown * 1000);

    state.timer = timer;
    this.logger.log(`安排自动连击 userId=${userId}, weapon=${weaponName}, combo=${state.comboCount}/${3}`);
  }

  /**
   * 清除自动连击状态
   *
   * @param userId 用户ID
   */
  clearCombo(userId: number): void {
    const state = this.comboState.get(userId);
    if (state && state.timer) {
      clearTimeout(state.timer);
    }
    this.comboState.delete(userId);
  }

  // ==================== 地图增益自动获取 ====================

  /**
   * 应用地图增益
   * 进入地图时自动获得地图的 mapBuffs
   * 将地图的增益效果添加到玩家的 buffs 列表中
   *
   * @param player 玩家对象
   * @param map 地图对象
   */
  applyMapBuffs(player: any, map: any): void {
    try {
      // 解析地图的 mapBuffs JSON 字段
      const mapBuffs: any[] = JSON.parse(map.mapBuffs || '[]');
      if (mapBuffs.length === 0) return;

      // 解析玩家当前的 buffs
      const playerBuffs: any[] = JSON.parse(player.buffs || '[]');
      const now = Date.now() / 1000;

      for (const mapBuff of mapBuffs) {
        // 移除同名的旧增益
        const filteredBuffs = playerBuffs.filter((b: any) => b.name !== mapBuff.name);

        // 添加新增益（地图增益持续到离开地图，设为永久 = 很大的过期时间）
        filteredBuffs.push({
          name: mapBuff.name,
          value: mapBuff.value,
          duration: mapBuff.duration || 86400, // 默认24小时
          expireAt: now + (mapBuff.duration || 86400),
          source: 'mapBuff',
          mapId: map.id,
        });

        // 更新 buffs
        player.buffs = JSON.stringify(filteredBuffs);
      }

      this.logger.log(`应用地图增益 map=${map.name}, buffs=${mapBuffs.map((b: any) => b.name).join(',')}`);
    } catch (error) {
      this.logger.warn(`应用地图增益失败: ${error.message}`);
    }
  }

  // ==================== 花园猫闪避反击处理 ====================

  /**
   * 处理花园猫闪避反击
   * 当玩家闪避攻击后，自动反击且必中
   * 由上层在闪避判定时调用
   *
   * @param userId 用户ID
   * @param weaponIndex 武器索引
   * @returns 反击结果文本
   */
  async handleGardenCatCounter(userId: number, weaponIndex: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查使魔类型是否为花园猫
    if (player.type !== '花园猫') {
      return '';
    }

    // 执行反击（必中）
    const result = await this.weaponAttack(userId, weaponIndex, {
      mustHit: true,
      attackText: '【花园猫·闪避反击】',
      noDelay: true,
    });

    if (result.damageDealt > 0) {
      return `花园猫闪避并发动反击！\n${result.result}`;
    }

    return '';
  }
}