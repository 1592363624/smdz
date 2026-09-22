/**
 * UI 全局状态（Pinia）：跨组件共享的临时 UI 状态
 * toasts：轻提示队列（成功/错误/警告/信息，悬停暂停自动关闭）
 * paletteOpen：命令面板（Cmd/Ctrl+K）开关
 * hpVfxLevel：血量预警特效强度档位（simple/standard/strong，localStorage 持久化）
 */
import { defineStore } from 'pinia';

/** 血量预警特效档位（循环切换顺序） */
const HP_VFX_LEVELS = ['simple', 'standard', 'strong'];
const HP_VFX_LEVEL_KEY = 'smdz_hp_vfx_level';

/** 默认 toast 停留时长（ms） */
const TOAST_DEFAULT_TIMEOUT = 5000;

export const useUiStore = defineStore('ui', {
  state: () => ({
    /**
     * @type {Array<{
     *   id:number, type:string, title:string, message:string,
     *   timeout:number, remaining:number, _timer:number|null, _startedAt:number
     * }>}
     */
    toasts: [],
    /** 命令面板是否打开 */
    paletteOpen: false,
    /**
     * 手机端「我的」全屏面板是否打开。
     * 提到 store 是为了让底部标签栏在任意路由都能唤起它（公屏页之外的家园/前线/竞技场
     * 也想一眼看到角色状态），而不是只有 ChatView 内部的局部 ref。
     */
    meOpen: false,
    /**
     * 「我的」面板的 history 靶子状态。
     * _meEntry：我们压进去的那条同文档条目还在不在；_afterMeClosed：收面板后要接着做的事。
     */
    _meEntry: false,
    _afterMeClosed: null,
    /**
     * 血量预警特效档位。必须在此声明：cycleHpVfxLevel/setHpVfxLevel 一直在写这个属性，
     * 但过去没放进 state，等于靠 Vue 的响应式代理「意外」兜住，DevTools 里也看不见。
     */
    hpVfxLevel: typeof localStorage !== 'undefined'
      ? (localStorage.getItem(HP_VFX_LEVEL_KEY) || 'standard')
      : 'standard',
    /** 自增 toast id 计数器 */
    _toastSeq: 0,
  }),
  actions: {
    /**
     * 弹出一条轻提示
     * @param {{type?:'success'|'error'|'warning'|'info', title?:string, message?:string, timeout?:number}} opts
     *   timeout<=0 表示不自动关闭（仍可点击/点叉关掉）
     * @returns {number} toast id（可用于手动关闭）
     */
    pushToast(opts = {}) {
      const {
        type = 'info',
        title = '',
        message = '',
        timeout = TOAST_DEFAULT_TIMEOUT,
      } = opts;
      const id = ++this._toastSeq;
      const toast = {
        id,
        type,
        title,
        message,
        timeout,
        remaining: Math.max(0, timeout),
        _timer: null,
        _startedAt: 0,
      };
      this.toasts.push(toast);
      this._armToastTimer(toast);
      return id;
    },
    removeToast(id) {
      const i = this.toasts.findIndex((t) => t.id === id);
      if (i === -1) return;
      const toast = this.toasts[i];
      if (toast._timer) {
        clearTimeout(toast._timer);
        toast._timer = null;
      }
      this.toasts.splice(i, 1);
    },
    /** 鼠标悬停：暂停自动关闭倒计时，避免还没读完就消失 */
    pauseToast(id) {
      const toast = this.toasts.find((t) => t.id === id);
      if (!toast || !toast._timer) return;
      clearTimeout(toast._timer);
      toast._timer = null;
      const elapsed = Date.now() - toast._startedAt;
      toast.remaining = Math.max(500, toast.remaining - elapsed);
    },
    /** 鼠标离开：从剩余时长继续倒计时 */
    resumeToast(id) {
      const toast = this.toasts.find((t) => t.id === id);
      if (!toast || toast._timer || toast.timeout <= 0) return;
      this._armToastTimer(toast);
    },
    /** 内部：给 toast 装上自动关闭定时器 */
    _armToastTimer(toast) {
      if (toast.timeout <= 0 || toast.remaining <= 0) return;
      toast._startedAt = Date.now();
      toast._timer = setTimeout(() => this.removeToast(toast.id), toast.remaining);
    },
    openPalette() {
      this.paletteOpen = true;
    },
    closePalette() {
      this.paletteOpen = false;
    },
    togglePalette() {
      this.paletteOpen = !this.paletteOpen;
    },
    /** 打开「我的」全屏面板（手机端底部标签栏入口） */
    openMe() {
      if (this.meOpen) return;
      this.meOpen = true;
      // 压一条同文档 history 条目当「返回键靶子」：手机按返回应该先收面板，而不是直接退出游戏。
      // 整条靶子的生命周期只在这里管（openMe/patchHandlePop/afterMeClosed），
      // 谁要是自己 closeMe() + router.push() 就会和这条 back() 抢历史栈、被弹回原页。
      if (!this._meEntry) {
        this._meEntry = true;
        window.history.pushState({ smdzSheet: 1 }, '');
      }
    },
    closeMe() {
      if (!this.meOpen) return;
      this.meOpen = false;
      if (this._meEntry) {
        this._meEntry = false;
        window.history.back();
      }
    },
    toggleMe() {
      if (this.meOpen) this.closeMe();
      else this.openMe();
    },
    /**
     * 「先收面板，再去做导航/开弹窗」。
     * closeMe() 会发起一次 history.back()，同一拍里再 pushState 路由会被那次
     * popstate 顶回去（实测表现：从家园点「设置」，页面停在 /home 什么也没发生）。
     * 所以把后续动作挂到 popstate 真正落地之后再执行；万一浏览器没发事件，400ms 兜底。
     */
    afterMeClosed(fn) {
      if (!fn) return;
      if (!this.meOpen && !this._meEntry) { fn(); return; }
      this._afterMeClosed = fn;
      this.closeMe();
      setTimeout(() => {
        if (!this._afterMeClosed) return;
        const f = this._afterMeClosed;
        this._afterMeClosed = null;
        this._meEntry = false;
        f();
      }, 400);
    },
    /**
     * 由 App.vue 在 window popstate 上调用（浏览器返回键 / 侧滑）。
     * @param {boolean} byBrowser true = 用户按了返回
     * @returns {boolean} 是否被面板消化掉了这次返回
     */
    handlePopByBrowser(byBrowser) {
      if (!byBrowser) return false;
      if (this.meOpen) {
        // 靶子已被浏览器的返回消费掉，只需收面板，不要再 back() 一次
        this._meEntry = false;
        this.meOpen = false;
        const f = this._afterMeClosed;
        this._afterMeClosed = null;
        if (f) f();
        return true;
      }
      if (this._meEntry) {
        // 面板是点 ✕ 关的，但玩家又按了返回：把这条残留靶子安静地让掉
        this._meEntry = false;
        const f = this._afterMeClosed;
        this._afterMeClosed = null;
        if (f) f();
        return true;
      }
      const f = this._afterMeClosed;
      this._afterMeClosed = null;
      if (f) f();
      return false;
    },
    /** 循环切换血量预警特效档位（简约 → 标准 → 强烈）并持久化 */
    cycleHpVfxLevel() {
      const i = HP_VFX_LEVELS.indexOf(this.hpVfxLevel);
      this.hpVfxLevel = HP_VFX_LEVELS[(i + 1) % HP_VFX_LEVELS.length];
      localStorage.setItem(HP_VFX_LEVEL_KEY, this.hpVfxLevel);
    },
    /** 直接设置血量预警特效档位（设置弹窗单选用），非法值忽略 */
    setHpVfxLevel(level) {
      if (!HP_VFX_LEVELS.includes(level)) return;
      this.hpVfxLevel = level;
      localStorage.setItem(HP_VFX_LEVEL_KEY, level);
    },
  },
});
