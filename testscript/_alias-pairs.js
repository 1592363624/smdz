/**
 * 别名对清点脚本（一次性诊断）
 * 目的：抽取所有 `主字段 ?? 兜底字段` 表达式，输出 (主, 兜底) 配对统计，
 *      作为「别名 → 规范名」映射表的依据。
 */
const fs = require('fs');
const path = require('path');

const roots = [
  'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/src',
  'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/web/src',
];
const cn = (s) => /[\u4e00-\u9fa5]/.test(String(s));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walk(p, out);
    } else if (/\.(ts|vue|js)$/.test(e.name)) out.push(p);
  }
}
const files = [];
for (const r of roots) if (fs.existsSync(r)) walk(r, files);

// 属性链提取：匹配 `X.Y` 或 `X?.Y` 形式（含下标）
const CHAIN = `([A-Za-z_$][\\w$]*(?:\\??\\.[\\w$\\u4e00-\\u9fa5]+|\\[[^\\]]{0,30}\\])*)`;
const re = new RegExp(`${CHAIN}\\s*\\?\\?\\s*${CHAIN}`, 'g');

const pairs = new Map(); // "leftProp -> rightProp" (仅属性名，去对象前缀)
const leftOnly = new Map();
const rightOnly = new Map();

function lastProp(chain) {
  const m = chain.match(/\.([\w$\u4e00-\u9fa5]+)\s*$/);
  if (m) return m[1];
  const b = chain.match(/\[\s*['"]([^'"]+)['"]\s*\]\s*$/);
  if (b) return b[1];
  return null;
}

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(src))) {
    const lp = lastProp(m[1]);
    const rp = lastProp(m[2]);
    if (!lp || !rp) continue;
    if (!cn(lp) && !cn(rp)) continue;
    // 过滤掉纯字符串/数字常量
    const key = `${lp} ?? ${rp}`;
    pairs.set(key, (pairs.get(key) || 0) + 1);
    if (cn(rp) && !cn(lp)) rightOnly.set(key, (rightOnly.get(key) || 0) + 1);
    if (cn(lp) && !cn(rp)) leftOnly.set(key, (leftOnly.get(key) || 0) + 1);
  }
}

const show = (title, mp) => {
  console.log(`\n=== ${title} ===`);
  for (const [k, v] of [...mp.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(String(v).padStart(5), k);
  }
};
show('英文主 → 中文兜底（重点：要删的兜底） total=' + [...rightOnly.values()].reduce((a, b) => a + b, 0), rightOnly);
show('中文主 → 英文兜底（重点：要翻转的写法） total=' + [...leftOnly.values()].reduce((a, b) => a + b, 0), leftOnly);
console.log('\n=== 全部含中文的兜底对 total=' + [...pairs.values()].reduce((a, b) => a + b, 0) + ' ===');
const all = [...pairs.entries()].sort((a, b) => b[1] - a[1]);
console.log(all.map(([k, v]) => `${k}(${v})`).join('  '));