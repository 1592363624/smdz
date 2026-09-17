/**
 * 静态数据 count 键分布清点（一次性诊断）
 * 目的：列出 server/prisma/data/*.json 中所有 key 为 count 的路径模板，
 *      判断哪些是「数量语义」需要改名为 quantity，哪些是无关用法不能动。
 */
const fs = require('fs');
const path = require('path');
const dir = 'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/prisma/data';
const tally = new Map();

function walk(node, tmpl, depth = 0) {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${tmpl}[]`, depth + 1));
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'count') {
        const key = tmpl || '(root)';
        tally.set(key, (tally.get(key) || 0) + 1);
      }
      walk(v, `${tmpl}.${k}`, depth + 1);
    }
  }
}

for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  const raw = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, '');
  let data;
  try { data = JSON.parse(raw); } catch (e) { console.log(`!! ${f} 解析失败 ${e.message}`); continue; }
  tally.clear();
  walk(data, '');
  if (tally.size === 0) continue;
  const rows = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n${f}`);
  for (const [p, n] of rows.slice(0, 20)) console.log(`   ${n}\t${p}`);
}