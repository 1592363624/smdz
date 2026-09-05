import { ActorRuntime } from '../src/modules/actor';
import { FamiliarSystemService } from '../src/modules/game/familiar-system.service';
import { PlayerService } from '../src/modules/game/player.service';
import { StaticDataService } from '../src/modules/game/static-data.service';
import { TaskService } from '../src/modules/game/task.service';

/**
 * 三支柱回归：货币统一读写入口（支柱一）
 *
 * 正式库 7516（使魔大王/花园猫）事故复现：
 *   16:26:13 兑换召唤券52 成功（21.012+52=73.012）
 *   16:26:26 召唤使魔73 →「你的召唤券只有21.012」（兑换前旧值）
 * 根因：兑换加券只写背包条目 quantity、召唤只读 count——同一份 Actor 活态里
 * 双字段分裂，读侧拿到陈旧值；若召唤数量 ≤ 旧值还会按旧值扣减写回，把刚到账
 * 的券整段吞掉（16:12 会话实际损失 52 券/1040 钻）。
 *
 * 修复：所有货币读写收敛到 PlayerService.getEntryQuantity / getCurrencyAmount /
 * setCurrencyAmount——读侧与落库仲裁同口径（偏离物化基准更大的字段），写侧
 * count/quantity 双字段同步 + 刷新基准。「读到旧字段」在构造上不再可能。
 */

function makePrisma(row: any) {
  const cloneRow = () => JSON.parse(JSON.stringify(row));
  const prisma: any = {
    player: {
      findUnique: jest.fn(async () => cloneRow()),
      update: jest.fn(async ({ where, data }: any) => {
        if (where?.id !== row.id) throw new Error('player id 不匹配');
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const cv = where?.id_version;
        if (!cv || row.id !== cv.id || row.version !== cv.version) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    currencyLog: { create: jest.fn(async () => ({})) },
  };
  return prisma;
}

function makeRow(): any {
  return {
    id: 1,
    userId: 42,
    version: 0,
    mapId: 1,
    level: 1,
    // 落库态背包不含货币条目（列是唯一真相源）；正式库 7516 结算后的真实余额形态
    diamonds: 1050.6,
    tickets: 21.012,
    dataCores: 0,
    backpack: '[]',
    markers: '{}',
    markers2: '[]',
    recipes: '[]',
    tasks: '[]',
    buffs: '[]',
    equipment: '[]',
    weapons: '[]',
    hp: 52, maxHp: 52, shield: 22, maxShield: 22, armor: 32, maxArmor: 32,
    attack: 10, hit: 10, dodge: 10, speed: 10, crit: 3, critDmg: 150,
    regenHp: 0, regenShield: 0, regenArmor: 0, affinity: 0,
    vitality: 100, lastOpTime: 0, readTime: 0, playTime: 0,
    baseName: '花园猫',
  };
}

function makeStaticData(): any {
  return {
    getEquipmentByName: () => undefined,
    getShopConfig: () => ({
      activity: [],
      diamond: [{ name: '召唤券', count: 20 }],
      dataCore: [],
    }),
    getAllFamiliars: () => [{ name: '阿尔缇娜' }, { name: '露娜' }],
  };
}

function makeFixture(): { row: any; prisma: any; playerService: PlayerService; familiarSystem: FamiliarSystemService } {
  const row = makeRow();
  const prisma = makePrisma(row);
  // 注入真实 ActorRuntime：两次操作落入同一 cell、共享内存活态——
  // 这正是 7516 事故的运行时形态（兑换后 17 秒内召唤，cell 未被空闲驱逐）。
  const actorRuntime = new ActorRuntime();
  const playerService = new PlayerService(
    prisma,
    makeStaticData() as unknown as StaticDataService,
    { getMapById: async () => null } as any,
    undefined as any,
    actorRuntime,
  );
  playerService.onModuleInit();
  const taskService: any = { advance: jest.fn(async () => '') };
  const familiarSystem = new FamiliarSystemService(
    prisma,
    playerService,
    {} as any,
    makeStaticData() as unknown as StaticDataService,
    taskService,
    {} as any,
    {} as any,
  );
  return { row, prisma, playerService, familiarSystem };
}

describe('支柱一：兑换→立刻召唤的新鲜度（7516 正式库事故复现）', () => {
  it('兑换召唤券52 后立即召唤使魔73 必须成功且按新余额扣减（修复前报「只有21.012」）', async () => {
    const { row, familiarSystem } = makeFixture();

    // 用户 16:26:13 的原话：兑换召唤券52（1040 钻 → +52 券 → 73.012）
    await expect(familiarSystem.exchange(42, '召唤券', 52))
      .resolves.toContain('兑换了召唤券x52');

    // 用户 16:26:26 的原话：召唤使魔73。修复前同 cell 活态里 .count 仍是 21.012，
    // 会返回「你的召唤券只有21.012，无法召唤73次」；修复后读到 73.012 并正常扣减。
    await expect(familiarSystem.summonFamiliar(42, 73))
      .resolves.toContain('使用了73张召唤券');

    // 落库终态：73.012 过两位小数闸=73.01，扣 73 后 0.01（条目花光移除），钻石只扣一次
    expect(row.tickets).toBeCloseTo(0.01, 6);
    expect(row.diamonds).toBeCloseTo(10.6, 6);
  });

  it('召唤数量 ≤ 兑换前旧值时也不得吞券：扣减必须基于兑换后的新余额', async () => {
    const { row, familiarSystem } = makeFixture();

    await familiarSystem.exchange(42, '召唤券', 52); // 21.012 → 73.012
    // 修复前：同 cell 读 .count=21.012 → 扣 1 写 20.012 → 73.012 的列被旧值扣减覆盖
    // （52 券凭空消失）。修复后按 73.012 扣减。
    await expect(familiarSystem.summonFamiliar(42, 1))
      .resolves.toContain('使用了1张召唤券');

    expect(row.tickets).toBeCloseTo(72.01, 6);
    expect(row.diamonds).toBeCloseTo(10.6, 6);
  });
});

describe('支柱一：统一货币读写入口语义', () => {
  it('读侧与落库仲裁同口径：取偏离物化基准更大的字段，绝不读双字段镜像旧值', () => {
    const { playerService } = makeFixture();
    const player: any = {
      backpack: [{ name: '召唤券', type: '资源', quantity: 73.012, count: 21.012 }],
      _currencyMirror: { '召唤券': 21.012 },
    };
    // 修复前 addResourceToBackpack 只写 quantity 后，召唤读 .count 得到旧值 21.012
    expect(playerService.getCurrencyAmount(player, '召唤券')).toBeCloseTo(73.012, 6);
    // 反向分裂同样处理
    const player2: any = {
      backpack: [{ name: '召唤券', type: '资源', quantity: 21.012, count: 73.012 }],
      _currencyMirror: { '召唤券': 21.012 },
    };
    expect(playerService.getCurrencyAmount(player2, '召唤券')).toBeCloseTo(73.012, 6);
    // 无基准（原始行/手工条目）：quantity 优先
    const player3: any = { backpack: [{ name: '钻石', quantity: 5 }] };
    expect(playerService.getCurrencyAmount(player3, '钻石')).toBe(5);
    // 条目缺失 = 0
    expect(playerService.getCurrencyAmount(player, '数据核心')).toBe(0);
  });

  it('写侧双字段同步 + 刷新物化基准；<=0 视为花光移除条目并把基准清零', () => {
    const { playerService } = makeFixture();
    const player: any = {
      backpack: [{ name: '召唤券', type: '资源', quantity: 21.012, count: 21.012 }],
      _currencyMirror: { '召唤券': 21.012 },
    };

    playerService.setCurrencyAmount(player, '召唤券', 73.012);
    const entry = player.backpack.find((i: any) => i.name === '召唤券');
    // 写侧过 roundItemQuantity 两位小数闸（防 73.012 型长尾入库的既定纪律）
    expect(entry.quantity).toBeCloseTo(73.01, 6);
    expect(entry.count).toBeCloseTo(73.01, 6);
    expect(player._currencyMirror['召唤券']).toBeCloseTo(73.01, 6);

    playerService.setCurrencyAmount(player, '召唤券', 0.012000000000000455);
    const entry2 = player.backpack.find((i: any) => i.name === '召唤券');
    expect(entry2.quantity).toBeCloseTo(0.01, 6);
    expect(entry2.count).toBeCloseTo(0.01, 6);

    playerService.setCurrencyAmount(player, '召唤券', 0);
    expect(player.backpack.some((i: any) => i.name === '召唤券')).toBe(false);
    expect(player._currencyMirror['召唤券']).toBe(0);

    // 无条目时写入自动创建双字段条目（无 mirror 的对象也不炸）
    const player2: any = { backpack: [] };
    playerService.setCurrencyAmount(player2, '钻石', 1050.6);
    expect(player2.backpack[0]).toMatchObject({ name: '钻石', quantity: 1050.6, count: 1050.6 });
  });

  it('任务发奖 addBackpackItem 用偏差感知读当存量：分裂条目上累加不吞余额', () => {
    const { playerService } = makeFixture();
    const prisma = makePrisma(makeRow());
    const taskService = new TaskService(
      prisma,
      playerService,
      { getTaskByName: () => undefined } as any,
      undefined as any,
    );
    // 7516 同源形态：条目被某单字段写者分裂（count=旧值4.02，quantity=新值1050.62）
    const player: any = { backpack: [{ name: '钻石', type: '资源', count: 4.02, quantity: 1050.62 }], _currencyMirror: { '钻石': 4.02 } };
    (taskService as any).addBackpackItem(player.backpack, '钻石', 1050.6, '资源', player);
    const entry = player.backpack.find((i: any) => i.name === '钻石');
    // 修复前读 count=4.02 → 4.02+1050.6=1054.62，把 quantity 上的真实余额吞掉
    expect(entry.count).toBeCloseTo(2101.22, 6);
    expect(entry.quantity).toBeCloseTo(2101.22, 6);
  });
});
