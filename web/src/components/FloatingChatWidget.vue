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
        <!-- 发红包：打开道具选择弹窗（读背包 → 选中后立即扣除并广播） -->
        <button
          type="button"
          class="fc-icon-btn fc-rp-open"
          title="发红包（把背包道具装进红包）"
          @click="openRedPacketComposer"
        >
          🧧
        </button>
        <!-- 我的红包：发出的 / 领到的 / 过期退回明细 -->
        <button
          type="button"
          class="fc-icon-btn"
          title="我的红包（发出/领到/退回明细）"
          @click="rpMineOpen = true"
        >
          🧾
        </button>
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

          <!-- 世界红包卡片：展示道具内容与领取进度，可一键领取 -->
          <div
            v-else-if="m.type === 'redpacket'"
            class="fc-rp-card"
            :class="{ mine: isMine(m), done: rpState(m).done }"
          >
            <div class="fc-rp-emoji">🧧</div>
            <div class="fc-rp-body">
              <div class="fc-rp-title">{{ rpState(m).title }}</div>
              <div class="fc-rp-sub">{{ rpState(m).sub }}</div>
              <div v-if="rpState(m).greeting" class="fc-rp-greeting">“{{ rpState(m).greeting }}”</div>
              <div class="fc-rp-progress">{{ rpState(m).progress }}</div>
            </div>
            <button
              type="button"
              class="fc-rp-btn"
              :class="{ claimed: rpState(m).mine }"
              :disabled="rpState(m).disabled || rpClaimingId === rpState(m).id"
              @click="onRedPacketClick(m)"
            >
              {{ rpClaimingId === rpState(m).id ? '领取中…' : rpState(m).btnText }}
            </button>
          </div>

          <!-- 普通聊天气泡 -->
          <div v-else class="fc-row" :class="{ mine: isMine(m) }">
            <!-- 头像：右键可直接 @ 对方（QQ 式快捷提及） -->
            <div
              class="fc-avatar"
              :class="{ 'at-able': canAtSender(m) }"
              :style="{ background: avatarBg(m) }"
              @contextmenu="openPlayerCtx($event, m)"
            >
              {{ avatarLetter(m) }}
            </div>
            <div class="fc-bubble-wrap">
              <div class="fc-meta">
                <span
                  class="fc-name"
                  :class="{ 'at-able': canAtSender(m) }"
                  @contextmenu="openPlayerCtx($event, m)"
                >{{ displayName(m) }}</span>
                <span class="fc-time">{{ formatTime(m.createdAt) }}</span>
              </div>
              <div class="fc-msg-bubble" :class="{ pending: m._pending }">
                <!-- @提及 分段渲染：命中后端可解析的 @名字 时高亮，并支持右键快速 @ -->
                <template v-for="(seg, si) in contentSegments(m.content)" :key="si">
                  <span
                    v-if="seg.type === 'mention'"
                    class="fc-mention"
                    :title="'右键快速 @ ' + seg.text.replace('@', '')"
                    @contextmenu="openMentionCtx($event, seg)"
                  >{{ seg.display }}</span>
                  <template v-else>{{ seg.text }}</template>
                </template>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 未读提醒：面板开着但用户在看历史时，新消息以红色提示条显示；点击回到底部并清未读 -->
    <button v-if="chat.unread > 0" type="button" class="fc-unread-jump" @click="jumpToLatest">
      ↓ {{ chat.unread > 99 ? '99+' : chat.unread }} 条新消息
    </button>

    <div class="fc-input-bar">
      <!-- @ 玩家下拉：输入 @ 时在上方展开，支持方向键/回车/Tab/鼠标选择 -->
      <div
        v-if="showAt && atCandidates.length"
        class="fc-at-list"
        :style="{ maxHeight: FLOATING_CHAT_CONFIG.atListMaxHeight + 'px' }"
      >
        <div
          v-for="(p, pi) in atCandidates"
          :key="p.id ?? p.username"
          class="fc-at-item"
          :class="{ active: pi === atIndex }"
          @mousedown.prevent="pickAtPlayer(p)"
        >
          <span class="fc-at-icon">@</span>
          <span class="fc-at-name">{{ p.nickname || p.username }}</span>
          <span class="fc-at-state" :class="{ on: p.online }">{{ p.online ? '在线' : '离线' }}</span>
        </div>
      </div>
      <input
        ref="inputEl"
        v-model="draft"
        class="fc-input"
        type="text"
        :maxlength="FLOATING_CHAT_CONFIG.draftMaxLen"
        placeholder="说点什么…（输入 @ 可 @人，右键名字可快捷 @）"
        :disabled="!connected"
        @input="onDraftInput"
        @keydown="onInputKeydown"
        @blur="onInputBlur"
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

  <!-- 右键快捷菜单：@ TA / 复制昵称。Teleport 到 body，避免被面板 backdrop-filter 裁剪 -->
  <Teleport to="body">
    <div
      v-if="ctxMenu.show"
      class="fc-ctx"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @contextmenu.prevent
    >
      <button type="button" class="fc-ctx-item" @click="ctxAtPlayer">
        <span class="fc-ctx-icon">@</span>
        提及 {{ ctxMenu.label }}
      </button>
      <button type="button" class="fc-ctx-item" @click="ctxCopyName">
        <span class="fc-ctx-icon">📋</span>
        复制昵称
      </button>
    </div>
  </Teleport>

  <!-- 发红包弹窗：从背包挑选道具（发送时立即扣除），支持逐个调整份数 -->
  <Teleport to="body">
    <div v-if="rpOpen" class="fc-rp-overlay" @click.self="closeRedPacketComposer">
      <div class="fc-rp-modal">
        <header class="fc-rp-modal-head">
          <h3>🧧 发红包</h3>
          <button type="button" class="fc-icon-btn" title="关闭" @click="closeRedPacketComposer">✕</button>
        </header>

        <div class="fc-rp-modal-body">
          <p class="fc-rp-hint">从背包里挑道具放进红包，点击发送时立即从背包扣除；24 小时内没人领完的会自动退回。</p>

          <!-- 玩法选择：普通 / 专属（指定领取人）/ 口令 -->
          <div class="fc-rp-types">
            <button
              v-for="t in RED_PACKET_CLIENT_CONFIG.packetTypes"
              :key="t.value"
              type="button"
              class="fc-rp-type"
              :class="{ active: rpType === t.value }"
              :title="t.desc"
              @click="rpType = t.value"
            >
              <span class="fc-rp-type-icon">{{ t.icon }}</span>
              <span class="fc-rp-type-label">{{ t.label }}</span>
            </button>
          </div>

          <!-- 专属红包：搜索并选择指定领取人 -->
          <template v-if="rpType === 'TARGET'">
            <div v-if="rpTargetId" class="fc-rp-picked-target">
              🎯 仅 <strong>{{ rpTargetName }}</strong> 可领
              <button type="button" class="fc-rp-clear-target" @click="clearRedPacketTarget">更换</button>
            </div>
            <template v-else>
              <input
                v-model="rpTargetKeyword"
                class="fc-rp-greeting-input"
                type="text"
                placeholder="搜索领取人（昵称 / 用户名）"
              />
              <div v-if="rpTargetCandidates.length" class="fc-rp-targets">
                <button
                  v-for="p in rpTargetCandidates"
                  :key="p.id"
                  type="button"
                  class="fc-rp-target"
                  @click="pickRedPacketTarget(p)"
                >
                  <span class="fc-rp-target-name">{{ p.nickname || p.username }}</span>
                  <em :class="{ on: p.online }">{{ p.online ? '在线' : '离线' }}</em>
                </button>
              </div>
              <div v-else class="fc-rp-empty">没有匹配的玩家</div>
            </template>
          </template>

          <!-- 口令红包：设置领取口令（领取者需要输入它） -->
          <input
            v-if="rpType === 'PASSCODE'"
            v-model="rpPasscode"
            class="fc-rp-greeting-input"
            type="text"
            :maxlength="RED_PACKET_CLIENT_CONFIG.maxPasscodeLength"
            placeholder="设置领取口令（别人要输入它才能领）"
          />

          <div v-if="rpLoading" class="fc-rp-empty">背包加载中…</div>
          <div v-else-if="!rpItems.length" class="fc-rp-empty">背包里暂无可放入红包的道具</div>
          <div v-else class="fc-rp-items">
            <div
              v-for="item in rpItems"
              :key="item.name"
              class="fc-rp-item"
              :class="{ picked: rpPicked(item.name) > 0 }"
            >
              <span class="fc-rp-item-name">{{ item.name }}</span>
              <span class="fc-rp-item-owned">拥有 {{ item.quantity }}</span>
              <div class="fc-rp-stepper">
                <!-- 步进器：0 表示不放这个道具；中间份数支持直接手填（负号/字母会被过滤，超出拥有量会被截断） -->
                <button type="button" :disabled="rpPicked(item.name) <= 0" @click="rpStep(item, -1)">−</button>
                <input
                  class="fc-rp-count-input"
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  :value="rpPicked(item.name)"
                  :title="`可直接填写数量（0 ~ ${item.quantity}，不能为负数）`"
                  @focus="onRpCountFocus"
                  @input="onRpCountInput(item, $event)"
                  @blur="onRpCountBlur(item, $event)"
                />
                <button
                  type="button"
                  :disabled="rpPicked(item.name) >= item.quantity || rpTotalCount >= RED_PACKET_CLIENT_CONFIG.maxTotalCount"
                  @click="rpStep(item, 1)"
                >
                  ＋
                </button>
              </div>
            </div>
          </div>

          <input
            v-model="rpGreeting"
            class="fc-rp-greeting-input"
            type="text"
            :maxlength="RED_PACKET_CLIENT_CONFIG.maxGreetingLength"
            placeholder="祝福语（选填）"
          />
        </div>

        <footer class="fc-rp-modal-foot">
          <span class="fc-rp-total">
            共 {{ rpTotalCount }} 份<em v-if="rpKindCount">／{{ rpKindCount }} 种</em>
          </span>
          <button
            type="button"
            class="fc-send"
            :disabled="!rpTotalCount || rpSubmitting"
            @click="submitRedPacket"
          >
            {{ rpSubmitting ? '发送中…' : '塞进红包' }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>

  <!-- 口令红包领取：输入发送者设定的口令后再提交领取 -->
  <Teleport to="body">
    <div v-if="rpPassPrompt.open" class="fc-rp-overlay" @click.self="closePasscodePrompt">
      <div class="fc-rp-modal fc-rp-pass-modal">
        <header class="fc-rp-modal-head">
          <h3>🔑 输入口令</h3>
          <button type="button" class="fc-icon-btn" title="关闭" @click="closePasscodePrompt">✕</button>
        </header>
        <div class="fc-rp-modal-body">
          <p class="fc-rp-hint">这是口令红包，输入发送者设置的口令就能领走一份。</p>
          <input
            v-model="rpPassPrompt.value"
            class="fc-rp-greeting-input"
            type="text"
            :maxlength="RED_PACKET_CLIENT_CONFIG.maxPasscodeLength"
            placeholder="请输入口令"
            @keyup.enter="submitPasscode"
          />
        </div>
        <footer class="fc-rp-modal-foot">
          <span class="fc-rp-total">口令默认不区分大小写</span>
          <button type="button" class="fc-send" @click="submitPasscode">确认领取</button>
        </footer>
      </div>
    </div>
  </Teleport>

  <!-- 我的红包：发出的 / 领到的 / 过期退回明细（组件内部自行拉取数据） -->
  <RedPacketMinePanel
    v-if="rpMineOpen"
    :connected="props.connected"
    @close="rpMineOpen = false"
    @notify="(payload) => emit('notify', payload)"
  />
</template>

<script setup>
/**
 * 右下角悬浮世界聊天窗
 * 参照 palworld-server-tool 的三态设计：气泡 → 小窗 → 伪全屏。
 * 消息由 ChatView 按 type=chat 路由进本组件；发送走统一 socket 通道。
 *
 * 支持 QQ 式 @人：
 * - 气泡内 @提及 自动高亮（@用户名 换算为 @昵称展示）
 * - 右键头像/昵称/@片段 → 弹出菜单「提及 TA」（把 "@名字 " 填入输入框）
 * - 输入框中输入 @ 时弹出玩家下拉，支持方向键/回车/Tab/鼠标选择
 * 被 @ 的玩家由后端 chat:at 事件定向提醒（ChatView 统一弹轻提示）。
 *
 * 未来扩展：红包 / 道具赠送等消息 type 直接进 messages，模板按 type 分支渲染即可。
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useFloatingChatStore } from '../stores/floatingChat';
import RedPacketMinePanel from './RedPacketMinePanel.vue';
import { chatApi } from '../api';
import {
  MENTION_CONFIG,
  FLOATING_CHAT_CONFIG,
  RED_PACKET_CLIENT_CONFIG,
  mentionParseRegex,
  isSafeMentionName,
} from '../config';

const props = defineProps({
  /** 是否已连接 Socket.IO */
  connected: { type: Boolean, default: false },
  /** 当前用户 id，用于区分自己/他人的气泡对齐 */
  selfId: { type: [Number, String], default: null },
  /** 发送纯聊天： (content: string) => void */
  send: { type: Function, default: null },
  /** 可@玩家列表（父组件轮询下发，形如 [{ id, username, nickname, online }]） */
  mentionPlayers: { type: Array, default: () => [] },
});

const emit = defineEmits(['refresh-players', 'notify']);

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
  // 同步给 store：不在底部时新消息要计入未读（红点提醒）
  chat.setAtBottom(stickToBottom.value);
}

function scrollToBottom(force = false) {
  if (!force && !stickToBottom.value) return;
  stickToBottom.value = true;
  nextTick(() => {
    const el = listEl.value;
    if (el) el.scrollTop = el.scrollHeight;
    chat.setAtBottom(true);
  });
}

/** 未读提示条点击：跳回最新消息并清空未读 */
function jumpToLatest() {
  scrollToBottom(true);
  chat.setAtBottom(true);
}

// 打开面板时贴底，并请求父组件刷新可@玩家列表（保证下拉里是较新的在线状态）
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

watch(
  () => chat.open,
  (v) => {
    if (v) emit('refresh-players');
  },
);

// 同步当前用户 id 到 store：自己发送的消息（如自己发的红包广播回来）不计未读红点
watch(
  () => props.selfId,
  (id) => chat.setSelfId(id),
  { immediate: true },
);

// ---------- @提及（QQ 式 @人） ----------
// 可@玩家列表由父组件（ChatView，按 MENTION_CONFIG.playersRefreshMs 轮询）下发，避免重复请求接口
const players = computed(() => (Array.isArray(props.mentionPlayers) ? props.mentionPlayers : []));

/** 用户名/昵称 → 玩家 映射：把消息里的 @用户名 解析成昵称展示 */
const playerByName = computed(() => {
  const map = new Map();
  for (const p of players.value) {
    if (p?.username) map.set(p.username, p);
    if (p?.nickname) map.set(p.nickname, p);
  }
  return map;
});

/**
 * 取可写入 @ 的名字：昵称能被后端解析时优先昵称（更直观），
 * 否则退回用户名——含空格/表情的昵称会被 @ 解析截断，导致 @ 不到人
 * @param {object} player { username, nickname }
 * @returns {string}
 */
function mentionNameOf(player) {
  const nick = String(player?.nickname || '').trim();
  if (nick && isSafeMentionName(nick)) return nick;
  return String(player?.username || '').trim();
}

/**
 * @提及 的展示文本：能匹配到玩家且昵称「@ 安全」时显示 @昵称，否则保持原文
 * @param {string} name @ 后面的名字（用户名或昵称）
 * @returns {string}
 */
function mentionDisplay(name) {
  const p = playerByName.value.get(name);
  const nick = String(p?.nickname || '').trim();
  if (nick && nick !== name && isSafeMentionName(nick)) return '@' + nick;
  return '@' + name;
}

/**
 * 把聊天文本按 @提及 拆成片段（mention / text），供模板高亮渲染
 * 与后端 ChatService.parseMentions 使用同款规则，保证「高亮的都能 @ 到人」
 * @param {string} content 原始消息文本
 * @returns {Array<{type:'text'|'mention', text:string, display?:string}>}
 */
function contentSegments(content) {
  const text = String(content ?? '');
  const segs = [];
  const regex = mentionParseRegex();
  let last = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) segs.push({ type: 'text', text: text.slice(last, m.index) });
    // text 保留原文用于回填兜底，display 优先显示昵称
    segs.push({ type: 'mention', text: m[0], display: mentionDisplay(m[1]) });
    last = regex.lastIndex;
  }
  if (last === 0) return [{ type: 'text', text }];
  if (last < text.length) segs.push({ type: 'text', text: text.slice(last) });
  return segs;
}

/** 该消息是否提供「右键 @ 对方」入口（自己发的、无发送者的消息不给） */
function canAtSender(m) {
  if (!m?.sender || isMine(m)) return false;
  return !!mentionNameOf(m.sender);
}

// ---------- @ 输入补全 ----------
// @ 下拉是否展开、当前选中索引、过滤关键词、@ 在输入框中的起始位置（用于替换）
const showAt = ref(false);
const atIndex = ref(0);
const atKeyword = ref('');
const atStart = ref(-1);

/** 过滤后的 @ 候选玩家（昵称/用户名匹配，按在线优先由后端排序，这里只截断） */
const atCandidates = computed(() => {
  const kw = atKeyword.value.trim().toLowerCase();
  const list = kw
    ? players.value.filter(
        (p) =>
          String(p.username || '').toLowerCase().includes(kw) ||
          String(p.nickname || '').toLowerCase().includes(kw),
      )
    : players.value;
  return list.slice(0, MENTION_CONFIG.autocompleteLimit);
});

/**
 * 检测输入框是否处于 @ 模式（光标前存在最近一个未被空白打断的 @）
 * 处于 @ 模式时同步记录 @ 起始位置与关键词，便于后续整体替换
 */
function detectAtMode() {
  const el = inputEl.value;
  const text = draft.value;
  const pos = el?.selectionStart ?? text.length;
  const before = text.slice(0, pos);
  const atIdx = before.lastIndexOf('@');
  if (atIdx === -1) return false;
  const after = before.slice(atIdx + 1);
  // 关键词超长（如粘贴整段文本）时不进入 @ 模式，避免误触发下拉
  if (after.length > MENTION_CONFIG.nameMaxLen) return false;
  // @ 与光标之间出现空白，说明是普通文本里的 @（邮箱、表情等）
  if (/\s/.test(after)) return false;
  atStart.value = atIdx;
  atKeyword.value = after;
  return true;
}

/** 关闭 @ 下拉并重置状态 */
function closeAt() {
  showAt.value = false;
  atIndex.value = 0;
  atKeyword.value = '';
  atStart.value = -1;
}

/** 输入变化：@ 模式下呼出玩家下拉（无候选则关闭） */
function onDraftInput() {
  if (detectAtMode() && atCandidates.value.length) {
    showAt.value = true;
    atIndex.value = 0;
  } else {
    closeAt();
  }
}

/**
 * 把 "@名字 " 插入输入框
 * @param {string} name 要 @ 的名字（用户名/昵称）
 * @param {{start:number,end:number}|null} range 需替换的区间（@ 补全用）；为空则插入到光标处（失焦则追加到末尾）
 */
function insertMentionText(name, range = null) {
  const clean = String(name || '').trim();
  if (!clean) return;
  const el = inputEl.value;
  const text = draft.value;
  const focused = !!el && document.activeElement === el;
  const start = range ? range.start : focused ? el.selectionStart : text.length;
  const end = range ? range.end : focused ? el.selectionEnd : start;
  const before = text.slice(0, start);
  const after = text.slice(end);
  // 前一个字符不是空白时补一个空格，避免出现 "你好@张三" 这种粘连
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const insert = `${lead}@${clean} `;
  draft.value = (before + insert + after).slice(0, FLOATING_CHAT_CONFIG.draftMaxLen);
  closeAt();
  nextTick(() => {
    const node = inputEl.value;
    if (!node) return;
    const caret = Math.min((before + insert).length, FLOATING_CHAT_CONFIG.draftMaxLen);
    node.focus();
    node.setSelectionRange(caret, caret);
  });
}

/** 从 @ 下拉中选中玩家：把 " @关键词 " 区间替换为 "@名字 " */
function pickAtPlayer(p) {
  const name = mentionNameOf(p);
  if (!name) return;
  const start = atStart.value >= 0 ? atStart.value : (inputEl.value?.selectionStart ?? draft.value.length);
  insertMentionText(name, { start, end: start + 1 + atKeyword.value.length });
}

/** 输入框失焦：延迟关闭下拉，给 mousedown 选中留出时间 */
function onInputBlur() {
  setTimeout(closeAt, MENTION_CONFIG.blurCloseDelayMs);
}

// ---------- 右键快捷 @ ----------
// 菜单状态：显示标记 + 视口坐标 + 待 @ 的名字/展示名
const ctxMenu = ref({ show: false, x: 0, y: 0, name: '', label: '' });

/** 弹出右键菜单（坐标钳制在视口内，避免菜单跑出屏幕） */
function showCtxMenu(e, name, label) {
  ctxMenu.value = {
    show: true,
    x: Math.max(8, Math.min(e.clientX, window.innerWidth - 172)),
    y: Math.max(8, Math.min(e.clientY, window.innerHeight - 88)),
    name,
    label: label || name,
  };
}

function closeCtxMenu() {
  ctxMenu.value.show = false;
}

/** 右键消息头像/昵称：菜单里提供「提及 TA」 */
function openPlayerCtx(e, m) {
  if (!canAtSender(m)) return;
  e.preventDefault();
  e.stopPropagation();
  showCtxMenu(e, mentionNameOf(m.sender), displayName(m));
}

/** 右键气泡里的 @提及 片段：菜单里提供「提及 TA」（原文优先，保证能 @ 到人） */
function openMentionCtx(e, seg) {
  const name = String(seg?.text || '').replace(/^@/, '').trim();
  if (!name) return;
  e.preventDefault();
  e.stopPropagation();
  showCtxMenu(e, name, String(seg.display || seg.text).replace(/^@/, ''));
}

/** 菜单项「提及 TA」：把 "@名字 " 填入输入框 */
function ctxAtPlayer() {
  const name = ctxMenu.value.name;
  closeCtxMenu();
  insertMentionText(name);
}

/** 菜单项「复制昵称」：剪贴板不可用时静默忽略，不打断聊天 */
async function ctxCopyName() {
  const label = ctxMenu.value.label;
  closeCtxMenu();
  try {
    await navigator.clipboard?.writeText(label);
  } catch {
    // 非 HTTPS / 未授权等场景写入失败，忽略即可
  }
}

/** 点击菜单外部时收起菜单（菜单自身的 pointerdown 不关，交给 click 处理） */
function onGlobalPointerDown(e) {
  if (!ctxMenu.value.show) return;
  if (e.target?.closest?.('.fc-ctx')) return;
  closeCtxMenu();
}

// ---------- 世界红包 ----------
// 发红包弹窗状态：打开时拉取背包可发放清单；份数在本地调整，提交时由服务端扣除背包
const rpOpen = ref(false);
const rpLoading = ref(false);
const rpItems = ref([]);
/** 已选道具：name → 份数（0 表示不放） */
const rpPickedMap = ref({});
const rpGreeting = ref('');
const rpSubmitting = ref(false);
/** 正在领取的红包ID（按钮转圈用） */
const rpClaimingId = ref(null);
/** 红包玩法：NORMAL / TARGET / PASSCODE（选项见 RED_PACKET_CLIENT_CONFIG.packetTypes） */
const rpType = ref('NORMAL');
/** 专属红包：领取人搜索关键词与已选目标ID */
const rpTargetKeyword = ref('');
const rpTargetId = ref(null);
/** 口令红包：发送者设置的口令 */
const rpPasscode = ref('');
/** 领取口令红包时的输入弹窗状态 */
const rpPassPrompt = ref({ open: false, packetId: null, value: '' });
/** 「我的红包」面板开关（组件内部自行拉取 GET /chat/redpacket/mine） */
const rpMineOpen = ref(false);

/** 可指定为领取人的玩家：复用父组件下发的可@玩家列表，按关键词过滤 */
const rpTargetCandidates = computed(() => {
  const kw = rpTargetKeyword.value.trim().toLowerCase();
  const list = Array.isArray(props.mentionPlayers) ? props.mentionPlayers : [];
  const hit = kw
    ? list.filter(
        (p) =>
          String(p.nickname || '').toLowerCase().includes(kw) ||
          String(p.username || '').toLowerCase().includes(kw),
      )
    : list;
  return hit.slice(0, MENTION_CONFIG.autocompleteLimit);
});

/** 已选领取人的展示名（用于「仅 XXX 可领」提示） */
const rpTargetName = computed(() => {
  const id = rpTargetId.value;
  if (!id) return '';
  const list = Array.isArray(props.mentionPlayers) ? props.mentionPlayers : [];
  const hit = list.find((p) => p.id === id);
  return hit ? hit.nickname || hit.username : `#${id}`;
});

/** 选中专属红包的领取人 */
function pickRedPacketTarget(p) {
  if (!p) return;
  rpTargetId.value = p.id;
  rpTargetKeyword.value = '';
}

/** 清除已选领取人（重新搜索） */
function clearRedPacketTarget() {
  rpTargetId.value = null;
  rpTargetKeyword.value = '';
}

/** 已选总份数（1 份 = 1 个道具） */
const rpTotalCount = computed(() =>
  Object.values(rpPickedMap.value).reduce((sum, qty) => sum + (Number(qty) || 0), 0),
);
/** 已选道具种类数 */
const rpKindCount = computed(() => Object.keys(rpPickedMap.value).length);

/** 某道具已选份数 */
function rpPicked(name) {
  return Number(rpPickedMap.value[name] || 0);
}

/**
 * 设置某道具放入的份数（手填与步进共用入口）
 * 统一钳制规则：整数、0 ~ 拥有量、总量不超过 maxTotalCount、种类不超过 maxItemKinds
 * @returns {number} 实际生效的份数（供输入框回写，避免显示与状态不一致）
 */
function rpSetCount(item, value) {
  const owned = Math.max(0, Math.floor(Number(item?.quantity) || 0));
  let next = Math.floor(Number(value) || 0);
  // 负数/NaN 一律归零；上限取「拥有量」与「剩余可分配总量」的较小值
  if (!Number.isFinite(next) || next < 0) next = 0;
  next = Math.min(next, owned);
  const others = rpTotalCount.value - rpPicked(item.name);
  const remainCap = Math.max(0, RED_PACKET_CLIENT_CONFIG.maxTotalCount - others);
  next = Math.min(next, remainCap);

  const map = { ...rpPickedMap.value };
  if (next <= 0) delete map[item.name];
  else map[item.name] = next;
  // 前端先挡一道种类上限，避免提交后才被后端拒绝
  if (Object.keys(map).length > RED_PACKET_CLIENT_CONFIG.maxItemKinds) return rpPicked(item.name);
  rpPickedMap.value = map;
  return next;
}

/** 步进调整某道具放入的份数（0 ~ 拥有量）；超出种类上限时不生效 */
function rpStep(item, delta) {
  rpSetCount(item, rpPicked(item.name) + delta);
}

/** 聚焦时全选，方便直接输入覆盖（不必先删掉原来的数字） */
function onRpCountFocus(event) {
  event?.target?.select?.();
}

/**
 * 手填份数：过滤掉负号/字母/小数点等非法字符后写入状态
 * - 输入为空时保留空输入（不强行填 0），失焦再规范化
 * - 超过拥有量/总量上限时立即截断为合法值并回写输入框
 */
function onRpCountInput(item, event) {
  const raw = String(event?.target?.value ?? '');
  // 只保留数字：'-'、'.'、'e'、空格等会被直接丢弃，所以永远不可能是负数
  const digits = raw.replace(/\D/g, '');
  rpSetCount(item, digits ? Number(digits) : 0);
  if (raw === '' || !event?.target) return;
  // 回写实际生效值（体现上限截断）；未变化时不回写，避免打断连续输入
  const applied = String(rpPicked(item.name));
  if (raw !== applied) event.target.value = applied;
}

/** 失焦规范化：空输入或超限输入都显示为真实生效的份数 */
function onRpCountBlur(item, event) {
  if (event?.target) event.target.value = String(rpPicked(item.name));
}

/** 打开发红包弹窗：读取背包中可放入红包的道具 */
async function openRedPacketComposer() {
  if (!props.connected) {
    emit('notify', { type: 'error', message: '未连接服务器，暂时无法发红包' });
    return;
  }
  rpOpen.value = true;
  rpGreeting.value = '';
  rpPickedMap.value = {};
  rpItems.value = [];
  // 玩法相关状态重置：默认普通红包，清空领取人与口令
  rpType.value = 'NORMAL';
  rpTargetId.value = null;
  rpTargetKeyword.value = '';
  rpPasscode.value = '';
  rpLoading.value = true;
  try {
    const res = await chatApi.getRedPacketItems();
    rpItems.value = res.data || [];
  } catch {
    emit('notify', { type: 'error', message: '背包读取失败，请稍后重试' });
  } finally {
    rpLoading.value = false;
  }
}

function closeRedPacketComposer() {
  rpOpen.value = false;
}

/** 提交红包：服务端二次校验并扣背包，随后会向世界频道广播一条红包消息 */
async function submitRedPacket() {
  if (rpSubmitting.value) return;
  const items = Object.entries(rpPickedMap.value).map(([name, quantity]) => ({ name, quantity }));
  if (!items.length) return;
  // 玩法前置校验（服务端还会再校验一次，这里只是为了让用户少一次无效请求）
  if (rpType.value === 'TARGET' && !rpTargetId.value) {
    emit('notify', { type: 'error', message: '请先选择专属红包的领取人' });
    return;
  }
  if (rpType.value === 'PASSCODE' && !rpPasscode.value.trim()) {
    emit('notify', { type: 'error', message: '请先设置口令红包的口令' });
    return;
  }
  rpSubmitting.value = true;
  try {
    const payload = { greeting: rpGreeting.value, items, packetType: rpType.value };
    // 专属：传目标用户ID；口令：传明文口令（服务端按配置忽略大小写比对）
    if (rpType.value === 'TARGET') payload.target = rpTargetId.value;
    if (rpType.value === 'PASSCODE') payload.passcode = rpPasscode.value.trim();
    await chatApi.createRedPacket(payload);
    rpOpen.value = false;
    emit('notify', { type: 'success', message: '红包已发出' });
    // 背包已被扣减：下次打开弹窗会重新拉取清单，无需本地维护
  } catch (e) {
    emit('notify', { type: 'error', message: extractApiMessage(e, '红包发送失败') });
  } finally {
    rpSubmitting.value = false;
  }
}

/**
 * 红包卡片展示状态：优先取 store 里的实时视图（socket 推送 / 接口拉取），
 * 视图缺失（如状态接口失败）时退化为只读展示，避免用户点了没反应。
 * @param {object} m 聊天消息（type='redpacket'）
 */
function rpState(m) {
  const view = chat.redPackets[m.refId] || m.redPacket || null;
  const mine = isMine(m);
  if (!view) {
    return {
      id: m.refId,
      title: '🧧 世界红包',
      sub: m.content || '道具红包',
      greeting: '',
      progress: '状态加载中…',
      mine: false,
      done: false,
      btnText: '领取',
      disabled: true,
      packetType: 'NORMAL',
      targetUserId: null,
      targetUserName: null,
      passcode: null,
      needsPasscode: false,
    };
  }
  const finished = view.status === 'FINISHED';
  const expired = view.status === 'EXPIRED' || view.expired;
  const exhausted = view.claimedCount >= view.totalCount;
  const claimedByMe = !!view.myClaim;
  const packetType = view.packetType || 'NORMAL';
  const isTargetType = packetType === 'TARGET';
  const isPasscodeType = packetType === 'PASSCODE';
  // 专属红包：指定领取人不是我 → 按钮置灰（服务端也会拦）
  const notForMe =
    isTargetType && view.targetUserId && String(view.targetUserId) !== String(props.selfId);
  let btnText = '领取';
  let disabled = false;
  if (mine) {
    btnText = '我发的';
    disabled = true;
  } else if (claimedByMe) {
    btnText = `已领 ${view.myClaim.itemName}`;
    disabled = true;
  } else if (expired) {
    btnText = '已过期';
    disabled = true;
  } else if (finished || exhausted) {
    btnText = '已抢完';
    disabled = true;
  } else if (notForMe) {
    btnText = '专属红包';
    disabled = true;
  } else if (isPasscodeType) {
    btnText = '输口令领取';
  }
  const statusText = expired ? '已过期退回' : finished || exhausted ? '已抢完' : '可领取';
  // 副标题带玩法提示：专属显示领取人；口令显示「需口令」（自己发的顺带回显自己设的口令）
  const subSuffix = isTargetType
    ? ` · 仅 ${view.targetUserName || '指定玩家'} 可领`
    : isPasscodeType
      ? mine && view.passcode
        ? ` · 我的口令「${view.passcode}」`
        : ' · 需口令'
      : '';
  return {
    id: view.id,
    title: `🧧 ${view.senderName} 的红包`,
    sub: `${view.summary || '道具红包'}${subSuffix}`,
    greeting: view.greeting || '',
    progress: `已领 ${view.claimedCount}/${view.totalCount} 份 · ${statusText}`,
    mine: claimedByMe,
    done: finished || expired || exhausted,
    btnText,
    disabled,
    packetType,
    targetUserId: view.targetUserId ?? null,
    targetUserName: view.targetUserName || null,
    passcode: view.passcode || null,
    // 需要弹口令输入才能领（口令正确性由服务端判定）
    needsPasscode: isPasscodeType && !disabled && !mine,
  };
}

/**
 * 红包卡片按钮点击：口令红包先弹出口令输入框，其余直接领取
 * @param {object} m 红包消息
 */
function onRedPacketClick(m) {
  const state = rpState(m);
  if (state.disabled) return;
  if (state.needsPasscode) {
    rpPassPrompt.value = { open: true, packetId: m.refId, value: '' };
    return;
  }
  claimRedPacket(m);
}

/** 关闭口令输入弹窗 */
function closePasscodePrompt() {
  rpPassPrompt.value.open = false;
}

/** 提交口令并领取（口令正确性由服务端判定，不对会给提示） */
async function submitPasscode() {
  const id = rpPassPrompt.value.packetId;
  const code = String(rpPassPrompt.value.value || '').trim();
  if (!id || !code) return;
  rpPassPrompt.value.open = false;
  await claimRedPacket({ refId: id }, code);
}

/** 领取红包：成功提示领到的道具，并同步卡片状态（服务端同时会广播给所有人） */
async function claimRedPacket(m, passcode = '') {
  const id = m.refId;
  if (!id || rpClaimingId.value) return;
  rpClaimingId.value = id;
  try {
    const res = await chatApi.claimRedPacket(id, passcode);
    if (res?.data?.packet) chat.upsertRedPacket(res.data.packet);
    emit('notify', {
      type: 'success',
      message: `抢到 ${res?.data?.itemName || '道具'}×${res?.data?.quantity || 1}`,
    });
  } catch (e) {
    emit('notify', { type: 'error', message: extractApiMessage(e, '领取失败，请稍后再试') });
  } finally {
    rpClaimingId.value = null;
  }
}

/** 从接口错误里取提示文案：后端异常统一返回 { message }，取不到则用兜底文案 */
function extractApiMessage(error, fallback) {
  return error?.response?.data?.message || error?.message || fallback;
}

// ---------- 发送 ----------
function onSend() {
  const text = draft.value.trim();
  if (!text || !props.connected) return;
  if (typeof props.send === 'function') {
    props.send(text);
  }
  draft.value = '';
  closeAt();
  closeCtxMenu();
  stickToBottom.value = true;
  scrollToBottom(true);
  nextTick(() => inputEl.value?.focus());
}

/** 回车发送 / @ 下拉键盘导航：下拉激活时方向键与回车优先用于选人 */
function onInputKeydown(e) {
  if (showAt.value && atCandidates.value.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      atIndex.value = Math.min(atIndex.value + 1, atCandidates.value.length - 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      atIndex.value = Math.max(atIndex.value - 1, 0);
      return;
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      pickAtPlayer(atCandidates.value[atIndex.value] || atCandidates.value[0]);
      return;
    }
    if (e.key === 'Escape') {
      // 阻止冒泡，避免 Esc 顺手把整个聊天面板也关掉
      e.preventDefault();
      e.stopPropagation();
      closeAt();
      return;
    }
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    onSend();
  }
}

// ---------- Esc ----------
function onEsc() {
  if (chat.fullscreen) chat.toggleFullscreen();
  else chat.setOpen(false);
}

function onKeydown(e) {
  if (e.key !== 'Escape') return;
  // Esc 逐层收起：我的红包 → 口令弹窗 → 发红包弹窗 → 右键菜单 → 聊天面板
  if (rpMineOpen.value) {
    rpMineOpen.value = false;
    return;
  }
  if (rpPassPrompt.value.open) {
    closePasscodePrompt();
    return;
  }
  if (rpOpen.value) {
    closeRedPacketComposer();
    return;
  }
  if (ctxMenu.value.show) {
    closeCtxMenu();
    return;
  }
  if (!chat.open) return;
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
  // 点击任意位置收起右键菜单（菜单内部点击由菜单自身处理）
  window.addEventListener('pointerdown', onGlobalPointerDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('pointerdown', onGlobalPointerDown);
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

/* ===== 世界红包卡片 ===== */
.fc-msg.rp {
  display: flex;
}
.fc-rp-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(100%, 320px);
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.28), rgba(234, 179, 8, 0.2));
  border: 1px solid rgba(239, 68, 68, 0.42);
  margin-left: 36px;
}
.fc-rp-card.mine {
  margin-left: auto;
  margin-right: 0;
}
/* 已结束（抢完/过期）的红包降低存在感，避免误点 */
.fc-rp-card.done {
  opacity: 0.72;
  filter: saturate(0.6);
}
.fc-rp-emoji {
  flex-shrink: 0;
  font-size: 26px;
  line-height: 1;
}
.fc-rp-body {
  flex: 1;
  min-width: 0;
}
.fc-rp-title {
  font-size: 12.5px;
  font-weight: 700;
  color: #fecaca;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fc-rp-sub {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 3px;
  word-break: break-all;
}
.fc-rp-greeting {
  font-size: 11px;
  color: #fcd34d;
  margin-top: 3px;
  word-break: break-all;
}
.fc-rp-progress {
  font-size: 10px;
  color: var(--muted);
  margin-top: 4px;
}
.fc-rp-btn {
  flex-shrink: 0;
  height: 30px;
  padding: 0 12px;
  border: none;
  border-radius: 999px;
  background: linear-gradient(135deg, #ef4444, #f59e0b);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}
.fc-rp-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.fc-rp-btn.claimed {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text-secondary);
}

/* ===== 未读提示条（面板开着但用户在翻历史时显示） ===== */
.fc-unread-jump {
  position: absolute;
  left: 50%;
  bottom: 62px;
  transform: translateX(-50%);
  z-index: 3;
  padding: 5px 14px;
  border: 1px solid rgba(239, 68, 68, 0.55);
  border-radius: 999px;
  background: rgba(239, 68, 68, 0.92);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
}
.fc-unread-jump:hover {
  filter: brightness(1.08);
}

/* ===== 发红包弹窗 ===== */
.fc-rp-overlay {
  position: fixed;
  inset: 0;
  z-index: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}
.fc-rp-modal {
  width: min(420px, calc(100vw - 32px));
  max-height: min(560px, calc(100vh - 64px));
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  border: 1px solid var(--border-light);
  background: rgba(24, 20, 46, 0.98);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}
.fc-rp-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.fc-rp-modal-head h3 {
  margin: 0;
  font-size: 14px;
  color: var(--text);
}
.fc-rp-modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.fc-rp-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
}
.fc-rp-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  color: var(--muted-dark);
}
.fc-rp-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fc-rp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: rgba(10, 10, 26, 0.55);
}
.fc-rp-item.picked {
  border-color: rgba(251, 191, 36, 0.55);
  background: rgba(251, 191, 36, 0.08);
}
.fc-rp-item-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fc-rp-item-owned {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--muted);
}
.fc-rp-stepper {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.fc-rp-stepper button {
  width: 24px;
  height: 24px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(139, 92, 246, 0.14);
  color: var(--text);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.fc-rp-stepper button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
/* 份数输入框：支持直接手填（宽到能放下 4~5 位数字，避免数字被截断看不清） */
.fc-rp-count-input {
  width: 48px;
  height: 24px;
  padding: 0 4px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: rgba(10, 10, 26, 0.7);
  color: #fbbf24;
  font-size: 12px;
  font-weight: 700;
  text-align: center;
  outline: none;
  -moz-appearance: textfield;
}
.fc-rp-count-input:focus {
  border-color: rgba(251, 191, 36, 0.7);
  box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.15);
}
.fc-rp-greeting-input {
  height: 34px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 12.5px;
  outline: none;
}
.fc-rp-greeting-input:focus {
  border-color: var(--accent);
}
.fc-rp-modal-foot {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  background: rgba(20, 16, 42, 0.6);
}
.fc-rp-total {
  font-size: 12px;
  color: var(--muted);
}
.fc-rp-total em {
  font-style: normal;
  color: var(--muted-dark);
}

/* ===== 红包玩法选择（普通 / 专属 / 口令） ===== */
.fc-rp-types {
  display: flex;
  gap: 6px;
}
.fc-rp-type {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 32px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: rgba(10, 10, 26, 0.55);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.fc-rp-type.active {
  border-color: rgba(251, 191, 36, 0.6);
  background: rgba(251, 191, 36, 0.12);
  color: #fbbf24;
  font-weight: 600;
}
.fc-rp-type-icon {
  font-size: 13px;
}

/* 专属红包：指定领取人的搜索与列表 */
.fc-rp-targets {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 132px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.fc-rp-target {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(10, 10, 26, 0.55);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}
.fc-rp-target:hover {
  background: rgba(139, 92, 246, 0.16);
}
.fc-rp-target-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fc-rp-target em {
  flex-shrink: 0;
  font-style: normal;
  font-size: 10px;
  color: var(--muted-dark);
}
.fc-rp-target em.on {
  color: var(--success);
}
.fc-rp-picked-target {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}
.fc-rp-picked-target strong {
  color: #fbbf24;
}
.fc-rp-clear-target {
  margin-left: auto;
  padding: 3px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
}
.fc-rp-clear-target:hover {
  color: var(--text);
  border-color: var(--border-light);
}

/* 口令红包领取弹窗：比发红包弹窗窄一些 */
.fc-rp-pass-modal {
  width: min(320px, calc(100vw - 32px));
}

/* 输入栏：position 供 @ 玩家下拉绝对定位 */
.fc-input-bar {
  position: relative;
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

/* ===== @提及 相关 ===== */
/* 气泡内的 @名字 高亮：与中央公屏 .mention-highlight 视觉一致 */
.fc-mention {
  color: #fbbf24;
  font-weight: 700;
  background: rgba(251, 191, 36, 0.12);
  border-radius: 4px;
  padding: 0 2px;
  cursor: context-menu;
}
/* 可右键 @ 的头像/昵称：给出可交互暗示（context-menu 光标 + hover 高亮） */
.fc-avatar.at-able,
.fc-name.at-able {
  cursor: context-menu;
}
.fc-avatar.at-able:hover {
  border-color: rgba(251, 191, 36, 0.55);
}
.fc-name.at-able:hover {
  text-decoration: underline;
}

/* @ 玩家下拉：在输入框上方展开 */
.fc-at-list {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: calc(100% + 6px);
  z-index: 2;
  overflow-y: auto;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid var(--border-light);
  background: rgba(20, 16, 42, 0.98);
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.5);
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.fc-at-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
}
.fc-at-item.active,
.fc-at-item:hover {
  background: rgba(139, 92, 246, 0.2);
  color: var(--text);
}
.fc-at-icon {
  color: #fbbf24;
  font-weight: 800;
}
.fc-at-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fc-at-state {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--muted-dark);
}
.fc-at-state.on {
  color: var(--success);
}

/* 右键快捷菜单（Teleport 到 body，fixed 定位） */
.fc-ctx {
  position: fixed;
  z-index: 600;
  min-width: 150px;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid var(--border-light);
  background: rgba(24, 20, 46, 0.98);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55);
}
.fc-ctx-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.fc-ctx-item:hover {
  background: rgba(139, 92, 246, 0.22);
  color: var(--text);
}
.fc-ctx-icon {
  color: #fbbf24;
  font-weight: 800;
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
