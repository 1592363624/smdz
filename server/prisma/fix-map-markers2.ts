/**
 * 一次性数据修复：把 GameMap.markers2 中误存为对象('{}')的存量数据归一化为数组('[]')。
 * 背景：seed-data.ts 历史版本创建地图时 markers2 误初始化为 '{}'，
 * 而框架约定（对齐原版 标记2）为数组元素 {name, expireAt}，导致采集/刷新/战斗等
 * 按数组解析的链路崩溃（表现为"捡垃圾"等指令报"未找到指令"）。
 * 运行：npx ts-node prisma/fix-map-markers2.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const maps = await prisma.gameMap.findMany({ select: { id: true, name: true, markers2: true } });
  let fixed = 0;
  for (const map of maps) {
    let parsed: any;
    try {
      parsed = JSON.parse(map.markers2 || '[]');
    } catch {
      parsed = null;
    }
    if (Array.isArray(parsed)) continue; // 已是数组，无需处理
    // 对象/损坏数据 → 归一化为空数组（原语义即"无地图标记"）
    await prisma.gameMap.update({ where: { id: map.id }, data: { markers2: '[]' } });
    fixed += 1;
    console.log(`修复 地图${map.id}[${map.name}] markers2: ${String(map.markers2).slice(0, 60)} → []`);
  }
  console.log(`完成：共 ${maps.length} 张地图，修复 ${fixed} 张`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
