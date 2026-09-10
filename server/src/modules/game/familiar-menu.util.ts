/**
 * 使魔选择/更换相关菜单文本构建器（纯函数，无副作用）。
 *
 * 对应原版 _主程序.ecode：
 * - 新玩家门禁列表（L11464-11480，原版发任意消息被拦截后返回）
 * - 选择使魔预览（L786-792：名称(好感N)/技能等级/说明2/「1、选择 2、返回」）
 * - 更换使魔列表（L766-775：已拥有使魔两列编号列表）
 *
 * 两列编号菜单对应原版 叠加2 子程序（解码源码中定义缺失，按游玩实例还原）：
 * 每行两项，列1按显示宽度（中文=2）补空格到 13 列后接制表符，编号右对齐 2 位。
 */

// 数值收敛唯一实现（两位小数），禁手写 Math.round 副本
import { roundItemQuantity } from '../../common/utils/game-text.util';

/** 每行两列时列1的显示宽度（含编号），超出则不补空格直接接制表符 */
const TWO_COLUMN_WIDTH = 13;

/** 计算字符串显示宽度：CJK 字符（含全角标点）记 2，其余记 1 */
export function textDisplayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK 统一表意文字、全角形式、CJK 标点、假名等常用区段按 2 计
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += isWide ? 2 : 1;
  }
  return width;
}

/**
 * 原版 显示熟练度等级（数据显示.ecode L1640-1660）：
 * 等级 = 满足 熟练度 < 等级² 的最小等级（从 1 起），文本返回 "等级(熟练度/等级²)"，
 * 如熟练度 0 → "1(0/1)"。
 */
export function formatSkillLevelText(proficiency: number): string {
  const prof = Math.max(0, Number(proficiency) || 0);
  let level = 1;
  while (prof >= level * level) level += 1;
  const rounded = roundItemQuantity(prof);
  return `${level}(${rounded}/${level * level})`;
}

/**
 * 两列编号菜单（叠加2 还原）。entries 为 "编号、名称" 数组，
 * 编号自动右对齐 2 位（" 1、" / "10、"），列1补空格到固定显示宽度后接制表符。
 */
export function buildTwoColumnMenu(entries: string[]): string {
  const lines: string[] = [];
  const normalize = (entry: string): string => {
    const match = entry.match(/^(\d+)、([\s\S]*)$/);
    if (!match) return entry;
    return `${match[1].padStart(2, ' ')}、${match[2]}`;
  };
  for (let i = 0; i < entries.length; i += 2) {
    const left = normalize(entries[i]);
    const right = i + 1 < entries.length ? normalize(entries[i + 1]) : '';
    if (!right) {
      lines.push(left);
      break;
    }
    const pad = Math.max(0, TWO_COLUMN_WIDTH - textDisplayWidth(left));
    lines.push(`${left}${' '.repeat(pad)}\t${right}`);
  }
  return lines.join('\n');
}

/** 新玩家门禁列表（原版 L11467-11480）：返回菜单文本与临时输入替换串 */
export function buildFamiliarGateMenu(summonableFamiliars: Array<{ name?: string }>): {
  text: string;
  tempInput: string;
} {
  const names = summonableFamiliars
    .map((f) => String(f.name || '未知'))
    .filter((name) => name !== '未知');
  const entries = names.map((name, i) => `${i + 1}、${name}`);
  const tempInput = names.map((name, i) => `${i + 1}@选择使魔${name}`).join('#');
  const text = [
    '选择你的第一个使魔来开始游戏：',
    '发送数字来进行选择',
    buildTwoColumnMenu(entries),
  ].join('\n');
  return { text, tempInput };
}

/* ==================== 使魔契约引导页（Web）结构化 DTO ==================== */

/** 专精归一后的元素键（前端据此上色；仅作展示层分类，不参与任何战斗计算） */
export type FamiliarElementKey = 'thunder' | 'fire' | 'ice' | 'physical' | 'none';

/** 使魔契约选择页的单张卡片数据（由 familiars.json 派生，纯读、不落库） */
export interface FamiliarGateEntry {
  /** 使魔名称（= 首次选择时写入 player.type/baseName 的值） */
  name: string;
  /** 特殊序号（原版常量表序号） */
  specialSeq: number;
  /** 特有技能名（主动技能，如「啾啾猫猫！」） */
  uniqueSkill: string;
  /** 定位标签（description2「定位」字段，复合定位如「辅助/输出」拆成两项） */
  roleTags: string[];
  /** 专精原文（description2「专精」字段；原版取值包含「雷电/火焰/无/物理/制造/远程武器」等） */
  specialty: string;
  /** 操作难度原文（超超低/低/中/高/超高/超超超高） */
  difficulty: string;
  /** 操作难度星级 1~5（1=最易上手，前端画点用；未知按 3） */
  difficultyLevel: number;
  /** 优点标签（description2「优点」字段按顿号切分） */
  merits: string[];
  /** 元素归一键（由全部文本关键字统计得出，用于卡片配色） */
  elementKey: FamiliarElementKey;
  /** 特性全文（description，含换行） */
  trait: string;
  /** 主动/被动技能说明全文（skillDesc，含换行） */
  skillDesc: string;
  /** 背景/设计行（description2 中非结构化的首行；可能为空） */
  flavor: string;
  /** 好感度逐档解锁的能力描述（affinityDesc，最多 5 档，含换行） */
  awaken: string[];
}

/** 操作难度 → 星级（1 最易 ~ 5 最难）。未列举的值按关键字降级推断。 */
const DIFFICULTY_LEVELS: Record<string, number> = {
  超超低: 1,
  超低: 1,
  极低: 1,
  低: 2,
  较低: 2,
  中: 3,
  中等: 3,
  较高: 4,
  高: 4,
  超高: 5,
  超超高: 5,
  超超超高: 5,
};

/** 原版换行哨兵 → 真换行（文本渠道唯一约定，禁各处手写 replace） */
export function plainGameText(raw: unknown): string {
  return String(raw ?? '').replace(/#换行/g, '\n');
}

/** 元素关键字 → 归一键。同一使魔命中多系时取出现次数最多者，平手按 雷 > 火 > 冰 > 物。 */
function resolveElementKey(...texts: string[]): FamiliarElementKey {
  const hay = texts.join('\n');
  const groups: Array<{ key: FamiliarElementKey; re: RegExp }> = [
    { key: 'thunder', re: /[雷电]/g },
    { key: 'fire', re: /[火焰]/g },
    { key: 'ice', re: /冰/g },
    { key: 'physical', re: /物/g },
  ];
  let best: { key: FamiliarElementKey; n: number } | null = null;
  for (const g of groups) {
    const n = (hay.match(g.re) || []).length;
    if (n > 0 && (!best || n > best.n)) best = { key: g.key, n };
  }
  return best ? best.key : 'none';
}

/**
 * 解析 description2 的结构化字段。
 * 原版格式（#换行 分节，节内两空格分隔）：
 *   [可选故事行]
 *   定位:辅助    专精:雷电
 *   优点:全体复活、全体回复、…
 *   操作难度:超超低
 * 解析失败的节一律归入 flavor（绝不丢内容）。
 */
/**
 * 是否为由原版作者留下的「设计:」署名行。
 *
 * 说明2 中有部分使魔带 `设计:某某(QQ前缀**)` 的作者署名，文本渠道（选择使魔预览）原样输出，
 * 但对玩家首屏的引导页属于噪声——Web DTO 在展示层剥掉它，**不代表源数据缺失**，
 * 修改内容时不要反过来去动 familiars.json。
 */
function isDesignCredit(line: string): boolean {
  return /^设计\s*[:：]/.test(line);
}

function parseStyleSection(description2: unknown): {
  roleTags: string[];
  specialty: string;
  merits: string[];
  difficulty: string;
  flavor: string;
} {
  const sections = plainGameText(description2)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const roleTags: string[] = [];
  let specialty = '';
  const merits: string[] = [];
  let difficulty = '';
  const flavorLines: string[] = [];

  /** 结构化字段关键字（任一命中即按结构化节处理） */
  const STRUCTURED_RE = /(定位|专精|优点|操作难度)\s*[:：]/;

  for (const line of sections) {
    // 存量数据存在「叙述与字段粘连」的写法（如伊芙利特「…恢复如初定位:输出    专精:火焰」），
    // 故此处不要求关键字位于行首：关键字之前的残留文本归入 flavor，绝不丢弃。
    const kwIdx = line.search(STRUCTURED_RE);
    if (kwIdx < 0) {
      if (!isDesignCredit(line)) flavorLines.push(line);
      continue;
    }
    const leading = line.slice(0, kwIdx).trim();
    if (leading && !isDesignCredit(leading)) flavorLines.push(leading);

    const role = line.match(/定位\s*[:：]\s*([^\s专]+)/);
    if (role) {
      for (const tag of role[1].split(/[/／]/)) {
        const t = tag.trim();
        if (t && !roleTags.includes(t)) roleTags.push(t);
      }
    }
    const spec = line.match(/专精\s*[:：]\s*([^\s优]+)/);
    if (spec) specialty = spec[1].trim();
    // 「优点」可能与其后的结构化字段同处一行（#换行 缺失时），用前瞻截断避免吞掉别的字段
    const merit = line.match(/优点\s*[:：]\s*(.+?)(?=\s*(?:定位|专精|操作难度)\s*[:：]|$)/);
    if (merit) {
      for (const item of merit[1].split(/[、,，]/)) {
        const t = item.trim();
        if (t && !merits.includes(t)) merits.push(t);
      }
    }
    const diff = line.match(/操作难度\s*[:：]\s*(\S+)/);
    if (diff) difficulty = diff[1].trim();
  }

  return { roleTags, specialty, merits, difficulty, flavor: flavorLines.join('\n') };
}

/** 难度星级：先查表，未列举时按「低/高」关键字降级推断，全无命中按 3（中性）。 */
function resolveDifficultyLevel(difficulty: string): number {
  const exact = DIFFICULTY_LEVELS[difficulty];
  if (exact) return exact;
  if (!difficulty) return 3;
  if (difficulty.includes('低')) return 2;
  if (difficulty.includes('高')) return 4;
  return 3;
}

/**
 * 使魔契约引导页 DTO 构建（纯函数）。
 * 入参须为「已过滤 noSummon」的使魔定义数组，顺序即展示顺序——
 * 与文本门禁 `buildFamiliarGateMenu` 的编号一一对应（同一份 getAllFamiliars 原始序），
 * 保证 Web 引导页与 QQ/AstrBot 文本菜单列出的使魔集合、编号完全一致。
 */
export function buildFamiliarGateDetail(familiars: Array<Record<string, any>>): FamiliarGateEntry[] {
  return familiars.map((f) => {
    const style = parseStyleSection(f?.description2);
    const trait = plainGameText(f?.description);
    const skillDesc = plainGameText(f?.skillDesc);
    const awaken = (Array.isArray(f?.affinityDesc) ? f.affinityDesc : [])
      .map((t: unknown) => plainGameText(t))
      .filter((t: string) => t !== '');
    const rawSpecialSeq = Number(f?.specialSeq);
    return {
      name: String(f?.name ?? '未知'),
      specialSeq: Number.isFinite(rawSpecialSeq) ? rawSpecialSeq : 0,
      uniqueSkill: String(f?.uniqueSkill ?? ''),
      roleTags: style.roleTags,
      specialty: style.specialty,
      difficulty: style.difficulty,
      difficultyLevel: resolveDifficultyLevel(style.difficulty),
      merits: style.merits,
      elementKey: resolveElementKey(String(f?.description2 ?? ''), trait, skillDesc, style.specialty),
      trait,
      skillDesc,
      flavor: style.flavor,
      awaken,
    };
  });
}

/** 老玩家更换使魔列表（原版 L766-775）：返回菜单文本与临时输入替换串 */
export function buildFamiliarSwitchMenu(
  playerName: string,
  ownedNames: string[],
): { text: string; tempInput: string } {
  const entries = ownedNames.map((name, i) => `${i + 1}、${name}`);
  const tempInput = ownedNames.map((name, i) => `${i + 1}@更换使魔${name}`).join('#');
  const lines = [
    `${playerName}选择你想更换的使魔，背包和等级等数据不会清空`,
  ];
  if (entries.length > 0) {
    lines.push(buildTwoColumnMenu(entries));
  }
  lines.push('你可以发送「召唤使魔」来解锁更多可更换的使魔');
  return { text: lines.join('\n'), tempInput };
}

/**
 * 教程任务领取提示块（原版 _主程序.ecode L11686-11706 每条消息结算段）：
 * 每领取一个教程任务输出一行「领取了X，可以发送“查看任务”来查看」+ 分隔线，
 * 原版按 新手→进阶 顺序逐条前插，最终显示顺序为 进阶 在上、新手 在下。
 * @param addedNames 本次实际领取的任务名（按领取顺序，如 ['新手教程','进阶教程']）
 */
export function buildTutorialClaimBlock(addedNames: string[]): string {
  if (!addedNames || addedNames.length === 0) return '';
  const lines: string[] = [];
  for (const taskName of [...addedNames].reverse()) {
    lines.push(`领取了${taskName}，可以发送“查看任务”来查看`);
    lines.push('————————');
  }
  // 末尾分隔线与后续正文（如“选择为X开始游戏”）之间由调用方拼接，此处保留尾换行语义
  return lines.join('\n') + '\n';
}

/**
 * 选择使魔预览（原版 L786-792）：
 * 名称(好感N) / 技能等级:X(经验/需求) / 说明2 全文 / 「1、选择 2、返回」菜单。
 * 原版首行为使魔图片（取图片），网页文本渠道无图片通道，此处省略。
 */
export function buildFamiliarPreview(
  familiar: { name?: string; description2?: string },
  affinity: number,
  skillProficiency: number,
): { text: string; tempInput: string } {
  const name = String(familiar.name || '未知');
  const brief = String(familiar.description2 || '').replace(/#换行/g, '\n');
  const lines = [
    `${name}(好感${Math.round(Number(affinity) || 0)})`,
    `技能等级:${formatSkillLevelText(skillProficiency)}`,
    brief,
    '1、选择\t\t2、返回',
  ].filter((line) => line !== '');
  return {
    text: lines.join('\n'),
    tempInput: `1@选择使魔确认${name}#2@更换使魔#选择@选择使魔确认${name}#返回@更换使魔`,
  };
}
