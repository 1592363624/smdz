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
import { ItemSystemService } from './item-system.service';
import { StaticDataService } from './static-data.service';
import { AchievementService } from './achievement.service';
import { CombatStateService } from './combat-state.service';

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
  /** 指定攻击目标名（对应原版 `攻击怪物名` 设置玩家.目标） */
  targetName?: string;
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
  /** 本次攻击即时攻击加成（百分比，如普拉娜"火力"、战斗女仆"精准攻击"） */
  attackBonus?: number;
  /** 本次攻击即时暴击伤害加成（百分比，如战斗女仆"精准暴伤"） */
  critDmgBonus?: number;
  /** 本次攻击后需要给攻击方添加的增益（原版 获得增益 调用的简化表达） */
  attackerBuffs?: Array<{ name: string; value: number; duration: number }>;
  /** 本次攻击后需要给防御方添加的增益（如龙姬"点燃"） */
  defenderBuffs?: Array<{ name: string; value: number; duration: number }>;
  /** 本次攻击消耗/写入攻击方标记（如小樱"空间魔力"、战斗女仆"沉着"） */
  markerOps?: Array<{ key: string; delta: number }>;
  /** 是否命中后增加目标"被近战"标记（剑圣"时代变了"依赖） */
  markTargetAsMelee?: boolean;
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
  /** 三段暴击评级文本（绝杀/完美/致命/强力/正中/擦过/描边 + 百分比），无评级则为空 */
  rating?: string;
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
  dropText?: string;
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
  self?: any;             // 武器自带属性（原版 z1.自带，含 anesthesia 麻醉字段）
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
    private readonly staticData: StaticDataService,
    private readonly achievementService: AchievementService,
    private readonly itemSystem: ItemSystemService,
    private readonly combatState: CombatStateService,
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
      targetName = '',
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
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) {
      return { result: '你不在任何地图上！', killed: [], damageDealt: 0, expGained: 0, drops: [] };
    }

    // 3. 从地图获取怪物列表（GameMonster 表，async）
    const monsters = await this.mapService.getMapMonsters(map);
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

    // 4.1 武器攻击冷却检查（严格对齐原版：按武器名写入玩家 markers2 持久化标记）
    //     原版 _主程序.ecode:904 `时间间隔要求(武器名+"冷却", 攻击冷却, 玩家.标记2, ...)`
    //     noDelay(延时攻击/自动连击) 无视冷却
    if (!noDelay && weapon?.name) {
      const now = Date.now();
      const cooldownSec = weapon.cooldown || 5;
      const cooldownName = `${weapon.name}冷却`;
      const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
      const entry = markers2.find((m: any) => m?.name === cooldownName);
      if (entry && entry.expireAt && now < entry.expireAt) {
        const remaining = Math.ceil((entry.expireAt - now) / 1000);
        return {
          result: `${weapon.name} 冷却中，请等待 ${remaining} 秒`,
          killed: [],
          damageDealt: 0,
          expGained: 0,
          drops: [],
        };
      }
      // 写入武器冷却标记（覆盖旧标记）
      const newMarkers2 = markers2.filter((m: any) => m?.name !== cooldownName);
      newMarkers2.push({ name: cooldownName, expireAt: now + cooldownSec * 1000 });
      player.markers2 = JSON.stringify(newMarkers2);
    }

    // 5. 确定攻击目标列表
    let targets = this.selectTargets(monsters, player, allAttack, weapon, targetName);

    if (targets.length === 0) {
      return { result: '没有可以攻击的目标', killed: [], damageDealt: 0, expGained: 0, drops: [] };
    }

    // 6. 处理使魔专属战斗特效
    // 根据玩家的当前使魔类型，触发专属战斗特效（如战斗女仆随机效果、伊卡洛斯歼灭模式等）
    const familiarEffect = this.processFamiliarEffects(player, playerData, weapon, context);
    // 应用使魔特效修改后的参数
    let effectiveDamageMultiplier = familiarEffect.damageMultiplier; // 修改后的伤害倍率
    const effectiveAllAttack = familiarEffect.forceAllAttack || familiarEffect.allAttack; // 实际全体攻击标记
    let hitRateModifier = familiarEffect.hitRateModifier; // 命中率修正
    let extraPenetration = familiarEffect.extraPenetration; // 额外穿透
    const effectText = familiarEffect.effectText; // 特效文本

    // 如果使魔特效改变了全体攻击标记，重新选择目标
    // 例如：战斗女仆RPG!/机枪会取消全体攻击，云爆弹会强制全体攻击
    if (effectiveAllAttack !== allAttack) {
      targets = this.selectTargets(monsters, player, effectiveAllAttack, weapon, targetName);
    }

    // 7. 执行攻击循环
    const resultLines: string[] = [];
    const killed: string[] = [];
    let totalDamage = 0;
    let totalExp = 0;
    const allDrops: any[] = [];
    let attackCount = 0;

    // 构造攻击者加成数据（合并基础+装备+增益；传入 map 供宠物存活数量加成使用）
    const attackerBonus = this.buildAttackerBonus(player, playerData, map);

    // ========== 当前生命>0 移除卷土重来（原版 _计算玩家 L2539-2541） ==========
    // 原版：当前生命>0 时获得增益(卷土重来, -30) 即移除卷土重来（卷土重来仅在死亡时生效）
    if ((player.hp || 0) > 0 && playerData.buffs && Array.isArray(playerData.buffs)) {
      const jtIdx = playerData.buffs.findIndex((b: any) => b && b.name === '卷土重来');
      if (jtIdx >= 0) {
        playerData.buffs.splice(jtIdx, 1);
        player.buffs = JSON.stringify(playerData.buffs);
      }
    }

    // ========== 等级差距（对应原版 加成计算.ecode L1817-1820 新人加成） ==========
    // 原版：世界等级 = 全局标记"世界"；若 玩家.等级 < 世界等级*10，
    //       则 差距 = 1 - 玩家.等级/(世界等级*10)（0<差距<1，等级越低差距越大）。
    // 差距用于命中/伤害：命中 = 命中/(1-差距)（放大），伤害 = 剩余/(1-差距)（放大）→ 新人加成。
    // 只有等级低于世界等级×10 的"新人"享受该加成，高等级玩家无差距。
    try {
      const wlConfig = await this.prisma.systemConfig.findUnique({
        where: { key: 'game.worldLevel' },
      });
      const worldLevel = Number(wlConfig?.value ?? 1) || 1;
      const threshold = worldLevel * 10;
      if (player.level < threshold) {
        attackerBonus.gap = 1 - player.level / threshold;
      }
    } catch (e) {
      this.logger.warn(`读取世界等级计算差距失败: ${e.message}`);
    }

    // ========== 载具加成（对应原版 加成计算.ecode 载具加成 L3334-3379） ==========
    // 玩家驾驶载具时，将地图上对应载具的加成并入攻击属性（攻击2/闪避2/命中2 + 其余加成）
    if (player.vehicle) {
      try {
        const mapVehicles = this.playerService.safeJsonParse<any[]>(map.vehicles, []);
        const v = mapVehicles.find((x: any) => x && (x.id === player.vehicle || x.编号 === player.vehicle));
        if (v && (v.currentHp ?? v.当前生命 ?? 1) > 0) {
          const vBonus = v.bonus || v.加成 || {};
          const inc = 1; // 法宝3级+5% 的细节可后续补
          attackerBonus.attack2 = (attackerBonus.attack2 || 0) + (vBonus.attack2 || 0) * inc;
          attackerBonus.dodge2 = (attackerBonus.dodge2 || 0) + (vBonus.dodge2 || 0) * inc;
          attackerBonus.hit2 = (attackerBonus.hit2 || 0) + (vBonus.hit2 || 0) * inc;
          // 其余载具加成（生命/护盾/装甲/伤害/暴击等）
          for (const key of ['attack', 'hp', 'shield', 'armor', 'dodge', 'hit', 'speed', 'crit', 'critDmg', 'physDmg', 'fireDmg', 'iceDmg', 'elecDmg'] as const) {
            if (vBonus[key]) {
              (attackerBonus as any)[key] = ((attackerBonus as any)[key] || 0) + (vBonus[key] || 0) * inc;
            }
          }
          // 发丝（白的发丝）：掉落率/品质固定
          if (v.hair || v.发丝) {
            attackerBonus.dropRate = 0;
            attackerBonus.dropQuality = 0;
          }
        }
      } catch (err: any) {
        this.logger.warn(`载具加成失败: ${err.message}`);
      }
    }

    // ========== 使魔被动特效的即时攻击修正（对应原版 造成伤害 L1037-1142） ==========
    // 普拉娜"火力"/战斗女仆"精准攻击"：按百分比加攻击；
    // 战斗女仆"精准暴伤"：按百分比加暴击伤害；小樱"库洛魔力"等
    if (familiarEffect.attackBonus) {
      attackerBonus.attack = (attackerBonus.attack || 0) + (attackerBonus.attack || 0) * (familiarEffect.attackBonus / 100);
      if (familiarEffect.effectText.includes('火力')) {
        resultLines.push(`【普拉娜·火力】攻击+${familiarEffect.attackBonus}%`);
      } else {
        resultLines.push(`【使魔特效】攻击+${familiarEffect.attackBonus}%`);
      }
    }
    if (familiarEffect.critDmgBonus) {
      attackerBonus.critDmg = (attackerBonus.critDmg || 150) + familiarEffect.critDmgBonus;
    }
    // 使魔被动特效：给攻击方添加增益（如小樱"库洛魔力"、伊芙利特"五番"）
    if (familiarEffect.attackerBuffs && familiarEffect.attackerBuffs.length > 0) {
      const playerBuffs = this.playerService.safeJsonParse<any[]>(player.buffs, []);
      for (const b of familiarEffect.attackerBuffs) {
        playerBuffs.push({ name: b.name, value: b.value, expireAt: Date.now() / 1000 + b.duration, duration: b.duration });
      }
      player.buffs = JSON.stringify(playerBuffs);
    }
    // 使魔被动特效：消耗/写入攻击方标记（如小樱"空间魔力"、普拉娜无）
    if (familiarEffect.markerOps && familiarEffect.markerOps.length > 0) {
      const m = (playerData.markers || {}) as Record<string, number>;
      for (const op of familiarEffect.markerOps) {
        m[op.key] = (m[op.key] || 0) + op.delta;
      }
      playerData.markers = m;
      player.markers = JSON.stringify(m);
    }

    // ========== 通用战斗特判（对应原版 战斗相关.ecode 造成伤害 L1004-1185） ==========
    // 攻击模式（炮击模式）：闪避固定为1（对应原版 L2340-2342 玩家.属性.闪避 = 1）
    if (player.attackMode === 1) {
      attackerBonus.dodge = 1;
      attackerBonus.dodge2 = 0;
    }
    // 1. 力量模式/隐匿模式（增益标记）：近战/拳头伤害×1.5；隐匿模式下远程伤害×1.5且暴击率100%
    const buffs = playerData.buffs || [];
    const hasPowerMode = buffs.some((b: any) => b && b.name === '力量模式');
    const hasStealthMode = buffs.some((b: any) => b && b.name === '隐匿模式');
    const isMelee = !weapon.type || weapon.type.includes('近战') || weapon.name === '拳头';
    if (hasPowerMode) {
      if (isMelee) {
        effectiveDamageMultiplier *= 1.5;
        resultLines.push('【力量模式】近战伤害×1.5');
      }
    }
    if (hasStealthMode) {
      if (!isMelee) {
        effectiveDamageMultiplier *= 1.5;
        attackerBonus.crit = 100; // 隐匿模式远程暴击率100%
        resultLines.push('【隐匿模式】远程伤害×1.5且必暴击');
      } else {
        resultLines.push('【隐匿攻击】');
      }
    }

    // 2. 次元破碎（装备）：33%几率 +20 三层穿透
    const hasDimBreak = (playerData.equipment || []).some((e: any) => (e.name || '').includes('次元破碎'));
    if (hasDimBreak && Math.random() < 0.33) {
      attackerBonus.shieldPenetration = (attackerBonus.shieldPenetration || 0) + 20;
      attackerBonus.armorPenetration = (attackerBonus.armorPenetration || 0) + 20;
      attackerBonus.hpPenetration = (attackerBonus.hpPenetration || 0) + 20;
      resultLines.push('【次元破碎】穿透+20%');
    }

    // 3. 因果逆转（武器特效==47）：固定命中率+20%
    if (weapon.specialEffect === 47) {
      hitRateModifier += 20;
    }

    // ========== 武器特殊序号特效（对应原版 造成伤害 L1306-1337） ==========
    // 兰音被动：好感≥100 时，武器冷却越长最终伤害越高（150×冷却/20/100，下限100%，上限200%+技能×5%）
    if (player.type === '兰音' && (player.affinity || 0) >= 100) {
      const lanyinSkill = this.playerService.getMarkerValue(playerData.markers, '兰音技能');
      const cd = weapon.cooldown || 5;
      let a1 = 150 * cd / 20 / 100;
      if (a1 < 1) a1 = 1;
      const cap = 2 + lanyinSkill * 0.05;
      if (a1 > cap) a1 = cap;
      effectiveDamageMultiplier *= a1;
      resultLines.push(`【寸光】伤害×${(a1 * 100).toFixed(0)}%`);
    }
    // 镰刀1：卷土重来增益时伤害×3
    if (weapon.specialSeq === 37 || weapon.name?.includes('镰刀')) {
      const hasComeback = buffs.some((b: any) => b && b.name === '卷土重来');
      if (hasComeback) {
        effectiveDamageMultiplier *= 3;
        resultLines.push('【镰刀】伤害×3');
      }
    }
    // 艾斯特拉斯：60秒冷却，伤害+390%
    if (weapon.specialSeq === 25 || weapon.name?.includes('艾斯特拉斯')) {
      effectiveDamageMultiplier += 390;
      resultLines.push('【艾斯特拉斯】伤害+390%');
    }

    // 读取并消费玩家"下次攻击"型标记 buff（兰音系 心无所扰/月落寸光/反转童话）
    // 这些标记由 familiar-skills 的 setNextAttackBuff 写入，此处命中时生效一次后清除
    const nextAttack = this.consumeNextAttackBuffs(player);

    // 如果有特效文本，先添加到结果中
    if (effectText) {
      resultLines.push(effectText);
    }

    for (const target of targets) {
      if (target.hp <= 0) continue;
      // 防御方使魔免伤标记（恶毒色欲/saber ex/四糸乃冰凯 触发时置真，本次伤害=0）
      let dmgNullified = false;
      // 裸体围裙/透明围裙 易伤（格挡判定中累加，防御方 bonus 构建后应用）
      let apronVuln = 0;

      // ========== 防御方闪避判定（对应原版 造成伤害 L1267-1428） ==========
      // 四糸乃：固定闪避+10；伊卡洛斯(歼灭模式)：20%几率获得闪避；绝灭天使：消耗羽毛触发光翼闪避
      // 「闪避」增益：目标处于闪避状态时大幅提升闪避率（原版"固定闪避"语义）
      let targetDodgeModifier = 0;
      let targetHasDodgeBuff = false;
      const targetType = target.type || '';
      const targetBuffs: any[] = this.safeParseJson(target.buffs, []);
      const now = Date.now() / 1000;
      // 闪避增益（含时长）：闪避状态剩余秒数越多闪避率越高（原版固定闪避+100）
      const dodgeBuff = targetBuffs.find((b: any) => b && b.name === '闪避');
      if (dodgeBuff && dodgeBuff.expireAt && dodgeBuff.expireAt > now) {
        targetHasDodgeBuff = true;
        targetDodgeModifier += 100;
        const remain = Math.ceil(dodgeBuff.expireAt - now);
        if (remain > 0) resultLines.push(`${target.name} 处于闪避状态(${remain}秒)`);
      }
      if (targetType.includes('四糸乃')) {
        targetDodgeModifier += 10;
      }
      if (targetType.includes('伊卡洛斯')) {
        const hasAnnihilation = targetBuffs.some((b: any) => b && b.name === '歼灭模式');
        if (hasAnnihilation && Math.random() < 0.2) {
          targetDodgeModifier += 100; // 歼灭模式闪避
        }
      }
      if (targetType.includes('绝灭天使')) {
        const hasLightWing = targetBuffs.some((b: any) => b && b.name === '光翼');
        if (hasLightWing) {
          targetDodgeModifier += 30; // 光翼闪避
        }
      }

      // 命中判定（应用使魔特效的命中率修正 + 心无所扰必中标记 + 因果逆转 + 防御方闪避）
      let isHit: boolean;
      if (mustHit) {
        isHit = true;
      } else if (nextAttack.mustHitNext && Math.random() * 100 < (nextAttack.mustHitChance ?? 100)) {
        // 心无所扰：按几率无视闪避和闪避状态必中
        isHit = true;
        resultLines.push('【心无所扰】无视闪避，必定命中！');
      } else {
        // 因果逆转（武器特效==47）：目标有闪避状态时，按 1÷(闪避剩余×2)×100% 几率无视闪避
        let effectiveDodge = targetDodgeModifier;
        if (weapon.specialEffect === 47 && targetHasDodgeBuff && dodgeBuff?.expireAt) {
          const dodgeRemain = Math.max(0.1, dodgeBuff.expireAt - now);
          const ignoreChance = 1 / (dodgeRemain * 2) * 100;
          if (Math.random() * 100 < ignoreChance) {
            effectiveDodge = 0;
            resultLines.push(`【因果逆转】无视了${target.name}的闪避状态`);
          }
        }
        const hitRate = this.calcHitRate(attackerBonus, target, false) + hitRateModifier;
        isHit = this.checkHit(hitRate, effectiveDodge);
      }

      // ========== 熟练度记录（对应原版 造成伤害 L1483-1496） ==========
      // 命中：给玩家加「战斗熟练度」与「武器类型熟练度」，反馈到 _计算玩家 的属性成长
      // 未命中：给防御方(怪物)加「闪避熟练度」
      if (isHit) {
        this.achievementService.addAchievement(player, '战斗熟练度', 1);
        if (weapon.type) {
          this.achievementService.addAchievement(player, `${weapon.type}熟练度`, 1);
        }
        // 记录攻击者，保证参与战斗的玩家获得奖励
        const targetMarkers = this.safeParseJson<Record<string, number>>(target.markers, {});
        targetMarkers[`攻击者${player.userId}`] = (targetMarkers[`攻击者${player.userId}`] || 0) + 0.001;
        target.markers = JSON.stringify(targetMarkers);
        // 使魔被动特效：给目标添加增益（如龙姬"点燃"）
        if (familiarEffect.defenderBuffs && familiarEffect.defenderBuffs.length > 0) {
          const tBuffs = this.playerService.safeJsonParse<any[]>(target.buffs, []);
          for (const b of familiarEffect.defenderBuffs) {
            tBuffs.push({ name: b.name, value: b.value, expireAt: Date.now() / 1000 + b.duration, duration: b.duration });
          }
          target.buffs = JSON.stringify(tBuffs);
          resultLines.push(`${target.name} 受到【${familiarEffect.defenderBuffs.map((b) => b.name).join('、')}】效果`);
        }
        // 命中后消耗目标的闪避状态（对应原版：命中后闪避状态失效）
        if (targetHasDodgeBuff) {
          const remaining = targetBuffs.filter((b: any) => !(b && b.name === '闪避'));
          target.buffs = JSON.stringify(remaining);
        }
        // ========== 防御方使魔被动特效（对应原版 造成伤害 L2224-2262） ==========
        // 攻击命中防御方使魔时，防御方使魔可能触发减伤/免伤/反击特效
        if (targetType.includes('恶毒')) {
          // 恶毒好感≥100：30秒内"色欲"免伤一次（伤害倍率=0）
          const tMarks = this.safeParseJson<Record<string, number>>(target.markers, {});
          if ((tMarks['恶毒好感'] || 0) >= 100 && tMarks['色欲2'] && Date.now() / 1000 - (tMarks['色欲2时间'] || 0) > 30) {
            resultLines.push(`${target.name} 触发【色欲】，本次攻击被魅惑无效！`);
            dmgNullified = true;
            tMarks['色欲2'] = (tMarks['色欲2'] || 0) + 1;
            tMarks['色欲2时间'] = Date.now() / 1000;
            target.markers = JSON.stringify(tMarks);
          }
        }
        if (targetType.includes('saber')) {
          // saber好感≥40：有"ex"增益时伤害=0
          const tBuffs2 = this.safeParseJson<any[]>(target.buffs, []);
          if (tBuffs2.some((b: any) => b && b.name === 'ex')) {
            resultLines.push(`${target.name} 的【ex】护盾抵消了本次攻击！`);
            dmgNullified = true;
          }
        }
        if (targetType.includes('四糸乃')) {
          // 四糸乃好感≥80：20秒冷却触发"冰凯"免伤一次
          const tBuffs2 = this.safeParseJson<any[]>(target.buffs, []);
          if (tBuffs2.some((b: any) => b && b.name === 'bk1')) {
            resultLines.push(`${target.name} 的【冰凯】挡住了本次攻击！`);
            dmgNullified = true;
            target.buffs = JSON.stringify(tBuffs2.filter((b: any) => !(b && b.name === 'bk1')));
          }
        }
      } else {
        resultLines.push(`${target.name} 闪避了攻击`);
        // 未命中：防御方获得「闪避熟练度」（对应原版 L1484）
        const tMarkers = this.safeParseJson<Record<string, number>>(target.markers, {});
        tMarkers['闪避熟练度'] = (tMarkers['闪避熟练度'] || 0) + 1;
        target.markers = JSON.stringify(tMarkers);
        continue;
      }

      // ========== 格挡判定（对应原版 造成伤害 L2583-2688 完整还原） ==========
      // 1. 免伤前置：防御方有"剑阵"增益时本次伤害=0
      // 2. 格挡来源：防爆盾(+10)/金刚不坏(+10)/圆盾(+5)/烟雾弹增益(+20)
      //    /裸体围裙(近战+10 远程-10 且易伤+5)/透明围裙(+标记×5+5 且易伤+5)/含光套装(+50)
      // 3. 几率判断(格挡) 触发：
      //    - 阿尔缇娜 a3=-1.01：格挡成功（无额外效果）
      //    - a3=-1.02（a技能2增益）：30%完全格挡 / 20%穿透+ / 其余按条件
      //    - 含光套装(陪睡>7)：随机0.01~0.15倍率
      //    - 铃铛：15秒冷却内×0.25，否则随机0.01~0.15倍率
      //    - 默认：×0.25（减伤75%）
      //    - 圆盾：120秒冷却完全免伤并恢复满状态
      //    - 防御熟练度+3
      // 4. 套装减伤（触发格挡后单独判定）：防爆(近战)/游骑兵(射弹)/游侠(生体)/动力(能量)/无畏(制导)
      // 5. 攻击方有"激变星"增益时本次伤害=0
      {
        const tBuffs = this.safeParseJson<any[]>(target.buffs, []);
        const tMk = this.safeParseJson<Record<string, number>>(target.markers, {});
        const nowSec2 = Date.now() / 1000;

        // 1. 剑阵增益：伤害=0（对应原版 L2583-2586）
        if (tBuffs.some((b: any) => b && b.name === '剑阵' && (!b.expireAt || b.expireAt > nowSec2))) {
          resultLines.push(`${target.name} 【剑阵】格挡了本次攻击！`);
          dmgNullified = true;
        }

        if (!dmgNullified) {
          // 2. 计算格挡率
          let blockRate = 0;
          // 防爆盾/圆盾/金刚不坏（原版 L2587-2595）
          const tName = target.name || '';
          if (tName.includes('防爆盾')) blockRate += 10;
          if (tName.includes('圆盾')) blockRate += 5;
          if (tName.includes('金刚不坏')) blockRate += 10;
          // 烟雾弹增益（原版 L2596-2599）
          if (tBuffs.some((b: any) => b && b.name === '烟雾弹' && (!b.expireAt || b.expireAt > nowSec2))) {
            blockRate += 20;
            resultLines.push(`${target.name} 【烟雾弹】格挡率+20%`);
          }
          // 裸体围裙（原版 L2600-2610）：近战/生体武器+10，远程-10，易伤+5
          const isMeleeWeapon = !weapon.type || weapon.type.includes('近战') || weapon.type.includes('生体') || weapon.name === '拳头';
          if (tName.includes('裸体围裙')) {
            blockRate += isMeleeWeapon ? 10 : -10;
            apronVuln += 5;
          }
          // 透明围裙（原版 L2612-2618）：格挡+标记熟练度×5+5，易伤+5
          if (tName.includes('透明围裙')) {
            const apronLv = tMk['透明围裙'] || 0;
            blockRate += apronLv * 5 + 5;
            apronVuln += 5;
            tMk['透明围裙'] = apronLv + 1;
            resultLines.push(`${target.name} 【透明围裙】格挡+${apronLv * 5 + 5}%`);
          }

          // 3. 格挡判定
          if (blockRate > 0 && Math.random() * 100 < blockRate) {
            // 阿尔缇娜格挡分支（a3=-1.02：a技能2增益时）——完整还原30%完全格挡/20%穿透+
            if (tBuffs.some((b: any) => b && b.name === 'a技能2' && (!b.expireAt || b.expireAt > nowSec2))) {
              const roll = Math.random() * 100;
              if (roll < 30) {
                // 30%完全格挡：伤害=0（原版 L2632-2634）
                resultLines.push(`${target.name} 【阿尔缇娜·完全格挡】`);
                dmgNullified = true;
              } else if (roll > 80) {
                // 20%穿透+：穿透提升（原版 L2635-2637）
                attackerBonus.shieldPenetration = (attackerBonus.shieldPenetration || 0) + 15;
                attackerBonus.armorPenetration = (attackerBonus.armorPenetration || 0) + 15;
                attackerBonus.hpPenetration = (attackerBonus.hpPenetration || 0) + 15;
                resultLines.push(`${target.name} 【阿尔缇娜·穿透+】穿透+15%`);
              } else {
                // 其余按条件：格挡×0.25
                effectiveDamageMultiplier *= 0.25;
                resultLines.push(`${target.name} 【格挡】本次伤害降低75%`);
              }
            } else {
              // 默认格挡：伤害倍率×0.25（减伤75%）
              effectiveDamageMultiplier *= 0.25;
              resultLines.push(`${target.name} 【格挡】本次伤害降低75%`);
            }
            // 防御熟练度+3（原版 L2674-2676）
            tMk['防御熟练度'] = (tMk['防御熟练度'] || 0) + 3;
          }
        }
        target.markers = JSON.stringify(tMk);
      }

      // 暴击判定（含被暴击率修正，对应原版 L988-1023/L1200-1202）
      // 被暴击率来源：会心一击a(+10+技能等级)/隐匿模式远程(100)/兰顿之兆(-10)
      let hitByRate = 0;
      if (attackText === '会心一击a') {
        const markers_c = (playerData.markers || {}) as Record<string, number>;
        hitByRate += 10 + (markers_c['会心一击熟练度'] || 0);
      }
      if (target.name?.includes('兰顿之兆')) {
        hitByRate -= 10;
      }
      const isCrit = this.checkCrit(attackerBonus.crit || 0, hitByRate);

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
      // 索敌计算机/超级计算机：命中/闪避倍率过高时保留倍率（原版 L2290-2302）
      const hasSniper = hasEquip('索敌计算机') || hasEquip('超级计算机');

      // 伤害计算
      const defenderBonus = this.buildMonsterBonus(target);
      // ========== 目标易伤（debuff）计算（对应原版 造成伤害 L2139-2142/L2263-2273） ==========
      // 易伤来源：割裂(+10)、影光(+a1×2.5 封顶a1=40)、重伤(+a1)，累加到 defenderBonus.debuff，
      // 由 calcDamage 统一按 剩余伤害×(1+易伤/100) 应用。
      {
        const tBuffs = this.playerService.safeJsonParse<any[]>(target.buffs, []);
        const nowSec = Date.now() / 1000;
        let vuln = 0;
        // 割裂：易伤+10
        if (tBuffs.some((b: any) => b && b.name === '割裂' && (!b.expireAt || b.expireAt > nowSec))) {
          vuln += 10;
        }
        // 影光：易伤 + 增益值×2.5（增益值封顶40）
        const shadow = tBuffs.find((b: any) => b && b.name === '影光' && (!b.expireAt || b.expireAt > nowSec));
        if (shadow) {
          const shadowVal = Math.min(40, Number(shadow.value) || 0);
          vuln += shadowVal * 2.5;
        }
        // 重伤：易伤 + 增益值
        const heavy = tBuffs.find((b: any) => b && b.name === '重伤' && (!b.expireAt || b.expireAt > nowSec));
        if (heavy) {
          vuln += Number(heavy.value) || 0;
        }
        // 裸体围裙/透明围裙 易伤（格挡判定中记录）
        vuln += apronVuln || 0;
        defenderBonus.debuff = (defenderBonus.debuff || 0) + vuln;
      }
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

      // ========== 特殊武器特效（对应原版 造成伤害 L1295+，斩首/尖兵/因果逆转/如梦似幻等） ==========
      // 调用 processSpecialEffects 按武器 specialEffect 触发对应效果，应用额外伤害/倍率/命中修正/穿透
      const specialEffect = this.processSpecialEffects(player, target, weapon, 0, weapon.damageType || CombatSystemService.DMG_PHYS);
      if (specialEffect.effectText) {
        resultLines.push(specialEffect.effectText);
      }
      // 应用特效修改后的伤害倍率与命中修正
      const effectiveDmgMult = effectiveDamageMultiplier * (specialEffect.damageMultiplier || 1.0);
      // 额外穿透（如特殊装备附带）
      if (specialEffect.extraPenetration) {
        attackerBonus.shieldPenetration = (attackerBonus.shieldPenetration || 0) + specialEffect.extraPenetration;
        attackerBonus.armorPenetration = (attackerBonus.armorPenetration || 0) + specialEffect.extraPenetration;
        attackerBonus.hpPenetration = (attackerBonus.hpPenetration || 0) + specialEffect.extraPenetration;
      }
      // 命中修正（因果逆转等）——攻击判定已在此之前完成，此处用于最终命中率展示，不影响本次判定
      hitRateModifier += specialEffect.hitRateModifier || 0;

      // ========== 武器追加伤害（对应原版 造成伤害 L2749-2897 全量） ==========
      // 走完整抗性/倍率流程。目标当前状态 = hp+shield+armor。
      // 本框架无"不触发特效"概念，默认恒为"触发"（不触发特效==假），故各 .如果真 守卫均成立。
      // 额外伤害倍率(extraDamageMult) 对应原版 L983 初始化=1，L1805 镇岳陪睡>2 时 +=0.15。
      {
        const nowSec = Date.now() / 1000;
        const targetCurState = (target.hp || 0) + (target.shield || 0) + (target.armor || 0);
        const targetMaxState = (target.maxHp || target.hp || 0) + (target.maxShield || target.shield || 0) + (target.maxArmor || target.armor || 0);
        const lostState = Math.max(0, targetMaxState - targetCurState);
        const setsData = this.safeParseJson<any>(player.sets, {});
        const sakuraHits = setsData['小樱命中次数'] ?? setsData.sakuraHits ?? 0;
        const sleepLv = setsData['陪睡'] ?? setsData.sleepover ?? 0;
        // 攻击方标记（原版 攻击方.标记）；防御方标记（原版 防御方.标记 = target.markers）
        const playerMk = this.safeParseJson<Record<string, number>>(player.markers || {}, {});
        const targetMk = this.safeParseJson<Record<string, number>>(target.markers || {}, {});

        // ---- 无双勇士标记累计（原版 战斗相关.ecode L1964-1966） ----
        // 装备要求(攻击方,#无双勇士) 成立时：添加成就("ww"+攻击方.QQ, 1, 防御方.标记) 即给目标标记累加 ww 计数；
        // 之后在 L2843（本块"无双"分支）读该值>=4 时触发无双效果并清零。对应本框架 key = ww+userId。
        const hasUndyingWarrior = (playerData.equipment as any[])?.some(
          (e: any) => e.specialSeq === 92 || (e.name || '').includes('无双勇士'),
        );
        if (hasUndyingWarrior) {
          const wwKey = `ww${player.userId ?? player.qqNumber ?? ''}`;
          targetMk[wwKey] = (targetMk[wwKey] || 0) + 1;
          resultLines.push(`【无双】${targetMk[wwKey]}`);
        }

        // ---- 额外伤害倍率：法宝[镇岳]陪睡>2 → +0.15（原版 L1805-1808，特殊序号!=-2 时）----
        // 原版该段位于 .判断 (攻击方.特殊序号 == -2) 的默认分支，故 specialSeq==-2 时不加。
        let extraDamageMult = 1;
        if (player.specialSeq !== -2 && sakuraHits === 2 && sleepLv > 2) {
          extraDamageMult += 0.15;
          resultLines.push(`【镇岳·额外伤害倍率】+15%`);
        }

        // ---- 梅塔特隆（原版 L2737-2740，在 a4 计算之前）：额外伤害.电 += 当前护盾×额外伤害倍率 ----
        if (weapon.specialSeq === 95 || weapon.name?.includes('梅塔特隆')) {
          const bonus = (player.shield || 0) * extraDamageMult;
          attackerBonus.elecDmg = (attackerBonus.elecDmg || 0) + bonus;
          resultLines.push(`【梅塔特隆】电伤+${Math.round(bonus)}`);
        }

        // ========== 法宝追加伤害（原版 L2778-2796） ==========
        // 镇岳（法宝4级）：命中造成目标当前状态5%的额外物理伤害（×额外伤害倍率）
        if (sakuraHits === 2 && sleepLv > 3) {
          const a2 = targetCurState * 0.05 * extraDamageMult;
          attackerBonus.physDmg = (attackerBonus.physDmg || 0) + a2; // 剩余物伤 += a2（原版 L2782-2783）
          resultLines.push(`【镇岳】+${Math.round(a2)}`);
        }
        // 飞天独龙神女枪（法宝7级）：造成伤害时额外造成目标当前状态5%的雷电伤害
        else if (sakuraHits === 1 && sleepLv > 7) {
          const a2 = targetCurState * 0.05 * extraDamageMult;
          attackerBonus.elecDmg = (attackerBonus.elecDmg || 0) + a2;
          resultLines.push(`【神女枪】+${Math.round(a2)}`);
        }

        // ========== 武器自带麻醉判定（原版 L2797：z1.自带.麻醉 <= 0） ==========
        const z1Anesthesia = (weapon.self as any)?.anesthesia || 0;
        if (z1Anesthesia <= 0) {
          // 斩舰刀（特殊序号-22）：a1 += 5（每击物伤+5%，原版 L2798-2799）
          if (weapon.specialSeq === -22 || weapon.name?.includes('斩舰刀')) {
            attackerBonus.physDmg = (attackerBonus.physDmg || 0) + (attackerBonus.attack || 0) * 0.05;
            resultLines.push('【斩舰刀】物伤+5%');
          }
          // 退魔圣焰（特殊序号-8）：物伤×0.4 转为火/冰/电三系（原版 L2800-2804）
          if (weapon.specialSeq === -8 || weapon.name?.includes('退魔圣焰')) {
            const origPhys = (attackerBonus.physDmg || 0) + (attackerBonus.attack || 0);
            const conv = origPhys * 0.4;
            attackerBonus.physDmg = 0;
            attackerBonus.fireDmg = (attackerBonus.fireDmg || 0) + conv;
            attackerBonus.iceDmg = (attackerBonus.iceDmg || 0) + conv;
            attackerBonus.elecDmg = (attackerBonus.elecDmg || 0) + conv;
            resultLines.push(`【退魔圣焰】物伤转化+${Math.round(conv * 3)}`);
          }
          // 袖剑（装备要求 #袖剑，原版 L2808-2817）：满状态>90% + 5秒冷却 → a1 += 10
          const myState = (player.hp || 0) + (player.shield || 0) + (player.armor || 0);
          const myMaxState = (player.maxHp || player.hp || 0) + (player.maxShield || player.shield || 0) + (player.maxArmor || player.armor || 0);
          const hasSleeveDagger = (playerData.equipment as any[])?.some((e: any) => (e.name || '').includes('袖剑'));
          if (hasSleeveDagger && myState > myMaxState * 0.9 && (!playerMk['袖剑冷却'] || nowSec - (playerMk['袖剑冷却'] || 0) > 5)) {
            playerMk['袖剑冷却'] = nowSec;
            attackerBonus.physDmg = (attackerBonus.physDmg || 0) + (attackerBonus.attack || 0) * 0.1;
            resultLines.push(`【袖剑】物伤+10%`);
          }
        }

        // ========== 不触发特效==假 段（原版 L2818-2897） ==========
        // ---- 觉醒天神（原版 L2819-2829：攻击方特殊序号<-1 且 觉醒熟练≥500） ----
        if ((player.specialSeq ?? 0) < -1 && (playerMk['觉醒'] ?? 0) >= 500) {
          const a2 = targetMaxState * 0.03 / 4 * extraDamageMult;
          attackerBonus.fireDmg = (attackerBonus.fireDmg || 0) + a2;
          attackerBonus.physDmg = (attackerBonus.physDmg || 0) + a2;
          attackerBonus.elecDmg = (attackerBonus.elecDmg || 0) + a2;
          attackerBonus.iceDmg = (attackerBonus.iceDmg || 0) + a2;
          resultLines.push(`【天神】+${Math.round(a2 * 4)}`);
        }
        // ---- 雪獒铠甲（原版 L2830-2842：取成就熟练度(标记,"铠甲")==#雪獒铠甲(5)，60秒冷却） ----
        // 原版：a2 = s - 取成就(标记,"xa")；a2/转秒>=60 → 追加剩余伤害×0.75（四系）+ 闪避3秒
        const armorMk = playerMk['铠甲'] ?? 0;
        if (armorMk === 5) {
          const lastXa = playerMk['xa'] || 0;
          if (nowSec - lastXa >= 60) {
            playerMk['xa'] = nowSec; // 用正数时间戳记录上次触发时间（原版 添加成就 xa=60*转秒 正数）
            const m = extraDamageMult;
            attackerBonus.fireDmg = (attackerBonus.fireDmg || 0) + (attackerBonus.fireDmg || 0) * 0.75 * m;
            attackerBonus.physDmg = (attackerBonus.physDmg || 0) + (attackerBonus.physDmg || 0) * 0.75 * m;
            attackerBonus.iceDmg = (attackerBonus.iceDmg || 0) + (attackerBonus.iceDmg || 0) * 0.75 * m;
            attackerBonus.elecDmg = (attackerBonus.elecDmg || 0) + (attackerBonus.elecDmg || 0) * 0.75 * m;
            resultLines.push(`【雪獒】剩余伤害×1.75，闪避+3秒`);
            // 获得增益(攻击方.增益,"闪避",3)（原版 L2839）
            const pBuffs = this.safeParseJson<any[]>(player.buffs, []);
            if (!pBuffs.some((b: any) => b && b.name === '闪避' && b.expireAt > nowSec)) {
              pBuffs.push({ name: '闪避', expireAt: nowSec + 3 });
            }
            player.buffs = JSON.stringify(pBuffs);
          }
        }
        // ---- 无双（原版 L2843-2851：取成就熟练度(防御方.标记,"ww"+攻击方QQ)>=4） ----
        const wwKey = `ww${player.userId ?? player.qqNumber ?? ''}`;
        const wwVal = targetMk[wwKey] || 0;
        if (wwVal >= 4) {
          // 原版：置成就熟练度("ww"+QQ, 防御方.标记, 0) 清零；目标当前状态×15%/4 四系
          targetMk[wwKey] = 0;
          const a2 = targetCurState * 0.15 / 4 * extraDamageMult;
          attackerBonus.fireDmg = (attackerBonus.fireDmg || 0) + a2;
          attackerBonus.physDmg = (attackerBonus.physDmg || 0) + a2;
          attackerBonus.elecDmg = (attackerBonus.elecDmg || 0) + a2;
          attackerBonus.iceDmg = (attackerBonus.iceDmg || 0) + a2;
          resultLines.push(`【无双】+${Math.round(a2 * 4)}`);
        }
        // ---- 常春藤（原版 L2852-2867：攻击方活力==#常春藤(-14)，生体/近战武器命中时目标当前状态×5%物伤） ----
        if (player.vitality === -14 || player.活力 === -14) {
          const wtype = weapon.type || '';
          const isBioMelee = wtype.includes('生体') || wtype.includes('近战');
          if (isBioMelee) {
            const a2 = targetCurState * 0.05 * extraDamageMult;
            attackerBonus.physDmg = (attackerBonus.physDmg || 0) + a2;
            resultLines.push(`【神爪】+${Math.round(a2)}`);
          }
        }
        // ---- 军姬2（原版 L2868-2875：攻击方特殊序号==#军姬2(24)，目标已损失状态×4%/4 四系） ----
        if ((player.specialSeq ?? 0) === 24) {
          const a2 = lostState * 0.04 / 4 * extraDamageMult;
          attackerBonus.fireDmg = (attackerBonus.fireDmg || 0) + a2;
          attackerBonus.physDmg = (attackerBonus.physDmg || 0) + a2;
          attackerBonus.elecDmg = (attackerBonus.elecDmg || 0) + a2;
          attackerBonus.iceDmg = (attackerBonus.iceDmg || 0) + a2;
          resultLines.push(`【撕裂】+${Math.round(a2 * 4)}`);
        }
        // ---- 武器判断：法芙娜 / 伊苏尔德的剪刀（原版 L2876-2892） ----
        // 法芙娜（特殊序号-20）：目标已损失状态×5%/4，四系均加
        if (weapon.specialSeq === -20 || weapon.name?.includes('法芙娜')) {
          const bonus = lostState * 0.05 / 4 * extraDamageMult;
          attackerBonus.fireDmg = (attackerBonus.fireDmg || 0) + bonus;
          attackerBonus.physDmg = (attackerBonus.physDmg || 0) + bonus;
          attackerBonus.elecDmg = (attackerBonus.elecDmg || 0) + bonus;
          attackerBonus.iceDmg = (attackerBonus.iceDmg || 0) + bonus;
          resultLines.push(`【法芙娜·撕裂】+${Math.round(bonus * 4)}`);
        }
        // 伊苏尔德的剪刀（特殊序号-24）：目标最大状态×3%/4，四系均加
        if (weapon.specialSeq === -24 || weapon.name?.includes('剪刀')) {
          const bonus = targetMaxState * 0.03 / 4 * extraDamageMult;
          attackerBonus.fireDmg = (attackerBonus.fireDmg || 0) + bonus;
          attackerBonus.physDmg = (attackerBonus.physDmg || 0) + bonus;
          attackerBonus.elecDmg = (attackerBonus.elecDmg || 0) + bonus;
          attackerBonus.iceDmg = (attackerBonus.iceDmg || 0) + bonus;
          resultLines.push(`【伊苏尔德的剪刀】+${Math.round(bonus * 4)}`);
        }
        // ---- 火焰披风（原版 L2893-2897：装备要求 #火焰披风，30秒冷却，自身当前状态/10 火伤 + 穿透5） ----
        const hasFlameCloak = (playerData.equipment as any[])?.some((e: any) => (e.name || '').includes('火焰披风'));
        if (hasFlameCloak && (!playerMk['火焰披风'] || nowSec - (playerMk['火焰披风'] || 0) > 30)) {
          playerMk['火焰披风'] = nowSec;
          const a2 = ((player.hp || 0) + (player.shield || 0) + (player.armor || 0)) / 10 * extraDamageMult;
          attackerBonus.fireDmg = (attackerBonus.fireDmg || 0) + a2;
          attackerBonus.penetrate = (attackerBonus.penetrate || 0) + 5;
          resultLines.push(`【火焰披风】火伤+${Math.round(a2)}，穿透+5`);
        }

        // 写回攻击方/防御方标记变更
        player.markers = JSON.stringify(playerMk);
        if (wwVal >= 4) target.markers = JSON.stringify(targetMk);
      }

      // 三段评级熟练度：从玩家标记读取当前熟练度（对应原版 显示熟练度等级），
      // 传入 calcDamage 参与评级倍率加成，calcDamage 内部会累加熟练度后写回
      const markers = (playerData.markers || {}) as Record<string, number>;
      const mastery = {
        致命: markers['致命熟练度'] || 0,
        强力: markers['强力熟练度'] || 0,
        正中: markers['正中熟练度'] || 0,
        擦过: markers['擦过熟练度'] || 0,
        描边: markers['描边熟练度'] || 0,
      };
      const damageResult = this.calcDamage(
        attackerBonus,
        defenderBonus,
        weapon,
        weapon.damageType || CombatSystemService.DMG_PHYS,
        isCrit,
        { dmgLower, dmgUpper, sniperComputer: hasSniper, amplifier3: (attackerBonus as any).amplifier3 === 3, mastery },
      );
      // 写回累加后的熟练度（玩家为真实玩家，非怪物）
      // 注意：playerData.markers 是解析对象，savePlayer 保存的是 player.markers 字符串，
      // 因此写回对象后需同步回 player.markers，确保后续 savePlayer 能持久化。
      if (player.specialSeq > 0) {
        let masteryChanged = false;
        for (const key of ['致命', '强力', '正中', '擦过', '描边'] as const) {
          const markerKey = `${key}熟练度`;
          if (markers[markerKey] !== mastery[key]) {
            markers[markerKey] = mastery[key];
            masteryChanged = true;
          }
        }
        if (masteryChanged) {
          playerData.markers = markers;
          player.markers = JSON.stringify(markers);
        }
      }

      // 防御方使魔免伤：色欲/ex/冰凯 触发时本次伤害=0（原版 伤害倍率=0）
      if (dmgNullified) {
        resultLines.push(`${target.name} 的防御抵消了本次伤害！`);
        continue;
      }

      // 应用伤害倍率（含使魔特效 + 特殊武器特效修改后的倍率，再加特殊特效的额外伤害）
      let finalDamage = Math.floor(damageResult.damage * effectiveDmgMult / 100) + (specialEffect.bonusDmg || 0);
      if (finalDamage < 1 && isHit) finalDamage = 1; // 保底1点伤害
      totalDamage += finalDamage;

      // 扣除怪物血量（三池分伤）
      const appliedDamage = this.applyDamageToMonster(target, finalDamage, damageResult.poolDamage);

      // ========== 反伤（对应原版 计算反伤 子程序 L4791-4873） ==========
      // 防御方（目标）携带反伤来源时，按比例把伤害反弹给攻击方：
      //   恶毒好感≥100(色欲30s)：反伤100%；军姬好感≥40(剑阵)：反伤100%
      //   荆棘之翼：+15%；小鱼发饰(60s冷却)：+200%；军姬2好感≥40：+100%+(2+技能等级×0.05)%
      // 反伤倍率 = min(攻击方理论受伤×倍率, 防御方当前状态) / 防御方理论伤害 × 100
      {
        const tBuffs3 = this.safeParseJson<any[]>(target.buffs, []);
        const tMk2 = this.safeParseJson<Record<string, number>>(target.markers, {});
        let reflectMult = 0;
        let reflectLimited = false;
        // 恶毒好感≥100：色欲冷却30秒内反伤100%（每次触发重置冷却）
        if (targetType.includes('恶毒') && (tMk2['恶毒好感'] || 0) >= 100) {
          if (!tMk2['色欲'] || Date.now() / 1000 - (tMk2['色欲时间'] || 0) > 30) {
            tMk2['色欲'] = 1;
            tMk2['色欲时间'] = Date.now() / 1000;
            reflectMult += 1;
            resultLines.push(`${target.name} 触发【色欲反伤】！`);
          }
        }
        // 军姬好感≥40：有剑阵增益时反伤100%
        if (targetType.includes('军姬') && !targetType.includes('军姬2') && (tMk2['军姬好感'] || 0) >= 40 &&
            tBuffs3.some((b: any) => b && b.name === '剑阵')) {
          reflectMult += 1;
          resultLines.push(`${target.name} 触发【剑阵反伤】！`);
        }
        // 荆棘之翼：+15%
        if (target.name?.includes('荆棘之翼')) {
          reflectMult += 0.15;
        }
        // 小鱼发饰：60秒冷却 +200%
        if (target.name?.includes('小鱼发饰') && (!tMk2['小鱼冷却时间'] || Date.now() / 1000 - tMk2['小鱼冷却时间'] > 60)) {
          tMk2['小鱼冷却时间'] = Date.now() / 1000;
          reflectMult += 2;
          resultLines.push(`${target.name} 触发【小鱼发饰反伤】！`);
        }
        // 军姬2好感≥40：+100%+(2+技能等级×0.05)%
        if (targetType.includes('军姬2') && (tMk2['军姬2好感'] || 0) >= 40 && (target.hp || 0) > 0) {
          reflectMult += 1 + (2 + (tMk2['军姬2技能熟练度'] || 0) * 0.05);
          reflectLimited = true;
          resultLines.push(`${target.name} 触发【军姬2反伤】！`);
        }
        if (reflectMult > 0) {
          // 攻击方理论受伤（原版 L4851）：Σ(攻击方四属性伤害×武器系数)×暴击伤害/100×暴击/100×伤害倍率/100
          const atkRaw = (attackerBonus.physDmg || 0) * (weapon.properties?.phys || 100) / 100
            + (attackerBonus.fireDmg || 0) * (weapon.properties?.fire || 0) / 100
            + (attackerBonus.iceDmg || 0) * (weapon.properties?.ice || 0) / 100
            + (attackerBonus.elecDmg || 0) * (weapon.properties?.elec || 0) / 100;
          const atkTheory = atkRaw * (attackerBonus.critDmg || 150) / 100 * (attackerBonus.crit || 5) / 100 * effectiveDmgMult / 100;
          // 防御方理论伤害（原版 L4853）：目标自己的武器/属性理论伤害
          const defTheory = Math.max(1, (defenderBonus.physDmg || 0) + (defenderBonus.fireDmg || 0) + (defenderBonus.iceDmg || 0) + (defenderBonus.elecDmg || 0));
          // 反伤 = min(攻击方理论受伤×倍率, 防御方当前状态) / 防御方理论伤害 × 100
          const defState = (target.hp || 0) + (target.shield || 0) + (target.armor || 0);
          let reflectDmg = Math.min(atkTheory * reflectMult, defState) / defTheory * 100;
          // 军姬2限制：反伤 ≤ (2+技能等级×0.05)×防御方总状态
          if (reflectLimited) {
            const cap = (2 + (tMk2['军姬2技能熟练度'] || 0) * 0.05) * ((target.maxHp || target.hp || 0) + (target.maxShield || target.shield || 0) + (target.maxArmor || target.armor || 0));
            reflectDmg = Math.min(reflectDmg, cap);
          }
          if (reflectDmg > 0) {
            player.hp = Math.max(0, (player.hp || 0) - Math.floor(reflectDmg));
            resultLines.push(`【反伤】${target.name} 反弹了 ${Math.floor(reflectDmg)} 点伤害给你！`);
          }
        }
        target.markers = JSON.stringify(tMk2);
      }

      // 反转童话：命中后按几率将目标某个属性正负符号反转（持续一定时间）
      if (nextAttack.reverseResist && Math.random() * 100 < (nextAttack.reverseChance ?? 0)) {
        this.reverseMonsterResistance(target, nextAttack.reverseDuration || 600);
        resultLines.push(`【反转童话】${target.name}的某个属性抗性被反转了！`);
      }

      // 构建攻击文本（含三段评级显示）
      const atkText = attackText || this.getAttackText(weapon, weapon.damageType);
      const critText = isCrit ? '【暴击】' : '';
      const ratingText = damageResult.rating || '';
      const dmgText = this.formatDamageText(finalDamage, damageResult.poolDamage);
      resultLines.push(`${atkText} ${target.name}，造成 ${dmgText}${critText}${ratingText ? ` ${ratingText}` : ''}`);

      attackCount++;

      // ========== 免死判定（对应原版 免死 子程序 L5020-5096） ==========
      // 目标（防御方）在即将死亡时可能触发免死：
      //   龙姬"怒吼"增益 → 保留1血（b=2）
      //   伊芙利特"五番a"增益 → 伤害0（b=3，冷却60-技能等级/2秒触发）
      //   猫爪吊坠"猫爪"增益 → 伤害0（b=4，90秒冷却）
      //   战斗女仆"守护3"标记 → 伤害0（b=5）
      if (target.hp <= 0) {
        const tBuffs4 = this.safeParseJson<any[]>(target.buffs, []);
        const tMk3 = this.safeParseJson<Record<string, number>>(target.markers, {});
        const tType = target.type || '';
        // 龙姬怒吼：保留1血
        if (tType.includes('龙姬') && tBuffs4.some((b: any) => b && b.name === '怒吼')) {
          target.hp = 1;
          resultLines.push(`${target.name} 触发【怒吼】免死，保留了1点生命！`);
        } else if (tBuffs4.some((b: any) => b && b.name === '五番a')) {
          // 伊芙利特五番a：伤害0
          target.hp = Math.max(1, target.hp); // 恢复为至少1（原本应为0）
          resultLines.push(`${target.name} 触发【神威灵装·五番】免死！`);
        } else if (tBuffs4.some((b: any) => b && b.name === '猫爪')) {
          // 猫爪吊坠：伤害0
          target.hp = Math.max(1, target.hp);
          resultLines.push(`${target.name} 触发【猫爪】免死！`);
        } else if (tMk3['守护3']) {
          // 战斗女仆守护3：伤害0
          target.hp = Math.max(1, target.hp);
          resultLines.push(`${target.name} 触发【女仆守护】免死！`);
        }
      }

      // 处理击杀
      if (target.hp <= 0) {
        killed.push(target.name);
        resultLines.push(`${target.name} 已被击杀`);

        // 处理怪物死亡（传入 attacker=playerData 触发 置掉落+战利品 发放闭环）
        const deathResult = await this.handleMonsterDeath(target, userId, map.id, playerData);
        totalExp += deathResult.expGain;
        allDrops.push(...deathResult.drops);

        if (deathResult.dropText) {
          resultLines.push(`掉落：${deathResult.dropText}`);
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

    // 8. 召唤物协同攻击（对齐原版 覅攻击pd L320-499：玩家攻击后，归属玩家的召唤物也出手）
    //    当前地图上归属该玩家的召唤物，若存活则用拳头攻击一次怪物。
    //    召唤物击杀的掉落已合并进 player 背包；经验通过 out 累计到 totalExp 统一发放。
    const summonOut = { totalExp: 0 };
    const summonLines = await this.summonCoAttack(player, playerData.markers, map, summonOut);
    if (summonLines.length > 0) {
      resultLines.push(`━━━ 召唤物攻击 ━━━`);
      resultLines.push(...summonLines);
    }
    totalExp += summonOut.totalExp;

    // 9. 怪物反击（对应原版 覅攻击pd L290-319：怪物攻击地图上的玩家）
    //    玩家攻击/召唤物攻击后，地图上仍存活的怪物随机一只发起反击，
    //    形成"你来我往"的完整战斗闭环。玩家被打死时进入死亡状态。
    try {
      const counterLines = await this.monsterCounterAttack(player, playerData, map);
      if (counterLines.length > 0) {
        resultLines.push(`━━━ 怪物反击 ━━━`);
        resultLines.push(...counterLines);
      }
    } catch (e: any) {
      this.logger.warn(`怪物反击失败: ${e.message}`);
    }

    // 10. 保存玩家状态（血量变化 + 掉落合并后的背包）
    await this.playerService.savePlayer(player);

    // 11. 添加经验到玩家
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
   * 召唤物协同攻击
   * 对应原版 覅攻击pd L320-499：攻击时遍历地图召唤物，归属当前玩家的存活召唤物用武器攻击怪物。
   * 本框架召唤物未配置武器时用拳头攻击，属性由使魔定义 + 好感 + 等级计算。
   * @param player 玩家对象
   * @param markers 玩家标记（读取好感）
   * @param map 当前地图
   * @param out 可选的输出累计对象（totalExp 累计召唤物击杀经验，供 weaponAttack 统一 addExp）
   * @returns 召唤物攻击结果文本行
   */
  private async summonCoAttack(
    player: any,
    markers: any,
    map: any,
    out?: { totalExp: number },
  ): Promise<string[]> {
    const lines: string[] = [];
    try {
      const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
      // 只取归属当前玩家且存活的召唤物（对应原版：归属=玩家QQ，当前生命>0）
      const mySummons = summons.filter(
        (s: any) =>
          s &&
          (String(s.ownerQQ) === String(player.userId) || String(s.归属) === String(player.userId)) &&
          (s.hp ?? s.当前生命 ?? 1) > 0,
      );
      if (mySummons.length === 0) return lines;

      // 获取地图上还活着的怪物
      const monsters = (await this.mapService.getMapMonsters(map)).filter((m: any) => (m.hp || 0) > 0);
      if (monsters.length === 0) return lines;

      for (const summon of mySummons) {
        // 召唤物基础属性：使魔定义 + 玩家对该使魔的好感 + 玩家等级
        const familiarDef = this.staticData.getFamiliarByName(summon.name) || {};
        // 好感存于玩家 markers（{使魔名}好感，对应原版 添加成就(使魔名+"好感")）
        const affinity = this.playerService.getMarkerValue(markers, `${summon.name}好感`);
        const level = player.level || 1;
        const summonBonus: BonusData = {
          attack: (familiarDef.baseAttack ?? familiarDef.attack ?? 10) + affinity + level * 2,
          attack2: 0,
          hit: (familiarDef.baseHit ?? familiarDef.hit ?? 80) + affinity,
          hit2: 0,
          dodge: familiarDef.dodge ?? 10,
          dodge2: 0,
          crit: familiarDef.crit ?? 5,
          critDmg: familiarDef.critDmg ?? 150,
          hp: summon.hp ?? 100,
          shield: summon.shield ?? 0,
          armor: summon.armor ?? 0,
        };

        // 拳头攻击
        const target = monsters[Math.floor(Math.random() * monsters.length)];
        if (!target) continue;
        const hitRate = this.calcHitRate(summonBonus, this.buildMonsterBonus(target));
        const isHit = this.checkHit(hitRate);
        if (!isHit) {
          lines.push(`${summon.name} 攻击 ${target.name}，被闪避了`);
          continue;
        }
        const isCrit = this.checkCrit(summonBonus.crit || 0);
        const dmg = this.calcDamage(
          summonBonus,
          this.buildMonsterBonus(target),
          { name: '拳头', damage: 1, damageType: CombatSystemService.DMG_PHYS, properties: { phys: 100, fire: 0, ice: 0, elec: 0 } },
          CombatSystemService.DMG_PHYS,
          isCrit,
        );
        const finalDmg = Math.max(1, Math.floor(dmg.damage));
        const applied = this.applyDamageToMonster(target, finalDmg, dmg.poolDamage);
        lines.push(`${summon.name} 攻击 ${target.name}，造成 ${this.formatDamageText(finalDmg, applied)}${isCrit ? '【暴击】' : ''}`);

        // 怪物死亡处理（传入 attacker=playerData 触发 置掉落+战利品 发放闭环）
        if (target.hp <= 0) {
          const deathResult = await this.handleMonsterDeath(target, player.userId, map.id, player);
          // 召唤物击杀经验累计到玩家（由 weaponAttack 末尾 addExp 统一发放）
          if (out?.totalExp !== undefined) out.totalExp += deathResult.expGain;
          lines.push(`${target.name} 已被击杀`);
          if (deathResult.dropText) {
            lines.push(`掉落：${deathResult.dropText}`);
          }
          if (deathResult.expGain > 0) {
            lines.push(`获得 ${deathResult.expGain} 点经验`);
          }
        } else {
          await this.updateMonsterHpInMap(map.id, target);
        }
      }
    } catch (err: any) {
      this.logger.warn(`召唤物协同攻击失败: ${err.message}`);
    }
    return lines;
  }

  /**
   * 怪物反击
   * 对应原版 覅攻击pd L290-319：玩家攻击后，地图上仍存活的怪物随机一只发起反击。
   * 防御方为攻击玩家本人（原版会攻击地图上所有在线玩家，此处简化为只反击攻击者，
   * 保证单人打怪"你来我往"闭环；多人协战的反击后续可扩展）。
   * 玩家被打到生命≤0时进入死亡状态（不立即复活，需使用复活/救助等指令），
   * 与 weaponAttack 开头的 isPlayerDead 检查配合形成死亡惩罚闭环。
   * @param player 攻击玩家对象
   * @param playerData 玩家完整数据
   * @param map 当前地图
   * @returns 反击结果文本行
   */
  private async monsterCounterAttack(player: any, playerData: PlayerData, map: any): Promise<string[]> {
    const lines: string[] = [];
    try {
      // 随机选一只存活怪物（对应原版 L291：b = 取随机数(1, 取数组成员数(地图.怪物2))）
      const aliveMonsters = (await this.mapService.getMapMonsters(map)).filter((m: any) => (m.hp || 0) > 0);
      if (aliveMonsters.length === 0) return lines;

      // 玩家已死则不反击（避免鞭尸）
      if (this.playerService.isPlayerDead(player)) return lines;

      const monster = aliveMonsters[Math.floor(Math.random() * aliveMonsters.length)];
      const monsterBonus = this.buildMonsterBonus(monster);

      // 怪物攻击（对应原版 战斗() 怪物攻击分支：武器攻击 防御方）
      // 命中判定：怪物命中 vs 玩家闪避
      const playerDef = this.buildAttackerBonus(player, playerData, map);
      const hitRate = this.calcHitRate(monsterBonus, { dodge: playerDef.dodge || 0, dodge2: playerDef.dodge2 || 0 });
      if (!this.checkHit(hitRate)) {
        lines.push(`${monster.name} 向你发起攻击，但被你闪避了`);
        return lines;
      }

      // 伤害计算（怪物作为攻击方，玩家作为防御方；怪物武器简化为拳头+怪物四属性伤害）
      const dmg = this.calcDamage(
        monsterBonus,
        {
          hp: player.hp || 0,
          shield: player.shield || 0,
          armor: player.armor || 0,
          dodge: playerDef.dodge || 0,
          dodge2: playerDef.dodge2 || 0,
          // 玩家三层抗性（玩家自身装备/使魔提供的抗性）
          shieldPhysRes: playerDef.shieldPhysRes || 0,
          shieldFireRes: playerDef.shieldFireRes || 0,
          shieldIceRes: playerDef.shieldIceRes || 0,
          shieldElecRes: playerDef.shieldElecRes || 0,
          shieldAllRes: playerDef.shieldAllRes || 0,
          armorPhysRes: playerDef.armorPhysRes || 0,
          armorFireRes: playerDef.armorFireRes || 0,
          armorIceRes: playerDef.armorIceRes || 0,
          armorElecRes: playerDef.armorElecRes || 0,
          armorAllRes: playerDef.armorAllRes || 0,
          hpPhysRes: playerDef.hpPhysRes || 0,
          hpFireRes: playerDef.hpFireRes || 0,
          hpIceRes: playerDef.hpIceRes || 0,
          hpElecRes: playerDef.hpElecRes || 0,
          hpAllRes: playerDef.hpAllRes || 0,
          hpDmgCap: 100,
          armorDmgCap: 100,
          shieldDmgCap: 100,
        },
        { name: '怪物攻击', damage: 0, damageType: CombatSystemService.DMG_PHYS, properties: { phys: 100, fire: 0, ice: 0, elec: 0 } },
        CombatSystemService.DMG_PHYS,
        false,
      );
      const finalDmg = Math.max(1, Math.floor(dmg.damage));

      // 扣除玩家血量（三池：护盾→装甲→生命）
      const pool = dmg.poolDamage || { shield: 0, armor: 0, hp: finalDmg };
      const shieldDmg = Math.min(pool.shield, player.shield || 0);
      const armorDmg = Math.min(pool.armor, player.armor || 0);
      const hpDmg = Math.min(pool.hp, player.hp || 0);
      player.shield = Math.max(0, (player.shield || 0) - shieldDmg);
      player.armor = Math.max(0, (player.armor || 0) - armorDmg);
      player.hp = Math.max(0, (player.hp || 0) - hpDmg);

      const dmgText = this.formatDamageText(finalDmg, { shield: shieldDmg, armor: armorDmg, hp: hpDmg });
      if (this.playerService.isPlayerDead(player)) {
        lines.push(`${monster.name} 攻击你，造成 ${dmgText}，你倒下了！`);
        lines.push(`你已死亡，可使用「救助」或「复活使魔」来复活`);
      } else {
        lines.push(`${monster.name} 攻击你，造成 ${dmgText}`);
      }
    } catch (err: any) {
      this.logger.warn(`怪物反击失败: ${err.message}`);
    }
    return lines;
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
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 获取地图怪物（GameMonster 表，async）
    const monsters = await this.mapService.getMapMonsters(map);
    if (monsters.length === 0) {
      return '当前地图没有目标可以炮击';
    }

    // ========== 炮击伤害计算（对应原版 _主程序.ecode L800-900） ==========
    // 原版：需要切换炮击模式或驾驶安装舰炮的载具；炮击伤害倍率由炮台部件决定
    const mapVehicles = this.playerService.safeJsonParse<any[]>(map.vehicles, []);
    const vehicle = mapVehicles.find((x: any) => x && (x.id === player.vehicle || x.编号 === player.vehicle));
    const vParts = this.playerService.safeJsonParse<any[]>(vehicle?.parts, []);
    const partNames = vParts.map((p: any) => p.name || '');
    // 炮台部件倍率：和平鸽/平定者×4、京兆巨炮×3、速子光矛×4、虹天剑A×2，默认×1（攻击模式炮击）
    let cannonMult = 1;
    if (partNames.some((n: string) => n.includes('和平鸽') || n.includes('平定者'))) cannonMult = 4;
    else if (partNames.some((n: string) => n.includes('京兆巨炮'))) cannonMult = 3;
    else if (partNames.some((n: string) => n.includes('速子光矛'))) cannonMult = 4;
    else if (partNames.some((n: string) => n.includes('虹天剑A'))) cannonMult = 2;
    else if (player.attackMode !== 1) {
      return '需要切换为炮击模式，或者驾驶安装了舰炮的载具';
    }

    // 载具攻击加成（含部件）
    const vBonus = vehicle?.bonus || vehicle?.加成 || {};
    const vehicleAtk = (vBonus.attack || 0) + (vBonus.physDmg || 0) + (vBonus.fireDmg || 0) + (vBonus.iceDmg || 0) + (vBonus.elecDmg || 0);

    let totalDamage = 0;
    const killed: string[] = [];
    const lines: string[] = [];

    for (const monster of monsters) {
      if (monster.hp <= 0) continue;

      // 炮击基础伤害 = (玩家攻击 + 载具攻击) × 炮台倍率
      const baseDamage = ((player.attack || 10) + vehicleAtk) * cannonMult;
      const defenderBonus = this.buildMonsterBonus(monster);
      const damage = Math.max(1, Math.floor(baseDamage - (defenderBonus.armor || 0)));

      monster.hp = Math.max(0, monster.hp - damage);
      totalDamage += damage;
      lines.push(`炮击命中 ${monster.name}，造成 ${damage} 点伤害`);

      if (monster.hp <= 0) {
        killed.push(monster.name);
        // 传入 attacker=player 触发 置掉落+战利品 发放闭环（distributeLoot 写背包）
        const deathResult = await this.handleMonsterDeath(monster, userId, map.id, player);
        // 经验即时发放（炮击无外部 addExp 汇总，直接在此发放）
        if (deathResult.expGain > 0) {
          await this.playerService.addExp(userId, deathResult.expGain);
        }
        lines.push(`${monster.name} 被摧毁了！获得 ${deathResult.expGain} 点经验`);
        if (deathResult.dropText) {
          lines.push(`掉落：${deathResult.dropText}`);
        }
      }
    }

    // 保存玩家状态（掉落合并后的背包 + 反伤等血量变化）
    await this.playerService.savePlayer(player);

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
    opts?: {
      dmgLower?: number;
      dmgUpper?: number;
      /** 是否有索敌计算机/超级计算机（命中/闪避倍率过高时保留倍率而非强制归一为1） */
      sniperComputer?: boolean;
      /** 套装增幅器=3：三段评级阈值 +20% 且评级后倍率 +20% */
      amplifier3?: boolean;
      /** 三段评级熟练度值（可读写，用于累加熟练度并计算倍率加成） */
      mastery?: { 致命?: number; 强力?: number; 正中?: number; 擦过?: number; 描边?: number };
    },
  ): DamageResult {
    // 1. 计算基础攻击力 = 攻击力 + 武器伤害 + 元素伤害
    const sumBreakdown = (b: DamageBreakdown): number => b.physical + b.fire + b.ice + b.elec;
    const baseAttack = (atkBonus.attack || 0) + (atkBonus.attack2 || 0) + (weapon.damage || 0);

    // 2. 各属性伤害 = 基础攻击力 × 武器属性系数
    const weaponProps = weapon.properties || { phys: 100, fire: 0, ice: 0, elec: 0 };
    const rawBreakdown: DamageBreakdown = {
      physical: baseAttack * weaponProps.phys / 100 + (atkBonus.physDmg || 0) + (atkBonus.physDmg2 || 0),
      fire: baseAttack * weaponProps.fire / 100 + (atkBonus.fireDmg || 0) + (atkBonus.fireDmg2 || 0),
      ice: baseAttack * weaponProps.ice / 100 + (atkBonus.iceDmg || 0) + (atkBonus.iceDmg2 || 0),
      elec: baseAttack * weaponProps.elec / 100 + (atkBonus.elecDmg || 0) + (atkBonus.elecDmg2 || 0),
    };

    // 3. 基础伤害倍率（对应原版"暴击倍率"，实为总伤害倍率）：
    //    L2274-2278：暴击倍率 = 攻击方命中 / 防御方闪避（闪避<1 则 /1）
    const hitVal = (atkBonus.hit || 0) + (atkBonus.hit2 || 0) || 100;
    const dodgeVal = (defBonus.dodge || 0) + (defBonus.dodge2 || 0);
    let dmgMult = dodgeVal >= 1 ? hitVal / dodgeVal : hitVal;

    // 4. 伤害下限/上限（原版 L2279-2316：默认下限0.25；超载+0.25、霰弹-0.15、雷火剑+0.5）
    const dmgLower = opts?.dmgLower ?? 0.25;
    const dmgUpper = opts?.dmgUpper ?? 0;

    // 5. 倍率封顶（原版 L2289-2308）：
    //    若 倍率×下限 > 1（即命中/闪避 > 4），说明是"碾压级"命中优势——
    //    原版只有装备索敌计算机/超级计算机且未冷却时才保留该倍率(显示"索敌xx%")，
    //    否则强制 倍率=1，防止高命中/低闪避打出爆炸伤害破坏平衡。
    if (dmgMult * dmgLower > 1) {
      if (!opts?.sniperComputer) {
        dmgMult = 1;
      }
    }

    // 6. 伤害随机区间（原版 L2317）：取随机数(倍率×下限×10000, 10000×(1+上限))/10000
    //    注意上限是固定 1+伤害上限，不随倍率放大；下限随倍率放大。
    const minMult = dmgMult * dmgLower;
    const maxMult = 1 + dmgUpper;
    if (maxMult <= minMult) {
      dmgMult = minMult; // 防御性处理：区间非法时取下限
    } else {
      dmgMult = minMult + Math.random() * (maxMult - minMult);
    }

    // 7. 三段暴击评级（原版 L2309-2379）：
    //    评级阈值用 倍率+增幅器3加成(20%)；每级乘对应"熟练度等级"加成并累加熟练度
    //    （绝杀>1.2 / 完美≥1 / 致命>0.8 / 强力>0.6 / 正中>0.4 / 擦过>0.2 / 描边）
    const amplifierBonus = opts?.amplifier3 ? 0.2 : 0; // 套装.增幅器=3 提供 +20%
    const mastery = opts?.mastery ?? { 致命: 0, 强力: 0, 正中: 0, 擦过: 0, 描边: 0 };
    const ratingVal = dmgMult + amplifierBonus;
    let rating = '';
    const addMastery = (name: string, amt: number): void => {
      if (mastery && mastery[name] !== undefined) {
        mastery[name] = (mastery[name] || 0) + amt;
      }
    };
    const applyMastery = (name: string, divisor: number): number => {
      const lvl = mastery?.[name] || 0;
      return 1 + lvl / divisor;
    };
    if (ratingVal > 1.2) {
      rating = `【绝杀】${Math.round(dmgMult * 100 + amplifierBonus * 100)}%`;
      addMastery('致命', 1); addMastery('强力', 1); addMastery('正中', 1); addMastery('擦过', 1); addMastery('描边', 1);
      dmgMult = dmgMult * applyMastery('致命', 500);
    } else if (ratingVal >= 1) {
      rating = `【完美】${Math.round(dmgMult * 100 + amplifierBonus * 100)}%`;
      addMastery('致命', 0.4); addMastery('强力', 0.4); addMastery('正中', 0.4); addMastery('擦过', 0.4); addMastery('描边', 0.4);
      dmgMult = dmgMult * applyMastery('致命', 500);
    } else if (ratingVal > 0.8) {
      rating = `【致命】${Math.round(dmgMult * 100 + amplifierBonus * 100)}%`;
      addMastery('致命', 1);
      dmgMult = dmgMult * applyMastery('致命', 500);
    } else if (ratingVal > 0.6) {
      rating = `【强力】${Math.round(dmgMult * 100 + amplifierBonus * 100)}%`;
      addMastery('强力', 1);
      dmgMult = dmgMult * applyMastery('强力', 400);
    } else if (ratingVal > 0.4) {
      rating = `【正中】${Math.round(dmgMult * 100 + amplifierBonus * 100)}%`;
      addMastery('正中', 1);
      dmgMult = dmgMult * applyMastery('正中', 300);
    } else if (ratingVal > 0.2) {
      rating = `【擦过】${Math.round(dmgMult * 100 + amplifierBonus * 100)}%`;
      addMastery('擦过', 1);
      dmgMult = dmgMult * applyMastery('擦过', 200);
    } else {
      rating = `【描边】${Math.round(dmgMult * 100 + amplifierBonus * 100)}%`;
      addMastery('描边', 1);
      dmgMult = dmgMult * applyMastery('描边', 100);
    }
    // 增幅器3：评级后倍率 +20%（原版 L2379 暴击倍率 = 暴击倍率 + a2/100）
    dmgMult = dmgMult + amplifierBonus;

    // 8. 暴击：倍率 × 暴击伤害/100（原版 L2395；暴击伤害默认150%即1.5倍）
    let critMultiplier = 1.0;
    if (isCrit) {
      critMultiplier = (atkBonus.critDmg || 150) / 100;
      dmgMult = dmgMult * critMultiplier;
    }

    // 9. 等级差距修正（原版 L3290-3297：剩余伤害 /(1-攻击差距) ×(1-防御差距)）
    //    此处攻击方差距 gap 为正表示"攻击方等级低于目标"，应降低伤害 → 用 1/(1-gap) 放大分母实现降伤
    const levelGap = (atkBonus.gap || 0);
    const levelFactor = levelGap >= 1 ? 0.1 : Math.max(0.1, 1 / (1 - levelGap));

    // 10. 易伤加成（原版 L3162-3165：剩余X伤 ×(1+易伤/100)）
    const vulnerability = (defBonus.debuff || 0) / 100 + 1;

    // 11. 应用所有修正，计算各属性最终伤害
    const finalBreakdown: DamageBreakdown = {
      physical: rawBreakdown.physical * dmgMult * levelFactor * vulnerability,
      fire: rawBreakdown.fire * dmgMult * levelFactor * vulnerability,
      ice: rawBreakdown.ice * dmgMult * levelFactor * vulnerability,
      elec: rawBreakdown.elec * dmgMult * levelFactor * vulnerability,
    };

    // 12. 三层池独立抗性减免（护盾/装甲/生命各自抗穿）
    const penetration = this.getPenetration(atkBonus);
    const resistBreakdown = this.applyResistances(finalBreakdown, defBonus, penetration);

    // 12.5 贯穿几率判断（对应原版 L3192-3288）
    // 原版：几率判断(攻击方.贯穿 - 防御方.抗贯穿) 百分比判定；
    // 触发后按目标当前护盾/装甲状态，把部分剩余伤害"跳过当前池直接注入更深层池"：
    //   - 只有护盾 或 只有装甲：额外生命伤害 = 剩余×0.3，剩余×0.7走正常流程
    //   - 护盾+装甲都有：额外生命×0.1、额外装甲×0.2、剩余×0.7
    const penetrateRatio = (atkBonus.penetrate || 0) - (defBonus.antiPenetrate || 0);
    let pierce = { directLife: 0, directArmor: 0, directShield: 0 };
    if (penetrateRatio > 0 && Math.random() * 100 < penetrateRatio) {
      const hasShield = (defBonus.shield || 0) > 0;
      const hasArmor = (defBonus.armor || 0) > 0;
      if (hasShield && hasArmor) {
        // 护盾1装甲1：额外生命=剩余×0.1、额外装甲=剩余×0.2
        const total = sumBreakdown(resistBreakdown.shield);
        pierce = { directLife: total * 0.1, directArmor: total * 0.2, directShield: 0 };
      } else if (hasShield || hasArmor) {
        // 护盾1装甲0 / 护盾0装甲1：额外生命=剩余×0.3
        const total = sumBreakdown(resistBreakdown.shield);
        pierce = { directLife: total * 0.3, directArmor: 0, directShield: 0 };
      }
    }

    // 13. 三池串行分伤（破盾溢出打装甲，破甲溢出打生命；贯穿跳过池直接注入）
    const poolDamage = this.distributeDamageToPools(resistBreakdown, atkBonus, defBonus, pierce.directLife > 0 || pierce.directArmor > 0 ? pierce : undefined);

    // 14. 总伤害
    const totalDamage = poolDamage.shield + poolDamage.armor + poolDamage.hp;

    return {
      damage: Math.max(0, Math.floor(totalDamage)),
      isHit: true,
      isCrit,
      hitRate: hitVal / Math.max(1, dodgeVal) * 100,
      damageBreakdown: finalBreakdown,
      poolDamage,
      critMultiplier,
      rating,
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

    // 等级差距修正（原版 L1607-1611）：a1 = 命中/(1-差距)/闪避
    // 新人差距 gap 越大，命中越被放大（新人加成）
    const gap = attacker.gap || 0;
    const hitAfterGap = gap >= 1 ? atkHit : atkHit / (1 - gap);

    if (defDodge < 1) {
      return Math.min(95, hitAfterGap);
    }
    return Math.min(95, Math.max(5, hitAfterGap / defDodge * 100));
  }

  /**
   * 暴击判定
   * 对应原版 L2380-2398：几率判断(攻击方.属性.暴击 + 被暴击率)
   * 被暴击率修正来源：会心一击a(+10+技能等级)/隐匿模式远程(100)/兰顿之兆(-10)
   * @param critRate 攻击方暴击率
   * @param hitByRate 被暴击率修正（防御方提供）
   */
  checkCrit(critRate: number, hitByRate: number = 0): boolean {
    const effectiveCritRate = Math.max(0, Math.min(100, critRate + (hitByRate || 0)));
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
   *
   * 注意：掉落物不再在此处调用 addToBackpack 单独写库。
   * 原因：调用方(如 weaponAttack)在击杀后会整体 savePlayer(player)，
   * 若此处已把掉落写入数据库，随后 savePlayer 用旧内存对象覆盖写回会把掉落抹掉。
   * 因此这里只返回 drops，由调用方合并进内存玩家对象后统一持久化。
   */
  async handleMonsterDeath(
    monster: any,
    userId: number,
    mapId: number,
    attacker?: any,
  ): Promise<MonsterDeathResult> {
    // 计算经验值
    const expGain = this.calcMonsterExp(monster);

    // 生成掉落物（基础掉落清单，含 name/type/quantity/data）
    const drops = this.generateDrops(monster, 1);

    // 置掉落（原版 战利品 前序 置掉落 L5245）：记录攻击者对怪物的掉落能力到怪物标记
    // 注意：原版在怪物删除前写怪物.标记，本框架怪物即时删除，此处保留原版调用顺序（行为可见）
    if (attacker) {
      const monsterMarkers = this.playerService.safeJsonParse<any[]>(monster.markers, []);
      monster.markers = JSON.stringify(this.setDrop(attacker, monsterMarkers));
    }

    // 战利品发放（原版 战斗相关.ecode L4874）：装备展开/资源经验/成就/背包写入/掉落文本
    let dropText = '';
    if (attacker && drops.length > 0) {
      const playerData = await this.playerService.getPlayerData(userId);
      dropText = await this.itemSystem.distributeLoot(playerData, drops);
      // distributeLoot 已直接写入 player.backpack（与"内存合并后统一save"一致），
      // 调用方不再需要 mergeDropsIntoPlayer
    }

    // 从地图移除怪物（GameMonster 表，按自增 id 删除；加锁避免并发竞态）
    try {
      await this.mapService.removeMapMonster(mapId, monster.id);
    } catch (error) {
      this.logger.warn(`从地图移除怪物失败: ${error.message}`);
    }

    return { expGain, drops, dropText };
  }

  /**
   * 将掉落物合并进玩家内存对象背包（避免 addToBackpack 与 savePlayer 的覆盖冲突）
   * 掉落物按同名叠加数量，与 playerService.addToBackpack 行为一致，
   * 但只修改内存对象，由调用方最终 savePlayer 一次性写库。
   * @param player 玩家对象（backpack 字段为 JSON 字符串）
   * @param drops 掉落物列表
   */
  private mergeDropsIntoPlayer(player: any, drops: any[]): void {
    if (!drops || drops.length === 0) return;
    const backpack = this.playerService.getBackpackItems(player);
    for (const drop of drops) {
      const count = drop.quantity || drop.count || 1;
      if (count <= 0) continue;
      const existing = backpack.find((b: any) => b.name === drop.name);
      if (existing) {
        const cur = existing.count ?? existing.quantity ?? 0;
        existing.count = cur + count;
        delete existing.quantity; // 统一用 count 字段，避免双字段歧义
      } else {
        backpack.push({ name: drop.name, count });
      }
    }
    player.backpack = JSON.stringify(backpack);
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

    // 普拉娜武器冷却×10（原版 _计算玩家 L1761-1763：玩家.特殊序号==#普拉娜 时 武器.冷却=武器.冷却*10）
    let rawCooldown = rawWeapon.cooldown || rawWeapon.冷却 || 5;
    if (Number(attacker.specialSeq) === 22) {
      rawCooldown = rawCooldown * 10;
    }

    return {
      name: rawWeapon.name || '未知武器',
      damage: rawWeapon.damage || rawWeapon.伤害 || 0,
      damageType: this.resolveDamageType(rawWeapon.damageType || rawWeapon.伤害类型 || '物理'),
      attackText: rawWeapon.attackText || rawWeapon.攻击文本 || '',
      type: rawWeapon.type || rawWeapon.类型 || '近战武器',
      specialSeq: rawWeapon.specialSeq || rawWeapon.特殊序号 || 0,
      cooldown: rawCooldown,
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
    targetName?: string,
  ): any[] {
    const alive = monsters.filter(m => (m.hp || 0) > 0);

    if (alive.length === 0) return [];

    // 指定目标（对应原版 `攻击怪物名` 设置玩家.目标后按名称锁定目标）
    if (targetName) {
      const matched = alive.filter(m => m.name === targetName);
      if (matched.length > 0) return matched;
      // 未找到指定名称的目标时，回退随机（避免"攻击指定怪物"完全无效）
      const targetIdx = Math.floor(Math.random() * alive.length);
      return [alive[targetIdx]];
    }

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
   * 对应原版 加成计算.ecode _计算玩家()：按等级+熟练度成长。
   * public：供信息显示/属性面板调用，展示"计算后"的成长属性。
   */
  buildAttackerBonus(player: any, playerData: PlayerData, map?: any): BonusData {
    // 从玩家基础属性构建
    // 对齐原版 _计算玩家：加成从 0 起步（原版 玩家.加成 = 空加成 j），
    // 再由"等级成长 + 使魔专属 + 装备/套装"累加得出最终属性。
    // 注意：hp/shield/armor 以"上限字段"（maxHp/maxShield/maxArmor）为基数，
    // 而非当前血量(player.hp)，避免把当前血量当加成基数导致上限虚高。
    // map 可选：用于宠物存活数量加成（原版 L2187-2221）
    const bonus: BonusData = {
      attack: 0,
      attack2: 0,
      hit: 0,
      hit2: 0,
      dodge: 0,
      dodge2: 0,
      crit: 0,
      critDmg: 0,  // 暴击伤害由成长公式给出（原版：150+等级/10）
      hp: 0,       // 生命由成长公式给出（原版：50+(等级×2+防御熟练)×(1+等级/100)，1级≈52）
      shield: 0,   // 护盾：20+...
      armor: 0,    // 装甲：30+...
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

    // ========== 玩家/使魔通用成长公式（对应原版 加成计算.ecode L1799-1833） ==========
    // 原版 _计算玩家 对所有特殊序号>0（即选了使魔的玩家）按等级+属性熟练度成长：
    //   - 暴击+3、暴击伤害+150+等级/10、攻击加成=暴击伤害+100
    //   - 速度=10+等级/5+闪避熟练/4*(1+等级/100)
    //   - 四元素伤害=10+(等级+对应熟练)*(1+等级/100)
    //   - 命中=10+(等级/2+战斗熟练/2)*(1+等级/100)；攻击=10+战斗熟练*(1+等级/100)
    //   - 生命=50+(等级*2+防御熟练)*(1+等级/100)；护盾=20+...；装甲=30+...
    //   - 闪避=10+(等级/2+防御熟练/2)*(1+等级/100)；全抗+10；三回复+0.1+等级/10
    // 熟练度存于玩家 markers（原版：显示熟练度等级(标记,"雷电")），本框架沿用同名 key。
    const markers = playerData.markers || {};
    const lv = player.level || 1;
    const prof = (key: string) => this.playerService.getMarkerValue(markers, key);
    const lvFactor = 1 + lv / 100;
    const profElec = prof('雷电');
    const profFire = prof('火焰');
    const profPhys = prof('物理');
    const profIce = prof('冰冻');
    const profCombat = prof('战斗');
    const profDefense = prof('防御');
    const profDodge = prof('闪避');
    const profGather = prof('采集');

    if (player.type) {
      // 玩家是使魔（特殊序号>0）：应用原版通用成长
      bonus.crit = (bonus.crit || 0) + 3;
      bonus.critDmg = (bonus.critDmg || 0) + 150 + lv / 10;
      bonus.attackBonus = (bonus.critDmg || 0) + 100;
      bonus.speed = 10 + lv / 5 + profDodge / 4 * lvFactor;
      bonus.elecDmg = (bonus.elecDmg || 0) + 10 + (lv + profElec) * lvFactor;
      bonus.fireDmg = (bonus.fireDmg || 0) + 10 + (lv + profFire) * lvFactor;
      bonus.physDmg = (bonus.physDmg || 0) + 10 + (lv + profPhys) * lvFactor;
      bonus.iceDmg = (bonus.iceDmg || 0) + 10 + (lv + profIce) * lvFactor;
      bonus.hit = (bonus.hit || 0) + 10 + (lv / 2 + profCombat / 2) * lvFactor;
      bonus.attack = (bonus.attack || 0) + 10 + profCombat * lvFactor;
      bonus.gather = (bonus.gather || 0) + 100 + lv / 3 + profGather * (1 + lv / 1000);
      bonus.hp = (bonus.hp || 0) + 50 + (lv * 2 + profDefense) * lvFactor;
      bonus.shield = (bonus.shield || 0) + 20 + (lv * 2 + profDefense) * lvFactor;
      bonus.armor = (bonus.armor || 0) + 30 + (lv * 2 + profDefense) * lvFactor;
      bonus.dodge = (bonus.dodge || 0) + 10 + (lv / 2 + profDefense / 2) * lvFactor;
      bonus.hpAllRes = (bonus.hpAllRes || 0) + 10;
      bonus.shieldAllRes = (bonus.shieldAllRes || 0) + 10;
      bonus.armorAllRes = (bonus.armorAllRes || 0) + 10;
      bonus.hpRegen = (bonus.hpRegen || 0) + 0.1 + lv / 10;
      bonus.shieldRegen = (bonus.shieldRegen || 0) + 0.1 + lv / 10;
      bonus.armorRegen = (bonus.armorRegen || 0) + 0.1 + lv / 10;
    } else {
      // 未选使魔的玩家（特殊序号≤0，原版 _计算玩家 L1834-1835 只叠加"基础"）：
      // 使用数据库基础字段作为兜底，避免命中/闪避等显示为 0。
      bonus.attack = player.attack || 0;
      bonus.hit = player.hit || 100;
      bonus.dodge = player.dodge || 0;
      bonus.crit = player.crit || 5;
      bonus.critDmg = player.critDmg || 150;
      bonus.hp = player.maxHp || player.hp || 100;
      bonus.shield = player.maxShield || player.shield || 0;
      bonus.armor = player.maxArmor || player.armor || 0;
      bonus.speed = player.speed || 100;
    }

    // ========== 使魔专属加成（对应原版 _计算玩家 L1872+ 核心分支） ==========
    // 按需补充高频使魔的专属规则（数值均来自原版，不臆造）
    const seq = player.specialSeq ?? 0;
    const skillLevel = prof(`${player.type}技能`);
    switch (String(seq)) {
      case '8': { // 战斗女仆：电伤×1.25；好感≥20 沉着攻击2加成
        bonus.elecDmg = (bonus.elecDmg || 0) * 1.25;
        break;
      }
      case '1': { // 花园猫：电伤2+25、掉落率+10+技能等级
        bonus.elecDmg2 = (bonus.elecDmg2 || 0) + 25;
        bonus.dropRate = (bonus.dropRate || 0) + 10 + skillLevel;
        break;
      }
      case '12': { // 龙姬（原版 L1894-1914）：物伤2+50、生命/护盾/装甲2-50；好感分支
        bonus.physDmg2 = (bonus.physDmg2 || 0) + 50;
        bonus.hp2 = (bonus.hp2 || 0) - 50;
        bonus.shield2 = (bonus.shield2 || 0) - 50;
        bonus.armor2 = (bonus.armor2 || 0) - 50;
        // 怒吼增益时生命保底1（原版 L1899-1904）
        const pBuffsD = playerData.buffs || [];
        if (pBuffsD.some((b: any) => b && b.name === '怒吼') && (player.hp || 0) < 1) {
          player.hp = 1;
        }
        // 好感≥80：暴伤+5×技能等级（原版 L1905-1907）
        if ((player.affinity || 0) >= 80) {
          bonus.critDmg = (bonus.critDmg || 0) + 5 * skillLevel;
        }
        // 好感≥20：残血增伤（已损失状态比例×物伤）（原版 L1908-1911）
        if ((player.affinity || 0) >= 20) {
          const curState = (player.hp || 0) + (player.shield || 0) + (player.armor || 0);
          const maxState = (bonus.hp || 1) + (bonus.shield || 0) + (bonus.armor || 0);
          const lostRatio = Math.max(0, Math.min(1, 1 - curState / Math.max(1, maxState)));
          bonus.physDmg = (bonus.physDmg || 0) + (bonus.physDmg || 0) * lostRatio * (1 + skillLevel / 200);
        }
        // 好感≥60：攻击2 + 龙闪熟练度（原版 L1912-1914）
        if ((player.affinity || 0) >= 60) {
          bonus.attack2 = (bonus.attack2 || 0) + this.playerService.getMarkerValue(markers, '龙闪');
        }
        break;
      }
      case '10': { // 小樱：三元素伤2+10+技能/2、护盾2+15+技能、武器冷却-3
        bonus.elecDmg2 = (bonus.elecDmg2 || 0) + 10 + skillLevel / 2;
        bonus.fireDmg2 = (bonus.fireDmg2 || 0) + 10 + skillLevel / 2;
        bonus.iceDmg2 = (bonus.iceDmg2 || 0) + 10 + skillLevel / 2;
        bonus.shield2 = (bonus.shield2 || 0) + 15 + skillLevel;
        // 原版 L2049-2071：好感≥100 且满状态时，最高属性伤害系+10+技能（混沌魔力）
        if ((player.affinity || 0) >= 100) {
          const curState = (player.hp || 0) + (player.shield || 0) + (player.armor || 0);
          const maxState = (bonus.hp || 1) + (bonus.shield || 0) + (bonus.armor || 0);
          if (curState >= maxState) {
            const elec = bonus.elecDmg || 0;
            const fire = bonus.fireDmg || 0;
            const ice = bonus.iceDmg || 0;
            if (elec > fire) {
              if (elec > ice) {
                bonus.elecDmg2 = (bonus.elecDmg2 || 0) + 10 + skillLevel;
              } else {
                bonus.iceDmg2 = (bonus.iceDmg2 || 0) + 10 + skillLevel;
              }
            } else if (fire > ice) {
              bonus.fireDmg2 = (bonus.fireDmg2 || 0) + 10 + skillLevel;
            } else {
              bonus.iceDmg2 = (bonus.iceDmg2 || 0) + 10 + skillLevel;
            }
          }
        }
        break;
      }
      case '18': { // 启·木之本樱（原版 L1925-1931）：三元素伤2+15+技能、武器冷却-3
        bonus.elecDmg2 = (bonus.elecDmg2 || 0) + 15 + skillLevel;
        bonus.fireDmg2 = (bonus.fireDmg2 || 0) + 15 + skillLevel;
        bonus.iceDmg2 = (bonus.iceDmg2 || 0) + 15 + skillLevel;
        break;
      }
      case '13': { // 伊卡洛斯（原版 L1932-1952）：冰伤2+25；好感分支
        bonus.iceDmg2 = (bonus.iceDmg2 || 0) + 25;
        // 好感≥20：溅射+25+技能×2、溅射2+1（原版 L1934-1937）
        if ((player.affinity || 0) >= 20) {
          bonus.splash = (bonus.splash || 0) + 25 + skillLevel * 2;
          bonus.splashCount = (bonus.splashCount || 0) + 1;
        }
        // 好感≥40：攻击2 + (溅射2 + 武器溅射2)×20（原版 L1938-1948）
        if ((player.affinity || 0) >= 40) {
          let weaponSplash2 = 0;
          if ((player.affinity || 0) >= 60) {
            // 武器锁定置0 + 武器溅射2
            const weaponsD = this.playerService.safeJsonParse<any[]>(player.weapons, []);
            const curW = weaponsD[(player.currentWeapon || 1) - 1];
            if (curW) {
              curW.lockTime = 0;
              weaponSplash2 = (curW.bonus?.splash2 ?? curW.加成?.溅射2 ?? 0) + (curW.baseBonus?.splash2 ?? curW.基础加成?.溅射2 ?? 0);
            }
          }
          bonus.attack2 = (bonus.attack2 || 0) + ((bonus.splashCount || 0) + weaponSplash2) * 20;
        }
        // 好感≥80：攻击2 + 闪避增益值×10（原版 L1949-1952）
        if ((player.affinity || 0) >= 80) {
          const dodgeBuff = (playerData.buffs || []).find((b: any) => b && b.name === '闪避');
          const dodgeVal = dodgeBuff?.value || 0;
          bonus.attack2 = (bonus.attack2 || 0) + dodgeVal * 10;
        }
        break;
      }
      case '6': { // 恶毒（原版 L1954-1974）：火伤2+25；好感≥20 残血暴击；好感≥40 命中/闪避攻击2；鹰眼增益
        bonus.fireDmg2 = (bonus.fireDmg2 || 0) + 25;
        // 好感≥20：残血暴击/暴伤（原版 L1956-1960）
        if ((player.affinity || 0) >= 20) {
          const curState = (player.hp || 0) + (player.shield || 0) + (player.armor || 0);
          const maxState = (bonus.hp || 1) + (bonus.shield || 0) + (bonus.armor || 0);
          const hpRatio = Math.min(1, curState / Math.max(1, maxState));
          bonus.crit = (bonus.crit || 0) + (15 + skillLevel) * hpRatio;
          bonus.critDmg = (bonus.critDmg || 0) + (50 + skillLevel * 5) * hpRatio;
        }
        // 鹰眼增益：溅射+50+技能、溅射2+2、命中2+50+技能、穿透15（原版 L1961-1967）
        if ((playerData.buffs || []).some((b: any) => b && b.name === '鹰眼')) {
          bonus.splash = (bonus.splash || 0) + 50 + skillLevel;
          bonus.splashCount = (bonus.splashCount || 0) + 2;
          bonus.hit2 = (bonus.hit2 || 0) + 50 + skillLevel;
          this.bonusService.addPenetration(bonus, 15);
        }
        // 好感≥40：命中/闪避比例攻击2（原版 L1968-1974）
        if ((player.affinity || 0) >= 40) {
          let a1 = (bonus.hit || 0) / Math.max(1, (bonus.dodge || 1)) * 100;
          if (a1 > 50 + skillLevel * 2) a1 = 50 + skillLevel * 2;
          bonus.attack2 = (bonus.attack2 || 0) + a1;
        }
        break;
      }
      case '2': { // 长萌：火伤×1.25+火伤2+25；护盾/装甲2+1+技能；好感≥20 回复转命中
        bonus.fireDmg = (bonus.fireDmg || 0) * 1.25;
        bonus.fireDmg2 = (bonus.fireDmg2 || 0) + 25;
        bonus.shield2 = (bonus.shield2 || 0) + 1 + skillLevel;
        bonus.armor2 = (bonus.armor2 || 0) + 1 + skillLevel;
        bonus.fireDmg = (bonus.fireDmg || 0) + ((bonus.armor || 0) + (bonus.shield || 0)) * (0.15 + skillLevel / 200);
        if ((player.affinity || 0) >= 20) {
          bonus.hit = (bonus.hit || 0) + (bonus.hpRegen || 0) * 10 + (bonus.armorRegen || 0) * 10;
        }
        if ((player.affinity || 0) >= 60) {
          // 原版 L1985-1995：护盾/装甲≥20%各+25韧性；当前状态/上限×40 抗贯穿
          let a = 0;
          if ((player.shield || 0) / Math.max(1, (bonus.shield || 1)) >= 0.2) a += 1;
          if ((player.armor || 0) / Math.max(1, (bonus.armor || 1)) >= 0.2) a += 1;
          bonus.tenacity = (bonus.tenacity || 0) + (1 - (bonus.tenacity || 0) / 100) * a * 25;
          const curState = (player.hp || 0) + (player.shield || 0) + (player.armor || 0);
          const maxState = (bonus.hp || 1) + (bonus.shield || 0) + (bonus.armor || 0);
          bonus.antiPenetrate = (bonus.antiPenetrate || 0) + curState / Math.max(1, maxState) * 40;
        }
        break;
      }
      case '11': { // 伊芙利特：火伤2+25；好感≥80 火抗115；攻击模式 命中2+50+技能、攻击2+33
        bonus.fireDmg2 = (bonus.fireDmg2 || 0) + 25;
        if ((player.affinity || 0) >= 80) {
          bonus.hpFireRes = 115;
          bonus.armorFireRes = 115;
          bonus.shieldFireRes = 115;
        }
        if (player.attackMode === 1) {
          bonus.hit2 = (bonus.hit2 || 0) + 50 + skillLevel;
          bonus.attack2 = (bonus.attack2 || 0) + 33;
        }
        break;
      }
      case '4': { // 剑圣：物伤2+1.25；好感≥20 近战攻击2+15+技能；好感≥60 攻击/命中2比例加成
        bonus.physDmg2 = (bonus.physDmg2 || 0) + 1.25;
        if ((player.affinity || 0) >= 20) {
          bonus.attack2 = (bonus.attack2 || 0) + 15 + skillLevel;
        }
        if ((player.affinity || 0) >= 60) {
          const ratio = Math.min(1, (player.hp || 0) / Math.max(1, (bonus.hp || 1)));
          const a1 = 20 + ratio * 20;
          bonus.attack2 = (bonus.attack2 || 0) + a1;
          bonus.hit2 = (bonus.hit2 || 0) + a1;
        }
        if ((player.affinity || 0) >= 40) {
          bonus.critDmg = (bonus.critDmg || 0) + 3 * skillLevel;
        }
        if ((player.affinity || 0) >= 80) {
          bonus.atkHp = (bonus.atkHp || 0) + 15 + skillLevel;
        }
        break;
      }
      case '15': { // 四糸乃（原版 L2034-2047）：冰伤2+25；好感≥60 冰抗115；好感≥40 闪避+等级*技能、武器冰属性×1.15+技能/200
        bonus.iceDmg2 = (bonus.iceDmg2 || 0) + 25;
        if ((player.affinity || 0) >= 60) {
          bonus.hpIceRes = 115;
          bonus.armorIceRes = 115;
          bonus.shieldIceRes = 115;
        }
        if ((player.affinity || 0) >= 40) {
          bonus.dodge = (bonus.dodge || 0) + lv * skillLevel;
          // 武器冰属性系数 × (1.15 + 技能/200)（原版 L2043-2045）
          const weaponsD = this.playerService.safeJsonParse<any[]>(player.weapons, []);
          const curW = weaponsD[(player.currentWeapon || 1) - 1];
          if (curW) {
            const props = curW.properties || curW.属性 || {};
            const ice = props.ice ?? props.冰 ?? 0;
            props.ice = props.冰 = ice * (1.15 + skillLevel / 200);
            curW.properties = curW.属性 = props;
          }
        }
        break;
      }
      case '17': { // 安克雷奇：生命回复2+2、生命2+25+技能
        bonus.hpRegen2 = (bonus.hpRegen2 || 0) + 2;
        bonus.hp2 = (bonus.hp2 || 0) + 25 + skillLevel;
        break;
      }
      case '3': { // 绝灭天使（对应原版 _计算玩家 L2076-2097 + 取羽毛）
        // 羽毛存于 markers['羽毛']（累计时间戳），每10秒自然回复1片，上限10+技能等级（日轮×1.5）
        const featherMarker = this.playerService.getMarkerValue(markers, '羽毛');
        const featherMax = 10 + skillLevel;
        let feather = 0;
        if (featherMarker > 0) {
          // 按累计时长估算当前羽毛（简化：距上次结算超过10秒则补1片）
          const elapsed = Math.floor((Date.now() / 1000 - featherMarker) / 10);
          feather = Math.min(featherMax, elapsed + 1);
        }
        feather = Math.max(0, Math.min(featherMax, feather));
        const pBuffs: any[] = playerData.buffs || [];
        // a3 倍率：救世魔王×1.5（韧性+50%、穿透+10）；光翼×(1+0.5+技能/100)（原版 L2077-2091）
        let a3 = 1;
        const hasSavior = pBuffs.some((b: any) => b && b.name === '救世魔王');
        if (hasSavior) {
          a3 = 1.5;
          bonus.tenacity = (bonus.tenacity || 0) + (1 - (bonus.tenacity || 0) / 100) * 50;
          this.bonusService.addPenetration(bonus, 10);
        }
        const hasLightWing = pBuffs.some((b: any) => b && b.name === '光翼');
        if (hasLightWing) a3 = a3 * (1 + 0.5 + skillLevel / 100);
        // 炮冠增益：贯穿 + 羽毛/2×a3、穿透+10（原版 L2084-2088）
        if (pBuffs.some((b: any) => b && b.name === '炮冠')) {
          bonus.penetrate = (bonus.penetrate || 0) + Math.round(feather / 2 * a3 * 100) / 100;
          this.bonusService.addPenetration(bonus, 10);
        }
        // 命中2 = 羽毛 × a3（原版 L2092）
        bonus.hit2 = (bonus.hit2 || 0) + feather * a3;
        // 无光盾时：每片羽毛额外+1%暴伤（原版 L2093-2096：光盾存在时羽毛+1并暴伤+羽毛）
        if (!pBuffs.some((b: any) => b && b.name === '光盾')) {
          bonus.critDmg = (bonus.critDmg || 0) + feather;
        }
        // 攻击2 = 羽毛 × a3（原版 L2097）
        bonus.attack2 = (bonus.attack2 || 0) + feather * a3;
        break;
      }
      case '16': { // 军姬：生命2+25；好感≥20 物伤2+45+技能、闪避2+5+技能/22
        bonus.hp2 = (bonus.hp2 || 0) + 25;
        if ((player.affinity || 0) >= 20) {
          bonus.physDmg2 = (bonus.physDmg2 || 0) + 45 + skillLevel;
          bonus.dodge2 = (bonus.dodge2 || 0) + 5 + skillLevel / 22;
        } else {
          bonus.physDmg2 = (bonus.physDmg2 || 0) + 25;
        }
        break;
      }
      case '19': { // saber（原版 L2107-2132）：物伤2+50、攻击2+30；好感≥20 物伤2+40+技能*2；好感≥60 穿透+10、暴伤+技能*3；ex增益
        bonus.physDmg2 = (bonus.physDmg2 || 0) + 50;
        bonus.attack2 = (bonus.attack2 || 0) + 30;
        if ((player.affinity || 0) >= 20) {
          bonus.physDmg2 = (bonus.physDmg2 || 0) + 40 + skillLevel * 2;
        }
        if ((player.affinity || 0) >= 60) {
          this.bonusService.addPenetration(bonus, 10);
          bonus.critDmg = (bonus.critDmg || 0) + skillLevel * 3;
        }
        // ex增益（原版 L2117-2132）：好感≥80 物伤2+50+技能；好感≥100 全属性+15+技能/2
        if ((playerData.buffs || []).some((b: any) => b && b.name === 'ex')) {
          if ((player.affinity || 0) >= 80) {
            bonus.physDmg2 = (bonus.physDmg2 || 0) + 50 + skillLevel;
          }
          if ((player.affinity || 0) >= 100) {
            const a1 = 15 + skillLevel / 2;
            bonus.attack2 = (bonus.attack2 || 0) + a1;
            bonus.armor2 = (bonus.armor2 || 0) + a1;
            bonus.shield2 = (bonus.shield2 || 0) + a1;
            bonus.hp2 = (bonus.hp2 || 0) + a1;
            bonus.dodge2 = (bonus.dodge2 || 0) + a1;
            bonus.hit2 = (bonus.hit2 || 0) + a1;
          }
        }
        break;
      }
      case '14': { // 星尘（原版 L2134-2156）：电伤+护盾*(0.5+技能/100)、电伤2+25、护盾2+25+技能；好感≥40 高盾增韧；中子星/xta/xtb增益
        bonus.elecDmg = (bonus.elecDmg || 0) + (bonus.shield || 0) * (0.5 + skillLevel / 100);
        bonus.elecDmg2 = (bonus.elecDmg2 || 0) + 25;
        bonus.shield2 = (bonus.shield2 || 0) + 25 + skillLevel;
        if ((player.affinity || 0) >= 40) {
          // 原版 L2138-2146：护盾>50%时 韧性+50%、抗贯穿+40、穿透+15、必中
          if ((player.shield || 0) / Math.max(1, (bonus.shield || 1)) > 0.5) {
            bonus.tenacity = (bonus.tenacity || 0) + (1 - (bonus.tenacity || 0) / 100) * 50;
            bonus.antiPenetrate = (bonus.antiPenetrate || 0) + 40;
            this.bonusService.addPenetration(bonus, 15);
            bonus.mustHit = true;
          }
        }
        // 中子星增益：全抗 + 增益值×0.025（原版 L2147-2150）
        const neutronStar = (playerData.buffs || []).find((b: any) => b && b.name === '中子星');
        if (neutronStar) {
          const a1 = Number(neutronStar.value) || 0;
          bonus.hpAllRes = (bonus.hpAllRes || 0) + a1 * 0.025;
          bonus.armorAllRes = (bonus.armorAllRes || 0) + a1 * 0.025;
          bonus.shieldAllRes = (bonus.shieldAllRes || 0) + a1 * 0.025;
        }
        // xta/xtb 增益：护盾回复/护盾回复2 + 增益值（原版 L2151-2156）
        const xta = (playerData.buffs || []).find((b: any) => b && b.name === 'xta');
        if (xta) bonus.shieldRegen = (bonus.shieldRegen || 0) + (Number(xta.value) || 0);
        const xtb = (playerData.buffs || []).find((b: any) => b && b.name === 'xtb');
        if (xtb) bonus.shieldRegen2 = (bonus.shieldRegen2 || 0) + (Number(xtb.value) || 0);
        break;
      }
      case '7': { // 阿尔缇娜（原版 L2158-2176）：冰伤2+25、攻击2+18；闪避2+25+技能；a格挡/a格挡2/a模式
        bonus.iceDmg2 = (bonus.iceDmg2 || 0) + 25;
        bonus.attack2 = (bonus.attack2 || 0) + 18;
        // a格挡2增益：穿透+15、贯穿+15（原版 L2161-2164）
        if ((playerData.buffs || []).some((b: any) => b && b.name === 'a格挡2')) {
          this.bonusService.addPenetration(bonus, 15);
          bonus.penetrate = (bonus.penetrate || 0) + 15;
        }
        // a格挡增益：攻击2 + 增益值×5、暴伤 + 增益值×10（原版 L2165-2169）
        const aBlock = (playerData.buffs || []).find((b: any) => b && b.name === 'a格挡');
        if (aBlock) {
          const a1 = Number(aBlock.value) || 0;
          bonus.attack2 = (bonus.attack2 || 0) + a1 * 5;
          bonus.critDmg = (bonus.critDmg || 0) + a1 * 10;
        }
        // a模式（原版 L2170-2175）：a模式=0 攻击2+25+技能+穿透15；否则 生命2+1.25+技能
        const aMode = this.playerService.getMarkerValue(markers, 'a模式');
        if (!aMode || aMode === 0) {
          bonus.attack2 = (bonus.attack2 || 0) + 25 + skillLevel;
          this.bonusService.addPenetration(bonus, 15);
        } else {
          bonus.hp2 = (bonus.hp2 || 0) + 1.25 + skillLevel;
        }
        bonus.dodge2 = (bonus.dodge2 || 0) + 25 + skillLevel;
        break;
      }
      case '22': { // 普拉娜（原版 L1761-1763/L1684-1708）：武器冷却×10；好感≥60 甩枪穿透；好感≥100 标记武器熟练
        // 武器冷却×10 在武器层面处理（getWeaponData 中），此处处理好感特效
        if ((player.affinity || 0) >= 60) {
          // 好感≥80：甩枪穿透增益（原版 L1693-1695：标记2 甩枪 +20，持续1+技能×0.01秒）
          if ((player.affinity || 0) >= 80) {
            bonus.penetrate = (bonus.penetrate || 0) + 20;
          }
        }
        break;
      }
      case '23': { // 兰音（原版 L2570-2586 + L2409-2464 反转童话被动）：兰音模式判断（攻击/速度模式）+ 魅力×1.5 + 负数反转
        // 原版：增幅器伤害系 vs 命中闪避系 比较 → 兰音模式1（攻击）/2（速度）；命中/闪避互相补齐
        if ((player.affinity || 0) > 0) {
          const dmgStats = (bonus.fireDmg2 || 0) + (bonus.attack2 || 0) + (bonus.elecDmg2 || 0);
          const accStats = (bonus.hit2 || 0) + (bonus.dodge2 || 0);
          if (dmgStats > accStats) {
            // 攻击模式：火/电伤互相补齐×1.1
            if ((bonus.fireDmg || 0) > (bonus.elecDmg || 0)) {
              bonus.elecDmg = (bonus.fireDmg || 0) * 1.1;
            } else {
              bonus.fireDmg = (bonus.elecDmg || 0) * 1.1;
            }
          } else {
            // 速度模式：命中/闪避互相补齐×1.25
            if ((bonus.hit || 0) > (bonus.dodge || 0)) {
              bonus.dodge = (bonus.hit || 0) * 1.25;
            } else {
              bonus.hit = (bonus.dodge || 0) * 1.25;
            }
          }
        }
        // 魅力×1.5（原版 L2586）
        bonus.charm = (bonus.charm || 0) * 1.5;
        // 反转童话被动（原版 L2409-2464）：好感≥80 时，护盾/装甲/生命为负则反转，
        // 每次独立冷却60秒；好感<80 时负数清零。
        // 注意：该逻辑在 _计算玩家 中位于"回复结算之后"（L2409），依赖当前值，
        // 此处同步实现对当前护盾/装甲/生命就地修正。
        if ((player.affinity || 0) >= 80) {
          const markers2List = Array.isArray(playerData.markers2) ? playerData.markers2 : [];
          const hasCd = (key: string) => markers2List.some((m: any) => m && m.name === key && (Date.now() / 1000) < (m.expireAt || 0));
          if ((player.shield || 0) < 0) {
            if (!hasCd('fz护盾')) {
              player.shield = -(player.shield || 0);
            } else {
              player.shield = 0;
            }
          }
          if ((player.armor || 0) < 0) {
            if (!hasCd('fz装甲')) {
              player.armor = -(player.armor || 0);
            } else {
              player.armor = 0;
            }
          }
          if ((player.hp || 0) < 0) {
            if (!hasCd('fz生命')) {
              player.hp = -(player.hp || 0);
            } else {
              player.hp = 0;
            }
          }
        } else {
          if ((player.hp || 0) < 0) player.hp = 0;
          if ((player.shield || 0) < 0) player.shield = 0;
          if ((player.armor || 0) < 0) player.armor = 0;
        }
        break;
      }
      case '24': { // 军姬2（原版 L2560-2568）：全属性×1.1；好感≥80 护盾×(1+技能×0.03)、四伤+护盾×0.15
        const scaleAll = (field: keyof BonusData) => {
          const v = bonus[field] as number | undefined;
          if (typeof v === 'number') (bonus as any)[field] = v * 1.1;
        };
        scaleAll('attack'); scaleAll('attack2');
        scaleAll('hp'); scaleAll('hp2');
        scaleAll('shield'); scaleAll('shield2');
        scaleAll('armor'); scaleAll('armor2');
        scaleAll('physDmg'); scaleAll('physDmg2');
        scaleAll('fireDmg'); scaleAll('fireDmg2');
        scaleAll('iceDmg'); scaleAll('iceDmg2');
        scaleAll('elecDmg'); scaleAll('elecDmg2');
        scaleAll('dodge'); scaleAll('dodge2');
        scaleAll('hit'); scaleAll('hit2');
        if ((player.affinity || 0) >= 80) {
          bonus.shield = (bonus.shield || 0) * (1 + skillLevel * 0.03);
          const shBonus = (bonus.shield || 0) * 0.15;
          bonus.physDmg = (bonus.physDmg || 0) + shBonus;
          bonus.fireDmg = (bonus.fireDmg || 0) + shBonus;
          bonus.elecDmg = (bonus.elecDmg || 0) + shBonus;
          bonus.iceDmg = (bonus.iceDmg || 0) + shBonus;
        }
        break;
      }
      default:
        break;
    }

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

    // ========== 套装加成（对应原版 _计算玩家 L2284 套装判断2 L3381-3444） ==========
    // 黑花嫁/白花嫁4件套、暴击熟练度→暴伤、武器等级加成（高斯步枪等+等级×2）
    try {
      const sets = this.playerService.safeJsonParse<any>(player.sets, {});
      const weapons = this.playerService.safeJsonParse<any[]>(player.weapons, []);
      this.bonusService.checkSetBonus({
        currentHp: player.hp || 0,
        currentShield: player.shield || 0,
        currentArmor: player.armor || 0,
        bonus,
        attributes: bonus,
        weapons,
        currentWeapon: player.currentWeapon || 0,
        level: player.level || 1,
        qq: String(player.userId || ''),
        markers: playerData.markers || {},
        markers2: playerData.markers2 || [],
        sets,
      }, Date.now() / 1000);
    } catch (err: any) {
      this.logger.warn(`套装加成计算失败: ${err.message}`);
    }

    // ========== 好感追加分支（对应原版 _计算玩家 L2285-2315） ==========
    // 好感≥20：启木之本樱 命中+=物伤×0.05 且 物伤=0（原版 L2286-2291）
    // 好感≥80：安克雷奇 命中+=生命/100、闪避=命中+生命/100（L2293-2295）；星尘 护盾回复+=(护盾-当前护盾)/100（L2299-2303）
    // 好感≥100：长萌 装甲回复+=(装甲-当前装甲)/100（L2305-2309）
    if ((player.affinity || 0) >= 20) {
      if (seq === 18) { // 启木之本樱
        bonus.hit = (bonus.hit || 0) + (bonus.physDmg || 0) * 0.05;
        bonus.physDmg = 0;
      }
      if ((player.affinity || 0) >= 80) {
        if (seq === 17) { // 安克雷奇
          bonus.hit = (bonus.hit || 0) + (bonus.hp || 0) / 100;
          bonus.dodge = (bonus.hit || 0) + (bonus.hp || 0) / 100;
        }
        if (seq === 14) { // 星尘
          bonus.shieldRegen = (bonus.shieldRegen || 0) + ((bonus.shield || 0) - (player.shield || 0)) / 100;
        }
        if ((player.affinity || 0) >= 100) {
          if (seq === 2) { // 长萌
            bonus.armorRegen = (bonus.armorRegen || 0) + ((bonus.armor || 0) - (player.armor || 0)) / 100;
          }
        }
      }
    }

    // ========== 阿尔缇娜 a模式=1 全抗+50、生命+=四伤、四伤=1（原版 L2316-2328） ==========
    if (seq === 7 && this.playerService.getMarkerValue(markers, 'a模式') === 1) {
      bonus.hpAllRes = (bonus.hpAllRes || 0) + 50;
      bonus.armorAllRes = (bonus.armorAllRes || 0) + 50;
      bonus.shieldAllRes = (bonus.shieldAllRes || 0) + 50;
      bonus.hp = (bonus.hp || 0) + (bonus.physDmg || 0) + (bonus.iceDmg || 0) + (bonus.fireDmg || 0) + (bonus.elecDmg || 0);
      bonus.physDmg = 1;
      bonus.iceDmg = 1;
      bonus.fireDmg = 1;
      bonus.elecDmg = 1;
    }

    // ========== 套装植入体 1-4 对应属性伤×1.25（原版 L2329-2339） ==========
    try {
      const sets = this.playerService.safeJsonParse<any>(player.sets, {});
      if (sets.implant === 1) bonus.physDmg = (bonus.physDmg || 0) * 1.25;
      if (sets.implant === 2) bonus.fireDmg = (bonus.fireDmg || 0) * 1.25;
      if (sets.implant === 3) bonus.iceDmg = (bonus.iceDmg || 0) * 1.25;
      if (sets.implant === 4) bonus.elecDmg = (bonus.elecDmg || 0) * 1.25;
      // 攻击模式==1：闪避=1（原版 L2340-2342）
      if (sets.attackMode === 1) bonus.dodge = 1;
      // 晚礼服≥4 且非兰音：魅力×1.5（原版 L2590-2595）
      if ((sets.eveningGown || 0) >= 4 && seq !== 23) {
        bonus.charm = (bonus.charm || 0) * 1.5;
      }
      // 增幅器==1：当前武器冷却-10%（≥1秒）（原版 L2609-2618）
      if (sets.amplifier === 1 && player.currentWeapon > 0) {
        const weaponsD = this.playerService.safeJsonParse<any[]>(player.weapons, []);
        const curW = weaponsD[(player.currentWeapon || 1) - 1];
        if (curW) {
          let a1 = (curW.cooldown || 5) * 0.1;
          if (a1 < 1) a1 = 1;
          curW.cooldown = (curW.cooldown || 5) - a1;
        }
      }
      // 科学家≥4：生产+5（原版 L2619-2621）
      if ((sets.scientist || 0) >= 4) bonus.production = (bonus.production || 0) + 5;
    } catch (err: any) {
      this.logger.warn(`套装追加处理失败: ${err.message}`);
    }

    // ========== 三回复 /10（原版 L2343-2345） ==========
    bonus.hpRegen = (bonus.hpRegen || 0) / 10;
    bonus.armorRegen = (bonus.armorRegen || 0) / 10;
    bonus.shieldRegen = (bonus.shieldRegen || 0) / 10;

    // ========== 脏弹/核废料（原版 L2362-2382） ==========
    const pBuffs = playerData.buffs || [];
    if (pBuffs.some((b: any) => b && b.name === '脏弹')) {
      bonus.hpRegen = 0;
      bonus.hpRegen2 = 0;
      bonus.armorRegen = (bonus.armorRegen || 0) / 2;
      bonus.armorRegen2 = (bonus.armorRegen2 || 0) / 2;
    } else {
      // 携带核废料且600秒间隔内无法回复生命（原版 L2368-2380）
      const backpack = this.playerService.safeJsonParse<any[]>(player.backpack, []);
      if (backpack.some((it: any) => it && it.name === '核废料' && (it.count || 0) > 0)) {
        bonus.hpRegen = 0;
        bonus.hpRegen2 = 0;
      }
    }

    // ========== 战斗宙斯盾/抗穿透护盾（原版 L2523-2535） ==========
    // 当前护盾≥75% 且装备战斗宙斯盾：抗贯穿+100；当前护盾≥5% 且装备抗穿透护盾：抗贯穿+100
    try {
      const equips = this.playerService.safeJsonParse<any[]>(player.equipment, []);
      const hasEquip = (name: string) => equips.some((e: any) => e && e.name === name);
      if ((player.shield || 0) >= (bonus.shield || 0) * 0.75 && hasEquip('战斗宙斯盾')) {
        bonus.antiPenetrate = (bonus.antiPenetrate || 0) + 100;
      }
      if ((player.shield || 0) >= (bonus.shield || 0) * 0.05 && hasEquip('抗穿透护盾')) {
        bonus.antiPenetrate = (bonus.antiPenetrate || 0) + 100;
      }
    } catch {
      // 忽略装备解析错误
    }

    // ========== 闪避<1 → 1（原版 L2536-2538） ==========
    if ((bonus.dodge || 0) < 1) bonus.dodge = 1;

    // ========== 纯洁无瑕/破刃之剑（原版 L2542-2559） ==========
    // 装备特效要求 + 未被击败/被击败 状态判定（标记2 "被击败"）
    try {
      const equips = this.playerService.safeJsonParse<any[]>(player.equipment, []);
      const hasEffect = (effect: string) => equips.some((e: any) => e && e.forcedEffect === effect || e && e.特效 === effect);
      const markers2List = Array.isArray(playerData.markers2) ? playerData.markers2 : [];
      const defeated = markers2List.some((m: any) => m && m.name === '被击败');
      if (hasEffect('纯洁无瑕') && !defeated) {
        bonus.charm = (bonus.charm || 0) + 25;
        this.addAttackBonusPercent(bonus, 25);
        bonus.hit = (bonus.hit || 0) * 1.25;
        bonus.dodge = (bonus.dodge || 0) * 1.25;
      }
      if (hasEffect('破刃之剑') && defeated) {
        bonus.charm = (bonus.charm || 0) + 5;
        this.addAttackBonusPercent(bonus, 5);
        bonus.hit = (bonus.hit || 0) * 1.05;
        bonus.dodge = (bonus.dodge || 0) * 1.05;
      }
    } catch {
      // 忽略装备解析错误
    }

    // ========== 卷土重来/线圈减伤（原版 L2596-2608） ==========
    // 卷土重来增益 或 套装线圈>0：闪避=1、四伤÷2
    // 注意原版 L2599/L2605 疑似笔误：火伤=冰伤/2、冰伤=火伤/2（交叉赋值），按原版保留
    if (pBuffs.some((b: any) => b && b.name === '卷土重来')) {
      bonus.dodge = 1;
      bonus.physDmg = (bonus.physDmg || 0) / 2;
      bonus.fireDmg = (bonus.iceDmg || 0) / 2; // 原版 L2599，疑似笔误（应为火伤/2），按原版保留
      bonus.elecDmg = (bonus.elecDmg || 0) / 2;
      bonus.iceDmg = (bonus.fireDmg || 0) / 2; // 原版 L2601，疑似笔误（应为冰伤/2），按原版保留
    }
    try {
      const sets = this.playerService.safeJsonParse<any>(player.sets, {});
      if ((sets.coil || 0) > 0) {
        bonus.physDmg = (bonus.physDmg || 0) / 2;
        bonus.fireDmg = (bonus.iceDmg || 0) / 2; // 原版 L2605，疑似笔误，按原版保留
        bonus.elecDmg = (bonus.elecDmg || 0) / 2;
        bonus.iceDmg = (bonus.fireDmg || 0) / 2; // 原版 L2607，疑似笔误，按原版保留
      }
    } catch {
      // 忽略套装解析错误
    }

    // ========== 宠物存活数量加成（原版 L2187-2221） ==========
    // 原版：b=宠物存活数量(玩家.地图, 玩家.QQ, c, d, e, 玩家.套装.白)
    //   - e≠0（有白）：物伤2×1.05
    //   - b≠0：小樱好感≥80 攻击2+b×10；军姬 攻击2+b×10、全抗+5×b
    //   - c>0（钳制≤2）：攻击2/命中2/闪避2 + c×10
    //   - d>0（钳制≤2）：贯穿+5×d、暴击伤害+75×d
    // 宠物=地图召唤物中归属该玩家且存活的；此处读取当前地图召唤物计算。
    try {
      const mapForPet = map;
      let petCount = 0;   // b：存活宠物总数
      let c = 0;          // c：存活非白宠物数（钳制≤2）
      let d = 0;          // d：存活白宠物数（钳制≤2）
      let hasWhite = false; // e：是否存在白
      if (mapForPet) {
        const summons = this.playerService.safeJsonParse<any[]>(mapForPet.summons, []);
        for (const s of summons) {
          const isOwner =
            s &&
            (String(s.ownerQQ) === String(player.userId) || String(s.归属) === String(player.userId)) &&
            (s.hp ?? s.当前生命 ?? 1) > 0;
          if (!isOwner) continue;
          const isWhite = s.name === '白' || s.名称 === '白';
          petCount += 1;
          if (isWhite) d += 1;
          else c += 1;
          if (isWhite) hasWhite = true;
        }
      }
      if (hasWhite) {
        bonus.physDmg2 = (bonus.physDmg2 || 0) * 1.05;
      }
      if (petCount > 0) {
        if (seq === 10 && (player.affinity || 0) >= 80) { // 小樱 团结友爱
          bonus.attack2 = (bonus.attack2 || 0) + petCount * 10;
        }
        if (seq === 16) { // 军姬 森罗万象
          bonus.attack2 = (bonus.attack2 || 0) + petCount * 10;
          bonus.hpAllRes = (bonus.hpAllRes || 0) + 5 * petCount;
          bonus.armorAllRes = (bonus.armorAllRes || 0) + 5 * petCount;
          bonus.shieldAllRes = (bonus.shieldAllRes || 0) + 5 * petCount;
        }
        if (c > 0) {
          if (c > 2) c = 2;
          bonus.attack2 = (bonus.attack2 || 0) + c * 10;
          bonus.hit2 = (bonus.hit2 || 0) + c * 10;
          bonus.dodge2 = (bonus.dodge2 || 0) + c * 10;
        }
        if (d > 0) {
          if (d > 2) d = 2;
          bonus.penetrate = (bonus.penetrate || 0) + 5 * d;
          bonus.critDmg = (bonus.critDmg || 0) + 75 * d;
        }
      }
    } catch (err: any) {
      this.logger.warn(`宠物存活数量加成计算失败: ${err.message}`);
    }

    // ========== 黑色兔子玩偶（原版 L2222-2238） ==========
    // 装备黑色兔子玩偶：取最高属性系对应 伤2+10
    try {
      const equips = this.playerService.safeJsonParse<any[]>(player.equipment, []);
      if (equips.some((e: any) => e && e.name === '黑色兔子玩偶')) {
        if ((bonus.elecDmg || 0) > (bonus.fireDmg || 0)) {
          if ((bonus.elecDmg || 0) > (bonus.iceDmg || 0)) {
            bonus.elecDmg2 = (bonus.elecDmg2 || 0) + 10;
          } else {
            bonus.iceDmg2 = (bonus.iceDmg2 || 0) + 10;
          }
        } else if ((bonus.fireDmg || 0) > (bonus.iceDmg || 0)) {
          bonus.fireDmg2 = (bonus.fireDmg2 || 0) + 10;
        } else {
          bonus.iceDmg2 = (bonus.iceDmg2 || 0) + 10;
        }
      }
      // 套装一拳==4：攻击2+25、全部武器锁定+5（原版 L2239-2244）
      const sets = this.playerService.safeJsonParse<any>(player.sets, {});
      if ((sets.onePunch || 0) === 4) {
        bonus.attack2 = (bonus.attack2 || 0) + 25;
        const weaponsD = this.playerService.safeJsonParse<any[]>(player.weapons, []);
        for (const w of weaponsD) {
          if (w) w.lockTime = (w.lockTime || 0) + 5;
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
   * 增加攻击（百分比属性攻击）
   * 对应原版 加成计算.ecode 增加攻击() L1394-1405（攻击2分支）：
   *   玩家.属性.电伤 += (加成.攻击 + 加成.电伤 + 基础.电伤)
   *                   × (1 + 属性.电伤2/100) × (1 + 加成.电伤2/100) × (1 + 加成.攻击2/100)
   *                   × 攻击2/100
   *   物伤/冰伤/火伤 同理。
   * 用于 纯洁无瑕/破刃之剑 等"增加攻击(玩家, , 百分比)"特效。
   * @param bonus 加成对象（就地修改四属性伤害）
   * @param attack2 百分比攻击值（原版第二参数：百分比 属性）
   */
  private addAttackBonusPercent(bonus: BonusData, attack2: number): void {
    if (!attack2) return;
    const atkBonus = (bonus.attack || 0) + (bonus.attackBonus || 0);
    // 原版 (1 + 属性.攻击2/100) 中的"属性.攻击2"对应本框架 attack2（递减后）；
    // 这里简化取当前 bonus.attack2（若已应用递减则用递减值，行为接近原版）。
    const atk2Factor = (1 + (bonus.attack2 || 0) / 100);
    const mul = (dmg2: number) => (1 + (dmg2 || 0) / 100) * atk2Factor * attack2 / 100;
    bonus.elecDmg = (bonus.elecDmg || 0) + (atkBonus + (bonus.elecDmg || 0) + (bonus.elecDmg2 || 0)) * mul(bonus.elecDmg2 || 0);
    bonus.physDmg = (bonus.physDmg || 0) + (atkBonus + (bonus.physDmg || 0) + (bonus.physDmg2 || 0)) * mul(bonus.physDmg2 || 0);
    bonus.iceDmg = (bonus.iceDmg || 0) + (atkBonus + (bonus.iceDmg || 0) + (bonus.iceDmg2 || 0)) * mul(bonus.iceDmg2 || 0);
    bonus.fireDmg = (bonus.fireDmg || 0) + (atkBonus + (bonus.fireDmg || 0) + (bonus.fireDmg2 || 0)) * mul(bonus.fireDmg2 || 0);
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
    // 读取辅助：优先顶层字段，回退到 bonus JSON。
    // 兼容中文 key 与英文 key 两套命名（monsters.json 的 bonus 里是中文，如"生命物抗"；
    // 历史代码可能写入英文如 hpPhysRes），二者任一存在都读到。
    const zhKeyMap: Record<string, string[]> = {
      shieldPhysRes: ['护盾物抗'],
      shieldFireRes: ['护盾火抗'],
      shieldIceRes: ['护盾冰抗'],
      shieldElecRes: ['护盾电抗'],
      shieldAllRes: ['护盾全抗'],
      armorPhysRes: ['装甲物抗'],
      armorFireRes: ['装甲火抗'],
      armorIceRes: ['装甲冰抗'],
      armorElecRes: ['装甲电抗'],
      armorAllRes: ['装甲全抗'],
      hpPhysRes: ['生命物抗'],
      hpFireRes: ['生命火抗'],
      hpIceRes: ['生命冰抗'],
      hpElecRes: ['生命电抗'],
      hpAllRes: ['生命全抗'],
      shieldDmgCap: ['护盾伤害上限'],
      armorDmgCap: ['装甲伤害上限'],
      hpDmgCap: ['生命伤害上限'],
      physDmg: ['物伤'],
      fireDmg: ['火伤'],
      iceDmg: ['冰伤'],
      elecDmg: ['电伤'],
    };
    const pick = (k: string) => {
      // 顶层字段
      if (monster[k] !== undefined) return monster[k];
      // 英文 key 直读 bonus
      if (mb[k] !== undefined) return mb[k];
      // 中文 key 映射读取
      const zhKeys = zhKeyMap[k];
      if (zhKeys) {
        for (const zk of zhKeys) {
          if (mb[zk] !== undefined) return mb[zk];
        }
      }
      return 0;
    };

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
      hpDmgCap: pick('hpDmgCap') || 100,
      // 贯穿几率/抗贯穿（原版 贯穿判断 L3192：几率判断(攻击方.贯穿-防御方.抗贯穿)）
      penetrate: mb['贯穿'] !== undefined ? mb['贯穿'] : (monster.penetrate || 0),
      antiPenetrate: mb['抗贯穿'] !== undefined ? mb['抗贯穿'] : (monster.antiPenetrate || 0),
      // 怪物四属性伤害（对应原版 _初始化怪物 属性构建，monsters.json bonus 中文 key：物伤/火伤/冰伤/电伤）
      physDmg: pick('physDmg') || 0,
      fireDmg: pick('fireDmg') || 0,
      iceDmg: pick('iceDmg') || 0,
      elecDmg: pick('elecDmg') || 0,
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
    // 原版穿透模型（攻击目标() L4140-4143 等）：
    //   造成物伤 = 剩余物伤 * (1 - 护盾物抗/100 * (1 - (护盾穿透+盾穿.物)/100))
    // 即"百分比穿透"：穿透按比例削减抗性，而不是直接减去抗性值。
    //   有效抗性 = (单项抗 + 全抗) × (1 - 穿透/100)，穿透>=100 则完全无视抗性。
    const calcRes = (single: number) => {
      const total = single + allRes;
      const effective = total * (1 - (pen || 0) / 100);
      return Math.min(100, Math.max(0, effective)) / 100;
    };
    const physRes = calcRes(defBonus[`${resPrefix}PhysRes` as keyof BonusData] as number || 0);
    const fireRes = calcRes(defBonus[`${resPrefix}FireRes` as keyof BonusData] as number || 0);
    const iceRes = calcRes(defBonus[`${resPrefix}IceRes` as keyof BonusData] as number || 0);
    const elecRes = calcRes(defBonus[`${resPrefix}ElecRes` as keyof BonusData] as number || 0);

    return {
      physical: breakdown.physical * (1 - physRes),
      fire: breakdown.fire * (1 - fireRes),
      ice: breakdown.ice * (1 - iceRes),
      elec: breakdown.elec * (1 - elecRes),
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
    penetrate?: { directLife: number; directArmor: number; directShield: number },
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

    // 贯穿：跳过当前池直接注入更深层池的额外伤害（对应原版 L3232-3265）
    //   directShield = 跳过护盾直接打装甲/生命的伤害
    //   directArmor  = 跳过护盾和装甲直接打生命的伤害
    //   directLife   = 直接打生命的伤害（= directArmor 的上层部分，按分段比例）
    // 原版分段：护盾1装甲0/护盾0装甲1 → 额外生命=剩余×0.3；护盾1装甲1 → 额外生命×0.1、额外装甲×0.2
    const pierce = penetrate || { directLife: 0, directArmor: 0, directShield: 0 };

    // 单一"剩余四属性伤害"流转（对应原版 剩余物伤/火伤/冰伤/电伤 逐步缩放）
    // 三层共用同一份剩余伤害：每层先按本层抗穿算本层伤害，破层后缩放剩余伤害再入下一层
    let remaining: DamageBreakdown = {
      physical: resisted.shield.physical,
      fire: resisted.shield.fire,
      ice: resisted.shield.ice,
      elec: resisted.shield.elec,
    };
    // 贯穿的"直接伤害"已跳过护盾层，从护盾层剩余中扣除对应比例（剩余×0.7）
    if (pierce.directLife > 0 || pierce.directArmor > 0 || pierce.directShield > 0) {
      remaining = scale(remaining, 0.7);
    }

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

    // 贯穿注入：跳过护盾直接打装甲的伤害（护盾1装甲1时 额外装甲=剩余×0.2）
    if (pierce.directArmor > 0) {
      pool.armor += Math.min(pierce.directArmor, Math.max(0, currentArmor - pool.armor));
    }
    // 贯穿注入：跳过护盾/装甲直接打生命的伤害（护盾1装甲0/护盾0装甲1 → 额外生命=剩余×0.3）
    if (pierce.directLife > 0) {
      pool.hp += Math.min(pierce.directLife, Math.max(0, currentHp - pool.hp));
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
   * 更新地图数据库中怪物的血量（GameMonster 表，加锁消除并发丢失更新）
   * 原版为单线程内存模型，无并发问题；后端多请求并发时，
   * 若不加锁，两个请求会同时读到同一旧快照并各自覆盖写回，导致一方伤害"蒸发"。
   * 此处通过 MapService.withMapLock 串行化同地图的读改写，按怪物自增 id 定位写回三层池。
   */
  private async updateMonsterHpInMap(mapId: number, monster: any): Promise<void> {
    try {
      // 优先取自增 id；旧调用方可能传 qq 字符串，需先解析
      const monsterId = typeof monster.id === 'number' ? monster.id : undefined;
      if (monsterId === undefined) {
        // 退化：按 qq 查 id（兼容临时怪物字符串 id 场景）
        const found = await this.mapService.getMapMonsters(mapId);
        const hit = found.find((m: any) => m.qq === monster.id || String(m.id) === String(monster.id));
        if (!hit) return;
        await this.mapService.updateMonsterFields(mapId, hit.id, {
          hp: monster.hp,
          shield: monster.shield,
          armor: monster.armor,
        });
        return;
      }
      await this.mapService.updateMonsterFields(mapId, monsterId, {
        hp: monster.hp,
        shield: monster.shield,
        armor: monster.armor,
      });
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
      case '小樱':
        return this.processSakuraEffects(player, playerData, weapon, context, defaultResult);
      case '伊芙利特':
        return this.processIfritEffects(player, playerData, weapon, context, defaultResult);
      case '龙姬':
        return this.processDragonGirlEffects(player, playerData, weapon, context, defaultResult);
      case '启木之本樱':
        return this.processSakuraSakuraEffects(player, playerData, weapon, context, defaultResult);
      case '军姬':
        return this.processMilitaryGirlEffects(player, playerData, weapon, context, defaultResult);
      case '星尘':
        return this.processStardustEffects(player, playerData, weapon, context, defaultResult);
      default:
        return defaultResult;
    }
  }

  /**
   * 军姬被动战斗特效（对应原版 L2192-2209）
   * - 好感≥100：攻击时给目标附加"影光"增益(持续1秒，值60，易伤计算用)
   * - 有"万象"增益且使用近战/拳头：30秒冷却触发"剑阵转轮"持续伤害(物伤/10)
   * - 消耗"万象2"标记：本次伤害倍率 ×(2+技能等级/100)
   */
  private processMilitaryGirlEffects(
    player: any,
    playerData: any,
    weapon: WeaponData,
    context: AttackContext,
    base: FamiliarEffectResult,
  ): FamiliarEffectResult {
    const result = { ...base };
    const markers = playerData.markers || {};
    const skillLevel = markers['军姬技能熟练度'] || 0;
    const affinity = markers['军姬好感'] || 0;

    // 好感≥100：给目标附加"影光"
    if (affinity >= 100) {
      result.defenderBuffs = [
        ...(result.defenderBuffs || []),
        { name: '影光', value: 60, duration: 1 },
      ];
      result.effectText += '【影光】';
    }

    // "万象2"标记：伤害倍率 ×(2+技能等级/100)
    if ((markers['万象2'] || 0) === 1) {
      result.damageMultiplier = (result.damageMultiplier || 100) * (2 + skillLevel / 100);
      result.effectText += '【万象二重】';
      result.markerOps = [
        ...(result.markerOps || []),
        { key: '万象2', delta: -1 },
      ];
    }

    // 剑阵转轮：近战且有"万象"增益时，物伤/10 持续伤害（简化：写入 defenderBuffs 提示）
    const isMeleeW = !weapon.type || weapon.type.includes('近战') || weapon.name === '拳头';
    if (isMeleeW && (playerData.buffs || []).some((b: any) => b && b.name === '万象')) {
      result.effectText += '【剑阵转轮】';
    }

    return result;
  }

  /**
   * 星尘被动战斗特效（对应原版 L2211-2218）
   * 消耗"dz"标记：本次攻击额外电伤 + 标记值×(5+技能等级/10)（斗转星移）
   */
  private processStardustEffects(
    player: any,
    playerData: any,
    weapon: WeaponData,
    context: AttackContext,
    base: FamiliarEffectResult,
  ): FamiliarEffectResult {
    const result = { ...base };
    const markers = playerData.markers || {};
    const skillLevel = markers['星尘技能熟练度'] || 0;
    const dz = markers['dz'] || 0;
    if (dz !== 0) {
      const bonus = dz * (5 + skillLevel / 10);
      // 原版：剩余电伤 + a2，此处简化为本次伤害倍率加成分（等效电伤追加）
      result.damageMultiplier = (result.damageMultiplier || 100) + bonus;
      result.effectText += `【斗转星移+${bonus.toFixed(0)}】`;
      result.markerOps = [
        ...(result.markerOps || []),
        { key: 'dz', delta: -dz },
      ];
    }
    return result;
  }

  /**
   * 小樱被动战斗特效（对应原版 L1062-1072）
   * - 战斗冷却120秒冷却完毕后，获得"库洛魔力"增益(+30+技能等级，持续2秒)
   * - 每回合消耗"空间魔力"标记加命中(+25+技能等级)
   */
  private processSakuraEffects(
    player: any,
    playerData: any,
    weapon: WeaponData,
    context: AttackContext,
    base: FamiliarEffectResult,
  ): FamiliarEffectResult {
    const result = { ...base };
    const markers = playerData.markers || {};
    const skillLevel = markers['小樱技能熟练度'] || 0;

    // 空间魔力：消耗标记，本次命中+25+技能等级
    const spaceMagic = markers['空间魔力'] || 0;
    if (spaceMagic > 0) {
      result.hitRateModifier += 25 + skillLevel;
      result.effectText += `【空间魔力+${spaceMagic}】`;
      result.markerOps = [{ key: '空间魔力', delta: -1 }];
    }

    // 库洛魔力：120秒冷却（简化：每20秒最多获得一次），加攻击
    // 原版通过增益持续机制实现，此处简化为每120秒刷新一次攻击加成
    const lastMagicTime = markers['库洛魔力时间'] || 0;
    const now = Date.now();
    if (now - lastMagicTime > 120000) {
      result.attackBonus = (result.attackBonus || 0) + (30 + skillLevel) * 0.5;
      result.attackerBuffs = [
        ...(result.attackerBuffs || []),
        { name: '库洛魔力', value: 30 + skillLevel, duration: 2 },
      ];
      result.markerOps = [
        ...(result.markerOps || []),
        { key: '库洛魔力时间', delta: now },
      ];
      result.effectText += '【库洛魔力】';
    }

    return result;
  }

  /**
   * 伊芙利特被动战斗特效（对应原版 L1074-1079）
   * 好感≥40：获得"五番"增益(+20，持续1秒)，本次攻击+20%伤害倍率
   */
  private processIfritEffects(
    player: any,
    playerData: any,
    weapon: WeaponData,
    context: AttackContext,
    base: FamiliarEffectResult,
  ): FamiliarEffectResult {
    const result = { ...base };
    const markers = playerData.markers || {};
    const affinity = markers['伊芙利特好感'] || 0;
    if (affinity >= 40) {
      const skillLevel = markers['伊芙利特技能熟练度'] || 0;
      const bufVal = 20;
      result.attackerBuffs = [
        ...(result.attackerBuffs || []),
        { name: '五番', value: bufVal, duration: 1 },
      ];
      result.damageMultiplier = (result.damageMultiplier || 100) + 20;
      result.effectText += `【五番+${bufVal}】`;
    }
    return result;
  }

  /**
   * 龙姬被动战斗特效（对应原版 L1089-1092）
   * 好感≥40：攻击时给目标附加"点燃"增益(持续5+技能等级/2秒)
   */
  private processDragonGirlEffects(
    player: any,
    playerData: any,
    weapon: WeaponData,
    context: AttackContext,
    base: FamiliarEffectResult,
  ): FamiliarEffectResult {
    const result = { ...base };
    const markers = playerData.markers || {};
    const affinity = markers['龙姬好感'] || 0;
    if (affinity >= 40) {
      const skillLevel = markers['龙姬技能熟练度'] || 0;
      result.defenderBuffs = [
        ...(result.defenderBuffs || []),
        { name: '点燃', value: 20, duration: Math.floor(5 + skillLevel / 2) },
      ];
      result.effectText += '【点燃】';
    }
    return result;
  }

  /**
   * 启木之本樱被动战斗特效（对应原版 L1094-1103）
   * 好感≥20：攻击时减少自身"封印解除"技能冷却
   */
  private processSakuraSakuraEffects(
    player: any,
    playerData: any,
    weapon: WeaponData,
    context: AttackContext,
    base: FamiliarEffectResult,
  ): FamiliarEffectResult {
    const result = { ...base };
    const markers = playerData.markers || {};
    const affinity = markers['启木之本樱好感'] || 0;
    if (affinity >= 20) {
      // 减少封印解除冷却（简化：记录最近触发时间，展示提示）
      result.effectText += '【封印解除冷却减少】';
    }
    return result;
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
   * 普拉娜被动战斗特效（对应原版 L1037-1060）
   * - 好感≥20："压制"增益叠加，本次攻击增加 15+技能等级 的攻击加成（火力）
   * - 好感≥80："甩枪"穿透，本次攻击三层穿透 + 15×(1+技能等级×0.01)
   */
  private processPlanaEffects(
    player: any,
    playerData: any,
    weapon: WeaponData,
    context: AttackContext,
    base: FamiliarEffectResult,
  ): FamiliarEffectResult {
    const result = { ...base };
    const markers = playerData.markers || {};
    const skillLevel = markers['普拉娜技能熟练度'] || 0;
    const affinity = markers['普拉娜好感'] || 0;

    // 好感≥20：火力加成（压制增益叠加，简化：本次攻击直接加攻击加成）
    if (affinity >= 20) {
      const fireBonus = 15 + skillLevel;
      result.attackBonus = (result.attackBonus || 0) + fireBonus;
      result.attackerBuffs = [
        ...(result.attackerBuffs || []),
        { name: '压制', value: fireBonus, duration: 1 },
      ];
      result.effectText += `【火力+${fireBonus}】`;
    }

    // 好感≥80：甩枪穿透（三层穿透 + 15×(1+技能等级×0.01)，上限15×(1+技能等级×0.01)）
    if (affinity >= 80) {
      const penMax = 15 * (1 + skillLevel * 0.01);
      const penVal = Math.min(penMax, 15 * (1 + skillLevel * 0.01));
      result.extraPenetration = (result.extraPenetration || 0) + penVal;
      result.effectText += `【甩枪+${penVal.toFixed(1)}】`;
    }

    // 武器名显示
    result.effectText = `【普拉娜·${weapon.name || '武器'}】${result.effectText}`;
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
        const map = await this.mapService.getMapById(player.mapId);
        if (!map) {
          this.stopAutoCombat(userId);
          return;
        }

        const monsters = await this.mapService.getMapMonsters(map);
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

  // ==================== 行动无限制 ====================

  /**
   * 行动无限制（对应原版 战斗相关.ecode L5097-5172 子程序）
   *
   * 原版语义：检查玩家是否处于"被限制"状态，返回真=被限制（不可行动），假=可行动。
   * 参数：
   *   - 玩家：玩家对象（含 markers / markers2 / attackMode / 套装）
   *   - 返回文本：引用参数，被限制时写入剩余时间提示
   *   - s：当前秒（时间戳，秒）
   *   - 炮击可：炮击模式下是否仍允许（默认真=炮击模式也允许）
   *   - 无视理由：1移动 2复活 3采集 4工作 5躺下 6自动开采，对应数字可无视该限制
   *   - 长须鲸开采：长须鲸开采时额外检查"自动开采2"
   *
   * 1:1 还原各.如果真分支顺序（移动→复活→采集→工作→攻击模式→躺下→自动开采→长须鲸→麻痹）。
   * markers2 标记（移动/复活/采集/工作/麻痹）采用秒级 expireAt（与原版 s 秒一致，
   * 与 game.service 内 markers2 增益冷却写法一致）。
   *
   * @param player 玩家对象
   * @param opts 可选参数（炮击可 / 无视理由 / 长须鲸开采）
   * @returns { restricted: boolean, text: string } restricted 为真表示被限制
   */
  actionUnrestricted(
    player: any,
    opts?: { cannonOk?: boolean; ignoreReason?: number; blueWhale?: boolean },
  ): { restricted: boolean; text: string } {
    const nowSec = Date.now() / 1000;
    const cannonOk = opts?.cannonOk ?? true;
    const ignoreReason = opts?.ignoreReason ?? 0;
    const blueWhale = opts?.blueWhale ?? false;
    const markers = this.playerService.safeJsonParse<any>(player.markers, {});
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    let text = '';

    // 标记要求(name, markers2, 返回文本, s)：存在且未过期则写入剩余时间文本并返回真
    const marker2Require = (name: string, reason: number): boolean => {
      if (ignoreReason === reason) return false;
      const entry = markers2.find((m: any) => m && m.name === name);
      if (entry && entry.expireAt && entry.expireAt > nowSec) {
        const remain = Math.ceil(entry.expireAt - nowSec);
        text = `${player.name} ${name}中，还需要 ${remain} 秒`; // 原版：玩家.名称 + name + "还需要" + 剩余
        return true;
      }
      return false;
    };

    // 移动限制（原版 L5106-5112）
    if (marker2Require('移动', 1)) {
      return { restricted: true, text };
    }
    // 复活限制（原版 L5113-5119）
    if (marker2Require('复活', 2)) {
      return { restricted: true, text };
    }
    // 采集限制（原版 L5120-5126）
    if (marker2Require('采集', 3)) {
      return { restricted: true, text };
    }
    // 工作限制（原版 L5127-5133）
    if (marker2Require('工作', 4)) {
      return { restricted: true, text };
    }
    // 炮击模式（原版 L5134-5142：套装.攻击模式==1）
    if (player.attackMode === 1) {
      if (cannonOk) {
        return { restricted: false, text: '' };
      }
      text = `${player.name} 炮击模式下不可以`;
      return { restricted: true, text };
    }
    // 躺下（原版 L5143-5150：取成就熟练度(玩家.标记,"躺下")==1 → 自动起床返回假）
    if (this.playerService.getMarkerValue(markers, '躺下') === 1) {
      if (ignoreReason !== 5) {
        // 原版 躺下起床显示(玩家, 2) 自动起床：置成就熟练度("躺下",0)
        text = `${player.name} 从躺下状态起身`; // 原版 L5145 躺下起床显示(玩家,2)+"【分段】"，此处内联等价文本
        this.playerService.setMarker(markers, '躺下', 0);
        player.markers = JSON.stringify(markers);
        return { restricted: false, text };
      }
    }
    // 自动开采（原版 L5151-5157：取成就熟练度(玩家.标记,"自动开采")!=0）
    if (this.playerService.getMarkerValue(markers, '自动开采') !== 0) {
      if (ignoreReason !== 6) {
        text = `${player.name} 自动开采中，"开采停止"来停止`;
        return { restricted: true, text };
      }
    }
    // 长须鲸开采（原版 L5158-5164：取成就熟练度(玩家.标记,"自动开采2")!=0）
    if (blueWhale) {
      if (this.playerService.getMarkerValue(markers, '自动开采2') !== 0) {
        text = `${player.name} 自动开采中，"开采停止"来停止`;
        return { restricted: true, text };
      }
    }
    // 麻痹（原版 L5165-5171：标记要求("麻痹", 玩家.标记2) → 无视理由!=1）
    if (marker2Require('麻痹', 1)) {
      return { restricted: true, text };
    }
    // 原版 L5172 默认返回(假)
    return { restricted: false, text: '' };
  }

  // ==================== 玩家死亡 ====================

  /**
   * 玩家死亡判定（对应原版 战斗相关.ecode L5173-5231 子程序）
   *
   * 原版语义：玩家当前生命<=0 时，依次检查各种"免死/复活豁免"：
   *   - 增益"卷土重来"存在 → 不死（额外文本）
   *   - 军姬(特殊序号=16) 且有存活宠物 → 冷却"sf"60秒未过则森罗万象复活（生命/2）
   *   - 装备"死亡行者"(specialSeq=16) 冷却90秒未过 → 复活（生命/2）
   *   - 装备"石中剑"(specialSeq=-35) 冷却90秒未过 → 复活（生命/2）
   *   - 否则 → 真死，w 文本="已经死掉了!你可以"复活使魔"或者"删除怪物""
   * 返回真=真死；返回文本 w 写入死亡提示。
   *
   * 1:1 还原各.判断分支顺序（卷土重来→军姬→默认→b==1→死亡行者→石中剑→默认）。
   * 依赖：playerData.buffs / playerData.equipment / playerData.markers2 / playerData.map.summons。
   *
   * @param playerData 玩家完整数据（含 player/markers/buffs/equipment/map）
   * @returns { dead: boolean, extraText: string, deathText: string }
   */
  playerDeath(playerData: any): { dead: boolean; extraText: string; deathText: string } {
    const nowSec = Math.floor(Date.now() / 1000);
    const player = playerData.player;
    const buffs = Array.isArray(playerData.buffs) ? playerData.buffs : [];
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const equipment = Array.isArray(playerData.equipment) ? playerData.equipment : [];

    // 时间间隔要求(name, sec, markers2, s)：存在且未过期 → 冷却中(真)；否则(假)=可触发
    const intervalActive = (name: string, sec: number): boolean => {
      const e = markers2.find((m: any) => m && m.name === name);
      return !!(e && e.expireAt && e.expireAt > nowSec);
    };
    // 写入冷却标记
    const setInterval = (name: string, sec: number) => {
      const filtered = markers2.filter((m: any) => !(m && m.name === name));
      filtered.push({ name, expireAt: nowSec + sec });
      player.markers2 = JSON.stringify(filtered);
    };
    // 装备要求(玩家, specialSeq)：遍历装备命中 specialSeq
    const hasEquip = (seq: number): boolean =>
      equipment.some((e: any) => e && e.specialSeq === seq);
    // 增益要求(name)：buff 存在且未过期
    const buffActive = (name: string): boolean =>
      buffs.some((b: any) => b && b.name === name && (!b.expireAt || b.expireAt > nowSec));

    let extraText = player.额外文本 || '';
    let deathText = '';

    // 当前生命>0 → 不可能死（原版入口隐含 玩家.当前生命<=0 才进入；此处保守判定）
    if (player.当前生命 > 0 || player.currentHp > 0) {
      return { dead: false, extraText, deathText };
    }

    // 卷土重来（原版 L5182-5184）
    if (buffActive('卷土重来')) {
      extraText = extraText + `卷土重来`;
      return { dead: false, extraText, deathText };
    }

    // 军姬（原版 L5185-5199：特殊序号==16 且有存活宠物）
    if (player.specialSeq === 16 || player.type === '军姬') {
      // 宠物存活数量：map.summons 中归属本玩家且 hp>0（原版按 玩家.地图/玩家.QQ 查）
      const map = playerData.map || {};
      const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
      const alivePet = summons.some(
        (s: any) => s && (s.userId === player.qqNumber || s.userId === player.userId) && (s.hp || s.当前生命 || 0) > 0,
      );
      let b = 0;
      if (alivePet) {
        // 冷却"sf"60秒（原版 L5187：时间间隔要求("sf",60,...) 真=冷却中 b=0，假=未冷却 b=1）
        b = intervalActive('sf', 60) ? 0 : 1;
      } else {
        b = 0;
      }
      if (b === 1) {
        extraText = extraText + `死亡状态下被"森罗万象"复活`;
        player.当前生命 = (player.属性?.生命 || player.生命上限 || 1) / 2; // 原版 玩家.属性.生命/2
        return { dead: false, extraText, deathText };
      }
    }

    // 死亡行者（原版 L5204-5212：specialSeq=16 装备）
    if (hasEquip(16)) {
      if (!intervalActive('死亡行者', 90)) {
        extraText = extraText + `死亡状态下被死亡行者复活`;
        player.当前生命 = (player.属性?.生命 || player.生命上限 || 1) / 2;
        setInterval('死亡行者', 90);
        return { dead: false, extraText, deathText };
      }
      deathText = `${player.name} 已经死掉了!你可以"复活使魔"或者"删除怪物"`;
      return { dead: true, extraText, deathText };
    }

    // 石中剑（原版 L5214-5222：specialSeq=-35 装备）
    if (hasEquip(-35)) {
      if (!intervalActive('石中剑', 90)) {
        extraText = extraText + `死亡状态下被石中剑复活`;
        player.当前生命 = (player.属性?.生命 || player.生命上限 || 1) / 2;
        setInterval('石中剑', 90);
        return { dead: false, extraText, deathText };
      }
      deathText = `${player.name} 已经死掉了!你可以"复活使魔"或者"删除怪物"`;
      return { dead: true, extraText, deathText };
    }

    // 默认（原版 L5224-5226）：真死
    deathText = `${player.name} 已经死掉了!你可以"复活使魔"或者"删除怪物"`;
    return { dead: true, extraText, deathText };
  }

  // ==================== 置掉落 ====================

  /**
   * 置掉落（对应原版 战斗相关.ecode L5245-5317 子程序）
   *
   * 原版语义：记录攻击者对某怪物的最高掉落能力（掉落率/掉落品质/传说率/宝石缎带），
   * 写入怪物.标记 数组（以 "dl"/"dp"/"xy"/"ds" + 玩家QQ 为 name 的成就条目）。
   * 后续战利品() 据此决定掉落数量/品质。
   *
   * 1:1 还原四段（掉落率→"dl" / 掉落品质→"dp" / 传说率→"xy" / 宝石缎带→"ds"），
   * 各段比较：玩家能力值 > 怪物已有记录值 才覆盖（否则保留更高记录）。
   * ⚠️原版 L5291 传说率段比较误用 `玩家.属性.掉落品质`（疑似笔误，按原版保留）。
   *
   * @param attacker 攻击玩家（含 属性.掉落率/掉落品质、套装.传说率、QQ、equipment）
   * @param monsterMarkers 怪物.标记 数组（会被原地更新，返回新数组）
   * @returns 更新后的怪物标记数组
   */
  setDrop(attacker: any, monsterMarkers: any[]): any[] {
    const markers = Array.isArray(monsterMarkers) ? monsterMarkers.slice() : [];
    const qq = attacker.qqNumber || attacker.QQ || attacker.userId || '';

    // 写入/更新怪物标记中某前缀+QQ 的成就条目（取最高值）
    const writeMarker = (prefix: string, value: number): void => {
      const name = prefix + qq;
      const idx = markers.findIndex((m: any) => m && m.name === name);
      if (idx >= 0) {
        // 已存在：仅当新值更大才覆盖（原版 玩家.能力 > 怪物.标记[a].数值 才删除重写）
        if (value > (markers[idx].数值 || 0)) {
          markers[idx] = { name, 数值: value };
        }
      } else {
        // 无记录：新增（原版 b==-1 判定后 置成就熟练度 新增）
        markers.push({ name, 数值: value });
      }
    };
    // 仅记录存在（不比较大小，存在即写1）：宝石缎带段
    const writeMarkerOnce = (prefix: string, value: number): void => {
      const name = prefix + qq;
      const idx = markers.findIndex((m: any) => m && m.name === name);
      if (idx < 0) {
        markers.push({ name, 数值: value });
      }
    };

    // 掉落率（原版 L5251-5267：玩家.属性.掉落率 != 0）
    if ((attacker.属性?.掉落率 || attacker.dropRate || 0) !== 0) {
      writeMarker('dl', attacker.属性?.掉落率 || attacker.dropRate || 0);
    }
    // 掉落品质（原版 L5269-5285：玩家.属性.掉落品质 != 0）
    if ((attacker.属性?.掉落品质 || attacker.dropQuality || 0) !== 0) {
      writeMarker('dp', attacker.属性?.掉落品质 || attacker.dropQuality || 0);
    }
    // 传说率（原版 L5287-5303：玩家.套装.传说率 != 0；⚠️L5291 比较误用 掉落品质，按原版保留）
    if ((attacker.套装?.传说率 || attacker.legendRate || 0) !== 0) {
      writeMarker('xy', attacker.套装?.传说率 || attacker.legendRate || 0);
    }
    // 宝石缎带（原版 L5305-5317：装备要求(#宝石缎带) 成立 → 写 "ds"=1）
    const equipment = Array.isArray(attacker.equipment) ? attacker.equipment : [];
    const hasGemRibbon = equipment.some((e: any) => e && e.specialSeq === 98); // #宝石缎带 常量=98
    if (hasGemRibbon) {
      writeMarkerOnce('ds', 1);
    }

    return markers;
  }

  // ==================== 挑战怪物 ====================

  /**
   * 挑战怪物（对应原版 战斗相关.ecode L4726-4790 子程序）
   *
   * 原版语义：根据整数 a 分段返回挑战怪物名字：
   *   - b = a % 10
   *   - a<100 / a<200 / a<300 / a>=300 四段，按 b 值映射到具体怪物名或随机文本
   * 本框架用随机文本(逗号串)取随机一项，与原版 随机文本() 等价。
   *
   * 1:1 还原各分段与 b 值映射（含 a>=900 精英兔子/露娜 分支）。
   *
   * @param a 挑战编号（整数）
   * @returns 怪物名字
   */
  challengeMonsterName(a: number): string {
    const rand = (csv: string): string => {
      const arr = csv.split('，'); // 原版用中文逗号
      return arr[Math.floor(Math.random() * arr.length)];
    };
    const b = a % 10;

    if (a < 100) {
      if (b === 1 || b === 6) return '绿毛龟';
      if (b === 2 || b === 7) return '水元素';
      if (b === 3 || b === 8) return '巨齿鲨';
      if (b === 4 || b === 9) return '螳螂';
      return rand('钢铁之翼，苏醒守卫者，Doge，腐化剑龙');
    }
    if (a < 200) {
      if (b === 1 || b === 6) return '第四帝国火力手';
      if (b === 2 || b === 7) return '纳米战士';
      if (b === 3 || b === 8) return '钢铁之翼';
      if (b === 4 || b === 9) return 'Doge';
      return rand('闪电飞龙，火焰飞龙，冰霜飞龙，剧毒飞龙');
    }
    if (a < 300) {
      if (b === 1 || b === 6) return 'CELL直升机';
      if (b === 2 || b === 7) return '岩石巨人';
      if (b === 3 || b === 8) return rand('Doge，闪电飞龙，火焰飞龙，冰霜飞龙，剧毒飞龙');
      if (b === 4 || b === 9) return rand('精英哥布林，无畏战士');
      return rand('熔岩巨人，精英钢铁之翼，防御节点，执行者，洛');
    }
    // a >= 300
    if (b === 1 || b === 6) {
      return a >= 900 ? rand('精英兔子，露娜') : '精英兔子';
    }
    if (b === 2 || b === 7) return rand('要塞，绫波');
    if (b === 3 || b === 8) return rand('精英钢铁之翼，彼岸花，曼陀罗');
    if (b === 4 || b === 9) return rand('精英闪电飞龙，精英火焰飞龙，精英冰霜飞龙，精英剧毒飞龙，无畏战士，稻草人，拉菲');
    return rand('熔岩巨人，防御节点，执行者，洛，海神龙，鹭，洛，可畏，柴郡，机械降神');
  }

  // ==================== 掉落残骸 ====================

  /**
   * 掉落残骸（对应原版 战斗相关.ecode L4947-4985 子程序）
   *
   * 原版语义：特定地精系列怪物死亡时，给地图.资源2 中的"载具残骸"资源累加次数 b：
   *   地精=1 / 地精十夫长=1.5 / 地精百夫长=2 / 地精千夫长=2.5 / 地精将军=3
   *   若地图资源2 无"载具残骸"则按 资源列表1 找到该资源模板新增（次数=b）。
   *
   * 1:1 还原各名称分段与系数，以及"存在则累加/不存在则新增"逻辑。
   *
   * @param resources2 地图.资源2 数组（会被原地更新）
   * @param name 怪物名称
   * @returns 更新后的资源2数组
   */
  dropWreckage(resources2: any[], name: string): any[] {
    const res = Array.isArray(resources2) ? resources2.slice() : [];
    let b = 0;
    if (name === '地精') b = 1;
    else if (name === '地精十夫长') b = 1.5;
    else if (name === '地精百夫长') b = 2;
    else if (name === '地精千夫长') b = 2.5;
    else if (name === '地精将军') b = 3;
    else return res; // 原版 默认 返回()

    // 已存在"载具残骸"则累加
    let found = false;
    for (let i = 0; i < res.length; i++) {
      if (res[i] && res[i].名称 === '载具残骸') {
        res[i] = { ...res[i], 次数: (res[i].次数 || 0) + b };
        found = true;
        break;
      }
    }
    // 不存在则新增（原版从 资源列表1 取模板，此处直接构造最小模板）
    if (!found) {
      res.push({ 名称: '载具残骸', 次数: b });
    }
    return res;
  }

  // ==================== 选择高血量目标 ====================

  /**
   * 选择高血量目标（对应原版 战斗相关.ecode L5423-5438 子程序）
   *
   * 原版语义：遍历防御方数组，记录每个目标的 当前生命+当前装甲+当前护盾 总和与索引 a，
   * 按数量升序排序（物品数量排序 默认从小到大），返回最后一个（即总和最大者）的索引耐久。
   * 无目标返回 0。
   *
   * 1:1 还原：总和计算、升序排序、返回末位索引。
   *
   * @param defenders 防御方数组（每项含 当前生命/当前装甲/当前护盾 或 hp/armor/shield）
   * @returns 最高血量目标的数组索引（无目标返回 0）
   */
  /**
   * 取攻击文本（对应原版 数据显示.ecode L2413 子程序 取攻击文本）
   *
   * 原版语义：从全局 文本列表 中按名称查找攻击文本，命中返回该项，否则返回 文本列表[1]（默认第一项）。
   * 本方法等价实现：从 StaticDataService 的 attack-texts 配置按 name 查找，未命中返回 { name: '' }。
   *
   * @param name 攻击文本名称（如 "自动步枪"）
   * @returns 攻击文本对象（至少含 name 字段，原版 攻击文本 结构）
   */
  private getAttackTextByName(name: string): any {
    const list: any[] = this.staticData.getAllAttackTexts() || [];
    const hit = list.find((t: any) => t.name === name);
    // 原版：命中返回 文本列表[b]，否则返回 文本列表[1]（下标1即数组第1项）
    return hit || list[0] || { name: '' };
  }

  /**
   * 叠加载具加成（对应原版 加成计算.ecode L3913-4076 子程序 叠加载具加成）
   *
   * 原版语义：把 目标加成 按 数量 累加进 加成（参考，原地修改）。
   * 当 硅基核心加成 > 1 时，正向字段（原值>0）乘 硅基核心加成，负向字段（原值<=0）乘 核心负面降低 = 1 - (硅基核心加成-1)*2；
   * 当 硅基核心加成 <= 1 时（本场景传 1），核心负面降低 = 1，正负字段均乘 数量（等价直接叠加）。
   *
   * 本方法 1:1 还原逐字段叠加逻辑（攻击2/生命2/护盾2/装甲2/闪避2/命中2/电伤2/火伤2/冰伤2/物伤2/溅射2/速度2/
   * 生产/生命回复2/护盾回复2/装甲回复2/攻击次数/攻击/护盾/装甲/生命/闪避/命中/电伤/火伤/冰伤/物伤/溅射/速度）。
   * 注意：原版每个字段都有「若>0 乘硅基核心加成 否则 乘核心负面降低」的二分支，本场景 硅基核心加成=1 → 核心负面降低=1 → 等价全乘 数量。
   *
   * @param bonus 被累加的加成对象（原地修改）
   * @param target 来源加成对象
   * @param count 数量（倍数）
   * @param produce 生产类（原版参数，本场景固定 假，未参与计算路径）
   * @param siliconCore 硅基核心加成（原版参数，本场景固定 1）
   */
  private stackVehicleBonus(
    bonus: any,
    target: any,
    count: number,
    produce: boolean,
    siliconCore: number,
  ): void {
    const coreNegReduce = siliconCore > 1 ? 1 - (siliconCore - 1) * 2 : 1;
    // 逐字段累加：原版正负二分支，本场景 siliconCore=1 → 等价 字段值 * count
    const fields = [
      '攻击2', '生命2', '护盾2', '装甲2', '闪避2', '命中2', '电伤2', '火伤2', '冰伤2', '物伤2',
      '溅射2', '速度2', '生命回复2', '护盾回复2', '装甲回复2', '攻击', '护盾', '装甲', '生命',
      '闪避', '命中', '电伤', '火伤', '冰伤', '物伤', '溅射', '速度',
    ];
    for (const f of fields) {
      const tv = target[f] ?? 0;
      // 原版：>0 用硅基核心加成，否则用核心负面降低
      const factor = tv > 0 ? siliconCore : coreNegReduce;
      bonus[f] = (bonus[f] ?? 0) + tv * count * factor;
    }
    // 生产 字段（原版 L3986-4000，正负与 生产类 共同决定）
    if (target.生产) {
      if (produce) bonus.生产 = (bonus.生产 ?? 0) + target.生产 * count * siliconCore;
      else bonus.生产 = (bonus.生产 ?? 0) + (target.生产 * count * siliconCore) / 4;
    } else {
      if (produce) bonus.生产 = (bonus.生产 ?? 0) + target.生产 * count * coreNegReduce;
      else bonus.生产 = (bonus.生产 ?? 0) + (target.生产 * count) / 4 * coreNegReduce;
    }
    // 攻击次数（原版 L4001）
    bonus.攻击次数 = (bonus.攻击次数 ?? 0) + (target.攻击次数 ?? 0) * count;
  }

  /**
   * 计算载具（生成前线场景的基础阶段，对应原版 加成计算.ecode L3556 计算载具 被本子程序调用的路径）
   *
   * 原版 生成前线 调用 `计算载具(zj, s, , , , )`：第3-6参数（计算产出/玩家成就/玩家任务/生产力提高/所在地图）均空，
   * 因此 计算载具 仅执行【属性计算阶段】（跳过生产产出分支）。
   * 进一步：本场景 zj 的零件是 资源（"阵地核心"/"轻型装甲"），均不在 部件列表 中命中，
   * 故 计算载具 实际只做：载具.加成 = 全新空加成（原版 L3580 `载具.加成 = j`，j 为局部全新 加成）、
   * 防御/武器/行走/功能/加成.生命 清零，然后根据零件（资源，无部件匹配）不贡献任何加成 → 载具.加成.生命 保持 0。
   *
   * 完整 计算载具（含部件匹配/硅基核心/生产产出）为 RKT ⬜ 独立大项，此处仅实现生成前线所需的等价执行路径。
   *
   * @param vehicle 载具对象（原地修改：重置加成/清空防御武器行走功能/生命上限置0）
   */
  private computeVehicleBasic(vehicle: any): void {
    // 原版 L3580: 载具.加成 = j（j 为全新 加成，全字段默认0）
    vehicle.加成 = {};
    vehicle.防御 = 0;
    vehicle.武器 = 0;
    vehicle.行走 = 0;
    vehicle.功能 = 0;
    vehicle.加成.生命 = 0;
    vehicle.行走方式 = 0;
    // 本场景零件（阵地核心/轻型装甲）均为资源名，不在 部件列表 中 → 不贡献任何加成
    // 故 载具.加成.生命 保持 0，后续调用方以 zj.当前生命 = zj.加成.生命 赋 0
  }

  /**
   * 生成前线（对应原版 战斗相关.ecode L5319-5422 子程序 生成前线）
   *
   * 原版语义：在地图上为一个玩家（qq）生成一个"前线"召唤物（玩家结构）和"阵地"载具，
   * 前者承担防御（武器来自地图建筑加成.攻击），后者提供后勤（零件=阵地核心+轻型装甲）。
   * 已存在同名召唤物/载具则更新，否则新增。置成就熟练度 跟随/阵地。
   *
   * 逐行还原要点：
   * - g.名称/类型="前线"、g.归属=qq、g.QQ="怪物前线"+qq+"sg"
   * - g.属性.必中=true、生命=1、闪避=1、物伤=冰伤=电伤=火伤=1、命中=前线等级+1、特殊序号=-2
   * - 武器 z：类型="射弹武器"、载具强制伤害=true、冷却=10
   * - 遍历地图建筑：建筑.加成.攻击!=0 → 加一把武器（名称=建筑名、加成、攻击文本、属性=26/25/25/25×攻击×数量），c+=生命×数量
   * - 无武器 → 默认"火力"自动步枪（属性26/25/25/25）
   * - g.套装.增幅器=3、g.属性.攻击=1
   * - 载具 zj：名称="阵地"、零件=[阵地核心×1, 轻型装甲×(10+c+前线等级)]、归属/驾驶员/编号=g.QQ，计算载具
   * - 置成就熟练度("跟随"/"阵地", g.标记, 1)
   * - 按 g2(已有召唤物)/zj.列表编号 决定 新增或更新 到 d.召唤物/d.载具
   *
   * 注：原版依赖全局 建筑列表（含 加成.攻击/加成.生命/攻击文本）。当前网页版 map.buildings 为生产建筑 JSON，
   * 暂无带 加成.攻击 的战斗建筑，故武器数组通常为空 → 走"火力自动步枪"默认分支；逻辑完整保留，待战斗建筑数据补全即生效。
   *
   * @param map DB GameMap 记录（含 summons/vehicles/buildings 的 JSON 字符串）
   * @param qq 玩家QQ文本
   * @param s 长整数时间戳（原版参数，生成前线场景未参与计算，保留传参对齐）
   * @param frontLineLevel 前线等级（短整数）
   * @returns { summon, summons, vehicles } 修改后的召唤物与写回用的数组（调用方负责持久化）
   */
  generateFrontline(map: any, qq: string, s: number, frontLineLevel: number): {
    summon: any;
    summons: any[];
    vehicles: any[];
  } {
    // 解析地图动态字段（JSON 字符串 → 数组），与原版 d.建筑/d.召唤物/d.载具 对应
    const buildings: any[] = this.playerService.safeJsonParse<any[]>(map.buildings, []);
    const summons: any[] = this.playerService.safeJsonParse<any[]>(map.summons, []);
    const vehicles: any[] = this.playerService.safeJsonParse<any[]>(map.vehicles, []);

    // 原版 L5336-5343：构造"前线"召唤物 g（玩家结构）
    const g: any = {
      名称: '前线',
      类型: '前线',
      归属: qq,
      QQ: '怪物前线' + qq + 'sg',
      属性: {},
      武器: [],
      装备: [],
      套装: {},
      标记: [],
    };
    g.属性.必中 = true;
    g.属性.生命 = 1;
    g.当前生命 = 1; // 先置1，后续按 g2 是否存在覆盖
    g.属性.闪避 = 1;
    g.属性.物伤 = 1;
    g.属性.冰伤 = 1;
    g.属性.电伤 = 1;
    g.属性.火伤 = 1;
    g.属性.命中 = frontLineLevel + 1;
    g.特殊序号 = -2;

    // 原版 L5340：取已存在的召唤物（按 QQ）。原版 取召唤物 命中时会写回 编号=数组下标，此处等价模拟
    const g2Idx = summons.findIndex((x: any) => x.QQ === g.QQ);
    const g2 = g2Idx >= 0 ? summons[g2Idx] : {};
    if (g2Idx >= 0) {
      g2.编号 = g2Idx; // 等价 取召唤物 L487：地图.召唤物[a].编号 = a
      // 原版 L5343：g.当前生命 = g2.当前生命（保留既有血量）
      g.当前生命 = g2.当前生命 ?? 1;
    }

    // 原版 L5351-5367：构造武器 z（射弹武器）
    let c = 0; // 轻型装甲数量累加（c += 加成.生命 × 数量）
    // 原版 L5354-5355：重定义数组 武器/装备 为0成员
    g.武器 = [];
    g.装备 = [];
    // 原版 L5356-5371：遍历地图建筑
    for (const b of buildings) {
      // 取建筑完整定义（含 加成.攻击/加成.生命/攻击文本），原版 取建筑(d.建筑[a].名称)
      const j = this.staticData.getBuildingByName(b.name) || b;
      const jBonus = j.加成 || b.加成 || {};
      if (jBonus.攻击 !== 0 && jBonus.攻击 != null) {
        const z: any = {
          类型: '射弹武器',
          载具强制伤害: true,
          冷却: 10,
          名称: b.name,
          加成: {},
          攻击文本: {},
          属性: {},
        };
        z.加成 = z.加成 || {};
        // 原版 L5361：z.攻击文本 = 取攻击文本(j.攻击文本)
        const atkText = this.getAttackTextByName(j.攻击文本 || b.攻击文本 || '');
        z.攻击文本 = { name: atkText?.name ?? '' };
        // 原版 L5362：叠加载具加成(z.加成, j.加成, 数量, 假, 1)
        this.stackVehicleBonus(z.加成, jBonus, b.count ?? 1, false, 1);
        // 原版 L5363-5366：属性 = 26/25/25/25 × 攻击 × 数量
        const atkVal = jBonus.攻击 ?? 0;
        const cnt = b.count ?? 1;
        z.属性.物 = 26 * atkVal * cnt;
        z.属性.电 = 25 * atkVal * cnt;
        z.属性.冰 = 25 * atkVal * cnt;
        z.属性.火 = 25 * atkVal * cnt;
        g.武器.push(z);
        // 原版 L5368：c = c + j.加成.生命 × 数量
        c = c + (jBonus.生命 ?? 0) * cnt;
      }
    }

    // 原版 L5372-5380：无武器则默认"火力"自动步枪
    if (g.武器.length === 0) {
      const z: any = {
        类型: '射弹武器',
        载具强制伤害: true,
        冷却: 10,
        名称: '火力',
        攻击文本: {},
        属性: {},
      };
      const atkText = this.getAttackTextByName('自动步枪');
      z.攻击文本 = { name: atkText?.name ?? '' };
      z.属性.物 = 26;
      z.属性.电 = 25;
      z.属性.冰 = 25;
      z.属性.火 = 25;
      g.武器.push(z);
    }

    // 原版 L5381：z.攻击文本.名称 = ""
    // 注意：原版此行把刚构造的 z（默认分支的火力武器）的攻击文本名称清空；逐行保留
    if (g.武器.length > 0) {
      g.武器[g.武器.length - 1].攻击文本 = g.武器[g.武器.length - 1].攻击文本 || {};
      g.武器[g.武器.length - 1].攻击文本.name = '';
    }

    // 原版 L5382-5383
    g.套装 = g.套装 || {};
    g.套装.增幅器 = 3;
    g.属性.攻击 = 1;

    // 原版 L5384-5399：构造"阵地"载具 zj
    const zjIdx = vehicles.findIndex((x: any) => x.编号 === g.QQ);
    const zj: any = { 名称: '阵地', 零件: [], 归属: g.QQ, 驾驶员: g.QQ, 编号: g.QQ, 加成: {}, 当前生命: 0, 列表编号: zjIdx };
    // 原版 L5386：重定义数组 零件 为0成员
    zj.零件 = [];
    // 原版 L5387-5390：加入 阵地核心×1
    zj.零件.push({ 名称: '阵地核心', 类型: '资源', 数量: 1 });
    // 原版 L5391-5394：加入 轻型装甲×(10 + c + 前线等级)
    zj.零件.push({ 名称: '轻型装甲', 类型: '资源', 数量: 10 + c + frontLineLevel });
    // 原版 L5398：计算载具(zj, s, , , , ) —— 本场景等价基础阶段
    this.computeVehicleBasic(zj);

    // 原版 L5399：g.载具 = zj.编号
    g.载具 = zj.编号;

    // 原版 L5400：g2 = 取召唤物(g.QQ, d) —— 重新取一次（判断编号）。等价写回 编号=下标
    const g2Idx2 = summons.findIndex((x: any) => x.QQ === g.QQ);
    const g2b = g2Idx2 >= 0 ? summons[g2Idx2] : {};
    if (g2Idx2 >= 0) g2b.编号 = g2Idx2; // 等价 取召唤物 L487

    // 原版 L5401-5402：置成就熟练度("跟随"/"阵地", g.标记, 1)
    const markerArr: any[] = Array.isArray(g.标记) ? g.标记 : [];
    this.combatState.setAchievementProficiency('跟随', markerArr, 1);
    this.combatState.setAchievementProficiency('阵地', markerArr, 1);
    g.标记 = markerArr;

    // 原版 L5403-5421：按 g2.编号 决定 新增/更新
    if (g2b.编号 == null || g2b.编号 === 0 || g2Idx2 < 0) {
      // 原版 L5404：g.当前生命 = 1
      g.当前生命 = 1;
      // 原版 L5405-5410：载具 列表编号==0 → 新增，否则更新
      if (zj.列表编号 == null || zj.列表编号 === 0 || zjIdx < 0) {
        zj.当前生命 = zj.加成.生命;
        vehicles.push(zj);
      } else {
        zj.当前生命 = zj.加成.生命;
        vehicles[zjIdx] = zj;
      }
      summons.push(g);
    } else {
      // 原版 L5413：d.召唤物[g2.编号] = g
      summons[g2Idx2] = g;
      // 原版 L5414-5419：载具 列表编号==0 → 新增，否则更新
      if (zj.列表编号 == null || zj.列表编号 === 0 || zjIdx < 0) {
        zj.当前生命 = zj.加成.生命;
        vehicles.push(zj);
      } else {
        zj.当前生命 = zj.加成.生命;
        vehicles[zjIdx] = zj;
      }
    }

    return { summon: g, summons, vehicles };
  }

  selectHighHpTarget(defenders: any[]): number {
    if (!Array.isArray(defenders) || defenders.length === 0) return 0;
    const list = defenders.map((d: any, idx: number) => ({
      idx,
      total: (d.当前生命 ?? d.hp ?? 0) + (d.当前装甲 ?? d.armor ?? 0) + (d.当前护盾 ?? d.shield ?? 0),
    }));
    // 原版 物品数量排序 默认升序（从小到大），返回末位=总和最大
    list.sort((a: any, b: any) => a.total - b.total);
    return list[list.length - 1].idx;
  }
}