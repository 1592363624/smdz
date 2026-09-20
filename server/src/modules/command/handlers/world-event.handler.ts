/**
 * 全服世界事件指令处理器（独立 handlerKey = 'worldEvent'）。三条指令都归本 handler，
 * 靠 rawMessage 首段（引擎按 name/别名精确或最长前缀命中后改写为「标准指令名 + 参数」）分支：
 *   世界事件      → 查看进度面板
 *   领取世界奖励  → 领取已解锁里程碑奖励
 *   世界事件管理  → 管理员开关/结算/重置/调目标（内部自鉴权）
 */
import { Inject } from '@nestjs/common';
import { WorldEventService } from '../../game/world-event.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';
import { failCommand, okCommand } from '../command-result.util';

export class WorldEventHandler implements CommandHandler {
  key = 'worldEvent';
  module = 'game';

  constructor(
    @Inject(WorldEventService) private readonly worldEvent: WorldEventService,
  ) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return failCommand('未登录');
    }
    const userId = ctx.userId;
    const first = ctx.rawMessage.replace(/^[\/！!]/, '').trim().split(/\s+/)[0] || '';

    let content: string;
    if (first === '世界事件管理' || first === 'world-event-admin') {
      content = await this.worldEvent.adminCommand(userId, args);
    } else if (first === '领取世界奖励' || first === 'claim-world-reward' || first === 'lqsjjl') {
      // 可选参数：指定档位，如「领取世界奖励 100」
      const tier = args.length > 0 && Number(args[0]) > 0 ? Number(args[0]) : undefined;
      content = await this.worldEvent.claimReward(userId, tier);
    } else {
      // 世界事件 / world-event / 事件 / sj
      content = await this.worldEvent.viewPanel(userId);
    }
    return okCommand(content);
  }
}
