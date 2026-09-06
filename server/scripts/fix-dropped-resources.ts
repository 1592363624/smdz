/**
 * 一次性迁移：修复「掉落的货舱 / 能量元素落在 resources2、且缺完整定义」的僵尸资源。
 *
 * 背景（2026-09-06 线上问题：森林出口 能量元素×9 / 货舱×10 编号点了没有任何反应）：
 *   定时任务 dropCargoPods 原先把动态资源写成 {name,type,amount,respawnTime} 字面量
 *   塞进 GameMap.resources2，缺 gatherCmd / times / outputs：
 *     1) 观察附近照样给它编了号，但 cmd 为空 → 编号不注册 → 发数字完全无反应；
 *     2) 采集链路 getGatherResources 在 resources 非空时只读 resources → 永远采不到；
 *     3) 即便采到也因为 outputs 为空而「什么都没有收集到」。
 *   运行时修复（schedule.service + map.service.dropResourceToMap）已把投放改为
 *   「完整模板 + 写 resources + 累加 times」，本脚本清理修复前留下的存量脏数据。
 *
 * 处理逻辑：
 *   1) 扫描每张地图的 resources2，筛出目标条目（默认：货舱/能量元素，且缺 gatherCmd）；
 *   2) 从 resources2 移除该条目，取其 amount（≥1）作为可采集次数；
 *   3) 在 resources 中 upsert 同名条目：已存在 → times += amount；不存在 → 用全局
 *      resources.json 的完整定义写入，times = amount。
 *
 * ⚠️ 建议在停服/低峰窗口运行：脚本直接 update GameMap，绕过 MapService 的
 * per-map 串行锁，与同时发生的采集结算并发时存在丢失更新风险（概率低）。
 *
 * 用法（在 server/ 目录下）：
 *   npx ts-node scripts/fix-dropped-resources.ts --db=test                  # 试运行（只读）
 *   npx ts-node scripts/fix-dropped-resources.ts --db=test --apply          # 写入测试库
 *   npx ts-node scripts/fix-dropped-resources.ts --db=prod --apply          # 写入正式库
 *   npx ts-node scripts/fix-dropped-resources.ts --db=prod --names=货舱,能量元素
 *   npx ts-node scripts/fix-dropped-resources.ts --db=prod --all            # 迁移所有 resources2 条目（慎用）
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

const DEFAULT_NAMES = ['货舱', '能量元素'];

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

function timesOf(r: any): number {
  const v = Number(r?.times ?? r?.次数 ?? 0);
  return Number.isFinite(v) ? v : 0;
}

function amountOf(r: any): number {
  const v = Number(r?.amount ?? r?.数量 ?? 1);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 1;
}

function hasGatherCmd(r: any): boolean {
  return String(r?.gatherCmd ?? r?.采集指令 ?? '').trim() !== '';
}

/**
 * 写入前全量备份地图资源列到 server/.backup/，作为回滚依据。
 * 只备份本次会动的两列（resources / resources2），体积小、可直接用于人工回滚。
 */
async function backupMapResources(prisma: PrismaService, dbArg: string): Promise<string> {
  const rows = await (prisma as any).gameMap.findMany({
    select: { id: true, name: true, resources: true, resources2: true },
    orderBy: { id: 'asc' },
  });
  const dir = path.resolve(__dirname, '..', '.backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `map-resources-${dbArg}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8');
  return file;
}

async function main() {
  const args = process.argv.slice(2);
  const dbArg = args.find((a) => a.startsWith('--db='))?.split('=')[1] ?? '';
  const apply = args.includes('--apply');
  const all = args.includes('--all');
  const namesArg = args.find((a) => a.startsWith('--names='))?.split('=')[1] ?? '';
  if (!DB_URLS[dbArg]) {
    console.error('用法: npx ts-node scripts/fix-dropped-resources.ts --db=test|prod [--apply] [--all] [--names=货舱,能量元素]');
    process.exit(1);
  }
  process.env.DATABASE_URL = DB_URLS[dbArg];
  console.log(`===== 掉落资源迁移 | 库=${dbArg} | 模式=${apply ? 'APPLY(写入)' : 'DRY-RUN(只读预览)'} | 范围=${all ? '全部 resources2 条目' : (namesArg || DEFAULT_NAMES.join(','))} =====`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const staticData = app.get(StaticDataService);
  const prisma = app.get(PrismaService);

  const resourceDefs = staticData.getAllResources() as any[];
  const defByName = new Map<string, any>(
    resourceDefs.map((r: any) => [String(r?.name ?? '').trim(), r]),
  );
  console.log(`全局资源表载入 ${defByName.size} 条定义`);

  const targetNames = new Set(
    (namesArg ? namesArg.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_NAMES),
  );

  const maps = await prisma.gameMap.findMany({ select: { id: true, name: true, resources: true, resources2: true } });
  console.log(`扫描 ${maps.length} 张地图 ...\n`);

  if (apply) {
    const backupFile = await backupMapResources(prisma, dbArg);
    console.log(`已备份地图资源列 → ${backupFile}\n`);
  }

  let touchedMaps = 0;
  let movedEntries = 0;
  let totalTimes = 0;
  const missingDef = new Set<string>();
  const perName: Record<string, number> = {};

  for (const map of maps) {
    const resources2 = parseArray(map.resources2);
    if (resources2.length === 0) continue;

    const hitIdx: number[] = [];
    resources2.forEach((r: any, idx: number) => {
      const name = nameOf(r);
      if (!name) return;
      if (!all) {
        if (!targetNames.has(name)) return;
        if (hasGatherCmd(r)) return; // 定义完整的条目不动（正常运行时数据）
      }
      hitIdx.push(idx);
    });
    if (hitIdx.length === 0) continue;

    const resources = parseArray(map.resources);
    const notes: string[] = [];

    for (const idx of hitIdx) {
      const stale = resources2[idx];
      const name = nameOf(stale);
      const amount = Math.max(amountOf(stale), timesOf(stale), 1);
      const existing = resources.find((r: any) => nameOf(r) === name);

      if (existing) {
        const next = timesOf(existing) + amount;
        existing.times = next;
        if (existing.次数 !== undefined) existing.次数 = next;
        notes.push(`${name} 合并(原${timesOf(existing) - amount}次 +${amount}) → ${next}次`);
      } else {
        const def = defByName.get(name);
        if (!def) {
          missingDef.add(name);
          notes.push(`${name} 全局资源表缺定义，跳过`);
          continue;
        }
        const created = JSON.parse(JSON.stringify(def));
        created.name = name;
        created.times = amount;
        if (created.次数 !== undefined) created.次数 = amount;
        resources.push(created);
        notes.push(`${name} 新建(${amount}次)`);
      }
      movedEntries += 1;
      totalTimes += amount;
      perName[name] = (perName[name] ?? 0) + amount;
    }

    // 从 resources2 移除已处理条目（倒序 splice）
    const keptResources2 = resources2.filter((_: any, idx: number) => !hitIdx.includes(idx));
    if (keptResources2.length === resources2.length) continue;

    touchedMaps += 1;
    console.log(`地图#${map.id} ${map.name}:`);
    for (const n of notes) console.log(`  - ${n}`);

    if (apply) {
      await prisma.gameMap.update({
        where: { id: map.id },
        data: { resources, resources2: keptResources2 },
      });
    }
  }

  console.log(`\n===== 汇总 =====`);
  console.log(`受影响地图: ${touchedMaps} 张`);
  console.log(`迁移条目: ${movedEntries} 条，累计可采集次数: ${totalTimes}`);
  for (const [name, times] of Object.entries(perName)) {
    console.log(`  ${name}: ${times} 次`);
  }
  if (missingDef.size > 0) {
    console.log(`⚠️ 全局资源表缺少定义的资源名: ${[...missingDef].join('、')}`);
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
