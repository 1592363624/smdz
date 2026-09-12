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

@Injectable()
export class DungeonService {
  private readonly logger = new Logger(DungeonService.name);

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
   * 原版两条路径都只是 `加入成员(地图.可前往, k)`，既不写地图编号也不回收旧入口；
   * 这里补上 mapId 是为了让「前往 X(副本)」不再依赖名称解析（名称解析在副本名与地图名
   * 不一致时会产生永远进不去的入口，见 2026-09-13 的“扭曲深渊”事故）。
   *
   * 覆盖策略：同名的旧入口先移除再写入（保证 mapId 指向当前地图）；
   * source=spawn 时额外回收本图上一次定时生成的入口，避免入口无限累积，
   * 但不会动玩家花副本券开的 source=ticket 入口。
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

    // 定时生成先回收自己上一次的入口，避免 0/12/18 点各刷一次后入口堆积
    if (source === DUNGEON_ENTRY_SOURCE.SPAWN) {
      await this.removeSpawnedDungeonEntries(mapId);
    }
    // 同名入口可能由另一条路径留下且 mapId 已失效，先按名称移除再重写
    const entryName = `${name}(副本)`;
    await this.mapService.removeMapConnection(mapId, entryName);
    await this.mapService.appendMapConnection(mapId, {
      name: entryName,
      mapId: Number(target.id),
      distance: 100,
      isInstance: true,
      source,
    });
    return { ok: true, entryName, mapId: Number(target.id) };
  }

  /**
   * 回收某张地图上由定时生成留下的副本入口（source=spawn）。
   * 历史数据没有 source 标记，由 purgeInvalidDungeonEntries 按“是否指向真实地图”兜底清理。
   */
  private async removeSpawnedDungeonEntries(mapId: number): Promise<void> {
    const map = await this.mapService.getMapById(mapId).catch(() => null);
    if (!map) return;
    const spawned = this.mapService.getConnections(map).filter(
      (connection: any) => String(connection?.name || '').endsWith(INSTANCE_ENTRY_SUFFIX)
        && connection?.source === DUNGEON_ENTRY_SOURCE.SPAWN,
    );
    for (const connection of spawned) {
      await this.mapService.removeMapConnection(mapId, String(connection.name));
    }
  }

  /**
   * 清理无效副本入口（启动自愈 + 数据兜底）。
   *
   * 判定：连接名以“(副本)”结尾，且 mapId 未指向存在的地图、去掉“(副本)”后也查不到同名地图，
   * 即为脏入口（玩家点了只会得到“地图不存在”）。典型来源：旧版定时生成用了
   * 地图表里不存在的副本名（扭曲深渊/遗忘之地/…）——入口会一直卡在地图上直到副本被刷新。
   *
   * @returns 清理统计：涉及地图数、删除入口数、被删入口的“地图→入口”清单
   */
  async purgeInvalidDungeonEntries(): Promise<{ maps: number; removed: number; entries: string[] }> {
    const allMaps = await this.mapService.getAllMaps();
    const validIds = new Set(
      allMaps.map((map: any) => Number(map?.id)).filter((id) => Number.isFinite(id) && id > 0),
    );
    const validNames = new Set(
      allMaps.map((map: any) => String(map?.name || '').trim()).filter(Boolean),
    );

    let maps = 0;
    let removed = 0;
    const entries: string[] = [];
    for (const map of allMaps) {
      const invalid = this.mapService.getConnections(map).filter((connection: any) => {
        const entryName = String(connection?.name || '');
        if (!entryName.endsWith(INSTANCE_ENTRY_SUFFIX)) return false;
        const byId = connection?.mapId !== undefined
          && connection?.mapId !== null
          && validIds.has(Number(connection.mapId));
        const byName = validNames.has(entryName.slice(0, -INSTANCE_ENTRY_SUFFIX.length));
        return !byId && !byName;
      });
      if (invalid.length === 0) continue;

      maps += 1;
      for (const connection of invalid) {
        const entryName = String(connection.name);
        await this.mapService.removeMapConnection(Number(map.id), entryName);
        entries.push(`${map.name}→${entryName}`);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.logger.log(`清理无效副本入口 ${removed} 条（涉及 ${maps} 张地图）：${entries.join('、')}`);
    }
    return { maps, removed, entries };
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
        select: { id: true, userId: true, name: true, markers: true },
      });
      for (const player of players) {
        const markers = this.parseObject(player.markers, {});
        delete markers['移动中'];
        await this.playerService.enqueueUserWrite(player.userId, async () => {
          const _pd = await this.playerService.getPlayerData(player.userId);
          Object.assign(_pd.player, {
            mapId: exitMap.id,
            location: exitMap.name,
            // Player markers 为 Json 列，直接写对象
            markers,
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
