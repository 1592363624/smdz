/**
 * 卸下装备指令处理器：委托 GameService 卸下指定部位。
 * 用法：unequip <部位>
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';
import { failCommand, okCommand } from '../command-result.util';

export class UnequipHandler implements CommandHandler {
  key = 'unequip';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return failCommand('未登录');
    }
    const slot = args[0] || '';
    if (!slot) {
      return failCommand('请指定要卸下的部位(武器/护甲/头部/脚部/饰品)');
    }
    const result = await this.gameService.handleUnequip(ctx.userId, slot);
    return okCommand(result);
  }
}