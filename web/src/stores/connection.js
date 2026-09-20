/**
 * 连接与服务器状态（Pinia）：WebSocket 连接状态、全服人数/在线人数、在线玩家名单，
 * 以及「谁上线/谁离线」的短时提示（时长见 PRESENCE_CONFIG）。
 * AdminView 等其它视图共用，集中在此避免重复拉取与不一致。
 */
import { defineStore } from 'pinia';
import { PRESENCE_CONFIG } from '../config';

/** 上下线提示的自增 id（仅本地展示/去重用，不与后端约定） */
let presenceSeq = 0;

export const useConnectionStore = defineStore('connection', {
  state: () => ({
    /** WebSocket 是否已连接 */
    connected: false,
    /** 服务器统计：总玩家数 / 在线人数 / 在线玩家名单（名单条数上限由后端配置控制） */
    stats: { totalPlayers: 0, onlinePlayers: 0, onlineList: [] },
    /** 有效期内的上下线提示（最新在前），每条形如 { id, type: 'online'|'offline', name, at }，到期由定时器自动移除 */
    presenceNotices: [],
  }),
  actions: {
    setConnected(v) {
      this.connected = !!v;
    },
    /**
     * 设置服务器统计。兼容后端 stats 接口与 socket stats:update 事件的字段命名。
     * 若事件同时携带 presence（本次上线/离线的玩家），顺带生成一条状态栏提示。
     * @param {{totalPlayers?:number, onlinePlayers?:number, total?:number, online?:number,
     *          onlineList?:string[], presence?:{type:'online'|'offline', name:string}}} s
     */
    setStats(s) {
      if (!s) return;
      this.stats = {
        totalPlayers: Number(s.totalPlayers ?? s.total ?? 0),
        onlinePlayers: Number(s.onlinePlayers ?? s.online ?? 0),
        // 调用方未带名单时保留上一次结果，避免悬停面板闪空
        onlineList: Array.isArray(s.onlineList)
          ? s.onlineList.filter(Boolean).map((n) => String(n))
          : this.stats.onlineList,
      };
      if (s.presence?.name) this.pushPresenceNotice(s.presence);
    },
    /**
     * 记录一条上下线提示（保留时长与最大条数由 PRESENCE_CONFIG 控制）
     * @param {{type:'online'|'offline', name:string}} presence
     */
    pushPresenceNotice(presence) {
      const notice = {
        id: ++presenceSeq,
        type: presence.type === 'offline' ? 'offline' : 'online',
        name: String(presence.name || '').trim(),
        at: Date.now(),
      };
      if (!notice.name) return;
      // 同名同类型的重复推送（如重连抖动）直接忽略，避免提示刷屏
      if (this.presenceNotices.some((n) => n.name === notice.name && n.type === notice.type)) return;
      this.presenceNotices.unshift(notice);
      if (this.presenceNotices.length > PRESENCE_CONFIG.noticeMaxStacks) {
        this.presenceNotices.length = PRESENCE_CONFIG.noticeMaxStacks;
      }
      // 到期自动消失（默认 1 分钟）；组件卸载后提示仍会自然失效，不会泄漏
      setTimeout(() => this.removePresenceNotice(notice.id), PRESENCE_CONFIG.noticeTtlMs);
    },
    /** 移除指定提示（到期或手动关闭） */
    removePresenceNotice(id) {
      this.presenceNotices = this.presenceNotices.filter((n) => n.id !== id);
    },
  },
});
