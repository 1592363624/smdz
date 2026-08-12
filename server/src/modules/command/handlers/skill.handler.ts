/**
 * 技能指令处理器
 * 委托 GameService 展示玩家使魔技能信息。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 技能指令
 * 用法：skill
 */
export class SkillHandler implements CommandHandler {
  key = 'skill';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录', broadcast: false, durationMs: 0 };
    }
    const result = await this.gameService.handleSkill(ctx.userId);
    return { success: true, content: result, broadcast: false, durationMs: 0 };
  }
}