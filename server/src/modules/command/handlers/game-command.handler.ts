/**
 * 统一游戏指令处理器
 * 处理所有游戏相关的指令，按指令名分发到对应的子系统
 * 对应原版易语言：_主程序.ecode 中的指令分发逻辑
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { GameService } from '../../game/game.service';
import { CombatSystemService } from '../../game/combat-system.service';
import { ItemSystemService } from '../../game/item-system.service';
import { FamiliarSystemService } from '../../game/familiar-system.service';
import { FamiliarSkillsService } from '../../game/familiar-skills.service';
import { PlayerService } from '../../game/player.service';
import { TutorialService } from '../../game/tutorial.service';
import { ShortcutService } from '../../game/shortcut.service';
import { HomeService } from '../../game/home.service';
import { TaskService } from '../../game/task.service';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

@Injectable()
export class GameCommandHandler implements CommandHandler {
  key = 'game'; // 所有游戏指令的 handlerKey 都设为 'game'
  module = 'game';
  private readonly logger = new Logger(GameCommandHandler.name);

  constructor(
    @Inject(GameService) private readonly gameService: GameService,
    @Inject(CombatSystemService) private readonly combatSystem: CombatSystemService,
    @Inject(ItemSystemService) private readonly itemSystem: ItemSystemService,
    @Inject(FamiliarSystemService) private readonly familiarSystem: FamiliarSystemService,
    @Inject(FamiliarSkillsService) private readonly familiarSkills: FamiliarSkillsService,
    @Inject(PlayerService) private readonly playerService: PlayerService,
    @Inject(TutorialService) private readonly tutorialService: TutorialService,
    @Inject(ShortcutService) private readonly shortcutService: ShortcutService,
    @Inject(HomeService) private readonly homeService: HomeService,
    @Inject(TaskService) private readonly taskService: TaskService,
  ) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return { success: false, content: '未登录', broadcast: false, durationMs: 0 };
    }

    // 从原始消息中提取指令名（去除前缀）
    // 注意：无空格输入（如 `选择使魔伊卡洛斯`）的前缀匹配已由 CommandService.dispatch
    // 统一处理（含别名前缀，改写 rawMessage 为标准"指令 参数"形式），此处只需按空格解析首词。
    const rawMsg = ctx.rawMessage.trim();
    const cmdName = rawMsg.replace(/^[\/！!]/, '').split(/\s+/)[0];

    const result = await this.dispatch(ctx, cmdName, args);
    return result;
  }

  /**
   * 检查新手指引
   * 如果玩家开启了新手指引且该操作有对应的引导文本，返回引导提示
   * @param userId 用户ID
   * @param tutorialType 引导类型
   * @returns 引导文本（空字符串表示不需要引导）
   */
  private async checkTutorial(userId: number, tutorialType: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { markers } = playerData;
    const text = this.tutorialService.getTutorial(tutorialType, markers);
    if (text) {
      // 标记该引导已完成，下次不再显示
      this.tutorialService.markTutorialDone(markers, tutorialType);
      markers['指引_' + tutorialType] = 1;
      // 命令化写入口：只投递「markers 这一列被改了」的意图，由邮箱内基于最新
      // 活态应用。不传整行对象，因此不存在「旧快照字段顺带覆盖活态」的可能。
      await this.playerService.patchPlayer(userId, { markers }, 'tutorial');
    }
    return text;
  }

  /** 执行动作后再推进任务，避免参数错误、冷却和资源不足被误记成功。 */
  private async runTaskAction(
    userId: number,
    operation: () => Promise<string>,
    actions: Array<{ name: string; count?: number }>,
  ): Promise<string> {
    const result = await operation();
    if (this.isSuccessfulAction(result)) {
      for (const action of actions) {
        await this.taskService.advance(userId, action.name, action.count ?? 1);
      }
    }
    return result;
  }

  private isSuccessfulAction(result: string): boolean {
    if (!result?.trim()) return false;
    return !/(失败|错误|未知指令|未知操作|未知技能|不存在|无法|不能|不可|未找到|无效|请选择|请指定|请输入|请先|正在前往|正在工作|战斗状态|当前不可用|只能使用|未安装|没有安装|还需要|等级不足|需要等级|材料不足|数量不足|活力不足|余额不足|没有足够|你只有|不够|尚未|未解锁|冷却中|已死亡|不在|不是|已经签到过|地上没有|背包中没有|当前地图没有可|当前地图没有名为|附近没有|没有目标|没有载具|没有家园|没有可挤奶|没有可剪毛|没有可以|你还没有|你没有|耐久度已满|还不需要修|无需维修)/.test(result);
  }

  /** 命令响应状态只识别明确错误，查询结果中的“没有”不代表命令失败。 */
  private isSuccessfulResponse(result: string): boolean {
    if (!result?.trim()) return false;
    return !/(指令执行错误|家园操作失败|未知指令|未知操作|未知技能|失败|错误|不存在|无法|不能|不可|未找到|无效|请选择|请指定|请输入|请先|正在前往|正在工作|战斗状态|当前不可用|只能使用|未安装|还需要|等级不足|需要等级|材料不足|数量不足|活力不足|余额不足|没有足够|你只有|冷却中|已死亡|尚未|未解锁|不是|已经签到过|地上没有可|背包中没有|当前地图没有可|当前地图没有名为|附近没有|没有载具|没有家园|没有可挤奶|没有可剪毛|没有可以|耐久度已满|还不需要修|无需维修)/.test(result);
  }

  private parseCountedAction(input: string): { name: string; count: number } {
    const value = String(input || '').trim();
    const match = value.match(/^(.*?)(\d+)$/);
    if (!match) return { name: value, count: 1 };
    return { name: match[1].trim(), count: Math.max(1, Number(match[2])) };
  }

  /** 从载具批量操作的响应中读取实际完成数量，避免库存不足时虚增任务进度。 */
  private parseActionResultCount(result: string, fallback: number): number {
    const match = result.match(/(?:[x×]\s*(\d+)|把\s*(\d+)\s*个|拆卸了[^\n]*?[x×]\s*(\d+))/i);
    const count = Number(match?.[1] || match?.[2] || match?.[3] || fallback);
    return Number.isFinite(count) && count > 0 ? count : 1;
  }

  private parseCraftArguments(args: string[]): { recipeName: string; count: number } {
    const input = args.join(' ').trim();
    if (!input) return { recipeName: '', count: 1 };
    const spaced = input.match(/^(.+?)\s+(\d+)$/);
    if (spaced) return { recipeName: spaced[1].trim(), count: Math.max(1, Number(spaced[2])) };
    const compact = input.match(/^(.+?)(\d+)$/);
    if (compact) return { recipeName: compact[1].trim(), count: Math.max(1, Number(compact[2])) };
    return { recipeName: input, count: 1 };
  }

  private parseUseArguments(args: string[]): { itemName: string; count: number } {
    const input = args.join(' ').trim();
    if (!input) return { itemName: '', count: 1 };

    // 支持“使用 种子箱 10”和前缀路由还原后的“使用种子箱10”。
    const spaced = input.match(/^(.+?)\s+(\d+)$/);
    if (spaced) return { itemName: spaced[1].trim(), count: Math.max(1, Number(spaced[2])) };
    const compact = input.match(/^(.+?)(\d+)$/);
    if (compact) return { itemName: compact[1].trim(), count: Math.max(1, Number(compact[2])) };
    return { itemName: input, count: 1 };
  }

  /**
   * “使用全部XX”按结果行汇总任务进度：
   * 每行形如“使用了N的箱名”，推进“使用物品”N 与“使用箱名”N。
   * 不走 isSuccessfulAction 门禁——汇总文本里单箱失败不影响其他箱的成功行记账。
   */
  private async advanceUseAllTasks(userId: number, result: string): Promise<void> {
    let total = 0;
    const perName = new Map<string, number>();
    for (const m of result.matchAll(/使用了(\d+)的([^,，\n]+)/g)) {
      const count = Number(m[1]);
      const name = m[2].trim();
      if (!Number.isFinite(count) || count <= 0 || !name) continue;
      total += count;
      perName.set(name, (perName.get(name) || 0) + count);
    }
    if (total <= 0) return;
    await this.taskService.advance(userId, '使用物品', total);
    for (const [name, count] of perName) {
      await this.taskService.advance(userId, '使用' + name, count);
    }
  }

  private async dispatch(ctx: CommandContext, cmdName: string, args: string[]): Promise<CommandResult> {
    const userId = ctx.userId!;
    const arg = args.join(' ');
    const firstArg = args[0] || '';

    try {
      switch (cmdName) {
        // ========== 基础指令 ==========
        case '攻击':
        case 'attack':
        case '打':
        case '揍': {
          // 原版 `武器攻击()` 使用玩家当前装备武器（玩家.当前武器），而非固定拳头。
          // 若玩家已装备武器(当前武器>0)则用当前武器（触发该武器 cooldown/特殊序号特效），否则退化为拳头。
          const pd = await this.playerService.getPlayerData(userId);
          const weaponIndex = (pd.player.currentWeapon || 0) > 0 ? pd.player.currentWeapon : 0;
          // 原版 `攻击怪物名` 会设置 玩家.目标 后锁定该怪物，这里把参数作为目标名传入；
          // 同时按原版语义把目标记入标记（使魔技能.ecode L1744），六道轮回靠它实现
          // 冥鱼腿环的属性锁定——先发「攻击闪避」再洗装即只刷闪避。
          if (arg) {
            pd.markers['目标'] = arg;
            // markers 为原生 Json 列，直接传对象（stringify 会双重编码）
            pd.player.markers = pd.markers;
            await this.playerService.savePlayer(pd.player);
          }
          const result = await this.combatSystem.weaponAttack(userId, weaponIndex, { targetName: arg });
          // 自动推进任务：击杀怪物（对应原版 L9314~L9315）
          // 添加成就("击败怪物", 数量, 成就, 任务) 与 添加成就("击败" + 怪物名, 数量, ...)
          const killedList = result.killed || [];
          if (killedList.length > 0) {
            await this.taskService.advance(userId, '击败怪物', killedList.length);
            for (const killedName of killedList) {
              await this.taskService.advance(userId, '击败' + killedName);
            }
            // “消耗活力”由战斗奖励结算层按实际扣除量推进，命令层不重复记账。
          }
          // 新手引导：攻击照常执行，引导文本作为附加提示（不拦截，避免"首次攻击被吞"）
          // 对应原版：攻击即攻击，无引导拦截逻辑
          const tutorialText = await this.checkTutorial(userId, 'attack');
          if (tutorialText) {
            return this.wrap(`${result.result}\n━━━━━━━━━━━━━━━\n💡 ${tutorialText}`);
          }
          return this.wrap(result.result);
        }

        case '炮击':
        case 'cannon': {
          const result = await this.combatSystem.cannonAttack(userId, arg);
          // 原版 _主程序.ecode L947：炮击成功后推进炮击任务。
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '炮击');
          return this.wrap(result);
        }

        // ========== 自动战斗 / 延时攻击（对应原版 自动战斗 / 延时攻击指令） ==========
        case '自动战斗':
        case 'auto': {
          // 取当前装备武器索引，启动每5秒自动攻击循环（死亡/无怪自动停止）
          const pd = await this.playerService.getPlayerData(userId);
          const weaponIndex = (pd.player.currentWeapon || 0) > 0 ? pd.player.currentWeapon : 0;
          const started = this.combatSystem.startAutoCombat(userId, weaponIndex);
          return this.wrap(started ? '🔄 已开启自动战斗（每5秒攻击一次，直到死亡或地图无怪）' : '自动战斗启动失败');
        }

        case '停止自动战斗':
        case 'stop':
          this.combatSystem.stopAutoCombat(userId);
          return this.wrap('⏹ 已停止自动战斗');

        case '延时攻击':
        case 'delay': {
          // 取当前武器锁定时间（原版 武器攻击 L70-86：有锁定时间的武器触发延时攻击）
          const pd = await this.playerService.getPlayerData(userId);
          const weaponIndex = (pd.player.currentWeapon || 0) > 0 ? pd.player.currentWeapon : 0;
          const weapons = this.playerService.safeJsonParse<any[]>(pd.player.weapons, []);
          const w = weaponIndex > 0 ? weapons[weaponIndex - 1] : null;
          const lockTime = w?.lockTime ?? w?.锁定时间 ?? 0;
          if (lockTime <= 0) {
            return this.wrap('当前武器没有锁定时间，无法发动延时攻击');
          }
          const ok = this.combatSystem.scheduleDelayedAttack(userId, weaponIndex, lockTime);
          return this.wrap(ok ? `⏳ 已安排延时攻击（锁定${lockTime}秒后自动出手）` : '延时攻击安排失败');
        }

        case '信息':
        case 'info':
        case '资料':
        case '查看': {
          // 查看地图单位（原版 对话菜单 1、查看 → 查看NPC/怪物名）；未命中单位时回退查看自己
          if (arg.trim()) {
            const unitDetail = await this.gameService.handleViewUnit(userId, arg.trim());
            if (unitDetail) return this.wrap(unitDetail);
          }
          // 信息照常展示，引导作为附加提示（不拦截，对齐原版：查看即查看）
          const info = await this.gameService.handleInfo(userId);
          const tutorialText = await this.checkTutorial(userId, 'info');
          if (tutorialText) {
            return this.wrap(`${info}\n━━━━━━━━━━━━━━━\n💡 ${tutorialText}`);
          }
          return this.wrap(info);
        }

        case '背包':
        case 'inventory': {
          // 检查新手指引
          const tutorialText = await this.checkTutorial(userId, 'viewBag');
          if (tutorialText) {
            return this.wrap(tutorialText);
          }
          // 查看背包单项详情（对应原版 物品操作.ecode L817：添加成就("查看背包详细")）
          if (arg) {
            await this.taskService.advance(userId, '查看背包详细');
          }
          return this.wrap(await this.gameService.handleInventory(userId, arg));
        }

        case '移动':
        case 'move':
        case '前往':
        case '去': {
          // 普通移动按原版在 GameService 创建移动状态后推进“移动”，
          // 避免命令层按固定1次重复记账或在失败时提前记账。
          const result = await this.gameService.handleMove(userId, arg);
          return this.wrap(result);
        }

        case '飞到': {
          if (!arg.trim()) {
            return this.wrap(await this.gameService.handleFlyTo(userId, arg));
          }
          const result = await this.runTaskAction(
            userId,
            () => this.gameService.handleFlyTo(userId, arg),
            [{ name: '飞行' }],
          );
          return this.wrap(result);
        }

        case '地图':
        case 'map': {
          // 检查新手指引
          const tutorialText = await this.checkTutorial(userId, 'map');
          if (tutorialText) {
            return this.wrap(tutorialText);
          }
          return this.wrap(await this.gameService.handleMap(userId));
        }

        case '技能':
        case 'skill':
          return this.wrap(await this.gameService.handleSkill(userId));

        case '使魔技能':
        case 'familiar-skills':
          return this.wrap(await this.gameService.handleFamiliarSkills(userId));

        case '装备':
        case 'equip':
        case '穿上': {
          // 检查新手指引
          const tutorialText = await this.checkTutorial(userId, 'equipWeapon');
          if (tutorialText) {
            return this.wrap(tutorialText);
          }
          const playerData = await this.playerService.getPlayerData(userId);
          const equipArg = arg.trim();
          const numericIndex = /^\d+$/.test(equipArg) ? Number(equipArg) - 1 : -1;
          const itemIndex = numericIndex >= 0
            ? numericIndex
            : playerData.backpack.findIndex((candidate: any) => candidate.name === equipArg);
          const item = itemIndex >= 0 ? playerData.backpack[itemIndex] : undefined;
          const result = await this.gameService.handleEquip(userId, arg);
          if (this.isSuccessfulAction(result) && item?.type === '装备') {
            const action = this.itemSystem.isWeaponItem(item) ? '使用武器' : '使用装备';
            await this.taskService.advance(userId, action);
            await this.taskService.advance(userId, '装备' + item.name);
          }
          return this.wrap(result);
        }

        case '卸下':
        case 'unequip':
        case '脱下':
          return this.wrap(await this.gameService.handleUnequip(userId, firstArg));

        case '使用':
        case 'use': {
          const useInput = args.join(' ').trim();
          // 原版 _主程序.ecode L4517-4540：“使用全部XX” → 全部使用名字包含[XX]的物品（屏蔽种子）
          if (useInput.startsWith('全部')) {
            const keyword = useInput.slice(2).trim();
            const allResult = await this.gameService.handleUseAllItems(userId, keyword);
            await this.advanceUseAllTasks(userId, allResult);
            return this.wrap(allResult);
          }
          if (!useInput) {
            // 原版 L4515-4516：无参数 → 用法提示（顺带展示“使用全部”用法）
            const pd = await this.playerService.getPlayerData(userId);
            const pname = (pd.player as any)?.name ?? '';
            return this.wrap(`${pname}“使用普通装备补给箱1”来使用1个普通装备补给箱\n你可以“使用全部补给箱”来全部使用名字中包含[补给箱]的物品`);
          }
          const useArgs = this.parseUseArguments(args);
          const result = await this.gameService.handleUseItem(userId, useArgs.itemName, useArgs.count);
          if (this.isSuccessfulAction(result) && useArgs.itemName && !/种下了/.test(result)) {
            const actualCount = Number(result.match(/(?:使用了|使用|开启了|打开了)[^\d]*(\d+)/)?.[1] || useArgs.count);
            await this.taskService.advance(userId, '使用物品', actualCount);
            await this.taskService.advance(userId, '使用' + useArgs.itemName, actualCount);
          }
          return this.wrap(result);
        }

        // ========== 物品系统 ==========
        case '制造':
        case 'craft':
        case '制作': {
          const craft = this.parseCraftArguments(args);
          const result = await this.runTaskAction(
            userId,
            () => this.itemSystem.craftItem(userId, craft.recipeName, craft.count),
            [
              { name: '制造', count: craft.count },
              ...(craft.recipeName ? [{ name: '制造' + craft.recipeName, count: craft.count }] : []),
            ],
          );
          return this.wrap(result);
        }

        case '分解':
        case 'deconstruct': {
          // 原版 分解+全部（_主程序.ecode L3387-3435）：一键分解全部未锁定装备
          if (arg.trim() === '全部' || arg.trim() === '全部装备') {
            const result = await this.itemSystem.deconstructAll(userId);
            const count = Number(result.match(/分解了(\d+)件装备/)?.[1] || 0);
            if (count > 0) {
              await this.taskService.advance(userId, '分解', count);
            }
            return this.wrap(result);
          }
          const deconstruct = this.parseCountedAction(arg);
          const result = await this.runTaskAction(
            userId,
            () => this.itemSystem.deconstructItem(userId, deconstruct.name, deconstruct.count),
            [{ name: '分解', count: deconstruct.count }],
          );
          return this.wrap(result);
        }

        case '丢弃':
        case 'discard':
        case '扔掉':
          return this.wrap(await this.itemSystem.discardItem(userId, firstArg));

        case '移除':
        case 'remove':
          // 对应原版：移除()（_主程序.ecode L3310-3360）
          // 从次元保险柜取出指定物品（模式 4 = 取出）。无参数时提示。
          if (!arg) {
            return this.wrap(`${'请指定要取出的物品名称，例如：移除 物品名'}`);
          }
          return this.wrap(await this.itemSystem.removeFromVault(userId, arg));

        case '保护':
        case 'protect':
          return this.wrap(await this.itemSystem.protectItem(userId, arg));

        case '强化':
        case 'enhance':
        case '升级': {
          const enhancementPart = arg.replace(/\d+/g, '').trim();
          const equipmentParts = new Set([
            '头部', '饰品', '肩膀', '上身', '手臂', '手掌',
            '腰部', '背部', '下身', '腿部', '腿环', '脚部', '武器',
          ]);
          if (equipmentParts.has(enhancementPart)) {
            const result = await this.gameService.handleEquipEnhance(userId, arg);
            if (this.isSuccessfulAction(result)) {
              // 原版使用实际完成次数 c；资源不足时不能按请求次数虚增任务进度。
              const count = Number(result.match(/强化了[^\d]*(\d+)次/)?.[1]
                || arg.match(/\d+/)?.[0] || 1);
              await this.taskService.advance(userId, '强化装备', count);
              await this.taskService.advance(userId, '强化' + enhancementPart, count);
            }
            return this.wrap(result);
          }
          const result = await this.itemSystem.enhanceItem(userId, arg);
          if (this.isSuccessfulAction(result) && arg) {
            await this.taskService.advance(userId, '强化' + arg);
          }
          return this.wrap(result);
        }

        case '解析':
        case 'analyze':
          return this.wrap(await this.itemSystem.analyzeEquipment(userId, arg));

        case '锁定装备':
        case 'lock':
          return this.wrap(await this.itemSystem.lockEquipment(userId, arg));

        case '解锁':
        case 'unlock':
          return this.wrap(await this.itemSystem.unlockEquipment(userId, arg));

        // ========== 使魔系统 ==========
        case '选择使魔':
        case 'select':
        case 'familiar':
        case '更换使魔':
          return this.wrap(await this.familiarSystem.selectFamiliar(userId, arg));

        case '召唤使魔':
        case 'summon': {
          const count = parseInt(firstArg, 10) || 1;
          return this.wrap(await this.familiarSystem.summonFamiliar(userId, count));
        }

        // 召唤固定剧情角色"白"（对应原版 _主程序.ecode L9777 召唤1白1）
        case '召唤1白1':
        case 'summon-white':
          return this.wrap(await this.familiarSystem.summonStoryFamiliar(userId, '白'));

        case '命名使魔':
        case 'name-familiar':
          return this.wrap(await this.familiarSystem.nameFamiliar(userId, arg));

        case '查看使魔': {
          // 检查新手指引
          const tutorialText = await this.checkTutorial(userId, 'familiarData');
          if (tutorialText) {
            return this.wrap(tutorialText);
          }
          // 查看使魔 = 基础数据 + 「1、更多」子菜单（原版 _主程序.ecode L5527/L5548）
          // 「更多」是全局帮助指令，为免冲突此处「查看使魔」的更多子菜单使用专用令牌「使魔更多」。
          return this.wrap(await this.gameService.handleViewFamiliar(userId));
        }
        case '使魔数据':
        case 'familiar-data': {
          // 使魔数据 = 基础数据展示（原版 _主程序.ecode L6464 使魔数据 子程序，无「更多」子菜单）
          return this.wrap(await this.gameService.handleFamiliarData(userId));
        }
        case '使魔更多':
        case 'familiar-more': {
          // 查看使魔 →「更多」子菜单：使魔数据/查看技能/查看使魔详细/被动效果（原版 _主程序.ecode L4107-4113）
          return this.wrap(await this.gameService.handleFamiliarMore(userId));
        }
        case '查看使魔详细':
        case 'familiar-detail': {
          // 查看使魔详细 = 详细属性数据（原版 L5505 显示使魔数据 玩家,真）
          return this.wrap(await this.familiarSystem.viewFamiliarData(userId, true));
        }

        case '使魔商店':
        case 'familiar-shop':
          return this.wrap(await this.familiarSystem.familiarShop(userId, firstArg || undefined));

        case '兑换':
        case 'exchange':
          // 对应原版 _主程序.ecode L2630-L2634：数字是兑换次数，其余文本是物品名称。
          {
            const exchangeText = arg || firstArg;
            const digits = exchangeText.match(/\d+/g);
            const count = digits ? Number(digits.join('')) || 1 : 1;
            const itemName = exchangeText.replace(/\d/g, '').replace(/\s+/g, '');
            return this.wrap(await this.familiarSystem.exchange(userId, itemName, count));
          }

        // ========== 使魔技能系统 ==========
        // 原版 使魔技能.ecode L667-L769：六道轮回支持「六道轮回N属性」洗装与「六道轮回选择M」选择，
        // 无空格输入由 CommandService 前缀路由还原为标准"指令 参数"后进入本分支。
        // 前缀路由会把「六道轮回选择2」还原成 指令=六道轮回 参数=选择2，
        // 因此与原版一致在六道轮回分支内先判「选择」前缀。
        case '六道轮回':
        case 'six-paths':
          if (arg.startsWith('选择')) {
            return this.wrap(await this.familiarSkills.sixPathsChoice(userId, arg.slice(2)));
          }
          return this.wrap(await this.familiarSkills.executeSkill(userId, '六道轮回', arg));

        // 直接以「六道轮回选择」为指令名输入时的兜底分支（正常都会被上一分支拦截）。
        case '六道轮回选择':
          return this.wrap(await this.familiarSkills.sixPathsChoice(userId, arg));

        case '怒吼':
        case 'roar':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '怒吼'));

        case '万象':
        case 'myriad-visions':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '万象'));

        // 原版 Saber 特有技能文本就是 "ex"（使魔技能.ecode L1406 消息数据=="ex"），
        // 因此指令层也要认 "ex"，与自动释放的 normalizeUniqueSkill(ex→誓约胜利之剑) 对齐。
        case '誓约胜利之剑':
        case 'excalibur':
        case 'ex':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '誓约胜利之剑'));

        case '鹰眼':
        case 'hawk-eye':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '鹰眼'));

        case '歼灭':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '歼灭'));

        case '歼灭模式':
        case 'annihilation-mode':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '歼灭模式'));

        case '绝对守护':
        case 'absolute-guard':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '绝对守护'));

        case '斗转星移':
        case 'stellar-shift':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '斗转星移'));

        case '火力全开':
        case 'full-firepower':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '火力全开'));

        case '啾啾猫猫':
        case 'meow-attack':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '啾啾猫猫'));

        case '银龙附体':
        case 'silver-dragon':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '银龙附体'));

        case '斩':
        case 'slash':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '斩'));

        case '会心一击':
        case 'critical-hit':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '会心一击'));

        case '全弹发射':
        case 'full-salvo':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '全弹发射'));

        case '光翼':
        case 'light-wings':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '光翼'));

        case '炮冠':
        case 'cannon-crown':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '炮冠'));

        case '日轮':
        case 'solar-wheel':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '日轮'));

        case '安宝加油':
        case 'anchor-boost':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '安宝加油'));

        case '灼烂歼鬼':
        case 'scorched-finger':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '灼烂歼鬼'));

        case '冻结傀儡':
        case 'freeze-puppet':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '冻结傀儡'));

        case '封印解除':
        case 'seal-release':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '封印解除'));

        case '召唤银龙':
        case 'summon-dragon':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '召唤银龙'));

        // 兰音技能组
        case '形神合一':
        case 'spirit-unity':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '形神合一'));

        case '风月入墨':
        case 'wind-moon':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '风月入墨'));

        case '心无所扰':
        case 'heart-unperturbed':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '心无所扰'));

        case '梦倾天下':
        case 'dream-world':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '梦倾天下'));

        case '反转童话':
        case 'reverse-fairytale':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '反转童话'));

        case '月落寸光':
        case 'moonlight-inch':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '月落寸光'));

        // 通用/装备技能
        case '洗脑':
        case 'brainwash':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '洗脑', firstArg));

        case '砸瓦鲁多':
        case 'za-warudo':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '砸瓦鲁多'));

        case '训练':
        case 'train':
          // 训练成功后再推进任务（对应原版 L2087）。
          {
            const result = await this.familiarSkills.executeSkill(userId, '训练');
            if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '训练');
            return this.wrap(result);
          }

        case '掌控时间':
        case 'time-control':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '掌控时间'));

        case '召唤':
        case 'summon-thing':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '召唤', firstArg));

        case '力量模式':
        case 'power-mode':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '力量模式'));

        case '速度模式':
        case 'speed-mode':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '速度模式'));

        case '装甲模式':
        case 'armor-mode':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '装甲模式'));

        case '隐匿模式':
        case 'stealth-mode':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '隐匿模式'));

        // ========== 家园系统 ==========
        case '家园':
        case 'home':
          // 家园子命令统一经过此路由；建筑安装/拆卸仍由 GameService
          // 依据当前地图分流到家园或载具，避免家园快捷指令落入载具分支。
          return this.wrap(await this.handleHomeCommand(userId, firstArg, args.slice(1)));

        case '使魔家园':
        case 'familiar-home':
          return this.wrap(await this.gameService.handleFamiliarHome(userId));

        case '圈地':
          return this.wrap(await this.familiarSystem.handleHome(userId, '圈地', ...args.slice(1)));

        case '开挖地基':
        case 'dig-foundation':
          return this.wrap(await this.familiarSystem.handleHome(userId, '开挖地基'));

        case '建造地基':
        case 'build-foundation':
          return this.wrap(await this.familiarSystem.handleHome(userId, '建造地基'));

        case '建造房子':
        case 'build-house':
          return this.wrap(await this.familiarSystem.handleHome(userId, '建造房子'));

        case '生产':
          return this.wrap(await this.gameService.handleVehicleProduction(userId, args.join(' ')));

        case '建造':
          return this.wrap(await this.handleHomeCommand(userId, '建造', args));

        case '拆除':
          return this.wrap(await this.handleHomeCommand(userId, '拆除', args));

        case '种植':
          return this.wrap(await this.handleHomeCommand(userId, '种植', args));

        case '收获':
          return this.wrap(await this.handleHomeCommand(userId, '收获', args));

        // ========== 宠物系统 ==========
        case '宠物':
        case 'pet':
          return this.wrap(await this.familiarSystem.handlePet(userId, firstArg));

        case '捕捉':
        case 'capture': {
          const target = firstArg || args.slice(1).join(' ');
          const result = await this.familiarSystem.capturePet(userId, 'capture', target);
          // 捕捉成功后的任务推进由 FamiliarSystemService 在保存宠物后负责，
          // handler 只负责分发，避免同一次捕捉被记两次。
          return this.wrap(result);
        }

        // ========== 地图/探索 ==========
        case '传送':
        case 'teleport': {
          const result = await this.runTaskAction(
            userId,
            () => this.gameService.handleMove(userId, arg),
            [{ name: '传送' }],
          );
          return this.wrap(result);
        }

        case '跃迁': {
          const result = await this.runTaskAction(
            userId,
            () => this.gameService.handleMove(userId, arg),
            [{ name: '跃迁' }],
          );
          return this.wrap(result);
        }

        case '探测':
        case 'probe':
        case 'scout':
          return this.wrap(await this.gameService.handleProbe(userId));

        case '拾取':
        case 'pickup': {
          const result = await this.gameService.handlePickup(userId, arg);
          const tutorialText = await this.checkTutorial(userId, 'pickup');
          return this.wrap(tutorialText ? `${result}\n━━━━━━━━━━━━━━━\n💡 ${tutorialText}` : result);
        }

        case '开采':
        case 'mine': {
          const result = await this.gameService.handleMine(userId, firstArg);
          return this.wrap(result);
        }

        // ========== 副本系统 ==========
        case '开启副本':
        case 'start-dungeon': {
          const result = await this.gameService.handleStartDungeon(userId, arg);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '开启副本');
          return this.wrap(result);
        }

        case '刷新副本':
        case 'refresh-dungeon':
          return this.wrap(await this.gameService.handleRefreshDungeon(userId, arg));

        // ========== 载具系统 ==========
        case '安装':
        case 'install': {
          const action = this.parseCountedAction(arg);
          const result = await this.gameService.handleInstall(userId, arg);
          if (this.isSuccessfulAction(result)) {
            const count = this.parseActionResultCount(result, action.count);
            await this.taskService.advance(userId, '安装', count);
            if (action.name) await this.taskService.advance(userId, '安装' + action.name, count);
          }
          return this.wrap(result);
        }

        case '拆卸':
        case 'uninstall': {
          const action = this.parseCountedAction(arg);
          const result = await this.gameService.handleUninstallPart(userId, action.name, action.count);
          if (this.isSuccessfulAction(result)) {
            const count = this.parseActionResultCount(result, action.count);
            await this.taskService.advance(userId, '拆卸部件', count);
            if (action.name) await this.taskService.advance(userId, '拆卸' + action.name, count);
          }
          return this.wrap(result);
        }

        case '载具':
        case 'vehicle':
          return this.wrap(await this.gameService.handleVehicleStatus(userId));

        // ========== 任务系统 ==========
        case '领取任务':
        case 'accept-quest':
          return this.wrap(await this.gameService.handleAcceptQuest(userId, arg));

        case '查看任务':
        case 'quests':
        case '我的任务':
          return this.wrap(await this.gameService.handleViewQuests(userId, arg));

        case '提交任务':
        case 'complete-quest':
          return this.wrap(await this.gameService.handleCompleteQuest(userId, arg));

        // ========== 社交系统 ==========
        case '对话':
        case 'talk':
        case '交谈': {
          const dialogueInput = arg.trim();
          // 原版支持“对话 NPC 1”选择第1段对话；任务动作只记录实际NPC名称。
          const dialogueTarget = dialogueInput.replace(/\s+\d+$/, '').trim();
          // 只有“对话露娜未知 N”（未知物品兑换）走露娜专属剧情；普通的「对话 露娜」
          // 必须与露娜正常对话（原版 L1410 按六字命令“对话露娜未知”判断），
          // 且原版兑换分支不会推进“对话”成就。
          if (/露娜.*未知/.test(dialogueTarget)) {
            return this.wrap(await this.gameService.handleDialogueLuna(userId, dialogueInput));
          }
          // 任务推进由 GameService.handleTalk 在真正找到对话对象后统一处理
          // （对齐原版 L1566-1567），这里不再按返回文本猜测成败，避免重复计数。
          return this.wrap(await this.gameService.handleTalk(userId, dialogueTarget));
        }

        // 对话露娜未知：用背包中的未知物品与露娜兑换奖励
        case '对话露娜未知':
        case 'dialogue-luna':
          return this.wrap(await this.gameService.handleDialogueLuna(userId, arg));

        // 来倒目的：内部延时移动命令，格式 "来倒目的地图名$来源地图"（由系统延时触发）
        case '来倒目的':
        case 'arrive':
          return this.wrap(await this.gameService.handleArriveAt(userId, arg));

        case '救助':
        case 'rescue':
          return this.wrap(await this.gameService.handleRescue(userId));

        case '赠予':
        case 'give':
        case 'gift': {
          const targetQQ = firstArg;
          const itemName = args[1] || '';
          const count = parseInt(args[2] || '1', 10);
          return this.wrap(await this.gameService.handleGive(userId, targetQQ, itemName, count));
        }

        case '设置跟随':
        case 'follow': {
          const parts = arg.split(/\s+/);
          const targetName = parts[0] || '';
          const mode = parts[1];
          const isFollow = mode === undefined
            ? undefined
            : mode !== 'stop' && mode !== 'false' && mode !== '取消';
          return this.wrap(await this.familiarSystem.setFollow(userId, targetName, isFollow));
        }

        // ========== 私聊 / 反馈 ==========
        case '私聊':
        case 'whisper':
        case 'pm': {
          const parts = arg.split(/\s+/);
          const targetName = parts[0] || '';
          const content = parts.slice(1).join(' ');
          return this.wrap(await this.gameService.handlePrivateChat(userId, targetName, content));
        }

        case '反馈':
        case 'feedback': {
          const raw = firstArg === 'bug' || firstArg === 'suggestion' || firstArg === '建议' || firstArg === '问题'
            ? args.slice(1).join(' ')
            : arg;
          return this.wrap(await this.gameService.handleFeedback(userId, raw));
        }

        // ========== 状态系统 ==========
        case '躺下':
        case 'lie-down':
          return this.wrap(await this.gameService.handleLieDown(userId));

        case '起床':
        case 'get-up':
          return this.wrap(await this.gameService.handleGetUp(userId));

        // ========== 设置 ==========
        case '设置':
        case 'settings':
          return this.wrap(await this.gameService.handleSettings(userId, firstArg, args.slice(1).join(' ')));

        // ========== 设置子指令 ==========
        case '设置指引':
        case 'setting-guide':
          return this.wrap(await this.gameService.handleSettingsGuide(userId));

        case '设置随机':
        case 'setting-random':
          return this.wrap(await this.gameService.handleSettingsRandom(userId));

        case '设置采集':
        case 'setting-gather':
          return this.wrap(await this.gameService.handleSettingsGather(userId));

        case '设置活力':
        case 'setting-vitality':
          return this.wrap(await this.gameService.handleSettingsVitality(userId));

        case '设置不扶':
        case 'setting-no-help':
          return this.wrap(await this.gameService.handleSettingsNoHelp(userId));

        case '设置音乐':
        case 'setting-music':
          return this.wrap(await this.gameService.handleSettingsMusic(userId));

        case '设置倍率':
        case 'setting-multiplier':
          return this.wrap(await this.gameService.handleSettingsMultiplier(userId));

        case '设置购物':
        case 'setting-shop':
          return this.wrap(await this.gameService.handleSettingsShop(userId, firstArg));

        case '设置位置':
        case 'setting-location':
          return this.wrap(await this.gameService.handleSettingsLocation(userId, arg));

        case '设置标记':
        case 'setting-marker':
          return this.wrap(await this.gameService.handleSettingsMarker(userId, arg));

        // ========== 快捷输入 ==========
        case '快捷':
        case 'sc':
        case 'shortcut': {
          const subCmd = firstArg; // 子命令
          const subArgs = args.slice(1).join(' ');
          return this.wrap(await this.shortcutService.handleShortcutCmd(userId, subCmd, subArgs));
        }

        // ========== 管理 ==========
        case '管理':
        case 'admin':
        case '管理员':
        case 'gm':
          return this.wrap(await this.gameService.handleAdminCommand(userId, args));

        // ========== 基础战斗命令 ==========
        case '开始战斗':
        case 'start-battle':
          // 手动进入战斗循环模式
          return this.wrap(await this.gameService.handleStartBattle(userId));

        case '扫荡':
        case 'sweep':
          // 快速战斗/扫荡模式
          return this.wrap(await this.gameService.handleSweep(userId, Number(firstArg) || 0));

        case '闪避':
        case 'dodge': {
          const result = await this.gameService.handleDodge(userId);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '闪避');
          return this.wrap(result);
        }

        // ========== 玩家信息命令 ==========
        case '资源背包':
        case 'resource-bag':
          return this.wrap(await this.gameService.handleResourceBag(userId));

        case '背包搜索':
        case 'search-bag':
          return this.wrap(await this.gameService.handleSearchBag(userId, firstArg));

        case '保险柜搜索':
        case 'search-safe':
          return this.wrap(await this.gameService.handleSearchSafe(userId, firstArg));

        case '比较装备':
        case 'compare-equip':
          const targetName = args[0] || '';
          const compareName = args[1] || '';
          return this.wrap(await this.gameService.handleCompareEquip(userId, targetName, compareName));

        case '被动效果':
        case 'passive-effects':
          return this.wrap(await this.gameService.handlePassiveEffects(userId));

        case '图鉴':
        case 'handbook':
          return this.wrap(await this.gameService.handleHandbook(userId, firstArg));

        // ========== 物品操作命令 ==========
        case '切换武器':
        case 'switch-weapon':
          return this.wrap(await this.gameService.handleSwitchWeapon(userId, firstArg));

        case '强化植入体':
        case 'enhance-implant': {
          const result = await this.gameService.handleEnhanceImplant(userId, firstArg);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '强化植入体');
          return this.wrap(result);
        }

        case '查看植入体':
        case 'view-implant':
          return this.wrap(await this.gameService.handleViewImplant(userId));

        case '切换植入体':
        case 'switch-implant': {
          const result = await this.gameService.handleSwitchImplant(userId, firstArg);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '切换植入体');
          return this.wrap(result);
        }

        case '还原植入体':
        case 'reset-implant':
          return this.wrap(await this.gameService.handleResetImplant(userId));

        case '查看增幅器':
        case 'view-amplifier':
          return this.wrap(await this.gameService.handleViewAmplifier(userId));

        case '切换增幅器':
        case 'switch-amplifier': {
          const result = await this.gameService.handleSwitchAmplifier(userId, firstArg);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '切换增幅器');
          return this.wrap(result);
        }

        case '强化增幅器':
        case 'enhance-amplifier': {
          const result = await this.gameService.handleEnhanceAmplifier(userId, firstArg);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '强化增幅器');
          return this.wrap(result);
        }

        case '还原增幅器':
        case 'reset-amplifier':
          return this.wrap(await this.gameService.handleResetAmplifier(userId));

        case '炼丹':
        case 'alchemy': {
          const craft = this.parseCraftArguments(args);
          const result = await this.gameService.handleAlchemy(userId, craft.recipeName, craft.count);
          if (craft.recipeName && this.isSuccessfulAction(result)) {
            // 原版 _主程序.ecode L8597 使用独立的“炼丹”任务动作，不能
            // 把炼丹错误归入普通“制造”任务。
            await this.taskService.advance(userId, '炼丹', craft.count);
          }
          return this.wrap(result);
        }

        case '融合':
        case 'merge': {
          const result = await this.gameService.handleMerge(userId, firstArg, args.slice(1));
          if (firstArg && this.isSuccessfulAction(result)) {
            // 融合23 的10%成功分支对应原版独立成就“造神”；
            // 普通融合以及特效/暴击伤害融合仍推进“融合”。
            const fusionMode = args.slice(1).join(' ').trim();
            if (/造神成功/.test(result)) {
              await this.taskService.advance(userId, '造神');
            } else if (
              !/^23$/.test(firstArg)
              || fusionMode === '42'
              || (fusionMode === '' && /激活了/.test(result))
            ) {
              await this.taskService.advance(userId, '融合');
            }
          }
          return this.wrap(result);
        }

        case '锻造':
        case 'forge': {
          const craft = this.parseCraftArguments(args);
          const result = await this.gameService.handleForge(userId, craft.recipeName, craft.count);
          if (craft.recipeName && this.isSuccessfulAction(result)) {
            await this.taskService.advance(userId, '制造', craft.count);
            await this.taskService.advance(userId, '制造' + craft.recipeName, craft.count);
          }
          return this.wrap(result);
        }

        case '育种':
        case 'breed': {
          const result = await this.gameService.handleBreed(userId, firstArg);
          if (firstArg && this.isSuccessfulAction(result)) {
            await this.taskService.advance(userId, '生崽');
            await this.taskService.advance(userId, '育种');
            await this.taskService.advance(userId, '育种' + firstArg);
          }
          return this.wrap(result);
        }

        // ========== 使魔系统命令 ==========
        case '通用技能':
        case 'common-skills':
          return this.wrap(await this.gameService.handleCommonSkills(userId));

        case '使魔称号':
        case 'familiar-titles':
          return this.wrap(await this.gameService.handleFamiliarTitles(userId));

        case '领取称号':
        case 'claim-title': {
          const result = await this.gameService.handleClaimTitle(userId, firstArg);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '领取称号');
          return this.wrap(result);
        }

        case '佩戴称号':
        case 'equip-title': {
          const result = await this.gameService.handleEquipTitle(userId, firstArg);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '佩戴称号');
          return this.wrap(result);
        }

        case '使魔排行':
        case 'familiar-rank':
          return this.wrap(await this.gameService.handleFamiliarRank(userId));

        case '排行':
        case 'ranking':
          return this.wrap(await this.gameService.handleRanking(userId, firstArg));

        case '大召唤术':
        case 'mass-summon':
          return this.wrap(await this.gameService.handleMassSummon(userId, firstArg));

        case '复活使魔':
        case 'revive-familiar':
          return this.wrap(await this.gameService.handleReviveFamiliar(userId));

        case '安乐天使':
        case 'ease-angel':
          return this.wrap(await this.gameService.handleEaseAngel(userId, arg));

        case '福音书':
        case 'gospel':
          return this.wrap(await this.gameService.handleGospel(userId, arg));

        case '启示录':
        case 'apocalypse':
          return this.wrap(await this.gameService.handleApocalypse(userId));

        case '切换模式':
        case 'switch-mode':
          return this.wrap(await this.gameService.handleSwitchMode(userId, firstArg));

        case '纳米生化装':
        case 'nano-suit':
          return this.wrap(await this.gameService.handleNanoSuit(userId, firstArg));

        case '铠甲合体':
        case 'armor-combine':
          return this.wrap(await this.gameService.handleArmorCombine(userId));

        case '使魔挑战':
        case 'familiar-challenge':
          return this.wrap(await this.gameService.handleFamiliarChallenge(userId));

        case '开始挑战':
        case 'start-challenge':
          return this.wrap(await this.gameService.handleStartChallenge(userId));

        // ========== 带"覅"前缀的管理/调试延时攻击命令（对应原版 _主程序.ecode） ==========
        // 覅下一层：使魔挑战副本进入下一层（_主程序.ecode L6431 覅下一层）
        case '覅下一层':
        case 'challenge-next-layer': {
          const result = await this.gameService.familiarChallengeNextLayer(userId);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '挑战等级');
          return this.wrap(result);
        }

        // 覅攻击pd：地图定点管理员攻击 + 载具修复（_主程序.ecode L200 覅攻击pd）
        case '覅攻击pd':
        case 'admin-attack-pd':
          return this.wrap(await this.combatSystem.adminAttackMap(userId, arg));

        // 覅公jj：延时攻击（按 QQ$武器 定位召唤物/怪物/玩家并以其武器攻击）（_主程序.ecode L536 覅公jj）
        case '覅公jj':
        case 'delayed-attack-qq':
          return this.wrap(await this.combatSystem.delayedAttackByQQWeapon(userId, arg));

        // ========== 地图/探索命令 ==========
        case '观察附近':
        case 'look-around':
          return this.wrap(await this.gameService.handleLookAround(userId));

        // ========== 查看XXX 导航系列（对应原版 _主程序.ecode L5442-5570） ==========
        case '查看宠物':
        case 'view-pets':
          return this.wrap(await this.gameService.handleViewPets(userId));

        case '查看载具':
        case 'view-vehicles':
          return this.wrap(await this.gameService.handleViewVehicles(userId));

        case '查看作物':
        case 'view-crops':
          return this.wrap(await this.gameService.handleViewCrops(userId));

        case '查看建筑':
        case 'view-buildings':
          return this.wrap(await this.gameService.handleViewBuildings(userId));

        case '查看家园':
        case 'view-homes':
          return this.wrap(await this.gameService.handleViewHomes(userId));

        case '查看成就':
        case 'view-achievements':
          return this.wrap(await this.gameService.handleViewAchievements(userId));

        case '查看技能':
        case 'view-skills':
          return this.wrap(await this.gameService.handleViewSkills(userId));

        case '查看标记':
        case 'view-markers':
          return this.wrap(await this.gameService.handleViewMarkers(userId));

        case '查看标记2':
        case 'view-markers2':
          return this.wrap(await this.gameService.handleViewMarkers2(userId));

        // 查看地图 ≈ 地图指令；查看说明 ≈ 地图详情
        case '查看地图':
          return this.wrap(await this.gameService.handleMap(userId));

        case '查看说明':
        case 'view-description':
          return this.wrap(await this.gameService.handleViewDescription(userId));

        // 查看已装备装备/武器（对应原版 L5596 查看装备/查看武器）
        case '查看装备':
        case 'view-equip':
          return this.wrap(await this.gameService.handleViewEquip(userId, arg, '装备'));

        case '查看武器':
        case 'view-weapon':
          return this.wrap(await this.gameService.handleViewEquip(userId, arg, '武器'));

        // 查看保险柜（对应原版 L5435 查看保险柜）
        case '查看保险柜':
        case 'view-safe':
          return this.wrap(await this.gameService.handleViewSafe(userId, arg));

        // ========== 对话跟随 / 家园设置（对应原版 L1368/L1397/L5277） ==========
        case '对话咏星跟随':
        case 'dialogue-yongxing': {
          const result = await this.gameService.handleDialogueYongxing(userId);
          if (result.includes('愿意跟随')) await this.taskService.advance(userId, '拐妹子');
          return this.wrap(result);
        }

        case '对话小恶魔跟随':
        case 'dialogue-little-demon':
          return this.wrap(await this.gameService.handleDialogueLittleDemon(userId));

        case '设置肉食比例':
        case 'set-meat-ratio':
          return this.wrap(await this.gameService.handleSetMeatRatio(userId, arg));

        case '召唤货舱':
        case 'summon-cargo': {
          const result = await this.gameService.handleSummonCargo(userId);
          // 原版 _主程序.ecode L6293：成功召唤货舱才推进任务。
          if (result.includes('召唤货舱成功')) await this.taskService.advance(userId, '召唤货舱');
          return this.wrap(result);
        }

        case '发射信号枪':
        case 'signal-gun':
          return this.wrap(await this.gameService.handleSignalGun(userId));

        // ========== 副本命令 ==========
        case '副本清空':
        case 'clear-dungeon':
          return this.wrap(await this.gameService.handleClearDungeon(userId, arg));

        // ========== 载具命令 ==========
        case '组装':
        case 'assemble': {
          // 原版 _主程序.ecode L10096-L10117：多段空格参数表示按模拟配方直接组装新载具。
          const parts = arg.split(/\s+/).filter(Boolean);
          if (parts.length > 2) {
            const multiPartResult = await this.gameService.assembleVehicleFromParts(userId, parts);
            return this.wrap(multiPartResult);
          }

          const action = this.parseCountedAction(arg);
          const result = await this.gameService.handleAssembleVehicle(userId, action.name, action.count);
          if (this.isSuccessfulAction(result)) {
            const isVehicleAssembly = /成功组装载具|组装了一个载具/.test(result);
            const count = isVehicleAssembly ? 1 : this.parseActionResultCount(result, action.count);
            await this.taskService.advance(userId, isVehicleAssembly ? '组装载具' : '组装部件', count);
            if (action.name) await this.taskService.advance(userId, '组装' + action.name, count);
          }
          return this.wrap(result);
        }

        case '驾驶':
        case 'drive': {
          const result = await this.gameService.handleDriveVehicle(userId, firstArg);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '驾驶载具');
          return this.wrap(result);
        }

        case '载具命名':
        case 'name-vehicle':
          return this.wrap(await this.gameService.handleNameVehicle(userId, firstArg));

        case '载具模拟':
        case 'simulate-vehicle': {
          const result = await this.gameService.handleSimulateVehicle(userId, firstArg);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '载具模拟');
          return this.wrap(result);
        }

        case '维修':
        case 'repair': {
          const result = await this.gameService.handleRepairVehicle(userId, firstArg);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '维修载具');
          return this.wrap(result);
        }

        case '脱出':
        case 'exit': {
          const result = await this.gameService.handleExitVehicle(userId);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '脱出');
          return this.wrap(result);
        }

        case '接管':
        case 'takeover':
          return this.wrap(await this.gameService.handleTakeoverVehicle(userId, firstArg));

        case '架炮':
        case 'deploy-cannon':
          return this.wrap(await this.gameService.handleDeployCannon(userId, firstArg));

        case '模式转换':
        case 'mode-change':
          return this.wrap(await this.gameService.handleModeChange(userId, firstArg));

        case '转换':
        case 'transform':
          return this.wrap(await this.gameService.handleTransform(userId, firstArg));

        case '牵引':
        case 'tractor':
          return this.wrap(await this.gameService.handleTractorBeam(userId, firstArg));

        case '控制终端':
        case 'control-terminal':
          // 原版控制终端=白的羁绊终端（技能a/技能b 子命令经前缀路由进入 arg）
          return this.wrap(await this.gameService.handleControlTerminal(userId, arg));

        case '载具操作':
        case 'vehicle-ops':
          return this.wrap(await this.gameService.handleVehicleOps(userId));

        case '增幅器说明':
        case 'amplifier-help':
          return this.wrap(await this.gameService.handleAmplifierHelp(userId));

        // ========== 宠物/社交命令 ==========
        case '开始捕捉':
        case 'start-capture':
          return this.wrap(await this.gameService.handleStartCapture(userId, firstArg));

        case '停止捕捉':
        case 'stop-capture':
          return this.wrap(await this.gameService.handleStopCapture(userId, firstArg));

        case '全部跟随':
        case 'follow-all':
          return this.wrap(await this.gameService.handleFollowAll(userId));

        case '补魔':
        case 'refill': {
          const result = await this.gameService.handleRefill(userId);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '补魔');
          return this.wrap(result);
        }

        case '挤奶':
        case 'milk': {
          const result = await this.gameService.handleMilk(userId, firstArg);
          return this.wrap(result);
        }

        case '剪毛':
        case 'shear': {
          const result = await this.gameService.handleShear(userId, firstArg);
          return this.wrap(result);
        }

        // ========== 任务/设置命令 ==========
        case '放弃任务':
        case 'abandon-quest':
          return this.wrap(await this.gameService.handleAbandonQuest(userId, arg));

        // ========== 其他命令 ==========
        case '使魔大战':
        case 'game-intro':
          return this.wrap(await this.gameService.handleGameIntro(userId));

        case '游戏解释':
        case 'game-terms':
        case '名词解释':
          return this.wrap(await this.gameService.handleGameTerms(userId, firstArg));

        case '更多':
        case 'more':
          return this.wrap(await this.gameService.handleMoreHelp(userId));

        case '更新历史':
        case 'changelog':
          return this.wrap(await this.gameService.handleChangelog(userId));

        case '贸易':
        case 'trade':
          {
            const result = await this.gameService.handleTrade(userId, firstArg, args.slice(1));
            return this.wrap(result);
          }

        case '购物':
        case 'shop':
          {
            const result = await this.gameService.handleShop(userId, firstArg, args.slice(1));
            return this.wrap(result);
          }

        case '求助':
        case 'help-me':
          {
            const result = await this.gameService.handleHelpMe(userId, args.join(' '));
            return this.wrap(result);
          }

        case '配方':
        case 'recipe':
          return this.wrap(await this.gameService.handleRecipe(userId, firstArg));

        case '逆向':
        case 'reverse':
          return this.wrap(await this.gameService.handleReverse(userId, firstArg));

        case '预设切换':
        case 'preset':
        case '切换预设':
          return this.wrap(await this.gameService.handlePresetSwitch(userId, firstArg));

        case '回充':
        case 'recharge':
          return this.wrap(await this.gameService.handleRecharge(userId));

        case '修理':
        case 'repair-item':
          return this.wrap(await this.gameService.handleRepairItem(userId, firstArg));

        case '装填':
        case 'reload':
          return this.wrap(await this.gameService.handleReload(userId, firstArg));

        case '生成神之工匠':
        case 'spawn-artisan':
          return this.wrap(await this.gameService.handleSpawnArtisan(userId));

        case '生成废弃载具':
        case 'spawn-wreck':
          return this.wrap(await this.gameService.handleSpawnWreck(userId));

        case '签到':
        case 'daily-checkin': {
          const result = await this.gameService.handleDailyCheckin(userId);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '签到');
          return this.wrap(result);
        }

        case '新手教程':
        case 'tutorial':
          return this.wrap(await this.tutorialService.handleTutorial(userId, firstArg));

        case '文本发送':
        case 'text-send':
          return this.wrap(await this.gameService.handleTextSend(userId, firstArg));

        case '查看指定玩家':
        case 'view-player':
          return this.wrap(await this.gameService.handleViewPlayer(userId, firstArg));

        // ========== 社交/基础 ==========
        case '扶':
        case 'help-up':
          return this.wrap(await this.gameService.handleHelpUp(userId));

        case '呼叫':
        case 'call': {
          const result = await this.gameService.handleCallVehicle(userId, arg);
          return this.wrap(result);
        }

        // ========== 安装/拆卸 ==========
        case '安装全部':
        case 'install-all':
          return this.wrap(await this.gameService.handleInstallAll(userId));

        case '拆卸全部':
        case 'uninstall-all':
          return this.wrap(await this.gameService.handleUninstallAll(userId));

        // ========== 背包操作 ==========
        case '背包操作':
        case 'bag-ops':
          return this.wrap(await this.gameService.handleBagOps(userId));

        // ========== 装备 ==========
        case '装备强化':
        case 'equip-enhance': {
          const result = await this.gameService.handleEquipEnhance(userId, firstArg);
          const part = firstArg.replace(/\d+/g, '').trim();
          if (part && this.isSuccessfulAction(result)) {
            const count = Number(firstArg.match(/\d+/)?.[0] || 1);
            await this.taskService.advance(userId, '强化' + part, count);
          }
          return this.wrap(result);
        }

        case '装备加成':
        case 'equip-bonus':
          return this.wrap(await this.gameService.handleEquipBonus(userId, firstArg));

        case '装备预设':
        case 'equip-preset':
          return this.wrap(await this.gameService.handleEquipPreset(userId, firstArg, args.slice(1)));

        // ========== 商店 ==========
        // 活跃度/钻石/数据三个商店统一委托给使魔商店子系统显示对应子商店
        case '活跃度商店':
        case 'activity-shop':
          return this.wrap(await this.familiarSystem.familiarShop(userId, 'activity'));

        case '钻石商店':
        case 'diamond-shop':
          return this.wrap(await this.familiarSystem.familiarShop(userId, 'diamond'));

        case '数据商店':
        case 'data-shop':
          return this.wrap(await this.familiarSystem.familiarShop(userId, 'dataCore'));

        // ========== 探测扩展 ==========
        // 原版探测系列：无关键词=汇总提示/全部列表；有关键词=定向搜索
        case '探测雷达':
        case 'probe-radar': {
          const result = await this.gameService.handleProbeRadar(userId);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '探测雷达');
          return this.wrap(result);
        }

        case '探测资源':
        case 'probe-resource':
          return this.wrap(await this.gameService.handleProbeResources(userId, firstArg));

        case '探测拾取':
        case 'probe-pickup':
          return this.wrap(await this.gameService.handleProbeAndPickup(userId, firstArg));

        case '探测作物':
        case 'probe-crop':
          return this.wrap(await this.gameService.handleProbeCrops(userId, firstArg));

        // ========== 宠物扩展 ==========
        case '宠物操作':
        case 'pet-ops':
          return this.wrap(await this.familiarSystem.handlePet(userId, firstArg));

        case '宠物改名':
        case 'pet-rename':
          return this.wrap(await this.familiarSystem.renamePet(userId, firstArg, args.slice(1).join(' ')));

        case '宠物转让':
        case 'pet-transfer':
          return this.wrap(await this.familiarSystem.transferPet(userId, firstArg, args.slice(1).join(' ')));

        case '宠物驾驶':
        case 'pet-drive':
          return this.wrap(await this.familiarSystem.petDrive(userId, firstArg, args.slice(1).join(' ')));

        case '宠物喂食':
        case 'pet-feed':
          return this.wrap(await this.familiarSystem.petFeed(userId, firstArg, parseInt(args[1], 10) || 1));

        case '宠物嗅探':
        case 'pet-sniff':
          return this.wrap(await this.familiarSystem.petSniff(userId, firstArg, args.slice(1).join(' ')));

        case '宠物觉醒':
        case 'pet-awaken':
        {
          const result = await this.familiarSystem.petAwaken(userId, firstArg, args.slice(1).join(' '));
          const awakened = Number(result.match(/觉醒了(\d+)次/)?.[1] || 0);
          if (awakened > 0) await this.taskService.advance(userId, '觉醒宠物', awakened);
          return this.wrap(result);
        }

        case '宠物攻击':
        case 'pet-attack':
          return this.wrap(await this.familiarSystem.petAttack(userId, firstArg));

        case '宠物前往':
        case 'pet-goto':
          return this.wrap(await this.familiarSystem.petGoto(userId, firstArg, args.slice(1).join(' ')));

        case '宠物装备':
        case 'pet-equip':
          return this.wrap(await this.familiarSystem.petEquip(userId, firstArg, args.slice(1).join(' ')));

        // ========== 全部指令 ==========
        case '全部跟随':
        case 'follow-all':
        case 'all-follow':
          return this.wrap(await this.gameService.handleFollowAll(userId));

        case '全部停下':
        case 'all-stop':
          return this.wrap(await this.gameService.handleAllStop(userId));

        case '全部主动':
        case 'all-active':
          return this.wrap(await this.gameService.handleAllActive(userId));

        case '全部被动':
        case 'all-passive':
          return this.wrap(await this.gameService.handleAllPassive(userId));

        case '全部挤奶':
        case 'all-milk':
          return this.wrap(await this.gameService.handleAllMilk(userId));

        case '全部指令':
        case 'all-commands':
          return this.wrap(await this.gameService.handleAllCommands(userId));

        // ========== 家园扩展 ==========
        case '家园操作':
        case 'home-ops':
          return this.wrap(await this.familiarSystem.handleHome(userId, '家园操作', ...args));

        case '家园前线':
        case 'home-front':
          return this.wrap(await this.familiarSystem.handleHome(userId, '家园前线', ...args));

        case '家园产出':
        case 'home-output':
          return this.wrap(await this.familiarSystem.handleHome(userId, '家园产出', ...args));

        case '家园音乐':
        case 'home-music':
          return this.wrap(await this.familiarSystem.handleHome(userId, '家园音乐', ...args));

        case '家园搬迁':
        case 'home-relocate':
          return this.wrap(await this.familiarSystem.handleHome(userId, '家园搬迁', ...args));

        case '家园命名':
        case 'home-rename':
          return this.wrap(await this.familiarSystem.handleHome(userId, '家园命名', ...args));

        // ========== 开采扩展 ==========
        case '开采自动':
        case 'auto-mine': {
          const result = await this.gameService.handleAutoMine(userId);
          if (this.isSuccessfulAction(result)) await this.taskService.advance(userId, '开采自动');
          return this.wrap(result);
        }

        case '开采停止':
        case 'stop-mine':
          return this.wrap(await this.gameService.handleStopMine(userId));

        // ========== 配方 ==========
        case '配方解锁':
        case 'recipe-unlock':
          return this.wrap(await this.gameService.handleRecipeUnlock(userId, arg));

        // ========== 求助/购物扩展 ==========
        case '求助确认':
        case 'confirm-help':
          return this.wrap(await this.gameService.handleConfirmHelp(userId, firstArg));

        case '购物自动':
        case 'auto-shop':
          return this.wrap(await this.gameService.handleAutoShop(userId, firstArg));

        // ========== 管理/调试 ==========
        case '刷新怪物':
        case 'refresh-monster':
          return this.wrap(await this.gameService.handleRefreshMonster(userId));

        case '删除怪物':
        case 'delete-monster':
          return this.wrap(await this.gameService.handleDeleteMonster(userId));

        case '生成人物':
        case 'spawn-npc':
          return this.wrap(await this.gameService.handleSpawnNpc(userId, firstArg));

        // ========== 生产模式 ==========
        case '生产0':
        case 'prod-mode-0':
          return this.wrap(await this.gameService.handleVehicleProduction(userId, '0'));

        case '生产1':
        case 'prod-mode-1':
          return this.wrap(await this.gameService.handleVehicleProduction(userId, '1'));

        // ========== 铠甲合体 ==========
        case '炎龙':
        case 'yanlong':
          return this.wrap(await this.gameService.handleArmorCombine(userId, '炎龙'));

        case '黑犀':
        case 'heixi':
          return this.wrap(await this.gameService.handleArmorCombine(userId, '黑犀'));

        case '飞影':
        case 'feiying':
          return this.wrap(await this.gameService.handleArmorCombine(userId, '飞影'));

        case '地虎':
        case 'dihu':
          return this.wrap(await this.gameService.handleArmorCombine(userId, '地虎'));

        case '雪獒':
        case 'xueao':
          return this.wrap(await this.gameService.handleArmorCombine(userId, '雪獒'));

        // ========== 其他 ==========
        case '转换文本':
        case 'transform-text':
          return this.wrap(await this.gameService.handleTransformText(userId, firstArg));

        case '保存图片':
        case 'save-image':
          return this.wrap(await this.gameService.handleSaveImage(userId, firstArg));

        case '保存图片开始':
        case 'start-save-image':
          return this.wrap(await this.gameService.handleStartSaveImage(userId));

        case '保存图片停止':
        case 'stop-save-image':
          return this.wrap(await this.gameService.handleStopSaveImage(userId));

        // ========== 接管停止 ==========
        case '接管停止':
        case 'stop-takeover':
          return this.wrap(await this.gameService.handleStopTakeover(userId));

        // ========== 确认还原 ==========
        case '确认还原植入体等级':
        case 'confirm-reset-implant':
          return this.wrap(await this.gameService.handleConfirmResetImplant(userId));

        case '确认还原增幅器等级':
        case 'confirm-reset-amplifier':
          return this.wrap(await this.gameService.handleConfirmResetAmplifier(userId));

        default: {
          // 资源采集指令（对应原版 gatherCmd，如 打开箱子/打开休眠仓/收集物品/捡垃圾）
          // 将指令名映射为地图固定资源的采集动作
          const compactGather = cmdName.match(/^(.*?)(\d+)$/);
          const gatherName = compactGather ? compactGather[1].trim() : cmdName;
          const gatherCount = compactGather ? Math.max(1, Number(compactGather[2])) : 1;
          const gatherResult = await this.gameService.handleGatherResource(userId, gatherName, gatherCount);
          if (gatherResult && this.isSuccessfulAction(gatherResult)) {
            return this.wrap(gatherResult);
          }
          return this.wrap(`未知指令「${cmdName}」`);
        }
      }
    } catch (err: any) {
      return { success: false, content: `指令执行错误: ${err.message}`, broadcast: false, durationMs: 0 };
    }
  }

  /**
   * 家园命令路由
   * 将新版生产相关的家园子命令分发到 HomeService，其他保持原有路由
   */
  private async handleHomeCommand(userId: number, subCommand: string, args: string[]): Promise<string> {
    const normalizedSubCommand = String(subCommand || '').trim();

    // 原版家园菜单直接生成“安装基础发电机1/拆卸基础发电机2”这类无空格快捷指令。
    // 兼容它们，同时保留“家园 安装 ...”形式。
    const compactHomeAction = normalizedSubCommand.match(/^(安装|拆卸)(.+)$/);
    if (normalizedSubCommand === '安装' || normalizedSubCommand === '拆卸' || compactHomeAction) {
      const actionName = compactHomeAction?.[1] || normalizedSubCommand;
      const raw = compactHomeAction?.[2]?.trim() || args.join(' ').trim();
      if (actionName === '安装') {
        const action = this.parseCountedAction(raw);
        const result = await this.gameService.handleInstall(userId, raw);
        if (this.isSuccessfulAction(result)) {
          const count = this.parseActionResultCount(result, action.count);
          await this.taskService.advance(userId, '安装', count);
          if (action.name) await this.taskService.advance(userId, '安装' + action.name, count);
        }
        return result;
      }
      const action = this.parseCountedAction(raw);
      const result = await this.gameService.handleUninstallPart(userId, action.name, action.count);
      if (this.isSuccessfulAction(result)) {
        const count = this.parseActionResultCount(result, action.count);
        await this.taskService.advance(userId, '拆卸部件', count);
        if (action.name) await this.taskService.advance(userId, '拆卸' + action.name, count);
      }
      return result;
    }

    // 生产相关的子命令由 HomeService 处理
    const productionCommands = ['建造', '拆除', '种植', '收获', '生产'];
    if (productionCommands.includes(normalizedSubCommand)) {
      try {
        const playerData = await this.playerService.getPlayerData(userId);
        const { player, markers } = playerData;
        const yardAction = ['建造', '拆除', '种植', '收获'].includes(normalizedSubCommand);
        const map = yardAction ? await this.gameService.getCurrentMap(userId) : null;
        if (yardAction && (!map || !player.houseName || map.name !== player.houseName)) {
          return `${player.name || '冒险者'}只能在自己的院子里进行${normalizedSubCommand}操作`;
        }
        const backpack = this.playerService.safeJsonParse<any[]>(player.backpack, []);

        // 加载建筑定义列表
        const buildingDefs = await this.homeService.getAllBuildingDefs();

        let result;
        switch (normalizedSubCommand) {
          case '建造': {
            const buildingName = args.join(' ') || (args[0] || '');
            if (!buildingName) return '请指定要建造的建筑名称，例如：建造 训练器';
            const buildResult = await this.homeService.buildBuilding(map, buildingName, buildingDefs, backpack);
            if (buildResult.success) {
              // 保存地图和背包变更
              await this.gameService.updateMapBuildings(map.id, map.buildings);
              player.backpack = backpack;
              await this.playerService.savePlayer(player);
              // 自动推进任务
              await this.taskService.advance(userId, '建造');
              await this.taskService.advance(userId, '建筑数量');
              await this.taskService.advance(userId, '安装' + buildingName);
            }
            return buildResult.message;
          }

          case '拆除': {
            const parsed = this.parseCountedAction(args.join(' '));
            const buildingName = parsed.name;
            if (!buildingName) return '请指定要拆除的建筑名称，例如：拆除 训练器';
            let removed = 0;
            let removeResult: { success: boolean; message: string } = {
              success: false,
              message: `地图上没有「${buildingName}」`,
            };
            for (let i = 0; i < parsed.count; i++) {
              removeResult = await this.homeService.removeBuilding(map, buildingName, buildingDefs, backpack);
              if (!removeResult.success) break;
              removed++;
            }
            if (removed > 0) {
              await this.gameService.updateMapBuildings(map.id, map.buildings);
              player.backpack = backpack;
              await this.playerService.savePlayer(player);
              await this.taskService.advance(userId, '拆除', removed);
              await this.taskService.advance(userId, `拆除${buildingName}`, removed);
            }
            return removed === parsed.count
              ? `拆除了「${buildingName}」×${removed}`
              : removed > 0
                ? `拆除了「${buildingName}」×${removed}\n${removeResult.message}`
                : removeResult.message;
          }

          case '种植': {
            const parsed = this.parseCountedAction(args.join(' '));
            const seedName = parsed.name;
            if (!seedName) return '请指定要种植的种子名称，例如：种植 小麦种子';
            let planted = 0;
            let plantedCropName = '';
            let plantResult: { success: boolean; message: string } = { success: false, message: '' };
            for (let i = 0; i < parsed.count; i++) {
              plantResult = await this.homeService.plantSeed(map, seedName, backpack, buildingDefs);
              if (!plantResult.success) break;
              planted++;
              plantedCropName ||= plantResult.message.match(/「([^」]+)」/)?.[1] || seedName.replace(/种子$/, '');
            }
            if (planted > 0) {
              await this.gameService.updateMapBuildings(map.id, map.buildings, map.resources2);
              player.backpack = backpack;
              await this.playerService.savePlayer(player);
              await this.taskService.advance(userId, '种植', planted);
              if (plantedCropName) await this.taskService.advance(userId, `种植${plantedCropName}`, planted);
            }
            if (planted === parsed.count) {
              return '成功种植了' + planted + '个「' + seedName.replace(/种子$/, '') + '」';
            }
            if (planted > 0) {
              return '成功种植了' + planted + '个「' + seedName.replace(/种子$/, '') + '」\n' + plantResult.message;
            }
            return plantResult.message;
          }

          case '收获': {
            const cropName = args.join(' ') || (args[0] || '');
            if (!cropName) return '请指定要收获的作物名称，例如：收获 小麦';
            const harvestResult = await this.homeService.harvestCrop(map, cropName, buildingDefs, backpack);
            if (harvestResult.success) {
              await this.gameService.updateMapBuildings(map.id, map.buildings, map.resources2);
              player.backpack = backpack;
              await this.playerService.savePlayer(player);
              await this.taskService.advance(userId, '收获');
              await this.taskService.advance(userId, `收获${cropName}`);
            }
            return harvestResult.message;
          }

          case '生产': {
            // 生产操作直接观测并领取家园产出，对应地图操作.ecode 观测地图。
            const productionResult = await this.homeService.collectHomeOutput(userId);
            if (this.isSuccessfulAction(productionResult)) {
              await this.taskService.advance(userId, '生产');
            }
            return productionResult;
          }

          default:
            return `家园功能「${normalizedSubCommand}」开发中`;
        }
      } catch (e) {
        this.logger.warn(`家园操作失败: ${e.message}`);
        return `家园操作失败: ${e.message}`;
      }
    }

    // 其他子命令保持原有路由到 familiarSystem.handleHome
    return await this.familiarSystem.handleHome(userId, normalizedSubCommand, ...args);
  }

  private wrap(content: string): CommandResult {
    return { success: this.isSuccessfulResponse(content), content, broadcast: true, durationMs: 0 };
  }
}
