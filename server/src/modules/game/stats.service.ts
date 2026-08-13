/**
 * 在线统计服务
 * 追踪当前 WebSocket 在线玩家，提供总玩家数及在线玩家数。
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);
  /** 当前在线玩家 userId 集合 */
  private onlineUsers = new Set<number>();

  constructor(private readonly prisma: PrismaService) {}

  /** 用户上线 */
  userOnline(userId: number): void {
    this.onlineUsers.add(userId);
  }

  /** 用户下线 */
  userOffline(userId: number): void {
    this.onlineUsers.delete(userId);
  }

  /** 获取在线人数 */
  getOnlineCount(): number {
    return this.onlineUsers.size;
  }

  /** 获取总玩家数（Player 表的记录数） */
  async getTotalPlayers(): Promise<number> {
    return this.prisma.player.count();
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