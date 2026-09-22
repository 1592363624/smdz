/**
 * 玩家服务
 * 对应原版易语言：数据存取.ecode
 * 负责玩家的创建、读取、保存、等级管理、背包操作、标记系统等功能
 */

import { Injectable, Logger, NotFoundException, Optional, Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BonusData } from './bonus.service';
import { StaticDataService } from './static-data.service';
import { MapService } from './map.service';
import { ITEM_SYSTEM_SERVICE, COMBAT_SYSTEM_SERVICE } from './service-tokens';
import type { ItemSystemService } from './item-system.service';
import {
  filterActive, findActive, expireAfter, remainSeconds, formatRemain, itemName,
} from './expire-time.util';
import { deriveDisplayName } from './display-name.util';
import { asJsonValue } from '../../common/utils/json-value.util';
import { roundItemQuantity } from '../../common/utils/game-text.util';
import { backfillSpecialSeq, canonicalizeBackpack, lookupFromStaticData, mergeBackpackItem } from './item-normalize.util';
// 字段规范契约（唯一别名映射表）：读档/落库两个边界统一收敛字段名；
// 标记读/写/存在性判定统一走这里的唯一口径（数组 { name, value } / 字典按键）
import { normalizePlayerRow, normalizeEntryList, readMarkerValue, writeMarkerValue } from './field-contract.util';
// 三池数值出口归一化（第四道闸）：落库前兜底收敛，保证 DB 不出现浮点残值脏数据。
import { normalizePools, normalizePoolValue } from './player-pool.util';
import { PlayerMutateContextService } from './player-mutate-context.service';
import { GameHighlightService } from './highlight.service';
import { ActorRuntime, actorKey } from '../actor';

/** 玩家数据完整解析后的结构 */
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
 * 玩家写模型命令。
 *
 * 业务层推荐投递命令，而不是把 getPlayerData 返回的整行对象传回保存入口。
 * PATCH 仅允许更新列白名单中的字段；其余三种高频命令表达业务意图，
 * 由 PlayerService 在该玩家 Actor 邮箱内基于最新活态执行。
 */
export type PlayerPatch = Partial<Record<
  | 'level' | 'exp' | 'upgradeExp' | 'name' | 'baseName' | 'type' | 'specialSeq'
  | 'hp' | 'maxHp' | 'shield' | 'maxShield' | 'armor' | 'maxArmor'
  | 'attack' | 'defense' | 'speed' | 'dodge' | 'hit' | 'crit' | 'critDmg'
  | 'regenHp' | 'regenShield' | 'regenArmor' | 'mapId' | 'location' | 'houseName'
  | 'currentWeapon' | 'affinity' | 'masterQQ' | 'vitality' | 'lastOpTime' | 'readTime'
  | 'playTime' | 'vehicle' | 'backpack' | 'equipment' | 'weapons' | 'markers' | 'markers2'
  | 'buffs' | 'tasks' | 'titles' | 'skills' | 'sets' | 'bonus' | 'baseBonus'
  | 'safeBox' | 'equipmentPresets' | 'reverse' | 'recipes' | 'stats'
  | 'diamonds' | 'tickets' | 'dataCores', any>>;

export type PlayerCommand =
  | { type: 'PATCH'; patch: PlayerPatch; source?: string }
  | { type: 'UPDATE_MARKERS'; changes: Record<string, any>; source?: string }
  | { type: 'SET_MARKER'; name: string; value: any; source?: string }
  | { type: 'SET_ATTRIBUTE'; attr: 'hp' | 'shield' | 'armor' | 'vitality' | 'currentWeapon'; value: number; source?: string }
  | { type: 'ADJUST_ATTRIBUTE'; attr: 'hp' | 'shield' | 'armor' | 'vitality'; delta: number; source?: string };

/** 写基线元数据键（savePlayer 兼容层附加，非枚举、不落库/不进 fieldSignature）；PlayerMutateService 需读写其货币审计去重标志，故导出 */
export const PLAYER_WRITE_META = Symbol('player-write-meta');
const PLAYER_PATCH_FIELDS = [
  'level', 'exp', 'upgradeExp', 'name', 'baseName', 'type', 'specialSeq',
  'hp', 'maxHp', 'shield', 'maxShield', 'armor', 'maxArmor',
  'attack', 'defense', 'speed', 'dodge', 'hit', 'crit', 'critDmg',
  'regenHp', 'regenShield', 'regenArmor', 'mapId', 'location', 'houseName',
  'currentWeapon', 'affinity', 'masterQQ', 'vitality', 'lastOpTime', 'readTime',
  'playTime', 'vehicle', 'backpack', 'equipment', 'weapons', 'markers', 'markers2',
  'buffs', 'tasks', 'titles', 'skills', 'sets', 'bonus', 'baseBonus',
  'safeBox', 'equipmentPresets', 'reverse', 'recipes', 'stats',
  'diamonds', 'tickets', 'dataCores',
] as const;
interface PlayerWriteMeta {
  baseline: Record<string, any>;
  userId?: number;
  /** 本次落库的货币变动已由兜底审计（auditCurrencyWrite）记账；mutate 链据此去重 */
  currencyAuditDone?: boolean;
}

/** 写模型诊断计数（见 PlayerService.writeModelStats / getWriteModelDiagnostics） */
export interface PlayerWriteModelStats {
  /** 旧快照整包写入被 strict 拦截（**已丢写**）的次数 */
  staleWriteBlocked: number;
  /** 旧快照写入被记录后照常合并（PLAYER_WRITE_CAS=log 兼容模式）的次数 */
  staleWriteMerged: number;
  /** persistPlayer 乐观锁冲突（CAS 未命中）次数 */
  casConflict: number;
  /** 最近一次旧快照拦截的时间戳（ms），无则为 null */
  staleWriteAt: number | null;
  /** 最近一次旧快照拦截的调用方栈首帧（便于直接定位写路径） */
  staleWriteCaller: string;
}
function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) return value;
  // BigInt：lastOpTime/readTime/playTime 等列在 schema 中是 BigInt。
  // structuredClone 支持它，但 JSON 往返不支持——必须先归一，否则退化为
  // JSON 序列化时会直接抛 "Do not know how to serialize a BigInt"。
  if (typeof value === 'bigint') return Number(value) as unknown as T;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch { /* fallback */ }
  }
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)),
    ) as T;
  } catch {
    // 含函数/循环引用等不可序列化值：退回原引用。差异比较会退化为引用比较，
    // 最坏情况是「漏判未改动」，即多合并一次同值字段——安全方向，绝不会丢写。
    return value;
  }
}
const CANONICAL_JSON_FIELDS = [
  'backpack', 'equipment', 'weapons', 'markers', 'markers2',
  'buffs', 'tasks', 'safeBox',
] as const;

/**
 * 字段级写基线开关（环境变量 PLAYER_WRITE_DIFF，默认 on）：
 * - on（默认）：savePlayer 收到带写基线的行对象时，只投递「相对基线实际改过的
 *   字段」。把「调用方把整行旧快照搬回邮箱」这条路从根上掐断。
 * - off：合并「对象上出现过的全部字段」（整包搬运），仅供线上排障时对照。
 */
const WRITE_DIFF_MODE: 'on' | 'off' =
  process.env.PLAYER_WRITE_DIFF === 'off' ? 'off' : 'on';

/** Object.prototype.hasOwnProperty 的短写法（避免对象上被覆写时的原型链陷阱）。 */
function hasOwn(obj: any, key: PropertyKey): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

@Injectable()
export class PlayerService {
  private readonly logger = new Logger(PlayerService.name);

  /**
   * 写模型诊断计数（进程级，重启归零）。
   *
   * 为什么需要：`拦截到旧快照整包写入` 与 `玩家乐观锁冲突` 都是**静默丢写**信号
   * （strict 模式下调用方拿不到异常，玩家只会看到「操作了但状态没生效」），只能靠
   * 翻日志堆栈人肉定位。计数与「最近一次调用方」落到内存，由 `GET game/admin/write-model`
   * 一次性读出，便于上线后回归观测。
   */
  private readonly writeModelStats: PlayerWriteModelStats = {
    staleWriteBlocked: 0,
    staleWriteMerged: 0,
    casConflict: 0,
    staleWriteAt: null,
    staleWriteCaller: '',
  };

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
    /** Actor 运行时注入入口：唯一写路径内核（生产由 ActorModule 注入全局单例）。
     *  未注入（存量测试桩手工 new）时构造器自动内置独立实例并注册 player 类型，
     *  桩测试与生产走同一条 Actor 路径。 */
    @Optional() injectedRuntime?: ActorRuntime,
    /** 物品系统（可选依赖，经 ITEM_SYSTEM_SERVICE 字符串 token 别名注入，
     *  避免 PlayerService↔ItemSystemService 运行时循环加载）。
     *  用于创建玩家时按原版"生成装备"路径卷词条生成初始武器；拿不到时（存量测试桩）
     *  退化为仅名字的静态装备条目。 */
    @Optional() @Inject(ITEM_SYSTEM_SERVICE)
    private readonly itemSystem?: ItemSystemService,
    /** 高光时刻推送（可选依赖）。升级时定向推送给该玩家播放屏幕级动画；
     *  存量测试桩手工 new PlayerService 时不传，升级结算逻辑完全不变。 */
    @Optional() private readonly highlight?: GameHighlightService,
    /**
     * 战斗系统（可选依赖，经 COMBAT_SYSTEM_SERVICE 字符串 token 别名注入）。
     *
     * 用途**唯一**：死亡复活「半血」的基数必须是**计算上限**（原版 玩家.属性.生命，
     * 含装备/套装/增益），而计算上限的唯一出口是 `buildAttackerBonus`。PlayerService →
     * CombatSystemService 会形成运行时循环加载，故走 token 别名（与 ItemService 的
     * 三池回复基数同一范式）。存量测试桩不传时退回基础上限 maxHp 兜底。
     */
    @Optional() @Inject(COMBAT_SYSTEM_SERVICE)
    private readonly combatSystem?: { buildAttackerBonus: (player: any, playerData?: any, map?: any) => any },
  ) {
    // Actor 运行时恒有实例：生产用注入的全局单例；测试桩自动内置独立实例。
    this.actorRuntime = injectedRuntime ?? new ActorRuntime();
    if (!injectedRuntime) {
      // 自动内置的 runtime 由本服务全权持有（仅测试桩场景；无需 Nest 生命周期托管）
      this.ownsRuntime = true;
    }
    if (!this.actorRuntime.hasType('player')) {
      this.registerPlayerActorType();
    }
  }

  /** Actor 运行时（唯一写路径内核，恒有实例——见构造器）。 */
  private readonly actorRuntime: ActorRuntime;

  /** 是否为构造时自动内置的 runtime（仅测试桩场景；DI 注入的全局单例归 ActorModule 管）。 */
  private ownsRuntime = false;

  /**
   * 把 player 注册为本 runtime 的 Actor 类型（幂等）。
   * load = getPlayerData（载入并归一化，行 JSON 字段为 accessor 权威透传），
   * save = persistPlayerData（落库整份 PlayerData：行 getter 序列化的即权威态），
   * 策略 writeThrough 保证每次写后立即落库。
   */
  private registerPlayerActorType(): void {
    this.actorRuntime!.registerType('player', {
      load: (id) => this.getPlayerData(Number(id)),
      save: (_id, state) => this.persistPlayerData(state as PlayerData),
      persist: 'writeThrough',
    });
  }

  /**
   * 每个玩家的串行邮箱（Actor 收件箱，全服共享，按 userId 区分）。
   *
   * 这不是互斥锁：它是一条 per-user 的 Promise 链，同一玩家的所有写操作被串到
   * 前一个之后顺序执行，单进程内天然单线程、无竞态，无任何 Mutex/信号量阻塞。
   * 即「改状态只能给它发消息 / 内部单线程」的 Actor 模型落地形态。
   *
   * 为什么必须串行：玩家背包/标记等复杂结构以 JSON 整包存取，任何「读取快照→
   * 修改→savePlayer 整包写回」的路径若与其它路径并发，后写者会用旧快照覆盖
   * 先写者的改动（表现为兑换扣钻后召唤券被后台开采结算的旧快照回滚）。
   * 已在同一邮箱内的调用（同 userId）直接放行以支持嵌套。
   */
  enqueueUserWrite<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    if (!userId || !Number.isFinite(userId)) return fn();

    // 唯一写路径：委托单进程 Actor 层（内存活态 + 串行邮箱 + writeThrough 落库）。
    // 同玩家写操作经 actorRuntime.run('player', userId) 串到同一邮箱链，内部
    // getPlayerData/savePlayer 走内存态缓存，写后由运行时统一落库。
    // 可重入：同一条异步链已在 run 内时直接执行（防自死锁），落库交给最外层 run。
    return this.actorRuntime!.run<T, T>('player', userId, async () => fn());
  }

  /** 升级通知队列：userId → 待展示文本（applyLevelUps 入队，指令收尾排水）。 */
  private levelUpTexts = new Map<number, string[]>();

  /**
   * 安全解析 JSON 值，解析失败时返回默认值。
   * 兼容两种存储形态（与 asJsonValue 语义一致）：
   *  - Prisma Json 列 / 内存快照：读出已是「解析好的对象/数组」，直接作为权威数据返回，
   *    绝不能再走 JSON.parse（否则对象被强制转成 "[object Object]" 而误判失败、丢失真实数据）；
   *  - 历史字符串列 / 双表示 accessor：是 JSON 文本，解析后返回。
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
   * @param upgradeExpBonus 升级经验加成（百分比），默认 0
   * @param windMoonReduce 风月入墨减益（百分比），默认 0
   */
  calcUpgradeExp(
    level: number,
    upgradeExpBonus = 0,
    windMoonReduce = 0,
  ): number {
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
   * 获取或创建玩家：已有档案直接返回，否则建档并初始化
   * （初始装备、初始物品、初始位置与标记）
   */
  async getOrCreatePlayer(userId: number): Promise<any> {
    const uid = this.requireUserId(userId);
    await this.assertUserExists(uid);
    let player = await this.prisma.player.findUnique({ where: { userId: uid } });
    if (!player) {
      this.logger.log(`为用户 ${uid} 创建新玩家档案`);

      // 初始装备（全部为原版道具，对应原版「普通装备补给箱」的布装备+石制工具）：
      // 武器走原版"生成装备"路径卷随机词条（品质e），保证开局有真实武器伤害。
      // 装备名必须取自装备表——表内无定义的名称武器伤害恒为 0。
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
      // 任务需求条目数量只认规范键 quantity（读同义键 count 会拿到 undefined）
      let initialTasks: Array<{ name: string; requirements: Array<{ name: string; quantity: number }> }> = [];
      const tutorialTask = this.staticData.getTaskByName('新手教程');
      if (tutorialTask) {
        // asJsonValue 容错读取：静态数据可能是已解析数组，也可能是 JSON 字符串
        const reqs = asJsonValue<Array<{ name: string; quantity: number }>>(
          tutorialTask.requirements, []
        );
        if (reqs.length > 0) {
          initialTasks.push({ name: '新手教程', requirements: JSON.parse(JSON.stringify(reqs)) });
        }
      }

      const startMap = await this.resolveStartMap();

      player = await this.prisma.player.create({
        data: {
          userId: uid,
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

      // 新玩家出生不在此刷怪（对齐原版）：原版 `刷新地图` 只在服务器读档
      // （接口1.ecode L1374）与副本刷新（后台运作 L1066）执行，与建档无关；
      // 出生地图的常驻怪由启动补齐（ScheduleService.onApplicationBootstrap →
      // MapService.spawnResidentMonsters）与「刷新怪物」标记驱动补齐覆盖。
      // 若在建档时整批重刷出生地图，会把该地图上其他玩家正在打的怪一并替换。
    }
    return player;
  }

  /**
   * 获取玩家数据（把各 JSON 字段解析成对象，供业务层直接使用）
   * @deprecated 快照式写模型的读入口，仅存量调用点兼容保留，新代码禁用。
   *   终态：指令域一律走 `PlayerMutateService.mutate`（单一快照 + 统一落库 + 货币审计），
   *   后台跨玩家域走 `patchPlayer`（定向字段写，不整包覆盖）。收口进度由架构门禁
   *   `architecture-guard.spec.ts` 的 `RAW_SAVEPLAYER_BASELINE` 度量（只减不增）。
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

    // 自动修复存量玩家无效地图（mapId=0 / <=0 / 指向已不存在的地图）
    // 覆盖：新手村缺失导致 mapId=0；家园被删后 mapId 仍指向已删动态图等幽灵位置。
    let needsStartMapFix = !player.mapId || player.mapId <= 0;
    if (!needsStartMapFix && player.mapId > 0) {
      try {
        const currentMap = await this.mapService.getMapById(player.mapId);
        if (!currentMap) needsStartMapFix = true;
      } catch {
        // 测试桩未提供 getMapById 或读图抛错：不把有效 mapId 误判为无效
      }
    }
    if (needsStartMapFix) {
      const startMap = await this.resolveStartMap();
      if (startMap && startMap.id !== player.mapId) {
        this.logger.warn(`玩家 ${userId} 地图无效(mapId=${player.mapId})，自动修正为 ${startMap.name}(id=${startMap.id})`);
        // 就地修复 + 定点落库，禁止两个嵌套：
        // 1) 嵌套 enqueueUserWrite——本方法可能正被 Actor load 激活中，激活窗口
        //    cell.running=false，嵌套排队会等当前 run 的 gate → 永久死锁；
        // 2) 嵌套 getPlayerData——重读 DB 后 mapId 仍为 0，修复分支会自我递归。
        // 内存就地改（Actor 激活时该对象正是即将成为 cell.state 的活态），
        // 库内只定点更新 mapId/location 两列；$use 中间件自增 version 后手动
        // 同步内存版本，避免同一快照随后的 savePlayer 被 CAS 误拒。
        player.mapId = startMap.id;
        player.location = startMap.name;
        await this.prisma.player.update({
          where: { userId: player.userId }, // 归属判定靠 where.userId（Player.id ≠ userId）
          data: { mapId: startMap.id, location: startMap.name },
        });
        player.version = Number(player.version ?? 0) + 1;
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


    // 字段规范归一化（读档闸）：把历史别名键（数量/名称/count/有效期至…）就地收敛为
    // 规范英文键，业务代码此后只可能看到一套字段名，杜绝「某处只读 count」这类口径分裂。
    // 详见 field-contract.util.ts（唯一映射表）。
    normalizePlayerRow(player);

    // 货币物化（P1）：钻石/召唤券/数据核心的真相源是独立列，读取时物化回
    // 背包数组，业务代码照常按背包物品读写（透明兼容）。
    this.materializeCurrencies(player);

    // 物品身份自愈：背包内同名非装备合并、type 收敛到
    // 静态定义（equipments.json/items.json 为唯一真源），保证同一物品无论从
    // 什么渠道获得身份一致。详见 item-normalize.util.ts。
    const staticLookup = lookupFromStaticData(this.staticData);
    player.backpack = canonicalizeBackpack(
      asJsonValue<any[]>(player.backpack, []),
      staticLookup,
    );

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

    // 植入体保底：对齐原版 加成计算.ecode L1644-1649（_计算玩家 每次重算必跑）——
    // 装备栏没有植入体时现场补一件白板（data='x'）植入体，等效"创号自带"。
    // 原版植入体不走任何获取渠道，全靠这条隐式保底；仅内存兜底，随本次快照
    // 后续的业务保存一并落库（与上方活力标记兜底同一策略，只读指令不落库）。
    const equipment = asJsonValue<any[]>(player.equipment, []);
    this.ensureImplantEquipment(equipment);
    // 好感度权威源是 标记["<使魔名>好感"]（`addAchievement` 写入：巧克力、任务奖励、行商等），
    // 而 `player.affinity` 这一列只在「更换使魔」时同步过一次（familiar-system L346）。
    // 不同步的后果：战斗里所有「好感≥20/40/60/80/100 才解锁」的使魔与装备描述，对好感早就涨上去
    // 的玩家仍按换使魔那一刻的旧值判定（通常是 0），表现为"描述写了、实际永远不触发"。
    // 读档闸统一把列刷成 max(列, 标记)，面板/战斗/商店因此看到的是同一个数（与活力标记、植入体
    // 保底同一策略：只兜内存态，随本次快照后续的业务保存落库）。
    if (player.type) {
      const affinityMarker = Number(markers?.[`${player.type}好感`] ?? 0);
      if (Number.isFinite(affinityMarker) && affinityMarker > Number(player.affinity ?? 0)) {
        player.affinity = affinityMarker;
      }
    }
    // 特殊序号补齐（读档闸）：存量装备/武器条目不带 specialSeq，而战斗与加成里
    // 「按 特殊序号 判定」的装备效果（棒棒糖97、射爆核心29、叹息之墙12…）远多于
    // 按名称判定的那几条。在这里统一补齐，展示层/攻击链/防御链/属性面板看到的
    // 才是同一份带序号的权威态；补齐细节与理由见 item-normalize.backfillSpecialSeq。
    backfillSpecialSeq(equipment, staticLookup);
    const weapons = backfillSpecialSeq(asJsonValue<any[]>(player.weapons, []), staticLookup);

    const result: any = {
      player,
      // Prisma Json 列读出的是对象；asJsonValue 兼容对象/历史字符串两种形态
      backpack: asJsonValue<any[]>(player.backpack, []),
      equipment,
      weapons,
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
    // 给兼容 savePlayer 层附加不可枚举写基线。后续即使调用方在邮箱外持有该对象，
    // savePlayer 也只会投递「相对这份基线实际改过的字段」，不会把整行旧快照搬进邮箱。
    this.attachWriteMeta(player, userId);
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
   * 植入体保底（对齐原版 加成计算.ecode L1644-1649，_计算玩家 每次重算必跑）：
   * 装备栏没有任何植入体（含 植入体-强攻 等变体）时，现场补一件白板植入体
   * {name:'植入体', type:'装备', data:'x'}。原版语义为"创号自带 + 无法卸下"——
   * 数据层不需要任何获取渠道，卸下拦截见 item.service.unequipItem。
   * 就地修改传入数组；幂等，已有任意植入体时不重复添加。
   */
  private ensureImplantEquipment(equipment: any[]): void {
    if (!Array.isArray(equipment)) return;
    const hasImplant = equipment.some((item: any) =>
      String(item?.name ?? '').startsWith('植入体'),
    );
    if (hasImplant) return;
    equipment.push({
      name: '植入体',
      type: '装备',
      quantity: 1,
      durability: 0,
      data: 'x', // 白板品质码：无词条、无强化
    });
  }

  /**
   * 双表示收敛（框架级根除 style A/B 分叉）：
   *   (A) 改顶层解析数组/对象：`ctx.backpack.push(...)` / `ctx.markers['x'] = 1`；
   *   (B) 改行字段：`player.backpack = backpack`。
   * 两者若各自持有一份数据，落库前就得用「基线对比 + merge 启发式」猜业务改的是
   * 哪一侧，启发式一旦拿到陈旧表示会互相覆盖。
   *
   * 这里把行字段改为 accessor：getter 序列化权威态（顶层解析表示）、setter 解析
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
          // setter 收到无法解析的历史脏字符串时原样透传，
          // 读取侧 safeJsonParse 会走各自的 default 兜底。
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

  /**
   * 给玩家行附加不可枚举的「写基线」（PLAYER_WRITE_META）。
   *
   * ## 解决什么问题
   *
   * `savePlayer(player)` 的语义是「把调用方给的行对象合并进活态」。常见调用形态是
   * 「邮箱外读一份 DB 副本 → 改一两个字段 → 整行传回 savePlayer」（典型：战斗循环
   * 定时器、延时结算回调）。这类调用携带的是**整行旧快照**：合并进活态时，副本上
   * 那些「没打算改、但已经过期」的字段会一并覆盖活态里刚刚发生的新写入——
   * 这正是「旧快照覆盖」事故的直接形态。
   *
   * ## 怎么解决
   *
   * 载入时为行附加一份字段级基线（本次读取时的快照）。savePlayer 收到带基线的
   * 对象时，只投递「相对该基线**实际改过**的字段」；未改动的字段一个都不进邮箱。
   * 于是调用方无论持有多少过期字段，都无法把它们搬进活态——它没有改过的东西
   * 根本不会被提交。
   *
   * ## 为什么是安全的
   *
   * 差异判定的两种错判方向代价不对等，实现刻意选了安全的一侧：
   * - 误判「改了」（实际没改）→ 合并一个与活态同值的字段 → 无副作用；
   * - 误判「没改」（实际改了）→ 丢弃调用方的写入 → **丢数据**。
   * 因此比较采用「同值优先、可疑即判为已改」：标量用 ===，对象用 JSON 序列化
   * 比较；JSON.stringify 不可比较时保留原引用，最终退化为「判为已改」。
   *
   * 基线不可枚举，因此不会进入 fieldSignature（mutate 的落库判定）、不会被
   * Object.assign / JSON.stringify 带出去污染落库数据。
   *
   * 幂等：活态复用时（Actor 邮箱内 getPlayerData 直接返回 cell.state）只在
   * 首次载入建立基线，重复附加会把「本链已改但未落库的值」误当成基线。
   */
  private attachWriteMeta(player: any, userId: number): void {
    if (!player || typeof player !== 'object') return;
    if (hasOwn(player, PLAYER_WRITE_META)) return;
    const baseline: Record<string, any> = {};
    for (const field of PLAYER_PATCH_FIELDS) {
      baseline[field] = cloneJson(this.readComparable(player, field));
    }
    Object.defineProperty(player, PLAYER_WRITE_META, {
      value: { baseline, userId } satisfies PlayerWriteMeta,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }

  /**
   * 读取字段的「可比较值」：JSON 字段统一解析成结构、BigInt 归一为 number。
   *
   * 行上装了 accessor 的 8 个子集合（见 installCanonicalAccessors）读出来是
   * 序列化字符串，历史字符串列同理；两者都先解析成结构再比较，避免「同一份
   * 数据两种表示」被判成已改动。数值型字符串（如 location='新手村'）解析失败
   * 时原样返回，基线与当前值走同一条路径，比较依然自洽。
   */
  private readComparable(player: any, field: string): any {
    const raw = player?.[field];
    if (typeof raw === 'bigint') return Number(raw);
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return raw; }
    }
    return raw;
  }

  /** 字段值是否等价（仅用于写基线差异判定，语义见 attachWriteMeta）。 */
  private isSameFieldValue(a: any, b: any): boolean {
    if (a === b) return true;
    // null vs undefined 视作不同（一个是「有值但空」，一个是「没读到」），保守判为已改
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false; // 标量不等即已改（NaN 亦然，安全方向）
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false; // 无法序列化（循环引用/BigInt 残留）：判为已改，宁可多写不丢写
    }
  }

  /**
   * 计算「相对写基线实际改过的字段」。
   * @returns 无写基线（手工构造的局部写对象）时返回 null —— 调用方按原语义全量合并。
   */
  private diffAgainstWriteBaseline(incoming: any): Record<string, any> | null {
    const meta: PlayerWriteMeta | undefined = incoming?.[PLAYER_WRITE_META];
    if (!meta?.baseline) return null;
    const changed: Record<string, any> = {};
    for (const field of PLAYER_PATCH_FIELDS) {
      if (!hasOwn(incoming, field)) continue;
      const current = this.readComparable(incoming, field);
      if (this.isSameFieldValue(current, meta.baseline[field])) continue;
      changed[field] = current;
    }
    return changed;
  }

  /**
   * 落库/合并成功后推进写基线：把已提交字段的基线更新为「本次提交的值」。
   *
   * 不推进会让同一次读取后的第二次 savePlayer 把同样的旧值再覆盖回活态——
   * 那段时间里活态可能已被战斗等路径改过，重复提交等于用旧值反压新值。
   * 推进后基线即「我最后一次推给活态的状态」，语义闭合。
   */
  private advanceWriteBaseline(incoming: any, submitted: Record<string, any>): void {
    const meta: PlayerWriteMeta | undefined = incoming?.[PLAYER_WRITE_META];
    if (!meta?.baseline) return;
    for (const [field, value] of Object.entries(submitted)) {
      meta.baseline[field] = cloneJson(value);
    }
  }

  /**
   * 统一货币读写入口（三支柱·支柱一：单写者下的构造级新鲜度）
   *
   * 货币条目的数量只认规范键 quantity（与物品域完全同口径，历史别名 count 由
   * field-contract 在读写档边界收敛）。若条目同时挂 count/quantity 两份镜像字段，
   * 一处只写 quantity、另一处只读 count 就会互相打架，且 savePlayer 的
   * 「重读+合并」安全网救不了这种分裂（两个字段都属于同一权威态，quantity 的修改
   * 是真变更、count 的陈旧是合法字段值）。只保留一个键，「读到旧字段」在构造上
   * 即不可能；所有货币数量读写统一经过本入口。
   */

  /**
   * 按名称读货币数量（背包条目缺失 = 0）。
   * @param backpack 调用方持有的工作背包数组（getBackpackItems 解析产物）。传入时
   * 以它为准——工作数组可能已含未提交的改动，绝不能绕开它重读 player.backpack 旧串。
   */
  getCurrencyAmount(player: any, name: string, backpack?: any[]): number {
    const items = backpack ?? asJsonValue<any[]>(player?.backpack, []);
    const item = items.find((it: any) => it?.name === name);
    const quantity = Number(item?.quantity);
    return Number.isFinite(quantity) ? quantity : 0;
  }

  /**
   * 按名称写货币数量：只写规范键 quantity；value<=0 视为花光——移除条目
   * （对齐「背包条目缺失=已花光」不变量，落库侧据此把列同步为 0）。
   * @param backpack 调用方持有的工作背包数组。传入时只改该数组（提交由调用方
   * `player.backpack = backpack` 统一完成，与全库「解析克隆→改→写回」约定一致）；
   * 不传时自行解析并写回权威态。
   */
  setCurrencyAmount(player: any, name: string, value: number, backpack?: any[]): void {
    const items = backpack ?? asJsonValue<any[]>(player?.backpack, []);
    const idx = items.findIndex((it: any) => it?.name === name);
    const qty = roundItemQuantity(value);
    if (!Number.isFinite(qty) || qty <= 0) {
      if (idx >= 0) items.splice(idx, 1);
    } else if (idx >= 0) {
      items[idx].quantity = qty;
    } else {
      items.push({ name, type: '资源', quantity: qty });
    }
    if (!backpack) player.backpack = items;
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
        if (idx >= 0) backpack[idx].quantity = qty;
        else backpack.push({ name, type: '资源', quantity: qty });
      } else if (idx >= 0) {
        backpack.splice(idx, 1);
      }
    };
    upsert('钻石', Number(player.diamonds ?? 0));
    upsert('召唤券', Number(player.tickets ?? 0));
    upsert('数据核心', Number(player.dataCores ?? 0));
    player.backpack = backpack; // Json 列直接写数组
    // 物化标记（不落库）：落库提取货币时据此确认「背包对三种货币有最终解释权」，
    // 手工构造的局部对象/未物化的原始行没有它，其货币条目不被信任。
    (player as any)._currencyMaterialized = true;
  }


  /**
   * 保存玩家数据：JSON 字段自动序列化后写回数据库
   * @param player 要保存的玩家对象（包含可能已修改的 JSON 字段）
   * @deprecated 快照式写模型的写入口，仅存量调用点兼容保留，新代码禁用。
   *   终态：指令域一律走 `PlayerMutateService.mutate`（最外层统一落库），
   *   后台跨玩家域走 `patchPlayer`（定向字段写，不整包覆盖）。收口进度由架构门禁
   *   `RAW_SAVEPLAYER_BASELINE` 度量（只减不增）。
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
    // 统一聚合键：邮箱 key 只允许 userId。仅有行 id 的局部对象先反查 userId——
    // 行 id 直接当 key 会造出 'player:<行id>' 幽灵邮箱（同一行两条互不串行的
    // 邮箱），且幽灵 cell 激活时 getOrCreatePlayer(<行id>) 会以行 id 建档，
    // 触发 player 外键冲突（Foreign key constraint violated: userId）。
    {
      const uid = await this.resolveActorUserId(player);
      if (uid === undefined) return;
      const expected = actorKey('player', uid);
      // 重入判定必须同时满足：ALS key 匹配 + run 此刻真的在执行中（cell.running）。
      // ALS 会随定时器回调逃逸出 run 作用域，已结束旧 run 的残留 ALS 同样匹配 key；
      // 只比 key 会让逃逸回调绕过邮箱，把旧快照直接 merge 进活态再标脏落库
      // ——「旧快照覆盖」事故根因之一（与 ActorRuntime.run 的重入判定对齐）。
      if (
        this.actorRuntime.currentActorKey() === expected
        && this.actorRuntime.isRunActive('player', uid)
      ) {
        const live = this.actorRuntime.peekLive('player', uid) as PlayerData | undefined;
        if (live) {
          // 同 Actor 链（真实在 run 内）：把调用方的裸行合并进活态 cell.state，
          // 由 Actor 末尾 writeThrough 落库。合并前做旧快照检测（见 mergeIntoLiveState）。
          // accepted → 回写快照版本，否则同一条指令后续的第二次 savePlayer 会被
          // 自己刚推进的 version 判成旧快照而静默丢弃（见 rebaseSnapshotVersion）。
          const accepted = this.mergeIntoLiveState(live.player, player);
          this.applyLevelUps(live.player);
          this.refreshDisplayName(live.player);
          if (accepted) this.rebaseSnapshotVersion(player, live.player);
          this.actorRuntime.markDirty();
          // 重入 run：本次写由「外层 run 末尾」统一写库，不再 repeat 打库。
          return;
        }
        // 活态缺失（cell 被 invalidate 后同链继续写）：落入下方邮箱路径按最新活态重写。
      }
      // 邮箱路径：跨玩家 Actor 链、ALS 逃逸回调、或活态缺失——一律排队到该玩家
      // 自己的邮箱内，基于最新活态合并后落库，杜绝 DB 旧副本整包回滚。
      await this.enqueueUserWrite(uid, async () => {
        // enqueueUserWrite 会重新 load 活态，这里的 player 仅携带调用方的改动；
        // 实际落库以邮箱内的最新活态为准（merge 当前改动）。merge 的目标就是
        // 活态本身，run 收尾 writeThrough 不会重复落库（本 run 未标脏）。
        const pd = await this.getPlayerData(uid);
        const accepted = this.mergeIntoLiveState(pd.player, player);
        this.applyLevelUps(pd.player);
        this.refreshDisplayName(pd.player);
        await this.persistPlayer(pd.player);
        // 落库已推进活态 version：回写到调用方快照，避免「同一份快照连写多次」时
        // 第 2 次起被自己推进的版本判成旧快照（strict 模式静默丢写，实测事故见
        // rebaseSnapshotVersion 注释）。必须放在 persistPlayer 之后取落库后的版本。
        if (accepted) this.rebaseSnapshotVersion(player, pd.player);
      });
      return;
    }
  }

  /**
   * 写模型诊断读数（只读，供 `GET game/admin/write-model` 与测试断言）。
   *
   * 判读口径：
   * - `staleWriteBlocked > 0`：**存在静默丢写**——仍有写路径在 mutate/邮箱管道之外，
   *   对同一份快照连续写多次（同形态事故见 GameService.handleDodge 迁移注释）；
   *   日志里每条 `拦截到旧快照整包写入` 都带调用方堆栈，可直接定位到方法。
   * - `casConflict > 0`：确有并发写者撞版本（strict 下会向调用方抛「玩家数据并发冲突」）。
   * 两者长期为 0 才说明写入口收口到位。
   */
  getWriteModelDiagnostics(): PlayerWriteModelStats & { casMode: string } {
    return { ...this.writeModelStats, casMode: PlayerService.CAS_MODE };
  }

  /**
   * 解析写入对象的邮箱聚合键（恒为 userId）。
   *
   * - 带 userId：直接使用（校验为正整数）。
   * - 仅带行 id（历史局部写 {id, markers}）：反查一次 userId，并告警提示调用方
   *   显式携带——行 id 永远不得作为 Actor key（会造出并行幽灵邮箱 + 幽灵建档）。
   * - 均无法解析（行不存在/查询失败）：返回 undefined，调用方丢弃本次写库，
   *   绝不带着行 id 进入邮箱。
   */
  private async resolveActorUserId(player: any): Promise<number | undefined> {
    if (player?.userId !== undefined && player?.userId !== null) {
      const direct = Number(player.userId);
      if (Number.isFinite(direct) && direct > 0) return direct;
    }
    if (player?.id !== undefined && player?.id !== null) {
      const rowId = Number(player.id);
      if (Number.isFinite(rowId) && rowId > 0) {
        try {
          const row = await this.prisma.player.findUnique({
            where: { id: rowId },
            select: { userId: true },
          });
          if (row?.userId) {
            this.logger.warn(
              `savePlayer 收到仅有行 id(${rowId}) 的写入对象，已反查 userId=${row.userId}。`
              + `请调用方显式携带 userId：行 id 不得作为 Actor 邮箱键。`,
            );
            return row.userId;
          }
          this.logger.error(`savePlayer 写入对象无法解析归属玩家（行 id=${rowId} 不存在），本次写库已丢弃`);
          return undefined;
        } catch (e: any) {
          this.logger.error(`savePlayer 反查行 id=${rowId} 的 userId 失败: ${e?.message ?? e}，本次写库已丢弃`);
          return undefined;
        }
      }
    }
    this.logger.error('savePlayer 收到既无 userId 也无有效行 id 的写入对象，本次写库已丢弃');
    return undefined;
  }

  /**
   * 把调用方携带的字段合并进活态玩家行，并对「旧快照整包写」做检测。
   *
   * 调用方对象带 version 且小于活态 version，说明它是很久之前读出的快照
   * （活态此后已被其他写者推进）——正是「旧快照整包覆盖」的特征。
   * - strict 模式（默认）：直接丢弃本次合并，保护活态（调用方应基于活态重算后重试）；
   * - log 模式（运维回退用，PLAYER_WRITE_CAS=log）：记录冲突与调用方堆栈后
   *   照常合并（业务不中断）。
   * version 相同或更大不属于旧快照，正常合并。
   *
   * @returns 是否接受了本次合并（false = 判定为旧快照并丢弃，strict 模式）；
   *   调用方据此决定是否回写快照 version（见 rebaseSnapshotVersion）。
   */
  private mergeIntoLiveState(liveRow: any, incoming: any): boolean {
    if (!incoming || typeof incoming !== 'object') return false;
    const liveVersion = Number(liveRow?.version ?? 0);
    if (incoming.version !== undefined) {
      const incomingVersion = Number(incoming.version);
      if (Number.isFinite(incomingVersion) && incomingVersion < liveVersion) {
        const stack = (new Error('stale-player-write').stack ?? '')
          .split('\n')
          .slice(2, 7)
          .join('\n');
        // 可观测性计数：这类「静默丢写」是「玩家看到操作了但状态没生效」的直接信号。
        // 数量非零即说明仍有写路径没走 mutate 管道（见 getWriteModelDiagnostics）。
        const blocked = PlayerService.CAS_MODE === 'strict';
        // 调用方栈首帧：跳过 player.service 自身帧，直接给到「是谁在写」
        const frames = (new Error('stale-player-write').stack ?? '')
          .split('\n').slice(1).map((s) => s.trim()).filter(Boolean);
        this.writeModelStats.staleWriteAt = Date.now();
        this.writeModelStats.staleWriteCaller = (
          frames.find((f) => !f.includes('player.service')) ?? frames[0] ?? ''
        ).slice(0, 200);
        if (blocked) this.writeModelStats.staleWriteBlocked += 1;
        else this.writeModelStats.staleWriteMerged += 1;
        this.logger.error(
          `拦截到旧快照整包写入: incoming.version=${incomingVersion} < live.version=${liveVersion}`
          + ` (PLAYER_WRITE_CAS=${PlayerService.CAS_MODE})，调用方堆栈:\n${stack}`,
        );
        if (blocked) return false;
      }
    }

    // 字段级投递：带写基线的行对象只提交「相对基线实际改过的字段」。
    // 这是掐断「整行旧快照搬运」的那一刀——调用方没改过的字段（哪怕它手上的
    // 值已经过期 30 秒）一个都不会进活态。无写基线（手工构造的局部写对象）
    // 时 diff 返回 null，按原语义合并对象上出现过的全部字段。
    const diff = WRITE_DIFF_MODE === 'on' ? this.diffAgainstWriteBaseline(incoming) : null;
    if (diff) {
      // 同源短路：调用方传回的就是活态本身（Actor 邮箱内 getPlayerData 直接返回
      // cell.state，业务改完 pd.backpack/pd.markers 再 savePlayer(pd.player)）。
      // 此时改动已经落在权威态上，无需再合并；若硬把 diff 出来的解析副本写回
      // accessor，权威态会被换成新对象，而业务手里的 pd.backpack / pd.markers
      // 仍指向旧对象——同一条指令后续再改就改了个寂寞（静默丢写）。
      if (incoming === liveRow) {
        this.advanceWriteBaseline(incoming, diff);
        return true;
      }
      const submitted: Record<string, any> = {};
      for (const [field, value] of Object.entries(diff)) {
        submitted[field] = value;
        liveRow[field] = value;
      }
      this.advanceWriteBaseline(incoming, diff);
      return true;
    }

    // 混合态复活防线（Actor 合并路径）：incoming 携带未物化的原始背包（字符串形态，
    // 直读 prisma 行的特征）而活态已物化过货币时，incoming 的货币条目新鲜度不可知
    // ——正式库「陈旧钻石条目复活」事故形态。货币以活态列+物化条目为唯一权威：
    // 丢弃 incoming 的货币条目、保留活态物化条目，非货币改动照常合并。
    // （经 getPlayerData 物化的 incoming 走上方 diff 路径，不受本分支影响。）
    if (typeof incoming.backpack === 'string' && (liveRow as any)._currencyMaterialized) {
      const incomingBp = this.safeJsonParse<any[]>(incoming.backpack, []);
      const liveBp = this.safeJsonParse<any[]>(liveRow.backpack, []);
      if (Array.isArray(incomingBp) && Array.isArray(liveBp)) {
        const currencies = new Set(['钻石', '召唤券', '数据核心']);
        const trusted = liveBp.filter((it: any) => it && currencies.has(it.name));
        const merged = [
          ...incomingBp.filter((it: any) => it && !currencies.has(it.name)),
          ...trusted,
        ];
        incoming = { ...incoming, backpack: JSON.stringify(merged) };
      }
    }

    Object.assign(liveRow, incoming);
    // 活态 version 是权威：调用方快照携带的 version 不得回写拉低/顶替
    // （否则随后的 CAS 会拿调用方的版本号做条件，必然误报冲突）。
    if (incoming.version !== undefined) {
      liveRow.version = liveVersion;
    }
    return true;
  }

  /**
   * 写通过后把「本次读取的活态版本」回写到调用方快照上（自我推进基线）。
   *
   * ## 解决什么问题
   *
   * 旧快照拦截判定用的是「调用方快照的 version < 活态 version」，但**调用方自己
   * 每一次成功写入都会把活态 version 推进 1**，而调用方快照的 version 一直停在
   * 读取时刻。于是「读一次快照 → 连续写多次」的指令，第 2 次及以后的写入全被判成
   * 旧快照、在 strict 模式下被静默丢弃（`mergeIntoLiveState` 直接 return，调用方
   * 拿不到任何异常）——表现为「发指令看着成功、状态没生效」（冷却没写进去时
   * 同一指令还能无限连发）。
   *
   * ## 为什么这样是安全的
   *
   * 只在**合并已被接受**之后回写版本：真正陈旧（从未被接受过）的快照版本不变，
   * 仍会被拦截；而字段级投递（attachWriteMeta 的写基线 diff）本来就只提交「相对
   * 读取基线实际改过的字段」，回写版本不会让任何未改动字段进入活态。换言之，
   * 回写只是承认「这份快照刚刚贡献过、它的基线已经推进到那个版本」，而不是放宽
   * 整行搬运。
   */
  private rebaseSnapshotVersion(incoming: any, liveRow: any): void {
    if (!incoming || typeof incoming !== 'object') return;
    if (incoming === liveRow) return;
    if (incoming.version === undefined) return;
    const live = Number(liveRow?.version);
    if (!Number.isFinite(live)) return;
    incoming.version = live;
  }

  /**
   * 在玩家 Actor 邮箱内执行一个命令。命令只携带意图/字段 patch，不接收可回写的
   * Player 行对象；handler 每次都拿到该邮箱的唯一活态。
   *
   * 这是「命令化写模型」的入口：调用方描述**要做什么**，而不是把自己手上的
   * 状态快照交回来。命令在邮箱内基于最新活态应用（见 applyPlayerCommand），
   * 因此从根上不存在「调用方拿着 30 秒前的整行对象回写」的可能。
   *
   * @param userId 玩家 userId（唯一合法聚合键，行 id 不接受）
   * @param command 写意图
   * @param handler 可选的后续计算：在命令已应用、尚未落库时基于活态执行，
   *                返回值透传给调用方（如「扣完券后读最新余额」）
   */
  async dispatchCommand<T>(userId: number, command: PlayerCommand, handler?: (player: any) => Promise<T> | T): Promise<T | void> {
    const uid = this.requireUserId(userId);
    return this.enqueueUserWrite(uid, async () => {
      const data = await this.getPlayerData(uid);
      const player = data.player;
      this.applyPlayerCommand(player, command);
      const result = handler ? await handler(player) : undefined;
      await this.savePlayer(player);
      return result;
    });
  }

  /** 仅投递字段级 patch；所有字段都在邮箱内应用到最新活态。 */
  async patchPlayer(userId: number, patch: PlayerPatch, source = 'patch'): Promise<void> {
    await this.dispatchCommand(userId, { type: 'PATCH', patch, source });
  }

  /**
   * 命令应用器：在邮箱内基于活态执行，不接受 version/id/userId 等身份/并发元数据
   * 作为业务字段（它们由邮箱自己管，调用方无权提交）。
   *
   * 所有权约定：PATCH 的 JSON 字段**直接挂载到活态而不克隆**。业务拿到的
   * `ctx.markers` / `ctx.backpack` 本就是活态引用，「改完投递回邮箱」是主流写法，
   * 克隆反而会让调用方手里的引用与活态脱钩，同一条指令后续再改就改了个寂寞。
   * 代价是调用方投递后不应再改动该对象——即命令即所有权移交，这是 Actor 消息
   * 传递的常态（消息体归接收者所有）。
   */
  private applyPlayerCommand(player: any, command: PlayerCommand): void {
    switch (command.type) {
      case 'PATCH':
        for (const field of PLAYER_PATCH_FIELDS) {
          if (!hasOwn(command.patch, field)) continue;
          player[field] = (command.patch as any)[field];
        }
        return;
      case 'UPDATE_MARKERS': {
        const markers = asJsonValue<Record<string, any>>(player.markers, {});
        Object.assign(markers, cloneJson(command.changes));
        player.markers = markers;
        return;
      }
      case 'SET_MARKER': {
        const markers = asJsonValue<Record<string, any>>(player.markers, {});
        markers[command.name] = cloneJson(command.value);
        player.markers = markers;
        return;
      }
      case 'SET_ATTRIBUTE':
        player[command.attr] = Number(command.value);
        return;
      case 'ADJUST_ATTRIBUTE':
        player[command.attr] = Number(player[command.attr] ?? 0) + Number(command.delta);
        return;
    }
  }

  private requireUserId(userId: number): number {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) throw new Error(`无效的玩家 userId: ${String(userId)}`);
    return uid;
  }

  /**
   * 建档前校验 User 外键存在。
   *
   * 任何调用方误把 Player.id 当 userId 传进来时，在这里给出明确错误，绝不尝试
   * `player.create({ userId: 行id })`——那会以行 id 造出一条指向不存在 User 的
   * 孤儿档案，或直接撞外键约束（Foreign key constraint violated: userId），
   * 报错信息完全指不到真正的调用方。
   *
   * 用 `typeof ... === 'function'` 判定而非真值判定：PrismaClient 类型上
   * `user.findUnique` 恒为已定义，直接把函数引用写进条件会被 TS 判为恒真并报
   * TS2774（编译失败）。存量测试桩也可能没有 user 模型，两者都需兼容。
   */
  private async assertUserExists(uid: number): Promise<void> {
    const userModel = (this.prisma as any)?.user;
    if (typeof userModel?.findUnique !== 'function') return; // 测试桩无 user 模型：跳过校验
    const user = await userModel
      .findUnique({ where: { id: uid }, select: { id: true } })
      .catch(() => null);
    if (!user) {
      throw new NotFoundException(`用户 ${uid} 不存在，无法创建玩家档案（确认传入的是 userId 而非 Player.id）`);
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

    const scalarFields = [
      'level', 'exp', 'upgradeExp', 'name', 'baseName', 'type', 'specialSeq',
      'hp', 'maxHp', 'shield', 'maxShield', 'armor', 'maxArmor',
      'attack', 'defense', 'speed', 'dodge', 'hit', 'crit', 'critDmg',
      'regenHp', 'regenShield', 'regenArmor',
      'mapId', 'location', 'houseName',
      'currentWeapon', 'affinity', 'masterQQ', 'vitality',
      'lastOpTime', 'readTime', 'playTime', 'vehicle',
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
        // 落库边界统一收敛条目字段名（count→quantity 等历史别名在此彻底消失，
        // 保证 DB 中永远只有规范键；读档边界已收敛，这里是幂等的兜底）
        normalizeEntryList(items, 'item');
        // 判别「权威快照」：对象上有货币列字段说明它来自 getPlayerData 的完整读取，
        // 此时背包对三种货币有最终解释权（条目缺失=已花光=0）；
        // 手工构造的局部对象（无货币字段）只做「有条目才同步」的保守提取，
        // 避免把未加载的货币误清为 0。
        const authoritativeSnapshot = player.diamonds !== undefined
          || player.tickets !== undefined
          || player.dataCores !== undefined;
        // 列同步只信任经 materializeCurrencies 物化过的对象（_currencyMaterialized）：
        // 该标记等价于「这份背包是 getPlayerData 装载的完整态」。无标记的对象（手工
        // 构造的局部写、findUnique 原始行的历史遗留 JSON 条目）其条目新鲜度不可知——
        // 正式库事故即「陈旧钻石条目」经保守提取复活成权威余额（旧余额覆盖新余额的
        // 混合态）。此类对象一律：条目从背包 JSON 剥离（维持背包不含货币条目的
        // 不变量）、货币列保持原值不动、告警暴露。
        const materialized = (player as any)._currencyMaterialized === true;
        const pairs: Array<[string, string]> = [['钻石', 'diamonds'], ['召唤券', 'tickets'], ['数据核心', 'dataCores']];
        for (const [itemName, column] of pairs) {
          const idx = items.findIndex((it: any) => it?.name === itemName);
          if (idx >= 0) {
            if (materialized) {
              const value = Number(items[idx].quantity) || 0;
              updateData[column] = value;
              // 同步回内存快照：调用方（如 mutate 审计）保存后读取列值应与库一致
              (player as any)[column] = value;
            } else {
              this.logger.warn(
                `货币条目来自未物化对象(无_currencyMaterialized)，已剥离条目并保留列原值`
                + ` id=${player?.id ?? '未知'} column=${column} 条目值=${items[idx].quantity}`,
              );
            }
            items.splice(idx, 1);
          } else if (authoritativeSnapshot && materialized) {
            // 仅当对象经 getPlayerData 物化过货币（_currencyMaterialized 存在）时，
            // 背包条目缺失才算「已花光=0」；findUnique 原始行没有该标记，
            // 其背包本就不含物化条目——缺失只代表落库态未物化，绝不能据此清零，
            // 否则旧读档把整列背包回写会顺带把货币误清为 0
            // （「主线-继续询问」任务结算清空玩家钻石/召唤券的正式库事故根因防护）。
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
   * 乐观锁模式（环境变量 PLAYER_WRITE_CAS，默认 strict）：
   * - off：完全关闭 CAS，走无条件 update（$use 中间件自增 version）。
   * - log：按读取快照的 version 条件更新；count=0（快照已被他人推进）
   *   时记录冲突与调用方堆栈后强制写库——把「旧快照整包覆盖」从静默变成显式
   *   可观测，业务行为保持不变（运维回退模式，不再是默认）。
   * - strict（默认）：冲突直接抛错阻断，宁可让调用方重试也不用旧快照覆盖新写入。
   *   单进程 + Actor 邮箱下旁路写理论为零，CAS 命中即真实竞态，故默认让它立刻可见。
   * 存量测试桩手工 new PlayerService（无 updateMany mock）时自动退回无条件 update。
   */
  private static readonly CAS_MODE: 'off' | 'log' | 'strict' =
    (['off', 'log', 'strict'] as const).includes(process.env.PLAYER_WRITE_CAS as any)
      ? (process.env.PLAYER_WRITE_CAS as 'off' | 'log' | 'strict')
      : 'strict';

  /**
   * 真正的落库动作（非 Actor 感知，必由「不在 Actor 内」的路径调用）：
   * 普通 savePlayer 路径、以及 Actor 运行时 config.save 的写后落库都走这里，
   * 因此不会递归进入 Actor 分支。
   *
   * 串行邮箱是第一道防线（同玩家写操作严格排队），乐观锁是**最后一道**：即便
   * 有写路径绕过邮箱（旁路裸写、跨进程、未来接入的分布式邮箱），也会在这里被
   * 版本条件拦下，冲突显式暴露为错误日志/异常，而不是静默覆盖。
   */
  private async persistPlayer(player: any): Promise<void> {
    // 落库兜底闸（第四道闸）：任何漏过业务出口的三池浮点/负值写入在此收敛为
    // 「两位小数 + 不足 0.5 归零」，DB 不会存下 0.02 这类「面板显示 0、判定仍存活」的脏值。
    normalizePools(player);
    // 字段规范闸（落库唯一出口）：任何写入方即使写了历史别名键（数量/名称/count/
    // 有效期至…），此处一并收敛为规范英文键后落库，保证 DB 里同义字段只有一份。
    normalizePlayerRow(player);
    const updateData = this.buildPlayerUpdateData(player);
    // 全路径货币审计（P4 兜底）：mutate 管道内的审计只覆盖 mutate 链，这里在
    // 真正落库层兜底——Actor writeThrough / 邮箱路径 / 裸保存的货币变动同样入账。
    this.auditCurrencyWrite(player, updateData);
    const snapshotVersion = Number(player.version ?? 0);
    const canCas = PlayerService.CAS_MODE !== 'off'
      && !!player?.id
      && Number.isFinite(snapshotVersion)
      && typeof (this.prisma.player as any)?.updateMany === 'function';

    if (!canCas) {
      await this.prisma.player.update({
        // where 用 userId（unique）：write-inspect 靠 where.userId 判定归属，
        // where.id 是 Player 自增主键 ≠ userId，会让 UI 同步事件推错用户
        where: { userId: player.userId },
        data: updateData, // $use 中间件自动 version: { increment: 1 }
      });
      // 回写内存版本：保持快照与库一致（中间件已 +1）
      player.version = snapshotVersion + 1;
      return;
    }

    // 乐观锁 CAS：按读取时的 version 条件更新（updateMany 走 where {userId, id, version}，
    // 带上 userId 让 write-inspect 能正确解析归属，UI 同步广播不受影响）。
    const result = await this.prisma.player.updateMany({
      where: { id: player.id, userId: player.userId, version: snapshotVersion },
      data: { ...updateData, version: snapshotVersion + 1 },
    });
    if (result.count > 0) {
      player.version = snapshotVersion + 1;
      return;
    }
    // CAS 未命中：本快照落库前已被其他写者推进版本。
    const current = await this.prisma.player.findUnique({
      where: { id: player.id },
      select: { version: true },
    }).catch(() => null);
    const stack = (new Error('player-cas-conflict').stack ?? '')
      .split('\n')
      .slice(2, 7)
      .join('\n');
    // 可观测性计数（见 getWriteModelDiagnostics）
    this.writeModelStats.casConflict += 1;
    this.logger.error(
      `玩家乐观锁冲突: id=${player.id} 快照version=${snapshotVersion}`
      + ` 库内version=${current?.version ?? '未知'}`
      + ` (PLAYER_WRITE_CAS=${PlayerService.CAS_MODE})，调用方堆栈:\n${stack}`,
    );
    if (PlayerService.CAS_MODE === 'strict') {
      throw new Error(
        `玩家数据并发冲突(id=${player.id}, 快照version=${snapshotVersion})，本次写入已拒绝，请重试`,
      );
    }
    // log 模式：强制写（业务不中断），version 以库内最新为准推进。
    await this.prisma.player.update({
      where: { userId: player.userId }, // 归属判定靠 where.userId（Player.id ≠ userId）
      data: updateData, // $use 中间件自动 version: { increment: 1 }
    });
    player.version = Number(current?.version ?? snapshotVersion) + 1;
  }

  /**
   * 全路径货币审计（P4 兜底层）：本次落库若携带货币列且相对写基线（attachWriteMeta
   * 在载入时建立的快照，PLAYER_PATCH_FIELDS 含 diamonds/tickets/dataCores）发生
   * 变化，即写一条 CurrencyLog。before 取自内存基线，零额外查询；无基线的手工
   * 对象无从对比 before，跳过（mutate 链自有 ctx 前后审计覆盖）。
   *
   * 说明：mutate 链末端的统一落库也会经过这里，与 mutate.auditCurrencyChanges
   * 理论上可能各记一条——审计定位是异常侦测（正式库曾因管道未生效导致整表为空、
   * 事故零痕迹），允许少量重复，绝不接受漏记。写入失败仅告警，不影响落库主链路。
   */
  private auditCurrencyWrite(player: any, updateData: any): void {
    try {
      const meta: PlayerWriteMeta | undefined = player?.[PLAYER_WRITE_META];
      if (!meta?.baseline) return; // 手工对象无基线：无 before 可比，交给上层审计
      // mutate 链活跃时跳过：mutate 管道末尾的 auditCurrencyChanges 已按同一笔变动
      // 记账（before 取自 mutate 进入时的快照，更完整），这里再记会双份污染审计表。
      // 本兜底只覆盖「不经 mutate 管道」的落库（Actor writeThrough / 邮箱路径 / 裸保存）。
      const mutateUid = Number(player.userId ?? meta.userId ?? 0);
      if (mutateUid && this.mutateContext?.has(mutateUid)) return;
      const model = (this.prisma as any)?.currencyLog;
      if (typeof model?.create !== 'function') return; // 测试桩无 currencyLog 模型
      const pairs: Array<[string, string]> = [
        ['diamonds', '钻石'], ['tickets', '召唤券'], ['dataCores', '数据核心'],
      ];
      for (const [column, label] of pairs) {
        if (updateData[column] === undefined) continue;
        const before = Number(meta.baseline[column] ?? 0);
        const after = Number(updateData[column]);
        const delta = Number((after - before).toFixed(6));
        if (!Number.isFinite(delta) || delta === 0) continue;
        // 基线推进到本次落库值：同一对象重复落库不重复记同一笔 delta
        meta.baseline[column] = after;
        const stack = (new Error('currency-audit').stack ?? '')
          .split('\n')
          .slice(2, 5)
          .join(' <- ');
        void model
          .create({
            data: {
              userId: Number(player.userId ?? meta.userId ?? 0),
              currency: label,
              delta,
              balanceAfter: after,
            },
          })
          .catch((err: any) =>
            this.logger.warn(`货币审计写入失败 id=${player?.id} ${label}: ${err?.message || err}`),
          );
        this.logger.log(`货币变动审计 id=${player?.id} ${label} ${before} -> ${after} (Δ${delta}) 调用: ${stack}`);
        meta.currencyAuditDone = true;
      }
    } catch (err: any) {
      // 审计是旁路：任何异常不得影响业务结果
      this.logger.warn(`货币审计异常 id=${player?.id}: ${err?.message || err}`);
    }
  }

  /**
   * mutate 链完成自有货币审计后调用：把写基线推进到本次落库值。
   * 否则 Actor writeThrough 稍后的兜底审计仍以载入基线为 before，
   * 会把同一笔变动重复记账（mutate 一条 + writeThrough 一条）。
   */
  syncCurrencyBaseline(player: any): void {
    const meta: PlayerWriteMeta | undefined = player?.[PLAYER_WRITE_META];
    if (!meta?.baseline) return;
    for (const column of ['diamonds', 'tickets', 'dataCores'] as const) {
      if (player[column] !== undefined) meta.baseline[column] = Number(player[column]);
    }
  }

  /**
   * Actor 运行时 config.save 的落库入口：把整份 PlayerData 写回 player 表。
   *
   * 双表示收敛下（见 installCanonicalAccessors），行字段是读写都透传到顶层权威
   * 表示的 accessor——无论业务用哪种风格改（顶层 `ctx.backpack.push(...)` 还是
   * 行 `player.backpack = backpack`），改的都是同一份权威数据，落库
   * 经 asJsonValue 收敛后必然以最新权威态写入 Json 列。落库因此退化为单纯的
   * 整包写入，无需任何「基线对比 + 按侧猜测」的调和逻辑。
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
      'masterQQ', 'vitality', 'lastOpTime', 'readTime', 'playTime', 'vehicle',
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
      // 未升级也顺带修正可能过期的 upgradeExp 存量脏值：仅在对象本就携带该字段时
      // 覆写，门槛一律实时计算、不信任过期字段。
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

    // 原版 _计算玩家 等级成长（加成计算.ecode L1799-1833）：直接按公式覆盖上限
    // （对齐原版：1级玩家生命上限≈52，攻击=10）。
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

    // 三池封顶不在此处做：本方法拿不到装备/增益加成，按基础字段封顶会把
    // 计算上限（面板分母，含装备加成）的余量削掉——升级后当前值被砍回基础上限、
    // 奶回复按基础上限算，出现「生命 691/818 恒不满」。封顶统一收敛到
    // buildAttackerBonus 末尾（原版 _计算玩家 L2465 当前>属性.上限 时封顶的对应物）。
    this.logger.log(`玩家 ${player.userId} 等级 ${lv}，重算属性: 攻击=${player.attack} HP上限=${player.maxHp}`);
  }

  /** 获取玩家所在位置信息（地图ID与地图名称） */
  async getPlayerLocation(userId: number): Promise<{ mapId: number; mapName: string }> {
    // 走 getPlayerData：Actor 邮箱内读内存活态，避免 writeThrough 未落库时读到旧位置
    const pd = await this.getPlayerData(userId);
    const player = pd.player;

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

  /** 检查玩家是否死亡（hp <= 0） */
  isPlayerDead(player: any): boolean {
    return (player.hp || 0) <= 0;
  }

  /**
   * 三池「计算上限」（原版 玩家.属性.生命）——死亡复活半血基数。
   *
   * 计算上限的唯一出口是 `CombatSystemService.buildAttackerBonus`（含装备/套装/增益，
   * 即面板分母），与「三池第四道闸」口径一致。取不到（测试桩未注入 / 计算异常）时
   * 退回基础上限 `maxHp`，保证行为不劣化。
   *
   * 只用 player 自身可得的字段构造 playerData 入参，**绝不重新读档**——避免在既有
   * mutate/Actor 链里产生第二份快照（快照覆盖 bug 的根因）。
   */
  private resolveCombatCapHp(player: any, playerData?: any): number {
    const baseMax = Number(player?.maxHp ?? player?.生命上限 ?? player?.属性?.生命 ?? 0);
    const fallback = Number.isFinite(baseMax) && baseMax > 0 ? baseMax : 100;
    const bonusBuilder = this.combatSystem?.buildAttackerBonus;
    if (typeof bonusBuilder !== 'function') return fallback;
    try {
      const parsedMarkers = playerData?.markers
        ?? (player?.markers && typeof player.markers === 'object'
          ? player.markers
          : this.safeJsonParse<any>(player?.markers, {}));
      const pd = {
        player,
        weapons: Array.isArray(playerData?.weapons)
          ? playerData.weapons : this.safeJsonParse<any[]>(player?.weapons, []),
        equipment: Array.isArray(playerData?.equipment)
          ? playerData.equipment : this.safeJsonParse<any[]>(player?.equipment, []),
        buffs: Array.isArray(playerData?.buffs)
          ? playerData.buffs : this.safeJsonParse<any[]>(player?.buffs, []),
        markers: parsedMarkers,
      };
      const bonus = bonusBuilder(player, pd);
      const cap = Number(bonus?.生命);
      if (Number.isFinite(cap) && cap > 0) return cap;
    } catch (e: any) {
      this.logger.warn(`计算上限取值失败，复活基数退回基础上限: ${e?.message ?? e}`);
    }
    return fallback;
  }

  /**
   * 原版「玩家死亡」判定与复活级联（战斗相关.ecode L5173-5227）。
   *
   * **唯一实现**：`deathGateText`（指令/技能门禁）与 `CombatSystemService.playerDeath`
   * （战斗结算）都调用本方法；禁止任何地方再复写第二份级联。
   *
   * 判定顺序 1:1 对齐原版 `.判断` 链——原版每条分支都带显式返回，短路语义必须保留：
   *   当前生命 > 0                                     → 不死
   *   增益「卷土重来」（原版 L5182-5184）                → 免死放行（返回假，指令继续）
   *   军姬(使魔 16) + 本图存活宠物 + `sf` 60s 就绪        → 半血复活；不满足则继续往下判
   *   装备「死亡行者」(装备 16) 90s 就绪                 → 半血复活；冷却中 → 直接真死
   *   持有「石中剑」(武器 -35) 90s 就绪                  → 半血复活；冷却中 → 直接真死
   *   否则                                             → 真死
   *
   * 只读判定 + **原地改写** hp / markers2 / 额外文本，本方法自身不落库：
   * 持久化由调用方收尾保存，或 `deathGateText` 统一执行一次。
   */
  resolvePlayerDeath(
    player: any,
    playerData?: { buffs?: any; equipment?: any; weapons?: any; markers?: any; map?: any },
  ): { dead: boolean; reviveText: string; deathText: string } {
    if (!player) return { dead: false, reviveText: '', deathText: '' };
    const deathText = `${player.name || '冒险者'}已经死掉了!你可以"复活使魔"或者"删除怪物"`;

    const nowMs = Date.now();
    // 运行时对象（召唤物/怪物/载具）生命存于 currentHp，存在时才一并同步
    const curHp = Number(player.hp ?? player.currentHp ?? 0);
    if (curHp > 0) return { dead: false, reviveText: '', deathText: '' };

    const buffs = Array.isArray(playerData?.buffs)
      ? playerData!.buffs : this.safeJsonParse<any[]>(player.buffs, []);
    const equipment = Array.isArray(playerData?.equipment)
      ? playerData!.equipment : this.safeJsonParse<any[]>(player.equipment, []);
    const weapons = Array.isArray(playerData?.weapons)
      ? playerData!.weapons : this.safeJsonParse<any[]>(player.weapons, []);
    const markers2 = this.safeJsonParse<any[]>(player.markers2, []);
    // 原版 `玩家.当前生命 = 玩家.属性.生命 / 2`：基数必须是**计算上限**
    // （含装备/套装/增益，即面板分母）。禁用 player.maxHp 作首选——它是
    // recalcLevelStats 写的**基础上限**，装备加成余量会被削掉（见本文件
    // recalcLevelStats 注释「不得按基础字段封顶」）。取不到计算上限才退回基础上限。
    const maxHp = this.resolveCombatCapHp(player, playerData);

    /** 追加 玩家.额外文本（原版以 "#换行" 起首，输出层统一转真实换行） */
    const appendExtra = (text: string): string => {
      const line = `#换行${text}`;
      player.额外文本 = `${player.额外文本 ?? ''}${line}`;
      return line;
    };
    /** 原版 装备要求(玩家, seq, , 真)：武器与装备任一命中即可 */
    const ownsSpecialSeq = (seq: number): boolean =>
      [...weapons, ...equipment]
        .some((it: any) => it && Number(it.specialSeq ?? NaN) === seq);
    /** 半血复活 + 写冷却标记（原版 当前生命 = 属性.生命 / 2） */
    const revive = (label: string, cdKey: string, cdSec: number) => {
      const half = normalizePoolValue(maxHp / 2);
      player.hp = half;
      if ('currentHp' in player) player.currentHp = half;
      const next = markers2.filter((m: any) => itemName(m) !== cdKey);
      next.push({ name: cdKey, expireAt: expireAfter(cdSec, nowMs) });
      player.markers2 = next;
      this.logger.log(`玩家 ${player.userId ?? ''} 死亡状态下被「${label}」复活（HP ${half}）`);
      return { dead: false, reviveText: appendExtra(`死亡状态下被${label}复活`), deathText: '' };
    };
    /** 冷却键是否仍在生效（原版 时间间隔要求(...) == 真） */
    const cdActive = (key: string): boolean => !!findActive(markers2, key, nowMs);

    // 卷土重来（原版 L5182-5184）：返回假 → 指令继续执行
    const comeback = findActive(buffs, '卷土重来', nowMs);
    if (comeback) {
      return {
        dead: false,
        reviveText: appendExtra(`卷土重来${formatRemain(remainSeconds(comeback, nowMs))}`),
        deathText: '',
      };
    }

    // 灵魂石（装备 70；原版 战斗相关.ecode L3798-3805）：能量满 100%（击杀储 4 层，每层 25%）
    // 时死亡 → 三池回满并清零能量。层数由 CombatSystemService 的击杀结算写入（同一标记键）。
    // 放在 军姬/死亡行者/石中剑 之前：原版这段就在 造成伤害 的死亡处理里，早于 玩家死亡 级联，
    // 且它是"满血复活"，与后面几个半血复活互斥（先命中即返回，不会双重回血）。
    if (ownsSpecialSeq(70)) {
      const soulMarkers = this.safeJsonParse<Record<string, any>>(player.markers ?? {}, {});
      const soulStacks = Number(soulMarkers?.['灵魂石'] ?? 0);
      if (soulStacks >= 4) {
        player.hp = maxHp;
        if ('currentHp' in player) player.currentHp = maxHp;
        player.shield = Number(player.maxShield ?? player.shield ?? 0);
        player.armor = Number(player.maxArmor ?? player.armor ?? 0);
        soulMarkers['灵魂石'] = 0;
        player.markers = soulMarkers; // Json 列直接写对象
        this.logger.log(`玩家 ${player.userId ?? ''} 死亡状态下被「灵魂石」复活（三池回满）`);
        return { dead: false, reviveText: appendExtra('被灵魂石复活'), deathText: '' };
      }
    }

    // 军姬（原版 L5185-5199）：有存活宠物且 sf 冷却就绪才复活，否则继续往下判
    if (Number(player.specialSeq ?? 0) === 16 || player.type === '军姬') {
      const summons = this.safeJsonParse<any[]>(playerData?.map?.summons, []);
      const alivePet = summons.some((s: any) => s
        && (s.userId === player.qqNumber || s.userId === player.userId)
        && Number(s.hp ?? 0) > 0);
      if (alivePet && !cdActive('sf')) {
        return revive('"森罗万象"', 'sf', 60);
      }
    }

    // 死亡行者（原版 L5204-5212）：装备序号 16；冷却中直接真死（原版返回真，不试石中剑）
    if (ownsSpecialSeq(16)) {
      if (cdActive('死亡行者')) return { dead: true, reviveText: '', deathText };
      return revive('死亡行者', '死亡行者', 90);
    }

    // 石中剑（原版 L5214-5222）：武器序号 -35（原版 装备要求(..., 真) = 含武器）
    // 冷却按描述取 60 秒（描述「恢复50%生命，冷却60秒」；原版此处置 90）。
    if (ownsSpecialSeq(-35)) {
      if (cdActive('石中剑')) return { dead: true, reviveText: '', deathText };
      return revive('石中剑', '石中剑', 60);
    }

    return { dead: true, reviveText: '', deathText };
  }

  /**
   * 指令/技能死亡门禁（对齐原版 玩家死亡 返回 真/假 语义）。
   *
   * @returns null=可继续（未死 / 卷土重来免死 / 已复活）；字符串=真死提示，调用方直接 return
   */
  async deathGateText(player: any): Promise<string | null> {
    if (!this.isPlayerDead(player)) return null;
    // 军姬复活需要本图存活宠物：只在真死路径上按需读图，正常指令零开销
    let map: any;
    if (Number(player?.specialSeq ?? 0) === 16 || player?.type === '军姬') {
      map = await this.mapService.getMapById(player.mapId).catch(() => null);
    }
    const result = this.resolvePlayerDeath(player, { map });
    if (result.dead) return result.deathText;
    // 复活是持久状态变更：统一落库一次（savePlayer 在 mutate/Actor 链内退化为合并+标脏）
    if (result.reviveText) await this.savePlayer(player);
    return null;
  }

  /** 获取玩家背包中的物品数组（兼容 Json 列对象与历史字符串两种形态） */
  getBackpackItems(player: any): any[] {
    const backpack = player.backpack;
    if (typeof backpack === 'string') {
      return this.safeJsonParse<any[]>(backpack, []);
    }
    return Array.isArray(backpack) ? backpack : [];
  }

  /** 添加物品到背包：普通物品按名自动叠加数量，装备按原版「生成装备」路径生成独立条目 */
  async addToBackpack(userId: number, itemName: string, count: number): Promise<boolean> {
    try {
      // 读、改、写全部放入 enqueueUserWrite 内完成：基于 Actor 内存活态修改背包。
      // 在邮箱外读 DB 行副本、改完再整包写回时，活态里未落库的改动
      // （如战斗刚掉落的物品）会被覆盖，造成丢失更新。
      await this.enqueueUserWrite(userId, async () => {
        const _pd = await this.getPlayerData(userId);
        const backpack = this.getBackpackItems(_pd.player);

        // 装备/武器（静态装备表有定义，如高斯步枪、麻醉枪）不走普通物品的「堆叠」逻辑：
        // 按原版"生成装备"路径卷随机词条生成，每个装备占独立一条（type='装备'、quantity=1），
        // 保证背包能以"装备"身份显示（不显示 ×N）、并能被解析出词条/伤害正常装备。
        // 否则 addToBackpack 只会写成 { name, count } 占位条目，既无 type='装备'（无法装备），
        // 也无 data 词条（伤害/属性恒为 0）。
        const isEquip = !!this.staticData.getEquipmentByName(itemName);
        if (isEquip) {
          // 清理背包里以普通物品占位存下的同名条目，避免与真实装备并存。
          for (let i = backpack.length - 1; i >= 0; i--) {
            if (backpack[i]?.name === itemName && backpack[i]?.type !== '装备') backpack.splice(i, 1);
          }
          // 装备不堆叠：发放 N 个就生成 N 条独立装备（与掉落/采集生成逻辑一致）。
          const times = Math.max(1, Math.floor(count || 1));
          for (let i = 0; i < times; i++) {
            let gear: any = { name: itemName, type: '装备', quantity: 1, durability: 0, data: 'e' };
            if (this.itemSystem) {
              try {
                gear = await this.itemSystem.generateRewardEquipment(itemName);
              } catch (e) {
                this.logger.warn(`生成装备「${itemName}」失败，退化为静态条目: ${e?.message ?? e}`);
              }
            }
            // 入包走唯一出口（装备不合并；出口兜底保证品质码不变量）
            mergeBackpackItem(
              backpack,
              { ...gear, name: gear?.name || itemName, type: '装备', quantity: 1 },
              lookupFromStaticData(this.staticData),
            );
          }
        } else {
          // 普通物品：走背包写入唯一出口（按名合并、type 以静态定义为唯一真源、
          // 数量只写规范键 quantity + 两位小数收敛），不在此手写合并逻辑
          const qty = roundItemQuantity(count);
          mergeBackpackItem(
            backpack,
            { name: itemName, quantity: qty },
            lookupFromStaticData(this.staticData),
          );
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
        // 数量只读规范键 quantity（count/数量 等别名已由持久化边界收敛，见 field-contract.util.ts）
        const currentCount = Number(item.quantity ?? 0);

        if (currentCount < count) {
          this.logger.warn(`移除物品失败：${itemName} 数量不足（需要 ${count}，拥有 ${currentCount}）`);
          return false;
        }

        if (currentCount === count) {
          backpack.splice(index, 1);
        } else {
          // 减少数量（只写规范键 quantity，清理历史别名 count 避免歧义）
          item.quantity = currentCount - count;
          if ('count' in item) delete item.count;
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
   * 检查玩家是否有某个标记。
   * 数组形态看是否存在同名条目，字典形态看键是否存在；两者都由共享口径判定。
   * @param markers 标记容器（已解析对象/数组，或 Json 列历史字符串）
   */
  hasMarker(markers: any, name: string): boolean {
    const parsed = typeof markers === 'string' ? this.safeJsonParse<any>(markers, {}) : markers;
    if (Array.isArray(parsed)) return parsed.some((it: any) => it && it.name === name);
    return parsed?.[name] !== undefined && parsed?.[name] !== null;
  }

  /**
   * 获取标记的数值（标记读取唯一口径，数组/字典两种形态通用，缺失返回 0）。
   * @param markers 标记容器（已解析对象/数组，或 Json 列历史字符串）
   */
  getMarkerValue(markers: any, name: string): number {
    const parsed = typeof markers === 'string' ? this.safeJsonParse<any>(markers, {}) : markers;
    return readMarkerValue(parsed, name);
  }

  /**
   * 设置标记（标记写入唯一口径：数组写 { name, value }、字典按键赋值，原地修改）。
   * 传入字符串（Json 列原始值）时无法原地写回，调用方必须先解析为对象/数组。
   */
  setMarker(markers: any, name: string, value: number): void {
    if (!markers || typeof markers !== 'object') return;
    writeMarkerValue(markers, name, value);
  }
}
