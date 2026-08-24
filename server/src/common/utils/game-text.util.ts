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
