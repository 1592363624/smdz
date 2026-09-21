/**
 * 系统配置中心的启动维护：废弃键清理 + 积分制遗留值刷新。
 *
 * 不变量（对齐项目约定「系统配置页只放真设置」）：
 * - 代码里已无读取方的键（OBSOLETE_CONFIG_KEYS）启动即删，后台不留守著能改、改了没用的假开关；
 * - 竞技场换成名次互换制后，库里仍是积分制形状的 arena.tierConfig / seasonCarry=softReset 刷回默认；
 * - 管理员自定义过、且新规则真的会读的值**一个字节都不动**。
 */

import { SystemConfigService } from '../src/modules/system-config/system-config.service';
import {
  ARENA_CONFIG_KEYS,
  DEFAULT_ARENA_SEASON_CARRY,
  DEFAULT_ARENA_TIERS_JSON,
} from '../src/config/arena.config';

function makePrismaStub(initial: Array<Partial<{ key: string; value: string; type: string; group: string; label: string; description: string }>> = []) {
  const rows = new Map<string, any>();
  initial.forEach((row, idx) => {
    rows.set(row.key!, {
      id: idx + 1,
      value: '',
      type: 'string',
      group: 'system',
      label: row.key,
      description: '',
      ...row,
    });
  });
  let nextId = rows.size + 1;
  const prisma: any = {
    systemConfig: {
      findMany: jest.fn(async () => [...rows.values()].sort((a, b) => a.id - b.id)),
      findUnique: jest.fn(async ({ where }: any) => rows.get(where.key) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.get(where.key);
        if (!row) throw new Error(`not found: ${where.key}`);
        Object.assign(row, data);
        return row;
      }),
      create: jest.fn(async ({ data }: any) => {
        if (rows.has(data.key)) throw new Error(`duplicate: ${data.key}`);
        const row = { id: nextId++, ...data };
        rows.set(data.key, row);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const keys: string[] = where?.key?.in ?? [];
        let count = 0;
        for (const k of keys) if (rows.delete(k)) count++;
        return { count };
      }),
    },
    _rows: rows,
  };
  return prisma;
}

function makeService(prisma: any): SystemConfigService {
  const svc = Object.create(SystemConfigService.prototype) as SystemConfigService;
  (svc as any).prisma = prisma;
  (svc as any).logger = { log: jest.fn(), warn: jest.fn() };
  (svc as any).cache = new Map();
  return svc;
}

const arenaRow = (value: string, extra: any = {}) => ({
  key: ARENA_CONFIG_KEYS.tierConfig,
  value,
  type: 'json',
  group: 'arena',
  label: '段位表(JSON)',
  description: 'old',
  ...extra,
});

describe('SystemConfigService 启动维护（竞技场名次互换制）', () => {
  it('库里仍是积分制的 minRating 阈值表时刷回名次区间默认表', async () => {
    const legacy = JSON.stringify([
      { key: 'grandmaster', name: '传奇角斗士', minRating: 1600, tone: 'gold' },
      { key: 'master', name: '天梯大师', minRating: 1450, tone: 'purple' },
    ]);
    const prisma = makePrismaStub([arenaRow(legacy)]);
    await makeService(prisma).onModuleInit();
    expect(prisma._rows.get(ARENA_CONFIG_KEYS.tierConfig).value).toBe(DEFAULT_ARENA_TIERS_JSON);
  });

  it('seasonCarry=softReset（积分制遗留）刷回当前默认口径', async () => {
    const prisma = makePrismaStub([
      { key: ARENA_CONFIG_KEYS.seasonCarry, value: 'softReset', type: 'string', group: 'arena', label: '换季名次口径', description: '' },
    ]);
    await makeService(prisma).onModuleInit();
    expect(prisma._rows.get(ARENA_CONFIG_KEYS.seasonCarry).value).toBe(DEFAULT_ARENA_SEASON_CARRY);
  });

  it('管理员自定义过的名次区间表原样保留（只认旧形状，不搞一刀切覆盖）', async () => {
    const custom = JSON.stringify([
      { key: 'king', name: '我的王座', rankFrom: 1, rankTo: 1, tone: 'gold' },
      { key: 'rest', name: '其余全员', rankFrom: 2, rankTo: 0, tone: 'brown' },
    ]);
    const prisma = makePrismaStub([arenaRow(custom)]);
    await makeService(prisma).onModuleInit();
    expect(prisma._rows.get(ARENA_CONFIG_KEYS.tierConfig).value).toBe(custom);
  });

  it('积分制四个键启动即删，新键补齐（后台里不留守行）', async () => {
    const prisma = makePrismaStub([
      { key: 'arena.ratingBase', value: '1000', group: 'arena' },
      { key: 'arena.ratingFloor', value: '800', group: 'arena' },
      { key: 'arena.ratingK', value: '32', group: 'arena' },
      { key: 'arena.ratingMarginCap', value: '250', group: 'arena' },
    ]);
    const svc = makeService(prisma);
    await svc.onModuleInit();
    for (const key of ['arena.ratingBase', 'arena.ratingFloor', 'arena.ratingK', 'arena.ratingMarginCap']) {
      expect(prisma._rows.has(key)).toBe(false);
    }
    // 名次制新键（跳级窗口、初始排名）由默认表补进库，管理界面立刻可见
    expect(prisma._rows.get(ARENA_CONFIG_KEYS.challengeRankWindow).value).toBe('1');
    expect(prisma._rows.get(ARENA_CONFIG_KEYS.rankInitByPower).value).toBe('true');
    // 键名与读取方一一对上：这几个键启动后都在库里，且值是可解析的默认形状
    const keys = ['enabled', 'tierConfig', 'challengeRankWindow', 'dailyChallengeLimit', 'seasonCarry']
      .map((k) => (ARENA_CONFIG_KEYS as any)[k]);
    const values = await (svc as any).getMany(keys);
    for (const key of keys) expect(values[key]).not.toBeUndefined();
    expect(values[ARENA_CONFIG_KEYS.seasonCarry]).toBe(DEFAULT_ARENA_SEASON_CARRY);
    // json 类型可能被解析成数组、也可能仍是文本（配置导入路径就是字符串），两种都要能读出区间
    const tiers = typeof values[ARENA_CONFIG_KEYS.tierConfig] === 'string'
      ? JSON.parse(values[ARENA_CONFIG_KEYS.tierConfig])
      : values[ARENA_CONFIG_KEYS.tierConfig];
    expect(Array.isArray(tiers) && tiers[0]).toHaveProperty('rankFrom');
  });
});
