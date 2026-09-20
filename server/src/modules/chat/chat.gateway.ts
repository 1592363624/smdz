/**
 * 公屏聊天网关 (Socket.IO)：每频道一个房间，网页聊天框 → 指令判定 → 指令引擎 → 广播回房间。
 * 对应原版易语言：处理群() / 处理私聊() → handleIncomingMessage；发送群消息() → io.to(room).emit('chat:message')。
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
import { GameHighlightService } from '../game/highlight.service';

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

  /** 每用户最近一次发消息时间戳（ms），用于发送间隔限流 */
  private readonly lastUserMessageAt = new Map<number, number>();

  constructor(
    private readonly chatService: ChatService,
    private readonly commandService: CommandService,
    private readonly jwtService: JwtService,
    private readonly systemConfigService: SystemConfigService,
    private readonly shortcutService: ShortcutService,
    private readonly statsService: StatsService,
    private readonly prisma: PrismaService,
    private readonly gameService: GameService,
    private readonly highlightService: GameHighlightService,
  ) {}

  /**
   * 连接建立时：校验 JWT，加入默认世界频道房间
   * 机器人(AstrBot 插件)使用 botToken 握手认证：匹配 BOT_ACCESS_TOKEN 时
   * 加入专用 bot 房间，不进世界频道，仅接收 bot:push 定向推送
   * （延时任务完成/移动到达等系统消息，见 ChatService.broadcastSystem）
   */
  async handleConnection(client: Socket) {
    try {
      // 机器人通道握手：auth.botToken 与 BOT_ACCESS_TOKEN 一致即视为机器人客户端。
      // 令牌为空时永不放行，避免空匹配把所有人放进 bot 房间。
      const botToken = client.handshake.auth?.botToken;
      if (
        botToken &&
        GlobalConfig.getInstance().botAccessToken &&
        botToken === GlobalConfig.getInstance().botAccessToken
      ) {
        client.data.bot = true;
        await client.join('bot');
        this.logger.log('机器人客户端已连接并加入 bot 房间');
        client.emit('chat:connected', { channel: 'bot', bot: true });
        return;
      }

      const token = client.handshake.auth?.token || client.handshake.headers?.authorization?.replace('Bearer ', '');
      if (!token) {
        throw new UnauthorizedException('缺少认证令牌');
      }
      const payload = this.jwtService.verify(token, {
        secret: GlobalConfig.getInstance().jwtSecret,
      });
      // 从数据库查询最新角色（管理员/封禁即时生效，不信任握手里的旧 payload）
      const dbUser = await this.prisma.user.findUnique({
        where: { id: payload.userId },
        select: { role: true, status: true },
      });
      if (!dbUser || dbUser.status === 'BANNED') {
        throw new UnauthorizedException('账号不存在或已被封禁');
      }
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
      // 个人专属房间：供服务端定向推送（移动到达后刷新地图面板、私聊/反馈消息）
      await client.join(`user:${payload.userId}`);
      // admin 房间：接收反馈新消息等管理员通知
      if (['ADMIN', 'SUPER_ADMIN'].includes(dbUser.role)) {
        await client.join('admin');
      }
      // 重连检测必须在计数前采样：本次连接前无任何连接（0→1）才算「回来」，
      // 断开期间的离开计时以此刻为终点（见下方 settleTimeElapsedOnReconnect）
      const wasOffline = !this.statsService.isOnline(user.userId);
      this.statsService.userOnline(user.userId);
      // 在线人数变化 → 广播服务器统计（网页左下角即时刷新）。
      // 只有「从无连接变为有连接」才算上线，同一账号重开标签页不重复提示
      this.refreshStatsBroadcast(wasOffline ? { type: 'online', userId: user.userId } : null);
      this.logger.log(`用户 ${payload.username}(id=${payload.userId}) 已连接并加入频道「${channel.name}」`);

      client.emit('chat:connected', { channel: channel.name, channelId: channel.id });

      // 「WS 连上 = 回来」：结算断开期间的离线补偿（离开时长 = 上次断开时刻 → 此刻，
      // 计时起点精度由 handleDisconnect 的强制结算保证），提示只发个人房间不广播世界频道
      // （刷新页面即重连，广播会刷屏）。
      if (wasOffline) {
        try {
          const awayText = await this.gameService.settleTimeElapsedOnReconnect(user.userId);
          if (awayText) {
            const msg = await this.chatService.saveMessage({
              channelId: user.channelId,
              senderId: user.userId,
              type: 'system',
              content: awayText,
            });
            this.server.to(`user:${user.userId}`).emit('chat:message', msg);
          }
        } catch (e: any) {
          this.logger.warn(`重连离线结算失败: ${e.message}`);
        }
      }
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
    // 高光时刻推送同样需要 server 实例（任务达成/称号/升级的屏幕级动画）
    this.highlightService.setServer(server);
  }

  /** 连接断开清理 */
  handleDisconnect(client: Socket) {
    const user = client.data?.user as SocketUser | undefined;
    if (user) {
      this.statsService.userOffline(user.userId);
      // 引用计数归零才算真正离线（多标签页只关一个既不提示、也不改在线数）
      const trulyOffline = !this.statsService.isOnline(user.userId);
      this.refreshStatsBroadcast(trulyOffline ? { type: 'offline', userId: user.userId } : null);
      this.logger.log(`用户 ${user.username}(id=${user.userId}) 断开连接`);
      // 「WS 断开 = 离开」：仅最后一个连接关闭（引用计数归零）时强制结算一次，
      // 把 lastOpTime 推进到断开时刻，使离开时长从断开这一刻精确起算
      //（重连时由 handleConnection 结算并定向推送提示）。内部自捕获，fire-and-forget。
      if (trulyOffline) {
        void this.gameService.settleTimeElapsedOnDisconnect(user.userId);
      }
    } else {
      this.logger.log(`客户端断开: ${client.id}`);
    }
  }

  /**
   * 重新统计并广播「服务器统计」（总玩家数/在线人数/在线玩家名单）到所有客户端。
   * 同时下发 presence 事件，客户端据此在状态栏在线数后面展示 1 分钟上下线提示
   * （保留时长由前端配置控制）。
   *
   * @param presence 本次触发的上下线玩家；无实际在线状态变化（如同一账号开新标签页）传 null
   */
  private async refreshStatsBroadcast(
    presence: { type: 'online' | 'offline'; userId: number } | null = null,
  ): Promise<void> {
    try {
      const stats = await this.statsService.getStats();
      let payload: typeof stats & { presence?: { type: 'online' | 'offline'; name: string } } = stats;
      if (presence) {
        // 名字解析失败只影响提示文案，不应阻断统计广播本身，故单独兜底
        let name = '';
        try {
          name = await this.statsService.getUserDisplayName(presence.userId);
        } catch (e: any) {
          this.logger.warn(`解析上下线玩家名失败(userId=${presence.userId}): ${e.message}`);
        }
        payload = { ...stats, presence: { type: presence.type, name } };
      }
      this.server.emit('stats:update', payload);
    } catch (e: any) {
      this.logger.warn(`广播服务器统计失败: ${e.message}`);
    }
  }

  /**
   * 接收用户发来的消息（聊天 或 指令），前端聊天框统一走这里。
   * 支持多行输入：每行作为独立指令/聊天消息，按顺序逐行执行。
   *
   * source='floating'（右下角世界聊天悬浮窗发出）：该入口定位为纯聊天频道，
   * 内容一律作为聊天广播，不进快捷替换/指令系统——"在哪个窗口发就归哪个窗口"，
   * 避免"签到"这类指令名文字在悬浮窗发出后被执行并跑到中央公屏。
   */
  @SubscribeMessage('chat:message')
  async handleIncomingMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { content: string; source?: string },
  ) {
    const user: SocketUser | undefined = client.data.user;
    if (!user) {
      client.emit('error', { message: '未认证' });
      return;
    }
    const content = (body?.content || '').trim();
    if (!content) return;
    const source = body?.source === 'floating' ? 'floating' : 'main';

    // 发送间隔限流（防刷屏）：0=不限制
    const intervalMs = await this.getMessageIntervalMs();
    if (intervalMs > 0 && !this.tryConsumeMessageSlot(user.userId, intervalMs)) {
      const waitSec = this.formatRateLimitWaitSec(user.userId, intervalMs);
      // 专用事件名：`error` 在 Socket.IO 中语义特殊，前端也不一定展示
      client.emit('chat:rate-limit', { message: `消息发送过于频繁，请 ${waitSec} 秒后再发` });
      return;
    }

    // 多行输入：按换行拆分逐行顺序执行（行间同样受发送间隔约束，避免后端处理压力）
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length > 1) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        await this.processSingleLine(client, user, line, source);
        if (i < lines.length - 1) {
          await new Promise(resolve => setTimeout(resolve, Math.max(intervalMs, 100)));
          // 行间刷新冷却起点，避免一次多行粘贴绕过间隔限制
          this.lastUserMessageAt.set(user.userId, Date.now());
        }
      }
      return;
    }

    await this.processSingleLine(client, user, content, source);
  }

  /** 读取用户消息最小间隔（毫秒）；配置异常或 ≤0 时返回 0（不限制） */
  private async getMessageIntervalMs(): Promise<number> {
    try {
      const sec = await this.systemConfigService.getMessageIntervalSec();
      const n = Number(sec);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return Math.round(n * 1000);
    } catch {
      return 0;
    }
  }

  /**
   * 检查并记录本次发送时间戳。
   * @returns true=允许发送；false=间隔未到（本次不更新时间戳，避免惩罚重试）
   */
  private tryConsumeMessageSlot(userId: number, intervalMs: number): boolean {
    const now = Date.now();
    const last = this.lastUserMessageAt.get(userId) || 0;
    if (last > 0 && now - last < intervalMs) return false;
    this.lastUserMessageAt.set(userId, now);
    return true;
  }

  /** 还需等待多少秒（至少 0.1s，保留一位小数） */
  private formatRateLimitWaitSec(userId: number, intervalMs: number): number {
    const remaining = intervalMs - (Date.now() - (this.lastUserMessageAt.get(userId) || 0));
    return Math.max(0.1, Math.ceil(remaining / 100) / 10);
  }

  /**
   * 处理单行消息（指令 或 聊天），单行与多行输入共用。
   * @param source 消息来源：'floating'=世界聊天悬浮窗（纯聊天，不进指令系统）；'main'=主输入框（指令判定优先）
   */
  private async processSingleLine(
    client: Socket,
    user: SocketUser,
    rawContent: string,
    source: 'floating' | 'main' = 'main',
  ) {
    let content = rawContent;

    // 悬浮窗消息：定位为纯聊天频道，跳过快捷替换与指令判定，直接公屏广播
    if (source !== 'floating') {
      // 先经过快捷输入系统预处理（快捷键/输入替换/临时替换）
      content = await this.shortcutService.processShortcut(content, user.userId);

      // 判断是否是指令：根据配置的前缀和"是否必须前缀"决定（见 GlobalConfig）
      const isCommand = await this.isCommandInput(content, user.userId);

      if (isCommand) {
        // 新玩家选使魔门禁不在网关重复判定：CommandService.dispatch 已有同款拦截
        // （覆盖网页/AstrBot/API 所有渠道），且门禁判定需要全量读玩家——网关这边
        // 每条指令都读一遍纯属浪费，直接放行交给 dispatch。
        await this.handleCommand(client, user, content);
        return;
      }
    }

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

  /**
   * 解析 @提及 的目标玩家：按 用户名/昵称/ID 精确匹配
   * @param to 目标标识（用户名/昵称/数字ID）
   * @param selfId 当前用户ID（排除自己）
   */
  private async resolveTargetUser(to: string | number, selfId: number): Promise<any | null> {
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
   * 解析公屏消息中的 @提及，定向推送给被提及的玩家：
   * 在线时收到 chat:at 通知（含提及者信息与原文），可据此跳转回复。
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
   * 判断输入是否应作为指令处理（前缀与开关均从系统配置中心读取，管理员可在线改）：
   * - 命中任一配置的前缀 → 是指令
   * - 若 command.requirePrefix=false：无前缀时，若输入命中已注册的指令名/别名 → 是指令；
   *   若输入与当前地图的采集指令(gatherCmd)匹配 → 也是指令（对齐原版运行时匹配，无需预注册）
   * - 否则视为普通聊天
   * @param userId 发送者用户ID（用于判定当前地图采集指令）
   */
  private async isCommandInput(content: string, userId: number): Promise<boolean> {
    const prefixes = await this.systemConfigService.getCommandPrefixes();
    const requirePrefix = await this.systemConfigService.getCommandRequirePrefix();
    if (prefixes.some((p) => p && content.startsWith(p))) {
      return true;
    }
    if (!requirePrefix) {
      if (await this.commandService.matchCommandName(content)) {
        return true;
      }
      // 采集指令按当前地图资源运行时匹配（对齐原版），不要求预注册
      const cmdName = content.trim().replace(/^[\/！!]+/, '').split(/\s+/)[0];
      if (cmdName && (await this.gameService.hasGatherCmd(userId, cmdName))) {
        return true;
      }
    }
    return false;
  }

  /** 处理指令：调用指令引擎，结果按需广播或仅回传给发送者 */
  private async handleCommand(_client: Socket, user: SocketUser, content: string) {
    const ctx: CommandContext = {
      userId: user.userId,
      username: user.username,
      channelId: user.channelId,
      channelName: '世界频道',
      rawMessage: content,
      source: CommandSource.WEB,
    };

    // 指令原文先作为公屏消息广播，让所有人（含发送者）看到"谁发了什么指令"，
    // 其后才是系统回复（对齐原版群聊）。必须在 dispatch 之前广播：攻击/采集/移动等
    // 指令内部有大量数据库读写与结算，等执行完再广播会让发送者迟迟看不到自己刚发的文字。
    const cmdMsg = await this.chatService.saveMessage({
      channelId: user.channelId,
      senderId: user.userId,
      type: 'command',
      content,
    });
    this.server.to('世界频道').emit('chat:message', cmdMsg);

    const result = await this.commandService.dispatch(ctx);

    // 指令结果统一落库 + 广播到世界频道：本游戏定位"公屏聊天"，背包/属性等查询结果
    // 不属于私密信息，一律公开展示；不落库的回包在刷新后会从历史接口（ChatMessage 表）
    // 消失，导致前端卡片丢失，因此实时与历史必须一致。
    // 私密结果（visibility='private'，如探测雷达）：真实内容仅定向回传发送者本人，
    // 其他玩家只收到占位提示，防止他人白嫖探测结果。
    const isPrivate = result.visibility === 'private';
    try {
      // 私密结果：占位文本随消息落库，供历史加载脱敏时使用（规则配置的占位优先）
      const placeholder = isPrivate
        ? result.placeholder || this.chatService.getPrivatePlaceholder()
        : undefined;
      const msg = await this.chatService.saveMessage({
        channelId: user.channelId,
        senderId: user.userId,
        type: 'system',
        content: result.content,
        visibility: isPrivate ? 'private' : 'public',
        placeholder,
      });
      if (isPrivate) {
        // 世界频道内除发送者外所有人：只看到占位提示
        this.server
          .to('世界频道')
          .except(`user:${user.userId}`)
          .emit('chat:message', { ...msg, content: placeholder });
        // 发送者本人：定向推送真实内容
        this.server.to(`user:${user.userId}`).emit('chat:message', msg);
      } else {
        this.server.to('世界频道').emit('chat:message', msg);
      }
    } catch (e: any) {
      // saveMessage 内部已做超长截断 + 短提示兜底；这里兜最后一层：
      // 落库链路仍炸（库不可用等）时，至少给发送者一条可读失败回执，避免「指令执行了却毫无回包」
      this.logger.error(`指令结果广播失败: ${e?.message ?? e}`);
      this.server.to(`user:${user.userId}`).emit('chat:message', {
        type: 'system',
        content: '指令已执行，但结果上屏失败，请稍后重试或刷新查看历史消息。',
        sender: null,
        createdAt: new Date().toISOString(),
      });
    }
  }
}
