/**
 * 使魔竞技场（异步 PVP · 镜像天梯）配置（纯常量模块，无服务依赖，
 * 避免 system-config → game → system-config 的运行时循环依赖）。
 *
 * 玩法：玩家把当前配置冻结成「角斗镜像」挂上天梯，其他玩家挑战镜像，系统用现成伤害引擎
 * 无头跑完整场战斗并出战报。打的是镜像，输了只掉名次，不动任何真实资产。
 * 天梯没有积分：只能挑战排在自己前面的人，打赢就顶替他的名次、他退到自己的旧位置。
 * 赛季结束时按名次发放**完全可配置**的奖励：资源 / 经验 / 称号 / 头像框 / 功能特权
 * （特权即「把只有管理员能用的口子变成可授予的能力」，如野外批量采集）。
 *
 * 设计与边界见 docs/arena-ladder-design.md。
 * 配置项抽取原则沿用 world-event.config.ts：阈值/开关/周期/奖励均可在系统配置中心在线调整。
 */

/** 入场消耗方式：免费 / 扣活力 / 扣背包门票道具 */
export type ArenaEntryMode = 'free' | 'vitality' | 'ticket';
/**
 * 一场竞技场对局的性质：
 * - `ladder` 正式局：打排在自己前面的人，计费计次、打赢换席位、记胜败；
 * - `practice` 练手局：打排名不高于自己的人（或超出跳级窗口时系统改判的练手对象），
 *   不扣消耗、不占每日次数、席位与名次完全不动、不计胜败场次，只出战报。
 */
export type ArenaMatchMode = 'ladder' | 'practice';
/** 换季名次口径：keep=按上季末名次继承席位 / reset=全部重头排队（席位清零） */
export type ArenaSeasonCarry = 'keep' | 'reset';

/** 段位定义：按**榜单名次区间**判定（排名互换制下没有分数，段位只能挂在名次上） */
export interface ArenaTierDef {
  key: string;
  name: string;
  /** 命中区间下界（含），名次从 1 开始 */
  rankFrom: number;
  /** 命中区间上界（含）；0 表示不限（兜底段位） */
  rankTo: number;
  /** 前端展示色/描边标识 */
  tone: string;
}

/** 可授予的功能特权定义（与 role 无关：role 是后台身份，特权是会到期的玩法奖励） */
export interface ArenaPrivilegeDef {
  key: string;
  name: string;
  description: string;
}

/** 头像框定义（奖励用的稀有装扮，键名进 PlayerAvatarFrame.frameKey） */
export interface ArenaAvatarFrameDef {
  key: string;
  name: string;
  /** 展示样式标识（渐变/描边），前端按此取样式 */
  tone: string;
  description: string;
}

/** 赛季奖励里的特权授予条目 */
export interface ArenaSeasonPrivilege {
  key: string;
  /** 有效天数（到期自动失效；0 = 永久，慎用） */
  days: number;
  /** 授予理由文案，留空则按赛季名次自动生成 */
  reason?: string;
}

/**
 * 单个名次档的奖励。
 * rewards 条目与 CheckinRewardEntry 逐字一致（数量键只有 quantity，写 count 会被发放口静默跳过）。
 */
export interface ArenaSeasonRewardBand {
  /** 名次区间（含端点） */
  from: number;
  to: number;
  /** 发放的资源/经验/活力条目 */
  rewards?: Array<{ type: 'item' | 'exp' | 'vitality' | 'title' | 'frame' | 'privilege'; name: string; quantity: number }>;
  /** 称号名数组（写进 Player.titles，已拥有则跳过） */
  titles?: string[];
  /** 头像框键数组（进 PlayerAvatarFrame） */
  frames?: string[];
  /** 功能特权数组（进 PlayerPrivilege，带到期） */
  privileges?: ArenaSeasonPrivilege[];
  /** 本档展示文案（战报/结算公告用），留空自动生成 */
  label?: string;
}

/** 参与奖：打满场次即可获得，与名次档互不冲突（可同时发放） */
export interface ArenaSeasonParticipation {
  minMatches: number;
  rewards?: ArenaSeasonRewardBand['rewards'];
  titles?: string[];
  frames?: string[];
}

/** 赛季奖励总配置（SystemConfig `arena.seasonRewards`，json） */
export interface ArenaSeasonRewards {
  ranks: ArenaSeasonRewardBand[];
  participation?: ArenaSeasonParticipation;
}

/** 系统配置键：标量各一条便于单条调整，复杂结构走 json */
export const ARENA_CONFIG_KEYS = {
  enabled: 'arena.enabled',
  /** 段位表（按名次区间，json） */
  tierConfig: 'arena.tierConfig',
  /**
   * 可挑战的名次差上限：默认 1 = 只能一顺位往上打（要碰更高的人，必须先打赢眼前的相邻位）；
   * N = 可打「高出你 1~N 名」；0 = 只要求排名在自己前面、不限差多少（放开跳级狙击）。
   */
  challengeRankWindow: 'arena.challengeRankWindow',
  /** 每日挑战次数与入场消耗 */
  dailyChallengeLimit: 'arena.dailyChallengeLimit',
  entryMode: 'arena.entryMode',
  entryVitalityCost: 'arena.entryVitalityCost',
  entryTicketItem: 'arena.entryTicketItem',
  entryTicketCost: 'arena.entryTicketCost',
  /** 提交/刷新镜像的消耗（与挑战独立计数） */
  submitMode: 'arena.submitMode',
  submitVitalityCost: 'arena.submitVitalityCost',
  submitTicketItem: 'arena.submitTicketItem',
  submitTicketCost: 'arena.submitTicketCost',
  /** 防连打窗口（小时） */
  avoidRepeatHours: 'arena.avoidRepeatHours',
  /** 无头战斗的时间轴上限 */
  battleTimeLimitSec: 'arena.battleTimeLimitSec',
  battleMaxActions: 'arena.battleMaxActions',
  /** 参战门槛（防止 1 级号占榜） */
  minLevelToEnter: 'arena.minLevelToEnter',
  /**
   * 开榜初始排名：系统刚上线、全服还没有任何天梯档案时，按当时的**战斗力**给达标玩家排出初始名次。
   * 没有这一步，第一批玩家的名次只由「谁先发送提交镜像」决定，榜首等于手快的人。
   */
  rankInitByPower: 'arena.rankInitByPower',
  /** 初始排名一次处理多少人（战力要逐人现算，冷启动时控住总开销） */
  rankInitLimit: 'arena.rankInitLimit',
  /** 赛季 */
  seasonLengthDays: 'arena.seasonLengthDays',
  seasonStartAt: 'arena.seasonStartAt',
  /** 换季名次口径：keep=按上季名次继承席位 / reset=全部重头排队 */
  seasonCarry: 'arena.seasonCarry',
  seasonRewards: 'arena.seasonRewards',
  /** 赛季结算是否在世界频道公告前三名（每赛季仅一次） */
  announceSeason: 'arena.announceSeason',
  /** 头像框定义表（json） */
  avatarFrames: 'arena.avatarFrames',
  /** 持有 batchGather 特权的玩家，野外批量采集的倍率上限（管理员不受限） */
  batchGatherPrivilegeMax: 'arena.batchGatherPrivilegeMax',
  /** 榜单每页条数 */
  ladderPageSize: 'arena.ladderPageSize',
} as const;

/** 段位表默认（名次区间；rankTo=0 表示不限，兜底放最后） */
export const DEFAULT_ARENA_TIERS: ArenaTierDef[] = [
  { key: 'grandmaster', name: '传奇角斗士', rankFrom: 1, rankTo: 1, tone: 'gold' },
  { key: 'master', name: '天梯大师', rankFrom: 2, rankTo: 3, tone: 'purple' },
  { key: 'diamond', name: '钻石斗技者', rankFrom: 4, rankTo: 10, tone: 'cyan' },
  { key: 'platinum', name: '白金斗技者', rankFrom: 11, rankTo: 30, tone: 'silver-blue' },
  { key: 'gold', name: '黄金试炼者', rankFrom: 31, rankTo: 100, tone: 'bronze-gold' },
  { key: 'silver', name: '白银试炼者', rankFrom: 101, rankTo: 300, tone: 'silver' },
  { key: 'bronze', name: '见习角斗士', rankFrom: 301, rankTo: 0, tone: 'brown' },
];

/**
 * 默认挑战资格窗口：1 = 只能一顺位往上打（想碰更高的人，必须先打赢前面的相邻位）。
 * 0 = 不限名次差，只要排在自己前面就能打（跳级狙击榜首）。
 * 一顺位往上打让「连胜爬榜」成为唯一的上位路径，也限制了打赢一次带来的名次震荡。
 */
export const DEFAULT_ARENA_CHALLENGE_RANK_WINDOW = 1;

/** 每日挑战次数 / 入场消耗默认 */
export const DEFAULT_ARENA_DAILY_LIMIT = 10;
export const DEFAULT_ARENA_ENTRY_MODE: ArenaEntryMode = 'vitality';
export const DEFAULT_ARENA_ENTRY_VITALITY = 20;
export const DEFAULT_ARENA_ENTRY_TICKET_ITEM = '竞技场门票';
export const DEFAULT_ARENA_ENTRY_TICKET_COST = 1;
export const DEFAULT_ARENA_SUBMIT_MODE: ArenaEntryMode = 'vitality';
export const DEFAULT_ARENA_SUBMIT_VITALITY = 10;
export const DEFAULT_ARENA_AVOID_REPEAT_HOURS = 6;
export const DEFAULT_ARENA_BATTLE_TIME_LIMIT_SEC = 180;
export const DEFAULT_ARENA_BATTLE_MAX_ACTIONS = 400;
export const DEFAULT_ARENA_MIN_LEVEL = 30;
/** 开榜按战力排初始名次：默认开；一次最多 500 人（逐人现算属性块，冷启动的总开销靠这个数兜住） */
export const DEFAULT_ARENA_RANK_INIT_BY_POWER = true;
export const DEFAULT_ARENA_RANK_INIT_LIMIT = 500;
export const DEFAULT_ARENA_LADDER_PAGE_SIZE = 20;

/** 赛季默认 */
export const DEFAULT_ARENA_SEASON_LENGTH_DAYS = 30;
/** keep=按上季名次继承席位（新季仍要重新提交镜像）；reset=全部重头排队 */
export const DEFAULT_ARENA_SEASON_CARRY: ArenaSeasonCarry = 'keep';

/** 特权定义（新增特权在此登记，后台与文案自动生效） */
export const ARENA_PRIVILEGE_DEFS: ArenaPrivilegeDef[] = [
  {
    key: 'batchGather',
    name: '野外批量采集',
    description: '在非家园地图用「采集指令N」一次采 N 次（倍率上限受系统配置约束，管理员不受限）',
  },
];
/** 批量采集特权键（采集口判定用） */
export const PRIVILEGE_BATCH_GATHER = 'batchGather';
export const DEFAULT_ARENA_BATCH_GATHER_PRIVILEGE_MAX = 10;

/** 头像框定义默认 */
export const DEFAULT_ARENA_AVATAR_FRAMES: ArenaAvatarFrameDef[] = [
  { key: 'arena_champion', name: '冠冕·天梯之首', tone: 'gold-crown', description: '赛季冠军限定，全服唯一' },
  { key: 'arena_elite', name: '环·白银竞技场', tone: 'silver-ring', description: '赛季前三限定' },
  { key: 'arena_player', name: '角斗印记', tone: 'bronze-mark', description: '赛季参与纪念' },
];

/**
 * 赛季奖励默认表。
 * 名次档 + 参与奖；称号/头像框/特权/资源全部可后台改，不需要发版。
 * 对应称号需存在于 titles.json（直发口对未知称号只告警不拒发，方便先配后补表）。
 */
export const DEFAULT_ARENA_SEASON_REWARDS: ArenaSeasonRewards = {
  ranks: [
    {
      from: 1, to: 1, label: '赛季冠军',
      titles: ['竞技场之王'],
      frames: ['arena_champion'],
      privileges: [{ key: PRIVILEGE_BATCH_GATHER, days: 30 }],
      rewards: [
        { type: 'item', name: '凭证', quantity: 30 },
        { type: 'item', name: '传说强化券', quantity: 10 },
        { type: 'exp', name: '', quantity: 200000 },
      ],
    },
    {
      from: 2, to: 3, label: '赛季亚军',
      frames: ['arena_elite'],
      rewards: [
        { type: 'item', name: '凭证', quantity: 20 },
        { type: 'item', name: '史诗强化券', quantity: 10 },
        { type: 'exp', name: '', quantity: 120000 },
      ],
    },
    {
      from: 4, to: 10, label: '赛季前十',
      titles: ['角斗大师'],
      rewards: [
        { type: 'item', name: '凭证', quantity: 10 },
        { type: 'exp', name: '', quantity: 80000 },
      ],
    },
    {
      from: 11, to: 30, label: '赛季三十强',
      rewards: [{ type: 'exp', name: '', quantity: 40000 }],
    },
  ],
  participation: {
    minMatches: 10,
    titles: ['天梯常客'],
    frames: ['arena_player'],
    rewards: [{ type: 'item', name: '凭证', quantity: 3 }],
  },
};

/** 系统配置中心写入用的 JSON 文本（value 一律字符串） */
export const DEFAULT_ARENA_TIERS_JSON = JSON.stringify(DEFAULT_ARENA_TIERS);
export const DEFAULT_ARENA_AVATAR_FRAMES_JSON = JSON.stringify(DEFAULT_ARENA_AVATAR_FRAMES);
export const DEFAULT_ARENA_SEASON_REWARDS_JSON = JSON.stringify(DEFAULT_ARENA_SEASON_REWARDS);

/** 把任意值洗成正整数；非法（NaN/负/非有限）回落默认 */
export function arenaPositive(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 把任意值洗成非负整数（0 有业务含义的场景用这个） */
export function arenaNonNegative(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** 段位表是否还是积分制的「minRating 阈值」旧形状（名次制下这份永远不会命中） */
export function isLegacyArenaTierConfig(raw: any): boolean {
  const value = typeof raw === 'string' ? tryParseJsonArray(raw) : raw;
  const list = Array.isArray(value) ? value : Array.isArray(value?.tiers) ? value.tiers : [];
  return list.some((t: any) => t && t.minRating !== undefined && t.rankFrom === undefined);
}

/**
 * 段位表归一（按名次区间，过滤非法项后按 rankFrom 升序）。
 * 兼容旧的「minRating 阈值」形状：那是积分制的遗留配置，识别到就直接回落默认表，
 * 免得后台里躺着一份永远不会命中的段位表。
 */
export function normalizeArenaTiers(raw: any): ArenaTierDef[] {
  const value = typeof raw === 'string' ? tryParseJsonArray(raw) : raw;
  const list = Array.isArray(value) ? value : Array.isArray(value?.tiers) ? value.tiers : [];
  if (isLegacyArenaTierConfig(list)) return [...DEFAULT_ARENA_TIERS];
  const tiers = list
    .filter((t: any) => t && typeof t.name === 'string' && t.name.trim())
    .map((t: any) => ({
      key: String(t.key ?? t.name).trim(),
      name: String(t.name).trim(),
      rankFrom: arenaPositive(t.rankFrom, 1),
      rankTo: arenaNonNegative(t.rankTo, 0),
      tone: String(t.tone ?? '').trim(),
    }));
  if (tiers.length === 0) return [...DEFAULT_ARENA_TIERS];
  tiers.sort((a: ArenaTierDef, b: ArenaTierDef) => a.rankFrom - b.rankFrom);
  return tiers;
}

/**
 * 按**榜单名次**取段位（rankTo=0 表示不限，作兜底档）。
 * 段位跟名次走，所以别人往上换、你就会掉段位——这正是擂台制该有的手感。
 */
export function deriveArenaTier(tiers: ArenaTierDef[], rank: number): ArenaTierDef {
  const r = arenaPositive(rank, 1);
  for (const tier of tiers) {
    if (r >= tier.rankFrom && (tier.rankTo === 0 || r <= tier.rankTo)) return tier;
  }
  return tiers[tiers.length - 1] ?? DEFAULT_ARENA_TIERS[DEFAULT_ARENA_TIERS.length - 1];
}

/**
 * 新入榜者的席位：排在当前最低席位再往后一名；空榜时第一名拿 1 号席位。
 * 席位只用来定序（越大越靠前），数值本身不对外展示，所以允许一路往负数走，
 * 赛季边界会按名次重排成 1..N（见 ArenaSeasonService.compactSeats）。
 */
export function seatForNewcomer(lowestSeat: number | null | undefined): number {
  if (lowestSeat === null || lowestSeat === undefined) return 1;
  const base = Number(lowestSeat);
  return (Number.isFinite(base) ? base : 1) - 1;
}

/**
 * 「本赛季达到过的最好名次」的合并：名次越小越好，0 表示还没记录过（直接取本次）。
 * 只进不退，提交镜像和打赢换位两处都要走它，否则靠提交爬到第 1 名的人最佳名次会一直空着。
 */
export function bestRankAfter(prev: number | null | undefined, rank: number): number {
  const p = Number(prev) || 0;
  const r = Number(rank) || 0;
  if (r <= 0) return p;
  if (p <= 0) return r;
  return Math.min(p, r);
}

/** 头像框表归一（容忍 JSON 文本：配置中心按 json 类型解析，但 seed/导入路径可能给字符串） */
export function normalizeArenaFrames(raw: any): ArenaAvatarFrameDef[] {
  const list0 = typeof raw === 'string' ? tryParseJsonArray(raw) : raw;
  const list = Array.isArray(list0) ? list0 : Array.isArray(list0?.frames) ? list0.frames : [];
  const frames = list
    .filter((f: any) => f && typeof f.key === 'string' && f.key.trim())
    .map((f: any) => ({
      key: String(f.key).trim(),
      name: String(f.name ?? f.key).trim(),
      tone: String(f.tone ?? '').trim(),
      description: String(f.description ?? '').trim(),
    }));
  return frames.length > 0 ? frames : [...DEFAULT_ARENA_AVATAR_FRAMES];
}

/** JSON 文本宽容解析：不是合法 JSON 就原样返回，交给上层归一逻辑回落默认 */
function tryParseJsonArray(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 奖励条目类型白名单：与 CheckinRewardService 的发放口同一套键，写错类型的条目直接丢 */
const ARENA_REWARD_TYPES = new Set(['item', 'exp', 'vitality', 'title', 'frame', 'privilege']);

/** 洗一档奖励条目：只认白名单类型（拼错的 type 绝不能退化成"按物品发进背包"去凭空造物） */
function normalizeRewardEntries(raw: any): ArenaSeasonRewardBand['rewards'] {
  if (!Array.isArray(raw)) return undefined;
  const list = raw
    .filter((r: any) => r && ARENA_REWARD_TYPES.has(String(r.type ?? 'item')))
    .map((r: any) => ({
      type: r.type,
      name: String(r.name ?? '').trim(),
      // 数量只认规范键 quantity（与 grantRewards 同一口径），旧键 count 在此明确拒绝
      quantity: arenaNonNegative(r.quantity, 0),
    }));
  return list.length > 0 ? list : undefined;
}

/**
 * 赛季奖励表归一：洗掉非法档位（from>to、名次非正），按 from 升序返回。
 * 结构被后台手改坏时回落内置默认，保证结算不会整体哑火。
 */
export function normalizeArenaSeasonRewards(raw: any): ArenaSeasonRewards {
  const source = (typeof raw === 'string' ? tryParseJsonArray(raw) : raw) as any;
  if (!source) return structuredCloneSafe(DEFAULT_ARENA_SEASON_REWARDS);
  const ranks: ArenaSeasonRewardBand[] = (Array.isArray(source.ranks) ? source.ranks : [])
    .filter((b: any) => b && arenaPositive(b.from, 0) > 0)
    .map((b: any) => ({
      from: arenaPositive(b.from, 1),
      to: Math.max(arenaPositive(b.from, 1), arenaPositive(b.to, arenaPositive(b.from, 1))),
      titles: Array.isArray(b.titles) ? b.titles.map((t: any) => String(t).trim()).filter(Boolean) : undefined,
      frames: Array.isArray(b.frames) ? b.frames.map((t: any) => String(t).trim()).filter(Boolean) : undefined,
      privileges: Array.isArray(b.privileges)
        ? b.privileges
            .filter((p: any) => p && typeof p.key === 'string' && p.key.trim())
            .map((p: any) => ({ key: String(p.key).trim(), days: arenaNonNegative(p.days, 30), reason: p.reason ? String(p.reason) : '' }))
        : undefined,
      rewards: normalizeRewardEntries(b.rewards),
      label: b.label ? String(b.label) : undefined,
    }))
    .sort((a, b) => a.from - b.from);
  const p = source.participation;
  return {
    ranks,
    participation: p && typeof p === 'object'
      ? {
          minMatches: arenaNonNegative(p.minMatches, 0),
          titles: Array.isArray(p.titles) ? p.titles.map((t: any) => String(t).trim()).filter(Boolean) : undefined,
          frames: Array.isArray(p.frames) ? p.frames.map((t: any) => String(t).trim()).filter(Boolean) : undefined,
          rewards: normalizeRewardEntries(p.rewards),
        }
      : undefined,
  };
}

/** 取某名次命中的所有奖励档（区间重叠时全部命中，保持配置顺序） */
export function matchArenaRewardBands(cfg: ArenaSeasonRewards, rank: number): ArenaSeasonRewardBand[] {
  const r = Number(rank);
  if (!Number.isFinite(r) || r <= 0) return [];
  return (cfg.ranks || []).filter((band) => r >= band.from && r <= band.to);
}

/** structuredClone 在 Node 18/20 皆有，保险起见失败回落 JSON 深拷贝 */
export function structuredCloneSafe<T>(value: T): T {
  try {
    return (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))) as T;
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/** 特权定义查表（后台/文案都以此为准，新增特权只改 ARENA_PRIVILEGE_DEFS） */
export function findPrivilegeDef(key: string): ArenaPrivilegeDef | undefined {
  return ARENA_PRIVILEGE_DEFS.find((p) => p.key === String(key || '').trim());
}

/** 特权键的中文名（未知键回落键名本身，不让后台配错导致文案空白） */
export function privilegeLabel(key: string): string {
  return findPrivilegeDef(key)?.name ?? String(key || '');
}

/** 入场模式归一 */
export function normalizeArenaEntryMode(raw: any): ArenaEntryMode {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'free' || v === 'ticket' || v === 'vitality' ? (v as ArenaEntryMode) : DEFAULT_ARENA_ENTRY_MODE;
}

/**
 * 换季名次口径归一。
 * `softReset` 是积分制（按系数保留旧分）的遗留值，名次互换制下没有对应逻辑，一律按 keep 处理；
 * 该值同时被系统配置启动流程用来把库里仍是 softReset 的行刷回默认（见 ARENA_LEGACY_SEASON_CARRY）。
 */
export function normalizeArenaSeasonCarry(raw: any): ArenaSeasonCarry {
  const v = String(raw ?? '').trim();
  return v === 'reset' ? 'reset' : 'keep';
}

/** 积分制遗留的换季口径值（名次制下没有读取方，启动时刷回默认） */
export const ARENA_LEGACY_SEASON_CARRY = 'softReset';

/** 本地日期 YYYY-MM-DD（与签到 / 抽奖 / 每日登录同一口径，0 点自然重置） */
export function arenaTodayString(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** 系统配置中心的一条默认项（结构与 SystemConfigService.DEFAULT_CONFIGS 逐字段一致） */
export interface ArenaConfigDefault {
  key: string;
  value: string;
  label: string;
  description: string;
  type: 'number' | 'boolean' | 'string' | 'json';
  group: 'arena';
}

/**
 * 竞技场全部配置项的默认表（供 SystemConfigService.DEFAULT_CONFIGS 直接展开）。
 * 启动时 ensureDefaultConfigs 幂等落库、不覆盖管理员已改的值；后台按 group=arena 成组展示。
 * 这里每一项都被代码真实读取——不放无消费者的键。
 */
export const ARENA_DEFAULT_CONFIGS: ArenaConfigDefault[] = [
  { key: ARENA_CONFIG_KEYS.enabled, value: 'true', label: '竞技场总开关', description: '关闭后所有竞技场指令只提示暂未开放', type: 'boolean', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.tierConfig, value: DEFAULT_ARENA_TIERS_JSON, label: '段位表(JSON)', description: '[{key,name,rankFrom,rankTo,tone}] 按**榜单名次区间**判定，rankTo=0 表示不限；改名改区间即时生效', type: 'json', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.challengeRankWindow, value: String(DEFAULT_ARENA_CHALLENGE_RANK_WINDOW), label: '可挑战名次差上限', description: '默认 1=只能一顺位往上打（想打更高的必须先赢前面那个）；N=可打高出自己 1~N 名；0=只要求排名更高、不限差多少', type: 'number', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.dailyChallengeLimit, value: String(DEFAULT_ARENA_DAILY_LIMIT), label: '每日挑战次数', description: '0点按天懒重置；0 表示关闭挑战（仍可提交镜像）', type: 'number', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.entryMode, value: DEFAULT_ARENA_ENTRY_MODE, label: '挑战消耗方式', description: 'vitality=扣活力 / ticket=扣背包门票 / free=免费', type: 'string', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.entryVitalityCost, value: String(DEFAULT_ARENA_ENTRY_VITALITY), label: '挑战消耗活力', description: 'entryMode=vitality 时每次挑战扣除的活力', type: 'number', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.entryTicketItem, value: DEFAULT_ARENA_ENTRY_TICKET_ITEM, label: '挑战门票道具名', description: 'entryMode=ticket 时从背包按名扣除的道具', type: 'string', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.entryTicketCost, value: String(DEFAULT_ARENA_ENTRY_TICKET_COST), label: '挑战门票数量', description: '每次挑战消耗的门票张数', type: 'number', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.submitMode, value: DEFAULT_ARENA_SUBMIT_MODE, label: '提交镜像消耗方式', description: '与挑战独立计费：vitality / ticket / free', type: 'string', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.submitVitalityCost, value: String(DEFAULT_ARENA_SUBMIT_VITALITY), label: '提交镜像消耗活力', description: '每次刷新角斗镜像扣除的活力', type: 'number', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.submitTicketItem, value: DEFAULT_ARENA_ENTRY_TICKET_ITEM, label: '提交镜像门票道具名', description: 'submitMode=ticket 时扣除的道具', type: 'string', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.submitTicketCost, value: '0', label: '提交镜像门票数量', description: '默认 0：提交不额外吃门票，避免不敢刷新镜像', type: 'number', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.avoidRepeatHours, value: String(DEFAULT_ARENA_AVOID_REPEAT_HOURS), label: '同一镜像防连打(小时)', description: '0=不限制；防止盯着一人刷分', type: 'number', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.battleTimeLimitSec, value: String(DEFAULT_ARENA_BATTLE_TIME_LIMIT_SEC), label: '镜像对战时限(秒)', description: '到点未分生死按三池剩余生命比例判定，相等记平局', type: 'number', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.battleMaxActions, value: String(DEFAULT_ARENA_BATTLE_MAX_ACTIONS), label: '镜像对战出手上限', description: '双方合计出手次数上限，防极端数据空转', type: 'number', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.minLevelToEnter, value: String(DEFAULT_ARENA_MIN_LEVEL), label: '竞技场开放等级', description: '低于该等级不能提交镜像与挑战', type: 'number', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.rankInitByPower, value: String(DEFAULT_ARENA_RANK_INIT_BY_POWER), label: '开榜按战力排初始名次', description: '全服还没有任何天梯档案时（系统刚上线），启动后按当时战斗力排出初始名次；关掉则所有人从「提交镜像」那一刻起排队尾', type: 'boolean', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.rankInitLimit, value: String(DEFAULT_ARENA_RANK_INIT_LIMIT), label: '初始名次人数上限', description: '初始排名一次处理多少人（战力要逐人现算，控冷启动开销；超出的人走提交镜像排队尾）', type: 'number', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.ladderPageSize, value: String(DEFAULT_ARENA_LADDER_PAGE_SIZE), label: '天梯榜每页条数', description: '「竞技场 页N」每页显示多少个镜像', type: 'number', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.seasonLengthDays, value: String(DEFAULT_ARENA_SEASON_LENGTH_DAYS), label: '赛季长度(天)', description: '开季与换季时决定截止时刻，改值不影响进行中的本赛季', type: 'number', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.seasonStartAt, value: '', label: '首赛季开始时刻', description: '留空=首次启动即刻开季；填 ISO 时刻（如 2026-10-01T00:00:00）可预排', type: 'string', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.seasonCarry, value: DEFAULT_ARENA_SEASON_CARRY, label: '换季名次口径', description: 'keep=按上季末名次继承席位（仍须重提镜像）/ reset=全部重头排队', type: 'string', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.seasonRewards, value: DEFAULT_ARENA_SEASON_REWARDS_JSON, label: '赛季奖励表(JSON)', description: 'ranks:[{from,to,titles,frames,privileges,rewards}] + participation；名次档全部可配', type: 'json', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.avatarFrames, value: DEFAULT_ARENA_AVATAR_FRAMES_JSON, label: '头像框定义(JSON)', description: '[{key,name,tone,description}]，赛季奖励按 key 发放', type: 'json', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.batchGatherPrivilegeMax, value: String(DEFAULT_ARENA_BATCH_GATHER_PRIVILEGE_MAX), label: '批量采集特权倍率上限', description: '持 batchGather 特权者在野外一次最多采几倍（管理员不受此限）', type: 'number', group: 'arena' },
  { key: ARENA_CONFIG_KEYS.announceSeason, value: 'true', label: '赛季结算世界公告', description: '每赛季一次，公布前三名与冠军获得的特权', type: 'boolean', group: 'arena' },
];

/** 指令名（seed 与 handler 共用，避免两处拼写漂移） */
export const ARENA_COMMANDS = {
  ladder: '竞技场',
  submit: '提交镜像',
  /** 不叫「挑战」：项目里 使魔挑战 / 开始挑战 已是爬塔指令，且前缀回落匹配会把裸「挑战」误伤 */
  challenge: '挑战镜像',
  history: '竞技场战绩',
  report: '战报',
  frames: '头像框',
  admin: '竞技场管理',
} as const;
