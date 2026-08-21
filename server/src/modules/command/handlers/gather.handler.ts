/**
 * 资源采集指令处理器（对齐原版运行时匹配设计）
 * 委托 GameService.handleGatherResource 处理地图固定资源采集。
 * 对应原版易语言的「打开箱子 / 打开休眠仓 / 收集物品 / 捡垃圾 / 收集木头 / 收集石头」等
 * gatherCmd 采集指令。这些指令【不预注册到指令表】，而是由 CommandService.dispatch
 * 在指令表未命中时兜底调用本处理器（对齐原版 _主程序.ecode：所有指令匹配失败后进入采集分支），
 * 按"指令名"运行时匹配当前地图资源2的 gatherCmd 字段。
 */

import { Inject, Injectable } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { TaskService } from '../../game/task.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 资源采集指令处理器
 * 指令名 = 地图资源的 gatherCmd 字段（如 打开箱子 / 打开休眠仓 / 收集木头 / 捡垃圾）。
 * 由 CommandService 作为"指令表未命中"的兜底处理器调用（对齐原版运行时匹配）。
 * 未匹配到当前地图资源时返回 success=false + 固定标记「未匹配」，供上层判定并退化为未知指令提示。
 */
@Injectable()
export class GatherHandler implements CommandHandler {
  key = 'gather';
  module = 'game';

  constructor(
    @Inject(GameService) private readonly gameService: GameService,
    @Inject(TaskService) private readonly taskService: TaskService,
  ) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录', broadcast: false, durationMs: 0 };
    }
    // 从 rawMessage 解析指令名（去除前缀 + 首词），作为 gatherCmd 匹配地图资源
    const raw = (ctx.rawMessage || '').trim().replace(/^[\/！!]+/, '');
    const cmdName = raw.split(/\s+/)[0];
    if (!cmdName) {
      return { success: false, content: '请输入采集指令', broadcast: false, durationMs: 0 };
    }

    const compact = cmdName.match(/^(.*?)(\d+)$/);
    const gatherName = compact ? compact[1].trim() : cmdName;
    const gatherCount = compact ? Math.max(1, Number(compact[2])) : 1;
    const result = await this.gameService.handleGatherResource(ctx.userId, gatherName, gatherCount);
    if (result) {
      // 冷却、死亡等提示也有返回文本，但不能因此消耗任务次数。
      const taskNotice = this.taskService.consumeNotifications(ctx.userId);
      const content = taskNotice
        ? `${result}\n━━━━━━━━━━━━━━━\n${taskNotice}`
        : result;
      return {
        success: this.isSuccessfulAction(result),
        content,
        broadcast: false,
        durationMs: 0,
      };
    }

    // 当前地图没有匹配 gatherCmd 的资源
    return { success: false, content: `当前地图没有可「${gatherName}」的资源`, broadcast: false, durationMs: 0 };
  }

  private isSuccessfulAction(result: string): boolean {
    if (!result?.trim()) return false;
    return !/(失败|错误|未知|不存在|无法|不能|不可|未找到|请指定|请先|冷却中|还需要|已死亡|不在|当前地图没有)/.test(result);
  }
}
