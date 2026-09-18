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
      :pending="pendingOp"
      :queue="guideQueue"
      :materials="materialsOwned"
      @send="runGuideCommand"
      @skip="skipPendingOp"
      @open-chat="router.push('/chat')"
    />
  </div>

  <!-- 建成后 / 加载中 / 错误：正常家园页（顶栏 + 农田等） -->
  <div v-else class="yd-page">
    <!-- 顶栏：家园名 / 关键指标 / 状态与刷新 -->
    <header class="yd-top">
      <button class="yd-back" title="返回聊天" @click="router.push('/chat')">←</button>
      <!-- 家园系统内面板切换：院子 ↔ 前线互相跳转（前线入口已从聊天侧栏移到这里） -->
      <div class="yd-switch">
        <span class="yd-switch-btn on">🏡 家园</span>
        <button class="yd-switch-btn" title="打开家园前线防守面板" @click="router.push('/frontline')">🛡️ 前线</button>
      </div>
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
            <span class="yd-stat">⚡ 电力 <b>{{ overview?.overview?.powerNet ?? 0 }}</b><em v-if="fuelShortage" class="yd-theo">理论</em></span>
            <span class="yd-stat">⛽ 燃料 <b>{{ fmtQty(overview?.overview?.fuelStock ?? 0) }}</b>（{{ fuelText }}）</span>
            <span class="yd-stat">🌱 肥料 <b>{{ fmtQty(overview?.overview?.fertilizerStock ?? 0) }}</b></span>
            <span class="yd-stat">👷 岗位 <b>{{ fmtQty(overview?.overview?.jobSupply ?? 0) }}/{{ overview?.overview?.jobDemand ?? 0 }}</b></span>
            <span class="yd-stat">⏱ 距上次观测 <b>{{ fmtDuration(overview?.elapsedSeconds ?? 0) }}</b></span>
          </div>
          <div v-if="!hasPower" class="yd-alarm">电力不足，建筑生产停止——检查电站与燃料</div>
          <div v-else-if="fuelShortage" class="yd-alarm fuel">燃料不足！发电机空转，建筑产出时长已归零——请补充燃料到院子</div>

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
                  <span class="yd-p-out" :class="p.stage.ripe ? 'gain' : ''">{{ cropStageText(p.stage) }}</span>
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
                {{ o.name }} ×{{ o.quantity }}<span v-if="o.clearCmd" class="yd-chip-go">{{ o.clearCmd }}</span>
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
            v-for="(sName, si) in liveCropStage(selected.stage).names"
            :key="'ds-' + si"
            :class="{ on: si <= liveCropStage(selected.stage).index, ripe: liveCropStage(selected.stage).ripe }"
          >
            {{ sName }}
          </span>
          <div class="yd-d-stage-tip" :class="liveCropStage(selected.stage).ripe ? 'gain' : ''">
            {{ liveCropStage(selected.stage).ripe
              ? '✓ 已成熟，点击下方收获'
              : `🌱 生长中，还需 ${fmtRemain(liveCropStage(selected.stage).remainSeconds)} 成熟` }}
          </div>
        </div>
        <div class="yd-d-ops">
          <template v-if="selected.kind === 'crop'">
            <button
              class="yd-btn warn"
              :disabled="running || (selected.stage && !liveCropStage(selected.stage).ripe)"
              @click="run(C.commands.harvest(selected.name))"
            >
              🌾 收获全部（{{ selected.name }} ×{{ selected.total }}）
            </button>
            <span class="yd-dim">
              {{ selected.stage && !liveCropStage(selected.stage).ripe
                ? '未成熟的作物还不能收获，等它长完再收'
                : '收获会一次收走该作物全部已成熟的棵' }}
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
import { io } from 'socket.io-client';
import { commandApi, gameApi, homeApi } from '../api';
// playerInfo 用于跳过后立刻同步 pendingActions
import { HOME_YARD_CONFIG as C, HOME_BUILD_GUIDE_CONFIG as G, WS_URL } from '../config';
// 家园建造四步引导卡片（顶部进度条，就地发指令）
import HomeBuildGuide from '../components/HomeBuildGuide.vue';
import { useUiStore } from '../stores/ui';
import { usePlayerStore } from '../stores/player';
import { syncServerClock, serverNow } from '../utils/serverClock';

const router = useRouter();
const ui = useUiStore();
const playerStore = usePlayerStore();

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
/** 家园页专用 socket：延时结算由服务端推送，不轮询 */
let socket = null;
/** 高频心跳：把 pendingActions.endAt（服务器时刻）换成剩余秒数（1s 心跳会在最后一格卡住） */
const clockTick = ref(serverNow());
let clockTimer = null;
/** 到点后的主动拉取：socket 可能慢半拍，本地先到点就主动刷玩家+院子 */
let settlePullTimer = null;
let settlePullCount = 0;

// ---------- 派生数据 ----------
/**
 * 服务端 pendingActions 里与家园引导相关的进行中操作（挖土割草 / 赶路 / 建造工作）。
 * 唯一真相源：后端写标记时 pushPlayerUpdate，延时结算后再 push 一次——
 * 前端只跟推送，不解析回包文案、不轮询。
 */
const homePendingAction = computed(() => {
  const list = playerStore.info?.pendingActions || [];
  return list.find((a) => a?.kind === 'gather')
    || list.find((a) => a?.kind === 'move')
    || list.find((a) => a?.kind === 'work')
    || null;
});

/**
 * pendingActions 快照 → 引导按钮倒计时（endAt 为服务器时刻）。
 * - 剩余 >1s：整秒展示（ceil）
 * - 最后 ~0.6s：直接进 finishing，避免「1s」卡住观感
 * - 到点后仍保留条目直到服务端推送清空，由主动拉取兜底
 */
const pendingOp = computed(() => {
  // 必须先无条件读一次时钟：放在下面两个提前 return 之后，computed 与 clockTick 的依赖
  // 就不会稳定建立，250ms 心跳改值也通知不到渲染副作用——症状即倒计时只跟着轮询跳。
  const now = clockTick.value;
  const a = homePendingAction.value;
  if (!a) return null;
  const endAt = Number(a.endAt || 0);
  if (!endAt) return null;
  const remainMs = endAt - now;
  const finishing = remainMs <= 600;
  const remain = finishing ? 0 : Math.max(1, Math.ceil(remainMs / 1000));
  const totalMs = Number(a.totalMs || 0) || Math.max(remainMs, 1);
  const total = Math.max(remain, Math.ceil(totalMs / 1000));
  const cmd = a.kind === 'gather'
    ? String(a.label || '').trim()
    : a.kind === 'move' ? '前往' : '建造';
  return {
    key: a.key,
    kind: a.kind,
    cmd,
    label: String(a.label || '').trim(),
    detail: String(a.detail || '').trim(),
    icon: a.icon || '⏳',
    remain,
    total,
    endAt,
    finishing,
    remainMs,
  };
});

/** 当前登录用户是否超管（引导上提供「⚡完成」跳过倒计时） */
const isAdmin = computed(() => {
  try {
    const u = JSON.parse(localStorage.getItem('user') || 'null');
    return ['ADMIN', 'SUPER_ADMIN'].includes(u?.role);
  } catch {
    return false;
  }
});

/** 某清障指令对应的障碍剩余次数（yard.obstacles[].quantity） */
function clearLeftOf(cmd) {
  const c = String(cmd || '').trim();
  if (!c) return 0;
  const hit = obstacles.value.find(
    (o) => o.clearCmd === c || o.name === c || String(o.clearCmd || '').includes(c),
  );
  return Math.max(0, Number(hit?.quantity || 0));
}

/** 服务端清障队列（yard.clearQueue：[{cmd,quantity}]）中某指令的条数 */
function queuedCountOf(cmd) {
  const c = String(cmd || '').trim();
  const row = (data.value?.clearQueue || []).find((x) => x?.cmd === c);
  return Math.max(0, Number(row?.quantity || 0));
}

/**
 * 院子障碍 + 服务端队列合成的清障进度视图。
 * - left：地图障碍剩余（结算前不变，含进行中/已排队）
 * - arranged：进行中 + 队列
 * - available：还能再排 = max(0, left - arranged)
 * - progress：已安排 / max(left, arranged)  —— 队列有货但障碍数为 0 时也要能看见
 */
const clearSpots = computed(() => {
  const p = pendingOp.value;
  const busy = p?.kind === 'gather' ? p.cmd : '';
  const byCmd = new Map();
  for (const o of obstacles.value || []) {
    const cmd = String(o.clearCmd || '').trim();
    if (!cmd) continue;
    const left = Math.max(0, Number(o.quantity) || 0);
    if (left <= 0 && !queuedCountOf(cmd)) continue;
    // 开挖地基后院子里会有 2 个同名「土堆」资源；按指令聚合时必须累加 left，
    // 否则只显示最后一堆的次数，玩家会以为「清完 ×20」就能结束（实际还要再清一堆）。
    const prev = byCmd.get(cmd);
    if (prev) {
      prev.left += left;
      prev.piles = (prev.piles || 1) + 1;
    } else {
      byCmd.set(cmd, {
        cmd,
        name: String(o.name || cmd).trim(),
        left,
        piles: 1,
      });
    }
  }
  // 队列里有、地图上却没有显示的类型：也要露出来，避免「队列有挖土但界面只有割草」
  for (const row of data.value?.clearQueue || []) {
    const cmd = String(row?.cmd || '').trim();
    if (!cmd) continue;
    if (!byCmd.has(cmd)) {
      byCmd.set(cmd, { cmd, name: cmd, left: 0 });
    }
  }
  return Array.from(byCmd.values()).map((s) => {
    const queued = queuedCountOf(s.cmd);
    const inFlight = busy === s.cmd ? 1 : 0;
    const arranged = inFlight + queued;
    const available = Math.max(0, s.left - arranged);
    const progressTotal = Math.max(s.left, arranged, 1);
    return {
      ...s,
      queued,
      inFlight,
      arranged,
      available,
      busy: busy === s.cmd,
      progressPct: Math.min(100, Math.round((arranged / progressTotal) * 100)),
    };
  });
});

/** 传给引导组件的排队/跳过信息（队列来自服务端，刷新不丢） */
const guideQueue = computed(() => {
  const p = pendingOp.value;
  const serverQueue = data.value?.clearQueue || [];
  const firstCmd = serverQueue[0]?.cmd || '';
  const busyCmd = p?.kind === 'gather' ? p.cmd : firstCmd;
  const busySpot = clearSpots.value.find((s) => s.cmd === busyCmd) || null;
  const queuedLeft = serverQueue.reduce((n, x) => n + Number(x?.quantity || 0), 0);
  return {
    adminMode: isAdmin.value,
    queueCount: queuedLeft,
    queueCmd: firstCmd,
    queueDetail: serverQueue.map((x) => `${x.cmd}×${x.quantity}`).join('、'),
    busyClearCmd: busyCmd,
    clears: clearSpots.value,
    /** 障碍总数（结算前不变）；可排看 clears[].available */
    clearLeft: busySpot ? busySpot.left : (clearSpots.value[0]?.left || 0),
    clearTotalLeft: (p?.kind === 'gather' ? 1 : 0) + queuedLeft,
    needHome: progress.value > 0 && !atHome.value,
    obstaclesLeft: clearSpots.value.reduce((n, s) => n + s.left, 0),
  };
});

/** 接口里的真实房名（可为空）；展示名 houseName 才做「家园」兜底 */
const rawHouseName = computed(() => String(data.value?.houseName || '').trim());
const houseName = computed(() => rawHouseName.value || '家园');
const level = computed(() => Number(data.value?.level ?? 1) || 1);
const vouchers = computed(() => Number(data.value?.vouchers ?? 0) || 0);
const progress = computed(() => Number(data.value?.progress ?? 0) || 0);
/**
 * 房子开工后进度立刻是 4（与原版一致），但 2 分钟读条未结束前
 * 仍应留在建造引导页，不能切到完整家园（房子还没盖好）。
 */
const houseConstructing = computed(() => {
  if (progress.value < 4) return false;
  const p = pendingOp.value;
  if (!p || p.kind !== 'work') return false;
  const label = String(p.label || '').trim();
  return label.includes('房子') || label.includes('建造');
});
/** 是否处于「建造引导接管」阶段：未建成 / 房子施工中 / 刚建成庆祝 */
const buildingPhase = computed(() => {
  if (!data.value) return false;
  if (progress.value < 4) return true;
  if (houseConstructing.value) return true;
  return holdDone.value;
});
/** 玩家快照上的位置（与院子图名一致即视为已到家，不单靠读条消失） */
const playerLocation = computed(() => String(playerStore.info?.location || '').trim());
/** 到家判定：yard.atHome 为权威；赶路 finishing 时若 location 已是自家院子，也视为到家 */
const atHome = computed(() => {
  if (data.value?.atHome) return true;
  const house = rawHouseName.value;
  if (house && playerLocation.value && playerLocation.value === house) return true;
  return false;
});
const blocked = computed(() => data.value?.blocked || '');
const crop = computed(() => data.value?.crop || { used: 0, limit: 0, plots: [] });
const building = computed(() => data.value?.building || { used: 0, limit: 0, plots: [] });
const obstacles = computed(() => data.value?.obstacles || []);
const seeds = computed(() => data.value?.seeds || []);
const buildings = computed(() => data.value?.buildings || []);
/** 背包资源存量：{ 木头: 50, 石头: 30, … }（建造引导「已有 X/需要 Y」用） */
const materialsOwned = computed(() => data.value?.materials || {});
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
/** 燃料不足：有消耗但库存撑不过 6 小时（与后端 fuelShortage 同口径） */
const fuelShortage = computed(() => Boolean(overview.value?.overview?.fuelShortage));
const dailyList = computed(() => overview.value?.overview?.dailyDisplay || []);
const claimList = computed(() => (overview.value?.gains || []).filter((g) => Number(g.quantity) > 0));
const stockList = computed(() => (stockTab.value === 'seed' ? seeds.value : buildings.value));
// 地块可能成百上千（高等级 + 多凭证），只渲染前 N 块防止页面卡死
// 渲染上限内顺手换成 liveCropStage：stage 随 clockTick 逐秒推进，不必等 45s 轮询才跳
const visibleCropPlots = computed(() => crop.value.plots.slice(0, C.plot.maxVisible)
  .map((p) => (p.stage ? { ...p, stage: liveCropStage(p.stage) } : p)));
const visibleBuildingPlots = computed(() => building.value.plots.slice(0, C.plot.maxVisible));
const gridStyle = computed(() => ({
  '--yd-min': `${C.plot.minSize}px`,
  '--yd-gap': `${C.plot.gap}px`,
}));
/** 田里已成熟的作物名（去重），用于「一键收获」；未成熟的不参与，避免白跑一遍 */
const cropNames = computed(() => {
  // 依赖 clockTick：本地刚熟的格子也能立刻进一键收获，不必等 45s 轮询
  void clockTick.value;
  const names = new Set();
  for (const p of crop.value.plots) {
    if (p.state === 'occupied' && p.name && p.stage && liveCropStage(p.stage).ripe) names.add(p.name);
  }
  return Array.from(names);
});
/** 田里正在生长的作物格数量（顶栏统计用） */
const growingCount = computed(() => {
  void clockTick.value;
  let count = 0;
  for (const p of crop.value.plots) {
    if (p.state === 'occupied' && p.stage && !liveCropStage(p.stage).ripe) count += 1;
  }
  return count;
});

/** 本地时钟首次把某块地算成熟时，拉一次院子同步服务端 ripe/收获态 */
watch(cropNames, (now, prev) => {
  if ((prev?.length || 0) > 0 && now.length > prev.length) {
    void refresh();
  } else if ((prev?.length || 0) === 0 && now.length > 0 && data.value) {
    // 从全无成熟到有成熟（含首屏后本地到点）
    void refresh();
  }
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
  // 首屏必须拉一次玩家快照：建造倒计时依赖 pendingActions.endAt，
  // 只等 socket player:update 会漏掉「直接进 /home / 刷新页面」的场景
  void loadPlayerSnapshot();
  timer = setInterval(refresh, C.refreshMs);
  // 250ms 心跳：最后 1 格用秒级时会在 1s 卡近 1 秒+结算延迟，观感像卡住
  clockTimer = setInterval(() => { clockTick.value = serverNow(); }, 250);
  connectHomeSocket();
  // 挂载后若已有空转队列，立刻尝试接龙（watch 只在变化时触发，首屏可能漏）
  setTimeout(() => { tryDrainIdleQueue(); }, 600);
});

/** 空闲且队列有货：调服务端接龙（无读条时开挖下一条） */
async function tryDrainIdleQueue() {
  if (drainGuard || running.value) return;
  const qLen = (data.value?.clearQueue || []).length;
  if (!qLen || pendingOp.value || !atHome.value) return;
  drainGuard = true;
  try {
    await homeApi.drainClear();
    await Promise.all([loadPlayerSnapshot(), refresh()]);
  } catch { /* 静默 */ }
  finally {
    drainGuard = false;
  }
}
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  if (clockTimer) clearInterval(clockTimer);
  if (holdDoneTimer) clearTimeout(holdDoneTimer);
  if (settlePullTimer) {
    clearTimeout(settlePullTimer);
    settlePullTimer = null;
  }
  disconnectHomeSocket();
  endBrush();
});

/** 家园页 socket：指令执行 / 延时结算后服务端会推 player:update（含 pendingActions）与 map:update */
function connectHomeSocket() {
  const token = localStorage.getItem('token');
  if (!token || socket) return;
  socket = io(WS_URL, {
    auth: { token },
    transports: ['websocket'],
  });
  socket.on('connect', () => {
    syncServerClock();
    // 重连窗口内可能错过结算推送：全量拉一次校准
    refresh();
  });
  socket.on('player:update', (info) => {
    if (!info) return;
    playerStore.setPlayerInfo(info);
    clockTick.value = serverNow();
    syncPendingFlag();
  });
  // 移动到达强推 map:update：建造期一律刷院子（到家后 atHome/清障按钮要立刻变）
  socket.on('map:update', () => {
    clockTick.value = serverNow();
    if (buildingPhase.value || hadPending || pendingOp.value) {
      refresh();
      void loadPlayerSnapshot();
    }
  });
}

function disconnectHomeSocket() {
  if (!socket) return;
  socket.disconnect();
  socket = null;
}

/**
 * 观察「进行中的延时操作」从有→无：服务端结算完成后推送空列表，
 * 此时刷一次院子，UI 自动进入下一阶段（障碍消失 / 已到家 / 进度变化）。
 */
function syncPendingFlag() {
  const has = Boolean(pendingOp.value) || Boolean(homePendingAction.value);
  if (hadPending && !has) {
    hadPending = false;
    refresh();
    return;
  }
  hadPending = has;
}

/**
 * 本地时钟一到点（finishing）：不干等 socket——连续主动拉玩家快照+院子，
 * 否则结算/推送慢时会一直停在「1s / 即将完成」。
 */
function armSettlePull() {
  settlePullCount = 0;
  if (settlePullTimer) clearTimeout(settlePullTimer);
  settlePullTimer = setTimeout(pullUntilSettled, 80);
}

function pullUntilSettled() {
  settlePullTimer = null;
  if (running.value) return;
  if (!pendingOp.value?.finishing && !hadPending) return;
  settlePullCount += 1;
  Promise.all([loadPlayerSnapshot(), refresh()]).finally(() => {
    if (running.value) return;
    // 赶路：延时任务 tick 最多可晚 1s+结算写库，多拉几轮避免卡在「即将到达」
    const stillBusy = pendingOp.value?.finishing || (hadPending && pendingOp.value);
    if (!stillBusy) return;
    const maxPulls = pendingOp.value?.kind === 'move' ? 20 : 8;
    const gap = pendingOp.value?.kind === 'move' ? 200 : 300;
    if (settlePullCount < maxPulls) {
      settlePullTimer = setTimeout(pullUntilSettled, gap);
    }
  });
}

/**
 * 作物阶段本地实时视图：有 plantedAt 时用 clockTick（已对齐服务器）倒数，
 * 否则退回接口快照 remainSeconds。模板里读 clockTick，250ms 心跳驱动重渲染。
 */
function liveCropStage(stage) {
  if (!stage) return stage;
  const plantedAt = Number(stage.plantedAt || 0);
  const total = Number(stage.totalSeconds || 0);
  if (!plantedAt || total <= 0) return stage;

  const nowSec = clockTick.value / 1000;
  const elapsed = Math.max(0, nowSec - plantedAt);
  const ripe = elapsed >= total;
  const remainSeconds = ripe ? 0 : Math.max(1, Math.ceil(total - elapsed));
  const stageCount = Math.max(1, Number(stage.total) || stage.names?.length || 1);
  const index = ripe
    ? stageCount - 1
    : Math.min(stageCount - 1, Math.floor(elapsed / (total / stageCount)));

  return {
    ...stage,
    index,
    progressPct: ripe ? 1 : Math.min(1, elapsed / total),
    remainSeconds,
    ripe,
    plantedAt,
  };
}

/** 格子/详情里的成熟文案（跟随本地心跳） */
function cropStageText(stage) {
  const live = liveCropStage(stage);
  if (live.ripe) return '✓ 可收获';
  const name = live.names?.[live.index] ?? '';
  return `${name} · ${fmtRemain(live.remainSeconds)}`;
}
watch([pendingOp, homePendingAction], () => {
  syncPendingFlag();
});

watch(
  () => pendingOp.value?.finishing,
  (now, prev) => {
    if (now && !prev) armSettlePull();
  },
);

/** 队列有货但没有任何读条（刷新后空转 / 结算间隙）：主动接龙，别让进度条消失 */
let drainGuard = false;
watch(
  [() => (data.value?.clearQueue || []).length, () => Boolean(pendingOp.value)],
  // Vue 多源 watch 的回调参数是数组，不是标量——写成 (qLen, hasPend) 会让 hasPend 恒为真，接龙永远不触发
  async ([qLen], [hasPend]) => {
    if (!qLen || hasPend || running.value) return;
    await tryDrainIdleQueue();
  },
);

/**
 * 房子读条结束（houseConstructing true→false）：引导页多留 6s
 * 播完撒花/落成动画，再切完整家园。开工瞬间进度已是 4，不能那时就切走。
 */
watch(houseConstructing, (now, before) => {
  if (before && !now && progress.value >= 4) {
    holdDone.value = true;
    clearTimeout(holdDoneTimer);
    holdDoneTimer = setTimeout(() => { holdDone.value = false; }, 6000);
  }
});
watch(progress, (now) => {
  if (now < 4) holdDone.value = false;
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
  if (running.value || pendingOp.value || !cmds?.length) return;
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
  if (running.value || pendingOp.value) return;
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
  if (running.value || pendingOp.value || !cmd) return;
  if (requireHome && !atHome.value) {
    ui.pushToast({ type: 'warning', message: C.texts.notAtHome });
    return;
  }
  running.value = true;
  try {
    const res = await commandApi.execute(cmd);
    const text = res?.data?.content ?? '';
    ui.pushToast({ type: 'success', message: text || `已执行：${cmd}`, timeout: 5000 });
  } catch (e) {
    ui.pushToast({ type: 'error', message: e?.response?.data?.message || `执行失败：${cmd}` });
  } finally {
    running.value = false;
    selected.value = null;
    picker.value.open = false;
    // 即时指令：短延时补拉院子。延时指令（挖土/赶路/建造）还必须补拉 playerInfo，
    // 否则「建造房子中 Ns」的 endAt 来自旧快照/缺失，倒计时会卡住不动。
    setTimeout(() => {
      refresh();
      void loadPlayerSnapshot();
    }, C.refetchDelayMs);
  }
}

/**
 * 四步引导条上的按钮。
 * - 挖土/割草：入服务端队列（连点排队，刷新不丢）
 * - 挖土N/割草N：批量一次采集（后端院子支持次数后缀），比连点 N 次顺滑
 * - 其余走统一指令通道
 */
function runGuideCommand(cmd) {
  const c = String(cmd || '').trim();
  const isTravel = c.startsWith('前往');
  const isSingleClear = c === '挖土' || c === '割草';
  const isBatchClear = /^(挖土|割草)\d+$/.test(c);

  if (isSingleClear) {
    const gathering = pendingOp.value?.kind === 'gather' ? pendingOp.value : null;
    if (gathering && gathering.cmd !== c) {
      ui.pushToast({
        type: 'info',
        message: `正在「${gathering.cmd}」，完成前只能继续点「${gathering.cmd}」`,
      });
      return;
    }
    return enqueueClear(c);
  }

  // 批量/排满：
  // - 闲置：直接发「挖土N」一次采集完（后端院子批量）
  // - 已有同类读条或队列：把剩余可排次数一次塞进服务端队列（不发新 gather）
  if (isBatchClear) {
    const m = c.match(/^(挖土|割草)(\d+)$/);
    const base = m?.[1] || '';
    const n = Math.max(1, Number(m?.[2] || 1));
    const gathering = pendingOp.value?.kind === 'gather' ? pendingOp.value : null;
    if (gathering && gathering.cmd !== base) {
      ui.pushToast({ type: 'info', message: `正在「${gathering.cmd}」，完成前只能清「${gathering.cmd}」` });
      return;
    }
    if (gathering || queuedCountOf(base) > 0) {
      // 排满：按「还能再排多少」入队，而不是再开一条批量 gather
      const spot = clearSpots.value.find((s) => s.cmd === base);
      const available = spot ? spot.available : n;
      if (available <= 0) {
        ui.pushToast({ type: 'info', message: `「${base}」已经全部安排好了` });
        return;
      }
      return enqueueClear(base, available);
    }
    return run(c, { requireHome: progress.value > 0 });
  }

  return run(c, { requireHome: !isTravel && progress.value > 0 });
}

/** 清障入队（服务端持久化）：空闲自动开第一发，进行中只排队；count=一次入队条数 */
async function enqueueClear(cmd, count = 1) {
  if (running.value) return;
  running.value = true;
  try {
    const res = await homeApi.enqueueClear(cmd, count);
    const payload = res?.data ?? res;
    ui.pushToast({
      type: payload?.success ? 'success' : 'info',
      message: payload?.message || (payload?.success ? `已排队「${cmd}」` : '排队失败'),
    });
    // 空闲入队时服务端会立刻 drain 开第一发：clearQueue 被弹空，
    // 只刷院子看不到「已安排/读条」；必须同步拉玩家快照，按钮才立刻变倒计时。
    if (payload?.success) {
      await Promise.all([refresh(), loadPlayerSnapshot()]);
    }
  } catch (e) {
    ui.pushToast({
      type: 'error',
      message: e?.response?.data?.message || `排队「${cmd}」失败`,
    });
  } finally {
    running.value = false;
  }
}

/**
 * 超管：跳过读条。
 * - 清障（挖土/割草/服务端队列）：一次跳过**整条**队列，不是只消 1 次
 * - 赶路/建造等：走通用 finishNow
 * 结束后强制拉 yard + playerInfo，保证 UI 立刻进入下一状态。
 */
async function skipPendingOp() {
  if (!isAdmin.value) return;
  const queueLen = (data.value?.clearQueue || []).reduce((n, x) => n + Number(x?.quantity || 0), 0);
  const isClear = pendingOp.value?.kind === 'gather' || queueLen > 0;
  running.value = true;
  try {
    const res = isClear ? await homeApi.finishClear() : await gameApi.finishNow();
    const payload = res?.data ?? res;
    ui.pushToast({
      type: payload?.success ? 'success' : 'error',
      message: payload?.message || (payload?.success ? '已立即完成' : '跳过失败'),
    });
    // 立刻刷新院子与玩家面板（不依赖 socket 推送时序）
    await Promise.all([
      refresh(),
      loadPlayerSnapshot(),
    ]);
  } catch (e) {
    ui.pushToast({
      type: 'error',
      message: e?.response?.data?.message || e?.message || '立即完成失败',
    });
  } finally {
    running.value = false;
  }
}

/** 拉一次玩家快照写入 player store（pendingActions / location / atHome） */
async function loadPlayerSnapshot() {
  try {
    const res = await gameApi.playerInfo();
    playerStore.setPlayerInfo(res?.data ?? res ?? null);
    clockTick.value = serverNow();
    syncPendingFlag();
    // 位置已是自家院子但 yard 还没刷到 atHome：立刻补拉院子
    const house = rawHouseName.value;
    const loc = String(playerStore.info?.location || '').trim();
    if (house && loc === house && !data.value?.atHome) {
      await refresh();
    }
  } catch { /* 静默：socket 推送仍会兜底 */ }
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
    new Set(
      selectionList.value
        .filter((x) => x.plot.stage && liveCropStage(x.plot.stage).ripe)
        .map((x) => x.plot.name)
        .filter(Boolean),
    ),
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
/* ---------- 家园 ↔ 前线 面板切换 ---------- */
.yd-switch {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg2, #0f1116);
  flex-shrink: 0;
}
.yd-switch-btn {
  padding: 4px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
button.yd-switch-btn {
  cursor: pointer;
}
button.yd-switch-btn:hover {
  color: var(--text, #e5e7eb);
  background: rgba(255, 255, 255, 0.06);
}
.yd-switch-btn.on {
  color: var(--text, #e5e7eb);
  background: rgba(139, 92, 246, 0.16);
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
.yd-alarm.fuel {
  border-color: rgba(251, 146, 60, 0.4);
  background: rgba(251, 146, 60, 0.1);
  color: #fb923c;
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
.yd-theo {
  margin-left: 4px;
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(251, 146, 60, 0.15);
  color: #fb923c;
  font-size: 10px;
  font-style: normal;
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
