/**
 * 「发送指令」成就写入回归
 *
 * 背景（2026-09-15 玩家反馈）：发送多条指令后「领取称号 肝帝I」仍提示
 * “需要发送指令x10，你只达到了0”。
 * 根因：原版 添加成就(“发送指令”,1,玩家.成就,玩家.任务) 一次调用同时写
 * 「成就」（Player.markers，称号进度数据源）与「任务」；移植版只有
 * taskService.advance（只推进任务），没有写 markers → 肝帝系列条件恒为 0。
 * 修复：CommandService.finishCommandTasks 里同步调用
 * AchievementService.addAchievement(player, '发送指令', 1)（可选依赖，
 * 未注入时跳过、不阻断指令主链路）。
 */
import { CommandService } from '../src/modules/command/command.service';

function buildService(options: { withAchievement?: boolean } = {}) {
  const taskService = {
    advance: jest.fn(async () => ''),
    consumeNotifications: jest.fn(() => ''),
  };
  const gameService = {
    getFirstFamiliarGate: jest.fn(async () => null),
    hasGatherCmd: jest.fn(async () => false),
    calculateTimeElapsed: jest.fn(async () => ''),
    triggerAutoFamiliarSkill: jest.fn(async () => ''),
    settleDailyLogin: jest.fn(async () => ''),
    getActionHints: jest.fn(async () => ''),
    pushPlayerUpdate: jest.fn(async () => undefined),
    pushMapUpdate: jest.fn(async () => undefined),
  };
  const infoHandler = {
    key: 'info',
    handle: jest.fn(async () => ({
      success: true,
      content: '【路人甲】Lv.145',
      broadcast: false,
      durationMs: 0,
    })),
  };
  const player = { userId: 42, name: '路人甲', markers: {} };
  const playerService = {
    takePendingLevelUpText: () => '',
    getPlayerData: jest.fn(async () => ({ player })),
  };
  const achievementService = { addAchievement: jest.fn(async () => undefined) };
  const prisma = {
    command: {
      findMany: jest.fn(async () => [
        { name: '信息', alias: 'info,资料,查看,状态', handlerKey: 'info', enabled: true },
      ]),
    },
    commandLog: { create: jest.fn(async () => ({})) },
  };
  const service = new CommandService(
    prisma as any,
    { info: infoHandler } as any,
    gameService as any,
    playerService as any,
    taskService as any,
    undefined, // playerMutate：本测试走降级读档路径
    undefined, // sourceRegistry
    undefined, // systemConfigService
    options.withAchievement === false ? undefined : (achievementService as any),
  );
  return { service, taskService, achievementService, playerService, player };
}

describe('「发送指令」成就写入（肝帝系列前置）', () => {
  it('指令成功执行后同时推进任务并写「发送指令」成就', async () => {
    const { service, taskService, achievementService, player } = buildService();

    const result = await service.dispatch({ userId: 42, rawMessage: '信息', source: 'web' } as any);

    expect(result.success).toBe(true);
    // 任务侧保持原行为（发送指令 + 发送“正文”）
    expect(taskService.advance).toHaveBeenCalledWith(42, '发送指令');
    // 成就侧：原版 添加成就("发送指令",1,玩家.成就,玩家.任务) 的成就那一半
    const addAchievementMock = achievementService.addAchievement as unknown as jest.Mock;
    expect(addAchievementMock).toHaveBeenCalledTimes(1);
    const [playerArg, nameArg, countArg] = addAchievementMock.mock.calls[0] as [any, string, number];
    expect(playerArg).toBe(player);
    expect(nameArg).toBe('发送指令');
    expect(countArg).toBe(1);
  });

  it('失败结果（未命中指令）不写「发送指令」成就', async () => {
    const { service, achievementService } = buildService();

    const result = await service.dispatch({
      userId: 42,
      rawMessage: '不存在的指令xx',
      source: 'web',
    } as any);

    expect(result.success).toBe(false);
    expect(achievementService.addAchievement).not.toHaveBeenCalled();
  });

  it('成就服务未注入（测试桩降级路径）时不报错、指令照常返回', async () => {
    const { service } = buildService({ withAchievement: false });

    const result = await service.dispatch({ userId: 42, rawMessage: '信息', source: 'web' } as any);

    expect(result.success).toBe(true);
    expect(result.content).toContain('路人甲');
  });
});
