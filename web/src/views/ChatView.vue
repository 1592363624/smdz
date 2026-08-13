<template>
  <div class="chat-page">
    <!-- 左侧：在线信息与指令面板 -->
    <aside class="sidebar">
      <div class="user-card" :class="{ 'is-admin': isAdmin }" @click="onAvatarClick" :title="avatarTitle">
        <div class="avatar">
          <!-- 有 QQ 头像时显示图片，否则显示首字母 -->
          <img v-if="user?.avatar" :src="user.avatar" class="avatar-img" />
          <span v-else class="avatar-letter">{{ (user?.nickname || user?.username || '?')[0] }}</span>
        </div>
        <div>
          <div class="name">{{ user?.nickname || user?.username }}</div>
          <div class="meta">@{{ user?.username }}</div>
        </div>
      </div>

      <!-- 玩家信息面板 -->
      <div class="player-info" v-if="playerInfo">
        <div class="pi-row">
          <span class="pi-label">等级</span>
          <span class="pi-value">{{ playerInfo.level }}</span>
        </div>
        <div class="pi-row">
          <span class="pi-label">生命值</span>
          <span class="pi-value">{{ playerInfo.hp }} / {{ playerInfo.maxHp }}</span>
        </div>
        <div class="pi-hp-bar">
          <div
            class="pi-hp-fill"
            :class="hpBarClass"
            :style="{ width: hpPercent + '%' }"
          ></div>
        </div>
        <div class="pi-row">
          <span class="pi-label">位置</span>
          <span class="pi-location">{{ playerInfo.location }}</span>
        </div>
      </div>
      <div class="player-info" v-else>
        <div class="pi-row">
          <span class="pi-label">状态</span>
          <span class="pi-value" style="color: var(--muted); font-size: 12px;">未加载 信息 查看</span>
        </div>
      </div>

      <!-- 快捷操作按钮 -->
      <div class="quick-actions">
        <button class="qa-bag" @click="quickAction('背包')">🎒 背包</button>
        <button class="qa-info" @click="quickAction('信息')">📋 信息</button>
        <button class="qa-map" @click="quickAction('地图')">🗺️ 地图</button>
        <button class="qa-attack" @click="quickAction('攻击')">⚔️ 攻击</button>
      </div>

      <!-- 地图连接 -->
      <div class="map-connections" v-if="mapConnections.length">
        <h4>🗺️ 地图连接</h4>
        <div class="mc-grid">
          <span
            v-for="mc in mapConnections"
            :key="mc.name"
            class="mc-node"
            :class="{ current: mc.current }"
            @click="quickAction('go ' + mc.name)"
          >{{ mc.name }}</span>
        </div>
      </div>

      <!-- 指令列表（可折叠） -->
      <div class="section cmd-section">
        <h3 class="cmd-header" @click="cmdCollapsed = !cmdCollapsed">
          <span class="cmd-toggle">{{ cmdCollapsed ? '▶' : '▼' }}</span>
          📖 指令列表 <span class="cmd-count">({{ commands.length }})</span>
        </h3>
        <ul class="cmd-list" v-show="!cmdCollapsed">
          <li v-for="c in commands" :key="c.name" @click="quickSend(c.name)">
            <span class="cmd-name">{{ c.name }}</span>
            <span class="cmd-desc">{{ c.description }}</span>
          </li>
        </ul>
      </div>

      <button v-if="isAdmin" class="logout admin-entry" @click="router.push('/admin')">⚙️ 管理后台</button>
      <button class="logout" @click="logout">退出登录</button>
    </aside>

    <!-- 手机端遮罩层（点击关闭抽屉） -->
    <div class="mobile-overlay" :class="{ open: mobileMenuOpen }" @click="mobileMenuOpen = false"></div>

    <!-- 手机端抽屉菜单 -->
    <aside class="mobile-drawer" :class="{ open: mobileMenuOpen }">
      <div class="user-card" :class="{ 'is-admin': isAdmin }" @click="onAvatarClick" :title="avatarTitle">
        <div class="avatar">
          <img v-if="user?.avatar" :src="user.avatar" class="avatar-img" />
          <span v-else class="avatar-letter">{{ (user?.nickname || user?.username || '?')[0] }}</span>
        </div>
        <div>
          <div class="name">{{ user?.nickname || user?.username }}</div>
          <div class="meta">@{{ user?.username }}</div>
        </div>
      </div>

      <div class="player-info" v-if="playerInfo">
        <div class="pi-row">
          <span class="pi-label">等级</span>
          <span class="pi-value">{{ playerInfo.level }}</span>
        </div>
        <div class="pi-row">
          <span class="pi-label">生命值</span>
          <span class="pi-value">{{ playerInfo.hp }} / {{ playerInfo.maxHp }}</span>
        </div>
        <div class="pi-hp-bar">
          <div class="pi-hp-fill" :class="hpBarClass" :style="{ width: hpPercent + '%' }"></div>
        </div>
        <div class="pi-row">
          <span class="pi-label">位置</span>
          <span class="pi-location">{{ playerInfo.location }}</span>
        </div>
      </div>
      <div class="player-info" v-else>
        <div class="pi-row">
          <span class="pi-label">状态</span>
          <span class="pi-value" style="color: var(--muted); font-size: 12px;">未加载 信息 查看</span>
        </div>
      </div>

      <div class="quick-actions">
        <button class="qa-bag" @click="mobileMenuOpen = false; quickAction('背包')">🎒 背包</button>
        <button class="qa-info" @click="mobileMenuOpen = false; quickAction('信息')">📋 信息</button>
        <button class="qa-map" @click="mobileMenuOpen = false; quickAction('地图')">🗺️ 地图</button>
        <button class="qa-attack" @click="mobileMenuOpen = false; quickAction('攻击')">⚔️ 攻击</button>
      </div>

      <div class="map-connections" v-if="mapConnections.length">
        <h4>🗺️ 地图连接</h4>
        <div class="mc-grid">
          <span v-for="mc in mapConnections" :key="mc.name" class="mc-node" :class="{ current: mc.current }" @click="mobileMenuOpen = false; quickAction('go ' + mc.name)">{{ mc.name }}</span>
        </div>
      </div>

      <div class="section cmd-section">
        <h3 class="cmd-header" @click="cmdCollapsed = !cmdCollapsed">
          <span class="cmd-toggle">{{ cmdCollapsed ? '▶' : '▼' }}</span>
          📖 指令列表 <span class="cmd-count">({{ commands.length }})</span>
        </h3>
        <div class="cmd-body" v-show="!cmdCollapsed">
          <!-- 指令搜索 -->
          <div class="cmd-search-wrapper">
            <input class="cmd-search" v-model="cmdSearch" placeholder="搜索指令（回车选中第一条）..." @click.stop @keyup.enter="selectFirstCmd" />
            <span v-if="cmdSearch" class="cmd-search-clear" @click="cmdSearch = ''">✕</span>
          </div>
          <ul class="cmd-list">
            <li v-for="c in cmdSearchResults" :key="c.name" @click="mobileMenuOpen = false; quickSend(c.name)">
              <span class="cmd-name">{{ c.name }}</span>
              <span class="cmd-desc">{{ c.description }}</span>
            </li>
            <li v-if="cmdSearchResults.length === 0 && cmdSearch" class="cmd-empty">未匹配到指令</li>
          </ul>
        </div>
      </div>

      <button v-if="isAdmin" class="logout admin-entry" @click="mobileMenuOpen = false; router.push('/admin')">⚙️ 管理后台</button>
      <button class="logout" @click="logout">退出登录</button>
    </aside>

    <!-- 右侧：公屏聊天 -->
    <main class="chat-main">
      <header class="chat-header">
        <button class="mobile-menu-btn" @click="mobileMenuOpen = !mobileMenuOpen">
          <span class="menu-bar"></span>
          <span class="menu-bar"></span>
          <span class="menu-bar"></span>
        </button>
        <h2>💬 {{ channel?.name || '世界频道' }}</h2>
        <span class="conn-status" :class="connected ? 'on' : 'off'">
          {{ connected ? '已连接' : '连接中...' }}
        </span>
      </header>

      <!-- 消息列表 -->
      <div ref="msgList" class="messages" @scroll="onMsgScroll">
        <div v-for="(m, i) in messages" :key="i" :class="['msg', msgClass(m)]">
          <span v-if="m.sender" class="sender">{{ m.sender.nickname || m.sender.username }}：</span>
          <span v-else-if="m.type !== 'system' && m.type !== 'game' && m.type !== 'combat' && m.type !== 'info'" class="sender">系统：</span>
          <span class="content" style="white-space: pre-line">
            <template v-for="(seg, si) in parseContent(m.content)" :key="si">
              <span v-if="seg.type === 'text'">{{ seg.text }}</span>
              <span v-else class="cmd-clickable" @click="quickSend(seg.text)">{{ seg.text }}</span>
            </template>
          </span>
        </div>
        <div v-if="!messages.length" class="empty">暂无消息，发送第一条指令吧！</div>
        <!-- 回到底部按钮 -->
        <button v-if="showScrollBtn" class="scroll-bottom-btn" @click="scrollToBottom()">↓ 回到底部</button>
      </div>

      <!-- 手机端浮动快捷操作栏 -->
      <div class="mobile-float-actions">
        <button class="mfa-bag" @click="quickAction('背包')">🎒</button>
        <button class="mfa-info" @click="quickAction('信息')">📋</button>
        <button class="mfa-map" @click="quickAction('地图')">🗺️</button>
        <button class="mfa-attack" @click="quickAction('攻击')">⚔️</button>
      </div>

      <!-- 输入框 -->
      <footer class="input-bar">
        <div class="input-wrapper">
          <input
            ref="inputEl"
            v-model="input"
            @keyup.enter="sendMessage"
            @keyup="onInputKeyup"
            @keydown="onInputKeydown"
            @blur="onInputBlur"
            placeholder="开始愉快地玩耍吧!"
          />
          <!-- 指令自动补全下拉 -->
          <div v-if="showAutocomplete && filteredCommands.length" class="autocomplete-list">
            <div
              v-for="(cmd, ci) in filteredCommands"
              :key="cmd.name"
              class="ac-item"
              :class="{ active: ci === autocompleteIndex }"
              @mousedown.prevent="selectAutocomplete(cmd)"
            >
              <span class="ac-name">{{ cmd.name }}</span>
              <span class="ac-desc">{{ cmd.description }}</span>
            </div>
          </div>
        </div>
        <button @click="sendMessage" :disabled="!connected">发送</button>
      </footer>
    </main>
  </div>
</template>

<script setup>
/**
 * 公屏聊天页（增强版）
 * 核心功能：
 * - Socket.IO 实时连接后端公屏频道，接收/广播消息
 * - 输入框支持普通聊天 与 /指令，带指令自动补全
 * - 展示玩家信息面板（等级、HP、位置）
 * - 快捷操作按钮（背包、信息、地图、攻击）
 * - 地图连接显示
 * - 消息类型彩色区分（聊天、指令、系统、游戏、战斗、信息）
 */
import { ref, onMounted, onUnmounted, nextTick, computed } from 'vue';
import { useRouter } from 'vue-router';
import { io } from 'socket.io-client';
import { chatApi, commandApi, userApi, gameApi } from '../api';
import { WS_URL } from '../config';

const router = useRouter();
const user = ref(JSON.parse(localStorage.getItem('user') || 'null'));
const channel = ref(null);
const messages = ref([]);
const commands = ref([]);
const input = ref('');
const connected = ref(false);
const msgList = ref(null);
const inputEl = ref(null);
let socket = null;

// 玩家信息
const playerInfo = ref(null);
// 地图连接
const mapConnections = ref([]);

// 手机端菜单状态
const mobileMenuOpen = ref(false);

// 回到底部按钮
const showScrollBtn = ref(false);
let isUserScrolling = false;

// 指令列表折叠状态（手机端默认折叠）
const cmdCollapsed = ref(window.innerWidth < 768);

// 指令搜索
const cmdSearch = ref('');
const cmdSearchResults = computed(() => {
  const q = cmdSearch.value.trim().toLowerCase();
  if (!q) return commands.value;
  return commands.value.filter(
    c => c.name.toLowerCase().includes(q) || (c.description && c.description.toLowerCase().includes(q))
  );
});

// 自动补全状态
const showAutocomplete = ref(false);
const autocompleteIndex = ref(-1);

// 是否为管理员(显示管理后台入口)
const isAdmin = computed(() => ['ADMIN', 'SUPER_ADMIN'].includes(user.value?.role));

// 头像的 title 提示文本
const avatarTitle = computed(() => {
  if (isAdmin.value) return '点击进入管理后台';
  if (user.value?.qqNumber) return `QQ: ${user.value.qqNumber}`;
  return '点击查看用户信息';
});

// 点击头像事件：管理员跳转管理后台，普通用户显示提示
function onAvatarClick() {
  if (isAdmin.value) {
    router.push('/admin');
  } else if (user.value?.qqNumber) {
    // 复制 QQ 号到剪贴板
    navigator.clipboard.writeText(user.value.qqNumber).catch(() => {});
  }
}

// 生命值百分比
const hpPercent = computed(() => {
  if (!playerInfo.value || !playerInfo.value.maxHp) return 0;
  return Math.round((playerInfo.value.hp / playerInfo.value.maxHp) * 100);
});

// 血条颜色样式
const hpBarClass = computed(() => {
  const pct = hpPercent.value;
  if (pct <= 25) return 'low';
  if (pct <= 60) return 'medium';
  return '';
});

// 根据输入前缀过滤指令列表，用于自动补全
const filteredCommands = computed(() => {
  const text = input.value.trim();
  // 不需要 / 前缀，只要输入非空就展示自动补全
  if (!text) return [];
  const partial = text.toLowerCase();
  // 优先匹配开头，其次匹配包含
  const startsWith = commands.value.filter((c) => c.name.toLowerCase().startsWith(partial));
  const contains = commands.value.filter(
    (c) => c.name.toLowerCase().includes(partial) && !startsWith.includes(c)
  );
  return [...startsWith, ...contains].slice(0, 10);
});

// 消息样式分类（增强版：支持更多消息类型）
function msgClass(m) {
  if (m.type === 'system') return 'system';
  if (m.type === 'command') return 'command';
  if (m.type === 'game') return 'game';
  if (m.type === 'combat') return 'combat';
  if (m.type === 'info') return 'info';
  return 'chat';
}

// 解析消息内容，将指令名（被「」包裹或空格分隔的单个单词）转换为可点击片段
// 匹配模式：「指令名」或者 输入XX / 使用XX 后面的指令名
function parseContent(content) {
  if (!content) return [{ type: 'text', text: content }];

  const segments = [];
  // 匹配「指令名」模式，以及输入/使用/发送/输入指令等模式
  // 正则：匹配「([^」]+)」或者(输入|使用|发送)(\s+)([^\s]+)
  const regex = /「([^」]+)」|(输入|使用|发送)(\s+)([^\s]+)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(content)) !== null) {
    // 添加匹配前的文本
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        text: content.slice(lastIndex, match.index),
      });
    }

    // 提取指令名
    let cmdName = match[1];
    if (!cmdName) {
      // 第二种匹配模式：输入 指令名 → 匹配到 match[4]
      cmdName = match[4];
    }

    if (cmdName) {
      segments.push({
        type: 'command',
        text: cmdName.trim(),
      });
    } else {
      segments.push({
        type: 'text',
        text: match[0],
      });
    }

    lastIndex = regex.lastIndex;
  }

  // 添加剩余文本
  if (lastIndex < content.length) {
    segments.push({
      type: 'text',
      text: content.slice(lastIndex),
    });
  }

  return segments;
}

// 快速发送指令(填入输入框，便于补充参数后手动发送)
function quickSend(name) {
  input.value = name;
  showAutocomplete.value = false;
  nextTick(() => {
    inputEl.value?.focus();
  });
}

// 快捷操作按钮 — 直接发送对应指令
function quickAction(action) {
  if (!socket) return;
  socket.emit('chat:message', { content: action });
}

// 指令搜索回车选中第一条
function selectFirstCmd() {
  if (cmdSearchResults.value.length > 0) {
    mobileMenuOpen.value = false;
    quickSend(cmdSearchResults.value[0].name);
  }
}

// 输入框键盘事件：控制自动补全
function onInputKeyup() {
  if (filteredCommands.value.length && input.value.trim()) {
    showAutocomplete.value = true;
    // 重置选中索引
    if (autocompleteIndex.value >= filteredCommands.value.length) {
      autocompleteIndex.value = 0;
    }
  } else {
    showAutocomplete.value = false;
  }
}

function onInputKeydown(e) {
  if (!showAutocomplete.value || !filteredCommands.value.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    autocompleteIndex.value = Math.min(autocompleteIndex.value + 1, filteredCommands.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    autocompleteIndex.value = Math.max(autocompleteIndex.value - 1, 0);
  } else if (e.key === 'Tab' || e.key === 'Enter') {
    if (autocompleteIndex.value >= 0 && autocompleteIndex.value < filteredCommands.value.length) {
      e.preventDefault();
      selectAutocomplete(filteredCommands.value[autocompleteIndex.value]);
    }
  } else if (e.key === 'Escape') {
    showAutocomplete.value = false;
  }
}

function onInputBlur() {
  // 延迟关闭，让 mousedown 事件有机会触发
  setTimeout(() => {
    showAutocomplete.value = false;
  }, 200);
}

function selectAutocomplete(cmd) {
  input.value = cmd.name + ' ';
  showAutocomplete.value = false;
  autocompleteIndex.value = -1;
  nextTick(() => {
    inputEl.value?.focus();
  });
}

async function sendMessage() {
  const content = input.value.trim();
  if (!content || !socket) return;
  // 通过 WebSocket 发送(后端自动判断聊天或指令)
  socket.emit('chat:message', { content });
  input.value = '';
  showAutocomplete.value = false;
}

function appendMessage(msg) {
  messages.value.push(msg);
  // 限制本地消息数量，防止内存增长
  if (messages.value.length > 300) {
    messages.value.splice(0, messages.value.length - 300);
  }
  // 用户没有手动滚动时，自动滚动到底部
  if (!isUserScrolling) {
    scrollToBottom();
  }
}

function scrollToBottom() {
  showScrollBtn.value = false;
  isUserScrolling = false;
  nextTick(() => {
    if (msgList.value) {
      msgList.value.scrollTop = msgList.value.scrollHeight;
    }
  });
}

// 消息滚动监听 - 检测用户是否手动向上滚动
function onMsgScroll() {
  if (!msgList.value) return;
  const el = msgList.value;
  const threshold = 150;
  const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  if (!isNearBottom) {
    if (!isUserScrolling) {
      isUserScrolling = true;
      showScrollBtn.value = true;
    }
  } else {
    showScrollBtn.value = false;
    isUserScrolling = false;
  }
}

function logout() {
  socket?.disconnect();
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  router.push('/login');
}

// 加载玩家信息和地图连接
async function loadPlayerInfo() {
  try {
    const res = await gameApi.playerInfo();
    playerInfo.value = res.data;
  } catch {
    // 玩家信息接口可能不存在，静默忽略
  }
}

async function loadMapConnections() {
  try {
    const res = await gameApi.mapConnections();
    mapConnections.value = res.data;
  } catch {
    // 地图连接接口可能不存在，静默忽略
  }
}

// 移动端视图高度修复函数
let setViewportHeight = null;

onMounted(async () => {
  try {
    // 移动端视图高度修复：动态计算实际可视高度，避免键盘弹出时布局错乱
    setViewportHeight = () => {
      const vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty('--vh', `${vh}px`);
    };
    setViewportHeight();
    window.addEventListener('resize', setViewportHeight);

    // 加载频道和历史消息
    const ch = await chatApi.getChannel();
    channel.value = ch.data;
    const msgs = await chatApi.getMessages(ch.data.id, 50);
    messages.value = msgs.data;
    // 加载指令列表
    const cmds = await commandApi.list();
    commands.value = cmds.data;
    // 加载玩家信息和地图连接
    await Promise.allSettled([loadPlayerInfo(), loadMapConnections()]);

    // 建立 WebSocket 连接(携带 token 认证)
    // 开发环境直连后端，生产环境走同源代理
    const token = localStorage.getItem('token');
    socket = io(WS_URL, {
      auth: { token },
      transports: ['websocket'],
    });

    socket.on('connect', () => {
      connected.value = true;
    });
    socket.on('disconnect', () => {
      connected.value = false;
    });
    // 接收公屏消息(聊天、指令结果广播、系统消息)
    socket.on('chat:message', (msg) => {
      appendMessage(msg);
    });
    // 接收玩家信息更新事件
    socket.on('player:update', (data) => {
      if (data) {
        playerInfo.value = data;
      }
    });
    // 接收地图连接更新事件
    socket.on('map:update', (data) => {
      if (data && data.connections) {
        mapConnections.value = data.connections;
      }
    });
    socket.on('error', (e) => {
      console.error('socket error', e);
    });

    scrollToBottom();
  } catch (e) {
    console.error('加载失败', e);
  }
});

onUnmounted(() => {
  socket?.disconnect();
  window.removeEventListener('resize', setViewportHeight);
});
</script>