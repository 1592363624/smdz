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

/// Socket 客户端附加的用户信息
interface SocketUser {
  userId: number;
  username: string;
  channelId: number;
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
      // 确保默认频道存在，并获取其 ID
      const channel = await this.chatService.ensureDefaultChannel();

      const user: SocketUser = {
        userId: payload.userId,
        username: payload.username,
        channelId: channel.id,
      };
      client.data.user = user;

      // 加入频道房间（房间名用频道名）
      await client.join(channel.name);
      // 加入个人专属房间，供服务端定向推送（如移动到达后刷新地图面板）
      await client.join(`user:${payload.userId}`);
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
    let content = (body?.content || '').trim();
    if (!content) return;

    // 先经过快捷输入系统预处理（快捷键/输入替换/临时替换）
    content = await this.shortcutService.processShortcut(content, user.userId);

    // 判断是否是指令：根据配置的前缀和"是否必须前缀"决定（见 GlobalConfig）
    const isCommand = await this.isCommandInput(content);

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
    }
  }

  /**
   * 判断输入是否应作为指令处理
   * 规则（可配置，从系统配置中心读取）：
   * - 命中任一配置的前缀 → 是指令
   * - 若 command.requirePrefix=false：无前缀时，若输入命中已注册的指令名/别名 → 是指令；否则视为聊天
   */
  private async isCommandInput(content: string): Promise<boolean> {
    // 从系统配置中心读取(管理员可在界面在线修改)
    const prefixes = await this.systemConfigService.getCommandPrefixes();
    const requirePrefix = await this.systemConfigService.getCommandRequirePrefix();
    // 命中任一配置的前缀
    if (prefixes.some((p) => p && content.startsWith(p))) {
      return true;
    }
    // 无需强制前缀：精确匹配已注册指令名/别名
    if (!requirePrefix) {
      return this.commandService.matchCommandName(content);
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
