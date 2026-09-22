<template>
  <!-- 开局门闸：判定完成前不渲染主界面，避免新玩家看到一瞬间的空壳页 -->
  <div v-if="!bootReady" class="boot-splash">
    <div class="boot-ring"></div>
  </div>

  <div v-show="bootReady" class="chat-page">
    <!-- 左侧：用户信息 + Tab 切换面板 -->
    <aside class="sidebar">
      <!-- 顶部固定：用户卡片（次要信息折叠进昵称下方小字）+ 绑定提示（按需展开） -->
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
              <!-- 当前使魔徽标：贴在昵称右侧，不单独占一行 -->
              <span v-if="playerInfo?.type" class="user-marker" :title="'当前使魔：' + playerInfo.type">{{ playerInfo.type }}</span>
            </div>
            <!-- 昵称行内编辑 -->
            <div v-if="nicknameEditing" class="nickname-edit-row">
              <input v-model="nicknameInput" class="nickname-input" maxlength="20" placeholder="输入新昵称" @keyup.enter="saveNickname" @keyup.esc="nicknameEditing = false" />
              <button class="qq-btn primary" :disabled="nicknameBusy" @click.stop="saveNickname">{{ nicknameBusy ? '…' : '保存' }}</button>
              <button class="qq-btn" @click.stop="nicknameEditing = false">取消</button>
            </div>
            <div v-if="nicknameError" class="nickname-error">{{ nicknameError }}</div>
            <!-- 次要信息单行：OpenID（点击复制）+ QQ 绑定状态，小字号贴着昵称下方 -->
            <div v-if="!nicknameEditing" class="sub-row">
              <span
                class="sub-id"
                :title="'点击复制 OpenID：' + (user?.externalId || '未登录')"
                @click.stop="copyOpenId"
              >ID {{ maskedOpenId }}</span>
              <span v-if="user?.qqNumber && !isLegacyQqBind" class="sub-qq" title="已绑定真实 QQ 号">✅ QQ {{ user.qqNumber }}</span>
              <button v-else class="sub-qq unbound" :title="bindHintTitle" @click.stop="bindHintOpen = !bindHintOpen">⚠️ 未绑定</button>
              <span v-if="copyTip" class="sub-copy">{{ copyTip }}</span>
            </div>
          </div>
          <span v-if="isAdmin" class="admin-badge">ADMIN</span>
        </div>

        <!-- 绑定引导：默认收起，点「未绑定」才展开，避免常驻占高 -->
        <div v-if="bindHintOpen" class="bind-hint">
          <span class="bind-hint-text">在 QQ 群发送：</span>
          <code class="bind-cmd">使魔大战绑定QQ {{ user?.externalId || '你的OpenID' }}</code>
          <button class="qq-btn" :disabled="!user?.externalId" @click.stop="copyOpenId">📋 复制</button>
        </div>
      </div>

      <!-- 中部：Tab 切换 -->
      <div class="sidebar-tabs">
        <button class="sidebar-tab" :class="{ active: sidebarTab === 'me' }" @click="sidebarTab = 'me'">
          <span class="tab-icon">👤</span>我的
        </button>
        <!-- 家园：跳独立全屏页 /home（侧栏放不下格子院落）；前线面板从家园页顶栏切换进入 -->
        <button
          class="sidebar-tab"
          title="打开家园院子（独立页面）"
          @click="router.push('/home')"
        >
          <span class="tab-icon">🏠</span>家园
        </button>
        <!-- 竞技场：镜像天梯独立页面（榜单 + 战报回放占屏大，同样塞不进侧栏） -->
        <button
          class="sidebar-tab"
          title="打开使魔竞技场天梯（独立页面）"
          @click="router.push('/arena')"
        >
          <span class="tab-icon">🏟️</span>竞技场
        </button>
      </div>

      <div class="sidebar-content">
        <!-- 我的 Tab：玩家信息 + 快捷操作 -->
        <div v-show="sidebarTab === 'me'" class="tab-pane">
          <!-- 玩家状态面板：桌面侧栏与 App 级「我的」底部抽屉共用组件（等级/血条/战斗力/任务/装备/增益实时展示）；@send 接武器列表「卸下」按钮指令 -->
          <PlayerStatusPanel
            v-if="playerInfo"
            :info="playerInfo"
            :nickname="user?.nickname || user?.username || ''"
            @send="onRichCardSend"
          />
          <div class="player-info" v-else>
            <div class="pi-row">
              <span class="pi-label">状态</span>
              <span class="pi-value" style="color: var(--muted); font-size: 12px;">未加载 信息 查看</span>
            </div>
          </div>

          <!-- 我的常用指令：用户自定义，可编辑、可拖拽排序，点击直接发送（实现见 components/FavoriteCommands.vue） -->
          <FavoriteCommands ref="favRef" @send="onFavoriteSend" />
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
          <!-- 在线：悬停展开在线玩家名单（条数上限由后端配置决定，默认 10） -->
          <div
            class="ss-text ss-online-wrap"
            title="悬停查看在线玩家名单"
            @mouseenter="openOnlinePanel"
            @mouseleave="scheduleCloseOnlinePanel"
          >
            <span class="ss-label">在线</span>
            <span class="ss-value ss-online">{{ serverStats.onlinePlayers }}</span>
            <div
              v-if="onlinePanelOpen"
              class="ss-popover"
              @mouseenter="openOnlinePanel"
              @mouseleave="scheduleCloseOnlinePanel"
            >
              <div class="ss-pop-head">
                <span>当前在线</span>
                <span class="ss-pop-count">{{ serverStats.onlinePlayers }}</span>
              </div>
              <ul v-if="serverStats.onlineList.length" class="ss-pop-list">
                <li v-for="(name, i) in serverStats.onlineList" :key="name + '-' + i">
                  <span class="ss-pop-dot"></span>
                  <span class="ss-pop-name">{{ name }}</span>
                </li>
              </ul>
              <div v-else class="ss-pop-empty">暂无在线玩家</div>
              <div v-if="hiddenOnlineCount > 0" class="ss-pop-more">
                另有 {{ hiddenOnlineCount }} 名玩家在线
              </div>
            </div>
          </div>
          <!-- 上下线提示：紧跟「在线」数字同一行只显示最新一条（1 分钟后自动消失，时长见 PRESENCE_CONFIG） -->
          <div
            v-if="presenceNotices.length"
            :key="presenceNotices[0].id"
            class="ss-presence"
            :class="presenceNotices[0].type"
          >
            <span class="ss-presence-name">{{ presenceNotices[0].name }}</span>
            <span class="ss-presence-text">{{ presenceNotices[0].type === 'online' ? '上线了' : '离线了' }}</span>
          </div>
        </div>
        <div class="sidebar-footer-actions">
          <button class="logout" title="个人设置" @click="settingsOpen = true">🔧 设置</button>
          <button v-if="showAdminEntry" class="logout admin-entry" @click="router.push('/admin')">⚙️ 管理后台</button>
          <button class="logout reset-data" @click="resetMyData">清除数据</button>
          <button class="logout" @click="logout">退出</button>
        </div>
      </div>
    </aside>


    <!-- 右侧：公屏聊天 -->
    <main class="chat-main">
      <!-- 桌面端顶栏：过滤 / 版本 / 指令面板 / 反馈 / 外链。
           手机端整条隐藏（≤768px）：过滤与指令面板已下移到拇指区的快捷指令条，
           版本与反馈进了「我的」面板，顶部由 App 级 HUD 接管。 -->
      <header class="chat-header">
        <div class="header-right action-dock" :class="{ 'is-hidden': dockHidden }" @mouseenter="revealDock" @mouseleave="scheduleDockHide">
          <!-- 消息过滤切换：选择是否显示其他玩家的聊天与系统回复 -->
          <button
            class="header-action-btn filter-toggle"
            :class="{ on: showOthersMsg }"
            :title="showOthersMsg ? '当前显示所有人的系统/指令消息，点击隐藏他人的回复' : '当前仅显示自己的消息，点击恢复显示他人消息'"
            @click="toggleShowOthers"
          >
            {{ showOthersMsg ? '👁 显示他人' : '🙈 仅看自己' }}
          </button>
          <span class="version-tag" title="点击查看更新记录" @click="openUpdateLog">v{{ APP_VERSION }}<em v-if="deployVersion?.short" class="version-tag-sha">#{{ deployVersion.short }}</em></span>
          <!-- 命令面板入口：桌面端可用 Cmd/Ctrl+K 唤起，移动端点此打开 -->
          <button class="header-action-btn palette-open-btn" title="指令面板（Cmd/Ctrl+K）" @click="ui.openPalette()">
            ⌨️ 指令
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

      <!-- 全服世界事件：常驻细进度条（贴 header 下，不随消息流滚动）；点击展开完整面板，实时增量来自 socket worldEvent:progress -->
      <WorldEventBar
        :live="worldEventProgress"
        :connected="connected"
        @send="onWorldEventSend"
        @notify="(p) => showToast(p?.message, p?.type || 'info')"
      />

      <!-- 消息列表 -->
      <!-- 滚动意图：仅滚轮 / 触摸上翻 / 拖滚动条算用户主动翻历史，才解除贴底跟随；图片/大卡片迟到渲染引起的布局变化不算 -->
      <div ref="msgList" class="messages" @scroll="onMsgScroll"
           @wheel.passive="onWheelIntent"
           @touchstart.passive="onTouchStartIntent"
           @touchmove.passive="onTouchMoveIntent"
           @pointerdown="markUserScrollIntent">
        <div v-for="(v, i) in messageViews" :key="v.key" :class="['msg', msgClass(v.msg), msgAlign(v.msg), { 'msg-rich': v.rich, 'msg-battle': v.battle, 'msg-cv': v.cv }]"
             :title="isUserMsg(v.msg) ? '单击复制消息 / 双击重发' : undefined"
             @click="onMsgClick(v.msg)"
             @dblclick="onMsgDblClick(v.msg)">
          <div class="msg-body">
            <!-- TODO(arena) 头像框暂未铺到这里：聊天消息列表根本没有头像节点，且服务端消息负载的
                 sender 只 select {id, username, nickname}（server/src/modules/chat/chat.service.ts），
                 既没有 avatar 也没有 frame。要渲染「佩戴中头像框」的彩色描边，需要
                 ① 服务端 sender 带上 frame:{key,name,tone}，② 这里加一个头像元素，
                 ③ 复用 ArenaView 的 TONE_CLASS 色表（tone → ar-tone-* 类）。
                 属于消息负载改造，不在本次只读面板范围内，故此处仅留标记不动结构。 -->
            <span v-if="v.msg.sender" class="sender" :title="'右键 @ ' + (v.msg.sender.nickname || v.msg.sender.username)" @contextmenu.prevent="quickAtUser(v.msg.sender)">{{ v.msg.sender.nickname || v.msg.sender.username }}：</span>
            <span v-else-if="v.msg.type !== 'system' && v.msg.type !== 'game' && v.msg.type !== 'combat' && v.msg.type !== 'info'" class="sender">系统：</span>
            <!-- 私密消息（自己发出的）→ 打上 🔒 标记便于识别；他人看到的是占位文案，文案本身已带锁图标 -->
            <span v-if="isPrivateSelfMsg(v.msg)" class="private-badge" title="这条消息只有你自己能看到完整内容">🔒 仅你可见</span>
            <!-- 战斗结算 → 修真科幻风战斗卡片（伤害重击/暴击迸发/击杀烙印动画） -->
            <div v-if="v.battle" class="battle-wrap"><BattleCard :text="v.msg.content" :viewer-name="viewerName" /></div>
            <!-- 结构化长消息（背包/属性/装备）→ 网格卡片布局；外层 div 显式撑满，避免 center 对齐收缩宽度 -->
            <div v-else-if="v.rich" class="rich-wrap"><RichSystemCard :text="v.msg.content" @send="onRichCardSend" /></div>
            <!-- 家园建造四步引导 → 带动画的进度卡片（按钮只发指令，跳转去 /home） -->
            <div v-else-if="v.homeGuide" class="home-guide-wrap">
              <HomeBuildGuide :step="v.homeGuide" @send="onHomeGuideSend" @open-home="goHomeYard" />
            </div>
            <span v-else class="content" style="white-space: pre-line">
              <template v-for="(seg, si) in v.segs" :key="si">
                <span v-if="seg.type === 'text'">{{ seg.text }}</span>
                <span v-else-if="seg.type === 'mention'" class="mention-highlight" :title="'右键 @ ' + (seg.displayText || seg.text).replace('@', '')" @contextmenu.prevent="quickAtText(seg.displayText || seg.text)">{{ seg.displayText || seg.text }}</span>
                <span v-else class="cmd-clickable" :title="'左键点击发送 / 右键填入输入框「' + seg.text + '」'" @click.stop="quickSend(seg.text)" @contextmenu.prevent="quickFill(seg.text)">{{ seg.displayText || seg.text }}</span>
              </template>
            </span>
          </div>
          <span class="msg-time">{{ formatTime(v.msg.createdAt) }}</span>
        </div>
        <div v-if="!messageViews.length" class="empty">
          <template v-if="messages.length">🙈 已隐藏其他玩家的消息，点击顶部「仅看自己」可恢复</template>
          <template v-else>
            <div>暂无游戏消息，发送第一条指令吧！</div>
            <div class="empty-chat-hint">世界聊天在右下角 💬 悬浮窗</div>
          </template>
        </div>
        <!-- 回到底部按钮 -->
        <button v-if="showScrollBtn" class="scroll-bottom-btn" @click="scrollToBottom()">↓ 回到底部</button>
      </div>

      <!-- 进行中操作倒计时：采集/移动/抢救等延时指令的剩余时间与进度 -->
      <PendingActionBar
        :actions="pendingActions"
        :admin-mode="isAdmin"
        @expired="onPendingExpired"
        @complete="onPendingComplete"
      />

      <!-- 手机端快捷指令条（拇指区「技能栏」）：横向滑动，一屏拇指可及。
           取代原来的 4 个 34px emoji 方块 + 顶栏的 ⌨️指令 / 👁显示他人 两个入口。 -->
      <div class="m-skills">
        <button class="msk msk-cmd" type="button" @click="ui.openPalette()">
          <span class="msk-ico">⌨️</span><span class="msk-t">指令</span>
        </button>
        <!-- 世界聊天入口：手机端不再有右下角可拖的悬浮气泡（那是一件网页小工具），
             改成与技能栏同级的一个键，未读数挂在角标上。面板本体仍是 FloatingChatWidget。 -->
        <button class="msk" :class="{ on: floatingChat.open }" type="button" @click="toggleWorldChat()">
          <span class="msk-ico">🌍<span v-if="floatingChat.unread > 0" class="msk-badge">{{ floatingChat.unread > 99 ? '99+' : floatingChat.unread }}</span></span>
          <span class="msk-t">世界</span>
        </button>
        <button
          class="msk"
          :class="{ on: showOthersMsg }"
          type="button"
          :aria-pressed="showOthersMsg"
          @click="toggleShowOthers"
        >
          <span class="msk-ico">{{ showOthersMsg ? '👁' : '🙈' }}</span><span class="msk-t">{{ showOthersMsg ? '他人' : '只看我' }}</span>
        </button>
        <button class="msk" type="button" @click="quickAction('背包')"><span class="msk-ico">🎒</span><span class="msk-t">背包</span></button>
        <button class="msk" type="button" @click="quickAction('信息')"><span class="msk-ico">📋</span><span class="msk-t">信息</span></button>
        <button class="msk" type="button" @click="quickAction('地图')"><span class="msk-ico">🗺️</span><span class="msk-t">地图</span></button>
        <button class="msk atk" type="button" @click="quickAction('攻击')"><span class="msk-ico">⚔️</span><span class="msk-t">攻击</span></button>
        <!-- 玩家自己的常用指令直接铺进技能栏：点一下就发，等价于桌面上的常用芯片 -->
        <button
          v-for="f in skillFavorites"
          :key="'msk-' + f.cmd"
          class="msk fav"
          type="button"
          @click="onFavoriteSend(f.cmd)"
        >
          <span class="msk-t">{{ f.label }}</span>
        </button>
        <span v-if="skillFavsHint" class="msk-more" @click="ui.openMe()">＋ 在「我的」里加常用</span>
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
            @compositionstart="onInputCompositionStart"
            @compositionend="onInputCompositionEnd"
            @blur="onInputBlur"
            placeholder="回车换行，Ctrl+Enter 发指令；Ctrl+K 唤起指令面板"
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
              <!-- 非名称命中（别名/拼音/首字母）时展示命中来源，解释候选为何出现 -->
              <span v-if="cmd.match && cmd.match.type !== 'name'" class="ac-hit">{{ hitLabel(cmd.match) }}</span>
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

    <!-- 右下角悬浮世界聊天：与中央游戏区隔离，聊天/红包等不淹没战斗指令结果 -->
    <!-- mention-players：复用本页轮询的可@玩家列表，供悬浮窗 @ 下拉与右键 @ 使用 -->
    <FloatingChatWidget
      :connected="connected"
      :self-id="user?.id"
      :mention-players="mentionablePlayers"
      :send="(text) => sendChatMessage(text, 'floating')"
      @refresh-players="loadMentionablePlayers"
      @notify="onFloatingNotify"
    />

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
          <!-- 点击怪物行 = 直接发送「攻击 怪物名」指令（与 NPC 行同款快捷交互） -->
          <div v-for="m in mapOverview.currentMap.monsterList" :key="'cur-mon-' + m.name" class="ip-row npc-row" title="点击发送攻击指令" @click="quickAction('攻击 ' + m.name)">
            <span class="ip-row-name">💀 {{ m.name }}</span>
            <span class="ip-row-meta">Lv.{{ m.level }} · HP {{ Math.round(m.hp || 0) }}</span>
          </div>
        </div>
        <div class="ip-empty" v-else>该地图暂无怪物</div>
      </div>

      <div class="ip-block" v-if="mapOverview?.currentMap">
        <h4 class="ip-title">⛏️ 资源 ({{ mapOverview.currentMap.resources || 0 }})</h4>
        <div class="ip-list" v-if="mapOverview.currentMap.resourceList?.length">
          <!-- 点击资源行 = 直接发送该资源的采集指令（gatherCmd 优先，如 打开货舱/收集能量；缺失时回退「采集 资源名」）
               右键 = 超管批量采集（仅管理员绑定，以剩余最大次数发送） -->
          <div
            v-for="r in mapOverview.currentMap.resourceList"
            :key="'cur-res-' + r.name"
            class="ip-row npc-row"
            :title="isAdmin ? '点击单次采集；右键批量采集' : '点击发送采集指令'"
            @click="quickAction(r.gatherCmd || '采集 ' + r.name)"
            @contextmenu.prevent="isAdmin && quickGatherMax(r)"
          >
            <span class="ip-row-name">📦 {{ r.name }}</span>
            <span class="ip-row-meta" v-if="r.times >= 0">×{{ r.times }} · {{ r.gatherCmd || '采集' }}</span>
            <span class="ip-row-meta" v-else>{{ r.gatherCmd || '采集' }}</span>
          </div>
        </div>
        <div class="ip-empty" v-else>该地图暂无资源</div>
      </div>

      <div class="ip-block" v-if="mapOverview?.currentMap">
        <h4 class="ip-title">💬 NPC ({{ mapOverview.currentMap.npcs || 0 }})</h4>
        <div class="ip-list" v-if="mapOverview.currentMap.npcList?.length">
          <div v-for="(n, ni) in mapOverview.currentMap.npcList" :key="'cur-npc-' + ni + '-' + n.name" class="ip-row npc-row" @click="quickAction('对话 ' + n.name)">
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
            title="点击把 TA 的 @ 提及填入输入框"
            @click="atNearbyPlayer(p)"
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

      <!-- 全部地图：可折叠，点击条目发 go 指令快速传送 -->
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

    <!-- 个人设置弹窗：用户级设置功能统一收纳（当前：血量预警特效档位） -->
    <div v-if="settingsOpen" class="settings-overlay" @click.self="settingsOpen = false">
      <div class="settings-modal">
        <header class="set-header">
          <h3>🔧 个人设置</h3>
          <button class="panel-close" title="关闭" @click="settingsOpen = false">✕</button>
        </header>
        <div class="set-body">
          <section class="set-section">
            <div class="set-section-title">🩸 血量预警特效</div>
            <div class="set-section-desc">低血量 / 死亡时屏幕边缘光效的强度档位，立即生效</div>
            <div class="set-options">
              <button
                v-for="opt in HP_VFX_OPTIONS"
                :key="opt.value"
                class="set-option"
                :class="{ active: ui.hpVfxLevel === opt.value }"
                @click="ui.setHpVfxLevel(opt.value)"
              >
                <span class="set-option-name">{{ opt.label }}<i v-if="ui.hpVfxLevel === opt.value" class="set-option-check">✓ 当前</i></span>
                <span class="set-option-desc">{{ opt.desc }}</span>
              </button>
            </div>
          </section>
        </div>
      </div>
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

    <!-- 高光时刻动画层：任务达成 / 领取新任务 / 获得称号 / 等级提升 时播放屏幕级动画 -->
    <GameHighlight ref="highlightRef" />

    <!-- 血量预警 / 死亡状态全屏特效层：三边呼吸光效分层预警 + 死亡三段式反馈（档位见顶栏开关） -->
    <HealthVfx :info="playerInfo" />

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

    <!-- 命令面板（Cmd/Ctrl+K 唤起）：复用本页已加载的指令列表 -->
    <CommandPalette :commands="commands" @select="onPaletteSelect" />
  </div>
</template>

<script setup>
/**
 * 公屏聊天页：Socket.IO 实时收发指令/系统消息 + 指令自动补全 +
 * 玩家状态侧栏、地图信息面板、常用指令、反馈工单、公告与部署更新弹窗。
 */
// App.vue 的 keep-alive 按组件名匹配缓存（include: ['ChatView', ...]），名字必须显式声明
defineOptions({ name: 'ChatView' });

import { ref, onMounted, onUnmounted, nextTick, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import PlayerStatusPanel from '../components/PlayerStatusPanel.vue';
import PendingActionBar from '../components/PendingActionBar.vue';
import WorldEventBar from '../components/WorldEventBar.vue';
import FloatingChatWidget from '../components/FloatingChatWidget.vue';
import { io } from 'socket.io-client';
import { chatApi, userApi, gameApi, feedbackApi, systemApi } from '../api';
import {
  WS_URL,
  API_BASE,
  APP_VERSION,
  UPDATE_SETTINGS,
  GITHUB_ISSUES_URL,
  // @提及 规则（字符集/长度/下拉上限/刷新间隔）统一从配置读取，与后端解析规则保持一致
  MENTION_CONFIG,
  mentionParseRegex,
  isSafeMentionName,
  // 在线玩家悬浮面板 / 上下线提示（保留时长、条数、关闭延迟）配置
  PRESENCE_CONFIG,
  // 指令检索（拼音/别名匹配、各入口条数上限）配置
  COMMAND_SEARCH_CONFIG,
  // 家园建造四步引导（识别规则 / 步骤 / 动画 / 自动跳转）配置
  HOME_BUILD_GUIDE_CONFIG,
} from '../config';
import AnnRichText from '../components/AnnRichText';
import GameHighlight from '../components/GameHighlight.vue';
// 血量预警 / 死亡状态全屏特效层
import HealthVfx from '../components/HealthVfx.vue';
// 结构化长消息（背包/属性/装备）网格卡片渲染：纯前端展示层，不影响后端/AstrBot 文本
import RichSystemCard from '../components/RichSystemCard.vue';
// 家园建造四步引导卡片（圈地→开挖地基→建造地基→建造房子）
import HomeBuildGuide from '../components/HomeBuildGuide.vue';
import BattleCard from '../components/BattleCard.vue';
import CommandPalette from '../components/CommandPalette.vue';
// 「我的常用指令」面板：桌面侧栏用实例，手机端编辑入口在 App 级「我的」抽屉里（状态与后端读写都在组件内）
import FavoriteCommands from '../components/FavoriteCommands.vue';
import { useUiStore } from '../stores/ui';
import { useCommandStore } from '../stores/command';
import { useConnectionStore } from '../stores/connection';
import { usePlayerStore } from '../stores/player';
import { useFloatingChatStore } from '../stores/floatingChat';
import { syncServerClock } from '../utils/serverClock';
import { parseHighlights, GAME_HIGHLIGHT_EVENT } from '../utils/gameHighlight';
import { isBattleContent } from '../utils/battleText';
// 指令检索：中文名/别名/拼音全拼/拼音首字母统一匹配，供自动补全、侧栏搜索、常用指令候选取用
import { searchCommands, hitLabel } from '../utils/commandSearch';
// App 级总线：手机 HUD / 底部标签栏 / 「我的」面板都常驻在 App 层，发指令与开弹窗都要借本页执行
import { subscribeCommands, onChatAction } from '../utils/bus';
import { onTabRetap } from '../composables/useTabRetap';
// 触感反馈：主操作与芯片点击各一档震感，不支持 vibrate 的平台（iOS）自动静默
import { tapMedium, tapLight } from '../utils/haptics';

const router = useRouter();
const ui = useUiStore();
// 集中状态（Pinia store）：指令列表 / 连接与服务器统计 / 玩家信息
const commandStore = useCommandStore();
const connectionStore = useConnectionStore();
const playerStore = usePlayerStore();
// 世界聊天（type=chat）与中央游戏流分离：聊天进悬浮窗，指令/战斗/系统留中央
const floatingChat = useFloatingChatStore();
const user = ref(JSON.parse(localStorage.getItem('user') || 'null'));
const channel = ref(null);
const messages = ref([]);
const commands = computed(() => commandStore.commands);
const input = ref('');
const connected = computed(() => connectionStore.connected);
// 全服世界事件：socket worldEvent:progress 最新进度（常驻细条实时增量，喂给 WorldEventBar）
const worldEventProgress = ref(null);
// 面板「领取已解锁奖励」按钮 → 走统一发指令通道（与 QQ 端逐字相同，不新增写接口）
function onWorldEventSend(text) {
  if (!connected.value) {
    showToast('未连接服务器，请稍后再试', 'error');
    return;
  }
  if (sendChatMessage(String(text || '')) === false) {
    showToast('发送过于频繁，请稍后再试', 'error');
  }
}
const msgList = ref(null);
const inputEl = ref(null);

/**
 * 开局门闸：判定「是否需要引导」完成前不渲染主界面，避免新玩家先看到一帧空壳页再被跳转；
 * 也保证移动端测高时拿得到真实布局尺寸。
 */
const bootReady = ref(false);

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

// 预解析渲染视图：segs 是 parseContent 的缓存结果，用 WeakMap 按消息对象缓存，
// 避免模板对全部消息重复跑书名号/💡 正则（消息越多越卡的主因）；命令列表变化时才重算。
const msgParseCache = new WeakMap();
function cachedParseMsg(m) {
  const cmds = commands.value;
  const hit = msgParseCache.get(m);
  if (hit && hit.cmds === cmds) return hit; // 命令列表未变 → 直接复用
  const v = {
    cmds,
    segs: parseContent(m.content, cmds),
    // 背包/属性面板等结构化长列表 → 用网格卡片渲染；其余保持原样式
    rich: isRichCardContent(m.content),
    // 战斗结算文本 → 用战斗卡片渲染（修真科幻风伤害动画）
    battle: isBattleContent(m.content),
    // 家园建造四步引导：0=不是引导消息，1-4=当前建造进度
    homeGuide: parseHomeBuildGuideStep(m.content),
  };
  msgParseCache.set(m, v);
  return v;
}

const messageViews = computed(() =>
  visibleMessages.value.map((m, i) => {
    const p = cachedParseMsg(m);
    return {
      // 优先用服务端消息 id 作 key；实时推送的系统回包没有 id 时用 内容+序号 兜底
      key: m.id ?? `rt-${i}-${m.createdAt || ''}`,
      msg: m,
      segs: p.segs,
      rich: p.rich,
      battle: p.battle,
      homeGuide: p.homeGuide,
      // 历史消息（非最新 3 条）启用 content-visibility，视口外跳过布局与绘制：
      // 消息上限 300 条 + 背包/战斗大卡片，全量渲染是公屏滑动卡顿主因；
      // 最新 3 条不加，保证自动滚底的 scrollHeight 计算基于真实布局。
      cv: i < visibleMessages.value.length - 3,
    };
  }),
);

/**
 * 判断消息内容是否走富卡片（网格）渲染：背包 / 制造配方清单 / 属性面板三类头部格式
 * 仅为前端展示层判定，不改写任何原始文本（后端与 AstrBot 兼容不受影响）
 */
function isRichCardContent(text) {
  if (!text || typeof text !== 'string') return false;
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '').trim()).filter(Boolean);
  if (!lines.length) return false;
  // 背包：任意一行匹配 "🎒 背包/资源背包 (N种):" 头，且其后存在 "序号." 行
  // 资源背包与背包服务端输出同构，共用富卡片判定（handleResourceBag 约定）
  for (let i = 0; i < lines.length; i++) {
    if (/^🎒\s*(?:资源)?背包\s*\(\d+(?:种)?\)/.test(lines[i])) {
      return lines.slice(i + 1).some((l) => /^\d+\./.test(l));
    }
  }
  // 制造配方清单：任意一行匹配 "X请选择要制造的Y配方:" 头，且其后存在 "序号、" 行
  // （craft-menu.util buildCategoryListText 输出约定；「制造 资源/装备/建筑/载具」共用）
  for (let i = 0; i < lines.length; i++) {
    if (/.+请选择要制造的\S+配方[:：]?$/.test(lines[i])) {
      return lines.slice(i + 1).some((l) => /^\d+、/.test(l));
    }
  }
  // 属性面板：扫描到 "📋 装备" 区块，且消息中含 "【名字】Lv" 标题与属性行 "图标 标签:值"
  if (lines.some((l) => l.includes('📋 装备'))) {
    const hasTitle = lines.some((l) => /^【.+】\s*Lv\.?\d+/i.test(l));
    const hasProp = lines.some((l) => /^❤️|🛡️|⛓️|⚔️|💨|⭐|📍|🔥/.test(l) && /[:：]/.test(l));
    return hasTitle && hasProp;
  }
  return false;
}

/**
 * 识别家园建造引导块并取出进度步数（1-4，非引导消息返回 0）。
 * 后端在「圈地 / 开挖地基 / 建造地基 / 建造房子」回包末尾追加统一格式引导块
 * （见 server/src/modules/game/home-build-guide.util.ts），这里只做展示层识别、不改原文。
 */
function parseHomeBuildGuideStep(text) {
  if (!text || typeof text !== 'string') return 0;
  const matched = text.match(HOME_BUILD_GUIDE_CONFIG.headerRegex);
  if (!matched) return 0;
  const step = Number(matched[1]);
  return step >= 1 && step <= HOME_BUILD_GUIDE_CONFIG.total ? step : 0;
}

/** 系统公告前缀：须与后端 admin.service.sendAnnouncement 写入的前缀一致；弹窗标题已表明是公告，展示前剥离正文里的这一份 */
const ANN_PREFIX = '【系统公告】';

/** 公告一律走弹窗展示、不进公屏消息流（服务端仍持久化留档） */
function isAnnouncementMsg(m) {
  return m.type === 'system' && typeof m.content === 'string' && m.content.startsWith(ANN_PREFIX);
}

/**
 * 公告正文归一化：剥离服务端加的「【系统公告】」前缀。
 * 实时推送（载荷已是原始正文）与历史补弹（整条含前缀）共用，保证两条路径展示一致。
 */
function normalizeAnnContent(content) {
  const text = String(content ?? '');
  if (!text.startsWith(ANN_PREFIX)) return text;
  return text.slice(ANN_PREFIX.length).replace(/^[ \t]*\r?\n?/, '');
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

// 服务器统计（总人数、在线人数、在线玩家名单）
const serverStats = computed(() => connectionStore.stats);
let statsTimer = null;
let socket = null;

// ===== 状态栏「在线」悬浮名单 + 上下线提示 =====
/** 上下线提示（store 统一维护，到期自动移除；保留时长见 PRESENCE_CONFIG） */
const presenceNotices = computed(() => connectionStore.presenceNotices);
const onlinePanelOpen = ref(false);
/** 延迟关闭定时器：让鼠标从数字滑到面板上时不闪断 */
let onlinePanelCloseTimer = null;
/**
 * 未在名单中列出的在线人数。
 * 后端只返回前 N 个在线玩家（N 由后端配置控制），差值用「还有 X 人」补足，
 * 保证玩家知道总在线数远大于展示条数。
 */
const hiddenOnlineCount = computed(() =>
  Math.max(0, Number(serverStats.value.onlinePlayers || 0) - (serverStats.value.onlineList?.length || 0)),
);

/** 展开悬浮名单（顺带取消待执行的关闭，实现"数字 ↔ 面板"之间连续悬停） */
function openOnlinePanel() {
  if (onlinePanelCloseTimer) {
    clearTimeout(onlinePanelCloseTimer);
    onlinePanelCloseTimer = null;
  }
  onlinePanelOpen.value = true;
}

/** 延迟关闭悬浮名单：留出鼠标移动时间，避免玩家一离开数字面板就消失 */
function scheduleCloseOnlinePanel() {
  if (onlinePanelCloseTimer) clearTimeout(onlinePanelCloseTimer);
  onlinePanelCloseTimer = setTimeout(() => {
    onlinePanelOpen.value = false;
    onlinePanelCloseTimer = null;
  }, PRESENCE_CONFIG.hoverCloseDelayMs);
}

const playerInfo = computed(() => playerStore.info);

// ===== 个人设置弹窗（左下角「设置」入口，后续用户设置功能统一收纳于此） =====
const settingsOpen = ref(false);
// 血量预警特效档位选项（写入 ui store，localStorage 持久化）
const HP_VFX_OPTIONS = [
  { value: 'simple', label: '简约', desc: '仅血条闪烁，无屏幕边缘光效，适合挂机' },
  { value: 'standard', label: '标准', desc: '三边分级呼吸光效，日常默认' },
  { value: 'strong', label: '强烈', desc: '光效亮度提升 + 频闪强化，适合高强度战斗' },
];

// 战斗卡片视角名：服务端战斗文本以「玩家面板 name」（含称号后缀）称呼玩家，
// 用于把命中行区分为「我打出 / 打到我身上 / 其他」三种样式；拿不到面板名时回退登录昵称
const viewerName = computed(() => playerInfo.value?.name || user.value?.nickname || user.value?.username || '');
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
  playerStore.setPlayerInfo(data);
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
let nearbyTimer = null;
let atPlayersTimer = null;
// 玩家/地图面板兜底轮询计时器：socket 推送万一丢失时定期校准
let panelTimer = null;
// 全部地图是否折叠（默认折叠，保持面板简洁）
const allMapsCollapsed = ref(true);

// 桌面端左侧栏 Tab 切换（me=个人）；地图信息统一在右侧信息面板，指令入口为 Ctrl+K / 顶栏 ⌨️
const sidebarTab = ref('me');

const showScrollBtn = ref(false);
// 是否「贴底跟随最新消息」（QQ 式滚动行为）：默认跟随，永远看着最新一条。
// 只由用户真实滚动意图解除（滚轮/触摸/拖动滚动条），布局变化一律不算，详见 onMsgScroll
let stickToBottom = true;

// ---------- 我的常用指令：FavoriteCommands 组件回传内容的落地 ----------
// 常用指令的状态、后端读写、分享/导入、拖拽排序都已抽到 components/FavoriteCommands.vue，
// 组件只负责「点了哪一条」，怎么发出去属于本页（要用到 socket / 输入框这些页面级状态）。
// 组件实例引用：桌面侧栏 favRef（挂载时自取列表）
const favRef = ref(null);

/**
 * 统一「发一条文本」的落点：有连接走统一发送入口（本地回显 + 回到底部），
 * 未连接则降级为填入输入框并聚焦（让玩家能看到自己要发什么，而不是点了没反应）。
 * 常用芯片点击与全局总线投递共用这一份，保证两条链路的降级行为一致。
 */
function sendTextOrFill(text) {
  if (socket) {
    sendChatMessage(text);
  } else {
    input.value = text;
    nextTick(() => inputEl.value?.focus());
  }
}

/** 技能栏「世界」键：开/收世界聊天面板（面板状态在 stores/floatingChat，跨路由保留） */
function toggleWorldChat() {
  tapLight();
  floatingChat.setOpen(!floatingChat.open);
}

// 原 onFavoriteClick 非编辑态分支：桌面侧栏芯片、手机拇指区技能栏芯片共用
function onFavoriteSend(text) {
  tapLight(); // 芯片点中的轻触感（iOS 不支持 vibrate 时静默）
  sendTextOrFill(text);
}

// ---------- 手机端拇指区技能栏：常用指令的只读镜像 ----------
// 编辑仍在「我的」面板里的 FavoriteCommands（分享/导入/拖拽排序都在那边），这里只铺前 N 条：
// 横向条一旦长到要翻页，后面的就等于不存在了。
const SKILL_FAV_MAX = 8;
const skillFavorites = ref([]);
// 一条常用都还没有 → 把空位变成「去添加」的入口，而不是留一条空横条
const skillFavsHint = computed(() => skillFavorites.value.length === 0);
async function loadSkillFavorites() {
  try {
    const res = await userApi.getFavorites();
    // 与 FavoriteCommands 同一套解包/归一化：兼容后端可能返回的字符串数组格式
    const list = Array.isArray(res.data) ? res.data : [];
    skillFavorites.value = list
      .slice(0, SKILL_FAV_MAX)
      .map((it) => (typeof it === 'string' ? { cmd: it, label: it } : { cmd: it.cmd, label: it.label || it.cmd }));
  } catch {
    skillFavorites.value = [];
  }
}
// 「我的」面板刚关掉 = 玩家可能在里面改过常用指令 → 重新拉一次（打开时拉会和面板自身加载抢跑）
watch(
  () => ui.meOpen,
  (open, wasOpen) => {
    if (wasOpen && !open) loadSkillFavorites();
  },
);

// ---------- App 级总线：全局 HUD / 底部标签栏 / 「我的」面板借本页收发 ----------
// 注册在 setup 顶层（不是 onMounted）：本页被 App keep-alive 后切走不销毁，
// 整个会话只此一个订阅者；缓存期间从其它页投递的指令也仍由本页的 socket 发出。
// 冷启动直达 /home 时本页还没挂载，bus 会把投递先攒进队列，注册瞬间一次性冲刷回来。
const offBusCommand = subscribeCommands((text) => sendTextOrFill(text));
const offBusAction = onChatAction((name) => {
  // 设置与更新记录弹窗的实现（表单/接口/部署信息拉取）都留在本页，面板只发请求
  if (name === 'settings') settingsOpen.value = true;
  else if (name === 'updatelog') openUpdateLog();
});

/* 再点一次「公屏」标签：像所有信息流 App 那样回到最新消息，而不是没反应 */
onTabRetap('/chat', () => scrollToBottom());

// 自动补全状态
const showAutocomplete = ref(false);
const autocompleteIndex = ref(-1);
// 输入法组合状态与输入框 DOM 实时快照：
// 中文输入法组合期间（正在打拼音）v-model 不会更新（组合文本由浏览器托管），
// 只读 v-model 就做不到「边打拼音边出候选」，因此组合期间改用 DOM 实时值检索。
const inputComposing = ref(false);
const inputRaw = ref('');

/** 记录输入框 DOM 实时内容（组合期间 v-model 尚未更新，检索需要这份快照） */
function syncInputRaw() {
  const el = inputEl.value;
  if (el && typeof el.value === 'string') inputRaw.value = el.value;
}

/** 输入法开始组合（如开始输入拼音）：切到 DOM 实时值检索，边打边出候选 */
function onInputCompositionStart() {
  inputComposing.value = true;
  syncInputRaw();
}

/**
 * 输入法组合结束（拼音已上屏为文字）：切回 v-model 值。
 * 这里不主动刷新下拉：上屏后 v-model 变化会让 filteredCommands 自动重算；
 * 主动刷新反而会在「点击补全项导致组合被打断」时把刚关掉的下拉又弹出来。
 */
function onInputCompositionEnd() {
  inputComposing.value = false;
  syncInputRaw();
}

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

// 用户名/昵称 → 玩家 映射：把消息里的 @用户名（如 qq_<32位openid>）解析成昵称展示
// 依赖 mentionablePlayers（60s 轮询刷新），列表加载/更新后历史消息的高亮名会自动换算成昵称
const mentionableByName = computed(() => {
  const map = new Map();
  for (const p of mentionablePlayers.value) {
    if (p.username) map.set(p.username, p);
    if (p.nickname) map.set(p.nickname, p);
  }
  return map;
});

/**
 * 解析 @提及 的展示名（返回带 @ 前缀的文本）：能匹配到玩家且昵称「@安全」（中英文/数字/下划线，可被后端解析）
 * 时显示 @昵称；否则保持原文（用户名或原昵称），保证右键回填后仍能 @ 到人
 */
function mentionDisplayText(name) {
  const p = mentionableByName.value.get(name);
  const nick = String(p?.nickname || '').trim();
  // 名字规则统一取自配置（与后端 @提及 解析一致）
  if (nick && nick !== name && isSafeMentionName(nick)) {
    return '@' + nick;
  }
  return '@' + name;
}

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

// 旧版 QQ 绑定判定：qqNumber 只接受 5-12 位纯数字真实 QQ 号；
// 存量数据里存的是 QQ 互联 32 位 hex openid，与 AstrBot 机器人传入的 QQ 号匹配不上，
// 命中此判定即视为未绑定，提示玩家换绑为真实 QQ 号。
const isLegacyQqBind = computed(() => {
  const qq = user.value?.qqNumber;
  if (!qq) return false;
  return !/^\d{5,12}$/.test(qq);
});

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

// 绑定引导展开开关
const bindHintOpen = ref(false);
// 未绑定时的 hover 提示：给出完整绑定指令（展开区也显示同样内容，兼容移动端无 hover）
const bindHintTitle = computed(() =>
  user.value?.externalId
    ? `未绑定 QQ：在 QQ 群发送「使魔大战绑定QQ ${user.value.externalId}」`
    : '未绑定 QQ',
);

// 复制提示文本（2 秒后自动清空）
const copyTip = ref('');
let copyTipTimer = null;

function copyOpenId() {
  const id = user.value?.externalId;
  if (!id) return;
  navigator.clipboard.writeText(id)
    .then(() => {
      copyTip.value = '已复制';
      if (copyTipTimer) clearTimeout(copyTipTimer);
      copyTipTimer = setTimeout(() => { copyTip.value = ''; }, 2000);
    })
    .catch(() => {});
}

// 根据输入过滤指令列表，用于自动补全
// 支持中文名、别名、拼音全拼（beibao）、拼音首字母（bb）检索；
// 不纳入描述匹配：描述命中面太广，会让下拉被长尾候选淹没（描述检索留给侧栏搜索/命令面板）
const filteredCommands = computed(() => {
  // 组合期间（正在打拼音）用 DOM 实时值检索，其余时候用 v-model 值
  const text = (inputComposing.value ? inputRaw.value : input.value).trim();
  // 不需要 / 前缀，只要输入非空就展示自动补全
  if (!text) return [];
  return searchCommands(commands.value, text, {
    limit: COMMAND_SEARCH_CONFIG.limits.autocomplete,
    matchDescription: false,
    // 附带命中信息：拼音/别名命中时在候选行上提示，让玩家知道候选为何出现
    withMatch: true,
  });
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

// 消息样式分类：系统消息额外区分「自己的」与「别人的」，用于颜色区分（自己的保持金色高亮，别人的暗淡）
function msgClass(m) {
  if (m.type === 'system') return isOwnSystemMessage(m) ? 'system' : 'system system-other';
  if (m.type === 'command') return 'command';
  if (m.type === 'game') return 'game';
  if (m.type === 'combat') return 'combat';
  if (m.type === 'info') return 'info';
  return 'chat';
}

/**
 * 是否为「自己发出的私密消息」——需要额外打 🔒 标记的那类。
 * 他人看到的私密消息内容本身就是占位文案（占位文案默认自带 🔒 图标），再叠加标记只会重复。
 */
function isPrivateSelfMsg(m) {
  return m?.visibility === 'private' && isOwnSystemMessage(m);
}

/**
 * 消息对齐分类（QQ 聊天风格）
 * - 系统/游戏/战斗/信息类消息 → center（居中，无论是否带 sender）
 * - 普通聊天和玩家指令（chat/command）→ 本人 own（右侧）、他人 other（左侧）
 * 说明：指令触发的公屏结果多为"系统广播"（如"某某移动到某地"），
 * 它们即便带玩家 sender，也应居中展示，与玩家主动发起的对话气泡区分开。
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

// ---------- 消息气泡交互：单击复制原文 / 双击重发 ----------
// 仅对玩家实际发出的消息（chat/command，带发送者）生效，系统/战斗/卡片消息不受影响
let msgClickTimer = null; // 单击延迟派发定时器：等待可能到来的双击，避免单击复制与双击重发同时触发

/** 判断是否为玩家发送的消息气泡（单击/双击交互的作用范围） */
function isUserMsg(m) {
  return !!m.sender && (m.type === 'chat' || m.type === 'command');
}

/** 气泡单击：延迟 260ms 确认不是双击后，复制消息原文到剪贴板 */
function onMsgClick(msg) {
  if (!isUserMsg(msg)) return;
  if (msgClickTimer) return; // 已有待派发的单击，说明这是双击的第一击，交给 dblclick 处理
  msgClickTimer = setTimeout(() => {
    msgClickTimer = null;
    copyMsgContent(msg);
  }, 260);
}

/** 气泡双击：取消待派发的单击，直接把这条消息原样重发一遍 */
function onMsgDblClick(msg) {
  if (!isUserMsg(msg)) return;
  if (msgClickTimer) {
    clearTimeout(msgClickTimer);
    msgClickTimer = null;
  }
  resendMsg(msg);
}

/** 复制消息原文到剪贴板（clipboard API 失败时降级为隐藏文本域 + execCommand） */
function copyMsgContent(msg) {
  const text = (msg.content || '').trim();
  if (!text) return;
  navigator.clipboard.writeText(text)
    .then(() => showToast('消息已复制', 'success'))
    .catch(() => {
      // 降级方案：非安全上下文（http）下 clipboard API 不可用
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showToast('消息已复制', 'success');
      } catch {
        showToast('复制失败', 'error');
      }
      document.body.removeChild(ta);
    });
}

/**
 * 重发消息：走统一发送入口 sendChatMessage（受发言频率限制约束），
 * socket 未连接时降级为填入输入框
 */
function resendMsg(msg) {
  const text = (msg.content || '').trim();
  if (!text) return;
  if (socket) {
    sendChatMessage(text);
  } else {
    input.value = text;
    nextTick(() => inputEl.value?.focus());
  }
}

/** 把游戏文本里的 "#换行" 标记（原版 #换行符）转成真实换行；存量消息里仍有字面 "#换行" */
function normalizeLineBreaks(text) {
  if (typeof text !== 'string' || !text.includes('#换行')) return text;
  return text.split('#换行').join('\n');
}

/**
 * 解析消息内容，将可点击的指令名转换为可交互片段
 * 匹配优先级：1. 「指令名 参数」中文书名号；2. 「💡 输入/使用/发送 指令名 说明文字」后端提示格式
 * 模式 2 必须取动词后的第一个独立词作为指令名（取后一个词会把说明文字当成指令名），
 * 且两种模式都要能在已知指令名/别名里命中，否则按普通文本渲染，避免点到无效内容报错。
 * @param cmdList 已加载的指令列表，用于校验提取出的指令名是否有效
 * @returns 片段数组，每项 { type: 'text'|'command'|'mention', text, displayText?, source? }
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

  // 无任何匹配时原样返回
  if (segments.length === 0) {
    return [{ type: 'text', text: content }];
  }

  // 处理文本片段中的 @提及 高亮（在已有 segment 基础上拆解 text 片段）
  // 解析规则（字符集与长度上限）统一取自配置，与后端 parseMentions 保持一致
  const mentionRegex = mentionParseRegex();
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
        // @提及：text 保留原文（用于右键回填兜底），displayText 优先显示昵称
        finalSegments.push({ type: 'mention', text: m[0], displayText: mentionDisplayText(m[1]) });
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
 * 快速发送指令：无参数指令（argsSchema 为空）直接发送，需要参数的填入输入框待补充
 */
function quickSend(name) {
  if (!name) return;
  const cmd = commands.value.find(c => c.name === name);
  // argsSchema 为空数组 "[]" 或不存在时，视为无参数指令，直接发送
  const needParams = cmd && cmd.argsSchema && cmd.argsSchema !== '[]';
  if (!needParams) {
    // 无参数指令 → 直接发送（走统一入口：本地回显 + 回到底部）
    if (socket) {
      sendChatMessage(name);
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

// 快捷操作按钮 — 直接发送对应指令（走统一入口：本地回显 + 回到底部）
function quickAction(action) {
  if (!socket) return;
  tapMedium(); // 拇指区技能栏的「出手」确认感
  sendChatMessage(action);
}

/**
 * 右键资源行 = 超管批量采集（以剩余最大次数发送）。
 * 仅管理员可达（模板侧已用 isAdmin 短路）；times=-1（无限）时取大数，
 * 后端有限资源夹到剩余次数、超管野外批量放开上限。
 */
function quickGatherMax(r) {
  if (!socket || !isAdmin.value) return;
  const base = r.gatherCmd || '采集 ' + r.name;
  const max = r.times > 0 ? Math.floor(r.times) : 999;
  quickAction(base + max);
}

// 命令面板（Cmd/Ctrl+K）选中回调：复用 quickSend 的「无参直发 / 有参填入」逻辑
function onPaletteSelect(name) {
  if (!name) return;
  quickSend(name);
  ui.pushToast({ type: 'info', message: `已发送指令：${name}` });
}

/**
 * 右键点击提示指令：将指令内容填入输入框（不发送），便于先查看/补充参数再手动发送
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
 */
function atMentionName(p) {
  if (!p) return '';
  const nick = String(p.nickname || '').trim();
  if (nick && isSafeMentionName(nick)) return nick;
  return p.username || '';
}

/**
 * 右键点击消息中的玩家名：把 "@昵称 " 填入输入框（@提及该玩家）
 * 后端 @ 匹配支持按昵称精确解析，优先填入 "@昵称 " 更直观（昵称不可用时退回用户名）
 */
function quickAtUser(sender) {
  if (!sender) return;
  const name = atMentionName(sender);
  if (!name) return;
  input.value = '@' + name + ' ';
  closeAtAutocomplete();
  nextTick(() => {
    inputEl.value?.focus();
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
  // 同步 DOM 实时内容（输入法组合期间每次变化都会触发，是拼音候选的刷新时机）
  syncInputRaw();
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

// 输入框键盘事件（keyup）：仅在非 @ 模式下控制指令自动补全
function onInputKeyup() {
  // 同步 DOM 实时内容，保证检索文本最新（输入法组合期间 v-model 落后于 DOM）
  syncInputRaw();
  // @ 模式下隐藏指令补全，避免两者下拉冲突
  if (showAtAutocomplete.value || detectAtMode()) {
    showAutocomplete.value = false;
    return;
  }
  if (filteredCommands.value.length && input.value.trim()) {
    showAutocomplete.value = true;
    if (autocompleteIndex.value >= filteredCommands.value.length) {
      autocompleteIndex.value = 0;
    }
  } else {
    showAutocomplete.value = false;
  }
}

function onInputKeydown(e) {
  // 输入法组合中（正在选拼音候选）：回车/Tab 归输入法选词，不能被补全逻辑拦截
  if (e.isComposing) return;
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

// ---------- 发送统一入口：emit + 本地回显 + 回到底部 ----------
// 本地回显：消息不等服务器广播回来，发送后立即上屏，消除"发出去的文字过好久才显示"的体感卡顿。
// 多行输入按行拆分暂存，与后端"逐行处理、逐行广播"的行为一一对应；
// 服务器广播到达后由 appendMessage 按「发送者=自己」去重替换为带 id 的正式消息。

/** 富文本卡片（RichSystemCard）回传来的一条指令（如背包格子点击→「穿上 XX」），纳入常规发送流程 */
function onRichCardSend(content) {
  sendChatMessage(content);
}

/** 家园建造引导卡片：点击「下一步」按钮 → 走统一指令通道发送（与 QQ 端逐字一致） */
function onHomeGuideSend(cmd) {
  sendChatMessage(cmd);
}

/** 家园建造引导：跳转家园院子页面（/home），后续清理地面/开挖/建造都在该页操作 */
function goHomeYard() {
  router.push('/home');
}

/**
 * 圈地成功后自动把玩家送到家园页（可配置关闭）。
 * 只对自己触发的回包、且仅配置的那一步生效，每条消息只处理一次，避免刷屏反复跳。
 */
const autoRedirectedGuideKeys = new Set();
watch(messageViews, (views) => {
  const cfgRedirect = HOME_BUILD_GUIDE_CONFIG.autoRedirect;
  if (!cfgRedirect?.enabled) return;
  for (let i = views.length - 1; i >= 0 && i >= views.length - 3; i -= 1) {
    const v = views[i];
    if (!v?.homeGuide || v.homeGuide !== cfgRedirect.step) continue;
    if (!isOwnSystemMessage(v.msg)) continue;
    const key = v.key;
    if (autoRedirectedGuideKeys.has(key)) continue;
    autoRedirectedGuideKeys.add(key);
    setTimeout(goHomeYard, Math.max(0, Number(cfgRedirect.delayMs) || 0));
    break;
  }
});

/**
 * 统一发送入口（中央输入框 / 悬浮窗 / 侧栏按钮共用）。
 * @param {string} content 消息文本
 * @param {'main'|'floating'} source 发送来源：
 *  - 'main'（默认）：中央游戏区入口，指令优先——后端判定为指令则执行并显示在中央公屏；
 *  - 'floating'：右下角世界聊天悬浮窗，定位纯聊天频道——后端不做指令判定，
 *    一律当聊天广播回悬浮窗，"在哪个窗口发就归哪个窗口"。
 */
function sendChatMessage(content, source = 'main') {
  const text = (content || '').trim();
  if (!text || !socket) return false;
  // 前端软节流：过快时直接提示，不发 socket、不本地回显（避免“看起来发出去了”）
  const intervalSec = Number(chatRateLimitSec.value);
  if (Number.isFinite(intervalSec) && intervalSec > 0) {
    const now = Date.now();
    const remainingMs = lastChatSendAt + intervalSec * 1000 - now;
    if (remainingMs > 0) {
      const waitSec = Math.max(0.1, Math.ceil(remainingMs / 100) / 10);
      showToast(`消息发送过于频繁，请 ${waitSec} 秒后再发`, 'error');
      return false;
    }
    lastChatSendAt = now;
  }
  // source 随消息上送：后端据此决定"悬浮窗=纯聊天 / 主输入框=指令判定"（见 chat.gateway）
  socket.emit('chat:message', { content: text, source });
  const self = user.value || {};
  const sender = { id: self.id, username: self.username, nickname: self.nickname };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (const line of lines) {
    // 悬浮窗消息本地回显一律进悬浮窗；主输入框消息按内容预估样式（指令金色/聊天白色），
    // 预估不准时由服务端广播纠偏（appendMessage 双向去重），最终只显示在一处。
    const type = source === 'floating' ? 'chat' : guessMessageType(line);
    if (type === 'chat') {
      // 纯聊天本地回显 → 悬浮窗
      floatingChat.append(floatingChat.makePending(line, self));
    } else {
      appendMessage({
        type,
        content: line,
        sender,
        createdAt: new Date().toISOString(),
        _pending: true, // 本地暂存标记：服务器广播到达后被替换
      });
    }
  }
  // 发送后强制回到底部，确保刚发出的消息立即可见（即使用户之前向上翻阅过历史）
  scrollToBottom();
  return true;
}

// 本地回显的消息类型预估：命中前缀或已知指令名/别名 → command，否则 chat。
// 只影响上屏瞬间的样式（指令金色/聊天白色），服务器正式消息到达后会整体替换为准确类型。
function guessMessageType(text) {
  const t = (text || '').trim();
  if (/^[\/！!]/.test(t)) return 'command';
  // 纯数字编号菜单（如 1/2/3）走主窗指令路径：后端会做临时输入替换；
  // 若当聊天本地回显会进悬浮窗，用户主屏看起来像“发了没反应”。
  if (/^\d+$/.test(t)) return 'command';
  const name = t.replace(/^[\/！!]+/, '').split(/\s+/)[0] || '';
  if (!name) return 'chat';
  return commands.value.some(
    (c) => c.name === name || (c.alias || '').split(',').map((s) => s.trim()).includes(name)
  ) ? 'command' : 'chat';
}

async function sendMessage() {
  // @ 模式下按回车优先选中玩家，而不是直接发送消息
  if (showAtAutocomplete.value && filteredAtPlayers.value.length) {
    selectAtPlayer(filteredAtPlayers.value[atAutocompleteIndex.value >= 0 ? atAutocompleteIndex.value : 0]);
    return;
  }
  const content = input.value.trim();
  if (!content || !socket) return;
  // 通过 WebSocket 发送(后端自动判断聊天或指令)，同时本地回显立即上屏。
  // 限流/未连接时 sendChatMessage 返回 false：保留输入框内容，避免“发出去了但屏幕没反应”。
  const ok = sendChatMessage(content);
  if (!ok) return;
  tapMedium(); // 发送成功才震（被限流/未连接时不震，手感与结果一致）
  input.value = '';
  showAutocomplete.value = false;
  closeAtAutocomplete();
  autoResizeInput();
}

/**
 * 是否应路由到右下角悬浮世界聊天窗（而非中央游戏流）。
 * chat = 玩家世界聊天；redpacket = 世界红包卡片（refId 关联红包）
 */
function isFloatingChatMsg(m) {
  if (!m?.type) return false;
  return m.type === 'chat' || m.type === 'redpacket' || m.type === 'redpacket_claim';
}

function appendMessage(msg) {
  if (!msg) return;
  // 兜底：socket 实时消息若缺少时间戳，则补当前时间，保证每条消息都能显示精确到秒的时间
  if (!msg.createdAt) msg.createdAt = new Date().toISOString();
  // 里程碑动画：先于下方去重替换逻辑执行，无论消息是新增还是替换本地回显都能触发
  highlightFromMessage(msg);
  // 世界聊天 → 右下角悬浮窗（与中央游戏流分离，避免聊天刷屏游戏区）
  // 未来红包/道具消息 type 同样进悬浮窗
  if (isFloatingChatMsg(msg)) {
    floatingChat.append(msg);
    // 服务端判定为聊天的纠偏：若本地预判为指令而在中央公屏留了 pending 回显，
    // 需将其移除，避免同一条消息在中央公屏与悬浮窗各显示一份。
    // 只认自己 30 秒内的 pending：先按内容精确匹配，再 FIFO 兜底。
    if (msg.type === 'chat' && msg.sender?.id != null && msg.sender.id === user.value?.id) {
      const now = Date.now();
      const freshSelf = (m) =>
        m._pending && m.sender?.id === user.value?.id &&
        now - new Date(m.createdAt).getTime() < 30000;
      let idx = messages.value.findIndex((m) => freshSelf(m) && m.content === msg.content);
      if (idx < 0) idx = messages.value.findIndex(freshSelf);
      if (idx >= 0) messages.value.splice(idx, 1);
    }
    return;
  }
  // 本地回显去重：自己发出的指令广播到达时，用服务端正式消息（带 id/准确类型/时间）
  // 替换发送瞬间暂存的那条本地回显，避免同一条消息显示两遍。
  // 优先按内容精确匹配；找不到再按先后顺序配对——后端会做快捷输入替换（如发"1"被替换成
  // "选择使魔XX"）导致广播内容与原输入不同，此时按 FIFO 配对才不会漏。
  // 只认 30 秒内的暂存，避免陈旧未确认消息被后来者误替换。
  if (msg.sender?.id != null && msg.sender.id === user.value?.id && msg.type === 'command') {
    const now = Date.now();
    const fresh = (m) => m._pending && now - new Date(m.createdAt).getTime() < 30000;
    let idx = messages.value.findIndex((m) => fresh(m) && m.content === msg.content);
    if (idx < 0) {
      idx = messages.value.findIndex(fresh);
    }
    if (idx >= 0) {
      messages.value.splice(idx, 1, msg);
      if (stickToBottom) scrollToBottom();
      return;
    }
    // 中央公屏没有对应 pending：说明本地预判为聊天、回显进了悬浮窗，
    // 但服务端判定为指令。移除悬浮窗里的 pending，避免同一条消息两边各显示一份。
    floatingChat.removePendingLike(msg);
  }
  messages.value.push(msg);
  // 限制本地消息数量，防止内存增长
  if (messages.value.length > 300) {
    messages.value.splice(0, messages.value.length - 300);
  }
  // 用户没有手动翻历史时，自动滚动到底部（贴底跟随）
  if (stickToBottom) {
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

// ===== 贴底跟随（QQ 式滚动）：默认永远看着最新一条 =====
// 背景：历史消息带 content-visibility:auto（高度按 contain-intrinsic-size 估算），
// 图片/战斗卡/字体又常在消息上屏后若干帧才完成布局 → scrollHeight「迟到增长」，
// 单次 scrollTop=scrollHeight 会停在中间；更糟的是，这类布局变化引发的 scroll 事件
// 会被误判成「用户向上翻历史」，于是永久停止自动贴底（按钮出现、别人再发言也不跟了）。
// 对策：
//   ① 只有「用户真实滚动意图」（滚轮/触摸/拖拽滚动条）才解除贴底，布局变化一律不算；
//   ② 贴底状态由一个低频守护定时器维持：只在外界内容（scrollHeight）变长时才补滚一次，
//      用户一旦接管立即停手 —— 与微信/QQ「始终停在最新消息」的行为一致。
const SCROLL_BOTTOM_THRESHOLD = 40; // 贴底容差（像素）：过大会让用户刚上滑几十像素就被判定仍在底部并立即贴回
const USER_SCROLL_INTENT_MS = 300; // 用户滚动意图有效期：窗口内的滚动动作才算「用户在滚」
let userScrollIntentAt = 0; // 最近一次用户滚动意图时间戳
let bottomFollowTimer = 0; // 贴底守护定时器句柄（0 = 未运行）
let lastFollowScrollHeight = 0; // 贴底守护已补滚到的高度基准（内容未变就不抢）

/** 登记用户滚动意图（模板 @pointerdown 等调用）：只有用户亲手滚才允许解除贴底 */
function markUserScrollIntent() {
  userScrollIntentAt = performance.now();
}

/** 立即解除贴底（用户主动向上翻历史时调用）。
 *  不等 scroll 事件：手机端合成器滚动的 scroll 事件会延迟数帧，期间贴底循环会把位置抢回底部；
 *  列表本来就不能滚动时不解除（否则会弹出一个点了也没用的「回到底部」按钮）。 */
function releaseBottomStick() {
  if (!isMessageListScrollable()) return;
  userScrollIntentAt = performance.now();
  stickToBottom = false;
  showScrollBtn.value = true;
  stopBottomFollow();
}

/** 滚轮：向上滚（deltaY<0）= 查看历史 → 立即解除贴底；向下滚仍保持跟随（滑到底看最新） */
function onWheelIntent(e) {
  markUserScrollIntent();
  if (e.deltaY < 0) releaseBottomStick();
}

let touchStartY = 0; // 触摸起点 y：与 touchmove 比较即可判断手指方向
/** 触摸开始：登记起点与意图 */
function onTouchStartIntent(e) {
  touchStartY = e.touches[0]?.clientY ?? 0;
  markUserScrollIntent();
}
/** 触摸移动：手指向下拖 = 内容上翻（查看历史）→ 立即解除贴底 */
function onTouchMoveIntent(e) {
  markUserScrollIntent();
  if ((e.touches[0]?.clientY ?? 0) - touchStartY > 8) releaseBottomStick();
}

/** 停止贴底跟随（用户接管阅读历史或组件卸载时调用） */
function stopBottomFollow() {
  if (bottomFollowTimer) {
    clearInterval(bottomFollowTimer);
    bottomFollowTimer = 0;
  }
}

/**
 * 启动低频贴底守护：stickToBottom 为真时每 120ms 采样一次 scrollHeight，
 * 只有内容真的变长（新消息/图片/卡片迟到布局）才补滚回底部。
 * 判据必须是「scrollHeight 是否变长」而不是「离底距离」：用户上滑翻历史时 scrollHeight 不变，
 * 守护就永不抢滚动条（否则每帧无条件对比离底距离会把人一直拽回底部，且读 scrollHeight 强制 layout 掉帧）。
 */
function startBottomFollow() {
  if (bottomFollowTimer || !stickToBottom) return;
  lastFollowScrollHeight = msgList.value?.scrollHeight ?? 0;
  bottomFollowTimer = setInterval(() => {
    const el = msgList.value;
    if (!el || !stickToBottom) return; // 用户接管 / 已卸载 → 停手
    const h = el.scrollHeight;
    if (h <= lastFollowScrollHeight) return; // 内容没变（用户上滑/静止）→ 绝不抢滚动条
    lastFollowScrollHeight = h;
    // 用户刚上手（滚轮/触摸/拖动滚动条）的短时间内延迟补滚，避免"手指一放就弹到底"
    if (performance.now() - userScrollIntentAt < USER_SCROLL_INTENT_MS) return;
    el.scrollTop = el.scrollHeight;
  }, 120);
}

function scrollToBottom() {
  showScrollBtn.value = false;
  stickToBottom = true;
  nextTick(() => {
    if (msgList.value) {
      msgList.value.scrollTop = msgList.value.scrollHeight;
    }
    startBottomFollow(); // 复杂度由贴底守护接管（图片/卡片迟到布局也能跟上）
  });
}

// ===== 首次加载/刷新贴底 =====
// 字体加载、战斗卡/公告配图渲染、--vh 重算都会让 scrollHeight 迟到增长，
// 单次滚底会停在"中间"；内容高度再变化就继续滚到底，直到用户主动滚动接管（stickToBottom=false）。
let pinBottomResizeObs = null;
function pinBottomOnLoad() {
  scrollToBottom();
  // 字体加载完成后文本行高会变，显式再贴一次底（不支持 fonts API 时静默跳过）
  document.fonts?.ready
    ?.then(() => {
      if (stickToBottom) scrollToBottom();
    })
    .catch(() => {});
}

// 消息滚动监听：维护「贴底跟随」状态（是否继续跟着最新消息）
// 关键：图片/卡片迟到布局、content-visibility 高度估算切换、滚动锚定补偿……
// 这些非用户行为同样会触发 scroll 事件，此时 scrollHeight 与上次不同；
// 不能把它们当成「用户向上翻历史」，否则就会重演"聊着聊着滚动条自己停在中间"的问题。
let lastMsgScrollTop = 0;
let lastSeenScrollHeight = 0;
function onMsgScroll() {
  if (!msgList.value) return;
  const el = msgList.value;
  const h = el.scrollHeight;
  // scrollHeight 变了 → 这次 scroll 事件多半来自布局变化/程序化滚动，而非用户滚动
  const heightChanged = h !== lastSeenScrollHeight;
  lastSeenScrollHeight = h;
  const isNearBottom = h - el.scrollTop - el.clientHeight < SCROLL_BOTTOM_THRESHOLD;
  if (!isNearBottom) {
    // 只有两种情况解除贴底：① 用户刚有滚动动作（滚轮/触摸/拖拽滚动条）；
    // ② 高度没变却离底（说明是用户自己滚上去的，而不是内容长高把我们顶上去的）
    const userIntent = performance.now() - userScrollIntentAt < USER_SCROLL_INTENT_MS;
    if (stickToBottom && (userIntent || !heightChanged)) {
      stickToBottom = false;
      showScrollBtn.value = true;
      stopBottomFollow(); // 用户接管：立刻停掉贴底循环，绝不抢滚动条
    }
  } else {
    // 回到（接近）底部：恢复贴底跟随，按钮隐藏；用户手动滚回底部同样会恢复。
    // 但若用户此刻正在向上翻历史（意图窗口内且实际位置离底），不能急着贴回——
    // 否则会出现"往上滑一点点又弹回最下面"的抢滚动条体验。
    const userScrollingUp = performance.now() - userScrollIntentAt < USER_SCROLL_INTENT_MS && el.scrollTop > 0;
    if (!userScrollingUp) {
      stickToBottom = true;
      showScrollBtn.value = false;
      startBottomFollow();
    }
  }
  // 仅向上翻历史时短暂显示操作坞；向下滚/贴底不出现
  const delta = el.scrollTop - lastMsgScrollTop;
  lastMsgScrollTop = el.scrollTop;
  if (delta < -2 && !isNearBottom) {
    revealDock();
  } else if (delta > 2 || isNearBottom) {
    hideDockNow();
  }
}

/** 顶部操作坞（桌面端顶栏那排入口）：滚动/悬停时短暂显示，几秒后自动隐藏 */
const DOCK_HIDE_MS = 3000;
const dockHidden = ref(false);
let dockHideTimer = null;

function clearDockHideTimer() {
  if (dockHideTimer) {
    clearTimeout(dockHideTimer);
    dockHideTimer = null;
  }
}

function scheduleDockHide() {
  clearDockHideTimer();
  dockHideTimer = setTimeout(() => {
    dockHideTimer = null;
    dockHidden.value = true;
  }, DOCK_HIDE_MS);
}

function revealDock() {
  clearDockHideTimer();
  dockHidden.value = false;
  scheduleDockHide();
}

/** 立即隐藏操作坞（向下滚动时） */
function hideDockNow() {
  clearDockHideTimer();
  dockHidden.value = true;
}

// 消息列表是否真的能滚动：不可滚动时不弹「回到底部」按钮（点了也没用的按钮不该占位）
function isMessageListScrollable() {
  const el = msgList.value;
  return !!el && el.scrollHeight - el.clientHeight > 8;
}

function logout() {
  socket?.disconnect();
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  router.push('/login');
}

// 清除自己的游戏数据（与管理员GM清除同一后端实现，账号保留、进度重置为未开始游玩）
async function resetMyData() {
  const ok = confirm(
    '确定要清除自己的游戏数据吗？\n' +
    '等级、背包、装备、任务等进度将全部重置，账号保留，可重新开局。\n此操作不可恢复！',
  );
  if (!ok) return;
  try {
    const res = await gameApi.resetMyData();
    alert(res.message || '已清空游戏数据，请重新登录开始新开局');
    logout();
  } catch (e) {
    alert('清除失败：' + (e.response?.data?.message || e.message));
  }
}

// 加载玩家信息（地图总览见 loadMapOverview）
async function loadPlayerInfo() {
  try {
    const res = await gameApi.playerInfo();
    playerStore.setPlayerInfo(res.data);
  } catch {
    // 玩家信息接口可能不存在，静默忽略
  }
}

/**
 * 开局预检：未选择使魔（player.type 为空）的玩家不允许停留在主界面，
 * 直接重定向到全屏「使魔契约引导页」，选完再由引导页送回。
 *
 * 判据与服务端指令门禁完全一致（player.type 空 = 原版「老玩家==假」= 未开局），
 * 因此本页只做跳转、不做任何写入，避免出现第二条换使魔通道。
 * @returns {Promise<boolean>} true = 已发起跳转，调用方须立即中止后续初始化
 */
async function redirectIfNotOnboarded() {
  try {
    const res = await gameApi.playerInfo();
    playerStore.setPlayerInfo(res.data);
    if (!res.data?.type) {
      router.replace('/onboard');
      return true;
    }
  } catch {
    // 接口异常时不阻断进主界面（后续 30s 兜底轮询会再校准），避免弱网被锁在引导页
  }
  return false;
}

async function loadMapOverview() {
  try {
    const res = await gameApi.mapOverview();
    mapOverview.value = res.data;
  } catch {
    // 地图总览接口可能不存在，静默忽略
  }
}

// 进行中操作（采集/移动/抢救…）快照，来自玩家状态面板的同一份数据
const pendingActions = computed(() => playerInfo.value?.pendingActions || []);

/**
 * 倒计时归零回调：延时指令已到点，主动拉一次玩家状态与地图，
 * 把已结算的条目清掉并同步结算产出（后端定时器抖动或兜底扫描时尤其需要）。
 */
let pendingRefreshAt = 0;
async function onPendingExpired() {
  const nowMs = Date.now();
  if (nowMs - pendingRefreshAt < 1500) return; // 多条同时到期时合并刷新
  pendingRefreshAt = nowMs;
  await Promise.all([loadPlayerInfo(), loadMapOverview()]);
}

// 超管点击读条上的「⚡完成」：走 REST 静默通道（指令与结果都不进聊天流，别人不可见）。
// 注意 http 拦截器已解包 body：res = { success, message, completed }，直接取 message。
// 结果用 Toast 如实提示（成功/无任务/权限不足），成功后刷新读条快照让条目消失。
async function onPendingComplete() {
  let ok = false;
  try {
    const res = await gameApi.finishNow();
    ok = !!res?.success;
    showToast(res?.message || (ok ? '已触发立即完成' : '操作失败'), ok ? 'success' : 'error');
  } catch (e) {
    showToast(e?.response?.data?.message || e?.message || '立即完成失败', 'error');
  }
  if (ok) await loadPlayerInfo();
}

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

/**
 * 悬浮世界聊天窗的轻提示回调（抢红包结果 / 红包发出 / 背包读取失败等）
 * 统一转成页面 Toast，保证提示样式与其它功能一致。
 */
function onFloatingNotify(payload) {
  if (payload?.message) showToast(payload.message, payload.type || 'info');
}

async function loadServerStats() {
  try {
    const res = await gameApi.stats();
    connectionStore.setStats(res.data);
  } catch {
    // 统计接口可能暂不可用，静默忽略
  }
}

let setViewportHeight = null;

// ===== 全局 Toast 轻提示 =====
const toasts = ref([]);
let toastId = 0;
/** 软节流：上次成功发出消息的时间戳（ms） */
let lastChatSendAt = 0;
/** 发送间隔（秒），由后端配置下发；缺失时按 0.2 兜底 */
const chatRateLimitSec = ref(0.2);
/**
 * 显示一条轻提示（3 秒后自动消失）
 * @param type info / error / success
 */
function showToast(message, type = 'info') {
  const id = ++toastId;
  toasts.value.push({ id, message, type });
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 3000);
}

// ===== 高光时刻动画（任务达成 / 领取新任务 / 获得称号 / 等级提升）=====
// 组件实例：由 GameHighlight.vue 暴露 push 方法
const highlightRef = ref(null);

/**
 * 播放一条高光动画
 *
 * 带 3 秒去重窗口：结构化事件（后端埋点）与文本兜底解析会命中同一次结算，
 * 不去重就会连着弹两遍一模一样的动画。
 * @param {object} payload { type, title?, detail?, names?, rewards? }
 */
const highlightSeen = new Map();
function pushHighlight(payload) {
  if (!payload?.type) return;
  const now = Date.now();
  // 顺带清理过期条目，避免 Map 无限增长
  for (const [k, t] of highlightSeen) {
    if (now - t > 3000) highlightSeen.delete(k);
  }
  const sig = `${payload.type}|${(payload.names || []).join('、')}|${payload.detail || ''}`;
  const last = highlightSeen.get(sig);
  if (last && now - last < 3000) return;
  highlightSeen.set(sig, now);
  highlightRef.value?.push?.(payload);
}

/**
 * 文本兜底：解析公屏文本里的里程碑并播放动画
 *
 * 后端已用结构化事件 game:highlight 覆盖主链路，这里解析文本是为了兜住
 * 尚未埋点的历史路径（以及 AstrBot 等其它渠道回传的内容）。
 * 关键约束：只认归属自己的消息——别人完成任务时公屏也会广播同款文本，
 * 绝不能给别人放动画。
 */
function highlightFromMessage(msg) {
  if (!msg || typeof msg.content !== 'string') return;
  // 只处理系统类回执；玩家聊天/指令原文不参与解析
  if (msg.type !== 'system' && msg.type !== 'game' && msg.type !== 'info') return;
  if (!isOwnSystemMessage(msg)) return;
  for (const item of parseHighlights(msg.content)) {
    pushHighlight(item);
  }
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

/**
 * 点击附近玩家：把 "@昵称 " 填入输入框（快速 @ 提及，后端按昵称精确解析）
 * @param p 附近玩家对象（含 userId / nickname / username / online）
 */
function atNearbyPlayer(p) {
  if (!p) return;
  quickAtUser({ id: p.userId, username: p.username, nickname: p.nickname });
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

function closeFeedbackPanel() {
  feedbackPanelOpen.value = false;
}

/**
 * 加载"我的反馈工单"列表，并按各工单 unreadCount 汇总头部未读红点
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

function startNewFeedback() {
  feedbackView.value = 'create';
}

/** 新建反馈附件选择：调用上传接口得到可访问 URL 列表 */
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
 * 处理从剪贴板粘贴的图片：自动上传并加入附件列表（用户直接 Ctrl+V 粘贴截图，无需选文件）
 * @param urlsRef 目标附件 URL 列表 ref（fbUploadedUrls / replyUploadedUrls）
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

/** 回复附件选择：调用上传接口得到可访问 URL 列表 */
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

/** 在当前工单下追加回复 */
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

/** 解析消息中的附件字段（数据库中以 JSON 字符串存储），返回附件 URL 数组 */
function fmAttachments(msg) {
  if (!msg || !msg.attachments) return [];
  try {
    const arr = typeof msg.attachments === 'string' ? JSON.parse(msg.attachments) : msg.attachments;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 取附件 URL 的文件名（供展示） */
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
  // 正文剥离「【系统公告】」前缀：弹窗标题已表明这是公告，正文重复一次是冗余
  annQueue.value.push({ id, content: normalizeAnnContent(a.content), createdAt: a.createdAt });
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
function openAnnImagePreview(img) {
  annImagePreview.value = { src: img.src, alt: img.alt || '' };
}
function closeAnnImagePreview() {
  annImagePreview.value = null;
}

onMounted(async () => {
  // 未选使魔的新玩家：先进全屏契约引导页，选定使魔后再回到主界面。
  // 必须放在最前面——否则主界面会先渲染一帧，且公屏历史/面板数据对新玩家都是无意义的。
  if (await redirectIfNotOnboarded()) return;

  // 放行主界面渲染，并等 v-show 生效后再进入测高/滚动等依赖真实布局的初始化
  bootReady.value = true;
  await nextTick();

  // 拇指区技能栏的常用指令镜像：与桌面侧栏面板各拉一份（编辑入口仍在「我的」面板）
  loadSkillFavorites();

  // 消息区容器高度变化（键盘弹出、--vh 重算）时保持贴底：
  // 仅在 stickToBottom 仍为真时补滚，用户已接管就绝不抢滚动条
  if (msgList.value && 'ResizeObserver' in window) {
    pinBottomResizeObs = new ResizeObserver(() => {
      if (stickToBottom && msgList.value) {
        msgList.value.scrollTop = msgList.value.scrollHeight;
      }
    });
    pinBottomResizeObs.observe(msgList.value);
  }

  try {
    // 时钟对齐：倒计时进度条/增益剩余时间都拿服务器时刻与本机时钟相减，
    // 先测一次偏移量（失败静默，倒计时退化为本机时钟）；socket 重连时会再测
    syncServerClock();
    // 消息发送间隔：后端配置下发（防刷屏软节流）；失败保持默认 0.2s
    try {
      const webCfg = await systemApi.getWebConfig();
      const sec = Number(webCfg?.data?.messageIntervalSec);
      if (Number.isFinite(sec) && sec >= 0) chatRateLimitSec.value = sec;
    } catch { /* 静默，用默认值 */ }
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
    // 历史按类型分流：世界聊天进悬浮窗，指令/系统/战斗等留在中央游戏流
    const historyAll = (msgs.data || []).reverse();
    const historyChat = [];
    const historyGame = [];
    for (const m of historyAll) {
      if (isFloatingChatMsg(m)) historyChat.push(m);
      else historyGame.push(m);
    }
    floatingChat.setMessages(historyChat);
    // 历史里的红包卡片需要实时状态（已领 x/y、是否过期/抢完）：按 refId 批量拉取后写入 store
    const redPacketIds = historyChat
      .filter((m) => m.type === 'redpacket' && Number.isFinite(m.refId))
      .map((m) => m.refId);
    if (redPacketIds.length) {
      chatApi
        .getRedPackets(redPacketIds)
        .then((res) => floatingChat.setRedPackets(res.data || []))
        .catch(() => {
          // 红包状态拉取失败不影响聊天展示（卡片会退化为基础展示）
        });
    }
    messages.value = historyGame;
    // 扫描历史中的未读系统公告 → 弹窗补展示（离线期间错过的公告上线后仍会弹出）
    scanHistoryAnnouncements(historyGame);
    await commandStore.loadCommands();
    // 常用指令列表由 FavoriteCommands 组件自己读写，这里在指令全量列表就绪后再刷新一次面板
    await favRef.value?.loadFavorites();
    await Promise.allSettled([
      loadPlayerInfo(),
      loadMapOverview(),
      loadNearbyPlayers(),
      loadMentionablePlayers(),
      // 反馈列表（含 unreadCount）确保头部红点正确显示
      loadFeedbackTickets(),
    ]);
    loadServerStats();
    // 查询开发登录开关：开启时非管理员账号也显示管理后台入口（仅开发环境生效）
    loadDevLoginStatus();
    statsTimer = setInterval(loadServerStats, 30000);
    // 玩家/地图面板兜底轮询：socket 推送万一丢失（断线瞬间/服务重启）也能在 30 秒内自动校准
    panelTimer = setInterval(() => {
      if (!document.hidden) {
        loadPlayerInfo();
        loadMapOverview();
      }
    }, 30000);
    // 附近玩家/可@列表定期刷新：感知其他玩家进出区域与上下线，@ 列表间隔由配置控制
    nearbyTimer = setInterval(loadNearbyPlayers, 30000);
    atPlayersTimer = setInterval(loadMentionablePlayers, MENTION_CONFIG.playersRefreshMs);

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
      connectionStore.setConnected(true);
      // 重连后重测时钟偏移：会话期间本机时钟可能被系统 NTP 校准过
      syncServerClock();
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
      connectionStore.setConnected(false);
    });
    // 接收公屏消息(聊天、指令结果广播、系统消息)
    socket.on('chat:message', (msg) => {
      appendMessage(msg);
    });
    // 接收高光时刻事件（任务达成/领取新任务/获得称号/等级提升）
    // 后端按 user:{id} 房间定向推送，只可能是自己的，无需再做归属判断
    socket.on(GAME_HIGHLIGHT_EVENT, (data) => {
      pushHighlight(data);
    });
    // 全服世界事件实时进度（后端每 10 分钟 tick 推一次；里程碑/跨台阶另有公屏播报）
    socket.on('worldEvent:progress', (data) => {
      worldEventProgress.value = data;
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
        connectionStore.setStats(data);
      }
    });
    socket.on('error', (e) => {
      console.error('socket error', e);
      // 带 message 的错误顺带弹提示（未认证等）；限流走专用 chat:rate-limit
      if (e?.message) showToast(e.message, 'error');
    });
    // 发送间隔限流：明确告知还要等多久，避免“静默发不出去”
    socket.on('chat:rate-limit', (data) => {
      showToast(data?.message || '消息发送过于频繁，请稍后再发', 'error');
    });

    // 接收公屏 @提及 通知，弹出轻提示
    socket.on('chat:at', (data) => {
      if (!data) return;
      const fromName = data.from?.nickname || data.from?.username || '有人';
      showToast(`${fromName} 在公屏 @ 了你`);
    });
    // 红包状态更新（有人领取 / 被领完 / 过期退回）：同步悬浮窗里的红包卡片
    socket.on('chat:redpacket', (packet) => {
      if (packet?.id) floatingChat.upsertRedPacket(packet);
    });
    // 专属红包定向提醒：有人专门给你发了红包（只推给被指定的人）
    socket.on('chat:redpacket-target', (data) => {
      if (!data) return;
      const from = data.from || '有人';
      const detail = data.summary ? `（${data.summary}）` : '';
      // 红包消息本身会进悬浮窗并累计未读红点，这里再给一条即时轻提示
      showToast(`${from} 给你发了一个专属红包${detail}，快去领！`, 'success');
    });
    // 红包过期退回通知：提醒发送者剩余道具已回到背包
    socket.on('chat:redpacket-refund', (data) => {
      if (!data) return;
      const names = (data.items || [])
        .map((item) => `${item.name}×${item.quantity}`)
        .join('、');
      showToast(names ? `红包已过期，剩余道具已退回背包：${names}` : '红包已过期，道具已退回背包', 'info');
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

    // 首屏兜底重滚（scrollHeight 迟到增长的原因见 pinBottomOnLoad 定义处）
    pinBottomOnLoad();
  } catch (e) {
    console.error('加载失败', e);
  }
});

onUnmounted(() => {
  socket?.disconnect();
  // 清理贴底跟随循环 + 容器尺寸监听
  stopBottomFollow();
  pinBottomResizeObs?.disconnect();
  pinBottomResizeObs = null;
  window.removeEventListener('resize', setViewportHeight);
  window.visualViewport?.removeEventListener('resize', setViewportHeight);
  // 总线订阅随组件销毁一并摘掉（keep-alive 缓存期间故意保留，见 setup 顶层注册处）
  offBusCommand();
  offBusAction();
  clearDockHideTimer();
  if (statsTimer) clearInterval(statsTimer);
  if (nearbyTimer) clearInterval(nearbyTimer);
  if (atPlayersTimer) clearInterval(atPlayersTimer);
  if (panelTimer) clearInterval(panelTimer);
  if (updateTimer) clearInterval(updateTimer);
  if (updateCountdownTimer) clearInterval(updateCountdownTimer);
  if (annTimer) clearInterval(annTimer);
  if (onlinePanelCloseTimer) {
    clearTimeout(onlinePanelCloseTimer);
    onlinePanelCloseTimer = null;
  }
});
</script>

<style scoped>
/* ===== 私密消息标记：自己才能看到完整内容的消息 ===== */
.private-badge {
  display: inline-block;
  margin-right: 6px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  color: #ffd76a;
  background: rgba(255, 215, 106, 0.12);
  border: 1px solid rgba(255, 215, 106, 0.35);
  vertical-align: middle;
  white-space: nowrap;
}

/* ===== 开局门闸（仅判定期间可见）：避免新玩家看到空壳主界面后被打断跳转 ===== */
.boot-splash {
  position: fixed;
  inset: 0;
  z-index: 5;
  display: grid;
  place-items: center;
  background: var(--bg);
}
.boot-ring {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  animation: boot-spin 0.8s linear infinite;
}
@keyframes boot-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .boot-ring { animation: none; }
}

/* 富卡片消息容器：占满消息主体宽度，让内部网格能排多列 */
.rich-wrap {
  width: 100%;
  min-width: 0;
  display: block;
}
/* 家园建造引导卡片容器：宽度自适应，最宽 560px 避免超宽屏被拉散 */
.home-guide-wrap {
  width: 100%;
  min-width: 0;
  max-width: 560px;
  margin: 2px auto;
}
/* 个人中心 @username 行：长 username（完整 QQ OpenID 约35字符）超出显示省略号，不换行 */
.meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  display: block;
}
/* ===== 右下角操作坞按钮（反馈等） ===== */
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

/* ===== 顶部操作坞 ===== */
/* 单行横排；滚动/悬停时显示，几秒后淡出隐藏 */
.action-dock {
  margin-left: auto;
  margin-right: auto;
  width: max-content;
  max-width: calc(100% - 8px);
  flex-wrap: nowrap;
  white-space: nowrap;
  justify-content: center;
  align-items: center;
  gap: 6px;
  padding: 0;
  border-radius: 0;
  background: transparent;
  border: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  box-shadow: none;
  opacity: 1;
  transform: translateY(0);
  transition: opacity 0.22s ease, transform 0.22s ease, visibility 0.22s ease;
}
.action-dock.is-hidden {
  opacity: 0;
  transform: translateY(-6px);
  visibility: hidden;
  pointer-events: none;
  /* visibility:hidden 仍占布局高；压到 0 才不会在顶栏里撑出一条空黑条 */
  height: 0;
  min-height: 0;
  overflow: hidden;
  margin: 0;
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
/* ===== 个人设置弹窗 ===== */
.settings-overlay {
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
.settings-modal {
  width: 420px;
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
.set-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--glass-border);
  background: rgba(10, 10, 26, 0.6);
}
.set-header h3 {
  font-size: 15px;
  color: var(--text);
  margin: 0;
}
.set-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.set-section-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}
.set-section-desc {
  font-size: 11px;
  color: var(--muted);
  margin-top: 3px;
}
.set-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
.set-option {
  text-align: left;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: rgba(139, 92, 246, 0.04);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.set-option:hover {
  border-color: rgba(139, 92, 246, 0.5);
}
.set-option.active {
  border-color: rgba(139, 92, 246, 0.8);
  background: rgba(139, 92, 246, 0.14);
  box-shadow: 0 0 12px rgba(139, 92, 246, 0.18);
}
.set-option-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
}
.set-option.active .set-option-name {
  color: #c4b5fd;
}
.set-option-check {
  font-style: normal;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(139, 92, 246, 0.2);
  border: 1px solid rgba(139, 92, 246, 0.4);
  color: #c4b5fd;
}
.set-option-desc {
  font-size: 11px;
  color: var(--muted);
}

/* ============================================================
 * 手机端游戏手感（≤768px）
 *
 * 顶部 web 栏整条下线（App 级 HUD 接管），本页只留两块游戏区：
 * 拇指区技能栏 .m-skills（横滑，一眼可及的主操作）+ 输入行动条 .input-bar。
 * 特异度说明：scoped 编译后自带 [data-v-*] 属性选择器，这里 <768px 的规则
 * 一律压得住 styles.css 里给 .chat-header / .input-bar 写的旧手机规则。
 * ============================================================ */
/* 拇指区技能栏是手机端专属：模板里没有按视口 v-if 网关（SSR 无关、也不该跟随
   一次性的 JS 判定），所以桌面端靠这条基础规则整体藏起来，下面 768px 里再点亮。 */
.m-skills {
  display: none;
}

@media (max-width: 768px) {
  /* ===== 顶栏：手机端不显示（过滤/指令已下移到技能栏，版本号与反馈在「我的」面板里） ===== */
  .chat-header {
    display: none;
  }
  /* 顶栏里剩的「网页味」元素（版本号 / GitHub 反馈 / 外链推广）桌面端专属，
     显式写死，避免以后有人把顶栏调回可见时又漏出来 */
  .chat-header .version-tag,
  .chat-header .github-issue-btn,
  .chat-header .reborn-link {
    display: none;
  }

  /* ===== 拇指区技能栏：横向滑动的一排「技能按钮」 ===== */
  .m-skills {
    display: flex;
    align-items: stretch;
    flex-shrink: 0;
    gap: 6px;
    padding: 6px 10px;
    border-top: 1px solid var(--glass-border);
    background: rgba(10, 10, 26, 0.55);
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
    scroll-snap-type: x proximity;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .m-skills::-webkit-scrollbar {
    display: none;
  }

  /* 单个技能：图标在上、文字在下的竖排小块，拇指能稳点到的最小尺寸 */
  .msk {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    flex: 0 0 auto;
    min-width: 54px;
    min-height: 46px;
    padding: 4px 9px;
    border-radius: 12px;
    border: 1px solid rgba(139, 92, 246, 0.4);
    background: linear-gradient(160deg, rgba(41, 32, 80, 0.92), rgba(14, 12, 34, 0.92));
    color: var(--text-secondary);
    font-family: inherit;
    cursor: pointer;
    scroll-snap-align: start;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition: transform 0.12s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .msk-ico {
    font-size: 17px;
    line-height: 1.15;
  }
  .msk-t {
    font-size: 10.5px;
    line-height: 1.25;
    white-space: nowrap;
    color: var(--text);
  }
  /* 按下即缩：手机端没有 hover，:active 是唯一能给的「按到了」反馈 */
  .msk:active {
    transform: scale(0.93);
  }
  /* 过滤开关的开启态：填成主色渐变，一眼看出现在处于哪个过滤档 */
  .msk.on {
    border-color: rgba(139, 92, 246, 0.85);
    background: var(--accent-gradient);
    box-shadow: 0 0 12px rgba(139, 92, 246, 0.3);
  }
  .msk.on .msk-t {
    color: #fff;
  }
  /* 攻击：暖红金渐变，整条技能栏里唯一的高对比块 = 主战斗动作 */
  .msk.atk {
    border-color: rgba(251, 191, 36, 0.6);
    background: linear-gradient(160deg, #f59e0b, #dc2626 62%, #7f1d1d);
    box-shadow: 0 2px 10px rgba(220, 38, 38, 0.32);
  }
  .msk.atk .msk-t {
    color: #fff;
    font-weight: 700;
  }
  /* 常用指令芯片：纯文案、无图标，视觉上矮一档，和技能按钮区分开 */
  .msk.fav {
    flex-direction: row;
    min-width: 0;
    padding: 0 12px;
    border-color: var(--glass-border);
    background: rgba(139, 92, 246, 0.1);
  }
  .msk.fav .msk-t {
    color: var(--text-secondary);
    max-width: 108px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* 空态提示：点它直接开「我的」面板去加常用（虚线框 = 还能往里放东西） */
  .msk-more {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    align-self: center;
    padding: 6px 10px;
    border: 1px dashed rgba(139, 92, 246, 0.45);
    border-radius: 12px;
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
    scroll-snap-align: start;
    -webkit-tap-highlight-color: transparent;
  }
  .msk-more:active {
    color: var(--text-secondary);
    border-color: var(--accent);
  }

  /* ===== 输入栏 = 行动条：紧凑、按钮够大、字号防 iOS 放大 ===== */
  .input-bar {
    align-items: flex-end;
    flex-shrink: 0;
    gap: 8px;
    padding: 6px 10px;
    padding-bottom: calc(8px + var(--safe-bottom));
    border-top: 1px solid var(--glass-border);
    background: rgba(10, 10, 26, 0.72);
  }
  .input-wrapper {
    flex: 1 1 auto;
    min-width: 0;
  }
  /* 16px 是硬要求：小于它 iOS Safari 聚焦会自动放大整个页面且回不去 */
  .input-wrapper textarea.cmd-input {
    min-height: 44px;
    padding: 10px 12px;
    font-size: 16px;
    line-height: 1.45;
    border-radius: 12px;
    font-family: inherit;
  }
  /* 发送键：48px 的圆角大块，拇指落点，和技能栏同一条横轴上 */
  .input-bar > button {
    flex: 0 0 auto;
    min-width: 56px;
    height: 48px;
    padding: 0 16px;
    border-radius: 16px;
    background: var(--accent-gradient-full);
    background-size: 200% auto;
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 1px;
    box-shadow: 0 3px 12px rgba(139, 92, 246, 0.34);
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition: transform 0.12s ease, background-position 0.3s ease, box-shadow 0.2s ease;
  }
  .input-bar > button:active:not(:disabled) {
    transform: scale(0.94);
    background-position: right center;
  }
  .input-bar > button:disabled {
    opacity: 0.45;
    box-shadow: none;
  }

  /* 键盘弹起：技能栏收起，把纵向空间全让给正文（body.kb-open 由本页 visualViewport 测高逻辑维护） */
  body.kb-open .m-skills {
    display: none;
  }
}

/* 小屏（≤480px）：只收内边距与字号，芯片最小尺寸保持不动（拇指区不能再小） */
@media (max-width: 480px) {
  .m-skills {
    gap: 5px;
    padding: 5px 8px;
  }
  .msk {
    padding: 4px 8px;
    border-radius: 11px;
  }
  .msk-t {
    font-size: 10px;
  }
  .msk.fav .msk-t {
    max-width: 88px;
  }
  .input-bar {
    padding: 5px 8px;
    padding-bottom: calc(6px + var(--safe-bottom));
  }
  .input-wrapper textarea.cmd-input {
    padding: 9px 11px;
  }
}

/* 手机端：消息行与技能栏角标的补充规则（写在最后，靠源码顺序压过上面的历史规则） */
@media (max-width: 768px) {
  /* 「世界」键的未读角标 */
  .msk-ico {
    position: relative;
  }
  .msk-badge {
    position: absolute;
    top: -5px;
    right: -9px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 999px;
    background: var(--danger, #ef4444);
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    line-height: 14px;
    text-align: center;
    box-shadow: 0 0 0 1.5px rgba(10, 10, 26, 0.9);
  }

  /* 一条消息原本排成「正文 + 右侧时间戳」一行：手机上秒级时间戳约 103px 且 nowrap，
     会把正文挤到 0 宽、时间戳溢出视口（自己发的指令消息整条只剩个被裁掉的时间）。
     手游的聊天流本来就是正文一屏、时间戳当配角，所以改成上下两行。 */
  .msg {
    flex-direction: column;
    align-items: stretch;
    gap: 0;
  }
  .msg-body {
    width: 100%;
    min-width: 0;
  }
  .msg-time {
    flex: 0 0 auto;
    margin-top: 1px;
    font-size: 9.5px;
    line-height: 1.2;
    opacity: 0.5;
    text-align: right;
    white-space: normal;
  }
  /* 居中系的系统/战斗消息保持居中，不让时间戳跑到右边去压排版 */
  .msg.system .msg-time,
  .msg.info .msg-time {
    text-align: center;
  }
}
</style>
