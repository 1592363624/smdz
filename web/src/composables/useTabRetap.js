/**
 * 「再点一次已选中的底部标签」订阅 helper。
 *
 * 手游与网页的一个细节差别：App 里再点当前标签不是没反应，而是「回到这页的开头」
 * （信息流回顶、聊天回最新）。底部标签栏在重复点击时派发 smdz:tab-retap，
 * 具体做什么由各页面自己定 —— 只有页面知道哪块才是它的滚动区。
 *
 * 用 onUnmounted（不是 onDeactivated）摘监听：配合 App.vue 的 keep-alive，
 * 页面被缓存时监听器仍在，但 detail.path 不匹配就不会误触发，后台页面抢不走滚动。
 */
import { getCurrentInstance, onUnmounted } from 'vue';

const EVENT = 'smdz:tab-retap';

/**
 * @param {string} path 只响应这个路由的重复点击
 * @param {Function} handler 命中时要做的动作
 * @returns {Function} 手动摘除监听的函数
 */
export function onTabRetap(path, handler) {
  const fn = (e) => {
    if (e?.detail?.path === path) handler();
  };
  window.addEventListener(EVENT, fn);
  // 组件内调用时自动随组件卸载摘掉；组件外调用则靠返回的句柄自行摘
  if (getCurrentInstance()) onUnmounted(() => window.removeEventListener(EVENT, fn));
  return () => window.removeEventListener(EVENT, fn);
}

/** 把选择器命中的滚动容器平滑滚回顶部；找不到就什么都不做 */
export function scrollTopWithin(selector) {
  const el = document.querySelector(selector);
  if (!el) return;
  if (typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior: 'smooth' });
  else el.scrollTop = 0;
}

export const TAB_RETAP_EVENT = EVENT;
