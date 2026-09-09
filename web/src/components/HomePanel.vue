<template>
  <div class="home-panel">
    <!-- 加载/错误态 -->
    <div v-if="loading && !data" class="hm-hint">家园数据加载中...</div>
    <div v-else-if="error && !data" class="hm-hint hm-err">{{ error }}</div>

    <template v-else-if="data">
      <!-- 未建成/无地图：引导走文本指令 -->
      <div v-if="data.blocked" class="hm-hint">🏠 {{ data.blocked }}<br /><span class="hm-dim">发送「家园」查看建造进度</span></div>

      <template v-else>
        <!-- 顶部状态条：电力 / 生产模式 / 燃料倒计时 / 距上次观测 -->
        <div class="hm-status">
          <span class="hm-badge" :class="data.hasPower ? 'ok' : 'bad'">{{ data.hasPower ? '⚡ 有电' : '⛔ 无电' }}</span>
          <span class="hm-badge" :class="{ over: data.overloaded }">{{ data.overloaded ? '🔥 超载' : '标准' }}</span>
          <span class="hm-stat">⏱ 燃料可支撑 <b>{{ fmtDuration(data.remainingFuelSeconds) }}</b></span>
          <span class="hm-stat">距上次观测 <b>{{ fmtDuration(data.elapsedSeconds) }}</b></span>
        </div>
        <div v-if="!data.hasPower" class="hm-nopower">电力不足，建筑生产停止——检查电站与燃料</div>
        <div v-if="data.worldSimulation" class="hm-ai">🤖 {{ data.worldSimulation.text }}</div>

        <!-- 预计领取：现在发「产出」能拿到的全部物品（与结算同一套公式的投影） -->
        <div class="hm-section" v-if="claimList.length">
          <div class="hm-sec-title">🎁 预计领取<span class="hm-count">{{ claimList.length }}</span></div>
          <div class="hm-chips">
            <span v-for="g in claimList" :key="'g-' + g.name" class="hm-chip gain">+{{ g.name }} ×{{ fmt(g.quantity) }}</span>
          </div>
        </div>
        <div class="hm-section" v-else-if="data.hasPower">
          <div class="hm-sec-title">🎁 预计领取</div>
          <div class="hm-hint">暂无可领取产出</div>
        </div>

        <!-- 每日速率：贸易按每日产出 2% 结算，这里直接看速率 -->
        <div class="hm-section" v-if="data.dailyOutput.length">
          <div class="hm-sec-title">📈 每日产出速率<span class="hm-count">{{ data.dailyOutput.length }}</span></div>
          <div class="hm-chips">
            <span v-for="d in data.dailyOutput" :key="'d-' + d.name" class="hm-chip rate">{{ d.name }} {{ fmt(d.quantity) }}/天</span>
          </div>
        </div>

        <!-- 设备卡片：建筑+作物（含优先级与每分钟投入/产出口径） -->
        <div class="hm-section" v-if="data.producers.length">
          <div class="hm-sec-title">🏭 设备<span class="hm-count">{{ data.producers.length }}</span></div>
          <div class="hm-dev-grid">
            <div v-for="(p, i) in data.producers" :key="'p-' + p.name + '-' + i" class="hm-dev">
              <div class="hm-dev-head">
                <span class="hm-dev-name">{{ p.name }}</span>
                <span class="hm-dev-meta">×{{ p.count }}<i class="hm-pri">P{{ p.priority }}</i></span>
              </div>
              <div class="hm-dev-outs">
                <span
                  v-for="(o, oi) in p.outputs"
                  :key="'o-' + i + '-' + oi"
                  class="hm-out"
                  :class="o.quantity >= 0 ? 'gain' : 'cost'"
                >{{ o.quantity >= 0 ? '+' : '−' }}{{ o.name }} {{ fmt(Math.abs(o.quantity)) }}/分</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 库存（产出存放地）：默认收起，hover-to-expand 风格的折叠区 -->
        <div class="hm-section" v-if="data.storage.length">
          <button type="button" class="hm-sec-title hm-toggle" @click="storageOpen = !storageOpen">
            📦 产出存放地<span class="hm-count">{{ data.storage.length }}</span>
            <span class="hm-arrow" :class="{ open: storageOpen }">▸</span>
          </button>
          <div v-show="storageOpen" class="hm-chips">
            <span v-for="(s, i) in data.storage" :key="'s-' + s.name + '-' + i" class="hm-chip stock">{{ s.name }} ×{{ fmt(s.quantity) }}</span>
          </div>
        </div>

        <!-- 操作：与 QQ「产出」同一指令通道，结果见聊天流；无电也可领（宠物蛋/垃圾仍产出） -->
        <button type="button" class="hm-collect" @click="emit('action', '产出')">
          🎁 一键领取（发送「产出」）
        </button>
        <div class="hm-foot">预览不结算：看面板不会推进观测时间，产出保留在 QQ/网页任一端领取</div>
      </template>
    </template>
  </div>
</template>

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue';
import { homeApi } from '../api';

/**
 * 家园面板（GET /game/home/overview 只读 DTO 消费端）。
 * 数据自取：仅在本 Tab 激活时拉取 + 45s 轮询（懒结算模型无后台 tick，
 * 面板数据只在领取/交互后变化，轮询只为捕捉「在别处领过产出」后的状态刷新）。
 * 「一键领取」不走新端点：emit action 由 ChatView 转发到统一聊天指令通道（sendChatMessage），
 * 与 QQ「产出」完全同一条路径——统一调用约定，零双路径。
 */
const props = defineProps({
  active: { type: Boolean, default: false },
});
const emit = defineEmits(['action']);

const data = ref(null);
const loading = ref(false);
const error = ref('');
const storageOpen = ref(false);
let timer = null;

async function refresh() {
  loading.value = true;
  try {
    const res = await homeApi.overview();
    data.value = res?.data ?? null;
    error.value = '';
  } catch (e) {
    error.value = e?.response?.data?.message || '家园数据加载失败';
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.active,
  (on) => {
    if (on) {
      refresh();
      if (!timer) timer = setInterval(refresh, 45000);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

// 预计领取 = 直接产出 + 按优先级结算的正产出（与文本渲染「获得XxY」同源）
const claimList = ref([]);
function rebuildClaim() {
  const list = Array.isArray(data.value?.gains) ? data.value.gains : [];
  claimList.value = list.filter((g) => Number(g.quantity) > 0);
}
watch(data, rebuildClaim, { immediate: true });

// 展示口径：<0.01 保留 4 位小数（蛋糕/垃圾量级），其余两位封顶，杜绝浮点尾巴
function fmt(v) {
  const n = Number(v) || 0;
  const abs = Math.abs(n);
  if (abs >= 100) return String(Math.round(n));
  if (abs >= 0.01 || abs === 0) return String(Math.round(n * 100) / 100);
  return String(Math.round(n * 10000) / 10000);
}
function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}时${m}分` : `${m}分`;
}
</script>

<style scoped>
.home-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
}
.hm-hint {
  color: var(--muted);
  line-height: 1.7;
  padding: 8px;
  text-align: center;
}
.hm-err {
  color: #f87171;
}
.hm-dim {
  opacity: 0.7;
  font-size: 11px;
}
.hm-status {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.hm-badge {
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg3);
  font-size: 11px;
  white-space: nowrap;
}
.hm-badge.ok {
  color: #4ade80;
  border-color: rgba(74, 222, 128, 0.4);
}
.hm-badge.bad {
  color: #f87171;
  border-color: rgba(248, 113, 113, 0.4);
}
.hm-badge.over {
  color: #fb923c;
  border-color: rgba(251, 146, 60, 0.45);
}
.hm-stat {
  color: var(--muted);
  white-space: nowrap;
}
.hm-stat b {
  color: var(--text, #e5e7eb);
  font-weight: 600;
}
.hm-nopower {
  color: #f87171;
  background: rgba(248, 113, 113, 0.08);
  border: 1px solid rgba(248, 113, 113, 0.3);
  border-radius: 8px;
  padding: 6px 8px;
  line-height: 1.6;
}
.hm-ai {
  color: var(--accent2, #06b6d4);
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 8px;
}
.hm-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hm-sec-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
}
.hm-count {
  color: var(--accent, #8b5cf6);
  background: var(--bg3);
  border-radius: 8px;
  padding: 0 6px;
  font-size: 10px;
}
.hm-toggle {
  background: none;
  border: none;
  cursor: pointer;
  width: 100%;
  text-align: left;
  font: inherit;
  color: inherit;
}
.hm-arrow {
  margin-left: auto;
  transition: transform 0.15s;
}
.hm-arrow.open {
  transform: rotate(90deg);
}
.hm-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.hm-chip {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--bg3);
  border: 1px solid var(--border);
  white-space: nowrap;
  font-size: 11px;
}
.hm-chip.gain {
  color: #4ade80;
  border-color: rgba(74, 222, 128, 0.35);
}
.hm-chip.rate {
  color: var(--accent2, #06b6d4);
}
.hm-chip.stock {
  color: var(--muted);
}
.hm-dev-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.hm-dev {
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.hm-dev-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 4px;
}
.hm-dev-name {
  color: var(--text, #e5e7eb);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hm-dev-meta {
  color: var(--muted);
  white-space: nowrap;
}
.hm-pri {
  font-style: normal;
  color: var(--accent, #8b5cf6);
  margin-left: 4px;
  font-size: 10px;
}
.hm-dev-outs {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hm-out {
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hm-out.gain {
  color: #4ade80;
}
.hm-out.cost {
  color: #f87171;
}
.hm-collect {
  margin-top: 2px;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid rgba(139, 92, 246, 0.45);
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.18), rgba(6, 182, 212, 0.14));
  color: var(--text, #e5e7eb);
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.15s;
}
.hm-collect:hover:not(:disabled) {
  filter: brightness(1.25);
}
.hm-collect:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.hm-foot {
  color: var(--muted);
  font-size: 10px;
  text-align: center;
  line-height: 1.6;
}
</style>
