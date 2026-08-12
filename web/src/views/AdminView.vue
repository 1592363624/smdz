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
              <th>QQ号</th>
              <th>角色</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <td>{{ u.id }}</td>
              <td>{{ u.username }}</td>
              <td>
                <input class="inline-input" :value="u.nickname" @change="updateUser(u, { nickname: $event.target.value })" />
              </td>
              <td>{{ u.qqNumber || '-' }}</td>
              <td>
                <select :value="u.role" @change="updateUser(u, { role: $event.target.value })">
                  <option value="USER">USER</option>
                  <option value="ADMIN">ADMIN</option>
                  <option value="SUPER_ADMIN">SUPER_ADMIN</option>
                </select>
              </td>
              <td>
                <select :value="u.status" @change="updateUser(u, { status: $event.target.value })">
                  <option value="ACTIVE">正常</option>
                  <option value="BANNED">封禁</option>
                </select>
              </td>
              <td>
                <span v-if="savedUser === u.id" class="saved-badge">✓</span>
              </td>
            </tr>
          </tbody>
        </table>

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

          <!-- 发送全服公告 -->
          <div class="gm-tool-card">
            <h3>📢 发送全服公告</h3>
            <div class="gm-field">
              <label>公告内容</label>
              <textarea v-model="gmAnnouncement.content" placeholder="输入要发送给所有玩家的公告内容..."></textarea>
            </div>
            <button class="gm-btn danger" @click="doSendAnnouncement" :disabled="gmLoading">发送公告</button>
            <p v-if="gmAnnouncement.result" class="gm-result">{{ gmAnnouncement.result }}</p>
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
 */
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { adminApi } from '../api';

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

// ---- GM 工具 ----
const gmLoading = ref(false);

const gmGiveItem = ref({
  target: '',
  itemName: '',
  quantity: 1,
  result: '',
});

const gmAnnouncement = ref({
  content: '',
  result: '',
});

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

// ---- 通用 ----
function goChat() { router.push('/chat'); }
function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  router.push('/login');
}

onMounted(async () => {
  // 校验是否为管理员
  if (!['ADMIN', 'SUPER_ADMIN'].includes(user.value?.role)) {
    alert('没有管理员权限');
    router.push('/chat');
    return;
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
/* 管理后台样式已移至全局 styles.css */
</style>