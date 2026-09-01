/* 临时脚本：分析装备数据（名称/类型/基础词条/伤害/品质） */
const fs = require('fs');
const eqs = JSON.parse(fs.readFileSync(__dirname + '/prisma/data/equipments.json', 'utf-8'));
const items = JSON.parse(fs.readFileSync(__dirname + '/prisma/data/items.json', 'utf-8'));

console.log('=== 装备总数:', eqs.length, '===');
const keys = new Set();
eqs.forEach((e) => Object.keys(e).forEach((k) => keys.add(k)));
console.log('所有字段:', [...keys].join(', '));

const byType = {};
eqs.forEach((e) => {
  const t = e.equipType || e.类型 || '未知';
  byType[t] = byType[t] || [];
  byType[t].push(e.name);
});
console.log('\n=== 按装备类型分组 ===');
for (const [t, names] of Object.entries(byType)) {
  console.log(`\n[${t}] ${names.length}件: ${names.join('、')}`);
}

console.log('\n=== 各装备基础伤害(damage)与词条(bonus) ===');
eqs.forEach((e) => {
  const dmg = e.properties?.damage || e.damage || {};
  const dmgStr = Object.entries(dmg).map(([k, v]) => `${k}:${v}`).join(' ');
  const bonusStr = e.bonus ? Object.entries(e.bonus).map(([k, v]) => `${k}:${v}`).join(' ') : '';
  console.log(`${e.name}\n   type=${e.equipType} specialSeq=${e.specialSeq} specialEffect=${e.specialEffect}\n   dmg=[${dmgStr}] bonus=[${bonusStr}] affixes=[${(e.affixes||[]).join(',')}]`);
});

// 检查物品里是否有装备类物品的品质/价格
console.log('\n=== items.json 中装备类条目（数量/品质/价格字段） ===');
const equipItems = items.filter((i) => {
  const n = String(i.name || '');
  return n.includes('枪') || n.includes('甲') || n.includes('盾') || n.includes('刃') || n.includes('剑') || n.includes('武器') || n.includes('装备');
});
console.log('装备类物品数:', equipItems.length);
const itemKeys = new Set();
equipItems.forEach((i) => Object.keys(i).forEach((k) => itemKeys.add(k)));
console.log('物品字段:', [...itemKeys].join(', '));
