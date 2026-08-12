/**
 * 背包指令处理器
 * 委托 GameService 展示玩家背包物品。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 背包指令
 * 用法：inventory 或 背包
 */
export class InventoryHandler implements CommandHandler {
  key = 'inventory';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录，无法查看背包', broadcast: false, durationMs: 0 };
    }
    const result = await this.gameService.handleInventory(ctx.userId);
    return { success: true, content: result, broadcast: false, durationMs: 0 };
  }
}