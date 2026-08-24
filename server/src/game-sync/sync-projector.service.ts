/**
 * 同步投影器
 * 订阅 ChangeBus 的实体变更事件，推导"受影响用户"并触发防抖推送：
 * - player 变更  → 受影响用户 = [该用户]
 * - monster 变更 → 受影响用户 = 该地图全部在线玩家（★跨玩家视野同步）
 * 推送统一走 GameService.pushPlayerUpdate/pushMapUpdate（自带 300ms 防抖 +
 * 读库投影），因此事件风暴、重复事件天然幂等。
 */

import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, Inject, forwardRef } from '@nestjs/common';
import { ChangeBusService, ChangeEvent } from './change-bus.service';
import { GameService } from '../modules/game/game.service';
import { PrismaService } from '../prisma/prisma.service';
import { StatsService } from '../modules/game/stats.service';

@Injectable()
export class SyncProjectorService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SyncProjectorService.name);
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly changeBus: ChangeBusService,
    private readonly prisma: PrismaService,
    private readonly statsService: StatsService,
    // GameService 与本模块相互引用（GameModule 全局提供 GameService），
    // 用 forwardRef 打破循环；参数放末位以兼容按位置 new 的测试写法
    @Inject(forwardRef(() => GameService)) private readonly gameService?: GameService,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.changeBus.on((e) => this.project(e));
    this.logger.log('SyncProjector 已订阅 ChangeBus，数据→UI 自动同步生效');
  }

  onApplicationShutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** 单条变更事件的投影入口；任何异常只记日志，不影响业务 */
  project(e: ChangeEvent): void {
    switch (e.entity) {
      case 'player':
        void this.gameService?.pushPlayerUpdate(e.userId).catch?.(() => undefined);
        break;
      case 'monster':
        void this.projectMonster(e.mapId);
        break;
    }
  }

  /**
   * 怪物/地图态变化 → 该地图全部在线玩家的地图面板失效
   * （怪物血量、资源数量等是共享视图，必须广播给同图所有在线玩家）
   */
  private async projectMonster(mapId: number): Promise<void> {
    try {
      const online = this.statsService.getOnlineUserIds();
      const rows = await this.prisma.player.findMany({
        where: { mapId },
        select: { userId: true },
      });
      for (const row of rows) {
        if (!online.has(row.userId)) continue; // 离线玩家无 socket，推送无意义
        void this.gameService?.pushMapUpdate(row.userId).catch?.(() => undefined);
      }
    } catch (err: any) {
      this.logger.warn(`投影怪物变更(map=${mapId})失败: ${err?.message}`);
    }
  }
}
