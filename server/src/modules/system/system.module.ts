/** 系统信息模块：系统版本/部署信息接口（/api/system/version）。 */

import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';

@Module({
  controllers: [SystemController],
  providers: [SystemService],
})
export class SystemModule {}
