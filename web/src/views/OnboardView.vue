<template>
  <div class="ob-root">
    <!-- ===== 背景层：星域 / 星云 / 能量网格 ===== -->
    <div class="ob-bg" aria-hidden="true">
      <div class="ob-nebula"></div>
      <div class="ob-nebula ob-nebula--b"></div>
      <div class="ob-grid"></div>
      <div class="ob-stars"></div>
      <div class="ob-vignette"></div>
    </div>

    <!-- ===== 载入中 ===== -->
    <div v-if="loading" class="ob-center">
      <div class="ob-rune ob-rune--spin"></div>
      <p class="ob-loading-text">正在解析契约名录…</p>
    </div>

    <!-- ===== 阶段一：序章 ===== -->
    <section v-else-if="stage === 'prologue'" class="ob-prologue">
      <div class="ob-crest">
        <svg viewBox="0 0 120 120" fill="none">
          <circle cx="60" cy="60" r="52" stroke="url(#crestGrad)" stroke-width="1" stroke-dasharray="4 6" />
          <circle cx="60" cy="60" r="42" stroke="url(#crestGrad)" stroke-width="1.5" opacity=".7" />
          <path d="M60 12 L74 46 L110 60 L74 74 L60 108 L46 74 L10 60 L46 46 Z"
                stroke="url(#crestGrad)" stroke-width="1.2" opacity=".85" />
          <circle cx="60" cy="60" r="9" fill="url(#crestGrad)" opacity=".9" />
          <defs>
            <linearGradient id="crestGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#8b5cf6" />
              <stop offset="50%" stop-color="#06b6d4" />
              <stop offset="100%" stop-color="#ec4899" />
            </linearGradient>
          </defs>
        </svg>
      </div>

      <h1 class="ob-title">
        <span class="ob-title-main">使魔大战</span>
        <span class="ob-title-num">III</span>
      </h1>
      <p class="ob-subtitle">逆流次元 · 契约之始</p>

      <p class="ob-lead">
        这是一段以文字驱动的多人在线冒险。你将与一位使魔缔结契约，
        以它为身、以它为刃，穿越次元残响中的地图，采集、战斗、建造与成长。
      </p>

      <ul class="ob-features">
        <li v-for="f in FEATURES" :key="f.title" class="ob-feature">
          <span class="ob-feature-icon">{{ f.icon }}</span>
          <div class="ob-feature-body">
            <h3>{{ f.title }}</h3>
            <p>{{ f.desc }}</p>
          </div>
        </li>
      </ul>

      <div class="ob-metrics">
        <div class="ob-metric">
          <strong>{{ familiars.length || '—' }}</strong>
          <span>位可契约使魔</span>
        </div>
        <div class="ob-metric">
          <strong>4</strong>
          <span>系属性伤害</span>
        </div>
        <div class="ob-metric">
          <strong>3</strong>
          <span>层战斗池</span>
        </div>
        <div class="ob-metric">
          <strong>∞</strong>
          <span>公屏共战</span>
        </div>
      </div>

      <button class="ob-cta ob-cta--primary" type="button" @click="stage = 'select'">
        <span>开 始 契 约</span>
      </button>
      <p class="ob-hint">需先选定一位使魔，契约成立后方可进入冒险</p>
    </section>

    <!-- ===== 阶段二：选择使魔 ===== -->
    <section v-else-if="stage === 'select'" class="ob-select">
      <header class="ob-select-head">
        <div class="ob-select-title">
          <p class="ob-step">第 一 步 · 缔 结 契 约</p>
          <h2>选择你的使魔</h2>
          <p class="ob-select-desc">
            每位使魔拥有独立的专属技能、被动特性与成长曲线。契约后可更换，但受冷却限制——
            请选择与你风格相合的一位。
          </p>
        </div>

        <div class="ob-filters">
          <input
            v-model.trim="keyword"
            class="ob-search"
            type="search"
            placeholder="搜索使魔名称 / 技能 / 优点"
            maxlength="20"
          />
          <div class="ob-chips">
            <button
              v-for="r in roleFilters"
              :key="r"
              type="button"
              class="ob-chip"
              :class="{ 'is-active': roleFilter === r }"
              @click="roleFilter = r"
            >{{ r }}</button>
          </div>
        </div>
      </header>

      <div class="ob-select-body">
        <!-- 卡片列表 -->
        <div class="ob-list">
          <button
            v-for="f in filteredFamiliars"
            :key="f.name"
            type="button"
            class="ob-card"
            :class="{ 'is-selected': selected && selected.name === f.name }"
            :style="cardStyle(f)"
            @click="pick(f)"
          >
            <span class="ob-card-seq">{{ String(f.specialSeq).padStart(2, '0') }}</span>
            <span class="ob-card-name">{{ f.name }}</span>
            <span class="ob-card-skill">{{ f.uniqueSkill || '—' }}</span>
            <span class="ob-card-tags">
              <em v-if="f.specialty" class="ob-tag ob-tag--elem">{{ elemLabel(f) }}</em>
              <em v-for="r in f.roleTags" :key="r" class="ob-tag">{{ r }}</em>
            </span>
            <span class="ob-card-diff" :title="`操作难度：${f.difficulty || '未知'}`">
              <i v-for="n in 5" :key="n" :class="{ 'is-on': n <= f.difficultyLevel }"></i>
            </span>
          </button>

          <p v-if="filteredFamiliars.length === 0" class="ob-empty">
            没有符合条件的使魔，试试更换关键词或筛选条件
          </p>
        </div>

        <!-- 详情栏（桌面常驻 / 移动端抽屉） -->
        <aside class="ob-detail" :class="{ 'is-open': detailOpen }">
          <button class="ob-detail-close" type="button" @click="detailOpen = false">✕</button>

          <template v-if="selected">
            <div class="ob-detail-head" :style="{ '--el': elemColor(selected), '--el-glow': elemGlow(selected) }">
              <span class="ob-detail-sigil">{{ elemIcon(selected) }}</span>
              <div>
                <h3>{{ selected.name }}</h3>
                <p class="ob-detail-sub">
                  <span v-if="selected.specialty">{{ elemLabel(selected) }}专精</span>
                  <span v-if="selected.roleTags.length">{{ selected.roleTags.join(' · ') }}</span>
                  <span>契约序号 {{ String(selected.specialSeq).padStart(2, '0') }}</span>
                </p>
              </div>
            </div>

            <div v-if="selected.uniqueSkill" class="ob-detail-skill">
              <span class="ob-detail-label">专属技能</span>
              <strong>{{ selected.uniqueSkill }}</strong>
            </div>

            <div class="ob-detail-row">
              <span class="ob-detail-label">操作难度</span>
              <span class="ob-detail-diff">
                <i v-for="n in 5" :key="n" :class="{ 'is-on': n <= selected.difficultyLevel }"></i>
                <em>{{ selected.difficulty || '未知' }}</em>
              </span>
            </div>

            <div v-if="selected.merits.length" class="ob-detail-block">
              <span class="ob-detail-label">优势</span>
              <div class="ob-merits">
                <em v-for="m in selected.merits" :key="m">{{ m }}</em>
              </div>
            </div>

            <div v-if="selected.flavor" class="ob-detail-block">
              <span class="ob-detail-label">档案</span>
              <p class="ob-detail-text ob-detail-text--dim">{{ selected.flavor }}</p>
            </div>

            <div v-if="selected.trait" class="ob-detail-block">
              <span class="ob-detail-label">特性</span>
              <p class="ob-detail-text">{{ selected.trait }}</p>
            </div>

            <div v-if="selected.skillDesc" class="ob-detail-block">
              <span class="ob-detail-label">技能说明</span>
              <p class="ob-detail-text">{{ selected.skillDesc }}</p>
            </div>

            <div v-if="selected.awaken.length" class="ob-detail-block">
              <span class="ob-detail-label">好感成长<em class="ob-detail-note">契约后逐档解锁</em></span>
              <ol class="ob-awaken">
                <li v-for="(a, i) in selected.awaken" :key="i">{{ a }}</li>
              </ol>
            </div>

            <button class="ob-cta ob-cta--primary ob-cta--block" type="button" @click="askSeal">
              <span>与 {{ selected.name }} 缔结契约</span>
            </button>
          </template>

          <div v-else class="ob-detail-placeholder">
            <div class="ob-rune"></div>
            <p>从左侧名录中选择一位使魔<br />查看它的完整档案</p>
          </div>
        </aside>
      </div>
    </section>

    <!-- ===== 阶段三：确认仪式 ===== -->
    <div v-if="confirming && selected" class="ob-overlay" @click.self="confirming = false">
      <div class="ob-confirm" :style="{ '--el': elemColor(selected), '--el-glow': elemGlow(selected) }">
        <p class="ob-confirm-eyebrow">契 约 确 认</p>
        <div class="ob-confirm-sigil">{{ elemIcon(selected) }}</div>
        <h3>{{ selected.name }}</h3>
        <p class="ob-confirm-text">
          契约为<span>不可逆</span>的起点：你的初始数据将以此使魔为基准重置，
          并获得它的专属技能与被动特性。日后可更换，但受冷却限制。
        </p>
        <ul class="ob-confirm-list">
          <li><span>初始好感</span><em>{{ SEAL_AFFINITY_NOTE(selected) }}</em></li>
          <li><span>专属技能</span><em>{{ selected.uniqueSkill || '—' }}</em></li>
          <li><span>角色定位</span><em>{{ selected.roleTags.join(' · ') || '—' }}</em></li>
        </ul>
        <div class="ob-confirm-actions">
          <button class="ob-cta ob-cta--ghost" type="button" @click="confirming = false">再想想</button>
          <button class="ob-cta ob-cta--primary" type="button" :disabled="submitting" @click="seal">
            <span>确认缔结</span>
          </button>
        </div>
      </div>
    </div>

    <!-- ===== 阶段四：契约成立 ===== -->
    <div v-if="stage === 'sealing' || stage === 'done'" class="ob-overlay ob-overlay--seal">
      <div class="ob-seal">
        <div class="ob-seal-ring" :class="{ 'is-done': stage === 'done' }">
          <svg viewBox="0 0 240 240" fill="none">
            <circle class="ob-seal-c1" cx="120" cy="120" r="104" stroke="url(#sealGrad)" stroke-width="1.5" stroke-dasharray="6 10" />
            <circle class="ob-seal-c2" cx="120" cy="120" r="82" stroke="url(#sealGrad)" stroke-width="1" stroke-dasharray="2 8" />
            <circle class="ob-seal-c3" cx="120" cy="120" r="112" stroke="#ec4899" stroke-width=".8" opacity=".5" />
            <polygon points="120,30 195,165 45,165" stroke="url(#sealGrad)" stroke-width="1" opacity=".7" />
            <polygon points="120,210 45,75 195,75" stroke="url(#sealGrad)" stroke-width="1" opacity=".45" />
            <defs>
              <linearGradient id="sealGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#8b5cf6" />
                <stop offset="50%" stop-color="#06b6d4" />
                <stop offset="100%" stop-color="#ec4899" />
              </linearGradient>
            </defs>
          </svg>
          <span class="ob-seal-sigil">{{ selected ? elemIcon(selected) : '✦' }}</span>
        </div>

        <template v-if="stage === 'sealing'">
          <h3 class="ob-seal-title">正在缔结契约</h3>
          <p class="ob-seal-step">{{ sealStepText }}</p>
          <div class="ob-seal-bar"><i></i></div>
        </template>

        <template v-else>
          <h3 class="ob-seal-title ob-seal-title--done">契 约 成 立</h3>
          <p class="ob-seal-sub">
            自此，你的名字是 <strong>{{ selected && selected.name }}</strong>
          </p>
          <p v-if="sealMessage" class="ob-seal-msg">{{ sealMessage }}</p>
          <button class="ob-cta ob-cta--primary" type="button" @click="enterGame">
            <span>进 入 冒 险</span>
          </button>
        </template>
      </div>
    </div>

    <!-- ===== 错误提示 ===== -->
    <div v-if="sealError" class="ob-toast">{{ sealError }}</div>
  </div>
</template>

<script setup>
/**
 * 使魔契约引导页（新手首屏仪式）
 *
 * 定位：未选择使魔（player.type 为空）的玩家进入主界面前的全屏引导页。
 * 数据与写入均复用指令侧的唯一实现，本页只负责呈现与编排：
 *   - 只读：GET /game/familiar/gate → GameService.getFirstFamiliarGate 同源同口径
 *     （可选集合 = 静态定义 !noSummon 过滤后的原始序，与 QQ 两列编号菜单一一对应）
 *   - 写入：POST /game/familiar/choose → FamiliarSystemService.chooseFirstFamiliar
 *     （内部即「选择使魔确认<名称>」，清空初始数据 / 写角色 / 领教程任务 / 升级提示）
 * 已开局的玩家访问本页会被直接送回主界面，避免出现第二条换使魔通道。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { familiarApi } from '../api';

const router = useRouter();

/** 元素归类 → 展示色/图标。仅为前端展示层分类，与任何战斗计算无关。 */
const ELEMENTS = {
  thunder: { label: '雷电', color: '#fbbf24', glow: 'rgba(251, 191, 36, .38)', icon: '⚡' },
  fire: { label: '火焰', color: '#fb7185', glow: 'rgba(251, 113, 133, .38)', icon: '🔥' },
  ice: { label: '冰霜', color: '#22d3ee', glow: 'rgba(34, 211, 238, .38)', icon: '❄' },
  physical: { label: '物理', color: '#a78bfa', glow: 'rgba(167, 139, 250, .38)', icon: '⚔' },
  none: { label: '无属性', color: '#94a3b8', glow: 'rgba(148, 163, 184, .32)', icon: '✦' },
};

// icon 用大写财务数字而非 emoji：emoji 依赖系统字体（部分符号在 Windows/安卓会缺字），
// 而徽章式数字在任何终端都能稳定渲染，也更贴合「契约仪式」的调性。
const FEATURES = [
  {
    icon: '壹',
    title: '契约使魔',
    desc: '二十余位使魔各握专属技能与被动特性，契约、召唤、更换、命名皆由你决定。',
  },
  {
    icon: '贰',
    title: '探索与采集',
    desc: '在互联的地图间移动，采集资源、击败怪物，用掉落与经验堆叠成长。',
  },
  {
    icon: '叁',
    title: '装备与强化',
    desc: '四系属性伤害对撞生命、装甲、护盾三层战斗池；装备、植入体、增幅器层层强化。',
  },
  {
    icon: '肆',
    title: '家园与经营',
    desc: '圈地建屋、制造装配、驾驶载具，把采集与生产逐步交给自动化。',
  },
];

/** 步骤文案（缔结演出用，纯前端节奏控制，不代表真实后端阶段） */
const SEAL_STEPS = ['铭刻真名…', '共鸣元素回路…', '缔结契约标记…', '唤醒使魔意识…'];

const loading = ref(true);
const stage = ref('prologue'); // prologue | select | sealing | done
const familiars = ref([]);
const keyword = ref('');
const roleFilter = ref('全部');
const selected = ref(null);
const detailOpen = ref(false);
const confirming = ref(false);
const submitting = ref(false);
const sealStepText = ref(SEAL_STEPS[0]);
const sealMessage = ref('');
const sealError = ref('');
let sealTimers = [];

/** 角色筛选列表：由数据实际出现的定位动态汇总，避免硬编码与原版口径脱节 */
const roleFilters = computed(() => {
  const set = new Set();
  for (const f of familiars.value) for (const r of f.roleTags || []) set.add(r);
  return ['全部', ...Array.from(set)];
});

const filteredFamiliars = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return familiars.value.filter((f) => {
    if (roleFilter.value !== '全部' && !(f.roleTags || []).includes(roleFilter.value)) {
      return false;
    }
    if (!kw) return true;
    const hay = [
      f.name,
      f.uniqueSkill,
      f.specialty,
      f.difficulty,
      ...(f.merits || []),
      ...(f.roleTags || []),
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(kw);
  });
});

function elemOf(f) {
  return ELEMENTS[f?.elementKey] || ELEMENTS.none;
}
function elemColor(f) {
  return elemOf(f).color;
}
function elemGlow(f) {
  return elemOf(f).glow;
}
function elemIcon(f) {
  return elemOf(f).icon;
}
function elemLabel(f) {
  return elemOf(f).label;
}
/** 卡片主题：把元素色通过 CSS 变量注入，避免为每种元素写一套类名 */
function cardStyle(f) {
  return { '--el': elemColor(f), '--el-glow': elemGlow(f) };
}

/** 「初始好感」提示：兰音在原版为 20，其余为 1（与 selectFamiliar 首次选择分支一致） */
function SEAL_AFFINITY_NOTE(f) {
  const isLanyin = f && (f.name === '兰音' || String(f.specialSeq) === '23');
  return isLanyin ? '20（该使魔特例）' : '1';
}

function pick(f) {
  selected.value = f;
  detailOpen.value = true;
}

function askSeal() {
  if (!selected.value || submitting.value) return;
  confirming.value = true;
}

/** 缔结演出：先播放节奏文案，再并行等待接口返回，两者都完成才进入「契约成立」 */
async function seal() {
  if (!selected.value || submitting.value) return;
  submitting.value = true;
  sealError.value = '';
  confirming.value = false;
  stage.value = 'sealing';
  sealStepText.value = SEAL_STEPS[0];
  clearSealTimers();
  SEAL_STEPS.forEach((text, i) => {
    if (i === 0) return;
    sealTimers.push(setTimeout(() => (sealStepText.value = text), i * 620));
  });
  const minShow = new Promise((resolve) => sealTimers.push(setTimeout(resolve, SEAL_STEPS.length * 620)));

  try {
    // 失败也走完整演出：用 allSettled 而非 all，避免请求早退把缔结动画拦腰截断
    // （否则错误提示会盖在只播了一半的演出上）。
    const settled = await Promise.allSettled([familiarApi.choose(selected.value.name), minShow]);
    const api = settled[0];
    // 演出节拍已走完，先清掉剩余步进定时器再切换阶段，避免残留回调改写已废弃文案
    clearSealTimers();

    if (api.status === 'fulfilled' && api.value?.success) {
      sealMessage.value = api.value.message || '';
      stage.value = 'done';
      // 契约成立后自动进入主界面；玩家主动点击按钮则立即进入
      sealTimers.push(setTimeout(enterGame, 2600));
    } else {
      stage.value = 'select';
      detailOpen.value = true;
      sealError.value =
        (api.status === 'fulfilled' ? api.value?.message : '') ||
        api.reason?.response?.data?.message ||
        api.reason?.message ||
        '契约未能建立，请稍后重试';
      sealTimers.push(setTimeout(() => (sealError.value = ''), 4200));
    }
  } finally {
    submitting.value = false;
  }
}

function enterGame() {
  clearSealTimers();
  router.replace('/chat');
}

function clearSealTimers() {
  for (const t of sealTimers) clearTimeout(t);
  sealTimers = [];
}

function onKeydown(e) {
  if (e.key !== 'Escape') return;
  if (confirming.value) {
    confirming.value = false;
  } else if (detailOpen.value) {
    detailOpen.value = false;
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  try {
    const res = await familiarApi.gate();
    const data = res?.data || {};
    // 已选择使魔（老玩家误入本页）→ 直接回主界面，本页不做任何写入
    if (!data.needsSelection) {
      router.replace('/chat');
      return;
    }
    familiars.value = Array.isArray(data.familiars) ? data.familiars : [];
  } catch {
    sealError.value = '契约名录加载失败，请刷新重试';
    setTimeout(() => (sealError.value = ''), 4000);
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  clearSealTimers();
});
</script>

<style scoped>
/* ===== 根容器：全屏、独立滚动，不影响主界面布局 ===== */
.ob-root {
  position: fixed;
  inset: 0;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--bg);
  color: var(--text);
  -webkit-overflow-scrolling: touch;
}

/* ===== 背景层 ===== */
.ob-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
}
.ob-nebula {
  position: absolute;
  top: -30%;
  left: -20%;
  width: 90vw;
  height: 90vw;
  max-width: 1100px;
  max-height: 1100px;
  border-radius: 50%;
  background: radial-gradient(circle at 40% 40%, rgba(139, 92, 246, 0.28), transparent 62%);
  filter: blur(20px);
  animation: ob-float 22s ease-in-out infinite;
}
.ob-nebula--b {
  top: auto;
  left: auto;
  right: -25%;
  bottom: -30%;
  background: radial-gradient(circle at 60% 60%, rgba(6, 182, 212, 0.22), transparent 62%);
  animation-duration: 28s;
  animation-direction: reverse;
}
.ob-grid {
  position: absolute;
  inset: -10%;
  background-image:
    linear-gradient(rgba(139, 92, 246, 0.07) 1px, transparent 1px),
    linear-gradient(90deg, rgba(139, 92, 246, 0.07) 1px, transparent 1px);
  background-size: 64px 64px;
  transform: perspective(600px) rotateX(58deg) translateY(12%);
  transform-origin: center bottom;
  opacity: 0.5;
}
.ob-stars {
  position: absolute;
  inset: -50%;
  background-image:
    radial-gradient(1px 1px at 20px 30px, rgba(255, 255, 255, 0.6) 50%, transparent 51%),
    radial-gradient(1px 1px at 130px 95px, rgba(196, 181, 253, 0.55) 50%, transparent 51%),
    radial-gradient(1.6px 1.6px at 210px 45px, rgba(103, 232, 249, 0.45) 50%, transparent 51%),
    radial-gradient(1px 1px at 300px 160px, rgba(255, 255, 255, 0.35) 50%, transparent 51%);
  background-size: 260px 210px, 320px 250px, 430px 320px, 520px 380px;
  animation: ob-drift 120s linear infinite;
  opacity: 0.5;
}
.ob-vignette {
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 50% 45%, transparent 35%, rgba(10, 10, 26, 0.85) 100%);
}
@keyframes ob-float {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(4%, 3%) scale(1.08); }
}
@keyframes ob-drift {
  from { transform: translate(0, 0); }
  to { transform: translate(-260px, -210px); }
}

/* ===== 载入中 ===== */
.ob-center {
  position: relative;
  z-index: 1;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
}
.ob-loading-text {
  color: var(--muted);
  font-size: 14px;
  letter-spacing: 2px;
}
.ob-rune {
  width: 74px;
  height: 74px;
  border-radius: 50%;
  border: 1px dashed var(--border-light);
  background: radial-gradient(circle, rgba(139, 92, 246, 0.2), transparent 70%);
  position: relative;
}
.ob-rune::after {
  content: '';
  position: absolute;
  inset: 12px;
  border-radius: 50%;
  border: 1px solid rgba(6, 182, 212, 0.4);
}
.ob-rune--spin {
  animation: ob-rotate 6s linear infinite;
}
@keyframes ob-rotate {
  to { transform: rotate(360deg); }
}

/* ===== 阶段一：序章 ===== */
.ob-prologue {
  position: relative;
  z-index: 1;
  max-width: 860px;
  margin: 0 auto;
  padding: clamp(28px, 7vh, 72px) 22px clamp(40px, 8vh, 80px);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  animation: ob-rise 0.7s ease both;
}
.ob-crest {
  width: clamp(84px, 14vw, 118px);
  margin-bottom: 22px;
  filter: drop-shadow(0 0 22px rgba(139, 92, 246, 0.35));
  animation: ob-pulse 4.5s ease-in-out infinite;
}
.ob-crest svg { width: 100%; display: block; }
@keyframes ob-pulse {
  0%, 100% { opacity: 0.85; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.04); }
}
.ob-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: clamp(30px, 7vw, 52px);
  line-height: 1.1;
  letter-spacing: 0.08em;
  font-weight: 700;
}
.ob-title-main {
  background: var(--accent-gradient-full);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}
.ob-title-num {
  font-size: clamp(20px, 4vw, 30px);
  color: var(--accent2);
  letter-spacing: 0.04em;
}
.ob-subtitle {
  margin-top: 10px;
  font-size: 13px;
  letter-spacing: 0.42em;
  color: var(--muted);
}
.ob-lead {
  margin-top: 26px;
  max-width: 620px;
  font-size: 14.5px;
  line-height: 2;
  color: var(--text-secondary);
}
.ob-features {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  width: 100%;
  margin-top: 34px;
}
.ob-feature {
  display: flex;
  gap: 12px;
  padding: 16px;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: linear-gradient(140deg, rgba(30, 26, 58, 0.72), rgba(20, 16, 42, 0.5));
  transition: border-color 0.25s ease, transform 0.25s ease;
}
.ob-feature:hover {
  border-color: var(--border-light);
  transform: translateY(-2px);
}
.ob-feature-icon {
  flex: none;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  font-size: 14px;
  font-weight: 600;
  color: var(--accent2);
  border: 1px solid rgba(6, 182, 212, 0.3);
  background: rgba(6, 182, 212, 0.08);
}
.ob-feature-body h3 {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 5px;
}
.ob-feature-body p {
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--muted);
}
.ob-metrics {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px 32px;
  margin-top: 32px;
}
.ob-metric {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 78px;
}
.ob-metric strong {
  font-size: 22px;
  font-weight: 700;
  background: var(--accent-gradient);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.ob-metric span {
  font-size: 11.5px;
  color: var(--muted-dark);
  letter-spacing: 1px;
}
.ob-hint {
  margin-top: 16px;
  font-size: 12px;
  color: var(--muted-dark);
}

/* ===== 通用按钮 ===== */
.ob-cta {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 46px;
  padding: 0 34px;
  border-radius: 12px;
  border: 1px solid transparent;
  font-size: 14.5px;
  font-weight: 600;
  letter-spacing: 0.14em;
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.25s ease, background 0.25s ease, opacity 0.2s ease;
  font-family: inherit;
}
.ob-cta--primary {
  margin-top: 30px;
  color: #fff;
  background: var(--accent-gradient);
  box-shadow: 0 10px 30px rgba(139, 92, 246, 0.32);
  overflow: hidden;
}
.ob-cta--primary::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, transparent 30%, rgba(255, 255, 255, 0.32) 50%, transparent 70%);
  background-size: 240% 100%;
  animation: ob-shimmer 3.2s linear infinite;
}
@keyframes ob-shimmer {
  from { background-position: 220% 0; }
  to { background-position: -60% 0; }
}
.ob-cta--primary:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 14px 38px rgba(139, 92, 246, 0.45);
}
.ob-cta--primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.ob-cta--ghost {
  color: var(--text-secondary);
  background: rgba(20, 16, 42, 0.7);
  border-color: var(--border);
}
.ob-cta--ghost:hover {
  border-color: var(--border-light);
  color: var(--text);
}
.ob-cta--block {
  width: 100%;
  margin-top: 22px;
}

/* ===== 阶段二：选择 ===== */
.ob-select {
  position: relative;
  z-index: 1;
  max-width: 1240px;
  margin: 0 auto;
  padding: clamp(20px, 4vh, 44px) 20px 40px;
  animation: ob-rise 0.6s ease both;
}
.ob-select-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 22px;
}
.ob-step {
  font-size: 11.5px;
  letter-spacing: 0.4em;
  color: var(--accent2);
  margin-bottom: 8px;
}
.ob-select-title h2 {
  font-size: clamp(21px, 3.4vw, 28px);
  font-weight: 700;
  letter-spacing: 0.04em;
}
.ob-select-desc {
  margin-top: 8px;
  max-width: 560px;
  font-size: 12.5px;
  line-height: 1.85;
  color: var(--muted);
}
.ob-filters {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-end;
}
.ob-search {
  width: 268px;
  max-width: 100%;
  padding: 10px 14px;
  border-radius: 11px;
  border: 1px solid var(--border);
  background: rgba(10, 10, 26, 0.72);
  color: var(--text);
  font-size: 13.5px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.22s ease, box-shadow 0.22s ease;
}
.ob-search:focus {
  border-color: rgba(6, 182, 212, 0.45);
  box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.1);
}
.ob-search::placeholder { color: var(--muted-dark); }
.ob-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  justify-content: flex-end;
}
.ob-chip {
  padding: 5px 13px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(20, 16, 42, 0.6);
  color: var(--muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s ease;
}
.ob-chip:hover { color: var(--text-secondary); border-color: var(--border-light); }
.ob-chip.is-active {
  color: #fff;
  border-color: transparent;
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.85), rgba(6, 182, 212, 0.8));
}

.ob-select-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 382px;
  gap: 22px;
  align-items: start;
}

/* 卡片列表 */
.ob-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: 12px;
}
.ob-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 15px 15px 13px;
  border-radius: 15px;
  border: 1px solid var(--border);
  background: linear-gradient(150deg, rgba(30, 26, 58, 0.78), rgba(16, 13, 34, 0.62));
  color: var(--text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: transform 0.22s ease, border-color 0.22s ease, box-shadow 0.28s ease;
}
/* 左侧元素色条 + 悬停光晕 */
.ob-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--el, var(--accent));
  opacity: 0.75;
}
.ob-card::after {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 88% 0%, var(--el-glow, rgba(139, 92, 246, 0.3)), transparent 62%);
  opacity: 0;
  transition: opacity 0.28s ease;
  pointer-events: none;
}
.ob-card:hover {
  transform: translateY(-3px);
  border-color: var(--el, var(--border-light));
  box-shadow: 0 12px 26px rgba(0, 0, 0, 0.42);
}
.ob-card:hover::after { opacity: 0.9; }
.ob-card.is-selected {
  border-color: var(--el, var(--accent));
  box-shadow: 0 0 0 1px var(--el, var(--accent)), 0 12px 30px rgba(0, 0, 0, 0.45);
}
.ob-card.is-selected::after { opacity: 0.85; }
.ob-card-seq {
  font-size: 11px;
  letter-spacing: 2px;
  color: var(--muted-dark);
}
.ob-card-name {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.03em;
}
.ob-card-skill {
  font-size: 12px;
  color: var(--el, var(--accent2));
  opacity: 0.92;
}
.ob-card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 3px;
}
.ob-tag {
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: rgba(10, 10, 26, 0.6);
  font-size: 11px;
  font-style: normal;
  color: var(--muted);
}
.ob-tag--elem {
  color: var(--el, var(--accent2));
  border-color: var(--el, var(--border-light));
}
.ob-card-diff {
  display: inline-flex;
  gap: 3px;
  margin-top: 4px;
}
.ob-card-diff i,
.ob-detail-diff i {
  width: 14px;
  height: 3px;
  border-radius: 2px;
  background: var(--bg4);
}
.ob-card-diff i.is-on,
.ob-detail-diff i.is-on {
  background: var(--accent-gradient);
}
.ob-empty {
  grid-column: 1 / -1;
  padding: 40px 0;
  text-align: center;
  color: var(--muted-dark);
  font-size: 13px;
}

/* 详情栏 */
.ob-detail {
  position: sticky;
  top: 20px;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  padding: 20px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: linear-gradient(165deg, rgba(20, 16, 42, 0.94), rgba(12, 10, 28, 0.9));
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(10px);
}
.ob-detail-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(10, 10, 26, 0.7);
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  display: none;
}
.ob-detail-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 60px 10px;
  text-align: center;
  color: var(--muted-dark);
  font-size: 12.5px;
  line-height: 1.9;
}
.ob-detail-head {
  display: flex;
  align-items: center;
  gap: 13px;
  padding-bottom: 15px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 15px;
}
.ob-detail-sigil {
  flex: none;
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: 13px;
  font-size: 22px;
  color: var(--el, var(--accent2));
  border: 1px solid var(--el, var(--border-light));
  background: radial-gradient(circle at 50% 40%, var(--el-glow, rgba(139, 92, 246, 0.28)), transparent 72%);
}
.ob-detail-head h3 {
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.ob-detail-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--muted);
}
.ob-detail-skill {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--el, var(--border));
  background: rgba(10, 10, 26, 0.55);
  margin-bottom: 14px;
}
.ob-detail-skill strong {
  font-size: 14px;
  color: var(--el, var(--accent2));
  font-weight: 600;
}
.ob-detail-label {
  font-size: 11.5px;
  letter-spacing: 1.4px;
  color: var(--muted-dark);
  text-transform: uppercase;
}
.ob-detail-note {
  margin-left: 6px;
  font-style: normal;
  letter-spacing: 0;
  color: var(--accent2);
  font-size: 10.5px;
}
.ob-detail-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 14px;
}
.ob-detail-diff {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.ob-detail-diff i { width: 20px; height: 4px; }
.ob-detail-diff em {
  margin-left: 7px;
  font-style: normal;
  font-size: 12px;
  color: var(--text-secondary);
}
.ob-detail-block {
  margin-bottom: 15px;
}
.ob-detail-block .ob-detail-label {
  display: block;
  margin-bottom: 7px;
}
.ob-detail-text {
  font-size: 12.5px;
  line-height: 1.9;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}
.ob-detail-text--dim { color: var(--muted); }
.ob-merits {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ob-merits em {
  padding: 3px 9px;
  border-radius: 7px;
  font-size: 11.5px;
  font-style: normal;
  color: var(--text-secondary);
  border: 1px solid var(--border-light);
  background: rgba(139, 92, 246, 0.1);
}
.ob-awaken {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.ob-awaken li {
  font-size: 12px;
  line-height: 1.85;
  color: var(--muted);
}

/* ===== 遮罩 / 确认仪式 ===== */
.ob-overlay {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: 22px;
  background: rgba(6, 5, 16, 0.82);
  backdrop-filter: blur(6px);
  animation: ob-fade 0.28s ease both;
}
.ob-confirm {
  width: min(440px, 100%);
  padding: 26px 24px 22px;
  border-radius: 18px;
  border: 1px solid var(--el, var(--border));
  background: linear-gradient(165deg, rgba(30, 26, 58, 0.97), rgba(14, 11, 30, 0.96));
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6), 0 0 40px var(--el-glow, rgba(139, 92, 246, 0.2));
  text-align: center;
  animation: ob-rise 0.35s ease both;
}
.ob-confirm-eyebrow {
  font-size: 11px;
  letter-spacing: 0.42em;
  color: var(--muted-dark);
}
.ob-confirm-sigil {
  width: 62px;
  height: 62px;
  margin: 14px auto 10px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  font-size: 27px;
  color: var(--el, var(--accent2));
  border: 1px solid var(--el, var(--border-light));
  background: radial-gradient(circle, var(--el-glow, rgba(139, 92, 246, 0.3)), transparent 72%);
  animation: ob-pulse 3.6s ease-in-out infinite;
}
.ob-confirm h3 {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.05em;
}
.ob-confirm-text {
  margin-top: 12px;
  font-size: 12.5px;
  line-height: 1.95;
  color: var(--muted);
}
.ob-confirm-text span {
  color: var(--accent3);
  font-weight: 600;
}
.ob-confirm-list {
  list-style: none;
  margin-top: 16px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.ob-confirm-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  font-size: 12.5px;
}
.ob-confirm-list span { color: var(--muted-dark); }
.ob-confirm-list em {
  font-style: normal;
  color: var(--text);
  text-align: right;
}
.ob-confirm-actions {
  display: flex;
  gap: 10px;
  margin-top: 20px;
}
.ob-confirm-actions .ob-cta {
  flex: 1;
  margin-top: 0;
  padding: 0 12px;
  letter-spacing: 0.08em;
}

/* ===== 缔结 / 成立 ===== */
.ob-overlay--seal { z-index: 30; }
.ob-seal {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  animation: ob-rise 0.4s ease both;
}
.ob-seal-ring {
  position: relative;
  width: min(240px, 62vw);
  aspect-ratio: 1;
  display: grid;
  place-items: center;
}
.ob-seal-ring svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.ob-seal-c1 { animation: ob-rotate 14s linear infinite; transform-origin: 120px 120px; }
.ob-seal-c2 { animation: ob-rotate 9s linear infinite reverse; transform-origin: 120px 120px; }
.ob-seal-c3 { animation: ob-rotate 20s linear infinite; transform-origin: 120px 120px; }
.ob-seal-ring.is-done { animation: ob-burst 0.7s ease both; }
@keyframes ob-burst {
  0% { transform: scale(0.86); filter: brightness(1.6); }
  60% { transform: scale(1.06); }
  100% { transform: scale(1); filter: brightness(1); }
}
.ob-seal-sigil {
  font-size: clamp(38px, 9vw, 58px);
  filter: drop-shadow(0 0 18px rgba(139, 92, 246, 0.6));
  animation: ob-pulse 3s ease-in-out infinite;
}
.ob-seal-title {
  margin-top: 22px;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.32em;
  color: var(--text-secondary);
}
.ob-seal-title--done {
  font-size: clamp(22px, 5vw, 30px);
  background: var(--accent-gradient-full);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.ob-seal-step {
  margin-top: 10px;
  font-size: 12.5px;
  letter-spacing: 0.16em;
  color: var(--accent2);
  min-height: 20px;
}
.ob-seal-bar {
  width: min(300px, 70vw);
  height: 3px;
  margin-top: 18px;
  border-radius: 2px;
  background: var(--bg4);
  overflow: hidden;
}
.ob-seal-bar i {
  display: block;
  height: 100%;
  width: 40%;
  border-radius: 2px;
  background: var(--accent-gradient);
  animation: ob-sweep 1.1s ease-in-out infinite;
}
@keyframes ob-sweep {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}
.ob-seal-sub {
  margin-top: 12px;
  font-size: 14px;
  color: var(--text-secondary);
}
.ob-seal-sub strong { color: var(--accent2); font-weight: 700; }
.ob-seal-msg {
  max-width: 460px;
  margin-top: 14px;
  padding: 12px 16px;
  border-radius: 12px;
  border: 1px solid var(--border-light);
  background: rgba(10, 10, 26, 0.6);
  font-size: 12.5px;
  line-height: 1.9;
  color: var(--muted);
  white-space: pre-wrap;
  text-align: left;
}

/* ===== 错误提示 ===== */
.ob-toast {
  position: fixed;
  left: 50%;
  bottom: 42px;
  transform: translateX(-50%);
  z-index: 40;
  max-width: min(440px, 88vw);
  padding: 11px 18px;
  border-radius: 11px;
  border: 1px solid rgba(239, 68, 68, 0.45);
  background: rgba(40, 12, 18, 0.94);
  color: #fecaca;
  font-size: 12.5px;
  text-align: center;
  animation: ob-rise 0.3s ease both;
}

@keyframes ob-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes ob-rise {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ===== 响应式：窄屏单列 + 详情抽屉 ===== */
@media (max-width: 1024px) {
  .ob-select-body {
    grid-template-columns: minmax(0, 1fr);
  }
  .ob-detail {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    top: auto;
    max-height: 82vh;
    border-radius: 18px 18px 0 0;
    border-left: none;
    border-right: none;
    border-bottom: none;
    transform: translateY(102%);
    transition: transform 0.34s cubic-bezier(0.22, 0.61, 0.36, 1);
    z-index: 25;
    padding-top: 26px;
    overscroll-behavior: contain;
    /* 收起时不可交互：抽屉只是移出视口，仍留在 DOM 中 */
    pointer-events: none;
  }
  .ob-detail.is-open {
    transform: translateY(0);
    box-shadow: 0 -14px 50px rgba(0, 0, 0, 0.62);
    pointer-events: auto;
  }
  .ob-detail-close { display: block; }
  .ob-detail-placeholder { display: none; }
  .ob-list { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
}
@media (max-width: 720px) {
  .ob-features { grid-template-columns: minmax(0, 1fr); }
  .ob-filters { align-items: stretch; width: 100%; }
  .ob-search { width: 100%; }
  .ob-chips { justify-content: flex-start; }
  .ob-metrics { gap: 12px 22px; }
  .ob-cta { padding: 0 24px; }
  .ob-card { padding: 13px 12px 11px; }
  .ob-card-name { font-size: 15px; }
}
/* 尊重系统「减少动态效果」偏好 */
@media (prefers-reduced-motion: reduce) {
  .ob-nebula,
  .ob-stars,
  .ob-crest,
  .ob-confirm-sigil,
  .ob-seal-sigil,
  .ob-rune--spin,
  .ob-seal-c1,
  .ob-seal-c2,
  .ob-seal-c3,
  .ob-cta--primary::after,
  .ob-seal-bar i {
    animation: none !important;
  }
}
</style>
