const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const players = await p.player.findMany({ include: { user: { select: { username: true, nickname: true, id: true } } } });
  const withFam = players.filter(pl => pl.type);
  console.log('有效使魔玩家:', withFam.length);
  for (const pl of withFam) {
    const uname = pl.user?.username || '';
    console.log({ userId: pl.userId, username: uname, len: uname.length, nickname: pl.user?.nickname, name: pl.name, level: pl.level, type: pl.type });
  }
  await p.$disconnect();
})();