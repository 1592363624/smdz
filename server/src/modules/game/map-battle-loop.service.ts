/**
 * 地图怪物自动攻击循环
 *
 * 复刻原版易语言 _主程序.ecode L200-535「覅攻击pd」的延时递归驱动：
 *   - 原版每回合随机一只存活怪物攻击全图玩家/召唤物，回合结束时若仍有目标，
 *     通过 新建延时("覅攻击pd"+地图, "0", 群号, 4)（L504）自动续下一回合，
 *     直到 无目标（"#没有目标"，战斗相关.ecode L47）或地图"活动"标记过期（L211）才停止。
 *   - 后台「延时执行」线程（后台运作.ecode L1532）每秒扫描待执行延时，
 *     按 (命令,qq) 去重 —— 同一地图同时最多存在一个待执行回合；玩家动作只负责拉起，
 *     不会叠加多个并行循环。
 *
 * 触发点对齐原版 新建延时 调用位：
 *   - 攻击指令（_主程序.ecode L166，3秒）→ CombatSystemService.weaponAttack
 *   - 采集（L11426，5秒）→ GameService 采集结算
 *   - 传送/跃迁到达（L1761/1767/1790，5秒）→ GameService.performArrival
 *   - 地精攻势（L2167，3秒）→ GameService 家园前线
 *   - 使魔技能延时（使魔技能.ecode，5秒）→ FamiliarSkillsService
 *
 * 回合本体复用 CombatSystemService.adminAttackMap（单回合地图战斗节拍），
 * 结果通过世界频道系统消息广播（对应原版 发送群消息）。
 */

import { Inject, Injectable, Logger, OnApplicationShutdown, Optional, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MapService } from './map.service';
import { CombatStateService } from './combat-state.service';
import { StatsService } from './stats.service';
import { ChatService } from '../chat/chat.service';
import { CombatSystemService } from './combat-system.service';
import { hasActive } from './expire-time.util';

@Injectable()
export class MapBattleLoopService implements OnApplicationShutdown {
  private readonly logger = new Logger(MapBattleLoopService.name);

  /** 每张地图最多一个待执行回合（原版 延时执行 线程对 (命令,qq) 去重） */
  private readonly timers = new Map<number, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mapService: MapService,
    private readonly combatState: CombatStateService,
    private readonly statsService: StatsService,
    private readonly chatService: ChatService,
    @Inject(forwardRef(() => CombatSystemService))
    private readonly combatSystem: CombatSystemService,
  ) {}

  /**
   * 原版 新建延时("覅攻击pd"+地图, "0", 群号, N秒)：延时拉起一回合地图怪物攻击。
   * 同一地图已有待执行回合时本次调用被丢弃（原版 延时执行 去重语义）。
   */
  scheduleRound(mapId: number, delaySec: number): void {
    const id = Number(mapId);
    if (!Number.isFinite(id) || id <= 0) return;
    const delayMs = Math.round(Number(delaySec) * 1000);
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    if (this.timers.has(id)) return;

    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.runRound(id);
    }, delayMs);
    // 延时游戏事件不阻塞进程退出/测试收尾（原版进程退出同样丢弃待执行延时）
    const unref = (timer as any)?.unref;
    if (typeof unref === 'function') unref.call(timer);
    this.timers.set(id, timer);
  }

  /** 该地图是否有待执行回合（测试与运维观测用） */
  hasPendingRound(mapId: number): boolean {
    return this.timers.has(Number(mapId));
  }

  /**
   * 玩家活跃（后台运作.ecode L399-411）+ 延时拉起怪物攻击回合。
   *   - 地图"活动"标记刷新 120 秒（L409，循环的存活窗口）；
   *   - 玩家"战斗"标记 15 秒（L410，随调用方的玩家保存流程落库）；
   *   - 新建延时("覅攻击pd"+地图, delaySec)。
   * 隐匿豁免（_主程序.ecode L152-165）：隐匿模式玩家不惊动怪物。
   * @param context 可选的已加载玩家/地图对象（避免重复读库）；player 需为可写对象
   */
  async triggerByPlayerAction(
    userId: number,
    delaySec: number,
    context?: { player?: any; map?: any },
  ): Promise<void> {
    try {
      const uid = Number(userId);
      if (!Number.isFinite(uid) || uid <= 0) return;

      const player = context?.player
        ?? await this.prisma.player.findUnique({ where: { userId: uid } });
      if (!player) return;

      // 原版 L160：标记要求("隐匿模式", 玩家.增益) → 隐匿攻击，不拉起怪物回合
      const buffs = this.safeParseArray(player.buffs);
      if (hasActive(buffs, '隐匿模式')) return;

      const map = context?.map ?? await this.mapService.getMapById(Number(player.mapId));
      if (!map) return;

      // 原版 L410：获得增益(玩家.标记2, "战斗", 15)——挂在完整玩家对象上，
      // 由调用方随战斗流程统一保存；仅传 userId 的轻量路径不回写（15秒标记可容忍丢失）。
      if (context?.player) {
        try {
          const playerBuffs = this.safeParseArray(context.player.buffs);
          this.combatState.gainBuff(playerBuffs, '战斗', 15, false, Date.now());
          context.player.buffs = JSON.stringify(playerBuffs);
        } catch { /* 战斗标记失败不影响循环拉起 */ }
      }

      // 原版 L409：获得增益(地图.标记2, "活动", 120)——活动窗口是循环的存活条件
      const markers2 = this.safeParseArray(map.markers2);
      this.combatState.gainBuff(markers2, '活动', 120, false, Date.now());
      map.markers2 = JSON.stringify(markers2);
      await this.mapService.updateDynamicFields(map.id, { markers2: map.markers2 });

      this.scheduleRound(map.id, delaySec);
    } catch (e: any) {
      this.logger.warn(`拉起地图怪物攻击循环失败 userId=${userId}: ${e?.message ?? e}`);
    }
  }

  /**
   * 执行一回合（延时到期）。
   * 原版延时回合以 QQ="0"（无玩家名义）投递；本框架的回合子系统（召唤物协同、
   * 灼烧结算归属、任务推进）需要名义玩家，取同图在线玩家承载；同图无人在线时
   * 以 0 进入（怪物仍会攻击地图召唤物，无任何防御方时走 "#没有目标" 终止分支）。
   */
  private async runRound(mapId: number): Promise<void> {
    try {
      const map = await this.mapService.getMapById(mapId);
      if (!map) return;

      const online = this.statsService.getOnlineUserIds();
      const rows = await this.prisma.player.findMany({ where: { mapId }, select: { userId: true } });
      const candidates = rows
        .map((row: any) => Number(row.userId))
        .filter((uid: number) => online.has(uid));
      const nominal = candidates.length > 0 ? candidates[0] : 0;

      const mapArg = String(map.mapIndex ?? map.id);
      const text = await this.combatSystem.adminAttackMap(nominal, mapArg);
      if (text && text.trim()) {
        // 原版回合文本发送到群（处理群 → 发送群消息）；本框架走世界频道系统消息
        await this.chatService.broadcastSystem('世界频道', text).catch(() => undefined);
      }
    } catch (e: any) {
      this.logger.warn(`地图怪物攻击回合执行失败 mapId=${mapId}: ${e?.message ?? e}`);
    }
  }

  private safeParseArray(value: any): any[] {
    if (Array.isArray(value)) return value;
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : (value ?? []);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** 进程退出时丢弃待执行回合（原版内存延时同样不落盘） */
  onApplicationShutdown(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
