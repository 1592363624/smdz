import { GatherHandler } from '../src/modules/command/handlers/gather.handler';
import { GameService } from '../src/modules/game/game.service';

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
  };
  const prisma = {
    player: {
      // settlePendingGathers 兜底扫描用：返回该玩家的实时 markers
      findMany: jest.fn(async () => [
        { userId: player.userId, id: player.id ?? 1, markers: player.markers },
      ]),
    },
    gameMap: {
      update: jest.fn(async ({ data }: any) => {
        Object.assign(map, data);
        return map;
      }),
    },
  };
  const playerService = {
    getPlayerData: jest.fn(async () => ({
      player,
      // 对齐真实 getPlayerData：weapons 从 player.weapons JSON 解析
      weapons: (() => {
        try { return JSON.parse(player.weapons || '[]'); } catch { return []; }
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
        return JSON.parse(currentPlayer.backpack || '[]');
      } catch {
        return [];
      }
    }),
    savePlayer: jest.fn(async () => undefined),
    addExp: jest.fn(async () => ({ leveledUp: false, newLevel: 10 })),
    isPlayerDead: jest.fn((p: any) => Number(p?.hp ?? 1) <= 0),
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
  };
  const chatService = {
    broadcastSystem: jest.fn(async () => undefined),
    emitToUser: jest.fn(async () => undefined),
  };
  const service: any = Object.create(GameService.prototype);
  Object.assign(service, {
    prisma,
    playerService,
    mapService: {
      getMapById: jest.fn(async () => map),
      getMapMonsters: jest.fn(async () => options.monsters || []),
    },
    combatSystem,
    combatState: {
      addMarker: jest.fn((名称: string, 时间: number, 标记: any[], 现行时间: number) => {
        if (时间 === 0) return;
        标记.push({ 名称, 有效期至: 现行时间 + 时间 * 1000 });
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
  return { service, player, map, taskService, prisma, itemSystemService, chatService, playerService, combatSystem };
}

describe('手动采集两阶段流程（对齐原版采集耗时机制）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('阶段1：回复预计耗时不发奖励，并写入采集中状态+采集锁定标记', async () => {
    const fixture = makeGatherFixture({
      name: '医疗箱',
      times: -1,
      outputs: [{ name: '奶', count: 2, chance: 100 }],
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
    expect(JSON.parse(fixture.player.backpack)).toEqual([]);
    expect(fixture.taskService.advance).not.toHaveBeenCalled();

    // 写入「采集中」状态与「采集」锁定标记
    const markers = JSON.parse(fixture.player.markers);
    expect(markers['采集中']).toEqual(expect.objectContaining({ target: '医疗箱', cmd: '打开箱子' }));
    const markers2 = JSON.parse(fixture.player.markers2);
    expect(markers2).toEqual([expect.objectContaining({ 名称: '采集' })]);
    expect(fixture.playerService.savePlayer).toHaveBeenCalled();
  });

  it('阶段2：延时结算发放产出、经验和“还可以采集N次”提示', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0); // 概率判定必成功
    const fixture = makeGatherFixture({
      name: '老树',
      times: 5,
      outputs: [{ name: '木头', count: 2, chance: 100 }],
      gatherCmd: '收集木头',
    });

    await fixture.service.handleGatherResource(42, '收集木头');
    const result = await fixture.service.settleGatherResource(42);

    expect(result).toContain('测试玩家收集到了木头×2');
    expect(result).toContain(',得到了');
    expect(result).toContain('经验');
    expect(result).toContain('测试地图的老树还可以采集4次');

    const backpack = JSON.parse(fixture.player.backpack);
    expect(backpack).toEqual([
      expect.objectContaining({ name: '木头', count: 2, quantity: 2 }),
    ]);
    // 经验按原版公式：(等级/2+1)×次数×(1+加成%) = (10/2+1)×1 = 6
    expect(fixture.playerService.addExp).toHaveBeenCalledWith(42, 6);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '采集', 1);
    expect(fixture.chatService.broadcastSystem).toHaveBeenCalledWith(
      '世界频道', expect.stringContaining('收集到了'), 42,
    );

    // 结算后锁定标记应已移除
    const markers2 = JSON.parse(fixture.player.markers2);
    expect(markers2.find((m: any) => m.名称 === '采集')).toBeUndefined();

    // 地图资源剩余次数被扣减
    const resources = JSON.parse(fixture.map.resources);
    expect(resources[0].times).toBe(4);
  });

  it('阶段1：采集中再次采集被「行动无限制」拦截（原版 正在采集，还需要N）', async () => {
    const fixture = makeGatherFixture({
      name: '医疗箱',
      times: -1,
      outputs: [{ name: '奶', count: 2, chance: 100 }],
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
    expect(JSON.parse(fixture.player.backpack)).toEqual([]);
    expect(fixture.taskService.advance).not.toHaveBeenCalled();
  });

  it('阶段1：副本有怪物时提示先清除目标；自动采集模式禁止手动采集', async () => {
    const dungeon = makeGatherFixture({
      name: '副本箱',
      times: -1,
      outputs: [{ name: '奶', count: 1, chance: 100 }],
      gatherCmd: '打开箱子',
    }, { mapOverrides: { isInstance: true }, monsters: [{ id: 1 }] });
    expect(await dungeon.service.handleGatherResource(42, '打开箱子'))
      .toBe('测试玩家需要清除附近的目标');

    const autoMode = makeGatherFixture({
      name: '普通树',
      times: -1,
      outputs: [{ name: '木头', count: 1, chance: 100 }],
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
      outputs: [{ name: '木头', count: 1, chance: 100 }],
      gatherCmd: '收集木头',
    }, {
      summons: [
        // 跟随中的存活宠物（跟随熟练度<1）
        { ownerQQ: '42', hp: 50, 标记: {} },
        // 非跟随状态（跟随=1）
        { ownerQQ: '42', hp: 50, 标记: { '跟随': 1 } },
        // 别人的宠物
        { ownerQQ: '99', hp: 50, 标记: {} },
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
      outputs: [{ name: '果实', count: 1, chance: 100 }],
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
    const resources = JSON.parse(fixture.map.resources);
    expect(resources[0].times).toBe(96);
  });

  it('阶段2：资源在等待期间消失时作废本次动作', async () => {
    const fixture = makeGatherFixture({
      name: '一次性资源',
      times: -1,
      marker: '一次性资源标记',
      outputs: [{ name: '水晶', count: 1, chance: 100 }],
      gatherCmd: '采集一次性资源',
    });

    await fixture.service.handleGatherResource(42, '采集一次性资源');
    // 等待期间资源被刷新掉（resources 清空）
    fixture.map.resources = '[]';

    const result = await fixture.service.settleGatherResource(42);
    expect(result).toBe('');
    expect(JSON.parse(fixture.player.backpack)).toEqual([]);
    expect(fixture.playerService.addExp).not.toHaveBeenCalled();
    expect(fixture.taskService.advance).not.toHaveBeenCalledWith(42, '采集', expect.anything());
  });

  it('矿炮在手时限时上限30秒（原版 #矿炮 特殊序号-38）', async () => {
    const fixture = makeGatherFixture({
      name: '大矿山',
      times: -1,
      outputs: [{ name: '铁矿', count: 1, chance: 100 }],
      gatherCmd: '挖矿',
      timeScale: 20, // 无矿炮时 60~120 秒
    });
    fixture.player.currentWeapon = 1;
    fixture.player.weapons = JSON.stringify([{ name: '矿炮', specialSeq: -38 }]);

    const result = await fixture.service.handleGatherResource(42, '挖矿');
    const seconds = Number(result.match(/大概需要(\d+)秒$/)![1]);
    expect(seconds).toBe(30);
  });

  it('settlePendingGathers：到期补结算、未到期恢复定时器', async () => {
    const dueFixture = makeGatherFixture({
      name: '到期树',
      times: -1,
      outputs: [{ name: '木头', count: 1, chance: 100 }],
      gatherCmd: '收集木头',
    });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await dueFixture.service.handleGatherResource(42, '收集木头');
    // 人为把 settleAt 改到过去，模拟重启丢失定时器后已到期
    const markers = JSON.parse(dueFixture.player.markers);
    markers['采集中'].settleAt = Date.now() - 1000;
    dueFixture.player.markers = JSON.stringify(markers);

    const settled = await dueFixture.service.settlePendingGathers();
    expect(settled).toBe(1);
    expect(JSON.parse(dueFixture.player.backpack)).toEqual([
      expect.objectContaining({ name: '木头' }),
    ]);

    // 未到期的采集不应被提前结算
    const pendingFixture = makeGatherFixture({
      name: '未到期树',
      times: -1,
      outputs: [{ name: '木头', count: 1, chance: 100 }],
      gatherCmd: '收集木头',
    });
    await pendingFixture.service.handleGatherResource(42, '收集木头');
    const settledPending = await pendingFixture.service.settlePendingGathers();
    expect(settledPending).toBe(0);
    expect(JSON.parse(pendingFixture.player.backpack)).toEqual([]);
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

  it('兼容旧 JSON：名称末尾数量、count 字段作为概率', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const fixture = makeGatherFixture({
      name: '旧箱子',
      times: 1,
      outputs: JSON.stringify([{ name: '木头3', count: 100 }]),
      gatherCmd: '打开旧箱子',
    });

    await fixture.service.handleGatherResource(42, '打开旧箱子');
    const result = await fixture.service.settleGatherResource(42);
    const backpack = JSON.parse(fixture.player.backpack);

    expect(result).toContain('木头×3');
    expect(backpack).toEqual([expect.objectContaining({ name: '木头', count: 3, quantity: 3 })]);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '采集', 1);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '打开旧箱子', 1);
    expect(JSON.parse(fixture.map.markers2)).toEqual([
      expect.objectContaining({ name: '刷新资源旧箱子' }),
    ]);
  });

  it('兼容数组形式旧 JSON，并按名称末尾数量发放', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const fixture = makeGatherFixture({
      name: '数组旧箱子',
      times: -1,
      outputs: [{ name: '石头2', count: 100 }],
      gatherCmd: '打开数组旧箱子',
    });

    await fixture.service.handleGatherResource(42, '打开数组旧箱子');
    const result = await fixture.service.settleGatherResource(42);

    expect(result).toContain('石头×2');
    expect(JSON.parse(fixture.player.backpack)).toEqual([
      expect.objectContaining({ name: '石头', count: 2, quantity: 2 }),
    ]);
  });

  it('装备品质后缀和负数产出按原版分别生成装备、获得绝对数量', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const fixture = makeGatherFixture({
      name: '集装箱',
      times: -1,
      outputs: [
        { name: '寒风s', count: 0, chance: 100 },
        { name: '工业建筑箱-3', count: 0, chance: 100 },
      ],
      gatherCmd: '打开集装箱',
    }, { equipmentNames: ['寒风'] });

    await fixture.service.handleGatherResource(42, '打开集装箱');
    await fixture.service.settleGatherResource(42);
    const backpack = JSON.parse(fixture.player.backpack);

    expect(fixture.itemSystemService.generateRewardEquipment).toHaveBeenCalledWith('寒风', 's');
    expect(backpack).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '寒风', type: '装备' }),
      expect.objectContaining({ name: '工业建筑箱', count: 3, quantity: 3 }),
    ]));
  });

  it('休眠仓首次采集在结算时触发召唤白剧情', async () => {
    const fixture = makeGatherFixture({
      name: '休眠仓',
      times: -1,
      proxySpeak: '召唤1白1',
      outputs: [{ name: '增幅器s', count: 0, chance: 100 }],
      gatherCmd: '打开休眠仓',
    }, { equipmentNames: ['增幅器'] });

    const startText = await fixture.service.handleGatherResource(42, '打开休眠仓');
    // 阶段1 只回复耗时，不出剧情文本
    expect(startText).toContain('大概需要');

    const result = await fixture.service.settleGatherResource(42);
    expect(result).toContain('这里是哪里？');
    expect(fixture.taskService.acceptTask).toHaveBeenCalledWith(42, '主线-身世');
    const markers = JSON.parse(fixture.player.markers);
    expect(markers['召唤白']).toBe(1);
  });
});
