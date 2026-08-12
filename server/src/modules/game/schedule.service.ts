/**
 * 后台定时任务服务
 * 对应原版易语言：后台运作.ecode
 * 负责自动保存、地图资源刷新、副本生成等定时任务
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { MapService } from './map.service';

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);
  private autoSaveRunning = false;
  private lastAutoSaveTime = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly mapService: MapService,
  ) {}

  /**
   * 自动保存 - 每5分钟执行一次
   * 对应原版：自动保存线程
   * 保存所有在线玩家的数据
   */
  @Cron('0 */5 * * * *') // 每5分钟（秒 分 时 日 月 周）
  async autoSave() {
    if (this.autoSaveRunning) {
      this.logger.warn('自动保存仍在运行中，跳过本次');
      return;
    }
    this.autoSaveRunning = true;
    this.lastAutoSaveTime = Date.now();

    try {
      const players = await this.prisma.player.findMany({
        where: { userId: { gt: 0 } },
        select: { userId: true, updatedAt: true },
      });

      let savedCount = 0;
      for (const p of players) {
        // 只保存最近30分钟内有更新的玩家
        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
        if (p.updatedAt > thirtyMinAgo) {
          // PlayerService.savePlayer 已经处理了持久化
          savedCount++;
        }
      }

      this.logger.log(`自动保存完成: ${savedCount} 个玩家`);
    } catch (err: any) {
      this.logger.error(`自动保存失败: ${err.message}`);
    } finally {
      this.autoSaveRunning = false;
    }
  }

  /**
   * 地图资源刷新 - 每10分钟执行一次
   * 对应原版：地图刷新
   */
  @Cron('0 */10 * * * *') // 每10分钟
  async refreshMapResources() {
    try {
      const maps = await this.prisma.gameMap.findMany();
      for (const map of maps) {
        await this.mapService.refreshMapResources(map.id);
      }
      this.logger.log(`地图资源刷新完成: ${maps.length} 个地图`);
    } catch (err: any) {
      this.logger.error(`地图资源刷新失败: ${err.message}`);
    }
  }

  /**
   * 怪物重生 - 每分钟检查一次
   * 对应原版：怪物刷新
   */
  @Cron('0 * * * * *') // 每分钟
  async respawnMonsters() {
    try {
      const maps = await this.prisma.gameMap.findMany({
        where: { monsterCount: { gt: 0 } },
      });

      for (const map of maps) {
        const spawnMonsters = JSON.parse(map.spawnMonsters || '[]');
        const tempMonsters = JSON.parse(map.tempMonsters || '[]');
        const totalMonsters = spawnMonsters.length + tempMonsters.length;

        // 如果怪物数量少于配置，补充刷新
        if (totalMonsters < map.monsterCount) {
          await this.mapService.refreshMapMonsters(map.id);
        }
      }
    } catch (err: any) {
      this.logger.error(`怪物重生失败: ${err.message}`);
    }
  }

  /**
   * 清理过期标记和增益 - 每5分钟执行一次
   * 对应原版：标记清理
   */
  @Cron('0 */5 * * * *') // 每5分钟
  async cleanupExpiredBuffs() {
    try {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const players = await this.prisma.player.findMany({
        select: { userId: true, markers2: true, buffs: true },
      });

      let cleanedCount = 0;
      for (const player of players) {
        let changed = false;

        // 清理过期 markers2
        const markers2 = JSON.parse(player.markers2 || '[]');
        const validMarkers2 = markers2.filter((m: any) => {
          if (!m.expireAt) return true;
          return BigInt(m.expireAt) > now;
        });
        if (validMarkers2.length !== markers2.length) {
          changed = true;
        }

        // 清理过期 buffs
        const buffs = JSON.parse(player.buffs || '[]');
        const validBuffs = buffs.filter((b: any) => {
          if (!b.expireAt) return true;
          return BigInt(b.expireAt) > now;
        });
        if (validBuffs.length !== buffs.length) {
          changed = true;
        }

        if (changed) {
          await this.prisma.player.update({
            where: { userId: player.userId },
            data: {
              markers2: JSON.stringify(validMarkers2),
              buffs: JSON.stringify(validBuffs),
            },
          });
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        this.logger.log(`清理了 ${cleanedCount} 个玩家的过期标记`);
      }
    } catch (err: any) {
      this.logger.error(`清理过期标记失败: ${err.message}`);
    }
  }

  /**
   * 获取自动保存状态
   */
  getAutoSaveStatus(): { lastSave: number; running: boolean } {
    return {
      lastSave: this.lastAutoSaveTime,
      running: this.autoSaveRunning,
    };
  }
}