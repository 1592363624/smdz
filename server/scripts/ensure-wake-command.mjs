/**
 * 把「唤醒 / 确认唤醒」写入两库 Command 表。
 * 用法：node scripts/ensure-wake-command.mjs
 */
import { PrismaClient } from '@prisma/client';

const TEST_URL =
  'mysql://smdztest:smdztest@52shell.ltd:3306/smdztest?charset=utf8mb4&connection_limit=100';
const PRD_URL =
  process.env.PRD_DATABASE_URL ||
  'mysql://smdz:EDzCnyba6HYnx5MT@52shell.ltd:3306/smdz?charset=utf8mb4&connection_limit=100';

const COMMANDS = [
  {
    name: '唤醒',
    alias: 'wake-wreck',
    description: '唤醒被封印的远古遗迹（先确认再献祭+守卫战）',
    sortOrder: 2221,
  },
  {
    name: '确认唤醒',
    alias: 'confirm-wake-wreck',
    description: '确认唤醒远古遗迹并自动进入守卫战',
    sortOrder: 2222,
  },
];

async function ensureCmd(url, label, spec) {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const existing = await prisma.command.findFirst({ where: { name: spec.name } });
    if (existing) {
      await prisma.command.update({
        where: { id: existing.id },
        data: {
          alias: spec.alias,
          description: spec.description,
          handlerKey: 'game',
          minRole: 'USER',
          enabled: true,
        },
      });
      console.log(`[${label}] 已存在「${spec.name}」，已刷新 id=${existing.id}`);
    } else {
      const row = await prisma.command.create({
        data: {
          name: spec.name,
          alias: spec.alias,
          description: spec.description,
          handlerKey: 'game',
          minRole: 'USER',
          sortOrder: spec.sortOrder,
          enabled: true,
        },
      });
      console.log(`[${label}] 已插入「${spec.name}」id=${row.id}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  for (const spec of COMMANDS) {
    await ensureCmd(TEST_URL, '测试库', spec);
    await ensureCmd(PRD_URL, '正式库', spec);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
