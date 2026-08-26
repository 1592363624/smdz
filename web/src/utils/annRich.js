/**
 * 系统公告富文本解析器（Markdown 子集 → 结构化 token）
 *
 * 设计要点：
 * - 输出 token 数组而非 HTML 字符串：前端用 <template> 按 token 类型结构化渲染，
 *   不经过 v-html / innerHTML，天然免疫 XSS（URL 白名单校验 + 文本节点原样输出）。
 * - 支持语法：
 *     [文字](https://链接)          超链接
 *     ![图片描述](https://图片.png) 图片
 *     **粗体**  *斜体*  `行内代码` ~~删除线~~
 *     换行直接生效（按行切分段落）
 * - 兼容裸 URL：未加语法的 http(s) 链接自动识别为可点击链接。
 * - 兼容旧版纯文本公告（无任何标记时整段按纯文本渲染）。
 */

/// 协议白名单：仅允许安全协议，防 javascript:/data: 等危险 scheme
const SAFE_PROTOCOLS = ['http:', 'https:'];

/** 校验 URL 是否安全可点击/可加载 */
function isSafeUrl(url) {
  try {
    return SAFE_PROTOCOLS.includes(new URL(url, window.location.origin).protocol);
  } catch {
    return false;
  }
}

/**
 * 行内解析：把一行文本切成 inline token 流
 * 支持：图片、链接、粗体、斜体、行内代码、删除线、裸 URL
 */
function parseInline(line) {
  const tokens = [];
  // 正则说明：图片 → 链接 → 行内代码 → 粗体 → 斜体 → 删除线 → 裸URL，从左到右优先匹配
  const re =
    /(!\[([^\]]*)\]\(([^)\s]+)\))|(\[([^\]]+)\]\(([^)\s]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(~~([^~]+)~~)|(https?:\/\/[^\s<>()\[\]{}"']+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) {
      pushText(tokens, line.slice(last, m.index));
    }
    if (m[1]) {
      // 图片
      const url = m[3];
      tokens.push({ t: 'img', src: url, alt: m[2], safe: isSafeUrl(url) });
    } else if (m[4]) {
      // 链接
      const url = m[6];
      tokens.push({ t: 'link', href: url, text: m[5], safe: isSafeUrl(url) });
    } else if (m[7]) {
      // 行内代码
      tokens.push({ t: 'code', text: m[8] });
    } else if (m[9]) {
      // 粗体
      tokens.push({ t: 'bold', children: parseInline(m[10]) });
    } else if (m[11]) {
      // 斜体
      tokens.push({ t: 'italic', children: parseInline(m[12]) });
    } else if (m[13]) {
      // 删除线
      tokens.push({ t: 'strike', children: parseInline(m[14]) });
    } else if (m[15]) {
      // 裸 URL：自动识别为可点击链接
      const url = m[15];
      tokens.push({ t: 'link', href: url, text: url, safe: isSafeUrl(url) });
    }
    last = re.lastIndex;
  }
  if (last < line.length) {
    pushText(tokens, line.slice(last));
  }
  return tokens;
}

/** 追加文本 token（与相邻文本合并，减少 token 数量） */
function pushText(tokens, text) {
  if (!text) return;
  const prev = tokens[tokens.length - 1];
  if (prev && prev.t === 'text') prev.text += text;
  else tokens.push({ t: 'text', text });
}

/**
 * 解析公告全文为块级 token 列表
 * @returns {Array<{t:'p',children:Array}>|Array<{t:'img-block',...}>}
 */
export function parseAnnouncement(content) {
  if (typeof content !== 'string' || !content) return [];
  const blocks = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue; // 空行跳过
    blocks.push({ t: 'p', children: parseInline(line) });
  }
  return blocks;
}

export { isSafeUrl };
