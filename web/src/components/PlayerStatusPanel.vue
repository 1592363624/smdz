<template>
  <div class="player-info">
    <div class="pi-header">
      <span class="pi-name">{{ info.name || '冒险者' }}</span>
      <span class="pi-type" v-if="info.type">{{ info.type }}</span>
    </div>
    <div class="pi-row pi-row-level">
      <span class="pi-label">等级</span>
      <span class="pi-value">Lv.{{ info.level }}</span>
    </div>
    <div class="pi-bar-row">
      <div class="pi-bar-label"><span>经验</span><span>{{ info.exp }}/{{ info.upgradeExp }}</span></div>
      <div class="pi-bar"><div class="pi-bar-fill exp" :style="{ width: expPercent + '%' }"></div></div>
    </div>
    <div class="pi-row">
      <span class="pi-label">❤️ 生命</span>
      <span class="pi-value">{{ r(info.hp) }} / {{ r(info.maxHp) }}</span>
    </div>
    <div class="pi-bar"><div class="pi-bar-fill hp" :class="hpBarClass" :style="{ width: hpPercent + '%' }"></div></div>
    <div class="pi-row">
      <span class="pi-label">🛡️ 护盾</span>
      <span class="pi-value">{{ r(info.shield) }} / {{ r(info.maxShield) }}</span>
    </div>
    <div class="pi-bar"><div class="pi-bar-fill shield" :style="{ width: shieldPercent + '%' }"></div></div>
    <div class="pi-row">
      <span class="pi-label">🛡️ 装甲</span>
      <span class="pi-value">{{ r(info.armor) }} / {{ r(info.maxArmor) }}</span>
    </div>
    <div class="pi-bar"><div class="pi-bar-fill armor" :style="{ width: armorPercent + '%' }"></div></div>
    <div class="pi-row">
      <span class="pi-label">⚡ 活力</span>
      <span class="pi-value">{{ r(info.vitality) }} / {{ r(info.maxVitality) }}</span>
    </div>
    <div class="pi-bar"><div class="pi-bar-fill vitality" :style="{ width: vitalityPercent + '%' }"></div></div>

    <!-- 战斗力：与「信息」文本面板同口径（计算后属性代入原版战斗力公式） -->
    <div class="pi-row pi-row-power" v-if="info.combatPower !== undefined && info.combatPower !== null">
      <span class="pi-label">🔥 战斗力</span>
      <span class="pi-power">{{ r(info.combatPower).toLocaleString('zh-CN') }}</span>
    </div>

    <div class="pi-stats">
      <div class="pi-stat"><span>攻击</span><b>{{ r(info.attack) }}</b></div>
      <div class="pi-stat"><span>防御</span><b>{{ r(info.defense) }}</b></div>
      <div class="pi-stat"><span>速度</span><b>{{ r(info.speed) }}</b></div>
      <div class="pi-stat"><span>闪避</span><b>{{ r(info.dodge) }}</b></div>
      <div class="pi-stat"><span>命中</span><b>{{ r(info.hit) }}</b></div>
      <div class="pi-stat"><span>暴击</span><b>{{ r(info.crit) }}%</b></div>
    </div>

    <!-- 当前任务：与文本面板一致，仅展示进行中的任务 -->
    <div class="pi-section" v-if="tasks.length">
      <div class="pi-section-title">📋 当前任务<span class="pi-count">{{ tasks.length }}</span></div>
      <div class="pi-task-list">
        <span v-for="t in tasks" :key="'task-' + t.name" class="pi-task">{{ t.name }}<i v-if="t.count">({{ t.count }})</i></span>
      </div>
    </div>

    <!-- 装备栏：15 个栏位一览，默认收起可展开；空栏显示 无(+强化等级) -->
    <div class="pi-section">
      <button type="button" class="pi-section-title pi-toggle" @click="eqOpen = !eqOpen">
        📋 装备<span class="pi-count">{{ equippedCount }}/{{ eqList.length }}</span>
        <span class="pi-arrow" :class="{ open: eqOpen }">▸</span>
      </button>
      <div v-show="eqOpen" class="pi-eq-grid">
        <div v-for="e in eqList" :key="'eq-' + e.slot" class="pi-eq" :title="e.effect > 0 ? '特效' + e.effect : ''">
          <span class="pi-eq-slot">{{ e.slot }}</span>
          <span v-if="e.name" class="pi-eq-val" :class="'q-' + qKey(e.quality)">
            {{ e.quality === '普通' ? '' : e.quality + ' ' }}{{ e.name }}<i v-if="e.effect > 0">[特效{{ e.effect }}]</i>(+{{ e.enhance }})
          </span>
          <span v-else class="pi-eq-empty">无(+{{ e.enhance }})</span>
        </div>
      </div>
    </div>

    <!-- 增益：本地时钟实时倒计时，过期条目后端已过滤，前端再兜底隐藏 -->
    <div class="pi-section" v-if="visibleBuffs.length">
      <div class="pi-section-title">✨ 增益</div>
      <div class="pi-buff-list">
        <span v-for="b in visibleBuffs" :key="'buff-' + b.name" class="pi-buff">
          {{ b.name }}<em>({{ buffRemain(b.expireAt) }})</em>
        </span>
      </div>
    </div>

    <div class="pi-row pi-row-loc">
      <span class="pi-label">📍 位置</span>
      <span class="pi-location">{{ info.location }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { serverNow } from '../utils/serverClock';

const props = defineProps({
  // buildPlayerInfo 快照（REST 全量 / socket player:update 推送，结构一致）
  info: { type: Object, required: true },
});

// 数值统一取整展示，避免浮点尾巴（如 545.6800000000001）
const r = (v) => Math.round(Number(v) || 0);

const hpPercent = computed(() => (!props.info?.maxHp ? 0 : Math.round((props.info.hp / props.info.maxHp) * 100)));
const expPercent = computed(() =>
  !props.info?.upgradeExp ? 0 : Math.min(100, Math.round((props.info.exp / props.info.upgradeExp) * 100)),
);
const shieldPercent = computed(() =>
  !props.info?.maxShield ? 0 : Math.min(100, Math.round((props.info.shield / props.info.maxShield) * 100)),
);
const armorPercent = computed(() =>
  !props.info?.maxArmor ? 0 : Math.min(100, Math.round((props.info.armor / props.info.maxArmor) * 100)),
);
// 活力进度：当前活力占历史上限（活力2）的百分比，上限可能高于 100
const vitalityPercent = computed(() =>
  !props.info?.maxVitality ? 0 : Math.min(100, Math.round((props.info.vitality / props.info.maxVitality) * 100)),
);
const hpBarClass = computed(() => {
  const pct = hpPercent.value;
  if (pct <= 25) return 'low';
  if (pct <= 60) return 'medium';
  return '';
});

// 当前任务快照（服务端已过滤已完成，兼容旧缓存无字段）
const tasks = computed(() => (Array.isArray(props.info?.tasks) ? props.info.tasks : []));

// 装备栏快照；默认展开，可点击标题收起
const eqList = computed(() => (Array.isArray(props.info?.equipment) ? props.info.equipment : []));
const eqOpen = ref(true);
const equippedCount = computed(() => eqList.value.filter((e) => e.name).length);
// 品质文字 → 配色档位（普通灰/良好绿/优秀蓝/精良紫/史诗橙/传说金/神迹红）
const QUALITY_KEY = { 普通: 'e', 良好: 'd', 优秀: 'c', 精良: 'b', 史诗: 'a', 传说: 's', 神迹: 'x' };
const qKey = (q) => QUALITY_KEY[q] || 'e';

// 增益倒计时：每秒跳一次对齐时钟驱动重渲染（expireAt 为服务器时刻，
// 用 serverNow 相减，避免本机时钟漂移让剩余时间整体偏差）
const buffs = computed(() => (Array.isArray(props.info?.buffs) ? props.info.buffs : []));
const nowTick = ref(serverNow());
let tickTimer = null;
onMounted(() => {
  tickTimer = setInterval(() => {
    nowTick.value = serverNow();
  }, 1000);
});
onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer);
});
// 无到期时间（expireAt=0）为永久增益，始终显示且不走倒计时
const visibleBuffs = computed(() =>
  buffs.value.filter((b) => {
    const expire = Number(b?.expireAt || 0);
    return !expire || expire > nowTick.value;
  }),
);
function buffRemain(expireAt) {
  const expire = Number(expireAt || 0);
  if (!expire) return '永久';
  const remainSec = Math.max(0, Math.floor((expire - nowTick.value) / 1000));
  const mm = Math.floor(remainSec / 60);
  const ss = remainSec % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}
</script>
