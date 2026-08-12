/**
 * Prisma 服务
 * 封装 PrismaClient 生命周期，随 Nest 应用启动/销毁。
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /** 应用启动时建立数据库连接 */
  async onModuleInit() {
    await this.$connect();
  }

  /** 应用销毁时断开数据库连接 */
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
