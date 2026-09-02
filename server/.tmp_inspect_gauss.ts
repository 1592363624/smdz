/* 临时调试脚本：检查含高斯步枪玩家的背包/武器/装备状态 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const players = await (prisma as any).player.findMany({
    select: { id: true, userId: true, name: true, backpack: true, weapons: true, currentWeapon: true, equipment: true },
  });
  for (const p of players) {
    const all = [p.backpack, p.weapons, p.equipment];
    const hit = JSON.stringify(all).includes('高斯步枪') || JSON.stringify(all).includes('麻醉枪');
    if (hit) {
      console.log('=== 玩家 id=', p.id, 'userId=', p.userId, 'name=', p.name, 'currentWeapon=', p.currentWeapon);
      console.log('  weapons:', JSON.stringify(p.weapons));
      console.log('  currentWeapon=', p.currentWeapon);
      const gauss = (p.backpack || []).filter((x: any) => (x.name || '').includes('高斯'));
      console.log('  背包中的高斯条目:', JSON.stringify(gauss));
    }
  }
}

main()
  .catch((e) => { console.error('ERR', e?.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());