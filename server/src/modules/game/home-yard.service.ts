/**
 * 家园院子格子视图装配服务（只读）。
 *
 * 面向 Web 端「家园」独立页面：把家园的聚合存储（GameMap.buildings 建筑、
 * GameMap.resources2 作物与地面障碍）投影成 QQ 农场式的"一格一格"地块数组，
 * 并附带玩家背包里可种植 / 可安装的库存，供玩家直接在格子上操作。
 *
 * 设计约定（务必遵守）：
 * 1. **只读**：本服务不写任何数据、不推进观测时间、不领取产出。所有变更依旧
 *    由 QQ / 网页统一的指令通道（种植 / 收获 / 安装 / 拆除 / 产出）执行，
 *    杜绝出现第二条写路径造成结算双轨。
 * 2. **聚合展开**：后端按"名称 + 数量"聚合存储，这里把 count=N 展开为 N 个
 *    地块；对某一格执行收获 / 拆除即等于该名称数量 -1，与指令语义天然一致。
 * 3. **上限即地块数**：作物上限 cropLimit、建筑上限 buildingLimit 就是当前可用
 *    地块总数（原版由玩家等级与凭证决定），超额部分渲染为待开垦（locked）。
 */

import { Injectable, Logger } from '@nestjs/common';
import { PlayerService } from './player.service';
import { MapService } from './map.service';
import { StaticDataService } from './static-data.service';
import { HomeService, HomeSettlement } from './home.service';
import { HOME_YARD_CONFIG } from './home-yard.config';
import { asJsonValue } from '../../common/utils/json-value.util';

// ==================== DTO ====================

/** 速率/数量条目：quantity 允许为负，负数表示消耗 */
export interface HomeYardRate {
  name: string;
  quantity: number;
}

/** 作物生长阶段信息（分阶段成熟玩法；建筑地块无此字段） */
export interface HomeYardCropStage {
  /** 当前阶段下标（0 基，播种=0） */
  index: number;
  /** 阶段总数（4~5） */
  total: number;
  /** 阶段名称数组（如 播种/发芽/生长/开花/成熟） */
  names: string[];
  /** 生长进度 0~1（用于进度条） */
  progressPct: number;
  /** 剩余成熟秒数（成熟为 0） */
  remainSeconds: number;
  /** 是否已成熟（成熟后才能收获） */
  ripe: boolean;
  /** 总成熟秒数 */
  totalSeconds: number;
}

/** 单个地块 */
export interface HomeYardPlot {
  /** 地块序号（0 基，前端可直接当 key） */
  index: number;
  /** 地块用途：作物田 / 建筑区 */
  kind: 'crop' | 'building';
  /** occupied=已种植(安装)、empty=已开垦空闲、locked=待开垦 */
  state: 'occupied' | 'empty' | 'locked';
  /** 作物名 / 建筑名（空地与待开垦为空串） */
  name: string;
  /** 同名事物在院子里的总数量（用于「拆除全部 N 个」这类批量指令） */
  total: number;
  /** 每分钟产出（负数=消耗）；作物进入分阶段成熟玩法后此字段恒为空 */
  outputs: HomeYardRate[];
  /** 一次性可得：作物=成熟收获产出，建筑=拆除返还 */
  harvest: HomeYardRate[];
  /** 作物生长阶段（仅 occupied 作物格有值；建筑格为 undefined） */
  stage?: HomeYardCropStage;
  description: string;
  /** 待开垦地块的解锁提示文案 */
  unlockHint: string;
}

/** 仓库条目：背包里可以种下去 / 装上去的东西 */
export interface HomeYardStock {
  /** 背包中的物品名（种子名或建筑名，指令直接消费） */
  name: string;
  kind: 'seed' | 'building';
  /** 背包持有数量 */
  quantity: number;
  /** 种下 / 安装后出现在地块上的名字 */
  target: string;
  description: string;
  /** 种下 / 安装后的每分钟产出（负数=消耗） */
  outputs: HomeYardRate[];
}

/** 一片区域（作物田或建筑区） */
export interface HomeYardArea {
  /** 已占用地块数 */
  used: number;
  /** 已开垦地块数（等级 + 凭证决定） */
  limit: number;
  plots: HomeYardPlot[];
}

/** 地面障碍（土堆/杂草等，需先清理） */
export interface HomeYardObstacle {
  name: string;
  count: number;
  description: string;
  /** 清理该障碍的采集指令（如「挖土」「割草」） */
  clearCmd: string;
}

/** 家园院子全量视图 */
export interface HomeYardInfo {
  /** 早退原因（无家园/地图丢失等）；存在时其余字段为空投影 */
  blocked?: string;
  houseName: string;
  /** 玩家当前是否站在自己的院子里（种植/安装/拆除/收获都需要人在院子） */
  atHome: boolean;
  /** 家园建造进度（4=已建成） */
  progress: number;
  level: number;
  /** 凭证数量（影响地块上限） */
  vouchers: number;
  crop: HomeYardArea;
  building: HomeYardArea;
  obstacles: HomeYardObstacle[];
  /** 背包里可种植的种子 */
  seeds: HomeYardStock[];
  /** 背包里可安装的建筑 */
  buildings: HomeYardStock[];
  /** 背包资源类物品按名聚合的存量（建造引导「已有 X」用；装备不计入） */
  materials: Record<string, number>;
  /** 院子存放地（产出堆）快照 */
  storage: HomeYardRate[];
  /** 复用既有只读总览（电力/产出速率等），前端无需再单独请求 */
  overview: HomeSettlement | null;
  /** 服务端清障排队快照：[{ cmd: '挖土', count: 3 }]，刷新/换端不丢 */
  clearQueue: Array<{ cmd: string; count: number }>;
}

@Injectable()
export class HomeYardService {
  private readonly logger = new Logger(HomeYardService.name);

  constructor(
    private readonly playerService: PlayerService,
    private readonly mapService: MapService,
    private readonly staticData: StaticDataService,
    private readonly homeService: HomeService,
  ) {}

  /**
   * 装配家园院子格子视图（只读，不结算、不写库）。
   *
   * @param userId 当前登录用户 ID
   * @returns 院子视图 DTO；家园不存在时返回 blocked
   */
  async getHomeYard(userId: number): Promise<HomeYardInfo> {
    const emptyArea: HomeYardArea = { used: 0, limit: 0, plots: [] };
    const emptyYard = (blocked: string, extra: Partial<HomeYardInfo> = {}): HomeYardInfo => ({
      blocked,
      houseName: extra.houseName ?? '',
      atHome: extra.atHome ?? false,
      progress: extra.progress ?? 0,
      level: extra.level ?? 1,
      vouchers: extra.vouchers ?? 0,
      crop: extra.crop ?? emptyArea,
      building: extra.building ?? emptyArea,
      obstacles: extra.obstacles ?? [],
      seeds: extra.seeds ?? [],
      buildings: extra.buildings ?? [],
      materials: extra.materials ?? {},
      storage: extra.storage ?? [],
      overview: extra.overview ?? null,
      clearQueue: extra.clearQueue ?? [],
    });

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (!player) return emptyYard('玩家档案不存在');

    const markers = asJsonValue<any>(player.markers, {});
    const houseName = String(player.houseName ?? '').trim();
    const level = Number(player.level ?? 1) || 1;
    const progress = Number(this.playerService.getMarkerValue(markers, '家园进度') ?? 0) || 0;
    const vouchers = Number(markers?.['凭证'] ?? 0) || 0;
    const base = { houseName, level, progress, vouchers };

    if (!houseName) return emptyYard('还没有家园，先发送「圈地」选一块地吧', base);

    const map = await this.mapService.getMapByName(houseName).catch(() => null);
    if (!map) return emptyYard('家园所在的地图不存在', base);

    // 玩家是否在家：种植/安装/拆除/收获都要求人站在自己的院子里
    const currentMap = await this.mapService.getMapById(player.mapId).catch(() => null);
    const atHome = !!currentMap && String(currentMap.name ?? '') === houseName;

    // 复用既有只读总览：电力/燃料/每日速率等一站取回，且绝不推进观测时间
    const overview = await this.homeService.getHomeOverview(userId).catch(() => null);

    const resources2 = asJsonValue<any[]>(map.resources2, []);
    const buildingEntries = asJsonValue<any[]>(map.buildings, []);

    // ---- 作物与地面障碍：原版以「产出2 是否为空」区分 ----
    const cropSlots: Array<{
      name: string;
      count: number;
      plantedAt?: number;
      outputs: HomeYardRate[];
      harvest: HomeYardRate[];
      description: string;
    }> = [];
    const obstacles: HomeYardObstacle[] = [];
    for (const resource of resources2) {
      const name = this.nameOf(resource);
      if (!name) continue;
      const count = Math.max(1, Math.round(this.countOf(resource)) || 1);
      const outputs = this.toRates(resource?.outputs2 ?? resource?.['产出2'] ?? []);
      if (outputs.length > 0) {
        const def = this.findResourceDef(name);
        // 分阶段成熟玩法：收获收益 = 产出2 正收益 × 成熟总秒数/600（整周期掉落）
        const plan = this.homeService.getCropGrowthPlan(name);
        const harvestRate = plan.totalSeconds / plan.rewardScaleDivisor;
        cropSlots.push({
          name,
          count,
          // 每粒种子独立的种植时间戳；旧聚合存档没有该字段（buildCropStage 里按已成熟处理）
          plantedAt: Number(resource?.plantedAt ?? resource?.['种植时间'] ?? 0) || undefined,
          outputs: [],
          harvest: outputs
            .filter((item) => item.quantity > 0 && item.name !== '电力')
            .map((item) => ({
              name: item.name,
              quantity: Math.round(item.quantity * harvestRate * 100) / 100,
            })),
          description: String(def?.description ?? resource?.description ?? ''),
        });
        continue;
      }
      const def = this.findResourceDef(name);
      obstacles.push({
        name,
        count,
        description: String(def?.description ?? resource?.description ?? ''),
        clearCmd: String(def?.gatherCmd ?? resource?.gatherCmd ?? '').trim(),
      });
    }

    // ---- 建筑：只认建筑定义，兼容旧数据里误写入 buildings 的作物 ----
    const buildingSlots: Array<{ name: string; count: number; outputs: HomeYardRate[]; harvest: HomeYardRate[]; description: string }> = [];
    for (const entry of buildingEntries) {
      const name = this.nameOf(entry);
      if (!name) continue;
      const def = this.staticData.getBuildingByName(name);
      if (!def) continue; // 非建筑（旧作物数据等）不占建筑地块
      const count = Math.max(1, Math.round(this.countOf(entry)) || 1);
      const materials = this.toRates(def?.materials ?? def?.['材料'] ?? []);
      buildingSlots.push({
        name,
        count,
        outputs: materials,
        // 拆除返还：原版只对消耗项返还 50%（向下取整）
        harvest: materials
          .filter((item) => item.quantity < 0)
          .map((item) => ({ name: item.name, quantity: Math.floor(Math.abs(item.quantity) * 0.5) }))
          .filter((item) => item.quantity > 0),
        description: String(def?.description ?? ''),
      });
    }

    const crop = this.buildArea({
      kind: 'crop',
      level,
      limit: Number(overview?.overview?.cropLimit ?? 0) || 0,
      slots: cropSlots,
    });
    const building = this.buildArea({
      kind: 'building',
      level,
      limit: Number(overview?.overview?.buildingLimit ?? 0) || 0,
      slots: buildingSlots,
    });

    // ---- 背包库存：可种植的种子 + 可安装的建筑 + 建造材料存量 ----
    const backpack = this.playerService.getBackpackItems(player);
    const seeds: HomeYardStock[] = [];
    const buildings: HomeYardStock[] = [];
    /** 背包资源类物品按名聚合：建造引导要展示「已拥有」数量（木头/石头/铁矿/绳子等） */
    const materials: Record<string, number> = {};
    for (const item of backpack) {
      const name = this.nameOf(item);
      if (!name) continue;
      const quantity = this.countOf(item);
      if (quantity <= 0) continue;

      const itemType = String((item as any)?.type ?? (item as any)?.['类型'] ?? '').trim();
      if (itemType !== '装备') {
        materials[name] = (materials[name] || 0) + quantity;
      }

      const buildingDef = this.staticData.getBuildingByName(name);
      if (buildingDef) {
        if (buildings.length < HOME_YARD_CONFIG.stockDisplayLimit) {
          buildings.push({
            name,
            kind: 'building',
            quantity,
            target: name,
            description: String(buildingDef?.description ?? ''),
            outputs: this.toRates(buildingDef?.materials ?? buildingDef?.['材料'] ?? []),
          });
        }
        continue;
      }
      const seed = this.resolveSeedTarget(name);
      if (seed && seeds.length < HOME_YARD_CONFIG.stockDisplayLimit) {
        seeds.push({
          name,
          kind: 'seed',
          quantity,
          target: seed.cropName,
          description: seed.description,
          outputs: seed.outputs,
        });
      }
    }

    const storage = (overview?.storage ?? [])
      .filter((item) => Number(item?.quantity ?? 0) > 0)
      .slice(0, HOME_YARD_CONFIG.storageDisplayLimit)
      .map((item) => ({ name: item.name, quantity: item.quantity }));

    // 服务端清障队列（挖土/割草连点排队）：刷新页面仍可见
    const clearQueueRaw = asJsonValue<any[]>(markers['清障队列'], []);
    const clearQueue: Array<{ cmd: string; count: number }> = [];
    if (Array.isArray(clearQueueRaw)) {
      for (const item of clearQueueRaw) {
        const cmd = String(item || '').trim();
        if (!cmd) continue;
        const last = clearQueue[clearQueue.length - 1];
        if (last && last.cmd === cmd) last.count += 1;
        else clearQueue.push({ cmd, count: 1 });
      }
    }

    return {
      blocked: overview?.blocked,
      houseName,
      atHome,
      progress,
      level,
      vouchers,
      crop,
      building,
      obstacles,
      seeds,
      buildings,
      /** 背包资源存量 map（引导卡片「已有 X/需要 Y」用；装备不计入） */
      materials,
      storage,
      overview: overview ?? null,
      clearQueue,
    };
  }

  // ==================== 内部工具 ====================

  /**
   * 把聚合条目（名称 + 数量）展开成地块数组。
   * 已占用的格数可能超过上限（历史数据 / 凭证过期），此时全部渲染为 occupied，
   * 不再补空地；上限之外补 lockedPreviewPlots 个待开垦地块作为解锁目标。
   * 作物格附带生长阶段信息（stage），未成熟的格由前端禁用收获。
   */
  private buildArea(args: {
    kind: 'crop' | 'building';
    level: number;
    limit: number;
    slots: Array<{
      name: string;
      count: number;
      plantedAt?: number;
      outputs: HomeYardRate[];
      harvest: HomeYardRate[];
      description: string;
    }>;
  }): HomeYardArea {
    const plots: HomeYardPlot[] = [];
    const pushPlot = (plot: Omit<HomeYardPlot, 'index'>) => {
      plots.push({ index: plots.length, ...plot });
    };

    for (const slot of args.slots) {
      for (let i = 0; i < slot.count; i += 1) {
        pushPlot({
          kind: args.kind,
          state: 'occupied',
          name: slot.name,
          total: slot.count,
          outputs: slot.outputs.slice(0, HOME_YARD_CONFIG.outputsPerPlot),
          harvest: slot.harvest.slice(0, HOME_YARD_CONFIG.outputsPerPlot),
          // 作物格计算生长阶段；建筑格不参与
          stage: args.kind === 'crop' ? this.buildCropStage(slot.name, slot.plantedAt) : undefined,
          description: slot.description,
          unlockHint: '',
        });
      }
    }

    const used = plots.length;
    const unlocked = Math.max(args.limit, used);
    while (plots.length < unlocked) {
      pushPlot({
        kind: args.kind,
        state: 'empty',
        name: '',
        total: 0,
        outputs: [],
        harvest: [],
        description: '',
        unlockHint: '',
      });
    }
    for (let i = 1; i <= HOME_YARD_CONFIG.lockedPreviewPlots; i += 1) {
      pushPlot({
        kind: args.kind,
        state: 'locked',
        name: '',
        total: 0,
        outputs: [],
        harvest: [],
        description: '',
        unlockHint: this.buildUnlockHint(args.kind, args.level, i),
      });
    }

    return { used, limit: unlocked, plots };
  }

  /**
   * 待开垦地块的解锁提示：按原版上限公式反推所需等级。
   * 作物上限 = ceil(等级/5) + 凭证×5；建筑上限 = ceil(等级/20) + 凭证 + 2。
   *
   * @param nth 第几个待开垦地块（1 基）
   */
  private buildUnlockHint(kind: 'crop' | 'building', level: number, nth: number): string {
    const step = kind === 'crop'
      ? HOME_YARD_CONFIG.cropLevelStep
      : HOME_YARD_CONFIG.buildingLevelStep;
    const needLevel = (Math.ceil(level / step) + nth - 1) * step + 1;
    return `等级 ${needLevel} 或使用凭证开垦`;
  }

  /**
   * 解析种子 → 可种植作物的映射。
   * 与 HomeService.plantSeed 同源：优先取物品使用效果的第一项，其次去掉「种子」后缀，
   * 命中资源定义且产出2 非空才算可种（否则它只是个普通物品）。
   */
  private resolveSeedTarget(seedName: string): { cropName: string; outputs: HomeYardRate[]; description: string } | null {
    // 兼容「椰树种子1」这类带数量后缀的背包写法
    const bare = seedName.replace(/\d+$/, '').trim();
    const def = this.staticData.getItemByName(bare) ?? this.staticData.getItemByName(seedName);
    const useEffects = asJsonValue<any[]>(def?.useEffects ?? def?.['使用效果'] ?? [], []);
    const first = useEffects
      .flatMap((effect: any) => String(effect ?? '').split(/[，,、]/))
      .map((text: string) => text.trim())
      .find(Boolean) || '';
    const cropName = first || (seedName.endsWith('种子') ? seedName.slice(0, -2) : '');
    if (!cropName) return null;

    const resourceDef = this.findResourceDef(cropName);
    if (!resourceDef) return null;
    const outputs = this.toRates(resourceDef?.outputs2 ?? resourceDef?.['产出2'] ?? []);
    if (outputs.length === 0) return null;
    return {
      cropName,
      outputs,
      description: String(resourceDef?.description ?? def?.description ?? ''),
    };
  }

  /**
   * 计算作物当前生长阶段（与 HomeService.harvestCrop 的成熟判定同口径）。
   * - 有 plantedAt：按 (now - plantedAt) 与总时长换算阶段下标与剩余时间；
   * - 无 plantedAt（旧聚合存档/历史数据）：视为已成熟，方便旧数据直接收获。
   */
  private buildCropStage(cropName: string, plantedAt?: number): HomeYardCropStage {
    const plan = this.homeService.getCropGrowthPlan(cropName);
    const stageCount = Math.max(1, plan.stageNames.length);
    const now = Date.now() / 1000;
    const elapsed = plantedAt ? Math.max(0, now - plantedAt) : plan.totalSeconds;
    const ripe = elapsed >= plan.totalSeconds;
    return {
      index: ripe ? stageCount - 1 : Math.min(stageCount - 1, Math.floor(elapsed / (plan.totalSeconds / stageCount))),
      total: stageCount,
      names: plan.stageNames,
      progressPct: ripe ? 1 : Math.min(1, elapsed / plan.totalSeconds),
      remainSeconds: ripe ? 0 : Math.max(1, Math.ceil(plan.totalSeconds - elapsed)),
      ripe,
      totalSeconds: plan.totalSeconds,
    };
  }

  private findResourceDef(name: string): any | null {
    return this.staticData.getAllResources().find((resource: any) => this.nameOf(resource) === name) ?? null;
  }

  /** 归一化为 { name, quantity }；兼容 count / 数量 等历史键名 */
  private toRates(list: any): HomeYardRate[] {
    const parsed = typeof list === 'string' ? this.parseJson(list, []) : list;
    return (Array.isArray(parsed) ? parsed : [])
      .filter((item: any) => this.nameOf(item))
      .map((item: any) => ({
        name: this.nameOf(item),
        quantity: Number(item?.quantity ?? item?.count ?? item?.['数量'] ?? 0) || 0,
      }));
  }

  private nameOf(item: any): string {
    return String(item?.name ?? item?.['名称'] ?? '').trim();
  }

  private countOf(item: any): number {
    return Number(item?.quantity ?? item?.count ?? item?.times ?? item?.['数量'] ?? item?.['次数'] ?? 0) || 0;
  }

  private parseJson<T>(value: any, fallback: T): T {
    if (value && typeof value === 'object') return value as T;
    if (typeof value !== 'string') return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
}
