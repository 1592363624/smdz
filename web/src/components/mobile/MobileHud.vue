<template>
  <!--
    手机端顶部常驻 HUD（Head-Up Display）。
    手游的通行做法：不管在哪个界面，头像/等级/血条/经验条一直挂在最上面，
    玩家永远知道自己「是谁、还剩多少血、离升级多远」。
    原来的实现是这些信息藏在左上角汉堡 → 左侧抽屉里，每次都要开两层才能看到，
    这正是不像游戏、像表单页面的根本原因。
  -->
  <header class="hud">
    <button class="hud-card" type="button" @click="openMe">
      <span class="hud-avatar" :class="{ dead: hpDead }">
        <img v-if="avatar" :src="avatar" class="hud-avatar-img" alt="" />
        <span v-else class="hud-avatar-letter">{{ avatarLetter }}</span>
        <span v-if="familiar" class="hud-familiar">{{ familiar }}</span>
      </span>
      <span class="hud-id">
        <span class="hud-name-row">
          <span class="hud-name">{{ displayName }}</span>
          <span class="hud-lv">Lv.{{ level }}</span>
        </span>
        <span class="hud-bars">
          <span class="hud-bar hp" :class="{ 'is-low': hpPercent > 0 && hpPercent <= 30, 'is-dead': hpDead }">
            <span class="hud-bar-fill" :style="{ width: hpPercent + '%' }"></span>
            <span class="hud-bar-text">{{ hpDead ? '濒死' : hpText }}</span>
          </span>
          <span class="hud-bar exp">
            <span class="hud-bar-fill" :style="{ width: expPercent + '%' }"></span>
          </span>
        </span>
      </span>
    </button>

    <div class="hud-side">
      <span v-if="power" class="hud-pill power" :title="'战斗力 ' + power">⚔{{ compact(power) }}</span>
      <span
        class="hud-dot"
        :class="connected ? 'on' : 'off'"
        :title="connected ? '已连接服务器' : '连接中断，正在重连'"
      ></span>
    </div>
  </header>
</template>

<script setup>
/**
 * HUD 只负责「显示 + 进角色面板」，不复制 PlayerStatusPanel 的内容：
 * 数据全部来自 player store（ChatView / HomeView 的 socket player:update 在写入），
 * 所以配合 App.vue 的 keep-alive，切到任何标签页这里的血条都还在实时跳动。
 * store 为空时（直达 /arena 等未加载玩家信息的页面）自己补拉一次，避免出现空壳。
 */
import { computed, onMounted, watch } from 'vue';
import { usePlayerStore } from '../../stores/player';
import { useConnectionStore } from '../../stores/connection';
import { useUiStore } from '../../stores/ui';
import { gameApi } from '../../api';
import { tapLight } from '../../utils/haptics';

const playerStore = usePlayerStore();
const connection = useConnectionStore();
const ui = useUiStore();

const info = computed(() => playerStore.info || {});
const connected = computed(() => connection.connected);

/** 登录用户（ChatView 同源读取 localStorage.user） */
const user = computed(() => {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null') || {};
  } catch {
    return {};
  }
});

const displayName = computed(() => user.value?.nickname || user.value?.username || '旅行者');
const avatar = computed(() => user.value?.avatar || '');
const avatarLetter = computed(() => (displayName.value || '?').trim().charAt(0).toUpperCase());
const familiar = computed(() => info.value?.type || '');
const level = computed(() => info.value?.level ?? '--');
const power = computed(() => Number(info.value?.combatPower) || 0);

function num(v) { return Math.round(Number(v) || 0); }
const hpPercent = computed(() => {
  const max = num(info.value?.maxHp);
  return max ? Math.max(0, Math.min(100, Math.round((num(info.value?.hp) / max) * 100))) : 0;
});
const expPercent = computed(() => {
  const need = num(info.value?.upgradeExp);
  return need ? Math.max(0, Math.min(100, Math.round((num(info.value?.exp) / need) * 100))) : 0;
});
const hpText = computed(() => `${num(info.value?.hp)}/${num(info.value?.maxHp)}`);
/** 濒死判定与 PlayerStatusPanel 一致：hp<=0 且没有「卷土重来」增益才算真死 */
const hpDead = computed(() => {
  if (num(info.value?.maxHp) <= 0) return false;
  if (num(info.value?.hp) > 0) return false;
  const buffs = Array.isArray(info.value?.buffs) ? info.value.buffs : [];
  const now = Date.now();
  return !buffs.some(
    (b) => b && (b.name ?? b.名称) === '卷土重来' && (!Number(b.expireAt) || Number(b.expireAt) > now),
  );
});

/** 大数缩写：12800 → 1.28万，避免战力数字把 HUD 撑挤；先取整再缩写（战力是小数） */
function compact(n) {
  const v = Math.round(Number(n) || 0);
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(v >= 1e6 ? 1 : 2) + '万';
  return String(v);
}

function openMe() {
  tapLight();
  ui.toggleMe();
}

/** store 空着时补拉一次；已有数据不重复请求（各页自己的轮询会刷新） */
async function ensureLoaded() {
  if (playerStore.info) return;
  try {
    const res = await gameApi.playerInfo();
    if (res?.data) playerStore.setPlayerInfo(res.data);
  } catch {
    /* 静默：401 由拦截器统一处理，弱网下 HUD 保持占位不报错 */
  }
}
onMounted(ensureLoaded);
watch(() => playerStore.info, ensureLoaded);
</script>

<style scoped>
.hud {
  position: relative;
  z-index: 481;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  height: var(--hud-h);
  padding: 0 10px;
  padding-top: 0;
  background: linear-gradient(180deg, rgba(26, 20, 58, 0.97), rgba(12, 11, 30, 0.92));
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(139, 92, 246, 0.28);
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.45);
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.hud-card {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  margin-left: -6px;
  border: 0;
  border-radius: 12px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.18s ease, transform 0.12s ease;
}
.hud-card:active {
  background: rgba(139, 92, 246, 0.14);
  transform: scale(0.985);
}
/* 头像：六边形金币托，濒死时变红 */
.hud-avatar {
  position: relative;
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: linear-gradient(145deg, rgba(139, 92, 246, 0.5), rgba(6, 182, 212, 0.28));
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12) inset, 0 2px 8px rgba(0, 0, 0, 0.45);
  overflow: visible;
}
.hud-avatar.dead {
  background: linear-gradient(145deg, rgba(239, 68, 68, 0.6), rgba(120, 20, 20, 0.4));
  animation: hudDeadPulse 1.4s ease-in-out infinite;
}
@keyframes hudDeadPulse {
  0%, 100% { box-shadow: 0 0 0 1px rgba(255,255,255,0.12) inset, 0 0 6px rgba(239, 68, 68, 0.4); }
  50% { box-shadow: 0 0 0 1px rgba(255,255,255,0.12) inset, 0 0 16px rgba(239, 68, 68, 0.85); }
}
.hud-avatar-img {
  width: 100%;
  height: 100%;
  border-radius: 10px;
  object-fit: cover;
}
.hud-avatar-letter {
  font-size: 16px;
  font-weight: 700;
  color: #fff;
}
.hud-familiar {
  position: absolute;
  right: -4px;
  bottom: -5px;
  max-width: 42px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 4px;
  border-radius: 6px;
  font-size: 9px;
  font-weight: 700;
  line-height: 14px;
  color: #0a0a1a;
  background: linear-gradient(90deg, #fbbf24, #f59e0b);
  box-shadow: 0 0 0 1.5px rgba(10, 10, 26, 0.9);
}
.hud-id {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.hud-name-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.hud-name {
  font-size: 12px;
  font-weight: 700;
  color: var(--text, #f1f1f9);
  max-width: 46vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hud-lv {
  flex: 0 0 auto;
  font-size: 10.5px;
  font-weight: 700;
  color: #fbbf24;
  text-shadow: 0 0 8px rgba(251, 191, 36, 0.35);
}
.hud-bars {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  max-width: 200px;
}
.hud-bar {
  position: relative;
  height: 8px;
  border-radius: 999px;
  background: rgba(6, 8, 24, 0.85);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.07) inset;
  overflow: hidden;
}
.hud-bar-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 999px;
  transition: width 0.45s cubic-bezier(0.22, 1, 0.36, 1);
}
.hud-bar.hp .hud-bar-fill {
  background: linear-gradient(90deg, #22c55e, #4ade80);
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.5);
}
.hud-bar.hp.is-low .hud-bar-fill {
  background: linear-gradient(90deg, #f59e0b, #fbbf24);
  box-shadow: 0 0 8px rgba(245, 158, 11, 0.6);
}
.hud-bar.hp.is-dead .hud-bar-fill {
  background: linear-gradient(90deg, #991b1b, #ef4444);
}
.hud-bar.exp {
  height: 5px;
}
.hud-bar.exp .hud-bar-fill {
  background: linear-gradient(90deg, #8b5cf6, #06b6d4);
  box-shadow: 0 0 6px rgba(139, 92, 246, 0.5);
}
.hud-bar-text {
  position: absolute;
  inset: 0;
  font-size: 7.5px;
  font-weight: 700;
  line-height: 8px;
  text-align: center;
  letter-spacing: 0.2px;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
  white-space: nowrap;
}
.hud-side {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 7px;
}
.hud-pill {
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.35);
  color: #fca5a5;
}
.hud-pill.power {
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.28), rgba(6, 182, 212, 0.18));
  border-color: rgba(139, 92, 246, 0.5);
  color: #e9d5ff;
}
.hud-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success, #22c55e);
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.8);
}
.hud-dot.off {
  background: var(--danger, #ef4444);
  box-shadow: 0 0 8px rgba(239, 68, 68, 0.8);
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
</style>
