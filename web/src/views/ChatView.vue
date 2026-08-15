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

      <!-- 地图总览 -->
      <div class="map-connections" v-if="mapOverview">
        <h4>🗺️ 地图总览</h4>
        <!-- 当前所在地图 -->
        <div class="mc-current">
          📍 {{ mapOverview.currentMap.name }}
          <span class="mc-detail" v-if="mapOverview.currentMap.monsters || mapOverview.currentMap.resources || mapOverview.currentMap.npcs">
            （怪物{{ mapOverview.currentMap.monsters }} · 资源{{ mapOverview.currentMap.resources }} · NPC{{ mapOverview.currentMap.npcs }}）
          </span>
        </div>
        <!-- 子区域（可前往） -->
        <div class="mc-block" v-if="mapOverview.subMaps.length">
          <div class="mc-block-title">子区域</div>
          <div class="mc-grid">
            <span
              v-for="mc in mapOverview.subMaps"
              :key="'sub-' + mc.name"
              class="mc-node"
              @click="quickAction('go ' + mc.name)"
            >{{ mc.name }}</span>
          </div>
        </div>
        <!-- 全部地图 -->
        <div class="mc-block">
          <div class="mc-block-title mc-fold" @click="allMapsCollapsed = !allMapsCollapsed">
            <span class="mc-caret">{{ allMapsCollapsed ? '▶' : '▼' }}</span>
            全部地图（{{ mapOverview.allMaps.length }}）
          </div>
          <div class="mc-grid" v-show="!allMapsCollapsed">
            <span
              v-for="mc in mapOverview.allMaps"
              :key="'all-' + mc.name"
              class="mc-node"
              :class="{ current: mc.isCurrent, reachable: mc.isReachable }"
              @click="quickAction('go ' + mc.name)"
            >{{ mc.name }}</span>
          </div>
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

      <!-- 底部状态栏：连接状态 + 总人数 + 在线人数 -->
      <div class="sidebar-status">
        <span class="ss-dot" :class="connected ? 'on' : 'off'"></span>
        <span class="ss-text">
          <span class="ss-conn" :class="connected ? 'on' : 'off'">{{ connected ? '已连接' : '未连接' }}</span>
        </span>
        <span class="ss-divider"></span>
        <span class="ss-text">
          <span class="ss-label">总人数</span>
          <span class="ss-value">{{ serverStats.totalPlayers }}</span>
        </span>
        <span class="ss-divider"></span>
        <span class="ss-text">
          <span class="ss-label">在线</span>
          <span class="ss-value ss-online">{{ serverStats.onlinePlayers }}</span>
        </span>
      </div>
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

      <div class="map-connections" v-if="mapOverview">
        <h4>🗺️ 地图总览</h4>
        <!-- 当前所在地图 -->
        <div class="mc-current">
          📍 {{ mapOverview.currentMap.name }}
          <span class="mc-detail" v-if="mapOverview.currentMap.monsters || mapOverview.currentMap.resources || mapOverview.currentMap.npcs">
            （怪物{{ mapOverview.currentMap.monsters }} · 资源{{ mapOverview.currentMap.resources }} · NPC{{ mapOverview.currentMap.npcs }}）
          </span>
        </div>
        <!-- 子区域（可前往） -->
        <div class="mc-block" v-if="mapOverview.subMaps.length">
          <div class="mc-block-title">子区域</div>
          <div class="mc-grid">
            <span v-for="mc in mapOverview.subMaps" :key="'msub-' + mc.name" class="mc-node" @click="mobileMenuOpen = false; quickAction('go ' + mc.name)">{{ mc.name }}</span>
          </div>
        </div>
        <!-- 全部地图 -->
        <div class="mc-block">
          <div class="mc-block-title mc-fold" @click="allMapsCollapsed = !allMapsCollapsed">
            <span class="mc-caret">{{ allMapsCollapsed ? '▶' : '▼' }}</span>
            全部地图（{{ mapOverview.allMaps.length }}）
          </div>
          <div class="mc-grid" v-show="!allMapsCollapsed">
            <span v-for="mc in mapOverview.allMaps" :key="'mall-' + mc.name" class="mc-node" :class="{ current: mc.isCurrent, reachable: mc.isReachable }" @click="mobileMenuOpen = false; quickAction('go ' + mc.name)">{{ mc.name }}</span>
          </div>
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

      <!-- 手机端底部状态栏 -->
      <div class="sidebar-status">
        <span class="ss-dot" :class="connected ? 'on' : 'off'"></span>
        <span class="ss-text">
          <span class="ss-conn" :class="connected ? 'on' : 'off'">{{ connected ? '已连接' : '未连接' }}</span>
        </span>
        <span class="ss-divider"></span>
        <span class="ss-text">
          <span class="ss-label">总人数</span>
          <span class="ss-value">{{ serverStats.totalPlayers }}</span>
        </span>
        <span class="ss-divider"></span>
        <span class="ss-text">
          <span class="ss-label">在线</span>
          <span class="ss-value ss-online">{{ serverStats.onlinePlayers }}</span>
        </span>
      </div>
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
        <div class="header-right">
          <span class="version-tag" title="当前版本">v{{ APP_VERSION }}</span>
          <a class="reborn-link" href="http://xx.52shell.ltd" target="_blank" rel="noopener noreferrer">《重生之凡人修仙》</a>
        </div>
      </header>

      <!-- 消息列表 -->
      <div ref="msgList" class="messages" @scroll="onMsgScroll">
        <div v-for="(m, i) in messages" :key="i" :class="['msg', msgClass(m)]">
          <div class="msg-body">
            <span v-if="m.sender" class="sender">{{ m.sender.nickname || m.sender.username }}：</span>
            <span v-else-if="m.type !== 'system' && m.type !== 'game' && m.type !== 'combat' && m.type !== 'info'" class="sender">系统：</span>
            <span class="content" style="white-space: pre-line">
              <template v-for="(seg, si) in parseContent(m.content, commands)" :key="si">
                <span v-if="seg.type === 'text'">{{ seg.text }}</span>
                <span v-else class="cmd-clickable" :title="'左键点击发送 / 右键填入输入框「' + seg.text + '」'" @click="quickSend(seg.text)" @contextmenu.prevent="quickFill(seg.text)">{{ seg.displayText || seg.text }}</span>
              </template>
            </span>
          </div>
          <span class="msg-time">{{ formatTime(m.createdAt) }}</span>
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
import { WS_URL, APP_VERSION } from '../config';

const router = useRouter();
const user = ref(JSON.parse(localStorage.getItem('user') || 'null'));
const channel = ref(null);
const messages = ref([]);
const commands = ref([]);
const input = ref('');
const connected = ref(false);
const msgList = ref(null);
const inputEl = ref(null);

// 服务器统计（总人数、在线人数）
const serverStats = ref({ totalPlayers: 0, onlinePlayers: 0 });
let statsTimer = null;
let socket = null;

// 玩家信息
const playerInfo = ref(null);
// 地图总览（当前区域 + 全部地图）
const mapOverview = ref(null);
// 全部地图是否折叠（默认折叠，保持面板简洁）
const allMapsCollapsed = ref(true);

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

/**
 * 解析消息内容，将可点击的指令名转换为可交互片段
 *
 * 匹配规则（按优先级）：
 *   1. 「指令名」—— 中文书名号包裹的精确指令名（最高优先级）
 *   2. 💡 输入/使用/发送 指令名 说明文字 —— 后端提示格式，提取动词后的第一个词作为指令名
 *
 * 关键修复：原正则 /(输入|使用|发送)(\s+)([^\s]+)/g 会错误匹配
 *   "💡 输入 背包 查看你拥有的物品" → 把"查看你拥有的物品"当指令名
 *   原因：正则把"输入"后的第一个词(背包)当成前缀的一部分，取了后面的词。
 *   新逻辑：明确"输入/使用/发送"后的第一个独立词就是指令名，后面的是说明文字。
 *
 * @param {string} content - 原始消息文本
 * @param {Array} cmdList - 已加载的指令列表（用于验证指令名有效性）
 * @returns {Array} 解析后的片段数组，每项 { type: 'text'|'command', text, displayText?, source? }
 */
function parseContent(content, cmdList) {
  if (!content) return [{ type: 'text', text: content }];

  const segments = [];
  // 构建已知指令名集合（用于验证提取的指令名是否有效，避免误导用户点击无效内容）
  const validCmdNames = new Set((cmdList || []).map(c => c.name));
  const validCmdAliases = new Set(
    (cmdList || []).flatMap(c => (c.alias || '').split(',').map(a => a.trim()).filter(Boolean))
  );

  let lastIndex = 0;

  // 模式1：「指令名」—— 精确匹配，优先级最高
  const bookEndRegex = /「([^」]+)」/g;
  let match;
  while ((match = bookEndRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: content.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'command', text: match[1].trim(), source: 'bookend' });
    lastIndex = bookEndRegex.lastIndex;
  }

  // 对剩余文本处理模式2：💡 提示类指令（整行匹配）
  if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex);
    // 匹配以 💡 开头的提示行：💡 + 动词 + 指令名 + 可选说明文字
    // 关键改进：明确动词后的第一个独立词是指令名，后面都是说明
    const hintRegex = /^💡\s*(输入|使用|发送|试试|尝试)\s+([^\s]+)(?:\s+(.*?))?$/gm;
    let hintLastIdx = 0;
    let hintMatch;

    while ((hintMatch = hintRegex.exec(remaining)) !== null) {
      // 提示前的普通文本
      if (hintMatch.index > hintLastIdx) {
        segments.push({ type: 'text', text: remaining.slice(hintLastIdx, hintMatch.index) });
      }

      const candidateCmd = hintMatch[2].trim(); // 动词后的第一个词，如"背包"、"装备"
      const description = (hintMatch[3] || '').trim(); // 后续说明文字

      // 验证候选指令名是否是有效的已知指令（核心防错机制）
      const isValidCmd = validCmdNames.has(candidateCmd) || validCmdAliases.has(candidateCmd);

      if (isValidCmd && candidateCmd) {
        // 有效指令：显示完整文字（指令名+说明），但点击只发送纯净指令名
        segments.push({
          type: 'command',
          text: candidateCmd,
          displayText: description ? `${candidateCmd} ${description}` : candidateCmd,
          source: 'hint',
        });
      } else {
        // 不是已知指令 → 作为普通文本显示（避免用户点了无效内容报错）
        segments.push({ type: 'text', text: hintMatch[0] });
      }

      hintLastIdx = hintRegex.lastIndex;
    }

    // 剩余未匹配的文本
    if (hintLastIdx < remaining.length) {
      segments.push({ type: 'text', text: remaining.slice(hintLastIdx) });
    }
  }

  // 如果没有任何匹配，返回原始文本
  if (segments.length === 0) {
    return [{ type: 'text', text: content }];
  }

  return segments;
}

/**
 * 快速发送指令（智能模式）
 * - 如果指令不需要参数（argsSchema 为空数组）→ 直接通过 socket 发送
 * - 否则 → 填入输入框，便于补充参数后手动发送
 * @param {string} name - 指令名
 */
function quickSend(name) {
  if (!name) return;
  // 查找该指令是否需要参数（通过 argsSchema 判断）
  const cmd = commands.value.find(c => c.name === name);
  // argsSchema 为空数组 "[]" 或不存在时，视为无参数指令，直接发送
  const needParams = cmd && cmd.argsSchema && cmd.argsSchema !== '[]';
  if (!needParams) {
    // 无参数指令 → 直接发送
    if (socket) {
      socket.emit('chat:message', { content: name });
    } else {
      // socket 未连接时降级为填入输入框
      input.value = name;
      nextTick(() => inputEl.value?.focus());
    }
  } else {
    // 需要参数的指令 → 填入输入框并聚焦，让用户补充参数
    input.value = name + ' ';
    showAutocomplete.value = false;
    nextTick(() => inputEl.value?.focus());
  }
}

// 快捷操作按钮 — 直接发送对应指令
function quickAction(action) {
  if (!socket) return;
  socket.emit('chat:message', { content: action });
}

/**
 * 右键点击提示指令：将指令内容填入输入框（不发送）
 * 便于用户先查看/补充参数，确认后再手动发送
 * @param {string} name - 指令名
 */
function quickFill(name) {
  if (!name) return;
  input.value = name + ' ';
  showAutocomplete.value = false;
  nextTick(() => inputEl.value?.focus());
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
  if (!msg) return;
  // 兜底：socket 实时消息若缺少时间戳，则补当前时间，保证每条消息都能显示精确到秒的时间
  if (!msg.createdAt) msg.createdAt = new Date().toISOString();
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

/**
 * 格式化消息时间（精确到秒）
 * @param ts 时间戳/ISO字符串
 * @returns HH:mm:ss，非法或缺失时返回空字符串
 */
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

async function loadMapOverview() {
  try {
    const res = await gameApi.mapOverview();
    mapOverview.value = res.data;
  } catch {
    // 地图总览接口可能不存在，静默忽略
  }
}

// 加载服务器统计（总人数、在线人数）
async function loadServerStats() {
  try {
    const res = await gameApi.stats();
    serverStats.value = res.data;
  } catch {
    // 统计接口可能暂不可用，静默忽略
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
    // 加载玩家信息和地图总览
    await Promise.allSettled([loadPlayerInfo(), loadMapOverview()]);
    // 加载服务器统计
    loadServerStats();
    // 每 30 秒刷新一次服务器统计
    statsTimer = setInterval(loadServerStats, 30000);

    // 建立 WebSocket 连接(携带 token 认证)
    // 开发环境直连后端，生产环境走同源代理
    const token = localStorage.getItem('token');
    socket = io(WS_URL, {
      auth: { token },
      transports: ['websocket'],
    });

    socket.on('connect', () => {
      connected.value = true;
      // 连接建立后再刷新一次统计，确保自己立刻计入在线人数
      loadServerStats();
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
    // 接收地图总览更新事件（移动到达后由服务端定向推送）
    socket.on('map:update', (data) => {
      if (data && data.overview) {
        mapOverview.value = data.overview;
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
  if (statsTimer) clearInterval(statsTimer);
});
</script>