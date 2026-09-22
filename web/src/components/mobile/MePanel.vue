<template>
  <Teleport to="body">
    <Transition name="me">
      <div v-if="ui.meOpen" class="me-root">
        <div class="me-scrim" @click="close"></div>
        <section class="me-sheet" role="dialog" aria-label="我的">
          <span class="me-grabber" @click="close"></span>

          <header class="me-head">
            <div class="me-id">
              <span class="me-avatar" :class="{ 'is-admin': isAdmin }">
                <img v-if="user?.avatar" :src="user.avatar" class="me-avatar-img" alt="" />
                <span v-else>{{ avatarLetter }}</span>
              </span>
              <span class="me-idtext">
                <span v-if="!editingName" class="me-name" @click="startEditName">
                  {{ displayName }}<span class="me-name-pen">✏️</span>
                </span>
                <span v-else class="me-name-edit">
                  <input
                    v-model="nameInput"
                    class="me-name-input"
                    maxlength="20"
                    placeholder="新昵称"
                    @keyup.enter="saveName"
                    @keyup.esc="editingName = false"
                  />
                  <button class="me-mini ok" :disabled="nameBusy" @click="saveName">{{ nameBusy ? '…' : '保存' }}</button>
                  <button class="me-mini" @click="editingName = false">取消</button>
                </span>
                <span class="me-sub">
                  <span class="me-lv">Lv.{{ info?.level ?? '--' }}</span>
                  <span v-if="info?.type" class="me-fam">{{ info.type }}</span>
                  <span class="me-conn" :class="connected ? 'on' : 'off'">{{ connected ? '在线' : '重连中' }}</span>
                </span>
              </span>
            </div>
            <button class="me-close" type="button" aria-label="关闭" @click="close">✕</button>
          </header>

          <nav class="me-seg">
            <button
              v-for="s in segs"
              :key="s.key"
              class="me-seg-btn"
              :class="{ on: pane === s.key }"
              type="button"
              @click="switchPane(s.key)"
            >{{ s.icon }} {{ s.label }}</button>
          </nav>

          <div class="me-body">
            <!-- 角色：状态面板 + 常用指令（与桌面侧栏同一个组件，功能不缩水） -->
            <div v-show="pane === 'role'" class="me-pane">
              <PlayerStatusPanel
                v-if="info"
                :info="info"
                :nickname="displayName"
                @send="onSend"
              />
              <div v-else class="me-empty">正在同步角色数据…</div>
              <FavoriteCommands ref="favRef" @send="onSend" />
            </div>

            <!-- 地图：当前位置 / 子区域 / 全部地图 / 附近玩家，点格子直接传送 -->
            <div v-show="pane === 'map'" class="me-pane">
              <div v-if="mapOverview" class="mc-map">
                <div class="mc-here">📍 {{ mapOverview.currentMap?.name }}</div>
                <div v-if="mapOverview.subMaps?.length" class="mc-block">
                  <div class="mc-title">子区域</div>
                  <div class="mc-grid">
                    <button
                      v-for="m in mapOverview.subMaps"
                      :key="'sub-' + m.name"
                      class="mc-node"
                      type="button"
                      @click="go(m.name)"
                    >{{ m.name }}</button>
                  </div>
                </div>
                <div class="mc-block">
                  <div class="mc-title mc-fold" @click="allMapsCollapsed = !allMapsCollapsed">
                    <span class="mc-caret">{{ allMapsCollapsed ? '▶' : '▼' }}</span>
                    全部地图（{{ mapOverview.allMaps?.length || 0 }}）
                  </div>
                  <div v-show="!allMapsCollapsed" class="mc-grid">
                    <button
                      v-for="m in mapOverview.allMaps"
                      :key="'all-' + m.name"
                      class="mc-node"
                      :class="{ current: m.isCurrent, reachable: m.isReachable }"
                      type="button"
                      @click="go(m.name)"
                    >{{ m.name }}</button>
                  </div>
                </div>
              </div>
              <div v-else class="me-empty">地图数据加载中…</div>

              <div class="mc-block">
                <div class="mc-title">👥 附近玩家（{{ nearby.length }}）</div>
                <div v-if="nearby.length" class="mc-grid">
                  <button
                    v-for="p in nearby"
                    :key="'np-' + p.userId"
                    class="mc-node nearby"
                    :class="{ online: p.online }"
                    type="button"
                    @click="atPlayer(p)"
                  >{{ p.nickname || p.username }}<em v-if="!p.online">·离线</em></button>
                </div>
                <div v-else class="mc-none">当前区域暂无其他玩家</div>
              </div>
            </div>

            <!-- 行囊：背包/装备/属性等入口，全部走指令，与桌面端同源 -->
            <div v-show="pane === 'act'" class="me-pane">
              <div class="me-act-grid">
                <button v-for="a in acts" :key="a.cmd" class="me-act" type="button" @click="run(a.cmd)">
                  <span class="me-act-icon">{{ a.icon }}</span>
                  <span class="me-act-label">{{ a.label }}</span>
                </button>
              </div>
            </div>
          </div>

          <footer class="me-foot">
            <div class="me-foot-row">
              <button class="me-foot-btn" type="button" @click="openChatAction('settings')">🔧 设置</button>
              <button class="me-foot-btn" type="button" @click="openChatAction('updatelog')">📋 更新</button>
              <button v-if="showAdminEntry" class="me-foot-btn admin" type="button" @click="goto('/admin')">⚙️ 管理</button>
              <button class="me-foot-btn" type="button" @click="goto('/onboard')">🐾 使魔</button>
              <button class="me-foot-btn danger" type="button" @click="logout">退出</button>
            </div>
            <!-- 顶栏让给 HUD 后，反馈入口与外链挪到这里：手机主屏不该长着「版本 v0.9.0 / BUG 反馈 / 广告位」 -->
            <div class="me-foot-links">
              <a :href="GITHUB_ISSUES_URL" target="_blank" rel="noopener noreferrer">🐞 BUG 反馈</a>
              <span class="me-sep">·</span>
              <a href="http://xx.52shell.ltd" target="_blank" rel="noopener noreferrer">《重生之凡人修仙》</a>
            </div>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
/**
 * 手机端「我的」全屏底部抽屉（手游里的角色面板）。
 *
 * 取代原来的左侧滑出抽屉：左侧抽屉是网页后台的习惯，手游一律从底部升起、
 * 拇指往上推，且内容占满整屏（角色/地图/快捷操作分页）。
 * 组件挂在 App 级而不是 ChatView 里，所以在家园/前线/竞技场任意一屏都能直接唤起，
 * 不用先跳回公屏 —— 这是「像在玩一个 App」和「像在看一个网页」的分水岭。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PlayerStatusPanel from '../PlayerStatusPanel.vue';
import FavoriteCommands from '../FavoriteCommands.vue';
import { useUiStore } from '../../stores/ui';
import { usePlayerStore } from '../../stores/player';
import { useConnectionStore } from '../../stores/connection';
import { gameApi, userApi } from '../../api';
import { API_BASE, GITHUB_ISSUES_URL } from '../../config';
import { sendCommand, requestChatAction } from '../../utils/bus';
import { tapLight } from '../../utils/haptics';

const ui = useUiStore();
const playerStore = usePlayerStore();
const connection = useConnectionStore();
const router = useRouter();
const route = useRoute();

const segs = [
  { key: 'role', label: '角色', icon: '👤' },
  { key: 'map', label: '地图', icon: '🗺️' },
  { key: 'act', label: '快捷', icon: '⚡' },
];
const acts = [
  { icon: '🎒', label: '背包', cmd: '背包' },
  { icon: '📋', label: '信息', cmd: '信息' },
  { icon: '🗺️', label: '地图', cmd: '地图' },
  { icon: '⚔️', label: '攻击', cmd: '攻击' },
  { icon: '💰', label: '灵石', cmd: '灵石' },
  { icon: '🛒', label: '商店', cmd: '商店' },
  { icon: '🎁', label: '签到', cmd: '签到' },
  { icon: '📜', label: '任务', cmd: '任务' },
];

const pane = ref('role');
const favRef = ref(null);

const info = computed(() => playerStore.info);
const connected = computed(() => connection.connected);
const user = computed(() => {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null') || {};
  } catch {
    return {};
  }
});
const displayName = computed(() => user.value?.nickname || user.value?.username || '旅行者');
const avatarLetter = computed(() => (displayName.value || '?').trim().charAt(0).toUpperCase());
const isAdmin = computed(() => ['ADMIN', 'SUPER_ADMIN'].includes(user.value?.role));
const devLoginOn = ref(false);
const showAdminEntry = computed(() => isAdmin.value || devLoginOn.value);

/* ===== 昵称行内编辑 ===== */
const editingName = ref(false);
const nameInput = ref('');
const nameBusy = ref(false);
function startEditName() {
  tapLight();
  nameInput.value = displayName.value;
  editingName.value = true;
}
async function saveName() {
  const v = nameInput.value.trim();
  if (!v || nameBusy.value) return;
  nameBusy.value = true;
  try {
    await userApi.updateNickname(v);
    const u = { ...user.value, nickname: v };
    localStorage.setItem('user', JSON.stringify(u));
    ui.pushToast({ type: 'success', message: '昵称已更新' });
    editingName.value = false;
  } catch (e) {
    ui.pushToast({ type: 'error', message: e?.response?.data?.message || '修改失败' });
  } finally {
    nameBusy.value = false;
  }
}

/* ===== 地图数据（打开面板时才拉，切到地图页签再拉附近玩家） ===== */
const mapOverview = ref(null);
const nearby = ref([]);
const allMapsCollapsed = ref(true);
let mapLoadedAt = 0;

async function loadMap() {
  // 30 秒内不重复拉，避免反复开关面板打爆接口
  if (Date.now() - mapLoadedAt < 30000 && mapOverview.value) return;
  mapLoadedAt = Date.now();
  try {
    const res = await gameApi.mapOverview();
    mapOverview.value = res?.data ?? null;
  } catch {
    /* 静默：接口不可用时保留上次结果 */
  }
  try {
    const res = await gameApi.nearbyPlayers();
    nearby.value = Array.isArray(res?.data) ? res.data : [];
  } catch {
    /* 同上 */
  }
}

function switchPane(k) {
  tapLight();
  pane.value = k;
  if (k === 'map') loadMap();
}

/* ===== 指令投递：面板是 App 级常驻，socket 只在 ChatView 里，所以统一走 bus ===== */
function deliver(text) {
  const handled = sendCommand(text);
  if (!handled && route.path !== '/chat') router.push('/chat');
}

/* 下面所有「收面板 + 再做别的事」都必须过 ui.afterMeClosed：
   面板关闭时 store 会 history.back() 撤掉它压的返回靶子，
   同一拍里直接 router.push() 会被那次 popstate 顶回原页面（实测过：点了设置页面不动）。 */
function onSend(text) {
  ui.afterMeClosed(() => deliver(text));
}
function run(cmd) {
  tapLight();
  deliver(cmd);
}
function go(name) {
  tapLight();
  ui.afterMeClosed(() => deliver('go ' + name));
}
function atPlayer(p) {
  tapLight();
  ui.afterMeClosed(() => deliver('@' + (p.nickname || p.username) + ' '));
}

function close() {
  ui.closeMe();
}
function goto(path) {
  tapLight();
  ui.afterMeClosed(() => router.push(path));
}
function openChatAction(name) {
  tapLight();
  ui.afterMeClosed(() => {
    // 设置/更新记录弹窗的实现仍在 ChatView 里，先把人带回公屏页，动作会在那边排队等挂载
    if (route.path !== '/chat') router.push('/chat');
    requestChatAction(name);
  });
}
function logout() {
  tapLight();
  if (!confirm('确认退出登录？')) return;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  ui.afterMeClosed(() => router.push('/login'));
}

/** 与 ChatView 同源的开发登录开关查询：开着就把「管理」入口露出来（本地调试用） */
async function loadDevStatus() {
  try {
    const res = await fetch(`${API_BASE}/auth/dev/status`);
    const data = await res.json();
    devLoginOn.value = data?.data?.enabled === true || data?.enabled === true;
  } catch {
    devLoginOn.value = false;
  }
}
onMounted(loadDevStatus);

/* 打开时锁住底层页面滚动（抽屉内部自己滚），关闭时立刻解除，避免滚动位置泄漏到其它页 */
watch(
  () => ui.meOpen,
  (open) => {
    document.body.classList.toggle('me-open', open);
    if (!open) return;
    tapLight();
    loadMap();
    nextTick(() => favRef.value?.loadFavorites?.());
  },
);
</script>

<style scoped>
/* 锁滚动必须写在非 scoped 之外才能命中 body：这里用全局块 */
</style>

<style>
body.me-open {
  overflow: hidden;
  overscroll-behavior: none;
}
</style>

<style scoped>
.me-root {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  /* 只盖到底栏上沿：底栏保持可见可点，玩家可以不关面板直接切去家园/竞技场。
     手游的底部抽屉一律让主导航常驻，遮满整屏反而像网页弹窗。 */
  bottom: calc(var(--mtb-h, 58px) + var(--safe-bottom, 0px));
  z-index: 600;
  display: flex;
  align-items: flex-end;
}
.me-scrim {
  position: absolute;
  inset: 0;
  background: rgba(4, 4, 14, 0.68);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}
.me-sheet {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
  /* 高度即 .me-root 的整个可用区：上沿已经留出了 HUD，不必再自己算减法 */
  height: 100%;
  background: linear-gradient(180deg, #1b1540 0%, #120f28 22%, #0b0a1e 100%);
  border: 1px solid rgba(139, 92, 246, 0.32);
  border-bottom: 0;
  border-radius: 20px 20px 0 0;
  box-shadow: 0 -14px 44px rgba(0, 0, 0, 0.66);
  overflow: hidden;
}
.me-grabber {
  flex: 0 0 auto;
  width: 42px;
  height: 4px;
  margin: 8px auto 2px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
  cursor: pointer;
}
.me-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 14px 10px;
}
.me-id {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}
.me-avatar {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  font-size: 20px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(145deg, #8b5cf6, #06b6d4);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.14) inset, 0 4px 14px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.me-avatar.is-admin {
  background: linear-gradient(145deg, #f59e0b, #ef4444);
}
.me-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.me-idtext {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.me-name {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
  max-width: 58vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.me-name-pen {
  font-size: 11px;
  opacity: 0.45;
}
.me-name-edit {
  display: flex;
  align-items: center;
  gap: 6px;
}
.me-name-input {
  width: 120px;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(6, 8, 24, 0.7);
  color: var(--text);
  /* 16px：iOS 小于此值聚焦会自动放大整页 */
  font-size: 16px;
}
.me-mini {
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-light);
  background: rgba(139, 92, 246, 0.1);
  color: var(--text);
  font-size: 12px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.me-mini.ok {
  background: var(--accent-gradient);
  border-color: transparent;
  color: #fff;
  font-weight: 600;
}
.me-mini:active { transform: scale(0.94); }
.me-sub {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  color: var(--muted);
}
.me-lv { color: #fbbf24; font-weight: 700; }
.me-fam {
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(6, 182, 212, 0.16);
  border: 1px solid rgba(6, 182, 212, 0.34);
  color: #67e8f9;
  font-weight: 600;
}
.me-conn.on { color: var(--success); }
.me-conn.off { color: var(--danger); }
.me-close {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid var(--border-light);
  background: rgba(255, 255, 255, 0.05);
  color: var(--muted);
  font-size: 16px;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.me-close:active { transform: scale(0.9); color: #fff; }

.me-seg {
  flex: 0 0 auto;
  display: flex;
  gap: 4px;
  margin: 0 14px 8px;
  padding: 3px;
  border-radius: 11px;
  background: rgba(6, 8, 24, 0.6);
  border: 1px solid var(--glass-border);
}
.me-seg-btn {
  flex: 1 1 0;
  padding: 8px 4px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--muted);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: all 0.18s ease;
}
.me-seg-btn.on {
  color: #fff;
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.9), rgba(6, 182, 212, 0.65));
  box-shadow: 0 2px 12px rgba(139, 92, 246, 0.35);
}
.me-seg-btn:active { transform: scale(0.97); }

.me-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  padding: 0 14px 12px;
}
.me-pane { display: flex; flex-direction: column; gap: 10px; }
.me-empty {
  padding: 18px 0;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
}

.mc-map { display: flex; flex-direction: column; gap: 8px; }
.mc-here {
  padding: 9px 12px;
  border-radius: 10px;
  background: rgba(139, 92, 246, 0.12);
  border: 1px solid var(--border-light);
  font-size: 13px;
  font-weight: 600;
  color: #ddd6fe;
}
.mc-block { display: flex; flex-direction: column; gap: 6px; }
.mc-title { font-size: 11.5px; color: var(--muted); font-weight: 600; }
.mc-fold { cursor: pointer; display: flex; align-items: center; gap: 5px; min-height: 30px; }
.mc-caret { font-size: 9px; }
.mc-none { font-size: 11.5px; color: var(--muted-dark); }
.mc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: 6px;
}
.mc-node {
  padding: 10px 6px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: rgba(10, 10, 26, 0.55);
  color: var(--text-secondary);
  font-size: 11.5px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: all 0.15s ease;
}
.mc-node:active { transform: scale(0.95); }
.mc-node.reachable { border-color: rgba(34, 197, 94, 0.5); color: #86efac; }
.mc-node.current {
  border-color: var(--accent);
  background: rgba(139, 92, 246, 0.22);
  color: #fff;
  font-weight: 700;
}
.mc-node.nearby em { font-style: normal; opacity: 0.55; margin-left: 2px; font-size: 10px; }
.mc-node.nearby.online { border-color: rgba(34, 197, 94, 0.4); }

.me-act-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.me-act {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 62px;
  border-radius: 12px;
  border: 1px solid var(--border-light);
  background: linear-gradient(160deg, rgba(139, 92, 246, 0.14), rgba(6, 182, 212, 0.06));
  color: var(--text);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: transform 0.12s ease, box-shadow 0.2s ease;
}
.me-act:active {
  transform: scale(0.94);
  box-shadow: 0 0 16px rgba(139, 92, 246, 0.4) inset;
}
.me-act-icon { font-size: 21px; line-height: 1; }
.me-act-label { font-size: 11px; font-weight: 600; }

.me-foot {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px 8px;
  border-top: 1px solid var(--glass-border);
  background: rgba(8, 8, 22, 0.72);
}
.me-foot-row {
  display: flex;
  gap: 6px;
}
.me-foot-links {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 11px;
}
.me-foot-links a {
  color: var(--muted);
  text-decoration: none;
  padding: 4px 6px;
  -webkit-tap-highlight-color: transparent;
}
.me-foot-links a:active {
  color: var(--accent2, #06b6d4);
}
.me-sep {
  color: var(--muted-dark);
}
.me-foot-btn {
  flex: 1 1 0;
  min-height: 40px;
  padding: 0 4px;
  border-radius: 10px;
  border: 1px solid var(--border-light);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.me-foot-btn:active { transform: scale(0.96); }
.me-foot-btn.admin { border-color: rgba(251, 191, 36, 0.5); color: #fbbf24; }
.me-foot-btn.danger { border-color: rgba(239, 68, 68, 0.45); color: #fca5a5; }

/* 升起 / 落下：抽屉从底部推入，比左侧滑出更贴近手游面板手感 */
.me-enter-active, .me-leave-active {
  transition: opacity 0.2s ease;
}
.me-enter-active .me-sheet, .me-leave-active .me-sheet {
  transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.me-enter-from, .me-leave-to { opacity: 0; }
.me-enter-from .me-sheet, .me-leave-to .me-sheet { transform: translateY(100%); }
</style>
