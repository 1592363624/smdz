/**
 * Prisma 数据访问模块
 * 全局提供 PrismaService 单例，供所有模块注入使用。
 * PrismaService 依赖 ChangeBusService（写操作拦截发事件），
 * 通过导入 GameSyncModule 共享其唯一实例（勿在本模块重复 provide）。
 */

import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { StaticDataService } from '../modules/game/static-data.service';
import { GameSyncModule } from '../game-sync/game-sync.module';

@Global()
@Module({
  imports: [GameSyncModule],
  providers: [PrismaService, StaticDataService],
  exports: [PrismaService, StaticDataService],
})
export class PrismaModule {}
