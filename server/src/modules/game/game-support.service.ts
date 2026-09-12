/**
 * 共享支撑层服务（game 模块化重构 P1-3 抽出）
 *
 * 职责：被多个指令域共用、无业务语义的底层辅助——数值/时长/序号格式化、
 *       Json 与标记（markers/markers2）读写、随机数、地图/玩家只读快照、
 *       跨域任务推进适配、玩家写模型收口薄封装（mutatePlayer）。
 * 依赖方向：只依赖基础设施与纵向系统服务（Prisma / Player / PlayerMutate /
 *       Map / StaticData / Task / CombatState）；**禁止注入任何指令域子服务
 *       （game/commands/*.service）**——支撑层零回边（门禁 G7 断言出度边=0）。
 * 单一真相源：数值展示统一 game-text.util.formatDisplayNumber（round2Text /
 *       formatGatherNumber 均为薄委托）；时长文本统一 formatMsDurationText /
 *       formatSecondsDurationText（millisecondsToText / secondsToTimeText /
 *       formatUptime 均为薄委托）。
 * 对口原版：散落于 _主程序.ecode 的 通用 取随机数/数字到时间/显示数字 等子程序。
 *
 * 方法可见性：全部 public——它们经 GameService 门面被各指令域与测试桩调用
 *（重构方案 §10.2：跨子服务调用的方法一律放弃 private 语义）。
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { asJsonValue } from '../../common/utils/json-value.util';
import {
  formatDisplayNumber,
  formatMsDurationText,
  formatSecondsDurationText,
} from '../../common/utils/game-text.util';
import { PlayerService } from './player.service';
import { PlayerMutateService } from './player-mutate.service';
import { MapService } from './map.service';
import { StaticDataService } from './static-data.service';
import { TaskService } from './task.service';
import { CombatStateService } from './combat-state.service';

@Injectable()
export class GameSupportService {
  private readonly logger = new Logger(GameSupportService.name);

  constructor(
    private readonly playerService: PlayerService,
    private readonly prisma: PrismaService,
    private readonly mapService: MapService,
    private readonly staticData: StaticDataService,
    private readonly taskService: TaskService,
    private readonly combatState: CombatStateService,
    // PlayerMutateService 可选：与原 GameService.mutatePlayer 相同的降级回退
    //（测试桩未注入时走 enqueueUserWrite 等价路径，行为不变）。
    @Optional() private readonly playerMutate?: PlayerMutateService,
  ) {}

  /**
   * 玩家状态变更的收口入口（对 PlayerMutateService.mutate 的薄封装）。
   *
   * 生产环境由 Nest 注入真实的 PlayerMutateService（Actor 式：锁内单一快照、
   * 统一落库、货币审计、嵌套复用）。测试桩若不提供该依赖，则退化为等价的
   * 「enqueueUserWrite + getPlayerData + fn + savePlayer」路径，保持旧行为不变，
   * 避免逐个测试桩补依赖。
   */
  mutatePlayer<T>(userId: number, fn: (ctx: any) => Promise<T> | T): Promise<T> {
    if (this.playerMutate) return this.playerMutate.mutate(userId, fn);
    return this.playerService.enqueueUserWrite(userId, async () => {
      const ctx = await this.playerService.getPlayerData(userId);
      const result = await fn(ctx);
      await this.playerService.savePlayer(ctx.player);
      return result;
    });
  }

  /** 任务推进的服务层适配点，避免任务服务不可用时影响核心玩法动作。 */
  async advanceTask(userId: number, actionName: string, count = 1): Promise<void> {
    const advance = (this.taskService as any)?.advance;
    if (typeof advance !== 'function') return;
    if (count === 1) {
      await advance.call(this.taskService, userId, actionName);
    } else {
      await advance.call(this.taskService, userId, actionName, count);
    }
  }

  incrementMarker(markers: Record<string, any>, key: string, amount: number): void {
    markers[key] = Number(markers[key] || 0) + amount;
  }

  normalizeMarkers2(markers2: any[]): void {
    const normalized = markers2.map((entry: any) => this.combatState.normalizeBuffItem(entry));
    markers2.splice(0, markers2.length, ...normalized);
  }

  /**
   * 判断玩家是否装备指定名称的装备（对应原版 装备要求）
   * @param player 玩家对象
   * @param name 装备名称
   */
  hasEquip(player: any, name: string): boolean {
    const equips: any[] = asJsonValue<any[]>(player.equipment, []);
    return equips.some((e: any) => e && (e.name === name || e.名称 === name));
  }

  /**
   * 写入/覆盖 markers2 增益标记（对应原版 获得增益/添加标记）
   * @param markers2 增益数组（就地修改）
   * @param name 标记名
   * @param expireAt 到期时间戳（秒）
   * @param strength 强度（可选）
   */
  setMarkers2(markers2: any[], name: string, expireAt: number, strength?: number): void {
    const idx = markers2.findIndex((m: any) => m && m.name === name);
    if (idx >= 0) {
      markers2[idx].expireAt = expireAt;
      if (strength !== undefined) markers2[idx].strength = strength;
    } else {
      markers2.push(strength !== undefined ? { name, expireAt, strength } : { name, expireAt });
    }
  }

  itemName(item: any): string {
    return String(item?.name ?? item?.名称 ?? '');
  }

  itemType(item: any): string {
    return String(item?.type ?? item?.类型 ?? '');
  }

  /**
   * 获取玩家名称的辅助方法
   */
  async getPlayerName(userId: number): Promise<string> {
    try {
      // 走 getPlayerData：Actor 邮箱内读内存活态，改名后无需等待落库即可生效
      const pd = await this.playerService.getPlayerData(userId);
      return pd.player.name || '冒险者';
    } catch {
      return '冒险者';
    }
  }

  /**
   * 获取玩家当前所在的地图对象
   * @param userId 用户ID
   * @returns 地图对象
   */
  async getCurrentMap(userId: number): Promise<any> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) throw new Error('玩家数据不存在');
    return this.mapService.getMapById(player.mapId);
  }

  round2Text(value: number): string {
    // 展示口径统一走 game-text.util.formatDisplayNumber（两位小数、去尾零、非有限值回落 '0'）
    return formatDisplayNumber(value);
  }

  /** 毫秒 → 可读时间文本（对应原版 数字到时间 的秒/分秒简化）。 */
  millisecondsToText(ms: number): string {
    return formatMsDurationText(ms);
  }

  /**
   * 格式化运行时长（秒 → 可读文本）
   */
  formatUptime(seconds: number): string {
    return formatSecondsDurationText(seconds, 'fullUnits');
  }

  /** 原版 取随机数(最小,最大)（含两端）。 */
  randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  parseJsonArray(value: any): any[] {
    if (Array.isArray(value)) return value;
    return asJsonValue<any[]>(value, []);
  }

  firstPositiveNumber(...values: any[]): number {
    for (const value of values) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
  }

  /** 秒数 → 时间文本（对应原版 数字到时间；在线时间可能跨天，补 天/小时 段） */
  secondsToTimeText(seconds: number): string {
    return formatSecondsDurationText(seconds);
  }

  formatGatherNumber(value: number): string {
    // 展示口径统一（两位小数、去尾零、非有限值回落 '0'）
    return formatDisplayNumber(value);
  }

  formatReverseNumber(value: number): string {
    return String(Math.round(value));
  }

  /**
   * 解析资源的采集指令：条目自带 gatherCmd 优先，缺失时回退到全局资源列表的同名定义。
   *
   * 事故背景（2026-09-06）：定时任务掉落货舱/能量元素时只写入了 {name,type,amount}
   * 字面量，缺 gatherCmd；观察附近照样给它编了号，但 cmd 为空 → 编号不注册 →
   * 玩家发送编号后完全没有反应（连"未知指令"提示都没有）。
   * 这里做兜底：只要资源名能在全局资源表里找到，编号就一定点得动。
   */
  resolveGatherCmd(resource: any): string {
    const own = String(resource?.gatherCmd ?? resource?.采集指令 ?? '').trim();
    if (own) return own;
    const name = String(resource?.name ?? resource?.名称 ?? '').trim();
    if (!name) return '';
    const definition = this.staticData.getAllResources()
      .find((r: any) => String(r?.name ?? '').trim() === name);
    return String(definition?.gatherCmd ?? definition?.采集指令 ?? '').trim();
  }

  /**
   * 修改当前地图上归属玩家、且允许控制的召唤物模式。
   * 原版“全部”命令只处理归属当前玩家的非幼崽/非阵地召唤物，不能把
   * 召唤物自身 QQ 当成归属，否则地图上的公共 NPC 可能被误改。
   */
  async updateOwnedSummonMode(
    userId: number,
    mode: 'follow' | 'idle' | 'active' | 'passive',
  ): Promise<{ count: number; map?: any }> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return { count: 0 };

    const rawSummons = typeof map.summons === 'string'
      ? asJsonValue<any[]>(map.summons, [])
      : map.summons;
    const summons = Array.isArray(rawSummons) ? rawSummons : [];
    const ownerIds = new Set([
      userId,
      player.id,
      player.userId,
      player.qqNumber,
      player.externalId,
      player.masterQQ,
    ].map((value) => String(value ?? '')).filter(Boolean));

    const controllable = summons.filter((summon: any) => {
      const owner = String(
        summon?.ownerQQ ?? summon?.归属 ?? summon?.owner ?? summon?.ownerId ?? '',
      );
      if (!ownerIds.has(owner)) return false;

      const rawMarkers = typeof summon?.markers === 'string'
        ? asJsonValue<any>(summon.markers, {})
        : (summon?.markers ?? summon?.标记 ?? {});
      const markers = rawMarkers && typeof rawMarkers === 'object' ? rawMarkers : {};
      return Number(markers['幼崽'] ?? markers['阵地'] ?? 0) === 0;
    });

    for (const summon of controllable) {
      const rawMarkers = typeof summon?.markers === 'string'
        ? asJsonValue<any>(summon.markers, {})
        : (summon?.markers ?? summon?.标记 ?? {});
      const markers = rawMarkers && typeof rawMarkers === 'object' ? { ...rawMarkers } : {};
      if (mode === 'follow') {
        summon.follow = true;
        summon.mode = 'follow';
        markers['跟随'] = 0;
      } else if (mode === 'idle') {
        summon.follow = false;
        summon.mode = 'idle';
        markers['跟随'] = 1;
      } else if (mode === 'active') {
        summon.mode = 'active';
        summon.active = true;
        markers['主动'] = 0;
      } else {
        summon.mode = 'passive';
        summon.active = false;
        markers['主动'] = 1;
      }
      summon.markers = markers; // Json 列直接写对象
      if (summon.标记 !== undefined) summon.标记 = summon.markers;
    }

    if (controllable.length > 0) {
      await this.mapService.updateDynamicFields(map.id, { summons });
    }
    return { count: controllable.length, map };
  }

  /** 当前是否可训练：当前地图存在「训练器」建筑，或背包持有「训练器」 */
  async hasTrainerAccess(player: any): Promise<boolean> {
    try {
      const map = await this.mapService.getMapById(player.mapId);
      const buildings = asJsonValue<any[]>(map?.buildings, []);
      if (buildings.some((b: any) => String(b?.name ?? '') === '训练器')) return true;
      const backpack = this.playerService.getBackpackItems(player);
      if (backpack.some((item: any) => String(item?.name ?? '') === '训练器')) return true;
    } catch {
      /* 读取失败按不可训练处理 */
    }
    return false;
  }
}
