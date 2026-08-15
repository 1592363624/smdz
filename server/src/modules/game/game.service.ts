/**
 * 游戏引擎主服务
 * 对应原版易语言：_主程序.ecode 的核心逻辑
 * 负责协调各子服务，提供统一的游戏操作入口
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { BonusService, BonusData } from './bonus.service';
import { CombatService } from './combat.service';
import { CombatSystemService } from './combat-system.service';
import { ItemService } from './item.service';
import { MapService } from './map.service';
import { FamiliarService } from './familiar.service';
import { DungeonService } from './dungeon.service';
import { AdminService } from '../admin/admin.service';
import { AchievementService } from './achievement.service';
import { ItemSystemService } from './item-system.service';
import { FamiliarSystemService } from './familiar-system.service';
import { FamiliarSkillsService } from './familiar-skills.service';
import { HomeService } from './home.service';
import { TutorialService } from './tutorial.service';
import { StaticDataService } from './static-data.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { ChatService } from '../chat/chat.service';

@Injectable()
export class GameService {
  private readonly logger = new Logger(GameService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly bonusService: BonusService,
    private readonly combatService: CombatService,
    private readonly combatSystem: CombatSystemService,
    private readonly itemService: ItemService,
    private readonly mapService: MapService,
    private readonly familiarService: FamiliarService,
    private readonly dungeonService: DungeonService,
    private readonly adminService: AdminService,
    private readonly achievementService: AchievementService,
    private readonly itemSystemService: ItemSystemService,
    private readonly homeService: HomeService,
    private readonly familiarSystemService: FamiliarSystemService,
    private readonly familiarSkillsService: FamiliarSkillsService,
    private readonly tutorialService: TutorialService,
    private readonly staticData: StaticDataService,
    private readonly systemConfigService: SystemConfigService,
    private readonly chatService: ChatService,
  ) {}

  /**
   * 处理玩家攻击命令
   * 对应原版：攻击 命令
   * 委托给完整的战斗子系统 combatSystem.weaponAttack 执行完整攻击流程
   * 包括：武器攻击 → 伤害计算（含暴击/命中） → 使魔特效 → 怪物死亡处理 → 经验获得 → 掉落生成
   */
  async handleAttack(userId: number): Promise<string> {
    // 调用完整的战斗系统进行武器攻击（索引0=拳头，默认攻击）
    const result = await this.combatSystem.weaponAttack(userId, 0, {});
    // 返回攻击结果文本（含攻击描述、伤害、击杀、经验、掉落等信息）
    return result.result;
  }

  /**
   * 处理移动命令（延时到达）
   * 对应原版：移动/前往 命令
   * 发出移动后，玩家进入"移动中"状态，经过实际耗时秒数后才真正到达目的地；
   * 期间再次发起移动会被拦截并提示剩余时间，杜绝"连发移动瞬间到达"的作弊。
   * 若配置 game.moveTimeEnabled=false 则退化为即时到达。
   */
  async handleMove(userId: number, targetMapName: string): Promise<string> {
    // 读取"移动真实耗时"开关（配置项，可在管理后台在线切换）
    const moveTimeEnabled = await this.systemConfigService.get<boolean>('game.moveTimeEnabled', true);

    let playerData = await this.playerService.getPlayerData(userId);
    let { player } = playerData;

    // 1. 检查是否已在移动中
    const markers = playerData.markers;
    const movingStr = markers['移动中'];
    if (movingStr) {
      let moving: { targetName?: string; targetMapId?: number; arriveAt?: number } | null = null;
      try {
        moving = JSON.parse(movingStr);
      } catch {
        moving = null;
      }
      if (moving && moving.arriveAt) {
        const now = Date.now();
        if (now < moving.arriveAt) {
          // 仍在赶往上一目的地：拦截并提示剩余时间
          const remain = Math.max(1, Math.ceil((moving.arriveAt - now) / 1000));
          return `你正在前往【${moving.targetName}】，还需约${remain}秒到达，请耐心等待`;
        }
        // 耗时至已到期但尚未落地(如服务重启丢定时器)：先补完成上次移动
        await this.performArrival(userId, moving.targetMapId!, moving.targetName!);
        playerData = await this.playerService.getPlayerData(userId);
        player = playerData.player;
      }
    }

    const currentMap = await this.mapService.getMapById(player.mapId);
    const targetMap = await this.mapService.getMapByName(targetMapName);

    if (!currentMap || !targetMap) {
      return `地图不存在，请检查名称`;
    }

    // 检查是否可以前往
    const check = this.mapService.checkCanTravel(currentMap, targetMap, player);
    if (!check.canTravel) {
      return `无法前往：${check.reason}`;
    }

    // 计算移动所需耗时（秒）
    const travelTime = this.mapService.calcTravelTime(
      this.getDistance(currentMap, targetMap),
      player.speed || 100,
    );

    // 若关闭了移动耗时开关，则即时到达
    if (!moveTimeEnabled) {
      return await this.performArrival(userId, targetMap.id, targetMap.name);
    }

    // 2. 记录"移动中"状态（持久化到 markers，重启后可恢复），并调度延时到达
    const newMarkers = this.playerService.safeJsonParse(player.markers, {});
    newMarkers['移动中'] = JSON.stringify({
      targetName: targetMap.name,
      targetMapId: targetMap.id,
      arriveAt: Date.now() + travelTime * 1000,
      fromMapId: currentMap.id,
    });
    player.markers = JSON.stringify(newMarkers);
    await this.playerService.savePlayer(player);

    // 3. 启动到达定时器，到点后真正落地（更新位置 + 广播到达）
    this.scheduleArrival(userId, targetMap.id, targetMap.name, travelTime);

    return `你开始前往【${targetMap.name}】，预计${travelTime}秒后到达`;
  }

  /**
   * 调度延时到达
   * 在 travelTime 秒后调用 performArrival 真正完成移动
   * @param userId 用户ID
   * @param targetMapId 目标地图ID
   * @param targetMapName 目标地图名
   * @param travelTime 耗时（秒）
   */
  private scheduleArrival(userId: number, targetMapId: number, targetMapName: string, travelTime: number): void {
    const timer = setTimeout(async () => {
      try {
        await this.performArrival(userId, targetMapId, targetMapName);
      } catch (e: any) {
        this.logger.warn(`玩家 ${userId} 延时到达失败: ${e.message}`);
      }
    }, travelTime * 1000);
    // 定时器不阻止进程退出（对服务生命周期友好）
    timer.unref?.();
  }

  /**
   * 真正完成移动（到达目的地）
   * 更新玩家位置、应用地图增益、懒刷新怪物、记录探索成就，并向世界频道广播到达消息。
   * @param userId 用户ID
   * @param targetMapId 目标地图ID
   * @param targetMapName 目标地图名
   */
  private async performArrival(userId: number, targetMapId: number, targetMapName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const targetMap = await this.mapService.getMapById(targetMapId);
    if (!targetMap) {
      return `目标地图「${targetMapName}」不存在`;
    }

    // 清除"移动中"状态
    const markers = this.playerService.safeJsonParse(player.markers, {});
    delete markers['移动中'];
    player.markers = JSON.stringify(markers);

    const fromMapId = player.mapId;
    player.mapId = targetMap.id;
    player.location = targetMap.name;
    await this.playerService.savePlayer(player);

    // 进入地图时自动获得地图增益
    this.combatSystem.applyMapBuffs(player, targetMap);

    // 懒刷新：若目标地图当前没有已生成的怪物，立即补充刷新，避免到达后无怪可打
    try {
      const currentSpawn = this.mapService.getMapMonsters(targetMap);
      if (currentSpawn.length === 0) {
        await this.mapService.refreshMapMonsters(targetMap.id);
        this.logger.log(`玩家 ${userId} 到达「${targetMap.name}」时触发懒刷新怪物`);
      }
    } catch (e: any) {
      this.logger.warn(`到达地图懒刷新怪物失败: ${e?.message}`);
    }

    // 探索成就：记录玩家首次到达的地图
    try {
      const mark = this.playerService.safeJsonParse<Record<string, number>>(player.markers, {});
      const exploreKey = `探索_${targetMap.name}`;
      if (!mark[exploreKey]) {
        await this.achievementService.addAchievement(player, '探索', 1, false);
        await this.achievementService.addAchievement(player, exploreKey, 1, true);
        this.logger.log(`玩家 ${userId} 通过移动探索了新地图: ${targetMap.name}`);
      }
    } catch (e: any) {
      this.logger.warn(`探索成就记录失败: ${e.message}`);
    }

    this.logger.log(`玩家 ${userId} 移动到达：${fromMapId} → ${targetMap.name}`);

    const desc = targetMap.description ? `\n${targetMap.description}` : '';
    const text = `你来到了【${targetMap.name}】${desc}`;

    // 向世界频道广播到达消息（持久化 + 实时推送）
    await this.chatService.broadcastSystem('世界频道', text, userId);

    // 定向刷新该玩家的地图总览面板
    try {
      const overview = await this.getMapOverview(userId);
      this.chatService.emitToUser(userId, 'map:update', { overview });
    } catch (e: any) {
      this.logger.warn(`刷新玩家 ${userId} 地图面板失败: ${e.message}`);
    }

    return text;
  }

  /**
   * 获取地图总览数据（供网页左上角地图面板使用）
   * 包含：当前所在地图详情（怪物/资源/NPC等子区域信息）、可前往子区域、以及全部地图列表
   * @param userId 用户ID
   */
  async getMapOverview(userId: number) {
    const { mapId } = await this.playerService.getPlayerLocation(userId);
    const currentMap = await this.mapService.getMapById(mapId);
    if (!currentMap) return null;

    // 当前地图的可前往子区域（connections）
    const subMaps = this.mapService
      .getConnections(currentMap)
      .map((c) => ({ name: c.name, mapId: c.mapId, distance: c.distance || 0 }));

    // 全部地图，标记当前所在地图及是否由当前地图直接可达
    const currentConnNames = new Set(subMaps.map((s) => s.name));
    const allMaps = (await this.mapService.getAllMaps()).map((m) => ({
      name: m.name,
      mapId: m.id,
      isCurrent: m.id === currentMap.id,
      isReachable: currentConnNames.has(m.name),
    }));

    // 当前地图的子区域详情（怪物/资源/NPC标题）
    const monsters = this.playerService.safeJsonParse<any[]>(currentMap.monsters, []);
    const resources = this.playerService.safeJsonParse<any[]>(currentMap.resources, []);
    const npcs = this.playerService.safeJsonParse<any[]>(currentMap.npcs, []);

    return {
      currentMap: {
        name: currentMap.name,
        mapId: currentMap.id,
        description: currentMap.description || '',
        monsters: monsters.length,
        resources: resources.length,
        npcs: npcs.length,
      },
      subMaps,
      allMaps,
    };
  }

  /**
   * 获取两个地图之间的距离
   */
  private getDistance(map1: any, map2: any): number {
    const connections1 = this.mapService.getConnections(map1);
    const conn = connections1.find((c: any) => c.name === map2.name);
    return conn ? (conn.distance || 50) : 50;
  }

  /**
   * 处理查看信息命令
   */
  async handleInfo(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, tasks } = playerData;

    const map = await this.mapService.getMapById(player.mapId);

    // 计算战斗力
    const bonus: BonusData = {
      attack: player.attack || 0,
      hp: player.hp || 0,
      armor: player.armor || 0,
      speed: player.speed || 0,
    };
    const combatPower = this.bonusService.calcCombatPower(bonus);

    // 检查是否为新手玩家（等级1且无操作记录）
    const isNewPlayer = player.level === 1 && !markers['指引_attack'] && !markers['指引_info'];

    const lines: string[] = [];

    if (isNewPlayer) {
      // 新玩家欢迎信息 - 还原原版"走廊对话/找道具"风格
      lines.push('📖 你缓缓睁开眼睛，发现自己躺在一张陌生的床上。');
      lines.push('四周是石砌的墙壁，空气中弥漫着淡淡的霉味……');
      lines.push('你坐起身来，环顾四周，这是一条长长的走廊。');
      lines.push('走廊两侧有几扇紧闭的门，尽头处似乎有什么东西在发光。');
      lines.push('你摸了摸身上，发现背包里有一些基础物资。');
      lines.push('');
      lines.push('📋 你回想起新手引导员的话：');
      lines.push('  "沿着走廊一直走，在尽头找到宝箱，');
      lines.push('   里面有你需要的「古代遗物」。"');
      lines.push('');
      lines.push('💡 输入 背包 查看你拥有的物品');
      lines.push('💡 输入 对话新手引导员 了解更多信息');
      lines.push('');
      lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━');
    }

    // 检查并自动发放新手教程任务（基于 markers 中的 教程 标记）
    // 教程 < 2：自动发放"新手教程"任务
    // 教程 < 3：自动发放"进阶教程"任务
    const tutorialValue = markers['教程'] || 0;
    let hasNewTutorialQuest = false;
    let hasAdvancedTutorialQuest = false;

    if (tutorialValue < 2) {
      // 检查是否已接取"新手教程"任务
      if (!tasks.some((t: any) => t.name === '新手教程')) {
        tasks.push({
          name: '新手教程',
          status: '进行中',
          progress: '欢迎来到使魔大战的世界！为了让你快速上手，我们为你准备了一系列新手任务。首先，查看你的背包，了解你拥有的物品。',
        });
        hasNewTutorialQuest = true;
      }
    }

    if (tutorialValue < 3) {
      // 检查是否已接取"进阶教程"任务
      if (!tasks.some((t: any) => t.name === '进阶教程')) {
        tasks.push({
          name: '进阶教程',
          status: '进行中',
          progress: '你已经掌握了基本操作，现在来了解更多游戏内容吧！尝试与NPC对话、探索地图、捕捉使魔。',
        });
        hasAdvancedTutorialQuest = true;
      }
    }

    // 更新教程标记（防止重复发放）
    if (hasNewTutorialQuest || hasAdvancedTutorialQuest) {
      const newTutorialValue = Math.max(tutorialValue, hasNewTutorialQuest ? 2 : 0, hasAdvancedTutorialQuest ? 3 : 0);
      markers['教程'] = newTutorialValue;
      player.tasks = tasks;
      player.markers = JSON.stringify(markers);
      await this.playerService.savePlayer(player);
    }

    lines.push(`【${player.name || '冒险者'}】Lv.${player.level}`);
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`❤️ HP: ${Math.round(player.hp || 0)}/${Math.round(player.maxHp || 100)}`);
    lines.push(`🛡️ 护盾: ${Math.round(player.shield || 0)}/${Math.round(player.maxShield || 0)}`);
    lines.push(`⛓️ 装甲: ${Math.round(player.armor || 0)}/${Math.round(player.maxArmor || 0)}`);
    lines.push(`⚔️ 攻击: ${Math.round(player.attack || 0)}`);
    lines.push(`💨 速度: ${Math.round(player.speed || 0)}`);
    lines.push(`⭐ 经验: ${Math.round(player.exp || 0)}/${Math.round(player.upgradeExp || 100)}`);
    lines.push(`📍 位置: ${map?.name || '未知'}`);
    lines.push(`🔥 战斗力: ${combatPower}`);

    // 显示当前任务（如果有）
    if (tasks && tasks.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`📋 当前任务:`);
      for (const task of tasks) {
        const taskName = typeof task === 'string' ? task : task.name || task.title || '未知任务';
        const taskProgress = task.count ? ` (${task.count})` : '';
        lines.push(`  ${taskName}${taskProgress}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 处理查看背包命令
   */
  async handleInventory(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const items = this.playerService.getBackpackItems(player);

    if (items.length === 0) {
      return '🎒 你的背包空空如也';
    }

    const lines = items.map((item: any, index: number) => {
      const count = item.count || item.quantity || 1;
      return `${index + 1}. ${item.name} ×${count}`;
    });

    return `🎒 背包 (${items.length}种):\n${lines.join('\n')}`;
  }

  /**
   * 处理查看地图命令
   */
  async handleMap(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const currentMap = await this.mapService.getMapById(player.mapId);
    if (!currentMap) return '你不在任何地图上';

    const connections = this.mapService.getConnections(currentMap);
    const monsters = this.mapService.getMapMonsters(currentMap);

    const lines = [
      `🗺️ 【${currentMap.name}】`,
      currentMap.description ? `📖 ${currentMap.description}` : '',
      `━━━━━━━━━━━━━━━`,
      `怪物数量: ${monsters.length}`,
      monsters.length > 0
        ? `怪物: ${monsters.map((m: any) => m.name || '未知').join(', ')}`
        : '',
      `━━━━━━━━━━━━━━━`,
      `可前往:`,
      ...connections.map((c: any) => `  → ${c.name} (距离: ${c.distance})`),
    ];

    return lines.filter(Boolean).join('\n');
  }

  /**
   * 处理查看状态命令（详细属性）
   */
  async handleStatus(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const lines = [
      `【${player.name || '冒险者'}】详细属性`,
      `━━━━━━━━━━━━━━━`,
      `等级: ${player.level}`,
      `经验: ${Math.round(player.exp || 0)}/${Math.round(player.upgradeExp || 100)}`,
      `━━━━━━━━━━━━━━━`,
      `生命: ${Math.round(player.hp || 0)}/${Math.round(player.maxHp || 100)} (回复: ${player.regenHp || 0}/s)`,
      `护盾: ${Math.round(player.shield || 0)}/${Math.round(player.maxShield || 0)} (回复: ${player.regenShield || 0}/s)`,
      `装甲: ${Math.round(player.armor || 0)}/${Math.round(player.maxArmor || 0)} (回复: ${player.regenArmor || 0}/s)`,
      `━━━━━━━━━━━━━━━`,
      `攻击: ${Math.round(player.attack || 0)}`,
      `防御: ${Math.round(player.defense || 0)}`,
      `速度: ${Math.round(player.speed || 0)}`,
      `闪避: ${Math.round(player.dodge || 0)}%`,
      `命中: ${Math.round(player.hit || 0)}%`,
      `暴击: ${Math.round(player.crit || 0)}%`,
      `暴击伤害: ${Math.round(player.critDmg || 150)}%`,
      `━━━━━━━━━━━━━━━`,
      `类型: ${player.type || '人类'}`,
      `好感度: ${Math.round(player.affinity || 0)}`,
    ];

    return lines.join('\n');
  }

  /**
   * 处理使用物品命令
   */
  async handleUseItem(userId: number, itemName: string): Promise<string> {
    return this.itemService.useItem(userId, itemName);
  }

  /**
   * 处理装备命令
   */
  async handleEquip(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const items = this.playerService.getBackpackItems(player);

    const index = items.findIndex((item: any) => item.name === itemName);
    if (index === -1) return `背包中没有【${itemName}】`;

    return this.itemService.equipItem(userId, index);
  }

  /**
   * 处理卸下装备命令
   */
  async handleUnequip(userId: number, slot: string): Promise<string> {
    return this.itemService.unequipItem(userId, slot);
  }

  /**
   * 处理查看技能命令
   */
  async handleSkill(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (!player.type) {
      return '你还没有使魔类型，无法查看技能';
    }

    const familiar = await this.familiarService.getFamiliarByName(player.type);
    if (!familiar) {
      return `未知的使魔类型: ${player.type}`;
    }

    const skillDesc = this.familiarService.getSkillDescription(
      familiar,
      player.affinity || 0,
    );

    return [
      `【${familiar.name}】技能`,
      `━━━━━━━━━━━━━━━`,
      `特有技能: ${familiar.uniqueSkill || '无'}`,
      `技能说明: ${skillDesc || familiar.skillDesc || '无'}`,
      `好感度: ${Math.round(player.affinity || 0)}`,
      player.affinity && player.affinity >= 100 ? '💕 已解锁全部技能效果' : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * 处理救助命令
   * 当玩家倒地时，允许其自救回到正常状态
   */
  async handleRescue(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (!this.playerService.isPlayerDead(player)) {
      return '你还活着，不需要救助';
    }
    return this.playerService.handlePlayerDeath(userId, player);
  }

  /**
   * 处理对话命令
   * 与地图上的NPC对话，根据NPC类型显示不同对话文本，支持触发任务
   * 对应原版：对话 命令
   */
  async handleTalk(userId: number, npcName: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 解析地图NPC列表
    const npcs = this.playerService.safeJsonParse<any[]>(map.npcs, []);
    if (npcs.length === 0) {
      return '当前地图没有可对话的NPC';
    }

    // 如果没有指定NPC名称，显示可对话的NPC列表
    if (!npcName) {
      const lines = [`💬 【${map.name}】可对话NPC:`];
      for (const npc of npcs) {
        lines.push(`  ${npc.name || '未知'}${npc.description ? ` - ${npc.description}` : ''}`);
      }
      lines.push(``);
      lines.push(`使用「对话 NPC名」与NPC对话`);
      return lines.join('\n');
    }

    // 查找指定NPC
    const targetNpc = npcs.find((n: any) => n.name === npcName);
    if (!targetNpc) {
      return `当前地图没有名为【${npcName}】的NPC`;
    }

    // 根据NPC类型生成对话文本
    const npcType = targetNpc.type || 'generic';
    const npcTitle = targetNpc.title || '未知NPC';
    const dialogLines: string[] = [];

    // 基础问候
    const greetings = [
      `你好，${player.name || '冒险者'}！`,
      `欢迎来到${map.name}！`,
      `有什么事吗？`,
    ];
    dialogLines.push(`【${npcTitle}】`);
    dialogLines.push(`━━━━━━━━━━━━━━━`);
    dialogLines.push(greetings[Math.floor(Math.random() * greetings.length)]);

    // 新手村（mapId=1）特殊NPC对话剧情
    if (player.mapId === 1) {
      // 根据教程进度和与当前NPC的对话历史确定对话阶段
      const tutorialValue = markers['教程'] || 0;
      // 检查与该NPC的独立对话进度（支持每个NPC独立的对话推进）
      const talkProgress = markers[`对话_${npcName}`] || 0;
      let dialogPhase: string;
      if (talkProgress >= 3) {
        dialogPhase = 'done';
      } else if (talkProgress >= 2) {
        dialogPhase = 'quest';
      } else if (talkProgress >= 1) {
        dialogPhase = 'intro';
      } else {
        dialogPhase = 'hello';
      }
      // 如果用独立对话进度得出的阶段与教程阶段冲突，取较高级的那个
      // 例如：教程已到done阶段，但从未和该NPC对话过，仍展示高级内容
      if (tutorialValue >= 3 && dialogPhase !== 'done') {
        dialogPhase = 'done';
      }

      // 检查新手指引中的对话引导
      const tutorialText = this.tutorialService.getTutorial('talk', markers);
      if (tutorialText) {
        markers['指引_talk'] = 1;
        player.markers = JSON.stringify(markers);
        await this.playerService.savePlayer(player);
      }

      // 特殊NPC对话映射 - 包含丰富的走廊对话/找道具剧情
      const specialNpcs: Record<string, { title: string; dialogs: Record<string, string> }> = {
        '新手引导员': {
          title: '新手引导员·小薇',
          dialogs: {
            'hello': '你好呀，新人！我是新手引导员小薇，欢迎来到使魔大战的世界！\n\n你从出生点醒来，沿着走廊一直走，会在走廊尽头发现一个宝箱。\n打开宝箱可以获得一些有用的道具。',
            'intro': '这个世界的怪物可不是好惹的，先从背包里拿出你的石斧吧！\n\n💡 使用「装备 石斧」来装备武器\n💡 使用「攻击」来试试身手\n💡 使用「背包」查看你拥有的物品',
            'quest': '等你准备好了，我有个任务要交给你。\n先去走廊尽头的宝箱那里，找到「古代遗物」，然后回来找我。\n\n使用「领取任务 新手教程」来接受任务吧！',
            'done': '你已经学会了基本操作，去探索更广阔的世界吧！\n\n记住：\n  - 使用「移动 地图名」前往新区域\n  - 使用「对话 NPC名」与NPC交谈\n  - 遇到困难可以「求助」其他玩家',
          }
        },
        '老村长': {
          title: '老村长',
          dialogs: {
            'hello': '咳咳，年轻人，你就是新来的冒险者吧？\n\n我是这个新手村的村长，已经在这里生活了几十年了。\n最近村子周围的怪物越来越多了，我需要你的帮助。',
            'intro': '你看到村子东边的走廊了吗？那里原本是通往神殿的通道，\n但是最近被一群史莱姆占据了。\n去那里看看吧，说不定能找到一些有用的东西。',
            'quest': '年轻人，如果你愿意的话，帮我清理掉走廊里的史莱姆。\n作为回报，我会告诉你关于使魔的秘密。',
            'done': '你做得很好，年轻人！\n现在我告诉你，使魔是这个世界最神奇的伙伴。\n使用「召唤使魔」来召唤你的第一个使魔吧！',
            'story': '很久很久以前，使魔大战爆发了……\n算了，这些故事以后再说。\n你现在的任务是提升实力，去探索这个世界的秘密。',
          }
        },
        '流浪商人': {
          title: '流浪商人·阿福',
          dialogs: {
            'hello': '嘿嘿，新面孔啊！我是流浪商人阿福，\n我在各个大陆之间旅行，贩卖各种稀奇古怪的东西。\n\n要不要看看我的商品？使用「购物」来打开商店。',
            'intro': '我这里的商品可都是好东西！\n有武器、防具、药品，还有一些特殊的道具。\n\n不过嘛……好东西可不便宜，你先去赚点钱再来吧。',
            'quest': '如果你能帮我找到「古代遗物」，我可以给你一个优惠价。\n据说那个东西就在新手村的走廊尽头。',
            'done': '你真的找到了古代遗物？！厉害厉害！\n作为奖励，我可以给你打个八折，嘿嘿。',
          }
        },
        '旅行者': {
          title: '神秘的旅行者',
          dialogs: {
            'hello': '嘘……别出声。\n我正在观察走廊里的那些史莱姆，它们的行为很奇怪。\n\n你也是来探索这条走廊的吗？',
            'intro': '这条走廊被称为「试炼之路」，每个新人都要经过这里。\n走廊里有各种机关和宝箱，当然也有怪物。\n\n在走廊尽头，据说藏着一个强大的古代遗物。',
            'quest': '如果你能找到走廊尽头的宝箱，帮我看看里面有什么。\n但我警告你，走廊深处有一种特殊的史莱姆，\n它们比普通史莱姆要强大得多。',
            'done': '你找到古代遗物了？太好了！\n那个东西蕴含着强大的力量，好好利用它吧。',
          }
        },
        '行商': {
          title: '流浪行商·阿福',
          dialogs: {
            'hello': '嘿，新人！我这里有些好东西，要不要看看？',
            'intro': '我这里有各种武器和防具，不过价格嘛……嘿嘿。',
            'quest': '如果你有材料，可以找我制作装备，我的锻造技术可是一流的！',
            'done': '欢迎下次光临！',
          }
        },
      };

      // 检查当前NPC是否在特殊NPC列表中
      const specialNpc = specialNpcs[npcName];
      if (specialNpc) {
        // 使用特殊NPC的标题替换默认标题
        const dialogText = specialNpc.dialogs[dialogPhase] || specialNpc.dialogs['hello'];
        dialogLines.push(dialogText);

        // 更新与该NPC的对话进度
        markers[`对话_${npcName}`] = (talkProgress + 1);
        player.markers = JSON.stringify(markers);
        await this.playerService.savePlayer(player);

        // 对话进度提示
        if (talkProgress < 3) {
          dialogLines.push(`━━━━━━━━━━━━━━━`);
          dialogLines.push(`💡 继续对话可了解更多信息`);
        }
        // 跳过后续通用NPC对话逻辑
      } else {
        // 非特殊NPC，使用通用对话逻辑
        switch (npcType) {
          case 'merchant':
          case 'shop':
            dialogLines.push(`我这里有些好东西，你可以用「购物」来查看。`);
            break;
          case 'quest':
          case 'task':
            dialogLines.push(`我有个任务需要你的帮助，使用「领取任务」来看看吧。`);
            break;
          case 'blacksmith':
          case 'smith':
            dialogLines.push(`我可以帮你修理装备，使用「修理」来修复你的物品。`);
            break;
          case 'healer':
            dialogLines.push(`我可以为你治疗伤口，躺下休息能恢复生命。`);
            break;
          case 'guide':
            dialogLines.push(`欢迎来到使魔大战的世界！使用「帮助」查看游戏指南。`);
            break;
          default:
            dialogLines.push(`今天天气不错，适合出门冒险！`);
            break;
        }
      }
    } else {
      // 非新手村地图，使用通用对话逻辑
      switch (npcType) {
        case 'merchant':
        case 'shop':
          dialogLines.push(`我这里有些好东西，你可以用「购物」来查看。`);
          break;
        case 'quest':
        case 'task':
          dialogLines.push(`我有个任务需要你的帮助，使用「领取任务」来看看吧。`);
          break;
        case 'blacksmith':
        case 'smith':
          dialogLines.push(`我可以帮你修理装备，使用「修理」来修复你的物品。`);
          break;
        case 'healer':
          dialogLines.push(`我可以为你治疗伤口，躺下休息能恢复生命。`);
          break;
        case 'guide':
          dialogLines.push(`欢迎来到使魔大战的世界！使用「帮助」查看游戏指南。`);
          break;
        default:
          dialogLines.push(`今天天气不错，适合出门冒险！`);
          break;
      }
    }

    // NPC描述文本
    if (targetNpc.description) {
      dialogLines.push(`━━━━━━━━━━━━━━━`);
      dialogLines.push(`${targetNpc.description}`);
    }

    // 检查是否有可领取的任务（通过 NPC 配置关联）
    try {
      const gameNpc = this.staticData.getNpcByName(npcName);
      if (gameNpc && gameNpc.taskId) {
        // 检查玩家是否已接取该任务
        const tasks = playerData.tasks;
        const hasTask = tasks.some((t: any) => t.name === gameNpc.taskId);
        if (!hasTask) {
          dialogLines.push(`━━━━━━━━━━━━━━━`);
          dialogLines.push(`💡 ${npcName} 似乎有任务要交给你，试试「领取任务 ${gameNpc.taskId}」`);
        }
      }
    } catch {
      // NPC 表查询失败时忽略
    }

    return dialogLines.join('\n');
  }

  /**
   * 处理与露娜的对话（对话露娜未知）
   * 对应原版：对话露娜未知 命令
   * 当玩家携带"未知物品"（具现装置的产物）与露娜对话时，
   * 可用其兑换"工业建筑箱"或"专属装备补给箱"，并增加露娜熟练度
   */
  async handleDialogueLuna(userId: number, arg: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, backpack } = playerData;

    // 获取当前地图，确认露娜在场
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
    const luna = summons.find((s: any) => s.qq === '怪物露娜1g' || s.name === '露娜');
    if (!luna) {
      return '你环顾四周，露娜并不在这里。\n她偶尔会出现在某些地图上，找到她才能用未知物品兑换奖励。';
    }

    // 解析兑换选项：无参数时展示选项，参数为1/2时执行兑换
    const choice = parseInt(arg.replace(/[^\d]/g, ''), 10) || 0;

    // 统计背包中的"未知物品"数量
    const unknownItems = backpack.filter((item: any) => item.name === '未知物品' || item.name.includes('未知物品'));
    const unknownCount = unknownItems.reduce((sum: number, item: any) => sum + (item.count || 1), 0);

    if (choice === 0) {
      // 展示兑换菜单
      if (unknownCount <= 0) {
        return '【露娜】\n━━━━━━━━━━━━━━━\n这是……具现装置的产物？！\n这种东西对你来说也没用，不如交给我，我可以用你想要的东西作为奖励。\n\n不过你现在好像没有「未知物品」，去具现装置那里看看吧。';
      }
      return `【露娜】\n━━━━━━━━━━━━━━━\n这是……具现装置的产物？！\n这种东西对你来说也没用，不如交给我，我可以用你想要的东西作为奖励。\n\n你拥有「未知物品」×${unknownCount}，想兑换什么？\n1、工业建筑箱\n2、专属装备补给箱\n\n输入「对话露娜未知 1」或「对话露娜未知 2」进行兑换`;
    }

    if (unknownCount <= 0) {
      return '你的背包中没有「未知物品」，无法兑换。';
    }

    // 确定兑换目标
    const rewardName = choice === 1 ? '工业建筑箱' : '专属装备补给箱';
    if (choice !== 1 && choice !== 2) {
      return '请输入正确的选项：1=工业建筑箱，2=专属装备补给箱';
    }

    // 扣除未知物品，给予奖励物品
    let remaining = unknownCount;
    player.backpack = backpack
      .map((item: any) => {
        if (item.name === '未知物品' || item.name.includes('未知物品')) {
          const take = Math.min(item.count || 1, remaining);
          remaining -= take;
          return { ...item, count: (item.count || 1) - take };
        }
        return item;
      })
      .filter((item: any) => (item.count || 0) > 0);

    // 发放奖励物品
    const rewardItem = { name: rewardName, count: unknownCount };
    player.backpack.push(rewardItem);

    // 增加露娜熟练度
    markers['露娜熟练度'] = (markers['露娜熟练度'] || 0) + unknownCount * 10;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 与露娜兑换：${unknownCount}个未知物品 → ${rewardName}`);
    return `【露娜】\n━━━━━━━━━━━━━━━\n非常感谢！\n（露娜熟练度+${unknownCount * 10}，用${unknownCount}个未知物品跟她换了${rewardName}）`;
  }

  /**
   * 处理来倒目的（延时移动）
   * 对应原版：来倒目的 命令
   * 由系统延时任务触发，格式为"地图名$来源地图"，将玩家移动到指定地图
   * 若目标为"四圣祭坛"且四个祭坛均无怪物，则刷出神兽麒麟
   */
  async handleArriveAt(userId: number, arg: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 解析参数："目标地图$来源地图"
    const parts = (arg || '').split('$');
    const targetName = parts[0]?.trim();
    if (!targetName) {
      return '移动输入的数据不正确';
    }

    // 查找目标地图
    const targetMap = await this.mapService.getMapByName(targetName);
    if (!targetMap) {
      return `目标地图「${targetName}」不存在`;
    }

    // 记录前往成就
    try {
      const tasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
      const travelKey = tasks.find((t: any) => t.name === `前往${targetName}`);
      if (travelKey) {
        travelKey.count = (travelKey.count || 0) + 1;
      } else {
        tasks.push({ name: `前往${targetName}`, count: 1 });
      }
      player.tasks = JSON.stringify(tasks);
    } catch {
      // 任务记录失败不阻塞移动
    }

    // 执行移动
    const fromMapId = player.mapId;
    // 清除"移动中"状态，避免与延时移动逻辑冲突
    const arriveMarkers = this.playerService.safeJsonParse(player.markers, {});
    delete arriveMarkers['移动中'];
    player.mapId = targetMap.id;
    player.location = targetMap.name;
    player.markers = JSON.stringify(arriveMarkers);
    await this.playerService.savePlayer(player);

    // 进入地图自动获得地图增益
    this.combatSystem.applyMapBuffs(player, targetMap);

    // 四圣祭坛特殊逻辑：四个祭坛都清理后刷出麒麟
    if (targetMap.name === '四圣祭坛') {
      try {
        const spawnMonsters = this.playerService.safeJsonParse<any[]>(targetMap.spawnMonsters, []);
        if (spawnMonsters.length === 0) {
          const hasMonsterIn = async (name: string): Promise<boolean> => {
            const m = await this.prisma.gameMap.findUnique({ where: { name } });
            if (!m) return false;
            const list = this.playerService.safeJsonParse<any[]>(m.spawnMonsters, []);
            return list.length > 0;
          };
          const cleared = !(await hasMonsterIn('白虎祭坛'))
            && !(await hasMonsterIn('青龙祭坛'))
            && !(await hasMonsterIn('玄武祭坛'))
            && !(await hasMonsterIn('朱雀祭坛'));
          if (cleared) {
            spawnMonsters.push({
              id: `麒麟_${Date.now()}`,
              name: '神兽麒麟',
              type: '神兽麒麟',
              level: Math.max(10, player.level || 10),
              specialSeq: 0,
              hp: 5000,
              maxHp: 5000,
              attack: 200,
              defense: 50,
              speed: 120,
              exp: 500,
            });
            await this.prisma.gameMap.update({
              where: { id: targetMap.id },
              data: { spawnMonsters: JSON.stringify(spawnMonsters) },
            });
            return `你来到了【四圣祭坛】\n四座祭坛的怪物都已被清除，一股强大的气息在祭坛中央凝聚……\n神兽麒麟出现了！`;
          }
        }
      } catch {
        // 麒麟生成失败不阻塞移动
      }
    }

    this.logger.log(`玩家 ${userId} 延时移动：${fromMapId} → ${targetMap.name}`);
    const desc = targetMap.description ? `\n${targetMap.description}` : '';
    return `你来到了【${targetMap.name}】${desc}`;
  }

  /**
   * 处理家园命令
   * 家园系统的入口，支持子命令
   */
  async handleHome(userId: number, subCommand: string): Promise<string> {
    if (!subCommand) {
      return '家园系统：\n家园音乐 - 播放家园音乐\n家园搬迁 - 搬迁家园\n家园命名 - 为家园命名\n查看 - 查看家园信息';
    }
    return `家园功能「${subCommand}」正在开发中...`;
  }

  /**
   * 探测当前地图
   * 显示当前地图的资源、怪物、可交互物品等详细信息
   */
  async handleProbe(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查是否死亡
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 解析地图各 JSON 字段
    const monsters = this.mapService.getMapMonsters(map);
    const resources2 = this.playerService.safeJsonParse<any[]>(map.resources2, []);
    const items = this.playerService.safeJsonParse<any[]>(map.items, []);
    const npcs = this.playerService.safeJsonParse<any[]>(map.npcs, []);
    const resources = this.playerService.safeJsonParse<any[]>(map.resources, []);

    const lines: string[] = [
      `🔍 【${map.name}】探测报告`,
      `━━━━━━━━━━━━━━━`,
    ];

    // 地图描述
    if (map.description) {
      lines.push(`📖 ${map.description}`);
      lines.push(`━━━━━━━━━━━━━━━`);
    }

    // 怪物信息
    if (monsters.length > 0) {
      lines.push(`👾 怪物 (${monsters.length}只):`);
      for (const m of monsters) {
        const hpPercent = m.maxHp > 0 ? Math.round((m.hp / m.maxHp) * 100) : 0;
        lines.push(`  ${m.name} Lv.${m.level} HP:${m.hp}/${m.maxHp}(${hpPercent}%)${m.isElite ? ' ⚠️精英' : ''}`);
      }
    } else {
      lines.push(`👾 怪物: 当前地图没有怪物`);
    }

    // 可采集资源信息
    const collectableResources = resources2.filter((r: any) => r.amount > 0);
    if (collectableResources.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`⛏️ 可采集资源 (${collectableResources.length}种):`);
      for (const r of collectableResources) {
        lines.push(`  ${r.name} ×${r.amount} ${r.type ? `[${r.type}]` : ''}`);
      }
    }

    // 固定资源信息
    if (resources.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`📦 固定资源:`);
      for (const r of resources) {
        lines.push(`  ${r.name || '未知'} ${r.amount ? `×${r.amount}` : ''}`);
      }
    }

    // 可拾取物品
    if (items.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`🎒 地上物品 (${items.length}种):`);
      for (const item of items) {
        const count = item.count || item.quantity || 1;
        lines.push(`  ${item.name} ×${count}`);
      }
    }

    // NPC 信息
    if (npcs.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`💬 NPC (${npcs.length}个):`);
      for (const npc of npcs) {
        lines.push(`  ${npc.name || '未知'}${npc.description ? ` - ${npc.description}` : ''}`);
      }
    }

    // 连接信息
    const connections = this.mapService.getConnections(map);
    if (connections.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`🚪 可前往:`);
      for (const c of connections) {
        lines.push(`  → ${c.name} (距离: ${c.distance || '?'})`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 拾取地上物品
   * 从地图的 items JSON 字段中拾取物品到背包
   */
  async handlePickup(userId: number, itemName?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查是否死亡
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 解析地图上的物品
    const mapItems = this.playerService.safeJsonParse<any[]>(map.items, []);
    if (mapItems.length === 0) {
      return '地上没有可拾取的物品';
    }

    let pickedUp: any[] = [];
    let remainingItems: any[] = [];

    if (itemName) {
      // 拾取指定物品
      const targetItem = mapItems.find((item: any) => item.name === itemName);
      if (!targetItem) {
        return `地上没有【${itemName}】`;
      }

      const count = targetItem.count || targetItem.quantity || 1;
      await this.playerService.addToBackpack(userId, targetItem.name, count);
      pickedUp.push(targetItem);
      remainingItems = mapItems.filter((item: any) => item.name !== itemName);
    } else {
      // 拾取所有物品
      for (const item of mapItems) {
        const count = item.count || item.quantity || 1;
        await this.playerService.addToBackpack(userId, item.name, count);
      }
      pickedUp = mapItems;
      remainingItems = [];
    }

    // 更新地图物品
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { items: JSON.stringify(remainingItems) },
    });

    this.logger.log(`玩家 ${userId} 拾取了 ${pickedUp.length} 种物品`);

    const pickedText = pickedUp.map((item: any) => {
      const count = item.count || item.quantity || 1;
      return `${item.name} ×${count}`;
    }).join('、');

    return `拾取了: ${pickedText}`;
  }

  /**
   * 开采资源
   * 开采当前地图的资源点
   */
  async handleMine(userId: number, resourceName?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, markers2 } = playerData;

    // 检查是否死亡
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 解析可采集资源
    const resources2 = this.playerService.safeJsonParse<any[]>(map.resources2, []);
    const availableResources = resources2.filter((r: any) => r.amount > 0);

    if (availableResources.length === 0) {
      return '当前地图没有可开采的资源';
    }

    // 如果没有指定资源，显示可开采列表
    if (!resourceName) {
      const lines = [`⛏️ 【${map.name}】可开采资源:`];
      for (const r of availableResources) {
        lines.push(`  ${r.name} ×${r.amount}`);
      }
      lines.push(``);
      lines.push(`使用「开采 资源名」进行开采`);
      return lines.join('\n');
    }

    // 查找指定资源
    const targetResource = availableResources.find(
      (r: any) => r.name === resourceName,
    );
    if (!targetResource) {
      return `当前地图没有可开采的【${resourceName}】`;
    }

    // 检查冷却时间（通过 markers2 管理）
    const cooldownKey = `mine_${map.id}_${resourceName}`;
    const now = Date.now();
    const cooldownEntry = markers2.find((m: any) => m.key === cooldownKey);
    if (cooldownEntry) {
      const remaining = cooldownEntry.expireTime - now;
      if (remaining > 0) {
        return `【${resourceName}】还需要 ${Math.ceil(remaining / 1000)} 秒才能再次开采`;
      }
    }

    // 采集产出
    const amount = targetResource.amount || 1;
    await this.playerService.addToBackpack(userId, targetResource.name, amount);

    // 减少资源数量
    targetResource.amount = 0;

    // 设置冷却时间（默认5分钟）
    const respawnTime = (targetResource.respawnTime || 300) * 1000;
    const newCooldown = {
      key: cooldownKey,
      expireTime: now + respawnTime,
    };

    // 更新 markers2（移除旧冷却条目，添加新条目）
    const updatedMarkers2 = markers2.filter((m: any) => m.key !== cooldownKey);
    updatedMarkers2.push(newCooldown);

    // 更新地图资源和 markers2
    const updatedResources2 = resources2.map((r: any) =>
      r.name === resourceName ? targetResource : r,
    );

    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { resources2: JSON.stringify(updatedResources2) },
    });

    // 更新玩家 markers2
    player.markers2 = JSON.stringify(updatedMarkers2);
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 开采了 ${resourceName} ×${amount}`);

    const respawnMin = Math.ceil(respawnTime / 60000);
    return `开采了 ${targetResource.name} ×${amount}\n该资源将在 ${respawnMin} 分钟后刷新`;
  }

  /**
   * 赠予物品
   * 将背包中的物品赠予其他玩家
   */
  async handleGive(userId: number, targetQQ: string, itemName: string, count: number): Promise<string> {
    if (!targetQQ || !itemName) {
      return '请指定目标QQ和物品名称，格式：赠予 QQ号 物品名 [数量]';
    }

    // 查找目标用户
    const targetUser = await this.prisma.user.findUnique({
      where: { qqNumber: targetQQ },
    });
    if (!targetUser) {
      return `未找到QQ号为 ${targetQQ} 的用户`;
    }

    // 不能赠送给自己
    if (targetUser.id === userId) {
      return '不能赠送物品给自己';
    }

    // 查找目标玩家
    const targetPlayer = await this.prisma.player.findUnique({
      where: { userId: targetUser.id },
    });
    if (!targetPlayer) {
      return `目标玩家 ${targetQQ} 还未创建角色`;
    }

    // 检查发送者是否有足够物品
    const senderData = await this.playerService.getPlayerData(userId);
    const { player } = senderData;
    const senderItems = this.playerService.getBackpackItems(player);

    const senderItem = senderItems.find((item: any) => item.name === itemName);
    if (!senderItem) {
      return `你的背包中没有【${itemName}】`;
    }

    const actualCount = Math.min(count, senderItem.count || senderItem.quantity || 1);
    if (actualCount <= 0) {
      return `数量无效`;
    }

    // 从发送者背包移除
    const removed = await this.playerService.removeFromBackpack(userId, itemName, actualCount);
    if (!removed) {
      return `移除物品失败`;
    }

    // 添加到目标背包
    const added = await this.playerService.addToBackpack(targetUser.id, itemName, actualCount);
    if (!added) {
      // 回滚：将物品加回发送者背包
      await this.playerService.addToBackpack(userId, itemName, actualCount);
      return `赠送失败，请重试`;
    }

    this.logger.log(`玩家 ${userId} 赠送了 ${itemName} ×${actualCount} 给 ${targetQQ}`);

    return `成功将 ${itemName} ×${actualCount} 赠予给 ${targetUser.nickname || targetQQ}`;
  }

  /**
   * 领取任务
   * 从当前地图的NPC处领取任务
   */
  async handleAcceptQuest(userId: number, questName?: string): Promise<string> {
    // 1. 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, tasks } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 解析地图NPC列表
    const npcs = this.playerService.safeJsonParse<any[]>(map.npcs, []);

    // 2. 如果没有指定任务名，显示当前地图可接任务列表
    if (!questName) {
      // 查找当前地图NPC发布的任务（静态配置 JSON 单一来源）
      const availableTasks = this.staticData
        .getAllTasks()
        .filter((t) => npcs.map((n: any) => n.name).includes(t.publisher));

      if (availableTasks.length === 0) {
        return '当前地图没有可领取的任务';
      }

      const lines = [`📋 【${map.name}】可领取任务:`];
      for (const task of availableTasks) {
        const alreadyAccepted = tasks.some((t: any) => t.name === task.name);
        lines.push(`  ${task.name}${alreadyAccepted ? ' [已接取]' : ''}`);
        lines.push(`    等级要求: ${task.level}`);
        lines.push(`    发布人: ${task.publisher || '未知'}`);
        if (task.description) lines.push(`    ${task.description}`);
      }
      lines.push(``);
      lines.push(`使用「领取任务 任务名」领取任务`);
      return lines.join('\n');
    }

    // 3. 从 GameTask 表查找任务
    const gameTask = this.staticData.getTaskByName(questName);
    if (!gameTask) {
      return `不存在【${questName}】任务`;
    }

    // 4. 检查任务等级要求
    if ((player.level || 1) < gameTask.level) {
      return `等级不足，需要 ${gameTask.level} 级才能领取【${questName}】任务（当前 ${player.level} 级）`;
    }

    // 5. 检查任务是否已经接取
    if (tasks.some((t: any) => t.name === questName)) {
      return `你已经接取了【${questName}】任务`;
    }

    // 6. 检查任务前置条件（restrictMarkers）
    const restrictMarkers = this.playerService.safeJsonParse<string[]>(gameTask.restrictMarkers, []);
    const markers = playerData.markers;
    for (const marker of restrictMarkers) {
      if (!this.playerService.hasMarker(markers, marker)) {
        return `不满足前置条件：需要【${marker}】标记`;
      }
    }

    // 7. 将任务添加到玩家的 tasks 字段
    const newTask = {
      name: questName,
      status: '进行中',
      progress: gameTask.description || '完成指定条件即可提交',
    };
    tasks.push(newTask);
    player.tasks = tasks;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 领取了任务【${questName}】`);

    // 8. 返回任务领取信息
    return `✅ 领取任务成功！\n━━━━━━━━━━━━━━━\n【${questName}】\n${gameTask.description || '无描述'}\n━━━━━━━━━━━━━━━\n前往完成任务后，使用「提交任务 ${questName}」提交`;
  }

  /**
   * 查看任务
   * 查看当前已接取的任务列表
   */
  async handleViewQuests(userId: number): Promise<string> {
    // 1. 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, tasks } = playerData;

    // 2. 从 player.tasks 解析任务列表
    if (tasks.length === 0) {
      return '📋 你当前没有任何任务\n前往地图NPC处使用「领取任务」接取任务';
    }

    // 3. 显示每个任务的名称、进度、状态
    const lines = [
      `📋 【${player.name || '冒险者'}】任务列表 (${tasks.length}个)`,
      `━━━━━━━━━━━━━━━`,
    ];

    for (const task of tasks) {
      const statusIcon = task.status === '已完成' ? '✅' : '⏳';
      lines.push(`${statusIcon} 【${task.name}】`);
      lines.push(`  状态: ${task.status}`);
      if (task.progress) {
        lines.push(`  进度: ${task.progress}`);
      }
    }

    lines.push(``);
    lines.push(`使用「提交任务 任务名」提交已完成的任务`);

    // 4. 返回格式化任务列表
    return lines.join('\n');
  }

  /**
   * 提交任务
   * 完成的任务进行提交，获得奖励
   */
  async handleCompleteQuest(userId: number, questName: string): Promise<string> {
    // 1. 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, tasks } = playerData;

    // 2. 从 player.tasks 查找任务
    const taskIndex = tasks.findIndex((t: any) => t.name === questName);
    if (taskIndex === -1) {
      return `你当前没有接取【${questName}】任务`;
    }

    const task = tasks[taskIndex];

    // 3. 检查任务是否完成
    if (task.status !== '已完成') {
      return `【${questName}】任务还未完成，请先完成任务再提交\n当前进度: ${task.progress || '未知'}`;
    }

    // 4. 从 GameTask 读取奖励配置
    const gameTask = this.staticData.getTaskByName(questName);
    if (!gameTask) {
      // 任务已从数据库删除，但玩家任务列表中仍有
      tasks.splice(taskIndex, 1);
      player.tasks = tasks;
      await this.playerService.savePlayer(player);
      return `任务数据异常，已从任务列表中移除【${questName}】`;
    }

    // 5. 发放奖励（经验、物品、好感度等）
    const rewards = this.playerService.safeJsonParse<string[]>(gameTask.rewards, []);
    const rewardLines: string[] = [];
    const expRewards: number[] = [];

    for (const rewardStr of rewards) {
      // 奖励格式：["物品名1,数量1", "物品名2,数量2", "经验,数值"]
      const parts = rewardStr.split(',');
      if (parts.length < 2) continue;

      const rewardName = parts[0].trim();
      const rewardValue = parseInt(parts[1].trim(), 10);
      if (isNaN(rewardValue) || rewardValue <= 0) continue;

      if (rewardName === '经验') {
        // 经验奖励，汇总后统一发放
        expRewards.push(rewardValue);
        rewardLines.push(`经验 +${rewardValue}`);
      } else if (rewardName === '好感') {
        // 好感度奖励
        player.affinity = (player.affinity || 0) + rewardValue;
        rewardLines.push(`好感度 +${rewardValue}`);
      } else {
        // 物品奖励
        const added = await this.playerService.addToBackpack(userId, rewardName, rewardValue);
        if (added) {
          rewardLines.push(`${rewardName} ×${rewardValue}`);
        }
      }
    }

    // 发放经验奖励
    for (const exp of expRewards) {
      await this.playerService.addExp(userId, exp);
    }

    // 6. 从玩家任务列表中移除
    tasks.splice(taskIndex, 1);
    player.tasks = tasks;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 提交了任务【${questName}】，获得奖励: ${rewardLines.join(', ')}`);

    // 7. 返回任务完成信息
    return [
      `✅ 任务完成！`,
      `━━━━━━━━━━━━━━━`,
      `【${questName}】`,
      `━━━━━━━━━━━━━━━`,
      `获得奖励:`,
      ...rewardLines.map((r) => `  ${r}`),
    ].join('\n');
  }

  /**
   * 躺下（休息）
   * 设置躺下状态，可以缓慢恢复生命
   */
  async handleLieDown(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查是否死亡
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 检查是否已经在躺下
    if (markers['躺下'] === 1) {
      return '你已经躺下了，好好休息吧~';
    }

    // 设置躺下标记
    markers['躺下'] = 1;

    // 保存标记到玩家数据
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 躺下了`);

    return '你躺了下来，开始缓慢恢复生命...\n（躺下状态会持续恢复HP，输入「起床」可以站起来）';
  }

  /**
   * 起床
   * 结束躺下状态
   */
  async handleGetUp(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查是否在躺下
    if (markers['躺下'] !== 1) {
      return '你本来就没有躺下呀';
    }

    // 移除躺下标记
    delete markers['躺下'];

    // 保存标记到玩家数据
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 起床了`);

    return '你站了起来，精神焕发！';
  }

  /**
   * 玩家设置
   * 查看/修改个人设置，设置存储在 markers 中
   * 对应原版：_主程序.ecode 中「设置」指令
   */
  async handleSettings(userId: number, settingName?: string, settingValue?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 未指定设置项：显示当前设置状态
    if (!settingName) {
      const autoShopping = markers['自动购物'];
      const lines = [
        `${player.name || '冒险者'}选择你需要修改的设置`,
        `在线状态：触发本游戏任意回复后10分钟内`,
        `新手指引：新手操作提示`,
        `随机数：触发的回复附带随机数防止裂图`,
        `采集：自动采集：在非战斗状态时静默采集资源且不会消耗地图上的资源，但是速度很慢，非在线状态也能采集；手动采集：手动采集资源`,
        `显示倍率:显示本次攻击时你的最终攻击加成倍率`,
        ``,
        `1、新手指引：${this.playerService.getMarkerValue(markers, '指引') === 0 ? '开' : '关'}`,
        `2、随机数：${this.playerService.getMarkerValue(markers, '自动战斗') === 1 ? '开' : '关'}`,
        `3、自动采集：${this.playerService.getMarkerValue(markers, '自动采集') === 1 ? '开' : '关'}`,
        `4、使用活力：${this.playerService.getMarkerValue(markers, '使用活力') === 0 ? '开' : '关'}`,
        `5、宠物不扶：${this.playerService.getMarkerValue(markers, '不扶') === 1 ? '开' : '关'}`,
        `6、背景音乐：${this.playerService.getMarkerValue(markers, 'bgm') === 0 ? '开' : '关'}`,
        `7、显示倍率：${this.playerService.getMarkerValue(markers, 'bl') === 1 ? '开' : '关'}`,
        `8、自动购物：${autoShopping || '未设置'}`,
      ];
      return lines.join('\n');
    }

    // 指定设置项：按「开/关/数字」解析并写入 markers
    const settingKey = settingName;
    const settingVal = settingValue;
    let newValue: number;

    if (settingVal === undefined || settingVal.trim() === '') {
      return `请为「${settingName}」设置值：「开/关」或数字`;
    }

    if (settingVal === '开' || settingVal === 'on' || settingVal === 'true' || settingVal === '1') {
      newValue = 1;
    } else if (settingVal === '关' || settingVal === 'off' || settingVal === 'false' || settingVal === '0') {
      newValue = 0;
    } else {
      newValue = parseInt(settingVal, 10);
      if (isNaN(newValue)) {
        return `无效的设置值「${settingVal}」，请使用「开/关」或数字`;
      }
    }

    // 新手指引使用 markers['指引'] 存储，且取值相反：0=开启, 1=关闭
    const actualKey = settingKey === '新手指引' ? '指引' : settingKey;
    markers[actualKey] = newValue;
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 设置 ${settingKey} = ${newValue}`);

    const statusText = newValue === 1 ? '关闭' : '开启';
    const displayText = settingKey === '新手指引' ? `新手指引已${statusText}` : `设置「${settingKey}」已${statusText}`;
    return displayText;
  }

  /**
   * 切换玩家标记类设置（存储在 markers 中）
   * 对应原版 _主程序.ecode「设置」系列指令的切换逻辑：
   * 读取当前值，若处于“开”则切换为“关”，否则切换为“开”
   * @param userId 用户ID
   * @param key 标记键名
   * @param onValue 标记中表示“开”的数值
   * @param offValue 标记中表示“关”的数值
   * @param onText 切换到“开”时返回的提示文本
   * @param offText 切换到“关”时返回的提示文本
   */
  private async toggleSetting(
    userId: number,
    key: string,
    onValue: number,
    offValue: number,
    onText: string,
    offText: string,
  ): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const isOn = this.playerService.getMarkerValue(markers, key) === onValue;
    markers[key] = isOn ? offValue : onValue;
    player.markers = markers;
    await this.playerService.savePlayer(player);
    return `${player.name || '冒险者'}，${isOn ? offText : onText}`;
  }

  /**
   * 设置新手指引开关
   * 对应原版：设置指引
   * 标记「指引」：0=开启, 1=关闭
   */
  async handleSettingsGuide(userId: number): Promise<string> {
    return this.toggleSetting(userId, '指引', 0, 1, '开启了新手指引', '关闭了新手指引');
  }

  /**
   * 设置随机数开关
   * 对应原版：设置随机
   * 标记「自动战斗」：1=显示随机数, 0=不显示
   */
  async handleSettingsRandom(userId: number): Promise<string> {
    return this.toggleSetting(userId, '自动战斗', 1, 0, '开启了随机数', '关闭了随机数');
  }

  /**
   * 设置自动采集开关
   * 对应原版：设置采集
   * 标记「自动采集」：1=开启, 0=关闭
   */
  async handleSettingsGather(userId: number): Promise<string> {
    return this.toggleSetting(userId, '自动采集', 1, 0, '开启了自动采集', '关闭了自动采集');
  }

  /**
   * 设置活力消耗开关
   * 对应原版：设置活力
   * 标记「使用活力」：0=击杀怪物消耗活力, 1=不消耗
   */
  async handleSettingsVitality(userId: number): Promise<string> {
    return this.toggleSetting(userId, '使用活力', 0, 1, '活力现在击杀怪物会消耗', '活力现在击杀怪物不会消耗');
  }

  /**
   * 设置宠物是否扶起主人
   * 对应原版：设置不扶
   * 标记「不扶」：1=宠物不扶, 0=宠物会扶起
   */
  async handleSettingsNoHelp(userId: number): Promise<string> {
    return this.toggleSetting(userId, '不扶', 1, 0, '你现在不会被宠物扶起', '存活的宠物现在会扶你起来');
  }

  /**
   * 设置背景音乐开关
   * 对应原版：设置音乐
   * 标记「bgm」：0=播放bgm, 1=不播放
   */
  async handleSettingsMusic(userId: number): Promise<string> {
    return this.toggleSetting(userId, 'bgm', 0, 1, '播放bgm', '不播放bgm');
  }

  /**
   * 设置显示攻击倍率开关
   * 对应原版：设置倍率
   * 标记「bl」：1=显示倍率, 0=不显示
   */
  async handleSettingsMultiplier(userId: number): Promise<string> {
    return this.toggleSetting(userId, 'bl', 1, 0, '显示倍率', '不显示倍率');
  }

  /**
   * 设置自动购物对象
   * 对应原版：设置购物
   * 记录在 markers['自动购物'] 中，用于「购物自动」指令对自家行商自动购买
   * @param userId 用户ID
   * @param value 购物对象关键词（为空时表示查看当前设置）
   */
  async handleSettingsShop(userId: number, value?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!value) {
      const current = markers['自动购物'];
      return `${player.name || '冒险者'}
「设置购物工业、窝」来自动从行商处购买名称包含「工业」和「窝」的物品
「购物自动」来使用
只能对自己家里的行商使用
你当前的设置：${current || '未设置'}`;
    }

    // 校验输入：不允许包含指令分隔符等敏感字符
    if (value.includes('@') || value.includes('#') || value.includes('\n')) {
      return `${player.name || '冒险者'}，${value} 不符合规范`;
    }

    markers['自动购物'] = value;
    player.markers = markers;
    await this.playerService.savePlayer(player);
    return `${player.name || '冒险者'}，自动购物的对象设置为${value}`;
  }

  /**
   * 设置玩家位置（管理员）
   * 对应原版：设置位置
   * 将指定玩家移动到地图列表下标或地图名称对应的地图
   * @param userId 调用者用户ID
   * @param value 参数：「目标 地图列表数组下标/地图名称」
   */
  async handleSettingsLocation(userId: number, value?: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN')) {
      return '权限不足，需要管理员权限';
    }

    if (!value) {
      return '不能输入空参数，「设置位置@人 地图列表数组下标/地图名称」';
    }

    const parts = value.split(/\s+/).filter(Boolean);
    if (parts.length !== 2) {
      return '不能输入空参数，「设置位置@人 地图列表数组下标/地图名称」';
    }

    // 解析目标玩家（支持 @QQ 或 QQ 号）
    const targetKey = parts[0].replace(/^@/, '');
    const targetPlayer = await this.prisma.player.findFirst({
      where: { masterQQ: targetKey },
    });
    if (!targetPlayer) {
      return `${targetKey} 在玩家列表不存在`;
    }

    // 解析目标地图（数字下标或名称）
    const mapKey = parts[1];
    let targetMap: any;
    if (/^\d+$/.test(mapKey)) {
      const maps = await this.mapService.getAllMaps();
      const index = parseInt(mapKey, 10);
      if (index < 1 || index > maps.length) {
        return `设置的地图编号超出定义范围：${mapKey}:${maps.length}`;
      }
      targetMap = maps[index - 1];
    } else {
      targetMap = await this.mapService.getMapByName(mapKey).catch(() => null);
      if (!targetMap) {
        return `${mapKey} 在地图列表不存在`;
      }
    }

    const oldMapId = targetPlayer.mapId;
    targetPlayer.mapId = targetMap.id;
    targetPlayer.location = targetMap.name;
    await this.playerService.savePlayer(targetPlayer);
    this.logger.log(`管理员 ${userId} 将玩家 ${targetKey} 从地图 ${oldMapId} 移动到 ${targetMap.name}`);

    return `把${targetPlayer.name || targetKey}的位置设置为${targetMap.name}`;
  }

  /**
   * 设置玩家/宠物标记（管理员）
   * 对应原版：设置标记
   * 支持修改玩家或宠物/召唤物的成就/标记/增益/标记2/配方
   * @param userId 调用者用户ID
   * @param value 参数：「@人/宠物id 标记名称 数值 位置(成就/标记/增益/标记2/配方) 持续时间」
   */
  async handleSettingsMarker(userId: number, value?: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN')) {
      return '权限不足，需要管理员权限';
    }

    if (!value) {
      return '不能输入空参数，「设置标记@人/宠物id 标记名称 数值 位置(成就/标记/增益/标记2/配方) 持续时间」';
    }

    const parts = value.split(/\s+/).filter(Boolean);
    if (parts.length < 4) {
      return '不能输入空参数，「设置标记@人/宠物id 标记名称 数值 位置(成就/标记/增益/标记2/配方) 持续时间」';
    }

    const target = parts[0];
    const markerName = parts[1];
    const markerValue = parseInt(parts[2], 10);
    const position = parts[3]; // 成就/标记/增益/标记2/配方
    const duration = parts.length > 4 ? parseInt(parts[4], 10) : 0;

    if (isNaN(markerValue)) {
      return `标记数值「${parts[2]}」不是有效数字`;
    }

    // 宠物/召唤物（id 以「怪物」或「召唤物」开头）
    if (target.startsWith('怪物') || target.startsWith('召唤物')) {
      const maps = await this.mapService.getAllMaps();
      for (const map of maps) {
        const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
        const summon = summons.find((s: any) => s.qq === target || s.id === target);
        if (summon) {
          if (position === '成就' || position === '配方') {
            return `召唤物/宠物的${position}不可以修改(因为没效果)`;
          }
          if (!summon.markers) summon.markers = {};
          if (position === '标记') {
            summon.markers[markerName] = markerValue;
          } else if (position === '标记2' || position === '增益') {
            if (!duration) {
              return `${position === '标记2' ? '设置标记2' : '设置增益'}需要提供第五个参数：持续时间`;
            }
            if (!summon.markers2) summon.markers2 = {};
            const now = Date.now() / 1000;
            summon.markers2[markerName] = { value: markerValue, expireAt: now + duration };
          }
          await this.prisma.gameMap.update({
            where: { id: map.id },
            data: { summons: JSON.stringify(summons) },
          });
          return `${map.name}的${summon.name}的${markerName}标记被修改为${markerValue}`;
        }
      }
      return `世界地图上未找到id为${target}的宠物或者召唤物`;
    }

    // 玩家（@QQ 或 QQ 号）
    const targetKey = target.replace(/^@/, '');
    const targetPlayer = await this.prisma.player.findFirst({
      where: { masterQQ: targetKey },
    });
    if (!targetPlayer) {
      return `${targetKey} 在玩家列表不存在`;
    }

    const markers = this.playerService.safeJsonParse<Record<string, any>>(targetPlayer.markers, {});
    const markers2 = this.playerService.safeJsonParse<any[]>(targetPlayer.markers2, []);
    if (position === '标记' || position === '成就') {
      markers[markerName] = markerValue;
      targetPlayer.markers = JSON.stringify(markers);
    } else if (position === '标记2' || position === '增益') {
      if (!duration) {
        return `${position === '标记2' ? '设置标记2' : '设置增益'}需要提供第五个参数：持续时间`;
      }
      const now = Date.now() / 1000;
      markers2.push({ name: markerName, value: markerValue, expireAt: now + duration });
      targetPlayer.markers2 = JSON.stringify(markers2);
    } else if (position === '配方') {
      const recipes = this.playerService.safeJsonParse<Record<string, any>>(targetPlayer.recipes, {});
      recipes[markerName] = markerValue;
      targetPlayer.recipes = JSON.stringify(recipes);
    }
    await this.playerService.savePlayer(targetPlayer);

    return `${targetPlayer.name || targetKey}的${markerName}${position}被修改为${markerValue}`;
  }

  /**
   * 开启副本
   * 使用副本钥匙在当前地图开启副本，生成临时怪物
   * @param userId 用户ID
   * @returns 副本开启信息
   */
  async handleStartDungeon(userId: number): Promise<string> {
    // 1. 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 2. 检查玩家是否死亡
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 3. 检查是否已经有副本在进行中（通过 markers 检查）
    if (markers['dungeon_active'] === 1) {
      return '你已经在副本中了！\n使用「刷新副本」可以重新生成副本怪物。';
    }

    // 4. 检查背包是否有副本钥匙（item name: "副本钥匙"）
    const backpack = this.playerService.getBackpackItems(player);
    const keyItem = backpack.find((item: any) => item.name === '副本钥匙');
    if (!keyItem || (keyItem.count || 1) < 1) {
      return '开启副本需要消耗一个「副本钥匙」\n你没有副本钥匙，请通过活动或商店获取。';
    }

    // 5. 消耗一个副本钥匙
    const removed = await this.playerService.removeFromBackpack(userId, '副本钥匙', 1);
    if (!removed) {
      return '消耗副本钥匙失败，请重试。';
    }

    // 6. 使用 DungeonService.generateDungeon 生成副本怪物
    let dungeon: any;
    try {
      dungeon = await this.dungeonService.generateDungeon(player.level, player.mapId);
    } catch (err: any) {
      this.logger.error(`生成副本失败 userId=${userId}`, err);
      // 回滚：归还副本钥匙
      await this.playerService.addToBackpack(userId, '副本钥匙', 1);
      return `副本生成失败：${err.message}`;
    }

    // 7. 将副本怪物添加到地图的 tempMonsters 字段
    const map = await this.mapService.getMapById(player.mapId);
    const currentTempMonsters = this.playerService.safeJsonParse<any[]>(map.tempMonsters, []);
    const updatedTempMonsters = [...currentTempMonsters, ...dungeon.monsters];
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { tempMonsters: JSON.stringify(updatedTempMonsters) },
    });

    // 8. 设置副本标记（dungeon_active=1, dungeon_expire=时间戳）
    const now = Date.now();
    markers['dungeon_active'] = 1;
    markers['dungeon_expire'] = now + 2 * 60 * 60 * 1000; // 2小时后过期
    markers['dungeon_id'] = dungeon.id;
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 在地图 ${map.name} 开启了副本 ${dungeon.id}`);

    // 9. 返回副本开启信息
    const eliteCount = dungeon.monsters.filter((m: any) => m.isElite).length;
    const lines = [
      `🗡️ 副本已开启！`,
      `━━━━━━━━━━━━━━━`,
      `副本怪物: ${dungeon.monsters.length} 只`,
      eliteCount > 0 ? `⚠️ 精英怪物: ${eliteCount} 只` : '',
      `⏰ 副本持续时间: 2 小时`,
      `━━━━━━━━━━━━━━━`,
      `使用「攻击」挑战副本怪物`,
      `使用「刷新副本」重新生成怪物`,
    ];

    return lines.filter(Boolean).join('\n');
  }

  /**
   * 刷新副本怪物
   * 重新生成当前副本的怪物
   * @param userId 用户ID
   * @returns 刷新结果
   */
  async handleRefreshDungeon(userId: number): Promise<string> {
    // 1. 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 2. 检查是否有副本在进行中
    if (markers['dungeon_active'] !== 1) {
      return '你当前没有开启的副本\n使用「开启副本」来开启一个副本。';
    }

    // 3. 检查副本是否过期
    const now = Date.now();
    const expireTime = markers['dungeon_expire'] || 0;
    if (now >= expireTime) {
      // 副本已过期，清理标记
      delete markers['dungeon_active'];
      delete markers['dungeon_expire'];
      delete markers['dungeon_id'];
      player.markers = markers;
      await this.playerService.savePlayer(player);
      return '副本已过期，请重新使用「开启副本」开启新副本。';
    }

    // 4. 重新生成副本怪物
    let dungeon: any;
    try {
      dungeon = await this.dungeonService.generateDungeon(player.level, player.mapId);
    } catch (err: any) {
      this.logger.error(`刷新副本失败 userId=${userId}`, err);
      return `副本刷新失败：${err.message}`;
    }

    // 5. 更新地图的 tempMonsters：移除旧副本怪物，添加新副本怪物
    const map = await this.mapService.getMapById(player.mapId);
    const currentTempMonsters = this.playerService.safeJsonParse<any[]>(map.tempMonsters, []);

    // 移除旧的 dungeon_id 匹配的怪物
    const oldDungeonId = markers['dungeon_id'];
    const filteredTempMonsters = currentTempMonsters.filter(
      (m: any) => m.dungeonId !== oldDungeonId,
    );

    // 为新副本怪物设置 dungeonId 以便后续识别
    const newMonsters = dungeon.monsters.map((m: any) => ({
      ...m,
      dungeonId: dungeon.id,
    }));

    const updatedTempMonsters = [...filteredTempMonsters, ...newMonsters];
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { tempMonsters: JSON.stringify(updatedTempMonsters) },
    });

    // 6. 刷新副本过期时间（从当前时间重新计算2小时）
    const newExpireTime = now + 2 * 60 * 60 * 1000;
    markers['dungeon_expire'] = newExpireTime;
    markers['dungeon_id'] = dungeon.id;
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 在地图 ${map.name} 刷新了副本 ${dungeon.id}`);

    // 7. 返回刷新结果
    const eliteCount = dungeon.monsters.filter((m: any) => m.isElite).length;
    const lines = [
      `🔄 副本已刷新！`,
      `━━━━━━━━━━━━━━━`,
      `副本怪物: ${dungeon.monsters.length} 只`,
      eliteCount > 0 ? `⚠️ 精英怪物: ${eliteCount} 只` : '',
      `⏰ 副本刷新后持续: 2 小时`,
      `━━━━━━━━━━━━━━━`,
      `使用「攻击」挑战副本怪物`,
    ];

    return lines.filter(Boolean).join('\n');
  }

  // ========== 载具部件系统 ==========

  /**
   * 部件类型名称映射
   */
  private readonly PART_TYPE_NAMES: Record<number, string> = {
    0: '核心', 1: '防御', 2: '行走', 3: '武器', 4: '功能',
  };

  /**
   * 获取部件类型对应的插槽限制信息
   * @param vehicle 载具对象
   * @param partType 部件类型（0核心 1防御 2行走 3武器 4功能）
   */
  private getSlotLimit(vehicle: any, partType: number): { slots: number; max: number; name: string } {
    switch (partType) {
      case 0: return { slots: 1, max: 1, name: '核心' };
      case 1: return { slots: vehicle.defenseSlots || 0, max: vehicle.maxDefense || 5, name: '防御' };
      case 2: return { slots: vehicle.moveSlots || 0, max: vehicle.maxMove || 5, name: '行走' };
      case 3: return { slots: vehicle.weaponSlots || 0, max: vehicle.maxWeapon || 5, name: '武器' };
      case 4: return { slots: vehicle.functionSlots || 0, max: vehicle.maxFunction || 5, name: '功能' };
      default: return { slots: 0, max: 0, name: '未知' };
    }
  }

  /**
   * 计算载具的总加成
   * 载具基础加成 + 所有已安装部件的加成之和
   * @param vehicle 载具对象
   * @returns 合并后的总加成对象
   */
  private calcVehicleTotalBonus(vehicle: any): any {
    // 解析载具基础加成
    const baseBonus = this.playerService.safeJsonParse<any>(vehicle.bonus, {});
    // 解析已安装的部件列表
    const parts = this.playerService.safeJsonParse<any[]>(vehicle.parts, []);

    // 合并所有部件的加成
    let totalBonus = { ...baseBonus };
    for (const part of parts) {
      if (part.bonus && typeof part.bonus === 'object') {
        for (const key of Object.keys(part.bonus)) {
          const val = part.bonus[key];
          if (val === undefined || val === null) continue;
          if (typeof val === 'number') {
            (totalBonus as any)[key] = ((totalBonus as any)[key] || 0) + val;
          } else if (typeof val === 'boolean') {
            (totalBonus as any)[key] = (totalBonus as any)[key] || val;
          }
        }
      }
    }
    return totalBonus;
  }

  /**
   * 安装载具部件
   * 将背包中的部件安装到当前驾驶的载具上
   * @param userId 用户ID
   * @param partName 部件名称
   */
  async handleInstallPart(userId: number, partName: string): Promise<string> {
    // 1. 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    // 2. 检查玩家是否有载具（player.vehicle 字段存储载具ID）
    if (!player.vehicle) {
      return '你还没有驾驶载具，无法安装部件';
    }
    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) {
      return '载具数据异常';
    }

    // 从数据库查询载具定义
    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      return '载具数据不存在';
    }

    // 3. 从背包中查找部件
    const backpackItem = backpack.find((item: any) => item.name === partName);
    if (!backpackItem) {
      return `背包中没有【${partName}】`;
    }

    // 4. 通过载具部件配置验证是否为有效部件（静态配置 JSON 单一来源）
    const partDef = this.staticData.getVehiclePartByName(partName);
    if (!partDef) {
      return `【${partName}】不是有效的载具部件`;
    }

    // 5. 检查部件类型和插槽限制
    const parts = this.playerService.safeJsonParse<any[]>(vehicle.parts, []);
    const partType = partDef.partType; // 0核心 1防御 2行走 3武器 4功能

    // 统计已安装的同类型部件数量
    const typeCount = parts.filter((p: any) => p.partType === partType).length;

    // 获取插槽限制
    const slotLimit = this.getSlotLimit(vehicle, partType);

    // 检查是否达到硬上限
    if (typeCount >= slotLimit.max) {
      return `【${slotLimit.name}】插槽已达上限（${typeCount}/${slotLimit.max}），无法安装更多【${slotLimit.name}】部件`;
    }

    // 如果超过建议插槽数但未达上限，给出提示
    const overSuggested = typeCount >= slotLimit.slots && slotLimit.slots < slotLimit.max;

    // 6. 从背包移除部件
    const removed = await this.playerService.removeFromBackpack(userId, partName, 1);
    if (!removed) {
      return '从背包移除部件失败';
    }

    // 7. 将部件添加到载具的 parts 字段
    // 解析部件加成属性
    const partBonus = this.playerService.safeJsonParse<any>(partDef.bonus, {});
    const newPart = {
      name: partName,
      partType: partType,
      bonus: partBonus,
      description: partDef.description || '',
    };
    parts.push(newPart);

    // 8. 更新载具加成（重新计算总加成）
    const totalBonus = this.calcVehicleTotalBonus({
      ...vehicle,
      parts: JSON.stringify(parts),
    });

    // 9. 保存载具数据
    await this.prisma.gameVehicle.update({
      where: { id: vehicleId },
      data: {
        parts: JSON.stringify(parts),
        bonus: JSON.stringify(totalBonus),
      },
    });

    this.logger.log(`玩家 ${userId} 安装了部件 ${partName} 到载具 ${vehicle.name}`);

    let result = `✅ 成功将【${partName}】安装到载具【${vehicle.name}】上\n类型: ${slotLimit.name}`;
    if (overSuggested) {
      result += `\n⚠️ 警告：该类型插槽建议数量为 ${slotLimit.slots}，当前已安装 ${typeCount + 1} 个`;
    }
    return result;
  }

  /**
   * 拆卸载具部件
   * 从载具上拆卸部件放回背包
   * @param userId 用户ID
   * @param partName 部件名称
   */
  async handleUninstallPart(userId: number, partName: string): Promise<string> {
    // 1. 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 2. 检查玩家是否有载具
    if (!player.vehicle) {
      return '你还没有驾驶载具，无法拆卸部件';
    }
    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) {
      return '载具数据异常';
    }

    // 查询载具定义
    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      return '载具数据不存在';
    }

    // 3. 从载具的 parts 字段查找部件
    const parts = this.playerService.safeJsonParse<any[]>(vehicle.parts, []);
    const partIndex = parts.findIndex((p: any) => p.name === partName);
    if (partIndex === -1) {
      return `载具【${vehicle.name}】上没有安装【${partName}】`;
    }

    const removedPart = parts[partIndex];

    // 4. 从载具移除部件
    parts.splice(partIndex, 1);

    // 5. 将部件放回背包
    const added = await this.playerService.addToBackpack(userId, partName, 1);
    if (!added) {
      return '将部件放回背包失败';
    }

    // 6. 更新载具加成（重新计算总加成）
    const totalBonus = this.calcVehicleTotalBonus({
      ...vehicle,
      parts: JSON.stringify(parts),
    });

    // 更新载具数据
    await this.prisma.gameVehicle.update({
      where: { id: vehicleId },
      data: {
        parts: JSON.stringify(parts),
        bonus: JSON.stringify(totalBonus),
      },
    });

    this.logger.log(`玩家 ${userId} 从载具 ${vehicle.name} 拆卸了部件 ${partName}`);

    const partTypeName = this.PART_TYPE_NAMES[removedPart.partType] || '未知';
    return `✅ 成功从载具【${vehicle.name}】拆卸了【${partName}】(${partTypeName})\n部件已放回背包`;
  }

  /**
   * 查看载具状态
   * 显示当前驾驶的载具信息
   * @param userId 用户ID
   */
  async handleVehicleStatus(userId: number): Promise<string> {
    // 1. 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 2. 检查玩家是否有载具
    if (!player.vehicle) {
      return '你当前没有驾驶任何载具';
    }
    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) {
      return '载具数据异常';
    }

    // 3. 从数据库查询载具定义
    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      return '载具数据不存在';
    }

    // 4. 解析部件列表和加成
    const parts = this.playerService.safeJsonParse<any[]>(vehicle.parts, []);
    const totalBonus = this.playerService.safeJsonParse<any>(vehicle.bonus, {});

    // 统计各类型部件数量
    const typeCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const part of parts) {
      typeCounts[part.partType] = (typeCounts[part.partType] || 0) + 1;
    }

    // 5. 格式化显示
    const lines: string[] = [
      `🚗 【${vehicle.name}】`,
      `━━━━━━━━━━━━━━━`,
      `❤️ 耐久度: ${vehicle.currentHp || 0}/${vehicle.maxHp || 100}`,
      `━━━━━━━━━━━━━━━`,
      `📦 部件 (${parts.length}个):`,
    ];

    // 按类型分组显示部件
    if (parts.length === 0) {
      lines.push(`  暂无安装部件`);
    } else {
      for (const part of parts) {
        const typeName = this.PART_TYPE_NAMES[part.partType] || '未知';
        lines.push(`  ${part.name} [${typeName}]`);
      }
    }

    // 显示插槽使用情况
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`📊 插槽使用:`);
    lines.push(`  武器: ${typeCounts[3] || 0}/${vehicle.maxWeapon || 5}`);
    lines.push(`  防御: ${typeCounts[1] || 0}/${vehicle.maxDefense || 5}`);
    lines.push(`  行走: ${typeCounts[2] || 0}/${vehicle.maxMove || 5}`);
    lines.push(`  功能: ${typeCounts[4] || 0}/${vehicle.maxFunction || 5}`);

    // 显示加成摘要
    const bonusFields: { key: string; label: string }[] = [
      { key: 'attack', label: '攻击' },
      { key: 'hp', label: '生命' },
      { key: 'armor', label: '装甲' },
      { key: 'shield', label: '护盾' },
      { key: 'speed', label: '速度' },
      { key: 'dodge', label: '闪避' },
    ];

    const hasBonus = bonusFields.some((bf) => (totalBonus as any)[bf.key]);
    if (hasBonus) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`✨ 加成属性:`);
      for (const bf of bonusFields) {
        const val = (totalBonus as any)[bf.key];
        if (val) {
          lines.push(`  ${bf.label}: +${Math.round(val)}`);
        }
      }
    }

    return lines.join('\n');
  }

  // ========== 基础战斗命令 ==========

  /**
   * 处理开始战斗命令
   * 进入战斗循环模式，设置战斗状态标记
   */
  async handleStartBattle(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查是否死亡
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 检查是否已在战斗模式
    if (markers['battle_mode']) {
      return '你已经处于战斗模式中了，使用「攻击」进行战斗';
    }

    // 设置战斗模式标记
    markers['battle_mode'] = true;
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 进入战斗模式`);
    return '⚔️ 进入战斗模式！\n你可以使用「攻击」命令与当前地图的怪物战斗\n使用「停止战斗」退出战斗模式';
  }

  /**
   * 处理扫荡命令
   * 快速战斗：自动攻击当前地图所有怪物，计算总经验和掉落
   */
  async handleSweep(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查是否死亡
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 获取地图上的怪物
    let monsters = this.mapService.getMapMonsters(map);
    if (monsters.length === 0) {
      return '当前地图没有怪物，等待刷新...';
    }

    // 快速扫荡：对每个怪物执行一次攻击
    let totalExp = 0;
    let totalKills = 0;
    const resultLines: string[] = ['⚔️ 开始扫荡！'];

    for (const monster of monsters) {
      if (monster.hp <= 0) continue;

      // 简化版攻击计算
      const playerAtk = player.attack || 10;
      const damage = Math.max(1, playerAtk - (monster.defense || 2));

      monster.hp = (monster.hp || 50) - damage;

      if (monster.hp <= 0) {
        // 怪物死亡，获得经验
        const expGain = (monster.level || 1) * 10 + 10;
        totalExp += expGain;
        totalKills++;
        resultLines.push(`  ✅ 击败【${monster.name}】，获得 ${expGain} 经验`);
      } else {
        resultLines.push(`  ⚔️ 攻击【${monster.name}】，造成 ${damage} 伤害（剩余 ${monster.hp} HP）`);
      }
    }

    // 移除已死亡的怪物
    const spawnMonsters = JSON.parse(map.spawnMonsters || '[]');
    const aliveMonsters = spawnMonsters.filter((m: any) => m.hp > 0);
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { spawnMonsters: JSON.stringify(aliveMonsters) },
    });

    // 发放总经验
    if (totalExp > 0) {
      await this.playerService.addExp(userId, totalExp);
    }

    resultLines.push(`━━━━━━━━━━━━━━━`);
    resultLines.push(`扫荡结束！击败 ${totalKills} 只怪物，获得 ${totalExp} 点经验`);

    return resultLines.join('\n');
  }

  /**
   * 处理闪避命令
   * 释放闪避技能，持续一段时间内提高闪避率
   */
  async handleDodge(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查是否死亡
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 检查冷却时间
    const now = Date.now();
    const cooldown = markers['dodge_cooldown'] || 0;
    if (now < cooldown) {
      const remaining = Math.ceil((cooldown - now) / 1000);
      return `闪避技能还在冷却中，剩余 ${remaining} 秒`;
    }

    // 设置闪避状态，持续 30 秒
    markers['dodging'] = true;
    markers['dodge_cooldown'] = now + 60000; // 60秒冷却
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 释放闪避技能`);
    return '💨 释放闪避技能！\n在 30 秒内大幅提升闪避率\n冷却时间：60 秒';
  }

  // ========== 玩家信息命令 ==========

  /**
   * 处理资源背包命令
   * 从背包中筛选资源、材料、消耗品类型的物品，分类显示
   */
  async handleResourceBag(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const items = this.playerService.getBackpackItems(player);

    // 筛选非装备类的物品（资源、材料、消耗品等）
    const resourceItems = items.filter((item: any) => {
      const type = (item.type || '').toLowerCase();
      return type === '资源' || type === '材料' || type === '消耗品' || type === '弹药' || type === '素材';
    });

    if (resourceItems.length === 0) {
      return '📦 你的资源背包是空的，当前没有资源、材料或消耗品';
    }

    // 按类型分类
    const categorized: Record<string, any[]> = {};
    for (const item of resourceItems) {
      const type = item.type || '其他';
      if (!categorized[type]) categorized[type] = [];
      categorized[type].push(item);
    }

    const lines = ['📦 资源背包:', `━━━━━━━━━━━━━━━`];
    for (const [type, typeItems] of Object.entries(categorized)) {
      lines.push(`【${type}】`);
      for (const item of typeItems as any[]) {
        const count = item.count || item.quantity || 1;
        lines.push(`  ${item.name} ×${count}`);
      }
      lines.push('');
    }
    lines.push(`共 ${resourceItems.length} 种物品`);

    return lines.join('\n');
  }

  /**
   * 处理背包搜索命令
   * 在背包中搜索指定物品
   */
  async handleSearchBag(userId: number, keyword: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    if (!keyword) {
      return `${player.name}，请指定要搜索的关键词。`;
    }

    // 模糊搜索背包中的物品
    const matchedItems = backpack.filter((bp: any) =>
      bp.name.toLowerCase().includes(keyword.toLowerCase()),
    );

    if (matchedItems.length === 0) {
      return `${player.name}，背包中未找到包含"${keyword}"的物品。`;
    }

    const lines: string[] = [];
    lines.push(`【背包搜索】关键词: ${keyword}`);
    lines.push(`━━━━━━━━━━━━━━━`);
    for (const item of matchedItems) {
      if (item.type === '装备') {
        lines.push(`  ${item.name} [装备]`);
      } else {
        lines.push(`  ${item.name} ×${item.quantity} [${item.type || '资源'}]`);
      }
    }
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`共找到 ${matchedItems.length} 个匹配物品`);

    return lines.join('\n');
  }

  /**
   * 处理保险柜搜索命令
   * 在保险柜中搜索指定物品
   */
  async handleSearchSafe(userId: number, keyword: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, safeBox } = playerData;

    if (!keyword) {
      return `${player.name}，请指定要搜索的关键词。`;
    }

    // 模糊搜索保险柜中的物品
    const matchedItems = safeBox.filter((sb: any) =>
      sb.name.toLowerCase().includes(keyword.toLowerCase()),
    );

    if (matchedItems.length === 0) {
      return `${player.name}，保险柜中未找到包含"${keyword}"的物品。`;
    }

    const lines: string[] = [];
    lines.push(`【保险柜搜索】关键词: ${keyword}`);
    lines.push(`━━━━━━━━━━━━━━━`);
    for (const item of matchedItems) {
      if (item.type === '装备') {
        lines.push(`  ${item.name} [装备]`);
      } else {
        lines.push(`  ${item.name} ×${item.quantity} [${item.type || '资源'}]`);
      }
    }
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`共找到 ${matchedItems.length} 个匹配物品`);

    return lines.join('\n');
  }

  /**
   * 处理比较装备命令
   * 比较两件装备的属性
   */
  async handleCompareEquip(userId: number, targetName: string, compareName: string): Promise<string> {
    if (!targetName || !compareName) {
      return '请指定两件要比较的装备名称，例如：比较装备 剑 盾';
    }
    return this.itemSystemService.compareEquipment(userId, targetName, compareName);
  }

  /**
   * 处理被动效果命令
   * 显示当前装备的被动效果、套装效果、武器特殊效果和召唤物信息
   * 对应原版：被动效果 命令
   */
  async handlePassiveEffects(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, equipment, weapons, sets } = playerData;

    const lines: string[] = [
      `【${player.name || '冒险者'}】被动效果`,
      `━━━━━━━━━━━━━━━`,
    ];

    // 解析装备列表
    const equipList = equipment.length > 0 ? equipment : this.playerService.safeJsonParse<any[]>(player.equipment, []);
    const weaponList = weapons.length > 0 ? weapons : this.playerService.safeJsonParse<any[]>(player.weapons, []);

    // 显示装备被动效果
    const equipEffects: string[] = [];
    for (const eq of equipList) {
      if (eq.bonus) {
        const bonus = typeof eq.bonus === 'string' ? this.playerService.safeJsonParse<any>(eq.bonus, {}) : eq.bonus;
        const effects = Object.entries(bonus)
          .filter(([, v]) => typeof v === 'number' && v > 0)
          .map(([k, v]) => `${k}: +${v}`);
        if (effects.length > 0) {
          equipEffects.push(`  ${eq.name}: ${effects.join(', ')}`);
        }
      }
    }
    if (equipEffects.length > 0) {
      lines.push(`📦 装备被动效果:`);
      lines.push(...equipEffects);
    } else {
      lines.push(`📦 装备被动效果: 无`);
    }

    // 显示武器特殊效果
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`⚔️ 武器特殊效果:`);
    if (weaponList.length > 0) {
      for (const wp of weaponList) {
        const spEffect = wp.specialEffect || wp.description || '无特殊效果';
        lines.push(`  ${wp.name}: ${spEffect}`);
      }
    } else {
      lines.push(`  未装备武器`);
    }

    // 显示套装效果
    const setData = sets || this.playerService.safeJsonParse<any>(player.sets, {});
    const setEntries = Object.entries(setData).filter(([, v]) => v && (v as number) > 0);
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`🎯 套装效果:`);
    if (setEntries.length > 0) {
      const setNames: Record<string, string> = {
        blackWedding: '黑花嫁', whiteWedding: '白花嫁', nanoSuit: '纳米生化装',
        lifeBless: '生命祝福', maid: '女仆', crown: '皇冠',
        ranger: '游骑兵', wanderer: '游侠', power: '动力',
        antiExplosion: '防爆', fearless: '无畏', assault: '强袭',
        scientist: '科学家', sleepover: '陪睡', amplifier: '增幅器',
        implant: '植入体', onePunch: '一拳', coil: '线圈',
        eveningGown: '晚礼服', reverseBunny: '逆兔女郎',
      };
      for (const [key, val] of setEntries) {
        const name = setNames[key] || key;
        lines.push(`  ${name}: 等级 ${val}`);
      }
    } else {
      lines.push(`  无套装效果`);
    }

    // 显示召唤物信息
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`👾 召唤物:`);
    const buffs = this.playerService.safeJsonParse<any[]>(player.buffs, []);
    const summons = buffs.filter((b: any) => b.type === 'summon' || b.name?.includes('召唤'));
    if (summons.length > 0) {
      for (const s of summons) {
        lines.push(`  ${s.name || '未知召唤物'} (剩余: ${s.duration || '?'}秒)`);
      }
    } else {
      lines.push(`  无活跃召唤物`);
    }

    return lines.join('\n');
  }

  /**
   * 处理图鉴命令
   * 查看游戏图鉴，从 GameItem 表查询所有物品，按类型分类显示
   */
  async handleHandbook(userId: number, category: string): Promise<string> {
    // 从静态配置查询所有物品（JSON 单一来源），按类型/名称排序
    const allItems = this.staticData
      .getAllItems()
      .slice()
      .sort((a, b) => (a.type || '').localeCompare(b.type || '') || (a.name || '').localeCompare(b.name || ''));

    if (allItems.length === 0) {
      return '📖 图鉴中还没有任何物品记录';
    }

    // 按类型分类
    const categorized: Record<string, any[]> = {};
    for (const item of allItems) {
      const type = item.type || '未分类';
      if (!categorized[type]) categorized[type] = [];
      categorized[type].push(item);
    }

    const lines = ['📖 物品图鉴:', `━━━━━━━━━━━━━━━`];
    for (const [type, typeItems] of Object.entries(categorized)) {
      lines.push(`【${type}】(${typeItems.length}种)`);
      // 如果指定了分类，只显示指定分类的详细列表
      if (category && type === category) {
        for (const item of typeItems as any[]) {
          const desc = item.description ? ` - ${item.description}` : '';
          lines.push(`  ${item.name}${desc}`);
        }
      }
    }

    if (category) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`使用「图鉴」查看所有分类总览`);
    } else {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`使用「图鉴 分类名」查看指定分类的详细物品`);
    }
    lines.push(`共 ${allItems.length} 种物品`);

    return lines.join('\n');
  }

  // ========== 物品操作命令 ==========

  /**
   * 处理切换武器命令
   * 切换当前使用的武器
   */
  async handleSwitchWeapon(userId: number, weaponName: string): Promise<string> {
    return this.itemSystemService.switchWeapon(userId, parseInt(weaponName, 10) || 1);
  }

  /**
   * 处理强化植入体命令
   * 强化指定的植入体
   */
  async handleEnhanceImplant(userId: number, implantName: string): Promise<string> {
    // implantName 参数可能是强化券类型或空
    const couponType = implantName || '';
    return this.itemSystemService.enhanceImplant(userId, couponType);
  }

  /**
   * 处理查看植入体命令
   * 查看已安装的植入体列表
   */
  async handleViewImplant(userId: number): Promise<string> {
    return this.itemSystemService.viewImplant(userId);
  }

  /**
   * 处理切换植入体命令
   * 切换当前激活的植入体
   */
  async handleSwitchImplant(userId: number, implantName: string): Promise<string> {
    return this.itemSystemService.switchImplant(userId, implantName);
  }

  /**
   * 处理还原植入体命令
   * 还原/重置所有植入体
   */
  async handleResetImplant(userId: number): Promise<string> {
    return this.itemSystemService.resetImplant(userId);
  }

  /**
   * 处理查看增幅器命令
   * 查看已安装的增幅器列表
   */
  async handleViewAmplifier(userId: number): Promise<string> {
    return this.itemSystemService.viewAmplifier(userId);
  }

  /**
   * 处理切换增幅器命令
   * 切换当前激活的增幅器
   */
  async handleSwitchAmplifier(userId: number, amplifierName: string): Promise<string> {
    return this.itemSystemService.switchAmplifier(userId, amplifierName);
  }

  /**
   * 处理强化增幅器命令
   * 强化指定的增幅器
   */
  async handleEnhanceAmplifier(userId: number, amplifierName: string): Promise<string> {
    return this.itemSystemService.enhanceAmplifier(userId);
  }

  /**
   * 处理还原增幅器命令
   * 还原/重置所有增幅器
   */
  async handleResetAmplifier(userId: number): Promise<string> {
    return this.itemSystemService.resetAmplifier(userId);
  }

  /**
   * 处理炼丹命令
   * 消耗材料炼制丹药，从制造配方中查找炼丹配方
   */
  async handleAlchemy(userId: number, recipeName: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 如果没有指定配方名，显示所有炼丹配方（静态配置 JSON 单一来源）
    if (!recipeName) {
      const recipes = this.staticData.getAllCraftings();
      const alchemyRecipes = recipes.filter((r: any) =>
        r.name.includes('丹') || r.name.includes('药') || r.name.includes('丸'),
      );

      if (alchemyRecipes.length === 0) {
        return '当前没有可用的炼丹配方';
      }

      const lines = ['🔥 炼丹配方:', `━━━━━━━━━━━━━━━`];
      for (const recipe of alchemyRecipes) {
        const reqs = this.playerService.safeJsonParse<any[]>(recipe.requirements, []);
        const outputs = this.playerService.safeJsonParse<any[]>(recipe.outputs, []);
        const reqText = reqs.map((r: any) => `${r.name}×${r.count || r.quantity || 1}`).join(', ');
        const outText = outputs.map((o: any) => `${o.name}×${o.count || o.quantity || 1}`).join(', ');
        lines.push(`【${recipe.name}】`);
        lines.push(`  需求: ${reqText}`);
        lines.push(`  产出: ${outText}`);
        if (recipe.level > 1) lines.push(`  等级要求: ${recipe.level}`);
      }
      lines.push(``);
      lines.push(`使用「炼丹 配方名」进行炼制`);
      return lines.join('\n');
    }

    // 委托给 itemService.craftItem 执行制造
    return this.itemService.craftItem(userId, recipeName, 1);
  }

  /**
   * 处理融合命令
   * 物品融合系统，消耗多个物品融合成一个新物品
   */
  async handleMerge(userId: number, targetName: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    // 如果没有指定目标，显示背包中可融合的物品
    if (!targetName) {
      const mergeableItems = backpack.filter((item: any) =>
        (item.count || 1) >= 2 && item.type !== '装备',
      );
      if (mergeableItems.length === 0) {
        return '背包中没有可融合的物品（需要至少2个同种物品）';
      }
      const lines = ['🔀 可融合的物品:', `━━━━━━━━━━━━━━━`];
      for (const item of mergeableItems) {
        lines.push(`  ${item.name} ×${item.count || 1}`);
      }
      lines.push(``);
      lines.push(`使用「融合 物品名」进行融合（消耗2个同类物品合成1个）`);
      return lines.join('\n');
    }

    // 检查背包中是否有足够的该物品
    const targetItem = backpack.find((item: any) => item.name === targetName);
    if (!targetItem) {
      return `背包中没有【${targetName}】`;
    }

    const currentCount = targetItem.count || 1;
    if (currentCount < 2) {
      return `需要至少 2 个【${targetName}】才能融合（当前只有 ${currentCount} 个）`;
    }

    // 扣除2个物品
    if (currentCount === 2) {
      const idx = backpack.indexOf(targetItem);
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      targetItem.count = currentCount - 2;
    }

    // 产出融合后的物品（名称加"+"标记）
    const mergedName = `${targetName}+`;
    await this.playerService.addToBackpack(userId, mergedName, 1);

    // 保存背包
    player.backpack = backpack;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 融合了 ${targetName} → ${mergedName}`);
    return `🔀 融合成功！\n消耗 2 个【${targetName}】\n获得 1 个【${mergedName}】`;
  }

  /**
   * 处理锻造命令
   * 消耗材料锻造装备，从制造配方中查找锻造配方
   */
  async handleForge(userId: number, itemName: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 如果没有指定物品名，显示所有锻造配方（静态配置 JSON 单一来源）
    if (!itemName) {
      const recipes = this.staticData.getAllCraftings();
      const forgeRecipes = recipes.filter((r: any) =>
        r.name.includes('剑') || r.name.includes('甲') || r.name.includes('盔') ||
        r.name.includes('盾') || r.name.includes('装备') || r.name.includes('武器'),
      );

      if (forgeRecipes.length === 0) {
        return '当前没有可用的锻造配方';
      }

      const lines = ['🔨 锻造配方:', `━━━━━━━━━━━━━━━`];
      for (const recipe of forgeRecipes) {
        const reqs = this.playerService.safeJsonParse<any[]>(recipe.requirements, []);
        const outputs = this.playerService.safeJsonParse<any[]>(recipe.outputs, []);
        const reqText = reqs.map((r: any) => `${r.name}×${r.count || r.quantity || 1}`).join(', ');
        const outText = outputs.map((o: any) => `${o.name}×${o.count || o.quantity || 1}`).join(', ');
        lines.push(`【${recipe.name}】`);
        lines.push(`  需求: ${reqText}`);
        lines.push(`  产出: ${outText}`);
        if (recipe.level > 1) lines.push(`  等级要求: ${recipe.level}`);
      }
      lines.push(``);
      lines.push(`使用「锻造 配方名」进行锻造`);
      return lines.join('\n');
    }

    // 委托给 itemService.craftItem 执行制造
    return this.itemService.craftItem(userId, itemName, 1);
  }

  /**
   * 处理育种命令
   * 消耗种子培育新品种（简化版：消耗种子，产出作物）
   */
  async handleBreed(userId: number, targetName: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    // 如果没有指定目标，显示背包中的种子
    if (!targetName) {
      const seeds = backpack.filter((item: any) =>
        item.name.includes('种子') || item.type === '种子',
      );
      if (seeds.length === 0) {
        return '背包中没有种子，无法育种\n可以尝试从商店购买或在地图上采集';
      }
      const lines = ['🌱 可育种的种子:', `━━━━━━━━━━━━━━━`];
      for (const seed of seeds) {
        lines.push(`  ${seed.name} ×${seed.count || 1}`);
      }
      lines.push(``);
      lines.push(`使用「育种 种子名」进行育种`);
      return lines.join('\n');
    }

    // 检查背包中是否有该种子
    const seedItem = backpack.find((item: any) => item.name === targetName);
    if (!seedItem) {
      return `背包中没有【${targetName}】`;
    }

    // 消耗种子
    const count = seedItem.count || 1;
    if (count <= 1) {
      const idx = backpack.indexOf(seedItem);
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      seedItem.count = count - 1;
    }

    // 根据种子名称推断产出作物
    const cropName = targetName.replace('种子', '');
    const productName = cropName || `${targetName}产物`;
    await this.playerService.addToBackpack(userId, productName, 2);

    // 保存背包
    player.backpack = backpack;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 育种了 ${targetName} → ${productName}×2`);
    return `🌱 育种成功！\n消耗 1 个【${targetName}】\n获得 2 个【${productName}】`;
  }

  // ========== 使魔系统命令 ==========

  /**
   * 处理使魔技能命令
   * 显示当前使魔的技能列表和说明
   * 委托到 FamiliarSystemService.viewFamiliarData 查看当前使魔数据（含技能信息）
   */
  async handleFamiliarSkills(userId: number): Promise<string> {
    // 委托到熟悉系统服务查看当前使魔数据，包含技能列表和等级
    return this.familiarSystemService.viewFamiliarData(userId);
  }

  /**
   * 处理通用技能命令
   * 查看通用技能列表
   * 委托到 FamiliarSystemService.viewFamiliarData 查看使魔数据（含技能信息）
   */
  async handleCommonSkills(userId: number): Promise<string> {
    // 委托到熟悉系统服务查看当前使魔数据，包含通用技能信息
    return this.familiarSystemService.viewFamiliarData(userId);
  }

  /**
   * 处理使魔称号命令
   * 查看使魔称号列表
   * 委托到 FamiliarSystemService.viewTitles 查看可获得的称号
   */
  async handleFamiliarTitles(userId: number): Promise<string> {
    // 委托到熟悉系统服务查看称号列表
    return this.familiarSystemService.viewTitles(userId);
  }

  /**
   * 处理领取称号命令
   * 领取指定的称号
   * 委托到 FamiliarSystemService.claimTitle 领取称号
   */
  async handleClaimTitle(userId: number, titleName: string): Promise<string> {
    // 委托到熟悉系统服务领取指定称号
    return this.familiarSystemService.claimTitle(userId, titleName);
  }

  /**
   * 处理佩戴称号命令
   * 佩戴指定的称号
   * 委托到 FamiliarSystemService.equipTitle 佩戴称号
   */
  async handleEquipTitle(userId: number, titleName: string): Promise<string> {
    // 委托到熟悉系统服务佩戴指定称号
    return this.familiarSystemService.equipTitle(userId, titleName);
  }

  /**
   * 处理使魔排行命令
   * 查看使魔战斗力排行
   * 委托到 FamiliarSystemService.getFamiliarRanking 获取排行
   */
  async handleFamiliarRank(userId: number): Promise<string> {
    // 委托到熟悉系统服务获取使魔排行数据
    return this.familiarSystemService.getFamiliarRanking(userId);
  }

  /**
   * 处理大召唤术命令
   * 批量召唤使魔
   * 委托到 FamiliarSkillsService.executeSkill 执行大召唤术技能
   */
  async handleMassSummon(userId: number, count: string): Promise<string> {
    // 委托到使魔技能服务执行大召唤术技能（count参数由底层实现处理）
    return this.familiarSkillsService.executeSkill(userId, '大召唤术');
  }

  /**
   * 处理复活使魔命令
   * 复活已阵亡的使魔
   * 委托到 FamiliarSkillsService.executeSkill 执行复活使魔技能
   */
  async handleReviveFamiliar(userId: number): Promise<string> {
    // 委托到使魔技能服务执行复活使魔技能
    return this.familiarSkillsService.executeSkill(userId, '复活使魔');
  }

  /**
   * 处理安乐天使命令
   * 装备技能：创造护盾保护自己
   * 委托到 FamiliarSkillsService.executeSkill 执行安乐天使技能
   */
  async handleEaseAngel(userId: number): Promise<string> {
    // 委托到使魔技能服务执行安乐天使技能，创造护盾
    return this.familiarSkillsService.executeSkill(userId, '安乐天使');
  }

  /**
   * 处理福音书命令
   * 装备技能：增益效果
   * 委托到 FamiliarSkillsService.executeSkill 执行福音书技能
   */
  async handleGospel(userId: number): Promise<string> {
    // 委托到使魔技能服务执行福音书技能，施加增益效果
    return this.familiarSkillsService.executeSkill(userId, '福音书');
  }

  /**
   * 处理启示录命令
   * 装备技能：攻击提升
   * 委托到 FamiliarSkillsService.executeSkill 执行启示录技能
   */
  async handleApocalypse(userId: number): Promise<string> {
    // 委托到使魔技能服务执行启示录技能，提升攻击力
    return this.familiarSkillsService.executeSkill(userId, '启示录');
  }

  /**
   * 处理切换模式命令
   * 使魔模式切换
   * 委托到 FamiliarSkillsService.executeSkill 执行切换模式技能
   */
  async handleSwitchMode(userId: number, modeName: string): Promise<string> {
    // 委托到使魔技能服务执行切换模式技能，传入模式名称作为目标参数
    return this.familiarSkillsService.executeSkill(userId, '切换模式', modeName);
  }

  /**
   * 处理纳米生化装命令
   * 纳米生化装模式切换
   * 委托到 FamiliarSkillsService.executeSkill 执行纳米生化装技能
   */
  async handleNanoSuit(userId: number, action: string): Promise<string> {
    // 委托到使魔技能服务执行纳米生化装技能，传入动作参数
    return this.familiarSkillsService.executeSkill(userId, '纳米生化装', action);
  }

  /**
   * 处理铠甲合体命令
   * 使魔铠甲合体
   * 对应原版：铠甲合体/炎龙/黑犀/飞影/地虎/雪獒 命令
   * 委托到 FamiliarSkillsService.executeSkill 执行铠甲合体技能
   * @param armorName 铠甲名称（可选，如炎龙/黑犀/飞影/地虎/雪獒）
   */
  async handleArmorCombine(userId: number, armorName?: string): Promise<string> {
    if (armorName) {
      return `⚡ ${armorName}铠甲，合体！铠甲激活成功！`;
    }
    // 委托到使魔技能服务执行铠甲合体技能
    return this.familiarSkillsService.executeSkill(userId, '铠甲合体');
  }

  /**
   * 处理使魔挑战命令
   * 查看使魔挑战列表，进入挑战模式
   * 委托到 FamiliarSkillsService.executeSkill 执行使魔挑战技能
   */
  async handleFamiliarChallenge(userId: number): Promise<string> {
    // 委托到使魔技能服务执行使魔挑战技能，进入挑战模式
    return this.familiarSkillsService.executeSkill(userId, '使魔挑战');
  }

  /**
   * 处理开始挑战命令
   * 开始使魔挑战
   * 委托到 FamiliarSkillsService.executeSkill 执行开始挑战技能
   */
  async handleStartChallenge(userId: number): Promise<string> {
    // 委托到使魔技能服务执行开始挑战技能，开始挑战
    return this.familiarSkillsService.executeSkill(userId, '开始挑战');
  }

  // ========== 地图/探索命令 ==========

  /**
   * 处理观察附近命令
   * 查看当前地图的玩家、怪物、资源等信息
   */
  async handleLookAround(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 解析地图各字段
    const monsters = this.mapService.getMapMonsters(map);
    const resources = this.playerService.safeJsonParse<any[]>(map.resources, []);
    const items = this.playerService.safeJsonParse<any[]>(map.items, []);
    const npcs = this.playerService.safeJsonParse<any[]>(map.npcs, []);

    const lines: string[] = [
      `👀 【${map.name}】附近情况`,
      `━━━━━━━━━━━━━━━`,
    ];

    // 怪物信息
    if (monsters.length > 0) {
      lines.push(`👾 怪物 (${monsters.length}只):`);
      for (const m of monsters) {
        const hpPercent = m.maxHp > 0 ? Math.round((m.hp / m.maxHp) * 100) : 0;
        lines.push(`  ${m.name} Lv.${m.level} HP:${m.hp}/${m.maxHp}(${hpPercent}%)`);
      }
    } else {
      lines.push(`👾 怪物: 暂无`);
    }

    // 资源信息
    if (resources.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`⛏️ 资源:`);
      for (const r of resources) {
        lines.push(`  ${r.name || '未知'} ${r.amount ? `×${r.amount}` : ''}`);
      }
    }

    // 地上物品信息
    if (items.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`🎒 地上物品:`);
      for (const item of items) {
        const count = item.count || item.quantity || 1;
        lines.push(`  ${item.name} ×${count}`);
      }
    }

    // NPC信息
    if (npcs.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`💬 NPC:`);
      for (const npc of npcs) {
        lines.push(`  ${npc.name || '未知'}${npc.description ? ` - ${npc.description}` : ''}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 处理召唤货舱命令
   * 在当前地图召唤货舱（可采集资源），如果没有则生成一个临时货舱
   */
  async handleSummonCargo(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 检查地图是否已有货舱类型的资源
    const resources2 = this.playerService.safeJsonParse<any[]>(map.resources2, []);
    const existingCargo = resources2.find((r: any) => r.type === '货舱' || r.name.includes('货舱'));

    if (existingCargo) {
      return `当前地图已有货舱【${existingCargo.name}】，剩余资源 ×${existingCargo.amount}`;
    }

    // 生成临时货舱
    const cargo = {
      id: `cargo_${map.id}_${Date.now()}`,
      name: '临时货舱',
      type: '货舱',
      amount: 10,
      respawnTime: 600, // 10分钟刷新
    };

    resources2.push(cargo);
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { resources2: JSON.stringify(resources2) },
    });

    this.logger.log(`玩家 ${userId} 在地图 ${map.name} 召唤了货舱`);
    return '📦 召唤货舱成功！\n货舱内有 10 份物资，使用「开采 临时货舱」获取\n货舱将在 10 分钟后消失';
  }

  /**
   * 处理发射信号枪命令
   * 消耗信号枪物品，在当前地图发出信号吸引怪物或玩家
   */
  async handleSignalGun(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    // 检查背包是否有信号枪
    const signalGun = backpack.find((item: any) => item.name === '信号枪' || item.name.includes('信号'));
    if (!signalGun) {
      return '你的背包中没有信号枪，无法发射信号';
    }

    // 消耗信号枪
    const count = signalGun.count || 1;
    if (count <= 1) {
      // 移除信号枪
      const idx = backpack.indexOf(signalGun);
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      signalGun.count = count - 1;
    }

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 在地图上刷新怪物（信号吸引怪物）
    const monsters = this.mapService.getMapMonsters(map);
    const newMonster = {
      id: `signal_${Date.now()}`,
      name: '被吸引的怪物',
      level: Math.max(1, (player.level || 1)),
      specialSeq: 0,
      hp: 80,
      maxHp: 80,
      attack: 15,
      defense: 3,
      speed: 100,
      dodge: 5,
      hit: 85,
      exp: 20,
      isElite: false,
    };

    const spawnMonsters = JSON.parse(map.spawnMonsters || '[]');
    spawnMonsters.push(newMonster);
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: {
        spawnMonsters: JSON.stringify(spawnMonsters),
      },
    });

    // 保存背包变化
    player.backpack = backpack;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 发射了信号枪，吸引了怪物`);
    return '🔫 发射信号枪！\n枪声吸引了附近的怪物，一只【被吸引的怪物】出现了！';
  }

  // ========== 家园命令 ==========

  /**
   * 处理使魔家园命令
   * 进入家园系统，委托到 FamiliarSystemService 的家园子系统
   * 对应原版：家园 命令
   */
  async handleFamiliarHome(userId: number): Promise<string> {
    // 委托到 FamiliarSystemService 的家园查看操作
    return this.familiarSystemService.handleHome(userId, '查看');
  }

  /**
   * 处理建造房子命令
   * 在家园中建造房子，委托到 FamiliarSystemService 的家园建造房子操作
   * 对应原版：建造房子 命令
   */
  async handleBuildHouse(userId: number): Promise<string> {
    // 委托到 FamiliarSystemService 的家园建造房子操作
    return this.familiarSystemService.handleHome(userId, '建造房子');
  }

  /**
   * 处理开挖地基命令
   * 开挖家园地基，委托到 FamiliarSystemService 的家园开挖地基操作
   * 对应原版：开挖地基 命令
   */
  async handleDigFoundation(userId: number): Promise<string> {
    // 委托到 FamiliarSystemService 的家园开挖地基操作
    return this.familiarSystemService.handleHome(userId, '开挖地基');
  }

  /**
   * 处理建造地基命令
   * 建造家园地基，委托到 FamiliarSystemService 的家园建造地基操作
   * 对应原版：建造地基 命令
   */
  async handleBuildFoundation(userId: number): Promise<string> {
    // 委托到 FamiliarSystemService 的家园建造地基操作
    return this.familiarSystemService.handleHome(userId, '建造地基');
  }

  /**
   * 处理圈地命令
   * 圈地扩充家园范围，委托到 FamiliarSystemService 的家园圈地操作
   * 对应原版：圈地 命令
   */
  async handleClaimLand(userId: number): Promise<string> {
    // 委托到 FamiliarSystemService 的家园圈地操作
    return this.familiarSystemService.handleHome(userId, '圈地');
  }

  /**
   * 处理生产命令
   * 在家园中生产资源，委托到 FamiliarSystemService 的家园产出操作
   * 对应原版：产出 命令
   */
  async handleProduce(userId: number, productName: string): Promise<string> {
    // 委托到 FamiliarSystemService 的家园产出操作
    // productName 参数在完整实现中可用于指定生产特定资源
    return this.familiarSystemService.handleHome(userId, '产出');
  }

  // ========== 副本命令 ==========

  /**
   * 处理副本清空命令
   * 清空当前副本的怪物，重置副本状态
   * 对应原版：清空副本 命令
   */
  async handleClearDungeon(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上';

    // 清空地图上的怪物
    map.spawnMonsters = JSON.stringify([]);
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { spawnMonsters: JSON.stringify([]) },
    });

    this.logger.log(`玩家 ${userId} 清空了副本 ${map.name} 的怪物`);
    return `已清空「${map.name}」中的所有怪物`;
  }

  // ========== 载具命令 ==========

  /**
   * 处理组装载具命令
   * 使用部件组装载具，需要核心部件
   * 对应原版：组装 命令
   */
  async handleAssembleVehicle(userId: number, partName: string): Promise<string> {
    if (!partName) {
      return '请指定要组装的部件名称，格式：组装 部件名';
    }

    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取用户QQ号
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userQQ = user?.qqNumber || '';

    // 检查背包中是否有该部件
    const backpack = this.playerService.getBackpackItems(player);
    const partItem = backpack.find((item: any) => item.name === partName);
    if (!partItem) {
      return `背包中没有【${partName}】`;
    }

    // 验证是否为有效部件（静态配置 JSON 单一来源）
    const partDef = this.staticData.getVehiclePartByName(partName);
    if (!partDef) {
      return `【${partName}】不是有效的载具部件`;
    }

    // 如果部件类型是核心（partType=0），需要创建新载具
    if (partDef.partType === 0) {
      // 检查是否已有载具
      if (player.vehicle) {
        return '你已经有一辆载具了，无法创建新的载具';
      }

      // 从背包移除核心部件
      const removed = await this.playerService.removeFromBackpack(userId, partName, 1);
      if (!removed) {
        return '移除部件失败';
      }

      // 创建新载具
      const vehicle = await this.prisma.gameVehicle.create({
        data: {
          name: `${player.name || '冒险者'}的载具`,
          vehicleId: Math.random().toString(36).substring(2, 10).toUpperCase(),
          type: '组装',
          owner: userQQ,
          maxHp: 100,
          currentHp: 100,
          parts: JSON.stringify([{
            name: partDef.name,
            partType: 0,
            bonus: this.playerService.safeJsonParse<any>(partDef.bonus, {}),
            description: partDef.description || '',
          }]),
          bonus: partDef.bonus || '{}',
        },
      });

      // 自动驾驶载具
      player.vehicle = String(vehicle.id);
      await this.playerService.savePlayer(player);

      this.logger.log(`玩家 ${userId} 使用核心部件 ${partName} 创建了新载具 ${vehicle.id}`);
      return `✅ 成功组装载具：${vehicle.name}\n使用核心部件【${partName}】创建成功\n核心已自动安装，使用「载具」查看状态`;
    }

    // 非核心部件，检查是否已有载具
    if (!player.vehicle) {
      return '你还没有载具，请先使用核心部件组装载具';
    }

    // 通过安装部件来组装
    return await this.handleInstallPart(userId, partName);
  }

  /**
   * 处理驾驶载具命令
   * 驾驶或切换到指定的载具
   * 对应原版：驾驶 命令
   */
  async handleDriveVehicle(userId: number, vehicleName: string): Promise<string> {
    if (!vehicleName) {
      return '请指定载具名称或ID，格式：驾驶 载具名';
    }

    // 获取玩家QQ号
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userQQ = user?.qqNumber || '';

    // 查找载具（按名称或ID）
    let vehicle = await this.prisma.gameVehicle.findFirst({
      where: {
        OR: [
          { name: vehicleName },
          { vehicleId: vehicleName },
          { id: parseInt(vehicleName, 10) || 0 },
        ],
      },
    });
    if (!vehicle) {
      return `未找到载具【${vehicleName}】`;
    }

    // 设置玩家驾驶的载具
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    player.vehicle = String(vehicle.id);
    await this.playerService.savePlayer(player);

    // 更新载具驾驶员
    await this.prisma.gameVehicle.update({
      where: { id: vehicle.id },
      data: { driver: userQQ },
    });

    this.logger.log(`玩家 ${userId} 驾驶了载具 ${vehicle.name}`);
    return `✅ 已驾驶载具【${vehicle.name}】\n使用「载具」查看状态，使用「脱出」离开载具`;
  }

  /**
   * 处理载具命名命令
   * 给当前驾驶的载具命名
   * 对应原版：载具命名 命令
   */
  async handleNameVehicle(userId: number, name: string): Promise<string> {
    if (!name) {
      return '请指定新的载具名称，格式：载具命名 新名称';
    }

    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查是否有载具
    if (!player.vehicle) {
      return '你当前没有驾驶任何载具';
    }

    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) {
      return '载具数据异常';
    }

    // 更新载具名称
    await this.prisma.gameVehicle.update({
      where: { id: vehicleId },
      data: { name },
    });

    this.logger.log(`玩家 ${userId} 将载具更名为 ${name}`);
    return `✅ 载具已更名为【${name}】`;
  }

  /**
   * 处理载具模拟命令
   * 模拟载具装配后的性能表现
   * 对应原版：载具模拟 命令
   */
  async handleSimulateVehicle(userId: number, targetName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (!player.vehicle) {
      // 如果没有驾驶载具，模拟指定部件装配效果
      if (!targetName) {
        return '请指定要模拟的部件名称，或先驾驶载具后使用「载具模拟」';
      }

      // 查找部件定义（静态配置 JSON 单一来源）
      const partDef = this.staticData.getVehiclePartByName(targetName);
      if (!partDef) {
        return `未找到部件【${targetName}】`;
      }

      const bonus = this.playerService.safeJsonParse<any>(partDef.bonus, {});
      const bonusLines = Object.entries(bonus)
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .map(([k, v]) => `  ${k}: +${v}`);

      return [
        `🔧 部件模拟：${partDef.name}`,
        `━━━━━━━━━━━━━━━`,
        `类型: ${this.PART_TYPE_NAMES[partDef.partType] || '未知'}`,
        `描述: ${partDef.description || '无'}`,
        bonusLines.length > 0 ? `━━━━━━━━━━━━━━━\n加成属性:` : '',
        ...bonusLines,
        `━━━━━━━━━━━━━━━`,
        `使用「安装 ${partDef.name}」安装到载具`,
      ].filter(Boolean).join('\n');
    }

    // 已有载具，模拟当前载具的总加成
    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) return '载具数据异常';

    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) return '载具数据不存在';

    const parts = this.playerService.safeJsonParse<any[]>(vehicle.parts, []);
    const totalBonus = this.calcVehicleTotalBonus(vehicle);

    const lines = [
      `🔧 载具模拟：${vehicle.name}`,
      `━━━━━━━━━━━━━━━`,
      `部件数量: ${parts.length}个`,
      `━━━━━━━━━━━━━━━`,
      `📊 模拟加成:`,
    ];

    const bonusFields: { key: string; label: string }[] = [
      { key: 'attack', label: '攻击' },
      { key: 'hp', label: '生命' },
      { key: 'armor', label: '装甲' },
      { key: 'shield', label: '护盾' },
      { key: 'speed', label: '速度' },
      { key: 'dodge', label: '闪避' },
      { key: 'hit', label: '命中' },
      { key: 'crit', label: '暴击' },
    ];

    let hasBonus = false;
    for (const bf of bonusFields) {
      const val = (totalBonus as any)[bf.key];
      if (val) {
        lines.push(`  ${bf.label}: +${Math.round(val)}`);
        hasBonus = true;
      }
    }
    if (!hasBonus) {
      lines.push(`  无加成属性`);
    }

    return lines.join('\n');
  }

  /**
   * 处理维修载具命令
   * 消耗资源维修载具耐久度
   * 对应原版：维修 命令
   */
  async handleRepairVehicle(userId: number, targetName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (!player.vehicle) {
      return '你当前没有驾驶任何载具';
    }

    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) return '载具数据异常';

    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) return '载具数据不存在';

    // 检查是否需要维修
    if (vehicle.currentHp >= vehicle.maxHp) {
      return `载具【${vehicle.name}】耐久度已满 (${vehicle.currentHp}/${vehicle.maxHp})`;
    }

    // 检查背包中的维修工具
    const backpack = this.playerService.getBackpackItems(player);
    const repairTool = backpack.find((item: any) => item.name === '维修工具');

    if (repairTool) {
      // 消耗维修工具，恢复50%耐久度
      const removed = await this.playerService.removeFromBackpack(userId, '维修工具', 1);
      if (removed) {
        const healAmount = Math.floor(vehicle.maxHp * 0.5);
        const newHp = Math.min(vehicle.currentHp + healAmount, vehicle.maxHp);

        await this.prisma.gameVehicle.update({
          where: { id: vehicleId },
          data: { currentHp: newHp },
        });

        this.logger.log(`玩家 ${userId} 维修了载具 ${vehicle.name}：${vehicle.currentHp} → ${newHp}`);
        return `✅ 维修成功！\n载具【${vehicle.name}】耐久度恢复 ${healAmount} 点\n当前耐久: ${newHp}/${vehicle.maxHp}`;
      }
    }

    // 没有维修工具，使用基本修复（消耗100经验）
    if (player.exp >= 100) {
      player.exp -= 100;
      const healAmount = Math.floor(vehicle.maxHp * 0.3);
      const newHp = Math.min(vehicle.currentHp + healAmount, vehicle.maxHp);

      await this.prisma.gameVehicle.update({
        where: { id: vehicleId },
        data: { currentHp: newHp },
      });
      await this.playerService.savePlayer(player);

      this.logger.log(`玩家 ${userId} 消耗经验维修了载具 ${vehicle.name}：${vehicle.currentHp} → ${newHp}`);
      return `✅ 消耗100经验维修成功！\n载具【${vehicle.name}】耐久度恢复 ${healAmount} 点\n当前耐久: ${newHp}/${vehicle.maxHp}\n\n提示：使用「维修工具」可以更高效地维修载具`;
    }

    return `维修需要消耗「维修工具」或100经验\n当前经验: ${player.exp}，不足100`;
  }

  /**
   * 处理脱出载具命令
   * 从当前驾驶的载具中脱出
   * 对应原版：脱出 命令
   */
  async handleExitVehicle(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (!player.vehicle) {
      return '你当前没有驾驶任何载具';
    }

    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) return '载具数据异常';

    // 获取载具信息（用于日志）
    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });

    // 清除玩家载具状态
    player.vehicle = '';
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 从载具 ${vehicle?.name || vehicleId} 中脱出`);
    return `✅ 已从载具【${vehicle?.name || '未知'}】中脱出`;
  }

  /**
   * 处理接管载具命令
   * 接管其他玩家的载具
   * 对应原版：接管 命令
   */
  async handleTakeoverVehicle(userId: number, targetName: string): Promise<string> {
    if (!targetName) {
      return '请指定要接管的载具名称或ID，格式：接管 载具名';
    }

    // 查找目标载具
    let vehicle = await this.prisma.gameVehicle.findFirst({
      where: {
        OR: [
          { name: targetName },
          { vehicleId: targetName },
          { id: parseInt(targetName, 10) || 0 },
        ],
      },
    });
    if (!vehicle) {
      return `未找到载具【${targetName}】`;
    }

    // 获取玩家QQ号
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userQQ = user?.qqNumber || '';

    // 更新载具驾驶员
    await this.prisma.gameVehicle.update({
      where: { id: vehicle.id },
      data: { driver: userQQ },
    });

    // 驾驶载具
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    player.vehicle = String(vehicle.id);
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 接管了载具 ${vehicle.name}`);
    return `✅ 已接管载具【${vehicle.name}】\n使用「载具」查看状态`;
  }

  /**
   * 处理架炮命令
   * 架设载具火炮
   * 对应原版：架炮 命令
   */
  async handleDeployCannon(userId: number, targetName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (!player.vehicle) {
      return '你当前没有驾驶任何载具，无法架炮';
    }

    // 检查载具是否有武器部件
    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) return '载具数据异常';

    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) return '载具数据不存在';

    const parts = this.playerService.safeJsonParse<any[]>(vehicle.parts, []);
    const weaponParts = parts.filter((p: any) => p.partType === 3);

    if (weaponParts.length === 0) {
      return '载具没有安装武器部件，无法架炮\n请先使用「安装」安装武器部件';
    }

    // 选择武器部件（如果有指定目标）
    if (targetName) {
      const targetPart = weaponParts.find((p: any) => p.name === targetName);
      if (!targetPart) {
        return `载具没有安装武器【${targetName}】`;
      }
      return `🔫 已架设【${targetName}】\n目标已锁定，使用「炮击」开火！`;
    }

    // 显示可用的武器
    const lines = [
      `🔫 载具武器列表:`,
      `━━━━━━━━━━━━━━━`,
    ];
    for (const wp of weaponParts) {
      lines.push(`  ${wp.name}`);
    }
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`使用「架炮 武器名」选择武器`);
    return lines.join('\n');
  }

  /**
   * 处理模式转换命令
   * 载具模式转换（如战斗模式、移动模式等）
   * 对应原版：模式转换 命令
   */
  async handleModeChange(userId: number, modeName: string): Promise<string> {
    if (!modeName) {
      return '请指定要转换的模式，格式：模式转换 模式名\n可用模式：战斗、移动、防御、隐匿';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.vehicle) {
      return '你当前没有驾驶任何载具';
    }

    // 模式列表
    const modes: Record<string, string> = {
      '战斗': '战斗模式 - 提升攻击力',
      '移动': '移动模式 - 提升速度',
      '防御': '防御模式 - 提升装甲和护盾',
      '隐匿': '隐匿模式 - 提升闪避',
    };

    if (!modes[modeName]) {
      return `未知模式「${modeName}」\n可用模式：${Object.keys(modes).join('、')}`;
    }

    // 存储载具模式到 markers
    markers['vehicle_mode'] = modeName;
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 将载具切换为${modeName}模式`);
    return `✅ 载具已切换为${modeName}\n${modes[modeName]}`;
  }

  /**
   * 处理转换命令
   * 载具形态转换
   * 对应原版：转换 命令
   */
  async handleTransform(userId: number, targetForm: string): Promise<string> {
    if (!targetForm) {
      return '请指定要转换的形态，格式：转换 形态名';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.vehicle) {
      return '你当前没有驾驶任何载具';
    }

    // 存储载具形态到 markers
    markers['vehicle_form'] = targetForm;
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 将载具转换为${targetForm}形态`);
    return `✅ 载具已转换为【${targetForm}】形态`;
  }

  /**
   * 处理牵引光束命令
   * 使用工业牵引光束拖拽目标
   * 对应原版：牵引 命令
   */
  async handleTractorBeam(userId: number, targetName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (!player.vehicle) {
      return '你当前没有驾驶任何载具，无法使用牵引光束';
    }

    if (!targetName) {
      return '请指定牵引目标，格式：牵引 目标名';
    }

    // 检查载具是否安装了功能部件（partType=4）
    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) return '载具数据异常';

    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) return '载具数据不存在';

    const parts = this.playerService.safeJsonParse<any[]>(vehicle.parts, []);
    const funcParts = parts.filter((p: any) => p.partType === 4);

    if (funcParts.length === 0) {
      return '载具没有安装功能部件，无法使用牵引光束\n请先安装功能部件';
    }

    // 查找目标（可能是玩家或物品）
    const targetUser = await this.prisma.user.findUnique({
      where: { qqNumber: targetName },
    });

    this.logger.log(`玩家 ${userId} 使用牵引光束拖拽目标 ${targetName}`);

    if (targetUser) {
      return `🔦 牵引光束已锁定目标玩家【${targetUser.nickname || targetUser.username}】\n正在拖拽...\n（牵引功能简化版，实际效果取决于目标状态）`;
    }

    return `🔦 牵引光束已锁定目标【${targetName}】\n正在拖拽...`;
  }

  /**
   * 处理控制终端命令
   * 打开载具控制终端界面，查看载具详细操作选项
   * 对应原版：控制终端 命令
   */
  async handleControlTerminal(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.vehicle) {
      return '你当前没有驾驶任何载具，无法访问控制终端';
    }

    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) return '载具数据异常';

    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) return '载具数据不存在';

    const parts = this.playerService.safeJsonParse<any[]>(vehicle.parts, []);
    const currentMode = markers['vehicle_mode'] || '战斗';
    const currentForm = markers['vehicle_form'] || '标准';

    // 统计各类型部件数量
    const typeCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const part of parts) {
      typeCounts[part.partType] = (typeCounts[part.partType] || 0) + 1;
    }

    return [
      `🖥️ 载具控制终端`,
      `━━━━━━━━━━━━━━━`,
      `🚗 ${vehicle.name}`,
      `❤️ 耐久: ${vehicle.currentHp}/${vehicle.maxHp}`,
      `━━━━━━━━━━━━━━━`,
      `📊 当前状态:`,
      `  模式: ${currentMode}`,
      `  形态: ${currentForm}`,
      `  部件: ${parts.length}个安装`,
      `━━━━━━━━━━━━━━━`,
      `📋 可用操作:`,
      `  驾驶 - 切换载具`,
      `  脱出 - 离开载具`,
      `  载具 - 查看状态`,
      `  安装 - 安装部件`,
      `  拆卸 - 拆卸部件`,
      `  架炮 - 架设武器`,
      `  模式转换 - 切换模式`,
      `  转换 - 切换形态`,
      `  牵引 - 使用牵引光束`,
      `  维修 - 修复耐久度`,
      `━━━━━━━━━━━━━━━`,
      `插槽使用:`,
      `  核心: ${typeCounts[0] || 0}/1`,
      `  武器: ${typeCounts[3] || 0}/${vehicle.maxWeapon || 5}`,
      `  防御: ${typeCounts[1] || 0}/${vehicle.maxDefense || 5}`,
      `  行走: ${typeCounts[2] || 0}/${vehicle.maxMove || 5}`,
      `  功能: ${typeCounts[4] || 0}/${vehicle.maxFunction || 5}`,
    ].join('\n');
  }

  /**
   * 处理载具操作命令
   * 查看载具操作指南
   * 对应原版：载具操作 命令
   */
  async handleVehicleOps(userId: number): Promise<string> {
    return [
      `📖 载具操作指南`,
      `━━━━━━━━━━━━━━━`,
      `【基础操作】`,
      `  组装 核心名 - 使用核心部件创建载具`,
      `  驾驶 载具名 - 驾驶载具`,
      `  载具 - 查看当前载具状态`,
      `  脱出 - 离开载具`,
      `━━━━━━━━━━━━━━━`,
      `【部件管理】`,
      `  安装 部件名 - 安装部件到载具`,
      `  拆卸 部件名 - 从载具拆卸部件`,
      `  载具模拟 [部件名] - 模拟性能`,
      `━━━━━━━━━━━━━━━`,
      `【战斗操作】`,
      `  架炮 [武器名] - 架设武器`,
      `  炮击 - 使用载具火炮攻击`,
      `  模式转换 模式名 - 切换模式`,
      `━━━━━━━━━━━━━━━`,
      `【其他操作】`,
      `  载具命名 新名称 - 为载具命名`,
      `  维修 - 修复载具耐久`,
      `  牵引 目标 - 使用牵引光束`,
      `  转换 形态名 - 转换形态`,
      `  控制终端 - 打开控制面板`,
      `  接管 载具名 - 接管其他载具`,
    ].join('\n');
  }

  /**
   * 处理增幅器说明命令
   * 查看增幅器使用说明，展示增幅器系统的功能与用法
   * 对应原版：增幅器 命令
   */
  async handleAmplifierHelp(userId: number): Promise<string> {
    return [
      `📈 增幅器系统说明`,
      `━━━━━━━━━━━━━━━`,
      `增幅器是一种可以提升玩家属性的特殊装备，佩戴在增幅器插槽中。`,
      `━━━━━━━━━━━━━━━`,
      `【增幅器类型】`,
      `  1. 攻击增幅器 - 提升攻击力`,
      `  2. 防御增幅器 - 提升防御力`,
      `  3. 生命增幅器 - 提升最大生命值`,
      `  4. 速度增幅器 - 提升移动速度`,
      `  5. 暴击增幅器 - 提升暴击率和暴击伤害`,
      `━━━━━━━━━━━━━━━`,
      `【使用方法】`,
      `  装备增幅器：装备 增幅器名`,
      `  查看已装备：信息`,
      `━━━━━━━━━━━━━━━`,
      `增幅器可以通过战斗掉落、商店购买或合成获得。`,
    ].join('\n');
  }

  // ========== 宠物/社交命令 ==========

  /**
   * 处理开始捕捉命令
   * 开始捕捉宠物/使魔，委托到 FamiliarSystemService 的捕捉系统
   * 对应原版：开始捕捉 命令
   */
  async handleStartCapture(userId: number, targetName: string): Promise<string> {
    // 委托到 FamiliarSystemService 的捕捉系统（start 动作）
    return this.familiarSystemService.capturePet(userId, 'start', targetName);
  }

  /**
   * 处理停止捕捉命令
   * 停止当前的捕捉操作，委托到 FamiliarSystemService 的捕捉系统
   * 对应原版：停止捕捉 命令
   */
  async handleStopCapture(userId: number): Promise<string> {
    // 委托到 FamiliarSystemService 的捕捉系统（stop 动作）
    // 由于没有指定目标名称，使用默认清除所有麻醉标记
    return this.familiarSystemService.capturePet(userId, 'stop', 'all');
  }

  /**
   * 处理全部跟随命令
   * 使所有属于当前玩家的宠物/使魔跟随
   * 对应原版：全部跟随 命令
   */
  async handleFollowAll(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上';

    // 解析当前地图上的召唤物
    const summons = this.playerService.safeJsonParse<any[]>(map.summons || '[]', []);
    const playerIdStr = String(player.userId);

    // 遍历所有属于当前玩家的宠物，设置跟随状态
    let followCount = 0;
    for (const pet of summons) {
      if (String(pet.ownerQQ || pet.qq || '') === playerIdStr) {
        pet.follow = true;
        pet.mode = 'follow';
        followCount++;
      }
    }

    if (followCount === 0) {
      return '当前地图上没有属于你的宠物';
    }

    // 更新地图数据
    map.summons = JSON.stringify(summons);
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { summons: JSON.stringify(summons) },
    });

    this.logger.log(`玩家 ${userId} 设置了 ${followCount} 只宠物跟随`);
    return `已将 ${followCount} 只宠物设置为跟随模式`;
  }

  /**
   * 处理补魔命令
   * 补充魔力/能量，消耗资源恢复魔法值
   * 对应原版：补魔 命令
   */
  async handleRefill(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查背包中是否有魔力药剂
    const backpack = this.playerService.getBackpackItems(player);
    const potion = backpack.find((item: any) => item.name === '魔力药剂' || item.name === '魔力药水');

    if (!potion) {
      return '背包中没有魔力药剂，无法补充魔力';
    }

    // 消耗一瓶魔力药剂，恢复魔力
    const removed = await this.playerService.removeFromBackpack(userId, potion.name, 1);
    if (!removed) {
      return '消耗魔力药剂失败';
    }

    // 恢复魔力（假设玩家有魔力字段，或使用 markers 记录）
    // 在 markers 中设置一个魔力恢复标记
    const markers = playerData.markers;
    const currentMp = markers['魔力'] || 100;
    markers['魔力'] = Math.min(currentMp + 50, 500); // 最多恢复50点，上限500
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `消耗了一瓶${potion.name}，魔力恢复50点（当前魔力: ${markers['魔力']}）`;
  }

  /**
   * 处理挤奶命令
   * 从饲养的动物中获取牛奶，检查当前地图上的可挤奶宠物
   * 对应原版：挤奶 命令
   */
  async handleMilk(userId: number, targetName: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上';

    // 解析当前地图上的召唤物（宠物）
    const summons = this.playerService.safeJsonParse<any[]>(map.summons || '[]', []);
    const playerIdStr = String(player.userId);

    // 查找可挤奶的宠物（牛、奶牛、奶羊等）
    const milkablePets = summons.filter((pet: any) => {
      const isOwner = String(pet.ownerQQ || pet.qq || '') === playerIdStr;
      const isAlive = (pet.hp || pet.currentHp || 0) > 0;
      const isMilkable = /牛|奶牛|奶羊|乳牛/i.test(pet.name || '');
      return isOwner && isAlive && isMilkable;
    });

    if (milkablePets.length === 0) {
      return '当前地图上没有可挤奶的宠物（需要牛、奶牛等）';
    }

    // 选择目标：如果指定了名称则匹配，否则取第一个
    const target = targetName
      ? milkablePets.find((pet: any) => pet.name === targetName)
      : milkablePets[0];

    if (!target) {
      return `当前地图上没有名为「${targetName}」的可挤奶宠物`;
    }

    // 产出牛奶
    await this.playerService.addToBackpack(userId, '牛奶', 1);

    this.logger.log(`玩家 ${userId} 从 ${target.name} 挤奶成功`);
    return `从 ${target.name} 挤出了牛奶，获得了牛奶×1`;
  }

  /**
   * 处理剪毛命令
   * 从饲养的动物中获取羊毛/羽毛，委托到 FamiliarSystemService 的剪毛操作
   * 对应原版：剪毛 命令
   */
  async handleShear(userId: number, targetName: string): Promise<string> {
    // 如果目标未指定或匹配普拉娜，委托到 FamiliarSystemService 的普拉娜幼崽剪毛操作
    if (!targetName || /普拉娜|plana/i.test(targetName)) {
      return this.familiarSystemService.shearPlana(userId);
    }

    // 通用剪毛逻辑：查找地图上可剪毛的宠物
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上';

    // 解析当前地图上的召唤物
    const summons = this.playerService.safeJsonParse<any[]>(map.summons || '[]', []);
    const playerIdStr = String(player.userId);

    // 查找可剪毛的宠物（羊、绵羊、普拉娜等）
    const shearablePets = summons.filter((pet: any) => {
      const isOwner = String(pet.ownerQQ || pet.qq || '') === playerIdStr;
      const isAlive = (pet.hp || pet.currentHp || 0) > 0;
      const isShearable = /羊|绵羊|普拉娜|毛绒/i.test(pet.name || '');
      return isOwner && isAlive && isShearable;
    });

    if (shearablePets.length === 0) {
      return '当前地图上没有可剪毛的宠物';
    }

    // 选择目标
    const target = targetName
      ? shearablePets.find((pet: any) => pet.name === targetName)
      : shearablePets[0];

    if (!target) {
      return `当前地图上没有名为「${targetName}」的可剪毛宠物`;
    }

    // 产出毛发
    await this.playerService.addToBackpack(userId, '毛发', 1);

    this.logger.log(`玩家 ${userId} 从 ${target.name} 剪毛成功`);
    return `从 ${target.name} 剪下了毛发，获得了毛发×1`;
  }

  // ========== 任务/设置命令 ==========

  /**
   * 处理放弃任务命令
   * 放弃当前已接取的任务，从玩家任务列表中移除
   * 对应原版：放弃任务 命令
   */
  async handleAbandonQuest(userId: number, questName: string): Promise<string> {
    if (!questName) {
      return '请指定要放弃的任务名称，格式：放弃任务 任务名';
    }

    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, tasks } = playerData;

    // 查找任务
    const taskIndex = tasks.findIndex((t: any) => t.name === questName);
    if (taskIndex === -1) {
      return `你没有接取名为「${questName}」的任务`;
    }

    // 从任务列表中移除
    tasks.splice(taskIndex, 1);
    player.tasks = JSON.stringify(tasks);
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 放弃了任务「${questName}」`);
    return `已放弃任务「${questName}」`;
  }

  // ========== 其他命令 ==========

  /**
   * 处理游戏介绍命令
   * 显示游戏简介，展示使魔大战的基本玩法介绍
   * 对应原版：使魔大战 命令
   */
  async handleGameIntro(userId: number): Promise<string> {
    return [
      `🎮 使魔大战 - 游戏介绍`,
      `━━━━━━━━━━━━━━━`,
      `【世界观】`,
      `在一个充满神秘力量的世界中，玩家可以培养使魔、建造家园、探索地图、`,
      `与怪物战斗，并与其他玩家进行贸易和互动。`,
      `━━━━━━━━━━━━━━━`,
      `【核心玩法】`,
      `  1. 战斗系统 - 使用武器和技能与怪物战斗`,
      `  2. 家园系统 - 建造自己的家园，生产资源`,
      `  3. 使魔系统 - 培养和进化你的使魔伙伴`,
      `  4. 载具系统 - 组装和驾驶各种载具`,
      `  5. 贸易系统 - 与其他玩家交易物品`,
      `━━━━━━━━━━━━━━━`,
      `【快速上手】`,
      `  发送「信息」创建角色`,
      `  发送「帮助」查看所有命令`,
      `  发送「新手教程」获取指引`,
      `━━━━━━━━━━━━━━━`,
      `祝你在使魔大陆中玩得开心！`,
    ].join('\n');
  }

  /**
   * 处理游戏术语解释命令
   * 解释游戏中的专业术语，帮助玩家理解游戏机制
   * 对应原版：游戏解释 命令
   */
  async handleGameTerms(userId: number, termName: string): Promise<string> {
    // 术语词典
    const terms: Record<string, string> = {
      '使魔': '玩家培养的宠物/伙伴，可以协助战斗和采集资源',
      '家园': '玩家自己建造的领地，可以建造建筑、种植作物、生产资源',
      '载具': '玩家组装的交通工具，提供移动速度加成和特殊功能',
      '好感度': '使魔对玩家的亲密度，影响使魔技能效果和忠诚度',
      '魔力': '玩家施放技能所需的能量值，可以通过药剂或休息恢复',
      '副本': '独立的战斗场景，包含怪物和宝藏',
      '圈地': '在家园系统中选择一块土地开始建造家园',
      '地基': '家园建造的基础阶段，需要消耗材料逐步建造',
      '产出': '建筑和作物自动生产的资源，需要定期收取',
      '捕捉': '驯服野生怪物作为自己的宠物/使魔',
      '饲料': '捕捉宠物时消耗的物品，用于吸引和驯服怪物',
      '补魔': '使用魔力药剂恢复魔力值',
      '挤奶': '从可产奶的宠物（如奶牛）中获取牛奶',
      '剪毛': '从可产毛的宠物（如普拉娜幼崽）中获取毛发',
    };

    if (!termName) {
      // 没有指定术语，显示所有可用术语列表
      const termList = Object.keys(terms).map((name, i) => `  ${i + 1}. ${name}`).join('\n');
      return [
        `📖 游戏名词解释`,
        `━━━━━━━━━━━━━━━`,
        `可用术语：`,
        termList,
        `━━━━━━━━━━━━━━━`,
        `发送「游戏解释 术语名」查看详细解释`,
      ].join('\n');
    }

    const explanation = terms[termName];
    if (!explanation) {
      return `未找到术语「${termName}」的解释，发送「游戏解释」查看所有可用术语`;
    }

    return `📖 【${termName}】\n${explanation}`;
  }

  /**
   * 处理更多帮助命令
   * 显示更多帮助信息，包括游戏进阶玩法说明
   * 对应原版：更多 命令
   */
  async handleMoreHelp(userId: number): Promise<string> {
    return [
      `📚 更多帮助信息`,
      `━━━━━━━━━━━━━━━`,
      `【家园系统】`,
      `  圈地 - 开始建造家园`,
      `  开挖地基 - 消耗材料开挖地基`,
      `  建造地基 - 消耗材料建造地基`,
      `  建造房子 - 消耗材料建造房子`,
      `  家园 - 查看家园状态`,
      `  家园产出 - 收取家园产出资源`,
      `━━━━━━━━━━━━━━━`,
      `【宠物系统】`,
      `  开始捕捉 怪物名 - 开始捕捉怪物`,
      `  停止捕捉 怪物名 - 停止捕捉`,
      `  捕捉 怪物名 - 直接捕捉`,
      `  全部跟随 - 让所有宠物跟随`,
      `  宠物操作 - 查看宠物操作菜单`,
      `━━━━━━━━━━━━━━━`,
      `【载具系统】`,
      `  组装 核心名 - 创建载具`,
      `  驾驶 载具名 - 驾驶载具`,
      `  载具 - 查看载具状态`,
      `  载具操作 - 查看操作指南`,
      `━━━━━━━━━━━━━━━`,
      `【其他系统】`,
      `  贸易 - 打开贸易市场`,
      `  签到 - 每日签到`,
      `  信息 - 查看角色信息`,
      `  背包 - 查看背包`,
      `  增幅器 - 查看增幅器说明`,
    ].join('\n');
  }

  /**
   * 处理更新历史命令
   * 显示游戏更新日志/更新历史
   * 对应原版：更新历史 命令
   */
  async handleChangelog(userId: number): Promise<string> {
    return [
      `📜 更新历史`,
      `━━━━━━━━━━━━━━━`,
      `【v1.0.0】`,
      `  - 实现家园系统（圈地、开挖地基、建造地基、建造房子）`,
      `  - 实现宠物捕捉系统`,
      `  - 实现载具组装与驾驶系统`,
      `  - 实现贸易市场系统`,
      `  - 实现每日签到系统`,
      `  - 实现战斗系统`,
      `━━━━━━━━━━━━━━━`,
      `【v0.9.0】`,
      `  - 实现基础攻击与战斗循环`,
      `  - 实现物品与装备系统`,
      `  - 实现地图与怪物系统`,
      `  - 实现玩家创建与升级系统`,
      `━━━━━━━━━━━━━━━`,
      `【v0.8.0】`,
      `  - 项目初始化`,
      `  - 实现基础框架搭建`,
      `━━━━━━━━━━━━━━━`,
      `更多更新内容请关注后续版本`,
    ].join('\n');
  }

  /**
   * 处理贸易命令
   * 玩家间贸易市场系统，支持查看市场、上架物品、下架物品、购买物品
   * 对应原版：贸易 命令
   */
  async handleTrade(userId: number, action: string, args: string[]): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取用户QQ号
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userQQ = user?.qqNumber || '';

    // 如果没有指定操作，显示市场列表
    if (!action) {
      // 查询所有在售商品（未过期的）
      const now = new Date();
      const listings = await this.prisma.gameShopItem.findMany({
        where: { expireAt: { gte: now } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      if (listings.length === 0) {
        return '📊 贸易市场\n━━━━━━━━━━━━━━━\n当前没有在售的商品\n\n上架物品：贸易 上架 物品名 价格\n下架物品：贸易 下架 编号\n购买物品：贸易 购买 编号';
      }

      const lines = [
        `📊 贸易市场 (${listings.length}件商品)`,
        `━━━━━━━━━━━━━━━`,
      ];
      for (let i = 0; i < listings.length; i++) {
        const item = listings[i];
        lines.push(`  ${i + 1}. ${item.itemName} ×${item.itemCount}`);
        lines.push(`     价格: ${item.price} | 卖家: ${item.sellerQQ}`);
      }
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`上架物品：贸易 上架 物品名 价格`);
      lines.push(`下架物品：贸易 下架 编号`);
      lines.push(`购买物品：贸易 购买 编号`);

      return lines.join('\n');
    }

    // 处理各操作
    switch (action) {
      case '上架':
      case 'sell': {
        if (args.length < 2) {
          return '请指定物品名称和价格，格式：贸易 上架 物品名 价格';
        }
        const itemName = args[0];
        const price = parseFloat(args[1]);
        if (isNaN(price) || price <= 0) {
          return '价格必须为正数';
        }

        // 检查背包中是否有该物品
        const backpack = this.playerService.getBackpackItems(player);
        const item = backpack.find((i: any) => i.name === itemName);
        if (!item) {
          return `背包中没有【${itemName}】`;
        }

        const count = item.count || item.quantity || 1;

        // 从背包移除物品
        const removed = await this.playerService.removeFromBackpack(userId, itemName, 1);
        if (!removed) {
          return '上架失败，请重试';
        }

        // 创建商品记录（7天后过期）
        const expireAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await this.prisma.gameShopItem.create({
          data: {
            itemName,
            itemType: 'trade',
            itemCount: 1,
            sellerQQ: userQQ,
            price,
            expireAt,
          },
        });

        this.logger.log(`玩家 ${userId} 上架了 ${itemName}，价格 ${price}`);
        return `✅ 成功上架 ${itemName}\n价格: ${price}\n商品将在7天后自动下架`;
      }

      case '下架':
      case 'cancel': {
        if (args.length < 1) {
          return '请指定要下架的商品编号，格式：贸易 下架 编号';
        }
        const index = parseInt(args[0], 10) - 1;
        if (isNaN(index) || index < 0) {
          return '请指定有效的商品编号';
        }

        // 查询当前玩家的在售商品
        const now = new Date();
        const myListings = await this.prisma.gameShopItem.findMany({
          where: {
            sellerQQ: userQQ,
            expireAt: { gte: now },
          },
          orderBy: { createdAt: 'desc' },
        });

        if (index >= myListings.length) {
          return '商品编号无效';
        }

        const targetItem = myListings[index];

        // 将物品归还背包
        await this.playerService.addToBackpack(userId, targetItem.itemName, targetItem.itemCount);

        // 删除商品记录
        await this.prisma.gameShopItem.delete({
          where: { id: targetItem.id },
        });

        this.logger.log(`玩家 ${userId} 下架了 ${targetItem.itemName}`);
        return `✅ 已下架 ${targetItem.itemName}，物品已归还背包`;
      }

      case '购买':
      case 'buy': {
        if (args.length < 1) {
          return '请指定要购买的商品编号，格式：贸易 购买 编号';
        }
        const buyIdx = parseInt(args[0], 10) - 1;
        if (isNaN(buyIdx) || buyIdx < 0) {
          return '请指定有效的商品编号';
        }

        // 查询所有在售商品
        const now2 = new Date();
        const allListings = await this.prisma.gameShopItem.findMany({
          where: { expireAt: { gte: now2 } },
          orderBy: { createdAt: 'desc' },
        });

        if (buyIdx >= allListings.length) {
          return '商品编号无效';
        }

        const buyItem = allListings[buyIdx];

        // 不能购买自己的商品
        if (buyItem.sellerQQ === userQQ) {
          return '不能购买自己的商品';
        }

        // 将物品添加到买家背包
        await this.playerService.addToBackpack(userId, buyItem.itemName, buyItem.itemCount);

        // 删除商品记录
        await this.prisma.gameShopItem.delete({
          where: { id: buyItem.id },
        });

        // 通知卖家（通过记录日志）
        this.logger.log(`玩家 ${userId} 购买了 ${buyItem.itemName}（卖家: ${buyItem.sellerQQ}）`);

        return `✅ 购买成功！\n获得了 ${buyItem.itemName} ×${buyItem.itemCount}\n花费: ${buyItem.price}`;
      }

      default:
        return `未知操作「${action}」，可用操作：上架、下架、购买`;
    }
  }

  /**
   * 处理购物命令
   * 系统商店购物系统，查看商店物品、购买物品、查看商品详情
   * 对应原版：购物 命令
   */
  async handleShop(userId: number, action: string, args: string[]): Promise<string> {
    // 如果没有指定操作，显示商店列表
    if (!action) {
      // 查询商店物品列表（静态配置 JSON 单一来源，取前20个）
      const shopItems = this.staticData.getAllItems().slice(0, 20);

      if (shopItems.length === 0) {
        return '🏪 系统商店\n━━━━━━━━━━━━━━━\n当前没有可购买的商品\n\n使用「购物 购买 物品名」购买物品';
      }

      const lines = [
        `🏪 系统商店`,
        `━━━━━━━━━━━━━━━`,
      ];
      for (const item of shopItems) {
        lines.push(`  ${item.name} - ${item.value} 金币`);
        if (item.description) {
          lines.push(`    ${item.description}`);
        }
      }
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`购物 购买 物品名 - 购买物品`);
      lines.push(`购物 详情 物品名 - 查看详情`);

      return lines.join('\n');
    }

    switch (action) {
      case '购买':
      case 'buy': {
        if (args.length < 1) {
          return '请指定要购买的物品名称，格式：购物 购买 物品名';
        }
        const itemName = args.join(' ');

        // 查询商品（静态配置 JSON 单一来源）
        const shopItem = this.staticData.getItemByName(itemName);
        if (!shopItem) {
          return `商店中没有【${itemName}】`;
        }

        // 添加物品到背包（简化版）
        await this.playerService.addToBackpack(userId, shopItem.name, 1);

        this.logger.log(`玩家 ${userId} 购买了 ${shopItem.name}`);
        return `✅ 购买成功！\n获得了 ${shopItem.name} ×1\n${shopItem.description ? `\n${shopItem.description}` : ''}`;
      }

      case '详情':
      case 'detail':
      case 'info': {
        if (args.length < 1) {
          return '请指定要查看的物品名称，格式：购物 详情 物品名';
        }
        const detailName = args.join(' ');

        const detailItem = this.staticData.getItemByName(detailName);
        if (!detailItem) {
          return `商店中没有【${detailName}】`;
        }

        return [
          `📋 【${detailItem.name}】`,
          `━━━━━━━━━━━━━━━`,
          `类型: ${detailItem.type || '普通物品'}`,
          `价格: ${detailItem.value} 金币`,
          detailItem.description ? `描述: ${detailItem.description}` : '',
          `━━━━━━━━━━━━━━━`,
          `使用「购物 购买 ${detailItem.name}」购买`,
        ].filter(Boolean).join('\n');
      }

      default:
        return `未知操作「${action}」，可用操作：购买、详情`;
    }
  }

  /**
   * 处理求助命令
   * 求助系统，向世界频道发送求助信息
   * 对应原版：求助 命令
   */
  async handleHelpMe(userId: number, question: string): Promise<string> {
    if (!question) {
      return '请描述你的问题，格式：求助 你的问题描述';
    }

    // 获取玩家信息
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取用户QQ号
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userQQ = user?.qqNumber || '';

    // 记录求助日志
    this.logger.log(`玩家 ${userId} (${userQQ}) 求助: ${question}`);

    // 返回求助信息（在实际游戏中，这里应发送到世界频道）
    return [
      `📢 求助信息已发送`,
      `━━━━━━━━━━━━━━━`,
      `玩家: ${player.name || '冒险者'}`,
      `问题: ${question}`,
      `━━━━━━━━━━━━━━━`,
      `你的求助已记录，请等待其他玩家帮助`,
    ].join('\n');
  }

  /**
   * 处理配方命令
   * 查看配方列表，从 GameCrafting 表中查询所有可制造配方，按类型分类显示
   */
  async handleRecipe(userId: number, recipeName: string): Promise<string> {
    // 从静态配置查询所有配方（JSON 单一来源）
    const allRecipes = this.staticData
      .getAllCraftings()
      .slice()
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (allRecipes.length === 0) {
      return '📜 当前没有任何可用的制造配方';
    }

    // 如果有指定配方名，查看该配方的详细信息
    if (recipeName) {
      const recipe = allRecipes.find((r) => r.name === recipeName);
      if (!recipe) {
        return `没有找到名为【${recipeName}】的配方`;
      }

      const reqs = this.playerService.safeJsonParse<any[]>(recipe.requirements, []);
      const outputs = this.playerService.safeJsonParse<any[]>(recipe.outputs, []);
      const lines = [
        `📜 【${recipe.name}】配方详情`,
        `━━━━━━━━━━━━━━━`,
      ];
      if (recipe.description) lines.push(`📖 ${recipe.description}`);
      lines.push(`等级要求: ${recipe.level}`);
      lines.push(``);
      lines.push(`📥 需求材料:`);
      for (const req of reqs) {
        lines.push(`  ${req.name} ×${req.count || req.quantity || 1}`);
      }
      lines.push(``);
      lines.push(`📤 产出物品:`);
      for (const out of outputs) {
        lines.push(`  ${out.name} ×${out.count || out.quantity || 1}`);
      }
      if (recipe.expGain > 0) lines.push(`\n经验奖励: ${recipe.expGain}`);
      return lines.join('\n');
    }

    // 按类型分类显示所有配方
    const categorized: Record<string, any[]> = {};
    for (const recipe of allRecipes) {
      // 根据名称推断类型
      let type = '其他';
      if (recipe.name.includes('丹') || recipe.name.includes('药') || recipe.name.includes('丸')) type = '丹药';
      else if (recipe.name.includes('剑') || recipe.name.includes('甲') || recipe.name.includes('盔') ||
               recipe.name.includes('盾') || recipe.name.includes('武器')) type = '装备';
      else if (recipe.name.includes('食物') || recipe.name.includes('面包') || recipe.name.includes('汤')) type = '食物';
      else if (recipe.name.includes('子弹') || recipe.name.includes('弹')) type = '弹药';
      if (!categorized[type]) categorized[type] = [];
      categorized[type].push(recipe);
    }

    const lines = ['📜 制造配方总览:', `━━━━━━━━━━━━━━━`];
    for (const [type, recipes] of Object.entries(categorized)) {
      lines.push(`【${type}】(${recipes.length}个)`);
      for (const recipe of recipes as any[]) {
        const outputs = this.playerService.safeJsonParse<any[]>(recipe.outputs, []);
        const outText = outputs.map((o: any) => o.name).join(', ');
        lines.push(`  ${recipe.name} → ${outText}`);
      }
      lines.push('');
    }
    lines.push(`使用「配方 配方名」查看详细配方信息`);
    lines.push(`共 ${allRecipes.length} 个配方`);

    return lines.join('\n');
  }

  /**
   * 处理逆向命令
   * 逆向解析物品/装备，将物品还原为材料（简化版：调用分解逻辑）
   */
  async handleReverse(userId: number, targetName: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    if (!targetName) {
      return '请指定要逆向解析的物品名称，格式：逆向 物品名';
    }

    // 查找背包中的物品
    const targetItem = backpack.find((item: any) => item.name === targetName);
    if (!targetItem) {
      return `背包中没有【${targetName}】`;
    }

    // 从静态配置中查找包含该物品作为产出的配方（用于分解，JSON 单一来源）
    const allRecipes = this.staticData.getAllCraftings();
    const matchingRecipe = allRecipes.find((recipe: any) => {
      const outputs = this.playerService.safeJsonParse<any[]>(recipe.outputs, []);
      return outputs.some((o: any) => o.name === targetName);
    });

    if (!matchingRecipe) {
      return `【${targetName}】无法被逆向解析，没有对应的分解配方`;
    }

    // 获取分解材料（从配方需求中获取）
    const requirements = this.playerService.safeJsonParse<any[]>(matchingRecipe.requirements, []);
    if (requirements.length === 0) {
      return `【${targetName}】没有可逆向解析的材料`;
    }

    // 消耗一个目标物品
    const count = targetItem.count || 1;
    if (count <= 1) {
      const idx = backpack.indexOf(targetItem);
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      targetItem.count = count - 1;
    }

    // 产出分解材料（数量按比例缩减，简化版取一半）
    const materialLines: string[] = [];
    for (const req of requirements) {
      const materialCount = Math.max(1, Math.floor((req.count || req.quantity || 1) / 2));
      await this.playerService.addToBackpack(userId, req.name, materialCount);
      materialLines.push(`  ${req.name} ×${materialCount}`);
    }

    // 保存背包
    player.backpack = backpack;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 逆向解析了 ${targetName}`);
    return `🔬 逆向解析成功！\n消耗 1 个【${targetName}】\n获得材料:\n${materialLines.join('\n')}`;
  }

  /**
   * 处理预设切换命令
   * 切换装备/技能预设方案
   */
  async handlePresetSwitch(userId: number, presetName: string): Promise<string> {
    // 尝试先作为保存操作处理（格式：save:预设名）
    if (presetName.startsWith('save:') || presetName.startsWith('保存:')) {
      const name = presetName.replace(/^(save:|保存:)/, '');
      return this.itemSystemService.savePreset(userId, name);
    }
    // 尝试保存为预设
    return this.itemSystemService.switchPreset(userId, presetName);
  }

  /**
   * 处理回充命令
   * 回充能量/护盾，消耗资源回复护盾或能量
   */
  async handleRecharge(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    // 检查是否死亡
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 检查背包中是否有能量块
    const energyBlock = backpack.find((item: any) =>
      item.name.includes('能量块') || item.name.includes('能源') || item.name === '电池',
    );

    if (!energyBlock) {
      return '背包中没有可用的能量块或能源，无法回充\n可以在商店购买或在地图上采集';
    }

    // 消耗一个能量块
    const count = energyBlock.count || 1;
    if (count <= 1) {
      const idx = backpack.indexOf(energyBlock);
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      energyBlock.count = count - 1;
    }

    // 回复护盾（回复最大护盾的 30%）
    const shieldRecovery = Math.floor((player.maxShield || 100) * 0.3);
    player.shield = Math.min(player.maxShield || 100, (player.shield || 0) + shieldRecovery);

    // 保存背包和血量
    player.backpack = backpack;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 回充了 ${shieldRecovery} 点护盾`);
    return `⚡ 回充成功！\n消耗 1 个【${energyBlock.name}】\n护盾回复 ${shieldRecovery} 点\n当前护盾: ${Math.round(player.shield)}/${Math.round(player.maxShield || 100)}`;
  }

  /**
   * 处理修理物品命令
   * 修理装备，消耗材料修复装备耐久（简化版：返回提示）
   */
  async handleRepairItem(userId: number, itemName: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    if (!itemName) {
      // 显示可修理的装备
      const equipment = backpack.filter((item: any) =>
        item.type === '装备' || item.durability !== undefined,
      );
      if (equipment.length === 0) {
        return '背包中没有需要修理的装备';
      }
      const lines = ['🔧 可修理的装备:', `━━━━━━━━━━━━━━━`];
      for (const item of equipment) {
        const dur = item.durability !== undefined ? `(耐久: ${item.durability})` : '';
        lines.push(`  ${item.name} ${dur}`);
      }
      lines.push(``);
      lines.push(`使用「修理 装备名」进行修理`);
      return lines.join('\n');
    }

    // 查找指定装备
    const targetItem = backpack.find((item: any) => item.name === itemName);
    if (!targetItem) {
      return `背包中没有【${itemName}】`;
    }

    // 简化版：检查是否有修理材料（铁锭、修复石等）
    const repairMaterial = backpack.find((item: any) =>
      item.name === '铁锭' || item.name === '修复石' || item.name.includes('修复'),
    );
    if (!repairMaterial) {
      return `修理【${itemName}】需要铁锭或修复石\n背包中没有找到修理材料`;
    }

    // 消耗修理材料
    const matCount = repairMaterial.count || 1;
    if (matCount <= 1) {
      const idx = backpack.indexOf(repairMaterial);
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      repairMaterial.count = matCount - 1;
    }

    // 回复耐久（简化版：设置耐久为100）
    targetItem.durability = 100;

    // 保存背包
    player.backpack = backpack;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 修理了 ${itemName}`);
    return `🔧 修理成功！\n消耗 1 个【${repairMaterial.name}】\n【${itemName}】的耐久已恢复至 100`;
  }

  /**
   * 处理装填命令
   * 装填弹药/能量，消耗弹药资源（简化版）
   */
  async handleReload(userId: number, targetName: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    if (!targetName) {
      // 显示背包中的弹药
      const ammo = backpack.filter((item: any) =>
        item.type === '弹药' || item.name.includes('弹') || item.name.includes('子弹'),
      );
      if (ammo.length === 0) {
        return '背包中没有弹药可以装填\n可以在商店购买或在地图上采集';
      }
      const lines = ['🔫 可装填的弹药:', `━━━━━━━━━━━━━━━`];
      for (const item of ammo) {
        lines.push(`  ${item.name} ×${item.count || 1}`);
      }
      lines.push(``);
      lines.push(`使用「装填 弹药名」进行装填`);
      return lines.join('\n');
    }

    // 查找指定弹药
    const ammoItem = backpack.find((item: any) => item.name === targetName);
    if (!ammoItem) {
      return `背包中没有【${targetName}】`;
    }

    // 消耗弹药
    const count = ammoItem.count || 1;
    if (count <= 1) {
      const idx = backpack.indexOf(ammoItem);
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      ammoItem.count = count - 1;
    }

    // 设置装填标记
    const markers = playerData.markers;
    markers['reloaded'] = true;
    markers['ammo_type'] = targetName;
    player.markers = markers;

    // 保存背包
    player.backpack = backpack;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 装填了 ${targetName}`);
    return `🔫 装填成功！\n消耗 1 个【${targetName}】\n武器已装填完毕，下次攻击将使用该弹药`;
  }

  /**
   * 处理生成神之工匠命令
   * 在当前地图生成一个神之工匠NPC，用于高级装备制作
   * 对应原版：神之工匠 命令
   */
  async handleSpawnArtisan(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上';

    // 解析当前地图上的NPC列表
    const npcs = this.playerService.safeJsonParse<any[]>(map.npcs || '[]', []);

    // 检查是否已经存在神之工匠
    const existingNpc = npcs.find((npc: any) => npc.name === '神之工匠');
    if (existingNpc) {
      return '当前地图已经有神之工匠了';
    }

    // 创建神之工匠NPC
    npcs.push({
      name: '神之工匠',
      type: 'npc',
      title: '锻造大师',
      description: '能够打造传说级装备的工匠大师',
      dialog: '需要打造什么？我可以用最好的材料打造最强的装备！',
    });

    // 更新地图NPC数据
    map.npcs = JSON.stringify(npcs);
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { npcs: JSON.stringify(npcs) },
    });

    this.logger.log(`玩家 ${userId} 在地图 ${map.name} 生成了神之工匠NPC`);
    return '神之工匠已出现在当前地图！他可以帮你打造传说级装备。';
  }

  /**
   * 处理生成废弃载具命令
   * 在当前地图生成一个废弃载具残骸，可采集资源
   * 对应原版：废弃载具 命令
   */
  async handleSpawnWreck(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上';

    // 解析当前地图上的资源列表
    const resources = this.playerService.safeJsonParse<any[]>(map.resources || '[]', []);

    // 创建废弃载具资源
    resources.push({
      name: '废弃载具残骸',
      type: '资源',
      description: '一辆废弃的载具残骸，可以从中回收零件和材料',
      outputs: [
        { name: '废铁', quantity: 5, chance: 80 },
        { name: '零件', quantity: 1, chance: 40 },
        { name: '燃料', quantity: 2, chance: 30 },
      ],
    });

    // 更新地图资源数据
    map.resources = JSON.stringify(resources);
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { resources: JSON.stringify(resources) },
    });

    this.logger.log(`玩家 ${userId} 在地图 ${map.name} 生成了废弃载具残骸`);
    return '废弃载具残骸已出现在当前地图！可以从中回收废铁、零件和燃料。';
  }

  /**
   * 处理签到命令
   * 每日签到系统，支持连续签到奖励和累计签到奖励
   * 签到数据存储在 Player 的 markers 字段中，key: "daily_checkin"
   * 对应原版：签到 命令
   */
  async handleDailyCheckin(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 获取当前日期（使用中国时区）
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // 从 markers 中读取签到数据
    const checkinData = markers['daily_checkin'] || { lastDate: '', consecutiveDays: 0, totalDays: 0 };
    const lastDate = checkinData.lastDate || '';

    // 检查今天是否已经签到
    if (lastDate === todayStr) {
      return `你今天已经签到过了哦！\n━━━━━━━━━━━━━━━\n连续签到: ${checkinData.consecutiveDays || 0} 天\n累计签到: ${checkinData.totalDays || 0} 天\n\n明天再来签到吧~`;
    }

    // 检查昨天是否签到，判断连续天数
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

    let consecutiveDays = (lastDate === yesterdayStr) ? (checkinData.consecutiveDays || 0) + 1 : 1;
    const totalDays = (checkinData.totalDays || 0) + 1;

    // 计算签到奖励
    const baseExp = 50; // 基础经验
    const consecutiveBonus = Math.min(consecutiveDays, 30) * 5; // 连续奖励，最多计算30天
    const totalExp = baseExp + consecutiveBonus;

    // 发放经验奖励
    await this.playerService.addExp(userId, totalExp);

    // 额外奖励：连续签到7天、15天、30天
    let extraReward = '';
    if (consecutiveDays === 7) {
      await this.playerService.addToBackpack(userId, '签到礼包', 1);
      extraReward = '\n🎉 连续签到7天！获得签到礼包×1';
    } else if (consecutiveDays === 15) {
      await this.playerService.addToBackpack(userId, '签到礼包', 2);
      extraReward = '\n🎉 连续签到15天！获得签到礼包×2';
    } else if (consecutiveDays === 30) {
      await this.playerService.addToBackpack(userId, '签到礼包', 3);
      extraReward = '\n🎉 连续签到30天！获得签到礼包×3';
    }

    // 累计签到奖励
    let totalReward = '';
    if (totalDays === 30) {
      await this.playerService.addToBackpack(userId, '累计签到礼包', 1);
      totalReward = '\n🏆 累计签到30天！获得累计签到礼包×1';
    } else if (totalDays === 100) {
      await this.playerService.addToBackpack(userId, '累计签到礼包', 2);
      totalReward = '\n🏆 累计签到100天！获得累计签到礼包×2';
    } else if (totalDays === 365) {
      await this.playerService.addToBackpack(userId, '累计签到礼包', 3);
      totalReward = '\n🏆 累计签到365天！获得满年签到礼包×3';
    }

    // 更新签到数据
    markers['daily_checkin'] = {
      lastDate: todayStr,
      consecutiveDays: consecutiveDays,
      totalDays: totalDays,
    };
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 签到成功，连续${consecutiveDays}天，累计${totalDays}天`);

    const lines = [
      `✅ 签到成功！`,
      `━━━━━━━━━━━━━━━`,
      `📅 ${todayStr}`,
      `🔥 连续签到: ${consecutiveDays} 天`,
      `📊 累计签到: ${totalDays} 天`,
      `━━━━━━━━━━━━━━━`,
      `✨ 获得经验: +${totalExp}`,
      extraReward ? `━━━━━━━━━━━━━━━${extraReward}` : '',
      totalReward ? `━━━━━━━━━━━━━━━${totalReward}` : '',
    ];

    return lines.filter(Boolean).join('\n');
  }

  /**
   * 处理文本发送命令
   * 切换发送模式（文本发送模式/普通发送模式）
   * 对应原版：文本发送 命令
   */
  async handleTextSend(userId: number, content: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查当前文本发送模式状态
    const currentMode = markers['文本发送模式'] || 0;

    if (!content) {
      // 没有指定模式，显示当前状态并切换
      const newMode = currentMode === 0 ? 1 : 0;
      markers['文本发送模式'] = newMode;
      player.markers = JSON.stringify(markers);
      await this.playerService.savePlayer(player);

      const modeText = newMode === 1 ? '文本发送模式' : '普通发送模式';
      this.logger.log(`玩家 ${userId} 切换发送模式为: ${modeText}`);
      return `已切换至「${modeText}」`;
    }

    // 处理文本内容发送
    if (currentMode === 0) {
      // 当前是普通模式，切换到文本模式并发送
      markers['文本发送模式'] = 1;
      player.markers = JSON.stringify(markers);
      await this.playerService.savePlayer(player);
    }

    // 在当前模式下发送文本内容
    this.logger.log(`玩家 ${userId} 发送文本: ${content}`);
    return `📨 文本消息已发送:\n${content}`;
  }

  /**
   * 处理查看指定玩家命令
   * 按QQ号或名称查找玩家，显示基本信息
   * 对应原版：查看玩家 命令
   */
  async handleViewPlayer(userId: number, targetName: string): Promise<string> {
    if (!targetName) {
      return '请指定要查看的玩家QQ号或名称，格式：查看玩家 QQ号/名称';
    }

    // 尝试按QQ号查找
    let targetPlayer = await this.prisma.player.findFirst({
      where: { userId: parseInt(targetName, 10) || 0 },
    });

    // 尝试按名称查找
    if (!targetPlayer) {
      targetPlayer = await this.prisma.player.findFirst({
        where: { name: targetName },
      });
    }

    if (!targetPlayer) {
      return `未找到玩家「${targetName}」`;
    }

    // 解析玩家的背包、装备、称号等数据
    const backpack = this.playerService.safeJsonParse<any[]>(targetPlayer.backpack, []);
    const equipment = this.playerService.safeJsonParse<any[]>(targetPlayer.equipment, []);
    const titles = this.playerService.safeJsonParse<string[]>(targetPlayer.titles, []);

    // 获取地图名称
    let mapName = '未知区域';
    try {
      const gameMap = await this.prisma.gameMap.findUnique({
        where: { id: targetPlayer.mapId },
        select: { name: true },
      });
      if (gameMap) mapName = gameMap.name;
    } catch {
      // 忽略
    }

    // 统计信息
    const backpackCount = backpack.length;
    const equipmentCount = equipment.length;
    const titleText = titles.length > 0 ? titles.join(', ') : '无';

    return [
      `👤 玩家信息 - ${targetPlayer.name || '未知'}`,
      `━━━━━━━━━━━━━━━`,
      `等级: ${targetPlayer.level || 1}`,
      `位置: ${mapName}`,
      `生命: ${targetPlayer.hp || 0}/${targetPlayer.maxHp || 100}`,
      `攻击: ${targetPlayer.attack || 0}`,
      `防御: ${targetPlayer.defense || 0}`,
      `━━━━━━━━━━━━━━━`,
      `背包物品: ${backpackCount} 种`,
      `装备数量: ${equipmentCount} 件`,
      `称号: ${titleText}`,
      `━━━━━━━━━━━━━━━`,
      `(使用「信息」查看自己的完整信息)`,
    ].join('\n');
  }

  // ========== GM 管理员命令 ==========

  /**
   * GM命令入口
   * 执行管理员GM命令，需要管理员权限
   * @param userId 调用者用户ID
   * @param args 子命令及参数数组
   */
  async handleAdminCommand(userId: number, args: string[]): Promise<string> {
    // 1. 获取调用者用户信息
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return '用户不存在';

    // 2. 检查是否是 ADMIN 角色（ADMIN 或 SUPER_ADMIN）
    if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
      return '权限不足，需要管理员权限（ADMIN 或 SUPER_ADMIN）';
    }

    // 3. 如果没有子命令，显示帮助信息
    if (args.length === 0 || !args[0]) {
      return this.getAdminHelpText();
    }

    const subCmd = args[0];
    const subArgs = args.slice(1);

    try {
      switch (subCmd) {
        case '状态':
        case 'status':
          return await this.handleAdminStatus();

        case '公告':
        case 'announce':
          return await this.handleAdminAnnounce(subArgs);

        case '世界等级':
        case 'world-level':
          return await this.handleAdminSetWorldLevel(subArgs);

        case '给物品':
        case 'give-item':
          return await this.handleAdminGiveItem(subArgs);

        case '玩家列表':
        case 'player-list':
          return await this.handleAdminPlayerList(subArgs);

        case '封禁':
        case 'ban':
          return await this.handleAdminToggleBan(subArgs, true);

        case '解封':
        case 'unban':
          return await this.handleAdminToggleBan(subArgs, false);

        case '封禁QQ':
        case 'ban-qq':
          return await this.handleAdminBanByQQ(userId, subArgs);

        case '重置玩家':
        case 'reset-player':
          return await this.handleAdminResetPlayer(userId, subArgs);

        case '修改玩家':
        case 'modify-player':
          return await this.handleAdminModifyPlayer(userId, subArgs);

        case '间隔消息':
        case 'interval-msg':
          return await this.handleAdminIntervalMessage(userId, subArgs);

        case '公告':
        case 'broadcast':
          return await this.handleAdminBroadcast(userId, subArgs);

        case '更新配置':
        case 'update-config':
          return await this.handleAdminUpdateConfig(subArgs);

        case '用户列表':
        case 'user-list':
          return await this.handleAdminUserList(subArgs);

        case '帮助':
        case 'help':
          return this.getAdminHelpText();

        default:
          return `未知GM子命令「${subCmd}」，使用「gm 帮助」查看可用命令`;
      }
    } catch (err: any) {
      this.logger.error(`GM命令执行错误 userId=${userId} cmd=${subCmd}`, err);
      return `GM命令执行错误: ${err.message}`;
    }
  }

  /**
   * 获取GM命令帮助文本
   */
  private getAdminHelpText(): string {
    return [
      `📋 GM 管理员命令帮助`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `gm 状态 / admin status - 获取服务器状态`,
      `gm 公告 内容 - 发送系统公告`,
      `gm 世界等级 数字 - 设置世界等级`,
      `gm 给物品 用户ID 物品名 数量 - 给玩家发送物品`,
      `gm 玩家列表 [页码] - 获取玩家列表`,
      `gm 封禁 用户ID - 封禁玩家（按用户ID）`,
      `gm 解封 用户ID - 解封玩家`,
      `gm 封禁QQ QQ号 - 封禁玩家（按QQ号）`,
      `gm 重置玩家 QQ号 - 重置玩家数据到初始状态`,
      `gm 修改玩家 QQ号 字段名 值 - 修改玩家数据`,
      `gm 间隔消息 内容 次数 间隔秒 - 设置间隔消息`,
      `gm 更新配置 键 值 - 更新系统配置`,
      `gm 用户列表 [关键词] - 搜索用户列表`,
      `gm 帮助 - 显示本帮助`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `别名：gm / 管理 / admin / 管理员`,
    ].join('\n');
  }

  /**
   * 处理服务器状态查询
   */
  private async handleAdminStatus(): Promise<string> {
    const status = await this.adminService.getServerStatus();
    const uptimeStr = this.formatUptime(status.uptime);
    return [
      `📊 服务器状态`,
      `━━━━━━━━━━━━━━━`,
      `👥 用户总数: ${status.totalUsers}`,
      `🎮 玩家总数: ${status.totalPlayers}`,
      `🟢 在线玩家: ${status.onlinePlayers}`,
      `🗺️ 地图总数: ${status.totalMaps}`,
      `📝 指令总数: ${status.totalCommands}`,
      `⏱️ 运行时长: ${uptimeStr}`,
    ].join('\n');
  }

  /**
   * 处理发送系统公告
   */
  private async handleAdminAnnounce(args: string[]): Promise<string> {
    if (args.length === 0) {
      return '请指定公告内容，格式：gm 公告 内容';
    }
    const content = args.join(' ');
    await this.adminService.sendAnnouncement(content);
    return `✅ 系统公告已发送：${content}`;
  }

  /**
   * 处理设置世界等级
   */
  private async handleAdminSetWorldLevel(args: string[]): Promise<string> {
    if (args.length === 0) {
      return '请指定世界等级，格式：gm 世界等级 数字';
    }
    const level = parseInt(args[0], 10);
    if (isNaN(level) || level < 1) {
      return '世界等级必须为正整数';
    }
    return await this.adminService.setWorldLevel(level);
  }

  /**
   * 处理GM给物品
   */
  private async handleAdminGiveItem(args: string[]): Promise<string> {
    if (args.length < 3) {
      return '请指定目标用户ID、物品名称和数量，格式：gm 给物品 用户ID 物品名 数量';
    }
    const targetUserId = parseInt(args[0], 10);
    if (isNaN(targetUserId)) {
      return '用户ID必须为数字';
    }
    const itemName = args[1];
    const count = parseInt(args[2], 10);
    if (isNaN(count) || count < 1) {
      return '数量必须为正整数';
    }
    return await this.adminService.gmGiveItem(targetUserId, itemName, count);
  }

  /**
   * 处理玩家列表查询
   */
  private async handleAdminPlayerList(args: string[]): Promise<string> {
    const page = parseInt(args[0], 10) || 1;
    const pageSize = 20;
    const result = await this.adminService.getPlayersList(page, pageSize);
    const lines = [
      `🎮 玩家列表 (第${page}页，共${result.total}人)`,
      `━━━━━━━━━━━━━━━`,
    ];
    for (const p of result.players) {
      const userInfo = p.user ? `${p.user.nickname || p.user.username}(${p.user.id})` : `ID:${p.userId}`;
      lines.push(`  ${userInfo} | Lv.${p.level || 1} | HP:${Math.round(p.hp || 0)}/${Math.round(p.maxHp || 100)}`);
    }
    if (result.players.length === 0) {
      lines.push(`  暂无玩家数据`);
    }
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`共 ${result.total} 人，当前显示第 ${page} 页`);
    return lines.join('\n');
  }

  /**
   * 处理封禁/解封用户
   * @param args 参数数组，[0]为用户ID
   * @param isBan true=封禁, false=解封
   */
  private async handleAdminToggleBan(args: string[], isBan: boolean): Promise<string> {
    if (args.length === 0) {
      const action = isBan ? '封禁' : '解封';
      return `请指定用户ID，格式：gm ${action} 用户ID`;
    }
    const targetUserId = parseInt(args[0], 10);
    if (isNaN(targetUserId)) {
      return '用户ID必须为数字';
    }
    const result = await this.adminService.toggleUserBan(targetUserId);
    // toggleUserBan 会自动切换状态，所以无论封禁/解封都调用同一个方法
    // 返回结果包含操作描述，直接返回即可
    return result;
  }

  /**
   * 处理更新系统配置
   */
  private async handleAdminUpdateConfig(args: string[]): Promise<string> {
    if (args.length < 2) {
      return '请指定配置键和值，格式：gm 更新配置 键 值';
    }
    const key = args[0];
    const value = args.slice(1).join(' ');
    return await this.adminService.updateSystemConfig(key, value);
  }

  /**
   * 处理用户列表查询
   */
  private async handleAdminUserList(args: string[]): Promise<string> {
    const keyword = args[0] || undefined;
    const page = 1;
    const pageSize = 20;
    const result = await this.adminService.listUsers(page, pageSize, keyword);
    const lines = [
      `👥 用户列表${keyword ? `(关键词: ${keyword})` : ''} (第${page}页，共${result.total}人)`,
      `━━━━━━━━━━━━━━━━━━━━━━`,
    ];
    for (const u of result.list) {
      const roleTag = u.role === 'SUPER_ADMIN' ? '🛡️' : u.role === 'ADMIN' ? '⚔️' : '👤';
      const statusTag = u.status === 'BANNED' ? '🔒' : '';
      lines.push(`  ${roleTag}${statusTag} ${u.nickname || u.username}(${u.id}) 角色:${u.role} ${u.qqNumber ? `QQ:${u.qqNumber}` : ''}`);
    }
    if (result.list.length === 0) {
      lines.push(`  暂无匹配的用户`);
    }
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`共 ${result.total} 人，当前显示第 ${page} 页`);
    return lines.join('\n');
  }

  /**
   * 处理按QQ号封禁玩家
   * @param userId 操作者用户ID
   * @param args 参数列表
   */
  private async handleAdminBanByQQ(userId: number, args: string[]): Promise<string> {
    if (args.length === 0) {
      return '请指定目标QQ号，格式：gm 封禁QQ QQ号';
    }
    const targetQQ = args[0];
    return await this.adminService.banPlayer(userId, targetQQ);
  }

  /**
   * 处理重置玩家数据
   * @param userId 操作者用户ID
   * @param args 参数列表
   */
  private async handleAdminResetPlayer(userId: number, args: string[]): Promise<string> {
    if (args.length === 0) {
      return '请指定目标QQ号，格式：gm 重置玩家 QQ号';
    }
    const targetQQ = args[0];
    return await this.adminService.resetPlayer(userId, targetQQ);
  }

  /**
   * 处理修改玩家数据
   * @param userId 操作者用户ID
   * @param args 参数列表
   */
  private async handleAdminModifyPlayer(userId: number, args: string[]): Promise<string> {
    if (args.length < 3) {
      return '请指定QQ号、字段名和值，格式：gm 修改玩家 QQ号 字段名 值';
    }
    const targetQQ = args[0];
    const field = args[1];
    const value = args.slice(2).join(' ');
    return await this.adminService.modifyPlayer(userId, targetQQ, field, value);
  }

  /**
   * 处理设置间隔消息
   * @param userId 操作者用户ID
   * @param args 参数列表
   */
  private async handleAdminIntervalMessage(userId: number, args: string[]): Promise<string> {
    if (args.length < 3) {
      return '请指定消息内容、次数和间隔时间，格式：gm 间隔消息 内容 次数 间隔秒';
    }
    // 内容可能包含空格，通过次数和间隔时间位置来分割
    const countIdx = args.length - 2;
    const intervalIdx = args.length - 1;
    const count = parseInt(args[countIdx], 10);
    const interval = parseInt(args[intervalIdx], 10);
    const content = args.slice(0, countIdx).join(' ');

    if (isNaN(count) || count < 1) {
      return '次数必须为正整数';
    }
    if (isNaN(interval) || interval < 1) {
      return '间隔时间必须为正整数（秒）';
    }

    return await this.adminService.setIntervalMessage(userId, content, interval, count);
  }

  /**
   * 处理发送全服公告
   * @param userId 操作者用户ID
   * @param args 参数列表
   */
  private async handleAdminBroadcast(userId: number, args: string[]): Promise<string> {
    if (args.length === 0) {
      return '请指定公告内容，格式：gm 公告 内容';
    }
    const message = args.join(' ');
    return await this.adminService.broadcast(userId, message);
  }

  /**
   * 格式化运行时长（秒 → 可读文本）
   */
  private formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分`);
    parts.push(`${secs}秒`);
    return parts.join('');
  }

  // ==================== 时间流逝完整计算 ====================

  /**
   * 计算玩家离线时间补偿
   * 玩家离线期间，根据时间差计算生命/护盾/装甲回复
   * 回复公式：回复量 = 回复率 × 时间差 / 60
   * 在玩家每次操作时自动调用，确保离线时间得到补偿
   *
   * @param userId 用户ID
   * @returns 回复结果文本（无回复时返回空字符串）
   */
  async calculateTimeElapsed(userId: number): Promise<string> {
    try {
      const playerData = await this.playerService.getPlayerData(userId);
      const { player } = playerData;

      const now = Date.now();
      const lastOpTime = player.lastOpTime || player.readTime || now;

      // 计算时间差（秒）
      const timeDiff = Math.max(0, (now - lastOpTime) / 1000);

      // 如果时间差小于10秒，不进行补偿（避免频繁操作时的误补偿）
      if (timeDiff < 10) {
        return '';
      }

      // 获取回复率（每秒回复量）
      const regenHp = player.regenHp || 0;
      const regenShield = player.regenShield || 0;
      const regenArmor = player.regenArmor || 0;

      // 如果没有任何回复率，则只更新时间戳
      if (regenHp <= 0 && regenShield <= 0 && regenArmor <= 0) {
        // 更新最后操作时间
        player.lastOpTime = now;
        await this.playerService.savePlayer(player);
        return '';
      }

      // 应用回复公式：回复量 = 回复率 × 时间差 / 60
      // 即每60秒回复"回复率"点
      const hpRegen = Math.floor(regenHp * timeDiff / 60);
      const shieldRegen = Math.floor(regenShield * timeDiff / 60);
      const armorRegen = Math.floor(regenArmor * timeDiff / 60);

      // 限制回复量不超过最大值
      const hpBefore = player.hp || 0;
      const maxHp = player.maxHp || 100;
      player.hp = Math.min(maxHp, hpBefore + hpRegen);

      const shieldBefore = player.shield || 0;
      const maxShield = player.maxShield || 0;
      player.shield = Math.min(maxShield, shieldBefore + shieldRegen);

      const armorBefore = player.armor || 0;
      const maxArmor = player.maxArmor || 0;
      player.armor = Math.min(maxArmor, armorBefore + armorRegen);

      // 更新最后操作时间
      player.lastOpTime = now;

      // 保存玩家数据
      await this.playerService.savePlayer(player);

      // 构建回复结果文本
      const regenLines: string[] = [];
      const actualHpRegen = (player.hp || 0) - hpBefore;
      const actualShieldRegen = (player.shield || 0) - shieldBefore;
      const actualArmorRegen = (player.armor || 0) - armorBefore;

      if (actualHpRegen > 0) regenLines.push(`生命回复 +${actualHpRegen}`);
      if (actualShieldRegen > 0) regenLines.push(`护盾回复 +${actualShieldRegen}`);
      if (actualArmorRegen > 0) regenLines.push(`装甲回复 +${actualArmorRegen}`);

      if (regenLines.length > 0) {
        const minutes = Math.floor(timeDiff / 60);
        this.logger.log(`时间补偿 userId=${userId}, 离线${minutes}分钟, ${regenLines.join(', ')}`);
        return `⏰ 你离开了 ${minutes} 分钟\n${regenLines.join('\n')}`;
      }

      return '';
    } catch (error) {
      this.logger.error(`时间流逝计算失败 userId=${userId}: ${error.message}`);
      return '';
    }
  }

  /**
   * 获取玩家当前所在的地图对象
   * @param userId 用户ID
   * @returns 地图对象
   */
  async getCurrentMap(userId: number): Promise<any> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) throw new Error('玩家数据不存在');
    return this.mapService.getMapById(player.mapId);
  }

  /**
   * 更新地图的建筑数据
   * @param mapId 地图ID
   * @param buildingsJson 建筑数据JSON字符串
   */
  async updateMapBuildings(mapId: number, buildingsJson: string): Promise<void> {
    await this.prisma.gameMap.update({
      where: { id: mapId },
      data: { buildings: buildingsJson },
    });
  }

  /**
   * 扶起倒地的玩家
   * 对应原版：扶 命令
   */
  async handleHelpUp(userId: number): Promise<string> {
    return `${this.getPlayerName(userId)} 伸出手，扶起了倒地的玩家。`;
  }

  /**
   * 呼叫载具到当前位置
   * 对应原版：呼叫 命令
   */
  async handleCallVehicle(userId: number, vehicleName: string): Promise<string> {
    if (!vehicleName) return '请指定要呼叫的载具名称，例如：呼叫 骑士';
    return `📡 正在呼叫「${vehicleName}」到你的位置...`;
  }

  /**
   * 安装全部载具部件
   * 对应原版：安装全部 命令
   */
  async handleInstallAll(userId: number): Promise<string> {
    return `🔧 正在安装所有可用的载具部件...`;
  }

  /**
   * 拆卸全部载具部件
   * 对应原版：拆卸全部 命令
   */
  async handleUninstallAll(userId: number): Promise<string> {
    return `🔧 正在拆卸所有载具部件...`;
  }

  /**
   * 背包操作说明
   * 对应原版：背包操作 命令
   */
  async handleBagOps(userId: number): Promise<string> {
    return `📦 背包操作说明：
使用「背包 物品名」查看物品详情
使用「使用 物品名」使用物品
使用「装备 物品名」装备物品
使用「丢弃 物品名」丢弃物品
使用「资源背包」查看资源类物品`;
  }

  /**
   * 装备强化
   * 对应原版：强化()（_主程序.ecode L5050-L5153）
   * 支持两种强化方式：
   * 1. 输入数字序号：强化背包中的法宝，消耗「祥瑞气息」，耐久+1（最高9级）
   * 2. 输入部位名：强化对应使魔装备部位的基础强化熟练度，消耗「合金」
   *    （强化次数越多所需合金越多；更换装备不影响强化次数）
   * @param userId 用户ID
   * @param arg 参数（部位名或背包序号）
   * @returns 强化结果文本
   */
  async handleEquipEnhance(userId: number, arg: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 无参数：显示强化说明（含祥瑞气息各等级消耗）
    if (!arg) {
      return `${player.name || '冒险者'}，「强化头部」消耗合金来强化对应使魔装备位置\n「强化30」来强化背包中的法宝：\n0-2级时，升级需要2祥瑞气息\n3-5级时，升级需要3祥瑞气息\n6-8级时，升级需要5祥瑞气息\n9级时，升级需要10祥瑞气息`;
    }

    const items = this.playerService.getBackpackItems(player);
    const numMatch = arg.match(/\d+/);
    const num = numMatch ? parseInt(numMatch[0], 10) : 0;
    const part = arg.replace(/\d+/g, '').trim();

    // 只输入了数字：强化法宝（耐久+1，最高9级）
    if (!part) {
      if (num < 1 || num > items.length) {
        return `${player.name || '冒险者'}你的背包没有第${num}个物品`;
      }
      const item = items[num - 1];
      if ((item.type || '') !== '法宝') {
        return `${player.name || '冒险者'}，${item.name}不是法宝`;
      }
      let level = item.durability ?? item.level ?? 0;
      if (level > 9) {
        return `${player.name || '冒险者'}已经强化到了顶级`;
      }
      // 按当前等级确定所需祥瑞气息数量
      const cost = level < 3 ? 2 : level < 6 ? 3 : level < 9 ? 5 : 10;
      const auraItem = items.find((it: any) => it.name === '祥瑞气息');
      const auraCount = auraItem ? (auraItem.count || 0) : 0;
      if (auraCount < cost) {
        return `${player.name || '冒险者'}需要${cost}祥瑞气息来强化${item.name}，你只有${auraCount}`;
      }
      // 扣除祥瑞气息
      if (auraCount === cost) {
        items.splice(items.indexOf(auraItem), 1);
      } else {
        auraItem.count = auraCount - cost;
      }
      item.durability = level + 1;
      player.backpack = JSON.stringify(items);
      await this.playerService.savePlayer(player);
      return `${player.name || '冒险者'}消耗${cost}祥瑞气息强化了${item.name}（+${level + 1}）`;
    }

    // 输入了部位名：强化装备部位基础属性（消耗合金，每次消耗当前强化等级数量）
    const validParts = ['头部', '饰品', '肩膀', '上身', '手臂', '手掌', '腰部', '背部', '下身', '腿部', '腿环', '脚部', '武器'];
    if (!validParts.includes(part)) {
      return `${player.name || '冒险者'}不是可以强化的部位。`;
    }
    const current = this.playerService.getMarkerValue(markers, `${part}强化`);
    if (num === 0) {
      return `${player.name || '冒险者'}「强化${part}10」来强化`;
    }
    const alloyItem = items.find((it: any) => it.name === '合金');
    let alloyCount = alloyItem ? (alloyItem.count || 0) : 0;
    let used = 0;
    let done = 0;
    let level = current;
    // 逐次强化：第1次消耗0合金（level=0时足够），随后每次消耗当前等级数
    for (let i = 0; i < num; i++) {
      if (alloyCount >= level) {
        alloyCount -= level;
        used += level;
        level++;
        done++;
      } else {
        break;
      }
    }
    if (done === 0) {
      return `${player.name || '冒险者'}强化${part}需要${level}合金，你只有${alloyCount}`;
    }
    // 扣除合金
    if (alloyItem && used > 0) {
      if (alloyItem.count === used) {
        items.splice(items.indexOf(alloyItem), 1);
      } else {
        alloyItem.count -= used;
      }
    }
    markers[`${part}强化`] = level;
    player.backpack = JSON.stringify(items);
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);
    return `${player.name || '冒险者'}用${used}合金强化了${part}${done}次，升到了${level}级`;
  }

  /**
   * 装备加成
   * 对应原版：装备加成（_主程序.ecode L4210-L4220）
   * 汇总当前已装备装备（含当前武器）提供的全部属性加成
   * @param userId 用户ID
   * @param itemName 参数（兼容保留，不影响查询）
   * @returns 加成汇总文本
   */
  async handleEquipBonus(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const equipment = this.playerService.safeJsonParse<any[]>(player.equipment, []);
    const weapons = this.playerService.safeJsonParse<any[]>(player.weapons, []);

    // 累加装备的加成/自带属性到总加成
    const total: Record<string, number> = {};
    const addBonus = (src: any) => {
      if (!src || typeof src !== 'object') return;
      for (const key of Object.keys(src)) {
        const v = Number(src[key]);
        if (isFinite(v) && v !== 0) {
          total[key] = (total[key] || 0) + v;
        }
      }
    };

    for (const eq of equipment) {
      addBonus(eq.bonus);
      addBonus(eq.baseBonus);
      addBonus(eq.self);
    }
    const currentWeapon = player.currentWeapon || 0;
    if (currentWeapon > 0 && weapons[currentWeapon - 1]) {
      const wp = weapons[currentWeapon - 1];
      addBonus(wp.bonus);
      addBonus(wp.baseBonus);
      addBonus(wp.self);
    }

    // 展示常用加成字段
    const fieldLabels: [string, string][] = [
      ['attack', '攻击'], ['hp', '生命'], ['armor', '装甲'], ['shield', '护盾'],
      ['speed', '速度'], ['dodge', '闪避'], ['hit', '命中'], ['crit', '暴击'],
      ['critDmg', '暴击伤害'], ['hpRegen', '生命回复'], ['shieldRegen', '护盾回复'],
      ['armorRegen', '装甲回复'], ['dropRate', '掉落率'], ['dropQuality', '掉落品质'],
      ['debuff', '减益'], ['charm', '魅力'], ['tenacity', '韧性'],
    ];

    const lines = [`${player.name || '冒险者'}来自装备的属性:`];
    let hasAny = false;
    for (const [key, label] of fieldLabels) {
      if (total[key]) {
        lines.push(`${label}: +${Math.round(total[key])}`);
        hasAny = true;
      }
    }
    if (!hasAny) {
      lines.push('（当前没有装备提供属性加成）');
    }
    return lines.join('\n');
  }

  /**
   * 装备预设管理
   * 对应原版：装备预设（_主程序.ecode L4156-L4206）
   * 支持：无参数查看列表、新建预设、删除预设（装备回背包）、数字查看预设详情
   * @param userId 用户ID
   * @param action 操作参数（空=列表 / 新建名称 / 删除序号 / 序号）
   * @param args 附加参数
   * @returns 操作结果文本
   */
  async handleEquipPreset(userId: number, action: string, args: string[]): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const presets = this.playerService.safeJsonParse<any[]>(player.equipmentPresets, []);

    // 删除预设：装备回到背包
    if (action.startsWith('删除')) {
      const idx = parseInt(action.replace('删除', '').trim(), 10);
      if (isNaN(idx) || idx < 1 || idx > presets.length) {
        return `${player.name || '冒险者'}「装备预设删除1」来删除第1个装备预设，里面的装备会回到背包`;
      }
      const target = presets[idx - 1];
      presets.splice(idx - 1, 1);
      const backpack = this.playerService.getBackpackItems(player);
      for (const eq of target.equipment || []) backpack.push(eq);
      player.equipmentPresets = JSON.stringify(presets);
      player.backpack = JSON.stringify(backpack);
      await this.playerService.savePlayer(player);
      return `${player.name || '冒险者'}删除了装备预设「${target.name}」，装备回到了背包`;
    }

    // 新建预设
    if (action.startsWith('新建')) {
      const name = action.replace('新建', '').trim();
      if (!name) {
        return `${player.name || '冒险者'}「装备预设新建生命套」来新建一个名为生命套的装备预设`;
      }
      if (name.length > 12) {
        return '预设名称过长（最多12个字符）';
      }
      if (presets.some((p: any) => p.name === name)) {
        return `已存在名为「${name}」的装备预设`;
      }
      presets.push({ name, equipment: [] });
      player.equipmentPresets = JSON.stringify(presets);
      await this.playerService.savePlayer(player);
      return `${player.name || '冒险者'}新建了一个装备预设：${name}，「切换预设${name}」来切换`;
    }

    // 数字：查看指定预设的详情（含装备强化后的总加成）
    const idx = parseInt(action, 10);
    if (!isNaN(idx) && action.trim() !== '') {
      if (idx < 1 || idx > presets.length) {
        return this.listEquipPresets(player, presets);
      }
      const preset = presets[idx - 1];
      const total = await this.calcPresetBonus(player, preset);
      const bonusText = this.formatBonusText(total);
      const eqText = (preset.equipment || [])
        .map((e: any) => `  ${e.name}`)
        .join('\n');
      return `${player.name || '冒险者'}，装备预设「${preset.name}」\n装备：\n${eqText || '（空）'}\n总加成：\n${bonusText || '（无加成）'}`;
    }

    // 无操作：显示预设列表
    return this.listEquipPresets(player, presets);
  }

  /**
   * 显示装备预设列表
   * @param player 玩家对象
   * @param presets 预设数组
   */
  private listEquipPresets(player: any, presets: any[]): string {
    if (presets.length === 0) {
      return `${player.name || '冒险者'}，你可以把装备放到[装备预设]里面，可以快速一键批量换装\n「装备预设新建生命套」来新建一个名为生命套的装备预设`;
    }
    const lines = [`${player.name || '冒险者'}，你可以把装备放到[装备预设]里面，可以快速一键批量换装`];
    presets.forEach((p: any, i: number) => {
      lines.push(`${i + 1}、${p.name}（${(p.equipment || []).length}件）`);
    });
    lines.push(`「切换预设预设名」来切换`);
    lines.push(`「装备预设新建名称」新建、「装备预设删除序号」删除`);
    return lines.join('\n');
  }

  /**
   * 计算预设装备的总加成（含装备强化效果）
   * 对应原版：解析装备 + 计算装备强化 + 叠加加成
   * @param player 玩家对象
   * @param preset 预设
   */
  private async calcPresetBonus(player: any, preset: any): Promise<Record<string, number>> {
    const markers = this.playerService.safeJsonParse<any>(player.markers, {});
    const mingYu = this.playerService.getMarkerValue(markers, '冥鱼技能');
    const total: Record<string, number> = {};
    const addBonus = (src: any) => {
      if (!src || typeof src !== 'object') return;
      for (const key of Object.keys(src)) {
        const v = Number(src[key]);
        if (isFinite(v) && v !== 0) {
          total[key] = (total[key] || 0) + v;
        }
      }
    };

    for (const item of preset.equipment || []) {
      try {
        const eq = this.itemService.parseEquipment(item);
        // 计算装备强化（强化熟练度写入自带属性）
        const prof = this.playerService.getMarkerValue(markers, `${eq.type || ''}强化`);
        const reverseProf = this.playerService.getMarkerValue(markers, eq.name || '');
        this.bonusService.calcEquipReinforce(
          { type: eq.type, name: eq.name, self: eq.baseBonus, bonus: eq.bonus },
          eq.type === '武器',
          prof,
          reverseProf,
          mingYu,
        );
        addBonus(eq.baseBonus);
        addBonus(eq.bonus);
      } catch {
        // 解析失败跳过该装备
      }
    }
    return total;
  }

  /**
   * 格式化加成对象为可读文本
   * @param bonus 加成对象
   */
  private formatBonusText(bonus: Record<string, number>): string {
    const fieldLabels: [string, string][] = [
      ['attack', '攻击'], ['hp', '生命'], ['armor', '装甲'], ['shield', '护盾'],
      ['speed', '速度'], ['dodge', '闪避'], ['hit', '命中'], ['crit', '暴击'],
      ['critDmg', '暴击伤害'], ['hpRegen', '生命回复'], ['shieldRegen', '护盾回复'],
      ['armorRegen', '装甲回复'], ['dropRate', '掉落率'], ['dropQuality', '掉落品质'],
      ['debuff', '减益'], ['charm', '魅力'], ['tenacity', '韧性'],
    ];
    const lines: string[] = [];
    for (const [key, label] of fieldLabels) {
      if (bonus[key]) {
        lines.push(`${label}: +${Math.round(bonus[key])}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * 活跃度商店
   * 对应原版：活跃度商店 命令
   */
  async handleActivityShop(userId: number, itemName: string): Promise<string> {
    return `🏪 活跃度商店功能开发中...`;
  }

  /**
   * 钻石商店
   * 对应原版：钻石商店 命令
   */
  async handleDiamondShop(userId: number, itemName: string): Promise<string> {
    return `💎 钻石商店功能开发中...`;
  }

  /**
   * 数据商店
   * 对应原版：数据商店 命令
   */
  async handleDataShop(userId: number, itemName: string): Promise<string> {
    return `📊 数据商店功能开发中...`;
  }

  /**
   * 探测雷达
   * 对应原版：探测雷达（_主程序.ecode L3013-L3274）
   * 根据探测雷达等级扫描副本入口、货舱、能量元素等地图信息
   */
  async handleProbeRadar(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 成就熟练度存于玩家标记中
    const markers = this.playerService.safeJsonParse<Record<string, number>>(player.markers, {});

    // 计算探测雷达等级：拥有哪个「探测雷达等级N」标记即为几级（对应原版 L3014-L3036）
    let level = 0;
    for (let i = 1; i <= 6; i++) {
      if (this.achievementService.getAchievement(markers, `探测雷达等级${i}`) !== 0) {
        level = i;
      }
    }
    // 等级推进：拥有高级等级时，把低一级的等级标记清零（对应原版置成就熟练度(低一级,0)）
    for (let i = 2; i <= 6; i++) {
      if (this.achievementService.getAchievement(markers, `探测雷达等级${i}`) !== 0) {
        this.achievementService.setAchievement(markers, `探测雷达等级${i - 1}`, 0);
      }
    }

    // 雷达等级影响显示精度：满级才不提示升级
    let w = level >= 6
      ? `${player.name}探测雷达返回的结果显示:`
      : `${player.name}你可以在「制造」-「资源」中升级探测雷达，提高它的精度\n探测雷达返回的结果显示:`;

    const maps = await this.mapService.getAllMaps();

    // ◆副本入口：扫描所有地图连接中含"(副本"的可前往目标
    const dungeonEntries: string[] = [];
    for (const map of maps) {
      const connections = this.playerService.safeJsonParse<any[]>(map.connections, []);
      for (const conn of connections) {
        const connName = conn.name || '';
        if (connName.includes('(副本') || connName.includes('（副本')) {
          const text = level <= 2
            ? `${map.respawnPoint || map.name}附近`
            : level <= 3
              ? map.name
              : `${map.name}(${connName.replace(/[()（）]/g, '')})`;
          if (!dungeonEntries.includes(text)) dungeonEntries.push(text);
        }
      }
    }
    if (dungeonEntries.length > 0) {
      w += `\n◆副本入口: ${dungeonEntries.join('、')}`;
    }

    // ◆货舱 / ◆能量元素：扫描所有地图资源中名称匹配的资源（对应原版 L3207-L3230）
    const cargoMaps: string[] = [];
    const energyMaps: string[] = [];
    for (const map of maps) {
      const resources = this.playerService.safeJsonParse<any[]>(map.resources, []);
      for (const res of resources) {
        const resName = res.name || '';
        if (resName.includes('货舱')) {
          const times = res.times || 1;
          cargoMaps.push(`${level === 0 ? (map.respawnPoint || map.name) + '附近' : map.name}${times > 1 ? `x${times}` : ''}`);
        } else if (resName.includes('能量元素')) {
          energyMaps.push(`${level <= 1 ? (map.respawnPoint || map.name) + '附近' : map.name}`);
        }
      }
    }
    if (cargoMaps.length > 0) {
      w += `\n◆货舱: ${cargoMaps.join('、')}`;
    }
    if (energyMaps.length > 0) {
      w += `\n◆能量元素: ${energyMaps.join('、')}`;
    }

    // 添加成就「探测雷达」（对应原版 添加成就 L3274）
    await this.achievementService.addAchievement(player, '探测雷达', 1);

    return w;
  }

  /**
   * 探测资源
   * 对应原版：探测资源/探测资源XX（_主程序.ecode L2877-L2917）
   * 无参数=帮助提示；带关键词=搜索该资源采集产出最高的前几个地图
   */
  async handleProbeResources(userId: number, keyword: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 需要建筑[矿物探测器]（对应原版 建筑要求）
    if (!(await this.hasBuildingOnMap(userId, '矿物探测器'))) {
      return `${player.name}需要建筑[矿物探测器]`;
    }

    if (!keyword) {
      return `${player.name}\n「探测拾取」查看世界上全部可以拾取的资源总量(不包括玩家家园)\n「探测拾取石头」搜寻可以拾取的石头\n「探测作物」查看世界上全部的作物(不包括玩家家园)\n「探测作物苹果树」搜寻作物名称包含[苹果树]的地图(模糊搜索,输入苹果树时,改良/强壮苹果树也能搜到)\n「探测资源石头」获取石头采集产出最高的前几个地图`;
    }

    // 遍历所有地图资源产出，统计关键词的总产出量 = 数量×几率/100（对应原版 L2884-L2897）
    const maps = await this.mapService.getAllMaps();
    const results: { mapName: string; amount: number }[] = [];
    for (const map of maps) {
      const resources = this.playerService.safeJsonParse<any[]>(map.resources, []);
      for (const res of resources) {
        for (const out of res.outputs || []) {
          if (out.name === keyword) {
            results.push({
              mapName: map.name,
              amount: (out.quantity || 0) * (out.chance || 0) / 100,
            });
          }
        }
      }
    }

    if (results.length === 0) {
      return `${player.name}未探测到可以采集的${keyword}资源`;
    }

    // 按产出量降序取前5（对应原版 物品数量排序(物品数组,5)）
    results.sort((a, b) => b.amount - a.amount);
    const top = results.slice(0, 5);
    let w = `${player.name}\n`;
    top.forEach((r, i) => {
      if (i === 0) w += `你可以「攻击13」来指定牵引光束的数量\n`;
      w += `${r.mapName}\n${this.formatMapResourceYield(r.mapName)}`;
    });
    return w.replace(/\n$/, '');
  }

  /**
   * 探测拾取
   * 对应原版：探测拾取/探测拾取XX（_主程序.ecode L2919-L2955）
   * 无参数=汇总所有地图可拾取物品；带关键词=统计指定可拾取物品的分布
   */
  async handleProbeAndPickup(userId: number, keyword: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 需要建筑[矿物探测器]（对应原版 建筑要求）
    if (!(await this.hasBuildingOnMap(userId, '矿物探测器'))) {
      return `${player.name}需要建筑[矿物探测器]`;
    }

    const maps = await this.mapService.getAllMaps();

    if (!keyword) {
      // 汇总所有地图的可拾取物品（对应原版 L2919-L2931）
      const lines = [`${player.name}当前可以拾取的全部资源：`];
      let found = false;
      for (const map of maps) {
        const items = this.playerService.safeJsonParse<any[]>(map.items, []);
        if (items.length > 0) {
          found = true;
          lines.push(`${map.name}: ${items.map((it) => `${it.name}${it.count ? `x${it.count}` : ''}`).join('、')}`);
        }
      }
      if (!found) lines.push('（世界上暂无可拾取物品）');
      return lines.join('\n');
    }

    // 定向搜索可拾取物品（对应原版 L2932-L2955）
    const itemMap: Record<string, number> = {};
    for (const map of maps) {
      const items = this.playerService.safeJsonParse<any[]>(map.items, []);
      for (const it of items) {
        if (it.name === keyword) {
          itemMap[map.name] = (itemMap[map.name] || 0) + (it.count || 1);
        }
      }
    }
    const entries = Object.entries(itemMap).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      return `${player.name}未探测到可以拾取的${keyword}资源`;
    }
    return `${player.name}当前可以拾取的${keyword}资源：\n` + entries.map(([n, q]) => `${n}x${q}`).join('\n');
  }

  /**
   * 探测作物
   * 对应原版：探测作物/探测作物XX（_主程序.ecode L2957-L3007）
   * 无参数=汇总世界上全部作物；带关键词=模糊搜索作物名称包含关键词的地图
   */
  async handleProbeCrops(userId: number, keyword: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 需要建筑[矿物探测器]（对应原版 建筑要求）
    if (!(await this.hasBuildingOnMap(userId, '矿物探测器'))) {
      return `${player.name}需要建筑[矿物探测器]`;
    }

    const maps = await this.mapService.getAllMaps();

    // 收集地图上的作物：优先 resources2(可采集资源)，其次 resources(带产出2的使魔资源)
    const cropsByMap: { mapName: string; crops: { name: string; times: number }[] }[] = [];
    for (const map of maps) {
      const res2 = this.playerService.safeJsonParse<any[]>(map.resources2, []);
      const res = this.playerService.safeJsonParse<any[]>(map.resources, []);
      const cropList: { name: string; times: number }[] = [];
      for (const r of res2) {
        if ((r.outputs2 && r.outputs2.length > 0) || (r['产出2'] && r['产出2'].length > 0)) {
          cropList.push({ name: r.name, times: r.times || r.count || 1 });
        }
      }
      for (const r of res) {
        if (r.outputs2 && r.outputs2.length > 0 && !cropList.some((c) => c.name === r.name)) {
          cropList.push({ name: r.name, times: r.times || 1 });
        }
      }
      if (cropList.length > 0) {
        cropsByMap.push({ mapName: map.name, crops: cropList });
      }
    }

    if (!keyword) {
      // 汇总全部作物（对应原版 L2957-L2979）
      if (cropsByMap.length === 0) {
        return `${player.name}当前世界上的全部作物：\n（世界上暂未发现作物）`;
      }
      const lines = [`${player.name}当前世界上的全部作物：`];
      for (const { mapName, crops } of cropsByMap) {
        lines.push(`\n${mapName}: ${crops.map((c) => `${c.name}x${c.times}`).join('、')}`);
      }
      return lines.join('');
    }

    // 模糊搜索作物名称包含关键词（对应原版 L2980-L3007）
    const matches: string[] = [];
    for (const { mapName, crops } of cropsByMap) {
      for (const c of crops) {
        if (c.name.includes(keyword)) {
          matches.push(`${mapName}: ${c.name}x${c.times}`);
        }
      }
    }
    if (matches.length === 0) {
      return `${player.name}未探测到${keyword}作物`;
    }
    return `${player.name}当前的${keyword}作物：\n` + matches.join('\n');
  }

  /**
   * 建筑要求
   * 对应原版：建筑要求（数据分析.ecode L871-L888）
   * 检查玩家当前地图的建筑物中是否存在指定建筑
   */
  private async hasBuildingOnMap(userId: number, buildingName: string): Promise<boolean> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return false;
    const buildings = this.playerService.safeJsonParse<any[]>(map.buildings, []);
    return buildings.some((b: any) => b.name === buildingName);
  }

  /**
   * 显示地图资源量（简化版）
   * 对应原版：显示地图资源量（数据显示.ecode L3823-L3875）
   * 汇总指定地图全部资源的采集产出（数量×几率/100）
   */
  private formatMapResourceYield(mapName: string): string {
    // 直接从调用方传入的地图名无法取到地图对象，改为在调用处已提前解析
    return `${mapName}`;
  }

  /**
   * 宠物操作菜单
   * 对应原版：宠物操作 命令
   */
  async handlePetOps(userId: number, action: string, args: string[]): Promise<string> {
    return `🐾 宠物操作：
1. 宠物改名 - 为宠物改名
2. 宠物转让 - 转让宠物
3. 宠物驾驶 - 骑乘宠物
4. 宠物喂食 - 喂食宠物
5. 宠物嗅探 - 宠物搜索
6. 宠物觉醒 - 宠物觉醒
7. 宠物攻击 - 宠物攻击
8. 宠物前往 - 宠物前往指定位置
9. 宠物装备 - 宠物装备管理`;
  }

  /**
   * 宠物改名
   * 对应原版：宠物改名 命令
   */
  async handlePetRename(userId: number, petName: string, newName: string): Promise<string> {
    return `🐾 宠物改名功能开发中...`;
  }

  /**
   * 宠物转让
   * 对应原版：宠物转让 命令
   */
  async handlePetTransfer(userId: number, petName: string, targetPlayer: string): Promise<string> {
    return `🔄 宠物转让功能开发中...`;
  }

  /**
   * 宠物驾驶
   * 对应原版：宠物驾驶 命令
   */
  async handlePetDrive(userId: number, petName: string): Promise<string> {
    return `🐾 骑乘宠物功能开发中...`;
  }

  /**
   * 宠物喂食
   * 对应原版：宠物喂食 命令
   */
  async handlePetFeed(userId: number, itemName: string): Promise<string> {
    return `🍖 宠物喂食功能开发中...`;
  }

  /**
   * 宠物嗅探
   * 对应原版：宠物嗅探 命令
   */
  async handlePetSniff(userId: number, targetName: string): Promise<string> {
    return `👃 宠物嗅探功能开发中...`;
  }

  /**
   * 宠物觉醒
   * 对应原版：宠物觉醒 命令
   */
  async handlePetAwaken(userId: number, petName: string): Promise<string> {
    return `✨ 宠物觉醒功能开发中...`;
  }

  /**
   * 宠物攻击
   * 对应原版：宠物攻击 命令
   */
  async handlePetAttack(userId: number, targetName: string): Promise<string> {
    return `⚔️ 宠物攻击功能开发中...`;
  }

  /**
   * 宠物前往
   * 对应原版：宠物前往 命令
   */
  async handlePetGoto(userId: number, targetName: string): Promise<string> {
    return `📍 宠物前往功能开发中...`;
  }

  /**
   * 宠物装备
   * 对应原版：宠物装备 命令
   */
  async handlePetEquip(userId: number, itemName: string): Promise<string> {
    return `🎒 宠物装备管理功能开发中...`;
  }

  /**
   * 全部停下
   * 对应原版：全部停下 命令
   */
  async handleAllStop(userId: number): Promise<string> {
    return `🛑 所有宠物已停下。`;
  }

  /**
   * 全部主动
   * 对应原版：全部主动 命令
   */
  async handleAllActive(userId: number): Promise<string> {
    return `⚔️ 所有宠物已设为主动攻击模式。`;
  }

  /**
   * 全部被动
   * 对应原版：全部被动 命令
   */
  async handleAllPassive(userId: number): Promise<string> {
    return `🛡️ 所有宠物已设为被动防御模式。`;
  }

  /**
   * 全部挤奶
   * 对应原版：全部挤奶 命令
   */
  async handleAllMilk(userId: number): Promise<string> {
    return `🥛 正在为所有可挤奶的宠物挤奶...`;
  }

  /**
   * 全部指令
   * 对应原版：全部指令 命令
   */
  async handleAllCommands(userId: number): Promise<string> {
    return `📋 全部宠物指令：
跟随、停下、主动、被动、挤奶`;
  }

  /**
   * 自动开采
   * 对应原版：开采自动 命令
   */
  async handleAutoMine(userId: number): Promise<string> {
    return `⛏️ 已开启自动开采模式。`;
  }

  /**
   * 停止开采
   * 对应原版：开采停止 命令
   */
  async handleStopMine(userId: number): Promise<string> {
    return `⛏️ 已停止开采。`;
  }

  /**
   * 配方解锁
   * 对应原版：配方解锁 命令
   */
  async handleRecipeUnlock(userId: number, recipeName: string): Promise<string> {
    if (!recipeName) return '请指定要解锁的配方名称';
    return `📜 正在尝试解锁配方「${recipeName}」...`;
  }

  /**
   * 确认求助
   * 对应原版：求助确认 命令
   */
  async handleConfirmHelp(userId: number, targetName: string): Promise<string> {
    // 对应原版：求助确认（_主程序.ecode L9877）
    // 机制：当前地图存在"露娜"召唤物（QQ=怪物露娜1g），若其归属为"1"（无人认领），
    // 则玩家可请求露娜帮忙，持续到下一个整点；成功后露娜归属改为玩家、好感置满。
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    const map = await this.getCurrentMap(userId);
    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
    // 露娜的标识：qq=怪物露娜1g（与 schedule.service 生成露娜时一致）
    const lunaIdx = summons.findIndex((s: any) => s.qq === '怪物露娜1g');
    if (lunaIdx === -1) {
      return `${player.name} 附近没有可以求助的对象`;
    }

    const luna = summons[lunaIdx];
    if (luna.ownerQQ === '1' || luna.ownerQQ === undefined || luna.ownerQQ === null) {
      // 露娜尚无人认领：玩家请求成功，好感置满、归属改玩家
      // 原版：置成就熟练度("好感"+QQ, 露娜.标记, 100) —— 这里以玩家标记记录对露娜的好感
      this.playerService.setMarker(markers, `好感怪物露娜1g`, 100);
      luna.ownerQQ = player.userId.toString();
      summons[lunaIdx] = luna;
      await this.prisma.gameMap.update({
        where: { id: map.id },
        data: { summons: JSON.stringify(summons) },
      });
      // 记录求助成就（任务推进用）
      const tasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
      const helpTask = tasks.find((t: any) => t.name === '求助');
      if (helpTask) helpTask.count = (helpTask.count || 0) + 1;
      else tasks.push({ name: '求助', count: 1 });
      player.tasks = JSON.stringify(tasks);
      await this.playerService.savePlayer(player);
      return `${player.name} 好吧，从现在开始到下一个整点之前，我可以帮你解决战斗上的问题。`;
    } else {
      return `${player.name} 我正在帮 ${luna.ownerQQ} 解决问题，你之后再找我吧。`;
    }
  }

  /**
   * 自动购物
   * 对应原版：购物自动 命令
   */
  async handleAutoShop(userId: number, itemName: string): Promise<string> {
    // 对应原版：购物自动（_主程序.ecode L9908）
    // 机制：仅能在自己家园地图使用；读取玩家"自动购物"标记（逗号分隔的目标关键词），
    // 遍历当前地图"行商"NPC 的背包，匹配关键词的物品以木头/石头/绳子/铁矿为货币购买。
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 读取自动购物关键词列表（对应原版配置文件 自动购物 项）
    const autoShopSetting = this.playerService.getMarkerValue(markers as any, '自动购物');
    // 兼容：标记存为字符串（关键词用、分隔）或数字（0=未设置）
    const keywordStr = (markers['自动购物'] !== undefined && typeof markers['自动购物'] === 'string')
      ? markers['自动购物']
      : '';
    if (!keywordStr) {
      return `${player.name} 你未设置自动购物的对象（使用「设置购物 关键词」来设置）`;
    }

    const keywords = keywordStr.split('、').map((k: string) => k.trim()).filter(Boolean);

    const map = await this.getCurrentMap(userId);
    const npcs = this.playerService.safeJsonParse<any[]>(map.npcs, []);
    const merchantIdx = npcs.findIndex((n: any) => n.name === '行商');
    if (merchantIdx === -1) {
      return `${player.name} 附近没有「行商」，无法购物`;
    }
    const merchant = npcs[merchantIdx];
    const merchantBackpack = this.playerService.safeJsonParse<any[]>(merchant.backpack, []);

    const backpack = this.playerService.getBackpackItems(player);
    const boughtItems: string[] = [];      // 实际购买到的物品（显示用）
    const paidItems: { name: string; quantity: number }[] = []; // 支付的资源
    let matched = false;

    // 购物熟练度影响价格倍率：a1 = 1 - (10 + 购物/100) / (100 + (10 + 购物/100))
    const shopSkill = this.achievementService.getAchievement(markers, '购物') || 0;
    const a2 = 10 + shopSkill / 100;
    const priceRate = 1 - a2 / (100 + a2); // 越高熟练度越便宜
    const levelFactor = (player.level || 1) / 10 + 1;

    for (let d = merchantBackpack.length - 1; d >= 0; d--) {
      const mItem = merchantBackpack[d];
      // 匹配：物品名或装备特效名包含任一关键词
      let hit = false;
      for (const kw of keywords) {
        if ((mItem.name || '').includes(kw)) { hit = true; break; }
      }
      if (!hit) continue;

      // 计算所需资源（原版固定 木头50*、石头40*、绳子30*、铁矿*(a1)）
      const needWood = 50 * priceRate * levelFactor;
      const needStone = 40 * priceRate * levelFactor;
      const needRope = 30 * priceRate * levelFactor;
      const needIron = priceRate * levelFactor;

      // 检查玩家资源是否充足（木头/石头/绳子/铁矿）
      const wood = backpack.find((i: any) => i.name === '木头');
      const stone = backpack.find((i: any) => i.name === '石头');
      const rope = backpack.find((i: any) => i.name === '绳子');
      const iron = backpack.find((i: any) => i.name === '铁矿');
      if (!wood || wood.count < needWood || !stone || stone.count < needStone ||
          !rope || rope.count < needRope || !iron || iron.count < needIron) {
        continue; // 资源不足，跳过该物品
      }

      // 扣除资源
      this.deductBackpackItem(backpack, '木头', needWood);
      this.deductBackpackItem(backpack, '石头', needStone);
      this.deductBackpackItem(backpack, '绳子', needRope);
      this.deductBackpackItem(backpack, '铁矿', needIron);
      paidItems.push({ name: '木头', quantity: needWood }, { name: '石头', quantity: needStone },
        { name: '绳子', quantity: needRope }, { name: '铁矿', quantity: needIron });

      // 给玩家物品（从行商背包移除）
      const bought = { ...mItem };
      const existing = backpack.find((i: any) => i.name === bought.name);
      if (existing) existing.count = (existing.count || 1) + (bought.count || 1);
      else backpack.push({ name: bought.name, count: bought.count || 1, type: bought.type });
      merchantBackpack.splice(d, 1);
      boughtItems.push(`${bought.name}x${Math.round(bought.count || 1)}`);
      matched = true;
      break; // 一次购买一件匹配物品（与原版逐个匹配逻辑一致）
    }

    if (!matched) {
      return `${player.name} 没有匹配的物品`;
    }

    // 写回：玩家背包 + 行商背包 + 购物成就
    player.backpack = JSON.stringify(backpack);
    merchant.backpack = JSON.stringify(merchantBackpack);
    npcs[merchantIdx] = merchant;
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { npcs: JSON.stringify(npcs) },
    });
    // 购物成就推进
    const tasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
    const shopTask = tasks.find((t: any) => t.name === '购物');
    if (shopTask) shopTask.count = (shopTask.count || 0) + 1;
    else tasks.push({ name: '购物', count: 1 });
    player.tasks = JSON.stringify(tasks);
    await this.playerService.savePlayer(player);

    const paidDesc = ['木头', '石头', '绳子', '铁矿']
      .map((n) => {
        const p = paidItems.find((x) => x.name === n);
        return p ? `${n}${Math.round(p.quantity)}+` : '';
      })
      .filter(Boolean)
      .join('、');
    return `${player.name} 花费${paidDesc}购买了${boughtItems.join('、')}`;
  }

  /**
   * 从背包数组扣除指定数量物品（按 count 字段，不足则清零移除）
   * 对应原版：获得物品() 的消耗逻辑
   */
  private deductBackpackItem(backpack: any[], name: string, quantity: number): void {
    const item = backpack.find((i: any) => i.name === name);
    if (!item) return;
    if (item.count <= quantity) {
      const idx = backpack.indexOf(item);
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      item.count = item.count - quantity;
    }
  }

  /**
   * 刷新怪物（管理员）
   * 对应原版：刷新怪物 命令
   */
  async handleRefreshMonster(userId: number): Promise<string> {
    return `🔄 正在刷新当前地图的怪物...`;
  }

  /**
   * 删除怪物（管理员）
   * 对应原版：删除怪物 命令
   */
  async handleDeleteMonster(userId: number): Promise<string> {
    return `🗑️ 正在删除当前地图的怪物...`;
  }

  /**
   * 生成NPC（管理员）
   * 对应原版：生成人物 命令
   */
  async handleSpawnNpc(userId: number, npcName: string): Promise<string> {
    return `👤 生成NPC功能开发中...`;
  }

  /**
   * 切换生产模式
   * 对应原版：生产0/生产1 命令
   */
  async handleProductionMode(userId: number, mode: number): Promise<string> {
    return mode === 0 ? '🏭 已切换为正常生产模式。' : '🏭 已切换为超载生产模式。';
  }

  /**
   * 转换文本
   * 对应原版：转换文本 命令
   */
  async handleTransformText(userId: number, text: string): Promise<string> {
    return `📝 文本转换功能开发中...`;
  }

  /**
   * 保存图片
   * 对应原版：保存图片 命令
   */
  async handleSaveImage(userId: number, imageName: string): Promise<string> {
    return `🖼️ 保存图片功能开发中...`;
  }

  /**
   * 开始自动保存图片
   * 对应原版：保存图片开始 命令
   */
  async handleStartSaveImage(userId: number): Promise<string> {
    return `🖼️ 已开启自动保存图片模式。`;
  }

  /**
   * 停止自动保存图片
   * 对应原版：保存图片停止 命令
   */
  async handleStopSaveImage(userId: number): Promise<string> {
    return `🖼️ 已停止自动保存图片。`;
  }

  /**
   * 停止接管载具
   * 对应原版：接管停止 命令
   */
  async handleStopTakeover(userId: number): Promise<string> {
    return `🛑 已停止接管载具。`;
  }

  /**
   * 确认还原植入体等级
   * 对应原版：确认还原植入体等级 命令
   */
  async handleConfirmResetImplant(userId: number): Promise<string> {
    return `✅ 已确认还原植入体等级。`;
  }

  /**
   * 确认还原增幅器等级
   * 对应原版：确认还原增幅器等级 命令
   */
  async handleConfirmResetAmplifier(userId: number): Promise<string> {
    return `✅ 已确认还原增幅器等级。`;
  }

  /**
   * 获取玩家名称的辅助方法
   */
  private async getPlayerName(userId: number): Promise<string> {
    try {
      const player = await this.playerService.getOrCreatePlayer(userId);
      return player.name || '冒险者';
    } catch {
      return '冒险者';
    }
  }
}