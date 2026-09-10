/**
 * 只读扫描：玩家装备数据中「无品质码」的装备条目（2026-09-10）。
 *
 * 背景：原版唯一的装备构造入口是 `生成装备`（物品操作.ecode L1128-1261），
 * 其 data 串恒为 `品质 + 加成转数据 + "!bx" + 特效` —— **首字符必然是品质码**
 * （e/d/c/b/a/s，空则掷骰必落其一）。原版其余入包路径全是从已有装备复制 data。
 * 因此「无品质码装备」在本项目属异常数据，来源见下方三条路径。
 *
 * 扫描范围：Player.equipment（装备栏）/ weapons（武器栏）/ backpack（背包）/
 *          equipmentPresets（装备预设，宽松展开）。
 *
 * 判定：
 *   1) 是否为装备条目 —— type='装备' 直接认定；type 为其它非空值则排除；
 *      缺 type 的历史条目回退静态表 `getEquipmentByName` 判定；
 *   2) data 首字符是否落在品质码集合 [e d c b a s x]（大小写不敏感）。
 *
 * ⚠️ 本脚本**只读**，不写入任何数据（无 --apply 分支）。
 *
 * 用法（在 server/ 目录下）：
 *   npx ts-node scripts/scan-no-quality-equipment.ts --db=test
 *   npx ts-node scripts/scan-no-quality-equipment.ts --db=prod
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { PrismaService } from '../src/prisma/prisma.service';

// 与 server/.env 保持一致（测试库/正式库同主机）
const DB_URLS: Record<string, string> = {
  test: 'mysql://smdztest:smdztest@52shell.ltd:3306/smdztest?charset=utf8mb4&connection_limit=5',
  prod: 'mysql://smdz:EDzCnyba6HYnx5MT@52shell.ltd:3306/smdz?charset=utf8mb4&connection_limit=5',
};

/** 合法品质码（小写），与 equipment-ref.util.QUALITY_CODE_BY_NAME 同集合 */
const QUALITY_CODES = new Set(['e', 'd', 'c', 'b', 'a', 's', 'x']);

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

function dataOf(r: any): string {
  return String(r?.data ?? r?.数据 ?? '');
}

/** data 首字符品质码（小写）；非法/缺失返回空串 */
function qualityCode(data: string): string {
  const c = data.charAt(0).toLowerCase();
  return QUALITY_CODES.has(c) ? c : '';
}

/** 装备预设列宽松展开：容器可能是 { 装备: [...] } 或数组本身 */
function flattenPresets(raw: any): Array<{ idx: number; item: any }> {
  const out: Array<{ idx: number; item: any }> = [];
  for (const [i, preset] of parseArray(raw).entries()) {
    const inner = preset?.装备 ?? preset?.装备数组 ?? preset?.equipments ?? preset?.items;
    if (Array.isArray(inner)) {
      for (const item of inner) out.push({ idx: i, item });
    } else if (preset && typeof preset === 'object' && (preset as any).name) {
      out.push({ idx: i, item: preset });
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const dbArg = args.find((a) => a.startsWith('--db='))?.split('=')[1] ?? '';
  if (!DB_URLS[dbArg]) {
    console.error('用法: npx ts-node scripts/scan-no-quality-equipment.ts --db=test|prod');
    process.exit(1);
  }
  process.env.DATABASE_URL = DB_URLS[dbArg];
  console.log(`===== 无品质码装备扫描（只读）| 库=${dbArg} =====\n`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const staticData = app.get(StaticDataService);
  const prisma = app.get(PrismaService);

  const isEquipmentEntry = (item: any): boolean => {
    const type = String(item?.type ?? item?.类型 ?? '').trim();
    if (type === '装备') return true;
    if (type) return false;
    // 缺 type 的历史条目：回退静态表判定（无定义则不算装备，避免误报）
    return Boolean(staticData.getEquipmentByName(nameOf(item)));
  };

  const players = await prisma.player.findMany({
    select: {
      userId: true,
      name: true,
      equipment: true,
      weapons: true,
      backpack: true,
      equipmentPresets: true,
      updatedAt: true,
    },
  });
  console.log(`扫描 ${players.length} 名玩家 ...\n`);

  let totalEquip = 0;
  let totalBad = 0;
  let playersHit = 0;
  const byColumn = new Map<string, number>();
  const byName = new Map<string, number>();
  const detailLines: string[] = [];

  for (const player of players) {
    const columns: Array<[string, Array<{ idx: number; item: any }>]> = [
      ['equipment', parseArray(player.equipment).map((item, idx) => ({ idx, item }))],
      ['weapons', parseArray(player.weapons).map((item, idx) => ({ idx, item }))],
      ['backpack', parseArray(player.backpack).map((item, idx) => ({ idx, item }))],
      ['equipmentPresets', flattenPresets(player.equipmentPresets)],
    ];

    const hits: string[] = [];
    for (const [column, entries] of columns) {
      for (const { idx, item } of entries) {
        if (!isEquipmentEntry(item)) continue;
        totalEquip += 1;
        const data = dataOf(item);
        if (qualityCode(data)) continue;
        totalBad += 1;
        byColumn.set(column, (byColumn.get(column) ?? 0) + 1);
        const name = nameOf(item) || '(无名)';
        byName.set(name, (byName.get(name) ?? 0) + 1);
        const type = String(item?.type ?? item?.类型 ?? '');
        hits.push(
          `  [${column} #${idx}] ${name} | type=${type || '(无)'} | data=${JSON.stringify(data.slice(0, 60))}`,
        );
      }
    }

    if (hits.length > 0) {
      playersHit += 1;
      const stamp = player.updatedAt ? new Date(player.updatedAt).toISOString() : '?';
      detailLines.push(`玩家#${player.userId} ${player.name || '未命名'} (updatedAt=${stamp}):`);
      detailLines.push(...hits);
    }
  }

  if (detailLines.length > 0) {
    console.log(detailLines.join('\n'));
    console.log('');
  }

  console.log('===== 汇总 =====');
  console.log(`装备条目总数      : ${totalEquip}`);
  console.log(`无品质码条目      : ${totalBad}`);
  console.log(`命中玩家          : ${playersHit} / ${players.length}`);
  if (byColumn.size > 0) {
    console.log('按来源列          :');
    for (const [column, count] of byColumn) console.log(`  ${column}: ${count}`);
  }
  if (byName.size > 0) {
    console.log('按装备名          :');
    for (const [name, count] of [...byName.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name}: ${count}`);
    }
  }
  console.log('\n本脚本只读，未写入任何数据。');

  await app.close();
}

main().catch((e) => {
  console.error('扫描失败:', e);
  process.exit(1);
});
