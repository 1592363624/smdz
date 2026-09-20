/**
 * 救助指令处理器：救助倒地玩家。
 * 用法：救助
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';
import { failCommand } from '../command-result.util';

export class RescueHandler implements CommandHandler {
  key = 'rescue';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.userId) {
      return failCommand('未登录');
    }
    const result = await this.gameService.handleRescue(ctx.userId);
    return { success: true, content: result, broadcast: true, durationMs: 0 };
  }
}