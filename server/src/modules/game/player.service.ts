/**
 * 玩家服务
 * 对应原版易语言：数据存取.ecode
 * 负责玩家的创建、读取、保存、等级管理、背包操作、标记系统等功能
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { PrismaService } from '../../prisma/prisma.service';
import { BonusData } from './bonus.service';
import { StaticDataService } from './static-data.service';
import { MapService } from './map.service';

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
  /** 同一玩家的用户级串行化锁：key=userId，值=锁尾 Promise */
  private readonly userLocks = new Map<number, Promise<unknown>>();
  /**
   * 锁重入上下文：同一异步链内重复进入同一 userId 的锁时直接放行，
   * 避免服务间嵌套调用（如兑换 → 任务推进）造成自我死锁。
   */
  private readonly lockContext = new AsyncLocalStorage<number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly staticData: StaticDataService,
    private readonly mapService: MapService,
  ) {}

  /**
   * 玩家数据的读-改-写串行化锁（全服共享，按 userId 区分）。
   *
   * 背景：玩家背包/标记等复杂结构以 JSON 字符串整包存取，任何「读取快照→
   * 修改→savePlayer 整包写回」的路径如果与其它路径并发执行，后写者会用
   * 旧快照覆盖先写者的改动（曾导致兑换扣钻后召唤券被后台开采结算的旧
   * 快照回滚）。此前 AutoMineService / TaskService 各持有私有锁互不互斥。
   * 现统一委托本方法；已在同一把锁内的调用（同 userId）直接放行以支持嵌套。
   * @param userId 用户ID
   * @param fn 持锁期间执行的读写逻辑
   */
  withUserLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    if (!userId || !Number.isFinite(userId)) return fn();

    // 可重入：同一条异步链已持有该用户的锁时不再排队，防止 A→B→A 自死锁。
    const held = this.lockContext.getStore();
    if (held === userId) return fn();

    const previous = this.userLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    // 本持有者的闸门：resolve 即放行下一个排队者；gate 永不 reject。
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // 只等前一把锁的闸门，绝不能把自己的 gate 算进等待链（否则自我死锁）。
    const myTurn = previous.then(() => undefined, () => undefined);
    this.userLocks.set(userId, gate);

    return (async () => {
      await myTurn;
      try {
        // run 的新异步链继承重入标记；await 后仍可读到（ALS 贯穿整个 async 链）。
        return await this.lockContext.run(userId, fn);
      } finally {
        release();
        if (this.userLocks.get(userId) === gate) this.userLocks.delete(userId);
      }
    })();
  }

  /** 升级通知队列：userId → 待展示文本（applyLevelUps 入队，指令收尾排水）。 */
  private levelUpTexts = new Map<number, string[]>();

  /**
   * 安全解析 JSON 字符串，解析失败时返回默认值
   * @param jsonStr 待解析的 JSON 字符串
   * @param defaultVal 解析失败时的默认值
   */
  safeJsonParse<T>(jsonStr: string, defaultVal: T): T {
    // 守卫：DB 字段为 NULL/undefined 时，JSON.parse(null) 会返回 null 而非抛错，
    // 若不处理会导致调用方拿到 null 后 .filter 等崩溃（如 map.summons/map.vehicles 为空字段）。
    if (jsonStr === null || jsonStr === undefined) {
      return defaultVal;
    }
    try {
      const parsed = JSON.parse(jsonStr) as T;
      // 字段存储为字符串 "null" 时 JSON.parse 返回 null（不抛错），需回退默认值，
      // 避免调用方对 null 调用 .filter 等崩溃。
      if (parsed === null) return defaultVal;
      return parsed;
    } catch {
      this.logger.warn(`JSON 解析失败，使用默认值: ${jsonStr}`);
      return defaultVal;
    }
  }

  /**
   * 计算指定等级所需的升级经验
   * 对应原版（加成计算.ecode L1781-1794）：
   *   a2 = (c*c + 5) * (1 + 玩家.加成.升级经验 / 100) * (1 - 风月入墨减益 / 100)
   * 其中 c 为当前等级。若没有"升级经验加成"（装备/称号/使魔提供的升级经验百分比），
   * 则 upgradeExpBonus=0；"风月入墨"减益为负面增益（0~100 百分比）。
   * @param level 当前等级
   * @param upgradeExpBonus 升级经验加成（百分比），默认 0
   * @param windMoonReduce 风月入墨减益（百分比），默认 0
   * @returns 升级所需经验值
   */
  calcUpgradeExp(
    level: number,
    upgradeExpBonus = 0,
    windMoonReduce = 0,
  ): number {
    // 升级经验加成>0 会降低升级门槛（即需要的经验更少），故为 (1 + 加成/100)
    const base = level * level + 5;
    return Math.floor(base * (1 + upgradeExpBonus / 100) * (1 - windMoonReduce / 100));
  }

  /**
   * 对应 数据显示.ecode L1640-L1665 的“显示熟练度等级”。
   * 等级从1开始，熟练度达到当前等级平方后再升一级。
   */
  getSkillLevel(markers: any, name: string): number {
    // 原版调用方传入“使魔名称”，实际标记名为“使魔名称+技能熟练度”。
    // 例如兰音对应“兰音技能熟练度”，不能误读为“兰音熟练度”。
    const proficiency = Math.max(0, this.getMarkerValue(markers, `${name}技能熟练度`));
    let level = 1;
    while (proficiency >= level * level) level += 1;
    return level;
  }

  /**
   * 解析新玩家出生地图
   * 优先"新手村"，其次回退到"医疗室"（原版出生点，见 maps.json 首条），
   * 再取第一张地图兜底，避免数据里没有"新手村"导致出生在无效地图（mapId=0）的问题。
   * @returns 出生地图对象（可能为 null）
   */
  private async resolveStartMap(): Promise<any> {
    return (await this.mapService.getMapByName('新手村').catch(() => null))
      || (await this.mapService.getMapByName('医疗室').catch(() => null))
      || (await this.mapService.getAllMaps().then(maps => maps[0]));
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

      // 初始任务：自动领取「新手教程」（对应原版 开局自动接取新手引导任务）
      // 任务要求与奖励从静态数据 tasks.json 读取，避免在代码中硬编码
      let initialTasks: Array<{ name: string; requirements: Array<{ name: string; count: number }> }> = [];
      const tutorialTask = this.staticData.getTaskByName('新手教程');
      if (tutorialTask) {
        const reqs = this.safeJsonParse<Array<{ name: string; count: number }>>(
          tutorialTask.requirements, []
        );
        if (reqs.length > 0) {
          initialTasks.push({ name: '新手教程', requirements: JSON.parse(JSON.stringify(reqs)) });
        }
      }

      const startMap = await this.resolveStartMap();

      player = await this.prisma.player.create({
        data: {
          userId,
          // 基础属性
          level: 1,
          exp: 0,
          upgradeExp: this.calcUpgradeExp(1),
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
          // 位置信息
          mapId: startMap?.id ?? 0,
          location: startMap?.name ?? '新手村',
          // 复杂数据结构
          backpack: JSON.stringify(initialBackpack),
          equipment: JSON.stringify(initialEquipment),
          weapons: JSON.stringify(initialWeapons),
          markers: JSON.stringify(initialMarkers),
          titles: JSON.stringify(initialTitles),
          tasks: JSON.stringify(initialTasks),
        },
      });

      // 新玩家出生后立即刷新出生地图的怪物，避免"开局无怪可打、只能干等每分钟定时刷新"的问题。
      // 原版玩家在医疗室醒来后应能立即与史莱姆战斗。
      if (startMap) {
        try {
          await this.mapService.refreshMapMonsters(startMap.id);
          this.logger.log(`新玩家 ${userId} 出生，已在「${startMap.name}」刷出怪物`);
        } catch (e) {
          this.logger.warn(`新玩家出生刷怪失败: ${e.message}`);
        }
      }
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

    // 自动修复存量玩家无效地图（mapId=0 或不存在的地图）
    // 避免"新手村"地图不存在导致 mapId=0 被写入数据库后，玩家卡在无效地图
    if (!player.mapId || player.mapId <= 0) {
      const startMap = await this.resolveStartMap();
      if (startMap && startMap.id !== player.mapId) {
        this.logger.warn(`玩家 ${userId} 地图无效(mapId=${player.mapId})，自动修正为 ${startMap.name}(id=${startMap.id})`);
        await this.prisma.player.update({
          where: { id: player.id },
          data: { mapId: startMap.id, location: startMap.name },
        });
        // 该定点写会被 $use 拦截器自增 version；同步内存快照版本，
        // 否则同一快照随后的 savePlayer 会因版本过期被 CAS 误拒。
        player.version = Number(player.version ?? 0) + 1;
        player.mapId = startMap.id;
        player.location = startMap.name;
      }
    }

    // 货币物化（P1）：钻石/召唤券/数据核心的真相源是独立列，读取时物化回
    // 背包数组，业务代码照常按背包物品读写（透明兼容）。
    this.materializeCurrencies(player);

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

  /** 货币列 → 背包物品（覆盖同名旧条目；无货币条目时创建），供 getPlayerData 物化。 */
  private materializeCurrencies(player: any): void {
    if (player.diamonds === undefined && player.tickets === undefined && player.dataCores === undefined) {
      return; // 测试桩或旧快照：无货币列则不处理
    }
    const backpack = this.safeJsonParse<any[]>(player.backpack, []);
    const upsert = (name: string, qty: number) => {
      const idx = backpack.findIndex((item: any) => item?.name === name);
      if (qty > 0) {
        // 双字段镜像：存量代码读 .count（如召唤）或 .quantity（如兑换）都正确；
        // 写侧只改其一也没关系——保存时按「与物化基准值的偏差」识别被改的字段。
        if (idx >= 0) {
          backpack[idx].quantity = qty;
          backpack[idx].count = qty;
        } else {
          backpack.push({ name, type: '资源', quantity: qty, count: qty });
        }
      } else if (idx >= 0) {
        backpack.splice(idx, 1);
      }
      // 记录物化基准（不落库）：保存时用于识别业务改的是哪个字段
      ((player as any)._currencyMirror ||= {})[name] = qty;
    };
    upsert('钻石', Number(player.diamonds ?? 0));
    upsert('召唤券', Number(player.tickets ?? 0));
    upsert('数据核心', Number(player.dataCores ?? 0));
    player.backpack = JSON.stringify(backpack);
  }


  /**
   * 保存玩家数据
   * 将修改后的数据写回数据库，JSON 字段会自动序列化
   * @param player 要保存的玩家对象（包含可能已修改的 JSON 字段）
   */
  async savePlayer(player: any): Promise<void> {
    // 经验归一化门禁：落库前强制保证 exp < 当前等级门槛。任何直写 player.exp
    // 的路径（挤奶青龙奖励/躺下离线经验/掉落经验/GM 改面板）都在这里被统一结算，
    // 不依赖调用方记得调用 addExp——这是不变量级别的收口，而非约定级别。
    // 注意：必须在序列化前执行，升级重算的属性字段才会随本次保存一并写入。
    this.applyLevelUps(player);

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

    // 货币提取（P1）：背包里的钻石/召唤券/数据核心落库时写入独立列，
    // 并从 backpack JSON 中移除——列是唯一真相源，读取时由 materializeCurrencies 物化回来。
    if (updateData.backpack !== undefined) {
      let items: any[] | null = null;
      try { items = JSON.parse(updateData.backpack); } catch { items = null; }
      if (Array.isArray(items)) {
        // 判别「权威快照」：对象上有货币列字段说明它来自 getPlayerData 的完整读取，
        // 此时背包对三种货币有最终解释权（条目缺失=已花光=0）；
        // 手工构造的局部对象（无货币字段）只做「有条目才同步」的保守提取，
        // 避免把未加载的货币误清为 0。
        const authoritativeSnapshot = player.diamonds !== undefined
          || player.tickets !== undefined
          || player.dataCores !== undefined;
        // 物化时记录的基准值：用于双字段镜像下识别「哪个字段被业务改过」
        const mirrorMap = (player as any)._currencyMirror || {};
        const pairs: Array<[string, string]> = [['钻石', 'diamonds'], ['召唤券', 'tickets'], ['数据核心', 'dataCores']];
        for (const [itemName, column] of pairs) {
          const idx = items.findIndex((it: any) => it?.name === itemName);
          if (idx >= 0) {
            const it = items[idx];
            const hasQ = it.quantity !== undefined;
            const hasC = it.count !== undefined;
            let value: number;
            if (hasQ && hasC && mirrorMap[itemName] !== undefined) {
              // 双字段都在且已知基准：取偏离基准更大的字段（另一个是未被修改的镜像）
              const q = Number(it.quantity);
              const c = Number(it.count);
              const base = Number(mirrorMap[itemName]);
              value = Math.abs(q - base) >= Math.abs(c - base) ? q : c;
            } else if (hasQ) {
              // 单字段（手工构造或旧数据）：该字段即权威值
              value = Number(it.quantity);
            } else {
              value = Number(it.count ?? 0);
            }
            updateData[column] = value;
            items.splice(idx, 1);
            // 同步回内存快照：调用方（如 mutate 审计）保存后读取列值应与库一致
            (player as any)[column] = value;
          } else if (authoritativeSnapshot) {
            updateData[column] = 0;
            (player as any)[column] = 0;
          }
        }
        updateData.backpack = JSON.stringify(items);
      }
    }

    // 乐观锁（CAS）：以「读快照时的 version」做条件更新（依赖 (id, version)
    // 复合唯一键）。版本过期说明期间有其它路径写过该玩家，本写回若落库会用
    // 旧数据整包覆盖——曾导致兑换扣钻后召唤券被后台结算的旧快照回滚蒸发。
    // Prisma update 匹配不到复合键时抛 P2025，这里转换为显式并发冲突错误，
    // 让「忘加锁的新代码」从静默丢数据变成可见失败；调用方重读即可拿到最新状态。
    const snapshotVersion = Number(player.version ?? 0);

    if (player.version === undefined || player.version === null) {
      // 部分更新：调用方手工构造的字段子集（如 {id, markers}/{id, markers2}），
      // 属于单字段定点写、无覆盖面风险，不参与 CAS，按原路径落库。
      await this.prisma.player.update({
        where: { id: player.id },
        data: updateData,
      });
      return;
    }

    try {
      await this.prisma.player.update({
        where: { id_version: { id: player.id, version: snapshotVersion } },
        data: { ...updateData, version: snapshotVersion + 1 },
      });
      // 回写新版本到内存对象：同一快照在同一条业务链里可能被多次保存
      // （如先扣钱保存、再发奖励保存），不回写会让第二次 CAS 因版本+1 而误判冲突。
      player.version = snapshotVersion + 1;
    } catch (error: any) {
      if (error?.code === 'P2025') {
        // 快照过期：严格拒绝。不做字段合并——若冲突双方修改的是同一个整包字段
        // （如都写 backpack），合并会把丢失更新 bug 请回来。调用方应重读最新
        // 状态重试；计数器型写入者用「增量重放」恢复（见 AchievementService）。
        this.logger.warn(
          `玩家 ${player.id}(${player.userId ?? '?'}) 数据已被并发修改(version=${snapshotVersion} 过期)，本次保存被拒绝`,
        );
        throw new Error('玩家数据并发冲突，请重试');
      }
      throw error;
    }
  }

  /**
   * 经验归一化门禁（对应原版 加成计算.ecode L1781-1794 的总经验推导）：
   * 按「等级²+5」门槛循环扣除并推进等级，保证不变量 exp < 当前等级门槛 在保存前成立。
   * 升级时同步 upgradeExp 与基础战斗属性（recalcLevelStats），并把
   * 「⭐ 等级提升！」文本追加到通知队列（takePendingLevelUpText 统一排水）。
   *
   * savePlayer 在落库前无条件调用本方法，因此任何直写 player.exp 的路径
   * （挤奶青龙奖励/躺下离线经验/distributeLoot 经验掉落/GM 改面板）都自动获得
   * 与 addExp 相同的升级结算，未来新路径无需记得手动调用。
   * @param player 玩家对象（就地修改 level/exp/upgradeExp 及成长属性）
   * @returns 是否发生了升级
   */
  applyLevelUps(player: any): boolean {
    // 部分更新对象（如 {id, markers}）不含等级/经验字段，跳过归一化；
    // 也绝不往这类定点写注入派生字段，避免用错误计算值覆盖真实玩家的数据。
    if (player.level === undefined && player.exp === undefined) return false;

    let level = Math.max(1, Number(player.level ?? 1));
    let exp = Number(player.exp || 0);
    let upgradeExp = this.calcUpgradeExp(level);
    const startLevel = level;

    while (upgradeExp > 0 && exp >= upgradeExp) {
      exp -= upgradeExp;
      level += 1;
      upgradeExp = this.calcUpgradeExp(level);
    }

    if (level === startLevel) {
      // 未升级也顺带修正可能过期的 upgradeExp 存量脏值（仅在对象本就携带该字段时，
      // 与旧 addExp「实时计算门槛、不信任过期字段」的策略一致）
      if (player.upgradeExp !== undefined) player.upgradeExp = upgradeExp;
      return false;
    }

    player.level = level;
    player.exp = exp;
    player.upgradeExp = this.calcUpgradeExp(level);
    this.recalcLevelStats(player);
    this.logger.log(`玩家 ${player.userId ?? player.id ?? '?'} 升级到 ${level} 级`);
    this.enqueueLevelUpText(
      player.userId,
      `⭐ 等级提升了！Lv.${startLevel} → Lv.${level}`,
    );
    return true;
  }

  /** 升级通知入队（挂在服务实例上、按 userId 键控，跨内存快照存活）。 */
  private enqueueLevelUpText(userId: number | undefined, text: string): void {
    if (!userId || !text) return;
    const list = this.levelUpTexts.get(userId) || [];
    list.push(text);
    this.levelUpTexts.set(userId, list);
  }

  /**
   * 排水并清空该玩家的待展示升级通知（原版指令收尾「判断玩家执行这次操作后
   * 是否升级了」的对位实现，_主程序.ecode L12038-12046）。无待展示内容返回空串。
   */
  takePendingLevelUpText(userId: number): string {
    const list = this.levelUpTexts.get(userId);
    if (!list || list.length === 0) return '';
    this.levelUpTexts.delete(userId);
    return list.join('\n');
  }

  /**
   * 增加玩家经验
   * 如果经验超过升级所需，自动升级（结算逻辑统一走 applyLevelUps，
   * 与 savePlayer 归一化门禁共享同一份实现）
   * 升级后同步重算基础战斗属性（maxHp/maxShield/maxArmor/attack 等），
   * 对齐原版 _计算玩家 的等级成长公式（加成计算.ecode L1799-1833）。
   * @param userId 用户ID
   * @param exp 增加的经验值
   * @returns 是否升级及新等级
   */
  async addExp(userId: number, exp: number): Promise<{ leveledUp: boolean; newLevel: number }> {
    const player = await this.getOrCreatePlayer(userId);

    // 累加经验
    player.exp = (player.exp || 0) + exp;

    const leveledUp = this.applyLevelUps(player);

    // 持久化（含升级后重算的属性字段）
    await this.savePlayer(player);

    return { leveledUp, newLevel: player.level };
  }

  /**
   * 按原版 _计算玩家 通用成长公式重算玩家基础战斗属性
   * 对齐 加成计算.ecode L1799-1833（特殊序号>0 即选了使魔的玩家）：
   *   - 攻击=10+战斗熟练×(1+等级/100)；命中=10+(等级/2+战斗熟练/2)×(1+等级/100)
   *   - 生命=50+(等级×2+防御熟练)×(1+等级/100)；护盾=20+...；装甲=30+...
   *   - 闪避=10+(等级/2+防御熟练/2)×(1+等级/100)
   *   - 速度=10+等级/5+闪避熟练/4×(1+等级/100)
   *   - 暴击+3；暴击伤害+150+等级/10
   * 只更新 DB 存储字段（maxHp/maxShield/maxArmor/attack/hit/dodge/crit/critDmg/speed/regen），
   * 供防御方受击、面板显示、数据库一致性使用；攻击方完整计算仍在 buildAttackerBonus。
   * public：供 selectFamiliar 首次选使魔开局时同步重算，使 1 级新玩家属性即符合公式。
   * @param player 玩家对象（会就地修改 maxHp 等字段）
   */
  recalcLevelStats(player: any): void {
    // 仅对已选使魔（type 非空）的玩家应用等级成长；未选使魔的玩家不成长
    if (!player.type) return;

    const markers = this.safeJsonParse<Record<string, number>>(player.markers, {});
    const lv = player.level || 1;
    const lvFactor = 1 + lv / 100;
    const prof = (key: string) => markers[key] || 0;
    const profCombat = prof('战斗');
    const profDefense = prof('防御');
    const profDodge = prof('闪避');

    // 原版 _计算玩家 等级成长（加成计算.ecode L1799-1833）：
    //   攻击=10+战斗熟练×(1+等级/100)；命中=10+(等级/2+战斗熟练/2)×(1+等级/100)
    //   生命=50+(等级×2+防御熟练)×(1+等级/100)；护盾=20+...；装甲=30+...
    //   闪避=10+(等级/2+防御熟练/2)×(1+等级/100)
    //   速度=10+等级/5+闪避熟练/4×(1+等级/100)
    //   暴击+3；暴击伤害+150+等级/10
    // 直接按公式覆盖上限（对齐原版：1级玩家生命上限≈52，攻击=10）。
    player.maxHp = Math.floor(50 + (lv * 2 + profDefense) * lvFactor);
    player.maxShield = Math.floor(20 + (lv * 2 + profDefense) * lvFactor);
    player.maxArmor = Math.floor(30 + (lv * 2 + profDefense) * lvFactor);
    player.attack = Math.floor(10 + profCombat * lvFactor);
    player.hit = Math.floor(10 + (lv / 2 + profCombat / 2) * lvFactor);
    player.dodge = Math.floor(10 + (lv / 2 + profDefense / 2) * lvFactor);
    player.speed = Math.floor(10 + lv / 5 + profDodge / 4 * lvFactor);
    player.crit = 5 + 3; // 初始5 + 原版暴击+3
    player.critDmg = Math.floor(150 + 150 + lv / 10);
    // 回复速率：原版 L1831 成长后为 (0.1+等级/10)，L2343-2345 再 /10 折算为每秒回复
    // （本字段直接存最终每秒回复值，供离线补偿 calculateTimeElapsed 使用）
    player.regenHp = (0.1 + lv / 10) / 10;
    player.regenShield = (0.1 + lv / 10) / 10;
    player.regenArmor = (0.1 + lv / 10) / 10;

    // 当前血量不得超过新上限（原版 L2465：当前生命>属性.生命 时封顶）
    if ((player.hp || 0) > player.maxHp) player.hp = player.maxHp;
    if ((player.shield || 0) > player.maxShield) player.shield = player.maxShield;
    if ((player.armor || 0) > player.maxArmor) player.armor = player.maxArmor;

    this.logger.log(`玩家 ${player.userId} 等级 ${lv}，重算属性: 攻击=${player.attack} HP上限=${player.maxHp}`);
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
      const gameMap = await this.mapService.getMapById(player.mapId).catch(() => null);
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
      // 兼容历史字段不一致：既有 quantity（初始装备/消耗品），又有 count（掉落物）
      const existing = backpack.find((item: any) => item.name === itemName);
      if (existing) {
        const cur = existing.quantity ?? existing.count ?? 0;
        const newVal = cur + count;
        // 统一写入 count，同时清理 quantity 避免双字段歧义
        existing.count = newVal;
        delete existing.quantity;
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
      // 兼容 quantity/count 双字段：优先 count，其次 quantity
      const currentCount = item.count ?? item.quantity ?? 1;

      if (currentCount < count) {
        this.logger.warn(`移除物品失败：${itemName} 数量不足（需要 ${count}，拥有 ${currentCount}）`);
        return false;
      }

      if (currentCount === count) {
        // 数量刚好用完，移除该物品条目
        backpack.splice(index, 1);
      } else {
        // 减少数量（统一写 count，清理 quantity 避免歧义）
        item.count = currentCount - count;
        delete item.quantity;
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
