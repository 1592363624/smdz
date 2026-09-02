/**
 * 任务系统
 *
 * 原版任务没有“提交”阶段：行动通过 添加成就() 推进要求，要求清空后
 * 在同一次指令收尾中发奖、接后续任务并删除已完成任务。本服务保留旧的
 * 提交接口只用于清理存量数据，正常任务始终走自动结算。
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { StaticDataService } from './static-data.service';
import { ItemSystemService } from './item-system.service';
import { ShortcutService } from './shortcut.service';
import { PlayerMutateContextService } from './player-mutate-context.service';
import { GameHighlightService } from './highlight.service';

// 索引签名：Prisma Json 列（Prisma.InputJsonValue）要求对象具备字符串索引签名，
// 否则赋值 player.tasks 等字段时 TS2322 类型不兼容
interface TaskRequirement {
  [key: string]: any;
  name: string;
  count: number;
}

interface PlayerTask {
  [key: string]: any;
  name: string;
  requirements: TaskRequirement[];
  publisher?: string;
  completed?: boolean;
}

interface TaskReward {
  name: string;
  count: number;
  type?: string;
}

interface SettledTask {
  name: string;
  rewards: string[];
  /** 本任务完成时自动领取到的后续任务名（原版“并领取了新的任务”）。 */
  chained?: string[];
}

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);
  private readonly notifications = new Map<number, string[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly staticData: StaticDataService,
    private readonly itemSystem: ItemSystemService,
    // 查看任务的编号直达/放弃入口依赖临时输入替换（对应原版 临时输入替换）。
    // Optional：旧测试桩未提供时自动跳过。
    @Optional() private readonly shortcutService?: ShortcutService,
    // 用于在 mutate 上下文内复用同一份快照，避免被 mutate 包住时产生第二份快照。
    // Optional：旧测试桩未提供时退化为「自己读档 → 自己保存」的兼容路径。
    @Optional() private readonly mutateContext?: PlayerMutateContextService,
    /**
     * 高光时刻推送（可选依赖）。存量测试桩手工 new TaskService 时不会传入，
     * 拿不到则跳过推送，任务结算逻辑完全不变。
     */
    @Optional() private readonly highlight?: GameHighlightService,
  ) {}

  /**
   * 串行化同一玩家的任务读改写，避免并发指令丢进度或重复发奖。
   * 锁本体在 PlayerService.enqueueUserWrite（全服共享，与兑换/召唤/后台结算互斥），
   * 这里委托以保持调用点不变。
   */
  private async enqueueUserWrite<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    return this.playerService.enqueueUserWrite(userId, fn);
  }

  /**
   * 把一批已结算任务转成前端高光动画事件：
   * - 完成任务 + 奖励 → task-complete（一次结算可能同时完成多个任务，合并为一条）
   * - 自动领取的后续任务 → task-accept
   * 与 formatCompletionMessage 共用同一份 completed 数据，保证公屏文本与
   * 高光弹窗展示的内容一致。
   * @param userId 玩家 ID
   * @param completed 本轮结算出的任务列表
   */
  private emitTaskHighlight(userId: number, completed: SettledTask[]): void {
    if (!this.highlight || completed.length === 0) return;

    const names = completed.map((item) => item.name);
    // 奖励行中夹杂的“对你的好感+X”不属于物品奖励，高光里单独忽略即可
    const rewards = completed
      .flatMap((item) => item.rewards || [])
      .filter((line) => line && !line.includes('对你的好感+'));
    const chained = Array.from(
      new Set(completed.flatMap((item) => (item.chained ?? []).filter(Boolean))),
    );

    this.highlight.emit(userId, {
      type: 'task-complete',
      title: names.length > 1 ? `任务达成 ×${names.length}` : '任务达成',
      names,
      rewards,
    });

    if (chained.length > 0) {
      this.highlight.emit(userId, {
        type: 'task-accept',
        title: '新任务',
        names: chained,
      });
    }
  }

  private notify(userId: number, text: string): void {
    if (!text) return;
    const pending = this.notifications.get(userId) ?? [];
    pending.push(text);
    this.notifications.set(userId, pending);
  }

  /** 取出并清空由行动推进产生的任务通知。 */
  consumeNotifications(userId: number): string {
    const pending = this.notifications.get(userId) ?? [];
    this.notifications.delete(userId);
    return pending.join('\n');
  }

  /**
   * 对应原版 添加成就(名称, 数值, 成就, 任务)。
   * 同一个行动会推进所有任务和所有同名要求。
   */
  async advance(userId: number, actionName: string, count = 1): Promise<string> {
    if (!userId || !actionName || !Number.isFinite(count) || count <= 0) return '';

    return this.enqueueUserWrite(userId, async () => {
      try {
        // 若已在某玩家的 mutate 上下文内，直接复用那份快照，避免产生第二份快照
        // 把 mutate 的未落库改动覆盖掉（详见 docs/player-state-architecture.md）。
        const ctx = this.mutateContext?.currentFor(userId);
        const player = ctx ? ctx.player : await this.prisma.player.findUnique({ where: { userId } });
        if (!player) return '';

        const tasks = this.parsePlayerTasks(player.tasks);
        if (tasks.length === 0) return '';

        const changed = this.applyTaskProgress(tasks, actionName, count);
        const completed = await this.settleCompletedTasks(player, tasks);
        if (!changed && completed.length === 0) return '';

        player.tasks = tasks; // Player tasks 为 Json 列，直接写数组
        // 复用 ctx 时由最外层 mutate 统一落库；否则单独保存（向后兼容）。
        if (!ctx) {
          await this.saveTaskState(player, [
            'tasks', 'markers', 'backpack', 'recipes', 'exp', 'level', 'upgradeExp',
            'hp', 'maxHp', 'shield', 'maxShield', 'armor', 'maxArmor', 'attack',
            'hit', 'dodge', 'speed', 'crit', 'critDmg', 'regenHp', 'regenShield',
            'regenArmor', 'vitality', 'affinity',
          ]);
        }

        const message = this.formatCompletionMessage(completed);
        this.notify(userId, message);
        this.emitTaskHighlight(userId, completed);
        return message;
      } catch (error: any) {
        this.logger.warn(`推进任务失败: ${error?.message || error}`);
        return '';
      }
    });
  }

  /**
   * 兼容旧版“已完成/待提交”存档。新格式任务不会进入这里，因为完成时
   * 已经自动发放奖励并从列表删除。
   */
  async completePendingTask(userId: number, taskName: string): Promise<string> {
    if (!taskName) return '请指定任务名称，格式：提交任务 任务名';

    return this.enqueueUserWrite(userId, async () => {
      const ctx = this.mutateContext?.currentFor(userId);
      const player = ctx ? ctx.player : await this.prisma.player.findUnique({ where: { userId } });
      if (!player) return '玩家数据不存在';

      const raw = this.parseRawTasks(player.tasks);
      const parsedTasks = this.parsePlayerTasks(raw);
      const taskIndex = this.resolveTaskIndex(parsedTasks, taskName);
      const actualTaskName = taskIndex >= 0 ? parsedTasks[taskIndex].name : this.cleanName(taskName);
      const rawTask = raw.find((item: any) => this.taskName(item) === actualTaskName);
      if (!rawTask) return `你当前没有接取「${actualTaskName || taskName}」任务；正常任务完成后奖励会自动发放`;

      const isLegacyCompleted = rawTask.completed === true
        || rawTask.status === '已完成'
        || rawTask.status === '已提交';
      if (!isLegacyCompleted) {
        const current = parsedTasks.find((task) => task.name === actualTaskName);
        const remaining = current?.requirements.map((r) => `${r.name}(${r.count})`).join('，') || '未知';
        return `【${actualTaskName}】任务还未完成，当前剩余要求：${remaining}`;
      }

      const tasks = parsedTasks;
      const index = tasks.findIndex((task) => task.name === actualTaskName);
      if (index < 0) return `任务「${actualTaskName}」数据无效，无法结算`;

      const publisher = tasks[index].publisher;
      tasks.splice(index, 1);
      // 原版一轮任务结算只在进入循环时计算一次奖励倍率，后续任务
      // 即使因“完成任务”级联完成，也继续使用同一个倍率。
      const rewardScale = this.getRewardScale(this.parseObject(player.markers, {}));
      const { rewardLines, chained } = await this.settleOneTask(player, tasks, actualTaskName, publisher, rewardScale);
      this.applyTaskProgress(tasks, '完成任务', 1);
      const chainedSettled = await this.settleCompletedTasks(player, tasks, rewardScale);
      player.tasks = tasks; // Player tasks 为 Json 列，直接写数组
      if (!ctx) {
        await this.saveTaskState(player, [
          'tasks', 'markers', 'backpack', 'recipes', 'exp', 'level', 'upgradeExp',
          'hp', 'maxHp', 'shield', 'maxShield', 'armor', 'maxArmor', 'attack',
          'hit', 'dodge', 'speed', 'crit', 'critDmg', 'regenHp', 'regenShield',
          'regenArmor', 'vitality', 'affinity',
        ]);
      }

      const message = this.formatCompletionMessage([
        { name: actualTaskName, rewards: rewardLines, chained },
        ...chainedSettled,
      ]);
      this.notify(userId, message);
      this.emitTaskHighlight(userId, [
        { name: actualTaskName, rewards: rewardLines, chained },
        ...chainedSettled,
      ]);
      return message;
    });
  }

  /**
   * 统一结算队列。任务从列表移除后再加“完成任务”计数，保证级联任务
   * 和同一行动完成的多个任务都只结算一次。
   */
  private async settleCompletedTasks(
    player: any,
    tasks: PlayerTask[],
    rewardScale = this.getRewardScale(this.parseObject(player.markers, {})),
  ): Promise<SettledTask[]> {
    const initial = tasks
      .filter((task) => !task.completed && task.requirements.length === 0)
      .map((task) => task.name);
    const queue = [...new Set(initial)];
    const queued = new Set(queue);
    const completed: SettledTask[] = [];

    const enqueue = (name: string) => {
      if (!queued.has(name)) {
        queued.add(name);
        queue.push(name);
      }
    };

    while (queue.length > 0) {
      const taskName = queue.shift() as string;
      const index = tasks.findIndex((task) => task.name === taskName);
      if (index < 0) continue;

      const task = tasks[index];
      if (task.completed || task.requirements.length > 0) continue;
      const publisher = task.publisher;
      tasks.splice(index, 1);
      const { rewardLines, chained } = await this.settleOneTask(player, tasks, taskName, publisher, rewardScale);
      completed.push({ name: taskName, rewards: rewardLines, chained });

      // 原版在加入后续任务后调用 添加成就("完成任务")，所以新任务也
      // 能收到本次完成计数。奖励内部产生的动作同样可能清空其他任务。
      this.applyTaskProgress(tasks, '完成任务', 1);
      for (const other of tasks) {
        if (!other.completed && other.requirements.length === 0) enqueue(other.name);
      }
    }

    return completed;
  }

  /** 结算一个任务：奖励、后续任务、配方、熟练度和经验都改在同一 player 对象。 */
  private async settleOneTask(
    player: any,
    tasks: PlayerTask[],
    taskName: string,
    publisher?: string,
    rewardScale = this.getRewardScale(this.parseObject(player.markers, {})),
  ): Promise<{ rewardLines: string[]; chained: string[] }> {
    const gameTask = this.getTaskDefinition(taskName);
    if (!gameTask) {
      this.logger.warn(`任务 ${taskName} 未在静态任务定义中找到`);
      return { rewardLines: [], chained: [] };
    }

    const markers = this.parseObject(player.markers, {});
    const backpack = this.parseArray(player.backpack);
    const rewardLines: string[] = [];

    for (const reward of this.parseRewards(gameTask.rewards)) {
      if (!reward.name || reward.count <= 0) continue;
      const amount = reward.count * rewardScale;
      const rewardName = this.cleanName(reward.name);

      if (rewardName === '好感') {
        const affinity = await this.addPublisherAffinity(player, publisher, amount);
        if (affinity.applied) {
          // 原版把好感奖励追加为独立行：“白对你的好感+5”。
          const label = affinity.npcName ? `${affinity.npcName}对你的好感` : '好感';
          rewardLines.push(`${label}+${this.formatNumber(amount)}`);
        } else {
          rewardLines.push('好感未增加');
        }
      } else if (rewardName === '活力') {
        player.vitality = Number(player.vitality || 0) + amount;
        rewardLines.push(`活力×${this.formatNumber(amount)}`);
      } else if (this.isEquipmentReward(rewardName, reward.type)) {
        // 原版任务奖励中的装备数量不是堆叠数量，而是百分比概率；命中后只生成一件。
        if (Math.random() * 100 >= amount) continue;
        const equipment = await this.itemSystem.generateRewardEquipment(rewardName);
        this.addEquipmentReward(backpack, equipment);
        rewardLines.push(`${rewardName}x1`);
        this.applyTaskProgress(tasks, '获得装备', 1);
        this.applyTaskProgress(tasks, `获得${rewardName}`, 1);
      } else {
        this.addBackpackItem(backpack, rewardName, amount, reward.type);
        // 原版奖励文案为 名称x数量（小写x，_主程序.ecode L12046 附近 w2 拼接）。
        rewardLines.push(`${rewardName}x${this.formatNumber(amount)}`);
        // 对齐原版任务结算中的 添加成就("采集资源") / 添加成就("采集" + 物品名)。
        this.applyTaskProgress(tasks, '采集资源', 1);
        this.applyTaskProgress(tasks, `采集${rewardName}`, amount);
      }
    }

    player.backpack = backpack; // Player backpack 为 Json 列，直接写数组

    const nextTaskNames = this.parseStringArray(gameTask.nextTasks);
    const chainedNames: string[] = [];
    for (const nextName of nextTaskNames) {
      if (!nextName || tasks.some((task) => task.name === nextName)) continue;
      const next = this.staticData.getTaskByName(nextName);
      if (!next) continue;
      const requirements = this.parseRequirements(next.requirements);
      if (requirements.length === 0 && !this.hasRequirementEntries(next.requirements)) continue;
      tasks.push({
        name: nextName,
        requirements: this.cloneRequirements(requirements),
        ...(publisher ? { publisher } : {}),
      });
      chainedNames.push(nextName);
    }

    if (taskName.startsWith('解锁配方')) {
      const recipeName = taskName.slice('解锁配方'.length).trim();
      if (recipeName) {
        const recipes = this.getUnlockedRecipeNames(player.recipes);
        if (!recipes.includes(recipeName)) {
          recipes.push(recipeName);
          player.recipes = recipes; // Player recipes 为 Json 列，直接写数组
        }
        markers['解锁配方'] = Number(markers['解锁配方'] || 0) + 1;
        this.applyTaskProgress(tasks, '解锁配方', 1);
      }
    }

    markers['完成任务'] = Number(markers['完成任务'] || 0) + 1;
    markers['任务熟练度'] = Number(markers['任务熟练度'] || 0) + 1;
    // 对齐原版“活跃度”子程序：活跃度同时推进任务，并记录历史活跃度
    // 与当前使魔类型好感。这里直接修改内存中的任务数组，避免在任务锁内
    // 再次调用 advance 造成自锁。
    this.applyTaskProgress(tasks, '活跃度', 3);
    markers['活跃度'] = Number(markers['活跃度'] || 0) + 3;
    markers['历史活跃度'] = Number(markers['历史活跃度'] || 0) + 3;
    const playerType = this.cleanName(player.type);
    if (playerType) {
      const affinityKey = `${playerType}好感`;
      markers[affinityKey] = Number(markers[affinityKey] || 0) + 0.03;
    }
    player.markers = markers; // Player markers 为 Json 列，直接写对象
    return { rewardLines, chained: chainedNames };
  }

  /**
   * 完成提示（对齐原版 _主程序.ecode L11960-11972）：
   * “完成了任务:A、B，得到了:奖励1、奖励2\n并领取了新的任务:X、Y”。
   * 奖励数量为按任务熟练度加成后的实发数量（如 优秀武器补给箱x1.02）。
   */
  private formatCompletionMessage(completed: SettledTask[]): string {
    if (completed.length === 0) return '';
    const names = completed.map((item) => item.name).join('、');
    const rewards: string[] = [];
    const affinityLines: string[] = [];
    for (const item of completed) {
      for (const line of item.rewards) {
        if (line.includes('对你的好感+')) affinityLines.push(line);
        else rewards.push(line);
      }
    }
    const chainedNames = completed.flatMap((item) => item.chained ?? []);
    let text = rewards.length > 0
      ? `完成了任务:${names}，得到了:${rewards.join('、')}`
      : `完成了任务:${names}，`;
    for (const line of affinityLines) text += `\n${line}`;
    if (chainedNames.length > 0) text += `\n并领取了新的任务:${chainedNames.join('、')}`;
    return text;
  }

  /**
   * 任务定义同时覆盖静态任务和原版运行时生成的配方解锁任务。
   * 配方任务不写入 tasks.json，而是用“解锁配方+配方名”作为稳定的任务名，
   * 这样旧存档、查看详情和自动结算都能走同一条任务链。
   */
  private getTaskDefinition(taskName: string): any | undefined {
    const staticTask = this.staticData.getTaskByName(taskName);
    if (staticTask) return staticTask;

    const prefix = '解锁配方';
    if (!taskName.startsWith(prefix)) return undefined;
    const recipeName = taskName.slice(prefix.length).trim();
    if (!recipeName) return undefined;

    const recipe = this.getRecipeDefinition(recipeName);
    if (!recipe) return undefined;
    return {
      name: taskName,
      description: `完成这个任务即可${taskName}`,
      requirements: recipe.unlockRequirements ?? recipe.解锁需求 ?? [],
      rewards: '[]',
      nextTasks: '[]',
    };
  }

  private getAllVehicleRecipes(): any[] {
    const api = this.staticData as any;
    const recipes = typeof api.getAllVehicleRecipes === 'function'
      ? api.getAllVehicleRecipes()
      : [];
    return Array.isArray(recipes) ? recipes : [];
  }

  private getRecipeDefinition(recipeName: string): any | undefined {
    const api = this.staticData as any;
    if (typeof api.getVehicleRecipeByName === 'function') {
      const recipe = api.getVehicleRecipeByName(recipeName);
      if (recipe) return recipe;
    }
    return this.getAllVehicleRecipes().find((recipe) =>
      this.cleanName(recipe?.name ?? recipe?.名称) === this.cleanName(recipeName),
    );
  }

  /** 将数组和旧版“配方名 -> 熟练度”的对象格式统一成配方名称列表。 */
  private getUnlockedRecipeNames(value: any): string[] {
    let parsed = value;
    if (typeof parsed === 'string') {
      if (!parsed.trim()) return [];
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return [];
      }
    }

    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map((item) => this.taskName(item)).filter(Boolean))];
    }
    if (parsed && typeof parsed === 'object') {
      return [...new Set(Object.entries(parsed)
        .filter(([, proficiency]) => Number(proficiency) !== 0)
        .map(([name]) => this.cleanName(name))
        .filter(Boolean))];
    }
    return [];
  }

  private countUnlockedRecipesAtOrAbove(unlockedNames: string[], minLevel: number): number {
    if (minLevel <= 0) return unlockedNames.length;
    return [...new Set(unlockedNames)].filter((name) => {
      const recipe = this.getRecipeDefinition(name);
      const level = Number(recipe?.level ?? recipe?.等级 ?? 0);
      return Number.isFinite(level) && level >= minLevel;
    }).length;
  }

  private canUnlockRecipe(recipe: any, unlockedNames: string[]): boolean {
    const level = Number(recipe?.level ?? recipe?.等级 ?? 1);
    if (!Number.isFinite(level) || level <= 1) return true;
    return this.countUnlockedRecipesAtOrAbove(unlockedNames, level - 1) >= level;
  }

  private getRewardScale(markers: Record<string, any>): number {
    const mastery = Math.max(0, Number(markers['任务熟练度'] || 0));
    let level = 1;
    while (mastery >= level * level) level += 1;
    return (1 + level / 100) * (1 + Number(markers['完成任务'] || 0) / 200);
  }

  private isEquipmentReward(name: string, type?: string): boolean {
    // 任务奖励中的“数量”对装备表示掉落概率；未标记类型的装备名仍按
    // 堆叠物品处理，例如“麻醉枪×100”和“隐形披风×100”。
    return type === '装备' || type === 'equipment';
  }

  private addEquipmentReward(backpack: any[], equipment: any): void {
    backpack.push({
      ...equipment,
      type: '装备',
      quantity: 1,
      count: 1,
      durability: Number(equipment?.durability || 0),
    });
  }

  private addBackpackItem(backpack: any[], name: string, count: number, type?: string): void {
    const existing = backpack.find((item: any) => this.taskName(item) === name);
    if (existing) {
      const current = Number(existing.count ?? existing.quantity ?? 0);
      const next = current + count;
      // 新版物品系统读取 quantity，旧存档/旧展示读取 count；任务奖励
      // 同时保留两者，避免奖励入包后无法制造、使用或显示。
      existing.count = next;
      existing.quantity = next;
      return;
    }
    backpack.push({
      name,
      count,
      quantity: count,
      type: type || '资源',
    });
  }

  /**
   * 好感奖励优先写入任务发布 NPC/召唤物，并复刻原版达到100好感时的归属切换。
   * 找不到运行时发布人时回退到玩家字段，兼容旧存档中没有发布人信息的任务。
   * @returns applied 是否写入；npcName 命中的 NPC 名称（用于“白对你的好感+N”文案）。
   */
  private async addPublisherAffinity(
    player: any,
    publisher: string | undefined,
    amount: number,
  ): Promise<{ applied: boolean; npcName?: string }> {
    const mapsApi = (this.prisma as any).gameMap;
    if (publisher && mapsApi?.findMany) {
      const maps = await mapsApi.findMany();
      for (const map of maps || []) {
        for (const field of ['summons', 'npcs']) {
          const units = this.parseArray(map[field]);
          const npc = units.find((item: any) => String(
            item?.qq ?? item?.QQ ?? item?.id ?? item?.编号 ?? '',
          ) === String(publisher));
          if (!npc) continue;

          const npcName = String(npc?.name ?? npc?.名称 ?? '') || undefined;
          const npcMarkers = this.parseObject(npc.markers ?? npc.标记, {});
          const currentKey = `好感${player.userId}`;
          const otherHasMaxAffinity = Object.entries(npcMarkers).some(([key, value]) =>
            key.startsWith('好感') && key !== currentKey && Number(value) >= 100,
          );
          if (otherHasMaxAffinity) return { applied: false, npcName };

          const currentAffinity = Number(npcMarkers[currentKey] || 0);
          const nextAffinity = currentAffinity + amount;
          npcMarkers[currentKey] = nextAffinity;
          if (npc.markers !== undefined) npc.markers = npcMarkers; // Json 列直接写对象
          else npc.标记 = npcMarkers;

          const owner = String(npc.ownerQQ ?? npc.ownerId ?? npc.归属 ?? '');
          if (nextAffinity >= 100 && owner !== String(player.userId)) {
            for (const key of Object.keys(npcMarkers)) {
              if (key.startsWith('好感') && key !== currentKey) delete npcMarkers[key];
            }
            npc.ownerQQ = String(player.userId);
            npc.归属 = String(player.userId);
            if (npc.markers !== undefined) npc.markers = npcMarkers; // Json 列直接写对象
            else npc.标记 = npcMarkers;
          }

          if (mapsApi.update) {
            // GameMap Json 列（npcs/monsters/summons 等）直接写数组
            await mapsApi.update({ where: { id: map.id }, data: { [field]: units } });
          }
          return { applied: true, npcName };
        }
      }
    }
    player.affinity = Number(player.affinity || 0) + amount;
    return { applied: true };
  }

  /** 修改所有当前任务的同名要求；不触发数据库写入，供任务奖励级联使用。 */
  private applyTaskProgress(tasks: PlayerTask[], actionName: string, count: number): boolean {
    if (!actionName || !Number.isFinite(count) || count <= 0) return false;
    const normalizedAction = this.cleanName(actionName);
    let changed = false;
    for (const task of tasks) {
      if (task.completed || task.requirements.length === 0) continue;
      for (let i = task.requirements.length - 1; i >= 0; i--) {
        const requirement = task.requirements[i];
        if (requirement.name !== normalizedAction) continue;
        requirement.count -= count;
        changed = true;
        if (requirement.count <= 0) task.requirements.splice(i, 1);
      }
    }
    return changed;
  }

  /** 获取当前可领取任务；allowedNames 由当前地图 NPC 任务池提供。 */
  async getAvailableTasks(
    userId: number,
    allowedNames?: string[],
    publisher?: string,
  ): Promise<any[]> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) return [];

    const tasks = this.parsePlayerTasks(player.tasks);
    const activeNames = new Set(tasks.map((task) => task.name));
    const allowed = allowedNames ? new Set(allowedNames) : undefined;
    const markers = this.parseObject(player.markers, {});
    return this.staticData.getAllTasks().filter((task: any) => {
      if (!task?.name || activeNames.has(task.name)) return false;
      if (allowed && !allowed.has(task.name)) return false;
      if (publisher && tasks.some((item) => item.publisher === publisher)) return false;
      if (Number(player.level || 1) < Number(task.level || 1)) return false;
      if (Number(task.chance ?? 100) < 100 && Math.random() * 100 >= Number(task.chance)) return false;
      return this.canAcceptByMarkers(task.restrictMarkers, markers);
    });
  }

  /**
   * 领取任务并保存统一格式 {name, requirements, publisher}。
   * @param npcName 从 NPC 对话领取时传 NPC 名，输出原版格式
   *                （“能帮我个忙吗？…接受了任务X”，_主程序.ecode L7393-7400）。
   */
  async acceptTask(userId: number, taskName: string, publisher?: string, npcName?: string): Promise<string> {
    if (!taskName) return '请指定任务名称，格式：领取任务 任务名';

    return this.enqueueUserWrite(userId, async () => {
      const gameTask = this.staticData.getTaskByName(taskName);
      if (!gameTask) return `任务「${taskName}」不存在`;
      const player = await this.prisma.player.findUnique({ where: { userId } });
      if (!player) return '玩家数据不存在';

      const tasks = this.parsePlayerTasks(player.tasks);
      if (tasks.some((task) => task.name === taskName)) return `你已经领取了任务「${taskName}」`;
      if (Number(player.level || 1) < Number(gameTask.level || 1)) {
        return `等级不足，需要 ${gameTask.level || 1} 级才能领取「${taskName}」`;
      }

      const markers = this.parseObject(player.markers, {});
      if (!this.canAcceptByMarkers(gameTask.restrictMarkers, markers)) {
        return `当前标记条件不允许领取任务「${taskName}」`;
      }

      const actualPublisher = publisher || String(gameTask.publisher || '') || undefined;
      if (actualPublisher && tasks.some((task) => task.publisher === actualPublisher)) {
        return npcName
          ? `${player.name || ''}你已经领取了${npcName}的任务了，先去完成吧`
          : '你已经领取了该发布人的任务，请先完成当前任务';
      }

      const requirements = this.parseRequirements(gameTask.requirements);
      if (requirements.length === 0 && !this.hasRequirementEntries(gameTask.requirements)) {
        return `任务「${taskName}」没有可推进的要求`;
      }
      tasks.push({
        name: taskName,
        requirements: this.cloneRequirements(requirements),
        ...(actualPublisher ? { publisher: actualPublisher } : {}),
      });
      // 原版领取任务后立即写入“领取任务”成就，因此只要求领取一次的
      // 任务可以在同一条指令中自动结算并领取后续任务。
      this.applyTaskProgress(tasks, '领取任务', 1);
      markers['领取任务'] = Number(markers['领取任务'] || 0) + 1;
      player.markers = markers; // Player markers 为 Json 列，直接写对象
      const completed = await this.settleCompletedTasks(player, tasks);
      player.tasks = tasks; // Player tasks 为 Json 列，直接写数组
      await this.saveTaskState(player, [
        'tasks', 'markers', 'backpack', 'recipes', 'exp', 'level', 'upgradeExp',
        'hp', 'maxHp', 'shield', 'maxShield', 'armor', 'maxArmor', 'attack',
        'hit', 'dodge', 'speed', 'crit', 'critDmg', 'regenHp', 'regenShield',
        'regenArmor', 'vitality', 'affinity',
      ]);
      const completion = this.formatCompletionMessage(completed);
      this.emitTaskHighlight(userId, completed);
      if (npcName) {
        // 原版领取任务文案（_主程序.ecode L7395）：图片+名称+能帮我个忙吗+说明+接受了任务X，
        // 并设置“1@查看任务”临时输入。
        if (this.shortcutService) {
          await this.shortcutService.setTempInput(userId, '1@查看任务').catch(() => undefined);
        }
        const lines = [
          `【${npcName}】`,
          `${npcName}`,
          '能帮我个忙吗？',
          `${gameTask.description || ''}`,
          `接受了任务${taskName}`,
        ].filter((line) => line.trim().length > 0);
        return completion ? `${lines.join('\n')}\n${completion}` : lines.join('\n');
      }
      return `✅ 已领取任务: ${taskName}\n${gameTask.description || ''}${completion ? `\n${completion}` : ''}`;
    });
  }

  /**
   * 原版“配方解锁”不是静态任务，而是根据载具生产配方即时生成任务。
   * 任务完成后由统一结算链把配方写入玩家.recipes。
   */
  async acceptRecipeUnlockTask(userId: number, selector = ''): Promise<string> {
    return this.enqueueUserWrite(userId, async () => {
      const player = await this.prisma.player.findUnique({ where: { userId } });
      if (!player) return '玩家数据不存在';

      const recipes = this.getAllVehicleRecipes();
      const unlockedNames = this.getUnlockedRecipeNames(player.recipes);
      const candidates = recipes.filter((recipe) =>
        recipe?.name && !unlockedNames.includes(String(recipe.name)) && this.canUnlockRecipe(recipe, unlockedNames),
      );
      if (!selector) {
        if (candidates.length === 0) return `${player.name || '冒险者'}当前没有可以解锁的配方`;
        const lines = [`${player.name || '冒险者'}你现在有下列可以解锁的配方：`];
        for (const recipe of candidates) {
          lines.push(`${recipes.indexOf(recipe) + 1}、${recipe.name}（${Number(recipe.level || 1)}级）`);
        }
        lines.push('使用“配方解锁 配方名”领取对应的解锁任务。');
        return lines.join('\n');
      }

      const normalized = this.cleanName(selector);
      let recipe = /^\d+$/.test(normalized)
        ? recipes[Number(normalized) - 1]
        : recipes.find((item) => String(item?.name || '') === normalized);
      if (!recipe && /^\d+$/.test(normalized)) recipe = candidates[Number(normalized) - 1];
      if (!recipe?.name) return `没有找到名为「${selector}」的配方`;
      const recipeName = String(recipe.name);
      if (unlockedNames.includes(recipeName)) return `${player.name || '冒险者'}你已经解锁了[${recipeName}]这个配方了.`;
      if (!this.canUnlockRecipe(recipe, unlockedNames)) {
        const level = Number(recipe.level || 1);
        const ownedCount = this.countUnlockedRecipesAtOrAbove(unlockedNames, level - 1);
        return `${player.name || '冒险者'}想要接取解锁${recipeName}的任务的话，你必须先拥有至少${level}个${level - 1}级的配方，你只有${ownedCount}个`;
      }

      const tasks = this.parsePlayerTasks(player.tasks);
      const taskName = `解锁配方${recipeName}`;
      if (tasks.some((task) => task.name === taskName)) {
        return `${player.name || '冒险者'}你已经领取过解锁${recipeName}的任务了`;
      }
      const activeUnlockCount = tasks.filter((task) => task.name.startsWith('解锁配方')).length;
      const maxUnlockTasks = unlockedNames.includes('生产加速4') ? 2 : 1;
      if (activeUnlockCount >= maxUnlockTasks) {
        return activeUnlockCount >= 2
          ? `${player.name || '冒险者'}你已经领取了两个解锁配方的任务。`
          : `${player.name || '冒险者'}一次只能领取一个解锁配方的任务。\n你可以选择优先解锁[生产加速4]这个配方，它可以提高可同时接取的配方解锁任务的上限。`;
      }

      const requirements = this.parseRequirements(recipe.unlockRequirements ?? recipe.解锁需求);
      if (requirements.length === 0) return `配方「${recipeName}」没有可用的解锁要求`;
      tasks.push({ name: taskName, requirements });
      player.tasks = tasks; // Player tasks 为 Json 列，直接写数组
      await this.saveTaskState(player, ['tasks']);
      return `${player.name || '冒险者'}领取了${taskName}的任务\n完成这个任务即可${taskName}`;
    });
  }

  /**
   * 查看任务（对应原版 _主程序.ecode L5573-5593）：
   * - 无编号：输出“你现在接受了以下任务”+ 编号名单，并设置数字临时输入直达 查看任务N；
   * - 带编号/名称：输出单条任务详情（原版 显示任务，数据显示.ecode L414-456），
   *   尾部追加“a、放弃此任务”入口并设置 a@放弃任务N 临时输入。
   */
  async listTasks(userId: number, selector = ''): Promise<string> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) return '玩家数据不存在';
    const tasks = this.parsePlayerTasks(player.tasks);

    if (selector) {
      const index = this.resolveTaskIndex(tasks, selector);
      if (index < 0) return `你只有${tasks.length}个任务。`;
      const markers = this.parseObject(player.markers, {});
      // 解码原版 L5589-5591 会在详情尾部追加“a、放弃此任务”并设置 a@放弃任务N
      // 临时输入，但实际游玩版本（参照玩家提供的原版游玩记录）不含该入口，故不输出；
      // 放弃任务指令本身（放弃任务 序号/名称）仍按原版可用。
      return (await this.formatTaskDetails(
        tasks[index],
        this.getTaskDefinition(tasks[index].name),
        markers,
        index + 1,
        player.name,
      )).join('\n');
    }

    if (tasks.length === 0) return '你还没有接受任何任务，去找地图上的NPC看看吧';

    if (this.shortcutService) {
      const tempGroups = tasks.map((_, i) => `${i + 1}@查看任务${i + 1}`).join('#');
      await this.shortcutService.setTempInput(userId, tempGroups);
    }
    const lines = ['你现在接受了以下任务'];
    // 发布人标注需查运行时地图：整个列表只查一次 DB，逐条任务复用
    const publisherMaps = await this.loadPublisherMaps();
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      lines.push(`${index + 1}、${task.name}${await this.publisherLabel(task.publisher, true, publisherMaps)}`);
    }
    return lines.join('\n');
  }

  /** 原版查看任务使用1-based序号，名称输入作为兼容扩展保留。 */
  private resolveTaskIndex(tasks: PlayerTask[], selector: string): number {
    const normalized = this.cleanName(selector);
    if (!normalized) return -1;
    if (/^\d+$/.test(normalized)) {
      const index = Number(normalized) - 1;
      return index >= 0 && index < tasks.length ? index : -1;
    }
    return tasks.findIndex((task) => task.name === normalized);
  }

  /**
   * 任务详情（对应原版 数据显示.ecode L414-456 显示任务）：
   * {玩家名}/{任务名}/{说明}/◆需要要求/·完成可获得奖励(按任务熟练度与完成任务数加成)/自动发放说明。
   */
  private async formatTaskDetails(
    task: PlayerTask,
    definition: any,
    markers: Record<string, any>,
    index: number,
    playerName?: string,
  ): Promise<string[]> {
    const lines: string[] = [];
    lines.push(String(playerName ?? ''));
    lines.push(`${task.name}`);
    if (definition?.description) lines.push(`${definition.description}`);
    for (const requirement of task.requirements) {
      const count = Number(requirement.count);
      lines.push(count === 1
        ? `◆需要${requirement.name}`
        : `◆需要${requirement.name}x${this.formatNumber(count)}`);
    }
    // 原版取发布人空值返回空串且直接拼接（不加换行），此处仅在非空时输出
    const publisherLine = await this.publisherLabel(task.publisher, false);
    if (publisherLine) lines.push(publisherLine);
    const rewards = this.parseRewards(definition?.rewards);
    lines.push(`·完成可获得:${rewards
      .map((reward) => `${reward.name}x${this.formatNumber(reward.count * this.getRewardScale(markers))}`)
      .join('、')}`);
    lines.push('·完成任务后奖励自动发放。');
    // 对齐原版 数据显示.ecode L452-454：任务文本含"采集"时追加说明
    const fullText = lines.join('\n');
    if (fullText.includes('采集')) {
      lines.push('·击杀怪物掉落资源、从地上拾取不是玩家丢弃的资源，也属于[采集]行为');
    }
    return lines;
  }

  /**
   * 发布人标注（对应原版 数据分析.ecode L229-250 取发布人）：
   * 发布人为空返回空串；在地图召唤物/NPC 中按 qq 找到发布人时，nameOnly 返回“(名称)”、
   * 详情模式返回“·来自:名称(地图名)”；找不到时 nameOnly 返回空串、
   * 详情模式返回“·来自:{qq}(对象已不存在)”。
   * 「白」等运行时召唤物存于 DB GameMap（summons/npcs 为动态字段，静态 maps.json
   * 不含任何带 qq 的单位），因此实时查找以 DB 为准；匹配口径与 addPublisherAffinity
   * 一致（qq/QQ/id/编号），旧测试桩缺 gameMap 时退回静态定义查找。
   */
  private async publisherLabel(
    publisher: string | undefined,
    nameOnly: boolean,
    publisherMaps?: any[],
  ): Promise<string> {
    const qq = String(publisher ?? '').trim();
    if (!qq) return '';
    const maps = publisherMaps ?? await this.loadPublisherMaps();
    for (const map of maps as any[]) {
      for (const field of ['summons', 'npcs']) {
        const units = typeof map?.[field] === 'string'
          ? this.parseAnyArray(map[field])
          : (Array.isArray(map?.[field]) ? map[field] : []);
        for (const unit of units || []) {
          if (String(unit?.qq ?? unit?.QQ ?? unit?.id ?? unit?.编号 ?? '') !== qq) continue;
          const name = String(unit?.name ?? unit?.名称 ?? '');
          return nameOnly ? `(${name})` : `\n·来自:${name}(${map?.name ?? ''})`;
        }
      }
    }
    return nameOnly ? '' : `\n·来自:${qq}(对象已不存在)`;
  }

  /**
   * 发布人查找用的地图列表：优先 DB 实时地图（只取名称与单位两列，避免整行 JSON）；
   * 旧测试桩无 gameMap 或查询失败时退回静态定义。
   */
  private async loadPublisherMaps(): Promise<any[]> {
    const mapsApi = (this.prisma as any).gameMap;
    if (typeof mapsApi?.findMany === 'function') {
      const dbMaps = await mapsApi
        .findMany({ select: { name: true, summons: true, npcs: true } })
        .catch(() => undefined);
      if (Array.isArray(dbMaps)) return dbMaps;
    }
    const getAllMaps = (this.staticData as any)?.getAllMaps;
    return typeof getAllMaps === 'function' ? (getAllMaps.call(this.staticData) || []) : [];
  }

  /** 原版新玩家首次行动按教程标记门槛依次加入新手教程和进阶教程。 */
  async ensureTutorialTasks(userId: number): Promise<string[]> {
    return this.enqueueUserWrite(userId, async () => {
      // 读「活态」玩家而非直查 prisma：当本调用处于 P2 mutate 管道（enqueueUserWrite）内时，
      // selectFamiliar 的 savePlayer 仅标脏、未即时落库，直查 DB 会拿到 type 为空的旧快照，
      // 导致教程任务不领取（onboarding 回归）。getPlayerData 在邮箱内返回活态内存态
      // （type 已设），写回也经 savePlayer（Actor 感知），随外层 run 统一落库，不被陈旧快照覆盖。
      const playerData = await this.playerService.getPlayerData(userId);
      const player = playerData.player;
      if (!player) return [];
      // 未开局（尚未选择第一个使魔）不领取：原版新玩家指令在开局确认前提前返回，
      // 教程领取发生在“选择使魔确认”当次结算（_主程序.ecode L11686-11706），
      // 由 selectFamiliar 确认分支主动触发并展示领取提示。
      if (!player.type) return [];
      const tasks = this.parsePlayerTasks(player.tasks);
      const markers = this.parseObject(player.markers, {});
      const added: string[] = [];
      const tutorialValue = Number(markers['教程'] || 0);
      let markerChanged = false;

      if (tutorialValue < 2) {
        const definition = this.staticData.getTaskByName('新手教程');
        if (definition && !tasks.some((task) => task.name === '新手教程')) {
          const requirements = this.parseRequirements(definition.requirements);
          if (this.hasRequirementEntries(definition.requirements)) {
            tasks.push({ name: '新手教程', requirements: this.cloneRequirements(requirements) });
            added.push('新手教程');
          }
        }
        if (Number(markers['教程'] || 0) < 2) {
          markers['教程'] = 2;
          markerChanged = true;
        }
      }

      if (Number(markers['教程'] || 0) < 3 && !tasks.some((task) => task.name === '进阶教程')) {
        const definition = this.staticData.getTaskByName('进阶教程');
        if (definition) {
          const requirements = this.parseRequirements(definition.requirements);
          if (this.hasRequirementEntries(definition.requirements)) {
            tasks.push({ name: '进阶教程', requirements: this.cloneRequirements(requirements) });
            added.push('进阶教程');
            markers['教程'] = 3;
            markerChanged = true;
          }
        }
      }

      // 先把教程标记写入内存对象，再结算可能立即完成的任务，避免结算
      // 在 player.markers 上产生的“完成任务/活跃度”被旧快照覆盖。
      player.markers = markers; // Player markers 为 Json 列，直接写对象
      const completed = await this.settleCompletedTasks(player, tasks);
      if (added.length > 0 || markerChanged || completed.length > 0) {
        player.tasks = tasks; // Player tasks 为 Json 列，直接写数组
        // 标脏而非直调 savePlayer：本方法恒在 playerMutate.mutate / Actor run 内被调用
        // （command.service、selectFamiliar、game.service 三处调用点均已包裹）。此处只是
        // 把"已改动"信号透传给最外层 run 的落库策略（markDirty 让其按 writeThrough 落库），
        // 不新增裸 savePlayer 调用点（架构门禁友好），也避免内层只标脏不落的语义误解。
        this.playerService.markPlayerDirty(userId);
      }
      return added;
    });
  }

  /** 保留旧调用名，供选择使魔流程使用。 */
  async initNewPlayerTasks(userId: number): Promise<void> {
    await this.enqueueUserWrite(userId, async () => {
      const player = await this.prisma.player.findUnique({ where: { userId } });
      if (!player) return;
      const tasks = this.parsePlayerTasks(player.tasks);
      const definition = this.staticData.getTaskByName('新手教程');
      if (!definition || tasks.some((task) => task.name === '新手教程')) return;
      const requirements = this.parseRequirements(definition.requirements);
      if (!this.hasRequirementEntries(definition.requirements)) return;
      const markers = this.parseObject(player.markers, {});
      tasks.push({ name: '新手教程', requirements: this.cloneRequirements(requirements) });
      markers['教程'] = Math.max(2, Number(markers['教程'] || 0));
      player.markers = markers; // Player markers 为 Json 列，直接写对象
      await this.settleCompletedTasks(player, tasks);
      player.tasks = tasks; // Player tasks 为 Json 列，直接写数组
      await this.saveTaskState(player, [
        'tasks', 'markers', 'backpack', 'recipes', 'exp', 'level', 'upgradeExp',
        'hp', 'maxHp', 'shield', 'maxShield', 'armor', 'maxArmor', 'attack',
        'hit', 'dodge', 'speed', 'crit', 'critDmg', 'regenHp', 'regenShield',
        'regenArmor', 'vitality', 'affinity',
      ]);
    });
  }

  /** 放弃任务：教程/进阶/主线不可放弃，其他任务之间有300秒间隔。 */
  async abandonTask(userId: number, taskName: string): Promise<string> {
    if (!taskName) return '请指定要放弃的任务名称，格式：放弃任务 任务名';
    return this.enqueueUserWrite(userId, async () => {
      const player = await this.prisma.player.findUnique({ where: { userId } });
      if (!player) return '玩家数据不存在';
      const tasks = this.parsePlayerTasks(player.tasks);
      const index = this.resolveTaskIndex(tasks, taskName);
      const actualTaskName = index >= 0 ? tasks[index].name : this.cleanName(taskName);
      if (index < 0) return `你没有接取名为「${actualTaskName || taskName}」的任务`;
      // 原版 L11256-11265：名称含 进阶/教程/主线 的任务不可放弃
      if (/教程|进阶|主线/.test(actualTaskName)) {
        return `${player.name || ''}${actualTaskName}不是可以放弃的任务。`;
      }

      const markers2 = this.parseArray(player.markers2);
      const now = Date.now();
      const cooldown = markers2.find((item: any) => this.taskName(item) === '放弃任务');
      const cooldownAt = this.toMilliseconds(cooldown?.expireAt ?? cooldown?.有效期至);
      if (cooldownAt > now) return `放弃任务冷却中，还需 ${Math.ceil((cooldownAt - now) / 1000)} 秒`;

      tasks.splice(index, 1);
      const marker = { name: '放弃任务', expireAt: now + 300 * 1000 };
      const oldIndex = markers2.findIndex((item: any) => this.taskName(item) === '放弃任务');
      if (oldIndex >= 0) markers2[oldIndex] = marker;
      else markers2.push(marker);
      player.tasks = tasks; // Player tasks 为 Json 列，直接写数组
      player.markers2 = markers2; // Player markers2 为 Json 列，直接写数组
      await this.saveTaskState(player, ['tasks', 'markers2']);
      return `${player.name || ''}放弃了任务${actualTaskName}`;
    });
  }

  /** 只写任务结算实际改动的字段，避免覆盖同一指令期间其他系统保存的数据。 */
  private async saveTaskState(player: any, fields: string[]): Promise<void> {
    const data: Record<string, any> = {};
    for (const field of fields) {
      if (player[field] === undefined) continue;
      // Json 列字段（tasks/markers/backpack/recipes 等）保持对象/数组原样透传；
      // 数值字段原样透传。此前对 object 做 stringify 会导致 Json 列双重编码。
      data[field] = player[field];
    }
    if (Object.keys(data).length === 0) return;
    await this.playerService.enqueueUserWrite(player.userId, async () => {
      const _pd = await this.playerService.getPlayerData(player.userId);
      Object.assign(_pd.player, data);
      await this.playerService.savePlayer(_pd.player);
    });
  }

  private canAcceptByMarkers(raw: any, markers: Record<string, any>): boolean {
    const restrictions = this.parseAnyArray(raw);
    for (const restriction of restrictions) {
      const name = typeof restriction === 'string'
        ? restriction
        : String(restriction?.name ?? restriction?.名称 ?? '');
      if (!name) continue;
      const required = typeof restriction === 'object' && (restriction.required === true || restriction.必须 === true);
      const present = markers[name] !== undefined && markers[name] !== null;
      if (required ? !present : present) return false;
    }
    return true;
  }

  private parsePlayerTasks(value: any): PlayerTask[] {
    const raw = this.parseRawTasks(value);
    const result: PlayerTask[] = [];
    for (const item of raw) {
      const name = this.taskName(item);
      if (!name) continue;
      const completed = item.completed === true || item.status === '已完成' || item.status === '已提交';
      const publisher = String(item.publisher ?? item.发布人 ?? '') || undefined;
      if (completed) {
        result.push({ name, requirements: [], publisher, completed: true });
        continue;
      }

      const rawRequirements = item.requirements ?? item.要求;
      let requirements = this.parseRequirements(rawRequirements);
      if (requirements.length === 0 && !this.hasRequirementEntries(rawRequirements)) {
        const definition = this.getTaskDefinition(name);
        requirements = this.parseRequirements(definition?.requirements);
        if (requirements.length === 0 && !this.hasRequirementEntries(definition?.requirements)) continue;
      }
      result.push({ name, requirements, publisher });
    }
    return result;
  }

  private parseRawTasks(value: any): any[] {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return [];
    let raw = value.trim();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === 'string') raw = parsed.trim();
      else return [];
    } catch {
      // 继续按原版存档的反引号分隔格式解析。
    }
    return raw.split('`')
      .map((entry) => this.parseLegacyTask(entry))
      .filter((entry): entry is Record<string, any> => !!entry);
  }

  private parseRequirements(value: any): TaskRequirement[] {
    const parsed = this.parseRequirementEntries(value);
    return parsed
      .map((item: any) => {
        if (typeof item === 'string') return this.parseNameCountToken(item);
        return {
          name: this.cleanName(item?.name ?? item?.名称 ?? ''),
          count: Number(item?.count ?? item?.数值 ?? item?.quantity ?? item?.数量 ?? 0),
        };
      })
      .filter((item) => item.name && Number.isFinite(item.count) && item.count > 0);
  }

  private parseRewards(value: any): TaskReward[] {
    const parsed = this.parseAnyArray(value);
    return parsed
      .map((item: any) => ({
        name: this.cleanName(item?.name ?? item?.名称 ?? ''),
        count: Number(item?.count ?? item?.quantity ?? item?.数量 ?? item?.数值 ?? 0),
        type: item?.type ?? item?.类型,
      }))
      .filter((item) => item.name && Number.isFinite(item.count));
  }

  private parseStringArray(value: any): string[] {
    if (Array.isArray(value)) {
      return value
        .flatMap((item: any) => typeof item === 'string' ? item.split(/[，,\s]+/) : [])
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return this.parseStringArray(parsed);
    } catch {
      // 兼容原版以空格分隔的后续任务配置。
    }
    return value.split(/[，,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private parseRequirementEntries(value: any): any[] {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return [];
    const raw = value.trim();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 继续尝试原版任务要求编码。
    }
    if (raw.includes('#b#')) {
      return raw.split('#a#').map((entry) => {
        const parts = entry.split('#b#');
        return { name: parts[0], count: parts[1] };
      });
    }
    return raw.split(/[，,\s]+/).filter(Boolean);
  }

  private parseNameCountToken(value: string): TaskRequirement {
    const match = String(value || '').trim().match(/^(.*?)(-?\d+(?:\.\d+)?)$/);
    if (!match) return { name: this.cleanName(value), count: 0 };
    return { name: this.cleanName(match[1]), count: Number(match[2]) };
  }

  private hasRequirementEntries(value: any): boolean {
    return this.parseRequirementEntries(value).some((item: any) => {
      const name = typeof item === 'string'
        ? this.parseNameCountToken(item).name
        : this.cleanName(item?.name ?? item?.名称 ?? '');
      return !!name;
    });
  }

  private parseLegacyTask(value: string): Record<string, any> | null {
    const parts = String(value || '').split('!');
    if (parts.length < 2) return null;
    const name = parts.shift()?.trim() || '';
    if (!name) return null;
    const requirements = parts.shift() || '';
    const publisher = parts.join('!').trim();
    return {
      name,
      requirements: this.parseRequirements(requirements),
      ...(publisher ? { publisher } : {}),
    };
  }

  private parseAnyArray(value: any): any[] {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === '') return [];
    if (typeof value !== 'string') return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private parseArray(value: any): any[] {
    return this.parseAnyArray(value);
  }

  private parseObject(value: any, fallback: Record<string, any>): Record<string, any> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { ...fallback };
      } catch {
        return { ...fallback };
      }
    }
    return { ...fallback };
  }

  private taskName(value: any): string {
    if (typeof value === 'string') return this.cleanName(value);
    return this.cleanName(value?.name ?? value?.名称 ?? '');
  }

  private cleanName(value: any): string {
    return String(value ?? '').replace(/\s+/g, '').trim();
  }

  private cloneRequirements(value: TaskRequirement[]): TaskRequirement[] {
    return value.map((item) => ({ name: item.name, count: item.count }));
  }

  private formatNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  private toMilliseconds(value: any): number {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
}
