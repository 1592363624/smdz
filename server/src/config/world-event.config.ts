/**
 * 全服世界事件配置（纯常量模块，无服务依赖，避免 system-config → game → system-config 循环）。
 *
 * 玩法：按 day/week/month 开一个全服共同目标（可从任务池随机抽取），进度取「世界熟练度」点数
 * 差值（复用 GlobalProficiencyService，零新增计数），跨过 25/50/75/100% 里程碑逐级解锁全服 buff，
 * 达成后可领取世界奖励（人人一次，WorldEventClaim 唯一约束做幂等）。未达成只是拿不到额外奖励，
 * 世界等级照常上涨（原有压力不变）。
 *
 * 配置项抽取原则沿用 red-packet.config.ts：所有阈值/开关/周期/奖励均可在系统配置中心在线调整。
 * 读取入口：WorldEventService 经 SystemConfigService.get(键, 默认) 逐项读取；
 * buff 生效点（schedule / checkin-reward / time-settle）统一走 WorldEventService.getActiveBuffValues()
 * 同步内存缓存，避免反向 async 依赖成环。
 */

/** 周期粒度：自然日 0 点 / 周一 0 点 / 1 日 0 点对齐（北京时间） */
export type WorldEventPeriod = 'day' | 'week' | 'month';
/** 进度指标。Phase 1 仅 kill 埋点就绪；gather/craft/challenge 为占位，抽样时自动过滤未就绪项 */
export type WorldEventMetric = 'kill' | 'gather' | 'craft' | 'challenge';
/** 全服 buff 类型（均落在非 G9 冻结文件；dropRate 属 combat-system，本期不做） */
export type WorldEventBuffType = 'cargoPods' | 'checkinExp' | 'vitalityRegen' | 'challengeBox';
/** 任务来源：fixed=固定用 metric+baseGoal；pool=从任务池按权重随机抽 */
export type WorldEventTaskSource = 'fixed' | 'pool';

/** 任务池条目 */
export interface WorldEventTaskDef {
  key: string;
  title: string;
  metric: WorldEventMetric;
  /** 目标增量提示（pool 模式下作为本周期 goalPoints） */
  goalHint: number;
  /** 加权随机权重（须为正数） */
  weight: number;
  desc: string;
}

/** 里程碑奖励条目（数量键为 quantity，与 CheckinRewardEntry 逐字一致；写 count 会被 grantRewards 静默跳过） */
export interface WorldEventRewardEntry {
  type: 'item' | 'exp' | 'vitality';
  name: string;
  quantity: number;
}

/** 单个里程碑档位的奖励 */
export interface WorldEventMilestoneReward {
  percent: number;
  rewards: WorldEventRewardEntry[];
}

/** 里程碑 buff 定义 */
export interface WorldEventBuffDef {
  percent: number;
  type: WorldEventBuffType;
  value: number;
  label: string;
}

/** 系统配置键（json 类型走系统配置中心；标量各自独立键，便于管理界面单条调整） */
export const WORLD_EVENT_CONFIG_KEYS = {
  enabled: 'worldEvent.enabled',
  period: 'worldEvent.period',
  cycleDays: 'worldEvent.cycleDays',
  autoStart: 'worldEvent.autoStart',
  graceHours: 'worldEvent.graceHours',
  taskSource: 'worldEvent.taskSource',
  taskPool: 'worldEvent.taskPool',
  randomPick: 'worldEvent.randomPick',
  panelTitleOverride: 'worldEvent.panelTitleOverride',
  metric: 'worldEvent.metric',
  baseGoal: 'worldEvent.baseGoal',
  goalAutoAdjust: 'worldEvent.goalAutoAdjust',
  goalAdjustMin: 'worldEvent.goalAdjustMin',
  goalAdjustMax: 'worldEvent.goalAdjustMax',
  milestones: 'worldEvent.milestones',
  startPointsFallback: 'worldEvent.startPointsFallback',
  rewards: 'worldEvent.rewards',
  buffs: 'worldEvent.buffs',
  announceOnMilestone: 'worldEvent.announceOnMilestone',
  announceOnStart: 'worldEvent.announceOnStart',
  progressBroadcastStep: 'worldEvent.progressBroadcastStep',
  panelTitle: 'worldEvent.panelTitle',
  panelDesc: 'worldEvent.panelDesc',
  history: 'worldEvent.history',
} as const;

/** 标量默认值（系统配置缺失/损坏时兜底） */
export const DEFAULT_WORLD_EVENT = {
  enabled: true,
  period: 'week' as WorldEventPeriod,
  cycleDays: 7,
  autoStart: true,
  graceHours: 24,
  taskSource: 'pool' as WorldEventTaskSource,
  randomPick: true,
  panelTitleOverride: '',
  metric: 'kill' as WorldEventMetric,
  baseGoal: 20000,
  goalAutoAdjust: true,
  goalAdjustMin: 0.6,
  goalAdjustMax: 1.5,
  startPointsFallback: 0,
  announceOnMilestone: true,
  announceOnStart: true,
  progressBroadcastStep: 10,
  panelTitle: '星海远征',
  panelDesc: '异界的裂隙正在扩大，全使魔的战斗意志是世界唯一的屏障。',
};

/** 里程碑百分比档位默认 */
export const DEFAULT_WORLD_EVENT_MILESTONES = [25, 50, 75, 100];

/**
 * 任务池默认值。metric=kill 埋点就绪（复用世界熟练度差值）；gather/craft 为占位，
 * 开周期时若 metricReady=false 会被自动过滤回退到 kill 池，避免空转。
 */
export const DEFAULT_WORLD_EVENT_TASK_POOL: WorldEventTaskDef[] = [
  { key: 'kill_wave', title: '清扫裂隙', metric: 'kill', goalHint: 20000, weight: 3, desc: '全服击杀累计' },
  { key: 'kill_boss', title: '讨伐潮汐', metric: 'kill', goalHint: 8000, weight: 2, desc: '全服击杀累计（精英向）' },
  { key: 'gather_ore', title: '矿脉动员', metric: 'gather', goalHint: 5000, weight: 1, desc: '全服采集次数累计（Phase 2 埋点）' },
  { key: 'craft_gear', title: '工坊赶工', metric: 'craft', goalHint: 3000, weight: 1, desc: '全服制造次数累计（Phase 2 埋点）' },
];

/** 里程碑奖励表默认（条目用 quantity）。
 *  Phase 1 仅用 item/exp：二者在 grantRewards 内部各自落库（addToBackpack / mutate 感知 addExp）；
 *  vitality 需调用方持有并回写玩家对象，与指令 mutate 快照冲突，留待受管上下文的 Phase 2。 */
export const DEFAULT_WORLD_EVENT_REWARDS: { milestones: WorldEventMilestoneReward[] } = {
  milestones: [
    { percent: 25, rewards: [{ type: 'item', name: '强化券', quantity: 5 }] },
    {
      percent: 50,
      rewards: [
        { type: 'item', name: '强化券', quantity: 10 },
        { type: 'exp', name: '', quantity: 5000 },
      ],
    },
    {
      percent: 75,
      rewards: [
        { type: 'item', name: '史诗强化券', quantity: 5 },
        { type: 'item', name: '觉醒丹', quantity: 1 },
      ],
    },
    {
      percent: 100,
      rewards: [
        { type: 'item', name: '传说强化券', quantity: 5 },
        { type: 'item', name: '觉醒丹', quantity: 3 },
      ],
    },
  ],
};

/** 全服增益表默认（达成即生效，持续到本周期结束） */
export const DEFAULT_WORLD_EVENT_BUFFS: { buffs: WorldEventBuffDef[] } = {
  buffs: [
    { percent: 25, type: 'cargoPods', value: 1, label: '每小时额外货舱 +1' },
    { percent: 50, type: 'checkinExp', value: 20, label: '每日签到经验 +20%' },
    { percent: 75, type: 'vitalityRegen', value: 25, label: '活力恢复速度 +25%' },
    { percent: 100, type: 'challengeBox', value: 1, label: '挑战层每日奖励箱 +1' },
  ],
};

/** 系统配置中心写入用的 JSON 文本（value 一律字符串） */
export const DEFAULT_WORLD_EVENT_TASK_POOL_JSON = JSON.stringify({ tasks: DEFAULT_WORLD_EVENT_TASK_POOL });
export const DEFAULT_WORLD_EVENT_MILESTONES_JSON = JSON.stringify(DEFAULT_WORLD_EVENT_MILESTONES);
export const DEFAULT_WORLD_EVENT_REWARDS_JSON = JSON.stringify(DEFAULT_WORLD_EVENT_REWARDS);
export const DEFAULT_WORLD_EVENT_BUFFS_JSON = JSON.stringify(DEFAULT_WORLD_EVENT_BUFFS);

/** 某指标埋点是否就绪（Phase 1 仅 kill）。gather/craft/challenge 埋点落地后在此放开。 */
export function metricReady(metric: string): boolean {
  return metric === 'kill';
}

/** FNV-1a 32 位哈希，把字符串映射到 [0,1) 的确定性单位值（用于按 cycleId 派生随机种子，保证同周期抽样稳定） */
export function unitFromHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x019e3514);
  }
  // 转无符号后归一化到 [0,1)
  return (h >>> 0) / 0x100000000;
}

/**
 * 按权重从任务池随机抽取一条（种子派生自 cycleId → 同一周期多次调用结果一致）。
 * 先过滤掉埋点未就绪的 metric；池空或全未就绪时回退 fallback（kill 兜底）。
 * randomPick=false 时取权重最高的一条（近似固定）。
 */
export function pickWorldEventTask(
  pool: WorldEventTaskDef[],
  cycleId: string,
  randomPick: boolean,
  fallback: WorldEventTaskDef,
): WorldEventTaskDef {
  const usable = (Array.isArray(pool) ? pool : []).filter((t) => t && metricReady(t.metric) && Number(t.weight) > 0);
  if (usable.length === 0) return fallback;
  if (!randomPick) {
    return usable.reduce((a, b) => (Number(b.weight) > Number(a.weight) ? b : a), usable[0]);
  }
  const total = usable.reduce((s, t) => s + Number(t.weight), 0);
  let r = unitFromHash(cycleId) * total;
  for (const t of usable) {
    r -= Number(t.weight);
    if (r < 0) return t;
  }
  return usable[usable.length - 1];
}

/** kill 兜底任务（池被改成不可用时保证仍有可跑任务） */
export const FALLBACK_KILL_TASK: WorldEventTaskDef = {
  key: 'kill_wave',
  title: '全服击杀',
  metric: 'kill',
  goalHint: DEFAULT_WORLD_EVENT.baseGoal,
  weight: 1,
  desc: '全服击杀累计',
};
