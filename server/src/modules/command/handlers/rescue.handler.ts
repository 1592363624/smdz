/**
 * 救助指令处理器
 * 委托 GameService 处理玩家救助逻辑。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 救助倒地的玩家指令
 * 用法：救助
 */
export class RescueHandler implements CommandHandler {
  key = 'rescue';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录', broadcast: false, durationMs: 0 };
    }
    const result = await this.gameService.handleRescue(ctx.userId);
    return { success: true, content: result, broadcast: true, durationMs: 0 };
  }
}