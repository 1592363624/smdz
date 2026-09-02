/**
 * 连接与服务器状态（Pinia）
 * 接管原本散落在 ChatView 的：WebSocket 连接状态、全服人数/在线人数。
 * 这些状态 AdminView 等其它视图也会用到，集中到 store 后可避免重复拉取与不一致。
 */
import { defineStore } from 'pinia';

export const useConnectionStore = defineStore('connection', {
  state: () => ({
    /** WebSocket 是否已连接 */
    connected: false,
    /** 服务器统计：总玩家数 / 在线人数 */
    stats: { totalPlayers: 0, onlinePlayers: 0 },
  }),
  actions: {
    setConnected(v) {
      this.connected = !!v;
    },
    /**
     * 设置服务器统计。兼容后端 stats 接口与 socket stats:update 事件的字段命名。
     * @param {{totalPlayers?:number, onlinePlayers?:number, total?:number, online?:number}} s
     */
    setStats(s) {
      if (!s) return;
      this.stats = {
        totalPlayers: Number(s.totalPlayers ?? s.total ?? 0),
        onlinePlayers: Number(s.onlinePlayers ?? s.online ?? 0),
      };
    },
  },
});
