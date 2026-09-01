/**
 * 玩家写入口收口（P2 增强）+ 货币审计（P4）
 *
 * ## 设计定位：Actor 模型的轻量实现
 *
 * 玩家是状态的唯一归属者。所有对玩家数据的修改都必须通过 `mutate(userId, fn)`，
 * 由本服务保证三件事：
 *
 * 1. **串行**：全程持 `PlayerService.enqueueUserWrite` 用户级锁，与战斗、后台结算、
 *    其它指令天然互斥，不需要调用方记得加锁。
 * 2. **单一快照**：一条业务链只读取一份快照，嵌套调用复用它（见 currentContext）。
 *    这是本项目并发正确性的基石——历史上反复出现的「旧快照整包覆盖」事故，
 *    根因都是子流程自行重新读档并落库，导致上层快照瞬间过期。
 * 3. **统一落库**：只有最外层负责保存与审计，内层改动自动被收口。
 *
 * ## 为什么嵌套必须复用而不是重读
 *
 * 若 `fn` 内部再调 `mutate(同一玩家)` 时重新读档，就会同时存在两份快照：
 * 内层保存推进版本号后，外层那份随即过期，外层的下一次保存必然被 CAS 拒绝
 * （表现为玩家看到「玩家数据并发冲突，请重试」）；若侥幸写入，则会用旧数据
 * 整包覆盖内层刚落库的结果。复用同一份 ctx 后，两类问题同时消失。
 *
 * ## 使用约定
 *
 * - 业务代码**不要**自己调 `getPlayerData` / `savePlayer`，改用本服务的
 *   `mutate`（写）或 `read`（只读）。
 * - 子流程接收 `ctx` 参数透传，不要以 `userId` 重新读档。
 * - 需要跨玩家写入时（如 A 攻击 B），**不要**在 A 的 mutate 内嵌套 B 的 mutate
 *   （会形成嵌套锁，A→B 与 B→A 并发时死锁）。应把 B 的变更移到 A 的 mutate 之外，
 *   或走独立的定向写入通道。
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerData, PlayerService } from './player.service';
import { PlayerMutateContextService } from './player-mutate-context.service';

/** 参与审计的货币列 → 中文名 */
const CURRENCY_COLUMNS: Array<{ column: 'diamonds' | 'tickets' | 'dataCores'; label: string }> = [
  { column: 'diamonds', label: '钻石' },
  { column: 'tickets', label: '召唤券' },
  { column: 'dataCores', label: '数据核心' },
];

export interface MutateContext extends PlayerData {
  /** 声明本次修改涉及货币变动的原因（用于审计日志备注位，可选） */
  auditReason?: string;
}

@Injectable()
export class PlayerMutateService {
  private readonly logger = new Logger(PlayerMutateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    /**
     * 上下文登记处（独立服务，无业务依赖）。
     *
     * 抽出去的原因：PlayerService 也需要读「当前链是否在同一玩家的 mutate 内」
     * （见 PlayerService.addExp），而 PlayerMutateService 又依赖 PlayerService，
     * 直接互注会成环。两边都只依赖这个无依赖的中立服务即可。
     */
    private readonly mutateContext: PlayerMutateContextService,
  ) {}

  /**
   * 玩家状态变更的唯一推荐入口：在锁内读一次新鲜快照，执行变更，统一落库。
   *
   * 嵌套调用（同一 userId）复用外层 ctx，不重复读档、不重复落库、不重复审计，
   * 全交给最外层收口。
   *
   * @param userId 用户ID
   * @param fn 变更逻辑；通过 ctx.player / ctx.backpack 等直接修改，返回值透传
   */
  async mutate<T>(userId: number, fn: (ctx: MutateContext) => Promise<T> | T): Promise<T> {
    const active = this.mutateContext.currentFor(userId);
    if (active) {
      return await fn(active as MutateContext);
    }

    return this.playerService.enqueueUserWrite(userId, async () => {
    const ctx = (await this.playerService.getPlayerData(userId)) as MutateContext;
    const before = this.readCurrencies(ctx.player);
    // 记录整份 ctx 字段签名，用于"纯改 ctx 但未显式 savePlayer"场景的落库判定
    const sig0 = this.fieldSignature(ctx);

    // fn 抛异常时不会走到保存，锁照常释放，业务可安全向上冒泡错误
    try {
      const result = await this.mutateContext.run(userId, ctx, () => fn(ctx));

      // 落库判定（彻底根治只读指令自增 version）：
      // 1) 任意嵌套 savePlayer 被调用 → __mutateDirty 已被置位（最快路径）；
      // 2) 否则比对字段签名：只要本链改过 ctx（哪怕没显式 savePlayer，如光翼/采集开始
      //    这种"纯改 ctx"写法），签名就会变化 → 仍需落库。两者任一命中才写，
      //    纯只读指令签名不变 → 跳过 CAS，不无故让并发写者被判并发冲突。
      // 注意：行 JSON 字段（player.backpack 等）是读写都透传到顶层权威表示的
      // accessor（见 PlayerService.installCanonicalAccessors），顶层与行不再可能
      // 分叉，落库前无需任何「按侧回写」的同步步骤。
      const needSave = (ctx as any).__mutateDirty || this.fieldSignature(ctx) !== sig0;
      if (needSave) {
        await this.playerService.savePlayer(ctx.player);

        const after = this.readCurrencies(ctx.player);
        this.auditCurrencyChanges(Number(userId), before, after, (ctx as any).auditReason);
      }
      return result;
    } finally {
      // 收口：本上下文自此作废（无论成功/抛错）。fn 内调度的定时器（如采集 10~16s
      // 延时结算）会带着本 ALS 快照逃逸出去，若不置为已结束，回调里的 savePlayer 会
      // 误把改动"合并"进这个死上下文并跳过 Actor markDirty，导致结算静默丢失
      // （医疗箱/休眠仓每人一次永久标记被抹掉、资源可无限重复采集的反复复发根因）。
      this.mutateContext.finish(ctx);
    }
  });
  }

  /**
   * 只读变体：在锁内读快照供查询/判定，不落库、不审计。
   * 适用于「需要一份一致的玩家视图」但不修改的展示与校验路径。
   */
  async read<T>(userId: number, fn: (ctx: MutateContext) => Promise<T> | T): Promise<T> {
    const active = this.mutateContext.currentFor(userId);
    if (active) {
      return await fn(active as MutateContext);
    }

    return this.playerService.enqueueUserWrite(userId, async () => {
      const ctx = (await this.playerService.getPlayerData(userId)) as MutateContext;
      try {
        return await this.mutateContext.run(userId, ctx, () => fn(ctx));
      } finally {
        // 只读上下文同样会随 ALS 逃逸进定时器回调，收口后立即作废（见 mutate 内注释）
        this.mutateContext.finish(ctx);
      }
    });
  }

  /** 当前调用链是否已在某玩家的 mutate/read 上下文内。 */
  isInMutate(userId?: number): boolean {
    return this.mutateContext.has(userId);
  }

  /**
   * 入口在 mutate 内修改了 ctx 但未显式调用 savePlayer 时，声明本次链路需要落库。
   * 例：绝灭天使·光翼 / 采集开始 这类"改 ctx 但不自己 savePlayer"的读改写段。
   * 基础设施已保证 mutate 内任意 savePlayer 自动标记，此处只覆盖"纯改 ctx"的写法。
   */
  markDirty(userId: number): void {
    const ctx = this.mutateContext.currentFor(userId);
    if (ctx) (ctx as any).__mutateDirty = true;
  }

  /** 当前链上指定玩家的 mutate 上下文；不在 mutate/read 内时返回 null。 */
  currentFor(userId: number): MutateContext | null {
    return (this.mutateContext.currentFor(userId) as MutateContext | null) ?? null;
  }

  private readCurrencies(player: any): Record<string, number> {
    const out: Record<string, number> = {};
    for (const { column } of CURRENCY_COLUMNS) {
      out[column] = Number(player?.[column] ?? 0);
    }
    return out;
  }

  /** 对比前后余额，差异非零的货币各记一条审计日志。失败仅告警。 */
  private auditCurrencyChanges(
    userId: number,
    before: Record<string, number>,
    after: Record<string, number>,
    reason?: string,
  ): void {
    try {
      for (const { column, label } of CURRENCY_COLUMNS) {
        const delta = Number((after[column] - before[column]).toFixed(6));
        if (!Number.isFinite(delta) || delta === 0) continue;
        void this.prisma.currencyLog
          .create({
            data: {
              userId,
              currency: label,
              delta,
              balanceAfter: after[column],
            },
          })
          .catch((err: any) =>
            this.logger.warn(`货币审计写入失败 userId=${userId} ${label}: ${err?.message || err}`),
          );
      }
    } catch (err: any) {
      // 审计是旁路：任何异常不得影响业务结果
      this.logger.warn(`货币审计异常 userId=${userId}: ${err?.message || err}`);
    }
  }

  /**
   * 整份 ctx 的字段签名：用于判定"本链是否改过 ctx 但没显式 savePlayer"。
   * 覆盖 player 上的标量/JSON 字段以及解析后的集合字段（backpack/markers/...），
   * 任意一侧被改签名都会变化，从而让外层统一落库——无需调用方记得 markDirty。
   * 排除运行时副作用字段（__mutateDirty / auditReason / 货币物化基准）。
   */
  private fieldSignature(ctx: any): string {
    const skip = new Set(['__mutateDirty', 'auditReason', '_currencyMirror']);
    const keys = Object.keys(ctx).filter((k) => !skip.has(k)).sort();
    let sig = '';
    for (const k of keys) {
      const v = ctx[k];
      // JSON.stringify 不识别 BigInt（会抛 "Do not know how to serialize a BigInt"），
      // 此处统一将 BigInt 转 Number 再序列化。player.lastOpTime/readTime/playTime 等
      // 字段在 game.service.ts 中会被直接赋值为 BigInt(now)，若不处理会直接炸。
      const safe = (v: any): any => {
        if (v == null) return v;
        if (typeof v === 'bigint') return Number(v);
        if (typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map(safe);
        const o: any = {};
        for (const kk of Object.keys(v)) o[kk] = safe((v as any)[kk]);
        return o;
      };
      sig += k + ':' + JSON.stringify(safe(v)) + ';';
    }
    return sig;
  }
}
