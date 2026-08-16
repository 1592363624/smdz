/**
 * 系统信息模块
 * 提供系统版本/部署信息接口(/api/system/version)。
 * SystemConfigService 由 SystemConfigModule 全局提供，此处可直接注入使用。
 */

import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';

@Module({
  controllers: [SystemController],
  providers: [SystemService],
})
export class SystemModule {}
