/**
 * 一次性脚本：直接给 路人甲 的背包发放 可可树种子×2（Json 列直读直写）。
 * 运行后删除。
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const user = await p.user.findUnique({ where: { username: '路人甲' }, select: { id: true } });
  const player = await p.player.findUnique({ where: { userId: user.id } });
  console.log('当前背包条目数:', Array.isArray(player.backpack) ? player.backpack.length : typeof player.backpack);
  // 移除旧的同名条目后追加（避免叠加重复）
  const backpack = player.backpack.filter((it) => it?.name !== '可可树种子');
  backpack.push({ name: '可可树种子', type: '物品', quantity: 2, count: 2 });
  await p.player.update({ where: { id: player.id }, data: { backpack } });
  const check = await p.player.findUnique({ where: { id: player.id }, select: { backpack: true } });
  const seed = check.backpack.find((it) => it?.name === '可可树种子');
  console.log('写入后校验:', JSON.stringify(seed), '背包条目数:', check.backpack.length);
  await p.$disconnect();
})();
