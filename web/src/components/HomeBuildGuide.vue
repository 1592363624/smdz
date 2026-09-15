<template>
  <!--
    家园建造四步引导卡片（圈地 → 开挖地基 → 建造地基 → 建造房子）
    展示层组件：只负责展示与发指令，不新增任何写接口——按钮发出的文本与 QQ 端逐字一致。
  -->
  <div class="hbg" :class="{ 'hbg-compact': compact, 'hbg-done': isDone, 'hbg-flash': flashing }">
    <div class="hbg-head">
      <span class="hbg-title">🏗️ {{ titleText }}</span>
      <span class="hbg-count">{{ step }}/{{ total }}</span>
    </div>

    <!-- 四步进度链：已完成 ✅ / 当前步脉冲 / 未开始灰显，连接线带流光 -->
    <div class="hbg-steps">
      <div
        v-for="(s, i) in steps"
        :key="s.step"
        class="hbg-step"
        :class="stateOf(s)"
        :style="{ animationDelay: `${i * anim.stepDelayMs}ms` }"
      >
        <div class="hbg-dot">
          <span class="hbg-dot-icon">{{ s.icon }}</span>
          <span v-if="stateOf(s) === 'done'" class="hbg-check">✅</span>
        </div>
        <span class="hbg-name">{{ s.name }}</span>
        <span v-if="i < steps.length - 1" class="hbg-conn" :class="{ on: s.step < step }"></span>
      </div>
    </div>

    <div class="hbg-body">
      <p class="hbg-tip">{{ tipText }}</p>
      <div class="hbg-ops">
        <button
          v-for="c in assistCmds"
          :key="c"
          class="hbg-btn tiny"
          :disabled="busy || !atHome"
          :title="`发送「${c}」`"
          @click="onSend(c)"
        >
          {{ c }}
        </button>
        <button
          v-if="nextCmd"
          class="hbg-btn primary"
          :disabled="busy || !atHome"
          @click="onSend(nextCmd)"
        >
          {{ nextText }}
        </button>
        <button v-if="!compact" class="hbg-btn ghost" @click="emit('open-home')">
          {{ cfg.texts.openHome }}
        </button>
      </div>
      <p v-if="!atHome" class="hbg-warn">{{ cfg.texts.notAtHome }}</p>
    </div>

    <!-- 第 4 步（房子开工）撒花：纯装饰，pointer-events:none 不影响操作 -->
    <div v-if="celebrating" class="hbg-confetti" aria-hidden="true">
      <span v-for="n in 8" :key="n" :style="{ '--d': `${n * 90}ms`, '--x': `${(n - 4.5) * 11}%` }"></span>
    </div>
  </div>
</template>

<script setup>
/**
 * 家园建造引导卡片
 *
 * 用途：把「圈地 → 开挖地基 → 建造地基 → 建造房子」这四步做成带动画的新手引导条，
 * 同时出现在两处：
 * - 聊天流（ChatView 识别后端引导文本后渲染，附「打开家园」跳转按钮）；
 * - 家园页 HomeView 顶部（compact 模式，就地执行下一步指令）。
 *
 * 写路径约定：所有按钮只 emit('send', 指令文本)，由父组件走统一指令通道执行，
 * 组件自身不调用任何接口。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { HOME_BUILD_GUIDE_CONFIG as cfg } from '../config';

const props = defineProps({
  /** 当前进度：0=未圈地，1-4=对应步骤 */
  step: { type: Number, default: 0 },
  /** 紧凑模式（家园页内使用）：隐藏「打开家园」按钮 */
  compact: { type: Boolean, default: false },
  /** 父组件正在执行指令：期间禁用按钮避免并发写入 */
  busy: { type: Boolean, default: false },
  /** 是否已站在自己院子里（开挖/建造类指令的前置条件） */
  atHome: { type: Boolean, default: true },
});

const emit = defineEmits(['send', 'open-home']);

const steps = cfg.steps;
const total = cfg.total;
const anim = cfg.animation;

/** 当前步骤定义 */
const current = computed(() => steps.find((s) => s.step === props.step) || null);
/** 进度到 4 即视为建成（房子开工后 2 分钟完工，此处按原版口径视作已完成流程） */
const isDone = computed(() => props.step >= total);
/** 下一步要发送的指令：进度 0 → 圈地；最后一步为空 */
const nextCmd = computed(() => {
  if (!props.step) return cfg.firstCommand;
  return current.value?.next || '';
});
/** 当前步可用的辅助指令（挖土/割草等清障指令） */
const assistCmds = computed(() => current.value?.cmds || []);
const titleText = computed(() => (isDone.value ? cfg.texts.doneTitle : cfg.texts.title));
const tipText = computed(() => {
  if (isDone.value) return cfg.texts.doneTip;
  // 进度 0：还没有家园，引导先去圈地
  if (!props.step) return cfg.texts.startTip;
  return current.value?.tip || cfg.texts.startTip;
});
const nextText = computed(() => (nextCmd.value ? cfg.texts.nextCmd(nextCmd.value) : cfg.texts.building));

/** 单步状态：done=已完成 current=进行中 building=末步施工中 todo=未开始 */
function stateOf(s) {
  if (s.step < props.step) return 'done';
  if (s.step === props.step) return isDone.value ? 'building' : 'current';
  return 'todo';
}

/** 进度推进时的高亮闪烁（watch 到 step 变化才触发，首次渲染不闪） */
const flashing = ref(false);
/** 末步撒花 */
const celebrating = ref(false);
let flashTimer = null;
let celebrateTimer = null;

watch(
  () => props.step,
  (now, before) => {
    if (!anim.enabled || before === undefined || now === before) return;
    flashing.value = true;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashing.value = false; }, anim.flashMs);
    if (now >= total) {
      celebrating.value = true;
      clearTimeout(celebrateTimer);
      celebrateTimer = setTimeout(() => { celebrating.value = false; }, anim.celebrateMs);
    }
  },
);

/** 点击发出指令：交由父组件走统一指令通道，保证与 QQ 端同一条写路径 */
function onSend(cmd) {
  if (!cmd || props.busy) return;
  emit('send', cmd);
}

onBeforeUnmount(() => {
  clearTimeout(flashTimer);
  clearTimeout(celebrateTimer);
});
</script>

<style scoped>
.hbg {
  --hbg-accent: #4ea3ff;
  --hbg-done: #38d39f;
  position: relative;
  overflow: hidden;
  padding: 12px 14px 14px;
  border: 1px solid rgba(78, 163, 255, 0.35);
  border-radius: 14px;
  background: linear-gradient(160deg, rgba(20, 30, 48, 0.92), rgba(14, 20, 34, 0.94));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  color: #e8f1ff;
  animation: hbg-in 0.45s ease both;
}

.hbg-compact { padding: 10px 12px 12px; border-radius: 12px; }

.hbg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.hbg-title { font-size: 14px; font-weight: 700; letter-spacing: 0.5px; }

.hbg-count {
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(78, 163, 255, 0.16);
  border: 1px solid rgba(78, 163, 255, 0.4);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* ---- 四步进度链 ---- */
.hbg-steps { display: flex; align-items: flex-start; gap: 0; }

.hbg-step {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  animation: hbg-step-in 0.4s ease both;
}

.hbg-dot {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
  font-size: 17px;
  transition: transform 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease;
}

.hbg-dot-icon { line-height: 1; }

.hbg-check {
  position: absolute;
  right: -4px;
  bottom: -4px;
  font-size: 12px;
}

.hbg-name { font-size: 11.5px; color: #9fb2cc; white-space: nowrap; }

/* 连接线：完成段亮起并流光，未完成段保持暗色 */
.hbg-conn {
  position: absolute;
  top: 17px;
  left: calc(50% + 22px);
  right: calc(-50% + 22px);
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
}

.hbg-conn.on {
  background: linear-gradient(90deg, var(--hbg-done), var(--hbg-accent));
  background-size: 200% 100%;
  animation: hbg-flow 1.8s linear infinite;
}

/* 状态配色 */
.hbg-step.done .hbg-dot {
  border-color: rgba(56, 211, 159, 0.6);
  background: rgba(56, 211, 159, 0.14);
  box-shadow: 0 0 12px rgba(56, 211, 159, 0.28);
}
.hbg-step.done .hbg-name { color: #9ff0d0; }

.hbg-step.current .hbg-dot {
  border-color: var(--hbg-accent);
  background: rgba(78, 163, 255, 0.18);
  box-shadow: 0 0 0 0 rgba(78, 163, 255, 0.5);
  animation: hbg-pulse 1.8s ease-out infinite;
}
.hbg-step.current .hbg-name { color: #cfe6ff; font-weight: 700; }

.hbg-step.building .hbg-dot {
  border-color: #ffb454;
  background: rgba(255, 180, 84, 0.16);
  animation: hbg-pulse 1.6s ease-out infinite;
}
.hbg-step.building .hbg-name { color: #ffd79a; font-weight: 700; }

.hbg-step.todo .hbg-dot { opacity: 0.55; }

/* ---- 说明与操作区 ---- */
.hbg-body { margin-top: 12px; }

.hbg-tip { margin: 0 0 10px; font-size: 12.5px; line-height: 1.6; color: #b9c9de; }

.hbg-ops { display: flex; flex-wrap: wrap; gap: 8px; }

.hbg-btn {
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: #e8f1ff;
  font-size: 12.5px;
  transition: transform 0.15s ease, background 0.2s ease, border-color 0.2s ease;
}
.hbg-btn:hover:not(:disabled) { transform: translateY(-1px); background: rgba(255, 255, 255, 0.12); }
.hbg-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.hbg-btn.primary {
  border-color: transparent;
  background: linear-gradient(120deg, #3b82f6, #4ea3ff 45%, #38d39f);
  background-size: 200% 100%;
  font-weight: 700;
  color: #05121f;
  animation: hbg-flow 3.2s linear infinite;
}

.hbg-btn.ghost { background: transparent; border-color: rgba(78, 163, 255, 0.5); color: #9fd0ff; }
.hbg-btn.tiny { padding: 5px 10px; font-size: 12px; }

.hbg-warn { margin: 8px 0 0; font-size: 12px; color: #ffb454; }

/* ---- 进度推进闪烁 / 撒花 ---- */
.hbg-flash::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(circle at 50% 0%, rgba(78, 163, 255, 0.35), transparent 65%);
  animation: hbg-flash-fade 1.2s ease-out forwards;
}

.hbg-confetti { position: absolute; inset: 0; pointer-events: none; }
.hbg-confetti span {
  position: absolute;
  top: -10px;
  left: calc(50% + var(--x));
  width: 7px;
  height: 12px;
  border-radius: 2px;
  background: linear-gradient(180deg, #ffd76a, #ff8a5b);
  animation: hbg-fall 1.8s linear var(--d) forwards;
}
.hbg-confetti span:nth-child(even) { background: linear-gradient(180deg, #7ee8fa, #4ea3ff); }

/* ---- 关键帧 ---- */
@keyframes hbg-in {
  from { opacity: 0; transform: translateY(8px) scale(0.99); }
  to { opacity: 1; transform: none; }
}
@keyframes hbg-step-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
@keyframes hbg-pulse {
  0% { box-shadow: 0 0 0 0 rgba(78, 163, 255, 0.45); }
  70% { box-shadow: 0 0 0 12px rgba(78, 163, 255, 0); }
  100% { box-shadow: 0 0 0 0 rgba(78, 163, 255, 0); }
}
@keyframes hbg-flow {
  from { background-position: 0% 50%; }
  to { background-position: 200% 50%; }
}
@keyframes hbg-flash-fade {
  from { opacity: 0.9; }
  to { opacity: 0; }
}
@keyframes hbg-fall {
  from { transform: translateY(0) rotate(0deg); opacity: 1; }
  to { transform: translateY(190px) rotate(420deg); opacity: 0; }
}

/* 系统开启「减少动效」时关闭全部动画（无障碍降级） */
@media (prefers-reduced-motion: reduce) {
  .hbg,
  .hbg-step,
  .hbg-conn.on,
  .hbg-btn.primary,
  .hbg-step.current .hbg-dot,
  .hbg-step.building .hbg-dot,
  .hbg-flash::after,
  .hbg-confetti span {
    animation: none !important;
  }
}
</style>
