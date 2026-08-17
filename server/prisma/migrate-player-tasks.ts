/**
 * 玩家任务数据一次性迁移脚本（migrate-player-tasks）
 * ------------------------------------------------------------------
 * 背景：任务系统重构（手动接取/提交制 -> 自动推进制）后，存量玩家 task 数据
 * 存在新旧结构并存的情况。本脚本将 Player.tasks 统一规范化为新格式：
 *   { name, requirements: [{name, count}], completed? }
 * 并清理旧格式残留的 status / progress / count(非 requirements) 等冗余字段。
 *
 * 幂等性：脚本可重复执行，对已是统一新格式的数据不做无谓改动。
 * 兜底：若遇到真正无 requirements 的纯旧格式条目（旧 task.service 的
 *   {name, count} 或 game.service 的 {name, status, progress}），
 *   会尝试从 prisma/data/tasks.json 的任务定义还原 requirements。
 *
 * 运行: npx ts-node prisma/migrate-player-tasks.ts
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

/** tasks.json 数据目录 */
const DATA_DIR = path.resolve(__dirname, 'data');

/** 读取任务定义（name -> 定义），用于还原缺失的 requirements */
function loadTaskDefs(): Map<string, any> {
  const file = path.join(DATA_DIR, 'tasks.json');
  if (!fs.existsSync(file)) return new Map();
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const map = new Map<string, any>();
    for (const r of rows || []) {
      if (r && r.name) map.set(r.name, r);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** 解析 requirements（兼容 JSON 字符串与数组两种形态），返回便捷 entries */
function parseRequirements(raw: any): Array<{ name: string; count: number }> | null {
  let arr: any[] | null = null;
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      return null;
    }
  }
  if (!arr) return null;
  const out: Array<{ name: string; count: number }> = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    if (Array.isArray(r)) continue; // 非法嵌套直接跳过
    if (r.name === undefined) continue;
    out.push({ name: String(r.name), count: Number(r.count) || 0 });
  }
  return out;
}

/**
 * 将单个玩家任务条目规范化为新格式
 * @param task 原始任务条目
 * @param taskDefs 任务定义表（name -> 定义）
 * @returns 规范化后的条目；无法还原时返回 null（丢弃）
 */
function normalizeTask(task: any, taskDefs: Map<string, any>): any | null {
  if (!task || typeof task !== 'object') return null;
  const name = task.name;
  if (name === undefined || name === null || name === '') return null;

  // 已完成判定（新格式 completed，或旧格式 status 已完成/已提交）
  const isCompleted =
    task.completed === true ||
    task.status === '已完成' ||
    task.status === '已提交';

  // 1) 已完成：requirements 置空，保留 completed 标记，去掉旧字段
  if (isCompleted) {
    return { name, requirements: [], completed: true };
  }

  // 2) 未完成：优先保留已有 requirements，缺失则从任务定义还原
  let reqs = parseRequirements(task.requirements);
  if (!reqs) {
    const def = taskDefs.get(name);
    if (def) reqs = parseRequirements(def.requirements);
  }

  if (!reqs) {
    // 既无 requirements 又无法从定义还原的无意义记录，丢弃
    return null;
  }

  return { name, requirements: reqs };
}

async function main() {
  console.log('🚀 开始迁移玩家任务数据（旧格式 -> 统一新格式）...\n');

  const taskDefs = loadTaskDefs();
  console.log(`   已加载任务定义 ${taskDefs.size} 条\n`);

  const players = await prisma.player.findMany({ select: { id: true, userId: true, tasks: true } });
  console.log(`   玩家总数: ${players.length}\n`);

  let updatedCount = 0;
  let cleanedFieldCount = 0;
  let normalizedCount = 0;
  let errorCount = 0;

  for (const p of players) {
    let arr: any[];
    try {
      arr = typeof p.tasks === 'string' && p.tasks ? JSON.parse(p.tasks) : (p.tasks || []);
    } catch (e) {
      console.warn(`   ⚠️ [userId=${p.userId}] tasks 解析失败，跳过: ${(e as Error).message}`);
      errorCount++;
      continue;
    }
    if (!Array.isArray(arr)) {
      // 非数组数据视为脏数据，恢复为空任务列表
      await prisma.player.update({ where: { id: p.id }, data: { tasks: '[]' } });
      console.warn(`   ⚠️ [userId=${p.userId}] tasks 非数组，已重置为空列表`);
      normalizedCount++;
      continue;
    }

    const normalized: any[] = [];
    let hadRedundant = false;
    let restruct = false;

    for (const t of arr) {
      // 统计存在旧冗余字段的条目（仅用于日志）
      if (t && typeof t === 'object' && (t.status !== undefined || t.progress !== undefined)) {
        hadRedundant = true;
        cleanedFieldCount++;
      }
      const norm = normalizeTask(t, taskDefs);
      if (!norm) continue;
      // 判断是否发生了实质性结构变化（requirements 丢失后还原 / 已完成收拢 / 字段清理）
      if (
        t && (
          !Array.isArray(t.requirements) ||
          t.completed !== norm.completed ||
          t.status !== undefined ||
          t.progress !== undefined ||
          t.count !== undefined
        )
      ) {
        restruct = true;
      }
      normalized.push(norm);
    }

    // 仅在有变化时才写库，减少无谓更新
    if (restruct || hadRedundant) {
      await prisma.player.update({ where: { id: p.id }, data: { tasks: JSON.stringify(normalized) } });
      updatedCount++;
    }
  }

  console.log('🎉 ====== 任务数据迁移完成 ======\n');
  console.log(`   已更新玩家: ${updatedCount}`);
  console.log(`   清理的旧残留字段条目: ${cleanedFieldCount}`);
  console.log(`   重置的非数组脏数据: ${normalizedCount}`);
  console.log(`   解析失败玩家: ${errorCount}`);
}

main()
  .catch((e) => {
    console.error('迁移过程发生错误:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log('\n已断开数据库连接');
  });