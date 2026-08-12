/**
 * 攻击指令处理器
 * 对应原版：攻击 命令
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 攻击指令处理器
 * 委托 GameService 处理玩家攻击当前地图怪物。
 */
export class AttackHandler implements CommandHandler {
  key = 'attack';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录', broadcast: false, durationMs: 0 };
    }
    const result = await this.gameService.handleAttack(ctx.userId);
    return { success: true, content: result, broadcast: true, durationMs: 0 };
  }
}