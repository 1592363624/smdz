<template>
  <div class="fl-page">
    <!-- 顶栏：前线名 / 关键指标 / 状态与刷新 -->
    <header class="fl-top">
      <button class="fl-back" title="返回聊天" @click="router.push('/chat')">←</button>
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

    <!-- 主体：QQ 农场式模块卡片 -->
    <main v-else-if="data" class="fl-body">
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
/**
 * 家园前线面板（只读视图 + 统一指令通道写操作）。
 *
 * 数据源：homeApi.frontline（只读 DTO，不结算不写库）；
 * 写操作（前往前线 / 安装 / 拆卸 / 开始战斗）一律通过 commandApi.execute
 * 发送与 QQ 端逐字相同的文本指令（config.HOME_FRONTLINE_CONFIG.commands），
 * 没有第二条写路径，结算口径不会双轨。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { commandApi, homeApi } from '../api';
import { HOME_FRONTLINE_CONFIG as C } from '../config';
import { useUiStore } from '../stores/ui';

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

async function refresh() {
  loading.value = true;
  try {
    const res = await homeApi.frontline();
    data.value = res?.data ?? null;
    error.value = '';
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
  .fl-body {
    padding: 10px;
  }
  .fl-grid {
    grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  }
}
</style>
