/**
 * 指令引擎模块
 * 提供统一的指令分发、处理器注册与执行能力。
 */

import { Module, forwardRef } from '@nestjs/common';
import { CommandService } from './command.service';
import { CommandController } from './command.controller';
import { handlerProviders } from './handlers';
import { CommandHandlerMap } from './command-handler-map.provider';
import { GameModule } from '../game/game.module';

@Module({
  imports: [forwardRef(() => GameModule)],
  providers: [
    CommandService,
    ...handlerProviders,
    CommandHandlerMap, // 构建 key -> handler 的映射 provider
  ],
  controllers: [CommandController],
  exports: [CommandService],
})
export class CommandModule {}