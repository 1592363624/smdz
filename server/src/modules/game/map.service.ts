/**
 * 地图服务
 * 对应原版易语言：地图操作.ecode
 * 负责地图管理、移动、资源刷新等
 *
 * 架构说明（静态/动态分离）：
 * - 静态字段（name, description, connections, npcs, monsters, items, buildings, vehicles,
 *   requireMarkers, mapBuffs 等）从 StaticDataService 读取 maps.json，无需 seed。
 * - 动态字段（summons, resources, resources2, markers, markers2）仍在数据库 GameMap 表中，用于存储运行时状态。
 * - 怪物运行时实例已独立为 GameMonster 表（对应原版「玩家」结构体，1:1 对齐 @Struct.ecode L287-341），
 *   不再存于 GameMap.spawnMonsters/tempMonsters（已删除）。常驻怪物由 refreshMapMonsters
 *   按 maps.json 的 monsters 模板生成；临时怪物（嗅探/事件/召唤）由 addTempMonster 写入 isTemp=true。
 * - getMapById / getMapByName 会自动合并静态定义 + 动态状态后返回。
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { StaticDataService } from './static-data.service';
import { BonusService } from './bonus.service';
import { CombatStateService } from './combat-state.service';

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
 * 地图上的怪物实例（对应 GameMonster 表行 + 原版「玩家」结构体运行时视图）
 * 战斗/使魔/管理模块直接读写 hp/shield/armor/bonus/buffs/markers 等字段，
 * 所有字段与原版 玩家 结构体（@Struct.ecode L287-341）1:1 对齐。
 */
export interface MapMonster {
  /** 数据库自增ID（对应原版 玩家.QQ，原版为"怪物"+生成编号()） */
  id: number;
  /** 所属地图ID */
  mapId: number;
  /** 怪物类型名（对应原版 玩家.类型，查 monsters.json 模板的 key） */
  type: string;
  /** 显示名称（对应原版 玩家.名称） */
  name: string;
  /** 唯一标识字符串（对应原版 玩家.QQ，"怪物"+生成编号()） */
  qq: string;
  /** 唯一标识字符串（兼容旧调用方按字符串比较 id，存为"monster_"+id） */
  uid?: string;
  /** 特殊序号 specialSeq */
  specialSeq: number;
  /** 归属（宠物主人 QQ） */
  ownerQQ?: string;
  /** 等级 */
  level: number;
  /** 图片/觉醒名前缀 */
  image?: string;
  /** 当前HP */
  hp: number;
  /** 最大HP */
  maxHp: number;
  /** 当前护盾（三层池第一层） */
  shield: number;
  /** 最大护盾 */
  maxShield: number;
  /** 当前装甲（三层池第二层） */
  armor: number;
  /** 最大装甲 */
  maxArmor: number;
  /** 攻击力（怪物定义 attack） */
  attack: number;
  /** 防御力（怪物定义 defense） */
  defense: number;
  /** 速度（怪物定义 speed） */
  speed: number;
  /** 闪避率（怪物定义 dodge，百分比） */
  dodge: number;
  /** 命中率（怪物定义 hit，百分比） */
  hit: number;
  /** 是否精英 */
  isElite: boolean;
  /** 受加成后的最终属性（BonusData JSON 字符串） */
  bonus: string;
  /** 基础加成（JSON 字符串） */
  baseBonus: string;
  /** 额外加成（JSON 字符串） */
  extraBonus: string;
  /** 装备数组 JSON 字符串 */
  equipments: string;
  /** 武器数组 JSON 字符串 */
  weapons: string;
  /** 当前武器索引 */
  currentWeapon: number;
  /** 装备预设 JSON 字符串 */
  equipmentPresets: string;
  /** 永久标记/熟练度 JSON 字符串 */
  markers: string;
  /** 限时标记/增益 JSON 字符串 */
  markers2: string;
  /** 增益 JSON 字符串 */
  buffs: string;
  /** 成就熟练度 JSON 字符串 */
  achievements: string;
  /** 套装对象 JSON 字符串 */
  set: string;
  /** 好感 */
  affinity: number;
  /** 活力（宠物存特殊序号） */
  vitality: number;
  /** 击杀经验 */
  exp: number;
  /** 背包 JSON 字符串 */
  backpack: string;
  /** 时间差（分钟） */
  timeDiff: number;
  /** 读取时间（长整数时间戳） */
  readTime: bigint;
  /** 是否宠物 */
  isPet: boolean;
  /** 是否临时怪物 */
  isTemp: boolean;
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
 * - 完全动态：summons, markers, markers2
 * - 半动态（JSON 提供初始值，DB 存储运行时修改）：
 *   npcs, buildings, vehicles, items, monsters, connections, resources, resources2
 *   运行时 NPC 增减、建筑建造/拆除、载具生成/移除、怪物模板变更、连接增删、资源采集次数等
 *   都会修改这些字段，因此 DB 中的值优先于 JSON 静态定义。
 * 注意：怪物运行时实例已迁移到 GameMonster 表，不再出现在 DYNAMIC_MAP_FIELDS。
 */
const DYNAMIC_MAP_FIELDS = [
  'summons',
  'resources', 'resources2', 'markers', 'markers2',
  'npcs', 'buildings', 'vehicles', 'items', 'monsters', 'connections',
  'mapBuffs', 'music',
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
    private readonly bonusService: BonusService,
    private readonly combatState: CombatStateService,
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
    const merged = staticMaps.map((sm) => this.mergeMap(sm, dbMapByName.get(sm.name) || {}));

    // 原版会在运行时把玩家家园追加到全局地图列表。动态家园不在静态
    // maps.json 中，因此不能只返回静态地图，否则前往/观察/地图总览会丢失家园。
    const staticNames = new Set(staticMaps.map((sm: any) => sm.name));
    for (const dbMap of dbMaps) {
      if (!staticNames.has(dbMap.name)) {
        merged.push(dbMap);
      }
    }
    return merged;
  }

  /**
   * 查询原版“召唤物存在”。类型1查全局地图召唤物，类型2查全局 GameMonster。
   * 召唤物字段兼容当前英文 JSON、原版中文字段以及已解析数组。
   */
  async summonExists(type: number, qq: string): Promise<boolean> {
    const targetQQ = String(qq ?? '');
    if (!targetQQ) return false;

    if (type === 1) {
      const maps = await this.getAllMaps();
      return maps.some((map: any) => {
        const raw = map?.summons ?? map?.召唤物 ?? [];
        const summons = Array.isArray(raw)
          ? raw
          : this.safeParseJSON<any[]>(raw, []);
        return summons.some((summon: any) =>
          String(summon?.qq ?? summon?.QQ ?? '') === targetQQ,
        );
      });
    }

    const monsters = (this.prisma as any).gameMonster;
    if (!monsters) return false;
    if (typeof monsters.findFirst === 'function') {
      const found = await monsters.findFirst({
        where: { qq: targetQQ },
        select: { id: true },
      });
      return Boolean(found);
    }
    if (typeof monsters.findMany === 'function') {
      const found = await monsters.findMany({ where: { qq: targetQQ } });
      return Array.isArray(found) && found.length > 0;
    }
    return false;
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
    const dbMap = await this.prisma.gameMap.findUnique({ where: { name } });
    if (!staticMap) {
      if (dbMap) return dbMap;
      throw new NotFoundException(`地图「${name}」不存在`);
    }
    return this.mergeMap(staticMap, dbMap || {});
  }

  /**
   * 确保一个玩家家园的院子、屋内和前线地图存在，并补齐双向入口。
   *
   * 对应原版 接口1.ecode L1395-1480：读取玩家存档后，把
   * `${房子名称}`、`${房子名称}屋内`、`${房子名称}前线` 作为动态地图
   * 追加到地图列表。进度小于4时只创建院子；房屋建成后再创建后两张地图。
   */
  async ensureHouseMaps(
    houseName: string,
    baseMapId: number,
    homeProgress: number,
  ): Promise<{ yard: any; interior?: any; frontline?: any }> {
    if (!houseName) throw new NotFoundException('家园名称为空，无法创建家园地图');

    const baseMap = await this.getMapById(baseMapId);
    if (!baseMap) {
      throw new NotFoundException(`家园所在地图 ID=${baseMapId} 不存在`);
    }

    const yard = await this.ensureDynamicMap(houseName, {
      description: `玩家在${baseMap.name}圈定的家园`,
      isFrontier: true,
      connections: JSON.stringify([{ name: baseMap.name, mapId: baseMap.id, distance: 10, isFrontier: false }]),
    });
    await this.appendMapConnection(baseMap.id, {
      name: houseName,
      mapId: yard.id,
      distance: 10,
      isFrontier: true,
    });

    if (homeProgress < 4) {
      return { yard };
    }

    const buildings = yard.buildings || '[]';
    const items = yard.items || '[]';
    const interior = await this.ensureDynamicMap(`${houseName}屋内`, {
      description: `${houseName}的屋内`,
      isFrontier: true,
      buildings,
      items,
      connections: JSON.stringify([{ name: houseName, mapId: yard.id, distance: 10, isFrontier: true }]),
    });
    const frontline = await this.ensureDynamicMap(`${houseName}前线`, {
      description: `${houseName}的前线防御阵地`,
      isInstance: true,
      buildings,
      items,
      connections: JSON.stringify([{ name: houseName, mapId: yard.id, distance: 10, isFrontier: true }]),
    });

    await this.appendMapConnection(yard.id, {
      name: interior.name,
      mapId: interior.id,
      distance: 10,
      isFrontier: true,
    });
    await this.appendMapConnection(yard.id, {
      name: frontline.name,
      mapId: frontline.id,
      distance: 10,
      isFrontier: true,
    });

    return { yard, interior, frontline };
  }

  /**
   * 重命名家园的三张动态地图并同步所有地图入口。
   * 对应原版 _主程序.ecode L2333-2417：改家园名称时同时修改院子、屋内、前线，
   * 并把其他地图中指向旧院子的入口改为新名称。
   */
  async renameHouseMaps(oldName: string, newName: string): Promise<void> {
    if (!oldName || !newName || oldName === newName) return;
    const oldNames = [oldName, `${oldName}屋内`, `${oldName}前线`];
    const newNames = [newName, `${newName}屋内`, `${newName}前线`];
    const rows = await this.prisma.gameMap.findMany({ where: { name: { in: oldNames } } });
    const conflicts = await this.prisma.gameMap.findMany({
      where: { name: { in: newNames }, id: { notIn: rows.map((row) => row.id) } },
      select: { name: true },
    });
    if (conflicts.length > 0) {
      throw new Error(`地图名称已存在：${conflicts[0].name}`);
    }

    const renameToken = `__家园改名_${randomUUID()}`;
    for (let i = 0; i < rows.length; i++) {
      await this.prisma.gameMap.update({
        where: { id: rows[i].id },
        data: { name: `${renameToken}${i}` },
      });
    }
    for (let i = 0; i < rows.length; i++) {
      await this.prisma.gameMap.update({
        where: { id: rows[i].id },
        data: { name: newNames[oldNames.indexOf(rows[i].name)] || newNames[i] },
      });
    }

    const allMaps = await this.prisma.gameMap.findMany({
      select: { id: true, connections: true },
    });
    const replacements = new Map(oldNames.map((name, index) => [name, newNames[index]]));
    for (const map of allMaps) {
      const connections = this.safeParseJSON<any[]>(map.connections, []);
      let changed = false;
      for (const connection of connections) {
        const replacement = replacements.get(connection?.name);
        if (replacement) {
          connection.name = replacement;
          changed = true;
        }
      }
      if (changed) {
        await this.prisma.gameMap.update({
          where: { id: map.id },
          data: { connections: JSON.stringify(connections) },
        });
      }
    }
  }

  /** 删除地图中指向指定名称的入口，供家园搬迁移除旧世界地图入口。 */
  async removeMapConnection(mapId: number, targetName: string): Promise<void> {
    await this.withMapLock(mapId, async () => {
      const current = await this.prisma.gameMap.findUnique({ where: { id: mapId } });
      if (!current) return;
      const connections = this.safeParseJSON<any[]>(current.connections, []);
      const filtered = connections.filter((connection: any) => connection?.name !== targetName);
      if (filtered.length !== connections.length) {
        await this.prisma.gameMap.update({
          where: { id: mapId },
          data: { connections: JSON.stringify(filtered) },
        });
      }
    });
  }

  /** 创建/读取不在静态 maps.json 中的运行时地图。 */
  private async ensureDynamicMap(name: string, defaults: Record<string, any>): Promise<any> {
    const existing = await this.prisma.gameMap.findUnique({ where: { name } });
    if (existing) return existing;

    const latest = await this.prisma.gameMap.findFirst({
      orderBy: { mapIndex: 'desc' },
      select: { mapIndex: true },
    });
    const mapIndex = (latest?.mapIndex || 0) + 1;
    const row = await this.prisma.gameMap.create({
      data: {
        name,
        description: defaults.description || '',
        mapIndex,
        level: defaults.level || 1,
        isFrontier: defaults.isFrontier ?? false,
        noTeleport: defaults.noTeleport ?? false,
        noMove: defaults.noMove ?? false,
        isInstance: defaults.isInstance ?? false,
        requiredTravel: defaults.requiredTravel || 0,
        monsters: defaults.monsters || '[]',
        spawnMonsters: defaults.spawnMonsters || '[]',
        tempMonsters: defaults.tempMonsters || '[]',
        summons: defaults.summons || '[]',
        resources: defaults.resources || '[]',
        resources2: defaults.resources2 || '[]',
        connections: defaults.connections || '[]',
        npcs: defaults.npcs || '[]',
        items: defaults.items || '[]',
        buildings: defaults.buildings || '[]',
        vehicles: defaults.vehicles || '[]',
        markers: defaults.markers || '{}',
        markers2: defaults.markers2 || '[]',
        mapBuffs: defaults.mapBuffs || '[]',
        requireMarkers: defaults.requireMarkers || '[]',
        failHint: defaults.failHint || '',
        clearMarkers: defaults.clearMarkers || '',
        music: defaults.music || '',
        monsterCount: defaults.monsterCount || 0,
        noSpecial: defaults.noSpecial ?? true,
      },
    });
    return row;
  }

  /** 按名称追加地图入口，幂等且串行化，避免并发命令覆盖已有连接。 */
  async appendMapConnection(mapId: number, connection: Record<string, any>): Promise<void> {
    await this.withMapLock(mapId, async () => {
      const current = await this.prisma.gameMap.findUnique({ where: { id: mapId } });
      if (!current) return;
      const connections = this.safeParseJSON<any[]>(current.connections, []);
      if (connections.some((item: any) => item?.name === connection.name)) return;
      connections.push(connection);
      await this.prisma.gameMap.update({
        where: { id: mapId },
        data: { connections: JSON.stringify(connections) },
      });
    });
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
    // 0. 新手剧情区放行：医疗室/走廊设为不可传送，但玩家触发「召唤白」剧情后
    //    （打开休眠仓，"锁着的门解开了"）应能沿连接前往走廊/森林出口，推进主线任务。
    //    因此先判断是否命中"召唤白解锁的新手区路径"，命中则直接放行 noTeleport。
    const playerMarkers: Record<string, any> = this.safeParseJSON(player?.markers, {});
    const summonBai = '召唤白' in playerMarkers;
    const isStoryNewbieRoute =
      summonBai &&
      (currentMap.name === '医疗室' && targetMap.name === '走廊') ||
      (currentMap.name === '走廊' && targetMap.name === '森林出口');
    // 解锁后仍可原路返回（双向都放开新手区内部路径）
    const isNewbieInternal =
      (currentMap.name === '走廊' && targetMap.name === '医疗室');
    if ((isStoryNewbieRoute || isNewbieInternal) && summonBai) {
      // 属于新手剧情解锁路径，跳过 noTeleport 限制，进入后续连接判定
    } else {
      // 1. 检查目标地图是否禁止前往（非新手剧情解锁路径）
      if (targetMap.noTeleport) {
        return { canTravel: false, reason: '该地图无法直接前往' };
      }
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
   * 构建怪物最终加成（对应原版 _初始化怪物 加成计算 L2644-3052 的"纯计算"部分）。
   *
   * 原版流程：怪物列表检索 → 生成装备/叠加加成进 g.基础 → 等级成长(L2764-2777)
   * → 法宝/载具/增益/buff/反转童话/套装判断2 → 觉醒分段(L2890-2934)
   * → 一拳/冰雪之心/恶毒之刃/线圈 → 战斗力 → 特殊序号。
   *
   * 本后端 monsters.json 的 bonus 已是"基础属性+武器/装备加成"的综合体（human 录入时已合并），
   * 故跳过"生成装备并叠加"环节，直接对该综合 bonus 应用后续乘数/加数，对齐最终属性效果。
   *
   * @param defBonus 怪物定义 bonus（中文键 JSON，已是综合属性）
   * @param opts 计算参数：等级(level)/觉醒(awaken)/好感(affinity)/击杀(killCount)/
   *             装备名列表(equipments)/特殊序号(specialSeq)/冰雪之心(xuexin)/恶毒之刃(edzhi)
   * @returns 最终加成对象（中文键，与原版 monsters.json bonus 格式一致，供 GameMonster.bonus 直接存储，buildMonsterBonus 会解析）
   */
  private buildMonsterBonusFromDef(defBonus: Record<string, any>, opts: {
    level: number;
    awaken: number;
    affinity?: number;   // 好感（宠物奶量系数，L2822）
    killCount?: number;  // 击杀标记值（L2832）
    equipments?: string[]; // 装备名列表（用于套装判断 L2758/L2820）
    specialSeq?: number; // 怪物特殊序号（套装判断第二参数）
    xuexin?: boolean;    // 冰雪之心增益（L3002）
    edzhi?: boolean;     // 恶毒之刃增益（L3005）
  }): Record<string, any> {
    const level = opts.level || 1;
    const awaken = opts.awaken || 0;
    // 等级成长系数 lvFactor = (1 + 等级×0.05)，原版 _初始化怪物 L2764 起每一条都乘此项
    const lvFactor = 1 + level * 0.05;
    // 觉醒因子：(1 + 觉醒/200)，原版 L2764-2777
    const awakenFactor = 1 + awaken / 200;

    // ===== 套装判断（原版 L2758/L2820 套装判断）=====
    // 维护本地 setData，套装判断写入；一拳/线圈等从 setData 读取（对齐原版 g.套装 字段）
    // 原版：对"玩家/怪物自身特殊序号"与"每件装备名"都各做一次套装判断累加。
    const setData: Record<string, any> = {};
    // 1) 自身特殊序号（怪物/玩家本体套装，如怪物穿动能线圈 specialSeq=123）
    const selfSeq = opts.specialSeq || 0;
    if (selfSeq !== 0) {
      this.combatState.setJudgment(setData, '', selfSeq);
    }
    // 2) 遍历装备名累加套装计数（装备无 specialSeq 时按名称前缀判定）
    const eqNames: string[] = opts.equipments || [];
    for (const eqName of eqNames) {
      this.combatState.setJudgment(setData, eqName, 0);
    }
    // 一拳套装（原版 L2884：套装.一拳==4）
    const onePunch = setData.onePunch || 0;
    // 线圈（原版 L3025：套装.线圈>0）
    const coil = setData.coil || 0;

    // ===== 好感系数 a1（原版 L2822-2830）=====
    // a1 = 1 + (好感[归属] - 100)/1000；<1 则取 1；宝宝标记 ×1.5；×(1+觉醒/200)
    let a1 = 1 + ((opts.affinity || 0) - 100) / 1000;
    if (a1 < 1) a1 = 1;
    // 注：宝宝标记(标记.宝宝==1)在常驻怪物场景为 0，此处不触发（宠物场景由调用方传 opts）
    a1 = a1 * awakenFactor;

    // 工作副本：从 defBonus 深拷贝，后续所有乘数/加数就地修改
    const b: Record<string, any> = { ...defBonus };
    // 把套装判断结果写入 bonus.套装（供战斗/其他逻辑读取，对齐原版 g.套装）
    b.套装 = setData;

    // ===== 击杀标记加成（原版 L2832-2846）=====
    // 觉醒>0 时：陪睡>6 则击杀属性翻倍；基础三池 +b*8，闪避/命中/四伤 +b
    const kill = opts.killCount || 0;
    if (awaken > 0 && kill > 0) {
      let kb = kill;
      if ((b.陪睡 || 0) > 6) kb = kb * 2; // 原版 L2834：所有法宝7级效果击杀翻倍
      b.生命 = (b.生命 || 0) + kb * 8;
      b.护盾 = (b.护盾 || 0) + kb * 8;
      b.装甲 = (b.装甲 || 0) + kb * 8;
      b.闪避 = (b.闪避 || 0) + kb;
      b.命中 = (b.命中 || 0) + kb;
      b.火伤 = (b.火伤 || 0) + kb;
      b.物伤 = (b.物伤 || 0) + kb;
      b.冰伤 = (b.冰伤 || 0) + kb;
      b.电伤 = (b.电伤 || 0) + kb;
    }

    // ===== 等级成长 + 好感系数（原版 L2847-2861，对应"不重新生成"分支的最终乘子）=====
    // 常驻/首次均在 spawn 时一次性计算，使用 lvFactor × a1（a1 已含 awakenFactor）
    const grow = (key: string, hasLevel20: boolean) => {
      const base = b[key] || 0;
      if (hasLevel20) {
        // 生命/护盾/装甲专用：基础 + 等级×20（原版 L2764-2766）
        b[key] = lvFactor * (base + level * 20) * a1;
      } else {
        b[key] = lvFactor * base * a1;
      }
    };
    grow('生命', true);
    grow('护盾', true);
    grow('装甲', true);
    grow('闪避', false);
    grow('命中', false);
    grow('生命回复', false);
    grow('护盾回复', false);
    grow('装甲回复', false);
    grow('暴击伤害', false);
    grow('电伤', false);
    grow('火伤', false);
    grow('物伤', false);
    grow('冰伤', false);
    // 经验（原版 L2861，用 g1.等级 即 level，无 a1）
    b.经验 = Math.floor(lvFactor * (b.经验 || 10));
    // 麻醉（原版 L2780/L2860）：取绝对值 × 成长
    b.麻醉 = Math.floor(lvFactor * Math.abs(b.麻醉 || 0) * a1);

    // ===== 觉醒分段（原版 L2890-2934）=====
    // 觉醒≥100 炼精化气：命中×1.1、闪避×1.1、增加攻击(+20)
    // 觉醒≥200 逆转阴阳：贯穿+10、增加攻击(+50)
    // 觉醒≥400 羽化升仙：三池/闪避/命中/三回复 ×1.5、增加攻击(+50)
    // 注：≥300 天地同辉需载具存活判定（此处无载具，跳过 +20 攻击）；≥500 天神降世仅改名
    if (awaken >= 100) {
      b.命中 = (b.命中 || 0) * 1.1;
      b.闪避 = (b.闪避 || 0) * 1.1;
      this.addMonsterAttackPercent(b, 20);
    }
    if (awaken >= 200) {
      b.贯穿 = (b.贯穿 || 0) + 10;
      this.addMonsterAttackPercent(b, 50);
    }
    if (awaken >= 400) {
      b.生命 = (b.生命 || 0) * 1.5;
      b.护盾 = (b.护盾 || 0) * 1.5;
      b.装甲 = (b.装甲 || 0) * 1.5;
      b.闪避 = (b.闪避 || 0) * 1.5;
      b.命中 = (b.命中 || 0) * 1.5;
      b.生命回复 = (b.生命回复 || 0) * 1.5;
      b.护盾回复 = (b.护盾回复 || 0) * 1.5;
      b.装甲回复 = (b.装甲回复 || 0) * 1.5;
      this.addMonsterAttackPercent(b, 50);
    }

    // ===== 一拳套装（原版 L2884-2889）：套装.一拳==4 → 增加攻击力(+25%) =====
    // 原版「增加攻击 (玩家, , 25)」第二参数为空 → 百分比加玩家.攻击（攻击力），非四属性伤害
    if (onePunch === 4) {
      b.攻击 = (b.攻击 || 0) * 1.25;
      // 原版还有 武器[a].锁定+5，这里武器锁定由战斗系统处理，跳过
    }

    // ===== 冰雪之心增益（原版 L3002-3003）：闪避×0.75 =====
    if (opts.xuexin) {
      b.闪避 = (b.闪避 || 0) * 0.75;
    }

    // ===== 恶毒之刃增益（原版 L3005判定后 L3005-3011）：三回复全 /2 =====
    if (opts.edzhi) {
      b.生命回复 = (b.生命回复 || 0) / 2;
      b.装甲回复 = (b.装甲回复 || 0) / 2;
      b.护盾回复 = (b.护盾回复 || 0) / 2;
      b.生命回复2 = (b.生命回复2 || 0) / 2;
      b.装甲回复2 = (b.装甲回复2 || 0) / 2;
      b.护盾回复2 = (b.护盾回复2 || 0) / 2;
    }

    // ===== 线圈（原版 L3025-3030）：套装.线圈>0 → 四伤均 /2 =====
    // 原版笔误：冰伤 = 火伤/2（交叉赋值），按原版保留
    if (coil > 0) {
      b.物伤 = (b.物伤 || 0) / 2;
      b.火伤 = (b.火伤 || 0) / 2;
      b.电伤 = (b.电伤 || 0) / 2;
      b.冰伤 = (b.火伤 || 0) / 2; // 原版 L3029：冰伤=火伤/2（疑似笔误，按原版保留）
    }

    return b as Record<string, any>;
  }

  /**
   * 怪物"增加攻击(百分比)"（对应原版 增加攻击(玩家,,百分比) L1394-1405）。
   * 与原版一致：按百分比提升四属性伤害（物/火/冰/电伤）。
   * 注意：怪物无 attackBonus 字段体系，这里直接对四伤做百分比乘法。
   */
  private addMonsterAttackPercent(b: Record<string, any>, pct: number): void {
    if (!pct) return;
    const mult = 1 + pct / 100;
    b.物伤 = (b.物伤 || 0) * mult;
    b.火伤 = (b.火伤 || 0) * mult;
    b.冰伤 = (b.冰伤 || 0) * mult;
    b.电伤 = (b.电伤 || 0) * mult;
  }

  /**
   * 刷新地图怪物（常驻怪物）
   * 对应原版 地图操作.ecode 怪物刷新 / _初始化怪物（加成计算 L2644-2777）。
   * 实现：
   *  - 先清空本地图所有「常驻(isTemp=false)」怪物实例（原版整批重刷语义）；
   *  - 按 maps.json 的 monsters 模板名 + map.monsterCount 重新生成并写入 GameMonster 表。
   *  - 模板 + 等级成长公式对齐原版 L2764-2777（生命/护盾/装甲 额外 +等级×20，其余仅 ×lvFactor×awakenFactor）。
   * 临时怪物(isTemp=true，嗅探/事件/召唤产物)不参与整批重刷，保留至被击杀或逻辑移除。
   */
  async refreshMapMonsters(mapId: number): Promise<void> {
    // 获取静态定义（用于 monsters 模板和 monsterCount）
    const map = await this.getMapById(mapId);
    if (!map) {
      throw new NotFoundException(`地图 ID=${mapId} 不存在，无法刷新怪物`);
    }

    // 读取地图固定怪物列表作为模板（存的是怪物名数组），结合 monsterCount 生成实际怪物实例
    const monsterNames: string[] = this.safeParseJSON(map.monsters, []);
    // 原版“刷新地图”仅在地图配置了怪物模板时生成怪物；空模板不能退化成野怪。
    const count = monsterNames.length > 0 ? Math.min(map.monsterCount || 3, 20) : 0;

    // 预加载地图上所有怪物名对应的怪物定义（含三层池 护盾/装甲），来自静态配置 JSON
    const monsterDefs: Record<string, any> = {};
    if (monsterNames.length > 0) {
      const allDefs = this.staticData.getAllMonsters();
      for (const name of monsterNames) {
        const def = allDefs.find((d) => d?.name === name);
        if (def) monsterDefs[name] = def;
      }
    }

    // 构建待插入的常驻怪物实例数据
    const inserts: any[] = [];
    for (let i = 0; i < count; i++) {
      if (monsterNames.length > 0) {
        const name = monsterNames[Math.floor(Math.random() * monsterNames.length)];
        const def = monsterDefs[name];
        const shield = def?.shield || 0;
        const armor = def?.armor || 0;
        const defBonus = def?.bonus ? this.safeParseJSON<any>(def.bonus, {}) : {};
        // 怪物等级：定义等级（若为0则用地图等级），用于 _初始化怪物 等级成长
        const level = def?.level || map.level || 1;
        // 觉醒：怪物定义 bonus.觉醒（原版 L2763 取成就熟练度(标记,"觉醒")，怪物默认0）
        const awaken = defBonus.觉醒 || 0;

        // === 整合 _初始化怪物 深层计算（加成计算 L2644-3052）===
        // 对综合 bonus 应用等级成长 + 好感 + 击杀 + 觉醒档 + 一拳/冰雪之心/恶毒之刃/线圈
        // 返回最终 bonus（含成长后的 生命/护盾/装甲/闪避/命中/四伤 等）
        const eqList: string[] = defBonus.equipmentList
          ? (Array.isArray(defBonus.equipmentList) ? defBonus.equipmentList : [defBonus.equipmentList])
          : (defBonus.装备 ? [defBonus.装备].filter(Boolean) : []);
        const finalBonus = this.buildMonsterBonusFromDef(defBonus, {
          level,
          awaken,
          affinity: 0,
          killCount: 0,
          equipments: eqList,
          specialSeq: def?.specialSeq || -1,
          xuexin: false,
          edzhi: false,
        });
        // 三层池基础值取自最终 bonus（已含成长+好感系数）
        const baseHp = def?.hp || (finalBonus.生命 || 100);
        const baseShield = finalBonus.护盾 !== undefined ? finalBonus.护盾 : (shield || 0);
        const baseArmor = finalBonus.装甲 !== undefined ? finalBonus.装甲 : (armor || 0);
        // 等级成长系数 lvFactor（三层池额外 +等级×20；原版 L2764-2766）
        const lvFactor = 1 + level * 0.05;
        const awakenFactor = 1 + awaken / 200;
        const hpVal = Math.floor(lvFactor * (baseHp + level * 20) * awakenFactor);
        const shieldVal = Math.floor(lvFactor * (baseShield + level * 20) * awakenFactor);
        const armorVal = Math.floor(lvFactor * (baseArmor + level * 20) * awakenFactor);
        // 其余属性（L2767-2777）：仅 ×lvFactor×awakenFactor
        const dodgeVal = Math.floor(lvFactor * (def?.dodge || finalBonus.闪避 || 5) * awakenFactor);
        const hitVal = Math.floor(lvFactor * (def?.hit || finalBonus.命中 || 85) * awakenFactor);
        // 攻击：优先用 finalBonus.攻击（已含一拳等套装加攻），否则用 def.attack 基础值
        const atkVal = Math.floor(lvFactor * (finalBonus.攻击 || def?.attack || 10) * awakenFactor);
        const speedVal = Math.floor(lvFactor * (def?.speed || 100) * awakenFactor);
        const expVal = Math.floor(lvFactor * (finalBonus.经验 || 10) * awakenFactor);
        inserts.push({
          mapId,
          type: def?.type || '怪物',
          name: def?.name || name || '未知怪物',
          // 唯一标识：原版为"怪物"+生成编号()，这里用"monster_"+mapId+序号+UUID 保证唯一且可读
          qq: `monster_${mapId}_${i}_${randomUUID()}`,
          specialSeq: def?.specialSeq || -1,
          level,
          image: def?.image || '',
          hp: hpVal,
          maxHp: hpVal,
          shield: shieldVal,
          maxShield: shieldVal,
          armor: armorVal,
          maxArmor: armorVal,
          attack: atkVal,
          defense: def?.defense || 0,
          speed: speedVal,
          dodge: dodgeVal,
          hit: hitVal,
          isElite: def?.type === '精英' || false,
          // 最终加成（含等级成长/觉醒/套装等，对应原版 玩家.加成）
          bonus: JSON.stringify(finalBonus),
          baseBonus: JSON.stringify(finalBonus),
          extraBonus: '{}',
          // 装备列表：用上方已按空格正确拆分的 eqList（原版 bonus.装备 形如"射爆核心 超载核心 袖剑"）
          equipments: JSON.stringify(eqList.length ? eqList : []),
          weapons: defBonus.武器 ? JSON.stringify(String(defBonus.武器).split(/\s+/).filter(Boolean)) : '[]',
          currentWeapon: 0,
          equipmentPresets: '[]',
          markers: '[]',
          markers2: '[]',
          buffs: '[]',
          achievements: '[]',
          // 套装判定结果来自 buildMonsterBonusFromDef 计算的 finalBonus.套装（对齐原版 g.套装）
          set: JSON.stringify(finalBonus.套装 || {}),
          affinity: 0,
          vitality: 0,
          exp: expVal,
          backpack: '[]',
          isPet: false,
          isTemp: false,
        });
      } else {
        const level = map.level || 1;
        // 对齐原版 _初始化怪物 L2764-2777 等级成长公式（野怪：基础生命100/护盾0/装甲0/攻击10/闪避5/命中85/经验10）
        const lvFactor = 1 + level * 0.05;
        // 野怪综合 bonus：空 defBonus 经 buildMonsterBonusFromDef 得到默认成长属性（生命/闪避/命中等默认值）
        const wildBonus = this.buildMonsterBonusFromDef({}, { level, awaken: 0 });
        const hpVal = Math.floor(lvFactor * (100 + level * 20));
        const atkVal = Math.floor(lvFactor * 10);
        const speedVal = Math.floor(lvFactor * 100);
        const dodgeVal = Math.floor(lvFactor * (wildBonus.闪避 || 5));
        const hitVal = Math.floor(lvFactor * (wildBonus.命中 || 85));
        const expVal = Math.floor(lvFactor * (wildBonus.经验 || 10));
        inserts.push({
          mapId,
          type: '野怪',
          name: '野怪',
          qq: `monster_${mapId}_${i}_${randomUUID()}`,
          specialSeq: -1,
          level,
          hp: hpVal,
          maxHp: hpVal,
          shield: 0,
          maxShield: 0,
          armor: 0,
          maxArmor: 0,
          attack: atkVal,
          defense: 0,
          speed: speedVal,
          dodge: dodgeVal,
          hit: hitVal,
          isElite: false,
          bonus: JSON.stringify(wildBonus),
          baseBonus: JSON.stringify(wildBonus),
          extraBonus: '{}',
          equipments: '[]',
          weapons: '[]',
          currentWeapon: 0,
          equipmentPresets: '[]',
          markers: '[]',
          markers2: '[]',
          buffs: '[]',
          achievements: '[]',
          set: '{}',
          affinity: 0,
          vitality: 0,
          exp: expVal,
          backpack: '[]',
          isPet: false,
          isTemp: false,
        });
      }
    }

    // 整批重刷：加锁删除本地图常驻怪物，再批量插入（保留临时怪物 isTemp=true）
    await this.withMapLock(mapId, async () => {
      await this.prisma.gameMonster.deleteMany({
        where: { mapId, isTemp: false },
      });
      if (inserts.length > 0) {
        await this.prisma.gameMonster.createMany({ data: inserts });
      }
    });

    this.logger.log(`地图 ${map.name} 刷新了 ${inserts.length} 只常驻怪物`);
  }

  /**
   * 按指定类型生成一只运行时怪物。
   *
   * 对应原版 _主程序.ecode L2087-2160 中反复设置“玩家2.类型”后调用
   * `_初始化怪物` 并加入 `地图.怪物2`。前线波次不能使用常驻刷新，因为每只
   * 怪物的类型和等级由前线熟练度决定，故单独写入 GameMonster。
   */
  private async buildMonsterSpawnData(
    mapId: number,
    name: string,
    options: { level?: number; isTemp?: boolean; ownerQQ?: string; qq?: string } = {},
  ): Promise<Record<string, any>> {
    const map = await this.getMapById(mapId);
    if (!map) throw new NotFoundException(`地图 ID=${mapId} 不存在，无法生成怪物`);

    const def = this.staticData.getAllMonsters().find((item: any) => item?.name === name);
    if (!def) throw new NotFoundException(`怪物「${name}」不存在`);

    const defBonus = def.bonus ? this.safeParseJSON<Record<string, any>>(def.bonus, {}) : {};
    const level = options.level ?? def.level ?? map.level ?? 1;
    const awaken = Number(defBonus.觉醒 || 0);
    const equipmentList: string[] = Array.isArray(defBonus.equipmentList)
      ? defBonus.equipmentList
      : (defBonus.装备 ? String(defBonus.装备).split(/\s+/).filter(Boolean) : []);
    const finalBonus = this.buildMonsterBonusFromDef(defBonus, {
      level,
      awaken,
      affinity: 0,
      killCount: 0,
      equipments: equipmentList,
      specialSeq: def.specialSeq || -1,
      xuexin: false,
      edzhi: false,
    });

    const lvFactor = 1 + level * 0.05;
    const awakenFactor = 1 + awaken / 200;
    const baseHp = def.hp || finalBonus.生命 || 100;
    const baseShield = finalBonus.护盾 !== undefined ? finalBonus.护盾 : (def.shield || 0);
    const baseArmor = finalBonus.装甲 !== undefined ? finalBonus.装甲 : (def.armor || 0);
    const hp = Math.floor(lvFactor * (baseHp + level * 20) * awakenFactor);
    const shield = Math.floor(lvFactor * (baseShield + level * 20) * awakenFactor);
    const armor = Math.floor(lvFactor * (baseArmor + level * 20) * awakenFactor);
    return {
      mapId,
      type: def.type || '怪物',
      name: def.name,
      qq: options.qq || `monster_${mapId}_${randomUUID()}`,
      specialSeq: def.specialSeq || -1,
      ownerQQ: options.ownerQQ || '',
      level,
      image: def.image || '',
      hp,
      maxHp: hp,
      shield,
      maxShield: shield,
      armor,
      maxArmor: armor,
      attack: Math.floor(lvFactor * (finalBonus.攻击 || def.attack || 10) * awakenFactor),
      defense: def.defense || 0,
      speed: Math.floor(lvFactor * (def.speed || 100) * awakenFactor),
      dodge: Math.floor(lvFactor * (def.dodge || finalBonus.闪避 || 5) * awakenFactor),
      hit: Math.floor(lvFactor * (def.hit || finalBonus.命中 || 85) * awakenFactor),
      isElite: def.type === '精英',
      bonus: JSON.stringify(finalBonus),
      baseBonus: JSON.stringify(finalBonus),
      extraBonus: '{}',
      equipments: JSON.stringify(equipmentList),
      weapons: defBonus.武器 ? JSON.stringify(String(defBonus.武器).split(/\s+/).filter(Boolean)) : '[]',
      currentWeapon: 0,
      equipmentPresets: '[]',
      markers: '{}',
      markers2: '[]',
      buffs: '[]',
      achievements: '[]',
      set: JSON.stringify(finalBonus.套装 || {}),
      affinity: 0,
      vitality: 0,
      exp: Math.floor(lvFactor * (finalBonus.经验 || 10) * awakenFactor),
      backpack: '[]',
      isPet: false,
      isTemp: options.isTemp ?? true,
    };
  }

  async spawnMonsterByName(
    mapId: number,
    name: string,
    options: { level?: number; isTemp?: boolean; ownerQQ?: string; qq?: string } = {},
  ): Promise<MapMonster> {
    const data = await this.buildMonsterSpawnData(mapId, name, options);
    const row = await this.prisma.gameMonster.create({
      data,
    });
    return row as unknown as MapMonster;
  }

  /**
   * 构造地图召唤物实例。与 GameMonster 使用同一套静态怪物初始化，
   * 但返回 JSON 召唤物对象，由调用方在地图锁内写回 map.summons。
   */
  async createMapSummonByName(
    mapId: number,
    name: string,
    options: { level?: number; ownerQQ?: string; qq?: string } = {},
  ): Promise<any> {
    return this.buildMonsterSpawnData(mapId, name, { ...options, isTemp: true });
  }

  /**
   * 获取地图上的怪物列表（来自 GameMonster 表）
   * 兼容旧调用方传 map 对象或 mapId。返回常驻+临时怪物实例（含完整 玩家 结构体字段）。
   * @param mapOrId 地图对象（含 id）或地图ID
   */
  async getMapMonsters(mapOrId: any): Promise<MapMonster[]> {
    const mapId = typeof mapOrId === 'number' ? mapOrId : mapOrId?.id;
    if (mapId === undefined || mapId === null) return [];
    return (await this.prisma.gameMonster.findMany({
      where: { mapId },
      orderBy: { id: 'asc' },
    })) as unknown as MapMonster[];
  }

  /**
   * 获取地图上存活的怪物列表（hp>0）
   */
  async getAliveMapMonsters(mapOrId: any): Promise<MapMonster[]> {
    const all = await this.getMapMonsters(mapOrId);
    return all.filter((m: any) => (m.hp || 0) > 0);
  }

  /**
   * 按ID获取单个怪物实例
   */
  async getGameMonsterById(id: number): Promise<MapMonster | null> {
    const m = await this.prisma.gameMonster.findUnique({ where: { id } });
    return (m as unknown as MapMonster) || null;
  }

  /**
   * 移除地图上的怪物（死亡后）
   * 从 GameMonster 表删除指定记录（兼容旧调用方的字符串/数字 id）。
   * @param mapOrId 地图对象或ID（保留以兼容旧签名，实际按 monsterId 删除）
   * @param monsterId 怪物自增ID 或 qq 字符串
   */
  async removeMapMonster(mapOrId: any, monsterId: number | string): Promise<void> {
    try {
      if (typeof monsterId === 'number') {
        await this.prisma.gameMonster.delete({ where: { id: monsterId } });
      } else {
        // 旧调用方可能传 qq 字符串（如 "monster_xxx"）
        await this.prisma.gameMonster.deleteMany({ where: { qq: String(monsterId) } });
      }
    } catch (e: any) {
      this.logger.warn(`移除怪物 ${monsterId} 失败（可能已不存在）: ${e?.message}`);
    }
  }

  /**
   * 写回怪物三层池血量（加锁，消除并发丢失更新）
   * 对应原版单线程内存模型下对 地图.怪物2[x].当前生命/护盾/装甲 的直接写回。
   */
  async updateMonsterFields(mapId: number, monsterId: number, data: {
    hp?: number; shield?: number; armor?: number; buffs?: string; bonus?: string;
    markers?: string; markers2?: string;
  }): Promise<void> {
    await this.withMapLock(mapId, async () => {
      const update: any = {};
      if (data.hp !== undefined) update.hp = data.hp;
      if (data.shield !== undefined) update.shield = data.shield;
      if (data.armor !== undefined) update.armor = data.armor;
      if (data.buffs !== undefined) update.buffs = data.buffs;
      if (data.bonus !== undefined) update.bonus = data.bonus;
      if (data.markers !== undefined) update.markers = data.markers;
      if (data.markers2 !== undefined) update.markers2 = data.markers2;
      if (Object.keys(update).length === 0) return;
      await this.prisma.gameMonster.update({ where: { id: monsterId }, data: update });
    });
  }

  /**
   * 保存完整怪物实例（用于使魔技能修改 buffs/bonus 等整行写回）
   */
  async saveGameMonster(monster: MapMonster): Promise<void> {
    const { id, ...rest } = monster as any;
    await this.prisma.gameMonster.update({ where: { id }, data: rest });
  }

  /**
   * 添加临时怪物（嗅探/事件/召唤产物，isTemp=true）
   * 返回新建记录的完整行（含自增 id，供后续读写）。
   */
  async addTempMonster(mapId: number, data: Partial<MapMonster> & { name: string }): Promise<MapMonster> {
    const row = await this.prisma.gameMonster.create({
      data: {
        mapId,
        type: data.type || '怪物',
        name: data.name,
        qq: data.qq || `temp_${mapId}_${randomUUID()}`,
        specialSeq: data.specialSeq ?? -1,
        ownerQQ: data.ownerQQ || '',
        level: data.level ?? 1,
        image: data.image || '',
        hp: data.hp ?? 100,
        maxHp: data.maxHp ?? (data.hp ?? 100),
        shield: data.shield ?? 0,
        maxShield: data.maxShield ?? (data.shield ?? 0),
        armor: data.armor ?? 0,
        maxArmor: data.maxArmor ?? (data.armor ?? 0),
        attack: data.attack ?? 0,
        defense: data.defense ?? 0,
        speed: data.speed ?? 100,
        dodge: data.dodge ?? 0,
        hit: data.hit ?? 85,
        isElite: data.isElite ?? false,
        bonus: data.bonus || '{}',
        baseBonus: data.baseBonus || (data.bonus || '{}'),
        extraBonus: data.extraBonus || '{}',
        equipments: data.equipments || '[]',
        weapons: data.weapons || '[]',
        currentWeapon: data.currentWeapon ?? 0,
        equipmentPresets: data.equipmentPresets || '[]',
        markers: data.markers || '[]',
        markers2: data.markers2 || '[]',
        buffs: data.buffs || '[]',
        achievements: data.achievements || '[]',
        set: data.set || '{}',
        affinity: data.affinity ?? 0,
        vitality: data.vitality ?? 0,
        exp: data.exp ?? 0,
        backpack: data.backpack || '[]',
        isPet: data.isPet ?? false,
        isTemp: true,
      },
    });
    return row as unknown as MapMonster;
  }

  /**
   * 清空地图上全部怪物实例（GameMonster 表）
   * 对应原版「清空副本」/「清空地图怪物」语义，直接 deleteMany 本地图所有记录
   * （常驻 + 临时一并清除，随后由刷新/事件逻辑重新生成）。
   */
  async clearMapMonsters(mapId: number): Promise<void> {
    await this.prisma.gameMonster.deleteMany({ where: { mapId } });
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

    // 原版“刷新地图”清空资源2，再按地图资源名称从全局资源列表复制完整定义。
    // 优先读取静态地图配置，避免把运行时采集次数或临时资源当作模板。
    const staticMap = this.staticData.getMapByName(map.name);
    const configuredResources: any[] = this.safeParseJSON(
      staticMap?.resources ?? map.resources,
      [],
    );
    if (configuredResources.length === 0) {
      await this.prisma.gameMap.update({
        where: { id: mapId },
        data: { resources2: '[]' },
      });
      this.logger.log(`地图 ${map.name} 刷新了 0 个可采集资源`);
      return;
    }

    const resourceDefinitions = this.staticData.getAllResources();
    const refreshedResources = configuredResources.map((configured: any) => {
      const name = String(configured?.name ?? configured?.名称 ?? '').trim();
      const definition = resourceDefinitions.find((resource: any) => resource?.name === name);
      // 保留地图配置中可能被事件改写的字段，同时用资源列表补齐原版运行时字段。
      return {
        ...(definition || {}),
        ...configured,
        name,
        type: configured?.type || configured?.类型 || definition?.type || '资源',
        times: configured?.times ?? definition?.times ?? 1,
        outputs: configured?.outputs ?? definition?.outputs ?? [],
        outputs2: configured?.outputs2 ?? definition?.outputs2 ?? [],
        gatherCmd: configured?.gatherCmd ?? definition?.gatherCmd ?? '',
      };
    }).filter((resource: any) => resource.name);

    await this.prisma.gameMap.update({
      where: { id: mapId },
      data: {
        resources: JSON.stringify(refreshedResources),
        resources2: JSON.stringify(refreshedResources),
      },
    });

    this.logger.log(`地图 ${map.name} 刷新了 ${refreshedResources.length} 个可采集资源`);
  }

  /**
   * 只处理原版“刷新资源<名称>”标记，恢复已到期的单个资源。
   * 地图刷新线程不能整批覆盖资源，否则会把尚未耗尽的资源和玩家进度一并重置。
   */
  async refreshExpiredMapResources(mapId: number): Promise<number> {
    return this.withMapLock(mapId, async () => {
      const map = await this.getMapById(mapId);
      if (!map) {
        throw new NotFoundException(`地图 ID=${mapId} 不存在，无法刷新资源`);
      }

      // 兼容存量数据：地图标记2容器必须为数组（历史种子曾误写 '{}'）
      const rawMarkers2 = this.safeParseJSON<any>(map.markers2, []);
      const markers2 = Array.isArray(rawMarkers2) ? rawMarkers2 : [];
      if (markers2.length === 0) return 0;

      const resources = this.safeParseJSON<any[]>(map.resources, []);
      const resources2 = this.safeParseJSON<any[]>(map.resources2, []);
      const now = Date.now();
      const activeMarkers: any[] = [];
      let restored = 0;
      let resourcesChanged = false;
      let resources2Changed = false;

      for (const marker of markers2) {
        const markerName = String(marker?.name ?? marker?.名称 ?? marker?.key ?? '').trim();
        const expireAt = this.normalizeMapMarkerTime(marker?.expireAt ?? marker?.有效期至 ?? marker?.expireTime);
        if (!markerName.startsWith('刷新资源') || !expireAt || expireAt > now) {
          activeMarkers.push(marker);
          continue;
        }

        const resourceName = markerName.slice('刷新资源'.length).trim();
        if (!resourceName) continue;

        const field = marker?.resourceField === 'resources2'
          ? 'resources2'
          : marker?.resourceField === 'resources'
            ? 'resources'
            : (resources.length > 0 || resources2.length === 0 ? 'resources' : 'resources2');
        const targetResources = field === 'resources2' ? resources2 : resources;
        if (targetResources.some((resource: any) =>
          String(resource?.name ?? resource?.名称 ?? '').trim() === resourceName,
        )) {
          continue;
        }

        const template = this.getMapResourceTemplate(map, resourceName);
        if (!template) continue;
        targetResources.push(template);
        restored += 1;
        if (field === 'resources2') resources2Changed = true;
        else resourcesChanged = true;
      }

      const data: Record<string, string> = {
        markers2: JSON.stringify(activeMarkers),
      };
      if (resourcesChanged) data.resources = JSON.stringify(resources);
      if (resources2Changed) data.resources2 = JSON.stringify(resources2);
      await this.prisma.gameMap.update({ where: { id: mapId }, data });
      return restored;
    });
  }

  private normalizeMapMarkerTime(value: any): number {
    const time = Number(value ?? 0);
    if (!Number.isFinite(time) || time <= 0) return 0;
    return time < 1e12 ? time * 1000 : time;
  }

  private getMapResourceTemplate(map: any, resourceName: string): any | null {
    const staticMap = this.staticData.getMapByName(map.name);
    const configuredResources = this.safeParseJSON<any[]>(staticMap?.resources, []);
    const configured = configuredResources.find((resource: any) =>
      String(resource?.name ?? resource?.名称 ?? '').trim() === resourceName,
    );
    const definition = this.staticData.getAllResources().find((resource: any) =>
      String(resource?.name ?? resource?.名称 ?? '').trim() === resourceName,
    );
    if (!configured && !definition) return null;

    const template = {
      ...(definition || {}),
      ...(configured || {}),
      name: resourceName,
      type: configured?.type || configured?.类型 || definition?.type || definition?.类型 || '资源',
      times: configured?.times ?? configured?.次数 ?? definition?.times ?? definition?.次数 ?? 1,
      outputs: configured?.outputs ?? configured?.产出 ?? definition?.outputs ?? definition?.产出 ?? [],
      outputs2: configured?.outputs2 ?? configured?.产出2 ?? definition?.outputs2 ?? definition?.产出2 ?? [],
      gatherCmd: configured?.gatherCmd ?? configured?.采集指令 ?? definition?.gatherCmd ?? definition?.采集指令 ?? '',
    };
    return JSON.parse(JSON.stringify(template));
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
