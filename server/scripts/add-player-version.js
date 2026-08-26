/* 守卫式加列：Player.version + (id, version) 复合唯一索引（幂等，可重复执行） */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const col = await p.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Player' AND COLUMN_NAME = 'version'`,
  );
  if (!col[0].n) {
    await p.$executeRawUnsafe('ALTER TABLE `Player` ADD COLUMN `version` INTEGER NOT NULL DEFAULT 0');
    console.log('added column version');
  } else {
    console.log('column version already exists');
  }

  const idx = await p.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Player' AND INDEX_NAME = 'Player_id_version_key'`,
  );
  if (!idx[0].n) {
    await p.$executeRawUnsafe('CREATE UNIQUE INDEX `Player_id_version_key` ON `Player`(`id`, `version`)');
    console.log('created index Player_id_version_key');
  } else {
    console.log('index already exists');
  }

  const check = await p.$queryRawUnsafe(`SELECT id, userId, version FROM Player LIMIT 3`);
  console.log('sample rows:', JSON.stringify(check));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
