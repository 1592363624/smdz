/**
 * 从原版 使魔大战.txt 抽取两类尚未迁移的数据：
 *   1. 类型=配方     → prisma/data/recipes.json   （原版 94 条，另 1 条「配方模板」过滤）
 *   2. 类型=随机载具 → prisma/data/wrecks.json    （原版 11 条）
 *
 * 解析严格对齐原版 数据存取.ecode：
 *   配方     L907-945：段名去掉"配方"两字；产出/消耗 先全角逗号转半角，再按空格分项，
 *                      每项按逗号分 3 段（名称/数量/几率），不足 3 段丢弃；
 *                      解锁需求 按空格分项，去数字=名称、取数字=数量。
 *   随机载具 L946-960：名称 = 段名 + 几率（原版把几率编码进名称），
 *                      这里拆成独立的 name/chance 两字段；
 *                      零件按全角逗号分项，去数字=名称、取数字=数量（仅资源类有数量）。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../原版易语言源代码/源码/使魔大战.txt');
const OUT_DIR = path.resolve(__dirname, '../prisma/data');

/** 去掉字符串中的数字 */
const 去数字 = (s) => String(s || '').replace(/\d/g, '');
/** 取出字符串中的数字 */
const 取数字 = (s) => (String(s || '').match(/\d/g) || []).join('');

// ---------- 读段 ----------
const raw = fs.readFileSync(SRC, 'utf8');
const lines = raw.split(/\r?\n/);

/** 段列表：[{ name, fields: {k:v} }]，保持原文顺序 */
const sections = [];
let cur = null;
for (const line of lines) {
  const secMatch = /^\[(.+)\]$/.exec(line.trim());
  if (secMatch) {
    if (cur) sections.push(cur);
    cur = { name: secMatch[1], fields: {} };
    continue;
  }
  if (!cur) continue;
  const eq = line.indexOf('=');
  if (eq > 0) {
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1);
    if (!(k in cur.fields)) cur.fields[k] = v; // 首出现优先，与原版 读配置项3 一致
  }
}
if (cur) sections.push(cur);

// ---------- 解析"名称，数量,几率"三元组列表 ----------
function parseTriple(text) {
  const out = [];
  if (!text || !text.trim()) return out;
  // 全角逗号 → 半角，再按空格分项
  const normalized = text.replace(/，/g, ',');
  for (const token of normalized.split(' ')) {
    const t = token.trim();
    if (!t) continue;
    const parts = t.split(',');
    if (parts.length !== 3) continue; // 原版只收 3 段
    const name = parts[0].trim();
    if (!name) continue;
    out.push({
      name,
      count: Number(parts[1]) || 0,
      chance: Number(parts[2]) || 0,
    });
  }
  return out;
}

// ---------- 1. 配方 ----------
const recipes = [];
for (const sec of sections) {
  if (sec.fields['类型'] !== '配方') continue;
  // 原版：名称 = 段名去掉"配方"两字
  const name = sec.name.replace(/配方/g, '');
  // 模板行（"配方模板" → "模板"）过滤
  if (name === '模板') continue;
  recipes.push({
    name,
    description: sec.fields['说明'] || '缺少说明',
    level: parseInt(sec.fields['等级'] || '1', 10) || 1,
    productivity: parseInt(sec.fields['生产力消耗'] || '1', 10) || 1,
    outputs: parseTriple(sec.fields['产出'] || ''),
    inputs: parseTriple(sec.fields['消耗'] || ''),
    unlockReq: (sec.fields['解锁需求'] || '')
      .split(' ')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => ({ name: 去数字(t), count: Number(取数字(t)) || 0 }))
      .filter((x) => x.name),
  });
}

// ---------- 2. 随机载具（废弃载具） ----------
const wrecks = [];
for (const sec of sections) {
  if (sec.fields['类型'] !== '随机载具') continue;
  const chance = parseFloat(sec.fields['几率'] || '0') || 0;
  const parts = (sec.fields['零件'] || '')
    .split('，')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ name: 去数字(t), count: Number(取数字(t)) || 1 }))
    .filter((x) => x.name);
  if (parts.length <= 2) continue; // 原版要求零件 > 2 才收录
  wrecks.push({ name: sec.name, chance, parts });
}

fs.writeFileSync(
  path.join(OUT_DIR, 'recipes.json'),
  JSON.stringify(recipes, null, 2) + '\n',
  'utf8',
);
fs.writeFileSync(
  path.join(OUT_DIR, 'wrecks.json'),
  JSON.stringify(wrecks, null, 2) + '\n',
  'utf8',
);

console.log(`recipes.json: ${recipes.length} 条（原版基线 94）`);
console.log(`wrecks.json : ${wrecks.length} 条（原版基线 11）`);
console.log('--- 配方样例 ---');
console.log(JSON.stringify(recipes[0], null, 2));
console.log('--- 废弃载具样例 ---');
console.log(JSON.stringify(wrecks[0], null, 2).slice(0, 600));
