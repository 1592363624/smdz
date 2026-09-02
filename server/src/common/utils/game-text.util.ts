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
