/**
 * 公屏群聊模块：Socket.IO 每频道一个房间做"公屏"广播；
 * 用户在聊天框发消息 → 网关收到 → 交给指令引擎 → 结果广播回房间。
 * 对应原版 QQ 群聊广播逻辑。
 */

import { Module, Global, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { GlobalConfig } from '../../config/global.config';
import { CommandModule } from '../command/command.module';
import { GameModule } from '../game/game.module';
import { ChatGateway } from './chat.gateway';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { RedPacketService } from './red-packet.service';

@Global()
@Module({
  imports: [
    forwardRef(() => CommandModule),
    // 显式引入 GameModule，确保 ChatGateway 与 GameController 使用同一个 StatsService 实例
    forwardRef(() => GameModule),
    // 提供 JwtService，用于 WebSocket 连接的 JWT 校验
    JwtModule.register({
      secret: GlobalConfig.getInstance().jwtSecret,
      signOptions: { expiresIn: GlobalConfig.getInstance().jwtExpiresIn },
    }),
  ],
  providers: [ChatGateway, ChatService, RedPacketService],
  controllers: [ChatController],
  exports: [ChatService, RedPacketService],
})
export class ChatModule {}
