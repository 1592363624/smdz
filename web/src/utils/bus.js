/**
 * 全局轻量指令总线（无依赖）
 *
 * 只解决一件事：手机端 HUD / 底部标签栏 / 「我的」面板现在是 App 级常驻组件，
 * 而「发一条指令」「打开设置弹窗」这两条链路的实现只在 ChatView 里（socket、本地回显、
 * 滚动到底、表单与接口全在那）。与其把它们提到 App 级重写一遍，不如让 ChatView
 * 继续当唯一的订阅者，其它地方只负责投递。
 * ChatView 被 keep-alive 常驻后订阅者一直活着；万一还没挂载（冷启动直达 /home），
 * 投递先进队列，挂载后一次性冲刷 —— 所以调用方不需要关心对方在不在。
 */

let cmdHandler = null;
const pending = [];

/** 界面动作的当前订阅者（ChatView 挂载后注册）与待办队列 */
let actionHandler = null;
const pendingActs = [];

/** ChatView 挂载时调用；返回取消订阅函数。注册时会顺带冲刷积压指令。 */
export function subscribeCommands(handler) {
  cmdHandler = handler;
  if (pending.length) {
    const queued = pending.splice(0, pending.length);
    queued.forEach((t) => {
      try {
        handler(t);
      } catch {
        /* 单条投递失败不影响后续 */
      }
    });
  }
  return () => {
    if (cmdHandler === handler) cmdHandler = null;
  };
}

/** 是否已有能处理指令的页面在挂着（决定要不要先跳回 /chat） */
export function hasCommandHandler() {
  return !!cmdHandler;
}

/**
 * 投递一条指令。
 * @param {string} text 发送内容
 * @returns {boolean} true = 已交给在线的 ChatView；false = 已入队，调用方需把玩家带到 /chat 触发冲刷
 */
export function sendCommand(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (cmdHandler) {
    cmdHandler(t);
    return true;
  }
  pending.push(t);
  return false;
}

/**
 * 请求 ChatView 代执行一个界面动作（设置弹窗 / 更新记录弹窗）。
 * 这些弹窗的表单与接口都在 ChatView 里，抄一份到 App 级面板必然双份漂移，
 * 所以由面板发请求、公屏页执行。ChatView 可能还没挂载（冷启动直达 /home 再点设置），
 * 因此与指令投递同一套「无订阅者则入队」的语义，挂载后自动补执行。
 * @param {'settings'|'updatelog'} name
 */
export function requestChatAction(name) {
  if (!name) return;
  if (actionHandler) {
    actionHandler(name);
    return;
  }
  pendingActs.push(name);
}

/** ChatView 挂载时注册界面动作处理器；返回取消函数，注册瞬间冲刷待办 */
export function onChatAction(handler) {
  actionHandler = handler;
  if (pendingActs.length) {
    const queued = pendingActs.splice(0, pendingActs.length);
    queued.forEach((n) => {
      try {
        handler(n);
      } catch {
        /* 单个动作失败不影响后续 */
      }
    });
  }
  return () => {
    if (actionHandler === handler) actionHandler = null;
  };
}
