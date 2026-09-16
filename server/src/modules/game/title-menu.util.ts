/**
 * 称号「查看可领取称号」列表渲染（纯函数，无副作用）。
 *
 * 对应原版编号菜单惯例（原版 _主程序.ecode L10520-10553）：玩家直接回复数字领取对应称号。
 * 本文件只负责「分组数据 → 文本 + 编号注册项」这一步；进度计算与系列归组仍在
 * FamiliarSystemService.viewAvailableTitles 完成（数据归数据、版式归版式）。
 *
 * 2026-09-15 可读性重排（玩家反馈「提示有 N 个可领，却看不出是哪几个」）：
 * 旧版把「已达成」标记 ✦ 放在每行行尾，混在进度文本里基本看不见；新版拆成两个区块——
 *  - 「✅ 现在就能领」：所有已达成项置顶，行首 ✅ + 独立编号，领奖入口一眼可见；
 *  - 「⏳ 下一阶进度」：每系列只展开首个未达成阶位，组头展示当前值/目标值/进度条；
 * 顶部汇总行还会直接点名可领取的称号（超过配置上限时折算为「…（共 N 个）」）。
 */

import { formatDamageText, formatSecondsDurationText } from '../../common/utils/game-text.util';

/** 消息线框分隔线（与其余游戏消息同一套字符） */
export const TITLE_DIVIDER = '━━━━━━━━━━━━━━━';
/** 列表标题（渲染时拼上「（未拥有数/总数）」） */
export const TITLE_LIST_LABEL = '📜 可领取的称号';
/** 「现在就能领」区块标题 */
export const TITLE_READY_LABEL = '✅ 现在就能领（回复编号直接领取）：';
/** 「下一阶进度」区块标题 */
export const TITLE_NEXT_LABEL = '⏳ 下一阶进度（达成后自动移到上方）：';
/** 一个都没达成时的鼓励语 */
export const TITLE_NONE_READY_HINT = '暂无条件达成的称号，继续加油';
/** 所有称号均已持有的终态文案 */
export const TITLE_ALL_OWNED_TEXT = '所有称号均已领取 ✅';
/** 领取方式脚注 */
export const TITLE_FOOTER = '发送编号即可快速领取，或使用「领取称号 称号名」';
/** 已拥有称号列表的佩戴方式脚注 */
export const OWNED_TITLE_FOOTER = '发送编号即可快速佩戴，或使用「佩戴称号 称号名」；发送「佩戴称号取消」可摘下称号';
/** 已拥有称号列表的一行双列个数 */
export const OWNED_TITLE_PER_LINE = 2;

/** 单个称号条目（进度在数据装配阶段已算好） */
export interface TitleEntryView {
  /** 称号名（原版 titles.json 的 name） */
  name: string;
  /** 各要求的进度子串：要求名(当前/要求值)，多条件以全角空格连接 */
  reqTexts: string[];
  /** 是否全部要求已达成（达成即进入「现在就能领」区块） */
  ready: boolean;
  /** 首个要求的目标值：组内按阶梯升序（I→X）排序用 */
  firstNeed: number;
}

/** 同一系列（称号名去罗马数字阶位 + 同一要求名）的称号组 */
export interface TitleSeriesGroupView {
  /** 系列名（肝帝II → 肝帝） */
  seriesName: string;
  /** 系列要求名（组头展示当前值，取首条要求） */
  reqName: string;
  /** 系列当前进度原始值（组头进度条，取首条要求） */
  current: number;
  /** 未拥有的全部阶位（含不展开的高阶位，用于判定「下一阶」） */
  entries: TitleEntryView[];
}

/** 渲染入参 */
export interface AvailableTitlesRenderOptions {
  /** 原版称号总数（标题分母） */
  totalCount: number;
  /** 未拥有称号总数（标题分子，含未展开的高阶位） */
  availableCount: number;
  /** 顶部汇总最多点名的可领取称号数量（超出折算「…（共 N 个）」） */
  readySummaryNameLimit: number;
}

/** 渲染结果 */
export interface AvailableTitlesRenderResult {
  /** 最终消息文本 */
  text: string;
  /** 按展示顺序的 `编号@领取称号 称号名` 注册项（ShortcutService 临时输入用） */
  shortcutEntries: string[];
  /** 已达成可领取的数量 */
  readyCount: number;
}

/**
 * 进度值展示：在线时间用时分秒，其余走通用数值格式化。
 * @param reqName 要求名（titles.json 里的 name）
 * @param value 原始数值
 */
export function formatTitleProgress(reqName: string, value: number): string {
  return reqName === '在线时间' ? formatSecondsDurationText(value) : formatDamageText(value);
}

/**
 * 5 格迷你进度条 + 百分比（封顶 100%）。
 * @param current 当前值
 * @param need 目标值
 */
export function buildTitleMiniBar(current: number, need: number): string {
  const ratio = need > 0 ? Math.min(1, current / need) : 1;
  const filled = Math.round(ratio * 5);
  return `${'▰'.repeat(filled)}${'▱'.repeat(5 - filled)} ${Math.floor(ratio * 100)}%`;
}

/** 已排定编号的展示项（编号在渲染阶段统一发放） */
interface PlannedEntry {
  no: number;
  group: TitleSeriesGroupView;
  entry: TitleEntryView;
}

/**
 * 渲染「查看可领取称号」列表。
 *
 * 编号发放规则：先给所有已达成项发号并置顶（组顺序 → 组内阶梯升序），再给各系列的
 * 「下一阶」发号；编号连续且与展示顺序一致，玩家回复编号即触发对应「领取称号 称号名」。
 *
 * @param groups 未拥有称号的系列分组（数据装配结果）
 * @param options 标题统计与展示阈值
 */
export function renderAvailableTitles(
  groups: TitleSeriesGroupView[],
  options: AvailableTitlesRenderOptions,
): AvailableTitlesRenderResult {
  const readyPlanned: PlannedEntry[] = [];
  const nextPlanned: PlannedEntry[] = [];
  let no = 0;

  // 第一轮：组内排序并确定「下一阶」，同时给已达成项发号（置顶区块的编号最小）
  const nextOf: Array<{ group: TitleSeriesGroupView; next?: TitleEntryView }> = [];
  for (const group of groups) {
    // 组内按门槛升序（I→X 阶梯）；同门槛按名称排序，保证编号可预期（不改动原数组）
    const sorted = [...group.entries].sort(
      (a, b) => a.firstNeed - b.firstNeed || a.name.localeCompare(b.name, 'zh'),
    );
    // 展开口径：已达成待领取的全部保留 + 首个未达成的「下一阶」；更高阶位由组头与顶部汇总概括
    nextOf.push({ group, next: sorted.find((e) => !e.ready) });
    for (const entry of sorted) {
      if (entry.ready) readyPlanned.push({ no: ++no, group, entry });
    }
  }
  // 第二轮：再给各系列「下一阶」续号——编号严格跟随展示顺序（可领区块 → 进度区块）
  for (const { group, next } of nextOf) {
    if (next) nextPlanned.push({ no: ++no, group, entry: next });
  }

  const readyCount = readyPlanned.length;
  const lines: string[] = [`${TITLE_LIST_LABEL}（${options.availableCount}/${options.totalCount}）`];

  // 顶部汇总：直接点名可领取的称号——玩家最先看这一行，一眼知道"哪几个能领"
  if (readyCount > 0) {
    const names = readyPlanned.map((p) => p.entry.name);
    const limit = Math.max(1, Math.floor(options.readySummaryNameLimit) || 1);
    const shown =
      names.length > limit
        ? `${names.slice(0, limit).join('、')} …（共 ${names.length} 个）`
        : names.join('、');
    lines.push(`✅ ${readyCount} 个条件已达成可领取：${shown}`);
  } else if (nextPlanned.length > 0) {
    lines.push(TITLE_NONE_READY_HINT);
  }
  lines.push(TITLE_DIVIDER);

  // 区块一：可立即领取（置顶，行首 ✅ 便于扫读；旧版行尾 ✦ 玩家根本找不到）
  if (readyCount > 0) {
    lines.push(TITLE_READY_LABEL);
    for (const p of readyPlanned) {
      lines.push(`✅ ${p.no}、${p.entry.name}　${p.entry.reqTexts.join('　')}`);
    }
    if (nextPlanned.length > 0) lines.push(TITLE_DIVIDER);
  }

  // 区块二：下一阶进度（每系列一行组头 + 一行下一阶，组头给当前值/目标值/进度条）
  if (nextPlanned.length > 0) {
    lines.push(TITLE_NEXT_LABEL);
    for (const p of nextPlanned) {
      const { group, entry } = p;
      lines.push(
        `▎${group.seriesName} · ${group.reqName}：当前 ${formatTitleProgress(group.reqName, group.current)}` +
          ` ｜下一阶需 ${formatTitleProgress(group.reqName, entry.firstNeed)}　${buildTitleMiniBar(group.current, entry.firstNeed)}`,
      );
      lines.push(` ${p.no}、${entry.name}　${entry.reqTexts.join('　')}`);
    }
    lines.push(TITLE_DIVIDER);
  }

  // 脚注：有可领编号才提示领取方式；一个都没展开说明全部到手
  lines.push(no > 0 ? TITLE_FOOTER : TITLE_ALL_OWNED_TEXT);

  return {
    text: lines.join('\n'),
    // readyPlanned 与 nextPlanned 的编号严格递增且前者在前，合并即得连续编号序列
    shortcutEntries: [...readyPlanned, ...nextPlanned].map((p) => `${p.no}@领取称号 ${p.entry.name}`),
    readyCount,
  };
}

// ==================== 已拥有称号列表（使魔称号） ====================

/** 已拥有称号条目（历史字符串形状由调用方先归一） */
export interface OwnedTitleItem {
  name: string;
  equipped: boolean;
}

/** 已拥有称号渲染结果 */
export interface OwnedTitlesRenderResult {
  text: string;
  /** 按展示顺序的 `编号@佩戴称号 称号名` 注册项 */
  shortcutEntries: string[];
}

/** 罗马数字阶位 → 阿拉伯序号（用于同系列取最高等级；无阶位视为 1） */
export function titleTierRank(name: string): number {
  const map: Record<string, number> = {
    I: 1,
    II: 2,
    III: 3,
    IV: 4,
    V: 5,
    VI: 6,
    VII: 7,
    VIII: 8,
    IX: 9,
    X: 10,
  };
  const matched = name.match(/(IX|IV|VI{0,3}|I{1,3}|X|V)$/);
  return matched ? map[matched[1]] || 1 : 1;
}

/** 系列名 = 称号名去掉尾部罗马数字阶位（肝帝II → 肝帝；住这了IX → 住这了） */
export function titleSeriesName(name: string): string {
  return name.replace(/(?:IX|IV|VI{0,3}|I{1,3}|X|V)$/, '').trim() || name;
}

/**
 * 渲染「使魔称号」已拥有列表。
 * 同一系列默认只保留最高等级；若当前佩戴的是该系列的非最高阶，一并保留佩戴项
 * （否则 ✅ 会消失，玩家找不到自己在戴什么）。编号与展示顺序一致；一行双列压缩高度。
 * @param playerName 已佩戴称号后的派生显示名（列表标题用）
 * @param titles 已拥有称号（含佩戴状态）
 */
export function renderOwnedTitles(playerName: string, titles: OwnedTitleItem[]): OwnedTitlesRenderResult {
  // 按系列折叠：最高阶必留；佩戴中的低阶额外保留
  const bySeries = new Map<string, OwnedTitleItem[]>();
  for (const title of titles) {
    const series = titleSeriesName(title.name);
    const bucket = bySeries.get(series);
    if (bucket) bucket.push(title);
    else bySeries.set(series, [title]);
  }

  const kept: OwnedTitleItem[] = [];
  for (const bucket of bySeries.values()) {
    let highest = bucket[0];
    for (const title of bucket) {
      if (titleTierRank(title.name) > titleTierRank(highest.name)) highest = title;
    }
    kept.push(highest);
    for (const title of bucket) {
      if (title.equipped && title.name !== highest.name) kept.push(title);
    }
  }

  // 佩戴中的置顶，其余按系列出现顺序，便于一眼找到当前称号
  kept.sort((a, b) => Number(b.equipped) - Number(a.equipped));

  const lines = [`${playerName} 的称号列表`, TITLE_DIVIDER];
  const shortcutEntries: string[] = [];
  let no = 0;
  for (let i = 0; i < kept.length; i += OWNED_TITLE_PER_LINE) {
    const cells = kept
      .slice(i, i + OWNED_TITLE_PER_LINE)
      .map((title) => {
        no += 1;
        shortcutEntries.push(`${no}@佩戴称号 ${title.name}`);
        return `${no}、${title.equipped ? '✅' : ''}${title.name}`;
      });
    lines.push(cells.join('  '));
  }
  lines.push(TITLE_DIVIDER);
  lines.push(OWNED_TITLE_FOOTER);

  return { text: lines.join('\n'), shortcutEntries };
}
