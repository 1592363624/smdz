/**
 * 玩家 mutate 上下文登记处（无业务依赖）
 *
 * 存在的唯一理由：**打破循环依赖**。
 *
 * `PlayerService`（读档/保存/加经验等基础能力）需要知道「当前异步链是不是已经
 * 在某个玩家的 mutate 里」，以便在被 mutate 包住时复用同一份快照、不再自己读档
 * 与保存。但 `PlayerMutateService` 又依赖 `PlayerService`，两边直接互相注入会成环。
 *
 * 因此把「上下文存取」抽成这个不依赖任何业务的服务，两边都注入它即可。
 *
 * 用 AsyncLocalStorage 而非普通字段：它会贯穿整条 async 链（await 之后依然可读），
 * 且天然按请求隔离，不会在并发请求之间互相污染。
 */

import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

/** 最小结构约定：mutate 上下文至少要有 player，其余为 PlayerData 的解析字段。 */
export interface MutateContextLike {
  player: any;
  [key: string]: any;
}

@Injectable()
export class PlayerMutateContextService {
  /** userId → 该玩家在本条异步链上的 mutate 上下文 */
  private readonly storage = new AsyncLocalStorage<Map<number, MutateContextLike>>();

  /**
   * 在本条异步链上登记某玩家的 mutate 上下文，并在该上下文内执行 fn。
   * 用「拷贝一份新 Map」而非就地修改，避免兄弟分支互相污染。
   */
  run<T>(userId: number, ctx: MutateContextLike, fn: () => Promise<T> | T): Promise<T> | T {
    const next = new Map(this.storage.getStore() ?? []);
    next.set(Number(userId), ctx);
    // 同时按玩家主键 id 登记：savePlayer 收到的对象常只有 .id（无 .userId），
    // 合并回上下文时需能按 .id 反查。统一收口在 run 作用域结束后才触发，届时
    // ALS 已还原，不会误判为「仍在 mutate 内」。
    const pid = ctx.player?.id;
    if (pid !== undefined && pid !== null) next.set(Number(pid), ctx);
    return this.storage.run(next, fn);
  }

  /**
   * 取本条异步链上指定玩家的 mutate 上下文；不在 mutate 内时返回 null。
   *
   * 调用方（如 PlayerService.addExp）据此决定：有 ctx 就直接改它并返回（不读档、
   * 不保存，交给最外层收口）；没有则走原有的「自己读档 → 改 → 自己保存」路径。
   * 这让 mutate 化可以**局部渐进推进**，而不必一次性改造整条调用链。
   */
  currentFor(userId: number): MutateContextLike | null {
    return this.storage.getStore()?.get(Number(userId)) ?? null;
  }

  /** 本条异步链是否已在某玩家的 mutate 上下文内。 */
  has(userId?: number): boolean {
    const store = this.storage.getStore();
    if (!store) return false;
    return userId === undefined ? store.size > 0 : store.has(Number(userId));
  }

  /** 本条异步链上正在 mutate 的所有 userId（诊断用）。 */
  activeUserIds(): number[] {
    return [...(this.storage.getStore()?.keys() ?? [])];
  }
}
