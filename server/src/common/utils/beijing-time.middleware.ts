import { Prisma, PrismaClient } from '@prisma/client';
import { BEIJING_OFFSET_MS, beijingNow, shiftDatesInPlace } from './beijing-time.util';

/**
 * Prisma 的 DateTime 一律按 UTC 落库（引擎生成的 now()/@updatedAt 也在引擎侧按 UTC 计算），
 * 且中间件收到的 params.args 中 DateTime 值已被序列化为 ISO 字符串（非 Date 实例）。
 * 本中间件把存储语义统一为「北京时间墙上时间」：
 *  - 写入：模型 DateTime 字段的显式值 +8h；引擎默认填充的 now()/@updatedAt 字段改写为北京时间；
 *  - 读取：引擎返回的 Date 结果统一 -8h，业务层拿到的始终是真实时刻。
 * 字段定位依赖 DMMF（含嵌套关系字段），raw 查询不转换入参（其结果仍做 Date 叠加校正）。
 */

const WRITE_ACTIONS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert']);
const UPDATE_DEFAULT_ACTIONS = new Set(['update', 'updateMany']);
const RAW_ACTIONS = new Set([
  'queryRaw',
  'queryRawUnsafe',
  'executeRaw',
  'executeRawUnsafe',
  'findRaw',
  'aggregateRaw',
  'runCommandRaw',
]);

interface ModelTimeMeta {
  timeFields: Set<string>;
  relationFields: Map<string, string>;
  createDefaults: string[];
  updateDefaults: string[];
}

function buildTimeMeta(): Map<string, ModelTimeMeta> {
  const map = new Map<string, ModelTimeMeta>();
  const models = (Prisma as unknown as { dmmf?: { datamodel?: { models?: unknown[] } } }).dmmf?.datamodel?.models;
  if (!Array.isArray(models)) {
    return map;
  }
  for (const model of models) {
    const raw = model as {
      name?: string;
      fields?: Array<{
        name?: string;
        type?: string;
        kind?: string;
        hasDefaultValue?: boolean;
        isUpdatedAt?: boolean;
        default?: { name?: string };
      }>;
    };
    const timeFields = new Set<string>();
    const relationFields = new Map<string, string>();
    const createDefaults: string[] = [];
    const updateDefaults: string[] = [];
    for (const field of raw.fields ?? []) {
      const name = field.name ?? '';
      if (field.kind === 'object' && field.type) {
        relationFields.set(name, field.type);
        continue;
      }
      if (field.type !== 'DateTime') {
        continue;
      }
      timeFields.add(name);
      if (field.hasDefaultValue && field.default?.name === 'dbgenerated') {
        continue;
      }
      if (field.isUpdatedAt) {
        createDefaults.push(name);
        updateDefaults.push(name);
        continue;
      }
      if (field.hasDefaultValue && field.default?.name === 'now') {
        createDefaults.push(name);
      }
    }
    map.set(raw.name ?? '', { timeFields, relationFields, createDefaults, updateDefaults });
  }
  return map;
}

const TIME_META = buildTimeMeta();

function shiftScalarTime(value: unknown, shiftMs: number): unknown {
  if (value instanceof Date) {
    value.setTime(value.getTime() + shiftMs);
    return value;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (Number.isNaN(t)) {
      return value;
    }
    return new Date(t + shiftMs).toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => shiftScalarTime(item, shiftMs));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = shiftScalarTime((value as Record<string, unknown>)[key], shiftMs);
    }
    return out;
  }
  return value;
}

type Mode = 'data' | 'where';
type Defaults = 'create' | 'update' | 'none';

function applyNode(node: unknown, model: string | undefined, shiftMs: number, mode: Mode, defaults: Defaults, fillValue: Date): void {
  const m = model ?? '';
  if (node instanceof Date) {
    node.setTime(node.getTime() + shiftMs);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      applyNode(item, m, shiftMs, mode, defaults, fillValue);
    }
    return;
  }
  if (!node || typeof node !== 'object') {
    return;
  }
  const obj = node as Record<string, unknown>;
  const meta = TIME_META.get(m);
  if (meta) {
    for (const key of Object.keys(obj)) {
      if (key === 'data' || key === 'where' || key === 'cursor') {
        applyNode(obj[key], m, shiftMs, key === 'where' ? 'where' : 'data', defaults, fillValue);
        continue;
      }
      if (meta.timeFields.has(key)) {
        obj[key] = shiftScalarTime(obj[key], shiftMs);
        continue;
      }
      const target = meta.relationFields.get(key);
      if (target) {
        applyRelation(obj[key], target, shiftMs, fillValue);
        continue;
      }
      applyNode(obj[key], m, shiftMs, mode, 'none', fillValue);
    }
  }
  if (mode === 'data' && defaults !== 'none' && meta && obj) {
    const defs = defaults === 'create' ? meta.createDefaults : meta.updateDefaults;
    for (const f of defs) {
      if (obj[f] === undefined) {
        obj[f] = fillValue;
      }
    }
  }
}

function applyRelation(value: unknown, targetModel: string | undefined, shiftMs: number, fillValue: Date): void {
  const m = targetModel ?? '';
  if (Array.isArray(value)) {
    for (const item of value) {
      applyRelation(item, m, shiftMs, fillValue);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (key === 'create') {
      applyNode(v, m, shiftMs, 'data', 'create', fillValue);
    } else if (key === 'createMany') {
      const sub = v as Record<string, unknown> | undefined;
      applyNode(sub?.data, m, shiftMs, 'data', 'create', fillValue);
      applyNode(sub?.where, m, shiftMs, 'where', 'none', fillValue);
    } else if (key === 'update' || key === 'updateMany') {
      if (Array.isArray(v)) {
        for (const item of v) {
          const row = item as Record<string, unknown> | undefined;
          applyNode(row?.data, m, shiftMs, 'data', 'update', fillValue);
          applyNode(row?.where, m, shiftMs, 'where', 'none', fillValue);
        }
      } else if (v && typeof v === 'object') {
        applyNode(v as Record<string, unknown>, m, shiftMs, 'data', 'update', fillValue);
      }
    } else if (['connect', 'disconnect', 'delete', 'deleteMany'].includes(key)) {
      applyNode(v, m, shiftMs, 'where', 'none', fillValue);
    } else if (['some', 'every', 'none', 'is', 'isNot'].includes(key)) {
      applyNode(v, m, shiftMs, 'where', 'none', fillValue);
    } else {
      applyNode(v, m, shiftMs, 'where', 'none', fillValue);
    }
  }
}

function processArgs(action: string, args: Record<string, unknown> | undefined, model: string | undefined, shiftMs: number, fillValue: Date): void {
  if (!args || !action) {
    return;
  }
  if (action === 'create') {
    applyNode(args.data, model, shiftMs, 'data', 'create', fillValue);
    return;
  }
  if (action === 'createMany') {
    applyNode(args.data, model, shiftMs, 'data', 'create', fillValue);
    return;
  }
  if (action === 'upsert') {
    applyNode(args.create, model, shiftMs, 'data', 'create', fillValue);
    applyNode(args.update, model, shiftMs, 'data', 'update', fillValue);
    applyNode(args.where, model, shiftMs, 'where', 'none', fillValue);
    return;
  }
  if (UPDATE_DEFAULT_ACTIONS.has(action)) {
    applyNode(args.data, model, shiftMs, 'data', 'update', fillValue);
    applyNode(args.where, model, shiftMs, 'where', 'none', fillValue);
    return;
  }
  applyNode(args.where, model, shiftMs, 'where', 'none', fillValue);
  applyNode(args.cursor, model, shiftMs, 'where', 'none', fillValue);
}

export function attachBeijingTimeMiddleware(client: PrismaClient): void {
  client.$use(async (params, next) => {
    const p = params as Prisma.MiddlewareParams & { args?: Record<string, unknown>; model?: string };
    const action = typeof p.action === 'string' ? p.action : '';
    try {
      if (action && !RAW_ACTIONS.has(action)) {
        processArgs(action, p.args, p.model, BEIJING_OFFSET_MS, beijingNow());
      }
    } catch {
      // 旁路校正失败不得影响数据操作本身
    }

    const result = await next(params);
    try {
      if (result && typeof result === 'object') {
        shiftDatesInPlace(result, -BEIJING_OFFSET_MS);
      }
    } catch {
      // 旁路校正失败不得影响数据操作结果本身
    }
    return result;
  });
}