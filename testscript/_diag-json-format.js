/**
 * 诊断：对比磁盘 JSON 文本与 JSON.stringify(data,null,2)+('\n') 的首个差异位置。
 * 用法：node testscript/_diag-json-format.js <文件相对 data 目录的路径>
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'server', 'prisma', 'data');

for (const name of process.argv.slice(2)) {
  const raw = fs.readFileSync(path.join(DIR, name), 'utf8');
  const data = JSON.parse(raw);
  const trail = raw.endsWith('\n');
  const out = JSON.stringify(data, null, 2) + (trail ? '\n' : '');
  if (out === raw) {
    console.log(`${name}: 格式一致`);
    continue;
  }
  let i = 0;
  while (i < Math.min(out.length, raw.length) && out[i] === raw[i]) i++;
  console.log(`${name}: 首个差异 offset=${i}`);
  console.log('  磁盘 : ', JSON.stringify(raw.slice(Math.max(0, i - 60), i + 60)));
  console.log('  标准 : ', JSON.stringify(out.slice(Math.max(0, i - 60), i + 60)));
  console.log(`  长度 磁盘=${raw.length} 标准=${out.length} 末尾换行=${trail}`);
}