/**
 * 装备指令处理器：委托 GameService 装备物品。
 * 用法：equip <物品名称>
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';
import { failCommand, okCommand } from '../command-result.util';

export class EquipHandler implements CommandHandler {
  key = 'equip';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return failCommand('未登录');
    }
    const itemName = args.join(' ');
    if (!itemName) {
      return failCommand('请指定要装备的物品名称');
    }
    const result = await this.gameService.handleEquip(ctx.userId, itemName);
    return okCommand(result);
  }
}