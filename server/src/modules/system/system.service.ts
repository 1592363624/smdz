/**
 * 系统信息/版本服务
 * 负责读取部署清单(version.json)与更新检测配置，供前端检测"部署完成"并展示更新日志。
 *
 * 数据来源：
 * - version.json：由 GitHub Actions 在每次部署前生成，随代码包部署到服务器
 *   (路径: {服务根目录}/version.json)，包含 commit SHA、部署时间、最近提交日志。
 *   本地开发环境没有该文件时，退化为返回 package.json 版本与空 SHA(前端据此跳过弹窗)。
 * - SystemConfig 表：更新检测的开关/轮询间隔/倒计时/冷却等配置项(管理员可在线调整)。
 */

import { Injectable } from '@nestjs/common';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { SystemConfigService } from '../system-config/system-config.service';

/** version.json 缓存有效期(毫秒)，避免每次请求都读磁盘 */
const VERSION_CACHE_TTL = 10_000;

@Injectable()
export class SystemService {
  /** 已解析的部署清单缓存(文件 mtime + 加载时间双重判断) */
  private cached: { mtimeMs: number; loadedAt: number; data: any } | null = null;

  constructor(private readonly configService: SystemConfigService) {}

  /**
   * 获取部署版本信息与更新检测配置
   * @returns {object} 含 version/sha/short/ref/deployedAt/message/commits/recentCommits/prevSha + settings
   *   - commits: 本次部署相对上次部署新增的 commit（即本次 push 的一整批）
   *   - recentCommits: 始终保留的最近 20 条（用于手动点击版本号查看更新记录）
   *   - prevSha: 本次部署所基于的上次部署 SHA
   */
  async getDeployInfo() {
    const manifest = this.readVersionManifest();
    const settings = await this.getUpdateSettings();
    return { ...manifest, settings };
  }

  /**
   * 读取 version.json(带缓存)，文件不存在时返回本地开发默认值
   */
  private readVersionManifest() {
    const filePath = join(process.cwd(), 'version.json');
    try {
      const stat = statSync(filePath);
      // 文件未变化且缓存未过期 → 直接返回缓存，避免频繁读磁盘
      if (
        this.cached &&
        this.cached.mtimeMs === stat.mtimeMs &&
        Date.now() - this.cached.loadedAt < VERSION_CACHE_TTL
      ) {
        return this.cached.data;
      }
      const raw = readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      this.cached = { mtimeMs: stat.mtimeMs, loadedAt: Date.now(), data };
      return data;
    } catch {
      // 本地开发环境没有 version.json：返回默认值(sha 为空，前端据此不弹更新窗)
      return {
        version: this.getPackageVersion(),
        sha: '',
        short: '',
        ref: 'local',
        deployedAt: null,
        message: '',
        commits: [],
        recentCommits: [],
        prevSha: '',
        source: 'local',
      };
    }
  }

  /**
   * 读取 package.json 中的版本号(兜底)
   */
  private getPackageVersion(): string {
    try {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
      return pkg.version || '0.1.0';
    } catch {
      return '0.1.0';
    }
  }

  /**
   * 读取更新检测相关配置(来自 SystemConfig 表，管理员可在线调整)
   */
  private async getUpdateSettings() {
    const [enabled, interval, autoReloadSeconds, promptCooldown] = await Promise.all([
      this.configService.get<boolean>('update.check.enabled', true),
      this.configService.get<number>('update.check.interval', 30),
      this.configService.get<number>('update.autoReloadSeconds', 15),
      this.configService.get<number>('update.promptCooldown', 300),
    ]);
    return {
      enabled,
      interval,
      autoReloadSeconds,
      promptCooldown,
    };
  }
}
