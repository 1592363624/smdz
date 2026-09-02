/* 端到端验证：背包富卡片 → 悬浮「纵横C」→ 图鉴弹层显示基础名内容。
 *
 * 链路：dev login 拿 token → 塞 localStorage 进 /chat → 发「背包」指令
 *      → 等富卡片网格出现 → hover 纵横C 格子 → 等 .rc-hb-content 出现 → 断言内容。
 */
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://localhost:5173';
const API = 'http://localhost:3333';
const USERNAME = '路人乙';
const TARGET_CELL = '纵横C'; // 期望回退到基础名「纵横」
const EXPECTED = '纵横（能量武器）';

async function devLogin() {
  const res = await fetch(`${API}/api/auth/dev/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME }),
  });
  const json = await res.json();
  return json.data; // { access_token, user, ... }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const auth = await devLogin();
  console.log('[1] dev login ok, user:', auth.user.username, 'id:', auth.user.id);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [page.error]', m.text().slice(0, 200));
  });

  // 塞登录态（路由守卫只查 localStorage.token）
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((a) => {
    localStorage.setItem('token', a.access_token);
    localStorage.setItem('user', JSON.stringify(a.user));
  }, auth);
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await sleep(2500); // 等 WS 连接 + 历史消息加载
  console.log('[2] /chat loaded, url =', page.url());

  // 发送「背包」指令
  await page.waitForSelector('textarea.cmd-input', { timeout: 10000 });
  await page.type('textarea.cmd-input', '背包');
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  console.log('[3] 背包 指令已发送');

  // 等富卡片网格出现
  await page.waitForSelector('.rc-cell-item', { timeout: 15000 });
  await sleep(600); // 等渲染稳定
  const cellCount = await page.$$eval('.rc-cell-item', (els) => els.length);
  console.log(`[4] 富卡片格子数 = ${cellCount}`);

  // hover 目标格子（先滚进视野）
  const cells = await page.$$('.rc-cell-item');
  let target = null;
  for (const c of cells) {
    const txt = await c.evaluate((el) => el.textContent);
    if (txt.includes(TARGET_CELL)) { target = c; break; }
  }
  if (!target) {
    console.log(`[!] 没找到「${TARGET_CELL}」格子，弹层回退用例中止`);
    await browser.close();
    process.exit(1);
  }
  await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await sleep(300);
  await target.hover();
  console.log(`[5] 已悬浮「${TARGET_CELL}」`);

  // 等弹层出现 + 内容填充（弹层挂 body 下，100ms enterDelay + 2 段请求时间）
  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.rc-hb-content');
        return el && el.textContent.trim().length > 0;
      },
      { timeout: 8000 },
    );
  } catch (e) {
    const loading = await page.$eval('.rc-handbook', (el) => el.textContent).catch(() => null);
    console.log('[!] 弹层内容 8s 内未出现，弹层状态 =', loading || '(弹层根本没出现)');
    await page.screenshot({ path: 'e2e_fail.png' });
    await browser.close();
    process.exit(1);
  }

  const popup = await page.$eval('.rc-handbook', (el) => ({
    text: el.textContent.trim().slice(0, 120),
    visible:
      el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
  }));
  console.log('[6] 弹层可见 =', popup.visible);
  console.log('[6] 弹层内容前 120 字 =', popup.text);

  const pass = popup.text.includes(EXPECTED);
  console.log(pass ? `[✓] PASS：回退到基础名，内容含「${EXPECTED}」` : `[✗] FAIL：未含「${EXPECTED}」`);

  await page.screenshot({ path: 'e2e_handbook.png' });
  console.log('[7] 截图已保存 e2e_handbook.png');
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error('E2E ERROR:', e.message);
  process.exit(1);
});
