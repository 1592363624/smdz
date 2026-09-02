/**
 * 系统配置中心服务
 * 集中管理所有可通过管理员界面在线调整的配置项(指令前缀、游戏数值、功能开关等)。
 * 配置存数据库 SystemConfig 表，修改后立即生效，无需重启服务。
 *
 * 遵循"配置项抽取"原则：业务逻辑中所有可能变化的常量都通过这里管理。
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SystemConfigService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 配置行内存缓存（key → 行），TTL 内免打库。
   * SystemConfig 表极小且变更频率极低，但 getCommandPrefixes 等热点读取
   * 在「每条消息」的指令判定路径上——远程库下每次往返都直接叠加到回复延迟。
   * set() 写库后主动失效对应 key，保证"管理员改完立即生效"。
   */
  private static readonly CACHE_TTL_MS = 5000;
  private readonly cache = new Map<string, { row: any; at: number }>();

  /**
   * 获取所有配置项
   */
  async findAll() {
    return this.prisma.systemConfig.findMany({ orderBy: { id: 'asc' } });
  }

  /**
   * 获取单个配置项的原始记录（带 TTL 缓存）
   */
  async findByKey(key: string) {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < SystemConfigService.CACHE_TTL_MS) {
      return hit.row;
    }
    const row = await this.prisma.systemConfig.findUnique({ where: { key } });
    this.cache.set(key, { row, at: now });
    return row;
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
   * 行不存在时自动创建（type 按 key 前缀推断分组，值类型默认 string），
   * 让新增配置项无需先跑 seed 即可在管理界面直接保存生效。
   */
  async set(key: string, value: any) {
    const row = await this.findByKey(key);
    // 按类型序列化
    let serialized: string;
    let type: string;
    if (row) {
      type = row.type;
      switch (type) {
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
      const updated = await this.prisma.systemConfig.update({ where: { key }, data: { value: serialized } });
      // 写库成功后失效缓存，管理员改完立即生效（不依赖 TTL 到期）
      this.cache.delete(key);
      return updated;
    }
    // 行不存在 → 自动创建：type 先按传入值推断（number/boolean 可识别，其余按 string），
    // group 取 key 第一段（如 web.handbookTooltipDelayMs → web），便于管理界面分组展示。
    serialized = String(value);
    type =
      typeof value === 'number' || (typeof value === 'string' && value !== '' && !Number.isNaN(Number(value)))
        ? 'number'
        : typeof value === 'boolean' || value === 'true' || value === 'false'
          ? 'boolean'
          : 'string';
    const created = await this.prisma.systemConfig.create({
      data: {
        key,
        value: serialized,
        type,
        label: key,
        description: '（自动创建）管理界面可修改显示名与描述',
        group: key.split('.')[0] || 'system',
      } as any,
    });
    this.cache.delete(key);
    return created;
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
