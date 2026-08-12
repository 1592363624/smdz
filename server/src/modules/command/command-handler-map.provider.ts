/**
 * 指令处理器映射 Provider
 * 将所有 CommandHandler 实例组装成 { key: handler } 映射，供 CommandService 分发使用。
 */

import { Provider } from '@nestjs/common';
import { handlerProviders } from './handlers';
import { CommandHandler } from './interfaces/command.interface';

/** 注入 token：用于获取 handler 映射表 */
export const COMMAND_HANDLER_MAP = 'COMMAND_HANDLER_MAP';

/**
 * 工厂 Provider
 * 通过 @Inject 拿到所有 handler 实例数组，构建 key -> handler 映射。
 * 注意：inject 数组会逐个解析，因此 useFactory 用 rest 参数接收所有 handler 实例。
 */
export const CommandHandlerMap: Provider = {
  provide: COMMAND_HANDLER_MAP,
  inject: handlerProviders,
  useFactory: (...handlers: CommandHandler[]): Record<string, CommandHandler> => {
    const map: Record<string, CommandHandler> = {};
    for (const handler of handlers) {
      if (handler && handler.key) {
        map[handler.key] = handler;
      }
    }
    return map;
  },
};