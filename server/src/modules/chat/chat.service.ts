/**
 * 聊天服务
 * 负责消息的持久化、频道的查询，以及生成统一的"公屏消息"结构。
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 获取或创建默认频道（世界频道 id=1）
   */
  async ensureDefaultChannel() {
    let channel = await this.prisma.channel.findUnique({ where: { name: '世界频道' } });
    if (!channel) {
      channel = await this.prisma.channel.create({
        data: { name: '世界频道', description: '所有玩家公屏频道' },
      });
    }
    return channel;
  }

  /**
   * 根据 ID 获取频道
   */
  getChannel(id: number) {
    return this.prisma.channel.findUnique({ where: { id } });
  }

  /**
   * 拉取频道历史消息（用于页面刷新后加载）
   */
  async getMessages(channelId: number, limit = 50) {
    return this.prisma.chatMessage.findMany({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { sender: { select: { id: true, username: true, nickname: true } } },
    });
  }

  /**
   * 持久化一条公屏消息
   */
  async saveMessage(data: {
    channelId: number;
    senderId?: number;
    type: string;
    content: string;
  }) {
    return this.prisma.chatMessage.create({
      data: {
        channelId: data.channelId,
        senderId: data.senderId,
        type: data.type,
        content: data.content,
      },
      include: { sender: { select: { id: true, username: true, nickname: true } } },
    });
  }
}
