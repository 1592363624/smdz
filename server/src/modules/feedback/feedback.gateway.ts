/**
 * 反馈系统网关 (Socket.IO)
 * 仅负责将 Socket.IO 服务端实例注入 FeedbackService，
 * 使服务在创建工单/追加消息/状态变更时能实时推送给管理员或对应玩家。
 */
import { OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { GlobalConfig } from '../../config/global.config';
import { FeedbackService } from './feedback.service';

@WebSocketGateway({
  cors: { origin: GlobalConfig.getInstance().corsOrigins, credentials: true },
  namespace: '/ws', // 与公屏聊天同一命名空间
})
export class FeedbackGateway implements OnGatewayInit {
  @WebSocketServer()
  server: Server;

  constructor(private readonly feedbackService: FeedbackService) {}

  /**
   * 网关初始化完成后，将 Socket.IO 实例注入 FeedbackService
   */
  afterInit(server: Server) {
    this.feedbackService.setServer(server);
  }
}
