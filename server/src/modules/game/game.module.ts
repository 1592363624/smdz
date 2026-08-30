/**
 * 游戏引擎模块
 * 整合所有游戏核心逻辑：战斗、物品、地图、玩家、加成计算等
 * 对应原版易语言：战斗相关.ecode, 物品操作.ecode, 地图操作.ecode, 加成计算.ecode, 数据存取.ecode
 */

import { Module, Global, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ActorModule } from '../actor/actor.module';
import { GameSyncModule } from '../../game-sync/game-sync.module';
import { AdminModule } from '../admin/admin.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { GameController } from './game.controller';
import { GameService } from './game.service';
import { PlayerService } from './player.service';
import { PlayerMutateService } from './player-mutate.service';
import { PlayerMutateContextService } from './player-mutate-context.service';
import { TutorialService } from './tutorial.service';
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
import { ITEM_SYSTEM_SERVICE } from './service-tokens';

@Global()
@Module({
  imports: [PrismaModule, ActorModule, GameSyncModule, forwardRef(() => AdminModule), FeedbackModule],
  controllers: [GameController],
  providers: [
    GameService,
    PlayerService,
    PlayerMutateContextService,
    PlayerMutateService,
    TutorialService,
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
    // 字符串 token 别名：让 PlayerService 无需 import ItemSystemService（避免运行时循环加载）
    { provide: ITEM_SYSTEM_SERVICE, useExisting: ItemSystemService },
  ],
  exports: [
    GameService,
    PlayerService,
    PlayerMutateContextService,
    PlayerMutateService,
    TutorialService,
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
  ],
})
export class GameModule {}
