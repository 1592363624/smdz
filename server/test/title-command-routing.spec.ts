/**
 * 称号查看指令路由回归
 *
 * 背景（2026-09-13 玩家反馈）：发送「查看可领取称号」返回了信息面板。
 * 根因：「查看可领取称号」从未注册为指令，而「信息」指令的别名含「查看」，
 * dispatch 前缀回退把「查看可领取称号」吞成「查看」+ 参数「可领取称号」，
 * 于是返回了「信息」的玩家属性面板。
 * 修复：注册「查看可领取称号」指令（seed + game handler case），精确命中后
 * 委托 FamiliarSystemService.viewAvailableTitles。
 */
import { GameCommandHandler } from '../src/modules/command/handlers/game-command.handler';
import { CommandService } from '../src/modules/command/command.service';

function buildService(gameServiceOverrides: Record<string, any> = {}) {
  const taskService = {
    ensureTutorialTasks: jest.fn(async () => []),
    advance: jest.fn(async () => ''),
    consumeNotifications: jest.fn(() => ''),
  };
  const gameService = {
    handleAvailableTitles: jest.fn(async () => '📜 可领取的称号\n使魔新手（拥有1个使魔好感度≥25）'),
    handleInfo: jest.fn(async () => '【路人甲】Lv.145'),
    calculateTimeElapsed: jest.fn(async () => ''),
    getFirstFamiliarGate: jest.fn(async () => null),
    getActionHints: jest.fn(async () => ''),
    pushPlayerUpdate: jest.fn(async () => undefined),
    pushMapUpdate: jest.fn(async () => undefined),
    ...gameServiceOverrides,
  };
  const infoHandler = {
    key: 'info',
    handle: jest.fn(async () => ({ success: true, content: '【路人甲】Lv.145', broadcast: false, durationMs: 0 })),
  };
  const gameHandler = new GameCommandHandler(
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
  // 指令表取自 seed.ts 的称号族 + 「信息」（别名含「查看」，即 bug 中的误命中来源）
  const commands = [
    { name: '信息', alias: 'info,资料,查看,状态', handlerKey: 'info', enabled: true },
    { name: '使魔称号', alias: 'familiar-titles', handlerKey: 'game', enabled: true },
    { name: '查看可领取称号', alias: 'available-titles', handlerKey: 'game', enabled: true },
    { name: '领取称号', alias: 'claim-title', handlerKey: 'game', enabled: true },
    { name: '佩戴称号', alias: 'equip-title', handlerKey: 'game', enabled: true },
  ];
  const prisma = {
    command: { findMany: jest.fn(async () => commands) },
    commandLog: { create: jest.fn(async () => ({})) },
  };
  const service = new CommandService(
    prisma as any,
    { game: gameHandler, info: infoHandler } as any,
    gameService as any,
    { takePendingLevelUpText: () => '' } as any,
    taskService as any,
  );
  return { service, gameService, infoHandler, taskService };
}

describe('称号查看指令路由', () => {
  it('「查看可领取称号」精确命中新指令，返回可领取称号列表而非信息面板', async () => {
    const { service, gameService, infoHandler } = buildService();

    const result = await service.dispatch({
      userId: 42,
      rawMessage: '查看可领取称号',
      source: 'web',
    } as any);

    expect(result.success).toBe(true);
    expect(gameService.handleAvailableTitles).toHaveBeenCalledWith(42);
    expect(result.content).toContain('可领取的称号');
    expect(infoHandler.handle).not.toHaveBeenCalled();
  });

  it('英文别名 available-titles 同样命中可领取称号列表', async () => {
    const { service, gameService } = buildService();

    const result = await service.dispatch({
      userId: 42,
      rawMessage: 'available-titles',
      source: 'web',
    } as any);

    expect(result.success).toBe(true);
    expect(gameService.handleAvailableTitles).toHaveBeenCalledWith(42);
    expect(result.content).toContain('可领取的称号');
  });

  it('回归：「查看」单独发送仍命中「信息」别名，返回玩家信息面板', async () => {
    const { service, gameService, infoHandler } = buildService();

    const result = await service.dispatch({
      userId: 42,
      rawMessage: '查看',
      source: 'web',
    } as any);

    expect(result.success).toBe(true);
    expect(infoHandler.handle).toHaveBeenCalled();
    expect(gameService.handleAvailableTitles).not.toHaveBeenCalled();
    expect(result.content).toContain('【路人甲】');
  });
});
