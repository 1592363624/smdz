<template>
  <div class="fl-page">
    <!-- 顶栏：前线名 / 关键指标 / 状态与刷新 -->
    <header class="fl-top">
      <button class="fl-back" title="返回聊天" @click="router.push('/chat')">←</button>
      <!-- 家园系统内面板切换：院子 ↔ 前线互相跳转 -->
      <div class="fl-switch">
        <button class="fl-switch-btn" title="返回家园院子" @click="router.push('/home')">🏡 家园</button>
        <span class="fl-switch-btn on">🛡️ 前线</span>
      </div>
      <div class="fl-head-main">
        <div class="fl-house">🛡️ {{ houseName }}前线</div>
        <div class="fl-meta">
          <span>前线等级 Lv.{{ frontLevel }}</span>
          <span>防御 {{ defense.used }}/{{ defense.limit }}</span>
          <span v-if="enemies.length" class="fl-warn">⚠ 敌人 {{ enemies.length }}</span>
          <span v-else class="fl-ok">前线平静</span>
          <span v-if="active.active" class="fl-act">⚔️ 活动 {{ active.remainSeconds }}s</span>
        </div>
      </div>
      <div class="fl-head-ops">
        <span v-if="atFrontline" class="fl-pill ok">📍 在前线</span>
        <span v-else class="fl-pill">📍 未在前线</span>
        <button class="fl-btn ghost" :disabled="loading" @click="refresh">刷新</button>
      </div>
    </header>

    <!-- 房子未建成 / 无家园：全屏引导（只引导去建房子，前线功能一律不开放） -->
    <div v-if="data && (!houseName || progress < 4)" class="fl-full-cta">
      <div class="fl-cta-card">
        <div class="fl-cta-icon">🏗️</div>
        <div class="fl-cta-title">{{ !houseName ? '还没有家园' : '前线尚未解锁' }}</div>
        <div class="fl-cta-desc">{{ !houseName ? '先发送「圈地」选一块地，完成建房后即可开启前线防守' : '需要先完成房屋的建造（家园进度 4/4），才能开启前线' }}</div>
        <button class="fl-btn primary block" @click="router.push('/home')">去家园建造 →</button>
      </div>
    </div>

    <!-- 数据加载中 -->
    <div v-else-if="!data && loading" class="fl-loading">前线数据加载中…</div>

    <!-- 拉取失败：原来 error 只写不读，失败时整页空白，玩家不知道是前线没了还是网络断了 -->
    <div v-else-if="!data && error" class="fl-loading err">
      <div>{{ error }}</div>
      <button class="fl-btn primary" :disabled="loading" @click="refresh">重试</button>
    </div>

    <!-- 主体：QQ 农场式模块卡片 -->
    <main v-else-if="data" class="fl-body">
      <div v-if="error" class="fl-banner">{{ error }}（下面仍是最近一次成功加载的前线状态）</div>
      <!-- 状态头卡：防御阵地总览 -->
      <section class="fl-block status">
        <div class="fl-block-head"><span class="fl-b-chip shield">🛡️</span><span>防御阵地</span></div>
        <div class="fl-status-row">
          <div class="fl-stat">
            <div class="fl-stat-val">{{ frontLevel }}</div>
            <div class="fl-stat-label">前线等级</div>
          </div>
          <div class="fl-stat">
            <div class="fl-stat-val">{{ defense.used }}<em>/{{ defense.limit }}</em></div>
            <div class="fl-stat-label">防御建筑</div>
          </div>
          <div class="fl-stat">
            <div class="fl-stat-val" :class="{ act: active.active }">{{ active.active ? `${active.remainSeconds}s` : '—' }}</div>
            <div class="fl-stat-label">活动状态</div>
          </div>
        </div>
        <div class="fl-hint">{{ C.texts.frontlineHint }}</div>
      </section>

      <!-- 敌人区：地精波次（开始战斗后出现） -->
      <section class="fl-block enemy">
        <div class="fl-block-head"><span class="fl-b-chip enemy">⚔️</span><span>敌人</span><span v-if="enemies.length" class="fl-chip-count">{{ enemies.length }}</span></div>
        <div v-if="enemies.length" class="fl-enemy-list">
          <div v-for="(e, i) in enemies" :key="i" class="fl-enemy">
            <span class="fl-enemy-icon">{{ iconOf(e.name, 'enemy') }}</span>
            <div class="fl-enemy-main">
              <div class="fl-enemy-name">{{ e.name }}<em> Lv.{{ e.level }}</em></div>
              <div class="fl-enemy-hp"><div class="fl-enemy-hp-fill" :style="{ width: hpPct(e) + '%' }"></div></div>
              <div class="fl-enemy-num">{{ e.hp }} / {{ e.maxHp }}</div>
            </div>
          </div>
        </div>
        <div v-else class="fl-empty">{{ C.texts.frontlineQuiet }}</div>
      </section>

      <!-- 火力通道：前线召唤物的武器 -->
      <section class="fl-block firepower">
        <div class="fl-block-head"><span class="fl-b-chip fire">🎯</span><span>火力通道</span></div>
        <div v-if="firepower.length" class="fl-weapon-list">
          <div v-for="(w, i) in firepower" :key="i" class="fl-weapon">
            <span class="fl-weapon-icon">{{ iconOf(w.name, 'weapon') }}</span>
            <span class="fl-weapon-name">{{ w.name }}</span>
            <span class="fl-weapon-dmg">伤害 {{ w.damagePct }}%</span>
          </div>
        </div>
        <div v-else class="fl-empty">{{ C.texts.noFirepower }}</div>
      </section>

      <!-- 已安装的防御建筑 -->
      <section class="fl-block built">
        <div class="fl-block-head"><span class="fl-b-chip build">🏰</span><span>防御建筑</span><span v-if="defense.buildings.length" class="fl-chip-count">{{ defense.used }}/{{ defense.limit }}</span></div>
        <div v-if="defense.buildings.length" class="fl-grid">
          <button v-for="(b, i) in defense.buildings" :key="i" class="fl-cell" :class="{ disabled: !atFrontline }" :title="atFrontline ? '点击拆卸' : C.texts.needFrontline" @click="askRemove(b)">
            <span class="fl-cell-icon">{{ iconOf(b.name, 'building') }}</span>
            <span class="fl-cell-name">{{ b.name }}</span>
            <span class="fl-cell-num">×{{ b.quantity }}</span>
          </button>
        </div>
        <div v-else class="fl-empty">尚未安装防御建筑，从下方库存中安装</div>
      </section>

      <!-- 背包可安装的防御建筑库存 -->
      <section class="fl-block stock">
        <div class="fl-block-head"><span class="fl-b-chip stock">📦</span><span>可安装的防御建筑</span><span v-if="stock.length" class="fl-chip-count">{{ stock.length }} 种</span></div>
        <div v-if="stock.length" class="fl-grid">
          <button v-for="(s, i) in stock" :key="i" class="fl-cell" :class="{ disabled: !atFrontline }" :title="atFrontline ? `点击安装 ${s.name}` : C.texts.needFrontline" @click="install(s)">
            <span class="fl-cell-icon">{{ iconOf(s.name, 'building') }}</span>
            <span class="fl-cell-name">{{ s.name }}</span>
            <span class="fl-cell-num">×{{ s.quantity }}</span>
          </button>
        </div>
        <div v-else class="fl-empty">{{ C.texts.installEmpty }}</div>
      </section>

      <!-- 底部操作条 -->
      <div class="fl-actions">
        <button v-if="!atFrontline" class="fl-btn primary big" :disabled="running" @click="goFrontline">
          📍 前往前线
        </button>
        <button v-else class="fl-btn danger big" :disabled="running || enemies.length > 0 || !canBattle" :title="enemies.length ? C.texts.hasEnemies : C.texts.canBattle" @click="startBattle">
          {{ enemies.length ? '⚔️ 战斗进行中' : '⚔️ 开始战斗' }}
        </button>
      </div>
    </main>

    <!-- 拆卸确认弹窗 -->
    <div v-if="confirm" class="fl-mask" @click.self="confirm = null">
      <div class="fl-modal">
        <div class="fl-modal-title">拆卸防御建筑</div>
        <div class="fl-modal-desc">{{ C.texts.removeConfirm(confirm.name, confirm.quantity) }}</div>
        <div class="fl-modal-btns">
          <button class="fl-btn ghost" :disabled="running" @click="confirm = null">取消</button>
          <button class="fl-btn danger" :disabled="running" @click="doRemove">拆卸</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
/** 组件名供 App.vue 的 keep-alive include 使用 */
defineOptions({ name: 'FrontlineView' });
/**
 * 家园前线面板（只读视图 + 统一指令通道写操作）。
 *
 * 数据源：homeApi.frontline（只读 DTO，不结算不写库）；
 * 写操作（前往前线 / 安装 / 拆卸 / 开始战斗）一律通过 commandApi.execute
 * 发送与 QQ 端逐字相同的文本指令（config.HOME_FRONTLINE_CONFIG.commands），
 * 没有第二条写路径，结算口径不会双轨。
 */
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { commandApi, homeApi } from '../api';
import { HOME_FRONTLINE_CONFIG as C } from '../config';
import { useUiStore } from '../stores/ui';
import { onTabRetap, scrollTopWithin } from '../composables/useTabRetap';

const router = useRouter();
const ui = useUiStore();

const data = ref(null);
const loading = ref(false);
const error = ref('');
/** 指令执行中：期间禁用其它操作，避免并发写入 */
const running = ref(false);
/** 拆卸确认弹窗数据（{name, quantity}） */
const confirm = ref(null);

let timer = null;

const houseName = computed(() => data.value?.houseName || '');
const progress = computed(() => Number(data.value?.progress ?? 0) || 0);
const frontLevel = computed(() => Number(data.value?.frontLevel ?? 0) || 0);
const atFrontline = computed(() => Boolean(data.value?.atFrontline));
const defense = computed(() => data.value?.defense || { used: 0, limit: 3, buildings: [] });
const firepower = computed(() => data.value?.firepower || []);
const enemies = computed(() => data.value?.enemies || []);
const active = computed(() => data.value?.active || { active: false, remainSeconds: 0 });
const stock = computed(() => data.value?.stock || []);
const canBattle = computed(() => Boolean(data.value?.canBattle));

/** 上次自动补发「前往前线」的时间戳（毫秒），配合 autoEnter.cooldownMs 防止赶路中反复重发 */
let lastAutoEnterAt = 0;

/**
 * 进入前线页自动前往前线：布防 / 拆卸 / 战斗都要求人在前线，
 * 刷新后检测到不在前线就自动补发一次「前往 家园名前线」。
 * 走的是与手动按钮相同的统一指令通道，只是前置校验静默化（无家园 / 未建成时不弹警告），
 * 冷却期内不重发，服务器返回的文本仍以 toast 告知。
 */
async function maybeAutoEnterFrontline() {
  if (!C.autoEnter?.enabled) return;
  // 无家园 / 房子未建成 / 已在前线 / 有指令在跑：都不需要自动补发
  if (!houseName.value || progress.value < 4 || atFrontline.value || running.value) return;
  const now = Date.now();
  if (now - lastAutoEnterAt < (Number(C.autoEnter.cooldownMs) || 0)) return;
  lastAutoEnterAt = now;
  try {
    const res = await commandApi.execute(C.commands.goFrontline(houseName.value));
    const text = res?.data?.content ?? '';
    ui.pushToast({ type: text.includes('成功') ? 'success' : 'info', message: text || '已自动前往前线', timeout: 4000 });
    // 指令落地后补拉一次，尽快把 atFrontline 刷成 true
    setTimeout(refresh, C.refetchDelayMs);
  } catch (e) {
    ui.pushToast({ type: 'info', message: e?.response?.data?.message || '自动前往前线失败，可手动点击「前往前线」' });
  }
}

async function refresh() {
  loading.value = true;
  try {
    const res = await homeApi.frontline();
    data.value = res?.data ?? null;
    error.value = '';
    // 数据到位后再判定位置，避免用旧的 atFrontline 误判
    void maybeAutoEnterFrontline();
  } catch (e) {
    error.value = e?.response?.data?.message || '前线数据加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  refresh();
  timer = setInterval(refresh, C.refreshMs);
});
/* 再点一次「前线」标签：回到阵地顶部，不用玩家自己往上拖 */
onTabRetap('/frontline', () => scrollTopWithin('.fl-body'));

/* keep-alive 配套：失活时停表，切回来立刻补一次刷新。
   不这么做的话，本在前线之后被缓存的页面会一直在后台拉接口。 */
onActivated(() => {
  if (timer) return;
  refresh();
  timer = setInterval(refresh, C.refreshMs);
});
onDeactivated(() => {
  if (timer) { clearInterval(timer); timer = null; }
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

// ---------- 展示工具 ----------
/** 按名称关键词匹配图标（规则见 config.HOME_FRONTLINE_CONFIG.icons） */
function iconOf(name, kind) {
  const rules = C.icons[kind] || [];
  for (const rule of rules) {
    if (name.includes(rule.kw)) return rule.icon;
  }
  return C.fallbackIcon[kind] || '❔';
}
/** 敌人血量百分比（夹 0~100，保证血条不会撑破） */
function hpPct(e) {
  const max = Number(e?.maxHp) || 1;
  return Math.max(0, Math.min(100, Math.round((Number(e?.hp) || 0) / max * 100)));
}

// ---------- 指令执行 ----------
/** 校验前置状态：房子未建成 / 无家园一律拦截 */
function gateBlocked() {
  if (!houseName.value) {
    ui.pushToast({ type: 'warning', message: C.texts.noHouse });
    return true;
  }
  if (progress.value < 4) {
    ui.pushToast({ type: 'warning', message: C.texts.needBuilt });
    return true;
  }
  return false;
}

/**
 * 执行单条指令并刷新数据。
 * @param {string} cmd 与 QQ 端逐字一致的指令文本
 * @param {{requireFrontline?: boolean}} opts 布防/拆卸要求人在前线
 */
async function run(cmd, opts = {}) {
  if (running.value) return;
  if (gateBlocked()) return;
  if (opts.requireFrontline && !atFrontline.value) {
    ui.pushToast({ type: 'warning', message: C.texts.needFrontline });
    return;
  }
  running.value = true;
  try {
    const res = await commandApi.execute(cmd);
    const text = res?.data?.content ?? '';
    ui.pushToast({ type: text.includes('成功') ? 'success' : 'info', message: text || '指令已发送', timeout: 4000 });
  } catch (e) {
    ui.pushToast({ type: 'error', message: e?.response?.data?.message || `执行失败：${cmd}` });
  } finally {
    running.value = false;
    setTimeout(refresh, C.refetchDelayMs);
  }
}

/** 前往前线地图（原版「前往 家园名前线」，无地点门禁，随时可去） */
function goFrontline() {
  run(C.commands.goFrontline(houseName.value));
}

/** 安装防御建筑（要求人在前线；原版「安装 名称N」数量缺省 1） */
function install(s) {
  run(C.commands.install(s.name), { requireFrontline: true });
}

/** 弹出拆卸确认（要求人在前线） */
function askRemove(b) {
  if (!atFrontline.value) {
    ui.pushToast({ type: 'warning', message: C.texts.needFrontline });
    return;
  }
  confirm.value = { name: b.name, quantity: b.quantity };
}

/** 执行拆卸（原版「拆卸 名称N」数量缺省 1，逐格拆除） */
async function doRemove() {
  if (!confirm.value || running.value) return;
  const { name } = confirm.value;
  confirm.value = null;
  await run(C.commands.remove(name), { requireFrontline: true });
}

/** 开始战斗（原版「开始战斗」：消耗活跃度 1，生成地精波次；无地点门禁） */
function startBattle() {
  if (enemies.value.length > 0) {
    ui.pushToast({ type: 'warning', message: C.texts.hasEnemies });
    return;
  }
  if (!window.confirm(C.texts.startBattleConfirm)) return;
  run(C.commands.startBattle());
}
</script>

<style scoped>
.fl-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg2, #0f1116);
  color: var(--text, #e5e7eb);
  font-size: 13px;
  overflow: hidden;
}

/* ---------- 顶栏 ---------- */
.fl-top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg3, #171a21);
  flex-shrink: 0;
}
.fl-back {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg2, #0f1116);
  color: var(--text, #e5e7eb);
  cursor: pointer;
  font-size: 16px;
}
.fl-back:hover {
  filter: brightness(1.2);
}
/* 触屏没有 hover，只有 hover 态的键按下去必须另有反馈，否则点上去像没反应 */
.fl-back:active {
  filter: brightness(1.5);
  transform: scale(0.9);
}
/* ---------- 家园 ↔ 前线 面板切换 ---------- */
.fl-switch {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg2, #0f1116);
  flex-shrink: 0;
}
.fl-switch-btn {
  padding: 4px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
button.fl-switch-btn {
  cursor: pointer;
}
button.fl-switch-btn:hover {
  color: var(--text, #e5e7eb);
  background: rgba(255, 255, 255, 0.06);
}
/* 分段控件的未选中一半：手机上它是唯一的页内导航，按下要有"陷进去"的手感 */
button.fl-switch-btn:active {
  transform: scale(0.96);
  filter: brightness(1.35);
}
.fl-switch-btn.on {
  color: var(--text, #e5e7eb);
  background: rgba(139, 92, 246, 0.16);
}
.fl-head-main {
  min-width: 0;
  flex: 1;
}
.fl-house {
  font-size: 16px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fl-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  color: var(--muted);
  font-size: 11px;
  margin-top: 2px;
}
.fl-warn {
  color: #f87171;
}
.fl-ok {
  color: #4ade80;
}
.fl-act {
  color: #fb923c;
  animation: fl-pulse 1.6s ease-in-out infinite;
}
@keyframes fl-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
.fl-head-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.fl-pill {
  padding: 3px 9px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg2, #0f1116);
  font-size: 11px;
  white-space: nowrap;
}
.fl-pill.ok {
  color: #4ade80;
  border-color: rgba(74, 222, 128, 0.4);
}

/* ---------- 全屏引导（无家园 / 未建成） ---------- */
.fl-full-cta {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.fl-cta-card {
  width: min(430px, 100%);
  padding: 30px 26px 26px;
  border: 1px solid rgba(78, 163, 255, 0.3);
  border-radius: 18px;
  background: linear-gradient(165deg, rgba(20, 32, 52, 0.95), rgba(12, 18, 32, 0.96));
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.4);
  text-align: center;
}
.fl-cta-icon {
  font-size: 44px;
  margin-bottom: 12px;
}
.fl-cta-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 8px;
}
.fl-cta-desc {
  color: var(--muted);
  line-height: 1.7;
  margin-bottom: 18px;
}

/* ---------- 主体滚动区 ---------- */
.fl-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
}
/* 失败态：文案 + 重试按钮竖排居中，红字（原来连 .err 样式都没有，失败就是一屏空白） */
.fl-loading.err {
  flex-direction: column;
  gap: 12px;
  color: #f87171;
  text-align: center;
  padding: 24px;
  line-height: 1.7;
}
/* 已有数据但本轮刷新失败：顶部提示"看到的是上一次的结果" */
.fl-banner {
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid rgba(248, 113, 113, 0.4);
  background: rgba(248, 113, 113, 0.08);
  color: #fca5a5;
  font-size: 12px;
}
.fl-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ---------- 模块卡片 ---------- */
.fl-block {
  background: linear-gradient(160deg, var(--bg3, #171a21), rgba(23, 26, 33, 0.75));
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
  transition: box-shadow 0.2s ease, transform 0.18s ease;
}
.fl-block:hover {
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.38);
}
/* 按住卡片里的格子时，:active 会连带冒到祖先卡片上：把投影收回一格，读作"这块受力了" */
.fl-block:active {
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
}
.fl-block-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 14px;
  margin-bottom: 10px;
}
.fl-b-chip {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-size: 15px;
  flex-shrink: 0;
}
.fl-b-chip.shield { background: rgba(59, 130, 246, 0.18); }
.fl-b-chip.enemy  { background: rgba(248, 113, 113, 0.18); }
.fl-b-chip.fire   { background: rgba(251, 146, 60, 0.18); }
.fl-b-chip.build  { background: rgba(74, 222, 128, 0.16); }
.fl-b-chip.stock  { background: rgba(167, 139, 250, 0.18); }
.fl-chip-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted);
  background: var(--bg2, #0f1116);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1px 8px;
}

/* 状态头卡 */
.fl-status-row {
  display: flex;
  gap: 10px;
}
.fl-stat {
  flex: 1;
  text-align: center;
  background: var(--bg2, #0f1116);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 4px;
}
.fl-stat-val {
  font-size: 20px;
  font-weight: 800;
}
.fl-stat-val em {
  font-style: normal;
  font-size: 13px;
  color: var(--muted);
  font-weight: 600;
}
.fl-stat-val.act {
  color: #fb923c;
}
.fl-stat-label {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
}
.fl-hint {
  margin-top: 10px;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.6;
  padding: 8px 10px;
  background: rgba(78, 163, 255, 0.06);
  border-radius: 10px;
}

/* 敌人区 */
.fl-enemy-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fl-enemy {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg2, #0f1116);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 8px 10px;
}
.fl-enemy-icon {
  font-size: 24px;
  flex-shrink: 0;
}
.fl-enemy-main {
  flex: 1;
  min-width: 0;
}
.fl-enemy-name {
  font-weight: 600;
  font-size: 13px;
}
.fl-enemy-name em {
  font-style: normal;
  color: var(--muted);
  font-size: 11px;
  font-weight: 500;
  margin-left: 6px;
}
.fl-enemy-hp {
  height: 7px;
  border-radius: 4px;
  background: rgba(248, 113, 113, 0.15);
  overflow: hidden;
  margin-top: 4px;
}
.fl-enemy-hp-fill {
  height: 100%;
  background: linear-gradient(90deg, #f87171, #fb923c);
  border-radius: 4px;
  transition: width 0.5s ease;
}
.fl-enemy-num {
  font-size: 11px;
  color: var(--muted);
  margin-top: 3px;
}

/* 火力通道 */
.fl-weapon-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fl-weapon {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg2, #0f1116);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 7px 10px;
}
.fl-weapon-icon {
  font-size: 16px;
}
.fl-weapon-name {
  font-weight: 600;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fl-weapon-dmg {
  font-size: 12px;
  color: #fb923c;
  flex-shrink: 0;
}

/* 网格（防御建筑 / 库存） */
.fl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
}
.fl-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 6px;
  background: var(--bg2, #0f1116);
  border: 1px solid var(--border);
  border-radius: 12px;
  cursor: pointer;
  color: var(--text, #e5e7eb);
  font-size: 12px;
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}
.fl-cell:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.35);
  border-color: rgba(74, 222, 128, 0.45);
}
.fl-cell:active:not(:disabled) {
  transform: scale(0.96);
}
.fl-cell.disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.fl-cell-icon {
  font-size: 26px;
}
.fl-cell-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.fl-cell-num {
  color: var(--muted);
  font-size: 11px;
}

/* 空态 */
.fl-empty {
  padding: 18px 10px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
  background: var(--bg2, #0f1116);
  border: 1px dashed var(--border);
  border-radius: 12px;
}

/* 底部操作条 */
.fl-actions {
  position: sticky;
  bottom: 0;
  padding: 10px 0 2px;
  background: linear-gradient(transparent, var(--bg2, #0f1116) 30%);
  display: flex;
  gap: 10px;
}
.fl-btn {
  border: 1px solid var(--border);
  background: var(--bg3, #171a21);
  color: var(--text, #e5e7eb);
  border-radius: 10px;
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
  transition: filter 0.15s ease, transform 0.15s ease;
}
.fl-btn:hover:not(:disabled) {
  filter: brightness(1.15);
}
.fl-btn:active:not(:disabled) {
  transform: scale(0.97);
}
.fl-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.fl-btn.ghost {
  background: transparent;
}
.fl-btn.primary {
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  border-color: rgba(59, 130, 246, 0.6);
}
.fl-btn.danger {
  background: linear-gradient(135deg, #ef4444, #dc2626);
  border-color: rgba(239, 68, 68, 0.6);
}
.fl-btn.big {
  flex: 1;
  padding: 13px 16px;
  font-size: 15px;
  font-weight: 700;
  border-radius: 12px;
}
.fl-btn.block {
  width: 100%;
}

/* 拆卸确认弹窗 */
.fl-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
  animation: fl-fade 0.2s ease;
}
.fl-modal {
  width: min(360px, 90vw);
  padding: 20px;
  background: var(--bg3, #171a21);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
  animation: fl-pop 0.22s ease;
}
.fl-modal-title {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 8px;
}
.fl-modal-desc {
  color: var(--muted);
  line-height: 1.6;
  margin-bottom: 16px;
}
.fl-modal-btns {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
@keyframes fl-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes fl-pop {
  from { opacity: 0; transform: scale(0.92); }
  to { opacity: 1; transform: scale(1); }
}

/* 窄屏适配 */
@media (max-width: 560px) {
  .fl-top {
    flex-wrap: wrap;
  }
  .fl-body {
    padding: 10px;
  }
  .fl-grid {
    grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  }
}

/* ============================================================
 * 手机端（游戏外壳）适配
 *
 * 一律追加在样式表末尾，靠源码顺序盖住上面的桌面规则，桌面端逐像素不变。
 * 上下两条常驻边的空间都是外壳给的：顶部 HUD 自带刘海内缩（.fl-top 这里再叠一次
 * --safe-top 就会出现两段空白），底部标签栏由 .game-stage 用 padding 预留
 * （本页根节点也不加 padding-bottom，否则滚动区凭空矮一截）。
 * ============================================================ */
@media (max-width: 768px) {
  /* 跨页导航已经归底栏，再留一个"返回聊天"会和「公屏」重复并挤掉标题宽度；
     只在挂了外壳时隐藏，窄窗口的桌面浏览器仍然要点它 */
  html.has-shell .fl-back {
    display: none;
  }

  .fl-top {
    padding: 8px 12px;
    gap: 8px;
    flex-wrap: wrap;
  }
  .fl-house {
    font-size: 15px;
  }

  /* 家园 ↔ 前线：本页唯一的导航，换成手游常见的整行分段控件。
     独占一行放在标题下方，拇指的落点才不会压到右侧的"在前线"徽标和刷新键 */
  .fl-switch {
    order: 3;
    flex: 1 0 100%;
    gap: 4px;
    padding: 4px;
    border-radius: 13px;
  }
  .fl-switch-btn {
    flex: 1;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
    border-radius: 10px;
    font-size: 15px;
    font-weight: 700;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.04);
    transition: transform 0.12s ease, filter 0.15s ease, background 0.2s ease;
  }
  /* 触屏没有 hover 可依赖：当前页整块填主题渐变，另一半留暗底，一眼能看出在哪 */
  .fl-switch-btn.on {
    background: var(--accent-gradient, linear-gradient(90deg, #8b5cf6, #06b6d4));
    color: #fff;
    box-shadow: 0 4px 14px rgba(139, 92, 246, 0.38);
  }

  .fl-body {
    padding: 12px 10px 14px;
  }
  .fl-block {
    padding: 12px 10px;
  }
  .fl-block-head {
    font-size: 15px;
    margin-bottom: 12px;
  }
  .fl-b-chip {
    width: 34px;
    height: 34px;
    font-size: 17px;
    border-radius: 10px;
  }

  /* 状态三格：min-width 是唯一保险——净宽不够时整行折成 2+1，
     而不是把 20px 的数字压到换行、三格高度参差 */
  .fl-status-row {
    flex-wrap: wrap;
    gap: 8px;
  }
  .fl-stat {
    flex: 1 1 40%;
    min-width: 96px;
    padding: 12px 4px;
  }
  .fl-stat-val {
    font-size: 22px;
  }

  /* 建筑格：390px 下净宽约 346px → 3 列、每格约 108px，装得下四字词又足够宽热点中 */
  .fl-grid {
    grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
    gap: 10px;
  }
  .fl-cell {
    min-height: 88px;
    padding: 12px 6px;
  }

  .fl-btn {
    min-height: 44px;
    padding: 10px 16px;
    font-size: 14px;
  }

  /* 主行动按钮：滚动容器是 .fl-body（根节点 overflow:hidden），
     所以 sticky 的下沿天然停在底栏上沿，这里只需要把按钮撑成通栏大CTA */
  .fl-actions {
    padding: 12px 0 10px;
  }
  .fl-actions .fl-btn.big {
    flex: 1 1 100%;
    min-height: 50px;
    font-size: 16px;
    font-weight: 800;
    letter-spacing: 1px;
    border-radius: 14px;
  }
  .fl-actions .fl-btn.primary {
    box-shadow: 0 8px 22px rgba(59, 130, 246, 0.4);
  }
  .fl-actions .fl-btn.danger {
    box-shadow: 0 8px 22px rgba(239, 68, 68, 0.42);
  }
  /* 通栏大按钮若不"沉"下去，玩家分不清是按钮还是一块色条 */
  .fl-actions .fl-btn.big:active:not(:disabled) {
    transform: scale(0.98) translateY(2px);
    filter: brightness(0.93);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
  }

  /* 拆卸确认：居中弹窗的按钮在手机上够不着，改成贴着底栏上沿升起的抽屉；
     z-index 必须高过底栏的 480，否则抽屉会被自己的导航条盖住一半 */
  .fl-mask {
    align-items: flex-end;
    z-index: 500;
    padding: 16px 0 calc(var(--mtb-h, 58px) + var(--safe-bottom, 0px));
  }
  .fl-modal {
    width: 100%;
    max-width: none;
    border-radius: 18px 18px 0 0;
    padding: 18px 16px 22px;
    /* 高度上限按外壳实测的可视高度扣掉 HUD 与底栏，键盘/横屏下也不会顶穿屏幕 */
    max-height: calc(var(--vvh, 100dvh) - var(--hud-h, 52px) - var(--mtb-h, 58px) - var(--safe-bottom, 0px) - 24px);
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    animation: fl-sheet 0.26s cubic-bezier(0.22, 1, 0.36, 1);
  }
  /* 抽屉顶那道小横杠：暗示这块可以往下拖掉 */
  .fl-modal::before {
    content: '';
    display: block;
    width: 38px;
    height: 4px;
    margin: -6px auto 12px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.24);
  }
  .fl-modal-title {
    text-align: center;
    font-size: 16px;
  }
  .fl-modal-desc {
    margin-bottom: 18px;
    line-height: 1.7;
  }
  /* 抽屉里的两个键拉平成左右各半：单手拇指够不到右下角那对右对齐的小按钮 */
  .fl-modal-btns .fl-btn {
    flex: 1;
    min-height: 46px;
    font-size: 15px;
    font-weight: 700;
  }
  @keyframes fl-sheet {
    from { transform: translateY(100%); }
    to { transform: none; }
  }
}

/* 手机竖屏（≤480，与 stores/device.js 的 isPhone 同断点）：仓库改成 4 列图标墙 */
@media (max-width: 480px) {
  /* 346px 净宽放 4 列时单格仍有 ~80px，缩略图+名称+数量的点卡够拇指按，
     密度更接近常见手游的背包，也让一屏能看全库存不用滚 */
  .fl-grid {
    grid-template-columns: repeat(auto-fill, minmax(78px, 1fr));
    gap: 8px;
  }
  .fl-cell {
    min-height: 84px;
    padding: 10px 4px;
  }
  .fl-cell-icon {
    font-size: 28px;
  }
  .fl-top {
    padding: 8px 10px;
  }
  .fl-switch-btn {
    font-size: 14px;
  }
  /* 320px 老机型净宽只有 ~280px，沿用 96px 下限会折成 2+1 让第三格孤零零占半行，
     收到 88px 就仍然是一排三格 */
  .fl-stat {
    min-width: 88px;
    padding: 10px 2px;
  }
  .fl-stat-val {
    font-size: 20px;
  }
  .fl-enemy,
  .fl-weapon {
    padding: 10px;
  }
  .fl-enemy-icon {
    font-size: 28px;
  }
  .fl-cta-card {
    padding: 24px 18px 20px;
  }
  .fl-cta-icon {
    font-size: 38px;
  }
  .fl-cta-title {
    font-size: 17px;
  }
}
</style>
