/**
 * 写操作静默上下文（AsyncLocalStorage）
 * 定时任务类批量写（在线时长统计、自动保存等）在 silent 上下文中执行，
 * Prisma 拦截器据此跳过变更事件，避免每分钟数百条无 UI 价值的事件风暴。
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface WriteContext {
  /** 为真时拦截器不发事件 */
  silent?: boolean;
  /** 写入来源标识（cron/autoSave 等），随事件透出便于排查 */
  writer?: string;
}

export const writeContext = new AsyncLocalStorage<WriteContext>();

/**
 * 在指定上下文中执行回调
 * @example
 * await runSilent('cron', () => this.prisma.player.updateMany(...))
 */
export function runSilent<T>(writer: string, fn: () => Promise<T>): Promise<T> {
  return writeContext.run({ silent: true, writer }, fn);
}
