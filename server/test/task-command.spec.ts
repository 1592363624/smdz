import { GameCommandHandler } from '../src/modules/command/handlers/game-command.handler';
import { CommandService } from '../src/modules/command/command.service';

describe('任务相关制造入口', () => {
  it('制造床2按配方名和数量执行，并按实际数量推进任务', async () => {
    const taskService: any = {
      ensureTutorialTasks: jest.fn(async () => []),
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const itemSystem = {
      craftItem: jest.fn(async (_userId: number, recipeName: string, count: number) =>
        `冒险者用材料制造了${count}个${recipeName}，得到了${recipeName}×${count}`),
    };
    const handler = new GameCommandHandler(
      {} as any,
      {} as any,
      itemSystem as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      taskService as any,
    );

    const result = await handler.handle({
      userId: 42,
      rawMessage: '制造 床2',
      source: 'web',
    } as any, ['床2']);

    expect(result.success).toBe(true);
    expect(itemSystem.craftItem).toHaveBeenCalledWith(42, '床', 2);
    expect(taskService.advance).toHaveBeenCalledWith(42, '制造', 2);
    expect(taskService.advance).toHaveBeenCalledWith(42, '制造床', 2);
  });

  it('基础handler执行的查看背包也推进发送类任务', async () => {
    const taskService = {
      ensureTutorialTasks: jest.fn(async () => []),
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const inventoryHandler = {
      handle: jest.fn(async () => ({
        success: true,
        content: '背包内容',
        broadcast: false,
        durationMs: 0,
      })),
    };
    const commandDef = { name: '背包', alias: '查看背包', handlerKey: 'inventory', enabled: true };
    const prisma = {
      command: {
        findFirst: jest.fn(async ({ where }: any) =>
          where?.name?.equals === '背包' ? commandDef : null),
        findMany: jest.fn(async () => [commandDef]),
      },
      commandLog: { create: jest.fn(async () => ({})) },
    };
    const gameService = {
      getFirstFamiliarGate: jest.fn(async () => null),
      calculateTimeElapsed: jest.fn(async () => ''),
      triggerAutoFamiliarSkill: jest.fn(async () => ''),
      pushPlayerUpdate: jest.fn(async () => undefined),
      pushMapUpdate: jest.fn(async () => undefined),
    };
    const service = new CommandService(
      prisma as any,
      { inventory: inventoryHandler } as any,
      gameService as any,
      { takePendingLevelUpText: () => '' } as any,
      taskService as any,
    );

    const result = await service.dispatch({
      userId: 42,
      rawMessage: '查看背包',
      source: 'web',
    } as any);

    expect(result.success).toBe(true);
    expect(taskService.ensureTutorialTasks).toHaveBeenCalledWith(42);
    expect(taskService.advance).toHaveBeenCalledWith(42, '发送“查看背包”');
    expect(taskService.advance).toHaveBeenCalledWith(42, '发送指令');
  });

  it('紧凑输入强化头部10走装备部位强化，并按次数推进任务', async () => {
    const taskService = {
      ensureTutorialTasks: jest.fn(async () => []),
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const gameService = {
      handleEquipEnhance: jest.fn(async () => '冒险者用合金强化了头部10次，升到了10级'),
    };
    const handler = new GameCommandHandler(
      gameService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      taskService as any,
    );

    const result = await handler.handle({
      userId: 42,
      rawMessage: '强化 头部10',
      source: 'web',
    } as any, ['头部10']);

    expect(result.success).toBe(true);
    expect(gameService.handleEquipEnhance).toHaveBeenCalledWith(42, '头部10');
    expect(taskService.advance).toHaveBeenCalledWith(42, '强化装备', 10);
    expect(taskService.advance).toHaveBeenCalledWith(42, '强化头部', 10);
  });

  it('装备1按背包序号装备实际物品，并推进对应武器任务', async () => {
    const taskService = {
      ensureTutorialTasks: jest.fn(async () => []),
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const playerData = {
      backpack: [
        { name: '石斧', type: '装备', data: 'e' },
        { name: '面包', type: '消耗品', quantity: 1 },
      ],
    };
    const gameService = {
      handleEquip: jest.fn(async () => '冒险者装备了石斧'),
    };
    const playerService = {
      getPlayerData: jest.fn(async () => playerData),
    };
    const itemSystem = {
      isWeaponItem: jest.fn(() => true),
    };
    const tutorialService = {
      getTutorial: jest.fn(() => ''),
    };
    const handler = new GameCommandHandler(
      gameService as any,
      {} as any,
      itemSystem as any,
      {} as any,
      {} as any,
      playerService as any,
      tutorialService as any,
      {} as any,
      {} as any,
      taskService as any,
    );

    const result = await handler.handle({
      userId: 42,
      rawMessage: '装备 1',
      source: 'web',
    } as any, ['1']);

    expect(result.success).toBe(true);
    expect(gameService.handleEquip).toHaveBeenCalledWith(42, '1');
    expect(taskService.advance).toHaveBeenCalledWith(42, '使用武器');
    expect(taskService.advance).toHaveBeenCalledWith(42, '装备石斧');
    expect(taskService.advance).not.toHaveBeenCalledWith(42, '装备1');
  });

  it('使用物品同时推进通用使用物品和具体物品任务', async () => {
    const taskService = {
      ensureTutorialTasks: jest.fn(async () => []),
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const gameService = {
      handleUseItem: jest.fn(async () => '冒险者使用了2个种子箱'),
    };
    const handler = new GameCommandHandler(
      gameService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      taskService as any,
    );

    const result = await handler.handle({
      userId: 42,
      rawMessage: '使用 种子箱2',
      source: 'web',
    } as any, ['种子箱2']);

    expect(result.success).toBe(true);
    expect(gameService.handleUseItem).toHaveBeenCalledWith(42, '种子箱', 2);
    expect(taskService.advance).toHaveBeenCalledWith(42, '使用物品', 2);
    expect(taskService.advance).toHaveBeenCalledWith(42, '使用种子箱', 2);
  });

  it('对话列表展示不推进对话任务，指定NPC才推进通用和具体任务', async () => {
    const taskService = {
      ensureTutorialTasks: jest.fn(async () => []),
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const gameService = {
      handleTalk: jest.fn(async (userId: number, npcName: string) =>
        npcName ? '【史莱姆】你好' : '可对话NPC列表'),
      handleDialogueLuna: jest.fn(async () => '露娜'),
    };
    const handler = new GameCommandHandler(
      gameService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      taskService as any,
    );

    await handler.handle({ userId: 42, rawMessage: '对话', source: 'web' } as any, []);
    expect(taskService.advance).not.toHaveBeenCalled();

    await handler.handle({ userId: 42, rawMessage: '对话 史莱姆', source: 'web' } as any, ['史莱姆']);
    expect(taskService.advance).toHaveBeenNthCalledWith(1, 42, '对话');
    expect(taskService.advance).toHaveBeenNthCalledWith(2, 42, '对话史莱姆');
  });

  it('普通求助只展示露娜提示，不直接推进求助任务；确认入口由服务处理', async () => {
    const taskService = {
      ensureTutorialTasks: jest.fn(async () => []),
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const gameService = {
      handleHelpMe: jest.fn(async () => '【露娜】\n有解决不了的麻烦需要我帮忙的吗？'),
    };
    const handler = new GameCommandHandler(
      gameService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      taskService as any,
    );

    const result = await handler.handle({ userId: 42, rawMessage: '求助', source: 'web' } as any, []);

    expect(result.content).toContain('露娜');
    expect(taskService.advance).not.toHaveBeenCalled();
  });

  it('飞到使用独立飞行入口，展示目的地时不推进任务', async () => {
    const taskService = {
      ensureTutorialTasks: jest.fn(async () => []),
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const gameService = {
      handleFlyTo: jest.fn(async (_userId: number, target: string) =>
        target ? '冒险者飞了起来……' : '请选择地点:'),
    };
    const handler = new GameCommandHandler(
      gameService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      taskService as any,
    );

    await handler.handle({ userId: 42, rawMessage: '飞到', source: 'web' } as any, []);
    expect(taskService.advance).not.toHaveBeenCalled();

    await handler.handle({ userId: 42, rawMessage: '飞到 森林出口', source: 'web' } as any, ['森林出口']);
    expect(gameService.handleFlyTo).toHaveBeenCalledWith(42, '森林出口');
    expect(taskService.advance).toHaveBeenCalledWith(42, '飞行', 1);
  });
});

describe('任务相关移动入口', () => {
  it('飞到作为独立指令分发，不会被移动别名吞掉', async () => {
    const handler = {
      handle: jest.fn(async () => ({
        success: true,
        content: '冒险者飞了起来……',
        broadcast: true,
        durationMs: 0,
      })),
    };
    const taskService = {
      ensureTutorialTasks: jest.fn(async () => []),
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const gameService = {
      getFirstFamiliarGate: jest.fn(async () => null),
      calculateTimeElapsed: jest.fn(async () => ''),
      triggerAutoFamiliarSkill: jest.fn(async () => ''),
      pushPlayerUpdate: jest.fn(async () => undefined),
      pushMapUpdate: jest.fn(async () => undefined),
    };
    const commandDef = { name: '飞到', alias: 'fly', handlerKey: 'game', enabled: true };
    const prisma = {
      command: {
        findFirst: jest.fn(async ({ where }: any) =>
          where?.name?.equals === '飞到' ? commandDef : null),
        findMany: jest.fn(async () => [commandDef]),
      },
      commandLog: { create: jest.fn(async () => ({})) },
    };
    const service = new CommandService(
      prisma as any,
      { game: handler } as any,
      gameService as any,
      { takePendingLevelUpText: () => '' } as any,
      taskService as any,
    );

    const result = await service.dispatch({
      userId: 42,
      rawMessage: '飞到 目标地图',
      source: 'web',
    } as any);

    expect(result.success).toBe(true);
    expect(handler.handle).toHaveBeenCalledWith(
      expect.objectContaining({ rawMessage: '飞到 目标地图' }),
      ['目标地图'],
    );
    expect(taskService.advance).toHaveBeenCalledWith(42, '发送“飞到 目标地图”');
  });
});

describe('家园安装/拆卸快捷入口任务推进', () => {
  function makeHandler(gameService: any, taskService: any): GameCommandHandler {
    return new GameCommandHandler(
      gameService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      taskService,
    );
  }

  function makeTaskService(): any {
    return {
      ensureTutorialTasks: jest.fn(async () => []),
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
  }

  it('家园紧凑安装按服务实际数量推进通用和具体安装任务', async () => {
    const taskService = makeTaskService();
    const gameService = {
      handleInstall: jest.fn(async () => '把1个基础发电机放到了测试家园'),
    };
    const handler = makeHandler(gameService, taskService);

    const result = await handler.handle({
      userId: 42,
      rawMessage: '家园 安装基础发电机2',
      source: 'web',
    } as any, ['安装基础发电机2']);

    expect(result.success).toBe(true);
    expect(gameService.handleInstall).toHaveBeenCalledWith(42, '基础发电机2');
    expect(taskService.advance).toHaveBeenCalledWith(42, '安装', 1);
    expect(taskService.advance).toHaveBeenCalledWith(42, '安装基础发电机', 1);
  });

  it('家园紧凑拆卸按服务实际数量推进通用和具体拆卸任务', async () => {
    const taskService = makeTaskService();
    const gameService = {
      handleUninstallPart: jest.fn(async () => '成功从载具【测试车】拆卸了【轮胎】×2(行走)'),
    };
    const handler = makeHandler(gameService, taskService);

    const result = await handler.handle({
      userId: 42,
      rawMessage: '家园 拆卸轮胎3',
      source: 'web',
    } as any, ['拆卸轮胎3']);

    expect(result.success).toBe(true);
    expect(gameService.handleUninstallPart).toHaveBeenCalledWith(42, '轮胎', 3);
    expect(taskService.advance).toHaveBeenCalledWith(42, '拆卸部件', 2);
    expect(taskService.advance).toHaveBeenCalledWith(42, '拆卸轮胎', 2);
  });

  it('家园安装失败时不推进任何安装任务', async () => {
    const taskService = makeTaskService();
    const gameService = {
      handleInstall: jest.fn(async () => '背包中没有【基础发电机】'),
    };
    const handler = makeHandler(gameService, taskService);

    const result = await handler.handle({
      userId: 42,
      rawMessage: '家园 安装基础发电机2',
      source: 'web',
    } as any, ['安装基础发电机2']);

    expect(result.success).toBe(false);
    expect(taskService.advance).not.toHaveBeenCalled();
  });
});

describe('原版任务动作收尾', () => {
  function makeHandler() {
    const taskService: any = {
      ensureTutorialTasks: jest.fn(async () => []),
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const gameService = {
      handleAlchemy: jest.fn(async () => '冒险者炼制出了2个觉醒丹'),
      handleMerge: jest.fn(async () => '融合成功'),
      handleDialogueYongxing: jest.fn(async () => '咏星愿意跟随你了！'),
      handleSummonCargo: jest.fn(async () => '召唤货舱成功！'),
      handleSimulateVehicle: jest.fn(async () => '载具模拟完成'),
      handleRepairVehicle: jest.fn(async () => '维修成功'),
      handleExitVehicle: jest.fn(async () => '冒险者离开了载具'),
      handleCallVehicle: jest.fn(async (_userId: number, name: string) =>
        name === '行商' ? '行商来到了院子里' : '宠物来到了当前地图'),
      familiarChallengeNextLayer: jest.fn(async () => '准备挑战第2层'),
    };
    const combatSystem = {
      cannonAttack: jest.fn(async () => '远程炮击造成12点伤害'),
    };
    const familiarSystem = {
      // 捕捉服务在成功落库后负责自己的“捕捉/捕捉目标”任务推进。
      capturePet: jest.fn(async (_userId: number, _mode: string, target: string) => {
        await taskService.advance(42, '捕捉');
        if (target) await taskService.advance(42, '捕捉' + target);
        return '成功捕捉了史莱姆';
      }),
      petAwaken: jest.fn(async () => '消耗2颗觉醒丹让史莱姆觉醒了2次'),
    };
    const handler = new GameCommandHandler(
      gameService as any,
      combatSystem as any,
      {} as any,
      familiarSystem as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      taskService as any,
    );
    return { handler, taskService, gameService, combatSystem, familiarSystem };
  }

  it('补齐原版动作并只在业务成功后推进任务', async () => {
    const fixture = makeHandler();
    const ctx = (rawMessage: string) => ({ userId: 42, rawMessage, source: 'web' } as any);

    await fixture.handler.handle(ctx('炮击 目标谷'), ['目标谷']);
    await fixture.handler.handle(ctx('捕捉 史莱姆'), ['史莱姆']);
    await fixture.handler.handle(ctx('炼丹 觉醒丹 2'), ['觉醒丹', '2']);
    await fixture.handler.handle(ctx('融合 装备'), ['装备']);
    await fixture.handler.handle(ctx('对话咏星跟随'), []);
    await fixture.handler.handle(ctx('召唤货舱'), []);
    await fixture.handler.handle(ctx('载具模拟 部件'), ['部件']);
    await fixture.handler.handle(ctx('维修'), []);
    await fixture.handler.handle(ctx('脱出'), []);
    await fixture.handler.handle(ctx('呼叫 行商'), ['行商']);
    await fixture.handler.handle(ctx('覅下一层'), []);
    await fixture.handler.handle(ctx('宠物觉醒 史莱姆 2'), ['史莱姆', '2']);

    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '炮击');
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '捕捉');
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '捕捉史莱姆');
    expect(fixture.taskService.advance.mock.calls.filter((call: any[]) => call[1] === '捕捉')).toHaveLength(1);
    expect(fixture.taskService.advance.mock.calls.filter((call: any[]) => call[1] === '捕捉史莱姆')).toHaveLength(1);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '炼丹', 2);
    expect(fixture.taskService.advance).not.toHaveBeenCalledWith(42, '制造', 2);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '融合');
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '拐妹子');
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '召唤货舱');
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '载具模拟');
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '维修载具');
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '脱出');
    // 行商的“呼叫行商/呼叫”由 GameService 按真实行商等级推进；
    // handler 层 mock 不应伪造服务内部的等级副作用。
    expect(fixture.taskService.advance).not.toHaveBeenCalledWith(42, '呼叫行商');
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '挑战等级');
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '觉醒宠物', 2);
  });

  it('炮击失败和捕捉失败不消耗任务次数', async () => {
    const fixture = makeHandler();
    fixture.combatSystem.cannonAttack.mockResolvedValue('当前地图没有目标');
    fixture.familiarSystem.capturePet.mockResolvedValue('附近没有史莱姆');

    await fixture.handler.handle({ userId: 42, rawMessage: '炮击', source: 'web' } as any, []);
    await fixture.handler.handle({ userId: 42, rawMessage: '捕捉 史莱姆', source: 'web' } as any, ['史莱姆']);

    expect(fixture.taskService.advance).not.toHaveBeenCalled();
  });
});

describe('载具任务动作收尾', () => {
  function makeHandler() {
    const taskService: any = {
      ensureTutorialTasks: jest.fn(async () => []),
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const gameService: any = {
      handleAssembleVehicle: jest.fn(async () => '✅ 成功将【轻型足】×2安装到载具【白天鹅】上'),
      handleUninstallPart: jest.fn(async () => '✅ 成功从载具【白天鹅】拆卸了【轻型足】×2(行走)'),
    };
    const handler = new GameCommandHandler(
      gameService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      taskService,
    );
    return { handler, gameService, taskService };
  }

  it('已有载具组装按实际数量推进组装部件和具体部件任务', async () => {
    const fixture = makeHandler();
    const result = await fixture.handler.handle(
      { userId: 42, rawMessage: '组装 轻型足3', source: 'web' } as any,
      ['轻型足3'],
    );

    expect(result.success).toBe(true);
    expect(fixture.gameService.handleAssembleVehicle).toHaveBeenCalledWith(42, '轻型足', 3);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '组装部件', 2);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '组装轻型足', 2);
    expect(fixture.taskService.advance).not.toHaveBeenCalledWith(42, '组装载具', expect.anything());
  });

  it('核心创建载具只推进一次组装载具，具体核心动作仍同步记录', async () => {
    const fixture = makeHandler();
    fixture.gameService.handleAssembleVehicle.mockResolvedValue('✅ 成功组装载具：白天鹅');

    await fixture.handler.handle(
      { userId: 42, rawMessage: '组装 骑士核心2', source: 'web' } as any,
      ['骑士核心2'],
    );

    expect(fixture.gameService.handleAssembleVehicle).toHaveBeenCalledWith(42, '骑士核心', 2);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '组装载具', 1);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '组装骑士核心', 1);
    expect(fixture.taskService.advance).not.toHaveBeenCalledWith(42, '组装部件', expect.anything());
  });

  it('拆卸按实际数量推进拆卸部件和具体部件任务，失败不推进', async () => {
    const fixture = makeHandler();

    await fixture.handler.handle(
      { userId: 42, rawMessage: '拆卸 轻型足3', source: 'web' } as any,
      ['轻型足3'],
    );

    expect(fixture.gameService.handleUninstallPart).toHaveBeenCalledWith(42, '轻型足', 3);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '拆卸部件', 2);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '拆卸轻型足', 2);

    fixture.taskService.advance.mockClear();
    fixture.gameService.handleUninstallPart.mockResolvedValue('载具上没有安装【轻型足】');
    await fixture.handler.handle(
      { userId: 42, rawMessage: '拆卸 轻型足', source: 'web' } as any,
      ['轻型足'],
    );
    expect(fixture.taskService.advance).not.toHaveBeenCalled();
  });

  it('安装按服务返回的实际数量推进，库存不足不使用请求数量', async () => {
    const fixture = makeHandler();
    fixture.gameService.handleInstall = jest.fn(async () =>
      '✅ 成功将【轻型足】×1安装到载具【白天鹅】上');

    await fixture.handler.handle(
      { userId: 42, rawMessage: '安装 轻型足3', source: 'web' } as any,
      ['轻型足3'],
    );

    expect(fixture.gameService.handleInstall).toHaveBeenCalledWith(42, '轻型足3');
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '安装', 1);
    expect(fixture.taskService.advance).toHaveBeenCalledWith(42, '安装轻型足', 1);
    expect(fixture.taskService.advance).not.toHaveBeenCalledWith(42, '安装', 3);
  });
});

describe('采集命令总路由', () => {
  it('命中地图采集指令时保留冷却提示，不降级成未知指令', async () => {
    const taskService = {
      ensureTutorialTasks: jest.fn(async () => []),
      advance: jest.fn(async () => ''),
      consumeNotifications: jest.fn(() => ''),
    };
    const gatherHandler = {
      handle: jest.fn(async () => ({
        success: false,
        content: '【木头】还需要 299 秒才能再次采集',
        broadcast: false,
        durationMs: 0,
      })),
    };
    const commandLog = { create: jest.fn(async () => ({})) };
    const service = new CommandService(
      {
        command: {
          findFirst: jest.fn(async () => null),
          findMany: jest.fn(async () => []),
        },
        commandLog,
      } as any,
      { gather: gatherHandler } as any,
      {
        getFirstFamiliarGate: jest.fn(async () => null),
        hasGatherCmd: jest.fn(async () => true),
      } as any,
      { takePendingLevelUpText: () => '' } as any,
      taskService as any,
    );

    const result = await service.dispatch({
      userId: 42,
      rawMessage: '收集木头',
      source: 'web',
    } as any);

    expect(result.success).toBe(false);
    expect(result.content).toContain('还需要 299 秒');
    expect(result.content).not.toContain('未找到指令');
    expect(gatherHandler.handle).toHaveBeenCalled();
    expect(taskService.advance).not.toHaveBeenCalled();
    expect(commandLog.create).toHaveBeenCalled();
  });
});
