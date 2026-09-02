/**
 * 玩家信息状态（Pinia）
 * 接管原本散落在 ChatView 的 playerInfo（等级/HP/位置/任务/装备/增益等）。
 * 由 REST 初次加载与 socket player:update 实时刷新共同写入，供状态面板与多个子组件共享。
 */
import { defineStore } from 'pinia';

export const usePlayerStore = defineStore('player', {
  state: () => ({
    /** 玩家档案对象；未加载时为 null */
    info: null,
  }),
  actions: {
    setPlayerInfo(data) {
      this.info = data ?? null;
    },
  },
});
