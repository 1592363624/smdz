/**
 * 查看玩家信息指令处理器：展示当前玩家档案。
 * 用法：info；带参数（查看 白 / 查看白兔子）时优先查看地图单位（原版 对话菜单 1、查看）。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { TutorialService } from '../../game/tutorial.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';
import { appendTutorialHint, failCommand, okCommand } from '../command-result.util';

export class InfoHandler implements CommandHandler {
  key = 'info';
  module = 'basic';

  constructor(
    @Inject(GameService) private readonly gameService: GameService,
    @Inject(TutorialService) private readonly tutorialService: TutorialService,
  ) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.userId) {
      return failCommand('未登录，无法查看信息');
    }
    // 原版 对话菜单 “1、查看”→ 查看NPC/怪物名：带参数且命中地图单位时展示单位详情
    const args = ctx.rawMessage.trim().split(/\s+/).slice(1);
    const unitName = args.join(' ').trim();
    if (unitName) {
      const unitDetail = await this.gameService.handleViewUnit(ctx.userId, unitName).catch(() => '');
      if (unitDetail) {
        // 单位详情不是「角色信息面板」：不消费 info 引导，留给真正查看自己信息时展示，
        // 也避免引导文案（"这是你的角色信息面板"）与正文语义不符。
        return okCommand(unitDetail);
      }
      // 原版通用查看链（_主程序.ecode L5671-L5683）：召唤物/怪物未命中 →
      // 继续匹配当前地图载具（名称/编号皆可），无主废弃载具亦在列
      const vehicleDetail = await this.gameService.handleViewVehicle(ctx.userId, unitName).catch(() => '');
      if (vehicleDetail && !vehicleDetail.includes('附近没有')) {
        return okCommand(vehicleDetail);
      }
    }
    const result = await this.gameService.handleInfo(ctx.userId);
    // 新手引导：信息照常展示、引导仅作附加提示（不拦截，避免「首次查看信息被吞」）。
    const tutorialText = await this.tutorialService.consumeTutorial(ctx.userId, 'info');
    return okCommand(appendTutorialHint(result, tutorialText));
  }
}
