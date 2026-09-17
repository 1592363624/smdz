/**
 * 字段规范中间件（Prisma）—— 把「历史别名字段」收敛为英文规范名的全局唯一闸口。
 *
 * 为什么放在 Prisma 层：地图/怪物/载具的读写点分散在 20+ 个服务里（拾取、驾驶、
 * 建造、排行、后台寻宝…），逐个接入必然漏。挂在中间件上则**所有**读写自动过闸：
 *   - 写侧：落库前把 data 里的 JSON 列归一化（旧键迁移/删除，规范键为准）；
 *   - 读侧：返回前把行内的 JSON 列归一化（防御部署前写入的历史脏数据 / 直连 SQL）。
 *
 * 归一化只改**字段名**，不改任何数值与内容：markers 的键是标记名（采集木头…）、
 * bonus 的键是属性名（生命/闪避…），都属于内容语义，不在收敛范围内。
 * 规则表见 field-contract.util.ts（唯一映射源）。
 */

import {
  normalizePlayerRow,
  normalizeMapRow,
  normalizeMonsterRow,
  normalizeVehicleRow,
} from '../modules/game/field-contract.util';

/** 模型 → 行级归一化函数（未列出的模型不做任何处理） */
const ROW_NORMALIZERS: Record<string, (row: any) => boolean> = {
  Player: normalizePlayerRow,
  GameMap: normalizeMapRow,
  GameMonster: normalizeMonsterRow,
  GameVehicle: normalizeVehicleRow,
};

/** 读取类操作（返回行数据，需要在返回前归一化） */
const READ_ACTIONS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany']);
/** 视为「写」的操作动词 */
const WRITE_ACTIONS = new Set(['create', 'update', 'updateMany', 'upsert', 'createMany']);

/**
 * 写侧：归一化待写入的 JSON 列。
 * 兼容 Prisma 各种写法：update/updateMany 的 data 为对象或对象数组，
 * upsert 的 create/update 各是一份 data，createMany 的 data 为数组。
 */
function normalizeWriteArgs(args: any, normalize: (row: any) => boolean): void {
  if (!args || typeof args !== 'object') return;
  if (args.data) {
    if (Array.isArray(args.data)) {
      for (const row of args.data) normalize(row);
    } else {
      normalize(args.data);
    }
  }
  // upsert：create / update 是两份独立的 data
  if (args.create) normalize(args.create);
  if (args.update) normalize(args.update);
}

/**
 * 读侧：归一化返回的行（单行或数组）。
 */
function normalizeReadResult(result: any, normalize: (row: any) => boolean): void {
  if (Array.isArray(result)) {
    for (const row of result) normalize(row);
  } else if (result && typeof result === 'object') {
    normalize(result);
  }
}

/**
 * 把字段规范闸挂到 Prisma 实例上（与 attachBeijingTimeMiddleware 同一范式）。
 * 任何异常都只吞掉自己的归一化逻辑，绝不影响数据操作本身。
 */
export function attachFieldCanonicalMiddleware(prisma: any): void {
  prisma.$use(async (params: any, next: (p: any) => Promise<any>) => {
    const model = params?.model;
    const normalize = model ? ROW_NORMALIZERS[model] : undefined;
    if (!normalize) return next(params);

    try {
      if (WRITE_ACTIONS.has(params.action)) normalizeWriteArgs(params.args, normalize);
    } catch {
      // 归一化失败不得阻断写入（最坏情况是历史脏键多留一次）
    }

    const result = await next(params);

    try {
      if (READ_ACTIONS.has(params.action)) normalizeReadResult(result, normalize);
    } catch {
      // 同上：读侧归一化是防御性旁路
    }

    return result;
  });
}