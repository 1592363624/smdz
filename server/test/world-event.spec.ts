/**
 * 全服世界事件单元测试（纯桩，不进 db-specs，无需真实库）。
 *
 * 覆盖：
 *  - world-event.util：day/week/month 周期边界 + cycleId 格式（固定时钟注入）、随机抽样的确定性、
 *    kill 兜底回退、buff 派生、目标缩放、字符进度条；
 *  - WorldEventService：进度差值 + 点数回退自愈、开周期快照与不重复开、里程碑只解锁一次、
 *    结算条件抢占幂等、领取幂等 + 发货失败回滚、buff 同步缓存。
 */
import {
  computeCycleWindow,
  formatCycleId,
  isoWeekNo,
  computeActiveBuffs,
  adjustGoal,
  asciiProgressBar,
} from '../src/modules/game/world-event.util';
import {
  pickWorldEventTask,
  FALLBACK_KILL_TASK,
  DEFAULT_WORLD_EVENT_TASK_POOL,
  DEFAULT_WORLD_EVENT_BUFFS,
  type WorldEventTaskDef,
} from '../src/config/world-event.config';
import { WorldEventService } from '../src/modules/game/world-event.service';

// ==================== util 纯函数 ====================

describe('world-event.util', () => {
  // 2026-09-17 是周四；用北京墙钟构造固定时刻（UTC = 北京 - 8h）
  const bj = (y: number, m0: number, d: number, hh = 0) =>
    Date.UTC(y, m0, d, hh) - 8 * 3600 * 1000; // 真实 epoch

  it('day 周期对齐自然日 0 点，cycleId=YYYY-MM-DD', () => {
    const w = computeCycleWindow('day', bj(2026, 8, 17, 13)); // 北京 9/17 13:00
    expect(w.cycleId).toBe('2026-09-17');
    expect(w.startAt.getTime()).toBe(bj(2026, 8, 17, 0));
    expect(w.endAt.getTime() - w.startAt.getTime()).toBe(24 * 3600 * 1000);
  });

  it('week 周期对齐周一 0 点，cycleId=YYYY-Www（ISO 周）', () => {
    const w = computeCycleWindow('week', bj(2026, 8, 17, 13)); // 周四
    // 本周一 = 9/14
    expect(w.startAt.getTime()).toBe(bj(2026, 8, 14, 0));
    expect(w.endAt.getTime() - w.startAt.getTime()).toBe(7 * 24 * 3600 * 1000);
    expect(w.cycleId).toBe(`${isoWeekNo(2026, 8, 14).year}-W${String(isoWeekNo(2026, 8, 14).week).padStart(2, '0')}`);
  });

  it('month 周期对齐 1 日 0 点，cycleId=YYYY-MM', () => {
    const w = computeCycleWindow('month', bj(2026, 8, 30, 23));
    expect(w.cycleId).toBe('2026-09');
    expect(w.startAt.getTime()).toBe(bj(2026, 8, 1, 0));
    expect(w.endAt.getTime()).toBe(bj(2026, 9, 1, 0));
  });

  it('cycleId 跨北京 0 点切换（13:59Z = 北京次日 0 点）', () => {
    // 北京 9/18 00:00 = UTC 9/17 16:00
    const justAfterMidnight = Date.UTC(2026, 8, 17, 16, 0, 0);
    expect(formatCycleId('day', justAfterMidnight)).toBe('2026-09-18');
    const justBefore = Date.UTC(2026, 8, 17, 15, 59, 59);
    expect(formatCycleId('day', justBefore)).toBe('2026-09-17');
  });

  it('随机抽样对同一 cycleId 结果稳定，且过滤未就绪 metric 后回退 kill', () => {
    const a = pickWorldEventTask(DEFAULT_WORLD_EVENT_TASK_POOL as WorldEventTaskDef[], '2026-W38', true, FALLBACK_KILL_TASK);
    const b = pickWorldEventTask(DEFAULT_WORLD_EVENT_TASK_POOL as WorldEventTaskDef[], '2026-W38', true, FALLBACK_KILL_TASK);
    expect(a.key).toBe(b.key);
    expect(a.metric).toBe('kill'); // 只有 kill 埋点就绪
    // 只剩 gather（未就绪）→ 过滤后空 → 回退 kill 兜底
    const onlyGather: WorldEventTaskDef[] = [{ key: 'g', title: 'g', metric: 'gather', goalHint: 1, weight: 5, desc: '' }];
    const fb = pickWorldEventTask(onlyGather, '2026-W38', true, FALLBACK_KILL_TASK);
    expect(fb.key).toBe(FALLBACK_KILL_TASK.key);
  });

  it('randomPick=false 取权重最高的一条', () => {
    const t = pickWorldEventTask(DEFAULT_WORLD_EVENT_TASK_POOL as WorldEventTaskDef[], 'x', false, FALLBACK_KILL_TASK);
    expect(t.weight).toBe(3); // kill_wave 权重最高
  });

  it('computeActiveBuffs：达成的档位累加，未达成不计', () => {
    const buffs = computeActiveBuffs({ '25': 't', '50': 't' }, DEFAULT_WORLD_EVENT_BUFFS.buffs);
    expect(buffs.cargoPods).toBe(1);
    expect(buffs.checkinExpPct).toBe(20);
    expect(buffs.vitalityRegenPct).toBe(0);
    expect(buffs.challengeBox).toBe(0);
  });

  it('adjustGoal：完成度夹在 [min,max]', () => {
    expect(adjustGoal(20000, 34000, 0.6, 1.5)).toBe(30000); // 170% → ×1.5
    expect(adjustGoal(20000, 2000, 0.6, 1.5)).toBe(12000); // 10% → ×0.6 兜底
    expect(adjustGoal(20000, 22000, 0.6, 1.5)).toBe(22000); // 110% → ×1.1
  });

  it('asciiProgressBar：20 格按比例', () => {
    expect(asciiProgressBar(50, 20)).toBe(`[${'█'.repeat(10)}${'░'.repeat(10)}]`);
  });
});

// ==================== 内存假 Prisma ====================

function makeFakePrisma() {
  const cycles: any[] = [];
  const claims: any[] = [];
  let cid = 1;
  let kid = 1;

  const matchCycle = (r: any, where: any) => {
    if (where.status !== undefined && r.status !== where.status) return false;
    if (where.cycleId !== undefined && r.cycleId !== where.cycleId) return false;
    if (where.settledAt?.not === null && r.settledAt == null) return false;
    if (where.graceEndAt?.gt && !(r.graceEndAt && new Date(r.graceEndAt).getTime() > where.graceEndAt.gt.getTime())) return false;
    return true;
  };
  const sortCycles = (rows: any[], orderBy?: any) => {
    if (!orderBy) return rows;
    return [...rows].sort((a, b) => {
      for (const k of Object.keys(orderBy)) {
        const dir = orderBy[k] === 'desc' ? -1 : 1;
        const av = a[k] instanceof Date ? a[k].getTime() : a[k];
        const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
        if (av !== bv) return (av > bv ? 1 : -1) * dir;
      }
      return 0;
    });
  };

  return {
    __cycles: cycles,
    __claims: claims,
    worldEventCycle: {
      findFirst: jest.fn(async ({ where = {}, orderBy }: any = {}) => {
        const m = cycles.filter((r) => matchCycle(r, where));
        const s = sortCycles(m, orderBy);
        return s[0] ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: cid++,
          lastStep: 0,
          reached: {},
          finalPoints: null,
          graceEndAt: null,
          settledAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
          startAt: new Date(data.startAt),
          endAt: new Date(data.endAt),
        };
        cycles.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = cycles.find((x) => x.id === where.id);
        if (r) Object.assign(r, data);
        return r;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const r of cycles) {
          let ok = true;
          if (where.id !== undefined && r.id !== where.id) ok = false;
          if (where.status !== undefined && r.status !== where.status) ok = false;
          if (ok) { Object.assign(r, data); count++; }
        }
        return { count };
      }),
      delete: jest.fn(async ({ where }: any) => {
        const i = cycles.findIndex((x) => x.id === where.id);
        if (i >= 0) return cycles.splice(i, 1)[0];
        return null;
      }),
    },
    worldEventClaim: {
      create: jest.fn(async ({ data }: any) => {
        const dup = claims.some(
          (c) => c.cycleId === data.cycleId && c.userId === data.userId && c.percent === data.percent,
        );
        if (dup) throw new Error('Unique constraint failed');
        const row = { id: kid++, createdAt: new Date(), ...data };
        claims.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where = {} }: any = {}) => {
        return claims.filter((c) => {
          if (where.cycleId !== undefined && c.cycleId !== where.cycleId) return false;
          if (where.userId !== undefined && c.userId !== where.userId) return false;
          if (where.percent?.in && !where.percent.in.includes(c.percent)) return false;
          return true;
        });
      }),
      delete: jest.fn(async ({ where }: any) => {
        const i = claims.findIndex((c) => c.id === where.id);
        if (i >= 0) return claims.splice(i, 1)[0];
        return null;
      }),
      deleteMany: jest.fn(async ({ where = {} }: any) => {
        let count = 0;
        for (let i = claims.length - 1; i >= 0; i--) {
          if (where.cycleId !== undefined && claims[i].cycleId !== where.cycleId) continue;
          claims.splice(i, 1);
          count++;
        }
        return { count };
      }),
      count: jest.fn(async ({ where = {} }: any) => {
        const uids = new Set(claims.filter((c) => where.cycleId === undefined || c.cycleId === where.cycleId).map((c) => c.userId));
        return uids.size;
      }),
    },
    user: { findUnique: jest.fn(async () => ({ id: 1, role: 'ADMIN' })) },
    systemConfig: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => ({})),
      update: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
    },
  };
}

// 默认所有配置读回传入的默认值 → 等价全部走内置默认
function makeFakeConfig() {
  return { get: jest.fn(async (_k: string, def: any) => def), set: jest.fn(async () => {}) };
}
function makeFakeChat() {
  return {
    broadcastSystem: jest.fn(async () => ({})),
    emitToChannel: jest.fn(),
    emitToUser: jest.fn(),
  };
}
function makeFakeProficiency(startAt = 1000) {
  const holder = { points: startAt };
  return {
    holder,
    getPoints: jest.fn(async () => holder.points),
    ensureLoaded: jest.fn(async () => {}),
  };
}
function makeFakeCheckinReward() {
  return { grantRewards: jest.fn(async (_u: number, entries: any[]) => entries.map((e) => `${e.name || e.type}x${e.quantity}`)) };
}

function makeService(f: ReturnType<typeof makeFakePrisma>) {
  const config = makeFakeConfig();
  const chat = makeFakeChat();
  const prof = makeFakeProficiency(1000);
  const reward = makeFakeCheckinReward();
  const svc = new WorldEventService(f as any, config as any, chat as any, prof as any, reward as any);
  return { svc, config, chat, prof, reward };
}

// ==================== service ====================

describe('WorldEventService', () => {
  it('currentProgress：正常差值；点数回退时自愈重置基准、进度归零不抛', async () => {
    const f = makeFakePrisma();
    const { svc, prof } = makeService(f);
    const cycle: any = { id: 1, cycleId: '2026-W38', startPoints: 1000, goalPoints: 100, status: 'ACTIVE' };
    prof.holder.points = 1050;
    expect(await svc.currentProgress(cycle)).toEqual({ current: 50, goal: 100, percent: 50 });

    prof.holder.points = 800; // 管理员下调 → 低于 startPoints
    const p = await svc.currentProgress(cycle);
    expect(p).toEqual({ current: 0, goal: 100, percent: 0 });
    expect(f.worldEventCycle.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { startPoints: 800 } });
    expect(cycle.startPoints).toBe(800);
  });

  it('startCycle：快照起始点数并建 ACTIVE 行；同窗口不重复开', async () => {
    const f = makeFakePrisma();
    const { svc, chat, prof } = makeService(f);
    prof.holder.points = 5000;
    const cycle: any = await (svc as any).startCycle(await (svc as any).loadConfig());
    expect(cycle.status).toBe('ACTIVE');
    expect(cycle.startPoints).toBe(5000);
    expect(cycle.goalPoints).toBeGreaterThan(0);
    expect(chat.broadcastSystem).toHaveBeenCalled();
    // 再开一次：同 cycleId 已存在 ACTIVE → 直接返回同一条，不新建
    const again: any = await (svc as any).startCycle(await (svc as any).loadConfig());
    expect(again.id).toBe(cycle.id);
    expect(f.__cycles.length).toBe(1);
  });

  it('checkMilestones：跨过的档位只解锁一次并刷新 buff 缓存', async () => {
    const f = makeFakePrisma();
    const { svc, prof, chat } = makeService(f);
    const cycle: any = {
      id: 1, cycleId: '2026-W38', status: 'ACTIVE', startPoints: 0, goalPoints: 100,
      reached: {}, period: 'week', metric: 'kill', taskKey: 'kill_wave', taskTitle: 'T',
      startAt: new Date(0), endAt: new Date(Date.now() + 3600_000), lastStep: 0,
      finalPoints: null, graceEndAt: null, settledAt: null,
    };
    f.__cycles.push(cycle);
    prof.holder.points = 55; // 55% → 达成 25、50
    await (svc as any).checkMilestones(cycle, await (svc as any).loadConfig());
    expect(Object.keys(cycle.reached).sort()).toEqual(['25', '50']);
    // 再跑一次不重复解锁、不重复播报里程碑
    const before = chat.broadcastSystem.mock.calls.length;
    await (svc as any).checkMilestones(cycle, await (svc as any).loadConfig());
    expect(chat.broadcastSystem.mock.calls.length).toBe(before);
    // buff 缓存反映 25+50
    const buffs = svc.getActiveBuffValues();
    expect(buffs.cargoPods).toBe(1);
    expect(buffs.checkinExpPct).toBe(20);
  });

  it('settleIfDue：未到点不动；到点条件抢占，只结算一次', async () => {
    const f = makeFakePrisma();
    const { svc } = makeService(f);
    const cycle: any = {
      id: 2, cycleId: '2026-W39', status: 'ACTIVE', startPoints: 0, goalPoints: 100,
      reached: { '25': 't' }, period: 'week', metric: 'kill', taskKey: 'kill_wave', taskTitle: 'T',
      startAt: new Date(0), endAt: new Date(Date.now() + 3600_000), lastStep: 0,
      finalPoints: null, graceEndAt: null, settledAt: null,
    };
    f.__cycles.push(cycle);
    await (svc as any).settleIfDue(cycle, await (svc as any).loadConfig());
    expect(cycle.status).toBe('ACTIVE'); // 未到点

    cycle.endAt = new Date(Date.now() - 1000); // 到点
    await (svc as any).settleIfDue(cycle, await (svc as any).loadConfig());
    expect(cycle.status).toBe('SETTLED');
    expect(cycle.graceEndAt).toBeTruthy();
    // 再次结算：updateMany 抢不到（非 ACTIVE）→ 幂等，graceEndAt 不被改写
    const g = cycle.graceEndAt;
    await (svc as any).settleIfDue(cycle, await (svc as any).loadConfig());
    expect(cycle.graceEndAt).toBe(g);
  });

  it('claimReward：解锁档只可领一次；发货失败回滚领取记账', async () => {
    const f = makeFakePrisma();
    const { svc, prof, reward } = makeService(f);
    const cycle: any = {
      id: 3, cycleId: '2026-W40', status: 'ACTIVE', startPoints: 0, goalPoints: 100,
      reached: { '25': 't', '50': 't' }, period: 'week', metric: 'kill', taskKey: 'kill_wave', taskTitle: 'T',
      startAt: new Date(0), endAt: new Date(Date.now() + 3600_000), lastStep: 0,
      finalPoints: null, graceEndAt: null, settledAt: null,
    };
    f.__cycles.push(cycle);
    prof.holder.points = 50;

    const first = await svc.claimReward(7);
    expect(first).toContain('领取成功');
    expect(f.__claims.length).toBe(2); // 25% + 50%

    const second = await svc.claimReward(7);
    expect(second).toContain('已经领过');
    expect(f.__claims.length).toBe(2);

    // 发货抛错 → 回滚该档记账
    reward.grantRewards.mockRejectedValueOnce(new Error('boom'));
    const before = f.__claims.length;
    await svc.claimReward(8, 25); // 新用户，第一次调用注入失败
    expect(f.__claims.length).toBe(before); // 回滚，不新增
    expect(f.__claims.some((c) => c.userId === 8)).toBe(false);
  });

  it('无进行中周期：领取/面板给出友好文案', async () => {
    const f = makeFakePrisma();
    const { svc } = makeService(f);
    expect(await svc.claimReward(1)).toContain('没有进行中的世界事件');
    expect(await svc.viewPanel(1)).toContain('没有进行中的世界事件');
  });
});
