/**
 * 后台任务模块：注册所有定时任务服务。
 * 注意：PlayerService 和 MapService 由全局 GameModule 提供，故此处不导入 GameModule。
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../prisma/prisma.module';
import { ScheduleService } from './schedule.service';
import { DungeonService } from './dungeon.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
  ],
  providers: [
    ScheduleService,
    DungeonService,
  ],
  exports: [ScheduleService, DungeonService],
})
export class GameTasksModule {}