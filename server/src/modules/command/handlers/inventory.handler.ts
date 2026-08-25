/**
 * 背包指令处理器
 * 委托 GameService 展示玩家背包物品。
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { TaskService } from '../../game/task.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 背包指令
 * 用法：inventory 或 背包
 * 支持带参数查看单项详情（对应原版 `背包1`/`背包 石斧`，背包操作 L815~L818）
 */
export class InventoryHandler implements CommandHandler {
  key = 'inventory';
  module = 'game';

  constructor(
    @Inject(GameService) private readonly gameService: GameService,
    @Inject(TaskService) private readonly taskService: TaskService,
  ) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录，无法查看背包', broadcast: false, durationMs: 0 };
    }
    const arg = (args || []).join(' ');
    // 查看背包单项详情推进任务（对应原版 物品操作.ecode L817：添加成就("查看背包详细")）。
    // 注意：背包指令的 handlerKey 是 inventory，此前推进逻辑写在 game 处理器里属于死代码，
    // 导致【教程-装备】“需要查看背包详细”无法完成。
    if (arg) {
      await this.taskService.advance(ctx.userId, '查看背包详细');
    }
    const result = await this.gameService.handleInventory(ctx.userId, arg || undefined);
    return { success: true, content: result, broadcast: false, durationMs: 0 };
  }
}