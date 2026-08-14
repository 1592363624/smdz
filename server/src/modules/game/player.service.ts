/**
 * 玩家服务
 * 对应原版易语言：数据存取.ecode
 * 负责玩家的创建、读取、保存、等级管理、背包操作、标记系统等功能
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BonusData } from './bonus.service';

/**
 * 玩家数据完整解析后的结构
 */
export interface PlayerData {
  player: any;
  backpack: any[];
  equipment: any[];
  weapons: any[];
  markers: any;
  markers2: any[];
  buffs: any[];
  tasks: any[];
  safeBox: any[];
  sets?: any;
}

@Injectable()
export class PlayerService {
  private readonly logger = new Logger(PlayerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 安全解析 JSON 字符串，解析失败时返回默认值
   * @param jsonStr 待解析的 JSON 字符串
   * @param defaultVal 解析失败时的默认值
   */
  safeJsonParse<T>(jsonStr: string, defaultVal: T): T {
    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      this.logger.warn(`JSON 解析失败，使用默认值: ${jsonStr}`);
      return defaultVal;
    }
  }

  /**
   * 计算指定等级所需的升级经验
   * 公式：100 * 1.15^(level-1)
   * @param level 当前等级
   * @returns 升级所需经验值
   */
  private calcUpgradeExp(level: number): number {
    return Math.floor(100 * Math.pow(1.15, level - 1));
  }

  /**
   * 获取或创建玩家
   * 如果用户已有玩家档案则返回，否则创建新档案
   * 新玩家初始化：发放初始装备、初始物品、设置初始位置与标记
   * @param userId 用户ID
   * @returns 玩家对象
   */
  async getOrCreatePlayer(userId: number): Promise<any> {
    let player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) {
      this.logger.log(`为用户 ${userId} 创建新玩家档案`);

      // 初始背包物品：石斧(武器)、皮帽(装备)、布衣(装备)、新手补给、面包×3
      const initialBackpack = [
        { name: '石斧', type: '装备', quantity: 1, durability: 0, data: 'e' },
        { name: '皮帽', type: '装备', quantity: 1, durability: 0, data: 'e' },
        { name: '布衣', type: '装备', quantity: 1, durability: 0, data: 'e' },
        { name: '新手补给', type: '消耗品', quantity: 1, durability: 0, data: '' },
        { name: '面包', type: '消耗品', quantity: 3, durability: 0, data: '' },
      ];

      // 初始已装备的武器（石斧直接装备在武器栏）
      const initialWeapons = [
        { name: '石斧', type: '武器', slot: 1, quantity: 1, durability: 0, data: 'e' },
      ];

      // 初始已装备的防具
      const initialEquipment = [
        { name: '布衣', type: '装备', slot: '身体', quantity: 1, durability: 0, data: 'e' },
      ];

      // 初始标记："指引"=0 表示新手指引开启
      const initialMarkers = { '指引': 0 };

      // 初始称号
      const initialTitles = ['新人'];

      player = await this.prisma.player.create({
        data: {
          userId,
          // 基础属性
          level: 1,
          exp: 0,
          upgradeExp: 100,
          name: '冒险者',
          type: '',
          // 战斗属性
          hp: 100,
          maxHp: 100,
          shield: 0,
          maxShield: 0,
          armor: 0,
          maxArmor: 0,
          attack: 10,
          defense: 0,
          speed: 100,
          dodge: 0,
          hit: 100,
          crit: 5,
          critDmg: 150,
          // 位置信息 - 初始地图为新手村（按真实地图表查询其ID，避免硬编码导致与数据ID体系不匹配）
          mapId: (await this.prisma.gameMap.findFirst({ where: { name: '新手村' } }))?.id ?? 0,
          location: '新手村',
          // 复杂数据结构
          backpack: JSON.stringify(initialBackpack),
          equipment: JSON.stringify(initialEquipment),
          weapons: JSON.stringify(initialWeapons),
          markers: JSON.stringify(initialMarkers),
          titles: JSON.stringify(initialTitles),
        },
      });
    }
    return player;
  }

  /**
   * 获取玩家数据（完整JSON解析）
   * 解析所有JSON字段为对象，方便业务层直接使用
   * @param userId 用户ID
   * @returns 包含解析后各字段的玩家数据
   */
  async getPlayerData(userId: number): Promise<PlayerData> {
    const player = await this.getOrCreatePlayer(userId);

    return {
      player,
      backpack: this.safeJsonParse<any[]>(player.backpack, []),
      equipment: this.safeJsonParse<any[]>(player.equipment, []),
      weapons: this.safeJsonParse<any[]>(player.weapons, []),
      markers: this.safeJsonParse<any>(player.markers, {}),
      markers2: this.safeJsonParse<any[]>(player.markers2, []),
      buffs: this.safeJsonParse<any[]>(player.buffs, []),
      tasks: this.safeJsonParse<any[]>(player.tasks, []),
      safeBox: this.safeJsonParse<any[]>(player.safeBox, []),
    };
  }

  /**
   * 保存玩家数据
   * 将修改后的数据写回数据库，JSON 字段会自动序列化
   * @param player 要保存的玩家对象（包含可能已修改的 JSON 字段）
   */
  async savePlayer(player: any): Promise<void> {
    // 提取需要序列化的 JSON 字段，确保它们以字符串形式存储
    const jsonFields = [
      'backpack', 'equipment', 'weapons', 'markers', 'markers2',
      'buffs', 'tasks', 'titles', 'skills', 'sets', 'bonus',
      'baseBonus', 'safeBox', 'equipmentPresets', 'reverse',
      'recipes', 'stats',
    ];

    const updateData: any = {};
    for (const field of jsonFields) {
      if (player[field] !== undefined) {
        // 如果已经是对象则序列化，否则保持原样（可能是已序列化的字符串）
        updateData[field] = typeof player[field] === 'object'
          ? JSON.stringify(player[field])
          : player[field];
      }
    }

    // 复制非 JSON 的基础字段
    const scalarFields = [
      'level', 'exp', 'upgradeExp', 'name', 'type', 'specialSeq',
      'hp', 'maxHp', 'shield', 'maxShield', 'armor', 'maxArmor',
      'attack', 'defense', 'speed', 'dodge', 'hit', 'crit', 'critDmg',
      'regenHp', 'regenShield', 'regenArmor',
      'mapId', 'location', 'houseName',
      'currentWeapon', 'affinity', 'masterQQ', 'vitality',
      'lastOpTime', 'readTime', 'vehicle',
    ];

    for (const field of scalarFields) {
      if (player[field] !== undefined) {
        updateData[field] = player[field];
      }
    }

    await this.prisma.player.update({
      where: { id: player.id },
      data: updateData,
    });
  }

  /**
   * 增加玩家经验
   * 如果经验超过升级所需，自动升级
   * @param userId 用户ID
   * @param exp 增加的经验值
   * @returns 是否升级及新等级
   */
  async addExp(userId: number, exp: number): Promise<{ leveledUp: boolean; newLevel: number }> {
    const player = await this.getOrCreatePlayer(userId);
    let leveledUp = false;

    // 累加经验
    player.exp = (player.exp || 0) + exp;

    // 检查是否满足升级条件：经验 >= 升级所需经验
    let upgradeExp = player.upgradeExp || this.calcUpgradeExp(player.level);
    while (player.exp >= upgradeExp) {
      player.exp -= upgradeExp;
      player.level += 1;
      player.upgradeExp = this.calcUpgradeExp(player.level);
      upgradeExp = player.upgradeExp;
      leveledUp = true;
      this.logger.log(`玩家 ${userId} 升级到 ${player.level} 级`);
    }

    // 持久化
    await this.prisma.player.update({
      where: { id: player.id },
      data: {
        level: player.level,
        exp: player.exp,
        upgradeExp: player.upgradeExp,
      },
    });

    return { leveledUp, newLevel: player.level };
  }

  /**
   * 获取玩家所在位置信息
   * @param userId 用户ID
   * @returns 地图ID和地图名称
   */
  async getPlayerLocation(userId: number): Promise<{ mapId: number; mapName: string }> {
    const player = await this.getOrCreatePlayer(userId);

    // 根据 mapId 查询地图名称
    let mapName = player.location || '未知区域';
    try {
      const gameMap = await this.prisma.gameMap.findUnique({
        where: { id: player.mapId },
        select: { name: true },
      });
      if (gameMap) {
        mapName = gameMap.name;
      }
    } catch {
      // 地图不存在时使用玩家记录的 location 字段
    }

    return { mapId: player.mapId, mapName };
  }

  /**
   * 检查玩家是否死亡
   * @param player 玩家对象
   * @returns 是否死亡（hp <= 0）
   */
  isPlayerDead(player: any): boolean {
    return (player.hp || 0) <= 0;
  }

  /**
   * 处理玩家死亡（复活、惩罚等）
   * - 生命值恢复至最大生命值的 50%
   * - 护盾/装甲清零
   * - 返回死亡提示文本
   * @param userId 用户ID
   * @param player 玩家对象
   * @returns 死亡处理结果提示文本
   */
  async handlePlayerDeath(userId: number, player: any): Promise<string> {
    // 复活：恢复 50% 最大生命值，清空护盾和装甲
    player.hp = Math.floor((player.maxHp || 100) * 0.5);
    player.shield = 0;
    player.armor = 0;

    // 更新数据库
    await this.prisma.player.update({
      where: { id: player.id },
      data: {
        hp: player.hp,
        shield: 0,
        armor: 0,
      },
    });

    this.logger.log(`玩家 ${userId} 已死亡并复活，HP 恢复至 ${player.hp}`);
    return '你已死亡，已消耗部分资源复活。生命值恢复至 50%，护盾和装甲已清零。';
  }

  /**
   * 获取玩家背包中的物品
   * @param player 玩家对象
   * @returns 背包物品数组
   */
  getBackpackItems(player: any): any[] {
    const backpack = player.backpack;
    if (typeof backpack === 'string') {
      return this.safeJsonParse<any[]>(backpack, []);
    }
    return Array.isArray(backpack) ? backpack : [];
  }

  /**
   * 添加物品到背包
   * 相同名称的物品会自动叠加数量
   * @param userId 用户ID
   * @param itemName 物品名称
   * @param count 添加数量
   * @returns 是否成功
   */
  async addToBackpack(userId: number, itemName: string, count: number): Promise<boolean> {
    try {
      const player = await this.getOrCreatePlayer(userId);
      const backpack = this.getBackpackItems(player);

      // 查找是否已有同名物品，有则叠加数量
      const existing = backpack.find((item: any) => item.name === itemName);
      if (existing) {
        existing.count = (existing.count || 1) + count;
      } else {
        backpack.push({ name: itemName, count });
      }

      // 写回数据库
      await this.prisma.player.update({
        where: { id: player.id },
        data: { backpack: JSON.stringify(backpack) },
      });

      return true;
    } catch (error) {
      this.logger.error(`添加物品失败 userId=${userId}, item=${itemName}, count=${count}`, error);
      return false;
    }
  }

  /**
   * 从背包移除物品
   * @param userId 用户ID
   * @param itemName 物品名称
   * @param count 移除数量
   * @returns 是否成功（数量不足时返回 false）
   */
  async removeFromBackpack(userId: number, itemName: string, count: number): Promise<boolean> {
    try {
      const player = await this.getOrCreatePlayer(userId);
      const backpack = this.getBackpackItems(player);

      const index = backpack.findIndex((item: any) => item.name === itemName);
      if (index === -1) {
        this.logger.warn(`移除物品失败：背包中未找到 ${itemName}`);
        return false;
      }

      const item = backpack[index];
      const currentCount = item.count || 1;

      if (currentCount < count) {
        this.logger.warn(`移除物品失败：${itemName} 数量不足（需要 ${count}，拥有 ${currentCount}）`);
        return false;
      }

      if (currentCount === count) {
        // 数量刚好用完，移除该物品条目
        backpack.splice(index, 1);
      } else {
        // 减少数量
        item.count = currentCount - count;
      }

      // 写回数据库
      await this.prisma.player.update({
        where: { id: player.id },
        data: { backpack: JSON.stringify(backpack) },
      });

      return true;
    } catch (error) {
      this.logger.error(`移除物品失败 userId=${userId}, item=${itemName}, count=${count}`, error);
      return false;
    }
  }

  /**
   * 检查玩家是否有某个标记
   * @param markers 标记对象（已解析或 JSON 字符串）
   * @param name 标记名
   * @returns 是否存在该标记
   */
  hasMarker(markers: any, name: string): boolean {
    const parsed = typeof markers === 'string'
      ? this.safeJsonParse<any>(markers, {})
      : (markers || {});
    return parsed[name] !== undefined && parsed[name] !== null;
  }

  /**
   * 获取标记的数值
   * @param markers 标记对象（已解析或 JSON 字符串）
   * @param name 标记名
   * @returns 标记数值，不存在时返回 0
   */
  getMarkerValue(markers: any, name: string): number {
    const parsed = typeof markers === 'string'
      ? this.safeJsonParse<any>(markers, {})
      : (markers || {});
    return parsed[name] || 0;
  }

  /**
   * 设置标记
   * 若标记已存在则覆盖，不存在则新增
   * @param markers 标记对象（已解析或 JSON 字符串，会被修改）
   * @param name 标记名
   * @param value 标记数值
   */
  setMarker(markers: any, name: string, value: number): void {
    const parsed = typeof markers === 'string'
      ? this.safeJsonParse<any>(markers, {})
      : (markers || {});
    parsed[name] = value;
    // 如果传入的是对象引用，直接修改；否则修改后返回
    if (typeof markers === 'object' && markers !== null) {
      Object.assign(markers, parsed);
    }
  }
}