/**
 * 游戏文本规范化工具
 *
 * 原版易语言源码与静态数据(items/equipments/maps/vehicles 等 JSON)中，
 * 使用 "#换行" 文本标记表示换行（对应原版 #换行符 常量）。
 * 该标记若原样输出，玩家会在网页/QQ 里看到字面的 "#换行" 字样。
 * 本工具在服务端输出边界(指令结果/公屏消息/面板数据)统一将其替换为真实换行符。
 */

/** 原版换行标记 */
export const LINE_BREAK_MARKER = '#换行';

/**
 * 将游戏文本中的 "#换行" 标记替换为真实换行符
 * @param text 任意文本（非字符串输入原样返回）
 * @returns 规范化后的文本
 */
export function normalizeGameText<T>(text: T): T {
  if (typeof text !== 'string' || !text.includes(LINE_BREAK_MARKER)) {
    return text;
  }
  return text.split(LINE_BREAK_MARKER).join('\n') as unknown as T;
}

/**
 * 玩家可见的数值显示格式化：最多保留两位小数并去除尾零；
 * 无小数的值直接显示整数（不显示 .0）。
 *
 * 背景：物品/资源/掉落数量在反复累加过程中会在浮点层面累出 0.05176666666666652 之类的长尾，
 * 但数值语义本身只有有限精度。展示层统一收敛到两位小数，避免把浮点误差展示给玩家。
 *
 * 注意：仅用于“对外展示”，严禁用于后续逻辑计算（计算请保有原始数值）。
 * @param value 任意数值（非有限数字时返回 0）
 * @returns 格式化后的展示字符串
 */
export function formatDisplayNumber(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  // 最多两位小数、自动去尾零（1.5 -> "1.5"，2 -> "2"，0.05 -> "0.05"）
  return String(Math.round(num * 100) / 100);
}

/**
 * 物品/资源数量的计算收敛：四舍五入保留两位小数。
 *
 * 适用于“存储 + 计算”链路：掉落、奖励、累加、分解返还等数量在反复运算后会
 * 在浮点层面累出长尾（如 0.05176666666666652），这里统一收敛到两位小数，
 * 既保证入库数据整洁，也避免长尾继续向后续计算扩散。
 *
 * 与 formatDisplayNumber（仅展示）不同，本函数返回 number，用于真正写入/累加数值。
 * @param value 数值（非有限数字时返回 0）
 * @returns 收敛到两位小数后的数值
 */
export function roundItemQuantity(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

/**
 * 伤害数值的统一展示口径：四舍五入取整（非有限数字按 0 处理）。
 *
 * 单一真相源：原 game.service 与 combat-system.service 各持有一份逐字符相同的
 * `displayDamage` 私有实现（重构方案 §11.3 第 3 行），下沉为本 util 后两处改引，
 * 防止双实现漂移。
 * @param value 伤害数值
 * @returns 取整后的展示字符串
 */
export function formatDamageText(value: unknown): string {
  return String(Math.round(Number(value) || 0));
}

// ============================================================
// 时长文本统一出口（P1-2 收敛）
//
// 全库曾扩散 7 个时长格式化辅助（game.service 6 个 + combat-system 1 个，
// 见重构方案 §11.3 第 4 行）。收敛为本文件的两个统一函数：
//   - 毫秒 → 文本：formatMsDurationText
//   - 秒   → 文本：formatSecondsDurationText
// 各历史口径以 style 参数保留（逐字节一致，零行为变化）：
//   - 'minSec'：向下取整的「X秒 / X分Y秒」（原 millisecondsToText / msToTimeTextLocal）
//   - 'remainingMinutes'：向上取整、最少 1 秒的「X秒 / X分钟」（原 formatMilkRemaining）
//   - 'adaptive'：自适应省略高位零段「X天X小时X分 / X小时X分 / X分X秒 / X秒」
//     （原 secondsToTimeText）
//   - 'fullUnits'：始终输出全段落「X天X小时X分X秒」（原 formatVehicleTime / formatUptime）
// ============================================================

/** 毫秒时长文本口径 */
export type MsDurationStyle = 'minSec' | 'remainingMinutes';

/**
 * 毫秒 → 可读时长文本（单一真相源）
 * @param ms 毫秒数
 * @param style 展示口径，默认 'minSec'
 */
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

/** 秒时长文本口径 */
export type SecondsDurationStyle = 'adaptive' | 'fullUnits';

/**
 * 秒 → 可读时长文本（单一真相源）
 * @param seconds 秒数
 * @param style 展示口径，默认 'adaptive'
 */
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
