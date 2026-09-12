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
  /** 采集开始阶段的进程内去重时间戳：key=userId（防同刻连发双开任务）。 */
  private readonly gatherStartInflight = new Map<number, number>();
  /** 玩家面板推送防抖定时器：同一玩家短时间内的多次状态变化合并为一次推送 */
  private readonly playerUpdateTimers = new Map<number, NodeJS.Timeout>();
  /** 地图面板推送防抖定时器：作用同上，避免自动战斗/怪物反击期间的 socket 风暴 */
  private readonly mapUpdateTimers = new Map<number, NodeJS.Timeout>();
  /** 推送版本号计数器（player:{uid} / map:{uid} → 单调递增 rev，供前端丢弃乱序旧包） */
  private readonly revCounters = new Map<string, number>();

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
    @Optional() private readonly autoMineService?: AutoMineService,
    // 活力上限与恢复公式共用规则服务，确保魅力历史值和旧存档兜底一致。
    @Optional() private readonly vitalityService?: VitalityService,
    // 玩家状态收口入口（Actor 式写入口）。放最后且 @Optional：
    // 既不影响现有测试桩的位置传参，未注入时也走 mutatePlayer 的等价回退路径。
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
    // 共享支撑层（P1-3 抽出）：数值/时长/标记等跨域辅助的唯一实现。
    // @Optional 兼容 29 位置参数与 Object.create 测试桩（C2）；未注入时由
    // supportSvc 访问器用桩自身的同名字段懒构造，委托目标恒存在（R8 兼容桥）。
    @Optional() private support?: GameSupportService,
    // RankingCommandService：15 个方法已迁出（本批 P2），未注入时由 rankingServiceSvc 懒构造桥兜底（C2 尾部追加）。
    @Optional() private rankingService?: RankingCommandService,
      // AdminCommandService：17 个方法已迁出（本批 P2），未注入时由 adminCommandServiceSvc 懒构造桥兜底（C2 尾部追加）。
    @Optional() private adminCommandService?: AdminCommandService,
    // FusionCraftService：20 个方法已迁出（本批 P2），未注入时由 fusionCraftServiceSvc 懒构造桥兜底（C2 尾部追加）。
    @Optional() private fusionCraftService?: FusionCraftService,
    // TimeSettleService：10 个方法已迁出（本批 P2），未注入时由 timeSettleServiceSvc 懒构造桥兜底（C2 尾部追加）。
    @Optional() private timeSettleService?: TimeSettleService,
    // PetCommandService：21 个方法已迁出（本批 P2），未注入时由 petCommandServiceSvc 懒构造桥兜底（C2 尾部追加）。
    @Optional() private petCommandService?: PetCommandService,
    // EquipCommandService：25 个方法已迁出（本批 P2），未注入时由 equipCommandServiceSvc 懒构造桥兜底（C2 尾部追加）。
    @Optional() private equipCommandService?: EquipCommandService,
    // SkillCommandService：23 个方法已迁出（本批 P2），未注入时由 skillCommandServiceSvc 懒构造桥兜底（C2 尾部追加）。
    @Optional() private skillCommandService?: SkillCommandService,
    // ShopTradeService：32 个方法已迁出（本批 P2），未注入时由 shopTradeServiceSvc 懒构造桥兜底（C2 尾部追加）。
    @Optional() private shopTradeService?: ShopTradeService,
    // QuestDialogueService：48 个方法已迁出（本批 P2），未注入时由 questDialogueServiceSvc 懒构造桥兜底（C2 尾部追加）。
    @Optional() private questDialogueService?: QuestDialogueService,
    // HomeBuildService：24 个方法已迁出（本批 P2），未注入时由 homeBuildServiceSvc 懒构造桥兜底（C2 尾部追加）。
    @Optional() private homeBuildService?: HomeBuildService,
    // DelayedSettleService：8 个方法已迁出（本批 P2），未注入时由 delayedSettleServiceSvc 懒构造桥兜底（C2 尾部追加）。
    @Optional() private delayedSettleService?: DelayedSettleService,
    // DungeonChallengeService：20 个方法已迁出（本批 P2），未注入时由 dungeonChallengeServiceSvc 懒构造桥兜底（C2 尾部追加）。
    @Optional() private dungeonChallengeService?: DungeonChallengeService,
    // RescueWhiteService：37 个方法已迁出（本批 P2），未注入时由 rescueWhiteServiceSvc 懒构造桥兜底（C2 尾部追加）。
    @Optional() private rescueWhiteService?: RescueWhiteService,
) {}

  /** RescueWhiteService 懒构造桥（R8）：生产由 Nest 注入；测试桩未注入时用门面自身字段构建，委托目标恒存在。 */
  private get rescueWhiteServiceSvc(): RescueWhiteService {
    if (!this.rescueWhiteService) {
      this.rescueWhiteService = new RescueWhiteService(
        this.supportSvc,
        this.prisma,
        this.playerService,
        this.combatSystem,
        this.mapService,
        this.chatService,
        this.taskService,
        this.delayedTaskService,
      );
    }
    return this.rescueWhiteService;
  }

  /** DungeonChallengeService 懒构造桥（R8）：生产由 Nest 注入；测试桩未注入时用门面自身字段构建，委托目标恒存在。 */
  private get dungeonChallengeServiceSvc(): DungeonChallengeService {
    if (!this.dungeonChallengeService) {
      this.dungeonChallengeService = new DungeonChallengeService(
        this.supportSvc,
        this.prisma,
        this.playerService,
        this.combatSystem,
        this.mapService,
        this.dungeonService,
        this.achievementService,
        this.itemSystemService,
        this.familiarSkillsService,
        this.staticData,
        this.taskService,
        this.shortcutService,
        this.combatState,
        this.vitalityService,
        this.delayedTaskService,
      );
    }
    return this.dungeonChallengeService;
  }

  /** DelayedSettleService 懒构造桥（R8）：生产由 Nest 注入；测试桩未注入时用门面自身字段构建，委托目标恒存在。 */
  private get delayedSettleServiceSvc(): DelayedSettleService {
    if (!this.delayedSettleService) {
      this.delayedSettleService = new DelayedSettleService(
        this.supportSvc,
        this.prisma,
        this.playerService,
        this.mapService,
        this.achievementService,
        this.homeService,
        this.staticData,
        this.chatService,
        this.taskService,
        this.combatState,
        this.delayedTaskService,
      );
    }
    return this.delayedSettleService;
  }

  /** HomeBuildService 懒构造桥（R8）：生产由 Nest 注入；测试桩未注入时用门面自身字段构建，委托目标恒存在。 */
  private get homeBuildServiceSvc(): HomeBuildService {
    if (!this.homeBuildService) {
      this.homeBuildService = new HomeBuildService(
        this.supportSvc,
        this.shopTradeServiceSvc,
        this.prisma,
        this.playerService,
        this.mapService,
        this.homeService,
        this.familiarSystemService,
        this.staticData,
        this.taskService,
        this.combatState,
        this.delayedTaskService,
      );
    }
    return this.homeBuildService;
  }

  /** QuestDialogueService 懒构造桥（R8）：生产由 Nest 注入；测试桩未注入时用门面自身字段构建，委托目标恒存在。 */
  private get questDialogueServiceSvc(): QuestDialogueService {
    if (!this.questDialogueService) {
      this.questDialogueService = new QuestDialogueService(
        this.supportSvc,
        this.prisma,
        this.playerService,
        this.combatSystem,
        this.mapService,
        this.achievementService,
        this.familiarSystemService,
        this.familiarSkillsService,
        this.tutorialService,
        this.staticData,
        this.systemConfigService,
        this.chatService,
        this.feedbackService,
        this.taskService,
        this.shortcutService,
        this.handbookService,
      );
    }
    return this.questDialogueService;
  }

  /** ShopTradeService 懒构造桥（R8）：生产由 Nest 注入；测试桩未注入时用门面自身字段构建，委托目标恒存在。 */
  private get shopTradeServiceSvc(): ShopTradeService {
    if (!this.shopTradeService) {
      this.shopTradeService = new ShopTradeService(
        this.supportSvc,
        this.prisma,
        this.playerService,
        this.itemService,
        this.mapService,
        this.achievementService,
        this.itemSystemService,
        this.homeService,
        this.familiarSystemService,
        this.staticData,
        this.taskService,
      );
    }
    return this.shopTradeService;
  }

  /** SkillCommandService 懒构造桥（R8）：生产由 Nest 注入；测试桩未注入时用门面自身字段构建，委托目标恒存在。 */
  private get skillCommandServiceSvc(): SkillCommandService {
    if (!this.skillCommandService) {
      this.skillCommandService = new SkillCommandService(
        this.supportSvc,
        this.prisma,
        this.playerService,
        this.mapService,
        this.familiarSystemService,
        this.familiarSkillsService,
        this.staticData,
        this.combatState,
        this.globalProficiency,
      );
    }
    return this.skillCommandService;
  }

  /** EquipCommandService 懒构造桥（R8）：生产由 Nest 注入；测试桩未注入时用门面自身字段构建，委托目标恒存在。 */
  private get equipCommandServiceSvc(): EquipCommandService {
    if (!this.equipCommandService) {
      this.equipCommandService = new EquipCommandService(
        this.supportSvc,
        this.playerService,
        this.itemService,
        this.itemSystemService,
        this.staticData,
        this.combatState,
      );
    }
    return this.equipCommandService;
  }

  /** PetCommandService 懒构造桥（R8）：生产由 Nest 注入；测试桩未注入时用门面自身字段构建，委托目标恒存在。 */
  private get petCommandServiceSvc(): PetCommandService {
    if (!this.petCommandService) {
      this.petCommandService = new PetCommandService(
        this.supportSvc,
        this.prisma,
        this.playerService,
        this.mapService,
        this.familiarSystemService,
        this.familiarSkillsService,
        this.staticData,
        this.combatState,
      );
    }
    return this.petCommandService;
  }

  /** TimeSettleService 懒构造桥（R8）：生产由 Nest 注入；测试桩未注入时用门面自身字段构建，委托目标恒存在。 */
  private get timeSettleServiceSvc(): TimeSettleService {
    if (!this.timeSettleService) {
      this.timeSettleService = new TimeSettleService(
        this.supportSvc,
        this.playerService,
        this.combatSystem,
        this.staticData,
        this.taskService,
        this.statsService,
        this.combatState,
        this.vitalityService,
        this.playerMutate,
      );
    }
    return this.timeSettleService;
  }

  /** FusionCraftService 懒构造桥（R8）：生产由 Nest 注入；测试桩未注入时用门面自身字段构建，委托目标恒存在。 */
  private get fusionCraftServiceSvc(): FusionCraftService {
    if (!this.fusionCraftService) {
      this.fusionCraftService = new FusionCraftService(
        this.supportSvc,
        this.playerService,
        this.itemService,
        this.mapService,
        this.itemSystemService,
        this.staticData,
        this.shortcutService,
      );
    }
    return this.fusionCraftService;
  }

  /** AdminCommandService 懒构造桥（R8）：生产由 Nest 注入；测试桩未注入时用门面自身字段构建，委托目标恒存在。 */
  private get adminCommandServiceSvc(): AdminCommandService {
    if (!this.adminCommandService) {
      this.adminCommandService = new AdminCommandService(
        this.supportSvc,
        this.prisma,
        this.adminService,
        this.delayedTaskService,
      );
    }
    return this.adminCommandService;
  }

  /** RankingCommandService 懒构造桥（R8）：生产由 Nest 注入；测试桩未注入时用门面自身字段构建，委托目标恒存在。 */
  private get rankingServiceSvc(): RankingCommandService {
    if (!this.rankingService) {
      this.rankingService = new RankingCommandService(
        this.supportSvc,
        this.prisma,
        this.playerService,
        this.bonusService,
        this.combatSystem,
        this.itemService,
        this.combatState,
      );
    }
    return this.rankingService;
  }

  /**
   * 门面委托目标（非空保证）：生产环境由 Nest 注入 GameSupportService；
   * 测试桩未注入时，用桩上已有的同名字段（playerService/prisma/...）懒构造一份——
   * 支撑层运行期用到的依赖与原方法在门面上的 this.X 完全一致，桩行为不变。
   */
  private get supportSvc(): GameSupportService {
    if (!this.support) {
      this.support = new GameSupportService(
        this.playerService,
        this.prisma,
        this.mapService,
        this.staticData,
        this.taskService,
        this.combatState,
        this.shortcutService,
        this.playerMutate,
      );
    }
    return this.support;
  }

  /**
   * 玩家状态变更的收口入口（对 PlayerMutateService.mutate 的薄封装）。
   *
   * 生产环境由 Nest 注入真实的 PlayerMutateService（Actor 式：锁内单一快照、
   * 统一落库、货币审计、嵌套复用）。测试桩若不提供该依赖，则退化为等价的
   * 「enqueueUserWrite + getPlayerData + fn + savePlayer」路径，保持旧行为不变，
   * 避免逐个测试桩补依赖。
   */
  private mutatePlayer<T>(userId: number, fn: (ctx: any) => Promise<T> | T): Promise<T> {
    return this.supportSvc.mutatePlayer(userId, fn);
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
    this.skillCommandService?.attachFacade?.(this);
    this.shopTradeService?.attachFacade?.(this);
    this.questDialogueService?.attachFacade?.(this);
    this.homeBuildService?.attachFacade?.(this);
    this.delayedSettleService?.attachFacade?.(this);
    this.dungeonChallengeService?.attachFacade?.(this);
    this.rescueWhiteService?.attachFacade?.(this);
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
    return this.questDialogueServiceSvc.triggerAutoFamiliarSkill(userId);
  }
  private async buildNumberedMenu( userId: number, options: { label: string; cmd: string }[], hint = '💡 发送编号数字(如 1)即可快速操作', extraGroups: string[] = [], ): Promise<string[]>{
    return this.supportSvc.buildNumberedMenu(userId, options, hint, extraGroups);
  }
  async handleViewUnit(userId: number, unitName: string): Promise<string>{
    return this.questDialogueServiceSvc.handleViewUnit(userId, unitName);
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
  async handleMove(userId: number, targetMapName: string): Promise<string> {
    // 读取"移动真实耗时"开关（配置项，可在管理后台在线切换）
    const moveTimeEnabled = await this.systemConfigService.get<boolean>('game.moveTimeEnabled', true);

    let playerData = await this.playerService.getPlayerData(userId);
    let { player } = playerData;

    // 1. 检查是否已在移动中
    const markers = playerData.markers;
    const movingStr = markers['移动中'];
    if (movingStr) {
      // 「移动中」标记兼容对象（新）与 JSON 字符串（旧数据）两种形态
      const moving = asJsonValue<{ targetName?: string; targetMapId?: number; arriveAt?: number } | null>(movingStr, null);
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
    if (!currentMap) {
      return `地图不存在，请检查名称`;
    }

    // 对齐原版 _主程序.ecode L6514：行动无限制（八项门禁：移动/复活/采集/工作/麻痹/
    // 躺下/自动开采/炮击，无豁免——移动中自然被拦）
    const moveRestriction = this.combatSystem.actionUnrestricted(player);
    if (moveRestriction.restricted) return moveRestriction.text;

    const requestedName = String(targetMapName || '').trim();

    // 对齐原版 L6516-6517：关卡图有怪且目标不是“出口”时，必须先清除附近的目标
    if (Number(currentMap.关卡 ?? 0) !== 0 && requestedName !== '出口') {
      let gateMonsters: any[] = [];
      try {
        gateMonsters = await this.mapService.getMapMonsters(currentMap);
      } catch {
        gateMonsters = [];
      }
      if (gateMonsters.length !== 0) {
        return `${player.name}需要清除附近的目标`;
      }
    }

    // 对齐原版 L6519-6536：空参返回编号菜单——家园进度≠0 时首位是自家房子，
    // 其余为非开拓地地图，全部写入临时输入替换（N@前往地图名）。
    if (!requestedName) {
      const maps = await this.mapService.getAllMaps();
      const options: string[] = [];
      const tempInputParts: string[] = [];
      if (player.houseName && this.playerService.getMarkerValue(asJsonValue(player.markers, {}), '家园进度') !== 0) {
        options.push(String(player.houseName));
        tempInputParts.push(`1@前往${player.houseName}`);
      }
      for (const m of maps) {
        if (!m || m.开拓地 || m.isFrontier) continue;
        options.push(String(m.name));
        tempInputParts.push(`${options.length}@前往${m.name}`);
      }
      if (this.shortcutService?.setTempInput && tempInputParts.length > 0) {
        await this.shortcutService.setTempInput(userId, tempInputParts.join('#'));
      }
      return `${player.name || '冒险者'}请选择地点:\n${options.map((n, i) => `${i + 1}、${n}`).join('\n')}`;
    }

    // 对齐原版 L6547-6548：处于战斗标记且本图有怪时不能前往
    {
      const moveMarkers2 = Array.isArray(playerData.markers2)
        ? playerData.markers2
        : this.parseJsonArray(player.markers2);
      let fightMonsters: any[] = [];
      try {
        fightMonsters = await this.mapService.getMapMonsters(currentMap);
      } catch {
        fightMonsters = [];
      }
      const combatText = { value: '' };
      if (fightMonsters.length !== 0 && this.combatState.markerRequire?.('战斗', moveMarkers2, combatText, Date.now())) {
        return `${player.name}战斗状态，`;
      }
    }

    // 对齐原版 L6549-6576：「出口」分支——副本退出（空间乱流）。
    // 当前地图可前往含“出口”时：随机目的地（编号3起、排除关卡/不刷特殊），
    // 路径=当前图→空间乱流→目的地（成就“移动”按路径节点数=3推进），
    // 耗时=50/速度（整数截断、下限3），写“移动”标记并延时到达。
    if (requestedName === '出口'
      && this.mapService.getConnections(currentMap).some((connection: any) => connection?.name === '出口')) {
      const maps = await this.mapService.getAllMaps();
      const candidates = maps.filter((m: any) =>
        Number(m?.id ?? 0) >= 3 && !m.关卡 && !m.isInstance && !m.noSpecial && !m.不刷特殊);
      if (candidates.length > 0) {
        const dest = candidates[Math.floor(Math.random() * candidates.length)];
        let exitSeconds = Math.floor(50 / Math.max(1, Number(player.speed || 100)));
        if (exitSeconds < 3) exitSeconds = 3;

        if (!moveTimeEnabled) {
          const arrival = await this.performArrival(userId, dest.id, dest.name);
          await this.advanceTask(userId, '移动', 3);
          return arrival;
        }

        await this.scheduleArrival(userId, dest.id, dest.name, exitSeconds);
        // 原版 L6574 添加标记("移动", b, 玩家.标记2)——行动无限制的移动锁数据源
        const exitMarkers2 = asJsonValue<any[]>(player.markers2, []);
        this.normalizeMarkers2(exitMarkers2);
        this.combatState.addMarker('移动', exitSeconds, exitMarkers2, Date.now());
        player.markers2 = exitMarkers2; // Json 列直接写数组
        await this.playerService.savePlayer(player);
        // 原版 L6573：路径节点数 = 当前图/空间乱流/目的地 共 3 个
        await this.advanceTask(userId, '移动', 3);
        const exitFollow = await this.summonFollowDisplay(currentMap, userId, { requireFollow: true });
        const exitFollowText = exitFollow.count > 0 ? `带着${exitFollow.names.join('、')}一起` : '';
        return `${player.name || '冒险者'}${exitFollowText}开始前往${dest.name},大概需要${exitSeconds}秒`;
      }
      // 地图无“出口”连接或无候选目的地：原版静默落空，继续按普通前往解析
    }

    const dungeonEntry = this.mapService.getConnections(currentMap)
      .find((connection: any) => connection?.name === requestedName);
    const isDungeonEntry = requestedName.endsWith('(副本)');
    let targetMap: any = null;
    if (isDungeonEntry) {
      // 原版 _主程序.ecode L6578-L6604：必须先验证当前地图存在该临时入口，
      // 再去掉“(副本)”解析真实地图并按传送路径移动。
      if (!dungeonEntry) return `${player.name}#错误：副本不存在"${requestedName}"`;
      const baseName = requestedName.slice(0, -4);
      targetMap = await this.mapService.getMapByName(baseName).catch(() => null);
    } else {
      targetMap = await this.mapService.getMapByName(requestedName).catch(() => null);
    }

    if (!currentMap || !targetMap) {
      return `地图不存在，请检查名称`;
    }

    // 对齐原版 _主程序.ecode L6610-6618：新手（未触发「召唤白」剧情）自动导航锁——
    // 目的地图编号 >2（医疗室/走廊之外）时拦截，并预置临时输入 1→观察附近。
    // 副本入口在原版分支中早于该锁，不受限。
    // 补充出生区作用域（当前地图 ≤2 才生效）：原版世界结构上不存在「人在外地且无召唤白」
    // 的玩家（新号出生医疗室，外出本身被此锁挡住）；但本项目存在迁移存量老玩家
    // （如人在地图66、标记无召唤白），无作用域时锁退化为全图禁行——走回出生区途经的
    // 每张图 id>2 同样被拦，且引导的「观察附近→打开休眠仓」只在医疗室存在，形成死循环
    // （2026-09-09 玩家无法移动事故）。
    if (!isDungeonEntry
      && Number(currentMap.id) <= 2
      && (Number(this.playerService.getMarkerValue(asJsonValue(player.markers, {}), '召唤白')) || 0) < 1
      && Number(targetMap.id) > 2) {
      if (this.shortcutService?.setTempInput) {
        await this.shortcutService.setTempInput(userId, '1@观察附近');
      }
      return `${player.name || '冒险者'}你现在还不能使用自动导航\n1、观察附近`;
    }

    // 对齐原版 _主程序.ecode L6626-6630：载具行走方式 0(未安装行走机构)/4(无法移动) 时不能"前往"
    const travelVehicle = await this.findTravelVehicle(player, currentMap);
    if (travelVehicle) {
      const walkMode = Number(travelVehicle?.行走方式 ?? travelVehicle?.walkMode ?? travelVehicle?.moveType ?? 0);
      if (walkMode === 0) {
        return `${player.name}当前驾驶的载具${travelVehicle?.名称 || travelVehicle?.name || ''}未安装行走机构或有的部件超过了上限`;
      }
      if (walkMode === 4) {
        return `${player.name}当前驾驶的载具${travelVehicle?.名称 || travelVehicle?.name || ''}安装了无法移动的组件`;
      }
    }

    // 对齐原版 _主程序.ecode 前往分支：目的地为当前位置时 取最短路径 距离为0，
    // 按“没有路径”拦截，不允许反复前往脚下地图；副本入口按传送处理不受此限制。
    if (!isDungeonEntry && Number(targetMap.id) === Number(currentMap.id)) {
      return `${player.name}所在地"${currentMap.name}"没有前往"${targetMap.name}"的路径`;
    }

    // 检查是否可以前往（原版 L6634：前往需求查出发地图；L6648：标记要求查目的地图）
    const check = isDungeonEntry
      ? { canTravel: true }
      : this.mapService.checkCanTravel(currentMap, targetMap, player, { mode: 'move', vehicle: travelVehicle });
    if (!check.canTravel) {
      return `无法前往：${check.reason}`;
    }

    // 计算移动所需耗时（秒）
    const travelDistance = isDungeonEntry
      ? Number(dungeonEntry?.distance || 100)
      : this.getDistance(currentMap, targetMap);
    // 原版 _主程序.ecode L6574/L6601/L6664：移动任务按最短路径节点数推进，
    // 不是按耗时或距离推进；路径长度至少按一次移动处理。
    const movementTaskCount = await this.getMovementPathLength(currentMap, targetMap);
    // 原版 L6638-6644：b = 距离/速度（整数截断）；b < 路径节点数 → b=路径节点数；b < 1 → b=1
    const travelTime = this.mapService.calcTravelTime(
      travelDistance,
      player.speed || 100,
      movementTaskCount,
    );

    // 若关闭了移动耗时开关，则即时到达
    if (!moveTimeEnabled) {
      const result = await this.performArrival(userId, targetMap.id, targetMap.name);
      if (!/不存在|已经在/.test(result)) {
        await this.advanceTask(userId, '移动', movementTaskCount);
      }
      return result;
    }

    // 2. 记录"移动中"状态（持久化到 markers，重启后可恢复），并调度延时到达
    const newMarkers = asJsonValue(player.markers, {});
    newMarkers['移动中'] = JSON.stringify({
      targetName: targetMap.name,
      targetMapId: targetMap.id,
      startedAt: Date.now(),
      arriveAt: Date.now() + travelTime * 1000,
      fromMapId: currentMap.id,
    });
    player.markers = newMarkers; // Json 列直接写对象
    // 原版 L6668 添加标记("移动", b, 玩家.标记2)——行动无限制移动锁的数据源
    const moveMarkers2 = asJsonValue<any[]>(player.markers2, []);
    this.normalizeMarkers2(moveMarkers2);
    this.combatState.addMarker('移动', travelTime, moveMarkers2, Date.now());
    player.markers2 = moveMarkers2; // Json 列直接写数组
    await this.playerService.savePlayer(player);

    // 3. 启动到达定时器，到点后真正落地（更新位置 + 广播到达）
    await this.scheduleArrival(userId, targetMap.id, targetMap.name, travelTime);
    await this.advanceTask(userId, '移动', movementTaskCount);

    return `你开始前往【${targetMap.name}】，预计${travelTime}秒后到达`;
  }

  /**
   * 处理“传送/跃迁”命令（对应 _主程序.ecode L1676-1808）。
   * 与“前往/移动”不同：传送立即落地。门禁链：死亡→行动无限制→载具行走方式四态
   * （无载具才检查天蓝吊坠/军姬免费传送）→空参菜单（家园房子+编号临时输入替换）→
   * 原地/不存在/不可传送→战斗状态（本图有怪）→5秒冷却→前往需求。
   * 执行：观测地图+剪毛→玩家移动(资产迁移)→成就→活跃度+1→代发言触发→
   * 观察附近(临时输入)→文本分支（无载具=分子重组+成就传送；有载具=跃迁到了+
   * 成就跃迁+旗舰跃迁引擎 30 秒冷却 200% 倍率攻击+覅攻击pd）。
   */
  async handleTeleport(userId: number, targetMapName: string): Promise<string> {
    let playerData = await this.playerService.getPlayerData(userId);
    let player = playerData.player;
    const name = player.name || '冒险者';
    { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    const markers2 = Array.isArray(playerData.markers2)
      ? playerData.markers2
      : this.parseJsonArray(player.markers2);
    const restriction = this.combatSystem.actionUnrestricted(player);
    if (restriction.restricted) return restriction.text;

    const currentMap = await this.mapService.getMapById(player.mapId);
    if (!currentMap) return '地图不存在，请检查名称';

    // 载具行走方式四态门禁（原版 L1684-1695）：有载具按行走方式拦截，
    // 无载具才检查天蓝吊坠/军姬免费传送。
    const vehicle = await this.findTravelVehicle(player, currentMap);
    if (vehicle) {
      const walkMode = Number(vehicle?.行走方式 ?? vehicle?.walkMode ?? vehicle?.moveType ?? 0);
      const vehicleName = vehicle?.名称 || vehicle?.name || '';
      if (walkMode === 1) return `${name}当前驾驶的载具${vehicleName}只能使用“前往”来移动`;
      if (walkMode === 2) return `${name}当前驾驶的载具${vehicleName}只能使用“前往”或者“飞到”来移动`;
      if (walkMode === 4) return `${name}当前驾驶的载具${vehicleName}安装了无法移动的组件`;
      if (walkMode === 0) return `${name}当前驾驶的载具${vehicleName}未安装行走机构或有的部件超过了上限`;
    } else {
      const equipment = playerData.equipment || asJsonValue<any[]>(player.equipment, []);
      const hasPendant = equipment.some((item: any) => String(item?.name ?? item?.名称 ?? '') === '天蓝吊坠');
      const freeByFamiliar = await this.familiarSystemService.canFreeTeleport(userId);
      if (!hasPendant && !freeByFamiliar) return `${name},需要装备“天蓝吊坠”`;
    }

    const requested = String(targetMapName || '').trim();
    if (!requested) {
      // 空参菜单（原版 L1706-1724）：家园进度≠0 时首位是自家房子，其余为可传送地图；
      // 全部编号写入临时输入替换（N@传送地图名）。
      const maps = await this.mapService.getAllMaps();
      const options: string[] = [];
      const tempInputParts: string[] = [];
      if (player.houseName && this.playerService.getMarkerValue(asJsonValue(player.markers, {}), '家园进度') !== 0) {
        options.push(String(player.houseName));
        tempInputParts.push(`1@传送${player.houseName}`);
      }
      for (const m of maps) {
        if (!m || m.不可传送 || m.noTeleport || m.开拓地 || m.isFrontier) continue;
        options.push(String(m.name));
        tempInputParts.push(`${options.length}@传送${m.name}`);
      }
      if (this.shortcutService?.setTempInput && tempInputParts.length > 0) {
        await this.shortcutService.setTempInput(userId, tempInputParts.join('#'));
      }
      return `${name}请选择地点:\n${options.map((n, i) => `${i + 1}、${n}`).join('\n')}\n你也可以发送“传送@人”来传送到其他玩家身边`;
    }

    let targetMap: any = null;
    let targetName = requested;
    const playerTarget = requested.match(/^\[@([^\]]+)\]$/);
    if (playerTarget) {
      const identity = playerTarget[1];
      const userModel: any = (this.prisma as any).user;
      const targetUser = await userModel?.findFirst?.({ where: { OR: [{ qqNumber: identity }, { externalId: identity }] } })
        ?? (/^\d+$/.test(identity) ? await userModel?.findUnique?.({ where: { id: Number(identity) } }) : null);
      if (!targetUser) return `${name}对方未加入游戏：${requested}`;
      const targetPlayer = await (this.prisma as any).player?.findUnique?.({ where: { userId: targetUser.id } });
      if (!targetPlayer) return `${name}对方未加入游戏：${requested}`;
      targetName = String(targetPlayer.location || targetPlayer.mapId || '');
      targetMap = await this.mapService.getMapById(targetPlayer.mapId);
    } else {
      targetMap = await this.mapService.getMapByName(requested).catch(() => null);
    }
    // 原版 L1734-1741 拦截顺序：原地 → 不存在 → 不可传送 → 战斗状态 → 冷却 → 前往需求
    if (targetMap && Number(targetMap.id) === Number(currentMap.id)) return `${name}不能原地重组。`;
    if (!targetMap) return `${name},${targetName}在地图列表不存在。`;
    if (targetMap.不可传送 || targetMap.noTeleport) {
      return `${name}目的地${targetName}存在严重干扰，贸然前往后果不可预料。`;
    }

    let mapMonsters: any[] = [];
    try {
      mapMonsters = await this.mapService.getMapMonsters(currentMap);
    } catch {
      mapMonsters = [];
    }
    const combatText = { value: '' };
    if (mapMonsters.length !== 0 && this.combatState.markerRequire?.('战斗', markers2, combatText, Date.now())) {
      return `${name}战斗状态`;
    }

    const cooldownText = { value: '' };
    if (this.combatState.timeIntervalRequire('传送冷却', 5, markers2, Date.now(), cooldownText, Date.now())) {
      player.markers2 = markers2; // Json 列直接写数组
      await this.playerService.savePlayer(player);
      return `${name}${cooldownText.value}`;
    }
    // 原版 L1744：传送查目的地图的前往需求（动态能力判定：vehicle 为 null=徒步持天蓝吊坠）
    const travelCheck = this.mapService.checkCanTravel(currentMap, targetMap, player, { mode: 'teleport', vehicle });
    if (!travelCheck.canTravel) return `${name}${travelCheck.reason || '无法前往该地图'}`;

    // ===== 执行（原版 L1747-1808）=====
    const fromMapId = player.mapId;
    player.mapId = targetMap.id;
    player.location = targetMap.name;

    // 观测地图产出 + 四圣祭坛麒麟 + 普拉娜幼崽剪毛（与来倒目的共用统一入口）
    let triggerText = '';
    try {
      triggerText = await this.applyArrivalTriggers(player, targetMap);
    } catch (e: any) {
      this.logger.warn(`传送到达触发失败: ${e.message}`);
    }

    // 玩家移动（原版 L1755）：载具/跟随召唤物资产迁移 + 移除“风月入墨”增益
    await this.migratePlayerAssetsOnMove(fromMapId, targetMap.id, player);

    await this.combatSystem.applyMapBuffs(player, targetMap);
    player.markers2 = markers2; // Json 列直接写数组
    await this.playerService.savePlayer(player);

    await this.taskService.advance(userId, `前往${targetName}`);
    // 任务结算(advance)基于最新库数据改写过字段，重载快照再写活跃度，避免旧对象回写。
    player = (await this.playerService.getPlayerData(userId)).player;

    // 活跃度+1（原版 L1759）
    const activeMarkers = asJsonValue(player.markers, {});
    this.incrementMarker(activeMarkers, '活跃度', 1);
    player.markers = activeMarkers;
    await this.playerService.savePlayer(player);

    // 代发言触发（原版 L1761-1777）：地图“代发言”字段当前数据未配置（已知遗留），
    // 字段存在时按原版语义执行——载具损毁看隐形披风，其余看载具隐形模块。
    const autoBroadcast = String((targetMap as any).代发言 ?? (targetMap as any).autoBroadcast ?? '');
    if (autoBroadcast) {
      if (autoBroadcast === '触发攻击') {
        const vehicleHp = Number(vehicle?.当前生命 ?? vehicle?.currentHp ?? vehicle?.hp ?? 0);
        let shouldTrigger = false;
        if (vehicle && vehicleHp < 0) {
          const freshEquip = asJsonValue<any[]>((await this.playerService.getPlayerData(userId)).player.equipment, []);
          const hasCloak = freshEquip.some((item: any) => String(item?.name ?? item?.名称 ?? '') === '隐形披风');
          shouldTrigger = !hasCloak;
        } else {
          const partNames = vehicle ? this.collectVehiclePartNames(vehicle) : [];
          shouldTrigger = !partNames.includes('隐形模块');
        }
        if (shouldTrigger) {
          // 原版 L1757-1771：此分支仅豁免隐形披风/隐形模块，不豁免隐匿模式
          await this.combatSystem.triggerMapBattleLoop(userId, 5, { player, map: targetMap }, { ignoreStealth: true });
        }
      }
      // 其余代发言文本为原版内部延时指令（0 秒新建延时），当前无对应映射，暂略。
    }

    // 观察附近 + 编号临时输入替换（原版 L1758 w4=观察附近 + 临时输入替换）
    let lookText = '';
    try {
      lookText = await this.handleLookAround(userId);
    } catch (e: any) {
      this.logger.warn(`传送生成观察附近失败: ${e.message}`);
    }

    const follow = await this.summonFollowDisplay(targetMap, userId, { requireFollow: true });
    const followText = follow.count > 0 ? `带着${follow.names.join('、')}一起` : '';
    let lines: string[];
    if (!vehicle) {
      lines = [`${name}${followText}在${targetName}完成了分子重组。`];
      await this.taskService.advance(userId, '传送');
    } else {
      lines = [`${name}${followText}跃迁到了${targetName}`];
      await this.taskService.advance(userId, '跃迁');
      // 旗舰跃迁引擎（原版 L1786-1800）：目的地有怪且载具装引擎，30 秒冷却通过时
      // 立即以 200% 倍率必中全体攻击 + 5 秒后怪物回合 + 活跃度+1。
      try {
        mapMonsters = await this.mapService.getMapMonsters(targetMap);
      } catch {
        mapMonsters = [];
      }
      const partNames = this.collectVehiclePartNames(vehicle);
      const jumpText = { value: '' };
      if (mapMonsters.length > 0
        && partNames.includes('旗舰跃迁引擎')
        && !this.combatState.timeIntervalRequire('旗舰跃迁', 30, markers2, Date.now(), jumpText, Date.now())) {
        const attack = await this.combatSystem.weaponAttack(userId, Number(player.currentWeapon ?? 0), {
          damageMultiplier: 200,
          mustHit: true,
          allAttack: true,
          attackText: '旗舰跃迁a',
        });
        if (attack?.result) lines.push(attack.result);
        player = (await this.playerService.getPlayerData(userId)).player;
        const jumpMarkers = asJsonValue(player.markers, {});
        this.incrementMarker(jumpMarkers, '活跃度', 1);
        player.markers = jumpMarkers;
        player.markers2 = markers2; // Json 列直接写数组
        await this.playerService.savePlayer(player);
        // 原版 L1789：旗舰跃迁引怪无隐匿豁免
        await this.combatSystem.triggerMapBattleLoop(userId, 5, { player, map: targetMap }, { ignoreStealth: true });
      }
    }
    if (triggerText) lines.push(triggerText);
    if (lookText) lines.push(lookText);
    return lines.join('\n');
  }

  /**
   * 处理飞到命令。
   * 飞行和普通前往共用到达结算，但入口条件、冷却和延迟时间按原版飞行分支单独处理。
   */
  async handleFlyTo(userId: number, targetMapName: string): Promise<string> {
    let playerData = await this.playerService.getPlayerData(userId);
    let { player } = playerData;
    const playerName = player.name || '冒险者';
    const markers = playerData.markers || asJsonValue(player.markers, {});
    const markers2 = Array.isArray(playerData.markers2)
      ? playerData.markers2
      : this.parseJsonArray(player.markers2);

      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    // 原版新手地图（地图序号小于3）不能直接飞行，只能先观察并按剧情移动。
    if (Number(player.mapId) < 3) {
      return `${playerName}当前不可用，观察附近看看吧`;
    }

    // 飞行不能覆盖正在进行的移动/工作；已到期的移动先补结算，兼容服务重启丢失定时器。
    const moving = asJsonValue<any>(markers['移动中'], null);
    if (moving?.arriveAt) {
      if (Date.now() < Number(moving.arriveAt)) {
        return `你正在前往【${moving.targetName || '目的地'}】，还需约${Math.max(1, Math.ceil((moving.arriveAt - Date.now()) / 1000))}秒到达，请耐心等待`;
      }
      if (moving.targetMapId) {
        await this.performArrival(userId, Number(moving.targetMapId), String(moving.targetName || '目的地'));
        playerData = await this.playerService.getPlayerData(userId);
        player = playerData.player;
      }
    }

    const currentMap = await this.mapService.getMapById(player.mapId);
    if (!currentMap) return '地图不存在，请检查名称';

    const activeMarkerText = { value: '' };
    if (this.combatState?.markerRequire?.('工作', markers2, activeMarkerText, Date.now())) {
      return `${playerName}正在工作，${activeMarkerText.value || '请稍后再试'}`;
    }

    const requestedName = String(targetMapName || '').trim();
    if (!requestedName) {
      const maps = typeof this.mapService.getAllMaps === 'function'
        ? await this.mapService.getAllMaps()
        : [];
      const options = maps
        .filter((map: any) => map && !map.noTeleport && !map.不可传送 && !map.isFrontier && !map.开拓地)
        .map((map: any) => String(map.name || ''))
        .filter((name: string) => name && name !== currentMap.name);
      if (this.shortcutService?.setTempInput && options.length > 0) {
        await this.shortcutService.setTempInput(
          userId,
          options.map((name: string, index: number) => `${index + 1}@飞到${name}`).join('#'),
        );
      }
      return `${playerName}请选择地点:\n${options.map((name: string, index: number) => `${index + 1}、${name}`).join('\n')}\n你也可以发送“飞到@人”来飞到其他玩家身边`;
    }

    let targetMap: any = null;
    const playerTarget = requestedName.match(/^\[@([^\]]+)\]$/);
    if (playerTarget) {
      const identity = playerTarget[1];
      const userModel: any = (this.prisma as any).user;
      let targetUser: any = null;
      if (userModel?.findFirst) {
        targetUser = await userModel.findFirst({
          where: { OR: [{ qqNumber: identity }, { externalId: identity }] },
        });
      }
      if (!targetUser && userModel?.findUnique && /^\d+$/.test(identity)) {
        targetUser = await userModel.findUnique({ where: { id: Number(identity) } });
      }
      if (!targetUser) return `${playerName}对方未加入游戏：${requestedName}`;
      const targetPlayer = await (this.prisma as any).player?.findUnique?.({
        where: { userId: targetUser.id },
      });
      if (!targetPlayer) return `${playerName}对方未加入游戏：${requestedName}`;
      targetMap = await this.mapService.getMapById(targetPlayer.mapId);
    } else {
      targetMap = await this.mapService.getMapByName(requestedName).catch(() => null);
    }

    if (!targetMap) return `${playerName},${requestedName}在地图列表不存在。`;
    if (targetMap.id === currentMap.id) return `${playerName}不能原地飞。`;
    if (targetMap.noTeleport || targetMap.不可传送) {
      return `${playerName}目的地${targetMap.name}无法飞过去。`;
    }

    let monsters: any[] = [];
    try {
      monsters = typeof this.mapService.getMapMonsters === 'function'
        ? await this.mapService.getMapMonsters(currentMap)
        : [];
    } catch {
      monsters = [];
    }
    const battleText = { value: '' };
    if (monsters.length > 0 && this.combatState?.markerRequire?.('战斗', markers2, battleText, Date.now())) {
      return `${playerName}战斗状态，${battleText.value || '请先结束战斗'}`;
    }

    const cooldownText = { value: '' };
    if (this.combatState?.timeIntervalRequire?.('飞行冷却', 10, markers2, Date.now(), cooldownText, Date.now())) {
      player.markers2 = markers2; // Json 列直接写数组
      await this.playerService.savePlayer(player);
      return `${playerName}${cooldownText.value}`;
    }

    // 原版 L1620：飞到查目的地图的前往需求（动态能力判定）
    const vehicle = await this.findTravelVehicle(player, currentMap);
    if (typeof this.mapService.checkCanTravel === 'function') {
      const check = this.mapService.checkCanTravel(currentMap, targetMap, player, { mode: 'fly', vehicle });
      if (!check.canTravel) return `${playerName}${check.reason || '无法前往该地图'}`;
    }

    const moveType = Number(vehicle?.行走方式 ?? vehicle?.walkMode ?? vehicle?.moveType ?? 0);
    if (vehicle && moveType === 0) {
      return `${playerName}当前驾驶的载具${vehicle.名称 || vehicle.name}未安装行走机构或有的部件超过了上限`;
    }
    if (vehicle && moveType === 1) {
      return `${playerName}当前驾驶的载具${vehicle.名称 || vehicle.name}只能使用“前往”来移动`;
    }
    if (vehicle && moveType === 4) {
      return `${playerName}当前驾驶的载具${vehicle.名称 || vehicle.name}安装了无法移动的组件`;
    }

    const hasFox = [...(playerData.equipment || []), ...(playerData.weapons || [])]
      .some((item: any) => String(item?.name ?? item?.名称 ?? '') === '狐');
    let arrivalMap = targetMap;
    let confused = false;
    if (!vehicle && !hasFox && Math.random() < 0.1) {
      const maps = typeof this.mapService.getAllMaps === 'function'
        ? await this.mapService.getAllMaps()
        : [];
      const candidates = maps.filter((map: any) =>
        map && map.id !== currentMap.id && Number(map.id) >= 3 && !map.noTeleport && !map.不可传送 && !map.isFrontier && !map.开拓地,
      );
      if (candidates.length > 0) {
        arrivalMap = candidates[Math.floor(Math.random() * candidates.length)];
        confused = arrivalMap.id !== targetMap.id;
      }
    }

    const seconds = vehicle || hasFox ? 5 : 10;
    const nextMarkers = asJsonValue(player.markers, {});
    nextMarkers['移动中'] = JSON.stringify({
      targetName: arrivalMap.name,
      targetMapId: arrivalMap.id,
      startedAt: Date.now(),
      arriveAt: Date.now() + seconds * 1000,
      fromMapId: currentMap.id,
      mode: '飞行',
    });
    player.markers = nextMarkers; // Json 列直接写对象
    player.markers2 = markers2; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    await this.scheduleArrival(userId, arrivalMap.id, arrivalMap.name, seconds);

    return confused
      ? `${playerName}飞了起来，但是遇到了混乱气流……`
      : `${playerName}飞了起来……`;
  }

  /** 查找玩家当前驾驶或接管的载具，避免把其他地图的载具当成当前载具。 */
  private async findTravelVehicle(player: any, currentMap: any): Promise<any | null> {
    const sets = this.parseVehicleValue<any>(player?.sets, {});
    const key = String(player?.vehicle || sets?.takeVehicle || sets?.接管载具 || '');
    if (!key) return null;
    const vehicles = this.parseVehicleValue<any[]>(currentMap?.vehicles, []);
    const keys = (value: any): string[] => [
      value?.编号, value?.vehicleId, value?.id, value?.名称, value?.name,
    ].filter((value) => value !== undefined && value !== null && String(value) !== '').map(String);
    const local = vehicles.find((value: any) => keys(value).includes(key));
    if (local) return this.toRuntimeVehicle(local);

    const gameVehicle: any = (this.prisma as any).gameVehicle;
    if (!gameVehicle) return null;
    const numericId = Number(key);
    let vehicle = Number.isInteger(numericId) && numericId > 0
      ? await gameVehicle.findUnique?.({ where: { id: numericId } })
      : null;
    if (!vehicle && gameVehicle.findFirst) {
      vehicle = await gameVehicle.findFirst({ where: { OR: [{ vehicleId: key }, { name: key }] } });
    }
    if (!vehicle) return null;
    if (Number(vehicle.mapIndex || 0) && Number(vehicle.mapIndex) !== Number(currentMap.id)) return null;
    return this.toRuntimeVehicle(vehicle);
  }

  /**
   * 调度延时到达
   * 在 travelTime 秒后调用 performArrival 真正完成移动
   * @param userId 用户ID
   * @param targetMapId 目标地图ID
   * @param targetMapName 目标地图名
   * @param travelTime 耗时（秒）
   */
  private async scheduleArrival(userId: number, targetMapId: number, targetMapName: string, travelTime: number): Promise<void> {
    if (!this.delayedTaskService) return;
    await this.delayedTaskService.schedule({
      type: 'move',
      userId,
      runAt: Date.now() + travelTime * 1000,
      payload: { targetMapId, targetName: targetMapName },
    });
  }

  /**
   * 真正完成移动（到达目的地）
   * 更新玩家位置、应用地图增益、记录探索成就，并向世界频道广播到达消息。
   * @param userId 用户ID
   * @param targetMapId 目标地图ID
   * @param targetMapName 目标地图名
   */
  /** 过渡期公开（P3-1 QuestDialogueService 经门面引用调用；P3-6 内核合并后改为直接注入） */
  async performArrival(
    userId: number,
    targetMapId: number,
    targetMapName: string,
  ): Promise<string> {
    // 支柱二·自串行：延时任务 tick 直调本方法时无任何外层锁；指令路径已在
    // mutate/邮箱内（enqueueUserWrite 重入放行）。统一过用户级串行邮箱，
    // 保证「读档→到达结算→写回」全程独占该玩家状态，不依赖调用方记得持锁。
    return this.playerService.enqueueUserWrite(userId, () =>
      this.applyPerformArrival(userId, targetMapId, targetMapName));
  }

  /** 移动到达结算的数据库读改写段（performArrival 已持用户级串行邮箱）。 */
  private async applyPerformArrival(
    userId: number,
    targetMapId: number,
    targetMapName: string,
  ): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    let { player } = playerData;

    const targetMap = await this.mapService.getMapById(targetMapId);
    if (!targetMap) {
      return `目标地图「${targetMapName}」不存在`;
    }

    // 定时器、服务重启补偿和内部到达命令可能同时触发；同一目标已经落地时不重复推进任务。
    const currentMarkers = asJsonValue(player.markers, {});
    const pending = asJsonValue<any>(currentMarkers['移动中'], null);
    if (Number(player.mapId) === Number(targetMap.id)
      && (!pending || Number(pending.targetMapId) !== Number(targetMap.id))) {
      return `你已经在【${targetMap.name}】`;
    }

    // 清除"移动中"状态
    const markers = currentMarkers;
    delete markers['移动中'];
    player.markers = markers; // Json 列直接写对象

    const fromMapId = player.mapId;
    player.mapId = targetMap.id;
    player.location = targetMap.name;

    // 对齐原版 地图操作.ecode L1093-1269 玩家移动+召唤物移动：
    // 1) 玩家载具从原地图迁移到目标地图
    // 2) 召唤物驾驶的载具迁移（行走方式≠0且≠4）
    // 3) 跟随玩家的召唤物迁移到目标地图
    // 4) 移除"风月入墨"增益（离开地图时失效）
    await this.migratePlayerAssetsOnMove(fromMapId, targetMap.id, player);

    // 进入地图时自动获得地图增益
    await this.combatSystem.applyMapBuffs(player, targetMap);
    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, `前往${targetMap.name}`);
    // 原版到达延时（来倒目的）在同一回复里前插“完成了任务:…”块；
    // 这里主动取出通知，避免延时路径无指令收尾而丢失提示。
    const arrivalTaskNotice = this.taskService.consumeNotifications(userId);

    // 任务结算(advance)基于数据库最新数据改写了 tasks/markers/backpack 等字段；
    // 这里必须重新加载玩家快照，否则下方探索成就用旧对象整体回写，
    // 会把刚完成的任务“复活”并回滚奖励。
    player = (await this.playerService.getPlayerData(userId)).player;

    // 到达不再"懒刷新"怪物（对齐原版）：原版 IS 不在地图到达处刷新怪物
    // （`刷新地图` 仅在服务器读档 接口1.ecode L1374 与副本刷新 后台运作 L1066 调用）。
    // 怪物补充完全由「刷新怪物」标记驱动：击杀登记 120 秒标记 → 到期后后台补 1 只
    // （`MapService.refillResidentMonstersByMarker` / `ScheduleService.respawnMonsters`）。
    // 旧实现「0 怪即整批满刷」会跳过原版的空窗期，并可能把其他玩家正在打的怪一并替换。

    // 探索成就：记录玩家首次到达的地图
    try {
      const mark = asJsonValue<Record<string, number>>(player.markers, {});
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

    // ========== 到达触发（对齐原版 来倒目的 _主程序.ecode L6694-6712）==========
    // 观测地图产出(通用段) / 四圣祭坛刷麒麟 / 普拉娜幼崽剪毛。
    let triggerText = '';
    try {
      triggerText = await this.applyArrivalTriggers(player, targetMap);
    } catch (e: any) {
      this.logger.warn(`到达触发失败: ${e.message}`);
    }

    // 对齐原版 来倒目的（_主程序.ecode L6751-6760）：到达回复 =
    // “玩家名来到了地图名”（关卡图附说明）+ 观察附近完整列表（含编号临时输入）。
    let lookText = '';
    try {
      lookText = await this.handleLookAround(userId);
    } catch (e: any) {
      this.logger.warn(`到达生成观察附近失败: ${e.message}`);
    }

    // 对齐原版 来倒目的 L6762-6776：狐自动攻击——装备#狐 且“狐”60秒冷却通过
    // 且本图有怪时，立即以 50% 倍率必中全体攻击并拉起怪物回合。
    let foxText = '';
    try {
      foxText = await this.applyFoxAutoAttack(userId, targetMap);
    } catch (e: any) {
      this.logger.warn(`到达狐自动攻击失败: ${e.message}`);
    }

    const isGateMap = Boolean((targetMap as any).isInstance || (targetMap as any).关卡);
    let text = `${player.name || '冒险者'}来到了${targetMap.name}`;
    if (isGateMap && targetMap.description) text += `\n${targetMap.description}`;
    if (triggerText) text += `\n${triggerText}`;
    if (lookText) text += `\n${lookText}`;
    if (foxText) text += `\n${foxText}`;
    if (arrivalTaskNotice) text = `${arrivalTaskNotice}\n————————\n${text}`;

    // 注：原版到达拉起怪物攻击（_主程序.ecode L1755-1795）仅限地图"代发言=触发攻击"
    // 且载具损毁/无隐形模块的场景；本框架地图表未配置"代发言"字段，普通到达不惊动怪物，
    // 怪物回合仍由攻击/采集等动作触发（triggerMapBattleLoop）。

    // 向世界频道广播到达消息（持久化 + 实时推送）
    await this.chatService.broadcastSystem('世界频道', text, userId);

    // 定向刷新该玩家的地图总览面板
    try {
      const overview = await this.getMapOverview(userId);
      this.chatService.emitToUser(userId, 'map:update', { overview });
      // 玩家面板无需手动刷新：上方 savePlayer 已由 Prisma 拦截器自动触发 player:update
    } catch (e: any) {
      this.logger.warn(`刷新玩家 ${userId} 地图面板失败: ${e.message}`);
    }

    return text;
  }

  /**
   * 到达触发狐自动攻击（原版 _主程序.ecode L6762-6776 来倒目的）。
   * 装备#狐（特殊序号27，非持握）且“狐”60秒冷却通过且本图有怪时：
   * 以当前武器对全体怪物 50% 倍率必中攻击（attackText “狐a”），随后
   * 新建延时“覅攻击pd”5秒（triggerMapBattleLoop，含玩家活跃）+ 活跃度+1。
   * 击杀奖励由 weaponAttack 内部结算（对应原版 发放奖励）。
   * @returns 攻击结果文本（未触发时为空串）
   */
  private async applyFoxAutoAttack(userId: number, map: any): Promise<string> {
    const fresh = await this.playerService.getPlayerData(userId);
    const freshPlayer = fresh.player;
    const equipments = fresh.equipment || asJsonValue<any[]>(freshPlayer.equipment, []);
    const weapons = fresh.weapons || asJsonValue<any[]>(freshPlayer.weapons, []);
    if (!this.combatState.equipRequire(equipments, weapons, Number(freshPlayer.currentWeapon ?? 0), 27, '狐', false)) {
      return '';
    }

    const markers2 = Array.isArray(fresh.markers2)
      ? fresh.markers2
      : this.parseJsonArray(freshPlayer.markers2);
    const foxText = { value: '' };
    const foxBlocked = this.combatState.timeIntervalRequire('狐', 60, markers2, Date.now(), foxText, Date.now());

    let monsters: any[] = [];
    if (!foxBlocked) {
      try {
        monsters = await this.mapService.getMapMonsters(map);
      } catch {
        monsters = [];
      }
    }

    let attackResult = '';
    if (!foxBlocked && monsters.length > 0) {
      const attack = await this.combatSystem.weaponAttack(userId, Number(freshPlayer.currentWeapon ?? 0), {
        damageMultiplier: 50,
        mustHit: true,
        allAttack: true,
        attackText: '狐a',
      });
      attackResult = attack?.result || '';
    }

    // 落库：狐冷却标记 + 活跃度+1（攻击后重载快照，避免覆盖 weaponAttack 的击杀/掉落写入）
    const afterPlayer = (await this.playerService.getPlayerData(userId)).player;
    const afterMarkers = asJsonValue<Record<string, any>>(afterPlayer.markers, {});
    if (attackResult) this.incrementMarker(afterMarkers, '活跃度', 1);
    afterPlayer.markers = afterMarkers;
    afterPlayer.markers2 = markers2; // Json 列直接写数组
    await this.playerService.savePlayer(afterPlayer);

    if (attackResult) {
      // 原版 L6767-6771：覅攻击pd 5秒 + 玩家活跃（triggerMapBattleLoop 内处理）；
      // 狐分支无隐匿豁免（ignoreStealth）
      await this.combatSystem.triggerMapBattleLoop(userId, 5, { player: afterPlayer, map }, { ignoreStealth: true });
    }
    return attackResult;
  }

  /**
   * 到达地图统一触发（对齐原版 来倒目的 _主程序.ecode L6694-6712 / 传送 L1753-1777）。
   * 1) 观测地图产出·通用段（地图操作.ecode 观测地图 L53-76）：宠物产蛋/垃圾、具现装置产未知物品；
   *    开拓地(家园)的完整观测（建筑/作物）由「家园产出」命令的 collectHomeOutput 结算，此处跳过避免双重记账。
   * 2) 四圣祭坛：其余四祭坛怪物清空后刷出神兽麒麟（L6697-6712）。
   * 3) 普拉娜幼崽剪毛（使魔技能.ecode L14-70）：带剪刀的普拉娜幼崽召唤物为地图动物剪毛。
   * @param player 到达玩家
   * @param targetMap 目标地图行
   * @returns 附加文本（无则空串）
   */
  private async applyArrivalTriggers(player: any, targetMap: any): Promise<string> {
    const lines: string[] = [];
    const readNum = (v: any): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    // ===== 1. 观测地图产出·通用段 =====
    if (!targetMap.isFrontier && !targetMap.isInstance) {
      const nowSec = Date.now() / 1000;
      // mutateMapFields 锁内闭环：重读最新 items/markers/summons/buildings → 计算产出 → 差异写回
      // （markers 记录观测时间必然变化；items 仅在真正产出时变化，由逐字段 JSON 比对决定是否落库）
      await this.mapService.mutateMapFields(targetMap.id, ['items', 'markers', 'summons', 'buildings'], (f) => {
        const mapMarkers = f.markers as Record<string, any>;
        const lastObserved = readNum(mapMarkers['观测时间']);
        const timeDiff = lastObserved > 0 ? Math.max(0, nowSec - lastObserved) : 0;
        mapMarkers['观测时间'] = nowSec;
        const items = f.items as any[];
        const mergeItem = (name: string, qty: number): void => {
          if (!(qty > 0)) return;
          const found = items.find((it: any) => it && (it.name ?? it.名称) === name);
          if (found) {
            // 数量累加统一过 roundItemQuantity 三道闸（比例产出会累出浮点长尾）
            found.quantity = roundItemQuantity(readNum(found.quantity ?? found.count ?? found.数量) + qty);
          } else {
            items.push({ name, quantity: roundItemQuantity(qty) });
          }
        };
        if (f.summons.length > 0) {
          // 蛋/垃圾：时间差/86400×宠物数（原版 L60-66 两项同率累计入 地图.物品）
          const rate = (timeDiff / 86400) * f.summons.length;
          mergeItem('蛋', rate);
          mergeItem('垃圾', rate);
        }
        // 具现装置：每天产出1个未知物品（原版 L70-75）
        const hasGadget = (f.buildings as any[]).some(
          (b: any) => b && String(b.name ?? b.名称 ?? '') === '具现装置' && readNum(b.quantity ?? b.count ?? b.数量 ?? 1) > 0,
        );
        if (hasGadget) mergeItem('未知物品', timeDiff / 86400);
      });
    }

    // ===== 2. 四圣祭坛刷麒麟（原版 来倒目的 L6697-6712）=====
    if (targetMap.name === '四圣祭坛') {
      try {
        const residentMonsters = (await this.mapService.getMapMonsters(targetMap.id)).filter((m: any) => !m.isTemp);
        if (residentMonsters.length === 0) {
          const hasMonsterIn = async (name: string): Promise<boolean> => {
            const m = await this.mapService.getMapByName(name);
            if (!m) return false;
            const list = await this.mapService.getMapMonsters(m.id);
            return list.length > 0;
          };
          const cleared = !(await hasMonsterIn('白虎祭坛'))
            && !(await hasMonsterIn('青龙祭坛'))
            && !(await hasMonsterIn('玄武祭坛'))
            && !(await hasMonsterIn('朱雀祭坛'));
          if (cleared) {
            // 神兽麒麟：事件型临时怪物，写入 GameMonster 表 isTemp=true
            await this.mapService.addTempMonster(targetMap.id, {
              name: '神兽麒麟',
              type: '神兽麒麟',
              specialSeq: 0,
              level: Math.max(10, player.level || 10),
              hp: 5000,
              maxHp: 5000,
              attack: 200,
              defense: 50,
              speed: 120,
              exp: 500,
            });
            lines.push('四座祭坛的怪物都已被清除，一股强大的气息在祭坛中央凝聚……');
            lines.push('神兽麒麟出现了！');
          }
        }
      } catch (e: any) {
        this.logger.warn(`四圣祭坛麒麟生成失败: ${e.message}`);
      }
    }

    // ===== 3. 普拉娜幼崽剪毛（使魔技能.ecode L14-70）=====
    try {
      const shearText = await this.shearPranaCubsOnArrival(targetMap, player);
      if (shearText) lines.push(shearText);
    } catch (e: any) {
      this.logger.warn(`到达剪毛触发失败: ${e.message}`);
    }

    return lines.join('\n');
  }

  /**
   * 到达时普拉娜幼崽自动剪毛（使魔技能.ecode L14-70）。
   * 遍历当前地图召唤物：活力==-31(普拉娜幼崽) 且武器含剪刀(特殊序号-40/名称"剪刀")的幼崽，
   * 为其归属者剪当前地图全部动物的毛发——每类动物每天一次（时间间隔要求("剪毛"+类型, 有效期当天())）。
   * 毛发进入幼崽 装备预设[2].装备（宠物随身包），并计入归属者 剪毛/采集 成就与任务。
   * ⚠️偏差：原版还会剪地图上其他玩家使魔的毛发，本框架动物仅遍历召唤物（玩家本体无毛发字段，不剪）。
   */
  private async shearPranaCubsOnArrival(map: any, arrivingPlayer: any): Promise<string> {
    const readNum = (v: any): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const summons = asJsonValue<any[]>(map.summons, []);
    if (!summons.length) return '';
    const isPranaCub = (s: any): boolean =>
      !!s && (Number(s.vitality ?? s.活力 ?? 0) === -31 || String(s.type ?? s.类型 ?? '') === '普拉娜幼崽');
    const cubs = summons.filter(isPranaCub);
    if (!cubs.length) return '';

    const dayEndMs = (() => {
      const d = new Date();
      d.setHours(23, 59, 59, 999);
      return d.getTime();
    })();
    const nowMs = Date.now();

    for (const cub of cubs) {
      // 剪刀判定（原版 L27-33）：武器列表含 特殊序号==#剪刀(-40)
      const rawWeapons = cub.weapons ?? cub.武器;
      const weapons = Array.isArray(rawWeapons)
        ? rawWeapons
        : asJsonValue<any[]>(String(rawWeapons ?? '[]'), []);
      const hasScissors = weapons.some(
        (w: any) => w && (String(w.name ?? w.名称 ?? '') === '剪刀' || Number(w.specialSeq ?? w.特殊序号 ?? 0) === -40),
      );
      if (!hasScissors) continue;

      // 归属者解析（原版 L36-41）：归属 != 当前玩家 → 取玩家(归属)，否则用当前玩家
      const ownerKey = String(cub.ownerQQ ?? cub.归属 ?? cub.owner ?? '');
      let owner = arrivingPlayer;
      if (ownerKey
        && ownerKey !== String(arrivingPlayer.qq ?? '')
        && ownerKey !== String(arrivingPlayer.userId ?? '')
        && ownerKey !== String(arrivingPlayer.qqNumber ?? '')) {
        owner = await this.prisma.player.findFirst({
          where: [
            { qqNumber: ownerKey },
            { userId: Number(ownerKey) || -1 },
          ] as any,
        }).catch(() => null) as any;
        if (!owner) continue;
      }

      // 幼崽需有 装备预设[2]（原版 L35）；毛发写入 装备预设[2].装备（宠物随身包）
      const rawPresets = cub.equipmentPresets ?? cub.装备预设;
      const presets = Array.isArray(rawPresets)
        ? rawPresets
        : asJsonValue<any[]>(String(rawPresets ?? '[]'), []);
      if (presets.length <= 1) continue;
      if (!presets[1]) presets[1] = { name: '宠物背包', equipment: [] };
      const rawBag = presets[1].equipment ?? presets[1].装备;
      const bag = Array.isArray(rawBag)
        ? rawBag
        : asJsonValue<any[]>(String(rawBag ?? '[]'), []);

      const markers2 = asJsonValue<any[]>(owner.markers2, []);
      let totalHair = 0;
      for (const animal of summons) {
        if (!animal || animal === cub) continue;
        const typeName = String(animal.type ?? animal.类型 ?? animal.name ?? animal.名称 ?? '').trim();
        if (!typeName) continue;
        const key = `剪毛${typeName}`;
        // 时间间隔要求(name, 有效期当天())：存在且未过期 → 冷却中
        const cd = markers2.find((m: any) => m && m.name === key);
        if (cd && Number(cd.expireAt ?? 0) > nowMs) continue;
        const filtered = markers2.filter((m: any) => !(m && m.name === key));
        filtered.push({ name: key, expireAt: dayEndMs });
        markers2.length = 0;
        markers2.push(...filtered);
        // 毛发：召唤物自带 毛发 字段为空时按原版默认给"毛发"1个（@Struct L342）
        const hairRaw = animal.毛发 ?? animal.hair;
        const hairName = String(hairRaw?.name ?? hairRaw?.名称 ?? '毛发') || '毛发';
        const hairQty = Math.max(1, Math.round(readNum(hairRaw?.quantity ?? hairRaw?.数量 ?? 1)));
        const found = bag.find((it: any) => it && (it.name ?? it.名称) === hairName);
        if (found) {
          found.quantity = (Number(found.quantity ?? found.count ?? found.数量) || 0) + hairQty;
        } else {
          bag.push({ name: hairName, quantity: hairQty });
        }
        totalHair += hairQty;
      }

      if (totalHair > 0) {
        presets[1].equipment = bag;
        cub.equipmentPresets = cub.装备预设 = presets;
        owner.markers2 = markers2; // Json 列直接写数组
        // 地图聚合串行化写入口：锁内重读最新 summons，把「装备预设」写回其中的幼崽
        // （幼崽可能被并发路径迁移/移除，找不到时跳过，绝不复活已删除单位）。
        const cubQQ = String(cub?.qq ?? cub?.QQ ?? '');
        const cubName = String(cub?.name ?? cub?.名称 ?? '');
        const isSameCub = (s: any): boolean =>
          !!s && String(s?.qq ?? s?.QQ ?? '') === cubQQ
            && (cubQQ ? true : String(s?.name ?? s?.名称 ?? '') === cubName);
        await this.mapService.mutateSummons(map.id, (fresh) => {
          const freshCub = fresh.find(isSameCub);
          if (freshCub) freshCub.equipmentPresets = freshCub.装备预设 = presets;
        });
        if (owner.userId) {
          await this.playerService.savePlayer(owner);
          await this.achievementService.addAchievement(owner, '剪毛', totalHair, false);
          await this.achievementService.addAchievement(owner, '采集', totalHair, false);
        }
        return `${cub.name ?? cub.名称 ?? '普拉娜幼崽'} 为地图上的动物剪了毛，获得了毛发x${totalHair}`;
      }
    }
    return '';
  }

  /**
   * 玩家移动时迁移载具和跟随召唤物（对齐原版 地图操作.ecode L1093-1269）。
   * - 玩家载具：从原地图 vehicles 数组中移除，添加到目标地图 vehicles 数组
   * - 召唤物驾驶的载具：行走方式≠0(无行走机构)且≠4(坐地)时迁移
   * - 跟随召唤物：标记中"跟随"熟练度<1 的召唤物迁移到目标地图
   * - 风月入墨增益：离开地图时从玩家增益列表中移除
   * @param fromMapId 原地图ID
   * @param toMapId 目标地图ID
   * @param player 玩家对象（含 vehicle/qq/buffs 等字段）
   */
  private async migratePlayerAssetsOnMove(
    fromMapId: number,
    toMapId: number,
    player: any,
  ): Promise<void> {
    if (!fromMapId || Number(fromMapId) === Number(toMapId)) return;

    const playerQQ = String(player.userId ?? player.qq ?? '');
    if (!playerQQ) return;

    try {
      const vehicleKey = (v: any) => String(v?.id ?? v?.编号 ?? v?.vehicleId ?? '');
      const summonOwner = (s: any) => String(s?.归属 ?? s?.owner ?? s?.qq ?? '');

      // 地图聚合串行化写入口：迁出/迁入各自在 per-map 锁内「重读最新容器 → 改 → 写回」
      // 闭环执行，消除基于合并快照的旧数据覆盖（跟随单位被地图写竞态清除的根因）。
      // === 1~3. 载具与跟随召唤物迁出（原版 L1125-1256）===
      const movers = await this.mapService.mutateMapFields(
        Number(fromMapId),
        ['summons', 'vehicles'],
        (f) => {
          const fromVehicles = f.vehicles;
          const fromSummons = f.summons;
          const moved = { vehicles: [] as any[], summons: [] as any[] };

          // === 1. 玩家载具迁移（原版 L1125-1142）===
          if (player.vehicle) {
            const pVehicleKey = String(player.vehicle);
            const idx = fromVehicles.findIndex((v: any) => vehicleKey(v) === pVehicleKey);
            if (idx >= 0) {
              // 从原地图移除载具，添加到目标地图
              moved.vehicles.push(fromVehicles[idx]);
              fromVehicles.splice(idx, 1);
            }
          }

          // === 2. 召唤物驾驶的载具迁移（原版 L1201-1243）===
          // 只迁移跟随玩家的召唤物的载具（行走方式≠0且≠4）
          const followSummons = fromSummons.filter((s: any) => summonOwner(s) === playerQQ);
          for (const summon of followSummons) {
            const sVehicle = String(summon?.载具 ?? summon?.vehicle ?? '');
            if (!sVehicle) continue;

            // 检查"跟随"熟练度<1（原版 取成就熟练度(标记,"跟随")<1）
            const summonMarkers = asJsonValue<any[]>(summon?.标记 ?? summon?.markers, []);
            const followSkill = summonMarkers['跟随'] ?? 0;
            if (Number(followSkill) >= 1) continue; // 熟练度>=1 不迁移（非跟随状态）

            const vIdx = fromVehicles.findIndex((v: any) => vehicleKey(v) === sVehicle);
            if (vIdx < 0) continue;

            const sv = fromVehicles[vIdx];
            const walkMode = Number(sv?.行走方式 ?? sv?.walkMode ?? 0);
            // 行走方式 0=无行走机构（不能动），4=坐地（不能动）
            if (walkMode === 0 || walkMode === 4) continue;

            moved.vehicles.push(sv);
            fromVehicles.splice(vIdx, 1);
          }

          // === 3. 跟随召唤物迁移（原版 L1244-1256）===
          for (let i = fromSummons.length - 1; i >= 0; i--) {
            const s = fromSummons[i];
            if (summonOwner(s) !== playerQQ) continue;

            // 跟随熟练度<1 才迁移
            const sMarkers = asJsonValue<any[]>(s?.标记 ?? s?.markers, []);
            const fSkill = sMarkers['跟随'] ?? 0;
            if (Number(fSkill) >= 1) continue;

            // 更新召唤物地图字段并迁移
            (s as any).地图 = Number(toMapId);
            (s as any).mapId = Number(toMapId);
            moved.summons.push(s);
            fromSummons.splice(i, 1);
          }
          return moved;
        },
      );

      // === 迁入：把迁出单位并入目标地图（同样锁内闭环）===
      await this.mapService.mutateMapFields(Number(toMapId), ['summons', 'vehicles'], (f) => {
        f.vehicles.push(...movers.vehicles);
        f.summons.push(...movers.summons);
      });

      // === 4. 移除"风月入墨"增益（原版 L1146-1154）===
      // 原版在移动时从 player.增益 中删除"风月入墨"（离开地图失效）
      const buffs = asJsonValue<any[]>(player.buffs, []);
      const beforeLen = buffs.length;
      const keptBuffs = buffs.filter((b: any) => String(b?.name ?? b?.名称 ?? '') !== '风月入墨');
      if (keptBuffs.length !== beforeLen) {
        player.buffs = keptBuffs; // Json 列直接写数组
      }
    } catch (e: any) {
      this.logger.warn(`迁移玩家载具/召唤物失败: ${e?.message}`);
    }
  }

  /**
   * 构建当前玩家的状态摘要（等级/经验/HP/护盾/装甲/属性等）
   * 数据结构与 GET /game/player/info 一致，供前端玩家信息面板展示，
   * 也用于指令执行后通过 socket 实时刷新玩家面板。
   * @param userId 用户ID
   * @returns 玩家状态摘要对象（属性为按等级+熟练度计算后的值）
   */
  async buildPlayerInfo(userId: number): Promise<any | null> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    // 计算后属性（对齐原版 _计算玩家，与控制器 getPlayerInfo 保持一致）
    const calcBonus = this.combatSystem.buildAttackerBonus(player, playerData);
    // 战斗力（基于"计算后"的成长属性，与文本面板 handleInfo 同口径）
    const powerBonus: BonusData = {
      攻击: calcBonus.攻击 || 0,
      生命: calcBonus.生命 || 0,
      装甲: calcBonus.装甲 || 0,
      速度: calcBonus.速度 || 0,
    };
    return {
      id: player.id,
      userId: player.userId,
      level: player.level,
      exp: player.exp,
      upgradeExp: this.playerService.calcUpgradeExp(player.level),
      name: player.name,
      type: player.type,
      hp: player.hp,
      maxHp: Math.round(calcBonus.生命 || player.maxHp || 100),
      shield: player.shield,
      maxShield: Math.round(calcBonus.护盾 || player.maxShield || 0),
      armor: player.armor,
      maxArmor: Math.round(calcBonus.装甲 || player.maxArmor || 0),
      attack: Math.round(calcBonus.攻击 || 0),
      speed: Math.round(calcBonus.速度 || player.speed || 0),
      dodge: Math.round(calcBonus.闪避 || 0),
      hit: Math.round(calcBonus.命中 || 0),
      crit: Math.round(calcBonus.暴击 || 0),
      critDmg: Math.round(calcBonus.暴击伤害 || 150),
      mapId: player.mapId,
      location: player.location,
      affinity: player.affinity,
      vitality: Number(player.vitality || 0),
      maxVitality: this.vitalityService
        ? this.vitalityService.getVitalityMax(markers)
        : Math.max(100, Number(this.playerService.getMarkerValue(markers, '活力2')) || 100),
      combatPower: this.bonusService.calcCombatPower(powerBonus),
      tasks: this.buildActiveTasks(playerData.tasks),
      equipment: this.buildEquipmentSnapshot(player, markers),
      buffs: this.buildActiveBuffs(playerData.buffs),
      // 进行中的延时操作（采集/移动/抢救…）：前端据此渲染统一倒计时进度条
      pendingActions: this.buildPendingActions(player, markers, playerData.markers2, playerData.buffs),
    };
  }

  /**
   * 进行中的延时操作快照（网页「进行中操作」倒计时条用）。
   *
   * 原版里大量指令是"发指令 → 等 N 秒 → 延时结算"，期间玩家会被行动限制锁住，
   * 但界面上只有聊天区一行文字提示，玩家常常误以为指令没生效而重复发送。
   * 这里把玩家身上所有"还需要 N 秒"的状态汇总成统一结构，前端一次性渲染：
   *   - 采集：markers['采集中']（打开箱子 / 打开休眠仓 / 收集木头 / 捡垃圾 等地图资源指令）
   *   - 移动：markers['移动中']（前往其它地图的路途耗时）
   *   - 抢救：markers2 中 name=复活（抢救使魔 / 维修载具 / 自救）
   *   - 工作：markers2 中 name=工作（救助其他玩家）
   *   - 麻痹：markers2 中 name=麻痹（负面锁定状态）
   *   - 卷土重来：buffs 中 name=卷土重来（倒地免死保护，到期即真死）
   * 只输出仍未到期的条目；已到期的由各自的延时结算/兜底任务清除，前端也会本地剔除。
   *
   * 关于进度百分比：只有 `endAt` 是必需字段。前端以「首次渲染时的剩余时间」作为分母自行起算
   * 进度条，因此这里不必强求每条都带 startedAt；`totalMs` 为 0 即表示"总时长未知"。
   * startedAt/totalMs 仅在写入侧顺手落盘时透出（采集、移动、抢救、麻痹），
   * 作用是刷新页面/重连后进度条仍落在真实位置，缺失不影响进度条正常推进。
   *
   * @param player 玩家行（用于兜底取 markers2 原始串）
   * @param markers 已解析的对象标记
   * @param markers2 已解析的时效标记数组
   * @param buffs 已解析的增益数组（卷土重来免死保护倒计时）
   * @returns 进行中操作列表（按结束时间升序，通常只有 1 条）
   */
  private buildPendingActions(
    player: any,
    markers: any,
    markers2: any,
    buffs?: any,
  ): Array<{ key: string; kind: string; label: string; detail: string; icon: string; startedAt: number; endAt: number; totalMs: number }> {
    const now = Date.now();
    const list: Array<any> = [];

    /** 历史数据里 expireAt 有秒/毫秒两种口径：统一走 expire-time.util 归一（秒/毫秒启发式单一真相源）。 */
    const toEndMs = (raw: any): number => toExpireMs({ expireAt: raw });

    const push = (item: {
      key: string; kind: string; label: string; detail?: string; icon?: string;
      endAt: number; startedAt?: number; totalMs?: number;
    }) => {
      const endAt = Math.floor(item.endAt);
      if (!endAt || endAt <= now) return; // 已到期：结算任务会清理，此处不展示
      const knownStart = Math.floor(item.startedAt ?? 0);
      const knownTotal = Math.floor(item.totalMs ?? 0);
      // 起止时间与总时长知其二即可推第三个；两者都拿不到时 totalMs 置 0，
      // 表示「总时长未知」——前端据此走不确定进度动画，而不是画一条卡在 0% 的空槽。
      const startedAt = knownStart || (knownTotal > 0 ? Math.max(0, endAt - knownTotal) : 0);
      const totalMs = knownTotal > 0
        ? Math.min(knownTotal, endAt - Math.max(0, startedAt) || knownTotal)
        : (knownStart > 0 ? Math.max(0, endAt - knownStart) : 0);
      list.push({
        key: item.key,
        kind: item.kind,
        label: item.label,
        detail: item.detail || '',
        icon: item.icon || '⏳',
        startedAt,
        endAt,
        totalMs,
      });
    };

    // ===== 1) 采集（打开箱子 / 打开休眠仓 / 收集木头 / 捡垃圾 …）=====
    // 写入处 handleGatherResource：markers['采集中'] = { target, cmd, count, startedAt, settleAt }
    const gather = markers?.['采集中'];
    if (gather && typeof gather === 'object') {
      const endAt = Number(gather.settleAt ?? 0) || 0;
      const startedAt = Number(gather.startedAt ?? 0) || 0;
      const cmd = String(gather.cmd ?? '').trim();
      const target = String(gather.target ?? '').trim();
      const count = Number(gather.count ?? 1);
      push({
        key: 'gather',
        kind: 'gather',
        label: cmd || '采集中',
        detail: [target, count > 1 ? `×${count}` : ''].filter(Boolean).join(' '),
        icon: '⛏️',
        endAt,
        startedAt,
        totalMs: startedAt ? endAt - startedAt : undefined,
      });
    }

    // ===== 2) 移动（前往其它地图的路途耗时）=====
    // 写入处 handleMove：markers['移动中'] = JSON 字符串 { targetName, arriveAt, ... }
    const movingRaw = markers?.['移动中'];
    const moving = typeof movingRaw === 'string'
      ? asJsonValue<any>(movingRaw, null)
      : movingRaw;
    if (moving && typeof moving === 'object') {
      const endAt = Number(moving.arriveAt ?? 0) || 0;
      const startedAt = Number(moving.startedAt ?? 0) || 0;
      const mode = String(moving.mode ?? '').trim();
      push({
        key: 'move',
        kind: 'move',
        label: '移动中',
        detail: moving.targetName ? `${mode || '前往'}【${moving.targetName}】` : (mode || ''),
        icon: mode === '飞行' ? '🕊️' : '🚶',
        endAt,
        startedAt,
        totalMs: startedAt ? endAt - startedAt : undefined,
      });
    }

    // ===== 3) markers2 时效标记：抢救/维修/救助/麻痹 =====
    const list2 = Array.isArray(markers2)
      ? markers2
      : asJsonValue<any[]>(player?.markers2, []);
    const rescueText: Record<string, string> = {
      self: '自救', familiar: '抢救使魔', vehicle: '维修载具', player: '救助玩家',
    };
    const rescueIcon: Record<string, string> = {
      self: '💊', familiar: '🩹', vehicle: '🔧', player: '🤝',
    };
    for (const entry of list2) {
      if (!entry || typeof entry !== 'object') continue;
      const name = String(entry?.name ?? entry?.名称 ?? '');
      const endMs = toEndMs(entry?.expireAt ?? entry?.有效期至);
      if (!endMs) continue;
      // 带 rescueType 的「复活/工作」= 救助链路（抢救使魔/维修载具/自救/救助玩家）
      const rescueType = String(entry?.rescueType ?? '');
      if (rescueType) {
        // startedAt/totalMs 由 createRescueMarker 落盘，只用于刷新页面后进度条仍显示真实位置；
        // 老标记没有这两个字段时 totalMs 为 0，前端会以首次观测到的剩余时间自行起算。
        push({
          key: `rescue:${rescueType}`,
          kind: 'rescue',
          label: rescueText[rescueType] || '抢救',
          icon: rescueIcon[rescueType] || '🩹',
          endAt: endMs,
          startedAt: Number(entry?.startedAt ?? 0) || 0,
          totalMs: Number(entry?.totalMs ?? 0) || 0,
        });
        continue;
      }
      // 纯进度型锁定标记：采集/移动的 markers2 镜像（markers 里已有更详细信息时跳过，避免重复条目）
      if (name === '采集' && list.some((a: any) => a.key === 'gather')) continue;
      if (name === '移动' && list.some((a: any) => a.key === 'move')) continue;
      // 这些标记的 startedAt/totalMs 是可选字段，缺失时前端按「总时长未知」处理
      const markStart = Number(entry?.startedAt ?? 0);
      const markTotal = Number(entry?.totalMs ?? 0);
      if (name === '采集') {
        push({ key: 'gather', kind: 'gather', label: '采集中', icon: '⛏️', endAt: endMs, startedAt: markStart, totalMs: markTotal });
      } else if (name === '移动') {
        push({ key: 'move', kind: 'move', label: '移动中', icon: '🚶', endAt: endMs, startedAt: markStart, totalMs: markTotal });
      } else if (name === '工作') {
        push({ key: 'work', kind: 'work', label: '工作中', icon: '🔨', endAt: endMs, startedAt: markStart, totalMs: markTotal });
      } else if (name === '攻击冷却') {
        // 公共攻击冷却（原版 战斗相关.ecode L93-107 / L4601-4605 检查）：期间所有武器都无法出手
        push({ key: 'attack-cd', kind: 'cooldown', label: '攻击冷却', detail: '无法攻击', icon: '⚔️', endAt: endMs, startedAt: markStart, totalMs: markTotal });
      } else if (name.endsWith('冷却')) {
        // 单武器冷却（原版 _主程序.ecode L904 `${武器名}冷却`）：标注是哪把武器在转CD。
        // 这些标记只挂在攻击者自己的 markers2 上（被击方的「被寒风冷却」等在对方身上），天然不会串人。
        push({ key: `cd:${name}`, kind: 'cooldown', label: name.replace(/冷却$/, ''), detail: '武器冷却中', icon: '⚔️', endAt: endMs, startedAt: markStart, totalMs: markTotal });
      } else if (name === '麻痹') {
        push({ key: 'paralysis', kind: 'debuff', label: '麻痹中', detail: '无法行动', icon: '⚡', endAt: endMs, startedAt: markStart, totalMs: markTotal });
      }
    }

    // ===== 4) buffs 增益：卷土重来（倒地免死保护，到期即真死）=====
    // 写入处：怪物反击 / 反伤致死的死亡级联（combat-system），以及原版 获得增益("卷土重来")。
    // 存量格式两套并存：英文 { name, expireAt=秒 } 与归一化中文 { 名称, 有效期至=毫秒 }，
    // 与全文件 toEndMs 口径一致地兼容读取。同名多条时只保留结束时间最晚的一条，避免前端 key 冲突。
    const buffList = Array.isArray(buffs)
      ? buffs
      : asJsonValue<any[]>(player?.buffs, []);
    let comebackEndMs = 0;
    for (const b of buffList) {
      if (!b || typeof b !== 'object') continue;
      if (String(b?.name ?? b?.名称 ?? '') !== '卷土重来') continue;
      const endMs = toEndMs(b?.expireAt ?? b?.有效期至);
      if (endMs > comebackEndMs) comebackEndMs = endMs;
    }
    if (comebackEndMs > 0) {
      push({
        key: 'comeback',
        kind: 'comeback',
        label: '卷土重来',
        detail: '免死保护中，倒地仍可行动',
        icon: '🔄',
        endAt: comebackEndMs,
        // 增益落盘不带 startedAt/时长，totalMs=0 → 前端按首次观测剩余时间起算（与麻痹同策略）
      });
    }

    return list.sort((a: any, b: any) => a.endAt - b.endAt);
  }

  /**
   * 当前任务快照（网页「我的」面板用）：仅保留未完成任务的名字与进度计数，
   * 结构对齐 handleInfo 文本面板的任务段（字符串条目 / name|title 对象均兼容）。
   */
  private buildActiveTasks(rawTasks: any): Array<{ name: string; count?: number }> {
    const list = Array.isArray(rawTasks) ? rawTasks : [];
    const result: Array<{ name: string; count?: number }> = [];
    for (const t of list) {
      if (typeof t === 'string') {
        if (t.trim()) result.push({ name: t });
        continue;
      }
      const name = t?.name || t?.title;
      if (!name) continue;
      // 已完成标记的不再展示（任务完成结算后会从列表移除，此处兜底）
      if (t.completed === true || t.status === '已完成' || t.status === '已提交') continue;
      const count = Number(t.count ?? 0);
      result.push(count > 0 ? { name, count } : { name });
    }
    return result;
  }

  /**
   * 装备栏快照（网页「我的」面板用）：按部位遍历 + 武器/植入/增幅，
   * 与 handleInfo 装备面板（原版 数据显示.ecode 使魔数据 L2032-2210）保持同一取数口径。
   * name 为 null 表示该栏位为空，前端显示「无(+强化等级)」。
   */
  private buildEquipmentSnapshot(player: any, markers: any): Array<{
    slot: string; name: string | null; quality: string; effect: number; enhance: number; enhanceRate: number; attrs: string; no: number | null;
    weapons?: Array<{ slot: string; name: string; quality: string; effect: number; enhance: number; enhanceRate: number; attrs: string; no: number | null }>;
  }> {
    // 品质展示标签：大写品质码（S/A/B…），与背包显示名同口径，单一实现见 equipment-ref.util。
    // 2026-09-10 用户约定：装备栏评级不再显示中文品质名（传说/史诗…），
    // 玩家可直接和背包里的「冰雹S」对照，不必再脑内换算 S 是不是传说。
    const equipmentList = asJsonValue<any[]>(player.equipment, []);
    const weaponList = asJsonValue<any[]>(player.weapons, []);
    const currentWeaponIdx = Number(player.currentWeapon ?? 0);
    // 已装备序号（卸下编号口径单一实现）：每格带 no，前端武器列表「卸下」按钮直接发「卸下 no」，
    // 与「信息」文本面板 / unequipItem 纯数字分支三处同源，禁各自重算。
    const equipped = this.itemService.buildEquippedList(player);
    const noOf = (kind: 'equip' | 'weapon', slot: string, arrIndex: number): number | null =>
      equipped.find((e) => e.kind === kind && e.slot === slot && (kind === 'weapon' ? e.weaponIndex === arrIndex : e.equipIndex === arrIndex))?.no ?? null;

    const entryOf = (slot: string, item: any, enhanceKey: string, no: number | null = null) => {
      const enhanceLv = this.combatState.getAchievementProficiency(markers, enhanceKey);
      if (!item) return { slot, name: null, quality: '', effect: 0, enhance: enhanceLv, enhanceRate: 0, attrs: '', no: null };
      const rawData = String(item.data || item.数据 || '');
      let effectNum = Number(item.effect || item.特效 || 0);
      if (!effectNum && rawData) {
        const bxMatch = rawData.match(/!bx(\d+)/);
        if (bxMatch) effectNum = parseInt(bxMatch[1], 10) || 0;
      }
      // 逐件属性（**强化后**口径 + 行尾 `(+x.xx)` 增量标注）：单一实现
      // itemSystemService.formatReinforcedEquipAttrs（与战斗链 calcEquipReinforce 同源）。
      // 2026-09-10 修复：此前只读 parseEquipment 原始值，从不强化 → 玩家「强化武器」后
      // 武器详情属性行完全不变，误判强化未生效（实测 +0 / +2 两组属性一模一样）。
      let attrs = '';
      let enhanceRate = 0;
      if (rawData) {
        const shown = this.itemSystemService.formatReinforcedEquipAttrs(item, markers);
        attrs = shown.text;
        enhanceRate = shown.coefficient;
      }
      return {
        slot,
        name: String(item.name || item.名称 || '未知'),
        quality: equipmentQualityLabel(rawData),
        effect: effectNum,
        enhance: enhanceLv,
        // 强化系数百分比（系数 a1 × 100，两位小数）：面板「强化 +2（系数 +1%）」用，
        // 等级取整后增益不可见时，玩家仍能读出实际收益
        enhanceRate: Math.round(enhanceRate * 10000) / 100,
        attrs,
        no,
      };
    };

    const getEquipType = (item: any): string => {
      const def = this.staticData.getEquipmentByName(item.name);
      return String(def?.equipType ?? def?.type ?? def?.类型 ?? item.type ?? item.类型 ?? '');
    };
    const slotNames = ['头部', '饰品', '肩膀', '上身', '背部', '手臂', '手掌', '腰部', '下身', '腿环', '腿部', '脚部'];
    const result = slotNames.map((slotName) => {
      const eqIdx = equipmentList.findIndex((e: any) => getEquipType(e) === slotName);
      return entryOf(
        slotName,
        eqIdx >= 0 ? equipmentList[eqIdx] : null,
        slotName + '强化',
        eqIdx >= 0 ? noOf('equip', slotName, eqIdx) : null,
      );
    });
    // 武器格（15 格之一：手持那把，空手回拳头占位；位置保持原顺序在植入之前）
    const heldIdx = currentWeaponIdx - 1;
    const weaponCell = entryOf('武器', heldIdx >= 0 && weaponList[heldIdx] ? weaponList[heldIdx] : null, '武器强化',
      heldIdx >= 0 && weaponList[heldIdx] ? noOf('weapon', '武器', heldIdx) : null);
    result.push(weaponCell);
    // 植入体 / 增幅器
    // 强化等级存放于 markers['植入体等级'] / markers['增幅器等级']（写入侧：item-system.service.ts upgradeImplant/upgradeAmplifier）
    const implantIdx = equipmentList.findIndex((e: any) => {
      const def = this.staticData.getEquipmentByName(e.name);
      return def?.equipType === '植入体' || def?.type === '植入体';
    });
    result.push(entryOf('植入', implantIdx >= 0 ? equipmentList[implantIdx] : null, '植入体等级',
      implantIdx >= 0 ? noOf('equip', '植入', implantIdx) : null));
    const ampIdx = equipmentList.findIndex((e: any) => {
      const def = this.staticData.getEquipmentByName(e.name);
      return def?.equipType === '增幅器' || def?.type === '增幅器';
    });
    result.push(entryOf('增幅', ampIdx >= 0 ? equipmentList[ampIdx] : null, '增幅器等级',
      ampIdx >= 0 ? noOf('equip', '增幅', ampIdx) : null));
    // 全部武器详情（手持 + 背上备用），挂「武器」格 weapons 子字段：
    // 2026-09-09 用户约定：左栏装备栏**固定 15 格不变**（背上武器不展开为独立格），
    // 前端单击「武器」格时展开该列表逐件展示详情 + 卸下按钮（按序号发「卸下 no」，
    // no 与「信息」文本面板 / unequipItem 编号分支三处同源）。列表顺序：手持在前，其余按 weapons[] 序。
    const weaponDetails: Array<{ slot: string; name: string; quality: string; effect: number; enhance: number; enhanceRate: number; attrs: string; no: number | null }> = [];
    const weaponDetailOf = (slot: string, item: any, no: number | null) => {
      const cell = entryOf(slot, item, '武器强化', no);
      weaponDetails.push({ slot, name: cell.name ?? '', quality: cell.quality, effect: cell.effect, enhance: cell.enhance, enhanceRate: cell.enhanceRate, attrs: cell.attrs, no });
    };
    // 背上武器按 weapons[] 序；手持插到最前（列表顺序约定：手持在前）
    for (let i = 0; i < weaponList.length; i++) {
      if (!weaponList[i] || i + 1 === currentWeaponIdx) continue;
      weaponDetailOf('背上', weaponList[i], noOf('weapon', '背上', i));
    }
    if (heldIdx >= 0 && weaponList[heldIdx]) {
      const no = noOf('weapon', '武器', heldIdx);
      const cell = entryOf('武器', weaponList[heldIdx], '武器强化', no);
      weaponDetails.unshift({ slot: '武器', name: cell.name ?? '', quality: cell.quality, effect: cell.effect, enhance: cell.enhance, enhanceRate: cell.enhanceRate, attrs: cell.attrs, no });
    }
    (weaponCell as any).weapons = weaponDetails;
    return result;
  }

  /**
   * 文本面板增益行：把增益数组格式化为「名称(剩余m:ss)」列表。
   *
   * 统一走过期时间归一化（秒/毫秒两种历史口径都识别），并**剔除已过期条目**：
   * 原逻辑只把剩余秒数钳到 0，导致过期的增益一直以「(0:00)」常驻在「信息」
   * 面板里不会消失。
   * @param rawBuffs 增益数组或 JSON 字符串
   * @returns 展示文本数组（无有效增益时为空数组，调用方据此省略整行）
   */
  private formatBuffList(rawBuffs: any): string[] {
    const now = Date.now();
    return filterActive(rawBuffs, now).map((buff: any) => {
      const name = buff?.name || buff?.名称 || '未知';
      // 无到期时间 = 永久增益，不带倒计时，避免显示成误导性的 (0:00)
      return toExpireMs(buff) ? `${name}(${formatRemain(remainSeconds(buff, now))})` : name;
    });
  }

  /**
   * 增益快照（网页「我的」面板用）：过滤已过期条目，保留名字与有效期时间戳，
   * 剩余倒计时由前端按本地时钟实时计算。
   */
  private buildActiveBuffs(rawBuffs: any): Array<{ name: string; expireAt: number }> {
    // 先按统一时间口径剔除过期条目，再统一输出毫秒时间戳给前端倒计时
    // （历史数据里 expireAt 有秒/毫秒两种口径，必须归一化后再交给前端）
    const now = Date.now();
    return filterActive(rawBuffs, now).map((b: any) => ({
      name: String(b?.name || b?.名称 || '未知'),
      expireAt: toExpireMs(b),
    }));
  }

  /**
   * 定向推送玩家状态更新到该用户的前端 socket（触发网页玩家面板实时刷新）
   * 在指令执行成功（攻击/采集/装备/技能/移动等）后调用，
   * 使打怪掉血、加经验、升级等变化实时体现在界面上，无需手动 F5。
   * 带 300ms 尾沿防抖：自动战斗(每5秒)/连击/延时攻击等高频结算场景下
   * 同一玩家的多次变化合并为一次推送，避免 socket 风暴拖垮前后端。
   * @param userId 用户ID
   */
  async pushPlayerUpdate(userId: number): Promise<void> {
    const existing = this.playerUpdateTimers.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.playerUpdateTimers.delete(userId);
      void this.doPushPlayerUpdate(userId);
    }, 300);
    timer.unref?.();
    this.playerUpdateTimers.set(userId, timer);
  }

  private async doPushPlayerUpdate(userId: number): Promise<void> {
    try {
      const data = await this.buildPlayerInfo(userId);
      if (data) {
        data.rev = this.nextRev(`player:${userId}`);
        this.chatService.emitToUser(userId, 'player:update', data);
      }
    } catch (e: any) {
      this.logger.warn(`推送玩家 ${userId} 状态更新失败: ${e.message}`);
    }
  }

  /**
   * 定向推送地图总览到该用户的前端 socket（触发网页地图面板 + 附近玩家实时刷新）
   * 在指令执行（攻击/采集/移动等，会让怪物HP、资源数量、所在地图/附近玩家变化）后调用。
   * 前端收到 map:update 后会自动重载附近玩家列表，因此一并覆盖"附近玩家"。
   * 与 pushPlayerUpdate 相同的 300ms 防抖策略。
   * @param userId 用户ID
   */
  async pushMapUpdate(userId: number): Promise<void> {
    const existing = this.mapUpdateTimers.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.mapUpdateTimers.delete(userId);
      void this.doPushMapUpdate(userId);
    }, 300);
    timer.unref?.();
    this.mapUpdateTimers.set(userId, timer);
  }

  private async doPushMapUpdate(userId: number): Promise<void> {
    try {
      const overview = await this.getMapOverview(userId);
      if (overview) {
        this.chatService.emitToUser(userId, 'map:update', {
          overview,
          rev: this.nextRev(`map:${userId}`),
        });
      }
    } catch (e: any) {
      this.logger.warn(`推送玩家 ${userId} 地图面板更新失败: ${e.message}`);
    }
  }

  /**
   * 推送版本号：每个 (实体,用户) 维度的单调递增计数器。
   * 前端据此丢弃网络乱序导致的旧包（rev 小于已应用值则忽略）。
   * 进程重启归零无碍——前端对 rev 回退/归零宽容处理（视为新会话）。
   */
  private nextRev(key: string): number {
    const next = (this.revCounters.get(key) || 0) + 1;
    this.revCounters.set(key, next);
    return next;
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
    // 资源面板与指令「探测/观察附近」保持一致：过滤已采完(times=0)与当前玩家已领取过的固定资源，
    // 避免出现"面板里有、实际打不开/已领过"的不一致观感（原版医疗箱/休眠仓为每人一次的常驻资源）。
    const playerMarkers = await this.getPlayerMarkers(userId);
    const resources = this.playerService
      .safeJsonParse<any[]>(currentMap.resources, [])
      .filter((r: any) => this.getResourceTimes(r) !== 0 && this.isGatherResourceAvailable(r, playerMarkers));
    const npcs = asJsonValue<any[]>(currentMap.npcs, []);
    // 召唤物与 NPC 同属「可对话单位」，与观察附近口径一致（见下方 npcList 合并逻辑）
    const summons = asJsonValue<any[]>(currentMap.summons, []);

    // 怪物列表：从 spawnMonsters + tempMonsters 合并，去重后携带等级/HP
    // 用 staticData 的怪物 JSON 补全等级/HP，未收录的怪物按基础值兜底
    const mapMonsters = await this.mapService.getMapMonsters(currentMap);
    const seenMonsters = new Set<string>();
    const monsterList = mapMonsters
      .filter((m) => {
        const key = m.name || '';
        if (!key || seenMonsters.has(key)) return false;
        seenMonsters.add(key);
        return true;
      })
      .map((m) => {
        const def = this.staticData.getMonsterByName(m.name) || {};
        // 面板属性必须与指令「查看」一致：优先使用 GameMonster 实例实时属性（含等级成长），
        // 静态模板(level/hp)仅作为兜底，避免出现"面板显示基础生命、查看显示成长后生命"的不一致。
        return {
          name: m.name,
          level: m.level ?? def.level ?? currentMap.level ?? 1,
          hp: m.hp ?? m.maxHp ?? def.hp ?? def.maxHp ?? 0,
        };
      });

    // 资源列表：采集型资源携带产出物/数量/gatherCmd
    const resourceList = resources.map((r: any) => ({
      name: r.name,
      type: r.type || '',
      // 剩余可采集次数（原版 times/次数，-1 表示无限），前端据此显示 ×N
      count: this.getResourceTimes(r),
      times: r.times ?? -1,
      gatherCmd: r.gatherCmd || '采集',
      // 取首个产出物的名称作为可见掉落，便于玩家判断价值
      firstDrop: Array.isArray(r.outputs) && r.outputs.length ? r.outputs[0]?.name : '',
    }));

    // NPC 列表：静态 NPC + 地图召唤物（对齐指令「观察附近」的 宠物/NPC 口径，
    // game.service L8176-8248：白仅主人可见；神之工匠/小雫/露娜/行商/小白狐/花园宝宝
    // 等特殊 NPC 同名去重标[!]；幼崽/倒地召唤物带后缀标注）。网页面板与指令侧
    // 显示口径保持一致，避免"观察附近有小白狐、面板 NPC(0)"的不一致观感。
    const summonEntries: Array<{ name: string; title: string; type: string }> = [];
    if (summons.length > 0) {
      const ownerRow = await this.prisma.player
        .findUnique({
          where: { userId },
          select: {
            id: true,
            masterQQ: true,
            user: { select: { qqNumber: true, externalId: true } },
          },
        })
        .catch(() => null);
      const ownerIds = new Set(
        [
          String(userId),
          String(ownerRow?.id ?? ''),
          String(ownerRow?.masterQQ ?? ''),
          String(ownerRow?.user?.qqNumber ?? ''),
          String(ownerRow?.user?.externalId ?? ''),
        ].filter(Boolean),
      );
      const nameOf = (s: any): string => String(s?.name ?? s?.名称 ?? '') || '未知';
      const qqOf = (s: any): string => String(s?.qq ?? s?.QQ ?? '');
      const isMonsterSummon = (s: any): boolean => qqOf(s).startsWith('怪物');
      const markerVal = (unit: any, markerName: string): number => {
        const raw = unit?.markers ?? unit?.标记 ?? {};
        const parsed = typeof raw === 'string' ? asJsonValue<any>(raw, {}) : raw;
        if (Array.isArray(parsed)) {
          const item = parsed.find((x: any) => (x?.name ?? x?.名称) === markerName);
          return Number(item?.value ?? item?.数值 ?? item?.count ?? 0);
        }
        return Number(parsed?.[markerName] ?? 0);
      };
      const isFixedSpecialNpc = (s: any): boolean =>
        ['npc1g', 'npc2g', '怪物露娜1g'].includes(qqOf(s)) || ['行商'].includes(nameOf(s));
      const isDedupableSpecialNpc = (s: any): boolean =>
        ['小白狐', '花园宝宝'].includes(nameOf(s));

      const shownSpecialNames = new Set<string>();
      for (const s of summons) {
        const name = nameOf(s);
        // 白只对主人显示（原版 L781-784）
        if (name === '白' && !ownerIds.has(String(s?.ownerQQ ?? s?.归属 ?? s?.owner ?? ''))) {
          continue;
        }
        const isSpecialNpc = isFixedSpecialNpc(s) || isDedupableSpecialNpc(s);
        if (isSpecialNpc && shownSpecialNames.has(name)) continue;
        let title = '召唤物';
        if (isSpecialNpc) {
          shownSpecialNames.add(name);
          title = '[!]';
        } else if (markerVal(s, '幼崽') !== 0) {
          title = '(幼崽)';
        } else if (isMonsterSummon(s)) {
          title = Number(s?.currentHp ?? s?.当前生命 ?? s?.hp ?? 0) > 0 ? '召唤物' : '(倒地)';
        }
        summonEntries.push({ name, title, type: 'summon' });
      }
    }

    const npcList = [
      ...npcs.map((n: any) => ({
        name: n.name,
        title: n.title || '',
        type: n.type || 'npc',
      })),
      ...summonEntries,
    ];

    return {
      currentMap: {
        name: currentMap.name,
        mapId: currentMap.id,
        // 静态数据中的地图描述含 "#换行" 标记，输出前统一转为真实换行
        description: normalizeGameText(currentMap.description || ''),
        // 怪物实例统一来自 GameMonster；currentMap.monsters 仅是静态模板，不代表当前存活数量。
        monsters: mapMonsters.length,
        resources: resources.length,
        // NPC 计数与 npcList 同口径：静态 NPC + 召唤物（观察附近口径）
        npcs: npcList.length,
        monsterList,
        resourceList,
        npcList,
      },
      subMaps,
      allMaps,
    };
  }

  /**
   * 获取当前玩家所在区域（同一地图）的附近玩家列表
   * 用于网页右侧面板展示"附近玩家"，支持与其他玩家交互（私聊/@提及等）
   * 规则：同一地图内的玩家视为"附近"，标记在线状态，自己除外；在线优先、按等级降序排列
   * @param userId 当前玩家用户ID
   * @returns 附近玩家列表 [{ userId, username, nickname, avatar, level, name, hp, maxHp, online }]
   */
  async getNearbyPlayers(userId: number): Promise<any[]> {
    // 当前玩家所在地图
    const { mapId } = await this.playerService.getPlayerLocation(userId);
    // 同一地图内的所有玩家档案（关联用户信息用于展示昵称/头像）
    const players = await this.prisma.player.findMany({
      where: { mapId },
      include: {
        user: {
          select: { id: true, username: true, nickname: true, avatar: true },
        },
      },
    });

    // 在线用户集合（一次性读取，避免逐个判断）
    const onlineIds = this.statsService.getOnlineUserIds();

    return players
      .filter((p) => p.userId !== userId) // 排除自己
      .map((p) => ({
        userId: p.userId,
        username: p.user.username,
        nickname: p.user.nickname || p.user.username,
        avatar: p.user.avatar || '',
        level: p.level,
        name: p.name,
        hp: p.hp,
        maxHp: p.maxHp,
        online: onlineIds.has(p.userId),
      }))
      .sort(
        (a, b) =>
          // 在线玩家优先，其次按等级降序
          Number(b.online) - Number(a.online) || b.level - a.level,
      );
  }

  /**
   * 获取两个地图之间的距离
   */
  private getDistance(map1: any, map2: any): number {
    const connections1 = this.mapService.getConnections(map1);
    const conn = connections1.find((c: any) => c.name === map2.name);
    return conn ? (conn.distance || 50) : 50;
  }

  /** 计算原版“移动”成就使用的最短路径节点数（含起点和终点）。 */
  private async getMovementPathLength(startMap: any, targetMap: any): Promise<number> {
    const startName = String(startMap?.name || '');
    const targetName = String(targetMap?.name || '');
    if (!startName || !targetName || startName === targetName) return 1;

    try {
      const getAllMaps = (this.mapService as any)?.getAllMaps;
      const getConnections = (this.mapService as any)?.getConnections;
      if (typeof getAllMaps !== 'function' || typeof getConnections !== 'function') return 1;

      const maps = await getAllMaps.call(this.mapService);
      const mapByName = new Map((maps || []).map((map: any) => [String(map?.name || ''), map]));
      mapByName.set(startName, startMap);
      mapByName.set(targetName, targetMap);

      const queue: Array<{ name: string; length: number }> = [{ name: startName, length: 1 }];
      const visited = new Set<string>([startName]);
      while (queue.length > 0) {
        const current = queue.shift() as { name: string; length: number };
        const currentMap = mapByName.get(current.name);
        for (const connection of getConnections.call(this.mapService, currentMap) || []) {
          const nextName = String(connection?.name || '');
          if (!nextName || visited.has(nextName)) continue;
          const nextLength = current.length + 1;
          if (nextName === targetName) return nextLength;
          if (mapByName.has(nextName)) {
            visited.add(nextName);
            queue.push({ name: nextName, length: nextLength });
          }
        }
      }
    } catch (error: any) {
      this.logger.warn(`计算移动路径长度失败: ${error?.message || error}`);
    }
    return 1;
  }

  /**
   * 处理查看信息命令
   */
  async handleInfo(userId: number): Promise<string> {
    await this.taskService.ensureTutorialTasks(userId);
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, tasks } = playerData;

    const map = await this.mapService.getMapById(player.mapId);

    // 计算战斗力（基于"计算后"的成长属性，而非 DB 静态字段）
    // 对应原版 加成计算.ecode _计算玩家：攻击/生命/护盾/装甲按等级+熟练度成长
    const calcBonus = this.combatSystem.buildAttackerBonus(player, playerData);
    const bonus: BonusData = {
      攻击: calcBonus.攻击 || 0,
      生命: calcBonus.生命 || 0,
      装甲: calcBonus.装甲 || 0,
      速度: calcBonus.速度 || 0,
    };
    const combatPower = this.bonusService.calcCombatPower(bonus);

    // 检查是否为新手玩家（等级1且无操作记录）
    const isNewPlayer = player.level === 1 && !markers['指引_attack'] && !markers['指引_info'];

    const lines: string[] = [];

    if (isNewPlayer) {
      // 新玩家欢迎信息 - 清晰的起步引导 + 编号快捷菜单
      lines.push('🎉 欢迎来到使魔大战！');
      lines.push('━━━━━━━━━━━━━━━');
      lines.push('📖 你从医疗室醒来，这里有一些基础物资。');
      lines.push('下面带你了解这个世界：');
      lines.push('');
      lines.push('【现在做什么？】');
      lines.push('  1. 发送「观察附近」看看周围有什么');
      lines.push('  2. 发送「背包」看看你的基础物资');
      lines.push('  3. 发送「攻击」试试打怪');
      lines.push('  4. 发送「使魔大战」打开完整主菜单');
      lines.push('  5. 发送「帮助」查看常用指令和玩法');
      lines.push('');
      lines.push('💡 发送下方编号数字可快速操作：');
      lines.push('  1. 观察附近    2. 查看背包');
      lines.push('  3. 攻击        4. 打开主菜单');
      lines.push('  5. 查看帮助');
      lines.push('');
      lines.push('━━━━━━━━━━━━━━━');
      // 为新玩家生成编号快捷操作（临时输入替换，发数字即可触发）
      await this.shortcutService.setTempInput(userId, '1@观察附近#2@背包#3@攻击#4@使魔大战#5@帮助');
    }

    // 显示计算后的属性：攻击/生命/护盾/装甲/速度均来自 _计算玩家 成长公式（含等级成长）
    // 原版显示的就是 玩家.属性（计算后），而非基础存储值
    const showAttack = Math.round(calcBonus.攻击 || 0);
    const showMaxHp = Math.round(calcBonus.生命 || player.maxHp || 100);
    const showMaxShield = Math.round(calcBonus.护盾 || player.maxShield || 0);
    const showMaxArmor = Math.round(calcBonus.装甲 || player.maxArmor || 0);
    const showSpeed = Math.round(calcBonus.速度 || player.speed || 0);

    lines.push(`【${player.name || '冒险者'}】Lv.${player.level}`);
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`❤️ HP: ${Math.round(player.hp || 0)}/${showMaxHp}`);
    lines.push(`🛡️ 护盾: ${Math.round(player.shield || 0)}/${showMaxShield}`);
    lines.push(`⛓️ 装甲: ${Math.round(player.armor || 0)}/${showMaxArmor}`);
    lines.push(`⚔️ 攻击: ${showAttack}`);
    lines.push(`💨 速度: ${showSpeed}`);
    lines.push(`⭐ 经验: ${Math.round(player.exp || 0)}/${Math.round(this.playerService.calcUpgradeExp(player.level))}`);
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

    // ========== 装备栏面板（对齐原版 数据显示.ecode 使魔数据 L2032-2210） ==========
    // 原版按部位遍历：头部/饰品/肩膀/上身/背部/手臂/手掌/腰部/下身/腿环/腿部/脚部/武器/植入体/增幅器/背上备用武器
    const equipmentList = asJsonValue<any[]>(player.equipment, []);
    const weaponList = asJsonValue<any[]>(player.weapons, []);
    const currentWeaponIdx = Number(player.currentWeapon ?? 0);
    const slotNames = ['头部', '饰品', '肩膀', '上身', '背部', '手臂', '手掌', '腰部', '下身', '腿环', '腿部', '脚部'];
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`📋 装备:`);

    // 已装备列表（卸下编号口径单一实现 itemService.buildEquippedList）：已装备行渲染「N.」前缀，
    // 与「卸下 N」指令序号对号；空槽位不入列不占号（玩家看到的每个序号都对应一件可操作装备）。
    // 网页快照 buildEquipmentSnapshot 同源锚定本列表（每格带 no），三处口径禁各自重算。
    const equipped = this.itemService.buildEquippedList(player);
    const noOf = (kind: 'equip' | 'weapon', slot: string, arrIndex: number): number =>
      equipped.find((e) => e.kind === kind && e.slot === slot && (kind === 'weapon' ? e.weaponIndex === arrIndex : e.equipIndex === arrIndex))?.no ?? 0;

    // 品质标签 = 大写品质码（S/A/B…，equipment-ref.util 单一实现），与网页快照同口径。
    // 2026-09-10 用户约定：装备栏评级显示品质码字母，直接对应背包显示名「冰雹S」。
    // 此处曾内联一份中文品质 map（与 buildEquipmentSnapshot 各抄一份 = 双重表示），已收敛。
    // 有码才加「S 」前缀；裸条目装备（无 data）不加前缀，避免拼出「  防弹头盔」双空格。
    const withQuality = (label: string, name: string): string => (label ? `${label} ${name}` : name);

    // 装备槽位取数：与 buildEquipmentSnapshot / 网页左面板同口径。
    // 运行时 item.type 固定为「装备」大分类（见 item.service.equipItem），必须查静态表 equipType，
    // 对齐原版 物品操作.ecode L1824 寻找装备（z=装备列表[b] 后取 z.类型）。
    const getEquipType = (item: any): string => {
      const def = this.staticData.getEquipmentByName(item.name);
      return String(def?.equipType ?? def?.type ?? def?.类型 ?? item.type ?? item.类型 ?? '');
    };

    for (const slotName of slotNames) {
      const eqIdx = equipmentList.findIndex((e: any) => getEquipType(e) === slotName);
      if (eqIdx >= 0) {
        const eq = equipmentList[eqIdx];
        const qName = equipmentQualityLabel(eq.data || eq.数据 || '');
        const fx = eq.effect || eq.特效 || 0;
        const fxStr = fx > 0 ? `[特效${fx}]` : '';
        const enhanceLv = this.combatState.getAchievementProficiency(markers, slotName + '强化');
        const no = noOf('equip', slotName, eqIdx);
        lines.push(`  ${no}.${slotName}: ${withQuality(qName, `${eq.name || eq.名称 || '未知'}${fxStr}`)}(+${enhanceLv})`);
      } else {
        const enhanceLv = this.combatState.getAchievementProficiency(markers, slotName + '强化');
        lines.push(`  ${slotName}: 无(+${enhanceLv})`);
      }
    }

    // 武器栏（L2160-2168）
    if (currentWeaponIdx > 0 && weaponList[currentWeaponIdx - 1]) {
      const w = weaponList[currentWeaponIdx - 1];
      const qName = equipmentQualityLabel(w.data || w.数据 || '');
      const fx = w.effect || w.特效 || 0;
      const fxStr = fx > 0 ? `[特效${fx}]` : '';
      const enhanceLv = this.combatState.getAchievementProficiency(markers, '武器强化');
      const no = noOf('weapon', '武器', currentWeaponIdx - 1);
      lines.push(`  ${no}.武器: ${withQuality(qName, `${w.name || w.名称 || '拳头'}${fxStr}`)}(+${enhanceLv})`);
    } else {
      // 空手占位：拳头不是一件有品质的装备，不带品质码前缀（前端以「拳头」判定为未装备）
      const enhanceLv = this.combatState.getAchievementProficiency(markers, '武器强化');
      lines.push(`  武器: 拳头(+${enhanceLv})`);
    }

    // 植入体（L2170-2179）
    // 强化等级：markers['植入体等级']（写入侧 item-system.service.ts upgradeImplant）。
    // 原版此处不显示等级，为与网页左面板 buildEquipmentSnapshot 同口径，统一补上 (+N)。
    const implantIdx = equipmentList.findIndex((e: any) => getEquipType(e) === '植入体');
    const implantLv = this.combatState.getAchievementProficiency(markers, '植入体等级');
    if (implantIdx >= 0) {
      const im = equipmentList[implantIdx];
      const qName = equipmentQualityLabel(im.data || im.数据 || '');
      const no = noOf('equip', '植入', implantIdx);
      lines.push(`  ${no}.植入: ${withQuality(qName, im.name || im.名称 || '未知')}(+${implantLv})`);
    } else {
      lines.push(`  植入: 无(+${implantLv})`);
    }

    // 增幅器（L2180-2189）
    // 强化等级：markers['增幅器等级']（写入侧 item-system.service.ts upgradeAmplifier），同上统一口径。
    const ampIdx = equipmentList.findIndex((e: any) => getEquipType(e) === '增幅器');
    const ampLv = this.combatState.getAchievementProficiency(markers, '增幅器等级');
    if (ampIdx >= 0) {
      const am = equipmentList[ampIdx];
      const qName = equipmentQualityLabel(am.data || am.数据 || '');
      const no = noOf('equip', '增幅', ampIdx);
      lines.push(`  ${no}.增幅: ${withQuality(qName, am.name || am.名称 || '未知')}(+${ampLv})`);
    } else {
      lines.push(`  增幅: 无(+${ampLv})`);
    }

    // 背上备用武器（L2190-2209）；每件带序号，与「卸下 N」对号（同名武器也能精确卸到指定那把）
    let backupIdx = 0;
    for (let i = 0; i < weaponList.length; i++) {
      if (i + 1 !== currentWeaponIdx) {
        const w = weaponList[i];
        const qName = equipmentQualityLabel(w.data || w.数据 || '');
        const fx = w.effect || w.特效 || 0;
        const fxStr = fx > 0 ? `[特效${fx}]` : '';
        const no = noOf('weapon', '背上', i);
        const label = withQuality(qName, `${w.name || w.名称 || '未知'}${fxStr}`);
        if (backupIdx === 0) {
          lines.push(`  ${no}.背上: ${label}`);
        } else {
          lines.push(`  ${no}.      ${label}`);
        }
        backupIdx++;
      }
    }

    // 卸下编号用法提示（有已装备项时才显示）
    if (equipped.length > 0) {
      lines.push(`💡 「卸下 序号」可精确卸下对应装备（如 卸下 ${equipped[0].no}）`);
    }

    // 当前增益效果（对齐原版 显示使魔数据 L956-963）
    const buffStrs = this.formatBuffList(playerData.buffs ?? player.buffs);
    if (buffStrs.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`✨ 增益: ${buffStrs.join('、')}`);
    }

    return lines.join('\n');
  }

  /**
   * 「背包」列表展示顺序（用户约定 2026-09-09）：资源/材料/消耗品在前、装备在后，
   * 组内保持背包原始顺序（稳定分区）。数字类指令（装备 N / 背包 N）的编号必须
   * 与本列表序号同源——单一实现，禁止散弹复制。
   */
  getBackpackDisplayItems(items: any[]): any[]{
    return this.supportSvc.getBackpackDisplayItems(items);
  }
  async handleInventory(userId: number, arg?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const items = this.playerService.getBackpackItems(player);
    const displayItems = this.getBackpackDisplayItems(items);

    if (displayItems.length === 0) {
      return '🎒 你的背包空空如也';
    }

    // 查看单项详情（对应原版 物品操作.ecode L815~L818：背包 序号/名称 查看物品详情）
    if (arg) {
      // 序号=展示列表编号（与「背包」输出同源）；名称仍查全背包
      const idxNum = parseInt(arg, 10);
      let item;
      if (!isNaN(idxNum) && idxNum >= 1 && idxNum <= displayItems.length) {
        item = displayItems[idxNum - 1];
      } else {
        item = items.find((i: any) => (i.name || i.名称) === arg);
      }
      if (!item) {
        return `背包中没有找到【${arg}】\n使用「背包」查看物品列表`;
      }
      if ((item.type || item.类型) === '装备') {
        // 传 markers：详情自带属性块按「装备强化及自带」强化后口径输出（单一实现）
        return this.itemSystemService.analyzeEquipmentItem(item, '背包', playerData.markers);
      }
      const itemName = item.name || item.名称 || '未知物品';
      const count = Math.round(this.itemQuantity(item) * 100) / 100;
      const type = item.type || item.类型 ? `\n类型: ${item.type || item.类型}` : '';
      const desc = item.description || item.说明 ? `\n${item.description || item.说明}` : '';
      return `🎒【${itemName}】×${count}${type}${desc}`;
    }

    // 文本契约（RVW04 P2-8）：以下行格式被 web/src/components/RichSystemCard.vue
    // parseLayout 背包分支的正则解析——普通物品行「N. 名称 ×数量」匹配
    // /^(\d+)\.\s*(.+?)\s*×\s*([\d.]+)\s*$/，装备行「N. 名称」匹配 /^(\d+)\.\s*(.+)$/；
    // 标题行「🎒 背包(N种)」匹配 /^🎒\s*(?:资源)?背包\s*\(\d+(?:种)?\)/。
    // 排序与行格式另由 server/test/inventory-display.spec.ts 契约测试
    // （'背包展示排序（资源在前、装备在后）'）锁定。改动此处输出必须同步前端正则与契约测试。
    const lines = displayItems.map((item: any, index: number) => {
      if ((item.type || item.类型) === '装备') {
        return `${index + 1}. ${this.itemService.formatEquipmentInventoryDisplay(item)}`;
      }
      const itemName = item.name || item.名称 || '未知物品';
      const count = Math.round(this.itemQuantity(item) * 100) / 100;
      return `${index + 1}. ${itemName} ×${count}`;
    });

    return `🎒 背包 (${displayItems.length}种):\n${lines.join('\n')}`;
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
    const monsters = await this.mapService.getMapMonsters(currentMap);

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
  /**
   * 处理详细属性面板命令
   * 对应原版 数据显示.ecode 显示使魔数据(L723-995)：详细模式(参数详细=真)
   * 显示计算后的完整属性面板，含四系抗性、穿透、回复、增益等
   */
  async handleStatus(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, buffs, weapons, equipment, sets } = playerData;

    // 计算后属性（对齐原版 _计算玩家：攻击/生命/护盾/装甲/命中/闪避/暴击等按等级+熟练度成长）
    const calcBonus = this.combatSystem.buildAttackerBonus(player, playerData);
    const b = calcBonus;
    const num = (v: any) => Math.round(Number(v) || 0);
    const fmt = (v: any) => {
      const n = Number(v) || 0;
      return Number.isInteger(n) ? String(n) : n.toFixed(1);
    };

    const lines: string[] = [];
    lines.push(`【${player.name || '冒险者'}】详细属性`);
    lines.push('━━━━━━━━━━━━━━━');
    // 基础信息（L768-779）
    lines.push(`等级: ${player.level}`);
    const expStr = `经验: ${num(player.exp)}/${num(this.playerService.calcUpgradeExp(player.level))}`;
    lines.push(expStr);
    // 觉醒信息（L773-777）
    const awakenVal = this.combatState.getAchievementProficiency(markers, '觉醒');
    const killVal = this.combatState.getAchievementProficiency(markers, '击杀');
    if (awakenVal > 0) {
      lines.push(`击杀: ${killVal} (觉醒可获得击杀属性加成)`);
    }
    lines.push('━━━━━━━━━━━━━━━');
    // 三池（L780-786）
    if (num(b.护盾) !== 0) lines.push(`护盾: ${num(player.shield)}/${num(b.护盾)}`);
    if (num(b.装甲) !== 0) lines.push(`装甲: ${num(player.armor)}/${num(b.装甲)}`);
    lines.push(`生命: ${num(player.hp)}/${num(b.生命)}`);
    // 四系攻击（L787-788）
    lines.push(`物攻: ${fmt(b.物伤)}  电攻: ${fmt(b.电伤)}`);
    lines.push(`火攻: ${fmt(b.火伤)}  冰攻: ${fmt(b.冰伤)}`);
    // 命中/闪避/速度/暴击（L789-790）
    lines.push(`命中: ${fmt(b.命中)}  闪避: ${fmt(b.闪避)}`);
    lines.push(`速度: ${fmt(b.速度)}  暴击: ${num(b.暴击)}%`);
    // 好感/采集（L791-806）
    const affinityVal = this.combatState.getAchievementProficiency(markers, '好感' + player.qq || '');
    if (player.type) {
      const famAff = this.combatState.getAchievementProficiency(markers, (player.type || '') + '好感');
      lines.push(`好感: ${fmt(famAff)}  采集: ${num(b.采集)}%`);
    } else {
      lines.push(`好感: ${fmt(affinityVal)}`);
    }
    // 战力/挑战等级（L807）
    const combatPower = this.bonusService.calcCombatPower(b);
    const challengeLevel = this.combatState.getAchievementProficiency(markers, '挑战等级');
    lines.push(`战力: ${combatPower}  挑战: ${challengeLevel}`);
    lines.push('━━━━━━━━━━━━━━━');
    // ========== 详细属性段（L808-976，对应原版 详细=真 分支） ==========
    // 护盾抗性（L809-813）
    if (num(b.护盾伤害上限) !== 0) lines.push(`◆护盾单次最多减少${fmt(b.护盾伤害上限)}%`);
    lines.push(`◆护盾物/火/冰/电抗:`);
    lines.push(`  ${fmt(b.护盾物抗)}%/${fmt(b.护盾火抗)}%/${fmt(b.护盾冰抗)}%/${fmt(b.护盾电抗)}%`);
    // 装甲抗性（L814-818）
    if (num(b.装甲伤害上限) !== 0) lines.push(`◆装甲单次最多减少${fmt(b.装甲伤害上限)}%`);
    lines.push(`◆装甲物/火/冰/电抗:`);
    lines.push(`  ${fmt(b.装甲物抗)}%/${fmt(b.装甲火抗)}%/${fmt(b.装甲冰抗)}%/${fmt(b.装甲电抗)}%`);
    // 生命抗性（L819-823）
    if (num(b.生命伤害上限) !== 0) lines.push(`◆生命单次最多减少${fmt(b.生命伤害上限)}%`);
    lines.push(`◆生命物/火/冰/电抗:`);
    lines.push(`  ${fmt(b.生命物抗)}%/${fmt(b.生命火抗)}%/${fmt(b.生命冰抗)}%/${fmt(b.生命电抗)}%`);
    // 暴击伤害/韧性（L824）
    lines.push(`◆暴击伤害: ${fmt(b.暴击伤害)}%  韧性: ${fmt(b.韧性)}%`);
    // 经验加成/升级经验（L825-835）
    if (player.type) {
      if (num(b.经验) !== 0 || num(b.升级经验) !== 0) {
        lines.push(`◆获得经验+${fmt(b.经验)}%  升级经验${fmt(b.升级经验)}%`);
      }
    } else {
      if (num(b.升级经验) !== 0) {
        lines.push(`◆升级经验${fmt(b.升级经验)}%`);
      }
    }
    // 穿透（L836-838）
    if (num(b.护盾穿透) + num(b.装甲穿透) + num(b.生命穿透) !== 0) {
      lines.push(`◆护盾/装甲/生命穿透: ${fmt(b.护盾穿透)}/${fmt(b.装甲穿透)}/${fmt(b.生命穿透)}%`);
    }
    // 攻击冷却（L839-850）：玩家按武器列举
    const weaponList = weapons || asJsonValue<any[]>(player.weapons, []);
    if (Array.isArray(weaponList) && weaponList.length > 0) {
      const cdParts: string[] = weaponList.map((w: any, i: number) =>
        `${w.name || w.名称 || `武器${i + 1}`}:${num(w.cooldown ?? w.冷却 ?? 0)}`,
      );
      lines.push(`◆攻击冷却:`);
      lines.push(`  ${cdParts.join('  ')}`);
    }
    // 额外攻击次数（L851-853）
    if (num(b.攻击次数) > 0) {
      lines.push(`◆额外攻击次数: ${num(b.攻击次数)}`);
    }
    // 贯穿/抗贯穿（L854-856）
    if (num(b.贯穿) + num(b.抗贯穿) !== 0) {
      lines.push(`◆贯穿: ${fmt(b.贯穿)}%  抗贯穿: ${fmt(b.抗贯穿)}%`);
    }
    // 溅射（L857-859）
    if (num(b.溅射) + num(b.溅射2 ?? 0) !== 0) {
      lines.push(`◆溅射伤害: ${num(b.溅射)}% (数量${num(b.溅射数量 ?? 0)})`);
    }
    // 三回复（L860-868）
    if (num(b.护盾回复) + num(b.护盾回复2 ?? 0) !== 0) {
      lines.push(`◆护盾回复: ${fmt(b.护盾回复)}+${fmt(b.护盾回复2)}%`);
    }
    if (num(b.装甲回复) + num(b.装甲回复2 ?? 0) !== 0) {
      lines.push(`◆装甲修复: ${fmt(b.装甲回复)}+${fmt(b.装甲回复2)}%`);
    }
    if (num(b.生命回复) + num(b.生命回复2 ?? 0) !== 0) {
      lines.push(`◆生命恢复: ${fmt(b.生命回复)}+${fmt(b.生命回复2)}%`);
    }
    // 三偷取（L869-877）
    if (num(b.吸护盾) + num(b.吸护盾2 ?? 0) !== 0) {
      lines.push(`◆护盾偷取: ${num(b.吸护盾)}+${num(b.吸护盾2)}%`);
    }
    if (num(b.吸装甲) + num(b.吸装甲2 ?? 0) !== 0) {
      lines.push(`◆装甲偷取: ${num(b.吸装甲)}+${num(b.吸装甲2)}%`);
    }
    if (num(b.吸生命) + num(b.吸生命2 ?? 0) !== 0) {
      lines.push(`◆生命偷取: ${num(b.吸生命)}+${num(b.吸生命2)}%`);
    }
    // 三部位伤害倍率（L878）
    lines.push(`◆护盾/装甲/生命伤害: ${100 + num(b.攻击护盾)}/${100 + num(b.攻击装甲)}/${100 + num(b.攻击生命)}`);
    // 掉落（L879-884）
    if (num(b.掉落率) + num(b.掉落品质) !== 0) {
      lines.push(`◆掉落几率+${fmt(b.掉落率)}% (数量+${fmt(b.掉落品质)}%)`);
    }
    if (sets && num((sets as any).legendaryRate ?? (sets as any).传说率) !== 0) {
      lines.push(`◆传说几率+${fmt((num((sets as any).legendaryRate ?? (sets as any).传说率)) * 12.5)}%`);
    }
    // 每秒回复（L885-889）：玩家版除以3
    const hpRegenPerSec = (num(b.生命回复) + num(b.生命回复2) / 100 * num(b.生命)) /
      (1 - (num(b.生命火抗) + num(b.生命物抗) + num(b.生命冰抗) + num(b.生命电抗)) / 400);
    const armorRegenPerSec = (num(b.装甲回复) + num(b.装甲回复2) / 100 * num(b.装甲)) /
      (1 - (num(b.装甲火抗) + num(b.装甲物抗) + num(b.装甲冰抗) + num(b.装甲电抗)) / 400);
    const shieldRegenPerSec = (num(b.护盾回复) + num(b.护盾回复2) / 100 * num(b.护盾)) /
      (1 - (num(b.护盾火抗) + num(b.护盾物抗) + num(b.护盾冰抗) + num(b.护盾电抗)) / 400);
    const totalRegen = hpRegenPerSec + armorRegenPerSec + shieldRegenPerSec;
    lines.push(`◆每秒回复: ${fmt(totalRegen / 3)}`);
    // 卷土重来（L890-892）
    if (player.type) {
      lines.push(`◆卷土重来持续时间: ${30 + num(b.卷土重来)}`);
    }
    // 每秒输出DPS（L893-920）
    const currentWeaponIdx = num(player.currentWeapon ?? player.当前武器 ?? 0);
    if (currentWeaponIdx > 0 && Array.isArray(weaponList) && weaponList.length >= currentWeaponIdx) {
      const z = weaponList[currentWeaponIdx - 1];
      const zPhys = Number(z?.bonus?.物 ?? z?.属性?.物 ?? 0);
      const zFire = Number(z?.bonus?.火 ?? z?.属性?.火 ?? 0);
      const zIce = Number(z?.bonus?.冰 ?? z?.属性?.冰 ?? 0);
      const zElec = Number(z?.bonus?.电 ?? z?.属性?.电 ?? 0);
      const zCd = Number(z?.cooldown ?? z?.冷却 ?? 10) || 10;
      const baseDps = (num(b.冰伤) * zIce / 100 + num(b.火伤) * zFire / 100 + num(b.物伤) * zPhys / 100 + num(b.电伤) * zElec / 100) / zCd;
      const critDps = (num(b.暴击伤害) - 100) / 100 * num(b.暴击) / 100 * baseDps;
      lines.push(`◆每秒输出: ${fmt(baseDps + critDps)}`);
    } else {
      const baseDps = num(b.物伤) / 10;
      const critDps = num(b.暴击) / 100 * (num(b.暴击伤害) - 100) / 100 * baseDps;
      lines.push(`◆每秒输出: ${fmt(baseDps + critDps)}`);
    }
    // 攻击加成倍率（L903-904）
    const atkBonus = (100 + (1 * (1 + num(b.电伤2) / 100) * (1 + num(b.攻击2) / 100) +
      1 * (1 + num(b.物伤2) / 100) + 1 * (1 + num(b.火伤2) / 100) + 1 * (1 + num(b.冰伤2) / 100) - 4) * 100) *
      (1 + num(b.攻击2) / 100);
    lines.push(`◆攻击加成倍率: ${fmt(atkBonus)}%`);
    // 当前增益效果（L956-963）
    const buffStrs = this.formatBuffList(Array.isArray(buffs) ? buffs : player.buffs);
    if (buffStrs.length > 0) {
      lines.push(`◆当前增益: ${buffStrs.join('、')}`);
    }
    // 魅力/活力（L977-985）
    if (player.type) {
      const productivity = this.combatState.getAchievementProficiency(markers, '生产');
      if (productivity > 0) {
        lines.push(`载具生产力+${productivity}%  魅力: ${fmt(b.魅力)}`);
      } else {
        lines.push(`魅力: ${fmt(b.魅力)}`);
      }
      const vitality = Math.max(100, this.combatState.getAchievementProficiency(markers, '活力2'));
      lines.push(`活力: ${num(player.vitality ?? player.活力 ?? 0)}/${vitality}`);
    }
    // 驾驶载具（L986-992）
    const map = await this.mapService.getMapById(player.mapId);
    if (map?.name) {
      const vehicles = asJsonValue<any[]>(map.vehicles, []);
      const playerVehicles = asJsonValue<any[]>(player.vehicles, []);
      const allVehicles = [...(vehicles || []), ...(playerVehicles || [])];
      const driven = allVehicles.find((v: any) =>
        v.owner === String(userId) || v.归属 === String(userId) ||
        v.driver === String(userId) || v.驾驶者 === String(userId),
      );
      if (driven) {
        const vName = driven.name || driven.名称 || '载具';
        const vHp = num(driven.currentHp ?? driven.当前生命 ?? 0);
        const vMaxHp = num(driven.bonus?.生命 ?? driven.加成?.生命 ?? 0);
        lines.push(`正在驾驶 ${vName}(${vHp}/${vMaxHp})`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 处理使用物品命令
   */
  async handleUseItem(userId: number, itemName: string, count = 1): Promise<string> {
    const cropName = this.getSeedCropName(itemName);
    if (cropName) {
      return this.handleUseSeed(userId, itemName, cropName, count);
    }
    return this.itemService.useItem(userId, itemName, count);
  }

  /**
   * 处理“使用全部XX”命令
   * 1:1 复刻 _主程序.ecode L4517-4540：模糊匹配名字包含[XX]的全部可用箱子，
   * 屏蔽种子，倒序逐一全部使用（对应原版快捷的“使用全部箱”操作）。
   */
  async handleUseAllItems(userId: number, keyword: string): Promise<string> {
    return this.itemService.useAllItems(userId, keyword);
  }

  /** 原版“使用种子”直接把作物放入当前地图资源2，不经过普通物品掉落。 */
  private getSeedCropName(itemName: string): string {
    const normalizedName = String(itemName || '').trim();
    if (!normalizedName.endsWith('种子')) return '';
    const item = this.staticData.getItemByName(normalizedName);
    const effects = asJsonValue<any[]>(item?.useEffects, []);
    const candidates = effects
      .flatMap((effect: any) => String(effect ?? '').split(/[，,、]/))
      .map((effect: string) => effect.trim())
      .filter(Boolean);
    const resource = this.staticData.getAllResources().find((candidate: any) => {
      const name = String(candidate?.name ?? candidate?.名称 ?? '').trim();
      return candidates.includes(name)
        && this.parseResourceOutputs(candidate?.outputs2 ?? candidate?.['产出2']).length > 0;
    });
    return String(resource?.name ?? resource?.名称 ?? '').trim();
  }

  private async handleUseSeed(
    userId: number,
    seedName: string,
    cropName: string,
    requestedCount: number,
  ): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${player.name || '冒险者'}当前不在有效地图中`;

    const mapName = String(map.name || '');
    if (mapName.endsWith('屋内')) {
      return `${player.name || '冒险者'}不能在房子内使用${seedName}`;
    }

    const ownHouse = Boolean(player.houseName && mapName === String(player.houseName));
    if (map.isFrontier && !ownHouse) {
      return `${player.name || '冒险者'}不能在别人家里用这个`;
    }

    // 原版普通地图最多保留两个作物；自己的院子允许继续种植。
    if (!ownHouse) {
      const resources2 = asJsonValue<any[]>(map.resources2, []);
      const cropCount = resources2
        .filter((resource: any) => this.parseResourceOutputs(resource?.outputs2 ?? resource?.['产出2']).length > 0)
        .reduce((total: number, resource: any) => total + Number(
          resource?.quantity ?? resource?.count ?? resource?.times ?? resource?.次数 ?? 1,
        ), 0);
      if (cropCount >= 2) return `${player.name || '冒险者'}当前地图无法种下更多了`;
    }

    const count = Math.max(1, Math.floor(Number(requestedCount) || 1));
    let planted = 0;
    let lastMessage = '';
    for (let index = 0; index < count; index++) {
      const result = await this.homeService.plantSeed(map, seedName, backpack, []);
      lastMessage = result.message;
      if (!result.success) break;
      planted += 1;
    }
    if (planted <= 0) return lastMessage || `背包中没有「${seedName}」`;

    await this.mapService.updateDynamicFields(map.id, { resources2: map.resources2 });
    player.backpack = backpack; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, '种植', planted);
    await this.taskService.advance(userId, `种植${cropName}`, planted);
    return `${player.name || '冒险者'}在${mapName}种下了${cropName}×${planted}`;
  }

  /**
   * 处理装备命令
   * 用户可能输入的物品名形态：
   *   - 「基础名」（如 防弹上衣）
   *   - 「基础名 + 单字母品质码」（如 防弹上衣D）
   *   - 「基础名 + 品质码 + 可选·后缀特效」（如 防弹上衣D·纯洁无瑕）
   * 而背包里 item.name 仅存基础名（品质在 item.data，特效在解析层），
   * 因此做三层回退匹配保证任意形态都能定位到目标物品。
   */
  async handleEquip(userId: number, itemName: string): Promise<string>{
    return this.equipCommandServiceSvc.handleEquip(userId, itemName);
  }
  async handleUnequip(userId: number, slot: string): Promise<string>{
    return this.equipCommandServiceSvc.handleUnequip(userId, slot);
  }
  async handleSkill(userId: number): Promise<string>{
    return this.skillCommandServiceSvc.handleSkill(userId);
  }
  async handleRescue(userId: number): Promise<string>{
    return this.rescueWhiteServiceSvc.handleRescue(userId);
  }
  async handleTalk(userId: number, npcName: string): Promise<string>{
    return this.questDialogueServiceSvc.handleTalk(userId, npcName);
  }
  private genericNpcChatLine(npcType: string): string{
    return this.questDialogueServiceSvc.genericNpcChatLine(npcType);
  }
  private async buildUnitDialogue( player: any, userId: number, npcName: string, unit: any, kind: 'npc' | 'summon' | 'monster', ): Promise<string>{
    return this.questDialogueServiceSvc.buildUnitDialogue(player, userId, npcName, unit, kind);
  }
  private millisecondsToText(ms: number): string {
    return this.supportSvc.millisecondsToText(ms);
  }

  private round2Text(value: number): string {
    return this.supportSvc.round2Text(value);
  }

  /**
   * 处理与露娜的对话（对话露娜未知）
   * 对应原版：对话露娜未知 命令
   * 当玩家携带"未知物品"（具现装置的产物）与露娜对话时，
   * 可用其兑换"工业建筑箱"或"专属装备补给箱"，并增加露娜熟练度
   */
  async handleDialogueLuna(userId: number, arg: string): Promise<string>{
    return this.questDialogueServiceSvc.handleDialogueLuna(userId, arg);
  }
  async handleArriveAt(userId: number, arg: string): Promise<string>{
    return this.questDialogueServiceSvc.handleArriveAt(userId, arg);
  }
  async handleHome(userId: number, subCommand: string, ...args: string[]): Promise<string>{
    return this.homeBuildServiceSvc.handleHome(userId, subCommand, ...args);
  }
  async handleProbe(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查是否死亡
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 解析地图各 JSON 字段
    const monsters = await this.mapService.getMapMonsters(map);
    const resources2 = asJsonValue<any[]>(map.resources2, []);
    const items = asJsonValue<any[]>(map.items, []);
    const npcs = asJsonValue<any[]>(map.npcs, []);
    // 与采集门禁保持一致：过滤已采完(times=0)与当前玩家已领取过(marker)的固定资源
    const probeMarkers = asJsonValue<Record<string, any>>(player.markers, {});
    const resources = asJsonValue<any[]>(map.resources, [])
      .filter((r: any) => this.getResourceTimes(r) !== 0 && this.isGatherResourceAvailable(r, probeMarkers));

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
        // 伤害计算保留双精度（对齐原版），显示时取整，避免出现 HP:13.13679525036632 这种浮点尾巴
        lines.push(`  ${m.name} Lv.${m.level} HP:${Math.round(m.hp)}/${Math.round(m.maxHp)}(${hpPercent}%)${m.isElite ? ' ⚠️精英' : ''}`);
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
        lines.push(`  ${item.name} ×${formatDisplayNumber(count)}`);
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
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 解析地图上的物品
    const mapItems = asJsonValue<any[]>(map.items, []);
    if (mapItems.length === 0) {
      return '地上没有可拾取的物品';
    }

    const requestedName = String(itemName || '').trim();
    if (!requestedName) {
      // 对齐原版：无参数只展示地面物品，“拾取全部”才真正执行拾取。
      const lines = [`${player.name || '冒险者'}附近的地上有:`];
      lines.push(...mapItems.map((item: any) => {
        const count = Number(item.count ?? item.quantity ?? 1);
        return `  ${item.name || '未知'}${count === 1 ? '' : ` ×${formatDisplayNumber(count)}`}`;
      }));
      return lines.join('\n');
    }

    // 开拓地（玩家家园）保护（原版 L3721-3736）：只有主人可以在自己家园/屋内/前线拾取
    if (map.开拓地 || map.isFrontier) {
      const house = String(player.houseName ?? '');
      const mapName = String(map.name ?? '');
      const ownHome = !!house
        && (mapName === house || mapName === `${house}屋内` || mapName === `${house}前线`);
      if (!ownHome) return `${player.name || '冒险者'}不能拿别人家里的东西`;
    }

    // 花园猫/铃铛 +33%（原版 L3743：玩家特殊序号==花园猫(1) 或 装备铃铛(特殊序号64)）
    const equipments = playerData.equipment || asJsonValue<any[]>(player.equipment, []);
    const weapons = playerData.weapons || asJsonValue<any[]>(player.weapons, []);
    const hasPickBonus = Number(player.specialSeq ?? player.特殊序号 ?? 0) === 1
      || this.combatState.equipRequire(equipments, weapons, Number(player.currentWeapon ?? 0), 64, '铃铛', false);

    const pickAll = requestedName === '全部' || requestedName === '全部拾取';
    let pickedUp: any[];
    let bonusApplied = false;

    if (pickAll) {
      // mutateMapFields 锁内闭环：重读最新 items → 全部取走 → 以实际取走内容发放
      // （避免两名玩家并发拾取同一批物品时按各自快照重复发放）
      pickedUp = await this.mapService.mutateMapFields(map.id, ['items'], (f) => {
        const taken = [...(f.items as any[])];
        for (const item of taken) {
          const type = item.type ?? item.类型 ?? '资源';
          if (type === '装备' || String(item.data ?? '') === 'a') continue;
          if (hasPickBonus) {
            // 原版 L3744-3746：数量×1.33 并标记 data="a" 防止重复加成
            item.quantity = Number(item.quantity ?? item.count ?? 1) * 1.33;
            item.data = 'a';
            bonusApplied = true;
          }
        }
        f.items = [];
        return taken;
      });
    } else {
      // 原版同时支持“拾取物品名”和“拾取序号”；锁内重定位，确保只取走一份
      const taken = await this.mapService.mutateMapFields(map.id, ['items'], (f) => {
        const fresh = f.items as any[];
        const numericIndex = /^\d+$/.test(requestedName) ? Number(requestedName) - 1 : -1;
        const idx = numericIndex >= 0
          ? numericIndex
          : fresh.findIndex((item: any) => (item.name || item.名称) === requestedName);
        if (idx < 0 || idx >= fresh.length) return null;
        const item = fresh[idx];
        const type = item.type ?? item.类型 ?? '资源';
        if (type === '装备' || String(item.data ?? '') === 'a') return fresh.splice(idx, 1)[0];
        if (hasPickBonus) {
          item.quantity = Number(item.quantity ?? item.count ?? 1) * 1.33;
          item.data = 'a';
          bonusApplied = true;
        }
        return fresh.splice(idx, 1)[0];
      });
      if (!taken) {
        return `地上没有【${requestedName}】`;
      }
      pickedUp = [taken];
    }

    for (const item of pickedUp) {
      const count = Number(item.count ?? item.quantity ?? 1);
      await this.playerService.addToBackpack(userId, item.name || item.名称, count);
    }

    this.logger.log(`玩家 ${userId} 拾取了 ${pickedUp.length} 种物品`);

    const pickedText = pickedUp.map((item: any) => {
      const count = Number(item.count ?? item.quantity ?? 1);
      return `${item.name || item.名称} ×${formatDisplayNumber(count)}`;
    }).join('、');

    // 原版拾取顺序：先记录资源产出，再记录拾取条目数。
    // 资源数量是任务进度；“拾取”按地面条目数，不按堆叠数量计算。
    for (const item of pickedUp) {
      const type = item.type ?? item.类型 ?? '资源';
      const itemNameValue = item.name || item.名称 || '';
      const count = Number(item.count ?? item.quantity ?? 1);
      if (type !== '装备' && item.data !== 'a' && itemNameValue && count > 0) {
        await this.advanceTask(userId, '采集资源', count);
        await this.advanceTask(userId, `采集${itemNameValue}`, count);
      }
    }
    await this.advanceTask(userId, '拾取', pickedUp.length);

    // 活跃度+1（原版 L3766/L3810）
    const freshPlayer = (await this.playerService.getPlayerData(userId)).player;
    const freshMarkers = asJsonValue<Record<string, any>>(freshPlayer.markers, {});
    this.incrementMarker(freshMarkers, '活跃度', 1);
    freshPlayer.markers = freshMarkers;
    await this.playerService.savePlayer(freshPlayer);

    // 地图标记“全部拾取/拾取”时间戳（原版 L3767-3771/L3811-3815：取成就熟练度(地图.标记)）
    const stampKey = pickAll ? '全部拾取' : '拾取';
    let lastStampText = '';
    await this.mapService.mutateMapFields(map.id, ['markers'], (f) => {
      const mapMarkers = f.markers as Record<string, any>;
      const last = Number(mapMarkers[stampKey] ?? 0);
      if (last > 0) {
        lastStampText = `${map.name}上次被${pickAll ? '全部拾取' : '单项拾取'}是在${this.millisecondsToText(Date.now() - last)}之前`;
      }
      mapMarkers[stampKey] = Date.now();
      return true;
    }).catch(() => undefined);

    const bonusText = bonusApplied ? '(+33%)' : '';
    const text = pickAll
      ? `${player.name || '冒险者'}卷走了地上的${pickedUp.length}样东西${bonusText}\n${pickedText}`
      : `${player.name || '冒险者'}卷走了地上的${pickedText}${bonusText}`;
    return lastStampText ? `${text}\n${lastStampText}` : text;
  }

  /**
   * 开采资源
   * 开采当前地图的资源点
   */
  async handleMine(userId: number, resourceName?: string): Promise<string> {
    // 对齐原版 _主程序.ecode L7491「开采」：无参=载具开采（60秒延时结算）。
    // 原版「开采 资源名」带参无行为（L7512 判断 w2=="" 才进入开采链）；资源点采集
    // 原版由各资源自带的采集指令（打开箱子/捡垃圾等）承担。新版保留带参入口，
    // 避免破坏既有玩法，属有意保留的兼容扩展。
    if (resourceName) return this.mineResourcePoint(userId, resourceName);
    return this.mineByVehicle(userId);
  }

  /**
   * 手动载具开采（原版 _主程序.ecode L7491-7531「开采」）。
   * 门禁链：需驾驶载具 → 载具 HP>0 → 采集器部件（引力调频器/行星解裂器/激光采集器）
   * → 不能在副本 → 行动无限制（理由5=躺下豁免）。
   * 通过后：添加「工作」60秒标记 → 无隐形模块时延时5秒引怪（覅攻击pd）→ 玩家活跃
   * → 排程 60 秒延时结算（settleManualMine，原版「开采1c2c」）。
   */
  private async mineByVehicle(userId: number): Promise<string> {
    return this.mutatePlayer(userId, async (ctx) => {
      const { player } = ctx;
        { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }
      const map = await this.mapService.getMapById(player.mapId);
      if (!map) return '你不在任何地图上！';

      // 取载具（原版 L7494-7499）
      const vehicle = await this.findTravelVehicle(player, map);
      if (!vehicle) return `${player.name ?? '冒险者'}需要驾驶载具`;
      const vehicleName = String(vehicle.name ?? vehicle.名称 ?? '载具');
      if (Number(vehicle.currentHp ?? vehicle.当前生命 ?? 0) <= 0) {
        return `${player.name ?? '冒险者'}载具需要“维修”`;
      }

      // 采集器部件档位（原版 L7501-7509）：引力调频器=3 / 行星解裂器=2 / 激光采集器=1
      const partNames = this.collectVehiclePartNames(vehicle);
      const collector = partNames.includes('引力调频器')
        ? 3
        : partNames.includes('行星解裂器')
          ? 2
          : partNames.includes('激光采集器')
            ? 1
            : 0;
      if (collector === 0) {
        // 原版 L7511：提示 + 临时输入替换「1@制造部件」（输入 1 直接前往制造部件）
        if (this.shortcutService?.setTempInput) {
          await this.shortcutService.setTempInput(userId, '1@制造部件');
        }
        return `${player.name ?? '冒险者'}${vehicleName}需要安装激光采集器、行星解裂器或者引力调频器\n(输入 1 前往制造部件)`;
      }
      const collectorText = collector === 3
        ? '引力调频器分解'
        : collector === 2
          ? '行星解裂器轰炸'
          : '激光采集器轰炸';

      // 副本拦截（原版 L7513-7514）
      if (map.isInstance || Number(map.关卡 ?? 0) !== 0) {
        return `${player.name ?? '冒险者'}不能在副本里干这个`;
      }
      // 行动无限制，理由5=躺下豁免（原版 L7515）
      const restrict = this.combatSystem.actionUnrestricted(player, { ignoreReason: 5 });
      if (restrict.restricted) return restrict.text;

      // 工作 60 秒标记（原版 L7518 添加标记("工作",60,玩家.标记2)）
      const markers2 = asJsonValue<any[]>(player.markers2, []);
      this.normalizeMarkers2(markers2);
      this.combatState.addMarker('工作', 60, markers2, Date.now());

      // 玩家活跃（原版 L7530 玩家活跃：地图活动窗口120秒 + 玩家战斗标记15秒）
      // 无隐形模块时先延时5秒引怪（原版 L7527-7529 新建延时"覅攻击pd"+地图, 5秒）。
      const hasStealthModule = partNames.includes('隐形模块');
      if (!hasStealthModule) {
        // 原版 L7527-7529：工作分支仅豁免隐形模块，不豁免隐匿模式
        await (this.combatSystem as any).triggerMapBattleLoop(userId, 5, { player, map }, { ignoreStealth: true });
      } else {
        const mapMarkers2 = asJsonValue<any[]>(map.markers2, []);
        this.combatState.gainBuff(mapMarkers2, '活动', 120, false, Date.now());
        map.markers2 = mapMarkers2; // 内存对象保持一致
        // 落库走按名合并（锁内重读）：本命令期间可能已有击杀登记「刷新怪物」标记，
        // 整组回写会把新标记抹掉 → 怪不再补。
        await this.mapService.mergeMapMarkers2(map.id, mapMarkers2);
        this.combatState.gainBuff(markers2, '战斗', 15, false, Date.now());
      }
      player.markers2 = markers2; // Json 列直接写数组

      // 排程 60 秒延时结算（原版 L7531 新建延时「开采1c2c」）
      if (this.delayedTaskService) {
        await this.delayedTaskService.schedule({
          type: 'mine',
          userId,
          dedupeKey: String(userId),
          runAt: Date.now() + 60 * 1000,
        });
      }

      // 文本（原版 L7519-7526：玩家名+召唤物跟随显示+用+采集器名+地图名）
      const display = await this.summonFollowDisplay(map, userId, { requireFollow: false, countLimit: 3 });
      const followText = display.count > 0 ? `带着${display.names.join('、')}一起` : '';
      return `${player.name ?? '冒险者'}${followText}用${collectorText}${map.name}`;
    });
  }

  /**
   * 资源点采集（带参「开采 资源名」兼容分支）。
   * 直接采当前地图剩余数量>0 的资源点并挂 respawnTime 冷却。
   * 注：原版无此用法（载具开采见 mineByVehicle、资源点采集指令见 handleGatherResource），
   * 此处为保留既有玩法的复刻扩展。
   */
  private async mineResourcePoint(userId: number, resourceName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, markers2 } = playerData;

    // 检查是否死亡
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 解析可采集资源
    const resources2 = asJsonValue<any[]>(map.resources2, []);
    const availableResources = resources2.filter((r: any) => Number(r.amount ?? r.数量 ?? 0) > 0);

    if (availableResources.length === 0) {
      return '当前地图没有可开采的资源';
    }

    // 如果没有指定资源，显示可开采列表
    if (!resourceName) {
      const lines = [`⛏️ 【${map.name}】可开采资源:`];
      for (const r of availableResources) {
        lines.push(`  ${r.name ?? r.名称} ×${r.amount ?? r.数量}`);
      }
      lines.push(``);
      lines.push(`使用「开采 资源名」进行开采`);
      return lines.join('\n');
    }

    // 查找指定资源
    const targetResource = availableResources.find(
      (r: any) => (r.name ?? r.名称) === resourceName,
    );
    if (!targetResource) {
      return `当前地图没有可开采的【${resourceName}】`;
    }

    // 检查冷却时间（通过 markers2 管理）
    const cooldownKey = `mine_${map.id}_${resourceName}`;
    const now = Date.now();
    const cooldownEntry = markers2.find((m: any) =>
      (m.key ?? m.name ?? m.名称) === cooldownKey,
    );
    if (cooldownEntry) {
      const expireMs = toExpireMs(cooldownEntry);
      const remaining = expireMs - now;
      if (remaining > 0) {
        return `【${resourceName}】还需要 ${Math.ceil(remaining / 1000)} 秒才能再次开采`;
      }
    }

    // 采集产出
    const resourceDisplayName = targetResource.name ?? targetResource.名称 ?? resourceName;
    const amount = Number(targetResource.amount ?? targetResource.数量 ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return `当前地图没有可开采的【${resourceName}】`;
    }

    // 在同一个玩家对象上完成背包和冷却写入，避免 addToBackpack 先保存后再用旧快照覆盖背包。
    const backpack = Array.isArray((playerData as any).backpack)
      ? (playerData as any).backpack
      : this.playerService.getBackpackItems(player);
    this.addItemToCollection(backpack, { name: resourceDisplayName, type: '资源', quantity: amount });
    player.backpack = backpack; // Json 列直接写数组

    // 设置冷却时间（默认5分钟）
    const respawnTime = (targetResource.respawnTime || 300) * 1000;
    const newCooldown = {
      key: cooldownKey,
      expireTime: now + respawnTime,
    };

    // 更新 markers2（移除旧冷却条目，添加新条目）
    const updatedMarkers2 = markers2.filter((m: any) =>
      (m?.key ?? m?.name ?? m?.名称) !== cooldownKey,
    );
    updatedMarkers2.push(newCooldown);

    // 更新地图资源（mutateMapFields 锁内闭环：重读最新 resources2 → 按名重定位归零 → 差异写回；
    // 避免两名玩家并发开采同一资源时按各自快照重复结算/整组覆盖）
    const mined = await this.mapService.mutateMapFields(map.id, ['resources2'], (f) => {
      const fresh = f.resources2 as any[];
      const idx = fresh.findIndex((r: any) => (r.name ?? r.名称) === resourceName);
      if (idx === -1) return false;
      const r = fresh[idx];
      r.amount = 0;
      if (r.数量 !== undefined) r.数量 = 0;
      return true;
    });
    if (!mined) {
      return `这里没有${resourceDisplayName}可以开采`;
    }

    // 更新玩家 markers2
    player.markers2 = updatedMarkers2; // Json 列直接写数组
    await this.playerService.savePlayer(player);

    // 手动开采的任务在服务层按真实产量结算，命令层不再重复推进。
    await this.advanceTask(userId, '开采');
    await this.advanceTask(userId, '采集资源', amount);
    const gatherCommand = targetResource.gatherCmd ?? targetResource.采集指令 ?? '';
    if (resourceName === '货舱' || gatherCommand === '打开货舱') {
      await this.advanceTask(userId, '打开货舱');
    } else {
      await this.advanceTask(userId, `采集${resourceDisplayName}`, amount);
    }

    // 原版“采集资源”在有跟随者协助时会把实际采集次数减一记为“奴役”。
    // 当前资源点一次结算的 amount 就是实际采集次数，保留首轮为0的原版边界。
    const enslaved = Math.max(0, Math.floor(amount) - 1);
    if (enslaved > 0) await this.advanceTask(userId, '奴役', enslaved);

    this.logger.log(`玩家 ${userId} 开采了 ${resourceDisplayName} ×${amount}`);

    const respawnMin = Math.ceil(respawnTime / 60000);
    return `开采了 ${resourceDisplayName} ×${amount}\n该资源将在 ${respawnMin} 分钟后刷新`;
  }

  /**
   * 手动载具开采的 60 秒延时结算（原版 _主程序.ecode L7534-7608「开采1c2c」）。
   * 遍历当前地图野生资源（可再生、标记空、产出2空）：
   *   - 每个产出按身边召唤物因子独立 roll 几率（原版 几率判断）；
   *   - 数量 = 产出数量×16×(1+采集/100)，行星解裂器额外 ×(1+rand(2500,5000)/10000)；
   *   - 每个资源「次数-6」，次数归零后移除资源并挂 1800 秒「刷新资源X」重生标记；
   *   - 成就：开采+1 / 采集资源 / 采集X / 采集熟练度+2×因子；
   *   - 无隐形模块时结算后再次引怪。
   */
  private async settleManualMine(userId: number): Promise<void> {
    const text = await this.playerService.enqueueUserWrite(userId, async () => {
      const playerData = await this.playerService.getPlayerData(userId);
      const { player } = playerData;
      const map = await this.mapService.getMapById(player.mapId);
      if (!map) return '';

      // 载具/采集器重取（结算文本用；中途换载具时以当前载具为准）
      const vehicle = await this.findTravelVehicle(player, map);
      const partNames = vehicle ? this.collectVehiclePartNames(vehicle) : [];
      const collector = partNames.includes('引力调频器')
        ? 3
        : partNames.includes('行星解裂器')
          ? 2
          : partNames.includes('激光采集器')
            ? 1
            : 0;
      const collectorText = collector === 3
        ? '引力调频器开采出了'
        : collector === 2
          ? '行星解裂器开采出了'
          : '激光采集器开采出了';

      // 跟随因子（原版 L7535/L7543-7546：归属召唤物数上限2，+1）
      const display = await this.summonFollowDisplay(map, userId, { requireFollow: false, countLimit: 3 });
      const followerFactor = Math.min(2, display.count) + 1;

      // 采集加成（原版 玩家.属性.采集，实时加成口径）
      let gatherBonus = 0;
      try {
        const bonus = this.combatSystem.buildAttackerBonus(player, playerData, map) as any;
        gatherBonus = Number(bonus?.采集 ?? 0);
      } catch { /* 加成缺失按0处理 */ }
      const multiplier = 1 + gatherBonus / 100;

      // 遍历野生资源产出（原版 L7550-7585；数据侧资源/资源2已合并进 resources 字段）
      const resources = asJsonValue<any[]>(map.resources, []);
      const emptied: string[] = [];
      const awarded = new Map<string, number>();
      // 装备单独记账：装备在上方循环里已按 generateRewardEquipment 生成入包（带词条），
      // 不得再进 awarded 走 addItemToCollection——那会再推一份无 data 的裸条目（重复发放）。
      const awardedEquipment = new Map<string, number>();
      const backpack = this.playerService.getBackpackItems(player);
      for (const resource of resources) {
        if (resource?.renewable === false || resource?.不可再生 === true) continue; // 不可再生
        if (String(resource?.marker ?? resource?.标记 ?? '').trim()) continue;      // 一次性特殊资源
        const outputs2 = resource?.outputs2 ?? resource?.['产出2'];
        if (Array.isArray(outputs2) ? outputs2.length > 0 : asJsonValue<any[]>(outputs2, []).length > 0) continue; // 建筑/作物产出
        for (const out of this.parseResourceOutputs(resource?.outputs)) {
          if (!out.name || out.name === '电力') continue;
          for (let i = 0; i < followerFactor; i++) {
            if (Math.random() * 100 >= Number(out.chance ?? 100)) continue; // 几率判断
            let amount = Number(out.count ?? 0) * 16 * multiplier;
            if (collector === 2) {
              amount *= 1 + this.randomInt(2500, 5000) / 10000; // 原版 L7562 行星解裂器随机增幅
            }
            if (amount <= 0) continue;
            const itemType = this.staticData.getEquipmentByName(out.name) ? '装备' : '资源';
            if (itemType === '装备') {
              const equipment = await this.itemSystemService.generateRewardEquipment(out.name, out.quality || '');
              this.addBackpackItem(backpack, { ...equipment, type: '装备', quantity: 1, count: 1 });
              awardedEquipment.set(out.name, (awardedEquipment.get(out.name) || 0) + 1);
            } else {
              awarded.set(out.name, (awarded.get(out.name) || 0) + amount);
            }
          }
        }
        // 次数-6（原版 L7571-7575；次数 -1 = 无限）
        const times = Number(resource?.times ?? resource?.次数 ?? -1);
        if (times !== -1 && times > 0) emptied.push(resource.name ?? resource.名称);
      }

      // 背包写回（数值过 roundItemQuantity 三道闸）；awarded 现只含资源，装备已在生成时入包
      for (const [itemName, amount] of awarded) {
        this.addItemToCollection(backpack, { name: itemName, type: '资源', quantity: amount });
      }
      player.backpack = backpack; // Json 列直接写数组

      // 地图写回：次数-6、枯竭移除并挂 1800 秒刷新标记（原版 L7571-7591+后台运作 L1035）
      let exhaustedText = '';
      await this.mapService.mutateMapFields(map.id, ['resources', 'markers2'], (f) => {
        const fresh = f.resources as any[];
        if (!Array.isArray(fresh)) return false;
        let changed = false;
        for (let i = fresh.length - 1; i >= 0; i--) {
          const resource = fresh[i];
          if (resource?.renewable === false || resource?.不可再生 === true) continue;
          if (String(resource?.marker ?? resource?.标记 ?? '').trim()) continue;
          const outputs2 = resource?.outputs2 ?? resource?.['产出2'];
          if (Array.isArray(outputs2) ? outputs2.length > 0 : asJsonValue<any[]>(outputs2, []).length > 0) continue;
          const times = Number(resource?.times ?? resource?.次数 ?? -1);
          if (times === -1) continue;
          const remaining = Math.max(0, times - 6);
          resource.times = remaining;
          if (resource.次数 !== undefined) resource.次数 = remaining;
          changed = true;
          if (remaining <= 0) {
            fresh.splice(i, 1); // 枯竭移除
            const name = String(resource.name ?? resource.名称 ?? '');
            const mapMarkers2 = Array.isArray(f.markers2) ? f.markers2 : [];
            const filtered = mapMarkers2.filter((entry: any) => (entry?.name ?? entry?.名称) !== `刷新资源${name}`);
            filtered.push({ name: `刷新资源${name}`, expireAt: Date.now() + 1800 * 1000, resourceField: 'resources' });
            f.markers2 = filtered;
          }
        }
        return changed;
      }).catch(() => false);

      // 成就与任务（原版 L7549/L7602-7605）；装备沿用历史口径计入采集任务
      const totalAmount = [...awarded.values(), ...awardedEquipment.values()].reduce((sum, value) => sum + value, 0);
      await this.advanceTask(userId, '开采');
      await this.advanceTask(userId, '采集资源', totalAmount);
      for (const [itemName, amount] of awarded) {
        await this.advanceTask(userId, `采集${itemName}`, amount);
      }
      for (const [itemName, amount] of awardedEquipment) {
        await this.advanceTask(userId, `采集${itemName}`, amount);
      }
      const markers = asJsonValue<Record<string, any>>(player.markers, {});
      markers['采集熟练度'] = Number(markers['采集熟练度'] ?? 0) + 2 * followerFactor;
      player.markers = markers; // Json 列直接写对象
      await this.playerService.savePlayer(player);

      // 结算文本（原版 L7535-7542/L7595-7599）
      // 结算文本（原版 L7535-7542/L7595-7599）；装备按 件 计入（与手动采集块一致）
      const gainedText = [
        ...[...awarded.entries()].map(([name, amount]) => `${name}×${formatDisplayNumber(amount)}`),
        ...[...awardedEquipment.entries()].map(([name, amount]) => `${name}×${amount}`),
      ].join('、');
      const followText = display.count > 0 ? `带着${display.names.join('、')}一起` : '';
      let resultText = `${player.name ?? '冒险者'}${followText}用${collectorText}${gainedText || ''}`;
      if (!gainedText) resultText = `${player.name ?? '冒险者'}${map.name}的资源已经枯竭了`;
      // 无隐形模块时结算后再次引怪（原版 L7606-7608，仅隐形模块豁免，不豁免隐匿模式）
      if (!partNames.includes('隐形模块')) {
        try {
          await (this.combatSystem as any).triggerMapBattleLoop(userId, 5, { player, map }, { ignoreStealth: true });
        } catch (e: any) {
          this.logger.warn(`开采结算引怪失败 userId=${userId}: ${e?.message || e}`);
        }
      }
      void exhaustedText;
      const taskNotice = this.taskService.consumeNotifications(userId);
      if (taskNotice) resultText = `${taskNotice}\n————————\n${resultText}`;
      return resultText;
    });

    if (text) {
      await this.chatService.broadcastSystem('世界频道', text, userId).catch(() => undefined);
      try {
        await this.pushPlayerUpdate(userId);
        await this.pushMapUpdate(userId);
      } catch { /* 推送失败不影响结算 */ }
    }
  }

  /** 载具部件名收集（含内置零件递归；与 AutoMineService.getVehiclePartNames 同口径）。 */
  private collectVehiclePartNames(vehicle: any): string[] {
    const names: string[] = [];
    const visit = (part: any): void => {
      if (!part) return;
      const name = String(part?.name ?? part?.名称 ?? '').trim();
      if (name) names.push(name);
      for (const inner of (Array.isArray(part?.builtinParts ?? part?.内置零件 ?? part?.builtin ?? part?.内置)
        ? (part.builtinParts ?? part?.内置零件 ?? part?.builtin ?? part?.内置)
        : asJsonValue<any[]>(part?.builtinParts ?? part?.内置零件 ?? part?.builtin ?? part?.内置, []))) {
        visit(inner);
      }
    };
    const parts = Array.isArray(vehicle?.parts ?? vehicle?.零件)
      ? (vehicle.parts ?? vehicle.零件)
      : asJsonValue<any[]>(vehicle?.parts ?? vehicle?.零件, []);
    for (const part of parts) visit(part);
    for (const part of (Array.isArray(vehicle?.builtinParts ?? vehicle?.内置零件)
      ? (vehicle.builtinParts ?? vehicle.内置零件)
      : asJsonValue<any[]>(vehicle?.builtinParts ?? vehicle?.内置零件, []))) {
      visit(part);
    }
    return names;
  }

  /**
   * 召唤物跟随显示（原版 数据显示.ecode L326-401 召唤物跟随显示）。
   * 归属=玩家（ownerQQ/userId 任意键命中）、requireFollow=true 时还要求「跟随」熟练度<1；
   * countLimit 为显示数量上限（原版第2参）。返回名单文本与数量。
   */
  /** 过渡期公开（P3-3 DelayedSettleService 经门面引用调用；P3-6 内核合并后改为直接注入） */
  async summonFollowDisplay(
    map: any,
    userId: number,
    options: { requireFollow?: boolean; countLimit?: number } = {},
  ): Promise<{ names: string[]; count: number; indexes: number[] }> {
    const requireFollow = options.requireFollow ?? true;
    const countLimit = options.countLimit ?? 0;
    const raw = map?.summons ?? map?.召唤物 ?? [];
    const summons = Array.isArray(raw) ? raw : asJsonValue<any[]>(raw, []);
    const ownerKeys = new Set([String(userId)].filter(Boolean));
    const names: string[] = [];
    const indexes: number[] = [];
    for (let i = 0; i < summons.length; i++) {
      const summon = summons[i];
      const owner = String(summon?.ownerQQ ?? summon?.归属 ?? summon?.owner ?? summon?.qq ?? '');
      if (!ownerKeys.has(owner)) continue;
      if (requireFollow) {
        let summonMarkers: any = summon?.markers ?? summon?.标记 ?? {};
        if (!Array.isArray(summonMarkers) && typeof summonMarkers === 'string') {
          summonMarkers = asJsonValue<any>(summonMarkers, {});
        }
        const prof = Array.isArray(summonMarkers)
          ? Number(summonMarkers.find((m: any) => (m?.name ?? m?.名称) === '跟随')?.value ?? 0)
          : Number(summonMarkers?.['跟随'] ?? 0);
        if (prof >= 1) continue; // 熟练度>=1 为不跟随
      }
      names.push(String(summon?.name ?? summon?.名称 ?? summon?.type ?? summon?.类型 ?? '宠物'));
      indexes.push(i);
      if (countLimit > 0 && names.length >= countLimit) break;
    }
    return { names, count: names.length, indexes };
  }

  /** 原版 取随机数(最小,最大)（含两端）。 */
  private randomInt(min: number, max: number): number {
    return this.supportSvc.randomInt(min, max);
  }

  /**
   * 判断当前玩家所在地图是否有匹配给定 gatherCmd 的固定资源。
   * 用于 ChatGateway 判定"该输入是否应作为采集指令处理"（避免被当作普通聊天广播）。
   * 对齐原版：采集指令运行时按当前地图资源2的"采集指令"匹配，无需预注册到指令表。
   * @param userId 玩家ID
   * @param cmdName 采集指令名（如 打开箱子/打开休眠仓/收集木头/捡垃圾）
   * @returns true=当前地图存在该采集指令对应的资源
   */
  async hasGatherCmd(userId: number, cmdName: string): Promise<boolean> {
    if (!cmdName) return false;
    try {
      const player = await this.prisma.player.findUnique({ where: { userId } });
      if (!player) return false;
      const map = await this.mapService.getMapById(player.mapId);
      if (!map) return false;
      const resources = this.getGatherResources(map);
      const markers = asJsonValue<Record<string, any>>(player.markers, {});
      const parsed = this.parseGatherCommand(cmdName);
      return resources.some((r) => r.gatherCmd === parsed.name
        && this.getResourceTimes(r) !== 0
        && this.isGatherResourceAvailable(r, markers));
    } catch {
      return false;
    }
  }

  /**
   * 开箱锁门禁查询（对应原版 _主程序.ecode L117-118）：
   * item.service 打开箱子处理期写入的「开箱」标记（markers2）未过期时，
   * 拦截玩家的一切其他指令：“正在开箱子，或者等待X”。
   * @returns 拦截文本；无锁时返回空串
   */
  async getOpenBoxLockText(userId: number): Promise<string> {
    try {
      const player = await this.prisma.player.findUnique({
        where: { userId },
        select: { name: true, markers2: true },
      });
      if (!player?.markers2) return '';
      const markers2 = Array.isArray(player.markers2)
        ? player.markers2
        : asJsonValue<any[]>(player.markers2, []);
      const entry = markers2.find((m: any) => (m?.name ?? m?.名称 ?? m?.key) === '开箱');
      if (!entry) return '';
      const expireAt = toExpireMs(entry);
      const now = Date.now();
      if (!Number.isFinite(expireAt) || expireAt <= now) return '';
      const remainSec = Math.ceil((expireAt - now) / 1000);
      const timeText = remainSec >= 60
        ? `${Math.floor(remainSec / 60)}分${remainSec % 60}秒`
        : `${remainSec}秒`;
      return `${player.name || '冒险者'}正在开箱子，或者等待${timeText}`;
    } catch {
      return '';
    }
  }

  /**
   * 处理固定资源的采集指令【阶段1：开始采集】（对应原版 gatherCmd 机制）
   * 1:1 对齐原版 _主程序.ecode 默认分支 L11351-11456：
   * 门禁(副本清怪/死亡/行动限制/自动采集) → 计算随机耗时(3~6秒×时间倍率×额外次数，
   * 矿炮上限30秒) → 写入「采集中」状态+「采集」锁定标记 → 调度延时任务 →
   * 回复“{采集文本},大概需要N秒”。
   * 延时到点后由 settleGatherResource（阶段2）真正结算产出。
   *
   * @param userId 玩家ID
   * @param cmdName 采集指令名（如 打开箱子/打开休眠仓/收集物品/捡垃圾，可带数字后缀表示次数）
   * @returns 开始文本；未命中任何资源时返回空字符串
   */
  async handleGatherResource(userId: number, cmdName: string, requestedCount?: number): Promise<string> {
    if (!cmdName) return '';

    // 超管特权「野外批量采集」：指令带数字后缀时实时查库 role（不信前端传值）；
    // 无数字后缀不发起查询，普通采集零额外开销。mutate 外查好传入闭包。
    const preParsed = this.parseGatherCommand(cmdName);
    const preCount = Math.max(1, Math.floor(Number.isFinite(requestedCount) ? requestedCount as number : preParsed.count));
    let userRole = '';
    if (preCount > 1) {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      userRole = user?.role ?? '';
    }

    // 采集开始是「读快照→改→写回」型操作，必须在用户级锁内完成，
    // 否则与定时器的采集结算并发会互相覆盖玩家数据（实测会偶发「并发冲突」）。
    // 走 mutate 收口：锁内单快照、统一落库（详见 docs/player-state-architecture.md）。
    return this.mutatePlayer(userId, async (ctx) => {
      const playerData = ctx;
      const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '';

    // 解析地图固定资源列表
    const resources = this.getGatherResources(map);
    const parsedCommand = this.parseGatherCommand(cmdName);
    const gatherName = parsedCommand.name;
    let count = Math.max(1, Math.floor(Number.isFinite(requestedCount) ? requestedCount as number : parsedCommand.count));
    const markers = asJsonValue<Record<string, any>>(player.markers, {});
    const target = resources.find((r: any) => r.gatherCmd === gatherName
      && this.getResourceTimes(r) !== 0
      && this.isGatherResourceAvailable(r, markers));
    if (!target) return '';
    const resourceName = String(target.name ?? '');

    // ===== 原版 _主程序.ecode L11374-11381 采集开始门禁 =====
    // 关卡(副本)有怪物时必须先清怪；死亡/行动受限/自动采集模式下不能手动采集。
    const hasMonsters = (await this.mapService.getMapMonsters(map)).length > 0;
    if (map.isInstance && hasMonsters) {
      return `${player.name}需要清除附近的目标`;
    }
    const deathGate = this.playerService.isPlayerDead(player)
      ? `${player.name}已经死掉了!你可以"复活使魔"或者"删除怪物"`
      : '';
    if (deathGate) return deathGate;
    const restriction = this.combatSystem.actionUnrestricted(player, { cannonOk: false });
    if (restriction.restricted) return restriction.text;
    if (this.playerService.getMarkerValue(markers, '自动采集') === 1) {
      return `${player.name}自动采集模式下无法手动采集\n"设置采集"可切换回手动采集`;
    }
    // 进程内防重复提交：同一毫秒内连发两次请求时，第二次在「采集」标记落库前到达，
    // actionUnrestricted 拦不住；原版单线程事件循环天然无此竞态。
    if (!this.gatherStartInflight) (this as any).gatherStartInflight = new Map<number, number>();
    const inflight = this.gatherStartInflight.get(userId);
    if (inflight && Date.now() - inflight < 3000) {
      return `${player.name}正在采集中，请稍候`;
    }
    this.gatherStartInflight.set(userId, Date.now());

    // ===== 原版 _主程序.ecode L11383-11399 计算采集耗时 =====
    // 家园院子里输入"指令N"一次执行 N 次（额外次数），其他地图忽略数字。
    // 超管特权扩展（2026-09-10）：ADMIN/SUPER_ADMIN 在任何地图批量后缀同样生效；
    // 耗时与产出线性同比放大（矿炮 30 秒封顶只封时长不封次数）。
    // 原版公式：a1 = 取随机数(3000×倍率, 6000×倍率) × d / 1000（毫秒→秒）
    const isOwnYard = player.houseName === map.name;
    const isAdmin = userRole === 'ADMIN' || userRole === 'SUPER_ADMIN';
    const extraMultiplier = (isOwnYard || isAdmin) ? Math.max(1, Math.floor(count)) : 1;
    const timeScale = Math.max(0.01, Number(target.timeScale ?? target.时间倍率 ?? 1) || 1);
    const seconds = Math.round((3000 + Math.random() * 3000) * timeScale / 1000) * extraMultiplier;

    // 矿炮(特殊序号-38)在手的玩家，单次采集耗时上限30秒（原版 L11391-11398）
    const weapons = Array.isArray(playerData.weapons) ? playerData.weapons : [];
    // currentWeapon 为 1-based（0=赤手）。赤手时不应取用任何武器，
    // 否则会把背上第一把武器误判为"在手"，触发矿炮上限/污染【武器】占位符。
    const currentWeaponIdx = Number(player.currentWeapon ?? 0);
    const currentWeapon = currentWeaponIdx > 0 ? weapons[currentWeaponIdx - 1] : null;
    const cappedSeconds = currentWeapon?.specialSeq === -38 ? Math.min(seconds, 30) : seconds;

    const now = Date.now();

    // ===== 原版 _主程序.ecode L11428-11435 锁定与延时任务 =====
    // 添加标记("采集", 次数)：锁定期间 行动无限制 会拦截移动/攻击/再次采集；
    // 获得增益("采集", 秒数)：同一标记的另一种写法，到期即采集完成。
    const markers2 = asJsonValue<any[]>(player.markers2, []);
    markers['采集中'] = { target: resourceName, cmd: gatherName,
      count: extraMultiplier, adminBatch: !isOwnYard && isAdmin,
      startedAt: now, settleAt: now + cappedSeconds * 1000 };
    this.combatState.addMarker('采集', cappedSeconds, markers2, now);
    player.markers = markers; // Json 列直接写对象
    player.markers2 = markers2; // Json 列直接写数组

    // 排程持久化延时任务：到点由 DelayedTaskService 分发结算。
    // 任务行落库即跨重启存活，不再依赖内存定时器与周期扫描兜底；
    // 同 (type,userId) 先删后插，重复采集开始天然覆盖上一条排程。
    if (this.delayedTaskService) {
      await this.delayedTaskService.schedule({
        type: 'gather',
        userId,
        runAt: now + cappedSeconds * 1000,
      });
    }

    this.logger.log(`玩家 ${userId} 开始采集 ${resourceName}，预计 ${cappedSeconds} 秒`);

    // ===== 原版 L11400-11416 回复文本：采集文本模板 + 预计耗时 =====
    // 模板占位符：【名称】=玩家名(+跟随宠物)、【载具】=载具名(此处无载具上下文，移除)、【武器】=当前武器名
    const rawGatherText = String(target.gatherText ?? target.采集文本 ?? '')
      || `【名称】正在${gatherName}`;
    let startText = rawGatherText.replace('【载具】', '');
    startText = startText.replace('【名称】', String(player.name ?? '冒险者'));
    startText = startText
      .replace('【武器】', String(currentWeapon?.name ?? '') || '拳头');
    return `${startText},大概需要${cappedSeconds}秒`;
    });
  }

  /**
   * 采集延时结算（对应原版「采j结s」分支 _主程序.ecode L6790-6806 + 采集资源 地图操作.ecode L1469-1639）。
   * 由进程内定时器或后台兜底任务调用：校验并移除「采集中」状态 → 结算产出/经验/任务/资源次数。
   * @returns 结算文本（广播到世界频道）；无进行中采集或已失效时返回空串
   */
  async settleGatherResource(userId: number): Promise<string> {
    // 采集结算按「读快照→改→整包写回」更新玩家数据，必须持用户级共享锁，
    // 与兑换/召唤/任务推进互斥；进程内定时器与 cron 兜底两条路径都经过这里。
    return this.playerService.enqueueUserWrite(userId, () => this.applySettleGatherResource(userId));
  }

  /** 采集结算的数据库读改写段（调用方需已持有用户级锁）。 */
  private async applySettleGatherResource(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const pending = this.takePendingGather(player, userId);
    if (!pending) return '';
    const { state: gatherState, markers } = pending;

    // 结算即解锁：移除「采集」锁定标记（原版 获得增益 到期语义；定时器回调可能早于毫秒级过期）
    const lockedMarkers2 = asJsonValue<any[]>(player.markers2, []);
    const unlockedMarkers2 = lockedMarkers2.filter((m: any) =>
      (m?.name ?? m?.名称 ?? m?.key) !== '采集');
    const markers2Changed = unlockedMarkers2.length !== lockedMarkers2.length;

    // 原子认领「采集中」状态：进程内定时器与每5秒兜底扫描是并发结算入口，
    // 结算链路（产出/任务/激怒怪物等）耗时可超过兜底间隔，重入方若读到同样
    // 的「采集中」状态会双结算（产出翻倍+重复广播）。
    // 认领必须走整包 savePlayer（中央乐观锁按 (id,version) CAS）：
    // - 不能用不携带 version 的定点条件写（updateMany）：乐观锁拦截器会给它
    //   注入 version+1，而内存快照版本没同步，链尾的整包保存必然 P2025 失败，
    //   整次结算半途而废；
    // - 定点写也不会使其它旧快照失效，持有旧 markers 的并发写者仍能通过自己
    //   的 CAS 把「采集中」原样写回复活（2026-08-26 线上重复结算事故根因）。
    // 整包 CAS 认领成功即推进版本并同步内存快照，链尾保存顺理成章；失败
    // （P2025 并发冲突）说明另一入口已在结算，本调用立即放弃并还原内存快照，
    // 标记仍留库中由下一轮兜底重试，不会丢结算。
    const prevMarkersRaw = player.markers;
    const prevMarkers2BeforeClaim = player.markers2;
    player.markers = markers; // Json 列直接写对象
    if (markers2Changed) player.markers2 = unlockedMarkers2; // Json 列直接写数组
    try {
      await this.playerService.savePlayer(player);
    } catch (e: any) {
      player.markers = prevMarkersRaw;
      if (markers2Changed) player.markers2 = prevMarkers2BeforeClaim;
      this.logger.warn(`玩家 ${userId} 采集认领失败（并发冲突或写库异常），本次放弃: ${e?.message || e}`);
      return '';
    }

    const gatherName = String(gatherState.cmd ?? '');
    const resourceName = String(gatherState.target ?? '');
    const extraMultiplier = Math.max(1, Number(gatherState.count ?? 1));

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) {
      player.markers = markers; // Json 列直接写对象
      await this.playerService.savePlayer(player);
      return '';
    }
    const resources = this.getGatherResources(map);
    const resourceField = this.getGatherResourceField(map);
    const markersRecord = markers;
    const target = resources.find((r: any) => r.gatherCmd === gatherName
      && this.getResourceTimes(r) !== 0
      && this.isGatherResourceAvailable(r, markersRecord));

    let specialText = '';
    // 特殊资源：休眠仓 → 首次打开触发「召唤白」剧情（原版 _主程序.ecode L9777~L9795）
    if ((resourceName === '休眠仓' || target?.proxySpeak === '召唤1白1') && !markers['召唤白']) {
      markers['召唤白'] = 1;
      specialText = '这里是哪里？\n(随着休眠仓被打开，锁着的门似乎也跟着一起解开了)';
      this.logger.log(`玩家 ${userId} 唤醒了白`);
      await this.taskService.acceptTask(userId, '主线-身世');
      // 原版 L9780-9796：白作为真实召唤物加入当前地图（归属=玩家、初始好感30、
      // 任务池=白对话），随玩家移动而跟随，是对话/领取任务/挤奶/救助/控制终端的实体。
      try {
        await this.materializeWhiteSummon(player, map, markers);
      } catch (e: any) {
        this.logger.warn(`创建白的召唤物失败 userId=${userId}: ${e?.message}`);
      }
    }
    player.markers = markers; // Json 列直接写对象

    if (!target) {
      // 资源在等待期间被别人采完/刷新掉：本次动作作废（不产出、不计次数）
      await this.playerService.savePlayer(player);
      this.logger.log(`玩家 ${userId} 采集结算时资源已消失: ${resourceName}`);
      return '';
    }

    // ===== 原版 地图操作.ecode L1537-1561 实际采集次数 =====
    // e=跟随宠物数+1，再乘以额外次数；受资源剩余次数上限约束。
    // 有限资源(times>0)夹到剩余次数（共享世界态，超管特权同样受限）；
    // 无限资源(times<0)默认单次动作上限=|times|——超管野外批量（adminBatch）放开该上限。
    const followPetCount = await this.countFollowingSummons(map, userId);
    let actualGatherCount = (followPetCount + 1) * extraMultiplier;
    const resourceTimes = this.getResourceTimes(target);
    actualGatherCount = resourceTimes > 0
      ? Math.min(actualGatherCount, resourceTimes)
      : (gatherState.adminBatch
        ? actualGatherCount
        : Math.min(actualGatherCount, Math.abs(resourceTimes)));

    const dropRate = this.getGatherDropRate(playerData);
    const outputs = this.parseResourceOutputs(target.outputs);
    const gained: string[] = [];
    const awarded = new Map<string, number>();
    const awardedEquipment = new Map<string, number>();
    const backpack = this.playerService.getBackpackItems(player);
    for (const out of outputs) {
      if (!out.name || out.name === '电力') continue;
      const chance = Number(out.chance);
      for (let i = 0; i < actualGatherCount; i++) {
        if (Number.isFinite(chance) && chance >= 0 && Math.random() * 100 >= chance * dropRate) continue;
        const parsed = this.parseResourceOutputName(out.name, Number(out.count));
        if (!parsed.name) continue;
        // 类型三分类（原版 地图操作.ecode L1583-1590）：装备生成词条；资源乘采集加成；
        // 其余（箱子等可使用功能物品，items.json 中带 useEffects 的条目）不乘加成——
        // 否则"良好装备补给箱×1.47"这类小数数量会入库（Issue #12-3）。
        const staticItem = typeof (this.staticData as any)?.getItemByName === 'function'
          ? (this.staticData as any).getItemByName(parsed.name)
          : undefined;
        const itemUseEffects = staticItem?.useEffects;
        const isUsableItem = Array.isArray(itemUseEffects)
          ? itemUseEffects.length > 0
          : Boolean(itemUseEffects);
        const itemType = this.staticData.getEquipmentByName(parsed.name)
          ? '装备'
          : isUsableItem
            ? '物品'
            : '资源';
        if (itemType === '装备') {
          const quality = parsed.quality || '';
          const equipment = await this.itemSystemService.generateRewardEquipment(parsed.name, quality);
          this.addBackpackItem(backpack, { ...equipment, type: '装备', quantity: 1, count: 1 });
          awardedEquipment.set(parsed.name, (awardedEquipment.get(parsed.name) || 0) + 1);
        } else {
          const amount = parsed.count > 0
            ? (itemType === '资源' ? parsed.count * this.getGatherMultiplier(playerData) : parsed.count)
            : Math.abs(parsed.count);
          if (amount > 0) awarded.set(parsed.name, (awarded.get(parsed.name) || 0) + amount);
        }
      }
    }
    for (const [itemName, amount] of awarded) {
      // 统一规范化合并（type 以静态定义为准，非装备按名合并，Issue #11）
      mergeBackpackItem(backpack, { name: itemName, type: '资源', count: amount, quantity: amount },
        lookupFromStaticData(this.staticData));
      gained.push(`${itemName}×${this.formatGatherNumber(amount)}`);
    }
    for (const [itemName, amount] of awardedEquipment) gained.push(`${itemName}×${amount}`);
    player.backpack = backpack; // Json 列直接写数组

    // 原版采集成功后会把资源自身的“标记”写入玩家永久标记，
    // 例如医疗箱、休眠仓和散落的物品每个玩家只能领取一次。
    const resourceMarker = String(target.marker ?? target.标记 ?? '').trim();
    if (resourceMarker && actualGatherCount > 0) {
      markers[resourceMarker] = Number(markers[resourceMarker] ?? 0) + 1;
      player.markers = markers; // Json 列直接写对象
    }

    let timesSuffix = '';
    if (resourceTimes > 0) {
      // mutateMapFields 锁内闭环：重读最新资源数组与 markers2 → 按名重定位目标 →
      // 用最新剩余次数夹取实际采集数 → 扣减次数/耗尽移除/登记刷新标记 → 差异写回
      // （避免并发采集把次数扣成负数、或按各自快照整组覆盖刷新标记）
      const gatherResult = await this.mapService.mutateMapFields(map.id, [resourceField, 'markers2'], (f) => {
        const fresh = f[resourceField] as any[];
        const idx = fresh.findIndex((r: any) => r.name === target.name);
        if (idx === -1) return { removed: true, remaining: 0 };
        const freshTarget = fresh[idx];
        const freshTimes = this.getResourceTimes(freshTarget);
        const count = freshTimes > 0 ? Math.min(actualGatherCount, freshTimes) : actualGatherCount;
        const remaining = freshTimes - count;
        if (remaining <= 0) {
          fresh.splice(idx, 1);
          // 原版"次数归零"会添加"刷新资源<名称>"地图标记，后台刷新任务按该标记恢复资源。
          if (freshTarget.renewable !== false) {
            const mapMarkers2 = Array.isArray(f.markers2) ? f.markers2 : [];
            const refreshedMarkers2 = mapMarkers2.filter((entry: any) =>
              (entry?.name ?? entry?.名称) !== `刷新资源${freshTarget.name}`,
            );
            refreshedMarkers2.push({
              name: `刷新资源${freshTarget.name}`,
              expireAt: Date.now() + 1800 * 1000,
              resourceField,
            });
            f.markers2 = refreshedMarkers2;
          }
          return { removed: true, remaining: 0 };
        }
        freshTarget.times = remaining;
        return { removed: false, remaining };
      });
      if (gatherResult.remaining > 0) {
        timesSuffix = `\n${map.name}的${resourceName}还可以采集${gatherResult.remaining}次`;
      }
    }
    await this.playerService.savePlayer(player);

    // ===== 经验与任务推进（原版 L1613-1616）=====
    const expBonus = this.getGatherExpBonus(playerData);
    const expGain = Math.round((Number(player.level ?? 1) / 2 + 1) * actualGatherCount * expBonus);
    await this.playerService.addExp(userId, expGain);
    if (actualGatherCount > 0) {
      await this.taskService.advance(userId, '采集', actualGatherCount);
      await this.taskService.advance(userId, gatherName, actualGatherCount);
      await this.taskService.advance(userId, '奴役', Math.max(0, actualGatherCount - 1));
    }
    for (const [itemName, amount] of awarded) {
      await this.taskService.advance(userId, '采集资源', amount);
      await this.taskService.advance(userId, `采集${itemName}`, amount);
    }
    for (const [itemName, amount] of awardedEquipment) {
      await this.taskService.advance(userId, '获得装备', amount);
      await this.taskService.advance(userId, `获得${itemName}`, amount);
    }
    // 原版 地图操作.ecode L1619：添加成就("采集熟练度", e, 玩家.标记)——
    // 熟练度按实际采集次数推进。advance 会改写库内任务/标记字段，
    // 先重载快照再写熟练度，避免旧对象回写覆盖任务结算。
    if (actualGatherCount > 0) {
      const freshPlayer = (await this.playerService.getPlayerData(userId)).player;
      const proficiencyMarkers = asJsonValue<Record<string, any>>(freshPlayer.markers, {});
      proficiencyMarkers['采集熟练度'] = Number(proficiencyMarkers['采集熟练度'] ?? 0) + actualGatherCount;
      freshPlayer.markers = proficiencyMarkers;
      await this.playerService.savePlayer(freshPlayer);
    }

    // 代发言=触发攻击：采集完成会激怒附近怪物
    // （原版 _主程序.ecode L11426：新建延时("覅攻击pd"+地图, "0", 群号, 5)——
    //   采集后5秒怪物回合开始并自动续回合。
    //   四豁免对齐原版 L11417-11426：隐形披风装备 / 隐匿模式增益（triggerMapBattleLoop
    //   内部处理） / 特殊序号15=四糸乃 / 等级<15）
    if (String(target.proxySpeak ?? target.代发言 ?? '') === '触发攻击' && !map.isInstance) {
      try {
        const fresh = await this.playerService.getPlayerData(userId);
        const freshEquipments = fresh.equipment || asJsonValue<any[]>(fresh.player.equipment, []);
        const freshWeapons = fresh.weapons || asJsonValue<any[]>(fresh.player.weapons, []);
        const hasCloak = this.combatState.equipRequire(freshEquipments, freshWeapons, Number(fresh.player.currentWeapon ?? 0), 26, '隐形披风', false);
        const isYoshino = Number(fresh.player.specialSeq ?? fresh.player.特殊序号 ?? 0) === 15;
        if (Number(fresh.player.level ?? 0) >= 15 && !hasCloak && !isYoshino) {
          await (this.combatSystem as any).triggerMapBattleLoop(userId, 5, { player: fresh.player, map });
        }
      } catch (e: any) {
        this.logger.warn(`采集激怒怪物失败 userId=${userId}: ${e?.message}`);
      }
    }

    // 代发言播报（原版 地图操作.ecode L1620-1621：代发言非空 → 新建延时(代发言+复活点, 2秒)）。
    // 代发言是资源配置的内部延时指令名：触发攻击已在上方激怒怪物路径处理，
    // 召唤1白1 已在采集入口内联召唤，其余（覅本清/覅下一层）按 2 秒延时排程执行并广播。
    {
      const proxySpeak = String(target.proxySpeak ?? target.代发言 ?? '');
      if (proxySpeak && proxySpeak !== '触发攻击' && proxySpeak !== '召唤1白1') {
        if (this.delayedTaskService) {
          await this.delayedTaskService.schedule({
            type: 'proxySpeak',
            userId,
            dedupeKey: `${userId}:${proxySpeak}`,
            runAt: Date.now() + 2 * 1000,
            payload: { command: proxySpeak },
          });
        }
      }
    }

    // ===== 结算文本（原版 L1598-1613：“收集到了…”）=====
    const lootText = gained.length > 0 ? `收集到了${gained.join('、')}` : '什么都没有收集到';
    const petPrefix = followPetCount > 0 ? `带着${followPetCount}只宠物一起` : '';
    let resultText = `${player.name}${petPrefix}${lootText},得到了${expGain}经验`;
    if (specialText) resultText = `${specialText}\n${resultText}`;
    if (timesSuffix) resultText += timesSuffix;
    // 采集推进导致的任务完成提示（原版 发放奖励 前插“完成了任务:…”块）。
    // 延时结算不在指令管道内，必须在这里主动取出，否则通知滞留队列丢失。
    const gatherTaskNotice = this.taskService.consumeNotifications(userId);
    if (gatherTaskNotice) resultText = `${gatherTaskNotice}\n————————\n${resultText}`;

    // 延时端结果通过世界频道系统消息送达（指令回复通道覆盖不到定时器回调），
    // 同时推送玩家/地图面板（背包、资源次数变化）。
    await this.chatService.broadcastSystem('世界频道', resultText, userId).catch(() => undefined);
    try {
      await this.pushPlayerUpdate(userId);
      await this.pushMapUpdate(userId);
    } catch { /* 推送失败不影响结算 */ }
    return resultText;
  }

  /**
   * 提取玩家的「采集中」状态（存在且返回；调用方负责写回）。
   * 无状态时顺带清理孤儿「采集」锁定标记。
   */
  private takePendingGather(
    player: any,
    userId: number,
  ): { state: Record<string, any>; markers: Record<string, any> } | null {
    const markers = asJsonValue<Record<string, any>>(player.markers, {});
    const rawState = markers['采集中'];
    if (!rawState) {
      this.clearStaleGatherLock(player, userId);
      return null;
    }
    let state: any = rawState;
    if (typeof rawState === 'string') {
      // 「采集中」嵌套值可能是对象或旧存档 JSON 字符串，统一容错解析
      state = asJsonValue<Record<string, any> | null>(rawState, null);
    }
    if (!state || typeof state !== 'object' || !state.target) {
      delete markers['采集中'];
      player.markers = markers; // Json 列直接写对象
      this.clearStaleGatherLock(player, userId);
      return null;
    }
    delete markers['采集中'];
    return { state, markers };
  }

  /** 清理孤儿「采集」锁定标记（无对应采集中状态时的兜底，避免玩家被永久锁死）。 */
  private clearStaleGatherLock(player: any, userId: number): void {
    try {
      const markers2 = asJsonValue<any[]>(player.markers2, []);
      const filtered = markers2.filter((m: any) => (m?.name ?? m?.名称 ?? m?.key) !== '采集');
      if (filtered.length !== markers2.length) {
        player.markers2 = filtered; // Json 列直接写数组
        void this.playerService.savePlayer(player).catch(() => undefined);
        this.logger.log(`清理玩家 ${userId} 的孤儿采集锁定标记`);
      }
    } catch { /* 忽略清理失败 */ }
  }

  /**
   * 统计跟随玩家的存活召唤物数量（原版 召唤物跟随显示 数据显示.ecode L326-395：
   * 归属=玩家QQ 且 标记["跟随"]熟练度<1 视为跟随中）。
   */
  private async countFollowingSummons(map: any, userId: number): Promise<number> {
    try {
      const raw = map?.summons ?? map?.召唤物 ?? [];
      const summons = Array.isArray(raw) ? raw : asJsonValue<any[]>(raw, []);
      const playerKey = String(userId);
      return summons.filter((s: any) => {
        const owner = String(s?.ownerQQ ?? s?.归属 ?? s?.owner ?? s?.qq ?? '');
        if (owner !== playerKey) return false;
        const hp = Number(s?.hp ?? s?.当前生命 ?? 1);
        if (hp <= 0) return false;
        let summonMarkers: any = s?.markers ?? s?.标记 ?? {};
        if (!Array.isArray(summonMarkers) && typeof summonMarkers === 'string') {
          summonMarkers = asJsonValue<any>(summonMarkers, {});
        }
        const prof = Array.isArray(summonMarkers)
          ? Number(summonMarkers.find((m: any) => (m?.name ?? m?.名称) === '跟随')?.value ?? 0)
          : Number(summonMarkers?.['跟随'] ?? 0);
        return prof < 1;
      }).length;
    } catch {
      return 0;
    }
  }

  /** 采集经验加成系数（原版 1 + 属性.经验/100） */
  private getGatherExpBonus(playerData: any): number {
    try {
      const bonus = this.combatSystem.buildAttackerBonus(playerData.player, playerData) as any;
      return 1 + Math.max(0, Number(bonus?.经验 ?? 0)) / 100;
    } catch {
      return 1;
    }
  }

  /** 兼容新格式与早期错误导出的 resources JSON。 */
  /** 过渡期公开（P3-2 HomeBuildService 经门面引用调用） */
  parseResourceOutputs(value: any): any[] {
    const outputs = Array.isArray(value)
      ? value
      : asJsonValue<any[]>(value, []);
    if (!Array.isArray(outputs)) return [];
    return outputs.map((output: any) => {
      if (!output || typeof output !== 'object') return output;

      // 早期导出把“木头3，100”写成 {name:"木头3", count:100}。
      // 名称末尾数字是数量，旧 count 才是概率；没有紧凑数量时概率默认100%。
      const rawName = String(output.name ?? output.名称 ?? '').trim();
      const rawCount = Number(output.count ?? output.quantity ?? output.数量 ?? 0);
      const hasChance = output.chance !== undefined || output.几率 !== undefined;
      const compact = rawName.replace(/[edcbasx]$/i, '').match(/-?\d+(?:\.\d+)?$/);
      return {
        ...output,
        name: rawName,
        count: Number.isFinite(rawCount) ? rawCount : 0,
        chance: hasChance
          ? Number(output.chance ?? output.几率 ?? 0)
          : (compact ? rawCount : 100),
      };
    });
  }

  /**
   * 解析资源的采集指令：条目自带 gatherCmd 优先，缺失时回退到全局资源列表的同名定义。
   *
   * 事故背景（2026-09-06）：定时任务掉落货舱/能量元素时只写入了 {name,type,amount}
   * 字面量，缺 gatherCmd；观察附近照样给它编了号，但 cmd 为空 → 编号不注册 →
   * 玩家发送编号后完全没有反应（连"未知指令"提示都没有）。
   * 这里做兜底：只要资源名能在全局资源表里找到，编号就一定点得动。
   */
  private resolveGatherCmd(resource: any): string {
    return this.supportSvc.resolveGatherCmd(resource);
  }

  private getGatherResources(map: any): any[] {
    const resources = asJsonValue<any[]>(map?.resources, []);
    if (resources.length > 0) return resources;
    return asJsonValue<any[]>(map?.resources2, []);
  }

  private getGatherResourceField(map: any): 'resources' | 'resources2' {
    const resources = asJsonValue<any[]>(map?.resources, []);
    return resources.length > 0 ? 'resources' : 'resources2';
  }

  private isGatherResourceAvailable(resource: any, markers: Record<string, any>): boolean {
    const marker = String(resource?.marker ?? resource?.标记 ?? '').trim();
    if (!marker) return true;
    return Number(markers[marker] ?? 0) < 1;
  }

  /** 获取玩家永久标记(markers)对象，用于资源采集门禁的"每人一次"判断。 */
  private async getPlayerMarkers(userId: number): Promise<Record<string, any>> {
    try {
      const { player } = await this.playerService.getPlayerData(userId);
      return asJsonValue<Record<string, any>>(player?.markers, {});
    } catch {
      return {};
    }
  }

  /** 产出2（作物/建筑的生产产出）是否非空；产出2为空的资源2条目即地上的野生资源。 */
  private hasOutputs2(resource: any): boolean {
    const raw = resource?.outputs2 ?? resource?.['产出2'];
    if (Array.isArray(raw)) return raw.length > 0;
    if (raw == null || raw === '') return false;
    const parsed = asJsonValue<any[]>(raw, []);
    return Array.isArray(parsed) && parsed.length > 0;
  }

  private parseResourceOutputName(rawName: any, rawCount: number): { name: string; count: number; quality: string } {
    const source = String(rawName ?? '').trim();
    const qualityMatch = source.match(/^(.*?)([edcbasx])$/i);
    const quality = qualityMatch ? qualityMatch[2].toLowerCase() : '';
    const withoutQuality = qualityMatch ? qualityMatch[1] : source;
    const compact = withoutQuality.match(/^(.*?)(-?\d+(?:\.\d+)?)$/);
    if (!compact) return { name: withoutQuality, count: quality ? 0 : Number(rawCount) || 0, quality };
    return {
      name: compact[1].trim(),
      // 旧 JSON 把概率写进 count；只要名称仍带紧凑数量，就以名称中的数量为准。
      count: Number(compact[2]),
      quality,
    };
  }

  private getResourceTimes(resource: any): number {
    const value = Number(resource?.times ?? resource?.次数 ?? -1);
    return Number.isFinite(value) ? value : -1;
  }

  private parseGatherCommand(value: string): { name: string; count: number } {
    const input = String(value || '').trim();
    const match = input.match(/^(.*?)(\d+)$/);
    if (!match) return { name: input, count: 1 };
    return { name: match[1].trim(), count: Math.max(1, Number(match[2])) };
  }

  private getGatherMultiplier(playerData: any): number {
    const bonus = this.combatSystem.buildAttackerBonus(playerData.player, playerData);
    return Math.max(0, Number(bonus.采集 || 100) / 100);
  }

  private getGatherDropRate(playerData: any): number {
    const bonus = this.combatSystem.buildAttackerBonus(playerData.player, playerData);
    return Math.max(0, 1 + Number(bonus.掉落率 || 0) / 100);
  }

  private formatGatherNumber(value: number): string {
    return this.supportSvc.formatGatherNumber(value);
  }

  /**
   * 赠予物品
   * 将背包中的物品赠予其他玩家
   */
  async handleGive(userId: number, targetQQ: string, itemName: string, count: number): Promise<string>{
    return this.shopTradeServiceSvc.handleGive(userId, targetQQ, itemName, count);
  }
  async handlePrivateChat(userId: number, targetName: string, content: string): Promise<string>{
    return this.questDialogueServiceSvc.handlePrivateChat(userId, targetName, content);
  }
  async handleFeedback(userId: number, raw: string): Promise<string>{
    return this.questDialogueServiceSvc.handleFeedback(userId, raw);
  }
  async handleAcceptQuest(userId: number, questName?: string): Promise<string>{
    return this.questDialogueServiceSvc.handleAcceptQuest(userId, questName);
  }
  private parseNpcMarkers(unit: any): Record<string, any>{
    return this.questDialogueServiceSvc.parseNpcMarkers(unit);
  }
  private getQuestSources(units: any[]): QuestSource[]{
    return this.questDialogueServiceSvc.getQuestSources(units);
  }
  private splitQuestNames(value: any): string[]{
    return this.questDialogueServiceSvc.splitQuestNames(value);
  }
  private questUnitName(unit: any): string{
    return this.questDialogueServiceSvc.questUnitName(unit);
  }
  async handleViewQuests(userId: number, selector = ''): Promise<string>{
    return this.questDialogueServiceSvc.handleViewQuests(userId, selector);
  }
  async handleCompleteQuest(userId: number, questName: string): Promise<string>{
    return this.questDialogueServiceSvc.handleCompleteQuest(userId, questName);
  }
  async handleLieDown(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = player.name || '冒险者';

    // 检查是否死亡
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    // 行动无限制（原版 L7089 理由6：自动开采中可以躺下）
    const restriction = this.combatSystem.actionUnrestricted(player, { ignoreReason: 6 });
    if (restriction.restricted) return restriction.text;

    // 建筑要求（床）（原版 L7092-7093）
    if (!(await this.hasBuildingOnMap(userId, '床'))) {
      return `${name}需要床`;
    }

    // 陪睡宠物（原版 躺下起床显示：跟随显示数量上限2）
    const map = await this.mapService.getMapById(player.mapId);
    const display = await this.summonFollowDisplay(map, userId, { requireFollow: false, countLimit: 2 });
    const sleepover = display.count;
    const summons = Array.isArray(map?.summons) ? map.summons : asJsonValue<any[]>(map?.summons, []);
    const hasLuo = this.familiarService.checkHasSpecialPet(-4, summons);
    const luoPet = hasLuo
      ? summons.find((s: any) => (s?.specialSeq ?? s?.special_seq ?? s?.seq) === -4)
      : null;

    // 写入 陪睡 数（原版 L305-310：有洛为负数=有鹭）
    const sets = asJsonValue<any>(player.sets, {});
    sets.sleepover = hasLuo ? -sleepover : sleepover;
    player.sets = sets;

    // 置“躺下”标记（原版 L7093 置成就熟练度("躺下",1)）
    const markers = asJsonValue<Record<string, any>>(player.markers, {});
    markers['躺下'] = 1;
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 躺下了（陪睡${sleepover}${hasLuo ? '，有洛' : ''}）`);

    // 躺下起床显示(1)（原版 数据显示.ecode L299-311）
    const expBonus = Number(player.expBonus ?? 0);
    const level = Number(player.level ?? 1);
    let text = `${name}${display.count > 0 ? `和${display.names.join('和')}` : ''}躺到了床上`;
    text += `\n每秒获得经验:${this.round2Text(level / 100)}`;
    text += `\n你的经验加成:${this.round2Text(expBonus)}%`;
    text += `\n陪睡NPC/宠物:${sleepover}/2（+${sleepover * 50}%）`;
    if (luoPet) text += `\n${luoPet.name ?? luoPet.名称 ?? '洛'}:+10%`;
    const finalPerSec = (1 + sleepover * 0.5) * level * (1 + expBonus / 100) / 100 * (1 + (hasLuo ? 1 : 0) / 10);
    text += `\n最终每秒获得:${Math.round(finalPerSec)}`;
    return text;
  }

  /**
   * 起床（原版 _主程序.ecode L7102-7108）。
   * “躺下”标记==0 →“需要「躺下」”；清标记后回复 躺下起床显示(2)。
   */
  async handleGetUp(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const name = player.name || '冒险者';

    // 检查是否在躺下（原版 L7103 取成就熟练度("躺下")==0 →“需要”躺下”“）
    if (markers['躺下'] !== 1) {
      return `${name}需要“躺下”`;
    }

    // 移除躺下标记（原版 L7105 置成就熟练度("躺下",0)）
    delete markers['躺下'];

    // 保存标记到玩家数据
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 起床了`);

    // 躺下起床显示(2)（原版 数据显示.ecode L293：跟随显示(2) +“从床上爬了起来”）
    const map = await this.mapService.getMapById(player.mapId);
    const display = await this.summonFollowDisplay(map, userId, { requireFollow: false, countLimit: 2 });
    return `${name}${display.count > 0 ? `和${display.names.join('和')}` : ''}从床上爬了起来`;
  }

  /**
   * 玩家设置
   * 查看/修改个人设置，设置存储在 markers 中
   * 对应原版：_主程序.ecode 中「设置」指令
   *
   * 改造：
   * - 移除随机数、背景音乐、自动购物（已脱离用户可设置范围）
   * - 使用活力、自动采集改为管理员全局设置，用户侧只读展示
   * - 新手指引永远开启（用户侧不允许关闭）
   */
  async handleSettings(userId: number, settingName?: string, settingValue?: string): Promise<string>{
    return this.questDialogueServiceSvc.handleSettings(userId, settingName, settingValue);
  }
  private async toggleSetting( userId: number, key: string, onValue: number, offValue: number, onText: string, offText: string, ): Promise<string>{
    return this.questDialogueServiceSvc.toggleSetting(userId, key, onValue, offValue, onText, offText);
  }
  async handleSettingsGuide(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleSettingsGuide(userId);
  }
  async handleSettingsRandom(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleSettingsRandom(userId);
  }
  async handleSettingsGather(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleSettingsGather(userId);
  }
  async handleSettingsVitality(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleSettingsVitality(userId);
  }
  async handleSettingsNoHelp(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleSettingsNoHelp(userId);
  }
  async handleSettingsMusic(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleSettingsMusic(userId);
  }
  async handleSettingsMultiplier(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleSettingsMultiplier(userId);
  }
  async handleSettingsShop(userId: number, value?: string): Promise<string>{
    return this.questDialogueServiceSvc.handleSettingsShop(userId, value);
  }
  async handleSettingsLocation(userId: number, value?: string): Promise<string>{
    return this.questDialogueServiceSvc.handleSettingsLocation(userId, value);
  }
  async handleSettingsMarker(userId: number, value?: string): Promise<string>{
    return this.questDialogueServiceSvc.handleSettingsMarker(userId, value);
  }
  async handleStartDungeon(userId: number, dungeonName = ''): Promise<string>{
    return this.dungeonChallengeServiceSvc.handleStartDungeon(userId, dungeonName);
  }
  async handleRefreshDungeon(userId: number, dungeonName = ''): Promise<string>{
    return this.dungeonChallengeServiceSvc.handleRefreshDungeon(userId, dungeonName);
  }
  getSlotLimit(vehicle: any, partType: number): { slots: number; max: number; name: string } {
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
  /** 过渡期公开（P3-2 HomeBuildService 经门面引用调用） */
  calcVehicleTotalBonus(vehicle: any): any {
    // 解析载具基础加成
    const baseBonus = asJsonValue<any>(vehicle.bonus, {});
    // 解析已安装的部件列表
    const parts = asJsonValue<any[]>(vehicle.parts, []);

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

  /** 解析载具运行时 JSON，兼容 DB 字符串和地图 JSON 对象。 */
  private parseVehicleValue<T>(value: any, fallback: T): T {
    if (Array.isArray(value) || (value && typeof value === 'object')) return value as T;
    if (typeof value !== 'string' || !value.trim()) return fallback;
    return asJsonValue<T>(value, fallback);
  }

  /** 将 DB/地图载具转换为原版中文字段运行时结构。 */
  /** 过渡期公开（P3-4 DungeonChallengeService 经门面引用调用；P3-6 内核合并后改为直接注入） */
  toRuntimeVehicle(raw: any): any {
    const normalizeItem = (item: any): any => {
      const name = String(item?.名称 ?? item?.name ?? '');
      const quantity = Number(item?.数量 ?? item?.quantity ?? item?.count ?? 1);
      const durability = Number(item?.耐久 ?? item?.durability ?? 100);
      return {
        ...(item || {}),
        名称: name,
        name: item?.name ?? name,
        类型: item?.类型 ?? item?.type ?? '资源',
        type: item?.type ?? item?.类型 ?? '资源',
        数量: Number.isFinite(quantity) ? quantity : 0,
        quantity: item?.quantity ?? item?.count ?? (Number.isFinite(quantity) ? quantity : 0),
        耐久: Number.isFinite(durability) ? durability : 100,
        durability: item?.durability ?? (Number.isFinite(durability) ? durability : 100),
      };
    };
    const normalizeRecipe = (recipe: any): any => {
      const name = String(recipe?.名称 ?? recipe?.name ?? '');
      const value = Number(recipe?.数值 ?? recipe?.value ?? recipe?.production ?? recipe?.count ?? 0);
      return {
        ...(recipe || {}),
        名称: name,
        name: recipe?.name ?? name,
        数值: Number.isFinite(value) ? value : 0,
        value: recipe?.value ?? (Number.isFinite(value) ? value : 0),
      };
    };
    const parts = this.parseVehicleValue<any[]>(raw?.零件 ?? raw?.parts, []);
    const recipes = this.parseVehicleValue<any[]>(raw?.配方 ?? raw?.recipes, []);
    const bonus = this.parseVehicleValue<any>(raw?.加成 ?? raw?.bonus, {});
    const markers2 = this.parseVehicleValue<any[]>(raw?.标记2 ?? raw?.markers2, []);
    const currentHp = Number(raw?.当前生命 ?? raw?.currentHp ?? raw?.hp ?? 0);
    const maxHp = Number(raw?.生命 ?? raw?.maxHp ?? 0);
    const slotStatus = Number(raw?.上限 ?? raw?.slotStatus ?? 0);
    const moveType = Number(raw?.行走方式 ?? raw?.moveType ?? 0);
    return {
      ...(raw || {}),
      名称: String(raw?.名称 ?? raw?.name ?? ''),
      name: raw?.name ?? raw?.名称 ?? '',
      类型: String(raw?.类型 ?? raw?.type ?? ''),
      type: raw?.type ?? raw?.类型 ?? '',
      编号: String(raw?.编号 ?? raw?.vehicleId ?? raw?.id ?? ''),
      vehicleId: raw?.vehicleId ?? raw?.编号 ?? raw?.id ?? '',
      归属: String(raw?.归属 ?? raw?.owner ?? ''),
      owner: raw?.owner ?? raw?.归属 ?? '',
      驾驶员: String(raw?.驾驶员 ?? raw?.driver ?? ''),
      driver: raw?.driver ?? raw?.驾驶员 ?? '',
      当前生命: Number.isFinite(currentHp) ? currentHp : 0,
      currentHp: Number.isFinite(currentHp) ? currentHp : 0,
      生命: Number.isFinite(maxHp) ? maxHp : 0,
      maxHp: Number.isFinite(maxHp) ? maxHp : 0,
      上限: Number.isFinite(slotStatus) ? slotStatus : 0,
      slotStatus: Number.isFinite(slotStatus) ? slotStatus : 0,
      行走方式: Number.isFinite(moveType) ? moveType : 0,
      moveType: Number.isFinite(moveType) ? moveType : 0,
      零件: Array.isArray(parts) ? parts.map(normalizeItem) : [],
      配方: Array.isArray(recipes) ? recipes.map(normalizeRecipe) : [],
      加成: bonus && typeof bonus === 'object' ? bonus : {},
      标记2: Array.isArray(markers2) ? markers2 : [],
    };
  }

  /** 将原版中文运行时字段写回兼容的中英文载具对象。 */
  /** 过渡期公开（P3-4 DungeonChallengeService 经门面引用调用；P3-6 内核合并后改为直接注入） */
  toStoredVehicle(runtime: any): any {
    const parts = (runtime.零件 || []).map((item: any) => ({
      ...(item || {}),
      名称: item?.名称 ?? item?.name ?? '',
      name: item?.name ?? item?.名称 ?? '',
      类型: item?.类型 ?? item?.type ?? '资源',
      type: item?.type ?? item?.类型 ?? '资源',
      数量: Number(item?.数量 ?? item?.quantity ?? item?.count ?? 0),
      quantity: Number(item?.quantity ?? item?.数量 ?? item?.count ?? 0),
      耐久: Number(item?.耐久 ?? item?.durability ?? 100),
      durability: Number(item?.durability ?? item?.耐久 ?? 100),
    }));
    const recipes = (runtime.配方 || []).map((recipe: any) => ({
      ...(recipe || {}),
      名称: recipe?.名称 ?? recipe?.name ?? '',
      name: recipe?.name ?? recipe?.名称 ?? '',
      数值: Number(recipe?.数值 ?? recipe?.value ?? 0),
      value: Number(recipe?.value ?? recipe?.数值 ?? 0),
    }));
    const bonus = runtime.加成 || {};
    const markers2 = runtime.标记2 || [];
    return {
      ...(runtime || {}),
      名称: runtime.名称 ?? runtime.name ?? '',
      name: runtime.name ?? runtime.名称 ?? '',
      编号: runtime.编号 ?? runtime.vehicleId ?? runtime.id ?? '',
      vehicleId: runtime.vehicleId ?? runtime.编号 ?? runtime.id ?? '',
      类型: runtime.类型 ?? runtime.type ?? '',
      type: runtime.type ?? runtime.类型 ?? '',
      归属: runtime.归属 ?? runtime.owner ?? '',
      owner: runtime.owner ?? runtime.归属 ?? '',
      驾驶员: runtime.驾驶员 ?? runtime.driver ?? '',
      driver: runtime.driver ?? runtime.驾驶员 ?? '',
      当前生命: Number(runtime.当前生命 ?? runtime.currentHp ?? 0),
      currentHp: Number(runtime.currentHp ?? runtime.当前生命 ?? 0),
      生命: Number(runtime.生命 ?? runtime.maxHp ?? 0),
      maxHp: Number(runtime.maxHp ?? runtime.生命 ?? 0),
      上限: Number(runtime.上限 ?? runtime.slotStatus ?? 0),
      slotStatus: Number(runtime.slotStatus ?? runtime.上限 ?? 0),
      行走方式: Number(runtime.行走方式 ?? runtime.moveType ?? 0),
      moveType: Number(runtime.moveType ?? runtime.行走方式 ?? 0),
      零件: parts,
      parts,
      配方: recipes,
      recipes,
      加成: bonus,
      bonus,
      标记2: markers2,
      markers2,
    };
  }

  private vehicleDbData(runtime: any): Record<string, any> {
    const stored = this.toStoredVehicle(runtime);
    return {
      name: stored.name,
      vehicleId: String(stored.vehicleId || ''),
      type: stored.type,
      owner: String(stored.owner || ''),
      driver: String(stored.driver || ''),
      moveType: Number(stored.moveType || 0),
      maxHp: Number(stored.maxHp || 0),
      currentHp: Number(stored.currentHp || 0),
      slotStatus: Number(stored.slotStatus || 0),
      bonus: stored.bonus || {},
      parts: stored.parts || [],
      markers2: stored.markers2 || [],
      recipes: stored.recipes || [],
    };
  }

  /** 持久化生产结算后的载具；地图 JSON 和 GameVehicle 共用同一运行时结构。 */
  private async persistRuntimeVehicle(source: any, runtime: any): Promise<void> {
    if (source.kind === 'db') {
      await this.prisma.gameVehicle.update({
        where: { id: source.db.id },
        data: this.vehicleDbData(runtime),
      });
      return;
    }
    const vehicles = this.parseVehicleValue<any[]>(source.map?.vehicles, []);
    if (source.index == null || source.index < 0 || source.index >= vehicles.length) return;
    vehicles[source.index] = this.toStoredVehicle(runtime);
    await this.mapService.updateDynamicFields(source.map.id, {
      vehicles,
    });
  }

  /** 根据玩家驾驶/接管状态寻找当前可操作载具。 */
  private async findProductionVehicle(userId: number, player: any, currentMap: any): Promise<any | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const ownerIds = new Set([
      String(userId), String(player?.userId ?? ''), String(user?.qqNumber ?? ''),
      String(user?.externalId ?? ''), String(player?.masterQQ ?? ''),
    ].filter(Boolean));
    const sets = this.parseVehicleValue<any>(player?.sets, {});
    const takeover = String(sets?.takeVehicle ?? sets?.接管载具 ?? '');
    const requested = takeover || String(player?.vehicle ?? '');

    const matchUnit = (unit: any, key: string): boolean => {
      const ids = [unit?.编号, unit?.vehicleId, unit?.id, unit?.name, unit?.名称]
        .filter((value) => value !== undefined && value !== null)
        .map(String);
      if (key && ids.includes(key)) return true;
      const driver = String(unit?.驾驶员 ?? unit?.driver ?? '');
      return !key && ownerIds.has(driver);
    };
    const mapSource = (map: any, index: number): any => {
      const vehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
      const raw = vehicles[index];
      if (!raw) return null;
      return { kind: 'map', map, index, raw, runtime: this.toRuntimeVehicle(raw) };
    };

    const findDbVehicle = async (key: string): Promise<any | null> => {
      const numericId = Number(key);
      let db = Number.isInteger(numericId) && numericId > 0
        ? await this.prisma.gameVehicle.findUnique({ where: { id: numericId } })
        : null;
      if (!db && key) {
        db = await this.prisma.gameVehicle.findFirst({
          where: { OR: [{ vehicleId: key }, { name: key }] },
        });
      }
      return db;
    };

    const currentVehicles = this.parseVehicleValue<any[]>(currentMap?.vehicles, []);

    // 当前玩家.vehicle 是数据库载具主键时优先读取 GameVehicle；接管状态仍按原版优先查地图 JSON。
    // 这样旧地图中的同编号载具不会劫持新数据库载具的生产命令。
    if (!takeover && requested) {
      const db = await findDbVehicle(requested);
      if (db) return { kind: 'db', db, runtime: this.toRuntimeVehicle(db), map: currentMap };
    }

    let index = currentVehicles.findIndex((unit) => matchUnit(unit, requested));
    if (index >= 0) return mapSource(currentMap, index);

    // 接管载具可能暂时不在玩家所在地图；原版会全图检索并自动清理失效接管状态。
    if (takeover) {
      const maps = await this.mapService.getAllMaps();
      for (const map of maps) {
        if (map.id === currentMap?.id) continue;
        const vehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
        index = vehicles.findIndex((unit) => matchUnit(unit, takeover));
        if (index >= 0) return mapSource(map, index);
      }
    }

    const db = requested ? await findDbVehicle(requested) : null;
    if (!db && !requested) {
      const candidates = await this.prisma.gameVehicle.findMany({ orderBy: { id: 'asc' } });
      const owned = candidates.find((vehicle) => ownerIds.has(String(vehicle.driver)) || ownerIds.has(String(vehicle.owner)));
      if (owned) return { kind: 'db', db: owned, runtime: this.toRuntimeVehicle(owned), map: currentMap };
    }
    if (db) return { kind: 'db', db, runtime: this.toRuntimeVehicle(db), map: currentMap };
    return null;
  }

  private vehicleProductionOptions(map: any, vehicle: any): { yongxing: number; lannBaby: boolean } {
    const summons = this.parseVehicleValue<any[]>(map?.summons, []);
    const driver = String(vehicle?.驾驶员 ?? vehicle?.driver ?? '');
    const driverSummon = summons.find((summon: any) =>
      [summon?.QQ, summon?.qq, summon?.编号, summon?.id].filter(Boolean).map(String).includes(driver),
    );
    const seq = (summon: any): number => Number(
      summon?.活力 ?? summon?.vitality ?? summon?.特殊序号 ?? summon?.specialSeq ?? 0,
    );
    return {
      // 原版常量：咏星特殊序号=-27，兰音幼崽特殊序号=-30。
      yongxing: driverSummon && seq(driverSummon) === -27 ? 0.15 : 0,
      lannBaby: summons.some((summon: any) => seq(summon) === -30),
    };
  }

  private formatVehicleItems(items: any[]): string {
    const values = (items || []).filter((item: any) => Number(item?.quantity ?? item?.数量 ?? 0) !== 0);
    if (values.length === 0) return '无';
    return values.map((item: any) => {
      const name = item?.name ?? item?.名称 ?? '';
      const quantity = Number(item?.quantity ?? item?.数量 ?? 0);
      return `${name}x${this.round2Text(quantity)}`;
    }).join('、');
  }

  private formatVehicleTime(seconds: number): string {
    if (seconds === 86400.12345678) return '时间无限，显示一天的产量';
    return formatSecondsDurationText(seconds, 'fullUnits');
  }

  /**
   * 载具生产命令。
   * 对应原版 _主程序.ecode L10929-11222，以及物品操作.ecode L2612-2954。
   */
  async handleVehicleProduction(userId: number, argument = ''): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${player.name || '冒险者'}不在服务区`;

    let command = String(argument || '').trim();
    if (command.startsWith('生产')) command = command.substring(2).trim();
    if (!command) {
      return [
        `${player.name || '冒险者'},这是一个高级功能，上手难度较高，你应该先完成[教程]系列任务和[进阶]系列任务再来尝试。`,
        `“生产生肉分解1 5.2”来为当前驾驶的载具输入[生肉分解1]这个配方，并且把5.2的生产力分配给这个配方。可以输入负数来减少生产力。`,
        `“生产排序2 3”来调整两个配方的先后顺序。`,
        `“生产排序插入12 3”来把第12个配方在排序上插入到3的位置。`,
        `“生产限制资源箱10000”来对[资源箱]这种产物进行限制，输入0移除。`,
        `“生产配平5”来让载具其他配方自动根据消耗进行生产力分配。`,
        `产出的物品会存放于载具内，配方需要消耗的材料直接放入载具内即可。`,
        `载具生命为0时也可以生产，但是有部件超出容许安装限制时无法生产。`,
        `生产所需的配方可以发送“配方”来获取。`,
        `载具的核心不是生产类载具的核心时，生产力降低75%。`,
        `1、配方    2、查看产物`,
      ].join('\n');
    }

    const source = await this.findProductionVehicle(userId, player, map);
    if (!source) {
      const sets = this.parseVehicleValue<any>(player.sets, {});
      const takeover = String(sets?.takeVehicle ?? sets?.接管载具 ?? '');
      if (takeover) {
        sets.takeVehicle = '';
        sets.接管载具 = '';
        player.sets = sets;
        await this.playerService.savePlayer(player);
        return `${player.name || '冒险者'}由于你之前接管的载具${takeover}不在世界上，已自动停止接管`;
      }
      return `${player.name || '冒险者'}必须“驾驶”或者“接管”载具之后才能执行此操作`;
    }

    const runtime = source.runtime;
    const productionBonus = this.achievementService.getAchievement(playerData.markers, '生产');
    // 接管载具可能来自其他地图；兰音幼崽/咏星状态应从载具所在地图读取。
    const productionMap = source.kind === 'map'
      ? source.map
      : (Number(source.db?.mapIndex || 0) > 0
        ? await this.mapService.getMapById(Number(source.db.mapIndex))
        : map);
    const productionOptions = this.vehicleProductionOptions(productionMap || map, runtime);
    const timestamp = Date.now();
    const production = this.combatSystem.produceVehicle(
      runtime,
      timestamp,
      productionBonus,
      map.id,
      productionOptions,
    );

    // 生产结算必须先持久化，后续生产限制/排序/配方设置才不会覆盖已结算的时间戳。
    await this.persistRuntimeVehicle(source, runtime);

    // 原版实际产出同时推进「生产」成就和按物品拆分的任务要求。
    const producedByName = new Map<string, number>();
    for (const item of production.produced) {
      const name = String(item.name || '');
      const quantity = Number(item.quantity || 0);
      if (name && quantity > 0) producedByName.set(name, (producedByName.get(name) || 0) + quantity);
    }
    if (producedByName.size > 0) {
      const markers = playerData.markers || {};
      const total = [...producedByName.values()].reduce((sum, value) => sum + value, 0);
      this.achievementService.setAchievement(
        markers,
        '生产',
        this.achievementService.getAchievement(markers, '生产') + total,
      );
      player.markers = markers;
      await this.playerService.savePlayer(player);
      for (const [name, quantity] of producedByName) {
        await this.taskService.advance(userId, `生产${name}`, quantity);
        await this.taskService.advance(userId, '生产', quantity);
      }
    }

    const playerName = player.name || '冒险者';
    if (Number(runtime.加成?.生产 || 0) === 0) {
      return `${playerName},${runtime.名称}没有生产力，你可以组装生产线，或者使用专门的生产类载具。专门的生产类载具效率更高`;
    }
    if (runtime.上限 > 1) {
      return `${playerName},${runtime.名称}有部件超出了容许安装限制，无法正常运作`;
    }

    if (command === '0') {
      if (runtime.配方.length < 2) {
        return `${playerName}你尚未对${runtime.名称}输入配方\n“生产生肉分解1 5.2”来为当前驾驶的载具输入[生肉分解1]这个配方，并且把5.2的生产力分配给这个配方。`;
      }
      const recipeLines = runtime.配方.slice(1).map((recipe: any, index: number) => {
        const def = this.staticData.getVehicleRecipeByName(recipe.名称);
        const level = Number(def?.level ?? def?.等级 ?? 0);
        return `${index + 1}、${recipe.名称}(${level}级) ${this.round2Text(Number(recipe.数值 || 0))}生产力`;
      });
      const speedPercent = production.consumedProductivity > Number(runtime.加成.生产 || 0)
        ? production.productionSpeed * production.efficiency * 100
        : production.productionSpeed * 100;
      const lines = [
        `${playerName},${runtime.名称}的生产线:`,
        ...recipeLines,
        `◆生产力${this.round2Text(production.consumedProductivity)}/${this.round2Text(Number(runtime.加成.生产 || 0))},可生产${this.formatVehicleTime(production.availableTime)}`,
        `◆生产速度${this.round2Text(speedPercent)}%${production.byproductMultiplier !== 1 ? `,副产物+${this.round2Text((production.byproductMultiplier - 1) * 100)}%` : ''}${production.consumptionMultiplier !== 1 ? `,消耗-${this.round2Text((1 - production.consumptionMultiplier) * 100)}%` : ''}`,
        `◆每分钟消耗:${this.formatVehicleItems(production.consumptionPerMinute)}`,
        `◆每分钟产出:${this.formatVehicleItems(production.outputPerMinute)}`,
        `◆消耗+产出:${this.formatVehicleItems(production.combinedPerMinute)}`,
      ];
      if (production.availableTime > 0 && production.availableTime !== 86400.12345678) {
        lines.push(`◆最终产物:${this.formatVehicleItems(production.combinedPerMinute.map((item) => ({
          ...item,
          quantity: Number(item.quantity || 0) * production.availableTime / 60,
        })))}`);
      }
      const missing = production.combinedPerMinute
        .filter((item) => Number(item.quantity || 0) < 0 &&
          this.itemQuantity((runtime.零件 || []).find((part: any) => (part.名称 ?? part.name) === item.name)) <= 0)
        .length > 0;
      if (missing) lines.push('【缺少部分物品导致无法生产，你可以手动把物品组装到载具上】');
      await this.persistRuntimeVehicle(source, runtime);
      return lines.join('\n');
    }

    if (command === '1') {
      const sets = this.parseVehicleValue<any>(player.sets, {});
      const scientist = Number(sets?.scientist ?? sets?.科学家 ?? 0);
      if (scientist < 4) return `${playerName}需要装备科学家外套/裙子/手套以及白色丝袜`;
      if (runtime.配方.length < 2) return `${playerName}${runtime.名称}未输入配方`;
      const markers2 = playerData.markers2 || [];
      const cooldownText = { value: '' };
      const cooling = this.combatState.timeIntervalRequire(
        '生产1',
        36000,
        markers2,
        timestamp,
        cooldownText,
        timestamp,
      );
      player.markers2 = markers2;
      if (cooling) {
        await this.playerService.savePlayer(player);
        return `${playerName}${cooldownText.value}`;
      }
      runtime.配方[0].数值 = Number(runtime.配方[0].数值 || timestamp) - 3600 * 1000;
      await this.persistRuntimeVehicle(source, runtime);
      await this.playerService.savePlayer(player);
      return `${playerName},${runtime.名称}的时间加速流逝了一小时`;
    }

    if (command.startsWith('限制')) {
      const payload = command.substring(2).trim();
      const numberMatch = payload.match(/[-+]?\d+(?:\.\d+)?/);
      const productName = payload.replace(/[-+]?\d+(?:\.\d+)?/g, '').trim();
      if (!productName) {
        return `“生产限制资源箱10000.2”来对[资源箱]这种产物进行限制，载具内物品数量达到目标后不会继续生产；输入0移除`;
      }
      const limit = Math.max(0, numberMatch ? Number(numberMatch[0]) : 0);
      const limitName = `生产限制${productName}`;
      const parts = runtime.零件 || [];
      const existingIndex = parts.findIndex((part: any) => (part.名称 ?? part.name) === limitName);
      if (existingIndex >= 0) {
        if (limit === 0) {
          parts.splice(existingIndex, 1);
          await this.persistRuntimeVehicle(source, runtime);
          return `${playerName},移除了${productName}的生产限制`;
        }
        parts[existingIndex].名称 = limitName;
        parts[existingIndex].name = limitName;
        parts[existingIndex].数量 = limit;
        parts[existingIndex].quantity = limit;
      } else if (limit > 0) {
        parts.push({ 名称: limitName, name: limitName, 类型: '资源', type: '资源', 数量: limit, quantity: limit, 耐久: 100, durability: 100 });
      } else {
        return `${playerName},移除了${productName}的生产限制`;
      }
      await this.persistRuntimeVehicle(source, runtime);
      return `${playerName},${productName}的生产限制被设置为${limit}`;
    }

    if (command.startsWith('配平')) {
      const payload = command.substring(2).trim();
      let recipeNumber = Number(payload);
      if (!/^\d+$/.test(payload)) {
        const actualIndex = runtime.配方.findIndex((recipe: any, index: number) => index > 0 && recipe.名称 === payload);
        recipeNumber = actualIndex > 0 ? actualIndex : 0;
      }
      const recipeCount = Math.max(0, runtime.配方.length - 1);
      if (!recipeNumber) return `${playerName}“生产配平5”或者“生产配平木头分解1”来配平`;
      if (recipeNumber < 1 || recipeNumber > recipeCount) {
        return `${playerName},${runtime.名称}只有${recipeCount}个配方，输入的值超范围或者小于1:${recipeNumber}`;
      }
      const target = runtime.配方[recipeNumber];
      const targetDef = this.staticData.getVehicleRecipeByName(target.名称);
      const targetInputs = this.parseVehicleValue<any[]>(targetDef?.消耗 ?? targetDef?.inputs, []);
      const productionView = this.combatSystem.calculateVehicleProduction(runtime, timestamp, productionOptions);
      const messages: string[] = [`${runtime.名称}\n配方${target.名称}x${this.round2Text(Number(target.数值 || 0))}`];
      for (const input of targetInputs) {
        const inputName = input?.名称 ?? input?.name ?? '';
        const inputQty = Number(input?.数量 ?? input?.quantity ?? 0);
        const inputDurability = Number(input?.耐久 ?? input?.durability ?? 100) / 100;
        const need = inputQty * inputDurability * Number(target.数值 || 0)
          * productionView.consumptionMultiplier * productionView.efficiency * productionView.productionSpeed;
        let matched = false;
        for (let index = 1; index < runtime.配方.length; index++) {
          if (index === recipeNumber) continue;
          const other = runtime.配方[index];
          const otherDef = this.staticData.getVehicleRecipeByName(other.名称);
          const outputs = this.parseVehicleValue<any[]>(otherDef?.产出 ?? otherDef?.outputs, []);
          const output = outputs.find((item: any) => (item?.名称 ?? item?.name) === inputName);
          if (!output) continue;
          const outputQty = Number(output.数量 ?? output.quantity ?? 0);
          const outputDurability = Number(output.耐久 ?? output.durability ?? 100) / 100;
          const perProduction = outputQty * (outputDurability < 1 ? outputDurability * productionView.byproductMultiplier : 1)
            * productionView.efficiency * productionView.productionSpeed;
          if (perProduction <= 0) continue;
          other.数值 = need / perProduction;
          other.value = other.数值;
          messages.push(`配方${other.名称}产出${inputName}，生产力调整为${this.round2Text(other.数值)}`);
          matched = true;
        }
        if (!matched) messages.push(`没有其他产出${inputName}的配方`);
      }
      await this.persistRuntimeVehicle(source, runtime);
      return messages.join('\n');
    }

    if (command.startsWith('排序')) {
      const insertMatch = command.match(/^排序插入\s*(\d+)\s+(\d+)$/);
      const swapMatch = command.match(/^排序\s*(\d+)\s+(\d+)$/);
      const recipeCount = Math.max(0, runtime.配方.length - 1);
      if (insertMatch) {
        const from = Number(insertMatch[1]);
        const to = Number(insertMatch[2]);
        if (from < 1 || from > recipeCount || to < 1 || to > recipeCount || from === to) {
          return `${playerName},${runtime.名称}只有${recipeCount}个配方，或者你输入的值不符合规范(小于1或者相等)\n${from} ${to}`;
        }
        const moved = runtime.配方.splice(from, 1)[0];
        runtime.配方.splice(to, 0, moved);
        await this.persistRuntimeVehicle(source, runtime);
        await this.taskService.advance(userId, '生产排序');
        return `${playerName},${runtime.名称}的配方[${moved.名称}]移动到了${to}号`;
      }
      if (swapMatch) {
        const first = Number(swapMatch[1]);
        const second = Number(swapMatch[2]);
        if (first < 1 || second < 1 || first > recipeCount || second > recipeCount || first === second) {
          return `${playerName},${runtime.名称}只有${recipeCount}个配方，或者你输入的值不符合规范(小于1或者相等)\n${first} ${second}`;
        }
        const temp = runtime.配方[first];
        runtime.配方[first] = runtime.配方[second];
        runtime.配方[second] = temp;
        await this.persistRuntimeVehicle(source, runtime);
        await this.taskService.advance(userId, '生产排序');
        return `${playerName},${runtime.名称}的配方[${runtime.配方[second].名称}]和[${runtime.配方[first].名称}]交换了位置`;
      }
      return `${playerName}\n“生产排序2 3”来调整两个配方的先后顺序。“生产排序插入12 3”来把第12个配方插入到3的位置。`;
    }

    const recipeInput = command.split(/\s+/).filter(Boolean);
    if (recipeInput.length !== 2) {
      return `${playerName}你输入的数据不正确，请检查：${command}`;
    }
    const recipeName = recipeInput[0];
    const allocation = Number(recipeInput[1]);
    const unlocked = this.parseVehicleValue<any>(player.recipes, []);
    const unlockedNames = Array.isArray(unlocked)
      ? unlocked.map((recipe: any) => String(recipe?.名称 ?? recipe?.name ?? recipe))
      : Object.keys(unlocked || {}).filter((key) => Number(unlocked[key]) !== 0);
    if (!unlockedNames.includes(recipeName) || !this.staticData.getVehicleRecipeByName(recipeName)) {
      return `${playerName}你尚未解锁这个配方，或者输入的配方不存在：${recipeName}`;
    }
    if (!Number.isFinite(allocation)) {
      return `${playerName}你输入的数据不正确，请检查：${command}`;
    }
    if (runtime.配方.length === 0) runtime.配方.push({ 名称: '1', name: '1', 数值: timestamp, value: timestamp });
    this.combatState.addAchievement(recipeName, allocation, runtime.配方 as any);
    const current = runtime.配方.find((recipe: any) => recipe.名称 === recipeName);
    const currentValue = Number(current?.数值 || 0);
    const view = this.combatSystem.calculateVehicleProduction(runtime, timestamp, productionOptions);
    await this.persistRuntimeVehicle(source, runtime);
    await this.taskService.advance(userId, '设置生产配方');
    const currentOutput = view.combinedPerMinute.filter((item) => Number(item.quantity || 0) !== 0);
    return `${playerName}为${runtime.名称}设置了${recipeName}\n它当前占用的生产力为${this.round2Text(currentValue)}\n${runtime.名称}当前产出:${this.formatVehicleItems(currentOutput)}`;
  }

  /**
   * 原版“安装”统一入口：生产建筑放院子，功能建筑放屋内；非建筑则安装到载具。
   */
  async handleInstall(userId: number, rawName: string): Promise<string>{
    return this.homeBuildServiceSvc.handleInstall(userId, rawName);
  }
  private async handleInstallHomeFuel(userId: number, requestedCount: number): Promise<string>{
    return this.homeBuildServiceSvc.handleInstallHomeFuel(userId, requestedCount);
  }
  private async handleAssembleBuilding(userId: number, buildingName: string, count = 1): Promise<string>{
    return this.homeBuildServiceSvc.handleAssembleBuilding(userId, buildingName, count);
  }
  async handleInstallPart(userId: number, partName: string, count = 1): Promise<string>{
    return this.homeBuildServiceSvc.handleInstallPart(userId, partName, count);
  }
  async handleUninstallPart(userId: number, partName: string, count = 1): Promise<string>{
    return this.homeBuildServiceSvc.handleUninstallPart(userId, partName, count);
  }
  private async tryUninstallHomeBuilding( userId: number, player: any, map: any, buildingName: string, requestedCount: number, ): Promise<string | null>{
    return this.homeBuildServiceSvc.tryUninstallHomeBuilding(userId, player, map, buildingName, requestedCount);
  }
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
    const parts = asJsonValue<any[]>(vehicle.parts, []);
    const totalBonus = asJsonValue<any>(vehicle.bonus, {});

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
        const typeName = this.supportSvc.PART_TYPE_NAMES[part.partType] || '未知';
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
      { key: '攻击', label: '攻击' },
      { key: '生命', label: '生命' },
      { key: '装甲', label: '装甲' },
      { key: '护盾', label: '护盾' },
      { key: '速度', label: '速度' },
      { key: '闪避', label: '闪避' },
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
   * 对应原版 _主程序.ecode L2077-2163：在家园前线生成一轮地精攻势，
   * 写入 GameMonster，生成/刷新前线防御召唤物，并开启前线活动状态。
   */
  async handleStartBattle(userId: number): Promise<string>{
    return this.dungeonChallengeServiceSvc.handleStartBattle(userId);
  }
  async handleSweep(userId: number, requestedCount = 0): Promise<string>{
    return this.dungeonChallengeServiceSvc.handleSweep(userId, requestedCount);
  }
  private async handleSweepInner(userId: number, requestedCount: number): Promise<string>{
    return this.dungeonChallengeServiceSvc.handleSweepInner(userId, requestedCount);
  }
  private parseSweepMonsterNames(map: any): string[]{
    return this.dungeonChallengeServiceSvc.parseSweepMonsterNames(map);
  }
  private getSweepRequirement(playerData: any, monsterNames: string[]): { text: string; unmet: boolean }{
    return this.dungeonChallengeServiceSvc.getSweepRequirement(playerData, monsterNames);
  }
  private buildSweepRequirementText(playerData: any, monsterNames: string[]): string{
    return this.dungeonChallengeServiceSvc.buildSweepRequirementText(playerData, monsterNames);
  }
  async handleDodge(userId: number): Promise<string>{
    return this.dungeonChallengeServiceSvc.handleDodge(userId);
  }
  private hasEquip(player: any, name: string): boolean {
    return this.supportSvc.hasEquip(player, name);
  }

  /**
   * 写入/覆盖 markers2 增益标记（对应原版 获得增益/添加标记）
   * @param markers2 增益数组（就地修改）
   * @param name 标记名
   * @param expireAt 到期时间戳（秒）
   * @param strength 强度（可选）
   */
  private setMarkers2(markers2: any[], name: string, expireAt: number, strength?: number): void {
    this.supportSvc.setMarkers2(markers2, name, expireAt, strength);
  }

  // ========== 玩家信息命令 ==========

  /**
   * 处理资源背包命令
   * 从背包中筛选资源、材料、消耗品类型物品，输出格式与「背包」列表同构（见函数末尾注释）
   */
  async handleResourceBag(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const items = this.playerService.getBackpackItems(player);

    // 筛选非装备类的物品（资源、物品、材料、消耗品等——type 已由静态定义规范化，
    // 材料类在 items.json 中的规范 type 为「物品」，Issue #11）
    const resourceItems = items.filter((item: any) => {
      const type = (item.type || '').toLowerCase();
      return type === '资源' || type === '物品' || type === '材料' || type === '消耗品' || type === '弹药' || type === '素材';
    });

    if (resourceItems.length === 0) {
      return '📦 你的资源背包是空的，当前没有资源、材料或消耗品';
    }

    // 输出格式与「背包」列表完全同构（🎒 标题 + 「N. 名字 ×数量」行）：
    // 前端 RichSystemCard 的背包网格解析与 ChatView isRichCardContent 按同一文本约定复用，
    // 资源背包不设第二套解析分支（统一调用约定，禁止双重表示）。
    // 数量口径与 handleInventory 一致走 itemQuantity（quantity/count 双字段兜底），
    // 禁用旧的 count||quantity 读取（addToBackpack 历史路径只写 count 并 delete quantity）。
    // 文本契约（RVW04 P2-8）：标题 `🎒 资源背包 (N种):` 与物品行 `N. 名字 ×数量` 的解析正则
    // 定义在 web/src/components/RichSystemCard.vue parseLayout 背包分支
    //（/^🎒\s*(?:资源)?背包\s*\(\d+(?:种)?\)/ 与 /^(\d+)\.\s*(.+?)\s*×\s*([\d.]+)\s*$/），
    // server/test/inventory-display.spec.ts 契约测试同步锁定；改动须服务端、前端正则、契约测试三处一起改。
    const lines = resourceItems.map((item: any, index: number) => {
      const itemName = item.name || item.名称 || '未知物品';
      const count = Math.round(this.itemQuantity(item) * 100) / 100;
      return `${index + 1}. ${itemName} ×${count}`;
    });

    return `🎒 资源背包 (${resourceItems.length}种):\n${lines.join('\n')}`;
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
        // 数量读取必须走 quantity/count 双字段兜底（与 背包 列表的 itemQuantity 同口径）：
        // addToBackpack 历史路径只写 count 并 delete quantity，直接读 item.quantity 会
        // 得到 undefined → 显示 ×0（实证：能量块 ×486.55 搜索显示 ×0）
        lines.push(`  ${item.name} ×${formatDisplayNumber(this.itemQuantity(item))} [${item.type || '资源'}]`);
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
        // 同 背包搜索：quantity/count 双字段兜底，防 addToBackpack 单 count 存量显示 ×0
        lines.push(`  ${item.name} ×${formatDisplayNumber(this.itemQuantity(item))} [${item.type || '资源'}]`);
      }
    }
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`共找到 ${matchedItems.length} 个匹配物品`);

    return lines.join('\n');
  }

  /**
   * 查看已装备的装备/武器详情（对应原版 _主程序.ecode L5596 `查看装备/查看武器`）
   * 支持两种用法：
   *   - 无参数：列出身上已装备的装备/武器清单
   *   - 带参数（序号或名称）：查看指定装备/武器的详细属性
   * 原版按 `查看装备`/`查看武器` 区分查找武器栏或装备栏，此处同样区分。
   * @param userId 玩家ID
   * @param arg 参数（空=列表，否则为序号或装备名）
   * @param kind 装备类型：'武器' 查玩家.weapons，其他查玩家.equipment
   * @returns 查看结果文本
   */
  async handleViewEquip(userId: number, arg: string, kind: '武器' | '装备'): Promise<string>{
    return this.equipCommandServiceSvc.handleViewEquip(userId, arg, kind);
  }
  async handleViewSafe(userId: number, arg: string): Promise<string>{
    return this.equipCommandServiceSvc.handleViewSafe(userId, arg);
  }
  async handleCompareEquip(userId: number, targetName: string, compareName: string): Promise<string>{
    return this.equipCommandServiceSvc.handleCompareEquip(userId, targetName, compareName);
  }
  async handlePassiveEffects(userId: number): Promise<string>{
    return this.equipCommandServiceSvc.handlePassiveEffects(userId);
  }
  async handleHandbook(userId: number, arg: string): Promise<string>{
    return this.questDialogueServiceSvc.handleHandbook(userId, arg);
  }
  async handleSwitchWeapon(userId: number, weaponName: string): Promise<string>{
    return this.equipCommandServiceSvc.handleSwitchWeapon(userId, weaponName);
  }
  async handleEnhanceImplant(userId: number, target: string): Promise<string>{
    return this.equipCommandServiceSvc.handleEnhanceImplant(userId, target);
  }
  async handleViewImplant(userId: number): Promise<string>{
    return this.equipCommandServiceSvc.handleViewImplant(userId);
  }
  async handleSwitchImplant(userId: number, implantName: string): Promise<string>{
    return this.equipCommandServiceSvc.handleSwitchImplant(userId, implantName);
  }
  async handleResetImplant(userId: number): Promise<string>{
    return this.equipCommandServiceSvc.handleResetImplant(userId);
  }
  async handleViewAmplifier(userId: number): Promise<string>{
    return this.equipCommandServiceSvc.handleViewAmplifier(userId);
  }
  async handleSwitchAmplifier(userId: number, amplifierName: string): Promise<string>{
    return this.equipCommandServiceSvc.handleSwitchAmplifier(userId, amplifierName);
  }
  async handleEnhanceAmplifier(userId: number, target: string): Promise<string>{
    return this.equipCommandServiceSvc.handleEnhanceAmplifier(userId, target);
  }
  async handleResetAmplifier(userId: number): Promise<string>{
    return this.equipCommandServiceSvc.handleResetAmplifier(userId);
  }
  async handleAlchemy(userId: number, recipeName: string, count = 1): Promise<string>{
    return this.fusionCraftServiceSvc.handleAlchemy(userId, recipeName, count);
  }
  async handleMerge(userId: number, targetName: string, fusionArgs: string[] = []): Promise<string>{
    return this.fusionCraftServiceSvc.handleMerge(userId, targetName, fusionArgs);
  }
  private async fusionHelpText(userId: number): Promise<string>{
    return this.fusionCraftServiceSvc.fusionHelpText(userId);
  }
  private async handleFusion23(userId: number, backpackNumber: number, args: string[]): Promise<string>{
    return this.fusionCraftServiceSvc.handleFusion23(userId, backpackNumber, args);
  }
  private async activateFusionEffectWithoutArtisan(player: any, backpack: any[], item: any): Promise<string>{
    return this.fusionCraftServiceSvc.activateFusionEffectWithoutArtisan(player, backpack, item);
  }
  private async handleFusion23WangDamage(player: any, backpack: any[], sourceIndex: number, wangNumber: number): Promise<string>{
    return this.fusionCraftServiceSvc.handleFusion23WangDamage(player, backpack, sourceIndex, wangNumber);
  }
  private async handleFusion23SelectedEffect( userId: number, player: any, backpack: any[], index: number, item: any, mode: string, ): Promise<string>{
    return this.fusionCraftServiceSvc.handleFusion23SelectedEffect(userId, player, backpack, index, item, mode);
  }
  private hasFusionArtisan(map: any): boolean{
    return this.fusionCraftServiceSvc.hasFusionArtisan(map);
  }
  private isFusionAmplifier(item: any): boolean{
    return this.fusionCraftServiceSvc.isFusionAmplifier(item);
  }
  private fusionHasEffect(item: any): boolean{
    return this.fusionCraftServiceSvc.fusionHasEffect(item);
  }
  /** 过渡期公开（P2-8 ShopTradeService 经门面引用调用；实体已在 FusionCraftService，可后续改为直接注入） */
  isFusionWeapon(item: any): boolean{
    return this.fusionCraftServiceSvc.isFusionWeapon(item);
  }
  private getFusionEffects(item: any): Array<{ id: number; row: any }>{
    return this.fusionCraftServiceSvc.getFusionEffects(item);
  }
  private randomFusionEffectId(item: any): number{
    return this.fusionCraftServiceSvc.randomFusionEffectId(item);
  }
  private fusionDataParts(item: any): { prefix: string; segments: string[] }{
    return this.fusionCraftServiceSvc.fusionDataParts(item);
  }
  private rewriteFusionData(item: any, prefix?: string, effect?: number): string{
    return this.fusionCraftServiceSvc.rewriteFusionData(item, prefix, effect);
  }
  private setFusionBonus(item: any, code: string, value: number): string{
    return this.fusionCraftServiceSvc.setFusionBonus(item, code, value);
  }
  private upgradeFusionData(item: any): string{
    return this.fusionCraftServiceSvc.upgradeFusionData(item);
  }
  private correctFusionAttributes(item: any): boolean{
    return this.fusionCraftServiceSvc.correctFusionAttributes(item);
  }
  async handleForge(userId: number, itemName: string, count = 1): Promise<string>{
    return this.fusionCraftServiceSvc.handleForge(userId, itemName, count);
  }
  async handleBreed(userId: number, targetName: string): Promise<string>{
    return this.fusionCraftServiceSvc.handleBreed(userId, targetName);
  }
  async handleFamiliarSkills(userId: number): Promise<string>{
    return this.skillCommandServiceSvc.handleFamiliarSkills(userId);
  }
  async handleCommonSkills(userId: number): Promise<string>{
    return this.skillCommandServiceSvc.handleCommonSkills(userId);
  }
  private skillLevelInfo( markers: Record<string, any>, name: string, ): { level: number; text: string }{
    return this.skillCommandServiceSvc.skillLevelInfo(markers, name);
  }
  async handleFamiliarTitles(userId: number): Promise<string>{
    return this.skillCommandServiceSvc.handleFamiliarTitles(userId);
  }
  async handleClaimTitle(userId: number, titleName: string): Promise<string>{
    return this.skillCommandServiceSvc.handleClaimTitle(userId, titleName);
  }
  async handleEquipTitle(userId: number, titleName: string): Promise<string>{
    return this.skillCommandServiceSvc.handleEquipTitle(userId, titleName);
  }
  async handleFamiliarRank(userId: number, subtype = ''): Promise<string>{
    return this.rankingServiceSvc.handleFamiliarRank(userId, subtype);
  }
  private isRankablePlayer(p: any): boolean{
    return this.rankingServiceSvc.isRankablePlayer(p);
  }
  private async collectPlayerMarkerEntries( key: string, options: { excludeZero?: boolean } = {}, ): Promise<Array<{ name: string; value: number }>>{
    return this.rankingServiceSvc.collectPlayerMarkerEntries(key, options);
  }
  private handleCombatPowerRanking(requesterName: string): Promise<string>{
    return this.rankingServiceSvc.handleCombatPowerRanking(requesterName);
  }
  private async handleLevelRanking(requesterName: string): Promise<string>{
    return this.rankingServiceSvc.handleLevelRanking(requesterName);
  }
  private async handleTheoreticalDamageRanking(requesterName: string): Promise<string>{
    return this.rankingServiceSvc.handleTheoreticalDamageRanking(requesterName);
  }
  private handleMaxDamageRanking(requesterName: string): Promise<string>{
    return this.rankingServiceSvc.handleMaxDamageRanking(requesterName);
  }
  private handleKillCountRanking(requesterName: string): Promise<string>{
    return this.rankingServiceSvc.handleKillCountRanking(requesterName);
  }
  private handleOnlineTimeRanking(requesterName: string): Promise<string>{
    return this.rankingServiceSvc.handleOnlineTimeRanking(requesterName);
  }
  private async handlePetRanking(requesterName: string, kind: '战斗力' | '最高伤害'): Promise<string>{
    return this.rankingServiceSvc.handlePetRanking(requesterName, kind);
  }
  private secondsToTimeText(seconds: number): string {
    return this.supportSvc.secondsToTimeText(seconds);
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
    return this.rankingServiceSvc.recordRankingStats(userId);
  }
  async handleRanking(userId: number, type: string): Promise<string>{
    return this.rankingServiceSvc.handleRanking(userId, type);
  }
  private async handleWealthRanking(requesterName: string): Promise<string>{
    return this.rankingServiceSvc.handleWealthRanking(requesterName);
  }
  private async handleVehicleValueRanking(requesterName: string): Promise<string>{
    return this.rankingServiceSvc.handleVehicleValueRanking(requesterName);
  }
  private pushVehicleParts(target: any[], vehicle: any): void{
    this.supportSvc.pushVehicleParts(target, vehicle);
  }
  private formatRankingText( requesterName: string, title: string, entries: Array<{ name: string; value: number }>, valueText?: (value: number) => string, ): string{
    return this.rankingServiceSvc.formatRankingText(requesterName, title, entries, valueText);
  }
  async handleMassSummon(userId: number, count: string): Promise<string>{
    return this.petCommandServiceSvc.handleMassSummon(userId, count);
  }
  async handleReviveFamiliar(userId: number): Promise<string>{
    return this.rescueWhiteServiceSvc.handleReviveFamiliar(userId);
  }
  private async beginSelfRescue(userId: number, player: any, markers2: any[]): Promise<string>{
    return this.rescueWhiteServiceSvc.beginSelfRescue(userId, player, markers2);
  }
  async handleEaseAngel(userId: number, targetName?: string): Promise<string>{
    return this.skillCommandServiceSvc.handleEaseAngel(userId, targetName);
  }
  async handleGospel(userId: number, targetName?: string): Promise<string>{
    return this.skillCommandServiceSvc.handleGospel(userId, targetName);
  }
  async handleApocalypse(userId: number): Promise<string>{
    return this.skillCommandServiceSvc.handleApocalypse(userId);
  }
  async handleSwitchMode(userId: number, modeName: string): Promise<string>{
    return this.skillCommandServiceSvc.handleSwitchMode(userId, modeName);
  }
  async handleNanoSuit(userId: number, action: string): Promise<string>{
    return this.skillCommandServiceSvc.handleNanoSuit(userId, action);
  }
  async handleArmorCombine(userId: number, armorName?: string): Promise<string>{
    return this.skillCommandServiceSvc.handleArmorCombine(userId, armorName);
  }
  async handleFamiliarChallenge(userId: number): Promise<string>{
    return this.dungeonChallengeServiceSvc.handleFamiliarChallenge(userId);
  }
  async handleStartChallenge(userId: number): Promise<string>{
    return this.dungeonChallengeServiceSvc.handleStartChallenge(userId);
  }
  async familiarChallengeNextLayer(userId: number): Promise<string>{
    return this.dungeonChallengeServiceSvc.familiarChallengeNextLayer(userId);
  }
  async handleLookAround(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 解析地图各字段
    const monsters = await this.mapService.getMapMonsters(map);
    // 资源展示与采集门禁保持一致：过滤已采完(times=0)与当前玩家已领取过(marker)的资源，
    // 避免"观察附近列表里有、实际打不开"的观感（原版医疗箱/休眠仓为每人一次的常驻资源）。
    const playerMarkers = asJsonValue<Record<string, any>>(player.markers, {});
    const resources = asJsonValue<any[]>(map.resources, [])
      .filter((r: any) => this.getResourceTimes(r) !== 0 && this.isGatherResourceAvailable(r, playerMarkers));
    const items = asJsonValue<any[]>(map.items, []);
    const npcs = asJsonValue<any[]>(map.npcs, []);
    // 对齐原版 地图操作.ecode 观察附近（L628-971）：全文只有一张统一编号列表
    // （"b、名称" 逐项叠加 + w2 输入替换），可前往/资源/拾取/NPC 不再单独分段重复展示，
    // 编号列表即显示本体；仅编号列表覆盖不了的信息（怪物 HP 详情）保留为附加信息块。
    const quickOptions: { label: string; cmd: string }[] = [];
    const SEP = `━━━━━━━━━━━━━━━`;

    const lines: string[] = [
      `👀 【${map.name}】附近情况`,
      SEP,
    ];

    // 怪物信息（原版观察附近不展示普通野怪，HP 详情作为编号列表之外的附加信息块保留）
    if (monsters.length > 0) {
      lines.push(`👾 怪物 (${monsters.length}只):`);
      for (const m of monsters) {
        const hpPercent = m.maxHp > 0 ? Math.round((m.hp / m.maxHp) * 100) : 0;
        // 显示取整，避免出现 HP:13.13679525036632 这种浮点尾巴
        lines.push(`  ${m.name} Lv.${m.level} HP:${Math.round(m.hp)}/${Math.round(m.maxHp)}(${hpPercent}%)`);
      }
    }

    // 可前往（原版 L656-684：直接编入编号列表，N@前往名）
    const connections = this.mapService.getConnections(map) || [];
    for (const connection of connections) {
      if (!connection?.name) continue;
      quickOptions.push({ label: connection.name, cmd: `前往 ${connection.name}` });
    }

    // 资源（编入编号列表；无采集指令的仅展示，不生成快捷编号）
    // 兑现「开挖地基/建造地基」提示的承诺（观察附近可查看剩余次数）：
    // times>0 的资源标注剩余可采次数；times<0（无限，如医疗箱）不标。
    const timesLabel = (r: any): string => {
      const times = this.getResourceTimes(r);
      return times > 0 ? `(剩${times}次)` : '';
    };
    for (const r of resources) {
      const amount = r.amount ? ` ×${formatDisplayNumber(r.amount)}` : '';
      quickOptions.push({ label: `${r.name || '未知'}${amount}${timesLabel(r)}`, cmd: this.resolveGatherCmd(r) });
    }

    // 运行时资源2（对应原版 地图操作.ecode L862-893：观察附近列出产出2为空的地上资源——
    // 掉落货舱、家园院子的土堆/杂草等；作物/建筑产出2非空，走「查看作物」「查看建筑」）。
    // 教程文案（使魔大战.txt L3975）即要求玩家观察附近来发现院子里的杂草和土堆。
    const gatherPool = this.getGatherResources(map);
    // getGatherResources 在 map.resources 为空时回退到 resources2——此时采集可见集与
    // groundResources 同源，同源去重会把院子土堆/杂草全部误删（2026-09-09 巅峰阁事故）。
    // 去重仅在 resources 非空（采集可见集与 resources2 异源）时生效。
    const hasStaticResources = asJsonValue<any[]>(map.resources, []).length > 0;
    const groundResources = asJsonValue<any[]>(map.resources2, [])
      .filter((r: any) => !this.hasOutputs2(r)
        && this.getResourceTimes(r) !== 0
        && this.isGatherResourceAvailable(r, playerMarkers))
      // 采集链路（getGatherResources）在 resources 非空时只读 resources。
      // resources2 中与采集可见集同名的条目不再重复编号，避免出现
      //「列表里有、点下去采不到」的僵尸条目（2026-09-06 货舱/能量元素事故）。
      .filter((r: any) => !hasStaticResources || !gatherPool.some((g: any) =>
        String(g?.name ?? g?.名称 ?? '').trim() === String(r?.name ?? r?.名称 ?? '').trim()));
    for (const r of groundResources) {
      const amount = r.amount ? ` ×${formatDisplayNumber(r.amount)}` : '';
      quickOptions.push({ label: `${r.name || '未知'}${amount}${timesLabel(r)}`, cmd: this.resolveGatherCmd(r) });
    }

    // 地上物品（原版 L838-842：折叠为「拾取(N个物品)」单条入口，拾取前不展示明细）
    if (items.length > 0) {
      quickOptions.push({ label: `拾取(${items.length}个物品)`, cmd: '拾取' });
    }

    // NPC（静态 NPC 直接编入编号列表）
    for (const npc of npcs) {
      if (!npc?.name) continue;
      quickOptions.push({ label: String(npc.name), cmd: `对话 ${npc.name}` });
    }

    // 宠物/召唤物信息（对应原版 地图操作.ecode L685-805 观察附近）：
    // ≤6个逐个编入列表并可@对话；>6个折叠为一条「宠物(N个)」入口跳转「查看宠物」。
    const summons = asJsonValue<any[]>(map.summons, []);
    if (summons.length > 0) {
      // 玩家归属标识集合（原版 归属==玩家.QQ 过滤特殊宠物"白"，仅主人可见）
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      const ownerIds = new Set([
        String(userId),
        String(player.id),
        String(user?.qqNumber || ''),
        String(user?.externalId || ''),
        String(player.masterQQ || ''),
      ].filter(Boolean));

      const nameOf = (s: any): string => String(s?.name ?? s?.名称 ?? '') || '未知';
      const qqOf = (s: any): string => String(s?.qq ?? s?.QQ ?? '');
      const hpOf = (s: any): number => Number(s?.currentHp ?? s?.当前生命 ?? s?.hp ?? 0);
      const isMonsterSummon = (s: any): boolean => qqOf(s).startsWith('怪物');
      const markerVal = (unit: any, markerName: string): number => {
        const raw = unit?.markers ?? unit?.标记 ?? {};
        const parsed = typeof raw === 'string' ? asJsonValue<any>(raw, {}) : raw;
        if (Array.isArray(parsed)) {
          const item = parsed.find((x: any) => (x?.name ?? x?.名称) === markerName);
          return Number(item?.value ?? item?.数值 ?? item?.count ?? 0);
        }
        return Number(parsed?.[markerName] ?? 0);
      };
      // 特殊NPC（原版 L712-720：npc1g神之工匠/npc2小雫、露娜、行商固定[!]；小白狐/花园宝宝首次出现标[!]）
      const isFixedSpecialNpc = (s: any): boolean =>
        ['npc1g', 'npc2g', '怪物露娜1g'].includes(qqOf(s)) || ['行商'].includes(nameOf(s));
      const isDedupableSpecialNpc = (s: any): boolean =>
        ['小白狐', '花园宝宝'].includes(nameOf(s));
      // 对齐原版 L703 计算幼崽：观察前先刷新幼崽成长计时
      for (const s of summons) {
        try { this.familiarSystemService.checkAndUpdateGrowth(s); } catch { /* 成长解析失败不影响展示 */ }
      }

      if (summons.length > 6) {
        // 原版 L740-744：>6个时折叠为「宠物(N个)」，发编号进入查看宠物完整列表
        quickOptions.push({ label: `宠物(${summons.length}个)`, cmd: '查看宠物' });
      } else {
        const shownSpecialNames = new Set<string>();
        for (const s of summons) {
          const name = nameOf(s);
          // 原版 L781-784："白"只对主人显示
          if (name === '白' && !ownerIds.has(String(s?.ownerQQ ?? s?.归属 ?? s?.owner ?? ''))) {
            continue;
          }
          // 特殊NPC（固定[!]的神之工匠/小雫/露娜/行商 与 小白狐/花园宝宝类）同类项去重：
          // 同名只显示第一个并标[!]，后续同类项整行跳过（含快捷对话选项），避免刷屏。
          const isSpecialNpc = isFixedSpecialNpc(s) || isDedupableSpecialNpc(s);
          if (isSpecialNpc && shownSpecialNames.has(name)) {
            continue;
          }
          let label: string;
          if (isSpecialNpc) {
            shownSpecialNames.add(name);
            label = `${name}[!]`;
          } else if (markerVal(s, '幼崽') !== 0) {
            label = `${name}(幼崽)`;
          } else if (isMonsterSummon(s)) {
            label = hpOf(s) > 0 ? name : `${name}(倒地)`;
          } else {
            label = name;
          }
          // 所有召唤物条目均可@对话（原版 w2 += "#" + b + "@对话" + 名称），
          // 状态标记（[!]/(幼崽)/(倒地)）随编号列表 label 一并展示。
          quickOptions.push({ label, cmd: `对话 ${name}` });
        }
      }
    }

    // 地图信息 / 查看地图（原版观察附近尾段固定入口：N@查看说明 / N@查看地图）
    if (!map.isFrontier && !map.开拓地) {
      quickOptions.push({ label: '地图信息', cmd: '查看说明' });
    }
    quickOptions.push({ label: '查看地图', cmd: '查看地图' });

    // 统一生成编号快捷操作菜单（原版观察附近输出即编号列表本体：编号同时注册临时输入替换）
    if (quickOptions.length > 0) {
      if (lines[lines.length - 1] !== SEP) lines.push(SEP);
      const menuLines = await this.buildNumberedMenu(userId, quickOptions, '💡 发送编号数字(如 1)即可前往/采集/对话');
      lines.push(...menuLines);
    }


    // ===== 对齐原版 地图操作.ecode L867-968：编号项之后的四个信息段 =====

    // 自动采集资源文本（原版 L867-919 自动采集分支：附近资源 + 每分钟自动产出预估）
    if (Number(playerMarkers['自动采集'] ?? 0) !== 0) {
      const autoTargets = asJsonValue<any[]>(map.resources, []).filter((r: any) =>
        this.getResourceTimes(r) > 0
        && (String(r?.marker ?? r?.标记 ?? '') === ''
          || Number(playerMarkers[String(r?.marker ?? r?.标记 ?? '')] ?? 0) < 1));
      if (autoTargets.length > 0) {
        let gatherBonus = 0;
        try {
          const bonus = this.combatSystem.buildAttackerBonus(player, playerData, map) as any;
          gatherBonus = Number(bonus?.采集 ?? 0);
        } catch { /* 加成缺失按0处理 */ }
        const perMinute = new Map<string, number>();
        for (const r of autoTargets) {
          for (const out of asJsonValue<any[]>(r?.outputs ?? r?.产出, [])) {
            const outName = String(out?.name ?? out?.名称 ?? '');
            const qty = Number(out?.count ?? out?.数量 ?? 0);
            const chance = Number(out?.chance ?? out?.几率 ?? 100);
            if (!outName || !(qty > 0)) continue;
            // 原版 L876-878：产出数量 × 属性.采集/2000 × 几率/100
            perMinute.set(outName, (perMinute.get(outName) || 0) + qty * gatherBonus / 2000 * chance / 100);
          }
        }
        const yieldText = [...perMinute.entries()]
          .map(([itemName, qty]) => `${itemName}x${formatDisplayNumber(qty)}`)
          .join('、');
        lines.push(`附近资源:${autoTargets.map((r: any) => String(r.name ?? r.名称 ?? '')).join('、')},自动采集每分钟:${yieldText}`);
      }
    }

    // 附近玩家（原版 L929-941：地图玩家列表 → “附近的玩家:”名称列表）
    try {
      const nearbyRows = await this.prisma.player.findMany({
        where: { mapId: player.mapId },
        select: { name: true, user: { select: { username: true, nickname: true } } },
      });
      const nearbyNames = nearbyRows
        .map((row: any) => String(row?.name || row?.user?.nickname || row?.user?.username || ''))
        .filter(Boolean);
      if (nearbyNames.length > 0) {
        lines.push(`附近的玩家:${nearbyNames.join('、')}`);
      }
    } catch { /* 玩家列表查询失败不影响观察附近 */ }

    // 当前地图增益（原版 L942-949：地图标记3 → “当前地图增益:名称(剩余时间)”）
    {
      const lookMarkers2 = asJsonValue<any[]>(map.markers2, []);
      const lookNow = Date.now();
      const buffTexts = lookMarkers2
        .map((entry: any) => ({
          name: String(entry?.name ?? entry?.名称 ?? ''),
          expireAt: Number(entry?.expireAt ?? entry?.有效期至 ?? 0),
        }))
        .filter((entry) => entry.name && !entry.name.startsWith('刷新资源') && entry.expireAt > lookNow)
        .map((entry) => `${entry.name}（${this.millisecondsToText(entry.expireAt - lookNow)}）`);
      if (buffTexts.length > 0) {
        lines.push(`当前地图增益:${buffTexts.join('、')}`);
      }
    }

    // 躺下经验（原版 L950-960：躺下中显示每秒经验明细，与躺下起床显示同口径）
    if (Number(playerMarkers['躺下'] ?? 0) === 1) {
      const lieDisplay = await this.summonFollowDisplay(map, userId, { requireFollow: false, countLimit: 2 });
      const lieCount = lieDisplay.count;
      const lieSummons = asJsonValue<any[]>(map.summons, []);
      const luo = lieSummons.find((s: any) => (s?.specialSeq ?? s?.special_seq ?? s?.seq) === -4);
      const expBonus = Number(player.expBonus ?? 0);
      const level = Number(player.level ?? 1);
      const lieLines = [
        `${lieCount > 0 ? `正在和${lieDisplay.names.join('、')}` : '正'}躺在床上`,
        `每秒获得经验:${this.round2Text(level / 100)}`,
        `你的经验加成:${this.round2Text(expBonus)}%`,
        `陪睡NPC/宠物:${lieCount}/2（+${lieCount * 50}%）`,
      ];
      if (luo) lieLines.push(`${luo.name ?? luo.名称 ?? '洛'}:+10%`);
      const finalPerSec = (1 + lieCount * 0.5) * level * (1 + expBonus / 100) / 100 * (1 + (luo ? 1 : 0) / 10);
      lieLines.push(`最终每秒获得:${this.round2Text(finalPerSec)}`);
      lines.push(...lieLines);
    }

    // 自动开采显示（原版 L961-968：自动开采/自动开采2 开始时间戳 → “已自动开采:时长”）
    for (const mineMode of ['自动开采', '自动开采2']) {
      const startedAt = Number(playerMarkers[mineMode] ?? 0);
      if (startedAt > 0) {
        const elapsedMs = Date.now() - startedAt * 1000;
        if (elapsedMs > 0) lines.push(`已自动开采:${this.millisecondsToText(elapsedMs)}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 处理查看宠物命令（对应原版 _主程序.ecode L5442）
   * 列出当前地图的召唤物/宠物/NPC，并按编号生成"查看<名称>"快捷，玩家发编号查看详情。
   */
  async handleViewPets(userId: number): Promise<string>{
    return this.petCommandServiceSvc.handleViewPets(userId);
  }
  async handleViewVehicles(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    const vehicles = asJsonValue<any[]>(map.vehicles, []);
    const lines: string[] = [`🚗 【${map.name}】的载具:`, `━━━━━━━━━━━━━━━`];
    const options: { label: string; cmd: string }[] = [];

    if (vehicles.length === 0) {
      lines.push('  (当前地图没有载具)');
    } else {
      vehicles.forEach((v: any) => {
        const name = v.name || '未知载具';
        lines.push(`  ${name}`);
        options.push({ label: name, cmd: `查看 ${name}` });
      });
    }

    if (options.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      const menu = await this.buildNumberedMenu(userId, options, '💡 发送编号数字即可查看详情');
      lines.push(...menu);
    }
    return lines.join('\n');
  }

  /**
   * 处理查看作物命令（对应原版 _主程序.ecode L5466）
   * 列出当前地图资源2中可产出（产出2非空）的作物，并生成编号快捷。
   */
  async handleViewCrops(userId: number): Promise<string>{
    return this.homeBuildServiceSvc.handleViewCrops(userId);
  }
  async handleViewBuildings(userId: number): Promise<string>{
    return this.homeBuildServiceSvc.handleViewBuildings(userId);
  }
  async handleViewHomes(userId: number): Promise<string>{
    return this.homeBuildServiceSvc.handleViewHomes(userId);
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
    return this.homeBuildServiceSvc.handleViewFamiliar(userId);
  }
  async handleFamiliarData(userId: number): Promise<string>{
    return this.homeBuildServiceSvc.handleFamiliarData(userId);
  }
  async handleFamiliarMore(userId: number): Promise<string>{
    return this.homeBuildServiceSvc.handleFamiliarMore(userId);
  }
  async handleViewSkills(userId: number): Promise<string>{
    return this.skillCommandServiceSvc.handleViewSkills(userId);
  }
  async handleViewMarkers(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const lines: string[] = [`🔖 ${player.name || '冒险者'} 游戏标记:`, `━━━━━━━━━━━━━━━`];
    const entries = Object.entries(markers || {});
    if (entries.length === 0) {
      lines.push('  (暂无标记)');
    } else {
      for (const [name, value] of entries) {
        lines.push(`  ${name} ×${value}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * 处理查看标记2命令（对应原版 _主程序.ecode L5566）
   * 列出玩家限时标记（markers2 数组，含 expireAt）。
   */
  async handleViewMarkers2(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers2 } = playerData;
    const lines: string[] = [`⏱️ ${player.name || '冒险者'} 限时标记:`, `━━━━━━━━━━━━━━━`];
    const list = Array.isArray(markers2) ? markers2 : [];
    if (list.length === 0) {
      lines.push('  (暂无标记)');
    } else {
      const now = Date.now();
      for (const m of list) {
        if (!m || !m.name) continue;
        const remain = m.expireAt ? Math.max(0, Math.ceil((m.expireAt - now) / 1000)) : null;
        lines.push(`  ${m.name}${remain !== null ? ` (剩余${remain}秒)` : ''}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * 处理查看说明命令（对应原版 _主程序.ecode L5503）
   * 显示当前地图名称、说明、复活点（网页版无图片，仅文本）。
   */
  async handleViewDescription(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';
    const respawn = map.respawnPoint || map.复活点 || '未知';
    return [
      `📖 【${map.name}】说明`,
      `━━━━━━━━━━━━━━━`,
      map.description || '（该地图暂无说明）',
      `复活点: ${respawn}`,
    ].join('\n');
  }

  /**
   * 处理对话咏星跟随命令（对应原版 _主程序.ecode L1368）
   * 找到当前地图"咏星"怪物，检查好感≥100后将其转为归属于玩家的召唤物（跟随）。
   */
  async handleDialogueYongxing(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleDialogueYongxing(userId);
  }
  async handleDialogueLittleDemon(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleDialogueLittleDemon(userId);
  }
  async handleSetMeatRatio(userId: number, ratioStr: string): Promise<string>{
    return this.questDialogueServiceSvc.handleSetMeatRatio(userId, ratioStr);
  }
  async handleSignalGun(userId: number, countArg = ''): Promise<string>{
    return this.homeBuildServiceSvc.handleSignalGun(userId, countArg);
  }
  private async completeCargoSummon(userId: number, count: number): Promise<void>{
    return this.homeBuildServiceSvc.completeCargoSummon(userId, count);
  }
  private async applyCargoSummon(userId: number, count: number): Promise<void>{
    return this.homeBuildServiceSvc.applyCargoSummon(userId, count);
  }
  async handleFamiliarHome(userId: number): Promise<string>{
    return this.homeBuildServiceSvc.handleFamiliarHome(userId);
  }
  async handleBuildHouse(userId: number): Promise<string>{
    return this.homeBuildServiceSvc.handleBuildHouse(userId);
  }
  async handleDigFoundation(userId: number): Promise<string>{
    return this.homeBuildServiceSvc.handleDigFoundation(userId);
  }
  async handleBuildFoundation(userId: number): Promise<string>{
    return this.homeBuildServiceSvc.handleBuildFoundation(userId);
  }
  async handleClaimLand(userId: number): Promise<string>{
    return this.homeBuildServiceSvc.handleClaimLand(userId);
  }
  async handleProduce(userId: number, productName: string): Promise<string>{
    return this.questDialogueServiceSvc.handleProduce(userId, productName);
  }
  async handleClearDungeon(userId: number, dungeonName = ''): Promise<string>{
    return this.dungeonChallengeServiceSvc.handleClearDungeon(userId, dungeonName);
  }
  private parseDungeonArray(value: any): any[]{
    return this.dungeonChallengeServiceSvc.parseDungeonArray(value);
  }
  private normalizeDungeonMarkers2(markers2: any[]): void{
    this.dungeonChallengeServiceSvc.normalizeDungeonMarkers2(markers2);
  }
  async handleAssembleVehicle(userId: number, partName: string, count = 1): Promise<string> {
    const requestedCount = Math.max(1, Math.floor(Number(count) || 1));
    if (!partName) {
      return '请指定要组装的部件名称，格式：组装 部件名';
    }

    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取用户QQ号
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userQQ = user?.qqNumber || String(userId);

    // 检查背包中是否有该部件
    const backpack = this.playerService.getBackpackItems(player);
    const partItem = backpack.find((item: any) => item.name === partName);
    if (!partItem) {
      return `背包中没有【${partName}】`;
    }

    // 床等功能建筑也可以组装到载具，原版任务使用“组装床”而不是“安装床”。
    if (this.staticData.getBuildingByName(partName)) {
      return this.handleAssembleBuilding(userId, partName, requestedCount);
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
          driver: userQQ,
          mapIndex: player.mapId,
          maxHp: 100,
          currentHp: 100,
          parts: [{
            name: partDef.name,
            partType: 0,
            bonus: asJsonValue<any>(partDef.bonus, {}),
            description: partDef.description || '',
          }],
          bonus: asJsonValue<any>(partDef.bonus, {}),
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
    return await this.handleInstallPart(userId, partName, requestedCount);
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

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const map = await this.mapService.getMapById(player.mapId);
    const playerName = player.name || '冒险者';
    const driverId = String(user?.qqNumber || user?.externalId || userId);
    const ownerIds = new Set([
      String(userId), String(user?.qqNumber || ''), String(user?.externalId || ''),
      String(player.masterQQ || ''),
    ].filter(Boolean));

    const vehicleKeys = (value: any): string[] => [
      value?.编号, value?.vehicleId, value?.id, value?.名称, value?.name,
    ].filter((key) => key !== undefined && key !== null && String(key) !== '').map(String);
    const matchesVehicle = (value: any): boolean => vehicleKeys(value).includes(String(vehicleName));
    const ownerOf = (value: any): string => String(value?.归属 ?? value?.owner ?? '');
    const isAllowedOwner = (value: any): boolean => {
      const owner = ownerOf(value);
      return owner === '无主' || ownerIds.has(owner);
    };

    const mapVehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
    const mapIndex = mapVehicles.findIndex(matchesVehicle);
    let source: any = null;
    if (mapIndex >= 0) {
      source = {
        kind: 'map',
        map,
        index: mapIndex,
        runtime: this.toRuntimeVehicle(mapVehicles[mapIndex]),
      };
    } else {
      const numericId = Number(vehicleName);
      let dbVehicle: any = Number.isInteger(numericId) && numericId > 0
        ? await this.prisma.gameVehicle.findUnique({ where: { id: numericId } })
        : null;
      if (!dbVehicle) {
        dbVehicle = await this.prisma.gameVehicle.findFirst({
          where: {
            OR: [
              { name: vehicleName },
              { vehicleId: vehicleName },
            ],
          },
        });
      }
      // 原版只从当前地图的载具数组取值。GameVehicle 是当前项目的持久化映射：
      // mapIndex=0 表示旧存量未记录位置，允许归属者继续使用；新载具会写入当前 mapId。
      const vehicleMap = Number(dbVehicle?.mapIndex || 0);
      if (dbVehicle && (vehicleMap === 0 || vehicleMap === Number(map?.id) || vehicleMap === Number(map?.mapIndex))) {
        source = { kind: 'db', db: dbVehicle, map, runtime: this.toRuntimeVehicle(dbVehicle) };
      }
    }

    if (!source) return `${playerName}附近没有${vehicleName}`;
    if (!isAllowedOwner(source.runtime)) {
      return `${playerName}这是别人的${source.runtime.名称}，你不能驾驶`;
    }

    const runtime = source.runtime;
    const targetKeys = new Set(vehicleKeys(runtime));
    if (source.kind === 'db') targetKeys.add(String(source.db.id));
    const oldVehicleKey = String(player.vehicle || '');
    const targetWasUnowned = ownerOf(runtime) === '无主';
    let mapChanged = false;
    const summons = this.parseVehicleValue<any[]>(map?.summons, []);
    const dbUpdates: Promise<any>[] = [];

    // 原版 L10328-L10340：先让原驾驶员离开目标载具；玩家和召唤物分别清除自己的载具字段。
    const previousDriver = String(runtime.驾驶员 ?? runtime.driver ?? '');
    if (previousDriver && !ownerIds.has(previousDriver)) {
      let previousUser: any = null;
      const numericDriver = Number(previousDriver);
      if (Number.isInteger(numericDriver) && numericDriver > 0) {
        previousUser = await this.prisma.user.findUnique({ where: { id: numericDriver } });
      }
      if (!previousUser) {
        previousUser = await this.prisma.user.findFirst({
          where: { OR: [{ qqNumber: previousDriver }, { externalId: previousDriver }] },
        });
      }
      if (previousUser) {
        const previousData = await this.playerService.getPlayerData(previousUser.id);
        if (previousData?.player && previousData.player.vehicle) {
          previousData.player.vehicle = '';
          await this.playerService.savePlayer(previousData.player);
        }
      } else {
        const summon = summons.find((unit: any) => [
          unit?.QQ, unit?.qq, unit?.编号, unit?.id,
        ].filter(Boolean).map(String).includes(previousDriver));
        if (summon) {
          summon.载具 = '';
          summon.vehicle = '';
          mapChanged = true;
        }
      }
    }

    // 原版 L10346-L10350：驾驶新载具时清除玩家原来载具的驾驶员。
    if (oldVehicleKey && !targetKeys.has(oldVehicleKey)) {
      const oldMapIndex = mapVehicles.findIndex((unit: any) => vehicleKeys(unit).includes(oldVehicleKey));
      if (oldMapIndex >= 0) {
        mapVehicles[oldMapIndex].驾驶员 = '';
        mapVehicles[oldMapIndex].driver = '';
        mapChanged = true;
      } else {
        const oldNumericId = Number(oldVehicleKey);
        const oldDbVehicle = Number.isInteger(oldNumericId) && oldNumericId > 0
          ? await this.prisma.gameVehicle.findUnique({ where: { id: oldNumericId } })
          : await this.prisma.gameVehicle.findFirst({ where: { vehicleId: oldVehicleKey } });
        if (oldDbVehicle && oldDbVehicle.id !== source.db?.id) {
          dbUpdates.push(this.prisma.gameVehicle.update({
            where: { id: oldDbVehicle.id },
            data: { driver: '' },
          }));
        }
      }
    }

    runtime.驾驶员 = driverId;
    runtime.driver = driverId;
    if (targetWasUnowned) {
      runtime.归属 = driverId;
      runtime.owner = driverId;
    }
    if (source.kind === 'map') {
      mapVehicles[source.index] = this.toStoredVehicle(runtime);
      mapChanged = true;
    } else {
      dbUpdates.push(this.prisma.gameVehicle.update({
        where: { id: source.db.id },
        data: {
          owner: String(runtime.owner || runtime.归属 || ''),
          driver: driverId,
          mapIndex: Number(map?.id || 0),
        },
      }));
    }
    if (mapChanged) {
      await this.mapService.updateDynamicFields(map.id, {
        vehicles: mapVehicles,
        summons,
      });
    }
    await Promise.all(dbUpdates);

    player.vehicle = source.kind === 'db'
      ? String(source.db.id)
      : String(runtime.编号 || runtime.vehicleId || runtime.id || '');
    const sets = this.parseVehicleValue<any>(player.sets, {});
    // 原版 L10314：驾驶成功后立即终止接管状态。
    sets.takeVehicle = '';
    sets.接管载具 = '';
    player.sets = sets;
    await this.playerService.savePlayer(player);

    if (targetWasUnowned) {
      await this.achievementService.addAchievement(player, '拾取载具', 1);
      await this.taskService.advance(userId, '拾取载具' + runtime.名称);
    }
    await this.achievementService.addAchievement(player, '驾驶载具', 1);
    await this.taskService.advance(userId, '驾驶' + runtime.类型);

    const vehicleText = `${runtime.名称}(${runtime.类型})`;
    const result = targetWasUnowned
      ? `${playerName}获取了${runtime.名称}的权限,然后进入了${vehicleText}的驾驶舱,"脱出"来离开`
      : `${playerName}进入了${vehicleText}的驾驶舱,"脱出"来离开`;
    this.logger.log(`玩家 ${userId} 驾驶了载具 ${runtime.名称}`);
    return result;
  }

  /** 解析“核心1 轻型足2”式载具模拟参数；首个零件固定需要1个，其余取尾部数字。 */
  private parseVehicleAssemblyParts(parts: string[]): any[] {
    return parts.map((rawPart, index) => {
      const value = String(rawPart || '').trim();
      const name = index === 0 ? value.replace(/\d+/g, '') : value.replace(/\d+(?=\s*$)/, '').trim();
      const quantity = index === 0 ? 1 : Math.trunc(Number(value.match(/(\d+)\s*$/)?.[1] || 0));
      return { 名称: name, name, 类型: '资源', type: '资源', 数量: quantity, quantity };
    }).filter((part) => part.名称 && Number.isFinite(part.数量) && part.数量 > 0);
  }

  private async backpackQuantity(backpack: any[], name: string): Promise<number> {
    let total = 0;
    for (const item of backpack) {
      if ((item?.name ?? item?.名称) === name && item?.type !== '装备') {
        total += Number(item.quantity ?? item.count ?? 0);
      }
    }
    return total;
  }

  private addBackpackItem(backpack: any[], item: any): void {
    // 统一走 item-normalize 规范化合并：type 以静态定义为唯一真源（Issue #11）
    mergeBackpackItem(backpack, item, lookupFromStaticData(this.staticData));
  }

  /** 对应原版 制造()：dryRun 只校验，正式执行才消耗资源并产出物品。 */
  private async craftVehiclePart(
    player: any,
    backpack: any[],
    markers: Record<string, number>,
    name: string,
    count: number,
    dryRun: boolean,
  ): Promise<{ success: boolean; text: string }> {
    const recipe = this.staticData.getAllCraftings().find((row: any) => row.name === name);
    if (!recipe) return { success: false, text: `${player.name},【${name}】在制造列表不存在。` };
    if (recipe.noCraft) {
      return { success: false, text: `你输入了正确的名称，但是【${name}】不是可以制造的项目(它只是用来分解用的)，你也许想：` };
    }

    const normalizeItems = (value: any): any[] => {
      const rows = Array.isArray(value) ? value : asJsonValue<any[]>(value, []);
      return rows.map((row: any) => {
        const name = row?.name ?? row?.名称;
        // Issue #11：产出/需求缺 type 时对齐静态物品定义（经验胶囊=物品），
        // 防止默认“资源”与 item-system 路径（determineItemType=物品）分叉，
        // 造成同名不同 type 的背包条目永不合并。
        const staticType = name
          ? (this.staticData.getEquipmentByName(name) ? '装备' : this.staticData.getItemByName(name)?.type)
          : undefined;
        const type = row?.type ?? row?.类型 ?? staticType ?? '资源';
        return {
          ...row,
          name,
          名称: row?.名称 ?? row?.name,
          type,
          类型: row?.类型 ?? type,
          quantity: Number(row?.quantity ?? row?.count ?? row?.数量 ?? 0),
          数量: Number(row?.quantity ?? row?.count ?? row?.数量 ?? 0),
        };
      }).filter((row: any) => row.name && Number.isFinite(row.quantity));
    };
    const requirements = normalizeItems(recipe.requirements);
    const outputs = normalizeItems(recipe.outputs);
    const gainMarkers: string[] = asJsonValue<string[]>(recipe.gainMarkers, []);
    if (outputs.length === 0) {
      return { success: false, text: `！！警告：制造项目${recipe.name}的制造产出为空，请检查文件` };
    }
    if (player.level < recipe.level) return { success: false, text: `需要等级${recipe.level}` };
    if (gainMarkers.some((markerName) => markerName && (markers[markerName] || 0) >= 1)) {
      return { success: false, text: '这个不可以重复制造。' };
    }

    const insufficient: string[] = [];
    for (const requirement of requirements) {
      const required = requirement.quantity * count;
      const owned = await this.backpackQuantity(backpack, requirement.name);
      if (owned < required) insufficient.push(`需要${requirement.name} ×${required}，你只有${owned}`);
    }
    if (insufficient.length > 0) return { success: false, text: insufficient.join('\n') };
    if (dryRun) return { success: true, text: '' };

    for (const requirement of requirements) {
      let remaining = requirement.quantity * count;
      for (let index = backpack.length - 1; index >= 0 && remaining > 0; index--) {
        const item = backpack[index];
        if ((item?.name ?? item?.名称) !== requirement.name) continue;
        const current = Number(item.quantity ?? item.count ?? 0);
        const removed = Math.min(current, remaining);
        remaining -= removed;
        if (current - removed <= 0) backpack.splice(index, 1);
        else {
          item.quantity = current - removed;
          item.count = current - removed;
        }
      }
    }

    const producedTexts: string[] = [];
    for (const output of outputs) {
      const outputQuantity = output.quantity * count;
      const outputItem = {
        ...output,
        quantity: outputQuantity,
        数量: outputQuantity,
      };
      await this.addBackpackItem(backpack, outputItem);
      producedTexts.push(`${output.name} ×${outputQuantity}`);
    }
    markers['制造'] = (markers['制造'] || 0) + count;
    markers[`制造${name}`] = (markers[`制造${name}`] || 0) + count;
    for (const markerName of gainMarkers) {
      if (markerName) markers[markerName] = (markers[markerName] || 0) + count;
    }
    return { success: true, text: `${player.name}用制造了${count}的${name}\n得到了${producedTexts.join('、')}` };
  }

  /** 对应原版 组装载具()：先模拟扣除已有零件，再自动制造缺失零件并写入当前地图。 */
  async assembleVehicleFromParts(userId: number, rawParts: string[]): Promise<string> {
    const requiredParts = this.parseVehicleAssemblyParts(rawParts);
    if (!requiredParts.length) return '核心必须在最前面';
    const coreSpec = this.staticData.getVehiclePartSpecByName(requiredParts[0].名称);
    if (!coreSpec || !String(requiredParts[0].名称).replace(/\d+$/, '').endsWith('核心')) {
      return '核心必须在最前面';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const ownerQQ = String(user?.qqNumber || userId);
    const playerName = player.name || '冒险者';

    const restriction = this.combatSystem.actionUnrestricted(player, { cannonOk: false, ignoreReason: 6 });
    if (restriction.restricted) return `${playerName}${restriction.text}`;
    if (this.playerService.isPlayerDead(player)) {
      // 与其他指令同源：走 deathGateText（含 卷土重来免死 / 军姬·死亡行者·石中剑 半血复活
      // 级联），不再硬编码死亡文案 —— 否则这些复活机制在载具组装指令上失效。
      const deathText = await this.playerService.deathGateText(player);
      if (deathText) return deathText;
    }

    if (await this.hasOwnedProductionVehicle(ownerQQ, coreSpec)) {
      return `${playerName}一个玩家只能同时存在一个生产类载具，你可以在普通载具上组装生产线，一样有生产的效果。`;
    }

    const backpack = this.playerService.getBackpackItems(player);
    const temporaryBackpack = JSON.parse(JSON.stringify(backpack));
    const missingParts: any[] = [];
    for (const part of requiredParts) {
      const owned = await this.backpackQuantity(temporaryBackpack, part.名称);
      if (owned >= part.数量) continue;
      const stillMissing = part.数量 - owned;
      missingParts.push({ ...part, 数量: stillMissing, quantity: stillMissing });
    }

    let aborted = false;
    let failureText = '';
    for (const part of missingParts) {
      const dryRun = await this.craftVehiclePart(player, temporaryBackpack, markers, part.名称, part.数量, true);
      if (!dryRun.success) {
        failureText += failureText
          ? `、${part.名称}x${part.数量}`
          : `\n缺少这些物品，并且背包里面的数量不够/背包里面的资源不足以制造缺少的数量：${part.名称}x${part.数量}`;
        aborted = true;
      }
    }
    if (aborted) return `${playerName}${failureText}`;

    const craftTexts: string[] = [];
    for (const part of missingParts) {
      const crafted = await this.craftVehiclePart(player, backpack, markers, part.名称, part.数量, false);
      if (crafted.text) craftTexts.push(crafted.text);
    }

    const timestamp = Date.now();
    const runtime = this.toRuntimeVehicle({});
    runtime.零件 = requiredParts.map((part) => ({ ...part }));
    runtime.配方 = [{ 名称: '1', name: '1', 数值: timestamp, value: timestamp }];
    runtime.编号 = `V${timestamp.toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    runtime.vehicleId = runtime.编号;
    runtime.归属 = ownerQQ;
    runtime.owner = ownerQQ;
    this.combatSystem.recalculateVehicle(runtime, timestamp);
    const calculatedHp = Number(runtime.加成?.生命 || 0);
    runtime.当前生命 = calculatedHp;
    runtime.currentHp = calculatedHp;
    runtime.生命 = calculatedHp;
    runtime.maxHp = calculatedHp;
    runtime.名称 = `${playerName}的${String(requiredParts[0].名称).replace('核心', '')}`;
    runtime.name = runtime.名称;

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${playerName}不在任何地图上`;
    const vehicles = this.parseVehicleValue<any[]>(map.vehicles, []);
    vehicles.push(this.toStoredVehicle(runtime));
    await this.mapService.updateDynamicFields(map.id, { vehicles });

    for (const part of requiredParts) {
      let remaining = part.数量;
      for (let index = backpack.length - 1; index >= 0 && remaining > 0; index--) {
        const item = backpack[index];
        if ((item?.name ?? item?.名称) !== part.名称) continue;
        const current = Number(item.quantity ?? item.count ?? 0);
        const removed = Math.min(current, remaining);
        remaining -= removed;
        if (current - removed <= 0) backpack.splice(index, 1);
        else {
          item.quantity = current - removed;
          item.count = current - removed;
        }
      }
    }
    player.backpack = backpack; // Json 列直接写数组
    player.markers = markers; // Json 列直接写对象
    await this.playerService.savePlayer(player);

    await this.achievementService.addAchievement(player, '组装载具', 1);
    await this.taskService.advance(userId, `组装${requiredParts[0].名称}`, 1);

    return [`${playerName}组装了一个载具：${runtime.名称}`, ...craftTexts].filter(Boolean).join('\n');
  }

  private async hasOwnedProductionVehicle(ownerQQ: string, coreSpec: any): Promise<boolean> {
    if (!(Number(coreSpec?.partType ?? coreSpec?.类型) === 0 && Number(coreSpec?.bonus?.生产 || 0) !== 0)) return false;
    const maps = await this.mapService.getAllMaps();
    return maps.some((map: any) => this.parseVehicleValue<any[]>(map?.vehicles, []).some((vehicleRaw: any) => {
      if (String(vehicleRaw?.归属 ?? vehicleRaw?.owner ?? '') !== ownerQQ) return false;
      const vehicle = this.toRuntimeVehicle(vehicleRaw);
      return Number(vehicle.加成?.生产 || 0) !== 0 || (vehicle.零件 || []).some((part: any) => {
        const spec = this.staticData.getVehiclePartSpecByName(part.名称);
        return Number(spec?.partType) === 0 && Number(spec?.bonus?.生产 || 0) !== 0;
      });
    }));
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

      const bonus = asJsonValue<any>(partDef.bonus, {});
      const bonusLines = Object.entries(bonus)
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .map(([k, v]) => `  ${k}: +${v}`);

      return [
        `🔧 部件模拟：${partDef.name}`,
        `━━━━━━━━━━━━━━━`,
        `类型: ${this.supportSvc.PART_TYPE_NAMES[partDef.partType] || '未知'}`,
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

    const parts = asJsonValue<any[]>(vehicle.parts, []);
    const totalBonus = this.calcVehicleTotalBonus(vehicle);

    const lines = [
      `🔧 载具模拟：${vehicle.name}`,
      `━━━━━━━━━━━━━━━`,
      `部件数量: ${parts.length}个`,
      `━━━━━━━━━━━━━━━`,
      `📊 模拟加成:`,
    ];

    const bonusFields: { key: string; label: string }[] = [
      { key: '攻击', label: '攻击' },
      { key: '生命', label: '生命' },
      { key: '装甲', label: '装甲' },
      { key: '护盾', label: '护盾' },
      { key: '速度', label: '速度' },
      { key: '闪避', label: '闪避' },
      { key: '命中', label: '命中' },
      { key: '暴击', label: '暴击' },
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
   * 维修载具（原版 _主程序.ecode L10397-10495「维修」）。
   * 无参入口：行动无限制（理由6=自动开采豁免）→ 需驾驶载具 → 地图战斗增益+有怪拦截 →
   * 死亡 → 取载具（图上无此载具则弹射清空驾驶）→ 部件超上限四类拦截 → 满血「还不需要修」
   * → 耗时 = 20 秒，小雫/小凰/小蓝/小粉 各 -5 秒；
   *   耗时 <1 → 立即用0载具零件修好（计算载具+满血+成就维修载具）；
   *   否则「正在维修…」+ 工作 a 秒标记 + 延时 a 秒结算（completeVehicleRepair）。
   * 「维修 wcc1」是原版延时结算分支（延时任务以玩家身份重发命令）；
   * 「维修 其他参数」原版静默无输出。
   */
  async handleRepairVehicle(userId: number, targetName: string = ''): Promise<string> {
    const keyword = String(targetName ?? '').trim();
    if (keyword && keyword !== 'wcc1') return '';
    if (keyword === 'wcc1') return this.completeVehicleRepair(userId);

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = player.name || '冒险者';

    // 行动无限制（原版 L10400 理由6：自动开采中也可以维修）
    const restriction = this.combatSystem.actionUnrestricted(player, { ignoreReason: 6 });
    if (restriction.restricted) return restriction.text;
    if (!player.vehicle) return `${name}你现在没有在驾驶载具`;

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${name}不在任何地图上`;

    // 地图战斗增益 + 有怪拦截（原版 L10407-10408）
    const mapMarkers2 = asJsonValue<any[]>(map.markers2, []);
    const strength = { value: 0 };
    const remain = { value: 0 };
    let monsters: any[] = [];
    try {
      monsters = await this.mapService.getMapMonsters(map);
    } catch {
      monsters = [];
    }
    if (this.combatState.buffRequire('战斗', mapMarkers2, strength, Date.now(), remain) && monsters.length !== 0) {
      const remainSec = Math.max(0, Math.ceil(Number(remain.value) || 0));
      const remainText = remainSec >= 60
        ? `${Math.floor(remainSec / 60)}分${remainSec % 60}秒`
        : `${remainSec}秒`;
      return `${name}当前地图正在战斗中，请消灭全部怪物、离开，或者等待${remainText}`;
    }

    { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    // 取载具 + 计算载具（原版 L10412-10415）
    const vehicle = await this.findTravelVehicle(player, map);
    if (!vehicle) {
      // 原版 L10416-10418：附近没有该载具则弹射（清空驾驶状态）
      const vehicleKey = String(player.vehicle);
      player.vehicle = '';
      await this.playerService.savePlayer(player);
      return `#错误：附近没有载具${vehicleKey},已弹射`;
    }
    this.combatSystem.recalculateVehicle(vehicle, Date.now());

    // 部件超上限四类拦截（原版 L10419-10427）
    const overLimit = this.findVehicleOverLimitPart(vehicle);
    if (overLimit) {
      return `${name}，${vehicle.名称 || vehicle.name}安装的${overLimit}超过了上限，无法维修`;
    }

    const fullHp = Number(vehicle.加成?.生命 || 0) || this.rescueVehicleMaxHp(vehicle);
    if (fullHp > 0 && Number(vehicle.currentHp ?? vehicle.当前生命 ?? 0) === fullHp) {
      return `${name}还不需要修`;
    }

    // 耗时：基础 20 秒；小雫/小凰/小蓝/小粉 各 -5 秒（原版 L10431-10443）
    const partNames = this.collectVehiclePartNames(vehicle);
    let seconds = 20;
    for (const part of ['小雫', '小凰', '小蓝', '小粉']) {
      if (partNames.includes(part)) seconds -= 5;
    }
    if (seconds < 1) {
      return this.applyVehicleRepair(userId, player, map, vehicle);
    }

    // 工作 a 秒标记 + 延时结算（原版 L10447-10449）
    const markers2 = asJsonValue<any[]>(player.markers2, []);
    this.combatState.addMarker('工作', seconds, markers2, Date.now());
    player.markers2 = markers2; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    if (this.delayedTaskService) {
      await this.delayedTaskService.schedule({
        type: 'repair',
        userId,
        dedupeKey: String(userId),
        runAt: Date.now() + seconds * 1000,
      });
    }
    return `${name}正在维修${vehicle.名称 || vehicle.name},大概需要${seconds}秒`;
  }

  /**
   * 维修延时结算（原版「维修wcc1」L10462-10489）：
   * 延时到期后重发「维修 wcc1」——仍需驾驶载具（弹射/超上限拦截同入口），
   * 通过后用0载具零件把载具修好（计算载具重算加成 → 满血 → 成就维修载具）。
   * 结算文本经世界频道广播（延时路径无指令收尾）。
   * 支柱二：dts tick 直调无外层锁，入口自串行（指令路径重入放行）。
   */
  private async completeVehicleRepair(userId: number): Promise<string> {
    return this.playerService.enqueueUserWrite(userId, () =>
      this.applyCompleteVehicleRepair(userId));
  }

  private async applyCompleteVehicleRepair(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = player.name || '冒险者';
    if (!player.vehicle) return `${name}你现在没有在驾驶载具`;

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${name}不在任何地图上`;
    const vehicle = await this.findTravelVehicle(player, map);
    if (!vehicle) {
      const vehicleKey = String(player.vehicle);
      player.vehicle = '';
      await this.playerService.savePlayer(player);
      return `#错误：附近没有载具${vehicleKey},已弹射`;
    }
    const overLimit = this.findVehicleOverLimitPart(vehicle);
    if (overLimit) {
      return `${name}，${vehicle.名称 || vehicle.name}安装的${overLimit}超过了上限，无法维修`;
    }
    return this.applyVehicleRepair(userId, player, map, vehicle);
  }

  /**
   * 维修生效（原版 L10444-10445 / L10484-10488）：计算载具重算加成 → 当前生命=加成.生命
   * → 成就维修载具+1 → 回复“用0载具零件修好了X（类型）”。
   * 载具优先写回地图 vehicles JSON，DB 载具兜底直更 currentHp/maxHp。
   */
  private async applyVehicleRepair(userId: number, player: any, map: any, vehicle: any): Promise<string> {
    this.combatSystem.recalculateVehicle(vehicle, Date.now());
    const fullHp = Number(vehicle.加成?.生命 || 0) || this.rescueVehicleMaxHp(vehicle);
    vehicle.当前生命 = fullHp;
    vehicle.currentHp = fullHp;
    if (fullHp > 0) {
      vehicle.生命 = fullHp;
      vehicle.maxHp = fullHp;
    }

    const vehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
    const key = String(vehicle.编号 ?? vehicle.vehicleId ?? vehicle.id ?? vehicle.名称 ?? vehicle.name ?? '');
    const matches = (value: any): boolean => [
      value?.编号, value?.vehicleId, value?.id, value?.名称, value?.name,
    ].some((candidate) => candidate !== undefined && candidate !== null && String(candidate) === key);
    const index = key ? vehicles.findIndex(matches) : -1;
    if (index >= 0) {
      vehicles[index] = this.toStoredVehicle(vehicle);
      await this.mapService.updateDynamicFields(map.id, { vehicles });
    } else {
      const dbId = Number(vehicle.id);
      const gameVehicle = (this.prisma as any).gameVehicle;
      if (Number.isInteger(dbId) && dbId > 0 && gameVehicle?.update) {
        await gameVehicle.update({ where: { id: dbId }, data: { currentHp: fullHp, ...(fullHp > 0 ? { maxHp: fullHp } : {}) } });
      }
    }

    await this.advanceTask(userId, '维修载具');
    const vehicleType = String(vehicle.类型 ?? vehicle.type ?? '');
    const typeText = vehicleType ? `（${vehicleType}）` : '';
    return `${player.name || '冒险者'}用0载具零件修好了${vehicle.名称 || vehicle.name}${typeText}`;
  }

  /** 原版 L10419-10427 四类部件超上限拦截：按 功能→武器→行走→防御 顺序返回超限类别名。 */
  private findVehicleOverLimitPart(vehicle: any): string {
    const parts = Array.isArray(vehicle?.parts ?? vehicle?.零件)
      ? (vehicle.parts ?? vehicle.零件)
      : asJsonValue<any[]>(vehicle?.parts ?? vehicle?.零件, []);
    const count = (type: number): number =>
      parts.filter((part: any) => Number(part?.type ?? part?.类型 ?? -1) === type).length;
    if (count(4) > Number(vehicle?.maxFunction ?? 5)) return '功能部件';
    if (count(3) > Number(vehicle?.maxWeapon ?? 5)) return '武器部件';
    if (count(2) > Number(vehicle?.maxMove ?? 5)) return '行走机构';
    if (count(1) > Number(vehicle?.maxDefense ?? 5)) return '防御部件';
    return '';
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

    const vehicleKey = String(player.vehicle);
    const map = await this.mapService.getMapById(player.mapId);
    const mapVehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
    const vehicleKeys = (value: any): string[] => [
      value?.编号, value?.vehicleId, value?.id,
    ].filter((key) => key !== undefined && key !== null && String(key) !== '').map(String);
    const index = mapVehicles.findIndex((value: any) => vehicleKeys(value).includes(vehicleKey));

    if (index >= 0) {
      const runtime = this.toRuntimeVehicle(mapVehicles[index]);
      runtime.驾驶员 = '';
      runtime.driver = '';
      mapVehicles[index] = this.toStoredVehicle(runtime);
      await this.mapService.updateDynamicFields(map.id, { vehicles: mapVehicles });
      player.vehicle = '';
      await this.playerService.savePlayer(player);
      await this.achievementService.addAchievement(player, '脱出', 1);
      this.logger.log(`玩家 ${userId} 从载具 ${runtime.名称} 中脱出`);
      return `${player.name}离开了${runtime.名称}(${runtime.类型})`;
    }

    const numericId = Number(vehicleKey);
    const vehicle: any = Number.isInteger(numericId) && numericId > 0
      ? await this.prisma.gameVehicle.findUnique({ where: { id: numericId } })
      : await this.prisma.gameVehicle.findFirst({ where: { vehicleId: vehicleKey } });
    if (!vehicle) {
      player.vehicle = '';
      await this.playerService.savePlayer(player);
      return `#错误：附近没有载具${vehicleKey},已弹射`;
    }

    await this.prisma.gameVehicle.update({ where: { id: vehicle.id }, data: { driver: '' } });
    player.vehicle = '';
    await this.playerService.savePlayer(player);
    await this.achievementService.addAchievement(player, '脱出', 1);
    this.logger.log(`玩家 ${userId} 从载具 ${vehicle.name} 中脱出`);
    return `${player.name}离开了${vehicle.name}(${vehicle.type})`;
  }

  /**
   * 处理接管载具命令
   * 接管其他玩家的载具
   * 对应原版：接管 命令
   */
  async handleTakeoverVehicle(userId: number, targetName: string): Promise<string> {
    if (!targetName) {
      return '请发送“接管骑士”来接管名为骑士的载具';
    }

    // 原版只允许接管当前玩家拥有的载具；接管状态写入玩家.套装.接管载具，
    // 不改变驾驶员，也不把玩家.vehicle 改成被接管载具。
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const ownerIds = new Set([
      String(userId), String(user?.qqNumber ?? ''), String(user?.externalId ?? ''),
      String(player.masterQQ ?? ''),
    ].filter(Boolean));
    const map = await this.mapService.getMapById(player.mapId);
    const vehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
    const match = (item: any): boolean => {
      const identifiers = [item?.名称, item?.name, item?.编号, item?.vehicleId, item?.id]
        .filter((value) => value !== undefined && value !== null).map(String);
      const owner = String(item?.归属 ?? item?.owner ?? '');
      return identifiers.includes(String(targetName)) && ownerIds.has(owner);
    };
    let vehicle: any = vehicles.find(match);
    let vehicleId = vehicle ? String(vehicle.编号 ?? vehicle.vehicleId ?? vehicle.id ?? '') : '';

    if (!vehicle) {
      const numericId = Number(targetName);
      if (Number.isInteger(numericId) && numericId > 0) {
        vehicle = await this.prisma.gameVehicle.findUnique({ where: { id: numericId } });
      }
      if (!vehicle) {
        vehicle = await this.prisma.gameVehicle.findFirst({
          where: { OR: [{ name: targetName }, { vehicleId: targetName }] },
        });
      }
      if (vehicle && ownerIds.has(String(vehicle.owner ?? ''))) {
        vehicleId = String(vehicle.vehicleId || vehicle.id);
      } else {
        vehicle = null;
      }
    }

    if (!vehicle) {
      return `${player.name || '冒险者'},${map?.name || '当前地图'}这里没有名称或者id为${targetName}并且属于你的载具`;
    }

    const sets = this.parseVehicleValue<any>(player.sets, {});
    sets.takeVehicle = vehicleId;
    sets.接管载具 = vehicleId;
    player.sets = sets;
    await this.playerService.savePlayer(player);

    const vehicleName = vehicle.名称 ?? vehicle.name ?? targetName;
    this.logger.log(`玩家 ${userId} 接管了载具 ${vehicleName}`);
    return `${player.name || '冒险者'}已对${vehicleName}进行接管，现在无需驾驶即可拆装部件、设置生产\n“接管停止”可停止接管\n“驾驶”也可以中止接管`;
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

    const parts = asJsonValue<any[]>(vehicle.parts, []);
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
  async handleModeChange(userId: number, modeName: string): Promise<string>{
    return this.skillCommandServiceSvc.handleModeChange(userId, modeName);
  }
  async handleTransform(userId: number, targetForm: string): Promise<string>{
    return this.skillCommandServiceSvc.handleTransform(userId, targetForm);
  }
  async handleTractorBeam(userId: number, targetName: string): Promise<string>{
    return this.skillCommandServiceSvc.handleTractorBeam(userId, targetName);
  }
  async handleControlTerminal(userId: number, arg = ''): Promise<string>{
    return this.skillCommandServiceSvc.handleControlTerminal(userId, arg);
  }
  private bondSkillLabel(slot: 'a' | 'b', value: number): string{
    return this.skillCommandServiceSvc.bondSkillLabel(slot, value);
  }
  private async handleWhiteBondTerminal( userId: number, player: any, markers: Record<string, any>, arg: string, ): Promise<string>{
    return this.skillCommandServiceSvc.handleWhiteBondTerminal(userId, player, markers, arg);
  }
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
  async handleAmplifierHelp(userId: number): Promise<string>{
    return this.skillCommandServiceSvc.handleAmplifierHelp(userId);
  }
  async handleStartCapture(userId: number, targetName: string): Promise<string>{
    return this.petCommandServiceSvc.handleStartCapture(userId, targetName);
  }
  async handleStopCapture(userId: number, targetName?: string): Promise<string>{
    return this.petCommandServiceSvc.handleStopCapture(userId, targetName);
  }
  private async updateOwnedSummonMode(
    userId: number,
    mode: 'follow' | 'idle' | 'active' | 'passive',
  ): Promise<{ count: number; map?: any }> {
    return this.supportSvc.updateOwnedSummonMode(userId, mode);
  }

  /**
   * 处理全部跟随命令
   * 使所有属于当前玩家的宠物/使魔跟随
   * 对应原版：全部跟随 命令
   */
  async handleFollowAll(userId: number): Promise<string>{
    return this.petCommandServiceSvc.handleFollowAll(userId);
  }
  async handleRefill(userId: number): Promise<string>{
    return this.delayedSettleServiceSvc.handleRefill(userId);
  }
  private async completeRefill(userId: number): Promise<void>{
    return this.delayedSettleServiceSvc.completeRefill(userId);
  }
  async handleMilk(userId: number, targetName?: string): Promise<string>{
    return this.petCommandServiceSvc.handleMilk(userId, targetName);
  }
  private async settleMilk( userId: number, targetName?: string, all = false, ): Promise<{ text: string; count: number; amount: number }>{
    return this.petCommandServiceSvc.settleMilk(userId, targetName, all);
  }
  private formatMilkRemaining(ms: number): string{
    return this.petCommandServiceSvc.formatMilkRemaining(ms);
  }
  private hasActiveMilkMarker(markers2: any[], name: string, now: number): boolean{
    return this.petCommandServiceSvc.hasActiveMilkMarker(markers2, name, now);
  }
  private isMilkSpecial(pet: any, name: '茸' | '青龙', specialSeq: number): boolean{
    return this.petCommandServiceSvc.isMilkSpecial(pet, name, specialSeq);
  }
  private getMilkAmount(pet: any): number{
    return this.petCommandServiceSvc.getMilkAmount(pet);
  }
  private addSummonMilkAffinity(pet: any, ownerIds: Set<string>): void{
    this.petCommandServiceSvc.addSummonMilkAffinity(pet, ownerIds);
  }
  async handleShear(userId: number, targetName: string): Promise<string>{
    return this.petCommandServiceSvc.handleShear(userId, targetName);
  }
  async handleAbandonQuest(userId: number, questName: string): Promise<string>{
    return this.questDialogueServiceSvc.handleAbandonQuest(userId, questName);
  }
  async handleMenu(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleMenu(userId);
  }
  async handleFunctionMenu(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleFunctionMenu(userId);
  }
  async handleGameMenu(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleGameMenu(userId);
  }
  async handleCalculate(userId: number, expression: string): Promise<string>{
    return this.questDialogueServiceSvc.handleCalculate(userId, expression);
  }
  async handleRefreshData(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleRefreshData(userId);
  }
  async handleReloadData(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleReloadData(userId);
  }
  async handleConfirmReloadData(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleConfirmReloadData(userId);
  }
  async handleGameIntro(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleGameIntro(userId);
  }
  async getFirstFamiliarGate(userId: number): Promise<string | null>{
    return this.questDialogueServiceSvc.getFirstFamiliarGate(userId);
  }
  private localTodayString(now = new Date()): string{
    return this.timeSettleServiceSvc.localTodayString(now);
  }
  async settleDailyLogin(userId: number): Promise<string>{
    return this.timeSettleServiceSvc.settleDailyLogin(userId);
  }
  async getActionHints(userId: number): Promise<string>{
    return this.timeSettleServiceSvc.getActionHints(userId);
  }
  private async hasTrainerAccess(player: any): Promise<boolean>{
    return this.timeSettleServiceSvc.hasTrainerAccess(player);
  }
  async handleGameTerms(userId: number, termName: string): Promise<string>{
    return this.questDialogueServiceSvc.handleGameTerms(userId, termName);
  }
  async handleMoreHelp(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleMoreHelp(userId);
  }
  async handleChangelog(userId: number): Promise<string>{
    return this.questDialogueServiceSvc.handleChangelog(userId);
  }
  async handleTrade(userId: number, action: string, args: string[]): Promise<string>{
    return this.shopTradeServiceSvc.handleTrade(userId, action, args);
  }
  private async withTradeLock<T>(key: string, fn: () => Promise<T>): Promise<T>{
    return this.shopTradeServiceSvc.withTradeLock(key, fn);
  }
  private async handleHomeTrade( userId: number, targetUserId: number, targetMapName: string, ): Promise<string>{
    return this.shopTradeServiceSvc.handleHomeTrade(userId, targetUserId, targetMapName);
  }
  async handleShop(userId: number, action: string, args: string[]): Promise<string>{
    return this.shopTradeServiceSvc.handleShop(userId, action, args);
  }
  async handleHelpMe(userId: number, question: string): Promise<string>{
    return this.questDialogueServiceSvc.handleHelpMe(userId, question);
  }
  async handleRecipe(userId: number, recipeName: string): Promise<string>{
    return this.shopTradeServiceSvc.handleRecipe(userId, recipeName);
  }
  async handleReverse(userId: number, targetName: string): Promise<string>{
    return this.shopTradeServiceSvc.handleReverse(userId, targetName);
  }
  private readReverseProficiencies(player: any): Array<{ name: string; value: number }>{
    return this.shopTradeServiceSvc.readReverseProficiencies(player);
  }
  private reverseProficiency(reverse: Array<{ name: string; value: number }>, itemName: string): number{
    return this.shopTradeServiceSvc.reverseProficiency(reverse, itemName);
  }
  private setReverseProficiency( reverse: Array<{ name: string; value: number }>, itemName: string, amount: number, ): number{
    return this.shopTradeServiceSvc.setReverseProficiency(reverse, itemName, amount);
  }
  private itemName(item: any): string {
    return this.supportSvc.itemName(item);
  }

  private itemType(item: any): string {
    return this.supportSvc.itemType(item);
  }

  private reverseValue(item: any): number{
    return this.shopTradeServiceSvc.reverseValue(item);
  }
  private reverseItemFailure( playerName: string, item: any, reverse: Array<{ name: string; value: number }>, ): string{
    return this.shopTradeServiceSvc.reverseItemFailure(playerName, item, reverse);
  }
  private reverseOne(item: any, reverse: Array<{ name: string; value: number }>): number{
    return this.shopTradeServiceSvc.reverseOne(item, reverse);
  }
  private reverseAllEligible( playerName: string, backpack: any[], reverse: Array<{ name: string; value: number }>, ): { count: number; items: Array<{ name: string; value: number }> }{
    return this.shopTradeServiceSvc.reverseAllEligible(playerName, backpack, reverse);
  }
  private formatReverseNumber(value: number): string {
    return this.supportSvc.formatReverseNumber(value);
  }

  private formatReverseMenu( playerName: string, reverse: Array<{ name: string; value: number }>, inProgress: boolean, ): string{
    return this.shopTradeServiceSvc.formatReverseMenu(playerName, reverse, inProgress);
  }
  private formatReverseBatchResult( playerName: string, count: number, items: Array<{ name: string; value: number }>, ): string{
    return this.shopTradeServiceSvc.formatReverseBatchResult(playerName, count, items);
  }
  private formatReverseSingleResult( playerName: string, item: any, value: number, reverse: Array<{ name: string; value: number }>, ): string{
    return this.shopTradeServiceSvc.formatReverseSingleResult(playerName, item, value, reverse);
  }
  private async saveReverseResult( userId: number, player: any, backpack: any[], reverse: Array<{ name: string; value: number }>, count: number, ): Promise<void>{
    return this.shopTradeServiceSvc.saveReverseResult(userId, player, backpack, reverse, count);
  }
  async handlePresetSwitch(userId: number, presetName: string): Promise<string>{
    return this.equipCommandServiceSvc.handlePresetSwitch(userId, presetName);
  }
  async handleRecharge(userId: number): Promise<string>{
    return this.timeSettleServiceSvc.handleRecharge(userId);
  }
  async handleRepairItem(userId: number, itemName: string): Promise<string>{
    return this.equipCommandServiceSvc.handleRepairItem(userId, itemName);
  }
  async handleReload(userId: number, targetName: string): Promise<string>{
    return this.delayedSettleServiceSvc.handleReload(userId, targetName);
  }
  private currentWeaponItem(player: any, weapons: any[]): any | null{
    return this.supportSvc.currentWeaponItem(player, weapons);
  }
  private equipmentSpecialSeq(item: any): number{
    return this.supportSvc.equipmentSpecialSeq(item);
  }
  private hasEquippedSpecial( playerData: any, equipmentName: string, specialSeq: number, ): boolean{
    return this.supportSvc.hasEquippedSpecial(playerData, equipmentName, specialSeq);
  }
  private incrementMarker(markers: Record<string, any>, key: string, amount: number): void {
    this.supportSvc.incrementMarker(markers, key, amount);
  }

  private normalizeMarkers2(markers2: any[]): void {
    this.supportSvc.normalizeMarkers2(markers2);
  }

  private scheduleReloadCompletion( userId: number, mode: 'plana' | 'organ', seconds: number, ): void{
    this.delayedSettleServiceSvc.scheduleReloadCompletion(userId, mode, seconds);
  }
  private async completeReload(userId: number, mode: string): Promise<void>{
    return this.delayedSettleServiceSvc.completeReload(userId, mode);
  }
  async handleSpawnArtisan(userId: number): Promise<string>{
    return this.dungeonChallengeServiceSvc.handleSpawnArtisan(userId);
  }
  async handleSpawnWreck(userId: number): Promise<string>{
    return this.dungeonChallengeServiceSvc.handleSpawnWreck(userId);
  }
  async handleDailyCheckin(userId: number): Promise<string>{
    return this.timeSettleServiceSvc.handleDailyCheckin(userId);
  }
  async handleTextSend(userId: number, content: string): Promise<string>{
    return this.questDialogueServiceSvc.handleTextSend(userId, content);
  }
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
    const backpack = asJsonValue<any[]>(targetPlayer.backpack, []);
    const equipment = asJsonValue<any[]>(targetPlayer.equipment, []);
    // 称号兼容两种形状：字符串（历史自动发放）/ {name, equipped}（领取/佩戴）
    const titles = asJsonValue<any[]>(targetPlayer.titles, [])
      .filter((t: any) => t)
      .map((t: any) => (typeof t === 'string' ? t : t.name))
      .filter(Boolean);

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
   * 超管特权「立即完成」共享实现：QQ 指令与 Web REST 静默端点（读条按钮）双入口，
   * 单一实现（统一调用约定）。结构化返回，调用方自行决定呈现——
   * QQ 取 message 作文本回包，Web 按 ok/message 弹 Toast。
   */
  async finishNowForUser(userId: number): Promise<{ ok: boolean; completed: number; message: string }>{
    return this.adminCommandServiceSvc.finishNowForUser(userId);
  }
  async handleAdminFinishNow(userId: number): Promise<string>{
    return this.adminCommandServiceSvc.handleAdminFinishNow(userId);
  }
  async handleAdminCommand(userId: number, args: string[]): Promise<string>{
    return this.adminCommandServiceSvc.handleAdminCommand(userId, args);
  }
  private getAdminHelpText(): string{
    return this.adminCommandServiceSvc.getAdminHelpText();
  }
  private async handleAdminStatus(): Promise<string>{
    return this.adminCommandServiceSvc.handleAdminStatus();
  }
  private async handleAdminAnnounce(args: string[]): Promise<string>{
    return this.adminCommandServiceSvc.handleAdminAnnounce(args);
  }
  private async handleAdminSetWorldLevel(args: string[]): Promise<string>{
    return this.adminCommandServiceSvc.handleAdminSetWorldLevel(args);
  }
  private async handleAdminGiveItem(args: string[]): Promise<string>{
    return this.adminCommandServiceSvc.handleAdminGiveItem(args);
  }
  private async handleAdminPlayerList(args: string[]): Promise<string>{
    return this.adminCommandServiceSvc.handleAdminPlayerList(args);
  }
  private async handleAdminToggleBan(args: string[], isBan: boolean): Promise<string>{
    return this.adminCommandServiceSvc.handleAdminToggleBan(args, isBan);
  }
  private async handleAdminUpdateConfig(args: string[]): Promise<string>{
    return this.adminCommandServiceSvc.handleAdminUpdateConfig(args);
  }
  private async handleAdminUserList(args: string[]): Promise<string>{
    return this.adminCommandServiceSvc.handleAdminUserList(args);
  }
  private async handleAdminBanByQQ(userId: number, args: string[]): Promise<string>{
    return this.adminCommandServiceSvc.handleAdminBanByQQ(userId, args);
  }
  private async handleAdminResetPlayer(userId: number, args: string[]): Promise<string>{
    return this.adminCommandServiceSvc.handleAdminResetPlayer(userId, args);
  }
  private async handleAdminModifyPlayer(userId: number, args: string[]): Promise<string>{
    return this.adminCommandServiceSvc.handleAdminModifyPlayer(userId, args);
  }
  private async handleAdminIntervalMessage(userId: number, args: string[]): Promise<string>{
    return this.adminCommandServiceSvc.handleAdminIntervalMessage(userId, args);
  }
  private async handleAdminBroadcast(userId: number, args: string[]): Promise<string>{
    return this.adminCommandServiceSvc.handleAdminBroadcast(userId, args);
  }
  private formatUptime(seconds: number): string {
    return this.supportSvc.formatUptime(seconds);
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
    return this.timeSettleServiceSvc.calculateTimeElapsed(userId, opts);
  }
  async settleTimeElapsedOnDisconnect(userId: number): Promise<void>{
    return this.timeSettleServiceSvc.settleTimeElapsedOnDisconnect(userId);
  }
  async settleTimeElapsedOnReconnect(userId: number): Promise<string>{
    return this.timeSettleServiceSvc.settleTimeElapsedOnReconnect(userId);
  }
  private mutateForTimeElapsed( userId: number, opts: { force?: boolean; showBanner?: boolean }, ): Promise<string>{
    return this.timeSettleServiceSvc.mutateForTimeElapsed(userId, opts);
  }
  async getCurrentMap(userId: number): Promise<any> {
    return this.supportSvc.getCurrentMap(userId);
  }

  /**
   * 更新地图的建筑数据
   * @param mapId 地图ID
   * @param buildingsJson 建筑数据JSON字符串
   */
  async updateMapBuildings(mapId: number, buildingsJson: string, resources2Json?: string): Promise<void>{
    return this.homeBuildServiceSvc.updateMapBuildings(mapId, buildingsJson, resources2Json);
  }
  async handleHelpUp(userId: number): Promise<string>{
    return this.rescueWhiteServiceSvc.handleHelpUp(userId);
  }
  private parseRescueArray(value: any): any[]{
    return this.rescueWhiteServiceSvc.parseRescueArray(value);
  }
  private parseRescueMarkers(value: any): any[]{
    return this.rescueWhiteServiceSvc.parseRescueMarkers(value);
  }
  private createRescueMarker( rescueType: 'self' | 'familiar' | 'vehicle' | 'player', seconds: number, extra: Record<string, any> = {}, ): any{
    return this.rescueWhiteServiceSvc.createRescueMarker(rescueType, seconds, extra);
  }
  private getActiveRescueMarker(markers2: any[]): any | null{
    return this.rescueWhiteServiceSvc.getActiveRescueMarker(markers2);
  }
  private rescueExpireAtSeconds(marker: any): number{
    return this.rescueWhiteServiceSvc.rescueExpireAtSeconds(marker);
  }
  private remainingRescueSeconds(marker: any): number{
    return this.rescueWhiteServiceSvc.remainingRescueSeconds(marker);
  }
  private rescueActionText(type: string): string{
    return this.rescueWhiteServiceSvc.rescueActionText(type);
  }
  private formatRescueSeconds(seconds: number): number{
    return this.rescueWhiteServiceSvc.formatRescueSeconds(seconds);
  }
  private rescueHp(unit: any): number{
    return this.rescueWhiteServiceSvc.rescueHp(unit);
  }
  private rescueMaxHp(unit: any): number{
    return this.rescueWhiteServiceSvc.rescueMaxHp(unit);
  }
  private firstPositiveNumber(...values: any[]): number {
    return this.supportSvc.firstPositiveNumber(...values);
  }

  private parseRescueObject(value: any): any{
    return this.rescueWhiteServiceSvc.parseRescueObject(value);
  }
  private setRescueHp(unit: any, hp: number): void{
    this.rescueWhiteServiceSvc.setRescueHp(unit, hp);
  }
  private rescueUnitId(unit: any): string{
    return this.rescueWhiteServiceSvc.rescueUnitId(unit);
  }
  private rescueUnitName(unit: any): string{
    return this.rescueWhiteServiceSvc.rescueUnitName(unit);
  }
  private rescueVehicleKey(summon: any): string{
    return this.rescueWhiteServiceSvc.rescueVehicleKey(summon);
  }
  private rescueVehicleKeys(vehicle: any): Set<string>{
    return this.rescueWhiteServiceSvc.rescueVehicleKeys(vehicle);
  }
  private rescueVehicleMaxHp(vehicle: any): number{
    return this.rescueWhiteServiceSvc.rescueVehicleMaxHp(vehicle);
  }
  private rescueVehicleHp(vehicle: any): number{
    return this.rescueWhiteServiceSvc.rescueVehicleHp(vehicle);
  }
  private isDamagedRescueVehicle(vehicle: any): boolean{
    return this.rescueWhiteServiceSvc.isDamagedRescueVehicle(vehicle);
  }
  private setRescueVehicleHp(vehicle: any, hp: number): void{
    this.rescueWhiteServiceSvc.setRescueVehicleHp(vehicle, hp);
  }
  private hasActiveRescueBuff(value: any): boolean{
    return this.rescueWhiteServiceSvc.hasActiveRescueBuff(value);
  }
  private shortenRescueBuff(buffs: any[], name: string, seconds: number): boolean{
    return this.rescueWhiteServiceSvc.shortenRescueBuff(buffs, name, seconds);
  }
  private async saveRescueMap(map: any, summons: any[], vehicles: any[]): Promise<void>{
    return this.rescueWhiteServiceSvc.saveRescueMap(map, summons, vehicles);
  }
  private async claimRescueMarker(userId: number, token: string): Promise<boolean>{
    return this.rescueWhiteServiceSvc.claimRescueMarker(userId, token);
  }
  private async scheduleRescueCompletion(userId: number, marker: any): Promise<void>{
    return this.rescueWhiteServiceSvc.scheduleRescueCompletion(userId, marker);
  }
  private async completeRescue(userId: number, marker: any): Promise<string>{
    return this.rescueWhiteServiceSvc.completeRescue(userId, marker);
  }
  private async applyCompleteRescue(userId: number, marker: any): Promise<string>{
    return this.rescueWhiteServiceSvc.applyCompleteRescue(userId, marker);
  }
  private async applyWhiteAngelRevivalTeleport(userId: number, player: any): Promise<string>{
    return this.rescueWhiteServiceSvc.applyWhiteAngelRevivalTeleport(userId, player);
  }
  private async materializeWhiteSummon( player: any, map: any, markers: Record<string, any>, ): Promise<void>{
    return this.rescueWhiteServiceSvc.materializeWhiteSummon(player, map, markers);
  }
  async ensurePlayerWhite(player: any, map: any): Promise<any | null>{
    return this.rescueWhiteServiceSvc.ensurePlayerWhite(player, map);
  }
  private async syncWhiteAffinity( player: any, white: any, markers: Record<string, any>, mapId: number, ): Promise<void>{
    return this.rescueWhiteServiceSvc.syncWhiteAffinity(player, white, markers, mapId);
  }
  private async resolveRespawnMapId(allMaps: any[], fromMapId: number): Promise<number>{
    return this.rescueWhiteServiceSvc.resolveRespawnMapId(allMaps, fromMapId);
  }
  private findWhiteAngelMapId( allMaps: any[], isOwnWhite: (unit: any) => boolean, parseSummons: (map: any) => any[], ): number{
    return this.rescueWhiteServiceSvc.findWhiteAngelMapId(allMaps, isOwnWhite, parseSummons);
  }
  async handleCallVehicle(userId: number, vehicleName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const currentMap = await this.mapService.getMapById(player.mapId);
    if (!currentMap) return `${player.name || '冒险者'}不在服务区`;

    // 原版 建筑要求("通讯台") 同时检查地图建筑和当前驾驶载具的部件。
    const currentBuildings = asJsonValue<any[]>(currentMap.buildings, []);
    const currentVehicles = asJsonValue<any[]>(currentMap.vehicles, []);
    const currentVehicle = currentVehicles.find((vehicle: any) =>
      String(vehicle?.id ?? vehicle?.编号 ?? '') === String(player.vehicle || ''),
    );
    const currentVehicleParts = asJsonValue<any[]>(currentVehicle?.parts, []);
    const hasCommunication = currentBuildings.some((building: any) =>
      (building?.name ?? building?.名称) === '通讯台',
    ) || currentVehicleParts.some((part: any) =>
      (part?.name ?? part?.名称) === '通讯台',
    );

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const ownerIds = new Set([
      String(userId),
      String(player.id),
      String(user?.qqNumber || ''),
      String(user?.externalId || ''),
      String(player.masterQQ || ''),
    ].filter(Boolean));
    const jsonArray = (value: any): any[] => asJsonValue<any[]>(value, []);
    const ownerOf = (unit: any): boolean => ownerIds.has(String(
      unit?.ownerQQ ?? unit?.归属 ?? unit?.owner ?? '',
    ));
    const markerValue = (unit: any, markerName: string): number => {
      const raw = unit?.markers ?? unit?.标记 ?? {};
      const parsed = typeof raw === 'string' ? asJsonValue<any>(raw, {}) : raw;
      if (Array.isArray(parsed)) {
        const item = parsed.find((x: any) => (x?.name ?? x?.名称) === markerName);
        return Number(item?.value ?? item?.数值 ?? item?.count ?? 0);
      }
      return Number(parsed?.[markerName] ?? 0);
    };
    const allMaps = await this.mapService.getAllMaps();
    const candidates: Array<{ kind: 'pet' | 'vehicle'; map: any; unit: any; index: number }> = [];
    for (const map of allMaps) {
      for (const [index, unit] of jsonArray(map.summons).entries()) {
        if (ownerOf(unit)) candidates.push({ kind: 'pet', map, unit, index });
      }
      for (const [index, unit] of jsonArray(map.vehicles).entries()) {
        if (ownerOf(unit)) candidates.push({ kind: 'vehicle', map, unit, index });
      }
    }

    const rawTarget = (vehicleName || '').trim();
    if (!rawTarget) {
      if (candidates.length === 0 && !hasCommunication) return `${player.name || '冒险者'}没有可以呼叫的对象`;
      const lines = [`${player.name || '冒险者'}选择你想叫到身边的对象:`];
      if (hasCommunication) {
        lines.push(`行商`);
        lines.push(`神之工匠`);
      }
      candidates.forEach((candidate, index) => {
        const label = candidate.unit.name ?? candidate.unit.名称 ?? candidate.unit.type ?? candidate.unit.类型 ?? '未命名';
        lines.push(`${(hasCommunication ? 2 : 0) + index + 1}、${label}(${candidate.map.name})`);
      });
      return lines.join('\n');
    }

    // 原版使用“宠物QQ/载具编号”快捷前缀；名称本身也可能以“宠物”开头，
    // 因此先保留完整名称命中，再解析快捷前缀，避免“宠物甲”被截成“甲”。
    const exactRawTarget = candidates.some((candidate) => {
      const unit = candidate.unit;
      return String(unit.qq ?? unit.QQ ?? unit.id ?? unit.编号 ?? '') === rawTarget
        || (unit.name ?? unit.名称 ?? '') === rawTarget
        || (unit.image ?? unit.图片 ?? '') === rawTarget;
    });
    const explicitKind: 'pet' | 'vehicle' | undefined = exactRawTarget
      ? undefined
      : rawTarget.startsWith('宠物')
        ? 'pet'
        : rawTarget.startsWith('载具')
          ? 'vehicle'
          : undefined;
    const target = explicitKind ? rawTarget.substring(2) : rawTarget;
    if (target === '行商') {
      if (!hasCommunication) {
        return `${player.name || '冒险者'}需要建筑【通讯台】`;
      }
      const homeMap = player.houseName ? await this.mapService.getMapByName(player.houseName) : null;
      if (!homeMap) {
        return `${player.name || '冒险者'}#错误:玩家${user?.qqNumber || userId}(${player.name || '冒险者'})的院子[${player.houseName || ''}]在地图列表不存在`;
      }

      const nowMs = Date.now();
      const nowSec = nowMs / 1000;
      const hour = new Date(nowMs).getHours();
      const slot = hour < 12
        ? { name: '通讯1', message: '12点才能再次使用' }
        : hour >= 18
          ? { name: '通讯2', message: '0点才能再次使用' }
          : { name: '通讯3', message: '18点才能再次使用' };
      const existingSlotMarkers = jsonArray(player.markers2);
      const hadFreeCall = existingSlotMarkers.some((marker: any) => {
        const name = marker?.name ?? marker?.名称;
        const rawExpire = Number(marker?.expireAt ?? marker?.有效期至 ?? 0);
        const expireSec = rawExpire > 100000000000 ? rawExpire / 1000 : rawExpire;
        return name === slot.name && expireSec > nowSec;
      });
      const markers2 = existingSlotMarkers.filter((marker: any) => {
        const name = marker?.name ?? marker?.名称;
        if (name !== slot.name) return true;
        const rawExpire = Number(marker?.expireAt ?? marker?.有效期至 ?? 0);
        const expireSec = rawExpire > 100000000000 ? rawExpire / 1000 : rawExpire;
        return expireSec > nowSec;
      });
      const backpack = this.playerService.getBackpackItems(player);
      let merchantLevel = 0;
      let extraText = '';
      if (hadFreeCall) {
        const band = backpack.find((item: any) => (item?.name ?? item?.名称) === '发带');
        const bandCount = this.itemQuantity(band);
        if (bandCount < 1) return `${player.name || '冒险者'}${slot.message}`;
        const affinity = (10 + this.achievementService.getAchievement(markers, '购物') / 100) / 2;
        const maxLevel = 3 + Math.floor(affinity / 5);
        merchantLevel = bandCount >= maxLevel ? maxLevel : Math.trunc(bandCount);
        this.deductBackpackItem(backpack, '发带', merchantLevel);
        extraText = `,消耗发带${merchantLevel},还有${bandCount - merchantLevel}`;
      } else {
        const endOfDay = new Date(nowMs);
        endOfDay.setHours(24, 0, 0, 0);
        markers2.push({ name: slot.name, expireAt: endOfDay.getTime() / 1000 });
      }

      const affinityChance = (10 + this.achievementService.getAchievement(markers, '购物') / 100) / 2;
      let extraCount = 0;
      let triggerText = '';
      for (let i = 0; i < merchantLevel; i++) {
        if (Math.random() * 100 < affinityChance) {
          extraCount++;
          if (!triggerText) triggerText = `,并带来了更多物品。[行商好感触发,${this.round2Text(affinityChance)}%]`;
        }
      }
      const homeSummons = asJsonValue<any[]>(homeMap.summons, [])
        .filter((summon: any) => (summon?.name ?? summon?.名称) !== '行商');
      const inventory = await this.generateMerchantInventory(merchantLevel, extraCount);
      homeSummons.push({
        name: '行商',
        type: '行商',
        ownerQQ: '',
        qq: `召唤物${nowMs}`,
        level: merchantLevel,
        backpack: inventory, // GameMap.summons 为 Json 列，直接写结构体
        markers: {},
        markers2: [],
        buffs: [],
      });
      this.achievementService.setAchievement(markers, '呼叫行商', this.achievementService.getAchievement(markers, '呼叫行商') + merchantLevel);
      this.achievementService.setAchievement(markers, '呼叫', this.achievementService.getAchievement(markers, '呼叫') + merchantLevel);
      player.markers = markers;
      player.backpack = backpack; // Json 列直接写数组
      player.markers2 = markers2; // Json 列直接写数组
      await this.mapService.updateDynamicFields(homeMap.id, { summons: homeSummons });
      await this.playerService.savePlayer(player);
      // 原版 L5971-L5972：免费呼叫等级为0，不推进；发带呼叫按实际行商等级推进。
      if (merchantLevel > 0) {
        await this.advanceTask(userId, '呼叫行商', merchantLevel);
        await this.advanceTask(userId, '呼叫', merchantLevel);
      }
      return `行商来到了${homeMap.name}院子里${extraText}${triggerText}`;
    }

    if (target === '神之工匠') {
      const nowMs = Date.now();
      const nowSec = nowMs / 1000;
      const markers2 = jsonArray(player.markers2).filter((marker: any) => {
        const name = marker?.name ?? marker?.名称;
        const rawExpire = Number(marker?.expireAt ?? marker?.有效期至 ?? 0);
        const expireSec = rawExpire > 100000000000 ? rawExpire / 1000 : rawExpire;
        return name !== '通讯4' || expireSec <= nowSec;
      });
      const hasCooldown = jsonArray(player.markers2).some((marker: any) => {
        const name = marker?.name ?? marker?.名称;
        const rawExpire = Number(marker?.expireAt ?? marker?.有效期至 ?? 0);
        const expireSec = rawExpire > 100000000000 ? rawExpire / 1000 : rawExpire;
        return name === '通讯4' && expireSec > nowSec;
      });
      const backpack = this.playerService.getBackpackItems(player);
      if (hasCooldown) {
        const spirit = backpack.find((item: any) => (item?.name ?? item?.名称) === '灵石');
        if (this.itemQuantity(spirit) < 10) return `${player.name || '冒险者'}明天才能再次使用`;
        this.deductBackpackItem(backpack, '灵石', 10);
      } else {
        const endOfDay = new Date(nowMs);
        endOfDay.setHours(24, 0, 0, 0);
        markers2.push({ name: '通讯4', expireAt: endOfDay.getTime() / 1000 });
      }
      const summons = jsonArray(currentMap.summons).filter((summon: any) =>
        (summon?.qq ?? summon?.QQ) !== 'npc1g' && (summon?.qq ?? summon?.QQ) !== 'npc2g',
      );
      summons.push(
        { name: '神之工匠', type: '粉狐狐', qq: 'npc1g', ownerQQ: '1', hp: 100, maxHp: 100, markers: '{}', markers2: '[]', buffs: '[]' },
        { name: '小雫', type: '精英小雫', qq: 'npc2g', ownerQQ: '1', hp: 100, maxHp: 100, markers: '{}', markers2: '[]', buffs: '[]' },
      );
      player.backpack = backpack; // Json 列直接写数组
      player.markers2 = markers2; // Json 列直接写数组
      await this.mapService.updateDynamicFields(currentMap.id, { summons });
      await this.playerService.savePlayer(player);
      const greetings = ['我闻到了好闻的灵石味道！', '这些灵石都是你的吗？', '看来有人需要帮忙呢！'];
      const greeting = greetings[Math.floor(Math.random() * greetings.length)];
      return `【粉狐狐】“${greeting}”#换行神之工匠带着她的狐娘女仆来到了${currentMap.name}`;
    }

    const matched = candidates.find((candidate) => {
      if (explicitKind && candidate.kind !== explicitKind) return false;
      const unit = candidate.unit;
      return String(unit.qq ?? unit.QQ ?? unit.id ?? unit.编号 ?? '') === target
        || (unit.name ?? unit.名称 ?? '') === target
        || (unit.image ?? unit.图片 ?? unit.type ?? unit.类型 ?? '') === target;
    });
    if (!matched) return `${player.name || '冒险者'}你呼叫的对象${rawTarget}不在服务区`;

    if (matched.kind === 'pet') {
      // 对齐原版 L6045：先调用 计算幼崽 更新成长计时，再检查标记
      this.familiarSystemService.checkAndUpdateGrowth(matched.unit);
      if (markerValue(matched.unit, '阵地') !== 0) {
        return `${player.name || '冒险者'}\n${matched.unit.name ?? matched.unit.名称}防御阵地不能移动`;
      }
      if (markerValue(matched.unit, '幼崽') !== 0) {
        return `${player.name || '冒险者'}\n${matched.unit.name ?? matched.unit.名称}还是宝宝，不能离开家`;
      }
    } else if (Number(matched.unit.moveType ?? matched.unit.行走方式 ?? 0) === 4) {
      return `${player.name || '冒险者'}${matched.unit.name ?? matched.unit.名称}安装了无法移动的组件`;
    }

    const targetSummons = jsonArray(currentMap.summons);
    const targetVehicles = jsonArray(currentMap.vehicles);
    const sameMap = Number(matched.map.id) === Number(currentMap.id);
    const sourceMap = matched.map;
    const sourceSummons = sameMap ? targetSummons : jsonArray(sourceMap.summons);
    const sourceVehicles = sameMap ? targetVehicles : jsonArray(sourceMap.vehicles);
    let carriedVehicle: any = null;
    if (matched.kind === 'pet') {
      sourceSummons.splice(matched.index, 1);
      targetSummons.push(matched.unit);
      // 原版召唤物移动时会携带其驾驶的载具。
      const petVehicleId = matched.unit.vehicle ?? matched.unit.载具 ?? '';
      if (petVehicleId) {
        const vehicleIndex = sourceVehicles.findIndex((v: any) =>
          String(v.id ?? v.编号 ?? '') === String(petVehicleId),
        );
        if (vehicleIndex >= 0) {
          carriedVehicle = sourceVehicles[vehicleIndex];
          const carriedMoveType = Number(carriedVehicle.moveType ?? carriedVehicle.行走方式 ?? 0);
          // 原版“召唤物移动2”只携带可移动载具；行走方式4的载具留在原地图。
          if (carriedMoveType !== 4 && !sameMap) {
            targetVehicles.push(...sourceVehicles.splice(vehicleIndex, 1));
          }
        }
      }
    } else {
      sourceVehicles.splice(matched.index, 1);
      targetVehicles.push(matched.unit);
    }
    if (sameMap) {
      await this.mapService.updateDynamicFields(currentMap.id, {
        summons: targetSummons,
        vehicles: targetVehicles,
      });
    } else {
      await this.mapService.updateDynamicFields(sourceMap.id, {
        summons: sourceSummons,
        vehicles: sourceVehicles,
      });
      await this.mapService.updateDynamicFields(currentMap.id, {
        summons: targetSummons,
        vehicles: targetVehicles,
      });
    }
    const label = matched.unit.name ?? matched.unit.名称 ?? '对象';
    let result: string;
    if (matched.kind === 'pet') {
      const moveType = Number(carriedVehicle?.moveType ?? carriedVehicle?.行走方式 ?? 0);
      const vehicleLabel = carriedVehicle?.name ?? carriedVehicle?.名称 ?? '载具';
      const suffix = !carriedVehicle
        ? '跑到了'
        : moveType === 4
          ? `的${vehicleLabel}安装了无法移动的组件，${label}丢下${vehicleLabel}跑到了`
          : moveType === 0
            ? `拖着${vehicleLabel}跑到了`
            : moveType === 1
              ? `驾驶${vehicleLabel}一路疾驰来到了`
              : moveType === 2
                ? `操纵${vehicleLabel}飞到了`
                : `操纵${vehicleLabel}跃迁到了`;
      result = `${label}${suffix}${currentMap.name}`;
    } else {
      const moveType = Number(matched.unit.moveType ?? matched.unit.行走方式 ?? 0);
      const suffix = moveType === 0
        ? '被拖到了'
        : moveType === 1
          ? '挪到了'
          : moveType === 2
            ? '飞到了'
            : '跃迁到了';
      result = `${player.name || '冒险者'}\n${label}${suffix}${currentMap.name}`;
    }

    // 原版普通宠物/载具分支 L6066-L6087 会添加“呼叫”成就并同步任务；
    // 统一放在服务层，避免不同入口（网页/机器人/直接调用）重复或漏记。
    const callMarkers = playerData.markers && typeof playerData.markers === 'object'
      ? playerData.markers
      : asJsonValue<any>(player.markers, {});
    this.achievementService.setAchievement(
      callMarkers,
      '呼叫',
      this.achievementService.getAchievement(callMarkers, '呼叫') + 1,
    );
    player.markers = callMarkers;
    await this.playerService.savePlayer(player);
    await this.advanceTask(userId, '呼叫');
    return result;
  }

  /**
   * 安装全部不占用位置的建筑。
   * 对应原版 _主程序.ecode L1859-1931；这里的“部件”是原版建筑资源，
   * 与「安装」命令的载具部件分支不同。
   */
  async handleInstallAll(userId: number): Promise<string>{
    return this.homeBuildServiceSvc.handleInstallAll(userId);
  }
  async handleUninstallAll(userId: number): Promise<string>{
    return this.homeBuildServiceSvc.handleUninstallAll(userId);
  }
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
  async handleEquipEnhance(userId: number, arg: string): Promise<string>{
    return this.equipCommandServiceSvc.handleEquipEnhance(userId, arg);
  }
  async handleEquipBonus(userId: number, itemName: string): Promise<string>{
    return this.equipCommandServiceSvc.handleEquipBonus(userId, itemName);
  }
  async handleEquipPreset(userId: number, action: string, args: string[]): Promise<string>{
    return this.equipCommandServiceSvc.handleEquipPreset(userId, action, args);
  }
  private listEquipPresets(player: any, presets: any[]): string{
    return this.equipCommandServiceSvc.listEquipPresets(player, presets);
  }
  private async calcPresetBonus(player: any, preset: any): Promise<Record<string, number>>{
    return this.equipCommandServiceSvc.calcPresetBonus(player, preset);
  }
  private formatBonusText(bonus: Record<string, number>): string{
    return this.equipCommandServiceSvc.formatBonusText(bonus);
  }
  async handleActivityShop(userId: number, itemName: string): Promise<string>{
    return this.shopTradeServiceSvc.handleActivityShop(userId, itemName);
  }
  async handleDiamondShop(userId: number, itemName: string): Promise<string>{
    return this.shopTradeServiceSvc.handleDiamondShop(userId, itemName);
  }
  async handleDataShop(userId: number, itemName: string): Promise<string>{
    return this.shopTradeServiceSvc.handleDataShop(userId, itemName);
  }
  async handleProbeRadar(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    // 成就熟练度存于玩家标记中
    const markers = asJsonValue<Record<string, number>>(player.markers, {});

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
      const connections = asJsonValue<any[]>(map.connections, []);
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

    // 原版 雷达扫描共十类目标（_主程序.ecode L3044-L3273）：
    // 副本入口/行商/神之工匠/露娜/小恶魔/废弃载具/花园宝宝/小白狐/货舱/能量元素。
    // 显示精度随雷达等级变化；获得物品() 按显示名合并数量，
    // 花园宝宝/小白狐/货舱/能量元素超过3条时只显示前三名+总数。
    const near = (map: any) => `${map.respawnPoint || map.name}附近`;
    const mergeEntries = (list: Array<{ name: string; count: number }>): [string, number][] => {
      const merged = new Map<string, number>();
      for (const e of list) merged.set(e.name, (merged.get(e.name) || 0) + e.count);
      return [...merged.entries()];
    };
    const formatEntries = (entries: [string, number][], topN = 0): string => {
      const sorted = [...entries].sort((a, b) => b[1] - a[1]);
      const shown = topN > 0 && sorted.length > topN ? sorted.slice(0, topN) : sorted;
      const body = shown.map(([n, c]) => `${n}x${c}`).join('、');
      if (topN > 0 && sorted.length > topN) {
        const total = sorted.reduce((s, [, c]) => s + c, 0);
        return `${body}…等共${total}`;
      }
      return body;
    };

    // ◆行商/花园宝宝/小白狐/露娜：召唤物（原版 L3065-L3079、L3136-L3203）
    const merchantEntries: Array<{ name: string; count: number }> = [];
    const gardenBabyEntries: Array<{ name: string; count: number }> = [];
    const whiteFoxEntries: Array<{ name: string; count: number }> = [];
    const lunaEntries: Array<{ name: string; count: number }> = [];
    // ◆神之工匠：NPC（原版 L3083-L3093，QQ=npc1g）
    const artisanEntries: Array<{ name: string; count: number }> = [];
    for (const map of maps) {
      const summons = asJsonValue<any[]>(map.summons, []);
      for (const s of summons) {
        const sName = String(s?.name ?? s?.名称 ?? '');
        if (sName === '行商') {
          merchantEntries.push({ name: level >= 5 ? map.name : near(map), count: 1 });
        } else if (sName === '花园宝宝') {
          gardenBabyEntries.push({ name: level >= 6 ? map.name : near(map), count: 1 });
        } else if (sName === '小白狐') {
          whiteFoxEntries.push({ name: level >= 6 ? map.name : near(map), count: 1 });
        } else if (sName === '露娜' || s?.qq === '怪物露娜1g') {
          lunaEntries.push({ name: near(map), count: 1 });
        }
      }
      const npcs = asJsonValue<any[]>(map.npcs, []);
      for (const n of npcs) {
        if (String(n?.name ?? n?.名称 ?? '') === '神之工匠' || n?.qq === 'npc1g') {
          artisanEntries.push({ name: near(map), count: 1 });
        }
      }
    }
    if (merchantEntries.length > 0) {
      w += `\n◆行商: ${formatEntries(mergeEntries(merchantEntries))}`;
    }
    if (artisanEntries.length > 0) {
      w += `\n◆神之工匠: ${formatEntries(mergeEntries(artisanEntries))}`;
    }
    if (lunaEntries.length > 0) {
      w += `\n◆露娜: ${formatEntries(mergeEntries(lunaEntries))}`;
    }

    // ◆小恶魔：临时怪物表（原版 怪物2，QQ=怪物小恶魔1，恒显示复活点附近）
    const demonEntries: Array<{ name: string; count: number }> = [];
    try {
      const demons = await this.prisma.gameMonster.findMany({
        where: { qq: '怪物小恶魔1', hp: { gt: 0 } },
        select: { mapId: true },
      });
      const mapById = new Map<number, any>((maps as any[]).map((m: any) => [Number(m.id), m]));
      const demonCountByMap = new Map<number, number>();
      for (const d of demons) {
        demonCountByMap.set(d.mapId, (demonCountByMap.get(d.mapId) || 0) + 1);
      }
      for (const [mapId, count] of demonCountByMap) {
        const map = mapById.get(mapId);
        if (map) demonEntries.push({ name: near(map), count });
      }
    } catch {
      // 临时怪物表不可用时跳过小恶魔扫描，不影响其他雷达目标
    }
    if (demonEntries.length > 0) {
      w += `\n◆小恶魔: ${formatEntries(mergeEntries(demonEntries))}`;
    }

    // ◆废弃载具：无主载具（原版 L3122-L3133，恒显示复活点附近）
    const wreckEntries: Array<{ name: string; count: number }> = [];
    for (const map of maps) {
      const vehicles = asJsonValue<any[]>(map.vehicles, []);
      const wreckCount = vehicles.filter(
        (v: any) => String(v?.owner ?? v?.归属 ?? '') === '无主',
      ).length;
      if (wreckCount > 0) wreckEntries.push({ name: near(map), count: wreckCount });
    }
    if (wreckEntries.length > 0) {
      w += `\n◆废弃载具: ${formatEntries(mergeEntries(wreckEntries))}`;
    }

    if (gardenBabyEntries.length > 0) {
      w += `\n◆花园宝宝: ${formatEntries(mergeEntries(gardenBabyEntries), 3)}`;
    }
    if (whiteFoxEntries.length > 0) {
      w += `\n◆小白狐: ${formatEntries(mergeEntries(whiteFoxEntries), 3)}`;
    }

    // ◆货舱 / ◆能量元素：扫描所有地图资源中名称匹配的资源（对应原版 L3205-L3251）
    const cargoEntries: Array<{ name: string; count: number }> = [];
    const energyEntries: Array<{ name: string; count: number }> = [];
    for (const map of maps) {
      const resources = asJsonValue<any[]>(map.resources, []);
      for (const res of resources) {
        const resName = res?.name || '';
        if (resName.includes('货舱')) {
          cargoEntries.push({ name: level === 0 ? near(map) : map.name, count: Number(res.times) || 1 });
        } else if (resName.includes('能量元素')) {
          energyEntries.push({ name: level <= 1 ? near(map) : map.name, count: Number(res.times) || 1 });
        }
      }
    }
    if (cargoEntries.length > 0) {
      w += `\n◆货舱: ${formatEntries(mergeEntries(cargoEntries), 3)}`;
    }
    if (energyEntries.length > 0) {
      w += `\n◆能量元素: ${formatEntries(mergeEntries(energyEntries), 3)}`;
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
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

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
      const resources = asJsonValue<any[]>(map.resources, []);
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
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

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
        const items = asJsonValue<any[]>(map.items, []);
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
      const items = asJsonValue<any[]>(map.items, []);
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
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    // 需要建筑[矿物探测器]（对应原版 建筑要求）
    if (!(await this.hasBuildingOnMap(userId, '矿物探测器'))) {
      return `${player.name}需要建筑[矿物探测器]`;
    }

    const maps = await this.mapService.getAllMaps();

    // 收集地图上的作物：优先 resources2(可采集资源)，其次 resources(带产出2的使魔资源)
    const cropsByMap: { mapName: string; crops: { name: string; times: number }[] }[] = [];
    for (const map of maps) {
      const res2 = asJsonValue<any[]>(map.resources2, []);
      const res = asJsonValue<any[]>(map.resources, []);
      const cropList: { name: string; times: number }[] = [];
      for (const r of res2) {
        if (this.parseResourceOutputs(r.outputs2 ?? r['产出2']).length > 0) {
          cropList.push({ name: r.name, times: r.quantity || r.count || r.times || 1 });
        }
      }
      for (const r of res) {
        if (this.parseResourceOutputs(r.outputs2 ?? r['产出2']).length > 0 && !cropList.some((c) => c.name === r.name)) {
          cropList.push({ name: r.name, times: r.quantity || r.count || r.times || 1 });
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
    const buildings = asJsonValue<any[]>(map.buildings, []);
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
  async handlePetOps(userId: number, action: string, args: string[]): Promise<string>{
    return this.petCommandServiceSvc.handlePetOps(userId, action, args);
  }
  async handlePetRename(userId: number, petName: string, newName: string): Promise<string>{
    return this.petCommandServiceSvc.handlePetRename(userId, petName, newName);
  }
  async handlePetTransfer(userId: number, petName: string, targetPlayer: string): Promise<string>{
    return this.petCommandServiceSvc.handlePetTransfer(userId, petName, targetPlayer);
  }
  async handlePetDrive(userId: number, petName: string, vehicleName = '原'): Promise<string>{
    return this.petCommandServiceSvc.handlePetDrive(userId, petName, vehicleName);
  }
  async handlePetFeed(userId: number, petName: string, count = 1): Promise<string>{
    return this.petCommandServiceSvc.handlePetFeed(userId, petName, count);
  }
  async handlePetSniff(userId: number, targetName: string, monsterName = ''): Promise<string>{
    return this.petCommandServiceSvc.handlePetSniff(userId, targetName, monsterName);
  }
  async handlePetAwaken(userId: number, petName: string, count = '1'): Promise<string>{
    return this.petCommandServiceSvc.handlePetAwaken(userId, petName, count);
  }
  async handlePetAttack(userId: number, targetName: string): Promise<string>{
    return this.petCommandServiceSvc.handlePetAttack(userId, targetName);
  }
  async handlePetGoto(userId: number, targetName: string, mapName = ''): Promise<string>{
    return this.petCommandServiceSvc.handlePetGoto(userId, targetName, mapName);
  }
  async handlePetEquip(userId: number, petName: string, itemArg = ''): Promise<string>{
    return this.petCommandServiceSvc.handlePetEquip(userId, petName, itemArg);
  }
  async handleAllStop(userId: number): Promise<string>{
    return this.petCommandServiceSvc.handleAllStop(userId);
  }
  async handleAllActive(userId: number): Promise<string>{
    return this.petCommandServiceSvc.handleAllActive(userId);
  }
  async handleAllPassive(userId: number): Promise<string>{
    return this.petCommandServiceSvc.handleAllPassive(userId);
  }
  async handleAllMilk(userId: number): Promise<string>{
    return this.petCommandServiceSvc.handleAllMilk(userId);
  }
  async handleAllCommands(userId: number): Promise<string>{
    return this.petCommandServiceSvc.handleAllCommands(userId);
  }
  async handleAutoMine(userId: number): Promise<string> {
    return this.autoMineService
      ? this.autoMineService.start(userId)
      : `${this.getPlayerName(userId)}自动开采服务尚未加载`;
  }

  /**
   * 停止开采
   * 对应原版：开采停止 命令
   */
  async handleStopMine(userId: number): Promise<string> {
    return this.autoMineService
      ? this.autoMineService.stop(userId)
      : `${this.getPlayerName(userId)}自动开采服务尚未加载`;
  }

  /**
   * 配方解锁
   * 对应原版：配方解锁 命令
   */
  async handleRecipeUnlock(userId: number, recipeName = ''): Promise<string>{
    return this.shopTradeServiceSvc.handleRecipeUnlock(userId, recipeName);
  }
  async handleConfirmHelp(userId: number, targetName: string): Promise<string>{
    return this.questDialogueServiceSvc.handleConfirmHelp(userId, targetName);
  }
  async handleAutoShop(userId: number, itemName: string): Promise<string>{
    return this.shopTradeServiceSvc.handleAutoShop(userId, itemName);
  }
  private findMerchantInSummons(map: any): { summons: any[]; index: number } | null{
    return this.shopTradeServiceSvc.findMerchantInSummons(map);
  }
  private parseJsonArray(value: any): any[] {
    return this.supportSvc.parseJsonArray(value);
  }

  /**
   * 对应原版购物分支 L10031-L10042：开拓地限制与购买冷却。
   * 原版在自己的院子里不加“购买冷却”，在其他地图购买时每10秒允许一次。
   */
  private checkMerchantPurchaseGate( player: any, map: any, houseMap: any, ): { blocked: boolean; message: string; markers2: any[]; markers2Changed: boolean }{
    return this.shopTradeServiceSvc.checkMerchantPurchaseGate(player, map, houseMap);
  }
  private itemQuantity(item: any): number{
    return this.supportSvc.itemQuantity(item);
  }
  private async advanceTask(userId: number, actionName: string, count = 1): Promise<void> {
    return this.supportSvc.advanceTask(userId, actionName, count);
  }

  /** 行商列表显示名包含原版显示特效名称所需的特效标签。 */
  private formatMerchantItem(item: any, includeQuantity = false, includeEffect = true): string{
    return this.shopTradeServiceSvc.formatMerchantItem(item, includeQuantity, includeEffect);
  }
  /** 过渡期公开（P3-2 HomeBuildService 经门面引用调用） */
  formatMerchantItems(items: any[]): string{
    return this.shopTradeServiceSvc.formatMerchantItems(items);
  }
  private addItemToCollection(collection: any[], item: any): void{
    this.supportSvc.addItemToCollection(collection, item);
  }
  private hasEnoughResources(backpack: any[], costs: any[]): boolean{
    return this.shopTradeServiceSvc.hasEnoughResources(backpack, costs);
  }
  private generateMerchantResource(): any{
    return this.shopTradeServiceSvc.generateMerchantResource();
  }
  private async generateMerchantInventory(level: number, extra: number): Promise<any[]>{
    return this.shopTradeServiceSvc.generateMerchantInventory(level, extra);
  }
  async buildMerchantInventory(level = 1, extra = 0): Promise<any[]>{
    return this.shopTradeServiceSvc.buildMerchantInventory(level, extra);
  }
  private async purchaseMerchantItem( userId: number, player: any, markers: any, map: any, summons: any[], merchantIndex: number, merchantBackpack: any[], itemIndex: number, ): Promise<string>{
    return this.shopTradeServiceSvc.purchaseMerchantItem(userId, player, markers, map, summons, merchantIndex, merchantBackpack, itemIndex);
  }
  private deductBackpackItem(backpack: any[], name: string, quantity: number): void{
    this.supportSvc.deductBackpackItem(backpack, name, quantity);
  }
  async handleRefreshMonster(userId: number, monsterName = ''): Promise<string>{
    return this.dungeonChallengeServiceSvc.handleRefreshMonster(userId, monsterName);
  }
  async handleSpawnNpc(userId: number, argsString = ''): Promise<string>{
    return this.dungeonChallengeServiceSvc.handleSpawnNpc(userId, argsString);
  }
  async handleDeleteMonster(userId: number): Promise<string>{
    return this.dungeonChallengeServiceSvc.handleDeleteMonster(userId);
  }
  async handleProductionMode(userId: number, mode: number): Promise<string>{
    return this.skillCommandServiceSvc.handleProductionMode(userId, mode);
  }
  async handleTransformText(userId: number, text: string): Promise<string>{
    return this.skillCommandServiceSvc.handleTransformText(userId, text);
  }
  async handleSaveImage(userId: number, imageName: string): Promise<string>{
    return this.delayedSettleServiceSvc.handleSaveImage(userId, imageName);
  }
  async handleStartSaveImage(userId: number): Promise<string>{
    return this.delayedSettleServiceSvc.handleStartSaveImage(userId);
  }
  async handleStopSaveImage(userId: number): Promise<string>{
    return this.delayedSettleServiceSvc.handleStopSaveImage(userId);
  }
  async handleStopTakeover(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const sets = this.parseVehicleValue<any>(player.sets, {});
    const takeover = String(sets?.takeVehicle ?? sets?.接管载具 ?? '');
    if (!takeover) return `${player.name || '冒险者'}你没有在接管载具`;

    let vehicleName = takeover;
    const map = await this.mapService.getMapById(player.mapId);
    const vehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
    const vehicle = vehicles.find((item: any) =>
      [item?.编号, item?.vehicleId, item?.id].filter((value) => value !== undefined && value !== null).map(String).includes(takeover),
    );
    if (vehicle) vehicleName = vehicle.名称 ?? vehicle.name ?? takeover;
    sets.takeVehicle = '';
    sets.接管载具 = '';
    player.sets = sets;
    await this.playerService.savePlayer(player);
    return `${player.name || '冒险者'}停止了对${vehicleName}的接管`;
  }

  /**
   * 确认还原植入体等级
   * 对应原版：确认还原植入体等级 命令
   */
  async handleConfirmResetImplant(userId: number): Promise<string>{
    return this.equipCommandServiceSvc.handleConfirmResetImplant(userId);
  }
  async handleConfirmResetAmplifier(userId: number): Promise<string>{
    return this.equipCommandServiceSvc.handleConfirmResetAmplifier(userId);
  }
  private async getPlayerName(userId: number): Promise<string> {
    return this.supportSvc.getPlayerName(userId);
  }
}
