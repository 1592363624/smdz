/**
 * 传送指令处理器
 * 委托 GameService 处理玩家传送逻辑。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 传送到指定地图指令
 * 用法：传送 <地图名>
 */
export class TeleportHandler implements CommandHandler {
  key = 'teleport';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录', broadcast: false, durationMs: 0 };
    }
    const targetMap = args.join(' ');
    if (!targetMap) {
      return { success: false, content: '请指定目标地图', broadcast: false, durationMs: 0 };
    }
    const result = await this.gameService.handleMove(ctx.userId, targetMap);
    return { success: true, content: result, broadcast: false, durationMs: 0 };
  }
}