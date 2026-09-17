/**
 * 静态数据 JSON 键名清点（一次性诊断）
 * 目的：列出 server/prisma/data/*.json 中每个文件出现的「中文字段名」及其层级/出现次数，
 *      据此评估「字段名改英文」的改造范围。内容值（木头/哥布林）不在统计内。
 */
const fs = require('fs');
const path = require('path');
const dir = 'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/prisma/data';
const cn = (s) => /[\u4e00-\u9fa5]/.test(String(s));

function walk(value, bag, depth) {
  if (value == null || depth > 4) return;
  if (Array.isArray(value)) { for (const v of value.slice(0, 500)) walk(v, bag, depth); return; }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (cn(k)) {
        const rec = bag.get(k) || { n: 0, d: new Set() };
        rec.n++; rec.d.add(depth);
        bag.set(k, rec);
      }
      if (v && typeof v === 'object') walk(v, bag, depth + 1);
    }
  }
}

for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  const p = path.join(dir, f);
  let data;
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.log(`${f}: 解析失败 ${e.message}`); continue; }
  const bag = new Map();
  walk(data, bag, 0);
  if (bag.size === 0) { console.log(`${f.padEnd(24)} [无中文字段名]`); continue; }
  const list = [...bag.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log(`\n${f}  （中文字段名 ${bag.size} 种）`);
  console.log('   ' + list.map(([k, v]) => `${k}@d${[...v.d].join('/')}x${v.n}`).join('  '));
}