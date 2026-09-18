/**
 * 全服世界事件 · 纯函数工具（无副作用，供 WorldEventService 与单元测试共用）。
 *
 * 时间口径统一按北京时间（UTC+8），与项目「跨天/跨周」结算惯例一致：
 * 把真实 epoch 平移 +8h 后用 UTC getter 读到的即北京墙钟分量；
 * 反向由北京墙钟分量求真实 epoch 时再减回 8h。
 */
import {
  WorldEventPeriod,
  WorldEventBuffDef,
  WorldEventBuffType,
} from '../../config/world-event.config';

const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 一个周期的时间窗口（cycleId + 起止真实时刻） */
export interface CycleWindow {
  cycleId: string;
  startAt: Date;
  endAt: Date;
}

/** 北京墙钟分量 */
interface BjParts {
  y: number;
  m0: number; // 0-based 月
  d: number;  // 日
  dow: number; // 0=周日..6=周六（北京）
}

function bjParts(realMs: number): BjParts {
  const b = new Date(realMs + BJ_OFFSET_MS);
  return {
    y: b.getUTCFullYear(),
    m0: b.getUTCMonth(),
    d: b.getUTCDate(),
    dow: b.getUTCDay(),
  };
}

/** 由北京墙钟分量求真实 epoch（减去平移） */
function realFromBj(y: number, m0: number, d: number): number {
  return Date.UTC(y, m0, d) - BJ_OFFSET_MS;
}

/** ISO-8601 周编号（周一起始，含每年第一个星期四的周为第 1 周） */
export function isoWeekNo(y: number, m0: number, d: number): { year: number; week: number } {
  const t = new Date(Date.UTC(y, m0, d));
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // 移到本周星期四
  const isoYear = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  jan4.setUTCDate(jan4.getUTCDate() - jan4DayNum + 3); // 第 1 周的星期四
  const week = 1 + Math.round((t.getTime() - jan4.getTime()) / (7 * DAY_MS));
  return { year: isoYear, week };
}

/** 生成 cycleId：day→YYYY-MM-DD / week→YYYY-Www / month→YYYY-MM（均按北京时间） */
export function formatCycleId(period: WorldEventPeriod, realMs: number): string {
  const { y, m0, d } = bjParts(realMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (period === 'day') return `${y}-${pad(m0 + 1)}-${pad(d)}`;
  if (period === 'month') return `${y}-${pad(m0 + 1)}`;
  const { year, week } = isoWeekNo(y, m0, d);
  return `${year}-W${pad(week)}`;
}

/**
 * 计算「now 所属」周期的起止窗口（北京对齐）：
 * day = 当日 00:00 → 次日 00:00；week = 本周一 00:00 → 下周一 00:00；month = 本月 1 日 → 下月 1 日。
 */
export function computeCycleWindow(period: WorldEventPeriod, nowMs: number): CycleWindow {
  const { y, m0, d, dow } = bjParts(nowMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  let startReal: number;
  let endReal: number;
  if (period === 'day') {
    startReal = realFromBj(y, m0, d);
    endReal = startReal + DAY_MS;
  } else if (period === 'month') {
    startReal = realFromBj(y, m0, 1);
    endReal = realFromBj(y, m0 + 1, 1);
  } else {
    // week：北京周一起始。dow 0=周日→6，1=周一→0，…
    const mondayOffset = (dow + 6) % 7;
    startReal = realFromBj(y, m0, d) - mondayOffset * DAY_MS;
    endReal = startReal + 7 * DAY_MS;
  }
  return { cycleId: formatCycleId(period, nowMs), startAt: new Date(startReal), endAt: new Date(endReal) };
}

/** 归一化后的全服 buff 生效值（各生效点同步读取） */
export interface ActiveBuffValues {
  cargoPods: number;
  checkinExpPct: number;
  vitalityRegenPct: number;
  challengeBox: number;
}

const EMPTY_BUFFS: ActiveBuffValues = {
  cargoPods: 0,
  checkinExpPct: 0,
  vitalityRegenPct: 0,
  challengeBox: 0,
};

/** buff type → ActiveBuffValues 键 */
const BUFF_FIELD: Record<WorldEventBuffType, keyof ActiveBuffValues> = {
  cargoPods: 'cargoPods',
  checkinExp: 'checkinExpPct',
  vitalityRegen: 'vitalityRegenPct',
  challengeBox: 'challengeBox',
};

/**
 * 由「已达成里程碑集合 + buff 配置」算出当前全服生效的 buff 数值（纯函数）。
 * 达成即生效、未达成不生效；同类型多条按累加合并。reached 为 { "25": ISO时刻, ... }。
 */
export function computeActiveBuffs(
  reached: Record<string, unknown> | null | undefined,
  buffDefs: WorldEventBuffDef[],
): ActiveBuffValues {
  const out: ActiveBuffValues = { ...EMPTY_BUFFS };
  if (!reached || typeof reached !== 'object' || !Array.isArray(buffDefs)) return out;
  for (const def of buffDefs) {
    if (!def || !BUFF_FIELD[def.type as WorldEventBuffType]) continue;
    if (!(String(def.percent) in reached)) continue;
    const field = BUFF_FIELD[def.type as WorldEventBuffType];
    out[field] += Number(def.value) || 0;
  }
  return out;
}

/** 目标自动缩放：按上期完成度 ratio 夹在 [min,max] 系数内缩放下期目标 */
export function adjustGoal(goal: number, actual: number, min: number, max: number): number {
  const g = Number(goal) || 0;
  if (g <= 0) return g;
  const ratio = (Number(actual) || 0) / g;
  const factor = Math.min(max, Math.max(min, ratio));
  return Math.max(1, Math.floor(g * factor));
}

/** 由里程碑档位数组与当前 percent 求「已达成档位」（percent 达到该档即算达成） */
export function reachedMilestones(milestones: number[], percent: number): number[] {
  return (Array.isArray(milestones) ? milestones : []).filter((m) => percent >= Number(m)).map(Number);
}

/**
 * 字符进度条（Q 群纯文本降级，不依赖颜色）。width 为总格数。
 */
export function asciiProgressBar(percent: number, width = 20): string {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((p / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}]`;
}

/** 剩余时长文案：X天Y时Z分（负数归零） */
export function formatRemaining(ms: number): string {
  let s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86400);
  s -= days * 86400;
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const mins = Math.floor(s / 60);
  if (days > 0) return `${days}天${hours}时`;
  if (hours > 0) return `${hours}时${mins}分`;
  return `${mins}分`;
}
