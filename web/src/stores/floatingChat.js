/**
 * 右下角悬浮世界聊天状态（Pinia）
 * 与中央游戏消息流分离：type=chat 的世界聊天进本 store，指令/战斗/系统回包留在 ChatView。
 * 未读徽标在气泡收起态展示；打开面板时清零。
 */
import { defineStore } from 'pinia';
import { FLOATING_CHAT_CONFIG } from '../config';

/** 本地最多保留的聊天条数，超出丢最旧，防止长时间挂机内存膨胀（数值见 config.js） */
const MAX_CHAT_MESSAGES = FLOATING_CHAT_CONFIG.maxMessages;

let pendingSeq = 0;

export const useFloatingChatStore = defineStore('floatingChat', {
  state: () => ({
    /** 世界聊天消息（type=chat / redpacket） */
    messages: [],
    /** 未读消息数（未读数 > 0 即显示红点提醒） */
    unread: 0,
    /** 面板是否展开（小窗/伪全屏） */
    open: false,
    /** 伪全屏 */
    fullscreen: false,
    /** 红包状态表：packetId → 红包视图（红包卡片渲染数据源） */
    redPackets: {},
    /** 消息列表当前是否停在底部（用户向上翻阅时新消息计入未读） */
    atBottom: true,
    /** 当前用户 id（字符串化）：自己发送的消息不计未读，避免自发自读还报红点 */
    selfId: null,
  }),
  actions: {
    /**
     * 追加一条世界聊天消息（含本地 _pending 回显）。
     * 按服务端 id 去重；同 id 已存在则跳过，避免重连/广播重复。
     */
    append(msg) {
      if (!msg) return;
      if (!msg.createdAt) msg.createdAt = new Date().toISOString();

      // 红包消息自带实时视图（服务端广播时附在消息上）→ 直接入库，卡片无需再查一次
      if (msg.type === 'redpacket' && msg.redPacket?.id) {
        this.redPackets[msg.redPacket.id] = msg.redPacket;
      }

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

      // 未读红点：只要「别人发来的新消息还没被看到」就计数——
      // 面板收起、面板开着但用户翻看历史没停在底部、页面切到后台，三种情况都提醒。
      // 自己发送的消息（如自己发的红包广播回来）不计未读。
      const fromSelf =
        this.selfId != null && msg.sender?.id != null && String(msg.sender.id) === this.selfId;
      if (!msg._pending && !fromSelf) {
        if (!this.open || !this.atBottom || document.hidden) {
          this.unread += 1;
        }
      }
    },

    /** 记录当前用户 id，用于判断消息是否自己发的（自己发的不计未读） */
    setSelfId(id) {
      this.selfId = id == null ? null : String(id);
    },

    /** 写入/更新单个红包状态（socket 推送与接口拉取共用入口） */
    upsertRedPacket(packet) {
      if (!packet?.id) return;
      const prev = this.redPackets[packet.id];
      // 服务端广播的进度视图不带 myClaim（领取记录因人而异），
      // 合并时保留本地已知的领取结果，避免自己的「已领取」状态被广播覆盖掉
      this.redPackets[packet.id] = {
        ...packet,
        myClaim: packet.myClaim ?? prev?.myClaim ?? null,
      };
    },

    /** 批量写入红包状态（进频道时对齐历史消息里的红包卡片） */
    setRedPackets(list) {
      for (const packet of list || []) this.upsertRedPacket(packet);
    },

    /**
     * 同步「消息列表是否停在底部」。
     * 停在底部 = 用户正在看最新消息 → 清空未读；离开底部后新消息继续累计未读。
     */
    setAtBottom(value) {
      this.atBottom = !!value;
      if (this.atBottom) this.unread = 0;
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
