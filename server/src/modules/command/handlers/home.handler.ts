/**
 * 家园指令处理器：家园操作入口，委托 GameService 处理家园相关逻辑。
 * 用法：家园 [子命令]
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';
import { failCommand, okCommand } from '../command-result.util';

export class HomeHandler implements CommandHandler {
  key = 'home';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return failCommand('未登录');
    }
    const subCommand = args.shift() || '';
    const result = await this.gameService.handleHome(ctx.userId, subCommand, ...args);
    return okCommand(result);
  }
}
