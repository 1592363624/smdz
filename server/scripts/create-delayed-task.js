/* 一次性：创建 DelayedTask 表（幂等）。 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const SQL = `CREATE TABLE IF NOT EXISTS \`DelayedTask\` (
  \`id\` INTEGER NOT NULL AUTO_INCREMENT,
  \`type\` VARCHAR(191) NOT NULL,
  \`userId\` INTEGER NULL,
  \`dedupeKey\` VARCHAR(191) NULL,
  \`payload\` JSON NOT NULL DEFAULT ('{}'),
  \`runAt\` DATETIME(3) NOT NULL,
  \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX \`DelayedTask_runAt_idx\`(\`runAt\`),
  INDEX \`DelayedTask_type_userId_dedupeKey_idx\`(\`type\`, \`userId\`, \`dedupeKey\`),
  PRIMARY KEY (\`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;
(async () => {
  await p.$executeRawUnsafe(SQL);
  const cnt = await p.delayedTask.count();
  console.log('DelayedTask table ready, rows:', cnt);
  await p.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
