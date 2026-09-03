/**
 * 兼容两种存储形态的 Json 列读取（与生产 asJsonValue / safeJsonParse 语义一致）：
 *  - Prisma Json 列 / 内存快照 / 权威表示：读出已是「解析好的对象/数组」，直接返回；
 *  - 历史脏数据 / 旧桩字符串：兜底 JSON.parse。
 * 生产已全面切到「Json 列 = 原生对象/数组」（禁止 JSON.stringify 字符串落库），
 * 测试读断言处应用本 helper 而非裸 JSON.parse（否则对对象 parse 会抛 "X is not valid JSON"）。
 */
export function parseJson(value: any, fallback: any): any {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}
