/**
 * 移动指令处理器
 * 委托 GameService 处理玩家在地图间移动。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 移动指令
 * 用法：move <地图名>
 */
export class MoveHandler implements CommandHandler {
  key = 'move';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录，无法移动', broadcast: false, durationMs: 0 };
    }
    const targetMapName = args.join(' ');
    if (!targetMapName) {
      return { success: false, content: '用法：move <地图名>', broadcast: false, durationMs: 0 };
    }
    const result = await this.gameService.handleMove(ctx.userId, targetMapName);
    return { success: true, content: result, broadcast: true, durationMs: 0 };
  }
}