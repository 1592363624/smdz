/**
 * 地图指令处理器
 * 委托 GameService 展示当前地图及可前往区域。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 地图指令
 * 用法：map
 */
export class MapHandler implements CommandHandler {
  key = 'map';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录', broadcast: false, durationMs: 0 };
    }
    const result = await this.gameService.handleMap(ctx.userId);
    return { success: true, content: result, broadcast: false, durationMs: 0 };
  }
}