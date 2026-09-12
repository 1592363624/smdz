/**
 * 游戏引擎主服务
 * 对应原版易语言：_主程序.ecode 的核心逻辑
 * 负责协调各子服务，提供统一的游戏操作入口
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { BonusService, BonusData } from './bonus.service';
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
import { FeedbackService } from '../feedback/feedback.service';
import { TaskService } from './task.service';
import { GameSupportService } from './game-support.service';
import { GatherPanelService } from './commands/gather-panel.service';
import { MovementVehicleService } from './commands/movement-vehicle.service';
import { RescueWhiteService } from './commands/rescue-white.service';
import { DungeonChallengeService } from './commands/dungeon-challenge.service';
import { DelayedSettleService } from './commands/delayed-settle.service';
import { HomeBuildService } from './commands/home-build.service';
import type { QuestSource } from './commands/quest-dialogue.service';
import { QuestDialogueService } from './commands/quest-dialogue.service';
import { ShopTradeService } from './commands/shop-trade.service';
import { SkillCommandService } from './commands/skill-command.service';
import { EquipCommandService } from './commands/equip-command.service';
import { PetCommandService } from './commands/pet-command.service';
import { TimeSettleService } from './commands/time-settle.service';
import { FusionCraftService } from './commands/fusion-craft.service';
import { AdminCommandService } from './commands/admin-command.service';
import { RankingCommandService } from './commands/ranking-command.service';
import { ShortcutService } from './shortcut.service';
import { StatsService } from './stats.service';
import { CombatStateService } from './combat-state.service';
import { PlayerMutateService } from './player-mutate.service';
import { DelayedTaskService } from './delayed-task.service';
import { AutoMineService } from './auto-mine.service';
import { VitalityService } from './vitality.service';
import { HandbookService } from './handbook.service';
import { GlobalProficiencyService } from './global-proficiency.service';
import { normalizeGameText, formatDisplayNumber, formatDamageText, formatMsDurationText, formatSecondsDurationText, roundItemQuantity } from '../../common/utils/game-text.util';
import { mergeBackpackItem, lookupFromStaticData } from './item-normalize.util';
// 装备引用解析（基础名 + 品质码 + ·特效）单一实现，与「锁定装备/解锁」同源；
// equipmentQualityLabel = 装备栏品质展示标签（大写品质码）单一实现，文本面板/网页快照共用。
import { resolveEquipmentRefIndex, equipmentQualityLabel } from './equipment-ref.util';
import { filterActive, formatRemain, remainSeconds, toExpireMs } from './expire-time.util';
import { buildFamiliarGateMenu } from './familiar-menu.util';
import { asJsonValue } from '../../common/utils/json-value.util';
// 三池数值出口归一化（第四道闸）：回复/百分比缩放/封顶统一走 player-pool.util 单一实现，
// 两位小数 + 残值(<0.01)归零，杜绝 0.02 这类脏值残留导致「残血不死 + 伤害恒为 0」死锁。
import { capPoolValue, normalizePoolValue, normalizePools, round2 } from './player-pool.util';

/** 图鉴条目：name 必填，brief=列表页简介，detail=详情页逐行文本 */
interface HandbookEntry {
  name: string;
  brief?: string;
  detail?: string[];
}

@Injectable()
export class GameService {

  private readonly logger = new Logger(GameService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly bonusService: BonusService,
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
    private readonly feedbackService: FeedbackService,
    private readonly taskService: TaskService,
    private readonly shortcutService: ShortcutService,
    private readonly statsService: StatsService,
    private readonly combatState: CombatStateService,
    // —— 指令域子服务（P2/P3/P4 拆分收口，改为必选注入）——
    // 测试桩统一走 test/helpers/game-service-stub.factory.ts（createGameServiceStub），
    // 按生产构造签名惰性挂载支撑层与全部子服务，不再依赖门面懒构造桥。
    private readonly support: GameSupportService,
    private readonly rankingService: RankingCommandService,
    private readonly adminCommandService: AdminCommandService,
    private readonly fusionCraftService: FusionCraftService,
    private readonly timeSettleService: TimeSettleService,
    private readonly petCommandService: PetCommandService,
    private readonly equipCommandService: EquipCommandService,
    private readonly skillCommandService: SkillCommandService,
    private readonly shopTradeService: ShopTradeService,
    private readonly questDialogueService: QuestDialogueService,
    private readonly homeBuildService: HomeBuildService,
    private readonly delayedSettleService: DelayedSettleService,
    private readonly dungeonChallengeService: DungeonChallengeService,
    private readonly rescueWhiteService: RescueWhiteService,
    private readonly movementVehicleService: MovementVehicleService,
    private readonly gatherPanelService: GatherPanelService,
    // —— 存量可选依赖（重构前即为 @Optional，兼容既有位置传参测试桩）——
    @Optional() private readonly autoMineService?: AutoMineService,
    // 活力上限与恢复公式共用规则服务，确保魅力历史值和旧存档兜底一致。
    @Optional() private readonly vitalityService?: VitalityService,
    // 玩家状态收口入口（Actor 式写入口）。未注入时走 mutatePlayer 的等价回退路径。
    @Optional() private readonly playerMutate?: PlayerMutateService,
    // 持久化延时任务（采集/移动/救援/装填/副本关闭的跨重启排程）。
    // @Optional：测试桩以 Object.create 构造或老位置传参时走「无排程」降级，
    // 由启动迁移（recoverOrphanDelayedMarkers）与既有扫描兜底。
    @Optional() private readonly delayedTaskService?: DelayedTaskService,
    // 图鉴服务（HandbookService）负责 20 分类的详情渲染与搜索；
    // 用 @Optional 是为兼容现有 Object.create 测试桩，新测试请直接注入。
    @Optional() private readonly handbookService?: HandbookService,
    // 全局熟练度（原版 全局标记）：技能面板「世界等级 / 怪物等级+」的唯一真相源。
    // @Optional 兼容 Object.create / 位置传参的既有测试桩。
    @Optional() private readonly globalProficiency?: GlobalProficiencyService,
) {}

  /**
   * 玩家状态变更的收口入口（对 PlayerMutateService.mutate 的薄封装）。
   *
   * 生产环境由 Nest 注入真实的 PlayerMutateService（Actor 式：锁内单一快照、
   * 统一落库、货币审计、嵌套复用）。测试桩若不提供该依赖，则退化为等价的
   * 「enqueueUserWrite + getPlayerData + fn + savePlayer」路径，保持旧行为不变，
   * 避免逐个测试桩补依赖。
   */
  private mutatePlayer<T>(userId: number, fn: (ctx: any) => Promise<T> | T): Promise<T> {
    return this.support.mutatePlayer(userId, fn);
  }

  /** 模块初始化：注册各延时任务的结算 handler，并把存量标记迁移为延时任务。 */
  onModuleInit(): void {
    if (!this.delayedTaskService) return;
    const dts = this.delayedTaskService;
    dts.registerHandler('gather', async (task) => {
      await this.settleGatherResource(Number(task.userId));
    });
    dts.registerHandler('move', async (task) => {
      const targetMapId = Number(task.payload?.targetMapId || 0);
      const targetName = String(task.payload?.targetName || '');
      if (!targetMapId) return;
      await this.performArrival(Number(task.userId), targetMapId, targetName);
    });
    dts.registerHandler('rescue', async (task) => {
      if (!task.payload?.marker) return;
      await this.completeRescue(Number(task.userId), task.payload.marker);
    });
    dts.registerHandler('reload', async (task) => {
      await this.completeReload(Number(task.userId), String(task.payload?.mode || 'plana'));
    });
    dts.registerHandler('dungeonClose', async (task) => {
      const group = String(task.payload?.group || '');
      if (group) await this.dungeonService.closeDungeon(group);
    });
    // 手动载具开采结算（原版 _主程序.ecode L7534「开采1c2c」60秒延时）
    dts.registerHandler('mine', async (task) => {
      await this.settleManualMine(Number(task.userId));
    });
    // 补魔结算（原版 _主程序.ecode L7158「覅b魔w成」30秒延时）
    dts.registerHandler('refill', async (task) => {
      await this.completeRefill(Number(task.userId));
    });
    // 召唤货舱结算（原版 _主程序.ecode L6298「召h货1藏」6秒延时：扣信号枪生成货舱资源）
    dts.registerHandler('cargo', async (task) => {
      await this.completeCargoSummon(Number(task.userId), Number(task.payload?.count || 0));
    });
    // 维修载具结算（原版 _主程序.ecode L10449 新建延时「维修wcc1」a 秒）：
    // 延时到期后真正修好载具，并把结算文本广播给玩家（延时路径无指令收尾）。
    dts.registerHandler('repair', async (task) => {
      const text = await this.completeVehicleRepair(Number(task.userId));
      if (text) await this.chatService.broadcastSystem('世界频道', text, Number(task.userId)).catch(() => undefined);
    });
    // 建造地基完工结算（工作标记60秒到期）：发经验+推进任务，完工文本广播世界频道。
    dts.registerHandler('homeFoundation', async (task) => {
      const uid = Number(task.userId);
      const text = await this.familiarSystemService.settleHomeFoundation(uid);
      if (text) await this.chatService.broadcastSystem('世界频道', text, uid).catch(() => undefined);
    });
    // 建造房子完工结算（工作标记120秒到期）：发经验+推进任务，完工文本广播世界频道。
    dts.registerHandler('homeConstruct', async (task) => {
      const uid = Number(task.userId);
      const text = await this.familiarSystemService.settleHomeConstruct(uid);
      if (text) await this.chatService.broadcastSystem('世界频道', text, uid).catch(() => undefined);
    });
    // 采集代发言播报（原版 地图操作.ecode L1620-1621：新建延时(代发言+复活点, 2秒)）。
    // 代发言是资源配置的内部延时指令名，数据中现存：覅本清（副本通关链）、
    // 覅下一层（使魔挑战下一层）、召唤1白1（已在采集入口内联召唤，不走此排程）。
    dts.registerHandler('proxySpeak', async (task) => {
      const command = String(task.payload?.command || '');
      const uid = Number(task.userId);
      if (!command || !Number.isFinite(uid) || uid <= 0) return;
      let text = '';
      await this.playerService.enqueueUserWrite(uid, async () => {
        if (command === '覅本清') {
          text = await this.handleClearDungeon(uid);
        } else if (command === '覅下一层') {
          text = await this.familiarChallengeNextLayer(uid);
        }
      });
      if (text) {
        await this.chatService.broadcastSystem('世界频道', text, uid).catch(() => undefined);
      }
    });
    // 存量迁移：把上一代实现遗留在 markers 里的「采集中/移动中/救援」状态
    // 补建成延时任务（幂等：schedule 先删后插，标记已结算时结算 handler 自行空转）。
    void this.recoverOrphanDelayedMarkers().catch((e: any) => {
      this.logger.warn(`延时任务存量迁移失败（下次重启重试）: ${e?.message || e}`);
    });
  }

  /**
   * 启动迁移：扫一遍玩家 markers，把「采集中」「移动中」以及 markers2 里的救援标记
   * 补建成延时任务行。正常情况下这些状态在创建时就会同时排程任务，本方法只服务于
   * （a）首次部署时仍挂着旧实现内存定时器的玩家；（b）异常情况下任务行丢失的兜底。
   */
  private async recoverOrphanDelayedMarkers(): Promise<void> {
    if (!this.delayedTaskService) return;
    const players = await this.prisma.player.findMany({
      where: { userId: { gt: 0 } },
      select: { userId: true, markers: true, markers2: true },
    });
    const now = Date.now();
    let recovered = 0;
    for (const row of players || []) {
      const userId = Number(row.userId);
      if (!userId) continue;
      const markers = asJsonValue<Record<string, any>>(row.markers, {});
      const gathering = markers['采集中'];
      if (gathering && typeof gathering === 'object' && Number(gathering.settleAt || 0) > 0) {
        await this.delayedTaskService.schedule({
          type: 'gather',
          userId,
          runAt: Math.max(now, Number(gathering.settleAt)),
        });
        recovered += 1;
      }
      const movingStr = markers['移动中'];
      if (movingStr) {
        try {
          const moving = asJsonValue<{ targetName?: string; targetMapId?: number; arriveAt?: number } | null>(movingStr, null);
          if (moving?.arriveAt && moving?.targetMapId) {
            await this.delayedTaskService.schedule({
              type: 'move',
              userId,
              runAt: Math.max(now, Number(moving.arriveAt)),
              payload: { targetMapId: Number(moving.targetMapId), targetName: String(moving.targetName || '') },
            });
            recovered += 1;
          }
        } catch { /* 移动中标记损坏：忽略，由原有逻辑兜底 */ }
      }
      const markers2 = asJsonValue<any[]>(row.markers2, []);
      for (const marker of markers2) {
        const name = marker?.name ?? marker?.名称;
        if (marker?.rescueType && (name === '复活' || name === '工作')) {
          await this.delayedTaskService.schedule({
            type: 'rescue',
            userId,
            dedupeKey: String(marker.token ?? `${name}`),
            runAt: Math.max(now, this.rescueExpireAtSeconds(marker) * 1000),
            payload: { marker },
          });
          recovered += 1;
        }
      }
    }
    if (recovered > 0) this.logger.log(`延时任务存量迁移: 已为 ${recovered} 个进行中状态补建任务行`);
  }

  /**
   * 原版玩家指令收尾钩子：触发纯白之翼自动技能和宠物后台搜索。
   * 对应 _主程序 L11462 及 L11573-L11669 的顺序：技能自动处理后进入宠物互动/搜索。
   */
  async triggerAutoFamiliarSkill(userId: number): Promise<string>{
    return this.questDialogueService.triggerAutoFamiliarSkill(userId);
  }
  private async buildNumberedMenu( userId: number, options: { label: string; cmd: string }[], hint = '💡 发送编号数字(如 1)即可快速操作', extraGroups: string[] = [], ): Promise<string[]>{
    return this.support.buildNumberedMenu(userId, options, hint, extraGroups);
  }
  async handleViewUnit(userId: number, unitName: string): Promise<string>{
    return this.questDialogueService.handleViewUnit(userId, unitName);
  }
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
  async handleMove(userId: number, targetMapName: string): Promise<string>{
    return this.movementVehicleService.handleMove(userId, targetMapName);
  }
  async handleTeleport(userId: number, targetMapName: string): Promise<string>{
    return this.movementVehicleService.handleTeleport(userId, targetMapName);
  }
  async handleFlyTo(userId: number, targetMapName: string): Promise<string>{
    return this.movementVehicleService.handleFlyTo(userId, targetMapName);
  }
  async findTravelVehicle(player: any, currentMap: any): Promise<any | null>{
    return this.movementVehicleService.findTravelVehicle(player, currentMap);
  }
  private async scheduleArrival(userId: number, targetMapId: number, targetMapName: string, travelTime: number): Promise<void>{
    return this.movementVehicleService.scheduleArrival(userId, targetMapId, targetMapName, travelTime);
  }
  async performArrival( userId: number, targetMapId: number, targetMapName: string, ): Promise<string>{
    return this.movementVehicleService.performArrival(userId, targetMapId, targetMapName);
  }
  private async applyPerformArrival( userId: number, targetMapId: number, targetMapName: string, ): Promise<string>{
    return this.movementVehicleService.applyPerformArrival(userId, targetMapId, targetMapName);
  }
  private async applyFoxAutoAttack(userId: number, map: any): Promise<string>{
    return this.movementVehicleService.applyFoxAutoAttack(userId, map);
  }
  private async applyArrivalTriggers(player: any, targetMap: any): Promise<string>{
    return this.movementVehicleService.applyArrivalTriggers(player, targetMap);
  }
  private async shearPranaCubsOnArrival(map: any, arrivingPlayer: any): Promise<string>{
    return this.movementVehicleService.shearPranaCubsOnArrival(map, arrivingPlayer);
  }
  private async migratePlayerAssetsOnMove( fromMapId: number, toMapId: number, player: any, ): Promise<void>{
    return this.movementVehicleService.migratePlayerAssetsOnMove(fromMapId, toMapId, player);
  }
  async buildPlayerInfo(userId: number): Promise<any | null>{
    return this.gatherPanelService.buildPlayerInfo(userId);
  }
  private buildPendingActions( player: any, markers: any, markers2: any, buffs?: any, ): Array<{ key: string; kind: string; label: string; detail: string; icon: string; startedAt: number; endAt: number; totalMs: number }>{
    return this.gatherPanelService.buildPendingActions(player, markers, markers2, buffs);
  }
  private buildActiveTasks(rawTasks: any): Array<{ name: string; count?: number }>{
    return this.gatherPanelService.buildActiveTasks(rawTasks);
  }
  private buildEquipmentSnapshot(player: any, markers: any): Array<{
    slot: string; name: string | null; quality: string; effect: number; enhance: number; enhanceRate: number; attrs: string; no: number | null;
    weapons?: Array<{ slot: string; name: string; quality: string; effect: number; enhance: number; enhanceRate: number; attrs: string; no: number | null }>;
  }> {
    return this.gatherPanelService.buildEquipmentSnapshot(player, markers);
  }
  private formatBuffList(rawBuffs: any): string[]{
    return this.gatherPanelService.formatBuffList(rawBuffs);
  }
  private buildActiveBuffs(rawBuffs: any): Array<{ name: string; expireAt: number }>{
    return this.gatherPanelService.buildActiveBuffs(rawBuffs);
  }
  async pushPlayerUpdate(userId: number): Promise<void>{
    return this.gatherPanelService.pushPlayerUpdate(userId);
  }
  private async doPushPlayerUpdate(userId: number): Promise<void>{
    return this.gatherPanelService.doPushPlayerUpdate(userId);
  }
  async pushMapUpdate(userId: number): Promise<void>{
    return this.gatherPanelService.pushMapUpdate(userId);
  }
  private async doPushMapUpdate(userId: number): Promise<void>{
    return this.gatherPanelService.doPushMapUpdate(userId);
  }
  private nextRev(key: string): number{
    return this.gatherPanelService.nextRev(key);
  }
  async getMapOverview(userId: number){
    return this.gatherPanelService.getMapOverview(userId);
  }
  async getNearbyPlayers(userId: number): Promise<any[]>{
    return this.gatherPanelService.getNearbyPlayers(userId);
  }
  getDistance(map1: any, map2: any): number{
    return this.gatherPanelService.getDistance(map1, map2);
  }
  private async getMovementPathLength(startMap: any, targetMap: any): Promise<number>{
    return this.movementVehicleService.getMovementPathLength(startMap, targetMap);
  }
  async handleInfo(userId: number): Promise<string>{
    return this.gatherPanelService.handleInfo(userId);
  }
  getBackpackDisplayItems(items: any[]): any[]{
    return this.support.getBackpackDisplayItems(items);
  }
  async handleInventory(userId: number, arg?: string): Promise<string>{
    return this.gatherPanelService.handleInventory(userId, arg);
  }
  async handleMap(userId: number): Promise<string>{
    return this.gatherPanelService.handleMap(userId);
  }
  async handleStatus(userId: number): Promise<string>{
    return this.gatherPanelService.handleStatus(userId);
  }
  async handleUseItem(userId: number, itemName: string, count = 1): Promise<string>{
    return this.gatherPanelService.handleUseItem(userId, itemName, count);
  }
  async handleUseAllItems(userId: number, keyword: string): Promise<string>{
    return this.gatherPanelService.handleUseAllItems(userId, keyword);
  }
  private getSeedCropName(itemName: string): string{
    return this.gatherPanelService.getSeedCropName(itemName);
  }
  private async handleUseSeed( userId: number, seedName: string, cropName: string, requestedCount: number, ): Promise<string>{
    return this.gatherPanelService.handleUseSeed(userId, seedName, cropName, requestedCount);
  }
  async handleEquip(userId: number, itemName: string): Promise<string>{
    return this.equipCommandService.handleEquip(userId, itemName);
  }
  async handleUnequip(userId: number, slot: string): Promise<string>{
    return this.equipCommandService.handleUnequip(userId, slot);
  }
  async handleSkill(userId: number): Promise<string>{
    return this.skillCommandService.handleSkill(userId);
  }
  async handleRescue(userId: number): Promise<string>{
    return this.rescueWhiteService.handleRescue(userId);
  }
  async handleTalk(userId: number, npcName: string): Promise<string>{
    return this.questDialogueService.handleTalk(userId, npcName);
  }
  private genericNpcChatLine(npcType: string): string{
    return this.questDialogueService.genericNpcChatLine(npcType);
  }
  private async buildUnitDialogue( player: any, userId: number, npcName: string, unit: any, kind: 'npc' | 'summon' | 'monster', ): Promise<string>{
    return this.questDialogueService.buildUnitDialogue(player, userId, npcName, unit, kind);
  }
  private millisecondsToText(ms: number): string {
    return this.support.millisecondsToText(ms);
  }

  private round2Text(value: number): string {
    return this.support.round2Text(value);
  }

  /**
   * 处理与露娜的对话（对话露娜未知）
   * 对应原版：对话露娜未知 命令
   * 当玩家携带"未知物品"（具现装置的产物）与露娜对话时，
   * 可用其兑换"工业建筑箱"或"专属装备补给箱"，并增加露娜熟练度
   */
  async handleDialogueLuna(userId: number, arg: string): Promise<string>{
    return this.questDialogueService.handleDialogueLuna(userId, arg);
  }
  async handleArriveAt(userId: number, arg: string): Promise<string>{
    return this.questDialogueService.handleArriveAt(userId, arg);
  }
  async handleHome(userId: number, subCommand: string, ...args: string[]): Promise<string>{
    return this.homeBuildService.handleHome(userId, subCommand, ...args);
  }
  async handleProbe(userId: number): Promise<string>{
    return this.gatherPanelService.handleProbe(userId);
  }
  async handlePickup(userId: number, itemName?: string): Promise<string>{
    return this.gatherPanelService.handlePickup(userId, itemName);
  }
  async handleMine(userId: number, resourceName?: string): Promise<string>{
    return this.gatherPanelService.handleMine(userId, resourceName);
  }
  private async mineByVehicle(userId: number): Promise<string>{
    return this.gatherPanelService.mineByVehicle(userId);
  }
  private async mineResourcePoint(userId: number, resourceName: string): Promise<string>{
    return this.gatherPanelService.mineResourcePoint(userId, resourceName);
  }
  private async settleManualMine(userId: number): Promise<void>{
    return this.gatherPanelService.settleManualMine(userId);
  }
  collectVehiclePartNames(vehicle: any): string[]{
    return this.gatherPanelService.collectVehiclePartNames(vehicle);
  }
  async summonFollowDisplay( map: any, userId: number, options: { requireFollow?: boolean; countLimit?: number } = {}, ): Promise<{ names: string[]; count: number; indexes: number[] }>{
    return this.gatherPanelService.summonFollowDisplay(map, userId, options);
  }
  private randomInt(min: number, max: number): number {
    return this.support.randomInt(min, max);
  }

  /**
   * 判断当前玩家所在地图是否有匹配给定 gatherCmd 的固定资源。
   * 用于 ChatGateway 判定"该输入是否应作为采集指令处理"（避免被当作普通聊天广播）。
   * 对齐原版：采集指令运行时按当前地图资源2的"采集指令"匹配，无需预注册到指令表。
   * @param userId 玩家ID
   * @param cmdName 采集指令名（如 打开箱子/打开休眠仓/收集木头/捡垃圾）
   * @returns true=当前地图存在该采集指令对应的资源
   */
  async hasGatherCmd(userId: number, cmdName: string): Promise<boolean>{
    return this.gatherPanelService.hasGatherCmd(userId, cmdName);
  }
  async getOpenBoxLockText(userId: number): Promise<string>{
    return this.gatherPanelService.getOpenBoxLockText(userId);
  }
  async handleGatherResource(userId: number, cmdName: string, requestedCount?: number): Promise<string>{
    return this.gatherPanelService.handleGatherResource(userId, cmdName, requestedCount);
  }
  async settleGatherResource(userId: number): Promise<string>{
    return this.gatherPanelService.settleGatherResource(userId);
  }
  private async applySettleGatherResource(userId: number): Promise<string>{
    return this.gatherPanelService.applySettleGatherResource(userId);
  }
  private takePendingGather( player: any, userId: number, ): { state: Record<string, any>; markers: Record<string, any> } | null{
    return this.gatherPanelService.takePendingGather(player, userId);
  }
  private clearStaleGatherLock(player: any, userId: number): void{
    this.gatherPanelService.clearStaleGatherLock(player, userId);
  }
  private async countFollowingSummons(map: any, userId: number): Promise<number>{
    return this.gatherPanelService.countFollowingSummons(map, userId);
  }
  private getGatherExpBonus(playerData: any): number{
    return this.gatherPanelService.getGatherExpBonus(playerData);
  }
  parseResourceOutputs(value: any): any[]{
    return this.gatherPanelService.parseResourceOutputs(value);
  }
  private resolveGatherCmd(resource: any): string{
    return this.gatherPanelService.resolveGatherCmd(resource);
  }
  private getGatherResources(map: any): any[]{
    return this.gatherPanelService.getGatherResources(map);
  }
  private getGatherResourceField(map: any): 'resources' | 'resources2'{
    return this.gatherPanelService.getGatherResourceField(map);
  }
  private isGatherResourceAvailable(resource: any, markers: Record<string, any>): boolean{
    return this.gatherPanelService.isGatherResourceAvailable(resource, markers);
  }
  private async getPlayerMarkers(userId: number): Promise<Record<string, any>>{
    return this.gatherPanelService.getPlayerMarkers(userId);
  }
  private hasOutputs2(resource: any): boolean{
    return this.gatherPanelService.hasOutputs2(resource);
  }
  private parseResourceOutputName(rawName: any, rawCount: number): { name: string; count: number; quality: string }{
    return this.gatherPanelService.parseResourceOutputName(rawName, rawCount);
  }
  private getResourceTimes(resource: any): number{
    return this.gatherPanelService.getResourceTimes(resource);
  }
  private parseGatherCommand(value: string): { name: string; count: number }{
    return this.gatherPanelService.parseGatherCommand(value);
  }
  private getGatherMultiplier(playerData: any): number{
    return this.gatherPanelService.getGatherMultiplier(playerData);
  }
  private getGatherDropRate(playerData: any): number{
    return this.gatherPanelService.getGatherDropRate(playerData);
  }
  private formatGatherNumber(value: number): string {
    return this.support.formatGatherNumber(value);
  }

  /**
   * 赠予物品
   * 将背包中的物品赠予其他玩家
   */
  async handleGive(userId: number, targetQQ: string, itemName: string, count: number): Promise<string>{
    return this.shopTradeService.handleGive(userId, targetQQ, itemName, count);
  }
  async handlePrivateChat(userId: number, targetName: string, content: string): Promise<string>{
    return this.questDialogueService.handlePrivateChat(userId, targetName, content);
  }
  async handleFeedback(userId: number, raw: string): Promise<string>{
    return this.questDialogueService.handleFeedback(userId, raw);
  }
  async handleAcceptQuest(userId: number, questName?: string): Promise<string>{
    return this.questDialogueService.handleAcceptQuest(userId, questName);
  }
  private parseNpcMarkers(unit: any): Record<string, any>{
    return this.questDialogueService.parseNpcMarkers(unit);
  }
  private getQuestSources(units: any[]): QuestSource[]{
    return this.questDialogueService.getQuestSources(units);
  }
  private splitQuestNames(value: any): string[]{
    return this.questDialogueService.splitQuestNames(value);
  }
  private questUnitName(unit: any): string{
    return this.questDialogueService.questUnitName(unit);
  }
  async handleViewQuests(userId: number, selector = ''): Promise<string>{
    return this.questDialogueService.handleViewQuests(userId, selector);
  }
  async handleCompleteQuest(userId: number, questName: string): Promise<string>{
    return this.questDialogueService.handleCompleteQuest(userId, questName);
  }
  async handleLieDown(userId: number): Promise<string>{
    return this.gatherPanelService.handleLieDown(userId);
  }
  async handleGetUp(userId: number): Promise<string>{
    return this.gatherPanelService.handleGetUp(userId);
  }
  async handleSettings(userId: number, settingName?: string, settingValue?: string): Promise<string>{
    return this.questDialogueService.handleSettings(userId, settingName, settingValue);
  }
  private async toggleSetting( userId: number, key: string, onValue: number, offValue: number, onText: string, offText: string, ): Promise<string>{
    return this.questDialogueService.toggleSetting(userId, key, onValue, offValue, onText, offText);
  }
  async handleSettingsGuide(userId: number): Promise<string>{
    return this.questDialogueService.handleSettingsGuide(userId);
  }
  async handleSettingsRandom(userId: number): Promise<string>{
    return this.questDialogueService.handleSettingsRandom(userId);
  }
  async handleSettingsGather(userId: number): Promise<string>{
    return this.questDialogueService.handleSettingsGather(userId);
  }
  async handleSettingsVitality(userId: number): Promise<string>{
    return this.questDialogueService.handleSettingsVitality(userId);
  }
  async handleSettingsNoHelp(userId: number): Promise<string>{
    return this.questDialogueService.handleSettingsNoHelp(userId);
  }
  async handleSettingsMusic(userId: number): Promise<string>{
    return this.questDialogueService.handleSettingsMusic(userId);
  }
  async handleSettingsMultiplier(userId: number): Promise<string>{
    return this.questDialogueService.handleSettingsMultiplier(userId);
  }
  async handleSettingsShop(userId: number, value?: string): Promise<string>{
    return this.questDialogueService.handleSettingsShop(userId, value);
  }
  async handleSettingsLocation(userId: number, value?: string): Promise<string>{
    return this.questDialogueService.handleSettingsLocation(userId, value);
  }
  async handleSettingsMarker(userId: number, value?: string): Promise<string>{
    return this.questDialogueService.handleSettingsMarker(userId, value);
  }
  async handleStartDungeon(userId: number, dungeonName = ''): Promise<string>{
    return this.dungeonChallengeService.handleStartDungeon(userId, dungeonName);
  }
  async handleRefreshDungeon(userId: number, dungeonName = ''): Promise<string>{
    return this.dungeonChallengeService.handleRefreshDungeon(userId, dungeonName);
  }
  getSlotLimit(vehicle: any, partType: number): { slots: number; max: number; name: string }{
    return this.movementVehicleService.getSlotLimit(vehicle, partType);
  }
  calcVehicleTotalBonus(vehicle: any): any{
    return this.movementVehicleService.calcVehicleTotalBonus(vehicle);
  }
  private parseVehicleValue<T>(value: any, fallback: T): T{
    return this.movementVehicleService.parseVehicleValue(value, fallback);
  }
  toRuntimeVehicle(raw: any): any{
    return this.movementVehicleService.toRuntimeVehicle(raw);
  }
  toStoredVehicle(runtime: any): any{
    return this.movementVehicleService.toStoredVehicle(runtime);
  }
  private vehicleDbData(runtime: any): Record<string, any>{
    return this.movementVehicleService.vehicleDbData(runtime);
  }
  private async persistRuntimeVehicle(source: any, runtime: any): Promise<void>{
    return this.movementVehicleService.persistRuntimeVehicle(source, runtime);
  }
  private async findProductionVehicle(userId: number, player: any, currentMap: any): Promise<any | null>{
    return this.movementVehicleService.findProductionVehicle(userId, player, currentMap);
  }
  private vehicleProductionOptions(map: any, vehicle: any): { yongxing: number; lannBaby: boolean }{
    return this.movementVehicleService.vehicleProductionOptions(map, vehicle);
  }
  private formatVehicleItems(items: any[]): string{
    return this.movementVehicleService.formatVehicleItems(items);
  }
  private formatVehicleTime(seconds: number): string{
    return this.movementVehicleService.formatVehicleTime(seconds);
  }
  async handleVehicleProduction(userId: number, argument = ''): Promise<string>{
    return this.movementVehicleService.handleVehicleProduction(userId, argument);
  }
  async handleInstall(userId: number, rawName: string): Promise<string>{
    return this.homeBuildService.handleInstall(userId, rawName);
  }
  private async handleInstallHomeFuel(userId: number, requestedCount: number): Promise<string>{
    return this.homeBuildService.handleInstallHomeFuel(userId, requestedCount);
  }
  async handleAssembleBuilding(userId: number, buildingName: string, count = 1): Promise<string>{
    return this.homeBuildService.handleAssembleBuilding(userId, buildingName, count);
  }
  async handleInstallPart(userId: number, partName: string, count = 1): Promise<string>{
    return this.homeBuildService.handleInstallPart(userId, partName, count);
  }
  async handleUninstallPart(userId: number, partName: string, count = 1): Promise<string>{
    return this.homeBuildService.handleUninstallPart(userId, partName, count);
  }
  private async tryUninstallHomeBuilding( userId: number, player: any, map: any, buildingName: string, requestedCount: number, ): Promise<string | null>{
    return this.homeBuildService.tryUninstallHomeBuilding(userId, player, map, buildingName, requestedCount);
  }
  async handleVehicleStatus(userId: number): Promise<string>{
    return this.movementVehicleService.handleVehicleStatus(userId);
  }
  async handleStartBattle(userId: number): Promise<string>{
    return this.dungeonChallengeService.handleStartBattle(userId);
  }
  async handleSweep(userId: number, requestedCount = 0): Promise<string>{
    return this.dungeonChallengeService.handleSweep(userId, requestedCount);
  }
  private async handleSweepInner(userId: number, requestedCount: number): Promise<string>{
    return this.dungeonChallengeService.handleSweepInner(userId, requestedCount);
  }
  private parseSweepMonsterNames(map: any): string[]{
    return this.dungeonChallengeService.parseSweepMonsterNames(map);
  }
  private getSweepRequirement(playerData: any, monsterNames: string[]): { text: string; unmet: boolean }{
    return this.dungeonChallengeService.getSweepRequirement(playerData, monsterNames);
  }
  private buildSweepRequirementText(playerData: any, monsterNames: string[]): string{
    return this.dungeonChallengeService.buildSweepRequirementText(playerData, monsterNames);
  }
  async handleDodge(userId: number): Promise<string>{
    return this.dungeonChallengeService.handleDodge(userId);
  }
  private hasEquip(player: any, name: string): boolean {
    return this.support.hasEquip(player, name);
  }

  /**
   * 写入/覆盖 markers2 增益标记（对应原版 获得增益/添加标记）
   * @param markers2 增益数组（就地修改）
   * @param name 标记名
   * @param expireAt 到期时间戳（秒）
   * @param strength 强度（可选）
   */
  private setMarkers2(markers2: any[], name: string, expireAt: number, strength?: number): void {
    this.support.setMarkers2(markers2, name, expireAt, strength);
  }

  // ========== 玩家信息命令 ==========

  /**
   * 处理资源背包命令
   * 从背包中筛选资源、材料、消耗品类型物品，输出格式与「背包」列表同构（见函数末尾注释）
   */
  async handleResourceBag(userId: number): Promise<string>{
    return this.gatherPanelService.handleResourceBag(userId);
  }
  async handleSearchBag(userId: number, keyword: string): Promise<string>{
    return this.gatherPanelService.handleSearchBag(userId, keyword);
  }
  async handleSearchSafe(userId: number, keyword: string): Promise<string>{
    return this.gatherPanelService.handleSearchSafe(userId, keyword);
  }
  async handleViewEquip(userId: number, arg: string, kind: '武器' | '装备'): Promise<string>{
    return this.equipCommandService.handleViewEquip(userId, arg, kind);
  }
  async handleViewSafe(userId: number, arg: string): Promise<string>{
    return this.equipCommandService.handleViewSafe(userId, arg);
  }
  async handleCompareEquip(userId: number, targetName: string, compareName: string): Promise<string>{
    return this.equipCommandService.handleCompareEquip(userId, targetName, compareName);
  }
  async handlePassiveEffects(userId: number): Promise<string>{
    return this.equipCommandService.handlePassiveEffects(userId);
  }
  async handleHandbook(userId: number, arg: string): Promise<string>{
    return this.questDialogueService.handleHandbook(userId, arg);
  }
  async handleSwitchWeapon(userId: number, weaponName: string): Promise<string>{
    return this.equipCommandService.handleSwitchWeapon(userId, weaponName);
  }
  async handleEnhanceImplant(userId: number, target: string): Promise<string>{
    return this.equipCommandService.handleEnhanceImplant(userId, target);
  }
  async handleViewImplant(userId: number): Promise<string>{
    return this.equipCommandService.handleViewImplant(userId);
  }
  async handleSwitchImplant(userId: number, implantName: string): Promise<string>{
    return this.equipCommandService.handleSwitchImplant(userId, implantName);
  }
  async handleResetImplant(userId: number): Promise<string>{
    return this.equipCommandService.handleResetImplant(userId);
  }
  async handleViewAmplifier(userId: number): Promise<string>{
    return this.equipCommandService.handleViewAmplifier(userId);
  }
  async handleSwitchAmplifier(userId: number, amplifierName: string): Promise<string>{
    return this.equipCommandService.handleSwitchAmplifier(userId, amplifierName);
  }
  async handleEnhanceAmplifier(userId: number, target: string): Promise<string>{
    return this.equipCommandService.handleEnhanceAmplifier(userId, target);
  }
  async handleResetAmplifier(userId: number): Promise<string>{
    return this.equipCommandService.handleResetAmplifier(userId);
  }
  async handleAlchemy(userId: number, recipeName: string, count = 1): Promise<string>{
    return this.fusionCraftService.handleAlchemy(userId, recipeName, count);
  }
  async handleMerge(userId: number, targetName: string, fusionArgs: string[] = []): Promise<string>{
    return this.fusionCraftService.handleMerge(userId, targetName, fusionArgs);
  }
  private async fusionHelpText(userId: number): Promise<string>{
    return this.fusionCraftService.fusionHelpText(userId);
  }
  private async handleFusion23(userId: number, backpackNumber: number, args: string[]): Promise<string>{
    return this.fusionCraftService.handleFusion23(userId, backpackNumber, args);
  }
  private async activateFusionEffectWithoutArtisan(player: any, backpack: any[], item: any): Promise<string>{
    return this.fusionCraftService.activateFusionEffectWithoutArtisan(player, backpack, item);
  }
  private async handleFusion23WangDamage(player: any, backpack: any[], sourceIndex: number, wangNumber: number): Promise<string>{
    return this.fusionCraftService.handleFusion23WangDamage(player, backpack, sourceIndex, wangNumber);
  }
  private async handleFusion23SelectedEffect( userId: number, player: any, backpack: any[], index: number, item: any, mode: string, ): Promise<string>{
    return this.fusionCraftService.handleFusion23SelectedEffect(userId, player, backpack, index, item, mode);
  }
  private hasFusionArtisan(map: any): boolean{
    return this.fusionCraftService.hasFusionArtisan(map);
  }
  private isFusionAmplifier(item: any): boolean{
    return this.fusionCraftService.isFusionAmplifier(item);
  }
  private fusionHasEffect(item: any): boolean{
    return this.fusionCraftService.fusionHasEffect(item);
  }
  isFusionWeapon(item: any): boolean{
    return this.fusionCraftService.isFusionWeapon(item);
  }
  private getFusionEffects(item: any): Array<{ id: number; row: any }>{
    return this.fusionCraftService.getFusionEffects(item);
  }
  private randomFusionEffectId(item: any): number{
    return this.fusionCraftService.randomFusionEffectId(item);
  }
  private fusionDataParts(item: any): { prefix: string; segments: string[] }{
    return this.fusionCraftService.fusionDataParts(item);
  }
  private rewriteFusionData(item: any, prefix?: string, effect?: number): string{
    return this.fusionCraftService.rewriteFusionData(item, prefix, effect);
  }
  private setFusionBonus(item: any, code: string, value: number): string{
    return this.fusionCraftService.setFusionBonus(item, code, value);
  }
  private upgradeFusionData(item: any): string{
    return this.fusionCraftService.upgradeFusionData(item);
  }
  private correctFusionAttributes(item: any): boolean{
    return this.fusionCraftService.correctFusionAttributes(item);
  }
  async handleForge(userId: number, itemName: string, count = 1): Promise<string>{
    return this.fusionCraftService.handleForge(userId, itemName, count);
  }
  async handleBreed(userId: number, targetName: string): Promise<string>{
    return this.fusionCraftService.handleBreed(userId, targetName);
  }
  async handleFamiliarSkills(userId: number): Promise<string>{
    return this.skillCommandService.handleFamiliarSkills(userId);
  }
  async handleCommonSkills(userId: number): Promise<string>{
    return this.skillCommandService.handleCommonSkills(userId);
  }
  private skillLevelInfo( markers: Record<string, any>, name: string, ): { level: number; text: string }{
    return this.skillCommandService.skillLevelInfo(markers, name);
  }
  async handleFamiliarTitles(userId: number): Promise<string>{
    return this.skillCommandService.handleFamiliarTitles(userId);
  }
  async handleClaimTitle(userId: number, titleName: string): Promise<string>{
    return this.skillCommandService.handleClaimTitle(userId, titleName);
  }
  async handleEquipTitle(userId: number, titleName: string): Promise<string>{
    return this.skillCommandService.handleEquipTitle(userId, titleName);
  }
  async handleFamiliarRank(userId: number, subtype = ''): Promise<string>{
    return this.rankingService.handleFamiliarRank(userId, subtype);
  }
  private isRankablePlayer(p: any): boolean{
    return this.rankingService.isRankablePlayer(p);
  }
  private async collectPlayerMarkerEntries( key: string, options: { excludeZero?: boolean } = {}, ): Promise<Array<{ name: string; value: number }>>{
    return this.rankingService.collectPlayerMarkerEntries(key, options);
  }
  private handleCombatPowerRanking(requesterName: string): Promise<string>{
    return this.rankingService.handleCombatPowerRanking(requesterName);
  }
  private async handleLevelRanking(requesterName: string): Promise<string>{
    return this.rankingService.handleLevelRanking(requesterName);
  }
  private async handleTheoreticalDamageRanking(requesterName: string): Promise<string>{
    return this.rankingService.handleTheoreticalDamageRanking(requesterName);
  }
  private handleMaxDamageRanking(requesterName: string): Promise<string>{
    return this.rankingService.handleMaxDamageRanking(requesterName);
  }
  private handleKillCountRanking(requesterName: string): Promise<string>{
    return this.rankingService.handleKillCountRanking(requesterName);
  }
  private handleOnlineTimeRanking(requesterName: string): Promise<string>{
    return this.rankingService.handleOnlineTimeRanking(requesterName);
  }
  private async handlePetRanking(requesterName: string, kind: '战斗力' | '最高伤害'): Promise<string>{
    return this.rankingService.handlePetRanking(requesterName, kind);
  }
  private secondsToTimeText(seconds: number): string {
    return this.support.secondsToTimeText(seconds);
  }

  // ==================== 排行数据源记录（原版 _计算玩家 随每条指令结算） ====================


  /**
   * 指令入口排行数据源结算（原版每条指令都执行的 _计算玩家 记录段）：
   * 1) 在线时间：距上次指令的秒数累加进成就「在线时间」，单次上限 180
   *    （原版 加成计算.ecode L1588-1605：时间差>180 按离线只记 180）
   * 2) 战斗力：当前计算战斗力超过历史记录时写入成就「战斗力」
   *    （原版 加成计算.ecode L2474-2477，四舍五入两位）
   * 由 CommandService.dispatch 入口调用；失败静默，不影响指令本身。
   */
  async recordRankingStats(userId: number): Promise<void>{
    return this.rankingService.recordRankingStats(userId);
  }
  async handleRanking(userId: number, type: string): Promise<string>{
    return this.rankingService.handleRanking(userId, type);
  }
  private async handleWealthRanking(requesterName: string): Promise<string>{
    return this.rankingService.handleWealthRanking(requesterName);
  }
  private async handleVehicleValueRanking(requesterName: string): Promise<string>{
    return this.rankingService.handleVehicleValueRanking(requesterName);
  }
  private pushVehicleParts(target: any[], vehicle: any): void{
    this.support.pushVehicleParts(target, vehicle);
  }
  private formatRankingText( requesterName: string, title: string, entries: Array<{ name: string; value: number }>, valueText?: (value: number) => string, ): string{
    return this.rankingService.formatRankingText(requesterName, title, entries, valueText);
  }
  async handleMassSummon(userId: number, count: string): Promise<string>{
    return this.petCommandService.handleMassSummon(userId, count);
  }
  async handleReviveFamiliar(userId: number): Promise<string>{
    return this.rescueWhiteService.handleReviveFamiliar(userId);
  }
  private async beginSelfRescue(userId: number, player: any, markers2: any[]): Promise<string>{
    return this.rescueWhiteService.beginSelfRescue(userId, player, markers2);
  }
  async handleEaseAngel(userId: number, targetName?: string): Promise<string>{
    return this.skillCommandService.handleEaseAngel(userId, targetName);
  }
  async handleGospel(userId: number, targetName?: string): Promise<string>{
    return this.skillCommandService.handleGospel(userId, targetName);
  }
  async handleApocalypse(userId: number): Promise<string>{
    return this.skillCommandService.handleApocalypse(userId);
  }
  async handleSwitchMode(userId: number, modeName: string): Promise<string>{
    return this.skillCommandService.handleSwitchMode(userId, modeName);
  }
  async handleNanoSuit(userId: number, action: string): Promise<string>{
    return this.skillCommandService.handleNanoSuit(userId, action);
  }
  async handleArmorCombine(userId: number, armorName?: string): Promise<string>{
    return this.skillCommandService.handleArmorCombine(userId, armorName);
  }
  async handleFamiliarChallenge(userId: number): Promise<string>{
    return this.dungeonChallengeService.handleFamiliarChallenge(userId);
  }
  async handleStartChallenge(userId: number): Promise<string>{
    return this.dungeonChallengeService.handleStartChallenge(userId);
  }
  async familiarChallengeNextLayer(userId: number): Promise<string>{
    return this.dungeonChallengeService.familiarChallengeNextLayer(userId);
  }
  async handleLookAround(userId: number): Promise<string>{
    return this.gatherPanelService.handleLookAround(userId);
  }
  async handleViewPets(userId: number): Promise<string>{
    return this.petCommandService.handleViewPets(userId);
  }
  async handleViewVehicles(userId: number): Promise<string>{
    return this.movementVehicleService.handleViewVehicles(userId);
  }
  async handleViewCrops(userId: number): Promise<string>{
    return this.homeBuildService.handleViewCrops(userId);
  }
  async handleViewBuildings(userId: number): Promise<string>{
    return this.homeBuildService.handleViewBuildings(userId);
  }
  async handleViewHomes(userId: number): Promise<string>{
    return this.homeBuildService.handleViewHomes(userId);
  }
  async handleViewAchievements(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    return this.achievementService.getAchievementsDisplay(player);
  }

  /**
   * 处理查看使魔命令（基础数据 + 「1、更多」子菜单）
   * 对齐原版 _主程序.ecode L5527（查看使魔显示基础数据）与 L5548（追加「1、更多」）。
   * 基础数据只含当前战力与属性，技能说明与好感解锁分层由「使魔技能」独立展示，
   * 避免与「查看使魔」重复。
   */
  async handleViewFamiliar(userId: number): Promise<string>{
    return this.homeBuildService.handleViewFamiliar(userId);
  }
  async handleFamiliarData(userId: number): Promise<string>{
    return this.homeBuildService.handleFamiliarData(userId);
  }
  async handleFamiliarMore(userId: number): Promise<string>{
    return this.homeBuildService.handleFamiliarMore(userId);
  }
  async handleViewSkills(userId: number): Promise<string>{
    return this.skillCommandService.handleViewSkills(userId);
  }
  async handleViewMarkers(userId: number): Promise<string>{
    return this.gatherPanelService.handleViewMarkers(userId);
  }
  async handleViewMarkers2(userId: number): Promise<string>{
    return this.gatherPanelService.handleViewMarkers2(userId);
  }
  async handleViewDescription(userId: number): Promise<string>{
    return this.gatherPanelService.handleViewDescription(userId);
  }
  async handleDialogueYongxing(userId: number): Promise<string>{
    return this.questDialogueService.handleDialogueYongxing(userId);
  }
  async handleDialogueLittleDemon(userId: number): Promise<string>{
    return this.questDialogueService.handleDialogueLittleDemon(userId);
  }
  async handleSetMeatRatio(userId: number, ratioStr: string): Promise<string>{
    return this.questDialogueService.handleSetMeatRatio(userId, ratioStr);
  }
  async handleSignalGun(userId: number, countArg = ''): Promise<string>{
    return this.homeBuildService.handleSignalGun(userId, countArg);
  }
  private async completeCargoSummon(userId: number, count: number): Promise<void>{
    return this.homeBuildService.completeCargoSummon(userId, count);
  }
  private async applyCargoSummon(userId: number, count: number): Promise<void>{
    return this.homeBuildService.applyCargoSummon(userId, count);
  }
  async handleFamiliarHome(userId: number): Promise<string>{
    return this.homeBuildService.handleFamiliarHome(userId);
  }
  async handleBuildHouse(userId: number): Promise<string>{
    return this.homeBuildService.handleBuildHouse(userId);
  }
  async handleDigFoundation(userId: number): Promise<string>{
    return this.homeBuildService.handleDigFoundation(userId);
  }
  async handleBuildFoundation(userId: number): Promise<string>{
    return this.homeBuildService.handleBuildFoundation(userId);
  }
  async handleClaimLand(userId: number): Promise<string>{
    return this.homeBuildService.handleClaimLand(userId);
  }
  async handleProduce(userId: number, productName: string): Promise<string>{
    return this.questDialogueService.handleProduce(userId, productName);
  }
  async handleClearDungeon(userId: number, dungeonName = ''): Promise<string>{
    return this.dungeonChallengeService.handleClearDungeon(userId, dungeonName);
  }
  private parseDungeonArray(value: any): any[]{
    return this.dungeonChallengeService.parseDungeonArray(value);
  }
  private normalizeDungeonMarkers2(markers2: any[]): void{
    this.dungeonChallengeService.normalizeDungeonMarkers2(markers2);
  }
  async handleAssembleVehicle(userId: number, partName: string, count = 1): Promise<string>{
    return this.movementVehicleService.handleAssembleVehicle(userId, partName, count);
  }
  async handleDriveVehicle(userId: number, vehicleName: string): Promise<string>{
    return this.movementVehicleService.handleDriveVehicle(userId, vehicleName);
  }
  private parseVehicleAssemblyParts(parts: string[]): any[]{
    return this.movementVehicleService.parseVehicleAssemblyParts(parts);
  }
  async backpackQuantity(backpack: any[], name: string): Promise<number>{
    return this.gatherPanelService.backpackQuantity(backpack, name);
  }
  addBackpackItem(backpack: any[], item: any): void{
    this.gatherPanelService.addBackpackItem(backpack, item);
  }
  private async craftVehiclePart( player: any, backpack: any[], markers: Record<string, number>, name: string, count: number, dryRun: boolean, ): Promise<{ success: boolean; text: string }>{
    return this.movementVehicleService.craftVehiclePart(player, backpack, markers, name, count, dryRun);
  }
  async assembleVehicleFromParts(userId: number, rawParts: string[]): Promise<string>{
    return this.movementVehicleService.assembleVehicleFromParts(userId, rawParts);
  }
  private async hasOwnedProductionVehicle(ownerQQ: string, coreSpec: any): Promise<boolean>{
    return this.movementVehicleService.hasOwnedProductionVehicle(ownerQQ, coreSpec);
  }
  async handleNameVehicle(userId: number, name: string): Promise<string>{
    return this.movementVehicleService.handleNameVehicle(userId, name);
  }
  async handleSimulateVehicle(userId: number, targetName: string): Promise<string>{
    return this.movementVehicleService.handleSimulateVehicle(userId, targetName);
  }
  async handleRepairVehicle(userId: number, targetName: string = ''): Promise<string>{
    return this.movementVehicleService.handleRepairVehicle(userId, targetName);
  }
  private async completeVehicleRepair(userId: number): Promise<string>{
    return this.movementVehicleService.completeVehicleRepair(userId);
  }
  private async applyCompleteVehicleRepair(userId: number): Promise<string>{
    return this.movementVehicleService.applyCompleteVehicleRepair(userId);
  }
  private async applyVehicleRepair(userId: number, player: any, map: any, vehicle: any): Promise<string>{
    return this.movementVehicleService.applyVehicleRepair(userId, player, map, vehicle);
  }
  private findVehicleOverLimitPart(vehicle: any): string{
    return this.movementVehicleService.findVehicleOverLimitPart(vehicle);
  }
  async handleExitVehicle(userId: number): Promise<string>{
    return this.movementVehicleService.handleExitVehicle(userId);
  }
  async handleTakeoverVehicle(userId: number, targetName: string): Promise<string>{
    return this.movementVehicleService.handleTakeoverVehicle(userId, targetName);
  }
  async handleDeployCannon(userId: number, targetName: string): Promise<string>{
    return this.movementVehicleService.handleDeployCannon(userId, targetName);
  }
  async handleModeChange(userId: number, modeName: string): Promise<string>{
    return this.skillCommandService.handleModeChange(userId, modeName);
  }
  async handleTransform(userId: number, targetForm: string): Promise<string>{
    return this.skillCommandService.handleTransform(userId, targetForm);
  }
  async handleTractorBeam(userId: number, targetName: string): Promise<string>{
    return this.skillCommandService.handleTractorBeam(userId, targetName);
  }
  async handleControlTerminal(userId: number, arg = ''): Promise<string>{
    return this.skillCommandService.handleControlTerminal(userId, arg);
  }
  private bondSkillLabel(slot: 'a' | 'b', value: number): string{
    return this.skillCommandService.bondSkillLabel(slot, value);
  }
  private async handleWhiteBondTerminal( userId: number, player: any, markers: Record<string, any>, arg: string, ): Promise<string>{
    return this.skillCommandService.handleWhiteBondTerminal(userId, player, markers, arg);
  }
  async handleVehicleOps(userId: number): Promise<string>{
    return this.movementVehicleService.handleVehicleOps(userId);
  }
  async handleAmplifierHelp(userId: number): Promise<string>{
    return this.skillCommandService.handleAmplifierHelp(userId);
  }
  async handleStartCapture(userId: number, targetName: string): Promise<string>{
    return this.petCommandService.handleStartCapture(userId, targetName);
  }
  async handleStopCapture(userId: number, targetName?: string): Promise<string>{
    return this.petCommandService.handleStopCapture(userId, targetName);
  }
  private async updateOwnedSummonMode(
    userId: number,
    mode: 'follow' | 'idle' | 'active' | 'passive',
  ): Promise<{ count: number; map?: any }> {
    return this.support.updateOwnedSummonMode(userId, mode);
  }

  /**
   * 处理全部跟随命令
   * 使所有属于当前玩家的宠物/使魔跟随
   * 对应原版：全部跟随 命令
   */
  async handleFollowAll(userId: number): Promise<string>{
    return this.petCommandService.handleFollowAll(userId);
  }
  async handleRefill(userId: number): Promise<string>{
    return this.delayedSettleService.handleRefill(userId);
  }
  private async completeRefill(userId: number): Promise<void>{
    return this.delayedSettleService.completeRefill(userId);
  }
  async handleMilk(userId: number, targetName?: string): Promise<string>{
    return this.petCommandService.handleMilk(userId, targetName);
  }
  private async settleMilk( userId: number, targetName?: string, all = false, ): Promise<{ text: string; count: number; amount: number }>{
    return this.petCommandService.settleMilk(userId, targetName, all);
  }
  private formatMilkRemaining(ms: number): string{
    return this.petCommandService.formatMilkRemaining(ms);
  }
  private hasActiveMilkMarker(markers2: any[], name: string, now: number): boolean{
    return this.petCommandService.hasActiveMilkMarker(markers2, name, now);
  }
  private isMilkSpecial(pet: any, name: '茸' | '青龙', specialSeq: number): boolean{
    return this.petCommandService.isMilkSpecial(pet, name, specialSeq);
  }
  private getMilkAmount(pet: any): number{
    return this.petCommandService.getMilkAmount(pet);
  }
  private addSummonMilkAffinity(pet: any, ownerIds: Set<string>): void{
    this.petCommandService.addSummonMilkAffinity(pet, ownerIds);
  }
  async handleShear(userId: number, targetName: string): Promise<string>{
    return this.petCommandService.handleShear(userId, targetName);
  }
  async handleAbandonQuest(userId: number, questName: string): Promise<string>{
    return this.questDialogueService.handleAbandonQuest(userId, questName);
  }
  async handleMenu(userId: number): Promise<string>{
    return this.questDialogueService.handleMenu(userId);
  }
  async handleFunctionMenu(userId: number): Promise<string>{
    return this.questDialogueService.handleFunctionMenu(userId);
  }
  async handleGameMenu(userId: number): Promise<string>{
    return this.questDialogueService.handleGameMenu(userId);
  }
  async handleCalculate(userId: number, expression: string): Promise<string>{
    return this.questDialogueService.handleCalculate(userId, expression);
  }
  async handleRefreshData(userId: number): Promise<string>{
    return this.questDialogueService.handleRefreshData(userId);
  }
  async handleReloadData(userId: number): Promise<string>{
    return this.questDialogueService.handleReloadData(userId);
  }
  async handleConfirmReloadData(userId: number): Promise<string>{
    return this.questDialogueService.handleConfirmReloadData(userId);
  }
  async handleGameIntro(userId: number): Promise<string>{
    return this.questDialogueService.handleGameIntro(userId);
  }
  async getFirstFamiliarGate(userId: number): Promise<string | null>{
    return this.questDialogueService.getFirstFamiliarGate(userId);
  }
  private localTodayString(now = new Date()): string{
    return this.timeSettleService.localTodayString(now);
  }
  async settleDailyLogin(userId: number): Promise<string>{
    return this.timeSettleService.settleDailyLogin(userId);
  }
  async getActionHints(userId: number): Promise<string>{
    return this.timeSettleService.getActionHints(userId);
  }
  private async hasTrainerAccess(player: any): Promise<boolean>{
    return this.timeSettleService.hasTrainerAccess(player);
  }
  async handleGameTerms(userId: number, termName: string): Promise<string>{
    return this.questDialogueService.handleGameTerms(userId, termName);
  }
  async handleMoreHelp(userId: number): Promise<string>{
    return this.questDialogueService.handleMoreHelp(userId);
  }
  async handleChangelog(userId: number): Promise<string>{
    return this.questDialogueService.handleChangelog(userId);
  }
  async handleTrade(userId: number, action: string, args: string[]): Promise<string>{
    return this.shopTradeService.handleTrade(userId, action, args);
  }
  private async withTradeLock<T>(key: string, fn: () => Promise<T>): Promise<T>{
    return this.shopTradeService.withTradeLock(key, fn);
  }
  private async handleHomeTrade( userId: number, targetUserId: number, targetMapName: string, ): Promise<string>{
    return this.shopTradeService.handleHomeTrade(userId, targetUserId, targetMapName);
  }
  async handleShop(userId: number, action: string, args: string[]): Promise<string>{
    return this.shopTradeService.handleShop(userId, action, args);
  }
  async handleHelpMe(userId: number, question: string): Promise<string>{
    return this.questDialogueService.handleHelpMe(userId, question);
  }
  async handleRecipe(userId: number, recipeName: string): Promise<string>{
    return this.shopTradeService.handleRecipe(userId, recipeName);
  }
  async handleReverse(userId: number, targetName: string): Promise<string>{
    return this.shopTradeService.handleReverse(userId, targetName);
  }
  private readReverseProficiencies(player: any): Array<{ name: string; value: number }>{
    return this.shopTradeService.readReverseProficiencies(player);
  }
  private reverseProficiency(reverse: Array<{ name: string; value: number }>, itemName: string): number{
    return this.shopTradeService.reverseProficiency(reverse, itemName);
  }
  private setReverseProficiency( reverse: Array<{ name: string; value: number }>, itemName: string, amount: number, ): number{
    return this.shopTradeService.setReverseProficiency(reverse, itemName, amount);
  }
  private itemName(item: any): string {
    return this.support.itemName(item);
  }

  private itemType(item: any): string {
    return this.support.itemType(item);
  }

  private reverseValue(item: any): number{
    return this.shopTradeService.reverseValue(item);
  }
  private reverseItemFailure( playerName: string, item: any, reverse: Array<{ name: string; value: number }>, ): string{
    return this.shopTradeService.reverseItemFailure(playerName, item, reverse);
  }
  private reverseOne(item: any, reverse: Array<{ name: string; value: number }>): number{
    return this.shopTradeService.reverseOne(item, reverse);
  }
  private reverseAllEligible( playerName: string, backpack: any[], reverse: Array<{ name: string; value: number }>, ): { count: number; items: Array<{ name: string; value: number }> }{
    return this.shopTradeService.reverseAllEligible(playerName, backpack, reverse);
  }
  private formatReverseNumber(value: number): string {
    return this.support.formatReverseNumber(value);
  }

  private formatReverseMenu( playerName: string, reverse: Array<{ name: string; value: number }>, inProgress: boolean, ): string{
    return this.shopTradeService.formatReverseMenu(playerName, reverse, inProgress);
  }
  private formatReverseBatchResult( playerName: string, count: number, items: Array<{ name: string; value: number }>, ): string{
    return this.shopTradeService.formatReverseBatchResult(playerName, count, items);
  }
  private formatReverseSingleResult( playerName: string, item: any, value: number, reverse: Array<{ name: string; value: number }>, ): string{
    return this.shopTradeService.formatReverseSingleResult(playerName, item, value, reverse);
  }
  private async saveReverseResult( userId: number, player: any, backpack: any[], reverse: Array<{ name: string; value: number }>, count: number, ): Promise<void>{
    return this.shopTradeService.saveReverseResult(userId, player, backpack, reverse, count);
  }
  async handlePresetSwitch(userId: number, presetName: string): Promise<string>{
    return this.equipCommandService.handlePresetSwitch(userId, presetName);
  }
  async handleRecharge(userId: number): Promise<string>{
    return this.timeSettleService.handleRecharge(userId);
  }
  async handleRepairItem(userId: number, itemName: string): Promise<string>{
    return this.equipCommandService.handleRepairItem(userId, itemName);
  }
  async handleReload(userId: number, targetName: string): Promise<string>{
    return this.delayedSettleService.handleReload(userId, targetName);
  }
  private currentWeaponItem(player: any, weapons: any[]): any | null{
    return this.support.currentWeaponItem(player, weapons);
  }
  private equipmentSpecialSeq(item: any): number{
    return this.support.equipmentSpecialSeq(item);
  }
  private hasEquippedSpecial( playerData: any, equipmentName: string, specialSeq: number, ): boolean{
    return this.support.hasEquippedSpecial(playerData, equipmentName, specialSeq);
  }
  private incrementMarker(markers: Record<string, any>, key: string, amount: number): void {
    this.support.incrementMarker(markers, key, amount);
  }

  private normalizeMarkers2(markers2: any[]): void {
    this.support.normalizeMarkers2(markers2);
  }

  private scheduleReloadCompletion( userId: number, mode: 'plana' | 'organ', seconds: number, ): void{
    this.delayedSettleService.scheduleReloadCompletion(userId, mode, seconds);
  }
  private async completeReload(userId: number, mode: string): Promise<void>{
    return this.delayedSettleService.completeReload(userId, mode);
  }
  async handleSpawnArtisan(userId: number): Promise<string>{
    return this.dungeonChallengeService.handleSpawnArtisan(userId);
  }
  async handleSpawnWreck(userId: number): Promise<string>{
    return this.dungeonChallengeService.handleSpawnWreck(userId);
  }
  async handleDailyCheckin(userId: number): Promise<string>{
    return this.timeSettleService.handleDailyCheckin(userId);
  }
  async handleTextSend(userId: number, content: string): Promise<string>{
    return this.questDialogueService.handleTextSend(userId, content);
  }
  async handleViewPlayer(userId: number, targetName: string): Promise<string>{
    return this.gatherPanelService.handleViewPlayer(userId, targetName);
  }
  async finishNowForUser(userId: number): Promise<{ ok: boolean; completed: number; message: string }>{
    return this.adminCommandService.finishNowForUser(userId);
  }
  async handleAdminFinishNow(userId: number): Promise<string>{
    return this.adminCommandService.handleAdminFinishNow(userId);
  }
  async handleAdminCommand(userId: number, args: string[]): Promise<string>{
    return this.adminCommandService.handleAdminCommand(userId, args);
  }
  private getAdminHelpText(): string{
    return this.adminCommandService.getAdminHelpText();
  }
  private async handleAdminStatus(): Promise<string>{
    return this.adminCommandService.handleAdminStatus();
  }
  private async handleAdminAnnounce(args: string[]): Promise<string>{
    return this.adminCommandService.handleAdminAnnounce(args);
  }
  private async handleAdminSetWorldLevel(args: string[]): Promise<string>{
    return this.adminCommandService.handleAdminSetWorldLevel(args);
  }
  private async handleAdminGiveItem(args: string[]): Promise<string>{
    return this.adminCommandService.handleAdminGiveItem(args);
  }
  private async handleAdminPlayerList(args: string[]): Promise<string>{
    return this.adminCommandService.handleAdminPlayerList(args);
  }
  private async handleAdminToggleBan(args: string[], isBan: boolean): Promise<string>{
    return this.adminCommandService.handleAdminToggleBan(args, isBan);
  }
  private async handleAdminUpdateConfig(args: string[]): Promise<string>{
    return this.adminCommandService.handleAdminUpdateConfig(args);
  }
  private async handleAdminUserList(args: string[]): Promise<string>{
    return this.adminCommandService.handleAdminUserList(args);
  }
  private async handleAdminBanByQQ(userId: number, args: string[]): Promise<string>{
    return this.adminCommandService.handleAdminBanByQQ(userId, args);
  }
  private async handleAdminResetPlayer(userId: number, args: string[]): Promise<string>{
    return this.adminCommandService.handleAdminResetPlayer(userId, args);
  }
  private async handleAdminModifyPlayer(userId: number, args: string[]): Promise<string>{
    return this.adminCommandService.handleAdminModifyPlayer(userId, args);
  }
  private async handleAdminIntervalMessage(userId: number, args: string[]): Promise<string>{
    return this.adminCommandService.handleAdminIntervalMessage(userId, args);
  }
  private async handleAdminBroadcast(userId: number, args: string[]): Promise<string>{
    return this.adminCommandService.handleAdminBroadcast(userId, args);
  }
  private formatUptime(seconds: number): string {
    return this.support.formatUptime(seconds);
  }

  // ==================== 时间流逝完整计算 ====================

  /**
   * 计算玩家离线时间补偿
   * 玩家离线期间，根据时间差计算生命/护盾/装甲回复
   * 回复公式：回复量 = 回复率 × 时间差 / 60
   * 在玩家每次操作时自动调用，确保离线时间得到补偿
   *
   * 2026-09-06 Web 在线语义：离开计时以 WS 断开为起点、重连为终点
   * （ChatGateway 断开/重连钩子会强制结算，把 lastOpTime 精确推进到断开/回连时刻）：
   * - WS 在线时的指令结算照常补偿数值，但不输出「你离开了」横幅（活力提示保留）；
   * - force=true 跳过 10 秒防抖（断开/重连时刻的强制结算用）；
   * - showBanner=true 强制输出横幅（重连结算用，此刻 WS 已在线）。
   *
   * @param userId 用户ID
   * @param opts force: 跳过防抖强制结算；showBanner: 无视在线状态输出离开横幅
   * @returns 回复结果文本（无回复时返回空字符串）
   */
  async calculateTimeElapsed( userId: number, opts?: { force?: boolean; showBanner?: boolean }, ): Promise<string>{
    return this.timeSettleService.calculateTimeElapsed(userId, opts);
  }
  async settleTimeElapsedOnDisconnect(userId: number): Promise<void>{
    return this.timeSettleService.settleTimeElapsedOnDisconnect(userId);
  }
  async settleTimeElapsedOnReconnect(userId: number): Promise<string>{
    return this.timeSettleService.settleTimeElapsedOnReconnect(userId);
  }
  private mutateForTimeElapsed( userId: number, opts: { force?: boolean; showBanner?: boolean }, ): Promise<string>{
    return this.timeSettleService.mutateForTimeElapsed(userId, opts);
  }
  async getCurrentMap(userId: number): Promise<any> {
    return this.support.getCurrentMap(userId);
  }

  /**
   * 更新地图的建筑数据
   * @param mapId 地图ID
   * @param buildingsJson 建筑数据JSON字符串
   */
  async updateMapBuildings(mapId: number, buildingsJson: string, resources2Json?: string): Promise<void>{
    return this.homeBuildService.updateMapBuildings(mapId, buildingsJson, resources2Json);
  }
  async handleHelpUp(userId: number): Promise<string>{
    return this.rescueWhiteService.handleHelpUp(userId);
  }
  private parseRescueArray(value: any): any[]{
    return this.rescueWhiteService.parseRescueArray(value);
  }
  private parseRescueMarkers(value: any): any[]{
    return this.rescueWhiteService.parseRescueMarkers(value);
  }
  private createRescueMarker( rescueType: 'self' | 'familiar' | 'vehicle' | 'player', seconds: number, extra: Record<string, any> = {}, ): any{
    return this.rescueWhiteService.createRescueMarker(rescueType, seconds, extra);
  }
  private getActiveRescueMarker(markers2: any[]): any | null{
    return this.rescueWhiteService.getActiveRescueMarker(markers2);
  }
  private rescueExpireAtSeconds(marker: any): number{
    return this.rescueWhiteService.rescueExpireAtSeconds(marker);
  }
  private remainingRescueSeconds(marker: any): number{
    return this.rescueWhiteService.remainingRescueSeconds(marker);
  }
  private rescueActionText(type: string): string{
    return this.rescueWhiteService.rescueActionText(type);
  }
  private formatRescueSeconds(seconds: number): number{
    return this.rescueWhiteService.formatRescueSeconds(seconds);
  }
  private rescueHp(unit: any): number{
    return this.rescueWhiteService.rescueHp(unit);
  }
  private rescueMaxHp(unit: any): number{
    return this.rescueWhiteService.rescueMaxHp(unit);
  }
  private firstPositiveNumber(...values: any[]): number {
    return this.support.firstPositiveNumber(...values);
  }

  private parseRescueObject(value: any): any{
    return this.rescueWhiteService.parseRescueObject(value);
  }
  private setRescueHp(unit: any, hp: number): void{
    this.rescueWhiteService.setRescueHp(unit, hp);
  }
  private rescueUnitId(unit: any): string{
    return this.rescueWhiteService.rescueUnitId(unit);
  }
  private rescueUnitName(unit: any): string{
    return this.rescueWhiteService.rescueUnitName(unit);
  }
  private rescueVehicleKey(summon: any): string{
    return this.rescueWhiteService.rescueVehicleKey(summon);
  }
  private rescueVehicleKeys(vehicle: any): Set<string>{
    return this.rescueWhiteService.rescueVehicleKeys(vehicle);
  }
  rescueVehicleMaxHp(vehicle: any): number{
    return this.rescueWhiteService.rescueVehicleMaxHp(vehicle);
  }
  private rescueVehicleHp(vehicle: any): number{
    return this.rescueWhiteService.rescueVehicleHp(vehicle);
  }
  private isDamagedRescueVehicle(vehicle: any): boolean{
    return this.rescueWhiteService.isDamagedRescueVehicle(vehicle);
  }
  private setRescueVehicleHp(vehicle: any, hp: number): void{
    this.rescueWhiteService.setRescueVehicleHp(vehicle, hp);
  }
  private hasActiveRescueBuff(value: any): boolean{
    return this.rescueWhiteService.hasActiveRescueBuff(value);
  }
  private shortenRescueBuff(buffs: any[], name: string, seconds: number): boolean{
    return this.rescueWhiteService.shortenRescueBuff(buffs, name, seconds);
  }
  private async saveRescueMap(map: any, summons: any[], vehicles: any[]): Promise<void>{
    return this.rescueWhiteService.saveRescueMap(map, summons, vehicles);
  }
  private async claimRescueMarker(userId: number, token: string): Promise<boolean>{
    return this.rescueWhiteService.claimRescueMarker(userId, token);
  }
  private async scheduleRescueCompletion(userId: number, marker: any): Promise<void>{
    return this.rescueWhiteService.scheduleRescueCompletion(userId, marker);
  }
  private async completeRescue(userId: number, marker: any): Promise<string>{
    return this.rescueWhiteService.completeRescue(userId, marker);
  }
  private async applyCompleteRescue(userId: number, marker: any): Promise<string>{
    return this.rescueWhiteService.applyCompleteRescue(userId, marker);
  }
  private async applyWhiteAngelRevivalTeleport(userId: number, player: any): Promise<string>{
    return this.rescueWhiteService.applyWhiteAngelRevivalTeleport(userId, player);
  }
  async materializeWhiteSummon( player: any, map: any, markers: Record<string, any>, ): Promise<void>{
    return this.rescueWhiteService.materializeWhiteSummon(player, map, markers);
  }
  async ensurePlayerWhite(player: any, map: any): Promise<any | null>{
    return this.rescueWhiteService.ensurePlayerWhite(player, map);
  }
  private async syncWhiteAffinity( player: any, white: any, markers: Record<string, any>, mapId: number, ): Promise<void>{
    return this.rescueWhiteService.syncWhiteAffinity(player, white, markers, mapId);
  }
  private async resolveRespawnMapId(allMaps: any[], fromMapId: number): Promise<number>{
    return this.rescueWhiteService.resolveRespawnMapId(allMaps, fromMapId);
  }
  private findWhiteAngelMapId( allMaps: any[], isOwnWhite: (unit: any) => boolean, parseSummons: (map: any) => any[], ): number{
    return this.rescueWhiteService.findWhiteAngelMapId(allMaps, isOwnWhite, parseSummons);
  }
  async handleCallVehicle(userId: number, vehicleName: string): Promise<string>{
    return this.movementVehicleService.handleCallVehicle(userId, vehicleName);
  }
  async handleInstallAll(userId: number): Promise<string>{
    return this.homeBuildService.handleInstallAll(userId);
  }
  async handleUninstallAll(userId: number): Promise<string>{
    return this.homeBuildService.handleUninstallAll(userId);
  }
  async handleBagOps(userId: number): Promise<string>{
    return this.gatherPanelService.handleBagOps(userId);
  }
  async handleEquipEnhance(userId: number, arg: string): Promise<string>{
    return this.equipCommandService.handleEquipEnhance(userId, arg);
  }
  async handleEquipBonus(userId: number, itemName: string): Promise<string>{
    return this.equipCommandService.handleEquipBonus(userId, itemName);
  }
  async handleEquipPreset(userId: number, action: string, args: string[]): Promise<string>{
    return this.equipCommandService.handleEquipPreset(userId, action, args);
  }
  private listEquipPresets(player: any, presets: any[]): string{
    return this.equipCommandService.listEquipPresets(player, presets);
  }
  private async calcPresetBonus(player: any, preset: any): Promise<Record<string, number>>{
    return this.equipCommandService.calcPresetBonus(player, preset);
  }
  private formatBonusText(bonus: Record<string, number>): string{
    return this.equipCommandService.formatBonusText(bonus);
  }
  async handleActivityShop(userId: number, itemName: string): Promise<string>{
    return this.shopTradeService.handleActivityShop(userId, itemName);
  }
  async handleDiamondShop(userId: number, itemName: string): Promise<string>{
    return this.shopTradeService.handleDiamondShop(userId, itemName);
  }
  async handleDataShop(userId: number, itemName: string): Promise<string>{
    return this.shopTradeService.handleDataShop(userId, itemName);
  }
  async handleProbeRadar(userId: number): Promise<string>{
    return this.gatherPanelService.handleProbeRadar(userId);
  }
  async handleProbeResources(userId: number, keyword: string): Promise<string>{
    return this.gatherPanelService.handleProbeResources(userId, keyword);
  }
  async handleProbeAndPickup(userId: number, keyword: string): Promise<string>{
    return this.gatherPanelService.handleProbeAndPickup(userId, keyword);
  }
  async handleProbeCrops(userId: number, keyword: string): Promise<string>{
    return this.gatherPanelService.handleProbeCrops(userId, keyword);
  }
  private async hasBuildingOnMap(userId: number, buildingName: string): Promise<boolean>{
    return this.gatherPanelService.hasBuildingOnMap(userId, buildingName);
  }
  private formatMapResourceYield(mapName: string): string{
    return this.gatherPanelService.formatMapResourceYield(mapName);
  }
  async handlePetOps(userId: number, action: string, args: string[]): Promise<string>{
    return this.petCommandService.handlePetOps(userId, action, args);
  }
  async handlePetRename(userId: number, petName: string, newName: string): Promise<string>{
    return this.petCommandService.handlePetRename(userId, petName, newName);
  }
  async handlePetTransfer(userId: number, petName: string, targetPlayer: string): Promise<string>{
    return this.petCommandService.handlePetTransfer(userId, petName, targetPlayer);
  }
  async handlePetDrive(userId: number, petName: string, vehicleName = '原'): Promise<string>{
    return this.petCommandService.handlePetDrive(userId, petName, vehicleName);
  }
  async handlePetFeed(userId: number, petName: string, count = 1): Promise<string>{
    return this.petCommandService.handlePetFeed(userId, petName, count);
  }
  async handlePetSniff(userId: number, targetName: string, monsterName = ''): Promise<string>{
    return this.petCommandService.handlePetSniff(userId, targetName, monsterName);
  }
  async handlePetAwaken(userId: number, petName: string, count = '1'): Promise<string>{
    return this.petCommandService.handlePetAwaken(userId, petName, count);
  }
  async handlePetAttack(userId: number, targetName: string): Promise<string>{
    return this.petCommandService.handlePetAttack(userId, targetName);
  }
  async handlePetGoto(userId: number, targetName: string, mapName = ''): Promise<string>{
    return this.petCommandService.handlePetGoto(userId, targetName, mapName);
  }
  async handlePetEquip(userId: number, petName: string, itemArg = ''): Promise<string>{
    return this.petCommandService.handlePetEquip(userId, petName, itemArg);
  }
  async handleAllStop(userId: number): Promise<string>{
    return this.petCommandService.handleAllStop(userId);
  }
  async handleAllActive(userId: number): Promise<string>{
    return this.petCommandService.handleAllActive(userId);
  }
  async handleAllPassive(userId: number): Promise<string>{
    return this.petCommandService.handleAllPassive(userId);
  }
  async handleAllMilk(userId: number): Promise<string>{
    return this.petCommandService.handleAllMilk(userId);
  }
  async handleAllCommands(userId: number): Promise<string>{
    return this.petCommandService.handleAllCommands(userId);
  }
  async handleAutoMine(userId: number): Promise<string>{
    return this.gatherPanelService.handleAutoMine(userId);
  }
  async handleStopMine(userId: number): Promise<string>{
    return this.gatherPanelService.handleStopMine(userId);
  }
  async handleRecipeUnlock(userId: number, recipeName = ''): Promise<string>{
    return this.shopTradeService.handleRecipeUnlock(userId, recipeName);
  }
  async handleConfirmHelp(userId: number, targetName: string): Promise<string>{
    return this.questDialogueService.handleConfirmHelp(userId, targetName);
  }
  async handleAutoShop(userId: number, itemName: string): Promise<string>{
    return this.shopTradeService.handleAutoShop(userId, itemName);
  }
  private findMerchantInSummons(map: any): { summons: any[]; index: number } | null{
    return this.shopTradeService.findMerchantInSummons(map);
  }
  private parseJsonArray(value: any): any[] {
    return this.support.parseJsonArray(value);
  }

  /**
   * 对应原版购物分支 L10031-L10042：开拓地限制与购买冷却。
   * 原版在自己的院子里不加“购买冷却”，在其他地图购买时每10秒允许一次。
   */
  private checkMerchantPurchaseGate( player: any, map: any, houseMap: any, ): { blocked: boolean; message: string; markers2: any[]; markers2Changed: boolean }{
    return this.shopTradeService.checkMerchantPurchaseGate(player, map, houseMap);
  }
  private itemQuantity(item: any): number{
    return this.support.itemQuantity(item);
  }
  private async advanceTask(userId: number, actionName: string, count = 1): Promise<void> {
    return this.support.advanceTask(userId, actionName, count);
  }

  /** 行商列表显示名包含原版显示特效名称所需的特效标签。 */
  private formatMerchantItem(item: any, includeQuantity = false, includeEffect = true): string{
    return this.shopTradeService.formatMerchantItem(item, includeQuantity, includeEffect);
  }
  formatMerchantItems(items: any[]): string{
    return this.shopTradeService.formatMerchantItems(items);
  }
  private addItemToCollection(collection: any[], item: any): void{
    this.support.addItemToCollection(collection, item);
  }
  private hasEnoughResources(backpack: any[], costs: any[]): boolean{
    return this.shopTradeService.hasEnoughResources(backpack, costs);
  }
  private generateMerchantResource(): any{
    return this.shopTradeService.generateMerchantResource();
  }
  async generateMerchantInventory(level: number, extra: number): Promise<any[]>{
    return this.shopTradeService.generateMerchantInventory(level, extra);
  }
  async buildMerchantInventory(level = 1, extra = 0): Promise<any[]>{
    return this.shopTradeService.buildMerchantInventory(level, extra);
  }
  private async purchaseMerchantItem( userId: number, player: any, markers: any, map: any, summons: any[], merchantIndex: number, merchantBackpack: any[], itemIndex: number, ): Promise<string>{
    return this.shopTradeService.purchaseMerchantItem(userId, player, markers, map, summons, merchantIndex, merchantBackpack, itemIndex);
  }
  private deductBackpackItem(backpack: any[], name: string, quantity: number): void{
    this.support.deductBackpackItem(backpack, name, quantity);
  }
  async handleRefreshMonster(userId: number, monsterName = ''): Promise<string>{
    return this.dungeonChallengeService.handleRefreshMonster(userId, monsterName);
  }
  async handleSpawnNpc(userId: number, argsString = ''): Promise<string>{
    return this.dungeonChallengeService.handleSpawnNpc(userId, argsString);
  }
  async handleDeleteMonster(userId: number): Promise<string>{
    return this.dungeonChallengeService.handleDeleteMonster(userId);
  }
  async handleProductionMode(userId: number, mode: number): Promise<string>{
    return this.skillCommandService.handleProductionMode(userId, mode);
  }
  async handleTransformText(userId: number, text: string): Promise<string>{
    return this.skillCommandService.handleTransformText(userId, text);
  }
  async handleSaveImage(userId: number, imageName: string): Promise<string>{
    return this.delayedSettleService.handleSaveImage(userId, imageName);
  }
  async handleStartSaveImage(userId: number): Promise<string>{
    return this.delayedSettleService.handleStartSaveImage(userId);
  }
  async handleStopSaveImage(userId: number): Promise<string>{
    return this.delayedSettleService.handleStopSaveImage(userId);
  }
  async handleStopTakeover(userId: number): Promise<string>{
    return this.movementVehicleService.handleStopTakeover(userId);
  }
  async handleConfirmResetImplant(userId: number): Promise<string>{
    return this.equipCommandService.handleConfirmResetImplant(userId);
  }
  async handleConfirmResetAmplifier(userId: number): Promise<string>{
    return this.equipCommandService.handleConfirmResetAmplifier(userId);
  }
  private async getPlayerName(userId: number): Promise<string> {
    return this.support.getPlayerName(userId);
  }
}
