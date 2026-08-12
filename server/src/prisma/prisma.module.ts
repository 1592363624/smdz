/**
 * Prisma 数据访问模块
 * 全局提供 PrismaService 单例，供所有模块注入使用。
 */

import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
