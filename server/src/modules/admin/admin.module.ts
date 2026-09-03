/**
 * 管理员模块
 * 提供用户管理、系统配置管理、游戏管理等后台管理能力。
 */

import { Module, Global, forwardRef } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { StaticDataAdminService } from './static-data-admin.service';

@Module({
  imports: [forwardRef(() => ChatModule)],
  providers: [AdminService, StaticDataAdminService],
  controllers: [AdminController],
  exports: [AdminService],
})
export class AdminModule {}
