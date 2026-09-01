/** 一次性脚本：查询管理员账号。运行后删除。 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const admins = await p.user.findMany({
    where: { role: { contains: 'ADMIN' } },
    select: { id: true, username: true, role: true },
  });
  console.log(JSON.stringify(admins));
  await p.$disconnect();
})();
