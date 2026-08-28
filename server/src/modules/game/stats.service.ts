/**
 * 在线统计服务
 * 追踪当前 WebSocket 在线玩家，提供总玩家数及在线玩家数。
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);
  /**
   * 当前在线玩家连接计数（静态字段：即使出现多个实例也共享同一份数据）。
   * 按连接数引用计数而非简单 Set 去重：同一账号开多个标签页时，
   * 只有最后一个连接断开才判定为离线，避免关闭单个标签页误报离线。
   */
  private static onlineUsers = new Map<number, number>();

  constructor(private readonly prisma: PrismaService) {}

  /** 用户上线（连接数 +1） */
  userOnline(userId: number): void {
    StatsService.onlineUsers.set(userId, (StatsService.onlineUsers.get(userId) || 0) + 1);
  }

  /** 用户下线（连接数 -1，减到 0 才判定离线） */
  userOffline(userId: number): void {
    const count = (StatsService.onlineUsers.get(userId) || 0) - 1;
    if (count > 0) {
      StatsService.onlineUsers.set(userId, count);
    } else {
      StatsService.onlineUsers.delete(userId);
    }
  }

  /** 获取在线人数 */
  getOnlineCount(): number {
    return StatsService.onlineUsers.size;
  }

  /**
   * 判断指定用户是否在线
   * @param userId 用户ID
   * @returns true=在线 / false=离线
   */
  isOnline(userId: number): boolean {
    return StatsService.onlineUsers.has(userId);
  }

  /**
   * 获取当前在线用户ID集合（只读副本，供查询附近玩家时做在线标记）
   */
  getOnlineUserIds(): Set<number> {
    return new Set(StatsService.onlineUsers.keys());
  }

  /** 获取总注册用户数（User 表的记录数） */
  async getTotalPlayers(): Promise<number> {
    return this.prisma.user.count();
  }

  /** 获取完整统计信息 */
  async getStats(): Promise<{ totalPlayers: number; onlinePlayers: number }> {
    const [totalPlayers, onlinePlayers] = await Promise.all([
      this.getTotalPlayers(),
      Promise.resolve(this.getOnlineCount()),
    ]);
    return { totalPlayers, onlinePlayers };
  }
}