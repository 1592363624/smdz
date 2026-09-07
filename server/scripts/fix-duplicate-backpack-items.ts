/**
 * 一次性迁移：合并玩家背包中「同名多条目」的非装备物品（Issue #11）。
 *
 * 背景（2026-09-07 线上问题：大王背包 经验胶囊 type=资源 400100 与 type=物品 400000 并存，
 * 前端 13/40 两格显示同名物品）：
 *   制造/发放等不同写入路径对缺 type 的产出默认值不一致（资源 vs 物品），
 *   而部分合并逻辑按 name+type 匹配 → 同名不同 type 永不分条合并。
 *   运行时修复（item-system addItemToBackpack 改为按名称合并、game.service
 *   normalizeItems 产出 type 对齐静态定义）已堵住新增分叉，本脚本清理存量。
 *
 * 处理逻辑：
 *   1) 扫描所有玩家背包，按名称分组非装备条目；
 *   2) 同名多条目 → 合并为一条：优先使用静态物品定义的 type（getItemByName），
 *      无定义则保留第一条的 type；数量求和，保留第一条的其余字段；
 *   3) 装备条目（type=装备）永不参与合并（词条唯一）。
 *
 * ⚠️ 在线玩家保护：updatedAt 距今 < 10 分钟的玩家视为可能在线（Actor 活态
 * 常驻内存，每分钟 ：30 的 cron 会整行写回 DB，直改必被覆盖），默认跳过；
 * 确认离线后可加 --force 强制处理。
 *
 * 用法（在 server/ 目录下）：
 *   npx ts-node scripts/fix-duplicate-backpack-items.ts --db=test             # 试运行（只读）
 *   npx ts-node scripts/fix-duplicate-backpack-items.ts --db=test --apply     # 写入测试库
 *   npx ts-node scripts/fix-duplicate-backpack-items.ts --db=prod --apply     # 写入正式库
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { PrismaService } from '../src/prisma/prisma.service';

// 与 server/.env 保持一致（测试库/正式库同主机）
const DB_URLS: Record<string, string> = {
  test: 'mysql://smdztest:smdztest@52shell.ltd:3306/smdztest?charset=utf8mb4&connection_limit=5',
  prod: 'mysql://smdz:EDzCnyba6HYnx5MT@52shell.ltd:3306/smdz?charset=utf8mb4&connection_limit=5',
};

/** 数值口径：最多两位小数（与 roundItemQuantity 一致） */
function roundQuantity(v: number): number {
  return Math.round(v * 100) / 100;
}

function parseArray(raw: any): any[] {
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

function nameOf(r: any): string {
  return String(r?.name ?? r?.名称 ?? '').trim();
}

function qtyOf(r: any): number {
  const v = Number(r?.quantity ?? r?.count ?? 0);
  return Number.isFinite(v) ? v : 0;
}

/** 写入前全量备份玩家背包列到 server/.backup/，作为回滚依据。 */
async function backupBackpacks(prisma: PrismaService, dbArg: string): Promise<string> {
  const rows = await prisma.player.findMany({
    select: { userId: true, name: true, backpack: true },
    orderBy: { userId: 'asc' },
  });
  const dir = path.resolve(__dirname, '..', '.backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `player-backpacks-${dbArg}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8');
  return file;
}

async function main() {
  const args = process.argv.slice(2);
  const dbArg = args.find((a) => a.startsWith('--db='))?.split('=')[1] ?? '';
  const apply = args.includes('--apply');
  const force = args.includes('--force');
  if (!DB_URLS[dbArg]) {
    console.error('用法: npx ts-node scripts/fix-duplicate-backpack-items.ts --db=test|prod [--apply] [--force]');
    process.exit(1);
  }
  process.env.DATABASE_URL = DB_URLS[dbArg];
  console.log(`===== 背包同名条目合并 | 库=${dbArg} | 模式=${apply ? 'APPLY(写入)' : 'DRY-RUN(只读预览)'} =====`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const staticData = app.get(StaticDataService);
  const prisma = app.get(PrismaService);

  // 静态定义 → 规范 type（装备优先，其次物品定义）
  const canonicalType = (name: string): string | undefined => {
    if (staticData.getEquipmentByName(name)) return '装备';
    return staticData.getItemByName(name)?.type;
  };

  const players = await prisma.player.findMany({
    select: { userId: true, name: true, backpack: true, updatedAt: true },
  });
  console.log(`扫描 ${players.length} 名玩家 ...\n`);

  if (apply) {
    const backupFile = await backupBackpacks(prisma, dbArg);
    console.log(`已备份玩家背包列 → ${backupFile}\n`);
  }

  const ONLINE_WINDOW_MS = 10 * 60 * 1000;
  const now = Date.now();
  let touchedPlayers = 0;
  let mergedEntries = 0;
  const skippedOnline: string[] = [];

  for (const player of players) {
    const backpack = parseArray(player.backpack);
    if (backpack.length === 0) continue;

    // 按名称分组非装备条目
    const groups = new Map<string, number[]>();
    backpack.forEach((item: any, idx: number) => {
      if (String(item?.type ?? '') === '装备') return;
      const name = nameOf(item);
      if (!name) return;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(idx);
    });

    // 只处理同名多条目
    const dupGroups = [...groups.entries()].filter(([, idxs]) => idxs.length > 1);
    if (dupGroups.length === 0) continue;

    const recent = player.updatedAt ? now - new Date(player.updatedAt).getTime() < ONLINE_WINDOW_MS : false;
    if (recent && !force) {
      skippedOnline.push(`${player.name || player.userId}(updatedAt=${new Date(player.updatedAt).toISOString()})`);
      continue;
    }

    const notes: string[] = [];
    const removeIdx = new Set<number>();
    for (const [name, idxs] of dupGroups) {
      const canonical = canonicalType(name) ?? String(backpack[idxs[0]]?.type ?? '资源');
      const base = backpack[idxs[0]];
      const totalQty = roundQuantity(idxs.reduce((s, i) => s + qtyOf(backpack[i]), 0));
      const detail = idxs.map((i) => `${backpack[i]?.type ?? '?'}x${qtyOf(backpack[i])}`).join(' + ');
      base.type = canonical;
      if (base.类型 !== undefined) base.类型 = canonical;
      base.quantity = totalQty;
      base.count = totalQty;
      for (const i of idxs.slice(1)) removeIdx.add(i);
      mergedEntries += 1;
      notes.push(`  - ${name}: ${detail} → 合并为 ${canonical} x${totalQty}`);
    }

    touchedPlayers += 1;
    console.log(`玩家#${player.userId} ${player.name || '未命名'}:`);
    for (const n of notes) console.log(n);

    if (apply) {
      const kept = backpack.filter((_: any, idx: number) => !removeIdx.has(idx));
      await prisma.player.update({
        where: { userId: player.userId },
        data: { backpack: kept as any },
      });
    }
  }

  console.log(`\n===== 汇总 =====`);
  console.log(`受影响玩家: ${touchedPlayers} 名，合并条目: ${mergedEntries} 组`);
  if (skippedOnline.length > 0) {
    console.log(`⚠️ 跳过可能在线的玩家（10 分钟内有更新，需 --force 或确认离线后重跑）:`);
    for (const s of skippedOnline) console.log(`  - ${s}`);
  }
  if (!apply) {
    console.log(`\nDRY-RUN：未写入任何数据。确认无误后加 --apply 执行。`);
  }

  await app.close();
}

main().catch((e) => {
  console.error('迁移失败:', e);
  process.exit(1);
});
