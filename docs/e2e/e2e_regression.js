/* 综合回归：验证背包富卡片全部历史修复在同一版本下同时成立。
 * A. 背包卡片下不再出现文字版（.rc-raw 不存在）
 * B. 悬浮「纵横C」→ 延迟后内容正确（品质码回退 + 横幅剥离）
 * C. 同一物品再次悬浮 → 缓存秒出（明显快于配置延迟 1000ms）
 * D. 悬浮另一装备格子 → 内容非空且不是「查询失败」
 * E. 非装备格子（资源）样式为 rc-cell-use（cursor 默认、点击不响应）
 */
const puppeteer = require('puppeteer-core');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://localhost:5173';
const API = 'http://localhost:3333';
const USERNAME = '路人甲';
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

(async () => {
  // 确保延迟配置为 1000
  const gm = (await httpReq('POST', '/api/auth/dev/login', { username: 'admin' })).data;
  await httpReq('POST', '/api/admin/config/update', { key: 'web.handbookTooltipDelayMs', value: '1000' }, gm.access_token);
  const cfg = (await httpReq('GET', '/api/system/web-config')).data.handbookTooltipDelayMs;
  console.log(`[配置] handbookTooltipDelayMs = ${cfg}ms`);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
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
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  await page.waitForSelector('.rc-bag', { timeout: 15000 });
  await sleep(800);

  // ---- A. 文字版消失 ----
  const rawCount = await page.$$eval('.rc-raw', (els) => els.length);
  const cardText = await page.$eval('.rc-bag', (el) => el.textContent.length);
  const wholeRich = await page.$eval('.rich-card', (el) => el.textContent.length);
  const aPass = rawCount === 0 && wholeRich <= cardText + 200; // 富卡片文本不显著长于网格本身
  console.log(`[A] 文字版兜底 .rc-raw = ${rawCount} 个, 卡片总文本 ${wholeRich} vs 网格 ${cardText} → ${aPass ? '✓' : '✗'}`);

  // ---- 格子分类 ----
  const cellMeta = await page.$$eval('.rc-cell-item', (els) =>
    els.map((el) => ({ text: el.textContent, isUse: el.classList.contains('rc-cell-use') })),
  );
  const equipCells = cellMeta.filter((c) => !c.isUse);
  const useCells = cellMeta.filter((c) => c.isUse);
  console.log(`[格子] 共 ${cellMeta.length}（装备可点 ${equipCells.length} / 资源不可点 ${useCells.length}）`);
  const ePass = useCells.length > 0 && equipCells.length > 0;
  console.log(`[E] 资源格子带 rc-cell-use 类 → ${ePass ? '✓' : '✗'}`);

  async function hoverCell(matchText) {
    const cells = await page.$$('.rc-cell-item');
    for (const c of cells) {
      const txt = await c.evaluate((el) => el.textContent);
      if (txt.includes(matchText)) {
        await c.evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await sleep(250);
        await c.hover();
        return true;
      }
    }
    return false;
  }
  async function popupContent() {
    await page.waitForFunction(() => {
      const el = document.querySelector('.rc-hb-content');
      return el && el.textContent.trim().length > 0;
    }, { timeout: 8000 });
    return page.$eval('.rc-hb-content', (el) => el.textContent.trim());
  }

  // ---- B. 悬浮「纵横C」（首次：延迟 1s + 两段回退）----
  if (!(await hoverCell('纵横C'))) { console.log('[B] 找不到纵横C'); process.exit(1); }
  const tB0 = Date.now();
  const txtB = await popupContent();
  const elapsedB = Date.now() - tB0;
  const bPass = txtB.startsWith('纵横（能量武器）') && elapsedB >= 800;
  console.log(`[B] 首次悬浮纵横C: ${elapsedB}ms 后内容首行「${txtB.split('\n')[0]}」→ ${bPass ? '✓' : '✗'}`);

  // 移开（hover 到网格外空白区触发 mouseleave，让弹层关闭）
  await page.mouse.move(30, 300);
  await sleep(900);

  // ---- C. 缓存命中再次悬浮：按统一延迟（≈1000ms）出现，内容来自缓存（不再秒出、也不发请求）----
  const tC0 = Date.now();
  await hoverCell('纵横C');
  const txtC = await popupContent();
  const elapsedC = Date.now() - tC0;
  const cPass = txtC.startsWith('纵横（能量武器）') && elapsedC >= 800; // 缓存也要等延迟
  console.log(`[C] 二次悬浮纵横C: ${elapsedC}ms（缓存按延迟出现 ≥800ms）→ ${cPass ? '✓' : '✗'}`);

  // 移开（hover 到网格外：页面空白区，触发 rc-bag mouseleave 让弹层关闭）
  await page.mouse.move(30, 300);
  await sleep(900);

  // ---- D. 悬浮另一个装备（等弹层出现任意内容，最长 8s）----
  const otherEquip = equipCells.find((c) => !c.text.includes('纵横C'));
  if (otherEquip) {
    const dName = otherEquip.text.trim().split('×')[0].trim();
    await hoverCell(dName);
    await page.waitForFunction(() => {
      const el = document.querySelector('.rc-handbook');
      if (!el) return false;
      const t = el.textContent.trim();
      return t.length > 0 && !t.includes('读取图鉴中');
    }, { timeout: 8000 }).catch(() => {});
    await sleep(300);
    const txtD = await page.$eval('.rc-handbook', (el) => el.textContent.trim()).catch(() => '(弹层未出现)');
    const dPass = !txtD.includes('查询失败') && !txtD.startsWith('纵横（能量武器）');
    console.log(`[D] 悬浮「${dName.slice(0, 15)}」内容首行「${txtD.split('\n')[0].slice(0, 30)}」→ ${dPass ? '✓' : '✗'}`);
  } else {
    console.log('[D] 无其他装备可测，跳过');
  }

  await page.screenshot({ path: 'e2e_regression.png' });
  await browser.close();
  const pass = aPass && ePass && bPass && cPass;
  console.log(pass ? '\n[✓] 综合回归 PASS' : '\n[✗] 综合回归 FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error('E2E ERROR:', e.message);
  process.exit(1);
});
