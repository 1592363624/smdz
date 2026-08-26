/* 守卫式建表：CurrencyLog 货币审计日志（P4，幂等） */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const exists = await p.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'CurrencyLog'`,
  );
  if (!exists[0].n) {
    await p.$executeRawUnsafe(`
      CREATE TABLE \`CurrencyLog\` (
        \`id\` INTEGER NOT NULL AUTO_INCREMENT,
        \`userId\` INTEGER NOT NULL,
        \`currency\` VARCHAR(191) NOT NULL,
        \`delta\` DOUBLE NOT NULL,
        \`balanceAfter\` DOUBLE NOT NULL,
        \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        INDEX \`CurrencyLog_userId_createdAt_idx\`(\`userId\`, \`createdAt\`),
        PRIMARY KEY (\`id\`)
      ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    console.log('created table CurrencyLog');
  } else {
    console.log('table CurrencyLog already exists');
  }
  const n = await p.$queryRawUnsafe('SELECT COUNT(*) AS n FROM CurrencyLog');
  console.log('rows:', n[0].n);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
