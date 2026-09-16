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
      <!-- 天空装饰（纯 CSS；pointer-events:none 不挡操作） -->
      <div class="hbg-scene" aria-hidden="true">
        <i class="sb sb-sun"></i>
        <i class="sb sb-cloud sc1"></i>
        <i class="sb sb-cloud sc2"></i>
        <i class="sb sb-bird sv1"></i>
        <i class="sb sb-bird sv2"></i>
        <i v-for="n in 7" :key="'mote' + n" class="sb-mote" :style="{ '--d': `${n * 1.7}s`, '--x': `${8 + n * 12}%`, '--y': `${20 + (n % 3) * 18}%` }"></i>
      </div>

      <!-- 浮层：返回聊天（建造期其它家园功能全部隐藏） -->
      <div class="hbg-topbar">
        <button type="button" class="hbg-back" :disabled="busy" @click="emit('open-chat')">← 聊天</button>
        <span v-if="hasPending" class="hbg-at-home-warn travelling">⏳ {{ pendingLabel }}<template v-if="!pending?.finishing"> · {{ pendingLeft }}s</template></span>
        <span v-else-if="!atHome && stage > 0" class="hbg-at-home-warn">📍 需要先回家</span>
      </div>

      <!-- 院子场景 + 指令面板：整组垂直居中，宽屏不再整块贴底 -->
      <div class="hbg-stage">
        <div class="sb-lot" :class="'p' + stage" aria-hidden="true">
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

          <!-- 施工工具动画：按当前读条/阶段切换 -->
          <div class="sb-tools" :class="toolAnimClass" aria-hidden="true">
            <!-- 铲子：挖土 / 开挖地基 -->
            <div class="sb-tool sb-shovel">
              <i class="sh-handle"></i>
              <i class="sh-blade"></i>
            </div>
            <!-- 锄头：割草 -->
            <div class="sb-tool sb-hoe">
              <i class="ho-handle"></i>
              <i class="ho-head"></i>
            </div>
            <!-- 砌刀+砖：建造地基 -->
            <div class="sb-tool sb-trowel">
              <i class="tr-blade"></i>
              <i class="tr-brick b1"></i>
              <i class="tr-brick b2"></i>
              <i class="tr-brick b3"></i>
            </div>
            <!-- 锤子+钉：建造房子 -->
            <div class="sb-tool sb-hammer">
              <i class="hm-handle"></i>
              <i class="hm-head"></i>
              <i class="hm-nail"></i>
            </div>
            <!-- 割下的草屑 -->
            <div class="sb-grass-cut">
              <i v-for="n in 5" :key="n" :class="'gc' + n"></i>
            </div>
            <!-- 挖出的土块飞溅 -->
            <div class="sb-dig-chips">
              <i v-for="n in 4" :key="n" :class="'dc' + n"></i>
            </div>
          </div>
        </div>
        <div class="sb-fence" aria-hidden="true"><i v-for="n in 15" :key="n"></i></div>

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

        <!-- 材料清单：只在「还没开工、仍需备料」时展示；建造中材料已扣，避免和实扣对不上 -->
        <div v-if="showMaterials" class="hbg-mats">
          <span
            v-for="m in displayStep.materials"
            :key="m.name"
            class="hbg-mat"
            :class="{ ok: ownedOf(m.name) >= m.qty }"
            :title="`需要 ${m.qty}，已有 ${ownedOf(m.name)}`"
          >
            <i>{{ m.icon }}</i>{{ m.name }}
            <b>{{ m.qty }}</b>
            <em>已有 {{ ownedOf(m.name) }}</em>
          </span>
        </div>

        <!-- 清障：含队列进度条（即使障碍数暂时为 0，只要队列还有也要显示） -->
        <div v-if="!isDone && fullscreenClears.length" class="hbg-clears">
          <template v-for="s in fullscreenClears" :key="s.cmd">
            <div class="hbg-clear-row">
              <button
                class="hbg-btn hbg-clear"
                :class="{ on: s.busy }"
                :disabled="busy || !atHome || needHome || (s.available <= 0 && !s.busy)"
                :title="clearTitle(s)"
                @click="onSend(s.cmd)"
              >
                <i v-if="s.busy" class="hbg-travel-ring"></i>
                {{ s.busy ? (pending?.finishing ? `${s.cmd} …` : `${s.cmd} ${pendingLeft}s`) : s.cmd }}
                <span class="hbg-clear-left">
                  {{ s.left > 0
                    ? (s.available > 0 ? `还可排 ${s.available}` : '已排满')
                    : (s.arranged > 0 ? '队列中' : '—') }}
                </span>
                <span v-if="s.arranged > 0" class="hbg-queue-badge">
                  {{ s.arranged }}/{{ Math.max(s.left, s.arranged) }}
                </span>
              </button>
              <button
                v-if="s.arranged > 0 || s.left > 1"
                class="hbg-btn hbg-clear-all"
                :disabled="busy || !atHome || needHome || (s.arranged > 0 && s.available <= 0)"
                :title="s.arranged > 0 && s.available > 0
                  ? `把剩余可排的 ${s.available} 次全部排进队列`
                  : s.left > 1 ? `用「${s.cmd}${s.left}」一次清完` : undefined"
                @click="onSend(`${s.cmd}${s.arranged > 0 ? Math.max(s.available, 1) : s.left}`)"
              >
                {{ s.arranged > 0
                  ? (s.available > 0 ? `排满剩余 ×${s.available}` : '排队中…')
                  : `清完 ×${s.left}` }}
              </button>
            </div>
            <!-- 已安排进度条：一眼看到队列推进 -->
            <div v-if="s.arranged > 0" class="hbg-clear-track" :title="`已安排 ${s.arranged} / ${Math.max(s.left, s.arranged)}`">
              <i :style="{ width: s.progressPct + '%' }"></i>
              <span>已安排 {{ s.arranged }}/{{ Math.max(s.left, s.arranged) }}</span>
            </div>
          </template>
          <p v-if="multiPileHint" class="hbg-multipile-hint">{{ multiPileHint }}</p>
        </div>

        <div class="hbg-ops hbg-ops-full">
          <!-- 不在院子：回家是唯一主操作 -->
          <button
            v-if="!isDone && needHome && homeCmd"
            class="hbg-btn primary big"
            :class="{ on: hasPending && isPendingHome }"
            :disabled="busy || (hasPending && !isPendingHome)"
            :title="hasPending && isPendingHome ? '赶路中，到达后自动继续' : '回到自己的院子才能动土'"
            @click="!(hasPending && isPendingHome) && onSend(homeCmd)"
          >
            <template v-if="hasPending && isPendingHome">
              <i class="hbg-travel-ring dark"></i>
              {{ pending?.finishing ? '落地结算中…' : `赶路中 ${pendingLeft}s` }}
            </template>
            <template v-else>🏠 先回家院子</template>
          </button>

          <!-- 在院子里：下一步建造 -->
          <button
            v-else-if="!isDone && nextCmd"
            class="hbg-btn primary big"
            :class="{ on: isPendingCmd(nextCmd) }"
            :disabled="busy || hasPending || (needHome && stage > 0) || blockers.blockNext"
            :title="nextTitle"
            @click="onSend(nextCmd)"
          >
            <template v-if="isPendingCmd(nextCmd)">
              <i class="hbg-travel-ring dark"></i>
              {{ pending?.finishing ? `${pendingLabel} …` : `${pendingLabel} ${pendingLeft}s` }}
            </template>
            <template v-else>{{ primaryText }}</template>
            <span v-if="busy" class="hbg-btn-spin"></span>
          </button>

          <!-- 超管：跳过当前延时 -->
          <button
            v-if="queue?.adminMode && hasPending"
            class="hbg-btn tiny hbg-skip"
            title="管理员特权：跳过整条清障/延时队列"
            @click="emit('skip')"
          >⚡完成</button>
        </div>
        <p v-if="queue?.queueCount > 0" class="hbg-queue-hint">
          服务端队列 {{ queue.queueDetail || queue.queueCmd }} ·
          这一段结束后自动继续
          <template v-if="primaryArrangeText"> · {{ primaryArrangeText }}</template>
        </p>
        <p v-else-if="hasPending && pending?.finishing" class="hbg-queue-hint">
          {{ pending?.kind === 'move' ? '即将落地，正在确认位置…' : '即将完成，界面马上更新…' }}
        </p>
        </div>
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
        <!-- 材料清单：有 materials prop 时显示已有量（聊天流默认不传则只在全屏展示） -->
        <div v-if="!isDone && displayStep.materials?.length && materials" class="hbg-mats">
          <span
            v-for="m in displayStep.materials"
            :key="m.name"
            class="hbg-mat"
            :class="{ ok: ownedOf(m.name) >= m.qty }"
            :title="`需要 ${m.qty}，已有 ${ownedOf(m.name)}`"
          >
            <i>{{ m.icon }}</i>{{ m.name }}
            <b>{{ m.qty }}</b>
            <em>已有 {{ ownedOf(m.name) }}</em>
          </span>
        </div>
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
   * 清障排队 / 障碍剩余 / 超管跳过（HomeView 合成）：
   * { adminMode, queueCount, queueCmd, queueDetail, busyClearCmd, clears, needHome, ... }
   */
  queue: { type: Object, default: null },
  /**
   * 背包资源存量：{ 木头: 50, 石头: 30, … }。来自 GET /game/home/yard 的 materials 字段，
   * 用于在材料清单上显示「已有 X」。缺省/空对象时只显示需求量。
   */
  materials: { type: Object, default: null },
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
/**
 * 房子已开工但读条未结束：进度虽是 4，仍算「施工中」而非「已建成」。
 * 读条结束后 isDone 才变 true，引导页播庆祝再交给完整家园。
 */
const isHouseConstructing = computed(() => {
  if (props.step < total) return false;
  if (!hasPending.value || props.pending?.kind !== 'work') return false;
  const label = String(props.pending?.label || '').trim();
  return label.includes('房子') || label.includes('建造');
});
/** 流程完成 = 进度到 4 且房子读条已结束 */
const isDone = computed(() => props.step >= total && !isHouseConstructing.value);
/** 下一步要发送的指令：进度 0 → 圈地；最后一步为空（施工中保留「建造房子」以便显示读条） */
const nextCmd = computed(() => {
  if (!props.step) return cfg.firstCommand;
  if (isHouseConstructing.value) return '建造房子';
  return current.value?.next || '';
});
/** 当前步可用的辅助指令（挖土/割草等清障指令） */
const assistCmds = computed(() => (isDone.value ? [] : current.value?.cmds || []));
/** 背包中某材料的已有数量（缺省为 0） */
function ownedOf(name) {
  const bag = props.materials;
  if (!bag || typeof bag !== 'object') return 0;
  return Number(bag[name] || 0);
}
/** 回家指令：注册的是「移动/前往」，没有裸「回家」命令 */
const homeCmd = computed(() => {
  const name = String(props.houseName || '').trim();
  return name ? `前往 ${name}` : '';
});
const titleText = computed(() => (isDone.value ? cfg.texts.doneTitle : cfg.texts.title));
const tipText = computed(() => {
  if (isDone.value) return cfg.texts.doneTip;
  // 开工后进度立刻跳步，但材料是当前步刚扣的——建造中不要再说「备齐材料」
  if (buildingWork.value === 'foundation') return '地基正在浇筑，稍等片刻即可准备材料建造房子';
  if (buildingWork.value === 'house') return '小屋正在施工，约 2 分钟后完工';
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
const stage = computed(() => {
  // 房子施工中场景保持「施工中」样式，读条结束才切「已落成」
  if (isHouseConstructing.value) return 3;
  return Math.max(0, Math.min(4, props.step));
});

/** 是否有进行中的延时操作（挖土/割草/前往/建造…） */
const hasPending = computed(() => Number(props.pending?.remain || 0) > 0 || Boolean(props.pending?.finishing));
const pendingLeft = computed(() => Math.max(0, Math.ceil(Number(props.pending?.remain || 0))));
const pendingCmd = computed(() => String(props.pending?.cmd || '').trim());
/** 短标签优先用父组件给的 label，其次截断 cmd；建造读条补「中」与旧文案一致 */
const pendingLabel = computed(() => {
  let label = String(props.pending?.label || pendingCmd.value || '').trim();
  if (props.pending?.kind === 'work' && label && !label.endsWith('中')) label = `${label}中`;
  if (props.pending?.finishing) return `${label || '进行中'} · 即将完成`;
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

/** 当前是否在浇地基 / 盖房子读条中（开工后进度已跳步，用读条区分真实阶段） */
const buildingWork = computed(() => {
  if (!hasPending.value || props.pending?.kind !== 'work') return null;
  const label = String(props.pending?.label || '').trim();
  if (label.includes('地基')) return 'foundation';
  if (label.includes('房子')) return 'house';
  return 'work';
});

/**
 * 场景工具动画类名：按读条优先，其次按 stage 兜底。
 * dig=铲子挖土 · weed=锄头除草 · pour=砌地基 · hammer=锤子敲房 · idle=无
 */
const toolAnimClass = computed(() => {
  if (hasPending.value && props.pending?.kind === 'gather') {
    const cmd = String(props.pending?.cmd || props.pending?.label || '');
    if (cmd.includes('割草')) return 't-weed';
    if (cmd.includes('挖土') || cmd.includes('清')) return 't-dig';
  }
  if (buildingWork.value === 'foundation') return 't-pour';
  if (buildingWork.value === 'house') return 't-hammer';
  // 无读条时按阶段给个静态提示（方便知道下一步该干嘛）
  if (stage.value === 1) return 't-dig';
  if (stage.value === 2) return 't-pour';
  if (stage.value === 3) return 't-hammer';
  return 't-idle';
});

/**
 * 材料清单是否展示。
 * 开工后进度立刻跳下一步（原版口径），若仍渲染下一步材料会让人以为「要扣 300 却没扣」——
 * 实际此刻扣的是当前步材料。故：地基/房子读条进行中时隐藏材料行。
 */
const showMaterials = computed(() => {
  if (isDone.value) return false;
  if (!displayStep.value?.materials?.length) return false;
  return !buildingWork.value;
});

/** 全屏清障按钮列表（剩余次数 + 是否进行中） */
const fullscreenClears = computed(() => (props.queue?.clears || []).map((s) => ({
  ...s,
  busy: s.busy || isPendingCmd(s.cmd),
})));

const needHome = computed(() => Boolean(props.queue?.needHome) && stage.value > 0);

/** 「下一步」是否被障碍挡住 */
const blockers = computed(() => ({
  blockNext: needHome.value || (fullscreenClears.value.length > 0 && !hasPending.value),
}));

const nextTitle = computed(() => {
  if (isPendingCmd(nextCmd.value)) return '施工中，完成后自动刷新下一步';
  if (needHome.value) return '需要先回到自己的院子';
  if (blockers.value.blockNext) return '院子里还有土堆/杂草，先清完才能开挖地基';
  return undefined;
});

function clearTitle(s) {
  if (needHome.value) return '回到院子后才能清障';
  if (isOtherClearBusy(s.cmd)) {
    const busy = String(props.queue?.busyClearCmd || '').trim();
    return `正在「${busy}」，完成前只能继续点「${busy}」`;
  }
  const arranged = s.arranged ?? ((s.busy ? 1 : 0) + (s.queued || 0));
  const available = s.available ?? Math.max(0, (s.left || 0) - arranged);
  const pileNote = s.piles > 1 ? `（共 ${s.piles} 堆，要全部挖完）` : '';
  if (s.busy) return `进行中 · 已安排 ${arranged}/${s.left}${pileNote} · 还可再排 ${available}（点一下 +1）`;
  if (arranged > 0) return `已安排 ${arranged}/${s.left}${pileNote} · 还可再排 ${available}`;
  return `院子共 ${s.left} 次「${s.cmd}」${pileNote} · 点一下清 1 次`;
}

/** 同名多堆障碍（开挖地基后 2 堆土）的醒目提示：避免清完一堆以为挖完了 */
const multiPileHint = computed(() => {
  const list = fullscreenClears.value;
  const multi = list.find((s) => (s.piles || 1) > 1 && (s.left > 0 || s.arranged > 0));
  if (!multi) return '';
  const n = multi.piles || 2;
  if (multi.arranged > 0 && multi.available <= 0) {
    return `院子里有 ${n} 堆「${multi.cmd}」（共 ${multi.left} 次），已全部排进队列——挖完这一波才算清空，中途弹出新次数是正常的`;
  }
  return `院子里有 ${n} 堆「${multi.cmd}」要清（共 ${multi.left} 次）。用「清完」一次排满；若挖完一堆后还剩，系统会提示继续挖——不是没挖到`;
});

/** 已安排进度文案：「挖土 已安排 12/19」；障碍数为 0 时只报队列条数 */
const primaryArrangeText = computed(() => {
  const list = fullscreenClears.value;
  if (!list.length) return '';
  const s = list.find((x) => x.busy || x.arranged > 0) || null;
  if (!s || !s.arranged) return '';
  if (s.left <= 0) return `${s.cmd} 队列中 ×${s.arranged}`;
  return `${s.cmd} 已安排 ${s.arranged}/${s.left}`;
});

/** 队列里该指令的条数（进行中不计，模板上 ×(1+n)） */
function queueCountFor(cmd) {
  const c = String(cmd || '').trim();
  if (!c || !props.queue?.queueCmd) return 0;
  return props.queue.queueCmd === c ? Number(props.queue.queueCount || 0) : 0;
}

/** 另一类清障正在进行：禁用本按钮（挖土进行中禁用割草，反之亦然） */
function isOtherClearBusy(cmd) {
  const c = String(cmd || '').trim();
  if (c !== '挖土' && c !== '割草') return false;
  const busy = String(props.queue?.busyClearCmd || '').trim();
  if (!busy || busy === c) return false;
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
  () => [props.step, isHouseConstructing.value],
  ([now, constructing], [before]) => {
    if (!anim.enabled) return;
    // 进度跳步高亮
    if (before !== undefined && now !== before) {
      flashing.value = true;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flashing.value = false; }, anim.flashMs);
    }
    // 建成瞬间（读条刚结束）开始撒花；施工中不撒
    if (now >= total && !constructing) {
      if (!celebrating.value) {
        celebrating.value = true;
        clearTimeout(celebrateTimer);
        celebrateTimer = setTimeout(() => { celebrating.value = false; }, anim.celebrateMs);
      }
    } else if (constructing) {
      celebrating.value = false;
      clearTimeout(celebrateTimer);
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
  animation: hbg-fall 5.2s linear var(--d) forwards;
}
.hbg-confetti span:nth-child(even) { background: linear-gradient(180deg, #7ee8fa, #4ea3ff); }
/* 第二波：延后落下，撑满 6 秒庆祝窗口 */
.hbg-confetti span:nth-child(3n) { animation-delay: calc(var(--d) + 1.4s); }
.hbg-confetti span:nth-child(4n) { animation-delay: calc(var(--d) + 2.6s); }

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
  0% { transform: translateY(0) rotate(0deg); opacity: 0; }
  8% { opacity: 1; }
  85% { opacity: 1; }
  100% { transform: translateY(min(42vh, 360px)) rotate(480deg); opacity: 0; }
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
  .hbg-btn.primary.big.on,
  .sb-shovel,
  .sb-hoe,
  .sb-hammer,
  .tr-blade,
  .tr-brick,
  .hm-nail,
  .sb-grass-cut i,
  .sb-dig-chips i {
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
  justify-content: center;
  border: none;
  border-radius: 0;
  padding: 48px 16px 24px;
  /* 黄昏→白昼的天空：随进度从冷色工地感过渡到暖色落成感 */
  background: linear-gradient(180deg, #0c1830 0%, #152a48 38%, #1e4a3a 72%, #2d5a32 100%);
  overflow: hidden;
  box-shadow: none;
}

/* 院子场景 + 指令面板：整组垂直居中，宽屏不再整块贴底 */
.hbg-stage {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  max-height: 100%;
  /* 给顶栏留出空间，避免返回按钮压住院子 */
  padding-top: 48px;
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

/* 地块（院子）：在 stage 内流式排布，紧贴指令面板上方 */
.sb-lot {
  position: relative;
  width: min(560px, 86vw);
  height: min(32vh, 260px);
  min-height: 160px;
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

/* ============================================================
   施工工具动画（纯 CSS，按 toolAnimClass 切换）
   ============================================================ */
.sb-tools {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 5;
  overflow: hidden;
}
.sb-tool {
  position: absolute;
  opacity: 0;
  transition: opacity 0.25s ease;
}

/* ---- 铲子（挖土） ---- */
.sb-shovel {
  left: 58%;
  bottom: 28%;
  width: 36px;
  height: 72px;
  transform-origin: 50% 85%;
}
.sb-shovel .sh-handle {
  position: absolute;
  left: 50%;
  bottom: 18px;
  width: 5px;
  height: 48px;
  margin-left: -2px;
  border-radius: 3px;
  background: linear-gradient(180deg, #c4a070, #8b5a3a);
}
.sb-shovel .sh-handle::before {
  content: '';
  position: absolute;
  top: -6px;
  left: 50%;
  width: 14px;
  height: 8px;
  margin-left: -7px;
  border: 3px solid #8b5a3a;
  border-bottom: none;
  border-radius: 8px 8px 0 0;
}
.sb-shovel .sh-blade {
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 22px;
  height: 22px;
  margin-left: -11px;
  background: linear-gradient(145deg, #c0c8d0, #7a8490);
  clip-path: polygon(10% 0%, 90% 0%, 100% 55%, 50% 100%, 0% 55%);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}
.t-dig .sb-shovel {
  opacity: 1;
  animation: sb-dig-strike 0.9s ease-in-out infinite;
}

/* ---- 锄头（除草） ---- */
.sb-hoe {
  left: 38%;
  bottom: 30%;
  width: 50px;
  height: 56px;
  transform-origin: 70% 90%;
}
.sb-hoe .ho-handle {
  position: absolute;
  right: 8px;
  bottom: 4px;
  width: 4px;
  height: 48px;
  border-radius: 2px;
  background: linear-gradient(180deg, #d4b07a, #9a6a3a);
  transform: rotate(-28deg);
  transform-origin: 50% 100%;
}
.sb-hoe .ho-head {
  position: absolute;
  left: 4px;
  bottom: 10px;
  width: 22px;
  height: 10px;
  border-radius: 2px 6px 6px 2px;
  background: linear-gradient(180deg, #b8c0c8, #6a7480);
  transform: rotate(-28deg);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}
.t-weed .sb-hoe {
  opacity: 1;
  animation: sb-hoe-chop 1.1s ease-in-out infinite;
}
.t-weed .sb-grass-cut {
  opacity: 1;
}
.sb-grass-cut {
  position: absolute;
  left: 32%;
  bottom: 28%;
  width: 40px;
  height: 24px;
  opacity: 0;
}
.sb-grass-cut i {
  position: absolute;
  bottom: 0;
  width: 5px;
  height: 10px;
  border-radius: 2px 2px 0 0;
  background: #5a9a40;
  opacity: 0;
}
.sb-grass-cut .gc1 { left: 0; animation: sb-grass-fly 1.1s ease-out infinite 0s; }
.sb-grass-cut .gc2 { left: 10px; height: 8px; animation: sb-grass-fly 1.1s ease-out infinite 0.08s; }
.sb-grass-cut .gc3 { left: 20px; animation: sb-grass-fly 1.1s ease-out infinite 0.16s; }
.sb-grass-cut .gc4 { left: 28px; height: 7px; animation: sb-grass-fly 1.1s ease-out infinite 0.24s; }
.sb-grass-cut .gc5 { left: 36px; animation: sb-grass-fly 1.1s ease-out infinite 0.32s; }

/* ---- 砌刀 + 砖（建造地基） ---- */
.sb-trowel {
  left: 46%;
  bottom: 26%;
  width: 64px;
  height: 40px;
}
.sb-trowel .tr-blade {
  position: absolute;
  right: 0;
  bottom: 14px;
  width: 28px;
  height: 10px;
  border-radius: 2px 8px 8px 2px;
  background: linear-gradient(180deg, #d0d6de, #8a929c);
  transform-origin: 0% 50%;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
}
.sb-trowel .tr-brick {
  position: absolute;
  bottom: 0;
  width: 18px;
  height: 10px;
  border-radius: 2px;
  background: linear-gradient(180deg, #c47850, #a05838);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.15);
}
.sb-trowel .b1 { left: 2px; }
.sb-trowel .b2 { left: 22px; bottom: 2px; }
.sb-trowel .b3 { left: 42px; }
.t-pour .sb-trowel {
  opacity: 1;
}
.t-pour .tr-blade {
  animation: sb-trowel-spread 1.2s ease-in-out infinite;
}
.t-pour .tr-brick {
  animation: sb-brick-set 1.2s ease-in-out infinite;
}
.t-pour .b2 { animation-delay: 0.15s; }
.t-pour .b3 { animation-delay: 0.3s; }

/* ---- 锤子 + 钉（建造房子） ---- */
.sb-hammer {
  left: 62%;
  bottom: 38%;
  width: 48px;
  height: 52px;
  transform-origin: 30% 90%;
}
.sb-hammer .hm-handle {
  position: absolute;
  left: 10px;
  bottom: 0;
  width: 5px;
  height: 40px;
  border-radius: 3px;
  background: linear-gradient(180deg, #d4a860, #8b5a3a);
  transform: rotate(-12deg);
}
.sb-hammer .hm-head {
  position: absolute;
  left: 0;
  top: 4px;
  width: 26px;
  height: 14px;
  border-radius: 3px;
  background: linear-gradient(180deg, #c8d0d8, #6a7480);
  transform: rotate(-12deg);
  box-shadow: 0 2px 3px rgba(0, 0, 0, 0.3);
}
.sb-hammer .hm-head::after {
  content: '';
  position: absolute;
  right: -6px;
  top: 3px;
  width: 8px;
  height: 8px;
  border-radius: 0 3px 3px 0;
  background: #8a929c;
}
.sb-hammer .hm-nail {
  position: absolute;
  left: 28px;
  bottom: 22px;
  width: 3px;
  height: 12px;
  background: linear-gradient(180deg, #e8d090, #b09050);
  border-radius: 1px 1px 0 0;
}
.t-hammer .sb-hammer {
  opacity: 1;
  animation: sb-hammer-strike 0.7s ease-in-out infinite;
}
.t-hammer .hm-nail {
  animation: sb-nail-drive 0.7s ease-in-out infinite;
}

/* ---- 挖出土块飞溅 ---- */
.sb-dig-chips {
  position: absolute;
  left: 54%;
  bottom: 30%;
  width: 30px;
  height: 28px;
  opacity: 0;
}
.sb-dig-chips i {
  position: absolute;
  bottom: 0;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #6b4a26;
  opacity: 0;
}
.t-dig .sb-dig-chips {
  opacity: 1;
}
.t-dig .sb-dig-chips .dc1 { left: 4px; animation: sb-chip-fly 0.9s ease-out infinite 0s; }
.t-dig .sb-dig-chips .dc2 { left: 12px; width: 4px; height: 4px; animation: sb-chip-fly 0.9s ease-out infinite 0.12s; }
.t-dig .sb-dig-chips .dc3 { left: 18px; animation: sb-chip-fly 0.9s ease-out infinite 0.24s; }
.t-dig .sb-dig-chips .dc4 { left: 24px; width: 3px; height: 3px; animation: sb-chip-fly 0.9s ease-out infinite 0.36s; }

/* ---- 工具关键帧 ---- */
@keyframes sb-dig-strike {
  0%, 100% { transform: rotate(-8deg) translateY(0); }
  35% { transform: rotate(18deg) translateY(10px); }
  55% { transform: rotate(12deg) translateY(6px); }
}
@keyframes sb-hoe-chop {
  0%, 100% { transform: rotate(0deg) translateY(0); }
  40% { transform: rotate(22deg) translateY(8px); }
  60% { transform: rotate(14deg) translateY(4px); }
}
@keyframes sb-grass-fly {
  0% { opacity: 0; transform: translate(0, 0) rotate(0deg); }
  20% { opacity: 1; }
  100% { opacity: 0; transform: translate(var(--gx, 8px), -18px) rotate(50deg); }
}
.sb-grass-cut .gc1 { --gx: -10px; }
.sb-grass-cut .gc2 { --gx: 4px; }
.sb-grass-cut .gc3 { --gx: 14px; }
.sb-grass-cut .gc4 { --gx: -4px; }
.sb-grass-cut .gc5 { --gx: 18px; }
@keyframes sb-trowel-spread {
  0%, 100% { transform: rotate(0deg) translateX(0); }
  50% { transform: rotate(-18deg) translateX(-6px); }
}
@keyframes sb-brick-set {
  0%, 100% { opacity: 0.5; transform: translateY(6px); }
  40%, 70% { opacity: 1; transform: translateY(0); }
}
@keyframes sb-hammer-strike {
  0%, 100% { transform: rotate(-20deg); }
  45% { transform: rotate(8deg); }
  60% { transform: rotate(2deg); }
}
@keyframes sb-nail-drive {
  0%, 100% { transform: translateY(0); opacity: 1; }
  50% { transform: translateY(6px); opacity: 0.7; }
}

/* 院子栅栏：贴在 stage 内院子顶沿 */
.sb-fence {
  position: absolute;
  left: 50%;
  /* 院子高度 + 一点重叠，让桩落在草地顶边 */
  top: calc(min(32vh, 260px) - 10px);
  transform: translateX(-50%);
  width: min(620px, 92vw);
  max-width: 92vw;
  display: flex;
  justify-content: space-between;
  padding: 0 2%;
  box-sizing: border-box;
  z-index: 1;
  pointer-events: none;
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

/* ---- 指令面板（stage 内，紧接院子下方） ---- */
.hbg-panel {
  position: relative;
  z-index: 2;
  width: min(600px, 100%);
  margin: 0 auto;
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
/* 已有数量：不足偏暗、够了偏绿 */
.hbg-mat em {
  font-style: normal;
  font-size: 11px;
  color: #8fa3c0;
  font-variant-numeric: tabular-nums;
  margin-left: 2px;
}
.hbg-mat.ok {
  border-color: rgba(72, 200, 130, 0.45);
  background: rgba(72, 200, 130, 0.1);
}
.hbg-mat.ok em {
  color: #6ddea0;
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

/* 清障区：剩余次数醒目，一键清完更突出 */
.hbg-clears {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 12px;
}
.hbg-clear {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 14px;
  font-size: 13px;
  border-radius: 12px;
  border: 1px solid rgba(120, 170, 230, 0.28);
  background: rgba(30, 48, 72, 0.45);
  color: #e8f1ff;
}
.hbg-clear.on {
  border-color: rgba(78, 163, 255, 0.55);
  background: rgba(30, 60, 100, 0.5);
  font-weight: 700;
}
.hbg-clear-left {
  font-size: 11px;
  color: #ffd76a;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.hbg-clear-all {
  padding: 9px 16px;
  font-size: 13px;
  font-weight: 800;
  border-radius: 12px;
  border: 1px solid rgba(255, 180, 84, 0.45);
  background: linear-gradient(120deg, rgba(255, 180, 84, 0.22), rgba(255, 140, 60, 0.18));
  color: #ffd79a;
}
.hbg-multipile-hint {
  flex: 1 1 100%;
  margin: 0;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px dashed rgba(255, 215, 106, 0.35);
  background: rgba(255, 215, 106, 0.08);
  color: #ffe9a8;
  font-size: 12px;
  line-height: 1.45;
}
.hbg-clear-all:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(255, 160, 60, 0.25);
}
.hbg-clear:disabled,
.hbg-clear-all:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.hbg-clear-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  width: 100%;
}
.hbg-clear-track {
  position: relative;
  width: 100%;
  height: 18px;
  margin: -2px 0 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  overflow: hidden;
}
.hbg-clear-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, rgba(78, 163, 255, 0.35), rgba(56, 211, 159, 0.55));
  transition: width 0.35s ease;
}
.hbg-clear-track span {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 700;
  color: #e8f1ff;
  letter-spacing: 0.2px;
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
