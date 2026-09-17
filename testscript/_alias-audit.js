/**
 * 别名清点脚本（一次性诊断用，不入库）
 * 目的：扫描 server/src 与 web/src，抽取所有「中文属性名」的读取点，
 *      以及 `??` 兜底表达式里的 (主字段, 兜底字段) 组合，输出聚合清单。
 */
const fs = require('fs');
const path = require('path');

const roots = [
  'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/src',
  'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/web/src',
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walk(p, out);
    } else if (/\.(ts|vue|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = roots.flatMap((r) => (fs.existsSync(r) ? walk(r) : []));

const pairCount = new Map(); // "主 ?? 兜底" -> count
const cnPropCount = new Map(); // 中文属性名 -> count
const cnToFiles = new Map(); // 中文属性名 -> Set(file)

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative('d:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3', f).replace(/\\/g, '/');
  // 1) 所有 `?? 中文属性` 形态：如 `x.bonus ?? x.加成` / `a ?? b?.数量`
  const re = /([A-Za-z_$][\w$]*(?:\??\.[\w$]+|\[[^\]]*\])*)\s*\?\?\s*([^\n;]{0,60}?)(?=[,;)\]\n}]|$)/g;
  let m;
  while ((m = re.exec(src))) {
    const rhs = m[2];
    const cn = rhs.match(/[\u4e00-\u9fa5]+/);
    if (!cn) continue;
    const prop = rhs.match(/\.([\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)/);
    const key = prop ? prop[1] : cn[0];
    pairCount.set(key, (pairCount.get(key) || 0) + 1);
  }
  // 2) 所有出现的中文属性名（.中文 或 ['中文'] 或 中文: 定义）
  const cnRe = /(?:\.|\?\?\.)([\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)/g;
  while ((m = cnRe.exec(src))) {
    const k = m[1];
    cnPropCount.set(k, (cnPropCount.get(k) || 0) + 1);
    if (!cnToFiles.has(k)) cnToFiles.set(k, new Set());
    cnToFiles.get(k).add(rel);
  }
}

const sortDesc = (mp) => [...mp.entries()].sort((a, b) => b[1] - a[1]);

console.log('=== 作为 ?? 兜底目标出现的中文属性名（Top 60） ===');
for (const [k, v] of sortDesc(pairCount).slice(0, 60)) console.log(String(v).padStart(5), k);
console.log('\n=== 代码中出现的中文属性名总数 ===', cnPropCount.size);
console.log('\n=== 中文属性名 Top 80（含出现文件数） ===');
for (const [k, v] of sortDesc(cnPropCount).slice(0, 80)) {
  console.log(String(v).padStart(5), k.padEnd(12), 'files=' + cnToFiles.get(k).size);
}
console.log('\n=== 仅在 1-2 个文件出现的中文属性名（可能是局部遗留） ===');
const rare = sortDesc(cnPropCount).filter(([k]) => cnToFiles.get(k).size <= 2);
console.log('count =', rare.length);
for (const [k, v] of rare.slice(0, 60)) console.log(String(v).padStart(5), k.padEnd(12), [...cnToFiles.get(k)].join(' '));