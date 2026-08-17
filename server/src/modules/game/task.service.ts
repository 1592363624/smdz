/**
 * 自动任务推进服务
 * 对应原版易语言：任务系统.ecode、数据分析.ecode 中的 添加成就() 与任务完成检查逻辑
 *
 * 核心原理（与原版一致）：
 * 1. 玩家每执行一个操作（发送命令、击杀怪物、采集资源、对话等），调用 advance(actionName)
 * 2. advance() 遍历玩家所有未完成任务的要求列表，将匹配 actionName 的要求值递减
 * 3. 要求值归零则删除该要求（对应原版"删除成员"），所有要求被删除则任务完成
 * 4. 任务完成时自动发放奖励（经验、物品、好感度等）并自动激活后续任务
 * 5. 每次完成任务自动推进"完成任务"要求，用于支持"套娃"等计数任务
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { StaticDataService } from './static-data.service';

/**
 * 玩家任务项结构
 */
interface PlayerTask {
  name: string;                                                       // 任务名称（对应 GameTask.name）
  requirements: Array<{ name: string; count: number }>;               // 剩余要求列表（count 为剩余需要完成的次数）
  completed?: boolean;                                                // 是否已完成（true 表示已完成，仅展示，不参与推进）
}

/**
 * 任务奖励结构
 */
interface TaskReward {
  name: string;
  count: number;
}

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly staticData: StaticDataService,
  ) {}

  /**
   * 推进任务进度 - 对应原版 添加成就() 函数
   * 遍历玩家所有未完成任务，将匹配 actionName 的要求值递减
   *
   * @param userId 用户ID
   * @param actionName 操作名称（必须与任务要求中的 name 完全匹配）
   * @param count 完成数量（默认1）
   * @returns 任务完成提示文本，无完成则返回空字符串
   */
  async advance(userId: number, actionName: string, count: number = 1): Promise<string> {
    if (!userId || !actionName) return '';

    try {
      const player = await this.prisma.player.findUnique({ where: { userId } });
      if (!player) return '';

      // 解析玩家任务列表（统一为新格式）
      const tasks = this.parsePlayerTasks(player.tasks);
      if (tasks.length === 0) return '';

      const completedMessages: string[] = [];
      let changed = false;

      // 第一步：递减匹配的要求
      for (const task of tasks) {
        if (task.completed || !task.requirements || task.requirements.length === 0) continue;
        // 倒序遍历，便于安全删除
        for (let j = task.requirements.length - 1; j >= 0; j--) {
          const req = task.requirements[j];
          if (req.name === actionName) {
            req.count -= count;
            changed = true;
            // 要求值归零，删除该要求（对应原版：删除成员）
            if (req.count <= 0) {
              task.requirements.splice(j, 1);
            }
          }
        }
      }

      // 第二步：检查完成情况（对应原版：取数组成员数(要求) <= 0 即完成）
      for (let i = tasks.length - 1; i >= 0; i--) {
        const task = tasks[i];
        if (task.completed) continue;
        if (task.requirements && task.requirements.length === 0) {
          await this.completeTask(userId, task.name, tasks);
          completedMessages.push(`✅ 任务完成: ${task.name}`);
          // 移除已完成任务（对应原版：删除成员(玩家.任务, ...)）
          tasks.splice(i, 1);
          changed = true;
        }
      }

      // 第三步：仅在任务发生变化时保存，避免每次指令都写库
      if (changed) {
        player.tasks = JSON.stringify(tasks);
        await this.playerService.savePlayer(player);
      }

      return completedMessages.join('\n');
    } catch (e) {
      this.logger.warn(`推进任务失败: ${e.message}`);
      return '';
    }
  }

  /**
   * 完成任务 - 发放奖励并触发后续任务
   * 对应原版：_主程序.ecode 11836~11963 行的任务完成处理逻辑
   *
   * @param userId 用户ID
   * @param taskName 已完成的任务名称
   * @param playerTasks 内存中的任务列表（会被修改：追加后续任务、推进"完成任务"要求）
   */
  private async completeTask(
    userId: number,
    taskName: string,
    playerTasks: PlayerTask[],
  ): Promise<void> {
    // 从 GameTask 定义中查找任务数据
    const gameTask = this.staticData.getTaskByName(taskName);
    if (!gameTask) {
      this.logger.warn(`任务 ${taskName} 未在 GameTask 中找到，无法发放奖励`);
      return;
    }

    // 1. 发放奖励（对应原版：遍历 奖励1 数组）
    const rewards = this.parseRewards(gameTask.rewards);
    for (const reward of rewards) {
      if (!reward.name || reward.count <= 0) continue;
      if (reward.name === '好感') {
        // 好感度奖励：加到玩家 affinity 字段
        const player = await this.prisma.player.findUnique({ where: { userId } });
        if (player) {
          const affinity = Number(player.affinity || 0) + reward.count;
          await this.prisma.player.update({ where: { userId }, data: { affinity } });
        }
      } else {
        // 物品奖励：直接添加到背包
        await this.playerService.addToBackpack(userId, reward.name, Math.round(reward.count));
      }
    }

    // 2. 发放经验奖励（按任务等级 * 50）
    const expGain = (gameTask.level || 1) * 50;
    await this.playerService.addExp(userId, expGain);

    // 3. 自动激活后续任务（对应原版：任务.任务 数组 -> 取任务奖励(r, 真)）
    const nextTaskNames = this.playerService.safeJsonParse<string[]>(gameTask.nextTasks, []);
    for (const nextName of nextTaskNames) {
      if (!nextName) continue;
      if (playerTasks.some(t => t.name === nextName)) continue;
      const nextGameTask = this.staticData.getTaskByName(nextName);
      if (!nextGameTask) continue;
      const reqs = this.playerService.safeJsonParse<Array<{ name: string; count: number }>>(
        nextGameTask.requirements, []
      );
      // 要求为空的任务（如"进阶-贸易"等条件触发型）不自动激活，避免卡住玩家
      if (reqs.length > 0) {
        playerTasks.push({
          name: nextName,
          requirements: JSON.parse(JSON.stringify(reqs)), // 深拷贝
        });
      }
    }

    // 4. 推进"完成任务"要求（对应原版：添加成就("完成任务", 1, 玩家.成就, 玩家.任务)）
    // 用于支持"套娃"、"套娃2"等以完成任务数为要求的任务
    const cascadeTasks: string[] = [];
    for (const ct of playerTasks) {
      if (ct.completed || !ct.requirements || ct.requirements.length === 0) continue;
      for (let j = ct.requirements.length - 1; j >= 0; j--) {
        if (ct.requirements[j].name === '完成任务') {
          ct.requirements[j].count -= 1;
          if (ct.requirements[j].count <= 0) {
            ct.requirements.splice(j, 1);
          }
        }
      }
      if (ct.requirements.length === 0) {
        cascadeTasks.push(ct.name);
      }
    }

    // 5. 递归完成因"完成任务"计数而满足的任务
    for (const cascadeName of cascadeTasks) {
      const idx = playerTasks.findIndex(t => t.name === cascadeName);
      if (idx >= 0) {
        playerTasks.splice(idx, 1);
        await this.completeTask(userId, cascadeName, playerTasks);
      }
    }

    // 6. 添加任务熟练度标记（对应原版：添加成就("任务熟练度", 1, 玩家.标记)）
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (player) {
      const markers = this.playerService.safeJsonParse<Record<string, number>>(player.markers, {});
      markers['任务熟练度'] = (markers['任务熟练度'] || 0) + 1;
      await this.prisma.player.update({
        where: { userId },
        data: { markers: JSON.stringify(markers) },
      });
    }

    this.logger.log(`用户 ${userId} 完成任务: ${taskName}`);
  }

  /**
   * 解析奖励列表，统一为对象格式 [{name, count}]（与 tasks.json 一致）
   */
  private parseRewards(rewardsJson: any): TaskReward[] {
    try {
      const parsed = this.playerService.safeJsonParse<any[]>(rewardsJson, []);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(r => r && typeof r === 'object')
        .map(r => ({
          name: String(r.name || ''),
          count: Number(r.count || 0),
        }));
    } catch {
      return [];
    }
  }

  /**
   * 解析玩家任务列表
   * 数据已由 migrate-player-tasks 统一为单一格式，此处只处理新格式：
   *   { name, requirements: [{name, count}], completed? }
   * 对缺失 requirements 的异常条目做规整（尝试从任务定义还原，否则丢弃），
   * 同时容忍部分历史写法（completed 用 true 或旧 status 完成态标记）。
   */
  private parsePlayerTasks(tasksJson: any): PlayerTask[] {
    try {
      const raw = typeof tasksJson === 'string' ? JSON.parse(tasksJson) : (tasksJson || []);
      if (!Array.isArray(raw)) return [];

      const result: PlayerTask[] = [];
      for (const item of raw) {
        if (!item || typeof item !== 'object' || item.name === undefined || item.name === null) continue;

        const isCompleted =
          item.completed === true ||
          item.status === '已完成' ||
          item.status === '已提交';

        // 已完成任务：requirements 置空，保留展示但不参与推进
        if (isCompleted) {
          result.push({ name: item.name, requirements: [], completed: true });
          continue;
        }

        // 进行中任务：规整 requirements（缺失时从任务定义还原，保证任务可推进）
        let reqs = Array.isArray(item.requirements)
          ? item.requirements
          : this.playerService.safeJsonParse(item.requirements, []);
        reqs = reqs
          .filter((r: any) => r && typeof r === 'object' && r.name !== undefined)
          .map((r: any) => ({ name: r.name, count: Number(r.count) || 0 }));

        if (reqs.length === 0) {
          const gameTask = this.staticData.getTaskByName(item.name);
          if (gameTask) {
            reqs = this.playerService.safeJsonParse<Array<{ name: string; count: number }>>(
              gameTask.requirements, [],
            ).map(r => ({ name: r.name, count: Number(r.count) || 0 }));
          }
        }

        if (reqs.length === 0) continue; // 无可推进要求的任务，丢弃

        result.push({ name: item.name, requirements: reqs, completed: false });
      }
      return result;
    } catch {
      return [];
    }
  }

  /**
   * 获取玩家当前可接的任务列表（未激活的 GameTask）
   */
  async getAvailableTasks(userId: number): Promise<any[]> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) return [];

    const playerTasks = this.parsePlayerTasks(player.tasks);
    const activeTaskNames = playerTasks.map(t => t.name);

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

    const playerTasks = this.parsePlayerTasks(player.tasks);
    if (playerTasks.some(t => t.name === taskName)) {
      return `你已经领取了任务「${taskName}」`;
    }

    // 复制要求列表（对应原版：取任务奖励(r, 真)）
    const reqs = this.playerService.safeJsonParse<Array<{ name: string; count: number }>>(
      gameTask.requirements, []
    );
    if (reqs.length === 0) {
      return `任务「${taskName}」没有要求，可能为条件触发型任务`;
    }

    playerTasks.push({
      name: taskName,
      requirements: JSON.parse(JSON.stringify(reqs)), // 深拷贝
    });

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

    const playerTasks = this.parsePlayerTasks(player.tasks);
    if (playerTasks.length === 0) {
      return '📋 你当前没有任何任务\n使用「领取任务」来接取任务';
    }

    const lines: string[] = ['📋 任务列表'];

    // 进行中的任务
    const activeTasks = playerTasks.filter(t => !t.completed && t.requirements.length > 0);
    if (activeTasks.length > 0) {
      lines.push('━━━ 进行中 ━━━');
      for (const task of activeTasks) {
        const gameTask = this.staticData.getTaskByName(task.name);
        lines.push(`  【${task.name}】`);
        if (gameTask?.description) lines.push(`    ${gameTask.description}`);
        // 显示每条要求的完成进度
        if (gameTask) {
          const allReqs = this.playerService.safeJsonParse<Array<{ name: string; count: number }>>(
            gameTask.requirements, []
          );
          for (const req of task.requirements) {
            const totalReq = allReqs.find(r => r.name === req.name);
            const done = totalReq ? totalReq.count - req.count : 0;
            lines.push(`    📌 ${req.name}: ${done}/${totalReq ? totalReq.count : req.count}`);
          }
        }
      }
    }

    // 已完成的任务
    const completedTasks = playerTasks.filter(t => t.completed || t.requirements.length === 0);
    if (completedTasks.length > 0) {
      lines.push('━━━ 已完成 ━━━');
      for (const task of completedTasks) {
        lines.push(`  ✅ ${task.name}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 初始化新玩家的默认任务
   * 在新玩家创建时调用，自动发放"新手教程"任务
   */
  async initNewPlayerTasks(userId: number): Promise<void> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) return;

    const playerTasks = this.parsePlayerTasks(player.tasks);
    // 已有任务则跳过（避免重复发放）
    if (playerTasks.some(t => t.name === '新手教程')) return;

    const gameTask = this.staticData.getTaskByName('新手教程');
    if (!gameTask) return;

    const reqs = this.playerService.safeJsonParse<Array<{ name: string; count: number }>>(
      gameTask.requirements, []
    );
    if (reqs.length === 0) return;

    // 追加到已有任务列表末尾
    playerTasks.push({
      name: '新手教程',
      requirements: JSON.parse(JSON.stringify(reqs)),
    });
    player.tasks = JSON.stringify(playerTasks);
    await this.playerService.savePlayer(player);
    this.logger.log(`新玩家 ${userId} 已自动领取新手教程任务`);
  }
}
