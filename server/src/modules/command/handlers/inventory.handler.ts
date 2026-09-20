/**
 * 背包指令处理器：展示玩家背包物品。
 * 用法：inventory 或 背包
 * 支持带参数查看单项详情（对应原版 `背包1`/`背包 石制工具`，背包操作 L815~L818）
 */

import { Inject } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { TaskService } from '../../game/task.service';
import { TutorialService } from '../../game/tutorial.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';
import { appendTutorialHint, failCommand, okCommand } from '../command-result.util';

export class InventoryHandler implements CommandHandler {
  key = 'inventory';
  module = 'game';

  constructor(
    @Inject(GameService) private readonly gameService: GameService,
    @Inject(TaskService) private readonly taskService: TaskService,
    @Inject(TutorialService) private readonly tutorialService: TutorialService,
  ) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return failCommand('未登录，无法查看背包');
    }
    const arg = (args || []).join(' ');
    // 查看背包单项详情推进任务（对应原版 物品操作.ecode L817：添加成就("查看背包详细")）。
    if (arg) {
      await this.taskService.advance(ctx.userId, '查看背包详细');
    }
    const result = await this.gameService.handleInventory(ctx.userId, arg || undefined);
    // 新手引导：查看照常执行、引导仅作附加提示（不拦截，避免「首次查看背包被吞」；
    // 对齐原版 物品操作.ecode L811：背包正文之后才拼接 新手指引("查看背包")）。
    const tutorialText = await this.tutorialService.consumeTutorial(ctx.userId, 'viewBag');
    return okCommand(appendTutorialHint(result, tutorialText));
  }
}
