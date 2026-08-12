/**
 * 用户模块
 * 负责用户账号的注册、查询、绑定QQ号等操作。
 */

import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

@Module({
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
