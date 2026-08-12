/**
 * 对话指令处理器
 * 委托 GameService 处理与NPC对话逻辑。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 与地图上的NPC对话指令
 * 用法：对话 <NPC名>
 */
export class TalkHandler implements CommandHandler {
  key = 'talk';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录', broadcast: false, durationMs: 0 };
    }
    const npcName = args.join(' ');
    const result = await this.gameService.handleTalk(ctx.userId, npcName);
    return { success: true, content: result, broadcast: false, durationMs: 0 };
  }
}