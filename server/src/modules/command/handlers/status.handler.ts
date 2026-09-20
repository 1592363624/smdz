/**
 * 状态指令处理器：展示玩家详细属性。
 * 用法：status
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';
import { failCommand, okCommand } from '../command-result.util';

export class StatusHandler implements CommandHandler {
  key = 'status';
  module = 'basic';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.userId) {
      return failCommand('未登录');
    }
    const result = await this.gameService.handleStatus(ctx.userId);
    return okCommand(result);
  }
}