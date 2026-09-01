/**
 * 反馈系统服务
 * 封装反馈工单的 CRUD、消息追加、状态变更等核心业务逻辑，
 * 并通过 Socket.IO 实时推送通知管理员/用户。
 */
import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Server } from 'socket.io';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);
  /** Socket.IO 服务端实例，由 FeedbackGateway 注入 */
  private server: Server | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** 注入 Socket.IO 实例（由 FeedbackGateway 在 afterInit 调用） */
  setServer(server: Server): void {
    this.server = server;
  }

  /**
   * 创建一条新的反馈工单
   * 自动创建首条消息，并通过 Socket 广播通知管理员房间
   */
  async create(userId: number, data: { title: string; category: string; content: string; attachments: string[] }) {
    const feedback = await this.prisma.feedback.create({
      data: {
        userId,
        title: data.title,
        category: data.category,
        status: 'OPEN',
        messages: {
          create: {
            senderId: userId,
            senderType: 'user',
            content: data.content,
            // attachments 为原生 Json 列，直接传数组（stringify 会双重编码）
            attachments: data.attachments || [],
          },
        },
      },
      include: {
        user: { select: { id: true, username: true, nickname: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            sender: { select: { id: true, username: true, nickname: true } },
          },
        },
      },
    });

    // 通知在线管理员：有新反馈工单
    this.server?.to('admin').emit('feedback:new', {
      feedback: {
        id: feedback.id,
        title: feedback.title,
        category: feedback.category,
        user: feedback.user,
        createdAt: feedback.createdAt,
      },
    });

    return feedback;
  }

  /**
   * 获取指定用户的反馈列表（按更新时间倒序）
   * 同时附带每个工单的未读管理员消息数（用户未查看过的管理员回复）
   * 未读定义：FeedbackMessage.createdAt > Feedback.userLastReadAt 且 senderType === 'admin'
   */
  async getUserFeedbacks(userId: number) {
    const [list, unreadMap] = await Promise.all([
      this.prisma.feedback.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
        include: {
          user: { select: { id: true, username: true, nickname: true } },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1, // 最后一条消息预览
            include: {
              sender: { select: { id: true, username: true, nickname: true } },
            },
          },
        },
      }),
      this.countUnreadByFeedback(userId),
    ]);
    return list.map((fb) => ({ ...fb, unreadCount: unreadMap.get(fb.id) || 0 }));
  }

  /**
   * 批量统计用户的每个工单中"未读管理员消息数"
   * 单次 SQL 完成，避免 N+1；返回值 Map<feedbackId, unreadCount>
   */
  async countUnreadByFeedback(userId: number): Promise<Map<number, number>> {
    // 用原生 SQL 一次性 JOIN 统计：未读 = userLastReadAt 之后由 admin 发送的消息数
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ feedbackId: number; cnt: number | bigint }>
    >(
      `SELECT f.id AS feedbackId,
              (SELECT COUNT(*) FROM FeedbackMessage m
                 WHERE m.feedbackId = f.id
                   AND m.senderType = 'admin'
                   AND m.createdAt > f.userLastReadAt) AS cnt
         FROM Feedback f
        WHERE f.userId = ?`,
      userId,
    );
    const map = new Map<number, number>();
    for (const r of rows) {
      map.set(r.feedbackId, Number(r.cnt) || 0);
    }
    return map;
  }

  /**
   * 获取单个反馈工单详情（含完整消息列表）
   * 仅限工单所有者或管理员查看
   * 副作用：当查看者为工单所有者时，自动更新其 userLastReadAt 为当前时间，
   *       用于下次 getUserFeedbacks 时不再把这次已看的管理员消息算作未读
   */
  async getFeedbackDetail(feedbackId: number, userId: number, userRole: string) {
    const feedback = await this.prisma.feedback.findUnique({
      where: { id: feedbackId },
      include: {
        user: { select: { id: true, username: true, nickname: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            sender: { select: { id: true, username: true, nickname: true } },
          },
        },
      },
    });
    if (!feedback) throw new NotFoundException('反馈工单不存在');
    // 权限校验：仅本人或管理员可查看
    if (feedback.userId !== userId && !['ADMIN', 'SUPER_ADMIN'].includes(userRole)) {
      throw new ForbiddenException('无权查看此反馈工单');
    }
    // 工单所有者查看 → 更新最后已读时间（管理员视角不更新，避免污染用户未读统计）
    if (feedback.userId === userId) {
      await this.prisma.feedback.update({
        where: { id: feedbackId },
        data: { userLastReadAt: new Date() },
      });
      feedback.userLastReadAt = new Date();
    }
    return feedback;
  }

  /**
   * 在现有反馈工单下追加一条消息（用户或管理员均可）
   */
  async addMessage(
    feedbackId: number,
    senderId: number,
    senderType: string,
    data: { content: string; attachments: string[] },
    userRole: string,
  ) {
    const feedback = await this.prisma.feedback.findUnique({ where: { id: feedbackId } });
    if (!feedback) throw new NotFoundException('反馈工单不存在');

    // 权限校验：仅本人或管理员可回复
    if (feedback.userId !== senderId && !['ADMIN', 'SUPER_ADMIN'].includes(userRole)) {
      throw new ForbiddenException('无权回复此反馈工单');
    }

    // 如果工单已 CLOSED，管理员级别可再次开启，用户不允许回复
    if (feedback.status === 'CLOSED' && !['ADMIN', 'SUPER_ADMIN'].includes(userRole)) {
      throw new ForbiddenException('该反馈工单已关闭，无法继续回复');
    }

    // 创建消息
    const msg = await this.prisma.feedbackMessage.create({
      data: {
        feedbackId,
        senderId,
        senderType,
        content: data.content,
        // attachments 为原生 Json 列，直接传数组（stringify 会双重编码）
        attachments: data.attachments || [],
      },
      include: {
        sender: { select: { id: true, username: true, nickname: true } },
      },
    });

    // 自动更新工单更新时间
    await this.prisma.feedback.update({
      where: { id: feedbackId },
      data: { updatedAt: new Date() },
    });

    // 实时推送新消息
    const receiverRoom = senderType === 'admin' ? `user:${feedback.userId}` : 'admin';
    this.server?.to(receiverRoom).emit('feedback:message', {
      feedbackId,
      message: msg,
    });

    return msg;
  }

}