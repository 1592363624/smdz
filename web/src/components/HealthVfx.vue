<template>
  <!-- 全屏血量/死亡特效层：fixed 定位、pointer-events:none，绝不拦截点击 -->
  <div class="hv-root" :class="rootClass" aria-hidden="true">
    <!-- 受击快闪：低血量时再次受伤，屏幕边缘 100ms 红闪后回归呼吸 -->
    <div v-if="hitFlash" :key="'hit-' + hitFlash" class="hv-hit"></div>

    <!-- 死亡瞬时帧：全屏暗红一闪（前 100ms 全亮），与死亡状态变化同步触发 -->
    <div v-if="deathFlash" :key="'df-' + deathFlash" class="hv-death-flash"></div>

    <!-- 低血量持续态：左/右/下三边内发光呼吸（顶部是导航栏，不覆盖）；
         30~20% 暗红慢呼吸 / 20~10% 正红中速 / <10% 深血色频闪 + 噪点 -->
    <template v-if="showEdges">
      <div class="hv-edge hv-edge-left"></div>
      <div class="hv-edge hv-edge-right"></div>
      <div class="hv-edge hv-edge-bottom"></div>
      <!-- 濒死噪点：细微颗粒抖动，只做氛围，不遮挡文字 -->
      <div v-if="tier === 3" class="hv-noise"></div>
    </template>

    <!-- 死亡持续态：整体压暗 + 血色暗角 + 两侧强效红光带 + 底部上升血色粒子；
         复活时切 hv-collapse-* 动画：特效从四周向中心收束消退（0.5s） -->
    <template v-if="isDead || reviving">
      <div class="hv-dim" :class="{ 'hv-collapse-fade': reviving }"></div>
      <div class="hv-vignette" :class="{ 'hv-collapse-fade': reviving }"></div>
      <div class="hv-band hv-band-left" :class="{ 'hv-out-left': reviving }"></div>
      <div class="hv-band hv-band-right" :class="{ 'hv-out-right': reviving }"></div>
      <div class="hv-particles" :class="{ 'hv-collapse-fade': reviving }">
        <span
          v-for="p in particles"
          :key="p.id"
          class="hv-particle"
          :style="{
            left: p.left + 'vw',
            width: p.size + 'px',
            height: p.size * 2.2 + 'px',
            animationDuration: p.dur + 's',
            animationDelay: p.delay + 's',
            '--pv-drift': p.drift + 'px',
            '--pv-op': p.op,
          }"
        ></span>
      </div>
    </template>
  </div>
</template>

<script setup>
/**
 * 血量预警 / 死亡状态 全屏特效层
 *
 * 数据源：playerStore 快照（hp / maxHp / buffs），由 ChatView 传入。
 * - 低血量分层预警：30~20% 暗红慢呼吸(2s) / 20~10% 正红中速(1.2s) / <10% 深血色频闪+噪点；
 *   光效集中在左/右/下三边边缘向中心渐变（顶部为导航栏不覆盖），最亮处仅边缘 ~10px。
 * - 受击联动：低血量期间 hp 再次下降 → 边缘 100ms 红闪（hp 监听驱动，覆盖所有伤害来源）。
 * - 死亡三段式：瞬时暗红帧(100ms) → 持续态(压暗+暗角+红光带+血色粒子) → 复活收束(0.5s)。
 * - 死亡判定与战斗系统同口径：hp<=0 且增益「卷土重来」未过期不算真死
 *   （原版 战斗相关.ecode L5182-5184，expireAt=0 为永久增益）。
 * - 强度档位由 ui store 的 hpVfxLevel 驱动（simple/standard/strong，localStorage 持久化）：
 *   简约档无屏幕边缘光效与受击闪，仅保留左侧血条闪烁；死亡持续态各档位均保留（状态感知优先）。
 *
 * 无障碍与性能：图层不吃点击；命中 prefers-reduced-motion 时停用全部动画只留静态光。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useUiStore } from '../stores/ui';
import { serverNow } from '../utils/serverClock';

const props = defineProps({
  /** buildPlayerInfo 快照（与 PlayerStatusPanel 同源） */
  info: { type: Object, default: null },
});

const ui = useUiStore();
const level = computed(() => ui.hpVfxLevel || 'standard');

const num = (v) => Number(v) || 0;

const hpPct = computed(() => {
  const max = num(props.info?.maxHp);
  return max > 0 ? (num(props.info.hp) / max) * 100 : 100;
});

/** 「卷土重来」增益未过期 → hp<=0 不算真死（与战斗系统豁免口径一致） */
const hasComeback = computed(() => {
  const buffs = Array.isArray(props.info?.buffs) ? props.info.buffs : [];
  const now = serverNow();
  return buffs.some(
    (b) => b && (b.name ?? b.名称) === '卷土重来' && (!num(b.expireAt) || num(b.expireAt) > now),
  );
});

const isDead = computed(() => hpPct.value <= 0 && !hasComeback.value);

/** 预警档位：0=安全，1=30~20%，2=20~10%，3=濒死(<10%)；死亡后由死亡层接管，归零 */
const tier = computed(() => {
  if (isDead.value) return 0;
  const pct = hpPct.value;
  if (pct <= 10) return 3;
  if (pct <= 20) return 2;
  if (pct <= 30) return 1;
  return 0;
});

// ---------- 受击快闪（低血量时 hp 下降触发，160ms 动画） ----------
const hitFlash = ref(0);
let hitTimer = null;
watch(
  () => num(props.info?.hp),
  (nv, ov) => {
    if (ov === undefined || nv >= ov || isDead.value) return;
    if (tier.value <= 0 || level.value === 'simple') return;
    hitFlash.value += 1;
    clearTimeout(hitTimer);
    hitTimer = setTimeout(() => (hitFlash.value = 0), 160);
  },
);

// ---------- 死亡三段式 ----------
const deathFlash = ref(0);
const reviving = ref(false);
const particles = ref([]);
let deathTimer = null;
let reviveTimer = null;

/** 生成一批底部上升粒子：数量少、透明度高、错峰起飞（负延迟），只做氛围 */
function spawnParticles() {
  const arr = [];
  for (let i = 0; i < 12; i++) {
    arr.push({
      id: i,
      left: 4 + Math.random() * 92, // vw，横向铺开但避开极端边缘
      size: 2.5 + Math.random() * 3, // px
      dur: 7 + Math.random() * 7, // s，缓慢上升
      delay: -Math.random() * 12, // 负延迟：进场即处于中段，避免集体起飞
      drift: (Math.random() - 0.5) * 120, // px，轻微横向漂移
      op: 0.22 + Math.random() * 0.28, // 峰值透明度，保持低存在感
    });
  }
  particles.value = arr;
}

watch(
  isDead,
  (dead, old) => {
    // 同步 body 标记：右侧信息面板/聊天区弱红染色（styles.css 按 body 类挂样式）
    document.body.classList.toggle('smdz-hp-dead', dead);
    if (dead) {
      reviving.value = false;
      spawnParticles();
      // 首次挂载即处于死亡（如刷新页面）不补放瞬时帧，避免无意义重播
      if (old !== undefined && !old) {
        deathFlash.value += 1;
        clearTimeout(deathTimer);
        deathTimer = setTimeout(() => (deathFlash.value = 0), 420);
      }
    } else if (old !== undefined && old) {
      // 复活过渡：保持死亡层 0.5s，播放「四周向中心收束消退」后再卸载
      reviving.value = true;
      clearTimeout(reviveTimer);
      reviveTimer = setTimeout(() => (reviving.value = false), 520);
    }
  },
  { immediate: true },
);

// ---------- 视图开关 ----------
const showEdges = computed(
  () => !isDead.value && !reviving.value && tier.value > 0 && level.value !== 'simple',
);

const rootClass = computed(() => [
  'hv-lv-' + level.value,
  'hv-t' + tier.value,
  { 'hv-dead': isDead.value || reviving.value },
]);

onBeforeUnmount(() => {
  document.body.classList.remove('smdz-hp-dead');
  clearTimeout(hitTimer);
  clearTimeout(deathTimer);
  clearTimeout(reviveTimer);
});
</script>

<style scoped>
/* ===== 图层：铺满视口、不吃点击；层级低于系统公告(200)/更新弹窗(300) ===== */
.hv-root {
  position: fixed;
  inset: 0;
  z-index: 150;
  pointer-events: none;
  overflow: hidden;
}

/* ===== 档位变量：mult=强度倍率，w=边缘光宽度 ===== */
.hv-lv-standard {
  --hv-mult: 1;
  --hv-w: 110px;
}
.hv-lv-strong {
  --hv-mult: 1.6;
  --hv-w: 160px;
}
.hv-lv-simple {
  --hv-mult: 0;
  --hv-w: 90px;
}

/* ===== 分层配色与节奏：t1 暗红慢呼吸 / t2 正红中速 / t3 深血色频闪 ===== */
.hv-t1 {
  --hv-rgb: 155 32 32;
  --hv-dur: 2s;
  --hv-op: 0.3;
}
.hv-t2 {
  --hv-rgb: 239 68 68;
  --hv-dur: 1.2s;
  --hv-op: 0.5;
}
.hv-t3 {
  --hv-rgb: 146 15 15;
  --hv-dur: 0.5s;
  --hv-op: 0.75;
}

/* ===== 三边内发光：光从屏幕边缘向中心渐变，最亮处集中在边缘 ~10px ===== */
.hv-edge {
  position: absolute;
  opacity: 0;
}
.hv-edge-left {
  left: 0;
  top: 0;
  bottom: 0;
  width: var(--hv-w);
  background: linear-gradient(90deg, rgb(var(--hv-rgb)) 0%, transparent 100%);
  animation: hv-breathe var(--hv-dur) ease-in-out infinite;
}
.hv-edge-right {
  right: 0;
  top: 0;
  bottom: 0;
  width: var(--hv-w);
  background: linear-gradient(270deg, rgb(var(--hv-rgb)) 0%, transparent 100%);
  animation: hv-breathe var(--hv-dur) ease-in-out infinite;
}
.hv-edge-bottom {
  left: 0;
  right: 0;
  bottom: 0;
  height: calc(var(--hv-w) * 0.9);
  background: linear-gradient(0deg, rgb(var(--hv-rgb)) 0%, transparent 100%);
  animation: hv-breathe var(--hv-dur) ease-in-out infinite;
}
/* 呼吸：最暗 25% → 最亮档位上限，节奏由 --hv-dur 控制 */
@keyframes hv-breathe {
  0%,
  100% {
    opacity: calc(var(--hv-op) * var(--hv-mult) * 0.25);
  }
  50% {
    opacity: calc(var(--hv-op) * var(--hv-mult));
  }
}
/* 濒死频闪：快速跳变（非平滑呼吸），节奏感知即可判断危险程度 */
.hv-t3 .hv-edge {
  animation: hv-strobe 0.5s linear infinite;
}
@keyframes hv-strobe {
  0% {
    opacity: 0.12;
  }
  22% {
    opacity: calc(var(--hv-op) * var(--hv-mult));
  }
  38% {
    opacity: 0.2;
  }
  55% {
    opacity: calc(var(--hv-op) * var(--hv-mult) * 0.85);
  }
  72% {
    opacity: 0.15;
  }
  88% {
    opacity: calc(var(--hv-op) * var(--hv-mult) * 0.65);
  }
}

/* ===== 濒死噪点：细微颗粒抖动（feTurbulence 内联 SVG，平铺 140px） ===== */
.hv-noise {
  position: absolute;
  inset: -20px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E");
  background-size: 140px 140px;
  mix-blend-mode: overlay;
  opacity: 0.14;
  animation: hv-noise-jitter 0.34s steps(2, end) infinite;
}
@keyframes hv-noise-jitter {
  0% {
    transform: translate(0, 0);
    opacity: 0.12;
  }
  50% {
    transform: translate(-8px, 6px);
    opacity: 0.2;
  }
  100% {
    transform: translate(5px, -7px);
    opacity: 0.13;
  }
}

/* ===== 受击快闪：边缘径向红光 100ms 快闪后回归呼吸 ===== */
.hv-hit {
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at center, rgba(220, 38, 38, 0) 52%, rgba(220, 38, 38, 0.5) 100%);
  animation: hv-hit 0.16s ease-out forwards;
}
@keyframes hv-hit {
  0% {
    opacity: 0;
  }
  30% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

/* ===== 死亡瞬时帧：全屏暗红一闪（前 ~100ms 全亮后淡出），低亮度不刺眼 ===== */
.hv-death-flash {
  position: absolute;
  inset: 0;
  background: rgba(60, 4, 4, 0.66);
  animation: hv-death-flash 0.42s ease-out forwards;
}
@keyframes hv-death-flash {
  0% {
    opacity: 0;
  }
  24% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

/* ===== 死亡持续态：压暗 + 血色暗角 + 两侧红光带 ===== */
.hv-dim {
  position: absolute;
  inset: 0;
  background: rgba(10, 2, 2, 0.32);
  animation: hv-fade-in 0.8s ease-out both;
}
.hv-vignette {
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse 75% 70% at 50% 50%, transparent 52%, rgba(64, 4, 4, 0.62) 100%);
  animation: hv-fade-in 1s ease-out both;
}
@keyframes hv-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.hv-band {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 190px;
}
.hv-band-left {
  left: 0;
  background: linear-gradient(90deg, rgba(140, 10, 10, 0.72), rgba(140, 10, 10, 0) 100%);
  animation: hv-band-pulse 2.6s ease-in-out infinite;
}
.hv-band-right {
  right: 0;
  background: linear-gradient(270deg, rgba(140, 10, 10, 0.72), rgba(140, 10, 10, 0) 100%);
  animation: hv-band-pulse 2.6s ease-in-out infinite;
}
@keyframes hv-band-pulse {
  0%,
  100% {
    opacity: 0.55;
  }
  50% {
    opacity: 1;
  }
}

/* ===== 血色粒子：底部缓慢上升，数量少、透明度高，不遮挡中间文字 ===== */
.hv-particles {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.hv-particle {
  position: absolute;
  bottom: -10px;
  border-radius: 50%;
  background: rgba(220, 38, 38, 0.55);
  box-shadow: 0 0 6px rgba(220, 38, 38, 0.5);
  opacity: 0;
  animation: hv-rise linear infinite;
}
@keyframes hv-rise {
  0% {
    transform: translate(0, 0) scale(1);
    opacity: 0;
  }
  12% {
    opacity: var(--pv-op, 0.4);
  }
  100% {
    transform: translate(var(--pv-drift, 0px), -72vh) scale(0.35);
    opacity: 0;
  }
}

/* ===== 复活过渡：0.5s 从四周向中心收束消退 ===== */
.hv-collapse-fade {
  animation: hv-fade-out 0.5s ease-in forwards !important;
}
.hv-out-left {
  animation: hv-out-left 0.5s ease-in forwards !important;
}
.hv-out-right {
  animation: hv-out-right 0.5s ease-in forwards !important;
}
@keyframes hv-fade-out {
  to {
    opacity: 0;
  }
}
@keyframes hv-out-left {
  to {
    opacity: 0;
    transform: translateX(-60%);
  }
}
@keyframes hv-out-right {
  to {
    opacity: 0;
    transform: translateX(60%);
  }
}

/* ===== 简约档：死亡持续态保留但收敛（压暗/暗角减半，无噪点） ===== */
.hv-lv-simple .hv-dim {
  background: rgba(10, 2, 2, 0.16);
}
.hv-lv-simple .hv-vignette {
  background: radial-gradient(ellipse 75% 70% at 50% 50%, transparent 58%, rgba(64, 4, 4, 0.34) 100%);
}
.hv-lv-simple .hv-noise {
  display: none;
}

/* ===== 无障碍：尊重系统「减少动效」偏好 ===== */
@media (prefers-reduced-motion: reduce) {
  .hv-edge,
  .hv-noise,
  .hv-band,
  .hv-particle {
    animation: none !important;
  }
  .hv-edge {
    opacity: calc(var(--hv-op) * var(--hv-mult) * 0.6);
  }
  .hv-noise {
    opacity: 0.08;
  }
  .hv-particle {
    display: none;
  }
}
</style>
