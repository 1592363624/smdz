/**
 * 每日抽奖指令处理器
 * 独立 handlerKey（lottery），不挤进 GameService / GameCommandHandler 冻结面。
 *
 * 用法：
 * - 抽奖 / lottery          → 执行一次抽奖（消耗凭证）
 * - 抽奖状态 / lottery-status → 查看剩余次数与奖池
 */

import { Inject } from '@nestjs/common';
import { LotteryService } from '../../game/lottery.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

export class LotteryCommandHandler implements CommandHandler {
  key = 'lottery';
  module = 'game';

  constructor(
    @Inject(LotteryService) private readonly lotteryService: LotteryService,
  ) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录', broadcast: false, durationMs: 0 };
    }

    const raw = ctx.rawMessage.replace(/^[\/！!]/, '').trim();
    const first = raw.split(/\s+/)[0] || '';
    const isStatus =
      args[0] === 'status' ||
      first === '抽奖状态' ||
      first === 'lottery-status';

    const content = isStatus
      ? await this.lotteryService.statusCommand(ctx.userId)
      : await this.lotteryService.drawCommand(ctx.userId);

    return { success: true, content, broadcast: false, durationMs: 0 };
  }
}
