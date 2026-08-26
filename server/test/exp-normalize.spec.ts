import { PlayerService } from '../src/modules/game/player.service';
import { StaticDataService } from '../src/modules/game/static-data.service';

/**
 * 经验归一化门禁回归：
 * 原版（加成计算.ecode L1781-1794）等级是每次结算由总经验推导的，
 * 「经验 ≥ 当前门槛却没升级」在原版中不可能出现。移植版曾因挤奶青龙奖励、
 * 躺下离线经验、掉落「经验」等路径直写 player.exp 绕过升级循环，
 * 导致玩家卡在 Lv.5 经验 514/30 的非法状态。
 *
 * 修复后 savePlayer 在落库前无条件执行 applyLevelUps 归一化——
 * 不管哪条路径改了经验，写进库的状态必然满足不变量 exp < 当前等级门槛；
 * 升级文本进入按 userId 键控的通知队列，由指令收尾统一排水。
 */

/** 模拟真实 Prisma：(id, version) 复合唯一键 CAS + 主键定点更新 */
function makePrismaWithCas(rows: any[]) {
  const prisma: any = {
    player: {
      findUnique: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) => r.userId === where?.userId);
        return row ? { ...row } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const cv = where?.id_version;
        if (!cv) {
          const rowById = rows.find((r) => r.id === where?.id);
          if (!rowById) {
            const err0: any = new Error('record not found');
            err0.code = 'P2025';
            throw err0;
          }
          Object.assign(rowById, data);
          return rowById;
        }
        const row = rows.find((r) => r.id === cv.id);
        if (!row || row.version !== cv.version) {
          const err: any = new Error('An operation failed because it depends on one or more records that were required but was not found.');
          err.code = 'P2025';
          throw err;
        }
        Object.assign(row, data);
        return row;
      }),
    },
  };
  return prisma;
}

function makeService(prisma: any): PlayerService {
  const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  const service = new PlayerService(
    prisma,
    { getEquipmentByName: () => undefined } as unknown as StaticDataService,
    {} as any,
  );
  (service as any).logger = logger;
  return service;
}

function makeRow(overrides: any = {}) {
  return {
    id: 1,
    userId: 42,
    name: '测试玩家',
    mapId: 7,
    version: 0,
    type: '白',
    markers: '{}',
    backpack: '[]',
    ...overrides,
  };
}

describe('savePlayer 经验归一化门禁', () => {
  it('复现 bug 场景：Lv.5 经验 514 保存后自动连升到对应等级且余数低于门槛', async () => {
    // 现实来源：挤奶青龙奖励等路径直写 exp 累积出的非法存量状态
    const row = makeRow({ level: 5, exp: 514, upgradeExp: 30 });
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    await service.savePlayer({ ...row });

    expect(row.level).toBe(12);   // 扣 30+41+54+69+86+105+126 = 511，从 Lv.5 连升到 Lv.12
    expect(row.exp).toBe(3);      // 514-511
    expect(row.upgradeExp).toBe(12 * 12 + 5);
    expect(row.exp).toBeLessThan(row.upgradeExp); // 不变量恢复
  });

  it('经验未达门槛时不改动等级与经验', async () => {
    const row = makeRow({ level: 5, exp: 10, upgradeExp: 30 });
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    await service.savePlayer({ ...row });

    expect(row.level).toBe(5);
    expect(row.exp).toBe(10);
  });

  it('顺带修正存量脏 upgradeExp（旧版曾写入错误的 100）', async () => {
    const row = makeRow({ level: 1, exp: 2, upgradeExp: 100 });
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    await service.savePlayer({ ...row });

    expect(row.upgradeExp).toBe(6); // 1*1+5
    expect(row.level).toBe(1);
  });

  it('部分更新对象（无 level/exp 字段）跳过归一化且不注入派生字段', async () => {
    const row = makeRow({ level: 5, exp: 10 });
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    // 模拟 task.service 等路径手工构造的定点更新快照
    await service.savePlayer({ id: 1, version: 0, markers: '{"采集":1}' } as any);

    expect(row.level).toBe(5);
    expect((prisma.player.update.mock.calls[0][0].data).upgradeExp).toBeUndefined();
    expect((prisma.player.update.mock.calls[0][0].data).exp).toBeUndefined();
  });

  it('升级时重算成长属性并推进版本号（CAS 正常落库）', async () => {
    const row = makeRow({ level: 1, exp: 30, upgradeExp: 6, version: 7 });
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    await service.savePlayer({ ...row });

    expect(row.version).toBe(8);
    expect(row.level).toBeGreaterThan(1);
    // 已选使魔玩家升级后 maxHp 按公式重算（50+(lv*2+防御熟练)*(1+lv/100)）
    expect(Number(row.maxHp)).toBeGreaterThan(0);
  });
});

describe('升级通知队列', () => {
  it('applyLevelUps 触发的升级进入队列，takePendingLevelUpText 排水一次后清空', async () => {
    const row = makeRow({ level: 5, exp: 514, upgradeExp: 30 });
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    await service.savePlayer({ ...row });

    const text = service.takePendingLevelUpText(42);
    expect(text).toContain('⭐ 等级提升了！');
    expect(text).toContain('Lv.5 → Lv.12');

    // 排水是一次性的：第二次取为空，不会在后续指令里重复弹出
    expect(service.takePendingLevelUpText(42)).toBe('');
  });

  it('不同玩家的通知互不串扰', async () => {
    const a = makeRow({ id: 1, userId: 42, level: 1, exp: 20, upgradeExp: 6 });
    const b = makeRow({ id: 2, userId: 43, level: 1, exp: 2, upgradeExp: 6 });
    const prisma = makePrismaWithCas([a, b]);
    const service = makeService(prisma);

    await service.savePlayer({ ...a });

    expect(service.takePendingLevelUpText(43)).toBe('');
    expect(service.takePendingLevelUpText(42)).not.toBe('');
  });

  it('未升级不产生通知', async () => {
    const row = makeRow({ level: 5, exp: 10, upgradeExp: 30 });
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    await service.savePlayer({ ...row });

    expect(service.takePendingLevelUpText(42)).toBe('');
  });
});

describe('addExp 与归一化共享同一实现', () => {
  it('跨级加经验一次连升并返回新等级', async () => {
    const row = makeRow({ level: 1, exp: 0, upgradeExp: 6 });
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    const result = await service.addExp(42, 200);

    // 门槛序列 6/9/14/21/30/41/54：200 连扣到 Lv.8 余 25（< 69）
    expect(result.leveledUp).toBe(true);
    expect(result.newLevel).toBe(8);
    expect(row.level).toBe(8);
    expect(row.exp).toBe(25);
  });

  it('小额外加经验未过门槛时不升级', async () => {
    const row = makeRow({ level: 3, exp: 5, upgradeExp: 14 });
    const prisma = makePrismaWithCas([row]);
    const service = makeService(prisma);

    const result = await service.addExp(42, 3);

    expect(result.leveledUp).toBe(false);
    expect(result.newLevel).toBe(3);
    expect(row.exp).toBe(8);
  });
});
