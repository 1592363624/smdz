/**
 * 使用物品指令处理器
 * 委托 GameService 处理玩家使用物品。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 使用物品指令
 * 用法：use <物品名称>
 */
export class UseHandler implements CommandHandler {
  key = 'use';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录', broadcast: false, durationMs: 0 };
    }
    const itemName = args.join(' ');
    if (!itemName) {
      return { success: false, content: '请指定要使用的物品名称', broadcast: false, durationMs: 0 };
    }
    const result = await this.gameService.handleUseItem(ctx.userId, itemName);
    return { success: true, content: result, broadcast: false, durationMs: 0 };
  }
}