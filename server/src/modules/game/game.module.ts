/** 游戏服务模块
 * 组织游戏引擎所需服务的依赖注入，供 CommandModule / WebSocket gateway 消费。
 */
import { Module, Global, Optional, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GameService } from './game.service';
import { GameSupportService } from './game-support.service';
import { RescueWhiteService } from './commands/rescue-white.service';
import { DungeonChallengeService } from './commands/dungeon-challenge.service';
import { DelayedSettleService } from './commands/delayed-settle.service';
import { HomeBuildService } from './commands/home-build.service';
import { QuestDialogueService } from './commands/quest-dialogue.service';
import { ShopTradeService } from './commands/shop-trade.service';
import { SkillCommandService } from './commands/skill-command.service';
import { EquipCommandService } from './commands/equip-command.service';
import { PetCommandService } from './commands/pet-command.service';
import { TimeSettleService } from './commands/time-settle.service';
import { FusionCraftService } from './commands/fusion-craft.service';
import { AdminCommandService } from './commands/admin-command.service';
import { RankingCommandService } from './commands/ranking-command.service';
import { GameController } from './game.controller';
import { PlayerService } from './player.service';
import { PlayerMutateContextService } from './player-mutate-context.service';
import { PlayerMutateService } from './player-mutate.service';
import { BonusService } from './bonus.service';
import { ItemService } from './item.service';
import { MapService } from './map.service';
import { FamiliarService } from './familiar.service';
import { FamiliarSystemService } from './familiar-system.service';
import { FamiliarSkillsService } from './familiar-skills.service';
import { ItemSystemService } from './item-system.service';
import { CombatSystemService } from './combat-system.service';
import { CombatStateService } from './combat-state.service';
import { MapBattleLoopService } from './map-battle-loop.service';
import { DungeonService } from './dungeon.service';
import { AchievementService } from './achievement.service';
import { HomeService } from './home.service';
import { ShortcutService } from './shortcut.service';
import { TaskService } from './task.service';
import { StatsService } from './stats.service';
import { AutoMineService } from './auto-mine.service';
import { VitalityService } from './vitality.service';
import { HandbookService } from './handbook.service';
import { GameGlobalSettingService } from './game-global-setting.service';
import { GlobalProficiencyService } from './global-proficiency.service';
import { TutorialService } from './tutorial.service';
import { StaticDataService } from './static-data.service';
import { GameHighlightService } from './highlight.service';
import { DelayedTaskService } from './delayed-task.service';
import { ITEM_SYSTEM_SERVICE, COMBAT_SYSTEM_SERVICE } from './service-tokens';
import { GameSyncModule } from '../../game-sync/game-sync.module';
import { AdminModule } from '../admin/admin.module';
import { FeedbackModule } from '../feedback/feedback.module';

// 全局模块：GameService/PlayerService/StatsService 等游戏服务全应用可用
// （GameTasksModule 等模块依赖此约定，见其模块注释）
@Global()
@Module({
  // forwardRef 打破循环依赖：
  // - GameSyncModule：MapService 需要 ChangeBusService
  // - AdminModule / FeedbackModule：GameService 需要 AdminService / FeedbackService，
  //   而它们又反向依赖本模块的游戏服务
  imports: [
    forwardRef(() => GameSyncModule),
    forwardRef(() => AdminModule),
    forwardRef(() => FeedbackModule),
  ],
  providers: [
    GameService,
    GameSupportService,
    RescueWhiteService,
    DungeonChallengeService,
    DelayedSettleService,
    HomeBuildService,
    QuestDialogueService,
    ShopTradeService,
    SkillCommandService,
    EquipCommandService,
    PetCommandService,
    TimeSettleService,
    FusionCraftService,
    AdminCommandService,
    RankingCommandService,
    PlayerService,
    PlayerMutateContextService,
    PlayerMutateService,
    BonusService,
    ItemService,
    MapService,
    FamiliarService,
    FamiliarSystemService,
    FamiliarSkillsService,
    ItemSystemService,
    CombatSystemService,
    CombatStateService,
    MapBattleLoopService,
    DungeonService,
    AchievementService,
    HomeService,
    ShortcutService,
    TaskService,
    StatsService,
    AutoMineService,
    VitalityService,
    HandbookService,
    GameGlobalSettingService,
    GlobalProficiencyService,
    TutorialService,
    StaticDataService,
    DelayedTaskService,
    GameHighlightService,
    // 字符串 token 别名：让 PlayerService 无需 import ItemSystemService（避免运行时循环加载）
    { provide: ITEM_SYSTEM_SERVICE, useExisting: ItemSystemService },
    // 同上：ItemService 三池回复基数需要 CombatSystemService（计算后属性），
    // 直接 import 会翻转 familiar-skills 的模块初始化顺序（AFFIX_TO_BONUS 半初始化崩溃）
    { provide: COMBAT_SYSTEM_SERVICE, useExisting: CombatSystemService },
  ],
  exports: [
    GameService,
    GameSupportService,
    RescueWhiteService,
    DungeonChallengeService,
    DelayedSettleService,
    HomeBuildService,
    QuestDialogueService,
    ShopTradeService,
    SkillCommandService,
    EquipCommandService,
    PetCommandService,
    TimeSettleService,
    FusionCraftService,
    AdminCommandService,
    RankingCommandService,
    PlayerService,
    PlayerMutateContextService,
    PlayerMutateService,
    BonusService,
    ItemService,
    MapService,
    FamiliarService,
    FamiliarSystemService,
    FamiliarSkillsService,
    ItemSystemService,
    CombatSystemService,
    CombatStateService,
    MapBattleLoopService,
    DungeonService,
    AchievementService,
    HomeService,
    ShortcutService,
    TaskService,
    StatsService,
    AutoMineService,
    VitalityService,
    HandbookService,
    GameGlobalSettingService,
    GlobalProficiencyService,
    TutorialService,
    GameHighlightService,
    // token 别名同样导出，供全局的 AdminService 等注入
    ITEM_SYSTEM_SERVICE,
    COMBAT_SYSTEM_SERVICE,
  ],
  controllers: [GameController],
})
export class GameModule {}
