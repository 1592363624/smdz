/**
 * 在线统计服务
 * 追踪当前 WebSocket 在线玩家，提供总玩家数及在线玩家数。
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);
  /** 当前在线玩家 userId 集合（静态字段：即使出现多个实例也共享同一份数据） */
  private static onlineUsers = new Set<number>();

  constructor(private readonly prisma: PrismaService) {}

  /** 用户上线 */
  userOnline(userId: number): void {
    StatsService.onlineUsers.add(userId);
  }

  /** 用户下线 */
  userOffline(userId: number): void {
    StatsService.onlineUsers.delete(userId);
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
   * 获取当前在线用户ID集合（只读引用，供查询附近玩家时做在线标记）
   */
  getOnlineUserIds(): Set<number> {
    return StatsService.onlineUsers;
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