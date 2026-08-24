/**
 * 数据→UI 自动同步模块
 * 聚合 ChangeBus（事件源）与 SyncProjector（投影器）。
 *
 * 实例唯一性：本模块被 PrismaModule 与 GameModule 同时导入，
 * NestJS 对同一 Module 类只实例化一次（模块注册表去重），因此
 * ChangeBusService 全局单例。任何模块需要 ChangeBus 直接注入即可。
 */

import { Module } from '@nestjs/common';
import { ChangeBusService } from './change-bus.service';
import { SyncProjectorService } from './sync-projector.service';

@Module({
  providers: [ChangeBusService, SyncProjectorService],
  exports: [ChangeBusService, SyncProjectorService],
})
export class GameSyncModule {}
