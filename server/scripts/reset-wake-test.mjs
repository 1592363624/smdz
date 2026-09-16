import { PrismaClient } from '@prisma/client';

const url =
  'mysql://smdztest:smdztest@52shell.ltd:3306/smdztest?charset=utf8mb4&connection_limit=100';

function parseVehicles(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) || []; } catch { return []; }
  }
  return [];
}

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    // 降为普通用户，避免管理员直驾绕过封印干扰测试
    await prisma.user.update({ where: { username: 'waketester' }, data: { role: 'USER' } });

    // 清理测试玩家驾驶状态
    const user = await prisma.user.findUnique({ where: { username: 'waketester' } });
    await prisma.player.update({
      where: { userId: user.id },
      data: { vehicle: '', mapId: 52, level: 300, vitality: 50 },
    });

    // 重置礁石岛遗迹为「已唤醒未开打」或「未唤醒」——统一重置为未唤醒封印态
    const map = await prisma.gameMap.findUnique({ where: { id: 52 } });
    const vehicles = parseVehicles(map.vehicles).map((v) => {
      if (String(v?.编号 ?? v?.vehicleId ?? '') !== 'VMU3ZGXFJYHSV' && String(v?.名称 ?? '') !== '掩埋的幻影骑士') {
        return v;
      }
      return {
        ...v,
        归属: '无主',
        owner: '无主',
        驾驶员: '',
        driver: '',
        封印中: true,
        sealed: true,
        当前守卫波: 0,
        sealWave: 0,
        唤醒者: '',
        sealWaker: '',
        需求等级: 250,
        requireLevel: 250,
        守卫波数: 3,
        guardWaves: 3,
        献祭凭证: 1,
        sacrificeVouchers: 1,
        献祭活力: 9,
        sacrificeVitality: 9,
      };
    });
    await prisma.gameMap.update({ where: { id: 52 }, data: { vehicles } });

    // 清掉该图上残留的 sealguard
    const deleted = await prisma.gameMonster.deleteMany({
      where: { mapId: 52, qq: { startsWith: 'sealguard_VMU3ZGXFJYHSV' } },
    });
    console.log('已重置遗迹为未唤醒封印态；删除守卫', deleted.count, '只；测试用户=USER');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
