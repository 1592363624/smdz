/**
 * 使魔竞技场 · 镜像天梯服务（提交镜像 / 天梯榜 / 挑战结算 / 战报）。
 *
 * ## 设计要点（详见 docs/arena-ladder-design.md）
 * 1. **打的是冻结镜像**：挑战用的防守方数据来自 `ArenaMirror.snapshot`，结算全程不写任何
 *    真实玩家行；输了只掉名次，装备/经验/活力/称号/载具一律不动（唯一例外是入场消耗的活力/门票）。
 * 2. **排名互换制，没有积分**：只能挑战排在自己前面的人，打赢就顶替他的名次、他退到自己的旧位置，
 *    打输/平局双方席位都不动。没有可搬运的数值，所以小号喂分在这套规则下不成立。
 *    席位号存在 `rating` 列里（越大越靠前），名次 = 席位降序后的序号。
 * 3. **天梯榜 = 镜像榜**：只有挂了镜像的人可被挑战、才参与赛季名次。
 *    这条约束顺带解决了「旧镜像一直占位」——想留在榜上就得回来刷新配置。
 * 4. **状态分表**：席位/段位/每日次数都在 `ArenaProfile`，不占用 Player 的 markers 命名空间。
 * 5. **依赖方向**：只读 PlayerService/PlayerMutateService + 战斗引擎 token + 权益账本，
 *    不注入任何指令域服务，赛季结算与采集口都能安全复用。
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { PlayerMutateService } from '../player-mutate.service';
import { PlayerService } from '../player.service';
import { BonusService } from '../bonus.service';
import { EntitlementService } from '../entitlement.service';
import { CombatSystemService } from '../combat-system.service';
import { COMBAT_SYSTEM_SERVICE } from '../service-tokens';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { formatDisplayNumber } from '../../../common/utils/game-text.util';
import {
  ARENA_CONFIG_KEYS,
  DEFAULT_ARENA_AVOID_REPEAT_HOURS,
  DEFAULT_ARENA_BATTLE_MAX_ACTIONS,
  DEFAULT_ARENA_BATTLE_TIME_LIMIT_SEC,
  DEFAULT_ARENA_CHALLENGE_RANK_WINDOW,
  DEFAULT_ARENA_DAILY_LIMIT,
  DEFAULT_ARENA_ENTRY_MODE,
  DEFAULT_ARENA_ENTRY_TICKET_COST,
  DEFAULT_ARENA_ENTRY_TICKET_ITEM,
  DEFAULT_ARENA_ENTRY_VITALITY,
  DEFAULT_ARENA_LADDER_PAGE_SIZE,
  DEFAULT_ARENA_MIN_LEVEL,
  DEFAULT_ARENA_RANK_INIT_BY_POWER,
  DEFAULT_ARENA_RANK_INIT_LIMIT,
  DEFAULT_ARENA_SEASON_CARRY,
  DEFAULT_ARENA_SEASON_LENGTH_DAYS,
  DEFAULT_ARENA_SUBMIT_MODE,
  DEFAULT_ARENA_SUBMIT_VITALITY,
  DEFAULT_ARENA_TIERS_JSON,
  arenaNonNegative,
  arenaPositive,
  arenaTodayString,
  deriveArenaTier,
  normalizeArenaEntryMode,
  normalizeArenaSeasonCarry,
  normalizeArenaTiers,
  seatForNewcomer,
  bestRankAfter,
  ArenaEntryMode,
  ArenaMatchMode,
  ArenaTierDef,
} from '../../../config/arena.config';
import {
  MirrorSnapshot,
  isUsableMirror,
  mirrorSummaryLines,
  snapshotFromPlayerData,
} from './mirror-snapshot.util';
import { ArenaBattleService, ArenaFighter, ArenaFightResult } from './arena-battle.service';

/** 一次入场（挑战或提交）的消耗描述 */
export interface ArenaCost {
  mode: ArenaEntryMode;
  vitality: number;
  ticketItem: string;
  ticketCost: number;
}

/** 挑战消耗实际扣掉的东西（写进战报表做审计） */
export interface ArenaCostPaid {
  mode: ArenaEntryMode;
  amount: number;
  item?: string;
}

export interface ArenaRuntimeConfig {
  enabled: boolean;
  tiers: ArenaTierDef[];
  /** 可挑战的名次差上限（0=不限，只能打排在自己前面的） */
  challengeRankWindow: number;
  dailyChallengeLimit: number;
  entry: ArenaCost;
  submit: ArenaCost;
  avoidRepeatHours: number;
  battleTimeLimitSec: number;
  battleMaxActions: number;
  minLevelToEnter: number;
  /** 开榜按当前战力排初始名次（仅在全服还没有任何天梯档案时生效） */
  rankInitByPower: boolean;
  /** 初始名次一次处理的人数上限 */
  rankInitLimit: number;
  pageSize: number;
  seasonLengthDays: number;
  seasonStartAt: string;
  /** 赛季结算是否世界公告 */
  announceSeason: boolean;
}

/** 天梯榜一行 */
export interface LadderRow {
  rank: number;
  mirrorId: number;
  ownerId: number;
  ownerName: string;
  level: number;
  power: number;
  /** 席位号（ArenaMirror.rating 列；越大越靠前）。只对后台/审计有意义，玩家看的是 rank */
  seat: number;
  tier: string;
  mirrorVersion: number;
  capturedAt: number;
}

@Injectable()
export class ArenaService {
  private readonly logger = new Logger(ArenaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly mutate: PlayerMutateService,
    private readonly bonusService: BonusService,
    private readonly battle: ArenaBattleService,
    private readonly entitlement: EntitlementService,
    @Optional() @Inject(COMBAT_SYSTEM_SERVICE)
    private readonly combat?: CombatSystemService,
    /** 退还门票用背包唯一出口（按名合并、类型以静态数据为准），不手搓 {name,quantity} 行 */
    @Optional() private readonly playerService?: PlayerService,
  ) {}

  /**
   * 键级串行锁登记表：
   * - challengerLocks：按挑战者 userId，守住「每日次数 + 消耗 + 档案指针」不被同一玩家并发双花；
   * - participantLocks：按参战双方 userId，守住双方席位（档案 + 镜像冗余列）的「读 → 算 → 写回」与名次门判定。
   * 生产为 PM2 单实例 fork 模式（见 ecosystem.config.js），与 MapService.withMapLock 同一口径。
   */
  private readonly challengerLocks = new Map<number, Promise<void>>();
  private readonly participantLocks = new Map<number, Promise<void>>();
  /** 初始排名重入门位：巡检与管理员「初排」同时到位时只跑一遍全服扫描 */
  private seeding = false;

  /**
   * 同一把登记表上按多个键加锁：**按键升序**逐层嵌套。
   * A 打 B 与 B 打 A 同时发生时，两条链路都按 (min,max) 顺序取锁 → 只可能排队，不可能互相等待。
   */
  private withTwoKeyLocks<T>(registry: Map<number, Promise<void>>, keys: number[], fn: () => Promise<T>): Promise<T> {
    const unique = [...new Set(keys.map(Number).filter((k) => Number.isFinite(k)))].sort((a, b) => a - b);
    if (unique.length === 0) return fn();
    if (unique.length === 1) return this.withKeyLock(registry, unique[0], fn);
    return this.withKeyLock(registry, unique[0], () => this.withKeyLock(registry, unique[1], fn));
  }

  /**
   * 同一键的异步操作串行执行（队尾接力，前一个无论成败都继续）。
   *
   * 竞技场档案与镜像榜分都是「读 → 算 → 写回」：多人同时打同一镜像会丢掉一次守方记分，
   * 同一玩家连点两次挑战会双花每日次数。**不可重入**——锁内不得再取同一把锁的同一个键。
   */
  private async withKeyLock<T>(registry: Map<number, Promise<void>>, key: number, fn: () => Promise<T>): Promise<T> {
    const prev = registry.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    registry.set(key, tail);
    // 空闲后清理，避免长期运行下 Map 无限增长
    tail.finally(() => {
      if (registry.get(key) === tail) registry.delete(key);
    });
    return run;
  }

  // ==========================================================
  // 配置
  // ==========================================================

  /** 读取并规范化竞技场运行期配置（非法值逐项回落默认，改配置立即生效） */
  async getConfig(): Promise<ArenaRuntimeConfig> {
    const raw = await this.systemConfig.getMany([
      ARENA_CONFIG_KEYS.enabled,
      ARENA_CONFIG_KEYS.tierConfig,
      ARENA_CONFIG_KEYS.challengeRankWindow,
      ARENA_CONFIG_KEYS.dailyChallengeLimit,
      ARENA_CONFIG_KEYS.entryMode,
      ARENA_CONFIG_KEYS.entryVitalityCost,
      ARENA_CONFIG_KEYS.entryTicketItem,
      ARENA_CONFIG_KEYS.entryTicketCost,
      ARENA_CONFIG_KEYS.submitMode,
      ARENA_CONFIG_KEYS.submitVitalityCost,
      ARENA_CONFIG_KEYS.submitTicketItem,
      ARENA_CONFIG_KEYS.submitTicketCost,
      ARENA_CONFIG_KEYS.avoidRepeatHours,
      ARENA_CONFIG_KEYS.battleTimeLimitSec,
      ARENA_CONFIG_KEYS.battleMaxActions,
      ARENA_CONFIG_KEYS.minLevelToEnter,
      ARENA_CONFIG_KEYS.rankInitByPower,
      ARENA_CONFIG_KEYS.rankInitLimit,
      ARENA_CONFIG_KEYS.ladderPageSize,
      ARENA_CONFIG_KEYS.seasonLengthDays,
      ARENA_CONFIG_KEYS.seasonStartAt,
      ARENA_CONFIG_KEYS.announceSeason,
    ]).catch(() => ({}) as Record<string, any>);
    const g = (key: string, fallback: any) => (raw && raw[key] !== undefined && raw[key] !== null ? raw[key] : fallback);
    const entryMode = normalizeArenaEntryMode(g(ARENA_CONFIG_KEYS.entryMode, DEFAULT_ARENA_ENTRY_MODE));
    const submitMode = normalizeArenaEntryMode(g(ARENA_CONFIG_KEYS.submitMode, DEFAULT_ARENA_SUBMIT_MODE));
    return {
      enabled: g(ARENA_CONFIG_KEYS.enabled, true) !== false,
      tiers: normalizeArenaTiers(g(ARENA_CONFIG_KEYS.tierConfig, DEFAULT_ARENA_TIERS_JSON)),
      challengeRankWindow: arenaNonNegative(
        g(ARENA_CONFIG_KEYS.challengeRankWindow, DEFAULT_ARENA_CHALLENGE_RANK_WINDOW),
        DEFAULT_ARENA_CHALLENGE_RANK_WINDOW,
      ),
      dailyChallengeLimit: arenaNonNegative(g(ARENA_CONFIG_KEYS.dailyChallengeLimit, DEFAULT_ARENA_DAILY_LIMIT), DEFAULT_ARENA_DAILY_LIMIT),
      entry: {
        mode: entryMode,
        vitality: arenaNonNegative(g(ARENA_CONFIG_KEYS.entryVitalityCost, DEFAULT_ARENA_ENTRY_VITALITY), DEFAULT_ARENA_ENTRY_VITALITY),
        ticketItem: String(g(ARENA_CONFIG_KEYS.entryTicketItem, DEFAULT_ARENA_ENTRY_TICKET_ITEM) || DEFAULT_ARENA_ENTRY_TICKET_ITEM).trim(),
        ticketCost: arenaNonNegative(g(ARENA_CONFIG_KEYS.entryTicketCost, DEFAULT_ARENA_ENTRY_TICKET_COST), DEFAULT_ARENA_ENTRY_TICKET_COST),
      },
      submit: {
        mode: submitMode,
        vitality: arenaNonNegative(g(ARENA_CONFIG_KEYS.submitVitalityCost, DEFAULT_ARENA_SUBMIT_VITALITY), DEFAULT_ARENA_SUBMIT_VITALITY),
        ticketItem: String(g(ARENA_CONFIG_KEYS.submitTicketItem, DEFAULT_ARENA_ENTRY_TICKET_ITEM) || DEFAULT_ARENA_ENTRY_TICKET_ITEM).trim(),
        ticketCost: arenaNonNegative(g(ARENA_CONFIG_KEYS.submitTicketCost, 0), 0),
      },
      avoidRepeatHours: arenaNonNegative(g(ARENA_CONFIG_KEYS.avoidRepeatHours, DEFAULT_ARENA_AVOID_REPEAT_HOURS), DEFAULT_ARENA_AVOID_REPEAT_HOURS),
      battleTimeLimitSec: arenaPositive(g(ARENA_CONFIG_KEYS.battleTimeLimitSec, DEFAULT_ARENA_BATTLE_TIME_LIMIT_SEC), DEFAULT_ARENA_BATTLE_TIME_LIMIT_SEC),
      battleMaxActions: arenaPositive(g(ARENA_CONFIG_KEYS.battleMaxActions, DEFAULT_ARENA_BATTLE_MAX_ACTIONS), DEFAULT_ARENA_BATTLE_MAX_ACTIONS),
      minLevelToEnter: arenaNonNegative(g(ARENA_CONFIG_KEYS.minLevelToEnter, DEFAULT_ARENA_MIN_LEVEL), DEFAULT_ARENA_MIN_LEVEL),
      rankInitByPower: g(ARENA_CONFIG_KEYS.rankInitByPower, DEFAULT_ARENA_RANK_INIT_BY_POWER) !== false,
      rankInitLimit: arenaPositive(g(ARENA_CONFIG_KEYS.rankInitLimit, DEFAULT_ARENA_RANK_INIT_LIMIT), DEFAULT_ARENA_RANK_INIT_LIMIT),
      pageSize: arenaPositive(g(ARENA_CONFIG_KEYS.ladderPageSize, DEFAULT_ARENA_LADDER_PAGE_SIZE), DEFAULT_ARENA_LADDER_PAGE_SIZE),
      seasonLengthDays: arenaPositive(g(ARENA_CONFIG_KEYS.seasonLengthDays, DEFAULT_ARENA_SEASON_LENGTH_DAYS), DEFAULT_ARENA_SEASON_LENGTH_DAYS),
      seasonStartAt: String(g(ARENA_CONFIG_KEYS.seasonStartAt, '') || '').trim(),
      announceSeason: g(ARENA_CONFIG_KEYS.announceSeason, true) !== false,
    };
  }

  /** 挑战范围文案：窗口=1 时说清是「一顺位往上打」，别让玩家以为榜上随便挑 */
  private windowHint(cfg: ArenaRuntimeConfig): string {
    const w = Number(cfg.challengeRankWindow) || 0;
    if (w === 1) return '只能挑战紧挨在你前面的那一个镜像（一顺位往上打，想碰更高的必须先赢这里）';
    if (w > 1) return `只能挑战排在你前面的镜像（一次最多往上打 ${w} 名）`;
    return '只能挑战排在你前面的镜像（不限名次差）';
  }

  /**
   * 段位名（按**榜单名次**，供面板 / 结算 / 后台复用）。
   * 席位数值本身不对外展示，段位与奖励都挂在名次上，所以这里必须是名次而不是席位号。
   */
  tierName(cfg: ArenaRuntimeConfig, rank: number): string {
    return deriveArenaTier(cfg.tiers, rank).name;
  }

  // ==========================================================
  // 赛季与档案
  // ==========================================================

  /** 当前 ACTIVE 赛季；一个都没有时按配置开第一个赛季（首次上线自动可用） */
  async ensureActiveSeason(): Promise<{ season: any; expired: boolean; notStarted: boolean }> {
    const now = new Date();
    const season = await this.prisma.arenaSeason.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { no: 'asc' },
    });
    if (season) {
      return {
        season,
        expired: new Date(season.endAt).getTime() <= now.getTime(),
        notStarted: new Date(season.startAt).getTime() > now.getTime(),
      };
    }
    const cfg = await this.getConfig();
    // 序号取「已有最大 no + 1」而不是硬编码 1：赛季号是 @unique，
    // 全部赛季都已结算（换季 cron 与开新季之间有窗口）时硬编码会撞已存在的 S1，
    // 结果是 ensureActiveSeason 永久抛错——所有竞技场指令一起瘫掉。
    const latest = await this.prisma.arenaSeason.findFirst({ orderBy: { no: 'desc' }, select: { no: true } });
    const no = Math.max(1, Number(latest?.no ?? 0) + 1);
    const startAt = cfg.seasonStartAt && !Number.isNaN(Date.parse(cfg.seasonStartAt))
      ? new Date(cfg.seasonStartAt)
      : now;
    const endAt = new Date(startAt.getTime() + cfg.seasonLengthDays * 24 * 3600 * 1000);
    const created = await this.prisma.arenaSeason.create({
      data: { no, name: `S${no}`, startAt, endAt, status: 'ACTIVE' },
    }).catch(() => null);
    if (!created) throw new Error('竞技场赛季初始化失败');
    return {
      season: created,
      expired: created.endAt.getTime() <= now.getTime(),
      notStarted: created.startAt.getTime() > now.getTime(),
    };
  }

  /** 取（必要时建）玩家本赛季档案；新入榜者从基准分开局 */
  async getOrCreateProfile(userId: number, seasonId: number, cfg: ArenaRuntimeConfig) {
    const uid = Number(userId);
    const existing = await this.prisma.arenaProfile.findUnique({ where: { userId: uid } });
    if (existing) {
      // 赛季切换：换季时按 carry 口径处理席位与战绩，镜像需重提
      if (Number(existing.seasonId) !== Number(seasonId)) {
        return this.rollProfile(existing, seasonId, cfg);
      }
      return existing;
    }
    // 新入榜者没有「初始分」可发——排名互换制下只能插到最后一名之后，
    // 想往前挪就必须真的打赢排在你前面的人。
    const seat = await this.pickNewcomerSeat(Number(seasonId));
    return this.prisma.arenaProfile.create({
      data: {
        userId: uid,
        seasonId: Number(seasonId),
        rating: seat,
        bestRank: 0,
        tier: '',
      },
    }).catch(async (err: any) => {
      // 并发首开（同时打开面板、或结算与指令同时建号）会撞 userId 唯一键：
      // 抢输的一方读回对手刚建好的那一行即可，不该让玩家看到一次「服务器错误」。
      const raced = await this.prisma.arenaProfile.findUnique({ where: { userId: uid } });
      if (raced) return raced;
      throw err;
    });
  }

  /**
   * 取一个新席位号（越大越靠前）。
   * 并发首提交会算出同一个号：席位并列时名次只能靠镜像 id 兜底，
   * 与其留一个隐性并列，不如往下让一位（让 20 次仍撞说明有人在批量建号，接受并列）。
   */
  private async pickNewcomerSeat(seasonId: number): Promise<number> {
    const lowest = await this.prisma.arenaProfile.findFirst({
      where: { seasonId: Number(seasonId) },
      orderBy: { rating: 'asc' },
      select: { rating: true },
    });
    let seat = seatForNewcomer(lowest?.rating);
    for (let i = 0; i < 20; i++) {
      const taken = await this.prisma.arenaProfile.findFirst({
        where: { seasonId: Number(seasonId), rating: seat },
        select: { id: true },
      });
      if (!taken) break;
      seat -= 1;
    }
    return seat;
  }

  /**
   * 开榜初始排名：系统刚上线、全服还没有任何天梯档案时，按玩家**当时的战斗力**排出初始席位。
   *
   * 少了这一步，第一批玩家的名次就只由「谁先发送提交镜像」决定 —— 榜首等于手快的人。
   * 只建档案、**不建镜像**：没参与过竞技场的人不该平白变成别人能打的靶子，
   * 席位在他第一次「提交镜像」时兑现到榜上（镜像席位取自档案）。
   * 冷启动一次性开销：Player 没有存战力列，只能逐人现算属性块，所以带人数上限，
   * 并且整段只在天梯档案表为空时执行；读档一律走只读口，绝不写玩家行。
   */
  /**
   * @param quiet 巡检口用：无事可做时返回空串（不告警、不刷日志），只有真的排了名次才回文案
   */
  async seedInitialSeats(quiet = false): Promise<string> {
    if (this.seeding) return quiet ? '' : '初始排名正在排，稍后再看。';
    const cfg = await this.getConfig();
    if (!cfg.enabled || !cfg.rankInitByPower) return quiet ? '' : (cfg.enabled ? '已关闭「开榜按战力排初始名次」，入榜者一律排队尾（提交镜像即上榜）。' : '竞技场暂未开放，不做初始排名。');
    const existing = await this.prisma.arenaProfile.count().catch(() => -1);
    if (existing !== 0) {
      return quiet ? '' : `已有 ${existing} 份天梯档案，跳过初始排名（只有全服零档案时才排这一次）。`;
    }
    this.seeding = true;
    try {
      const { season } = await this.ensureActiveSeason();
      const candidates = await this.prisma.player.findMany({
        // 战力没有存列（Player.markers['战斗力'] 只是历史最高缓存），只能逐人现算；
        // 人数超上限时先按等级粗筛候选，再在候选内按现算战力精排——粗筛口径与「排行榜」一致。
        where: { level: { gte: cfg.minLevelToEnter }, NOT: { type: '' } },
        select: { userId: true },
        orderBy: [{ level: 'desc' }, { userId: 'asc' }],
        take: cfg.rankInitLimit,
      });
      const ranked: Array<{ userId: number; power: number }> = [];
      for (const row of candidates) {
        const uid = Number(row.userId);
        if (!uid) continue;
        // 只读口现算战力；未选使魔 / 引擎未就绪 / 快照不可用的人跳过（他们走提交镜像排队尾）
        const snapshot = await this.mutate.read(uid, (ctx) => {
          if (!ctx?.player?.type || !this.combat) return null;
          return snapshotFromPlayerData(
            uid, ctx,
            { buildAttackerBonus: (p, d, m) => this.combat!.buildAttackerBonus(p, d, m), calcCombatPower: (b) => this.bonusService.calcCombatPower(b) },
          );
        }).catch(() => null);
        if (!snapshot || !isUsableMirror(snapshot)) continue;
        const power = Number((snapshot as MirrorSnapshot).power) || 0;
        if (power <= 0) continue;
        ranked.push({ userId: uid, power });
      }
      // 战力降序；同战力按 userId 升序定序，保证同一份数据重复执行得到同一份名次
      ranked.sort((a, b) => b.power - a.power || a.userId - b.userId);
      for (let i = 0; i < ranked.length; i++) {
        await this.prisma.arenaProfile.create({
          data: {
            userId: ranked[i].userId, seasonId: Number(season.id),
            rating: ranked.length - i, bestRank: 0, tier: '',
          },
        }).catch(() => undefined);
      }
      const skipped = candidates.length - ranked.length;
      const lines = [
        `🏟️ 竞技场初始排名完成：按当前战力排入 ${ranked.length} 人（赛季 S${season.no}）`,
        ranked.length > 0 ? `榜首战力 ${ranked[0].power}，榜尾战力 ${ranked[ranked.length - 1].power}` : '没有可排的玩家',
        skipped > 0 ? `跳过 ${skipped} 人（未选使魔或数据不可用，提交镜像时排队尾）` : '',
        '初始席位只是起点：想往前挪只能真的打赢前面的人，镜像要「提交镜像」后才会上榜。',
      ].filter(Boolean);
      this.logger.log(lines[0]);
      return lines.join('\n');
    } finally {
      this.seeding = false;
    }
  }

  /**
   * 换季处理：席位 keep=按上季名次继承 / reset=重头排队。
   * 每日次数、防连打记录、镜像指针一律作废（新赛季必须重提镜像才有榜位）。
   */
  private async rollProfile(existing: any, seasonId: number, cfg: ArenaRuntimeConfig) {
    const rawCarry = await this.systemConfig.get<string>(ARENA_CONFIG_KEYS.seasonCarry, DEFAULT_ARENA_SEASON_CARRY);
    // 后台把值改错时必须落到一个明确口径上（默认 keep），而不是"字面量不等于 reset 就……"
    const carry = normalizeArenaSeasonCarry(rawCarry);
    // keep=按上季末名次继承席位（结算时已重排成 N..1）；reset=席位清零，
    // 新季按「谁先提交镜像谁在前」重新排队（同席位由镜像 id 定序）。
    const seat = carry === 'reset' ? 0 : (Number(existing.rating) || 0);
    return this.prisma.arenaProfile.update({
      where: { id: existing.id },
      data: {
        seasonId: Number(seasonId),
        rating: seat,
        // 新季节最好名次重新计
        bestRank: 0,
        // 段位跟名次走，换季后名次未定 → 先清空，面板按实时名次显示
        tier: '',
        wins: 0, losses: 0, draws: 0, streak: 0,
        // 换季清空每日次数与防连打记录（写空结构而非 null：Json 列置 null 需 Prisma.DbNull）
        daily: { lastDate: '', used: 0 } as any, avoid: {} as any,
        mirrorId: null, submittedAt: null,
      },
    });
  }

  // ==========================================================
  // 镜像提交
  // ==========================================================

  /**
   * 提交 / 刷新角斗镜像（指令「提交镜像」）。
   * 消耗走 `arena.submitMode`，与挑战次数互不计费。
   */
  async submitMirror(userId: number): Promise<string> {
    const cfg = await this.getConfig();
    if (!cfg.enabled) return '竞技场暂未开放，请联系管理员。';
    const gate = await this.entryGate(userId, cfg, 'submit');
    if (gate.text) return gate.text;

    // 同一玩家的竞技场写操作共用一把「挑战者锁」串行（提交与挑战同锁）：
    // 否则「边提交边挑战」会各自读到对方的旧档案，镜像指针与版本号互相覆盖。
    return this.withKeyLock(this.challengerLocks, Number(userId), () => this.submitMirrorLocked(userId, cfg));
  }

  /** 挑战者锁内：现算快照 → 计费 → 落镜像与档案 */
  private async submitMirrorLocked(userId: number, cfg: ArenaRuntimeConfig): Promise<string> {
    const { season, expired, notStarted } = await this.ensureActiveSeason();
    // 赛季空档同样不许上榜：结算 cron 每小时跑一次，到期到结算之间有窗口，
    // 若放任提交，玩家会挂进一个即将被判定的赛季榜，名次与奖励都会算错。
    if (notStarted) return `🏟️ 竞技场将于 ${formatTime(season.startAt)} 开放。`;
    if (expired) return '🏟️ 本赛季已结束，赛季奖励结算中，暂时不能提交镜像（稍后再来）。';
    const profile = await this.getOrCreateProfile(userId, season.id, cfg);

    // 现算快照（read 上下文：脱钩副本上算属性块，活态零污染）
    const built = await this.mutate.read(userId, (ctx) => {
      if (!ctx?.player?.type) return { error: '还未选择使魔，无法生成角斗镜像。' };
      if (!this.combat) return { error: '竞技场战斗引擎未就绪，暂时无法提交镜像。' };
      const snapshot = snapshotFromPlayerData(
        userId, ctx, { buildAttackerBonus: (p, d, m) => this.combat!.buildAttackerBonus(p, d, m), calcCombatPower: (b) => this.bonusService.calcCombatPower(b) },
      );
      return { snapshot, level: Number(ctx.player.level) || 0, name: String(ctx.player.name || ctx.player.baseName || '') };
    });
    if ((built as any).error) return (built as any).error;
    const snapshot = (built as any).snapshot as MirrorSnapshot;

    // 计费（唯一一处玩家写入：活力或门票道具）
    const paid = await this.payCost(userId, cfg.submit);
    if (!paid.ok) return paid.text;

    // 一玩家一赛季一镜像：直接按唯一键 (ownerId, seasonId) 定位，
    // 不依赖 profile.mirrorId（档案被后台调整或换季清空时那个指针可能失真，
    // 若据此走 create 会撞唯一键，玩家看到的是「提交失败」）。
    const existingMirror = await this.prisma.arenaMirror.findUnique({
      where: { ownerId_seasonId: { ownerId: Number(userId), seasonId: Number(season.id) } },
    }).catch(() => null);
    const version = Number(existingMirror?.version || 0) + 1;
    const seat = Number(profile.rating) || 0;
    const mirrorData = {
      ownerId: userId,
      ownerName: snapshot.name,
      seasonId: Number(season.id),
      snapshot: snapshot as any,
      power: snapshot.power,
      level: snapshot.level,
      // 镜像上的 rating 列存的是**席位号**（越大越靠前），榜单与名次都由它排序；
      // 段位跟名次走，所以要先落榜再算名次。
      rating: seat,
      tier: '',
      version,
    };
    const mirror = existingMirror
      ? await this.prisma.arenaMirror.update({ where: { id: Number(existingMirror.id) }, data: mirrorData })
      : await this.prisma.arenaMirror.create({ data: mirrorData });
    const myRank = await this.ladderRankOf(Number(mirror.id), Number(season.id));
    const myTier = this.tierName(cfg, myRank);
    await this.prisma.arenaMirror.update({ where: { id: Number(mirror.id) }, data: { tier: myTier } });
    // 提交即参战资格：只有挂了镜像的玩家才出现在榜上、才可被挑战
    // 最好名次也要在这里记：空榜第一个提交的人一上来就是第 1 名，他不打一场也达到过
    await this.prisma.arenaProfile.update({
      where: { id: profile.id },
      data: {
        mirrorId: mirror.id, mirrorPower: snapshot.power, mirrorLevel: snapshot.level,
        submittedAt: new Date(), tier: myTier, bestRank: bestRankAfter(profile.bestRank, myRank),
      },
    });

    const lines = [
      `🛡️ 角斗镜像已${existingMirror ? '刷新' : '提交'}（第 ${version} 版）`,
      ...mirrorSummaryLines(snapshot, myRank > 0 ? `当前第 ${myRank} 名 · ${myTier}` : '尚未上榜'),
      `消耗：${paid.text}`,
      '镜像是冻结快照：换装后需重新提交才会生效，他人挑战的始终是这一版。',
      this.windowHint(cfg),
      '打赢就顶替他的名次、他退到你原来的位置；打输与平局都不动席位，也不掉任何真实资产。',
    ];
    return lines.join('\n');
  }

  // ==========================================================
  // 天梯榜
  // ==========================================================

  /** 榜单行（按席位号降序 = 名次；同席位按镜像 id 升序，保证翻页稳定） */
  async ladderRows(seasonId: number, page: number, pageSize: number): Promise<{ rows: LadderRow[]; total: number; page: number; pages: number }> {
    const take = Math.max(1, Math.floor(pageSize));
    const pageIndex = Math.max(1, Math.floor(page));
    const skip = (pageIndex - 1) * take;
    const [mirrors, total] = await Promise.all([
      this.prisma.arenaMirror.findMany({
        where: { seasonId: Number(seasonId) },
        orderBy: [{ rating: 'desc' }, { id: 'asc' }],
        skip,
        take,
        select: {
          id: true, ownerId: true, ownerName: true, level: true, power: true,
          rating: true, tier: true, version: true, updatedAt: true,
        },
      }),
      this.prisma.arenaMirror.count({ where: { seasonId: Number(seasonId) } }),
    ]);
    const rows = mirrors.map((m: any, idx: number) => ({
      rank: skip + idx + 1,
      mirrorId: m.id,
      ownerId: m.ownerId,
      ownerName: m.ownerName,
      level: m.level,
      power: m.power,
      seat: m.rating,
      tier: m.tier,
      mirrorVersion: m.version,
      capturedAt: new Date(m.updatedAt).getTime(),
    }));
    return { rows, total, page: pageIndex, pages: Math.max(1, Math.ceil(total / take)) };
  }

  /** 某镜像在主榜单上的名次（1-based；席位号越大越靠前；不在榜返回 0） */
  async ladderRankOf(mirrorId: number, seasonId: number): Promise<number> {
    const mirror = await this.prisma.arenaMirror.findUnique({ where: { id: Number(mirrorId) } });
    if (!mirror) return 0;
    const ahead = await this.prisma.arenaMirror.count({
      where: {
        seasonId: Number(seasonId),
        OR: [
          { rating: { gt: mirror.rating } },
          { rating: mirror.rating, id: { lt: mirror.id } },
        ],
      },
    });
    return ahead + 1;
  }

  /** 指令「竞技场 [页码|序号]」：不带参数看面板+榜单，带序号看该镜像详情 */
  async viewPanel(userId: number, arg?: string): Promise<string> {
    const cfg = await this.getConfig();
    if (!cfg.enabled) return '竞技场暂未开放，请联系管理员。';
    const { season, expired, notStarted } = await this.ensureActiveSeason();
    if (notStarted) return `🏟️ 竞技场将于 ${formatTime(season.startAt)} 开放。`;
    if (expired) return '🏟️ 本赛季已结束，赛季奖励结算中（稍后再看，或由管理员执行「竞技场管理 结算」）。';
    const argText = String(arg ?? '').trim();
    // 「竞技场 5」= 查看榜单第 5 名的镜像详情；「竞技场 2」翻页由 -p 前缀区分
    // 参数口径：纯数字 = 看该名次镜像详情；「页N / pN」= 榜单翻页；空 = 第 1 页
    if (/^\d+$/.test(argText)) {
      return this.viewMirrorByRank(userId, season.id, Number(argText), cfg);
    }
    const page = parsePage(argText);
    const profile = await this.getOrCreateProfile(userId, season.id, cfg);
    const { rows, total, pages } = await this.ladderRows(season.id, page, cfg.pageSize);
    const mine = profile.mirrorId ? await this.ladderRankOf(Number(profile.mirrorId), season.id) : 0;
    const daily = this.readDaily(profile, cfg);
    const costText = this.costLabel(cfg.entry);
    const matches = Number(profile.wins) + Number(profile.losses) + Number(profile.draws);
    const streakText = profile.streak > 0 ? `连胜 ${profile.streak}` : profile.streak < 0 ? `连败 ${-profile.streak}` : '无连胜';

    const head = [
      '🏟️ 使魔竞技场 · 镜像天梯',
      `赛季 S${season.no}（至 ${formatTime(season.endAt)}）`,
      // 排名互换制：玩家只看名次与段位，席位号是内部排序键，不对外展示
      `我的名次：${mine ? `第 ${mine} 名 · ${this.tierName(cfg, mine)}` : '未上榜（先「提交镜像」）'}`,
      `战绩 ${matches} 场：${profile.wins} 胜 ${profile.losses} 负 ${profile.draws} 平（${streakText}）`,
      `今日挑战：剩 ${daily.left}/${cfg.dailyChallengeLimit} 次（${costText}）`,
      profile.mirrorId
        ? `我的镜像：${profile.mirrorLevel} 级 · 战力 ${formatDisplayNumber(profile.mirrorPower)}（${formatAgo(Number(profile.submittedAt))}提交）`
        : '我的镜像：尚未提交（先「提交镜像」才能上榜与被挑战）',
      '─'.repeat(16),
      `名次  段位        镜像主人`,
    ];
    const body = rows.map((r) => `${String(r.rank).padStart(4, ' ')}  ${String(r.tier).padEnd(8, ' ')}  ${r.ownerName}（Lv.${r.level} 战力${formatDisplayNumber(r.power)}，第${r.mirrorVersion}版）`);
    if (body.length === 0) body.push('（本服还没有人提交镜像，来当第一个擂主）');
    const tail = [
      '─'.repeat(16),
      this.windowHint(cfg),
      `打赢就顶替他的名次、他退到你原来的位置；打输与平局都不动席位，也不掉任何真实资产`,
      '打排名不高于你的镜像 = 免费练手：照样出完整战报，但不扣消耗、不占次数、不计胜败、名次一点不动。',
      `「竞技场 页2」翻页（共 ${total} 个镜像，${pages} 页）｜「竞技场 序号」看镜像详情`,
      '「提交镜像」冻结当前配置｜「挑战镜像 序号/玩家名」开战｜「竞技场战绩」「战报 <编号>」复盘',
    ];
    return [...head, ...body, ...tail].join('\n');
  }

  /** 「竞技场 <序号>」看某个镜像的详情（挑战前的情报） */
  async viewMirrorByRank(userId: number, seasonId: number, rank: number, cfg: ArenaRuntimeConfig): Promise<string> {
    const { rows } = await this.ladderRows(seasonId, Math.floor((rank - 1) / cfg.pageSize) + 1, cfg.pageSize);
    const row = rows.find((r) => r.rank === rank);
    if (!row) return `天梯榜上没有第 ${rank} 名（本服共 ${rows.length ? '若干' : '0'} 个镜像）。`;
    const mirror = await this.prisma.arenaMirror.findUnique({ where: { id: row.mirrorId } });
    if (!mirror || !isUsableMirror(mirror.snapshot)) return '该镜像数据已失效，请挑战其他对手。';
    const frame = await this.entitlement.equippedFrame(row.ownerId);
    return [
      `🔍 天梯第 ${rank} 名 · ${row.ownerName}`,
      ...mirrorSummaryLines(mirror.snapshot as MirrorSnapshot, row.tier || this.tierName(cfg, rank)),
      frame ? `佩戴头像框：${frame.name}` : '',
      `「挑战镜像 ${rank}」或「挑战镜像 ${row.ownerName}」发起对决`,
    ].filter(Boolean).join('\n');
  }

  // ==========================================================
  // 挑战
  // ==========================================================

  /**
   * 挑战天梯榜上某个镜像：`target` 为榜单序号或玩家名。
   *
   * 流程：门槛校验 → 挑战者锁内判次数与防连打 → 镜像锁内计费 + 无头结算 + 记分写战报。
   * 计费与结算分离：战斗引擎异常时退款，不让玩家白扣活力。
   */
  async challengeMirror(userId: number, target: string): Promise<string> {
    const cfg = await this.getConfig();
    if (!cfg.enabled) return '竞技场暂未开放，请联系管理员。';
    const targetText = String(target ?? '').trim();
    if (!targetText) return '挑战谁？「挑战镜像 榜单序号」或「挑战镜像 玩家名」。';

    const gate = await this.entryGate(userId, cfg, 'challenge');
    if (gate.text) return gate.text;
    const { season, expired, notStarted } = await this.ensureActiveSeason();
    if (notStarted) return `🏟️ 竞技场将于 ${formatTime(season.startAt)} 开放。`;
    if (expired) return '🏟️ 本赛季已结束，赛季奖励结算中，暂时不能挑战。';
    if (!this.combat) return '竞技场战斗引擎未就绪，暂时无法开战。';
    // 同一玩家连发两条挑战（连点 / 脚本并发）会在两次读档之间双花每日次数，
    // 判次与扣次必须落在同一把「挑战者锁」内完成；记分另按双方玩家键加锁（见下）。
    return this.withKeyLock(this.challengerLocks, Number(userId), () =>
      this.challengeWithinChallengerLock(userId, targetText, season, cfg, gate));
  }

  /** 挑战者锁内：定位目标镜像、判每日次数与防连打，再进镜像锁结算 */
  private async challengeWithinChallengerLock(
    userId: number,
    targetText: string,
    season: any,
    cfg: ArenaRuntimeConfig,
    gate: { text: string; name: string; level: number },
  ): Promise<string> {
    const profile = await this.getOrCreateProfile(userId, season.id, cfg);
    // 必须在榜：只有挂了镜像的人能挑战，保证榜上每个名次都是可被打下来的实靶子
    if (!profile.mirrorId) return '你还没有角斗镜像，先「提交镜像」（只有自己也在榜上，才能挑战别人）。';

    const mirror = await this.resolveTargetMirror(userId, targetText, season.id, cfg);
    if (typeof mirror === 'string') return mirror;
    if (!isUsableMirror(mirror.snapshot)) return '该镜像数据已失效，请挑战其他对手。';
    if (Number(mirror.ownerId) === Number(userId)) return '不能挑战自己的镜像。';

    // 记分要同时写双方档案与双方镜像行，而守方此刻不在线、只能由结算方代写。
    // 故按「参战双方玩家」加锁，键升序取（A↔B 互打时两条链路取锁顺序一致 → 不成环）。
    // 模式判定（正式局 / 练手局）也放在锁内：排队期间别人可能把守方顶下去，锁外算出的名次会过期，
    // 拿着过期名次去判「他在我后面所以免费」就会把本该换位的正式局漏记成练手局。
    return this.withTwoKeyLocks(this.participantLocks, [Number(userId), Number(mirror.ownerId)], async () => {
      const fresh = await this.prisma.arenaMirror.findUnique({ where: { id: Number(mirror.id) } });
      if (!fresh || !isUsableMirror(fresh.snapshot)) {
        return '该镜像已失效（对手重提或赛季已结算），本次未开战，消耗未扣。';
      }
      const myMirror = await this.prisma.arenaMirror.findUnique({ where: { id: Number(profile.mirrorId) } });
      if (!myMirror || !isUsableMirror(myMirror.snapshot)) return '你的镜像已失效，请重新「提交镜像」。';
      const gateCheck = await this.rankGateCheck(myMirror, fresh, season.id, cfg);
      if (typeof gateCheck === 'string') return gateCheck;

      // 每日次数只约束正式局（先判它，玩家看到「次数已用完」比看到冷却更好办）；
      // 练手局不占次数，因此只吃下面这条冷却。
      const daily = this.readDaily(profile, cfg);
      if (gateCheck.mode === 'ladder' && daily.left <= 0) {
        return `今日挑战次数已用完（${cfg.dailyChallengeLimit} 次），明天 0 点重置。（打排名不高于你的镜像是免费练手，不占次数）`;
      }
      // 防连打：正式局与练手局都吃这条冷却（练手免费，冷却是唯一能挡住拿同一个人刷情报的东西）
      const avoided = this.avoidHit(profile, fresh.id, cfg);
      if (avoided) {
        return `${fresh.ownerName} 的镜像刚被你打过，${avoided} 后才能再挑战（换个对手或明天再来）。`;
      }
      return this.settleChallenge({
        userId, gate, profile, mirror: fresh, season, cfg, daily,
        myMirror: myMirror as any, ...gateCheck,
      });
    });
  }

  /**
   * 挑战模式判定（双方参战锁内）：
   * - `ladder`（正式局）：守方排在自己前面且在跳级窗口内 → 计费计次、打赢换席位、记胜败；
   * - `practice`（练手局）：守方排名不高于自己 → 免费、不占每日次数、席位与名次完全不动、不计胜败；
   * - 跳级（前面但超出窗口）：直接拒。
   * 这套规则同时把「喂分」变成不成立的命题：没有可搬运的数值，小号无法把任何东西倒给主号；
   * 想把某人顶到前面，只能自己真的打赢前面的人，且被顶的人掉到你的旧位置。
   * @returns 放行时返回双方名次快照与模式（写战报要用），拒绝时返回文案
   */
  private async rankGateCheck(
    myMirror: any,
    targetMirror: any,
    seasonId: number,
    cfg: ArenaRuntimeConfig,
  ): Promise<string | { myRank: number; targetRank: number; mode: ArenaMatchMode }> {
    const myRank = await this.ladderRankOf(Number(myMirror.id), Number(seasonId));
    const targetRank = await this.ladderRankOf(Number(targetMirror.id), Number(seasonId));
    // 他不在你前面 → 这一场动不了任何人的名次，就是练手
    if (targetRank >= myRank) return { myRank, targetRank, mode: 'practice' };
    if (cfg.challengeRankWindow > 0 && myRank - targetRank > cfg.challengeRankWindow) {
      const w = cfg.challengeRankWindow;
      return w === 1
        ? `只能一顺位往上打：${targetMirror.ownerName} 在第 ${targetRank} 名，你在第 ${myRank} 名，先打赢排在你前面那一个。（打排名不高于你的镜像是免费练手，不计成绩）`
        : `跳不过这么远：一次最多能挑战高出 ${w} 名的对手（${targetMirror.ownerName} 在第 ${targetRank} 名，你在第 ${myRank} 名）。`;
    }
    return { myRank, targetRank, mode: 'ladder' };
  }

  /** 计费 → 无头结算 → 席位互换（练手局跳过这步） → 写战报（已在挑战者锁 + 双方参战锁内） */
  private async settleChallenge(input: {
    userId: number;
    gate: { text: string; name: string; level: number };
    profile: any;
    mirror: any;
    season: any;
    cfg: ArenaRuntimeConfig;
    daily: { used: number; left: number };
    myMirror: any;
    myRank: number;
    targetRank: number;
    /** ladder=正式局（计费计次换席位）；practice=练手局（全不动，只出战报） */
    mode: ArenaMatchMode;
  }): Promise<string> {
    const { userId, gate, profile, mirror, season, cfg, daily, myMirror, targetRank, mode } = input;
    const practice = mode === 'practice';
    // 攻方快照：现读当前配置，不落库（只有真正打出去才计费）
    const attackSnapshot = await this.mutate.read(userId, (ctx) => snapshotFromPlayerData(
      userId, ctx,
      { buildAttackerBonus: (p, d, m) => this.combat!.buildAttackerBonus(p, d, m), calcCombatPower: (b) => this.bonusService.calcCombatPower(b) },
    ));

    // 计费 + 记次数与防连打（次数在 ArenaProfile，消耗在玩家行，各自单点写）
    // 练手局不扣任何东西，但仍写冷却：免费的东西只能靠冷却防止被拿来刷同一个人。
    let paid: { ok: boolean; text: string; paid?: ArenaCostPaid } = { ok: true, text: '无（练手局不消耗、不占次数）' };
    if (!practice) {
      const result = await this.payCost(userId, cfg.entry);
      if (!result.ok) return result.text;
      paid = result;
    }
    await this.recordAttempt(profile, mirror.id, cfg, !practice);

    const rank = Number(targetRank) || await this.ladderRankOf(mirror.id, season.id);
    const defSnapshot = mirror.snapshot as MirrorSnapshot;
    const attackerFrame = await this.entitlement.equippedFrame(userId);
    const defenderFrame = await this.entitlement.equippedFrame(Number(mirror.ownerId));
    let fight: ArenaFightResult;
    try {
      fight = this.battle.fight(
        {
          side: 'attacker', userId, name: String(gate.name || attackSnapshot.name || '攻方'),
          snapshot: attackSnapshot as MirrorSnapshot, frameName: attackerFrame?.name,
        },
        {
          side: 'defender', userId: Number(mirror.ownerId), name: String(mirror.ownerName || defSnapshot.name),
          snapshot: defSnapshot, frameName: defenderFrame?.name,
        },
        { timeLimitSec: cfg.battleTimeLimitSec, maxActions: cfg.battleMaxActions },
      );
    } catch (err: any) {
      // 练手局本来就没扣东西，没有可退的账（退成「已退还」反而是假账）
      if (!practice) await this.refundCost(userId, cfg.entry);
      this.logger.warn(`竞技场结算失败（玩家 ${userId} → 镜像 ${mirror.id}）：${err?.message ?? err}${practice ? '（练手局，未产生消耗）' : '，已退还入场消耗'}`);
      return practice
        ? '⚔️ 竞技场结算异常，请稍后再试。'
        : '⚔️ 竞技场结算异常，本次消耗已退还，请稍后再试。';
    }

    // 正式局才动席位；练手局拿到的是「双方原地不动」的同构结果，让文案与战报都只读一个来源
    const seatChange = practice
      ? await this.practiceChange(profile, mirror, myMirror, cfg, season.id, Number(myMirror.id))
      : await this.applySeatSwap(
        userId, profile, mirror, fight.winner, cfg, season.id, Number(myMirror.id),
      );

    const match = await this.prisma.arenaMatch.create({
      data: {
        seasonId: Number(season.id),
        attackerId: userId,
        attackerName: String(gate.name || attackSnapshot.name || ''),
        defenderId: Number(mirror.ownerId),
        defenderName: String(mirror.ownerName || ''),
        mirrorId: Number(mirror.id),
        mirrorVersion: Number(mirror.version) || 1,
        winner: fight.winner,
        rounds: fight.actions,
        durationSec: fight.durationSec,
        // 这两对列存的是**席位号**（互换前后）；名次只写进 report，因为名次会随别人换位而变
        attackerRatingBefore: seatChange.attackerBefore,
        attackerRatingAfter: seatChange.attackerAfter,
        defenderRatingBefore: seatChange.defenderBefore,
        defenderRatingAfter: seatChange.defenderAfter,
        entryCost: practice
          ? { mode: 'practice', amount: 0, item: '' } as any
          : { mode: paid.paid?.mode ?? cfg.entry.mode, amount: paid.paid?.amount ?? 0, item: paid.paid?.item ?? '' } as any,
        report: {
          // mode 决定这一场算不算成绩：练手局的席位前后相同、也不计进胜败场次
          mode,
          lines: fight.lines, actionLog: fight.actionLog, sides: fight.sides,
          seats: {
            attacker: { before: seatChange.attackerBefore, after: seatChange.attackerAfter },
            defender: { before: seatChange.defenderBefore, after: seatChange.defenderAfter },
            swapped: seatChange.swapped,
          },
          ranks: {
            attacker: { before: input.myRank, after: seatChange.attackerRank },
            defender: { before: targetRank, after: seatChange.defenderRank },
          },
        } as any,
      },
    });

    return this.renderChallengeReply(fight, {
      matchId: match.id,
      seatChange,
      mode,
      myRank: Number(input.myRank),
      targetRank,
      costText: paid.text,
      // 练手局不吃次数：剩余次数按原样回显，别让玩家以为刚刚扣了一次
      dailyLeft: practice ? daily.left : Math.max(0, cfg.dailyChallengeLimit - (daily.used + 1)),
    });
  }

  /** 按名次或玩家名定位目标镜像；返回镜像行或拒绝文案 */
  private async resolveTargetMirror(
    userId: number,
    targetText: string,
    seasonId: number,
    cfg: ArenaRuntimeConfig,
  ): Promise<any | string> {
    if (/^\d+$/.test(targetText)) {
      const rank = Number(targetText);
      if (rank <= 0) return '榜单序号要从 1 开始。';
      const { rows, total } = await this.ladderRows(seasonId, Math.floor((rank - 1) / cfg.pageSize) + 1, cfg.pageSize);
      const row = rows.find((r) => r.rank === rank);
      if (!row) return `天梯榜上没有第 ${rank} 名（本赛季共 ${total} 个镜像）。`;
      const mirror = await this.prisma.arenaMirror.findUnique({ where: { id: row.mirrorId } });
      return mirror ?? '该镜像数据已失效，请挑战其他对手。';
    }
    const mirror = await this.prisma.arenaMirror.findFirst({
      where: { seasonId: Number(seasonId), ownerName: targetText },
      orderBy: [{ rating: 'desc' }, { id: 'asc' }],
    });
    if (!mirror) return `天梯榜上没有「${targetText}」的镜像（「竞技场」看榜单，或用序号挑战）。`;
    return mirror;
  }

  /**
   * 练手局的「赛后处理」：什么都不改，只把双方当前的席位/名次/段位读出来喂给同一份战报渲染口径。
   *
   * 与 `applySeatSwap` 返回同构结果，是为了让战报、`ArenaMatch` 的四列席位快照、
   * 前端名次展示只有一条代码路径——练手局的四列前后相等，`swapped=false`，一眼就能在审计里分辨。
   * 这里不写任何档案/镜像行：不动席位、不计胜败、不吃每日次数。
   */
  private async practiceChange(
    attackerProfile: any,
    mirror: any,
    myMirror: any,
    cfg: ArenaRuntimeConfig,
    seasonId: number,
    attackerMirrorId: number,
  ) {
    const n = (value: any) => Number(value) || 0;
    const attackerSeat = n(attackerProfile.rating);
    const defenderSeat = n(mirror.rating);
    const attackerRank = await this.ladderRankOf(Number(attackerMirrorId), Number(seasonId));
    const defenderRank = await this.ladderRankOf(Number(mirror.id), Number(seasonId));
    return {
      swapped: false,
      attackerBefore: attackerSeat, attackerAfter: attackerSeat,
      defenderBefore: defenderSeat, defenderAfter: defenderSeat,
      attackerRank, defenderRank,
      attackerTier: this.tierName(cfg, attackerRank), defenderTier: this.tierName(cfg, defenderRank),
      practice: true,
    };
  }

  /**
   * 赛后席位处理（排名互换制）：
   * - 攻方胜 → 双方席位互换：攻方顶到守方位置，守方退到攻方原来的位置；
   * - 攻方负 / 平局 → 席位一律不动，只记战绩。
   *
   * 这两条就是「喂不了分」的原因：没有任何可搬运的数值，小号既不能把分倒给大号，
   * 也不能靠故意输来降低对方名次——被打的人席位不动，动手的人白耗一次次数与活力。
   * 守方此刻不在线也要记账，这正是异步 PVP 的意义。
   */
  private async applySeatSwap(
    attackerId: number,
    attackerProfile: any,
    mirror: any,
    winner: 'attacker' | 'defender' | 'draw',
    cfg: ArenaRuntimeConfig,
    seasonId: number,
    attackerMirrorId: number,
  ) {
    // 计数一律按「读不到就当 0」处理：新档案刚建、或行由别的入口建起时字段可能缺省，
    // 直接 Number(undefined) 会得到 NaN 并污染整行战绩。
    const n = (value: any) => Number(value) || 0;
    const attackerBefore = n(attackerProfile.rating);
    const defenderProfile0 = await this.getOrCreateProfile(Number(mirror.ownerId), seasonId, cfg);
    const defenderBefore = n(defenderProfile0.rating);
    const swapped = winner === 'attacker';
    const attackerAfter = swapped ? defenderBefore : attackerBefore;
    const defenderAfter = swapped ? attackerBefore : defenderBefore;
    const attackerWin = swapped;
    const defenderWin = winner === 'defender';

    const attackerUpdate: any = {
      rating: attackerAfter,
      wins: n(attackerProfile.wins) + (attackerWin ? 1 : 0),
      losses: n(attackerProfile.losses) + (defenderWin ? 1 : 0),
      draws: n(attackerProfile.draws) + (winner === 'draw' ? 1 : 0),
      streak: attackerWin
        ? Math.max(1, n(attackerProfile.streak) + 1)
        : winner === 'draw'
          ? n(attackerProfile.streak)
          : Math.min(-1, n(attackerProfile.streak) - 1),
    };
    const defenderUpdate: any = {
      rating: defenderAfter,
      wins: n(defenderProfile0.wins) + (defenderWin ? 1 : 0),
      losses: n(defenderProfile0.losses) + (attackerWin ? 1 : 0),
      draws: n(defenderProfile0.draws) + (winner === 'draw' ? 1 : 0),
      streak: defenderWin
        ? Math.max(1, n(defenderProfile0.streak) + 1)
        : winner === 'draw'
          ? n(defenderProfile0.streak)
          : Math.min(-1, n(defenderProfile0.streak) - 1),
    };
    await this.prisma.arenaProfile.update({ where: { id: attackerProfile.id }, data: attackerUpdate });
    await this.prisma.arenaProfile.update({ where: { id: defenderProfile0.id }, data: defenderUpdate });

    // 席位号要同步到双方镜像行：榜单排序、名次、赛季名次奖励读的都是这份冗余值。
    // 按 (ownerId, seasonId) 定位而不是档案上的 mirrorId 指针——指针可能因换季/后台调整失真。
    await this.prisma.arenaMirror.updateMany({
      where: { ownerId: Number(attackerId), seasonId: Number(seasonId) },
      data: { rating: attackerAfter },
    });
    await this.prisma.arenaMirror.updateMany({
      where: { ownerId: Number(mirror.ownerId), seasonId: Number(seasonId) },
      data: { rating: defenderAfter },
    });
    // 段位挂在名次上，且**别人被顶下去会改变你的名次**，所以双方都要按新名次重算段位
    const attackerRank = await this.ladderRankOf(Number(attackerMirrorId), Number(seasonId));
    const defenderRank = await this.ladderRankOf(Number(mirror.id), Number(seasonId));
    const attackerTier = this.tierName(cfg, attackerRank);
    const defenderTier = this.tierName(cfg, defenderRank);
    // 「本赛季最好名次」只进不退（0=未记录过，直接取本次名次）
    await this.prisma.arenaProfile.update({
      where: { id: attackerProfile.id },
      data: { tier: attackerTier, bestRank: bestRankAfter(attackerProfile.bestRank, attackerRank) },
    });
    await this.prisma.arenaProfile.update({
      where: { id: defenderProfile0.id },
      data: { tier: defenderTier, bestRank: bestRankAfter(defenderProfile0.bestRank, defenderRank) },
    });
    await this.prisma.arenaMirror.updateMany({
      where: { ownerId: Number(attackerId), seasonId: Number(seasonId) },
      data: { tier: attackerTier },
    });
    await this.prisma.arenaMirror.updateMany({
      where: { ownerId: Number(mirror.ownerId), seasonId: Number(seasonId) },
      data: { tier: defenderTier },
    });
    return {
      swapped,
      attackerBefore, attackerAfter, defenderBefore, defenderAfter,
      attackerRank, attackerTier, defenderRank, defenderTier,
      practice: false,
    };
  }

  /** 挑战回包：结果 + 名次变化 + 战报正文（QQ 长度受限，只给尾部若干行） */
  private renderChallengeReply(
    fight: ArenaFightResult,
    meta: {
      matchId: number;
      costText: string;
      dailyLeft: number;
      myRank: number;
      targetRank: number;
      mode: ArenaMatchMode;
      seatChange: { swapped: boolean; attackerRank: number; defenderRank: number; attackerTier: string; defenderTier: string };
    },
  ): string {
    const won = fight.winner === 'attacker';
    const draw = fight.winner === 'draw';
    const practice = meta.mode === 'practice';
    const title = practice
      ? (draw ? '🤝 练手 · 平局' : won ? '🗡️ 练手 · 你赢了' : '🗡️ 练手 · 你输了')
      : (draw ? '🤝 平局' : won ? '🏆 挑战成功' : '💥 挑战失败');
    const seatLine = practice
      // 练手局：双方席位与名次一个字都不动，胜败也不计进战绩
      ? `练手局：不计成绩、不动席位（你还是第 ${meta.myRank} 名，对手还是第 ${meta.targetRank} 名）`
      : won
        ? `名次：第 ${meta.myRank} 名 → 第 ${meta.seatChange.attackerRank} 名（顶替了对手，段位 ${meta.seatChange.attackerTier}）\n`
          + `对手：第 ${meta.targetRank} 名 → 第 ${meta.seatChange.defenderRank} 名`
        : `名次不变（还是第 ${meta.myRank} 名）：只有打赢排在你前面的人才会换位，平局与失败都不动席位`;
    const head = [
      `${title}（${draw ? '势均力敌' : won ? '击溃对手镜像' : '被对手镜像击退'}）`,
      seatLine,
      `本次消耗：${meta.costText}｜今日剩余挑战 ${meta.dailyLeft} 次`,
      '打的是镜像：装备/经验/活力等真实资产不受影响。',
      '─'.repeat(16),
    ];
    // 战报截尾：开局若干行 + 结果行，完整正文走「战报 <编号>」
    const body = truncateReport(fight.lines, 14);
    return [...head, ...body, '─'.repeat(16), `「战报 ${meta.matchId}」看完整战报｜「竞技场战绩」看历史记录`].join('\n');
  }

  // ==========================================================
  // 战绩与战报
  // ==========================================================

  /** 「竞技场战绩」：我攻出去的和别人打我的，按时间倒序 */
  async viewHistory(userId: number, arg?: string): Promise<string> {
    const cfg = await this.getConfig();
    const page = parsePage(String(arg ?? ''));
    const take = Math.max(1, Math.min(20, cfg.pageSize));
    const skip = (page - 1) * take;
    const where = { OR: [{ attackerId: Number(userId) }, { defenderId: Number(userId) }] };
    const [rows, total] = await Promise.all([
      this.prisma.arenaMatch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true, attackerId: true, attackerName: true, defenderId: true, defenderName: true,
          winner: true, rounds: true, durationSec: true, attackerRatingAfter: true,
          defenderRatingAfter: true, createdAt: true, mirrorVersion: true, entryCost: true,
        },
      }),
      this.prisma.arenaMatch.count({ where }),
    ]);
    if (rows.length === 0) return '还没有竞技场战绩，先「提交镜像」再去「挑战」一个对手。';
    const lines = [
      `📜 竞技场战绩（共 ${total} 场，第 ${page}/${Math.max(1, Math.ceil(total / take))} 页）`,
      '编号  结果      对手（镜像版本）      用时',
    ];
    for (const row of rows) {
      const attacked = Number(row.attackerId) === Number(userId);
      // 练手局单独成行标出来：它不计进胜败，混在战绩里会被误读成「白捡的胜场」
      if (isPracticeMatch(row)) {
        const pp = attacked ? row.defenderName : row.attackerName;
        lines.push(`${String(row.id).padStart(4, ' ')}  ${'练手'.padEnd(8, ' ')}  ${pp}（第${row.mirrorVersion}版）`
          + `  ${row.durationSec}s/${row.rounds}手  不计成绩`);
        continue;
      }
      const won = row.winner !== 'draw' && (row.winner === 'attacker') === attacked;
      const outcome = row.winner === 'draw' ? '平局' : won ? (attacked ? '胜·已换位' : '胜·守住席位') : (attacked ? '负·名次不变' : '负·被顶替');
      const opponent = attacked ? row.defenderName : row.attackerName;
      lines.push(`${String(row.id).padStart(4, ' ')}  ${outcome.padEnd(8, ' ')}  ${opponent}（第${row.mirrorVersion}版）`
        + `  ${row.durationSec}s/${row.rounds}手`);
    }
    lines.push('「战报 <编号>」看完整战报');
    return lines.join('\n');
  }

  /** 「战报 <编号>」：完整回合正文（只有参战双方能看） */
  async viewReport(userId: number, matchId: number): Promise<string> {
    const match = await this.prisma.arenaMatch.findUnique({ where: { id: Number(matchId) } });
    if (!match) return '找不到这份战报。';
    if (Number(match.attackerId) !== Number(userId) && Number(match.defenderId) !== Number(userId)) {
      return '这份战报不属于你。';
    }
    const report = asJsonValue<{ lines?: string[] }>(match.report, {});
    const lines = Array.isArray(report?.lines) ? report.lines : [];
    if (lines.length === 0) return '这份战报没有正文记录。';
    return [`📄 战报 #${match.id}（${formatTime(match.createdAt)}）`, ...lines].join('\n');
  }

  /** 「头像框」：查看已获得与佩戴中；「头像框 佩戴 <键>」切换，「佩戴 无」卸下 */
  async viewFrames(userId: number, arg?: string): Promise<string> {
    const text = String(arg ?? '').trim();
    if (text === '佩戴' || text.startsWith('佩戴 ') || text.startsWith('佩戴')) {
      const raw = text === '佩戴' ? '' : text.slice(2).trim();
      // 卸下写成「无 / 卸下 / none」都认：面板提示用的是「佩戴 无」，网页按钮也发同一条，
      // 若把「无」当成框键去查拥有，玩家看到的是「尚未获得头像框「无」」这种莫名其妙的回包。
      const key = /^(无|卸下|不佩戴|none|off|unset)$/i.test(raw) ? '' : raw;
      const result = await this.entitlement.equipFrame(userId, key);
      return result.text;
    }
    const { owned } = await this.entitlement.listFrames(userId);
    if (owned.length === 0) {
      return '🖼️ 你还没有头像框。竞技场赛季结算会按名次发放限定框（「竞技场」看赛季安排）。';
    }
    const lines = ['🖼️ 我的头像框（「头像框 佩戴 <键名>」切换，「头像框 佩戴 无」卸下）'];
    for (const frame of owned) {
      lines.push(`${frame.equipped ? '★' : '・'} ${frame.name}（${frame.key}）${frame.description ? ` — ${frame.description}` : ''}`);
    }
    return lines.join('\n');
  }

  // ==========================================================
  // 门槛 / 计费 / 每日次数
  // ==========================================================

  /**
   * 参战门槛：等级 + 玩家名（顺便给上层复用名字，省一次读档）。
   * @returns text 非空即拒绝原因
   */
  private async entryGate(
    userId: number,
    cfg: ArenaRuntimeConfig,
    purpose: 'challenge' | 'submit',
  ): Promise<{ text: string; name: string; level: number }> {
    const snap = await this.mutate.read(userId, (ctx) => ({
      name: String(ctx?.player?.name || ctx?.player?.baseName || ''),
      level: Number(ctx?.player?.level) || 0,
    }));
    if (!snap.name && snap.level <= 0) {
      return { text: '还没创建角色，无法进入竞技场。', name: '', level: 0 };
    }
    if (snap.level < cfg.minLevelToEnter) {
      return { text: `竞技场在 Lv.${cfg.minLevelToEnter} 开放（你现在的等级：Lv.${snap.level}）。`, name: snap.name, level: snap.level };
    }
    void purpose;
    return { text: '', name: snap.name, level: snap.level };
  }

  /** 读每日挑战次数（懒重置，与签到/抽奖同一按天口径） */
  readDaily(profile: any, cfg: ArenaRuntimeConfig, now = new Date()): { used: number; left: number } {
    const daily = asJsonValue<{ lastDate?: string; used?: number }>(profile?.daily, {});
    const used = String(daily?.lastDate || '') === arenaTodayString(now) ? Number(daily?.used || 0) : 0;
    return { used, left: Math.max(0, cfg.dailyChallengeLimit - used) };
  }

  /** 记一次挑战尝试：次数 +1，并把该镜像写进防连打表 */
  private async recordAttempt(profile: any, mirrorId: number, cfg: ArenaRuntimeConfig, countDaily = true): Promise<void> {
    const today = arenaTodayString();
    const daily = asJsonValue<{ lastDate?: string; used?: number }>(profile.daily, {});
    const used = String(daily?.lastDate || '') === today ? Number(daily?.used || 0) : 0;
    const avoid = asJsonValue<Record<string, number>>(profile.avoid, {});
    avoid[String(mirrorId)] = Date.now();
    // 防连打表随镜像数无限增长：只保留窗口内的记录
    const windowMs = Math.max(0, cfg.avoidRepeatHours) * 3600 * 1000;
    for (const key of Object.keys(avoid)) {
      if (windowMs > 0 && Date.now() - Number(avoid[key]) > windowMs) delete avoid[key];
    }
    await this.prisma.arenaProfile.update({
      where: { id: profile.id },
      // 练手局只记冷却，不占每日次数（countDaily=false）
      data: countDaily
        ? { daily: { lastDate: today, used: used + 1 } as any, avoid: avoid as any }
        : { avoid: avoid as any },
    });
  }

  /** 该镜像是否在防连打冷却里；命中返回可读剩余时长 */
  private avoidHit(profile: any, mirrorId: number, cfg: ArenaRuntimeConfig): string {
    const hours = Number(cfg.avoidRepeatHours) || 0;
    if (hours <= 0) return '';
    const avoid = asJsonValue<Record<string, number>>(profile?.avoid, {});
    const last = Number(avoid?.[String(mirrorId)] || 0);
    if (!last) return '';
    const leftMs = last + hours * 3600 * 1000 - Date.now();
    if (leftMs <= 0) return '';
    return formatDuration(leftMs);
  }

  /**
   * 支付入场消耗（唯一一处会写玩家行的地方）。
   * 活力直接扣 `Player.vitality`；门票按背包规范键 quantity 扣减。
   */
  private async payCost(userId: number, cost: ArenaCost): Promise<{ ok: boolean; text: string; paid?: ArenaCostPaid }> {
    if (cost.mode === 'free') return { ok: true, text: '免费' };
    const result = await this.mutate.mutate(userId, (ctx) => {
      const player = ctx?.player;
      if (!player) return { ok: false, text: '玩家数据不存在。' };
      if (cost.mode === 'vitality') {
        const have = Number(player.vitality) || 0;
        if (cost.vitality > 0 && have < cost.vitality) {
          return { ok: false, text: `活力不足：挑战需要 ${cost.vitality} 点，当前 ${Math.floor(have)} 点。` };
        }
        player.vitality = have - cost.vitality;
        return { ok: true, text: `活力 -${cost.vitality}`, paid: { mode: 'vitality', amount: cost.vitality } as ArenaCostPaid };
      }
      const backpack = Array.isArray(ctx.backpack) ? ctx.backpack : [];
      const row = backpack.find((it: any) => String(it?.name ?? '') === cost.ticketItem);
      const have = Number(row?.quantity ?? 0) || 0;
      if (cost.ticketCost > 0 && have < cost.ticketCost) {
        return { ok: false, text: `需要「${cost.ticketItem}」x${cost.ticketCost}，当前只有 ${have} 张。` };
      }
      if (cost.ticketCost > 0 && row) {
        const next = have - cost.ticketCost;
        if (next <= 0) backpack.splice(backpack.indexOf(row), 1);
        else row.quantity = next;
        player.backpack = backpack;
      }
      return {
        ok: true,
        text: `${cost.ticketItem} -${cost.ticketCost}`,
        paid: { mode: 'ticket', amount: cost.ticketCost, item: cost.ticketItem } as ArenaCostPaid,
      };
    });
    return result;
  }

  /** 战斗引擎异常时退还入场消耗（次数不退：防用异常刷次数） */
  private async refundCost(userId: number, cost: ArenaCost): Promise<void> {
    // free 模式与「0 消耗」的配置都没有可退之物：后者若继续走退款，会给背包凭空插一条
    // 数量为 0 的门票行（配置把 ticketCost 填 0 时就会踩到）。
    if (cost.mode === 'free') return;
    if (cost.mode === 'vitality' ? cost.vitality <= 0 : cost.ticketCost <= 0) return;
    if (cost.mode === 'ticket') {
      // 门票走背包唯一出口：按名合并 + 类型以静态数据为准，
      // 手搓 {name, quantity} 塞回背包会造出一条没有 type 的野行（图鉴/仓库都会看到它）。
      if (this.playerService) {
        await this.playerService.addToBackpack(userId, cost.ticketItem, cost.ticketCost)
          .catch((err: any) => this.logger.warn(`竞技场门票退还失败（玩家 ${userId}）：${err?.message ?? err}`));
        return;
      }
      this.logger.warn(`竞技场门票退还缺少 PlayerService（玩家 ${userId}），改走背包内就地回补`);
    }
    await this.mutate.mutate(userId, (ctx) => {
      const player = ctx?.player;
      if (!player) return;
      if (cost.mode === 'vitality') {
        player.vitality = (Number(player.vitality) || 0) + cost.vitality;
        return;
      }
      const backpack = Array.isArray(ctx.backpack) ? ctx.backpack : [];
      const row = backpack.find((it: any) => String(it?.name ?? '') === cost.ticketItem);
      if (row) row.quantity = (Number(row.quantity) || 0) + cost.ticketCost;
      else backpack.push({ name: cost.ticketItem, quantity: cost.ticketCost });
      player.backpack = backpack;
    }).catch((err: any) => this.logger.warn(`竞技场消耗退还失败（玩家 ${userId}）：${err?.message ?? err}`));
  }

  /** 入场消耗文案（面板展示） */
  private costLabel(cost: ArenaCost): string {
    if (cost.mode === 'free') return '免费';
    if (cost.mode === 'ticket') return `${cost.ticketItem} x${cost.ticketCost}`;
    return `活力 ${cost.vitality}`;
  }

  // ==========================================================
  // 供赛季结算与后台复用的只读口
  // ==========================================================

  /** 本赛季榜单（名次即赛季奖励档位，全量取回用于结算） */
  async rankedMirrors(seasonId: number, limit = 500): Promise<any[]> {
    return this.prisma.arenaMirror.findMany({
      where: { seasonId: Number(seasonId) },
      orderBy: [{ rating: 'desc' }, { id: 'asc' }],
      take: Math.max(1, Math.floor(limit)),
    });
  }

  /** 竞技场概况（Web 面板首屏）：赛季 + 全服规模 + 本人天梯状态 */
  async getOverview(userId: number) {
    const { season, expired, notStarted } = await this.ensureActiveSeason();
    const cfg = await this.getConfig();
    const [mirrorCount, profileCount, matchCount] = await Promise.all([
      this.prisma.arenaMirror.count({ where: { seasonId: Number(season.id) } }),
      this.prisma.arenaProfile.count({ where: { seasonId: Number(season.id) } }),
      this.prisma.arenaMatch.count({ where: { seasonId: Number(season.id) } }),
    ]);
    const profile = Number(userId) > 0 ? await this.getOrCreateProfile(userId, season.id, cfg) : null;
    const daily = this.readDaily(profile, cfg);
    const myRank = profile?.mirrorId ? await this.ladderRankOf(Number(profile.mirrorId), Number(season.id)) : 0;
    const me = profile ? {
      userId: Number(profile.userId),
      /** 当前名次（0 = 未上榜）；排名互换制下玩家看的是这个，不是席位号 */
      rank: myRank,
      seat: Number(profile.rating) || 0,
      /** 本赛季达到过的最好名次（0=还没上过榜） */
      bestRank: Number(profile.bestRank) || 0,
      tier: myRank ? this.tierName(cfg, myRank) : String(profile.tier || ''),
      wins: Number(profile.wins) || 0,
      losses: Number(profile.losses) || 0,
      draws: Number(profile.draws) || 0,
      streak: Number(profile.streak) || 0,
      dailyLeft: daily.left,
      dailyLimit: cfg.dailyChallengeLimit,
      challengeRankWindow: cfg.challengeRankWindow,
      mirror: profile.mirrorId ? {
        id: Number(profile.mirrorId),
        power: Number(profile.mirrorPower) || 0,
        level: Number(profile.mirrorLevel) || 0,
        submittedAt: profile.submittedAt ? new Date(profile.submittedAt).getTime() : null,
        rank: myRank,
      } : null,
    } : null;
    return {
      season: {
        id: season.id, no: season.no, name: season.name,
        startAt: season.startAt, endAt: season.endAt, status: season.status,
        expired, notStarted,
      },
      mirrorCount, profileCount, matchCount,
      me,
      config: {
        enabled: cfg.enabled,
        dailyChallengeLimit: cfg.dailyChallengeLimit,
        entry: cfg.entry,
        submit: cfg.submit,
        minLevelToEnter: cfg.minLevelToEnter,
        avoidRepeatHours: cfg.avoidRepeatHours,
        /** 可挑战名次差上限（默认 1=一顺位往上打；0=只要求排名更高、不限差多少） */
        challengeRankWindow: cfg.challengeRankWindow,
        tiers: cfg.tiers,
      },
    };
  }

  /** 我的战绩（Web 分页；与指令「竞技场战绩」同源数据、不同呈现） */
  async matchesForUser(userId: number, page = 1) {
    const cfg = await this.getConfig();
    const take = Math.max(1, Math.min(20, cfg.pageSize));
    const skip = (Math.max(1, Math.floor(page)) - 1) * take;
    const where = { OR: [{ attackerId: Number(userId) }, { defenderId: Number(userId) }] };
    const [rows, total] = await Promise.all([
      this.prisma.arenaMatch.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.arenaMatch.count({ where }),
    ]);
    return {
      total,
      page: Math.max(1, Math.floor(page)),
      pageSize: take,
      rows: rows.map((row: any) => {
        const attacked = Number(row.attackerId) === Number(userId);
        // 席位号互换前后（越大越靠前）：换位的定义就是「自己的席位动了」，
        // 攻方打赢会升、守方被顶会降，所以判据是前后不等，不能只盯「升」。
        const seatBefore = Number(attacked ? row.attackerRatingBefore : row.defenderRatingBefore);
        const seatAfter = Number(attacked ? row.attackerRatingAfter : row.defenderRatingAfter);
        return {
          id: row.id,
          attacked,
          winner: row.winner,
          opponent: attacked ? row.defenderName : row.attackerName,
          opponentId: attacked ? Number(row.defenderId) : Number(row.attackerId),
          mirrorVersion: row.mirrorVersion,
          rounds: row.rounds,
          durationSec: row.durationSec,
          seatBefore,
          seatAfter,
          swapped: seatAfter !== seatBefore,
          // 练手局：不计胜败、不动席位，前端必须单独标出来，否则看着像白捡的一场胜场
          practice: isPracticeMatch(row),
          createdAt: row.createdAt,
        };
      }),
    };
  }

  /** 单份完整战报（仅参战双方可读） */
  async reportForUser(matchId: number, userId: number) {
    const match = await this.prisma.arenaMatch.findUnique({ where: { id: Number(matchId) } });
    if (!match) return null;
    if (Number(match.attackerId) !== Number(userId) && Number(match.defenderId) !== Number(userId)) return null;
    const report = asJsonValue<any>(match.report, {});
    return {
      id: match.id,
      winner: match.winner,
      rounds: match.rounds,
      durationSec: match.durationSec,
      createdAt: match.createdAt,
      attacker: { id: match.attackerId, name: match.attackerName, seatAfter: match.attackerRatingAfter },
      defender: { id: match.defenderId, name: match.defenderName, seatAfter: match.defenderRatingAfter },
      // seats/ranks 是结算瞬间的席位号与名次快照（名次会随后续换位而变，这里存的是当时的结果）
      seats: report?.seats ?? null,
      ranks: report?.ranks ?? null,
      // 练手局标记：席位前后相同、不计胜败，前端据此决定要不要显示名次变化
      practice: isPracticeMatch(match),
      lines: Array.isArray(report?.lines) ? report.lines : [],
      actionLog: Array.isArray(report?.actionLog) ? report.actionLog : [],
      sides: report?.sides ?? null,
    };
  }

  /** 我的装扮与特权（Web 面板：头像框列表 + 佩戴中 + 生效特权） */
  async entitlementsForUser(userId: number) {
    const [frames, privileges] = await Promise.all([
      this.entitlement.listFrames(Number(userId)),
      this.entitlement.listActivePrivileges(Number(userId)),
    ]);
    return { frames, privileges };
  }
}

/** 页码解析：「页2 / p2」=第 2 页；其它（含空）=1（纯数字已被名次详情分支截走） */
/** 这一场是不是练手局：计费口写死的 mode 标记（正式局这里是 vitality/ticket/free） */
function isPracticeMatch(row: any): boolean {
  const cost = asJsonValue<{ mode?: string }>(row?.entryCost, {}) || {};
  if (cost.mode === 'practice') return true;
  const report = asJsonValue<{ mode?: string }>(row?.report, {}) || {};
  return report.mode === 'practice';
}

function parsePage(value: string): number {
  const n = Number(String(value || '').replace(/^[页pP]/i, ''));
  return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
}

/** 战报截尾：保留开头 4 行（双方信息）+ 结尾若干行（关键回合与结果） */
function truncateReport(lines: string[], max: number): string[] {
  if (!Array.isArray(lines) || lines.length <= max) return lines || [];
  const head = lines.slice(0, 4);
  const tail = lines.slice(-(max - 4));
  return [...head, `…… 省略 ${lines.length - max} 行，「战报 <编号>」看全文 ……`, ...tail];
}

/** MM-DD HH:mm（赛季截止、战报时间戳统一口径） */
function formatTime(value: any): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 多久以前（镜像新鲜度提示） */
function formatAgo(ms: number): string {
  if (!ms) return '';
  const diff = Math.max(0, Date.now() - Number(ms));
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

/** 剩余时长文案（防连打提示）：N小时M分 / N分 */
function formatDuration(ms: number): string {
  const totalMinutes = Math.ceil(Math.max(0, ms) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`;
  return `${Math.max(1, minutes)}分钟`;
}
