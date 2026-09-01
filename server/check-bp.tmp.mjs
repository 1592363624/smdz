/**
 * 一次性脚本：检查击杀掉落是否真实落库（钻石/高斯步枪/资源箱/精英战利品）。
 * 运行后删除。
 */
const { PrismaClient } = await import('@prisma/client');
const p = new PrismaClient();
(async () => {
  const u = await p.user.findUnique({ where: { username: '路人甲' }, select: { id: true } });
  const pl = await p.player.findUnique({ where: { userId: u.id }, select: { level: true, exp: true, backpack: true, hp: true } });
  console.log('level=' + pl.level, 'exp=' + pl.exp, 'hp=' + pl.hp);
  for (const it of pl.backpack) console.log(' -', it?.name, 'x' + (it?.count ?? it?.quantity), it?.type ?? '');
  await p.$disconnect();
})();
