/**
 * Actor 运行时模块
 *
 * 把通用 Actor 运行时作为全局单例提供，并在应用启动（onModuleInit）时把全部有状态实体
 * 注册为 Actor 类型（怪物/地图/载具/商店物品）。玩家类型由 PlayerService 自行注册，
 * 因为它要复用 getPlayerData / savePlayer 的归一化与货币列化逻辑。
 *
 * 注册完成后，任意服务都能注入 ActorRuntime，并通过 runtime.run/tell/ask 以「每实体一个
 * 串行邮箱 + 内存态 + 异步落库」的纯 Actor 语义访问任意有状态实体。
 */

import { Global, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ActorRuntime, ACTOR_RUNTIME_OPTIONS } from './actor-runtime';
import { registerBuiltinActorTypes } from './builtin-types';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
class ActorBootstrap implements OnModuleInit {
  constructor(
    private readonly runtime: ActorRuntime,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    // 注册怪物/地图/载具/商店物品四种实体为 Actor（玩家由 PlayerService 注册）
    registerBuiltinActorTypes(this.runtime, this.prisma);
  }
}

@Global()
@Module({
  providers: [
    // 配置令牌：默认空对象；需要调参（lruMax/mailboxMaxDepth/...）时可在此覆盖
    { provide: ACTOR_RUNTIME_OPTIONS, useValue: {} },
    ActorRuntime,
    ActorBootstrap,
  ],
  exports: [ActorRuntime],
})
export class ActorModule {}
