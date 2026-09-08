/**
 * 指令引擎模块
 * 提供统一的指令分发、处理器注册与执行能力。
 */

import { Module, forwardRef } from '@nestjs/common';
import { CommandService } from './command.service';
import { CommandSourceRegistry } from './command-source.registry';
import { CommandController } from './command.controller';
import { handlerProviders } from './handlers';
import { CommandHandlerMap } from './command-handler-map.provider';
import { GameModule } from '../game/game.module';

@Module({
  imports: [forwardRef(() => GameModule)],
  providers: [
    CommandService,
    CommandSourceRegistry, // 记录用户最后指令渠道，供 ChatService 过滤 bot:push 回推
    ...handlerProviders,
    CommandHandlerMap, // 构建 key -> handler 的映射 provider
  ],
  controllers: [CommandController],
  exports: [CommandService, CommandSourceRegistry],
})
export class CommandModule {}