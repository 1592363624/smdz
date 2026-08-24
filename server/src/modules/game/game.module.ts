/**
 * 游戏引擎模块
 * 整合所有游戏核心逻辑：战斗、物品、地图、玩家、加成计算等
 * 对应原版易语言：战斗相关.ecode, 物品操作.ecode, 地图操作.ecode, 加成计算.ecode, 数据存取.ecode
 */

import { Module, Global, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { GameSyncModule } from '../../game-sync/game-sync.module';
import { AdminModule } from '../admin/admin.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { GameController } from './game.controller';
import { GameService } from './game.service';
import { PlayerService } from './player.service';
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

import { DungeonService } from './dungeon.service';
import { AchievementService } from './achievement.service';
import { HomeService } from './home.service';
import { ShortcutService } from './shortcut.service';
import { TaskService } from './task.service';
import { StatsService } from './stats.service';
import { AutoMineService } from './auto-mine.service';

@Global()
@Module({
  imports: [PrismaModule, GameSyncModule, forwardRef(() => AdminModule), FeedbackModule],
  controllers: [GameController],
  providers: [
    GameService,
    PlayerService,
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
    DungeonService,
    AchievementService,
    HomeService,
    ShortcutService,
    TaskService,
    StatsService,
    AutoMineService,
  ],
  exports: [
    GameService,
    PlayerService,
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
    DungeonService,
    AchievementService,
    HomeService,
    ShortcutService,
    TaskService,
    StatsService,
    AutoMineService,
  ],
})
export class GameModule {}
