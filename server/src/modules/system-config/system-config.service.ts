/**
 * 系统配置中心服务
 * 集中管理所有可通过管理员界面在线调整的配置项(指令前缀、游戏数值、功能开关等)。
 * 配置存数据库 SystemConfig 表，修改后立即生效，无需重启服务。
 *
 * 遵循"配置项抽取"原则：业务逻辑中所有可能变化的常量都通过这里管理。
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SystemConfigService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 获取所有配置项
   */
  async findAll() {
    return this.prisma.systemConfig.findMany({ orderBy: { id: 'asc' } });
  }

  /**
   * 获取单个配置项的原始记录
   */
  async findByKey(key: string) {
    return this.prisma.systemConfig.findUnique({ where: { key } });
  }

  /**
   * 读取配置值(自动解析为对应类型)
   * @param key 配置键
   * @param defaultValue 不存在时的默认值
   */
  async get<T = any>(key: string, defaultValue: T): Promise<T> {
    const row = await this.findByKey(key);
    if (!row) return defaultValue;
    return this.parseValue<T>(row.type, row.value, defaultValue);
  }

  /**
   * 批量读取配置
   */
  async getMany<T = any>(keys: string[]): Promise<Record<string, T>> {
    const rows = await this.prisma.systemConfig.findMany({
      where: { key: { in: keys } },
    });
    const result: Record<string, T> = {};
    for (const row of rows) {
      result[row.key] = this.parseValue<T>(row.type, row.value, undefined as any);
    }
    return result;
  }

  /**
   * 更新配置值(按类型校验/解析)
   */
  async set(key: string, value: any) {
    const row = await this.findByKey(key);
    if (!row) {
      throw new NotFoundException(`配置项 ${key} 不存在`);
    }
    // 按类型序列化
    let serialized: string;
    switch (row.type) {
      case 'number':
        serialized = String(Number(value));
        break;
      case 'boolean':
        serialized = value === true || value === 'true' ? 'true' : 'false';
        break;
      case 'json':
        serialized = typeof value === 'string' ? value : JSON.stringify(value);
        break;
      case 'string-array':
        serialized = Array.isArray(value) ? JSON.stringify(value) : JSON.stringify(String(value).split(','));
        break;
      default: // string
        serialized = String(value);
    }
    return this.prisma.systemConfig.update({ where: { key }, data: { value: serialized } });
  }

  /**
   * 快捷读取：指令前缀列表
   */
  getCommandPrefixes(): Promise<string[]> {
    return this.get<string[]>('command.prefixes', ['/', '！', '!']);
  }

  /**
   * 快捷读取：是否必须带前缀才算指令
   */
  getCommandRequirePrefix(): Promise<boolean> {
    return this.get<boolean>('command.requirePrefix', false);
  }

  /**
   * 按配置类型解析存储值
   */
  private parseValue<T>(type: string, raw: string, defaultValue: T): T {
    if (raw === '' && raw === undefined) return defaultValue;
    switch (type) {
      case 'number':
        return (Number(raw) || defaultValue) as T;
      case 'boolean':
        return (raw === 'true') as T;
      case 'json':
      case 'string-array': {
        try {
          return JSON.parse(raw) as T;
        } catch {
          return defaultValue;
        }
      }
      default:
        return (raw ?? defaultValue) as T;
    }
  }
}
