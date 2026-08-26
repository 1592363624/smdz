/* 守卫式加列：货币列化 P1（幂等） */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const cols = [
    ['diamonds', 'FLOAT NOT NULL DEFAULT 0'],
    ['tickets', 'FLOAT NOT NULL DEFAULT 0'],
    ['dataCores', 'FLOAT NOT NULL DEFAULT 0'],
  ];
  for (const [name, ddlType] of cols) {
    const exists = await p.$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Player' AND COLUMN_NAME = '${name}'`,
    );
    if (!exists[0].n) {
      await p.$executeRawUnsafe(`ALTER TABLE \`Player\` ADD COLUMN \`${name}\` ${ddlType}`);
      console.log(`added column ${name}`);
    } else {
      console.log(`column ${name} already exists`);
    }
  }

  // 存量回填：从背包 JSON 提取三种货币到列（只在列为全零时执行，避免覆盖）
  const players = await p.player.findMany({ select: { id: true, backpack: true, diamonds: true, tickets: true, dataCores: true } });
  let migrated = 0;
  for (const row of players) {
    if (row.diamonds !== 0 || row.tickets !== 0 || row.dataCores !== 0) continue;
    let items = [];
    try { items = JSON.parse(row.backpack || '[]'); } catch { continue; }
    const getQty = (name) => {
      const it = items.find((i) => i && i.name === name);
      return Number(it?.quantity ?? it?.count ?? 0);
    };
    await p.player.update({
      where: { id: row.id },
      data: {
        diamonds: getQty('钻石'),
        tickets: getQty('召唤券'),
        dataCores: getQty('数据核心'),
      },
    });
    migrated++;
  }
  console.log(`backfilled ${migrated} players`);

  const sample = await p.$queryRawUnsafe('SELECT id, userId, diamonds, tickets FROM Player LIMIT 3');
  console.log(JSON.stringify(sample));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
