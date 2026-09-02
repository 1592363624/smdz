/* 复现并验证「格子间切换残留」bug：
 * 1. hover 物品 A（纵横C）→ 等 1s 延迟 + 查询 → 弹层显示 A 内容
 * 2. 不经过网格外，直接 hover 相邻物品 B（矢量D）
 * 3. 关键断言：
 *    a) 切换瞬间（<300ms）弹层【不再是 A 内容】——显示 B 的读取中/内容
 *    b) B 查询完成后显示「矢量（能量武器）」，不是残留的纵横
 * 4. 再切回 A（缓存命中）→ 立即显示 A，无残留
 */
const puppeteer = require('puppeteer-core');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://localhost:5173';
const API = 'http://localhost:3333';
const USERNAME = '路人乙';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpReq(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request(API + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Length': data.length } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error('bad json')); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function popupCurrentText() {
  return page.$eval('.rc-handbook', (el) => el.textContent.trim()).catch(() => '');
}
async function popupHasContent(match, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const txt = await popupCurrentText();
    if (txt.includes(match)) return true;
    await sleep(100);
  }
  return false;
}

let browser, page;

(async () => {
  const gm = (await httpReq('POST', '/api/auth/dev/login', { username: 'admin' })).data;
  await httpReq('POST', '/api/admin/config/update', { key: 'web.handbookTooltipDelayMs', value: '1000' }, gm.access_token);
  const cfg = (await httpReq('GET', '/api/system/web-config')).data.handbookTooltipDelayMs;
  console.log(`[配置] 悬浮延迟 = ${cfg}ms`);

  browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 900 },
  });
  page = await browser.newPage();

  const auth = (await httpReq('POST', '/api/auth/dev/login', { username: USERNAME })).data;
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((a) => {
    localStorage.setItem('token', a.access_token);
    localStorage.setItem('user', JSON.stringify(a.user));
  }, auth);
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  await page.waitForSelector('textarea.cmd-input', { timeout: 10000 });
  await page.type('textarea.cmd-input', '背包');
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await page.waitForSelector('.rc-bag', { timeout: 15000 });
  await sleep(800);

  async function cellsOf() {
    return page.$$('.rc-cell-item');
  }
  async function hoverByName(name) {
    const cells = await cellsOf();
    for (const c of cells) {
      const txt = await c.evaluate((el) => el.textContent);
      if (txt.includes(name)) {
        await c.evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await sleep(250);
        await c.hover();
        return true;
      }
    }
    return false;
  }
  async function popupTextNow() {
    return page.$eval('.rc-handbook', (el) => el.textContent.trim()).catch(() => '(无弹层)');
  }

  // 1. 先读 A=纵横C（首次 → 1s 延迟 + 查询）
  console.log('[1] hover 纵横C ...');
  await hoverByName('纵横C');
  const okA = await popupHasContent('纵横（能量武器）', 8000);
  console.log(`[1] A 内容出现: ${okA ? '✓' : '✗'} → ${(await popupTextNow()).split('\n')[0]}`);

  // 2. 直接切到 B=矢量D（不经过网格外）——新时序：切换也等 enterDelay（1000ms），期间无弹层
  console.log('[2] 直接切到 矢量D ...');
  await hoverByName('矢量D');
  await sleep(350); // 350ms < 1000ms：弹层应已被收起（不留 A 残留，也不提前显示 B）
  const txtAt350 = await popupTextNow();
  const popupVisible350 = await page.$('.rc-handbook');
  const noResidueA = popupVisible350 === null || !txtAt350.includes('纵横（能量武器）');
  const notEarly = popupVisible350 === null || !txtAt350.includes('矢量');
  console.log(`[2] 切换 350ms 后弹层状态 = ${popupVisible350 ? '存在:「' + txtAt350.split('\n')[0].slice(0, 20) + '」' : '不存在'} → 无 A 残留: ${noResidueA ? '✓' : '✗'}, 未提前显示 B: ${notEarly ? '✓' : '✗'}`);

  const tB = Date.now();
  const okB = await popupHasContent('矢量（能量武器）', 8000);
  console.log(`[2] B 内容出现: ${okB ? '✓' : '✗'} → ${(await popupTextNow()).split('\n')[0]}`);
  console.log(`[2] 切换到 B 内容耗时 ${Date.now() - tB}ms（应 ≈延迟1000 + 查询，即 ≥1000ms）`);

  // 3. 再切回 A（缓存命中——但按新时序仍要等延迟，不能秒出）
  await page.mouse.move(30, 300); // 先移出网格等弹层收起
  await sleep(900);
  const t3 = Date.now();
  await hoverByName('纵横C');
  await sleep(300); // 300ms < 1000ms：缓存命中也不应提前弹
  const earlyBack = await page.$('.rc-handbook');
  const backA = await popupHasContent('纵横（能量武器）', 8000);
  const backElapsed = Date.now() - t3;
  console.log(`[3] 切回纵横C: 300ms 时弹层${earlyBack ? '已出现(✗ 缓存未按延迟)' : '未出现(✓)'}, 内容就位共 ${backElapsed}ms ≥1000ms: ${backElapsed >= 1000 ? '✓' : '✗'} →「${(await popupTextNow()).split('\n')[0].slice(0, 30)}」`);

  await page.screenshot({ path: 'e2e_switch.png' });
  await browser.close();
  const pass = okA && noResidueA && notEarly && okB && !earlyBack && backA && backElapsed >= 1000;
  console.log(pass ? '\n[✓] 切换残留+统一延迟 PASS' : '\n[✗] FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error('E2E ERROR:', e.message);
  if (browser) browser.close();
  process.exit(1);
});
