/**
 * 管理员模块
 * 提供用户管理、系统配置管理、游戏管理等后台管理能力。
 */

import { Module, Global, forwardRef } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';

@Module({
  imports: [forwardRef(() => ChatModule)],
  providers: [AdminService],
  controllers: [AdminController],
  exports: [AdminService],
})
export class AdminModule {}
