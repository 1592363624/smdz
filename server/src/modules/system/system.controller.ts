/**
 * 系统信息控制器
 * 提供公开的版本/部署信息接口，供前端检测"部署完成"并展示更新日志。
 * 该接口无需登录即可访问，前端在游戏主界面轮询调用。
 */

import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SystemService } from './system.service';

@ApiTags('系统')
@Controller('system')
export class SystemController {
  constructor(private readonly systemService: SystemService) {}

  /**
   * 获取部署版本信息与更新检测配置
   * 前端轮询此接口，当 commit SHA 变化时判定"部署完成"，
   * 弹窗展示更新日志并自动刷新页面。
   */
  @Get('version')
  @ApiOperation({ summary: '获取部署版本信息与更新检测配置' })
  async getVersion() {
    const data = await this.systemService.getDeployInfo();
    return { success: true, data };
  }
}
