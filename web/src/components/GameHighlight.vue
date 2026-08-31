<template>
  <!-- 高光时刻图层：固定定位、不拦截点击，所有内容纯展示 -->
  <div class="gh-layer" aria-live="polite">
    <!-- 冲击波：每次触发播放一次全屏径向闪光，约 0.75s 后自动移除 -->
    <div
      v-for="f in flashes"
      :key="'f' + f.id"
      class="gh-flash"
      :class="'gh-t-' + f.type"
    ></div>

    <!-- 卡片堆：同时最多 3 条，新的在下、旧的自动上移消散 -->
    <div class="gh-stack">
      <transition-group name="gh-pop">
        <div
          v-for="item in items"
          :key="item.id"
          class="gh-card"
          :class="'gh-t-' + item.type"
        >
          <!-- 横贯卡片的流光 -->
          <span class="gh-sheen" aria-hidden="true"></span>
          <!-- 顶部能量条 -->
          <span class="gh-beam" aria-hidden="true"></span>

          <!-- 左侧徽章：旋转光环 + 图标 + 迸发粒子 -->
          <div class="gh-emblem" aria-hidden="true">
            <span class="gh-halo"></span>
            <span class="gh-ring"></span>
            <span class="gh-icon">{{ metaOf(item).icon }}</span>
            <span
              v-for="n in SPARK_COUNT"
              :key="'s' + n"
              class="gh-spark"
              :style="sparkStyle(n)"
            ></span>
          </div>

          <!-- 右侧文案 -->
          <div class="gh-text">
            <div class="gh-label">{{ item.title || metaOf(item).label }}</div>
            <div v-if="item.names && item.names.length" class="gh-names">
              {{ item.names.join(' · ') }}
            </div>
            <div v-if="item.detail" class="gh-detail">{{ item.detail }}</div>
            <div v-if="item.rewards && item.rewards.length" class="gh-rewards">
              <span
                v-for="(r, ri) in item.rewards"
                :key="'r' + ri"
                class="gh-reward"
                :style="{ animationDelay: 0.34 + ri * 0.09 + 's' }"
              >＋ {{ r }}</span>
            </div>
          </div>
        </div>
      </transition-group>
    </div>
  </div>
</template>

<script setup>
/**
 * 游戏高光时刻动画层
 *
 * 触发方式（由父组件调用 push）：
 *   highlightRef.value.push({ type: 'task-complete', title: '任务达成', names: [...], rewards: [...] })
 *
 * 视觉构成（对应下方 <style> 同名动画）：
 *   - gh-flash  全屏径向冲击波，0.75s 一次，营造"屏幕被点亮"的瞬时感
 *   - gh-pop    卡片弹性入场/退场（cubic-bezier 回弹，带轻微 Z 轴翻转）
 *   - gh-sheen  斜向白色流光横扫卡片，模拟金属/水晶反光
 *   - gh-beam   卡片顶部能量条由中间向两侧展开
 *   - gh-halo   徽章背后的呼吸光晕
 *   - gh-ring   徽章外圈锥形渐变光环，持续旋转
 *   - gh-spark  8 枚粒子按圆周角度向外迸发（--a 角度 / --d 距离）
 *   - gh-label  主标题渐变文字 + 微光泽流动
 *
 * 无障碍与性能：
 *   - 图层 pointer-events: none，绝不遮挡聊天区与输入框
 *   - 命中 prefers-reduced-motion 时关闭全部动画，仅做淡入淡出
 *   - 卡片上限 3 条，超出即淘汰最旧一条，避免刷屏堆积
 */
import { ref, onUnmounted } from 'vue';
import { highlightMeta } from '../utils/gameHighlight';

/** 同屏最多展示的卡片数 */
const MAX_ITEMS = 5;
/** 单条卡片的停留时长（毫秒） */
const LIFE_MS = 6600;
/** 冲击波存活时长（毫秒），需与 CSS .gh-flash 动画时长一致 */
const FLASH_MS = 750;
/** 徽章迸发粒子数量 */
const SPARK_COUNT = 8;

const items = ref([]);
const flashes = ref([]);
let seq = 0;
/** id → timeout，用于组件卸载时统一清理，避免定时器泄漏 */
const timers = new Map();

function metaOf(item) {
  return highlightMeta(item.type);
}

/**
 * 计算第 n 枚粒子的飞散方向与距离
 * 角度按圆周均分并额外偏移 18°，避免粒子正对上下左右显得呆板
 */
function sparkStyle(n) {
  const angle = ((n - 1) / SPARK_COUNT) * 360 + 18;
  // 18~30px 之间抖动，让迸发更自然；上限需小于徽章中心到卡片左内边距的距离，
  // 否则粒子会被卡片 overflow:hidden 切掉
  const distance = 18 + ((n * 7) % 13);
  return {
    '--a': `${angle}deg`,
    '--d': `${distance}px`,
    animationDelay: `${0.16 + (n % 3) * 0.05}s`,
  };
}

/** 登记一个定时器并在触发后自动清理 */
function track(id, fn, ms) {
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms),
  );
}

/**
 * 推送一条高光提示
 * @param {object} payload { type, title?, detail?, names?, rewards? }
 */
function push(payload) {
  if (!payload || !payload.type) return;
  const id = ++seq;
  items.value.push({ id, ...payload });

  // 超出上限：立即淘汰最旧的一条，保证刷屏时画面不糊
  while (items.value.length > MAX_ITEMS) {
    const oldest = items.value.shift();
    const t = timers.get(oldest.id);
    if (t) {
      clearTimeout(t);
      timers.delete(oldest.id);
    }
  }

  track(id, () => remove(id), LIFE_MS);

  // 冲击波：与卡片同步播放一次，强化"大事发生"的瞬时冲击
  const flashId = id;
  flashes.value.push({ id: flashId, type: payload.type });
  track('flash-' + flashId, () => {
    flashes.value = flashes.value.filter((f) => f.id !== flashId);
  }, FLASH_MS);
}

function remove(id) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  items.value = items.value.filter((i) => i.id !== id);
}

onUnmounted(() => {
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
});

// 暴露给父组件：ChatView 收到 socket 事件或文本兜底命中时调用 push
defineExpose({ push });
</script>

<style scoped>
/* ===== 图层：铺满视口、不吃点击 ===== */
.gh-layer {
  position: fixed;
  inset: 0;
  /* 层级：高于侧滑面板(100)，低于系统公告/Toast(200)与更新弹窗(300)，
     保证重要的强制弹窗永远压得住高光动画 */
  z-index: 180;
  pointer-events: none;
  overflow: hidden;
}

/* ===== 全屏冲击波 ===== */
.gh-flash {
  position: absolute;
  inset: 0;
  animation: gh-flash 0.75s ease-out forwards;
}
.gh-flash.gh-t-task-complete {
  background: radial-gradient(circle at 50% 20%, rgba(251, 191, 36, 0.3) 0%, rgba(251, 191, 36, 0) 62%);
}
.gh-flash.gh-t-task-accept {
  background: radial-gradient(circle at 50% 20%, rgba(34, 211, 238, 0.28) 0%, rgba(34, 211, 238, 0) 62%);
}
.gh-flash.gh-t-title {
  background: radial-gradient(circle at 50% 20%, rgba(236, 72, 153, 0.3) 0%, rgba(139, 92, 246, 0.12) 40%, rgba(139, 92, 246, 0) 66%);
}
.gh-flash.gh-t-level-up {
  background: radial-gradient(circle at 50% 20%, rgba(251, 146, 60, 0.3) 0%, rgba(244, 63, 94, 0) 62%);
}
@keyframes gh-flash {
  0% {
    opacity: 0;
    transform: scale(1.06);
  }
  18% {
    opacity: 1;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(1);
  }
}

/* ===== 卡片堆：顶部居中，避开页面顶栏 ===== */
.gh-stack {
  position: absolute;
  /* 让开聊天区顶栏（含刘海屏安全区），卡片从顶栏下方浮出 */
  top: calc(58px + var(--safe-top, 0px));
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
}

/* ===== 卡片本体 ===== */
.gh-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: min(400px, 92vw);
  padding: 12px 18px 12px 14px;
  border-radius: 16px;
  overflow: hidden;
  background: linear-gradient(135deg, rgba(30, 22, 62, 0.94) 0%, rgba(18, 14, 40, 0.96) 100%);
  border: 1px solid var(--gh-line, rgba(251, 191, 36, 0.55));
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.04) inset,
    0 12px 34px rgba(0, 0, 0, 0.55),
    0 0 26px var(--gh-glow, rgba(251, 191, 36, 0.3));
  backdrop-filter: blur(6px);
  will-change: transform, opacity;
}

/* 类型配色：--gh-line 描边 / --gh-glow 外发光 / --gh-a、--gh-b 标题渐变两端 */
.gh-card.gh-t-task-complete {
  --gh-line: rgba(251, 191, 36, 0.6);
  --gh-glow: rgba(251, 191, 36, 0.34);
  --gh-a: #fde68a;
  --gh-b: #f59e0b;
  --gh-c: #fbbf24;
}
.gh-card.gh-t-task-accept {
  --gh-line: rgba(34, 211, 238, 0.55);
  --gh-glow: rgba(34, 211, 238, 0.3);
  --gh-a: #a5f3fc;
  --gh-b: #06b6d4;
  --gh-c: #22d3ee;
}
.gh-card.gh-t-title {
  --gh-line: rgba(236, 72, 153, 0.6);
  --gh-glow: rgba(236, 72, 153, 0.32);
  --gh-a: #fbcfe8;
  --gh-b: #c084fc;
  --gh-c: #ec4899;
}
.gh-card.gh-t-level-up {
  --gh-line: rgba(251, 146, 60, 0.6);
  --gh-glow: rgba(251, 146, 60, 0.32);
  --gh-a: #fed7aa;
  --gh-b: #f43f5e;
  --gh-c: #fb923c;
}

/* 斜向流光：横扫一次即停，模拟高光划过金属表面 */
.gh-sheen {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    105deg,
    transparent 20%,
    rgba(255, 255, 255, 0.05) 38%,
    rgba(255, 255, 255, 0.34) 50%,
    rgba(255, 255, 255, 0.05) 62%,
    transparent 80%
  );
  transform: translateX(-110%);
  animation: gh-sheen 1.15s cubic-bezier(0.22, 0.61, 0.36, 1) 0.2s 1 forwards;
}
@keyframes gh-sheen {
  to {
    transform: translateX(110%);
  }
}

/* 顶部能量条：由中心向两侧展开 */
.gh-beam {
  position: absolute;
  top: 0;
  left: 50%;
  height: 2px;
  width: 0;
  transform: translateX(-50%);
  border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--gh-c), transparent);
  box-shadow: 0 0 10px var(--gh-c);
  animation: gh-beam 0.62s cubic-bezier(0.16, 1, 0.3, 1) 0.06s forwards;
}
@keyframes gh-beam {
  to {
    width: 100%;
  }
}

/* ===== 徽章 ===== */
.gh-emblem {
  position: relative;
  flex: 0 0 auto;
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
}
/* 呼吸光晕 */
.gh-halo {
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--gh-glow) 0%, transparent 70%);
  animation: gh-halo 1.5s ease-in-out infinite;
}
@keyframes gh-halo {
  0%,
  100% {
    opacity: 0.55;
    transform: scale(0.92);
  }
  50% {
    opacity: 1;
    transform: scale(1.12);
  }
}
/* 旋转光环：锥形渐变 + 中心遮罩形成圆环 */
.gh-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(from 0deg, transparent 0deg, var(--gh-c) 90deg, transparent 200deg);
  animation: gh-spin 2.4s linear infinite;
  mask: radial-gradient(circle, transparent 58%, #000 60%);
  -webkit-mask: radial-gradient(circle, transparent 58%, #000 60%);
}
@keyframes gh-spin {
  to {
    transform: rotate(360deg);
  }
}
.gh-icon {
  position: relative;
  font-size: 23px;
  line-height: 1;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.6));
  animation: gh-icon-in 0.62s cubic-bezier(0.16, 1.5, 0.3, 1) 0.1s both;
}
@keyframes gh-icon-in {
  0% {
    transform: scale(0.2) rotate(-45deg);
    opacity: 0;
  }
  100% {
    transform: scale(1) rotate(0deg);
    opacity: 1;
  }
}
/* 迸发粒子：按 --a 角度向外飞，途中缩小消失 */
.gh-spark {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 4px;
  margin: -2px 0 0 -2px;
  border-radius: 50%;
  background: var(--gh-c);
  box-shadow: 0 0 6px var(--gh-c);
  opacity: 0;
  transform: rotate(var(--a)) translateX(6px);
  animation: gh-spark 0.9s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
@keyframes gh-spark {
  0% {
    opacity: 0;
    transform: rotate(var(--a)) translateX(4px) scale(0.3);
  }
  30% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: rotate(var(--a)) translateX(var(--d)) scale(0.2);
  }
}

/* ===== 文案 ===== */
.gh-text {
  flex: 1 1 auto;
  min-width: 0;
}
.gh-label {
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 2px;
  background: linear-gradient(90deg, var(--gh-a), var(--gh-b), var(--gh-a));
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: var(--gh-a); /* 不支持 background-clip 时的兜底 */
  animation: gh-shimmer 2.6s linear infinite;
}
@keyframes gh-shimmer {
  to {
    background-position: 200% 0;
  }
}
.gh-names {
  margin-top: 3px;
  font-size: 13px;
  font-weight: 600;
  color: #f1f1f9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gh-detail {
  margin-top: 2px;
  font-size: 12px;
  color: var(--gh-c);
  font-weight: 700;
}
.gh-rewards {
  margin-top: 5px;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.gh-reward {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--gh-a);
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid var(--gh-line);
  animation: gh-reward-in 0.42s cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes gh-reward-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.85);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* ===== 入场 / 退场 ===== */
.gh-pop-enter-active {
  animation: gh-card-in 0.56s cubic-bezier(0.16, 1.24, 0.3, 1) both;
}
.gh-pop-leave-active {
  position: absolute;
  animation: gh-card-out 0.34s ease-in both;
}
@keyframes gh-card-in {
  0% {
    opacity: 0;
    transform: translateY(-30px) scale(0.72) rotateX(-28deg);
    filter: brightness(2.4);
  }
  60% {
    opacity: 1;
    filter: brightness(1.15);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1) rotateX(0deg);
    filter: brightness(1);
  }
}
@keyframes gh-card-out {
  to {
    opacity: 0;
    transform: translateY(-16px) scale(0.9);
    filter: blur(2px);
  }
}
/* 退场时脱离文档流，让下方卡片平滑上移而不是突然跳位 */
.gh-pop-move {
  transition: transform 0.34s cubic-bezier(0.16, 1, 0.3, 1);
}

/* ===== 手机端：整体收紧，避免遮挡聊天区 ===== */
@media (max-width: 640px) {
  .gh-stack {
    top: calc(50px + var(--safe-top, 0px));
    gap: 8px;
  }
  .gh-card {
    width: min(340px, 94vw);
    padding: 10px 14px 10px 11px;
    gap: 10px;
    border-radius: 14px;
  }
  .gh-emblem {
    width: 38px;
    height: 38px;
  }
  .gh-icon {
    font-size: 19px;
  }
  .gh-label {
    font-size: 14px;
    letter-spacing: 1.5px;
  }
  .gh-names {
    font-size: 12px;
  }
}

/* ===== 无障碍：尊重系统「减少动效」偏好 ===== */
@media (prefers-reduced-motion: reduce) {
  .gh-flash,
  .gh-sheen,
  .gh-beam,
  .gh-halo,
  .gh-ring,
  .gh-icon,
  .gh-spark,
  .gh-label,
  .gh-reward,
  .gh-pop-enter-active,
  .gh-pop-leave-active {
    animation: none !important;
  }
  .gh-spark {
    display: none;
  }
  .gh-pop-enter-active,
  .gh-pop-leave-active {
    transition: opacity 0.25s ease;
  }
  .gh-pop-enter-from,
  .gh-pop-leave-to {
    opacity: 0;
  }
}
</style>
