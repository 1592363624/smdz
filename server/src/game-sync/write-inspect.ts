/**
 * 写操作参数解析（纯函数，供 PrismaService $use 拦截器使用）
 * 从 Prisma 写操作的 args 中提取变更实体的归属信息（userId / mapId），
 * 无法确定归属时返回 null（调用方据此决定是否放弃发事件）。
 *
 * 放独立纯函数的原因：$use 回调里不便单测；抽出来后可直接断言输入输出。
 */

export type WriteInspection =
  | { entity: 'player'; userId: number }
  | { entity: 'monster'; monsterId: number; mapId: number };

/** Prisma where 条件中最小数值提取 */
function pickNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 从 where 对象里取 id/userId/mapId 字段（含嵌套 OR/AND 的浅层兜底） */
function fromWhere(where: any): { id?: number; userId?: number; mapId?: number } {
  if (!where || typeof where !== 'object') return {};
  const direct = {
    id: pickNumber(where.id),
    userId: pickNumber(where.userId),
    mapId: pickNumber(where.mapId),
  };
  if (direct.userId || direct.mapId) return direct;
  // updateMany 场景常带 OR/AND 数组，浅扫一层找 userId/mapId
  for (const key of ['OR', 'AND']) {
    const arr = where[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const nested = fromWhere(item);
      if (nested.userId || nested.mapId) return { ...direct, ...nested };
    }
  }
  return direct;
}

/**
 * 解析一次写操作涉及的实体归属。
 * @param model Prisma 模型名（如 'Player' / 'GameMonster'）
 * @param operation Prisma 操作动词
 * @param args 操作参数（where/data/create 等）
 * @returns 归属信息；无法定位时 null
 */
export function inspectWriteParams(model: string, operation: string, args: any): WriteInspection | null {
  if (!args || typeof args !== 'object') return null;

  if (model === 'Player') {
    const where = fromWhere(args.where);
    // create/update 的 data 里通常带 userId（savePlayer 不写 userId，靠 where）
    const dataUserId = pickNumber(args.data?.userId ?? args.create?.userId);
    const userId = where.userId ?? where.id ?? dataUserId;
    // deleteMany 全表或仅按非归属字段过滤时无法定位 → 放弃
    // （Player.id 与 Player.userId 一一对应：@unique，见 schema.prisma L69）
    if (!userId) return null;
    return { entity: 'player', userId };
  }

  if (model === 'GameMonster') {
    const where = fromWhere(args.where);
    const dataMapId = pickNumber(args.data?.mapId ?? args.create?.mapId);
    const mapId = where.mapId ?? dataMapId;
    // 怪物行必属某张地图；定位不到地图则事件无投影价值
    if (!mapId) return null;
    const monsterId = where.id ?? pickNumber(args.data?.id);
    return { entity: 'monster', monsterId: monsterId ?? 0, mapId };
  }

  return null;
}
