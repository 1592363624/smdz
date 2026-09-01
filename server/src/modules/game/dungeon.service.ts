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

export interface DungeonMapGroup {
  name: string;
  maps: any[];
}

export interface CloseDungeonResult {
  name: string;
  movedPlayers: string[];
  message: string;
}

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
    const exitSummons = this.parseArray(exitMap.summons, []);
    const exitVehicles = this.parseArray(exitMap.vehicles, []);
    for (const map of group.maps) {
      exitSummons.push(...this.parseArray(map.summons, []));
      exitVehicles.push(...this.parseArray(map.vehicles, []));
      await this.mapService.updateDynamicFields(map.id, {
        // GameMap Json 列：空重置也必须传数组（字符串会被双重编码）
        summons: [],
        vehicles: [],
      });
    }
    await this.mapService.updateDynamicFields(exitMap.id, {
      summons: exitSummons, // Json 列直接写数组
      vehicles: exitVehicles,
    });

    // 原版先删除所有入口，再刷新所有复活点相同的地图。
    const dungeonEntry = `${group.name}(副本)`;
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
