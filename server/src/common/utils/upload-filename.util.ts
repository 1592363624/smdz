/**
 * 上传文件命名工具（公告配图 / 反馈附件共用，单一实现）
 *
 * 背景（2026-09-10 事故）：
 * multer 的 diskStorage 原先直接用 `extname(originalname)` 作为落盘扩展名。
 * 剪贴板截图、拖拽粘贴得到的 File 常常没有扩展名（originalname 为 "image" / "blob" / 空串），
 * 落盘文件名随之丢失后缀；静态服务只能按扩展名推断 Content-Type，无后缀会返回
 * application/octet-stream，浏览器 <img> 会拒绝渲染 → 图片显示为裂图。
 * 因此：原始文件名无扩展名时，按 MIME 兜底补一个。
 *
 * 命名规则：时间戳 + 随机串 + 扩展名（避免中文/空格/重名问题）。
 */
import { extname } from 'path';

/** MIME → 扩展名兜底映射（仅覆盖常见的图片类型，其余保持原行为） */
export const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
};

/**
 * 生成落盘文件名
 * @param originalname 原始文件名（可能为空、可能无扩展名）
 * @param mimetype     文件 MIME 类型（用于扩展名兜底）
 */
export function buildUploadFilename(originalname?: string, mimetype?: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  let ext = extname(originalname || '').toLowerCase();
  if (!ext && mimetype) {
    ext = MIME_EXTENSION_MAP[mimetype.toLowerCase()] || '';
  }
  return `${Date.now()}_${random}${ext}`;
}
