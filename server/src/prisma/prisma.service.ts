/**
 * Prisma 服务
 * 封装 PrismaClient 生命周期，随 Nest 应用启动/销毁。
 *
 * 数据→UI 自动同步：通过 $use 中间件拦截对游戏实体表（Player/GameMonster）
 * 的全部写操作，写成功后向 ChangeBus 广播"某实体脏了"事件，
 * 由 SyncProjector 推导受影响用户并触发防抖推送。业务代码零感知。
 */

import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ChangeBusService } from '../game-sync/change-bus.service';
import { inspectWriteParams } from '../game-sync/write-inspect';
import { writeContext } from '../game-sync/write-context';

/** 需要触发 UI 同步的游戏实体模型（白名单，避免系统表/日志表误伤） */
const SYNC_MODELS = new Set(['Player', 'GameMonster']);
/** 视为"写入"的操作动词 */
const WRITE_OPERATIONS = new Set(['create', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Optional() private readonly changeBus?: ChangeBusService) {
    super();
    // $use 直接作用于实例（Prisma 5 支持），无需替换 client。
    // 注意：$use 回调内不能引用 this.changeBus 之外的重逻辑；解析交给纯函数。
    this.$use(async (params, next) => {
      // 乐观锁中央自增：任何绕过 PlayerService.savePlayer 的直接写库
      // （admin/GM、道具系统定点写、定时清理等）也必须推进 version，
      // 否则并发中的旧快照 CAS 仍能通过并覆盖这些写入。调用方已显式
      // 携带 version（如 savePlayer 的 CAS 写法）时不重复注入。
      try {
        const p = params as any;
        if (
          p.model === 'Player'
          && (p.operation === 'update' || p.operation === 'updateMany')
          && p.args?.data
          && p.args.data.version === undefined
        ) {
          p.args.data.version = { increment: 1 };
        }
      } catch {
        // 旁路注入失败不得影响数据操作本身
      }

      const result = await next(params);
      try {
        const { model, operation, args } = params as any;
        if (model && WRITE_OPERATIONS.has(operation) && SYNC_MODELS.has(model)) {
          const ctx = writeContext.getStore();
          if (!ctx?.silent) {
            const info = inspectWriteParams(String(model), String(operation), args);
            if (info) {
              if (info.entity === 'player') {
                this.changeBus?.emit({ entity: 'player', userId: info.userId!, writer: `prisma:${operation}` });
              } else {
                this.changeBus?.emit({
                  entity: 'monster',
                  monsterId: info.monsterId ?? 0,
                  mapId: info.mapId!,
                  writer: `prisma:${operation}`,
                });
              }
            }
          }
        }
      } catch {
        // 拦截器是旁路：任何异常不得影响数据操作结果本身
      }
      return result;
    });
  }

  /** 应用启动时建立数据库连接 */
  async onModuleInit() {
    await this.$connect();
  }

  /** 应用销毁时断开数据库连接 */
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
