/**
 * AstrBot 机器人对接模块
 * 实现机器人与网页游戏引擎的双向对接：
 * - AstrBot(QQ) 收到玩家指令 → 通过 HTTP 调本服务 → 指令引擎执行 → 返回结果 → AstrBot 回复给 QQ
 * - 同时支持 WebSocket 长连接推送（实时公屏同步给机器人）
 *
 * 对应原版易语言的多框架(QQ)对接层，此处抽象为统一的"机器人接入层"。
 */

import { Module } from '@nestjs/common';
import { CommandModule } from '../command/command.module';
import { UsersModule } from '../users/users.module';
import { BotController } from './bot.controller';
import { BotService } from './bot.service';

@Module({
  imports: [CommandModule, UsersModule],
  providers: [BotService],
  controllers: [BotController],
})
export class BotModule {}
