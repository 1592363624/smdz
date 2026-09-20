/**
 * 一次性迁移：把存量数据里的「历史别名字段」收敛为英文规范键（字段口径统一）。
 * 全部 JSON 列只改字段名、不改任何数值与内容；收敛规则与运行时归一化器同源
 * （见 src/modules/game/field-contract.util.ts），避免两套口径。
 *
 * 处理范围：
 *   - Player:      backpack / safeBox / equipment / weapons / equipmentPresets / markers2 / buffs
 *   - GameMap:     items / resources / resources2 / buildings / markers2 / vehicles / summons
 *   - GameMonster: backpack / equipments / weapons / equipmentPresets / markers2 / buffs
 *   - GameVehicle: parts / builtinParts / markers2
 *
 * 收敛规则：
 *   - 规范键已存在 → 以规范键为准，删除同义旧键；
 *   - 规范键缺失   → 把旧键的值迁到规范键，再删除旧键；
 *   - count → quantity（物品域）、value → strength（增益域）为同义英文键合并。
 * 因此脚本是**幂等**的：跑第二遍应报告 0 处改动。
 *
 * ⚠️ 在线玩家保护：updatedAt 距今 < 10 分钟的玩家视为可能在线（Actor 活态常驻内存，
 * 周期写回会整行覆盖 DB），默认跳过；确认离线后可加 --force 强制处理。
 *
 * 用法（在 server/ 目录下）：
 *   npx ts-node scripts/migrate-field-canonical.ts --db=test             # 试运行（只读）
 *   npx ts-node scripts/migrate-field-canonical.ts --db=test --apply     # 写入测试库
 *   npx ts-node scripts/migrate-field-canonical.ts --db=prod --apply     # 写入正式库
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  normalizePlayerRow,
  normalizeMapRow,
  normalizeMonsterRow,
  normalizeVehicleRow,
} from '../src/modules/game/field-contract.util';

/** 与 server/.env 保持一致（测试库/正式库同主机） */
const DB_URLS: Record<string, string> = {
  test: 'mysql://smdztest:smdztest@52shell.ltd:3306/smdztest?charset=utf8mb4&connection_limit=5',
  prod: 'mysql://smdz:EDzCnyba6HYnx5MT@52shell.ltd:3306/smdz?charset=utf8mb4&connection_limit=5',
};

/** 在线判定窗口：updatedAt 距今小于该毫秒数视为可能在线，默认跳过 */
const ONLINE_WINDOW_MS = 10 * 60 * 1000;

const argv = process.argv.slice(2);
const DB_KEY = (argv.find((a) => a.startsWith('--db='))?.split('=')[1] ?? 'test') as 'test' | 'prod';
const APPLY = argv.includes('--apply');
const FORCE = argv.includes('--force');

if (!DB_URLS[DB_KEY]) {
  console.error(`未知的 --db 取值：${DB_KEY}（可选 test / prod）`);
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: DB_URLS[DB_KEY] } } });

/** 迁移统计：按「表.列」记录改动行数与中文旧键命中次数 */
const stats = new Map<string, { rows: number; keys: Map<string, number> }>();

/**
 * 记录一次列级改动，并统计本次实际被删除的旧键名。
 * @param scope 形如 "Player.backpack"
 */
function recordChange(scope: string, before: any, after: any): void {
  const rec = stats.get(scope) ?? { rows: 0, keys: new Map<string, number>() };
  rec.rows += 1;
  const beforeKeys = collectObjectKeys(before);
  const afterKeys = collectObjectKeys(after);
  for (const k of beforeKeys) {
    if (!afterKeys.has(k)) rec.keys.set(k, (rec.keys.get(k) ?? 0) + 1);
  }
  stats.set(scope, rec);
}

/** 收集 JSON 结构里所有对象键名（深 3 层内，够覆盖条目-容器两层） */
function collectObjectKeys(value: any, depth = 0, out = new Set<string>()): Set<string> {
  if (value == null || depth > 3) return out;
  if (Array.isArray(value)) {
    for (const v of value) collectObjectKeys(v, depth, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      if (v && typeof v === 'object') collectObjectKeys(v, depth + 1, out);
    }
  }
  return out;
}

/** 判断行是否「可能在线」（updatedAt 很新），在线行默认跳过以免被 Actor 写回覆盖 */
function isRecentlyActive(row: { updatedAt?: Date }): boolean {
  if (!row?.updatedAt) return false;
  return Date.now() - new Date(row.updatedAt).getTime() < ONLINE_WINDOW_MS;
}

/**
 * 对一行数据按给定归一化函数处理：返回被改动的列名清单（不改动则返回空数组）。
 * 归一化是就地修改，故先深拷贝一份用于对比与回滚判定。
 */
function normalizeRow(row: any, columns: string[], normalize: (r: any) => boolean): string[] {
  const snapshot = new Map<string, string>();
  for (const c of columns) snapshot.set(c, JSON.stringify(row[c] ?? null));
  normalize(row);
  const changed: string[] = [];
  for (const c of columns) {
    const after = JSON.stringify(row[c] ?? null);
    if (after !== snapshot.get(c)) {
      changed.push(c);
      recordChange(`${row.__scope ?? ''}.${c}`, JSON.parse(snapshot.get(c) as string), row[c]);
    }
  }
  return changed;
}

/**
 * 玩家任务进度（Player.tasks）条目字段收敛：需求/奖励条目的 count → quantity。
 *
 * 为什么必须迁移：task.service 的 parseRequirements / parseRewards 只读规范键
 * quantity（不兜底 count），count 写法会被解析成数量 0——需求被当作「无条件」
 * 直接判定通过、奖励按 0 发放（静默的奖励丢失）。
 *
 * 支持两种形态：规范数组；历史字符串（原版反引号分隔/Old JSON），解析成数组后写回。
 * @param tasks 该列的当前值（数组 / 字符串 / 其它）
 * @returns 收敛后的列值（无法解析时原样返回）
 */
function normalizePlayerTasks(tasks: any): any {
  let list: any[] | null = null;
  if (Array.isArray(tasks)) {
    list = tasks;
  } else if (typeof tasks === 'string' && tasks.trim()) {
    try {
      const parsed = JSON.parse(tasks.trim());
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      // 原版反引号格式由 task.service 读取时解析，这里不处理（无字段名可收敛）
      return tasks;
    }
  }
  if (!list) return tasks;
  for (const task of list) {
    if (!task || typeof task !== 'object') continue;
    for (const field of ['requirements', 'rewards']) {
      const entries = Array.isArray(task[field]) ? task[field] : null;
      if (!entries) continue;
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        // 与 field-contract 的物品域合并规则同义：count 是数量旧名，规范键优先
        if (entry.quantity === undefined && entry.count !== undefined) entry.quantity = entry.count;
        delete entry.count;
      }
    }
  }
  return list;
}

async function migratePlayers(): Promise<void> {
  const players = await prisma.player.findMany();
  const ITEM_COLS = ['backpack', 'safeBox', 'equipment', 'weapons', 'equipmentPresets'];
  const BUFF_COLS = ['markers2', 'buffs'];
  const COLS = [...ITEM_COLS, ...BUFF_COLS];
  let touched = 0;
  let skipped = 0;

  for (const p of players) {
    if (!FORCE && isRecentlyActive(p)) {
      skipped += 1;
      console.log(`  [跳过] 玩家 userId=${p.userId} 近期活跃（可能在线）`);
      continue;
    }
    const row: any = { ...p, __scope: 'Player' };
    const changed = normalizeRow(row, COLS, normalizePlayerRow);
    // 任务列形态可能由字符串升级为数组，故单独收敛（不并入逐列 JSON 对比）
    const beforeTasks = JSON.stringify(p.tasks ?? null);
    row.tasks = normalizePlayerTasks(p.tasks);
    if (JSON.stringify(row.tasks ?? null) !== beforeTasks) {
      changed.push('tasks');
      recordChange('Player.tasks', JSON.parse(beforeTasks), row.tasks);
    }
    if (changed.length === 0) continue;
    touched += 1;
    console.log(`  [改动] 玩家 userId=${p.userId}: ${changed.join(', ')}`);
    if (APPLY) {
      await prisma.player.update({
        where: { userId: p.userId },
        data: Object.fromEntries(changed.map((c) => [c, row[c]])),
      });
    }
  }
  console.log(`玩家：扫描 ${players.length} 行，需改动 ${touched} 行，跳过在线 ${skipped} 行${APPLY ? '（已写入）' : '（试运行未写入）'}`);
}

async function migrateMaps(): Promise<void> {
  const maps = await prisma.gameMap.findMany();
  const COLS = ['items', 'resources', 'resources2', 'buildings', 'markers2', 'vehicles', 'summons'];
  let touched = 0;
  for (const m of maps) {
    const row: any = { ...m, __scope: 'GameMap' };
    const changed = normalizeRow(row, COLS, normalizeMapRow);
    if (changed.length === 0) continue;
    touched += 1;
    console.log(`  [改动] 地图 id=${m.id}(${m.name}): ${changed.join(', ')}`);
    if (APPLY) {
      await prisma.gameMap.update({ where: { id: m.id }, data: Object.fromEntries(changed.map((c) => [c, row[c]])) });
    }
  }
  console.log(`地图：扫描 ${maps.length} 行，需改动 ${touched} 行${APPLY ? '（已写入）' : '（试运行未写入）'}`);
}

async function migrateMonsters(): Promise<void> {
  const monsters = await prisma.gameMonster.findMany();
  const COLS = ['backpack', 'equipments', 'weapons', 'equipmentPresets', 'markers2', 'buffs'];
  let touched = 0;
  for (const m of monsters) {
    const row: any = { ...m, __scope: 'GameMonster' };
    const changed = normalizeRow(row, COLS, normalizeMonsterRow);
    if (changed.length === 0) continue;
    touched += 1;
    if (APPLY) {
      await prisma.gameMonster.update({ where: { id: m.id }, data: Object.fromEntries(changed.map((c) => [c, row[c]])) });
    }
  }
  console.log(`怪物：扫描 ${monsters.length} 行，需改动 ${touched} 行${APPLY ? '（已写入）' : '（试运行未写入）'}`);
}

async function migrateVehicles(): Promise<void> {
  const vehicles = await prisma.gameVehicle.findMany();
  const COLS = ['parts', 'builtinParts', 'markers2'];
  let touched = 0;
  for (const v of vehicles) {
    const row: any = { ...v, __scope: 'GameVehicle' };
    const changed = normalizeRow(row, COLS, normalizeVehicleRow);
    if (changed.length === 0) continue;
    touched += 1;
    if (APPLY) {
      await prisma.gameVehicle.update({ where: { id: v.id }, data: Object.fromEntries(changed.map((c) => [c, row[c]])) });
    }
  }
  console.log(`载具：扫描 ${vehicles.length} 行，需改动 ${touched} 行${APPLY ? '（已写入）' : '（试运行未写入）'}`);
}

async function main(): Promise<void> {
  console.log(`\n=== 字段规范迁移（${APPLY ? '写入模式' : '试运行只读模式'}） 目标库=${DB_KEY}${FORCE ? ' --force 含在线玩家' : ''} ===\n`);
  await migratePlayers();
  await migrateMaps();
  await migrateMonsters();
  await migrateVehicles();

  console.log('\n=== 被收敛的旧键统计（旧键 → 命中次数） ===');
  if (stats.size === 0) {
    console.log('  无改动：数据已全部是规范键（幂等通过）');
  }
  for (const [scope, rec] of [...stats.entries()].sort()) {
    const keys = [...rec.keys.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' ');
    console.log(`  ${scope}: ${rec.rows} 行  →  ${keys}`);
  }
  console.log('');
}

main()
  .catch((e) => {
    console.error('迁移失败：', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());