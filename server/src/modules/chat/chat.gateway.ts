/**
 * 公屏聊天网关 (Socket.IO)
 * 实现"群聊式"公屏的实时双向通信：
 * - 每个频道一个 Socket.IO 房间
 * - 用户在网页聊天框发消息 → 收到 "chat:message" → 判断是否指令 → 分发到指令引擎 → 广播结果到房间
 *
 * 对应原版易语言的：
 * - 处理群() / 处理私聊() → 这里的 handleIncomingMessage
 * - 发送群消息() 广播 → 这里的 io.to(room).emit('chat:message')
 */

import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { GlobalConfig } from '../../config/global.config';
import { SystemConfigService } from '../system-config/system-config.service';
import { ChatService } from './chat.service';
import { CommandService } from '../command/command.service';
import { CommandContext, CommandSource } from '../command/interfaces/command.interface';
import { ShortcutService } from '../game/shortcut.service';
import { StatsService } from '../game/stats.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GameService } from '../game/game.service';

/// Socket 客户端附加的用户信息
interface SocketUser {
  userId: number;
  username: string;
  channelId: number;
  role: string;
}

@WebSocketGateway({
  cors: { origin: GlobalConfig.getInstance().corsOrigins, credentials: true },
  namespace: '/ws', // 连接地址形如 ws://host/ws
})
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly commandService: CommandService,
    private readonly jwtService: JwtService,
    private readonly systemConfigService: SystemConfigService,
    private readonly shortcutService: ShortcutService,
    private readonly statsService: StatsService,
    private readonly prisma: PrismaService,
    private readonly gameService: GameService,
  ) {}

  /**
   * 连接建立时：校验 JWT，加入默认世界频道房间
   */
  async handleConnection(client: Socket) {
    try {
      // 从连接握手参数中取 token
      const token = client.handshake.auth?.token || client.handshake.headers?.authorization?.replace('Bearer ', '');
      if (!token) {
        throw new UnauthorizedException('缺少认证令牌');
      }
      // 校验 JWT
      const payload = this.jwtService.verify(token, {
        secret: GlobalConfig.getInstance().jwtSecret,
      });
      // 从数据库查询最新角色（管理员/封禁即时生效）
      const dbUser = await this.prisma.user.findUnique({
        where: { id: payload.userId },
        select: { role: true, status: true },
      });
      if (!dbUser || dbUser.status === 'BANNED') {
        throw new UnauthorizedException('账号不存在或已被封禁');
      }
      // 确保默认频道存在，并获取其 ID
      const channel = await this.chatService.ensureDefaultChannel();

      const user: SocketUser = {
        userId: payload.userId,
        username: payload.username,
        channelId: channel.id,
        role: dbUser.role,
      };
      client.data.user = user;

      // 加入频道房间（房间名用频道名）
      await client.join(channel.name);
      // 加入个人专属房间，供服务端定向推送（如移动到达后刷新地图面板、私聊/反馈消息）
      await client.join(`user:${payload.userId}`);
      // 管理员额外加入 admin 房间，用于接收反馈新消息等通知
      if (['ADMIN', 'SUPER_ADMIN'].includes(dbUser.role)) {
        await client.join('admin');
      }
      // 记录在线状态
      this.statsService.userOnline(payload.userId);
      this.logger.log(`用户 ${payload.username}(id=${payload.userId}) 已连接并加入频道「${channel.name}」`);

      // 通知客户端连接成功
      client.emit('chat:connected', { channel: channel.name, channelId: channel.id });
    } catch (err: any) {
      this.logger.warn(`连接认证失败: ${err.message}`);
      client.emit('error', { message: '连接认证失败' });
      client.disconnect();
    }
  }

  /**
   * 网关初始化完成后，将 Socket.IO 服务端实例注入 ChatService
   * 使 ChatService.broadcastSystem 具备实时广播能力（供延时到达等场景主动推送）
   */
  afterInit(server: Server) {
    this.chatService.setServer(server);
  }

  /**
   * 连接断开清理
   */
  handleDisconnect(client: Socket) {
    const user = client.data?.user as SocketUser | undefined;
    if (user) {
      this.statsService.userOffline(user.userId);
      this.logger.log(`用户 ${user.username}(id=${user.userId}) 断开连接`);
    } else {
      this.logger.log(`客户端断开: ${client.id}`);
    }
  }

  /**
   * 接收用户发来的消息（聊天 或 指令）
   * 前端聊天框发送的内容统一走这里。
   * 支持多行输入：每行作为一个独立指令/聊天消息，按顺序逐行执行。
   */
  @SubscribeMessage('chat:message')
  async handleIncomingMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { content: string },
  ) {
    const user: SocketUser | undefined = client.data.user;
    if (!user) {
      client.emit('error', { message: '未认证' });
      return;
    }
    const content = (body?.content || '').trim();
    if (!content) return;

    // 多行输入：按换行符拆分，逐行顺序执行（每行间隔 300ms，避免后端处理压力）
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length > 1) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        await this.processSingleLine(client, user, line);
        // 最后一行不等待，其余行之间间隔 300ms
        if (i < lines.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
      return;
    }

    // 单行输入：保持原有逻辑
    await this.processSingleLine(client, user, content);
  }

  /**
   * 处理单行消息（指令 或 聊天）
   * 抽离为独立方法，供单行和多行输入复用
   */
  private async processSingleLine(client: Socket, user: SocketUser, rawContent: string) {
    let content = rawContent;

    // 先经过快捷输入系统预处理（快捷键/输入替换/临时替换）
    content = await this.shortcutService.processShortcut(content, user.userId);

    // 判断是否是指令：根据配置的前缀和"是否必须前缀"决定（见 GlobalConfig）
    const isCommand = await this.isCommandInput(content, user.userId);

    if (isCommand) {
      await this.handleCommand(client, user, content);
    } else {
      // 普通聊天，公屏广播
      const msg = await this.chatService.saveMessage({
        channelId: user.channelId,
        senderId: user.userId,
        type: 'chat',
        content,
      });
      this.server.to('世界频道').emit('chat:message', msg);
      // 解析 @提及并定向通知被提及的玩家（不改变公屏显示，仅推送提醒）
      await this.notifyMentions(user, content);
    }
  }

  /**
   * 私聊消息（Socket 实时通道，网页私聊面板使用）
   * 前端发送 { to: 对方用户名/ID, content }，服务端持久化并推送给接收方
   */
  @SubscribeMessage('chat:private')
  async handlePrivateMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { to: string | number; content: string },
  ) {
    const user: SocketUser | undefined = client.data.user;
    if (!user) {
      client.emit('error', { message: '未认证' });
      return;
    }
    const content = (body?.content || '').trim();
    const to = body?.to;
    if (!content || to === undefined || to === null || to === '') return;

    // 根据 用户名/昵称/ID 解析目标用户
    const target = await this.resolveTargetUser(to, user.userId);
    if (!target) {
      client.emit('chat:private-error', { message: '未找到该玩家，请确认用户名是否正确' });
      return;
    }
    if (target.id === user.userId) {
      client.emit('chat:private-error', { message: '不能给自己发送私聊消息' });
      return;
    }
    try {
      const msg = await this.chatService.sendPrivateMessage(user.userId, target.id, content);
      // 回传给自己（便于发送方即时显示）
      client.emit('chat:private', msg);
    } catch (e: any) {
      client.emit('chat:private-error', { message: e.message });
    }
  }

  /**
   * 解析 @提及的目标玩家：按 用户名/昵称/ID 精确匹配
   * @param to 目标标识（用户名/昵称/数字ID）
   * @param selfId 当前用户ID（排除自己）
   */
  private async resolveTargetUser(to: string | number, selfId: number): Promise<any | null> {
    // 数字ID 直接查询
    if (typeof to === 'number' || /^\d+$/.test(String(to))) {
      return this.prisma.user.findUnique({ where: { id: Number(to) } });
    }
    const name = String(to).trim();
    // 优先按用户名精确匹配，其次昵称精确匹配
    return (
      (await this.prisma.user.findFirst({ where: { username: name, id: { not: selfId } } })) ||
      (await this.prisma.user.findFirst({ where: { nickname: name, id: { not: selfId } } })) ||
      null
    );
  }

  /**
   * 解析公屏消息中的 @提及，定向推送给被提及的玩家
   * 被提及玩家在线时收到 chat:at 通知（含提及者信息与原文），可据此跳转回复
   * @param sender 发送者
   * @param content 消息内容
   */
  private async notifyMentions(sender: SocketUser, content: string) {
    const mentions = this.chatService.parseMentions(content);
    if (mentions.length === 0) return;
    for (const name of mentions) {
      const target = await this.resolveTargetUser(name, sender.userId);
      if (!target) continue;
      // 推送给被提及用户：在公屏看到自己被 @，附带来源信息
      this.server
        ?.to(`user:${target.id}`)
        .emit('chat:at', {
          from: { id: sender.userId, username: sender.username },
          content,
          peerId: target.id,
          at: new Date().toISOString(),
        });
    }
  }

  /**
   * 判断输入是否应作为指令处理
   * 规则（可配置，从系统配置中心读取）：
   * - 命中任一配置的前缀 → 是指令
   * - 若 command.requirePrefix=false：无前缀时，若输入命中已注册的指令名/别名 → 是指令；
   *   若输入与当前地图的采集指令(gatherCmd)匹配 → 也是指令（对齐原版运行时匹配，无需预注册）
   * - 否则视为普通聊天
   * @param content 消息内容
   * @param userId 发送者用户ID（用于判定当前地图采集指令）
   */
  private async isCommandInput(content: string, userId: number): Promise<boolean> {
    // 从系统配置中心读取(管理员可在界面在线修改)
    const prefixes = await this.systemConfigService.getCommandPrefixes();
    const requirePrefix = await this.systemConfigService.getCommandRequirePrefix();
    // 命中任一配置的前缀
    if (prefixes.some((p) => p && content.startsWith(p))) {
      return true;
    }
    // 无需强制前缀：先匹配已注册指令名/别名
    if (!requirePrefix) {
      if (await this.commandService.matchCommandName(content)) {
        return true;
      }
      // 其次匹配当前地图的采集指令（对齐原版：采集指令运行时按地图资源匹配）
      const cmdName = content.trim().replace(/^[\/！!]+/, '').split(/\s+/)[0];
      if (cmdName && (await this.gameService.hasGatherCmd(userId, cmdName))) {
        return true;
      }
    }
    return false;
  }

  /**
   * 处理指令：调用指令引擎，结果按需广播或仅回传给发送者
   */
  private async handleCommand(client: Socket, user: SocketUser, content: string) {
    const ctx: CommandContext = {
      userId: user.userId,
      username: user.username,
      channelId: user.channelId,
      channelName: '世界频道',
      rawMessage: content,
      source: CommandSource.WEB,
    };
    const result = await this.commandService.dispatch(ctx);

    // 将指令原文也作为一条聊天记录展示
    await this.chatService.saveMessage({
      channelId: user.channelId,
      senderId: user.userId,
      type: 'command',
      content,
    });

    if (result.broadcast) {
      // 公屏广播指令结果（如移动，所有人都能看到）
      const msg = await this.chatService.saveMessage({
        channelId: user.channelId,
        senderId: user.userId,
        type: 'system',
        content: result.content,
      });
      this.server.to('世界频道').emit('chat:message', msg);
    } else {
      // 仅回传给发送者（如查看背包）
      client.emit('chat:message', {
        type: 'system',
        content: result.content,
        sender: { username: '系统' },
        createdAt: new Date().toISOString(),
      });
    }
  }
}
