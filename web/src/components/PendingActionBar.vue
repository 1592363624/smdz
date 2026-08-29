<template>
  <!--
    进行中操作倒计时条：展示玩家身上所有「还需要 N 秒」的延时操作。
    数据源为后端 buildPlayerInfo 的 pendingActions 快照（REST 全量 + socket player:update 推送），
    剩余秒数/进度百分比由本地时钟逐秒计算，避免每帧请求后端。
  -->
  <div v-if="activeActions.length" class="pending-bar">
    <div
      v-for="a in activeActions"
      :key="a.key"
      class="pa-item"
      :class="['pa-kind-' + a.kind, { 'pa-done': remainOf(a) <= 0 }]"
    >
      <span class="pa-icon">{{ a.icon || '⏳' }}</span>
      <div class="pa-main">
        <div class="pa-line">
          <span class="pa-label">{{ a.label }}</span>
          <span v-if="a.detail" class="pa-detail">{{ a.detail }}</span>
          <span class="pa-spacer"></span>
          <span class="pa-remain">{{ remainOf(a) > 0 ? remainOf(a) + ' 秒' : '即将完成' }}</span>
        </div>
        <div class="pa-track">
          <div class="pa-fill" :style="{ width: percentOf(a) + '%' }"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
  // 后端 pendingActions 快照：[{ key, kind, label, detail, icon, startedAt, endAt, totalMs }]
  actions: { type: Array, default: () => [] },
});

// 有条目倒计时归零时通知父组件：后端延时结算有抖动（定时器/5 秒兜底扫描），
// 前端先本地隐藏，再由父组件拉一次最新状态把已结算的条目彻底清掉。
const emit = defineEmits(['expired']);

// 每秒触发一次重渲染的本地时钟（对齐增益倒计时的做法）
const now = ref(Date.now());
let timer = null;
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

// 过滤已到期的条目：后端延时结算有毫秒级抖动，前端先本地剔除避免残留
const activeActions = computed(() =>
  (props.actions || []).filter((a) => Number(a?.endAt || 0) > now.value),
);

watch(activeActions, (list, prev) => {
  if ((prev?.length || 0) > 0 && list.length < prev.length) emit('expired');
});

const remainOf = (a) => Math.max(0, Math.ceil((Number(a?.endAt || 0) - now.value) / 1000));

const percentOf = (a) => {
  const endAt = Number(a?.endAt || 0);
  const total = Number(a?.totalMs || 0);
  if (!endAt || total <= 0) return 0;
  const remain = Math.max(0, endAt - now.value);
  const done = total - remain;
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
};
</script>

<style scoped>
.pending-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-light);
  background: linear-gradient(90deg, rgba(139, 92, 246, 0.12), rgba(6, 182, 212, 0.08));
  flex-shrink: 0;
}

.pa-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pa-icon {
  font-size: 15px;
  line-height: 1;
  flex-shrink: 0;
  filter: drop-shadow(0 0 4px rgba(139, 92, 246, 0.6));
}

.pa-main {
  flex: 1;
  min-width: 0;
}

.pa-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  line-height: 1.4;
}

.pa-spacer {
  flex: 1;
}

.pa-label {
  color: var(--text);
  font-weight: 600;
  white-space: nowrap;
}

.pa-detail {
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pa-remain {
  color: var(--accent2);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.pa-track {
  margin-top: 3px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
}

.pa-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent-gradient);
  box-shadow: 0 0 8px rgba(139, 92, 246, 0.6);
  transition: width 0.9s linear;
}

/* 分类配色：让不同性质的等待一眼可辨 */
.pa-kind-gather .pa-remain {
  color: #fbbf24;
}
.pa-kind-gather .pa-fill {
  background: linear-gradient(90deg, #f59e0b, #fbbf24);
  box-shadow: 0 0 8px rgba(245, 158, 11, 0.6);
}
.pa-kind-move .pa-fill {
  background: linear-gradient(90deg, #06b6d4, #22d3ee);
  box-shadow: 0 0 8px rgba(6, 182, 212, 0.6);
}
.pa-kind-rescue .pa-remain,
.pa-kind-work .pa-remain {
  color: #4ade80;
}
.pa-kind-rescue .pa-fill,
.pa-kind-work .pa-fill {
  background: linear-gradient(90deg, #22c55e, #4ade80);
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.6);
}
.pa-kind-debuff .pa-remain {
  color: var(--danger);
}
.pa-kind-debuff .pa-fill {
  background: linear-gradient(90deg, #ef4444, #f87171);
  box-shadow: 0 0 8px rgba(239, 68, 68, 0.6);
}

.pa-done {
  opacity: 0.6;
}

@media (max-width: 768px) {
  .pending-bar {
    padding: 6px 10px;
  }
  .pa-line {
    font-size: 11px;
  }
}
</style>
