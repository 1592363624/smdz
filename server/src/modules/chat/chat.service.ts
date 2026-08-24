/**
 * 聊天服务
 * 负责消息的持久化、频道的查询，以及生成统一的"公屏消息"结构。
 */

import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';
import { PrismaService } from '../../prisma/prisma.service';
import { StatsService } from '../game/stats.service';
import { normalizeGameText } from '../../common/utils/game-text.util';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly statsService: StatsService,
  ) {}

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
   * 保留 type='command' 的指令原文消息：让玩家刷新页面后仍能看到自己发出的指令，
   * 与实时广播保持一致（实时显示包含指令原文，历史也包含，避免"刷新后自己的指令消失"）。
   * @param channelId 频道ID
   * @param limit 拉取条数（取最近 limit 条，由调用方传入较大值以容纳指令+系统消息）
   */
  async getMessages(channelId: number, limit = 100) {
    return this.prisma.chatMessage.findMany({
      where: {
        channelId,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { sender: { select: { id: true, username: true, nickname: true } } },
    });
  }

  /**
   * 持久化一条公屏消息
   * 内容统一经过 normalizeGameText：把游戏文本中的 "#换行" 标记转为真实换行
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
        content: normalizeGameText(data.content),
      },
      include: { sender: { select: { id: true, username: true, nickname: true } } },
    });
  }

  /**
   * 发送一条私聊消息
   * 持久化到 PrivateMessage 表，并通过 per-user 房间实时推送给接收方
   * @param senderId 发送者用户ID
   * @param receiverId 接收者用户ID
   * @param content 消息内容
   * @returns 创建后的私聊消息（含双方简要信息）
   */
  async sendPrivateMessage(senderId: number, receiverId: number, content: string) {
    if (senderId === receiverId) {
      throw new Error('不能给自己发私聊消息');
    }
    const msg = await this.prisma.privateMessage.create({
      data: { senderId, receiverId, content },
      include: {
        sender: { select: { id: true, username: true, nickname: true } },
        receiver: { select: { id: true, username: true, nickname: true } },
      },
    });
    // 实时推送给接收方（在线才收到，离线消息可在历史中查看）
    this.server?.to(`user:${receiverId}`).emit('chat:private', msg);
    return msg;
  }

  /**
   * 获取当前用户与其他用户的私聊会话列表
   * 按最近消息时间倒序，包含对方信息、最后一条消息、未读条数
   * @param userId 当前用户ID
   */
  async getPrivateConversations(userId: number) {
    // 取出与该用户相关的所有私聊消息（发出或接收）
    const messages = await this.prisma.privateMessage.findMany({
      where: { OR: [{ senderId: userId }, { receiverId: userId }] },
      orderBy: { createdAt: 'desc' },
      take: 1000,
      include: {
        sender: { select: { id: true, username: true, nickname: true } },
        receiver: { select: { id: true, username: true, nickname: true } },
      },
    });

    // 按"对方用户"分组，聚合成会话
    const convMap = new Map<number, any>();
    for (const m of messages) {
      const otherId = m.senderId === userId ? m.receiverId : m.senderId;
      if (otherId === userId) continue; // 防御：同用户
      let conv = convMap.get(otherId);
      if (!conv) {
        conv = {
          peerId: otherId,
          peer: otherId === m.senderId ? m.sender : m.receiver,
          lastMessage: null as any,
          lastAt: null as any,
          unread: 0,
        };
        convMap.set(otherId, conv);
      }
      if (!conv.lastAt || m.createdAt > conv.lastAt) {
        conv.lastAt = m.createdAt;
        conv.lastMessage = m.content;
      }
      // 未读：接收方是当前用户且未读
      if (m.receiverId === userId && !m.read) {
        conv.unread += 1;
      }
    }
    const list = Array.from(convMap.values());
    list.sort((a, b) => (b.lastAt > a.lastAt ? 1 : -1));
    return list;
  }

  /**
   * 获取与指定用户的私聊历史（双向消息，按时间正序）
   * @param userId 当前用户ID
   * @param peerId 对方用户ID
   * @param limit 拉取条数（默认50，取最近 limit 条再倒序返回）
   */
  async getPrivateMessages(userId: number, peerId: number, limit = 50) {
    const msgs = await this.prisma.privateMessage.findMany({
      where: {
        OR: [
          { senderId: userId, receiverId: peerId },
          { senderId: peerId, receiverId: userId },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(limit) || 50, 200),
      include: {
        sender: { select: { id: true, username: true, nickname: true } },
        receiver: { select: { id: true, username: true, nickname: true } },
      },
    });
    // 倒序取最近 N 条后按时间正序返回，便于前端直接渲染
    return msgs.reverse();
  }

  /**
   * 标记与指定用户的私聊消息为已读
   * 仅将"接收方=当前用户 且未读"的消息置为已读
   * @param userId 当前用户ID
   * @param peerId 对方用户ID
   * @returns 更新的条数
   */
  async markPrivateRead(userId: number, peerId: number) {
    const result = await this.prisma.privateMessage.updateMany({
      where: { senderId: peerId, receiverId: userId, read: false },
      data: { read: true },
    });
    return result.count;
  }

  /**
   * 解析普通聊天文本中的 @提及（@用户名），返回被提及的用户名列表
   * @param content 消息内容
   */
  parseMentions(content: string): string[] {
    const mentions: string[] = [];
    const regex = /@([\u4e00-\u9fa5A-Za-z0-9_]{1,32})/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      mentions.push(m[1]);
    }
    return mentions;
  }

  /**
   * 获取"可@提及"的玩家列表（供前端聊天框 @ 下拉选择 / 消息右键 @ 使用）
   * 返回全部 ACTIVE 账号的简洁信息，并附加实时在线标记（在线优先排序）
   * @param excludeUserId 需要排除的用户ID（通常是当前登录用户自己，避免@自己）
   * @returns [{ id, username, nickname, online }]
   */
  async getMentionablePlayers(excludeUserId?: number) {
    const onlineSet = this.statsService.getOnlineUserIds();
    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
      },
      select: { id: true, username: true, nickname: true },
      orderBy: { username: 'asc' },
    });
    // 附加在线标记，并按"在线在前、名字排序在后"排列，方便用户优先@到场的玩家
    return users
      .map((u) => ({
        id: u.id,
        username: u.username,
        nickname: u.nickname || u.username,
        online: onlineSet.has(u.id),
      }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));
  }
}
