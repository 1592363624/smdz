/**
 * 玩家/怪物三池（hp / shield / armor）数值出口归一化 —— 数值三道闸之外的「第四道闸」。
 *
 * 背景（2026-09-10 实测事故）：测试库「路人乙」三池停在
 *   hp=0.01999999999999602 / shield=0.0799999999999983 / armor=0.0799999999999983
 * 面板 Math.round 显示 0/72，但 `isPlayerDead → hp <= 0` 判为存活；同时战斗扣血端
 * 把「已按当前池值截断的微小伤害」再 Math.round 一次抹成 0，导致残血玩家既不死、
 * 又打不掉 —— 残血无敌死锁。
 *
 * 本模块是三池数值的**唯一出口实现**，所有写入/扣减/封顶/回复都必须经过它：
 *   1. 统一两位小数（对齐项目「数值最多两位小数」口径）；
 *   2. 绝对值 < POOL_EPSILON 的残值一律归零（清浮点尾 + 让死亡判定闭合）；
 *   3. 扣血端保证「已分配到该池的正伤害」不会因取整被抹成 0（破 2 中的死锁）。
 *
 * 与既有三道闸（rollAffix /100、formatBonusStats 两位显示、roundItemQuantity 累加）
 * 的关系：那三道管**物品/加成数值**，这一道管**三池当前值**。
 */

/** 浮点尾阈值：两位小数口径下无法表达的值（例 1e-15 级误差） */
export const POOL_EPSILON = 0.01;

/**
 * 归零地板：**不足 0.5 的池值一律归零**。
 *
 * 依据不是「两位小数」，而是**显示一致性**：面板对三池取 Math.round 显示，
 * 0.02 / 0.08 显示出来就是 0。若库里存 0.02 而 `hp <= 0` 判为存活，就会出现
 * 「面板 0 血、人还活着、还挨打不掉血」的自相矛盾态 —— 这正是本次事故的用户可见表现。
 *
 * 因此出口强制：显示为 0 的值，存下来就是 0。0.5 及以上（如龙闪后的 0.72）保留。
 */
export const POOL_ZERO_FLOOR = 0.5;

/** 两位小数取整（项目统一数值口径） */
export function round2(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * 归一化单个池值：非法/负数为 0；两位小数；不足 POOL_ZERO_FLOOR 归零。
 * 用于「当前值」的写入出口（回复、封顶、百分比缩放、落库兜底）。
 */
export function normalizePoolValue(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const rounded = round2(n);
  // 浮点尾 + 显示为 0 的残值（<0.5）一律归零，保证「库内存值」与「面板显示」一致
  if (rounded < POOL_ZERO_FLOOR) return 0;
  return rounded;
}

/**
 * 按上限封顶并归一化。
 * cap <= 0 / 非法 视为「无上限」，仅做归一化（与既有调用点口径一致）。
 */
export function capPoolValue(value: unknown, cap: unknown): number {
  const current = normalizePoolValue(value);
  const limit = Number(cap);
  if (!Number.isFinite(limit) || limit <= 0) return current;
  return normalizePoolValue(Math.min(current, limit));
}

/**
 * 战斗扣血出口：把 calcDamage 分配的「本层伤害」落成「实际扣减量」。
 *
 * 关键语义（修复死锁的核心）：
 * - 伤害 >= 当前池值 → **破池，扣光**（返回原始残值，不再取整）—— 旧实现在这里
 *   `Math.round(0.02) = 0`，残池永远扣不掉，是「残血无敌」的直接成因；
 * - 伤害不足以破池 → 按 Math.round 结算（与旧口径一致），不足 0.5 点则不扣。
 *
 * 禁止在调用侧再对返回值做 Math.round —— 那正是抹零死锁的成因。
 */
export function resolvePoolDamage(assigned: unknown, current: unknown): number {
  // 注意：这里必须用**原始**当前值判定，不能用归一化值 —— 归一化会把 0.02 这类残值
  // 抹成 0，导致「无血可扣」而 resurrect 出打不死的死锁。
  const raw = Number(current);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const want = Number(assigned);
  if (!Number.isFinite(want) || want <= 0) return 0;
  // 破池：扣光。返回原值而非归一化值，确保残池被真正扣到 0（死亡判定得以闭合）。
  if (want >= raw) return raw;
  const rounded = Math.round(want);
  // 伤害不足 0.5 点且不足以破池：不扣（与原版「造成 0」一致）。
  // 真实的大伤害必然走上面的破池分支，不会卡在这里。
  if (rounded <= 0) return 0;
  return normalizePoolValue(Math.min(rounded, raw));
}

/** 扣减后写回：当前值 - 扣减量，出口归一化（<0.01 归零） */
export function subtractPoolValue(current: unknown, damage: unknown): number {
  const base = normalizePoolValue(current);
  const loss = Number(damage);
  if (!Number.isFinite(loss) || loss <= 0) return base;
  return normalizePoolValue(base - loss);
}

/** 三池字段名（顺序：护盾 → 装甲 → 生命，与结算层一致） */
export const POOL_KEYS = ['hp', 'shield', 'armor'] as const;

/**
 * 就地归一化一个对象（玩家或怪物）的三池字段。
 * 作为落库前的兜底闸：任何漏网的浮点写入在这里被收敛，不让脏值进 DB。
 * @returns 是否发生过修改
 */
export function normalizePools(entity: any): boolean {
  if (!entity || typeof entity !== 'object') return false;
  let changed = false;
  for (const key of POOL_KEYS) {
    if (!(key in entity)) continue;
    const before = Number((entity as any)[key]);
    if (!Number.isFinite(before)) continue;
    const after = normalizePoolValue(before);
    if (after !== before) {
      (entity as any)[key] = after;
      changed = true;
    }
  }
  return changed;
}
