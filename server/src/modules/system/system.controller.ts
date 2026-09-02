/**
 * 系统信息控制器
 * 提供公开的版本/部署信息接口，供前端检测"部署完成"并展示更新日志。
 * 该接口无需登录即可访问，前端在游戏主界面轮询调用。
 */

import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SystemService } from './system.service';
import { SystemConfigService } from '../system-config/system-config.service';

@ApiTags('系统')
@Controller('system')
export class SystemController {
  constructor(
    private readonly systemService: SystemService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

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

  /**
   * 获取服务器当前时间（毫秒时间戳）
   * 前端启动/重连时调用一次，测算本机与服务器的时钟偏移量，
   * 使所有「服务器时刻 + 本地逐秒倒数」类倒计时（延时操作进度条、增益剩余时间）
   * 在本机时钟漂移时仍与服务器结算时刻对齐。
   */
  @Get('server-time')
  @ApiOperation({ summary: '获取服务器当前时间(毫秒时间戳)' })
  getServerTime() {
    return { success: true, data: { serverNow: Date.now() } };
  }

  /**
   * 获取网页前端可调配置（公开，无需登录）
   * 玩家侧组件（如背包图鉴弹层）启动时读取一次，GM 在后台修改后玩家刷新页面生效。
   */
  @Get('web-config')
  @ApiOperation({ summary: '获取网页前端可调配置(公开)' })
  async getWebConfig() {
    const handbookTooltipDelayMs = await this.systemConfigService.get<number>(
      'web.handbookTooltipDelayMs',
      1000,
    );
    return { success: true, data: { handbookTooltipDelayMs } };
  }
}
