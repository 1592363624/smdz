/**
 * 游戏高光时刻推送服务
 *
 * 用途：把「任务达成 / 领取新任务 / 获得称号 / 等级提升」这类里程碑
 * 以**结构化事件**定向推送给当事玩家，供前端播放屏幕级高光动画。
 *
 * 设计要点：
 * - 与 ChatService 一样采用「网关初始化后注入 server 实例」的模式（见
 *   ChatGateway.afterInit），不参与构造函数依赖注入，因此不会与
 *   CommandModule / GameModule 之间形成循环依赖。
 * - 只按 `user:{userId}` 房间定向推送，不写库、不进公屏，纯通知性质；
 *   推送失败（玩家离线 / socket 未就绪）静默降级，绝不影响主业务链路。
 * - 公屏文本仍照常产出，高光事件只是「额外的视觉增强」，二者互为主备：
 *   前端既有结构化事件驱动，也保留公屏文本兜底解析。
 */
import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';

/** 高光类型：决定前端的配色、图标与文案 */
export type GameHighlightType =
  | 'task-complete' // 完成任务并发放奖励
  | 'task-accept' // 自动领取到后续任务
  | 'title' // 获得新称号
  | 'level-up'; // 等级提升

export interface GameHighlightPayload {
  type: GameHighlightType;
  /** 主标题，如「任务达成」「称号解锁」 */
  title: string;
  /** 副标题/补充说明，如「Lv.3 → Lv.4」 */
  detail?: string;
  /** 主体名称列表（任务名 / 称号名），多条时前端会合并展示 */
  names?: string[];
  /** 奖励行，如「优秀装备补给箱x1.03」 */
  rewards?: string[];
  /** 服务端生成时间戳 */
  at: string;
}

/** 事件名常量：前后端共用 */
export const GAME_HIGHLIGHT_EVENT = 'game:highlight';

@Injectable()
export class GameHighlightService {
  private readonly logger = new Logger(GameHighlightService.name);

  /** Socket.IO 服务端实例，由 ChatGateway.afterInit 注入 */
  private server: Server | null = null;

  /**
   * 注入 Socket.IO 服务端实例
   * @param server Socket.IO 服务端实例
   */
  setServer(server: Server): void {
    this.server = server;
  }

  /**
   * 向指定玩家推送一条高光事件
   * @param userId 目标用户 ID（缺失或非法时静默忽略）
   * @param payload 高光内容（at 由本方法统一补齐）
   */
  emit(userId: number | undefined | null, payload: Omit<GameHighlightPayload, 'at'>): void {
    if (!userId || !Number.isFinite(Number(userId))) return;
    if (!this.server) return;
    try {
      this.server.to(`user:${userId}`).emit(GAME_HIGHLIGHT_EVENT, {
        ...payload,
        at: new Date().toISOString(),
      } as GameHighlightPayload);
    } catch (error: any) {
      // 推送属纯增强能力，任何异常都不能上抛打断业务结算
      this.logger.warn(`推送高光事件失败: ${error?.message || error}`);
    }
  }
}
