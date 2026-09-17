/**
 * 每日抽奖服务
 *
 * 规则（当前实现，后续次数/奖池可扩展）：
 * - 奖池 = items.json 全部资源/物品 + equipments.json 全部武器（排除模板类）；
 * - 每人每天 0 点重置，当日限 1 次；
 * - 消耗背包中的「凭证」x1（物品名与数量均可在系统配置中心调整）；
 * - 中奖物品自动入包：资源走按名合并，武器走「生成装备」卷词条。
 *
 * 玩家写入一律走 PlayerMutateService.mutate，避免旧快照整包覆盖。
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { formatDisplayNumber, roundItemQuantity } from '../../common/utils/game-text.util';
import { asJsonValue } from '../../common/utils/json-value.util';
import { SystemConfigService } from '../system-config/system-config.service';
import { PlayerMutateService } from './player-mutate.service';
import { StaticDataService } from './static-data.service';
import { ItemSystemService } from './item-system.service';
import { lookupFromStaticData, mergeBackpackItem } from './item-normalize.util';
import { ITEM_SYSTEM_SERVICE } from './service-tokens';
import {
  DEFAULT_LOTTERY_POOL_EXCLUDE,
  DEFAULT_LOTTERY_TICKET_COST,
  DEFAULT_LOTTERY_TICKET_ITEM,
  LOTTERY_DAILY_LIMIT_KEY,
  LOTTERY_ENABLED_KEY,
  LOTTERY_POOL_EXCLUDE_KEY,
  LOTTERY_TICKET_COST_KEY,
  LOTTERY_TICKET_ITEM_KEY,
  LotteryDrawResult,
  LotteryPoolEntry,
} from './lottery-config.defaults';

/** markers 里记录每日抽奖状态的 key */
const MARKER_KEY = 'daily_lottery';

@Injectable()
export class LotteryService {
  private readonly logger = new Logger(LotteryService.name);

  constructor(
    private readonly systemConfig: SystemConfigService,
    private readonly mutate: PlayerMutateService,
    private readonly staticData: StaticDataService,
    @Optional() @Inject(ITEM_SYSTEM_SERVICE)
    private readonly itemSystem?: ItemSystemService,
  ) {}

  /** 本地日期 YYYY-MM-DD（与签到 / 每日登录同一口径，0 点自然重置） */
  localTodayString(now = new Date()): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  /** 读取抽奖配置（后台可在线改，非法值回落默认） */
  async getConfig(): Promise<{
    enabled: boolean;
    dailyLimit: number;
    ticketItem: string;
    ticketCost: number;
    poolExclude: string[];
  }> {
    const [enabledRaw, dailyLimit, ticketItem, ticketCost, poolExcludeRaw] = await Promise.all([
      this.systemConfig.get<boolean>(LOTTERY_ENABLED_KEY, true),
      this.systemConfig.get<number>(LOTTERY_DAILY_LIMIT_KEY, 1),
      this.systemConfig.get<string>(LOTTERY_TICKET_ITEM_KEY, DEFAULT_LOTTERY_TICKET_ITEM),
      this.systemConfig.get<number>(LOTTERY_TICKET_COST_KEY, DEFAULT_LOTTERY_TICKET_COST),
      this.systemConfig.get<string>(
        LOTTERY_POOL_EXCLUDE_KEY,
        JSON.stringify(DEFAULT_LOTTERY_POOL_EXCLUDE),
      ),
    ]);

    let poolExclude: string[] = DEFAULT_LOTTERY_POOL_EXCLUDE;
    try {
      const parsed =
        typeof poolExcludeRaw === 'string' ? JSON.parse(poolExcludeRaw) : poolExcludeRaw;
      if (Array.isArray(parsed)) {
        poolExclude = parsed.map((x) => String(x ?? '').trim()).filter(Boolean);
      }
    } catch {
      /* 配置写坏时回落默认名单 */
    }

    return {
      enabled: enabledRaw !== false && String(enabledRaw) !== 'false',
      dailyLimit: Math.max(0, Math.floor(Number(dailyLimit) || 0)),
      ticketItem:
        String(ticketItem || DEFAULT_LOTTERY_TICKET_ITEM).trim() ||
        DEFAULT_LOTTERY_TICKET_ITEM,
      ticketCost: Math.max(0, Math.floor(Number(ticketCost) || 0)),
      poolExclude,
    };
  }

  /**
   * 构建奖池：资源/物品（items.json）+ 武器（equipments.json 中 isWeapon）。
   * 数量在展示层用 rollCount 现场摇；这里只给名字与种类。
   */
  buildPool(exclude: string[]): LotteryPoolEntry[] {
    const excludeSet = new Set(exclude);
    const pool: LotteryPoolEntry[] = [];
    const seen = new Set<string>();

    for (const item of this.staticData.getAllItems() || []) {
      const name = String(item?.name ?? '').trim();
      if (!name || excludeSet.has(name) || seen.has(name)) continue;
      seen.add(name);
      pool.push({ name, quantity: 1, kind: 'resource' });
    }

    for (const eq of this.staticData.getAllWeapons() || []) {
      const name = String(eq?.name ?? '').trim();
      if (!name || excludeSet.has(name) || seen.has(name)) continue;
      // 模板 / 空手类占位不进池
      if (name === '空手' || name.includes('模板')) continue;
      seen.add(name);
      pool.push({ name, quantity: 1, kind: 'weapon' });
    }

    return pool;
  }

  /** 中奖数量恒为 1（只发 1 个物品） */
  rollCount(): number {
    return 1;
  }

  /** 背包中某物品当前数量（只读规范键 quantity） */
  private countInBackpack(backpack: any[], name: string): number {
    const row = backpack.find((it: any) => String(it?.name ?? '') === name);
    if (!row) return 0;
    return Number(row.quantity ?? 0) || 0;
  }

  private safeBackpack(raw: any): any[] {
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return Array.isArray(raw) ? raw : [];
  }

  /**
   * 查询抽奖状态（前端面板：剩余次数 / 凭证数量 / 奖池预览）。
   * 经 mutate 只读：字段签名不变则不落库。
   */
  async getStatus(userId: number) {
    const cfg = await this.getConfig();
    const today = this.localTodayString();

    const snap = await this.mutate.mutate(userId, (ctx) => {
      const markers = asJsonValue<Record<string, any>>(ctx.player?.markers, {});
      const state = markers[MARKER_KEY] || { lastDate: '', used: 0 };
      const backpack = this.safeBackpack(ctx.player?.backpack);
      return {
        lastDate: String(state.lastDate || ''),
        usedToday:
          String(state.lastDate || '') === today ? Number(state.used || 0) : 0,
        ticketCount: this.countInBackpack(backpack, cfg.ticketItem),
      };
    });

    const pool = this.buildPool(cfg.poolExclude);
    const remaining = Math.max(0, cfg.dailyLimit - snap.usedToday);
    const canDraw =
      cfg.enabled &&
      cfg.dailyLimit > 0 &&
      remaining > 0 &&
      snap.ticketCount >= cfg.ticketCost;

    return {
      enabled: cfg.enabled,
      dailyLimit: cfg.dailyLimit,
      usedToday: snap.usedToday,
      remaining,
      ticketItem: cfg.ticketItem,
      ticketCost: cfg.ticketCost,
      ticketCount: snap.ticketCount,
      poolSize: pool.length,
      canDraw,
      today,
      poolPreview: pool.slice(0, 60).map((p) => ({
        name: p.name,
        quantity: 1,
        kind: p.kind,
      })),
    };
  }

  /**
   * 执行一次抽奖：校验 → 扣凭证 → 摇奖 → 入包 → 记 marker。
   * 全程一次 mutate，单一快照统一落库。
   */
  async drawOnce(userId: number): Promise<LotteryDrawResult> {
    const cfg = await this.getConfig();
    const today = this.localTodayString();

    if (!cfg.enabled) {
      return { ok: false, message: '抽奖活动暂未开放' };
    }
    if (cfg.dailyLimit <= 0) {
      return { ok: false, message: '当前抽奖次数为 0，请等待管理员开放' };
    }

    const pool = this.buildPool(cfg.poolExclude);
    if (pool.length === 0) {
      return { ok: false, message: '奖池为空，请联系管理员配置' };
    }

    const picked = pool[Math.floor(Math.random() * pool.length)];
    // 固定只发 1 个（数量规范键 quantity）
    const quantity = 1;

    return this.mutate.mutate(userId, async (ctx): Promise<LotteryDrawResult> => {
      const markers = asJsonValue<Record<string, any>>(ctx.player?.markers, {});
      const state = markers[MARKER_KEY] || { lastDate: '', used: 0 };
      const lastDate = String(state.lastDate || '');
      const usedToday = lastDate === today ? Number(state.used || 0) : 0;

      if (usedToday >= cfg.dailyLimit) {
        return {
          ok: false,
          dailyLimitHit: true,
          message: `今天已经抽过奖了（每日 ${cfg.dailyLimit} 次），明天 0 点重置~`,
        };
      }

      const backpack = this.safeBackpack(ctx.player?.backpack);
      const have = this.countInBackpack(backpack, cfg.ticketItem);
      if (cfg.ticketCost > 0 && have < cfg.ticketCost) {
        return {
          ok: false,
          noTicket: true,
          message: `抽奖需要「${cfg.ticketItem}」x${cfg.ticketCost}，当前只有 ${formatDisplayNumber(have)} 个`,
        };
      }

      // 扣凭证
      if (cfg.ticketCost > 0) {
        const next = roundItemQuantity(have - cfg.ticketCost);
        const row = backpack.find((it: any) => String(it?.name ?? '') === cfg.ticketItem);
        if (row) {
          if (next <= 0) {
            const idx = backpack.indexOf(row);
            if (idx >= 0) backpack.splice(idx, 1);
          } else {
            // 数量只写规范键 quantity（count 镜像已废弃）
            row.quantity = next;
          }
        }
      }

      // 发奖：武器走生成装备；资源走合并出口
      if (picked.kind === 'weapon') {
        let gear: any = {
          name: picked.name,
          type: '装备',
          quantity: 1,
          durability: 0,
          data: 'e',
        };
        if (this.itemSystem?.generateRewardEquipment) {
          try {
            gear = await this.itemSystem.generateRewardEquipment(picked.name);
          } catch (e: any) {
            this.logger.warn(
              `抽奖生成装备「${picked.name}」失败，退化为静态条目: ${e?.message ?? e}`,
            );
          }
        }
        mergeBackpackItem(
          backpack,
          {
            ...gear,
            name: gear?.name || picked.name,
            type: '装备',
            quantity: 1,
            data: String(gear?.data || 'e'),
          },
          lookupFromStaticData(this.staticData),
        );
      } else {
        mergeBackpackItem(
          backpack,
          { name: picked.name, quantity: 1 },
          lookupFromStaticData(this.staticData),
        );
      }

      ctx.player.backpack = backpack;
      markers[MARKER_KEY] = {
        lastDate: today,
        used: usedToday + 1,
      };
      ctx.player.markers = markers;

      this.logger.log(
        `玩家 ${userId} 抽中 ${picked.name}×1（消耗 ${cfg.ticketItem}x${cfg.ticketCost}，今日第 ${usedToday + 1}/${cfg.dailyLimit} 次）`,
      );

      return {
        ok: true,
        reward: {
          name: picked.name,
          quantity,
          type: picked.kind,
        },
        message: `🎉 抽奖获得：${picked.name}×1`,
      };
    });
  }

  /** 指令文本形态（公屏 / QQ 机器人） */
  async drawCommand(userId: number): Promise<string> {
    const result = await this.drawOnce(userId);
    return result.message;
  }

  /** 指令查看奖池 / 今日剩余 */
  async statusCommand(userId: number): Promise<string> {
    const status = await this.getStatus(userId);
    const lines = [
      '🎰 每日抽奖',
      '━━━━━━━━━━━━━━━',
      `📅 今日剩余次数: ${status.remaining}/${status.dailyLimit}`,
      `🎫 所需凭证: ${status.ticketItem}×${status.ticketCost}（持有 ${status.ticketCount}）`,
      `🎁 奖池规模: ${status.poolSize} 件（资源 + 武器）`,
      '━━━━━━━━━━━━━━━',
      status.canDraw
        ? '输入「抽奖」即可参与，中奖自动入包'
        : status.remaining <= 0
          ? '今日次数已用完，明天 0 点重置'
          : `凭证不足，需要 ${status.ticketItem}×${status.ticketCost}`,
    ];
    return lines.join('\n');
  }
}
