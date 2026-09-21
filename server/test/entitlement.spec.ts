/**
 * 权益底座单测：功能特权（可授予 / 可续期 / 可到期 / 可撤销）、头像框（拥有 + 单一佩戴）、
 * 称号直发；并连带验证采集口「批量能力判定」的三种来源（家园 / 管理员 / 赛季特权）。
 *
 * 这一层是竞技场赛季奖励的落点：奖励能不能真正生效、会不会过期后还在放行，
 * 全靠这里的行为契约，所以按「读侧判权」逐条钉死。
 */
import { EntitlementService } from '../src/modules/game/entitlement.service';
import { PRIVILEGE_BATCH_GATHER } from '../src/config/arena.config';

/** 只建本层用到的两张表 + 玩家 mutate 桩 */
function makeFakes() {
  const tables: Record<string, any[]> = { playerPrivilege: [], playerAvatarFrame: [] };
  let nextId = 1;
  const eq = (row: any, where: any) => {
    if (!where) return true;
    for (const [key, value] of Object.entries(where as any)) {
      if (value === null) {
        if (row[key] != null) return false;
        continue;
      }
      if (value && typeof value === 'object') {
        // 复合唯一键：{ userId_frameKey: { userId, frameKey } }
        for (const [subKey, subVal] of Object.entries(value as any)) {
          if (row[subKey] !== subVal) return false;
        }
        continue;
      }
      if (typeof value === 'boolean') {
        if (!!row[key] !== value) return false;
        continue;
      }
      if (row[key] !== value) return false;
    }
    return true;
  };
  const model = (name: string) => ({
    findUnique: jest.fn(async ({ where }: any = {}) => {
      const row = tables[name].find((r) => eq(r, where));
      return row ? { ...row } : null;
    }),
    findFirst: jest.fn(async ({ where }: any = {}) => {
      const row = tables[name].find((r) => eq(r, where));
      return row ? { ...row } : null;
    }),
    findMany: jest.fn(async ({ where }: any = {}) => tables[name].filter((r) => eq(r, where)).map((r) => ({ ...r }))),
    count: jest.fn(async ({ where }: any = {}) => tables[name].filter((r) => eq(r, where)).length),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: nextId++, createdAt: new Date(), updatedAt: new Date(), ...data };
      tables[name].push(row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = tables[name].find((r) => r.id === where.id);
      Object.assign(row, data);
      return { ...row };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const rows = tables[name].filter((r) => eq(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    }),
  });
  const prisma: any = {
    playerPrivilege: model('playerPrivilege'),
    playerAvatarFrame: model('playerAvatarFrame'),
    __tables: tables,
  };
  // 称号直发的写入口桩：记录被改过的 titles 数组，不落库
  const state: Record<number, any> = {};
  const mutate = {
    mutate: jest.fn(async (userId: number, fn: any) => {
      const ctx = state[userId] ?? (state[userId] = { player: { userId, titles: [] } });
      return fn(ctx);
    }),
  };
  const systemConfig = {
    get: jest.fn(async (_key: string, defaultValue: any) => defaultValue),
  };
  const staticData = { getTitleByName: jest.fn((name: string) => (name === '竞技场之王' ? { name } : null)) };
  const service = new EntitlementService(prisma, mutate as any, systemConfig as any, staticData as any);
  return { service, prisma, mutate, state, tables };
}

const DAY = 24 * 3600 * 1000;

describe('EntitlementService · 功能特权', () => {
  it('授予后生效，并带到期时刻与来源理由', async () => {
    const { service } = makeFakes();
    const result = await service.grantPrivilege(7, PRIVILEGE_BATCH_GATHER, {
      source: 'arenaSeason', days: 30, reason: 'S1 冠军',
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('野外批量采集');
    const active = await service.activePrivilege(7, PRIVILEGE_BATCH_GATHER);
    expect(active?.name).toBe('野外批量采集');
    expect(active?.reason).toBe('S1 冠军');
    expect(Number(active!.expiresAt) - Date.now()).toBeGreaterThan(29 * DAY);
  });

  it('同来源重复授予从剩余时间续期，不覆盖成更短的到期', async () => {
    const { service, prisma } = makeFakes();
    await service.grantPrivilege(7, PRIVILEGE_BATCH_GATHER, { source: 'arenaSeason', days: 30 });
    const first = prisma.__tables.playerPrivilege[0];
    await service.grantPrivilege(7, PRIVILEGE_BATCH_GATHER, { source: 'arenaSeason', days: 10 });
    expect(prisma.__tables.playerPrivilege).toHaveLength(1);
    expect(prisma.__tables.playerPrivilege[0].id).toBe(first.id);
    expect(Number(first.expiresAt) - Date.now()).toBeGreaterThan(39 * DAY);
    expect(Number(first.expiresAt) - Date.now()).toBeLessThan(41 * DAY);
  });

  it('到期即自动失效（读侧判权，不依赖清理任务）', async () => {
    const { service, prisma } = makeFakes();
    await service.grantPrivilege(7, PRIVILEGE_BATCH_GATHER, { days: 3 });
    const row = prisma.__tables.playerPrivilege[0];
    row.expiresAt = new Date(Date.now() - 1000);
    expect(await service.hasPrivilege(7, PRIVILEGE_BATCH_GATHER)).toBe(false);
    expect(await service.listActivePrivileges(7)).toHaveLength(0);
  });

  it('撤销后立即失效，列表也不再返回', async () => {
    const { service } = makeFakes();
    await service.grantPrivilege(7, PRIVILEGE_BATCH_GATHER, { days: 30 });
    expect(await service.revokePrivilege(7, PRIVILEGE_BATCH_GATHER)).toBe(1);
    expect(await service.hasPrivilege(7, PRIVILEGE_BATCH_GATHER)).toBe(false);
    expect(await service.listPrivilegeHolders(PRIVILEGE_BATCH_GATHER)).toHaveLength(0);
  });

  it('days=0 表示永久（expiresAt 置空，不会被判过期）', async () => {
    const { service, prisma } = makeFakes();
    await service.grantPrivilege(7, PRIVILEGE_BATCH_GATHER, { days: 0 });
    expect(prisma.__tables.playerPrivilege[0].expiresAt).toBeNull();
    expect(await service.hasPrivilege(7, PRIVILEGE_BATCH_GATHER)).toBe(true);
  });

  it('未知特权键与漏填天数都被当面拒，不留「静默无效」的授予', async () => {
    const { service, prisma } = makeFakes();
    const typo = await service.grantPrivilege(7, 'batchCather', { days: 30 });
    expect(typo.ok).toBe(false);
    expect(typo.text).toContain('未知特权键');
    // 没写天数不等于永久：只有显式 days=0 / permanent 才是永久
    expect((await service.grantPrivilege(7, PRIVILEGE_BATCH_GATHER, {})).ok).toBe(false);
    expect((await service.grantPrivilege(7, PRIVILEGE_BATCH_GATHER, { days: NaN })).ok).toBe(false);
    expect(prisma.__tables.playerPrivilege).toHaveLength(0);
    expect(await service.hasPrivilege(7, PRIVILEGE_BATCH_GATHER)).toBe(false);
  });
});

describe('EntitlementService · 头像框与称号', () => {
  it('头像框必须先获得才能佩戴，且同时只佩戴一个', async () => {
    const { service } = makeFakes();
    expect((await service.equipFrame(7, 'arena_champion')).ok).toBe(false);
    expect((await service.grantFrame(7, 'arena_champion', 'arenaSeason')).ok).toBe(true);
    await service.grantFrame(7, 'arena_elite', 'arenaSeason');
    expect((await service.equipFrame(7, 'arena_champion')).ok).toBe(true);
    expect((await service.equipFrame(7, 'arena_elite')).ok).toBe(true);
    const { owned, equipped } = await service.listFrames(7);
    expect(owned.filter((o) => o.equipped)).toHaveLength(1);
    expect(equipped).toBe('arena_elite');
    expect((await service.equippedFrame(7))?.key).toBe('arena_elite');
  });

  it('重复发放同一头像框不会插第二行，也不会改佩戴状态', async () => {
    const { service, prisma } = makeFakes();
    await service.grantFrame(7, 'arena_champion', 'arenaSeason');
    await service.equipFrame(7, 'arena_champion');
    const again = await service.grantFrame(7, 'arena_champion', 'arenaSeason');
    expect(again.text).toContain('已拥有');
    expect(prisma.__tables.playerAvatarFrame).toHaveLength(1);
    expect(prisma.__tables.playerAvatarFrame[0].equipped).toBe(true);
  });

  it('卸下用空键，卸下后不再返回佩戴中的框', async () => {
    const { service } = makeFakes();
    await service.grantFrame(7, 'arena_champion');
    await service.equipFrame(7, 'arena_champion');
    expect((await service.equipFrame(7, '')).ok).toBe(true);
    expect(await service.equippedFrame(7)).toBeNull();
  });

  it('称号直发写进 Player.titles 且去重（赛季结算可安全重跑）', async () => {
    const { service, state } = makeFakes();
    expect((await service.grantTitle(7, '竞技场之王')).text).toContain('获得称号');
    expect(state[7].player.titles).toEqual([{ name: '竞技场之王', equipped: false }]);
    expect((await service.grantTitle(7, '竞技场之王')).text).toContain('已拥有');
    expect(state[7].player.titles).toHaveLength(1);
  });

  it('titles.json 里还没有的称号照样发放，只告警不阻塞结算', async () => {
    const { service, state } = makeFakes();
    const result = await service.grantTitle(7, '未来才补的称号');
    expect(result.ok).toBe(true);
    expect(state[7].player.titles[0].name).toBe('未来才补的称号');
  });
});

/**
 * 采集口的「批量能力判定」：家园院子 / 管理员角色 / 赛季特权三条来源，
 * 以及特权者的倍率上限（管理员不受限）。用原型挂载只测这一条判定，
 * 不牵起整条采集链路（那部分由既有采集回归用例覆盖）。
 */
describe('批量采集口 · 特权门控', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GatherPanelService } = require('../src/modules/game/commands/gather-panel.service');
  const resolve = (svc: any, args: any[]) => svc.resolveBatchCap(...args);

  function makeGather(holders: number[], max = 10) {
    const svc = Object.create(GatherPanelService.prototype);
    svc.entitlement = { hasPrivilege: jest.fn(async (userId: number) => holders.includes(Number(userId))) };
    svc.systemConfig = { get: jest.fn(async () => max) };
    return svc;
  }

  it('家园院子与管理员直接按请求倍率放行，不受特权上限约束', async () => {
    const svc = makeGather([]);
    expect(await resolve(svc, [1, true, false, 50])).toBe(50);
    expect(await resolve(svc, [1, false, true, 50])).toBe(50);
    expect(svc.entitlement.hasPrivilege).not.toHaveBeenCalled();
  });

  it('普通玩家：无特权则完全不能批量；带特权按上限截断', async () => {
    const svc = makeGather([9], 10);
    expect(await resolve(svc, [9, false, false, 1])).toBe(0);
    expect(svc.entitlement.hasPrivilege).not.toHaveBeenCalled();
    expect(await resolve(svc, [1, false, false, 5])).toBe(0);
    expect(await resolve(svc, [9, false, false, 25])).toBe(10);
  });

  it('上限可在后台调（改配置即改特权者的批量倍率）', async () => {
    const svc = makeGather([9], 3);
    expect(await resolve(svc, [9, false, false, 25])).toBe(3);
  });
});
