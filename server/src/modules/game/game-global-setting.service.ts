import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemConfigService } from '../system-config/system-config.service';

@Injectable()
export class GameGlobalSettingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  /** 读取管理员配置的全局使用活力开关 */
  async getVitalityEnabled(): Promise<boolean> {
    return this.systemConfigService.get<boolean>('game.vitality.enabled', true);
  }

  /** 读取管理员配置的全局自动采集开关 */
  async getGatherEnabled(): Promise<boolean> {
    return this.systemConfigService.get<boolean>('game.gather.enabled', false);
  }

  /** 管理员更新全局使用活力开关 */
  async setVitalityEnabled(enabled: boolean): Promise<string> {
    await this.systemConfigService.set('game.vitality.enabled', enabled ? 'true' : 'false');
    return `全局使用活力设置为${enabled ? '开启' : '关闭'}`;
  }

  /** 管理员更新全局自动采集开关 */
  async setGatherEnabled(enabled: boolean): Promise<string> {
    await this.systemConfigService.set('game.gather.enabled', enabled ? 'true' : 'false');
    return `全局自动采集设置为${enabled ? '开启' : '关闭'}`;
  }
}
