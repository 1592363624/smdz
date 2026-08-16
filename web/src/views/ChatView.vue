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

      <!-- QQ 绑定区域：玩家自行绑定/更换QQ号，供群里机器人识别身份 -->
      <div class="qq-bind">
        <template v-if="user?.qqNumber && !qqBinding">
          <span class="qq-bound">✅ 已绑定 QQ: {{ user.qqNumber }}</span>
          <button class="qq-btn" @click="openQQBind">更换</button>
        </template>
        <template v-else>
          <div class="qq-bind-row">
            <input v-model="qqInput" class="qq-input" placeholder="输入你的QQ号" maxlength="12" @keyup.enter="bindQQ" />
            <button class="qq-btn primary" :disabled="qqBusy" @click="bindQQ">{{ qqBusy ? '绑定中…' : (user?.qqNumber ? '保存' : '绑定') }}</button>
          </div>
          <div v-if="qqError" class="qq-error">{{ qqError }}</div>
          <div class="qq-tip">绑定后可在QQ群用同号机器人发送“smdz 指令”操作本账号</div>
        </template>
      </div>

      <!-- 玩家信息面板 -->
      <div class="player-info" v-if="playerInfo">
        <div class="pi-header">
          <span class="pi-name">{{ playerInfo.name || '冒险者' }}</span>
          <span class="pi-type" v-if="playerInfo.type">{{ playerInfo.type }}</span>
        </div>
        <div class="pi-row">
          <span class="pi-label">等级</span>
          <span class="pi-value">Lv.{{ playerInfo.level }}</span>
        </div>
        <div class="pi-bar-row">
          <div class="pi-bar-label"><span>经验</span><span>{{ playerInfo.exp }}/{{ playerInfo.upgradeExp }}</span></div>
          <div class="pi-bar"><div class="pi-bar-fill exp" :style="{ width: expPercent + '%' }"></div></div>
        </div>
        <div class="pi-row">
          <span class="pi-label">❤️ 生命</span>
          <span class="pi-value">{{ Math.round(playerInfo.hp) }} / {{ Math.round(playerInfo.maxHp) }}</span>
        </div>
        <div class="pi-bar"><div class="pi-bar-fill hp" :class="hpBarClass" :style="{ width: hpPercent + '%' }"></div></div>
        <div class="pi-row">
          <span class="pi-label">🛡️ 护盾</span>
          <span class="pi-value">{{ Math.round(playerInfo.shield) }} / {{ Math.round(playerInfo.maxShield) }}</span>
        </div>
        <div class="pi-bar"><div class="pi-bar-fill shield" :style="{ width: shieldPercent + '%' }"></div></div>
        <div class="pi-row">
          <span class="pi-label">🛡️ 装甲</span>
          <span class="pi-value">{{ Math.round(playerInfo.armor) }} / {{ Math.round(playerInfo.maxArmor) }}</span>
        </div>
        <div class="pi-bar"><div class="pi-bar-fill armor" :style="{ width: armorPercent + '%' }"></div></div>
        <div class="pi-stats">
          <div class="pi-stat"><span>攻击</span><b>{{ Math.round(playerInfo.attack) }}</b></div>
          <div class="pi-stat"><span>防御</span><b>{{ Math.round(playerInfo.defense) }}</b></div>
          <div class="pi-stat"><span>速度</span><b>{{ Math.round(playerInfo.speed) }}</b></div>
          <div class="pi-stat"><span>闪避</span><b>{{ Math.round(playerInfo.dodge) }}</b></div>
          <div class="pi-stat"><span>命中</span><b>{{ Math.round(playerInfo.hit) }}</b></div>
          <div class="pi-stat"><span>暴击</span><b>{{ Math.round(playerInfo.crit) }}%</b></div>
        </div>
        <div class="pi-row pi-row-loc">
          <span class="pi-label">📍 位置</span>
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

      <!-- 手机端：QQ 绑定区域 -->
      <div class="qq-bind">
        <template v-if="user?.qqNumber && !qqBinding">
          <span class="qq-bound">✅ 已绑定 QQ: {{ user.qqNumber }}</span>
          <button class="qq-btn" @click="openQQBind">更换</button>
        </template>
        <template v-else>
          <div class="qq-bind-row">
            <input v-model="qqInput" class="qq-input" placeholder="输入你的QQ号" maxlength="12" @keyup.enter="bindQQ" />
            <button class="qq-btn primary" :disabled="qqBusy" @click="bindQQ">{{ qqBusy ? '绑定中…' : (user?.qqNumber ? '保存' : '绑定') }}</button>
          </div>
          <div v-if="qqError" class="qq-error">{{ qqError }}</div>
          <div class="qq-tip">绑定后可在QQ群用同号机器人发送“smdz 指令”操作本账号</div>
        </template>
      </div>

      <div class="player-info" v-if="playerInfo">
        <div class="pi-header">
          <span class="pi-name">{{ playerInfo.name || '冒险者' }}</span>
          <span class="pi-type" v-if="playerInfo.type">{{ playerInfo.type }}</span>
        </div>
        <div class="pi-row">
          <span class="pi-label">等级</span>
          <span class="pi-value">Lv.{{ playerInfo.level }}</span>
        </div>
        <div class="pi-bar-row">
          <div class="pi-bar-label"><span>经验</span><span>{{ playerInfo.exp }}/{{ playerInfo.upgradeExp }}</span></div>
          <div class="pi-bar"><div class="pi-bar-fill exp" :style="{ width: expPercent + '%' }"></div></div>
        </div>
        <div class="pi-row">
          <span class="pi-label">❤️ 生命</span>
          <span class="pi-value">{{ Math.round(playerInfo.hp) }} / {{ Math.round(playerInfo.maxHp) }}</span>
        </div>
        <div class="pi-bar"><div class="pi-bar-fill hp" :class="hpBarClass" :style="{ width: hpPercent + '%' }"></div></div>
        <div class="pi-row">
          <span class="pi-label">🛡️ 护盾</span>
          <span class="pi-value">{{ Math.round(playerInfo.shield) }} / {{ Math.round(playerInfo.maxShield) }}</span>
        </div>
        <div class="pi-bar"><div class="pi-bar-fill shield" :style="{ width: shieldPercent + '%' }"></div></div>
        <div class="pi-row">
          <span class="pi-label">�️ 装甲</span>
          <span class="pi-value">{{ Math.round(playerInfo.armor) }} / {{ Math.round(playerInfo.maxArmor) }}</span>
        </div>
        <div class="pi-bar"><div class="pi-bar-fill armor" :style="{ width: armorPercent + '%' }"></div></div>
        <div class="pi-stats">
          <div class="pi-stat"><span>攻击</span><b>{{ Math.round(playerInfo.attack) }}</b></div>
          <div class="pi-stat"><span>防御</span><b>{{ Math.round(playerInfo.defense) }}</b></div>
          <div class="pi-stat"><span>速度</span><b>{{ Math.round(playerInfo.speed) }}</b></div>
          <div class="pi-stat"><span>闪避</span><b>{{ Math.round(playerInfo.dodge) }}</b></div>
          <div class="pi-stat"><span>命中</span><b>{{ Math.round(playerInfo.hit) }}</b></div>
          <div class="pi-stat"><span>暴击</span><b>{{ Math.round(playerInfo.crit) }}%</b></div>
        </div>
        <div class="pi-row pi-row-loc">
          <span class="pi-label">📍 位置</span>
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
          <!-- 私聊入口按钮（带未读红点） -->
          <button class="header-action-btn" title="私聊" @click="togglePrivatePanel">
            💬 私聊
            <span v-if="unreadPrivateCount > 0" class="unread-badge">{{ unreadPrivateCount > 99 ? '99+' : unreadPrivateCount }}</span>
          </button>
          <!-- 反馈入口按钮 -->
          <button class="header-action-btn" title="反馈" @click="toggleFeedbackPanel">📝 反馈</button>
          <a class="reborn-link" href="http://xx.52shell.ltd" target="_blank" rel="noopener noreferrer">《重生之凡人修仙》</a>
        </div>
      </header>

      <!-- 消息列表 -->
      <div ref="msgList" class="messages" @scroll="onMsgScroll">
        <div v-for="(m, i) in messages" :key="i" :class="['msg', msgClass(m), msgAlign(m)]">
          <div class="msg-body">
            <span v-if="m.sender" class="sender">{{ m.sender.nickname || m.sender.username }}：</span>
            <span v-else-if="m.type !== 'system' && m.type !== 'game' && m.type !== 'combat' && m.type !== 'info'" class="sender">系统：</span>
            <span class="content" style="white-space: pre-line">
              <template v-for="(seg, si) in parseContent(m.content, commands)" :key="si">
                <span v-if="seg.type === 'text'">{{ seg.text }}</span>
                <span v-else-if="seg.type === 'mention'" class="mention-highlight">{{ seg.text }}</span>
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

    <!-- 桌面端右栏：当前地图详情 + 怪物/资源/NPC -->
    <aside class="info-panel">
      <div class="ip-block">
        <h4 class="ip-title">📍 当前地图</h4>
        <div class="ip-map-name">{{ mapOverview?.currentMap?.name || playerInfo?.location || '未知' }}</div>
        <div class="ip-map-desc" v-if="mapOverview?.currentMap?.description">{{ mapOverview.currentMap.description }}</div>
        <div class="ip-map-desc" v-else-if="playerInfo?.location">{{ playerInfo.location }} 的冒险区域</div>
      </div>

      <div class="ip-block" v-if="mapOverview?.currentMap">
        <h4 class="ip-title">👾 怪物 ({{ mapOverview.currentMap.monsters || 0 }})</h4>
        <div class="ip-list" v-if="mapOverview.currentMap.monsterList?.length">
          <div v-for="m in mapOverview.currentMap.monsterList" :key="'cur-mon-' + m.name" class="ip-row">
            <span class="ip-row-name">💀 {{ m.name }}</span>
            <span class="ip-row-meta">Lv.{{ m.level }} · HP {{ Math.round(m.hp || 0) }}</span>
          </div>
        </div>
        <div class="ip-empty" v-else>该地图暂无怪物</div>
      </div>

      <div class="ip-block" v-if="mapOverview?.currentMap">
        <h4 class="ip-title">⛏️ 资源 ({{ mapOverview.currentMap.resources || 0 }})</h4>
        <div class="ip-list" v-if="mapOverview.currentMap.resourceList?.length">
          <div v-for="r in mapOverview.currentMap.resourceList" :key="'cur-res-' + r.name" class="ip-row">
            <span class="ip-row-name">📦 {{ r.name }}</span>
            <span class="ip-row-meta">×{{ r.count }} · {{ r.gatherCmd || '采集' }}</span>
          </div>
        </div>
        <div class="ip-empty" v-else>该地图暂无资源</div>
      </div>

      <div class="ip-block" v-if="mapOverview?.currentMap">
        <h4 class="ip-title">💬 NPC ({{ mapOverview.currentMap.npcs || 0 }})</h4>
        <div class="ip-list" v-if="mapOverview.currentMap.npcList?.length">
          <div v-for="n in mapOverview.currentMap.npcList" :key="'cur-npc-' + n.name" class="ip-row npc-row" @click="quickAction('对话 ' + n.name)">
            <span class="ip-row-name">🗨️ {{ n.name }}</span>
            <span class="ip-row-meta" v-if="n.title">{{ n.title }}</span>
          </div>
        </div>
        <div class="ip-empty" v-else>该地图暂无 NPC</div>
      </div>

      <div class="ip-block">
        <h4 class="ip-title">🧭 可前往 ({{ mapOverview?.subMaps?.length || 0 }})</h4>
        <div class="ip-links" v-if="mapOverview?.subMaps?.length">
          <span
            v-for="mc in mapOverview.subMaps"
            :key="'rs-' + mc.name"
            class="ip-link"
            @click="quickAction('go ' + mc.name)"
          >{{ mc.name }}</span>
        </div>
        <div class="ip-empty" v-else>当前地图为孤立区域</div>
      </div>
    </aside>

    <!-- 私聊面板（右侧滑出覆盖层） -->
    <div v-if="privatePanelOpen" class="panel-overlay" @click.self="closePrivatePanel">
      <aside class="side-panel private-panel">
        <header class="panel-header">
          <h3>💬 私聊</h3>
          <button class="panel-close" title="关闭" @click="closePrivatePanel">✕</button>
        </header>
        <div class="private-body">
          <!-- 左侧：会话列表 -->
          <div class="conv-list">
            <div
              v-for="conv in privateConversations"
              :key="conv.peerId"
              class="conv-item"
              :class="{ active: privatePeerId === conv.peerId }"
              @click="openPrivateConversation(conv)"
            >
              <div class="conv-top">
                <span class="conv-name">{{ conv.peer?.nickname || conv.peer?.username || '玩家' }}</span>
                <span v-if="conv.unread > 0" class="conv-unread">{{ conv.unread > 99 ? '99+' : conv.unread }}</span>
              </div>
              <div class="conv-preview">{{ conv.lastMessage || '' }}</div>
            </div>
            <div v-if="!privateConversations.length" class="panel-empty">暂无私聊会话</div>
          </div>
          <!-- 右侧：聊天窗口 -->
          <div class="private-chat">
            <div class="private-msgs" v-if="privatePeerId">
              <div
                v-for="(pm, pi) in privateMessages"
                :key="pm.id || pi"
                :class="['pmsg', pm.senderId === user?.id ? 'own' : 'other']"
              >
                <span class="pmsg-sender">{{ pm.sender?.nickname || pm.sender?.username || '未知' }}：</span>
                <span class="pmsg-content" style="white-space: pre-line">{{ pm.content }}</span>
                <span class="pmsg-time">{{ formatTime(pm.createdAt) }}</span>
              </div>
              <div v-if="!privateMessages.length" class="panel-empty">暂无消息，发送第一条私聊吧！</div>
            </div>
            <div v-else class="panel-empty">选择左侧会话开始私聊</div>
            <footer class="panel-input-bar">
              <input
                v-model="privateInput"
                :disabled="!privatePeerId || !connected"
                placeholder="输入私聊内容..."
                @keyup.enter="sendPrivateMessage"
              />
              <button :disabled="!privatePeerId || !connected" @click="sendPrivateMessage">发送</button>
            </footer>
          </div>
        </div>
      </aside>
    </div>

    <!-- 反馈面板（右侧滑出覆盖层） -->
    <div v-if="feedbackPanelOpen" class="panel-overlay" @click.self="closeFeedbackPanel">
      <aside class="side-panel feedback-panel">
        <header class="panel-header">
          <h3>📝 反馈</h3>
          <button class="panel-new-btn" @click="startNewFeedback">＋ 新建反馈</button>
          <button class="panel-close" title="关闭" @click="closeFeedbackPanel">✕</button>
        </header>
        <div class="feedback-body">
          <!-- 新建反馈表单 -->
          <div v-if="feedbackView === 'create'" class="fb-create">
            <label class="fb-label">标题</label>
            <input v-model="fbForm.title" class="fb-input" maxlength="100" placeholder="简要描述问题或建议" />
            <label class="fb-label">分类</label>
            <select v-model="fbForm.category" class="fb-input">
              <option value="general">一般问题</option>
              <option value="bug">Bug 反馈</option>
              <option value="suggestion">功能建议</option>
            </select>
            <label class="fb-label">内容</label>
            <textarea v-model="fbForm.content" class="fb-input fb-textarea" placeholder="请详细描述你遇到的问题或建议..." rows="4"></textarea>
            <label class="fb-label">附件</label>
            <input type="file" multiple class="fb-file" @change="onFbFilesChange" />
            <div v-if="fbUploadedUrls.length" class="fb-file-list">
              <span v-for="(u, ui) in fbUploadedUrls" :key="ui" class="fb-file-item">📎 {{ fileName(u) }}</span>
            </div>
            <div class="fb-form-actions">
              <button class="fb-cancel" @click="feedbackView = 'list'">取消</button>
              <button class="fb-submit" :disabled="fbSubmitting" @click="submitFeedback">{{ fbSubmitting ? '提交中...' : '提交' }}</button>
            </div>
          </div>
          <!-- 我的反馈列表 + 详情 -->
          <template v-else>
            <div class="fb-list">
              <div
                v-for="t in feedbackTickets"
                :key="t.id"
                class="fb-ticket"
                :class="{ active: currentFeedback?.id === t.id }"
                @click="openFeedbackTicket(t)"
              >
                <div class="fb-ticket-top">
                  <span class="fb-ticket-title">{{ t.title }}</span>
                  <span class="fb-ticket-status" :class="'st-' + (t.status || '').toLowerCase()">{{ statusLabel(t.status) }}</span>
                </div>
                <div class="fb-ticket-meta">{{ categoryLabel(t.category) }} · {{ formatTime(t.createdAt) }}</div>
              </div>
              <div v-if="!feedbackTickets.length" class="panel-empty">暂无反馈工单，点击「新建反馈」提交</div>
            </div>
            <div v-if="currentFeedback" class="fb-detail">
              <div class="fb-detail-msgs">
                <div
                  v-for="fm in currentFeedback.messages || []"
                  :key="fm.id"
                  :class="['fmsg', fm.senderType === 'admin' ? 'admin' : 'own']"
                >
                  <div class="fmsg-head">
                    <span class="fmsg-sender">{{ fm.senderType === 'admin' ? '管理员' : (fm.sender?.nickname || fm.sender?.username || '我') }}</span>
                    <span class="fmsg-time">{{ formatTime(fm.createdAt) }}</span>
                  </div>
                  <div class="fmsg-content">{{ fm.content }}</div>
                  <div v-if="fmAttachments(fm).length" class="fmsg-attachments">
                    <a v-for="(u, ui) in fmAttachments(fm)" :key="ui" :href="u" target="_blank" rel="noopener noreferrer">📎 {{ fileName(u) }}</a>
                  </div>
                </div>
                <div v-if="!(currentFeedback.messages || []).length" class="panel-empty">暂无消息</div>
              </div>
              <footer class="panel-input-bar">
                <input
                  v-model="feedbackReply"
                  :disabled="currentFeedback.status === 'CLOSED'"
                  placeholder="追加回复...（工单关闭后不可回复）"
                  @keyup.enter="replyFeedback"
                />
                <input type="file" multiple class="reply-file" @change="onReplyFilesChange" />
                <button :disabled="currentFeedback.status === 'CLOSED'" @click="replyFeedback">回复</button>
              </footer>
            </div>
            <div v-else class="panel-empty">点击上方工单查看详情</div>
          </template>
        </div>
      </aside>
    </div>

    <!-- 全局 Toast 提示 -->
    <div class="toast-container">
      <transition-group name="toast-fade">
        <div v-for="t in toasts" :key="t.id" :class="['toast-item', t.type]">{{ t.message }}</div>
      </transition-group>
    </div>
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
import { chatApi, commandApi, userApi, gameApi, feedbackApi } from '../api';
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

// ---------- QQ 绑定（玩家自行绑定/更换） ----------
// 输入框内容、是否显示绑定输入框、错误提示、绑定中状态
const qqInput = ref('');
const qqBinding = ref(false);
const qqError = ref('');
const qqBusy = ref(false);

// 打开绑定输入框（已绑定时进入"更换"模式，回填当前QQ号）
function openQQBind() {
  qqInput.value = user.value?.qqNumber || '';
  qqBinding.value = true;
  qqError.value = '';
}

// 绑定/更换 QQ 号：调用后端 bind-qq 接口，成功后同步本地用户信息
async function bindQQ() {
  const qq = qqInput.value.trim();
  // 前端先做基础格式校验（与后端 DTO 规则一致）
  if (!/^\d{5,12}$/.test(qq)) {
    qqError.value = '请输入 5-12 位数字QQ号';
    return;
  }
  qqBusy.value = true;
  qqError.value = '';
  try {
    await userApi.bindQQ(qq);
    // 绑定成功：更新本地 user 并持久化，界面回到已绑定展示态
    user.value = { ...user.value, qqNumber: qq };
    localStorage.setItem('user', JSON.stringify(user.value));
    qqInput.value = '';
    qqBinding.value = false;
  } catch (e) {
    // 展示后端返回的错误（如"该QQ号已被其他账号绑定"）
    qqError.value = e?.response?.data?.message || '绑定失败，请重试';
  } finally {
    qqBusy.value = false;
  }
}

// 生命值百分比
const hpPercent = computed(() => {
  if (!playerInfo.value || !playerInfo.value.maxHp) return 0;
  return Math.round((playerInfo.value.hp / playerInfo.value.maxHp) * 100);
});

// 经验百分比
const expPercent = computed(() => {
  if (!playerInfo.value || !playerInfo.value.upgradeExp) return 0;
  return Math.min(100, Math.round((playerInfo.value.exp / playerInfo.value.upgradeExp) * 100));
});

// 护盾百分比
const shieldPercent = computed(() => {
  if (!playerInfo.value || !playerInfo.value.maxShield) return 0;
  return Math.min(100, Math.round((playerInfo.value.shield / playerInfo.value.maxShield) * 100));
});

// 装甲百分比
const armorPercent = computed(() => {
  if (!playerInfo.value || !playerInfo.value.maxArmor) return 0;
  return Math.min(100, Math.round((playerInfo.value.armor / playerInfo.value.maxArmor) * 100));
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
 * 消息对齐分类（QQ 聊天风格）
 * - 系统/游戏/战斗/信息类消息 → center（居中，无论是否带 sender）
 * - 普通聊天（chat）→ 本人 own（右侧）、他人 other（左侧）
 * 说明：指令触发的公屏结果多为"系统广播"（如"某某移动到某地"），
 * 它们即便带玩家 sender，也应居中展示，与玩家主动发起的对话气泡区分开。
 * @param {object} m 消息对象
 * @returns {string} 'own' | 'other' | 'center'
 */
function msgAlign(m) {
  // 系统类消息统一居中（覆盖 command/system/game/combat/info）
  if (m.type === 'system' || m.type === 'game' || m.type === 'combat' || m.type === 'info' || m.type === 'command') {
    return 'center';
  }
  // 普通聊天：按发送者归属区分左右
  if (!m.sender) return 'center';
  return m.sender.id === user.value?.id ? 'own' : 'other';
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

  // 模式1：「指令名 参数」—— 精确匹配，优先级最高
  // 书名号内第一个词必须是指令名或别名，后续内容作为参数一起发送
  // 这样可以避免「古代遗物」这类剧情道具名被误识别为可点击指令
  const bookEndRegex = /「([^」]+)」/g;
  let match;
  while ((match = bookEndRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: content.slice(lastIndex, match.index) });
    }
    const inner = match[1].trim();
    const firstWord = inner.split(/\s+/)[0];
    const isValidCmd = validCmdNames.has(firstWord) || validCmdAliases.has(firstWord);
    if (isValidCmd) {
      // 有效指令：发送完整指令（含参数），如「对话 新手引导员」
      segments.push({ type: 'command', text: inner, source: 'bookend' });
    } else {
      // 非指令内容（如剧情道具名）保持普通文本，避免误导点击
      segments.push({ type: 'text', text: match[0] });
    }
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

  // 处理文本片段中的 @提及 高亮（在已有 segment 基础上拆解 text 片段）
  const mentionRegex = /@([\u4e00-\u9fa5A-Za-z0-9_]{1,32})/g;
  const finalSegments = [];
  for (const seg of segments) {
    if (seg.type === 'text' && seg.text) {
      let lastTextIdx = 0;
      let m;
      mentionRegex.lastIndex = 0;
      while ((m = mentionRegex.exec(seg.text)) !== null) {
        if (m.index > lastTextIdx) {
          finalSegments.push({ type: 'text', text: seg.text.slice(lastTextIdx, m.index) });
        }
        finalSegments.push({ type: 'mention', text: m[0] });
        lastTextIdx = mentionRegex.lastIndex;
      }
      if (lastTextIdx < seg.text.length) {
        finalSegments.push({ type: 'text', text: seg.text.slice(lastTextIdx) });
      }
    } else {
      finalSegments.push(seg);
    }
  }
  return finalSegments;
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

// ===== 全局 Toast 轻提示 =====
const toasts = ref([]);
let toastId = 0;
/**
 * 显示一条轻提示（自动消失）
 * @param {string} message 提示内容
 * @param {string} type 类型：info / error / success
 */
function showToast(message, type = 'info') {
  const id = ++toastId;
  toasts.value.push({ id, message, type });
  // 3 秒后自动移除
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 3000);
}

// ===== 私聊面板状态 =====
const privatePanelOpen = ref(false);
const privateConversations = ref([]);
const privatePeerId = ref(null);
const privateMessages = ref([]);
const privateInput = ref('');
// 未读私聊总数（头部红点）
const unreadPrivateCount = ref(0);

/**
 * 打开/关闭私聊面板
 * 打开时刷新会话列表（同步未读计数）
 */
function togglePrivatePanel() {
  if (privatePanelOpen.value) {
    closePrivatePanel();
  } else {
    privatePanelOpen.value = true;
    loadPrivateConversations();
  }
}

/** 关闭私聊面板 */
function closePrivatePanel() {
  privatePanelOpen.value = false;
}

/**
 * 加载私聊会话列表，并重新计算头部未读总数
 */
async function loadPrivateConversations() {
  try {
    const res = await chatApi.getPrivateConversations();
    privateConversations.value = res.data || [];
    unreadPrivateCount.value = privateConversations.value.reduce((sum, c) => sum + (c.unread || 0), 0);
  } catch (e) {
    console.error('加载私聊会话失败', e);
    showToast('加载私聊会话失败', 'error');
  }
}

/**
 * 点击会话：加载与该用户的私聊历史，并标记已读
 * @param {object} conv 会话对象（含 peerId）
 */
async function openPrivateConversation(conv) {
  if (!conv || conv.peerId === privatePeerId.value) return;
  privatePeerId.value = conv.peerId;
  privateMessages.value = [];
  try {
    const res = await chatApi.getPrivateMessages(conv.peerId, 50);
    privateMessages.value = res.data || [];
  } catch (e) {
    console.error('加载私聊历史失败', e);
    showToast('加载私聊历史失败', 'error');
  }
  // 本地清空该会话未读并重新计算总未读
  conv.unread = 0;
  unreadPrivateCount.value = privateConversations.value.reduce((sum, c) => sum + (c.unread || 0), 0);
  // 调用后端标记已读（失败不影响本地展示）
  try {
    await chatApi.markPrivateRead(conv.peerId);
  } catch (e) {
    console.error('标记私聊已读失败', e);
  }
}

/**
 * 发送私聊消息（经 Socket，发送成功后由服务端回传 chat:private 追加显示）
 */
function sendPrivateMessage() {
  const content = privateInput.value.trim();
  if (!content || !socket || !privatePeerId.value) return;
  socket.emit('chat:private', { to: privatePeerId.value, content });
  privateInput.value = '';
}

/**
 * 处理收到的私聊消息（发送方回传 + 接收方推送均走这里）
 * @param {object} msg 私聊消息对象
 */
function handleIncomingPrivate(msg) {
  if (!msg || !user.value) return;
  // 对方ID：发给我的是发送方；我发出的则是接收方
  const peerId = msg.senderId === user.value.id ? msg.receiverId : msg.senderId;
  if (privatePanelOpen.value && privatePeerId.value === peerId) {
    // 面板打开且是当前会话 → 直接追加并标记已读
    privateMessages.value.push(msg);
    chatApi.markPrivateRead(peerId).catch(() => {});
  } else {
    // 否则增加未读计数，并同步更新会话列表
    unreadPrivateCount.value += 1;
    const conv = privateConversations.value.find((c) => c.peerId === peerId);
    if (conv) {
      conv.unread = (conv.unread || 0) + 1;
      conv.lastMessage = msg.content;
      conv.lastAt = msg.createdAt;
    } else {
      // 新会话插到最前
      privateConversations.value.unshift({
        peerId,
        peer: msg.senderId === user.value.id ? msg.receiver : msg.sender,
        lastMessage: msg.content,
        lastAt: msg.createdAt,
        unread: 1,
      });
    }
  }
}

// ===== 反馈面板状态 =====
const feedbackPanelOpen = ref(false);
const feedbackTickets = ref([]);
const currentFeedback = ref(null);
const feedbackView = ref('list'); // list | create
const fbSubmitting = ref(false);
const fbForm = ref({ title: '', category: 'general', content: '' });
const fbUploadedUrls = ref([]);
const feedbackReply = ref('');
const replyUploadedUrls = ref([]);

/**
 * 打开/关闭反馈面板
 * 打开时刷新"我的反馈工单"列表
 */
function toggleFeedbackPanel() {
  if (feedbackPanelOpen.value) {
    closeFeedbackPanel();
  } else {
    feedbackPanelOpen.value = true;
    loadFeedbackTickets();
  }
}

/** 关闭反馈面板 */
function closeFeedbackPanel() {
  feedbackPanelOpen.value = false;
}

/**
 * 加载"我的反馈工单"列表
 */
async function loadFeedbackTickets() {
  try {
    const res = await feedbackApi.mine();
    feedbackTickets.value = res.data || [];
  } catch (e) {
    console.error('加载反馈列表失败', e);
    showToast('加载反馈列表失败', 'error');
  }
}

/**
 * 加载单个反馈工单详情
 * @param {number} id 工单ID
 */
async function loadFeedbackDetail(id) {
  try {
    const res = await feedbackApi.detail(id);
    currentFeedback.value = res.data;
  } catch (e) {
    console.error('加载反馈详情失败', e);
    showToast('加载反馈详情失败', 'error');
  }
}

/** 点击工单 → 加载详情 */
function openFeedbackTicket(ticket) {
  if (!ticket) return;
  loadFeedbackDetail(ticket.id);
}

/** 进入新建反馈表单 */
function startNewFeedback() {
  feedbackView.value = 'create';
}

/**
 * 新建反馈附件选择：调用上传接口得到可访问 URL 列表
 * @param {Event} e 文件输入 change 事件
 */
async function onFbFilesChange(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  try {
    const res = await feedbackApi.upload(files);
    fbUploadedUrls.value = [...fbUploadedUrls.value, ...(res.data || [])];
  } catch (err) {
    console.error('附件上传失败', err);
    showToast('附件上传失败', 'error');
  }
}

/**
 * 提交新建反馈工单
 */
async function submitFeedback() {
  const title = fbForm.value.title.trim();
  const content = fbForm.value.content.trim();
  if (!title || !content) {
    showToast('请填写标题和内容', 'error');
    return;
  }
  fbSubmitting.value = true;
  try {
    await feedbackApi.create({
      title,
      category: fbForm.value.category,
      content,
      attachments: fbUploadedUrls.value,
    });
    showToast('反馈已提交，感谢你的反馈！', 'success');
    // 重置表单并返回列表
    fbForm.value = { title: '', category: 'general', content: '' };
    fbUploadedUrls.value = [];
    feedbackView.value = 'list';
    await loadFeedbackTickets();
  } catch (err) {
    console.error('提交反馈失败', err);
    showToast('提交反馈失败，请稍后重试', 'error');
  } finally {
    fbSubmitting.value = false;
  }
}

/**
 * 回复附件选择：调用上传接口得到可访问 URL 列表
 * @param {Event} e 文件输入 change 事件
 */
async function onReplyFilesChange(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  try {
    const res = await feedbackApi.upload(files);
    replyUploadedUrls.value = [...replyUploadedUrls.value, ...(res.data || [])];
  } catch (err) {
    console.error('回复附件上传失败', err);
    showToast('附件上传失败', 'error');
  }
}

/**
 * 在当前工单下追加回复
 */
async function replyFeedback() {
  if (!currentFeedback.value) return;
  const content = feedbackReply.value.trim();
  if (!content && !replyUploadedUrls.value.length) {
    showToast('请输入回复内容', 'error');
    return;
  }
  try {
    await feedbackApi.reply(currentFeedback.value.id, {
      content,
      attachments: replyUploadedUrls.value,
    });
    feedbackReply.value = '';
    replyUploadedUrls.value = [];
    await loadFeedbackDetail(currentFeedback.value.id);
    await loadFeedbackTickets();
  } catch (err) {
    console.error('回复失败', err);
    showToast('回复失败，请稍后重试', 'error');
  }
}

/**
 * 解析消息中的附件字段（数据库中以 JSON 字符串存储）
 * @param {object} msg 反馈消息对象
 * @returns {string[]} 附件 URL 数组
 */
function fmAttachments(msg) {
  if (!msg || !msg.attachments) return [];
  try {
    const arr = typeof msg.attachments === 'string' ? JSON.parse(msg.attachments) : msg.attachments;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * 取附件 URL 的文件名（供展示）
 * @param {string} url 附件 URL
 * @returns {string} 文件名
 */
function fileName(url) {
  const name = String(url || '').split('/').pop() || url;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** 反馈状态中文标签 */
function statusLabel(status) {
  const map = { OPEN: '待处理', PROCESSING: '处理中', CLOSED: '已关闭' };
  return map[status] || status || '未知';
}

/** 反馈分类中文标签 */
function categoryLabel(category) {
  const map = { general: '一般', bug: 'Bug', suggestion: '建议' };
  return map[category] || category || '其他';
}

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
    // 后端按 createdAt 倒序返回（最新在前），需反转成"旧消息在上、新消息在下"，
    // 与实时 push 到末尾的顺序一致，避免新消息出现在历史消息中间/顶部
    messages.value = (msgs.data || []).reverse();
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

    // 接收私聊消息（发送方回传 + 接收方推送均通过该事件）
    socket.on('chat:private', (msg) => {
      handleIncomingPrivate(msg);
    });
    // 接收公屏 @提及 通知，弹出轻提示
    socket.on('chat:at', (data) => {
      if (!data) return;
      const fromName = data.from?.nickname || data.from?.username || '有人';
      showToast(`${fromName} 在公屏 @ 了你`);
    });
    // 私聊发送失败提示
    socket.on('chat:private-error', (data) => {
      showToast(data?.message || '私聊发送失败', 'error');
    });
    // 反馈：收到新消息（管理员回复时推送给用户）
    socket.on('feedback:message', (data) => {
      if (!data) return;
      const { feedbackId } = data;
      // 当前正在查看该工单 → 刷新详情
      if (currentFeedback.value && currentFeedback.value.id === feedbackId) {
        loadFeedbackDetail(feedbackId);
      }
      // 反馈面板打开 → 刷新列表保持最新
      if (feedbackPanelOpen.value) {
        loadFeedbackTickets();
      }
    });
    // 反馈：状态变更通知
    socket.on('feedback:status', (data) => {
      if (!data) return;
      const { feedbackId, status } = data;
      if (currentFeedback.value && currentFeedback.value.id === feedbackId) {
        currentFeedback.value.status = status;
      }
      if (feedbackPanelOpen.value) {
        loadFeedbackTickets();
      }
      showToast(`反馈工单状态更新为「${statusLabel(status)}」`);
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

<style scoped>
/* ===== 头部操作按钮（私聊/反馈） ===== */
.header-action-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border: 1px solid var(--border-light);
  border-radius: 20px;
  background: rgba(20, 16, 42, 0.7);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
  touch-action: manipulation;
}
.header-action-btn:hover {
  color: #fff;
  border-color: var(--accent);
  box-shadow: 0 0 12px rgba(139, 92, 246, 0.25);
}
.header-action-btn:active {
  transform: scale(0.95);
}

/* 未读红点 */
.unread-badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 10px;
  background: var(--danger);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  animation: badgePulse 1.5s ease-in-out infinite;
}
@keyframes badgePulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
  50% { box-shadow: 0 0 8px 2px rgba(239, 68, 68, 0.5); }
}

/* ===== @提及高亮 ===== */
.mention-highlight {
  color: #fbbf24;
  font-weight: 700;
  background: rgba(251, 191, 36, 0.12);
  border-radius: 4px;
  padding: 0 2px;
  white-space: nowrap;
}

/* ===== 右侧滑出面板通用 ===== */
.panel-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  display: flex;
  justify-content: flex-end;
}
.side-panel {
  width: 420px;
  max-width: 92vw;
  height: 100%;
  height: calc(var(--vh, 1vh) * 100);
  background: var(--bg2);
  border-left: 1px solid var(--glass-border);
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  animation: panelSlideIn 0.25s ease-out;
}
@keyframes panelSlideIn {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--glass-border);
  background: rgba(10, 10, 26, 0.6);
}
.panel-header h3 {
  flex: 1;
  font-size: 15px;
  color: var(--text);
}
.panel-close {
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.panel-close:hover {
  color: #fff;
  border-color: var(--danger);
}
.panel-new-btn {
  padding: 5px 12px;
  border: none;
  border-radius: 8px;
  background: var(--accent-gradient);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
  touch-action: manipulation;
}
.panel-new-btn:hover {
  filter: brightness(1.1);
}
.panel-new-btn:active {
  transform: scale(0.95);
}

.panel-empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--muted-dark);
  font-size: 13px;
}

/* ===== 私聊面板 ===== */
.private-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.conv-list {
  width: 150px;
  flex-shrink: 0;
  border-right: 1px solid var(--glass-border);
  overflow-y: auto;
  background: rgba(10, 10, 26, 0.4);
}
.conv-item {
  padding: 10px;
  border-bottom: 1px solid rgba(139, 92, 246, 0.08);
  cursor: pointer;
  transition: background 0.15s ease;
}
.conv-item:hover {
  background: rgba(139, 92, 246, 0.1);
}
.conv-item.active {
  background: rgba(139, 92, 246, 0.2);
  border-left: 2px solid var(--accent);
}
.conv-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}
.conv-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-unread {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 10px;
  background: var(--danger);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  flex-shrink: 0;
}
.conv-preview {
  margin-top: 3px;
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.private-chat {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.private-msgs {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pmsg {
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.5;
  max-width: 92%;
  word-break: break-word;
}
.pmsg.own {
  align-self: flex-end;
  background: rgba(139, 92, 246, 0.18);
  border: 1px solid rgba(139, 92, 246, 0.3);
}
.pmsg.other {
  align-self: flex-start;
  background: rgba(20, 16, 42, 0.8);
  border: 1px solid var(--glass-border);
}
.pmsg-sender {
  font-weight: 600;
  color: var(--accent2);
  margin-right: 4px;
}
.pmsg-time {
  display: block;
  margin-top: 4px;
  font-size: 10px;
  color: var(--muted-dark);
}

.panel-input-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--glass-border);
  background: rgba(10, 10, 26, 0.6);
}
.panel-input-bar > input:not([type='file']) {
  flex: 1;
  min-width: 0;
  padding: 9px 12px;
  background: rgba(10, 10, 26, 0.8);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.panel-input-bar > input:not([type='file']):focus {
  border-color: var(--accent);
}
.panel-input-bar > input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.panel-input-bar > button {
  padding: 9px 14px;
  border: none;
  border-radius: 8px;
  background: var(--accent-gradient);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.panel-input-bar > button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ===== 反馈面板 ===== */
.feedback-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.fb-list {
  flex-shrink: 0;
  max-height: 45%;
  overflow-y: auto;
  border-bottom: 1px solid var(--glass-border);
}
.fb-ticket {
  padding: 10px 12px;
  border-bottom: 1px solid rgba(139, 92, 246, 0.08);
  cursor: pointer;
  transition: background 0.15s ease;
}
.fb-ticket:hover {
  background: rgba(139, 92, 246, 0.1);
}
.fb-ticket.active {
  background: rgba(139, 92, 246, 0.2);
}
.fb-ticket-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.fb-ticket-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-ticket-status {
  flex-shrink: 0;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 600;
}
.fb-ticket-status.st-open { background: var(--warning-bg); color: var(--warning); }
.fb-ticket-status.st-processing { background: var(--info-bg); color: var(--info); }
.fb-ticket-status.st-closed { background: var(--success-bg); color: var(--success); }
.fb-ticket-meta {
  margin-top: 3px;
  font-size: 11px;
  color: var(--muted);
}

.fb-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.fb-detail-msgs {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fmsg {
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.5;
  max-width: 92%;
}
.fmsg.own {
  align-self: flex-end;
  background: rgba(6, 182, 212, 0.1);
  border: 1px solid rgba(6, 182, 212, 0.25);
}
.fmsg.admin {
  align-self: flex-start;
  background: rgba(139, 92, 246, 0.14);
  border: 1px solid rgba(139, 92, 246, 0.3);
}
.fmsg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.fmsg-sender {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent2);
}
.fmsg-time {
  font-size: 10px;
  color: var(--muted-dark);
}
.fmsg-content {
  white-space: pre-line;
  word-break: break-word;
}
.fmsg-attachments {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 6px;
}
.fmsg-attachments a {
  color: var(--accent2);
  font-size: 12px;
  text-decoration: none;
}
.fmsg-attachments a:hover {
  text-decoration: underline;
}

/* 新建反馈表单 */
.fb-create {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fb-label {
  font-size: 12px;
  color: var(--muted);
  margin-top: 6px;
}
.fb-input {
  width: 100%;
  padding: 9px 12px;
  background: rgba(10, 10, 26, 0.8);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.fb-input:focus {
  border-color: var(--accent);
}
.fb-textarea {
  resize: vertical;
  min-height: 90px;
  font-family: inherit;
}
.fb-file {
  font-size: 12px;
  color: var(--muted);
}
.fb-file-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.fb-file-item {
  font-size: 11px;
  color: var(--accent2);
  background: rgba(6, 182, 212, 0.1);
  border: 1px solid rgba(6, 182, 212, 0.25);
  padding: 2px 8px;
  border-radius: 10px;
}
.fb-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
.fb-cancel {
  padding: 9px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
}
.fb-submit {
  padding: 9px 18px;
  border: none;
  border-radius: 8px;
  background: var(--accent-gradient);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.fb-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.reply-file {
  max-width: 90px;
  font-size: 11px;
  color: var(--muted);
}

/* ===== Toast 提示 ===== */
.toast-container {
  position: fixed;
  top: calc(16px + var(--safe-top));
  left: 50%;
  transform: translateX(-50%);
  z-index: 200;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}
.toast-item {
  padding: 10px 18px;
  border-radius: 10px;
  background: rgba(20, 16, 42, 0.95);
  border: 1px solid var(--border-light);
  color: var(--text);
  font-size: 13px;
  box-shadow: var(--glass-shadow);
  max-width: 80vw;
}
.toast-item.error {
  border-color: rgba(239, 68, 68, 0.5);
  color: #fca5a5;
}
.toast-item.success {
  border-color: rgba(34, 197, 94, 0.5);
  color: #86efac;
}
.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: all 0.25s ease;
}
.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* ===== 移动端适配 ===== */
@media (max-width: 768px) {
  .side-panel {
    width: 100vw;
    max-width: 100vw;
  }
  .header-action-btn {
    padding: 4px 8px;
    font-size: 12px;
  }
}
</style>