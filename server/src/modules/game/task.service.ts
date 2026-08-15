/**
 * 自动任务推进服务
 * 对应原版易语言：任务系统.ecode
 * 当玩家执行游戏操作时，自动检查并推进任务进度
 * 任务完成时自动发放奖励并触发后续任务
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { StaticDataService } from './static-data.service';

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly staticData: StaticDataService,
  ) {}

  /**
   * 推进任务进度 - 在玩家执行各种游戏操作时统一调用
   * @param userId 用户ID
   * @param action 操作类型，如 '击杀', '制造', '收集', '兑换', '捕捉', '探索', '装备', '升级'
   * @param target 目标名称，如怪物名、物品名（可选）
   * @param count 完成数量（默认1）
   * @returns 任务完成提示文本，无完成则返回空字符串
   */
  async advance(userId: number, action: string, target: string = '', count: number = 1): Promise<string> {
    if (!userId) return '';

    try {
      const player = await this.prisma.player.findUnique({ where: { userId } });
      if (!player) return '';

      // 1. 更新 Player.tasks 中的进度记录
      const tasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
      const taskKey = target ? `${action}${target}` : action;
      const existing = tasks.find((t: any) => t.name === taskKey);
      if (existing) {
        existing.count = (existing.count || 0) + count;
      } else {
        tasks.push({ name: taskKey, count });
      }

      // 2. 检查 GameTask 定义中的任务是否满足完成条件
      const completedText = await this.checkGameTaskCompletion(userId, tasks, action, target);

      // 3. 保存
      player.tasks = JSON.stringify(tasks);
      await this.playerService.savePlayer(player);

      return completedText;
    } catch (e) {
      this.logger.warn(`推进任务失败: ${e.message}`);
      return '';
    }
  }

  /**
   * 检查已激活的 GameTask 是否满足完成条件
   */
  private async checkGameTaskCompletion(
    userId: number,
    playerTasks: any[],
    action: string,
    target: string,
  ): Promise<string> {
    const allGameTasks = this.staticData.getAllTasks();
    const completedMessages: string[] = [];

    for (const gameTask of allGameTasks) {
      // 检查玩家是否已激活此任务
      const taskProgress = playerTasks.find((t: any) => t.name === gameTask.name);
      if (!taskProgress || taskProgress.completed) continue;

      // 解析任务要求（格式：[{name, count}]）
      const requirements = this.playerService.safeJsonParse<Array<{ name: string; count: number }>>(
        gameTask.requirements, []
      );
      if (requirements.length === 0) continue;

      // 检查当前操作是否匹配此任务的任一要求
      const matchesAction = requirements.some(
        req => req.name === action || (target && req.name === target)
      );
      if (!matchesAction) continue;

      // 检查是否满足所有要求
      let allRequirementsMet = true;
      for (const req of requirements) {
        // 查找玩家标记/背包中的进度
        const progress = await this.getRequirementProgress(userId, req.name, playerTasks);
        if (progress < req.count) {
          allRequirementsMet = false;
          break;
        }
      }

      if (allRequirementsMet) {
        // 任务完成 - 发放奖励
        await this.completeTask(userId, gameTask, playerTasks);
        completedMessages.push(`✅ 任务完成: ${gameTask.name}`);
      }
    }

    return completedMessages.join('\n');
  }

  /**
   * 获取某项要求的当前进度
   */
  private async getRequirementProgress(
    userId: number, reqName: string, playerTasks: any[]
  ): Promise<number> {
    // 1. 检查 Player.tasks 中的进度
    const taskProgress = playerTasks.find((t: any) => t.name === reqName);
    if (taskProgress) return taskProgress.count || 0;

    // 2. 检查玩家标记（如 "击杀" 成就）
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (player) {
      const markers = this.playerService.safeJsonParse<Record<string, number>>(player.markers, {});
      if (markers[reqName] !== undefined) return markers[reqName];
    }

    // 3. 检查背包（如 "铁矿" 收集数量）
    if (player) {
      const backpack = this.playerService.safeJsonParse<Array<{ name: string; count: number }>>(player.backpack, []);
      const item = backpack.find(i => i.name === reqName);
      if (item) return item.count || 0;
    }

    return 0;
  }

  /**
   * 完成任务 - 发放奖励并触发后续任务
   */
  private async completeTask(
    userId: number,
    gameTask: any,
    playerTasks: any[]
  ): Promise<void> {
    // 标记任务已完成
    const taskProgress = playerTasks.find((t: any) => t.name === gameTask.name);
    if (taskProgress) taskProgress.completed = true;

    // 发放奖励
    const rewards = this.playerService.safeJsonParse<Array<{ name: string; count: number }>>(
      gameTask.rewards, []
    );
    for (const reward of rewards) {
      if (reward.name && reward.count > 0) {
        await this.playerService.addToBackpack(userId, reward.name, reward.count);
      }
    }

    // 发放经验奖励
    const expGain = gameTask.level ? gameTask.level * 50 : 0;
    if (expGain > 0) {
      await this.playerService.addExp(userId, expGain);
    }

    // 触发后续任务
    const nextTasks = this.playerService.safeJsonParse<string[]>(gameTask.nextTasks, []);
    for (const nextTaskName of nextTasks) {
      if (nextTaskName && !playerTasks.find((t: any) => t.name === nextTaskName)) {
        playerTasks.push({ name: nextTaskName, count: 0, completed: false });
      }
    }

    this.logger.log(`用户 ${userId} 完成任务: ${gameTask.name}`);
  }

  /**
   * 获取玩家当前可接的任务列表（未激活的 GameTask）
   */
  async getAvailableTasks(userId: number): Promise<any[]> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) return [];

    const playerTasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
    const activeTaskNames = playerTasks.map((t: any) => t.name);

    // 获取所有未激活的任务
    const allGameTasks = this.staticData.getAllTasks();
    return allGameTasks.filter(t => !activeTaskNames.includes(t.name));
  }

  /**
   * 领取任务（激活一个 GameTask）
   */
  async acceptTask(userId: number, taskName: string): Promise<string> {
    const gameTask = this.staticData.getTaskByName(taskName);
    if (!gameTask) return `任务「${taskName}」不存在`;

    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) return '玩家数据不存在';

    const playerTasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
    if (playerTasks.find((t: any) => t.name === taskName)) {
      return `你已经领取了任务「${taskName}」`;
    }

    playerTasks.push({ name: taskName, count: 0, completed: false });
    player.tasks = JSON.stringify(playerTasks);
    await this.playerService.savePlayer(player);

    return `✅ 已领取任务: ${taskName}\n${gameTask.description || ''}`;
  }

  /**
   * 查看任务列表
   */
  async listTasks(userId: number): Promise<string> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) return '玩家数据不存在';

    const playerTasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
    const activeTasks = playerTasks.filter((t: any) => !t.completed);
    const completedTasks = playerTasks.filter((t: any) => t.completed);

    const lines: string[] = ['📋 任务列表'];

    if (activeTasks.length > 0) {
      lines.push('━━━ 进行中 ━━━');
      for (const task of activeTasks) {
        const gameTask = this.staticData.getTaskByName(task.name);
        const desc = gameTask?.description || '';
        const progress = task.count ? `(${task.count})` : '';
        lines.push(`  ${task.name}${progress}`);
        if (desc) lines.push(`    ${desc}`);
      }
    }

    if (completedTasks.length > 0) {
      lines.push('━━━ 已完成 ━━━');
      for (const task of completedTasks) {
        lines.push(`  ✅ ${task.name}`);
      }
    }

    if (activeTasks.length === 0 && completedTasks.length === 0) {
      lines.push('  暂无任务，使用「领取任务」来接取任务');
    }

    return lines.join('\n');
  }
}