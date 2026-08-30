import { ActorRuntime } from './actor-runtime';
import { EntityKey, actorKey } from './types';

/**
 * 跨实体协调者：在多个 Actor 之间做原子操作，且不会死锁。
 *
 * 纯单 Actor 模型的死穴：交易（A 扣钻 B 加钻）、公会银行、战斗同时改攻防双方——
 * 若 A 持锁等 B、B 持锁等 A 就会死锁。这里用「按稳定键字典序确定性排序」获取邮箱，
 * 任何调用方拿到锁的顺序都一致，环路被打破。
 *
 * 嵌套安全：run 内部再 run 同一实体会走 ActorRuntime 的可重入路径（ALS 识别当前键），
 * 不会自死锁。
 */
export async function coordinate<A = any, B = any, R = any>(
  runtime: ActorRuntime,
  keyA: EntityKey,
  keyB: EntityKey,
  fn: (stateA: A, stateB: B) => Promise<R>,
): Promise<R> {
  const ordered = [keyA, keyB].sort((x, y) =>
    actorKey(x.type, x.id).localeCompare(actorKey(y.type, y.id)),
  );
  const first = ordered[0];
  const second = ordered[1];
  return runtime.run<A, R>(first.type, first.id, async (stateFirst) => {
    return runtime.run<B, R>(second.type, second.id, async (stateSecond) => {
      // 顺序固定为字典序较小的实体先拿邮箱，caller 无论以何种顺序传入都不产生环路。
      // 内部排序后，再按「哪个才是 keyA」把内存态映射回 (stateA, stateB) 的语义位置。
      const aIsFirst = actorKey(first.type, first.id) === actorKey(keyA.type, keyA.id);
      const a = (aIsFirst ? stateFirst : stateSecond) as A;
      const b = (aIsFirst ? stateSecond : stateFirst) as B;
      return fn(a, b);
    });
  });
}

/**
 * 多实体协调：对一组实体按稳定键排序后依次获取邮箱并原子执行。
 * 适用于公会银行、拍卖行等多方参与的写。
 */
export async function coordinateMany<S extends EntityKey, R = any>(
  runtime: ActorRuntime,
  keys: S[],
  fn: (states: Record<string, any>) => Promise<R>,
): Promise<R> {
  const ordered = [...keys].sort((a, b) =>
    actorKey(a.type, a.id).localeCompare(actorKey(b.type, b.id)),
  );
  const states: Record<string, any> = {};
  const runRec = async (i: number): Promise<R> => {
    if (i >= ordered.length) return fn(states);
    const k = ordered[i];
    return runtime.run(k.type, k.id, async (state) => {
      states[actorKey(k.type, k.id)] = state;
      return runRec(i + 1);
    });
  };
  return runRec(0);
}
