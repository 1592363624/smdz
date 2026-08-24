/**
 * 游戏数据变更总线
 * 「数据→UI 自动同步」机制的事件源头：任何游戏实体写入后由此广播"某实体脏了"，
 * 由 SyncProjector 订阅并推导受影响用户、触发防抖推送。
 *
 * 设计约定：
 * - 事件只携带归属信息（谁变了），不携带数据载荷；投影时重新读库取最新值，
 *   因此同一实体短时间多次变更天然可合并，也避免 BigInt/大 JSON 进入事件层。
 * - listener 抛错只记日志，绝不影响其他 listener 与业务主流程（同步是副作用）。
 */

import { Injectable, Logger } from '@nestjs/common';

/** 玩家档案变更事件：userId 为玩家所属用户 */
export interface PlayerChangeEvent {
  entity: 'player';
  userId: number;
  /** 写入来源标识（savePlayer/prisma拦截器/cron等），用于调试与静默过滤 */
  writer?: string;
}

/** 地图怪物变更事件：影响范围为该地图全部在线玩家（跨玩家视野同步） */
export interface MonsterChangeEvent {
  entity: 'monster';
  monsterId: number;
  mapId: number;
  writer?: string;
}

export type ChangeEvent = PlayerChangeEvent | MonsterChangeEvent;

/** 事件监听器签名；允许异步但总线不等待 */
export type ChangeListener = (e: ChangeEvent) => void;

@Injectable()
export class ChangeBusService {
  private readonly logger = new Logger(ChangeBusService.name);
  private readonly listeners = new Set<ChangeListener>();

  /**
   * 广播一条变更事件（进程内、同步分发、不等待异步结果）
   * 业务代码唯一需要调用的 API：声明"某实体变了"，其余交给投影器。
   */
  emit(e: ChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(e);
      } catch (err: any) {
        // 同步是旁路能力：单个订阅方异常不能拖垮业务写入
        this.logger.warn(`ChangeBus 监听器处理失败: ${err?.message}`);
      }
    }
  }

  /** 注册监听器，返回退订函数（供 onApplicationShutdown 清理） */
  on(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 测试辅助：当前监听器数量 */
  listenerCount(): number {
    return this.listeners.size;
  }
}
