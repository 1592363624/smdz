/**
 * 查看玩家信息指令处理器
 * 委托 GameService 展示当前玩家档案。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 查看玩家信息指令
 * 用法：info
 * 带参数（查看 白 / 查看白兔子）时优先查看地图单位（原版 对话菜单 1、查看）。
 */
export class InfoHandler implements CommandHandler {
  key = 'info';
  module = 'basic';

  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录，无法查看信息', broadcast: false, durationMs: 0 };
    }
    // 原版 对话菜单 “1、查看”→ 查看NPC/怪物名：带参数且命中地图单位时展示单位详情
    const args = ctx.rawMessage.trim().split(/\s+/).slice(1);
    const unitName = args.join(' ').trim();
    if (unitName) {
      const unitDetail = await this.gameService.handleViewUnit(ctx.userId, unitName).catch(() => '');
      if (unitDetail) {
        return { success: true, content: unitDetail, broadcast: false, durationMs: 0 };
      }
    }
    const result = await this.gameService.handleInfo(ctx.userId);
    return { success: true, content: result, broadcast: false, durationMs: 0 };
  }
}