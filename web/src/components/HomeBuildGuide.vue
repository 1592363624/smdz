<template>
  <!--
    家园建造四步引导卡片（圈地 → 开挖地基 → 建造地基 → 建造房子）
    展示层组件：只负责展示与发指令，不新增任何写接口——按钮发出的文本与 QQ 端逐字一致。
    两种形态：
    - 默认：聊天流内嵌的小卡片；
    - fullscreen：家园页「房子未建成」时的全屏引导页，附带随进度逐级"长出"房子的
      纯 CSS 场景动画，帮助玩家直观理解建造阶段。
  -->
  <div class="hbg" :class="{ 'hbg-compact': compact, 'hbg-full': fullscreen, 'hbg-done': isDone, 'hbg-flash': flashing }">
    <!-- 全屏场景：天空 + 院子 + 施工中的房子（纯 CSS，不加载图片，pointer-events 不挡操作） -->
    <div v-if="fullscreen && !isDone" class="hbg-scene" aria-hidden="true">
      <i class="sb sb-sun"></i>
      <i class="sb sb-cloud sc1"></i>
      <i class="sb sb-cloud sc2"></i>
      <i class="sb sb-bird sv1"></i>
      <i class="sb sb-bird sv2"></i>
      <div class="sb-lot" :class="'p' + stage">
        <div class="sb-house">
          <div class="sb-roof"></div>
          <div class="sb-wall"><i class="sb-door"></i></div>
        </div>
        <div class="sb-hole"></div>
        <div class="sb-ground"></div>
        <div class="sb-sign">🚧</div>
        <div v-if="stage > 0 && stage < 4" class="sb-dust">
          <i v-for="n in 6" :key="n" :style="{ '--d': `${n * 0.35}s`, '--x': `${n * 20 - 58}px` }"></i>
        </div>
      </div>
      <div class="sb-fence"><i v-for="n in 13" :key="n"></i></div>
    </div>

    <div class="hbg-inner" :class="{ 'hbg-card': fullscreen }">
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
            v-if="fullscreen && !atHome"
            class="hbg-btn ghost"
            :disabled="busy"
            @click="onSend('回家')"
          >
            🏠 先回家
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
  /** 全屏引导模式（家园页「房子未建成」时使用）：铺满整页并附院子场景动画 */
  fullscreen: { type: Boolean, default: false },
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

/** 全屏场景的建造阶段：0=空地圈地，1=开挖地基，2=建造地基，3=建造房子，4=建成 */
const stage = computed(() => Math.max(0, Math.min(4, props.step)));

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
  .hbg-confetti span,
  .hbg-scene i,
  .sb-house,
  .sb-dust i {
    animation: none !important;
  }
}

/* ============================================================
   fullscreen 全屏引导模式（家园页房子未建成时）
   ------------------------------------------------------------
   整个引导铺满视口；inner 为可滚动内容卡片，场景为纯 CSS 装饰。
   房子随进度 stage 逐级"长出"：0=空地 → 1=地基坑 → 2=地基 →
   3=立起墙体屋顶 → 4=建成（组件不再渲染场景，改由家园页撒花）。
   ============================================================ */
.hbg-full {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: none;
  border-radius: 0;
  padding: 0;
  background: linear-gradient(180deg, #0c1830 0%, #12233f 45%, #1b3a24 100%);
  overflow: hidden auto;
  box-shadow: none;
}

/* 内容卡片：覆盖在场景之上，竖向铺开可滚动（仅全屏模式） */
.hbg-full .hbg-inner {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: min(560px, calc(100vw - 36px));
  margin: auto;
  padding: 22px 24px 26px;
}
.hbg-full .hbg-card {
  border: 1px solid rgba(78, 163, 255, 0.3);
  border-radius: 18px;
  background: linear-gradient(165deg, rgba(18, 30, 50, 0.94), rgba(12, 18, 32, 0.96));
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.45);
}

.hbg-full .hbg-title { font-size: 18px; }
.hbg-full .hbg-count { font-size: 14px; padding: 2px 12px; }
.hbg-full .hbg-dot { width: 44px; height: 44px; font-size: 21px; }
.hbg-full .hbg-name { font-size: 13px; }
.hbg-full .hbg-tip { font-size: 14px; line-height: 1.7; }
.hbg-full .hbg-btn { padding: 8px 16px; font-size: 13.5px; border-radius: 11px; }

/* ---- 全屏场景（纯 CSS 小院子） ---- */
.hbg-scene {
  position: fixed;
  inset: 0;
  z-index: 1;
  overflow: hidden;
  pointer-events: none;
}

/* 太阳 */
.sb-sun {
  position: absolute;
  top: 6%;
  right: 8%;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: radial-gradient(circle at 38% 36%, #fff6c8, #ffd76a 55%, rgba(255, 190, 80, 0.15) 75%);
  box-shadow: 0 0 34px 12px rgba(255, 215, 106, 0.45);
  animation: sb-pulse 5s ease-in-out infinite;
}

/* 云 */
.sb-cloud {
  position: absolute;
  width: 96px;
  height: 30px;
  border-radius: 999px;
  background: rgba(235, 244, 255, 0.75);
  filter: blur(1px);
}
.sb-cloud::before,
.sb-cloud::after {
  content: '';
  position: absolute;
  bottom: 0;
  border-radius: 50%;
  background: inherit;
}
.sb-cloud::before { width: 38px; height: 38px; left: 16px; }
.sb-cloud::after { width: 30px; height: 30px; right: 14px; }
.sc1 { top: 9%; left: 12%; animation: sb-drift 46s linear infinite; }
.sc2 { top: 20%; left: 52%; animation: sb-drift 64s linear 10s infinite; }

/* 飞鸟（两段羽翼拍打） */
.sb-bird {
  position: absolute;
  width: 16px;
  height: 8px;
}
.sb-bird::before,
.sb-bird::after {
  content: '';
  position: absolute;
  top: 0;
  width: 8px;
  height: 5px;
  border-radius: 6px 6px 2px 2px;
  background: #dfe8f5;
  animation: sb-flap 0.5s ease-in-out infinite alternate;
}
.sb-bird::before { left: 0; transform-origin: 100% 100%; }
.sb-bird::after { right: 0; transform-origin: 0% 100%; }
.sv1 { top: 14%; left: 30%; animation: sb-fly 34s linear infinite; }
.sv2 { top: 6%; left: 64%; animation: sb-fly 42s linear 8s infinite; }

/* 地块（院子）：自下而上占约 40% 视口 */
.sb-lot {
  position: absolute;
  left: 50%;
  bottom: 9%;
  width: min(560px, 92vw);
  height: 40vh;
  min-height: 240px;
  transform: translateX(-50%);
  background: linear-gradient(180deg, #5fae52 0%, #47863f 60%, #3a6f35 100%);
  border-radius: 20px 20px 0 0;
  box-shadow: inset 0 8px 22px rgba(0, 0, 0, 0.18), 0 18px 50px rgba(0, 0, 0, 0.4);
}

/* 地面草纹 */
.sb-ground {
  position: absolute;
  inset: 0;
  background-image:
    radial-gradient(rgba(255, 255, 255, 0.14) 1.5px, transparent 1.5px),
    radial-gradient(rgba(20, 60, 20, 0.35) 2px, transparent 2px);
  background-size: 26px 26px, 40px 40px;
  background-position: 4px 4px, 12px 8px;
  border-radius: inherit;
}

/* 地基坑（开挖地基阶段可见） */
.sb-hole {
  position: absolute;
  left: 50%;
  bottom: 16%;
  width: 38%;
  height: 15%;
  transform: translateX(-50%);
  border-radius: 12px;
  background: linear-gradient(180deg, #6b4a26, #4a2f16);
  box-shadow: inset 0 6px 14px rgba(0, 0, 0, 0.6);
  opacity: 0;
}
.sb-lot.p1 .sb-hole { opacity: 1; }

/* 施工中的房子：墙体随阶段长高，屋顶在地基完成后立起 */
.sb-house {
  position: absolute;
  left: 50%;
  bottom: 15%;
  transform: translateX(-50%);
  width: 34%;
  z-index: 2;
  transition: all 0.6s ease;
}
.sb-roof {
  width: 0;
  height: 0;
  border-left: calc(50% + 12px) solid transparent;
  border-right: calc(50% + 12px) solid transparent;
  border-bottom: 42px solid #d26b3f;
  opacity: 0;
  transition: all 0.5s ease;
  transform-origin: 50% 100%;
}
.sb-lot.p1 .sb-roof { border-bottom-width: 16px; opacity: 0.55; } /* 地基轮廓 */
.sb-lot.p2 .sb-roof { border-bottom-width: 16px; opacity: 1; }
.sb-lot.p3 .sb-roof { border-bottom-width: 42px; opacity: 1; }

.sb-wall {
  position: relative;
  height: 0;
  width: 100%;
  background: linear-gradient(180deg, #b9a184, #9d845f);
  transition: height 0.6s ease;
  overflow: hidden;
}
.sb-wall::before {
  content: '';
  position: absolute;
  inset: 6px;
  border: 2px dashed rgba(120, 90, 55, 0.55);
  border-radius: 6px;
}
.sb-lot.p1 .sb-wall { height: 10px; }
.sb-lot.p2 .sb-wall { height: 18px; }
.sb-lot.p3 .sb-wall { height: 46px; }
.sb-wall::after { /* 木质纹理 */
  content: '';
  position: absolute;
  inset: 0;
  background-image: linear-gradient(90deg, transparent 48%, rgba(255, 255, 255, 0.12) 50%, transparent 52%);
  background-size: 26px 100%;
}

.sb-door {
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 14px;
  height: 24px;
  transform: translateX(-50%);
  border-radius: 5px 5px 0 0;
  background: #6b4a26;
  opacity: 0;
  transition: opacity 0.4s ease 0.4s;
}
.sb-lot.p3 .sb-door { opacity: 1; }

/* 施工告示牌：圈地阶段最显眼 */
.sb-sign {
  position: absolute;
  left: 50%;
  bottom: 4%;
  transform: translateX(-50%);
  font-size: 22px;
  opacity: 0.9;
  animation: sb-sign-bob 1.6s ease-in-out infinite;
}

/* 施工灰尘粒子 */
.sb-dust i {
  position: absolute;
  bottom: 14%;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(210, 180, 130, 0.8);
  animation: sb-dust 1.6s ease-out infinite;
}

/* 院子栅栏 */
.sb-fence {
  position: absolute;
  left: 50%;
  bottom: calc(9% + 40vh + 6px);
  transform: translateX(-50%);
  width: min(620px, 100vw);
  display: flex;
  justify-content: space-between;
}
.sb-fence i {
  width: 6px;
  height: 22px;
  border-radius: 3px;
  background: #c8a06b;
  box-shadow: 0 2px 3px rgba(0, 0, 0, 0.25);
}

/* ---- 全屏场景动画 ---- */
@keyframes sb-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.06); }
}
@keyframes sb-drift {
  from { transform: translateX(-12vw); }
  to { transform: translateX(112vw); }
}
@keyframes sb-fly {
  from { transform: translate(-8vw, 0); }
  25% { transform: translate(14vw, -10px); }
  50% { transform: translate(38vw, 4px); }
  75% { transform: translate(62vw, -8px); }
  to { transform: translate(92vw, 0); }
}
@keyframes sb-flap {
  from { transform: rotate(-16deg); }
  to { transform: rotate(16deg); }
}
@keyframes sb-sign-bob {
  0%, 100% { transform: translate(-50%, 0); }
  50% { transform: translate(-50%, -4px); }
}
@keyframes sb-dust {
  0% { transform: translate(0, 0) scale(1); opacity: 0.9; }
  100% { transform: translate(var(--x), -34px) scale(0.2); opacity: 0; }
}

/* 移动端：场景压扁、卡片更贴近底部 */
@media (max-width: 640px) {
  .sb-lot { width: 100vw; min-height: 200px; }
  .hbg-inner { width: calc(100vw - 24px); padding: 16px 16px 20px; }
}
</style>
