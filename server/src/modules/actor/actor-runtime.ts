import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import {
  ActorTypeConfig,
  EntityId,
  EntityType,
  actorKey,
  PersistPolicy,
} from './types';

/**
 * 单进程 Actor 运行时
 *
 * 每个实体（type:id）对应一个 ActorCell：
 * - mailbox：一条 per-key 的 Promise 链，保证同实体所有写操作严格串行、单时刻一条
 *   （与旧 enqueueUserWrite 同构，但承载的是「内存态」而非每次打库）。
 * - state：实体内存态，激活时由 type.load 载入，之后复用，不再每次打库。
 * - dirty：被修改过、待落库。
 * - 单激活：同一 type:id 在进程内只有一个 cell（Map 唯一键），天然无并发写。
 *
 * 串行化靠 Promise 链而非 Mutex，所以「无锁、无 CAS」；version 仅由 $use 中间件自增
 * （审计/增量重放用），不在 Actor 层做冲突判定。
 *
 * 跨进程：本运行时仅保证单进程内串行。水平扩容时同一实体落不同实例会打破保证——
 * 届时需在前面加「玩家/实体亲和路由」或把 mailbox 换成分布式（见 docs）。本运行时预留
 * 了 type + id 的稳定键，便于未来接分布式邮箱。
 */
interface ActorCell<S = any> {
  key: string;
  type: EntityType;
  id: EntityId;
  state: S | undefined;
  dirty: boolean;
  activating: Promise<void> | null;
  mailbox: Promise<unknown>;
  lastUsed: number;
}

export interface ActorRuntimeOptions {
  /** 内存中最多保留多少个 Actor cell，超过后按 LRU 驱逐（先落库脏 cell） */
  lruMax?: number;
  /** 周期落库间隔（ms），0 关闭定时器 */
  flushIntervalMs?: number;
  /** 空闲多久（ms）的脏 cell 在周期落库时被驱逐 */
  idleEvictMs?: number;
}

@Injectable()
export class ActorRuntime implements OnModuleDestroy {
  private readonly cells = new Map<string, ActorCell>();
  private readonly types = new Map<EntityType, ActorTypeConfig>();
  /** 当前异步链归属的实体键（Actor 内可重入，不重复排队） */
  private readonly als = new AsyncLocalStorage<string>();
  private flushTimer?: ReturnType<typeof setInterval>;
  private readonly lruMax: number;
  private readonly flushIntervalMs: number;
  private readonly idleEvictMs: number;
  private readonly logger = new Logger(ActorRuntime.name);

  constructor(opts: ActorRuntimeOptions = {}) {
    this.lruMax = opts.lruMax ?? 2000;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.idleEvictMs = opts.idleEvictMs ?? 30_000;
    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        void this.flushIdle().catch((e) => this.logger.error(`周期落库失败: ${String(e)}`));
      }, this.flushIntervalMs);
      // 不参与事件循环引用，进程空闲也能退出
      if (typeof (this.flushTimer as any).unref === 'function') (this.flushTimer as any).unref();
    }
  }

  registerType(type: EntityType, config: ActorTypeConfig): void {
    this.types.set(type, config);
  }

  hasType(type: EntityType): boolean {
    return this.types.has(type);
  }

  /** 当前异步链是否已在某实体 Actor 内（供 getPlayerData/savePlayer 判断是否走缓存） */
  currentActorKey(): string | undefined {
    return this.als.getStore();
  }

  private policyOf(type: EntityType): PersistPolicy {
    return this.types.get(type)?.persist ?? 'writeThrough';
  }

  /** 仅查看（不激活）：实体 Actor 已在内存中则返回其状态，否则 undefined */
  peek<S = any>(type: EntityType, id: EntityId): S | undefined {
    const cell = this.cells.get(actorKey(type, id));
    return cell && cell.state !== undefined ? (cell.state as S) : undefined;
  }

  /** 标脏当前 Actor（savePlayer 等写入路径在 Actor 内调用，提示需要落库） */
  markDirty(): void {
    const key = this.als.getStore();
    if (!key) return;
    const cell = this.cells.get(key);
    if (cell) cell.dirty = true;
  }

  /**
   * 在实体 Actor 内串行执行 mutator，持有内存态。
   * fn 收到当前内存态（激活时由 load 载入），可直接修改；修改后应调用 markDirty()
   * （或由 save 路径隐式标脏）。按策略在写后/周期落库。
   */
  async run<S = any, R = any>(
    type: EntityType,
    id: EntityId,
    fn: (state: S) => Promise<R>,
  ): Promise<R> {
    const config = this.types.get(type);
    if (!config) throw new Error(`未注册的 Actor 类型: ${type}`);
    const key = actorKey(type, id);

    // 可重入：已在该实体 Actor 内（如跨实体协调者嵌套），直接执行，避免自死锁
    if (this.als.getStore() === key) {
      const cell = this.cells.get(key)!;
      cell.lastUsed = Date.now();
      return fn(cell.state as S);
    }

    const cell = this.ensureCell(key, type, id);
    // 串行：把本次任务挂到该实体邮箱链尾，等前一个完成再执行
    const prev = cell.mailbox;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    cell.mailbox = prev.then(() => undefined, () => undefined).then(() => gate);
    try {
      await prev.then(() => undefined, () => undefined);
      return await this.als.run(key, () => this.withActivated(cell, config, fn));
    } finally {
      release();
      this.evictIfNeeded();
    }
  }

  /** 消息式：发消息不取返回值（tell） */
  async tell(type: EntityType, id: EntityId, handler: (state: any) => Promise<void> | void): Promise<void> {
    await this.run(type, id, async (state) => {
      await handler(state);
    });
  }

  /** 消息式：发消息并返回结果（ask） */
  async ask<R = any>(type: EntityType, id: EntityId, handler: (state: any) => Promise<R> | R): Promise<R> {
    return this.run<R, R>(type, id, async (state) => handler(state));
  }

  /** 停用并落库（若脏）指定 Actor，从内存移除 */
  async deactivate(type: EntityType, id: EntityId): Promise<void> {
    const key = actorKey(type, id);
    const cell = this.cells.get(key);
    if (!cell) return;
    if (cell.dirty && cell.state !== undefined) {
      const config = this.types.get(type)!;
      await config.save(cell.id, cell.state);
      cell.dirty = false;
    }
    this.cells.delete(key);
  }

  /** 落库所有脏 cell（进程退出/手动刷盘用） */
  async flushAll(): Promise<void> {
    for (const cell of this.cells.values()) {
      if (cell.dirty && cell.state !== undefined) {
        const config = this.types.get(cell.type)!;
        try {
          await config.save(cell.id, cell.state);
        } catch (e) {
          this.logger.error(`flushAll 落库失败 ${cell.key}: ${String(e)}`);
        }
        cell.dirty = false;
      }
    }
  }

  /** 周期落库：把空闲超过 idleEvictMs 的脏 cell 落库并驱逐 */
  private async flushIdle(): Promise<void> {
    const now = Date.now();
    for (const [key, cell] of this.cells) {
      if (!cell.dirty || cell.state === undefined) continue;
      if (now - cell.lastUsed >= this.idleEvictMs) {
        const config = this.types.get(cell.type)!;
        try {
          await config.save(cell.id, cell.state);
          cell.dirty = false;
        } catch (e) {
          this.logger.error(`flushIdle 落库失败 ${key}: ${String(e)}`);
          continue;
        }
        this.cells.delete(key);
      }
    }
  }

  private ensureCell(key: string, type: EntityType, id: EntityId): ActorCell {
    let cell = this.cells.get(key);
    if (!cell) {
      cell = {
        key,
        type,
        id,
        state: undefined,
        dirty: false,
        activating: null,
        mailbox: Promise.resolve(),
        lastUsed: Date.now(),
      };
      this.cells.set(key, cell);
    }
    return cell;
  }

  private async withActivated<S, R>(
    cell: ActorCell<S>,
    config: ActorTypeConfig<S>,
    fn: (state: S) => Promise<R>,
  ): Promise<R> {
    if (cell.state === undefined) {
      if (!cell.activating) {
        cell.activating = (async () => {
          cell.state = await config.load(cell.id);
        })();
      }
      await cell.activating;
      cell.activating = null;
    }
    cell.lastUsed = Date.now();
    const result = await fn(cell.state as S);
    // run 是「单一写入口」：邮箱内的写操作执行后按策略落库。
    // - writeThrough：每次写后立刻落库（等价于原 savePlayer 行为，最安全）
    // - deferred：仅标脏，交给周期落库 / 停用 / LRU 驱逐统一落库（真正的异步批量）
    // 这里统一在 fn 之后按策略处理，调用方无需自行标脏也能保证持久化。
    const policy = this.policyOf(cell.type);
    if (cell.state !== undefined) {
      if (policy === 'writeThrough') {
        await config.save(cell.id, cell.state);
        cell.dirty = false;
      } else {
        cell.dirty = true;
      }
    }
    return result;
  }

  /** 超过容量上限时，按 LRU 驱逐最久未用且已落库的 cell（脏 cell 先落库） */
  private evictIfNeeded(): void {
    if (this.cells.size <= this.lruMax) return;
    // 收集可驱逐候选（按 lastUsed 升序）
    const candidates = [...this.cells.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    let over = this.cells.size - this.lruMax;
    for (const cell of candidates) {
      if (over <= 0) break;
      if (cell.dirty && cell.state !== undefined) {
        // 先落库再驱逐，避免丢数据
        const config = this.types.get(cell.type)!;
        config
          .save(cell.id, cell.state)
          .then(() => {
            cell.dirty = false;
            this.cells.delete(cell.key);
          })
          .catch((e) => this.logger.error(`LRU 落库失败 ${cell.key}: ${String(e)}`));
      } else {
        this.cells.delete(cell.key);
      }
      over--;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flushAll();
  }
}
