import { GameCommandHandler } from '../src/modules/command/handlers/game-command.handler';
import { CommandService } from '../src/modules/command/command.service';

describe('任务相关制造入口', () => {
  it('制造床2按配方名和数量执行，并按实际数量推进任务', async () => {
    const taskService = {
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
