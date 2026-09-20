/**
 * 服务器时钟对齐：所有「服务器时刻 + 本地逐秒倒数」类倒计时（延时操作进度条 endAt、增益 expireAt）
 * 都拿本机时钟与服务器时间戳相减，本机漂移几秒倒计时就整体偏移几秒
 * （症状即「指令刚发，进度条已经少了几秒」）。
 * 页面加载 / socket 重连时向 /system/server-time 取一次服务器毫秒时间，
 * 按「服务器时间 − (发出请求时的本机时间 + 往返耗时/2)」测算偏移量，
 * 之后 serverNow() = 本机时钟 + 偏移量。误差上限约为往返耗时的一半，正常环境 <100ms。
 */
import { systemApi } from '../api';

/** 本机时钟需加上的偏移量（毫秒）。未同步时为 0，即退化为原始本机时钟。 */
let offsetMs = 0;

/** 同步进行中标志：避免挂载与重连同时触发时重复请求 */
let syncing = null;

/**
 * 向服务器测量一次时钟偏移；失败时静默保留上次偏移量，倒计时退回本机时钟。
 * @returns 本次测得的偏移量（毫秒，正值表示本机时钟快于服务器）
 */
export function syncServerClock() {
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      const start = Date.now();
      const res = await systemApi.getServerTime();
      const rtt = Date.now() - start;
      const serverNow = Number(res?.data?.serverNow || 0);
      if (serverNow > 0) {
        offsetMs = serverNow - (start + rtt / 2);
      }
    } catch {
      // 保留旧偏移
    } finally {
      syncing = null;
    }
    return offsetMs;
  })();
  return syncing;
}

/** 与服务器对齐后的"现在"（毫秒时间戳）。所有与服务器时刻相减的场景都用它取当前时间。 */
export function serverNow() {
  return Date.now() + offsetMs;
}
