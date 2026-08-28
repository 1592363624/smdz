/**
 * 过期时间统一工具（增益/标记容器通用）
 *
 * 背景：项目历史原因，玩家增益（Player.buffs）、标记2（Player.markers2）、
 * 怪物增益（GameMonster.buffs）中的到期时间戳存在两套写入口径：
 *  - 秒级时间戳：如战斗层 `Date.now() / 1000 + duration`（多数战斗/技能写入）
 *  - 毫秒时间戳：如物品层 `nowMs + duration * 1000`、中文 key `有效期至`
 * 混用导致「倒计时算成 0:00 却永不过期」「过期增益仍被判定生效」等问题。
 *
 * 本工具把「读取侧」统一到毫秒口径：任何位置判断增益/标记是否有效，
 * 都调用 isActive / toExpireMs，保证两种口径的存量数据都能被正确识别。
 *
 * 判断标准与 combat-state.normalizeBuffItem 保持一致：数值 < 1e12 视为秒。
 * （1e12 毫秒 ≈ 2001-09-09，秒级时间戳 1.7e9 远小于它，毫秒级 1.7e12 大于它）
 */

/** 1 秒 = 1000 毫秒（原版易语言 #转秒） */
export const SECOND_MS = 1000;

/** 秒/毫秒分界阈值：小于它按秒处理 */
const MS_THRESHOLD = 1e12;

/**
 * 取出条目到期时间并归一化为毫秒时间戳
 * @param it 增益/标记条目（中英文 key 均可：有效期至 / expireAt）
 * @returns 毫秒时间戳；0 表示无期限（永久有效）
 */
export function toExpireMs(it: any): number {
  if (!it) return 0;
  const raw = Number(it.有效期至 ?? it.expireAt ?? it.expireTime ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw < MS_THRESHOLD ? raw * SECOND_MS : raw;
}

/**
 * 判断条目是否仍在有效期内
 * @param it 增益/标记条目（无到期时间视为永久有效，与原版无期限增益语义一致）
 * @param nowMs 当前毫秒时间戳（默认取系统时间）
 */
export function isActive(it: any, nowMs: number = Date.now()): boolean {
  const expire = toExpireMs(it);
  return expire === 0 || expire > nowMs;
}

/**
 * 取条目名称（中英文 key 兼容）
 */
export function itemName(it: any): string {
  return String(it?.名称 ?? it?.name ?? '');
}

/**
 * 判断增益数组中是否存在「指定名称且未过期」的条目
 * @param list 增益/标记数组（可为 JSON 字符串）
 * @param name 增益名称
 * @param nowMs 当前毫秒时间戳
 */
export function hasActive(list: any, name: string, nowMs: number = Date.now()): boolean {
  const arr = Array.isArray(list) ? list : [];
  return arr.some((it: any) => itemName(it) === name && isActive(it, nowMs));
}

/**
 * 查找「指定名称且未过期」的条目
 */
export function findActive(list: any, name: string, nowMs: number = Date.now()): any | undefined {
  const arr = Array.isArray(list) ? list : [];
  return arr.find((it: any) => itemName(it) === name && isActive(it, nowMs));
}

/**
 * 过滤出仍在有效期内的条目（无到期时间的永久条目保留）
 * 用于展示与「读取即生效判定」两处，避免过期增益残留。
 */
export function filterActive(list: any, nowMs: number = Date.now()): any[] {
  const arr = Array.isArray(list) ? list : [];
  return arr.filter((it: any) => isActive(it, nowMs));
}

/**
 * 生成「从现在起 seconds 秒后到期」的毫秒时间戳（写入增益时统一使用）
 */
export function expireAfter(seconds: number, nowMs: number = Date.now()): number {
  return nowMs + seconds * SECOND_MS;
}

/**
 * 判断条目在 seconds 秒后仍未过期（用于「增益续期」判定：
 * 已有增益到期时间不够长时才重新写入）。
 *
 * 注意与 isActive 的区别：这里**没有到期时间的条目视为 false**
 * （对齐原版 `b.expireAt > nowSec + 30` 的短路结果，无期限条目会被重新写入），
 * 而 isActive 把无期限条目视为永久有效。
 */
export function isActiveBeyond(it: any, seconds: number, nowMs: number = Date.now()): boolean {
  const expire = toExpireMs(it);
  return expire !== 0 && expire > nowMs + seconds * SECOND_MS;
}

/**
 * 剩余秒数（用于显示倒计时，最低 0）
 */
export function remainSeconds(it: any, nowMs: number = Date.now()): number {
  const expire = toExpireMs(it);
  if (!expire) return 0;
  return Math.max(0, Math.floor((expire - nowMs) / SECOND_MS));
}

/**
 * 把剩余秒数格式化为 m:ss
 */
export function formatRemain(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
