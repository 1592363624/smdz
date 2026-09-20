/**
 * 指令来源登记器：记录每个用户「最后一次发指令的渠道」，供 ChatService.broadcastSystem
 * 过滤延时系统消息的机器人回推（bot:push）。
 *
 * 判定规则（不设时间窗口，按「最后指令来源归属」）：用户最后一次用哪个渠道发指令，
 * 其延时结算结果就回推到哪个渠道。
 * - QQ 发「前往火山」→ 到达消息推 QQ（即使延时很久也推，因为是指令的结果）；
 * - 网页发「前往火山」→ 到达消息不推 QQ（只走网页公屏）。
 *
 * 存储为内存 Map（进程级状态，无需持久化）：
 * - 重启丢失后默认「非 QQ 来源」→ 不推 bot:push，宁可漏推不错推；
 * - 玩家在 QQ 再发一条指令即恢复回推。
 */

import { Injectable } from '@nestjs/common';
import { CommandSource } from './interfaces/command.interface';

@Injectable()
export class CommandSourceRegistry {
  /** userId -> 最后一次发指令的来源 */
  private lastSourceByUser = new Map<number, CommandSource>();

  /** 由 CommandService.dispatch 统一调用（所有渠道入口都汇聚于此），每次覆盖写。 */
  mark(userId: number, source: CommandSource): void {
    if (!Number.isFinite(userId)) return;
    this.lastSourceByUser.set(userId, source);
  }

  /** 最后一次指令是否来自 AstrBot（QQ）；无记录/网页/API 一律 false（不回推 QQ）。 */
  isFromBot(userId: number): boolean {
    return this.lastSourceByUser.get(userId) === CommandSource.ASTRBOT;
  }
}
