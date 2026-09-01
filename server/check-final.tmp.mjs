/**
 * 一次性脚本：核对掉落链路终态（exp/钻石/背包物品是否与两次击杀预期一致）。
 * 运行后删除。
 */
const { PrismaClient } = await import('@prisma/client');
const p = new PrismaClient();
const u = await p.user.findUnique({ where: { username: '路人甲' }, select: { id: true } });
const row = await p.player.findUnique({ where: { userId: u.id }, select: { exp: true, level: true, diamonds: true, backpack: true } });
console.log('exp=', row.exp, 'level=', row.level, 'diamonds=', row.diamonds);
const bp = Array.isArray(row.backpack) ? row.backpack : [];
for (const n of ['钻石', '生肉', '普通战利品']) {
  const items = bp.filter((i) => i?.name === n);
  console.log(`${n}:`, JSON.stringify(items));
}
await p.$disconnect();
