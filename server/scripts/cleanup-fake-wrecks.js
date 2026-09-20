/**
 * 清理"空壳无主载具"（幂等：命中条目删除后重复执行无副作用）
 *
 * 清理判据（三条同时满足才删除，避免误伤玩家载具）：
 *   1. owner === '无主'（玩家自己的载具 owner 是 userId，不受影响）
 *   2. 名称属于错误默认名单 FAKE_NAMES（非 wrecks.json 里的真废弃载具）
 *   3. parts 为空数组（真废弃载具带有完整零件清单）
 *
 * 用法：node scripts/cleanup-fake-wrecks.js
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/** 空壳无主载具的名字集合 */
const FAKE_NAMES = ['流浪者', '勘探者', '游骑兵', '探险家', '开拓者'];

async function main() {
  // vehicles 是 Json 字段，Prisma 不支持 contains 过滤，全量拉取后在 JS 中筛选
  const maps = await prisma.gameMap.findMany({
    select: { id: true, name: true, vehicles: true },
  });

  let removedTotal = 0;
  let touchedMaps = 0;
  for (const map of maps) {
    // Prisma Json 字段返回时已是对象/数组，兼容字符串与已解析两种形态
    let vehicles;
    const raw = map.vehicles;
    if (Array.isArray(raw)) {
      vehicles = raw;
    } else if (typeof raw === 'string') {
      try {
        vehicles = JSON.parse(raw || '[]');
      } catch {
        console.warn(`地图 ${map.name}(id=${map.id}) vehicles JSON 解析失败，跳过`);
        continue;
      }
    } else {
      vehicles = [];
    }
    if (!Array.isArray(vehicles)) continue;

    const kept = vehicles.filter((v) => {
      const isFake =
        String(v?.owner ?? '') === '无主' &&
        FAKE_NAMES.includes(String(v?.name ?? '')) &&
        (!Array.isArray(v?.parts) || v.parts.length === 0);
      return !isFake;
    });

    const removed = vehicles.length - kept.length;
    if (removed > 0) {
      await prisma.gameMap.update({
        where: { id: map.id },
        data: { vehicles: kept },
      });
      removedTotal += removed;
      touchedMaps++;
      console.log(`地图 ${map.name}(id=${map.id}): 移除 ${removed} 个空壳无主载具`);
    }
  }
  console.log(`清理完成：共移除 ${removedTotal} 个（涉及 ${touchedMaps} 张地图）`);
}

main()
  .catch((e) => {
    console.error('清理失败:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
