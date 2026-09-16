import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient({
  datasources: { db: { url: 'mysql://smdztest:smdztest@52shell.ltd:3306/smdztest?charset=utf8mb4&connection_limit=100' } },
});
const g = await prisma.gameMonster.findMany({ where: { mapId: 52, qq: { startsWith: 'sealguard_' } } });
for (const m of g) {
  await prisma.gameMonster.update({
    where: { id: m.id },
    data: { hp: 10, maxHp: 10, shield: 0, maxShield: 0, armor: 0, maxArmor: 0 },
  });
}
console.log('lowered', g.length);
await prisma.$disconnect();
