/**
 * 地图服务
 * 对应原版易语言：地图操作.ecode
 * 负责地图管理、移动、资源刷新等
 *
 * 架构说明（静态/动态分离）：
 * - 静态字段（name, description, connections, npcs, monsters, items, buildings, vehicles,
 *   requireMarkers, mapBuffs 等）从 StaticDataService 读取 maps.json，无需 seed。
 * - 动态字段（spawnMonsters, tempMonsters, summons, resources, resources2, markers, markers2）
 *   仍在数据库 GameMap 表中，用于存储运行时状态。
 * - getMapById / getMapByName 会自动合并静态定义 + 动态状态后返回。
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { StaticDataService } from './static-data.service';

/**
 * 可前往地图的连接信息
 */
export interface MapConnection {
  mapId: number;
  /** 地图名 */
  name: string;
  /** 距离（用于计算移动时间） */
  distance?: number;
  /** 需求条件：0无 1飞行 2传送 3跃迁 */
  requireTravel?: number;
  /** 需求标记列表 */
  requireMarkers?: string[];
}

/**
 * 地图上的怪物实例
 */
export interface MapMonster {
  /** 唯一标识 */
  id: string;
  /** 怪物名称 */
  name: string;
  /** 怪物等级 */
  level: number;
  /** 特殊序号 */
  specialSeq: number;
  /** 当前HP */
  hp: number;
  /** 最大HP */
  maxHp: number;
  /** 当前护盾（三层池第一层） */
  shield?: number;
  /** 最大护盾 */
  maxShield?: number;
  /** 当前装甲（三层池第二层） */
  armor?: number;
  /** 最大装甲 */
  maxArmor?: number;
  /** 攻击力 */
  attack: number;
  /** 防御力 */
  defense: number;
  /** 速度 */
  speed: number;
  /** 闪避率（百分比） */
  dodge?: number;
  /** 命中率（百分比） */
  hit?: number;
  /** 击杀经验值 */
  exp?: number;
  /** 是否精英 */
  isElite?: boolean;
  /** 掉落表（由怪物定义 bonus.drops 解析而来，[{name,quantity,rate}]） */
  dropTable?: Array<{ name: string; quantity: number; rate: number }>;
}

/**
 * 条件检查结果
 */
export interface TravelCheckResult {
  canTravel: boolean;
  reason?: string;
}

/**
 * 动态地图状态字段（仅存储在 DB 中，运行时可变）
 * - 完全动态：spawnMonsters, tempMonsters, summons, markers, markers2
 * - 半动态（JSON 提供初始值，DB 存储运行时修改）：
 *   npcs, buildings, vehicles, items, monsters, connections, resources, resources2
 *   运行时 NPC 增减、建筑建造/拆除、载具生成/移除、怪物模板变更、连接增删、资源采集次数等
 *   都会修改这些字段，因此 DB 中的值优先于 JSON 静态定义。
 */
const DYNAMIC_MAP_FIELDS = [
  'spawnMonsters', 'tempMonsters', 'summons',
  'resources', 'resources2', 'markers', 'markers2',
  'npcs', 'buildings', 'vehicles', 'items', 'monsters', 'connections',
  'mapBuffs',
];

@Injectable()
export class MapService {
  private readonly logger = new Logger(MapService.name);

  /**
   * 每张地图的进程内互斥锁（Promise 链实现）
   * 用于消除"读旧快照 → 改内存 → 整体覆盖写回"的并发丢失更新竞态。
   * 原版是单线程内存模型（全局访问锁），后端多请求并发必须显式串行化地图状态变更。
   * 注意：这是单进程锁，若 PM2 cluster 多副本部署，需改分布式锁（当前为单实例部署，够用）。
   */
  private readonly mapLocks = new Map<number, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly staticData: StaticDataService,
  ) {}

  /**
   * 对指定地图加锁执行一段异步操作，保证同一地图的状态变更串行化。
   * 锁内务必完成"读 → 改 → 写回"的完整闭环，避免并发覆盖。
   * @param mapId 地图ID
   * @param fn 需要在锁内执行的异步函数
   * @returns fn 的返回值
   */
  async withMapLock<T>(mapId: number, fn: () => Promise<T>): Promise<T> {
    // 取当前队尾（上一个任务），没有则用已完成的 Promise
    const prev = this.mapLocks.get(mapId) ?? Promise.resolve();
    // 当前任务在前一个任务 settle 之后执行（无论前一个成功或失败都继续）
    const run = prev.then(fn, fn);
    // 将"队尾"推进为当前任务（无论成功失败都 resolve，避免锁卡死）
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.mapLocks.set(mapId, tail);
    // 空闲后清理，防止 map 无限增长
    tail.finally(() => {
      if (this.mapLocks.get(mapId) === tail) {
        this.mapLocks.delete(mapId);
      }
    });
    return run;
  }

  /**
   * 合并静态地图定义（来自 JSON）和动态运行时状态（来自 DB）
   * 静态字段为基础，动态字段覆盖。
   */
  private mergeMap(staticMap: any, dbMap: any): any {
    // 静态定义作为基础
    const merged = { ...staticMap };

    // DB 的 id 覆盖 JSON 的 mapIndex（运行时使用 DB 自增 id）
    if (dbMap.id !== undefined) merged.id = dbMap.id;

    // 动态字段：DB 中有值则覆盖，否则保留静态定义
    for (const field of DYNAMIC_MAP_FIELDS) {
      if (dbMap[field] !== undefined && dbMap[field] !== null) {
        merged[field] = dbMap[field];
      }
    }

    return merged;
  }

  /**
   * 获取所有地图列表（合并静态定义 + 动态状态）
   */
  async getAllMaps(): Promise<any[]> {
    const staticMaps = this.staticData.getAllMaps();
    const dbMaps = await this.prisma.gameMap.findMany({
      orderBy: { mapIndex: 'asc' },
    });
    // 按 name 建立 DB 动态状态索引
    const dbMapByName = new Map<string, any>();
    for (const db of dbMaps) {
      dbMapByName.set(db.name, db);
    }
    return staticMaps.map((sm) => this.mergeMap(sm, dbMapByName.get(sm.name) || {}));
  }

  /**
   * 根据ID获取地图（合并静态定义 + 动态状态）
   */
  async getMapById(mapId: number): Promise<any> {
    // 先读 DB 获取 name（用于匹配静态 JSON）+ 动态字段
    const dbMap = await this.prisma.gameMap.findUnique({ where: { id: mapId } });
    if (!dbMap) return null;

    // 从静态 JSON 获取完整定义
    const staticMap = this.staticData.getMapByName(dbMap.name);
    if (!staticMap) {
      // 容错：静态 JSON 中不存在但 DB 有，直接返回 DB 数据
      this.logger.warn(`地图「${dbMap.name}」在静态 JSON 中未找到，回退到 DB 数据`);
      return dbMap;
    }

    return this.mergeMap(staticMap, dbMap);
  }

  /**
   * 根据名称获取地图（合并静态定义 + 动态状态）
   */
  async getMapByName(name: string): Promise<any> {
    const staticMap = this.staticData.getMapByName(name);
    if (!staticMap) {
      throw new NotFoundException(`地图「${name}」不存在`);
    }

    const dbMap = await this.prisma.gameMap.findUnique({ where: { name } });
    return this.mergeMap(staticMap, dbMap || {});
  }

  /**
   * 获取地图的可前往列表
   * 解析 connections JSON 字段，返回可前往的地图连接信息
   */
  getConnections(map: any): MapConnection[] {
    try {
      return JSON.parse(map.connections || '[]') as MapConnection[];
    } catch {
      this.logger.warn(`地图 ${map.name} connections 解析失败`);
      return [];
    }
  }

  /**
   * 检查是否可前往目标地图
   * 检查距离、需求条件、标记要求等
   * @param currentMap 当前所在地图
   * @param targetMap 目标地图
   * @param player 玩家对象（含 markers 等数据）
   */
  checkCanTravel(currentMap: any, targetMap: any, player: any): TravelCheckResult {
    // 1. 检查目标地图是否禁止前往
    if (targetMap.noTeleport) {
      return { canTravel: false, reason: '该地图无法直接前往' };
    }

    // 2. 检查目标地图的进入要求标记
    const requireMarkers: string[] = this.safeParseJSON(targetMap.requireMarkers, []);
    if (requireMarkers.length > 0) {
      const playerMarkers: Record<string, any> = this.safeParseJSON(player.markers, {});
      for (const marker of requireMarkers) {
        if (!(marker in playerMarkers)) {
          const hint = targetMap.failHint || `需要标记「${marker}」`;
          return { canTravel: false, reason: hint };
        }
      }
    }

    // 3. 检查连接是否可达
    const connections = this.getConnections(currentMap);
    const targetConn = connections.find((c) => c.mapId === targetMap.id || c.name === targetMap.name);
    if (!targetConn) {
      return { canTravel: true };
    }

    // 4. 检查目标地图的 requiredTravel 需求
    if (targetMap.requiredTravel > 0) {
      const playerMarkers: Record<string, any> = this.safeParseJSON(player.markers, {});
      const travelMarkerKey = `travel_${targetMap.requiredTravel}`;
      if (!(travelMarkerKey in playerMarkers)) {
        const travelTypeMap: Record<number, string> = { 1: '飞行', 2: '传送', 3: '跃迁' };
        return {
          canTravel: false,
          reason: `需要${travelTypeMap[targetMap.requiredTravel] || '特殊'}能力才能前往`,
        };
      }
    }

    return { canTravel: true };
  }

  /**
   * 计算移动所需时间（秒）
   * 根据距离和玩家速度计算
   * @param distance 距离（来自连接信息）
   * @param playerSpeed 玩家速度
   */
  calcTravelTime(distance: number, playerSpeed: number): number {
    const baseTime = distance > 0 && playerSpeed > 0 ? (distance / playerSpeed) * 10 : 5;
    return Math.max(1, Math.ceil(baseTime));
  }

  /**
   * 刷新地图怪物
   * 根据地图配置和世界等级生成怪物
   */
  async refreshMapMonsters(mapId: number): Promise<void> {
    // 获取静态定义（用于 monsters 模板和 monsterCount）
    const map = await this.getMapById(mapId);
    if (!map) {
      throw new NotFoundException(`地图 ID=${mapId} 不存在，无法刷新怪物`);
    }

    // 读取地图固定怪物列表作为模板（存的是怪物名数组），结合 monsterCount 生成实际怪物实例
    const monsterNames: string[] = this.safeParseJSON(map.monsters, []);
    const count = Math.min(map.monsterCount || 3, 20);

    // 预加载地图上所有怪物名对应的怪物定义（含三层池 护盾/装甲），来自静态配置 JSON
    const monsterDefs: Record<string, any> = {};
    if (monsterNames.length > 0) {
      const allDefs = this.staticData.getAllMonsters();
      for (const name of monsterNames) {
        const def = allDefs.find((d) => d?.name === name);
        if (def) monsterDefs[name] = def;
      }
    }

    const monsters: MapMonster[] = [];
    for (let i = 0; i < count; i++) {
      if (monsterNames.length > 0) {
        const name = monsterNames[Math.floor(Math.random() * monsterNames.length)];
        const def = monsterDefs[name];
        const shield = def?.shield || 0;
        const armor = def?.armor || 0;
        const defBonus = def?.bonus ? this.safeParseJSON<any>(def.bonus, {}) : {};
        const dropTable: Array<{ name: string; quantity: number; rate: number }> = Array.isArray(defBonus.drops)
          ? defBonus.drops
              .filter((d: any) => d && d.name)
              .map((d: any) => ({
                name: d.name,
                quantity: d.count ?? d.quantity ?? 1,
                rate: d.chance ?? 100,
              }))
          : [];
        // 怪物等级：定义等级（若为0则用地图等级），用于 _初始化怪物 等级成长
        const level = def?.level || map.level || 1;
        // 等级成长系数（对应原版 _初始化怪物 L2764：基础属性 × (1+等级×0.05)）
        const lvFactor = 1 + level * 0.05;
        const baseHp = def?.hp || 100;
        const baseMaxHp = def?.maxHp || baseHp;
        const baseShield = def?.maxShield || shield;
        const baseArmor = def?.maxArmor || armor;
        monsters.push({
          id: `monster_${mapId}_${i}_${randomUUID()}`,
          name: def?.name || name || '未知怪物',
          level,
          specialSeq: def?.specialSeq || 0,
          hp: Math.floor(baseMaxHp * lvFactor),
          maxHp: Math.floor(baseMaxHp * lvFactor),
          shield: Math.floor(baseShield * lvFactor),
          maxShield: Math.floor(baseShield * lvFactor),
          armor: Math.floor(baseArmor * lvFactor),
          maxArmor: Math.floor(baseArmor * lvFactor),
          attack: Math.floor((def?.attack || 10) * lvFactor),
          defense: def?.defense || 0,
          speed: Math.floor((def?.speed || 100) * lvFactor),
          dodge: Math.floor((def?.dodge || 5) * lvFactor),
          hit: Math.floor((def?.hit || 85) * lvFactor),
          exp: Math.floor((defBonus.经验 || 10) * lvFactor),
          isElite: def?.type === '精英' || false,
          dropTable,
        });
      } else {
        const level = map.level || 1;
        const lvFactor = 1 + level * 0.05;
        monsters.push({
          id: `monster_${mapId}_${i}_${randomUUID()}`,
          name: '野怪',
          level,
          specialSeq: 0,
          hp: Math.floor(100 * lvFactor),
          maxHp: Math.floor(100 * lvFactor),
          shield: 0,
          maxShield: 0,
          armor: 0,
          maxArmor: 0,
          attack: Math.floor(10 * lvFactor),
          defense: 0,
          speed: Math.floor(100 * lvFactor),
          dodge: Math.floor(5 * lvFactor),
          hit: Math.floor(85 * lvFactor),
          exp: Math.floor(10 * lvFactor),
          isElite: false,
        });
      }
    }

    // 将生成的怪物写入 spawnMonsters 字段（加锁，避免与并发的血量更新互相覆盖）
    await this.withMapLock(mapId, async () => {
      await this.prisma.gameMap.update({
        where: { id: mapId },
        data: { spawnMonsters: JSON.stringify(monsters) },
      });
    });

    this.logger.log(`地图 ${map.name} 刷新了 ${monsters.length} 只怪物`);
  }

  /**
   * 获取地图上的怪物列表
   * 合并固定怪物(spawnMonsters)和临时怪物(tempMonsters)
   */
  getMapMonsters(map: any): MapMonster[] {
    const spawnMonsters: MapMonster[] = this.safeParseJSON(map.spawnMonsters, []);
    const tempMonsters: MapMonster[] = this.safeParseJSON(map.tempMonsters, []);
    return [...spawnMonsters, ...tempMonsters];
  }

  /**
   * 移除地图上的怪物（死亡后）
   * 从 spawnMonsters 或 tempMonsters 中移除指定怪物
   */
  removeMapMonster(map: any, monsterId: string): void {
    const spawnMonsters: MapMonster[] = this.safeParseJSON(map.spawnMonsters, []);
    const tempMonsters: MapMonster[] = this.safeParseJSON(map.tempMonsters, []);

    map.spawnMonsters = JSON.stringify(spawnMonsters.filter((m) => m.id !== monsterId));
    map.tempMonsters = JSON.stringify(tempMonsters.filter((m) => m.id !== monsterId));
  }

  /**
   * 地图资源刷新
   * 定时刷新可采集资源
   */
  async refreshMapResources(mapId: number): Promise<void> {
    const map = await this.getMapById(mapId);
    if (!map) {
      throw new NotFoundException(`地图 ID=${mapId} 不存在，无法刷新资源`);
    }

    // 读取 resources2（可采集资源）作为模板，重新生成
    const resourceTemplates: any[] = this.safeParseJSON(map.resources2, []);
    if (resourceTemplates.length === 0) {
      this.logger.warn(`地图 ${map.name} 无可采集资源模板，跳过刷新`);
      return;
    }

    const refreshedResources = resourceTemplates.map((tpl: any, idx: number) => ({
      id: `resource_${mapId}_${idx}_${Date.now()}`,
      name: tpl.name || '未知资源',
      type: tpl.type || '普通',
      amount: tpl.amount || 1,
      respawnTime: tpl.respawnTime || 300,
    }));

    const resources: any[] = this.safeParseJSON(map.resources, []);

    await this.prisma.gameMap.update({
      where: { id: mapId },
      data: {
        resources: JSON.stringify(resources),
        resources2: JSON.stringify(refreshedResources),
      },
    });

    this.logger.log(`地图 ${map.name} 刷新了 ${refreshedResources.length} 个可采集资源`);
  }

  /**
   * 更新地图动态字段（仅写 DB，不影响静态 JSON）
   */
  async updateDynamicFields(mapId: number, data: Record<string, any>): Promise<void> {
    // 只允许更新动态字段
    const updateData: Record<string, any> = {};
    for (const field of DYNAMIC_MAP_FIELDS) {
      if (data[field] !== undefined) {
        updateData[field] = data[field];
      }
    }
    if (Object.keys(updateData).length === 0) return;

    await this.prisma.gameMap.update({
      where: { id: mapId },
      data: updateData,
    });
  }

  /**
   * 安全解析 JSON 字符串，解析失败返回默认值
   */
  private safeParseJSON<T>(jsonStr: string, defaultValue: T): T {
    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      return defaultValue;
    }
  }
}