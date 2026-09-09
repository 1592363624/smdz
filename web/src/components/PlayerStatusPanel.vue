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
    <!-- 四条主资源：2×2 网格（左上生命／右上护盾／左下护甲／右下活力），原竖排 4 行高度压缩为 2 行 -->
    <div class="pi-bars">
      <div class="pi-bar-cell" :class="hpTierClass ? 'pit-' + hpTierClass : ''">
        <div class="pi-bar-label"><span :class="{ 'hp-label-dead': hpDead }">❤️ 生命</span><span>{{ r(info.hp) }}/{{ r(info.maxHp) }}</span></div>
        <div class="pi-bar"><div class="pi-bar-fill hp" :class="[hpBarClass, hpTierClass]" :style="{ width: hpPercent + '%' }"></div></div>
      </div>
      <div class="pi-bar-cell">
        <div class="pi-bar-label"><span>🛡️ 护盾</span><span>{{ r(info.shield) }}/{{ r(info.maxShield) }}</span></div>
        <div class="pi-bar"><div class="pi-bar-fill shield" :style="{ width: shieldPercent + '%' }"></div></div>
      </div>
      <div class="pi-bar-cell">
        <div class="pi-bar-label"><span>🛡️ 装甲</span><span>{{ r(info.armor) }}/{{ r(info.maxArmor) }}</span></div>
        <div class="pi-bar"><div class="pi-bar-fill armor" :style="{ width: armorPercent + '%' }"></div></div>
      </div>
      <div class="pi-bar-cell">
        <div class="pi-bar-label"><span>⚡ 活力</span><span>{{ r(info.vitality) }}/{{ r(info.maxVitality) }}</span></div>
        <div class="pi-bar"><div class="pi-bar-fill vitality" :style="{ width: vitalityPercent + '%' }"></div></div>
      </div>
    </div>

    <!-- 战斗力：与「信息」文本面板同口径（计算后属性代入原版战斗力公式） -->
    <div class="pi-row pi-row-power" v-if="info.combatPower !== undefined && info.combatPower !== null">
      <span class="pi-label">🔥 战斗力</span>
      <span class="pi-power">{{ r(info.combatPower).toLocaleString('zh-CN') }}</span>
    </div>

    <div class="pi-stats">
      <div v-for="s in statList" :key="s.label" class="pi-stat">
        <span>{{ s.label }}</span><b>{{ s.value }}{{ s.suffix || '' }}</b>
      </div>
    </div>

    <!-- 当前任务：与文本面板一致，仅展示进行中的任务 -->
    <div class="pi-section" v-if="tasks.length">
      <div class="pi-section-title">📋 当前任务<span class="pi-count">{{ tasks.length }}</span></div>
      <div class="pi-task-list">
        <span v-for="t in tasks" :key="'task-' + t.name" class="pi-task">{{ t.name }}<i v-if="t.count">({{ t.count }})</i></span>
      </div>
    </div>

    <!-- 装备栏：15 个栏位一览；常态单行（槽位+装备名），详情悬浮展示（移动端点击切换） -->
    <div class="pi-section">
      <button type="button" class="pi-section-title pi-toggle" @click="eqOpen = !eqOpen">
        📋 装备<span class="pi-count">{{ equippedCount }}/{{ eqList.length }}</span>
        <span class="pi-arrow" :class="{ open: eqOpen }">▸</span>
      </button>
      <div v-show="eqOpen" class="pi-eq-grid">
        <!-- 已装备格：按品质描边着色；空槽：半透明虚线弱化（见 pi-empty）；带卸下序号徽标（与「卸下 N」对号） -->
        <div
          v-for="e in eqList"
          :key="'eq-' + e.slot"
          class="pi-eq"
          :class="{ 'pi-empty': !e.name, 'pi-eq-hover': hoveredSlot === e.slot }"
          :style="e.name && eqBorder(e) ? { border: eqBorder(e), boxShadow: eqShadow(e) } : {}"
          @mouseenter="onEqEnter($event, e)"
          @mouseleave="onEqLeave"
          @click="onEqClick($event, e)"
        >
          <span class="pi-eq-slot">{{ e.slot }}</span>
          <span v-if="e.name && e.no != null" class="pi-eq-no" title="卸下序号：发「卸下 N」可精确卸下该件">{{ e.no }}</span>
          <span v-if="e.name" class="pi-eq-val" :class="'q-' + qKey(e.quality)">
            {{ e.quality === '普通' ? '' : e.quality + ' ' }}{{ e.name }}<i v-if="e.effect > 0">[特效{{ e.effect }}]</i>(+{{ e.enhance }})
          </span>
          <span v-else class="pi-eq-empty">无(+{{ e.enhance }})</span>
        </div>
      </div>
    </div>

    <!-- 武器详情列表（2026-09-09）：点击任意武器格展开/收起。
         武器可装备多件（手持 + 背上备用），逐件展示品质/特效/强化/属性，每件带「卸下」按钮，
         按已装备序号发「卸下 N」精确卸到指定那把（同名武器也能区分）。 -->
    <div class="pi-section pi-weapons" v-show="weaponsOpen && weaponEntries.length">
      <div class="pi-weapons-title">⚔️ 武器详情<span class="pi-count">{{ weaponEntries.length }}</span></div>
      <div v-for="w in weaponEntries" :key="'wp-' + w.slot" class="pi-weapon">
        <div class="pi-weapon-head">
          <span class="pi-eq-slot">{{ w.slot }}</span>
          <span v-if="w.no != null" class="pi-eq-no">{{ w.no }}</span>
          <span class="pi-weapon-name" :class="'q-' + qKey(w.quality)">
            {{ w.quality === '普通' ? '' : w.quality + ' ' }}{{ w.name }}<i v-if="w.effect > 0">[特效{{ w.effect }}]</i>
          </span>
          <button type="button" class="pi-unequip" title="放回背包" @click="unequip(w)">卸下</button>
        </div>
        <div class="pi-weapon-meta">强化 +{{ w.enhance }}</div>
        <pre v-if="w.attrs" class="pi-weapon-attrs">{{ w.attrs }}</pre>
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

    <!-- 装备详情悬浮卡片：Teleport 到 body 用 fixed 定位，避免被侧栏 overflow 裁切 -->
    <Teleport to="body">
      <div
        v-show="hoveredEq"
        ref="tooltipEl"
        class="pi-eq-tooltip"
        :style="{ top: hoverPos.top + 'px', left: hoverPos.left + 'px', borderLeftColor: hoverBorder }"
        @mouseenter="cancelHide"
        @mouseleave="onTooltipLeave"
      >
        <template v-if="hoveredEq">
          <div class="pi-tip-head" :class="'q-' + qKey(hoveredEq.quality)">
            {{ hoveredEq.quality === '普通' ? '' : hoveredEq.quality + ' ' }}{{ hoveredEq.name }}<i v-if="hoveredEq.effect > 0">[特效{{ hoveredEq.effect }}]</i>
          </div>
          <div class="pi-tip-meta">{{ hoveredEq.slot }} · 强化 +{{ hoveredEq.enhance }}</div>
          <pre v-if="hoveredEq.attrs" class="pi-tip-attrs">{{ hoveredEq.attrs }}</pre>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { serverNow } from '../utils/serverClock';

const props = defineProps({
  // buildPlayerInfo 快照（REST 全量 / socket player:update 推送，结构一致）
  info: { type: Object, required: true },
});

// 数值统一取整展示，避免浮点尾巴（如 545.6800000000001）
const r = (v) => Math.round(Number(v) || 0);

/** 向父组件（ChatView）回传指令：武器列表「卸下」按钮 → 发「卸下 N」按序号精确卸下 */
const emit = defineEmits(['send']);

// ===== 武器详情列表（2026-09-09，交互修订版） =====
// 装备栏固定 15 格不变（背上武器不占格）；全部武器（手持+背上）详情由服务端挂在
// 「武器」格的 weapons 子字段。单击「武器」格展开列表：逐件详情 + 卸下按钮，
// 按序号发「卸下 N」精确卸到指定那把（序号与「信息」面板/卸下指令三处同源）。
const weaponsOpen = ref(false);
const weaponCell = computed(() => eqList.value.find((e) => e.slot === '武器') || null);
const weaponEntries = computed(() =>
  Array.isArray(weaponCell.value?.weapons) ? weaponCell.value.weapons : [],
);
function unequip(w) {
  if (w?.no == null) return;
  emit('send', `卸下 ${w.no}`);
}

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

// ===== 血量分层预警 / 死亡状态（与 HealthVfx 特效层同口径联动） =====
// 死亡判定与战斗系统一致：hp<=0 且增益「卷土重来」未过期不算真死（原版 战斗相关.ecode L5182）
const hpDead = computed(() => {
  const max = Number(props.info?.maxHp) || 0;
  if (max <= 0) return false;
  if ((Number(props.info?.hp) || 0) > 0) return false;
  const buffs = Array.isArray(props.info?.buffs) ? props.info.buffs : [];
  const now = serverNow();
  const hasComeback = buffs.some(
    (b) => b && (b.name ?? b.名称) === '卷土重来' && (!Number(b.expireAt) || Number(b.expireAt) > now),
  );
  return !hasComeback;
});
// 分层档位：t1=30~20%（暗红慢呼吸）/ t2=20~10%（正红中速）/ t3=<10%（濒死频闪）/ dead=死亡
const hpTierClass = computed(() => {
  if (hpDead.value) return 'dead';
  const pct = hpPercent.value;
  if (pct <= 10) return 't3';
  if (pct <= 20) return 't2';
  if (pct <= 30) return 't1';
  return '';
});

// 动态属性列表：只显示后端返回了且值 > 0 的属性
// - defense(防御)永远不会被成长赋值，后端返回 undefined 会自动隐藏
// - 如果某个属性真的是 0（无装备/无加成），也自动隐藏
const statList = computed(() => {
  const list = [];
  if (typeof props.info.attack !== 'undefined' && props.info.attack > 0) {
    list.push({ label: '攻击', value: r(props.info.attack) });
  }
  if (typeof props.info.defense !== 'undefined' && props.info.defense > 0) {
    list.push({ label: '防御', value: r(props.info.defense) });
  }
  if (typeof props.info.speed !== 'undefined' && props.info.speed > 0) {
    list.push({ label: '速度', value: r(props.info.speed) });
  }
  if (typeof props.info.dodge !== 'undefined' && props.info.dodge > 0) {
    list.push({ label: '闪避', value: r(props.info.dodge) });
  }
  if (typeof props.info.hit !== 'undefined' && props.info.hit > 0) {
    list.push({ label: '命中', value: r(props.info.hit) });
  }
  if (typeof props.info.crit !== 'undefined' && props.info.crit > 0) {
    list.push({ label: '暴击', value: r(props.info.crit), suffix: '%' });
  }
  return list;
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
// 品质档位 → 边框/光晕颜色（用于装备格按品质描边，与聊天卡片一致）
const EQ_COLOR = { e: '', d: '#4ade80', c: '#60a5fa', b: '#a78bfa', a: '#fb923c', s: '#fbbf24', x: '#f87171' };
const eqBorder = (e) => (EQ_COLOR[qKey(e.quality)] ? `1px solid ${EQ_COLOR[qKey(e.quality)]}` : '');
const eqShadow = (e) => (EQ_COLOR[qKey(e.quality)] ? `0 0 6px ${EQ_COLOR[qKey(e.quality)]}44` : '');

// ---------- 装备详情悬浮卡片 ----------
// 常态只显示一行（槽位 + 装备名），属性全部收进 hover 弹层；
// 桌面靠 mouseenter/leave，移动端无 hover 时点击切换（toggle 同一格收起）。
const hoveredSlot = ref('');
const hoverPos = ref({ top: 0, left: 0, placement: 'right' });
const tooltipEl = ref(null);
const hoveredEq = computed(() => eqList.value.find((e) => e.slot === hoveredSlot.value) || null);
const hoverBorder = computed(() => (hoveredEq.value ? EQ_COLOR[qKey(hoveredEq.value.quality)] || '#60a5fa' : '#60a5fa'));

// 依据格子位置放置弹层：优先右侧，空间不足换左侧；垂直方向夹在视口内
function positionTooltip(target) {
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const tipW = 250;
  const tipH = tooltipEl.value?.offsetHeight || 160;
  const gap = 8;
  let placement = 'right';
  let left = rect.right + gap;
  if (left + tipW > window.innerWidth - 4) {
    placement = 'left';
    left = rect.left - tipW - gap;
  }
  if (left < 4) {
    left = 4;
    placement = 'right';
  }
  let top = rect.top;
  if (top + tipH > window.innerHeight - 4) top = window.innerHeight - tipH - 4;
  if (top < 4) top = 4;
  hoverPos.value = { top, left, placement };
}

function showEq(e, target) {
  hoveredSlot.value = e.slot;
  nextTick(() => positionTooltip(target));
}
// 延迟收起：给鼠标挪进弹层的间隙，避免路过装备格时闪烁
let hideTimer = null;
function armHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!tooltipEl.value?.matches(':hover')) hoveredSlot.value = '';
  }, 150);
}
function cancelHide() {
  if (hideTimer) clearTimeout(hideTimer);
}
function onEqEnter(e, item) {
  if (!item.name) return;
  // 武器格悬浮照常显示手持武器详情卡；全部武器列表由单击展开（见 onEqClick），两者并存
  cancelHide();
  showEq(item, e.currentTarget);
}
function onEqLeave() {
  armHide();
}
// 点击：移动端无 hover 的替代路径；桌面再点同一格也可收起。
// 武器格单击 → 展开/收起武器详情列表（手持+背上全部武器 + 卸下按钮）；展开时收起悬浮卡避免重叠。
function onEqClick(e, item) {
  if (!item.name && item.slot !== '武器') return;
  if (item.slot === '武器') {
    hoveredSlot.value = '';
    weaponsOpen.value = !weaponsOpen.value;
    return;
  }
  if (hoveredSlot.value === item.slot) {
    hoveredSlot.value = '';
    return;
  }
  cancelHide();
  showEq(item, e.currentTarget);
}
function onTooltipLeave() {
  armHide();
}
// 侧栏滚动 / 窗口尺寸变化时直接收起，避免弹层与格子错位
function dismissOnScroll() {
  hoveredSlot.value = '';
}
onMounted(() => {
  window.addEventListener('scroll', dismissOnScroll, true);
  window.addEventListener('resize', dismissOnScroll);
});
onBeforeUnmount(() => {
  window.removeEventListener('scroll', dismissOnScroll, true);
  window.removeEventListener('resize', dismissOnScroll);
  if (hideTimer) clearTimeout(hideTimer);
});

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
