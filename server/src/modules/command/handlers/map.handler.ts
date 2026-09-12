/**
 * 地图指令处理器
 * 委托 GameService 展示当前地图及可前往区域。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { TutorialService } from '../../game/tutorial.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 地图指令
 * 用法：map
 */
export class MapHandler implements CommandHandler {
  key = 'map';
  module = 'game';

  constructor(
    @Inject(GameService) private readonly gameService: GameService,
    @Inject(TutorialService) private readonly tutorialService: TutorialService,
  ) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录', broadcast: false, durationMs: 0 };
    }
    const result = await this.gameService.handleMap(ctx.userId);
    // 新手引导：地图照常展示、引导仅作附加提示（不拦截，避免「首次看地图被吞」）。
    // 2026-09-13：旧实现在 game 处理器的死分支里用引导拦截正文，此处为迁移补齐。
    const tutorialText = await this.tutorialService.consumeTutorial(ctx.userId, 'map');
    return {
      success: true,
      content: tutorialText ? `${result}\n━━━━━━━━━━━━━━━\n💡 ${tutorialText}` : result,
      broadcast: false,
      durationMs: 0,
    };
  }
}
