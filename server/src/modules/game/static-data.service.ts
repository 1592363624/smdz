/**
 * 静态数据服务（StaticDataService）
 * ------------------------------------------------------------------
 * 架构改革核心：将"系统配置型固定不变数据"从数据库表中彻底移除，
 * 改为运行时直接读取 server/prisma/data/*.json（单一数据源 single source of truth）。
 *
 * 设计说明：
 * - 数据来源：prisma/data/*.json，由 convert-e-to-json.ts 从易语言配置离线转换而来，
 *   进版本控制、随部署分发。策划改数值直接编辑 JSON 后重启/重载即可生效，无需动数据库。
 * - 加载策略：首次访问时懒加载对应 JSON 到内存，之后走 Map 缓存（O(1) 查询），
 *   避免每次请求都读磁盘。可通过 refresh() 手动重载（热更新，不重启进程）。
 * - 与"动态数据"的分界：本服务只承载固定配置；玩家/频道/聊天/指令日志/地图实时
 *   刷怪状态等动态数据仍走 MySQL（Prisma）。
 *
 * 对应关系（JSON 文件 -> 原数据库表）：
 *   monsters.json  -> GameMonster       items.json     -> GameItem
 *   equipments.json-> GameEquipment     familiars.json -> GameFamiliar
 *   craftings.json -> GameCrafting      tasks.json     -> GameTask
 *   titles.json    -> GameTitle         buildings.json -> GameBuilding
 *   npcs.json      -> GameNpc           vehicles.json  -> GameVehiclePart(定义部分)
 *   blueprints.json-> GameBlueprint     buffs.json     -> GameBuff
 *   shops.json     -> GameShop          resources.json -> GameResource
 *   effects.json   -> GameEffect        attack-texts.json -> GameAttackText
 *   set-effects.json-> GameSetEffect    flavor-texts.json-> GameFlavorText
 *   update-logs.json-> GameUpdateLog
 *   vehicle-recipes.json -> 原版载具生产配方（无配置时保持空数组）
 */

import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/** JSON 数据目录（相对本文件） */
const DATA_DIR = path.resolve(__dirname, '../../../prisma/data');

/** 每种 JSON 对应的文件路径 */
const DATA_FILES = {
  monsters: 'monsters.json',
  items: 'items.json',
  equipments: 'equipments.json',
  familiars: 'familiars.json',
  craftings: 'craftings.json',
  tasks: 'tasks.json',
  titles: 'titles.json',
  buildings: 'buildings.json',
  npcs: 'npcs.json',
  vehicles: 'vehicles.json',
  blueprints: 'blueprints.json',
  buffs: 'buffs.json',
  shops: 'shops.json',
  resources: 'resources.json',
  effects: 'effects.json',
  attackTexts: 'attack-texts.json',
  setEffects: 'set-effects.json',
  flavorTexts: 'flavor-texts.json',
  updateLogs: 'update-logs.json',
  vehiclesParts: 'vehicles.json',
  vehicleParts: 'vehicle-parts.json',
  merchant: 'merchant.json',
  seedItems: 'seed-items.json',
  maps: 'maps.json',
  vehicleRecipes: 'vehicle-recipes.json',
} as const;

type DataKey = keyof typeof DATA_FILES;

@Injectable()
export class StaticDataService {
  private readonly logger = new Logger(StaticDataService.name);

  /** 缓存：dataKey -> 原始数组 */
  private cache: Partial<Record<DataKey, any[]>> = {};

  /**
   * 读取某类 JSON 原始数组（懒加载 + 缓存）
   * @param key 数据类别
   * @returns 固定配置数组；文件缺失或解析失败返回 []
   */
  loadRaw<T = any>(key: DataKey): T[] {
    if (this.cache[key]) return this.cache[key] as T[];
    const file = path.join(DATA_DIR, DATA_FILES[key]);
    let rows: T[] = [];
    if (fs.existsSync(file)) {
      try {
        rows = JSON.parse(fs.readFileSync(file, 'utf-8')) as T[];
      } catch (err: any) {
        this.logger.warn(`静态数据 ${DATA_FILES[key]} 解析失败: ${err.message}`);
        rows = [];
      }
    } else {
      this.logger.warn(`静态数据文件缺失: ${DATA_FILES[key]}`);
    }
    this.cache[key] = rows as any[];
    return rows;
  }

  /** 强制重载所有已加载的静态数据（热更新，不重启进程） */
  refresh(): void {
    this.cache = {};
    this.logger.log('静态数据缓存已清空（下次访问将重新从 JSON 加载）');
  }

  // ============ 通用查询 ============

  /** 按唯一键(name)查一条 */
  private findByKey<T extends { name?: string }>(key: DataKey, name: string): T | undefined {
    return this.loadRaw<T>(key).find((r) => r?.name === name);
  }

  /** 按整型序号查一条 */
  private findBySeq<T extends { specialSeq?: number }>(key: DataKey, seq: number): T | undefined {
    return this.loadRaw<T>(key).find((r) => r?.specialSeq === seq);
  }

  // ============ 怪物 ============

  getMonsterByName(name: string): any {
    return this.findByKey('monsters', name);
  }

  /** 怪物/宠物按特殊序号（负数=怪物/宠物，非负=使魔） */
  getMonsterBySeq(seq: number): any {
    return this.findBySeq('monsters', seq);
  }

  getAllMonsters(): any[] {
    return this.loadRaw('monsters');
  }

  // ============ 物品 ============

  getItemByName(name: string): any {
    return this.findByKey('items', name);
  }

  getAllItems(): any[] {
    return this.loadRaw('items');
  }

  // ============ 装备/武器 ============

  getEquipmentByName(name: string): any {
    return this.findByKey('equipments', name);
  }

  getAllEquipments(): any[] {
    return this.loadRaw('equipments');
  }

  /** 按装备部位/武器类型过滤（equipType 以"武器"结尾为武器） */
  getEquipmentsByType(type: string): any[] {
    return this.loadRaw('equipments').filter((e) => e?.equipType === type);
  }

  /** 是否武器（equipType 以"武器"结尾，如 射弹武器/能量武器/近战武器） */
  isWeapon(e: any): boolean {
    return typeof e?.equipType === 'string' && e.equipType.endsWith('武器');
  }

  getAllWeapons(): any[] {
    return this.loadRaw('equipments').filter((e) => this.isWeapon(e));
  }

  getAllNonWeapons(): any[] {
    return this.loadRaw('equipments').filter((e) => !this.isWeapon(e));
  }

  // ============ 使魔 ============

  getFamiliarByName(name: string): any {
    return this.findByKey('familiars', name);
  }

  getFamiliarBySeq(seq: number): any {
    return this.findBySeq('familiars', seq);
  }

  getAllFamiliars(): any[] {
    return this.loadRaw('familiars');
  }

  // ============ 制造配方 ============

  getCraftingByName(name: string): any {
    return this.findByKey('craftings', name);
  }

  getAllCraftings(): any[] {
    return this.loadRaw('craftings');
  }

  // ============ 任务 ============

  getTaskByName(name: string): any {
    return this.findByKey('tasks', name);
  }

  getAllTasks(): any[] {
    return this.loadRaw('tasks');
  }

  // ============ 称号 ============

  getTitleByName(name: string): any {
    return this.findByKey('titles', name);
  }

  getAllTitles(): any[] {
    return this.loadRaw('titles');
  }

  // ============ 建筑 ============

  getAllBuildings(): any[] {
    return this.loadRaw('buildings');
  }

  getBuildingByName(name: string): any {
    return this.findByKey('buildings', name);
  }

  // ============ NPC ============

  getNpcByName(name: string): any {
    return this.findByKey('npcs', name);
  }

  // ============ 载具/载具部件定义 ============
  // 说明：vehicles.json 存的是载具/部件模板（type 为 核心/防御/行走/武器/功能 等部件类型），
  // 运行时 GameVehicle 表承载玩家载具实例（动态），此处只提供模板查询。

  getVehiclePartByName(name: string): any {
    return this.findByKey('vehicles', name);
  }

  getAllVehicleParts(): any[] {
    return this.loadRaw('vehicles');
  }

  getAllVehicles(): any[] {
    return this.loadRaw('vehicles');
  }

  // ============ 载具生产配方 ============

  /** 原版「取配方」使用的载具生产配方；与普通制造配方分开。 */
  getVehicleRecipeByName(name: string): any {
    return this.findByKey('vehicleRecipes', name);
  }

  getAllVehicleRecipes(): any[] {
    return this.loadRaw('vehicleRecipes');
  }

  // ============ 原版 部件列表 规格表（vehicle-parts.json） ============
  // 说明：原版 计算载具 / 叠加载具加成 依赖全局「部件列表」（含 加成.攻击/上限/行走/防御/
  // 武器/功能/类型/限制2/内置零件/生产 等数值字段）。数据由 e/源码解析成为txt/使魔大战.txt
  // 中 类型=载具 的节经 数据存取.ecode L603-647 提取生成（见 convert 脚本思路）。
  // 与 vehicles.json（载具实例模板）区分：此处是部件规格定义。

  /** 按名称查部件规格（对应原版 取部件列表[b].名称 == X 的循环查找） */
  getVehiclePartSpecByName(name: string): any {
    return this.findByKey('vehicleParts', name);
  }

  /** 取全部部件规格（对应原版 部件列表 全局数组） */
  getAllVehiclePartSpecs(): any[] {
    return this.loadRaw('vehicleParts');
  }

  /** 原版 @Global 行商物品/行商装备池，保留重复项以保持随机权重。 */
  getMerchantConfig(): { equipmentText: string; itemText: string } {
    // 商店配置是 e/使魔大战.txt 的 SSOT；优先读取其解析结果。
    const shop = this.loadRaw<any>('shops')[0];
    const parse = (value: any): any[] => {
      if (Array.isArray(value)) return value;
      if (typeof value !== 'string') return [];
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    const equipment = parse(shop?.travelingEquip);
    const items = parse(shop?.travelingItem);
    if (equipment.length || items.length) {
      return {
        equipmentText: equipment.map((item) => item?.name || item?.名称 || '').filter(Boolean).join('，'),
        itemText: items
          .map((item) => `${item?.name || item?.名称 || ''}${item?.count ?? item?.数量 ?? 1}`)
          .filter(Boolean)
          .join('，'),
      };
    }

    // 兼容只携带旧版 merchant.json 的部署包。
    const merchant = this.loadRaw<any>('merchant')[0];
    return merchant || { equipmentText: '', itemText: '' };
  }

  /**
   * 原版 @Constant「种子等」的展开结果。
   * 该文件由易语言长文本配置离线提取，数组顺序和重复项都是随机权重的一部分。
   */
  getMerchantExtraItems(): string[] {
    const file = path.join(DATA_DIR, DATA_FILES.seedItems);
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Array.isArray(parsed) ? parsed.map(String) : (Array.isArray(parsed?.items) ? parsed.items.map(String) : []);
    } catch (err: any) {
      this.logger.warn(`静态数据 ${DATA_FILES.seedItems} 解析失败: ${err.message}`);
      return [];
    }
  }

  /**
   * 读取原版 [商店] 的三个兑换子商店。
   * 数据存取.ecode L805-824 按顺序填充活跃度、钻石、数据商店；
   * 返回值保留配置顺序，兑换时必须先查活跃度再查钻石、数据核心。
   */
  getShopConfig(): {
    activity: Array<{ name: string; count: number }>;
    diamond: Array<{ name: string; count: number }>;
    dataCore: Array<{ name: string; count: number }>;
  } {
    const row = this.loadRaw<any>('shops')[0] || {};
    const parse = (value: any): Array<{ name: string; count: number }> => {
      if (Array.isArray(value)) return value;
      if (typeof value !== 'string') return [];
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    const normalize = (value: any): Array<{ name: string; count: number }> => parse(value)
      .map((item: any) => ({
        name: String(item?.name ?? item?.名称 ?? '').trim(),
        count: Number(item?.count ?? item?.数量 ?? 0),
      }))
      .filter((item) => item.name && Number.isFinite(item.count));
    return {
      activity: normalize(row.shopActivity),
      diamond: normalize(row.shopDiamond),
      dataCore: normalize(row.shopData),
    };
  }

  // ============ 蓝图 ============

  getBlueprintByName(name: string): any {
    return this.findByKey('blueprints', name);
  }

  getAllBlueprints(): any[] {
    return this.loadRaw('blueprints');
  }

  // ============ 增益/商店/资源/特效/文本等（运行时零读取，供未来扩展） ============

  getBuffByName(name: string): any {
    return this.findByKey('buffs', name);
  }

  getAllBuffs(): any[] {
    return this.loadRaw('buffs');
  }

  getAllShops(): any[] {
    return this.loadRaw('shops');
  }

  getAllResources(): any[] {
    return this.loadRaw('resources');
  }

  getAllEffects(): any[] {
    return this.loadRaw('effects');
  }

  getAllAttackTexts(): any[] {
    return this.loadRaw('attackTexts');
  }

  getAllSetEffects(): any[] {
    return this.loadRaw('setEffects');
  }

  getAllFlavorTexts(): any[] {
    return this.loadRaw('flavorTexts');
  }

  getAllUpdateLogs(): any[] {
    return this.loadRaw('updateLogs');
  }

  // ============ 地图（静态定义，动态状态仍走 DB） ============

  /** 按 ID 获取地图静态定义（maps.json 中 mapIndex 作为 ID） */
  getMapById(mapId: number): any | undefined {
    return this.loadRaw('maps').find((m) => m?.id === mapId || m?.mapIndex === mapId);
  }

  /** 按名称获取地图静态定义 */
  getMapByName(name: string): any | undefined {
    return this.loadRaw('maps').find((m) => m?.name === name);
  }

  /** 获取全部地图静态定义 */
  getAllMaps(): any[] {
    return this.loadRaw('maps');
  }
}
