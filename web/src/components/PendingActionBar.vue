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
      :class="['pa-kind-' + a.kind, { 'pa-done': a.remain <= 0 }]"
    >
      <span class="pa-icon">{{ a.icon || '⏳' }}</span>
      <div class="pa-main">
        <div class="pa-line">
          <span class="pa-label">{{ a.label }}</span>
          <span v-if="a.detail" class="pa-detail">{{ a.detail }}</span>
          <span class="pa-spacer"></span>
          <span class="pa-remain">{{ a.remain > 0 ? a.remain + ' 秒' : '即将完成' }}</span>
          <!-- 超管特权：跳过倒计时立即结算（走统一聊天指令「立即完成」，与 QQ 同一路径）；
               卷土重来是免死保护状态没有可跳过的结算，排除 -->
          <button
            v-if="adminMode && a.remain > 0 && a.kind !== 'comeback'"
            class="pa-complete"
            :disabled="completedKeys.has(a.key)"
            title="管理员特权：跳过倒计时立即完成"
            @click="onComplete(a)"
          >⚡完成</button>
        </div>
        <div class="pa-track">
          <div v-if="a.known" class="pa-fill" :style="{ width: a.percent + '%' }"></div>
          <div v-else class="pa-fill pa-indeterminate"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { serverNow } from '../utils/serverClock';

const props = defineProps({
  // 后端 pendingActions 快照：[{ key, kind, label, detail, icon, startedAt, endAt, totalMs }]
  // 只有 endAt 是必需的；startedAt/totalMs 有则用于刷新页面后仍显示真实进度。
  actions: { type: Array, default: () => [] },
  // 超管特权：显示「⚡完成」跳过倒计时按钮（仅 ADMIN/SUPER_ADMIN 传入 true）
  adminMode: { type: Boolean, default: false },
});

// 有条目倒计时归零时通知父组件：后端延时结算有抖动（定时器/5 秒兜底扫描），
// 前端先本地隐藏，再由父组件拉一次最新状态把已结算的条目彻底清掉。
const emit = defineEmits(['expired', 'complete']);

// 已点过「⚡完成」的条目：结算需要零点几秒~几秒（服务端写锁排队），
// 禁用按钮防连点；条目随 player:update 推送消失后 Set 残留无害。
const completedKeys = new Set();

const onComplete = (a) => {
  if (completedKeys.has(a.key)) return;
  completedKeys.add(a.key);
  emit('complete', a);
};

// 每秒触发一次重渲染的对齐时钟（endAt 为服务器时刻，必须用 serverNow 相减，
// 否则本机时钟漂移几秒会让倒计时整体提前/滞后同样秒数）
const now = ref(serverNow());
let timer = null;
onMounted(() => {
  timer = setInterval(() => {
    now.value = serverNow();
  }, 1000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

/**
 * 每个条目按 key 记住「首次观测到的剩余时间」，它就是进度条的分母。
 *
 * 后端只知道结束时间 endAt，不知道玩家是什么时候看到这条倒计时的；
 * 但对进度条而言，第一次渲染时的剩余时间天然就是"总时长"——
 * 从那一刻起由 0% 走到 100%，无需后端补 startedAt，历史数据也照样推进。
 */
const observed = new Map();

const activeActions = computed(() => {
  const t = now.value;
  return (props.actions || [])
    .filter((a) => Number(a?.endAt || 0) > t)
    .map((a) => {
      const endAt = Number(a?.endAt || 0);
      const remainMs = Math.max(0, endAt - t);
      const backendTotal = Number(a?.totalMs || 0);
      const rec = observed.get(a?.key);
      let total = rec?.totalMs || 0;
      // 新一轮操作（endAt 变了）、首次出现、或剩余时间被延长 → 重新起算。
      // 后端带的总时长若不小于当前剩余则优先采信，这样刷新页面后进度条位置仍是真实的。
      if (!rec || rec.endAt !== endAt || remainMs > total) {
        total = backendTotal >= remainMs ? backendTotal : remainMs;
        observed.set(a?.key, { endAt, totalMs: total });
      }
      const elapsed = total - remainMs;
      return {
        ...a,
        remain: Math.ceil(remainMs / 1000),
        known: total > 0,
        percent: total > 0 ? Math.min(100, Math.max(0, Math.round((elapsed / total) * 100))) : 0,
      };
    });
});

watch(activeActions, (list, prev) => {
  if ((prev?.length || 0) > 0 && list.length < prev.length) emit('expired');
  // 条目消失（已结算）时清掉防连点记录：同一 key 的新一轮读条（再次挖土）要能重新点击
  if (completedKeys.size) {
    const alive = new Set((list || []).map((a) => a.key));
    for (const k of [...completedKeys]) if (!alive.has(k)) completedKeys.delete(k);
  }
});
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

/* 超管「⚡完成」：紧凑幽灵按钮，hover 才亮起，不干扰普通玩家的读条视觉 */
.pa-complete {
  flex-shrink: 0;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 1.5;
  border: 1px solid var(--border-light);
  border-radius: 10px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: all 0.15s ease;
}
.pa-complete:hover:not(:disabled) {
  border-color: rgba(139, 92, 246, 0.7);
  color: var(--accent);
  background: rgba(139, 92, 246, 0.12);
}
.pa-complete:disabled {
  opacity: 0.45;
  cursor: not-allowed;
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

/* 总时长未知：左右扫描的不确定进度，明确表达「进行中」而不是卡住 */
.pa-indeterminate {
  width: 35%;
  animation: pa-scan 1.4s ease-in-out infinite;
}

@keyframes pa-scan {
  0% { margin-left: 0; }
  50% { margin-left: 65%; }
  100% { margin-left: 0; }
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
/* 卷土重来：倒地免死保护，橙红警示渐变 + 呼吸脉动，提示「到期即真死」的紧迫感 */
.pa-kind-comeback .pa-remain {
  color: #fb923c;
}
.pa-kind-comeback .pa-fill {
  background: linear-gradient(90deg, #f97316, #fb923c);
  box-shadow: 0 0 8px rgba(249, 115, 22, 0.7);
  animation: pa-comeback-pulse 1.2s ease-in-out infinite;
}
@keyframes pa-comeback-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
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
