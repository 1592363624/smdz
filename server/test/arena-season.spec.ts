/**
 * 竞技场赛季结算单测：验证「奖励完全由配置驱动」这条硬要求。
 *
 * 用真实的 EntitlementService + 真实的 CheckinRewardService（发放出口）串起来，
 * 只把数据库与天梯查询换成内存桩——这样测试打到的是真的发奖链路：
 * 名次档 → grantRewards → 称号/头像框/特权/资源各自的落点，而不是桩之间的自证。
 */
import { ArenaSeasonService } from '../src/modules/game/arena/arena-season.service';
import { EntitlementService } from '../src/modules/game/entitlement.service';
import { CheckinRewardService } from '../src/modules/game/checkin-reward.service';
import { DEFAULT_ARENA_SEASON_REWARDS_JSON, DEFAULT_ARENA_TIERS_JSON } from '../src/config/arena.config';

function makeTables() {
  return {
    arenaSeason: [] as any[], arenaProfile: [] as any[], arenaMirror: [] as any[],
    playerPrivilege: [] as any[], playerAvatarFrame: [] as any[],
  };
}

/** 通用 where 匹配（覆盖本用例用到的等值 / in / 复合唯一键 / null 语义） */
function matches(row: any, where: any): boolean {
  if (!where) return true;
  for (const [key, value] of Object.entries(where as any)) {
    if (key === 'OR') {
      if (!(value as any[]).some((sub) => matches(row, sub))) return false;
      continue;
    }
    if (value === null) {
      if (row[key] != null) return false;
      continue;
    }
    if (value && typeof value === 'object') {
      if ('in' in (value as any)) {
        if (!(value as any).in.includes(row[key])) return false;
        continue;
      }
      if ('lte' in (value as any)) {
        if (!(new Date(row[key]).getTime() <= new Date((value as any).lte).getTime())) return false;
        continue;
      }
      // 复合唯一键：{ userId_key_source: { userId, key, source } }
      for (const [subKey, subVal] of Object.entries(value as any)) {
        if (row[subKey] !== subVal) return false;
      }
      continue;
    }
    if (row[key] !== value) return false;
  }
  return true;
}

function makeModel(tables: ReturnType<typeof makeTables>, name: string) {
  // 起始 id 刻意避开用例里手工 seed 的 1/2/3：真库由自增主键分配，桩必须不撞号
  let nextId = 1000;
  const list = () => tables[name];
  return {
    findMany: jest.fn(async ({ where, orderBy, take }: any = {}) => {
      let rows = list().filter((row) => matches(row, where)).map((row) => ({ ...row }));
      if (Array.isArray(orderBy)) {
        for (const entry of [...orderBy].reverse()) {
          for (const [field, dir] of Object.entries(entry as any)) {
            rows.sort((a, b) => {
              const cmp = typeof a[field] === 'number' ? a[field] - Number(b[field]) : String(a[field]).localeCompare(String(b[field]));
              return dir === 'desc' ? -cmp : cmp;
            });
          }
        }
      }
      return take ? rows.slice(0, take) : rows;
    }),
    findFirst: jest.fn(async ({ where }: any = {}) => {
      const rows = list().filter((row) => matches(row, where));
      return rows[0] ? { ...rows[0] } : null;
    }),
    findUnique: jest.fn(async ({ where }: any = {}) => {
      const rows = list().filter((row) => matches(row, where));
      return rows[0] ? { ...rows[0] } : null;
    }),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: nextId++, createdAt: new Date(), updatedAt: new Date(), ...data };
      list().push(row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = list().find((r) => matches(r, where));
      if (!row) throw new Error('P2025');
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const rows = list().filter((r) => matches(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    }),
  };
}

interface HarnessOptions {
  rewardsConfig?: any;
  mirrors?: any[];
  profiles?: any[];
}

function makeHarness(options: HarnessOptions = {}) {
  const tables = makeTables();
  const prisma: any = {
    __tables: tables,
    playerPrivilege: makeModel(tables, 'playerPrivilege'),
    playerAvatarFrame: makeModel(tables, 'playerAvatarFrame'),
  };
  // 赛季服务用到的三张表 + 权益表共用同一套内存实现
  const seasonModel = makeModel(tables, 'arenaSeason');
  prisma.arenaSeason = seasonModel;
  prisma.arenaProfile = makeModel(tables, 'arenaProfile');
  prisma.arenaMirror = makeModel(tables, 'arenaMirror');

  const configValues: Record<string, any> = {
    'arena.seasonRewards': options.rewardsConfig ?? DEFAULT_ARENA_SEASON_REWARDS_JSON,
    'arena.tierConfig': DEFAULT_ARENA_TIERS_JSON,
    ...(options.rewardsConfig && typeof options.rewardsConfig === 'object'
      ? { 'arena.seasonRewards': JSON.stringify(options.rewardsConfig) }
      : {}),
  };
  const systemConfig = {
    get: jest.fn(async (key: string, defaultValue: any) => (key in configValues ? configValues[key] : defaultValue)),
    getMany: jest.fn(async () => configValues),
  };

  // 称号直发写在这里：每个玩家一份常驻 ctx，便于断言最终 titles 数组
  const titleState: Record<number, any> = {};
  const entitlementMutate = {
    mutate: jest.fn(async (userId: number, fn: any) => {
      const ctx = titleState[userId] ?? (titleState[userId] = { player: { userId, titles: [] } });
      return fn(ctx);
    }),
  };
  const entitlement = new EntitlementService(prisma, entitlementMutate as any, systemConfig as any, { getTitleByName: () => ({}) } as any);
  const backpackAdds: Array<{ userId: number; name: string; count: number }> = [];
  const playerService = {
    addToBackpack: jest.fn(async (userId: number, name: string, count: number) => { backpackAdds.push({ userId, name, count }); }),
    addExp: jest.fn(async () => undefined),
  };
  const checkinReward = new CheckinRewardService(systemConfig as any, playerService as any, entitlement);
  const arena = {
    getConfig: jest.fn(async () => ({
      enabled: true, challengeRankWindow: 0,
      tiers: [], dailyChallengeLimit: 10, avoidRepeatHours: 6,
      entry: { mode: 'vitality', vitality: 20, ticketItem: '竞技场门票', ticketCost: 1 },
      submit: { mode: 'vitality', vitality: 10, ticketItem: '竞技场门票', ticketCost: 0 },
      battleTimeLimitSec: 180, battleMaxActions: 400, minLevelToEnter: 30, pageSize: 20,
      seasonLengthDays: 30, seasonStartAt: '', announceSeason: true,
    })),
    ensureActiveSeason: jest.fn(async () => ({ season: tables.arenaSeason[0], expired: false, notStarted: false })),
    rankedMirrors: jest.fn(async () => [...tables.arenaMirror].sort((a, b) => b.rating - a.rating)),
  };
  const chat = { broadcastSystem: jest.fn(async (..._args: any[]) => undefined) };
  const service = new ArenaSeasonService(
    prisma, systemConfig as any, arena as any, entitlement, checkinReward as any, chat as any,
    entitlementMutate as any,
  );
  return { service, prisma, tables, chat, backpackAdds, entitlement, titleState };
}

/** 造一个到期赛季 + 榜上镜像 + 参战档案 */
function seed(h: ReturnType<typeof makeHarness>, opts: { mirrors: Array<{ ownerId: number; name: string; seat: number }>; profiles?: Array<{ userId: number; matches: number }> }) {
  const endAt = new Date(Date.now() - 1000);
  h.tables.arenaSeason.push({ id: 1, no: 1, name: 'S1', startAt: new Date(Date.now() - 30 * 86400000), endAt, status: 'ACTIVE' });
  opts.mirrors.forEach((m, idx) => {
    h.tables.arenaMirror.push({ id: idx + 1, ownerId: m.ownerId, ownerName: m.name, seasonId: 1, rating: m.seat, tier: 'x', version: 1, level: 100, power: 1000 });
  });
  (opts.profiles || []).forEach((p) => {
    h.tables.arenaProfile.push({ userId: p.userId, seasonId: 1, rating: 0, wins: p.matches, losses: 0, draws: 0 });
  });
}

describe('ArenaSeasonService · 赛季结算', () => {
  it('冠军按默认配置拿到称号 + 限定头像框 + 批量采集特权 + 资源', async () => {
    const h = makeHarness();
    seed(h, {
      mirrors: [
        { ownerId: 11, name: '冠军', seat: 4 },
        { ownerId: 12, name: '亚军', seat: 3 },
        { ownerId: 13, name: '季军', seat: 2 },
        { ownerId: 14, name: '第四', seat: 1 },
      ],
    });
    const text = await h.service.settleSeason(h.tables.arenaSeason[0]);
    expect(text).toContain('S1 赛季结算完成');

    // 称号：只有冠军档配了「竞技场之王」，且写进 Player.titles 的领取口同构形状
    expect(h.titleState[11]?.player?.titles).toEqual([{ name: '竞技场之王', equipped: false }]);
    // 称号的「领取条件成就」同时被写上：否则已拥有者会在称号列表看到 0/1 的假缺失进度
    expect(h.titleState[11]?.player?.markers?.['竞技场赛季冠军']).toBe(1);
    expect(h.titleState[12]?.player?.titles ?? []).toHaveLength(0);
    // 特权：冠军拿到 batchGather，30 天期
    const privilege = h.tables.playerPrivilege.find((p) => p.userId === 11);
    expect(privilege?.key).toBe('batchGather');
    expect(privilege?.source).toBe('arenaSeason');
    expect(Number(privilege?.expiresAt) - Date.now()).toBeGreaterThan(29 * 86400000);
    expect(await h.entitlement.hasPrivilege(12, 'batchGather')).toBe(false);
    // 头像框：冠/亚/季分别拿到不同档的限定框
    expect(h.tables.playerAvatarFrame.find((f) => f.userId === 11)?.frameKey).toBe('arena_champion');
    expect(h.tables.playerAvatarFrame.find((f) => f.userId === 12)?.frameKey).toBe('arena_elite');
    expect(h.tables.playerAvatarFrame.find((f) => f.userId === 13)?.frameKey).toBe('arena_elite');
    expect(h.tables.playerAvatarFrame.find((f) => f.userId === 14)).toBeUndefined();
    // 资源走背包出口：凭证（冠军 30、亚军/季军 20、第四名落在 4-10 档拿 10）
    const vouchers = h.backpackAdds.filter((x) => x.name === '凭证');
    expect(vouchers.find((x) => x.userId === 11)?.count).toBe(30);
    expect(vouchers.find((x) => x.userId === 12)?.count).toBe(20);
    expect(vouchers.find((x) => x.userId === 14)?.count).toBe(10);
    // 第四名落在 4-10 档：拿「角斗大师」，但拿不到冠军限定（称号/头像框/特权）
    expect(h.tables.playerPrivilege.filter((p) => p.userId === 14)).toHaveLength(0);
    expect(h.titleState[14]?.player?.titles).toEqual([{ name: '角斗大师', equipped: false }]);
    expect(h.tables.playerAvatarFrame.find((f) => f.userId === 14)).toBeUndefined();
    expect(h.titleState[12]?.player?.titles ?? []).toHaveLength(0);
  });

  it('名次档与特权天数完全跟随配置：改配置即改发放结果', async () => {
    const h = makeHarness({
      rewardsConfig: {
        ranks: [{
          from: 1, to: 2, label: '自定义档',
          titles: ['自定义冠军称号'],
          privileges: [{ key: 'batchGather', days: 7, reason: '自定义理由' }],
          rewards: [{ type: 'item', name: '自定义资源', quantity: 5 }],
        }],
      },
    });
    seed(h, {
      mirrors: [
        { ownerId: 21, name: '甲', seat: 3 },
        { ownerId: 22, name: '乙', seat: 2 },
        { ownerId: 23, name: '丙', seat: 1 },
      ],
    });
    await h.service.settleSeason(h.tables.arenaSeason[0]);
    // 第二名也在档内（from-to 区间生效），第三名没有奖励
    expect(h.tables.playerPrivilege.map((p) => p.userId).sort()).toEqual([21, 22]);
    expect(Number(h.tables.playerPrivilege[0].expiresAt) - Date.now()).toBeLessThan(8 * 86400000);
    expect(h.tables.playerPrivilege[0].reason).toBe('自定义理由');
    expect(h.backpackAdds.every((x) => x.name === '自定义资源')).toBe(true);
    expect(h.tables.playerAvatarFrame).toHaveLength(0);
    expect(h.tables.playerPrivilege.find((p) => p.userId === 23)).toBeUndefined();
  });

  it('奖励条目里写错的 type 直接丢掉，不会退化成「按物品发进背包」凭空造物', async () => {
    const h = makeHarness({
      rewardsConfig: {
        ranks: [{
          from: 1, to: 1,
          rewards: [
            { type: 'itemm', name: '传说强化券', quantity: 999 },
            { type: 'item', name: '凭证', quantity: 5 },
          ],
        }],
      },
    });
    seed(h, { mirrors: [{ ownerId: 81, name: '甲', seat: 1 }] });
    await h.service.settleSeason(h.tables.arenaSeason[0]);
    expect(h.backpackAdds.map((x) => x.name)).toEqual(['凭证']);
  });

  it('重复结算不会二次发奖（ACTIVE→SETTLING 抢占即幂等锁）', async () => {
    const h = makeHarness();
    seed(h, { mirrors: [{ ownerId: 31, name: '独苗', seat: 1 }] });
    await h.service.settleSeason(h.tables.arenaSeason[0]);
    const privilegesAfterFirst = h.tables.playerPrivilege.length;
    const framesAfterFirst = h.tables.playerAvatarFrame.length;
    const second = await h.service.settleSeason(h.tables.arenaSeason[0]);
    expect(second).toContain('已在结算或已结算');
    expect(h.tables.playerPrivilege).toHaveLength(privilegesAfterFirst);
    expect(h.tables.playerAvatarFrame).toHaveLength(framesAfterFirst);
  });

  it('结算后自动开下一赛季，并把奖励配置快照与名次写进复盘字段', async () => {
    const h = makeHarness();
    seed(h, { mirrors: [{ ownerId: 41, name: '甲', seat: 2 }, { ownerId: 42, name: '乙', seat: 1 }] });
    await h.service.settleSeason(h.tables.arenaSeason[0]);
    const settled = h.tables.arenaSeason.find((s) => s.no === 1);
    const next = h.tables.arenaSeason.find((s) => s.no === 2);
    expect(settled.status).toBe('SETTLED');
    expect(settled.settledAt).toBeTruthy();
    expect(Array.isArray(settled.rewardSnapshot?.ranks)).toBe(true);
    expect(settled.settleInfo?.total).toBe(2);
    expect(settled.settleInfo?.rows[0]).toMatchObject({ rank: 1, userId: 41 });
    expect(next.status).toBe('ACTIVE');
    expect(next.endAt.getTime()).toBeGreaterThan(Date.now());
  });

  /**
   * 席位重排是换季才能做的收尾：把最终名次压成 N..1 写回档案，
   * 下一季 seasonCarry=keep 的继承、新入榜者的往后让，都以这份席位为基准。
   * 补算卡住的旧赛季时，新赛季可能已经在跑，所以只准动被结算那一季的档案。
   */
  it('结算把席位压成 N..1，且不动其他赛季的档案', async () => {
    const h = makeHarness();
    seed(h, {
      mirrors: [{ ownerId: 44, name: '甲', seat: 900 }, { ownerId: 45, name: '乙', seat: -3 }],
      profiles: [{ userId: 44, matches: 3 }, { userId: 45, matches: 1 }],
    });
    // 同一名玩家还有一行「下一季」的档案（补算旧赛季时会同时存在）
    h.tables.arenaProfile.push({ userId: 44, seasonId: 2, rating: 777, wins: 0, losses: 0, draws: 0 });
    await h.service.settleSeason(h.tables.arenaSeason[0]);
    const s1 = (uid: number) => h.tables.arenaProfile.find((p) => p.userId === uid && p.seasonId === 1);
    expect(s1(44).rating).toBe(2);
    expect(s1(45).rating).toBe(1);
    expect(h.tables.arenaProfile.find((p) => p.seasonId === 2).rating).toBe(777);
  });

  it('参与奖按打满场次发放，与名次奖并行不冲突', async () => {
    const h = makeHarness({
      rewardsConfig: {
        ranks: [{ from: 1, to: 1, rewards: [{ type: 'item', name: '名次礼', quantity: 1 }] }],
        participation: { minMatches: 10, titles: ['天梯常客'], rewards: [{ type: 'item', name: '参与礼', quantity: 2 }] },
      },
    });
    seed(h, {
      mirrors: [{ ownerId: 51, name: '冠军', seat: 2 }, { ownerId: 52, name: '路人心', seat: 1 }],
      profiles: [{ userId: 51, matches: 30 }, { userId: 52, matches: 12 }, { userId: 53, matches: 3 }],
    });
    await h.service.settleSeason(h.tables.arenaSeason[0]);
    const names = h.backpackAdds.map((x) => x.name);
    expect(names).toContain('名次礼');
    expect(h.backpackAdds.filter((x) => x.name === '参与礼').map((x) => x.userId).sort()).toEqual([51, 52]);
  });

  it('公告带上冠军与冠军获得的特权；关掉配置则不广播', async () => {
    const h = makeHarness();
    seed(h, { mirrors: [{ ownerId: 61, name: '张三', seat: 2 }, { ownerId: 62, name: '李四', seat: 1 }] });
    await h.service.settleSeason(h.tables.arenaSeason[0]);
    const [channel, content] = h.chat.broadcastSystem.mock.calls[0];
    expect(channel).toBe('世界频道');
    expect(content).toContain('张三');
    expect(content).toContain('野外批量采集');

    const muted = makeHarness();
    (muted.service as any).chat = undefined;
    seed(muted, { mirrors: [{ ownerId: 71, name: '甲', seat: 1 }] });
    await muted.service.settleSeason(muted.tables.arenaSeason[0]);
    expect(muted.chat.broadcastSystem).not.toHaveBeenCalled();
  });

  it('未到期的赛季不会被 settleExpiredSeasons 动到', async () => {
    const h = makeHarness();
    h.tables.arenaSeason.push({
      id: 1, no: 1, name: 'S1',
      startAt: new Date(), endAt: new Date(Date.now() + 86400000), status: 'ACTIVE',
    });
    expect(await h.service.settleExpiredSeasons()).toHaveLength(0);
    expect(h.tables.arenaSeason[0].status).toBe('ACTIVE');
  });
});
