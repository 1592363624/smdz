/**
 * 使用物品指令处理器
 * 委托 GameService 处理玩家使用物品。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { TaskService } from '../../game/task.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 使用物品指令
 * 用法：use <物品名称> [数量]
 */
export class UseHandler implements CommandHandler {
  key = 'use';
  module = 'game';

  constructor(
    @Inject(GameService) private readonly gameService: GameService,
    @Inject(TaskService) private readonly taskService: TaskService,
  ) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录', broadcast: false, durationMs: 0 };
    }
    const input = args.join(' ').trim();
    const spaced = input.match(/^(.+?)\s+(\d+)$/);
    const compact = input.match(/^(.+?)(\d+)$/);
    const match = spaced || compact;
    const itemName = match ? match[1].trim() : input;
    const count = match ? Math.max(1, Number(match[2])) : 1;
    if (!itemName) {
      return { success: false, content: '请指定要使用的物品名称', broadcast: false, durationMs: 0 };
    }
    const result = await this.gameService.handleUseItem(ctx.userId, itemName, count);
    if (!/(没有|不存在|无法|不能|不可|不是|错误|失败|请指定|正整数)/.test(result)) {
      await this.taskService.advance(ctx.userId, '使用物品', count);
      await this.taskService.advance(ctx.userId, `使用${itemName}`, count);
    }
    return { success: true, content: result, broadcast: false, durationMs: 0 };
  }
}
