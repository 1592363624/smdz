/**
 * 维护模式中间件（部署期间向玩家展示维护页面）
 *
 * 工作方式：
 * - 部署脚本在开始部署时于服务运行目录写入 maintenance.flag 文件，部署成功后删除；
 * - 本中间件在每个请求进入 Nest 路由 / serve-static 之前检测该文件（带 2 秒缓存）；
 * - 维护激活时：
 *     - /api/docs              → 直接放行（PM2 部署健康检查依赖此端点）
 *     - /api/system/version    → 503 JSON(code=MAINTENANCE)。
 *       前端版本轮询对该接口错误静默容错；维护页面轮询到该接口返回 200 时
 *       意味着维护已结束，随即整页刷新进入新版本。
 *     - 其余 /api/*、/ws/* HTTP 请求 → 503 JSON(code=MAINTENANCE)（QQ/Shell 侧可据此识别）
 *     - 其余请求（页面/静态资源） → 返回内嵌的维护 HTML 页面（自动轮询恢复）
 * - flag 文件不存在时零开销直通（仅 2 秒一次的 statSync）。
 *
 * 注意：WebSocket 升级请求不经过 Express 中间件栈，维护期间已建立的
 * WS 连接仍然存活，但所有 HTTP 指令接口已 503，游戏交互实际不可用。
 */

import { NextFunction, Request, Response } from 'express';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';

/** 维护开关文件路径（PM2 cwd = server/ 目录） */
const MAINTENANCE_FLAG_PATH = join(process.cwd(), 'maintenance.flag');

/** flag 存在性检测结果缓存时长（毫秒），避免每个请求都 statSync */
const FLAG_CHECK_TTL_MS = 2000;

let flagCache: { checkedAt: number; active: boolean } | null = null;

/**
 * 检测维护开关是否激活（带 TTL 缓存）
 * flag 文件内容为维护开始时间（ISO 字符串），由部署脚本写入
 */
function isMaintenanceActive(): boolean {
  const now = Date.now();
  if (flagCache && now - flagCache.checkedAt < FLAG_CHECK_TTL_MS) {
    return flagCache.active;
  }
  let active = false;
  try {
    statSync(MAINTENANCE_FLAG_PATH);
    active = true;
  } catch {
    active = false;
  }
  flagCache = { checkedAt: now, active };
  return active;
}

/** 读取维护开始时间（flag 文件内容），读取失败返回空字符串 */
function readMaintenanceSince(): string {
  try {
    return readFileSync(MAINTENANCE_FLAG_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

/** 统一的维护态 API 响应（机器可读，QQ/Shell 与前端据此识别维护） */
function sendMaintenanceJson(res: Response): void {
  res.status(503);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    code: 'MAINTENANCE',
    message: '服务器正在维护更新，请稍后再试（Server is under maintenance）',
  });
}

/**
 * 内嵌维护页面（自包含 HTML，不依赖 web/dist —— 目录切换期间静态目录不可靠）
 * 页面每 5 秒轮询 /api/system/version，一旦返回 200（维护结束）立即整页刷新进入游戏。
 */
function renderMaintenancePage(since: string): string {
  const sinceText = since
    ? `维护开始于 ${since}`
    : '服务器正在更新版本';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>使魔大战3 · 系统维护中</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: radial-gradient(ellipse at 50% 0%, #1d2536 0%, #0d1117 70%);
    color: #c9d4e3; font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    text-align: center; padding: 24px;
  }
  .card {
    max-width: 460px; padding: 48px 36px; border-radius: 16px;
    background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08);
    box-shadow: 0 12px 40px rgba(0,0,0,.45);
  }
  .orb {
    width: 64px; height: 64px; margin: 0 auto 24px; border-radius: 50%;
    border: 4px solid rgba(129,161,255,.25); border-top-color: #81a1ff;
    animation: spin 1s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 22px; color: #e8eefc; margin-bottom: 12px; letter-spacing: 1px; }
  p  { font-size: 14px; line-height: 1.8; color: #93a3bd; }
  .since { margin-top: 16px; font-size: 12px; color: #5d6c85; }
  .hint  { margin-top: 6px; font-size: 12px; color: #5d6c85; }
</style>
</head>
<body>
  <div class="card">
    <div class="orb"></div>
    <h1>系统维护中</h1>
    <p>服务器正在更新版本，维护期间暂时无法进入游戏。<br>页面将在维护结束后自动刷新，无需手动操作。</p>
    <p class="since">${sinceText}</p>
    <p class="hint">感谢您的耐心等待 ⚔</p>
  </div>
<script>
(function poll() {
  fetch('/api/system/version', { cache: 'no-store' })
    .then(function (r) { if (r.ok) location.reload(); })
    .catch(function () {});
  setTimeout(poll, 5000);
})();
</script>
</body>
</html>`;
}

/**
 * Express 中间件本体。必须注册在 Nest 路由与 serve-static 之前
 * （main.ts 中通过预先创建的 express 实例最先挂载）。
 */
export function maintenanceMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isMaintenanceActive()) {
    next();
    return;
  }

  const path = req.path || req.originalUrl || '/';

  // 健康检查端点放行：部署脚本的 Test-AppHealth 依赖 /api/docs
  if (path === '/api/docs' || path.startsWith('/api/docs?')) {
    next();
    return;
  }

  // API 请求：返回 503 机器可读维护响应
  if (path === '/api' || path.startsWith('/api/') || path.startsWith('/ws/')) {
    sendMaintenanceJson(res);
    return;
  }

  // 页面/静态资源请求：返回维护页面
  res.status(200);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(renderMaintenancePage(readMaintenanceSince()));
}
