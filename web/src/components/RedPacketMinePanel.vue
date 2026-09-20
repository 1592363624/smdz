<template>
  <!-- 「我的红包」面板：发出 / 领到 / 退回明细（Teleport 到 body，避免被悬浮窗裁剪） -->
  <Teleport to="body">
    <div class="rpm-overlay" @click.self="emit('close')">
      <div class="rpm-modal">
        <header class="rpm-head">
          <h3>🧾 我的红包</h3>
          <div class="rpm-head-actions">
            <button type="button" class="rpm-icon-btn" title="刷新" :disabled="loading" @click="load">
              ⟳
            </button>
            <button type="button" class="rpm-icon-btn" title="关闭" @click="emit('close')">✕</button>
          </div>
        </header>

        <!-- 分类页签：数量为 0 时不显示角标 -->
        <div class="rpm-tabs">
          <button
            v-for="item in TABS"
            :key="item.key"
            type="button"
            class="rpm-tab"
            :class="{ active: tab === item.key }"
            @click="tab = item.key"
          >
            <span class="rpm-tab-label">{{ item.icon }} {{ item.label }}</span>
            <em v-if="rowsOf(item.key).length" class="rpm-tab-count">{{ rowsOf(item.key).length }}</em>
          </button>
        </div>

        <div class="rpm-body">
          <div v-if="loading" class="rpm-empty">加载中…</div>
          <div v-else-if="!rows.length" class="rpm-empty">{{ activeTab.empty }}</div>

          <template v-else>
            <!-- ① 我发出的红包 -->
            <template v-if="tab === 'sent'">
              <div v-for="row in rows" :key="'s-' + row.id" class="rpm-card">
                <span class="rpm-icon">{{ typeMeta(row.packetType).icon }}</span>
                <div class="rpm-main">
                  <div class="rpm-title">
                    <span class="rpm-type">{{ typeMeta(row.packetType).label }}</span>
                    <span class="rpm-badge" :class="statusMeta(row).cls">{{ statusMeta(row).text }}</span>
                  </div>
                  <div class="rpm-sub">{{ row.summary || '道具红包' }}</div>
                  <div v-if="row.targetUserName" class="rpm-sub rpm-target">
                    仅 <strong>{{ row.targetUserName }}</strong> 可领
                  </div>
                  <div v-if="row.greeting" class="rpm-greeting">“{{ row.greeting }}”</div>
                  <div class="rpm-meta">
                    已领 {{ row.claimedCount }}/{{ row.totalCount }} 份 · {{ formatTime(row.createdAt) }}
                  </div>
                  <div v-if="row.status === 'EXPIRED'" class="rpm-refund">
                    ↩ 已退回：{{ row.remainingSummary || '（无剩余）' }}
                  </div>
                  <div v-else-if="row.remainingSummary" class="rpm-remain">
                    剩余未领：{{ row.remainingSummary }}
                  </div>
                </div>
              </div>
            </template>

            <!-- ② 我领到的红包 -->
            <template v-else-if="tab === 'claimed'">
              <div v-for="(row, i) in rows" :key="'c-' + row.packetId + '-' + i" class="rpm-card">
                <span class="rpm-icon">{{ typeMeta(row.packetType).icon }}</span>
                <div class="rpm-main">
                  <div class="rpm-title">
                    <span class="rpm-picked">{{ row.itemName }}×{{ row.quantity }}</span>
                    <span class="rpm-badge ok">已入背包</span>
                  </div>
                  <div class="rpm-sub">来自 {{ row.from }}</div>
                  <div v-if="row.greeting" class="rpm-greeting">“{{ row.greeting }}”</div>
                  <div class="rpm-meta">{{ formatTime(row.createdAt) }}</div>
                </div>
              </div>
            </template>

            <!-- ③ 过期退回明细 -->
            <template v-else>
              <div v-for="row in rows" :key="'r-' + row.packetId" class="rpm-card">
                <span class="rpm-icon">↩</span>
                <div class="rpm-main">
                  <div class="rpm-title">
                    <span class="rpm-type">{{ typeMeta(row.packetType).label }}红包</span>
                    <span class="rpm-badge warn">已退回</span>
                  </div>
                  <div class="rpm-sub">退回道具：{{ row.remainingSummary || '（无剩余）' }}</div>
                  <div v-if="row.greeting" class="rpm-greeting">“{{ row.greeting }}”</div>
                  <div class="rpm-meta">
                    被领 {{ row.claimedCount }}/{{ row.totalCount }} 份 · 退回时间 {{ formatTime(row.refundedAt) }}
                  </div>
                </div>
              </div>
            </template>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
/**
 * 「我的红包」面板：展示发出 / 领到 / 退回三个维度的记录，数据全部来自 GET /api/chat/redpacket/mine。
 * 发出含进度与剩余未领，已过期项显示当时退回的道具明细；领到记录来源玩家/道具/时间。
 */
import { computed, onMounted, ref } from 'vue';
import { chatApi } from '../api';

const props = defineProps({
  /** 是否已连接 Socket.IO（未连接时不允许刷新，避免无效请求） */
  connected: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'notify']);

/** 页签定义（empty 为空态文案） */
const TABS = [
  { key: 'sent', icon: '🧧', label: '发出的', empty: '还没有发过红包' },
  { key: 'claimed', icon: '🎁', label: '领到的', empty: '还没有领到过红包' },
  { key: 'refunds', icon: '↩', label: '退回', empty: '没有过期的红包' },
];

const tab = ref('sent');
const loading = ref(false);
const data = ref({ sent: [], claimed: [], refunds: [] });

/** 当前页签的数据行 */
const rows = computed(() => rowsOf(tab.value));
/** 当前页签定义（空态文案用） */
const activeTab = computed(() => TABS.find((item) => item.key === tab.value) || TABS[0]);

/** 取某个页签的数据行 */
function rowsOf(key) {
  return data.value?.[key] || [];
}

/** 拉取我的红包数据（打不开面板时给个 toast，避免用户以为面板坏了） */
async function load() {
  loading.value = true;
  try {
    const res = await chatApi.getMyRedPackets();
    data.value = res.data || { sent: [], claimed: [], refunds: [] };
  } catch {
    emit('notify', { type: 'error', message: '红包记录加载失败，请稍后重试' });
  } finally {
    loading.value = false;
  }
}

/** 玩法 → 图标与文案 */
function typeMeta(packetType) {
  if (packetType === 'TARGET') return { icon: '🎯', label: '专属' };
  if (packetType === 'PASSCODE') return { icon: '🔑', label: '口令' };
  return { icon: '🧧', label: '普通' };
}

/** 发出红包的状态徽章（可领取 / 已抢完 / 已过期退回） */
function statusMeta(row) {
  if (row.status === 'EXPIRED') return { text: '已过期退回', cls: 'warn' };
  if (row.status === 'FINISHED') return { text: '已抢完', cls: 'ok' };
  if (row.expired) return { text: '已过期退回', cls: 'warn' };
  return { text: '可领取', cls: 'live' };
}

/** 时间格式化：MM-DD HH:mm（跨年则带上年份） */
function formatTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getFullYear() === new Date().getFullYear() ? `${md} ${hm}` : `${date.getFullYear()}-${md} ${hm}`;
}

// 打开即加载；未连接时仍可看缓存（首次会失败并提示）
onMounted(() => {
  if (props.connected) load();
  else emit('notify', { type: 'error', message: '未连接服务器，暂时无法加载红包记录' });
});
</script>

<style scoped>
.rpm-overlay {
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
.rpm-modal {
  width: min(420px, calc(100vw - 32px));
  max-height: min(600px, calc(100vh - 64px));
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  border: 1px solid var(--border-light);
  background: rgba(24, 20, 46, 0.98);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}
.rpm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.rpm-head h3 {
  margin: 0;
  font-size: 14px;
  color: var(--text);
}
.rpm-head-actions {
  display: flex;
  gap: 2px;
}
.rpm-icon-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.rpm-icon-btn:hover:not(:disabled) {
  background: rgba(139, 92, 246, 0.15);
  color: var(--text);
}
.rpm-icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 页签 */
.rpm-tabs {
  display: flex;
  gap: 6px;
  padding: 10px 14px 0;
}
.rpm-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 30px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: rgba(10, 10, 26, 0.55);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.rpm-tab.active {
  border-color: rgba(251, 191, 36, 0.6);
  background: rgba(251, 191, 36, 0.12);
  color: #fbbf24;
  font-weight: 600;
}
.rpm-tab-count {
  font-style: normal;
  font-size: 10px;
  opacity: 0.8;
}

/* 列表 */
.rpm-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.rpm-empty {
  padding: 32px 0;
  text-align: center;
  font-size: 12px;
  color: var(--muted-dark);
}
.rpm-card {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(10, 10, 26, 0.55);
}
.rpm-icon {
  flex-shrink: 0;
  font-size: 20px;
  line-height: 1.2;
}
.rpm-main {
  flex: 1;
  min-width: 0;
}
.rpm-title {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rpm-type {
  font-size: 12px;
  font-weight: 700;
  color: #fecaca;
}
.rpm-picked {
  font-size: 12.5px;
  font-weight: 700;
  color: #fbbf24;
}
.rpm-badge {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  border: 1px solid transparent;
}
.rpm-badge.live {
  color: #34d399;
  border-color: rgba(52, 211, 153, 0.5);
  background: rgba(52, 211, 153, 0.12);
}
.rpm-badge.ok {
  color: var(--muted);
  border-color: var(--border);
}
.rpm-badge.warn {
  color: #fbbf24;
  border-color: rgba(251, 191, 36, 0.5);
  background: rgba(251, 191, 36, 0.1);
}
.rpm-sub {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--text-secondary);
  word-break: break-all;
}
.rpm-target strong {
  color: #fbbf24;
}
.rpm-greeting {
  margin-top: 3px;
  font-size: 11px;
  color: #fcd34d;
  word-break: break-all;
}
.rpm-meta {
  margin-top: 4px;
  font-size: 10.5px;
  color: var(--muted);
}
.rpm-refund {
  margin-top: 4px;
  font-size: 11px;
  color: #fbbf24;
  word-break: break-all;
}
.rpm-remain {
  margin-top: 4px;
  font-size: 11px;
  color: var(--muted);
  word-break: break-all;
}
</style>
