/**
 * Actor 运行时模块
 *
 * 把通用 Actor 运行时作为全局单例提供。玩家类型由 PlayerService 自行注册
 * （registerType('player', ...)），因为它要复用 getPlayerData / savePlayer 的
 * 归一化与货币列化逻辑。
 *
 * 注册完成后，任意服务都能注入 ActorRuntime，并通过 runtime.run/tell/ask 以「每实体一个
 * 串行邮箱 + 内存态 + 异步落库」的纯 Actor 语义访问有状态实体。
 *
 * 说明（RVW04 P1-4）：曾在此于 onModuleInit 时把 monster/map/vehicle/shopitem 四种
 * 实体注册为 Actor（actor/builtin-types.ts），但业务代码零调用（地图写走 map.service
 * 自带 withMapLock 闭环），属悬空注册，已整体移除；等真实跨实体原子需求（如玩家间
 * 交易）出现时再按需以 registerType 加回，运行时通用内核不受影响。
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
