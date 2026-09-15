/**
 * 指令检索工具（中文 / 别名 / 拼音全拼 / 拼音首字母）
 *
 * 背景：指令名以中文为主，玩家习惯用拼音连续输入（beibao、bbss），
 * 因此除原有「中文名/别名/描述」匹配外，还需支持「全拼」「首字母」两类拼音匹配。
 *
 * 实现要点：
 * - 为每条指令惰性构建检索索引（原名、别名、全拼、首字母），并用 Map 缓存，
 *   避免每次按键都重复调用拼音库（指令列表只在进入页面时加载一次）。
 * - 打分排序：名称直接命中 > 别名直接命中 > 拼音命中 > 描述兜底，
 *   同分时保持指令原有顺序（后端 sortOrder），保证候选列表稳定不跳动。
 * - 所有阈值、权重、条数上限集中在 config.js 的 COMMAND_SEARCH_CONFIG，调参无需改动本文件。
 */
import { pinyin } from 'pinyin-pro';
import { COMMAND_SEARCH_CONFIG } from '../config';

/** 全拼转换参数：无声调、数组输出、连续非中文整体保留（"HP恢复" → ["HP","hui","fu"]） */
const PINYIN_FULL_OPTS = { toneType: 'none', type: 'array', nonZh: 'consecutive' };
/** 首字母转换参数：pattern=first，其余同上（"HP恢复" → ["HP","h","f"]） */
const PINYIN_INITIALS_OPTS = {
  pattern: 'first',
  toneType: 'none',
  type: 'array',
  nonZh: 'consecutive',
};

/** 索引缓存：key = 指令名 + 别名，值为 buildIndex 的返回结构 */
const indexCache = new Map();

/** 中文字符判定：用于「只检索中文别名」模式过滤英文别名 */
const ZH_CHAR_RE = /[\u4e00-\u9fa5]/;

/** 命中来源 → 中文标签（用于下拉项提示，帮助玩家理解候选为何出现） */
const HIT_TYPE_LABELS = {
  alias: '别名',
  pinyin: '拼音',
  initials: '首字母',
  'alias-pinyin': '别名拼音',
  'alias-initials': '别名首字母',
  desc: '描述',
  'desc-pinyin': '描述拼音',
};

/** 归一化：转小写并去掉所有空白，忽略大小写与空格差异（"Bei Bao" → "beibao"） */
function normalize(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/\s+/g, '');
}

/** 紧凑化：仅保留字母、数字与中文，忽略连字符/下划线等符号（"search-bag" → "searchbag"） */
function compact(text) {
  return normalize(text).replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

/** 文本 → 拼音全拼串（仅保留字母数字，如 "背包搜索" → "beibaosousuo"） */
function toFullPinyin(text) {
  return pinyin(String(text || ''), PINYIN_FULL_OPTS)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** 文本 → 拼音首字母串（仅保留字母数字，如 "背包搜索" → "bbss"） */
function toInitials(text) {
  return pinyin(String(text || ''), PINYIN_INITIALS_OPTS)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * 构建（或命中缓存的）单条指令检索索引
 * @param {object} cmd 指令对象 { name, alias, description }
 * @returns {object} 含原名/别名/全拼/首字母的检索索引
 */
function buildIndex(cmd) {
  const name = String(cmd.name || '');
  const aliasRaw = String(cmd.alias || '');
  const descRaw = String(cmd.description || '');
  // 缓存键包含别名与描述：指令在后台被改动后索引会自动重建，不会用到过期数据
  const cacheKey = name + '\u0000' + aliasRaw + '\u0000' + descRaw;
  const cached = indexCache.get(cacheKey);
  if (cached) return cached;

  // 别名支持中英文逗号分隔（后端格式如 "attack,打,揍"）
  const aliases = aliasRaw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((a) => ({
      raw: a,
      // 是否含中文：供 aliasMatch='chinese'（默认）过滤掉 attack/lock/pickup 这类英文别名
      isZh: ZH_CHAR_RE.test(a),
      lower: normalize(a),
      compact: compact(a),
      full: toFullPinyin(a),
      init: toInitials(a),
    }));

  const idx = {
    name,
    nameLower: normalize(name),
    nameCompact: compact(name),
    nameFull: toFullPinyin(name),
    nameInit: toInitials(name),
    aliases,
    descLower: normalize(descRaw),
    // 描述拼音惰性计算：只有真正需要描述兜底匹配时才付这份开销
    descFull: null,
  };
  indexCache.set(cacheKey, idx);
  return idx;
}

/** 惰性补全描述拼音（沿用索引对象自身做缓存） */
function withDescPinyin(idx) {
  if (idx.descFull === null) {
    idx.descFull = toFullPinyin(idx.descLower);
  }
  return idx;
}

/**
 * 计算单条指令与查询词的匹配得分
 * @param {object} idx buildIndex 产物
 * @param {string} q 已归一化的查询词
 * @param {boolean} matchDescription 是否把描述纳入检索
 * @returns {{score:number, hit:{type:string,text:string}}|null} 命中信息；null 表示不匹配
 */
function scoreOne(idx, q, matchDescription) {
  const {
    enablePinyin,
    aliasMatch,
    minInitialsLen,
    minFullPinyinLen,
    minDescriptionLen,
    score: S,
  } = COMMAND_SEARCH_CONFIG;
  let best = 0;
  let hit = null;
  /** 记录更优命中：仅当分数更高时覆盖，从而自然实现「名称 > 别名 > 拼音 > 描述」的优先级 */
  const take = (score, type, text) => {
    if (score > best) {
      best = score;
      hit = { type, text };
    }
  };

  // ---------- 1. 指令名直接匹配：完全相等 > 前缀 > 包含 ----------
  if (idx.nameLower === q) take(S.nameExact, 'name', idx.name);
  else if (idx.nameLower.startsWith(q)) take(S.namePrefix, 'name', idx.name);
  else if (idx.nameCompact.includes(q)) take(S.nameContains, 'name', idx.name);

  // ---------- 2. 别名匹配（原文 + 拼音），按配置决定是否检索英文别名 ----------
  // 默认 aliasMatch='chinese'：只认含中文的别名。
  // 英文别名（attack/lock/pickup…）是给后端指令引擎用的，若参与检索，
  // 输入 "ck" 会因为 lock/unlock/pickup/attack 都包含 ck 而命中一堆无关指令。
  if (aliasMatch !== 'none') {
    for (const a of idx.aliases) {
      if (aliasMatch === 'chinese' && !a.isZh) continue;
      // 2.1 别名原文：完全相等 > 前缀 > 包含
      if (a.lower === q) take(S.aliasExact, 'alias', a.raw);
      else if (a.lower.startsWith(q)) take(S.aliasPrefix, 'alias', a.raw);
      else if (a.compact.includes(q)) take(S.aliasContains, 'alias', a.raw);
      // 2.2 别名拼音（只有中文别名的全拼/首字母才有检索价值）
      if (enablePinyin) {
        if (q.length >= minFullPinyinLen && a.full) {
          if (a.full.startsWith(q)) take(S.aliasPinyinPrefix, 'alias-pinyin', a.raw);
          else if (a.full.includes(q)) take(S.aliasPinyinContains, 'alias-pinyin', a.raw);
        }
        if (q.length >= minInitialsLen && a.init) {
          if (a.init === q) take(S.aliasInitialsExact, 'alias-initials', a.raw);
          else if (a.init.startsWith(q)) take(S.aliasInitialsPrefix, 'alias-initials', a.raw);
          else if (a.init.includes(q)) take(S.aliasInitialsContains, 'alias-initials', a.raw);
        }
      }
    }
  }

  // ---------- 3. 指令名拼音匹配（可在配置中整体关闭） ----------
  if (enablePinyin) {
    // 3.1 全拼（beibao → 背包）：过短输入命中面太大，需达到最小长度
    if (q.length >= minFullPinyinLen && idx.nameFull) {
      if (idx.nameFull.startsWith(q)) take(S.namePinyinPrefix, 'pinyin', idx.nameFull);
      else if (idx.nameFull.includes(q)) take(S.namePinyinContains, 'pinyin', idx.nameFull);
    }
    // 3.2 首字母（bb → 背包、bb → 资源背包 zybb）：单字母噪音极大，需达到最小长度
    if (q.length >= minInitialsLen && idx.nameInit) {
      if (idx.nameInit === q) take(S.nameInitialsExact, 'initials', idx.nameInit);
      else if (idx.nameInit.startsWith(q)) take(S.nameInitialsPrefix, 'initials', idx.nameInit);
      else if (idx.nameInit.includes(q)) take(S.nameInitialsContains, 'initials', idx.nameInit);
    }
  }

  // ---------- 4. 描述兜底匹配（分数最低，仅补充长尾候选） ----------
  if (matchDescription && q.length >= minDescriptionLen && idx.descLower) {
    if (idx.descLower.includes(q)) take(S.descContains, 'desc', idx.descLower);
    // 描述拼音只做全拼包含：描述首字母串很长，用首字母匹配几乎必中，噪音过大故不启用。
    // 且仅在尚未命中更高分时才计算（描述拼音惰性转换，避免为每条指令都转一遍拼音）
    if (enablePinyin && q.length >= minFullPinyinLen && best < S.descPinyin) {
      const full = withDescPinyin(idx).descFull;
      if (full && full.includes(q)) take(S.descPinyin, 'desc-pinyin', idx.descLower);
    }
  }

  return hit ? { score: best, hit } : null;
}

/**
 * 检索指令列表，按相关度降序返回
 * @param {Array} list 指令数组 [{ name, alias, description }]
 * @param {string} query 查询词（可为中文、英文、拼音全拼或首字母）
 * @param {object} [options] 检索选项
 * @param {number} [options.limit] 最多返回条数（0 或省略 = 不限制）
 * @param {boolean} [options.matchDescription] 是否把描述纳入检索（默认 true）
 * @param {boolean} [options.withMatch] 是否附带命中信息（true 时返回 { ...cmd, match } 浅拷贝）
 * @returns {Array} 命中指令数组；查询为空时按原顺序返回
 */
export function searchCommands(list, query, options = {}) {
  const source = Array.isArray(list) ? list : [];
  const { limit = 0, matchDescription = true, withMatch = false } = options;
  const take = (arr) => (limit > 0 ? arr.slice(0, limit) : arr);
  const q = normalize(query);
  // 空查询：不打分，按原顺序返回（保持原有「清空搜索框即展示全部指令」的行为）
  if (!q) return take(source.slice());

  const scored = [];
  source.forEach((cmd, order) => {
    if (!cmd || !cmd.name) return;
    const res = scoreOne(buildIndex(cmd), q, matchDescription);
    if (res) scored.push({ cmd, order, score: res.score, hit: res.hit });
  });
  // 相关度降序；同分时用原始下标兜底，保证排序稳定（Node/浏览器 sort 均稳定，此处双保险）
  scored.sort((a, b) => b.score - a.score || a.order - b.order);

  const result = scored.map((it) => (withMatch ? { ...it.cmd, match: it.hit } : it.cmd));
  return take(result);
}

/**
 * 生成命中提示文案（用于下拉项展示，如「首字母 bbss」）
 * @param {{type:string,text:string}} match searchCommands(withMatch) 返回的命中信息
 * @returns {string} 提示文案；无命中信息时返回空串
 */
export function hitLabel(match) {
  if (!match || !match.type || match.type === 'name') return '';
  const label = HIT_TYPE_LABELS[match.type] || '';
  return label ? `${label} ${match.text}` : '';
}
