/** 一次性脚本：查看指定制造配方需求。运行后删除。 */
const data = require('./prisma/data/craftings.json');
const hits = data.filter((c) => c.name === '巧克力' || c.name === '可可树种子');
for (const h of hits) {
  console.log(JSON.stringify({ name: h.name, requirements: h.requirements, outputs: h.outputs || h.gainItems }, null, 1));
}
console.log('总配方数:', data.length);
