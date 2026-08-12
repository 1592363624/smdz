/**
 * 家园指令处理器
 * 委托 GameService 处理家园相关逻辑。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 家园操作入口指令
 * 用法：家园 [子命令]
 */
export class HomeHandler implements CommandHandler {
  key = 'home';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录', broadcast: false, durationMs: 0 };
    }
    const subCommand = args.join(' ');
    const result = await this.gameService.handleHome(ctx.userId, subCommand);
    return { success: true, content: result, broadcast: false, durationMs: 0 };
  }
}