import { GatherHandler } from '../src/modules/command/handlers/gather.handler';
import { GameService } from '../src/modules/game/game.service';
import { DelayedTaskService } from '../src/modules/game/delayed-task.service';
import { parseJson } from './parse-json.util';
import { createGameServiceStub } from './helpers/game-service-stub.factory';

/**
 * 手动采集两阶段流程自检（1:1 对齐原版）：
 * 阶段1 handleGatherResource = _主程序.ecode L11351-11456（回复预计耗时+锁定+延时任务）
 * 阶段2 settleGatherResource = 采j结s L6790-6806 + 采集资源 地图操作.ecode L1469-1639
 */

function makeGatherFixture(resource: any, options: {
  equipmentNames?: string[];
  markers2?: any[];
  markers?: Record<string, any>;
  mapOverrides?: Record<string, any>;
  summons?: any[];
  monsters?: any[];
  role?: string;
} = {}) {
  const player: any = {
    userId: 42,
    name: '测试玩家',
    level: 10,
    mapId: 7,
    houseName: '',
    currentWeapon: 0,
    markers: JSON.stringify(options.markers || {}),
    markers2: JSON.stringify(options.markers2 || []),
    backpack: '[]',
  };
  const map: any = {
    id: 7,
    name: '测试地图',
    resources: JSON.stringify([resource]),
    resources2: '[]',
    markers2: '[]',
    summons: JSON.stringify(options.summons || []),
    ...options.mapOverrides,
  };
  const taskService = {
    advance: jest.fn(async () => ''),
    acceptTask: jest.fn(async () => ''),
    consumeNotifications: jest.fn(() => ''),
  };
  const prisma = {
    player: {
      // 兜底/迁移读取用：返回该玩家的实时 markers
      findMany: jest.fn(async () => [
        { userId: player.userId, id: player.id ?? 1, markers: player.markers },
      ]),
    },
    // 超管野外批量：带数字后缀的采集开始会实时查库 role
    user: {
      findUnique: jest.fn(async () => ({ id: player.userId, role: options.role ?? 'USER' })),
    },
    gameMap: {
      update: jest.fn(async ({ data }: any) => {
        Object.assign(map, data);
        return map;
      }),
    },
  };
  // 持久化延时任务的真实服务 + 内存桩库：handleGatherResource 排程、tick 分发结算
  const delayedTaskRows: any[] = [];
  let delayedTaskNextId = 1;
  const delayedTaskPrisma: any = {
    findMany: jest.fn(async ({ where, take }: any) => delayedTaskRows
      .filter((r) => r.runAt.getTime() <= where.runAt.lte.getTime())
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .slice(0, take ?? 30)),
    deleteMany: jest.fn(async ({ where }: any) => {
      // 两种形态：认领 {id, runAt<=lte}；排程覆盖 {type, userId, dedupeKey}
      const match = (r: any) => {
        if (where.id !== undefined) {
          if (r.id !== where.id) return false;
          if (where.runAt && r.runAt.getTime() > where.runAt.lte.getTime()) return false;
          return true;
        }
        if (where.type !== undefined && r.type !== where.type) return false;
        if (where.userId !== undefined && r.userId !== where.userId) return false;
        if (where.dedupeKey !== undefined && r.dedupeKey !== where.dedupeKey) return false;
        return true;
      };
      const idx = delayedTaskRows.findIndex(match);
      if (idx < 0) return { count: 0 };
      delayedTaskRows.splice(idx, 1);
      return { count: 1 };
    }),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: delayedTaskNextId++, ...data };
      delayedTaskRows.push(row);
      return row;
    }),
  };
  const delayedTaskService = new DelayedTaskService({ delayedTask: delayedTaskPrisma } as any);
  const playerService = {
  enqueueUserWrite: jest.fn((userId: number, fn: () => any) => fn()),
    getPlayerData: jest.fn(async () => ({
      player,
      // 对齐真实 getPlayerData：weapons 从 player.weapons JSON 解析
      weapons: (() => {
        try { return parseJson(player.weapons, []); } catch { return []; }
      })(),
    })),
    safeJsonParse: jest.fn((value: any, fallback: any) => {
      if (value === null || value === undefined) return fallback;
      if (typeof value !== 'string') return value;
      try {
        const parsed = JSON.parse(value);
        return parsed === null ? fallback : parsed;
      } catch {
        return fallback;
      }
    }),
    getBackpackItems: jest.fn((currentPlayer: any) => {
      try {
        return parseJson(currentPlayer.backpack, []);
      } catch {
        return [];
      }
    }),
    savePlayer: jest.fn(async () => undefined),
    addExp: jest.fn(async () => ({ leveledUp: false, newLevel: 10 })),
    isPlayerDead: jest.fn((p: any) => Number(p?.hp ?? 1) <= 0),
    deathGateText: jest.fn(async () => null), // 未死放行（与 isPlayerDead 恒假同语义）
    getMarkerValue: jest.fn((markers: any, name: string) => Number(markers?.[name] ?? 0)),
  };
  const itemSystemService = {
    generateRewardEquipment: jest.fn(async (name: string, quality?: string) => ({
      name,
      quality,
      type: '装备',
      data: 'e!bx0',
    })),
  };
  const combatSystem: any = {
    buildAttackerBonus: jest.fn(() => ({ 采集: 100, 掉落率: 0, 经验: 0 })),
    actionUnrestricted: jest.fn(() => ({ restricted: false, text: '' })),
    adminAttackMap: jest.fn(async () => '攻击'),
    // 采集引怪（原版 L11415-11426）：默认玩家等级10 <15 走豁免分支，不会真正调用；
    // 高等级用例显式断言本调用
    triggerMapBattleLoop: jest.fn(async () => undefined),
  };
  const chatService = {
    broadcastSystem: jest.fn(async () => undefined),
    emitToUser: jest.fn(async () => undefined),
  };
  const service: any = createGameServiceStub({
    prisma,
    delayedTaskService,
    playerService,
    mapService: {
      getMapById: jest.fn(async () => map),
      getMapMonsters: jest.fn(async () => options.monsters || []),
      // 模拟生产 mutateMapFields 闭环：重读最新字段 → 跑 mutator → 把改动同步回 map
      mutateMapFields: jest.fn(async (_mapId: number, fields: string[], mutator: (f: any) => any) => {
        const f: any = {};
        for (const field of fields) {
          const raw = (map as any)[field];
          f[field] = typeof raw === 'string'
            ? (() => { try { return JSON.parse(raw); } catch { return field === 'markers' ? {} : []; } })()
            : raw;
        }
        const result = mutator(f);
        for (const field of fields) (map as any)[field] = f[field];
        return result ?? {};
      }),
      mutateSummons: jest.fn(async (mapId: number, mutator: (f: any) => any) => {
        const raw = (map as any).summons;
        const summons = typeof raw === 'string'
          ? (() => { try { return JSON.parse(raw); } catch { return []; } })()
          : raw;
        const result = mutator(summons);
        (map as any).summons = summons;
        return result;
      }),
      // 采集引怪豁免分支的地图"活动"窗口刷新（按名合并落库）
      mergeMapMarkers2: jest.fn(async (_mapId: number, markers2: any[]) => {
        (map as any).markers2 = markers2;
      }),
    },
    combatSystem,
    combatState: {
      addMarker: jest.fn((名称: string, 时间: number, 标记: any[], 现行时间: number) => {
        if (时间 === 0) return;
        标记.push({ name: 名称, expireAt: 现行时间 + 时间 * 1000 });
      }),
      // 采集引怪豁免分支的玩家活跃（原版 L11427）：披风判定 + 地图/玩家标记刷新
      equipRequire: jest.fn((装备列表: any[], _武器列表: any[], _当前武器: number,
        特殊序号: number, 名称?: string, 是否武器?: boolean) => {
        if (是否武器) return false;
        return (装备列表 || []).some((eq: any) =>
          (特殊序号 !== 0 && eq?.特殊序号 === 特殊序号)
          || (!!名称 && (eq?.名称 === 名称 || eq?.name === 名称)));
      }),
      gainBuff: jest.fn((增益: any[], 名称: string, 时间: number, _叠加: boolean, 现行时间: number) => {
        增益.push({ name: 名称, expireAt: 现行时间 + 时间 * 1000 });
        return 0;
      }),
    },
    staticData: {
      getEquipmentByName: jest.fn((name: string) =>
        (options.equipmentNames || []).includes(name) ? { name } : undefined),
    },
    itemSystemService,
    taskService,
    chatService,
    logger: { log: jest.fn(), warn: jest.fn() },
    pushPlayerUpdate: jest.fn(async () => undefined),
    pushMapUpdate: jest.fn(async () => undefined),
  });
  return { service, player, map, taskService, prisma, itemSystemService, chatService, playerService, combatSystem, delayedTaskService, delayedTaskRows };
}

describe('手动采集两阶段流程（对齐原版采集耗时机制）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('阶段1：回复预计耗时不发奖励，并写入采集中状态+采集锁定标记', async () => {
    const fixture = makeGatherFixture({
      name: '医疗箱',
      times: -1,
      outputs: [{ name: '奶', quantity: 2, chance: 100 }],
      gatherCmd: '打开箱子',
      gatherText: '【名称】【载具】正在打开医疗箱',
      timeScale: 3,
    });

    const result = await fixture.service.handleGatherResource(42, '打开箱子');

    // 回复“大概需要N秒”（采集文本模板：【名称】=玩家名）
    expect(result).toContain('测试玩家正在打开医疗箱');
    expect(result).toContain(',大概需要');
    expect(result).toMatch(/大概需要(\d+)秒$/);
    // 耗时在 3~6 秒 × 时间倍率3 = 9~18 秒之间
    const seconds = Number(result.match(/大概需要(\d+)秒$/)![1]);
    expect(seconds).toBeGreaterThanOrEqual(9);
    expect(seconds).toBeLessThanOrEqual(18);

    // 不发奖励、不推进任务
    expect(parseJson(fixture.player.backpack, [])).toEqual([]);
    expect(fixture.taskService.advance).not.toHaveBeenCalled();

    // 写入「采集中」状态与「采集」锁定标记
    const markers = parseJson(fixture.player.markers, {});
    expect(markers['采集中']).toEqual(expect.objectContaining({ target: '医疗箱', cmd: '打开箱子' }));
    const markers2 = parseJson(fixture.player.markers2, []);
    // 等级10<15 走采集引怪豁免分支：玩家活跃（原版 L11427）先写"战斗"15秒标记，再写"采集"锁定标记
    expect(markers2).toEqual([
      expect.objectContaining({ name: '战斗' }),
      expect.objectContaining({ name: '采集' }),
    ]);
    expect(fixture.playerService.savePlayer).toHaveBeenCalled();
  });

  it('阶段2：延时结算发放产出、经验和“还可以采集N次”提示', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0); // 概率判定必成功
    const fixture = makeGatherFixture({
      name: '老树',
      times: 5,
      outputs: [{ name: '木头', quantity: 2, chance: 100 }],
      gatherCmd: '收集木头',
    });

    await fixture.service.handleGatherResource(42, '收集木头');
    const result = await fixture.service.settleGatherResource(42);

    expect(result).toContain('测试玩家收集到了木头×2');
    expect(result).toContain(',得到了');
    expect(result).toContain('经验');
    expect(result).toContain('测试地图的老树还可以采集4次');

    const backpack = parseJson(fixture.player.backpack, []);
    expect(backpack).toEqual([
      expect.objectContaining({ name: '木头', quantity: 2 }),
    ]);
    // 经验按原版公式：(等级/2+1)×次数×(1+加成%) = (10/2+1)×1 = 6
    expect(fixture.playerService.addExp).toHaveBeenCalledWith(42, 6);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '采集', 1);
    expect(fixture.chatService.broadcastSystem).toHaveBeenCalledWith(
      '世界频道', expect.stringContaining('收集到了'), 42,
    );

    // 结算后锁定标记应已移除
    const markers2 = parseJson(fixture.player.markers2, []);
    expect(markers2.find((m: any) => m.name === '采集')).toBeUndefined();

    // 地图资源剩余次数被扣减
    const resources = parseJson(fixture.map.resources, []);
    expect(resources[0].times).toBe(4);
  });

  it('阶段2：代发言非空时按原版排程 2 秒延时播报（原版 L1620-1621）', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0); // 概率判定必成功
    const fixture = makeGatherFixture({
      name: 'CELL数据中心',
      times: 5,
      outputs: [{ name: '能量块', quantity: 2, chance: 100 }],
      gatherCmd: '打开箱子',
      proxySpeak: '覅本清',
    });

    await fixture.service.handleGatherResource(42, '打开箱子');
    await fixture.service.settleGatherResource(42);

    // 排程 2 秒后的代发言内部指令（副本通关链入口）
    const row = fixture.delayedTaskRows.find((r: any) => r.type === 'proxySpeak');
    expect(row).toBeTruthy();
    expect(row.payload).toEqual({ command: '覅本清' });
    expect(row.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 2 * 1000);
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now() + 1000);
  });

  it('阶段1：采集中再次采集被「行动无限制」拦截（原版 正在采集，还需要N）', async () => {
    const fixture = makeGatherFixture({
      name: '医疗箱',
      times: -1,
      outputs: [{ name: '奶', quantity: 2, chance: 100 }],
      gatherCmd: '打开箱子',
    }, {
      markers2: [{ 名称: '采集', 有效期至: Date.now() / 1000 + 8 }],
    });
    fixture.combatSystem.actionUnrestricted.mockReturnValue({
      restricted: true,
      text: '测试玩家 采集中，还需要 8 秒',
    });

    const result = await fixture.service.handleGatherResource(42, '打开箱子');

    expect(result).toContain('还需要');
    expect(parseJson(fixture.player.backpack, [])).toEqual([]);
    expect(fixture.taskService.advance).not.toHaveBeenCalled();
  });

  it('阶段1：副本有怪物时提示先清除目标；自动采集模式禁止手动采集', async () => {
    const dungeon = makeGatherFixture({
      name: '副本箱',
      times: -1,
      outputs: [{ name: '奶', quantity: 1, chance: 100 }],
      gatherCmd: '打开箱子',
    }, { mapOverrides: { isInstance: true }, monsters: [{ id: 1 }] });
    expect(await dungeon.service.handleGatherResource(42, '打开箱子'))
      .toBe('测试玩家需要清除附近的目标');

    const autoMode = makeGatherFixture({
      name: '普通树',
      times: -1,
      outputs: [{ name: '木头', quantity: 1, chance: 100 }],
      gatherCmd: '收集木头',
    }, { markers: { 自动采集: 1 } });
    expect(await autoMode.service.handleGatherResource(42, '收集木头'))
      .toContain('自动采集模式下无法手动采集');
  });

  it('阶段2：跟随宠物数量计入实际采集次数（原版 召唤物跟随显示+奴役成就）', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const fixture = makeGatherFixture({
      name: '常驻树',
      // 原版负数次数=无限资源，|次数|=单次动作上限；此处给足余量验证宠物加成
      times: 10,
      outputs: [{ name: '木头', quantity: 1, chance: 100 }],
      gatherCmd: '收集木头',
    }, {
      summons: [
        // 跟随中的存活宠物（跟随熟练度<1）
        { ownerQQ: '42', hp: 50, markers: {} },
        // 非跟随状态（跟随=1）
        { ownerQQ: '42', hp: 50, markers: { '跟随': 1 } },
        // 别人的宠物
        { ownerQQ: '99', hp: 50, markers: {} },
      ],
    });

    await fixture.service.handleGatherResource(42, '收集木头');
    const result = await fixture.service.settleGatherResource(42);

    // 1只跟随宠物 → 实际采集2次
    expect(result).toContain('带着1只宠物一起收集到了木头×2');
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '奴役', 1);
  });

  it('阶段2：家园院子里带数字指令按额外次数放大耗时与采集量', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const fixture = makeGatherFixture({
      name: '院子果树',
      times: 99,
      outputs: [{ name: '果实', quantity: 1, chance: 100 }],
      gatherCmd: '摘果子',
      timeScale: 3,
    }, { mapOverrides: { name: '我的家' } });
    fixture.player.houseName = '我的家';

    const startText = await fixture.service.handleGatherResource(42, '摘果子3');

    // 耗时 = (3000~6000)×3×3/1000 = 27~54 秒
    const seconds = Number(startText.match(/大概需要(\d+)秒$/)![1]);
    expect(seconds).toBeGreaterThanOrEqual(27);
    expect(seconds).toBeLessThanOrEqual(54);

    const result = await fixture.service.settleGatherResource(42);
    expect(result).toContain('果实×3');
    const resources = parseJson(fixture.map.resources, []);
    expect(resources[0].times).toBe(96);
  });

  it('阶段2：同名多堆资源（开挖地基后2个土堆）可连续清完，清完一堆会提示还有下一堆', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const mound = () => ({
      name: '土堆',
      times: 20,
      outputs: [{ name: '钻石', quantity: 1, chance: 100 }],
      gatherCmd: '挖土',
      renewable: false,
      timeScale: 1,
    });
    // 开挖地基后院子里是 2 个独立的「土堆」资源条目（各 20 次）
    const multi = makeGatherFixture(mound(), {
      mapOverrides: { name: '我的家' },
    });
    multi.player.houseName = '我的家';
    multi.map.resources = JSON.stringify([mound(), mound()]);

    // 挖20：只清第一堆，结算文案必须提示「还有同名障碍」而不是装作清空了
    const realNow = Date.now;
    try {
      let now = realNow();
      jest.spyOn(Date, 'now').mockImplementation(() => now);

      await multi.service.handleGatherResource(42, '挖土20');
      const first = await multi.service.settleGatherResource(42);
      expect(first).toContain('这一堆土堆清完了');
      expect(first).toContain('不是没挖到');
      let piles = parseJson(multi.map.resources, []);
      expect(piles).toHaveLength(1);
      expect(piles[0].times).toBe(20);

      // 再挖20：第二堆也清掉（跨过 3 秒防重入窗口）
      now += 5000;
      await multi.service.handleGatherResource(42, '挖土20');
      const second = await multi.service.settleGatherResource(42);
      expect(second).not.toContain('这一堆土堆清完了');
      piles = parseJson(multi.map.resources, []);
      expect(piles).toHaveLength(0);

      // 一次「挖土40」应能把两堆合计 40 次都清掉（上限按同名合计）
      now += 5000;
      const all = makeGatherFixture(mound(), {
        mapOverrides: { name: '我的家' },
      });
      all.player.houseName = '我的家';
      all.map.resources = JSON.stringify([mound(), mound()]);
      await all.service.handleGatherResource(42, '挖土40');
      const clearAll = await all.service.settleGatherResource(42);
      expect(clearAll).toContain('钻石');
      expect(parseJson(all.map.resources, [])).toHaveLength(0);
    } finally {
      Date.now = realNow;
    }
  });

  it('超管特权：家园外带数字指令同样批量（普通玩家数字仍被忽略）', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const resource = {
      name: '老树',
      times: -1,
      outputs: [{ name: '木头', quantity: 1, chance: 100 }],
      gatherCmd: '收集木头',
      timeScale: 1,
    };

    // 超管：野外「收集木头5」→ 耗时×5、产出×5
    const admin = makeGatherFixture(resource, { role: 'SUPER_ADMIN' });
    const adminStart = await admin.service.handleGatherResource(42, '收集木头5');
    const adminSeconds = Number(adminStart.match(/大概需要(\d+)秒$/)![1]);
    expect(adminSeconds).toBeGreaterThanOrEqual(15);
    expect(adminSeconds).toBeLessThanOrEqual(30);
    const adminResult = await admin.service.settleGatherResource(42);
    expect(adminResult).toContain('木头×5');
    const adminMarkers = parseJson(admin.player.markers, {});
    expect(adminMarkers['采集中']).toBeUndefined(); // 已结算认领

    // 普通玩家：同指令数字被忽略（原版 L11383 家园限定），采 1 次
    const plain = makeGatherFixture(resource, { role: 'USER' });
    const plainStart = await plain.service.handleGatherResource(42, '收集木头5');
    const plainSeconds = Number(plainStart.match(/大概需要(\d+)秒$/)![1]);
    expect(plainSeconds).toBeGreaterThanOrEqual(3);
    expect(plainSeconds).toBeLessThanOrEqual(6);
    const plainResult = await plain.service.settleGatherResource(42);
    expect(plainResult).toContain('木头×1');
  });

  it('阶段2：资源在等待期间消失时作废本次动作', async () => {
    const fixture = makeGatherFixture({
      name: '一次性资源',
      times: -1,
      marker: '一次性资源标记',
      outputs: [{ name: '水晶', quantity: 1, chance: 100 }],
      gatherCmd: '采集一次性资源',
    });

    await fixture.service.handleGatherResource(42, '采集一次性资源');
    // 等待期间资源被刷新掉（resources 清空）
    fixture.map.resources = '[]';

    const result = await fixture.service.settleGatherResource(42);
    expect(result).toBe('');
    expect(parseJson(fixture.player.backpack, [])).toEqual([]);
    expect(fixture.playerService.addExp).not.toHaveBeenCalled();
    expect(fixture.taskService.advance).not.toHaveBeenCalledWith(42, '采集', expect.anything());
  });

  it('矿炮在手时限时上限30秒（原版 #矿炮 特殊序号-38）', async () => {
    const fixture = makeGatherFixture({
      name: '大矿山',
      times: -1,
      outputs: [{ name: '铁矿', quantity: 1, chance: 100 }],
      gatherCmd: '挖矿',
      timeScale: 20, // 无矿炮时 60~120 秒
    });
    fixture.player.currentWeapon = 1;
    fixture.player.weapons = JSON.stringify([{ name: '矿炮', specialSeq: -38 }]);

    const result = await fixture.service.handleGatherResource(42, '挖矿');
    const seconds = Number(result.match(/大概需要(\d+)秒$/)![1]);
    expect(seconds).toBe(30);
  });

  it('handleGatherResource 排程持久化延时任务，DelayedTaskService 到点分发结算恰好一次', async () => {
    const fixture = makeGatherFixture({
      name: '延时树',
      times: -1,
      outputs: [{ name: '木头', quantity: 1, chance: 100 }],
      gatherCmd: '收集木头',
    });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    // 注册采集分发 handler（生产由 GameService.onModuleInit 注册）
    fixture.delayedTaskService.registerHandler('gather', async (task: any) => {
      await fixture.service.settleGatherResource(Number(task.userId));
    });

    await fixture.service.handleGatherResource(42, '收集木头');
    // 阶段1 只排程：任务行已落库（跨重启存活），背包尚无产出
    expect(fixture.delayedTaskRows).toHaveLength(1);
    expect(fixture.delayedTaskRows[0].type).toBe('gather');
    expect(fixture.delayedTaskRows[0].userId).toBe(42);
    expect(parseJson(fixture.player.backpack, [])).toEqual([]);

    // 人为把 runAt 改到过去，模拟延时到期
    fixture.delayedTaskRows[0].runAt = new Date(Date.now() - 1000);
    const dispatched = await fixture.delayedTaskService.tick();
    expect(dispatched).toBe(1);
    expect(parseJson(fixture.player.backpack, [])).toEqual([
      expect.objectContaining({ name: '木头' }),
    ]);
    // 结算后「采集中」标记清除
    expect(parseJson(fixture.player.markers, {})['采集中']).toBeUndefined();

    // 任务行认领即删除：再次 tick 不会重复结算
    const secondTick = await fixture.delayedTaskService.tick();
    expect(secondTick).toBe(0);
    expect(parseJson(fixture.player.backpack, [])).toEqual([
      expect.objectContaining({ name: '木头', quantity: 1 }),
    ]);
  });

  it('服务重启后启动迁移把存量「采集中」标记补建为延时任务', async () => {
    const fixture = makeGatherFixture({
      name: '重启树',
      times: -1,
      outputs: [{ name: '木头', quantity: 1, chance: 100 }],
      gatherCmd: '收集木头',
    });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    fixture.delayedTaskService.registerHandler('gather', async (task: any) => {
      await fixture.service.settleGatherResource(Number(task.userId));
    });

    // 模拟旧实现/重启前遗留：markers 里有未结算的「采集中」，但任务行不存在
    fixture.player.markers = JSON.stringify({
      采集中: { target: '重启树', cmd: '收集木头', count: 1, startedAt: Date.now() - 60_000, settleAt: Date.now() - 1000 },
    });
    await (fixture.service as any).recoverOrphanDelayedMarkers();
    expect(fixture.delayedTaskRows).toHaveLength(1);

    // 迁移出的任务到点分发后正常结算
    await fixture.delayedTaskService.tick();
    expect(parseJson(fixture.player.backpack, [])).toEqual([
      expect.objectContaining({ name: '木头' }),
    ]);
  });

  it('采集冷却提示不推进采集任务', async () => {
    const taskService = {
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const handler = new GatherHandler(
      {
        handleGatherResource: jest.fn(async () => '【木头】还需要 299 秒才能再次采集'),
      } as any,
      taskService as any,
    );

    const result = await handler.handle({
      userId: 42,
      rawMessage: '收集木头',
      source: 'web',
    } as any);

    expect(result.success).toBe(false);
    expect(result.content).toContain('还需要');
    expect(taskService.advance).not.toHaveBeenCalled();
  });

  it('名称末尾数量编码：解析出物品名+数量，概率统一走 chance', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const fixture = makeGatherFixture({
      name: '旧箱子',
      times: 1,
      outputs: JSON.stringify([{ name: '木头3', chance: 100 }]),
      gatherCmd: '打开旧箱子',
    });

    await fixture.service.handleGatherResource(42, '打开旧箱子');
    const result = await fixture.service.settleGatherResource(42);
    const backpack = parseJson(fixture.player.backpack, []);

    expect(result).toContain('木头×3');
    expect(backpack).toEqual([expect.objectContaining({ name: '木头', quantity: 3 })]);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '采集', 1);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '打开旧箱子', 1);
    // 采集开始时玩家活跃（原版 L11427，等级10<15 走豁免分支仍执行）刷新地图"活动"窗口；
    // 结算枯竭后登记 1800 秒刷新标记
    expect(parseJson(fixture.map.markers2, [])).toEqual([
      expect.objectContaining({ name: '活动' }),
      expect.objectContaining({ name: '刷新资源旧箱子' }),
    ]);
  });

  it('数组形式产出：按名称末尾数量发放，概率只认 chance', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const fixture = makeGatherFixture({
      name: '数组旧箱子',
      times: -1,
      outputs: [{ name: '石头2', chance: 100 }],
      gatherCmd: '打开数组旧箱子',
    });

    await fixture.service.handleGatherResource(42, '打开数组旧箱子');
    const result = await fixture.service.settleGatherResource(42);

    expect(result).toContain('石头×2');
    expect(parseJson(fixture.player.backpack, [])).toEqual([
      expect.objectContaining({ name: '石头', quantity: 2 }),
    ]);
  });

  it('装备品质后缀和负数产出按原版分别生成装备、获得绝对数量', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const fixture = makeGatherFixture({
      name: '集装箱',
      times: -1,
      outputs: [
        { name: '寒风s', quantity: 0, chance: 100 },
        { name: '工业建筑箱-3', quantity: 0, chance: 100 },
      ],
      gatherCmd: '打开集装箱',
    }, { equipmentNames: ['寒风'] });

    await fixture.service.handleGatherResource(42, '打开集装箱');
    await fixture.service.settleGatherResource(42);
    const backpack = parseJson(fixture.player.backpack, []);

    expect(fixture.itemSystemService.generateRewardEquipment).toHaveBeenCalledWith('寒风', 's');
    expect(backpack).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '寒风', type: '装备' }),
      expect.objectContaining({ name: '工业建筑箱', quantity: 3 }),
    ]));
  });

  it('休眠仓首次采集在结算时触发召唤白剧情', async () => {
    const fixture = makeGatherFixture({
      name: '休眠仓',
      times: -1,
      proxySpeak: '召唤1白1',
      outputs: [{ name: '增幅器s', quantity: 0, chance: 100 }],
      gatherCmd: '打开休眠仓',
    }, { equipmentNames: ['增幅器'] });

    const startText = await fixture.service.handleGatherResource(42, '打开休眠仓');
    // 阶段1 只回复耗时，不出剧情文本
    expect(startText).toContain('大概需要');

    const result = await fixture.service.settleGatherResource(42);
    expect(result).toContain('这里是哪里？');
    expect(fixture.taskService.acceptTask).toHaveBeenCalledWith(42, '主线-身世');
    const markers = parseJson(fixture.player.markers, {});
    expect(markers['召唤白']).toBe(1);
    // 原版 L9780-9796：白作为真实召唤物加入当前地图（归属玩家、初始好感30）。
    // 走 mutateSummons 闭环（stub 会把 summons 同步回 fixture.map），不再直写 gameMap.update。
    const summons = parseJson(fixture.map.summons, []);
    const white = summons.find((s: any) => (s.name ?? s.名称) === '白');
    expect(white).toBeTruthy();
    expect(white.type).toBe('白');
    expect(white.markers['好感42']).toBe(30);
  });

  // ===== 采集引怪（原版 _主程序.ecode L11415-11426：开始采集时四豁免判断）=====

  it('采集引怪：等级≥15且无豁免时，开始采集即拉起5秒怪物回合', async () => {
    const fixture = makeGatherFixture({
      name: '老树',
      times: 5,
      outputs: [{ name: '木头', quantity: 2, chance: 100 }],
      gatherCmd: '收集木头',
    });
    fixture.player.level = 20;

    await fixture.service.handleGatherResource(42, '收集木头');

    expect(fixture.combatSystem.triggerMapBattleLoop).toHaveBeenCalledWith(
      42, 5, { player: fixture.player, map: fixture.map },
    );
  });

  it('采集引怪：等级<15豁免，不排怪物回合但玩家活跃照常', async () => {
    const fixture = makeGatherFixture({
      name: '老树',
      times: 5,
      outputs: [{ name: '木头', quantity: 2, chance: 100 }],
      gatherCmd: '收集木头',
    });
    // 夹具默认等级10，<15 豁免

    await fixture.service.handleGatherResource(42, '收集木头');

    expect(fixture.combatSystem.triggerMapBattleLoop).not.toHaveBeenCalled();
    // 玩家活跃（原版 L11427）："战斗"15秒挂玩家标记2、"活动"120秒刷新地图标记2；
    // 随后照常写"采集"锁定标记
    expect(parseJson(fixture.player.markers2, [])).toEqual([
      expect.objectContaining({ name: '战斗' }),
      expect.objectContaining({ name: '采集' }),
    ]);
    expect(parseJson(fixture.map.markers2, [])).toEqual(
      [expect.objectContaining({ name: '活动' })],
    );
  });

  it('采集引怪：隐形披风/隐匿模式/四糸乃豁免，不排怪物回合', async () => {
    const resource = {
      name: '老树',
      times: 5,
      outputs: [{ name: '木头', quantity: 2, chance: 100 }],
      gatherCmd: '收集木头',
    };
    const cases: Array<(player: any) => void> = [
      (player) => { player.equipment = JSON.stringify([{ 名称: '隐形披风', 特殊序号: 26 }]); },
      (player) => { player.buffs = JSON.stringify([{ name: '隐匿模式', expireAt: Date.now() + 60_000 }]); },
      (player) => { player.specialSeq = 15; },
    ];
    for (const exempt of cases) {
      const fixture = makeGatherFixture(resource);
      fixture.player.level = 20;
      exempt(fixture.player);
      fixture.combatSystem.triggerMapBattleLoop.mockClear();

      await fixture.service.handleGatherResource(42, '收集木头');

      expect(fixture.combatSystem.triggerMapBattleLoop).not.toHaveBeenCalled();
      // 豁免分支玩家活跃照常（原版 L11427 判断块之外无条件执行），随后照常写"采集"锁定标记
      expect(parseJson(fixture.player.markers2, [])).toEqual([
        expect.objectContaining({ name: '战斗' }),
        expect.objectContaining({ name: '采集' }),
      ]);
    }
  });
});
