/**
 * 传送指令处理器：传送到指定地图。
 * 用法：传送 <地图名>
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';
import { failCommand, okCommand } from '../command-result.util';

export class TeleportHandler implements CommandHandler {
  key = 'teleport';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return failCommand('未登录');
    }
    const targetMap = args.join(' ');
    if (!targetMap) {
      return failCommand('请指定目标地图');
    }
    const result = await this.gameService.handleTeleport(ctx.userId, targetMap);
    return okCommand(result);
  }
}
