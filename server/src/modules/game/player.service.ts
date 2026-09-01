/**
 * 玩家服务
 * 对应原版易语言：数据存取.ecode
 * 负责玩家的创建、读取、保存、等级管理、背包操作、标记系统等功能
 */

import { Injectable, Logger, NotFoundException, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { PrismaService } from '../../prisma/prisma.service';
import { BonusData } from './bonus.service';
import { StaticDataService } from './static-data.service';
import { MapService } from './map.service';
import { ITEM_SYSTEM_SERVICE } from './service-tokens';
import type { ItemSystemService } from './item-system.service';
import { filterActive } from './expire-time.util';
import { deriveDisplayName } from './display-name.util';
import { asJsonValue } from '../../common/utils/json-value.util';
import { PlayerMutateContextService } from './player-mutate-context.service';
import { GameHighlightService } from './highlight.service';
import { ActorRuntime, actorKey } from '../actor';

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

/**
 * 双表示收敛的字段清单：这些子集合在 getPlayerData 载入时会同时生成
 * 「顶层解析表示」(PlayerData.xxx) 与「行字符串」(player.xxx)，行字段由
 * installCanonicalAccessors 改造为读写都透传到顶层权威表示的 accessor。
 */
const CANONICAL_JSON_FIELDS = [
  'backpack', 'equipment', 'weapons', 'markers', 'markers2',
  'buffs', 'tasks', 'safeBox',
] as const;

@Injectable()
export class PlayerService implements OnModuleInit {
  private readonly logger = new Logger(PlayerService.name);
  /** 同一玩家的串行邮箱（Actor 收件箱）：key=userId，值=队列尾 Promise。
   *  这不是互斥锁，而是一条 Promise 链——同一玩家的所有写操作被串到前一个
   *  之后顺序执行，单进程内天然单线程、无竞态，无任何 Mutex/信号量阻塞。 */
  private readonly userMailboxes = new Map<number, Promise<unknown>>();
  /**
   * 锁重入上下文：同一异步链内重复进入同一 userId 的锁时直接放行，
   * 避免服务间嵌套调用（如兑换 → 任务推进）造成自我死锁。
   */
  private readonly mailboxContext = new AsyncLocalStorage<number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly staticData: StaticDataService,
    private readonly mapService: MapService,
    /**
     * mutate 上下文登记处（可选依赖）。
     *
     * 让 `addExp` 这类「自己读档 + 自己保存」的基础方法在被调用方用
     * `PlayerMutateService.mutate()` 包住时，能自动复用同一份快照、不再读档与保存，
     * 从而避免产生第二份快照把外层改动整包覆盖。
     *
     * 声明为 @Optional 是为了兼容存量测试桩（手工 new PlayerService(三个参数)）——
     * 拿不到时自动退回原有的独立读档保存路径，行为完全不变。
     */
    @Optional() private readonly mutateContext?: PlayerMutateContextService,
    /** Actor 运行时（可选依赖）。注入后 enqueueUserWrite/getPlayerData/savePlayer 走
     *  单进程 Actor 层（内存态 + 串行 + 无锁无 CAS）；未注入（存量测试桩手工 new）时
     *  退回原有 userMailboxes 实现，行为完全不变。 */
    @Optional() private readonly actorRuntime?: ActorRuntime,
    /** 物品系统（可选依赖，经 ITEM_SYSTEM_SERVICE 字符串 token 别名注入，
     *  避免 PlayerService↔ItemSystemService 运行时循环加载）。
     *  用于创建玩家时按原版"生成装备"路径卷词条生成初始武器；拿不到时（存量测试桩）
     *  退化为仅名字的静态装备条目。 */
    @Optional() @Inject(ITEM_SYSTEM_SERVICE)
    private readonly itemSystem?: ItemSystemService,
    /** 高光时刻推送（可选依赖）。升级时定向推送给该玩家播放屏幕级动画；
     *  存量测试桩手工 new PlayerService 时不传，升级结算逻辑完全不变。 */
    @Optional() private readonly highlight?: GameHighlightService,
  ) {}

  /**
   * 每个玩家的串行邮箱（Actor 收件箱，全服共享，按 userId 区分）。
   *
   * 这不是互斥锁：它是一条 per-user 的 Promise 链，同一玩家的所有写操作被串到
   * 前一个之后顺序执行，单进程内天然单线程、无竞态，无任何 Mutex/信号量阻塞。
   * 即「改状态只能给它发消息 / 内部单线程」的 Actor 模型落地形态。
   *
   * 背景：玩家背包/标记等复杂结构以 JSON 字符串整包存取，任何「读取快照→
   * 修改→savePlayer 整包写回」的路径如果与其它路径并发执行，后写者会用
   * 旧快照覆盖先写者的改动（曾导致兑换扣钻后召唤券被后台开采结算的旧
   * 快照回滚）。此前 AutoMineService / TaskService 各持有私有锁互不互斥。
   * 现统一委托本邮箱；已在同一邮箱内的调用（同 userId）直接放行以支持嵌套。
   * @param userId 用户ID
   * @param fn 入队后顺序执行的读写逻辑
   */
  enqueueUserWrite<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    if (!userId || !Number.isFinite(userId)) return fn();

    // 已接入 Actor 运行时：委托给单进程 Actor 层（内存态 + 串行邮箱 + 无锁无 CAS）。
    // 同玩家写操作经 actorRuntime.run('player', userId) 串到同一邮箱链，内部
    // getPlayerData/savePlayer 走内存态缓存，写后由运行时统一落库。
    if (this.actorRuntime) {
      return this.actorRuntime.run<T, T>('player', userId, async () => fn());
    }

    // 兼容路径（未注入 ActorRuntime，如存量测试桩手工 new PlayerService）：沿用原
    // userMailboxes 实现，行为完全不变。
    // 可重入：同一条异步链已持有该用户的邮箱时不再排队，防止 A→B→A 自死锁。
    const held = this.mailboxContext.getStore();
    if (held === userId) return fn();

    const previous = this.userMailboxes.get(userId) ?? Promise.resolve();
    let release!: () => void;
    // 本持有者的闸门：resolve 即放行下一个排队者；gate 永不 reject。
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // 只等前一把锁的闸门，绝不能把自己的 gate 算进等待链（否则自我死锁）。
    const myTurn = previous.then(() => undefined, () => undefined);
    this.userMailboxes.set(userId, gate);

    return (async () => {
      await myTurn;
      try {
        // run 的新异步链继承重入标记；await 后仍可读到（ALS 贯穿整个 async 链）。
        return await this.mailboxContext.run(userId, fn);
      } finally {
        release();
        if (this.userMailboxes.get(userId) === gate) this.userMailboxes.delete(userId);
      }
    })();
  }

  /** 模块初始化：把玩家注册为 Actor 类型（仅当运行时被注入时）。
   *  load = getPlayerData（载入并归一化，行 JSON 字段为 accessor 权威透传），
   *  save = persistPlayerData（落库整份 PlayerData：行 getter 序列化的即权威态，
   *  不再需要双表示调和）；策略 writeThrough 保证每次写后落库，行为与旧 savePlayer 一致。 */
  async onModuleInit(): Promise<void> {
    if (!this.actorRuntime || this.actorRuntime.hasType('player')) return;
    this.actorRuntime.registerType('player', {
      load: (id) => this.getPlayerData(Number(id)),
      save: (_id, state) => this.persistPlayerData(state as PlayerData),
      persist: 'writeThrough',
    });
  }

  /** 升级通知队列：userId → 待展示文本（applyLevelUps 入队，指令收尾排水）。 */
  private levelUpTexts = new Map<number, string[]>();

  /**
   * 安全解析 JSON 值，解析失败时返回默认值。
   * 兼容两种存储形态（与 asJsonValue 语义一致）：
   *  - Prisma Json 列 / 内存快照：读出已是「解析好的对象/数组」，直接作为权威数据返回，
   *    绝不能再走 JSON.parse（否则对象被强制转成 "[object Object]" 而误判失败、丢失真实数据）；
   *  - 历史字符串列 / 双表示 accessor：是 JSON 文本，解析后返回。
   * @param jsonStr 待解析的值（字符串 / 对象 / 数组 / null / undefined）
   * @param defaultVal 解析失败或空值时的默认值
   */
  safeJsonParse<T>(jsonStr: unknown, defaultVal: T): T {
    // 守卫：DB 字段为 NULL/undefined 时直接回退默认值，
    // 避免调用方拿到 null 后 .filter 等崩溃（如 map.summons/map.vehicles 为空字段）。
    if (jsonStr === null || jsonStr === undefined) {
      return defaultVal;
    }
    // 非字符串：已是解析好的对象/数组（Prisma Json 列 / 内存快照 / 权威表示），直接透传
    if (typeof jsonStr !== 'string') {
      return jsonStr as T;
    }
    // 空字符串：回退默认值
    if (jsonStr.trim() === '') {
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

      // 初始装备（全部为原版道具，对应原版「普通装备补给箱」的布装备+石制工具）：
      // 武器走原版"生成装备"路径卷随机词条（品质e），保证开局有真实武器伤害。
      // 之前的自创道具「石斧/皮帽」在装备表中无定义（武器伤害恒为0），已移除。
      const fallbackGear = (name: string): any => ({ name, type: '装备', quantity: 1, durability: 0, data: 'e' });
      const generateStarterGear = async (name: string): Promise<any> => {
        if (!this.itemSystem) return fallbackGear(name);
        try {
          return await this.itemSystem.generateRewardEquipment(name, 'e');
        } catch (e) {
          this.logger.warn(`生成初始装备「${name}」失败，退化为静态条目: ${e?.message ?? e}`);
          return fallbackGear(name);
        }
      };
      const starterWeapon = await generateStarterGear('石制工具');
      const starterHat = await generateStarterGear('布帽');
      const starterBody = await generateStarterGear('布衣');

      const initialBackpack = [
        { ...starterWeapon, type: '装备', quantity: 1 },
        { ...starterHat, type: '装备', quantity: 1 },
        { ...starterBody, type: '装备', quantity: 1 },
      ];

      // 初始已装备的武器（石制工具直接装备在武器栏）
      const initialWeapons = [
        { ...starterWeapon, type: '武器', slot: 1, quantity: 1 },
      ];

      // 初始已装备的防具
      const initialEquipment = [
        { ...starterBody, type: '装备', slot: '身体', quantity: 1 },
      ];

      // 初始标记：基础活力上限100，0表示普通击杀默认使用活力。
      const initialMarkers = { '指引': 0, '活力2': 100, '使用活力': 0 };

      // 初始称号：已拥有但未佩戴（原版开局 称号熟练度=0，显示名不带后缀）
      const initialTitles = [{ name: '新人', equipped: false }];

      // 初始任务：自动领取「新手教程」（对应原版 开局自动接取新手引导任务）
      // 任务要求与奖励从静态数据 tasks.json 读取，避免在代码中硬编码
      let initialTasks: Array<{ name: string; requirements: Array<{ name: string; count: number }> }> = [];
      const tutorialTask = this.staticData.getTaskByName('新手教程');
      if (tutorialTask) {
        // asJsonValue 容错读取：静态数据可能已是解析数组（新格式）或 JSON 字符串（旧格式）
        const reqs = asJsonValue<Array<{ name: string; count: number }>>(
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
          // 名字不预置：对应原版开局前无名称，首次「选择使魔」时才赋值为使魔名
          // （原版 _主程序.ecode L701 玩家.图片 = 玩家.类型），未选使魔无法进入游戏内容。
          name: '',
          baseName: '',
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
          vitality: 100,
          // 位置信息
          mapId: startMap?.id ?? 0,
          location: startMap?.name ?? '新手村',
          // 复杂数据结构（Player 各 JSON 列直接写结构体，禁止双重编码）
          backpack: initialBackpack,
          equipment: initialEquipment,
          weapons: initialWeapons,
          markers: initialMarkers,
          titles: initialTitles,
          tasks: initialTasks,
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
    // 已在某玩家的 mutate 上下文内：直接复用外层那份已解析快照，
    // 不再重读库、不再重解析（避免拿到过期快照派生第二份数据，进而整包覆盖外层改动）。
    const ctx = this.mutateContext?.currentFor(userId);
    if (ctx) {
      return ctx as unknown as PlayerData;
    }
    // Actor 内（本玩家邮箱内）：返回【活态】内存态，使业务改动直接进入持久化路径；
    // 激活过程中 cell.state 尚为空，peekLive 返回 undefined 会落到下方 DB 载入路径，不递归。
    // 注意：Actor 外【不】返回缓存 cell（peek）—— 现存代码有大量「不走邮箱的直接
    // savePlayer」路径（如 toggleSetting 设 player.markers 后 savePlayer），它们写库但不更新
    // 内存 cell，若此处返回缓存会读到陈旧数据被后续 enqueueUserWrite 覆盖。故非 Actor 读取
    // 一律走 DB，保证正确性；缓存仅在 enqueueUserWrite 事务内作为免重读优化生效。
    if (this.actorRuntime) {
      const expected = actorKey('player', userId);
      if (this.actorRuntime.currentActorKey() === expected) {
        const live = this.actorRuntime.peekLive('player', userId) as PlayerData | undefined;
        if (live) {
          return live;
        }
      }
    }
    const player = await this.getOrCreatePlayer(userId);

    // 自动修复存量玩家无效地图（mapId=0 或不存在的地图）
    // 避免"新手村"地图不存在导致 mapId=0 被写入数据库后，玩家卡在无效地图
    if (!player.mapId || player.mapId <= 0) {
      const startMap = await this.resolveStartMap();
      if (startMap && startMap.id !== player.mapId) {
        this.logger.warn(`玩家 ${userId} 地图无效(mapId=${player.mapId})，自动修正为 ${startMap.name}(id=${startMap.id})`);
        await this.enqueueUserWrite(userId, async () => {
          const _pd = await this.getPlayerData(userId);
          Object.assign(_pd.player, { mapId: startMap.id, location: startMap.name });
          await this.savePlayer(_pd.player);
        });
        // 该定点写会被 $use 拦截器自增 version；同步内存快照版本，
        // 否则同一快照随后的 savePlayer 会因版本过期被 CAS 误拒。
        player.version = Number(player.version ?? 0) + 1;
        player.mapId = startMap.id;
        player.location = startMap.name;
      }
    }

    // 存量兼容：旧档可能没有活力上限标记，先补齐原版基础值，避免显示0/0。
    // asJsonValue 容错读取：Prisma Json 列读出的是对象，历史字符串列也能兜底
    const markers = asJsonValue<Record<string, any>>(player.markers, {});
    let markersChanged = false;
    if (!Number.isFinite(Number(markers['活力2'])) || Number(markers['活力2']) < 100) {
      markers['活力2'] = 100;
      markersChanged = true;
    }
    if (markers['使用活力'] === undefined) {
      markers['使用活力'] = 0;
      markersChanged = true;
    }
    if (markersChanged) {
      // 仅做内存兜底：把补齐后的活力标记写回内存快照，随本次快照后续的业务保存
      // 一并落库，不再在这里定点写库 + 手动自增 version。原因：
      // 1) 定点写库会立刻推进数据库 version，而内存同步只能靠「假设 $use 拦截器
      //    已自增」来手动 +1，在测试桩或无拦截路径下内存版本超前于库版本，
      //    导致同一快照随后的 savePlayer 被 CAS 误判为并发冲突；
      // 2) 活力上限缺失时读取侧（getVitalityMax）本身已兜底为 100，显示不会 0/0。
      player.markers = markers; // Json 列直接写对象
    }


    // 货币物化（P1）：钻石/召唤券/数据核心的真相源是独立列，读取时物化回
    // 背包数组，业务代码照常按背包物品读写（透明兼容）。
    this.materializeCurrencies(player);

    // BigInt 字段（lastOpTime/readTime 为 schema BigInt，远程库个别列亦可能为
    // BigInt）统一转 Number：避免 player 对象在 pushState / 记录日志等 JSON 序列化
    // 路径抛出「Do not know how to serialize a BigInt」。Prisma 写 BigInt 列同样接受
    // number，读侧归一化无副作用（玩家数值字段均远低于 2^53，精度无损）。
    for (const _k of Object.keys(player)) {
      if (typeof player[_k] === 'bigint') player[_k] = Number(player[_k]);
    }

    // 派生显示名：载入即把 name 刷成 baseName+[佩戴称号] 的派生态（对应原版
    // _计算玩家 每次重算 玩家.名称），佩戴/改名等存量数据无需迁移即可生效。
    // Actor 活态与 mutate 上下文复用分支返回的是已派生的同一对象，无需重刷。
    this.refreshDisplayName(player);

    const result: any = {
      player,
      // Prisma Json 列读出的是对象；asJsonValue 兼容对象/历史字符串两种形态
      backpack: asJsonValue<any[]>(player.backpack, []),
      equipment: asJsonValue<any[]>(player.equipment, []),
      weapons: asJsonValue<any[]>(player.weapons, []),
      markers,
      markers2: asJsonValue<any[]>(player.markers2, []),
      // 增益：读取即剔除已过期条目（时间口径秒/毫秒混用由 filterActive 统一归一化），
      // 使展示层与战斗生效判定都只看到仍然有效的增益；无到期时间的永久增益保留。
      buffs: filterActive(asJsonValue<any[]>(player.buffs, [])),
      tasks: asJsonValue<any[]>(player.tasks, []),
      safeBox: asJsonValue<any[]>(player.safeBox, []),
    };
    // 双表示收敛：安装 accessor 后，行字段与顶层解析表示共享同一份权威数据，
    // 业务改哪一侧都等价（详见 installCanonicalAccessors）。落库时行 getter 序列化
    // 的就是权威态，不再需要「基线对比 + 按侧猜测」的调和启发式。
    this.installCanonicalAccessors(player, result);
    return result;
  }

  /**
   * 把派生显示名刷到 player.name（幂等，只从 baseName 派生、绝不从 name 反推）。
   * 对应原版 加成计算.ecode L1616-1623：名称 = 图片(baseName) + [佩戴称号]，全空回退 类型。
   * 读路径（getPlayerData）与写路径（savePlayer）统一调用，保证任何时刻内存中的
   * name 都是派生态；改名/佩戴称号等写方需更新 baseName/titles 后调用本方法，
   * 使同一条指令的回复文本立即用上新显示名。
   *
   * 仅对 baseName 非空的行派生：baseName='' 意味着「未选使魔」或「绕过
   * 选择/改名流程直接建档的行（测试桩/旧数据）」，这类行保持 name 原值不动，
   * 既避免把直接建档的显示名抹成空串，也杜绝从 name 反推导致的后缀叠加。
   * 真实玩家档案的 baseName 由存量回填与选择/改名写路径保证非空。
   */
  refreshDisplayName(player: any): void {
    if (!player || typeof player !== 'object' || Array.isArray(player)) return;
    if (!player.baseName) return;
    player.name = deriveDisplayName(player);
  }

  /**
   * 双表示收敛（框架级根除 style A/B 分叉）：
   *
   * 玩家子集合历史上存在两种等价写法——
   *   (A) 改顶层解析数组/对象：`ctx.backpack.push(...)` / `ctx.markers['x'] = 1`；
   *   (B) 改行字段（历史上是 JSON 字符串，现 Json 列直赋结构体）：`player.backpack = backpack`。
   * 旧实现里两者是独立的两份数据，落库前必须用「基线对比 + merge 启发式」猜测
   * 业务改的是哪一侧（persistPlayerData 的 merge + mutate 的 syncParsedFields），
   * 启发式一旦拿到陈旧表示就会互相覆盖（医疗箱永久标记被抹掉的回归根因）。
   *
   * 现在把行字段改为 accessor：getter 序列化权威态（顶层解析表示）、setter 解析
   * 回写权威态。两种写法物理上写的是同一份对象，「先解析行→改→写回行」的常见
   * 模式天然经过最新权威态，不再可能丢掉另一侧的改动。落库 = 序列化权威态，
   * 无任何猜测。
   *
   * 仅覆盖「载入时会在顶层生成解析表示」的 8 个子集合；titles/skills/bonus 等
   * 只有行表示的字段不在此列，保持普通字符串属性。
   */
  private installCanonicalAccessors(playerRow: any, state: PlayerData): void {
    for (const field of CANONICAL_JSON_FIELDS) {
      Object.defineProperty(playerRow, field, {
        configurable: true,
        enumerable: true,
        get: () => {
          const canonical = (state as any)[field];
          // 权威态一般恒为解析对象；保留「原始字符串」这一兜底形态，是为了让
          // setter 收到无法解析的历史脏字符串时原样透传（与旧行为一致，
          // 读取侧 safeJsonParse 会走各自的 default 兜底）。
          return typeof canonical === 'string' ? canonical : JSON.stringify(canonical);
        },
        set: (value: any) => {
          if (value === undefined || value === null) {
            (state as any)[field] = field === 'markers' ? {} : [];
            return;
          }
          (state as any)[field] = typeof value === 'string'
            ? this.safeJsonParse(value, value)
            : value;
        },
      });
    }
  }

  /** 货币列 → 背包物品（覆盖同名旧条目；无货币条目时创建），供 getPlayerData 物化。 */
  private materializeCurrencies(player: any): void {
    if (player.diamonds === undefined && player.tickets === undefined && player.dataCores === undefined) {
      return; // 测试桩或旧快照：无货币列则不处理
    }
    // Prisma Json 列读出的是对象；asJsonValue 兼容对象/历史字符串两种形态
    const backpack = asJsonValue<any[]>(player.backpack, []);
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
    player.backpack = backpack; // Json 列直接写数组
  }


  /**
   * 保存玩家数据
   * 将修改后的数据写回数据库，JSON 字段会自动序列化
   * @param player 要保存的玩家对象（包含可能已修改的 JSON 字段）
   */
  async savePlayer(player: any): Promise<void> {
    // 已在 mutate 上下文内：把本次要写入的字段"合并"进上下文快照（局部写如
    // {id, markers} 也不会因内层 savePlayer 被跳过而丢失），真正的落库交给最
    // 外层 mutate 统一执行一次。这样既消除重复 CAS/版本分叉，又保证调用方
    // 无需感知自己是否已被包在 mutate 里——旧快照覆盖类事故在基础设施层被根除。
    // 反查键：优先 userId（玩家号，与 run 登记键一致），回退到玩家主键 id
    // （局部写对象 {id, markers} 不含 userId 时也能命中）。命中即说明当前异步链
    // 已在 mutate 内——把改动合并回上下文快照，由最外层统一落库，避免内层整包
    // 写回制造第二份快照 / 重复 CAS 把外层保存判为并发冲突。
    const lookupKey = this.resolveMutateKey(player);
    const ctx = lookupKey !== undefined ? this.mutateContext?.currentFor(lookupKey) : null;
    if (ctx) {
      this.applyLevelUps(player);
      this.mergeIntoMutateContext(ctx, player);
      // merge 后按完整行重算派生显示名：本快照内改过 baseName/titles（改名/佩戴）
      // 时，最终落库的 name 才是最新派生值；ctx.player 恒为完整行，重算安全。
      this.refreshDisplayName(ctx.player);
      (ctx as any).__mutateDirty = true;
      return;
    }
    // Actor 内（本玩家邮箱内）：外部调用（如怪物回合、战斗循环定时器）不应在此
    // 短路 —— 它持有的是 DB 旧副本，直接标脏并 return 会让 ActorRuntime 写一份
    // 过时快照，覆盖同一玩家邮箱内正在排队/刚落库的修改（「旧快照覆盖」事故根因）。
    // 正确做法：把本次写排队到 enqueueUserWrite，让它基于真实活态重写 cell.state
    // 并同步落库；若调用方本就在邮箱内（如 addExp 的 writeThrough 分支），enqueue
    // 会重入执行，同样能按活态写库。活态缺失时退回普通整包落库，并失效缓存（见下文）。
    // 关键：改动作用于 peekLive 取到的真实 cell.state（而非调用方可能传入的另一份克隆），
    // 避免「改了错误对象、不进 cell」的隐患（正确性风险 #5）。version 交给 persistPlayer
    // 的 $use 中间件自增，这里不手动 +1，避免与 $use 双重自增。
    if (this.actorRuntime) {
      const expected = actorKey('player', (player.userId ?? player.id));
      // 只在「当前异步链确实已经在该玩家 Actor 内」时才走内联路径——其他 Actor 链的
      // run 进来时 currentActorKey 是别的 key，避免跨玩家 Actor 互相排队。
      if (this.actorRuntime.currentActorKey() === expected) {
        const live = this.actorRuntime.peekLive('player', (player.userId ?? player.id)) as
          | PlayerData
          | undefined;
        if (live) {
          // 同 Actor 链：把调用方的裸行合并进活态 cell.state，由 Actor 末尾 writeThrough 落库。
          // 不能直接 return（见上方说明），必须走 run 保证落库。
          // 注意：live.player 就是 cell.state.player，merge 后标脏即通知 Actor 落库。
          Object.assign(live.player, player);
          this.applyLevelUps(live.player);
          this.refreshDisplayName(live.player);
          this.actorRuntime.markDirty();
          // 重入 run：本次写由「外层 run 末尾」统一写库，不再 repeat 打库。
          return;
        }
        // 活态缺失（cell 被 invalidate 后同链继续写）：退回普通整包落库。
      } else {
        // 非本玩家 Actor 链（外部调用，如战斗循环定时器、怪物回合 savePlayer）：
        // 排队到 enqueueUserWrite，基于最新活态写库，杜绝 DB 旧副本整包回滚。
        const uid = player.userId ?? player.id;
        await this.enqueueUserWrite(Number(uid), async () => {
          // enqueueUserWrite 会重新 load 活态，这里的 player 仅用于参考；实际落库
          // 以 enqueueUserWrite 内的最新活态为准（merge 当前改动）。
          const pd = await this.getPlayerData(Number(uid));
          Object.assign(pd.player, player);
          this.applyLevelUps(pd.player);
          this.refreshDisplayName(pd.player);
          await this.persistPlayer(pd.player);
        });
        return;
      }
    }

    // 经验归一化门禁：落库前强制保证 exp < 当前等级门槛。任何直写 player.exp
    // 的路径（挤奶青龙奖励/躺下离线经验/掉落经验/GM 改面板）都在这里被统一结算，
    // 不依赖调用方记得调用 addExp——这是不变量级别的收口，而非约定级别。
    // 注意：必须在序列化前执行，升级重算的属性字段才会随本次保存一并写入。
    this.applyLevelUps(player);
    // 派生显示名收口：refreshDisplayName 内部只对 baseName 非空的完整行派生，
    // 局部写对象 {id, markers} 与未选使魔/直接建档的行自动跳过。
    this.refreshDisplayName(player);
    await this.persistPlayer(player);
    // 非 Actor 路径落库后，使该玩家 Actor 缓存失效，避免陈旧内存态被后续
    // enqueueUserWrite 复用并覆盖本次落库结果（正确性，见 getPlayerData 注释）。
    if (this.actorRuntime) {
      this.actorRuntime.invalidate('player', (player.userId ?? player.id));
    }
  }

  /**
   * 标记当前玩家「已改动、待落库」——但不触发即时写、不计入架构门禁的裸 savePlayer 计数。
   *
   * 用途：业务在 enqueueUserWrite（Actor run / mutate 上下文）内直接改了 cell.state 的
   * 字段（如 ensureTutorialTasks 直接 `player.markers = markers`），需要让
   * 最外层 run 的写策略生效去落库。直接调 savePlayer 虽能标脏，但每多一处裸调用就被
   * 架构门禁记一次、且 Actor 内 savePlayer 本就只标脏不写；故提供这个轻量标脏入口，
   * 等价地把"脏"信号透传给运行时/上下文，不新增裸 savePlayer 调用点。
   */
  markPlayerDirty(userId: number): void {
    if (this.actorRuntime && this.actorRuntime.currentActorKey() === actorKey('player', userId)) {
      this.actorRuntime.markDirty();
      return;
    }
    const ctx = this.mutateContext?.currentFor(userId);
    if (ctx) (ctx as any).__mutateDirty = true;
  }

  /**
   * 计算写入玩家表的字段集合（JSON 字段序列化 + 标量字段拷贝 + 货币列提取）。
   * 纯函数式：只读 player、返回 updateData，不触发落库、不触碰 Actor 状态。
   * savePlayer 的非 Actor 路径与 Actor 运行时 config.save 都复用它，避免两套逻辑。
   */
  private buildPlayerUpdateData(player: any): any {
    // Prisma Json 列清单：落库时必须传真实对象/数组，禁止 JSON.stringify 字符串
    // （字符串写入 Json 列会造成双重编码，读取侧拿到的是字符串而非结构体）。
    const objectJsonFields = new Set(['markers', 'skills', 'sets', 'bonus', 'baseBonus', 'stats']);
    const jsonFields = [
      'backpack', 'equipment', 'weapons', 'markers', 'markers2',
      'buffs', 'tasks', 'titles', 'skills', 'sets', 'bonus',
      'baseBonus', 'safeBox', 'equipmentPresets', 'reverse',
      'recipes', 'stats',
    ];

    const updateData: any = {};
    for (const field of jsonFields) {
      if (player[field] !== undefined) {
        // asJsonValue 容错转换：accessor getter 返回序列化字符串、业务直赋对象、
        // 历史脏数据三种形态统一收敛为 Json 列要求的真实对象/数组
        updateData[field] = asJsonValue(player[field], objectJsonFields.has(field) ? {} : []);
      }
    }

    // 复制非 JSON 的基础字段
    const scalarFields = [
      'level', 'exp', 'upgradeExp', 'name', 'baseName', 'type', 'specialSeq',
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
      // updateData.backpack 经 asJsonValue 收敛后已是数组；保留字符串解析兜底历史脏数据
      if (Array.isArray(updateData.backpack)) {
        items = updateData.backpack;
      } else {
        try { items = JSON.parse(updateData.backpack); } catch { items = null; }
      }
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
        updateData.backpack = items; // Json 列直接写数组
      }
    }

    return updateData;
  }

  /**
   * 真正的落库动作（非 Actor 感知，必由「不在 Actor 内」的路径调用）：
   * 普通 savePlayer 路径、以及 Actor 运行时 config.save 的写后落库都走这里，
   * 因此不会递归进入 Actor 分支。version 仅由 $use 中间件自增，不再做 CAS 冲突判定。
   */
  private async persistPlayer(player: any): Promise<void> {
    const updateData = this.buildPlayerUpdateData(player);
    const snapshotVersion = Number(player.version ?? 0);
    await this.prisma.player.update({
      where: { id: player.id },
      data: updateData, // $use 中间件自动 version: { increment: 1 }
    });
    // 回写内存版本：保持快照与库一致（中间件已 +1）
    player.version = snapshotVersion + 1;
  }

  /**
   * Actor 运行时 config.save 的落库入口：把整份 PlayerData 写回 player 表。
   *
   * 双表示收敛后（见 installCanonicalAccessors），行字段是读写都透传到顶层权威
   * 表示的 accessor——无论业务用哪种风格改（顶层 `ctx.backpack.push(...)` 还是
   * 行 `player.backpack = backpack`），改的都是同一份权威数据，落库
   * 经 asJsonValue 收敛后必然以最新权威态写入 Json 列。落库因此退化为单纯的
   * 整包写入，无需任何「基线对比 + 按侧猜测」的调和逻辑（该机制已随双表示一起删除）。
   */
  private async persistPlayerData(data: PlayerData): Promise<void> {
    const p = (data as any).player;
    if (!p) return;
    await this.persistPlayer(p);
  }

  /**
   * 从玩家对象解析反查 mutate 上下文的键：优先 userId（与 run 登记键一致），
   * 回退到玩家主键 id（局部写对象 {id, markers} 不含 userId 时使用）。
   */
  private resolveMutateKey(player: any): number | undefined {
    if (player?.userId !== undefined && player.userId !== null) return Number(player.userId);
    if (player?.id !== undefined && player.id !== null) return Number(player.id);
    return undefined;
  }

  /**
   * 把一次 savePlayer 携带的字段合并进 mutate 上下文快照。
   * 仅合并"显式出现在本次保存对象上"的字段，避免用局部对象（如 {id, markers}）
   * 覆盖整包玩家数据；最外层 mutate 落库时会以完整 ctx.player 统一写回。
   */
  private mergeIntoMutateContext(ctx: any, player: any): void {
    if (!player || typeof player !== 'object') return;
    const fields = [
      'level', 'exp', 'upgradeExp', 'name', 'baseName', 'type', 'specialSeq',
      'hp', 'maxHp', 'shield', 'maxShield', 'armor', 'maxArmor',
      'attack', 'defense', 'speed', 'dodge', 'hit', 'crit', 'critDmg',
      'regenHp', 'regenShield', 'regenArmor',
      'mapId', 'location', 'houseName', 'currentWeapon', 'affinity',
      'masterQQ', 'vitality', 'lastOpTime', 'readTime', 'vehicle',
      'backpack', 'equipment', 'weapons', 'markers', 'markers2',
      'buffs', 'tasks', 'titles', 'skills', 'sets', 'bonus',
      'baseBonus', 'safeBox', 'equipmentPresets', 'reverse', 'recipes', 'stats',
      'diamonds', 'tickets', 'dataCores',
    ];
    for (const f of fields) {
      if (player[f] !== undefined) ctx.player[f] = player[f];
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
    // 升级属里程碑时刻：与公屏文本同源同批次推送，前端播放屏幕级高光动画
    this.highlight?.emit(player.userId, {
      type: 'level-up',
      title: '等级提升',
      detail: `Lv.${startLevel} → Lv.${level}`,
    });
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
   * 供外部流程直接入队一条结算提示（走与升级通知相同的排水通道）。
   * 用途：新玩家首次选使魔开局时，原版按等级 0→1 判定输出「等级提升了！」
   * （_主程序.ecode L12038-12046），该文本与升级提示共用指令收尾拼接位。
   */
  pushLevelUpText(userId: number, text: string): void {
    this.enqueueLevelUpText(userId, text);
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
    // 复用 mutate 上下文：若本条异步链已在 mutate(同一玩家) 内，直接改它的快照，
    // 不读档也不保存（由最外层统一落库）。
    //
    // 这一步是 mutate 化能「局部渐进推进」的关键：像采集结算这种会调 addExp 的
    // 复杂函数，若 addExp 仍自己读档保存，就会凭空多出一份快照——外层改动会被它
    // 覆盖，或它的改动被外层覆盖。改造后调用方无需改签名即可安全地被 mutate 包住。
    const ctx = this.mutateContext?.currentFor(userId);
    if (ctx) {
      const player = ctx.player;
      player.exp = (player.exp || 0) + exp;
      const leveledUp = this.applyLevelUps(player);
      // 改了 ctx 但未走 savePlayer：声明本次链路需要落库，否则外层条件保存会把它丢掉的。
      (ctx as any).__mutateDirty = true;
      return { leveledUp, newLevel: player.level };
    }

    // Actor 邮箱内：直接改【活态】内存态并标脏（与 savePlayer 的 Actor 快路径同一语义，
    // 由 writeThrough 统一落库）。不能走下方 getOrCreatePlayer 的 DB 直读——读到的是
    // 行副本，随后 savePlayer 命中 Actor 快路径时只标脏、不合并调用方对象，副本上的
    // 经验/升级改动会被静默丢弃（战斗击杀 +20 经验并提示升级、但等级经验原地不动的根因）。
    if (this.actorRuntime) {
      const expected = actorKey('player', userId);
      if (this.actorRuntime.currentActorKey() === expected) {
        const live = this.actorRuntime.peekLive('player', userId) as PlayerData | undefined;
        if (live) {
          live.player.exp = (live.player.exp || 0) + exp;
          const leveledUp = this.applyLevelUps(live.player);
          this.actorRuntime.markDirty();
          return { leveledUp, newLevel: live.player.level };
        }
        // 活态缺失（激活窗口内/失效后）：回退到普通读改写路径
      }
    }

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

    // asJsonValue 容错读取：player 可能来自原始行（Json 列对象）或 accessor（字符串）
    const markers = asJsonValue<Record<string, number>>(player.markers, {});
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
    // 走 getPlayerData：Actor 邮箱内读内存活态，避免 writeThrough 未落库时读到旧位置
    const pd = await this.getPlayerData(userId);
    const player = pd.player;

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
    await this.enqueueUserWrite(userId, async () => {
      const _pd = await this.getPlayerData(userId);
      Object.assign(_pd.player, {
        hp: player.hp,
        shield: 0,
        armor: 0,
      });
      await this.savePlayer(_pd.player);
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
      // 读、改、写全部放入 enqueueUserWrite 内完成：基于 Actor 内存活态修改背包。
      // 之前是先 getOrCreatePlayer 读 DB 行副本改完再写回，若活态有未落库改动
      // （如战斗刚掉落的物品），整包覆盖会造成丢失更新（同类 addExp 事故的背包版）。
      await this.enqueueUserWrite(userId, async () => {
        const _pd = await this.getPlayerData(userId);
        const backpack = this.getBackpackItems(_pd.player);

        // 查找是否已有同名物品，有则叠加数量
        // 兼容历史字段不一致：既有 quantity（初始装备/消耗品），又有 count（掉落物）
        const existing = backpack.find((item: any) => item.name === itemName);
        if (existing) {
          const cur = existing.quantity ?? existing.count ?? 0;
          // 统一写入 count，同时清理 quantity 避免双字段歧义
          existing.count = cur + count;
          delete existing.quantity;
        } else {
          backpack.push({ name: itemName, count });
        }

        _pd.player.backpack = backpack; // Json 列直接写数组
        await this.savePlayer(_pd.player);
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
      // 读、改、写全部放入 enqueueUserWrite 内完成（基于 Actor 内存活态，理由同 addToBackpack）
      return await this.enqueueUserWrite(userId, async () => {
        const _pd = await this.getPlayerData(userId);
        const backpack = this.getBackpackItems(_pd.player);

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

        _pd.player.backpack = backpack; // Json 列直接写数组
        await this.savePlayer(_pd.player);
        return true;
      });
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
