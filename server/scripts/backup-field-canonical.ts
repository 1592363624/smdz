/**
 * 迁移前备份：导出 Player/GameMap/GameMonster/GameVehicle 中可能被改写的 JSON 列。
 * 用法：npx ts-node --transpile-only scripts/backup-field-canonical.ts --db=prod --out=../backup/xxx
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';

/** JSON.stringify 对 BigInt 会抛错，统一转字符串 */
function safeStringify(v: any, pretty = false): string {
  return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val), pretty ? 2 : undefined);
}
import { dirname, resolve } from 'path';
import { PrismaClient } from '@prisma/client';
import {
  normalizePlayerRow,
  normalizeMapRow,
  normalizeMonsterRow,
  normalizeVehicleRow,
} from '../src/modules/game/field-contract.util';

const DB_URLS: Record<string, string> = {
  test: 'mysql://smdztest:smdztest@52shell.ltd:3306/smdztest?charset=utf8mb4&connection_limit=5',
  prod: 'mysql://smdz:EDzCnyba6HYnx5MT@52shell.ltd:3306/smdz?charset=utf8mb4&connection_limit=5',
};

const argv = process.argv.slice(2);
const DB_KEY = (argv.find((a) => a.startsWith('--db='))?.split('=')[1] ?? 'test') as 'test' | 'prod';
const OUT = argv.find((a) => a.startsWith('--out='))?.split('=')[1] ?? `../backup/field-canonical-${DB_KEY}.json`;

const prisma = new PrismaClient({ datasources: { db: { url: DB_URLS[DB_KEY] } } });

function wouldChange(row: any, cols: string[], normalize: (r: any) => boolean): string[] {
  const before = cols.map((c) => safeStringify((row as any)[c] ?? null));
  const clone = JSON.parse(safeStringify(row));
  normalize(clone);
  return cols.filter((c, i) => safeStringify(clone[c] ?? null) !== before[i]);
}

async function main() {
  const outPath = resolve(process.cwd(), OUT);
  mkdirSync(dirname(outPath), { recursive: true });

  const players = await prisma.player.findMany();
  const maps = await prisma.gameMap.findMany();
  const monsters = await prisma.gameMonster.findMany();
  const vehicles = await prisma.gameVehicle.findMany();

  const backup: any = {
    db: DB_KEY,
    exportedAt: new Date().toISOString(),
    Player: [],
    GameMap: [],
    GameMonster: [],
    GameVehicle: [],
  };

  const itemCols = ['backpack', 'safeBox', 'equipment', 'weapons', 'equipmentPresets'];
  const buffCols = ['markers2', 'buffs'];
  const playerCols = [...itemCols, ...buffCols, 'tasks'];

  for (const p of players) {
    const cols = wouldChange(p, playerCols, (row) => {
      normalizePlayerRow(row);
      // tasks 与 migrate 脚本同逻辑：仅对比 JSON，不在这里改写写库
    });
    // tasks 单独检查
    try {
      const t = p.tasks;
      if (Array.isArray(t) || (typeof t === 'string' && t.trim().startsWith('['))) {
        // 粗略：只要含 count 就备份
        const s = typeof t === 'string' ? t : JSON.stringify(t);
        if (/"count"/.test(s)) cols.push('tasks');
      }
    } catch { /* ignore */ }
    if (cols.length) {
      backup.Player.push({ userId: p.userId, id: p.id, updatedAt: p.updatedAt, columns: cols, row: p });
    }
  }

  for (const m of maps) {
    const cols = wouldChange(m, ['items', 'resources', 'resources2', 'buildings', 'markers2', 'vehicles', 'summons'], normalizeMapRow);
    if (cols.length) backup.GameMap.push({ id: m.id, name: m.name, columns: cols, row: m });
  }
  for (const m of monsters) {
    const cols = wouldChange(m, ['backpack', 'equipments', 'weapons', 'equipmentPresets', 'markers2', 'buffs'], normalizeMonsterRow);
    if (cols.length) backup.GameMonster.push({ id: m.id, columns: cols, row: m });
  }
  for (const v of vehicles) {
    const cols = wouldChange(v, ['parts', 'builtinParts', 'markers2'], normalizeVehicleRow);
    if (cols.length) backup.GameVehicle.push({ id: v.id, columns: cols, row: v });
  }

  writeFileSync(outPath, safeStringify(backup, true), 'utf8');
  console.log(`备份完成: ${outPath}`);
  console.log(`  Player=${backup.Player.length} GameMap=${backup.GameMap.length} GameMonster=${backup.GameMonster.length} GameVehicle=${backup.GameVehicle.length}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
