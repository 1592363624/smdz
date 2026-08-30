/**
 * Actor 运行时类型定义
 *
 * 设计目标：把「每实体一个串行邮箱 + 内存态 + 单激活 + 异步落库」做成与具体实体无关的
 * 通用原语。玩家/怪物/地图/载具/商店物品都只是「注册进来的一种实体类型」，各自提供
 * load（从存储载入内存态）与 save（落库）即可成为 Actor。
 *
 * 这对应「理想 Actor 模型」的单进程形态：
 * - 每实体独立 Actor（type:id 唯一键）
 * - 私有内存态 + 串行邮箱（同实体写操作严格排队、单时刻一条）
 * - 状态只由该 Actor 自己改（外部通过 run/tell 发消息，不直接碰状态）
 * - 单进程内天然单线程、无竞态、无锁、无 CAS（串行化靠 Promise 链，非 Mutex）
 */

/** 实体类型名，如 'player' | 'monster' | 'map' | 'vehicle' | 'shopitem' */
export type EntityType = string;

/** 实体主键（玩家用 userId，怪物用 GameMonster.id 等） */
export type EntityId = number | string;

export interface EntityKey {
  type: EntityType;
  id: EntityId;
}

/** 稳定字符串键，作为 Map / ALS 的标识 */
export function actorKey(type: EntityType, id: EntityId): string {
  return `${type}:${id}`;
}

/** 持久化策略：writeThrough = 每次写后落库（行为等价于原 savePlayer，最安全）；
 *  deferred = 仅标脏，由定时器/停用统一落库（真正的异步批量，性能最优） */
export type PersistPolicy = 'writeThrough' | 'deferred';

export interface ActorTypeConfig<S = any> {
  /** 从存储载入该实体最新内存态（激活时调用一次） */
  load: (id: EntityId) => Promise<S>;
  /** 将内存态落库（writeThrough 每次写后 / deferred 周期或停用时调用） */
  save: (id: EntityId, state: S) => Promise<void>;
  /** 可选：全新状态的工厂（用于 load 可跳过或作为默认值） */
  initState?: () => S;
  /** 持久化策略，默认 writeThrough */
  persist?: PersistPolicy;
}

/** Actor 消息（tell/ask 风格；run 闭包是更省事的等价物） */
export interface ActorMessage<P = any, R = any> {
  type: string;
  payload?: P;
  /** ask 模式下用于回传结果的解析器（在 state 上执行后返回 R） */
  handle?: (state: any) => Promise<R> | R;
}
