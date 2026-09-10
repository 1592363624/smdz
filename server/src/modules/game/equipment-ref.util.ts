/**
 * 装备引用解析单一实现（2026-09-10）。
 *
 * 背景：玩家在背包里看到的装备显示名是「基础名 + 品质码 + 可选·特效」
 * （如 冰雹S / 冰雹S·纯洁无瑕，见 item.service.formatEquipmentInventoryDisplay），
 * 而背包条目里 item.name 只存基础名（冰雹），品质码在 item.data 首字符（s）。
 * 因此「按玩家输入定位装备」这件事必须有一套统一口径，禁止各指令各自写正则：
 *   - 曾经 game.service.handleEquip 内联了一份「末尾字母品质码」解析，
 *     锁定/解锁却只支持整名精确匹配，导致「锁定装备冰雹S」永远提示找不到；
 *   - 两份解析并存 = 双重表示，后续任何一处修 bug 都会漏掉另一处。
 *
 * 本模块对外只提供两个能力：
 *   1. parseEquipmentRef：把玩家输入文本解析成「基础名 + 品质码」候选（纯语法，不查数据）；
 *   2. resolveEquipmentRefIndexes：在背包里按候选顺序定位条目索引（单一匹配口径）。
 *
 * 匹配优先级（先命中先返回，命中即止）：
 *   A. 条目名 === 原始输入（历史脏数据 / 非装备条目兼容）；
 *   B. 条目名 === 基础名 且 品质码 === 候选品质（带品质码时**不降级**到任意品质，
 *      避免「矢量S」误穿成背包里第一件任意品质的矢量——2026-09-06 品质错配事故）；
 *   C. 输入含「·特效后缀」时，条目名 === 去掉后缀的核心串；
 *   D. 装备显示全名 === 原始输入（formatEquipmentInventoryDisplay 口径）。
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

/** 品质码 → 品质名（反向表，由正向表派生，禁各自再抄一份） */
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

/** 读取条目的品质码（data 首字符小写；无 data 视为空串） */
export function equipmentQualityCode(item: any): string {
  return String(item?.data ?? item?.数据 ?? '').charAt(0).toLowerCase();
}

/** 是否为装备条目（type 缺失/空的历史条目按装备处理，避免漏匹配） */
export function isEquipmentEntry(item: any): boolean {
  const type = String(item?.type ?? item?.类型 ?? '').trim();
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

/** 解析选项 */
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
  const nameOf = (item: any): string => String(item?.name ?? item?.名称 ?? '');

  const pick = (predicate: (item: any) => boolean): number[] =>
    pool.filter(({ item }) => predicate(item)).map(({ index }) => index);

  // A. 整名精确匹配
  const exact = pick((item) => nameOf(item) === ref.raw);
  if (exact.length > 0) return exact;

  // B. 基础名 + 品质码（带品质码时不降级到任意品质）
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

/**
 * 首件匹配下标（装备/分解等单件语义指令）；无匹配返回 -1。
 */
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
 * 按**装备实例**（基础名 + data 品质码）在背包中定位首件下标，无匹配返回 -1。
 *
 * 用于「按已存档条目还原装备」的场景（装备预设加载）：预设条目自带 data 品质码，
 * 只按基础名取第一件会把同名不同品质的装备张冠李戴（预设存的是 S，加载回来成了 A）。
 * 品质码一致才算命中；实例无 data 时退化为仅基础名匹配（兼容历史预设数据）。
 */
export function findEquipmentIndexByInstance(
  backpack: any[],
  instance: { name?: string; 名称?: string; data?: string; 数据?: string },
  options: { equipmentOnly?: boolean } = {},
): number {
  const name = String(instance?.name ?? instance?.名称 ?? '').trim();
  if (!name) return -1;

  const equipmentOnly = options.equipmentOnly !== false;
  const pool = (Array.isArray(backpack) ? backpack : [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !equipmentOnly || isEquipmentEntry(item));
  const nameOf = (item: any): string => String(item?.name ?? item?.名称 ?? '');

  const quality = equipmentQualityCode(instance);
  if (quality) {
    const hit = pool.find(({ item }) => nameOf(item) === name && equipmentQualityCode(item) === quality);
    if (hit) return hit.index;
  }
  const fallback = pool.find(({ item }) => nameOf(item) === name);
  return fallback ? fallback.index : -1;
}
