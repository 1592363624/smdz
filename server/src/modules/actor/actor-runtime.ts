import { Injectable, Logger, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import {
  ActorTypeConfig,
  EntityId,
  EntityType,
  actorKey,
  PersistPolicy,
} from './types';

/** ActorRuntime 的可选配置注入令牌（避免构造参数被 Nest 误当作待注入依赖） */
export const ACTOR_RUNTIME_OPTIONS = Symbol('ACTOR_RUNTIME_OPTIONS');

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
export class ActorMailboxOverflowError extends Error {
  constructor(key: string, depth: number) {
    super(`Actor 邮箱溢出: ${key} (积压=${depth})，请降低单实体写并发或扩容`);
    this.name = 'ActorMailboxOverflowError';
  }
}

interface ActorCell<S = any> {
  key: string;
  type: EntityType;
  id: EntityId;
  state: S | undefined;
  dirty: boolean;
  activating: Promise<void> | null;
  mailbox: Promise<unknown>;
  /** 当前在途任务数（背压用） */
  pending: number;
  lastUsed: number;
}

export interface ActorRuntimeOptions {
  /** 内存中最多保留多少个 Actor cell，超过后按 LRU 驱逐（先落库脏 cell） */
  lruMax?: number;
  /** 周期落库间隔（ms），0 关闭定时器 */
  flushIntervalMs?: number;
  /** 空闲多久（ms）的 cell（无论脏净）在周期落库时被驱逐回收 */
  idleEvictMs?: number;
  /** 单实体邮箱积压上限：超过则后续入队任务抛 ActorMailboxOverflowError（背压） */
  mailboxMaxDepth?: number;
  /** 协调者跨实体获取邮箱的超时（ms），0 = 不超时（防某个邮箱卡死连锁拖死） */
  coordinatorTimeoutMs?: number;
}

export interface ActorRuntimeStats {
  cells: number;
  byType: Record<string, number>;
  pending: number;
  totalPersists: number;
  totalEvictions: number;
  totalErrors: number;
  totalOverflow: number;
  mailboxDepthMax: number;
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
  private readonly mailboxMaxDepth: number;
  /** 跨实体协调者获取邮箱的超时（ms），0 = 不超时。对外只读，供 coordinator 使用。 */
  readonly coordinatorTimeoutMs: number;
  private readonly logger = new Logger(ActorRuntime.name);

  // 可观测性计数
  private totalPersists = 0;
  private totalEvictions = 0;
  private totalErrors = 0;
  private totalOverflow = 0;
  private mailboxDepthMax = 0;

  constructor(
    @Optional() @Inject(ACTOR_RUNTIME_OPTIONS) opts: ActorRuntimeOptions = {},
  ) {
    this.lruMax = opts.lruMax ?? 2000;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.idleEvictMs = opts.idleEvictMs ?? 30_000;
    this.mailboxMaxDepth = opts.mailboxMaxDepth ?? 1000;
    this.coordinatorTimeoutMs = opts.coordinatorTimeoutMs ?? 0;
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

  /**
   * 只读查看（不激活）：实体 Actor 已在内存中则返回其「浅冻结 + 深克隆」的快照，
   * 调用方随意改也不会污染内存态（正确性风险 #1 的根因）。未激活返回 undefined。
   * 深克隆用 structuredClone；若运行时引擎不支持则退化为 JSON 往返。
   */
  peek<S = any>(type: EntityType, id: EntityId): S | undefined {
    const cell = this.cells.get(actorKey(type, id));
    if (!cell || cell.state === undefined) return undefined;
    return clone(cell.state) as S;
  }

  /**
   * 活态查看（仅 Actor 内部消息处理用，如 getPlayerData/savePlayer 在邮箱内取自己的
   * 内存态直接改）。返回的是真实 cell.state 引用，修改会进入持久化路径——切勿在邮箱外调用。
   */
  peekLive<S = any>(type: EntityType, id: EntityId): S | undefined {
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

  /** 使某实体缓存失效（下次访问重新从存储载入）。
   *  供「不走 Actor 邮箱的直接写」（如大量现存 savePlayer 调用点）落库后调用，
   *  避免内存缓存陈旧、被后续 enqueueUserWrite 复用并覆盖本次落库结果。 */
  invalidate(type: EntityType, id: EntityId): void {
    const key = actorKey(type, id);
    const cell = this.cells.get(key);
    if (cell) this.cells.delete(key);
  }

  /**
   * 在实体 Actor 内串行执行 mutator，持有内存态。
   * fn 收到当前内存态（激活时由 load 载入），可直接修改；修改后应调用 markDirty()
   * （或由 save 路径隐式标脏）。run 在 fn 成功后按策略落库（writeThrough 仅当脏、
   * deferred 标脏留给后台）；fn 抛错则丢弃本次内存态、不落库（all-or-nothing）。
   */
  async run<S = any, R = any>(
    type: EntityType,
    id: EntityId,
    fn: (state: S) => Promise<R>,
  ): Promise<R> {
    const config = this.types.get(type);
    if (!config) throw new Error(`未注册的 Actor 类型: ${type}`);
    const key = actorKey(type, id);

    // 可重入：已在该实体 Actor 内（如跨实体协调者嵌套，或业务在 run 内再 enqueueUserWrite
    // 同一玩家），直接执行，避免自死锁。落库由最外层 run 负责。
    if (this.als.getStore() === key) {
      const cell = this.cells.get(key)!;
      cell.lastUsed = Date.now();
      return fn(cell.state as S);
    }

    const cell = this.ensureCell(key, type, id);
    // 背压：积压超过上限直接拒绝，避免 Promise 链无限增长拖垮进程
    if (this.mailboxMaxDepth > 0 && cell.pending >= this.mailboxMaxDepth) {
      this.totalOverflow++;
      throw new ActorMailboxOverflowError(key, cell.pending);
    }
    cell.pending++;
    if (cell.pending > this.mailboxDepthMax) this.mailboxDepthMax = cell.pending;

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
      cell.pending--;
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

  /** 停用并落库（若脏）指定 Actor，从内存移除。经邮箱排队，避免与在途 run 竞争。 */
  async deactivate(type: EntityType, id: EntityId): Promise<void> {
    const key = actorKey(type, id);
    const cell = this.cells.get(key);
    if (!cell) return;
    // 把「停用」也作为一条邮箱任务入队：等所有在途任务完成后才落库卸载，
    // 杜绝「deactivate 落库一半、在途 run 又写一次」的竞态。
    const prev = cell.mailbox;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    cell.mailbox = prev.then(() => undefined, () => undefined).then(() => gate);
    try {
      await prev.then(() => undefined, () => undefined);
      if (cell.dirty && cell.state !== undefined) {
        const config = this.types.get(type)!;
        await config.save(cell.id, cell.state);
        cell.dirty = false;
      }
    } finally {
      release();
    }
    // 仅当仍指向同一个 cell（期间没有被 re-run 重建）才删除
    if (this.cells.get(key) === cell) this.cells.delete(key);
  }

  /** 落库所有脏 cell（进程退出/手动刷盘用） */
  async flushAll(): Promise<void> {
    for (const cell of this.cells.values()) {
      if (cell.dirty && cell.state !== undefined) {
        const config = this.types.get(cell.type)!;
        try {
          await config.save(cell.id, cell.state);
          this.totalPersists++;
        } catch (e) {
          this.logger.error(`flushAll 落库失败 ${cell.key}: ${String(e)}`);
        }
        cell.dirty = false;
      }
    }
  }

  /**
   * 周期落库 + 空闲回收：把空闲超过 idleEvictMs 的 cell 落库（若脏）并驱逐。
   * 无论脏净都回收——干净空闲 cell 不再长期占用内存（健壮性缺口修复）。
   */
  private async flushIdle(): Promise<void> {
    const now = Date.now();
    for (const [key, cell] of this.cells) {
      if (cell.state === undefined) continue;
      if (now - cell.lastUsed >= this.idleEvictMs) {
        const config = this.types.get(cell.type)!;
        if (cell.dirty) {
          try {
            await config.save(cell.id, cell.state);
            this.totalPersists++;
            cell.dirty = false;
          } catch (e) {
            this.logger.error(`flushIdle 落库失败 ${key}: ${String(e)}`);
            continue; // 落库失败则保留在内存，下次再试
          }
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
        pending: 0,
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
    try {
      const result = await fn(cell.state as S);
      // run 是「单一写入口」：fn 成功后按策略落库。
      // - 仅当 dirty（fn 内或 save 路径调用过 markDirty）才落库：
      //   纯只读 run 不再白吞一次 DB 写（性能修复）。
      // - writeThrough：每次写后立刻落库（等价于原 savePlayer 行为，最安全）
      // - deferred：仅标脏，交给周期落库 / 停用 / LRU 驱逐统一落库（真正的异步批量）
      const policy = this.policyOf(cell.type);
      if (cell.state !== undefined && cell.dirty) {
        if (policy === 'writeThrough') {
          await config.save(cell.id, cell.state);
          this.totalPersists++;
          cell.dirty = false;
        }
        // deferred：保留 dirty，等后台刷盘
      }
      return result;
    } catch (e) {
      // all-or-nothing：fn 抛错则丢弃本次（可能半改的）内存态，强制下次 run 重新
      // 从库载入干净状态，避免半截改动被后续写落库污染 DB。
      cell.state = undefined;
      cell.dirty = false;
      cell.activating = null;
      this.totalErrors++;
      throw e;
    }
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
            if (this.cells.get(cell.key) === cell) this.cells.delete(cell.key);
          })
          .catch((e) => this.logger.error(`LRU 落库失败 ${cell.key}: ${String(e)}`));
        this.totalEvictions++;
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

  /** 运行时可观测性快照（运维/压测用） */
  stats(): ActorRuntimeStats {
    const byType: Record<string, number> = {};
    let pending = 0;
    for (const cell of this.cells.values()) {
      byType[cell.type] = (byType[cell.type] ?? 0) + 1;
      pending += cell.pending;
    }
    return {
      cells: this.cells.size,
      byType,
      pending,
      totalPersists: this.totalPersists,
      totalEvictions: this.totalEvictions,
      totalErrors: this.totalErrors,
      totalOverflow: this.totalOverflow,
      mailboxDepthMax: this.mailboxDepthMax,
    };
  }
}

/** 深克隆（只读 peek 用）：优先 structuredClone，退化到 JSON 往返。 */
function clone<T>(v: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(v);
    } catch {
      /* 含函数/BigInt 等不可克隆项时退化为 JSON */
    }
  }
  return JSON.parse(JSON.stringify(v)) as T;
}
