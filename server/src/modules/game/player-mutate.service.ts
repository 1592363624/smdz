/**
 * 玩家写入口收口（P2）+ 货币审计（P4）
 *
 * mutate(userId, fn) 是玩家数据「读-改-写」的唯一推荐入口：
 *   - 全程持 PlayerService 共享用户级锁（与兑换/召唤/战斗/后台结算互斥）
 *   - 快照来自锁内的一次新鲜读取，杜绝旧快照覆盖
 *   - 保存走 savePlayer 的 CAS，即使未来有路径绕过锁也有版本号兜底
 *
 * 货币审计（P4）：每次保存若货币列发生变化，写入 CurrencyLog 一条
 * （谁、哪种货币、变动量、变动后余额）。审计失败不影响业务主流程。
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerData, PlayerService } from './player.service';

/** 参与审计的货币列 → 中文名 */
const CURRENCY_COLUMNS: Array<{ column: 'diamonds' | 'tickets' | 'dataCores'; label: string }> = [
  { column: 'diamonds', label: '钻石' },
  { column: 'tickets', label: '召唤券' },
  { column: 'dataCores', label: '数据核心' },
];

export interface MutateContext extends PlayerData {
  /** 声明本次修改涉及货币变动的原因（用于审计日志备注位，可选） */
  auditReason?: string;
}

@Injectable()
export class PlayerMutateService {
  private readonly logger = new Logger(PlayerMutateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
  ) {}

  /**
   * 在共享用户级锁内读取最新快照并执行变更，结束后统一落库。
   * @param userId 用户ID
   * @param fn 变更逻辑；通过 ctx.player 直接修改字段，返回值作为本方法返回值
   */
  async mutate<T>(userId: number, fn: (ctx: MutateContext) => Promise<T> | T): Promise<T> {
    return this.playerService.withUserLock(userId, async () => {
      const ctx = (await this.playerService.getPlayerData(userId)) as MutateContext;

      const before = this.readCurrencies(ctx.player);
      const result = await fn(ctx);
      await this.playerService.savePlayer(ctx.player);
      const after = this.readCurrencies(ctx.player);

      this.auditCurrencyChanges(Number(userId), before, after, (ctx as any).auditReason);
      return result;
    });
  }

  private readCurrencies(player: any): Record<string, number> {
    const out: Record<string, number> = {};
    for (const { column } of CURRENCY_COLUMNS) {
      out[column] = Number(player?.[column] ?? 0);
    }
    return out;
  }

  /** 对比前后余额，差异非零的货币各记一条审计日志。失败仅告警。 */
  private auditCurrencyChanges(
    userId: number,
    before: Record<string, number>,
    after: Record<string, number>,
    reason?: string,
  ): void {
    try {
      for (const { column, label } of CURRENCY_COLUMNS) {
        const delta = Number((after[column] - before[column]).toFixed(6));
        if (!Number.isFinite(delta) || delta === 0) continue;
        void this.prisma.currencyLog
          .create({
            data: {
              userId,
              currency: label,
              delta,
              balanceAfter: after[column],
            },
          })
          .catch((err: any) =>
            this.logger.warn(`货币审计写入失败 userId=${userId} ${label}: ${err?.message || err}`),
          );
      }
    } catch (err: any) {
      // 审计是旁路：任何异常不得影响业务结果
      this.logger.warn(`货币审计异常 userId=${userId}: ${err?.message || err}`);
    }
  }
}
