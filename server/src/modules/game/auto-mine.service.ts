import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerData, PlayerService } from './player.service';
import { MapService } from './map.service';
import { StaticDataService } from './static-data.service';
import { CombatSystemService } from './combat-system.service';
import { ItemSystemService } from './item-system.service';
import { TaskService } from './task.service';

interface MiningContext {
  playerData: PlayerData;
  player: any;
  map: any;
  vehicle?: any;
  collector: number;
  alphaCore: boolean;
  followerFactor: number;
}

interface MiningSettlement {
  elapsedSeconds: number;
  text: string;
  changed: boolean;
}

/**
 * 自动开采状态与结算。
 *
 * 原版使用玩家永久标记“自动开采/自动开采2”保存开始时间，停止时按
 * 地图固定资源的每小时公式结算。服务端额外提供分钟级增量结算，保留
 * 标记即可跨进程/重启继续开采，不会把离线期间的收益丢掉。
 */
@Injectable()
export class AutoMineService {
  private readonly logger = new Logger(AutoMineService.name);
  private readonly userLocks = new Map<number, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly mapService: MapService,
    private readonly staticData: StaticDataService,
    private readonly combatSystem: CombatSystemService,
    private readonly itemSystem: ItemSystemService,
    private readonly taskService: TaskService,
  ) {}

  private async withUserLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.userLocks.get(userId) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    const tail = current.then(() => undefined, () => undefined);
    this.userLocks.set(userId, tail);
    try {
      return await current;
    } finally {
      if (this.userLocks.get(userId) === tail) this.userLocks.delete(userId);
    }
  }

  /** 开始自动开采，写入原版使用的两个标记之一。 */
  async start(userId: number, nowMs = Date.now()): Promise<string> {
    return this.withUserLock(userId, async () => {
      const context = await this.getContext(userId);
      const validation = this.validate(context, true);
      if (validation) return validation;

      const { player, map, alphaCore, followerFactor } = context;
      const markers = this.playerService.safeJsonParse<Record<string, any>>(player.markers, {});
      const mode = alphaCore ? '自动开采2' : '自动开采';
      const otherMode = alphaCore ? '自动开采' : '自动开采2';
      const nowSeconds = this.toSeconds(nowMs);

      // 同一玩家只保留当前载具对应的开采模式，避免换车后两条时间线叠加。
      delete markers[otherMode];
      markers[mode] = nowSeconds;
      player.markers = JSON.stringify(markers);
      await this.playerService.savePlayer(player);

      const bonus = this.getGatherBonus(context);
      const estimates = this.buildDrops(map, 3600, bonus, followerFactor);
      const estimateText = this.formatDrops(estimates) || '暂无可产出资源';
      const vehicleName = String(player.name || '你');
      const prefix = alphaCore && context.vehicle
        ? `${vehicleName}的${context.vehicle.name ?? context.vehicle.名称 ?? '载具'}`
        : vehicleName;
      return `${prefix}开始自动开采，预计每小时产出：${estimateText}`;
    });
  }

  /** 停止当前载具对应的自动开采并结算全部未结算时间。 */
  async stop(userId: number, nowMs = Date.now()): Promise<string> {
    return this.withUserLock(userId, async () => {
      const context = await this.getContext(userId);
      const validation = this.validate(context, false);
      if (validation) return validation;

      const { player, alphaCore } = context;
      const markers = this.playerService.safeJsonParse<Record<string, any>>(player.markers, {});
      const mode = alphaCore ? '自动开采2' : '自动开采';
      const otherMode = alphaCore ? '自动开采' : '自动开采2';
      const startedAt = this.readTimestamp(markers[mode]);
      const otherStartedAt = this.readTimestamp(markers[otherMode]);

      if (!startedAt) {
        if (otherStartedAt) {
          return alphaCore
            ? `${player.name || '冒险者'}你只能驾驶没有硅基核心阿尔法的载具来执行这个操作`
            : `${player.name || '冒险者'}你只能驾驶有硅基核心阿尔法的载具来执行这个操作`;
        }
        return `${player.name || '冒险者'}没有在开采`;
      }

      const settlement = await this.settle(userId, context, mode, startedAt, nowMs, true);
      const vehicleName = alphaCore && context.vehicle
        ? `${player.name || '冒险者'}的${context.vehicle.name ?? context.vehicle.名称 ?? '载具'}`
        : (player.name || '冒险者');
      return `${vehicleName}自动开采了${this.formatDuration(settlement.elapsedSeconds)}，炸出了${settlement.text || '暂无资源'}`;
    });
  }

  /**
   * 后台增量结算。时间标记不会清除，只有用户执行“开采停止”才会结束状态。
   * 返回本轮实际结算的玩家数量，供定时任务记录日志。
   */
  async checkpointAll(nowMs = Date.now()): Promise<number> {
    const players = await this.prisma.player.findMany({
      where: { userId: { gt: 0 } },
      select: { userId: true },
    });
    let settled = 0;
    for (const row of players) {
      try {
        if (await this.checkpoint(row.userId, nowMs)) settled++;
      } catch (error: any) {
        this.logger.warn(`玩家 ${row.userId} 自动开采结算失败: ${error?.message || error}`);
      }
    }
    return settled;
  }

  private async checkpoint(userId: number, nowMs: number): Promise<boolean> {
    return this.withUserLock(userId, async () => {
      const context = await this.getContext(userId);
      if (this.validate(context, false) || context.collector === 0) return false;

      const { player, alphaCore } = context;
      const markers = this.playerService.safeJsonParse<Record<string, any>>(player.markers, {});
      const mode = alphaCore ? '自动开采2' : '自动开采';
      const startedAt = this.readTimestamp(markers[mode]);
      if (!startedAt || this.toSeconds(nowMs) - startedAt < 60) return false;

      await this.settle(userId, context, mode, startedAt, nowMs, false);
      return true;
    });
  }

  private async getContext(userId: number): Promise<MiningContext> {
    const playerData = await this.playerService.getPlayerData(userId);
    const player = playerData.player;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) {
      return {
        playerData,
        player,
        map: null,
        collector: 0,
        alphaCore: false,
        followerFactor: 1,
      };
    }

    const vehicles = this.parseArray(map.vehicles);
    const vehicleKey = String(player.vehicle ?? '');
    const vehicle = vehicleKey
      ? vehicles.find((candidate: any) => [candidate?.id, candidate?.编号, candidate?.vehicleId]
        .some((value) => String(value ?? '') === vehicleKey))
      : undefined;
    const partNames = this.getVehiclePartNames(vehicle);
    const collector = partNames.includes('引力调频器')
      ? 3
      : partNames.includes('行星解裂器')
        ? 2
        : partNames.includes('激光采集器')
          ? 1
          : 0;
    const ownerIds = new Set([
      userId,
      player.userId,
      player.id,
      player.qqNumber,
      player.masterQQ,
    ].filter((value) => value !== undefined && value !== null && String(value) !== '')
      .map((value) => String(value)));
    const summons = this.parseArray(map.summons);
    const followerCount = summons.filter((summon: any) => ownerIds.has(String(
      summon?.ownerQQ ?? summon?.归属 ?? summon?.owner ?? '',
    )) && Number(summon?.hp ?? summon?.当前生命 ?? 1) > 0).length;

    return {
      playerData,
      player,
      map,
      vehicle,
      collector,
      alphaCore: partNames.includes('硅基核心阿尔法'),
      followerFactor: Math.min(2, followerCount) + 1,
    };
  }

  private validate(context: MiningContext, starting: boolean): string {
    const { player, map, vehicle, collector } = context;
    if (!map) return `${player?.name || '冒险者'}不在任何地图上`;
    if (this.isInstanceMap(map)) return `${player?.name || '冒险者'}不能在副本里干这个`;
    if (!vehicle) return `${player?.name || '冒险者'}需要驾驶载具`;
    const currentHp = Number(vehicle.currentHp ?? vehicle.当前生命 ?? 0);
    if (currentHp <= 0) return `${player?.name || '冒险者'}载具需要“维修”`;
    if (starting && collector === 0) {
      return `${player?.name || '冒险者'}${vehicle.name ?? vehicle.名称 ?? '载具'}需要安装激光采集器、行星解裂器或者引力调频器`;
    }
    return '';
  }

  private async settle(
    userId: number,
    context: MiningContext,
    mode: string,
    startedAt: number,
    nowMs: number,
    clearMarker: boolean,
  ): Promise<MiningSettlement> {
    const { player, playerData, map, followerFactor } = context;
    const nowSeconds = this.toSeconds(nowMs);
    const elapsedSeconds = Math.max(0, Math.floor(nowSeconds - startedAt));
    const bonus = this.getGatherBonus(context);
    const drops = this.buildDrops(map, elapsedSeconds, bonus, followerFactor);
    const taskProgress: Array<{ actionName: string; count: number }> = [];
    let dropText = '';

    if (drops.length > 0) {
      dropText = await this.itemSystem.distributeLoot(playerData, drops, {
        onTaskProgress: (actionName, count) => taskProgress.push({ actionName, count }),
      });
    }

    const markers = this.playerService.safeJsonParse<Record<string, any>>(player.markers, {});
    if (clearMarker) {
      delete markers[mode];
    } else {
      markers[mode] = nowSeconds;
    }
    // 原版：采集熟练度 += 开采秒数 / 6000 * 2 * (附近使魔+1)。
    if (elapsedSeconds > 0) {
      markers['采集熟练度'] = Number(markers['采集熟练度'] || 0)
        + elapsedSeconds / 6000 * 2 * followerFactor;
    }
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    for (const progress of taskProgress) {
      await this.taskService.advance(userId, progress.actionName, progress.count);
    }

    return {
      elapsedSeconds,
      text: dropText,
      changed: elapsedSeconds > 0 || clearMarker,
    };
  }

  private getGatherBonus(context: MiningContext): number {
    try {
      const bonus = this.combatSystem.buildAttackerBonus(
        context.player,
        context.playerData,
        context.map,
      );
      return Number(bonus?.采集 || 0);
    } catch {
      const rawBonus = this.playerService.safeJsonParse<any>(context.player?.bonus, {});
      return Number(rawBonus?.采集 || 0);
    }
  }

  private buildDrops(
    map: any,
    elapsedSeconds: number,
    gatherBonus: number,
    followerFactor: number,
  ): any[] {
    if (elapsedSeconds <= 0) return [];
    const resources = this.parseArray(map?.resources);
    const multiplier = 1 + gatherBonus / 100;
    const drops: any[] = [];
    for (const resource of resources) {
      const marker = String(resource?.marker ?? resource?.标记 ?? '').trim();
      if (marker) continue;
      for (const output of this.normalizeOutputs(resource?.outputs ?? resource?.产出)) {
        if (!output.name || output.name === '电力') continue;
        const quantity = output.count * 160 * multiplier * followerFactor
          * output.chance / 100 * elapsedSeconds / 3600;
        if (!Number.isFinite(quantity) || quantity === 0) continue;
        drops.push({
          name: output.name,
          type: this.staticData.getEquipmentByName(output.name) ? '装备' : '资源',
          quantity,
        });
      }
    }
    return drops;
  }

  private normalizeOutputs(value: any): Array<{ name: string; count: number; chance: number }> {
    const raw = this.parseArray(value);
    return raw.map((entry: any) => {
      const sourceName = String(entry?.name ?? entry?.名称 ?? '').trim();
      const rawCount = Number(entry?.count ?? entry?.quantity ?? entry?.数量 ?? 0);
      const hasChance = entry?.chance !== undefined || entry?.几率 !== undefined;
      const qualityMatch = sourceName.match(/^(.*?)([edcbasx])$/i);
      const qualityName = qualityMatch ? qualityMatch[1] : sourceName;
      const compact = qualityName.match(/^(.*?)(-?\d+(?:\.\d+)?)$/);
      if (!hasChance && compact) {
        return {
          name: compact[1].trim(),
          count: Number(compact[2]),
          chance: Number.isFinite(rawCount) ? rawCount : 100,
        };
      }
      return {
        name: qualityName,
        count: Number.isFinite(rawCount) ? rawCount : 0,
        chance: hasChance ? Number(entry?.chance ?? entry?.几率 ?? 0) : 100,
      };
    }).filter((entry) => entry.name && Number.isFinite(entry.count) && Number.isFinite(entry.chance));
  }

  private formatDrops(drops: any[]): string {
    const totals = new Map<string, number>();
    for (const drop of drops) {
      totals.set(drop.name, (totals.get(drop.name) || 0) + Number(drop.quantity || 0));
    }
    return [...totals.entries()]
      .filter(([, count]) => count !== 0)
      .map(([name, count]) => `${name}×${this.formatNumber(count)}`)
      .join('、');
  }

  private formatNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  }

  private formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}分钟`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest > 0 ? `${hours}小时${rest}分钟` : `${hours}小时`;
  }

  private readTimestamp(value: any): number {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return number > 1e11 ? number / 1000 : number;
  }

  private toSeconds(value: number): number {
    // 本服务的 nowMs 参数统一为毫秒；只有从玩家标记读取的旧值才由
    // readTimestamp 兼容秒级时间戳。
    return Math.floor(value / 1000);
  }

  private isInstanceMap(map: any): boolean {
    return !!map?.isInstance || !!map?.关卡 || Number(map?.关卡 || 0) !== 0;
  }

  private parseArray(value: any): any[] {
    if (Array.isArray(value)) return value;
    return this.playerService.safeJsonParse<any[]>(value, []);
  }

  private getVehiclePartNames(vehicle: any): string[] {
    if (!vehicle) return [];
    const names: string[] = [];
    const visit = (part: any): void => {
      if (!part) return;
      const name = String(part?.name ?? part?.名称 ?? '').trim();
      if (name) names.push(name);
      for (const inner of this.parseArray(part?.builtinParts ?? part?.内置零件 ?? part?.builtin ?? part?.内置)) {
        visit(inner);
      }
    };
    for (const part of this.parseArray(vehicle.parts ?? vehicle.零件)) visit(part);
    for (const part of this.parseArray(vehicle.builtinParts ?? vehicle.内置零件)) visit(part);
    return names;
  }
}
