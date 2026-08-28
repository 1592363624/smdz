// 临时排查脚本：统计全库 lastOpTime / readTime / vitality（用完即删）
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const big = (k, v) => (typeof v === 'bigint' ? v.toString() : v);

(async () => {
  const r = await prisma.$queryRawUnsafe(
    'SELECT MAX(lastOpTime) AS maxOp, MAX(readTime) AS maxRead, COUNT(*) AS c FROM Player'
  );
  console.log('global=', JSON.stringify(r, big));
  const v = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*) AS c FROM Player WHERE vitality > 0'
  );
  console.log('vitalityGreaterThan0=', JSON.stringify(v, big));
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); });
