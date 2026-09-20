/**
 * Actor 运行时模块：把通用 Actor 运行时作为全局单例提供。
 * 玩家类型由 PlayerService 自行注册（registerType('player', ...)），
 * 因为它要复用 getPlayerData / savePlayer 的归一化与货币列化逻辑。
 * 之后任意服务都能注入 ActorRuntime，用 run/tell/ask 以「每实体一个串行邮箱 +
 * 内存态 + 异步落库」的纯 Actor 语义访问有状态实体。
 */

import { Global, Module } from '@nestjs/common';
import { ActorRuntime, ACTOR_RUNTIME_OPTIONS } from './actor-runtime';

@Global()
@Module({
  providers: [
    // 配置令牌：默认空对象；需要调参（lruMax/mailboxMaxDepth/...）时可在此覆盖
    { provide: ACTOR_RUNTIME_OPTIONS, useValue: {} },
    ActorRuntime,
  ],
  exports: [ActorRuntime],
})
export class ActorModule {}
