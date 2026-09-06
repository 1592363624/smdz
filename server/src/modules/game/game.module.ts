/** 游戏服务模块
 * 组织游戏引擎所需服务的依赖注入，供 CommandModule / WebSocket gateway 消费。
 */
import { Module, Optional, Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GameService } from './game.service';
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
import { TutorialService } from './tutorial.service';
import { StaticDataService } from './static-data.service';
import { GameHighlightService } from './game-highlight.service';
import { ITEM_SYSTEM_SERVICE } from './service-tokens';

@Module({
  providers: [
    GameService,
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
    TutorialService,
    StaticDataService,
    GameHighlightService,
    // 字符串 token 别名：让 PlayerService 无需 import ItemSystemService（避免运行时循环加载）
    { provide: ITEM_SYSTEM_SERVICE, useExisting: ItemSystemService },
  ],
  exports: [
    GameService,
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
    GameHighlightService,
  ],
})
export class GameModule {}
