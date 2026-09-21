/**
 * 角斗镜像快照（纯函数模块，无服务依赖）。
 *
 * ## 这里冻结的是什么
 * 一份「能喂给现有伤害引擎的最小可战玩家文档」：
 * `buildAttackerBonus(player, playerData)` 只读 `player` 行的标量列
 * 与 `playerData.{weapons, equipment, markers, markers2, buffs, sets}`，
 * 因此快照就把这些原样冻结，其余（背包 / 任务 / 保险柜 / 统计 / 配方 / 装备预设）
 * 与战斗无关且体积最大，直接不入快照。
 *
 * ## 为什么带 bonus 快照
 * 冻结瞬间算出的 `BonusData` 只作展示与「镜像已过期」比对基线；
 * **实战仍以还原出的属性块为准**（三池当前值要在战斗中逐次扣减），
 * 避免同一份数值存在两个真相源。
 *
 * ## 深拷贝纪律
 * `buildAttackerBonus` 会在武器对象上写 `__originalBonus` / `__originalBaseBonus`
 * 缓存，套装判定还会原地改 `weapon.baseBonus`。快照一旦被污染，第二次还原就会从
 * 被污染的值重建（跨次累加）。故：构造时剥离这两个缓存键，还原时整份深拷贝。
 */
import { PlayerData } from '../player.service';
import { BonusData } from '../bonus.service';

/** 快照结构版本：字段语义变化时 +1，旧镜像按版本降级处理或直接要求重提 */
export const MIRROR_SNAPSHOT_VERSION = 1;

/** 与战斗无关、体积最大的列：不入快照（还原时补空数组满足 PlayerData 形状） */
const DROPPED_PLAYER_COLUMNS = [
  'backpack', 'tasks', 'safeBox', 'stats', 'recipes', 'equipmentPresets', 'reverse',
];

/** 武器/装备对象上的计算缓存键：冻结前剥离，防止污染后跨次累加 */
const WEAPON_CACHE_KEYS = ['__originalBonus', '__originalBaseBonus'];

/** 冻结后的角斗镜像 */
export interface MirrorSnapshot {
  v: number;
  /** 冻结时刻(ms)，面板展示「镜像为 X 分钟前的配置」 */
  capturedAt: number;
  userId: number;
  name: string;
  level: number;
  /** 使魔类型（player.type），榜单与战报展示 */
  familiarType: string;
  /** 佩戴中的称号名（无则空串） */
  equippedTitle: string;
  /** 快照瞬间战斗力（calcCombatPower 口径） */
  power: number;
  /** 当前武器索引（1-based，0=赤手），镜像默认以此武器开局 */
  currentWeapon: number;
  /** 玩家行（已剔除与战斗无关的大列） */
  player: Record<string, any>;
  weapons: any[];
  equipment: any[];
  markers: Record<string, any>;
  markers2: any[];
  buffs: any[];
  sets: Record<string, any>;
  /** 冻结瞬间的属性块（仅展示/比对，实战重算） */
  bonus: Record<string, number>;
}

/** JSON 列读出来可能是字符串（存量）或对象（新列），统一洗成对象/数组 */
function asJson<T>(value: any, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/**
 * 深拷贝（BigInt 安全）。
 *
 * Player 的 lastOpTime / readTime / playTime 是 BigInt 列，`JSON.stringify` 会对它们直接抛
 * "Do not know how to serialize a BigInt"——真库里每次提交镜像都会踩到（e2e 实测）。
 * 用 replacer 统一转字符串：快照里只用于还原可战文档，时间戳列不参与任何战斗计算。
 */
function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(
    JSON.stringify(value, (_key, raw) => (typeof raw === 'bigint' ? String(raw) : raw)),
  ) as T;
}

/** 剥离武器/装备对象上的计算缓存键（递归一层数组即可，元素本身是装备对象） */
function stripWeaponCache(list: any[]): any[] {
  return (Array.isArray(list) ? list : []).map((item: any) => {
    if (!item || typeof item !== 'object') return item;
    const clone: Record<string, any> = { ...item };
    for (const key of WEAPON_CACHE_KEYS) delete clone[key];
    return clone;
  });
}

/** 从 titles 列取当前佩戴称号（兼容历史字符串条目） */
function equippedTitleOf(titlesRaw: any): string {
  const titles = asJson<any[]>(titlesRaw, []);
  for (const t of titles) {
    if (typeof t === 'string') continue;
    if (t?.equipped) return String(t.name ?? '');
  }
  return '';
}

export interface BuildMirrorInput {
  userId: number;
  /** 现读的玩家快照（mutate / getPlayerData 的结果） */
  playerData: PlayerData;
  /** 同一份快照算出的属性块（buildAttackerBonus 结果） */
  bonus: BonusData;
  /** calcCombatPower 口径的战斗力 */
  power: number;
  /** 冻结时刻，默认 Date.now() */
  capturedAt?: number;
}

/**
 * 构造镜像快照。只读入参，不写玩家、不落库、不改内存（除深拷贝产物）。
 */
export function buildMirrorSnapshot(input: BuildMirrorInput): MirrorSnapshot {
  const { playerData, bonus, power } = input;
  const player = playerData?.player ?? {};
  const playerRow: Record<string, any> = {};
  for (const [key, value] of Object.entries(player as Record<string, any>)) {
    if (DROPPED_PLAYER_COLUMNS.includes(key)) continue;
    // BigInt 无法 JSON.stringify（lastOpTime/readTime/playTime 为 BigInt 列），转字符串保留原值
    playerRow[key] = typeof value === 'bigint' ? String(value) : value;
  }
  const markers = asJson<Record<string, any>>(playerData.markers ?? player.markers, {});
  return {
    v: MIRROR_SNAPSHOT_VERSION,
    capturedAt: Number(input.capturedAt ?? Date.now()),
    userId: Number(input.userId),
    name: String(player.name ?? player.baseName ?? '').trim(),
    level: Number(player.level ?? 0) || 0,
    familiarType: String(player.type ?? '').trim(),
    equippedTitle: equippedTitleOf(player.titles),
    power: Math.round(Number(power) || 0),
    currentWeapon: Number(player.currentWeapon ?? 0) || 0,
    player: deepClone(playerRow),
    weapons: stripWeaponCache(asJson<any[]>(playerData.weapons ?? player.weapons, [])),
    equipment: stripWeaponCache(asJson<any[]>(playerData.equipment ?? player.equipment, [])),
    markers: deepClone(markers),
    markers2: deepClone(asJson<any[]>(playerData.markers2 ?? player.markers2, [])),
    buffs: deepClone(asJson<any[]>(playerData.buffs ?? player.buffs, [])),
    sets: deepClone(asJson<Record<string, any>>(playerData.sets ?? player.sets, {})),
    bonus: deepClone(asJson<Record<string, number>>(bonus as any, {})),
  };
}

/** 快照是否可用于战斗（版本正确 + 关键结构齐备） */
export function isUsableMirror(snapshot: any): snapshot is MirrorSnapshot {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (Number(snapshot.v) !== MIRROR_SNAPSHOT_VERSION) return false;
  if (!snapshot.player || typeof snapshot.player !== 'object') return false;
  return Array.isArray(snapshot.weapons);
}

/**
 * 把玩家文档拆成一份「与活态完全脱钩」的战斗文档副本。
 *
 * 必须是副本：`buildAttackerBonus` 会在武器对象上写计算缓存并让套装判定原地改
 * `weapon.baseBonus`。若直接喂 `mutate/read` 上下文里的活态对象，这些写入会进入
 * 落库字段签名，导致「只是打开竞技场面板，玩家 version 就 +1」。
 */
export function detachCombatDoc(playerData: PlayerData): PlayerData {
  const player = deepClone(asJson<Record<string, any>>(playerData?.player, {})) as any;
  const weapons = deepClone(asJson<any[]>(playerData?.weapons ?? player.weapons, []));
  const equipment = deepClone(asJson<any[]>(playerData?.equipment ?? player.equipment, []));
  const markers = deepClone(asJson<Record<string, any>>(playerData?.markers ?? player.markers, {}));
  const markers2 = deepClone(asJson<any[]>(playerData?.markers2 ?? player.markers2, []));
  const buffs = deepClone(asJson<any[]>(playerData?.buffs ?? player.buffs, []));
  const sets = deepClone(asJson<Record<string, any>>(playerData?.sets ?? player.sets, {}));
  player.weapons = weapons;
  player.equipment = equipment;
  player.markers = markers;
  player.markers2 = markers2;
  player.buffs = buffs;
  player.sets = sets;
  return {
    player, backpack: [], equipment, weapons, markers, markers2, buffs, tasks: [], safeBox: [], sets,
  } as PlayerData;
}

/** 现算一份当前配置的镜像快照所需的战斗协作者（由服务注入，util 不依赖 DI） */
export interface SnapshotCalc {
  buildAttackerBonus(player: any, playerData: PlayerData, map?: any): BonusData;
  calcCombatPower(bonus: BonusData): number;
}

/**
 * 从「当前玩家文档」现算镜像快照（提交镜像、以及挑战时给攻击方现算都走这里）。
 * 全程只读入参：先脱钩成副本再算属性块，绝不把计算缓存写回活态。
 */
export function snapshotFromPlayerData(
  userId: number,
  playerData: PlayerData,
  calc: SnapshotCalc,
  capturedAt = Date.now(),
): MirrorSnapshot {
  const detached = detachCombatDoc(playerData);
  const bonus = calc.buildAttackerBonus(detached.player, detached, null);
  let power = 0;
  try {
    power = Number(calc.calcCombatPower(bonus)) || 0;
  } catch {
    // 战斗力只用于展示与「镜像过期」提示，算不出来时留 0，不阻塞提交
    power = 0;
  }
  return buildMirrorSnapshot({ userId, playerData: detached, bonus, power, capturedAt });
}

export interface MirrorActor {
  /** 直接可作 buildAttackerBonus 第一参 / getWeaponData 第一参的玩家对象 */
  actor: any;
  /** 与 actor 同源的玩家文档（Json 列均为对象形态） */
  playerData: PlayerData;
}

/**
 * 还原镜像为「可战玩家文档」。
 *
 * 每次还原都返回全新深拷贝：一场战斗里两侧各自还原一次，反复调用不会互相污染，
 * 也绝不会把改动带回真实玩家行（竞技场全程不写 Player，这是「输了不掉资产」的根）。
 */
export function restoreMirrorActor(snapshot: MirrorSnapshot): MirrorActor {
  const player = deepClone(asJson<Record<string, any>>(snapshot.player, {}));
  const weapons = deepClone(asJson<any[]>(snapshot.weapons, []));
  const equipment = deepClone(asJson<any[]>(snapshot.equipment, []));
  const markers = deepClone(asJson<Record<string, any>>(snapshot.markers, {}));
  const markers2 = deepClone(asJson<any[]>(snapshot.markers2, []));
  const buffs = deepClone(asJson<any[]>(snapshot.buffs, []));
  const sets = deepClone(asJson<Record<string, any>>(snapshot.sets, {}));
  // 行上的 Json 列与文档侧同源同引用：还原后两侧看到的必须是同一份，
  // 否则引擎内「读 player.weapons 还是读 playerData.weapons」的分歧会让属性算歪。
  player.weapons = weapons;
  player.equipment = equipment;
  player.markers = markers;
  player.markers2 = markers2;
  player.buffs = buffs;
  player.sets = sets;
  player.backpack = [];
  player.tasks = [];
  player.safeBox = [];
  const playerData = { player, backpack: [], equipment, weapons, markers, markers2, buffs, tasks: [], safeBox: [], sets } as PlayerData;
  return { actor: player, playerData };
}

/**
 * 镜像摘要行（面板与战报头部复用，保证两处口径一致）。
 * @param rankText 该镜像主人的名次文案，如「当前第 3 名 · 白银角斗士」
 */
export function mirrorSummaryLines(snapshot: MirrorSnapshot, rankText = ''): string[] {
  const bonus = snapshot.bonus || {};
  const captured = new Date(Number(snapshot.capturedAt) || Date.now());
  const capturedText = `${captured.getFullYear()}-${String(captured.getMonth() + 1).padStart(2, '0')}-${String(captured.getDate()).padStart(2, '0')} ${String(captured.getHours()).padStart(2, '0')}:${String(captured.getMinutes()).padStart(2, '0')}`;
  const weaponName = String(
    (snapshot.weapons?.[Math.max(0, Number(snapshot.currentWeapon) - 1)] as any)?.name
    ?? '拳头',
  );
  return [
    `镜像主人：${snapshot.name || '无名'}（Lv.${snapshot.level}${snapshot.familiarType ? ` ${snapshot.familiarType}` : ''}${snapshot.equippedTitle ? ` [${snapshot.equippedTitle}]` : ''}）`,
    `战斗力 ${snapshot.power}${rankText ? ` · ${rankText}` : ''}`,
    `生命 ${Math.round(bonus.生命 || 0)} / 装甲 ${Math.round(bonus.装甲 || 0)} / 护盾 ${Math.round(bonus.护盾 || 0)}`,
    `攻击 ${Math.round(bonus.攻击 || 0)} · 命中 ${Math.round(bonus.命中 || 0)} · 闪避 ${Math.round(bonus.闪避 || 0)} · 暴击 ${Math.round(bonus.暴击 || 0)}%`,
    `在手武器：${weaponName}（共 ${snapshot.weapons?.length || 0} 件）`,
    `冻结于 ${capturedText}`,
  ];
}

/** 属性块摘要（战报存档只留关键字段，避免整份 BonusData 撑大行） */
export function mirrorBonusDigest(snapshot: MirrorSnapshot): Record<string, number> {
  const b = snapshot.bonus || {};
  const keys = ['攻击', '攻击2', '命中', '闪避', '暴击', '暴击伤害', '生命', '装甲', '护盾', '物伤', '火伤', '冰伤', '电伤', '贯穿', '减益', '世界等级差距'];
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = Math.round((Number(b[key]) || 0) * 100) / 100;
  return out;
}
