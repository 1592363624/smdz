/**
 * 聊天服务
 * 负责消息的持久化、频道的查询，以及生成统一的"公屏消息"结构。
 */

import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  /** Socket.IO 服务端实例引用，由 ChatGateway 在初始化后注入，用于实时广播 */
  private server: Server | null = null;

  /**
   * 注入 Socket.IO 服务端实例
   * 由 ChatGateway.afterInit 调用，使本服务具备实时广播能力
   * @param server Socket.IO 服务端实例
   */
  setServer(server: Server): void {
    this.server = server;
  }

  /**
   * 向世界频道广播一条系统消息（持久化 + 实时推送）
   * 供指令引擎/游戏服务在非请求上下文（如延时到达）中主动推送消息给所有在线玩家
   * @param channelName 频道名（默认世界频道）
   * @param content 消息内容
   * @param senderId 发送者ID（可选）
   */
  async broadcastSystem(channelName: string, content: string, senderId?: number) {
    const channel = await this.ensureDefaultChannel();
    const msg = await this.saveMessage({
      channelId: channel.id,
      senderId,
      type: 'system',
      content,
    });
    // 实时推送给频道房间内所有在线用户
    this.server?.to(channelName).emit('chat:message', msg);
    return msg;
  }

  /**
   * 定向推送给指定在线用户（通过 per-user 房间 user:{userId}）
   * 用于玩家移动到达后刷新其地图面板等个性化场景
   * @param userId 目标用户ID
   * @param event 事件名
   * @param data 推送数据
   */
  emitToUser(userId: number, event: string, data: any): void {
    this.server?.to(`user:${userId}`).emit(event, data);
  }

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
   * 注意：排除 type='command' 的指令原文消息——
   * 后端在 handleCommand 中会把指令原文持久化但【不实时广播】，
   * 若历史加载也包含它们，会导致"刷新后多出用户消息、并把系统消息挤出最近 limit 条"的情况。
   * 因此历史加载与实时显示保持一致：指令原文不进入公屏历史。
   */
  async getMessages(channelId: number, limit = 50) {
    return this.prisma.chatMessage.findMany({
      where: {
        channelId,
        NOT: { type: 'command' },
      },
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
