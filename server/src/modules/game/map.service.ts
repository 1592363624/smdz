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
        // 觉醒因子：原版 _初始化怪物 L2764-2777 用 (1 + 觉醒/200)，怪物默认觉醒=0 → 因子=1
        const awaken = defBonus.觉醒 || 0;
        const awakenFactor = 1 + awaken / 200;
        // 等级成长系数 lvFactor = (1 + 等级×0.05)，原版 _初始化怪物 L2764 起每一条都乘此项
        const lvFactor = 1 + level * 0.05;
        // 三层池血量额外随等级线性增长 +等级×20（原版 L2764-2766：生命/护盾/装甲专用）
        const baseHp = def?.hp || 100;
        const baseShield = defBonus.护盾 !== undefined ? defBonus.护盾 : shield;
        const baseArmor = defBonus.装甲 !== undefined ? defBonus.装甲 : armor;
        const hpVal = Math.floor(lvFactor * (baseHp + level * 20) * awakenFactor);
        const shieldVal = Math.floor(lvFactor * (baseShield + level * 20) * awakenFactor);
        const armorVal = Math.floor(lvFactor * (baseArmor + level * 20) * awakenFactor);
        // 其余属性（L2767-2777）：仅 ×lvFactor×awakenFactor，无 +等级×20 项
        const dodgeVal = Math.floor(lvFactor * (def?.dodge || 5) * awakenFactor);
        const hitVal = Math.floor(lvFactor * (def?.hit || 85) * awakenFactor);
        const atkVal = Math.floor(lvFactor * (def?.attack || 10) * awakenFactor);
        const speedVal = Math.floor(lvFactor * (def?.speed || 100) * awakenFactor);
        const expVal = Math.floor(lvFactor * (defBonus.经验 || 10) * awakenFactor);
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
          // 三层池抗性/伤害/武器/装备/掉落等存于 bonus（对应原版 玩家.加成）
          bonus: def?.bonus || '{}',
          baseBonus: def?.bonus || '{}',
          extraBonus: '{}',
          equipments: defBonus.装备 ? JSON.stringify(defBonus.装备List || [defBonus.装备].filter(Boolean)) : '[]',
          weapons: defBonus.武器 ? JSON.stringify(String(defBonus.武器).split(/\s+/).filter(Boolean)) : '[]',
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
      } else {
        const level = map.level || 1;
        // 对齐原版 _初始化怪物 L2764-2777 等级成长公式（野怪：基础生命100/护盾0/装甲0/攻击10/闪避5/命中85/经验10）
        const lvFactor = 1 + level * 0.05;
        const hpVal = Math.floor(lvFactor * (100 + level * 20));
        const atkVal = Math.floor(lvFactor * 10);
        const speedVal = Math.floor(lvFactor * 100);
        const dodgeVal = Math.floor(lvFactor * 5);
        const hitVal = Math.floor(lvFactor * 85);
        const expVal = Math.floor(lvFactor * 10);
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
          bonus: '{}',
          baseBonus: '{}',
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
    hp?: number; shield?: number; armor?: number; buffs?: string; bonus?: string; markers2?: string;
  }): Promise<void> {
    await this.withMapLock(mapId, async () => {
      const update: any = {};
      if (data.hp !== undefined) update.hp = data.hp;
      if (data.shield !== undefined) update.shield = data.shield;
      if (data.armor !== undefined) update.armor = data.armor;
      if (data.buffs !== undefined) update.buffs = data.buffs;
      if (data.bonus !== undefined) update.bonus = data.bonus;
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