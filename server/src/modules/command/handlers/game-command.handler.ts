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
    const rawMsg = ctx.rawMessage.trim();
    const cmdName = rawMsg.replace(/^[\/！!]/, '').split(/\s+/)[0];

    return this.dispatch(ctx, cmdName, args);
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
      // 保存标记到数据库
      markers['指引_' + tutorialType] = 1;
      await this.playerService.savePlayer({ id: playerData.player.id, markers });
    }
    return text;
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
          // 检查新手指引
          const tutorialText = await this.checkTutorial(userId, 'attack');
          if (tutorialText) {
            return this.wrap(tutorialText);
          }
          const result = await this.combatSystem.weaponAttack(userId, 0, {});
          // 自动推进任务
          await this.taskService.advance(userId, '攻击');
          await this.taskService.advance(userId, '击杀');
          return this.wrap(result.result);
        }

        case '炮击':
        case 'cannon':
          return this.wrap(await this.combatSystem.cannonAttack(userId));

        case '信息':
        case 'info':
        case '资料':
        case '查看': {
          // 检查新手指引
          const tutorialText = await this.checkTutorial(userId, 'info');
          if (tutorialText) {
            return this.wrap(tutorialText);
          }
          return this.wrap(await this.gameService.handleInfo(userId));
        }

        case '背包':
        case 'inventory': {
          // 检查新手指引
          const tutorialText = await this.checkTutorial(userId, 'viewBag');
          if (tutorialText) {
            return this.wrap(tutorialText);
          }
          return this.wrap(await this.gameService.handleInventory(userId));
        }

        case '移动':
        case 'move':
        case '前往':
        case '去':
        case '飞到':
          // 自动推进任务
          await this.taskService.advance(userId, '探索', arg);
          return this.wrap(await this.gameService.handleMove(userId, arg));

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
          // 自动推进任务
          await this.taskService.advance(userId, '装备', arg);
          return this.wrap(await this.gameService.handleEquip(userId, arg));
        }

        case '卸下':
        case 'unequip':
        case '脱下':
          return this.wrap(await this.gameService.handleUnequip(userId, firstArg));

        case '使用':
        case 'use':
          // 自动推进任务
          await this.taskService.advance(userId, '使用', arg);
          return this.wrap(await this.gameService.handleUseItem(userId, arg));

        // ========== 物品系统 ==========
        case '制造':
        case 'craft':
        case '制作': {
          // 自动推进任务
          await this.taskService.advance(userId, '制造', arg);
          return this.wrap(await this.itemSystem.craftItem(userId, arg));
        }

        case '分解':
        case 'deconstruct':
          return this.wrap(await this.itemSystem.deconstructItem(userId, firstArg));

        case '丢弃':
        case 'discard':
        case '扔掉':
          return this.wrap(await this.itemSystem.discardItem(userId, firstArg));

        case '移除':
        case 'remove':
          return this.wrap(`移除功能开发中`);

        case '保护':
        case 'protect':
          return this.wrap(await this.itemSystem.protectItem(userId, arg));

        case '强化':
        case 'enhance':
        case '升级':
          return this.wrap(await this.itemSystem.enhanceItem(userId, arg));

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

        case '命名使魔':
        case 'name-familiar':
          return this.wrap(await this.familiarSystem.nameFamiliar(userId, arg));

        case '使魔数据':
        case 'familiar-data': {
          // 检查新手指引
          const tutorialText = await this.checkTutorial(userId, 'familiarData');
          if (tutorialText) {
            return this.wrap(tutorialText);
          }
          return this.wrap(await this.familiarSystem.viewFamiliarData(userId));
        }

        case '使魔商店':
        case 'familiar-shop':
          return this.wrap(await this.familiarSystem.familiarShop(userId, firstArg || undefined));

        case '兑换':
        case 'exchange':
          // 自动推进任务
          await this.taskService.advance(userId, '兑换', firstArg);
          return this.wrap(await this.familiarSystem.exchange(userId, firstArg));

        // ========== 使魔技能系统 ==========
        case '六道轮回':
        case 'six-paths':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '六道轮回'));

        case '怒吼':
        case 'roar':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '怒吼'));

        case '万象':
        case 'myriad-visions':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '万象'));

        case '誓约胜利之剑':
        case 'excalibur':
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

        // 通用/装备技能
        case '洗脑':
        case 'brainwash':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '洗脑', firstArg));

        case '砸瓦鲁多':
        case 'za-warudo':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '砸瓦鲁多'));

        case '训练':
        case 'train':
          return this.wrap(await this.familiarSkills.executeSkill(userId, '训练'));

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
          // 新版家园子命令路由：生产相关的子命令由 HomeService 处理
          // 建造/拆除/种植/收获/生产 由 HomeService 处理
          // 其他子命令（music/搬迁/命名/产出/前线/圈地/开挖地基/建造地基/建造房子/查看）保持原有路由
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
          return this.wrap(await this.handleHomeCommand(userId, '生产', args));

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
        case 'capture':
          // 自动推进任务
          await this.taskService.advance(userId, '捕捉', firstArg);
          return this.wrap(await this.familiarSystem.capturePet(userId, firstArg, args.slice(1).join(' ')));

        // ========== 地图/探索 ==========
        case '传送':
        case 'teleport':
        case '跃迁':
          // 自动推进任务
          await this.taskService.advance(userId, '传送', arg);
          return this.wrap(await this.gameService.handleMove(userId, arg));

        case '探测':
        case 'probe':
        case 'scout':
          return this.wrap(await this.gameService.handleProbe(userId));

        case '拾取':
        case 'pickup': {
          // 检查新手指引
          const tutorialText = await this.checkTutorial(userId, 'pickup');
          if (tutorialText) {
            return this.wrap(tutorialText);
          }
          // 自动推进任务
          await this.taskService.advance(userId, '拾取', arg);
          return this.wrap(await this.gameService.handlePickup(userId, arg));
        }

        case '开采':
        case 'mine':
          // 自动推进任务
          await this.taskService.advance(userId, '开采', firstArg);
          return this.wrap(await this.gameService.handleMine(userId, firstArg));

        // ========== 副本系统 ==========
        case '开启副本':
        case 'start-dungeon':
          return this.wrap(await this.gameService.handleStartDungeon(userId));

        case '刷新副本':
        case 'refresh-dungeon':
          return this.wrap(await this.gameService.handleRefreshDungeon(userId));

        // ========== 载具系统 ==========
        case '安装':
        case 'install':
          return this.wrap(await this.gameService.handleInstallPart(userId, arg));

        case '拆卸':
        case 'uninstall':
          return this.wrap(await this.gameService.handleUninstallPart(userId, arg));

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
          return this.wrap(await this.gameService.handleViewQuests(userId));

        case '提交任务':
        case 'complete-quest':
          return this.wrap(await this.gameService.handleCompleteQuest(userId, arg));

        // ========== 社交系统 ==========
        case '对话':
        case 'talk':
        case '交谈':
          return this.wrap(await this.gameService.handleTalk(userId, arg));

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
          const isFollow = parts[1] !== 'stop' && parts[1] !== 'false' && parts[1] !== '取消';
          return this.wrap(await this.familiarSystem.setFollow(userId, targetName, isFollow));
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
          return this.wrap(await this.gameService.handleSettingsGuide(userId, firstArg));

        case '设置随机':
        case 'setting-random':
          return this.wrap(await this.gameService.handleSettingsRandom(userId, firstArg));

        case '设置采集':
        case 'setting-gather':
          return this.wrap(await this.gameService.handleSettingsGather(userId, firstArg));

        case '设置活力':
        case 'setting-vitality':
          return this.wrap(await this.gameService.handleSettingsVitality(userId, firstArg));

        case '设置不扶':
        case 'setting-no-help':
          return this.wrap(await this.gameService.handleSettingsNoHelp(userId, firstArg));

        case '设置音乐':
        case 'setting-music':
          return this.wrap(await this.gameService.handleSettingsMusic(userId, firstArg));

        case '设置倍率':
        case 'setting-multiplier':
          return this.wrap(await this.gameService.handleSettingsMultiplier(userId, firstArg));

        case '设置购物':
        case 'setting-shop':
          return this.wrap(await this.gameService.handleSettingsShop(userId, firstArg));

        case '设置位置':
        case 'setting-location':
          return this.wrap(await this.gameService.handleSettingsLocation(userId, firstArg));

        case '设置标记':
        case 'setting-marker':
          return this.wrap(await this.gameService.handleSettingsMarker(userId, firstArg));

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
          return this.wrap(await this.gameService.handleSweep(userId));

        case '闪避':
        case 'dodge':
          // 释放闪避技能
          return this.wrap(await this.gameService.handleDodge(userId));

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
        case 'enhance-implant':
          return this.wrap(await this.gameService.handleEnhanceImplant(userId, firstArg));

        case '查看植入体':
        case 'view-implant':
          return this.wrap(await this.gameService.handleViewImplant(userId));

        case '切换植入体':
        case 'switch-implant':
          return this.wrap(await this.gameService.handleSwitchImplant(userId, firstArg));

        case '还原植入体':
        case 'reset-implant':
          return this.wrap(await this.gameService.handleResetImplant(userId));

        case '查看增幅器':
        case 'view-amplifier':
          return this.wrap(await this.gameService.handleViewAmplifier(userId));

        case '切换增幅器':
        case 'switch-amplifier':
          return this.wrap(await this.gameService.handleSwitchAmplifier(userId, firstArg));

        case '强化增幅器':
        case 'enhance-amplifier':
          return this.wrap(await this.gameService.handleEnhanceAmplifier(userId, firstArg));

        case '还原增幅器':
        case 'reset-amplifier':
          return this.wrap(await this.gameService.handleResetAmplifier(userId));

        case '炼丹':
        case 'alchemy':
          return this.wrap(await this.gameService.handleAlchemy(userId, firstArg));

        case '融合':
        case 'merge':
          return this.wrap(await this.gameService.handleMerge(userId, firstArg));

        case '锻造':
        case 'forge':
          return this.wrap(await this.gameService.handleForge(userId, firstArg));

        case '育种':
        case 'breed':
          return this.wrap(await this.gameService.handleBreed(userId, firstArg));

        // ========== 使魔系统命令 ==========
        case '通用技能':
        case 'common-skills':
          return this.wrap(await this.gameService.handleCommonSkills(userId));

        case '使魔称号':
        case 'familiar-titles':
          return this.wrap(await this.gameService.handleFamiliarTitles(userId));

        case '领取称号':
        case 'claim-title':
          return this.wrap(await this.gameService.handleClaimTitle(userId, firstArg));

        case '佩戴称号':
        case 'equip-title':
          return this.wrap(await this.gameService.handleEquipTitle(userId, firstArg));

        case '使魔排行':
        case 'familiar-rank':
          return this.wrap(await this.gameService.handleFamiliarRank(userId));

        case '大召唤术':
        case 'mass-summon':
          return this.wrap(await this.gameService.handleMassSummon(userId, firstArg));

        case '复活使魔':
        case 'revive-familiar':
          return this.wrap(await this.gameService.handleReviveFamiliar(userId));

        case '安乐天使':
        case 'ease-angel':
          return this.wrap(await this.gameService.handleEaseAngel(userId));

        case '福音书':
        case 'gospel':
          return this.wrap(await this.gameService.handleGospel(userId));

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

        // ========== 地图/探索命令 ==========
        case '观察附近':
        case 'look-around':
          return this.wrap(await this.gameService.handleLookAround(userId));

        case '召唤货舱':
        case 'summon-cargo':
          return this.wrap(await this.gameService.handleSummonCargo(userId));

        case '发射信号枪':
        case 'signal-gun':
          return this.wrap(await this.gameService.handleSignalGun(userId));

        // ========== 副本命令 ==========
        case '副本清空':
        case 'clear-dungeon':
          return this.wrap(await this.gameService.handleClearDungeon(userId));

        // ========== 载具命令 ==========
        case '组装':
        case 'assemble':
          return this.wrap(await this.gameService.handleAssembleVehicle(userId, firstArg));

        case '驾驶':
        case 'drive':
          return this.wrap(await this.gameService.handleDriveVehicle(userId, firstArg));

        case '载具命名':
        case 'name-vehicle':
          return this.wrap(await this.gameService.handleNameVehicle(userId, firstArg));

        case '载具模拟':
        case 'simulate-vehicle':
          return this.wrap(await this.gameService.handleSimulateVehicle(userId, firstArg));

        case '维修':
        case 'repair':
          return this.wrap(await this.gameService.handleRepairVehicle(userId, firstArg));

        case '脱出':
        case 'exit':
          return this.wrap(await this.gameService.handleExitVehicle(userId));

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
          return this.wrap(await this.gameService.handleControlTerminal(userId));

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
          return this.wrap(await this.gameService.handleStopCapture(userId));

        case '全部跟随':
        case 'follow-all':
          return this.wrap(await this.gameService.handleFollowAll(userId));

        case '补魔':
        case 'refill':
          return this.wrap(await this.gameService.handleRefill(userId));

        case '挤奶':
        case 'milk':
          return this.wrap(await this.gameService.handleMilk(userId, firstArg));

        case '剪毛':
        case 'shear':
          return this.wrap(await this.gameService.handleShear(userId, firstArg));

        // ========== 任务/设置命令 ==========
        case '放弃任务':
        case 'abandon-quest':
          return this.wrap(await this.gameService.handleAbandonQuest(userId, firstArg));

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
          return this.wrap(await this.gameService.handleTrade(userId, firstArg, args.slice(1)));

        case '购物':
        case 'shop':
          return this.wrap(await this.gameService.handleShop(userId, firstArg, args.slice(1)));

        case '求助':
        case 'help-me':
          return this.wrap(await this.gameService.handleHelpMe(userId, firstArg));

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
        case 'daily-checkin':
          return this.wrap(await this.gameService.handleDailyCheckin(userId));

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
        case 'call':
          return this.wrap(await this.gameService.handleCallVehicle(userId, arg));

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
        case 'equip-enhance':
          return this.wrap(await this.gameService.handleEquipEnhance(userId, firstArg));

        case '装备加成':
        case 'equip-bonus':
          return this.wrap(await this.gameService.handleEquipBonus(userId, firstArg));

        case '装备预设':
        case 'equip-preset':
          return this.wrap(await this.gameService.handleEquipPreset(userId, firstArg, args.slice(1)));

        // ========== 商店 ==========
        case '活跃度商店':
        case 'activity-shop':
          return this.wrap(await this.gameService.handleActivityShop(userId, arg));

        case '钻石商店':
        case 'diamond-shop':
          return this.wrap(await this.gameService.handleDiamondShop(userId, arg));

        case '数据商店':
        case 'data-shop':
          return this.wrap(await this.gameService.handleDataShop(userId, arg));

        // ========== 探测扩展 ==========
        case '探测雷达':
        case 'probe-radar':
          return this.wrap(await this.gameService.handleProbeRadar(userId));

        case '探测资源':
        case 'probe-resource':
          return this.wrap(await this.gameService.handleProbeResources(userId));

        case '探测拾取':
        case 'probe-pickup':
          return this.wrap(await this.gameService.handleProbeAndPickup(userId));

        case '探测作物':
        case 'probe-crop':
          return this.wrap(await this.gameService.handleProbeCrops(userId));

        // ========== 宠物扩展 ==========
        case '宠物操作':
        case 'pet-ops':
          return this.wrap(await this.gameService.handlePetOps(userId, firstArg, args.slice(1)));

        case '宠物改名':
        case 'pet-rename':
          return this.wrap(await this.gameService.handlePetRename(userId, firstArg, args.slice(1).join(' ')));

        case '宠物转让':
        case 'pet-transfer':
          return this.wrap(await this.gameService.handlePetTransfer(userId, firstArg, args.slice(1).join(' ')));

        case '宠物驾驶':
        case 'pet-drive':
          return this.wrap(await this.gameService.handlePetDrive(userId, firstArg));

        case '宠物喂食':
        case 'pet-feed':
          return this.wrap(await this.gameService.handlePetFeed(userId, firstArg));

        case '宠物嗅探':
        case 'pet-sniff':
          return this.wrap(await this.gameService.handlePetSniff(userId, firstArg));

        case '宠物觉醒':
        case 'pet-awaken':
          return this.wrap(await this.gameService.handlePetAwaken(userId, firstArg));

        case '宠物攻击':
        case 'pet-attack':
          return this.wrap(await this.gameService.handlePetAttack(userId, firstArg));

        case '宠物前往':
        case 'pet-goto':
          return this.wrap(await this.gameService.handlePetGoto(userId, firstArg));

        case '宠物装备':
        case 'pet-equip':
          return this.wrap(await this.gameService.handlePetEquip(userId, arg));

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
        case 'auto-mine':
          return this.wrap(await this.gameService.handleAutoMine(userId));

        case '开采停止':
        case 'stop-mine':
          return this.wrap(await this.gameService.handleStopMine(userId));

        // ========== 配方 ==========
        case '配方解锁':
        case 'recipe-unlock':
          return this.wrap(await this.gameService.handleRecipeUnlock(userId, firstArg));

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
          return this.wrap(await this.gameService.handleProductionMode(userId, 0));

        case '生产1':
        case 'prod-mode-1':
          return this.wrap(await this.gameService.handleProductionMode(userId, 1));

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

        default:
          return this.wrap(`未知指令「${cmdName}」`);
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
    // 生产相关的子命令由 HomeService 处理
    const productionCommands = ['建造', '拆除', '种植', '收获', '生产'];
    if (productionCommands.includes(subCommand)) {
      try {
        const playerData = await this.playerService.getPlayerData(userId);
        const { player, markers } = playerData;
        const map = await this.gameService.getCurrentMap(userId);
        const backpack = this.playerService.safeJsonParse<any[]>(player.backpack, []);

        // 加载建筑定义列表
        const buildingDefs = await this.homeService.getAllBuildingDefs();

        let result;
        switch (subCommand) {
          case '建造': {
            const buildingName = args.join(' ') || (args[0] || '');
            if (!buildingName) return '请指定要建造的建筑名称，例如：建造 训练器';
            const buildResult = await this.homeService.buildBuilding(map, buildingName, buildingDefs, backpack);
            if (buildResult.success) {
              // 保存地图和背包变更
              await this.gameService.updateMapBuildings(map.id, map.buildings);
              player.backpack = JSON.stringify(backpack);
              await this.playerService.savePlayer(player);
              // 自动推进任务
              await this.taskService.advance(userId, '建造', buildingName);
            }
            return buildResult.message;
          }

          case '拆除': {
            const buildingName = args.join(' ') || (args[0] || '');
            if (!buildingName) return '请指定要拆除的建筑名称，例如：拆除 训练器';
            const removeResult = await this.homeService.removeBuilding(map, buildingName, buildingDefs, backpack);
            if (removeResult.success) {
              await this.gameService.updateMapBuildings(map.id, map.buildings);
              player.backpack = JSON.stringify(backpack);
              await this.playerService.savePlayer(player);
            }
            return removeResult.message;
          }

          case '种植': {
            const seedName = args.join(' ') || (args[0] || '');
            if (!seedName) return '请指定要种植的种子名称，例如：种植 小麦种子';
            const plantResult = await this.homeService.plantSeed(map, seedName, backpack, buildingDefs);
            if (plantResult.success) {
              await this.gameService.updateMapBuildings(map.id, map.buildings);
              player.backpack = JSON.stringify(backpack);
              await this.playerService.savePlayer(player);
              await this.taskService.advance(userId, '种植', seedName);
            }
            return plantResult.message;
          }

          case '收获': {
            const cropName = args.join(' ') || (args[0] || '');
            if (!cropName) return '请指定要收获的作物名称，例如：收获 小麦';
            const harvestResult = await this.homeService.harvestCrop(map, cropName, buildingDefs, backpack);
            if (harvestResult.success) {
              await this.gameService.updateMapBuildings(map.id, map.buildings);
              player.backpack = JSON.stringify(backpack);
              await this.playerService.savePlayer(player);
              await this.taskService.advance(userId, '收获', cropName);
            }
            return harvestResult.message;
          }

          case '生产': {
            // 生产操作：查看家园产出状态
            const buildingOutput = await this.homeService.getBuildingOutputRate(markers);
            return `🏭 家园产出状态\n产出倍率: ${buildingOutput}x\n使用「家园 查看」查看详细产出信息`;
          }

          default:
            return `家园功能「${subCommand}」开发中`;
        }
      } catch (e) {
        this.logger.warn(`家园操作失败: ${e.message}`);
        return `家园操作失败: ${e.message}`;
      }
    }

    // 其他子命令保持原有路由到 familiarSystem.handleHome
    return await this.familiarSystem.handleHome(userId, subCommand, ...args);
  }

  private wrap(content: string): CommandResult {
    return { success: true, content, broadcast: true, durationMs: 0 };
  }
}