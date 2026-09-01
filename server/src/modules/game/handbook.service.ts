/**
 * 图鉴服务（HandbookService）
 * ------------------------------------------------------------------
 * 对齐原版易语言：数据显示.ecode L2632-3742 子程序 使魔图鉴。
 *
 * 原版行为：分类总览 → 类目列表 / 跨分类关键词搜索 → 单条详情。
 * 每条详情按各分类原版写法（L2970-3530）逐段输出：基础信息、伤害属性、好感 N 解锁链、
 * 技能等级替换、词条池展开、采集产出(基础+玩家倍率)、通道/怪物/资源/复活点、特效编号(调试用)、
 * 毛发来源等。
 *
 * 与原版的差异说明：
 *   - 原版每条详情开头调用 `取图片(输入)` 群发内嵌图片。新版已确认无需群内嵌图，纯文本输出。
 *   - 玩家.名称 前缀沿用原版习惯输出「玩家名 + 换行 + 条目内容」。
 */

import { Injectable, Logger } from '@nestjs/common';
import { StaticDataService } from './static-data.service';
import { ShortcutService } from './shortcut.service';
import { LINE_BREAK_MARKER } from '../../common/utils/game-text.util';
import { asJsonValue } from '../../common/utils/json-value.util';

// ---------- 纯函数工具 ----------

/** 数字四舍五入后输出（仿原版 文本四舍） */
function roundText(n: unknown): string {
  const v = Number(n);
  if (Number.isNaN(v)) return '0';
  return String(Math.round(v));
}

/** 数字保留整数或小数 */
function fmt2(n: unknown): string {
  const v = Number(n);
  if (Number.isNaN(v)) return '0';
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

/** 数字保留 1 位小数 */
function fmt1(n: unknown): string {
  const v = Number(n);
  if (Number.isNaN(v)) return '0';
  return (Math.round(v * 10) / 10).toString();
}

/** 仿原版 加括号：圆括号 */
function paren(s: string): string {
  return `（${s}）`;
}

/** 仿原版 加中括号：方头括号 */
function bracket(s: string): string {
  return `【${s}】`;
}

/** 仿原版 加引号：弯引号 */
function quote(s: string): string {
  return `“${s}”`;
}

/** JSON 数组解析，失败返回空 */
function parseArr(raw: unknown): any[] {
  const v = asJsonValue<any>(raw, []);
  return Array.isArray(v) ? v : [];
}

/** JSON 对象解析，失败返回默认 */
function parseObj(raw: unknown, def: any = {}): Record<string, any> {
  const v = asJsonValue<Record<string, any>>(raw, def);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : def;
}

/** 仿原版 显示加成：key=bonus JSON，onlyNonZero=true 时仅输出非零项 */
function renderBonus(bonus: Record<string, any>, onlyNonZero = false): string {
  if (!bonus || typeof bonus !== 'object') return '';
  const lines: string[] = [];
  for (const [k, v] of Object.entries(bonus)) {
    const n = Number(v) || 0;
    if (onlyNonZero && n === 0) continue;
    const sign = n > 0 ? '+' : '';
    lines.push(`${k}${sign}${fmt2(n)}`);
  }
  return lines.length ? `加成:${lines.join('、')}` : '';
}

/** 把 "#换行" 替换为真实换行 */
function nl(s: string | undefined | null): string {
  if (!s) return '';
  return String(s).split(LINE_BREAK_MARKER).join('\n');
}

/** 切成行（保留顺序） */
function lines(s: string | undefined | null): string[] {
  if (!s) return [];
  return String(s).split(LINE_BREAK_MARKER).map((p) => p.trim()).filter(Boolean);
}

/** 切分字符串 */
function splitText(s: string | undefined | null, sep: string): string[] {
  if (!s) return [];
  return String(s).split(sep);
}

function contains(haystack: string, needle: string): boolean {
  return !!haystack && !!needle && haystack.includes(needle);
}

/** 让概率这类数值展示成百分比 */
function pct(n: unknown, def = 100): string {
  const v = Number(n);
  return Number.isNaN(v) ? `${def}%` : `${v}%`;
}

// ---------- 装备词条池展开（原版 L3023-3028） ----------

const AFFIX_POOL_EXPANSIONS: Record<string, string> = {
  随机护盾: '护盾,攻击,物攻,冰攻,火攻,电攻,护盾全抗,护盾物抗,护盾冰抗,护盾火抗,护盾电抗,护盾回复',
  随机装甲: '装甲,攻击,物攻,冰攻,火攻,电攻,装甲全抗,装甲物抗,装甲冰抗,装甲火抗,装甲电抗,装甲修复',
  随机生命: '生命,攻击,物攻,冰攻,火攻,电攻,生命全抗,生命物抗,生命冰抗,生命火抗,生命电抗,生命恢复',
  随机攻击: '护盾,装甲,生命,攻击,物攻,冰攻,火攻,电攻,护盾全抗,装甲全抗,生命全抗,速度,命中,闪避',
  随机防御: '护盾,装甲,生命,生命全抗,护盾全抗,装甲全抗,生命物抗,生命冰抗,生命火抗,生命电抗,装甲物抗,装甲冰抗,装甲火抗,装甲电抗,护盾物抗,护盾冰抗,护盾火抗,护盾电抗,闪避,护盾回复,装甲修复,生命恢复',
  随机特殊: '暴击,速度,命中,闪避,掉落率,掉落数量,韧性,魅力',
};

/** 装备词条池展开：原版把"随机护盾/随机装甲..."展开为具体属性列表 */
function expandAffixPool(affixes: string[]): string {
  const expanded: Set<string> = new Set();
  for (const a of affixes) {
    const subs = (AFFIX_POOL_EXPANSIONS[a] ?? a).split(',').map((s) => s.trim()).filter(Boolean);
    for (const s of subs) expanded.add(s);
  }
  return Array.from(expanded).join('、');
}

// ---------- 技能等级替换（原版 数据显示.ecode L1801-1844） ----------

/** 把技能描述里的 【X技能等级】 替换为实际值 */
function subSkillLevel(text: string | undefined | null, skillLevel: number): string {
  if (!text || skillLevel <= 0) return String(text ?? '');
  let result = String(text);
  const repl = (literal: string, value: string | number) => {
    result = result.split(literal).join(String(value));
  };
  // 由大到小匹配避免误替
  repl('【10技能等级】', skillLevel * 10);
  repl('【5技能等级】', skillLevel * 5);
  repl('【4技能等级】', skillLevel * 4);
  repl('【3技能等级】', skillLevel * 3);
  repl('【2.5技能等级】', fmt1(skillLevel * 2.5));
  repl('【2技能等级】', skillLevel * 2);
  repl('【1技能等级】', skillLevel);
  repl('【0.75技能等级】', fmt1(skillLevel * 0.75));
  repl('【0.5技能等级】', skillLevel * 0.5);
  repl('【0.25技能等级】', fmt1(skillLevel * 0.25));
  repl('【0.2技能等级】', fmt1(skillLevel * 0.2));
  repl('【0.1技能等级】', fmt1(skillLevel * 0.1));
  repl('【0.05技能等级】', fmt2(skillLevel * 0.05));
  repl('【0.04技能等级】', fmt2(skillLevel * 0.04));
  repl('【0.03技能等级】', fmt2(skillLevel * 0.03));
  repl('【0.025技能等级】', fmt2(skillLevel * 0.025));
  repl('【0.02技能等级】', fmt2(skillLevel * 0.02));
  repl('【0.01技能等级】', fmt2(skillLevel * 0.01));
  repl('【0.005技能等级】', fmt4(skillLevel * 0.005));
  repl('【使魔等级x', '【等级x');
  return result;
}

function fmt4(n: number): string {
  return (Math.round(n * 10000) / 10000).toString();
}

/**
 * 科学计数法到文本（原版 科学计数法到文本）。
 * 小数值原样显示，达到万位起用指数形式（原版用于产出/消耗这类可能很大的数）。
 */
function sciText(n: unknown): string {
  const v = Number(n);
  if (Number.isNaN(v)) return '0';
  if (Math.abs(v) < 10000) return roundText(v);
  return v.toExponential(2);
}

// ---------- 原版两列菜单排版（L2654） ----------

/** 计算字符串的显示宽度：CJK/全角算 2，其余算 1 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of String(s)) {
    const code = ch.codePointAt(0) ?? 0;
    w += code > 0x2e80 ? 2 : 1;
  }
  return w;
}

/** 按显示宽度右补空格到指定宽度（用于两列菜单左列对齐） */
function padToWidth(s: string, width: number): string {
  const pad = Math.max(0, width - displayWidth(s));
  return s + ' '.repeat(pad);
}

/** 两列菜单左列的显示宽度：序号2 + "、"2 + 最长标签"对话文本"8 = 12，留 1 列余量 */
const MENU_COL_WIDTH = 13;

/**
 * 原版「图片资源」是 `使魔图片列表`（288 条）。新版未迁移图集数据，故为 0。
 * 与「音乐」一样属于数据缺失而非逻辑缺失，接口已留：迁移后改这里即可。
 */
const IMAGE_ASSET_COUNT = 0;

// ---------- 上下文 ----------

export interface HandbookContext {
  /** 玩家 ID（用来读取好感/技能标记） */
  userId: number;
  /** 玩家名称（原版 玩家.名称 前缀） */
  playerName: string;
  /** 玩家标志（用于跨分类搜索；可空） */
  markers?: any;
  /** 当前使魔名（用于读取好感/技能等级） */
  familiarName?: string;
  /** 当前使魔技能等级 */
  skillLevel?: number;
  /** 当前使魔的好感度（游戏内 player.type 当前的好感值） */
  affinity?: number;

  // ---- 以下仅怪物「详细数据」分支（图鉴X详细）用到，缺省按无加成计算 ----
  /** 玩家掉落率加成（%）——影响「掉落(你的加成)」的几率行 */
  playerDropRate?: number;
  /** 玩家掉落数量加成（%）——影响「掉落(你的加成)」的数量行 */
  playerDropQuality?: number;
  /** 是否持有「宝石缎带」（原版 L3215-3226 额外提升掉落几率） */
  hasGemRibbon?: boolean;
  /** 世界等级（对应原版 熟练度等级(全局标记,"世界")，来自 game.worldLevel 配置） */
  worldLevel?: number;
  /** 各怪物类型的熟练度等级（对应原版 熟练度等级(全局标记,怪物类型)） */
  monsterProficiency?: Record<string, number>;
}

// ---------- 分类键 ----------

/**
 * 图鉴分类键。
 * `craft`（制造）原版只在统计串里出现、菜单里没有入口，故单列一档。
 */
type CategoryKey =
  | 'familiar' | 'weapon' | 'equipment' | 'item' | 'resource' | 'map' | 'monster' | 'task'
  | 'buff' | 'building' | 'part' | 'title' | 'music' | 'equipEffect' | 'weaponEffect'
  | 'recipe' | 'image' | 'attackText' | 'dialogue' | 'wreck' | 'craft';

/**
 * 原版 数据显示.ecode L2654 菜单的 20 项（决定编号与展示顺序）。
 * 注意第 11 项原文是「部件」（统计串里才叫「载具部件」）。
 */
const CATEGORY_MENU: Array<{ key: CategoryKey; label: string }> = [
  { key: 'familiar', label: '使魔' },
  { key: 'weapon', label: '武器' },
  { key: 'equipment', label: '装备' },
  { key: 'resource', label: '资源' },
  { key: 'map', label: '地图' },
  { key: 'monster', label: '怪物' },
  { key: 'task', label: '任务' },
  { key: 'item', label: '物品' },
  { key: 'buff', label: '增益' },
  { key: 'building', label: '建筑' },
  { key: 'part', label: '部件' },
  { key: 'title', label: '称号' },
  { key: 'music', label: '音乐' },
  { key: 'equipEffect', label: '装备特效' },
  { key: 'weaponEffect', label: '武器特效' },
  { key: 'recipe', label: '配方' },
  { key: 'image', label: '图片' },
  { key: 'attackText', label: '攻击文本' },
  { key: 'dialogue', label: '对话文本' },
  { key: 'wreck', label: '废弃载具' },
];

/**
 * 原版 L2672-2965 的精确匹配扫描顺序。
 * **与菜单顺序不同**：装备排第 1、使魔第 2，攻击文本/对话文本垫底（且不支持模糊）。
 * 玩家输入完整名称时按此顺序找，命中即进入该分类的详情，不再做模糊搜索。
 */
const EXACT_SCAN_ORDER: CategoryKey[] = [
  'equipment', 'familiar', 'resource', 'map', 'monster', 'task', 'item', 'buff',
  'building', 'part', 'title', 'music', 'equipEffect', 'weaponEffect', 'image',
  'recipe', 'wreck', 'attackText', 'dialogue',
];

/** 「部件」在菜单里的标签，统计串里叫「载具部件」 */
const PART_LABEL_IN_MENU = '部件';

// ---------- 类目条目 ----------

interface HandbookEntry {
  name: string;
  brief?: string;
  detail?: string[];
}

interface CategoryEntry {
  title: string;
  entries: HandbookEntry[];
}

// ---------- 服务 ----------

@Injectable()
export class HandbookService {
  private readonly logger = new Logger(HandbookService.name);

  constructor(
    private readonly staticData: StaticDataService,
    private readonly shortcutService: ShortcutService,
  ) {}

  /**
   * 入口：与 game.service.handleHandbook 等价。
   *   无参                → 20 分类两列菜单 + 统计串（原版 L2654）
   *   图鉴载具            → 二级入口（核心/功能/武器/防御/行走，原版 L2655-2656）
   *   图鉴攻击文本/对话文本 → 列表（原版这两类不支持模糊搜索）
   *   图鉴<地点>附近      → 附近地图分组
   *   图鉴<分类名>        → 该分类列表
   *   图鉴<完整名称>      → **精确匹配优先**，直接进详情（原版 L2672-2965 扫描顺序）
   *   图鉴<关键词>        → 跨分类模糊搜索（原版 L2661 "X的图鉴搜索结果"）
   */
  async handle(arg: string | undefined | null, ctx: HandbookContext): Promise<string> {
    const query = String(arg ?? '').trim();
    // 当前玩家特有的渲染上下文：玩家姓名 + 当前使魔名/技能等级/好感值
    const renderCtx = ctx;

    if (!query) return this.renderOverview(ctx);
    if (query === '载具') return this.renderVehicleSubcategoryOverview(ctx);
    if (query === '攻击文本') return this.renderAttackTextList(ctx);
    if (query === '对话文本') return this.renderDialogueTextList(ctx);
    if (query.endsWith('附近')) {
      const placeName = query.slice(0, -'附近'.length).trim();
      if (!placeName) return `请在「附近」前输入地点名，如：图鉴医疗室附近`;
      return this.renderNearby(placeName, ctx);
    }

    // 「<名称>详细」= 原版 L2668-2671 的 g1 标记：仅怪物分类支持，走详细数据分支。
    if (query.length > '详细'.length && query.endsWith('详细')) {
      const monsterName = query.slice(0, -'详细'.length).trim();
      const monster = this.rawList('monster').find((m) => m?.name === monsterName);
      if (monster) return this.renderMonsterDetail(monster, renderCtx).join('\n');
      // 不是怪物名 → 落回常规流程（按原版：g1 只影响怪物分支的渲染，不改变匹配）
    }

    const sections = this.buildSections(renderCtx);
    const sec = sections.find((s) => s.title === query);
    if (sec) return this.renderCategoryList(sec);

    // 精确名称优先（原版 L2672-2965）：按固定分类顺序找同名条目，命中直接渲染详情。
    // 这是「图鉴花园猫」应当直达使魔详情、而不是返回 9 条模糊结果的关键。
    const exact = this.findExactByName(query, renderCtx);
    if (exact) return (exact.detail ?? []).join('\n');

    // 跨分类模糊搜索
    return this.renderSearch(query, sections);
  }

  /**
   * 按原版扫描顺序做**精确名称**匹配。
   * 原版：一旦某分类里出现「名称 == 输入」的条目就 `已找到 = N` 并跳出，用该分类渲染详情；
   *       只有全部分类都没精确命中时，才走模糊搜索累加 b。
   * @returns 命中条目的详情行数组，未命中返回 null
   */
  private findExactByName(name: string, ctx: HandbookContext): HandbookEntry | null {
    for (const key of EXACT_SCAN_ORDER) {
      const entry = this.lookupEntry(key, name, ctx);
      if (entry) return entry;
    }
    return null;
  }

  /** 在单个分类里按名称精确取条目（含详情渲染），供精确匹配与列表复用 */
  private lookupEntry(key: CategoryKey, name: string, ctx: HandbookContext): HandbookEntry | null {
    const raw = this.rawList(key).find((r) => this.entryName(key, r) === name);
    if (!raw) return null;
    return this.buildEntry(key, raw, ctx);
  }

  // ============================================================
  // 总览 / 类目列表 / 附近
  // ============================================================

  /**
   * 分类总览：对齐原版 数据显示.ecode L2654。
   *
   * 原版输出结构：
   *   玩家名 + "请选择分类"
   *   两列编号菜单（20 项，编号写入临时输入替换）
   *   "或者你可以" + 引号("图鉴腰部") + "来搜索"
   *   "当前:使魔31,武器和装备348,资源119,..."（20 项统计，口径与菜单不完全相同）
   */
  private renderOverview(ctx: HandbookContext): string {
    const menuRows: string[] = [];
    const shortcuts: string[] = [];

    for (let i = 0; i < CATEGORY_MENU.length; i += 2) {
      const left = CATEGORY_MENU[i];
      const right = CATEGORY_MENU[i + 1];
      // 序号右对齐 2 位，与原版 " 1、" / "11、" 一致
      const leftText = `${String(i + 1).padStart(2, ' ')}、${left.label}`;
      let row = padToWidth(leftText, MENU_COL_WIDTH);
      if (right) {
        row += ` ${String(i + 2).padStart(2, ' ')}、${right.label}`;
      }
      menuRows.push(row);
      shortcuts.push(`${i + 1}@图鉴${left.label}`);
      if (right) shortcuts.push(`${i + 2}@图鉴${right.label}`);
    }

    void this.shortcutService.setTempInput(ctx.userId, shortcuts.join('#'));

    return [
      `${ctx.playerName}请选择分类`,
      ...menuRows,
      `或者你可以${quote('图鉴腰部')}来搜索`,
      this.renderStatsLine(),
    ].join('\n');
  }

  /**
   * 统计串：对齐原版 L2654 的 20 项与顺序。
   * 口径说明：
   *   - 「武器和装备」合并计数（菜单里分列，统计串里合一）
   *   - 「部件」在统计串里写作「载具部件」
   *   - 「制造」只在统计串出现（菜单无入口）
   *   - 「图片资源」原版为使魔图片列表 288，新版未迁移图集数据记 0
   */
  private renderStatsLine(): string {
    const n = (key: CategoryKey) => this.rawList(key).length;
    const parts = [
      `使魔${n('familiar')}`,
      `武器和装备${n('weapon') + n('equipment')}`,
      `资源${n('resource')}`,
      `地图${n('map')}`,
      `怪物${n('monster')}`,
      `任务${n('task')}`,
      `物品${n('item')}`,
      `增益${n('buff')}`,
      `攻击文本${n('attackText')}`,
      `对话文本${n('dialogue')}`,
      `制造${n('craft')}`,
      `建筑${n('building')}`,
      `载具部件${n('part')}`,
      `称号${n('title')}`,
      `音乐${n('music')}`,
      `武器特效${n('weaponEffect')}`,
      `装备特效${n('equipEffect')}`,
      `图片资源${IMAGE_ASSET_COUNT}`,
      `配方${n('recipe')}`,
      `废弃载具${n('wreck')}`,
    ];
    return `当前:${parts.join(',')}`;
  }

  private renderVehicleSubcategoryOverview(ctx: HandbookContext): string {
    const subs = ['核心', '功能', '武器', '防御', '行走'];
    const shortcuts = subs.map((s, i) => `${i + 1}@图鉴${s}部件`);
    void this.shortcutService.setTempInput(ctx.userId, shortcuts.join('#'));
    const lines: string[] = [
      `${ctx.playerName}请选择分类`,
      ...subs.map((s, i) => `${i + 1}、${s}部件`),
      '使用「图鉴」返回总览',
    ];
    return lines.join('\n');
  }

  private async renderAttackTextList(ctx: HandbookContext): Promise<string> {
    const rows: any[] = this.staticData.loadRaw('attackTexts');
    const names = rows.map((r) => r?.name).filter(Boolean);
    const shortcuts = names.map((n, i) => `${i + 1}@图鉴${n}`);
    await this.shortcutService.setTempInput(ctx.userId, shortcuts.join('#'));
    const lines: string[] = [
      `${ctx.playerName}${quote('攻击文本')}的图鉴搜索结果`,
      `━━━━━━━━━━━━━━━`,
    ];
    names.forEach((n, i) => lines.push(`${i + 1}、${n}`));
    lines.push(`━━━━━━━━━━━━━━━`, `使用「图鉴 完整名称」查看详情`);
    return lines.join('\n');
  }

  private async renderDialogueTextList(ctx: HandbookContext): Promise<string> {
    const rows: any[] = this.staticData.loadRaw('npcs');
    const names = rows.map((r) => r?.name).filter(Boolean);
    const shortcuts = names.map((n, i) => `${i + 1}@图鉴${n}对话`);
    await this.shortcutService.setTempInput(ctx.userId, shortcuts.join('#'));
    const lines: string[] = [
      `${ctx.playerName}${quote('对话文本')}的图鉴搜索结果`,
      `━━━━━━━━━━━━━━━`,
    ];
    names.forEach((n, i) => lines.push(`${i + 1}、${n}对话`));
    lines.push(`━━━━━━━━━━━━━━━`, `使用「图鉴 完整名称」查看详情`);
    return lines.join('\n');
  }

  private async renderNearby(placeName: string, ctx: HandbookContext): Promise<string> {
    const allMaps: any[] = this.staticData.loadRaw('maps');
    const nearby = allMaps.filter((mp) => String(mp.respawnPoint || mp.name) === placeName);
    if (nearby.length === 0) {
      return `图鉴中没有找到【${placeName}附近】\n使用「图鉴」查看所有分类`;
    }
    nearby.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    const lines = [`📖 【${placeName}】附近的地图 (${nearby.length}张):`, `━━━━━━━━━━━━━━━`];
    const shortcuts: string[] = [];
    nearby.forEach((mp, index) => {
      const tag = mp.isFrontier ? '（家园）' : mp.isInstance ? '（副本）' : '';
      lines.push(`${index + 1}、${mp.name}${tag}`);
      shortcuts.push(`${index + 1}@图鉴${mp.name}`);
    });
    lines.push(`━━━━━━━━━━━━━━━`, `使用「图鉴 地图名」查看地图详情`);
    await this.shortcutService.setTempInput(ctx.userId, shortcuts.join('#'));
    return lines.join('\n');
  }

  private renderCategoryList(section: CategoryEntry): string {
    const lines = [`📖 ${section.title}图鉴 (${section.entries.length}条):`, `━━━━━━━━━━━━━━━`];
    for (const e of section.entries) {
      const brief = e.brief ? ` - ${e.brief}` : '';
      lines.push(`${e.name}${brief}`);
    }
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`使用「图鉴 名称」查看详情，使用「图鉴」查看所有分类`);
    return lines.join('\n');
  }

  // ============================================================
  // 跨分类模糊搜索（原版 L2684-2965）
  // ============================================================

  private renderSearch(keyword: string, sections: CategoryEntry[]): string {
    const hits: Array<{ category: string; entry: HandbookEntry }> = [];
    for (const section of sections) {
      for (const entry of section.entries) {
        const hay = `${entry.name}|${entry.brief ?? ''}|${(entry.detail ?? []).join('|')}`;
        if (contains(hay, keyword)) {
          hits.push({ category: section.title, entry });
        }
      }
    }
    if (hits.length === 0) {
      return `图鉴中没有找到【${keyword}】\n使用「图鉴」查看所有分类`;
    }
    if (hits.length === 1) {
      const det = hits[0].entry.detail ?? [];
      return det.join('\n') || `${hits[0].category}:${hits[0].entry.name}\n${hits[0].entry.brief ?? ''}`;
    }
    if (hits.length > 30) {
      const lines = [
        `📖 【${keyword}】的图鉴搜索结果 (${hits.length}条，仅显示前30):`,
        `━━━━━━━━━━━━━━━`,
      ];
      for (const h of hits.slice(0, 30)) lines.push(`【${h.category}】${h.entry.name}`);
      lines.push(`━━━━━━━━━━━━━━━`, `请输入更完整的关键词缩小范围`);
      return lines.join('\n');
    }
    const lines = [`📖 【${keyword}】的图鉴搜索结果 (${hits.length}条):`, `━━━━━━━━━━━━━━━`];
    for (const h of hits) lines.push(`【${h.category}】${h.entry.name}`);
    lines.push(`━━━━━━━━━━━━━━━`, `使用「图鉴 完整名称」查看详情`);
    return lines.join('\n');
  }

  // ============================================================
  // 数据分组
  // ============================================================

  buildSections(ctx?: HandbookContext): CategoryEntry[] {
    const renderCtx: HandbookContext = ctx ?? { userId: 0, playerName: '' };
    return CATEGORY_MENU.map(({ key, label }) => ({
      title: label,
      entries: this.rawList(key).map((raw) => this.buildEntry(key, raw, renderCtx)),
    }));
  }

  // ---------- 统一数据访问 ----------

  /**
   * 取某分类的原始条目（已过滤配置模板行）。
   *
   * 模板行过滤规则：原版数据里每个数组首条往往是占位配置（"任务模板"/"增益模板"/
   * "建筑模板"/"载具模板"/"物品模板"/"对话模板"/"配方模板"）。原版运行时不计入
   * `取数组成员数`，故新版同样剔除——过滤后各分类条数与原版基线一致
   * （任务 86 / 增益 18 / 建筑 104 / 物品 169 / 对话 19 / 配方 94）。
   *
   * 例外：「制造」(craft) 原版统计包含占位行（426），故不过滤。
   */
  private rawList(key: CategoryKey): any[] {
    const noTemplate = (rows: any[]) => rows.filter((r) => !/模板$/.test(String(r?.name ?? '')));
    switch (key) {
      case 'familiar':
        return this.staticData.getAllFamiliars().slice();
      case 'weapon':
        return this.staticData.getAllEquipments().filter((e) => this.staticData.isWeapon(e));
      case 'equipment':
        return this.staticData.getAllEquipments().filter((e) => !this.staticData.isWeapon(e));
      case 'item':
        return noTemplate(this.staticData.getAllItems());
      case 'resource':
        return this.staticData.getAllResources().slice();
      case 'map':
        return noTemplate(this.staticData.loadRaw('maps'));
      case 'monster':
        return this.staticData.getAllMonsters().slice();
      case 'task':
        return noTemplate(this.staticData.getAllTasks());
      case 'buff':
        return noTemplate(this.staticData.getAllBuffs());
      case 'building':
        return noTemplate(this.staticData.getAllBuildings());
      case 'part':
        return noTemplate(this.staticData.loadRaw('vehicles'));
      case 'title':
        return this.staticData.getAllTitles().slice();
      case 'equipEffect':
        return this.staticData.loadRaw('effects').filter((e) => e.limit === '装备');
      case 'weaponEffect':
        return this.staticData.loadRaw('effects').filter((e) => e.limit === '武器');
      case 'recipe':
        return this.staticData.loadRaw('recipes');
      case 'attackText':
        return this.staticData.loadRaw('attackTexts');
      case 'dialogue':
        return noTemplate(this.staticData.loadRaw('npcs'));
      case 'wreck':
        return this.staticData.loadRaw('wrecks');
      case 'craft':
        // 制造：原版统计含占位行（426），且菜单里没有入口，仅供统计串使用
        return this.staticData.getAllCraftings().slice();
      case 'music':
      case 'image':
      default:
        return [];
    }
  }

  /** 条目的图鉴显示名（对话文本分类原版命名为「<NPC名>对话」） */
  private entryName(key: CategoryKey, raw: any): string {
    if (key === 'dialogue') return `${raw?.name ?? ''}对话`;
    return String(raw?.name ?? '');
  }

  /** 把一条原始数据构建成图鉴条目（名 + 列表简介 + 详情行） */
  private buildEntry(key: CategoryKey, raw: any, ctx: HandbookContext): HandbookEntry {
    switch (key) {
      case 'familiar': {
        const skillLevel = ctx.skillLevel && ctx.skillLevel > 0 ? ctx.skillLevel : 1;
        const affinity = ctx.familiarName && ctx.familiarName === raw.name
          ? (ctx.affinity ?? 0)
          : 0;
        return {
          name: raw.name,
          brief: this.familiarBrief(raw),
          detail: this.renderFamiliarDetail(raw, skillLevel, affinity),
        };
      }
      case 'weapon':
        return {
          name: raw.name,
          brief: lines(raw.description)[0] ?? '',
          detail: this.renderEquipmentDetail(raw, true),
        };
      case 'equipment':
        return {
          name: raw.name,
          brief: lines(raw.description)[0] ?? '',
          detail: this.renderEquipmentDetail(raw, false),
        };
      case 'item':
        return {
          name: raw.name,
          brief: lines(raw.description)[0] ?? '',
          detail: this.renderItemDetail(raw),
        };
      case 'resource':
        return {
          name: raw.name,
          brief: lines(raw.description)[0] ?? '',
          detail: this.renderResourceDetail(raw),
        };
      case 'map':
        return {
          name: raw.name,
          brief: raw.respawnPoint ? `${raw.respawnPoint}附近` : '',
          detail: this.renderMapDetail(raw),
        };
      case 'monster':
        return {
          name: raw.name,
          brief: raw.level ? `Lv${raw.level}` : '',
          // 基础图鉴（原版 g1==0 分支）；「图鉴X详细」走 renderMonsterDetail
          detail: this.renderMonsterBase(raw),
        };
      case 'task':
        return {
          name: raw.name,
          brief: lines(raw.description)[0] ?? '',
          detail: this.renderTaskDetail(raw),
        };
      case 'buff':
        return {
          name: raw.name,
          brief: lines(raw.description)[0] ?? '',
          detail: this.renderBuffDetail(raw),
        };
      case 'building':
        return {
          name: raw.name,
          brief: lines(raw.description)[0] ?? '',
          detail: this.renderBuildingDetail(raw),
        };
      case 'part':
        return {
          name: raw.name,
          brief: raw.type ? `${raw.type}` : '',
          detail: this.renderVehiclePartDetail(raw),
        };
      case 'title':
        return {
          name: raw.name,
          brief: lines(raw.description)[0] ?? '',
          detail: this.renderTitleDetail(raw),
        };
      case 'equipEffect':
      case 'weaponEffect':
        return {
          name: raw.name,
          brief: lines(raw.description)[0] ?? '',
          detail: this.renderEffectDetail(raw),
        };
      case 'recipe':
        return {
          name: raw.name,
          brief: lines(raw.description)[0] ?? '',
          detail: this.renderRecipeDetail(raw),
        };
      case 'attackText':
        return {
          name: raw.name,
          brief: raw.forMonster ? '怪物' : '玩家',
          detail: this.renderAttackTextDetail(raw),
        };
      case 'dialogue':
        return {
          name: `${raw.name}对话`,
          brief: lines(parseArr(raw.friendlyChat)[0] ?? '')[0] ?? '',
          detail: this.renderDialogueDetail(raw),
        };
      case 'wreck':
        return {
          name: raw.name,
          brief: `刷新几率${raw.chance}%`,
          detail: this.renderWreckDetail(raw),
        };
      default:
        return { name: String(raw?.name ?? ''), brief: '', detail: [String(raw?.name ?? '')] };
    }
  }

  // ----- 1. 使魔 -----

  /** 渲染使魔列表的条目（取该玩家当前的 好感 与 技能等级） */
  private familiarBrief(f: any): string {
    const desc2 = nl(f.description2 || '');
    const firstLine = desc2.split('\n')[0] || '';
    // 截短到不超过 30 字
    return firstLine.length > 30 ? `${firstLine.slice(0, 30)}…` : firstLine;
  }

  /** 渲染使魔详情：对齐原版 数据显示.ecode L3045-3047 */
  renderFamiliarDetail(f: any, skillLevel: number, affinity: number, playerName?: string): string[] {
    const hairList = parseArr(f.hairDrop);
    const hairText = hairList.map((h: any) => `${h.name}x${roundText(h.count)}`).join('、') || '-';
    const detail: string[] = [];
    if (playerName) detail.push(playerName);
    detail.push(`${f.name}${paren(`好感${roundText(affinity)}`)}`);
    if (f.description2) detail.push(nl(f.description2));
    if (f.description) detail.push(nl(f.description));
    if (f.skillDesc) detail.push(nl(subSkillLevel(f.skillDesc, skillLevel)));
    const aff = parseArr(f.affinityDesc);
    if (aff.length > 0) {
      aff.forEach((d: any, i: number) => {
        const unlock = (i + 1) * 20;
        const text = nl(subSkillLevel(String(d), skillLevel));
        if (affinity >= unlock) detail.push(text);
        else detail.push(`好感${unlock}解锁:${text}`);
      });
    }
    detail.push(`特效编号(调试用):${roundText(f.specialSeq ?? 0)}`);
    detail.push(`毛发:${hairText}`);
    return detail;
  }

  // ----- 2-3. 装备/武器 -----

  /** 对齐原版 L2970-3044 */
  private renderEquipmentDetail(e: any, isWeapon: boolean): string[] {
    const detail: string[] = [];
    detail.push(`${e.name}${paren(e.equipType ?? '')}`);
    if (e.description) detail.push(nl(e.description));
    if (isWeapon) {
      const dmg = e.damage ?? {};
      detail.push(
        `◆伤害属性:物${roundText(dmg.物)}%/冰${roundText(dmg.冰)}%/火${roundText(dmg.火)}%/电${roundText(dmg.电)}%`,
      );
      detail.push(`◆攻击显示的文本:${e.attackText?.name ?? '-'}`);
      detail.push(`◆攻击冷却:${roundText(e.cooldown)}`);
      if (Number(e.lockTime ?? 0) > 0) detail.push(`◆攻击需要锁定${roundText(e.lockTime)}秒`);
      const neg = Number(e.negativeType ?? 0);
      if (neg === 1) detail.push('◆割裂:命中时叠加1层，持续30秒。4层时重置层数，并使目标受到的伤害增加10%，持续30秒。');
      else if (neg === 2) detail.push('◆灼烧:命中时叠加1层，持续30秒。4层时重置层数，并使目标回复速度减少50%，持续30秒。');
      else if (neg === 3) detail.push('◆深寒:命中时叠加1层，持续30秒。4层时重置层数，并使目标全部武器进入3秒冷却。');
      else if (neg === 4) detail.push('◆感电:命中时叠加1层，持续30秒。4层时重置层数，并降低目标5%抗性，持续30秒。');
    } else if (e.attackText?.name) {
      const atkTexts = splitText(String(e.attackText.name), '；');
      const summon = atkTexts.length > 1 ? atkTexts[1] : atkTexts[0];
      detail.push(`◆攻击时召唤${bracket(summon ?? '')}`);
    }

    const triggers = parseArr(e.triggers);
    if (triggers.length > 0) detail.push(`◆命中时触发效果:${triggers.join('、')}`);

    const bonus = parseObj(e.bonus);
    const bonusText = renderBonus(bonus, true);
    if (bonusText) detail.push(`◆${bonusText}`);

    if (e.mustEffect || e.mustHaveEffect) detail.push('◆这件装备在生成时必定附带特效');

    const affixes = parseArr(e.affixes);
    if (affixes.length > 0) {
      detail.push(`出现的属性:${expandAffixPool(affixes.map((a: any) => String(a)))}${paren('不会出现重复属性')}`);
    }

    detail.push(`出处:${e.name} (装备配置)`);
    detail.push(`特效编号(调试用):${roundText(e.specialSeq ?? 0)}`);
    return detail;
  }

  // ----- 4. 物品 -----

  private renderItemDetail(it: any): string[] {
    const detail: string[] = [];
    detail.push(it.name);
    if (it.description) detail.push(nl(it.description));
    if (it.value !== undefined) detail.push(`价值:${roundText(it.value)}`);
    const useGets = parseArr(it.useEffects).length > 0 ? parseArr(it.useEffects) : parseArr(it.useGets);
    if (useGets.length > 0) {
      detail.push(`使用可得:${useGets.map((s) => bracket(`随机一项:${s}`)).join('、')}`);
    }
    // 可用于制造（原版 L3286-3305）
    const usedBy: string[] = [];
    for (const c of this.staticData.loadRaw<any>('craftings')) {
      if (c.noCraft) continue;
      for (const req of parseArr(c.requirements)) {
        if (req.name === it.name) {
          usedBy.push(c.name);
          break;
        }
      }
      if (usedBy.length >= 200) break;
    }
    if (usedBy.length > 0) {
      const truncated = usedBy.length > 9;
      const visible = truncated ? usedBy.slice(0, 9) : usedBy;
      const tail = truncated ? `等共${usedBy.length}种制造项目` : '';
      detail.push(`可用于制造${visible.map(bracket).join('、')}${tail}`);
    }
    return detail;
  }

  // ----- 5. 资源 -----

  private renderResourceDetail(r: any): string[] {
    const detail: string[] = [];
    const count = r.count ?? r.times ?? -1;
    detail.push(`${r.name},可采集次数${roundText(count)},消耗时间${roundText(3 * Number(r.timeScale ?? 1))}~${roundText(6 * Number(r.timeScale ?? 1))}`);
    if (r.description) detail.push(nl(r.description));
    const outputs = parseArr(r.outputs);
    if (outputs.length > 0) {
      const text = outputs.map((o, i) =>
        `${i === 0 ? '采集产出:' : '、'}${o.name}x${roundText(Math.abs(Number(o.count ?? 0)))}${paren(pct(o.chance))}`
      ).join('');
      detail.push(text);
    }
    if (outputs.length > 0) {
      const gather = 100;
      const text = outputs.map((o, i) => {
        const cnt = Number(o.count ?? 0);
        if (cnt > 0) {
          return `${i === 0 ? '采集产出(你的倍率):' : '、'}${o.name}x${roundText(cnt * gather / 100)}${paren(pct(o.chance))}`;
        }
        return `${i === 0 ? '采集产出(你的倍率):' : '、'}${o.name}x${roundText(Math.abs(cnt))}${paren(pct(o.chance))}`;
      }).join('');
      detail.push(text);
    }
    // 产出2
    const out2Text = this.renderOutputs2(r);
    if (out2Text) detail.push(...out2Text);
    detail.push(`出处:${r.name} (资源配置)`);
    return detail;
  }

  /** 资源产出2（原版 L3079-3098） */
  private renderOutputs2(r: any): string[] {
    const out2 = parseArr(r.outputs2);
    if (out2.length === 0) return [];
    const priority = r.priority ?? '?';
    const isPower = out2[0]?.name === '电力';
    const lines: string[] = [];
    lines.push(`计算产出优先级:${priority}${isPower ? '(调试用,数值越小越先计算)' : '(数值越小越先计算)'}`);
    out2.forEach((o, i) => {
      if (o.name === '电力') {
        if (i === 0) lines.push(`每小时有几率生成在随机地图\n发电:${roundText(Number(o.count ?? 0) / 10)}`);
        else lines.push(`、发电:${roundText(Number(o.count ?? 0) / 10)}`);
      } else {
        const daily = Math.abs(Number(o.count ?? 0) * 144);
        const sci = daily.toExponential(2);
        if (i === 0) lines.push(`每小时有几率生成在随机地图\n每天额外生成资源:${o.name}x${sci}`);
        else lines.push(`、${o.name}x${sci}`);
      }
    });
    return lines;
  }

  // ----- 6. 地图 -----

  private renderMapDetail(mp: any): string[] {
    const detail: string[] = [];
    if (mp.description) detail.push(nl(mp.description));
    if (mp.respawnPoint) detail.push(`复活点:${mp.respawnPoint}`);
    if (mp.noSpecial) {
      detail.push('不会刷新货舱、能量元素、作物');
      detail.push('露娜、神之工匠、花园宝宝、小白狐、废弃载具不会出现在这里');
      detail.push('不会被乱流吹到这里');
    }
    if (mp.isFrontier) detail.push(paren('玩家家园'));
    if (mp.isInstance) detail.push('副本地图');
    if (mp.noTeleport || mp.unTeleportable) detail.push('不可传送、飞到、跃迁至此处');
    if (mp.noMoveHome) detail.push('家园不可搬迁到此处');
    if (mp.travelReq === '飞行') detail.push('【需要[飞行]才能到达】');
    if (mp.travelReq === '传送') detail.push('【需要装备[天蓝吊坠]，或者驾驶有[跃迁引擎]的载具才能传送到达】');
    if (mp.travelReq === '跃迁') detail.push('【需要驾驶有[跃迁引擎]的载具才能跃迁到达】');
    if (mp.onEnter === '触发攻击') detail.push('【警告：此地图怪物会主动攻击】');

    detail.push(`NPC数量${roundText(mp.npcCount ?? 0)}`);
    const res = parseArr(mp.resources).map((x) => x?.name).filter(Boolean);
    if (res.length > 0) detail.push(`自带的资源:${res.join('、')}`);
    const monsters = parseArr(mp.spawnMonsters ?? mp.monsters)
      .map((x) => (typeof x === 'string' ? x : x?.name))
      .filter(Boolean);
    if (monsters.length > 0) detail.push(`自带的怪物:${monsters.join('、')}`);

    const routes = parseArr(mp.reachables).filter((x) => !String(x?.name ?? '').includes('(副本)'));
    if (routes.length > 0) {
      const text = routes.map((r, i) =>
        `${i === 0 ? '通道:' : '、'}${r.name}${paren(`距离${roundText(r.distance)}`)}`
      ).join('');
      detail.push(text);
    }
    return detail;
  }

  // ----- 7. 怪物 -----

  /**
   * 怪物基础图鉴：对齐原版 L3165-3169（输入不以"详细"结尾时走这条）。
   * 结构：说明 + 基础等级 + 产奶量 + 毛发 + 特效编号(调试用) + "1、显示详细数据"。
   */
  private renderMonsterBase(m: any): string[] {
    const bonus = parseObj(m.bonus);
    const hair = parseArr(m.hairDrop);
    const out: string[] = [];
    if (m.description) out.push(nl(m.description));
    if (bonus.说明) out.push(nl(String(bonus.说明)));
    out.push(`基础等级:${m.level ?? '?'}`);
    // 原版取 怪物.好感 作产奶量；新版静态数据里该值落在 bonus.产奶量
    out.push(`产奶量:${roundText(bonus.产奶量 ?? 0)}`);
    out.push(`毛发:${hair.map((h) => `${h.name}x${roundText(h.count)}`).join('、') || '-'}`);
    out.push(`特效编号(调试用):${roundText(m.vitality ?? m.specialSeq ?? 0)}`);
    out.push('1、显示详细数据');
    return out;
  }

  /**
   * 怪物详细数据：对齐原版 L3170-3245（输入以"详细"结尾，即 `图鉴X详细`）。
   *
   * 原版调用 `_初始化怪物(玩家2)` 后再 `显示使魔数据(玩家2, 真, 玩家.QQ)`，
   * 输出顺序为：属性面板 → 使用的武器 → 使用的装备 → 驾驶的载具 → 闪避冷却 →
   * 掉落(含熟练度加成) → 掉落(你的加成) → 麻醉值 → 来自装备的被动效果 → 出处 → 说明。
   *
   * 新版改从 monsters.json 的 bonus 字段读取（武器/装备/载具/drops/麻醉 均已迁移），
   * 不再依赖运行时初始化；玩家相关加成由 ctx.playerDrop* 传入，缺省按 0 计算。
   */
  private renderMonsterDetail(m: any, ctx?: HandbookContext): string[] {
    const bonus = parseObj(m.bonus);
    const out: string[] = [];

    // ---- 属性面板（原版 显示使魔数据(详细=真) 的怪物分支） ----
    out.push(`${m.name}${paren(m.type ?? '怪物')}`);
    out.push(`等级:${roundText(m.level ?? 0)}`);
    if (Number(m.maxShield ?? 0) !== 0) out.push(`护盾:${roundText(m.shield)}/${roundText(m.maxShield)}`);
    if (Number(m.maxArmor ?? 0) !== 0) out.push(`装甲:${roundText(m.armor)}/${roundText(m.maxArmor)}`);
    out.push(`生命:${roundText(m.hp)}/${roundText(m.maxHp ?? m.hp)}`);
    out.push(`物攻:${roundText(m.attack)}  电攻:${roundText(bonus.电伤 ?? 0)}`);
    out.push(`火攻:${roundText(bonus.火伤 ?? 0)}  冰攻:${roundText(bonus.冰伤 ?? 0)}`);
    out.push(`命中:${roundText(m.hit)}  闪避:${roundText(m.dodge)}`);
    out.push(`速度:${roundText(m.speed)}  暴击:${roundText(bonus.暴击 ?? 0)}%`);
    out.push(`防御:${roundText(m.defense ?? 0)}`);
    // 三池四系抗性（原版 L812-823：护盾/装甲/生命 各自的 物/火/冰/电抗）
    if (this.hasResist(bonus, '护盾')) {
      out.push('◆护盾物/火/冰/电抗:');
      out.push(`  ${roundText(bonus.护盾物抗)}%/${roundText(bonus.护盾火抗)}%/${roundText(bonus.护盾冰抗)}%/${roundText(bonus.护盾电抗)}%`);
    }
    if (this.hasResist(bonus, '装甲')) {
      out.push('◆装甲物/火/冰/电抗:');
      out.push(`  ${roundText(bonus.装甲物抗)}%/${roundText(bonus.装甲火抗)}%/${roundText(bonus.装甲冰抗)}%/${roundText(bonus.装甲电抗)}%`);
    }
    if (this.hasResist(bonus, '生命')) {
      out.push('◆生命物/火/冰/电抗:');
      out.push(`  ${roundText(bonus.生命物抗)}%/${roundText(bonus.生命火抗)}%/${roundText(bonus.生命冰抗)}%/${roundText(bonus.生命电抗)}%`);
    }
    if (bonus.暴击伤害 || bonus.韧性) {
      out.push(`◆暴击伤害:${roundText(bonus.暴击伤害 ?? 0)}%  韧性:${roundText(bonus.韧性 ?? 0)}%`);
    }
    // 二阶回复（原版 L860-868）
    // 注意：静态数据里这几项是"每秒百分比"，数值常小于 1（如 0.1），
    // 用 roundText 会全部抹成 0，故改保留 2 位小数。
    if (Number(bonus.护盾回复 ?? 0) + Number(bonus.护盾回复2 ?? 0) !== 0) {
      out.push(`◆护盾回复:${fmt2(bonus.护盾回复)} + ${fmt2(bonus.护盾回复2)}%`);
    }
    if (Number(bonus.装甲回复 ?? 0) + Number(bonus.装甲回复2 ?? 0) !== 0) {
      out.push(`◆装甲修复:${fmt2(bonus.装甲回复)} + ${fmt2(bonus.装甲回复2)}%`);
    }
    if (Number(bonus.生命回复 ?? 0) + Number(bonus.生命回复2 ?? 0) !== 0) {
      out.push(`◆生命恢复:${fmt2(bonus.生命回复)} + ${fmt2(bonus.生命回复2)}%`);
    }
    if (bonus.经验) out.push(`◆击杀经验:${roundText(bonus.经验)}`);
    if (bonus.必中) out.push(`◆必中:${roundText(bonus.必中)}`);

    // ---- 使用的武器（原版 L3173-3180） ----
    const weapons = this.monsterWeapons(m, bonus);
    if (weapons.length > 0) out.push(`◆使用的武器:${weapons.join('、')}`);

    // ---- 使用的装备（原版 L3181-3188） ----
    const equips = this.monsterEquipments(m, bonus);
    if (equips.length > 0) out.push(`◆使用的装备:${equips.join('、')}`);

    // ---- 驾驶的载具（原版 L3189-3191） ----
    if (bonus.载具) out.push(`◆驾驶的载具:${bonus.载具}`);

    // ---- 闪避冷却（原版 L3192-3198） ----
    const dodgeCd = Number(bonus.闪避冷却 ?? 0);
    if (dodgeCd === 0) out.push('◆不会闪避攻击');
    else if (dodgeCd > 0) out.push(`◆闪避冷却:${dodgeCd}秒(主动)`);
    else out.push(`◆闪避冷却:${-dodgeCd}秒(被动)`);

    // ---- 掉落（原版 L3199-3233） ----
    const drops = parseArr(bonus.drops);
    if (drops.length > 0) {
      // 熟练度加成：原版 b = 熟练度等级(怪物类型) + 熟练度等级("世界")，数量 ×(1+b*0.05)
      const b = this.dropProficiencyLevel(m, ctx);
      const mul = 1 + b * 0.05;
      out.push(drops
        .map((d, i) => `${i === 0 ? '◆掉落:' : '、'}${d.name}x${roundText(Math.abs(Number(d.count ?? 0)) * mul)}${paren(pct(d.chance))}`)
        .join(''));
      // 玩家加成行：数量 ×(1+掉落品质/100)（仅正数量），几率 ×(1+掉落率/100)
      // 宝石缎带（原版 L3215-3226）额外把几率按 (1+(100-几率)/100*0.4) 提升
      const quality = Number(ctx?.playerDropQuality ?? 0);
      const rate = Number(ctx?.playerDropRate ?? 0);
      const gem = !!ctx?.hasGemRibbon;
      out.push(drops
        .map((d, i) => {
          const cnt = Number(d.count ?? 0);
          let chance = Number(d.chance ?? 100);
          if (gem) chance = chance * (1 + ((100 - chance) / 100) * 0.4);
          const shownCnt = cnt > 0 ? Math.abs(cnt) * (1 + quality / 100) : Math.abs(cnt);
          const shownChance = chance * (1 + rate / 100);
          return `${i === 0 ? '◆掉落(你的加成):' : '、'}${d.name}x${roundText(shownCnt)}${paren(`${roundText(shownChance)}%`)}`;
        })
        .join(''));
    }

    // ---- 麻醉值（原版 L3234-3238） ----
    const narc = Number(bonus.麻醉 ?? 0);
    if (narc < 0) out.push(`◆特殊麻醉值${roundText(narc)}(不可捕捉)`);
    else out.push(`◆麻醉值${roundText(narc)}，捕捉需要${roundText(narc / 150)}的饲料`);

    // ---- 来自装备的被动效果（原版 L3239-3242） ----
    if (bonus.效果) out.push(`◆来自装备的被动效果\n${nl(String(bonus.效果))}`);

    out.push(`出处:${m.name} (怪物配置)`);
    if (m.description) out.push(nl(m.description));
    return out;
  }

  /** 判断某池是否有任一抗性非零（避免输出全 0 的抗性行） */
  private hasResist(bonus: Record<string, any>, pool: string): boolean {
    return ['物抗', '火抗', '冰抗', '电抗'].some((s) => Number(bonus[pool + s] ?? 0) !== 0);
  }

  /** 怪物使用的武器名列表：优先 weapons 数组，回退 武器 字符串（空格分隔） */
  private monsterWeapons(m: any, bonus: Record<string, any>): string[] {
    const arr = parseArr(bonus.weapons).map((w) => (typeof w === 'string' ? w : w?.name)).filter(Boolean);
    if (arr.length > 0) return arr;
    return String(bonus.武器 ?? '').split(' ').map((s) => s.trim()).filter(Boolean);
  }

  /** 怪物使用的装备名列表：优先 equipmentList 数组，回退 装备 字符串（空格分隔） */
  private monsterEquipments(m: any, bonus: Record<string, any>): string[] {
    const arr = parseArr(bonus.equipmentList).map((e) => (typeof e === 'string' ? e : e?.name)).filter(Boolean);
    if (arr.length > 0) return arr;
    return String(bonus.装备 ?? '').split(' ').map((s) => s.trim()).filter(Boolean);
  }

  /**
   * 掉落熟练度等级（原版 L3199 的 b）。
   * 原版 = 熟练度等级(全局标记, 怪物类型) + 熟练度等级(全局标记, "世界")。
   * 新版：怪物类型熟练度取玩家标记，世界等级取 ctx.worldLevel（由调用方从
   * `game.worldLevel` 系统配置读入）；两者缺省为 0，此时掉落倍率为 1.0（即原版无加成基线）。
   */
  private dropProficiencyLevel(m: any, ctx?: HandbookContext): number {
    const monsterLevel = Number(ctx?.monsterProficiency?.[String(m.name)] ?? 0);
    const worldLevel = Number(ctx?.worldLevel ?? 0);
    return monsterLevel + worldLevel;
  }

  // ----- 8. 任务 -----

  private renderTaskDetail(t: any): string[] {
    const detail: string[] = [];
    if (t.description) detail.push(nl(t.description));
    const reqs = parseArr(t.requirements);
    if (reqs.length > 0) {
      detail.push(reqs.map((r, i) => `${i === 0 ? '需求:' : '、'}${r.name}x${roundText(r.count ?? 0)}`).join(''));
    }
    const rewards = parseArr(t.rewards);
    if (rewards.length > 0) {
      detail.push(rewards.map((r, i) => `${i === 0 ? '奖励:' : '、'}${r.name}x${roundText(r.count ?? 0)}${paren(pct(r.chance))}`).join(''));
    }
    const followups: string[] = Array.isArray(t.followups) ? t.followups.filter(Boolean) : [];
    if (followups.length > 0) {
      detail.push(followups.map((s, i) => `${i === 0 ? '完成后获得新的任务:' : '、'}${s}`).join(''));
    }
    return detail;
  }

  // ----- 9. 增益 -----

  private renderBuffDetail(b: any): string[] {
    const detail: string[] = [];
    if (b.description) detail.push(nl(b.description));
    const bonus = parseObj(b.bonus);
    const bonusText = renderBonus(bonus, true);
    if (bonusText) detail.push(`◆${bonusText}`);
    if (b.duration) detail.push(`持续时间:${roundText(b.duration)}秒`);
    return detail;
  }

  // ----- 10. 建筑 -----

  private renderBuildingDetail(b: any): string[] {
    const detail: string[] = [];
    if (b.description) detail.push(nl(b.description));
    if (b.type) detail.push(`类型:${b.type}`);
    return detail;
  }

  // ----- 11. 载具部件 -----

  private renderVehiclePartDetail(v: any): string[] {
    const detail: string[] = [];
    detail.push(`${v.name}${paren(v.type ?? '')}`);
    if (v.description) detail.push(nl(v.description));
    const bonus = parseObj(v.builtinBonus ?? v.bonus);
    const bonusText = renderBonus(bonus, true);
    if (bonusText) detail.push(`◆${bonusText}`);
    detail.push(`出处:${v.name} (载具部件配置)`);
    detail.push(`特效编号(调试用):${roundText(v.specialSeq ?? 0)}`);
    return detail;
  }

  // ----- 12. 称号 -----

  private renderTitleDetail(t: any): string[] {
    const detail: string[] = [];
    if (t.description) detail.push(nl(t.description));
    const req = t.requirements ?? {};
    if (req.name) detail.push(`要求:${req.name}`);
    const bonus = parseObj(t.bonus);
    const bonusText = renderBonus(bonus, true);
    if (bonusText) detail.push(`◆${bonusText}`);
    return detail;
  }

  // ----- 13. 攻击文本 -----

  private renderAttackTextDetail(r: any): string[] {
    const detail: string[] = [];
    detail.push(r.name);
    const atks = parseArr(r.attackTexts);
    if (atks.length) detail.push(`命中:${atks.join('、')}`);
    const sb = parseArr(r.shieldBreak);
    if (sb.length) detail.push(`破盾:${sb.join('、')}`);
    const ab = parseArr(r.armorBreak);
    if (ab.length) detail.push(`破甲:${ab.join('、')}`);
    const ks = parseArr(r.killTexts);
    if (ks.length) detail.push(`击杀:${ks.join('、')}`);
    const ms = parseArr(r.missTexts);
    if (ms.length) detail.push(`未中:${ms.join('、')}`);
    const lks = parseArr(r.lockTexts);
    if (lks.length) detail.push(`锁定:${lks.join('、')}`);
    return detail;
  }

  // ----- 14. 对话文本 -----

  private renderDialogueDetail(r: any): string[] {
    const detail: string[] = [];
    detail.push(`${r.name}对话`);
    const friendly = parseArr(r.friendlyChat);
    if (friendly.length) detail.push(`友好聊天:${friendly.join('、')}`);
    const hostile = parseArr(r.hostileChat);
    if (hostile.length) detail.push(`敌对聊天:${hostile.join('、')}`);
    const follow = parseArr(r.followText);
    if (follow.length) detail.push(`跟随:${follow.join('、')}`);
    const stop = parseArr(r.stopText);
    if (stop.length) detail.push(`停下:${stop.join('、')}`);
    const pickup = parseArr(r.pickupText);
    if (pickup.length) detail.push(`拾取:${pickup.join('、')}`);
    const milk = parseArr(r.milkText);
    if (milk.length) detail.push(`挤奶:${milk.join('、')}`);
    return detail;
  }

  // ----- 15-16. 装备特效 / 武器特效 -----

  private renderEffectDetail(r: any): string[] {
    const detail: string[] = [];
    if (r.description) detail.push(nl(r.description));
    const bonus = parseObj(r.bonus);
    const bonusText = renderBonus(bonus, true);
    if (bonusText) detail.push(`◆${bonusText}`);
    return detail;
  }

  // ----- 17. 配方（recipes.json，原版 L3481-3529） -----

  /**
   * 配方详情。
   * 注意：配方与「制造」是两个不同的数据集——
   *   - 配方 recipes.json（94 条）：生产力产出/消耗，有解锁需求，可领解锁任务
   *   - 制造 craftings.json（426 条）：材料→成品的制造配方，仅在统计串出现
   * 原版同样区分 `配方列表` 与 `制造列表`。
   */
  private renderRecipeDetail(pf: any, playerName?: string): string[] {
    const detail: string[] = [];
    detail.push(pf.name);
    if (pf.description) detail.push(nl(pf.description));
    detail.push(`配方等级:${roundText(pf.level ?? 1)}`);
    detail.push('每分钟1生产力的产出与消耗：');

    const outputs = parseArr(pf.outputs);
    if (outputs.length > 0) {
      // 几率(耐久)>=100 为主产物，<100 为副产物（数量按几率折算）
      const main = outputs.filter((o) => Number(o.chance ?? 0) >= 100);
      const side = outputs.filter((o) => Number(o.chance ?? 0) < 100);
      if (main.length > 0) {
        detail.push(`产物:${main.map((o) => `${o.name}x${sciText(o.count)}`).join('、')}`);
      }
      if (side.length > 0) {
        detail.push(`副产物:${side
          .map((o) => `${o.name}x${sciText(Number(o.count ?? 0) * Number(o.chance ?? 0) / 100)}`)
          .join('、')}`);
      }
    }
    const inputs = parseArr(pf.inputs);
    if (inputs.length > 0) {
      detail.push(`消耗:${inputs.map((o) => `${o.name}x${sciText(o.count)}`).join('、')}`);
    }

    // 解锁需求（原版 L3522-3527）：等级>1 时追加"至少N个N-1级的已解锁配方"
    const unlock = parseArr(pf.unlockReq);
    const level = Number(pf.level ?? 1);
    if (unlock.length > 0) {
      const items = unlock.map((u) => `${u.name}x${roundText(u.count)}`).join('、');
      detail.push(level <= 1
        ? `解锁需求:${items}`
        : `解锁需求:${items}、至少${level}个${level - 1}级的已解锁配方(你有0个)`);
    }
    detail.push('1、领取解锁这个配方的任务');
    return detail;
  }

  // ----- 18. 废弃载具（wrecks.json，原版 L3530-3532） -----

  /**
   * 废弃载具详情。
   * 原版：`载具模拟(零件, , 去数字(名称), , , )` 再把"消耗材料"替换成"载具价值"，
   *       最后追加 `每小时刷新几率:<名称里的数字>%`。
   * 新版把几率拆成了独立字段（原版编码在名称里），此处按同样文案输出。
   *
   * 说明：原版「载具模拟」会走完整的 `计算载具` 汇总属性（生命/攻击/抗性/槽位），
   * 而废弃载具的零件多为"损坏的武器位"这类特殊件，不是标准可装配部件。
   * 此处输出零件清单 + 载具价值（按 craftings 折算的基础材料），
   * 完整属性模拟留给载具系统收敛后再接入。
   */
  private renderWreckDetail(w: any): string[] {
    const detail: string[] = [];
    detail.push(w.name);
    const parts = parseArr(w.parts);
    if (parts.length > 0) {
      detail.push(`零件:${parts.map((p) => `${p.name}x${roundText(p.count ?? 1)}`).join('、')}`);
      // 载具价值（原版 取制造成本：零件按 craftings 配方折算成基础材料）
      const cost = this.calcManufactureCost(parts);
      if (cost.length > 0) {
        detail.push(`载具价值:${cost.map((c) => `${c.name}x${roundText(c.count)}`).join('、')}`);
      }
    }
    detail.push(`每小时刷新几率:${w.chance}%`);
    return detail;
  }

  /**
   * 取制造成本：把零件按 craftings 配方折算成基础材料。
   * 对应原版 数据分析.ecode L157-179：遍历制造列表，命中同名条目后取其需求 × 零件数量累加。
   */
  private calcManufactureCost(parts: Array<{ name: string; count: number }>): Array<{ name: string; count: number }> {
    const craftings = this.staticData.getAllCraftings();
    const acc = new Map<string, number>();
    for (const p of parts) {
      const recipe = craftings.find((c) => c.name === p.name);
      if (!recipe) continue;
      for (const req of parseArr(recipe.requirements)) {
        acc.set(req.name, (acc.get(req.name) ?? 0) + Number(req.count ?? 0) * Number(p.count ?? 1));
      }
    }
    return Array.from(acc, ([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }

  // ----- 19. 图片（原版 L2906-2913）-----

  /** 图片为占位：原版仅在玩家输入"图片"时列出 「图片列表」共几条，本轮无可索引图集数据。 */
  // ----- 20. 音乐（原版 L2860-2873）-----

  /** 音乐暂无独立数据源；占位返回空分类 */
}
