<template>
  <div class="chat-page">
    <!-- 左侧：用户信息 + Tab 切换面板 -->
    <aside class="sidebar">
      <!-- 顶部固定：用户卡片 + QQ 绑定 -->
      <div class="sidebar-header">
        <div class="user-card" :class="{ 'is-admin': isAdmin }" @click="onAvatarClick" :title="avatarTitle">
          <div class="avatar">
            <!-- 有 QQ 头像时显示图片，否则显示首字母 -->
            <img v-if="user?.avatar" :src="user.avatar" class="avatar-img" />
            <span v-else class="avatar-letter">{{ (user?.nickname || user?.username || '?')[0] }}</span>
          </div>
          <div class="user-info">
            <div class="name-row">
              <span class="name">{{ user?.nickname || user?.username }}</span>
              <button v-if="!nicknameEditing" class="nickname-edit-btn" title="修改昵称" @click.stop="openNicknameEdit">✏️</button>
            </div>
            <!-- 昵称行内编辑 -->
            <div v-if="nicknameEditing" class="nickname-edit-row">
              <input v-model="nicknameInput" class="nickname-input" maxlength="20" placeholder="输入新昵称" @keyup.enter="saveNickname" @keyup.esc="nicknameEditing = false" />
              <button class="qq-btn primary" :disabled="nicknameBusy" @click.stop="saveNickname">{{ nicknameBusy ? '…' : '保存' }}</button>
              <button class="qq-btn" @click.stop="nicknameEditing = false">取消</button>
            </div>
            <div v-if="nicknameError" class="nickname-error">{{ nicknameError }}</div>
            <div class="meta">@{{ user?.username }}</div>
          </div>
          <span v-if="isAdmin" class="admin-badge">ADMIN</span>
        </div>

        <!-- QQ 绑定区域：仅展示 OpenID 与绑定状态，手动输入已取消 -->
        <div class="qq-bind">
          <!-- OpenID 展示与复制 -->
          <div class="openid-row" @click="copyOpenId">
            <span class="openid-label">OpenID</span>
            <span class="openid-value" :title="user?.externalId || '未登录'">{{ maskedOpenId }}</span>
            <button class="qq-btn" :disabled="!user?.externalId" title="点击复制 OpenID">📋</button>
          </div>
          <!-- 已绑定真实QQ号 -->
          <div v-if="user?.qqNumber && !isLegacyQqBind" class="qq-bound-row">
            <span class="qq-bound">✅ 已绑定 QQ {{ user.qqNumber }}</span>
          </div>
          <!-- 未绑定 -->
          <div v-else class="qq-tip">
            请在 QQ 群中发送：<br/>
            <code class="bind-cmd">使魔大战绑定QQ {{ user?.externalId || '你的OpenID' }}</code>
          </div>
          <div v-if="copyTip" class="copy-tip">{{ copyTip }}</div>
        </div>
      </div>

      <!-- 中部：Tab 切换 -->
      <div class="sidebar-tabs">
        <button class="sidebar-tab" :class="{ active: sidebarTab === 'me' }" @click="sidebarTab = 'me'">
          <span class="tab-icon">👤</span>我的
        </button>
        <button class="sidebar-tab" :class="{ active: sidebarTab === 'cmd' }" @click="sidebarTab = 'cmd'">
          <span class="tab-icon">📖</span>指令
        </button>
      </div>

      <div class="sidebar-content">
        <!-- 我的 Tab：玩家信息 + 快捷操作 -->
        <div v-show="sidebarTab === 'me'" class="tab-pane">
          <!-- 玩家状态面板：桌面侧栏与手机抽屉共用组件（等级/血条/战斗力/任务/装备/增益实时展示） -->
          <PlayerStatusPanel v-if="playerInfo" :info="playerInfo" />
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

          <!-- 我的常用指令：用户自定义，可编辑、可拖拽排序，点击直接发送 -->
          <div class="fav-cmds">
            <div class="fav-head">
              <span class="fav-title">⭐ 我的常用</span>
              <button class="fav-edit-btn" @click="toggleFavEdit">{{ favEditing ? '完成' : '编辑' }}</button>
            </div>
            <div v-if="favoriteCommands.length || favEditing" class="fav-list">
              <span
                v-for="(f, fi) in favoriteCommands"
                :key="'fav-' + f.cmd"
                class="fav-chip"
                :class="{ editing: favEditing, dragging: dragIndex === fi, dragover: dragOverIndex === fi }"
                :draggable="favEditing"
                @dragstart="onFavDragStart(fi)"
                @dragover.prevent="onFavDragOver(fi)"
                @drop="onFavDrop(fi)"
                @click="onFavoriteClick(f)"
              >
                <span v-if="favEditing" class="fav-grip" title="拖拽排序">⋮⋮</span>
                {{ f.label }}
                <span v-if="favEditing" class="fav-del">✕</span>
              </span>
              <span v-if="!favoriteCommands.length && favEditing" class="fav-empty">暂无常用，在下方添加任意内容</span>
            </div>
            <div v-if="favEditing" class="fav-add">
              <input
                class="fav-add-input"
                v-model="favAddInput"
                placeholder="发送内容（任意文本，如：攻击 史莱姆）"
                @click.stop
                @keyup.enter="favAddInput.trim() ? addFavorite() : null"
              />
              <input
                class="fav-add-label"
                v-model="favAddLabel"
                placeholder="显示名（可选，留空用发送内容）"
                @click.stop
                @keyup.enter="favAddInput.trim() ? addFavorite() : null"
              />
              <button class="fav-add-btn" :disabled="favBusy || !favAddInput.trim()" @click="addFavorite()">+ 添加</button>
              <div v-if="favAddCandidates.length" class="fav-candidates">
                <span
                  v-for="c in favAddCandidates"
                  :key="'favc-' + c.name"
                  class="fav-cand"
                  @click="addFavorite(c.name)"
                >{{ c.name }}</span>
              </div>
            </div>
            <div v-if="!favEditing && !favoriteCommands.length" class="fav-hint">点「编辑」可添加常用指令</div>
            <div v-if="favMsg" class="fav-msg">{{ favMsg }}</div>
          </div>
        </div>

        <!-- 指令 Tab：搜索 + 指令列表（更大空间） -->
        <div v-show="sidebarTab === 'cmd'" class="tab-pane tab-pane-cmd">
          <div class="cmd-search-wrapper">
            <input class="cmd-search" v-model="cmdSearch" placeholder="搜索指令（回车发送第一条）..." @click.stop @keyup.enter="selectFirstCmd" />
            <span v-if="cmdSearch" class="cmd-search-clear" @click="cmdSearch = ''">✕</span>
          </div>
          <ul class="cmd-list">
            <li v-for="c in cmdSearchResults" :key="c.name" @click="quickSend(c.name)">
              <span class="cmd-name">{{ c.name }}</span>
              <span class="cmd-desc">{{ c.description }}</span>
            </li>
            <li v-if="cmdSearchResults.length === 0 && cmdSearch" class="cmd-empty">未匹配到指令</li>
          </ul>
          <div class="cmd-stats" v-if="!cmdSearch">共 {{ commands.length }} 条指令</div>
        </div>
      </div>

      <!-- 底部固定：状态栏 + 操作按钮 -->
      <div class="sidebar-footer">
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
        <div class="sidebar-footer-actions">
          <button v-if="showAdminEntry" class="logout admin-entry" @click="router.push('/admin')">⚙️ 管理后台</button>
          <button class="logout" @click="logout">退出</button>
        </div>
      </div>
    </aside>

    <!-- 手机端遮罩层（点击关闭抽屉） -->
    <div class="mobile-overlay" :class="{ open: mobileMenuOpen }" @click="mobileMenuOpen = false"></div>

    <!-- 手机端抽屉菜单 -->
    <aside class="mobile-drawer" :class="{ open: mobileMenuOpen }">
      <!-- 顶部固定：用户卡片 + QQ 绑定 -->
      <div class="sidebar-header">
        <div class="user-card" :class="{ 'is-admin': isAdmin }" @click="onAvatarClick" :title="avatarTitle">
          <div class="avatar">
            <img v-if="user?.avatar" :src="user.avatar" class="avatar-img" />
            <span v-else class="avatar-letter">{{ (user?.nickname || user?.username || '?')[0] }}</span>
          </div>
          <div class="user-info">
            <div class="name-row">
              <span class="name">{{ user?.nickname || user?.username }}</span>
              <button v-if="!nicknameEditing" class="nickname-edit-btn" title="修改昵称" @click.stop="openNicknameEdit">✏️</button>
            </div>
            <!-- 昵称行内编辑 -->
            <div v-if="nicknameEditing" class="nickname-edit-row">
              <input v-model="nicknameInput" class="nickname-input" maxlength="20" placeholder="输入新昵称" @keyup.enter="saveNickname" @keyup.esc="nicknameEditing = false" />
              <button class="qq-btn primary" :disabled="nicknameBusy" @click.stop="saveNickname">{{ nicknameBusy ? '…' : '保存' }}</button>
              <button class="qq-btn" @click.stop="nicknameEditing = false">取消</button>
            </div>
            <div v-if="nicknameError" class="nickname-error">{{ nicknameError }}</div>
            <div class="meta">@{{ user?.username }}</div>
          </div>
          <span v-if="isAdmin" class="admin-badge">ADMIN</span>
        </div>

        <div class="qq-bind">
          <div class="openid-row" @click="copyOpenId">
            <span class="openid-label">OpenID</span>
            <span class="openid-value" :title="user?.externalId || '未登录'">{{ maskedOpenId }}</span>
            <button class="qq-btn" :disabled="!user?.externalId" title="点击复制 OpenID">📋</button>
          </div>
          <div v-if="user?.qqNumber && !isLegacyQqBind" class="qq-bound-row">
            <span class="qq-bound">✅ 已绑定 QQ {{ user.qqNumber }}</span>
          </div>
          <div v-else class="qq-tip">
            请在 QQ 群中发送：<br/>
            <code class="bind-cmd">使魔大战绑定QQ {{ user?.externalId || '你的OpenID' }}</code>
          </div>
          <div v-if="copyTip" class="copy-tip">{{ copyTip }}</div>
        </div>
      </div>

      <!-- Tab 切换 -->
      <div class="sidebar-tabs">
        <button class="sidebar-tab" :class="{ active: mobileTab === 'me' }" @click="mobileTab = 'me'">
          <span class="tab-icon">👤</span>我的
        </button>
        <button class="sidebar-tab" :class="{ active: mobileTab === 'map' }" @click="mobileTab = 'map'">
          <span class="tab-icon">🗺️</span>地图
        </button>
        <button class="sidebar-tab" :class="{ active: mobileTab === 'cmd' }" @click="mobileTab = 'cmd'">
          <span class="tab-icon">📖</span>指令
        </button>
      </div>

      <div class="sidebar-content">
        <!-- 我的 Tab -->
        <div v-show="mobileTab === 'me'" class="tab-pane">
          <!-- 玩家状态面板：桌面侧栏与手机抽屉共用组件（等级/血条/战斗力/任务/装备/增益实时展示） -->
          <PlayerStatusPanel v-if="playerInfo" :info="playerInfo" />
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

          <!-- 我的常用指令：用户自定义，可编辑、可拖拽排序，点击直接发送 -->
          <div class="fav-cmds">
            <div class="fav-head">
              <span class="fav-title">⭐ 我的常用</span>
              <button class="fav-edit-btn" @click="toggleFavEdit">{{ favEditing ? '完成' : '编辑' }}</button>
            </div>
            <div v-if="favoriteCommands.length || favEditing" class="fav-list">
              <span
                v-for="(f, fi) in favoriteCommands"
                :key="'mfav-' + f.cmd"
                class="fav-chip"
                :class="{ editing: favEditing, dragging: dragIndex === fi, dragover: dragOverIndex === fi }"
                :draggable="favEditing"
                @dragstart="onFavDragStart(fi)"
                @dragover.prevent="onFavDragOver(fi)"
                @drop="onFavDrop(fi)"
                @click="mobileMenuOpen = false; onFavoriteClick(f)"
              >
                <span v-if="favEditing" class="fav-grip" title="拖拽排序">⋮⋮</span>
                {{ f.label }}
                <span v-if="favEditing" class="fav-del">✕</span>
              </span>
              <span v-if="!favoriteCommands.length && favEditing" class="fav-empty">暂无常用，在下方添加任意内容</span>
            </div>
            <div v-if="favEditing" class="fav-add">
              <input
                class="fav-add-input"
                v-model="favAddInput"
                placeholder="发送内容（任意文本，如：攻击 史莱姆）"
                @click.stop
                @keyup.enter="favAddInput.trim() ? addFavorite() : null"
              />
              <input
                class="fav-add-label"
                v-model="favAddLabel"
                placeholder="显示名（可选，留空用发送内容）"
                @click.stop
                @keyup.enter="favAddInput.trim() ? addFavorite() : null"
              />
              <button class="fav-add-btn" :disabled="favBusy || !favAddInput.trim()" @click="addFavorite()">+ 添加</button>
              <div v-if="favAddCandidates.length" class="fav-candidates">
                <span
                  v-for="c in favAddCandidates"
                  :key="'mfavc-' + c.name"
                  class="fav-cand"
                  @click="addFavorite(c.name)"
                >{{ c.name }}</span>
              </div>
            </div>
            <div v-if="!favEditing && !favoriteCommands.length" class="fav-hint">点「编辑」可添加常用指令</div>
            <div v-if="favMsg" class="fav-msg">{{ favMsg }}</div>
          </div>
        </div>

        <!-- 地图 Tab -->
        <div v-show="mobileTab === 'map'" class="tab-pane">
          <div class="map-connections" v-if="mapOverview">
            <div class="mc-current">
              📍 {{ mapOverview.currentMap.name }}
              <span class="mc-detail" v-if="mapOverview.currentMap.monsters || mapOverview.currentMap.resources || mapOverview.currentMap.npcs">
                怪{{ mapOverview.currentMap.monsters }} · 资{{ mapOverview.currentMap.resources }} · NPC{{ mapOverview.currentMap.npcs }}
              </span>
            </div>
            <div class="mc-block" v-if="mapOverview.subMaps.length">
              <div class="mc-block-title">子区域</div>
              <div class="mc-grid">
                <span v-for="mc in mapOverview.subMaps" :key="'msub-' + mc.name" class="mc-node" @click="mobileMenuOpen = false; quickAction('go ' + mc.name)">{{ mc.name }}</span>
              </div>
            </div>
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

          <div class="map-connections" v-if="nearbyPlayers.length || nearbyLoaded">
            <div class="mc-block">
              <div class="mc-block-title">👥 附近玩家（{{ nearbyPlayers.length }}）</div>
              <div class="mc-grid" v-if="nearbyPlayers.length">
                <span v-for="p in nearbyPlayers" :key="'mnp-' + p.userId" class="mc-node nearby-node" :class="{ online: p.online }" @click="mobileMenuOpen = false; startNearbyPrivateChat(p)">
                  {{ p.nickname || p.username }}<em v-if="!p.online">·离线</em>
                </span>
              </div>
              <div class="mc-block-title" v-else style="color: var(--muted); font-weight: 400;">当前区域暂无其他玩家</div>
            </div>
          </div>
        </div>

        <!-- 指令 Tab -->
        <div v-show="mobileTab === 'cmd'" class="tab-pane tab-pane-cmd">
          <div class="cmd-search-wrapper">
            <input class="cmd-search" v-model="cmdSearch" placeholder="搜索指令（回车发送第一条）..." @click.stop @keyup.enter="selectFirstCmd" />
            <span v-if="cmdSearch" class="cmd-search-clear" @click="cmdSearch = ''">✕</span>
          </div>
          <ul class="cmd-list">
            <li v-for="c in cmdSearchResults" :key="'mcmd-' + c.name" @click="mobileMenuOpen = false; quickSend(c.name)">
              <span class="cmd-name">{{ c.name }}</span>
              <span class="cmd-desc">{{ c.description }}</span>
            </li>
            <li v-if="cmdSearchResults.length === 0 && cmdSearch" class="cmd-empty">未匹配到指令</li>
          </ul>
          <div class="cmd-stats" v-if="!cmdSearch">共 {{ commands.length }} 条指令</div>
        </div>
      </div>

      <!-- 底部固定 -->
      <div class="sidebar-footer">
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
        <div class="sidebar-footer-actions">
          <button v-if="showAdminEntry" class="logout admin-entry" @click="mobileMenuOpen = false; router.push('/admin')">⚙️ 管理后台</button>
          <button class="logout" @click="logout">退出</button>
        </div>
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
          <!-- 消息过滤切换：选择是否显示其他玩家的聊天与系统回复 -->
          <button
            class="header-action-btn filter-toggle"
            :class="{ on: showOthersMsg }"
            :title="showOthersMsg ? '当前显示所有人的消息，点击隐藏他人的聊天与系统回复' : '当前仅显示自己的消息，点击恢复显示他人消息'"
            @click="toggleShowOthers"
          >
            {{ showOthersMsg ? '👁 显示他人' : '🙈 仅看自己' }}
          </button>
          <span class="version-tag" title="点击查看更新记录" @click="openUpdateLog">v{{ APP_VERSION }}<em v-if="deployVersion?.short" class="version-tag-sha">#{{ deployVersion.short }}</em></span>
          <!-- 私聊入口按钮（带未读红点） -->
          <button class="header-action-btn" title="私聊" @click="togglePrivatePanel">
            💬 私聊
            <span v-if="unreadPrivateCount > 0" class="unread-badge">{{ unreadPrivateCount > 99 ? '99+' : unreadPrivateCount }}</span>
          </button>
          <!-- BUG 反馈入口：醒目样式 + GitHub 图标，点击跳转 GitHub Issues 页 -->
          <a
            class="github-issue-btn"
            :href="GITHUB_ISSUES_URL"
            target="_blank"
            rel="noopener noreferrer"
            title="前往 GitHub 提交 BUG 反馈"
          >
            <svg class="github-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
              <!-- GitHub 官方 Logo 路径（24x24 视窗） -->
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
            </svg>
            <span>BUG 反馈</span>
          </a>
          <a class="reborn-link" href="http://xx.52shell.ltd" target="_blank" rel="noopener noreferrer">《重生之凡人修仙》</a>
        </div>
      </header>

      <!-- 消息列表 -->
      <div ref="msgList" class="messages" @scroll="onMsgScroll">
        <div v-for="(v, i) in messageViews" :key="v.key" :class="['msg', msgClass(v.msg), msgAlign(v.msg)]">
          <div class="msg-body">
            <span v-if="v.msg.sender" class="sender" :title="'右键 @ ' + (v.msg.sender.nickname || v.msg.sender.username)" @contextmenu.prevent="quickAtUser(v.msg.sender)">{{ v.msg.sender.nickname || v.msg.sender.username }}：</span>
            <span v-else-if="v.msg.type !== 'system' && v.msg.type !== 'game' && v.msg.type !== 'combat' && v.msg.type !== 'info'" class="sender">系统：</span>
            <span class="content" style="white-space: pre-line">
              <template v-for="(seg, si) in v.segs" :key="si">
                <span v-if="seg.type === 'text'">{{ seg.text }}</span>
                <span v-else-if="seg.type === 'mention'" class="mention-highlight" :title="'右键 @ ' + seg.text.replace('@', '')" @contextmenu.prevent="quickAtText(seg.text)">{{ seg.text }}</span>
                <span v-else class="cmd-clickable" :title="'左键点击发送 / 右键填入输入框「' + seg.text + '」'" @click="quickSend(seg.text)" @contextmenu.prevent="quickFill(seg.text)">{{ seg.displayText || seg.text }}</span>
              </template>
            </span>
          </div>
          <span class="msg-time">{{ formatTime(v.msg.createdAt) }}</span>
        </div>
        <div v-if="!messageViews.length" class="empty">
          {{ messages.length ? '🙈 已隐藏其他玩家的消息，点击右上角「仅看自己」可恢复' : '暂无消息，发送第一条指令吧！' }}
        </div>
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
          <!-- 多行输入框：回车换行，Ctrl+Enter 或点击发送按钮发送 -->
          <textarea
            ref="inputEl"
            v-model="input"
            rows="1"
            class="cmd-input"
            @keydown="onInputKeydown"
            @keyup="onInputKeyup"
            @input="onInputChange"
            @blur="onInputBlur"
            placeholder="回车换行，Ctrl+Enter 或点击「发送」发送指令"
          ></textarea>
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
          <!-- 玩家 @ 下拉（输入 @ 时呼出，支持过滤选择） -->
          <div v-if="showAtAutocomplete && filteredAtPlayers.length" class="autocomplete-list at-list">
            <div
              v-for="(p, pi) in filteredAtPlayers"
              :key="p.id"
              class="ac-item"
              :class="{ active: pi === atAutocompleteIndex }"
              @mousedown.prevent="selectAtPlayer(p)"
            >
              <span class="ac-at-icon">@</span>
              <span class="ac-name">{{ p.nickname || p.username }}</span>
              <span class="ac-desc" v-if="p.online">在线</span>
              <span class="ac-desc" v-else>离线</span>
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

      <!-- 附近玩家 -->
      <div class="ip-block">
        <h4 class="ip-title">👥 附近玩家 ({{ nearbyPlayers.length }})</h4>
        <div class="ip-list" v-if="nearbyPlayers.length">
          <div
            v-for="p in nearbyPlayers"
            :key="'np-' + p.userId"
            class="ip-row player-row"
            :class="{ online: p.online }"
            @click="startNearbyPrivateChat(p)"
          >
            <span class="ip-row-avatar">
              <img v-if="p.avatar" :src="p.avatar" class="np-avatar" />
              <span v-else class="np-avatar-letter">{{ (p.nickname || p.username || '?')[0] }}</span>
            </span>
            <span class="ip-row-name">{{ p.nickname || p.username }}</span>
            <span class="ip-row-meta">
              Lv.{{ p.level }}
              <span class="np-online-dot" :class="{ on: p.online }"></span>
            </span>
          </div>
        </div>
        <div class="ip-empty" v-else>当前区域暂无其他玩家</div>
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

      <!-- 全部地图（原左侧地图Tab迁移至此，可折叠、点击快速传送） -->
      <div class="ip-block" v-if="mapOverview">
        <h4 class="ip-title ip-fold" @click="allMapsCollapsed = !allMapsCollapsed">
          <span class="ip-caret">{{ allMapsCollapsed ? '▶' : '▼' }}</span>
          🗺️ 全部地图 ({{ mapOverview.allMaps.length }})
        </h4>
        <div class="ip-links" v-show="!allMapsCollapsed">
          <span
            v-for="mc in mapOverview.allMaps"
            :key="'rip-' + mc.name"
            class="ip-link"
            :class="{ current: mc.isCurrent, reachable: mc.isReachable }"
            @click="quickAction('go ' + mc.name)"
          >{{ mc.name }}</span>
        </div>
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
            <textarea
              v-model="fbForm.content"
              class="fb-input fb-textarea"
              placeholder="请详细描述你遇到的问题或建议...（可直接 Ctrl+V 粘贴剪贴板截图）"
              rows="4"
              @paste="(e) => handlePasteImage(e, fbUploadedUrls)"
            ></textarea>
            <label class="fb-label">附件（可 Ctrl+V 粘贴图片 / 选择文件）</label>
            <input type="file" multiple class="fb-file" @change="onFbFilesChange" />
            <div v-if="fbUploadedUrls.length" class="fb-file-list">
              <div v-for="(u, ui) in fbUploadedUrls" :key="ui" class="fb-file-item">
                <a v-if="isImage(u)" :href="u" target="_blank" rel="noopener noreferrer">
                  <img :src="u" class="fb-file-thumb" alt="附件预览" loading="lazy" />
                </a>
                <span v-else class="fb-file-name">📎 {{ fileName(u) }}</span>
                <button class="fb-file-remove" type="button" title="移除附件" @click="fbUploadedUrls.splice(ui, 1)">✕</button>
              </div>
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
                :class="{ active: currentFeedback?.id === t.id, 'has-unread': t.unreadCount > 0 }"
                @click="openFeedbackTicket(t)"
              >
                <div class="fb-ticket-top">
                  <span class="fb-ticket-title">{{ t.title }}</span>
                  <span class="fb-ticket-meta-right">
                    <span v-if="t.unreadCount > 0" class="fb-unread-dot">{{ t.unreadCount > 99 ? '99+' : t.unreadCount }}</span>
                    <span class="fb-ticket-status" :class="'st-' + (t.status || '').toLowerCase()">{{ statusLabel(t.status) }}</span>
                  </span>
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
                    <a
                      v-for="(u, ui) in fmAttachments(fm)"
                      :key="ui"
                      :href="u"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <img v-if="isImage(u)" :src="u" class="fb-attach-img" :alt="'附件 ' + (ui + 1)" loading="lazy" />
                      <span v-else>📎 {{ fileName(u) }}</span>
                    </a>
                  </div>
                </div>
                <div v-if="!(currentFeedback.messages || []).length" class="panel-empty">暂无消息</div>
              </div>
              <footer class="panel-input-bar">
                <div class="fb-reply-wrap">
                  <input
                    v-model="feedbackReply"
                    :disabled="currentFeedback.status === 'CLOSED'"
                    placeholder="追加回复...（可 Ctrl+V 粘贴截图）"
                    @keyup.enter="replyFeedback"
                    @paste="(e) => handlePasteImage(e, replyUploadedUrls)"
                  />
                  <div v-if="replyUploadedUrls.length" class="fb-reply-attachments">
                    <div v-for="(u, ui) in replyUploadedUrls" :key="ui" class="fb-reply-attach">
                      <img v-if="isImage(u)" :src="u" class="fb-file-thumb" alt="附件预览" loading="lazy" />
                      <span v-else class="fb-file-name">📎 {{ fileName(u) }}</span>
                      <button class="fb-file-remove" type="button" title="移除附件" @click="replyUploadedUrls.splice(ui, 1)">✕</button>
                    </div>
                  </div>
                </div>
                <input type="file" multiple class="reply-file" @change="onReplyFilesChange" />
                <button :disabled="currentFeedback.status === 'CLOSED'" @click="replyFeedback">回复</button>
              </footer>
            </div>
            <div v-else class="panel-empty">点击上方工单查看详情</div>
          </template>
        </div>
      </aside>
    </div>

    <!-- 系统公告弹窗：GM 全服公告强制弹出，阅读 5 秒后才允许点 X 关闭 -->
    <div v-if="currentAnn" class="announcement-overlay">
      <div class="announcement-modal">
        <header class="ann-header">
          <h3>📢 系统公告</h3>
          <button
            class="ann-close"
            :disabled="!annCanClose"
            :title="annCanClose ? '关闭' : `请阅读公告，${annCountdown} 秒后可关闭`"
            @click="closeAnnouncement"
          >✕</button>
        </header>
        <!-- 富文本正文：链接可点击、图片可放大、支持粗体/斜体/代码等 Markdown 子集 -->
        <AnnRichText class="ann-body" :content="currentAnn.content" @image-click="openAnnImagePreview" />
        <footer class="ann-footer">
          <span v-if="!annCanClose" class="ann-countdown">⏳ 阅读倒计时 {{ annCountdown }} 秒后可关闭</span>
          <span v-else class="ann-countdown ok">✅ 已阅读完毕，点击右上角 ✕ 关闭</span>
        </footer>
      </div>
    </div>

    <!-- 公告图片放大预览层 -->
    <div v-if="annImagePreview" class="ann-img-preview-overlay" @click.self="closeAnnImagePreview">
      <img :src="annImagePreview.src" :alt="annImagePreview.alt || '公告配图'" class="ann-img-preview-img" />
      <button class="ann-img-preview-close" title="关闭预览" @click="closeAnnImagePreview">✕</button>
    </div>

    <!-- 全局 Toast 提示 -->
    <div class="toast-container">
      <transition-group name="toast-fade">
        <div v-for="t in toasts" :key="t.id" :class="['toast-item', t.type]">{{ t.message }}</div>
      </transition-group>
    </div>

    <!-- 部署更新提示弹窗：检测到服务器有新版本部署后主动弹出，或点击版本号手动查看 -->
    <div v-if="updateModal.show" class="update-modal-overlay" @click.self="dismissUpdate">
      <div class="update-modal">
        <header class="um-header">
          <h3>{{ updateModal.manual ? '📜 更新记录' : '✨ 游戏更新完成' }}</h3>
          <span class="um-version">v{{ APP_VERSION }} · #{{ updateModal.short }}</span>
        </header>
        <div class="um-body">
          <div class="um-meta">
            <span v-if="updateModal.deployedAt" class="um-meta-item">🕒 {{ formatDeployTime(updateModal.deployedAt) }}</span>
            <span v-if="updateModal.ref" class="um-meta-item">🌿 {{ updateModal.ref }}</span>
            <span v-if="updateModal.manual" class="um-meta-item um-meta-manual">👆 手动查看</span>
          </div>
          <div class="um-log">
            <div class="um-log-title">📋 本次更新日志（相对上次部署新增 {{ (updateModal.commits || []).length }} 条提交）</div>
            <ul class="um-log-list">
              <li v-for="c in updateModal.commits || []" :key="c.sha || c.short">
                <span class="um-log-short">{{ c.short }}</span>
                <span class="um-log-msg">{{ c.message }}</span>
                <span v-if="c.author" class="um-log-author">{{ c.author }}</span>
                <span v-if="c.date" class="um-log-date">{{ formatDeployTime(c.date) }}</span>
              </li>
            </ul>
            <div v-if="!updateModal.commits || !updateModal.commits.length" class="um-log-empty">本次部署未解析到新增提交，展示最近提交：</div>
          </div>
          <!-- 最近提交：手动查看模式或本次批次为空时展示，便于他人追溯 -->
          <div class="um-log">
            <div class="um-log-title">🕘 最近提交</div>
            <ul class="um-log-list">
              <li v-for="c in (updateModal.commits && updateModal.commits.length ? [] : (updateModal.recentCommits || []))" :key="c.sha || c.short">
                <span class="um-log-short">{{ c.short }}</span>
                <span class="um-log-msg">{{ c.message }}</span>
                <span v-if="c.author" class="um-log-author">{{ c.author }}</span>
                <span v-if="c.date" class="um-log-date">{{ formatDeployTime(c.date) }}</span>
              </li>
            </ul>
            <div v-if="!(updateModal.recentCommits && updateModal.recentCommits.length)" class="um-log-empty">暂无提交记录</div>
          </div>
        </div>
        <footer class="um-footer">
          <span v-if="autoReloadSeconds > 0 && !updateModal.manual" class="um-countdown">{{ autoReloadSeconds }} 秒后自动刷新…</span>
          <button class="um-btn um-btn-later" @click="dismissUpdate">{{ updateModal.manual ? '关闭' : '稍后' }}</button>
          <button v-if="!updateModal.manual" class="um-btn um-btn-refresh" @click="applyUpdate">立即刷新</button>
        </footer>
      </div>
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
// 玩家状态面板（桌面侧栏 + 手机抽屉复用；战斗力/任务/装备/增益一屏展示）
import PlayerStatusPanel from '../components/PlayerStatusPanel.vue';
import { io } from 'socket.io-client';
import { chatApi, commandApi, userApi, gameApi, feedbackApi, systemApi } from '../api';
import { WS_URL, API_BASE, APP_VERSION, UPDATE_SETTINGS, GITHUB_ISSUES_URL } from '../config';
import AnnRichText from '../components/AnnRichText';

const router = useRouter();
const user = ref(JSON.parse(localStorage.getItem('user') || 'null'));
const channel = ref(null);
const messages = ref([]);
const commands = ref([]);
const input = ref('');
const connected = ref(false);
const msgList = ref(null);
const inputEl = ref(null);

// ===== 消息过滤：是否显示其他玩家的聊天与系统回复 =====
// 偏好持久化到 localStorage，刷新后保持上次选择
const SHOW_OTHERS_KEY = 'smdz_show_others_msg';
// true=显示所有人；false=仅显示自己的消息（自己的聊天/指令与自己触发的系统回复）
const showOthersMsg = ref(localStorage.getItem(SHOW_OTHERS_KEY) !== '0');
// 切换过滤开关并记忆偏好；恢复显示时自动回到底部
function toggleShowOthers() {
  showOthersMsg.value = !showOthersMsg.value;
  localStorage.setItem(SHOW_OTHERS_KEY, showOthersMsg.value ? '1' : '0');
  if (showOthersMsg.value) scrollToBottom();
}

// 预解析后的渲染视图：每条消息 { id, msg, segs }，segs 是 parseContent 的缓存结果。
// 避免模板里对全部消息重复执行书名号/💡正则（消息越多越卡的主因），新消息只需解析一次。
const messageViews = computed(() =>
  visibleMessages.value.map((m, i) => ({
    // 优先用服务端消息 id 作 key；实时推送的系统回包没有 id 时用 内容+序号 兜底
    key: m.id ?? `rt-${i}-${m.createdAt || ''}`,
    msg: m,
    segs: parseContent(m.content, commands.value),
  })),
);

/**
 * 判断一条消息是否为 GM 系统公告
 * 公告统一改为弹窗展示，不再出现在公屏消息流中（服务端仍持久化留档）
 */
function isAnnouncementMsg(m) {
  return m.type === 'system' && typeof m.content === 'string' && m.content.startsWith('【系统公告】');
}

/**
 * 过滤后的可见消息列表：
 * - 系统公告一律过滤（走弹窗展示）
 * - 开关开启 → 全部消息
 * - 开关关闭 → 仅保留「自己的」消息：本人发送的聊天/指令（sender 为自己）
 *   以及自己触发的系统回复（无 sender 或 sender 无 id 的回包，与 isOwnSystemMessage 判定一致）
 */
const visibleMessages = computed(() => {
  const filtered = messages.value.filter((m) => !isAnnouncementMsg(m));
  if (showOthersMsg.value) return filtered;
  const selfId = user.value?.id;
  return filtered.filter((m) => {
    if (!m.sender) return true;
    if (m.sender.id === undefined || m.sender.id === null) return true;
    return m.sender.id === selfId;
  });
});

// 服务器统计（总人数、在线人数）
const serverStats = ref({ totalPlayers: 0, onlinePlayers: 0 });
let statsTimer = null;
let socket = null;

// 玩家信息
const playerInfo = ref(null);
// 地图总览（当前区域 + 全部地图）
const mapOverview = ref(null);
// 推送版本号守卫：丢弃网络乱序导致的旧包（rev 回退/归零视为新会话，宽容放行）
let playerRev = 0;
let mapRev = 0;
function applyPlayerUpdate(data) {
  if (!data) return;
  const rev = Number(data.rev || 0);
  if (rev > 0 && rev <= playerRev) return; // 旧包丢弃
  playerRev = rev;
  playerInfo.value = data;
}
function applyMapUpdate(payload) {
  const overview = payload?.overview ?? payload;
  if (!overview) return;
  const rev = Number(payload?.rev || 0);
  if (rev > 0 && rev <= mapRev) return;
  mapRev = rev;
  mapOverview.value = overview;
}
// 附近玩家列表（当前区域同一地图内的其他玩家，含在线状态）
const nearbyPlayers = ref([]);
// 附近玩家是否已成功加载过（用于移动端空态展示）
const nearbyLoaded = ref(false);
// 附近玩家定时刷新计时器
let nearbyTimer = null;
// 可@玩家列表定时刷新计时器
let atPlayersTimer = null;
// 玩家/地图面板兜底轮询计时器：socket 推送万一丢失时定期校准
let panelTimer = null;
// 全部地图是否折叠（默认折叠，保持面板简洁）
const allMapsCollapsed = ref(true);

// 手机端菜单状态
const mobileMenuOpen = ref(false);

// 桌面端左侧栏 Tab 切换（me=个人/cmd=指令；地图信息统一在右侧信息面板展示）
const sidebarTab = ref('me');
// 手机端抽屉 Tab 切换（与桌面端独立，避免互相干扰）
const mobileTab = ref('me');

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

// ---------- 我的常用指令（用户自定义，置顶展示、可编辑、可拖拽排序） ----------
// 常用指令数组：每项 { cmd, label }。cmd 为实际发送内容（任意文本，模拟从输入框发送）；label 为按钮展示文字
const favoriteCommands = ref([]);
// 常用指令编辑态（true=进入编辑模式，显示删除按钮/添加框/拖拽手柄）
const favEditing = ref(false);
// 添加常用指令：cmd 为发送内容（任意文本），label 为可选显示名
const favAddInput = ref('');
const favAddLabel = ref('');
// 添加时的候选指令（基于 cmd 文本从全量指令过滤，仅作快速选择辅助；也可直接输入任意文本）
const favAddCandidates = computed(() => {
  const q = favAddInput.value.trim().toLowerCase();
  if (!q) return [];
  return commands.value
    .filter(c => c.name.toLowerCase().includes(q))
    .filter(c => !favoriteCommands.value.some(f => f.cmd === c.name))
    .slice(0, 30);
});
// 保存中/提示
const favBusy = ref(false);
const favMsg = ref('');
let favMsgTimer = null;
// 常用指令数量上限（与后端 MAX_FAVORITE_COMMANDS 保持一致）
const MAX_FAVORITES = 20;
// 拖拽排序状态：当前拖拽项索引、拖拽经过项索引
const dragIndex = ref(-1);
const dragOverIndex = ref(-1);

// 加载我的常用指令
async function loadFavorites() {
  try {
    const res = await userApi.getFavorites();
    // 兼容后端返回的字符串数组（早期格式）或 {cmd,label} 对象数组，统一归一化
    const list = Array.isArray(res.data) ? res.data : [];
    favoriteCommands.value = list.map((it) =>
      typeof it === 'string' ? { cmd: it, label: it } : { cmd: it.cmd, label: it.label || it.cmd }
    );
  } catch {
    favoriteCommands.value = [];
  }
}

// toast 提示
function showFavMsg(text) {
  favMsg.value = text;
  if (favMsgTimer) clearTimeout(favMsgTimer);
  favMsgTimer = setTimeout(() => (favMsg.value = ''), 1800);
}

// 提交整体列表到后端（全量覆盖，保留当前顺序）
async function saveFavorites(next) {
  favBusy.value = true;
  try {
    const res = await userApi.setFavorites(next);
    favoriteCommands.value = Array.isArray(res.data) ? res.data : next;
    return true;
  } catch (e) {
    showFavMsg(e?.response?.data?.message || '保存失败');
    return false;
  } finally {
    favBusy.value = false;
  }
}

// 添加一条常用指令（去重按 cmd + 上限校验）
async function addFavorite(cmdText) {
  const cmd = (cmdText != null ? cmdText : favAddInput.value).trim();
  if (!cmd) return;
  const label = (favAddLabel.value || cmd).trim() || cmd;
  if (favoriteCommands.value.some((f) => f.cmd === cmd)) {
    showFavMsg('已在常用列表中');
    return;
  }
  if (favoriteCommands.value.length >= MAX_FAVORITES) {
    showFavMsg(`最多 ${MAX_FAVORITES} 条`);
    return;
  }
  const next = [...favoriteCommands.value, { cmd, label }];
  const ok = await saveFavorites(next);
  if (ok) {
    favAddInput.value = '';
    favAddLabel.value = '';
    showFavMsg('已添加');
  }
}

// 删除一条常用指令（按 cmd 匹配）
async function removeFavorite(cmd) {
  const next = favoriteCommands.value.filter((f) => f.cmd !== cmd);
  const ok = await saveFavorites(next);
  if (ok) showFavMsg('已删除');
}

// 拖拽排序：拖拽开始记录索引
function onFavDragStart(idx) {
  dragIndex.value = idx;
}
// 拖拽经过某一项：记录目标索引，便于视觉反馈
function onFavDragOver(idx) {
  dragOverIndex.value = idx;
}
// 拖拽放下：交换顺序并提交
async function onFavDrop(idx) {
  const from = dragIndex.value;
  dragIndex.value = -1;
  dragOverIndex.value = -1;
  if (from < 0 || from === idx) return;
  const next = [...favoriteCommands.value];
  const [moved] = next.splice(from, 1);
  next.splice(idx, 0, moved);
  await saveFavorites(next);
  showFavMsg('顺序已保存');
}

// 进入/退出编辑模式
function toggleFavEdit() {
  favEditing.value = !favEditing.value;
  favAddInput.value = '';
  favAddLabel.value = '';
  dragIndex.value = -1;
  dragOverIndex.value = -1;
  if (!favEditing.value) favMsg.value = '';
}

// 点击常用指令：编辑态→删除；非编辑态→直接模拟从输入框发送（任意文本）
function onFavoriteClick(item) {
  if (favEditing.value) {
    removeFavorite(item.cmd);
  } else {
    // 直接走 socket 发送（与输入框发送完全一致），cmd 可为任意文本、未必是指令
    if (socket) {
      socket.emit('chat:message', { content: item.cmd });
    } else {
      input.value = item.cmd;
      nextTick(() => inputEl.value?.focus());
    }
  }
}

// 自动补全状态
const showAutocomplete = ref(false);
const autocompleteIndex = ref(-1);

// ---------- 玩家 @ 提及状态 ----------
// 可@的玩家列表（含在线状态，在线优先），加载后缓存
const mentionablePlayers = ref([]);
// @下拉是否显示、当前选中索引、过滤关键词、@ 在输入框中的起始位置(用于替换)
const showAtAutocomplete = ref(false);
const atAutocompleteIndex = ref(-1);
const atKeyword = ref('');
const atStartPos = ref(-1);

// 过滤后的 @ 玩家列表（按在线优先、名字匹配过滤）
const filteredAtPlayers = computed(() => {
  const kw = atKeyword.value.trim().toLowerCase();
  const all = mentionablePlayers.value;
  if (!kw) return all;
  return all.filter(
    (p) =>
      (p.username && p.username.toLowerCase().includes(kw)) ||
      (p.nickname && p.nickname.toLowerCase().includes(kw)),
  );
});

// 是否为管理员(显示管理后台入口)
const isAdmin = computed(() => ['ADMIN', 'SUPER_ADMIN'].includes(user.value?.role));

// 开发登录是否启用(服务端 DEV_LOGIN_ENABLED=1 时 /auth/dev/status 返回 enabled)。
// 开发环境下无论登录哪个账号都显示管理后台入口，方便本地调试。
const devLoginEnabled = ref(false);
const showAdminEntry = computed(() => isAdmin.value || devLoginEnabled.value);

// 查询开发登录开关（失败静默：生产环境该开关恒为关闭）
async function loadDevLoginStatus() {
  try {
    const res = await fetch(`${API_BASE}/auth/dev/status`);
    const data = await res.json();
    devLoginEnabled.value = data?.data?.enabled === true;
  } catch {
    devLoginEnabled.value = false;
  }
}

// 是否为"旧版QQ绑定"：早期版本把 QQ 互联 openid（32位hex）写进了 qqNumber，
// 导致与 AstrBot 机器人传入的真实QQ号匹配不上。这里判定 qqNumber 是否为
// 5-12 位纯数字QQ号，若不是则视为旧绑定，提示玩家换绑为真实QQ号。
const isLegacyQqBind = computed(() => {
  const qq = user.value?.qqNumber;
  if (!qq) return false;
  return !/^\d{5,12}$/.test(qq);
});

// 头像的 title 提示文本
const avatarTitle = computed(() => {
  if (isAdmin.value) return '点击进入管理后台';
  if (user.value?.externalId) return `点击复制 OpenID: ${user.value.externalId}`;
  return '点击查看用户信息';
});

// 点击头像事件：管理员跳转管理后台，普通用户复制 OpenID
function onAvatarClick() {
  if (isAdmin.value) {
    router.push('/admin');
  } else if (user.value?.externalId) {
    copyOpenId();
  }
}

// ---------- 修改昵称（点击用户卡片昵称旁的编辑按钮） ----------
const nicknameEditing = ref(false);
const nicknameInput = ref('');
const nicknameError = ref('');
const nicknameBusy = ref(false);

// 打开昵称编辑（回填当前昵称）
function openNicknameEdit() {
  nicknameInput.value = user.value?.nickname || '';
  nicknameError.value = '';
  nicknameEditing.value = true;
}

// 保存昵称：调用后端接口，成功后同步本地用户信息
async function saveNickname() {
  const nick = nicknameInput.value.trim();
  if (!nick) {
    nicknameError.value = '昵称不能为空';
    return;
  }
  nicknameBusy.value = true;
  nicknameError.value = '';
  try {
    const res = await userApi.updateNickname(nick);
    user.value = { ...user.value, ...res.data };
    localStorage.setItem('user', JSON.stringify(user.value));
    nicknameEditing.value = false;
  } catch (e) {
    nicknameError.value = e?.response?.data?.message || '保存失败，请重试';
  } finally {
    nicknameBusy.value = false;
  }
}

// ---------- OpenID 展示与复制 ----------
// OpenID 中间部分用星号隐藏，保留前 6 位与后 4 位
const maskedOpenId = computed(() => {
  const id = user.value?.externalId;
  if (!id) return '未获取';
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}...${id.slice(-4)}`;
});

// 复制提示文本（2 秒后自动清空）
const copyTip = ref('');
let copyTipTimer = null;

// 复制 OpenID 到剪贴板
function copyOpenId() {
  const id = user.value?.externalId;
  if (!id) return;
  navigator.clipboard.writeText(id)
    .then(() => {
      copyTip.value = 'OpenID 已复制，请到 QQ 群发送绑定指令';
      if (copyTipTimer) clearTimeout(copyTipTimer);
      copyTipTimer = setTimeout(() => { copyTip.value = ''; }, 2000);
    })
    .catch(() => {});
}

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

// 判断系统消息是否归属当前用户（自己的指令结果 vs 别人的公屏系统广播）
// - 后台回传给自己(无 sender.id，仅 sender.username=系统，如查看背包) → 视为自己的
// - 公屏广播带 sender.id：等于当前用户 → 自己的；否则是别人的
function isOwnSystemMessage(m) {
  if (!m.sender) return true;
  const self = user.value?.id;
  // 无 id 的回传系统消息（{username:'系统'}）归属自己
  if (m.sender.id === undefined || m.sender.id === null) return true;
  return self === undefined ? true : m.sender.id === self;
}

// 消息样式分类（增强版：支持更多消息类型）
// 系统消息额外区分「自己的」与「别人的」，用于颜色区分（自己的保持金色高亮，别人的暗淡）
function msgClass(m) {
  if (m.type === 'system') return isOwnSystemMessage(m) ? 'system' : 'system system-other';
  if (m.type === 'command') return 'command';
  if (m.type === 'game') return 'game';
  if (m.type === 'combat') return 'combat';
  if (m.type === 'info') return 'info';
  return 'chat';
}

/**
 * 消息对齐分类（QQ 聊天风格）
 * - 系统/游戏/战斗/信息类消息 → center（居中，无论是否带 sender）
 * - 普通聊天和玩家指令（chat/command）→ 本人 own（右侧）、他人 other（左侧）
 * 说明：指令触发的公屏结果多为"系统广播"（如"某某移动到某地"），
 * 它们即便带玩家 sender，也应居中展示，与玩家主动发起的对话气泡区分开。
 * @param {object} m 消息对象
 * @returns {string} 'own' | 'other' | 'center'
 */
function msgAlign(m) {
  // 系统回复统一居中；command 是玩家实际发送的指令，应按发送者左右排列
  if (m.type === 'system' || m.type === 'game' || m.type === 'combat' || m.type === 'info') {
    return 'center';
  }
  // 普通聊天：按发送者归属区分左右
  if (!m.sender) return 'center';
  return m.sender.id === user.value?.id ? 'own' : 'other';
}

/**
 * 将游戏文本中的 "#换行" 标记（原版 #换行符）转换为真实换行符
 * 兜底处理历史消息：早期入库的消息可能仍带着字面 "#换行" 标记
 * @param {string} text - 原始文本
 * @returns {string} 转换后的文本
 */
function normalizeLineBreaks(text) {
  if (typeof text !== 'string' || !text.includes('#换行')) return text;
  return text.split('#换行').join('\n');
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
  // 先把 "#换行" 标记转为真实换行（配合 white-space: pre-line 正常折行显示）
  content = normalizeLineBreaks(content);
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
  closeAtAutocomplete();
  nextTick(() => inputEl.value?.focus());
}

/**
 * 取适合填入输入框的 @ 名称：优先昵称（对玩家更直观可读），
 * 但 @ 提及按「中英文/数字/下划线」解析，含空格/表情等符号的昵称会被截断，
 * 此时退回用户名，保证一定能 @ 到人
 * @param {object} p { username, nickname }
 * @returns {string}
 */
function atMentionName(p) {
  if (!p) return '';
  const nick = String(p.nickname || '').trim();
  if (nick && /^[\u4e00-\u9fa5A-Za-z0-9_]{1,32}$/.test(nick)) return nick;
  return p.username || '';
}

/**
 * 右键点击消息中的玩家名：把 "@昵称 " 填入输入框（@提及该玩家）
 * 后端 @ 匹配支持按昵称精确解析，优先填入 "@昵称 " 更直观（昵称不可用时退回用户名）
 * @param {object} sender 消息发送者 { id, username, nickname }
 */
function quickAtUser(sender) {
  if (!sender) return;
  const name = atMentionName(sender);
  if (!name) return;
  input.value = '@' + name + ' ';
  closeAtAutocomplete();
  nextTick(() => {
    inputEl.value?.focus();
    // 光标定位到末尾
    inputEl.value?.setSelectionRange(input.value.length, input.value.length);
  });
}

/**
 * 右键点击消息中的 @提及 高亮片段：把 "@xxx " 原样填入输入框
 * @param {string} text 形如 "@用户名"
 */
function quickAtText(text) {
  const name = String(text || '').replace(/^@/, '').trim();
  if (!name) return;
  input.value = '@' + name + ' ';
  closeAtAutocomplete();
  nextTick(() => {
    inputEl.value?.focus();
    inputEl.value?.setSelectionRange(input.value.length, input.value.length);
  });
}

/**
 * 检测当前输入是否处于"@模式"（光标前存在最近一个未被空格打断的 @）
 * 处于 @ 模式时返回 true，并同步更新 @ 起始位置与过滤关键词
 */
function detectAtMode() {
  const el = inputEl.value;
  const text = input.value;
  const pos = el ? el.selectionStart ?? text.length : text.length;
  // 从光标向前找最近一个 @，若 @ 到光标之间没有空格则视为 @ 模式
  const before = text.slice(0, pos);
  const atIdx = before.lastIndexOf('@');
  if (atIdx === -1) return false;
  // @ 之后到光标前不能包含空白字符（空格/换行会中断 @ 输入）
  const after = before.slice(atIdx + 1);
  if (/\s/.test(after)) return false;
  // @ 前一个字符若非空白则可能是普通文本中的 @（如邮箱），但仍允许（后端同样按此解析）
  atStartPos.value = atIdx;
  atKeyword.value = after;
  return true;
}

// 输入框值变化事件：处理 @ 玩家下拉的显示与过滤
function onInputChange() {
  if (detectAtMode()) {
    // @ 模式下：更新关键词并重置选中索引，隐藏指令补全
    showAtAutocomplete.value = true;
    atAutocompleteIndex.value = filteredAtPlayers.value.length ? 0 : -1;
    showAutocomplete.value = false;
  } else {
    closeAtAutocomplete();
  }
  // 多行文本框随内容自动调整高度
  autoResizeInput();
}

// 多行文本框自动高度：根据内容行数在 min/max 高度间伸缩，避免滚动条突兀
function autoResizeInput() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

// 选中某个玩家：把 "关键词" 替换为 "@昵称 "（昵称含特殊字符时退回用户名，保证可被解析）
function selectAtPlayer(p) {
  if (!p) return;
  const name = atMentionName(p);
  if (!name) return;
  const pos = atStartPos.value;
  const text = input.value;
  // 定位 @ 结束位置（@ 后的关键词长度，结合 atStartPos 计算替换区间）
  const atEnd = pos + 1 + atKeyword.value.length;
  // 用 @username 替换原 " @关键词 "，并在末尾补一个空格分隔后续输入
  input.value = text.slice(0, pos) + '@' + name + ' ';
  closeAtAutocomplete();
  nextTick(() => {
    inputEl.value?.focus();
    // 光标定位到 @username 之后，方便继续输入
    const caret = pos + 1 + name.length + 1;
    inputEl.value?.setSelectionRange(caret, caret);
    autoResizeInput();
  });
}

// 关闭 @ 下拉并重置状态
function closeAtAutocomplete() {
  showAtAutocomplete.value = false;
  atAutocompleteIndex.value = -1;
  atKeyword.value = '';
  atStartPos.value = -1;
}

// 指令搜索回车选中第一条
function selectFirstCmd() {
  if (cmdSearchResults.value.length > 0) {
    mobileMenuOpen.value = false;
    quickSend(cmdSearchResults.value[0].name);
  }
}

// 输入框键盘事件（keyup）：仅在非 @ 模式下控制指令自动补全
function onInputKeyup() {
  // @ 模式下隐藏指令补全，避免两者下拉冲突
  if (showAtAutocomplete.value || detectAtMode()) {
    showAutocomplete.value = false;
    return;
  }
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
  // Ctrl+Enter 组合键发送消息（多行输入时回车用于换行，不触发发送）
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendMessage();
    return;
  }
  // 优先处理 @ 玩家下拉的方向键/回车/退出
  if (showAtAutocomplete.value && filteredAtPlayers.value.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      atAutocompleteIndex.value = Math.min(atAutocompleteIndex.value + 1, filteredAtPlayers.value.length - 1);
      return;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      atAutocompleteIndex.value = Math.max(atAutocompleteIndex.value - 1, 0);
      return;
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      // 仅在下拉激活时拦截回车用于选中玩家，否则回车应换行
      e.preventDefault();
      if (atAutocompleteIndex.value >= 0 && atAutocompleteIndex.value < filteredAtPlayers.value.length) {
        selectAtPlayer(filteredAtPlayers.value[atAutocompleteIndex.value]);
      } else if (filteredAtPlayers.value.length > 0) {
        // 未选中时默认选第一个
        selectAtPlayer(filteredAtPlayers.value[0]);
      }
      return;
    } else if (e.key === 'Escape') {
      closeAtAutocomplete();
      return;
    }
  }
  // 指令自动补全键盘控制；回车仅用于选中补全项，不发送（发送统一走 Ctrl+Enter/按钮）
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
    closeAtAutocomplete();
  }, 200);
}

function selectAutocomplete(cmd) {
  input.value = cmd.name + ' ';
  showAutocomplete.value = false;
  autocompleteIndex.value = -1;
  closeAtAutocomplete();
  nextTick(() => {
    inputEl.value?.focus();
  });
}

async function sendMessage() {
  // @ 模式下按回车优先选中玩家，而不是直接发送消息
  if (showAtAutocomplete.value && filteredAtPlayers.value.length) {
    selectAtPlayer(filteredAtPlayers.value[atAutocompleteIndex.value >= 0 ? atAutocompleteIndex.value : 0]);
    return;
  }
  const content = input.value.trim();
  if (!content || !socket) return;
  // 通过 WebSocket 发送(后端自动判断聊天或指令)
  socket.emit('chat:message', { content });
  input.value = '';
  showAutocomplete.value = false;
  closeAtAutocomplete();
  autoResizeInput();
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
 * 非当日的消息会附加年月日（如 2025/06/01），避免历史消息日期不明
 * @param ts 时间戳/ISO字符串
 * @returns 当日为 HH:mm:ss，非当日为 YYYY/MM/DD HH:mm:ss，非法或缺失时返回空字符串
 */
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const now = new Date();
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return time;
  }
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${time}`;
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

// 加载附近玩家列表（当前区域同一地图内的其他玩家）
async function loadNearbyPlayers() {
  try {
    const res = await gameApi.nearbyPlayers();
    nearbyPlayers.value = res.data || [];
    nearbyLoaded.value = true;
  } catch {
    // 附近玩家接口可能暂不可用，静默忽略（保留旧数据）
  }
}

// 加载可@的玩家列表（全部 ACTIVE 账号，含在线标记，供聊天框 @ 下拉选择）
async function loadMentionablePlayers() {
  try {
    const res = await chatApi.getPlayers();
    mentionablePlayers.value = res.data || [];
  } catch {
    // 接口暂不可用则保留旧数据（@ 下拉可能暂为空，但不影响聊天）
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

// ===== 部署更新检测（检测部署完成 → 弹窗展示更新日志 → 自动刷新） =====
// localStorage 键：记录"已确认过的部署版本"(避免刷新后重复弹) 与"上次弹窗时间"(冷却去打扰)
const UPDATE_SEEN_KEY = 'smdz_seen_deploy_version';
const UPDATE_PROMPT_KEY = 'smdz_last_prompt_at';
// 当前部署版本信息(用于右上角版本标签展示短 SHA)
const deployVersion = ref(null);
// 更新弹窗内容与显隐
// manual=true 表示用户主动点击版本号查看（无自动刷新、可关闭）；false 表示检测到新部署自动弹出
const updateModal = ref({ show: false, manual: false, commits: [], recentCommits: [] });
// 更新检测配置(以后端下发的为准，管理员可在线调整)
const updateSettings = ref({ ...UPDATE_SETTINGS });
// 自动刷新倒计时(秒)
const autoReloadSeconds = ref(0);
let updateTimer = null;
let updateCountdownTimer = null;

/**
 * 拉取部署版本信息，并同步右上角版本标签与更新检测配置
 * @returns {object|null} 版本信息对象；接口不可用时返回 null
 */
async function loadDeployInfo() {
  try {
    const res = await systemApi.getVersion();
    const data = res.data || {};
    deployVersion.value = data;
    // 配置以后端 SystemConfig 下发的为准(管理员在线可调)
    if (data.settings) updateSettings.value = { ...updateSettings.value, ...data.settings };
    return data;
  } catch {
    return null;
  }
}

/**
 * 轮询检测是否完成新部署：
 * 后端 version.json 的 commit SHA 变化(且未确认过、不在冷却期) → 弹出更新日志弹窗并启动自动刷新倒计时
 */
async function checkForUpdate() {
  const data = await loadDeployInfo();
  if (!data || !data.sha || !updateSettings.value.enabled) return;
  // 该版本已确认过(弹过窗/刷过新)→ 跳过
  const seen = localStorage.getItem(UPDATE_SEEN_KEY);
  if (data.sha === seen) return;
  // 冷却期内不重复打扰(玩家点过「稍后」)
  const lastPrompt = Number(localStorage.getItem(UPDATE_PROMPT_KEY) || 0);
  if (Date.now() - lastPrompt < (updateSettings.value.promptCooldown || 300) * 1000) return;
  localStorage.setItem(UPDATE_PROMPT_KEY, String(Date.now()));
  // 弹出更新提示并开始倒计时（自动检测模式，稍后/立即刷新可用）
  updateModal.value = { show: true, manual: false, ...data };
  startUpdateCountdown();
}

/**
 * 点击版本号手动打开更新记录弹窗（不触发自动刷新、不影响"已确认"状态）
 * 便于他人在任意时刻查看本次/最近的更新日志。
 */
function openUpdateLog() {
  // 确保已拉取最新部署信息
  loadDeployInfo().then((data) => {
    const info = data || deployVersion.value || {};
    updateModal.value = {
      show: true,
      manual: true,
      // 自动检测模式已弹过时，手动查看不再标记为"新版本" → 复用当前部署信息即可
      ...info,
      commits: info.commits || [],
      recentCommits: info.recentCommits || info.commits || [],
    };
    // 手动模式下不启动自动刷新倒计时
    clearInterval(updateCountdownTimer);
    autoReloadSeconds.value = 0;
  });
}

/** 启动自动刷新倒计时(0 表示不自动刷新) */
function startUpdateCountdown() {
  clearInterval(updateCountdownTimer);
  autoReloadSeconds.value = Math.max(0, Number(updateSettings.value.autoReloadSeconds) || 0);
  if (autoReloadSeconds.value <= 0) return;
  updateCountdownTimer = setInterval(() => {
    autoReloadSeconds.value -= 1;
    if (autoReloadSeconds.value <= 0) {
      clearInterval(updateCountdownTimer);
      applyUpdate();
    }
  }, 1000);
}

/**
 * 立即刷新页面。
 * 先记录"已确认版本"再刷新，避免刷新后加载到新代码再次弹窗。
 */
function applyUpdate() {
  if (updateModal.value.sha) {
    localStorage.setItem(UPDATE_SEEN_KEY, updateModal.value.sha);
  }
  clearInterval(updateCountdownTimer);
  window.location.reload();
}

/** 稍后刷新：关闭弹窗，冷却期过后由轮询再次提醒 */
function dismissUpdate() {
  clearInterval(updateCountdownTimer);
  updateModal.value.show = false;
}

/** 格式化部署时间(精确到分钟) */
function formatDeployTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
 * 从附近玩家列表发起私聊：打开私聊面板并切换到指定玩家
 * @param {object} p 附近玩家对象（含 userId / nickname / username / online）
 */
async function startNearbyPrivateChat(p) {
  if (!p || !p.userId) return;
  // 若会话已存在，直接切换到该会话
  const existing = privateConversations.value.find((c) => c.peerId === p.userId);
  if (existing) {
    await openPrivateConversation(existing);
    privatePanelOpen.value = true;
    return;
  }
  // 新会话：先打开面板并加载历史，再在会话列表中补一条占位会话
  privatePanelOpen.value = true;
  await openPrivateConversation({ peerId: p.userId });
  privateConversations.value.unshift({
    peerId: p.userId,
    peer: { id: p.userId, nickname: p.nickname, username: p.username },
    lastMessage: '',
    lastAt: null,
    unread: 0,
  });
  // 离线玩家仍可发送（消息会持久化，对方上线后可看到）
  if (!p.online) {
    showToast(`${p.nickname || p.username} 当前离线，消息将在其上线后送达`, 'info');
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
// 未读反馈总数（管理员回复未查看的消息数汇总），用于头部红点展示
const unreadFeedbackCount = ref(0);

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
 * 同时根据每个工单的 unreadCount 字段汇总头部未读红点
 */
async function loadFeedbackTickets() {
  try {
    const res = await feedbackApi.mine();
    feedbackTickets.value = res.data || [];
    // 汇总所有工单中未查看的管理员回复数，作为头部红点显示
    unreadFeedbackCount.value = feedbackTickets.value.reduce(
      (sum, t) => sum + (t.unreadCount || 0),
      0
    );
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

/** 点击工单 → 加载详情（后端在加载时已更新 userLastReadAt） */
async function openFeedbackTicket(ticket) {
  if (!ticket) return;
  await loadFeedbackDetail(ticket.id);
  // 后端已更新 userLastReadAt，该工单的未读数变为 0
  // 重新拉取列表以拿到最新的 unreadCount 并同步刷新头部红点
  if (ticket.unreadCount > 0) {
    await loadFeedbackTickets();
  }
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
 * 通用：处理从剪贴板粘贴的图片，自动上传并加入附件列表
 * 用户在文本框中直接 Ctrl+V 粘贴截图时触发，无需手动选择文件
 * @param {ClipboardEvent} e 粘贴事件
 * @param {import('vue').Ref} urlsRef 目标附件 URL 列表 ref（fbUploadedUrls / replyUploadedUrls）
 */
async function handlePasteImage(e, urlsRef) {
  if (!e.clipboardData) return;
  // 仅处理剪贴板中的图片项；文本等内容保持默认粘贴行为
  const items = Array.from(e.clipboardData.items || []);
  const files = items
    .filter((it) => it.kind === 'file' && it.type && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  // 阻止浏览器把图片二进制当作纯文本插入输入框
  e.preventDefault();
  try {
    const res = await feedbackApi.upload(files);
    urlsRef.value = [...urlsRef.value, ...(res.data || [])];
    showToast(`已上传 ${files.length} 张图片`, 'success');
  } catch (err) {
    console.error('粘贴图片上传失败', err);
    showToast('粘贴图片上传失败', 'error');
  }
}

/** 判断附件 URL 是否为图片（用于缩略图预览） */
function isImage(url) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test((url || '').split('?')[0]);
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

// ===== 系统公告弹窗（GM 全服公告） =====
// 已读公告 id 列表持久化：点 X 关闭后才算已读，刷新/重新登录不再弹出
const ANN_SEEN_KEY = 'smdz_seen_announcement_ids';
// 强制展示时长（毫秒）：倒计时结束前 X 按钮禁用
const ANN_FORCE_MS = 5000;
// 待展示公告队列：多条公告依次弹出，关闭一条再展示下一条
const annQueue = ref([]);
// 当前正在展示的公告（队首）
const currentAnn = computed(() => annQueue.value[0] || null);
// 是否已过强制展示期（true 后才允许关闭）
const annCanClose = ref(false);
// 关闭倒计时（秒），用于按钮提示文案
const annCountdown = ref(0);
let annTimer = null;

/** 读取本地已读公告 id 列表 */
function loadSeenAnnIds() {
  try {
    const arr = JSON.parse(localStorage.getItem(ANN_SEEN_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 标记公告为已读（最多保留最近 50 条，防止无限增长） */
function markAnnSeen(id) {
  if (id == null) return;
  const seen = loadSeenAnnIds();
  if (!seen.includes(id)) {
    seen.push(id);
    localStorage.setItem(ANN_SEEN_KEY, JSON.stringify(seen.slice(-50)));
  }
}

/**
 * 展示一条系统公告：
 * - 已读过的直接忽略；未读的进入队列依次弹出
 * - 队列首条开始 5 秒强制展示倒计时，期间 X 禁用
 */
function showAnnouncement(a) {
  if (!a || a.content == null) return;
  const id = a.id ?? `rt-${a.content}-${a.createdAt || ''}`;
  if (loadSeenAnnIds().includes(id)) return;
  // 去重：同一条公告（实时推送 + 历史扫描可能重复触发）只入队一次
  if (annQueue.value.some((it) => it.id === id)) return;
  annQueue.value.push({ id, content: a.content, createdAt: a.createdAt });
  // 仅在无进行中的倒计时时启动（队列后续公告由 closeAnnouncement 接力启动）
  if (!annTimer) startAnnForceShow();
}

/** 启动强制展示倒计时：5 秒内禁止关闭 */
function startAnnForceShow() {
  clearInterval(annTimer);
  annCanClose.value = false;
  annCountdown.value = Math.ceil(ANN_FORCE_MS / 1000);
  annTimer = setInterval(() => {
    annCountdown.value -= 1;
    if (annCountdown.value <= 0) {
      clearInterval(annTimer);
      annTimer = null;
      annCanClose.value = true;
    }
  }, 1000);
}

/** 关闭当前公告（仅倒计时结束后允许）：标记已读并展示队列中的下一条 */
function closeAnnouncement() {
  if (!annCanClose.value) return;
  const cur = annQueue.value[0];
  if (cur) markAnnSeen(cur.id);
  annQueue.value.shift();
  if (annQueue.value.length) {
    startAnnForceShow();
  } else {
    clearInterval(annTimer);
    annTimer = null;
    annCanClose.value = false;
    annCountdown.value = 0;
  }
}

/** 扫描历史消息中未读的系统公告并加入弹窗队列（离线期间错过的公告上线后补弹） */
function scanHistoryAnnouncements(list) {
  for (const m of list || []) {
    if (isAnnouncementMsg(m)) showAnnouncement(m);
  }
}

// 公告图片放大预览：null = 未打开；{ src, alt } = 当前预览的图片
const annImagePreview = ref(null);
/** 打开公告配图放大预览 */
function openAnnImagePreview(img) {
  annImagePreview.value = { src: img.src, alt: img.alt || '' };
}
/** 关闭公告配图放大预览 */
function closeAnnImagePreview() {
  annImagePreview.value = null;
}

onMounted(async () => {
  try {
    // 移动端视图高度修复：动态计算实际可视高度，避免键盘弹出时布局错乱
    // 关键：必须用 visualViewport.height（键盘弹出时会实时缩小），而非 window.innerHeight
    // （iOS Safari 键盘弹出时 innerHeight 不变、resize 不触发，导致 --vh 仍为全屏高度，
    //   聊天栏/输入栏会被键盘盖住）。同时监听 visualViewport 的 resize。
    setViewportHeight = () => {
      const vv = window.visualViewport;
      const ih = window.innerHeight;
      // 兼容不同键盘模式：
      // - Android adjustResize：键盘压缩布局视口，innerHeight 缩小，但 visualViewport.height 可能不变
      // - Android adjustPan / iOS：visualViewport.height 缩小
      // 取两者较小值，能覆盖两种模式，避免输入栏被键盘遮住
      const vhHeight = Math.min(vv && vv.height ? vv.height : ih, ih);
      const vh = vhHeight * 0.01;
      document.documentElement.style.setProperty('--vh', `${vh}px`);
      // 计算"可视区底部到浏览器可视区底部"的偏移量（键盘占用的高度），
      // 供移动端固定底部的输入栏使用，确保键盘弹出时不遮挡
      const bottomDiff = Math.max(0, ih - ((vv && vv.offsetTop && vv.offsetTop + vv.height) || ih));
      document.documentElement.style.setProperty('--kb', `${bottomDiff}px`);
      document.body.classList.toggle('kb-open', bottomDiff > 1);
    };
    setViewportHeight();
    window.addEventListener('resize', setViewportHeight);
    // iOS/Android 键盘弹出时触发 visualViewport 尺寸变化，需单独监听
    window.visualViewport?.addEventListener('resize', setViewportHeight);

    // 加载频道和历史消息（拉取最近 100 条：指令原文与系统回复都保留，刷新后仍可见自己的指令）
    const ch = await chatApi.getChannel();
    channel.value = ch.data;
    const msgs = await chatApi.getMessages(ch.data.id, 100);
    // 后端按 createdAt 倒序返回（最新在前），需反转成"旧消息在上、新消息在下"，
    // 与实时 push 到末尾的顺序一致，避免新消息出现在历史消息中间/顶部
    messages.value = (msgs.data || []).reverse();
    // 扫描历史中的未读系统公告 → 弹窗补展示（离线期间错过的公告上线后仍会弹出）
    scanHistoryAnnouncements(messages.value);
    // 加载指令列表
    const cmds = await commandApi.list();
    commands.value = cmds.data;
    // 加载我的常用指令（置顶展示）
    await loadFavorites();
    // 加载玩家信息和地图总览
    await Promise.allSettled([
      loadPlayerInfo(),
      loadMapOverview(),
      loadNearbyPlayers(),
      // 加载可@的玩家列表（供聊天框 @ 下拉选择）
      loadMentionablePlayers(),
      // 反馈列表（含 unreadCount）确保头部红点正确显示
      loadFeedbackTickets(),
    ]);
    // 加载服务器统计
    loadServerStats();
    // 查询开发登录开关：开启时非管理员账号也显示管理后台入口（仅开发环境生效）
    loadDevLoginStatus();
    // 每 30 秒刷新一次服务器统计
    statsTimer = setInterval(loadServerStats, 30000);
    // 玩家/地图面板兜底轮询：socket 推送万一丢失（断线瞬间/服务重启）也能在 30 秒内自动校准
    panelTimer = setInterval(() => {
      if (!document.hidden) {
        loadPlayerInfo();
        loadMapOverview();
      }
    }, 30000);
    // 每 30 秒刷新一次附近玩家（感知其他玩家进出当前区域/上下线）
    nearbyTimer = setInterval(loadNearbyPlayers, 30000);
    // 每 60 秒刷新一次可@玩家列表（同步在线状态与新增账号）
    atPlayersTimer = setInterval(loadMentionablePlayers, 60000);

    // 部署更新检测：首次加载仅同步版本标签(不弹窗)；随后按配置间隔轮询检测新部署
    await loadDeployInfo();
    // 首次访问(本地无已确认记录)时直接记录当前版本，避免加载到最新版还弹"更新完成"提示
    if (deployVersion.value?.sha && !localStorage.getItem(UPDATE_SEEN_KEY)) {
      localStorage.setItem(UPDATE_SEEN_KEY, deployVersion.value.sha);
    }
    const updateCheckMs = Math.max(5, Number(updateSettings.value.interval) || 30) * 1000;
    updateTimer = setInterval(checkForUpdate, updateCheckMs);

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
      // 断线窗口内的状态变化无法推送 → 重连成功即全量拉取快照校准面板
      loadPlayerInfo();
      loadMapOverview();
      // 部署完成后服务重启会导致 socket 断开并自动重连到新进程，
      // "重连成功"即新服务就绪的信号：立即检查一次版本变化，秒级弹出更新提示
      // (轮询仍保留作为兜底，覆盖服务未重启但版本文件更新的场景)
      checkForUpdate();
    });
    socket.on('disconnect', () => {
      connected.value = false;
    });
    // 接收公屏消息(聊天、指令结果广播、系统消息)
    socket.on('chat:message', (msg) => {
      appendMessage(msg);
    });
    // 接收 GM 系统公告 → 强制弹窗展示（阅读 5 秒后才可关闭）
    socket.on('announcement:new', (data) => {
      showAnnouncement(data);
    });
    // 接收玩家信息更新事件（经 rev 守卫应用，丢弃乱序旧包）
    socket.on('player:update', (data) => {
      applyPlayerUpdate(data);
    });
    // 接收地图总览更新事件（移动到达后由服务端定向推送）
    socket.on('map:update', (data) => {
      applyMapUpdate(data);
      // 移动到达后同步刷新附近玩家
      loadNearbyPlayers();
    });
    // 接收服务器统计更新事件（在线人数/总玩家数变化时实时刷新左下角）
    socket.on('stats:update', (data) => {
      if (data) {
        serverStats.value = data;
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
      const { feedbackId, message: fbMsg } = data;
      // 当前正在查看该工单 → 刷新详情
      if (currentFeedback.value && currentFeedback.value.id === feedbackId) {
        loadFeedbackDetail(feedbackId);
      }
      // 管理员回复才计入未读（用户自己发的消息不算）
      if (fbMsg && fbMsg.senderType === 'admin') {
        unreadFeedbackCount.value = Math.max(0, (unreadFeedbackCount.value || 0) + 1);
        // 同步更新对应工单行的未读数字段，便于面板内展示
        const ticket = feedbackTickets.value.find((t) => t.id === feedbackId);
        if (ticket) {
          ticket.unreadCount = (ticket.unreadCount || 0) + 1;
        }
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
  window.visualViewport?.removeEventListener('resize', setViewportHeight);
  if (statsTimer) clearInterval(statsTimer);
  if (nearbyTimer) clearInterval(nearbyTimer);
  if (atPlayersTimer) clearInterval(atPlayersTimer);
  if (panelTimer) clearInterval(panelTimer);
  if (updateTimer) clearInterval(updateTimer);
  if (updateCountdownTimer) clearInterval(updateCountdownTimer);
  if (annTimer) clearInterval(annTimer);
});
</script>

<style scoped>
/* 个人中心 @username 行：长 username（完整 QQ OpenID 约35字符）超出显示省略号，不换行 */
.meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  display: block;
}
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

/* ===== 消息过滤切换按钮（显示他人/仅看自己）===== */
/* 开启态（显示所有人）：高亮描边提示当前处于全量展示 */
.filter-toggle.on {
  color: #fff;
  border-color: var(--accent);
  background: rgba(139, 92, 246, 0.18);
  box-shadow: 0 0 10px rgba(139, 92, 246, 0.25);
}
/* 小屏下缩短文案留白，避免头部拥挤 */
@media (max-width: 768px) {
  .filter-toggle {
    padding: 5px 8px;
    font-size: 12px;
  }
}

/* ===== 头部「BUG 反馈」按钮：GitHub Issues 跳转入口（比普通操作按钮更醒目） ===== */
.github-issue-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 14px;
  /* 渐变底色 + 高亮描边，使其在头部一排按钮中更突出 */
  border: 1px solid rgba(167, 139, 250, 0.65);
  border-radius: 20px;
  background: linear-gradient(135deg, #8b5cf6, #6366f1);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.15s ease;
  touch-action: manipulation;
}
.github-issue-btn:hover {
  box-shadow: 0 0 14px rgba(139, 92, 246, 0.55);
  transform: translateY(-1px);
}
.github-issue-btn:active {
  transform: scale(0.95);
}
/* GitHub 图标：固定尺寸不参与压缩，与文字垂直居中 */
.github-icon {
  flex-shrink: 0;
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

/* ===== 系统公告弹窗（GM 全服公告） ===== */
.announcement-overlay {
  position: fixed;
  inset: 0;
  /* 高于侧滑面板(100)，保证公告永远置顶 */
  z-index: 200;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeInUp 0.25s ease-out;
}
.announcement-modal {
  width: min(480px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg2);
  border: 1px solid rgba(251, 191, 36, 0.45);
  border-radius: 14px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6), 0 0 24px rgba(251, 191, 36, 0.15);
}
.ann-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--glass-border);
  background: linear-gradient(135deg, rgba(251, 191, 36, 0.14), rgba(245, 158, 11, 0.08));
}
.ann-header h3 {
  flex: 1;
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #fde68a;
}
/* 关闭按钮：强制展示期内禁用（半透明+禁止光标） */
.ann-close {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
  touch-action: manipulation;
}
.ann-close:hover:not(:disabled) {
  color: #fff;
  border-color: var(--danger);
}
.ann-close:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
/* 公告正文：富文本渲染（换行由段落承担）、超长滚动 */
.ann-body {
  padding: 18px 20px;
  overflow-y: auto;
  word-break: break-word;
  color: var(--text);
  font-size: 14px;
  line-height: 1.7;
}
/* 富文本正文内部 */
.ann-rich p {
  margin: 0 0 10px;
}
.ann-rich p:last-child {
  margin-bottom: 0;
}
/* 公告内链接：金色高亮可点击 */
.ann-rich .ann-link {
  color: #fbbf24;
  text-decoration: underline;
  text-underline-offset: 3px;
  word-break: break-all;
}
.ann-rich .ann-link:hover {
  color: #fde68a;
}
/* 非白名单协议的链接/图片：降级为纯文本并标灰提示 */
.ann-rich .ann-link-unsafe {
  color: var(--muted);
  border-bottom: 1px dashed var(--border);
}
/* 公告配图：限宽自适应、圆角、可点击放大 */
.ann-rich .ann-img {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  vertical-align: middle;
  margin: 4px 2px;
  border: 1px solid var(--glass-border);
}
/* ===== 公告图片放大预览层 ===== */
.ann-img-preview-overlay {
  position: fixed;
  inset: 0;
  /* 高于公告弹窗(200) */
  z-index: 260;
  background: rgba(0, 0, 0, 0.82);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeInUp 0.2s ease-out;
}
.ann-img-preview-img {
  max-width: min(92vw, 960px);
  max-height: 88vh;
  object-fit: contain;
  border-radius: 10px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.7);
}
.ann-img-preview-close {
  position: absolute;
  top: 18px;
  right: 22px;
  width: 40px;
  height: 40px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 16px;
  cursor: pointer;
}
.ann-img-preview-close:hover {
  background: var(--danger);
}
.ann-footer {
  padding: 10px 16px;
  border-top: 1px solid var(--glass-border);
  text-align: right;
}
.ann-countdown {
  font-size: 12px;
  color: var(--muted);
}
.ann-countdown.ok {
  color: #34d399;
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

/* 消息发送者名（支持右键 @ 提人） */
.sender {
  cursor: context-menu;
}

/* ===== 聊天框 @ 玩家下拉 ===== */
.at-list .ac-item .ac-at-icon {
  color: #fbbf24;
  font-weight: 800;
  margin-right: 4px;
}
.at-list .ac-item .ac-name {
  color: #fbbf24;
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
.fb-ticket.has-unread {
  border-left: 2px solid var(--danger);
  background: rgba(239, 68, 68, 0.05);
}
.fb-ticket-meta-right {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
/* 工单列表中的未读小红点（管理员回复未查看） */
.fb-unread-dot {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 10px;
  background: var(--danger);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
  animation: badgePulse 1.5s ease-in-out infinite;
}
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
  flex-wrap: wrap;
  gap: 6px;
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
.fmsg-attachments .fb-attach-img {
  width: 96px;
  height: 96px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--border-light);
  cursor: pointer;
  display: block;
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
  gap: 8px;
  margin-top: 4px;
}
.fb-file-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--accent2);
  background: rgba(6, 182, 212, 0.08);
  border: 1px solid rgba(6, 182, 212, 0.2);
  padding: 3px 6px;
  border-radius: 8px;
  position: relative;
}
.fb-file-item .fb-file-thumb {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
  display: block;
  cursor: pointer;
}
.fb-file-item .fb-file-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-file-remove {
  background: none;
  border: none;
  color: var(--danger);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
  line-height: 1;
  flex-shrink: 0;
}
.fb-file-remove:hover {
  color: #f87171;
}
/* 回复输入框中的附件预览小区域 */
.fb-reply-wrap {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.fb-reply-wrap input {
  width: 100%;
  padding: 9px 12px;
  background: rgba(10, 10, 26, 0.8);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.fb-reply-wrap input:focus {
  border-color: var(--accent);
}
.fb-reply-wrap input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.fb-reply-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.fb-reply-attach {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: rgba(6, 182, 212, 0.08);
  border: 1px solid rgba(6, 182, 212, 0.2);
  border-radius: 6px;
  padding: 2px 4px;
}
.fb-reply-attach .fb-file-thumb {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: 4px;
  display: block;
  cursor: pointer;
}
.fb-reply-attach .fb-file-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  background: rgba(0,0,0,0.7);
  border-radius: 50%;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: #fff;
  border: 1px solid var(--border-light);
}
.reply-file {
  max-width: 72px;
  font-size: 11px;
  color: var(--muted);
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

/* ===== 版本标签中的部署短 SHA ===== */
.version-tag-sha {
  font-style: normal;
  margin-left: 4px;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(139, 92, 246, 0.18);
  border: 1px solid rgba(139, 92, 246, 0.35);
  color: #c4b5fd;
  font-size: 10px;
  font-weight: 600;
}

/* ===== 部署更新提示弹窗 ===== */
.update-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.update-modal {
  width: 600px;
  max-width: 94vw;
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  background: var(--bg2);
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55), 0 0 32px rgba(139, 92, 246, 0.15);
  animation: umPopIn 0.25s ease-out;
  overflow: hidden;
}
@keyframes umPopIn {
  from { opacity: 0; transform: translateY(12px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.um-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--glass-border);
  background: rgba(10, 10, 26, 0.6);
}
.um-header h3 {
  font-size: 15px;
  color: var(--text);
  margin: 0;
}
.um-version {
  flex-shrink: 0;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 20px;
  background: rgba(139, 92, 246, 0.18);
  border: 1px solid rgba(139, 92, 246, 0.35);
  color: #c4b5fd;
  font-weight: 600;
}
.um-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.um-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.um-meta-item {
  font-size: 12px;
  color: var(--muted);
  padding: 3px 10px;
  border-radius: 8px;
  background: rgba(139, 92, 246, 0.08);
  border: 1px solid rgba(139, 92, 246, 0.18);
}
.um-meta-manual {
  background: rgba(56, 189, 248, 0.08);
  border-color: rgba(56, 189, 248, 0.18);
  color: #7dd3fc;
}
.um-log-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}
.um-log-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.um-log-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 8px;
  background: rgba(10, 10, 26, 0.5);
  border: 1px solid var(--glass-border);
  font-size: 13px;
  line-height: 1.45;
}
.um-log-short {
  flex-shrink: 0;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 11px;
  color: #a78bfa;
  background: rgba(139, 92, 246, 0.14);
  border-radius: 6px;
  padding: 1px 6px;
}
.um-log-msg {
  color: var(--text-secondary);
  word-break: break-word;
  /* 保留提交信息中的换行符，支持多行更新内容展示 */
  white-space: pre-line;
}
.um-log-author {
  flex-shrink: 0;
  font-size: 11px;
  color: #f0abfc;
}
.um-log-date {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
.um-log-empty {
  font-size: 12px;
  color: var(--muted-dark);
  text-align: center;
  padding: 10px 0;
}
.um-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--glass-border);
  background: rgba(10, 10, 26, 0.6);
}
.um-countdown {
  flex: 1;
  font-size: 12px;
  color: var(--muted);
  animation: umPulse 1s ease-in-out infinite;
}
@keyframes umPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.um-btn {
  padding: 8px 16px;
  border-radius: 8px;
  border: none;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}
.um-btn-later {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
}
.um-btn-later:hover {
  color: var(--text);
  border-color: var(--text-secondary);
}
.um-btn-refresh {
  background: var(--accent-gradient);
  color: #fff;
}
.um-btn-refresh:hover {
  filter: brightness(1.1);
}
.um-btn-refresh:active {
  transform: scale(0.96);
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
  .update-modal {
    max-height: 90vh;
  }
}
</style>
