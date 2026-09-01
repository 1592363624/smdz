/** 一次性脚本：检查路人甲背包中可可树种子数量。运行后删除。 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const user = await p.user.findUnique({ where: { username: '路人甲' }, select: { id: true } });
  const player = await p.player.findUnique({ where: { userId: user.id }, select: { backpack: true } });
  const seed = player.backpack.find((it) => it?.name === '可可树种子');
  const chocolate = player.backpack.find((it) => it?.name === '巧克力');
  console.log('种子:', JSON.stringify(seed ?? null), '巧克力:', JSON.stringify(chocolate ?? null), '条目数:', player.backpack.length);
  await p.$disconnect();
})();
