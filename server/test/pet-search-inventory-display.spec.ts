import { CommandService } from '../src/modules/command/command.service';

function renderBackpack(backpack: any[]): string {
  const lines = backpack.map(
    (item: any, index: number) =>
      `${index + 1}. ${item.name} ×${item.quantity}`,
  );
  return `🎒 背包 (${backpack.length}种):\n${lines.join('\n')}`;
}

function makeEnvironment(commandDef: any, sharedBackpack: any[], searchBehavior: jest.Mock) {
  const handler = {
    handle: jest.fn(async () => ({
      success: true,
      content: renderBackpack(sharedBackpack),
      broadcast: false,
      durationMs: 0,
    })),
  };
  const taskService: any = {
    ensureTutorialTasks: jest.fn(async () => []),
    advance: jest.fn(async () => ''),
    consumeNotifications: jest.fn(() => ''),
  };
  const gameService: any = {
    getFirstFamiliarGate: jest.fn(async () => null),
    calculateTimeElapsed: jest.fn(async () => ''),
    triggerAutoFamiliarSkill: searchBehavior,
    settleDailyLogin: jest.fn(async () => ''),
    getActionHints: jest.fn(async () => ''),
    pushPlayerUpdate: jest.fn(async () => undefined),
    pushMapUpdate: jest.fn(async () => undefined),
  };
  const prisma: any = {
    command: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => [commandDef]),
    },
    commandLog: { create: jest.fn(async () => ({})) },
  };
  const playerMutate = {
    mutate: jest.fn(async (_userId: number, fn: () => Promise<any>) => fn()),
  };
  const service = new CommandService(
    prisma,
    { [commandDef.handlerKey]: handler } as any,
    gameService,
    { takePendingLevelUpText: () => '' } as any,
    taskService,
    playerMutate as any,
  );
  return { service, handler, gameService, taskService };
}

describe('宠物搜索与背包展示的一致性', () => {
  it('背包指令：先结算宠物搜索再渲染列表，新物品直接出现在本次背包里', async () => {
    const backpack: any[] = [
      { name: '木头', type: '资源', quantity: 3 },
      { name: '石头', type: '资源', quantity: 5 },
    ];
    const commandDef = { name: '背包', alias: 'inventory,查看背包', handlerKey: 'inventory', enabled: true };
    const searchBehavior = jest.fn(async () => {
      backpack.push({ name: '小粉', type: '资源', quantity: 1 });
      backpack.push({ name: '神龙祥瑞', type: '装备', quantity: 1, data: '@@x s!ai900' });
      return '白发现了小粉x1、神龙祥瑞[装备]，带回了走廊那边\n(物品数量+0%)(触发几率25%)(冷却600秒)';
    });
    const { service, handler, gameService } = makeEnvironment(commandDef, backpack, searchBehavior);

    const result = await service.dispatch({
      userId: 1,
      rawMessage: '背包',
      source: 'web',
    } as any);

    expect(result.success).toBe(true);
    // 列表直接包含本次搜索到的物品（不需要再发一次背包才看到）
    expect(result.content).toContain('🎒 背包 (4种)');
    expect(result.content).toContain('小粉');
    expect(result.content).toContain('神龙祥瑞');
    // 结果文本顺序：列表在前，搜索提示在后
    const listIdx = result.content.indexOf('🎒 背包');
    const searchIdx = result.content.indexOf('白发现了');
    expect(listIdx).toBeGreaterThanOrEqual(0);
    expect(searchIdx).toBeGreaterThan(listIdx);
    // 搜索在 handler 渲染列表之前结算，且只触发一次
    expect(gameService.triggerAutoFamiliarSkill).toHaveBeenCalledTimes(1);
    const searchOrder = gameService.triggerAutoFamiliarSkill.mock.invocationCallOrder[0];
    const handlerOrder = handler.handle.mock.invocationCallOrder[0];
    expect(searchOrder).toBeLessThan(handlerOrder);
  });

  it('别名"查看背包"同样按展示类指令提前结算', async () => {
    const backpack: any[] = [{ name: '木头', type: '资源', quantity: 3 }];
    const commandDef = { name: '背包', alias: 'inventory,查看背包', handlerKey: 'inventory', enabled: true };
    const searchBehavior = jest.fn(async () => {
      backpack.push({ name: '小粉', type: '资源', quantity: 1 });
      return '白发现了小粉x1，带回了走廊那边\n(物品数量+0%)(触发几率25%)(冷却600秒)';
    });
    const { service, handler, gameService } = makeEnvironment(commandDef, backpack, searchBehavior);

    await service.dispatch({
      userId: 1,
      rawMessage: '查看背包',
      source: 'web',
    } as any);

    expect(gameService.triggerAutoFamiliarSkill).toHaveBeenCalledTimes(1);
    const searchOrder = gameService.triggerAutoFamiliarSkill.mock.invocationCallOrder[0];
    const handlerOrder = handler.handle.mock.invocationCallOrder[0];
    expect(searchOrder).toBeLessThan(handlerOrder);
    expect((gameService.triggerAutoFamiliarSkill as jest.Mock).mock.calls[0][0]).toBe(1);
  });

  it('非展示类指令保持原版顺序：操作结束后再结算宠物搜索', async () => {
    const backpack: any[] = [{ name: '木头', type: '资源', quantity: 3 }];
    const commandDef = { name: '攻击', alias: 'attack,打,揍', handlerKey: 'game', enabled: true };
    const searchBehavior = jest.fn(async () => {
      backpack.push({ name: '小粉', type: '资源', quantity: 1 });
      return '白发现了小粉x1，带回了走廊那边\n(物品数量+0%)(触发几率25%)(冷却600秒)';
    });
    const { service, handler, gameService } = makeEnvironment(commandDef, backpack, searchBehavior);

    const result = await service.dispatch({
      userId: 1,
      rawMessage: '攻击 史莱姆',
      source: 'web',
    } as any);

    expect(result.success).toBe(true);
    expect(gameService.triggerAutoFamiliarSkill).toHaveBeenCalledTimes(1);
    const searchOrder = gameService.triggerAutoFamiliarSkill.mock.invocationCallOrder[0];
    const handlerOrder = handler.handle.mock.invocationCallOrder[0];
    expect(searchOrder).toBeGreaterThan(handlerOrder);
    expect(result.content).toContain('白发现了小粉x1');
  });

  it('只读指令不触发宠物搜索', async () => {
    const backpack: any[] = [{ name: '木头', type: '资源', quantity: 3 }];
    const commandDef = { name: '帮助', alias: 'help,指令,命令', handlerKey: 'help', enabled: true };
    const searchBehavior = jest.fn(async () => '');
    const { service, gameService } = makeEnvironment(commandDef, backpack, searchBehavior);

    await service.dispatch({
      userId: 1,
      rawMessage: '帮助',
      source: 'web',
    } as any);

    expect(gameService.triggerAutoFamiliarSkill).not.toHaveBeenCalled();
  });
});