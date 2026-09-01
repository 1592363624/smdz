// 删除脚本 v2（更可靠）：逐行读出 backpack -> JS 删除 name==="主线补给箱" -> update 写回
// 关键改动：打印 update 返回的 affected rows，确认是否真落库；最后用 $queryRaw 复查。
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const TARGET = '主线补给箱';

function parse(backpackRaw) {
  if (!backpackRaw) return [];
  try { const a = JSON.parse(backpackRaw); return Array.isArray(a) ? a : []; } catch { return []; }
}

async function clean(modelLabel, findMany, updateOne, idField) {
  console.log(`\n===== 清理 ${modelLabel} =====`);
  const rows = await findMany();
  let changed = 0;
  for (const row of rows) {
    const items = parse(row.backpack);
    const remaining = items.filter((it) => !(it && it.name === TARGET));
    if (remaining.length !== items.length) {
      const removed = items.length - remaining.length;
      const after = JSON.stringify(remaining);
      const res = await updateOne(row[idField], after);
      console.log(`  ✓ id=${row[idField]} 移除=${removed} update返回=${JSON.stringify(res)}`);
      changed++;
    }
  }
  console.log(`  ${modelLabel} 已更新行数: ${changed}`);
  return changed;
}

(async () => {
  try {
    await clean(
      'Player',
      () => prisma.player.findMany({ select: { id: true, backpack: true } }),
      (id, backpack) => prisma.player.updateMany({ where: { id }, data: { backpack } }),
      'id'
    );
    await clean(
      'GameMonster',
      () => prisma.gameMonster.findMany({ select: { id: true, backpack: true } }),
      (id, backpack) => prisma.gameMonster.updateMany({ where: { id }, data: { backpack } }),
      'id'
    );

    // 复查（原生 SQL，确认真落库）
    console.log('\n===== 复查 (SQL) =====');
    const players = await prisma.$queryRawUnsafe(
      `SELECT id, name, JSON_LENGTH(backpack) AS cnt,
              (SELECT COUNT(*) FROM JSON_TABLE(backpack, '$[*]' COLUMNS(n VARCHAR(255) PATH '$.name')) AS jt WHERE jt.n = ?) AS hit
       FROM Player HAVING hit > 0`,
      TARGET
    );
    console.log('复查仍含主线补给箱的 Player 行:', JSON.stringify(players));
    if (!players || players.length === 0) console.log('✅ 已全部清除');
  } catch (e) {
    console.error('删除失败:', e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
