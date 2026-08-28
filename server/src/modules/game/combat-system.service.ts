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

import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService, PlayerData } from './player.service';
import { BonusService, BonusData, SetData } from './bonus.service';
import { MapService, MapMonster } from './map.service';
import { ItemSystemService } from './item-system.service';
import { ItemService, BONUS_CODE_MAP } from './item.service';
import { StaticDataService } from './static-data.service';
import { AchievementService } from './achievement.service';
import { CombatStateService } from './combat-state.service';
import { StatsService } from './stats.service';
import { TaskService } from './task.service';
import { FamiliarSkillsService } from './familiar-skills.service';
import { VitalityService } from './vitality.service';

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
  /** 是否由装备特效「额外攻击次数」（棒棒糖/射爆核心）派生的攻击，防止递归 */
  isExtraAttack?: boolean;
  /** 是否由延时攻击触发的攻击 */
  isDelayed?: boolean;
  /** 是否由自动战斗循环触发的攻击 */
  isAutoCombat?: boolean;
  /**
   * 命中后给目标施加的持续伤害标记时长（秒）。
   * 对应原版 战斗相关.ecode L1930：攻击文本=="誓约胜利之剑a" 时，
   * 目标获得"sa"增益30秒；由地图战斗节拍每拍按 物攻/10×经过秒数 结算灼烧伤害。
   */
  burnSeconds?: number;
  /**
   * 本次攻击附加的三层穿透百分比（平铺值，非倍率）。
   * 对应原版 使魔技能.ecode L1424「增加穿透(玩家.属性, 15)」：誓约胜利之剑施放时注入，
   * 由 weaponAttackInner 在构建攻击方加成后叠加到护盾/装甲/生命穿透，仅本次攻击生效。
   */
  extraPenetrationFlat?: number;
  /** 指定攻击目标名（对应原版 `攻击怪物名` 设置玩家.目标） */
  targetName?: string;
  /** 指定 GameMonster 实例，避免同名怪物被重复选中 */
  targetId?: number | string;
  /** 指定攻击发生的目标地图（原版 武器攻击 的“地图”参数） */
  targetMapId?: number;
  /**
   * 原版武器攻击的运行时攻击方（召唤物/怪物）。
   * 玩家指令不设置此字段；设置后仍复用同一套命中、伤害、特效和掉落链路。
   */
  attackerOverride?: any;
  /** 运行时攻击方的已解析数据，通常由 attackerOverride 自动构造。 */
  attackerDataOverride?: PlayerData;
  /** 运行时攻击方不应再次启动玩家战斗驱动器。 */
  skipBattleDriver?: boolean;
  /** 跳过本次攻击的攻击时召唤触发（用于特殊递归攻击入口）。 */
  skipAttackSummons?: boolean;
  /** 测试与运行时递归入口可直接指定武器，绕过玩家当前武器索引。 */
  weaponOverride?: WeaponData;
  /**
   * 跳过用户级战斗串行锁。仅供已在锁内的递归入口（如花园猫闪避反击）
   * 复用外层锁使用；外部调用方不应设置此字段。
   */
  skipCombatLock?: boolean;
  /** 扫荡使用独立奖励路径：不消耗普通击杀活力，不触发活力双倍。 */
  vitalityMode?: 'normal' | 'sweep';
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
  /** 进入三池当前值截断前、经过护盾层抗性的四属性伤害（载具承伤使用） */
  vehicleBreakdown?: DamageBreakdown;
  /** 贯穿判定是否命中（载具损伤控制系统使用） */
  penetrated?: boolean;
  /** 贯穿直接注入三池的伤害，载具承伤时不会由载具吸收 */
  vehicleExtraPoolDamage?: PoolDamage;
  /** 贯穿直接伤害的四属性明细，供载具涂层逐属性缩放 */
  vehicleExtraBreakdown?: {
    shield: DamageBreakdown;
    armor: DamageBreakdown;
    life: DamageBreakdown;
  };
  /** 增强器等防御装备在本次伤害中生成的特效文本（原版“特效”引用参数） */
  effectText?: string;
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

/** 载具生产结算的运行时结果。数量单位与原版物品数组一致，时间单位为毫秒/秒。 */
export interface VehicleProductionResult {
  productionDisplay: string;
  productionSpeed: number;
  byproductMultiplier: number;
  consumptionMultiplier: number;
  efficiency: number;
  availableTime: number;
  consumedProductivity: number;
  elapsedMs: number;
  outputPerMinute: Array<{ name: string; quantity: number }>;
  consumptionPerMinute: Array<{ name: string; quantity: number }>;
  combinedPerMinute: Array<{ name: string; quantity: number }>;
  produced: Array<{ name: string; quantity: number }>;
  consumed: Array<{ name: string; quantity: number }>;
  stopped: boolean;
  reason?: string;
}

export interface VehicleRecalculationOptions {
  /** 咏星驾驶员提供的生产速率加成（原版固定为0.15）。 */
  yongxing?: number;
  /** 兰音幼崽使经过时间乘1.05。 */
  lannBaby?: boolean;
}

/**
 * 怪物死亡结果
 */
export interface MonsterDeathResult {
  expGain: number;
  drops: any[];
  dropText?: string;
  taskProgress?: Array<{ actionName: string; count: number; userId?: number }>;
  vitalityCost?: number;
  rewardMultiplier?: number;
}

interface CombatTaskProgress {
  actionName: string;
  count: number;
  /** 反击场景的受害者可能不是当前发起战斗的玩家。 */
  userId?: number;
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
  anesthesia?: number;    // 武器自带麻醉值（中文静态配置 bonus.麻醉）
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
    private readonly statsService: StatsService,
    @Optional() private readonly taskService?: TaskService,
    @Optional() private readonly petItemService?: ItemService,
    // 战斗内自动释放使魔技能（棒棒糖/光棱，原版 战斗相关.ecode L451/L1862）需要反向回调
    // FamiliarSkillsService；forwardRef+Optional+末位参数，兼容按位置 new 的既有测试。
    @Inject(forwardRef(() => FamiliarSkillsService))
    @Optional()
    private readonly familiarSkills?: FamiliarSkillsService,
    @Optional() private readonly vitalityService?: VitalityService,
  ) {}

  // ==================== 用户级战斗串行锁 ====================
  // 原版为单线程内存模型，指令天然原子执行；本框架 Web 后端多请求并发
  // 读改写同一玩家会产生丢失更新（典型表现：怪物反击写入的死亡/卷土重来
  // 状态被外层攻击流程的旧玩家快照整体覆盖回数据库），因此所有玩家战斗
  // 入口统一经 weaponAttack 的 per-user 互斥锁串行化。
  private readonly combatLocks = new Map<number, Promise<unknown>>();

  // ==================== 公开接口 ====================

  /**
   * 对指定用户串行执行一段战斗流程（per-user 互斥，对齐原版单线程语义）。
   * 同一用户并发进入时按到达顺序排队；不同用户互不阻塞。
   */
  private async withCombatLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.combatLocks.get(userId) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    // 队尾吞掉异常，避免后续排队者继承 rejected promise
    const tail = current.then(() => undefined, () => undefined);
    this.combatLocks.set(userId, tail);
    try {
      return await current;
    } finally {
      if (this.combatLocks.get(userId) === tail) this.combatLocks.delete(userId);
    }
  }

  /**
   * 武器攻击 - 完整版（公开入口）
   * 除已在锁内的递归入口（skipCombatLock）外，所有玩家战斗统一经
   * withCombatLock 串行化，防止并发指令的丢失更新。
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
    // 战斗会整包读改写玩家（背包扣弹药、掉落入包、增益标记等），
    // 必须与兑换/召唤/后台结算共用同一把用户级共享锁，否则自动战斗的
    // 周期回写会用旧快照覆盖并发写入的玩家数据。combatLock 只串行化
    // 战斗自身（含 skipCombatLock 直通路径），与数据安全无关，保留不动。
    return this.playerService.withUserLock(userId, () =>
      this.withCombatLock(userId, () => this.weaponAttackInner(userId, weaponIndex, context)));
  }

  /**
   * 武器攻击内部实现（必须在 withCombatLock 内调用）。
   * 对应原版：武器攻击()
   * 处理武器攻击完整流程：选择目标 → 命中判定 → 伤害计算 → 特效触发 → 击杀处理
   *
   * @param userId 攻击者用户ID
   * @param weaponIndex 武器索引（0=拳头）
   * @param context 攻击上下文参数
   */
  private async weaponAttackInner(
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
      targetId,
    } = context;

    // 连击触发标记：武器特殊序号（火神机枪/三千世界）攻击后，在冷却结束时自动再次攻击（对应原版 连击 L474-545）
    let comboTrigger = false;
    let comboCooldown = 5;

    // 攻击结果文本行（提前初始化，武器冷却阶段的特效文本也需写入）
    const resultLines: string[] = [];

    // 1. 获取攻击方数据。原版 武器攻击() 的“攻击方”既可以是玩家，
    // 也可以是召唤物/怪物；后两者没有独立 Player 表，使用运行时对象进入同一条结算链。
    const runtimeActor = context.attackerOverride;
    const isRuntimeActor = !!runtimeActor;
    const playerData = context.attackerDataOverride
      || (runtimeActor ? this.createRuntimeActorData(runtimeActor) : await this.playerService.getPlayerData(userId));
    const { player } = playerData;

    // 检查是否死亡
    // 原版“覅公jj”明确允许对死亡召唤物按 QQ 定位（原版 _主程序 L544 注释），
    // 因此运行时攻击方不做玩家死亡门禁；普通玩家仍按现有规则处理。
    if (!isRuntimeActor && this.playerService.isPlayerDead(player)) {
      // 原版死亡提示（战斗相关.ecode L5225）：真死后引导用「复活使魔」自救；
      // 「救助」仅作为兜底也能触发同一条自救链路。
      return {
        result: `${player.name || '冒险者'} 已经死掉了!你可以"复活使魔"或者"删除怪物"`,
        killed: [],
        damageDealt: 0,
        expGained: 0,
        drops: [],
      };
    }

    // 2. 获取攻击者所在地图与攻击目标地图。
    // 原版 武器攻击() 将地图作为显式参数传入；炮击可以在同一复活点的其他地图开火。
    const sourceMap = await this.mapService.getMapById(
      Number(player.mapId || runtimeActor?.mapId || runtimeActor?.地图 || context.targetMapId || 0),
    );
    if (!sourceMap) {
      return { result: '你不在任何地图上！', killed: [], damageDealt: 0, expGained: 0, drops: [] };
    }
    const map = context.targetMapId !== undefined
      ? await this.mapService.getMapById(context.targetMapId)
      : sourceMap;
    if (!map) {
      return { result: '目标地图不存在！', killed: [], damageDealt: 0, expGained: 0, drops: [] };
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
    const weapon = context.weaponOverride || this.getWeaponData(player, weaponIndex);

    // 4.1 武器攻击冷却检查（严格对齐原版：按武器名写入玩家 markers2 持久化标记）
    //     原版 _主程序.ecode:904 `时间间隔要求(武器名+"冷却", 攻击冷却, 玩家.标记2, ...)`
    //     noDelay(延时攻击/自动连击) 无视冷却
    if (!noDelay && weapon?.name) {
      const now = Date.now();
      // 武器特殊序号冷却修正（机械触手→6s / 雷火剑→1/3 / 火神机枪·三千世界→触发连击）
      // 对应原版 武器攻击 L94-103 冷却分支 + 触发自动连击标记
      const wepFx = this.processWeaponSpecialEffects(weapon, weapon.cooldown || 5);
      comboTrigger = wepFx.triggerCombo;
      comboCooldown = wepFx.cooldown;
      const cooldownSec = wepFx.cooldown;
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
      if (wepFx.effectText) resultLines.push(wepFx.effectText);
    }

    // 5. 确定攻击目标列表
    let targets = this.selectTargets(monsters, player, allAttack, weapon, targetName, targetId);

    if (targets.length === 0) {
      return { result: '没有可以攻击的目标', killed: [], damageDealt: 0, expGained: 0, drops: [] };
    }

    // 6. 处理使魔专属战斗特效
    // 根据玩家的当前使魔类型，触发专属战斗特效（如战斗女仆随机效果、伊卡洛斯歼灭模式等）
      const familiarEffect = this.processFamiliarEffects(player, playerData, weapon, context);
    // 应用使魔特效修改后的参数
    let effectiveDamageMultiplier = familiarEffect.damageMultiplier; // 修改后的伤害倍率
    const effectiveAllAttack = familiarEffect.forceAllAttack || familiarEffect.allAttack; // 实际全体攻击波标记
    let hitRateModifier = familiarEffect.hitRateModifier; // 命中率修正
    let extraPenetration = familiarEffect.extraPenetration; // 额外穿透
    const effectText = familiarEffect.effectText; // 特效文本
    // 溅射参数（战斗女仆RPG!/恶毒好感等设置）：对主目标外额外 splashCount 个目标造成分摊/必中伤害
    const splashCount = familiarEffect.splashCount || 0;
    const splashDamageMultiplier = familiarEffect.splashDamageMultiplier || 1;
    const splashMustHit = familiarEffect.splashMustHit || false;

    // ========== 装备特效（对应原版 战斗相关.ecode L441-467，#目标选择结束 之后） ==========
    // 棒棒糖(#特殊序号97)：10%几率「类型技能冷却」-60秒并自动释放使魔技能，额外攻击次数+1；
    // 射爆核心(#29)：60秒间隔 额外攻击次数+1；
    // 唯我主宰(#84)：60秒间隔 本次攻击必中。
    let mustHitOverride = mustHit;
    let extraAttackCount = 0;
    if (!context.skipCombatLock) {
      const equipsFx: any[] = Array.isArray(playerData.equipment)
        ? playerData.equipment
        : this.safeParseJson<any[]>(player.equipment, []);
      const hasEquipSeqFx = (seq: number): boolean =>
        equipsFx.some((e: any) => this.safeNum(e?.specialSeq ?? e?.特殊序号) === seq);

      // 棒棒糖（原版 L448-453）
      if (hasEquipSeqFx(97) && Math.random() * 100 < 10) {
        const nowMsFx = Date.now();
        const mk2Fx = this.safeParseJson<any[]>(player.markers2 || '[]', []);
        const typeKeyFx = `${player.type || '玩家'}技能冷却`;
        const skFx = mk2Fx.find((m: any) => m?.name === typeKeyFx);
        if (skFx) skFx.expireAt = Math.max(nowMsFx, skFx.expireAt - 60 * 1000);
        else mk2Fx.push({ name: typeKeyFx, expireAt: Math.max(nowMsFx, Math.floor(nowMsFx / 1000 - 60) * 1000) });
        player.markers2 = JSON.stringify(mk2Fx);
        resultLines.push('【棒棒糖】');
        // 原版 释放使魔技能(攻击方, s)：自动释放使魔特有技能（走主动技能完整门禁）
        if (!isRuntimeActor && this.familiarSkills) {
          try {
            const autoText = await this.familiarSkills.autoReleaseFamiliarSkill(userId);
            if (autoText) resultLines.push(autoText);
          } catch (e: any) {
            this.logger.warn(`棒棒糖自动释放使魔技能失败: ${e?.message ?? e}`);
          }
        }
      }
      // 射爆核心（原版 L455-459）：60s 冷却标记「射爆」→ 额外攻击次数+1
      if (hasEquipSeqFx(29)) {
        const nowSecFx = Date.now() / 1000;
        const pMkFx = this.safeParseJson<Record<string, number>>(player.markers, {});
        if (!pMkFx['射爆'] || nowSecFx - (pMkFx['射爆'] || 0) > 60) {
          pMkFx['射爆'] = nowSecFx;
          player.markers = JSON.stringify(pMkFx);
          extraAttackCount += 1;
          resultLines.push('【射爆】');
        }
      }
      // 唯我主宰（原版 L460-466）：60s 冷却标记「wzj」→ 本次必中
      if (hasEquipSeqFx(84)) {
        const nowSecFx = Date.now() / 1000;
        const pMkFx = this.safeParseJson<Record<string, number>>(player.markers, {});
        if (!pMkFx['wzj'] || nowSecFx - (pMkFx['wzj'] || 0) > 60) {
          pMkFx['wzj'] = nowSecFx;
          player.markers = JSON.stringify(pMkFx);
          mustHitOverride = true;
          resultLines.push('【唯我主宰】必中');
        }
      }
    }

    // 如果使魔特效改变了全体攻击标记，重新选择目标
    // 例如：战斗女仆RPG!/机枪会取消全体攻击，云爆弹会强制全体攻击
    if (effectiveAllAttack !== allAttack) {
      const reselected = this.selectTargets(monsters, player, effectiveAllAttack, weapon, targetName, targetId);
      targets.length = 0; targets.push(...reselected);
    }

    // 7. 执行攻击循环
    const killed: string[] = [];
    let totalDamage = 0;
    let totalExp = 0;
    const allDrops: any[] = [];
    const taskProgress: CombatTaskProgress[] = [];
    let attackCount = 0;
    let comebackKill = false;

    // 构造攻击者加成数据（合并基础+装备+增益；传入 map 供宠物存活数量加成使用）
    const attackerBonus = this.buildAttackerBonus(player, playerData, map);
    // 原版 使魔技能.ecode L1424「增加穿透(玩家.属性, 15)」：技能施放时注入的三层穿透，
    // 加成计算.ecode L3446 定义为 护盾/装甲/生命穿透 同时 += N。仅本次攻击生效。
    if (context.extraPenetrationFlat && context.extraPenetrationFlat > 0) {
      const pen = context.extraPenetrationFlat;
      attackerBonus.护盾穿透 = (attackerBonus.护盾穿透 || 0) + pen;
      attackerBonus.装甲穿透 = (attackerBonus.装甲穿透 || 0) + pen;
      attackerBonus.生命穿透 = (attackerBonus.生命穿透 || 0) + pen;
      resultLines.push(`【誓约胜利之剑】三层穿透+${pen}%`);
    }
    // 额外文本管道（原版 _主程序 L12033-12034：w = w + 玩家.额外文本 后清空）：
    // 反转童话被动(护盾/装甲/生命负数已反转) 与 计算增益(啾啾猫猫/银龙附体) 的附带文本并入本次回包。
    const attackerExtraText = (attackerBonus as any).额外文本;
    if (Array.isArray(attackerExtraText) && attackerExtraText.length) {
      resultLines.push(...attackerExtraText.map((t: string) => String(t).replace(/^#?换行/, '')));
      (attackerBonus as any).额外文本 = [];
    } else if (typeof attackerExtraText === 'string' && attackerExtraText.trim()) {
      resultLines.push(...attackerExtraText.split(/#?换行|\n/).filter(Boolean));
      (attackerBonus as any).额外文本 = '';
    }
    const comebackNowMs = Date.now();
    const hadComebackState = !isRuntimeActor
      && Array.isArray(playerData.buffs)
      && playerData.buffs.some((entry: any) => {
        if ((entry?.name ?? entry?.名称) !== '卷土重来') return false;
        const rawExpire = Number(entry?.expireAt ?? entry?.有效期至 ?? 0);
        const expireAt = rawExpire > 0 && rawExpire < 1e12 ? rawExpire * 1000 : rawExpire;
        return !expireAt || expireAt > comebackNowMs;
      });

    // 原版“造成伤害”在命中/伤害计算前触发攻击召唤。一次武器攻击可能有
    // 多个目标，但召唤自身有全局唯一 QQ 和冷却，因此在本轮目标循环前触发
    // 一次即可；全体攻击不会重复生成同一只召唤物。
    if (!context.skipAttackSummons) {
      const summonLines = await this.attackSummons(map, player, playerData, weapon, originalTimestamp);
      resultLines.push(...summonLines);
    }

    // ========== 当前生命>0 移除卷土重来（原版 _计算玩家 L2539-2541） ==========
    // 原版：当前生命>0 时获得增益(卷土重来, -30) 即移除卷土重来（卷土重来仅在死亡时生效）
    if ((player.hp || 0) > 0 && playerData.buffs && Array.isArray(playerData.buffs)) {
      const jtIdx = playerData.buffs.findIndex(
        (b: any) => b && (b.name ?? b.名称) === '卷土重来',
      );
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
        attackerBonus.世界等级差距 = 1 - player.level / threshold;
      }
    } catch (e) {
      this.logger.warn(`读取世界等级计算差距失败: ${e.message}`);
    }

    // ========== 载具加成（对应原版 加成计算.ecode 载具加成 L3334-3379） ==========
    // 玩家驾驶载具时，将地图上对应载具的加成并入攻击属性（攻击2/闪避2/命中2 + 其余加成）
    if (player.vehicle) {
      try {
        const mapVehicles = this.playerService.safeJsonParse<any[]>(sourceMap.vehicles, []);
        const v = mapVehicles.find((x: any) => x && (
          String(x.id) === String(player.vehicle)
          || String(x.编号) === String(player.vehicle)
          || String(x.vehicleId) === String(player.vehicle)
        ));
        if (v && (v.currentHp ?? v.当前生命 ?? 1) > 0) {
          const vBonus = v.bonus || v.加成 || {};
          const inc = 1; // 法宝3级+5% 的细节可后续补
          attackerBonus.攻击2 = (attackerBonus.攻击2 || 0) + (vBonus.攻击2 || 0) * inc;
          attackerBonus.闪避2 = (attackerBonus.闪避2 || 0) + (vBonus.闪避2 || 0) * inc;
          attackerBonus.命中2 = (attackerBonus.命中2 || 0) + (vBonus.命中2 || 0) * inc;
          // 其余载具加成（生命/护盾/装甲/伤害/暴击等）
          for (const key of ['攻击', '生命', '护盾', '装甲', '闪避', '命中', '速度', '暴击', '暴击伤害', '物伤', '火伤', '冰伤', '电伤'] as const) {
            if (vBonus[key]) {
              (attackerBonus as any)[key] = ((attackerBonus as any)[key] || 0) + (vBonus[key] || 0) * inc;
            }
          }
          // 发丝（白的发丝）：掉落率/品质固定
          if (v.hair || v.发丝) {
            attackerBonus.掉落率 = 0;
            attackerBonus.掉落品质 = 0;
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
      attackerBonus.攻击 = (attackerBonus.攻击 || 0) + (attackerBonus.攻击 || 0) * (familiarEffect.attackBonus / 100);
      if (familiarEffect.effectText.includes('火力')) {
        resultLines.push(`【普拉娜·火力】攻击+${familiarEffect.attackBonus}%`);
      } else {
        resultLines.push(`【使魔特效】攻击+${familiarEffect.attackBonus}%`);
      }
    }
    if (familiarEffect.critDmgBonus) {
      attackerBonus.暴击伤害 = (attackerBonus.暴击伤害 || 150) + familiarEffect.critDmgBonus;
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
      attackerBonus.闪避 = 1;
      attackerBonus.闪避2 = 0;
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
        attackerBonus.暴击 = 100; // 隐匿模式远程暴击率100%
        resultLines.push('【隐匿模式】远程伤害×1.5且必暴击');
      } else {
        resultLines.push('【隐匿攻击】');
      }
    }

    // 2. 次元破碎（装备）：33%几率 +20 三层穿透
    const hasDimBreak = (playerData.equipment || []).some((e: any) => (e.name || '').includes('次元破碎'));
    if (hasDimBreak && Math.random() < 0.33) {
      attackerBonus.护盾穿透 = (attackerBonus.护盾穿透 || 0) + 20;
      attackerBonus.装甲穿透 = (attackerBonus.装甲穿透 || 0) + 20;
      attackerBonus.生命穿透 = (attackerBonus.生命穿透 || 0) + 20;
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

    // ========== 战斗结果统计计数器（对应原版 简略模式 L755-771 攻击N次/命中X次/被闪避Y次） ==========
    // 原版用成就计数 冰伤2(未命中)/火伤2(被闪避)/电伤2(命中零伤)/物伤2(有效伤) 记录每次攻击结果，
    // 并在攻击次数>1 时输出"攻击N次，命中X次，被闪避Y次，命中零伤Z次，有效伤W次"。
    const atkStats = { total: 0, hit: 0, dodged: 0, nullDmg: 0, effective: 0 };

    // 原版 战斗相关.ecode L1338-L1349：有麻醉效果的武器优先消耗一枚强效麻醉镖。
    // 原版判断是“数量>1”，因此恰好一枚时仍按普通麻醉处理并保留该物品。
    const anesthesiaEffect = this.prepareWeaponAnesthesia(player, weapon, resultLines);

    for (const target of targets) {
      if (target.hp <= 0) continue;
      atkStats.total++; // 单次攻击尝试计数（对应原版 攻击N次）
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
      // mustHitOverride = context.mustHit 或 唯我主宰触发（原版 L462 必中=真）
      let isHit: boolean;
      if (mustHitOverride) {
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
        atkStats.hit++; // 命中计数（对应原版 物伤2 有效伤累计基础）
        this.achievementService.addAchievement(player, '战斗熟练度', 1);
        if (weapon.type) {
          this.achievementService.addAchievement(player, `${weapon.type}熟练度`, 1);
        }
        // 记录攻击者，保证参与战斗的玩家获得奖励
        const targetMarkers = this.normalizeMarkerObject(target.markers);
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
          // saber好感≥40：有"ex"增益时伤害=0（原版 战斗相关.ecode L2240-2246：防御方.好感>=40 && 增益要求("ex")）
          const defAff2 = target.affinity ?? (target as any).好感 ?? 0;
          const tBuffs2 = this.safeParseJson<any[]>(target.buffs, []);
          if (defAff2 >= 40 && tBuffs2.some((b: any) => b && b.name === 'ex')) {
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
        atkStats.dodged++; // 被闪避计数（对应原版 火伤2 被闪避次数）
        // 对应原版 战斗相关.ecode L1481：显示攻击文本(z1, 0, 攻击文本) 抽取「未命中」分类模板
        // 并展开占位符（如"【目标】躲开了【名称】的拳头"）；无配置时退回简版提示。
        const missName = (attackText ?? '').trim() || this.resolveAttackTextName(weapon);
        const missTemplates = this.getAttackTextTemplates(missName, 0);
        if (missTemplates.length > 0) {
          const tpl = missTemplates[Math.floor(Math.random() * missTemplates.length)];
          resultLines.push(this.expandAttackPlaceholders(tpl, player.name || '', target.name, String(weapon.name || '拳头'), this.getAttackerVehicleName(player, map)));
        } else {
          resultLines.push(`${target.name} 闪避了攻击`);
        }
        // 未命中：防御方获得「闪避熟练度」（对应原版 L1484）
        const tMarkers = this.normalizeMarkerObject(target.markers);
        tMarkers['闪避熟练度'] = (tMarkers['闪避熟练度'] || 0) + 1;
        target.markers = JSON.stringify(tMarkers);
        // 原版“闪避攻击”成就只在玩家作为攻击方的玩家对战分支产生。
        if (player.specialSeq > 0 && target.userId && Number(target.specialSeq ?? 0) > 0) {
          taskProgress.push({ userId: Number(target.userId), actionName: '闪避攻击', count: 1 });
        }
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
                attackerBonus.护盾穿透 = (attackerBonus.护盾穿透 || 0) + 15;
                attackerBonus.装甲穿透 = (attackerBonus.装甲穿透 || 0) + 15;
                attackerBonus.生命穿透 = (attackerBonus.生命穿透 || 0) + 15;
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
      const isCrit = this.checkCrit(attackerBonus.暴击 || 0, hitByRate);

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
      // 易伤来源：割裂(+10)、影光(+a1×2.5 封顶a1=40)、重伤(+a1)，累加到 defenderBonus.减益，
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
        defenderBonus.减益 = (defenderBonus.减益 || 0) + vuln;
      }
      // 应用使魔特效的额外穿透（单层，原版震撼弹等）
      if (extraPenetration > 0) {
        defenderBonus.生命全抗 = (defenderBonus.生命全抗 || 0) - extraPenetration;
      }
      // 月落寸光：按目标三层平均抗性获得穿透增益(2~20)x(1+技能等级/100)%
      // 原版：平均值越高增益越高，分别注入护盾/装甲/生命三层穿透
      if (nextAttack.nextPenetration) {
        const pen = this.calcMoonlightPenetration(defenderBonus, nextAttack.skillLevelForPen || 0);
        defenderBonus.护盾穿透 = (defenderBonus.护盾穿透 || 0) + pen;
        defenderBonus.装甲穿透 = (defenderBonus.装甲穿透 || 0) + pen;
        defenderBonus.生命穿透 = (defenderBonus.生命穿透 || 0) + pen;
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
        attackerBonus.护盾穿透 = (attackerBonus.护盾穿透 || 0) + specialEffect.extraPenetration;
        attackerBonus.装甲穿透 = (attackerBonus.装甲穿透 || 0) + specialEffect.extraPenetration;
        attackerBonus.生命穿透 = (attackerBonus.生命穿透 || 0) + specialEffect.extraPenetration;
      }
      // 命中修正（因果逆转等）——攻击判定已在此之前完成，此处用于最终命中率展示，不影响本次判定
      hitRateModifier += specialEffect.hitRateModifier || 0;

      // ========== 武器追加伤害（对应原版 造成伤害 L2749-2897 全量） ==========
      // 走完整抗性/倍率流程。目标当前状态 = hp+shield+armor。
      // 本框架无"不触发特效"概念，默认恒为"触发"（不触发特效==假），故各 .如果真 守卫均成立。
      // 额外伤害倍率(extraDamageMult) 对应原版 L983 初始化=1，L1805 镇岳陪睡>2 时 +=0.15。
      // forcedMult：强制伤害倍率修正（套装/装备触发 伤害0/×0.1/×1.5 等），默认1，在最终伤害处乘入。
      let forcedMult = 1;
      // dmgImmune：套装免疫（增幅器2敏锐 s敏锐>=5 → 伤害倍率=0），需跳过保底1点伤害并计为命中零伤。
      let dmgImmune = false;
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
        const targetMk = this.playerService.safeJsonParse<Record<string, number>>(target.markers || {}, {});

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
          attackerBonus.电伤 = (attackerBonus.电伤 || 0) + bonus;
          resultLines.push(`【梅塔特隆】电伤+${Math.round(bonus)}`);
        }

        // ========== 法宝追加伤害（原版 L2778-2796） ==========
        // 镇岳（法宝4级）：命中造成目标当前状态5%的额外物理伤害（×额外伤害倍率）
        if (sakuraHits === 2 && sleepLv > 3) {
          const a2 = targetCurState * 0.05 * extraDamageMult;
          attackerBonus.物伤 = (attackerBonus.物伤 || 0) + a2; // 剩余物伤 += a2（原版 L2782-2783）
          resultLines.push(`【镇岳】+${Math.round(a2)}`);
        }
        // 飞天独龙神女枪（法宝7级）：造成伤害时额外造成目标当前状态5%的雷电伤害
        else if (sakuraHits === 1 && sleepLv > 7) {
          const a2 = targetCurState * 0.05 * extraDamageMult;
          attackerBonus.电伤 = (attackerBonus.电伤 || 0) + a2;
          resultLines.push(`【神女枪】+${Math.round(a2)}`);
        }

        // ========== 武器自带麻醉判定（原版 L2797：z1.自带.麻醉 <= 0） ==========
        const z1Anesthesia = (weapon.self as any)?.anesthesia || 0;
        if (z1Anesthesia <= 0) {
          // 斩舰刀（特殊序号-22）：a1 += 5（每击物伤+5%，原版 L2798-2799）
          if (weapon.specialSeq === -22 || weapon.name?.includes('斩舰刀')) {
            attackerBonus.物伤 = (attackerBonus.物伤 || 0) + (attackerBonus.攻击 || 0) * 0.05;
            resultLines.push('【斩舰刀】物伤+5%');
          }
          // 退魔圣焰（特殊序号-8）：物伤×0.4 转为火/冰/电三系（原版 L2800-2804）
          if (weapon.specialSeq === -8 || weapon.name?.includes('退魔圣焰')) {
            const origPhys = (attackerBonus.物伤 || 0) + (attackerBonus.攻击 || 0);
            const conv = origPhys * 0.4;
            attackerBonus.物伤 = 0;
            attackerBonus.火伤 = (attackerBonus.火伤 || 0) + conv;
            attackerBonus.冰伤 = (attackerBonus.冰伤 || 0) + conv;
            attackerBonus.电伤 = (attackerBonus.电伤 || 0) + conv;
            resultLines.push(`【退魔圣焰】物伤转化+${Math.round(conv * 3)}`);
          }
          // 袖剑（装备要求 #袖剑，原版 L2808-2817）：满状态>90% + 5秒冷却 → a1 += 10
          const myState = (player.hp || 0) + (player.shield || 0) + (player.armor || 0);
          const myMaxState = (player.maxHp || player.hp || 0) + (player.maxShield || player.shield || 0) + (player.maxArmor || player.armor || 0);
          const hasSleeveDagger = (playerData.equipment as any[])?.some((e: any) => (e.name || '').includes('袖剑'));
          if (hasSleeveDagger && myState > myMaxState * 0.9 && (!playerMk['袖剑冷却'] || nowSec - (playerMk['袖剑冷却'] || 0) > 5)) {
            playerMk['袖剑冷却'] = nowSec;
            attackerBonus.物伤 = (attackerBonus.物伤 || 0) + (attackerBonus.攻击 || 0) * 0.1;
            resultLines.push(`【袖剑】物伤+10%`);
          }
        }

        // ========== 不触发特效==假 段（原版 L2818-2897） ==========
        // ---- 觉醒天神（原版 L2819-2829：攻击方特殊序号<-1 且 觉醒熟练≥500） ----
        if ((player.specialSeq ?? 0) < -1 && (playerMk['觉醒'] ?? 0) >= 500) {
          const a2 = targetMaxState * 0.03 / 4 * extraDamageMult;
          attackerBonus.火伤 = (attackerBonus.火伤 || 0) + a2;
          attackerBonus.物伤 = (attackerBonus.物伤 || 0) + a2;
          attackerBonus.电伤 = (attackerBonus.电伤 || 0) + a2;
          attackerBonus.冰伤 = (attackerBonus.冰伤 || 0) + a2;
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
            attackerBonus.火伤 = (attackerBonus.火伤 || 0) + (attackerBonus.火伤 || 0) * 0.75 * m;
            attackerBonus.物伤 = (attackerBonus.物伤 || 0) + (attackerBonus.物伤 || 0) * 0.75 * m;
            attackerBonus.冰伤 = (attackerBonus.冰伤 || 0) + (attackerBonus.冰伤 || 0) * 0.75 * m;
            attackerBonus.电伤 = (attackerBonus.电伤 || 0) + (attackerBonus.电伤 || 0) * 0.75 * m;
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
          attackerBonus.火伤 = (attackerBonus.火伤 || 0) + a2;
          attackerBonus.物伤 = (attackerBonus.物伤 || 0) + a2;
          attackerBonus.电伤 = (attackerBonus.电伤 || 0) + a2;
          attackerBonus.冰伤 = (attackerBonus.冰伤 || 0) + a2;
          resultLines.push(`【无双】+${Math.round(a2 * 4)}`);
        }
        // ---- 常春藤（原版 L2852-2867：攻击方活力==#常春藤(-14)，生体/近战武器命中时目标当前状态×5%物伤） ----
        if (player.vitality === -14 || player.活力 === -14) {
          const wtype = weapon.type || '';
          const isBioMelee = wtype.includes('生体') || wtype.includes('近战');
          if (isBioMelee) {
            const a2 = targetCurState * 0.05 * extraDamageMult;
            attackerBonus.物伤 = (attackerBonus.物伤 || 0) + a2;
            resultLines.push(`【神爪】+${Math.round(a2)}`);
          }
        }
        // ---- 军姬2（原版 L2868-2875：攻击方特殊序号==#军姬2(24)，目标已损失状态×4%/4 四系） ----
        if ((player.specialSeq ?? 0) === 24) {
          const a2 = lostState * 0.04 / 4 * extraDamageMult;
          attackerBonus.火伤 = (attackerBonus.火伤 || 0) + a2;
          attackerBonus.物伤 = (attackerBonus.物伤 || 0) + a2;
          attackerBonus.电伤 = (attackerBonus.电伤 || 0) + a2;
          attackerBonus.冰伤 = (attackerBonus.冰伤 || 0) + a2;
          resultLines.push(`【撕裂】+${Math.round(a2 * 4)}`);
        }
        // ---- 武器判断：法芙娜 / 伊苏尔德的剪刀（原版 L2876-2892） ----
        // 法芙娜（特殊序号-20）：目标已损失状态×5%/4，四系均加
        if (weapon.specialSeq === -20 || weapon.name?.includes('法芙娜')) {
          const bonus = lostState * 0.05 / 4 * extraDamageMult;
          attackerBonus.火伤 = (attackerBonus.火伤 || 0) + bonus;
          attackerBonus.物伤 = (attackerBonus.物伤 || 0) + bonus;
          attackerBonus.电伤 = (attackerBonus.电伤 || 0) + bonus;
          attackerBonus.冰伤 = (attackerBonus.冰伤 || 0) + bonus;
          resultLines.push(`【法芙娜·撕裂】+${Math.round(bonus * 4)}`);
        }
        // 伊苏尔德的剪刀（特殊序号-24）：目标最大状态×3%/4，四系均加
        if (weapon.specialSeq === -24 || weapon.name?.includes('剪刀')) {
          const bonus = targetMaxState * 0.03 / 4 * extraDamageMult;
          attackerBonus.火伤 = (attackerBonus.火伤 || 0) + bonus;
          attackerBonus.物伤 = (attackerBonus.物伤 || 0) + bonus;
          attackerBonus.电伤 = (attackerBonus.电伤 || 0) + bonus;
          attackerBonus.冰伤 = (attackerBonus.冰伤 || 0) + bonus;
          resultLines.push(`【伊苏尔德的剪刀】+${Math.round(bonus * 4)}`);
        }
        // ---- 火焰披风（原版 L2893-2897：装备要求 #火焰披风，30秒冷却，自身当前状态/10 火伤 + 穿透5） ----
        const hasFlameCloak = (playerData.equipment as any[])?.some((e: any) => (e.name || '').includes('火焰披风'));
        if (hasFlameCloak && (!playerMk['火焰披风'] || nowSec - (playerMk['火焰披风'] || 0) > 30)) {
          playerMk['火焰披风'] = nowSec;
          const a2 = ((player.hp || 0) + (player.shield || 0) + (player.armor || 0)) / 10 * extraDamageMult;
          attackerBonus.火伤 = (attackerBonus.火伤 || 0) + a2;
          attackerBonus.贯穿 = (attackerBonus.贯穿 || 0) + 5;
          resultLines.push(`【火焰披风】火伤+${Math.round(a2)}，穿透+5`);
        }

        // ========== 装备要求类穿透（原版 造成伤害 L2447 / L2021-2062） ==========
        // 两极反转（装备 specialSeq=63）：穿透+8（原版 L2447 增加穿透(攻击方.属性, 8)）
        const hasReverse = (playerData.equipment as any[])?.some(
          (e: any) => e.specialSeq === 63 || (e.name || '').includes('两极反转'),
        );
        if (hasReverse) {
          const cd = playerMk['两极反转冷却'] || 0;
          if (!playerMk['两级反转'] || nowSec - (playerMk['两级反转'] || 0) > 25) {
            playerMk['两级反转'] = nowSec;
            attackerBonus.护盾穿透 = (attackerBonus.护盾穿透 || 0) + 8;
            attackerBonus.装甲穿透 = (attackerBonus.装甲穿透 || 0) + 8;
            attackerBonus.生命穿透 = (attackerBonus.生命穿透 || 0) + 8;
            resultLines.push('【两极反转】穿透+8');
          }
        }

        // 法宝穿透：惊鲵(小樱命中次数=4)陪睡>5 → 火穿/甲穿/命穿+10（原版 L2021-2026）
        if (sakuraHits === 4 && sleepLv > 5) {
          attackerBonus.护盾穿透 = (attackerBonus.护盾穿透 || 0) + 10;
          attackerBonus.装甲穿透 = (attackerBonus.装甲穿透 || 0) + 10;
          attackerBonus.生命穿透 = (attackerBonus.生命穿透 || 0) + 10;
          resultLines.push('【惊鲵·穿透】三层穿透+10');
        }
        // 法宝[镇岳](小樱命中次数=2)：陪睡>1 → 物穿/甲穿/命穿+10（原版 L2028-2033）
        if (sakuraHits === 2 && sleepLv > 1) {
          attackerBonus.护盾穿透 = (attackerBonus.护盾穿透 || 0) + 10;
          attackerBonus.装甲穿透 = (attackerBonus.装甲穿透 || 0) + 10;
          attackerBonus.生命穿透 = (attackerBonus.生命穿透 || 0) + 10;
          // 陪睡>9 且 攻击方.属性.贯穿>0 → 各+贯穿/3，贯穿清零（原版 L2034-2041）
          if (sleepLv > 9 && (attackerBonus.贯穿 || 0) > 0) {
            const pen3 = (attackerBonus.贯穿 || 0) / 3;
            attackerBonus.护盾穿透 = (attackerBonus.护盾穿透 || 0) + pen3;
            attackerBonus.装甲穿透 = (attackerBonus.装甲穿透 || 0) + pen3;
            attackerBonus.生命穿透 = (attackerBonus.生命穿透 || 0) + pen3;
            attackerBonus.贯穿 = 0;
          }
        }
        // 植入体 1-4：分别 → 物/火/冰/电 三层穿透+10（原版 L2046-2062）
        const implant = setsData['植入体'] ?? setsData.implant ?? 0;
        if (implant === 1) {
          attackerBonus.护盾穿透 = (attackerBonus.护盾穿透 || 0) + 10;
          attackerBonus.装甲穿透 = (attackerBonus.装甲穿透 || 0) + 10;
          attackerBonus.生命穿透 = (attackerBonus.生命穿透 || 0) + 10;
        } else if (implant === 2) {
          attackerBonus.护盾穿透 = (attackerBonus.护盾穿透 || 0) + 10;
          attackerBonus.装甲穿透 = (attackerBonus.装甲穿透 || 0) + 10;
          attackerBonus.生命穿透 = (attackerBonus.生命穿透 || 0) + 10;
        } else if (implant === 3) {
          attackerBonus.护盾穿透 = (attackerBonus.护盾穿透 || 0) + 10;
          attackerBonus.装甲穿透 = (attackerBonus.装甲穿透 || 0) + 10;
          attackerBonus.生命穿透 = (attackerBonus.生命穿透 || 0) + 10;
        } else if (implant === 4) {
          attackerBonus.护盾穿透 = (attackerBonus.护盾穿透 || 0) + 10;
          attackerBonus.装甲穿透 = (attackerBonus.装甲穿透 || 0) + 10;
          attackerBonus.生命穿透 = (attackerBonus.生命穿透 || 0) + 10;
        }

        // ========== 增幅器套装 2/4/1（原版 造成伤害 L1981-2018） ==========
        // 原版 套装.增幅器 对应本框架 setsData['增幅器']。
        const amplifier = setsData['增幅器'] ?? setsData.amplifier ?? 0;
        if (amplifier === 2) {
          // 敏锐（防御方 s敏锐>=5 → 伤害倍率=0）
          const sMin = targetMk['s敏锐'] || 0;
          if (sMin >= 5) {
            targetMk['s敏锐'] = Math.max(0, sMin - 5);
            forcedMult = 0;
            dmgImmune = true; // 套装免疫：跳过保底1点伤害
            resultLines.push('【敏锐】本次伤害被免疫');
          }
        } else if (amplifier === 4) {
          // 坚毅（防御方 s坚毅>=5 → 易伤 -a*10）
          const sJie = targetMk['s坚毅'] || 0;
          if (sJie >= 5) {
            targetMk['s坚毅'] = 0;
            defenderBonus.减益 = (defenderBonus.减益 || 0) - sJie * 10;
            resultLines.push(`【坚毅】易伤-${sJie * 10}%`);
          }
        } else if (amplifier === 1) {
          // 速射（攻击方 s速射>=5 → 蓄力 伤害×1.5 + 三层穿透+10；否则 伤害×0.9）
          const sSpeed = playerMk['s速射'] || 0;
          if (sSpeed >= 5) {
            playerMk['s速射'] = 0;
            forcedMult *= 1.5;
            attackerBonus.护盾穿透 = (attackerBonus.护盾穿透 || 0) + 10;
            attackerBonus.装甲穿透 = (attackerBonus.装甲穿透 || 0) + 10;
            attackerBonus.生命穿透 = (attackerBonus.生命穿透 || 0) + 10;
            resultLines.push('【蓄力】伤害×1.5，穿透+10');
          } else {
            forcedMult *= 0.9;
            playerMk['s速射'] = (playerMk['s速射'] || 0) + 1;
            resultLines.push('【速射】伤害×0.9');
          }
        }

        // ========== 超压（普拉娜专属，原版 造成伤害 L1892-1911） ==========
        // 取成就熟练度(攻击方.标记, z1.名称+"t")>=1 → 伤害倍率×1.25（普拉娜好感>=60 → ×(1.25+技等×0.01)）
        if ((playerMk[`${weapon.name}t`] || 0) >= 1) {
          delete playerMk[`${weapon.name}t`];
          const isPlana = (player.specialSeq ?? 0) === 23 || player.type === '普拉娜'; // #普拉娜=23
          if (isPlana && (player.affinity ?? player.好感 ?? 0) >= 60) {
            forcedMult *= 1.25 + (player.skillLevel ?? player.技能等级 ?? 0) * 0.01;
          } else {
            forcedMult *= 1.25;
          }
          resultLines.push('【超压】伤害提升');
        }

        // ========== 第二批套装/武器/负面类型特效（原版 造成伤害 L1813-2160） ==========
        // 防御方增益集合（原版 防御方.增益）；此处从 target.buffs 读取（怪物/玩家统一）
        const defenderBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
        const hasDefBuff = (name: string) =>
          defenderBuffs.some((b: any) => b && (b.name || b.名称) === name);

        // ---- 创世纪（z1.特殊序号 == #创世纪(-18)：清空防御方三池+背包+经验，显示类型=1） ----
        // 原版 L1813-1821：防御方.当前护盾/当前装甲/当前生命=0；若为怪物则重定义背包、经验=0
        if (weapon.specialSeq === -18 || weapon.name?.includes('创世纪')) {
          target.hp = 0; (target as any).currentHp = 0;
          target.shield = 0; (target as any).currentShield = 0;
          target.armor = 0; (target as any).currentArmor = 0;
          if ((target as any).backpack || (target as any).背包) {
            (target as any).backpack = []; (target as any).背包 = [];
          }
          (target as any).exp = 0; (target as any).经验 = 0;
          resultLines.push('【创世纪】目标状态被清空');
        }

        // ---- 安乐天使（防御方增益含"安乐天使" → 伤害倍率=0，免疫，原版 L1824-1826） ----
        if (hasDefBuff('安乐天使')) {
          forcedMult = 0;
          dmgImmune = true; // 与敏锐同：跳过保底1点伤害
          resultLines.push('【安乐天使】本次伤害被免疫');
        }

        // ---- invincible 字段（防御方任意 buff 含 invincible:true → 本次伤害免疫） ----
        // 统一在此消费 addBuff 写入的 invincible 字段，对应原版使魔好感「无敌」语义
        // （如 saber 好感2「15秒内抵挡所有伤害」、安乐天使·护盾）。各技能只需写 invincible:true，
        // 不必各自造消费分支。已免疫则跳过，避免重复文本。
        if (!dmgImmune) {
          const defBuffsInv = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
          if (defBuffsInv.some((b: any) => b && b.invincible === true)) {
            forcedMult = 0;
            dmgImmune = true;
            resultLines.push('【无敌】本次伤害被完全抵挡');
          }
        }

        // ========== 武器特殊序号判断（原版 造成伤害 L1827-1867，紧接安乐天使之后） ==========
        // 对应 @Constant.ecode：仿真尾巴=-36 / 火焰飞羽=-30 / 纵横=-13 / 矢量=-12 / 影光=-23 / 寒风=-10 / 光棱=-29
        // 原版本段三类目标字段：
        //   · 武器冷却(仿真尾巴减CD/寒风加CD) → 原版「攻击方.标记2 / 防御方.标记2」= 框架 markers2 数组（元素 {name, expireAt}），与武器攻击冷却 L94-103 同一容器
        //   · 技能冷却(光棱) → 同为 markers2 数组（"类型+技能冷却"）
        //   · 防御方增益(火焰飞羽/影光) → 框架 target.buffs（中文 key {name, expireAt}）
        //   · 额外生命/装甲伤害(纵横/矢量) → BonusData（中文属性 key）

        // 本地解析 markers2 数组（原版 标记2 容器），与 L295-322 武器冷却读写约定一致
        // 注意：本段 markers2 容器的 expireAt 统一采用「毫秒」单位（与武器冷却 L322 一致），
        // 与 targetMk/playerMk（markers 对象，秒级 nowSec）不同，操作时需换算。
        const nowMs = Date.now();
        const atkMk2 = this.safeParseJson<any[]>(player.markers2 || '[]', []);
        const defMk2 = this.safeParseJson<any[]>(target.markers2 || '[]', []);

        // ---- 仿真尾巴（z1.特殊序号==#仿真尾巴(-36)：遍历攻击方武器，非仿真尾巴且处于"名称+冷却"状态则 CD-5，原版 L1827-1841） ----
        if (weapon.specialSeq === -36 || weapon.name?.includes('仿真尾巴')) {
          const atkWeapons = this.safeParseJson<any[]>(player.weapons || (player as any).武器 || '[]', []);
          let b = 0;
          for (const w of atkWeapons) {
            const wName = w.name || w.名称;
            if (w.specialSeq === -36 || (wName || '').includes('仿真尾巴')) continue; // 跳过仿真尾巴自身
            const cdKey = `${wName}冷却`;
            // 增益要求(攻击方.标记2, "名称+冷却") 存在且未过期即处于冷却中；markers2.expireAt 为毫秒
            const entry = atkMk2.find((m: any) => m?.name === cdKey && m.expireAt > nowMs);
            if (entry) {
              entry.expireAt = Math.max(nowMs, entry.expireAt - 5 * 1000); // 获得增益(...,-5,真,...) 减5秒（毫秒换算，不低于当前时刻）
              b++;
            }
          }
          if (b > 0) resultLines.push(`【仿真尾巴】${b}把武器CD-5`);
        }

        // ---- 火焰飞羽（z1.特殊序号==#火焰飞羽(-30)：给防御方加"飞羽"增益60秒，原版 L1843-1844） ----
        if (weapon.specialSeq === -30 || weapon.name?.includes('火焰飞羽')) {
          const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
          if (!tBuffs.some((x: any) => (x.name || x.名称) === '飞羽' && x.expireAt > nowSec + 30)) {
            tBuffs.push({ name: '飞羽', expireAt: nowSec + 30, 强度: 1 }); // 原版 获得增益(防御方.增益,"飞羽",30,假,s,1,真)
          }
          target.buffs = JSON.stringify(tBuffs);
        }

        // ---- 纵横（z1.特殊序号==#纵横(-13)：额外生命火伤 += 防御方生命*0.05*额外伤害倍率，原版 L1845-1846） ----
        if (weapon.specialSeq === -13 || weapon.name?.includes('纵横')) {
          const targetHp = target.maxHp || target.hp || (target as any).属性?.生命 || 0;
          attackerBonus.火伤 = (attackerBonus.火伤 || 0) + targetHp * 0.05 * extraDamageMult;
        }

        // ---- 矢量（z1.特殊序号==#矢量(-12)：额外装甲冰伤 += 防御方装甲*0.05*额外伤害倍率，原版 L1847-1848） ----
        if (weapon.specialSeq === -12 || weapon.name?.includes('矢量')) {
          const targetArmor = target.maxArmor || target.armor || (target as any).属性?.装甲 || 0;
          attackerBonus.冰伤 = (attackerBonus.冰伤 || 0) + targetArmor * 0.05 * extraDamageMult;
        }

        // ---- 影光（z1.特殊序号==#影光(-23)：给防御方加"影光"增益60秒，原版 L1849-1850；
        //      后续 L2263 读"影光"增益 → 易伤 += a1*2.5 已在 calcDamage 对应段实现） ----
        if (weapon.specialSeq === -23 || weapon.name?.includes('影光')) {
          const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
          if (!tBuffs.some((x: any) => (x.name || x.名称) === '影光' && x.expireAt > nowSec + 60)) {
            tBuffs.push({ name: '影光', expireAt: nowSec + 60, 强度: 1 }); // 原版 获得增益(防御方.增益,"影光",60,假,s,1,真)
          }
          target.buffs = JSON.stringify(tBuffs);
        }

        // ---- 寒风（z1.特殊序号==#寒风(-10)：防御方未处于"被寒风冷却"(180s)时，防御方所有武器CD+30，原版 L1851-1857） ----
        // 原版 时间间隔要求("被寒风冷却",180,防御方.标记2,...)==假 → 未冷却，触发。markers2.expireAt 为毫秒，间隔比对用毫秒
        if (weapon.specialSeq === -10 || weapon.name?.includes('寒风')) {
          const hfc = defMk2.find((m: any) => m?.name === '被寒风冷却');
          if (!hfc || nowMs - (hfc.expireAt || 0) > 180 * 1000) {
            // 写入"被寒风冷却"标记（expireAt 记录触发时刻，毫秒，间隔比对同原版 180s）
            const exist = defMk2.find((m: any) => m?.name === '被寒风冷却');
            if (exist) exist.expireAt = nowMs;
            else defMk2.push({ name: '被寒风冷却', expireAt: nowMs });
            const defWeapons = this.safeParseJson<any[]>(target.weapons || (target as any).武器 || '[]', []);
            for (const w of defWeapons) {
              const wName = w.name || w.名称;
              const tKey = `${wName}冷却`; // 获得增益(防御方.标记2,"名称+冷却",30,真,s)
              const te = defMk2.find((m: any) => m?.name === tKey);
              if (te) te.expireAt = Math.max(te.expireAt, (nowSec + 30) * 1000);
              else defMk2.push({ name: tKey, expireAt: (nowSec + 30) * 1000 });
            }
            resultLines.push('【寒风】');
          }
        }

        // ---- 光棱（z1.特殊序号==#光棱(-29)：攻击方未处于"光棱"(240s)时，攻击方「类型+技能冷却」-60 并释放使魔技能，原版 L1859-1863） ----
        if (weapon.specialSeq === -29 || weapon.name?.includes('光棱')) {
          const gl = atkMk2.find((m: any) => m?.name === '光棱');
          if (!gl || nowMs - (gl.expireAt || 0) > 240 * 1000) {
            // 写入"光棱"冷却记录（expireAt 记录触发时刻，毫秒，间隔比对同原版 240s）
            const gle = atkMk2.find((m: any) => m?.name === '光棱');
            if (gle) gle.expireAt = nowMs;
            else atkMk2.push({ name: '光棱', expireAt: nowMs });
            const typeKey = `${player.type || (player as any).类型 || '玩家'}技能冷却`;
            const sk = atkMk2.find((m: any) => m?.name === typeKey);
            if (sk) sk.expireAt = Math.max(nowMs, sk.expireAt - 60 * 1000); // 获得增益(攻击方.标记2,"类型+技能冷却",-60,真,s)
            else atkMk2.push({ name: typeKey, expireAt: Math.max(nowMs, (nowSec - 60) * 1000) });
            // 原版 释放使魔技能(攻击方, s)（战斗相关.ecode L1862）：自动释放攻击方使魔特有技能。
            // 经 forwardRef 注入的 FamiliarSkillsService 回调，走主动技能完整门禁
            // （类型校验/冷却/好感门槛）；未注入（测试按位置 new 的桩）或玩家未设特有技能时静默跳过。
            if (!isRuntimeActor && this.familiarSkills) {
              try {
                const autoText = await this.familiarSkills.autoReleaseFamiliarSkill(userId);
                if (autoText) resultLines.push(autoText);
              } catch (e: any) {
                this.logger.warn(`光棱自动释放使魔技能失败: ${e?.message ?? e}`);
              }
            }
          }
        }

        // ---- 神兽之力青龙（原版 L4500-4507：命中后给防御方5秒麻痹，并把每件武器冷却延长5秒） ----
        if (weapon.specialSeq === -31 || weapon.name?.includes('神兽之力青龙')) {
          defMk2.push({ name: '麻痹', expireAt: nowMs + 5 * 1000, 强度: 0 });
          const targetWeapons = this.safeParseJson<any[]>(target.weapons || (target as any).武器 || '[]', []);
          for (const targetWeapon of targetWeapons) {
            const targetWeaponName = targetWeapon?.name || targetWeapon?.名称;
            if (targetWeaponName) {
              const cooldownKey = `${targetWeaponName}冷却`;
              const cooldownEntry = defMk2.find((m: any) => m?.name === cooldownKey);
              if (cooldownEntry) cooldownEntry.expireAt += 5 * 1000;
              else defMk2.push({ name: cooldownKey, expireAt: nowMs + 5 * 1000 });
            }
          }
        }

        // 写回 markers2 数组变更（原版 标记2 容器）
        player.markers2 = JSON.stringify(atkMk2);
        target.markers2 = JSON.stringify(defMk2);

        // ---- 短衬衫2（防御方标记2含"短衬衫2" → 伤害×0.1，不叠加，原版 L1945-1947） ----
        if (targetMk['短衬衫2']) {
          forcedMult *= 0.1;
          resultLines.push('【短衬衫】伤害×0.1');
        }

        // ---- 永恒主宰（防御方装备含#永恒主宰(83)，60s cd → 伤害=0，原版 L1949-1953） ----
        const defEquip = (target as any).equipment as any[];
        const hasEternal = defEquip?.some((e: any) => e.specialSeq === 83 || (e.name || '').includes('永恒主宰'));
        if (hasEternal && (!targetMk['yzj'] || nowSec - (targetMk['yzj'] || 0) > 60)) {
          targetMk['yzj'] = nowSec;
          forcedMult = 0;
          dmgImmune = true;
          resultLines.push('【永恒主宰】本次伤害被免疫');
        }

        // ---- 负面类型触发计数（原版 L2070-2106：z1.负面类型 1/2/3/默认 → 割裂1/灼烧1/深寒1/感电1 累计，≥4 转正式增益） ----
        const negativeType = (weapon as any).negativeType ?? (weapon as any).负面类型 ?? 0;
        if (negativeType > 0) {
          let cntKey = '', formal = '', effName = '';
          if (negativeType === 1) { cntKey = '割裂1'; formal = '割裂'; effName = '割裂'; }
          else if (negativeType === 2) { cntKey = '灼烧1'; formal = '灼烧'; effName = '灼烧'; }
          else if (negativeType === 3) { cntKey = '深寒1'; formal = '深寒'; effName = '深寒'; }
          else { cntKey = '感电1'; formal = '感电'; effName = '感电'; }
          const cnt = (targetMk[cntKey] || 0) + 1;
          if (cnt >= 4) {
            // 计数清零，并给防御方加正式增益（原版 获得增益(防御方.增益, formal, 30,...)）
            targetMk[cntKey] = 0;
            const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
            if (!tBuffs.some((b: any) => b && (b.name || b.名称) === formal && b.expireAt > nowSec + 30)) {
              tBuffs.push({ name: formal, expireAt: nowSec + 30 });
            }
            target.buffs = JSON.stringify(tBuffs);
            if (effName === '灼烧' || effName === '深寒' || effName === '感电') {
              resultLines.push(`【${effName}】`);
            }
            // 原版在负面效果累计到4层时给攻击方任务记一次对应触发动作。
            taskProgress.push({ actionName: `触发${formal}`, count: 1 });
            // 深寒额外：所有武器CD+3（原版 L2091-2093）
            if (effName === '深寒') {
              const tWeapons = this.safeParseJson<any[]>(target.weapons || (target as any).武器 || '[]', []);
              tWeapons.forEach((w: any) => {
                targetMk[`${w.name || w.名称}冷却`] = nowSec;
              });
            }
          } else {
            targetMk[cntKey] = cnt;
          }
        }

        // ---- 感电增益 + 星尘超新星（原版 L2109-2136） ----
        // 负面类型可能刚把"感电"写入防御方增益，此处重新解析以纳入本次生效
        const defBuffs2 = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
        if (defBuffs2.some((b: any) => b && (b.name || b.名称) === '感电')) {
          resultLines.push('【感电】');
          // 增加全抗(防御方.属性, -5,-5,-5)：原版火/冰/电三系抗性各-5，本框架以三层全抗各-5 等效表达
          defenderBonus.生命全抗 = (defenderBonus.生命全抗 || 0) - 5;
          defenderBonus.护盾全抗 = (defenderBonus.护盾全抗 || 0) - 5;
          defenderBonus.装甲全抗 = (defenderBonus.装甲全抗 || 0) - 5;
          // 星尘好感≥60 → 穿透+10、攻击+25+技等/2、超新星电伤
          if ((player.affinity ?? (player as any).好感 ?? 0) >= 60 && (player.specialSeq ?? 0) === 14) { // #星尘=14
            attackerBonus.护盾穿透 = (attackerBonus.护盾穿透 || 0) + 10;
            attackerBonus.装甲穿透 = (attackerBonus.装甲穿透 || 0) + 10;
            attackerBonus.生命穿透 = (attackerBonus.生命穿透 || 0) + 10;
            attackerBonus.攻击 = (attackerBonus.攻击 || 0) + (25 + (player.skillLevel ?? (player as any).技能等级 ?? 0) / 2);
            const maxSh = target.maxShield || target.shield || 0;
            const curSh = target.currentShield || target.shield || 0;
            const a2 = maxSh > 0 ? 1 - curSh / maxSh : 0;
            const sn = a2 < 0.1 ? maxSh * 0.1 : maxSh * a2; // 原版 L2116-2122
            attackerBonus.电伤 = (attackerBonus.电伤 || 0) + sn;
            resultLines.push(`【超新星】电伤+${Math.round(sn)}`);
          }
        }

        // ---- 圣诞套装（防御方.套装.圣诞==2，30s cd → 掉落圣诞礼物，原版 L2151-2158） ----
        const defSets = this.safeParseJson<any>(target.sets || '{}', {});
        if ((defSets['圣诞'] ?? defSets.christmas) === 2 && (!targetMk['圣诞'] || nowSec - (targetMk['圣诞'] || 0) > 30)) {
          targetMk['圣诞'] = nowSec;
          resultLines.push('【掉落礼物】圣诞礼物'); // 实际入地图物品池由战利品系统处理，此处记录触发
        }

        // ---- 龙姬驱魔（攻击方特殊序号==#龙姬(12)：龙姬增伤清零加成，原版 L2161-2168） ----
        if ((player.specialSeq ?? 0) === 12) {
          const dragonDmg = playerMk['龙姬增伤'] || 0;
          if (dragonDmg !== 0) {
            attackerBonus.攻击 = (attackerBonus.攻击 || 0) + dragonDmg; // 增加单项攻击(攻击方,1,a1)
            resultLines.push(`【驱魔】+${Math.round(dragonDmg)}`);
            playerMk['龙姬增伤'] = 0;
          }
        }

        // ========== 第三批 使魔/装备专属特效（原版 造成伤害 L2161-2258 / L2439 / L2471-2586） ==========
        const atkSeq = player.specialSeq ?? 0;
        const defSeq = target.specialSeq ?? 0;
        const atkVit = player.vitality ?? (player as any).活力 ?? 0;
        const defVit = target.vitality ?? (target as any).活力 ?? 0;
        const atkAff = player.affinity ?? (player as any).好感 ?? 0;
        const defAff = target.affinity ?? (target as any).好感 ?? 0;
        const atkSkill = player.skillLevel ?? (player as any).技能等级 ?? 0;
        const defSkill = target.skillLevel ?? (target as any).技能等级 ?? 0;
        const defWeapons = this.safeParseJson<any[]>(target.weapons || (target as any).武器 || '[]', []);

        // ---- 攻击方使魔专属（原版 L2161-2218） ----
        // 古月娜(#古月娜=5) / 银龙：防御方所有武器 +"冷却"标记1秒（L2170-2173）
        if (atkSeq === 5 || player.type === '银龙' || (player as any).类型 === '银龙') {
          defWeapons.forEach((w: any) => {
            targetMk[`${w.name || w.名称}冷却`] = nowSec;
          });
        }
        // 恶毒(#恶毒=6)：防御方增益加"恶毒之刃" 15+技等（L2175-2177）
        if (atkSeq === 6) {
          const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
          if (!tBuffs.some((b: any) => b && (b.name || b.名称) === '恶毒之刃' && b.expireAt > nowSec + 15 + atkSkill)) {
            tBuffs.push({ name: '恶毒之刃', expireAt: nowSec + 15 + atkSkill });
          }
          target.buffs = JSON.stringify(tBuffs);
          resultLines.push('【恶毒之刃】');
        }
        // 伊芙利特(#伊芙利特=11) 好感≥80：防御方标记2加"燃烧" 15秒 强度10+技等/2（L2178-2182）
        if (atkSeq === 11 && atkAff >= 80) {
          targetMk['燃烧'] = nowSec; // 简化：冷却标记占位
          const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
          if (!tBuffs.some((b: any) => b && (b.name || b.名称) === '燃烧' && b.expireAt > nowSec + 15)) {
            tBuffs.push({ name: '燃烧', expireAt: nowSec + 15, strength: 10 + atkSkill / 2 });
          }
          target.buffs = JSON.stringify(tBuffs);
          resultLines.push('(燃烧)');
        }
        // 绝灭天使(#绝灭天使=3) 增益含"炮冠"：炮冠冷却30 + 取羽毛特效（L2184-2190，简化为置冷却标记+文本）
        if (atkSeq === 3) {
          const atkBuffs = this.safeParseJson<any[]>(player.buffs || (player as any).增益 || '[]', []);
          if (atkBuffs.some((b: any) => b && (b.name || b.名称) === '炮冠')) {
            playerMk['炮冠冷却'] = nowSec; // 30秒冷却（L2186 时间间隔要求 30）
            resultLines.push('【炮冠】');
          }
        }
        // 军姬(#军姬=16)：好感≥100 → 防御方加"影光"60秒；增益含"万象"且近战/拳头 → 转轮增益（L2192-2205）
        if (atkSeq === 16) {
          if (atkAff >= 100) {
            const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
            if (!tBuffs.some((b: any) => b && (b.name || b.名称) === '影光' && b.expireAt > nowSec + 60)) {
              tBuffs.push({ name: '影光', expireAt: nowSec + 60 });
            }
            target.buffs = JSON.stringify(tBuffs);
          }
          const atkBuffs2 = this.safeParseJson<any[]>(player.buffs || (player as any).增益 || '[]', []);
          if (atkBuffs2.some((b: any) => b && (b.name || b.名称) === '万象') &&
              (weapon.name === '拳头' || weapon.type === '近战武器')) {
            if (!targetMk['zllq'] || nowSec - (targetMk['zllq'] || 0) > 30) {
              targetMk['zllq'] = nowSec;
              const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
              if (!tBuffs.some((b: any) => b && (b.name || b.名称) === '转轮' && b.expireAt > nowSec + 30)) {
                tBuffs.push({ name: '转轮', expireAt: nowSec + 30, strength: (attackerBonus.物伤 || 0) / 10 });
              }
              target.buffs = JSON.stringify(tBuffs);
              resultLines.push(`【剑阵转轮】+${Math.round((attackerBonus.物伤 || 0) / 10)}`);
            }
          }
          // 军姬 标记"万象2"==1 → 伤害×(2+技等/100)（L2206-2209）
          if ((playerMk['万象2'] || 0) === 1) {
            playerMk['万象2'] = 0;
            forcedMult *= (2 + atkSkill / 100);
            resultLines.push('【万象2】');
          }
        }
        // 星尘(#星尘=14) 标记"dz"!=0 → 斗转星移 剩余电伤 += dz×(5+技等/10)（L2211-2218）
        if (atkSeq === 14) {
          const dz = playerMk['dz'] || 0;
          if (dz !== 0) {
            playerMk['dz'] = 0;
            const a2 = dz * (5 + atkSkill / 10);
            attackerBonus.电伤 = (attackerBonus.电伤 || 0) + a2;
            resultLines.push(`【斗转星移】+${Math.round(a2)}`);
          }
        }

        // ---- 防御方使魔专属（原版 L2224-2258） ----
        // 恶毒(#恶毒=6) 好感≥100 色欲2冷却30 → 伤害0（L2224-2231）
        if (defSeq === 6 && defAff >= 100) {
          if (!targetMk['色欲2'] || nowSec - (targetMk['色欲2'] || 0) > 30) {
            targetMk['色欲2'] = nowSec;
            forcedMult = 0;
            dmgImmune = true;
            resultLines.push('【色欲】');
          }
        }
        // 龙姬(#龙姬=12)：防御方增益加"怒吼"（L2233-2234）
        if (defSeq === 12) {
          const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
          if (!tBuffs.some((b: any) => b && (b.name || b.名称) === '怒吼')) {
            tBuffs.push({ name: '怒吼', expireAt: nowSec + 30 });
          }
          target.buffs = JSON.stringify(tBuffs);
        }
        // 长萌(#长萌=2) 好感≥40 → 防御方增益加"长萌承受"（L2235-2238）
        if (defSeq === 2 && defAff >= 40) {
          const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
          if (!tBuffs.some((b: any) => b && (b.name || b.名称) === '长萌承受' && b.expireAt > nowSec + 30)) {
            tBuffs.push({ name: '长萌承受', expireAt: nowSec + 30 });
          }
          target.buffs = JSON.stringify(tBuffs);
        }
        // saber(#saber=19) 好感≥40 增益含"ex" → 伤害0（L2240-2246）
        if (defSeq === 19 && defAff >= 40) {
          const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
          if (tBuffs.some((b: any) => b && (b.name || b.名称) === 'ex')) {
            forcedMult = 0;
            dmgImmune = true;
            resultLines.push('【ex】');
          }
        }
        // 四糸乃(#四糸乃=15) 好感≥80 冰凯冷却20 → 加"bk1"；增益含"bk1" → 伤害0（L2248-2258）
        if (defSeq === 15) {
          if (defAff >= 80 && (!targetMk['冰凯'] || nowSec - (targetMk['冰凯'] || 0) > 20)) {
            targetMk['冰凯'] = nowSec;
            const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
            if (!tBuffs.some((b: any) => b && (b.name || b.名称) === 'bk1')) {
              tBuffs.push({ name: 'bk1', expireAt: nowSec + 20 });
            }
            target.buffs = JSON.stringify(tBuffs);
          }
          const tBuffs2 = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
          if (tBuffs2.some((b: any) => b && (b.name || b.名称) === 'bk1')) {
            forcedMult = 0;
            dmgImmune = true;
            resultLines.push('【冰凯】');
          }
        }

        // ---- 吸血姬(活力=-15) 命中附加[猩红] 10秒（原版 L2439-2445） ----
        if (atkVit === -15) {
          if (!playerMk['xhcd'] || nowSec - (playerMk['xhcd'] || 0) > 180) {
            playerMk['xhcd'] = nowSec;
            const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
            if (!tBuffs.some((b: any) => b && (b.name || b.名称) === '猩红' && b.expireAt > nowSec + 10)) {
              tBuffs.push({ name: '猩红', expireAt: nowSec + 10 });
            }
            target.buffs = JSON.stringify(tBuffs);
            // 记录猩红添加者：原版 置成就熟练度("x红x"+QQ, 防御方.标记, #吸血姬猩红)
            targetMk[`x红x${player.qqNumber ?? player.userId ?? ''}`] = 15.312381;
            resultLines.push('【猩红】');
          }
        }

        // ---- 战斗女仆(#战斗女仆=8) 守护/超频（原版 L2471-2497 / L2521-2531） ----
        if (atkSeq === 8) {
          // 攻击方守护1 → 进守护2、守护1-1（L2471-2481，回合消耗，本框架简化为文本）
          const atkBuffs = this.safeParseJson<any[]>(player.buffs || (player as any).增益 || '[]', []);
          if (atkBuffs.some((b: any) => b && (b.name || b.名称) === '守护1')) {
            resultLines.push('【守护】');
          }
          // 好感≥60：与防御方交换武器冷却，并 战斗中增加攻击 5+技等/2（L2482-2497）
          if (atkAff >= 60) {
            for (const w of defWeapons) {
              const wkey = `${w.name || w.名称}冷却`;
              if (!targetMk[wkey]) {
                if (!playerMk['超频'] || nowSec - (playerMk['超频'] || 0) > 30) {
                  playerMk['超频'] = nowSec;
                  const a2 = targetMk[wkey] || 0;
                  targetMk[wkey] = a2; // 交换（简化：防御方武器进入冷却）
                  playerMk[`${weapon.name}冷却`] = (playerMk[`${weapon.name}冷却`] || 0) - a2;
                  // 原版“战斗中增加攻击(攻击方, 5+技能等级/2)”会把固定攻击同时
                  // 转换为四属性伤害；不能只重复当前电伤，否则其它三系不会获得增量。
                  this.addCombatAttack(attackerBonus, 5 + atkSkill / 2);
                  resultLines.push('【超频】');
                }
                break;
              }
            }
          }
        }
        // 防御方战斗女仆 守护1 → 伤害0（L2521-2531）
        if (defSeq === 8) {
          const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
          if (tBuffs.some((b: any) => b && (b.name || b.名称) === '守护1')) {
            forcedMult = 0;
            dmgImmune = true;
            resultLines.push('【守护】');
          }
        }

        // ---- 防御方套装/标记免疫（原版 L2533-2586） ----
        // 绝灭天使(#绝灭天使=3) 增益含"光盾" → 伤害0（L2533-2538）
        if (defSeq === 3) {
          const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
          if (tBuffs.some((b: any) => b && (b.name || b.名称) === '光盾')) {
            forcedMult = 0;
            dmgImmune = true;
            resultLines.push('【光盾】');
          }
        }
        // 军姬(#军姬=16) 好感≥40 jz冷却60 → 加"剑阵"12秒；好感≥80 回满血（L2540-2558）
        if (defSeq === 16 && defAff >= 40) {
          if (!targetMk['jz'] || nowSec - (targetMk['jz'] || 0) > 60) {
            targetMk['jz'] = nowSec;
            const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
            if (!tBuffs.some((b: any) => b && (b.name || b.名称) === '剑阵' && b.expireAt > nowSec + 12)) {
              tBuffs.push({ name: '剑阵', expireAt: nowSec + 12 });
            }
            target.buffs = JSON.stringify(tBuffs);
            if (defAff >= 80) {
              // 恢复 生命上限 生命（原版 当前生命 += 属性.生命 封顶）
              const maxHp = target.maxHp || target.hp || 0;
              target.hp = Math.min(maxHp, (target.hp || 0) + maxHp);
              resultLines.push(`【剑阵】恢复${maxHp}生命`);
            }
          }
        }
        // 军姬2(#军姬2=24) 好感≥20 标记jj2hg1>0 → 伤害0+招架（L2570-2578）
        if (defSeq === 24 && defAff >= 20) {
          if ((targetMk['jj2hg1'] || 0) > 0) {
            targetMk['jj2hg1'] = (targetMk['jj2hg1'] || 0) - 1;
            forcedMult = 0;
            dmgImmune = true;
            resultLines.push('【招架】');
          }
        }
        // 防御方增益含"剑阵" → 伤害0（L2583-2586）
        {
          const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
          if (tBuffs.some((b: any) => b && (b.name || b.名称) === '剑阵')) {
            forcedMult = 0;
            dmgImmune = true;
            resultLines.push('【剑阵】');
          }
        }

        // ========== 格挡系统（原版 造成伤害 L2512-2688 几率判断(格挡) 子系统） ==========
        // 先累计 格挡 值（来自防御方使魔/装备/增益/标记），再 几率判断(格挡) 概率触发；
        // 触发后 暴击倍率(=本框架 finalDamage 倍率) 乘 0.25 或随机比例，圆盾则三池回满+免疫。
        const defEquip2 = (target as any).equipment as any[];
        const defSets2 = this.safeParseJson<any>(target.sets || '{}', {});
        const defSakuraHits = defSets2['小樱命中次数'] ?? defSets2.sakuraHits ?? 0;
        const defSleepLv = defSets2['陪睡'] ?? defSets2.sleepover ?? 0;
        let blockVal = 0;
        // 花园猫(specialSeq=1) 标记"猫猫闪避">0 → 格挡=100 + 技能冷却-60 + 幻时增益（L2512-2519）
        if (defSeq === 1) {
          if ((targetMk['猫猫闪避'] || 0) > 0) {
            blockVal = 100;
            targetMk['猫猫闪避'] = 0;
            const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
            if (!tBuffs.some((b: any) => b && (b.name || b.名称) === '幻时')) {
              tBuffs.push({ name: '幻时', expireAt: nowSec + 30 });
            }
            target.buffs = JSON.stringify(tBuffs);
            targetMk[`${(target.type || (target as any).类型 || '')}技能冷却`] = nowSec;
            resultLines.push('【幻时】');
          }
        }
        // 阿尔缇娜(specialSeq=7) 好感≥40 → 格挡 += 15+技等/2；增益"a技能2" → 再+15+技等/2（L2560-2568）
        if (defSeq === 7) {
          if (defAff >= 40) blockVal += 15 + defSkill / 2;
          const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
          if (tBuffs.some((b: any) => b && (b.name || b.名称) === 'a技能2')) blockVal += 15 + defSkill / 2;
        }
        // 防爆盾装备 → 格挡+10（L2587-2589）
        if (defEquip2?.some((e: any) => e.specialSeq === 9 || (e.name || '').includes('防爆盾'))) blockVal += 10;
        // 神兽之力金刚不坏装备 → 格挡+10（L2590-2592）
        if (defEquip2?.some((e: any) => e.specialSeq === 102 || (e.name || '').includes('神兽之力金刚不坏'))) blockVal += 10;
        // 圆盾装备 → 格挡+5（L2593-2595）
        if (defEquip2?.some((e: any) => e.specialSeq === 51 || (e.name || '').includes('圆盾'))) blockVal += 5;
        // 烟雾弹增益 → 格挡+20（L2596-2599）
        {
          const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
          if (tBuffs.some((b: any) => b && (b.name || b.名称) === '烟雾弹')) blockVal += 20;
        }
        // 裸体围裙装备 → 易伤+5 + 格挡修正（L2600-2610）
        if (defEquip2?.some((e: any) => e.specialSeq === 65 || (e.name || '').includes('裸体围裙'))) {
          defenderBonus.减益 = (defenderBonus.减益 || 0) + 5;
          if (weapon.type !== '近战武器') blockVal -= 10;
          if (weapon.type !== '生体武器') blockVal -= 10;
        }
        // 透明围裙标记 → 格挡 += a2*5+5（L2612-2617）
        {
          const a2 = targetMk['透明围裙'] || 0;
          if (a2 > 0) {
            blockVal += a2 * 5 + 5;
            defenderBonus.减益 = (defenderBonus.减益 || 0) + 5;
            resultLines.push(`【格挡+】${a2 * 5 + 5}%`);
          }
        }
        // 含光(sakuraHits=5) 陪睡>6 → 格挡+50（L2619-2621）
        if (defSakuraHits === 5 && defSleepLv > 6) blockVal += 50;

        // 触发格挡：原版 几率判断(格挡) = 随机0~100 < 格挡 则触发（L2622）
        if (blockVal > 0 && Math.random() * 100 < blockVal) {
          let blockMult = 0.25; // 默认格挡：暴击倍率×0.25（L2671）
          resultLines.push('【格挡】');
          // 含光(sakuraHits=5) 陪睡>7 → 随机比例削弱（L2656-2659）
          if (defSakuraHits === 5 && defSleepLv > 7) {
            const a2 = (Math.floor(Math.random() * 1401) + 100) / 10000;
            blockMult = a2;
            resultLines.push(`【格挡】${Math.round((1 - a2) * 100)}%`);
          }
          // 铃铛装备：冷却15秒→0.25，否则随机比例（L2660-2668）
          if (defEquip2?.some((e: any) => e.specialSeq === 64 || (e.name || '').includes('铃铛'))) {
            if (!targetMk['铃铛冷却'] || nowSec - (targetMk['铃铛冷却'] || 0) > 15) {
              targetMk['铃铛冷却'] = nowSec;
              blockMult = 0.25;
            } else {
              const a2 = (Math.floor(Math.random() * 1401) + 100) / 10000;
              blockMult = a2;
              resultLines.push(`【格挡】${Math.round((1 - a2) * 100)}%`);
            }
          }
          // 圆盾装备 冷却120 → 三池回满 + 伤害0（L2677-2685）
          if (defEquip2?.some((e: any) => e.specialSeq === 51 || (e.name || '').includes('圆盾'))) {
            if (!targetMk['圆盾冷却'] || nowSec - (targetMk['圆盾冷却'] || 0) > 120) {
              targetMk['圆盾冷却'] = nowSec;
              const maxHp = target.maxHp || target.hp || 0;
              const maxSh = target.maxShield || target.shield || 0;
              const maxAr = target.maxArmor || target.armor || 0;
              target.hp = maxHp; target.shield = maxSh; target.armor = maxAr;
              blockMult = 0;
              resultLines.push('【圆盾】');
            }
          }
          if ((player.specialSeq ?? 0) > 0) {
            playerMk['防御熟练度'] = (playerMk['防御熟练度'] || 0) + 3;
          }
          forcedMult *= blockMult;
          if (blockMult === 0) dmgImmune = true; // 圆盾/免疫场景跳过保底1
        }

        // ========== 套装类型减伤（原版 L2689-2723） ==========
        const suitVal = (k: string) => defSets2[k] ?? 0;
        if (suitVal('防爆') > 0 && weapon.type === '近战武器') {
          forcedMult *= (1 - suitVal('防爆') / 10);
          resultLines.push(`【防爆】${suitVal('防爆') * 10}%`);
        }
        if (suitVal('游骑兵') > 0 && weapon.type === '射弹武器') {
          forcedMult *= (1 - suitVal('游骑兵') / 10);
          resultLines.push(`【游骑兵】${suitVal('游骑兵') * 10}%`);
        }
        if (suitVal('游侠') > 0 && weapon.type === '生体武器') {
          forcedMult *= (1 - suitVal('游侠') / 10);
          resultLines.push(`【游侠】${suitVal('游侠') * 10}%`);
        }
        if (suitVal('动力') > 0 && weapon.type === '能量武器') {
          forcedMult *= (1 - suitVal('动力') / 10);
          resultLines.push(`【动力】${suitVal('动力') * 10}%`);
        }
        if (suitVal('无畏') > 0 && weapon.type === '制导武器') {
          forcedMult *= (1 - suitVal('无畏') / 10);
          resultLines.push(`【无畏】${suitVal('无畏') * 10}%`);
        }
        // 激变星增益 → 伤害0（L2724-2727）
        {
          const tBuffs = this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []);
          const jbx = tBuffs.find((b: any) => b && (b.name || b.名称) === '激变星');
          if (jbx) {
            forcedMult = 0;
            dmgImmune = true;
            resultLines.push(`【激变星】${Math.round(jbx.strength || 0)}秒`);
          }
        }

        // 写回攻击方/防御方标记变更
        player.markers = JSON.stringify(playerMk);
        // targetMk 不只承载无双计数，也承载负面效果累计、冷却和装备特效状态。
        // 原先只在无双触发时写回，会丢失割裂/灼烧/深寒/感电的未满4层计数。
        if (target.userId) target.markers = JSON.stringify(targetMk);
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
      // 侵彻参数：增幅器5 需在 L959 块外重新读取玩家套装数据（原版 攻击方.套装.增幅器==5）
      const amplifierSets = this.safeParseJson<any>(player.sets, {});
      const amplifier5Flag = (amplifierSets['增幅器'] ?? amplifierSets.amplifier ?? 0) === 5;
      const weaponAnesthesiaVal = (weapon.self as any)?.anesthesia ?? weapon.anesthesia ?? 0;
      // 吸血姬猩红真伤：传入防御方标记/增益（原版 L4093-4110）
      const vtdDefMarkers = this.playerService.safeJsonParse<Record<string, any>>(target.markers || '{}', {});
      const vtdProfBefore = Number(vtdDefMarkers['猩红'] ?? 0);
      const damageResult = this.calcDamage(
        attackerBonus,
        defenderBonus,
        weapon,
        weapon.damageType || CombatSystemService.DMG_PHYS,
        isCrit,
        {
          dmgLower,
          dmgUpper,
          sniperComputer: hasSniper,
          amplifier3: (attackerBonus as any).amplifier3 === 3,
          amplifier5: amplifier5Flag,
          weaponAnesthesia: weaponAnesthesiaVal,
          mastery,
          defenderEquipment: playerData.equipment,
          defenderMarkers: vtdDefMarkers,
          defenderBuffs: this.safeParseJson<any[]>(target.buffs || (target as any).增益 || '[]', []),
        },
      );
      // 真伤释放后熟练度被清零 → 写回防御方标记
      if (vtdProfBefore > 0 && Number(vtdDefMarkers['猩红'] ?? 0) === 0) {
        target.markers = JSON.stringify(vtdDefMarkers);
      }
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
        atkStats.nullDmg++; // 命中零伤（对应原版 电伤2 命中没造成伤害）
        resultLines.push(`${target.name} 的防御抵消了本次伤害！`);
        continue;
      }

      // 套装免疫（增幅器2敏锐 s敏锐>=5 → 伤害倍率=0）：跳过保底1点伤害，计为命中零伤
      if (dmgImmune) {
        atkStats.nullDmg++;
        continue;
      }

      // 应用伤害倍率（含使魔特效 + 特殊武器特效修改后的倍率，再加特殊特效的额外伤害）
      // forcedMult：套装/装备强制倍率修正（敏锐免疫/蓄力×1.5/速射×0.9/超压×1.25 等）
      let finalDamage = Math.floor(damageResult.damage * effectiveDmgMult * forcedMult / 100) + (specialEffect.bonusDmg || 0);
      // 格挡/套装倍率(forcedMult≠1)会改变最终总伤害，但 calcDamage 内部的三池分配 poolDamage
      // 是基于未乘倍率的 damageResult.damage 算出的。需按比例同步缩放 poolDamage，
      // 否则实际扣血/展示文本仍按原 damage 的三池数值（如格挡后仍扣满 100 导致误杀）。
      let scaledPool = damageResult.poolDamage;
      if (damageResult.damage > 0 && finalDamage !== damageResult.damage) {
        const ratio = finalDamage / damageResult.damage;
        scaledPool = {
          shield: Math.round((damageResult.poolDamage.shield || 0) * ratio),
          armor: Math.round((damageResult.poolDamage.armor || 0) * ratio),
          hp: Math.round((damageResult.poolDamage.hp || 0) * ratio),
        };
      }
      if (finalDamage < 1 && isHit) finalDamage = 1; // 保底1点伤害（免疫场景已在上方 continue 跳过）

      // 原版 战斗相关.ecode L4419-L4424：捕捉模式只免疫生命层，护盾/装甲仍可损失。
      // 总伤害仍按完整伤害累计，供原版麻醉公式使用。
      const captureMode = (target.specialSeq ?? -1) === -1
        && this.hasActiveMonsterEntry(target.buffs, '捕捉模式');
      const appliedPool: PoolDamage = captureMode
        ? { ...scaledPool, hp: 0 }
        : { ...scaledPool };

      const defenderSets = this.safeParseJson<any>(target.sets || (target as any).套装 || '{}', {});
      // 原版“强袭”四件套在三层扣血前限制单池伤害：当前池≥70%且本次伤害超过70%
      // 上限时，该层只受70%上限伤害；30秒冷却按防御方标记2记录。
      const assaultMarkers = this.safeParseJson<any[]>(target.markers2, []);
      const assaultCap = (currentPool: number, maxPool: number): number => {
        if ((defenderSets?.强袭 ?? 0) !== 4 || maxPool <= 0) return currentPool;
        if (currentPool / maxPool < 0.7 || currentPool <= maxPool * 0.7) return currentPool;
        if (this.combatState.timeIntervalRequire('强袭冷却', 30, assaultMarkers, Date.now(), { value: '' }, Date.now())) {
          return maxPool * 0.7;
        }
        return currentPool;
      };
      appliedPool.shield = Math.min(appliedPool.shield, assaultCap(target.shield || 0, defenderBonus.护盾 || 0));
      appliedPool.armor = Math.min(appliedPool.armor, assaultCap(target.armor || 0, defenderBonus.装甲 || 0));
      appliedPool.hp = Math.min(appliedPool.hp, assaultCap(target.hp || 0, defenderBonus.生命 || 0));

      // 原版 L4260-4271：坚韧护盾在护盾被打穿后终止本次后续特效，先阻止生命池继续扣减。
      // 原版 战斗相关.ecode L4444-L4448：带麻醉的非生体武器不能直接击杀目标。
      if (!captureMode && anesthesiaEffect > 0 && (weapon.type || '') !== '生体武器'
        && target.hp > 0 && appliedPool.hp >= target.hp) {
        const allowedHpDamage = Math.max(0, target.hp - 1);
        const preventedHpDamage = appliedPool.hp - allowedHpDamage;
        appliedPool.hp = allowedHpDamage;
        finalDamage = Math.max(0, finalDamage - preventedHpDamage);
      }

      atkStats.effective++; // 有效伤（对应原版 物伤2 实际造成伤害次数）
      totalDamage += finalDamage;

      // 扣除怪物血量（三池分伤）
      const shieldBeforeDamage = target.shield === undefined ? 0 : Number(target.shield || 0);
      const armorBeforeDamage = target.armor === undefined ? 0 : Number(target.armor || 0);
      const defenderEquipment = ((target as any).equipment || []) as any[];
      const hasTenaciousShield = defenderEquipment.some((item: any) =>
        item && (item.specialSeq === 131 || (item.name || item.名称) === '坚韧护盾'));
      const tenaciousShieldMarkers = this.safeParseJson<any[]>(target.markers2, []);
      let tenaciousShieldTriggered = false;
      const tenaciousShieldMax = (target as any).maxShield ?? defenderBonus.护盾 ?? 0;
      const tenaciousShieldWillBreak = appliedPool.shield >= shieldBeforeDamage && shieldBeforeDamage > 0;
      if (hasTenaciousShield && tenaciousShieldWillBreak) appliedPool.hp = 0;
      const tenaciousShieldActive = hasTenaciousShield
        && shieldBeforeDamage > 0
        && tenaciousShieldMax > 0
        && shieldBeforeDamage / tenaciousShieldMax >= 0.15;
      const appliedDamage = this.applyDamageToMonster(target, finalDamage, appliedPool);
      if ((defenderSets?.强袭 ?? 0) === 4) target.markers2 = JSON.stringify(assaultMarkers);

      // 原版 L4260-4271：坚韧护盾在护盾被打穿后触发；15秒冷却未过则本次后续特效终止。
      const tenaciousShieldBreak = appliedDamage.shield > 0 && Number(target.shield || 0) <= 0;
      if (tenaciousShieldActive && tenaciousShieldBreak) {
        if (!this.combatState.timeIntervalRequire(
          '坚韧hd',
          15,
          tenaciousShieldMarkers,
          Date.now(),
          { value: '' },
          Date.now(),
        )) {
          target.markers2 = JSON.stringify(tenaciousShieldMarkers);
          tenaciousShieldTriggered = true;
          resultLines.push(`【坚韧护盾】`);
        }
        target.markers2 = JSON.stringify(tenaciousShieldMarkers);
      }

      // 原版破盾/破甲分支：木天蓼(-26)或好感≥40绝灭天使的“日轮a”命中后，
      // 将对应回复逆转增益写入防御方，持续 10×(1-韧性/100) 秒。
      const reversePool = (poolBefore: number, maxPool: number, poolName: '盾逆' | '甲逆') => {
        if (poolBefore <= 0 || maxPool <= 0 || poolBefore / maxPool < 0.15) return;
        const isWoodCat = weapon.specialSeq === -26 || (weapon.name || (weapon as any).名称) === '木天蓼';
        const isSolar = attackText === '日轮a' && (player.affinity || 0) >= 40;
        if (!isWoodCat && !isSolar) return;
        const reverseSeconds = 10 * (1 - (defenderBonus.韧性 || 0) / 100);
        const buffs = this.safeParseJson<any[]>(target.buffs, []);
        this.combatState.gainBuff(buffs, poolName, reverseSeconds, false, Date.now() / 1000);
        target.buffs = JSON.stringify(buffs);
        resultLines.push(`【${poolName === '盾逆' ? '盾回逆转' : '甲回逆转'}${Math.round(reverseSeconds)}秒】`);
      };
      reversePool(shieldBeforeDamage, defenderBonus.护盾 || 0, '盾逆');
      reversePool(armorBeforeDamage, defenderBonus.装甲 || 0, '甲逆');

      // 战斗事件任务在实际扣池后记录，避免把计算阶段的池分配误当成成功事件。
      if (damageResult.penetrated && finalDamage > 0) {
        taskProgress.push({ actionName: '贯穿', count: 1 });
      }
      if (shieldBeforeDamage > 0 && Number(target.shield || 0) <= 0) {
        taskProgress.push({ actionName: '破盾', count: 1 });
      }
      if (armorBeforeDamage > 0 && Number(target.armor || 0) <= 0) {
        taskProgress.push({ actionName: '破甲', count: 1 });
      }


      // 原版 战斗相关.ecode L3822-L3838：命中后累加当前麻醉并记录麻醉者。
      const anesthesiaText = this.applyWeaponAnesthesia(
        target,
        player,
        weapon,
        finalDamage,
        anesthesiaEffect,
      );
      if (anesthesiaText) resultLines.push(anesthesiaText);

      // ========== 溅射伤害（对应原版 造成伤害 L624-705 溅射循环） ==========
      // 战斗女仆RPG!/恶毒好感等设置 splashCount：对主目标外额外 splashCount 个存活目标，
      // 造成分摊伤害（溅射倍率），溅射必中（splashMustHit）。原版溅射伤害按各自目标抗性结算。
      if (splashCount > 0 && !effectiveAllAttack) {
        const splashTargets = targets
          .filter((t: any) => t !== target && (t.hp || 0) > 0);
        // 随机取 splashCount 个（不足则全取）
        for (let s = 0; s < splashCount && s < splashTargets.length; s++) {
          const st = splashTargets[s];
          const splashDef = this.buildMonsterBonus(st);
          const splashHit = splashMustHit ? true : this.checkHit(this.calcHitRate(attackerBonus, splashDef));
          if (!splashHit) {
            resultLines.push(`${st.name} 闪避了溅射伤害`);
            continue;
          }
          const stMarkersVtd = this.playerService.safeJsonParse<Record<string, any>>(st.markers || '{}', {});
          const stProfBefore = Number(stMarkersVtd['猩红'] ?? 0);
          const splashDmg = this.calcDamage(
            attackerBonus,
            splashDef,
            weapon,
            weapon.damageType || CombatSystemService.DMG_PHYS,
            isCrit,
            {
              amplifier5: amplifier5Flag,
              weaponAnesthesia: weaponAnesthesiaVal,
              defenderMarkers: stMarkersVtd,
              defenderBuffs: this.safeParseJson<any[]>(st.buffs || '[]', []),
            },
          );
          if (stProfBefore > 0 && Number(stMarkersVtd['猩红'] ?? 0) === 0) {
            st.markers = JSON.stringify(stMarkersVtd);
          }
          const splashFinal = Math.max(1, Math.floor(splashDmg.damage * splashDamageMultiplier));
          const splashShieldBefore = Number(st.shield || 0);
          const splashArmorBefore = Number(st.armor || 0);
          const splashApplied = this.applyDamageToMonster(st, splashFinal, splashDmg.poolDamage);
          if (splashDmg.penetrated && splashFinal > 0) {
            taskProgress.push({ actionName: '贯穿', count: 1 });
          }
          if (splashShieldBefore > 0 && splashApplied.shield > 0 && Number(st.shield || 0) <= 0) {
            taskProgress.push({ actionName: '破盾', count: 1 });
          }
          if (splashArmorBefore > 0 && splashApplied.armor > 0 && Number(st.armor || 0) <= 0) {
            taskProgress.push({ actionName: '破甲', count: 1 });
          }
          resultLines.push(`${st.name} 受到溅射伤害 ${splashFinal}`);
          if (st.hp <= 0) {
            const sd = await this.handleMonsterDeath(
              st,
              userId,
              map.id,
              playerData,
              context.vitalityMode || 'normal',
            );
            if (sd.expGain > 0) {
              totalExp += sd.expGain;
              resultLines.push(`${st.name} 被溅射击杀，获得 ${sd.expGain} 点经验`);
            }
            if (sd.dropText) resultLines.push(`掉落：${sd.dropText}`);
            taskProgress.push(...(sd.taskProgress || []));
            await this.updateMonsterHpInMap(map.id, st);
          } else {
            await this.updateMonsterHpInMap(map.id, st);
          }
        }
      }

      // ========== 反伤（对应原版 计算反伤 子程序 L4791-4873，已抽为独立方法 calcReflectDamage） ==========
      // 防御方（目标）携带反伤来源时，按比例把伤害反弹给攻击方：
      //   恶毒好感≥100(色欲30s)：反伤100%；军姬好感≥40(剑阵)：反伤100%
      //   荆棘之翼：+15%；小鱼发饰(60s冷却)：+200%；军姬2好感≥40：+100%+(2+技能等级×0.05)%
      // 反伤绝对值 = 计算反伤() 返回的百分比如实折算（防御方理论伤害 × 百分比/100）
      {
        // 构造防御方当前武器 z2 的属性系数（原版 L4845：当前武器==0 则用拳头 物=100）
        const defWeapons: any[] = this.safeParseJson(target.weapons, []);
        const defCurW = target.currentWeapon ? (defWeapons[target.currentWeapon - 1] || defWeapons[target.currentWeapon]) : null;
        const z2Props = defCurW
          ? {
              phys: defCurW.properties?.phys ?? defCurW.属性?.物 ?? 100,
              fire: defCurW.properties?.fire ?? defCurW.属性?.火 ?? 0,
              ice: defCurW.properties?.ice ?? defCurW.属性?.冰 ?? 0,
              elec: defCurW.properties?.elec ?? defCurW.属性?.电 ?? 0,
            }
          : { phys: 100, fire: 0, ice: 0, elec: 0 };
        const nowSec = Math.floor(Date.now() / 1000);
        const origTs = Date.now();
        // 原版 伤害倍率 参数 = 本次造成伤害的总倍率（攻击命中/防御闪避），对应本框架 dmgMult
        const reflectDmg = this.calcReflectDamage(
          target,
          defenderBonus,
          attackerBonus,
          {
            phys: weapon.properties?.phys ?? 100,
            fire: weapon.properties?.fire ?? 0,
            ice: weapon.properties?.ice ?? 0,
            elec: weapon.properties?.elec ?? 0,
          },
          z2Props,
          effectiveDmgMult, // 原版 伤害倍率（本次造成伤害的总倍率，含特效修正）
          nowSec,
          origTs,
        );
        if (reflectDmg > 0) {
          player.hp = Math.max(0, (player.hp || 0) - Math.floor(reflectDmg));
          resultLines.push(`【反伤】${target.name} 反弹了 ${Math.floor(reflectDmg)} 点伤害给你！`);
        }
      }

      // 反转童话（战斗相关.ecode L378-440）：兰音蓄势后，无论是否命中按 几率判断(50+技等/2) 触发；
      // 随机 a=1..10 → 目标已有 fzth<a> 增益则移除，否则获得 600*库洛牌(1.25) 秒 fzth 增益，
      // a==5/6 时立即反转目标属性装甲/护盾并把当前值同步翻负（计入"攻击者"+QQ 成就）。
      if (nextAttack.reverseResist) {
        const fairytaleText = this.applyReverseFairytale(player, target, nextAttack.reverseChance ?? 50);
        if (fairytaleText) resultLines.push(fairytaleText);
      }

      // 原版 L4260-4271：坚韧护盾在护盾被打穿后终止本次后续文本/反伤等处理。
      if (tenaciousShieldActive && tenaciousShieldBreak && tenaciousShieldTriggered) {
        await this.updateMonsterHpInMap(map.id, target);
        continue;
      }

      // 构建攻击文本（含三段评级显示）
      // 对应原版 战斗相关.ecode L3881 + L4064/4215/4346/4486：显示类型按伤害落点决定——
      // 击杀(4) > 护盾被打穿且剩余>10%(2) > 装甲被打穿且剩余>10%(3) > 普通命中(1)，
      // 再从武器攻击文本对应分类抽取模板并展开【名称】【载具】【目标】【武器】占位符。
      const attackerVehicleName = this.getAttackerVehicleName(player, map);
      const weaponDisplayName = String(weapon.name || '拳头');
      const displayType = target.hp <= 0
        ? 4
        : (shieldBeforeDamage > 0 && Number(target.shield || 0) <= 0 && shieldBeforeDamage / (defenderBonus.护盾 || shieldBeforeDamage || 1) > 0.1)
          ? 2
          : (armorBeforeDamage > 0 && Number(target.armor || 0) <= 0 && armorBeforeDamage / (defenderBonus.装甲 || armorBeforeDamage || 1) > 0.1)
            ? 3
            : 1;
      let atkText = '';
      // 对应原版 显示攻击文本()：优先按第3参 攻击文本 名称查文本列表，未传则用武器自带 z1.攻击文本；
      // 命中后按显示类型从对应分类随机抽取模板。查无条目时回落：显式传入保留原文，否则走旧兜底。
      const atkName = (attackText ?? '').trim() || this.resolveAttackTextName(weapon);
      const hitTemplates = this.getAttackTextTemplates(atkName, displayType);
      if (hitTemplates.length > 0) {
        atkText = hitTemplates[Math.floor(Math.random() * hitTemplates.length)];
      } else if ((attackText ?? '').trim()) {
        atkText = (attackText ?? '').trim();
      } else {
        atkText = this.getAttackText(weapon, weapon.damageType);
      }
      atkText = this.expandAttackPlaceholders(atkText, player.name || '', target.name, weaponDisplayName, attackerVehicleName);

      // 原版 战斗相关.ecode L1930：攻击文本=="誓约胜利之剑a" 命中后，
      // 给防御方获得增益("sa", 30秒)——灼烧标记，由地图战斗节拍按 物攻/10×经过秒数 结算。
      if ((attackText ?? '') === '誓约胜利之剑a' && context.burnSeconds && context.burnSeconds > 0) {
        const tBuffsSa = this.safeParseJson<any[]>(target.buffs, []);
        this.combatState.gainBuff(tBuffsSa, 'sa', context.burnSeconds, false, Date.now());
        target.buffs = JSON.stringify(tBuffsSa);
        resultLines.push(`${target.name} 被圣剑之光灼烧（每秒造成物攻10%伤害）`);
      }

      const critText = isCrit ? '【暴击】' : '';
      const ratingText = damageResult.rating || '';
      const dmgText = captureMode
        ? this.formatCaptureDamageText(finalDamage, appliedDamage, target, scaledPool.hp > 0)
        : this.formatDamageText(finalDamage, appliedDamage);
      const enhancerText = damageResult.effectText || '';
      resultLines.push(`${atkText} ${target.name}，造成 ${dmgText}${critText}${ratingText ? ` ${ratingText}` : ''}${enhancerText ? ` ${enhancerText}` : ''}`);

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
        const deathResult = await this.handleMonsterDeath(
        target,
        userId,
        map.id,
        playerData,
        context.vitalityMode || 'normal',
      );
        totalExp += deathResult.expGain;
        allDrops.push(...deathResult.drops);
        taskProgress.push(...(deathResult.taskProgress || []));

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
      if (attackerBonus.吸生命 && finalDamage > 0) {
        const leechAmount = this.calcLeech(finalDamage, attackerBonus.吸生命);
        if (leechAmount > 0) {
          player.hp = Math.min(
            (player.hp || 0) + leechAmount,
            player.maxHp || 100,
          );
          resultLines.push(`生命偷取 ${leechAmount} 点`);
        }
      }
    }

    // 原版击杀结算：处于“卷土重来”状态的攻击方成功击杀目标后，
    // 回满三层状态并推进一次对应任务。任务推进延后到本方法保存玩家后，
    // 避免 TaskService 的读改写被本次战斗的旧玩家快照覆盖。
    if (hadComebackState && killed.length > 0) {
      player.hp = Number(player.maxHp || attackerBonus.生命 || player.hp || 0);
      player.shield = Number(player.maxShield || attackerBonus.护盾 || player.shield || 0);
      player.armor = Number(player.maxArmor || attackerBonus.装甲 || player.armor || 0);
      comebackKill = true;
      resultLines.push(`${player.name || '你'}卷土重来！`);
    }

    // 8. 召唤物协同攻击（对齐原版 覅攻击pd L320-499：玩家攻击后，归属玩家的召唤物也出手）
    //    当前地图上归属该玩家的召唤物，若存活则用拳头攻击一次怪物。
    //    召唤物击杀的掉落已合并进 player 背包；经验通过 out 累计到 totalExp 统一发放。
    if (!context.skipBattleDriver && !isRuntimeActor) {
      const summonOut = { totalExp: 0, taskProgress: [] as Array<{ actionName: string; count: number }> };
      const summonLines = await this.summonCoAttack(player, playerData, map, summonOut);
      if (summonLines.length > 0) {
        resultLines.push(`━━━ 召唤物攻击 ━━━`);
        resultLines.push(...summonLines);
      }
      totalExp += summonOut.totalExp;
      taskProgress.push(...summonOut.taskProgress);
    }

    // 9. 怪物反击（对应原版 覅攻击pd L290-319：怪物攻击地图上的玩家）
    //    玩家攻击/召唤物攻击后，地图上仍存活的怪物随机一只发起反击，
    //    形成"你来我往"的完整战斗闭环。玩家被打死时进入死亡状态。
    if (!context.skipBattleDriver && !isRuntimeActor) {
      try {
        const counterLines = await this.monsterCounterAttack(player, playerData, map, taskProgress);
        if (counterLines.length > 0) {
          resultLines.push(`━━━ 怪物反击 ━━━`);
          resultLines.push(...counterLines);
        }
      } catch (e: any) {
        this.logger.warn(`怪物反击失败: ${e.message}`);
      }
    }

    // 10. 保存玩家状态（血量变化 + 掉落合并后的背包）
    if (isRuntimeActor) {
      await this.persistRuntimeActor(runtimeActor, map);
    } else {
      await this.playerService.savePlayer(player);
    }
    if (!isRuntimeActor && this.taskService && taskProgress.length > 0) {
      for (const progress of taskProgress) {
        await this.taskService.advance(progress.userId ?? userId, progress.actionName, progress.count);
      }
    }
    if (comebackKill) {
      if (this.taskService) {
        await this.taskService.advance(userId, '卷土重来');
      }
    }

    // 11. 添加经验到玩家（升级文本由指令引擎收尾统一排水追加，此处不重复取）
    if (totalExp > 0) {
      await this.playerService.addExp(userId, totalExp);
    }

    // 11.1 UI 同步说明：上方 savePlayer/addExp 落库后由 PrismaService 写拦截器
    //     自动发射 player 变更事件 → SyncProjector 防抖推送玩家面板；
    //     怪物血量变化经 MapService 收口广播同图在线玩家。此处无需手动推送。

    // ========== 简略战斗结果统计（对应原版 战斗相关.ecode L755-771 简略模式） ==========
    // 原版在攻击次数>1 时输出"攻击N次，命中X次，被闪避Y次，命中零伤Z次，有效伤W次"。
    // 此处当发生多次攻击尝试时附加统计行，还原原版战斗结算反馈。
    if (atkStats.total > 1) {
      resultLines.push(
        `━━━ 战斗统计 ━━━\n` +
        `攻击${atkStats.total}次，命中${atkStats.hit}次，被闪避${atkStats.dodged}次，` +
        `命中零伤${atkStats.nullDmg}次，有效伤${atkStats.effective}次`,
      );
    }

    // ========== 额外攻击次数（对应原版 战斗相关.ecode L445/L452/L456「额外攻击次数」累加） ==========
    // 棒棒糖触发时 +1、射爆核心冷却就绪时 +1；每点额外次数以当前武器再完整攻击一轮
    // （noDelay+isExtraAttack 防止连击/延时任务重复叠加）。原版由造成伤害外层循环消化该计数。
    if (!context.isExtraAttack && !isRuntimeActor && extraAttackCount > 0) {
      for (let i = 0; i < extraAttackCount; i++) {
        try {
          const extra = await this.weaponAttack(userId, weaponIndex, {
            noDelay: true,
            isCombo: true,
            isExtraAttack: true,
            damageMultiplier: 100,
          });
          resultLines.push(`【额外攻击】\n${extra.result}`);
        } catch (e: any) {
          this.logger.warn(`额外攻击执行失败: ${e?.message ?? e}`);
        }
      }
    }

    // ========== 自动连击（对应原版 武器攻击 L474-545 连击循环） ==========
    // 火神机枪/三千世界 等武器特殊序号触发：冷却结束时自动再次攻击（递归 weaponAttack，最多30次）。
    // noDelay(延时攻击/自动连击/自动战斗) 不再二次触发连击，避免无限递归。
    if (!isRuntimeActor && !noDelay && comboTrigger && weapon?.name) {
      this.triggerCombo(userId, weaponIndex, comboCooldown, weapon.name);
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
   * @param playerData 玩家完整数据（读取好感并复用同一玩家对象）
   * @param map 当前地图
   * @param out 可选的输出累计对象（totalExp 累计召唤物击杀经验，供 weaponAttack 统一 addExp）
   * @returns 召唤物攻击结果文本行
   */
  private async summonCoAttack(
    player: any,
    playerData: PlayerData,
    map: any,
    out?: {
      totalExp: number;
      taskProgress: Array<{ actionName: string; count: number }>;
    },
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
        const affinity = this.playerService.getMarkerValue(playerData.markers, `${summon.name}好感`);
        const level = player.level || 1;
        const summonBonus: BonusData = {
          攻击: (familiarDef.baseAttack ?? familiarDef.attack ?? 10) + affinity + level * 2,
          攻击2: 0,
          命中: (familiarDef.baseHit ?? familiarDef.hit ?? 80) + affinity,
          命中2: 0,
          闪避: familiarDef.dodge ?? 10,
          闪避2: 0,
          暴击: familiarDef.crit ?? 5,
          暴击伤害: familiarDef.critDmg ?? 150,
          生命: summon.hp ?? 100,
          护盾: summon.shield ?? 0,
          装甲: summon.armor ?? 0,
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
        const isCrit = this.checkCrit(summonBonus.暴击 || 0);
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
          const deathResult = await this.handleMonsterDeath(
            target,
            player.userId,
            map.id,
            playerData,
            'normal',
          );
          // 召唤物击杀经验累计到玩家（由 weaponAttack 末尾 addExp 统一发放）
          if (out?.totalExp !== undefined) out.totalExp += deathResult.expGain;
          out?.taskProgress.push(...(deathResult.taskProgress || []));
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
   * 怪物反击（扩至全图玩家）
   * 对应原版 战斗相关.ecode L4647-4713：怪物作为攻击方时，遍历地图上所有玩家，
   * 将「在线(活跃增益) + 当前生命>0 + 无隐匿模式 + 无炮冠」的玩家加入防御方数组，
   * 怪物对每个武器依次攻击数组内全部防御方（每位防御方独立做命中/闪避/伤害判定）。
   * 原版注释 L290-319 是每分钟定时器入口，本函数复刻的是「怪物攻击玩家」这一闭环本体。
   * @param attacker 发起攻击的玩家（原攻击方，用于区分"你"的提示文本）
   * @param attackerData 攻击者完整数据
   * @param map 当前地图
   * @returns 反击结果文本行
   */
  private async monsterCounterAttack(
    attacker: any,
    attackerData: PlayerData,
    map: any,
    taskProgress?: CombatTaskProgress[],
  ): Promise<string[]> {
    const lines: string[] = [];
    try {
      // 随机选一只存活怪物（对应原版 L291：b = 取随机数(1, 取数组成员数(地图.怪物2))）
      const aliveMonsters = (await this.mapService.getMapMonsters(map)).filter((m: any) => (m.hp || 0) > 0);
      if (aliveMonsters.length === 0) return lines;

      const monster = aliveMonsters[Math.floor(Math.random() * aliveMonsters.length)];
      const monsterBonus = this.buildMonsterBonus(monster);

      // ========== 收集全图可反击玩家（对应原版 L4663-4685 防御方筛选） ==========
      // 原版筛选：有"活跃"增益(在线) + 当前生命>0 + 无"隐匿模式" + 无"炮冠" 的玩家。
      // 原版 地图.玩家 数组含发起攻击的玩家本人（玩家在地图玩家列表中），故攻击者也会被反击。
      const onlineIds = this.statsService.getOnlineUserIds();
      // 同一地图的所有玩家档案（DB）
      const mapPlayers = await this.prisma.player.findMany({
        where: { mapId: map.id, userId: { not: undefined } },
        select: { userId: true },
      });
      // 候选 uid 集合：同图玩家 + 攻击者本人（攻击者可能不在 DB 玩家列表，如内存 mock 场景）
      const candidateUids = new Set<number>(mapPlayers.map((mp: any) => mp.userId));
      if (attacker?.userId) candidateUids.add(attacker.userId);
      // 攻击者本人复用外层 weaponAttack 已加载的同一内存对象（attacker/attackerData）：
      // 反击结算直接写在这份对象上、由外层第10步统一保存，避免二次读库产生旧快照副本，
      // 否则外层随后 savePlayer 会把反击写入的死亡/卷土重来状态整体覆盖回去（丢失更新）。
      const isSelfUid = (uid: number): boolean =>
        attacker?.userId != null && Number(uid) === Number(attacker.userId);
      const victimIds: number[] = [];
      for (const uid of candidateUids) {
        if (!onlineIds.has(uid)) continue; // 不攻击离线（原版 增益要求("活跃")==假 跳过）
        try {
          const victim = isSelfUid(uid) ? attacker : (await this.playerService.getPlayerData(uid)).player;
          if (this.playerService.isPlayerDead(victim)) continue; // 当前生命<=0 跳过（鞭尸豁免）
          // 隐匿模式 / 炮冠：原版 标记要求("隐匿模式"/"炮冠", 玩家2.增益) → 查增益列表
          const vBuffs = this.safeParseJson<any[]>(victim.buffs, []);
          if (vBuffs.some((b: any) => b && (b.name || b.名称) === '隐匿模式')) continue;
          if (vBuffs.some((b: any) => b && (b.name || b.名称) === '炮冠')) continue;
          victimIds.push(uid);
        } catch (e: any) {
          this.logger.warn(`读取反击目标 ${uid} 失败: ${e.message}`);
        }
      }
      if (victimIds.length === 0) return lines;

      // 怪物对每个武器依次攻击全部防御方（原版 L4686-4695：循环 攻击方.武器 × 防御方）
      // 本版怪物武器简化为拳头，循环受害者数组即可还原"攻击地图上所有符合条件玩家"。
      for (const uid of victimIds) {
        try {
          const useShared = isSelfUid(uid);
          const victimData = useShared ? attackerData : await this.playerService.getPlayerData(uid);
          const victim = useShared ? attacker : victimData.player;
          const oneLines = await this.monsterCounterAttackOnePlayer(
            monster, monsterBonus, victim, victimData, map, useShared,
            undefined, false, taskProgress, useShared,
          );
          lines.push(...oneLines);
        } catch (e: any) {
          this.logger.warn(`怪物反击玩家 ${uid} 失败: ${e.message}`);
        }
      }
    } catch (err: any) {
      this.logger.warn(`怪物反击失败: ${err.message}`);
    }
    return lines;
  }

  /**
   * 怪物对单个玩家发起反击（伤害/闪避/被动特效本体）
   * 对应原版 战斗相关.ecode L4663-4712：对防御方数组中的某位玩家执行 武器攻击 防御方 分支。
   * @param monster 攻击方怪物
   * @param monsterBonus 怪物属性加成
   * @param victim 受害玩家对象
   * @param victimData 受害玩家完整数据
   * @param map 当前地图
   * @param isSelf 是否攻击者本人（用于"你"的提示文本）
   * @param sharedWithAttacker 受害者对象与外层攻击流程共享（同一内存实例）。
   *        为真时本函数不落库，由外层 weaponAttack 第10步统一保存，
   *        避免旧快照覆盖外层尚未写入的其他状态。
   * @returns 该玩家的反击结果文本行
   */
  private async monsterCounterAttackOnePlayer(
    monster: any,
    monsterBonus: BonusData,
    victim: any,
    victimData: PlayerData,
    map: any,
    isSelf: boolean,
    weaponOverride?: WeaponData,
    runtimeVictim = false,
    taskProgress?: CombatTaskProgress[],
    sharedWithAttacker = false,
  ): Promise<string[]> {
    const lines: string[] = [];
    const localTaskProgress = taskProgress ?? [];
    const queueTaskProgress = (actionName: string, count = 1): void => {
      if (!runtimeVictim && victim?.userId && count > 0) {
        localTaskProgress.push({ userId: Number(victim.userId), actionName, count });
      }
    };
    try {
      // 死亡门禁（防御性复查）：真正倒下的玩家不再被反击选中。
      // 正常流程在 monsterCounterAttack 筛选阶段已豁免；此处兜底拦截
      // 同一轮反击中前序受害者结算刚写入的死亡状态，杜绝鞭尸。
      if (!runtimeVictim && this.playerService.isPlayerDead(victim)) return lines;
      // 命中判定：怪物命中 vs 玩家闪避；玩家若处于「闪避」状态(固定闪避+100)则几乎必闪避(100%免伤)
      // 启示录混乱分支的防御方就是攻击方怪物自身，仍使用怪物初始化属性，
      // 不能把怪物误当作玩家套用使魔成长公式。
      const victimDef = runtimeVictim
        ? this.buildMonsterBonus(victim)
        : this.buildAttackerBonus(victim, victimData, map);
      // 防御方额外文本（原版 _主程序 L12033）：受害者为兰音且三池负数反转时，文本并入反击回包
      if (!runtimeVictim) {
        const victimExtraText = (victimDef as any).额外文本;
        if (Array.isArray(victimExtraText) && victimExtraText.length) {
          lines.push(...victimExtraText.map((t: string) => String(t).replace(/^#?换行/, '')));
        } else if (typeof victimExtraText === 'string' && victimExtraText.trim()) {
          lines.push(...victimExtraText.split(/#?换行|\n/).filter(Boolean));
        }
      }
      const attackWeapon = weaponOverride || {
        name: '怪物攻击',
        damage: 0,
        damageType: CombatSystemService.DMG_PHYS,
        properties: { phys: 100, fire: 0, ice: 0, elec: 0 },
      };
      const attackBonus: BonusData = { ...monsterBonus };
      const weaponBonus = attackWeapon.bonus || {};
      for (const key of ['攻击', '攻击2', '命中', '命中2', '暴击', '暴击伤害', '物伤', '物伤2', '火伤', '火伤2', '冰伤', '冰伤2', '电伤', '电伤2', '贯穿'] as const) {
        const value = Number((weaponBonus as any)[key] ?? (weaponBonus as any)[this.toEnglishBonusKey(key)] ?? 0);
        if (value) (attackBonus as any)[key] = ((attackBonus as any)[key] || 0) + value;
      }
      const hitRate = this.calcHitRate(attackBonus, { 闪避: victimDef.闪避 || 0, 闪避2: victimDef.闪避2 || 0 });
      const youText = isSelf ? '你' : victim.name; // 原版对全图不同玩家用各自名称

      // ========== 防御方被动：幻时凝固（对应原版 战斗相关.ecode L1517-1547） ==========
      {
        const affinity = victim.affinity || 0;
        const happyBuff = this.safeParseJson<any[]>(victim.buffs, []).find((b: any) => b && b.name === '幸福');
        const phantomTrigger = (victim.type === '花园猫' && affinity >= 60) || !!happyBuff;
        if (phantomTrigger) {
          const monsterMarkers2 = this.safeParseJson<any[]>(monster.markers2, []);
          const cdText: { value: string } = { value: '' };
          if (!this.combatState.timeIntervalRequire('幻时冷却', 120, monsterMarkers2, Date.now(), cdText, Date.now())) {
            const monsterBuffs = this.safeParseJson<any[]>(monster.buffs, []);
            this.combatState.gainBuff(monsterBuffs, '幻时', 30, false, Date.now(), 0);
            monster.buffs = JSON.stringify(monsterBuffs);
            lines.push(`${victim.name} 发动了【幻时】，${monster.name} 被幻时凝固`);
          } else {
            lines.push(`${monster.name} 幻时抵抗${cdText.value}`);
          }
          monster.markers2 = JSON.stringify(monsterMarkers2);
          if (victim.type === '花园猫' && affinity >= 60) {
            const pMarkers2 = this.safeParseJson<any[]>(victim.markers2, []);
            this.combatState.gainBuff(pMarkers2, `${victim.type}技能冷却`, -10, true, Date.now(), 0);
            victim.markers2 = JSON.stringify(pMarkers2);
            this.achievementService.addAchievement(victim, '猫猫闪避', 1);
          }
        }
      }

      // 读取玩家"闪避"增益 buff（handleDodge 写入），作为固定闪避值。
      const victimBuffs = this.safeParseJson<any[]>(victim.buffs, []);
      const nowSec = Date.now() / 1000;
      const dodgeBuff = victimBuffs.find((b: any) => b && b.name === '闪避' && (!b.expireAt || b.expireAt > nowSec));
      let fixedDodge = 0;
      if (dodgeBuff) {
        fixedDodge = dodgeBuff.value || 100;
        const remain = Math.ceil((dodgeBuff.expireAt || 0) - nowSec);
        if (remain > 0) lines.push(`${youText}处于闪避状态（剩余${remain}秒），闪开了攻击`);
      }

      if (!this.checkHit(hitRate, fixedDodge)) {
        lines.push(`${monster.name} 向${youText}发起攻击，但被${youText}闪避了`);
        // ========== 花园猫闪避反击（对应原版 战斗相关.ecode L1429-1560 防御方闪避成功分支） ==========
        // 仅当花园猫就是外层持锁攻击者本人（sharedWithAttacker）时跳过再次加锁，
        // 否则正常走 weaponAttack 获取该玩家自己的战斗锁。
        if (victim.type === '花园猫') {
          try {
            const counterLines = await this.handleGardenCatCounter(
              victim.userId, 0, sharedWithAttacker, sharedWithAttacker ? victimData : undefined,
            );
            if (counterLines) lines.push(counterLines);
          } catch (e: any) {
            this.logger.warn(`花园猫反击失败: ${e.message}`);
          }
        }
        // ========== 防御方被动：含光回防（对应原版 战斗相关.ecode L1429-1444） ==========
        {
          const equipList: any[] = this.safeParseJson(victimData.equipment, []);
          const hanGuang = equipList.find((e: any) => (e.name || '').includes('含光'));
          if (hanGuang && (hanGuang.durability ?? hanGuang.耐久 ?? 0) > 8) {
            if ((victim.maxShield || 0) >= (victim.maxArmor || 0) && (victim.maxShield || 0) >= (victim.maxHp || 0)) {
              const heal = Math.round((victim.maxShield || 0) * 0.1);
              victim.shield = Math.min((victim.maxShield || 0), (victim.shield || 0) + heal);
              lines.push(`【含光】${victim.name} 回复了 ${heal} 护盾`);
            } else if ((victim.maxArmor || 0) >= (victim.maxHp || 0)) {
              const heal = Math.round((victim.maxArmor || 0) * 0.1);
              victim.armor = Math.min((victim.maxArmor || 0), (victim.armor || 0) + heal);
              lines.push(`【含光】${victim.name} 修复了 ${heal} 装甲`);
            } else {
              const heal = Math.round((victim.maxHp || 0) * 0.1);
              victim.hp = Math.min((victim.maxHp || 0), (victim.hp || 0) + heal);
              lines.push(`【含光】${victim.name} 恢复了 ${heal} 生命`);
            }
          }
        }
        // 与外层攻击流程共享同一玩家对象时不在此落库，由外层 weaponAttack 第10步统一保存
        if (!sharedWithAttacker) await this.playerService.savePlayer(victim);
        // UI 同步：savePlayer 落库后由 Prisma 拦截器自动触发面板刷新，无需手动推送
        if (!taskProgress && this.taskService) {
          for (const progress of localTaskProgress) {
            await this.taskService.advance(progress.userId ?? Number(victim.userId), progress.actionName, progress.count);
          }
        }
        return lines;
      }

      // 载具数据需要在伤害计算前读取：阿尔缇娜的贯穿加成发生在原版“贯穿判断”之前。
      const mapVehicles = this.playerService.safeJsonParse<any[]>(map.vehicles, []);
      const vehicleIndex = mapVehicles.findIndex((x: any) => x && (x.id === victim.vehicle || x.编号 === victim.vehicle));
      const vehicle = vehicleIndex >= 0 ? mapVehicles[vehicleIndex] : undefined;
      const vehicleCurrentHp = Number(vehicle?.currentHp ?? vehicle?.当前生命 ?? 0);
      const altinaMultiplier = 1.25 + Number(monster.skillLevel ?? 0) / 200;
      const damageAttackerBonus: BonusData = { ...attackBonus };
      if (vehicleCurrentHp > 0 && (monster.specialSeq ?? 0) === 7) {
        damageAttackerBonus.贯穿 = (damageAttackerBonus.贯穿 || 0) * 1.5;
      }

      // 伤害计算（怪物作为攻击方，玩家作为防御方；怪物武器简化为拳头+怪物四属性伤害）
      // 侵彻仅限玩家套装增幅器5触发，怪物无套装故 amplifier5=false
      const monsterWeaponAnesthesia = (attackWeapon.self as any)?.anesthesia ?? attackWeapon.anesthesia ?? 0;
      const victimMarkersVtd = this.playerService.safeJsonParse<Record<string, any>>(victim.markers || '{}', {});
      const victimProfBefore = Number(victimMarkersVtd['猩红'] ?? 0);
      const dmg = this.calcDamage(
        damageAttackerBonus,
        {
          生命: victim.hp || 0,
          护盾: victim.shield || 0,
          装甲: victim.armor || 0,
          闪避: victimDef.闪避 || 0,
          闪避2: victimDef.闪避2 || 0,
          护盾物抗: victimDef.护盾物抗 || 0,
          护盾火抗: victimDef.护盾火抗 || 0,
          护盾冰抗: victimDef.护盾冰抗 || 0,
          护盾电抗: victimDef.护盾电抗 || 0,
          护盾全抗: victimDef.护盾全抗 || 0,
          装甲物抗: victimDef.装甲物抗 || 0,
          装甲火抗: victimDef.装甲火抗 || 0,
          装甲冰抗: victimDef.装甲冰抗 || 0,
          装甲电抗: victimDef.装甲电抗 || 0,
          装甲全抗: victimDef.装甲全抗 || 0,
          生命物抗: victimDef.生命物抗 || 0,
          生命火抗: victimDef.生命火抗 || 0,
          生命冰抗: victimDef.生命冰抗 || 0,
          生命电抗: victimDef.生命电抗 || 0,
          生命全抗: victimDef.生命全抗 || 0,
          生命伤害上限: 100,
          装甲伤害上限: 100,
          护盾伤害上限: 100,
        },
        attackWeapon,
        attackWeapon.damageType || CombatSystemService.DMG_PHYS,
        false,
        {
          weaponAnesthesia: monsterWeaponAnesthesia,
          defenderMarkers: victimMarkersVtd,
          defenderBuffs: this.safeParseJson<any[]>(victim.buffs || '[]', []),
        },
      );
      if (victimProfBefore > 0 && Number(victimMarkersVtd['猩红'] ?? 0) === 0) {
        victim.markers = JSON.stringify(victimMarkersVtd);
      }
      const finalDmg = Math.max(0, Math.floor(dmg.damage));

      // ========== 载具承伤（对应原版 战斗相关.ecode L3175-3529） ==========
      // 原版载具分支结尾会清空普通四属性剩余伤害；载具击毁的同一次普通攻击不把
      // 溢出伤害转给驾驶员，只有“阵地”强制分支会继续穿透玩家三池。
      const vehicleResolution = await this.resolveVehicleDamage({
        vehicle,
        vehicleIndex,
        mapVehicles,
        map,
        attacker: monster,
        attackerBonus: damageAttackerBonus,
        victim,
        damage: dmg,
        baseDamage: finalDmg,
        altinaMultiplier,
        lines,
      });
      const playerDamage = vehicleResolution.damageToPlayer;

      // 扣除玩家血量（三池：护盾→装甲→生命），仅结算载具未吸收的部分
      const pool = vehicleResolution.poolDamage || dmg.poolDamage || { shield: 0, armor: 0, hp: playerDamage };
      const shieldBeforeDamage = Number(victim.shield || 0);
      const armorBeforeDamage = Number(victim.armor || 0);
      const shieldDmg = Math.min(Math.max(0, Math.round(pool.shield || 0)), victim.shield || 0);
      const armorDmg = Math.min(Math.max(0, Math.round(pool.armor || 0)), victim.armor || 0);
      const hpDmg = Math.min(Math.max(0, Math.round(pool.hp || 0)), victim.hp || 0);
      victim.shield = Math.max(0, (victim.shield || 0) - shieldDmg);
      victim.armor = Math.max(0, (victim.armor || 0) - armorDmg);
      victim.hp = Math.max(0, (victim.hp || 0) - hpDmg);

      // 猩红积累（战斗相关.ecode L3854-3859）：玩家作为受害者且带活跃猩红增益时，
      // 本次总伤害（上限=扣血后三池当前总和）累计入"猩红"熟练度，供真伤释放。
      // 与释放端互斥（释放要求无活跃增益），复用上面已解析的 victimMarkersVtd。
      if (playerDamage > 0) {
        try {
          const vBuffsScarlet = this.safeParseJson<any[]>(victim.buffs || '[]', []);
          const nowMsScarlet = Date.now();
          const hasScarletBuffV = vBuffsScarlet.some((b: any) => {
            if (!b) return false;
            if ((b.名称 ?? b.name) !== '猩红') return false;
            const rawExpire = Number(b.有效期至 ?? b.expireAt ?? 0);
            const expireMs = rawExpire > 0 && rawExpire < 1e12 ? rawExpire * 1000 : rawExpire;
            return expireMs > nowMsScarlet;
          });
          if (hasScarletBuffV) {
            const vStateCap = (victim.hp || 0) + (victim.armor || 0) + (victim.shield || 0);
            victimMarkersVtd['猩红'] = (Number(victimMarkersVtd['猩红'] ?? 0) || 0) + Math.min(playerDamage, vStateCap);
            victim.markers = JSON.stringify(victimMarkersVtd);
          }
        } catch {
          /* 标记/增益解析失败时跳过积累 */
        }
      }

      // 贯穿抵抗可能在载具结算中把 dmg.penetrated 清零，必须读取最终值。
      if (dmg.penetrated) queueTaskProgress('被贯穿');
      if (shieldBeforeDamage > 0 && shieldDmg > 0 && Number(victim.shield || 0) <= 0) {
        queueTaskProgress('被破盾');
      }
      if (armorBeforeDamage > 0 && armorDmg > 0 && Number(victim.armor || 0) <= 0) {
        queueTaskProgress('被破甲');
      }

      const dmgText = this.formatDamageText(playerDamage, { shield: shieldDmg, armor: armorDmg, hp: hpDmg });
      const wasDefeated = this.playerService.isPlayerDead(victim);
      if (wasDefeated) {
        queueTaskProgress('被击败');
        // ========== 卷土重来（对应原版 造成伤害 L3674：怪物击杀玩家，若 jlq 冷却未过则进入卷土重来状态） ==========
        // 原版：防御方.特殊序号>0(玩家) 且 时间间隔要求("jlq",60,防御方.标记2)==假 →
        // 获得增益("卷土重来", 30+玩家.属性.卷土重来)，立即满状态复活。
        const nowSecV = Math.floor(Date.now() / 1000);
        const vMk2 = this.safeParseJson<any[]>(victim.markers2, []);
        // 兼容存量重复标记：不能只用 find() 检查第一条 jlq，
        // 否则前面的过期记录会遮蔽后面真正有效的冷却，导致重复触发卷土重来。
        const hasActiveJlq = vMk2.some((marker: any) => {
          if ((marker?.name ?? marker?.名称) !== 'jlq') return false;
          const rawExpire = Number(marker?.expireAt ?? marker?.有效期至 ?? 0);
          const expireSec = rawExpire >= 1e12 ? rawExpire / 1000 : rawExpire;
          return expireSec > nowSecV;
        });
        if (!hasActiveJlq) {
          const vBonus = this.safeParseJson<any>(victim.bonus, {});
          const jtlSec = 30 + (vBonus['卷土重来'] || 0);
          const vBuffs = this.safeParseJson<any[]>(victim.buffs, []);
          // 原版 获得增益("卷土重来", 30+卷土重来属性) 写入玩家增益
          vBuffs.push({ name: '卷土重来', expireAt: nowSecV + jtlSec });
          victim.buffs = JSON.stringify(vBuffs);
          // 满状态复活（原版 当前生命/护盾/装甲 = 属性.对应上限）
          // 存量玩家可能没有同步 max* 字段；原版使用计算后的属性上限，
          // 因此依次回退到当前防御属性构建结果，最后才保留原值。
          victim.hp = Number(victim.maxHp || victimDef.生命 || victim.hp || 0);
          victim.shield = Number(victim.maxShield || victimDef.护盾 || victim.shield || 0);
          victim.armor = Number(victim.maxArmor || victimDef.装甲 || victim.armor || 0);
          // 写入 jlq 冷却 60 秒（原版 时间间隔要求("jlq",60)）。
          // 新写入前清除同名旧项，避免历史重复标记再次遮蔽有效冷却。
          const markersWithoutJlq = vMk2.filter((marker: any) => (marker?.name ?? marker?.名称) !== 'jlq');
          markersWithoutJlq.push({ name: 'jlq', expireAt: nowSecV + 60 });
          victim.markers2 = JSON.stringify(markersWithoutJlq);
          lines.push(`${monster.name} 攻击${youText}，造成 ${dmgText}，${youText}进入了卷土重来状态(${jtlSec}秒)`);
        } else {
          lines.push(`${monster.name} 攻击${youText}，造成 ${dmgText}，${youText}倒下了！`);
          if (isSelf) lines.push(`你已死亡，可使用「救助」或「复活使魔」来复活`);
          // 光荣弹（对应原版 战斗相关.ecode L584/591 死亡分支）：玩家死亡且装备 #光荣弹(44)
          try {
            const gloryText = await this.gloryGrenade(victim, monster, victimData, map, Date.now());
            if (gloryText) {
              lines.push(gloryText);
              await this.updateMonsterHpInMap(map.id, monster).catch(() => undefined);
            }
          } catch (e: any) {
            this.logger.warn(`光荣弹触发失败: ${e.message}`);
          }
        }
      } else {
        lines.push(`${monster.name} 使用${attackWeapon.name}攻击${youText}，造成 ${dmgText}`);
      }
      if (runtimeVictim) {
        await this.persistRuntimeActor(victim, map);
      } else {
        await this.playerService.savePlayer(victim);
      }
      if (!taskProgress && this.taskService) {
        for (const progress of localTaskProgress) {
          await this.taskService.advance(progress.userId ?? Number(victim.userId), progress.actionName, progress.count);
        }
      }
    } catch (err: any) {
      this.logger.warn(`怪物反击单体失败: ${err.message}`);
    }
    return lines;
  }

  /** 对齐加成计算.ecode L1409-1429“战斗中增加攻击”。 */
  private addCombatAttack(bonus: BonusData, fixedAttack = 0, percentAttack = 0): void {
    if (fixedAttack !== 0) {
      const attack2 = Number(bonus.攻击2 || 0) / 100;
      const factor = 1 + attack2;
      for (const key of ['电伤', '物伤', '冰伤', '火伤'] as const) {
        const secondary = Number((bonus as any)[`${key}2`] || 0) / 100;
        (bonus as any)[key] = Number((bonus as any)[key] || 0) + fixedAttack * (1 + secondary) * factor;
      }
      return;
    }
    if (percentAttack !== 0) {
      const factor = 1 + percentAttack / 100;
      for (const key of ['电伤', '物伤', '冰伤', '火伤'] as const) {
        (bonus as any)[key] = Number((bonus as any)[key] || 0) * factor;
      }
    }
  }

  /**
   * 原版“攻击召唤”（使魔技能.ecode L236-373）。
   *
   * 这一步必须发生在每个目标的命中判定之前：它只负责按唯一 QQ、冷却和
   * 重力井规则生成对象，不参与本次攻击的伤害结算。友方对象写入地图
   * summons，敌对对象写入 GameMonster，正好对应原版的两套临时数组。
   */
  async attackSummons(
    map: any,
    attacker: any,
    attackerData: PlayerData,
    weapon: WeaponData,
    timestamp = Date.now(),
  ): Promise<string[]> {
    const lines: string[] = [];
    // 保持旧版轻量测试夹具/外部注入实现的兼容性；完整 MapService 会提供
    // 这两个能力，缺失时不影响原有伤害结算。
    if (typeof (this.mapService as any).summonExists !== 'function'
      || typeof (this.mapService as any).createMapSummonByName !== 'function') {
      return lines;
    }
    const nowMs = timestamp >= 1e12 ? timestamp : timestamp * 1000;
    const specialSeq = Number(attacker?.specialSeq ?? attacker?.特殊序号 ?? 0);
    const attackerQQ = String(
      attacker?.qqNumber
      ?? attacker?.QQ
      ?? attacker?.qq
      ?? attacker?.userId
      ?? attacker?.id
      ?? '',
    );
    if (!attackerQQ || !map?.id) return lines;

    const skillLevel = this.skillLevelFromMarkers(
      attackerData.markers,
      String(attacker?.type ?? attacker?.类型 ?? ''),
    );
    const displayName = String(attacker?.name ?? attacker?.名称 ?? attacker?.type ?? attacker?.类型 ?? '攻击方');

    // 兰音：特殊序号23，友方宇航兔唯一存在于所有地图。
    if (specialSeq === 23 || attacker?.type === '兰音') {
      const summonQQ = `怪物宇航兔${attackerQQ}xg`;
      if (!(await this.mapService.summonExists(1, summonQQ))
        && this.setAttackSummonCooldown(attacker, attackerData, '召yht', Math.max(0, 60 - skillLevel), nowMs)) {
        const summon = await this.mapService.createMapSummonByName(map.id, '宇航兔', {
          level: this.forcedSummonLevel(attacker, false),
          ownerQQ: attackerQQ,
          qq: summonQQ,
        });
        this.setForcedLevelMarker(summon, this.forcedSummonLevel(attacker, false));
        if (await this.appendFriendlySummon(map, summon)) {
          lines.push('#换行【一只宇航兔从地下钻了出来】');
        }
      }
    }

    // 雷火剑：原版常量为-34，兼容历史测试/旧配置中的1001以及名称判断。
    const isThunderFireSword = weapon && (
      Number(weapon.specialSeq) === -34
      || Number(weapon.specialSeq) === 1001
      || String(weapon.name ?? '').includes('雷火剑')
    );
    if (isThunderFireSword) {
      const summonQQ = `怪物2巨航兔${attackerQQ}xg`;
      if (!(await this.mapService.summonExists(1, summonQQ))
        && this.setAttackSummonCooldown(attacker, attackerData, '召2yht', 60, nowMs)) {
        const summon = await this.mapService.createMapSummonByName(map.id, '巨型宇航兔', {
          level: this.forcedSummonLevel(attacker, false),
          ownerQQ: attackerQQ,
          qq: summonQQ,
        });
        this.setForcedLevelMarker(summon, this.forcedSummonLevel(attacker, false));
        if (await this.appendFriendlySummon(map, summon)) {
          lines.push('#换行【一只巨型宇航兔从地下钻了出来】');
        }
      }
    }

    const equipment = Array.isArray(attackerData.equipment) ? attackerData.equipment : [];
    for (const rawEquipment of equipment) {
      const summonText = this.getAttackSummonText(rawEquipment);
      if (!summonText) continue;

      const [namePart, entryText = '', gravityText = ''] = summonText
        .split(/[;；]/)
        .map((part) => part.trim());
      const summonName = namePart || '';
      if (!summonName) continue;
      const friendly = specialSeq !== -1;
      const summonQQ = `怪物${summonName}${attackerQQ}${friendly ? 'xg' : ''}`;
      const exists = await this.mapService.summonExists(friendly ? 1 : 2, summonQQ);
      if (exists) continue;

      // 原版只让敌对怪物受到重力井影响；被拦截本身也会占用60秒召唤冷却。
      if (!friendly && this.hasGravityWell(map, nowMs)) {
        if (this.setAttackSummonCooldown(attacker, attackerData, `${summonName}冷却`, 60, nowMs)) {
          lines.push(gravityText
            ? `#换行【${gravityText}】`
            : `#换行【${summonName}因为重力异常无法入场】`);
        }
        continue;
      }

      if (!this.setAttackSummonCooldown(attacker, attackerData, `${summonName}冷却`, 60, nowMs)) {
        continue;
      }

      try {
        if (friendly) {
          const isPet = specialSeq < -1;
          const forcedLevel = this.forcedSummonLevel(attacker, isPet);
          const summon = await this.mapService.createMapSummonByName(map.id, summonName, {
            level: forcedLevel,
            ownerQQ: isPet
              ? String(attacker?.ownerQQ ?? attacker?.归属 ?? '')
              : attackerQQ,
            qq: summonQQ,
          });
          this.setForcedLevelMarker(summon, forcedLevel);
          if (isPet) this.applyPetCloneState(summon, attacker);
          if (await this.appendFriendlySummon(map, summon)) {
            lines.push(entryText
              ? `#换行【${entryText}】`
              : `#换行【${summonName}在${displayName}的呼叫下跃迁到了${map.name}】`);
          }
        } else {
          await this.mapService.spawnMonsterByName(map.id, summonName, {
            level: this.forcedSummonLevel(attacker, false),
            isTemp: true,
            qq: summonQQ,
          });
          lines.push(entryText
            ? `#换行【${entryText}】`
            : `#换行【${summonName}在${displayName}的呼叫下跃迁到了${map.name}】`);
        }
      } catch (error: any) {
        // 原版找不到怪物模板时不会中断整次攻击；保留冷却并继续处理其他装备。
        this.logger.warn(`攻击召唤「${summonName}」失败: ${error?.message || error}`);
      }
    }
    return lines;
  }

  private setAttackSummonCooldown(
    attacker: any,
    attackerData: PlayerData,
    name: string,
    seconds: number,
    nowMs: number,
  ): boolean {
    const raw = attacker?.markers2 ?? attacker?.标记2 ?? attackerData.markers2 ?? [];
    const entries = this.safeParseJson<any[]>(raw, Array.isArray(raw) ? raw : []);
    const active = entries.some((entry: any) => {
      const entryName = entry?.name ?? entry?.名称;
      const rawExpire = Number(entry?.expireAt ?? entry?.有效期至 ?? 0);
      const expireAt = rawExpire > 0 && rawExpire < 1e12 ? rawExpire * 1000 : rawExpire;
      return entryName === name && expireAt > nowMs;
    });
    if (active) return false;

    const next = entries.filter((entry: any) => (entry?.name ?? entry?.名称) !== name);
    next.push({ name, expireAt: nowMs + Math.max(0, seconds) * 1000 });
    attacker.markers2 = JSON.stringify(next);
    attackerData.markers2 = next;
    if (attacker.标记2 !== undefined) attacker.标记2 = next;
    return true;
  }

  private forcedSummonLevel(attacker: any, isPet: boolean): number {
    const level = Number(attacker?.level ?? attacker?.等级 ?? 1) || 1;
    return Math.max(1, Math.floor(isPet ? level : level / 3));
  }

  private setForcedLevelMarker(summon: any, level: number): void {
    const markers = this.normalizeMarkerObject(summon?.markers ?? summon?.标记 ?? {});
    markers['强制等级'] = level;
    summon.markers = JSON.stringify(markers);
    if (summon.标记 !== undefined) summon.标记 = markers;
  }

  private applyPetCloneState(summon: any, attacker: any): void {
    const originalName = String(summon?.name ?? summon?.名称 ?? '');
    if (!originalName.includes('分身')) return;

    const image = String(attacker?.image ?? attacker?.图片 ?? attacker?.name ?? attacker?.名称 ?? '');
    const cloneName = `${image}分身`;
    summon.name = cloneName;
    summon.名称 = cloneName;
    summon.image = cloneName;
    summon.图片 = cloneName;

    const presets = this.safeParseJson<any[]>(
      attacker?.equipmentPresets ?? attacker?.装备预设 ?? [],
      Array.isArray(attacker?.equipmentPresets ?? attacker?.装备预设)
        ? (attacker?.equipmentPresets ?? attacker?.装备预设)
        : [],
    );
    summon.equipmentPresets = JSON.stringify(presets);
    summon.装备预设 = presets;

    const sourceMarkers = this.normalizeMarkerObject(attacker?.markers ?? attacker?.标记 ?? {});
    const markers = this.normalizeMarkerObject(summon?.markers ?? summon?.标记 ?? {});
    for (const key of ['觉醒', '击杀', '宝宝']) {
      if (sourceMarkers[key] !== undefined) markers[key] = sourceMarkers[key];
    }
    const owner = String(attacker?.ownerQQ ?? attacker?.归属 ?? '');
    if (owner && sourceMarkers[`好感${owner}`] !== undefined) {
      markers[`好感${owner}`] = sourceMarkers[`好感${owner}`];
    }
    const attackerQQ = String(attacker?.qq ?? attacker?.QQ ?? '');
    if (attackerQQ) markers[attackerQQ] = 14.421425;
    summon.markers = JSON.stringify(markers);
    summon.标记 = markers;
  }

  private async appendFriendlySummon(map: any, summon: any): Promise<boolean> {
    const write = async (): Promise<boolean> => {
      const current = await this.mapService.getMapById(map.id) || map;
      const raw = current?.summons ?? current?.召唤物 ?? [];
      const summons = Array.isArray(raw)
        ? [...raw]
        : this.playerService.safeJsonParse<any[]>(raw, []);
      const qq = String(summon?.qq ?? summon?.QQ ?? '');
      if (summons.some((item: any) => String(item?.qq ?? item?.QQ ?? '') === qq)) return false;
      summons.push(summon);
      await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });
      map.summons = JSON.stringify(summons);
      return true;
    };
    if (typeof (this.mapService as any).withMapLock === 'function') {
      return (this.mapService as any).withMapLock(map.id, write);
    }
    return write();
  }

  private getAttackSummonText(rawEquipment: any): string {
    const name = String(rawEquipment?.name ?? rawEquipment?.名称 ?? rawEquipment ?? '');
    if (!name) return '';
    const staticDefinition = typeof (this.staticData as any).getEquipmentByName === 'function'
      ? (this.staticData as any).getEquipmentByName(name)
      : undefined;
    const type = String(
      rawEquipment?.equipType
      ?? rawEquipment?.type
      ?? rawEquipment?.位置
      ?? rawEquipment?.分类
      ?? staticDefinition?.equipType
      ?? staticDefinition?.type
      ?? '',
    );
    const isWeapon = type.endsWith('武器')
      || (typeof (this.staticData as any).isWeapon === 'function'
        && (this.staticData as any).isWeapon(staticDefinition));
    if (isWeapon) return '';

    const parseText = (value: any): string => {
      if (!value) return '';
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          return parseText(parsed);
        } catch {
          return value.trim();
        }
      }
      if (typeof value === 'object') {
        return String(value.name ?? value.名称 ?? '').trim();
      }
      return '';
    };
    return parseText(
      rawEquipment?.attackText
      ?? rawEquipment?.攻击文本
      ?? staticDefinition?.attackText
      ?? staticDefinition?.攻击文本,
    );
  }

  private hasGravityWell(map: any, timestamp = Date.now()): boolean {
    const parseArray = (value: any): any[] => {
      if (Array.isArray(value)) return value;
      return this.playerService.safeJsonParse<any[]>(value, []);
    };
    const active = (value: any): boolean => parseArray(value).some((item: any) => {
      const name = String(item?.name ?? item?.名称 ?? item ?? '');
      if (name !== '重力井') return false;
      const rawExpire = Number(item?.expireAt ?? item?.有效期至 ?? 0);
      const expireAt = rawExpire > 0 && rawExpire < 1e12 ? rawExpire * 1000 : rawExpire;
      return !expireAt || expireAt > timestamp;
    });
    if (active(map?.markers3 ?? map?.标记3) || active(map?.mapBuffs)) return true;

    const markers = map?.markers ?? map?.标记;
    if (active(markers)) return true;
    const markerObject = this.safeParseJson<Record<string, any>>(markers, {});
    if (markerObject && Number(markerObject['重力井'] ?? 0) > 0) return true;

    const vehicles = parseArray(map?.vehicles ?? map?.载具);
    const collectPartNames = (value: any, names: string[]): void => {
      for (const part of parseArray(value)) {
        const name = String(part?.name ?? part?.名称 ?? part ?? '');
        if (name) names.push(name);
        collectPartNames(part?.parts ?? part?.零件, names);
        collectPartNames(part?.builtinParts ?? part?.内置零件, names);
      }
    };
    return vehicles.some((vehicle: any) => {
      const currentHp = Number(vehicle?.currentHp ?? vehicle?.当前生命 ?? 0);
      const driver = vehicle?.driver ?? vehicle?.驾驶员 ?? vehicle?.ownerDriver ?? '';
      if (currentHp <= 0 || !String(driver)) return false;
      const names: string[] = [];
      collectPartNames(vehicle?.parts ?? vehicle?.零件, names);
      collectPartNames(vehicle?.builtinParts ?? vehicle?.内置零件, names);
      return names.includes('重力井') || String(vehicle?.name ?? vehicle?.名称 ?? '') === '重力井';
    });
  }

  /**
   * 结算单次攻击对载具的影响。
   *
   * 对应原版 战斗相关.ecode L3175-L3529：这里保留原版的执行顺序，
   * 并把“普通剩余伤害”和“贯穿直接伤害”分开。原版在载具分支结束时
   * 会清空普通剩余四属性，所以载具被击毁的同一次普通攻击不会自动溢出
   * 到驾驶员；贯穿产生的额外三池伤害仍按原版继续结算。
   */
  private async resolveVehicleDamage(options: {
    vehicle?: any;
    vehicleIndex: number;
    mapVehicles: any[];
    map: any;
    attacker: any;
    attackerBonus: BonusData;
    victim: any;
    damage: DamageResult;
    baseDamage: number;
    altinaMultiplier: number;
    lines: string[];
  }): Promise<{ damageToPlayer: number; poolDamage: PoolDamage }> {
    const {
      vehicle,
      vehicleIndex,
      mapVehicles,
      map,
      attacker,
      attackerBonus,
      victim,
      damage,
      baseDamage,
      altinaMultiplier,
      lines,
    } = options;

    const zeroBreakdown = (): DamageBreakdown => ({ physical: 0, fire: 0, ice: 0, elec: 0 });
    const zeroPool = (): PoolDamage => ({ shield: 0, armor: 0, hp: 0 });
    const sumBreakdown = (b: DamageBreakdown): number => b.physical + b.fire + b.ice + b.elec;
    const sumPool = (p: PoolDamage): number => p.shield + p.armor + p.hp;
    const scaleBreakdown = (b: DamageBreakdown, ratio: number): DamageBreakdown => ({
      physical: b.physical * ratio,
      fire: b.fire * ratio,
      ice: b.ice * ratio,
      elec: b.elec * ratio,
    });
    const scalePool = (p: PoolDamage, ratio: number): PoolDamage => ({
      shield: p.shield * ratio,
      armor: p.armor * ratio,
      hp: p.hp * ratio,
    });
    const copyPool = (p: PoolDamage): PoolDamage => ({
      shield: Math.max(0, Number(p.shield || 0)),
      armor: Math.max(0, Number(p.armor || 0)),
      hp: Math.max(0, Number(p.hp || 0)),
    });
    const subtractPool = (whole: PoolDamage, part: PoolDamage): PoolDamage => ({
      shield: Math.max(0, whole.shield - part.shield),
      armor: Math.max(0, whole.armor - part.armor),
      hp: Math.max(0, whole.hp - part.hp),
    });
    const hasBreakdown = (b: DamageBreakdown): boolean => sumBreakdown(b) > 0;

    const vehicleParts = this.getVehiclePartNames(vehicle);
    const hasPart = (name: string): boolean => vehicleParts.includes(name);
    const currentHp = Number(vehicle?.currentHp ?? vehicle?.当前生命 ?? 0);
    const hasVehicle = !!vehicle && currentHp > 0;
    const reverseField = !!(vehicle?.reverseField ?? vehicle?.逆转力场);
    const nowMs = Date.now();
    const status = Math.max(0, Number(victim.hp || 0) + Number(victim.armor || 0) + Number(victim.shield || 0));
    const attackerMarkers = this.playerService.safeJsonParse<any[]>(attacker?.markers2, []);
    const victimMarkers = this.playerService.safeJsonParse<any[]>(victim?.markers2, []);
    const victimBuffs = this.playerService.safeJsonParse<any[]>(victim?.buffs, []);
    const vehicleMarkers = this.playerService.safeJsonParse<any[]>(vehicle?.markers2, []);
    let attackerMarkersChanged = false;
    let vehicleChanged = false;

    const persistAttackerMarkers = async (): Promise<void> => {
      if (!attackerMarkersChanged) return;
      attacker.markers2 = JSON.stringify(attackerMarkers);
      if (typeof attacker.id === 'number') {
        await this.updateMonsterHpInMap(map.id, attacker);
      }
    };
    const persistVehicle = async (): Promise<void> => {
      if (!hasVehicle || vehicleIndex < 0) return;
      vehicle.markers2 = JSON.stringify(vehicleMarkers);
      mapVehicles[vehicleIndex] = vehicle;
      map.vehicles = JSON.stringify(mapVehicles);
      if (vehicleChanged || vehicleIndex >= 0) {
        try {
          await this.mapService.updateDynamicFields(map.id, { vehicles: map.vehicles });
        } catch (e: any) {
          this.logger.warn(`载具承伤持久化失败: ${e.message}`);
        }
      }
    };

    const basePool = copyPool(damage.poolDamage || { shield: 0, armor: 0, hp: baseDamage });
    let extraPool = copyPool(damage.vehicleExtraPoolDamage || zeroPool());
    let extraBreakdown = damage.vehicleExtraBreakdown || {
      shield: zeroBreakdown(),
      armor: zeroBreakdown(),
      life: zeroBreakdown(),
    };
    let remaining = damage.vehicleBreakdown
      ? { ...damage.vehicleBreakdown }
      : damage.damageBreakdown
        ? { ...damage.damageBreakdown }
        : { physical: baseDamage, fire: 0, ice: 0, elec: 0 };
    const originalRemainingTotal = Math.max(0, sumBreakdown(remaining));
    const originalExtraPool = copyPool(extraPool);
    let penetrationResisted = false;

    // 原版 L3192-L3212：损伤控制系统B优先于A，只有贯穿命中时才消耗“sk”冷却。
    // 原始源码的这一段没有C分支，按原版保留。
    if (hasVehicle && damage.penetrated) {
      if (hasPart('损伤控制系统B')) {
        const cooldown = hasPart('损伤控制系统强化') ? 35 : 60;
        if (!this.combatState.timeIntervalRequire('sk', cooldown, vehicleMarkers, nowMs, { value: '' }, nowMs)) {
          penetrationResisted = true;
        }
      } else if (hasPart('损伤控制系统A')) {
        const cooldown = hasPart('损伤控制系统强化') ? 20 : 45;
        if (!this.combatState.timeIntervalRequire('sk', cooldown, vehicleMarkers, nowMs, { value: '' }, nowMs)) {
          penetrationResisted = true;
        }
      }
      if (penetrationResisted) {
        damage.penetrated = false;
        extraPool = zeroPool();
        extraBreakdown = {
          shield: zeroBreakdown(),
          armor: zeroBreakdown(),
          life: zeroBreakdown(),
        };
        vehicleChanged = true;
        lines.push('【贯穿抵抗】');
      }
    }

    // 载具部件使用中文标记2作为唯一状态容器；上面的时间接口会原地归一化它。
    if (hasVehicle) {
      vehicleChanged = true;
      vehicle.markers2 = JSON.stringify(vehicleMarkers);
    }

    // 原版 L3181-L3188/L3482-L3484：阿尔缇娜先放大四属性，载具伤害结算后再放大一次。
    if (hasVehicle && (attacker.specialSeq ?? 0) === 7) {
      remaining = scaleBreakdown(remaining, altinaMultiplier);
      extraBreakdown = {
        shield: scaleBreakdown(extraBreakdown.shield, altinaMultiplier),
        armor: scaleBreakdown(extraBreakdown.armor, altinaMultiplier),
        life: scaleBreakdown(extraBreakdown.life, altinaMultiplier),
      };
      extraPool = scalePool(extraPool, altinaMultiplier);
      lines.push(`【阿尔缇娜】贯穿载具伤害×${altinaMultiplier.toFixed(3)}`);
    }

    // 原版 L3298-L3316：已存在的“福音书”先把四属性剩余伤害固定为0.25，
    // 并清除贯穿额外伤害；该步骤发生在载具涂层和阵地判断之前。
    const gospelStrengthText = { value: 0 };
    const gospelTimeText = { value: 0 };
    const hasGospel = this.combatState.buffRequire('福音书', victimBuffs, gospelStrengthText, nowMs, gospelTimeText);
    if (hasGospel && gospelStrengthText.value > 0) {
      remaining = { physical: 0.25, fire: 0.25, ice: 0.25, elec: 0.25 };
      this.combatState.gainBuff2(
        victimBuffs,
        { 名称: '福音书', 持续时间: 300, 强度: 10 },
        nowMs,
      );
      extraPool = zeroPool();
      extraBreakdown = {
        shield: zeroBreakdown(),
        armor: zeroBreakdown(),
        life: zeroBreakdown(),
      };
      victim.buffs = JSON.stringify(victimBuffs);
      lines.push(`【福音书${gospelStrengthText.value}】`);
    } else if (hasGospel) {
      victim.buffs = JSON.stringify(victimBuffs);
    }

    const terrainValue = this.normalizeMarkerObject(attacker?.markers)['阵地'] || 0;
    // 原版 L3350-L3355：阵地攻击方不走载具的1/2点伤害上限；前线作为防御方时仍走普通载具分支。
    const forceVehicleDamage = terrainValue !== 0 && victim.name !== '前线';
    const poolFromRemaining = (): PoolDamage => {
      const normalPool = penetrationResisted ? subtractPool(basePool, originalExtraPool) : subtractPool(basePool, originalExtraPool);
      const remainingRatio = originalRemainingTotal > 0
        ? sumBreakdown(remaining) / originalRemainingTotal
        : 1;
      const adjustedPool = scalePool(normalPool, remainingRatio);
      return {
        shield: adjustedPool.shield + extraPool.shield,
        armor: adjustedPool.armor + extraPool.armor,
        hp: adjustedPool.hp + extraPool.hp,
      };
    };

    // 原版 L3320-L3347：逆转力场不承受伤害，也不能替驾驶员挡伤害。
    // 贯穿抵抗仍发生在此前的原版位置，因此只在抵抗触发时从玩家三池中移除贯穿额外伤害。
    if (hasVehicle && reverseField) {
      if (terrainValue === 1) {
        const lethalPool: PoolDamage = {
          shield: Math.max(0, Number(victim.shield || 0)),
          armor: Math.max(0, Number(victim.armor || 0)),
          hp: Math.max(0, Number(victim.hp || 0)),
        };
        await persistVehicle();
        await persistAttackerMarkers();
        return { damageToPlayer: sumPool(lethalPool), poolDamage: lethalPool };
      }
      const playerPool = poolFromRemaining();
      await persistVehicle();
      await persistAttackerMarkers();
      return { damageToPlayer: sumPool(playerPool), poolDamage: playerPool };
    }

    if (!hasVehicle) {
      await persistAttackerMarkers();
      if (terrainValue === 1) {
        // 原版 L3518-L3526：载具已失效且“阵地”熟练度为1时，四层穿透设为200并追加四属性必杀伤害。
        attackerBonus.生命穿透 = 200;
        attackerBonus.护盾穿透 = 200;
        attackerBonus.装甲穿透 = 200;
        const lethalPool: PoolDamage = {
          shield: Math.max(0, Number(victim.shield || 0)),
          armor: Math.max(0, Number(victim.armor || 0)),
          hp: Math.max(0, Number(victim.hp || 0)),
        };
        return { damageToPlayer: sumPool(lethalPool), poolDamage: lethalPool };
      }
      const playerPool = poolFromRemaining();
      return { damageToPlayer: sumPool(playerPool), poolDamage: playerPool };
    }

    // 涂层只影响仍然进入载具承伤阶段的攻击；逆转力场已在上面提前返回。
    const coating = this.getVehicleCoating(vehicle, vehicleParts);
    const coatingFactor = coating > 0 ? 0.05 : 1;
    const applyCoating = (b: DamageBreakdown): DamageBreakdown => {
      if (coating === 1) return { physical: b.physical * 0.05, fire: b.fire, ice: b.ice, elec: b.elec };
      if (coating === 2) return { physical: b.physical, fire: b.fire * 0.05, ice: b.ice, elec: b.elec };
      if (coating === 3) return { physical: b.physical, fire: b.fire, ice: b.ice * 0.05, elec: b.elec };
      if (coating === 4) return { physical: b.physical, fire: b.fire, ice: b.ice, elec: b.elec * 0.05 };
      return b;
    };
    remaining = applyCoating(remaining);
    extraBreakdown = {
      shield: applyCoating(extraBreakdown.shield),
      armor: applyCoating(extraBreakdown.armor),
      life: applyCoating(extraBreakdown.life),
    };
    if (hasBreakdown(extraBreakdown.shield) || hasBreakdown(extraBreakdown.armor) || hasBreakdown(extraBreakdown.life)) {
      extraPool = {
        shield: Math.min(sumBreakdown(extraBreakdown.shield), Math.max(0, Number(victim.shield || 0))),
        armor: Math.min(sumBreakdown(extraBreakdown.armor), Math.max(0, Number(victim.armor || 0))),
        hp: Math.min(sumBreakdown(extraBreakdown.life), Math.max(0, Number(victim.hp || 0))),
      };
    } else if (coating > 0) {
      extraPool = scalePool(extraPool, coatingFactor);
    }

    let vehicleDamage = 0;
    const remainingDamage = Math.max(0, sumBreakdown(remaining));

    // 原版 L3357-L3366：虹天剑首次命中载具走专用分支；虹a冷却期间走普通承伤。
    const rainbowOnCooldown = (attacker.specialSeq ?? 0) === -9
      ? this.combatState.timeIntervalRequire('虹a', 120, attackerMarkers, nowMs, { value: '' }, nowMs)
      : false;
    if (forceVehicleDamage) {
      // 阵地/地精攻击载具时跳过普通载具伤害上限，但仍经过涂层、贯穿和损控前置。
      vehicleDamage = remainingDamage;
    } else if ((attacker.specialSeq ?? 0) === -9 && !rainbowOnCooldown) {
      const vehicleMaxHp = Number(
        vehicle?.bonus?.生命 ?? vehicle?.加成?.生命 ?? vehicle?.maxHp ?? vehicle?.最大生命 ?? currentHp,
      );
      vehicleDamage = Math.max(0, vehicleMaxHp / 2);
      attackerMarkersChanged = true;
      lines.push(`(虹天剑${Math.floor(vehicleDamage)})`);
    } else {
      // 原版 L3367-L3447：先过损伤控制/福音书，再把普通承伤固定为0/1/2。
      if (remainingDamage > 0 && remainingDamage >= 0.05 * status) {
        if (hasPart('损伤控制系统A')) {
          const cooldown = hasPart('损伤控制系统强化') ? 35 : 60;
          if (!this.combatState.timeIntervalRequire('sk0', cooldown, vehicleMarkers, nowMs, { value: '' }, nowMs)) {
            this.combatState.gainBuff(vehicleMarkers, 'sk1', 5, false, nowMs, 0);
            vehicleChanged = true;
          }
        } else if (hasPart('损伤控制系统B')) {
          const cooldown = hasPart('损伤控制系统强化') ? 25 : 50;
          if (!this.combatState.timeIntervalRequire('sk0', cooldown, vehicleMarkers, nowMs, { value: '' }, nowMs)) {
            this.combatState.gainBuff(vehicleMarkers, 'sk1', 5, false, nowMs, 0);
            vehicleChanged = true;
          }
        } else if (hasPart('损伤控制系统C')) {
          const cooldown = hasPart('损伤控制系统强化') ? 15 : 40;
          if (!this.combatState.timeIntervalRequire('sk0', cooldown, vehicleMarkers, nowMs, { value: '' }, nowMs)) {
            this.combatState.gainBuff(vehicleMarkers, 'sk1', 5, false, nowMs, 0);
            vehicleChanged = true;
          }
        } else {
          const sets = this.playerService.safeJsonParse<any>(victim.sets, {});
          const sakuraHits = Number(sets['小樱命中次数'] ?? sets.sakuraHits ?? 0);
          const sleepover = Number(sets['陪睡'] ?? sets.sleepover ?? 0);
          if (sakuraHits > 0 && sakuraHits < 5 && sleepover > 7 &&
              !this.combatState.timeIntervalRequire('sk0', 60, vehicleMarkers, nowMs, { value: '' }, nowMs)) {
            this.combatState.gainBuff(vehicleMarkers, 'sk1', 2, false, nowMs, 0);
            vehicleChanged = true;
          }
        }

        const sk1Text = { value: 0 };
        const sk1Time = { value: 0 };
        const hasSk1 = this.combatState.buffRequire('sk1', vehicleMarkers, sk1Text, nowMs, sk1Time);
        if (!hasSk1 && hasPart('福音书系统')) {
          const gospelCdText = { value: 0 };
          if (!this.combatState.buffRequire('福音cd', victimMarkers, gospelCdText, nowMs, { value: 0 })) {
            const gospelStrength = this.combatState.gainBuff(victimMarkers, '福ys', 600, false, nowMs, 1, true);
            victim.markers2 = JSON.stringify(victimMarkers);
            vehicleDamage = 1;
            extraPool = zeroPool();
            if (gospelStrength >= 5) {
              this.combatState.gainBuff(victimMarkers, '福音cd', 3600, false, nowMs);
              lines.push('【福音书过载】');
            } else {
              lines.push(`【福音书${gospelStrength}】`);
            }
            victim.markers2 = JSON.stringify(victimMarkers);
          }
        }

        const remainingSk1 = { value: 0 };
        const remainingSk1Time = { value: 0 };
        if (this.combatState.buffRequire('sk1', vehicleMarkers, remainingSk1, nowMs, remainingSk1Time)) {
          vehicleDamage = 0;
          extraPool = zeroPool();
          lines.push(`【损控${Math.ceil(remainingSk1Time.value)}秒】`);
        } else if (vehicleDamage === 0) {
          if (remainingDamage < 0.05 * status) {
            lines.push(`(伤害过低未破防:${Math.floor(remainingDamage)})`);
            vehicleDamage = 0;
          } else {
            vehicleDamage = remainingDamage / 2 > status ? 2 : 1;
            if ((attacker.specialSeq ?? 0) === 24 && Number(attacker.affinity || 0) >= 40) {
              const skillLevel = Number(attacker.skillLevel ?? (
                              attacker.type
                                ? this.skillLevelFromMarkers(this.normalizeMarkerObject(attacker.markers), attacker.type)
                                : 0
              ));
              vehicleDamage *= 1.5 + skillLevel * 0.025;
            }
            const effect = attacker.weaponEffect ?? attacker.specialEffect ?? attacker.effect ?? attacker.特效;
            if (Number(effect) === 46) {
              vehicleDamage *= 1.25 + Math.random() * 0.25;
            }
          }
        }
      }
    }

    // 原版 L3472-L3484：觉醒300的防御方对负特殊序号攻击方有33%减半，
    // 随后阿尔缇娜载具伤害再次乘倍率。
    const victimMarkersObject = this.normalizeMarkerObject(victim.markers);
    const awakening = Number(victimMarkersObject['觉醒'] || 0);
    if ((attacker.specialSeq ?? 0) < -1 && awakening >= 300 && Math.random() * 100 < 33) {
      vehicleDamage /= 2;
      lines.push('(天地同辉)');
    }
    if (hasVehicle && (attacker.specialSeq ?? 0) === 7) {
      vehicleDamage *= altinaMultiplier;
    }

    vehicleDamage = Math.min(Math.max(0, vehicleDamage), currentHp);
    const afterVehicle = Math.max(0, currentHp - vehicleDamage);
    vehicle.currentHp = afterVehicle;
    vehicle.当前生命 = afterVehicle;
    vehicleChanged = true;
    lines.push(`${vehicle.name || vehicle.名称 || '载具'}生命-${Math.floor(vehicleDamage)}(${Math.floor(afterVehicle)})`);

    // 载具承伤分支结束时清空普通剩余四属性；只把额外三池伤害交给驾驶员。
    const playerPool = copyPool(extraPool);
    await persistVehicle();
    if ((attacker.specialSeq ?? 0) === -9) attackerMarkersChanged = true;
    await persistAttackerMarkers();
    return { damageToPlayer: sumPool(playerPool), poolDamage: playerPool };
  }

  /** 读取载具零件名称，兼容英文/中文字段和内置零件数组。 */
  private getVehiclePartNames(vehicle: any): string[] {
    if (!vehicle) return [];
    const parse = (value: any): any[] => Array.isArray(value)
      ? value
      : this.playerService.safeJsonParse<any[]>(value, []);
    const names: string[] = [];
    const visit = (part: any): void => {
      if (!part) return;
      const name = String(part.name ?? part.名称 ?? '');
      if (name) names.push(name);
      for (const inner of parse(part.builtinParts ?? part.内置零件 ?? part.builtin ?? part.内置)) visit(inner);
    };
    for (const part of parse(vehicle.parts ?? vehicle.零件)) visit(part);
    for (const part of parse(vehicle.builtinParts ?? vehicle.内置零件)) visit(part);
    return names;
  }

  /** 载具涂层类型：物理=1、火焰=2、冰冻=3、雷电=4（@Constant.ecode L277-L280）。 */
  private getVehicleCoating(vehicle: any, partNames: string[]): number {
    const raw = Number(vehicle?.coating ?? vehicle?.涂层 ?? 0);
    if (raw >= 1 && raw <= 4) return raw;
    if (partNames.includes('坚固涂层')) return CombatSystemService.DMG_PHYS;
    if (partNames.includes('耐热涂层')) return CombatSystemService.DMG_FIRE;
    if (partNames.includes('耐寒涂层')) return CombatSystemService.DMG_ICE;
    if (partNames.includes('电阻涂层')) return CombatSystemService.DMG_ELEC;
    return 0;
  }

  /**
   * 炮击 - 载具炮台攻击
   * 对应原版：炮击()
   * 对应 _主程序.ecode L800-L950：校验炮击模式/载具/武器/目标地图后，
   * 调用完整 武器攻击() 结算，而不是另造一套简化伤害公式。
   */
  async cannonAttack(userId: number, targetMapName = ''): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const targetName = targetMapName.trim();

    // 原版 L808：炮击没有参数时只提示使用格式，不进入载具/死亡判断。
    if (!targetName) {
      return `${player.name}“炮击飞龙谷”来使用`;
    }

    const parse = <T>(value: any, fallback: T): T => {
      if (value === null || value === undefined) return fallback;
      if (typeof value !== 'string') return value as T;
      try {
        const parsed = JSON.parse(value);
        return (parsed === null ? fallback : parsed) as T;
      } catch {
        return fallback;
      }
    };

    const currentMap = await this.mapService.getMapById(player.mapId);
    if (!currentMap) return '你不在任何地图上！';

    // 原版 取载具(玩家.载具, 当前地图)；同时兼容已经迁移到 GameVehicle 表的载具。
    const vehicleSource = await this.findCannonVehicle(player, currentMap, parse);
    const vehicle = vehicleSource?.vehicle;
    const partNames = this.getVehiclePartNames(vehicle);
    const sets = parse<any>(player.sets, {});
    const attackMode = Number(player.attackMode ?? sets.attackMode ?? sets.攻击模式 ?? 0);

    // 原版 L812-L829：先计算炮台 b 值，随后又用攻击模式分支无条件覆盖 b。
    // 这是原版疑似冗余/笔误：即使载具装有舰炮，攻击模式不是1时仍会被覆盖为0，按原版保留。
    let cannonMode = 0;
    if (vehicle) {
      if (partNames.includes('和平鸽')) cannonMode = 4;
      if (partNames.includes('平定者')) cannonMode = 4;
      if (partNames.includes('京兆巨炮')) cannonMode = 3;
      if (partNames.includes('速子光矛')) cannonMode = 4;
      if (partNames.includes('虹天剑A')) cannonMode = 2;
      if (attackMode === 1) cannonMode = 1;
      else cannonMode = 0;
    }
    // 原版 L826-L830 的覆盖分支在载具存在与否之外再次执行。
    if (attackMode === 1) cannonMode = 1;
    else cannonMode = 0;

    if (cannonMode === 0) {
      return `${player.name}需要切换为炮击模式，或者驾驶安装了舰炮的载具\n1、转换  2、架炮`;
    }

    if (vehicle && Number(vehicle.currentHp ?? vehicle.当前生命 ?? 0) === 0) {
      return `${player.name}载具需要“维修”`;
    }

    const weapons = parse<any[]>(player.weapons, []);
    const weaponIndex = Number(player.currentWeapon || 0);
    const weapon = weaponIndex > 0
      ? (weapons[weaponIndex - 1] || weapons[weaponIndex] || {})
      : {};
    const weaponName = String(weapon.name ?? weapon.名称 ?? '拳头');
    const weaponType = String(weapon.type ?? weapon.类型 ?? '近战武器');

    if (weaponIndex === 0) {
      return `${player.name}拳头无法射出去`;
    }
    if (weaponType === '近战武器' || weaponType.includes('近战')) {
      return `${player.name}近战武器无法射出去`;
    }

    const markers = parse<Record<string, number>>(playerData.markers ?? player.markers, {});
    if (weaponName === '管风琴' && Number(markers.管风琴 || 0) <= 0) {
      return `${player.name},管风琴没有弹药了,需要“装填”`;
    }

    let targetMap: any;
    try {
      targetMap = await this.mapService.getMapByName(targetName);
    } catch {
      targetMap = null;
    }
    if (!targetMap) {
      return `${player.name}${targetName}在地图列表不存在`;
    }

    // b=2/3 时原版允许跨复活点；由于上面的原版覆盖分支，正常路径为 b=1。
    const currentRespawn = currentMap.respawnPoint ?? currentMap.复活点 ?? '';
    const targetRespawn = targetMap.respawnPoint ?? targetMap.复活点 ?? '';
    if (cannonMode !== 2 && cannonMode !== 3 && currentRespawn !== targetRespawn) {
      return `${player.name}当前地图${currentMap.name}(${currentRespawn}附近)无法炮击处于${targetRespawn}附近的目标`;
    }

    const monsters = await this.mapService.getMapMonsters(targetMap);
    if (monsters.length === 0) {
      return `${player.name}${targetMap.name}没有目标`;
    }

    const now = Date.now();
    const markers2 = parse<any[]>(player.markers2, []);
    const featherCount = Number(
      player.specialSeq === 3 ? this.getFeather(player, markers, now) : 0,
    );
    const hasFeatherLimit = player.specialSeq === 3 && featherCount >= 10;
    const hasFastLoader = partNames.includes('高速装弹机');
    const fastLoaderLevel = Number(markers.高速1 || 0);
    const cooldownFactor = hasFeatherLimit
      ? 0
      : hasFastLoader
        ? (fastLoaderLevel === 2 ? 2.5 : 0)
        : 1;
    const cooldownSeconds = (Number(weapon.cooldown ?? weapon.冷却 ?? 5) || 5) * 1.5 * cooldownFactor;
    const cooldownEntry = markers2.find((item: any) =>
      item?.name === `${weaponName}冷却` && Number(item.expireAt ?? item.expireTime ?? 0) > now,
    );
    if (cooldownEntry) {
      const remaining = Math.max(1, Math.ceil((Number(cooldownEntry.expireAt ?? cooldownEntry.expireTime) - now) / 1000));
      return `${player.name}${weaponName}攻击冷却中，还需要${remaining}秒`;
    }
    markers2.splice(0, markers2.length, ...markers2.filter((item: any) => item?.name !== `${weaponName}冷却`));
    if (cooldownSeconds > 0) {
      markers2.push({ name: `${weaponName}冷却`, expireAt: now + cooldownSeconds * 1000 });
    }

    let prefix = '';
    if (hasFastLoader) {
      if (fastLoaderLevel !== 2) {
        markers.高速1 = fastLoaderLevel + 1;
        prefix = `（装弹机2）`;
      } else {
        markers.高速1 = 0;
        prefix = '（装弹机装填）';
      }
    }
    if (hasFeatherLimit) {
      this.getFeather(player, markers, now, 10);
      prefix += `（羽毛${featherCount}）`;
    }
    player.markers = JSON.stringify(markers);
    player.markers2 = JSON.stringify(markers2);
    // weaponAttack 会重新读取玩家；先持久化炮击前置消耗和冷却，避免新旧 PlayerData 覆盖。
    await this.playerService.savePlayer(player);

    const attack = await this.weaponAttack(userId, weaponIndex, {
      noDelay: true,
      allAttack: false,
      attackText: cannonMode === 3 ? '京兆巨炮a' : '远程炮击',
      damageMultiplier: 100,
      targetMapId: targetMap.id,
      originalTimestamp: now,
    });

    // 原版 L925-L932：炮击后记录成就、活动标记和活跃度；地图标记用当前项目的 markers2 表达。
    await this.achievementService.addAchievement(player, '炮击', 1);
    const targetMarkers2 = parse<any[]>(targetMap.markers2, []);
    const activeEntry = targetMarkers2.find((item: any) => item?.name === '活动');
    if (activeEntry) activeEntry.expireAt = now + 60 * 1000;
    else targetMarkers2.push({ name: '活动', expireAt: now + 60 * 1000 });
    await this.mapService.updateDynamicFields(targetMap.id, { markers2: JSON.stringify(targetMarkers2) });

    // 原版 L918-L923：若炮击载具带有脏弹，则消耗一枚并污染目标地图120秒。
    const dirtyBomb = this.findVehiclePart(vehicle, '脏弹', parse);
    if (dirtyBomb && Number(dirtyBomb.quantity ?? dirtyBomb.数量 ?? 0) >= 1) {
      const count = Number(dirtyBomb.quantity ?? dirtyBomb.数量) - 1;
      if (dirtyBomb.quantity !== undefined) dirtyBomb.quantity = count;
      if (dirtyBomb.数量 !== undefined) dirtyBomb.数量 = count;
      await this.persistCannonVehicle(vehicleSource, parse);
      const polluted = parse<any[]>(targetMap.markers2, []);
      polluted.push({ name: '脏弹', value: 120, expireAt: now + 120 * 1000 });
      await this.mapService.updateDynamicFields(targetMap.id, { markers2: JSON.stringify(polluted) });
      return `${prefix}${attack.result}\n脏弹里面装载的核废料污染了${targetMap.name}`;
    }

    return prefix ? `${prefix}${attack.result}` : attack.result;
  }

  /** 炮击载具查找：当前地图 JSON 优先，兼容 GameVehicle 表及中英文旧字段。 */
  private async findCannonVehicle(
    player: any,
    map: any,
    parse: <T>(value: any, fallback: T) => T,
  ): Promise<{ kind: 'map' | 'db'; map: any; index?: number; db?: any; vehicle: any } | null> {
    const key = String(player.vehicle ?? '');
    const vehicles = parse<any[]>(map.vehicles, []);
    const index = vehicles.findIndex((item: any) => [item?.id, item?.编号, item?.vehicleId, item?.name, item?.名称]
      .filter((value: any) => value !== undefined && value !== null)
      .map(String)
      .includes(key));
    if (index >= 0) return { kind: 'map', map, index, vehicle: vehicles[index] };

    const gameVehicle = (this.prisma as any).gameVehicle;
    if (!gameVehicle || !key) return null;
    const numericId = Number(key);
    let db = Number.isInteger(numericId) && numericId > 0
      ? await gameVehicle.findUnique({ where: { id: numericId } })
      : null;
    if (!db) {
      db = await gameVehicle.findFirst({ where: { OR: [{ vehicleId: key }, { name: key }] } });
    }
    if (!db) return null;
    const mapKeys = [map.id, map.mapIndex].filter((value: any) => value !== undefined && value !== null).map(String);
    if (Number(db.mapIndex || 0) > 0 && !mapKeys.includes(String(db.mapIndex))) return null;
    return { kind: 'db', map, db, vehicle: db };
  }

  private findVehiclePart(
    vehicle: any,
    name: string,
    parse: <T>(value: any, fallback: T) => T,
  ): any | null {
    const parts: any[] = parse<any[]>(vehicle?.parts ?? vehicle?.零件, []);
    // DB 载具的 parts 通常是字符串；把解析后的数组挂回运行时对象，
    // 使炮击后的脏弹消耗能够由 persistCannonVehicle 写回。
    if (vehicle && typeof vehicle.parts === 'string') vehicle.parts = parts;
    if (vehicle && typeof vehicle.零件 === 'string') vehicle.零件 = parts;
    const visit = (part: any): any => {
      if (!part) return null;
      if (String(part.name ?? part.名称 ?? '') === name) return part;
      for (const nested of parse<any[]>(part.builtinParts ?? part.内置零件 ?? part.builtin ?? part.内置, [])) {
        const found = visit(nested);
        if (found) return found;
      }
      return null;
    };
    for (const part of parts) {
      const found = visit(part);
      if (found) return found;
    }
    return null;
  }

  private async persistCannonVehicle(
    source: { kind: 'map' | 'db'; map: any; index?: number; db?: any; vehicle: any } | null,
    parse: <T>(value: any, fallback: T) => T,
  ): Promise<void> {
    if (!source) return;
    if (source.kind === 'db' && source.db) {
      const stored = source.vehicle;
      await (this.prisma as any).gameVehicle.update({
        where: { id: source.db.id },
        data: {
          parts: JSON.stringify(parse<any[]>(stored.parts ?? stored.零件, [])),
        },
      });
      return;
    }
    if (source.index === undefined) return;
    const vehicles = parse<any[]>(source.map.vehicles, []);
    vehicles[source.index] = source.vehicle;
    await this.mapService.updateDynamicFields(source.map.id, { vehicles: JSON.stringify(vehicles) });
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
      /** 套装增幅器=5：贯穿时追加侵彻伤害（原版 L3266-3284） */
      amplifier5?: boolean;
      /** 武器自带麻醉值（原版 z1.自带.麻醉；增幅器5需检查为0才触发侵彻） */
      weaponAnesthesia?: number;
      /** 三段评级熟练度值（可读写，用于累加熟练度并计算倍率加成） */
      mastery?: { 致命?: number; 强力?: number; 正中?: number; 擦过?: number; 描边?: number };
      /** 防御方装备列表；生命/装甲/护盾增强器按 L3166-L3172 顺序判断 */
      defenderEquipment?: Array<{ specialSeq?: number; name?: string; 特殊序号?: number; 名称?: string }>;
      /** 防御方标记对象（猩红熟练度读写，吸血姬真伤释放判定用） */
      defenderMarkers?: Record<string, any> | null;
      /** 防御方增益数组（判断猩红增益是否活跃） */
      defenderBuffs?: any[];
    },
  ): DamageResult {
    // 1. 计算基础攻击力 = 攻击力 + 武器伤害 + 元素伤害
    const sumBreakdown = (b: DamageBreakdown): number => b.physical + b.fire + b.ice + b.elec;
    const baseAttack = (atkBonus.攻击 || 0) + (atkBonus.攻击2 || 0) + (weapon.damage || 0);

    // 2. 各属性伤害 = 基础攻击力 × 武器属性系数
    const weaponProps = weapon.properties || { phys: 100, fire: 0, ice: 0, elec: 0 };
    const rawBreakdown: DamageBreakdown = {
      physical: baseAttack * weaponProps.phys / 100 + (atkBonus.物伤 || 0) + (atkBonus.物伤2 || 0),
      fire: baseAttack * weaponProps.fire / 100 + (atkBonus.火伤 || 0) + (atkBonus.火伤2 || 0),
      ice: baseAttack * weaponProps.ice / 100 + (atkBonus.冰伤 || 0) + (atkBonus.冰伤2 || 0),
      elec: baseAttack * weaponProps.elec / 100 + (atkBonus.电伤 || 0) + (atkBonus.电伤2 || 0),
    };

    // 3. 基础伤害倍率（对应原版"暴击倍率"，实为总伤害倍率）：
    //    L2274-2278：暴击倍率 = 攻击方命中 / 防御方闪避（闪避<1 则 /1）
    const hitVal = (atkBonus.命中 || 0) + (atkBonus.命中2 || 0) || 100;
    const dodgeVal = (defBonus.闪避 || 0) + (defBonus.闪避2 || 0);
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
      critMultiplier = (atkBonus.暴击伤害 || 150) / 100;
      dmgMult = dmgMult * critMultiplier;
    }

    // 9. 等级差距修正（原版 L3290-3297：剩余伤害 /(1-攻击差距) ×(1-防御差距)）
    //    此处攻击方差距 gap 为正表示"攻击方等级低于目标"，应降低伤害 → 用 1/(1-gap) 放大分母实现降伤
    const levelGap = (atkBonus.世界等级差距 || 0);
    const levelFactor = levelGap >= 1 ? 0.1 : Math.max(0.1, 1 / (1 - levelGap));

    // 10. 易伤加成（原版 L3162-3165：剩余X伤 ×(1+易伤/100)）
    const vulnerability = (defBonus.减益 || 0) / 100 + 1;

    // 11. 应用所有修正，计算各属性最终伤害
    const finalBreakdown: DamageBreakdown = {
      physical: rawBreakdown.physical * dmgMult * levelFactor * vulnerability,
      fire: rawBreakdown.fire * dmgMult * levelFactor * vulnerability,
      ice: rawBreakdown.ice * dmgMult * levelFactor * vulnerability,
      elec: rawBreakdown.elec * dmgMult * levelFactor * vulnerability,
    };

    // 11.5 防御方增强器：先改写防御方抗性，再进入三层抗穿流程。
    let enhancerEffectText = '';
    const defenderEquipment = opts?.defenderEquipment || [];
    if (defenderEquipment.some((item) =>
      item.specialSeq === 55
      || item.特殊序号 === 55
      || (item.name || item.名称) === '生命增强器')) {
      enhancerEffectText = this.bonusService.enhancer(
        defBonus, 3, finalBreakdown.physical, finalBreakdown.fire,
        finalBreakdown.ice, finalBreakdown.elec, 20, enhancerEffectText,
      );
    } else if (defenderEquipment.some((item) =>
      item.specialSeq === 56
      || item.特殊序号 === 56
      || (item.name || item.名称) === '装甲增强器')) {
      enhancerEffectText = this.bonusService.enhancer(
        defBonus, 2, finalBreakdown.physical, finalBreakdown.fire,
        finalBreakdown.ice, finalBreakdown.elec, 20, enhancerEffectText,
      );
    } else if (defenderEquipment.some((item) =>
      item.specialSeq === 57
      || item.特殊序号 === 57
      || (item.name || item.名称) === '护盾增强器')) {
      enhancerEffectText = this.bonusService.enhancer(
        defBonus, 1, finalBreakdown.physical, finalBreakdown.fire,
        finalBreakdown.ice, finalBreakdown.elec, 20, enhancerEffectText,
      );
    }

    // 12. 三层池独立抗性减免（护盾/装甲/生命各自抗穿）
    const penetration = this.getPenetration(atkBonus);
    const resistBreakdown = this.applyResistances(finalBreakdown, defBonus, penetration);

    // 12.5 贯穿几率判断（对应原版 L3192-3288）
    // 原版：几率判断(攻击方.贯穿 - 防御方.抗贯穿) 百分比判定；
    // 触发后按目标当前护盾/装甲状态，把部分剩余伤害"跳过当前池直接注入更深层池"：
    //   - 只有护盾 或 只有装甲：额外生命伤害 = 剩余×0.3，剩余×0.7走正常流程
    //   - 护盾+装甲都有：额外生命×0.1、额外装甲×0.2、剩余×0.7
    const penetrateRatio = (atkBonus.贯穿 || 0) - (defBonus.抗贯穿 || 0);
    const emptyBreakdown = (): DamageBreakdown => ({ physical: 0, fire: 0, ice: 0, elec: 0 });
    const scaleBreakdown = (b: DamageBreakdown, ratio: number): DamageBreakdown => ({
      physical: b.physical * ratio,
      fire: b.fire * ratio,
      ice: b.ice * ratio,
      elec: b.elec * ratio,
    });
    let pierce = { directLife: 0, directArmor: 0, directShield: 0 };
    let pierceBreakdown = {
      shield: emptyBreakdown(),
      armor: emptyBreakdown(),
      life: emptyBreakdown(),
    };
    const penetrated = penetrateRatio > 0 && Math.random() * 100 < penetrateRatio;
    if (penetrated) {
      const hasShield = (defBonus.护盾 || 0) > 0;
      const hasArmor = (defBonus.装甲 || 0) > 0;
      if (hasShield && hasArmor) {
        // 护盾1装甲1：额外生命=剩余×0.1、额外装甲=剩余×0.2
        const total = sumBreakdown(resistBreakdown.shield);
        pierce = { directLife: total * 0.1, directArmor: total * 0.2, directShield: 0 };
        pierceBreakdown = {
          shield: emptyBreakdown(),
          armor: scaleBreakdown(resistBreakdown.shield, 0.2),
          life: scaleBreakdown(resistBreakdown.shield, 0.1),
        };
      } else if (hasShield || hasArmor) {
        // 护盾1装甲0 / 护盾0装甲1：额外生命=剩余×0.3
        const total = sumBreakdown(resistBreakdown.shield);
        pierce = { directLife: total * 0.3, directArmor: 0, directShield: 0 };
        pierceBreakdown = {
          shield: emptyBreakdown(),
          armor: emptyBreakdown(),
          life: scaleBreakdown(resistBreakdown.shield, 0.3),
        };
      }
    }

    // 12.6 侵彻（对应原版 战斗相关.ecode L3266-3284）
    // 原版条件：攻击方.套装.增幅器==5 且 z1.自带.麻醉==0 且 伤害倍率!=0 且 已贯穿
    // 效果：按防御方三池上限的0.005×倍率追加四属性额外伤害到对应池
    let penetrateText = '';
    if (penetrated && opts?.amplifier5 && (opts?.weaponAnesthesia ?? 0) === 0 && dmgMult !== 0) {
      const defHp = defBonus.生命 || 0;
      const defArmor = defBonus.装甲 || 0;
      const defShield = defBonus.护盾 || 0;
      const totalPenetrate = (defHp * 0.02 + defArmor * 0.02 + defShield * 0.02) * dmgMult;
      // 追加额外四属性伤害到贯穿breakdown（原版 L3269-3280）
      const hpAdd = defHp * 0.005 * dmgMult;
      const armorAdd = defArmor * 0.005 * dmgMult;
      const shieldAdd = defShield * 0.005 * dmgMult;
      pierceBreakdown.life = {
        physical: pierceBreakdown.life.physical + hpAdd,
        fire: pierceBreakdown.life.fire + hpAdd,
        ice: pierceBreakdown.life.ice + hpAdd,
        elec: pierceBreakdown.life.elec + hpAdd,
      };
      pierceBreakdown.armor = {
        physical: pierceBreakdown.armor.physical + armorAdd,
        fire: pierceBreakdown.armor.fire + armorAdd,
        ice: pierceBreakdown.armor.ice + armorAdd,
        elec: pierceBreakdown.armor.elec + armorAdd,
      };
      pierceBreakdown.shield = {
        physical: pierceBreakdown.shield.physical + shieldAdd,
        fire: pierceBreakdown.shield.fire + shieldAdd,
        ice: pierceBreakdown.shield.ice + shieldAdd,
        elec: pierceBreakdown.shield.elec + shieldAdd,
      };
      // 重算 pierce 直接伤害值（汇总追加后的四属性总额）
      pierce.directLife = sumBreakdown(pierceBreakdown.life);
      pierce.directArmor = sumBreakdown(pierceBreakdown.armor);
      pierce.directShield = sumBreakdown(pierceBreakdown.shield);
      penetrateText = `（侵彻${Math.round(totalPenetrate)})`;
    }

    // 吸血姬猩红真伤释放（战斗相关.ecode L4093-4110）：
    // 防御方有"猩红"熟练度且当前无活跃猩红增益 → 本次攻击附加等额真伤（三池结转），
    // 上限=防御方当前三池总和（L4101-4103），随后熟练度清零（L4109）。
    let vampireTrueText = '';
    const vampireTrue: { value: number } = { value: 0 };
    if (opts?.defenderMarkers) {
      const prof = Number(opts.defenderMarkers['猩红'] ?? 0);
      if (prof > 0) {
        const nowMsVtd = Date.now();
        const hasScarletBuff = (opts?.defenderBuffs || []).some((b: any) => {
          if (!b) return false;
          if ((b.名称 ?? b.name) !== '猩红') return false;
          const rawExpire = Number(b.有效期至 ?? b.expireAt ?? 0);
          const expireMs = rawExpire > 0 && rawExpire < 1e12 ? rawExpire * 1000 : rawExpire;
          return expireMs > nowMsVtd;
        });
        if (!hasScarletBuff) {
          const totalState = (defBonus.生命 || 0) + (defBonus.装甲 || 0) + (defBonus.护盾 || 0);
          vampireTrue.value = Math.min(prof, totalState);
          vampireTrueText = `（猩红${Math.round(prof)}）`;
          opts.defenderMarkers['猩红'] = 0; // 原版 置成就熟练度("猩红",标记,0)
        }
      }
    }

    // 13. 三池串行分伤（破盾溢出打装甲，破甲溢出打生命；贯穿跳过池直接注入）
    const poolDamage = this.distributeDamageToPools(resistBreakdown, atkBonus, defBonus, pierce.directLife > 0 || pierce.directArmor > 0 ? pierce : undefined, vampireTrue);

    // 14. 总伤害
    const totalDamage = poolDamage.shield + poolDamage.armor + poolDamage.hp;
    const vehicleExtraPoolDamage: PoolDamage = {
      shield: Math.min(pierce.directShield, Math.max(0, defBonus.护盾 || 0)),
      armor: Math.min(pierce.directArmor, Math.max(0, defBonus.装甲 || 0)),
      hp: Math.min(pierce.directLife, Math.max(0, defBonus.生命 || 0)),
    };

    return {
      damage: Math.max(0, Math.floor(totalDamage)),
      isHit: true,
      isCrit,
      hitRate: hitVal / Math.max(1, dodgeVal) * 100,
      damageBreakdown: finalBreakdown,
      poolDamage,
      critMultiplier,
      rating,
      vehicleBreakdown: resistBreakdown.shield,
      penetrated,
      vehicleExtraPoolDamage,
      vehicleExtraBreakdown: pierceBreakdown,
      effectText: enhancerEffectText + penetrateText + vampireTrueText,
    };
  }

  /**
   * 计算反伤（对应原版 战斗相关.ecode 计算反伤() L4791-4873）
   * 返回防御方应反弹给攻击方的绝对伤害值。
   *
   * 原版逻辑（逐行对照）：
   *   L4806 恶毒好感≥100 且 色欲(30s)未冷却 → 返回 100（即反伤100%）
   *   L4815 军姬好感≥40 且有剑阵增益 → 返回 100
   *   L4824 装备要求(防御方,#荆棘之翼) → 倍率+0.15
   *   L4827 装备要求(防御方,#小鱼发饰) 且 小鱼冷却(60s)未过 → 倍率+2
   *   L4833 军姬2 当前生命>0 且 好感≥40 → 倍率+1+(2+技能等级×0.05)，军姬倍率限制=真
   *   L4844 倍率!=0 时：
   *     z2 = 防御方当前武器（无武器=拳头，物=100）
   *     a2 = Σ(攻击方.属性.四伤 × z1.属性.四/100) × 攻击方.暴击伤害/100 × 攻击方.暴击/100
   *     a2 = a2 × 伤害倍率/100
   *     a1 = Σ(防御方.属性.四伤 × z2.属性.四/100) × 防御方.暴击伤害/100 × 防御方.暴击/100
   *     a3 = 防御方当前生命+装甲+护盾
   *     若 a2×倍率 > a3 则 a2=a3 否则 a2=a2×倍率
   *     a1 = a2/a1×100（攻击方该受伤害占防御方理论伤害的百分比）
   *     最终 += a1
   *     若 军姬倍率限制：a1重取防御方总状态，若 最终 > (2+技能×0.05)×a1 则截断
   *   L4873 返回 最终（百分比）
   *
   * 本框架映射：原版返回的「百分比」按"防御方理论伤害(a1原始)"折算为绝对反伤值返回，
   * 即 绝对反伤 = 防御方理论伤害 × 最终/100，与 calcDamage 调用处直接扣攻击方 hp 的语义一致。
   *
   * @param defender 防御方（PlayerData，含 bonus/属性/武器/好感/技能等级/增益/标记2）
   * @param defenderBonus 防御方最终属性（BonusData）
   * @param attackerBonus 攻击方最终属性（BonusData）
   * @param z1Props 攻击方武器属性系数 {phys,fire,ice,elec}
   * @param z2Props 防御方当前武器属性系数 {phys,fire,ice,elec}（拳头默认全0仅物=100）
   * @param damageMultPct 本次造成伤害倍率（百分比，对应原版 伤害倍率 参数）
   * @param nowSec 当前秒级时间戳
   * @param origTimestamp 原始毫秒时间戳
   * @returns 绝对反伤值（已折算，可直接从攻击方 hp 扣除）
   */
  calcReflectDamage(
    defender: any,
    defenderBonus: BonusData,
    attackerBonus: BonusData,
    z1Props: { phys: number; fire: number; ice: number; elec: number },
    z2Props: { phys: number; fire: number; ice: number; elec: number },
    damageMultPct: number,
    nowSec: number,
    origTimestamp: number,
  ): number {
    const defBuffs: any[] = this.safeParseJson(defender.buffs, []);
    const defMarkers2: any[] = this.safeParseJson(defender.markers2, []);
    const affinity = defender.affinity || 0;
    const seq = defender.specialSeq ?? 0;
    const skillLevel = Number(defender.skillLevel ?? (
      defender.type
        ? this.skillLevelFromMarkers(this.safeParseJson(defender.markers, {}), defender.type)
        : 0
    ));
    const equipments: Array<{ 名称: string; 特殊序号?: number }> = this.safeParseJson(defender.equipments, []);
    const weapons: Array<{ 名称: string; 特殊序号?: number }> = this.safeParseJson(defender.weapons, []);
    const currentWeapon = defender.currentWeapon || 0;

    // L4806 恶毒好感≥100：色欲(30s)冷却未过则反伤100%
    if (affinity >= 100 && seq === 6) {
      // 原版 #恶毒 = 6
      if (this.combatState.timeIntervalRequire('色欲', 30, defMarkers2, origTimestamp, { value: '' }, origTimestamp) === false) {
        return 100; // 原版 返回(100)
      }
    }
    // L4815 军姬好感≥40：有剑阵增益则反伤100%
    if (affinity >= 40 && seq === 16) {
      // 原版 #军姬 = 16
      const a2Ref = { value: 0 };
      if (this.combatState.buffRequire('剑阵', defBuffs, a2Ref, origTimestamp, { value: 0 })) {
        return 100; // 原版 返回(100)
      }
    }
    // L4824 荆棘之翼（#荆棘之翼=18）：倍率+0.15
    let mult = 0.1; // 原版 倍率 默认 0.1
    if (this.combatState.equipRequire(equipments, weapons, currentWeapon, 18, '荆棘之翼', false)) {
      mult += 0.15;
    }
    // L4827 小鱼发饰（#小鱼发饰=35）：小鱼冷却(60s)未过则倍率+2
    if (this.combatState.equipRequire(equipments, weapons, currentWeapon, 35, '小鱼发饰', false)) {
      if (this.combatState.timeIntervalRequire('小鱼冷却', 60, defMarkers2, nowSec, { value: '' }, origTimestamp) === false) {
        mult += 2;
      }
    }
    // L4833 军姬2（#军姬2=24）：当前生命>0 且 好感≥40 → 倍率+1+(2+技能等级×0.05)
    let junjiLimit = false;
    if (seq === 24 && (defender.hp || 0) > 0 && affinity >= 40) {
      mult += 1 + (2 + skillLevel * 0.05);
      junjiLimit = true;
    }

    // L4844 倍率!=0 才进入伤害计算
    if (mult === 0) return 0;

    // L4845 防御方当前武器/拳头（z2）
    let z2Phys = 100, z2Fire = 0, z2Ice = 0, z2Elec = 0;
    if (currentWeapon !== 0) {
      const curW = weapons[currentWeapon - 1] || weapons[currentWeapon];
      if (curW) {
        const props = (curW as any).属性 || (curW as any).properties || { phys: 100, fire: 0, ice: 0, elec: 0 };
        z2Phys = props.phys ?? 100; z2Fire = props.fire ?? 0; z2Ice = props.ice ?? 0; z2Elec = props.elec ?? 0;
      }
    }

    // L4851 a2 = 攻击方理论受伤：Σ(攻击方.属性.四伤 × z1.属性.四/100) × 暴击伤害/100 × 暴击/100
    const a2Raw =
      (attackerBonus.物伤 || 0) * (z1Props.phys || 100) / 100 +
      (attackerBonus.火伤 || 0) * (z1Props.fire || 0) / 100 +
      (attackerBonus.冰伤 || 0) * (z1Props.ice || 0) / 100 +
      (attackerBonus.电伤 || 0) * (z1Props.elec || 0) / 100;
    let a2 = a2Raw * (attackerBonus.暴击伤害 || 150) / 100 * (attackerBonus.暴击 || 5) / 100;
    // L4852 a2 = a2 × 伤害倍率/100
    a2 = a2 * damageMultPct / 100;

    // L4853 a1 = 防御方理论伤害：Σ(防御方.属性.四伤 × z2.属性.四/100) × 暴击伤害/100 × 暴击/100
    const a1Raw =
      (defenderBonus.物伤 || 0) * z2Phys / 100 +
      (defenderBonus.火伤 || 0) * z2Fire / 100 +
      (defenderBonus.冰伤 || 0) * z2Ice / 100 +
      (defenderBonus.电伤 || 0) * z2Elec / 100;
    const a1 = a1Raw * (defenderBonus.暴击伤害 || 150) / 100 * (defenderBonus.暴击 || 5) / 100;

    // L4855 a3 = 防御方当前生命+装甲+护盾
    const a3 = (defender.hp || 0) + (defender.armor || 0) + (defender.shield || 0);
    // L4856 若 a2×倍率 > a3 则 a2=a3（封顶为防御方当前状态），否则 a2=a2×倍率
    if (a2 * mult > a3) {
      a2 = a3;
    } else {
      a2 = a2 * mult;
    }
    // L4862 最终百分比 = a2 / a1 × 100（攻击方应受伤害占防御方理论伤害之比）
    let finalPct = a1 !== 0 ? (a2 / a1) * 100 : 0;
    // L4864 军姬倍率限制：最终 ≤ (2+技能等级×0.05) × 防御方总状态
    if (junjiLimit) {
      const defTotal = (defenderBonus.生命 || 0) + (defenderBonus.装甲 || 0) + (defenderBonus.护盾 || 0);
      const cap = (2 + skillLevel * 0.05) * defTotal;
      if (finalPct > cap) finalPct = cap; // 原版 最终 = cap
    }
    // 原版返回「百分比」，此处折算为绝对反伤值（防御方理论伤害 × 百分比/100），
    // 与 calcDamage 调用处直接扣攻击方 hp 的语义一致。
    return (a1 * finalPct) / 100;
  }

  /**
   * 命中判定
   * 对应原版：a1 = 攻击方.命中/(1-差距)/防御方.闪避；几率判断(a1×100 - 固定闪避 + 最终命中)
   * hitRate 入参已是百分比（由 calcHitRate 计算：atkHit/defDodge*100 + 特效修正），
   * 钳制 [5,95] 后做随机判定。
   */
  checkHit(hitRate: number, dodgeRate: number = 0): boolean {
    // “闪避”技能写入100代表本次攻击必闪；不能被普通命中保底5%覆盖。
    if (dodgeRate >= 100) return false;
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
    const atkHit = (attacker.命中 || 0) + (attacker.命中2 || 0) || 100;
    const defDodge = (defender.dodge || 0) + (defender.dodge2 || 0) || 1;

    // 等级差距修正（原版 L1607-1611）：a1 = 命中/(1-差距)/闪避
    // 新人差距 gap 越大，命中越被放大（新人加成）
    const gap = attacker.世界等级差距 || 0;
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
   * 根据武器信息和伤害类型返回对应的攻击描述（含【名称】【载具】【目标】【武器】占位符，由调用方展开）
   */
  getAttackText(weapon: WeaponData, damageType: number): string {
    if (!weapon) return '拳头攻击';

    // 如果武器有自定义攻击文本，优先使用
    // （兼容两种形态：字符串名称或背包装备实例的 {name:"自动步枪"} 对象）
    if (weapon.attackText) {
      if (typeof weapon.attackText === 'string') return weapon.attackText;
      return String((weapon.attackText as any)?.name ?? (weapon.attackText as any)?.名称 ?? '').trim();
    }

    // 如果武器有攻击文本列表
    if (weapon.attackTexts && weapon.attackTexts.length > 0) {
      const idx = Math.floor(Math.random() * weapon.attackTexts.length);
      return weapon.attackTexts[idx];
    }

    // 无攻击文本配置时按原版语义回落到 文本列表[1]（拳头模板），而不是拼"武器名+物理攻击"
    const fistName = typeof weapon.attackText === 'object'
      ? String((weapon.attackText as any)?.name ?? (weapon.attackText as any)?.名称 ?? '').trim()
      : String(weapon.attackText ?? '').trim();
    const fistTexts = this.getAttackTextTemplates(fistName || '拳头', damageType);
    if (fistTexts.length > 0) {
      return fistTexts[Math.floor(Math.random() * fistTexts.length)];
    }

    // 攻击文本表缺失时的最终兜底
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
   * 取攻击文本模板（对应原版 显示攻击文本() 的文本列表查找 + 分类抽取）
   * @param name 攻击文本名称（如 "拳头"、"自动步枪"）
   * @param type 0未命中 1攻击 2破盾 3破甲 4击杀（5锁定由锁定流程单独处理）
   * @returns 该分类的模板数组；条目缺失返回 []（原版此时输出「[类型N]数组成员为0」提示）
   */
  private getAttackTextTemplates(name: string, type: number): string[] {
    const list = typeof this.staticData?.getAllAttackTexts === 'function'
      ? (this.staticData.getAllAttackTexts() || [])
      : [];
    const entry = list.find((t: any) => t?.name === name);
    if (!entry) return [];
    const fieldByType: Record<number, string> = {
      0: 'missTexts',
      1: 'attackTexts',
      2: 'shieldBreak',
      3: 'armorBreak',
      4: 'killTexts',
      5: 'lockTexts',
    };
    const raw = (entry as any)[fieldByType[type] ?? 'attackTexts'];
    let parsed: any = raw;
    // attack-texts.json 中各分类是 JSON 字符串（"[\"...\"]"），需二次解析
    if (typeof parsed === 'string') parsed = this.safeParseJson<any[]>(raw, []);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string' && x.length > 0) : [];
  }

  /**
   * 展开攻击文本占位符
   * 对应原版 战斗相关.ecode L3975-4010：
   * 【目标】→ 防御方名称、【载具】→ "操纵"+载具名（无载具删除）、【名称】→ 攻击方名称、
   * 【武器】→ 武器名。移植版玩家对战未开放，【名称】不加"(归属玩家)"后缀。
   */
  private expandAttackPlaceholders(
    template: string,
    attackerName: string,
    targetName: string,
    weaponName: string,
    vehicleName?: string,
  ): string {
    let text = template;
    text = text.split('【目标】').join(targetName || '');
    text = text.split('【载具】').join(vehicleName ? `操纵${vehicleName}` : '');
    text = text.split('【名称】').join(attackerName || '');
    text = text.split('【武器】').join(weaponName || '');
    return text;
  }

  /**
   * 解析武器的攻击文本名称
   * 对应原版 z1.攻击文本 即 文本列表 条目：背包装备实例存的是 {name:"自动步枪"} 对象，
   * 静态定义同形；字符串则原样返回。空值回落 '拳头'（原版 文本列表[1]）。
   */
  private resolveAttackTextName(weapon: WeaponData): string {
    const raw: any = weapon?.attackText;
    if (raw && typeof raw === 'object') {
      return String(raw.name ?? raw.名称 ?? '').trim();
    }
    const s = String(raw ?? '').trim();
    // 兼容历史存量：若写入的是整段展示文本（含【占位符】）则无法对应文本列表条目，回落拳头
    if (s && !s.includes('【')) return s;
    return '拳头';
  }

  /**
   * 取攻击方当前驾驶载具名称（用于展开【载具】占位符）
   * 对应原版 载具2.列表编号 != 0 → "操纵"+载具名；无载具时占位符整体删除。
   * 返回 undefined 表示无载具。
   */
  private getAttackerVehicleName(player: any, map: any): string | undefined {
    const vehicleKey = player?.vehicle;
    if (!vehicleKey) return undefined;
    try {
      const vehicles = this.playerService.safeJsonParse<any[]>(map?.vehicles, []);
      const v = vehicles.find((x: any) => x && (
        String(x.id) === String(vehicleKey)
        || String(x.编号) === String(vehicleKey)
        || String(x.vehicleId) === String(vehicleKey)
      ));
      if (!v || Number(v.currentHp ?? v.当前生命 ?? 1) <= 0) return undefined;
      const name = String(v.name ?? v.名称 ?? '').trim();
      return name || undefined;
    } catch {
      return undefined;
    }
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
    vitalityMode: 'normal' | 'sweep' = 'normal',
  ): Promise<MonsterDeathResult> {
    // GameMonster 真实实例先抢占奖励资格，避免两个玩家同时击杀同一实例时
    // 各自扣活力、发经验和发掉落。纯内存测试夹具没有 claim 接口时保持兼容。
    if (
      monster?.id !== undefined
      && typeof (this.mapService as any).claimMapMonster === 'function'
    ) {
      const claimed = await (this.mapService as any).claimMapMonster(mapId, Number(monster.id));
      if (!claimed) {
        return { expGain: 0, drops: [], dropText: '', taskProgress: [], vitalityCost: 0, rewardMultiplier: 1 };
      }
    }

    // 计算经验值
    let expGain = this.calcMonsterExp(monster);

    // 生成掉落物（基础掉落清单，含 name/type/quantity/data）
    let drops = this.generateDrops(monster, 1);

    let vitalityCost = 0;
    let rewardMultiplier = 1;

    // 置掉落（原版 战利品 前序 置掉落 L5245）：记录攻击者对怪物的掉落能力到怪物标记
    // 注意：原版在怪物删除前写怪物.标记，本框架怪物即时删除，此处保留原版调用顺序（行为可见）
    const attackerPlayer = attacker?.player ?? attacker;
    if (attacker) {
      const monsterMarkers = this.playerService.safeJsonParse<any[]>(monster.markers, []);
      monster.markers = JSON.stringify(this.setDrop(attackerPlayer, monsterMarkers));
    }

    // 战利品发放（原版 战斗相关.ecode L4874）：装备展开/资源经验/成就/背包写入/掉落文本。
    // 归属玩家必须在“是否有掉落”之前解析：原版即使没有物品掉落，也会结算经验和活力。
    let dropText = '';
    const taskProgress: Array<{ actionName: string; count: number }> = [];
    let playerData: any;
    if (userId) {
      try {
        playerData = attacker?.player
          ? attacker
          : attacker?.backpack !== undefined && attacker?.userId !== undefined
            ? { player: attacker }
            : await this.playerService.getPlayerData(userId);
      } catch (error: any) {
        this.logger.warn(`读取掉落归属玩家失败: ${error?.message || error}`);
      }
    }
    if (playerData?.player) {
      if (vitalityMode === 'normal' && this.vitalityService) {
        const markers = playerData.markers || this.playerService.safeJsonParse(playerData.player.markers, {});
        const decision = await this.vitalityService.applyNormalKillCost(playerData.player, markers, 1);
        vitalityCost = decision.vitalityCost;
        rewardMultiplier = decision.rewardMultiplier;
        if (rewardMultiplier !== 1) {
          expGain *= rewardMultiplier;
          drops = drops.map((drop: any) => {
            const type = String(drop?.type ?? drop?.类型 ?? '').trim();
            if (type === '装备' || type === 'equipment') return { ...drop };
            const quantity = Number(drop?.quantity ?? drop?.count ?? drop?.数量 ?? 0);
            return { ...drop, quantity: quantity * rewardMultiplier };
          });
        }
        if (vitalityCost > 0) {
          taskProgress.push({ actionName: '消耗活力', count: vitalityCost });
        }
        playerData.player.markers = JSON.stringify(markers);
      }

      if (drops.length > 0) {
        dropText = await this.itemSystem.distributeLoot(playerData, drops, {
          onTaskProgress: (actionName, count) => taskProgress.push({ actionName, count }),
        });
        // 原版“奖励玩家”只在装备宝石缎带时记录稀有掉落：每个已成功
        // 结算且原始几率 <= 1% 的掉落条目计一次，不按装备数量展开。
        const rareCount = drops.filter((drop: any) => {
          const name = String(drop?.name ?? drop?.名称 ?? '').trim();
          const chance = Number(drop?.chance ?? drop?.几率);
          return name && name !== '电力' && Number.isFinite(chance) && chance <= 1;
        }).length;
        if (rareCount > 0 && this.hasGemRibbon(playerData.player)) {
          await this.achievementService.addAchievement(playerData.player, '稀有掉落', rareCount, false);
          taskProgress.push({ actionName: '稀有掉落', count: rareCount });
        }
      }
      // 传入攻击方的 PlayerData 时，掉落直接写入 weaponAttack 使用的同一内存玩家对象。
    }

    // 从地图移除怪物（GameMonster 表，按自增 id 删除；加锁避免并发竞态）
    try {
      await this.mapService.removeMapMonster(mapId, monster.id);
    } catch (error) {
      this.logger.warn(`从地图移除怪物失败: ${error.message}`);
    }

    return { expGain, drops, dropText, taskProgress, vitalityCost, rewardMultiplier };
  }

  /**
   * 原版 战斗相关.ecode L1338-L1349：准备本次攻击的麻醉倍率。
   * 强效麻醉镖只有在数量大于1时才会被消耗，且将麻醉效果提升为2倍。
   */
  private prepareWeaponAnesthesia(
    player: any,
    weapon: WeaponData,
    resultLines: string[],
  ): number {
    const weaponAnesthesia = Number(weapon.self?.anesthesia ?? weapon.anesthesia ?? 0);
    if (weaponAnesthesia <= 0) return 0;

    const backpack = this.playerService.getBackpackItems(player);
    const dart = backpack.find((item: any) => item?.name === '强效麻醉镖');
    const dartCount = Number(dart?.quantity ?? dart?.count ?? 0);
    if (dart && dartCount > 1) {
      if (Object.prototype.hasOwnProperty.call(dart, 'quantity')) dart.quantity = dartCount - 1;
      else dart.count = dartCount - 1;
      player.backpack = JSON.stringify(backpack);
      resultLines.push('【强效麻醉】');
      return 2;
    }
    return 1;
  }

  /** 原版标记2兼容读取：同时支持中文字段和英文存量字段、秒/毫秒时间戳。 */
  private hasActiveMonsterEntry(value: any, name: string, nowMs = Date.now()): boolean {
    const entries = this.safeParseJson<any[]>(value, []);
    return entries.some((entry: any) => {
      const entryName = entry?.名称 ?? entry?.name;
      if (entryName !== name) return false;
      const rawExpire = Number(entry?.有效期至 ?? entry?.expireAt ?? 0);
      const expireAt = rawExpire > 0 && rawExpire < 1e12 ? rawExpire * 1000 : rawExpire;
      return !expireAt || expireAt > nowMs;
    });
  }

  /** 将原版标记数组或当前对象格式统一为可序列化的中文标记对象。 */
  private normalizeMarkerObject(value: any): Record<string, number> {
    const parsed = this.safeParseJson<any>(value, {});
    if (!Array.isArray(parsed)) return parsed && typeof parsed === 'object' ? parsed : {};
    const markers: Record<string, number> = {};
    for (const entry of parsed) {
      const name = entry?.名称 ?? entry?.name;
      if (!name) continue;
      markers[name] = Number(entry?.数值 ?? entry?.value ?? entry?.count ?? 0);
    }
    return markers;
  }

  /**
   * 原版 战斗相关.ecode L3822-L3838：命中后应用武器麻醉，并记录当前玩家的麻醉权限。
   * 当前麻醉和麻醉者标记都写入 GameMonster JSON，兼容存量实例。
   */
  private applyWeaponAnesthesia(
    target: any,
    player: any,
    weapon: WeaponData,
    totalDamage: number,
    anesthesiaEffect: number,
  ): string {
    const weaponAnesthesia = Number(weapon.self?.anesthesia ?? weapon.anesthesia ?? 0);
    if (weaponAnesthesia <= 0 || anesthesiaEffect <= 0 || totalDamage <= 0) return '';

    const bonus = this.safeParseJson<Record<string, any>>(target.bonus, {});
    const baseBonus = this.safeParseJson<Record<string, any>>(target.baseBonus, {});
    const maxAnesthesia = Math.abs(Number(bonus.麻醉 ?? baseBonus.麻醉 ?? 0));
    const baseAnesthesia = Number(baseBonus.麻醉 ?? bonus.麻醉 ?? 0);
    // 原版：基础麻醉为负数的怪物不能用武器麻醉。
    if (baseAnesthesia <= 0 || maxAnesthesia <= 0) return '';

    const current = Math.max(0, Number(bonus.当前麻醉 ?? bonus.currentAnesthesia ?? 0));
    if (current >= maxAnesthesia) return '';

    let multiplier = anesthesiaEffect;
    // 原版 战斗相关.ecode L4249-L4254/L4383-L4388：护盾或装甲当前值超过上限50%时，
    // 麻醉效果分别乘0.6，判定顺序与原版一致。
    if ((target.maxShield || 0) > 0 && (target.shield || 0) / target.maxShield > 0.5) multiplier *= 0.6;
    if ((target.maxArmor || 0) > 0 && (target.armor || 0) / target.maxArmor > 0.5) multiplier *= 0.6;

    const added = totalDamage * weaponAnesthesia / 100 * multiplier;
    if (added <= 0) return '';
    const next = current + added;
    bonus.当前麻醉 = next;
    target.bonus = JSON.stringify(bonus);

    const full = next >= maxAnesthesia;
    if (full) {
      const markers2 = this.safeParseJson<any[]>(target.markers2, []);
      const retained = markers2.filter((entry: any) => (entry?.名称 ?? entry?.name) !== '麻醉');
      retained.push({ 名称: '麻醉', 强度: 0, 有效期至: Date.now() + 3600 * 1000 });
      target.markers2 = JSON.stringify(retained);
    }

    const ownerQQ = String(player.qqNumber ?? player.userId ?? '');
    if (ownerQQ) {
      const markers = this.normalizeMarkerObject(target.markers);
      const ownerKey = `麻醉者${ownerQQ}`;
      markers[ownerKey] = (Number(markers[ownerKey]) || 0) + 1;
      target.markers = JSON.stringify(markers);
    }

    const text = `麻醉+${Math.round(added)}(${Math.round(next)}/${Math.round(maxAnesthesia)})`;
    return full ? `${text}\n${target.name}被麻醉了，现在一小时内可以捕捉` : text;
  }

  /**
   * 光荣弹（对应原版 战斗相关.ecode L4987-5018 子程序 光荣弹）
   *
   * 原版语义：当"死掉的"一方（防御方/攻击方）当前生命<=0 且装备了 #光荣弹(常量44)，
   * 则以其作为攻击方、对"攻击者"发起一次**必中**反击。反击伤害按双方属性比计算总倍率 a1，
   * 再以 a1%（百分比）作为总伤害倍率传入 造成伤害。
   *
   * 本版复刻核心场景：玩家(deadOne)死亡时装备光荣弹 → 必中反击怪物(attacker)。
   * 临时装备 z2：物/电/冰/火 各+25、自带必中、护盾/装甲/生命 穿透各+50、名称"光荣弹"；
   * 攻击文本="光荣弹a"；最终伤害 = 计算伤害 × (a1/100)（对齐原版 造成伤害 第7参 总倍率）。
   *
   * 注：原版攻击者可能是玩家或怪物、死者也可能是玩家或怪物。本版先实现"玩家死→反击怪物"
   * 这一主流路径；"怪物带光荣弹反击玩家"的罕见场景（需怪物装备含 specialSeq=44）待怪物
   * 装备系统补全后接入，此处不阻断主流程。
   *
   * @param deadOne 死者（本版为玩家，作攻击方）
   * @param attacker 攻击者（本版为怪物，作防御方，会被反击伤害）
   * @param playerData 玩家完整数据（含 equipment/bonus/map，供 buildAttackerBonus）
   * @param map 地图对象
   * @param rawTimestamp 原始毫秒时间戳
   * @returns 光荣弹反击文本（含倍率括号），无触发则返回空串
   */
  async gloryGrenade(
    deadOne: any,
    attacker: any,
    playerData: PlayerData,
    map: any,
    rawTimestamp: number,
  ): Promise<string> {
    let text = '';

    // 原版 L4998：死掉的.当前生命 <= 0 才触发（兼容 当前生命/currentHp/hp 三种写法）
    const deadHp = deadOne.当前生命 ?? deadOne.currentHp ?? deadOne.hp ?? 0;
    if (deadHp > 0) return text;

    // 原版 L4999：装备要求(死掉的, #光荣弹) —— 玩家装备数组中 specialSeq===44
    const equipment = Array.isArray(playerData.equipment) ? playerData.equipment : [];
    const hasGlory = equipment.some((e: any) => e && e.specialSeq === 44);
    if (!hasGlory) return text;

    // 原版 L5000-5005：构造临时装备 z2（四系伤害各25、必中、穿透+50）
    const atkBonus = this.buildAttackerBonus(deadOne, playerData, map);
    atkBonus.物伤 = (atkBonus.物伤 || 0) + 25;
    atkBonus.电伤 = (atkBonus.电伤 || 0) + 25;
    atkBonus.冰伤 = (atkBonus.冰伤 || 0) + 25;
    atkBonus.火伤 = (atkBonus.火伤 || 0) + 25;
    atkBonus.护盾穿透 = (atkBonus.护盾穿透 || 0) + 50;
    atkBonus.装甲穿透 = (atkBonus.装甲穿透 || 0) + 50;
    atkBonus.生命穿透 = (atkBonus.生命穿透 || 0) + 50;

    // 原版 L5006-5010：计算总倍率 a1（百分比）
    // a1 = (死者 生命+装甲+护盾) / (攻击者 物伤*0.25+火伤*0.25+冰伤*0.25+电伤*0.25) * 100
    const deadTotal = (deadOne.属性?.生命 || deadOne.生命上限 || 1)
      + (deadOne.属性?.装甲 || deadOne.装甲上限 || 0)
      + (deadOne.属性?.护盾 || deadOne.护盾上限 || 0);
    const atkQuarter = (attacker.物伤 || 0) * 0.25 + (attacker.火伤 || 0) * 0.25
      + (attacker.冰伤 || 0) * 0.25 + (attacker.电伤 || 0) * 0.25;
    let a1: number;
    if (atkQuarter > 0 && deadTotal > atkQuarter) {
      a1 = (deadTotal / atkQuarter) * 100;
    } else if (atkQuarter > 0) {
      // 原版 默认分支：攻击者四系伤害和 > 死者总状态 → 倒数倍率
      a1 = (atkQuarter / deadTotal) * 100;
    } else {
      a1 = 100; // 攻击者无伤害则按基础倍率
    }

    // 原版 L5014：造成伤害(死掉的, 攻击者, s, z2, w1, "", a1, 0,0,0, 真, "光荣弹a", 真, d, ...)
    // 必中 → 跳过命中判定直接算伤害；a1 作为总伤害倍率（百分比）。
    const defenderBonus = this.buildMonsterBonus(attacker);
    const z2 = {
      name: '光荣弹',
      damage: 0,
      damageType: CombatSystemService.DMG_PHYS,
      properties: { phys: 0, fire: 0, ice: 0, elec: 0 },
      必中: true,
    };
    const dmg = this.calcDamage(atkBonus, defenderBonus, z2 as any, CombatSystemService.DMG_PHYS, false);
    const finalDmg = Math.max(1, Math.floor(dmg.damage * (a1 / 100)));

    // 对攻击者（怪物）施加光荣弹伤害（三池扣减 + 可能致死）
    this.applyDamageToMonster(attacker, finalDmg, dmg.poolDamage || { shield: 0, armor: 0, hp: finalDmg });
    const pool = dmg.poolDamage || { shield: 0, armor: 0, hp: finalDmg };
    const dmgText = this.formatDamageText(finalDmg, {
      shield: Math.min(pool.shield, attacker.shield || 0),
      armor: Math.min(pool.armor, attacker.armor || 0),
      hp: Math.min(pool.hp, attacker.hp || 0),
    });
    text = `${deadOne.name} 引爆【光荣弹】，对 ${attacker.name} 造成 ${dmgText}`;
    text = text + `（倍率${Math.round(a1)}%）`;

    // 原版 L5014 后若攻击者被光荣弹打死，按正常怪物死亡流程结算掉落（对齐 造成伤害 致死分支）
    if ((attacker.hp || 0) <= 0) {
      try {
        const death = await this.handleMonsterDeath(attacker, deadOne.userId || deadOne.qqNumber, map.id, deadOne);
        if (death.dropText) text = text + '\n' + death.dropText;
      } catch (e: any) {
        this.logger.warn(`光荣弹击杀结算失败: ${e.message}`);
      }
    }
    return text;
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

    // 兼容两种数据来源：早期运行时对象使用 dropTable，转换后的真实怪物
    // 配置将掉落表放在 bonus JSON 的 drops 字段中。
    const legacyDropTable = Array.isArray(monster?.dropTable)
      ? monster.dropTable
      : this.safeParseJson<any[]>(monster?.dropTable, []);
    const monsterBonus = this.safeParseJson<Record<string, any>>(monster?.bonus, {});
    const bonusDropTable = Array.isArray(monsterBonus?.drops) ? monsterBonus.drops : [];
    const dropTable = legacyDropTable.length > 0 ? legacyDropTable : bonusDropTable;

    // 如果没有掉落表，使用默认掉落
    if (dropTable.length === 0) {
      // 基础掉落：根据怪物等级给一些基础材料
      const multiplier = Number.isFinite(Number(dropMultiplier)) ? Math.max(0, Number(dropMultiplier)) : 1;
      if (Math.random() < 0.3 * multiplier) {
        drops.push({
          name: '怪物材料',
          quantity: Math.floor(monster.level || 1) + 1,
        });
      }
      return drops;
    }

    // 根据掉落率判定每个掉落项
    for (const dropEntry of dropTable) {
      if (!dropEntry || typeof dropEntry !== 'object') continue;

      const name = String(dropEntry.name ?? dropEntry.名称 ?? dropEntry.itemName ?? '').trim();
      if (!name) continue;

      const rawChance = dropEntry.chance ?? dropEntry.rate ?? dropEntry.几率;
      const chance = rawChance === undefined || rawChance === null || rawChance === ''
        ? 100
        : Number(rawChance);
      const multiplier = Number.isFinite(Number(dropMultiplier)) ? Math.max(0, Number(dropMultiplier)) : 1;
      const dropRate = Math.max(0, Math.min(100, (Number.isFinite(chance) ? chance : 0) * multiplier));
      if (Math.random() * 100 >= dropRate) continue;

      const rawQuantity = dropEntry.quantity ?? dropEntry.count ?? dropEntry.数量;
      const quantity = rawQuantity === undefined || rawQuantity === null || rawQuantity === ''
        ? 1
        : Number(rawQuantity);
      if (!Number.isFinite(quantity)) continue;

      const explicitType = String(dropEntry.type ?? dropEntry.类型 ?? '').trim().toLowerCase();
      const equipmentByDefinition = typeof this.staticData?.getEquipmentByName === 'function'
        && !!this.staticData.getEquipmentByName(name);
      const type = explicitType === '装备' || explicitType === 'equipment'
        || equipmentByDefinition
        ? '装备'
        : (explicitType === '消耗品' || explicitType === 'consumable' ? '消耗品' : '资源');

      drops.push({
        itemId: dropEntry.itemId ?? dropEntry.itemID,
        name,
        type,
        quantity,
        chance: Number.isFinite(chance) ? chance : 0,
        ...(dropEntry.data ? { data: dropEntry.data } : {}),
      });
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
      // 原版 武器攻击 L54-58：z1.攻击文本 = 文本列表[1]（拳头条目），显示时按命中等级抽取模板并展开占位符
      return {
        name: '拳头',
        damage: 1,
        damageType: CombatSystemService.DMG_PHYS,
        attackText: '',
        type: '近战武器',
        properties: { phys: 100, fire: 0, ice: 0, elec: 0 },
        cooldown: 5,
      };
    }

    // 从攻击者装备或背包中获取武器
    const weapons = attacker.weapons || attacker.equipment || [];
    const rawWeaponValue = weapons[weaponIndex - 1];
    // 怪物静态配置的“武器”是名称字符串，玩家/召唤物存量通常是装备对象；
    // 两种结构都对应原版 武器 数组成员。
    if (!rawWeaponValue) {
      return {
        name: '拳头',
        damage: 1,
        damageType: CombatSystemService.DMG_PHYS,
        type: '近战武器',
        properties: { phys: 100, fire: 0, ice: 0, elec: 0 },
      };
    }
    const rawWeapon = typeof rawWeaponValue === 'string'
      ? { name: rawWeaponValue }
      : rawWeaponValue;

    // 解析武器属性。存量玩家的武器通常只有 name/data，固定数值需要回读静态装备定义。
    const staticWeapon = typeof (this.staticData as any)?.getEquipmentByName === 'function'
      ? ((this.staticData as any).getEquipmentByName(rawWeapon.name) || {})
      : {};
    const parseObject = (value: any): any => {
      if (typeof value !== 'string') return value || {};
      try { return JSON.parse(value) || {}; } catch { return {}; }
    };
    const rawBonus = parseObject(rawWeapon.bonus || rawWeapon.加成);
    const staticBonus = parseObject(staticWeapon.bonus);
    const properties = parseObject(
      rawWeapon.properties || rawWeapon.属性 || staticWeapon.properties || staticWeapon.属性,
    );
    const anesthesia = Number(
      rawWeapon.anesthesia ?? rawWeapon.麻醉 ?? rawBonus.麻醉 ?? staticBonus.麻醉 ?? 0,
    );

    // 普拉娜武器冷却×10（原版 _计算玩家 L1761-1763：玩家.特殊序号==#普拉娜 时 武器.冷却=武器.冷却*10）
    let rawCooldown = rawWeapon.cooldown ?? rawWeapon.冷却 ?? staticWeapon.cooldown ?? 5;
    if (Number(attacker.specialSeq) === 22) {
      rawCooldown = rawCooldown * 10;
    }

    return {
      name: rawWeapon.name || '未知武器',
      damage: rawWeapon.damage ?? rawWeapon.伤害 ?? staticWeapon.damage ?? staticWeapon.伤害 ?? 0,
      damageType: this.resolveDamageType(rawWeapon.damageType || rawWeapon.伤害类型 || staticWeapon.damageType || staticWeapon.伤害类型 || '物理'),
      attackText: rawWeapon.attackText || rawWeapon.攻击文本 || staticWeapon.attackText || staticWeapon.攻击文本 || '',
      type: rawWeapon.type || rawWeapon.类型 || staticWeapon.equipType || staticWeapon.type || '近战武器',
      specialSeq: rawWeapon.specialSeq ?? rawWeapon.特殊序号 ?? staticWeapon.specialSeq ?? 0,
      cooldown: rawCooldown || staticWeapon.cooldown || 5,
      lockTime: rawWeapon.lockTime ?? rawWeapon.锁定 ?? staticWeapon.lockTime ?? 0,
      forcedEffect: rawWeapon.forcedEffect ?? rawWeapon.必出特效 ?? staticWeapon.forcedEffect ?? false,
      vehicleForceDmg: rawWeapon.vehicleForceDmg ?? rawWeapon.无视载具 ?? staticWeapon.vehicleForceDmg ?? false,
      properties: {
        phys: properties.phys ?? properties.物 ?? 100,
        fire: properties.fire ?? properties.火 ?? 0,
        ice: properties.ice ?? properties.冰 ?? 0,
        elec: properties.elec ?? properties.电 ?? 0,
      },
      bonus: { ...staticBonus, ...rawBonus },
      baseBonus: parseObject(rawWeapon.baseBonus || rawWeapon.基础加成 || staticWeapon.baseBonus || staticWeapon.基础加成),
      attackTexts: parseObject(rawWeapon.attackTexts || rawWeapon.攻击文本列表 || staticWeapon.attackTexts || staticWeapon.攻击文本列表) || [],
      buffs: parseObject(rawWeapon.buffs || rawWeapon.增益 || staticWeapon.buffs || staticWeapon.增益) || [],
      negativeType: rawWeapon.negativeType ?? rawWeapon.负面类型 ?? staticWeapon.negativeType ?? 0,
      specialEffect: rawWeapon.specialEffect ?? rawWeapon.特效 ?? staticWeapon.specialEffect ?? 0,
      self: { ...(rawWeapon.self || rawWeapon.自带 || {}), anesthesia },
      anesthesia,
    };
  }

  /**
   * 解析单件装备/武器的属性加成
   * 存量物品只存 name/data：附加加成编码在 data 串（如 aa30 → 护盾+30），
   * 自带加成在静态装备定义 baseBonus；植入体/增幅器强化会直接写 bonus 对象。
   * 返回的 bonus/baseBonus 供 buildAttackerBonus 并入玩家总属性。
   * @param item 背包/装备栏中的原始物品对象
   * @returns bonus（附加加成）与 baseBonus（自带加成）
   */
  private resolveItemBonus(item: any): { bonus: Record<string, number>; baseBonus: Record<string, number> } {
    const parseObj = (value: any): Record<string, number> => {
      if (!value) return {};
      if (typeof value === 'object') return { ...value };
      try { return JSON.parse(String(value)) || {}; } catch { return {}; }
    };
    // 静态定义的自带加成（原地覆盖，静态为底、物品对象优先）
    const def = typeof (this.staticData as any)?.getEquipmentByName === 'function'
      ? (this.staticData as any).getEquipmentByName(String(item?.name ?? '')) || {}
      : {};
    const baseBonus: Record<string, number> = {
      ...parseObj(def?.baseBonus ?? def?.基础加成),
      ...parseObj(item?.baseBonus ?? item?.基础加成 ?? item?.self ?? item?.自带),
    };
    // 附加加成：先收已解析的对象字段（植入体/增幅器强化路径），再解析 data 编码串
    const bonus: Record<string, number> = {
      ...parseObj(item?.bonus ?? item?.加成),
    };
    const rawData = String(item?.data ?? item?.数据 ?? '');
    for (const segment of rawData.split('!')) {
      if (!segment || segment.length < 3) continue;
      const code = segment.substring(0, 2);
      const bonusKey = BONUS_CODE_MAP[code];
      if (!bonusKey) continue;
      const val = parseFloat(segment.substring(2));
      if (Number.isFinite(val) && val !== 0) {
        bonus[bonusKey] = (bonus[bonusKey] || 0) + val;
      }
    }
    return { bonus, baseBonus };
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
    targetId?: number | string,
  ): any[] {
    const alive = monsters.filter(m => (m.hp || 0) > 0);

    if (alive.length === 0) return [];

    if (targetId !== undefined && targetId !== null) {
      const matched = alive.find((m: any) =>
        String(m.id) === String(targetId) || String(m.qq) === String(targetId),
      );
      if (matched) return [matched];
    }

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
   * 原版 使魔技能.ecode L125-161：取羽毛。
   * 羽毛标记保存“上次结算时间”，不是当前数量；当前数量由时间差按10秒
   * 自动恢复并封顶。返回值是扣除前数量，扣除后的时间锚点写回 markers。
   * `deduction=-0.371` 是原版用于读取后清空时间锚点的特殊分支，按原样保留。
   */
  getFeather(
    player: any,
    markers: Record<string, any>,
    nowMs = Date.now(),
    deduction?: number,
  ): number {
    const nowSec = nowMs >= 1e12 ? nowMs / 1000 : nowMs;
    const skillLevel = Number(player.skillLevel ?? (
      player.type
        ? this.skillLevelFromMarkers(markers, player.type)
        : 0
    ));
    let max = 10 + skillLevel;
    let intervalFactor = 1;
    const buffs = this.playerService.safeJsonParse<any[]>(player.buffs, []);
    const nowForBuff = nowSec;
    const solar = buffs.some((b: any) => {
      if ((b?.name ?? b?.名称) !== '日轮') return false;
      const raw = Number(b?.expireAt ?? b?.有效期至 ?? 0);
      const expireSec = raw >= 1e12 ? raw / 1000 : raw;
      return !expireSec || expireSec > nowForBuff;
    });
    if (solar) {
      max *= 1.5;
      if (Number(player.affinity ?? player.好感 ?? 0) >= 40) intervalFactor = 0.5;
    }

    const rawStamp = Number(markers.羽毛 ?? markers.feather ?? 0);
    const stampSec = rawStamp >= 1e12 ? rawStamp / 1000 : rawStamp;
    const elapsed = Math.max(0, (nowSec - stampSec) / (10 * intervalFactor));
    let available = elapsed > max ? max : elapsed;
    if (!rawStamp) available = max;
    available = Math.max(0, Math.min(max, available));
    const beforeDeduction = available;

    const actualDeduction = deduction === undefined ? 0 : deduction;
    if (actualDeduction === -0.371) {
      available = 0;
    } else if (available > actualDeduction) {
      available -= actualDeduction;
    } else {
      available = 0;
    }

    markers.羽毛 = available > 0
      ? (nowSec - available * 10 * intervalFactor)
      : nowSec;
    markers.feather = undefined;
    player.markers = JSON.stringify(markers);
    return beforeDeduction;
  }

  /** 真实 PlayerService 与轻量测试夹具都使用同一套技能等级规则。 */
  private skillLevelFromMarkers(markers: any, familiarName: string): number {
    const service = this.playerService as any;
    if (typeof service.getSkillLevel === 'function') {
      return Number(service.getSkillLevel(markers, familiarName)) || 1;
    }
    const proficiency = Math.max(0, Number(
      service.getMarkerValue?.(markers, `${familiarName}技能熟练度`)
      ?? (markers || {})[`${familiarName}技能熟练度`]
      ?? 0,
    ));
    let level = 1;
    while (proficiency >= level * level) level += 1;
    return level;
  }

  /** 原版 使魔技能.ecode L486-503：从未冷却武器中随机返回一个1-based索引。 */
  private chooseRandomReadyWeapon(player: any, playerData: PlayerData, nowMs = Date.now()): number | null {
    const weapons = playerData.weapons || this.playerService.safeJsonParse<any[]>(player.weapons, []);
    if (!Array.isArray(weapons) || weapons.length === 0) return null;
    const markers2 = playerData.markers2 || this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const ready: number[] = [];
    for (let index = 0; index < weapons.length; index += 1) {
      const raw = weapons[index];
      const name = String(raw?.name ?? raw?.名称 ?? raw ?? '');
      if (!name) continue;
      const marker = markers2.find((item: any) => (item?.name ?? item?.名称) === `${name}冷却`);
      const rawExpire = Number(marker?.expireAt ?? marker?.有效期至 ?? 0);
      const expireMs = rawExpire >= 1e12 ? rawExpire : rawExpire * 1000;
      if (!marker || !rawExpire || expireMs <= nowMs) ready.push(index + 1);
    }
    if (ready.length === 0) return null;
    return ready[Math.floor(Math.random() * ready.length)];
  }

  /**
   * 构建攻击者加成数据
   * 合并玩家基础属性、装备加成、增益等
   * 对应原版 加成计算.ecode _计算玩家()：按等级+熟练度成长。
   * public：供信息显示/属性面板调用，展示"计算后"的成长属性。
   */
  buildAttackerBonus(player: any, playerData: PlayerData, map?: any): BonusData {
    // 原版 L1746-1760：每次计算玩家前先重置武器自带/加成，避免套装判断2
    // 写入的等级加成跨次累加。这里保留原始快照，供同一武器对象反复重置。
    // 从玩家基础属性构建
    // 对齐原版 _计算玩家：加成从 0 起步（原版 玩家.加成 = 空加成 j），
    // 再由"等级成长 + 使魔专属 + 装备/套装"累加得出最终属性。
    // 注意：hp/shield/armor 以"上限字段"（maxHp/maxShield/maxArmor）为基数，
    // 而非当前血量(player.hp)，避免把当前血量当加成基数导致上限虚高。
    // map 可选：用于宠物存活数量加成（原版 L2187-2221）
    const bonus: BonusData = {
      攻击: 0,
      攻击2: 0,
      命中: 0,
      命中2: 0,
      闪避: 0,
      闪避2: 0,
      暴击: 0,
      暴击伤害: 0,  // 暴击伤害由成长公式给出（原版：150+等级/10）
      生命: 0,       // 生命由成长公式给出（原版：50+(等级×2+防御熟练)×(1+等级/100)，1级≈52）
      护盾: 0,   // 护盾：20+...
      装甲: 0,    // 装甲：30+...
      物伤: 0,
      物伤2: 0,
      火伤: 0,
      火伤2: 0,
      冰伤: 0,
      冰伤2: 0,
      电伤: 0,
      电伤2: 0,
      吸生命: 0,
      贯穿: 0,
      生命穿透: 0,
      护盾穿透: 0,
      装甲穿透: 0,
      世界等级差距: 0,
      减益: 0,
    };

    try {
      const weapons = playerData.weapons || this.playerService.safeJsonParse<any[]>(player.weapons, []);
      if (Array.isArray(weapons) && weapons.length > 0) {
        weapons.forEach((weapon: any, index: number) => {
          if (!weapon || typeof weapon !== 'object') return;
          if (!weapon.__originalBonus) weapon.__originalBonus = JSON.stringify(weapon.bonus ?? weapon.加成 ?? {});
          if (!weapon.__originalBaseBonus) {
            weapon.__originalBaseBonus = JSON.stringify(
              weapon.baseBonus ?? weapon.基础加成 ?? weapon.self ?? weapon.自带 ?? {},
            );
          }

          const parseSnapshot = <T>(value: string, fallback: T): T => {
            try { return JSON.parse(value) as T; } catch { return fallback; }
          };
          weapon.bonus = weapon.加成 = parseSnapshot<Record<string, number>>(weapon.__originalBonus, {});
          weapon.baseBonus = weapon.基础加成 = weapon.self = weapon.自带 =
            parseSnapshot<Record<string, number>>(weapon.__originalBaseBonus, {});

          if (typeof weapon.baseBonus?.攻击 === 'number') {
            weapon.baseBonus.攻击 += index * (1 + lv / 100);
          }
        });
      }
    } catch (error: any) {
      this.logger.warn(`武器自带加成重置失败: ${error.message}`);
    }

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
      bonus.暴击 = (bonus.暴击 || 0) + 3;
      bonus.暴击伤害 = (bonus.暴击伤害 || 0) + 150 + lv / 10;
      bonus.攻击加成 = (bonus.暴击伤害 || 0) + 100;
      bonus.速度 = 10 + lv / 5 + profDodge / 4 * lvFactor;
      bonus.电伤 = (bonus.电伤 || 0) + 10 + (lv + profElec) * lvFactor;
      bonus.火伤 = (bonus.火伤 || 0) + 10 + (lv + profFire) * lvFactor;
      bonus.物伤 = (bonus.物伤 || 0) + 10 + (lv + profPhys) * lvFactor;
      bonus.冰伤 = (bonus.冰伤 || 0) + 10 + (lv + profIce) * lvFactor;
      bonus.命中 = (bonus.命中 || 0) + 10 + (lv / 2 + profCombat / 2) * lvFactor;
      bonus.攻击 = (bonus.攻击 || 0) + 10 + profCombat * lvFactor;
      bonus.采集 = (bonus.采集 || 0) + 100 + lv / 3 + profGather * (1 + lv / 1000);
      bonus.生命 = (bonus.生命 || 0) + 50 + (lv * 2 + profDefense) * lvFactor;
      bonus.护盾 = (bonus.护盾 || 0) + 20 + (lv * 2 + profDefense) * lvFactor;
      bonus.装甲 = (bonus.装甲 || 0) + 30 + (lv * 2 + profDefense) * lvFactor;
      bonus.闪避 = (bonus.闪避 || 0) + 10 + (lv / 2 + profDefense / 2) * lvFactor;
      bonus.生命全抗 = (bonus.生命全抗 || 0) + 10;
      bonus.护盾全抗 = (bonus.护盾全抗 || 0) + 10;
      bonus.装甲全抗 = (bonus.装甲全抗 || 0) + 10;
      bonus.生命回复 = (bonus.生命回复 || 0) + 0.1 + lv / 10;
      bonus.护盾回复 = (bonus.护盾回复 || 0) + 0.1 + lv / 10;
      bonus.装甲回复 = (bonus.装甲回复 || 0) + 0.1 + lv / 10;
    } else {
      // 未选使魔的玩家（特殊序号≤0，原版 _计算玩家 L1834-1835 只叠加"基础"）：
      // 使用数据库基础字段作为兜底，避免命中/闪避等显示为 0。
      bonus.攻击 = player.attack || 0;
      bonus.命中 = player.hit || 100;
      bonus.闪避 = player.dodge || 0;
      bonus.暴击 = player.crit || 5;
      bonus.暴击伤害 = player.critDmg || 150;
      bonus.生命 = player.maxHp || player.hp || 100;
      bonus.护盾 = player.maxShield || player.shield || 0;
      bonus.装甲 = player.maxArmor || player.armor || 0;
      bonus.速度 = player.speed || 100;
    }

    // ========== 使魔专属加成（对应原版 _计算玩家 L1872+ 核心分支） ==========
    // 按需补充高频使魔的专属规则（数值均来自原版，不臆造）
    const seq = player.specialSeq ?? 0;
    const skillLevel = player.type ? this.skillLevelFromMarkers(markers, player.type) : 0;
    // 原版玩家结构在计算属性时直接写入“技能等级”；保留英文/中文别名，
    // 让后续战斗特效和载具分支读取到同一套平方阈值结果。
    player.skillLevel = skillLevel;
    player.技能等级 = skillLevel;

    // 原版 L1681-1779：装备机械触手或使用普拉娜时，当前武器冷却中会
    // 从“随机未冷却武器”切换到可用武器；普拉娜高好感还会记录超压熟练。
    // 这里使用与 weaponAttack 相同的 markers2 容器，并兼容秒/毫秒存量时间戳。
    try {
      const equipment = playerData.equipment || this.playerService.safeJsonParse<any[]>(player.equipment, []);
      const hasMechanicalTentacle = equipment.some((item: any) =>
        String(item?.name ?? item?.名称 ?? '').includes('机械触手')
        || Number(item?.specialSeq ?? item?.特殊序号 ?? 0) === 110,
      );
      const isPlana = Number(player.specialSeq ?? 0) === 22 || player.type === '普拉娜';
      let weaponMode = hasMechanicalTentacle ? -2 : (isPlana ? -1 : 0);
      const affinity = Number(player.affinity ?? this.playerService.getMarkerValue(markers, `${player.type}好感`));
      const markers2 = playerData.markers2 || this.playerService.safeJsonParse<any[]>(player.markers2, []);
      const nowMs = Date.now();
      const isActive = (name: string): boolean => {
        const item = markers2.find((entry: any) => (entry?.name ?? entry?.名称) === name);
        const rawExpire = Number(item?.expireAt ?? item?.有效期至 ?? 0);
        if (!item || !rawExpire) return false;
        const expireMs = rawExpire >= 1e12 ? rawExpire : rawExpire * 1000;
        return expireMs > nowMs;
      };

      if (weaponMode === -1 && affinity >= 60) {
        weaponMode = -2;
        if (affinity >= 80 && !isActive('甩枪')) {
          markers2.push({ name: '甩枪', expireAt: nowMs + 20 * 1000, value: 1 + skillLevel * 0.01 });
        }
        if (affinity >= 100 && !isActive('pll')) {
          const currentName = Number(player.currentWeapon || 0) > 0
            ? String((playerData.weapons?.[Number(player.currentWeapon) - 1] as any)?.name
              ?? (playerData.weapons?.[Number(player.currentWeapon) - 1] as any)?.名称
              ?? '拳头')
            : '拳头';
          markers[`${currentName}t`] = 1;
          markers2.push({ name: 'pll', expireAt: nowMs + 15 * 1000 });
        }
      }

      if (weaponMode === -2) {
        const currentName = Number(player.currentWeapon || 0) > 0
          ? String((playerData.weapons?.[Number(player.currentWeapon) - 1] as any)?.name
            ?? (playerData.weapons?.[Number(player.currentWeapon) - 1] as any)?.名称
            ?? '拳头')
          : '拳头';
        if (isActive(`${currentName}冷却`)) {
          const nextWeapon = this.chooseRandomReadyWeapon(player, playerData, nowMs);
          if (nextWeapon !== null) player.currentWeapon = nextWeapon;
        }
      }
      player.markers2 = JSON.stringify(markers2);
      player.markers = JSON.stringify(markers);
    } catch (error: any) {
      this.logger.warn(`随机未冷却武器处理失败: ${error.message}`);
    }
    switch (String(seq)) {
      case '8': { // 战斗女仆：电伤×1.25；好感≥20 沉着攻击2加成
        bonus.电伤 = (bonus.电伤 || 0) * 1.25;
        break;
      }
      case '1': { // 花园猫：电伤2+25、掉落率+10+技能等级
        bonus.电伤2 = (bonus.电伤2 || 0) + 25;
        bonus.掉落率 = (bonus.掉落率 || 0) + 10 + skillLevel;
        break;
      }
      case '12': { // 龙姬（原版 L1894-1914）：物伤2+50、生命/护盾/装甲2-50；好感分支
        bonus.物伤2 = (bonus.物伤2 || 0) + 50;
        bonus.生命2 = (bonus.生命2 || 0) - 50;
        bonus.护盾2 = (bonus.护盾2 || 0) - 50;
        bonus.装甲2 = (bonus.装甲2 || 0) - 50;
        // 怒吼增益时生命保底1（原版 L1899-1904）
        const pBuffsD = playerData.buffs || [];
        if (pBuffsD.some((b: any) => b && b.name === '怒吼') && (player.hp || 0) < 1) {
          player.hp = 1;
        }
        // 好感≥80：暴伤+5×技能等级（原版 L1905-1907）
        if ((player.affinity || 0) >= 80) {
          bonus.暴击伤害 = (bonus.暴击伤害 || 0) + 5 * skillLevel;
        }
        // 好感≥20：残血增伤（已损失状态比例×物伤）（原版 L1908-1911）
        if ((player.affinity || 0) >= 20) {
          const curState = (player.hp || 0) + (player.shield || 0) + (player.armor || 0);
          const maxState = (bonus.生命 || 1) + (bonus.护盾 || 0) + (bonus.装甲 || 0);
          const lostRatio = Math.max(0, Math.min(1, 1 - curState / Math.max(1, maxState)));
          bonus.物伤 = (bonus.物伤 || 0) + (bonus.物伤 || 0) * lostRatio * (1 + skillLevel / 200);
        }
        // 好感≥60：攻击2 + 龙闪熟练度（原版 L1912-1914）
        if ((player.affinity || 0) >= 60) {
          bonus.攻击2 = (bonus.攻击2 || 0) + this.playerService.getMarkerValue(markers, '龙闪');
        }
        break;
      }
      case '10': { // 小樱：三元素伤2+10+技能/2、护盾2+15+技能、武器冷却-3
        bonus.电伤2 = (bonus.电伤2 || 0) + 10 + skillLevel / 2;
        bonus.火伤2 = (bonus.火伤2 || 0) + 10 + skillLevel / 2;
        bonus.冰伤2 = (bonus.冰伤2 || 0) + 10 + skillLevel / 2;
        bonus.护盾2 = (bonus.护盾2 || 0) + 15 + skillLevel;
        // 原版 L2049-2071：好感≥100 且满状态时，最高属性伤害系+10+技能（混沌魔力）
        if ((player.affinity || 0) >= 100) {
          const curState = (player.hp || 0) + (player.shield || 0) + (player.armor || 0);
          const maxState = (bonus.生命 || 1) + (bonus.护盾 || 0) + (bonus.装甲 || 0);
          if (curState >= maxState) {
            const elec = bonus.电伤 || 0;
            const fire = bonus.火伤 || 0;
            const ice = bonus.冰伤 || 0;
            if (elec > fire) {
              if (elec > ice) {
                bonus.电伤2 = (bonus.电伤2 || 0) + 10 + skillLevel;
              } else {
                bonus.冰伤2 = (bonus.冰伤2 || 0) + 10 + skillLevel;
              }
            } else if (fire > ice) {
              bonus.火伤2 = (bonus.火伤2 || 0) + 10 + skillLevel;
            } else {
              bonus.冰伤2 = (bonus.冰伤2 || 0) + 10 + skillLevel;
            }
          }
        }
        break;
      }
      case '18': { // 启·木之本樱（原版 L1925-1931）：三元素伤2+15+技能、武器冷却-3
        bonus.电伤2 = (bonus.电伤2 || 0) + 15 + skillLevel;
        bonus.火伤2 = (bonus.火伤2 || 0) + 15 + skillLevel;
        bonus.冰伤2 = (bonus.冰伤2 || 0) + 15 + skillLevel;
        break;
      }
      case '13': { // 伊卡洛斯（原版 L1932-1952）：冰伤2+25；好感分支
        bonus.冰伤2 = (bonus.冰伤2 || 0) + 25;
        // 好感≥20：溅射+25+技能×2、溅射2+1（原版 L1934-1937）
        if ((player.affinity || 0) >= 20) {
          bonus.溅射 = (bonus.溅射 || 0) + 25 + skillLevel * 2;
          bonus.溅射数量 = (bonus.溅射数量 || 0) + 1;
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
          bonus.攻击2 = (bonus.攻击2 || 0) + ((bonus.溅射数量 || 0) + weaponSplash2) * 20;
        }
        // 好感≥80：攻击2 + 闪避增益值×10（原版 L1949-1952）
        if ((player.affinity || 0) >= 80) {
          const dodgeBuff = (playerData.buffs || []).find((b: any) => b && b.name === '闪避');
          const dodgeVal = dodgeBuff?.value || 0;
          bonus.攻击2 = (bonus.攻击2 || 0) + dodgeVal * 10;
        }
        break;
      }
      case '6': { // 恶毒（原版 L1954-1974）：火伤2+25；好感≥20 残血暴击；好感≥40 命中/闪避攻击2；鹰眼增益
        bonus.火伤2 = (bonus.火伤2 || 0) + 25;
        // 好感≥20：残血暴击/暴伤（原版 L1956-1960）
        if ((player.affinity || 0) >= 20) {
          const curState = (player.hp || 0) + (player.shield || 0) + (player.armor || 0);
          const maxState = (bonus.生命 || 1) + (bonus.护盾 || 0) + (bonus.装甲 || 0);
          const hpRatio = Math.min(1, curState / Math.max(1, maxState));
          bonus.暴击 = (bonus.暴击 || 0) + (15 + skillLevel) * hpRatio;
          bonus.暴击伤害 = (bonus.暴击伤害 || 0) + (50 + skillLevel * 5) * hpRatio;
        }
        // 鹰眼增益：溅射+50+技能、溅射2+2、命中2+50+技能、穿透15（原版 L1961-1967）
        if ((playerData.buffs || []).some((b: any) => b && b.name === '鹰眼')) {
          bonus.溅射 = (bonus.溅射 || 0) + 50 + skillLevel;
          bonus.溅射数量 = (bonus.溅射数量 || 0) + 2;
          bonus.命中2 = (bonus.命中2 || 0) + 50 + skillLevel;
          this.bonusService.addPenetration(bonus, 15);
        }
        // 好感≥40：命中/闪避比例攻击2（原版 L1968-1974）
        if ((player.affinity || 0) >= 40) {
          let a1 = (bonus.命中 || 0) / Math.max(1, (bonus.闪避 || 1)) * 100;
          if (a1 > 50 + skillLevel * 2) a1 = 50 + skillLevel * 2;
          bonus.攻击2 = (bonus.攻击2 || 0) + a1;
        }
        break;
      }
      case '2': { // 长萌：火伤×1.25+火伤2+25；护盾/装甲2+1+技能；好感≥20 回复转命中
        bonus.火伤 = (bonus.火伤 || 0) * 1.25;
        bonus.火伤2 = (bonus.火伤2 || 0) + 25;
        bonus.护盾2 = (bonus.护盾2 || 0) + 1 + skillLevel;
        bonus.装甲2 = (bonus.装甲2 || 0) + 1 + skillLevel;
        bonus.火伤 = (bonus.火伤 || 0) + ((bonus.装甲 || 0) + (bonus.护盾 || 0)) * (0.15 + skillLevel / 200);
        if ((player.affinity || 0) >= 20) {
          bonus.命中 = (bonus.命中 || 0) + (bonus.生命回复 || 0) * 10 + (bonus.装甲回复 || 0) * 10;
        }
        if ((player.affinity || 0) >= 60) {
          // 原版 L1985-1995：护盾/装甲≥20%各+25韧性；当前状态/上限×40 抗贯穿
          let a = 0;
          if ((player.shield || 0) / Math.max(1, (bonus.护盾 || 1)) >= 0.2) a += 1;
          if ((player.armor || 0) / Math.max(1, (bonus.装甲 || 1)) >= 0.2) a += 1;
          bonus.韧性 = (bonus.韧性 || 0) + (1 - (bonus.韧性 || 0) / 100) * a * 25;
          const curState = (player.hp || 0) + (player.shield || 0) + (player.armor || 0);
          const maxState = (bonus.生命 || 1) + (bonus.护盾 || 0) + (bonus.装甲 || 0);
          bonus.抗贯穿 = (bonus.抗贯穿 || 0) + curState / Math.max(1, maxState) * 40;
        }
        break;
      }
      case '11': { // 伊芙利特：火伤2+25；好感≥80 火抗115；攻击模式 命中2+50+技能、攻击2+33
        bonus.火伤2 = (bonus.火伤2 || 0) + 25;
        if ((player.affinity || 0) >= 80) {
          bonus.生命火抗 = 115;
          bonus.装甲火抗 = 115;
          bonus.护盾火抗 = 115;
        }
        if (player.attackMode === 1) {
          bonus.命中2 = (bonus.命中2 || 0) + 50 + skillLevel;
          bonus.攻击2 = (bonus.攻击2 || 0) + 33;
        }
        break;
      }
      case '4': { // 剑圣：物伤2+1.25；好感≥20 近战攻击2+15+技能；好感≥60 攻击/命中2比例加成
        bonus.物伤2 = (bonus.物伤2 || 0) + 1.25;
        if ((player.affinity || 0) >= 20) {
          bonus.攻击2 = (bonus.攻击2 || 0) + 15 + skillLevel;
        }
        if ((player.affinity || 0) >= 60) {
          const ratio = Math.min(1, (player.hp || 0) / Math.max(1, (bonus.生命 || 1)));
          const a1 = 20 + ratio * 20;
          bonus.攻击2 = (bonus.攻击2 || 0) + a1;
          bonus.命中2 = (bonus.命中2 || 0) + a1;
        }
        if ((player.affinity || 0) >= 40) {
          bonus.暴击伤害 = (bonus.暴击伤害 || 0) + 3 * skillLevel;
        }
        if ((player.affinity || 0) >= 80) {
          bonus.攻击生命 = (bonus.攻击生命 || 0) + 15 + skillLevel;
        }
        break;
      }
      case '15': { // 四糸乃（原版 L2034-2047）：冰伤2+25；好感≥60 冰抗115；好感≥40 闪避+等级*技能、武器冰属性×1.15+技能/200
        bonus.冰伤2 = (bonus.冰伤2 || 0) + 25;
        if ((player.affinity || 0) >= 60) {
          bonus.生命冰抗 = 115;
          bonus.装甲冰抗 = 115;
          bonus.护盾冰抗 = 115;
        }
        if ((player.affinity || 0) >= 40) {
          bonus.闪避 = (bonus.闪避 || 0) + lv * skillLevel;
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
        bonus.生命回复2 = (bonus.生命回复2 || 0) + 2;
        bonus.生命2 = (bonus.生命2 || 0) + 25 + skillLevel;
        break;
      }
      case '3': { // 绝灭天使（对应原版 _计算玩家 L2076-2097 + 取羽毛）
        // 羽毛存于时间锚点标记，统一通过原版“取羽毛”子程序计算恢复/封顶。
        const feather = this.getFeather(player, markers, Date.now());
        const pBuffs: any[] = playerData.buffs || [];
        // a3 倍率：救世魔王×1.5（韧性+50%、穿透+10）；光翼×(1+0.5+技能/100)（原版 L2077-2091）
        let a3 = 1;
        const hasSavior = pBuffs.some((b: any) => b && b.name === '救世魔王');
        if (hasSavior) {
          a3 = 1.5;
          bonus.韧性 = (bonus.韧性 || 0) + (1 - (bonus.韧性 || 0) / 100) * 50;
          this.bonusService.addPenetration(bonus, 10);
        }
        const hasLightWing = pBuffs.some((b: any) => b && b.name === '光翼');
        if (hasLightWing) a3 = a3 * (1 + 0.5 + skillLevel / 100);
        // 炮冠增益：贯穿 + 羽毛/2×a3、穿透+10（原版 L2084-2088）
        if (pBuffs.some((b: any) => b && b.name === '炮冠')) {
          bonus.贯穿 = (bonus.贯穿 || 0) + Math.round(feather / 2 * a3 * 100) / 100;
          this.bonusService.addPenetration(bonus, 10);
        }
        // 命中2 = 羽毛 × a3（原版 L2092）
        bonus.命中2 = (bonus.命中2 || 0) + feather * a3;
        // 无光盾时：每片羽毛额外+1%暴伤（原版 L2093-2096：光盾存在时羽毛+1并暴伤+羽毛）
        if (!pBuffs.some((b: any) => b && b.name === '光盾')) {
          bonus.暴击伤害 = (bonus.暴击伤害 || 0) + feather;
        }
        // 攻击2 = 羽毛 × a3（原版 L2097）
        bonus.攻击2 = (bonus.攻击2 || 0) + feather * a3;
        break;
      }
      case '16': { // 军姬：生命2+25；好感≥20 物伤2+45+技能、闪避2+5+技能/22
        bonus.生命2 = (bonus.生命2 || 0) + 25;
        if ((player.affinity || 0) >= 20) {
          bonus.物伤2 = (bonus.物伤2 || 0) + 45 + skillLevel;
          bonus.闪避2 = (bonus.闪避2 || 0) + 5 + skillLevel / 22;
        } else {
          bonus.物伤2 = (bonus.物伤2 || 0) + 25;
        }
        break;
      }
      case '19': { // saber（原版 L2107-2132）：物伤2+50、攻击2+30；好感≥20 物伤2+40+技能*2；好感≥60 穿透+10、暴伤+技能*3；ex增益
        bonus.物伤2 = (bonus.物伤2 || 0) + 50;
        bonus.攻击2 = (bonus.攻击2 || 0) + 30;
        if ((player.affinity || 0) >= 20) {
          bonus.物伤2 = (bonus.物伤2 || 0) + 40 + skillLevel * 2;
        }
        if ((player.affinity || 0) >= 60) {
          this.bonusService.addPenetration(bonus, 10);
          bonus.暴击伤害 = (bonus.暴击伤害 || 0) + skillLevel * 3;
        }
        // ex增益（原版 L2117-2132）：好感≥80 物伤2+50+技能；好感≥100 全属性+15+技能/2
        if ((playerData.buffs || []).some((b: any) => b && b.name === 'ex')) {
          if ((player.affinity || 0) >= 80) {
            bonus.物伤2 = (bonus.物伤2 || 0) + 50 + skillLevel;
          }
          if ((player.affinity || 0) >= 100) {
            const a1 = 15 + skillLevel / 2;
            bonus.攻击2 = (bonus.攻击2 || 0) + a1;
            bonus.装甲2 = (bonus.装甲2 || 0) + a1;
            bonus.护盾2 = (bonus.护盾2 || 0) + a1;
            bonus.生命2 = (bonus.生命2 || 0) + a1;
            bonus.闪避2 = (bonus.闪避2 || 0) + a1;
            bonus.命中2 = (bonus.命中2 || 0) + a1;
          }
        }
        break;
      }
      case '14': { // 星尘（原版 L2134-2156）：电伤+护盾*(0.5+技能/100)、电伤2+25、护盾2+25+技能；好感≥40 高盾增韧；中子星/xta/xtb增益
        bonus.电伤 = (bonus.电伤 || 0) + (bonus.护盾 || 0) * (0.5 + skillLevel / 100);
        bonus.电伤2 = (bonus.电伤2 || 0) + 25;
        bonus.护盾2 = (bonus.护盾2 || 0) + 25 + skillLevel;
        if ((player.affinity || 0) >= 40) {
          // 原版 L2138-2146：护盾>50%时 韧性+50%、抗贯穿+40、穿透+15、必中
          if ((player.shield || 0) / Math.max(1, (bonus.护盾 || 1)) > 0.5) {
            bonus.韧性 = (bonus.韧性 || 0) + (1 - (bonus.韧性 || 0) / 100) * 50;
            bonus.抗贯穿 = (bonus.抗贯穿 || 0) + 40;
            this.bonusService.addPenetration(bonus, 15);
            bonus.必中 = true;
          }
        }
        // 中子星增益：全抗 + 增益值×0.025（原版 L2147-2150）
        const neutronStar = (playerData.buffs || []).find((b: any) => b && b.name === '中子星');
        if (neutronStar) {
          const a1 = Number(neutronStar.value) || 0;
          bonus.生命全抗 = (bonus.生命全抗 || 0) + a1 * 0.025;
          bonus.装甲全抗 = (bonus.装甲全抗 || 0) + a1 * 0.025;
          bonus.护盾全抗 = (bonus.护盾全抗 || 0) + a1 * 0.025;
        }
        // xta/xtb 增益：护盾回复/护盾回复2 + 增益值（原版 L2151-2156）
        const xta = (playerData.buffs || []).find((b: any) => b && b.name === 'xta');
        if (xta) bonus.护盾回复 = (bonus.护盾回复 || 0) + (Number(xta.value) || 0);
        const xtb = (playerData.buffs || []).find((b: any) => b && b.name === 'xtb');
        if (xtb) bonus.护盾回复2 = (bonus.护盾回复2 || 0) + (Number(xtb.value) || 0);
        break;
      }
      case '7': { // 阿尔缇娜（原版 L2158-2176）：冰伤2+25、攻击2+18；闪避2+25+技能；a格挡/a格挡2/a模式
        bonus.冰伤2 = (bonus.冰伤2 || 0) + 25;
        bonus.攻击2 = (bonus.攻击2 || 0) + 18;
        // a格挡2增益：穿透+15、贯穿+15（原版 L2161-2164）
        if ((playerData.buffs || []).some((b: any) => b && b.name === 'a格挡2')) {
          this.bonusService.addPenetration(bonus, 15);
          bonus.贯穿 = (bonus.贯穿 || 0) + 15;
        }
        // a格挡增益：攻击2 + 增益值×5、暴伤 + 增益值×10（原版 L2165-2169）
        const aBlock = (playerData.buffs || []).find((b: any) => b && b.name === 'a格挡');
        if (aBlock) {
          const a1 = Number(aBlock.value) || 0;
          bonus.攻击2 = (bonus.攻击2 || 0) + a1 * 5;
          bonus.暴击伤害 = (bonus.暴击伤害 || 0) + a1 * 10;
        }
        // a模式（原版 L2170-2175）：a模式=0 攻击2+25+技能+穿透15；否则 生命2+1.25+技能
        const aMode = this.playerService.getMarkerValue(markers, 'a模式');
        if (!aMode || aMode === 0) {
          bonus.攻击2 = (bonus.攻击2 || 0) + 25 + skillLevel;
          this.bonusService.addPenetration(bonus, 15);
        } else {
          bonus.生命2 = (bonus.生命2 || 0) + 1.25 + skillLevel;
        }
        bonus.闪避2 = (bonus.闪避2 || 0) + 25 + skillLevel;
        break;
      }
      case '22': { // 普拉娜（原版 L1761-1763/L1684-1708）：武器冷却×10；好感≥60 甩枪穿透；好感≥100 标记武器熟练
        // 武器冷却×10 在武器层面处理（getWeaponData 中），此处处理好感特效
        if ((player.affinity || 0) >= 60) {
          // 好感≥80：甩枪穿透增益（原版 L1693-1695：标记2 甩枪 +20，持续1+技能×0.01秒）
          if ((player.affinity || 0) >= 80) {
            bonus.贯穿 = (bonus.贯穿 || 0) + 20;
          }
        }
        break;
      }
      case '23': { // 兰音（原版 L2570-2586 + L2409-2464 反转童话被动）：兰音模式判断（攻击/速度模式）+ 魅力×1.5 + 负数反转
        // 原版：增幅器伤害系 vs 命中闪避系 比较 → 兰音模式1（攻击）/2（速度）；命中/闪避互相补齐
        if ((player.affinity || 0) > 0) {
          const dmgStats = (bonus.火伤2 || 0) + (bonus.攻击2 || 0) + (bonus.电伤2 || 0);
          const accStats = (bonus.命中2 || 0) + (bonus.闪避2 || 0);
          if (dmgStats > accStats) {
            // 攻击模式：火/电伤互相补齐×1.1
            if ((bonus.火伤 || 0) > (bonus.电伤 || 0)) {
              bonus.电伤 = (bonus.火伤 || 0) * 1.1;
            } else {
              bonus.火伤 = (bonus.电伤 || 0) * 1.1;
            }
          } else {
            // 速度模式：命中/闪避互相补齐×1.25
            if ((bonus.命中 || 0) > (bonus.闪避 || 0)) {
              bonus.闪避 = (bonus.命中 || 0) * 1.25;
            } else {
              bonus.命中 = (bonus.闪避 || 0) * 1.25;
            }
          }
        }
        // 魅力×1.5（原版 L2586）
        bonus.魅力 = (bonus.魅力 || 0) * 1.5;
        // 反转童话被动（原版 L2409-2464）：好感≥80 时，护盾/装甲/生命为负则反转，
        // 每次独立冷却60秒；好感<80 时负数清零。
        // 注意：该逻辑在 _计算玩家 中位于"回复结算之后"（L2409），依赖当前值，
        // 此处同步实现对当前护盾/装甲/生命就地修正。
        if ((player.affinity || 0) >= 80) {
          const markers2List = Array.isArray(playerData.markers2) ? playerData.markers2 : [];
          const hasCd = (key: string) => markers2List.some((m: any) => m && m.name === key && (Date.now() / 1000) < (m.expireAt || 0));
          // 原版 L2434-2462 翻转成功时同步写 玩家.额外文本（_主程序 L12033 追加到指令回包）：
          // "#换行(护盾负数,已反转)" / "(装甲负数,已反转)" / "(生命负数,已反转)"
          // 统一用数组形态承载（与 计算增益 啾啾猫猫/银龙附体 的写法一致）
          const extraArr: string[] = Array.isArray((bonus as any).额外文本)
            ? (bonus as any).额外文本
            : ((bonus as any).额外文本 ? [String((bonus as any).额外文本)] : []);
          if ((player.shield || 0) < 0) {
            if (!hasCd('fz护盾')) {
              player.shield = -(player.shield || 0);
              extraArr.push('(护盾负数,已反转)');
            } else {
              player.shield = 0;
            }
          }
          if ((player.armor || 0) < 0) {
            if (!hasCd('fz装甲')) {
              player.armor = -(player.armor || 0);
              extraArr.push('(装甲负数,已反转)');
            } else {
              player.armor = 0;
            }
          }
          if ((player.hp || 0) < 0) {
            if (!hasCd('fz生命')) {
              player.hp = -(player.hp || 0);
              extraArr.push('(生命负数,已反转)');
            } else {
              player.hp = 0;
            }
          }
          (bonus as any).额外文本 = extraArr;
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
        scaleAll('攻击'); scaleAll('攻击2');
        scaleAll('生命'); scaleAll('生命2');
        scaleAll('护盾'); scaleAll('护盾2');
        scaleAll('装甲'); scaleAll('装甲2');
        scaleAll('物伤'); scaleAll('物伤2');
        scaleAll('火伤'); scaleAll('火伤2');
        scaleAll('冰伤'); scaleAll('冰伤2');
        scaleAll('电伤'); scaleAll('电伤2');
        scaleAll('闪避'); scaleAll('闪避2');
        scaleAll('命中'); scaleAll('命中2');
        if ((player.affinity || 0) >= 80) {
          bonus.护盾 = (bonus.护盾 || 0) * (1 + skillLevel * 0.03);
          const shBonus = (bonus.护盾 || 0) * 0.15;
          bonus.物伤 = (bonus.物伤 || 0) + shBonus;
          bonus.火伤 = (bonus.火伤 || 0) + shBonus;
          bonus.电伤 = (bonus.电伤 || 0) + shBonus;
          bonus.冰伤 = (bonus.冰伤 || 0) + shBonus;
        }
        break;
      }
      default:
        break;
    }

    // 尝试合并装备加成
    // 存量装备物品通常只有 name/data（加成编码在 data 串中，自带加成在静态装备定义），
    // 必须先解析出 bonus（附加加成）与 baseBonus（自带加成）再并入总属性，
    // 否则穿戴装备后面板属性不会变化。
    try {
      const equips = playerData.equipment?.length
        ? playerData.equipment
        : this.playerService.safeJsonParse<any[]>(player.equipment, []);
      for (const equip of equips) {
        const resolved = this.resolveItemBonus(equip);
        if (resolved.bonus && Object.keys(resolved.bonus).length) {
          Object.assign(bonus, this.bonusService.mergeBonus(bonus, resolved.bonus));
        }
        if (resolved.baseBonus && Object.keys(resolved.baseBonus).length) {
          Object.assign(bonus, this.bonusService.mergeBonus(bonus, resolved.baseBonus));
        }
      }
      // 当前武器的附加加成并入总属性（currentWeapon 为 1-based，0=拳头无加成）。
      // 注意：不合并 weapon.baseBonus（自带加成）。baseBonus 是供套装判断2
      // 写入等级加成的引用字段（如高斯步枪 baseBonus.物伤 5→25），不应直接累
      // 进 total bonus——否则套装在 baseBonus 上叠加的等级加成会与已合并的原始值
      // 双重计数（如高斯步枪物伤多算 5）。baseBonus 的数值仅用于麻醉判定等特定场景。
      const cwIdx = Number(player.currentWeapon || 0);
      const weaponList = playerData.weapons?.length
        ? playerData.weapons
        : this.playerService.safeJsonParse<any[]>(player.weapons, []);
      if (cwIdx > 0 && weaponList[cwIdx - 1]) {
        const resolved = this.resolveItemBonus(weaponList[cwIdx - 1]);
        if (resolved.bonus && Object.keys(resolved.bonus).length) {
          Object.assign(bonus, this.bonusService.mergeBonus(bonus, resolved.bonus));
        }
      }
    } catch {
      // 忽略装备解析错误
    }

    // ========== 套装加成（对应原版 _计算玩家 L2284 套装判断2 L3381-3444） ==========
    // 黑花嫁/白花嫁4件套、暴击熟练度→暴伤、武器等级加成（高斯步枪等+等级×2）
    try {
      const sets = this.playerService.safeJsonParse<any>(player.sets, {});
      const weapons = playerData.weapons || this.playerService.safeJsonParse<any[]>(player.weapons, []);
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

    // ========== 法宝加成（对应原版 法宝加成 L3143-3232、法宝加成2 L3053-3096） ==========
    try {
      const sets = this.playerService.safeJsonParse<any>(player.sets, {});
      this.bonusService.calculateTreasureBonus(bonus, sets);
      this.bonusService.calculateHanGuangBonus(bonus, sets);
    } catch (err: any) {
      this.logger.warn(`法宝加成计算失败: ${err.message}`);
    }

    // ========== 计算增益（对应原版 加成计算.ecode L81-L575） ==========
    try {
      this.bonusService.calculateGameBonus({
        bonus,
        attributes: bonus,
        markers,
        buffs: playerData.buffs || [],
        equipment: playerData.equipment || this.playerService.safeJsonParse<any[]>(player.equipment, []),
        weapons: playerData.weapons || this.playerService.safeJsonParse<any[]>(player.weapons, []),
        currentWeapon: player.currentWeapon,
        level: lv,
        skillLevel,
        affinity: player.affinity,
        sets: this.playerService.safeJsonParse<SetData>(player.sets, {}),
        currentHp: player.hp,
      }, Date.now() / 1000);
    } catch (err: any) {
      this.logger.warn(`计算增益处理失败: ${err.message}`);
    }

    // ========== 好感追加分支（对应原版 _计算玩家 L2285-2315） ==========
    // 好感≥20：启木之本樱 命中+=物伤×0.05 且 物伤=0（原版 L2286-2291）
    // 好感≥80：安克雷奇 命中+=生命/100、闪避=命中+生命/100（L2293-2295）；星尘 护盾回复+=(护盾-当前护盾)/100（L2299-2303）
    // 好感≥100：长萌 装甲回复+=(装甲-当前装甲)/100（L2305-2309）
    if ((player.affinity || 0) >= 20) {
      if (seq === 18) { // 启木之本樱
        bonus.命中 = (bonus.命中 || 0) + (bonus.物伤 || 0) * 0.05;
        bonus.物伤 = 0;
      }
      if ((player.affinity || 0) >= 80) {
        if (seq === 17) { // 安克雷奇
          bonus.命中 = (bonus.命中 || 0) + (bonus.生命 || 0) / 100;
          bonus.闪避 = (bonus.命中 || 0) + (bonus.生命 || 0) / 100;
        }
        if (seq === 14) { // 星尘
          bonus.护盾回复 = (bonus.护盾回复 || 0) + ((bonus.护盾 || 0) - (player.shield || 0)) / 100;
        }
        if ((player.affinity || 0) >= 100) {
          if (seq === 2) { // 长萌
            bonus.装甲回复 = (bonus.装甲回复 || 0) + ((bonus.装甲 || 0) - (player.armor || 0)) / 100;
          }
        }
      }
    }

    // ========== 阿尔缇娜 a模式=1 全抗+50、生命+=四伤、四伤=1（原版 L2316-2328） ==========
    if (seq === 7 && this.playerService.getMarkerValue(markers, 'a模式') === 1) {
      bonus.生命全抗 = (bonus.生命全抗 || 0) + 50;
      bonus.装甲全抗 = (bonus.装甲全抗 || 0) + 50;
      bonus.护盾全抗 = (bonus.护盾全抗 || 0) + 50;
      bonus.生命 = (bonus.生命 || 0) + (bonus.物伤 || 0) + (bonus.冰伤 || 0) + (bonus.火伤 || 0) + (bonus.电伤 || 0);
      bonus.物伤 = 1;
      bonus.冰伤 = 1;
      bonus.火伤 = 1;
      bonus.电伤 = 1;
    }

    // ========== 套装植入体 1-4 对应属性伤×1.25（原版 L2329-2339） ==========
    try {
      const sets = this.playerService.safeJsonParse<any>(player.sets, {});
      if (sets.implant === 1) bonus.物伤 = (bonus.物伤 || 0) * 1.25;
      if (sets.implant === 2) bonus.火伤 = (bonus.火伤 || 0) * 1.25;
      if (sets.implant === 3) bonus.冰伤 = (bonus.冰伤 || 0) * 1.25;
      if (sets.implant === 4) bonus.电伤 = (bonus.电伤 || 0) * 1.25;
      // 攻击模式==1：闪避=1（原版 L2340-2342）
      if (sets.attackMode === 1) bonus.闪避 = 1;
      // 晚礼服≥4 且非兰音：魅力×1.5（原版 L2590-2595）
      if ((sets.eveningGown || 0) >= 4 && seq !== 23) {
        bonus.魅力 = (bonus.魅力 || 0) * 1.5;
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
      if ((sets.scientist || 0) >= 4) bonus.生产力 = (bonus.生产力 || 0) + 5;
    } catch (err: any) {
      this.logger.warn(`套装追加处理失败: ${err.message}`);
    }

    // ========== 三回复 /10（原版 L2343-2345） ==========
    bonus.生命回复 = (bonus.生命回复 || 0) / 10;
    bonus.装甲回复 = (bonus.装甲回复 || 0) / 10;
    bonus.护盾回复 = (bonus.护盾回复 || 0) / 10;

    // ========== 脏弹/核废料（原版 L2362-2382） ==========
    const pBuffs = playerData.buffs || [];
    if (pBuffs.some((b: any) => b && b.name === '脏弹')) {
      bonus.生命回复 = 0;
      bonus.生命回复2 = 0;
      bonus.装甲回复 = (bonus.装甲回复 || 0) / 2;
      bonus.装甲回复2 = (bonus.装甲回复2 || 0) / 2;
    } else {
      // 携带核废料且600秒间隔内无法回复生命（原版 L2368-2380）
      const backpack = this.playerService.safeJsonParse<any[]>(player.backpack, []);
      if (backpack.some((it: any) => it && it.name === '核废料' && (it.count || 0) > 0)) {
        bonus.生命回复 = 0;
        bonus.生命回复2 = 0;
      }
    }

    // ========== 战斗宙斯盾/抗穿透护盾（原版 L2523-2535） ==========
    // 当前护盾≥75% 且装备战斗宙斯盾：抗贯穿+100；当前护盾≥5% 且装备抗穿透护盾：抗贯穿+100
    try {
      const equips = this.playerService.safeJsonParse<any[]>(player.equipment, []);
      const hasEquip = (name: string) => equips.some((e: any) => e && e.name === name);
      if ((player.shield || 0) >= (bonus.护盾 || 0) * 0.75 && hasEquip('战斗宙斯盾')) {
        bonus.抗贯穿 = (bonus.抗贯穿 || 0) + 100;
      }
      if ((player.shield || 0) >= (bonus.护盾 || 0) * 0.05 && hasEquip('抗穿透护盾')) {
        bonus.抗贯穿 = (bonus.抗贯穿 || 0) + 100;
      }
    } catch {
      // 忽略装备解析错误
    }

    // ========== 闪避<1 → 1（原版 L2536-2538） ==========
    if ((bonus.闪避 || 0) < 1) bonus.闪避 = 1;

    // ========== 纯洁无瑕/破刃之剑（原版 L2542-2559） ==========
    // 装备特效要求 + 未被击败/被击败 状态判定（标记2 "被击败"）
    try {
      const equips = this.playerService.safeJsonParse<any[]>(player.equipment, []);
      const hasEffect = (effect: string) => equips.some((e: any) => e && e.forcedEffect === effect || e && e.特效 === effect);
      const markers2List = Array.isArray(playerData.markers2) ? playerData.markers2 : [];
      const defeated = markers2List.some((m: any) => m && m.name === '被击败');
      if (hasEffect('纯洁无瑕') && !defeated) {
        bonus.魅力 = (bonus.魅力 || 0) + 25;
        this.addAttackBonusPercent(bonus, 25);
        bonus.命中 = (bonus.命中 || 0) * 1.25;
        bonus.闪避 = (bonus.闪避 || 0) * 1.25;
      }
      if (hasEffect('破刃之剑') && defeated) {
        bonus.魅力 = (bonus.魅力 || 0) + 5;
        this.addAttackBonusPercent(bonus, 5);
        bonus.命中 = (bonus.命中 || 0) * 1.05;
        bonus.闪避 = (bonus.闪避 || 0) * 1.05;
      }
    } catch {
      // 忽略装备解析错误
    }

    // ========== 卷土重来/线圈减伤（原版 L2596-2608） ==========
    // 卷土重来增益 或 套装线圈>0：闪避=1、四伤÷2
    // 注意原版 L2599/L2605 疑似笔误：火伤=冰伤/2、冰伤=火伤/2（交叉赋值），按原版保留
    if (pBuffs.some((b: any) => b && b.name === '卷土重来')) {
      bonus.闪避 = 1;
      bonus.物伤 = (bonus.物伤 || 0) / 2;
      bonus.火伤 = (bonus.冰伤 || 0) / 2; // 原版 L2599，疑似笔误（应为火伤/2），按原版保留
      bonus.电伤 = (bonus.电伤 || 0) / 2;
      bonus.冰伤 = (bonus.火伤 || 0) / 2; // 原版 L2601，疑似笔误（应为冰伤/2），按原版保留
    }
    try {
      const sets = this.playerService.safeJsonParse<any>(player.sets, {});
      if ((sets.coil || 0) > 0) {
        bonus.物伤 = (bonus.物伤 || 0) / 2;
        bonus.火伤 = (bonus.冰伤 || 0) / 2; // 原版 L2605，疑似笔误，按原版保留
        bonus.电伤 = (bonus.电伤 || 0) / 2;
        bonus.冰伤 = (bonus.火伤 || 0) / 2; // 原版 L2607，疑似笔误，按原版保留
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
        bonus.物伤2 = (bonus.物伤2 || 0) * 1.05;
      }
      if (petCount > 0) {
        if (seq === 10 && (player.affinity || 0) >= 80) { // 小樱 团结友爱
          bonus.攻击2 = (bonus.攻击2 || 0) + petCount * 10;
        }
        if (seq === 16) { // 军姬 森罗万象
          bonus.攻击2 = (bonus.攻击2 || 0) + petCount * 10;
          bonus.生命全抗 = (bonus.生命全抗 || 0) + 5 * petCount;
          bonus.装甲全抗 = (bonus.装甲全抗 || 0) + 5 * petCount;
          bonus.护盾全抗 = (bonus.护盾全抗 || 0) + 5 * petCount;
        }
        if (c > 0) {
          if (c > 2) c = 2;
          bonus.攻击2 = (bonus.攻击2 || 0) + c * 10;
          bonus.命中2 = (bonus.命中2 || 0) + c * 10;
          bonus.闪避2 = (bonus.闪避2 || 0) + c * 10;
        }
        if (d > 0) {
          if (d > 2) d = 2;
          bonus.贯穿 = (bonus.贯穿 || 0) + 5 * d;
          bonus.暴击伤害 = (bonus.暴击伤害 || 0) + 75 * d;
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
        if ((bonus.电伤 || 0) > (bonus.火伤 || 0)) {
          if ((bonus.电伤 || 0) > (bonus.冰伤 || 0)) {
            bonus.电伤2 = (bonus.电伤2 || 0) + 10;
          } else {
            bonus.冰伤2 = (bonus.冰伤2 || 0) + 10;
          }
        } else if ((bonus.火伤 || 0) > (bonus.冰伤 || 0)) {
          bonus.火伤2 = (bonus.火伤2 || 0) + 10;
        } else {
          bonus.冰伤2 = (bonus.冰伤2 || 0) + 10;
        }
      }
      // 套装一拳==4：攻击2+25、全部武器锁定+5（原版 L2239-2244）
      const sets = this.playerService.safeJsonParse<any>(player.sets, {});
      if ((sets.onePunch || 0) === 4) {
        bonus.攻击2 = (bonus.攻击2 || 0) + 25;
        const weaponsD = this.playerService.safeJsonParse<any[]>(player.weapons, []);
        for (const w of weaponsD) {
          if (w) w.lockTime = (w.lockTime || 0) + 5;
        }
      }
    } catch {
      // 忽略装备解析错误
    }

    // ========== 计算增益（对应原版 _计算玩家 末尾 + 计算buff L3097-3142） ==========
    // 原版 _计算玩家 删除过期增益(L1864-1871)后，由 计算buff() 把活跃增益并入玩家属性：
    //   - mqtx/湮灭/削弱闪避/xla/xlb/xlc 特殊效果
    //   - default 分支：在"增益列表"按名称查找，将其加成按增益模式叠加到玩家属性
    // 本框架增益列表定义在 buffs.json（bonus 字段为字符串化 JSON，需解析为 BonusData）。
    try {
      const playerBuffs: any[] = playerData.buffs || [];
      if (playerBuffs.length > 0) {
        const nowSec = Date.now() / 1000;
        // buffs.json 的 bonus 字段已是中文 key（与 BonusData 全中文一致），直接解析使用，无需中英文映射。
        const buffDefs: any[] = this.staticData.getAllBuffs().map((d: any) => ({
          name: d.name,
          bonus: d.bonus ? (typeof d.bonus === 'string' ? this.playerService.safeJsonParse<BonusData>(d.bonus, {}) : d.bonus) : {},
        }));
        this.bonusService.calculateBuffs(
          bonus,                 // 属性对象（原版 玩家.属性）
          playerBuffs,          // 玩家活跃增益
          buffDefs,             // 增益列表定义
          nowSec,               // 当前时间戳（秒）
          {
            currentAnesthesia: (bonus.麻醉 || 0), // 原版 玩家.套装.当前麻醉；框架未独立建模麻醉量，用属性麻醉上限近似
            bonus,              // 增益模式叠加目标（原版 玩家.属性 与 玩家.加成 分离，本框架合并）
          },
        );
      }
    } catch (err: any) {
      this.logger.warn(`计算增益失败: ${err.message}`);
    }

    // ========== 最终加成（对应原版 _计算玩家 末尾 calculateFinalBonus 调用） ==========
    // 原版将"玩家.属性"(基础)与"玩家.加成"(装备/套装/增益累加)分离，
    // 最后调用 calculateFinalBonus(玩家.属性, 玩家.加成) 合并：
    //   - 四系伤害 = (伤害 + 攻击) * (1 + 伤害2/100) * (1 + 攻击2/100)²
    //   - 速度/命中/闪避/护盾/装甲/生命 *= (1 + 对应2/100)²
    // 本框架将两者合并为同一 bonus 对象，需先抽取"2"字段和"攻击"为独立来源再合并。
    // 原版 target(属性) 不含攻击，攻击来自 source(加成)，故将攻击移入 source 后从 target 清零。
    try {
      const attackVal = bonus.攻击 || 0;
      const source2: BonusData = {
        攻击: attackVal,
        攻击2: bonus.攻击2 || 0,
        电伤2: bonus.电伤2 || 0,
        火伤2: bonus.火伤2 || 0,
        物伤2: bonus.物伤2 || 0,
        冰伤2: bonus.冰伤2 || 0,
        速度2: bonus.速度2 || 0,
        命中2: bonus.命中2 || 0,
        闪避2: bonus.闪避2 || 0,
        护盾2: bonus.护盾2 || 0,
        装甲2: bonus.装甲2 || 0,
        生命2: bonus.生命2 || 0,
        生命回复2: bonus.生命回复2 || 0,
        护盾回复2: bonus.护盾回复2 || 0,
        装甲回复2: bonus.装甲回复2 || 0,
      };
      // 将攻击和"2"字段从 target 清零，让 calculateFinalBonus 重新计算
      bonus.攻击 = 0;
      bonus.攻击2 = 0; bonus.电伤2 = 0; bonus.火伤2 = 0;
      bonus.物伤2 = 0; bonus.冰伤2 = 0;
      bonus.速度2 = 0; bonus.命中2 = 0; bonus.闪避2 = 0;
      bonus.护盾2 = 0; bonus.装甲2 = 0; bonus.生命2 = 0;
      bonus.生命回复2 = 0; bonus.护盾回复2 = 0; bonus.装甲回复2 = 0;
      this.bonusService.calculateFinalBonus(bonus, source2);
      // calculateFinalBonus 会把 source.攻击 累加回 target.攻击
    } catch (err: any) {
      this.logger.warn(`最终加成计算失败: ${err.message}`);
    }

    // 应用递减收益
    this.bonusService.applyAllDiminishingReturns(bonus);

    // 魅力影响活力上限和恢复速度，但历史上限只增不减；
    // 这里不直接写库，调用方的同一玩家快照会在后续 savePlayer 时落盘。
    const currentCharm = Number(bonus.魅力 || 0);
    const vitalityMarkers = playerData.markers || {};
    const recordedMax = Number(this.playerService.getMarkerValue(vitalityMarkers, '活力2')) || 0;
    const nextMax = Math.max(100, 100 + (Number.isFinite(currentCharm) ? currentCharm : 0), recordedMax);
    vitalityMarkers['活力2'] = nextMax;
    player.markers = JSON.stringify(vitalityMarkers);

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
    const atkBonus = (bonus.攻击 || 0) + (bonus.攻击加成 || 0);
    // 原版 (1 + 属性.攻击2/100) 中的"属性.攻击2"对应本框架 attack2（递减后）；
    // 这里简化取当前 bonus.攻击2（若已应用递减则用递减值，行为接近原版）。
    const atk2Factor = (1 + (bonus.攻击2 || 0) / 100);
    const mul = (dmg2: number) => (1 + (dmg2 || 0) / 100) * atk2Factor * attack2 / 100;
    bonus.电伤 = (bonus.电伤 || 0) + (atkBonus + (bonus.电伤 || 0) + (bonus.电伤2 || 0)) * mul(bonus.电伤2 || 0);
    bonus.物伤 = (bonus.物伤 || 0) + (atkBonus + (bonus.物伤 || 0) + (bonus.物伤2 || 0)) * mul(bonus.物伤2 || 0);
    bonus.冰伤 = (bonus.冰伤 || 0) + (atkBonus + (bonus.冰伤 || 0) + (bonus.冰伤2 || 0)) * mul(bonus.冰伤2 || 0);
    bonus.火伤 = (bonus.火伤 || 0) + (atkBonus + (bonus.火伤 || 0) + (bonus.火伤2 || 0)) * mul(bonus.火伤2 || 0);
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
    // 读取辅助：怪物三层抗性存于 bonus JSON（monsters.json 已是中文 key，如"生命物抗"）。
    // 优先顶层字段，回退到 bonus JSON 中文 key（本框架 BonusData 全中文，无需中英文兼容映射）。
    const pick = (k: string) => {
      if (monster[k] !== undefined) return monster[k];
      if (mb[k] !== undefined) return mb[k];
      return 0;
    };

    return {
      攻击: monster.attack || 0,
      命中: monster.hit || 85,
      闪避: monster.dodge || 5,
      生命: monster.hp || 0,
      护盾: (monster.shield !== undefined ? monster.shield : (monster.maxShield || 0)),
      装甲: (monster.armor !== undefined ? monster.armor : (monster.maxArmor || 0)),
      // 三层池抗性（原版护盾/装甲/生命各自独立），来自 bonus JSON
      护盾物抗: pick('护盾物抗'),
      护盾火抗: pick('护盾火抗'),
      护盾冰抗: pick('护盾冰抗'),
      护盾电抗: pick('护盾电抗'),
      护盾全抗: pick('护盾全抗'),
      装甲物抗: pick('装甲物抗'),
      装甲火抗: pick('装甲火抗'),
      装甲冰抗: pick('装甲冰抗'),
      装甲电抗: pick('装甲电抗'),
      装甲全抗: pick('装甲全抗'),
      生命物抗: pick('生命物抗'),
      生命火抗: pick('生命火抗'),
      生命冰抗: pick('生命冰抗'),
      生命电抗: pick('生命电抗'),
      生命全抗: pick('生命全抗'),
      护盾伤害上限: pick('护盾伤害上限') || 100,
      装甲伤害上限: pick('装甲伤害上限') || 100,
      生命伤害上限: pick('生命伤害上限') || 100,
      // 贯穿几率/抗贯穿（原版 贯穿判断 L3192：几率判断(攻击方.贯穿-防御方.抗贯穿)）
      贯穿: mb['贯穿'] !== undefined ? mb['贯穿'] : (monster.penetrate || 0),
      抗贯穿: mb['抗贯穿'] !== undefined ? mb['抗贯穿'] : (monster.antiPenetrate || 0),
      // 怪物四属性伤害（对应原版 _初始化怪物 属性构建，monsters.json bonus 中文 key：物伤/火伤/冰伤/电伤）
      物伤: pick('物伤') || 0,
      火伤: pick('火伤') || 0,
      冰伤: pick('冰伤') || 0,
      电伤: pick('电伤') || 0,
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
    // 注：bonus.贯穿 为原版"贯穿几率"，不计入抗性穿透，三层穿透各自独立
    return {
      shield: bonus.护盾穿透 || 0,
      armor: bonus.装甲穿透 || 0,
      life: bonus.生命穿透 || 0,
    };
  }

  /**
   * 单层池抗性减免计算
   * 对应原版（以护盾层为例，攻击目标() 子程序）：
   *   造成物伤 = 剩余物伤 * (1 - 防御方.护盾物抗/100 * (1 - (攻击方.护盾穿透 + 盾穿.物)/100))
   * 三层池各自独立使用自己的抗性与穿透，互不干扰
   *
   * @param breakdown 该层池入场前的四属性伤害
   * @param resPrefix 抗性字段前缀：'护盾' | '装甲' | 'life'
   * @param allRes 该层全抗
   * @param pen 该层穿透值
   */
  private applyLayerResistances(
    breakdown: DamageBreakdown,
    defBonus: BonusData,
    resPrefix: '护盾' | '装甲' | 'life',
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
    const lifePrefix = resPrefix === 'life' ? '生命' : resPrefix;
    const physKey = `${lifePrefix}物抗`;
    const fireKey = `${lifePrefix}火抗`;
    const iceKey = `${lifePrefix}冰抗`;
    const elecKey = `${lifePrefix}电抗`;
    const readResist = (key: string) => Number(
      (defBonus as any)[key]
      ?? (defBonus as any)[key.replace('抗', 'Res')]
      ?? (defBonus as any)[`${key.slice(0, -1)}${key.endsWith('火抗') ? 'Fire' : key.endsWith('冰抗') ? 'Ice' : key.endsWith('电抗') ? 'Elec' : 'Phys'}Res`]
      ?? 0,
    ) || 0;
    const physRes = calcRes(readResist(physKey));
    const fireRes = calcRes(readResist(fireKey));
    const iceRes = calcRes(readResist(iceKey));
    const elecRes = calcRes(readResist(elecKey));

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
      breakdown, defBonus, '护盾', defBonus.护盾全抗 || 0, penetration.shield,
    );
    const armorResisted = this.applyLayerResistances(
      breakdown, defBonus, '装甲', defBonus.装甲全抗 || 0, penetration.armor,
    );
    const lifeResisted = this.applyLayerResistances(
      breakdown, defBonus, 'life', defBonus.生命全抗 || 0, penetration.life,
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
    vampireTrue?: { value: number },
  ): PoolDamage {
    const sum = (b: DamageBreakdown) => b.physical + b.fire + b.ice + b.elec;
    const scale = (b: DamageBreakdown, r: number): DamageBreakdown => ({
      physical: b.physical * r, fire: b.fire * r, ice: b.ice * r, elec: b.elec * r,
    });

    // 各池当前血量
    const currentShield = defBonus.护盾 || 0;
    const currentArmor = defBonus.装甲 || 0;
    const currentHp = defBonus.生命 || 0;

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
    let shieldDmg = sum(resisted.shield) * (1 + (atkBonus.攻击护盾 || 0) / 100);
    // 吸血姬真伤·护盾层（原版 L4175-4190）：伤害<当前护盾时真伤并入，超出部分结转下层
    if (vampireTrue && vampireTrue.value > 0 && shieldDmg < currentShield) {
      if (shieldDmg + vampireTrue.value > currentShield) {
        vampireTrue.value = vampireTrue.value - currentShield + shieldDmg;
        shieldDmg = currentShield + 1; // L4180 不加上的话破盾就不继续了
      } else {
        shieldDmg += vampireTrue.value;
        vampireTrue.value = 0;
      }
    }
    if (shieldDmg > 0) {
      pool.shield = Math.min(shieldDmg, currentShield);
      // 溢出比例（原版 剩余伤害 = (伤害 - 当前护盾) / 伤害），缩放"原始剩余四属性伤害"
      const overflowRatio = shieldDmg > currentShield
        ? (shieldDmg - currentShield) / shieldDmg
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
    let armorDmg = sum(armorLayer) * (1 + (atkBonus.攻击装甲 || 0) / 100);
    // 吸血姬真伤·装甲层（原版 L4312-4327）：伤害<当前装甲时真伤并入，超出部分结转下层
    if (vampireTrue && vampireTrue.value > 0 && armorDmg < currentArmor) {
      if (armorDmg + vampireTrue.value > currentArmor) {
        vampireTrue.value = vampireTrue.value - currentArmor + armorDmg;
        armorDmg = currentArmor + 1; // L4317 不加上的话破甲就不继续了
      } else {
        armorDmg += vampireTrue.value;
        vampireTrue.value = 0;
      }
    }
    if (armorDmg > 0) {
      pool.armor = Math.min(armorDmg, currentArmor);
      const overflowRatio = armorDmg > currentArmor
        ? (armorDmg - currentArmor) / armorDmg
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
    let hpDmg = sum(lifeLayer) * (1 + (atkBonus.攻击生命 || 0) / 100);
    // 吸血姬真伤·生命层（原版 L4453-4463）：伤害<当前生命时并入，最底层不再结转
    if (vampireTrue && vampireTrue.value > 0 && hpDmg < currentHp) {
      if (hpDmg + vampireTrue.value > currentHp) {
        vampireTrue.value = vampireTrue.value - currentHp + hpDmg;
        hpDmg = currentHp;
      } else {
        hpDmg += vampireTrue.value;
        vampireTrue.value = 0;
      }
    }
    if (hpDmg > 0) {
      // 生命为最底层：扣 min(伤害, 当前生命)，溢出（伤害>生命）即击杀，不再传递
      pool.hp = Math.min(hpDmg, currentHp);
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
    const currentShield = monster.shield !== undefined ? monster.shield : (monster.maxShield || 0);
    const currentArmor = monster.armor !== undefined ? monster.armor : (monster.maxArmor || 0);
    const shieldDmg = Math.min(poolDamage.shield, currentShield);
    const armorDmg = Math.min(poolDamage.armor, currentArmor);
    const hpDmg = Math.min(poolDamage.hp, monster.hp || 0);

    // 更新怪物状态
    if (monster.shield !== undefined) {
      monster.shield = Math.max(0, (monster.shield || 0) - shieldDmg);
    }
    if (monster.armor !== undefined) {
      monster.armor = Math.max(0, (monster.armor || 0) - armorDmg);
    }
    monster.hp = Math.max(0, (monster.hp || 0) - hpDmg);

    // 猩红积累（战斗相关.ecode L3854-3859）：防御方带活跃猩红增益时，
    // 本次总伤害（上限=三池当前总和）累计入防御方"猩红"熟练度，供真伤释放。
    if (totalDamage > 0) {
      try {
        const mBuffs: any[] = typeof monster.buffs === 'string' ? JSON.parse(monster.buffs || '[]') : (monster.buffs || []);
        const nowMs = Date.now();
        const hasScarletBuff = mBuffs.some((b: any) => {
          if (!b) return false;
          if ((b.名称 ?? b.name) !== '猩红') return false;
          const rawExpire = Number(b.有效期至 ?? b.expireAt ?? 0);
          const expireMs = rawExpire > 0 && rawExpire < 1e12 ? rawExpire * 1000 : rawExpire;
          return expireMs > nowMs;
        });
        if (hasScarletBuff) {
          const mMarkers: Record<string, any> = typeof monster.markers === 'string'
            ? JSON.parse(monster.markers || '{}')
            : (monster.markers || {});
          const stateCap = (monster.hp || 0) + (currentArmor || 0) + (currentShield || 0);
          mMarkers['猩红'] = (Number(mMarkers['猩红'] ?? 0) || 0) + Math.min(totalDamage, stateCap);
          monster.markers = typeof monster.markers === 'string' ? JSON.stringify(mMarkers) : mMarkers;
        }
      } catch {
        /* 标记/增益解析失败时跳过积累 */
      }
    }

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
          bonus: monster.bonus,
          markers: monster.markers,
          markers2: monster.markers2,
          buffs: monster.buffs,
        });
        return;
      }
      await this.mapService.updateMonsterFields(mapId, monsterId, {
        hp: monster.hp,
        shield: monster.shield,
        armor: monster.armor,
        bonus: monster.bonus,
        markers: monster.markers,
        markers2: monster.markers2,
        buffs: monster.buffs,
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
   * 把地图 JSON 中的召唤物/怪物运行时对象适配为 PlayerData 视图。
   * 原版所有攻击方都使用同一个“玩家”结构体；当前数据库把怪物字段拆开，
   * 这里仅做字段别名与 JSON 解析，不改变结算顺序或数值。
   */
  private createRuntimeActorData(actor: any): PlayerData {
    const parse = <T>(value: any, fallback: T): T => {
      if (value === undefined || value === null) return fallback;
      if (typeof value !== 'string') return value as T;
      return this.playerService.safeJsonParse<T>(value, fallback);
    };
    const array = (value: any): any[] => {
      const parsed = parse<any>(value, []);
      return Array.isArray(parsed) ? parsed : [];
    };

    const equipment = array(actor.equipment ?? actor.equipments ?? actor.装备);
    const weapons = array(actor.weapons ?? actor.武器);
    const backpack = array(actor.backpack ?? actor.背包);
    const markers2 = array(actor.markers2 ?? actor.标记2);
    const buffs = array(actor.buffs ?? actor.增益);
    const tasks = array(actor.tasks ?? actor.任务);
    const safeBox = array(actor.safeBox ?? actor.保险柜);
    const markers = this.normalizeMarkerObject(actor.markers ?? actor.标记 ?? {});

    // 后续通用结算代码读取英文存量字段；没有英文字段时补上 JSON 视图。
    if (actor.equipment === undefined) actor.equipment = JSON.stringify(equipment);
    if (actor.weapons === undefined) actor.weapons = JSON.stringify(weapons);
    if (actor.backpack === undefined) actor.backpack = JSON.stringify(backpack);
    if (actor.markers2 === undefined) actor.markers2 = JSON.stringify(markers2);
    if (actor.buffs === undefined) actor.buffs = JSON.stringify(buffs);
    if (actor.markers === undefined) actor.markers = JSON.stringify(markers);
    if (actor.sets === undefined && actor.set !== undefined) actor.sets = actor.set;

    return {
      player: actor,
      backpack,
      equipment,
      weapons,
      markers,
      markers2,
      buffs,
      tasks,
      safeBox,
      sets: parse<any>(actor.sets ?? actor.set ?? {}, {}),
    };
  }

  /** 兼容少量历史武器配置中的英文加成字段。 */
  private toEnglishBonusKey(key: string): string {
    const keys: Record<string, string> = {
      攻击: 'attack', 攻击2: 'attack2', 命中: 'hit', 命中2: 'hit2',
      暴击: 'crit', 暴击伤害: 'critDmg', 物伤: 'physDmg', 物伤2: 'physDmg2',
      火伤: 'fireDmg', 火伤2: 'fireDmg2', 冰伤: 'iceDmg', 冰伤2: 'iceDmg2',
      电伤: 'elecDmg', 电伤2: 'elecDmg2', 贯穿: 'penetration',
    };
    return keys[key] || key;
  }

  /** 将运行时攻击方的状态写回 GameMonster 或地图召唤物数组。 */
  private async persistRuntimeActor(actor: any, map: any): Promise<void> {
    if (!actor) return;

    // GameMonster 是 Prisma 行，具有数值 id；召唤物是 map.summons 内的 JSON 对象。
    if (typeof actor.id === 'number' && actor.id > 0 && actor.mapId !== undefined) {
      await this.mapService.saveGameMonster(actor);
      return;
    }

    const summons = this.playerService.safeJsonParse<any[]>(map?.summons, []);
    const actorQQ = String(actor.qq ?? actor.QQ ?? '');
    const index = summons.findIndex((item: any) => String(item?.qq ?? item?.QQ ?? '') === actorQQ);
    if (index < 0) return;

    // 同步原版中文别名，避免后续战斗循环只看到旧快照。
    if (actor.当前生命 !== undefined || actor.hp !== undefined) actor.当前生命 = actor.hp;
    if (actor.当前护盾 !== undefined || actor.shield !== undefined) actor.当前护盾 = actor.shield;
    if (actor.当前装甲 !== undefined || actor.armor !== undefined) actor.当前装甲 = actor.armor;
    if (actor.增益 !== undefined) actor.增益 = this.playerService.safeJsonParse<any[]>(actor.buffs, []);
    if (actor.标记2 !== undefined) actor.标记2 = this.playerService.safeJsonParse<any[]>(actor.markers2, []);
    summons[index] = actor;
    await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });
  }

  /** 原版捕捉模式生命层文本：生命不扣除，但显示当前生命和“捕捉中”状态。 */
  private formatCaptureDamageText(
    totalDamage: number,
    poolDamage: PoolDamage,
    monster: any,
    showLife: boolean,
  ): string {
    const parts: string[] = [];
    if (poolDamage.shield > 0) parts.push(`护盾-${Math.floor(poolDamage.shield)}`);
    if (poolDamage.armor > 0) parts.push(`装甲-${Math.floor(poolDamage.armor)}`);
    if (showLife) parts.push(`生命-0(${Math.floor(monster.hp || 0)})(捕捉中)`);
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
   * 安全数值转换（原版 取数值 语义）
   * 非法/缺失值回落 0，供装备特效等字段兜底。
   * @param v 待转换值
   * @returns 数值；NaN/undefined/null 返回 0
   */
  private safeNum(v: any): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
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
      ((defBonus.护盾物抗 || 0) + (defBonus.装甲物抗 || 0) + (defBonus.生命物抗 || 0)) / 3;
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
   * 反转童话 触发端（战斗相关.ecode L378-440）
   * 兰音好感≥80 蓄势后：几率判断(50+技等/2) → a=取随机数(1,10)：
   *   目标已有 fzth<a> 增益 → 获得增益(fzth<a>, -86400, 真) 即移除；
   *   否则获得 fzth<a> 持续 600*库洛牌(1.25) 秒，并按 a==5/6 立即反转目标属性.装甲/护盾，
   *   属性翻负且当前值>0 时 添加成就("攻击者"+攻击方QQ, 当前装甲*2, 防御方.标记) 并把当前值翻负。
   * 文本：a==1 反转:盾抗 / 2 甲抗 / 3 血抗 / 4 闪避(写入文本变量) / 5 装甲 / 6 护盾 /
   *       7 回复 / 8 暴击 / 9 命中 / 默认 伤害；未过几率 → (反转:失败)。
   * @returns 特效文本（含括号），无蓄势时返回空
   */
  private applyReverseFairytale(attacker: any, target: any, reverseChance: number): string {
    let effectText = '';
    // 原版 几率判断(50 + 攻击方.技能等级/2)：reverseChance 由技能施放时按同一公式预置
    if (!(Math.random() * 100 < reverseChance)) {
      return '（反转:失败）';
    }
    // 库洛牌(specialSeq=99)：主动技能持续时间+25%（原版 L383-387）
    const equipment = this.safeParseJson<any[]>(attacker.equipment || '[]', []);
    const hasKulo = equipment.some(
      (e: any) => e && (e.specialSeq === 99 || String(e.name ?? e.名称 ?? '') === '库洛牌'),
    );
    const a1 = hasKulo ? 1.25 : 1;
    const a = Math.floor(Math.random() * 10) + 1;
    const buffName = `fzth${a}`;
    const tBuffs = this.safeParseJson<any[]>(target.buffs, []);
    const nowSec = Math.floor(Date.now() / 1000);
    const existing = tBuffs.find((b: any) => b && (b.name ?? b.名称) === buffName);
    if (existing) {
      // 原版 获得增益(-86400, 真)：重复获得就移除
      const idx = tBuffs.indexOf(existing);
      tBuffs.splice(idx, 1);
      target.buffs = JSON.stringify(tBuffs);
    } else {
      tBuffs.push({ name: buffName, expireAt: nowSec + Math.round(600 * a1) });
      target.buffs = JSON.stringify(tBuffs);
      if (a === 5 || a === 6) {
        // 原版 L393-409：反转目标 属性.装甲/护盾，并把正的当前值同步翻负计入成就
        const attrKey = a === 5 ? '装甲' : '护盾';
        const curKey = a === 5 ? 'armor' : 'shield';
        const bonus = this.safeParseJson<Record<string, any>>(target.bonus, {});
        bonus[attrKey] = -Number(bonus[attrKey] || 0);
        target.bonus = JSON.stringify(bonus);
        const currentVal = Number(target[curKey] ?? 0);
        if (bonus[attrKey] < 0 && currentVal > 0) {
          const tMarkers = this.safeParseJson<Record<string, number>>(target.markers, {});
          this.combatState.addAchievement(`攻击者${attacker.qqNumber ?? attacker.userId ?? ''}`, currentVal * 2, tMarkers);
          target.markers = JSON.stringify(tMarkers);
          target[curKey] = -currentVal;
        }
      }
    }
    // 类别文本（原版 L412-432；a==4 写入 文本 变量，此处统一并入特效文本）
    const label = ['盾抗', '甲抗', '血抗', '闪避', '装甲', '护盾', '回复', '暴击', '命中', '伤害'][a - 1];
    effectText += `（反转:${label}）`;
    return effectText;
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
    const skillLevel = this.skillLevelFromMarkers(markers, '军姬');
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
    const skillLevel = this.skillLevelFromMarkers(markers, '星尘');
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
    const skillLevel = this.skillLevelFromMarkers(markers, '小樱');

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
      const skillLevel = this.skillLevelFromMarkers(markers, '伊芙利特');
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
      const skillLevel = this.skillLevelFromMarkers(markers, '龙姬');
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
    const skillLevel = this.skillLevelFromMarkers(markers, '普拉娜');
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
        if (equip.bonus && equip.bonus.全体攻击) {
          return true;
        }
        if (equip.baseBonus && equip.baseBonus.全体攻击) {
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

    // 最多连击30次（对齐原版 武器攻击 L526-545 连击上限30）
    const MAX_COMBO = 30;
    if (state.comboCount >= MAX_COMBO) {
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
    this.logger.log(`安排自动连击 userId=${userId}, weapon=${weaponName}, combo=${state.comboCount}/${30}`);
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
  async applyMapBuffs(player: any, map: any): Promise<void> {
    try {
      const parseArray = (value: any): any[] => {
        if (Array.isArray(value)) return value;
        return this.playerService.safeJsonParse<any[]>(value, []);
      };
      const now = Date.now() / 1000;

      // mapBuffs 是原版地图“标记3”的持久化载体；没有有效期的静态增益按配置时长初始化。
      const mapBuffs = parseArray(map.mapBuffs).map((raw: any) => {
        const buff = { ...(raw || {}) };
        if (buff.name === undefined && buff.名称 !== undefined) buff.name = buff.名称;
        if (buff.strength === undefined && buff.强度 !== undefined) buff.strength = buff.强度;
        if (buff.strength === undefined && buff.value !== undefined) buff.strength = buff.value;
        const rawExpire = Number(buff.expireAt ?? buff.有效期至 ?? 0);
        if (Number.isFinite(rawExpire) && rawExpire > 0) {
          buff.expireAt = rawExpire > 1e12 ? rawExpire / 1000 : rawExpire;
        } else {
          const duration = Number(buff.duration ?? buff.持续时间 ?? 86400) || 86400;
          buff.expireAt = now + duration;
        }
        return buff;
      });

      // 原版地图标记离开地图即失效；兼容之前没有 source 标记的存量同名增益。
      let playerBuffs: any[] = parseArray(player.buffs);
      const configuredMapNames = new Set(
        mapBuffs.map((buff: any) => String(buff?.name ?? buff?.名称 ?? '')).filter(Boolean),
      );
      playerBuffs = playerBuffs.filter((buff: any) =>
        buff?.source !== 'mapBuff' && buff?.source !== 'mapMarker' && !configuredMapNames.has(String(buff?.name ?? '')),
      );

      const buildings = parseArray(map.buildings);
      const summons = parseArray(map.summons);
      const items = parseArray(map.items);
      const hatchRequests: Array<{ type: string; ownerQQ: string; createdAt: number; growthSeconds: number }> = [];

      // 一次调用贯通：建筑/召唤物产生地图增益，过期标记清理，孵蛋鸡到期孵化，
      // 以及剩余标记复制到玩家增益。对应原版 加成计算.ecode L577-L652。
      this.bonusService.getMapBonus(playerBuffs, {
        buildings,
        summons,
        items,
        markers3: mapBuffs,
        onHatch: (request) => hatchRequests.push(request),
      }, now, now);

      // getMapBonus 负责原版幼崽的物品/标记修改；这里把请求转换为可参与战斗的真实召唤物。
      let hatchIndex = 0;
      for (const request of hatchRequests) {
        const childQQ = `怪物${Date.now()}${Math.floor(Math.random() * 100000)}${hatchIndex++}g`;
        let child: any;
        try {
          child = await this.mapService.createMapSummonByName(map.id, request.type, {
            ownerQQ: request.ownerQQ,
            qq: childQQ,
          });
        } catch (error: any) {
          // 原版蛋对应的神兽都在静态怪物表；存量配置缺失时仍保留可管理的幼崽对象。
          this.logger.warn(`孵化${request.type}时未找到静态怪物定义，使用基础幼崽: ${error?.message}`);
          child = {
            name: request.type,
            type: request.type,
            qq: childQQ,
            ownerQQ: request.ownerQQ,
            level: 1,
            hp: 100,
            maxHp: 100,
            shield: 0,
            maxShield: 0,
            armor: 0,
            maxArmor: 0,
            attack: 10,
            defense: 0,
            speed: 100,
            dodge: 0,
            hit: 85,
            bonus: '{}',
            baseBonus: '{}',
            extraBonus: '{}',
            equipments: '[]',
            weapons: '[]',
            markers2: '[]',
            buffs: '[]',
            achievements: '[]',
            set: '{}',
            backpack: '[]',
          };
        }

        child.name = `${request.type}幼崽`;
        child.type = request.type;
        child.qq = childQQ;
        child.QQ = childQQ;
        child.ownerQQ = request.ownerQQ;
        child.归属 = request.ownerQQ;
        child.isPet = true;
        child.specialSeq = -2;
        child.affinity = 150;
        child.好感 = 150;
        child.markers = {
          [`好感${request.ownerQQ}`]: 150,
          时间2: request.createdAt,
          幼崽: Math.max(0, request.growthSeconds),
          跟随: 1,
          宝宝: 1,
        };
        child.标记 = child.markers;
        child.follow = false;
        child.mode = 'idle';
        summons.push(child);
      }

      const activeMapNames = new Set(
        mapBuffs.map((buff: any) => String(buff?.name ?? buff?.名称 ?? '')).filter(Boolean),
      );
      for (const buff of playerBuffs) {
        if (activeMapNames.has(String(buff?.name ?? ''))) {
          buff.source = 'mapBuff';
          buff.mapId = map.id;
        }
      }

      player.buffs = JSON.stringify(playerBuffs);
      if (typeof (this.playerService as any).savePlayer === 'function') {
        await (this.playerService as any).savePlayer(player);
      }

      await this.mapService.updateDynamicFields(map.id, {
        mapBuffs: JSON.stringify(mapBuffs),
        items: JSON.stringify(items),
        summons: JSON.stringify(summons),
      });
      map.mapBuffs = JSON.stringify(mapBuffs);
      map.items = JSON.stringify(items);
      map.summons = JSON.stringify(summons);

      this.logger.log(`应用地图增益 map=${map.name}, buffs=${mapBuffs.map((b: any) => b.name).join(',')}`);
    } catch (error) {
      this.logger.warn(`应用地图增益失败: ${error.message}`);
    }
  }

  // ==================== 宠物攻击真实结算 ====================

  /**
   * 宠物攻击怪物（逐次真实结算，对齐原版 宠物攻击() 子程序）
   * 原版宠物攻击并非概率胜率模型，而是走「武器攻击→造成伤害」同一套真实伤害链路：
   * 宠物作为攻击方对怪物发起一次攻击，经过命中→暴击→三层扣减（护盾→装甲→生命），
   * 命中则扣减怪物血量、击杀则发放掉落；未命中宠物不掉血；若怪物携带反伤则宠物受反弹伤害。
   *
   * @param pet 宠物/召唤物实例（含 name/hp/attack/defense/speed/type 等）
   * @param monster 目标怪物实例（GameMap 上的 MapMonster）
   * @param mapId 地图ID（用于击杀后写回怪物血量 / 掉落发放）
   * @param ownerUserId 宠物归属玩家ID（击杀经验/掉落归属）
   * @returns 结算结果文本
   */
  async resolvePetVsMonster(
    pet: any,
    monster: any,
    mapId: number,
    ownerUserId: number,
    ownerPlayerData?: any,
    taskProgress?: Array<{ actionName: string; count: number }>,
    attackText?: string,
    mustHit?: boolean,
  ): Promise<string> {
    const petBonus: BonusData = {
      攻击: pet.attack || 10,
      攻击2: 0,
      命中: pet.hit || pet.命中 || 80,
      命中2: 0,
      闪避: pet.dodge || pet.闪避 || 10,
      闪避2: 0,
      暴击: pet.crit || pet.暴击 || 5,
      暴击伤害: pet.critDmg || pet.暴击伤害 || 150,
      生命: pet.hp || 100,
      护盾: pet.shield || 0,
      装甲: pet.armor || 0,
    };

    // 宠物觉醒装备（物品操作.ecode L2493-2517）：解析 装备预设[2].装备 并入宠物属性。
    // 武器并入 加成/自带；防具/饰品同样并入并做套装判断（原版 L2508-2510）。
    const presetEquip = pet.equipmentPresets?.[2]?.equipment ?? pet.装备预设?.[2]?.装备 ?? [];
    const toNum = (v: any): number => (typeof v === 'number' && isFinite(v) ? v : 0);
    const petSetData: SetData = {};
    for (const entry of (Array.isArray(presetEquip) ? presetEquip : [])) {
      if (!entry || String(entry.type ?? entry.类型 ?? '') !== '装备') continue; // L2500
      let parsed;
      try {
        parsed = this.petItemService?.parseEquipment(entry as any);
      } catch {
        continue;
      }
      if (!parsed) continue;
      const isWeaponEq = parsed.type === '武器'
        || (typeof this.staticData.isWeapon === 'function' && this.staticData.isWeapon(parsed));
      const sources = [parsed.bonus, parsed.baseBonus];
      for (const src of sources) {
        for (const [key, value] of Object.entries(src || {})) {
          const num = toNum(value);
          if (num === 0) continue;
          switch (key) {
            case '攻击': case '命中': case '闪避': case '暴击': case '暴击伤害':
            case '生命': case '护盾': case '装甲': case '速度':
              (petBonus as any)[key] = toNum((petBonus as any)[key]) + num;
              break;
            default:
              break; // 其余字段当前宠物战斗模型未消费
          }
        }
      }
      if (!isWeaponEq) {
        // L2510：非武器做套装判断
        try {
          this.combatState.setJudgment(petSetData, parsed.name, parsed.specialSeq);
        } catch {
          /* 静态数据缺失时跳过 */
        }
      }
    }
    // 一拳套装生效（原版 _初始化怪物尾段 L2884-2889：套装.一拳==4 → 增加攻击力+25%）
    if ((petSetData.onePunch || 0) >= 4) {
      petBonus.攻击 = toNum(petBonus.攻击) * 1.25;
    }

    const monsterBonus = this.buildMonsterBonus(monster);

    // 命中判定（宠物命中 vs 怪物闪避）；天神降世必中（原版 L400 传入"真"必中参数）
    if (!mustHit) {
      const hitRate = this.calcHitRate(petBonus, monsterBonus);
      if (!this.checkHit(hitRate)) {
        return `${pet.name} 攻击 ${monster.name}，被闪避了`;
      }
    }

    // 暴击判定
    const isCrit = this.checkCrit(petBonus.暴击 || 0);

    // 伤害计算（宠物为攻击方、怪物为防御方，走统一三层引擎）
    const dmg = this.calcDamage(
      petBonus,
      monsterBonus,
      { name: pet.name || '宠物攻击', damage: 1, damageType: CombatSystemService.DMG_PHYS, properties: { phys: 100, fire: 0, ice: 0, elec: 0 } },
      CombatSystemService.DMG_PHYS,
      isCrit,
    );
    const finalDamage = Math.max(1, Math.floor(dmg.damage));
    this.applyDamageToMonster(monster, finalDamage, dmg.poolDamage);

    // 对齐原版 战斗相关.ecode L2065-2066：攻击文本为"天神a"时给防御方施加"降"debuff（30秒）
    // "降"在 bonus.service.calculateGameBonus L145-148 中使被命中方全抗-10%
    if (attackText === '天神a') {
      const mBuffs = this.safeParseJson<any[]>(monster.buffs, []);
      this.combatState.gainBuff(mBuffs, '降', 30, false, Date.now(), 0);
      monster.buffs = JSON.stringify(mBuffs);
    }

    // 怪物被击杀 → 发放掉落与经验（传入 attacker=ownerUserId 触发掉落闭环）
    if (monster.hp <= 0) {
      const deathResult = await this.handleMonsterDeath(
        monster,
        ownerUserId,
        mapId,
        ownerPlayerData,
      );
      taskProgress?.push(...(deathResult.taskProgress || []));
      let text = `${pet.name} 击败了 ${monster.name}！`;
      if (deathResult.expGain > 0) text += ` 获得 ${deathResult.expGain} 点经验`;
      if (deathResult.dropText) text += ` 掉落：${deathResult.dropText}`;
      return text;
    }

    // 怪物存活 → 写回血量，并按怪物反伤给宠物造成反弹伤害（原版 计算反伤 简化）
    await this.updateMonsterHpInMap(mapId, monster);
    const monsterAtk = monster.attack || 0;
    if (monsterAtk > 0) {
      const reflect = Math.max(1, Math.round(monsterAtk * 0.3));
      pet.hp = Math.max(1, (pet.hp || 0) - reflect);
      return `${pet.name} 对 ${monster.name} 造成 ${finalDamage} 点伤害，但被反击受到了 ${reflect} 点伤害`;
    }

    return `${pet.name} 对 ${monster.name} 造成 ${finalDamage} 点伤害`;
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
  async handleGardenCatCounter(
    userId: number,
    weaponIndex: number,
    reuseOuterLock = false,
    sharedPlayerData?: PlayerData,
  ): Promise<string> {
    // 从怪物反击链路进入且受害者就是外层持锁攻击者本人时，复用外层同一内存对象，
    // 避免内部武器攻击重新读库产生旧快照副本、随后被外层保存整体覆盖（丢失更新）。
    const playerData = sharedPlayerData ?? await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查使魔类型是否为花园猫
    if (player.type !== '花园猫') {
      return '';
    }

    // 执行反击（必中）
    // 从怪物反击链路进入时（reuseOuterLock=true）调用方已持有该用户的战斗锁，
    // 必须跳过再次加锁，否则与外层 weaponAttack 互相等待造成死锁。
    const result = await this.weaponAttack(userId, weaponIndex, {
      mustHit: true,
      attackText: '【花园猫·闪避反击】',
      noDelay: true,
      skipCombatLock: reuseOuterLock,
      ...(sharedPlayerData ? { attackerDataOverride: sharedPlayerData } : {}),
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
      const entry = markers2.find((m: any) => m && (m.name ?? m.名称) === name);
      const rawExpire = Number(entry?.expireAt ?? entry?.有效期至 ?? 0);
      const expireAtSec = rawExpire >= 1e12 ? rawExpire / 1000 : rawExpire;
      if (entry && expireAtSec > nowSec) {
        const remain = Math.ceil(expireAtSec - nowSec);
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

  /** 显示伤害（对应原版 通用 显示伤害）：返回取整后的伤害数值文本 */
  private displayDamage(value: number): string {
    return String(Math.round(value || 0));
  }

  /** 数字到时间（对应原版 通用 数字到时间）：毫秒 → 可读时间文本（秒/分秒） */
  private msToTimeTextLocal(ms: number): string {
    const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
    if (totalSec < 60) return `${totalSec}秒`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}分${sec}秒`;
  }


  /**
   * 免死（对应原版 战斗相关.ecode L5020-5096 子程序 免死）
   *
   * 原版语义：防御方即将死亡时，按使魔/装备/增益决定能否免死（返回真=免死成功）。
   * 覆盖分支：龙姬怒吼(b=2)、伊芙利特五番a(b=3)、战斗女仆守护3(b=5)、
   * 吸血姬与分身互换生命、猫爪吊坠(b=4)、以及 五番a/猫爪 增益要求覆盖 b。
   * b==2：总伤害 += 当前生命-1 且 当前生命=1（原版 L5080-5083）。
   * b==3/4/5：当前生命保留，返回免死真（原版 L5084-5092）。
   *
   * 依赖：defender.buffs（增益）/ defender.markers2（冷却标记，原地修改）/
   * defender.equipment（装备 specialSeq）/ defender.markers（取成就熟练度）/
   * defender.specialSeq / defender.活力 / defender.currentHp。
   *
   * @param defender 防御方玩家/召唤物
   * @param buffs 增益数组（原地修改：五番a/猫爪 获得增益）
   * @param markers2 冷却标记数组（原地修改：五番冷却/猫爪冷却 时间间隔要求）
   * @param equipment 装备数组（specialSeq 命中）
   * @param s 毫秒时间戳
   * @param rawTimestamp 原始毫秒时间戳（默认=s）
   * @param totalDamageRef 总伤害引用（b==2 时累加 当前生命-1）
   * @param damageTextRef 伤害文本引用（原地追加免死提示）
   * @param defenderGroup 防御方全体（吸血姬分身互换生命用，可空）
   * @returns 是否免死（真=免死成功，原版返回真）
   */
  avoidDeath(
    defender: any,
    buffs: any[],
    markers2: any[],
    equipment: any[],
    s: number,
    rawTimestamp: number,
    totalDamageRef: { value: number },
    damageTextRef: { value: string },
    defenderGroup?: any[],
  ): boolean {
    const SEC = 1000;
    const nowSec = Math.floor(s / SEC);
    const rawSec = rawTimestamp !== undefined ? rawTimestamp : s;
    const specialSeq = defender.specialSeq;
    const 活力 = defender.活力;
    // 取成就熟练度（原版 取成就熟练度(防御方.标记, name)）
    const achVal = (name: string): number =>
      this.playerService.getMarkerValue(defender.markers, name);
    // 装备要求（原版 装备要求(防御方, #猫爪吊坠, )）：遍历装备命中 specialSeq
    const hasEquip = (seq: number): boolean =>
      equipment.some((e: any) => e && e.specialSeq === seq);
    // 兼容层：将运行时 buffs/markers2 原地归一化为「中文key+毫秒」，兼容 game 层英文 key+秒级写入
    for (let i = 0; i < buffs.length; i++) buffs[i] = this.combatState.normalizeBuffItem(buffs[i]);
    for (let i = 0; i < markers2.length; i++) markers2[i] = this.combatState.normalizeBuffItem(markers2[i]);
    // 增益要求（原版 增益要求(name, 防御方.增益, , s, a1)）：存在且未过期，返回剩余毫秒
    const buffRemain = (name: string): number => {
      const b = buffs.find((x: any) => x && x.名称 === name && (!x.有效期至 || x.有效期至 > nowSec * SEC));
      if (!b) return 0;
      return b.有效期至 ? Math.max(0, b.有效期至 - nowSec * SEC) : 0; // 毫秒剩余
    };
    const buffActive = (name: string): boolean => buffRemain(name) > 0;
    // 标记要求（原版 标记要求("怒吼", 防御方.增益, , s)）：buff 名存在且未过期
    const markerRequire = (name: string): boolean => buffActive(name);
    // 时间间隔要求（原版 时间间隔要求(name, sec, markers2, s, , raw)）：冷却中返回真，否则加标记返回假
    const intervalActive = (name: string, sec: number): boolean =>
      this.combatState.timeIntervalRequire(name, sec, markers2, s, { value: '' }, rawSec);
    // 获得增益（原版 获得增益(防御方.增益, name, 时间, , raw, , )）
    const addBuff = (name: string, durSec: number): void => {
      // gainBuff 的 s 参数为毫秒时间戳（内部 有效期至 = s + 时间*SECOND_MS）
      this.combatState.gainBuff(buffs, name, durSec, false, rawSec, 0);
    };

    let b = 1;
    // 原版 L5031-5036：龙姬(specialSeq=12) 怒吼标记 → b=2，否则 b=1
    if (specialSeq === 12) {
      if (markerRequire('怒吼')) {
        b = 2;
      } else {
        b = 1;
      }
    }
    // 原版 L5038-5042：伊芙利特(specialSeq=11) 五番冷却未过 → 获得增益 五番a 5秒
    else if (specialSeq === 11) {
      if (intervalActive('五番冷却', 60 - (defender.skillLevel || 0) / 2) === false) {
        addBuff('五番a', 5);
      }
    }
    // 原版 L5043-5049：战斗女仆(specialSeq=8) 守护3 熟练度!=0 → b=5，否则 b=1
    else if (specialSeq === 8) {
      if (achVal('守护3') !== 0) {
        b = 5;
      } else {
        b = 1;
      }
    }
    // 原版 L5050-5063：吸血姬(活力=-15) 与场上的 吸血姬分身(活力=-16, 当前生命>0) 互换生命
    else if (活力 === -15) {
      if (Array.isArray(defenderGroup)) {
        for (const member of defenderGroup) {
          if (member && member.活力 === -16 && (member.currentHp || member.当前生命 || 0) > 0) {
            damageTextRef.value =
              damageTextRef.value +
              '\n' +
              '生命' +
              this.displayDamage(-(defender.currentHp || 0)) +
              '(' + '0' + ')';
            defender.currentHp = member.currentHp || member.当前生命 || 0;
            member.currentHp = 0;
            damageTextRef.value =
              damageTextRef.value +
              '\n' +
              '【目标】与分身互换生命' +
              '(' + '生命+' + this.displayDamage(defender.currentHp || 0) + ')';
            return true;
          }
        }
      }
    }
    // 原版 L5064-5067：猫爪吊坠(specialSeq=23) 猫爪冷却未过 → 获得增益 猫爪 10秒
    else if (hasEquip(23)) {
      if (intervalActive('猫爪冷却', 90) === false) {
        addBuff('猫爪', 10);
      }
    }
    // 原版 L5069-5071：默认 b=1
    else {
      b = 1;
    }
    // 原版 L5072-5078：增益要求 覆盖 b（猫爪→4，五番a→3）
    if (buffActive('猫爪')) {
      b = 4;
    } else if (buffActive('五番a')) {
      b = 3;
    } else {
      b = 1;
    }
    // 原版 L5079-5095：b 分支
    if (b === 2) {
      totalDamageRef.value = totalDamageRef.value + (defender.currentHp || 0) - 1;
      damageTextRef.value =
        damageTextRef.value +
        '\n' +
        '生命' +
        this.displayDamage(-((defender.currentHp || 0) - 1)) +
        '(' + '1' + ')';
      defender.currentHp = 1;
      return true;
    } else if (b === 3) {
      damageTextRef.value =
        damageTextRef.value +
        '\n' +
        '生命-0' +
        '(' + this.displayDamage(defender.currentHp || 0) + ')' +
        '(' + '神威灵装·五番' + this.msToTimeTextLocal(buffRemain('五番a')) + ')';
      return true;
    } else if (b === 4) {
      damageTextRef.value =
        damageTextRef.value +
        '\n' +
        '生命-0' +
        '(' + this.displayDamage(defender.currentHp || 0) + ')' +
        '(' + '猫爪' + this.msToTimeTextLocal(buffRemain('猫爪')) + ')';
      return true;
    } else if (b === 5) {
      damageTextRef.value =
        damageTextRef.value +
        '\n' +
        '生命-0' +
        '(' + this.displayDamage(defender.currentHp || 0) + ')' +
        '(' + '女仆' + ')';
      return true;
    }
    return false;
  }

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

    // 原版 造成伤害 入口：当前生命<=0 先调 免死()，返回真则仍存活（龙姬/伊芙利特/战斗女仆/吸血姬/猫爪/五番a 分支）
    const dmgTextRef = { value: '' };
    const totalDmgRef = { value: Number.MAX_SAFE_INTEGER }; // 致死总伤害
    // 传入 buffs/markers2 的浅拷贝副本：avoidDeath 内部会把元素原地归一化为中文 key（兼容层），
    // 若直接传原引用会破坏本函数后续 buffActive（依赖英文 key）的读取，故隔离副本。
    if (this.avoidDeath(player, [...buffs], [...markers2], equipment, nowSec * 1000, nowSec * 1000, totalDmgRef, dmgTextRef)) {
      // 免死成功：b==2 已把 当前生命 置 1；b==3/4/5 保留当前生命；吸血姬已互换
      extraText = extraText + dmgTextRef.value;
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
    if ((attacker.属性?.掉落率 || attacker.掉落率 || 0) !== 0) {
      writeMarker('dl', attacker.属性?.掉落率 || attacker.掉落率 || 0);
    }
    // 掉落品质（原版 L5269-5285：玩家.属性.掉落品质 != 0）
    if ((attacker.属性?.掉落品质 || attacker.掉落品质 || 0) !== 0) {
      writeMarker('dp', attacker.属性?.掉落品质 || attacker.掉落品质 || 0);
    }
    // 传说率（原版 L5287-5303：玩家.套装.传说率 != 0；⚠️L5291 比较误用 掉落品质，按原版保留）
    if ((attacker.套装?.传说率 || attacker.legendRate || 0) !== 0) {
      writeMarker('xy', attacker.套装?.传说率 || attacker.legendRate || 0);
    }
    // 宝石缎带（原版 L5305-5317：装备要求(#宝石缎带) 成立 → 写 "ds"=1）
    const equipment = this.safeParseJson<any[]>(attacker.equipment, []);
    const hasGemRibbon = equipment.some((e: any) => e && (
      Number(e.specialSeq ?? e.特殊序号) === 98
      || String(e.name ?? e.名称 ?? '').trim() === '宝石缎带'
    )); // #宝石缎带 常量=98
    if (hasGemRibbon) {
      writeMarkerOnce('ds', 1);
    }

    return markers;
  }

  /** 判断玩家当前装备栏是否有宝石缎带，兼容 JSON 字符串和数组存档。 */
  private hasGemRibbon(player: any): boolean {
    const equipment = this.safeParseJson<any[]>(player?.equipment, []);
    return equipment.some((item: any) => item && (
      Number(item.specialSeq ?? item.特殊序号) === 98
      || String(item.name ?? item.名称 ?? '').trim() === '宝石缎带'
    ));
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
    const targetProduction = Number(target.生产 ?? 0);
    if (targetProduction > 0) {
      if (produce) bonus.生产 = (bonus.生产 ?? 0) + targetProduction * count * siliconCore;
      else bonus.生产 = (bonus.生产 ?? 0) + (targetProduction * count * siliconCore) / 4;
    } else {
      if (produce) bonus.生产 = (bonus.生产 ?? 0) + targetProduction * count * coreNegReduce;
      else bonus.生产 = (bonus.生产 ?? 0) + (targetProduction * count) / 4 * coreNegReduce;
    }
    // 攻击次数（原版 L4001）
    bonus.攻击次数 = (bonus.攻击次数 ?? 0) + (target.攻击次数 ?? 0) * count;
  }

  /**
   * 取物品数量（对应原版 物品操作.ecode L2022 取物品数量）
   * 遍历物品数组，累加同名物品的数量；若为装备也返回1。
   * 本方法为 计算载具 内部依赖的轻量等价实现。
   */
  private getItemQty(name: string, items: any[]): number {
    if (!Array.isArray(items)) return 0;
    let total = 0;
    for (const it of items) {
      if (it && (it.名称 ?? it.name) === name) {
        // 装备按1计；资源/物品按 数量 计
        const type = it.类型 ?? it.type;
        total += type === '装备' ? 1 : Number(it.数量 ?? it.quantity ?? it.count ?? 0);
      }
    }
    return total;
  }

  /**
   * 物品要求（计算载具 内部轻量等价，对应原版 物品操作.ecode L1784 物品要求）
   * 返回是否满足：不提供要求数量时存在即满足；提供时数量需 >= 要求。
   * 复用 getItemQty 实现，避免依赖 itemSystem 实例。
   */
  private reqItem(name: string, items: any[], requireQty?: number): boolean {
    const qty = this.getItemQty(name, items);
    if (requireQty == null) return qty > 0;
    return qty >= requireQty;
  }

  /** 统一读取载具 JSON 中的物品/零件，兼容中文原版字段和当前英文存量字段。 */
  private normalizeVehicleItem(item: any): any {
    const name = item?.名称 ?? item?.name ?? '';
    const quantity = Number(item?.数量 ?? item?.quantity ?? item?.count ?? 1);
    const durability = Number(item?.耐久 ?? item?.durability ?? 100);
    return {
      ...(item || {}),
      名称: String(name),
      name: item?.name ?? String(name),
      数量: Number.isFinite(quantity) ? quantity : 0,
      quantity: item?.quantity ?? item?.count ?? (Number.isFinite(quantity) ? quantity : 0),
      耐久: Number.isFinite(durability) ? durability : 100,
      durability: item?.durability ?? (Number.isFinite(durability) ? durability : 100),
      类型: item?.类型 ?? item?.type ?? '资源',
      type: item?.type ?? item?.类型 ?? '资源',
    };
  }

  private normalizeVehicleRecipe(recipe: any): any {
    const name = recipe?.名称 ?? recipe?.name ?? '';
    const value = Number(recipe?.数值 ?? recipe?.value ?? recipe?.production ?? recipe?.count ?? 0);
    return {
      ...(recipe || {}),
      名称: String(name),
      name: recipe?.name ?? String(name),
      数值: Number.isFinite(value) ? value : 0,
      value: recipe?.value ?? (Number.isFinite(value) ? value : 0),
    };
  }

  private parseVehicleJson<T>(value: any, fallback: T): T {
    if (Array.isArray(value) || (value && typeof value === 'object')) return value as T;
    if (typeof value !== 'string' || !value.trim()) return fallback;
    try {
      const parsed = JSON.parse(value);
      return parsed === null || parsed === undefined ? fallback : parsed as T;
    } catch {
      return fallback;
    }
  }

  private normalizeRuntimeVehicle(vehicle: any): void {
    const parts = this.parseVehicleJson<any[]>(vehicle?.零件 ?? vehicle?.parts, []);
    const recipes = this.parseVehicleJson<any[]>(vehicle?.配方 ?? vehicle?.recipes, []);
    vehicle.零件 = Array.isArray(parts) ? parts.map((item) => this.normalizeVehicleItem(item)) : [];
    vehicle.配方 = Array.isArray(recipes) ? recipes.map((item) => this.normalizeVehicleRecipe(item)) : [];
    vehicle.标记2 = this.parseVehicleJson<any[]>(vehicle?.标记2 ?? vehicle?.markers2, []);
    vehicle.加成 = this.parseVehicleJson<any>(vehicle?.加成 ?? vehicle?.bonus, {});
    vehicle.名称 = String(vehicle?.名称 ?? vehicle?.name ?? '');
    vehicle.name = vehicle?.name ?? vehicle.名称;
    vehicle.类型 = String(vehicle?.类型 ?? vehicle?.type ?? '');
    vehicle.type = vehicle?.type ?? vehicle.类型;
    vehicle.编号 = String(vehicle?.编号 ?? vehicle?.vehicleId ?? vehicle?.id ?? '');
    vehicle.vehicleId = vehicle?.vehicleId ?? vehicle.编号;
    vehicle.归属 = String(vehicle?.归属 ?? vehicle?.owner ?? '');
    vehicle.owner = vehicle?.owner ?? vehicle.归属;
    vehicle.驾驶员 = String(vehicle?.驾驶员 ?? vehicle?.driver ?? '');
    vehicle.driver = vehicle?.driver ?? vehicle.驾驶员;
    const currentHp = Number(vehicle?.当前生命 ?? vehicle?.currentHp ?? vehicle?.hp ?? 0);
    vehicle.当前生命 = Number.isFinite(currentHp) ? currentHp : 0;
    vehicle.currentHp = vehicle.当前生命;
    const maxHp = Number(vehicle?.生命 ?? vehicle?.maxHp ?? 0);
    vehicle.生命 = Number.isFinite(maxHp) ? maxHp : 0;
    vehicle.maxHp = vehicle.生命;
    const slotStatus = Number(vehicle?.上限 ?? vehicle?.slotStatus ?? 0);
    vehicle.上限 = Number.isFinite(slotStatus) ? slotStatus : 0;
    vehicle.slotStatus = vehicle.上限;
    const moveType = Number(vehicle?.行走方式 ?? vehicle?.moveType ?? 0);
    vehicle.行走方式 = Number.isFinite(moveType) ? moveType : 0;
    vehicle.moveType = vehicle.行走方式;
  }

  private vehicleRecipeItems(recipe: any, field: '产出' | '消耗'): any[] {
    const raw = field === '产出'
      ? (recipe?.产出 ?? recipe?.outputs)
      : (recipe?.消耗 ?? recipe?.inputs);
    const parsed = this.parseVehicleJson<any[]>(raw, []);
    return Array.isArray(parsed) ? parsed.map((item) => this.normalizeVehicleItem(item)) : [];
  }

  private getRuntimeVehicleRecipe(name: string): any | undefined {
    const recipe = this.staticData.getVehicleRecipeByName(name);
    if (!recipe) return undefined;
    return {
      ...recipe,
      名称: recipe.名称 ?? recipe.name ?? name,
      产出: this.vehicleRecipeItems(recipe, '产出'),
      消耗: this.vehicleRecipeItems(recipe, '消耗'),
    };
  }

  /** 原版 获得物品：同名资源叠加，默认不保留消耗后的非正数条目。 */
  private mergeVehicleItem(items: any[], item: any, allowNegative = false): void {
    const normalized = this.normalizeVehicleItem(item);
    if (!normalized.名称 || !Number.isFinite(normalized.数量) || normalized.数量 === 0) return;
    const existingIndex = items.findIndex((entry: any) =>
      (entry?.名称 ?? entry?.name) === normalized.名称,
    );
    if (existingIndex >= 0) {
      const existing = this.normalizeVehicleItem(items[existingIndex]);
      const next = existing.数量 + normalized.数量;
      if (!allowNegative && next <= 0) {
        items.splice(existingIndex, 1);
      } else {
        existing.数量 = next;
        existing.quantity = next;
        if (existing.count !== undefined) existing.count = next;
        items[existingIndex] = existing;
      }
      return;
    }
    if (normalized.数量 > 0 || allowNegative) items.push(normalized);
  }

  private addVehicleItemArray(items: any[], name: string, quantity: number, allowNegative = false): void {
    this.mergeVehicleItem(items, { 名称: name, 数量: quantity, 类型: '资源', 耐久: 100 }, allowNegative);
  }

  private recipeAllocation(recipes: any[], name: string): number {
    return recipes
      .filter((recipe: any) => recipe.名称 === name)
      .reduce((sum: number, recipe: any) => sum + Number(recipe.数值 || 0), 0);
  }

  /**
   * 原版 物品操作.ecode L2692-2954：结算载具生产。
   *
   * 该方法同时生成每分钟显示数据和按经过时间写回载具零件的实际产出，
   * 因为原版「生产」「计算载具」都通过同一个取生产产出函数完成这两件事。
   * 调用方负责在返回的 produced/consumed 上推进玩家成就与任务。
   */
  calculateVehicleProduction(
    vehicle: any,
    timestamp: number,
    options: { yongxing?: number; lannBaby?: boolean } = {},
  ): VehicleProductionResult {
    this.normalizeRuntimeVehicle(vehicle);
    const now = Number(timestamp);
    const productionDisplay = {
      productionSpeed: 1,
      byproductMultiplier: 1,
      consumptionMultiplier: 1,
      efficiency: 1,
    };
    const emptyResult = (overrides: Partial<VehicleProductionResult> = {}): VehicleProductionResult => ({
      productionDisplay: [
        String((productionDisplay.productionSpeed - 1) * 100),
        String((productionDisplay.byproductMultiplier - 1) * 100),
        String((1 - productionDisplay.consumptionMultiplier) * 100),
        String(productionDisplay.efficiency * 100),
      ].join('!'),
      productionSpeed: productionDisplay.productionSpeed,
      byproductMultiplier: productionDisplay.byproductMultiplier,
      consumptionMultiplier: productionDisplay.consumptionMultiplier,
      efficiency: productionDisplay.efficiency,
      availableTime: 0,
      consumedProductivity: 0,
      elapsedMs: 0,
      outputPerMinute: [],
      consumptionPerMinute: [],
      combinedPerMinute: [],
      produced: [],
      consumed: [],
      stopped: false,
      ...overrides,
    });

    const parts = vehicle.零件;
    const recipes = vehicle.配方;
    const systemII = Math.min(5, Math.max(0, this.getItemQty('生产调度系统II', parts)));
    productionDisplay.productionSpeed += systemII * 0.09;
    if ((options.yongxing || 0) > 0) productionDisplay.productionSpeed += 0.25;

    // 原版先于时间戳处理判断载具是否因部件超限而失效。
    if (Number(vehicle.上限 || 0) > 1) {
      return emptyResult({ stopped: true, reason: 'vehicle-over-limit' });
    }

    if (recipes.length === 0) {
      vehicle.配方 = [{ 名称: '1', 数值: now }];
      return emptyResult();
    }
    if (recipes[0].名称 !== '1') {
      recipes.unshift({ 名称: '1', 数值: now });
    }

    const lastRead = Number(recipes[0].数值);
    const rawElapsedMs = Number.isFinite(lastRead) ? now - lastRead : 0;
    let elapsedMs = rawElapsedMs;
    if (options.lannBaby) elapsedMs *= 1.05;
    recipes[0].数值 = now;

    const productionPower = Number(vehicle.加成?.生产 || 0);
    if (productionPower === 0) {
      if (this.getItemQty('具现装置', parts) > 0) {
        this.addVehicleItemArray(parts, '未知物品', elapsedMs / 1000 / 86400);
      }
      return emptyResult({ elapsedMs });
    }

    const systemI = Math.min(
      Math.max(0, 5 - systemII),
      Math.max(0, this.getItemQty('生产调度系统', parts)),
    );
    productionDisplay.productionSpeed += systemI * 0.05;

    const acceleration8 = this.recipeAllocation(recipes, '生产加速8') > 0;
    const acceleration6 = this.recipeAllocation(recipes, '生产加速6') > 0;
    const acceleration4 = this.recipeAllocation(recipes, '生产加速4') > 0;
    if (acceleration8) productionDisplay.productionSpeed += 0.25;
    else if (acceleration6) productionDisplay.productionSpeed += 0.15;
    else if (acceleration4) productionDisplay.productionSpeed += 0.05;
    if (this.getItemQty('小蓝', parts) > 0) productionDisplay.productionSpeed += 0.05;

    const type = String(vehicle.类型 || '');
    if (type === '九尾狐') {
      productionDisplay.byproductMultiplier += 1;
      productionDisplay.consumptionMultiplier -= 0.05;
    } else if (type === '夜璃') {
      productionDisplay.byproductMultiplier += 0.75;
    } else if (type === '河狸') {
      productionDisplay.byproductMultiplier += 0.5;
    } else if (type === '工作台') {
      productionDisplay.byproductMultiplier += 0.25;
    }
    if (this.getItemQty('小凰', parts) > 0) productionDisplay.byproductMultiplier += 0.25;
    if (this.getItemQty('小雫', parts) > 0) productionDisplay.consumptionMultiplier -= 0.02;
    if (this.getItemQty('具现装置', parts) > 0) productionDisplay.consumptionMultiplier -= 0.05;

    const outputPerMinute: any[] = [];
    const consumptionPerMinute: any[] = [];
    const combinedPerMinute: any[] = [];
    let consumedProductivity = 0;

    // 第一遍只生成「每分钟」面板数据，同时按配方顺序计算总生产力。
    for (let index = 1; index < recipes.length; index++) {
      const assignment = Number(recipes[index].数值 || 0);
      consumedProductivity += assignment;
      const recipe = this.getRuntimeVehicleRecipe(recipes[index].名称);
      if (!recipe) continue;
      for (const output of recipe.产出) {
        const ratio = Number(output.耐久 ?? 100) / 100;
        const quantity = Number(output.数量 || 0)
          * (ratio < 1 ? ratio * productionDisplay.byproductMultiplier : 1)
          * assignment * productionDisplay.productionSpeed;
        this.addVehicleItemArray(outputPerMinute, output.名称, quantity);
        this.addVehicleItemArray(combinedPerMinute, output.名称, quantity, true);
      }
      for (const input of recipe.消耗) {
        const ratio = Number(input.耐久 ?? 100) / 100;
        const quantity = Number(input.数量 || 0)
          * productionDisplay.consumptionMultiplier * ratio
          * assignment * productionDisplay.productionSpeed;
        this.addVehicleItemArray(consumptionPerMinute, input.名称, quantity);
        this.addVehicleItemArray(combinedPerMinute, input.名称, -quantity, true);
      }
    }

    if (consumedProductivity > productionPower && consumedProductivity > 0) {
      productionDisplay.efficiency = productionPower / consumedProductivity;
      for (const item of [...outputPerMinute, ...consumptionPerMinute, ...combinedPerMinute]) {
        item.数量 *= productionDisplay.efficiency;
      }
    }

    const productionDisplayText = [
      String((productionDisplay.productionSpeed - 1) * 100),
      String((productionDisplay.byproductMultiplier - 1) * 100),
      String((1 - productionDisplay.consumptionMultiplier) * 100),
      String(productionDisplay.efficiency * 100),
    ].join('!');

    const produced: any[] = [];
    const consumed: any[] = [];
    // 第二遍按原版顺序逐个配方结算。前一个配方的产出会立即进入零件，
    // 因而可以作为后一个配方的输入。
    for (let index = 1; index < recipes.length; index++) {
      const assignment = Number(recipes[index].数值 || 0);
      if (assignment <= 0) continue;
      const recipe = this.getRuntimeVehicleRecipe(recipes[index].名称);
      if (!recipe || recipe.产出.length === 0) continue;

      let maxMinutes: number | undefined;
      for (const input of recipe.消耗) {
        const rate = Number(input.数量 || 0)
          * productionDisplay.consumptionMultiplier
          * assignment * productionDisplay.productionSpeed
          * productionDisplay.efficiency;
        if (rate <= 0) continue;
        const supportedMinutes = this.getItemQty(input.名称, parts) / rate;
        maxMinutes = maxMinutes === undefined ? supportedMinutes : Math.min(maxMinutes, supportedMinutes);
      }

      for (const output of recipe.产出) {
        const ratio = Number(output.耐久 ?? 100) / 100;
        const rate = Number(output.数量 || 0) * assignment * productionDisplay.productionSpeed
          * productionDisplay.efficiency
          * (ratio < 1 ? ratio * productionDisplay.byproductMultiplier : 1);
        const limit = this.getItemQty(`生产限制${output.名称}`, parts);
        if (limit > 0 && rate > 0) {
          const remainingMinutes = (limit - this.getItemQty(output.名称, parts)) / rate;
          maxMinutes = maxMinutes === undefined ? remainingMinutes : Math.min(maxMinutes, remainingMinutes);
        }
      }

      const elapsedMinutes = Math.max(0, elapsedMs / 1000 / 60);
      const minutes = Math.max(0, Math.min(maxMinutes ?? 0, elapsedMinutes));
      if (minutes <= 0 || !Number.isFinite(minutes)) continue;

      for (const output of recipe.产出) {
        const ratio = Number(output.耐久 ?? 100) / 100;
        const quantity = minutes * Number(output.数量 || 0) * assignment
          * productionDisplay.productionSpeed * productionDisplay.efficiency
          * (ratio < 1 ? ratio * productionDisplay.byproductMultiplier : 1);
        this.addVehicleItemArray(parts, output.名称, quantity);
        this.addVehicleItemArray(produced, output.名称, quantity);
      }
      for (const input of recipe.消耗) {
        const ratio = Number(input.耐久 ?? 100) / 100;
        const quantity = minutes * Number(input.数量 || 0)
          * productionDisplay.consumptionMultiplier * ratio * assignment
          * productionDisplay.productionSpeed * productionDisplay.efficiency;
        this.addVehicleItemArray(parts, input.名称, -quantity);
        this.addVehicleItemArray(consumed, input.名称, quantity);
      }
    }

    let availableTime = 0;
    for (const item of combinedPerMinute) {
      const quantity = Number(item.数量 || 0);
      const supportedSeconds = quantity < 0
        ? this.getItemQty(item.名称, parts) / -quantity * 60
        : 86400.12345678;
      availableTime = availableTime === 0
        ? supportedSeconds
        : Math.min(availableTime, supportedSeconds);
    }

    return {
      productionDisplay: productionDisplayText,
      productionSpeed: productionDisplay.productionSpeed,
      byproductMultiplier: productionDisplay.byproductMultiplier,
      consumptionMultiplier: productionDisplay.consumptionMultiplier,
      efficiency: productionDisplay.efficiency,
      availableTime,
      consumedProductivity,
      elapsedMs,
      outputPerMinute,
      consumptionPerMinute,
      combinedPerMinute,
      produced,
      consumed,
      stopped: false,
    };
  }

  /**
   * 计算载具（对应原版 加成计算.ecode L3556-3912 子程序 计算载具）
   *
   * 原版语义：重新计算载具的各项属性（防御/武器/行走/功能上限与超限、加成叠加、硅基核心、
   * 逆转力场、湮灭圣光/审判导弹等穿透、小雫/小凰等生产加成、超限判定），并在提供 s 且非产出时
   * 处理 琪莎拉 自动回血；最终按 上限 标志决定产出分支。
   *
   * 本方法 1:1 还原 L3556-3912 全部属性计算逻辑；产出分支由 calculateVehicleProduction
   * 对应原版 L3898-3911 的 取生产产出。
   *
   * 数据来源：原版 部件列表 全局 = staticData.getAllVehiclePartSpecs()（vehicle-parts.json，
   * 由 e/源码解析成为txt/使魔大战.txt 类型=载具 节提取）；部件限制 全局（商店-部件限制）当前无数据 → 空数组。
   *
   * @param vehicle 载具对象（原地修改：重置并叠加属性/加成/上限等）
   * @param s 长整数时间戳（可空；为空则跳过时间相关回血）
   * @param calcOutput 是否计算产出（可空）
   * @param achieve 玩家成就数组（计算产出时用，可空）
   * @param tasks 玩家任务数组（计算产出时用，可空）
   * @param productivity 生产力提高（可空）
   * @param mapId 所在地图（可空）
   */
  /**
   * 对外提供原版「计算载具」的纯重算入口。
   * 生产系统先调用它得到载具加成、核心类型和超限标志，再执行「取生产产出」。
   */
  recalculateVehicle(
    vehicle: any,
    s: number | null = null,
    productivity = 0,
    mapId?: number,
    options: VehicleRecalculationOptions = {},
  ): any {
    this.computeVehicle(vehicle, s, false, undefined, undefined, productivity, mapId, options);
    return vehicle;
  }

  /** 原版「计算载具(..., 计算产出=真)」的公开入口。 */
  produceVehicle(
    vehicle: any,
    timestamp: number,
    productivity = 0,
    mapId?: number,
    options: VehicleRecalculationOptions = {},
  ): VehicleProductionResult {
    const result = this.computeVehicle(
      vehicle,
      timestamp,
      true,
      undefined,
      undefined,
      productivity,
      mapId,
      options,
    );
    return result || {
      productionDisplay: '0!0!0!100',
      productionSpeed: 1,
      byproductMultiplier: 1,
      consumptionMultiplier: 1,
      efficiency: 1,
      availableTime: 0,
      consumedProductivity: 0,
      elapsedMs: 0,
      outputPerMinute: [],
      consumptionPerMinute: [],
      combinedPerMinute: [],
      produced: [],
      consumed: [],
      stopped: true,
      reason: 'invalid-vehicle',
    };
  }

  private computeVehicle(
    vehicle: any,
    s: number | null,
    calcOutput?: boolean,
    achieve?: any[],
    tasks?: any[],
    productivity?: number,
    mapId?: number,
    options: VehicleRecalculationOptions = {},
  ): VehicleProductionResult | undefined {
    // DB 载具和历史地图 JSON 使用英文/中文混合字段，先统一为原版中文运行时结构。
    this.normalizeRuntimeVehicle(vehicle);
    const 部件列表 = this.staticData.getAllVehiclePartSpecs() || [];
    const 部件限制: any[] = []; // 原版 部件限制 全局（商店-部件限制），当前无数据
    const j: any = {}; // 全新空加成
    let 生产类Flag = false; // 原版 生产类 标志（核心部件含生产加成时置真）
    vehicle.加成 = j;
    if (vehicle.名称 === '') {
      return; // 原版 L3581-3583
    }
    vehicle.防御 = 0;
    vehicle.武器 = 0;
    vehicle.行走 = 0;
    vehicle.功能 = 0;
    vehicle.加成.生命 = 0;
    vehicle.行走方式 = 0;
    if (Array.isArray(vehicle.零件) && vehicle.零件.length > 0) {
      // 原版 L3591：载具.类型 = 子文本替换(零件[1].名称, "核心", ...)（仅取类型前缀）
      vehicle.类型 = (vehicle.零件[0].名称 || '').replace('核心', '');
    }
    vehicle.发丝 = false;
    vehicle.逆转力场 = false;
    vehicle.上限 = 0;
    vehicle.涂层 = 0;
    const 计算用零件: any[] = [];
    // 原版 L3598-3612：遍历零件，展开内置零件 + 加入计算用零件
    for (const p of vehicle.零件 || []) {
      // 在 部件列表 中查找同名部件，展开其 内置零件
      const spec = 部件列表.find((b: any) => b.name === p.名称);
      if (spec && Array.isArray(spec.builtinParts)) {
        for (const inner of spec.builtinParts) {
          const innerItem = {
            ...inner,
            名称: inner.名称 ?? inner.name ?? '',
            name: inner.name ?? inner.名称 ?? '',
            耐久: -11,
            durability: -11,
            数量: inner.count ?? inner.数量 ?? inner.quantity ?? 0,
            quantity: inner.count ?? inner.数量 ?? inner.quantity ?? 0,
          };
          计算用零件.push(innerItem);
        }
      }
      计算用零件.push(p);
    }
    // 原版 L3613-3619：硅基核心判定
    let 硅基核心加成 = 1;
    if (this.getItemQty('硅基核心阿尔法', 计算用零件) > 0) 硅基核心加成 = 1.035;
    else if (this.getItemQty('硅基核心贝塔', 计算用零件) > 0) 硅基核心加成 = 1.025;
    // 原版 L3620-3718：遍历计算用零件，匹配 部件列表 套用加成/上限/超限
    for (const cp of 计算用零件) {
      if (cp.名称 === '白的发丝') vehicle.发丝 = true;
      else if (cp.名称 === '逆转力场') vehicle.逆转力场 = true;
      const spec = 部件列表.find((b: any) => b.name === cp.名称);
      if (!spec) continue;
      // 原版限制2=“涂层”时把部件名称转换为通用伤害类型（加成计算.ecode L3596、
      // 战斗相关.ecode L3321-L3344）。静态部件数据缺少该派生字段时仍按名称补齐。
      if (spec.limit2 === '涂层' || ['坚固涂层', '耐热涂层', '耐寒涂层', '电阻涂层'].includes(cp.名称)) {
        const coatingByName: Record<string, number> = {
          坚固涂层: CombatSystemService.DMG_PHYS,
          耐热涂层: CombatSystemService.DMG_FIRE,
          耐寒涂层: CombatSystemService.DMG_ICE,
          电阻涂层: CombatSystemService.DMG_ELEC,
        };
        if (coatingByName[cp.名称]) vehicle.涂层 = coatingByName[cp.名称];
      }
      const 生产类 = (spec.bonus && spec.bonus.生产 > 0);
      // 核心必须是第一个（类型==0）
      if (spec.partType === 0) {
        vehicle.行走上限 = spec.walk;
        vehicle.防御上限 = spec.defense;
        vehicle.武器上限 = spec.weapon;
        vehicle.功能上限 = spec.function;
        vehicle.行走方式 = spec.moveType;
        if (spec.bonus && spec.bonus.生产 > 0) 生产类Flag = true;
      } else {
        if (cp.耐久 !== -11) { // 内置零件不参与
          if (spec.limit2) {
            // 原版通过“获得物品”加入物品3副本；不能复用同一个对象，
            // 且物品3的限制值字段是“数量”而不是“数值”。
            const limitItem = {
              名称: spec.limit2,
              name: spec.limit2,
              类型: '资源',
              type: '资源',
              数量: Number(cp.数量 ?? 0),
              quantity: Number(cp.数量 ?? 0),
              耐久: 100,
              durability: 100,
            };
            部件限制.push(limitItem);
          }
          // 行走/防御/武器/功能 上限与超限（原版 L3647-3714 四段）
          this.applyPartLimit(vehicle, spec, cp, '行走', 'walk');
          this.applyPartLimit(vehicle, spec, cp, '防御', '防御');
          this.applyPartLimit(vehicle, spec, cp, '武器', 'weapon');
          this.applyPartLimit(vehicle, spec, cp, '功能', 'function');
        }
      }
      // 原版 L3718-3746：叠加载具加成（内置零件耐久==-11 时全量，否则按上限分段）
      if (cp.耐久 === -11) {
        this.stackVehicleBonus(vehicle.加成, spec.bonus || {}, cp.数量 ?? 1, 生产类, 硅基核心加成);
      } else if (spec.limit == null || spec.limit <= 0) { // 原版 L3648/L3735：上限<=0 为无上限，全量叠加
        this.stackVehicleBonus(vehicle.加成, spec.bonus || {}, cp.数量 ?? 1, 生产类, 硅基核心加成);
      } else {
        const qty = cp.数量 ?? 1;
        if (qty <= spec.limit) {
          this.stackVehicleBonus(vehicle.加成, spec.bonus || {}, qty, 生产类, 硅基核心加成);
        } else {
          this.stackVehicleBonus(vehicle.加成, spec.bonus || {}, spec.limit, 生产类, 硅基核心加成);
          this.stackVehicleBonus(vehicle.加成, spec.bonus || {}, (qty - spec.limit) / 2, 生产类, 硅基核心加成);
          vehicle.上限 = 1;
        }
      }
    }
    // 原版 L3752-3759：逆转力场 加成修正
    if (vehicle.逆转力场) {
      vehicle.加成.护盾全抗 = Number(vehicle.加成.护盾全抗 || 0)
        + (1 - Number(vehicle.加成.护盾全抗 || 0) / 100) * Number(vehicle.加成.生命 || 0);
      vehicle.加成.装甲全抗 = Number(vehicle.加成.装甲全抗 || 0)
        + (1 - Number(vehicle.加成.装甲全抗 || 0) / 100) * Number(vehicle.加成.生命 || 0);
      vehicle.加成.生命全抗 = Number(vehicle.加成.生命全抗 || 0)
        + (1 - Number(vehicle.加成.生命全抗 || 0) / 100) * Number(vehicle.加成.生命 || 0);
      vehicle.加成.攻击 = Number(vehicle.加成.攻击 || 0) * 0.34;
      vehicle.加成.攻击2 = Number(vehicle.加成.攻击2 || 0) * 0.34;
      vehicle.加成.韧性 = Number(vehicle.加成.韧性 || 0) * 0.34;
    }
    // 原版 L3760-3768：上限负值保护
    if (vehicle.武器上限 < 0) vehicle.武器上限 = 0;
    if (vehicle.防御上限 < 0) vehicle.防御上限 = 0;
    if (vehicle.行走上限 < 0) vehicle.行走上限 = 0;
    // 原版 L3769-3801：导弹类穿透（湮灭圣光/审判导弹/星爆导弹/炼狱导弹）
    let c = 0;
    if (this.reqItem('湮灭圣光', 计算用零件) &&
        this.reqItem('氢弹', 计算用零件, 0.1)) {
      c = 1;
      vehicle.加成.贯穿 = Number(vehicle.加成.贯穿 || 0) + 20;
      this.bonusService.addPenetration(vehicle.加成, 20);
    }
    if (c === 0) {
      if (this.reqItem('审判导弹', 计算用零件) &&
          this.reqItem('导弹', 计算用零件, 0.1)) {
        vehicle.加成.贯穿 = Number(vehicle.加成.贯穿 || 0) + 10;
        this.bonusService.addPenetration(vehicle.加成, 10);
      } else if (this.reqItem('星爆导弹', 计算用零件) &&
                 this.reqItem('导弹', 计算用零件, 0.05)) {
        vehicle.加成.贯穿 = Number(vehicle.加成.贯穿 || 0) + 8;
        this.bonusService.addPenetration(vehicle.加成, 8);
      } else if (this.reqItem('炼狱导弹', 计算用零件) &&
                 this.reqItem('导弹', 计算用零件, 0.01)) {
        vehicle.加成.贯穿 = Number(vehicle.加成.贯穿 || 0) + 5;
        this.bonusService.addPenetration(vehicle.加成, 5);
      }
    }
    // 原版 L3802-3834：小雫/小凰/小蓝/小粉 上限加成 与 生产加成
    c = 0;
    if (!生产类Flag) {
      if (this.reqItem('小雫', 计算用零件)) vehicle.防御上限 += 1;
      if (this.reqItem('小凰', 计算用零件)) vehicle.武器上限 += 1;
      if (this.reqItem('小蓝', 计算用零件)) vehicle.功能上限 += 1;
      if (this.reqItem('小粉', 计算用零件)) vehicle.行走上限 += 1;
      vehicle.加成.生产 *= (1 + (productivity ?? 0) / 100);
    } else {
      // 生产类：咏星由 GameService 根据当前地图召唤物传入。
      const 咏星 = Number(options.yongxing || 0);
      if (this.reqItem('小粉', 计算用零件)) {
        vehicle.加成.生产 *= (1 + 0.05 + (productivity ?? 0) / 100 + 咏星);
      } else {
        vehicle.加成.生产 *= (1 + (productivity ?? 0) / 100 + 咏星);
      }
    }
    vehicle.加成.生产 = Math.round(vehicle.加成.生产 * 100) / 100;
    // 原版 L3836-3854：超限判定（行走/武器/防御/功能 超上限 → 当前生命=0）
    if (vehicle.行走 > vehicle.行走上限) { vehicle.当前生命 = 0; vehicle.行走方式 = 0; c = 1; }
    if (vehicle.武器 > vehicle.武器上限) { vehicle.当前生命 = 0; vehicle.行走方式 = 0; c = 1; }
    if (vehicle.防御 > vehicle.防御上限) { vehicle.当前生命 = 0; vehicle.行走方式 = 0; c = 1; }
    if (vehicle.功能 > vehicle.功能上限) { vehicle.当前生命 = 0; vehicle.行走方式 = 0; c = 1; }
    // 原版 L3855-3864：部件限制超出 → 当前生命=0
    if (部件限制.length > 0) {
      for (const pl of 部件限制) {
        const limit = Number(pl.数量 ?? pl.quantity ?? pl.数值 ?? 0);
        if (this.getItemQty(pl.名称, 部件限制) > limit) { c = 1; vehicle.当前生命 = 0; break; }
      }
    }
    // 原版 L3865-3897：生命回血（琪莎拉）/ 上限标志
    if (c === 0) {
      if (s == null) {
        return; // 原版 L3866-3868
      }
      if (vehicle.当前生命 < vehicle.加成.生命) {
        if (this.getItemQty('琪莎拉', 计算用零件) > 0) {
          if (vehicle.当前生命 === 0) {
            if (this.combatState.timeIntervalRequire('h1', 60, vehicle.标记2 || [], s, { value: '' }, s) === false) {
              vehicle.当前生命 += 1;
            }
          } else {
            if (this.combatState.timeIntervalRequire('h1', 30, vehicle.标记2 || [], s, { value: '' }, s) === false) {
              vehicle.当前生命 += 1;
            }
          }
        }
      }
    } else {
      vehicle.上限 = vehicle.上限 === 1 ? 3 : 2;
    }
    // 原版 L3895-3897：生命封顶
    if (vehicle.当前生命 > vehicle.加成.生命) vehicle.当前生命 = vehicle.加成.生命;
    // 同步英文字段，供 GameVehicle 持久化以及现有战斗代码读取。
    vehicle.生命 = Number(vehicle.加成.生命 || 0);
    vehicle.maxHp = vehicle.生命;
    vehicle.currentHp = vehicle.当前生命;
    vehicle.moveType = vehicle.行走方式;
    vehicle.slotStatus = vehicle.上限;
    // 原版 L3898-3911：产出分支（取生产产出）。
    if (calcOutput && s != null) {
      if (vehicle.上限 < 2) {
        return this.calculateVehicleProduction(vehicle, s, {
          yongxing: options.yongxing,
          lannBaby: options.lannBaby,
        });
      }
      // 原版超限分支不调用取生产产出，但仍保存本次读取时间。
      if (vehicle.配方.length > 0) vehicle.配方[0].数值 = s;
    }
    return undefined;
  }

  /** 原版 L3647-3714 四段：按部件类型套用 行走/防御/武器/功能 上限与超限 */
  private applyPartLimit(vehicle: any, spec: any, cp: any, field: string, specKey: string): void {
    const cur = (vehicle as any)[field] ?? 0;
    const limit = (vehicle as any)[field + '上限'] ?? 0;
    const specVal = (spec as any)[specKey] ?? 0;
    if (specVal >= 0) {
      if ((spec.limit ?? 0) <= 0) {
        (vehicle as any)[field + '上限'] = limit + (cp.数量 ?? 1) * specVal;
      } else if ((cp.数量 ?? 1) <= spec.limit) {
        (vehicle as any)[field + '上限'] = limit + (cp.数量 ?? 1) * specVal;
      } else {
        (vehicle as any)[field + '上限'] = limit + spec.limit * specVal + ((cp.数量 ?? 1) - spec.limit) / 2 * specVal;
        vehicle.上限 = 1;
      }
    } else {
      (vehicle as any)[field] = cur + (cp.数量 ?? 1) * Math.abs(specVal);
    }
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
    // 原版 L5398：计算载具(zj, s, , , , ) —— 完整 计算载具（本场景仅传 s，不进产出分支）
    this.computeVehicle(zj, s);

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

  /**
   * 地图定点管理员攻击 + 载具修复（对应原版 _主程序.ecode L200-535 覅攻击pd）
   *
   * 原版分支是完整"战斗()"driver 的入口，逐行还原要点：
   *   - L261-291 对地图每个怪物发起攻击（玩家武器 + 召唤物协同），含怪物闪避判定
   *   - L320-499 召唤物协同攻击、闪避、扶人、天神降世、觉醒宠物攻击（战斗循环子系统）
   *   - L507-530 载具修复：将玩家载具修复至满血，并发放载具材料
   *   - L202-206 延时递归（每回合约 2 秒）驱动后续怪物攻击
   *
   * 本框架现状：weaponAttack 已实现"玩家攻击地图怪物 + 召唤物协同攻击(summonCoAttack)"，
   * 故复用 weaponAttack 对所有地图怪物发起攻击；载具修复分支按原版 L507-530 独立实现。
   * 原版 L320-499 的召唤物攻击循环由 runMapSummonAttacks 接入统一武器攻击；
   * 觉醒宠物与怪物反击分别由 weaponAttack 协同分支和 monsterCounterAttack 结算。
   *
   * @param userId 用户ID
   * @param arg 地图参数（可选，原版按地图名定位，此处默认当前地图）
   * @returns 结果文本
   */
  async adminAttackMap(userId: number, arg: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 原版 L200-206：参数是地图列表的1-based编号，非法编号直接返回空文本。
    const maps = await this.mapService.getAllMaps();
    const requested = Number((arg || '').trim());
    const mapIndex = Number.isInteger(requested) && requested > 0 ? requested : 0;
    const map = mapIndex > 0 ? maps[mapIndex - 1] : await this.mapService.getMapById(player.mapId);
    if (!map) return '';
    const actualMapIndex = mapIndex || Number(map.mapIndex || map.id || 0);
    if (mapIndex > maps.length) return '';

    const nowMs = Date.now();
    // 兼容存量数据：地图标记2容器必须为数组（历史种子曾误写 '{}'）
    const rawMapMarkers2 = this.playerService.safeJsonParse<any>(map.markers2, []);
    const mapMarkers2 = Array.isArray(rawMapMarkers2) ? rawMapMarkers2 : [];
    const cooldownText = { value: '' };
    if (actualMapIndex > 0 && this.combatState.timeIntervalRequire(
      `gw${actualMapIndex}`,
      2,
      mapMarkers2,
      nowMs,
      cooldownText,
      nowMs,
    )) {
      return '';
    }
    map.markers2 = JSON.stringify(mapMarkers2);

    // 原版 L208-210：定点攻击前先移动临时怪物；GameMonster 已由地图服务独立持久化，
    // 读取最新实例即等价于原版内存中的移动后数组。
    const monsters = await this.mapService.getMapMonsters(map);
    if (monsters.length === 0) return '';

    const lines: string[] = [];
    const activityText = { value: '' };
    const active = this.combatState.markerRequire('活动', mapMarkers2, activityText, nowMs);
    if (!active) {
      // 原版 L212-235、L507-530：活动结束时只修复地图怪物和召唤物所挂载的低等级载具，
      // 不再执行攻击，也不发放额外物品。
      await this.repairMapVehicles(map, monsters, lines);
      map.markers2 = JSON.stringify(mapMarkers2);
      await this.mapService.updateDynamicFields(map.id, {
        markers2: map.markers2,
        vehicles: map.vehicles,
      });
      return lines.join('\n');
    }

    this.combatState.gainBuff(mapMarkers2, '战斗', 120, false, nowMs, 1, true);

    // 原版 L246-289：逐只处理怪物的闪避释放。
    await this.runAdminMonsterDodge(monsters, nowMs, lines);

    // 原版 L290-319：最多100次随机选择怪物，首个真正产生攻击文本的怪物结束本轮。
    const taskProgress: CombatTaskProgress[] = [];

    // 原版 加成计算.ecode L421-425：灼烧("sa")持续伤害结算——
    // 被誓约胜利之剑命中的怪物身上有"sa"标记（30秒），每次地图战斗节拍按
    // 物攻/10 × 经过秒数 对其造成真实伤害（三层池直扣，可击杀，无掉落）。
    await this.settleBurnDamage(map, monsters, userId, taskProgress, lines);

    for (let i = 0; i < 100 && lines.length === 0; i++) {
      const alive = monsters.filter((item: any) => (item.hp || 0) > 0);
      if (alive.length === 0) break;
      const monster = alive[Math.floor(Math.random() * alive.length)];
      if (this.hasActiveRuntimeBuff(monster.buffs, '麻醉', nowMs)
        || this.hasActiveRuntimeBuff(monster.buffs, '幻时', nowMs)) continue;
      const attackLines = await this.runMapMonsterAttack(monster, map, userId, taskProgress);
      if (attackLines.length > 0) lines.push(...attackLines);
    }

    // 原版 L320-499：召唤物协同、觉醒优先与普通召唤物攻击。
    const summonLines = await this.runMapSummonAttacks(map, player, userId);
    if (summonLines.length > 0) lines.push(...summonLines);

    // 原版 L320-350：存活的非被动召唤物（宠物）自动扶起同图倒地（卷土重来）玩家。
    const helpUpLines = await this.runMapSummonHelpUp(map);
    if (helpUpLines.length > 0) lines.push(...helpUpLines);

    map.markers2 = JSON.stringify(mapMarkers2);
    await this.mapService.updateDynamicFields(map.id, {
      markers2: map.markers2,
      summons: map.summons,
      vehicles: map.vehicles,
    });
    if (this.taskService && taskProgress.length > 0) {
      for (const progress of taskProgress) {
        if (progress.userId) {
          await this.taskService.advance(progress.userId, progress.actionName, progress.count);
        }
      }
    }
    return lines.join('\n');
  }

  /** 活动结束时修复怪物/召唤物挂载的低等级载具（原版 L214-229、L510-525）。 */
  private async repairMapVehicles(map: any, monsters: any[], lines: string[]): Promise<void> {
    const vehicles = this.playerService.safeJsonParse<any[]>(map.vehicles, []);
    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
    const actors = [...monsters, ...summons];
    let changed = false;
    for (const actor of actors) {
      const vehicleRef = actor?.vehicle ?? actor?.载具;
      if (!vehicleRef) continue;
      const vehicle = vehicles.find((item: any) => String(item?.id ?? item?.编号 ?? item?.name ?? item?.名称) === String(vehicleRef));
      if (!vehicle) continue;
      const current = Number(vehicle.currentHp ?? vehicle.当前生命 ?? 0);
      const maximum = Number(vehicle.maxHp ?? vehicle.生命 ?? vehicle.加成?.生命 ?? 0);
      const listIndex = Number(vehicle.列表编号 ?? vehicle.listIndex ?? 1);
      const upper = Number(vehicle.上限 ?? vehicle.limit ?? 0);
      if (current !== maximum && listIndex !== 0 && upper < 2) {
        vehicle.currentHp = maximum;
        vehicle.当前生命 = maximum;
        changed = true;
        lines.push(`${actor.name ?? actor.名称}修好了${vehicle.name ?? vehicle.名称}`);
      }
    }
    if (changed) map.vehicles = JSON.stringify(vehicles);
  }

  /** 原版 L246-289 的怪物闪避释放。 */
  private async runAdminMonsterDodge(monsters: any[], nowMs: number, lines: string[]): Promise<void> {
    for (const monster of monsters) {
      if ((monster.hp || 0) <= 0) continue;
      const buffs = this.playerService.safeJsonParse<any[]>(monster.buffs, []);
      const markers2 = this.playerService.safeJsonParse<any[]>(monster.markers2, []);
      if (this.hasActiveRuntimeBuff(monster.buffs, '麻醉', nowMs)) continue;
      const cooldown = Number(monster.dodgeCooldown ?? monster.闪避冷却 ?? this.safeJsonObject(monster.bonus).闪避冷却 ?? 0);
      if (cooldown <= 0 || Math.random() * 100 >= 50) continue;
      const fly = buffs.find((item: any) => (item?.name ?? item?.名称) === '飞羽');
      const flyLevel = Math.min(10, Number(fly?.value ?? fly?.强度 ?? 0));
      let actualCooldown = cooldown * (1 + flyLevel * 0.05);
      const shock = this.hasActiveRuntimeBuff(monster.markers2, '空间震', nowMs);
      if (shock) actualCooldown *= 2;
      const cdText = { value: '' };
      if (this.combatState.timeIntervalRequire('闪避冷却', actualCooldown, markers2, nowMs, cdText, nowMs)) continue;
      this.combatState.gainBuff(buffs, '闪避', 4, false, nowMs, 0);
      monster.buffs = JSON.stringify(buffs);
      monster.markers2 = JSON.stringify(markers2);
      await this.mapService.updateMonsterFields(monster.mapId, monster.id, {
        buffs: monster.buffs,
        markers2: monster.markers2,
      });
      const suffix = flyLevel > 0 ? `(冷却+${cooldown * flyLevel * 0.05}秒)` : '';
      lines.push(`${monster.name}尝试闪避攻击。${shock ? `${suffix}(双倍冷却)` : suffix}`);
    }
  }

  /**
   * 灼烧("sa")持续伤害结算（对应原版 加成计算.ecode L421-425）。
   *
   * 原版语义：誓约胜利之剑命中后给防御方获得增益("sa", 30, 假, 原始时间戳, 攻击方.属性.物伤/10, 假)，
   * 强度=攻击方物伤÷10；每次计算玩家时若目标仍带"sa"，则
   * 「添加特效 EX-伤害 → a1=攻击目标(, 玩家, s, , 玩家.时间差 × a1强度)」——
   * 即按 自上次结算以来经过的秒数 × 物攻/10 结算真实伤害（三层池直扣、可击杀、无掉落）。
   *
   * 本框架把"经过秒数"落在地图战斗节拍（adminAttackMap，原版 战斗() 每2秒节拍）上：
   * 每拍对带"sa"的存活怪物造成 (物伤/10)×(距上次灼烧结算秒数，封顶30秒标记剩余) 的伤害，
   * 并在怪物 markers 里记录「sa上次结算」时间戳。
   */
  private async settleBurnDamage(
    map: any,
    monsters: any[],
    userId: number,
    taskProgress: CombatTaskProgress[],
    lines: string[],
  ): Promise<void> {
    // 找到施放者当前物伤（原版 a1 = 攻击方.属性.物伤/10 在挂标记时已定值；
    // 这里取当前值近似——Saber 物伤在30秒窗口内变化很小）
    let physPerSec = 0;
    try {
      const casterData = await this.playerService.getPlayerData(userId);
      if (casterData?.player && String(casterData.player.type || '').toLowerCase() === 'saber') {
        const bonus = this.buildAttackerBonus(casterData.player, casterData, map);
        physPerSec = Number(bonus.物伤 || 0) / 10;
      }
    } catch {
      return; // 施放者不在线/数据缺失时跳过本次结算（标记仍在，下次再结）
    }
    if (physPerSec <= 0) return;

    const nowMs = Date.now();
    for (const monster of monsters) {
      if ((monster.hp || 0) <= 0) continue;
      const buffs = this.playerService.safeJsonParse<any[]>(monster.buffs, []);
      const saBuff = buffs.find((b: any) => b && (b.name ?? b.名称) === 'sa');
      if (!saBuff) continue;

      // 归一化有效期至（兼容秒/毫秒存量），过期即清掉并跳过
      const rawExpire = Number(saBuff.expireAt ?? saBuff.有效期至 ?? 0);
      const expireMs = rawExpire > 0 && rawExpire < 1e12 ? rawExpire * 1000 : rawExpire;
      if (!expireMs || expireMs <= nowMs) {
        monster.buffs = JSON.stringify(buffs.filter((b: any) => b !== saBuff));
        await this.mapService.updateMonsterFields(monster.mapId, monster.id, { buffs: monster.buffs });
        continue;
      }

      // 距上次灼烧结算的秒数（首次结算按1秒计，避免挂标记瞬间跳一大段）
      const markers = this.normalizeMarkerObject(monster.markers);
      const lastSettleMs = Number(markers['sa上次结算'] || 0);
      const elapsedSec = lastSettleMs > 0
        ? Math.min((nowMs - lastSettleMs) / 1000, (expireMs - nowMs) / 1000)
        : Math.min(2, (expireMs - nowMs) / 1000); // 首次：节拍间隔≈2秒
      if (elapsedSec <= 0) continue;

      // 剩余三层池（护盾→装甲→生命 顺序扣减）
      let dmg = physPerSec * elapsedSec;
      const shield = Number(monster.shield || 0);
      const armor = Number(monster.armor || 0);
      const hp = Number(monster.hp || 0);
      const toShield = Math.min(shield, dmg); dmg -= toShield;
      const toArmor = Math.min(armor, dmg); dmg -= toArmor;
      const toHp = Math.min(hp, dmg); dmg -= toHp;
      const totalDealt = toShield + toArmor + toHp;
      if (totalDealt <= 0) continue;

      monster.shield = shield - toShield;
      monster.armor = armor - toArmor;
      monster.hp = hp - toHp;
      markers['sa上次结算'] = nowMs;
      monster.markers = JSON.stringify(markers);

      await this.mapService.updateMonsterFields(monster.mapId, monster.id, {
        hp: monster.hp,
        shield: monster.shield,
        armor: monster.armor,
        markers: monster.markers,
        buffs: monster.buffs,
      });

      lines.push(`【誓约胜利之剑】${monster.name} 受到 ${Math.floor(totalDealt)} 点灼烧伤害（护盾-${Math.floor(toShield)} 装甲-${Math.floor(toArmor)} 生命-${Math.floor(toHp)}）`);

      // 灼烧击杀：走统一死亡处理（经验/掉落归灼烧施加者），但不再触发其反击链
      if ((monster.hp || 0) <= 0) {
        lines.push(`${monster.name} 被灼烧殆尽`);
        const deathResult = await this.handleMonsterDeath(monster, userId, map.id);
        taskProgress.push(...(deathResult.taskProgress || []));
      }
    }
  }

  /** 原版 战斗() 的怪物攻击分支：一只怪物的全部武器攻击所有可攻击参与者。 */
  private async runMapMonsterAttack(
    monster: any,
    map: any,
    userId: number,
    taskProgress?: CombatTaskProgress[],
  ): Promise<string[]> {
    const lines: string[] = [];
    const monsterBonus = this.buildMonsterBonus(monster);
    const weaponList = this.getRuntimeWeapons(monster);
    const weapons = weaponList.length > 0 ? weaponList : [null];
    const victims: Array<{ actor: any; data: PlayerData; runtime: boolean; isSelf: boolean }> = [];

    // 原版 L4647-L4660：地图有启示录标记时，25% 概率改为怪物攻击自己，
    // 不再进入玩家/召唤物防御方筛选。启示录技能原文写入“福音书”，两者均兼容。
    const rawMapMarkers2 = this.playerService.safeJsonParse<any>(map.markers2, []);
    const mapMarkers2 = Array.isArray(rawMapMarkers2) ? rawMapMarkers2 : [];
    const apocalypseActive = this.hasActiveRuntimeBuff(map.markers2, '启示录')
      || this.hasActiveRuntimeBuff(map.markers2, '福音书');
    const apocalypseConfusion = apocalypseActive && Math.random() * 100 < 25;
    if (apocalypseConfusion) {
      monster.mapId = map.id;
      victims.push({
        actor: monster,
        data: this.createRuntimeActorData(monster),
        runtime: true,
        isSelf: false,
      });
      lines.push(`${monster.name}陷入【启示录混乱】`);
    } else {
      // 原版顺序：玩家先加入防御方，召唤物随后加入。
      const online = new Set(this.statsService.getOnlineUserIds());
      online.add(userId);
      const rows = await this.prisma.player.findMany({ where: { mapId: map.id }, select: { userId: true } });
      for (const row of rows) {
        if (!online.has(row.userId)) continue;
        const data = await this.playerService.getPlayerData(row.userId);
        if (this.playerService.isPlayerDead(data.player)) continue;
        const buffs = this.playerService.safeJsonParse<any[]>(data.player.buffs, []);
        if (buffs.some((item: any) => ['隐匿模式', '炮冠'].includes(item?.name ?? item?.名称))) continue;
        victims.push({ actor: data.player, data, runtime: false, isSelf: row.userId === userId });
      }

      const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
      for (const summon of summons) {
        if ((summon?.hp ?? summon?.当前生命 ?? 0) <= 0) continue;
        summon.mapId = map.id;
        victims.push({ actor: summon, data: this.createRuntimeActorData(summon), runtime: true, isSelf: false });
      }
    }
    for (const rawWeapon of weapons) {
      const weapon = rawWeapon ? this.getWeaponData(monster, weaponList.indexOf(rawWeapon) + 1) : undefined;
      for (const victim of victims) {
        lines.push(...await this.monsterCounterAttackOnePlayer(
          monster,
          monsterBonus,
          victim.actor,
          victim.data,
          map,
          victim.isSelf,
          weapon,
          victim.runtime,
          taskProgress,
        ));
      }
      if (lines.some((line) => line.includes('幻时凝固'))) break;
    }
    await this.mapService.saveGameMonster(monster);
    return lines;
  }

  /** 原版 L320-499 的召唤物武器循环，使用统一武器攻击结算。 */
  private async runMapSummonAttacks(map: any, player: any, userId: number): Promise<string[]> {
    const lines: string[] = [];
    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
    for (const summon of summons) {
      const owner = summon?.ownerQQ ?? summon?.归属;
      if (String(owner) !== String(player.userId) && String(owner) !== String(player.qqNumber || '')) continue;
      if ((summon?.hp ?? summon?.当前生命 ?? 0) <= 0) continue;
      const active = this.playerService.getMarkerValue(
        this.normalizeMarkerObject(summon.markers ?? summon.标记 ?? {}),
        '主动',
      );
      if (active === 1) continue;
      const weaponList = this.getRuntimeWeapons(summon);
      const weaponIndex = weaponList.length > 0 ? 1 : 0;
      summon.mapId = map.id;
      const result = await this.weaponAttack(userId, weaponIndex, {
        attackerOverride: summon,
        targetMapId: map.id,
        noDelay: true,
        isDelayed: true,
        skipBattleDriver: true,
      });
      if (result.result) lines.push(result.result);
      if (result.killed.length > 0) break;
    }
    return lines;
  }

  /**
   * 地图战斗节拍：存活的非被动召唤物（宠物）自动扶起同图倒地玩家。
   * 对应原版 _主程序.ecode L320-350 覅攻击pd 内的「#扶玩家」循环：
   *   - 召唤物 标记"主动"==1（被动）跳过；当前生命<=0（死亡）跳过；
   *   - 玩家 标记"不扶"==1 时跳过（设置不扶）；
   *   - 玩家增益含未过期的"卷土重来"才扶；
   *   - 扶起 = 缩短卷土重来30秒（原版 获得增益("卷土重来",-30,真)，等效立即移除）+ 恢复一半生命；
   *   - 文本「{宠物名}扶起了{玩家名}」，宠物武器进入5秒冷却（冷却标记仅影响宠物攻击节奏，此处省略）。
   * @param map 当前地图（summons 会被就地修改并由调用方持久化）
   */
  private async runMapSummonHelpUp(map: any): Promise<string[]> {
    const lines: string[] = [];
    try {
      const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
      if (summons.length === 0) return lines;

      // 同图全部倒地玩家（卷土重来 buff 未过期），含离线玩家——原版按地图玩家数组遍历，不筛在线。
      let fallenPlayers: any[] = [];
      if (this.prisma?.player?.findMany) {
        fallenPlayers = await this.prisma.player.findMany({ where: { mapId: map.id } });
        fallenPlayers = fallenPlayers.filter((p: any) => this.hasActiveRuntimeBuff(p.buffs, '卷土重来'));
      }
      if (fallenPlayers.length === 0) return lines;

      const nowMs = Date.now();
      let changed = false;
      for (const summon of summons) {
        if (fallenPlayers.length === 0) break;
        // 原版 L322：标记"主动"==1 为被动模式，不参与扶人
        const active = this.playerService.getMarkerValue(
          this.normalizeMarkerObject(summon.markers ?? summon.标记 ?? {}),
          '主动',
        );
        if (active === 1) continue;
        // 原版 L328：死亡召唤物不扶人
        if ((Number(summon?.hp ?? summon?.当前生命 ?? 0)) <= 0) continue;

        const summonName = summon?.name ?? summon?.名称 ?? '宠物';
        for (const victim of [...fallenPlayers]) {
          // 原版 L336：玩家标记"不扶"==1 时跳过（设置不扶）
          const victimMarkers = this.normalizeMarkerObject(victim.markers);
          if (this.playerService.getMarkerValue(victimMarkers, '不扶') === 1) continue;

          // 原版 L342-344：缩短卷土重来30秒 + 恢复一半生命
          const buffs = this.playerService.safeJsonParse<any[]>(victim.buffs, []);
          const jtIdx = buffs.findIndex((b: any) => b && (b.name ?? b.名称) === '卷土重来');
          if (jtIdx < 0) continue;
          buffs.splice(jtIdx, 1);
          victim.buffs = JSON.stringify(buffs);
          victim.hp = Math.floor(Number(victim.maxHp || 100) / 2);
          await this.playerService.savePlayer(victim);

          lines.push(`${summonName}扶起了${victim.name || '冒险者'}`);
          changed = true;
          const idx = fallenPlayers.indexOf(victim);
          if (idx >= 0) fallenPlayers.splice(idx, 1);
          if (fallenPlayers.length === 0) break;
        }
      }

      if (changed && this.mapService.updateDynamicFields) {
        await this.mapService.updateDynamicFields(map.id, { summons: JSON.stringify(summons) });
      }
    } catch (e: any) {
      this.logger.warn(`宠物自动扶人失败: ${e.message}`);
    }
    return lines;
  }

  private safeJsonObject(value: any): Record<string, any> {
    if (value && typeof value === 'object') return value;
    return this.playerService.safeJsonParse<Record<string, any>>(value, {});
  }

  private hasActiveRuntimeBuff(value: any, name: string, nowMs = Date.now()): boolean {
    const list = this.playerService.safeJsonParse<any[]>(value, Array.isArray(value) ? value : []);
    return list.some((item: any) => {
      if ((item?.name ?? item?.名称) !== name) return false;
      const raw = Number(item?.expireAt ?? item?.有效期至 ?? 0);
      if (!raw) return true;
      return (raw < 1e12 ? raw * 1000 : raw) > nowMs;
    });
  }

  /**
   * 延时攻击：按 QQ$武器 定位召唤物/怪物/玩家并以其武器攻击（对应原版 _主程序.ecode L536-674 覅公jj）
   *
   * 原版三种模式：
   *   1. 召唤物$武器（含"g"）：用召唤物武器攻击地图怪物2
   *   2. 怪物$武器：怪物用武器攻击玩家数组（含幻时）
   *   3. 玩家$武器（默认）：玩家用当前武器攻击地图怪物2
   *
   * 本框架三种模式均复用统一战斗模型：召唤物通过 attackerOverride 攻击怪物，
   * 怪物通过 monsterCounterAttackOnePlayer 攻击玩家/召唤物，玩家走 weaponAttack。
   *
   * @param userId 用户ID
   * @param arg 形如 "QQ$武器名" 的参数
   * @returns 结果文本
   */
  async delayedAttackByQQWeapon(userId: number, arg: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const input = (arg || '').trim();
    if (!input) return '';

    // 原版 L536-540：关键词按“QQ$武器名”拆分，成员数不为2时只返回格式错误。
    const parts = input.split('$');
    if (parts.length !== 2) return `延迟攻击输入的数据不正确：${input}`;
    const targetQQ = parts[0];
    const weaponName = parts[1];

    // 原版 L541-565：召唤物（QQ 以 g 结尾或名称以“召唤物”开头）全地图查找，
    // 不要求当前生命大于0；找到武器后以“全体攻击+无延时”调用同一个武器攻击子程序。
    if (targetQQ.endsWith('g') || targetQQ.startsWith('召唤物')) {
      const maps = await this.getAllMapsForDelayedAttack(player.mapId);
      for (const map of maps) {
        const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
        const summon = summons.find((item: any) => String(item?.QQ ?? item?.qq ?? '') === targetQQ);
        if (!summon) continue;

        const weapons = this.getRuntimeWeapons(summon);
        const weaponIndex = weapons.findIndex((item: any) => this.getRuntimeWeaponName(item) === weaponName);
        if (weaponIndex < 0) {
          return `${summon.name ?? summon.名称 ?? targetQQ}的延时攻击武器${weaponName}不在身上`;
        }

        summon.mapId = map.id;
        const result = await this.weaponAttack(userId, weaponIndex + 1, {
          attackerOverride: summon,
          targetMapId: map.id,
          allAttack: true,
          noDelay: true,
          isDelayed: true,
          skipBattleDriver: true,
        });
        return result.result;
      }
      return '';
    }

    // 原版 L566-652：怪物$武器。怪物在幻时地图中只输出“被幻时凝固”，
    // 否则收集存活召唤物和未隐匿/未炮冠的玩家，逐一作为防御方结算该武器。
    if (input.startsWith('怪物')) {
      const maps = await this.getAllMapsForDelayedAttack(player.mapId);
      for (const map of maps) {
        const monsters = await this.mapService.getMapMonsters(map);
        const monster = monsters.find((item: any) => String(item?.qq ?? item?.QQ ?? '') === targetQQ);
        if (!monster) continue;

        const weaponList = this.getRuntimeWeapons(monster);
        const weaponIndex = weaponList.findIndex((item: any) => this.getRuntimeWeaponName(item) === weaponName);
        if (weaponIndex < 0) {
          return `${monster.name}的延时攻击武器${weaponName}不在身上`;
        }

        const mapMarkers = this.playerService.safeJsonParse<any[]>(map.markers3 ?? map.标记3 ?? '[]', []);
        const nowMs = Date.now();
        const isFrozen = mapMarkers.some((item: any) => {
          const name = item?.名称 ?? item?.name;
          const expire = Number(item?.有效期至 ?? item?.expireAt ?? 0);
          const expireMs = expire > 0 && expire < 1e12 ? expire * 1000 : expire;
          return name === '幻时' && (!expireMs || expireMs > nowMs);
        });
        if (isFrozen) return `${monster.name}被幻时凝固`;

        monster.mapId = map.id;
        const attackWeapon = this.getWeaponData(monster, weaponIndex + 1);
        const monsterBonus = this.buildMonsterBonus(monster);
        const victims: Array<{ actor: any; data: PlayerData; runtime: boolean; isSelf: boolean }> = [];

        const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
        for (const summon of summons) {
          if ((summon?.hp ?? summon?.当前生命 ?? 0) <= 0) continue;
          summon.mapId = map.id;
          victims.push({
            actor: summon,
            data: this.createRuntimeActorData(summon),
            runtime: true,
            isSelf: false,
          });
        }

        const playerRows = await this.prisma.player.findMany({
          where: { mapId: map.id },
          select: { userId: true },
        });
        for (const row of playerRows) {
          const victimData = await this.playerService.getPlayerData(row.userId);
          const victim = victimData.player;
          if (this.playerService.isPlayerDead(victim)) continue;
          const buffs = this.playerService.safeJsonParse<any[]>(victim.buffs, []);
          if (buffs.some((item: any) => ['隐匿模式', '炮冠'].includes(item?.name ?? item?.名称))) continue;
          victims.push({
            actor: victim,
            data: victimData,
            runtime: false,
            isSelf: row.userId === userId,
          });
        }

        const lines: string[] = [];
        for (const victim of victims) {
          lines.push(...await this.monsterCounterAttackOnePlayer(
            monster,
            monsterBonus,
            victim.actor,
            victim.data,
            map,
            victim.isSelf,
            attackWeapon,
            victim.runtime,
          ));
        }
        await this.mapService.saveGameMonster(monster);
        return lines.join('\n');
      }
      return '';
    }

    // 原版 L653-671：玩家$武器只允许“当前武器名称”匹配，然后使用当前武器攻击其所在地图。
    const targetUser = await this.findUserByDelayedTarget(targetQQ, player, userId);
    if (!targetUser?.id) return '';
    const targetData = await this.playerService.getPlayerData(targetUser.id);
    const currentWeapon = Number(targetData.player.currentWeapon || 0);
    const currentWeapons = this.getRuntimeWeapons(targetData.player);
    const currentWeaponItem = currentWeapon > 0 ? currentWeapons[currentWeapon - 1] : undefined;
    if (!currentWeapon || this.getRuntimeWeaponName(currentWeaponItem) !== weaponName) {
      return `${targetData.player.name}的延时攻击武器${weaponName}不在身上`;
    }
    const result = await this.weaponAttack(targetUser.id, currentWeapon, {
      noDelay: true,
      isDelayed: true,
      skipBattleDriver: true,
    });
    return result.result;
  }

  /** 读取延时攻击所需的地图快照，优先保留当前地图作为兜底。 */
  private async getAllMapsForDelayedAttack(currentMapId: number): Promise<any[]> {
    const current = await this.mapService.getMapById(currentMapId).catch(() => null);
    const all = await this.mapService.getAllMaps().catch(() => []);
    const maps = Array.isArray(all) ? all : [];
    if (current && !maps.some((item: any) => item?.id === current.id)) maps.unshift(current);
    return maps;
  }

  private getRuntimeWeapons(actor: any): any[] {
    const value = actor?.weapons ?? actor?.武器 ?? '[]';
    const weapons = this.playerService.safeJsonParse<any[]>(value, Array.isArray(value) ? value : []);
    return Array.isArray(weapons) ? weapons : [];
  }

  private getRuntimeWeaponName(weapon: any): string {
    return String(weapon?.name ?? weapon?.名称 ?? weapon ?? '');
  }

  private async findUserByDelayedTarget(targetQQ: string, player: any, userId: number): Promise<any | null> {
    if (String(targetQQ) === String(player.userId) || String(targetQQ) === String(player.id)) {
      return { id: userId };
    }
    const byQQ = await this.prisma.user.findFirst({
      where: { qqNumber: targetQQ },
      select: { id: true },
    }).catch(() => null);
    if (byQQ) return byQQ;
    if (/^\d+$/.test(targetQQ)) {
      return await this.prisma.user.findUnique({
        where: { id: Number(targetQQ) },
        select: { id: true },
      }).catch(() => null);
    }
    return null;
  }
}
