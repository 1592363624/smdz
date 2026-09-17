/**
 * 一次性诊断脚本：统计 server/test 下各 spec 里「旧别名键」的出现次数，
 * 用于评估「测试夹具是否还停留在历史字段名」的改造范围。
 */
const fs = require('fs');
const path = require('path');

const dir = 'd:/WorkSpace/IntelliJIDEAWorkspace/使魔大战3/server/test';
const KEYS = [
  '名称', '数量', '类型', '数据', '耐久', '有效期至', '强度', '是否叠加时间', '数值',
  '归属', '特殊序号', '当前生命', '当前护盾', '当前装甲', '技能等级', '编号', '加成',
  'count:', 'count =',
];

const rows = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.ts')) continue;
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  const hits = {};
  let total = 0;
  for (const k of KEYS) {
    const n = text.split(k).length - 1;
    if (n > 0) {
      hits[k] = n;
      total += n;
    }
  }
  if (total > 0) rows.push({ f, total, hits });
}
rows.sort((a, b) => b.total - a.total);
for (const r of rows) {
  console.log(String(r.total).padStart(4), r.f, JSON.stringify(r.hits));
}
console.log('含旧键的测试文件数：', rows.length);