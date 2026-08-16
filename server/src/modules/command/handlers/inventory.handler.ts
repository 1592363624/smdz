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
 * 支持带参数查看单项详情（对应原版 `背包1`/`背包 石斧`，背包操作 L815~L818）
 */
export class InventoryHandler implements CommandHandler {
  key = 'inventory';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录，无法查看背包', broadcast: false, durationMs: 0 };
    }
    const arg = (args || []).join(' ');
    const result = await this.gameService.handleInventory(ctx.userId, arg || undefined);
    return { success: true, content: result, broadcast: false, durationMs: 0 };
  }
}