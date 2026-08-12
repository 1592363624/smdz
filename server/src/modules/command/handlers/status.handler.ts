/**
 * 状态指令处理器
 * 委托 GameService 展示玩家详细属性。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 状态指令
 * 用法：status
 */
export class StatusHandler implements CommandHandler {
  key = 'status';
  module = 'basic';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录', broadcast: false, durationMs: 0 };
    }
    const result = await this.gameService.handleStatus(ctx.userId);
    return { success: true, content: result, broadcast: false, durationMs: 0 };
  }
}