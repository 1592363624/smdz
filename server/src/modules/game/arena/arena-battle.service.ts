/**
 * 角斗镜像对战结算器（无头：不进地图、不写玩家、不引怪、不广播）。
 *
 * ## 单一真相源
 * 伤害数值一律复用 `CombatSystemService` 的现成实现，本文件只做「时间轴 + 三池扣减 + 判定」：
 * - 属性块：`buildAttackerBonus(player, playerData)`（装备/套装/使魔/标记加成同源）；
 * - 武器解析：`getWeaponData(actor, weaponIndex)`（伤害、属性系数、冷却、特效语义）；
 * - 命中/暴击：`calcHitRate` / `checkHit` / `checkCrit`；
 * - 单次伤害：`calcDamage(...)`，含三段评级、贯穿、侵彻、三层抗性与 **三池分伤 poolDamage**。
 * 复制一份公式＝第二条真相源，PVE 一改平衡 PVP 就失真，所以这里一行伤害公式都不写。
 *
 * ## v1 明确不结算的机制（不做假装有）
 * 主动使魔技能、召唤物/宠物助战、免死复活链路（军姬/死亡行者/石中剑）、
 * 受击增益与负面状态（灼烧/深寒/割裂/感电）、载具承伤、套装对特定武器类型的减伤匹配、
 * 恶毒「暴怒」这类击杀触发的三池回满。镜像对战只保证「面板属性 + 在手武器」的对抗。
 *
 * ## 与 PVE 的三处刻意差异
 * 1. **世界等级差距清零**：新人加成/世界等级压制是 PVE 的成长保护，玩家互殴不该套用；
 * 2. **三段评级熟练度只在内存里累加**：真实 PVE 会把它写回玩家标记，竞技场绝不（打完就丢）；
 * 3. **三池回复按时间轴秒计 + 吸血按 吸生命 结算**：让肉盾/吸血构筑能撑到时限，
 *    而不是所有对局都单调地磨到死亡。
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { BonusData } from '../bonus.service';
import { CombatSystemService } from '../combat-system.service';
import { COMBAT_SYSTEM_SERVICE } from '../service-tokens';
import { formatDisplayNumber } from '../../../common/utils/game-text.util';
import { MirrorSnapshot, mirrorBonusDigest, restoreMirrorActor } from './mirror-snapshot.util';

/** 参战一侧：镜像快照 + 展示身份 */
export interface ArenaFighter {
  /** 己方=attacker（主动挑战），对方=defender（被挑战的镜像主人） */
  side: 'attacker' | 'defender';
  userId: number;
  name: string;
  snapshot: MirrorSnapshot;
  /** 佩戴中的头像框名（战报头部展示，可空） */
  frameName?: string;
}

export interface ArenaFightOptions {
  /** 时间轴上限（秒），到点未分生死按剩余生命比例判定 */
  timeLimitSec?: number;
  /** 出手次数上限（防极端数据打满 CPU） */
  maxActions?: number;
}

/** 单次出手记录（存进战报，前端可逐回合回放） */
export interface ArenaAction {
  /** 出手时刻（秒） */
  t: number;
  side: 'attacker' | 'defender';
  weapon: string;
  hit: boolean;
  crit: boolean;
  /** 三段评级文本（【绝杀】142% 等），未命中为空 */
  rating: string;
  /** 本次总伤害（三池合计，未命中为 0） */
  damage: number;
  poolDamage: { shield: number; armor: number; hp: number };
  /** 承伤方三池余量 */
  targetPools: { shield: number; armor: number; hp: number };
  /** 本次吸血量 */
  leech: number;
}

export interface ArenaFightResult {
  /** attacker / defender / draw */
  winner: 'attacker' | 'defender' | 'draw';
  /** 结束原因：ko=击倒 / timeup=时间上限判生命 / cap=出手上限 */
  reason: 'ko' | 'timeup' | 'cap';
  /** 双方合计出手次数 */
  actions: number;
  durationSec: number;
  lines: string[];
  sides: Record<'attacker' | 'defender', {
    userId: number;
    name: string;
    level: number;
    power: number;
    bonus: Record<string, number>;
    /** 终局三池（护盾/装甲/生命） */
    pools: { shield: number; armor: number; hp: number };
    /** 该侧承伤与命中统计 */
    taken: { actions: number; hits: number; damage: number };
  }>;
  /** 逐回合明细（存 ArenaMatch.report） */
  actionLog: ArenaAction[];
}

/** 一侧的战斗状态：可变属性块（三池字段即当前值）+ 下一次可出手时刻 */
interface FighterState {
  fighter: ArenaFighter;
  actor: any;
  playerData: any;
  bonus: BonusData;
  weapon: any;
  pools: { shield: number; armor: number; hp: number };
  maxPools: { shield: number; armor: number; hp: number };
  nextAt: number;
  cooldown: number;
  /** 上次结算三池回复的时刻（秒），用于按秒推进 生命回复/装甲回复/护盾回复 */
  lastRegenAt: number;
  actions: number;
  hits: number;
  takenDamage: number;
  takenActions: number;
}

@Injectable()
export class ArenaBattleService {
  private readonly logger = new Logger(ArenaBattleService.name);

  constructor(
    /**
     * 走字符串 token 别名注入：CombatSystemService 处在 game 模块的依赖深链里，
     * 直接 import 会翻转 CommonJS 模块初始化顺序（见 service-tokens.ts 说明）。
     */
    @Optional() @Inject(COMBAT_SYSTEM_SERVICE)
    private readonly combat?: CombatSystemService,
  ) {}

  /**
   * 跑完整场镜像对战。纯内存计算，不产生任何写库。
   * @throws 缺少战斗引擎时抛出（调用方按「竞技场暂不可用」处理）
   */
  fight(attacker: ArenaFighter, defender: ArenaFighter, opts: ArenaFightOptions = {}): ArenaFightResult {
    if (!this.combat || typeof (this.combat as any).calcDamage !== 'function') {
      throw new Error('竞技场战斗引擎未就绪');
    }
    const timeLimit = Math.max(1, Number(opts.timeLimitSec) || 180);
    const maxActions = Math.max(2, Number(opts.maxActions) || 400);

    const a = this.buildFighterState(attacker);
    const b = this.buildFighterState(defender);
    const actionLog: ArenaAction[] = [];
    let t = 0;
    let actions = 0;
    let reason: ArenaFightResult['reason'] = 'cap';

    // t=0 双方同时可出手，先手给挑战方（主动进场的信息优势）
    while (actions < maxActions) {
      const nextA = a.nextAt;
      const nextB = b.nextAt;
      const soonest = Math.min(nextA, nextB);
      if (soonest > timeLimit) { t = timeLimit; reason = 'timeup'; break; }
      t = soonest;
      // 先出手者：时刻相同（开局）时攻击方优先
      const atkState = nextA <= nextB ? a : b;
      const defState = atkState === a ? b : a;
      // 三池按秒回复：把两侧都推进到当前时刻，再结算这一次出手。
      // 只推进出手方的话，挨打那一侧的余量会停留在"上次自己出手时"，肉盾构筑莫名多挨伤。
      advanceRegen(a, t);
      advanceRegen(b, t);
      // 只推进本次出手者的计时器；回合同时开始即冷却
      atkState.nextAt = soonest + atkState.cooldown;
      const action = this.resolveStrike(atkState, defState, t);
      actionLog.push(action);
      actions++;
      if (defState.pools.hp <= 0) { reason = 'ko'; break; }
    }

    let winner: ArenaFightResult['winner'];
    if (reason === 'ko') {
      winner = a.pools.hp <= 0 ? 'defender' : 'attacker';
    } else {
      // 时间/次数上限：按剩余生命比例（三池合计占上限的比例）判定，相等记平
      const ratioA = lifeRatio(a);
      const ratioB = lifeRatio(b);
      winner = ratioA > ratioB ? 'attacker' : ratioB > ratioA ? 'defender' : 'draw';
    }

    const lines = this.renderReport(attacker, defender, a, b, winner, reason, actions, t, actionLog);
    return {
      winner,
      reason,
      actions,
      durationSec: Math.round(t * 100) / 100,
      lines,
      actionLog,
      sides: {
        attacker: sideView(attacker, a),
        defender: sideView(defender, b),
      },
    };
  }

  /**
   * 由镜像快照还原一侧战斗状态。
   *
   * 三池基数取 `buildAttackerBonus` 的 生命/装甲/护盾（该方法以 maxHp/maxShield/maxArmor
   * 为基数，不读当前血量），因此镜像天然满状态入场——打的是配置，不是「刚打完本的血皮」。
   */
  private buildFighterState(fighter: ArenaFighter): FighterState {
    const { actor, playerData } = restoreMirrorActor(fighter.snapshot);
    const bonus = this.combat!.buildAttackerBonus(actor, playerData, null) as BonusData;
    // 竞技场是玩家互殴：世界等级差距（新人保护/压制）不适用，两侧统一清零
    bonus.世界等级差距 = 0;
    const weaponIndex = this.pickWeaponIndex(fighter, playerData);
    const weapon = this.combat!.getWeaponData(actor, weaponIndex);
    const cooldown = Math.max(0.5, Number(weapon?.cooldown) || 5);
    const pools = {
      shield: Math.max(0, Number(bonus.护盾) || 0),
      armor: Math.max(0, Number(bonus.装甲) || 0),
      hp: Math.max(1, Number(bonus.生命) || 1),
    };
    return {
      fighter,
      actor,
      playerData,
      bonus,
      weapon: { ...(weapon || {}), index: weaponIndex },
      pools,
      maxPools: { ...pools },
      nextAt: 0,
      cooldown,
      lastRegenAt: 0,
      actions: 0,
      hits: 0,
      takenDamage: 0,
      takenActions: 0,
    };
  }

  /**
   * 镜像默认武器：优先用快照里的「当前武器」（1-based，0=赤手）；
   * 赤手但背包里有武器时回落第一件，避免把「忘了切武器」的玩家钉死在拳头上。
   */
  private pickWeaponIndex(fighter: ArenaFighter, playerData: any): number {
    const raw = Number(fighter.snapshot.currentWeapon ?? playerData?.player?.currentWeapon ?? 0);
    const count = Array.isArray(playerData?.weapons) ? playerData.weapons.length : 0;
    if (raw >= 1 && raw <= count) return Math.floor(raw);
    if (count > 0) return 1;
    return 0;
  }

  /** 一次出手：命中判定 → 暴击判定 → calcDamage → 三池扣减 → 吸血 → 战报行 */
  private resolveStrike(atk: FighterState, def: FighterState, t: number): ArenaAction {
    const combat = this.combat!;
    const weapon = atk.weapon as any;
    const defBonus = this.liveBonus(def);
    atk.actions++;
    def.takenActions++;

    const mustHit = !!(weapon?.effectFlags?.mustHit);
    const hitRate = combat.calcHitRate(atk.bonus, defBonus, mustHit);
    if (!combat.checkHit(hitRate, 0)) {
      return {
        t: round2(t), side: atk.fighter.side, weapon: String(weapon?.name ?? '拳头'),
        hit: false, crit: false, rating: '', damage: 0,
        poolDamage: { shield: 0, armor: 0, hp: 0 },
        targetPools: { ...def.pools }, leech: 0,
      };
    }
    const crit = combat.checkCrit(Number(atk.bonus.暴击) || 0, 0);
    // 三段评级熟练度：只改内存副本，绝不回写玩家（真实 PVE 才累加熟练度）
    const markers = (atk.playerData?.markers || {}) as Record<string, any>;
    const mastery = {
      致命: Number(markers['致命熟练度']) || 0,
      强力: Number(markers['强力熟练度']) || 0,
      正中: Number(markers['正中熟练度']) || 0,
      擦过: Number(markers['擦过熟练度']) || 0,
      描边: Number(markers['描边熟练度']) || 0,
    };
    const defMarkers = (def.playerData?.markers || {}) as Record<string, any>;
    const sets = (atk.playerData?.sets || {}) as Record<string, any>;
    const result = combat.calcDamage(atk.bonus, defBonus, weapon, Number(weapon?.damageType) || 0, crit, {
      mastery,
      amplifier3: (atk.bonus as any).amplifier3 === 3,
      amplifier5: (sets['增幅器'] ?? sets.amplifier ?? 0) === 5,
      weaponAnesthesia: weapon?.self?.anesthesia ?? weapon?.anesthesia ?? 0,
      sniperComputer: hasSniperComputer(def.playerData?.equipment),
      defenderEquipment: Array.isArray(def.playerData?.equipment) ? def.playerData.equipment : [],
      defenderMarkers: defMarkers,
      defenderBuffs: Array.isArray(def.playerData?.buffs) ? def.playerData.buffs : [],
    });

    const pool = result.poolDamage || { shield: 0, armor: 0, hp: 0 };
    // 三池按当前余量截断扣减（引擎内已 min 过一次，这里再兜一层防御脏数据）
    const shieldCut = Math.min(def.pools.shield, Math.max(0, pool.shield || 0));
    const armorCut = Math.min(def.pools.armor, Math.max(0, pool.armor || 0));
    const hpCut = Math.min(def.pools.hp, Math.max(0, pool.hp || 0));
    def.pools.shield -= shieldCut;
    def.pools.armor -= armorCut;
    def.pools.hp -= hpCut;
    const finalDamage = Math.round((shieldCut + armorCut + hpCut) * 100) / 100;
    def.takenDamage = round2(def.takenDamage + finalDamage);
    atk.hits++;

    // 吸血：按攻击方 吸生命 比例回补自身生命池（不超过上限），让消耗战能收敛
    let leech = 0;
    if (finalDamage > 0) {
      try {
        leech = Number(combat.calcLeech(finalDamage, Number(atk.bonus.吸生命) || 0)) || 0;
      } catch {
        leech = 0;
      }
      if (leech > 0) atk.pools.hp = Math.min(atk.maxPools.hp, atk.pools.hp + leech);
    }

    return {
      t: round2(t),
      side: atk.fighter.side,
      weapon: String(weapon?.name ?? '拳头'),
      hit: true,
      crit,
      rating: String(result.rating ?? ''),
      damage: finalDamage,
      poolDamage: { shield: round2(shieldCut), armor: round2(armorCut), hp: round2(hpCut) },
      targetPools: { shield: round2(def.pools.shield), armor: round2(def.pools.armor), hp: round2(def.pools.hp) },
      leech: round2(leech),
    };
  }

  /**
   * 承伤用的「当前值属性块」：calcDamage 读 defBonus 的 生命/装甲/护盾 作各池当前血量，
   * 因此每回合都要把可变三池回写到一份副本上（不改动原始 bonus，避免污染上限计算）。
   */
  private liveBonus(state: FighterState): BonusData {
    return {
      ...state.bonus,
      护盾: state.pools.shield,
      装甲: state.pools.armor,
      生命: state.pools.hp,
    };
  }

  /** 战报正文（MUD 口吻，行数组；指令侧按需截尾展示） */
  private renderReport(
    attacker: ArenaFighter,
    defender: ArenaFighter,
    a: FighterState,
    b: FighterState,
    winner: ArenaFightResult['winner'],
    reason: ArenaFightResult['reason'],
    actions: number,
    duration: number,
    log: ArenaAction[],
  ): string[] {
    const winnerName = winner === 'draw' ? '' : (winner === 'attacker' ? attacker.name : defender.name);
    const head = [
      '⚔️ 使魔竞技场 · 战报',
      `攻方 ${attacker.name}（Lv.${attacker.snapshot.level} 战力 ${formatDisplayNumber(attacker.snapshot.power)}${attacker.frameName ? ` · ${attacker.frameName}` : ''}）`,
      `守方 ${defender.name}（Lv.${defender.snapshot.level} 战力 ${formatDisplayNumber(defender.snapshot.power)}${defender.frameName ? ` · ${defender.frameName}` : ''}）`,
      '─'.repeat(16),
    ];
    const body = log.map((action) => {
      const atkName = action.side === 'attacker' ? attacker.name : defender.name;
      const defName = action.side === 'attacker' ? defender.name : attacker.name;
      const stamp = `[${action.t.toFixed(1)}s]`;
      if (!action.hit) return `${stamp} ${atkName} 的${action.weapon}落空，被 ${defName} 闪避`;
      const critText = action.crit ? ' 暴击' : '';
      const ratingText = action.rating ? `${action.rating}` : '';
      const pools = action.targetPools;
      return `${stamp} ${atkName} 用 ${action.weapon} 命中 ${defName}：${ratingText}${critText} ${formatDisplayNumber(Math.round(action.damage))}`
        + `（盾-${Math.round(action.poolDamage.shield)} 甲-${Math.round(action.poolDamage.armor)} 命-${Math.round(action.poolDamage.hp)}）`
        + ` 余 盾${Math.round(pools.shield)}/甲${Math.round(pools.armor)}/命${Math.round(pools.hp)}`
        + (action.leech > 0 ? ` ｜ ${atkName} 吸血 ${Math.round(action.leech)}` : '');
    });
    const resultText = winner === 'draw'
      ? '结果：势均力敌，判定平局（双方分数不变）'
      : `结果：${winnerName} 胜（${reason === 'ko' ? '击倒对手' : reason === 'timeup' ? '时间到，按剩余生命判定' : '出手上限，按剩余生命判定'}，共 ${actions} 次出手 / ${round2(duration)} 秒）`;
    const stats = [
      '─'.repeat(16),
      `${attacker.name}：出手 ${a.actions} 命中 ${a.hits}，承受 ${formatDisplayNumber(Math.round(a.takenDamage))} 伤害；终局 盾${Math.round(a.pools.shield)}/甲${Math.round(a.pools.armor)}/命${Math.round(a.pools.hp)}`,
      `${defender.name}：出手 ${b.actions} 命中 ${b.hits}，承受 ${formatDisplayNumber(Math.round(b.takenDamage))} 伤害；终局 盾${Math.round(b.pools.shield)}/甲${Math.round(b.pools.armor)}/命${Math.round(b.pools.hp)}`,
    ];
    return [...head, ...body, ...stats, resultText];
  }
}

/**
 * 按秒推进三池回复（生命回复/装甲回复/护盾回复），上限锁在快照算出的三池上限内。
 * 竞技场把时间轴显式跑出来，所以回复也按经过秒计，与 PVE 的"每秒回一拍"同口径。
 */
function advanceRegen(state: FighterState, now: number): void {
  const elapsed = now - state.lastRegenAt;
  if (elapsed <= 0) return;
  state.lastRegenAt = now;
  const regen = (current: number, max: number, rate: number | undefined) => {
    const gain = (Number(rate) || 0) * elapsed;
    if (gain <= 0) return current;
    return Math.min(max, current + gain);
  };
  state.pools.hp = regen(state.pools.hp, state.maxPools.hp, state.bonus.生命回复);
  state.pools.armor = regen(state.pools.armor, state.maxPools.armor, state.bonus.装甲回复);
  state.pools.shield = regen(state.pools.shield, state.maxPools.shield, state.bonus.护盾回复);
}

/** 剩余生命比例：三池合计 / 三池上限（时间上限时的胜负口径） */
function lifeRatio(state: FighterState): number {
  const max = state.maxPools.shield + state.maxPools.armor + state.maxPools.hp;
  if (max <= 0) return 0;
  return (state.pools.shield + state.pools.armor + state.pools.hp) / max;
}

function sideView(fighter: ArenaFighter, state: FighterState) {
  return {
    userId: fighter.userId,
    name: fighter.name,
    level: Number(fighter.snapshot.level) || 0,
    power: Number(fighter.snapshot.power) || 0,
    bonus: mirrorBonusDigest(fighter.snapshot),
    pools: {
      shield: round2(state.pools.shield),
      armor: round2(state.pools.armor),
      hp: round2(state.pools.hp),
    },
    taken: {
      actions: state.takenActions,
      hits: state.hits,
      damage: round2(state.takenDamage),
    },
  };
}

/** 索敌计算机/超级计算机：命中/闪避倍率过高时保留倍率而非封顶（与 PVE 同判据，按装备名识别） */
function hasSniperComputer(equipment: any): boolean {
  if (!Array.isArray(equipment)) return false;
  return equipment.some((item: any) => {
    const name = typeof item === 'string' ? item : String(item?.name ?? '');
    return name === '索敌计算机' || name === '超级计算机';
  });
}

function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}
