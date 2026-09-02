<!--
 * BattleCard.vue
 *
 * 功能：将服务端下发的「战斗结算纯文本」（攻击/炮击/地图战斗回合）在公屏中
 *       渲染成带「修真 × 科幻」风格动画的战斗卡片：伤害数字重击砸落、暴击迸发、
 *       击杀烙印、掉落战利品芯片、受击震屏等，替换单调的纯文本气泡。
 *
 * 设计约束与兼容性（与 RichSystemCard 相同的展示层原则）：
 * - 本组件仅是「展示层」增强——读原文做结构化展示，绝不改写原文内容。
 * - 后端与 AstrBot（QQ 等）仍走标准纯文本消息；解析失败时回退为原始文本直出。
 * - 文本解析逻辑在 utils/battleText.js（纯函数，正则与服务端战斗文案一一对应）。
 *
 * 动画说明：
 * - 所有动画均为 CSS 一次性入场动画（animation-fill-mode: both），通过 --d 自定义属性
 *   逐行错峰，避免消息流内多张卡片同时循环动画带来的性能压力。
 * - 尊重系统「减少动态效果」偏好（prefers-reduced-motion 时关闭动画）。
-->
<template>
  <div class="battle-card" :class="cardCls">
    <!-- 科幻边框四角 + 顶部能量流线 -->
    <i class="bc-corner tl"></i><i class="bc-corner tr"></i>
    <i class="bc-corner bl"></i><i class="bc-corner br"></i>
    <i class="bc-energy"></i>

    <!-- 头部：战斗标识 + 汇总徽章 -->
    <header class="bc-head">
      <span class="bc-hicon">⚔</span>
      <span class="bc-htitle">战斗结算</span>
      <span class="bc-badges">
        <span v-if="summary.damage > 0" class="bc-badge b-dmg">Σ {{ fmtNum(summary.damage) }}</span>
        <span v-if="summary.crits > 0" class="bc-badge b-crit">暴击 ×{{ summary.crits }}</span>
        <span v-if="summary.kills > 0" class="bc-badge b-kill">击杀 {{ summary.kills }}</span>
        <span v-if="summary.exp > 0" class="bc-badge b-exp">经验 +{{ fmtNum(summary.exp) }}</span>
        <span v-if="summary.incoming > 0" class="bc-badge b-in">受创 {{ fmtNum(summary.incoming) }}</span>
      </span>
    </header>

    <div class="bc-body">
      <template v-for="(seg, i) in segments" :key="i">
        <!-- 分隔线（召唤物攻击 / 怪物反击 / 战斗统计等小节标题） -->
        <div v-if="seg.kind === 'divider'" class="bc-divider" :style="dly(i)">
          <span class="bc-divider-line"></span>
          <span v-if="seg.title" class="bc-divider-title">{{ seg.title }}</span>
          <span class="bc-divider-line"></span>
        </div>

        <!-- 特效/增益触发芯片组（【棒棒糖】【火力】…） -->
        <div v-else-if="seg.kind === 'effects'" class="bc-effects" :style="dly(i)">
          <span
            v-for="(tag, ti) in seg.tags"
            :key="ti"
            class="bc-effect"
            :title="tag.desc || tag.name"
          >{{ tag.name }}<i v-if="tag.desc" class="bc-effect-desc">{{ tag.desc }}</i></span>
        </div>

        <!-- 命中行：出手文本 + 重击伤害数字 + 暴击/评级/三池分项 -->
        <div v-else-if="seg.kind === 'hit'" class="bc-hit" :class="['s-' + seg.side, dmgSize(seg), { 'is-crit': seg.crit }]" :style="dly(i)">
          <i v-if="seg.side === 'in'" class="bc-in-spike">▼</i>
          <div class="bc-hit-text">
            <template v-if="seg.counter || seg.glory">
              <span class="bc-attacker">{{ seg.attacker }}</span>
              <span v-if="seg.weapon" class="bc-weapon">〔{{ seg.weapon }}〕</span>
              <span v-if="seg.glory" class="bc-glory-tag">引爆【光荣弹】</span>
              <span class="bc-arrow">➤</span>
              <span class="bc-target">{{ seg.target }}</span>
            </template>
            <template v-else>
              <span v-if="seg.flavor" class="bc-flavor">{{ seg.flavor }} </span>
              <span class="bc-target">{{ seg.target }}</span>
            </template>
          </div>
          <div class="bc-dmg-row">
            <span class="bc-dmg">{{ fmtNum(seg.total) }}</span>
            <span v-if="seg.crit" class="bc-crit">暴击</span>
            <span v-if="seg.rating" class="bc-rating" :class="'r-' + seg.rating.level">{{ seg.rating.name }} {{ fmtNum(seg.rating.pct) }}%</span>
            <span v-if="seg.captured" class="bc-capture">捕捉中 · 剩余 {{ fmtNum(seg.captureHp) }}</span>
          </div>
          <div v-if="seg.pools.shield || seg.pools.armor || seg.pools.hp" class="bc-pools">
            <span v-if="seg.pools.shield" class="bc-pool p-sh">护盾 -{{ fmtNum(seg.pools.shield) }}</span>
            <span v-if="seg.pools.armor" class="bc-pool p-ar">装甲 -{{ fmtNum(seg.pools.armor) }}</span>
            <span v-if="seg.pools.hp" class="bc-pool p-hp">生命 -{{ fmtNum(seg.pools.hp) }}</span>
          </div>
          <div v-if="seg.extra && !seg.downed && !seg.rallied" class="bc-extra">{{ seg.extra }}</div>
          <div v-if="seg.downed" class="bc-extra x-down">✖ {{ seg.extra }}</div>
          <div v-else-if="seg.rallied" class="bc-extra x-rally">✦ {{ seg.extra }}</div>
        </div>

        <!-- 击杀烙印 -->
        <div v-else-if="seg.kind === 'kill'" class="bc-kill" :style="dly(i)">
          <span class="bc-kill-stamp">KO</span>
          <span class="bc-kill-name">{{ seg.name }}</span>
          <span class="bc-kill-word">已被击杀</span>
        </div>

        <!-- 掉落战利品 -->
        <div v-else-if="seg.kind === 'drop'" class="bc-drop" :style="dly(i)">
          <span class="bc-drop-label">✦ 战利品</span>
          <span v-for="(item, di) in seg.items" :key="di" class="bc-loot">{{ item }}</span>
        </div>

        <!-- 经验入账 -->
        <div v-else-if="seg.kind === 'exp'" class="bc-exp" :style="dly(i)">
          <span class="bc-exp-num">+{{ fmtNum(seg.amount) }}</span>
          <span class="bc-exp-label">经验</span>
        </div>

        <!-- 生命偷取 -->
        <div v-else-if="seg.kind === 'leech'" class="bc-leech" :style="dly(i)">
          <span class="bc-leech-icon">❥</span>生命偷取 +{{ fmtNum(seg.amount) }}
        </div>

        <!-- 闪避 -->
        <div v-else-if="seg.kind === 'dodge'" class="bc-dodge" :style="dly(i)">
          <span class="bc-dodge-text">{{ seg.text }}</span>
          <span class="bc-miss">MISS</span>
        </div>

        <!-- 格挡 -->
        <div v-else-if="seg.kind === 'block'" class="bc-block" :style="dly(i)">
          <span class="bc-block-icon">🛡</span>{{ seg.text }}
        </div>

        <!-- 战斗统计 -->
        <div v-else-if="seg.kind === 'stats'" class="bc-stats" :style="dly(i)">
          <span class="bc-stat">出手 <b>{{ seg.total }}</b></span>
          <span class="bc-stat s-ok">命中 <b>{{ seg.hit }}</b></span>
          <span class="bc-stat s-miss">被闪避 <b>{{ seg.dodged }}</b></span>
          <span class="bc-stat">零伤 <b>{{ seg.nullDmg }}</b></span>
          <span class="bc-stat s-ok">有效伤 <b>{{ seg.effective }}</b></span>
        </div>

        <!-- 死亡 / 卷土重来 / 状态触发 -->
        <div v-else-if="seg.kind === 'death'" class="bc-death" :style="dly(i)">{{ seg.text }}</div>
        <div v-else-if="seg.kind === 'rally'" class="bc-rally" :style="dly(i)">
          <span class="bc-rally-icon">☯</span>{{ seg.text }}
        </div>
        <div v-else-if="seg.kind === 'status'" class="bc-status" :style="dly(i)">{{ seg.text }}</div>

        <!-- 兜底：未识别行原样直出 -->
        <div v-else class="bc-raw" :style="dly(i)">{{ seg.text }}</div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { parseBattle, fmtNum } from '../utils/battleText';

const props = defineProps({
  /** 服务端下发的原始战斗结算文本（含换行），不做任何改写 */
  text: { type: String, default: '' },
  /** 当前浏览器端玩家的游戏内显示名（玩家面板 name），用于区分「我打出 / 打到我」视角 */
  viewerName: { type: String, default: '' },
});

const parsed = computed(() => parseBattle(props.text, { viewerName: props.viewerName }));
const segments = computed(() => parsed.value.segments);
const summary = computed(() => parsed.value.summary);

/** 卡片级状态类：有暴击/击杀时附加边框辉光与入场震屏 */
const cardCls = computed(() => ({
  'has-crit': summary.value.crits > 0,
  'has-kill': summary.value.kills > 0,
  'has-in': summary.value.incoming > 0,
}));

/** 逐行错峰延迟：封顶 12 行（更深的行直接同帧出现，避免长战斗等太久） */
function dly(i) {
  return { '--d': `${Math.min(i, 12) * 70}ms` };
}

/** 伤害数字大小分档：让高伤害更醒目 */
function dmgSize(seg) {
  if (seg.total >= 1000) return 'd-xl';
  if (seg.total >= 200) return 'd-l';
  return '';
}
</script>

<style scoped>
/* ================= 卡片容器：修真科幻风底座 ================= */
.battle-card {
  position: relative;
  width: 100%;
  min-width: 0;
  text-align: left;
  font-size: 13px;
  line-height: 1.55;
  color: #e2e8f0;
  background:
    /* 淡淡的斜向灵纹网格 */
    repeating-linear-gradient(135deg, rgba(139, 92, 246, 0.045) 0 1px, transparent 1px 14px),
    radial-gradient(120% 90% at 20% 0%, rgba(139, 92, 246, 0.14), transparent 55%),
    radial-gradient(120% 90% at 90% 100%, rgba(6, 182, 212, 0.1), transparent 55%),
    linear-gradient(160deg, rgba(16, 12, 34, 0.96), rgba(10, 9, 24, 0.96));
  /* 科幻切角面板 */
  clip-path: polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px);
  border: 1px solid rgba(139, 92, 246, 0.35);
  box-shadow:
    0 0 0 1px rgba(6, 182, 212, 0.1),
    0 4px 18px rgba(0, 0, 0, 0.4),
    inset 0 0 24px rgba(139, 92, 246, 0.06);
  padding: 9px 12px 10px;
  overflow: hidden;
  animation: bc-card-in 0.45s cubic-bezier(0.2, 0.9, 0.3, 1) both;
}
/* 暴击/击杀/受创状态：边框辉光染色 */
.battle-card.has-crit { border-color: rgba(251, 191, 36, 0.55); }
.battle-card.has-kill { border-color: rgba(248, 113, 113, 0.55); }
.battle-card.has-in { box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.12), 0 4px 18px rgba(0, 0, 0, 0.4), inset 0 0 24px rgba(248, 113, 113, 0.05); }

@keyframes bc-card-in {
  0% { opacity: 0; transform: translateY(8px) scale(0.985); filter: brightness(1.6) saturate(1.4); }
  60% { opacity: 1; filter: brightness(1.15); }
  100% { opacity: 1; transform: none; filter: none; }
}

/* 四角科幻亮角 */
.bc-corner {
  position: absolute;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(103, 232, 249, 0.65);
  filter: drop-shadow(0 0 4px rgba(103, 232, 249, 0.5));
  animation: bc-corner-in 0.7s ease-out 0.15s both;
  pointer-events: none;
}
.bc-corner.tl { top: 0; left: 0; border-right: none; border-bottom: none; }
.bc-corner.tr { top: 0; right: 0; border-left: none; border-bottom: none; }
.bc-corner.bl { bottom: 0; left: 0; border-right: none; border-top: none; }
.bc-corner.br { bottom: 0; right: 0; border-left: none; border-top: none; }
@keyframes bc-corner-in { from { opacity: 0; transform: scale(2.2); } to { opacity: 1; transform: none; } }

/* 顶部能量流线：一道青紫光带从左掠到右（一次性） */
.bc-energy {
  position: absolute;
  top: 0;
  left: 0;
  height: 2px;
  width: 45%;
  background: linear-gradient(90deg, transparent, rgba(103, 232, 249, 0.9), rgba(167, 139, 250, 0.9), transparent);
  filter: drop-shadow(0 0 6px rgba(103, 232, 249, 0.8));
  animation: bc-energy-run 1.1s cubic-bezier(0.3, 0.8, 0.4, 1) 0.1s both;
  pointer-events: none;
}
@keyframes bc-energy-run {
  from { transform: translateX(-110%); opacity: 0; }
  15% { opacity: 1; }
  to { transform: translateX(260%); opacity: 0; }
}

/* ================= 头部 ================= */
.bc-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 6px;
  margin-bottom: 7px;
  border-bottom: 1px solid rgba(139, 92, 246, 0.25);
}
.bc-hicon {
  font-size: 15px;
  filter: drop-shadow(0 0 6px rgba(251, 191, 36, 0.7));
  animation: bc-icon-pulse 0.9s ease-out 0.2s 2;
}
@keyframes bc-icon-pulse { 50% { transform: scale(1.25) rotate(-8deg); } }
.bc-htitle {
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 3px;
  background: linear-gradient(90deg, #c4b5fd, #67e8f9);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.bc-badges { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-left: auto; }
.bc-badge {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 20px;
  border: 1px solid rgba(139, 92, 246, 0.3);
  background: rgba(139, 92, 246, 0.1);
  color: #c4b5fd;
  animation: bc-badge-pop 0.35s cubic-bezier(0.2, 1.4, 0.4, 1) 0.3s both;
}
.bc-badge.b-dmg { color: #fda4af; border-color: rgba(248, 113, 113, 0.4); background: rgba(248, 113, 113, 0.1); }
.bc-badge.b-crit { color: #fde047; border-color: rgba(251, 191, 36, 0.45); background: rgba(251, 191, 36, 0.1); }
.bc-badge.b-kill { color: #f87171; border-color: rgba(248, 113, 113, 0.5); background: rgba(248, 113, 113, 0.12); }
.bc-badge.b-exp { color: #86efac; border-color: rgba(74, 222, 128, 0.4); background: rgba(74, 222, 128, 0.08); }
.bc-badge.b-in { color: #fca5a5; border-color: rgba(248, 113, 113, 0.45); background: rgba(248, 113, 113, 0.1); }
@keyframes bc-badge-pop { from { opacity: 0; transform: scale(0.6); } to { opacity: 1; transform: none; } }

/* ================= 通用行错峰入场 ================= */
.bc-body > div { animation: bc-row-in 0.32s ease-out var(--d, 0ms) both; }
@keyframes bc-row-in {
  from { opacity: 0; transform: translateX(-8px); }
  to { opacity: 1; transform: none; }
}

/* ================= 分隔线 ================= */
.bc-divider { display: flex; align-items: center; gap: 8px; margin: 7px 0 5px; }
.bc-divider-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(103, 232, 249, 0.5), transparent);
  transform-origin: center;
  animation: bc-line-grow 0.5s ease-out var(--d, 0ms) both;
}
@keyframes bc-line-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
.bc-divider-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 2px;
  color: #67e8f9;
  text-shadow: 0 0 8px rgba(103, 232, 249, 0.6);
  white-space: nowrap;
}

/* ================= 特效芯片组 ================= */
.bc-effects { display: flex; flex-wrap: wrap; gap: 4px; margin: 3px 0; }
.bc-effect {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 4px;
  color: #a5f3fc;
  background: rgba(6, 182, 212, 0.1);
  border: 1px solid rgba(6, 182, 212, 0.35);
  text-shadow: 0 0 6px rgba(103, 232, 249, 0.4);
}
.bc-effect-desc { font-style: normal; font-weight: 400; color: #7dd3fc; margin-left: 4px; }

/* ================= 命中行 ================= */
.bc-hit {
  position: relative;
  padding: 4px 8px 5px;
  margin: 4px 0;
  border-radius: 6px;
  background: rgba(139, 92, 246, 0.05);
  border: 1px solid rgba(139, 92, 246, 0.14);
  overflow: hidden;
}
/* 剑光扫过：一道斜向光带掠过命中行（一次性） */
.bc-hit::after {
  content: '';
  position: absolute;
  top: -20%;
  left: 0;
  width: 34%;
  height: 140%;
  background: linear-gradient(100deg, transparent, rgba(255, 255, 255, 0.14), transparent);
  transform: skewX(-18deg) translateX(-140%);
  animation: bc-slash 0.55s ease-out calc(var(--d, 0ms) + 0.18s) both;
  pointer-events: none;
}
@keyframes bc-slash { to { transform: skewX(-18deg) translateX(420%); } }
/* 出手/受击/中立行差异 */
.bc-hit.s-out { border-color: rgba(251, 191, 36, 0.22); background: rgba(251, 191, 36, 0.045); }
.bc-hit.s-in { border-color: rgba(248, 113, 113, 0.4); background: rgba(248, 113, 113, 0.07); animation: bc-row-in 0.32s ease-out var(--d, 0ms) both, bc-hit-shake 0.4s ease-out calc(var(--d, 0ms) + 0.15s); }
.bc-hit.s-in .bc-target { color: #fecaca; }
@keyframes bc-hit-shake {
  0%, 100% { transform: none; }
  25% { transform: translateX(-4px); }
  50% { transform: translateX(3px); }
  75% { transform: translateX(-2px); }
}
.bc-in-spike {
  position: absolute;
  top: 2px;
  right: 6px;
  font-size: 10px;
  color: #f87171;
  opacity: 0.9;
  text-shadow: 0 0 6px rgba(248, 113, 113, 0.8);
}

.bc-hit-text { font-size: 12.5px; color: #94a3b8; }
.bc-attacker { color: #fda4af; font-weight: 700; }
.bc-weapon { color: #7dd3fc; font-size: 11.5px; }
.bc-glory-tag { color: #fde047; font-size: 11.5px; font-weight: 700; margin: 0 2px; }
.bc-arrow { color: #f87171; margin: 0 3px; }
.bc-flavor { color: #94a3b8; }
.bc-target { color: #e2e8f0; font-weight: 700; }

/* 伤害数字：重击砸落 */
.bc-dmg-row { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.bc-dmg {
  display: inline-block;
  font-size: 21px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: 0.5px;
  line-height: 1.1;
  background: linear-gradient(180deg, #e0f2fe 0%, #7dd3fc 55%, #38bdf8 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 0 8px rgba(56, 189, 248, 0.45));
  animation: bc-slam 0.42s cubic-bezier(0.15, 0.9, 0.3, 1.25) calc(var(--d, 0ms) + 0.12s) both;
  transform-origin: left bottom;
}
/* 我打出的：赤金剑气；打到我身上的：猩红 */
.bc-hit.s-out .bc-dmg {
  background: linear-gradient(180deg, #fef3c7 0%, #fbbf24 55%, #f59e0b 100%);
  -webkit-background-clip: text;
  background-clip: text;
  filter: drop-shadow(0 0 9px rgba(251, 191, 36, 0.5));
}
.bc-hit.s-in .bc-dmg {
  background: linear-gradient(180deg, #fee2e2 0%, #f87171 55%, #ef4444 100%);
  -webkit-background-clip: text;
  background-clip: text;
  filter: drop-shadow(0 0 9px rgba(248, 113, 113, 0.55));
}
.bc-hit.d-l .bc-dmg { font-size: 25px; }
.bc-hit.d-xl .bc-dmg { font-size: 29px; }
@keyframes bc-slam {
  0% { opacity: 0; transform: scale(2.4) translateY(-6px); filter: blur(5px) drop-shadow(0 0 14px currentColor); }
  55% { opacity: 1; transform: scale(0.94) translateY(1px); filter: blur(0); }
  75% { transform: scale(1.06); }
  100% { opacity: 1; transform: none; }
}
/* 暴击数字追加迸发光环 */
.bc-hit.is-crit .bc-dmg { position: relative; }
.bc-hit.is-crit .bc-dmg::before {
  content: '';
  position: absolute;
  inset: -10px -14px;
  background: conic-gradient(from 0deg, transparent 0 12%, rgba(251, 191, 36, 0.25) 14%, transparent 16% 37%, rgba(251, 191, 36, 0.25) 39%, transparent 41% 62%, rgba(251, 191, 36, 0.25) 64%, transparent 66% 87%, rgba(251, 191, 36, 0.25) 89%, transparent 91%);
  border-radius: 50%;
  animation: bc-burst 0.7s ease-out calc(var(--d, 0ms) + 0.2s) both;
  pointer-events: none;
}
@keyframes bc-burst {
  0% { opacity: 0; transform: scale(0.4) rotate(0deg); }
  40% { opacity: 1; }
  100% { opacity: 0; transform: scale(1.5) rotate(50deg); }
}

.bc-crit {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 2px;
  color: #451a03;
  padding: 1px 8px;
  border-radius: 4px;
  background: linear-gradient(135deg, #fde047, #f59e0b);
  box-shadow: 0 0 10px rgba(251, 191, 36, 0.55);
  animation: bc-badge-pop 0.3s cubic-bezier(0.2, 1.6, 0.4, 1) calc(var(--d, 0ms) + 0.25s) both,
    bc-crit-glow 1.2s ease-in-out calc(var(--d, 0ms) + 0.55s) 2;
}
@keyframes bc-crit-glow { 50% { box-shadow: 0 0 18px rgba(251, 191, 36, 0.9); } }

.bc-rating { font-size: 11px; font-weight: 800; padding: 1px 7px; border-radius: 4px; border: 1px solid; }
.bc-rating.r-epic { color: #fda4af; border-color: rgba(244, 63, 94, 0.6); background: rgba(244, 63, 94, 0.12); text-shadow: 0 0 8px rgba(244, 63, 94, 0.6); }
.bc-rating.r-great { color: #d8b4fe; border-color: rgba(192, 132, 252, 0.55); background: rgba(192, 132, 252, 0.1); }
.bc-rating.r-good { color: #fdba74; border-color: rgba(251, 146, 60, 0.55); background: rgba(251, 146, 60, 0.1); }
.bc-rating.r-fair { color: #67e8f9; border-color: rgba(34, 211, 238, 0.5); background: rgba(34, 211, 238, 0.08); }
.bc-rating.r-normal { color: #86efac; border-color: rgba(74, 222, 128, 0.45); background: rgba(74, 222, 128, 0.08); }
.bc-capture { font-size: 11px; font-weight: 700; color: #86efac; border: 1px dashed rgba(74, 222, 128, 0.5); padding: 1px 7px; border-radius: 4px; }

/* 三池分项芯片 */
.bc-pools { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.bc-pool {
  font-size: 11px;
  font-weight: 600;
  padding: 0 6px;
  border-radius: 4px;
  border: 1px solid;
  animation: bc-badge-pop 0.3s ease-out calc(var(--d, 0ms) + 0.3s) both;
}
.bc-pool.p-sh { color: #67e8f9; border-color: rgba(103, 232, 249, 0.4); background: rgba(103, 232, 249, 0.07); }
.bc-pool.p-ar { color: #cbd5e1; border-color: rgba(148, 163, 184, 0.4); background: rgba(148, 163, 184, 0.07); }
.bc-pool.p-hp { color: #fca5a5; border-color: rgba(248, 113, 113, 0.45); background: rgba(248, 113, 113, 0.08); }

.bc-extra { font-size: 11.5px; color: #94a3b8; margin-top: 2px; }
.bc-extra.x-down { color: #f87171; font-weight: 700; }
.bc-extra.x-rally { color: #fde047; font-weight: 700; text-shadow: 0 0 8px rgba(253, 224, 71, 0.5); }

/* ================= 击杀烙印 ================= */
.bc-kill {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
  padding: 5px 9px;
  border-radius: 6px;
  background: linear-gradient(90deg, rgba(248, 113, 113, 0.14), transparent 70%);
  border-left: 3px solid #ef4444;
}
.bc-kill-stamp {
  font-size: 15px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: 1px;
  color: #fff;
  background: linear-gradient(135deg, #ef4444, #b91c1c);
  padding: 1px 8px;
  border-radius: 4px;
  box-shadow: 0 0 12px rgba(239, 68, 68, 0.6);
  animation: bc-stamp 0.4s cubic-bezier(0.2, 1.3, 0.4, 1) calc(var(--d, 0ms) + 0.15s) both;
}
@keyframes bc-stamp {
  0% { opacity: 0; transform: scale(2) rotate(-14deg); filter: blur(3px); }
  70% { opacity: 1; transform: scale(0.92) rotate(-3deg); filter: none; }
  100% { transform: scale(1) rotate(-3deg); }
}
.bc-kill-name { color: #fecaca; font-weight: 800; font-size: 14px; }
.bc-kill-word { color: #f87171; font-size: 12px; letter-spacing: 2px; }

/* ================= 掉落 / 经验 / 偷取 ================= */
.bc-drop { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin: 4px 0; }
.bc-drop-label { font-size: 11px; font-weight: 700; color: #fde047; letter-spacing: 1px; text-shadow: 0 0 6px rgba(253, 224, 71, 0.5); }
.bc-loot {
  font-size: 12px;
  font-weight: 600;
  color: #fef08a;
  padding: 1px 8px;
  border-radius: 20px;
  background: linear-gradient(135deg, rgba(251, 191, 36, 0.16), rgba(245, 158, 11, 0.08));
  border: 1px solid rgba(251, 191, 36, 0.45);
  animation: bc-loot-pop 0.35s cubic-bezier(0.2, 1.5, 0.4, 1) calc(var(--d, 0ms) + 0.2s) both;
}
@keyframes bc-loot-pop { from { opacity: 0; transform: scale(0.5) translateY(6px); } to { opacity: 1; transform: none; } }

.bc-exp { display: flex; align-items: baseline; gap: 5px; margin: 3px 0; }
.bc-exp-num {
  font-size: 17px;
  font-weight: 900;
  color: #86efac;
  text-shadow: 0 0 10px rgba(74, 222, 128, 0.55);
  animation: bc-rise 0.6s ease-out calc(var(--d, 0ms) + 0.2s) both;
}
@keyframes bc-rise { from { opacity: 0; transform: translateY(8px); } 60% { opacity: 1; } to { opacity: 1; transform: none; } }
.bc-exp-label { font-size: 11px; color: #4ade80; letter-spacing: 2px; }

.bc-leech { font-size: 12px; color: #fda4af; margin: 3px 0; }
.bc-leech-icon { margin-right: 4px; }

/* ================= 闪避 / 格挡 ================= */
.bc-dodge {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-style: italic;
  color: #64748b;
  margin: 3px 0;
}
.bc-dodge-text { flex: 1; min-width: 0; }
.bc-miss {
  font-size: 13px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: 2px;
  color: rgba(148, 163, 184, 0.7);
  animation: bc-miss-float 0.8s ease-out calc(var(--d, 0ms) + 0.2s) both;
}
@keyframes bc-miss-float {
  0% { opacity: 0; transform: translate(-8px, 2px) scale(1.4); }
  30% { opacity: 1; }
  100% { opacity: 0.55; transform: translate(0, -4px) scale(1); }
}
.bc-block {
  font-size: 12px;
  color: #93c5fd;
  margin: 3px 0;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.07);
  border: 1px dashed rgba(59, 130, 246, 0.35);
}
.bc-block-icon { margin-right: 4px; }

/* ================= 统计 ================= */
.bc-stats { display: flex; flex-wrap: wrap; gap: 5px; margin: 4px 0; }
.bc-stat {
  font-size: 11px;
  color: #94a3b8;
  padding: 1px 8px;
  border-radius: 20px;
  border: 1px solid rgba(139, 92, 246, 0.25);
  background: rgba(139, 92, 246, 0.06);
}
.bc-stat b { color: #e2e8f0; font-weight: 800; }
.bc-stat.s-ok b { color: #86efac; }
.bc-stat.s-miss b { color: #fca5a5; }

/* ================= 死亡 / 卷土重来 / 状态 / 兜底 ================= */
.bc-death {
  font-size: 12.5px;
  font-weight: 700;
  color: #f87171;
  text-shadow: 0 0 8px rgba(248, 113, 113, 0.5);
  margin: 4px 0;
  padding: 4px 9px;
  border-radius: 6px;
  background: rgba(127, 29, 29, 0.2);
  border: 1px solid rgba(248, 113, 113, 0.35);
}
.bc-rally {
  font-size: 13px;
  font-weight: 800;
  color: #fde047;
  letter-spacing: 1px;
  text-shadow: 0 0 10px rgba(253, 224, 71, 0.55);
  margin: 4px 0;
  padding: 4px 9px;
  border-radius: 6px;
  background: linear-gradient(90deg, rgba(251, 191, 36, 0.14), transparent);
  border-left: 3px solid #f59e0b;
}
.bc-rally-icon { margin-right: 4px; }
.bc-status { font-size: 11.5px; color: #fcd34d; margin: 3px 0; opacity: 0.9; }
.bc-raw { font-size: 12px; color: #94a3b8; margin: 2px 0; white-space: pre-line; }

/* ================= 无障碍：减少动态效果 ================= */
@media (prefers-reduced-motion: reduce) {
  .battle-card *,
  .battle-card {
    animation: none !important;
  }
}
</style>
