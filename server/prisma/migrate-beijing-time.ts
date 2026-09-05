/**
 * 历史数据时区迁移脚本（一次性）：把库中所有 DateTime 列统一 +8h，
 * 使存储语义从「UTC」变为「北京时间墙上时间」，与新版应用一致。
 *
 * 用法：本脚本只做「普通 +8h」，并未附带任何业务过滤条件，运行前请先备份数据库。
 *   npm run migrate:beijing-time
 *
 * 说明：
 *  - DateTime 为 NULL 的行自动跳过（SQL 语义：NULL + INTERVAL 仍为 NULL）。
 *  - 表名/列名来自 server/prisma/schema.prisma（MySQL 映射：User→User ...）。
 *  - JSON 列内嵌的 epoch 毫秒（lastOpTime/readTime/playTime 等 BigInt）是绝对时刻，
 *    不属于 DateTime，不做偏移。
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TABLES: Array<[string, string[]]> = [
  ['User', ['lastLoginAt', 'createdAt', 'updatedAt']],
  ['UserBinding', ['createdAt']],
  ['CurrencyLog', ['createdAt']],
  ['Player', ['createdAt', 'updatedAt']],
  ['GameMap', ['createdAt', 'updatedAt']],
  ['GameMonster', ['createdAt', 'updatedAt']],
  ['GameVehicle', ['createdAt', 'updatedAt']],
  ['GameShopItem', ['expireAt', 'createdAt', 'updatedAt']],
  ['Channel', ['createdAt']],
  ['ChatMessage', ['createdAt']],
  ['CommandLog', ['createdAt']],
  ['Command', ['createdAt', 'updatedAt']],
  ['SystemConfig', ['createdAt', 'updatedAt']],
  ['PrivateMessage', ['createdAt']],
  ['Feedback', ['createdAt', 'updatedAt']],
  ['FeedbackMessage', ['createdAt']],
  ['DelayedTask', ['runAt', 'createdAt']],
];

async function main() {
  const errors: string[] = [];

  // Feedback.userLastReadAt 有「1970-01-01 00:00:00」哨兵默认值（dbgenerated）：
  // 只在真值（已读时间）上偏移，跳过哨兵本身，避免哨兵漂移到 08:00。
  try {
    const sentinel = await prisma.$executeRawUnsafe(
      `UPDATE \`Feedback\` SET \`userLastReadAt\` = \`userLastReadAt\` + INTERVAL 8 HOUR
       WHERE \`userLastReadAt\` IS NOT NULL AND \`userLastReadAt\` > '1970-01-01 02:00:00'`,
    );
    console.log(`✅ Feedback.userLastReadAt: 偏移 ${sentinel} 行`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`⚠️ Feedback.userLastReadAt: ${msg}`);
    errors.push('Feedback.userLastReadAt');
  }
  for (const [table, columns] of TABLES) {
    for (const col of columns) {
      try {
        const result = await prisma.$executeRawUnsafe(
          `UPDATE \`${table}\` SET \`${col}\` = \`${col}\` + INTERVAL 8 HOUR WHERE \`${col}\` IS NOT NULL`,
        );
        console.log(`✅ ${table}.${col}: 偏移 ${result} 行`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`⚠️ ${table}.${col}: ${msg}`);
        errors.push(`${table}.${col}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error(`\n以下列偏移失败，请手动处理：\n${errors.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('\n🎉 全部 DateTime 列已偏移为北京时间。');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });