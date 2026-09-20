/**
 * 载具零件名收集。
 *
 * 载具的 parts/builtinParts 既可能是已解析数组，也可能是数据库里的单层编码 JSON 字符串；
 * 零件的内置件字段存在英文键（builtinParts/builtin）与中文键（内置零件/内置）两套历史来源，
 * 因此统一在此处按别名顺序读取，调用方不要再各写一份。
 */

import { asJsonValue } from './json-value.util';

/** 内置零件的候选键，读取顺序与 ?? 链一致（英文规范键优先，中文别名兜底）。 */
const BUILTIN_KEYS = ['builtinParts', '内置零件', 'builtin', '内置'] as const;

function asArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  return asJsonValue<any[]>(value, []);
}

function pickBuiltin(part: any): any[] {
  for (const key of BUILTIN_KEYS) {
    const raw = part?.[key];
    if (raw !== undefined && raw !== null) return asArray(raw);
  }
  return [];
}

/** 递归收集载具（含其内置零件）上所有非空零件名。 */
export function collectVehiclePartNames(vehicle: any): string[] {
  const names: string[] = [];
  const visit = (part: any): void => {
    if (!part) return;
    const name = String(part.name ?? '').trim();
    if (name) names.push(name);
    for (const inner of pickBuiltin(part)) visit(inner);
  };
  for (const part of asArray(vehicle?.parts)) visit(part);
  for (const part of asArray(vehicle?.builtinParts)) visit(part);
  return names;
}
