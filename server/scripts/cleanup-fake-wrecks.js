/**
 * 清理历史定时器BUG生成的"空壳无主载具"
 *
 * 背景：旧版 schedule.service.spawnRandomVehicle 用错误的默认名单
 * （流浪者/勘探者/游骑兵/探险家/开拓者）生成无主载具，且 parts 恒为空、
 * 血量固定 100 —— 不是 wrecks.json 里的真废弃载具，属于无效脏数据。
 *
 * 清理判据（三条同时满足才删除，避免误伤玩家载具）：
 *   1. owner === '无主'（玩家自己的载具 owner 是 userId，不受影响）
 *   2. 名称属于旧版错误名单 FAKE_NAMES
 *   3. parts 为空数组（真废弃载具带有完整零件清单）
 *
 * 用法：node scripts/cleanup-fake-wrecks.js
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/** 旧版 schedule.service.ts DEFAULT_VEHICLES 错误名单 */
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

    // 只删"无主 + 错误名单名 + 零件为空"的空壳，真废弃载具与玩家载具一律保留
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
