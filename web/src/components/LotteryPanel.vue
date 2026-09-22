<template>
  <!-- 每日抽奖面板：奖池道具名*数量高速跳动，停在中奖结果 -->
  <Teleport to="body">
    <div class="lt-overlay" @click.self="!spinning && emit('close')">
      <div class="lt-modal" role="dialog" aria-label="每日抽奖">
        <header class="lt-head">
          <h3>🎰 每日抽奖</h3>
          <button
            type="button"
            class="lt-icon-btn"
            title="关闭"
            :disabled="spinning"
            @click="emit('close')"
          >
            ✕
          </button>
        </header>

        <div class="lt-status">
          <span class="lt-chip">📅 今日剩余 {{ status?.remaining ?? '—' }}/{{ status?.dailyLimit ?? '—' }}</span>
          <span class="lt-chip">
            🎫 {{ status?.ticketItem || '凭证' }} {{ status?.ticketCount ?? 0 }}/{{ status?.ticketCost ?? 1 }}
          </span>
          <span class="lt-chip">🎁 奖池 {{ status?.poolSize ?? '—' }} 件</span>
        </div>

        <!-- 跑马灯主舞台 -->
        <div class="lt-stage" :class="{ spinning, done: !!result }">
          <div class="lt-reel-frame">
            <div
              class="lt-reel"
              :style="reelStyle"
            >
              <div
                v-for="(row, i) in reelRows"
                :key="i"
                class="lt-reel-item"
                :class="{ highlight: spinning === false && result && i === resultIndex }"
              >
                <span class="lt-reel-name">{{ row.name }}</span>
                <span class="lt-reel-x">×{{ row.quantity }}</span>
              </div>
            </div>
            <div class="lt-pointer" aria-hidden="true"></div>
          </div>
          <p class="lt-stage-hint">
            {{ spinning ? '奖池跳动中…' : result ? '中奖！奖励已自动入包' : '消耗凭证从全服奖池随机抽取' }}
          </p>
        </div>

        <!-- 结果 -->
        <div v-if="result" class="lt-result">
          <div class="lt-result-label">🎉 恭喜获得</div>
          <div class="lt-result-name">
            {{ result.name }}
            <em>×{{ result.quantity }}</em>
          </div>
          <div class="lt-result-type">{{ result.type === 'weapon' ? '武器（词条随机）' : '资源道具' }}</div>
        </div>
        <div v-else-if="errorText" class="lt-error">{{ errorText }}</div>

        <div class="lt-actions">
          <button
            type="button"
            class="lt-btn"
            :disabled="spinning || !status?.canDraw"
            @click="onDraw"
          >
            {{ spinning ? '抽取中…' : status?.canDraw ? '开始抽奖' : drawDisabledLabel }}
          </button>
          <button type="button" class="lt-btn ghost" :disabled="spinning" @click="reload">
            刷新状态
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
/**
 * 每日抽奖面板
 *
 * 流程：打开拉状态 → 点「开始抽奖」先请求服务端 → 拿到中奖结果后再播跑马灯，
 * 最终停在中奖项。动画只是表现层，结果以服务端为准，避免「先动画再扣凭证」的假抽。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { gameApi } from '../api';

const emit = defineEmits(['close', 'notify']);

const status = ref(null);
const spinning = ref(false);
const result = ref(null);
const errorText = ref('');
/** 跑马灯条目（含最后锁定的中奖项） */
const reelRows = ref([]);
/** 中奖项在 reelRows 中的下标 */
const resultIndex = ref(-1);
/** 当前 translateY（px），由 CSS transition 减速停住 */
const reelY = ref(0);

const ROW_H = 52;
const SPIN_ROWS = 28;

const reelStyle = computed(() => ({
  transform: `translateY(${reelY.value}px)`,
  transition: spinning.value
    ? 'none'
    : 'transform 2.6s cubic-bezier(0.12, 0.75, 0.12, 1)',
}));

const drawDisabledLabel = computed(() => {
  const s = status.value;
  if (!s) return '加载中…';
  if (!s.enabled) return '抽奖未开放';
  if (s.remaining <= 0) return '今日已抽完';
  if (s.ticketCount < s.ticketCost) return `缺少${s.ticketItem || '凭证'}`;
  return '暂不可抽';
});

let spinTimer = null;

onMounted(() => {
  reload();
});

onBeforeUnmount(() => {
  if (spinTimer) clearTimeout(spinTimer);
});

async function reload() {
  try {
    const res = await gameApi.lotteryStatus();
    status.value = res.data || null;
    errorText.value = '';
    // 打开/刷新时先把奖池预览铺进跑马灯，否则中间只有空框和金线
    seedIdleReel();
  } catch (e) {
    errorText.value = e?.response?.data?.message || '抽奖状态加载失败';
  }
}

/** 用 status.poolPreview 填一列待机奖池名；抽奖动画/中奖高亮时不覆盖 */
function seedIdleReel() {
  if (spinning.value || result.value) return;

  const pool = status.value?.poolPreview || [];
  if (!pool.length) {
    // 预览偶发为空时仍给可见占位，避免中间又变成空框
    const size = Number(status.value?.poolSize) || 0;
    reelRows.value = size > 0
      ? [{ name: `奖池 ${size} 件`, quantity: 1, kind: 'resource' }]
      : [];
    resultIndex.value = -1;
    reelY.value = 0;
    return;
  }

  // 视窗约 140px / 行高 52px ≈ 3 行；多铺几条，看起来是完整奖池而非单行占位
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const count = Math.min(shuffled.length, Math.max(8, pool.length));
  reelRows.value = Array.from({ length: count }, (_, i) => {
    const p = shuffled[i % shuffled.length];
    return {
      name: p.name,
      quantity: Math.max(1, Number(p.quantity) || 1),
      kind: p.kind || 'resource',
    };
  });
  resultIndex.value = -1;
  reelY.value = 0;
}

function pickPreviewPool() {
  const preview = status.value?.poolPreview || [];
  if (preview.length) return preview;
  return [{ name: '未知道具', quantity: 1, kind: 'resource' }];
}

function randomRow(pool) {
  const p = pool[Math.floor(Math.random() * pool.length)];
  return {
    name: p.name,
    quantity: Math.max(1, Number(p.quantity) || 1),
    kind: p.kind || 'resource',
  };
}

/** 先拿结果，再播减速停在中奖项的跑马灯 */
async function onDraw() {
  if (spinning.value || !status.value?.canDraw) return;
  spinning.value = true;
  result.value = null;
  errorText.value = '';
  resultIndex.value = -1;

  let drawRes;
  try {
    drawRes = await gameApi.lotteryDraw();
  } catch (e) {
    spinning.value = false;
    errorText.value = e?.response?.data?.message || '抽奖失败，请稍后重试';
    emit('notify', { type: 'error', message: errorText.value });
    return;
  }

  if (!drawRes?.success || !drawRes?.reward) {
    spinning.value = false;
    errorText.value = drawRes?.message || '抽奖失败';
    emit('notify', { type: 'error', message: errorText.value });
    await reload();
    return;
  }

  const reward = drawRes.reward;
  const pool = pickPreviewPool();

  // 拼一列：前面 SPIN_ROWS 条乱跳，最后一条是真奖
  const rows = [];
  for (let i = 0; i < SPIN_ROWS; i++) rows.push(randomRow(pool));
  rows.push({
    name: reward.name,
    quantity: Math.max(1, Number(reward.quantity) || 1),
    kind: reward.type || 'resource',
  });
  reelRows.value = rows;
  resultIndex.value = rows.length - 1;

  // 先重置到顶部，下一帧再开 transition，确保减速动画触发
  reelY.value = 0;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // 停在中奖项居中：帧高 140 中心在 70，行高 52 中心在 26 → translateY = 70 - 26 - i*ROW_H
  const stopY = 70 - ROW_H / 2 - resultIndex.value * ROW_H;
  reelY.value = stopY;

  if (spinTimer) clearTimeout(spinTimer);
  spinTimer = setTimeout(() => {
    spinning.value = false;
    result.value = {
      name: reward.name,
      quantity: reward.quantity,
      type: reward.type,
    };
    emit('notify', { type: 'success', message: drawRes.message || `获得 ${reward.name}×${reward.quantity}` });
    reload();
  }, 2700);
}
</script>

<style scoped>
.lt-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(8, 10, 18, 0.72);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.lt-modal {
  width: min(420px, 100%);
  background: linear-gradient(165deg, #1a1f33 0%, #121624 100%);
  border: 1px solid rgba(255, 215, 100, 0.28);
  border-radius: 14px;
  color: #e8ecf8;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  padding: 16px 18px 18px;
}

.lt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.lt-head h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.lt-icon-btn {
  border: none;
  background: rgba(255, 255, 255, 0.06);
  color: #aab3c9;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
}

.lt-icon-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}

.lt-icon-btn:active:not(:disabled) {
  transform: scale(0.9);
  background: rgba(255, 255, 255, 0.2);
}

.lt-status {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.lt-chip {
  font-size: 12px;
  color: #c5cde3;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 999px;
  padding: 3px 10px;
}

.lt-stage {
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(255, 215, 100, 0.18);
  border-radius: 12px;
  padding: 12px 12px 8px;
  margin-bottom: 12px;
}

.lt-reel-frame {
  position: relative;
  height: 140px;
  overflow: hidden;
  border-radius: 8px;
  background: linear-gradient(
    180deg,
    rgba(10, 12, 20, 0.95) 0%,
    rgba(18, 22, 36, 0.4) 40%,
    rgba(18, 22, 36, 0.4) 60%,
    rgba(10, 12, 20, 0.95) 100%
  );
}

.lt-reel {
  will-change: transform;
}

.lt-reel-item {
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 18px;
  font-size: 15px;
  font-weight: 500;
  color: #dfe6ff;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.04);
}

.lt-reel-item.highlight {
  color: #ffd764;
  text-shadow: 0 0 12px rgba(255, 215, 100, 0.55);
}

/* 长道具名（「★传说级·等离子光刃」）在 390px 屏上必须能缩，
   否则跑马灯行会把右侧的 ×数量 挤出 .lt-reel-frame 的裁切区 */
.lt-reel-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lt-reel-x {
  flex-shrink: 0;
  color: #9aa6c4;
  font-size: 13px;
}

.lt-reel-item.highlight .lt-reel-x {
  color: #ffe28a;
}

.lt-pointer {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 48px;
  transform: translateY(-50%);
  border: 1.5px solid rgba(255, 215, 100, 0.55);
  border-radius: 8px;
  box-shadow: inset 0 0 18px rgba(255, 200, 60, 0.12);
  pointer-events: none;
}

.lt-stage-hint {
  margin: 8px 0 2px;
  text-align: center;
  font-size: 12px;
  color: #8d97b0;
}

.lt-result {
  text-align: center;
  padding: 10px 8px 4px;
  margin-bottom: 8px;
}

.lt-result-label {
  font-size: 12px;
  color: #9aa6c4;
  margin-bottom: 4px;
}

.lt-result-name {
  font-size: 22px;
  font-weight: 700;
  color: #ffd764;
  letter-spacing: 0.02em;
}

.lt-result-name em {
  font-style: normal;
  font-size: 16px;
  margin-left: 2px;
  color: #ffe28a;
}

.lt-result-type {
  margin-top: 4px;
  font-size: 12px;
  color: #7d87a0;
}

.lt-error {
  text-align: center;
  color: #ff8b8b;
  font-size: 13px;
  margin: 8px 0;
}

.lt-actions {
  display: flex;
  gap: 8px;
}

.lt-btn {
  flex: 1;
  border: none;
  border-radius: 10px;
  padding: 11px 12px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  color: #1a1408;
  background: linear-gradient(135deg, #ffd764 0%, #f0b429 100%);
}

.lt-btn.ghost {
  flex: 0 0 auto;
  background: rgba(255, 255, 255, 0.08);
  color: #c5cde3;
  font-weight: 500;
}

.lt-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.lt-btn:not(.ghost):hover:not(:disabled) {
  filter: brightness(1.06);
}

.lt-btn:not(.ghost):active:not(:disabled) {
  transform: scale(0.98);
  filter: brightness(1.14);
}

/* ===== 手机端：抽卡面板改底部抽屉 =====
   抽卡是「看一眼结果 → 再按一次」的高频循环，主按钮必须一直停在拇指区里，
   所以抽屉贴底 + 操作条 sticky 在底沿：中部内容再多也不会把按钮顶出屏幕。 */
@media (max-width: 768px) {
  .lt-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .lt-modal {
    display: flex;
    flex-direction: column;
    width: 100%;
    /* HUD（等级/资源）在抽卡时仍需可见，抽屉只吃到 HUD 以下；
       --vvh 是 JS 实测值可能滞后，再套一层 100dvh 兜底。 */
    max-height: calc(min(var(--vvh, 100dvh), 100dvh) - var(--hud-h, 52px) - var(--safe-top, 0px));
    padding: 6px 16px 0;
    border-radius: 18px 18px 0 0;
    border-bottom: 0;
    box-shadow: 0 -14px 44px rgba(0, 0, 0, 0.6);
    overflow-x: hidden;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
  }

  /* 抽屉握把：没有它看着像被裁掉一半的桌面弹窗 */
  .lt-modal::before {
    content: '';
    flex: 0 0 auto;
    width: 40px;
    height: 4px;
    margin: 0 auto 6px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.22);
  }

  .lt-head {
    margin-bottom: 8px;
  }

  .lt-icon-btn {
    width: 40px;
    height: 40px;
    margin: -4px -8px 0 0;
    font-size: 17px;
  }

  .lt-chip {
    font-size: 12.5px;
    padding: 5px 11px;
  }

  .lt-result-name {
    font-size: 20px;
    overflow-wrap: anywhere;
  }

  /* 操作条钉在抽屉底沿：底色取面板渐变末端色，避免滚动内容从按钮缝里透出来 */
  .lt-actions {
    position: sticky;
    bottom: 0;
    z-index: 1;
    margin-top: auto;
    padding: 8px 0 calc(14px + var(--safe-bottom, 0px));
    background: #121624;
  }

  .lt-btn {
    min-height: 48px;
    font-size: 15px;
  }
}
</style>
