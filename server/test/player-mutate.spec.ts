import { PlayerMutateService } from '../src/modules/game/player-mutate.service';
import { PlayerMutateContextService } from '../src/modules/game/player-mutate-context.service';
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
  // 上下文登记处由两边共享，PlayerService 靠它感知「是否已在 mutate 内」
  const mutateContext = new PlayerMutateContextService();
  const playerService = new PlayerService(
    prisma,
    { getEquipmentByName: () => undefined } as unknown as StaticDataService,
    {} as any,
    mutateContext,
  );
  (playerService as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  const mutateService = new PlayerMutateService(prisma, playerService, mutateContext);
  (mutateService as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  return { playerService, mutateService, mutateContext };
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

// ============ 单一快照（Actor 语义）回归 ============
// 这几条锁住的是历史上反复出现的事故根因：子流程自行读档落库，导致上层快照
// 瞬间过期，随后要么被 CAS 拒绝（玩家看到「并发冲突」），要么把内层结果整包覆盖。
describe('mutate 单一快照语义（嵌套复用，不重读不重存）', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('嵌套 mutate 复用同一份 ctx：只读档一次、只落库一次，内层改动不丢失', async () => {
    const row = makeRow({ hp: 100 });
    const { prisma } = makePrisma([row]);
    const { playerService, mutateService } = makeServices(prisma);
    const spyRead = jest.spyOn(playerService, 'getPlayerData');
    const spySave = jest.spyOn(playerService, 'savePlayer');

    await mutateService.mutate(42, async (outer) => {
      outer.player.hp = 80;
      // 子流程：对应 castCombatSkill 这类「内部也会写入」的调用
      await mutateService.mutate(42, async (inner) => {
        expect(inner).toBe(outer); // 必须是同一个对象，不是第二份快照
        inner.player.hp = 60;
      });
      expect(outer.player.hp).toBe(60); // 内层改动对外层可见
    });

    expect(spyRead.mock.calls).toHaveLength(1);
    expect(spySave.mock.calls).toHaveLength(1);
    expect(row.hp).toBe(60); // 内层改动随最外层一起落库，没有被回滚
  });

  it('三层嵌套同样只落库一次，且所有层改动都生效', async () => {
    const row = makeRow({ markers: '{"活跃度":0}', hp: 100 });
    const { prisma } = makePrisma([row]);
    const { playerService, mutateService } = makeServices(prisma);
    const spySave = jest.spyOn(playerService, 'savePlayer');

    await mutateService.mutate(42, async (l1) => {
      l1.player.hp = 90;
      await mutateService.mutate(42, async (l2) => {
        l2.player.hp = 80;
        await mutateService.mutate(42, async (l3) => {
          const m = JSON.parse(l3.player.markers);
          m['活跃度'] += 1;
          l3.player.markers = JSON.stringify(m);
        });
      });
    });

    expect(spySave.mock.calls).toHaveLength(1);
    expect(row.hp).toBe(80);
    expect(JSON.parse(row.markers)['活跃度']).toBe(1);
  });

  it('mutate 内业务方直接调用 savePlayer 应合并回上下文而非二次落库', async () => {
    // 真实指令处理路径：业务代码读完快照（getPlayerData）后自行 savePlayer(player)。
    // 必须合并回 ctx、由最外层统一落库一次；若 ctx 反查键用错（player.id 而非
    // userId），内层 savePlayer 会真的写一次库再 bump 一次 version，导致
    // prisma.update 被调用两次、外层保存被 CAS 误判为并发冲突。
    const row = makeRow({ hp: 100 });
    const { prisma } = makePrisma([row]);
    const { playerService, mutateService } = makeServices(prisma);
    const spyUpdate = jest.spyOn(prisma.player, 'update');

    await mutateService.mutate(42, async (ctx) => {
      ctx.player.hp = 60;
      ctx.backpack.push({ name: '石头', count: 1 });
      // 模拟指令处理里常见的「自行保存」
      await playerService.savePlayer(ctx.player);
    });

    expect(spyUpdate.mock.calls).toHaveLength(1); // 内层合并、只落库一次
    expect(row.hp).toBe(60);
    expect(JSON.parse(row.backpack).some((i: any) => i.name === '石头')).toBe(true);
  });

  it('并发 mutate 串行执行，两次累加不丢失更新', async () => {
    const row = makeRow({ markers: '{"活跃度":0}' });
    const { prisma } = makePrisma([row]);
    const { mutateService } = makeServices(prisma);

    const bump = () =>
      mutateService.mutate(42, async (ctx) => {
        const m = JSON.parse(ctx.player.markers);
        await sleep(10); // 拉长读改写窗口，确保若无串行化必然丢更新
        m['活跃度'] = Number(m['活跃度'] || 0) + 1;
        ctx.player.markers = JSON.stringify(m);
      });

    await Promise.all([bump(), bump()]);

    expect(JSON.parse(row.markers)['活跃度']).toBe(2);
  });

  it('fn 抛异常时不落库，异常向上冒泡', async () => {
    const row = makeRow({ hp: 100 });
    const { prisma } = makePrisma([row]);
    const { mutateService } = makeServices(prisma);

    await expect(
      mutateService.mutate(42, (ctx) => {
        ctx.player.hp = 1;
        throw new Error('业务失败');
      }),
    ).rejects.toThrow('业务失败');

    expect(row.hp).toBe(100); // 未落库
  });
});

describe('mutate 结构化字段双向同步', () => {
  it('只改 ctx.backpack 也会同步回 player.backpack，不静默丢失', async () => {
    const row = makeRow({ backpack: '[{"name":"木头","quantity":10}]' });
    const { prisma } = makePrisma([row]);
    const { mutateService } = makeServices(prisma);

    await mutateService.mutate(42, (ctx) => {
      ctx.backpack[0].quantity = 3; // 故意不手动写回 player.backpack
    });

    // 货币物化会往背包追加条目，这里只校验目标物品被正确改到
    const wood = JSON.parse(row.backpack).find((i: any) => i.name === '木头');
    expect(wood.quantity).toBe(3);
  });

  it('直接改 player.backpack 字符串时不被 ctx 侧覆盖', async () => {
    const row = makeRow({ backpack: '[{"name":"木头","quantity":10}]' });
    const { prisma } = makePrisma([row]);
    const { mutateService } = makeServices(prisma);

    await mutateService.mutate(42, (ctx) => {
      ctx.player.backpack = '[{"name":"石头","quantity":5}]'; // 走字符串路径
    });

    expect(JSON.parse(row.backpack)[0].name).toBe('石头');
  });

  it('未触碰的字段不会被回写成解析后的等价字符串', async () => {
    const row = makeRow({ backpack: '[{"name":"木头","quantity":10}]' });
    const { prisma } = makePrisma([row]);
    const { mutateService } = makeServices(prisma);

    await mutateService.mutate(42, (ctx) => {
      ctx.player.hp = 42; // 只改标量，不碰背包
    });

    expect(row.hp).toBe(42);
    expect(JSON.parse(row.backpack)[0].quantity).toBe(10);
  });
});

// ============ 「自读自写」基础方法在 mutate 内的复用 ============
// 采集结算这类复杂函数内部会调 addExp(userId, ...)。若 addExp 仍自己读档保存，
// 就会凭空多出第二份快照：要么外层改动被它覆盖，要么它的改动被外层覆盖。
// 复用 ctx 后，调用方无需改签名就能被 mutate 安全包住——这是 mutate 化能
// 「局部渐进推进」而不必一次性改造整条调用链的关键。
describe('mutate 内调用 addExp 等基础方法复用同一份快照', () => {
  // 注意：经验增量刻意取 3（低于「等级²+5」=6 的升级门槛），
  // 否则 applyLevelUps 会把经验扣掉用于升级，exp 落库后不再是增量值。
  it('mutate 内调 addExp：复用 ctx，不读档不保存，改动随最外层一起落库', async () => {
    const row = makeRow({ exp: 0, level: 1, upgradeExp: 100000, hp: 100 });
    const { prisma } = makePrisma([row]);
    const { playerService, mutateService } = makeServices(prisma);
    const spySave = jest.spyOn(playerService, 'savePlayer');

    await mutateService.mutate(42, async (ctx) => {
      ctx.player.hp = 70;
      await playerService.addExp(42, 3);
    });

    // addExp 若自己读档保存，这里会是 2 次
    expect(spySave.mock.calls).toHaveLength(1);
    expect(row.exp).toBe(3); // 经验累加生效
    expect(row.hp).toBe(70); // 外层的 hp 改动没有被 addExp 的旧快照覆盖
  });

  it('mutate 外调 addExp：仍走独立读档保存路径（向后兼容）', async () => {
    const row = makeRow({ exp: 0, level: 1, upgradeExp: 100000 });
    const { prisma } = makePrisma([row]);
    const { playerService } = makeServices(prisma);

    await playerService.addExp(42, 3);

    expect(row.exp).toBe(3);
  });

  it('mutate 内升级时属性重算同样生效并落库', async () => {
    const row = makeRow({ exp: 0, level: 1, upgradeExp: 10, hp: 100, maxHp: 100, type: 'Saber' });
    const { prisma } = makePrisma([row]);
    const { playerService, mutateService } = makeServices(prisma);

    await mutateService.mutate(42, async (ctx) => {
      await playerService.addExp(42, 100);
    });

    // 跨过升级门槛：等级推进且等级相关属性被重算后落库
    expect(row.level).toBeGreaterThan(1);
  });
});
