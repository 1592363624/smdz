<!--
 * RichSystemCard.vue
 *
 * 功能：将服务端下发的「结构化纯文本」长消息（背包、属性面板、装备栏等）在公屏中
 *       渲染成更紧凑的网格卡片布局，避免竖向列表过长影响阅读体验。
 *
 * 设计约束与兼容性：
 * - 本组件仅是「展示层」增强——它读原文做结构化展示，但绝不改写原文内容。
 * - 后端与 AstrBot（QQ 等）仍走标准纯文本消息，本组件只在网页端对展示样式做优化。
 * - 当文本无法被规则识别时，自动回退为原始纯文本原样直出，保证任何场景内容完整。
 -->
<template>
  <div class="rich-card">
    <!--
     * 关键修复：用 <template> 把"弹层（独立 v-if）"和"主内容（v-if/v-else-if/v-else 互斥链）"分成两个独立块。
     * 之前 rc-handbook（v-if）插在 rc-bag（v-if）和 rc-profile（v-else-if）之间，会被 Vue 视为与 rc-profile 同链，
     * 导致 v-else（rc-raw）实际是与"图鉴弹层"配对，绕过 rc-bag 判断 → 检测到背包也仍会渲染文字版兜底。
     * 把弹层挪到主内容互斥链之后、用独立 v-if 渲染，彻底断开链依赖。
     -->
    <template v-if="layout">
      <!-- 背包 → 物品网格（容器统一监听离开以延迟关闭图鉴弹层，格子间移动不再触发 hide/show，杜绝闪屏） -->
      <div v-if="layout.kind === 'bag'" class="rc-bag" @mouseleave="scheduleHide">
        <div class="rc-title">{{ layout.title }}</div>
        <div class="rc-grid">
          <div
            v-for="(row, i) in layout.items"
            :key="i"
            class="rc-cell rc-cell-item"
            :class="{ 'rc-cell-use': row.kind === 'use' }"
            @click="onCellClick(row.name, row.kind)"
            @mouseenter="onCellEnter(row.name, $event)"
          >
            <!-- 序号格：与「装备 N」指令的解序号一一对应，方便玩家肉眼对号操作 -->
            <span v-if="row.idx != null" class="rc-idx">{{ row.idx }}</span>
            <span class="rc-name">{{ row.name }}</span>
            <span v-if="row.count != null" class="rc-count">×{{ row.count }}</span>
          </div>
        </div>
      </div>

      <!-- 属性面板 → 两栏：左列属性卡片 + 右列装备网格 -->
      <div v-else-if="layout.kind === 'profile'" class="rc-profile">
        <div class="rc-title">{{ layout.title }}</div>
        <div class="rc-cols">
          <div class="rc-cols-stats">
            <div class="rc-stats">
              <div v-for="(s, i) in layout.stats" :key="i" class="rc-stat">
                <span class="rc-icon">{{ s.icon }}</span>
                <span class="rc-label">{{ s.label }}</span>
                <span class="rc-value">{{ s.value }}</span>
              </div>
            </div>
            <!-- 系统横幅展示位（可开关，localStorage 记忆）：显示消息尾部【…】解锁/提示信息 -->
            <div v-if="bannerOpen && layout.banners.length" class="rc-banner-wrap">
              <div class="rc-banner-head">
                <span class="rc-banner-label">📣 系统提示（{{ layout.banners.length }}）</span>
                <button type="button" class="rc-banner-toggle" title="隐藏系统提示" @click="bannerOpen = false">−</button>
              </div>
              <div class="rc-banners">
                <div v-for="(b, i) in layout.banners" :key="i" class="rc-banner">{{ b }}</div>
              </div>
            </div>
          </div>
          <div v-if="layout.equip.length" class="rc-cols-equip">
            <div class="rc-equip">
              <div class="rc-subtitle">📋 装备</div>
              <div class="rc-equip-grid">
                <div
                  v-for="(e, i) in layout.equip"
                  :key="i"
                  class="rc-eqcell"
                  :class="{ 'rc-empty': !e.has }"
                  :style="e.has && e.quality ? { borderColor: QUALITY_COLOR[e.quality], boxShadow: `0 0 8px ${QUALITY_COLOR[e.quality]}55` } : {}"
                >
                  <span class="rc-slot">{{ e.slot }}</span>
                  <span
                    v-if="e.has"
                    class="rc-eq-name"
                    :style="e.quality ? { color: QUALITY_COLOR[e.quality] } : {}"
                    :title="e.text"
                  >{{ e.text }}</span>
                  <span v-else class="rc-eq-name rc-none">无</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 识别失败 → 原样直出文本（兜底，仅：未识别为 bag/profile 时触发；与上面互斥） -->
      <div v-else class="rc-raw" style="white-space: pre-line">{{ text }}</div>
    </template>

    <!--
     * 悬浮图鉴弹层：用 <Teleport to="body"> 挂到 body 下，
     * 完全脱离 .msg.msg-rich/.rich-card 等父级 stacking context / overflow:hidden 的影响。
     * 体积自适应内容，但有最小宽度，避免短文本塌缩成不可见。
     * z-index: 99999 高于绝大多数组件内弹层。
     * 关键改进：visible 在 mouseenter 同步段就设为 true（不再等 setTimeout），
     * 这样即使后端慢，也能立刻看到「读取图鉴中…」的占位文本。
     -->
    <Teleport to="body">
      <div
        v-if="active.visible"
        class="rc-handbook"
        :style="{ left: active.left + 'px', top: active.top + 'px' }"
      >
        <div v-if="active.loading" class="rc-hb-body rc-hb-loading">读取图鉴中…</div>
        <div v-else-if="active.error" class="rc-hb-body rc-hb-error">{{ active.error }}</div>
        <pre v-else class="rc-hb-body rc-hb-content">{{ active.content }}</pre>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch, Teleport } from 'vue';
import { commandApi, systemApi } from '../api';

/**
 * Props：text 为服务端下发的原始消息文本（含换行）
 */
const props = defineProps({
  text: { type: String, default: '' },
});

/** 向父组件（ChatView）发送指令：背包格子点击装备即触发 */
const emit = defineEmits(['send']);

/**
 * 系统横幅展示位的显隐开关。
 * 用户在属性卡片上手动隐藏后，用 localStorage 持久化，下次渲染仍保持选择。
 */
const BANNER_KEY = 'richcard.show-banner';
let bannerOpen = ref(localStorage.getItem(BANNER_KEY) !== '0');
function toggleBanner(v) {
  bannerOpen.value = v;
  localStorage.setItem(BANNER_KEY, v ? '1' : '0');
}
watch(bannerOpen, (v) => toggleBanner(v));

/**
 * 图鉴查询缓存：同一物品只向后端请求一次，之后悬浮直接读缓存，避免重复请求。
 */
const handbookCache = new Map();

/**
 * 悬浮图鉴弹层状态：
 * - 弹层 pointer-events:none 不参与鼠标事件，只由「格子 enter / 容器 leave」驱动。
 * - 在格子之间横向移动时只更新当前物品内容，绝不 hide/show，
 *   配合 enterDelay/hideDelay 延迟，彻底消除闪烁且保证内容稳定展示。
 */
const active = reactive({ visible: false, left: 0, top: 0, name: '', loading: false, error: '', content: '' });

// 显示延迟：鼠标掠过时防误触；隐藏延迟：容器内留出阅读时间
// enterDelay 默认 1000ms，可通过 GM 后台配置 web.handbookTooltipDelayMs 在线调整
// （模块级缓存：多个卡片实例只拉一次配置；拉取失败回退默认值）
const enterDelayDefault = 1000;
const enterDelay = { value: enterDelayDefault };
const hideDelay = 600;
let enterTimer = null;
let hideTimer = null;
/** 悬浮事件序号：每次进入/离开递增，供 setTimeout 回调与在途请求校验是否过期 */
let hoverSeq = 0;
let webConfigLoaded = false;

async function loadWebConfigOnce() {
  if (webConfigLoaded) return;
  webConfigLoaded = true;
  try {
    const res = await systemApi.getWebConfig();
    const ms = Number(res?.data?.handbookTooltipDelayMs ?? res?.handbookTooltipDelayMs);
    if (Number.isFinite(ms) && ms >= 0) enterDelay.value = ms;
  } catch {
    /* 配置拉取失败：保持默认值，不打扰用户 */
  }
}
onMounted(loadWebConfigOnce);

/**
 * 背包格子点击：只对装备（kind==='equip'）发「穿上 X」；消耗品/资源不响应（鼠标样式 + click return）。
 * 简化交互：避免「使用能量块→ 后端报不是可直接使用的物品」之类的反馈噪音。
 */
function onCellClick(name, itemKind) {
  if (itemKind !== 'equip') return;
  emit('send', `穿上 ${name}`);
}

/**
 * 鼠标悬浮背包格子 → 延迟后展示该物品图鉴。
 * 通过 REST 执行「图鉴」指令，结果仅在本弹层展示，不写入/广播到公屏（execute 只返回不广播）。
 *
 * 统一时序：无论首次进入、缓存命中、还是从另一格子切过来，
 * 一律等 enterDelay（默认 1000ms，GM 后台可配 web.handbookTooltipDelayMs）后才显示弹层——
 * "悬浮窗何时出现"完全由配置的延迟决定，不因缓存/切换而提前。
 * - 切换时立即收起旧弹层（等待期不残留上一个物品的内容）；
 * - 到点后：有缓存 → 直接展示内容；无缓存 → 读取中并请求。
 *
 * 防过期：hoverSeq 序号 token——每次进入/离开递增，setTimeout 回调与请求完成时校验 token，
 * 过期即丢弃（用户已移走/切到别的物品时，迟到的结果不污染当前弹层）。
 */
async function onCellEnter(name, e) {
  // 同物品且弹层已在显示（内容/错误/读取中）→ 直接复用，不重启延迟、不重算位置（防抖）
  clearTimeout(hideTimer);
  if (active.visible && active.name === name && (active.content || active.error || active.loading)) {
    return;
  }

  // 1) 算位置（提前算好存着：延迟结束后鼠标事件对象已失效，不能再取 getBoundingClientRect）
  const rect = e?.currentTarget?.getBoundingClientRect();
  if (rect) {
    // 弹层最大 300px 宽 / 260px 高：默认向右展开，右侧放不下则左向；超出视口向内收拢，保证完整可见
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const POP_W = 300;
    const POP_H = 260;
    let left = Math.round(rect.right + 8);
    if (left + POP_W > viewW) left = Math.round(rect.left - POP_W);
    left = Math.max(8, left);
    let top = Math.round(rect.top - 8);
    if (top < 4) top = 4;
    if (top + POP_H > viewH) top = Math.max(4, viewH - POP_H - 6);
    active.left = left;
    active.top = top;
  }

  // 2) 弹层正显示【另一个物品】的内容 → 立即收起（不留残留；等待期内旧物品信息不挂在新格子上）
  if (active.visible && active.name !== name) {
    hideNow();
  }

  // 3) 统一延迟后弹出：缓存命中直接展示内容（仍然等过延迟）；否则读取中 + 请求
  const mySeq = ++hoverSeq;
  clearTimeout(enterTimer);
  enterTimer = setTimeout(async () => {
    // 已被更新的进入/离开事件顶替 → 本回调作废
    if (mySeq !== hoverSeq) return;

    // 缓存命中 → 直接展示（不再发请求），但同样等过了 enterDelay
    if (handbookCache.has(name)) {
      active.name = name;
      active.error = '';
      active.loading = false;
      active.content = handbookCache.get(name);
      active.visible = true;
      return;
    }

    // 无缓存 → 读取中 + 请求
    active.name = name;
    active.error = '';
    active.content = '';
    active.loading = true;
    active.visible = true;
    /** 执行一次「图鉴 X」并取回 content（axios 拦截器已剥外层，兼容两/三层嵌套）；顺带剥顶部横幅 */
    const runQuery = async (q) => {
      const res = await commandApi.execute(`图鉴 ${q}`);
      const raw = (
        String(res?.data?.content ?? '') ||
        String(res?.content ?? '') ||
        ''
      ).trim();
      return stripLeadingBanners(raw);
    };
    try {
      // 两段式回退：
      // ① 先按显示名原样查（覆盖「妖精之森E」这类名字本身以品质码字母结尾的物品）
      // ② 显示名查不到、且能剥出更短基础名时（如「纵横C」→「纵横」），回退查基础名
      //    ——后端图鉴按基础名登记，带品质码的显示名匹配不到
      // 注意：dispatch 会把离线结算横幅（⏰…）前插到 content 开头，
      //       所以「没有找到」检测不能锚定行首，用 includes 判断。
      let trimmed = await runQuery(name);
      const isNotFound = (s) => s.includes('图鉴中没有找到');
      if (isNotFound(trimmed)) {
        const base = handbookQueryName(name);
        if (base !== name) {
          trimmed = await runQuery(base);
        }
      }
      trimmed = trimmed || '🐾 图鉴中暂无该物品的详细资料';
      // 请求完成时若用户已移走/切走 → 丢弃结果，不污染当前弹层
      if (mySeq !== hoverSeq) return;
      active.content = trimmed;
      active.loading = false;
      // 结果入缓存（含「图鉴中没有找到」——它就是该名字的最终结果，避免每次悬浮都重发两段请求；
      // 页面刷新即清空缓存，后端补录图鉴后刷新即可看到）。仅「空内容」占位不入缓存。
      if (trimmed !== '🐾 图鉴中暂无该物品的详细资料') {
        handbookCache.set(name, trimmed);
      }
    } catch (err) {
      if (mySeq !== hoverSeq) return;
      active.error = '图鉴查询失败，请稍后再试';
      active.loading = false;
    }
  }, enterDelay.value);
}

/** 立即收起弹层并清空状态（供切换/离开/卸载复用） */
function hideNow() {
  active.visible = false;
  active.name = '';
  active.content = '';
  active.error = '';
  active.loading = false;
}

/** 鼠标离开整个背包网格容器 → 延迟关闭图鉴弹层（留出阅读时间） */
function scheduleHide() {
  // 使所有挂起的进入 timer / 在途请求作废
  hoverSeq++;
  clearTimeout(enterTimer);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideNow();
    // 同时取消可能仍在进行的请求（无法真正 abort fetch，但下次重渲不会再被读到）
  }, hideDelay);
}

/** 组件卸载 → 清掉 timer + 隐藏，避免销毁残留。挂到 body 的 Teleport 节点会被 Vue 自动清理。 */
onBeforeUnmount(() => {
  clearTimeout(enterTimer);
  clearTimeout(hideTimer);
  hideNow();
});

/** 装备品质集合（与改版 backend qualityPrefix 对齐） */
const QUALITY_SET = new Set(['普通', '良好', '优秀', '精良', '史诗', '传说', '神迹']);
/** 品质 → 描边/文字颜色（供装备格区分品级） */
const QUALITY_COLOR = {
  普通: '#b0b6c4',
  良好: '#4ade80',
  优秀: '#38bdf8',
  精良: '#a78bfa',
  史诗: '#fbbf24',
  传说: '#f87171',
  神迹: '#f472b6',
};

/**
 * 结构化解析：把背包/属性面板这类纯文本列表转成可网格化的布局对象。
 * 返回 null 表示不识别（组件将原样直出文本）。
 */
const layout = computed(() => parseLayout(props.text));

/**
 * 判断是否为系统横幅通知文本（如「【你的训练器现在可以使用了】」）。
 * 这类解锁/提示横幅不属于背包物品或装备，卡片内不展示，避免混入最后一项。
 */
const isBannerLine = (s) => /^【.+】\s*$/.test(s || '');

/**
 * 启发式分类背包物品：装备 vs 消耗品/资源。
 * 依据：服务端「formatEquipmentInventoryDisplay」生成的装备显示名 = 基础名 + 单字母品质码 + 可选·特效。
 * 因此名字末尾正好是大写品质码字母（[EDCBASX]）即视为装备，其他视为可使用/资源。
 * 注意：先剥掉尾部·xxx特效再判断，避免把「防弹上衣D·纯洁无瑕」误判为非装备。
 */
function classifyItemKind(name) {
  const stripped = String(name || '').replace(/·[^·]+$/, '');
  return /[EDCBASX]$/.test(stripped) ? 'equip' : 'use';
}

/**
 * 图鉴查询名：剥掉显示名里的品质码/特效，得到后端图鉴登记用的「基础名」。
 * 背包显示「纵横C」= 基础名「纵横」+ 品质码 C；图鉴按基础名登记，
 * 直接发「图鉴 纵横C」会匹配不到，所以发请求前先剥码。
 * 仅当剥完后名字确实变短才返回新名，否则原样返回（避免误伤名字本身以 E 结尾的物品）。
 */
function handbookQueryName(displayName) {
  const stripped = String(displayName || '').replace(/·[^·]+$/, '');
  const base = stripped.replace(/[EDCBASX]$/, '');
  return base && base !== stripped ? base : stripped;
}

/**
 * 剥掉 content 顶部连续的系统横幅行。
 * dispatch 会把离线结算/状态提示前插到指令结果开头：
 *   ⏰ 你离开了 1 分 47 秒
 *   【活力快满了:102/102】
 *   ━━━━━━━━━━━━━━━
 *   （真正的指令结果…）
 * 悬浮图鉴弹层只关心指令结果本身，横幅挤占弹层空间且造成困惑。
 * 只从开头连续剥离，遇到第一行非横幅即停 —— 正文中部的【…】/━━ 不受影响。
 */
function stripLeadingBanners(text) {
  const lines = String(text || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '' || /^⏰\s/.test(t) || /^【.+】$/.test(t) || /^━+$/.test(t)) {
      i++;
    } else {
      break;
    }
  }
  return lines.slice(i).join('\n');
}

function parseLayout(text) {
  if (!text) return null;
  const lines = String(text)
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '');

  // ---------- 1. 背包：🎒 背包 (N种): + "1. xxx ×N"（标题可能在行中，需扫描定位） ----------
  const bagIdx = lines.findIndex((l) => /^🎒\s*背包\s*\(\d+(?:种)?\)/.test(l));
  if (bagIdx >= 0) {
    const items = [];
    for (const line of lines.slice(bagIdx + 1)) {
      const t = line.trim();
      if (isBannerLine(t)) continue; // 横幅通知非物品，不显示
      // 序号 idx 与后端「背包」列表的 index+1、「装备 N」的解序号一致，必须原样保留供对号
      const m = t.match(/^(\d+)\.\s*(.+?)\s*×\s*([\d.]+)\s*$/);
      if (m) {
        items.push({ idx: m[1], name: m[2].trim(), count: m[3], kind: classifyItemKind(m[2].trim()) });
      } else {
        const pm = t.match(/^(\d+)\.\s*(.+)$/);
        if (pm) {
          const plain = pm[2].trim();
          if (plain) items.push({ idx: pm[1], name: plain, count: null, kind: classifyItemKind(plain) });
        }
      }
    }
    if (items.length) {
      return { kind: 'bag', title: `🎒 背包 (${items.length}种)`, items };
    }
  }

  // ---------- 2. 属性面板：【名字】Lv.N 标题 + 属性行 + 📋 装备 区块 ----------
  const titleIdx = lines.findIndex((l) => /^【.+】\s*Lv\.?\d+/i.test(l));
  if (titleIdx >= 0 && lines.some((l) => l.includes('📋 装备'))) {
    const stats = [];
    let equip = [];
    const banners = [];
    let equipMode = false;
    const slotSet = new Set(['头部', '饰品', '肩膀', '上身', '背部', '手臂', '手掌', '腰部', '下身', '腿环', '腿部', '脚部', '武器', '植入', '增幅', '背上']);

    for (const raw of lines.slice(titleIdx + 1)) {
      const t = raw.trim();
      if (!t) continue;
      if (isBannerLine(t)) { banners.push(t); continue; } // 【…】系统横幅通知收集到展示位
      if (/^━+$/.test(t)) continue; // 分隔线跳过
      if (t.startsWith('📋 当前任务') || t.startsWith('✨ 增益')) { equipMode = false; continue; }
      if (t.startsWith('📋 装备')) { equipMode = true; continue; }

      if (equipMode) {
        // 装备行："头部: 传说 动力头盔(+0)" / "武器: 无(+0)"
        const em = t.match(/^([^:：]+)[:：]\s*(.+)$/);
        if (em && slotSet.has(em[1])) {
          const val = em[2].trim().replace(/\(\+?\d+\)$/, ''); // 去掉 (+强化)
          // 默认武器「普通 拳头」视为未装备（与 backend 的占位一致）
          const has = !/^(无|普通\s*无|普通\s*拳头)$/.test(val);
          // 品质 = 值首词（普通/良好/优秀/精良/史诗/传说/神迹），用于格子描边着色
          const firstWord = val.split(/\s+/)[0] || '';
          const quality = QUALITY_SET.has(firstWord) ? firstWord : '';
          equip.push({ slot: em[1], text: val || '无', has, quality });
        } else if (t && equip.length) {
          // 背上备用武器等多行同属一格 → 追加到上一格
          const last = equip[equip.length - 1];
          last.text = `${last.text} ${t}`;
          last.has = true;
        }
        continue;
      }

      // 属性行："❤️ HP: 123/456" / "⚔️ 攻击: 99"（标签可能含空格，按第一个冒号切分）
      const ci = t.indexOf('：');
      const ce = t.indexOf(':');
      let cut = -1;
      if (ci === -1 && ce === -1) continue;
      if (ce === -1) cut = ci;
      else if (ci === -1) cut = ce;
      else cut = Math.min(ci, ce);
      const head = t.slice(0, cut).trim();
      const value = t.slice(cut + 1).trim();
      if (!head || !value) continue;
      if (/^📋/.test(head)) continue; // 排除「📋」区块标题行混入属性
      const iconMatch = head.match(/^(\p{Extended_Pictographic})(?:[\uFE0F\u200D\u{20E3}-\u{1F9E0}]*)?\s*(.*)$/u);
      const icon = iconMatch ? iconMatch[1] + (iconMatch[0].includes('\uFE0F') ? '\uFE0F' : '') : (head.charAt(0) || '·');
      const label = iconMatch ? iconMatch[2].trim() : head;
      stats.push({ icon, label: label || head, value });
    }
    if (stats.length) {
      return { kind: 'profile', title: lines[titleIdx], stats, equip, banners };
    }
  }

  return null;
}
</script>

<style scoped>
.rich-card { width: 100%; min-width: 0; }
.rc-title { font-weight: 700; color: var(--accent); margin-bottom: 8px; font-size: 14px; }
.rc-subtitle { font-weight: 600; color: var(--accent2); margin: 10px 0 6px; font-size: 13px; }
/* 属性面板两栏布局：左=属性卡片，右=装备网格（窄屏自动坍缩为单列） */
.rc-cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.rc-cols-stats,
.rc-cols-equip { min-width: 0; }
.rc-stats {
  /* 左栏「一竖条」：每行一条属性，逐行向下排列 */
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: left;
}
.rc-stat {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  border: 1px solid rgba(139, 92, 246, 0.15);
  min-width: 0;
}
.rc-icon { font-size: 13px; flex-shrink: 0; }
.rc-label { font-size: 12px; color: var(--muted); white-space: nowrap; }
.rc-value { font-size: 13px; font-weight: 600; margin-left: auto; white-space: nowrap; }
.rc-grid {
  /* 背包 → 自适应标签流：flex-wrap 让每个标签按内容宽度单行显示，
     放不下自动换到下一行，天然不会横向溢出卡片边界，也不截断。 */
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  text-align: left;
}
.rc-cell {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  border: 1px solid rgba(139, 92, 246, 0.12);
  font-size: 12px;
  min-width: 0;
}
/* 背包格子改为可交互：悬浮高亮 + 点击反馈（发送装备指令） */
  .rc-cell-item {
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
  }
  .rc-cell-item:hover {
    background: rgba(139, 92, 246, 0.16);
    border-color: rgba(139, 92, 246, 0.5);
  }
  .rc-cell-item:active {
    transform: scale(0.96);
  }
  /* 非装备（资源/消耗品）格子：只显示、不可点。鼠标停留仍可触发图鉴弹层（查看说明），
     但 cursor 显示默认箭头 + 不再有 hover 高亮，避免误以为可点击。 */
  .rc-cell-item.rc-cell-use {
    cursor: default;
  }
  .rc-cell-item.rc-cell-use:hover {
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(139, 92, 246, 0.12);
  }

/* ===== 系统横幅展示位（属性左栏底部，可开关） ===== */
.rc-banner-wrap {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed rgba(139, 92, 246, 0.2);
}
.rc-banner-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.rc-banner-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent2);
}
.rc-banner-toggle {
  border: none;
  background: rgba(139, 92, 246, 0.15);
  color: var(--accent);
  width: 18px;
  height: 18px;
  line-height: 1;
  border-radius: 50%;
  cursor: pointer;
  font-size: 14px;
  padding: 0;
}
.rc-banner-toggle:hover {
  background: rgba(139, 92, 246, 0.3);
}
.rc-banners {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
}
.rc-banner {
  font-size: 12px;
  color: var(--muted);
  background: rgba(250, 204, 21, 0.06);
  border: 1px solid rgba(250, 204, 21, 0.14);
  border-radius: 8px;
  padding: 4px 8px;
}

/* ===== 悬浮图鉴弹层：仿浏览器原生 title 的紧凑 tips ===== */
.rc-handbook {
  position: fixed;
  z-index: 99999;
  /* 自适应内容宽度，上限 300px；最小 240px，避免短文本（如「暂无资料」）塌缩成不可见 */
  width: max-content;
  min-width: 240px;
  max-width: 300px;
  max-height: 260px;
  display: flex;
  flex-direction: column;
  background: rgba(24, 18, 38, 0.94);
  border: 1px solid rgba(139, 92, 246, 0.35);
  border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  overflow: hidden;
  /* 鼠标事件穿透：弹层不会抢到焦点，
     从而避免鼠标在「格子」与「弹层」间移动时反复 enter/leave 导致的闪烁 */
  pointer-events: none;
}
.rc-hb-body {
  padding: 6px 9px;
  font-size: 12px;
  line-height: 1.55;
  overflow: auto;
  color: var(--text);
}
.rc-hb-content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}
.rc-hb-loading { color: var(--muted); }
.rc-hb-error { color: #f87171; }
.rc-name {
  color: var(--muted);
  /* 不换行：单行完整显示（标签宽度随内容自适应） */
  white-space: nowrap;
}
/* 背包物品序号格：放在名字左侧、弱化显示，便于肉眼对应「装备 N」指令 */
.rc-idx {
  flex-shrink: 0;
  min-width: 16px;
  text-align: center;
  color: var(--muted-dark, #7b7484);
  font-size: 11px;
  font-weight: 600;
  background: rgba(139, 92, 246, 0.08);
  padding: 0 4px;
  border-radius: 4px;
  line-height: 1.4;
}
.rc-count { color: var(--accent2); font-weight: 600; flex-shrink: 0; }

/* ===== 装备区（右栏「一竖条」：每格一行，逐行向下，按品质描边） ===== */
.rc-equip-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
  text-align: left;
}
.rc-eqcell {
  /* 单行紧凑：部位标签 + 装备名并排（同左侧侧边栏 pi-eq 样式），省垂直空间 */
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 3px 8px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  border: 1px solid rgba(139, 92, 246, 0.12);
  font-size: 12px;
  min-width: 0;
}
/* 空装备格：整体弱化（半透明 + 虚线），与已装备格明显区分 */
.rc-eqcell.rc-empty {
  opacity: 0.5;
  background: transparent;
  border-style: dashed;
  border-color: rgba(139, 92, 246, 0.2);
}
.rc-eqcell.rc-empty .rc-slot {
  background: rgba(139, 92, 246, 0.08);
  color: var(--muted-dark, #7b7484);
}
.rc-eq-name {
  color: var(--muted);
  /* 单行展示，与左侧侧边栏装备一致 */
  white-space: nowrap;
}
.rc-slot {
  flex-shrink: 0;
  color: var(--accent);
  font-weight: 600;
  background: rgba(139, 92, 246, 0.14);
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
}
.rc-none { opacity: 0.6; font-style: italic; }
.rc-raw { white-space: pre-line; font-size: 14px; line-height: 1.6; }
@media (max-width: 640px) {
  /* 窄屏：两栏坍缩为单列（属性在上、装备在下），各自仍为单列竖条 */
  .rc-cols { grid-template-columns: 1fr; }
}
</style>