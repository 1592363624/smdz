import { AutoMineService } from '../src/modules/game/auto-mine.service';
import {
  FamiliarSystemService,
} from '../src/modules/game/familiar-system.service';
import { PlayerService } from '../src/modules/game/player.service';
import { StaticDataService } from '../src/modules/game/static-data.service';

/**
 * 回归：兑换召唤券后，后台自动开采结算不得用旧快照覆盖背包
 * （曾导致钻石被扣、召唤券没到账、背包显示回滚）。
 *
 * 复现方式：让 getContext 在读取快照与写回之间挂起（远程库高延迟窗口），
 * 期间玩家完成兑换；修复前挖矿结算的 savePlayer 会把兑换前的旧快照整包写回，
 * 兑换的扣钻/加券全部丢失。
 */

function makeFixture(options: { resources?: any[]; outputs?: any[] } = {}) {
  const player: any = {
    id: 1,
    userId: 42,
    name: '测试玩家',
    mapId: 7,
    vehicle: 'v1',
    markers: '{}',
    markers2: '[]',
    backpack: JSON.stringify([
      { name: '钻石', type: '资源', quantity: 2000 },
      { name: '召唤券', type: '资源', count: 20 },
    ]),
  };
  const map: any = {
    id: 7,
    name: '测试地图',
    isInstance: false,
    resources: JSON.stringify(options.resources ?? [{
      name: '矿脉',
      marker: '',
      outputs: options.outputs ?? [{ name: '铁矿', count: 2, chance: 100 }],
    }]),
    vehicles: JSON.stringify([{
      id: 'v1',
      name: '采集车',
      currentHp: 100,
      parts: [{ name: '激光采集器' }],
    }]),
    summons: '[]',
  };

  const prisma: any = {
    player: {
      findUnique: jest.fn(async ({ where }: any) => (where?.userId === player.userId ? player : undefined)),
      update: jest.fn(async ({ where, data }: any) => {
        if (where?.id !== player.id) throw new Error(`player id 不匹配: ${where?.id}`);
        Object.assign(player, data);
        return player;
      }),
      findMany: jest.fn(async () => [{ userId: player.userId }]),
    },
    gameMap: { findUnique: jest.fn(async () => map) },
  };

  // 真实的 PlayerService：共享用户级锁是本次回归的核心。
  const realPlayerService = new PlayerService(
    prisma,
    { getEquipmentByName: () => undefined } as unknown as StaticDataService,
    { getMapById: async () => map, getMapByName: async () => map } as any,
  );

  const staticData: any = {
    getEquipmentByName: () => undefined,
    getShopConfig: () => ({
      activity: [],
      diamond: [{ name: '召唤券', count: 20 }],
      dataCore: [],
    }),
    getAllFamiliars: () => [
      { name: '阿尔缇娜' },
      { name: '露娜' },
    ],
  };

  const taskService: any = {
    advance: jest.fn(async () => ''),
  };
  const itemSystem: any = {
    // 模拟真实 distributeLoot：把产出合并进快照背包并整包写回 player.backpack
    distributeLoot: jest.fn(async (playerData: any, drops: any[]) => {
      const backpack = JSON.parse(playerData.player.backpack || '[]');
      for (const drop of drops) {
        const existing = backpack.find((item: any) => item.name === drop.name);
        if (existing) existing.quantity = Number(existing.quantity ?? existing.count ?? 0) + drop.quantity;
        else backpack.push({ name: drop.name, type: '资源', quantity: drop.quantity });
      }
      playerData.player.backpack = JSON.stringify(backpack);
      return drops.map((drop) => `${drop.name}×${drop.quantity}`).join('、');
    }),
  };
  const combatSystem: any = { buildAttackerBonus: () => ({}) };

  const mine = new AutoMineService(
    prisma,
    realPlayerService as any,
    { getMapById: async () => map } as any,
    staticData,
    combatSystem,
    itemSystem,
    taskService,
  );

  const familiarSystem = new FamiliarSystemService(
    prisma,
    realPlayerService as any,
    {} as any, // bonusService：兑换路径不触达
    staticData,
    taskService,
    {} as any, // mapService：兑换路径不触达
    {} as any, // combatSystem：兑换路径不触达
  );

  return { player, mine, familiarSystem, realPlayerService };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('兑换与后台结算的用户级锁互斥', () => {
  it('兑换后启动的后台开采结算不得回滚兑换结果', async () => {
    const fixture = makeFixture();
    const { player, mine, familiarSystem, realPlayerService } = fixture;

    // 先启动自动开采（写入「自动开采」开始时间标记）
    await expect(mine.start(42, 1_000_000)).resolves.toContain('开始自动开采');

    // 对齐指令处理器调用形态：数字已拆出（兑换召唤券52 → ('召唤券', 52)）
    await expect(familiarSystem.exchange(42, '召唤券', 52)).resolves.toContain('兑换了召唤券x52');

    const afterExchange = JSON.parse(player.backpack);
    const diamondAfter = afterExchange.find((item: any) => item.name === '钻石');
    const ticketAfter = afterExchange.find((item: any) => item.name === '召唤券');
    expect(diamondAfter.quantity).toBeCloseTo(960);
    expect(ticketAfter.count).toBeCloseTo(72);

    // 后台结算在「读快照」处挂起，模拟远程库高延迟窗口
    let releaseContext: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseContext = resolve; });
    const originalGetContext = (mine as any).getContext.bind(mine);
    jest.spyOn(mine as any, 'getContext').mockImplementationOnce(async () => {
      const context = await originalGetContext(42);
      // 深拷贝快照：模拟真实场景中「独立的一次数据库读取」。
      // 此后共享对象上的任何写入都不得反映进这份旧快照，
      // 否则测试无法区分「锁生效」与「引用恰好相同」两种情况。
      const snapshotPlayer = { ...context.player };
      await gate;
      return {
        ...context,
        player: snapshotPlayer,
        playerData: { player: snapshotPlayer } as any,
      };
    });

    // 开采已持续 120 秒（baseMs 时启动），本轮结算应有铁矿产出
    void mine.checkpointAll(1_000_000 + 120_000);
    await sleep(30);

    // 结算挂起期间玩家继续兑换一张券（20钻）：先排队、后释放，避免测试自锁
    const secondExchange = familiarSystem.exchange(42, '召唤券', 1);
    await sleep(20);

    releaseContext!();
    await expect(secondExchange).resolves.toContain('兑换了召唤券x1');
    // 等挂起的 checkpointAll 微任务链彻底走完再断言
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const finalBackpack = JSON.parse(player.backpack);
    const diamondFinal = finalBackpack.find((item: any) => item.name === '钻石');
    const ticketFinal = finalBackpack.find((item: any) => item.name === '召唤券');
    const ore = finalBackpack.find((item: any) => item.name === '铁矿');
    // 钻石只被两次兑换扣减，未被旧快照回滚到 2000
    expect(diamondFinal.quantity).toBeCloseTo(940, 5);
    // 召唤券保留两次兑换的成果并叠加本轮开采产出
    expect(ticketFinal.count).toBeCloseTo(73, 5);
    expect(ore).toBeDefined();

    expect(realPlayerService.withUserLock).toBeTruthy();
  });

  it('同一玩家的并发指令按锁排队串行执行', async () => {
    const fixture = makeFixture();
    const { player, familiarSystem, realPlayerService } = fixture;

    const order: string[] = [];
    const first = familiarSystem.exchange(42, '召唤券', 1).then((text) => {
      order.push('first-done');
      return text;
    });
    const second = familiarSystem.exchange(42, '召唤券', 1).then((text) => {
      order.push('second-done');
      return text;
    });
    await Promise.all([first, second]);

    expect(order).toEqual(['first-done', 'second-done']);
    const backpack = JSON.parse(player.backpack);
    const diamonds = backpack.find((item: any) => item.name === '钻石');
    const tickets = backpack.find((item: any) => item.name === '召唤券');
    expect(diamonds.quantity).toBe(1960);
    expect(tickets.count).toBeCloseTo(22, 5);

    // 可重入：锁内再进同用户锁直接放行，不自我死锁（exchange→advance 嵌套场景）
    await expect(realPlayerService.withUserLock(42, async () =>
      realPlayerService.withUserLock(42, async () => 'nested'))).resolves.toBe('nested');
  });
});
