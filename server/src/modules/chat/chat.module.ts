/**
 * 公屏群聊模块
 * 提供"群聊式"的实时公屏消息能力，对应原版 QQ 群聊广播逻辑。
 *
 * 核心能力：
 * - Socket.IO 房间：每个频道一个房间，实现"公屏"广播给该频道所有在线用户
 * - 用户在聊天框发消息 → 网关收到 → 交给指令引擎 → 结果广播到房间
 */

import { Module, Global, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { GlobalConfig } from '../../config/global.config';
import { CommandModule } from '../command/command.module';
import { ChatGateway } from './chat.gateway';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Global()
@Module({
  imports: [
    forwardRef(() => CommandModule),
    // 提供 JwtService，用于 WebSocket 连接的 JWT 校验
    JwtModule.register({
      secret: GlobalConfig.getInstance().jwtSecret,
      signOptions: { expiresIn: GlobalConfig.getInstance().jwtExpiresIn },
    }),
  ],
  providers: [ChatGateway, ChatService],
  controllers: [ChatController],
  exports: [ChatService],
})
export class ChatModule {}
