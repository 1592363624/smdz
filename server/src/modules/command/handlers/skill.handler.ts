/**
 * 技能指令处理器：展示玩家使魔技能信息。
 * 用法：skill
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';
import { failCommand, okCommand } from '../command-result.util';

export class SkillHandler implements CommandHandler {
  key = 'skill';
  module = 'game';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.userId) {
      return failCommand('未登录');
    }
    const result = await this.gameService.handleSkill(ctx.userId);
    return okCommand(result);
  }
}