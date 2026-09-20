<template>
  <!--
    全服世界事件进度条：① 常驻细条贴 header 下方（图标 + 名称 + 进度 + 百分比 + 剩余时间）；
    ② 点击展开 Teleport 居中面板（大进度条 + 里程碑刻度 + 四档卡片 + 领取按钮，领取走统一指令通道，与 QQ 同一路径）。
    数据：首屏 GET /game/world-event/current；此后由父组件把 socket `worldEvent:progress` 作为
    `live` prop 传入做实时增量（不轮询）；文案/颜色全部取自 config WORLD_EVENT_UI。
  -->
  <div v-if="cycle" class="we-strip" :title="stripTitle" @click="openPanel">
    <span class="we-strip-icon">{{ cfg.icon }}</span>
    <span class="we-strip-name">{{ cycle.title || cfg.stripLabel }}</span>
    <div class="we-strip-track">
      <div class="we-strip-fill" :style="{ width: percent + '%' }"></div>
      <span
        v-for="m in milestones"
        :key="'tick-' + m.percent"
        class="we-strip-tick"
        :class="{ 'is-reached': m.reached }"
        :style="{ left: m.percent + '%' }"
      ></span>
    </div>
    <span class="we-strip-pct">{{ percent }}%</span>
    <span class="we-strip-remain">{{ remainingText }}</span>
    <span v-if="claimableCount" class="we-strip-badge">{{ claimableCount }}</span>
  </div>

  <Teleport to="body">
    <div v-if="expanded && cycle" class="we-overlay" @click.self="expanded = false">
      <div class="we-modal">
        <div class="we-head">
          <h3>{{ cfg.icon }} {{ cycle.title || cfg.texts.panelTitle }}<em class="we-cycle">{{ cycle.cycleId }}</em></h3>
          <div class="we-head-actions">
            <button class="we-icon-btn" :title="cfg.texts.refresh" @click="load(true)">⟳</button>
            <button class="we-icon-btn" :title="cfg.texts.close" @click="expanded = false">✕</button>
          </div>
        </div>
        <div class="we-body">
          <p class="we-desc">{{ cycle.description }}</p>
          <div class="we-meta">
            <span class="we-period">{{ periodLabel }}</span>
            <span class="we-remain">· {{ cfg.texts.remaining(remainingText) }}</span>
          </div>

          <div class="we-big-track">
            <div class="we-big-fill" :style="{ width: percent + '%' }"></div>
            <span
              v-for="m in milestones"
              :key="'btick-' + m.percent"
              class="we-big-tick"
              :class="{ 'is-reached': m.reached }"
              :style="{ left: m.percent + '%' }"
            >
              <i>{{ m.percent }}%</i>
            </span>
          </div>
          <div class="we-count">{{ fmt(current) }} / {{ fmt(goal) }}（{{ percent }}%）</div>

          <div class="we-milestones">
            <div
              v-for="m in milestones"
              :key="'ms-' + m.percent"
              class="we-ms-card"
              :class="msClass(m)"
            >
              <div class="we-ms-top">
                <span class="we-ms-icon">{{ msIcon(m) }}</span>
                <span class="we-ms-pct">{{ m.percent }}%</span>
              </div>
              <div class="we-ms-buff">{{ m.buffLabel || '—' }}</div>
              <div class="we-ms-sub">
                <span v-if="m.claimable" class="we-ms-claimable">可领取</span>
                <span v-else-if="m.reached" class="we-ms-done">已领取</span>
                <span v-else class="we-ms-gap">{{ cfg.texts.stillNeed(fmt(gapFor(m))) }}</span>
              </div>
            </div>
          </div>

          <div class="we-foot">
            <button
              v-if="claimableCount"
              class="we-claim-btn"
              @click="claim"
            >{{ cfg.texts.claimButton }} ×{{ claimableCount }}</button>
            <span v-else class="we-foot-hint">发送「{{ cfg.texts.viewCommand }}」查看，达成里程碑即可领奖</span>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { worldApi } from '../api';
import { WORLD_EVENT_UI as cfg } from '../config';
import { serverNow } from '../utils/serverClock';

const props = defineProps({
  /** socket `worldEvent:progress` 实时增量：{ cycleId, current, goal, percent } */
  live: { type: Object, default: null },
  /** 是否已连接（未连接时不请求） */
  connected: { type: Boolean, default: false },
});
const emit = defineEmits(['send', 'notify']);

// 首屏/刷新快照（REST 真相源），live 仅覆盖 current/goal/percent 做丝滑增量
const cycle = ref(null);
const expanded = ref(false);
let lastFetchAt = 0;

const fmt = (n) => Number(n || 0).toLocaleString();

async function load(force = false) {
  if (!props.connected) return;
  const now = Date.now();
  if (!force && now - lastFetchAt < cfg.refreshMs) return;
  try {
    const res = await worldApi.getCurrent();
    const data = res?.data;
    cycle.value = data && data.cycleId ? data : null;
    lastFetchAt = Date.now();
  } catch {
    emit('notify', { type: 'error', message: '世界事件进度加载失败，请稍后重试' });
  }
}

// 实时增量：cycleId 一致才覆盖数字；跨过里程碑或面板打开时回源刷新可领状态
watch(
  () => props.live,
  (l) => {
    if (!l || !cycle.value) return;
    if (l.cycleId && l.cycleId !== cycle.value.cycleId) {
      load(true); // 进入新周期，全量刷新
      return;
    }
    cycle.value = {
      ...cycle.value,
      current: typeof l.current === 'number' ? l.current : cycle.value.current,
      goal: typeof l.goal === 'number' ? l.goal : cycle.value.goal,
      percent: typeof l.percent === 'number' ? l.percent : cycle.value.percent,
    };
    if (typeof l.milestoneJustReached === 'number' || (expanded.value && l.percent !== cycle.value.percent)) {
      load(true);
    }
  },
);

const percent = computed(() => {
  const c = cycle.value;
  if (!c) return 0;
  return Math.max(0, Math.min(100, Number(c.percent) || 0));
});
const current = computed(() => cycle.value?.current ?? 0);
const goal = computed(() => cycle.value?.goal ?? 0);
const milestones = computed(() => (Array.isArray(cycle.value?.milestones) ? cycle.value.milestones : []));
const claimableCount = computed(() => (cycle.value?.claimable || []).length);
const periodLabel = computed(() => cfg.periodLabel[cycle.value?.period] || '');
const stripTitle = computed(() => `${cycle.value?.title || cfg.stripLabel} · ${percent.value}%（点击查看）`);

function gapFor(m) {
  const need = Math.ceil(((goal.value || 0) * m.percent) / 100);
  return Math.max(0, need - (current.value || 0));
}
function msIcon(m) {
  if (m.claimable) return cfg.milestoneIcons.claimable;
  if (m.reached) return m.claimed ? cfg.milestoneIcons.claimed : cfg.milestoneIcons.reached;
  return cfg.milestoneIcons.pending;
}
function msClass(m) {
  return {
    'is-claimable': !!m.claimable,
    'is-reached': !!m.reached,
    'is-pending': !m.reached,
  };
}

// 倒计时：本地逐秒推进，用 serverNow 消除本机时钟漂移
const nowTick = ref(serverNow());
let timer = null;
const remainingText = computed(() => {
  const end = cycle.value?.endAt ? new Date(cycle.value.endAt).getTime() : 0;
  if (!end) return '';
  let s = Math.max(0, Math.floor((end - nowTick.value) / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const mi = Math.floor(s / 60);
  if (cycle.value?.status === 'SETTLED') return '领取窗口内';
  if (d > 0) return `${d}天${h}时`;
  if (h > 0) return `${h}时${mi}分`;
  return `${mi}分`;
});

function openPanel() {
  expanded.value = true;
  load(false);
}
function claim() {
  const n = claimableCount.value;
  emit('send', cfg.texts.claimCommand);
  emit('notify', { type: 'info', message: `已发送领取指令（${n} 项），稍后自动刷新` });
  // 领取是异步指令结算，稍后回源刷新可领状态
  setTimeout(() => load(true), 1200);
}

// connected 就绪后再首屏拉取
watch(
  () => props.connected,
  (ok) => { if (ok) load(true); },
  { immediate: true },
);

onMounted(() => {
  timer = setInterval(() => { nowTick.value = serverNow(); }, 1000);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
/* ===== ① 常驻细条 ===== */
.we-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 14px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-light);
  background: linear-gradient(90deg, rgba(139, 92, 246, 0.14), rgba(6, 182, 212, 0.08));
  flex-shrink: 0;
  user-select: none;
}
.we-strip-icon { font-size: 14px; line-height: 1; filter: drop-shadow(0 0 4px rgba(139, 92, 246, 0.6)); }
.we-strip-name {
  font-size: 12px; font-weight: 600; color: var(--text);
  white-space: nowrap; max-width: 30vw; overflow: hidden; text-overflow: ellipsis;
}
.we-strip-track {
  position: relative; flex: 1; min-width: 40px; height: 6px;
  border-radius: 3px; background: rgba(255, 255, 255, 0.12); overflow: hidden;
}
.we-strip-fill {
  height: 100%; border-radius: 3px; background: var(--accent-gradient);
  box-shadow: 0 0 8px rgba(139, 92, 246, 0.6); transition: width 0.9s linear;
}
.we-strip-tick {
  position: absolute; top: 0; width: 2px; height: 100%;
  background: rgba(0, 0, 0, 0.35); transform: translateX(-1px);
}
.we-strip-tick.is-reached { background: rgba(74, 222, 128, 0.9); }
.we-strip-pct { font-size: 12px; font-weight: 700; color: var(--accent2); font-variant-numeric: tabular-nums; }
.we-strip-remain { font-size: 11px; color: var(--muted); white-space: nowrap; }
.we-strip-badge {
  min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
  background: #f59e0b; color: #1a1030; font-size: 11px; font-weight: 700; line-height: 16px; text-align: center;
}

/* ===== ② 展开面板（居中弹窗，手机铺满） ===== */
.we-overlay {
  position: fixed; inset: 0; z-index: 700; display: flex;
  align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
}
.we-modal {
  width: min(440px, calc(100vw - 32px)); max-height: min(640px, calc(100vh - 64px));
  display: flex; flex-direction: column; border-radius: 14px;
  border: 1px solid var(--border-light); background: rgba(24, 20, 46, 0.98);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.6); overflow: hidden;
}
.we-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.we-head h3 { margin: 0; font-size: 14px; color: var(--text); }
.we-cycle { margin-left: 8px; font-size: 11px; font-style: normal; color: var(--muted); }
.we-head-actions { display: flex; gap: 2px; }
.we-icon-btn {
  width: 28px; height: 28px; border: none; border-radius: 8px; background: transparent;
  color: var(--muted); font-size: 14px; cursor: pointer;
}
.we-icon-btn:hover { color: var(--text); background: rgba(255, 255, 255, 0.08); }
.we-body { padding: 14px; overflow-y: auto; }
.we-desc { margin: 0 0 8px; font-size: 12px; line-height: 1.6; color: var(--muted); }
.we-meta { display: flex; gap: 6px; font-size: 12px; color: var(--accent2); margin-bottom: 10px; }
.we-period { font-weight: 700; }
.we-remain { color: var(--muted); }

.we-big-track { position: relative; height: 12px; border-radius: 6px; background: rgba(255, 255, 255, 0.1); overflow: visible; margin-bottom: 6px; }
.we-big-fill { height: 100%; border-radius: 6px; background: var(--accent-gradient); box-shadow: 0 0 10px rgba(139, 92, 246, 0.6); transition: width 0.9s linear; }
.we-big-tick { position: absolute; top: -2px; width: 1px; height: 16px; background: var(--tick-color, rgba(255,255,255,0.55)); }
.we-big-tick i { position: absolute; top: 16px; left: 0; transform: translateX(-50%); font-size: 10px; font-style: normal; color: var(--muted); }
.we-big-tick.is-reached { background: #4ade80; }
.we-count { font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 18px; font-variant-numeric: tabular-nums; }

.we-milestones { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }
.we-ms-card { padding: 10px; border-radius: 10px; border: 1px solid var(--border-light); background: rgba(255, 255, 255, 0.03); }
.we-ms-card.is-reached { border-color: rgba(74, 222, 128, 0.4); }
.we-ms-card.is-claimable { border-color: rgba(245, 158, 11, 0.6); background: rgba(245, 158, 11, 0.1); }
.we-ms-card.is-pending { opacity: 0.8; }
.we-ms-top { display: flex; align-items: center; gap: 6px; }
.we-ms-pct { font-size: 13px; font-weight: 700; color: var(--text); }
.we-ms-buff { margin: 4px 0; font-size: 12px; color: var(--muted); line-height: 1.4; }
.we-ms-sub { font-size: 11px; }
.we-ms-claimable { color: #fbbf24; font-weight: 700; }
.we-ms-done { color: #4ade80; }
.we-ms-gap { color: var(--muted); }

.we-foot { display: flex; align-items: center; justify-content: space-between; }
.we-claim-btn {
  padding: 8px 16px; border: none; border-radius: 10px; cursor: pointer;
  font-size: 13px; font-weight: 700; color: #1a1030; background: var(--accent-gradient-full, var(--accent-gradient));
  box-shadow: 0 4px 14px rgba(139, 92, 246, 0.4);
}
.we-foot-hint { font-size: 11px; color: var(--muted); }

@media (max-width: 640px) {
  .we-modal { width: 100vw; max-height: 100dvh; border-radius: 0; }
  .we-strip-name { max-width: 26vw; }
}
</style>
