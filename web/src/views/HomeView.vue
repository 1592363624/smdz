<template>
  <div class="yd-page">
    <!-- 顶栏：家园名 / 关键指标 / 状态与刷新 -->
    <header class="yd-top">
      <button class="yd-back" title="返回聊天" @click="router.push('/chat')">←</button>
      <div class="yd-head-main">
        <div class="yd-house">🏡 {{ houseName }}</div>
        <div class="yd-meta">
          <span>Lv.{{ level }}</span>
          <span>凭证 {{ vouchers }}</span>
          <span v-if="progress < 4" class="yd-warn">建造进度 {{ progress }}/4</span>
          <span>作物 {{ crop.used }}/{{ crop.limit }}</span>
          <span>建筑 {{ building.used }}/{{ building.limit }}</span>
        </div>
      </div>
      <div class="yd-head-ops">
        <span class="yd-pill" :class="powerClass">{{ powerText }}</span>
        <span v-if="overloaded" class="yd-pill over">🔥 超载</span>
        <button class="yd-btn ghost" :disabled="loading" @click="refresh">刷新</button>
      </div>
    </header>

    <!-- 加载 / 错误 / 无家园 -->
    <div v-if="loading && !data" class="yd-hint">家园数据加载中...</div>
    <div v-else-if="error && !data" class="yd-hint err">{{ error }}</div>
    <div v-else-if="blocked" class="yd-hint">🏠 {{ blocked }}<span class="yd-dim">发送「圈地」开始建造自己的家园</span></div>

    <template v-else-if="data">
      <!-- 不在院子：种植/安装/拆除/收获都会被人不在院子拦截，先引导回家 -->
      <div v-if="!atHome" class="yd-banner">
        <span>📍 {{ C.texts.notAtHome }}</span>
        <button class="yd-btn primary" :disabled="running" @click="goHome">回家</button>
      </div>

      <div class="yd-body">
        <!-- 左侧：院子地块 -->
        <section class="yd-yard">
          <div class="yd-stats">
            <span class="yd-stat">⚡ 电力 <b>{{ overview?.overview?.powerNet ?? 0 }}</b></span>
            <span class="yd-stat">⛽ 燃料 <b>{{ fmtQty(overview?.overview?.fuelStock ?? 0) }}</b>（{{ fuelText }}）</span>
            <span class="yd-stat">🌱 肥料 <b>{{ fmtQty(overview?.overview?.fertilizerStock ?? 0) }}</b></span>
            <span class="yd-stat">👷 岗位 <b>{{ fmtQty(overview?.overview?.jobSupply ?? 0) }}/{{ overview?.overview?.jobDemand ?? 0 }}</b></span>
            <span class="yd-stat">⏱ 距上次观测 <b>{{ fmtDuration(overview?.elapsedSeconds ?? 0) }}</b></span>
          </div>
          <div v-if="!hasPower" class="yd-alarm">电力不足，建筑生产停止——检查电站与燃料</div>

          <!-- 农田 -->
          <div class="yd-block">
            <div class="yd-block-head">
              <span class="yd-b-title">🌾 农田</span>
              <span class="yd-b-count">{{ crop.used }}/{{ crop.limit }}</span>
              <span class="yd-dim">空地点击选种子种下；地块随等级与凭证开垦</span>
              <button class="yd-btn tiny" :disabled="running" @click="useVoucher">使用凭证开垦 +5</button>
            </div>
            <div class="yd-grid" :style="gridStyle">
              <button
                v-for="p in visibleCropPlots"
                :key="'c-' + p.index"
                class="yd-plot"
                :class="[p.state, { sel: selected === p }]"
                @click="onPlot(p)"
              >
                <span class="yd-p-icon">{{ iconOf(p) }}</span>
                <span class="yd-p-name">{{ p.name || (p.state === 'locked' ? '待开垦' : '+') }}</span>
                <span v-if="p.state === 'occupied'" class="yd-p-out">
                  <span v-if="p.outputs.length" :class="p.outputs[0].quantity >= 0 ? 'gain' : 'cost'">
                    {{ p.outputs[0].quantity >= 0 ? '+' : '' }}{{ fmtQty(p.outputs[0].quantity) }} {{ p.outputs[0].name }}/分
                  </span>
                  <span v-else class="yd-dim">无产出</span>
                </span>
                <span v-else-if="p.state === 'locked'" class="yd-p-hint">🔒 {{ p.unlockHint }}</span>
                <span v-else class="yd-p-hint">{{ C.texts.emptyCrop }}</span>
                <span v-if="p.total > 1" class="yd-p-total">×{{ p.total }}</span>
              </button>
            </div>
            <div v-if="crop.plots.length > visibleCropPlots.length" class="yd-more">
              仅显示前 {{ visibleCropPlots.length }} 块，共 {{ crop.plots.length }} 块
            </div>
          </div>

          <!-- 建筑区 -->
          <div class="yd-block">
            <div class="yd-block-head">
              <span class="yd-b-title">🏭 建筑区</span>
              <span class="yd-b-count">{{ building.used }}/{{ building.limit }}</span>
              <span class="yd-dim">空地点击选建筑安装；已安装的点击可拆除</span>
            </div>
            <div class="yd-grid" :style="gridStyle">
              <button
                v-for="p in visibleBuildingPlots"
                :key="'b-' + p.index"
                class="yd-plot"
                :class="[p.state, { sel: selected === p }]"
                @click="onPlot(p)"
              >
                <span class="yd-p-icon">{{ iconOf(p) }}</span>
                <span class="yd-p-name">{{ p.name || (p.state === 'locked' ? '待开垦' : '+') }}</span>
                <span v-if="p.state === 'occupied'" class="yd-p-out">
                  <span v-if="p.outputs.length" :class="p.outputs[0].quantity >= 0 ? 'gain' : 'cost'">
                    {{ p.outputs[0].quantity >= 0 ? '+' : '' }}{{ fmtQty(p.outputs[0].quantity) }} {{ p.outputs[0].name }}/分
                  </span>
                  <span v-else class="yd-dim">无产出</span>
                </span>
                <span v-else-if="p.state === 'locked'" class="yd-p-hint">🔒 {{ p.unlockHint }}</span>
                <span v-else class="yd-p-hint">{{ C.texts.emptyBuilding }}</span>
                <span v-if="p.total > 1" class="yd-p-total">×{{ p.total }}</span>
              </button>
            </div>
            <div v-if="building.plots.length > visibleBuildingPlots.length" class="yd-more">
              仅显示前 {{ visibleBuildingPlots.length }} 块，共 {{ building.plots.length }} 块
            </div>
          </div>

          <!-- 地面障碍：土堆/杂草未清理会挡住建造 -->
          <div v-if="obstacles.length" class="yd-block">
            <div class="yd-block-head">
              <span class="yd-b-title">🪨 地面障碍</span>
              <span class="yd-dim">清理后地块才能正常使用</span>
            </div>
            <div class="yd-chips">
              <button
                v-for="(o, i) in obstacles"
                :key="'o-' + o.name + '-' + i"
                class="yd-chip obstacle"
                :disabled="running || !o.clearCmd"
                @click="clearObstacle(o)"
              >
                {{ o.name }} ×{{ o.count }}<span v-if="o.clearCmd" class="yd-chip-go">{{ o.clearCmd }}</span>
              </button>
            </div>
          </div>
        </section>

        <!-- 右侧：存放地 / 仓库 / 速率 -->
        <aside class="yd-side">
          <div class="yd-card">
            <div class="yd-card-head">
              <span class="yd-c-title">📦 产出存放地</span>
              <span class="yd-c-count">{{ storage.length }}</span>
            </div>
            <div class="yd-chips">
              <span v-for="(s, i) in storage" :key="'s-' + s.name + '-' + i" class="yd-chip stock">
                {{ s.name }} ×{{ fmtQty(s.quantity) }}
              </span>
              <span v-if="!storage.length" class="yd-empty">暂无存放产出</span>
            </div>
            <button class="yd-btn primary block" :disabled="running" @click="collect">🎁 一键领取（产出）</button>
            <div v-if="claimList.length" class="yd-claim">
              预计可得：<span v-for="g in claimList" :key="'g-' + g.name" class="gain">+{{ g.name }}×{{ fmtQty(g.quantity) }}</span>
            </div>
          </div>

          <div class="yd-card">
            <div class="yd-card-head">
              <button class="yd-tab" :class="{ on: stockTab === 'seed' }" @click="stockTab = 'seed'">🌱 种子 {{ seeds.length }}</button>
              <button class="yd-tab" :class="{ on: stockTab === 'building' }" @click="stockTab = 'building'">🏗️ 建筑 {{ buildings.length }}</button>
            </div>
            <div class="yd-stock-list">
              <button
                v-for="s in stockList"
                :key="'k-' + s.name"
                class="yd-stock"
                :disabled="running"
                @click="quickUse(s)"
              >
                <span class="yd-s-icon">{{ stockIcon(s) }}</span>
                <span class="yd-s-main">
                  <span class="yd-s-name">{{ s.name }}</span>
                  <span class="yd-s-target">→ {{ s.target }}</span>
                </span>
                <span class="yd-s-qty">×{{ fmtQty(s.quantity) }}</span>
                <span class="yd-s-go">{{ s.kind === 'seed' ? '种下' : '安装' }}</span>
              </button>
              <div v-if="!stockList.length" class="yd-empty">
                {{ stockTab === 'seed' ? C.texts.noSeed : C.texts.noBuilding }}
              </div>
            </div>
          </div>

          <div class="yd-card" v-if="dailyList.length">
            <div class="yd-card-head"><span class="yd-c-title">📈 每日产出速率</span></div>
            <div class="yd-chips">
              <span v-for="(d, i) in dailyList" :key="'d-' + d.name + '-' + i" class="yd-chip rate">
                {{ d.name }} {{ fmtQty(d.quantity) }}/天
              </span>
            </div>
          </div>
        </aside>
      </div>

      <!-- 选中地块详情条 -->
      <div v-if="selected && selected.state === 'occupied'" class="yd-detail">
        <div class="yd-d-head">
          <span class="yd-d-icon">{{ iconOf(selected) }}</span>
          <div class="yd-d-info">
            <div class="yd-d-name">
              {{ selected.name }}<span v-if="selected.total > 1"> ×{{ selected.total }}</span>
            </div>
            <div class="yd-d-desc">{{ selected.description || '暂无描述' }}</div>
          </div>
          <button class="yd-x" @click="selected = null">✕</button>
        </div>
        <div class="yd-d-rates">
          <span v-for="(o, i) in selected.outputs" :key="'ro-' + i" :class="o.quantity >= 0 ? 'gain' : 'cost'">
            {{ o.name }} {{ fmtQty(o.quantity) }}/分
          </span>
          <span v-for="(h, i) in selected.harvest" :key="'rh-' + i" class="gain">
            {{ selected.kind === 'crop' ? '收获' : '拆除返还' }} {{ h.name }}×{{ fmtQty(h.quantity) }}
          </span>
        </div>
        <div class="yd-d-ops">
          <template v-if="selected.kind === 'crop'">
            <button class="yd-btn warn" :disabled="running" @click="run(C.commands.harvest(selected.name))">
              🌾 收获全部（{{ selected.name }} ×{{ selected.total }}）
            </button>
            <span class="yd-dim">作物按名称聚合存放，收获会一次收走同名的全部</span>
          </template>
          <template v-else>
            <button class="yd-btn danger" :disabled="running" @click="run(C.commands.remove(selected.name))">
              🔨 拆除 1 个
            </button>
            <button
              v-if="selected.total > 1"
              class="yd-btn danger"
              :disabled="running"
              @click="run(C.commands.remove(selected.name + selected.total))"
            >
              拆除全部 {{ selected.total }}
            </button>
          </template>
        </div>
      </div>

      <!-- 选择种子 / 建筑 -->
      <div v-if="picker.open" class="yd-mask" @click.self="picker.open = false">
        <div class="yd-modal">
          <div class="yd-m-head">
            {{ picker.kind === 'crop' ? C.texts.pickSeedTitle : C.texts.pickBuildingTitle }}
            <button class="yd-x" @click="picker.open = false">✕</button>
          </div>
          <div class="yd-m-list">
            <button
              v-for="s in picker.items"
              :key="'p-' + s.name"
              class="yd-stock"
              @click="pickStock(s)"
            >
              <span class="yd-s-icon">{{ stockIcon(s) }}</span>
              <span class="yd-s-main">
                <span class="yd-s-name">{{ s.name }}</span>
                <span class="yd-s-target">→ {{ s.target }}</span>
              </span>
              <span class="yd-s-qty">×{{ fmtQty(s.quantity) }}</span>
              <span class="yd-s-go">{{ s.kind === 'seed' ? '种下' : '安装' }}</span>
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
/**
 * 家园院子（QQ 农场式格子视图）独立页面。
 *
 * 数据来源：GET /api/game/home/yard（只读，不结算、不领取）。
 * 写操作约定：种植/收获/安装/拆除/领取一律通过 commandApi.execute 发送与 QQ 端
 * 逐字相同的文本指令，与聊天输入框、AstrBot 完全同一条路径——没有第二条写路径，
 * 结算口径不会双轨，操作结果也照常进聊天流。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { commandApi, homeApi } from '../api';
import { HOME_YARD_CONFIG as C } from '../config';
import { useUiStore } from '../stores/ui';

const router = useRouter();
const ui = useUiStore();

const data = ref(null);
const loading = ref(false);
const error = ref('');
/** 指令执行中：期间禁用其它操作，避免并发写入 */
const running = ref(false);
/** 当前选中的地块（详情条数据源） */
const selected = ref(null);
/** 空地上弹出的种子/建筑选择器 */
const picker = ref({ open: false, kind: 'crop', items: [] });
/** 右侧仓库当前 Tab */
const stockTab = ref('seed');
let timer = null;

// ---------- 派生数据 ----------
const houseName = computed(() => data.value?.houseName || '家园');
const level = computed(() => Number(data.value?.level ?? 1) || 1);
const vouchers = computed(() => Number(data.value?.vouchers ?? 0) || 0);
const progress = computed(() => Number(data.value?.progress ?? 0) || 0);
const atHome = computed(() => Boolean(data.value?.atHome));
const blocked = computed(() => data.value?.blocked || '');
const crop = computed(() => data.value?.crop || { used: 0, limit: 0, plots: [] });
const building = computed(() => data.value?.building || { used: 0, limit: 0, plots: [] });
const obstacles = computed(() => data.value?.obstacles || []);
const seeds = computed(() => data.value?.seeds || []);
const buildings = computed(() => data.value?.buildings || []);
const storage = computed(() => data.value?.storage || []);
const overview = computed(() => data.value?.overview || null);
const hasPower = computed(() => overview.value?.hasPower !== false);
const overloaded = computed(() => Boolean(overview.value?.overloaded));
const powerText = computed(() => (hasPower.value ? '⚡ 有电' : '⛔ 无电'));
const powerClass = computed(() => (hasPower.value ? 'ok' : 'bad'));
const fuelText = computed(() => {
  const seconds = overview.value?.overview?.fuelSeconds;
  if (seconds === null || seconds === undefined) return '∞';
  return fmtDuration(seconds);
});
const dailyList = computed(() => overview.value?.overview?.dailyDisplay || []);
const claimList = computed(() => (overview.value?.gains || []).filter((g) => Number(g.quantity) > 0));
const stockList = computed(() => (stockTab.value === 'seed' ? seeds.value : buildings.value));
// 地块可能成百上千（高等级 + 多凭证），只渲染前 N 块防止页面卡死
const visibleCropPlots = computed(() => crop.value.plots.slice(0, C.plot.maxVisible));
const visibleBuildingPlots = computed(() => building.value.plots.slice(0, C.plot.maxVisible));
const gridStyle = computed(() => ({
  '--yd-min': `${C.plot.minSize}px`,
  '--yd-gap': `${C.plot.gap}px`,
}));

// ---------- 数据拉取 ----------
async function refresh() {
  loading.value = true;
  try {
    const res = await homeApi.yard();
    data.value = res?.data ?? null;
    error.value = '';
  } catch (e) {
    error.value = e?.response?.data?.message || '家园数据加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  refresh();
  timer = setInterval(refresh, C.refreshMs);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

// ---------- 展示工具 ----------
/** 按名称关键词匹配图标（规则见 config.HOME_YARD_CONFIG.icons） */
function matchIcon(name, kind) {
  const rules = C.icons[kind] || [];
  for (const rule of rules) {
    if (name.includes(rule.kw)) return rule.icon;
  }
  return C.fallbackIcon[kind] || '❔';
}
function iconOf(plot) {
  if (!plot) return '';
  if (plot.state === 'locked') return '🔒';
  if (plot.state === 'empty') return plot.kind === 'crop' ? '🟫' : '⬜';
  return matchIcon(plot.name, plot.kind);
}
function stockIcon(stock) {
  return matchIcon(stock.target || stock.name, stock.kind === 'seed' ? 'crop' : 'building');
}
/** 展示口径：大数取整、一般两位小数、极小值四位（与 HomePanel 保持一致） */
function fmtQty(v) {
  const n = Number(v) || 0;
  const abs = Math.abs(n);
  if (abs >= 100) return String(Math.round(n));
  if (abs >= 0.01 || abs === 0) return String(Math.round(n * 100) / 100);
  return String(Math.round(n * 10000) / 10000);
}
function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}时${m}分` : `${m}分`;
}

// ---------- 操作 ----------
/**
 * 执行一条游戏指令（唯一的写路径）。
 * @param {string} cmd 与 QQ 端一致的指令文本
 * @param {{requireHome?: boolean}} opts requireHome=false 用于「产出」等无需在院子的操作
 */
async function run(cmd, opts = {}) {
  const requireHome = opts.requireHome !== false;
  if (running.value || !cmd) return;
  if (requireHome && !atHome.value) {
    ui.pushToast({ type: 'warning', message: C.texts.notAtHome });
    return;
  }
  running.value = true;
  try {
    const res = await commandApi.execute(cmd);
    const text = res?.data?.content ?? '';
    ui.pushToast({ type: 'success', message: text || `已执行：${cmd}`, timeout: 4000 });
  } catch (e) {
    ui.pushToast({ type: 'error', message: e?.response?.data?.message || `执行失败：${cmd}` });
  } finally {
    running.value = false;
    selected.value = null;
    picker.value.open = false;
    // 后端写完再读，避免读到旧快照
    setTimeout(refresh, C.refetchDelayMs);
  }
}

function onPlot(plot) {
  if (!plot) return;
  if (plot.state === 'locked') {
    ui.pushToast({ type: 'info', message: plot.unlockHint || '该地块尚未开垦' });
    return;
  }
  selected.value = plot;
  if (plot.state === 'empty') openPicker(plot.kind);
}

function openPicker(kind) {
  const items = kind === 'crop' ? seeds.value : buildings.value;
  if (!items.length) {
    ui.pushToast({ type: 'info', message: kind === 'crop' ? C.texts.noSeed : C.texts.noBuilding });
    return;
  }
  picker.value = { open: true, kind, items };
}

function pickStock(stock) {
  const cmd = stock.kind === 'seed'
    ? C.commands.plant(stock.name)
    : C.commands.install(stock.name);
  run(cmd);
}

/** 仓库里直接点「种下 / 安装」：等价于发送一次指令 */
function quickUse(stock) {
  pickStock(stock);
}

function goHome() {
  run(C.commands.goHome(houseName.value), { requireHome: false });
}
function collect() {
  run(C.commands.collect(), { requireHome: false });
}
function useVoucher() {
  run(C.commands.useVoucher(), { requireHome: false });
}
function clearObstacle(obstacle) {
  if (!obstacle?.clearCmd) return;
  run(obstacle.clearCmd);
}
</script>

<style scoped>
.yd-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg2, #0f1116);
  color: var(--text, #e5e7eb);
  font-size: 13px;
  overflow: hidden;
}

/* ---------- 顶栏 ---------- */
.yd-top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg3, #171a21);
  flex-shrink: 0;
}
.yd-back {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg2, #0f1116);
  color: var(--text, #e5e7eb);
  cursor: pointer;
  font-size: 16px;
}
.yd-back:hover {
  filter: brightness(1.2);
}
.yd-head-main {
  min-width: 0;
  flex: 1;
}
.yd-house {
  font-size: 16px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.yd-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  color: var(--muted);
  font-size: 11px;
  margin-top: 2px;
}
.yd-warn {
  color: #fb923c;
}
.yd-head-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.yd-pill {
  padding: 3px 9px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg2, #0f1116);
  font-size: 11px;
  white-space: nowrap;
}
.yd-pill.ok {
  color: #4ade80;
  border-color: rgba(74, 222, 128, 0.4);
}
.yd-pill.bad {
  color: #f87171;
  border-color: rgba(248, 113, 113, 0.4);
}
.yd-pill.over {
  color: #fb923c;
  border-color: rgba(251, 146, 60, 0.45);
}

/* ---------- 通用块 ---------- */
.yd-hint {
  padding: 24px;
  text-align: center;
  color: var(--muted);
  line-height: 1.8;
}
.yd-hint.err {
  color: #f87171;
}
.yd-dim {
  color: var(--muted);
  font-size: 11px;
}
.yd-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 10px 14px 0;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid rgba(251, 146, 60, 0.4);
  background: rgba(251, 146, 60, 0.1);
  color: #fb923c;
  flex-shrink: 0;
}
.yd-alarm {
  margin-bottom: 10px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid rgba(248, 113, 113, 0.3);
  background: rgba(248, 113, 113, 0.08);
  color: #f87171;
}
.yd-btn {
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg2, #0f1116);
  color: var(--text, #e5e7eb);
  cursor: pointer;
  font-size: 12px;
  transition: filter 0.15s;
}
.yd-btn:hover:not(:disabled) {
  filter: brightness(1.25);
}
.yd-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.yd-btn.ghost {
  background: transparent;
}
.yd-btn.tiny {
  padding: 3px 8px;
  font-size: 11px;
  margin-left: auto;
}
.yd-btn.primary {
  border-color: rgba(139, 92, 246, 0.45);
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.22), rgba(6, 182, 212, 0.16));
  font-weight: 600;
}
.yd-btn.warn {
  border-color: rgba(74, 222, 128, 0.45);
  color: #4ade80;
}
.yd-btn.danger {
  border-color: rgba(248, 113, 113, 0.45);
  color: #f87171;
}
.yd-btn.block {
  display: block;
  width: 100%;
  margin-top: 8px;
}

/* ---------- 主体 ---------- */
.yd-body {
  flex: 1;
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  overflow: hidden;
  min-height: 0;
}
.yd-yard {
  flex: 1;
  overflow-y: auto;
  padding-right: 4px;
  min-width: 0;
}
.yd-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.yd-stat {
  padding: 4px 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg3, #171a21);
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}
.yd-stat b {
  color: var(--text, #e5e7eb);
}
.yd-block {
  margin-bottom: 16px;
}
.yd-block-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.yd-b-title {
  font-weight: 700;
}
.yd-b-count {
  color: var(--accent, #8b5cf6);
  background: var(--bg3, #171a21);
  border-radius: 8px;
  padding: 0 6px;
  font-size: 11px;
}

/* ---------- 地块网格 ---------- */
.yd-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--yd-min, 96px), 1fr));
  gap: var(--yd-gap, 10px);
}
.yd-plot {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-height: 88px;
  padding: 8px 6px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg3, #171a21);
  color: var(--text, #e5e7eb);
  cursor: pointer;
  transition: transform 0.12s, border-color 0.12s, background 0.12s;
  overflow: hidden;
}
.yd-plot:hover {
  transform: translateY(-2px);
  border-color: var(--accent, #8b5cf6);
}
.yd-plot.sel {
  border-color: var(--accent, #8b5cf6);
  box-shadow: 0 0 0 1px var(--accent, #8b5cf6) inset;
}
.yd-plot.empty {
  border-style: dashed;
  background: rgba(139, 92, 246, 0.04);
}
.yd-plot.locked {
  opacity: 0.5;
  cursor: not-allowed;
  background: repeating-linear-gradient(
    45deg,
    var(--bg3, #171a21),
    var(--bg3, #171a21) 8px,
    rgba(255, 255, 255, 0.03) 8px,
    rgba(255, 255, 255, 0.03) 16px
  );
}
.yd-plot.locked:hover {
  transform: none;
  border-color: var(--border);
}
.yd-p-icon {
  font-size: 22px;
  line-height: 1;
}
.yd-p-name {
  font-size: 12px;
  font-weight: 600;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.yd-p-out {
  font-size: 10px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.yd-p-hint {
  font-size: 10px;
  color: var(--muted);
  text-align: center;
  line-height: 1.4;
}
.yd-p-total {
  position: absolute;
  top: 4px;
  right: 5px;
  font-size: 10px;
  color: var(--accent, #8b5cf6);
  background: var(--bg2, #0f1116);
  border-radius: 6px;
  padding: 0 4px;
}
.yd-more {
  margin-top: 6px;
  color: var(--muted);
  font-size: 11px;
}
.gain {
  color: #4ade80;
}
.cost {
  color: #f87171;
}

/* ---------- 右侧栏 ---------- */
.yd-side {
  width: 320px;
  flex-shrink: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.yd-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg3, #171a21);
  padding: 10px;
}
.yd-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.yd-c-title {
  font-weight: 700;
  font-size: 12px;
}
.yd-c-count {
  color: var(--accent, #8b5cf6);
  background: var(--bg2, #0f1116);
  border-radius: 8px;
  padding: 0 6px;
  font-size: 10px;
}
.yd-tab {
  flex: 1;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
}
.yd-tab.on {
  color: var(--text, #e5e7eb);
  border-color: var(--accent, #8b5cf6);
  background: rgba(139, 92, 246, 0.12);
}
.yd-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.yd-chip {
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg2, #0f1116);
  font-size: 11px;
  white-space: nowrap;
  color: var(--muted);
}
.yd-chip.stock {
  cursor: default;
}
.yd-chip.obstacle {
  cursor: pointer;
  color: #fb923c;
  border-color: rgba(251, 146, 60, 0.4);
}
.yd-chip.obstacle:hover:not(:disabled) {
  filter: brightness(1.2);
}
.yd-chip-go {
  margin-left: 6px;
  color: var(--accent, #8b5cf6);
}
.yd-chip.rate {
  color: var(--accent2, #06b6d4);
}
.yd-claim {
  margin-top: 8px;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.7;
}
.yd-claim .gain {
  margin-right: 6px;
}
.yd-stock-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 320px;
  overflow-y: auto;
}
.yd-stock {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg2, #0f1116);
  color: var(--text, #e5e7eb);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.12s;
}
.yd-stock:hover:not(:disabled) {
  border-color: var(--accent, #8b5cf6);
}
.yd-stock:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.yd-s-icon {
  font-size: 18px;
  flex-shrink: 0;
}
.yd-s-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.yd-s-name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.yd-s-target {
  font-size: 10px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.yd-s-qty {
  font-size: 11px;
  color: var(--muted);
  flex-shrink: 0;
}
.yd-s-go {
  font-size: 11px;
  color: var(--accent, #8b5cf6);
  flex-shrink: 0;
}
.yd-empty {
  color: var(--muted);
  font-size: 11px;
  padding: 8px;
  text-align: center;
}

/* ---------- 详情条 ---------- */
.yd-detail {
  border-top: 1px solid var(--border);
  background: var(--bg3, #171a21);
  padding: 10px 14px;
  flex-shrink: 0;
}
.yd-d-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.yd-d-icon {
  font-size: 24px;
}
.yd-d-info {
  flex: 1;
  min-width: 0;
}
.yd-d-name {
  font-weight: 700;
}
.yd-d-desc {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
  margin-top: 2px;
}
.yd-x {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
}
.yd-d-rates {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0;
  font-size: 11px;
}
.yd-d-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* ---------- 选择器 ---------- */
.yd-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 20px;
}
.yd-modal {
  width: min(420px, 100%);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg3, #171a21);
  overflow: hidden;
}
.yd-m-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  font-weight: 700;
}
.yd-m-list {
  padding: 10px 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* ---------- 移动端 ---------- */
@media (max-width: 980px) {
  .yd-body {
    flex-direction: column;
    overflow-y: auto;
  }
  .yd-yard,
  .yd-side {
    width: 100%;
    overflow: visible;
  }
  .yd-top {
    flex-wrap: wrap;
  }
  .yd-meta {
    font-size: 10px;
  }
}
</style>
