/**
 * 查看玩家信息指令处理器
 * 委托 GameService 展示当前玩家档案。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 查看玩家信息指令
 * 用法：info
 */
export class InfoHandler implements CommandHandler {
  key = 'info';
  module = 'basic';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录，无法查看信息', broadcast: false, durationMs: 0 };
    }
    const result = await this.gameService.handleInfo(ctx.userId);
    return { success: true, content: result, broadcast: false, durationMs: 0 };
  }
}