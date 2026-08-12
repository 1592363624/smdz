/**
 * 卸下装备指令处理器
 * 委托 GameService 处理玩家卸下装备。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 卸下装备指令
 * 用法：unequip <部位>
 */
export class UnequipHandler implements CommandHandler {
  key = 'unequip';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录', broadcast: false, durationMs: 0 };
    }
    const slot = args[0] || '';
    if (!slot) {
      return { success: false, content: '请指定要卸下的部位(武器/护甲/头部/脚部/饰品)', broadcast: false, durationMs: 0 };
    }
    const result = await this.gameService.handleUnequip(ctx.userId, slot);
    return { success: true, content: result, broadcast: false, durationMs: 0 };
  }
}