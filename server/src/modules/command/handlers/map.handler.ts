/**
 * 地图指令处理器：展示当前地图及可前往区域。
 * 用法：map
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { TutorialService } from '../../game/tutorial.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';
import { appendTutorialHint, failCommand, okCommand } from '../command-result.util';

export class MapHandler implements CommandHandler {
  key = 'map';
  module = 'game';

  constructor(
    @Inject(GameService) private readonly gameService: GameService,
    @Inject(TutorialService) private readonly tutorialService: TutorialService,
  ) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.userId) {
      return failCommand('未登录');
    }
    const result = await this.gameService.handleMap(ctx.userId);
    // 新手引导：地图照常展示、引导仅作附加提示（不拦截，避免「首次看地图被吞」）。
    const tutorialText = await this.tutorialService.consumeTutorial(ctx.userId, 'map');
    return okCommand(appendTutorialHint(result, tutorialText));
  }
}
