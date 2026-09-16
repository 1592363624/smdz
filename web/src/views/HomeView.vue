<template>
  <!-- 建造期（已拉到数据且进度 < 4）：整页接管为全屏建造引导。
       不显示游戏顶栏 / 农田 / 仓库等任何家园功能——房子没建成，
       其它家园系统操作一律不开放（后端 home-gate.util 同口径拦截）。
       圈地 / 开挖 / 建基 / 建房按钮就地发送与 QQ 端相同的指令，
       施工场景随进度逐级"长出"房子。 -->
  <div v-if="buildingPhase" class="yd-page yd-page-building">
    <HomeBuildGuide
      class="yd-guide-full"
      :step="progress"
      fullscreen
      :busy="running"
      :at-home="progress === 0 || atHome"
      :house-name="rawHouseName"
      :travel-left="travelLeft"
      @send="runGuideCommand"
      @open-chat="router.push('/chat')"
    />
  </div>

  <!-- 建成后 / 加载中 / 错误：正常家园页（顶栏 + 农田等） -->
  <div v-else class="yd-page">
    <!-- 顶栏：家园名 / 关键指标 / 状态与刷新 -->
    <header class="yd-top">
      <button class="yd-back" title="返回聊天" @click="router.push('/chat')">←</button>
      <div class="yd-head-main">
        <div class="yd-house">🏡 {{ houseName }}</div>
        <div class="yd-meta">
          <span>Lv.{{ level }}</span>
          <span>凭证 {{ vouchers }}</span>
          <span>作物 {{ crop.used }}/{{ crop.limit }}</span>
          <span>建筑 {{ building.used }}/{{ building.limit }}</span>
          <!-- 正在生长的作物格数量（QQ 农场式"种植中"徽标） -->
          <span v-if="growingCount" class="yd-grow">🌱 种植中 {{ growingCount }}</span>
        </div>
      </div>
      <div class="yd-head-ops">
        <span class="yd-pill" :class="powerClass">{{ powerText }}</span>
        <span v-if="overloaded" class="yd-pill over">🔥 超载</span>
        <button class="yd-btn ghost" :disabled="loading" @click="refresh">刷新</button>
      </div>
    </header>

    <div v-if="loading && !data" class="yd-hint">家园数据加载中...</div>
    <div v-else-if="error && !data" class="yd-hint err">{{ error }}</div>
    <!-- 异常空态（档案不存在 / 地图丢失等）：正常页内居中提示，不再与全屏引导叠加 -->
    <div v-else-if="blocked" class="yd-full-cta">
      <div class="yd-cta-card">
        <div class="yd-cta-icon">🏡</div>
        <h2 class="yd-cta-title">{{ blocked }}</h2>
        <p class="yd-cta-sub">选一块你中意的土地圈下来，就能开始建造你的专属家园</p>
        <button class="yd-btn primary big" :disabled="running" @click="startClaim">🚀 开始圈地</button>
        <p class="yd-cta-hint">圈地指令会在地图上生成你的院子，之后按引导逐步建造房子</p>
      </div>
    </div>

    <template v-else-if="data && progress >= 4">
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
              <span class="yd-b-chip crop">🌾</span>
              <span class="yd-b-title">农田</span>
              <span class="yd-b-count">{{ crop.used }}/{{ crop.limit }}</span>
              <span class="yd-dim">{{ batchKind === 'crop' ? C.texts.batchEmpty : '空地点击选种子种下；地块随等级与凭证开垦' }}</span>
              <div class="yd-b-ops">
                <button class="yd-btn tiny" :class="{ on: batchKind === 'crop' }" :title="C.texts.batchHint" @click="toggleBatch('crop')">
                  {{ batchKind === 'crop' ? C.texts.batchOff : C.texts.batchOn }}
                </button>
                <button class="yd-btn tiny warn" :disabled="running || !cropNames.length" @click="harvestAllCrops">
                  🌾 一键收获{{ cropNames.length ? `（${cropNames.length} 种）` : '' }}
                </button>
                <button class="yd-btn tiny" :disabled="running" @click="useVoucher">凭证开垦 +5</button>
              </div>
            </div>
            <div class="yd-grid" :class="{ brushing: batchKind === 'crop' }" :style="gridStyle">
              <button
                v-for="p in visibleCropPlots"
                :key="'c-' + p.index"
                class="yd-plot"
                :class="[p.state, { sel: selected === p, picked: selection.has('crop:' + p.index), ripe: p.stage?.ripe }]"
                :data-sel-key="'crop:' + p.index"
                @pointerdown="onPlotDown($event, 'crop', p)"
                @click="onPlot(p, 'crop')"
              >
                <span class="yd-p-icon">{{ iconOf(p) }}</span>
                <span class="yd-p-name">{{ p.name || (p.state === 'locked' ? '待开垦' : '+') }}</span>
                <!-- 作物格：分阶段成熟玩法，显示生长阶段条 + 剩余时间 / 可收获 -->
                <template v-if="p.kind === 'crop' && p.stage">
                  <span class="yd-p-stages">
                    <i v-for="(sName, si) in p.stage.names" :key="'s' + si" :class="{ on: si <= p.stage.index, ripe: p.stage.ripe }"></i>
                  </span>
                  <span class="yd-p-out" :class="p.stage.ripe ? 'gain' : ''">
                    {{ p.stage.ripe ? '✓ 可收获' : `${p.stage.names[p.stage.index]} · ${fmtRemain(p.stage.remainSeconds)}` }}
                  </span>
                </template>
                <template v-else-if="p.state === 'occupied'">
                  <span class="yd-p-out">
                    <span v-if="p.outputs.length" :class="p.outputs[0].quantity >= 0 ? 'gain' : 'cost'">
                      {{ p.outputs[0].quantity >= 0 ? '+' : '' }}{{ fmtQty(p.outputs[0].quantity) }} {{ p.outputs[0].name }}/分
                    </span>
                    <span v-else class="yd-dim">无产出</span>
                  </span>
                </template>
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
              <span class="yd-b-chip build">🏭</span>
              <span class="yd-b-title">建筑区</span>
              <span class="yd-b-count">{{ building.used }}/{{ building.limit }}</span>
              <span class="yd-dim">{{ batchKind === 'building' ? C.texts.batchEmpty : '空地点击选建筑安装；已安装的点击可拆除' }}</span>
              <div class="yd-b-ops">
                <button class="yd-btn tiny" :class="{ on: batchKind === 'building' }" :title="C.texts.batchHint" @click="toggleBatch('building')">
                  {{ batchKind === 'building' ? C.texts.batchOff : C.texts.batchOn }}
                </button>
              </div>
            </div>
            <div class="yd-grid" :class="{ brushing: batchKind === 'building' }" :style="gridStyle">
              <button
                v-for="p in visibleBuildingPlots"
                :key="'b-' + p.index"
                class="yd-plot"
                :class="[p.state, { sel: selected === p, picked: selection.has('building:' + p.index) }]"
                :data-sel-key="'building:' + p.index"
                @pointerdown="onPlotDown($event, 'building', p)"
                @click="onPlot(p, 'building')"
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
              <span class="yd-b-chip obstacle">🪨</span>
              <span class="yd-b-title">地面障碍</span>
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
              <span class="yd-b-chip stock">📦</span>
              <span class="yd-c-title">产出存放地</span>
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
              <span class="yd-b-chip bag">🎒</span>
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
            <div class="yd-card-head">
              <span class="yd-b-chip rate">📈</span>
              <span class="yd-c-title">每日产出速率</span>
            </div>
            <div class="yd-chips">
              <span v-for="(d, i) in dailyList" :key="'d-' + d.name + '-' + i" class="yd-chip rate">
                {{ d.name }} {{ fmtQty(d.quantity) }}/天
              </span>
            </div>
          </div>
        </aside>
      </div>

      <!-- 批量操作条：拖拽刷选后一次性种下 / 收获 / 拆除 -->
      <div v-if="selectionCount" class="yd-batch-bar">
        <span class="yd-bb-info">已选 <b>{{ selectionCount }}</b> 块 · {{ selectionLabel }}</span>
        <div class="yd-bb-ops">
          <button
            v-if="selectionState === 'empty' && batchKind === 'crop'"
            class="yd-btn warn"
            :disabled="running"
            @click="openPicker('crop', selectionCount)"
          >
            {{ C.texts.seedCount(selectionCount) }}
          </button>
          <button
            v-else-if="selectionState === 'empty'"
            class="yd-btn primary"
            :disabled="running"
            @click="openPicker('building', selectionCount)"
          >
            {{ C.texts.installCount(selectionCount) }}
          </button>
          <button v-else-if="batchKind === 'crop'" class="yd-btn warn" :disabled="running" @click="harvestSelected">
            {{ C.texts.harvestCount(selectionCount) }}
          </button>
          <button v-else class="yd-btn danger" :disabled="running" @click="removeSelected">
            {{ C.texts.removeCount(selectionCount) }}
          </button>
          <button class="yd-btn ghost" @click="clearSelection">取消选择</button>
          <button class="yd-btn ghost" @click="toggleBatch(batchKind)">{{ C.texts.batchOff }}</button>
        </div>
      </div>

      <!-- 选中地块详情条 -->
      <div v-else-if="selected && selected.state === 'occupied'" class="yd-detail">
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
            {{ selected.kind === 'crop' ? '成熟收获' : '拆除返还' }} {{ h.name }}×{{ fmtQty(h.quantity) }}
          </span>
        </div>
        <!-- 作物生长阶段详情：阶段点 + 剩余时间，未成熟禁用收获 -->
        <div v-if="selected.kind === 'crop' && selected.stage" class="yd-d-stage">
          <span
            v-for="(sName, si) in selected.stage.names"
            :key="'ds-' + si"
            :class="{ on: si <= selected.stage.index, ripe: selected.stage.ripe }"
          >
            {{ sName }}
          </span>
          <div class="yd-d-stage-tip" :class="selected.stage.ripe ? 'gain' : ''">
            {{ selected.stage.ripe ? '✓ 已成熟，点击下方收获' : `🌱 生长中，还需 ${fmtRemain(selected.stage.remainSeconds)} 成熟` }}
          </div>
        </div>
        <div class="yd-d-ops">
          <template v-if="selected.kind === 'crop'">
            <button
              class="yd-btn warn"
              :disabled="running || (selected.stage && !selected.stage.ripe)"
              @click="run(C.commands.harvest(selected.name))"
            >
              🌾 收获全部（{{ selected.name }} ×{{ selected.total }}）
            </button>
            <span class="yd-dim">
              {{ selected.stage && !selected.stage.ripe ? '未成熟的作物还不能收获，等它长完再收' : '收获会一次收走该作物全部已成熟的棵' }}
            </span>
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
            <span>
              {{ picker.kind === 'crop' ? C.texts.pickSeedTitle : C.texts.pickBuildingTitle }}
              <b v-if="picker.count > 1">×{{ picker.count }}</b>
            </span>
            <button class="yd-x" @click="picker.open = false">✕</button>
          </div>
          <div class="yd-m-list">
            <button
              v-for="s in picker.items"
              :key="'p-' + s.name"
              class="yd-stock"
              :disabled="running"
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
 *
 * 批量与拖拽（QQ 农场式）：
 * - 「批量」按钮开启刷选模式后，在地块上按住拖动即可刷选多块（只收同状态地块），
 *   松手后在底部批量条一次性种下 / 收获 / 拆除；Shift+点击 可反选微调。
 * - 批量指令沿用原版「名称+数量」写法（parseCountedAction），超出单条上限自动拆多条；
 *   种子名若以数字结尾导致批量解析失败，会自动退化为逐颗种植。
 * - 「一键收获」= 对田里每种作物各发一条「收获 名称」（该指令本就收走同名全部）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { commandApi, homeApi } from '../api';
import { HOME_YARD_CONFIG as C, HOME_BUILD_GUIDE_CONFIG as G } from '../config';
// 家园建造四步引导卡片（顶部进度条，就地发指令）
import HomeBuildGuide from '../components/HomeBuildGuide.vue';
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
/** 空地上弹出的种子/建筑选择器（count>1 表示批量） */
const picker = ref({ open: false, kind: 'crop', items: [], count: 1 });
/** 右侧仓库当前 Tab */
const stockTab = ref('seed');
/** 正在刷选的区域：'' | 'crop' | 'building'（同时只对一块区域生效） */
const batchKind = ref('');
/** 刷选中的地块 key 集合，形如 'crop:3' */
const selection = ref(new Set());
let timer = null;
/** 刚建成：全屏引导多停留一会儿播完落成庆祝，再切完整家园页 */
const holdDone = ref(false);
let holdDoneTimer = null;
/** 前往某地的剩余秒数（>0 时引导按钮显示倒计时，到点自动 refresh） */
const travelLeft = ref(0);
let travelTick = null;
let travelDoneTimer = null;

// ---------- 派生数据 ----------
/** 接口里的真实房名（可为空）；展示名 houseName 才做「家园」兜底 */
const rawHouseName = computed(() => String(data.value?.houseName || '').trim());
const houseName = computed(() => rawHouseName.value || '家园');
const level = computed(() => Number(data.value?.level ?? 1) || 1);
const vouchers = computed(() => Number(data.value?.vouchers ?? 0) || 0);
const progress = computed(() => Number(data.value?.progress ?? 0) || 0);
/** 是否处于「房子未建成 → 全屏引导接管」阶段（含刚建成的庆祝停留） */
const buildingPhase = computed(() => {
  if (!data.value) return false;
  if (progress.value < 4) return true;
  return holdDone.value;
});
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
/** 田里已成熟的作物名（去重），用于「一键收获」；未成熟的不参与，避免白跑一遍 */
const cropNames = computed(() => {
  const names = new Set();
  for (const p of crop.value.plots) {
    if (p.state === 'occupied' && p.name && p.stage?.ripe) names.add(p.name);
  }
  return Array.from(names);
});
/** 田里正在生长的作物格数量（顶栏统计用） */
const growingCount = computed(() => {
  let count = 0;
  for (const p of crop.value.plots) {
    if (p.state === 'occupied' && p.stage && !p.stage.ripe) count += 1;
  }
  return count;
});

// ---------- 刷选派生 ----------
/** 选中的 key → 还原成 { kind, plot } */
const selectionList = computed(() => {
  const list = [];
  for (const key of selection.value) {
    const [kind, raw] = String(key).split(':');
    const source = kind === 'crop' ? crop.value.plots : building.value.plots;
    const plot = source[Number(raw)];
    if (plot) list.push({ kind, plot });
  }
  return list;
});
const selectionCount = computed(() => selectionList.value.length);
/** 选中块的状态（刷选时已保证同类）：empty / occupied */
const selectionState = computed(() => selectionList.value[0]?.plot?.state ?? '');
const selectionLabel = computed(() => {
  if (!selectionCount.value) return '';
  if (selectionState.value === 'empty') return batchKind.value === 'crop' ? '空地（准备种植）' : '空地（准备安装）';
  return batchKind.value === 'crop' ? '已种植作物' : '已安装建筑';
});
/** 按名称聚合的选中项（建筑批量拆除用） */
const selectionGroups = computed(() => {
  const groups = new Map();
  for (const { plot } of selectionList.value) {
    if (!plot?.name) continue;
    groups.set(plot.name, (groups.get(plot.name) || 0) + 1);
  }
  return Array.from(groups.entries());
});

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
  if (holdDoneTimer) clearTimeout(holdDoneTimer);
  clearTravelCountdown();
  endBrush();
});

/** 从指令回包里解析「预计 N 秒后到达」；解析不到返回 0 */
function parseTravelSeconds(text) {
  const m = String(text || '').match(/预计\s*(\d+)\s*秒后到达/);
  return m ? Math.max(0, Number(m[1]) || 0) : 0;
}

function clearTravelCountdown() {
  if (travelTick) {
    clearInterval(travelTick);
    travelTick = null;
  }
  if (travelDoneTimer) {
    clearTimeout(travelDoneTimer);
    travelDoneTimer = null;
  }
  travelLeft.value = 0;
}

/**
 * 启动「前往」倒计时：按钮上每秒 -1，到 0 后立刻 refresh，
 * 不用再手动刷新才能看到「已到家 / 进度变化」。
 */
function startTravelCountdown(seconds) {
  const total = Math.max(1, Math.floor(Number(seconds) || 0));
  clearTravelCountdown();
  travelLeft.value = total;
  travelTick = setInterval(() => {
    travelLeft.value = Math.max(0, travelLeft.value - 1);
    if (travelLeft.value <= 0) {
      if (travelTick) {
        clearInterval(travelTick);
        travelTick = null;
      }
      // 到达后多等一小拍，确保后端 arrival 已落库
      travelDoneTimer = setTimeout(() => {
        travelDoneTimer = null;
        refresh();
      }, 400);
    }
  }, 1000);
}

/** 进度推进到 4：引导页多留 1.6s 播完撒花/落成动画，再切完整家园 */
watch(progress, (now, before) => {
  if (before === undefined || now === before) return;
  if (now >= 4 && before < 4) {
    holdDone.value = true;
    clearTimeout(holdDoneTimer);
    holdDoneTimer = setTimeout(() => { holdDone.value = false; }, 1600);
  } else if (now < 4) {
    holdDone.value = false;
  }
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

/** 剩余成熟时长：秒 → 中文（天/时/分），用于阶段倒计时展示 */
function fmtRemain(sec) {
  const s = Math.max(0, Math.ceil(Number(sec) || 0));
  if (s <= 0) return '0分';
  if (s >= 86400) {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    return h > 0 ? `${d}天${h}时` : `${d}天`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}时${m}分` : `${Math.max(1, m)}分`;
}

// ---------- 刷选交互（批量模式） ----------
/** 开/关某块区域的批量刷选；切换时清空选择，避免跨区域混选 */
function toggleBatch(kind) {
  if (batchKind.value === kind) {
    batchKind.value = '';
    clearSelection();
    return;
  }
  batchKind.value = kind;
  clearSelection();
}
function clearSelection() {
  selection.value = new Set();
}
/** Set 是引用类型，整体替换才能可靠触发响应 */
function addSelectionKey(key) {
  if (selection.value.has(key)) return;
  const next = new Set(selection.value);
  next.add(key);
  selection.value = next;
}
function toggleSelectionKey(key) {
  const next = new Set(selection.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  selection.value = next;
}

let brushing = false;
/** 本次刷选的基准状态：只刷同状态地块，避免空地与作物混选 */
let brushState = '';

/**
 * 批量模式下按下地块开始刷选（非批量模式完全不介入，交给 click 处理）。
 * 触屏同样生效：网格在刷选态会禁用 touch-action，避免被页面滚动抢走手势。
 */
function onPlotDown(event, kind, plot) {
  if (batchKind.value !== kind || !plot) return;
  event.preventDefault();
  brushing = true;
  brushState = plot.state;
  if (plot.state === 'locked') {
    ui.pushToast({ type: 'info', message: plot.unlockHint || '该地块尚未开垦' });
    return;
  }
  const key = `${kind}:${plot.index}`;
  // Shift 点击 = 反选，方便微调
  if (event.shiftKey) toggleSelectionKey(key);
  else addSelectionKey(key);
  window.addEventListener('pointermove', onBrushMove);
  window.addEventListener('pointerup', endBrush);
  window.addEventListener('pointercancel', endBrush);
}

/** 拖动刷过其它地块：只加不选，且只收同状态的地块 */
function onBrushMove(event) {
  if (!brushing) return;
  const el = document.elementFromPoint(event.clientX, event.clientY);
  const host = el?.closest?.('.yd-plot');
  const key = host?.getAttribute?.('data-sel-key');
  if (!key) return;
  const [kind, raw] = key.split(':');
  if (kind !== batchKind.value) return;
  const source = kind === 'crop' ? crop.value.plots : building.value.plots;
  const plot = source[Number(raw)];
  if (!plot || plot.state !== brushState || plot.state === 'locked') return;
  addSelectionKey(key);
}

function endBrush() {
  brushing = false;
  window.removeEventListener('pointermove', onBrushMove);
  window.removeEventListener('pointerup', endBrush);
  window.removeEventListener('pointercancel', endBrush);
}

// ---------- 操作 ----------
/**
 * 生成「名称+数量」的批量指令列表（超出单条上限自动拆分）。
 * 原版 parseCountedAction 支持「种植 椰树种子5」这类写法。
 */
function countedCommands(template, name, count) {
  const total = Math.max(1, Math.floor(Number(count) || 1));
  const cmds = [];
  let left = total;
  while (left > 0) {
    const n = Math.min(left, C.batch.maxPerCommand);
    cmds.push(template(C.commands.withCount(name, n)));
    left -= n;
  }
  return cmds;
}

/** 汇总批量执行结果（多条时只展示前几条，避免 toast 刷屏） */
function toastResults(texts) {
  const list = (texts || []).filter(Boolean);
  const shown = list.slice(0, C.batch.toastResultLimit).join(' / ');
  const tail = list.length > C.batch.toastResultLimit ? ` …共 ${list.length} 条` : '';
  ui.pushToast({ type: 'success', message: `${shown || '操作完成'}${tail}`, timeout: 5000 });
}

/** 批量收尾：解锁、清选择、退出批量模式、延迟重拉数据 */
function endBatch() {
  running.value = false;
  selected.value = null;
  picker.value = { open: false, kind: picker.value.kind, items: [], count: 1 };
  clearSelection();
  batchKind.value = '';
  setTimeout(refresh, C.refetchDelayMs);
}

/**
 * 顺序执行多条指令（批量操作统一出口）。
 * @param {string[]} cmds 与 QQ 端一致的指令文本列表
 * @param {{requireHome?: boolean}} opts
 */
/**
 * 家园写操作门禁：房子建成（进度 >= 4）前不允许种植 / 收获 / 安装 / 拆除 / 凭证开垦。
 * 与后端 home-gate.util 同一口径（后端也会拦截，这里只是提前给提示、少一次无效请求）。
 * @returns {boolean} true = 已被拦截
 */
function homeBuiltGuard() {
  if (progress.value >= G.total) return false;
  ui.pushToast({ type: 'warning', message: G.texts.needBuilt });
  return true;
}

async function runMany(cmds, opts = {}) {
  const requireHome = opts.requireHome !== false;
  if (running.value || !cmds?.length) return;
  if (homeBuiltGuard()) return;
  if (requireHome && !atHome.value) {
    ui.pushToast({ type: 'warning', message: C.texts.notAtHome });
    return;
  }
  running.value = true;
  const texts = [];
  try {
    for (const cmd of cmds) {
      try {
        const res = await commandApi.execute(cmd);
        const text = res?.data?.content ?? '';
        if (text) texts.push(text);
      } catch (e) {
        texts.push(e?.response?.data?.message || `执行失败：${cmd}`);
      }
    }
    toastResults(texts);
  } finally {
    endBatch();
  }
}

/**
 * 批量种植：优先发「种植 种子N」；若种子名本身以数字结尾导致批量解析失败
 * （回包不含「成功」），自动退化为逐颗种植，保证结果一致。
 */
async function plantMany(seedName, count) {
  if (running.value) return;
  if (homeBuiltGuard()) return;
  if (!atHome.value) {
    ui.pushToast({ type: 'warning', message: C.texts.notAtHome });
    return;
  }
  const total = Math.max(1, Math.floor(Number(count) || 1));
  running.value = true;
  const texts = [];
  try {
    for (const cmd of countedCommands(C.commands.plant, seedName, total)) {
      let ok = false;
      try {
        const res = await commandApi.execute(cmd);
        const text = res?.data?.content ?? '';
        if (text) texts.push(text);
        ok = text.includes('成功');
      } catch (e) {
        texts.push(e?.response?.data?.message || `执行失败：${cmd}`);
      }
      if (!ok) {
        // 退化路径：逐颗种，遇到「没有/不足」即停（种子已用完）
        for (let i = 0; i < total; i += 1) {
          try {
            const res = await commandApi.execute(C.commands.plant(seedName));
            const text = res?.data?.content ?? '';
            if (text) texts.push(text);
            if (text.includes('没有') || text.includes('不足')) break;
          } catch (e) {
            texts.push(e?.response?.data?.message || `执行失败：${C.commands.plant(seedName)}`);
            break;
          }
        }
        break;
      }
    }
    toastResults(texts);
  } finally {
    endBatch();
  }
}

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
  let text = '';
  try {
    const res = await commandApi.execute(cmd);
    text = res?.data?.content ?? '';
    ui.pushToast({ type: 'success', message: text || `已执行：${cmd}`, timeout: 5000 });
  } catch (e) {
    text = e?.response?.data?.message || `执行失败：${cmd}`;
    ui.pushToast({ type: 'error', message: text });
  } finally {
    running.value = false;
    selected.value = null;
    picker.value.open = false;
    // 「前往」带移动耗时：回包会写「预计 N 秒后到达」——
    // 先短延时拉一次（标记/菜单），再启动倒计时到点自动 refresh，推动 UI（如 atHome）变化。
    const travelSec = parseTravelSeconds(text);
    if (travelSec > 0) {
      setTimeout(refresh, C.refetchDelayMs);
      startTravelCountdown(travelSec);
    } else {
      setTimeout(refresh, C.refetchDelayMs);
    }
  }
}

/**
 * 四步引导条上的按钮：执行一步建造指令（仍走统一指令通道）。
 * 进度 0 的「圈地」不需要人在院子（此时还没有家园）。
 * 「前往 房名」是移动指令，本身也无需「必须在院子」门禁——
 * 否则人还没站在院子里时，引导里的「先回家」会被门禁误拦。
 * 其余步骤沿用「必须在院子」门禁。
 */
function runGuideCommand(cmd) {
  const isTravel = typeof cmd === 'string' && cmd.startsWith('前往 ');
  return run(cmd, { requireHome: !isTravel && progress.value > 0 });
}

/** 尚未圈地时的入口按钮：发送「圈地」（不需要人在院子） */
function startClaim() {
  return run(G.firstCommand, { requireHome: false });
}

function onPlot(plot, kind) {
  if (!plot) return;
  // 批量模式下点击 = 勾选/取消（拖拽刷选由 pointerdown / pointermove 处理）
  if (batchKind.value === kind) {
    if (plot.state === 'locked') {
      ui.pushToast({ type: 'info', message: plot.unlockHint || '该地块尚未开垦' });
      return;
    }
    toggleSelectionKey(`${kind}:${plot.index}`);
    return;
  }
  if (plot.state === 'locked') {
    ui.pushToast({ type: 'info', message: plot.unlockHint || '该地块尚未开垦' });
    return;
  }
  selected.value = plot;
  if (plot.state === 'empty') openPicker(kind, 1);
}

/** 打开种子/建筑选择器；count>1 时表示批量操作 */
function openPicker(kind, count = 1) {
  const items = kind === 'crop' ? seeds.value : buildings.value;
  if (!items.length) {
    ui.pushToast({ type: 'info', message: kind === 'crop' ? C.texts.noSeed : C.texts.noBuilding });
    return;
  }
  picker.value = { open: true, kind, items, count: Math.max(1, count) };
}

function pickStock(stock) {
  const count = Math.max(1, picker.value.count || 1);
  picker.value = { ...picker.value, open: false };
  if (stock.kind === 'seed') {
    // 超出已开垦地块的作物不参与产出，先按剩余空地截断
    const free = Math.max(0, crop.value.limit - crop.value.used);
    const wanted = Math.min(count, Math.floor(stock.quantity));
    const planted = Math.min(wanted, free);
    if (planted <= 0) {
      ui.pushToast({ type: 'warning', message: C.texts.overLimit(free) });
      endBatch();
      return;
    }
    if (planted < count) ui.pushToast({ type: 'warning', message: C.texts.overLimit(free) });
    plantMany(stock.name, planted);
    return;
  }
  const installed = Math.min(count, Math.floor(stock.quantity));
  runMany(countedCommands(C.commands.install, stock.name, installed));
}

/** 仓库里直接点「种下 / 安装」：等价于发送一次指令 */
function quickUse(stock) {
  if (stock.kind === 'seed') {
    plantMany(stock.name, 1);
    return;
  }
  run(C.commands.install(stock.name));
}

// ---------- 批量操作 ----------
/** 一键收获全部作物：对每种已成熟的作物各发一条「收获 名称」 */
function harvestAllCrops() {
  if (!cropNames.value.length) {
    ui.pushToast({
      type: 'info',
      message: growingCount.value ? `地里还有 ${growingCount.value} 棵在生长，成熟后才能收获` : C.texts.nothingToHarvest,
    });
    return;
  }
  runMany(cropNames.value.map((name) => C.commands.harvest(name)));
}

/** 收获选中地块（按作物名去重；后端会拦截未成熟的，前端只收集已成熟的避免无效请求） */
function harvestSelected() {
  const names = Array.from(
    new Set(selectionList.value.filter((x) => x.plot.stage?.ripe).map((x) => x.plot.name).filter(Boolean)),
  );
  if (!names.length) {
    ui.pushToast({ type: 'info', message: '选中的作物都还没成熟，先等它们长完再收' });
    return;
  }
  runMany(names.map((name) => C.commands.harvest(name)));
}

/** 拆除选中建筑（按名称聚合成「拆除 名称N」） */
function removeSelected() {
  if (!selectionGroups.value.length) return;
  const cmds = selectionGroups.value.flatMap(([name, n]) => countedCommands(C.commands.remove, name, n));
  runMany(cmds);
}

function goHome() {
  const name = rawHouseName.value;
  if (!name) {
    ui.pushToast({ type: 'warning', message: '还没有家园，先「圈地」' });
    return;
  }
  run(C.commands.goHome(name), { requireHome: false });
}
function collect() {
  run(C.commands.collect(), { requireHome: false });
}
function useVoucher() {
  // 凭证 = 开垦地块，属家园写操作：建成前不可用（后端同口径拦截）
  if (homeBuiltGuard()) return;
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
/* 顶栏"种植中"徽标：绿色呼吸提示正在生长的作物格数 */
.yd-grow {
  color: #4ade80;
  background: rgba(74, 222, 128, 0.1);
  border: 1px solid rgba(74, 222, 128, 0.35);
  border-radius: 10px;
  padding: 1px 8px;
  animation: yd-grow-pulse 2s ease-in-out infinite;
}
@keyframes yd-grow-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
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

/* 建造期：整页交给全屏引导，铺满视口（组件内部自带场景 + 指令面板） */
.yd-page-building {
  overflow: hidden;
}
.yd-guide-full {
  flex: 1;
  min-height: 0;
  width: 100%;
}

/* 异常空态（档案/地图异常）：正常页内居中卡片 */
.yd-full-cta {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.yd-cta-card {
  width: min(430px, 100%);
  padding: 30px 26px 26px;
  border: 1px solid rgba(78, 163, 255, 0.3);
  border-radius: 18px;
  background: linear-gradient(165deg, rgba(20, 32, 52, 0.95), rgba(12, 18, 32, 0.96));
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.4);
  text-align: center;
}
.yd-cta-icon {
  font-size: 46px;
  margin-bottom: 10px;
  animation: yd-cta-bob 2.4s ease-in-out infinite;
}
.yd-cta-title {
  margin: 0 0 8px;
  font-size: 17px;
  color: var(--text, #e5e7eb);
}
.yd-cta-sub {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--muted);
}
.yd-cta-hint {
  margin: 14px 0 0;
  font-size: 11.5px;
  color: var(--muted);
  opacity: 0.75;
}
@keyframes yd-cta-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-7px); }
}
.yd-btn.big {
  padding: 12px 26px;
  font-size: 15px;
  font-weight: 700;
  border-radius: 12px;
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
  transition: filter 0.15s, transform 0.1s;
}
.yd-btn:hover:not(:disabled) {
  filter: brightness(1.25);
}
.yd-btn:active:not(:disabled) {
  transform: scale(0.96);
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
}
.yd-btn.tiny.on {
  border-color: var(--accent, #8b5cf6);
  background: rgba(139, 92, 246, 0.16);
  color: var(--text, #e5e7eb);
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
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.008));
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
  border: 1px solid var(--border);
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.008));
  padding: 12px 12px 14px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.yd-block:hover {
  border-color: rgba(139, 92, 246, 0.35);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
}
.yd-block-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
/* 模块图标徽章：渐变圆角方块，按模块类型着色（QQ 农场式分区感） */
.yd-b-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  font-size: 16px;
  flex-shrink: 0;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.yd-b-chip.crop {
  background: linear-gradient(135deg, rgba(74, 222, 128, 0.28), rgba(34, 197, 94, 0.14));
}
.yd-b-chip.build {
  background: linear-gradient(135deg, rgba(139, 92, 246, 0.3), rgba(99, 102, 241, 0.15));
}
.yd-b-chip.obstacle {
  background: linear-gradient(135deg, rgba(251, 146, 60, 0.26), rgba(249, 115, 22, 0.12));
}
.yd-b-chip.stock {
  background: linear-gradient(135deg, rgba(6, 182, 212, 0.28), rgba(14, 165, 233, 0.12));
}
.yd-b-chip.bag {
  background: linear-gradient(135deg, rgba(250, 204, 21, 0.28), rgba(234, 179, 8, 0.12));
}
.yd-b-chip.rate {
  background: linear-gradient(135deg, rgba(244, 114, 182, 0.26), rgba(236, 72, 153, 0.12));
}
.yd-b-title {
  font-weight: 700;
  font-size: 14px;
}
.yd-b-count {
  color: var(--accent, #8b5cf6);
  background: var(--bg3, #171a21);
  border-radius: 8px;
  padding: 0 6px;
  font-size: 11px;
}
.yd-b-ops {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex-wrap: wrap;
}

/* ---------- 地块网格 ---------- */
.yd-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--yd-min, 96px), 1fr));
  gap: var(--yd-gap, 10px);
}
/* 刷选模式：禁用滚动与文本选中，让触屏拖拽刷选不被页面滚动抢走 */
.yd-grid.brushing {
  touch-action: none;
  user-select: none;
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
  transition: transform 0.18s cubic-bezier(0.22, 0.61, 0.36, 1), border-color 0.18s, background 0.18s, box-shadow 0.18s;
  overflow: hidden;
  will-change: transform;
}
.yd-plot:hover {
  transform: translateY(-3px);
  border-color: var(--accent, #8b5cf6);
  box-shadow: 0 6px 14px rgba(0, 0, 0, 0.22);
}
.yd-plot:active {
  transform: translateY(0) scale(0.97);
}
/* 成熟地块：绿色光晕呼吸，提示"可以收获了" */
.yd-plot.ripe {
  border-color: rgba(74, 222, 128, 0.6);
  background: rgba(74, 222, 128, 0.07);
  animation: yd-ripe-glow 2.2s ease-in-out infinite;
}
@keyframes yd-ripe-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0); }
  50% { box-shadow: 0 0 0 3px rgba(74, 222, 128, 0.2); }
}
.yd-plot.sel {
  border-color: var(--accent, #8b5cf6);
  box-shadow: 0 0 0 1px var(--accent, #8b5cf6) inset;
}
.yd-plot.picked {
  border-color: var(--accent2, #06b6d4);
  background: rgba(6, 182, 212, 0.14);
  box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.45) inset;
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
/* 作物格生长阶段条：横排小圆点，已度过阶段高亮为主题色，成熟整体变绿 */
.yd-p-stages {
  display: flex;
  gap: 2px;
  margin-top: 2px;
}
.yd-p-stages i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--bg2, #0f1116);
  border: 1px solid var(--border);
  transition: background 0.3s, border-color 0.3s;
}
.yd-p-stages i.on {
  background: var(--accent, #8b5cf6);
  border-color: var(--accent, #8b5cf6);
}
.yd-p-stages i.ripe {
  background: #4ade80;
  border-color: #4ade80;
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
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.008));
  padding: 12px;
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
}
.yd-card:hover {
  border-color: rgba(139, 92, 246, 0.3);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.15);
}
.yd-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
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

/* ---------- 批量操作条 ---------- */
.yd-batch-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  border-top: 1px solid var(--border);
  background: linear-gradient(90deg, rgba(6, 182, 212, 0.12), rgba(139, 92, 246, 0.12));
  padding: 10px 14px;
  flex-shrink: 0;
  animation: yd-slide-up 0.22s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.yd-bb-info {
  font-size: 12px;
  color: var(--muted);
}
.yd-bb-info b {
  color: var(--accent2, #06b6d4);
  font-size: 14px;
}
.yd-bb-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-wrap: wrap;
}

/* ---------- 详情条 ---------- */
.yd-detail {
  border-top: 1px solid var(--border);
  background: var(--bg3, #171a21);
  padding: 10px 14px;
  flex-shrink: 0;
  animation: yd-slide-up 0.22s cubic-bezier(0.22, 0.61, 0.36, 1);
}
@keyframes yd-slide-up {
  from {
    transform: translateY(8px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
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
/* 详情条生长阶段胶囊：已度过阶段高亮主题色，成熟整体变绿 */
.yd-d-stage {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin: 4px 0 8px;
}
.yd-d-stage span {
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg2, #0f1116);
  font-size: 11px;
  color: var(--muted);
}
.yd-d-stage span.on {
  color: var(--text, #e5e7eb);
  border-color: var(--accent, #8b5cf6);
  background: rgba(139, 92, 246, 0.15);
}
.yd-d-stage span.ripe {
  color: #4ade80;
  border-color: #4ade80;
  background: rgba(74, 222, 128, 0.12);
}
.yd-d-stage-tip {
  flex-basis: 100%;
  font-size: 11px;
  color: var(--muted);
}
.yd-d-stage-tip.gain {
  color: #4ade80;
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
  animation: yd-fade-in 0.18s ease-out;
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
  animation: yd-pop-in 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes yd-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes yd-pop-in {
  from {
    transform: scale(0.92) translateY(8px);
    opacity: 0;
  }
  to {
    transform: scale(1) translateY(0);
    opacity: 1;
  }
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
