import { PrismaClient } from '@prisma/client';

const url =
  'mysql://smdztest:smdztest@52shell.ltd:3306/smdztest?charset=utf8mb4&connection_limit=100';

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    // 1. 找无主载具所在地图
    const maps = await prisma.gameMap.findMany({ select: { id: true, name: true, vehicles: true } });
    let wreckMap = null;
    let wreckId = '';
    let wreckName = '';
    for (const m of maps) {
      const vs = typeof m.vehicles === 'string' ? JSON.parse(m.vehicles || '[]') : (m.vehicles || []);
      for (const v of vs) {
        const owner = String(v?.归属 ?? v?.owner ?? '');
        if (owner === '无主') {
          wreckMap = { id: m.id, name: m.name };
          wreckId = String(v?.编号 ?? v?.vehicleId ?? '');
          wreckName = String(v?.名称 ?? v?.name ?? '');
        }
      }
    }
    console.log('遗迹:', wreckName, wreckId, '地图:', wreckMap);

    // 2. 找/建 waketester
    let user = await prisma.user.findUnique({ where: { username: 'waketester' } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          username: 'waketester',
          password: 'waketester',
          nickname: '唤醒测试员',
          role: 'ADMIN',
        },
      });
      console.log('创建用户', user.id);
    } else {
      await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
      console.log('已有用户', user.id, '已设为 ADMIN');
    }

    let player = await prisma.player.findUnique({ where: { userId: user.id } });
    if (!player) {
      player = await prisma.player.create({
        data: {
          userId: user.id,
          name: '唤醒测试员',
          type: '粉狐狐',
          level: 300,
          vitality: 50,
          mapId: wreckMap?.id ?? 3,
          backpack: [
            { name: '凭证', type: '资源', count: 20, quantity: 20 },
          ],
        },
      });
    } else {
      await prisma.player.update({
        where: { userId: user.id },
        data: {
          name: '唤醒测试员',
          type: player.type || '粉狐狐',
          level: 300,
          vitality: 50,
          mapId: wreckMap?.id ?? player.mapId,
          backpack: [
            { name: '凭证', type: '资源', count: 20, quantity: 20 },
          ],
        },
      });
    }
    console.log('玩家 mapId=', player.mapId, 'level=', 300, '凭证=20 活力=50');

    // 3. 确认测试库 Command 有 唤醒
    const wakeCmd = await prisma.command.findFirst({ where: { name: '唤醒' } });
    console.log('Command 唤醒:', wakeCmd ? `id=${wakeCmd.id} enabled=${wakeCmd.enabled}` : '缺失!');

    // 4. monseters 有遗迹守卫
    const guard = await prisma.$queryRawUnsafe(
      `SELECT name FROM monsters WHERE name = '遗迹守卫' LIMIT 1`,
    ).catch(() => null);
    // monsters 在静态 JSON，不查库
    console.log('done');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
