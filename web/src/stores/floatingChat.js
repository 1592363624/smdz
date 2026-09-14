/**
 * 右下角悬浮世界聊天状态（Pinia）
 * 与中央游戏消息流分离：type=chat 的世界聊天进本 store，指令/战斗/系统回包留在 ChatView。
 * 未读徽标在气泡收起态展示；打开面板时清零。
 */
import { defineStore } from 'pinia';

/** 本地最多保留的聊天条数，超出丢最旧，防止长时间挂机内存膨胀 */
const MAX_CHAT_MESSAGES = 200;

let pendingSeq = 0;

export const useFloatingChatStore = defineStore('floatingChat', {
  state: () => ({
    /** 世界聊天消息（type=chat；预留 redpacket 等扩展类型） */
    messages: [],
    /** 收起态未读数 */
    unread: 0,
    /** 面板是否展开（小窗/伪全屏） */
    open: false,
    /** 伪全屏 */
    fullscreen: false,
  }),
  actions: {
    /**
     * 追加一条世界聊天消息（含本地 _pending 回显）。
     * 按服务端 id 去重；同 id 已存在则跳过，避免重连/广播重复。
     */
    append(msg) {
      if (!msg) return;
      if (!msg.createdAt) msg.createdAt = new Date().toISOString();

      // 本地回显替换：仅当广播消息的发送者与 pending 一致时替换（避免他人同文案误顶）
      if (msg.sender?.id != null && !msg._pending) {
        const now = Date.now();
        const freshSelf = (m) =>
          m._pending &&
          m.sender?.id === msg.sender.id &&
          now - new Date(m.createdAt).getTime() < 30000;
        let idx = this.messages.findIndex((m) => freshSelf(m) && m.content === msg.content);
        if (idx < 0) {
          idx = this.messages.findIndex(freshSelf);
        }
        if (idx >= 0) {
          this.messages.splice(idx, 1, msg);
          return;
        }
      }

      // 按 id 去重（历史 + 实时 / 重连重叠）
      if (msg.id != null) {
        if (this.messages.some((m) => m.id === msg.id)) return;
      } else if (msg._pending && msg._localKey) {
        // 本地回显：同 localKey 已存在则跳过
        if (this.messages.some((m) => m._localKey === msg._localKey)) return;
      }

      this.messages.push(msg);
      if (this.messages.length > MAX_CHAT_MESSAGES) {
        this.messages.splice(0, this.messages.length - MAX_CHAT_MESSAGES);
      }

      // 收起或非聚焦时累计未读（仅真实广播消息，不含本地回显）
      if (!msg._pending) {
        if (!this.open) {
          this.unread += 1;
        } else if (document.hidden) {
          this.unread += 1;
        }
      }
    },

    /** 批量写入历史（初始化 / 重载），不计未读 */
    setMessages(list) {
      const arr = Array.isArray(list) ? list.filter(Boolean) : [];
      this.messages = arr.slice(-MAX_CHAT_MESSAGES);
    },

    setOpen(v) {
      this.open = !!v;
      if (this.open) {
        this.fullscreen = false;
        this.unread = 0;
      }
    },

    toggleFullscreen() {
      this.fullscreen = !this.fullscreen;
    },

    /** 本地构造一条待发送回显 */
    makePending(content, self) {
      pendingSeq += 1;
      return {
        _pending: true,
        _localKey: `pc-${Date.now()}-${pendingSeq}`,
        type: 'chat',
        content,
        sender: self
          ? { id: self.id, username: self.username, nickname: self.nickname }
          : null,
        createdAt: new Date().toISOString(),
      };
    },
  },
});
