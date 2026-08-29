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
  const rounded = Math.round(prof * 100) / 100;
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
