/**
 * 持久化延时任务服务
 *
 * 统一承载「N 秒/分钟后结算一次」且**必须跨进程重启存活**的游戏延时：
 * 采集结算 / 移动到达 / 救援完成 / 装填完成 / 副本关闭。
 * 替代旧架构「内存 setTimeout + 每个玩法各写一个周期扫描兜底」的双轨制——
 * 旧架构下定时器随进程死亡丢失，扫描器从玩家 markers 反推任务，催生了
 * 指纹去重、防重入熔断等一系列补丁（见 delayed-settle-dedupe.spec 的历史）。
 *
 * 语义：
 * - 任务落库即持久：schedule 写 DelayedTask 行，进程重启后由周期 tick 分发，
 *   不存在「重启丢定时器」；玩家侧的「采集中」「移动中」等标记仍是行动门禁
 *   与结算认领（claim）的权威状态，本表只负责「何时唤醒结算」。
 * - 同 (type, userId, dedupeKey) 只保留一条：schedule 先删后插，天然实现
 *   「重排/取消」，无需单独的 cancel 调用点也正确。
 * - 分发即认领：tick 逐行 `deleteMany({ id, runAt <= now })` 抢占，抢到才执行，
 *   多实例/重叠 tick 不会双结算。
 * - 失败重试：handler 抛错时按 +30s 重排（最多 3 次），耗尽后丢弃并告警。
 *   结算 handler 自身都基于标记认领（幂等），重试安全。
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** 内置任务类型；新玩法延时请在此扩展并在业务侧 registerHandler。 */
export type DelayedTaskType =
  | 'gather'        // 采集延时结算（结算参数在玩家 markers['采集中']）
  | 'move'          // 移动延时到达（payload: targetMapId/targetName）
  | 'rescue'        // 救援完成（payload: markers2 里的救援标记，含 token）
  | 'reload'        // 装填完成（payload: mode = plana | organ）
  | 'dungeonClose'; // 副本通关关闭（payload: group，dedupeKey=地图组名）

export interface DelayedTaskScheduleInput {
  type: DelayedTaskType;
  /** 关联玩家；地图级任务（如副本关闭）可空 */
  userId?: number | null;
  /** 同类型去重键；缺省用 userId 字符串 */
  dedupeKey?: string | null;
  /** 到期时间（Date 或毫秒时间戳） */
  runAt: Date | number;
  payload?: Record<string, any>;
}

export interface DelayedTaskRow {
  id: number;
  type: string;
  userId: number | null;
  dedupeKey: string | null;
  payload: string;
  runAt: Date;
}

export type DelayedTaskHandler = (task: {
  id: number;
  type: DelayedTaskType;
  userId: number | null;
  dedupeKey: string | null;
  payload: Record<string, any>;
}) => Promise<void>;

/** handler 失败后的重试参数 */
const RETRY_DELAY_MS = 30 * 1000;
const MAX_ATTEMPTS = 3;
/** 分发扫描周期：广播/结算最多滞后该时长 */
const TICK_INTERVAL_MS = 1000;
/** 单次 tick 最多认领的任务数（防止重启后积压一次性全量执行挤爆邮箱） */
const BATCH_SIZE = 30;

@Injectable()
export class DelayedTaskService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DelayedTaskService.name);

  private readonly handlers = new Map<string, DelayedTaskHandler>();
  private tickTimer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private totalDispatched = 0;
  private totalFailed = 0;
  /** 已告警过「无 handler」的类型（每类型只告警一次，防刷屏） */
  private readonly warnedTypes = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    // 已有同类型注册（测试里重复初始化）则跳过
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      void this.tick().catch((e) => this.logger.error(`延时任务分发失败: ${e?.message || e}`));
    }, TICK_INTERVAL_MS);
    if (typeof (this.tickTimer as any).unref === 'function') this.tickTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
  }

  /** 注册某类型的结算 handler（由各业务服务在 onModuleInit 时登记）。 */
  registerHandler(type: DelayedTaskType, handler: DelayedTaskHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * 排程一个延时任务。同 (type, userId, dedupeKey) 先删后插：
   * 重复排程即重排，业务无需先显式取消。
   */
  async schedule(input: DelayedTaskScheduleInput): Promise<void> {
    const runAt = input.runAt instanceof Date ? input.runAt : new Date(input.runAt);
    const userId = input.userId == null ? null : Number(input.userId);
    const dedupeKey = input.dedupeKey == null
      ? (userId == null ? null : String(userId))
      : String(input.dedupeKey);
    const where: any = { type: input.type };
    if (userId != null) where.userId = userId;
    if (dedupeKey != null) where.dedupeKey = dedupeKey;
    // 先删后插（非事务即可：多出的旧行被 claim 后幂等 handler 兜底；当前单进程无并发排程方）
    await this.prisma.delayedTask.deleteMany({ where });
    await this.prisma.delayedTask.create({
      data: {
        type: input.type,
        userId,
        dedupeKey,
        payload: JSON.stringify(input.payload ?? {}),
        runAt,
      },
    });
  }

  /** 取消某（类）任务（未到期的排程行；不抛错，行不存在即无事发生）。 */
  async cancel(type: DelayedTaskType, userId?: number | null, dedupeKey?: string | null): Promise<void> {
    const where: any = { type };
    if (userId != null) where.userId = Number(userId);
    if (dedupeKey != null) where.dedupeKey = String(dedupeKey);
    await this.prisma.delayedTask.deleteMany({ where });
  }

  /**
   * 分发一轮到期任务：逐行 deleteMany 认领（runAt 条件防认领到重排后的新行），
   * 抢到才执行。周期由 onModuleInit 的 interval 驱动；也可被测试直接调用。
   * @returns 本轮实际分发的任务数
   */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const now = new Date();
      const due = await this.prisma.delayedTask.findMany({
        where: { runAt: { lte: now } },
        orderBy: { runAt: 'asc' },
        take: BATCH_SIZE,
      });
      let dispatched = 0;
      for (const row of due) {
        // 无 handler 的类型暂不认领（留在表里），等业务 onModuleInit 注册后再分发，
        // 避免「tick 先于 handler 注册」的启动时序竞争把任务行白白丢掉。
        if (!this.handlers.has(row.type)) {
          if (!this.warnedTypes.has(row.type)) {
            this.warnedTypes.add(row.type);
            this.logger.warn(`延时任务类型 ${row.type} 尚无已注册 handler，任务行暂留待处理`);
          }
          continue;
        }
        // 认领：删除成功（count=1）才执行；被并发 tick 抢走（count=0）则跳过
        const claimed = await this.prisma.delayedTask.deleteMany({
          where: { id: row.id, runAt: { lte: now } },
        });
        if (claimed.count === 0) continue;
        dispatched += 1;
        await this.dispatch(row);
      }
      this.totalDispatched += dispatched;
      return dispatched;
    } finally {
      this.ticking = false;
    }
  }

  /** 执行单个已认领任务；失败按 +30s 重排（最多 MAX_ATTEMPTS 次）。 */
  private async dispatch(row: {
    id: number;
    type: string;
    userId: number | null;
    dedupeKey: string | null;
    payload: string;
    runAt: Date;
  }): Promise<void> {
    const handler = this.handlers.get(row.type);
    let payload: Record<string, any> = {};
    try {
      payload = row.payload ? JSON.parse(row.payload) : {};
    } catch { /* 空载荷兜底 */ }

    if (!handler) {
      this.logger.error(`延时任务 ${row.type}(id=${row.id}) 无已注册 handler，丢弃。payload=${row.payload}`);
      return;
    }
    try {
      await handler({
        id: row.id,
        type: row.type as DelayedTaskType,
        userId: row.userId == null ? null : Number(row.userId),
        dedupeKey: row.dedupeKey,
        payload,
      });
    } catch (e: any) {
      this.totalFailed += 1;
      const attempts = Number(payload?.attempts ?? 0) + 1;
      if (attempts < MAX_ATTEMPTS) {
        await this.schedule({
          type: row.type as DelayedTaskType,
          userId: row.userId,
          dedupeKey: row.dedupeKey,
          runAt: new Date(Date.now() + RETRY_DELAY_MS),
          payload: { ...payload, attempts },
        });
        this.logger.warn(
          `延时任务 ${row.type}(id=${row.id}) 执行失败（第 ${attempts} 次），+${RETRY_DELAY_MS / 1000}s 重试: ${e?.message || e}`,
        );
      } else {
        this.logger.error(
          `延时任务 ${row.type}(id=${row.id}) 连续 ${attempts} 次失败，已丢弃: ${e?.message || e}`,
        );
      }
    }
  }

  /** 运维观测快照（GM 后台/压测用）。 */
  stats(): { dispatched: number; failed: number; handlers: string[] } {
    return {
      dispatched: this.totalDispatched,
      failed: this.totalFailed,
      handlers: [...this.handlers.keys()],
    };
  }
}
