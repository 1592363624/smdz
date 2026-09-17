/**
 * 临时脚本：把 server/prisma/data/*.json 里所有名为 count 的对象键重命名为 quantity。
 *
 * 约束：
 *  - 只改键名，值（含中文内容）一律不动；不删键、不重新排序（按 Object.entries 原顺序重建）。
 *  - 保持原有 JSON 格式（2 空格缩进 + 原文件是否带末尾换行），避免整文件 diff 噪音。
 *  - 自检：用同一 stringify 方式还原原数据，检查「仅 count→quantity 差异」，并打印每文件改动条数。
 *
 * 用法：node testscript/_rename-count-to-quantity.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'server', 'prisma', 'data');
const DRY = process.argv.includes('--dry');

/** 递归重命名：逐键重建对象以保持键顺序；数组元素递归处理 */
function renameKeys(node, stats) {
  if (Array.isArray(node)) return node.map((it) => renameKeys(it, stats));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const newKey = k === 'count' ? 'quantity' : k;
      if (k === 'count') stats.count++;
      out[newKey] = renameKeys(v, stats);
    }
    return out;
  }
  return node;
}

/**
 * 用与写回完全一致的方式序列化 data（保留原文件的末尾换行与换行风格）。
 * 注意：data 目录里部分文件是 CRLF（Windows 手写/旧脚本产出），若统一成 LF 会产生整文件 diff。
 */
function serialize(data, trailingNewline, eol) {
  const body = JSON.stringify(data, null, 2).split('\n').join(eol);
  return body + (trailingNewline ? eol : '');
}

/** 收集所有 count / quantity 出现处的「父路径+下标」指纹，用于等价性比对 */
function fingerprint(node, trail, acc) {
  if (Array.isArray(node)) {
    node.forEach((it, i) => fingerprint(it, `${trail}[${i}]`, acc));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'count' || k === 'quantity') acc.push(`${trail}.${k}=${JSON.stringify(v)}`);
      fingerprint(v, `${trail}.${k}`, acc);
    }
  }
  return acc;
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
const report = [];
let totalChanged = 0;

for (const file of files) {
  const full = path.join(DIR, file);
  const raw = fs.readFileSync(full, 'utf8');
  const trailingNewline = raw.endsWith('\n');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const data = JSON.parse(raw);

  // 格式基准校验：原数据按同一格式序列化是否与磁盘内容完全一致
  const formatMatched = serialize(data, trailingNewline, eol) === raw;

  const stats = { count: 0 };
  const renamed = renameKeys(data, stats);

  // 等价性自检 1：除 count→quantity 外，指纹完全一致
  const before = fingerprint(JSON.parse(raw), '$', []);
  const after = fingerprint(renamed, '$', []);
  const normalizeFp = (arr) => arr.map((s) => s.replace(/\.count=/, '.quantity=')).sort();
  const equivalent = JSON.stringify(normalizeFp(before)) === JSON.stringify(normalizeFp(after));

  // 等价性自检 2：序列化结果里除键名替换外无其它差异
  const out = serialize(renamed, trailingNewline, eol);
  const expected = raw.replace(/"count":/g, '"quantity":');
  const textEquivalent = out === expected;

  if (stats.count > 0) {
    if (!DRY) fs.writeFileSync(full, out, 'utf8');
    totalChanged += stats.count;
  }

  report.push({
    file,
    changed: stats.count,
    formatMatched,
    equivalent,
    textEquivalent,
    trailingNewline,
  });
}

console.log(`模式: ${DRY ? 'DRY-RUN（未写盘）' : '已写盘'}`);
console.log('文件'.padEnd(28), '改动数'.padStart(6), '原格式一致', '结构等价', '文本等价');
for (const r of report) {
  console.log(
    r.file.padEnd(28),
    String(r.changed).padStart(6),
    String(r.formatMatched).padStart(10),
    String(r.equivalent).padStart(8),
    String(r.textEquivalent).padStart(8),
  );
}
console.log(`\n合计改动 ${totalChanged} 处；涉及文件 ${report.filter((r) => r.changed > 0).length} 个`);

const bad = report.filter((r) => r.changed > 0 && (!r.equivalent || !r.textEquivalent));
if (bad.length) {
  console.error('\n[自检失败] 以下文件未通过等价性校验：', bad.map((b) => b.file).join(', '));
  process.exit(1);
}
const fmtBad = report.filter((r) => !r.formatMatched);
if (fmtBad.length) {
  console.warn('\n[注意] 以下文件原格式与统一 stringify 格式不一致（写回后可能产生格式 diff）：', fmtBad.map((b) => b.file).join(', '));
}
console.log('\n[自检通过] 所有改动文件均满足「除 count→quantity 外完全等价」');