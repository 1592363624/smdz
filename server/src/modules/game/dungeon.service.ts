/**
 * 副本生命周期服务。
 *
 * 原版不是运行时随机生成一组“副本怪物”，而是按地图的复活点把一组关卡
 * 地图作为一个副本开放：开启时追加“复活点(副本)”入口，关闭时迁移人员、
 * 召唤物和载具，清理标记并刷新这一组地图。
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { MapService } from './map.service';

/**
 * 副本临时入口的名称后缀（原版 加括号 (“副本”)）。
 * 入口名 = 副本名 + 该后缀，去掉后缀即真实副本地图名。
 */
const INSTANCE_ENTRY_SUFFIX = '(副本)';

export interface DungeonMapGroup {
  name: string;
  maps: any[];
}

export interface CloseDungeonResult {
  name: string;
  movedPlayers: string[];
  message: string;
}

/**
 * 副本入口统一生成结果
 */
export interface DungeonEntryResult {
  ok: boolean;
  /** 入口名称（副本名 + “(副本)”） */
  entryName?: string;
  /** 入口指向的真实副本地图 ID */
  mapId?: number;
  /** 入口到期时刻（毫秒时间戳）：开启时刻 + 有效期 */
  expireAt?: number;
  /** 失败原因 */
  reason?: string;
}

/**
 * 副本入口来源
 * - spawn：0/12/18 点定时生成（原版 后台运作.ecode L3-35「生成副本」）
 * - ticket：玩家消耗副本券开启（原版 _主程序.ecode L3916-3918「开启副本」）
 */
export const DUNGEON_ENTRY_SOURCE = {
  SPAWN: 'spawn',
  TICKET: 'ticket',
} as const;

/**
 * 副本入口默认有效期（小时）。原版入口是内存态、随重启消失，无过期概念；
 * 本框架持久化入口后用有效期实现「开启 24h 后自动关闭」，可通过配置中心
 * game.dungeonEntryLifetimeHours 调整。
 */
const DEFAULT_ENTRY_LIFETIME_HOURS = 24;

@Injectable()
export class DungeonService {
  private readonly logger = new Logger(DungeonService.name);
  /** 入口清扫运行锁：启动、每 5 分钟定时与玩家踩到过期入口都会触发，防并发重复关闭副本 */
  private sweepRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly mapService: MapService,
  ) {}

  /**
   * 原版 _主程序.ecode L3869-L3881/L3930-L3940 的副本候选地图筛选。
   * 同一复活点只显示一次；家园和“使魔挑战”不属于可开启副本。
   */
  async getInstanceGroups(): Promise<DungeonMapGroup[]> {
    const maps = await this.mapService.getAllMaps();
    const groups = new Map<string, any[]>();
    for (const [index, map] of maps.entries()) {
      const name = String(map.respawnPoint || map.复活点 || map.name || '').trim();
      // 原版循环从地图列表第3项开始，医疗室/走廊只是新手剧情副本，
      // 不出现在“开启副本/刷新副本”菜单中。
      if (index < 2 || !map.isInstance || map.isFrontier || !name || String(map.name || '').startsWith('使魔挑战')) {
        continue;
      }
      const group = groups.get(name) || [];
      group.push(map);
      groups.set(name, group);
    }
    return [...groups.entries()].map(([name, groupMaps]) => ({ name, maps: groupMaps }));
  }

  async findInstanceGroup(name: string): Promise<DungeonMapGroup | null> {
    const normalized = String(name || '').trim();
    if (!normalized) return null;
    const groups = await this.getInstanceGroups();
    return groups.find((group) => group.name === normalized) || null;
  }

  /**
   * 解析副本名对应的真实地图（原版 _主程序.ecode L6590「取地图列表编号(去掉"(副本)"的名称)」）。
   *
   * 先按副本组（复活点名）匹配，再回退按地图名精确匹配：
   * 「生成副本」的名单来自 [商店]副本/副本2（复活点名，必然是地图名），
   * 「开启副本」的名单来自副本组，两条路径都能解析到同一张真实地图。
   *
   * @param name 副本名（不含“(副本)”后缀）
   * @returns 真实地图对象；不存在时返回 null
   */
  async resolveDungeonTarget(name: string): Promise<any | null> {
    const normalized = String(name || '').trim();
    if (!normalized) return null;

    const group = await this.findInstanceGroup(normalized);
    if (group) {
      // 组内锚点图：名称与复活点同名的那一张（原版 L3890-3891 的双条件）
      const anchor = group.maps.find((map) => String(map?.name || '').trim() === normalized)
        || group.maps[0];
      if (anchor) return anchor;
    }
    return await this.mapService.getMapByName(normalized).catch(() => null);
  }

  /**
   * 统一副本入口生成：定时「生成副本」与玩家「开启副本」两条路径都走这里，
   * 保证入口结构一致（带 mapId 指向真实副本地图、距离 100、isInstance 标记）。
   *
   * 原版两条路径都只是 `加入成员(地图.可前往, k)`，只加不删，入口随重启消失；
   * 「刷新副本」关闭副本时才按名称删除入口（后台运作.ecode L1082-L1090）。
   *
   * 这里补上 mapId 是为了让「前往 X(副本)」不再依赖名称解析（名称解析在副本名与地图名
   * 不一致时会产生永远进不去的入口，见 2026-09-13 的“扭曲深渊”事故）。
   * 唯一差异：同图同名入口幂等（原版会重复加入成员），避免面板出现重复编号。
   *
   * 与原版的差异（2026-09-13 需求）：入口持久化并带有效期——从开启时刻起
   * game.dungeonEntryLifetimeHours（默认 24h）后自动关闭；重启不清空、按剩余时间
   * 继续倒计时，取代原版「重启重置」的内存态语义。
   *
   * @param mapId 承载入口的地图 ID（玩家/随机选中的出发地图）
   * @param dungeonName 副本名（不含“(副本)”后缀）
   * @param source 入口来源，见 DUNGEON_ENTRY_SOURCE
   */
  async openDungeonEntry(
    mapId: number,
    dungeonName: string,
    source: string = DUNGEON_ENTRY_SOURCE.TICKET,
  ): Promise<DungeonEntryResult> {
    const name = String(dungeonName || '').trim();
    if (!name) return { ok: false, reason: '副本名为空' };

    const target = await this.resolveDungeonTarget(name);
    if (!target) return { ok: false, reason: `副本不存在${name}` };

    // 原版是纯追加；同图同名先删后写保证 mapId 指向当前地图（幂等去重）。
    // 入口从开启时刻起计有效期（两条路径一致），到期由 sweepDungeonEntries 自动关闭。
    const entryName = `${name}${INSTANCE_ENTRY_SUFFIX}`;
    const expireAt = Date.now() + (await this.getEntryLifetimeMs());
    await this.mapService.removeMapConnection(mapId, entryName);
    await this.mapService.appendMapConnection(mapId, {
      name: entryName,
      mapId: Number(target.id),
      distance: 100,
      isInstance: true,
      source,
      expireAt,
    });
    return { ok: true, entryName, mapId: Number(target.id), expireAt };
  }

  /**
   * 读取副本入口有效期（毫秒）。配置中心 game.dungeonEntryLifetimeHours；读取失败回退默认 24h。
   */
  private async getEntryLifetimeMs(): Promise<number> {
    try {
      const row = await this.prisma.systemConfig.findUnique({
        where: { key: 'game.dungeonEntryLifetimeHours' },
      });
      const hours = Number(row?.value);
      if (Number.isFinite(hours) && hours > 0) return hours * 3600 * 1000;
    } catch {
      // 测试桩/配置表未就绪时走默认值
    }
    return DEFAULT_ENTRY_LIFETIME_HOURS * 3600 * 1000;
  }

  /**
   * 副本入口清扫（启动 + 每 5 分钟定时触发）：
   *
   * 1) 无效入口（去掉“(副本)”后解析不到任何地图的历史脏数据）→ 直接删除；
   * 2) 过期入口（expireAt 倒计时结束，开启时刻 + 有效期）→ 删除入口；若全服已无该副本名
   *    的未过期入口，执行完整关闭（迁移副本内玩家、清怪重刷——对应原版「刷新副本」的
   *    关闭语义）；若其他地图还有未到期的同名入口，只删到期这条，副本继续开放。
   *
   * 原版入口是内存态、随重启消失；持久化后以「到期时间」取代「重启重置」：
   * 重启不清空入口，倒计时继续（玩家副本券开的入口不再因重启被吞）。
   * 无 expireAt 的存量入口按原版语义视为长期有效，同名重新开启时会被带 expireAt 的新入口覆盖。
   *
   * @returns 清扫统计：删除数 / 过期数 / 关闭的副本组 / “地图→入口”清单
   */
  async sweepDungeonEntries(): Promise<{
    removed: number;
    expired: number;
    closedGroups: string[];
    entries: string[];
  }> {
    // 启动/定时/玩家触发可能并发，重入时放弃本轮（下一轮 5 分钟后自然补扫）
    if (this.sweepRunning) {
      return { removed: 0, expired: 0, closedGroups: [], entries: [] };
    }
    this.sweepRunning = true;
    try {
      const now = Date.now();
      const allMaps = await this.mapService.getAllMaps();

      // 第一遍分类：过期 / 无效（未过期但解析不到地图）/ 未过期有效（记录副本名）
      const expired: Array<{ mapId: number; entryName: string; baseName: string; mapName: string }> = [];
      const invalid: Array<{ mapId: number; entryName: string; mapName: string }> = [];
      const liveBaseNames = new Set<string>();
      for (const map of allMaps) {
        for (const connection of this.mapService.getConnections(map)) {
          const entryName = String(connection?.name || '');
          if (!entryName.endsWith(INSTANCE_ENTRY_SUFFIX)) continue;
          const baseName = entryName.slice(0, -INSTANCE_ENTRY_SUFFIX.length);
          const expireAt = Number(connection?.expireAt || 0);
          if (expireAt > 0 && expireAt <= now) {
            expired.push({ mapId: Number(map.id), entryName, baseName, mapName: String(map.name) });
            continue;
          }
          const target = await this.resolveDungeonTarget(baseName);
          if (!target) {
            invalid.push({ mapId: Number(map.id), entryName, mapName: String(map.name) });
          } else {
            liveBaseNames.add(baseName);
          }
        }
      }

      // 第二遍执行删除：无效入口 + 到期入口
      const entries: string[] = [];
      for (const item of [...invalid, ...expired]) {
        await this.mapService.removeMapConnection(item.mapId, item.entryName);
        entries.push(`${item.mapName}→${item.entryName}`);
      }

      // 过期副本的完整关闭：closeDungeon 会删除全服同名入口，
      // 仅当不存在任何未到期同名入口时才执行，避免误关别处刚开的副本
      const closedGroups: string[] = [];
      const handledBases = new Set<string>();
      for (const item of expired) {
        if (liveBaseNames.has(item.baseName) || handledBases.has(item.baseName)) continue;
        handledBases.add(item.baseName);
        const group = await this.findInstanceGroup(item.baseName);
        if (!group) continue;
        await this.closeDungeon(item.baseName);
        closedGroups.push(item.baseName);
      }

      const removed = entries.length;
      if (removed > 0) {
        this.logger.log(
          `副本入口清扫：删除 ${removed} 条（过期 ${expired.length}，关闭副本组 ${closedGroups.join('、') || '无'}）：${entries.join('、')}`,
        );
      }
      return { removed, expired: expired.length, closedGroups, entries };
    } finally {
      this.sweepRunning = false;
    }
  }

  /**
   * 原版后台运作.ecode L1039-L1106：关闭并刷新一个复活点下的副本地图组。
   * 玩家仍然使用数据库中的基础地图 ID；“(副本)”只是一条临时入口名称。
   */
  async closeDungeon(respawnPoint: string): Promise<CloseDungeonResult> {
    const group = await this.findInstanceGroup(respawnPoint);
    if (!group) {
      return {
        name: respawnPoint,
        movedPlayers: [],
        message: `${respawnPoint}副本不存在`,
      };
    }

    const allMaps = await this.mapService.getAllMaps();
    const instanceMapIds = group.maps
      .map((map) => Number(map.id))
      .filter((id) => Number.isFinite(id) && id > 0);

    // 原版固定把关闭副本中的玩家送到地图列表[23]。
    // 这里按静态地图顺序取第23张，保留该硬编码语义；数据不足时才回退到医疗室。
    const exitMap = allMaps[22]
      || await this.mapService.getMapByName('医疗室').catch(() => null)
      || allMaps[0];
    if (!exitMap) {
      throw new Error('没有可用的副本出口地图');
    }

    const movedPlayers: string[] = [];
    if (instanceMapIds.length > 0) {
      const players = await this.prisma.player.findMany({
        where: { mapId: { in: instanceMapIds } },
        select: { id: true, userId: true, name: true, markers: true, markers2: true },
      });
      for (const player of players) {
        const markers = this.parseObject(player.markers, {});
        delete markers['移动中'];
        // 同步清除 markers2 的「移动」镜像锁标记：否则提前传送出副本后，残留的
        // 行动门禁会让玩家在新地图被 行动无限制 拦截移动，且面板读条不消失
        const markers2 = Array.isArray(player.markers2)
          ? (player.markers2 as any[])
          : [];
        const kept2 = markers2.filter((m: any) => String(m?.名称 ?? m?.name ?? '') !== '移动');
        await this.playerService.enqueueUserWrite(player.userId, async () => {
          const _pd = await this.playerService.getPlayerData(player.userId);
          Object.assign(_pd.player, {
            mapId: exitMap.id,
            location: exitMap.name,
            // Player markers 为 Json 列，直接写对象
            markers,
            ...(kept2.length !== markers2.length ? { markers2: kept2 } : {}),
          });
          await this.playerService.savePlayer(_pd.player);
        });
        movedPlayers.push(player.name || `玩家${player.id}`);
      }
    }

    // 把副本内的召唤物和载具带回原版固定出口，再清空副本地图容器。
    // 逐图 mutateMapFields 锁内闭环：重读最新容器 → 取走全部单位 → 写回空数组，
    // 出口图再把累计单位并入（此前基于合并快照的读改写在并发下会互相覆盖）。
    const exitSummons: any[] = [];
    const exitVehicles: any[] = [];
    for (const map of group.maps) {
      await this.mapService.mutateMapFields(map.id, ['summons', 'vehicles'], (f) => {
        exitSummons.push(...f.summons);
        exitVehicles.push(...f.vehicles);
        f.summons = [];
        f.vehicles = [];
      });
    }
    await this.mapService.mutateMapFields(exitMap.id, ['summons', 'vehicles'], (f) => {
      f.summons.push(...exitSummons);
      f.vehicles.push(...exitVehicles);
    });

    // 同步 GameVehicle.mapIndex：双写路径下表行仍可能指向副本图，关副本后改到出口。
    // 地图 JSON 已迁走的车 + 仅存在表里、mapIndex 仍落在副本组的行，一并改。
    const vehicleModel = (this.prisma as any).gameVehicle;
    if (vehicleModel?.updateMany && instanceMapIds.length > 0) {
      try {
        await vehicleModel.updateMany({
          where: { mapIndex: { in: instanceMapIds } },
          data: { mapIndex: exitMap.id },
        });
      } catch (error: any) {
        this.logger.warn(`关闭副本同步 GameVehicle.mapIndex 失败: ${error?.message ?? error}`);
      }
    }

    // 原版先删除所有入口，再刷新所有复活点相同的地图。
    const dungeonEntry = `${group.name}${INSTANCE_ENTRY_SUFFIX}`;
    for (const map of allMaps) {
      await this.mapService.removeMapConnection(map.id, dungeonEntry);
    }

    for (const map of group.maps) {
      // refreshMapMonsters 保留临时怪物；原版刷新地图会清空怪物2，因此先全删再按模板重刷。
      await this.mapService.clearMapMonsters(map.id);
      await this.mapService.refreshMapMonsters(map.id);
      await this.mapService.refreshMapResources(map.id).catch((error: any) => {
        this.logger.warn(`刷新副本资源失败 map=${map.name}: ${error?.message}`);
      });
    }

    // 原版 d=地图列表中名称等于 w2 的地图，清理该地图配置的“删除标记”。
    const markerMap = group.maps.find((map) => map.name === group.name) || group.maps[0];
    const clearMarkers = String(markerMap?.clearMarkers || '').split(/\s+/).filter(Boolean);
    if (clearMarkers.length > 0) {
      const players = await this.prisma.player.findMany({
        select: { id: true, userId: true, markers: true },
      });
      for (const player of players) {
        const markers = this.parseObject(player.markers, {});
        let changed = false;
        for (const marker of clearMarkers) {
          if (Object.prototype.hasOwnProperty.call(markers, marker)) {
            delete markers[marker];
            changed = true;
          }
        }
        if (changed) {
          await this.playerService.enqueueUserWrite(player.userId, async () => {
            const _pd = await this.playerService.getPlayerData(player.userId);
            // Player markers 为 Json 列，直接写对象
            Object.assign(_pd.player, { markers });
            await this.playerService.savePlayer(_pd.player);
          });
        }
      }
    }

    const movedText = movedPlayers.length > 0
      ? `，${movedPlayers.join('、')}被传送离开了副本。`
      : '';
    const message = `${group.name}副本已关闭${movedText}`;
    this.logger.log(`副本 ${group.name} 已关闭，迁移玩家 ${movedPlayers.length} 人`);
    return { name: group.name, movedPlayers, message };
  }

  private parseArray(value: any, fallback: any[]): any[] {
    if (Array.isArray(value)) return [...value];
    try {
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed) ? parsed : [...fallback];
    } catch {
      return [...fallback];
    }
  }

  private parseObject(value: any, fallback: Record<string, any>): Record<string, any> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
    try {
      const parsed = JSON.parse(value || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { ...fallback };
    } catch {
      return { ...fallback };
    }
  }
}
