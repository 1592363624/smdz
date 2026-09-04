/**
 * Issue #6 一次性迁移：修复存量「任务奖励装备被误发放为堆叠资源」的背包条目。
 *
 * 背景：task.service.isEquipmentReward 此前只认显式 type='装备'，tasks.json 中
 * 未标注类型的装备奖励（麻醉枪/隐形披风/次元之刃/次元破碎）被写成
 * { name, count:100, quantity:100, type:'资源' } 堆叠条目，无法装备。
 * 已在 task.service.ts / player.service.ts / item.service.ts 落实运行时修复。
 *
 * 本脚本做数据层收尾（对齐 Issue 回复承诺「清理并补发」）：
 *   1) 扫描 Player.backpack：命中装备表名字、且 type 不是 装备/武器 的条目为坏条目；
 *   2) 移除同名坏条目，每人每个装备名补发 1 件真装备（数量语义为 100% 概率出 1 件，
 *      对齐原版几率判断），品质/词条走运行时 generateRewardEquipment 随机生成，
 *      与修复后任务结算的发放口径完全一致；
 *   3) 写入前打印逐玩家摘要，最后复查确认零残留。
 *
 * ⚠️ 建议 AGENT/游戏服务停服窗口运行：脚本绕过 enqueueUserWrite 串行锁与
 * Player.version 乐观锁（updateMany 不动 version，不会引发服务端 CAS 误拒，
 * 但并发在线玩家的背包写回可能覆盖迁移结果）。
 *
 * 用法（在 server/ 目录下）：
 *   npx ts-node scripts/migrate-issue6-equipment-rewards.ts --db=test            # 试运行（只读）
 *   npx ts-node scripts/migrate-issue6-equipment-rewards.ts --db=test --apply    # 写入测试库
 *   npx ts-node scripts/migrate-issue6-equipment-rewards.ts --db=prod --apply    # 写入正式库
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ItemSystemService } from '../src/modules/game/item-system.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { PrismaService } from '../src/prisma/prisma.service';

// 与 server/.env 保持一致（测试库/正式库同主机）
const DB_URLS: Record<string, string> = {
  test: 'mysql://smdztest:smdztest@52shell.ltd:3306/smdztest?charset=utf8mb4&connection_limit=5',
  prod: 'mysql://smdz:EDzCnyba6HYnx5MT@52shell.ltd:3306/smdz?charset=utf8mb4&connection_limit=5',
};

interface BackpackItem {
  name?: string;
  类型?: string;
  type?: string;
  count?: number;
  quantity?: number;
  [k: string]: any;
}

function parseBackpack(raw: any): BackpackItem[] {
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

/** 坏条目：名字命中装备表，且类型不是 装备/武器（即被当资源/无类型堆叠发放的装备） */
function isBrokenEntry(item: any, equipNames: Set<string>): boolean {
  if (!item || typeof item !== 'object') return false;
  const name = String(item.name ?? item['名称'] ?? '');
  if (!name || !equipNames.has(name)) return false;
  const type = String(item.type ?? item['类型'] ?? '');
  return type !== '装备' && type !== '武器';
}

async function main() {
  const args = process.argv.slice(2);
  const dbArg = args.find((a) => a.startsWith('--db='))?.split('=')[1] ?? '';
  const apply = args.includes('--apply');
  if (!DB_URLS[dbArg]) {
    console.error('用法: npx ts-node scripts/migrate-issue6-equipment-rewards.ts --db=test|prod [--apply]');
    process.exit(1);
  }
  process.env.DATABASE_URL = DB_URLS[dbArg];
  console.log(`===== Issue#6 装备奖励迁移 | 库=${dbArg} | 模式=${apply ? 'APPLY(写入)' : 'DRY-RUN(只读预览)'} =====`);

  // 启动独立应用上下文（不监听端口、无定时器），复用运行时装备生成口径
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const itemSystem = app.get(ItemSystemService);
  const staticData = app.get(StaticDataService);
  const prisma = app.get(PrismaService);

  const equipNames = new Set<string>(
    staticData.getAllEquipments().map((e: any) => String(e?.name ?? '')),
  );
  console.log(`装备表载入 ${equipNames.size} 个装备名`);

  const players = await prisma.player.findMany({ select: { id: true, userId: true, name: true, backpack: true } });
  console.log(`扫描 ${players.length} 个玩家档案 ...`);

  let touchedPlayers = 0;
  let removedEntries = 0;
  const grantedSummary: Record<string, number> = {};

  for (const p of players) {
    const backpack = parseBackpack(p.backpack);
    const brokenIdx = backpack
      .map((it, idx) => ({ it, idx }))
      .filter(({ it }) => isBrokenEntry(it, equipNames));
    if (brokenIdx.length === 0) continue;

    // 每个装备名补发 1 件（数量字段语义为概率，100 = 100% 出 1 件）
    const namesToGrant = [...new Set(brokenIdx.map(({ it }) => String(it.name ?? it['名称'])))];
    const grants: any[] = [];
    for (const name of namesToGrant) {
      const gear = await itemSystem.generateRewardEquipment(name);
      grants.push({ ...gear, name: gear?.name || name, type: '装备', quantity: 1, count: 1 });
      grantedSummary[name] = (grantedSummary[name] ?? 0) + 1;
    }

    const remaining = backpack.filter((it) => !isBrokenEntry(it, equipNames));
    const newBackpack = [...remaining, ...grants];

    touchedPlayers += 1;
    removedEntries += brokenIdx.length;
    console.log(
      `  玩家 id=${p.id} userId=${p.userId} ${p.name ?? ''} | 移除坏条目 ${brokenIdx.length} 条(${namesToGrant.join(',')}) | 补发 ${grants.length} 件真装备`,
    );

    if (apply) {
      const res = await prisma.player.updateMany({
        where: { id: p.id },
        data: { backpack: newBackpack as any },
      });
      if (res.count !== 1) {
        console.error(`  ✗ id=${p.id} 写入异常，返回=${JSON.stringify(res)}，请人工核查`);
        process.exit(2);
      }
    }
  }

  console.log(`\n小计：受影响玩家 ${touchedPlayers} 人，移除坏条目 ${removedEntries} 条，补发明细 ${JSON.stringify(grantedSummary)}`);
  if (!apply) {
    console.log('DRY-RUN 结束：未写入任何数据。确认无误后加 --apply 重新运行。');
  }

  // 复查：确认坏条目零残留（写库后）
  if (apply) {
    const after = await prisma.player.findMany({ select: { id: true, backpack: true } });
    let leftover = 0;
    for (const p of after) {
      const leftoverItems = parseBackpack(p.backpack).filter((it) => isBrokenEntry(it, equipNames));
      if (leftoverItems.length > 0) {
        leftover += leftoverItems.length;
        console.error(`  ✗ id=${p.id} 仍有 ${leftoverItems.length} 条坏条目未清除`);
      }
    }
    if (leftover === 0) {
      console.log('✅ 复查通过：全部坏条目已清理并补发');
    } else {
      console.error(`❌ 复查发现 ${leftover} 条残留，请人工核查`);
      process.exit(3);
    }
  }

  await app.close();
}

main().catch((e) => {
  console.error('迁移失败:', e);
  process.exit(1);
});
