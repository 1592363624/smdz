// 列出所有玩家以找到已有使魔的测试账号
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const players = await p.player.findMany({ take: 8, include: { user: { select: { username: true, nickname: true } } } });
  for (const pl of players) {
    console.log({
      userId: pl.userId, username: pl.user?.username, nickname: pl.user?.nickname,
      name: pl.name, level: pl.level, type: pl.type,
    });
  }
  await p.$disconnect();
})();