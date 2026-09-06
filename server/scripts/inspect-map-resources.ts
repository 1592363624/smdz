/**
 * 地图资源只读诊断：打印指定地图的 resources / resources2 摘要，用于排查
 *「观察附近看得到、点编号采不到」这类僵尸资源问题。
 *
 * 输出每列的：名称、次数(times)、数量(amount)、采集指令(gatherCmd)、产出条数，
 * 并标出「缺 gatherCmd」（编号会注册成空指令 → 玩家发数字完全无反应）与
 *「落在 resources2 但采集可见集只读 resources」（永远匹配不到）两种异常。
 *
 * 用法（在 server/ 目录下）：
 *   npx ts-node scripts/inspect-map-resources.ts --db=prod --map=森林出口
 *   npx ts-node scripts/inspect-map-resources.ts --db=test --map=森林出口,城镇出口
 *   npx ts-node scripts/inspect-map-resources.ts --db=prod --map=森林出口 --full
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const DB_URLS: Record<string, string> = {
  test: 'mysql://smdztest:smdztest@52shell.ltd:3306/smdztest?charset=utf8mb4&connection_limit=5',
  prod: 'mysql://smdz:EDzCnyba6HYnx5MT@52shell.ltd:3306/smdz?charset=utf8mb4&connection_limit=5',
};

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

function brief(r: any): string {
  const name = String(r?.name ?? r?.名称 ?? '未知');
  const times = r?.times ?? r?.次数;
  const amount = r?.amount ?? r?.数量;
  const cmd = String(r?.gatherCmd ?? r?.采集指令 ?? '');
  const outputs = Array.isArray(r?.outputs) ? r.outputs.length : 0;
  const flags: string[] = [];
  if (!cmd) flags.push('缺gatherCmd');
  if (outputs === 0) flags.push('缺产出');
  const parts = [
    `次数=${times ?? '-'}`,
    amount !== undefined ? `数量=${amount}` : '',
    `指令=${cmd || '空'}`,
    `产出${outputs}条`,
  ].filter(Boolean);
  return `    ${name} [${parts.join(' ')}]${flags.length ? '  ⚠ ' + flags.join('/') : ''}`;
}

async function main() {
  const args = process.argv.slice(2);
  const dbArg = args.find((a) => a.startsWith('--db='))?.split('=')[1] ?? '';
  const mapArg = args.find((a) => a.startsWith('--map='))?.split('=')[1] ?? '';
  if (!DB_URLS[dbArg] || !mapArg) {
    console.error('用法: npx ts-node scripts/inspect-map-resources.ts --db=test|prod --map=地图名[,地图名2]');
    process.exit(1);
  }
  process.env.DATABASE_URL = DB_URLS[dbArg];
  const names = mapArg.split(',').map((s) => s.trim()).filter(Boolean);
  console.log(`===== 地图资源诊断 | 库=${dbArg} | 地图=${names.join('、')} =====`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);

  for (const name of names) {
    const maps = await prisma.gameMap.findMany({
      where: { name },
      select: { id: true, name: true, resources: true, resources2: true },
    });
    if (maps.length === 0) {
      console.log(`\n【${name}】未找到`);
      continue;
    }
    for (const map of maps) {
      const resources = parseArray(map.resources);
      const resources2 = parseArray(map.resources2);
      // 采集链路的可见集：resources 非空时只读 resources
      const gatherPoolIsResources = resources.length > 0;
      console.log(`\n【${map.name}】id=${map.id}`);
      console.log(`  采集可见集 = ${gatherPoolIsResources ? 'resources（resources2 读不到）' : 'resources2（resources 为空）'}`);
      console.log(`  resources (${resources.length}):`);
      resources.forEach((r) => console.log(brief(r)));
      console.log(`  resources2 (${resources2.length}):`);
      resources2.forEach((r) => {
        console.log(brief(r));
        if (gatherPoolIsResources) {
          const rName = String(r?.name ?? r?.名称 ?? '');
          const dup = resources.some((g: any) => String(g?.name ?? g?.名称 ?? '') === rName);
          console.log(`      ↳ ${dup ? '采集可见集已有同名项（不会重复编号）' : '⚠ 采集链路读不到，手动输入指令也匹配不到'}`);
        }
      });
    }
  }

  await app.close();
}

main().catch((e) => {
  console.error('诊断失败:', e);
  process.exit(1);
});
