/**
 * 系统配置中心模块
 * 提供 SystemConfigService，供各模块注入读取/管理配置。
 */

import { Global, Module } from '@nestjs/common';
import { SystemConfigService } from './system-config.service';

@Global()
@Module({
  providers: [SystemConfigService],
  exports: [SystemConfigService],
})
export class SystemConfigModule {}
