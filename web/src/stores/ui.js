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
