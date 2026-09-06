/* 端到端验证 GM 可配置的图鉴悬浮延迟：
 * 1. GM 把 web.handbookTooltipDelayMs 设为 1500
 * 2. 浏览器打开背包 → hover「纵横C」
 * 3. 800ms 时弹层应【未】出现（若还是旧的 100ms 硬编码，此时已出现）
 * 4. 2.5s 内弹层应【已】出现且内容正确（走两段式回退）
 * 5. 恢复 1000
 * 全部 HTTP 用 Node 原生 http（避免 shell 引号剥坏中文 JSON）。
 */
const puppeteer = require('puppeteer-core');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://localhost:5173';
const API = 'http://localhost:3333';
const USERNAME = '路人甲';
const TARGET_CELL = '纵横C';
const EXPECTED = '纵横（能量武器）';
const DELAY_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpReq(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request(
      API + path,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(data ? { 'Content-Length': data.length } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('bad json: ' + buf.slice(0, 120))); }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // 1. GM 登录 + 设置延迟
  const gm = (await httpReq('POST', '/api/auth/dev/login', { username: 'admin' })).data;
  const token = gm.access_token;
  const setResult = await httpReq('POST', '/api/admin/config/update',
    { key: 'web.handbookTooltipDelayMs', value: String(DELAY_MS) }, token);
  console.log('[1] GM 设延迟 =', DELAY_MS, '→ success =', setResult.success === true);
  const cfgBefore = (await httpReq('GET', '/api/system/web-config')).data.handbookTooltipDelayMs;
  console.log('[1] 公开配置 =', cfgBefore, 'ms');

  // 2. 浏览器登录 + 进聊天页
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();

  const auth = (await httpReq('POST', '/api/auth/dev/login', { username: USERNAME })).data;
  if (!auth || !auth.access_token) { console.log('[!] 玩家登录失败:', auth); process.exit(1); }

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((a) => {
    localStorage.setItem('token', a.access_token);
    localStorage.setItem('user', JSON.stringify(a.user));
  }, auth);
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  await page.waitForSelector('textarea.cmd-input', { timeout: 10000 });
  await page.type('textarea.cmd-input', '背包');
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  await page.waitForSelector('.rc-cell-item', { timeout: 15000 });
  await sleep(600);
  console.log('[2] 背包富卡片已渲染');

  // 3. hover 目标格子
  const cells = await page.$$('.rc-cell-item');
  let target = null;
  for (const c of cells) {
    const txt = await c.evaluate((el) => el.textContent);
    if (txt.includes(TARGET_CELL)) { target = c; break; }
  }
  if (!target) { console.log('[!] 没找到目标格子'); await browser.close(); process.exit(1); }
  await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await sleep(300);

  await target.hover();
  const t0 = Date.now();
  await sleep(800); // 800ms < 1500ms 配置值，但 > 旧硬编码 100ms
  const at800 = await page.$('.rc-handbook');
  console.log(`[3] hover 后 800ms 弹层出现? ${at800 ? '是(✗ 延迟未生效)' : '否(✓ 延迟生效)'}`);

  // 4. 等弹层内容出现，测实际耗时
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.rc-hb-content');
      return el && el.textContent.trim().length > 0;
    },
    { timeout: 6000 },
  );
  const elapsed = Date.now() - t0;
  const text = await page.$eval('.rc-hb-content', (el) => el.textContent.trim().slice(0, 40));
  const passDelay = elapsed >= DELAY_MS - 300;
  const passText = text.includes(EXPECTED);
  console.log(`[4] 弹层实际出现耗时 ≈ ${elapsed}ms (配置 ${DELAY_MS}ms) → ${passDelay ? '✓' : '✗'}`);
  console.log(`[4] 内容首 40 字 = ${text} → ${passText ? '✓' : '✗'}`);

  // 5. 恢复默认
  await httpReq('POST', '/api/admin/config/update',
    { key: 'web.handbookTooltipDelayMs', value: '1000' }, token);
  console.log('[5] 已恢复默认 1000ms →', (await httpReq('GET', '/api/system/web-config')).data.handbookTooltipDelayMs, 'ms');

  await page.screenshot({ path: 'e2e_delay.png' });
  await browser.close();
  const pass = !at800 && passDelay && passText;
  console.log(pass ? '[✓] PASS' : '[✗] FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error('E2E ERROR:', e.message);
  process.exit(1);
});
