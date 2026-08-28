<template>
  <div class="admin-page">
    <!-- 顶栏 -->
    <header class="admin-header">
      <h1>⚙️ 管理员后台</h1>
      <div class="header-actions">
        <button class="btn-ghost" @click="goChat">← 返回公屏</button>
        <button class="btn-ghost" @click="logout">退出</button>
      </div>
    </header>

    <!-- 标签页 -->
    <nav class="tabs">
      <button :class="['tab', tab === 'dashboard' && 'active']" @click="tab = 'dashboard'">📊 仪表盘</button>
      <button :class="['tab', tab === 'config' && 'active']" @click="tab = 'config'">⚙️ 系统配置</button>
      <button :class="['tab', tab === 'users' && 'active']" @click="tab = 'users'">👥 用户管理</button>
      <button :class="['tab', tab === 'gm' && 'active']" @click="tab = 'gm'">🔧 GM 工具</button>
      <button :class="['tab', tab === 'feedback' && 'active']" @click="tab = 'feedback'">📋 反馈管理</button>
    </nav>

    <main class="admin-content">
      <!-- ===== 仪表盘 ===== -->
      <section v-if="tab === 'dashboard'" class="panel">
        <div class="panel-head">
          <h2>服务器状态</h2>
        </div>

        <!-- 统计卡片 -->
        <div class="stat-cards">
          <div class="stat-card">
            <div class="stat-number">{{ dashboardStats.totalUsers || '-' }}</div>
            <div class="stat-label">总用户数</div>
            <div class="stat-sub">注册用户总量</div>
          </div>
          <div class="stat-card">
            <div class="stat-number">{{ dashboardStats.onlinePlayers || '-' }}</div>
            <div class="stat-label">在线玩家</div>
            <div class="stat-sub">当前在线</div>
          </div>
          <div class="stat-card">
            <div class="stat-number">{{ dashboardStats.totalPlayers || '-' }}</div>
            <div class="stat-label">游戏角色</div>
            <div class="stat-sub">已创建角色</div>
          </div>
          <div class="stat-card">
            <div class="stat-number">{{ dashboardStats.totalMaps || '-' }}</div>
            <div class="stat-label">地图数量</div>
            <div class="stat-sub">可探索区域</div>
          </div>
          <div class="stat-card">
            <div class="stat-number">{{ dashboardStats.totalMonsters || '-' }}</div>
            <div class="stat-label">怪物总数</div>
            <div class="stat-sub">全服怪物</div>
          </div>
          <div class="stat-card">
            <div class="stat-number">{{ dashboardStats.totalItems || '-' }}</div>
            <div class="stat-label">物品总数</div>
            <div class="stat-sub">装备/道具</div>
          </div>
        </div>

        <!-- 世界等级 -->
        <div class="world-level-display">
          <span class="wl-label">🌍 世界等级</span>
          <span class="wl-value">{{ worldLevel }}</span>
          <div class="wl-controls">
            <input v-model.number="newWorldLevel" type="number" min="1" max="999" />
            <button class="gm-btn" @click="setWorldLevel" :disabled="gmLoading">设置</button>
          </div>
        </div>
      </section>

      <!-- ===== 系统配置 ===== -->
      <section v-if="tab === 'config'" class="panel">
        <div class="panel-head">
          <h2>系统配置中心</h2>
          <p class="hint">修改后立即生效，无需重启服务。可按分组管理指令、游戏等各类配置。</p>
        </div>

        <div class="config-groups">
          <div v-for="grp in configGroups" :key="grp.name" class="config-group">
            <h3>{{ grp.label }}</h3>
            <div v-for="cfg in grp.items" :key="cfg.key" class="config-item">
              <div class="config-info">
                <span class="config-label">{{ cfg.label }}</span>
                <span class="config-desc">{{ cfg.description }}</span>
              </div>
              <div class="config-editor">
                <!-- 布尔类型 -->
                <select v-if="cfg.type === 'boolean'" :value="cfg.value === 'true'" @change="saveConfig(cfg, $event.target.value === 'true')">
                  <option :value="true">是</option>
                  <option :value="false">否</option>
                </select>
                <!-- 字符串数组 -->
                <input v-else-if="cfg.type === 'string-array'" :value="arrayValue(cfg.value)" @change="saveConfig(cfg, stringToArray($event.target.value))" placeholder="逗号分隔多个值" />
                <!-- 数字 / 文本 -->
                <input v-else :value="cfg.value" @change="saveConfig(cfg, cfg.type === 'number' ? Number($event.target.value) : $event.target.value)" />
                <span class="saved-tip" :class="{ show: savedKey === cfg.key }">✓ 已保存</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ===== 用户管理 ===== -->
      <section v-if="tab === 'users'" class="panel">
        <div class="panel-head">
          <h2>用户管理</h2>
          <div class="search">
            <input v-model="keyword" placeholder="搜索用户名/昵称/QQ" @keyup.enter="loadUsers(1)" />
            <button @click="loadUsers(1)">搜索</button>
          </div>
        </div>

        <table class="user-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>用户名</th>
              <th>昵称</th>
              <th>角色 / 状态</th>
              <th>玩家信息</th>
              <th>在线</th>
              <th>在线时长</th>
              <th>最后活跃 / 最后登录</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <td>{{ u.id }}</td>
              <td>
                <div>{{ u.username }}</div>
                <div v-if="u.qqNumber" class="qq-ext">QQ: {{ u.qqNumber }}</div>
              </td>
              <td>
                <input class="inline-input" :value="u.nickname" @change="updateUser(u, { nickname: $event.target.value })" />
              </td>
              <td>
                <select class="role-select" :value="u.role" @change="updateUser(u, { role: $event.target.value })">
                  <option value="USER">USER</option>
                  <option value="ADMIN">ADMIN</option>
                  <option value="SUPER_ADMIN">SUPER_ADMIN</option>
                </select>
                <select class="status-select" :value="u.status" @change="updateUser(u, { status: $event.target.value })">
                  <option value="ACTIVE">正常</option>
                  <option value="BANNED">封禁</option>
                </select>
              </td>
              <td>
                <template v-if="u.player">
                  <span class="player-tag lv">{{ u.player.level }}级</span>
                  <span v-if="u.player.name" class="player-tag">{{ u.player.name }}</span>
                  <span v-if="u.player.location" class="player-tag loc">{{ u.player.location }}</span>
                </template>
                <span v-else class="muted">未创建角色</span>
              </td>
              <td>
                <span :class="['online-dot', u.online ? 'on' : 'off']"></span>
                {{ u.online ? '在线' : '离线' }}
              </td>
              <td>{{ formatDuration(u.playTimeSeconds) }}</td>
              <td class="time-cell">
                <div>{{ formatTime(u.lastActiveAt) || '从未' }}</div>
                <div class="time-sub">登录: {{ formatTime(u.lastLoginAt) || '从未' }} ({{ u.loginCount ?? 0 }}次)</div>
              </td>
              <td>
                <span v-if="savedUser === u.id" class="saved-badge">✓</span>
                <button class="detail-btn" title="查看/编辑用户详细数据" @click="openUserDetail(u)">详情</button>
                <button
                  class="reset-btn"
                  title="清空该玩家的游戏进度(保留账号，可重新选使魔开局)"
                  @click="resetUserData(u)"
                >清空数据</button>
                <button class="delete-btn" title="删除用户(级联删除其角色数据)" @click="deleteUser(u)" :disabled="u.id === user?.id">删除</button>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- 用户详情 / 编辑弹窗 -->
        <div v-if="detailUser" class="modal-mask" @click.self="closeUserDetail">
          <div class="modal-box">
            <div class="modal-head">
              <h3>
                用户详情
                <span :class="['online-dot', detailUser.online ? 'on' : 'off']"></span>
                <small class="muted">#{{ detailUser.id }} · {{ detailUser.username }}</small>
              </h3>
              <button class="modal-close" @click="closeUserDetail">×</button>
            </div>

            <div v-if="detailLoading" class="fb-empty">加载中...</div>
            <template v-else>
              <!-- 账号信息（只读 + 可改的绑定QQ） -->
              <div class="detail-grid">
                <div class="detail-item"><label>昵称</label><span>{{ detailUser.nickname || '-' }}</span></div>
                <div class="detail-item">
                  <label>QQ号（修改即保存，清空解绑）</label>
                  <input
                    class="qq-edit-input"
                    :value="detailUser.qqNumber || ''"
                    placeholder="未绑定"
                    @change="saveUserField({ qqNumber: $event.target.value.trim() })"
                  />
                </div>
                <div class="detail-item"><label>注册时间</label><span>{{ formatTime(detailUser.createdAt) || '-' }}</span></div>
                <div class="detail-item"><label>最后登录</label><span>{{ formatTime(detailUser.lastLoginAt) || '从未' }}（{{ detailUser.loginCount ?? 0 }} 次）</span></div>
                <div class="detail-item"><label>累计在线时长</label><span>{{ formatDuration(detailPlayer?.playTimeSeconds) }}</span></div>
                <div class="detail-item"><label>互联ID</label><span class="mono">{{ detailUser.externalId || '-' }}</span></div>
              </div>

              <template v-if="editForm">
                <p class="hint" style="margin: 10px 0 6px;">游戏数据编辑（留空的字段不会被修改，保存后即时生效）：</p>
                <div class="edit-grid">
                  <label v-for="f in editableFields" :key="f.field" class="edit-field">
                    <span>{{ f.label }}</span>
                    <input v-model="editForm[f.field]" :placeholder="'当前: ' + currentDisplay(f)" />
                  </label>
                </div>

                <div class="modal-foot">
                  <button class="gm-btn success" :disabled="editSaving" @click="savePlayerEdit">{{ editSaving ? '保存中...' : '保存修改' }}</button>
                  <span v-if="editResult" :class="['edit-result', editError && 'err']">{{ editResult }}</span>
                </div>
              </template>
              <p v-else class="muted" style="margin-top: 10px;">该用户尚未创建游戏角色。</p>
            </template>
          </div>
        </div>

        <div class="pagination">
          <button :disabled="page <= 1" @click="loadUsers(page - 1)">上一页</button>
          <span>第 {{ page }} 页 / 共 {{ Math.ceil(total / pageSize) }} 页 (共 {{ total }} 人)</span>
          <button :disabled="page >= Math.ceil(total / pageSize)" @click="loadUsers(page + 1)">下一页</button>
        </div>
      </section>

      <!-- ===== GM 工具 ===== -->
      <section v-if="tab === 'gm'" class="panel">
        <div class="panel-head">
          <h2>GM 工具</h2>
          <p class="hint">管理员专用工具，操作会即时生效。</p>
        </div>

        <div class="gm-tools">
          <!-- 发放物品 -->
          <div class="gm-tool-card">
            <h3>🎁 发放物品</h3>
            <div class="gm-field">
              <label>目标玩家（用户名或ID）</label>
              <input v-model="gmGiveItem.target" placeholder="输入玩家用户名或ID" />
            </div>
            <div class="gm-field">
              <label>物品名称</label>
              <input v-model="gmGiveItem.itemName" placeholder="如：铁剑、治疗药水" />
            </div>
            <div class="gm-field">
              <label>数量</label>
              <input v-model.number="gmGiveItem.quantity" type="number" min="1" value="1" />
            </div>
            <button class="gm-btn success" @click="doGiveItem" :disabled="gmLoading">发放物品</button>
            <p v-if="gmGiveItem.result" class="gm-result">{{ gmGiveItem.result }}</p>
          </div>

          <!-- 修改玩家属性 -->
          <div class="gm-tool-card">
            <h3>🔧 修改玩家属性</h3>
            <div class="gm-field">
              <label>目标玩家（用户名/昵称/QQ号/ID）</label>
              <input v-model="gmModify.target" placeholder="输入玩家用户名、昵称、QQ号或ID" />
            </div>
            <div class="gm-field">
              <label>属性字段</label>
              <select v-model="gmModify.field">
                <option v-for="f in modifyFields" :key="f.value" :value="f.value">{{ f.label }}</option>
              </select>
            </div>
            <div class="gm-field">
              <label>新值{{ modifyFieldValueIsNumber ? '（数字）' : '' }}</label>
              <input v-model="gmModify.value" :placeholder="modifyFieldValueIsNumber ? '如：10' : '如：新手村'" />
            </div>
            <button class="gm-btn" @click="doModifyPlayer" :disabled="gmLoading">修改属性</button>
            <p v-if="gmModify.result" class="gm-result">{{ gmModify.result }}</p>
          </div>

          <!-- 设置世界等级 -->
          <div class="gm-tool-card">
            <h3>🌍 设置世界等级</h3>
            <div class="gm-field">
              <label>当前世界等级：<strong>{{ worldLevel }}</strong></label>
            </div>
            <div class="gm-field">
              <label>新世界等级</label>
              <input v-model.number="newWorldLevel" type="number" min="1" max="999" />
            </div>
            <button class="gm-btn" @click="setWorldLevel" :disabled="gmLoading">设置世界等级</button>
            <p v-if="worldLevelResult" class="gm-result">{{ worldLevelResult }}</p>
          </div>

          <!-- 发送全服公告：支持富文本（链接/图片/粗体等 Markdown 子集），发送前可实时预览 -->
          <div class="gm-tool-card">
            <h3>📢 发送全服公告</h3>
            <div class="gm-field">
              <label>公告内容</label>
              <textarea v-model="gmAnnouncement.content" placeholder="输入要发送给所有玩家的公告内容...&#10;&#10;支持格式：[文字](链接) 超链接、![说明](图片地址) 配图、**粗体**、*斜体*、`代码`"></textarea>
              <div class="ann-editor-toolbar">
                <input ref="annImgInput" type="file" accept="image/*" multiple style="display: none" @change="onAnnImagesSelected" />
                <button class="btn-ghost" :disabled="annUploading" @click="pickAnnImages">
                  {{ annUploading ? '⏳ 上传中…' : '🖼️ 插入图片' }}
                </button>
                <span class="ann-editor-hint">支持 [文字](链接)、**粗体** 等写法，玩家端链接可直接点击</span>
              </div>
            </div>
            <!-- 实时预览：与玩家端公告弹窗同一渲染组件 -->
            <div v-if="gmAnnouncement.content.trim()" class="ann-preview">
              <div class="ann-preview-title">👁️ 预览（玩家端效果）</div>
              <AnnRichText class="ann-preview-body" :content="gmAnnouncement.content" />
            </div>
            <button class="gm-btn danger" @click="doSendAnnouncement" :disabled="gmLoading || !gmAnnouncement.content.trim()">发送公告</button>
            <p v-if="gmAnnouncement.result" class="gm-result">{{ gmAnnouncement.result }}</p>
          </div>
        </div>
      </section>

      <!-- ===== 反馈管理 ===== -->
      <section v-if="tab === 'feedback'" class="panel">
        <div class="panel-head">
          <h2>反馈管理</h2>
          <p class="hint">查看玩家反馈工单，回复消息并管理处理状态。</p>
        </div>

        <!-- 状态过滤 -->
        <div class="fb-filters">
          <button
            v-for="s in feedbackStatusFilters"
            :key="s.value"
            :class="['fb-filter-btn', { active: feedbackStatus === s.value }]"
            @click="setFeedbackStatus(s.value)"
          >
            {{ s.label }}
          </button>
        </div>

        <!-- 工单列表 -->
        <div v-if="feedbackLoading" class="fb-empty">加载中...</div>
        <div v-else-if="feedbackList.length" class="fb-list">
          <div
            v-for="f in feedbackList"
            :key="f.id"
            :class="['fb-card', { active: currentFeedback?.id === f.id }]"
            @click="openFeedbackDetail(f)"
          >
            <div class="fb-card-main">
              <span class="fb-ticket-no">#{{ f.id }}</span>
              <span class="fb-title">{{ f.title }}</span>
              <span :class="['fb-status', 'st-' + String(f.status).toLowerCase()]">{{ statusLabel(f.status) }}</span>
            </div>
            <div class="fb-card-sub">
              <span class="fb-cat">{{ categoryLabel(f.category) }}</span>
              <span class="fb-user">👤 {{ f.user?.nickname || f.user?.username || '用户' }}</span>
              <span class="fb-time">🕐 {{ formatTime(f.updatedAt) }}</span>
            </div>
            <div class="fb-preview">
              <span v-if="f.messages?.length" class="fb-preview-text">
                {{ (f.messages[0].senderType === 'admin' ? '[管理员] ' : '[用户] ') + (f.messages[0].content || '') }}
              </span>
              <span v-else class="fb-preview-text fb-preview-empty">暂无消息</span>
            </div>
          </div>
        </div>
        <div v-else class="fb-empty">暂无反馈工单</div>

        <!-- 分页 -->
        <div class="pagination fb-pagination">
          <button :disabled="feedbackPage <= 1" @click="loadFeedbackList(feedbackPage - 1)">上一页</button>
          <span>第 {{ feedbackPage }} 页 / 共 {{ Math.ceil(feedbackTotal / feedbackPageSize) }} 页 (共 {{ feedbackTotal }} 条)</span>
          <button :disabled="feedbackPage >= Math.ceil(feedbackTotal / feedbackPageSize)" @click="loadFeedbackList(feedbackPage + 1)">下一页</button>
        </div>

        <!-- 工单详情面板 -->
        <div v-if="currentFeedback" class="fb-detail">
          <div class="fb-detail-head">
            <div>
              <h3>#{{ currentFeedback.id }} {{ currentFeedback.title }}</h3>
              <div class="fb-detail-meta">
                <span :class="['fb-status', 'st-' + String(currentFeedback.status).toLowerCase()]">{{ statusLabel(currentFeedback.status) }}</span>
                <span class="fb-cat">{{ categoryLabel(currentFeedback.category) }}</span>
                <span class="fb-user">👤 {{ currentFeedback.user?.nickname || currentFeedback.user?.username || '用户' }}</span>
                <span class="fb-time">创建于 {{ formatTime(currentFeedback.createdAt) }}</span>
              </div>
            </div>
            <button class="btn-ghost" @click="closeFeedbackDetail">✕ 关闭</button>
          </div>

          <!-- 状态变更 -->
          <div class="fb-status-bar">
            <label for="fb-status-select">处理状态：</label>
            <select id="fb-status-select" :value="currentFeedback.status" @change="changeFeedbackStatus($event.target.value)">
              <option v-for="s in feedbackStatusOptions" :key="s" :value="s">{{ statusLabel(s) }}</option>
            </select>
          </div>

          <!-- 完整消息列表 -->
          <div class="fb-messages">
            <div v-for="m in currentFeedback.messages" :key="m.id" :class="['fb-msg', m.senderType === 'admin' ? 'from-admin' : 'from-user']">
              <div class="fb-msg-head">
                <span class="fb-msg-sender">{{ m.sender?.nickname || m.sender?.username || (m.senderType === 'admin' ? '管理员' : '用户') }}</span>
                <span class="fb-msg-time">{{ formatTime(m.createdAt) }}</span>
              </div>
              <div class="fb-msg-content">{{ m.content }}</div>
              <!-- 附件展示：图片显示缩略图，其它文件显示为下载链接 -->
              <div v-if="attachmentList(m).length" class="fb-msg-attachments">
                <a
                  v-for="(u, i) in attachmentList(m)"
                  :key="i"
                  class="fb-attach"
                  :href="resolveUploadUrl(u)"
                  target="_blank"
                  rel="noopener"
                >
                  <img v-if="isImage(u)" :src="resolveUploadUrl(u)" class="fb-attach-img" :alt="'附件 ' + (i + 1)" />
                  <span v-else class="fb-attach-file">📄 {{ fileName(u) }}</span>
                </a>
              </div>
            </div>
          </div>

          <!-- 管理员回复区 -->
          <div class="fb-reply">
            <textarea
              v-model="feedbackReplyText"
              placeholder="输入回复内容...（可 Ctrl+V 粘贴剪贴板截图）"
              maxlength="2000"
              @paste="handleReplyPasteImage"
            ></textarea>
            <div class="fb-reply-tools">
              <!-- 已上传的附件预览 -->
              <div v-if="feedbackReplyAttachments.length" class="fb-reply-attachments">
                <div v-for="(u, i) in feedbackReplyAttachments" :key="i" class="fb-reply-attach">
                  <img v-if="isImage(u)" :src="resolveUploadUrl(u)" class="fb-attach-img" alt="附件预览" />
                  <span v-else class="fb-attach-file">📄 {{ fileName(u) }}</span>
                  <button class="fb-remove" type="button" title="移除附件" @click="feedbackReplyAttachments.splice(i, 1)">✕</button>
                </div>
              </div>
              <div class="fb-reply-actions">
                <!-- 附件上传：隐藏的文件选择器，经 feedbackApi.upload() 上传后取回 URL -->
                <input
                  ref="fbFileInput"
                  type="file"
                  multiple
                  accept="image/*,.pdf,.zip,.doc,.docx,.txt"
                  style="display: none"
                  @change="onReplyFilesSelected"
                />
                <button class="btn-ghost" @click="pickReplyFiles" :disabled="feedbackReplying">📎 上传附件</button>
                <button class="gm-btn" @click="sendFeedbackReply" :disabled="feedbackReplying || !feedbackReplyText.trim()">发送回复</button>
              </div>
            </div>
            <p v-if="feedbackReplyMsg" class="fb-reply-msg" :class="{ error: feedbackReplyError }">{{ feedbackReplyMsg }}</p>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
/**
 * 管理员后台页面（增强版）
 * - 仪表盘：服务器状态统计、世界等级显示与控制
 * - 系统配置：在线修改指令前缀、游戏数值等配置项
 * - 用户管理：查看/修改用户角色、封禁状态、昵称
 * - GM 工具：发放物品、设置世界等级、发送全服公告
 * - 反馈管理：查看/回复玩家反馈工单、变更处理状态、上传附件
 */
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { adminApi, feedbackApi } from '../api';
import { API_BASE } from '../config';
import AnnRichText from '../components/AnnRichText';

const router = useRouter();
const tab = ref('dashboard');
const user = ref(JSON.parse(localStorage.getItem('user') || 'null'));

// ---- 仪表盘 ----
const dashboardStats = ref({});
const worldLevel = ref(1);
const newWorldLevel = ref(1);
const worldLevelResult = ref('');

async function loadDashboard() {
  try {
    const res = await adminApi.dashboard();
    dashboardStats.value = res.data;
  } catch {
    // 仪表盘接口可能不存在，静默使用默认值
  }
}

async function loadWorldLevel() {
  try {
    const res = await adminApi.worldLevel();
    worldLevel.value = res.data.level;
    newWorldLevel.value = res.data.level;
  } catch {
    // 世界等级接口可能不存在
  }
}

async function setWorldLevel() {
  if (!newWorldLevel.value || newWorldLevel.value < 1) return;
  gmLoading.value = true;
  try {
    const res = await adminApi.setWorldLevel(newWorldLevel.value);
    worldLevel.value = res.data.level;
    worldLevelResult.value = `世界等级已设置为 ${res.data.level}`;
    setTimeout(() => (worldLevelResult.value = ''), 3000);
  } catch (e) {
    worldLevelResult.value = '设置失败：' + (e.response?.data?.message || e.message);
  } finally {
    gmLoading.value = false;
  }
}

// ---- 系统配置 ----
const configs = ref([]);
const savedKey = ref('');
const groupLabels = { command: '指令设置', game: '游戏数据', system: '系统', bot: '机器人' };

const configGroups = computed(() => {
  const groups = {};
  for (const cfg of configs.value) {
    const g = cfg.group || 'system';
    if (!groups[g]) groups[g] = { name: g, label: groupLabels[g] || g, items: [] };
    groups[g].items.push(cfg);
  }
  return Object.values(groups);
});

function arrayValue(v) {
  try { return JSON.parse(v).join(', '); } catch { return v; }
}
function stringToArray(s) {
  return s.split(/[,，、\s]+/).filter((x) => x);
}

async function saveConfig(cfg, value) {
  await adminApi.updateConfig(cfg.key, value);
  cfg.value = typeof value === 'object' ? JSON.stringify(value) : String(value);
  savedKey.value = cfg.key;
  setTimeout(() => (savedKey.value = ''), 1500);
}

// ---- 用户管理 ----
const users = ref([]);
const keyword = ref('');
const page = ref(1);
const pageSize = 10;
const total = ref(0);
const savedUser = ref(0);

async function loadUsers(p) {
  page.value = p;
  const res = await adminApi.listUsers({ page: p, pageSize, keyword: keyword.value });
  users.value = res.data.list;
  total.value = res.data.total;
}

async function updateUser(u, changes) {
  const res = await adminApi.updateUser({ id: u.id, ...changes });
  Object.assign(u, res.data);
  savedUser.value = u.id;
  setTimeout(() => (savedUser.value = 0), 1500);
}

async function deleteUser(u) {
  if (u.id === user.value?.id) return;
  // 关键操作，需二次确认
  const ok = confirm(`确定要删除用户「${u.username}」吗？\n将同时删除其游戏角色、绑定关系等数据，不可恢复！`);
  if (!ok) return;
  try {
    const res = await adminApi.deleteUser(u.id);
    alert(res.message || '删除成功');
    // 从当前列表移除，避免整页刷新
    users.value = users.value.filter((x) => x.id !== u.id);
    total.value -= 1;
  } catch (e) {
    alert('删除失败：' + (e.response?.data?.message || e.message));
  }
}

/** 清空玩家游戏数据（保留账号，重置为未开始游玩状态） */
async function resetUserData(u) {
  const ok = confirm(
    `确定要清空用户「${u.username}」的游戏数据吗？\n` +
    `等级、背包、装备、任务等进度将全部重置，账号保留，可重新开局。\n此操作不可恢复！`,
  );
  if (!ok) return;
  try {
    const res = await adminApi.resetUserData(u.id);
    alert(res.message || '已清空游戏数据');
  } catch (e) {
    alert('清空失败：' + (e.response?.data?.message || e.message));
  }
}

// ---- 用户详情 / 编辑弹窗 ----
const detailUser = ref(null);      // 详情弹窗当前用户（含完整档案）
const detailLoading = ref(false);
const editForm = ref(null);        // 可编辑字段表单（仅收集有输入的字段提交）
const editSaving = ref(false);
const editResult = ref('');
const editError = ref(false);

// 可编辑的游戏字段（与后端 players/edit 白名单一致）
const editableFields = [
  { field: 'name', label: '角色名', numeric: false },
  { field: 'type', label: '使魔类型', numeric: false },
  { field: 'level', label: '等级', numeric: true },
  { field: 'exp', label: '经验', numeric: true },
  { field: 'upgradeExp', label: '升级所需经验', numeric: true },
  { field: 'hp', label: '当前HP', numeric: true },
  { field: 'maxHp', label: '最大HP', numeric: true },
  { field: 'shield', label: '当前护盾', numeric: true },
  { field: 'maxShield', label: '最大护盾', numeric: true },
  { field: 'armor', label: '当前装甲', numeric: true },
  { field: 'maxArmor', label: '最大装甲', numeric: true },
  { field: 'attack', label: '攻击', numeric: true },
  { field: 'defense', label: '防御', numeric: true },
  { field: 'speed', label: '速度', numeric: true },
  { field: 'dodge', label: '闪避', numeric: true },
  { field: 'hit', label: '命中', numeric: true },
  { field: 'crit', label: '暴击率(%)', numeric: true },
  { field: 'critDmg', label: '暴击伤害(%)', numeric: true },
  { field: 'regenHp', label: '生命回复', numeric: true },
  { field: 'regenShield', label: '护盾回复', numeric: true },
  { field: 'regenArmor', label: '装甲回复', numeric: true },
  { field: 'mapId', label: '地图ID', numeric: true },
  { field: 'location', label: '所在位置', numeric: false },
  { field: 'houseName', label: '家园名称', numeric: false },
  { field: 'affinity', label: '好感度', numeric: true },
  { field: 'vitality', label: '活力', numeric: true },
];

/** 详情弹窗中的玩家档案（detailUser.player） */
const detailPlayer = computed(() => detailUser.value?.player ?? null);

/** 字段当前值的展示文案 */
function currentDisplay(f) {
  const v = detailPlayer.value?.[f.field];
  return (v === null || v === undefined || v === '') ? '-' : String(v);
}

/** 打开用户详情弹窗并拉取完整档案 */
async function openUserDetail(u) {
  detailUser.value = u;
  detailLoading.value = true;
  editForm.value = null;
  editResult.value = '';
  editError.value = false;
  try {
    const res = await adminApi.userDetail(u.id);
    detailUser.value = res.data;
    // 表单初始为全空：留空 = 不修改该字段
    if (res.data.player) {
      editForm.value = Object.fromEntries(editableFields.map((f) => [f.field, '']));
    }
  } catch (e) {
    alert('加载用户详情失败：' + (e.response?.data?.message || e.message));
    detailUser.value = null;
  } finally {
    detailLoading.value = false;
  }
}

function closeUserDetail() {
  detailUser.value = null;
  editForm.value = null;
  editResult.value = '';
}

/** 弹窗内保存账号字段（如绑定QQ号） */
async function saveUserField(changes) {
  const u = detailUser.value;
  if (!u) return;
  try {
    const res = await adminApi.updateUser({ id: u.id, ...changes });
    Object.assign(u, res.data);
    savedUser.value = u.id;
    setTimeout(() => (savedUser.value = 0), 1500);
    await loadUsers(page.value); // 同步列表中的QQ展示
  } catch (e) {
    alert('保存失败：' + (e.response?.data?.message || e.message));
  }
}

/** 提交玩家数据编辑：只提交有输入的字段 */
async function savePlayerEdit() {
  const form = editForm.value;
  if (!form || !detailUser.value) return;
  const changes = {};
  for (const f of editableFields) {
    const raw = `${form[f.field] ?? ''}`.trim();
    if (raw === '') continue; // 留空不修改
    changes[f.field] = f.numeric ? Number(raw) : raw;
    if (f.numeric && Number.isNaN(changes[f.field])) {
      editError.value = true;
      editResult.value = `「${f.label}」需要数字`;
      return;
    }
  }
  if (Object.keys(changes).length === 0) {
    editError.value = true;
    editResult.value = '请先填写要修改的字段';
    return;
  }
  editSaving.value = true;
  editError.value = false;
  try {
    const res = await adminApi.editPlayerData(detailUser.value.id, changes);
    editResult.value = res.message || '保存成功';
    await loadUsers(page.value); // 刷新列表中的等级/位置等展示
  } catch (e) {
    editError.value = true;
    editResult.value = '保存失败：' + (e.response?.data?.message || e.message);
  } finally {
    editSaving.value = false;
  }
}

/** 秒数 → "X天X小时X分" 展示 */
function formatDuration(seconds) {
  const s = Number(seconds ?? 0);
  if (!s || s <= 0) return '-';
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${mins}分`;
  return `${mins}分钟`;
}

// ---- GM 工具 ----
const gmLoading = ref(false);

const gmGiveItem = ref({
  target: '',
  itemName: '',
  quantity: 1,
  result: '',
});

// ---- GM 修改玩家属性 ----
// 可修改字段（与后端白名单一致）
const modifyFields = [
  { value: 'level', label: '等级 (level)' },
  { value: 'exp', label: '经验 (exp)' },
  { value: 'name', label: '角色名 (name)' },
  { value: 'hp', label: '当前HP (hp)' },
  { value: 'maxHp', label: '最大HP (maxHp)' },
  { value: 'shield', label: '当前护盾 (shield)' },
  { value: 'maxShield', label: '最大护盾 (maxShield)' },
  { value: 'armor', label: '当前护甲 (armor)' },
  { value: 'maxArmor', label: '最大护甲 (maxArmor)' },
  { value: 'attack', label: '攻击 (attack)' },
  { value: 'defense', label: '防御 (defense)' },
  { value: 'speed', label: '速度 (speed)' },
  { value: 'dodge', label: '闪避 (dodge)' },
  { value: 'hit', label: '命中 (hit)' },
  { value: 'crit', label: '暴击率 (crit)' },
  { value: 'critDmg', label: '暴击伤害 (critDmg)' },
  { value: 'affinity', label: '好感度 (affinity)' },
  { value: 'mapId', label: '地图ID (mapId)' },
  { value: 'location', label: '所在位置 (location)' },
];
const modifyNumericFields = [
  'level', 'exp', 'hp', 'maxHp', 'shield', 'maxShield',
  'armor', 'maxArmor', 'attack', 'defense', 'speed', 'dodge',
  'hit', 'crit', 'critDmg', 'affinity', 'mapId',
];

const gmModify = ref({
  target: '',
  field: 'level',
  value: '',
  result: '',
});

/** 当前选中字段是否为数值型（用于输入提示） */
const modifyFieldValueIsNumber = computed(() => modifyNumericFields.includes(gmModify.value.field));

async function doModifyPlayer() {
  if (!gmModify.value.target || !gmModify.value.value) return;
  gmLoading.value = true;
  try {
    // 后端支持按用户名/昵称/QQ号/ID 解析目标玩家
    const res = await adminApi.modifyPlayer({
      target: String(gmModify.value.target).trim(),
      field: gmModify.value.field,
      value: String(gmModify.value.value),
    });
    gmModify.value.result = res.message || res.data || '修改成功！';
    setTimeout(() => (gmModify.value.result = ''), 3000);
  } catch (e) {
    gmModify.value.result = '修改失败：' + (e.response?.data?.message || e.message);
  } finally {
    gmLoading.value = false;
  }
}

const gmAnnouncement = ref({
  content: '',
  result: '',
});

// ---- 公告配图上传：选图后立即上传，以 Markdown 图片语法插入正文 ----
const annImgInput = ref(null);
const annUploading = ref(false);

/** 触发隐藏的图片选择器 */
function pickAnnImages() {
  annImgInput.value?.click();
}

/** 选择图片后上传，成功后把 ![](url) 追加到公告正文光标处（无光标则追加到末尾） */
async function onAnnImagesSelected(e) {
  const files = Array.from(e.target.files || []);
  // 清空 input 值，允许重复选择同一文件
  e.target.value = '';
  if (!files.length) return;
  annUploading.value = true;
  try {
    const res = await adminApi.uploadAnnouncementImage(files);
    const urls = res.data || [];
    if (!urls.length) throw new Error('未返回图片地址');
    const ta = gmAnnouncement.value.content;
    // Markdown 图片语法：括号内不能有空格，否则玩家端解析器不识别
    const snippet = urls.map((u) => `![](${u})`).join('\n');
    // 优先插入到 textarea 光标处，保持编辑体验
    const textareaEl = document.querySelector('.gm-tool-card .gm-field textarea');
    let pos = textareaEl && textareaEl.selectionStart != null ? textareaEl.selectionStart : -1;
    if (pos < 0 || pos > ta.length) pos = ta.length;
    const before = ta.slice(0, pos);
    const after = ta.slice(pos);
    const pad1 = before && !before.endsWith('\n') ? '\n' : '';
    const pad2 = after && !after.startsWith('\n') ? '\n' : '';
    gmAnnouncement.value.content = before + pad1 + snippet + pad2 + after;
  } catch (err) {
    alert('上传公告配图失败：' + (err.response?.data?.message || err.message));
  } finally {
    annUploading.value = false;
  }
}

async function doGiveItem() {
  if (!gmGiveItem.value.target || !gmGiveItem.value.itemName) return;
  gmLoading.value = true;
  try {
    const res = await adminApi.giveItem({
      target: gmGiveItem.value.target,
      itemName: gmGiveItem.value.itemName,
      quantity: gmGiveItem.value.quantity || 1,
    });
    gmGiveItem.value.result = res.message || '发放成功！';
    setTimeout(() => (gmGiveItem.value.result = ''), 3000);
  } catch (e) {
    gmGiveItem.value.result = '发放失败：' + (e.response?.data?.message || e.message);
  } finally {
    gmLoading.value = false;
  }
}

async function doSendAnnouncement() {
  if (!gmAnnouncement.value.content) return;
  gmLoading.value = true;
  try {
    const res = await adminApi.sendAnnouncement(gmAnnouncement.value.content);
    gmAnnouncement.value.result = res.message || '公告已发送！';
    gmAnnouncement.value.content = '';
    setTimeout(() => (gmAnnouncement.value.result = ''), 3000);
  } catch (e) {
    gmAnnouncement.value.result = '发送失败：' + (e.response?.data?.message || e.message);
  } finally {
    gmLoading.value = false;
  }
}

// ---- 反馈管理 ----
// 状态过滤按钮（数据驱动：value 为空串表示"全部"）
const feedbackStatusFilters = [
  { label: '全部', value: '' },
  { label: 'OPEN', value: 'OPEN' },
  { label: 'PROCESSING', value: 'PROCESSING' },
  { label: 'CLOSED', value: 'CLOSED' },
];
// 状态变更下拉的可选项
const feedbackStatusOptions = ['OPEN', 'PROCESSING', 'CLOSED'];
// 反馈分类的中文展示映射
const feedbackCategoryLabels = { general: '一般', bug: 'Bug 反馈', suggestion: '建议', other: '其他' };

const feedbackList = ref([]);
const feedbackTotal = ref(0);
const feedbackPage = ref(1);
const feedbackPageSize = 20; // 分页大小（与后端默认值一致）
const feedbackStatus = ref('');
const feedbackLoading = ref(false);

// 当前查看详情的工单（含完整消息列表）
const currentFeedback = ref(null);

// 回复输入与附件（上传后得到的 URL 列表）
const feedbackReplyText = ref('');
const feedbackReplyAttachments = ref([]);
const feedbackReplying = ref(false);
const feedbackReplyMsg = ref('');
const feedbackReplyError = ref(false);
const fbFileInput = ref(null);

/** 状态英文 → 中文展示文案 */
function statusLabel(s) {
  return { OPEN: '待处理', PROCESSING: '处理中', CLOSED: '已关闭' }[s] || s || '-';
}

/** 分类英文 → 中文展示文案 */
function categoryLabel(c) {
  return feedbackCategoryLabels[c] || c || '一般';
}

/**
 * 解析消息附件
 * 后端把附件数组以 JSON 字符串存储（attachments 字段），这里安全解析为数组。
 * @param {object} m 消息对象
 * @returns {string[]} 附件 URL 列表
 */
function attachmentList(m) {
  if (Array.isArray(m.attachments)) return m.attachments;
  try {
    const arr = JSON.parse(m.attachments || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 判断附件是否为图片（用于缩略图预览与下载链接分流） */
function isImage(url) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test((url || '').split('?')[0]);
}

/** 从附件 URL 提取文件名（用于非图片附件展示） */
function fileName(url) {
  const parts = (url || '').split('/');
  const name = parts[parts.length - 1] || '附件';
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * 拼接待访问的附件地址
 * 生产环境前端与后端同源，相对路径(/uploads/...)直接可用；
 * 开发环境(Vite)未代理 /uploads，需补上后端源地址(与 config.js 中 WS_URL 的约定一致)。
 */
function resolveUploadUrl(url) {
  if (import.meta.env.DEV && url && url.startsWith('/')) {
    return 'http://localhost:3333' + url;
  }
  return url;
}

/** 时间格式化：YYYY-MM-DD HH:mm */
function formatTime(t) {
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 加载反馈工单列表（带分页与状态过滤） */
async function loadFeedbackList(p) {
  feedbackLoading.value = true;
  try {
    const res = await feedbackApi.adminList({
      page: p,
      pageSize: feedbackPageSize,
      status: feedbackStatus.value || undefined,
    });
    feedbackPage.value = p;
    feedbackList.value = res.data.list;
    feedbackTotal.value = res.data.total;
  } catch (e) {
    alert('加载反馈列表失败：' + (e.response?.data?.message || e.message));
  } finally {
    feedbackLoading.value = false;
  }
}

/** 点击状态过滤按钮：切换过滤条件并回到第一页 */
function setFeedbackStatus(s) {
  feedbackStatus.value = s;
  loadFeedbackList(1);
}

/** 打开工单详情：先用列表项占位展示，再拉取完整消息列表 */
async function openFeedbackDetail(f) {
  currentFeedback.value = f;
  try {
    const res = await feedbackApi.detail(f.id);
    currentFeedback.value = res.data;
  } catch (e) {
    alert('加载反馈详情失败：' + (e.response?.data?.message || e.message));
  }
}

/** 关闭详情面板 */
function closeFeedbackDetail() {
  currentFeedback.value = null;
}

/** 管理员变更工单状态：更新详情与列表中的对应项 */
async function changeFeedbackStatus(s) {
  const fb = currentFeedback.value;
  if (!fb || !s || s === fb.status) return;
  try {
    const res = await feedbackApi.adminUpdateStatus(fb.id, s);
    fb.status = res.data.status;
    const item = feedbackList.value.find((x) => x.id === fb.id);
    if (item) item.status = res.data.status;
  } catch (e) {
    alert('更新状态失败：' + (e.response?.data?.message || e.message));
  }
}

/** 触发隐藏的文件选择器 */
function pickReplyFiles() {
  fbFileInput.value?.click();
}

/**
 * 处理从剪贴板粘贴的图片，自动上传并加入回复附件列表
 * 管理员在回复框中直接 Ctrl+V 粘贴截图，无需手动选择文件
 * @param {ClipboardEvent} e 粘贴事件
 */
async function handleReplyPasteImage(e) {
  if (!e.clipboardData) return;
  const items = Array.from(e.clipboardData.items || []);
  const files = items
    .filter((it) => it.kind === 'file' && it.type && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  try {
    const res = await feedbackApi.upload(files);
    feedbackReplyAttachments.value.push(...(res.data || []));
  } catch (err) {
    alert('粘贴图片上传失败：' + (err.response?.data?.message || err.message));
  }
}

/** 选择文件后上传附件，取回可访问 URL 加入待发送列表 */
async function onReplyFilesSelected(e) {
  const files = Array.from(e.target.files || []);
  // 清空 input 值，允许重复选择同一文件
  e.target.value = '';
  if (!files.length) return;
  try {
    const res = await feedbackApi.upload(files);
    const urls = res.data || [];
    feedbackReplyAttachments.value.push(...urls);
  } catch (err) {
    alert('上传附件失败：' + (err.response?.data?.message || err.message));
  }
}

/** 发送管理员回复：追加消息并同步更新列表中的最后消息预览 */
async function sendFeedbackReply() {
  const fb = currentFeedback.value;
  const content = feedbackReplyText.value.trim();
  if (!fb || !content) return;
  feedbackReplying.value = true;
  feedbackReplyError.value = false;
  try {
    const res = await feedbackApi.reply(fb.id, {
      content,
      attachments: feedbackReplyAttachments.value,
    });
    fb.messages.push(res.data);
    // 同步刷新列表项的"最后一条消息"预览与更新时间
    const item = feedbackList.value.find((x) => x.id === fb.id);
    if (item) {
      item.messages = [res.data];
      item.updatedAt = new Date().toISOString();
    }
    feedbackReplyText.value = '';
    feedbackReplyAttachments.value = [];
    feedbackReplyMsg.value = '回复已发送';
    setTimeout(() => (feedbackReplyMsg.value = ''), 2000);
  } catch (e) {
    feedbackReplyError.value = true;
    feedbackReplyMsg.value = '发送失败：' + (e.response?.data?.message || e.message);
  } finally {
    feedbackReplying.value = false;
  }
}

// 切换到"反馈管理"标签时自动加载数据
watch(tab, (v) => {
  if (v === 'feedback') loadFeedbackList(1);
});

// ---- 通用 ----
function goChat() { router.push('/chat'); }
function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  router.push('/login');
}

onMounted(async () => {
  // 校验是否为管理员；开发登录开启时（DEV_LOGIN_ENABLED=1）放行任意账号，方便本地调试
  const isAdminAccount = ['ADMIN', 'SUPER_ADMIN'].includes(user.value?.role);
  if (!isAdminAccount) {
    try {
      const res = await fetch(`${API_BASE}/auth/dev/status`);
      const data = await res.json();
      if (data?.data?.enabled !== true) {
        alert('没有管理员权限');
        router.push('/chat');
        return;
      }
    } catch {
      // 状态查询失败视为未开启开发登录
      alert('没有管理员权限');
      router.push('/chat');
      return;
    }
  }
  // 并行加载所有数据
  await Promise.allSettled([
    loadDashboard(),
    loadWorldLevel(),
    adminApi.listConfig().then((res) => { configs.value = res.data; }),
    loadUsers(1),
  ]);
});
</script>

<style scoped>
/* ===== 用户管理增强：在线状态点 / 玩家信息标签 / 时间列 ===== */
.online-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: middle;
}
.online-dot.on {
  background: #4ade80;
  box-shadow: 0 0 6px rgba(74, 222, 128, 0.8);
}
.online-dot.off {
  background: var(--muted-dark, #666);
}
.player-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
  background: rgba(139, 92, 246, 0.12);
  border: 1px solid rgba(139, 92, 246, 0.35);
  color: var(--text);
  margin: 1px 3px 1px 0;
  white-space: nowrap;
}
.player-tag.lv {
  color: var(--accent2);
  font-weight: 700;
}
.player-tag.loc {
  background: rgba(59, 130, 246, 0.12);
  border-color: rgba(59, 130, 246, 0.35);
}
.role-select,
.status-select {
  max-width: 110px;
}
.status-select option[value='BANNED'] {
  color: #f87171;
}
.time-cell {
  font-size: 12px;
  white-space: nowrap;
}
.time-sub {
  color: var(--muted);
  font-size: 11px;
  opacity: 0.85;
}

/* ===== 详情 / 编辑弹窗 ===== */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  animation: fadeInUp 0.2s ease-out;
}
.modal-box {
  width: min(760px, calc(100vw - 48px));
  max-height: 84vh;
  overflow-y: auto;
  background: var(--card, rgba(16, 16, 32, 0.96));
  border: 1px solid var(--glass-border, var(--border));
  border-radius: 14px;
  padding: 18px 20px;
  box-shadow: var(--glass-shadow, 0 8px 32px rgba(0, 0, 0, 0.45));
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.modal-head h3 {
  font-size: 16px;
  color: var(--text);
}
.modal-head small {
  font-weight: 400;
  margin-left: 6px;
}
.modal-close {
  background: none;
  border: none;
  color: var(--muted);
  font-size: 22px;
  cursor: pointer;
  line-height: 1;
}
.modal-close:hover {
  color: var(--text);
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px 16px;
}
.detail-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
}
.detail-item label {
  font-size: 11px;
  color: var(--muted);
}
.detail-item span {
  font-size: 13px;
  color: var(--text);
  word-break: break-all;
}
.qq-edit-input {
  background: rgba(10, 10, 26, 0.6);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  padding: 4px 8px;
  font-size: 13px;
  width: 100%;
}
.qq-edit-input:focus {
  outline: none;
  border-color: var(--accent);
}
.mono {
  font-family: monospace;
}
.muted {
  color: var(--muted);
}
.edit-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px 12px;
}
.edit-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
  color: var(--muted);
}
.edit-field input {
  background: rgba(10, 10, 26, 0.6);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  padding: 6px 9px;
  font-size: 13px;
}
.edit-field input:focus {
  outline: none;
  border-color: var(--accent);
}
.modal-foot {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.edit-result {
  font-size: 13px;
  color: #4ade80;
}
.edit-result.err {
  color: #f87171;
}

/* 管理后台基础样式已移至全局 styles.css，以下为"反馈管理"标签页专用样式 */

/* ===== 状态过滤按钮 ===== */
.fb-filters {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.fb-filter-btn {
  padding: 7px 16px;
  background: rgba(10, 10, 26, 0.6);
  border: 1px solid var(--border);
  border-radius: 20px;
  color: var(--muted);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s ease;
}
.fb-filter-btn:hover {
  color: var(--text);
  border-color: var(--accent);
}
.fb-filter-btn.active {
  color: #fff;
  background: var(--accent-gradient);
  border-color: transparent;
  box-shadow: 0 0 12px rgba(139, 92, 246, 0.3);
}

/* ===== 工单列表卡片 ===== */
.fb-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.fb-card {
  background: var(--glass-bg);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  padding: 14px 16px;
  cursor: pointer;
  transition: all 0.25s ease;
  animation: fadeInUp 0.25s ease-out;
}
.fb-card:hover {
  border-color: rgba(139, 92, 246, 0.4);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25), var(--shadow-glow);
  transform: translateY(-1px);
}
.fb-card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), var(--shadow-glow);
}
.fb-card-main {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.fb-ticket-no {
  color: var(--accent2);
  font-weight: 700;
  font-size: 13px;
  flex-shrink: 0;
}
.fb-title {
  flex: 1;
  min-width: 0;
  color: var(--text);
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-card-sub {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
  flex-wrap: wrap;
}
.fb-preview {
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-preview-empty {
  color: var(--muted-dark);
  font-style: italic;
}

/* ===== 状态标签（OPEN 红 / PROCESSING 黄 / CLOSED 绿） ===== */
.fb-status {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
  white-space: nowrap;
}
.fb-status.st-open {
  color: #f87171;
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.4);
}
.fb-status.st-processing {
  color: #facc15;
  background: rgba(234, 179, 8, 0.15);
  border: 1px solid rgba(234, 179, 8, 0.4);
}
.fb-status.st-closed {
  color: #4ade80;
  background: rgba(34, 197, 94, 0.15);
  border: 1px solid rgba(34, 197, 94, 0.4);
}
.fb-cat {
  color: var(--accent);
  font-size: 12px;
}

/* ===== 空态与分页 ===== */
.fb-empty {
  text-align: center;
  color: var(--muted-dark);
  padding: 40px 0;
  font-size: 13px;
}
.fb-pagination {
  margin-top: 16px;
}

/* ===== 详情面板（下方滑出） ===== */
.fb-detail {
  margin-top: 20px;
  background: var(--glass-bg);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--glass-border);
  border-radius: 14px;
  padding: 18px;
  animation: fadeInUp 0.3s ease-out;
  box-shadow: var(--glass-shadow);
}
.fb-detail-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}
.fb-detail-head h3 {
  font-size: 16px;
  color: var(--text);
  margin-bottom: 6px;
}
.fb-detail-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--muted);
  flex-wrap: wrap;
}

/* 状态变更栏 */
.fb-status-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid var(--glass-border);
  border-bottom: 1px solid var(--glass-border);
  margin-bottom: 14px;
  font-size: 13px;
  color: var(--muted);
}
.fb-status-bar select {
  padding: 6px 10px;
  background: rgba(10, 10, 26, 0.6);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-size: 13px;
  outline: none;
  transition: all 0.2s ease;
}
.fb-status-bar select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.15);
}

/* ===== 消息列表（气泡） ===== */
.fb-messages {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 420px;
  overflow-y: auto;
  padding: 4px;
  margin-bottom: 14px;
}
.fb-msg {
  max-width: 88%;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.6;
  animation: fadeInUp 0.25s ease-out;
}
.fb-msg.from-user {
  align-self: flex-start;
  background: rgba(6, 182, 212, 0.08);
  border: 1px solid rgba(6, 182, 212, 0.25);
  border-top-left-radius: 4px;
}
.fb-msg.from-admin {
  align-self: flex-end;
  background: rgba(139, 92, 246, 0.12);
  border: 1px solid rgba(139, 92, 246, 0.3);
  border-top-right-radius: 4px;
}
.fb-msg-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
  font-size: 12px;
}
.fb-msg-sender {
  font-weight: 600;
  color: var(--accent);
}
.fb-msg.from-admin .fb-msg-sender {
  color: #c084fc;
}
.fb-msg-time {
  color: var(--muted-dark);
  font-size: 11px;
  white-space: nowrap;
}
.fb-msg-content {
  color: var(--text);
  word-break: break-word;
  white-space: pre-wrap;
}

/* ===== 附件（图片缩略图 / 文件） ===== */
.fb-msg-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.fb-attach {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-decoration: none;
  border-radius: 8px;
  padding: 4px;
  border: 1px solid var(--glass-border);
  background: rgba(10, 10, 26, 0.5);
  transition: all 0.2s ease;
  max-width: 140px;
}
.fb-attach:hover {
  border-color: var(--accent);
  box-shadow: 0 0 10px rgba(139, 92, 246, 0.2);
}
.fb-attach-img {
  width: 120px;
  height: 90px;
  object-fit: cover;
  border-radius: 6px;
  display: block;
  background: var(--bg2);
}
.fb-attach-file {
  font-size: 11px;
  color: var(--accent2);
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ===== 回复区 ===== */
.fb-reply {
  border-top: 1px solid var(--glass-border);
  padding-top: 14px;
}
.fb-reply textarea {
  width: 100%;
  min-height: 80px;
  padding: 10px 12px;
  background: rgba(10, 10, 26, 0.6);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
  font-size: 13px;
  resize: vertical;
  outline: none;
  transition: all 0.2s ease;
}
.fb-reply textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.15);
}
.fb-reply-tools {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.fb-reply-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.fb-reply-attach {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  padding: 4px;
  background: rgba(10, 10, 26, 0.5);
}
.fb-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  line-height: 16px;
  border-radius: 50%;
  border: none;
  background: var(--danger);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
  opacity: 0.9;
  transition: all 0.15s ease;
}
.fb-remove:hover {
  opacity: 1;
  transform: scale(1.1);
}
.fb-reply-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.fb-reply-msg {
  margin-top: 8px;
  font-size: 12px;
  color: #4ade80;
  animation: fadeIn 0.3s ease;
}
.fb-reply-msg.error {
  color: #f87171;
}

/* ===== 公告编辑器：工具栏与实时预览 ===== */
.ann-editor-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.ann-editor-hint {
  font-size: 12px;
  color: var(--muted, #9ca3af);
}
.ann-preview {
  margin-top: 12px;
  border: 1px dashed var(--border, rgba(255, 255, 255, 0.15));
  border-radius: 10px;
  overflow: hidden;
}
.ann-preview-title {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--muted, #9ca3af);
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px dashed var(--border, rgba(255, 255, 255, 0.15));
}
/* 预览正文复用玩家端公告弹窗的渲染组件 */
.ann-preview-body {
  padding: 12px;
  font-size: 14px;
  line-height: 1.7;
  max-height: 260px;
  overflow-y: auto;
}
.ann-preview-body p {
  margin: 0 0 8px;
}
.ann-preview-body p:last-child {
  margin-bottom: 0;
}
.ann-preview-body .ann-link {
  color: #fbbf24;
  text-decoration: underline;
  word-break: break-all;
}
.ann-preview-body .ann-img {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  vertical-align: middle;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
}

/* ===== 移动端适配 ===== */
@media (max-width: 768px) {
  .fb-filters {
    gap: 6px;
  }
  .fb-filter-btn {
    padding: 6px 12px;
    font-size: 12px;
  }
  .fb-card {
    padding: 12px;
  }
  .fb-msg {
    max-width: 95%;
  }
  .fb-detail {
    padding: 14px;
  }
  .fb-detail-head {
    flex-direction: column;
  }
}
</style>