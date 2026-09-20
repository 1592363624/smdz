/**
 * 装备引用解析的单一实现：把玩家输入定位到背包装备条目，禁止各指令各自写正则。
 * 背包显示名为「基础名 + 品质码 + 可选·特效」（如 冰雹S·纯洁无瑕，见
 * item.service.formatEquipmentInventoryDisplay），而 item.name 只存基础名（冰雹）、品质码在
 * item.data 首字符（s），因此解析与匹配口径必须统一；匹配优先级 A→D 见 resolveEquipmentRefIndexes。
 */

/** 品质名 → 品质码（品质码 = 装备数据串 data 的首字符，小写） */
export const QUALITY_CODE_BY_NAME: Record<string, string> = {
  神迹: 'x',
  传说: 's',
  史诗: 'a',
  精良: 'b',
  优秀: 'c',
  良好: 'd',
  普通: 'e',
};

/** 品质码 → 品质名（反向表，禁各自再抄一份） */
export const QUALITY_NAME_BY_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(QUALITY_CODE_BY_NAME).map(([name, code]) => [code, name]),
);

/** 合法品质码集合（e/d/c/b/a/s/x） */
const QUALITY_CODES = new Set(Object.keys(QUALITY_NAME_BY_CODE));

/** 输入中「基础名 + 品质码」的解析候选 */
export interface EquipmentRefCandidate {
  /** 基础名（已去掉品质码与·特效后缀） */
  baseName: string;
  /** 品质码（小写字母） */
  quality: string;
}

/** 玩家输入解析结果 */
export interface EquipmentRef {
  /** 原始输入（已 trim） */
  raw: string;
  /** 去掉末尾「·特效」后的核心串 */
  core: string;
  /** 候选（按优先级），无品质信息时为空数组 */
  candidates: EquipmentRefCandidate[];
}

/** 读取条目的品质码（data 首字符小写；无 data / 非法码视为空串） */
export function equipmentQualityCode(item: any): string {
  return qualityCodeFromData(item?.data);
}

/**
 * 数据串 → 品质码（首字符小写）；非法/缺失一律返回**空串**。
 *
 * 原版唯一的装备构造入口「生成装备」（物品操作.ecode L1128-1261）保证 data 首字符恒为
 * 品质码（e/d/c/b/a/s/x），因此空串 = **异常数据**。各调用方**不得**自行回落成某个档位：
 * 回落「神迹」会把白板显示成最高品质，回落「普通」则与实际不符。
 */
export function qualityCodeFromData(data: unknown): string {
  const c = String(data ?? '').charAt(0).toLowerCase();
  return QUALITY_NAME_BY_CODE[c] ? c : '';
}

/** 品质展示标签：**大写品质码**（E/D/C/B/A/S/X，与背包显示名「冰雹S」同套），非法/缺失返回空串 */
export function equipmentQualityLabel(data: unknown): string {
  return qualityCodeFromData(data).toUpperCase();
}

/** 品质中文名（普通/良好/优秀/精良/史诗/传说/神迹），非法/缺失返回空串 */
export function equipmentQualityName(data: unknown): string {
  return QUALITY_NAME_BY_CODE[qualityCodeFromData(data)] ?? '';
}

/**
 * 品质 → 词条倍率（原版 生成装备 L1174-1192）：
 * e=1 / d=2 / c=3 / b=4 / a=6 / s=9，**其余码走原版默认分支 = 神迹 12 倍**。
 */
export const AFFIX_MULT_BY_QUALITY: Record<string, number> = { e: 1, d: 2, c: 3, b: 4, a: 6, s: 9 };

/** 品质码 → 词条倍率（未列举码 = 原版默认分支神迹 12） */
export function affixMultiplier(code: unknown): number {
  return AFFIX_MULT_BY_QUALITY[String(code ?? '').toLowerCase()] ?? 12;
}

/** 是否为装备条目（type 缺失/空的历史条目按装备处理，避免漏匹配） */
export function isEquipmentEntry(item: any): boolean {
  const type = String(item?.type ?? '').trim();
  return type === '' || type === '装备';
}

function pushCandidate(
  bucket: EquipmentRefCandidate[],
  baseName: string,
  quality: string | undefined | null,
): void {
  const name = String(baseName ?? '').trim();
  const code = String(quality ?? '').trim().toLowerCase();
  if (!name || !QUALITY_CODES.has(code)) return;
  if (bucket.some((c) => c.baseName === name && c.quality === code)) return;
  bucket.push({ baseName: name, quality: code });
}

/**
 * 解析玩家输入的装备引用文本（纯语法，不依赖背包数据）。
 * 支持形态：冰雹 / 冰雹S / 冰雹s / 冰雹[传说] / 冰雹[S] / 冰雹传说 / 冰雹S·纯洁无瑕
 */
export function parseEquipmentRef(input: string): EquipmentRef {
  const raw = String(input ?? '').trim();
  // 剥掉末尾「·特效」（最后一个 · 之后的内容）
  const core = raw.replace(/·[^·]*$/, '').trim();
  const candidates: EquipmentRefCandidate[] = [];

  if (core) {
    // 1) 中括号品质：冰雹[传说] / 冰雹[S]
    const bracket = core.match(/^(.+?)\[([^\]]+)\]$/);
    if (bracket) {
      const inner = bracket[2].trim();
      pushCandidate(candidates, bracket[1], QUALITY_CODE_BY_NAME[inner] ?? inner.charAt(0));
    }
    // 2) 末尾单字母品质码：冰雹S（优先级最高，与背包显示名一致）
    pushCandidate(candidates, core.slice(0, -1), core.slice(-1));
    // 3) 末尾中文品质词：冰雹传说（长词优先，避免「精良」被「良」类前缀截断）
    for (const name of Object.keys(QUALITY_CODE_BY_NAME).sort((a, b) => b.length - a.length)) {
      if (core.length > name.length && core.endsWith(name)) {
        pushCandidate(candidates, core.slice(0, core.length - name.length), QUALITY_CODE_BY_NAME[name]);
      }
    }
  }

  return { raw, core, candidates };
}

export interface ResolveEquipmentRefOptions {
  /** 装备显示全名格式化器（冰雹S·纯洁无瑕）；不传则跳过显示全名回退 */
  displayName?: (item: any) => string;
  /** 是否只匹配装备条目，默认 true */
  equipmentOnly?: boolean;
}

/**
 * 按玩家输入在背包里定位装备条目，返回**全部**匹配下标（保序）。
 * 锁定/解锁需要批量（同名同品质全锁），装备/分解需要首件——调用方自行取用。
 */
export function resolveEquipmentRefIndexes(
  backpack: any[],
  input: string,
  options: ResolveEquipmentRefOptions = {},
): number[] {
  const ref = typeof input === 'string' ? parseEquipmentRef(input) : parseEquipmentRef(String(input ?? ''));
  if (!ref.raw) return [];

  const equipmentOnly = options.equipmentOnly !== false;
  const pool = (Array.isArray(backpack) ? backpack : []).map((item, index) => ({ item, index }))
    .filter(({ item }) => !equipmentOnly || isEquipmentEntry(item));
  const nameOf = (item: any): string => String(item?.name ?? '');

  const pick = (predicate: (item: any) => boolean): number[] =>
    pool.filter(({ item }) => predicate(item)).map(({ index }) => index);

  // A. 条目名 === 原始输入整串（兼容非装备条目 / 名称本身就带品质码的数据）
  const exact = pick((item) => nameOf(item) === ref.raw);
  if (exact.length > 0) return exact;

  // B. 基础名 + 品质码（带品质码时不降级到任意品质，避免「矢量S」误穿成背包里任意品质的矢量）
  for (const candidate of ref.candidates) {
    const hit = pick(
      (item) =>
        nameOf(item) === candidate.baseName &&
        equipmentQualityCode(item) === candidate.quality,
    );
    if (hit.length > 0) return hit;
  }

  // C. 剥掉「·特效后缀」后的基础名
  if (ref.core && ref.core !== ref.raw) {
    const hit = pick((item) => nameOf(item) === ref.core);
    if (hit.length > 0) return hit;
  }

  // D. 显示全名（基础名 + 品质码 + ·特效）整段匹配
  if (options.displayName) {
    const hit = pick((item) => options.displayName!(item) === ref.raw);
    if (hit.length > 0) return hit;
  }

  return [];
}

/** 首件匹配下标（装备/分解等单件语义指令）；无匹配返回 -1。 */
export function resolveEquipmentRefIndex(
  backpack: any[],
  input: string,
  options: ResolveEquipmentRefOptions = {},
): number {
  const indexes = resolveEquipmentRefIndexes(backpack, input, options);
  return indexes.length > 0 ? indexes[0] : -1;
}

/**
 * 未命中的原因诊断（仅用于给玩家更准确的提示）：
 * 输入带品质码、且背包里存在同名装备但品质都对不上时返回对应品质名。
 */
export function describeQualityMiss(
  backpack: any[],
  input: string,
): { baseName: string; qualityName: string } | null {
  const ref = parseEquipmentRef(input);
  for (const candidate of ref.candidates) {
    const hasSameName = (Array.isArray(backpack) ? backpack : []).some(
      (item) => isEquipmentEntry(item) && String(item?.name ?? '') === candidate.baseName,
    );
    if (hasSameName) {
      return { baseName: candidate.baseName, qualityName: QUALITY_NAME_BY_CODE[candidate.quality] ?? candidate.quality };
    }
  }
  return null;
}

/**
 * 按**装备实例**（基础名 + data 品质码）定位首件下标，无匹配返回 -1；用于装备预设加载。
 * 只按基础名取第一件会把同名不同品质的装备张冠李戴（预设存 S、加载回来成了 A）；
 * 实例无 data 时退化为仅基础名匹配。
 */
export function findEquipmentIndexByInstance(
  backpack: any[],
  instance: { name?: string; data?: string },
  options: { equipmentOnly?: boolean } = {},
): number {
  const name = String(instance?.name ?? '').trim();
  if (!name) return -1;

  const equipmentOnly = options.equipmentOnly !== false;
  const pool = (Array.isArray(backpack) ? backpack : [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !equipmentOnly || isEquipmentEntry(item));
  const nameOf = (item: any): string => String(item?.name ?? '');

  const quality = equipmentQualityCode(instance);
  if (quality) {
    const hit = pool.find(({ item }) => nameOf(item) === name && equipmentQualityCode(item) === quality);
    if (hit) return hit.index;
  }
  const fallback = pool.find(({ item }) => nameOf(item) === name);
  return fallback ? fallback.index : -1;
}
