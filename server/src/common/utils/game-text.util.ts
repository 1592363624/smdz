/**
 * 游戏文本规范化工具：原版易语言源码与静态数据(items/equipments/maps/vehicles 等 JSON)用 "#换行" 标记
 * 表示换行（对应原版 #换行符 常量），原样输出会让玩家看到字面的 "#换行" 字样，
 * 故在服务端输出边界(指令结果/公屏消息/面板数据)统一替换为真实换行符。
 */

/** 原版换行标记 */
export const LINE_BREAK_MARKER = '#换行';

/**
 * 指令输出正文里的分隔线（15 个「━」）。前端 RichSystemCard 按这一串切分卡片段落，
 * 改动字符数量或内容必须与展示层同步。
 */
export const CARD_DIVIDER = '━━━━━━━━━━━━━━━';

/**
 * 将游戏文本中的 "#换行" 标记替换为真实换行符
 * @param text 任意文本（非字符串输入原样返回）
 */
export function normalizeGameText<T>(text: T): T {
  if (typeof text !== 'string' || !text.includes(LINE_BREAK_MARKER)) {
    return text;
  }
  return text.split(LINE_BREAK_MARKER).join('\n') as unknown as T;
}

/**
 * 玩家可见的数值显示格式化：最多保留两位小数并去除尾零；无小数的值直接显示整数（不显示 .0）。
 *
 * 物品/资源数量在反复累加后会在浮点层面累出 0.05176666666666652 之类的长尾，
 * 展示层统一收敛到两位小数，避免把浮点误差展示给玩家。
 *
 * 注意：仅用于“对外展示”，严禁用于后续逻辑计算（计算请保有原始数值）。
 * @param value 任意数值（非有限数字时返回 0）
 */
export function formatDisplayNumber(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  // 最多两位小数、自动去尾零（1.5 -> "1.5"，2 -> "2"，0.05 -> "0.05"）
  return String(Math.round(num * 100) / 100);
}

/**
 * 物品/资源数量的计算收敛：四舍五入保留两位小数，用于“存储 + 计算”链路
 * （掉落、奖励、累加、分解返还等），保证入库数据整洁且不向后续计算扩散长尾。
 *
 * 与 formatDisplayNumber（仅展示）不同，本函数返回 number，用于真正写入/累加数值。
 * @param value 数值（非有限数字时返回 0）
 */
export function roundItemQuantity(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

/**
 * 伤害数值的统一展示口径：四舍五入取整（非有限数字按 0 处理）。全库伤害展示只此一处。
 */
export function formatDamageText(value: unknown): string {
  return String(Math.round(Number(value) || 0));
}

// ===== 等宽排版工具（原版两列菜单对齐，全库唯一实现）=====

/**
 * 计算字符串的显示宽度：CJK/全角算 2，其余算 1。
 * 注意：纯"显示宽度"估算，网页比例字体下不保证逐列像素对齐（QQ/终端等准等宽场景对齐）。
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of String(s)) {
    const code = ch.codePointAt(0) ?? 0;
    w += code > 0x2e80 ? 2 : 1;
  }
  return w;
}

/** 按显示宽度右补空格到指定宽度（用于两列菜单左列对齐） */
export function padToWidth(s: string, width: number): string {
  const pad = Math.max(0, width - displayWidth(s));
  return s + ' '.repeat(pad);
}

// ===== 时长文本统一出口（全库唯一实现）=====

/**
 * 毫秒时长文本口径：
 * - 'minSec'：向下取整的「X秒 / X分Y秒」
 * - 'remainingMinutes'：向上取整、最少 1 秒的「X秒 / X分钟」
 */
export type MsDurationStyle = 'minSec' | 'remainingMinutes';

/** 毫秒 → 可读时长文本（默认 'minSec' 口径） */
export function formatMsDurationText(ms: number, style: MsDurationStyle = 'minSec'): string {
  if (style === 'remainingMinutes') {
    const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
    if (totalSeconds < 60) return `${totalSeconds}秒`;
    return `${Math.ceil(totalSeconds / 60)}分钟`;
  }
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (totalSec < 60) return `${totalSec}秒`;
  return `${Math.floor(totalSec / 60)}分${totalSec % 60}秒`;
}

/**
 * 秒时长文本口径：
 * - 'adaptive'：自适应省略高位零段「X天X小时X分 / X小时X分 / X分X秒 / X秒」
 * - 'fullUnits'：始终输出全段落「X天X小时X分X秒」
 */
export type SecondsDurationStyle = 'adaptive' | 'fullUnits';

/** 秒 → 可读时长文本（默认 'adaptive' 口径） */
export function formatSecondsDurationText(
  seconds: number,
  style: SecondsDurationStyle = 'adaptive',
): string {
  if (style === 'fullUnits') {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const day = Math.floor(total / 86400);
    const hour = Math.floor((total % 86400) / 3600);
    const minute = Math.floor((total % 3600) / 60);
    const second = total % 60;
    const parts: string[] = [];
    if (day) parts.push(`${day}天`);
    if (hour || parts.length) parts.push(`${hour}小时`);
    if (minute || parts.length) parts.push(`${minute}分`);
    parts.push(`${second}秒`);
    return parts.join('');
  }
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}天${h}小时${m}分`;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}
