/**
 * 维护/断线遮罩守卫（部署更新期间的原地维护 UI）
 *
 * 背景：部署期间后端 /api 返回 503(code=MAINTENANCE)，cutover 切换窗口甚至
 * 直接 ECONNREFUSED。旧实现是响应拦截器里整页跳 '/'——但生产环境页面请求由
 * nginx 静态托管，跳 '/' 拿到的仍是 SPA，路由又弹回 /chat，形成
 * 「/chat ↔ / 无限刷新」乒乓（2026-09-08 实证）。
 *
 * 新策略：绝不整页跳转。原地盖一层全屏遮罩（SPA 内自绘，不依赖服务端返回
 * 什么页面），由遮罩自己轮询 /api/system/version：
 *   - 200            → 维护/断线结束，location.reload() 进新版本
 *   - 503 MAINTENANCE → 切维护文案，继续轮询
 *   - 网络错误        → 切断线文案，继续轮询
 *
 * 框架无关（纯 DOM 注入，不依赖 Pinia/组件树），保证在任何报错时机都能盖住 UI。
 * 视觉与服务端维护页（maintenance.middleware.ts / public/maintenance.html）一致。
 */

/** 轮询间隔(毫秒)，与服务端维护页保持一致 */
const POLL_INTERVAL_MS = 5000;
/** 断线遮罩的触发阈值：30 秒内连续 2 次网络失败才显示，避免瞬时抖动误伤 */
const NET_FAIL_THRESHOLD = 2;
const NET_FAIL_WINDOW_MS = 30000;

/** 当前模式：null=未激活 | 'maintenance'=维护中 | 'disconnected'=连接中断 */
let mode = null;
/** 轮询定时器句柄（激活期间常驻，整页 reload 后自然销毁） */
let pollTimer = null;
/** 遮罩根元素 */
let overlayEl = null;
/** 标题/正文元素（模式切换时原地改文案） */
let titleEl = null;
let descEl = null;
/** 网络失败计数（阈值判定用） */
let netFailCount = 0;
let lastFailAt = 0;

/** 各模式的遮罩文案 */
const MODE_TEXT = {
  maintenance: {
    title: '系统维护中',
    desc: '服务器正在更新版本，维护期间暂时无法进入游戏。<br>页面将在维护结束后自动刷新，无需手动操作。',
  },
  disconnected: {
    title: '连接中断',
    desc: '与服务器失去连接，正在尝试重连…<br>连接恢复后页面会自动刷新。',
  },
};

/** 创建遮罩 DOM（只创建一次；再次调用仅切换文案） */
function ensureOverlay() {
  if (overlayEl) return;
  overlayEl = document.createElement('div');
  overlayEl.setAttribute('data-maintenance-overlay', '');
  overlayEl.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'display:flex', 'align-items:center', 'justify-content:center',
    'background:radial-gradient(ellipse at 50% 0%, #1d2536 0%, #0d1117 70%)',
    'color:#c9d4e3', 'font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
    'text-align:center', 'padding:24px',
  ].join(';');
  overlayEl.innerHTML = `
    <div style="max-width:460px;padding:48px 36px;border-radius:16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);box-shadow:0 12px 40px rgba(0,0,0,.45);">
      <div style="width:64px;height:64px;margin:0 auto 24px;border-radius:50%;border:4px solid rgba(129,161,255,.25);border-top-color:#81a1ff;animation:maintenance-spin 1s linear infinite;"></div>
      <h1 style="font-size:22px;color:#e8eefc;margin-bottom:12px;letter-spacing:1px;"></h1>
      <p style="font-size:14px;line-height:1.8;color:#93a3bd;"></p>
    </div>`;
  const style = document.createElement('style');
  style.textContent = '@keyframes maintenance-spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
  titleEl = overlayEl.querySelector('h1');
  descEl = overlayEl.querySelector('p');
  document.body.appendChild(overlayEl);
}

/** 切换遮罩文案（模式变化时调用） */
function applyModeText() {
  if (!titleEl) return;
  const text = MODE_TEXT[mode] || MODE_TEXT.maintenance;
  titleEl.textContent = text.title;
  descEl.innerHTML = text.desc;
}

/**
 * 探测服务器状态并决定下一步：
 * 200 → 整页刷新进游戏；503 → 维护态；其余 → 断线态。均继续轮询。
 */
async function probe() {
  try {
    const res = await fetch('/api/system/version', { cache: 'no-store' });
    if (res.ok) {
      stop();
      window.location.reload();
      return;
    }
    setMode(res.status === 503 ? 'maintenance' : 'disconnected');
  } catch {
    setMode('disconnected');
  }
}

/** 切换模式并刷新文案 */
function setMode(next) {
  if (mode === next) return;
  mode = next;
  applyModeText();
}

function start() {
  if (pollTimer) return;
  pollTimer = setInterval(probe, POLL_INTERVAL_MS);
  probe();
}

function stop() {
  clearInterval(pollTimer);
  pollTimer = null;
  mode = null;
  netFailCount = 0;
}

/**
 * 进入维护遮罩（503 MAINTENANCE 时由响应拦截器调用，立即显示）。
 * 幂等：重复调用不会叠加轮询或重建 DOM。
 */
export function showMaintenanceOverlay() {
  netFailCount = 0;
  ensureOverlay();
  setMode('maintenance');
  start();
}

/**
 * 报告一次网络层失败（无响应的 axios 错误，如 cutover 窗口的 ECONNREFUSED）。
 * 阈值内不动作；达到阈值后显示断线遮罩并开始轮询。
 */
export function reportNetworkFailure() {
  const now = Date.now();
  netFailCount = now - lastFailAt < NET_FAIL_WINDOW_MS ? netFailCount + 1 : 1;
  lastFailAt = now;
  if (netFailCount < NET_FAIL_THRESHOLD) return;
  // 已在维护遮罩态则不降级为断线文案（维护期网络抖动很常见）
  if (mode === 'maintenance') return;
  ensureOverlay();
  setMode('disconnected');
  start();
}
