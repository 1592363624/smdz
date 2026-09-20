/**
 * JSON 值容错工具。
 * prisma/data/*.json 的嵌套字段、以及数据库 GameMap/GameVehicle 等表的 JSON 字段
 * 可能是单层编码的 JSON 文本，也可能是已解析的真实数组/对象。
 * 本工具提供统一的「字符串或已解析值」容错读取，调用方无需关心数据来源。
 */

/**
 * 容错读取一个可能是 JSON 字符串、也可能是已解析对象的值。
 * @param fallback 解析失败或空值时的默认值
 */
export function asJsonValue<T>(value: unknown, fallback: T): T {
  // 已是对象/数组：直接返回（干净 JSON 文件、Prisma Json 列读取路径）
  if (value !== null && value !== undefined && typeof value !== 'string') {
    return value as T;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value) as T;
    // 字符串 "null" 解析结果为 null（不抛错），需回退默认值避免调用方 .filter 崩溃
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/**
 * 递归归一化：把数据中所有「看起来是 JSON 的字符串值」解码为真实结构。
 * 用于 StaticDataService.loadRaw 读取旧格式数据文件时兜底，
 * 保证下游业务层拿到的始终是真实数组/对象（新格式文件原样通过，零开销风险）。
 * @returns 归一化后的数据（深拷贝时仅在需要解码处复制）
 */
export function decodeJsonStrings<T>(data: T): T {
  if (typeof data === 'string') {
    const trimmed = data.trim();
    // 仅解码以 { 或 [ 开头的字符串（JSON 结构特征），普通文本原样返回
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return data;
      }
    }
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((item) => decodeJsonStrings(item)) as unknown as T;
  }
  if (data !== null && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
      out[key] = decodeJsonStrings(val);
    }
    return out as T;
  }
  return data;
}
