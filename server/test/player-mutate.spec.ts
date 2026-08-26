import { PlayerMutateService } from '../src/modules/game/player-mutate.service';
import { PlayerService } from '../src/modules/game/player.service';
import { StaticDataService } from '../src/modules/game/static-data.service';

/**
 * P2 mutate 管道 + P4 货币审计回归：
 * - mutate 持锁读取新鲜快照、执行变更、统一落库；
 * - 货币列变化时写 CurrencyLog（delta/balanceAfter），无变化不写。
 */

function makePrisma(rows: any[]) {
  const currencyLogs: any[] = [];
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
            const err: any = new Error('not found'); err.code = 'P2025'; throw err;
          }
          Object.assign(rowById, data);
          return rowById;
        }
        const row = rows.find((r) => r.id === cv.id);
        if (!row || row.version !== cv.version) {
          const err: any = new Error('required but was not found.'); err.code = 'P2025'; throw err;
        }
        Object.assign(row, data);
        return row;
      }),
    },
    currencyLog: {
      create: jest.fn(async ({ data }: any) => {
        currencyLogs.push(data);
        return data;
      }),
    },
  };
  return { prisma, currencyLogs };
}

function makeServices(prisma: any) {
  const playerService = new PlayerService(
    prisma,
    { getEquipmentByName: () => undefined } as unknown as StaticDataService,
    {} as any,
  );
  (playerService as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  const mutateService = new PlayerMutateService(prisma, playerService);
  (mutateService as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  return { playerService, mutateService };
}

function makeRow(overrides: any = {}) {
  return {
    id: 1, userId: 42, name: '测试玩家', mapId: 1, version: 0,
    markers: '{}', backpack: '[]',
    diamonds: 100, tickets: 20, dataCores: 0,
    ...overrides,
  };
}

describe('mutate 管道与货币审计', () => {
  it('mutate 内的货币变动被记录到 CurrencyLog（delta 与余额正确）', async () => {
    const row = makeRow();
    const { prisma, currencyLogs } = makePrisma([row]);
    const { mutateService } = makeServices(prisma);

    await mutateService.mutate(42, async (ctx) => {
      // 业务视角：像兑换一样扣 40 钻、加 2 券
      const bp = ctx.backpack;
      bp.find((i: any) => i.name === '钻石').quantity -= 40;
      bp.find((i: any) => i.name === '召唤券').count += 2;
      ctx.player.backpack = JSON.stringify(bp);
    });

    expect(row.diamonds).toBeCloseTo(60, 5);
    expect(row.tickets).toBeCloseTo(22, 5);

    const byCurrency = Object.fromEntries(currencyLogs.map((l) => [l.currency, l]));
    expect(byCurrency['钻石'].delta).toBeCloseTo(-40, 5);
    expect(byCurrency['钻石'].balanceAfter).toBeCloseTo(60, 5);
    expect(byCurrency['召唤券'].delta).toBeCloseTo(2, 5);
    expect(byCurrency['召唤券'].balanceAfter).toBeCloseTo(22, 5);
    expect(currencyLogs).toHaveLength(2);
  });

  it('无货币变动时不产生审计日志', async () => {
    const row = makeRow();
    const { prisma, currencyLogs } = makePrisma([row]);
    const { mutateService } = makeServices(prisma);

    await mutateService.mutate(42, async (ctx) => {
      ctx.player.hp = 55;
    });

    expect(row.hp).toBe(55);
    expect(currencyLogs).toHaveLength(0);
  });

  it('mutate 返回业务回调的返回值', async () => {
    const row = makeRow();
    const { prisma } = makePrisma([row]);
    const { mutateService } = makeServices(prisma);

    const result = await mutateService.mutate(42, () => 'ok');
    expect(result).toBe('ok');
  });
});
