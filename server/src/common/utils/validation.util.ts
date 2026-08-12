/**
 * 名称校验工具
 * 提供名称合法性校验、输入净化等通用函数
 * 对应原版易语言：文本操作.ecode 中的名称符合规范()
 */

/**
 * 敏感词列表（示例，可根据实际需要扩展）
 */
const SENSITIVE_WORDS: string[] = [
  '管理员', '系统', '客服', 'GM', 'admin', 'root',
];

/**
 * 非法字符正则
 * 原版中禁止的字符：# ! ` \r \n @ & ^ %
 */
const ILLEGAL_CHAR_REGEX = /[#!`\r\n@&^%]/;

/**
 * 名称长度限制
 */
const MIN_NAME_LENGTH = 1;
const MAX_NAME_LENGTH = 16;

/**
 * 校验名称是否合法
 * 对应原版：名称符合规范()
 * @param name 待校验的名称
 * @returns 校验结果，包含是否合法及原因
 */
export function validateName(name: string): { valid: boolean; reason: string } {
  // 检查空值
  if (!name || name.trim().length === 0) {
    return { valid: false, reason: '名称不能为空' };
  }

  // 检查长度
  if (name.length < MIN_NAME_LENGTH) {
    return { valid: false, reason: `名称长度不能小于${MIN_NAME_LENGTH}个字符` };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { valid: false, reason: `名称长度不能超过${MAX_NAME_LENGTH}个字符` };
  }

  // 检查非法字符（原版规则）
  if (ILLEGAL_CHAR_REGEX.test(name)) {
    if (name.includes('#')) return { valid: false, reason: '名称不能包含#' };
    if (name.includes('!')) return { valid: false, reason: '名称不能包含英文感叹号' };
    if (name.includes('`')) return { valid: false, reason: '名称不能包含`' };
    if (name.includes('\r') || name.includes('\n')) return { valid: false, reason: '名称不能包含换行符' };
    if (name.includes('@')) return { valid: false, reason: '名称不能包含@' };
    if (name.includes('&')) return { valid: false, reason: '名称不能包含&' };
    if (name.includes('^')) return { valid: false, reason: '名称不能包含^' };
    if (name.includes('%')) return { valid: false, reason: '名称不能包含%' };
    return { valid: false, reason: '名称包含非法字符' };
  }

  // 检查敏感词
  for (const word of SENSITIVE_WORDS) {
    if (name.toLowerCase().includes(word.toLowerCase())) {
      return { valid: false, reason: '名称包含敏感词汇' };
    }
  }

  return { valid: true, reason: '' };
}

/**
 * 净化输入文本
 * 移除非法字符，防止注入
 * 对应原版中对输入文本的净化处理
 * @param input 原始输入
 * @returns 净化后的文本
 */
export function sanitizeInput(input: string): string {
  if (!input) return '';

  let sanitized = input;

  // 替换等号（原版规则：替换为【等号】）
  sanitized = sanitized.replace(/=/g, '【等号】');

  // 移除非法字符
  sanitized = sanitized.replace(/[#!`\r\n@&^%]/g, '');

  // 移除多余空白
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  return sanitized;
}