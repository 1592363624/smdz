/**
 * UI 全局状态（Pinia）
 * 集中承载「跨组件共享的临时 UI 状态」，为后续把 ChatView / AdminView 中的
 * 散落状态（连接状态、玩家信息、toast、命令面板）抽到 store 打下基础。
 *
 * 当前纳入：
 * - toasts：全局轻提示队列（成功/错误/警告/信息）
 * - paletteOpen：命令面板（Cmd/Ctrl+K）开关
 * - hpVfxLevel：血量预警特效强度档位（simple/standard/strong，localStorage 持久化）
 */
import { defineStore } from 'pinia';

/** 血量预警特效档位（循环切换顺序） */
const HP_VFX_LEVELS = ['simple', 'standard', 'strong'];
const HP_VFX_LEVEL_KEY = 'smdz_hp_vfx_level';

export const useUiStore = defineStore('ui', {
  state: () => ({
    /** @type {Array<{id:number,type:string,title:string,message:string}>} */
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
     * @returns {number} toast id（可用于手动关闭）
     */
    pushToast(opts = {}) {
      const { type = 'info', title = '', message = '', timeout = 3000 } = opts;
      const id = ++this._toastSeq;
      this.toasts.push({ id, type, title, message });
      if (timeout > 0) {
        setTimeout(() => this.removeToast(id), timeout);
      }
      return id;
    },
    /** 关闭指定 toast */
    removeToast(id) {
      const i = this.toasts.findIndex((t) => t.id === id);
      if (i !== -1) this.toasts.splice(i, 1);
    },
    /** 打开命令面板 */
    openPalette() {
      this.paletteOpen = true;
    },
    /** 关闭命令面板 */
    closePalette() {
      this.paletteOpen = false;
    },
    /** 切换命令面板 */
    togglePalette() {
      this.paletteOpen = !this.paletteOpen;
    },
    /** 循环切换血量预警特效档位（简约 → 标准 → 强烈）并持久化 */
    cycleHpVfxLevel() {
      const i = HP_VFX_LEVELS.indexOf(this.hpVfxLevel);
      this.hpVfxLevel = HP_VFX_LEVELS[(i + 1) % HP_VFX_LEVELS.length];
      localStorage.setItem(HP_VFX_LEVEL_KEY, this.hpVfxLevel);
    },
  },
});
