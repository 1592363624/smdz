/**
 * 后台定时任务服务
 * 对应原版易语言：后台运作.ecode
 * 负责自动保存、地图资源刷新、副本生成、行商判断、掉落货舱等定时任务
 *
 * 注意：为避免循环依赖，本服务不注入 GameService，所有与游戏逻辑相关的
 * 操作（生成 NPC/怪物/召唤物/资源/载具等）均直接通过 PrismaService 操作数据库。
 * 可配置项（副本名、宠物数量上限、几率等）统一从 SystemConfig 配置中心读取。
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { MapService } from './map.service';

/**
 * 默认副本名称列表（未配置 game.instanceNames 时使用）
 */
const DEFAULT_INSTANCE_NAMES = ['扭曲深渊', '遗忘之地', '虚空裂谷', '古战场', '血色遗迹', '幽暗迷宫'];

/**
 * 默认随机无主载具名称列表（未配置 game.randomVehicles 时使用）
 */
const DEFAULT_VEHICLES = ['流浪者', '勘探者', '游骑兵', '探险家', '开拓者'];

/**
 * 默认作物关键词列表（未配置 game.cropKeywords 时使用，用于识别资源2中的作物）
 */
const DEFAULT_CROP_KEYWORDS = ['小麦', '水稻', '番茄', '玉米', '土豆', '萝卜', '苹果', '葡萄'];

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);
  private autoSaveRunning = false;
  private lastAutoSaveTime = 0;
  /** 行商判断运行锁，防止上一次未结束时重复执行 */
  private merchantRunning = false;
  /** 掉落货舱运行锁 */
  private cargoRunning = false;
  /** 生成副本运行锁 */
  private instanceRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly mapService: MapService,
  ) {}

  /**
   * 自动保存 - 每3分钟执行一次
   * 对应原版：自动保存线程（原版为3分钟一次，同时记录最高级玩家）
   * 保存所有在线玩家的数据
   */
  @Cron('0 */3 * * * *') // 每3分钟（秒 分 时 日 月 周）
  async autoSave() {
    if (this.autoSaveRunning) {
      this.logger.warn('自动保存仍在运行中，跳过本次');
      return;
    }
    this.autoSaveRunning = true;
    this.lastAutoSaveTime = Date.now();

    try {
      const players = await this.prisma.player.findMany({
        where: { userId: { gt: 0 } },
        select: { userId: true, level: true, name: true, updatedAt: true },
      });

      let savedCount = 0;
      for (const p of players) {
        // 只保存最近30分钟内有更新的玩家
        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
        if (p.updatedAt > thirtyMinAgo) {
          // PlayerService.savePlayer 已经处理了持久化
          savedCount++;
        }
      }

      this.logger.log(`自动保存完成: ${savedCount} 个玩家`);

      // 记录最高级玩家（对应原版：记录最高级玩家 子程序）
      await this.recordHighestLevelPlayer(players);
    } catch (err: any) {
      this.logger.error(`自动保存失败: ${err.message}`);
    } finally {
      this.autoSaveRunning = false;
    }
  }

  /**
   * 记录最高级玩家
   * 对应原版：记录最高级玩家()，将当前等级最高的玩家等级写入配置中心
   * @param players 玩家列表（含 level / name / userId）
   */
  private async recordHighestLevelPlayer(players: any[]): Promise<void> {
    try {
      if (!players || players.length === 0) return;

      // 找出等级最高的玩家
      let top = players[0];
      for (const p of players) {
        if (p.level > top.level) top = p;
      }

      // 将最高等级写入 SystemConfig，方便管理与界面展示
      await this.prisma.systemConfig.upsert({
        where: { key: 'game.highestPlayerLevel' },
        update: {
          value: String(top.level),
          type: 'number',
          label: '最高级玩家等级',
          group: 'game',
          description: `最高级玩家: ${top.name || ''}(用户ID ${top.userId})`,
        },
        create: {
          key: 'game.highestPlayerLevel',
          value: String(top.level),
          type: 'number',
          label: '最高级玩家等级',
          group: 'game',
          description: `最高级玩家: ${top.name || ''}(用户ID ${top.userId})`,
        },
      });
    } catch (err: any) {
      this.logger.warn(`记录最高级玩家失败: ${err.message}`);
    }
  }

  /**
   * 地图资源刷新 - 每10分钟执行一次
   * 对应原版：地图刷新
   */
  @Cron('0 */10 * * * *') // 每10分钟
  async refreshMapResources() {
    try {
      const maps = await this.mapService.getAllMaps();
      for (const map of maps) {
        await this.mapService.refreshMapResources(map.id);
      }
      this.logger.log(`地图资源刷新完成: ${maps.length} 个地图`);
    } catch (err: any) {
      this.logger.error(`地图资源刷新失败: ${err.message}`);
    }
  }

  /**
   * 怪物重生 - 每分钟检查一次
   * 对应原版：怪物刷新
   */
  @Cron('0 * * * * *') // 每分钟
  async respawnMonsters() {
    try {
      const allMaps = await this.mapService.getAllMaps();
      const maps = allMaps.filter((m: any) => m.monsterCount > 0);

      for (const map of maps) {
        const spawnMonsters = JSON.parse(map.spawnMonsters || '[]');
        const tempMonsters = JSON.parse(map.tempMonsters || '[]');
        const totalMonsters = spawnMonsters.length + tempMonsters.length;

        // 如果怪物数量少于配置，补充刷新
        if (totalMonsters < map.monsterCount) {
          await this.mapService.refreshMapMonsters(map.id);
        }
      }
    } catch (err: any) {
      this.logger.error(`怪物重生失败: ${err.message}`);
    }
  }

  /**
   * 移动延时落地兜底 - 每30秒扫描一次
   * 对应原版：全局"待执行延时"队列由单线程驱动，无丢失问题；
   * 后端 handleMove 用内存 setTimeout 触发落地，服务重启/定时器丢失会导致玩家永久卡在"移动中"。
   * 本任务扫描所有玩家 markers 中的「移动中」记录，凡 arriveAt 已到期的，补完成落地：
   * 更新玩家位置(mapId/location)、清除"移动中"标记、并懒刷新目标地图怪物。
   */
  @Cron('*/30 * * * * *') // 每30秒
  async settlePendingMoves() {
    try {
      const players = await this.prisma.player.findMany({
        where: { userId: { gt: 0 } },
        select: { id: true, userId: true, markers: true, mapId: true },
      });

      let settled = 0;
      for (const p of players) {
        if (!p.markers) continue;
        let markers: Record<string, any>;
        try {
          markers = JSON.parse(p.markers);
        } catch {
          continue;
        }
        const movingStr = markers['移动中'];
        if (!movingStr) continue;

        let moving: { targetName?: string; targetMapId?: number; arriveAt?: number } | null = null;
        try {
          moving = JSON.parse(movingStr);
        } catch {
          moving = null;
        }
        if (!moving || !moving.arriveAt || !moving.targetMapId) continue;

        // 未到期则跳过
        if (Date.now() < moving.arriveAt) continue;

        // 已到期：补完成落地
        const targetMap = await this.mapService.getMapById(moving.targetMapId);
        if (!targetMap) {
          // 目标地图已不存在，仅清除移动中标记，避免卡死
          delete markers['移动中'];
          await this.prisma.player.update({
            where: { id: p.id },
            data: { markers: JSON.stringify(markers) },
          });
          continue;
        }

        delete markers['移动中'];
        await this.prisma.player.update({
          where: { id: p.id },
          data: {
            markers: JSON.stringify(markers),
            mapId: moving.targetMapId,
            location: moving.targetName || targetMap.name,
          },
        });

        // 懒刷新：目标地图无怪物时补充刷新，避免到达后无怪可打
        try {
          const currentSpawn = this.mapService.getMapMonsters(targetMap);
          if (currentSpawn.length === 0) {
            await this.mapService.refreshMapMonsters(moving.targetMapId);
          }
        } catch (e: any) {
          this.logger.warn(`兜底落地懒刷新怪物失败: ${e?.message}`);
        }

        settled++;
      }
      if (settled > 0) {
        this.logger.log(`移动落地兜底: 补完成 ${settled} 名玩家的移动`);
      }
    } catch (err: any) {
      this.logger.error(`移动落地兜底任务失败: ${err.message}`);
    }
  }

  /**
   * 行商判断 - 每小时整点执行
   * 对应原版：行商判断()，生成行商、花园宝宝、小白狐、露娜、神之工匠、小雫、小恶魔、小蓝、无主载具
   * 通过运行锁 + 逐步 try-catch，保证单个步骤失败不影响其他步骤
   */
  @Cron('0 0 * * * *') // 每小时整点（秒=0，分=0）
  async merchantSpawn() {
    if (this.merchantRunning) {
      this.logger.warn('行商判断仍在运行中，跳过本次');
      return;
    }
    this.merchantRunning = true;

    try {
      // 获取可刷特殊的地图（排除开拓地/关卡/不刷特殊）
      const maps = await this.getSpawnableMaps();
      if (maps.length === 0) {
        this.logger.warn('行商判断: 没有可刷特殊的地图');
        return;
      }

      // 1. 清理上一小时生成的行商/露娜/神之工匠/小雫/小恶魔
      await this.clearOldMerchants(maps);

      // 2. 生成行商 NPC
      await this.spawnMerchant(maps);

      // 3. 生成特殊宠物（花园宝宝、小白狐）
      await this.spawnSpecialPet(maps, '花园宝宝');
      await this.spawnSpecialPet(maps, '小白狐');

      // 4. 生成露娜（特殊怪物）
      await this.spawnLuna(maps);

      // 5. 生成神之工匠、小雫（特殊 NPC）
      await this.spawnArtisanAndXiaonv(maps);

      // 6. 生成小恶魔（怪物2）
      await this.spawnLittleDemon(maps);

      // 7. 生成小蓝（5%几率生成特殊物品）
      await this.spawnBlueItem(maps);

      // 8. 生成随机无主载具（10点/22点必刷，其他时间随机）
      await this.spawnRandomVehicle(maps);
    } catch (err: any) {
      this.logger.error(`行商判断失败: ${err.message}`);
    } finally {
      this.merchantRunning = false;
    }
  }

  /**
   * 清理上一小时生成的特殊 NPC 和怪物
   * 对应原版：行商判断 开头删除旧的 行商/露娜/npc1(神之工匠)/npc2(小雫)/小恶魔
   * @param maps 可刷特殊的地图列表
   */
  private async clearOldMerchants(maps: any[]): Promise<void> {
    try {
      let cleaned = 0;
      for (const map of maps) {
        let changed = false;

        // 清理 npcs 中的 行商/神之工匠/小雫
        const npcs = this.parseJsonArray<any>(map.npcs);
        const keptNpcs = npcs.filter(
          (n: any) => !['行商', '神之工匠', '小雫'].includes(n.name),
        );
        if (keptNpcs.length !== npcs.length) changed = true;

        // 清理 summons 中的 露娜 及历史遗留的 npc1*/npc2*/行商
        const summons = this.parseJsonArray<any>(map.summons);
        const keptSummons = summons.filter((s: any) => {
          const name = s.name || '';
          const qq = s.qq || '';
          if (['行商', '神之工匠', '小雫', '露娜'].includes(name)) return false;
          if (qq === '怪物露娜1g') return false;
          if (qq.startsWith('npc1') || qq.startsWith('npc2')) return false;
          return true;
        });
        if (keptSummons.length !== summons.length) changed = true;

        // 清理 tempMonsters 中的 小恶魔
        const tempMonsters = this.parseJsonArray<any>(map.tempMonsters);
        const keptTemp = tempMonsters.filter(
          (m: any) => (m.name || '') !== '小恶魔' && (m.qq || '') !== '怪物小恶魔1',
        );
        if (keptTemp.length !== tempMonsters.length) changed = true;

        if (changed) {
          await this.mapService.updateDynamicFields(map.id, {
            npcs: JSON.stringify(keptNpcs),
            summons: JSON.stringify(keptSummons),
            tempMonsters: JSON.stringify(keptTemp),
          });
          cleaned++;
        }
      }
      if (cleaned > 0) this.logger.log(`行商判断: 清理了 ${cleaned} 个地图的旧 NPC`);
    } catch (err: any) {
      this.logger.error(`清理旧 NPC 失败: ${err.message}`);
    }
  }

  /**
   * 生成行商 NPC（随机地图）
   * @param maps 可刷特殊的地图列表
   */
  private async spawnMerchant(maps: any[]): Promise<void> {
    try {
      const map = this.pickRandomMap(maps);
      const npcs = this.parseJsonArray<any>(map.npcs);
      // 若地图已存在行商则跳过，避免重复
      if (npcs.some((n: any) => n.name === '行商')) return;

      npcs.push({
        name: '行商',
        type: 'npc',
        title: '流浪商人',
        description: '兜售各种物品的商人',
      });
      await this.mapService.updateDynamicFields(map.id, {
        npcs: JSON.stringify(npcs),
      });
      this.logger.log(`行商判断: 在地图 ${map.name} 生成了行商`);
    } catch (err: any) {
      this.logger.error(`生成行商失败: ${err.message}`);
    }
  }

  /**
   * 生成特殊宠物（花园宝宝 / 小白狐）
   * 对应原版：先统计全地图已有数量，未达上限时在随机地图生成召唤物
   * @param maps 可刷特殊的地图列表
   * @param petName 宠物名称（花园宝宝/小白狐）
   */
  private async spawnSpecialPet(maps: any[], petName: string): Promise<void> {
    try {
      // 读取数量上限配置（-1 表示上限=地图数量，与原版一致）
      const configKey = petName === '花园宝宝' ? 'game.petGardenBabyLimit' : 'game.petWhiteFoxLimit';
      let limit = await this.getConfigValue<number>(configKey, -1);
      if (limit === -1) limit = maps.length;

      // 统计全地图该宠物的已有数量
      const currentCount = await this.countSpecialPet(petName);
      if (currentCount >= limit) {
        this.logger.log(`行商判断: ${petName} 已达上限 ${currentCount}/${limit}，跳过生成`);
        return;
      }

      const map = this.pickRandomMap(maps);
      const summons = this.parseJsonArray<any>(map.summons);
      summons.push({
        name: petName,
        type: petName,
        specialSeq: -2,
        ownerQQ: '1',
        qq: `召唤物${this.genId()}`,
        hp: 100,
        maxHp: 100,
        attack: 10,
        defense: 5,
        speed: 100,
        level: 1,
        markers: {},
        vehicle: '',
      });
      await this.mapService.updateDynamicFields(map.id, {
        summons: JSON.stringify(summons),
      });
      this.logger.log(`行商判断: 在地图 ${map.name} 生成了 ${petName}（现有 ${currentCount + 1}/${limit}）`);
    } catch (err: any) {
      this.logger.error(`生成特殊宠物 ${petName} 失败: ${err.message}`);
    }
  }

  /**
   * 统计全地图某特殊宠物的已有数量
   * @param petName 宠物名称
   */
  private async countSpecialPet(petName: string): Promise<number> {
    const maps = await this.mapService.getAllMaps();
    const mapsWithSummons = maps.map((m: any) => ({ summons: m.summons }));
    let count = 0;
    for (const m of mapsWithSummons) {
      const summons = this.parseJsonArray<any>(m.summons);
      count += summons.filter((s: any) => s.name === petName).length;
    }
    return count;
  }

  /**
   * 生成露娜（特殊怪物，加入地图召唤物，QQ=怪物露娜1g，特殊序号=-2）
   * @param maps 可刷特殊的地图列表
   */
  private async spawnLuna(maps: any[]): Promise<void> {
    try {
      const map = this.pickRandomMap(maps);
      const summons = this.parseJsonArray<any>(map.summons);
      if (summons.some((s: any) => s.qq === '怪物露娜1g')) return;

      summons.push({
        name: '露娜',
        type: '露娜',
        ownerQQ: '1',
        qq: '怪物露娜1g',
        specialSeq: -2,
        hp: 500,
        maxHp: 500,
        attack: 50,
        defense: 20,
        speed: 120,
        level: 30,
        markers: {},
        vehicle: '',
      });
      await this.mapService.updateDynamicFields(map.id, {
        summons: JSON.stringify(summons),
      });
      this.logger.log(`行商判断: 在地图 ${map.name} 生成了露娜`);
    } catch (err: any) {
      this.logger.error(`生成露娜失败: ${err.message}`);
    }
  }

  /**
   * 生成神之工匠、小雫（特殊 NPC，加入地图 npcs 字段）
   * @param maps 可刷特殊的地图列表
   */
  private async spawnArtisanAndXiaonv(maps: any[]): Promise<void> {
    try {
      const map = this.pickRandomMap(maps);
      const npcs = this.parseJsonArray<any>(map.npcs);

      // 神之工匠（QQ=npc1g）
      if (!npcs.some((n: any) => n.name === '神之工匠' || n.qq === 'npc1g')) {
        npcs.push({
          name: '神之工匠',
          type: 'npc',
          title: '锻造大师',
          description: '能够打造传说级装备的工匠大师',
          qq: 'npc1g',
        });
      }
      // 小雫（QQ=npc2g）
      if (!npcs.some((n: any) => n.name === '小雫' || n.qq === 'npc2g')) {
        npcs.push({
          name: '小雫',
          type: 'npc',
          title: '精英小雫',
          description: '精英小雫',
          qq: 'npc2g',
        });
      }

      await this.mapService.updateDynamicFields(map.id, {
        npcs: JSON.stringify(npcs),
      });
      this.logger.log(`行商判断: 在地图 ${map.name} 生成了神之工匠、小雫`);
    } catch (err: any) {
      this.logger.error(`生成神之工匠/小雫失败: ${err.message}`);
    }
  }

  /**
   * 生成小恶魔（加入地图怪物2=tempMonsters，QQ=怪物小恶魔1）
   * @param maps 可刷特殊的地图列表
   */
  private async spawnLittleDemon(maps: any[]): Promise<void> {
    try {
      const map = this.pickRandomMap(maps);
      const tempMonsters = this.parseJsonArray<any>(map.tempMonsters);
      if (tempMonsters.some((m: any) => m.qq === '怪物小恶魔1')) return;

      tempMonsters.push({
        id: `demon_${map.id}_${this.genId()}`,
        name: '小恶魔',
        type: '小恶魔',
        qq: '怪物小恶魔1',
        specialSeq: -2,
        level: 10,
        hp: 300,
        maxHp: 300,
        attack: 30,
        defense: 10,
        speed: 110,
        dodge: 5,
        hit: 85,
        exp: 50,
        isElite: false,
      });
      await this.mapService.updateDynamicFields(map.id, {
        tempMonsters: JSON.stringify(tempMonsters),
      });
      this.logger.log(`行商判断: 在地图 ${map.name} 生成了小恶魔`);
    } catch (err: any) {
      this.logger.error(`生成小恶魔失败: ${err.message}`);
    }
  }

  /**
   * 生成小蓝（5%几率在地图物品中添加特殊物品）
   * @param maps 可刷特殊的地图列表
   */
  private async spawnBlueItem(maps: any[]): Promise<void> {
    try {
      const chance = await this.getConfigValue<number>('game.blueChance', 5);
      if (Math.random() * 100 >= chance) return;

      const map = this.pickRandomMap(maps);
      const items = this.parseJsonArray<any>(map.items);
      // 若地图已存在小蓝则跳过
      if (items.some((it: any) => it.name === '小蓝')) return;

      items.push({
        name: '小蓝',
        count: 1,
        quantity: 1,
        type: '资源',
        data: 'a',
      });
      await this.mapService.updateDynamicFields(map.id, {
        items: JSON.stringify(items),
      });
      this.logger.log(`行商判断: 在地图 ${map.name} 生成了特殊物品小蓝`);
    } catch (err: any) {
      this.logger.error(`生成小蓝失败: ${err.message}`);
    }
  }

  /**
   * 生成随机无主载具
   * 对应原版：生成随机载具()，10点/22点必刷，其他时间随机几率生成
   * @param maps 可刷特殊的地图列表
   */
  private async spawnRandomVehicle(maps: any[]): Promise<void> {
    try {
      const hour = new Date().getHours();
      const mustSpawn = hour === 10 || hour === 22;

      // 非必刷时间，按随机几率判断（默认50%）
      if (!mustSpawn) {
        const chance = await this.getConfigValue<number>('game.vehicleChance', 50);
        if (Math.random() * 100 >= chance) return;
      }

      const vehicleNames = await this.getConfigValue<string[]>('game.randomVehicles', DEFAULT_VEHICLES);
      if (!vehicleNames || vehicleNames.length === 0) return;

      const name = vehicleNames[Math.floor(Math.random() * vehicleNames.length)];
      const map = this.pickRandomMap(maps);
      const vehicles = this.parseJsonArray<any>(map.vehicles);

      vehicles.push({
        name,
        owner: '无主',
        driver: '',
        vehicleId: this.genId(),
        type: '',
        moveType: 0,
        maxHp: 100,
        currentHp: 100,
        parts: [],
        markers: {},
        markers2: [],
        recipes: [],
        builtinParts: [],
        bonus: {},
      });
      await this.mapService.updateDynamicFields(map.id, {
        vehicles: JSON.stringify(vehicles),
      });
      this.logger.log(`行商判断: 在地图 ${map.name} 生成了无主载具「${name}」`);
    } catch (err: any) {
      this.logger.error(`生成随机载具失败: ${err.message}`);
    }
  }

  /**
   * 掉落货舱 - 每小时整点后5秒执行
   * 对应原版：掉落货舱()，生成3个货舱、5个能量元素，随机几率生成作物
   * 与行商判断错开5秒执行，避免同一秒内并发操作数据库
   */
  @Cron('5 0 * * * *') // 每小时整点后5秒（秒=5，分=0）
  async dropCargoPods() {
    if (this.cargoRunning) {
      this.logger.warn('掉落货舱仍在运行中，跳过本次');
      return;
    }
    this.cargoRunning = true;

    try {
      const maps = await this.getSpawnableMaps();
      if (maps.length === 0) {
        this.logger.warn('掉落货舱: 没有可刷特殊的地图');
        return;
      }

      // 1. 生成3个货舱（若地图已有货舱则累加数量）
      for (let i = 0; i < 3; i++) {
        const map = this.pickRandomMap(maps);
        await this.addOrIncrementResource(map.id, {
          name: '货舱',
          type: '货舱',
          amount: 10,
          respawnTime: 600,
        });
      }

      // 2. 生成5个能量元素
      for (let i = 0; i < 5; i++) {
        const map = this.pickRandomMap(maps);
        await this.addOrIncrementResource(map.id, {
          name: '能量元素',
          type: '资源',
          amount: 3,
        });
      }

      // 3. 随机几率生成作物（在已有作物的地图上添加一个作物）
      await this.spawnCrop(maps);

      this.logger.log('掉落货舱完成: 3个货舱 + 5个能量元素');
    } catch (err: any) {
      this.logger.error(`掉落货舱失败: ${err.message}`);
    } finally {
      this.cargoRunning = false;
    }
  }

  /**
   * 在地图可采集资源(resources2)中添加资源；若已存在同名资源则累加数量
   * @param mapId 地图ID
   * @param resource 资源对象 { name, type, amount, respawnTime? }
   */
  private async addOrIncrementResource(mapId: number, resource: any): Promise<void> {
    const map = await this.mapService.getMapById(mapId);
    if (!map) return;

    const resources2 = this.parseJsonArray<any>(map.resources2);
    const existing = resources2.find((r: any) => r.name === resource.name);
    if (existing) {
      existing.amount = (existing.amount || 1) + (resource.amount || 1);
    } else {
      resources2.push({
        id: `${resource.name}_${mapId}_${this.genId()}`,
        ...resource,
      });
    }
    await this.mapService.updateDynamicFields(mapId, {
      resources2: JSON.stringify(resources2),
    });
  }

  /**
   * 随机几率生成作物（默认5%）
   * 在已有作物的地图上，随机选取一个作物并添加一个副本
   * @param maps 可刷特殊的地图列表
   */
  private async spawnCrop(maps: any[]): Promise<void> {
    try {
      const cropChance = await this.getConfigValue<number>('game.cropChance', 5);
      if (Math.random() * 100 >= cropChance) return;

      const cropKeywords = await this.getConfigValue<string[]>('game.cropKeywords', DEFAULT_CROP_KEYWORDS);

      // 找出已有作物的地图（资源2中存在作物类型/作物关键词的资源）
      const mapsWithCrops = maps.filter((m: any) => {
        const resources2 = this.parseJsonArray<any>(m.resources2);
        return resources2.some((r: any) => this.isCrop(r, cropKeywords));
      });
      if (mapsWithCrops.length === 0) return;

      const map = this.pickRandomMap(mapsWithCrops);
      const resources2 = this.parseJsonArray<any>(map.resources2);
      const crops = resources2.filter((r: any) => this.isCrop(r, cropKeywords));
      if (crops.length === 0) return;

      // 复制一个随机作物（重新生成id避免冲突）
      const crop = { ...crops[Math.floor(Math.random() * crops.length)] };
      crop.id = `crop_${map.id}_${this.genId()}`;
      resources2.push(crop);

      await this.mapService.updateDynamicFields(map.id, {
        resources2: JSON.stringify(resources2),
      });
      this.logger.log(`掉落货舱: 在地图 ${map.name} 生成了作物「${crop.name}」`);
    } catch (err: any) {
      this.logger.error(`生成作物失败: ${err.message}`);
    }
  }

  /**
   * 判断资源是否属于作物
   * @param resource 资源对象
   * @param cropKeywords 作物关键词列表
   */
  private isCrop(resource: any, cropKeywords: string[]): boolean {
    const type = resource.type || '';
    const name = resource.name || '';
    if (type.includes('作物')) return true;
    return cropKeywords.some((k) => name.includes(k));
  }

  /**
   * 生成副本 - 0点/12点/18点整执行
   * 对应原版：生成副本()，在随机地图生成2个副本入口（副本名从配置读取）
   */
  @Cron('0 0 0,12,18 * * *') // 0点、12点、18点（秒=0，分=0）
  async spawnInstances() {
    if (this.instanceRunning) {
      this.logger.warn('生成副本仍在运行中，跳过本次');
      return;
    }
    this.instanceRunning = true;

    try {
      const maps = await this.getSpawnableMaps();
      if (maps.length === 0) {
        this.logger.warn('生成副本: 没有可刷特殊的地图');
        return;
      }

      // 从配置中心读取副本名称列表
      const instanceNames = await this.getConfigValue<string[]>('game.instanceNames', DEFAULT_INSTANCE_NAMES);
      if (!instanceNames || instanceNames.length === 0) {
        this.logger.warn('生成副本: 未配置副本名称(game.instanceNames)');
        return;
      }

      // 生成2个副本入口
      for (let i = 0; i < 2; i++) {
        const map = this.pickRandomMap(maps);
        const connections = this.parseJsonArray<any>(map.connections);

        // 先移除该地图已有的副本入口，避免入口无限累积
        const keptConnections = connections.filter((c: any) => !(c.name && c.name.includes('(副本)')));
        const name = instanceNames[Math.floor(Math.random() * instanceNames.length)];

        keptConnections.push({
          name: `${name}(副本)`,
          type: 'instance',
          distance: 100,
        });

        await this.mapService.updateDynamicFields(map.id, {
          connections: JSON.stringify(keptConnections),
        });
        this.logger.log(`生成副本: 地图 ${map.name} 添加了副本入口「${name}(副本)」`);
      }
    } catch (err: any) {
      this.logger.error(`生成副本失败: ${err.message}`);
    } finally {
      this.instanceRunning = false;
    }
  }

  /**
   * 清理过期标记和增益 - 每5分钟执行一次
   * 对应原版：标记清理 + 刷新标记(1怪物 2资源)的过期清理
   */
  @Cron('0 */5 * * * *') // 每5分钟
  async cleanupExpiredBuffs() {
    try {
      const now = BigInt(Math.floor(Date.now() / 1000));

      // ----- 清理玩家过期标记和增益 -----
      const players = await this.prisma.player.findMany({
        select: { userId: true, markers2: true, buffs: true },
      });

      let cleanedCount = 0;
      for (const player of players) {
        let changed = false;

        // 清理过期 markers2
        const markers2 = JSON.parse(player.markers2 || '[]');
        const validMarkers2 = markers2.filter((m: any) => {
          if (!m.expireAt) return true;
          return BigInt(m.expireAt) > now;
        });
        if (validMarkers2.length !== markers2.length) {
          changed = true;
        }

        // 清理过期 buffs
        const buffs = JSON.parse(player.buffs || '[]');
        const validBuffs = buffs.filter((b: any) => {
          if (!b.expireAt) return true;
          return BigInt(b.expireAt) > now;
        });
        if (validBuffs.length !== buffs.length) {
          changed = true;
        }

        if (changed) {
          await this.prisma.player.update({
            where: { userId: player.userId },
            data: {
              markers2: JSON.stringify(validMarkers2),
              buffs: JSON.stringify(validBuffs),
            },
          });
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        this.logger.log(`清理了 ${cleanedCount} 个玩家的过期标记`);
      }

      // ----- 清理地图过期刷新标记（刷新怪物/刷新资源等，对应原版刷新标记逻辑） -----
      const allMapsForCleanup = await this.mapService.getAllMaps();
      const maps = allMapsForCleanup.map((m: any) => ({ id: m.id, markers2: m.markers2 }));

      let cleanedMaps = 0;
      for (const map of maps) {
        const mapMarkers2 = this.parseJsonArray<any>(map.markers2);
        const validMapMarkers2 = mapMarkers2.filter((m: any) => {
          if (!m.expireAt) return true;
          return BigInt(m.expireAt) > now;
        });
        if (validMapMarkers2.length !== mapMarkers2.length) {
          await this.mapService.updateDynamicFields(map.id, {
            markers2: JSON.stringify(validMapMarkers2),
          });
          cleanedMaps++;
        }
      }

      if (cleanedMaps > 0) {
        this.logger.log(`清理了 ${cleanedMaps} 个地图的过期刷新标记`);
      }
    } catch (err: any) {
      this.logger.error(`清理过期标记失败: ${err.message}`);
    }
  }

  /**
   * 获取自动保存状态
   */
  getAutoSaveStatus(): { lastSave: number; running: boolean } {
    return {
      lastSave: this.lastAutoSaveTime,
      running: this.autoSaveRunning,
    };
  }

  /**
   * 获取可刷特殊事件的地图列表（排除开拓地/关卡/不刷特殊）
   */
  private async getSpawnableMaps(): Promise<any[]> {
    const maps = await this.mapService.getAllMaps();
    return maps.filter((m: any) => !m.isFrontier && !m.isInstance && !m.noSpecial);
  }

  /**
   * 从地图列表中随机选取一个地图
   * @param maps 地图列表
   */
  private pickRandomMap(maps: any[]): any {
    return maps[Math.floor(Math.random() * maps.length)];
  }

  /**
   * 安全解析 JSON 数组，解析失败返回空数组
   * 兼容 JSON 字符串和已解析的数组（来自 mapService.getAllMaps 返回的合并数据）
   * @param jsonStr JSON 字符串或已解析的数组
   */
  private parseJsonArray<T>(jsonStr: string | T[]): T[] {
    if (Array.isArray(jsonStr)) return jsonStr;
    try {
      const value = JSON.parse(jsonStr || '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  /**
   * 生成唯一编号（时间戳+随机数）
   */
  private genId(): string {
    return `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  }

  /**
   * 从配置中心读取配置值（按类型自动解析），不存在或解析失败时返回默认值
   * @param key 配置键
   * @param defaultValue 默认值
   */
  private async getConfigValue<T>(key: string, defaultValue: T): Promise<T> {
    try {
      const row = await this.prisma.systemConfig.findUnique({ where: { key } });
      if (!row || row.value === '') return defaultValue;

      switch (row.type) {
        case 'number': {
          const num = Number(row.value);
          return (Number.isNaN(num) ? defaultValue : num) as T;
        }
        case 'boolean':
          return (row.value === 'true') as T;
        case 'json':
        case 'string-array': {
          try {
            return JSON.parse(row.value) as T;
          } catch {
            // 兼容逗号分隔的文本
            return (row.value.split(',').map((s) => s.trim()).filter(Boolean) as unknown) as T;
          }
        }
        default:
          return (row.value ?? defaultValue) as T;
      }
    } catch {
      return defaultValue;
    }
  }
}
