<template>
  <!--
    家园建造四步引导卡片（圈地 → 开挖地基 → 建造地基 → 建造房子）
    展示层组件：只负责展示与发指令，不新增任何写接口——按钮发出的文本与 QQ 端逐字一致。
    两种形态：
    - 默认：聊天流内嵌的小卡片；
    - fullscreen：家园页「房子未建成」时的全屏接管引导，附带随进度逐级"长出"房子的
      纯 CSS 施工场景动画，帮助玩家直观理解建造阶段。
  -->
  <div ref="rootEl" class="hbg" :class="{ 'hbg-compact': compact, 'hbg-full': fullscreen, 'hbg-done': isDone, 'hbg-flash': flashing }">
    <!-- ========== 全屏接管：场景 + 浮层顶栏 + 底部指令面板 ========== -->
    <template v-if="fullscreen">
      <!-- 施工场景（纯 CSS，不加载图片；pointer-events:none 不挡操作） -->
      <div class="hbg-scene" aria-hidden="true">
        <i class="sb sb-sun"></i>
        <i class="sb sb-cloud sc1"></i>
        <i class="sb sb-cloud sc2"></i>
        <i class="sb sb-bird sv1"></i>
        <i class="sb sb-bird sv2"></i>
        <i v-for="n in 7" :key="'mote' + n" class="sb-mote" :style="{ '--d': `${n * 1.7}s`, '--x': `${8 + n * 12}%`, '--y': `${20 + (n % 3) * 18}%` }"></i>

        <div class="sb-lot" :class="'p' + stage">
          <div class="sb-ground"></div>
          <!-- 圈地阶段：四角界桩 + 虚线地界 -->
          <div v-if="stage === 0" class="sb-stakes">
            <i v-for="n in 4" :key="'k' + n" :class="'sk' + n"></i>
          </div>
          <div class="sb-house">
            <div class="sb-chimney" v-if="stage >= 4"><i class="sb-smoke"></i><i class="sb-smoke s2"></i></div>
            <div class="sb-roof"></div>
            <div class="sb-wall"><i class="sb-door"></i><i class="sb-window"></i></div>
          </div>
          <div class="sb-hole"></div>
          <div class="sb-foundation"></div>
          <div v-if="stage >= 1 && stage <= 3" class="sb-piles">
            <i class="sp1"></i><i class="sp2"></i>
          </div>
          <div class="sb-sign">
            <i class="sb-sign-post"></i>
            <span>{{ signLabel }}</span>
          </div>
          <div v-if="stage > 0 && stage < 4" class="sb-dust">
            <i v-for="n in 6" :key="n" :style="{ '--d': `${n * 0.35}s`, '--x': `${n * 20 - 58}px` }"></i>
          </div>
        </div>
        <div class="sb-fence"><i v-for="n in 15" :key="n"></i></div>
      </div>

      <!-- 浮层：返回聊天（建造期其它家园功能全部隐藏） -->
      <div class="hbg-topbar">
        <button type="button" class="hbg-back" :disabled="busy" @click="emit('open-chat')">← 聊天</button>
        <span v-if="hasPending" class="hbg-at-home-warn travelling">⏳ {{ pendingLabel }} · {{ pendingLeft }}s</span>
        <span v-else-if="!atHome && stage > 0" class="hbg-at-home-warn">📍 需要先回家</span>
      </div>

      <!-- 底部指令面板：大标题 + 四步轨 + 材料 + 主操作 -->
      <div ref="panelEl" class="hbg-panel">
        <div class="hbg-eyebrow">
          <span class="hbg-eyebrow-step">{{ stepLabel }}</span>
          <span v-if="!isDone" class="hbg-eyebrow-sub">{{ displayStep.subtitle }}</span>
        </div>
        <h2 class="hbg-headline">{{ isDone ? cfg.texts.doneTitle : displayStep.headline }}</h2>

        <!-- 四步进度链 -->
        <div class="hbg-steps hbg-steps-full">
          <div
            v-for="(s, i) in steps"
            :key="s.step"
            class="hbg-step"
            :class="stateOf(s)"
            :style="{ animationDelay: `${i * anim.stepDelayMs}ms` }"
          >
            <div class="hbg-dot">
              <span class="hbg-dot-icon">{{ s.icon }}</span>
            </div>
            <span class="hbg-name">{{ s.name }}</span>
            <span v-if="i < steps.length - 1" class="hbg-conn" :class="{ on: s.step < step }"></span>
          </div>
        </div>

        <p class="hbg-tip">{{ isDone ? cfg.texts.doneTip : tipText }}</p>

        <!-- 材料清单（开挖 / 建地基步） -->
        <div v-if="!isDone && displayStep.materials?.length" class="hbg-mats">
          <span v-for="m in displayStep.materials" :key="m.name" class="hbg-mat">
            <i>{{ m.icon }}</i>{{ m.name }} <b>{{ m.qty }}</b>
          </span>
        </div>

        <div class="hbg-ops hbg-ops-full">
          <button
            v-for="c in assistCmds"
            :key="c"
            class="hbg-btn tiny hbg-btn-cmd"
            :class="{ on: isPendingCmd(c) }"
            :disabled="busy || !atHome || isOtherClearBusy(c)"
            :title="assistTitle(c)"
            @click="onSend(c)"
          >
            <i v-if="isPendingCmd(c)" class="hbg-travel-ring"></i>
            {{ isPendingCmd(c) ? `${c} ${pendingLeft}s` : c }}
            <span v-if="queueCountFor(c) > 0" class="hbg-queue-badge">×{{ 1 + queueCountFor(c) }}</span>
          </button>
          <button
            v-if="!isDone && (hasPending && isPendingHome || (!atHome && stage > 0 && homeCmd))"
            class="hbg-btn ghost hbg-btn-travel"
            :class="{ on: hasPending && isPendingHome }"
            :disabled="hasPending || busy"
            :title="hasPending && isPendingHome ? '赶路中，到达后自动刷新' : undefined"
            @click="!(hasPending && isPendingHome) && onSend(homeCmd)"
          >
            <template v-if="hasPending && isPendingHome">
              <i class="hbg-travel-ring"></i>
              赶路中 {{ pendingLeft }}s
            </template>
            <template v-else>🏠 先回家</template>
          </button>
          <button
            v-if="!isDone && nextCmd"
            class="hbg-btn primary big"
            :class="{ on: isPendingCmd(nextCmd) }"
            :disabled="busy || hasPending || (!atHome && stage > 0)"
            :title="isPendingCmd(nextCmd) ? '施工中，完成后自动刷新下一步' : undefined"
            @click="onSend(nextCmd)"
          >
            <template v-if="isPendingCmd(nextCmd)">
              <i class="hbg-travel-ring dark"></i>
              {{ nextCmd }}中 {{ pendingLeft }}s
            </template>
            <template v-else>{{ primaryText }}</template>
            <span v-if="busy" class="hbg-btn-spin"></span>
          </button>
          <!-- 超管：跳过当前延时（挖土/赶路/建造），与聊天页「⚡完成」同一通道 -->
          <button
            v-if="queue?.adminMode && hasPending"
            class="hbg-btn tiny hbg-skip"
            title="管理员特权：跳过倒计时立即完成"
            @click="emit('skip')"
          >⚡完成</button>
        </div>
        <p v-if="queue?.queueCount > 0" class="hbg-queue-hint">
          服务端队列：{{ queue.queueDetail || `${queue.queueCmd}×${queue.queueCount}` }} ·
          结算后自动继续（还可清 {{ queue.clearLeft }} 次，刷新不丢）
        </p>
      </div>

      <!-- 第 4 步（房子开工）撒花 -->
      <div v-if="celebrating" class="hbg-confetti hbg-confetti-full" aria-hidden="true">
        <span v-for="n in 14" :key="n" :style="{ '--d': `${n * 70}ms`, '--x': `${(n - 7.5) * 7}%` }"></span>
      </div>
    </template>

    <!-- ========== 聊天流内嵌小卡片 ========== -->
    <div v-else class="hbg-inner">
      <div class="hbg-head">
        <span class="hbg-title">🏗️ {{ titleText }}</span>
        <span class="hbg-count">{{ step }}/{{ total }}</span>
      </div>

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

      <div v-if="celebrating" class="hbg-confetti" aria-hidden="true">
        <span v-for="n in 8" :key="n" :style="{ '--d': `${n * 90}ms`, '--x': `${(n - 4.5) * 11}%` }"></span>
      </div>
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
 * - 家园页 HomeView（fullscreen 模式，房子未建成时整页接管）。
 *
 * 写路径约定：所有按钮只 emit('send', 指令文本)，由父组件走统一指令通道执行，
 * 组件自身不调用任何接口。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { HOME_BUILD_GUIDE_CONFIG as cfg } from '../config';

const props = defineProps({
  /** 当前进度：0=未圈地，1-4=对应步骤 */
  step: { type: Number, default: 0 },
  /** 紧凑模式（聊天流内使用）：隐藏「打开家园」按钮 */
  compact: { type: Boolean, default: false },
  /** 全屏引导模式（家园页「房子未建成」时使用）：整页接管并附施工场景动画 */
  fullscreen: { type: Boolean, default: false },
  /** 父组件正在执行指令：期间禁用按钮避免并发写入 */
  busy: { type: Boolean, default: false },
  /** 是否已站在自己院子里（开挖/建造类指令的前置条件） */
  atHome: { type: Boolean, default: true },
  /** 自家院子地图名：用于拼「前往 房名」回家指令（与 QQ 端逐字一致） */
  houseName: { type: String, default: '' },
  /**
   * 通用延时操作：父组件解析回包「预计 N 秒后到达 / 大概需要 N 秒 / 需要 N 分钟」后写入。
   * { cmd, label, remain, total }；remain>0 时对应按钮显示倒计时并禁用其它操作。
   */
  pending: { type: Object, default: null },
  /**
   * 清障排队 + 超管跳过：
   * { adminMode, queueCount, queueCmd, clearLeft, clearTotalLeft }
   */
  queue: { type: Object, default: null },
});

const emit = defineEmits(['send', 'open-home', 'open-chat', 'skip']);

const steps = cfg.steps;
const total = cfg.total;
const anim = cfg.animation;

/** 当前步骤定义（step 0 用 claim 虚拟步） */
const current = computed(() => {
  if (props.step <= 0) return cfg.claim;
  return steps.find((s) => s.step === props.step) || null;
});
/** 进度到 4 即视为建成（房子开工后 2 分钟完工，此处按原版口径视作已完成流程） */
const isDone = computed(() => props.step >= total);
/** 下一步要发送的指令：进度 0 → 圈地；最后一步为空 */
const nextCmd = computed(() => {
  if (!props.step) return cfg.firstCommand;
  return current.value?.next || '';
});
/** 当前步可用的辅助指令（挖土/割草等清障指令） */
const assistCmds = computed(() => (isDone.value ? [] : current.value?.cmds || []));
/** 回家指令：注册的是「移动/前往」，没有裸「回家」命令 */
const homeCmd = computed(() => {
  const name = String(props.houseName || '').trim();
  return name ? `前往 ${name}` : '';
});
const titleText = computed(() => (isDone.value ? cfg.texts.doneTitle : cfg.texts.title));
const tipText = computed(() => {
  if (isDone.value) return cfg.texts.doneTip;
  return current.value?.tip || cfg.texts.startTip;
});
const nextText = computed(() => (nextCmd.value ? cfg.texts.nextCmd(nextCmd.value) : cfg.texts.building));

/** 全屏模式当前展示步（含 claim / done） */
const displayStep = computed(() => current.value || cfg.claim);
/** 全屏主按钮文案：第 0 步用更明确的「开始圈地」 */
const primaryText = computed(() => {
  if (!props.step) return cfg.claim.cta;
  return nextText.value;
});
/** 全屏眉题：第 N 步 / 共 4 步（0 显示「准备开工」） */
const stepLabel = computed(() => {
  if (isDone.value) return '🎉 已建成';
  if (props.step <= 0) return '准备开工';
  return `第 ${props.step} 步 · 共 ${total} 步`;
});

/** 全屏场景的建造阶段：0=空地圈地，1=开挖地基，2=建造地基，3=建造房子，4=建成 */
const stage = computed(() => Math.max(0, Math.min(4, props.step)));

/** 是否有进行中的延时操作（挖土/割草/前往/建造…） */
const hasPending = computed(() => Number(props.pending?.remain || 0) > 0);
const pendingLeft = computed(() => Math.max(0, Math.ceil(Number(props.pending?.remain || 0))));
const pendingCmd = computed(() => String(props.pending?.cmd || '').trim());
/** 短标签优先用父组件给的 label，其次截断 cmd */
const pendingLabel = computed(() => {
  const label = String(props.pending?.label || pendingCmd.value || '').trim();
  if (label.length <= 10) return label;
  return `${label.slice(0, 10)}…`;
});
/** 当前延时是否由「先回家/前往」触发 */
const isPendingHome = computed(() => pendingCmd.value.startsWith('前往'));
/** 某条指令是否正是当前延时操作 */
function isPendingCmd(cmd) {
  if (!hasPending.value || !cmd) return false;
  const c = String(cmd).trim();
  const p = pendingCmd.value;
  if (!p) return false;
  return p === c || p.startsWith(c) || c.startsWith(p);
}

/** 队列里该指令的条数（进行中不计，模板上 ×(1+n)） */
function queueCountFor(cmd) {
  const c = String(cmd || '').trim();
  if (!c || !props.queue?.queueCmd) return 0;
  return props.queue.queueCmd === c ? Number(props.queue.queueCount || 0) : 0;
}

/** 清障按钮 tooltip：进行中可继续排队 */
function assistTitle(cmd) {
  const c = String(cmd || '').trim();
  if (isOtherClearBusy(c)) {
    const busy = String(props.queue?.busyClearCmd || '').trim();
    return `正在「${busy}」，完成前只能继续点「${busy}」`;
  }
  if (isPendingCmd(c)) {
    const q = queueCountFor(c);
    return q > 0
      ? `进行中 · 已排队 ${1 + q} 次，可继续点击追加`
      : '进行中——再点一次可排队，结算后自动继续';
  }
  if (queueCountFor(c) > 0) return '已排队，进行结束后自动执行';
  return `发送「${c}」（倒计时中可连点排队）`;
}

/** 另一类清障正在进行：禁用本按钮（挖土进行中禁用割草，反之亦然） */
function isOtherClearBusy(cmd) {
  const c = String(cmd || '').trim();
  if (c !== '挖土' && c !== '割草') return false;
  const busy = String(props.queue?.busyClearCmd || '').trim();
  if (!busy || busy === c) return false;
  // 忙的是清障（当前 gather 或队列头），而不是「前往/建造」
  return busy === '挖土' || busy === '割草';
}

/** 施工告示牌文案 */
const signLabel = computed(() => {
  if (stage.value >= 4) return '已落成';
  if (stage.value === 0) return '待圈地';
  if (stage.value === 1) return '施工中';
  if (stage.value === 2) return '浇地基';
  return '盖房子';
});

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

// ---- 全屏：测量底部面板高度，把 --hbg-panel-h 写到根上，场景（地块/栅栏）自动避开 ----
const rootEl = ref(null);
const panelEl = ref(null);
let panelRO = null;

function syncPanelHeight() {
  if (!props.fullscreen || !rootEl.value || !panelEl.value) return;
  const h = Math.ceil(panelEl.value.getBoundingClientRect().height);
  if (h > 0) rootEl.value.style.setProperty('--hbg-panel-h', `${h + 16}px`);
}

watch(
  () => [props.fullscreen, props.step, isDone.value, props.busy, props.atHome, props.pending],
  async () => {
    await nextTick();
    syncPanelHeight();
  },
  { deep: true },
);

onMounted(async () => {
  await nextTick();
  syncPanelHeight();
  if (props.fullscreen && typeof ResizeObserver !== 'undefined') {
    panelRO = new ResizeObserver(() => syncPanelHeight());
    if (panelEl.value) panelRO.observe(panelEl.value);
  }
});

onBeforeUnmount(() => {
  clearTimeout(flashTimer);
  clearTimeout(celebrateTimer);
  if (panelRO) panelRO.disconnect();
});
</script>

<style scoped>
.hbg {
  --hbg-accent: #4ea3ff;
  --hbg-done: #38d39f;
  --hbg-cta: #ffb454;
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

/* ---- 说明与操作区（聊天流） ---- */
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
.hbg-btn:focus-visible {
  outline: 2px solid rgba(78, 163, 255, 0.7);
  outline-offset: 2px;
}

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
  z-index: 5;
  background: radial-gradient(circle at 50% 0%, rgba(78, 163, 255, 0.35), transparent 65%);
  animation: hbg-flash-fade 1.2s ease-out forwards;
}

.hbg-confetti { position: absolute; inset: 0; pointer-events: none; z-index: 6; }
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
  .sb-dust i,
  .sb-mote,
  .hbg-travel-ring,
  .hbg-btn-travel.on,
  .hbg-btn-cmd.on,
  .hbg-btn.primary.big.on {
    animation: none !important;
  }
}

/* ============================================================
   fullscreen 全屏接管（家园页房子未建成时）
   ------------------------------------------------------------
   整页 = 施工场景 + 底部玻璃指令面板。不显示游戏顶栏 / 农田 /
   仓库等任何家园功能——房子没建成，其它系统一律不开放。
   房子随进度 stage 逐级"长出"：0=空地 → 1=地基坑 → 2=地基 →
   3=墙体屋顶 → 4=建成（组件播撒花，父页面切完整家园）。
   ============================================================ */
.hbg-full {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: none;
  border-radius: 0;
  padding: 0;
  /* 黄昏→白昼的天空：随进度从冷色工地感过渡到暖色落成感 */
  background: linear-gradient(180deg, #0c1830 0%, #152a48 38%, #1e4a3a 72%, #2d5a32 100%);
  overflow: hidden;
  box-shadow: none;
}

/* ---- 施工场景 ---- */
.hbg-scene {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
}

/* 太阳 */
.sb-sun {
  position: absolute;
  top: 5%;
  right: 7%;
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
.sc1 { top: 8%; left: 12%; animation: sb-drift 46s linear infinite; }
.sc2 { top: 18%; left: 52%; animation: sb-drift 64s linear 10s infinite; }

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
.sv1 { top: 12%; left: 30%; animation: sb-fly 34s linear infinite; }
.sv2 { top: 5%; left: 64%; animation: sb-fly 42s linear 8s infinite; }

/* 空气浮尘 */
.sb-mote {
  position: absolute;
  left: var(--x);
  top: var(--y);
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: rgba(255, 240, 190, 0.35);
  animation: sb-mote 7s ease-in-out var(--d) infinite;
}

/* 地块（院子）：抬到面板上方，保证房子/地基完整露出 */
.sb-lot {
  position: absolute;
  left: 50%;
  bottom: calc(var(--hbg-panel-h, 280px) + 8px);
  width: min(560px, 86vw);
  height: min(34vh, 280px);
  min-height: 180px;
  transform: translateX(-50%);
  background: linear-gradient(180deg, #5fae52 0%, #47863f 55%, #3a6f35 100%);
  border-radius: 22px 22px 0 0;
  box-shadow:
    inset 0 8px 22px rgba(0, 0, 0, 0.16),
    0 18px 50px rgba(0, 0, 0, 0.4);
  transition: background 0.6s ease;
}
/* 建成后微微提亮，像阳光洒在完工的院子上 */
.sb-lot.p4 {
  background: linear-gradient(180deg, #6dbf5e 0%, #4f9646 55%, #3f7a3a 100%);
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

/* 圈地阶段：四角界桩 */
.sb-stakes i {
  position: absolute;
  width: 8px;
  height: 26px;
  border-radius: 3px;
  background: linear-gradient(180deg, #e8c48a, #b8894a);
  box-shadow: 0 2px 3px rgba(0, 0, 0, 0.3);
  animation: sb-stake-pop 0.45s ease both;
}
.sb-stakes .sk1 { left: 10%; top: 14%; animation-delay: 0.05s; }
.sb-stakes .sk2 { right: 10%; top: 14%; animation-delay: 0.15s; }
.sb-stakes .sk3 { left: 10%; bottom: 18%; animation-delay: 0.25s; }
.sb-stakes .sk4 { right: 10%; bottom: 18%; animation-delay: 0.35s; }
.sb-lot::after {
  /* 界桩间的虚线地界（仅 p0） */
  content: '';
  position: absolute;
  inset: 16% 12% 22%;
  border: 2px dashed rgba(255, 240, 200, 0.45);
  border-radius: 10px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.4s ease;
}
.sb-lot.p0::after { opacity: 1; }

/* 地基坑（开挖阶段）：抬到院子中上部，避免被底部面板挡住 */
.sb-hole {
  position: absolute;
  left: 50%;
  bottom: 22%;
  width: 40%;
  height: 16%;
  transform: translateX(-50%) scaleY(0);
  transform-origin: 50% 100%;
  border-radius: 12px;
  background: linear-gradient(180deg, #6b4a26, #4a2f16);
  box-shadow: inset 0 6px 14px rgba(0, 0, 0, 0.6);
  opacity: 0;
  transition: opacity 0.45s ease, transform 0.5s ease;
}
.sb-lot.p1 .sb-hole {
  opacity: 1;
  transform: translateX(-50%) scaleY(1);
}

/* 地基板（建地基阶段）：石纹从坑里长出来 */
.sb-foundation {
  position: absolute;
  left: 50%;
  bottom: 22%;
  width: 36%;
  height: 12px;
  transform: translateX(-50%) scaleX(0);
  transform-origin: 50% 100%;
  border-radius: 4px;
  background:
    linear-gradient(90deg, rgba(0, 0, 0, 0.12) 1px, transparent 1px) 0 0 / 14px 100%,
    linear-gradient(180deg, #9aa3ad, #6e7680);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.35);
  opacity: 0;
  z-index: 1;
  transition: transform 0.55s ease, opacity 0.4s ease;
}
.sb-lot.p2 .sb-foundation,
.sb-lot.p3 .sb-foundation,
.sb-lot.p4 .sb-foundation {
  opacity: 1;
  transform: translateX(-50%) scaleX(1);
}
.sb-lot.p1 .sb-hole { z-index: 0; }

/* 施工土堆 */
.sb-piles i {
  position: absolute;
  width: 28px;
  height: 16px;
  border-radius: 50% 50% 40% 40%;
  background: radial-gradient(circle at 40% 30%, #8b6239, #5c3d1f);
  opacity: 0;
  transform: scale(0.4);
  transition: opacity 0.4s ease, transform 0.4s ease;
}
.sb-piles .sp1 { left: 16%; bottom: 30%; }
.sb-piles .sp2 { right: 18%; bottom: 34%; width: 22px; height: 13px; }
.sb-lot.p1 .sb-piles i,
.sb-lot.p2 .sb-piles i {
  opacity: 1;
  transform: scale(1);
}

/* 施工中的房子：居中偏上，完整露出在面板上方 */
.sb-house {
  position: absolute;
  left: 50%;
  bottom: 22%;
  transform: translateX(-50%) translateY(8px);
  width: 36%;
  z-index: 2;
  opacity: 0;
  transition: all 0.55s ease;
}
.sb-lot.p2 .sb-house,
.sb-lot.p3 .sb-house,
.sb-lot.p4 .sb-house {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.sb-roof {
  width: 120%;
  height: 52px;
  margin-left: -10%;
  background: linear-gradient(180deg, #e07a48, #c4552e);
  clip-path: polygon(0% 100%, 50% 0%, 100% 100%);
  opacity: 0;
  transform: scaleY(0.15);
  transform-origin: 50% 100%;
  transition: transform 0.5s ease, opacity 0.4s ease;
}
.sb-lot.p2 .sb-roof { opacity: 0.85; transform: scaleY(0.2); } /* 地基阶段仅轮廓 */
.sb-lot.p3 .sb-roof { opacity: 1; transform: scaleY(1); }
.sb-lot.p4 .sb-roof { opacity: 1; transform: scaleY(1); background: linear-gradient(180deg, #e88950, #c95f32); }

.sb-wall {
  position: relative;
  height: 0;
  width: 100%;
  background: linear-gradient(180deg, #c4a882, #9d845f);
  transition: height 0.6s ease;
  overflow: hidden;
}
.sb-wall::before {
  content: '';
  position: absolute;
  inset: 5px;
  border: 2px dashed rgba(120, 90, 55, 0.4);
  border-radius: 6px;
}
.sb-lot.p2 .sb-wall { height: 8px; }
.sb-lot.p3 .sb-wall { height: 52px; }
.sb-lot.p4 .sb-wall { height: 56px; background: linear-gradient(180deg, #e8d4b0, #c4a882); }
.sb-wall::after {
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
  width: 16px;
  height: 28px;
  transform: translateX(-50%);
  border-radius: 5px 5px 0 0;
  background: #6b4a26;
  opacity: 0;
  transition: opacity 0.4s ease 0.35s;
}
.sb-lot.p3 .sb-door,
.sb-lot.p4 .sb-door { opacity: 1; }

.sb-window {
  position: absolute;
  left: 18%;
  top: 28%;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  background: rgba(180, 230, 255, 0.55);
  border: 1.5px solid rgba(80, 60, 40, 0.45);
  opacity: 0;
  transition: opacity 0.4s ease 0.45s;
}
.sb-lot.p4 .sb-window { opacity: 1; }

/* 烟囱 + 炊烟（建成后）：贴在屋顶右侧坡面上 */
.sb-chimney {
  position: absolute;
  right: 28%;
  top: 10px;
  width: 14px;
  height: 22px;
  background: #8b5a3a;
  border-radius: 2px 2px 0 0;
  z-index: 1;
}
.sb-smoke {
  position: absolute;
  left: 50%;
  top: -8px;
  width: 8px;
  height: 8px;
  margin-left: -4px;
  border-radius: 50%;
  background: rgba(230, 235, 240, 0.55);
  animation: sb-smoke 2.4s ease-out infinite;
}
.sb-smoke.s2 { animation-delay: 1.2s; }

/* 施工告示牌 */
.sb-sign {
  position: absolute;
  left: 50%;
  bottom: 6%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  animation: sb-sign-bob 1.8s ease-in-out infinite;
}
.sb-sign span {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 2px;
  color: #3d2a14;
  background: #f0d090;
  border: 1.5px solid #c8a06b;
  border-radius: 4px;
  padding: 2px 8px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  white-space: nowrap;
}
.sb-sign-post {
  width: 4px;
  height: 12px;
  background: #8b5a3a;
  border-radius: 2px;
}

/* 施工灰尘粒子 */
.sb-dust i {
  position: absolute;
  bottom: 20%;
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
  bottom: calc(var(--hbg-panel-h, 280px) + 8px + min(34vh, 280px) - 2px);
  transform: translateX(-50%);
  width: min(620px, 92vw);
  max-width: 92vw;
  display: flex;
  justify-content: space-between;
  padding: 0 2%;
  box-sizing: border-box;
}
.sb-fence i {
  width: 6px;
  height: 22px;
  border-radius: 3px;
  background: #c8a06b;
  box-shadow: 0 2px 3px rgba(0, 0, 0, 0.25);
}

/* ---- 浮层顶栏 ---- */
.hbg-topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  pointer-events: none;
}
.hbg-back {
  pointer-events: auto;
  cursor: pointer;
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(10, 16, 28, 0.55);
  backdrop-filter: blur(8px);
  color: #d7e4f5;
  font-size: 13px;
  transition: background 0.2s ease, transform 0.15s ease;
}
.hbg-back:hover:not(:disabled) {
  background: rgba(20, 32, 52, 0.75);
  transform: translateX(-1px);
}
.hbg-back:disabled { opacity: 0.5; cursor: not-allowed; }
.hbg-back:focus-visible {
  outline: 2px solid rgba(78, 163, 255, 0.7);
  outline-offset: 2px;
}
.hbg-at-home-warn {
  pointer-events: auto;
  font-size: 12px;
  color: #ffd79a;
  background: rgba(80, 50, 16, 0.45);
  border: 1px solid rgba(255, 180, 84, 0.35);
  border-radius: 999px;
  padding: 5px 12px;
  backdrop-filter: blur(6px);
}

/* ---- 底部指令面板 ---- */
.hbg-panel {
  position: relative;
  z-index: 2;
  margin-top: auto;
  width: min(600px, calc(100% - 28px));
  margin-left: auto;
  margin-right: auto;
  margin-bottom: 16px;
  padding: 16px 20px 18px;
  border-radius: 18px;
  border: 1px solid rgba(120, 170, 230, 0.22);
  background: linear-gradient(165deg, rgba(14, 24, 42, 0.9), rgba(10, 16, 30, 0.94));
  backdrop-filter: blur(14px);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
  animation: hbg-panel-in 0.55s ease both;
}

.hbg-eyebrow {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}
.hbg-eyebrow-step {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: #0a1628;
  background: linear-gradient(120deg, #ffd76a, #ffb454);
  border-radius: 999px;
  padding: 3px 10px;
}
.hbg-eyebrow-sub {
  font-size: 12px;
  color: #9fb2cc;
}

.hbg-headline {
  margin: 0 0 10px;
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 0.5px;
  color: #f2f7ff;
  line-height: 1.3;
}

/* 全屏步轨：稍大一点 */
.hbg-steps-full { margin-bottom: 8px; }
.hbg-steps-full .hbg-dot { width: 36px; height: 36px; font-size: 17px; }
.hbg-steps-full .hbg-name { font-size: 11.5px; }
.hbg-steps-full .hbg-conn { top: 18px; left: calc(50% + 24px); right: calc(-50% + 24px); }

.hbg-panel .hbg-tip {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.65;
  color: #c5d4e8;
}

/* 材料清单 */
.hbg-mats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 12px;
}
.hbg-mat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  color: #d7e4f5;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  padding: 5px 12px 5px 8px;
}
.hbg-mat i { font-style: normal; font-size: 14px; }
.hbg-mat b {
  color: #ffd76a;
  font-variant-numeric: tabular-nums;
}

/* 全屏操作区 */
.hbg-ops-full { align-items: center; }
.hbg-btn.big {
  padding: 10px 20px;
  font-size: 14px;
  font-weight: 800;
  border-radius: 12px;
  position: relative;
}
/* 主 CTA：暖琥珀「开工」色，和蓝色辅助按钮形成层级 */
.hbg-panel .hbg-btn.primary.big {
  border: none;
  background: linear-gradient(120deg, #ffc857, #ffb454 40%, #ff8f4a);
  background-size: 200% 100%;
  color: #2a1808;
  box-shadow: 0 6px 20px rgba(255, 160, 60, 0.35);
  animation: hbg-flow 3.2s linear infinite;
}
.hbg-panel .hbg-btn.primary.big:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 10px 26px rgba(255, 160, 60, 0.45);
}
.hbg-panel .hbg-btn.primary.big:disabled {
  opacity: 0.55;
  animation: none;
}

/* 按钮内转圈（busy） */
.hbg-btn-spin {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-left: 6px;
  border: 2px solid rgba(42, 24, 8, 0.25);
  border-top-color: #2a1808;
  border-radius: 50%;
  vertical-align: -1px;
  animation: hbg-spin 0.7s linear infinite;
}

.hbg-panel .hbg-btn.tiny {
  padding: 7px 14px;
  font-size: 12.5px;
  border-radius: 10px;
}
.hbg-panel .hbg-btn.ghost {
  padding: 9px 16px;
  font-size: 13px;
}

.hbg-queue-badge {
  display: inline-block;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  color: #0a1628;
  background: linear-gradient(120deg, #7ee8fa, #4ea3ff);
  vertical-align: 1px;
}
.hbg-skip {
  border-color: rgba(255, 214, 106, 0.55) !important;
  color: #ffd76a !important;
  background: rgba(80, 60, 10, 0.4) !important;
  font-weight: 700;
}
.hbg-queue-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: #9fd0ff;
  opacity: 0.9;
}

/* 赶路/施工中按钮：环形进度 + 脉冲 */
.hbg-btn-travel.on,
.hbg-btn-cmd.on,
.hbg-btn.primary.big.on {
  cursor: default;
  animation: hbg-travel-glow 1.2s ease-in-out infinite;
}
.hbg-btn-travel.on {
  border-color: rgba(255, 180, 84, 0.55);
  color: #ffd79a;
  background: rgba(80, 50, 16, 0.35);
}
.hbg-btn-cmd.on {
  border-color: rgba(78, 163, 255, 0.55);
  color: #cfe6ff;
  background: rgba(30, 60, 100, 0.4);
  font-weight: 700;
}
.hbg-btn.primary.big.on {
  filter: saturate(0.85) brightness(0.95);
}
.hbg-travel-ring {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 6px;
  border-radius: 50%;
  border: 2px solid rgba(255, 180, 84, 0.35);
  border-top-color: #ffb454;
  vertical-align: -1px;
  animation: hbg-spin 0.85s linear infinite;
}
.hbg-travel-ring.dark {
  border-color: rgba(42, 24, 8, 0.25);
  border-top-color: #2a1808;
}
@keyframes hbg-travel-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 180, 84, 0.25); }
  50% { box-shadow: 0 0 0 5px rgba(255, 180, 84, 0.08); }
}
.hbg-at-home-warn.travelling {
  color: #ffe2a8;
  background: rgba(90, 55, 12, 0.5);
  border-color: rgba(255, 180, 84, 0.45);
}

/* 全屏撒花从顶部落下 */
.hbg-confetti-full span { top: -12px; }

/* ---- 全屏场景动画 ---- */
@keyframes hbg-panel-in {
  from { opacity: 0; transform: translateY(18px); }
  to { opacity: 1; transform: none; }
}
@keyframes hbg-spin {
  to { transform: rotate(360deg); }
}
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
  0%, 100% { transform: translateX(-50%) translateY(0); }
  50% { transform: translateX(-50%) translateY(-4px); }
}
@keyframes sb-dust {
  0% { transform: translate(0, 0) scale(1); opacity: 0.9; }
  100% { transform: translate(var(--x), -34px) scale(0.2); opacity: 0; }
}
@keyframes sb-mote {
  0%, 100% { transform: translateY(0); opacity: 0.2; }
  50% { transform: translateY(-18px); opacity: 0.55; }
}
@keyframes sb-stake-pop {
  from { opacity: 0; transform: scaleY(0.3); }
  to { opacity: 1; transform: scaleY(1); }
}
@keyframes sb-smoke {
  0% { transform: translateY(0) scale(0.6); opacity: 0.55; }
  100% { transform: translateY(-28px) scale(1.6); opacity: 0; }
}

/* 移动端：场景压扁、面板更贴近底部 */
@media (max-width: 640px) {
  .sb-lot {
    width: 94vw;
    height: min(28vh, 220px);
    min-height: 150px;
  }
  .hbg-panel {
    width: calc(100% - 20px);
    margin-bottom: 12px;
    padding: 14px 14px 16px;
    border-radius: 16px;
  }
  .hbg-headline { font-size: 17px; margin-bottom: 8px; }
  .hbg-steps-full .hbg-dot { width: 32px; height: 32px; font-size: 15px; }
  .hbg-steps-full .hbg-conn { top: 16px; left: calc(50% + 20px); right: calc(-50% + 20px); }
  .hbg-btn.big { width: 100%; justify-content: center; }
  .sb-sun { width: 44px; height: 44px; }
}
</style>
