import { PrismaClient } from '@prisma/client';

const url = process.argv[2];
if (!url) {
  console.error('usage: node scripts/db-ping.mjs <DATABASE_URL>');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });
try {
  const rows = await prisma.$queryRawUnsafe('SELECT 1 AS ok');
  console.log('ok', rows);
} catch (e) {
  console.error('fail', e.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
