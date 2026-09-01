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
    <!-- 背包 → 物品网格 -->
    <div v-if="layout && layout.kind === 'bag'" class="rc-bag">
      <div class="rc-title">{{ layout.title }}</div>
      <div class="rc-grid">
        <div v-for="(row, i) in layout.items" :key="i" class="rc-cell">
          <span class="rc-name" :title="row.name">{{ row.name }}</span>
          <span v-if="row.count != null" class="rc-count">×{{ row.count }}</span>
        </div>
      </div>
    </div>

    <!-- 属性面板 → 两栏：左列属性卡片 + 右列装备网格 -->
    <div v-else-if="layout && layout.kind === 'profile'" class="rc-profile">
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

    <!-- 识别失败 → 原样直出文本（兜底） -->
    <div v-else class="rc-raw" style="white-space: pre-line">{{ text }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

/**
 * Props：text 为服务端下发的原始消息文本（含换行）
 */
const props = defineProps({
  text: { type: String, default: '' },
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
      const m = t.match(/^(\d+)\.\s*(.+?)\s*×\s*([\d.]+)\s*$/);
      if (m) {
        items.push({ name: m[2].trim(), count: m[3] });
      } else {
        const plain = t.replace(/^\d+\.\s*/, '');
        if (plain) items.push({ name: plain, count: null });
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
    let equipMode = false;
    const slotSet = new Set(['头部', '饰品', '肩膀', '上身', '背部', '手臂', '手掌', '腰部', '下身', '腿环', '腿部', '脚部', '武器', '植入', '增幅', '背上']);

    for (const raw of lines.slice(titleIdx + 1)) {
      const t = raw.trim();
      if (!t) continue;
      if (isBannerLine(t)) continue; // 【…】系统横幅通知（训练器/凭证解锁提示），不并入属性或装备
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
      return { kind: 'profile', title: lines[titleIdx], stats, equip };
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
.rc-name {
  color: var(--muted);
  /* 不换行：单行完整显示（标签宽度随内容自适应） */
  white-space: nowrap;
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