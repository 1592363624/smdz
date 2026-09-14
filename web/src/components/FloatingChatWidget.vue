<template>
  <!-- 收起态：右下角可拖拽悬浮气泡 -->
  <button
    v-if="!chat.open"
    type="button"
    class="fc-fab"
    :style="{ right: bubblePos.right + 'px', bottom: bubblePos.bottom + 'px' }"
    aria-label="世界聊天"
    title="世界聊天（可拖动）"
    @pointerdown="onBubblePointerDown"
  >
    <span class="fc-fab-icon">💬</span>
    <span v-if="chat.unread > 0" class="fc-badge">
      {{ chat.unread > 99 ? '99+' : chat.unread }}
    </span>
  </button>

  <!-- 展开态：右下角小窗 / 伪全屏 -->
  <div
    v-else
    class="fc-panel"
    :class="{ fullscreen: chat.fullscreen }"
    @keydown.esc.stop.prevent="onEsc"
  >
    <div class="fc-header">
      <span class="fc-title">
        <span class="fc-title-icon">💬</span>
        世界聊天
      </span>
      <span class="fc-conn" :class="connected ? 'on' : 'off'">
        <span class="fc-conn-dot"></span>
        {{ connected ? '已连接' : '未连接' }}
      </span>
      <div class="fc-header-actions">
        <button
          type="button"
          class="fc-icon-btn"
          :title="chat.fullscreen ? '收起小窗' : '放大'"
          @click="chat.toggleFullscreen()"
        >
          {{ chat.fullscreen ? '⤡' : '⤢' }}
        </button>
        <button type="button" class="fc-icon-btn" title="关闭" @click="chat.setOpen(false)">
          ✕
        </button>
      </div>
    </div>

    <div ref="listEl" class="fc-list" @scroll="onListScroll">
      <div v-if="!chat.messages.length" class="fc-empty">
        <span class="fc-empty-icon">💬</span>
        <p>暂无聊天，来说点什么吧</p>
        <p class="fc-empty-hint">指令与战斗结果仍在中央游戏区展示</p>
      </div>
      <template v-else>
        <div
          v-for="(m, i) in chat.messages"
          :key="m.id ?? m._localKey ?? i"
          class="fc-msg"
          :class="rowClass(m)"
        >
          <!-- 系统/通知类：居中细体 -->
          <div v-if="isSystemLike(m)" class="fc-sys-line">{{ systemText(m) }}</div>

          <!-- 未来扩展：红包卡片 -->
          <div v-else-if="m.type === 'redpacket'" class="fc-rp-card" :class="{ mine: isMine(m) }">
            <div class="fc-rp-emoji">🧧</div>
            <div class="fc-rp-body">
              <div class="fc-rp-title">世界红包</div>
              <div class="fc-rp-sub">{{ m.content }}</div>
            </div>
          </div>

          <!-- 普通聊天气泡 -->
          <div v-else class="fc-row" :class="{ mine: isMine(m) }">
            <div class="fc-avatar" :style="{ background: avatarBg(m) }">
              {{ avatarLetter(m) }}
            </div>
            <div class="fc-bubble-wrap">
              <div class="fc-meta">
                <span class="fc-name">{{ displayName(m) }}</span>
                <span class="fc-time">{{ formatTime(m.createdAt) }}</span>
              </div>
              <div class="fc-msg-bubble" :class="{ pending: m._pending }">{{ m.content }}</div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <div class="fc-input-bar">
      <input
        ref="inputEl"
        v-model="draft"
        class="fc-input"
        type="text"
        maxlength="200"
        placeholder="说点什么…（纯聊天，不会混入游戏指令）"
        :disabled="!connected"
        @keyup.enter="onSend"
      />
      <button
        type="button"
        class="fc-send"
        :disabled="!connected || !draft.trim()"
        @click="onSend"
      >
        发送
      </button>
    </div>
  </div>
</template>

<script setup>
/**
 * 右下角悬浮世界聊天窗
 * 参照 palworld-server-tool 的三态设计：气泡 → 小窗 → 伪全屏。
 * 消息由 ChatView 按 type=chat 路由进本组件；发送走统一 socket 通道。
 *
 * 未来扩展：红包 / 道具赠送等消息 type 直接进 messages，模板按 type 分支渲染即可。
 */
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useFloatingChatStore } from '../stores/floatingChat';

const props = defineProps({
  /** 是否已连接 Socket.IO */
  connected: { type: Boolean, default: false },
  /** 当前用户 id，用于区分自己/他人的气泡对齐 */
  selfId: { type: [Number, String], default: null },
  /** 发送纯聊天： (content: string) => void */
  send: { type: Function, default: null },
});

const chat = useFloatingChatStore();

const listEl = ref(null);
const inputEl = ref(null);
const draft = ref('');
const stickToBottom = ref(true);

/** 气泡位置（距视口右下角偏移） */
const bubblePos = ref({ right: 20, bottom: 88 });

// ---------- 头像 ----------
const PALETTE = [
  'rgba(244, 114, 182, 0.22)',
  'rgba(251, 191, 36, 0.22)',
  'rgba(52, 211, 153, 0.22)',
  'rgba(56, 189, 248, 0.22)',
  'rgba(167, 139, 250, 0.22)',
  'rgba(232, 121, 249, 0.22)',
];

function nameOf(m) {
  return m?.sender?.nickname || m?.sender?.username || '玩家';
}

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

function avatarBg(m) {
  return PALETTE[hashName(nameOf(m)) % PALETTE.length];
}
// ink 调色板保留给头像字母着色扩展位；当前用 text-secondary 保证对比度

function avatarLetter(m) {
  const n = nameOf(m);
  return (n || '?')[0];
}

// ---------- 分类 ----------
function isMine(m) {
  // 本地 pending 一定是我发的
  if (m?._pending) return true;
  if (m?.sender?.id == null || props.selfId == null) return false;
  return String(m.sender.id) === String(props.selfId);
}

function isSystemLike(m) {
  if (m?.type === 'system') return true;
  // 无发送者的非聊天类型兜底
  return !m?.sender && m?.type !== 'chat' && m?.type !== 'redpacket';
}

function systemText(m) {
  return m?.content || '';
}

function displayName(m) {
  return nameOf(m);
}

function rowClass(m) {
  if (isSystemLike(m)) return 'sys';
  if (m?.type === 'redpacket') return 'rp';
  return isMine(m) ? 'own' : 'other';
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- 滚动 ----------
function onListScroll() {
  const el = listEl.value;
  if (!el) return;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function scrollToBottom(force = false) {
  if (!force && !stickToBottom.value) return;
  stickToBottom.value = true;
  nextTick(() => {
    const el = listEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// 打开面板时贴底
watch(
  () => [chat.open, chat.fullscreen, chat.messages.length],
  () => {
    if (chat.open) {
      stickToBottom.value = true;
      scrollToBottom(true);
      nextTick(() => inputEl.value?.focus());
    }
  },
);

// ---------- 发送 ----------
function onSend() {
  const text = draft.value.trim();
  if (!text || !props.connected) return;
  if (typeof props.send === 'function') {
    props.send(text);
  }
  draft.value = '';
  stickToBottom.value = true;
  scrollToBottom(true);
  nextTick(() => inputEl.value?.focus());
}

// ---------- Esc ----------
function onEsc() {
  if (chat.fullscreen) chat.toggleFullscreen();
  else chat.setOpen(false);
}

function onKeydown(e) {
  if (e.key !== 'Escape' || !chat.open) return;
  onEsc();
}

// ---------- 气泡拖拽 ----------
function onBubblePointerDown(e) {
  const el = e.currentTarget;
  const startX = e.clientX;
  const startY = e.clientY;
  const baseRight = bubblePos.value.right;
  const baseBottom = bubblePos.value.bottom;
  let moved = false;

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const maxRight = Math.max(8, window.innerWidth - w - 8);
    const maxBottom = Math.max(8, window.innerHeight - h - 8);
    bubblePos.value = {
      right: Math.min(Math.max(8, baseRight - dx), maxRight),
      bottom: Math.min(Math.max(8, baseBottom - dy), maxBottom),
    };
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (!moved) chat.setOpen(true);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// 伪全屏时锁定 body 滚动
watch(
  () => chat.open && chat.fullscreen,
  (v) => {
    document.body.style.overflow = v ? 'hidden' : '';
  },
);

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  document.body.style.overflow = '';
});
</script>

<style scoped>
/* ===== 气泡 ===== */
.fc-fab {
  position: fixed;
  z-index: 400;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  border: none;
  cursor: grab;
  touch-action: none;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-gradient);
  box-shadow: 0 4px 20px rgba(139, 92, 246, 0.45), var(--shadow-glow);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.fc-fab:hover {
  transform: scale(1.06);
  box-shadow: 0 6px 24px rgba(139, 92, 246, 0.55), 0 0 24px rgba(139, 92, 246, 0.3);
}
.fc-fab:active {
  cursor: grabbing;
  transform: scale(0.96);
}
.fc-fab-icon {
  font-size: 22px;
  line-height: 1;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35));
}
.fc-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--danger);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
  box-shadow: 0 2px 6px rgba(239, 68, 68, 0.5);
  pointer-events: none;
}

/* ===== 面板（小窗默认） ===== */
.fc-panel {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 400;
  display: flex;
  flex-direction: column;
  width: min(360px, calc(100vw - 32px));
  height: min(440px, calc(100vh - 120px));
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--glass-bg);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55), var(--shadow-glow);
  overflow: hidden;
}
.fc-panel.fullscreen {
  right: auto;
  bottom: auto;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(420px, calc(100vw - 40px));
  height: min(720px, calc(100vh - 48px));
  border-color: var(--border-light);
}

/* 头部 */
.fc-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: rgba(30, 26, 58, 0.55);
}
.fc-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.fc-title-icon {
  font-size: 14px;
}
.fc-conn {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: 11px;
  color: var(--muted);
}
.fc-conn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted-dark);
}
.fc-conn.on .fc-conn-dot {
  background: var(--success);
  box-shadow: 0 0 6px var(--success);
}
.fc-conn.off .fc-conn-dot {
  background: var(--danger);
}
.fc-header-actions {
  display: flex;
  gap: 2px;
}
.fc-icon-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  cursor: pointer;
  line-height: 1;
}
.fc-icon-btn:hover {
  background: rgba(139, 92, 246, 0.15);
  color: var(--text);
}

/* 消息列表：用块级流而非 flex 列，避免子项按内容收缩导致气泡变窄 */
.fc-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 10px;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.fc-list::-webkit-scrollbar {
  width: 4px;
}
.fc-list::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 4px;
}

.fc-empty {
  height: 100%;
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--muted-dark);
  text-align: center;
  font-size: 12px;
  pointer-events: none;
}
.fc-empty-icon {
  font-size: 28px;
  opacity: 0.35;
}
.fc-empty-hint {
  font-size: 11px;
  opacity: 0.7;
}

/* 系统行 */
.fc-msg {
  width: 100%;
  margin-bottom: 10px;
}
.fc-msg.sys {
  text-align: center;
}
.fc-sys-line {
  font-size: 11px;
  color: var(--muted-dark);
  line-height: 1.5;
  word-break: break-word;
  padding: 2px 8px;
}

/* 聊天行：固定头像 + 弹性气泡区（避免气泡被挤成竖排） */
.fc-row {
  display: flex;
  width: 100%;
  box-sizing: border-box;
  gap: 8px;
  align-items: flex-start;
}
.fc-row.mine {
  flex-direction: row-reverse;
}
.fc-avatar {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
  border: 1px solid var(--border-light);
  box-sizing: border-box;
}
.fc-bubble-wrap {
  flex: 1 1 auto;
  min-width: 0;
  max-width: calc(100% - 44px);
  display: flex;
  flex-direction: column;
  gap: 3px;
  box-sizing: border-box;
}
.fc-row.mine .fc-bubble-wrap {
  align-items: flex-end;
}
.fc-meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
  padding: 0 2px;
  max-width: 100%;
}
.fc-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent2);
  font-weight: 500;
}
.fc-row.mine .fc-name {
  color: var(--accent);
}
.fc-time {
  color: var(--muted-dark);
  font-size: 10px;
  flex-shrink: 0;
}
.fc-msg-bubble {
  display: inline-block;
  width: fit-content;
  max-width: 100%;
  box-sizing: border-box;
  padding: 7px 11px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
  background: var(--bg3);
  border: 1px solid var(--border);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  text-align: left;
  position: static;
  height: auto;
}
.fc-row.mine .fc-msg-bubble {
  background: rgba(139, 92, 246, 0.22);
  border-color: rgba(139, 92, 246, 0.4);
}
.fc-msg-bubble.pending {
  opacity: 0.7;
}

/* 红包卡片（预留） */
.fc-msg.rp {
  display: flex;
}
.fc-rp-card {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 220px;
  padding: 10px 12px;
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.35), rgba(234, 179, 8, 0.25));
  border: 1px solid rgba(239, 68, 68, 0.45);
  margin-left: 36px;
  cursor: pointer;
}
.fc-rp-card.mine {
  margin-left: auto;
  margin-right: 36px;
}
.fc-rp-emoji {
  font-size: 28px;
  line-height: 1;
}
.fc-rp-title {
  font-size: 13px;
  font-weight: 700;
  color: #fecaca;
}
.fc-rp-sub {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 2px;
}

/* 输入栏 */
.fc-input-bar {
  flex-shrink: 0;
  display: flex;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--border);
  background: rgba(20, 16, 42, 0.6);
}
.fc-input {
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.fc-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.2);
}
.fc-input:disabled {
  opacity: 0.5;
}
.fc-input::placeholder {
  color: var(--muted-dark);
}
.fc-send {
  flex-shrink: 0;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: 10px;
  background: var(--accent-gradient);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.fc-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.fc-send:not(:disabled):hover {
  filter: brightness(1.1);
}

/* 移动端：略缩小，避开底部快捷栏 */
@media (max-width: 768px) {
  .fc-panel {
    right: 10px;
    bottom: 72px;
    width: calc(100vw - 20px);
    height: min(50vh, 360px);
  }
  .fc-panel.fullscreen {
    width: calc(100vw - 16px);
    height: calc(100vh - 40px);
  }
  .fc-fab {
    bottom: 72px !important;
  }
}
</style>
