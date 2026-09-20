/**
 * 对话指令处理器：与地图上的 NPC 对话。
 * 用法：对话 <NPC名>
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';
import { failCommand, okCommand } from '../command-result.util';

export class TalkHandler implements CommandHandler {
  key = 'talk';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return failCommand('未登录');
    }
    const npcName = args.join(' ');
    const result = await this.gameService.handleTalk(ctx.userId, npcName);
    return okCommand(result);
  }
}