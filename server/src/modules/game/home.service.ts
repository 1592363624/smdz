/**
 * 家园系统核心服务
 * 对应原版易语言：使魔家园.ecode
 * 负责家园的生产、建筑、种植、宠物产出等核心逻辑
 * 包含：产出资源计算、建筑建造/拆除、种植系统、宠物生产、地图产出分析等
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { StaticDataService } from './static-data.service';
import { MapService } from './map.service';
import { asJsonValue } from '../../common/utils/json-value.util';
// 数值收敛唯一实现（两位小数），禁手写 Math.round 副本
import { roundItemQuantity } from '../../common/utils/game-text.util';
// 标记读写唯一口径（数组 { name, value } / 字典按键，中文别名由边界归一化收敛）
import { readMarkerValue, writeMarkerValue } from './field-contract.util';

// ==================== 类型定义 ====================

/**
 * 生产物品接口
 * 对应原版易语言的"产出"数据类型
 * 表示单个产出物品的名称、数量和几率
 */
export interface ProduceItem {
  name: string;
  quantity: number;
  chance?: number;
}

/**
 * 生产者/资源接口
 * 对应原版易语言的"资源1"数据类型
 * 用于产出计算的建筑/作物统一格式
 */
export interface Producer {
  name: string;
  type?: string;           // 类型
  count: number;           // 次数/数量
  outputs: ProduceItem[];  // 产出列表（建筑用产出2，作物用产出2）
  priority: number;        // 优先级（越小的优先计算）
  notOccupy?: boolean;     // 是否不占建筑位置
  level?: number;          // 等级
}

/**
 * 建筑物品接口
 * 对应原版易语言的"物品3"数据类型中的建筑部分
 * 存储在地图的 buildings 字段中
 */
export interface BuildingItem {
  name: string;
  quantity: number;        // 建筑数量
  type?: string;           // 类型
  durability?: number;     // 耐久
  data?: string;           // 额外数据
}

/**
 * 作物生长计划（分阶段成熟玩法）
 * 每个作物从种下起按 stageNames 逐阶段生长，全部走完即成熟，
 * 成熟后一次性收获"整个生长周期本应掉落的收益"（见 harvestCrop）。
 */
/** 作物实时累积（部分领取）配置：来源 prisma/data/crop-growth.json 的 accrual 段 */
export interface CropAccrualConfig {
  /** 总开关：开启后作物产出按已生长秒数实时累积、随时可领 */
  enabled: boolean;
  /** 未成熟时是否允许领走已累积的部分（领取后作物继续生长） */
  partialClaimEnabled: boolean;
  /** 累积秒数是否封顶到成熟时长（true=成熟后不再累积，总收益与旧口径一致） */
  capAtMatureSeconds: boolean;
}

export interface CropGrowthPlan {
  /** 阶段名称（如 播种/发芽/生长/开花/成熟） */
  stageNames: string[];
  /** 总成熟时长（秒） */
  totalSeconds: number;
  /** 每个阶段的秒数（均分） */
  stageSeconds: number[];
  /** 收获收益换算口径：产出按“每分钟”计量，总收益 = 基础产出/分 × 总时长/600 */
  rewardScaleDivisor: number;
  /** 实时累积玩法配置（缺失字段一律按“开启且封顶”处理） */
  accrual: CropAccrualConfig;
}

/**
 * 地图产出结果
 */
export interface MapOutputResult {
  buildingOutput: ProduceItem[];    // 建筑产出
  cropOutput: ProduceItem[];        // 作物产出
  totalOutput: ProduceItem[];       // 总产出
  totalConsumption: ProduceItem[];  // 总消耗
  hasPower: boolean;                // 是否有电
  remainingFuel: number;            // 剩余燃料能供应的秒数
  powerGeneration: number;          // 发电量
}

// ==================== 家园结算 DTO（唯一真相源） ====================

/** 家园结算产出的单项（quantity 允许为负，负数表示消耗） */
export interface HomeSettlementItem {
  name: string;
  quantity: number;
}

/** 家园生产者快照：参与本次结算的建筑/作物/特殊临时生产者的有效形态（供 Web 设备卡片） */
export interface HomeProducerSnapshot {
  name: string;
  type?: string;
  count: number;
  priority: number;
  outputs: ProduceItem[];
}

/** 世界模拟器训练进度快照 */
export interface HomeWorldSimulation {
  /** 训练进度百分比（aiProgress/864，原版口径） */
  aiProgressPercent: number;
  alphaChance: number;
  betaChance: number;
  /** 与 QQ 文本完全一致的状态行（含取整口径），文本渲染直接消费 */
  text: string;
  /** 本次训练生成的核心（settle 时已写入存放地；preview 时为概率投影） */
  cores: HomeSettlementItem[];
}

/**
 * 家园结算结构化结果——家园系统的唯一真相源。
 * - QQ 文本由 renderHomeSettlementText(settlement) 纯函数投影，数值与文本永不双轨；
 * - Web 面板（GET /game/home/overview）直接消费本 DTO；
 * - preview（settle:false）在深克隆上运行与结算完全相同的公式，
 *   不写观测时间/有电/每日产出/AI 标记，不触碰存放地与玩家档案。
 */
export interface HomeSettlement {
  /** 早退原因（家园未建成/无家园地图等）；存在时其余字段为空投影 */
  blocked?: string;
  playerName: string;
  hasPower: boolean;
  /** 生产模式：true=超载（建筑产出 1.25x / 燃耗 1.5x） */
  overloaded: boolean;
  /** 原始观测间隔（秒） */
  elapsedSeconds: number;
  /** 含宠物时间倍率后的有效间隔（秒） */
  effectiveElapsedSeconds: number;
  /** 燃料可支撑的生产时长（秒） */
  remainingFuelSeconds: number;
  /** 发电量（电力/分钟口径，原版 MapOutputResult.powerGeneration） */
  powerGeneration: number;
  /** 宠物/具现装置直接产出（蛋/垃圾/未知物品/核心等，settle 时已写入存放地） */
  directOutput: HomeSettlementItem[];
  /** 按优先级结算的有序正产出——渲染「获得XxY」行的唯一来源 */
  gains: HomeSettlementItem[];
  /** 每日折算正产出（供家园贸易 2% 与 UI 速率表；无电时为空） */
  dailyOutput: HomeSettlementItem[];
  /** 宠物异常提示（如螳螂无采集工具） */
  petBonusText: string[];
  worldSimulation?: HomeWorldSimulation;
  /** 参与本次结算的生产者快照（含特殊临时生产者） */
  producers: HomeProducerSnapshot[];
  /** 结算（或预览投影）后的存放地快照（中英键名已归一化为 name/quantity） */
  storage: HomeSettlementItem[];
  /** 家园总览段数据（使魔家园显示；preview 放宽进度门槛后进度1-3 也有值） */
  overview?: HomeOverviewInfo;
}

/**
 * 家园总览段数据——原版 观测地图 L515-565 生成的「使魔家园」显示内容。
 * 与结算同源：由 computeHomeSettlement 在两个返回路径上填充，
 * QQ 文本由 renderHomeOverviewText 纯函数投影。
 */
export interface HomeOverviewInfo {
  /** 作物数量/上限（资源2产出2非空条目次数和 / ceil(等级/5)+凭证*5） */
  cropCount: number;
  cropLimit: number;
  /** 建筑数量/上限（取建筑数量 / ceil(等级/20)+凭证+2） */
  buildingCount: number;
  buildingLimit: number;
  /** 岗位 供应/需求：供应=(宠物+按摩椅)*(1+按摩椅/50)，需求=ceil(建筑/6) */
  jobSupply: number;
  jobDemand: number;
  /** 人力供应倍率<1：岗位行前追加提示行 */
  laborShortage: boolean;
  /** 电力 净/发电量（原版取整=截断）；净<=0 追加电力不足提示 */
  powerNet: number;
  powerGeneration: number;
  /** 燃料库存与可支撑秒数；null=燃料自给自足(∞) */
  fuelStock: number;
  fuelSeconds: number | null;
  fuelShortage: boolean;
  /** 肥料库存与可支撑秒数（基础肥沃度 0.15 已计入速率判断）；null=∞ */
  fertilizerStock: number;
  fertilizerSeconds: number | null;
  fertilizerShortage: boolean;
  /** 每日展示产出（总产出2 速率×1440，排除电力；保留 0 值项，含基础肥沃度肥料） */
  dailyDisplay: HomeSettlementItem[];
}

@Injectable()
export class HomeService {
  private readonly logger = new Logger(HomeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly mapService: MapService,
    private readonly staticData: StaticDataService,
  ) {}

  /**
   * 生成临时建筑 - 多产出（对应原版：生成临时建筑_多产出()）：产出多个指定物品的临时生产者。
   *
   * @param buildingCount 建筑数量（不指定则默认为1）
   * @param specifiedPriority 指定优先级（不指定则默认为1）
   */
  createTempBuildingMulti(
    items: ProduceItem[],
    buildingCount?: number,
    specifiedPriority?: number,
  ): Producer {
    const producer: Producer = {
      name: '临时',
      outputs: items.map(item => ({
        name: item.name,
        quantity: this.getProduceQuantity(item),
      })),
      priority: specifiedPriority ?? 1,
      count: buildingCount ?? 1,
    };
    return producer;
  }

  /**
   * 生成临时建筑 - 单产出（对应原版：生成临时建筑()）：生产指定物品的临时生产者，
   * 指定名称命中建筑列表时改用该建筑定义的产出。
   *
   * @param specifiedName 指定名称（不为空时会从建筑列表查找）
   * @param buildingCount 建筑数量（不指定则默认为1）
   * @param specifiedPriority 指定优先级（不指定且查不到建筑时默认为2）
   * @param buildingList 建筑列表（用于按名称查找建筑定义）
   */
  createTempBuilding(
    outputName: string,
    outputQuantity: number,
    specifiedName?: string,
    buildingCount?: number,
    specifiedPriority?: number,
    buildingList?: Producer[],
  ): Producer {
    const producer: Producer = {
      name: '',
      outputs: [],
      priority: 2,
      count: buildingCount ?? 1,
    };

    // 如果指定了名称，尝试从建筑列表中查找
    if (specifiedName && buildingList) {
      const found = buildingList.find(b => b.name === specifiedName);
      if (found) {
        // 找到了建筑定义，使用该定义的产出
        producer.name = found.name;
        producer.outputs = [...found.outputs];
        producer.priority = found.priority;
        producer.notOccupy = found.notOccupy;
        return producer;
      }
    }

    // 没在建筑列表找到，创建临时建筑
    producer.name = '临时建筑';
    producer.outputs = [{ name: outputName, quantity: outputQuantity }];
    producer.priority = specifiedPriority ?? 2;

    return producer;
  }

  /**
   * 是否有特殊宠物（对应原版：是否有特殊宠物()）：返回 units 中首个匹配特殊序号的下标，未找到返回 -1。
   * 特殊宠物会影响生产加成（如龙女仆、英招、执行者等）。
   *
   * @param units 地图上的单位数组（召唤物/宠物）
   * @param requireAlive 是否要求存活（生命值大于0）
   */
  hasSpecialPet(
    specialSeq: number,
    units: any[],
    requireAlive?: boolean,
  ): number {
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      // 原版用"活力"字段存特殊序号
      const unitSpecialSeq = unit.specialSeq || unit.vitality || 0;
      if (unitSpecialSeq === specialSeq) {
        if (requireAlive) {
          if ((unit.hp || unit.currentHp || 0) > 0) {
            return i;
          }
        } else {
          return i;
        }
      }
    }
    return -1;
  }

  /**
   * 产出资源 - 核心函数
   * 对应原版：产出资源()
   * 计算家园/建筑/作物的资源产出
   * 生产类型：1=作物，2=建筑
   * 
   * 计算逻辑：
   * 1. 遍历所有生产者，只计算指定优先级的
   * 2. 取最小产出时间（受消耗品供应量影响）
   * 3. 每个产出 = 数量 × 人力供应倍率 × 次数 × 生产时间 / 60
   * 4. 作物产出是建筑的10%
   * 5. 电力/燃料有独立倍率
   *
   * @param timeDiff 时间差（秒，距上次观测流逝的秒数）
   * @param productionType 生产类型（1=作物，2=建筑）
   * @param noConsume true=无视消耗也能产出
   */
  produceResources(
    producers: Producer[],
    storage: any[],
    timeDiff: number,
    priority: number,
    productionType: number, // 1=作物 2=建筑
    buildingOutputRate: number,
    cropOutputRate: number,
    powerConsumeRate: number,
    fuelConsumeRate: number,
    powerFuelOutputRate: number,
    laborSupplyRate: number,
    noConsume?: boolean,
  ): ProduceItem[] {
    const outputItems: ProduceItem[] = [];
    const tempItem: any = { name: '', quantity: 0 };

    for (const producer of producers) {
      if (producer.priority !== priority) continue;

      let productionTime: number;
      if (noConsume) {
        productionTime = timeDiff;
      } else {
        productionTime = this.getMinProduceTime(
          producer,
          timeDiff,
          storage,
          productionType,
        );
      }

      for (const output of producer.outputs) {
        const outputQuantity = this.getProduceQuantity(output);
        // 公式：数量 × 人力供应倍率 × 次数 × 生产时间 / 60
        let quantity = outputQuantity * laborSupplyRate * producer.count * productionTime / 60;

        if (productionType === 1) {
          if (outputQuantity > 0) {
            quantity = quantity * cropOutputRate * 0.1;
          } else {
            quantity = quantity * 0.1;
          }
        } else {
          if (outputQuantity > 0) {
            quantity = quantity * buildingOutputRate;
            if (output.name === '电力' || output.name === '燃料') {
              quantity = quantity * powerFuelOutputRate;
            }
          } else {
            if (output.name === '电力') {
              quantity = quantity * powerConsumeRate;
            } else if (output.name === '燃料') {
              quantity = quantity * fuelConsumeRate;
            }
          }
        }

        // 原版产出资源 L116：电力只参与总平衡，不写入家园存放地。
        if (output.name === '电力') continue;

        tempItem.name = output.name;
        tempItem.quantity = quantity;
        this.addToOutput(outputItems, tempItem);
      }
    }

    return outputItems;
  }

  /**
   * 取最小产出时间
   * 对应原版：取最小产出时间()
   * 计算单个建筑的最小产出时间
   * 受燃料/电力等消耗品供应量影响
   * 如果消耗品不足，产出时间会延长（受限于消耗品库存）
   * 
   * @param timeDiff 时间差（秒）
   * @param storage 存放地（物品数组，用于查找可消耗的物品）
   * @param productionType 生产类型（1=作物，2=建筑）
   * @returns 最小产出时间（秒）
   */
  getMinProduceTime(
    producer: Producer,
    timeDiff: number,
    storage: any[],
    productionType: number,
  ): number {
    // 消耗倍率：建筑基础产出是/分钟，所以换算秒要/60
    // 作物基础产出是/10分钟，所以换算秒要/600
    const consumeRateDivisor = productionType === 2 ? 60 : 600;

    // 收集所有消耗品（负产出）的可供消耗时间
    const supplyTimes: number[] = [];

    for (const output of producer.outputs) {
      const outputQuantity = this.getProduceQuantity(output);
      if (outputQuantity < 0) {
        // 有消耗项（负产出）
        if (output.name !== '电力') {
          // 电力已经在其他地方判断了，这里只处理其他消耗品
          // 计算可供消耗的物品数量
          const availableAmount = this.getItemQuantity(output.name, storage);
          // 计算可供消耗的时间 = 库存量 / (消耗率 / 倍率)
          // 消耗率 = |数量| / 倍率（每秒消耗量）
          const consumeRate = Math.abs(outputQuantity) / consumeRateDivisor;
          if (consumeRate > 0) {
            const supplyTime = availableAmount / consumeRate;
            supplyTimes.push(supplyTime);
          }
        }
      }
    }

    // 如果没有消耗品，直接返回时间差
    if (supplyTimes.length === 0) {
      return timeDiff;
    }

    // 把可供消耗时间从小到大排序
    supplyTimes.sort((a, b) => a - b);

    // 取最小可供消耗时间，但不能超过时间差
    const minTime = Math.min(supplyTimes[0], timeDiff);
    return minTime;
  }

  /**
   * 转为生产
   * 对应原版：转为生产()
   * 将建筑数据（物品3格式）转换为生产者（资源1格式）
   * 用于统一计算产出
   * @param buildingDefs 建筑定义列表（从数据库GameBuilding表加载）
   */
  convertToProduction(
    buildings: BuildingItem[],
    buildingDefs: any[],
  ): Producer[] {
    const producers: Producer[] = [];

    for (const building of buildings) {
      const buildingName = this.getItemName(building);
      // 在建筑定义列表中查找匹配项
      const def = buildingDefs.find(d => this.getItemName(d) === buildingName);
      if (!def) continue;

      const producer: Producer = {
        name: this.getItemName(def),
        type: def.type || '',
        count: this.getItemQuantityValue(building),
        // 从建筑定义的 materials 字段解析产出（原版中建筑产出存储在产出2，这里统一用 outputs）
        outputs: this.normalizeProduceItems(this.safeParseJSON<any[]>(def.materials ?? def['材料'] ?? '[]', [])),
        priority: def.priority ?? def['优先级'] ?? ((building.type || def.type) === '作物' ? 1 : 2),
        notOccupy: Boolean(def.notOccupy ?? def.notOccupyBuilding),
      };

      producers.push(producer);
    }

    return producers;
  }

  /**
   * 取地图产出
   * 对应原版：取地图产出()
   * 计算整张地图的总产出，包括电力供应、燃料供应等
   * 返回燃料能供应的秒数
   * 
   * @param timeDiff 时间差（秒）
   * @param buildings 建筑生产者数组
   * @param crops 作物生产者数组
   * @param storage 存放地（物品数组）
   * @param cropOutputRate 作物产出倍率
   * @param buildingOutputRate 建筑产出倍率
   * @param powerConsumeRate 电力消耗倍率
   * @param fuelConsumeRate 燃料消耗倍率
   * @param powerFuelOutputRate 燃电产出倍率
   * @param laborSupplyRate 人力供应倍率
   * @param remainingFuel 初始剩余燃料（会更新）
   */
  getMapOutput(
    timeDiff: number,
    buildings: Producer[],
    crops: Producer[],
    storage: any[],
    cropOutputRate: number,
    buildingOutputRate: number,
    powerConsumeRate: number,
    fuelConsumeRate: number,
    powerFuelOutputRate: number,
    laborSupplyRate: number,
  ): MapOutputResult {
    const buildingOutput: ProduceItem[] = [];
    const cropOutput: ProduceItem[] = [];
    const totalOutput: ProduceItem[] = [];
    const totalConsumption: ProduceItem[] = [];
    let powerGeneration = 0;
    const tempItem: any = { name: '', quantity: 0 };

    // ----- 计算建筑总产出 -----
    for (const building of buildings) {
      for (const output of building.outputs) {
        const outputQuantity = this.getProduceQuantity(output);
        tempItem.name = output.name;
        tempItem.quantity = outputQuantity * building.count;

        if (output.name === '电力') {
          if (outputQuantity > 0) {
            // 正电力产出：发电
            tempItem.quantity = tempItem.quantity * buildingOutputRate * powerFuelOutputRate * laborSupplyRate;
            powerGeneration += tempItem.quantity;
          } else {
            // 负电力产出：耗电
            tempItem.quantity = tempItem.quantity * powerConsumeRate;
          }
        } else if (output.name === '燃料') {
          if (outputQuantity > 0) {
            tempItem.quantity = tempItem.quantity * buildingOutputRate * powerFuelOutputRate * laborSupplyRate;
          } else {
            tempItem.quantity = tempItem.quantity * fuelConsumeRate;
          }
        } else {
          // 其他物品
          if (outputQuantity > 0) {
            tempItem.quantity = tempItem.quantity * buildingOutputRate * laborSupplyRate;
          }
        }

        this.addToOutput(buildingOutput, { ...tempItem });
        this.addToOutput(totalOutput, { ...tempItem });

        // 记录消耗
        if (tempItem.quantity < 0) {
          this.addToOutput(totalConsumption, { ...tempItem });
        }
      }
    }

    // ----- 计算作物总产出（实时累积玩法） -----
    // 作物收益按已生长秒数累积在作物条目上，由「收获」命令领取（见 harvestCrop / cropAccrual），
    // 不按分钟掉落普通物品，因此不进入这里的总产出/消耗。
    // 这里只保留「电力类作物」（如太阳能板）的发电平衡作用，保证纯发电院子
    // 的 hasPower 判断不漂移；其余产出一律不进入总产出/消耗，也不影响每日产出。
    for (const crop of crops) {
      for (const output of crop.outputs) {
        const outputQuantity = this.getProduceQuantity(output);
        if (output.name !== '电力' || outputQuantity <= 0) continue;
        tempItem.name = output.name;
        // 作物的产出/10=建筑相同时间产出
        tempItem.quantity = outputQuantity * crop.count / 10;
        tempItem.quantity = tempItem.quantity * cropOutputRate * laborSupplyRate;
        powerGeneration += tempItem.quantity;
        this.addToOutput(cropOutput, { ...tempItem });
        this.addToOutput(totalOutput, { ...tempItem });
      }
    }

    // 判断是否有电：净电力产出 < 0 表示电力不足
    const powerNet = this.getItemQuantity('电力', totalOutput);
    const hasPower = powerNet >= 0;

    // 计算燃料供应时间
    let remainingFuel = 0;
    let fuelSupplyTime = timeDiff;
    if (!hasPower) {
      // 电力不足，无法产出
      return {
        buildingOutput,
        cropOutput,
        totalOutput,
        totalConsumption,
        hasPower: false,
        remainingFuel: 0,
        powerGeneration,
      };
    }

    // 计算燃料供应
    remainingFuel = this.getItemQuantity('燃料', storage);
    const fuelProduction = this.getItemQuantity('燃料', totalOutput);

    if (fuelProduction > 0) {
      // 燃料自给自足
      fuelSupplyTime = timeDiff;
    } else {
      // 燃料依赖库存，计算库存能支撑的时间
      const fuelConsumption = Math.abs(fuelProduction);
      if (fuelConsumption > 0) {
        fuelSupplyTime = remainingFuel / fuelConsumption * 60;
        if (fuelSupplyTime > timeDiff) {
          fuelSupplyTime = timeDiff;
        }
      }
    }

    return {
      buildingOutput,
      cropOutput,
      totalOutput,
      totalConsumption,
      hasPower,
      remainingFuel: fuelSupplyTime,
      powerGeneration,
    };
  }

  /**
   * 工业牵引光束产出
   * 对应原版：工业牵引光束产出()
   * 计算工业牵引光束的额外资源产出
   * 牵引光束会从未开拓地中提取资源，产出倍率为5倍
   * 
   * @param count 牵引光束数量
   * @param buildingOutputRate 建筑产出倍率
   * @param powerFuelOutputRate 燃电产出倍率
   * @param laborSupplyRate 人力供应倍率
   * @returns 产出物品数组
   */
  async industrialTractorBeamOutput(
    count: number,
    map: any,
    buildingOutputRate: number,
    powerFuelOutputRate: number,
    laborSupplyRate: number,
  ): Promise<ProduceItem[]> {
    const output: ProduceItem[] = [];

    // 获取地图的可前往列表
    const connections = this.mapService.getConnections(map);

    // 查找第一个未开拓的地图
    // 开拓地标记在 connection 的原始 JSON 数据中，可能存储为 isFrontier 或 开拓地
    let targetMapIndex = -1;
    for (let i = 0; i < connections.length; i++) {
      const conn = connections[i] as any;
      const isFrontier = conn.isFrontier || conn['开拓地'] || false;
      if (!isFrontier) {
        targetMapIndex = i;
        break;
      }
    }

    if (targetMapIndex === -1) {
      return []; // 没有未开拓的地图，无产出
    }

    // 获取目标地图的名称
    const targetMapName = connections[targetMapIndex].name;

    // 从 MapService 获取合并后的目标地图（静态 JSON + 动态 DB）
    const targetMap = await this.mapService.getMapByName(targetMapName).catch(() => null);

    if (!targetMap) {
      return [];
    }

    // 解析目标地图的资源
    const resources = this.safeParseJSON<any[]>(targetMap.resources, []);

    // 遍历资源，计算产出
    // 资源数据中每个 item 可能有产出列表（outputs/产出）和标记（marker/标记）
    for (const resource of resources) {
      const marker = (resource as any).marker || (resource as any)['标记'] || '';
      if (!marker) {
        // 没有标记的资源才能被牵引
        const resourceOutputs: ProduceItem[] = (resource as any).outputs || [];
        for (const item of resourceOutputs) {
          const quantity = this.getProduceQuantity(item) * (item.chance || 100) / 100 * count * 5; // 牵引光束5倍于基础产出

          if (item.name === '燃料' || item.name === '电力') {
            this.addToOutput(output, {
              name: item.name,
              quantity: quantity * laborSupplyRate * powerFuelOutputRate * buildingOutputRate,
            });
          } else {
            this.addToOutput(output, {
              name: item.name,
              quantity: quantity * laborSupplyRate * buildingOutputRate,
            });
          }
        }
      }
    }

    return output;
  }

  /**
   * 取建筑数量
   * 对应原版：取建筑数量()
   * 计算地图上非"不占"类型的建筑总数
   * 用于限制建筑数量上限
   * 
   * @returns 有效建筑数量
   */
  getBuildingCount(
    buildings: BuildingItem[],
    buildingDefs: any[],
  ): number {
    let total = 0;

    for (const building of buildings) {
      // 在建筑定义列表中查找
      const def = buildingDefs.find(d => this.getItemName(d) === this.getItemName(building));
      if (def) {
        // 检查是否"不占"类型（不占建筑位置）
        const notOccupy = def.notOccupy ?? false;
        if (!notOccupy) {
          total += this.getItemQuantityValue(building);
        }
      }
    }

    return total;
  }

  /**
   * 建筑建造
   * 对应原版：建造建筑相关逻辑
   * 在地图上建造建筑，检查材料需求并从背包扣除
   * 
   * @param backpack 玩家背包（会从中扣除材料）
   */
  async buildBuilding(
    map: any,
    buildingName: string,
    buildingDefs: any[],
    backpack: any[],
  ): Promise<{ success: boolean; message: string }> {
    // 查找建筑定义
    const def = buildingDefs.find(d => d.name === buildingName);
    if (!def) {
      return { success: false, message: `建筑「${buildingName}」不存在` };
    }

    // 解析建造材料需求
    const materials = this.normalizeProduceItems(this.safeParseJSON<any[]>(def.materials, []));

    // 检查材料是否足够
    for (const material of materials) {
      if (material.quantity > 0) continue; // 正数为产出，负数为消耗
      const needQuantity = Math.abs(material.quantity);
      const hasQuantity = this.getItemQuantity(material.name, backpack);
      if (hasQuantity < needQuantity) {
        return {
          success: false,
          message: `材料不足：需要${material.name}×${needQuantity}，你只有${Math.round(hasQuantity)}`,
        };
      }
    }

    // 扣除材料（消耗品）
    for (const material of materials) {
      if (material.quantity >= 0) continue; // 跳过产出项
      const needQuantity = Math.abs(material.quantity);
      this.removeItemQuantity(material.name, needQuantity, backpack);
    }

    // 添加到地图建筑列表
    const mapBuildings = this.safeParseJSON<any[]>(map.buildings, []);
    const existingBuilding = mapBuildings.find((b: any) => b.name === buildingName);
    if (existingBuilding) {
      this.setItemQuantity(existingBuilding, this.getItemQuantityValue(existingBuilding) + 1);
    } else {
      mapBuildings.push({ name: buildingName, quantity: 1, type: def.type || '' });
    }

    // 更新地图建筑数据（Json 列直接写数组，由调用方透传持久化）
    map.buildings = mapBuildings;

    return { success: true, message: `成功建造了「${buildingName}」` };
  }

  /**
   * 将背包中的建筑安装到当前地图。
   * 原版“安装”是把已制造建筑移入地图建筑数组，不是再次扣除建筑材料。
   */
  installBuilding(
    map: any,
    buildingName: string,
    backpack: any[],
    count = 1,
  ): { success: boolean; message: string; installed: number } {
    const def = buildingName
      ? this.staticData.getBuildingByName(buildingName)
      : undefined;
    if (!def) {
      return { success: false, message: `「${buildingName}」不是建筑`, installed: 0 };
    }

    const available = this.getItemQuantity(buildingName, backpack);
    const installed = Math.min(Math.max(1, Math.floor(count)), Math.floor(available));
    if (installed <= 0) {
      return { success: false, message: `你没有${buildingName}`, installed: 0 };
    }

    this.removeItemQuantity(buildingName, installed, backpack);
    const buildings = this.safeParseJSON<any[]>(map.buildings, []);
    const existing = buildings.find((item: any) => this.getItemName(item) === buildingName);
    if (existing) {
      this.setItemQuantity(existing, this.getItemQuantityValue(existing) + installed);
    } else {
      buildings.push({
        name: buildingName,
        count: installed,
        quantity: installed,
        type: def.type || '建筑',
      });
    }
    map.buildings = buildings; // Json 列直接写数组
    return {
      success: true,
      message: `把${installed}个${buildingName}放到了${map.name || '当前地图'}`,
      installed,
    };
  }

  /**
   * 建筑拆除
   * 对应原版：拆除建筑相关逻辑
   * 拆除地图上的建筑，返还部分材料（50%）
   * 
   * @param backpack 玩家背包（返还材料会加入）
   */
  async removeBuilding(
    map: any,
    buildingName: string,
    buildingDefs: any[],
    backpack: any[],
  ): Promise<{ success: boolean; message: string }> {
    // 查找建筑定义
    const def = buildingDefs.find(d => d.name === buildingName);
    if (!def) {
      return { success: false, message: `建筑「${buildingName}」不存在` };
    }

    // 从地图建筑列表中查找
    const mapBuildings = this.safeParseJSON<any[]>(map.buildings, []);
    const buildingIndex = mapBuildings.findIndex((b: any) => b.name === buildingName);
    if (buildingIndex === -1) {
      return { success: false, message: `地图上没有「${buildingName}」` };
    }

    const building = mapBuildings[buildingIndex];

    // 减少数量：至少 1 整栋才能拆；小数残余不得拆除、也不得被整条抹掉
    // （与 plantSeed 同口径：旧逻辑 buildingQuantity>1 才减 1、否则 splice）
    const buildingQuantity = this.getItemQuantityValue(building);
    if (!(buildingQuantity >= 1)) {
      return {
        success: false,
        message: `「${buildingName}」数量不足，还剩 ${buildingQuantity}，至少需要 1`,
      };
    }
    const buildingRemaining = buildingQuantity - 1;
    if (buildingRemaining > 0) {
      this.setItemQuantity(building, buildingRemaining);
    } else {
      mapBuildings.splice(buildingIndex, 1);
    }

    // 返还50%材料
    const materials = this.normalizeProduceItems(this.safeParseJSON<any[]>(def.materials, []));
    const returnedItems: string[] = [];
    for (const material of materials) {
      if (material.quantity >= 0) continue; // 跳过产出项
      const returnQuantity = Math.floor(Math.abs(material.quantity) * 0.5);
      if (returnQuantity > 0) {
        this.addItemToArray(material.name, returnQuantity, backpack);
        returnedItems.push(`${material.name}×${returnQuantity}`);
      }
    }

    // 更新地图建筑数据（Json 列直接写数组）
    map.buildings = mapBuildings;

    return {
      success: true,
      message: `拆除了「${buildingName}」，返还了${returnedItems.join('、') || '无材料'}`,
    };
  }

  /**
   * 种植种子
   * 对应原版：种植相关逻辑
   * 在地图上种植作物，消耗种子，等待生长后收获
   * 
   * @param buildingDefs 建筑定义列表（用于查找作物定义）
   */
  async plantSeed(
    map: any,
    seedName: string,
    backpack: any[],
    buildingDefs: any[],
  ): Promise<{ success: boolean; message: string }> {
    // 检查种子是否存在
    const seedIndex = backpack.findIndex((item: any) => item.name === seedName);
    if (seedIndex === -1) {
      return { success: false, message: `背包中没有「${seedName}」` };
    }

    // 原版种子通过物品.使用效果指向资源列表中的作物，而不是建筑列表。
    // 旧测试/旧开发数据可能只有“建筑作物”定义，因此保留后备查找。
    const seedDef = this.staticData.getItemByName(seedName);
    const useEffects = this.safeParseJSON<any[]>(seedDef?.useEffects ?? seedDef?.['使用效果'] ?? [], []);
    const effectName = useEffects
      .flatMap((effect: any) => String(effect ?? '').split(/[，,、]/))
      .map((effect: string) => effect.trim())
      .find(Boolean);
    let cropName = effectName || seedName;
    if (!effectName && seedName.endsWith('种子')) {
      cropName = seedName.substring(0, seedName.length - 2);
    }

    const resourceDef = this.staticData.getAllResources().find((resource: any) =>
      this.getItemName(resource) === cropName,
    );
    const legacyBuildingDef = buildingDefs.find(d => this.getItemName(d) === cropName);
    const resourceOutputs = this.normalizeProduceItems(
      resourceDef?.outputs2
      ?? legacyBuildingDef?.outputs2
      ?? legacyBuildingDef?.materials
      ?? [],
    );
    if (!resourceDef || resourceOutputs.length === 0) {
      if (!legacyBuildingDef) {
        return { success: false, message: `找不到「${cropName}」的作物定义` };
      }
    }

    // 消耗种子：必须至少整颗 1 才能种；小数残余（如 0.27）不得再种、也不得被整条抹掉。
    // 旧逻辑 seedQuantity > 1 才减 1、否则 splice 整条，导致 2.27 可连种 3 次（第 3 次把 0.27 当整颗）。
    const seedItem = backpack[seedIndex];
    const seedQuantity = this.getItemQuantityValue(seedItem);
    if (!(seedQuantity >= 1)) {
      return {
        success: false,
        message: `「${seedName}」数量不足，还剩 ${seedQuantity}，至少需要 1`,
      };
    }
    const seedRemaining = seedQuantity - 1;
    if (seedRemaining > 0) {
      this.setItemQuantity(seedItem, seedRemaining);
    } else {
      backpack.splice(seedIndex, 1);
    }

    // 原版作物存储在地图.resources2。分阶段成熟玩法下，每一粒种子都写入
    // **独立的资源条目**并打上 plantedAt 时间戳，这样各批次各自独立生长、
    // 各自成熟（不再按"名称+数量"聚合——聚合会让同一作物所有棵共享一个成熟时间）。
    const resources2 = this.safeParseJSON<any[]>(map.resources2, []);
    const crop = resourceDef
      ? JSON.parse(JSON.stringify(resourceDef))
      : { name: cropName, type: '作物', outputs2: [] };
    crop.name = cropName;
    crop.type = crop.type || '作物';
    crop.times = 1;
    crop.outputs = this.normalizeProduceItems(crop.outputs ?? []);
    crop.outputs2 = resourceOutputs;
    // 种植时间戳（秒）：收获时按它计算所处生长阶段；旧存档没有此字段视为已成熟
    crop.plantedAt = Date.now() / 1000;
    // 实时累积记账：已领取的生长秒数，播种时归零（部分领取后递增，防止重复领取）
    crop.claimedSeconds = 0;
    resources2.push(crop);

    map.resources2 = resources2; // Json 列直接写数组

    return { success: true, message: `成功种植了「${cropName}」` };
  }

  /**
   * 收获 / 领取作物（实时累积玩法）。
   *
   * 作物产出按「已生长秒数」实时累积（算法见 cropAccrual），玩家随时可领：
   * - 已成熟的条目：结算剩余未领的累积量并移除（腾出地块）；
   * - 生长中的条目：开启部分领取时可领走已累积部分，作物保留继续生长（claimedSeconds 记账）。
   *
   * 累积秒数默认封顶到成熟时长，因此「成熟立刻收获」的总收益与旧的一次性结算完全等价，
   * 区别只是玩家可以提前把已长出来的部分领走。
   */
  async harvestCrop(
    map: any,
    cropName: string,
    buildingDefs: any[],
    backpack: any[],
  ): Promise<{ success: boolean; message: string }> {
    // 新格式：作物位于resources2，收获物来自资源定义outputs2 的正收益。
    const resources2 = this.safeParseJSON<any[]>(map.resources2, []);
    const now = Date.now() / 1000;
    const isCropEntry = (resource: any): boolean =>
      this.getItemName(resource) === cropName
      && this.normalizeProduceItems(resource?.outputs2 ?? []).length > 0;

    const ripeEntries: any[] = [];
    const unripeEntries: any[] = [];
    const plan = this.getCropGrowthPlan(cropName);
    const cropResourceDef = this.staticData.getAllResources().find((resource: any) =>
      this.getItemName(resource) === cropName,
    );
    // 条目自身缺 outputs2 时用资源定义补齐（旧存档 / 手工改库场景），保证累积算法有输入
    const defOutputs = this.normalizeProduceItems(cropResourceDef?.outputs2 ?? []);
    for (const resource of resources2) {
      if (!isCropEntry(resource)) continue;
      if (defOutputs.length > 0 && !this.normalizeProduceItems(resource?.outputs2 ?? []).length) {
        resource.outputs2 = defOutputs;
      }
      const plantedAt = Number(resource.plantedAt ?? resource['种植时间'] ?? 0);
      // 无 plantedAt 的条目视为已成熟，可直接收获
      const ripe = plantedAt <= 0 || (now - plantedAt) >= plan.totalSeconds;
      (ripe ? ripeEntries : unripeEntries).push(resource);
    }

    // 优先收获成熟棵：这是唯一能腾出地块的操作，收益取「剩余未领的累积量」
    if (ripeEntries.length > 0) {
      const totals = new Map<string, number>();
      let ripeCount = 0;
      for (const resource of ripeEntries) {
        ripeCount += Math.max(1, Math.round(this.getResourceQuantityValue(resource)) || 1);
        for (const item of this.cropAccrual(cropName, resource, now).items) {
          totals.set(item.name, (totals.get(item.name) || 0) + item.quantity);
        }
      }

      // 只移除成熟条目，未成熟的继续留在地里生长
      for (const resource of ripeEntries) {
        const index = resources2.indexOf(resource);
        if (index >= 0) resources2.splice(index, 1);
      }
      map.resources2 = resources2; // Json 列直接写数组

      const harvested: string[] = [];
      for (const [name, quantity] of totals) {
        if (quantity <= 0) continue;
        this.addItemToArray(name, quantity, backpack);
        harvested.push(`${name}×${this.roundLikeOriginal(quantity)}`);
      }

      return {
        success: true,
        message: `收获了「${cropName}」×${ripeCount}，获得：${harvested.join('、') || '无产出'}`,
      };
    }

    if (unripeEntries.length > 0) {
      // 全部未成熟：开启实时累积后可「部分领取」——领走已累积的部分，作物继续长
      if (plan.accrual.enabled && plan.accrual.partialClaimEnabled) {
        const totals = new Map<string, number>();
        let earliestRemain = Infinity;
        for (const resource of unripeEntries) {
          const accrual = this.cropAccrual(cropName, resource, now);
          for (const item of accrual.items) {
            totals.set(item.name, (totals.get(item.name) || 0) + item.quantity);
          }
          // 记账：已领走的秒数推进到当前累积量，避免同一段生长时间重复领取
          resource.claimedSeconds = accrual.grownSeconds;
          const plantedAt = Number(resource.plantedAt ?? 0);
          if (plantedAt > 0) {
            earliestRemain = Math.min(earliestRemain, plan.totalSeconds - (now - plantedAt));
          }
        }
        map.resources2 = resources2; // Json 列直接写数组

        const harvested: string[] = [];
        for (const [name, quantity] of totals) {
          if (quantity <= 0) continue;
          this.addItemToArray(name, quantity, backpack);
          harvested.push(`${name}×${this.roundLikeOriginal(quantity)}`);
        }
        if (harvested.length === 0) {
          return {
            success: false,
            message: `「${cropName}」刚领过，还没有新的产出累积，等一会儿再来`,
          };
        }
        return {
          success: true,
          message: `领取了「${cropName}」已累积的产出：${harvested.join('、')}（作物仍在生长，最早还需${this.formatRemainTime(earliestRemain)}成熟）`,
        };
      }

      // 关闭部分领取：退回旧口径提示最早一株还需多久
      let earliestRemain = Infinity;
      for (const resource of unripeEntries) {
        const plantedAt = Number(resource.plantedAt ?? 0);
        const remain = plan.totalSeconds - (now - plantedAt);
        if (remain < earliestRemain) earliestRemain = remain;
      }
      return {
        success: false,
        message: `「${cropName}」还有${unripeEntries.length}棵未成熟，最早还需${this.formatRemainTime(earliestRemain)}`,
      };
    }

    // 存量数据兜底：部分作物条目写在 map.buildings 而非 map.items。
    const mapBuildings = this.safeParseJSON<any[]>(map.buildings, []);
    const cropIndex = mapBuildings.findIndex((b: any) => this.getItemName(b) === cropName);
    if (cropIndex === -1) {
      return { success: false, message: `地图上没有「${cropName}」` };
    }

    const def = buildingDefs.find(d => this.getItemName(d) === cropName);
    const resourceDef = this.staticData.getAllResources().find((resource: any) =>
      this.getItemName(resource) === cropName,
    );
    if (!def) {
      if (!resourceDef) return { success: false, message: `找不到「${cropName}」的定义` };
    }

    // 获取产出
    const outputs = def
      ? this.normalizeProduceItems(this.safeParseJSON<any[]>(def.materials, []))
      : this.normalizeProduceItems(resourceDef?.outputs ?? []);
    const crop = mapBuildings[cropIndex];
    const cropCount = this.getItemQuantityValue(crop);

    // 移除作物（Json 列直接写数组）
    mapBuildings.splice(cropIndex, 1);
    map.buildings = mapBuildings;

    // 加入背包
    const harvested: string[] = [];
    for (const output of outputs) {
      if (output.quantity > 0) {
        const totalQuantity = output.quantity * cropCount;
        this.addItemToArray(output.name, totalQuantity, backpack);
        harvested.push(`${output.name}×${totalQuantity}`);
      }
    }

    return {
      success: true,
      message: `收获了「${cropName}」×${cropCount}，获得：${harvested.join('、') || '无产出'}`,
    };
  }

  /**
   * 宠物生产
   * 对应原版：宠物自动产出（如执行者的蛋产出、英招的羽毛产出等）
   * 计算地图上特殊宠物的额外产出
   * 
   * @param outputQuantity 每个宠物的产出量
   * @param timeDiff 时间差（秒）
   */
  petProduction(
    map: any,
    specialSeq: number,
    outputName: string,
    outputQuantity: number,
    timeDiff: number,
  ): ProduceItem[] {
    const output: ProduceItem[] = [];

    // 获取地图上的召唤物
    const summons = this.safeParseJSON<any[]>(map.summons, []);

    // 查找指定特殊序号的宠物
    let petCount = 0;
    for (const unit of summons) {
      const unitSeq = unit.specialSeq || unit.vitality || 0;
      if (unitSeq === specialSeq && (unit.hp || unit.currentHp || 0) > 0) {
        petCount++;
      }
    }

    if (petCount === 0) {
      return [];
    }

    // 计算产出（每只宠物每分钟产出）
    const totalQuantity = outputQuantity * petCount * timeDiff / 60;
    if (totalQuantity > 0) {
      output.push({ name: outputName, quantity: totalQuantity });
    }

    return output;
  }

  // ==================== 工具方法 ====================

  /**
   * 获取物品数量（从数组中查找指定名称的物品总数）
   * 对应原版：取物品数量()
   */
  private getItemQuantity(name: string, items: any[]): number {
    let total = 0;
    for (const item of items) {
      if (this.getItemName(item) === name) {
        total += this.getItemQuantityValue(item);
      }
    }
    return total;
  }

  /**
   * 从数组中移除指定数量的物品
   * 对应原版：获得物品() 的消耗逻辑
   */
  private removeItemQuantity(name: string, quantity: number, items: any[]): void {
    let remaining = quantity;
    for (let i = items.length - 1; i >= 0 && remaining > 0; i--) {
      const item = items[i];
      if (this.getItemName(item) === name) {
        const itemQty = this.getItemQuantityValue(item);
        if (itemQty <= remaining) {
          remaining -= itemQty;
          items.splice(i, 1);
        } else {
          this.setItemQuantity(item, itemQty - remaining);
          remaining = 0;
        }
      }
    }
  }

  /**
   * 向数组中添加物品（相同名称合并数量）
   * 对应原版：获得物品()
   */
  private addItemToArray(name: string, quantity: number, items: any[], extra: Record<string, any> = {}): void {
    if (!name || !Number.isFinite(quantity) || quantity === 0) return;
    const existing = items.find((item: any) => this.getItemName(item) === name);
    if (existing) {
      this.setItemQuantity(existing, this.getItemQuantityValue(existing) + quantity);
    } else {
      items.push({ name, quantity, type: '资源', ...extra });
    }
  }

  /**
   * 将物品添加到产出列表（相同名称合并数量）
   */
  private addToOutput(outputList: ProduceItem[], item: { name: string; quantity: number }): void {
    // 负产出需要取绝对值记录消耗
    const existing = outputList.find(o => o.name === item.name);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      outputList.push({ name: item.name, quantity: item.quantity });
    }
  }

  private normalizeProduceItems(items: any): ProduceItem[] {
    const parsedItems = typeof items === 'string'
      ? this.safeParseJSON<any[]>(items, [])
      : items;
    return (Array.isArray(parsedItems) ? parsedItems : [])
      .filter((item) => item && this.getItemName(item))
      .map((item) => ({
        ...item,
        name: this.getItemName(item),
        // 条目数量只读规范键 quantity（count 不作为数量来源）
        quantity: Number(item.quantity ?? 0),
      }));
  }

  private getProduceQuantity(item: any): number {
    return Number(item?.quantity ?? 0);
  }

  private getItemQuantityValue(item: any): number {
    return Number(item?.quantity ?? 1);
  }

  private getResourceQuantityValue(resource: any): number {
    // 地图资源条目：数量为 quantity、可采集次数为 times，二者语义不同
    return Number(resource?.quantity ?? resource?.times ?? 1);
  }

  private setItemQuantity(item: any, value: number): void {
    // 数量只写规范键 quantity（双键并存会让同一条目出现两个数量）
    item.quantity = value;
  }

  private setResourceQuantity(resource: any, value: number): void {
    if (Object.prototype.hasOwnProperty.call(resource, 'times')
      && !Object.prototype.hasOwnProperty.call(resource, 'quantity')) {
      resource.times = value;
    } else {
      this.setItemQuantity(resource, value);
    }
  }

  private getItemName(item: any): string {
    // 只读规范键 name（中文别名由持久化边界收敛，见 field-contract.util.ts）
    return String(item?.name ?? '').trim();
  }

  /**
   * 计算作物的生长计划（阶段名/总时长/阶段时长/收益换算口径）。
   *
   * 时长确定规则（crop-growth.json 配置）：
   * 1. 显式覆盖：crops 中按作物名配置的 durationSeconds 优先（椰树/活性灵石/豆蔻等
   *    长线作物，避免被"价值分低"误分到速生档）；
   * 2. 价值分级：未覆盖的作物按"产出2 正收益 × 物品价值"的分数匹配 tiers，
   *    分数越低越速生（1 小时），越高越慢熟（最长 2 周）；
   * 3. 兜底：查不到定义时给 1 天（普通作物）。
   *
   * @param cropName 作物名（如 钻石树 / 椰树）
   */
  getCropGrowthPlan(cropName: string): CropGrowthPlan {
    const config = this.staticData.getCropGrowth();
    const override = config?.crops?.[cropName];
    const defaultNames = Array.isArray(config?.stageNames) && config.stageNames.length > 0
      ? config.stageNames
      : ['播种', '发芽', '生长', '开花', '成熟'];
    const divisor = Number(config?.rewardScaleDivisor ?? 600) || 600;
    // 实时累积配置：缺省即「开启 + 允许部分领取 + 累积封顶到成熟」，缺字段时行为与旧口径等价
    const accrualCfg = config?.accrual ?? {};
    const accrual: CropAccrualConfig = {
      enabled: accrualCfg.enabled !== false,
      partialClaimEnabled: accrualCfg.partialClaimEnabled !== false,
      capAtMatureSeconds: accrualCfg.capAtMatureSeconds !== false,
    };

    let totalSeconds: number;
    let stageCount: number;
    if (override && Number(override.durationSeconds) > 0) {
      // 分作物覆盖：时长与阶段数都按配置来
      totalSeconds = Number(override.durationSeconds);
      stageCount = Math.max(1, Number(override.stages ?? defaultNames.length) || defaultNames.length);
    } else {
      // 价值分级：分数 = Σ(产出2正收益 × 物品价值)，tiers 按分数区间给默认时长
      const resourceDef = this.staticData.getAllResources().find((r: any) => this.getItemName(r) === cropName);
      const outputs = this.normalizeProduceItems(resourceDef?.outputs2 ?? []);
      let score = 0;
      for (const output of outputs) {
        const quantity = this.getProduceQuantity(output);
        if (quantity <= 0) continue;
        const value = Number(this.staticData.getItemByName(output.name)?.value ?? 0) || 1;
        score += quantity * value;
      }
      const tier = (Array.isArray(config?.tiers) ? config.tiers : []).find((t: any) =>
        score >= Number(t?.minScore ?? 0)
        && (t?.maxScore == null || t.maxScore === '' || score < Number(t.maxScore)),
      );
      totalSeconds = Number(tier?.durationSeconds ?? 86400) || 86400;
      stageCount = Math.max(1, Number(tier?.stages ?? defaultNames.length) || defaultNames.length);
    }

    // 阶段名按数量裁剪/补足（保证前端每个阶段都有名字可显示）。
    // 4 阶段作物应展示「播种/发芽/生长/成熟」，而不是把「成熟」裁掉——
    // 裁剪时保留默认名列表的最后一个（成熟），其余取前 stageCount-1 个。
    let stageNames: string[];
    if (stageCount >= defaultNames.length) {
      stageNames = defaultNames.slice(0, stageCount);
    } else {
      stageNames = [...defaultNames.slice(0, stageCount - 1), defaultNames[defaultNames.length - 1]];
    }
    while (stageNames.length < stageCount) stageNames.push(`阶段${stageNames.length + 1}`);
    const stageSeconds = Array.from({ length: stageCount }, () => Math.round(totalSeconds / stageCount));
    return { stageNames, totalSeconds, stageSeconds, rewardScaleDivisor: divisor, accrual };
  }

  /**
   * 作物实时累积量（唯一真相源，地块展示与收获/领取共用同一份算法）。
   *
   * 口径与旧的「成熟一次性结算」完全一致：总收益 = 产出2 正收益 × 棵数 × 累积秒数 / rewardScaleDivisor，
   * 只是把「整周期到点一次性给」拆成「长多少秒就能领多少」，玩家不必等成熟。
   * 电力只参与家园电力平衡，不进入掉落（与结算口径一致）。
   *
   * @param cropName 作物名
   * @param entry map.resources2 中的一条作物条目（plantedAt / claimedSeconds / quantity）
   * @param now 秒级时间戳（缺省取当前系统时间）
   * @returns grownSeconds 已累积秒数（封顶后）、claimableSeconds 本次可领秒数、items 可领产出
   */
  cropAccrual(
    cropName: string,
    entry: any,
    now: number = Date.now() / 1000,
  ): {
    grownSeconds: number;
    claimedSeconds: number;
    claimableSeconds: number;
    ripe: boolean;
    items: { name: string; quantity: number }[];
  } {
    const plan = this.getCropGrowthPlan(cropName);
    const outputs = this.normalizeProduceItems(entry?.outputs2 ?? entry?.['产出2'] ?? []);
    const count = Math.max(1, Math.round(this.getResourceQuantityValue(entry)) || 1);
    // 旧存档没有 plantedAt：视为已长满，直接按整周期可收
    const plantedAt = Number(entry?.plantedAt ?? entry?.['种植时间'] ?? 0);
    const elapsed = plantedAt > 0 ? Math.max(0, now - plantedAt) : plan.totalSeconds;
    const grownSeconds = plan.accrual.capAtMatureSeconds
      ? Math.min(elapsed, plan.totalSeconds)
      : elapsed;
    // 已领取的秒数记账：部分领取后推进，避免同一段生长时间被重复领取
    const claimedSeconds = Math.max(0, Number(entry?.claimedSeconds ?? 0) || 0);
    const claimableSeconds = Math.max(0, grownSeconds - claimedSeconds);
    const items = outputs
      .filter((output: any) => this.getProduceQuantity(output) > 0 && output.name !== '电力')
      .map((output: any) => ({
        name: output.name,
        quantity: this.getProduceQuantity(output) * count * claimableSeconds / plan.rewardScaleDivisor,
      }))
      .filter((item) => item.quantity > 0);
    return {
      grownSeconds,
      claimedSeconds,
      claimableSeconds,
      ripe: plantedAt <= 0 || elapsed >= plan.totalSeconds,
      items,
    };
  }

  /**
   * 格式化剩余成熟时长（秒 → 中文，供未成熟提示使用）。
   */
  private formatRemainTime(seconds: number): string {
    const sec = Math.max(0, Math.floor(Number(seconds) || 0));
    if (sec <= 0) return '刚刚';
    if (sec >= 86400) {
      const days = Math.floor(sec / 86400);
      const hours = Math.floor((sec % 86400) / 3600);
      return hours > 0 ? `${days}天${hours}小时` : `${days}天`;
    }
    if (sec >= 3600) {
      const hours = Math.floor(sec / 3600);
      const minutes = Math.floor((sec % 3600) / 60);
      return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`;
    }
    return `${Math.max(1, Math.ceil(sec / 60))}分钟`;
  }

  /**
   * 读取地图/玩家标记（统一走标记读取唯一口径 readMarkerValue）。
   * 仅额外兼容 Json 列可能以字符串形态落库：解析后再交给共享实现，
   * 数组/字典两种规范形态与中文别名收敛都由 field-contract 负责。
   */
  private readMarkerValue(source: any, name: string): number {
    const parsed = typeof source === 'string' ? this.safeParseJSON<any>(source, {}) : source;
    return readMarkerValue(parsed, name);
  }

  /**
   * 安全解析 JSON 字符串
   */
  private safeParseJSON<T>(jsonStr: string | T, defaultValue: T): T {
    // 统一容错：字符串解析失败/空值回退默认值，对象/数组直接返回
    return asJsonValue<T>(jsonStr, defaultValue);
  }

  /** 原版“文本四舍”：保留两位小数后转文本。 */
  private roundLikeOriginal(value: number): number {
    return roundItemQuantity(value);
  }

  /**
   * 获取所有建筑定义
   * 从数据库中加载 GameBuilding 表
   */
  async getAllBuildingDefs(): Promise<any[]> {
    return this.staticData.getAllBuildings();
  }

  /**
   * 获取建筑产出倍率
   * 从玩家标记中读取产出倍率设置
   * @returns 产出倍率（默认1.0）
   */
  getBuildingOutputRate(markers: Record<string, number>): number {
    return markers['产出倍率'] || 1.0;
  }

  /**
   * 观测并领取家园产出（QQ 文本出口，输出文本格式为对外契约）。
   * 对应地图操作.ecode L53-540：先计算电力/燃料可支撑时间，再按优先级执行产出。
   * 计算与文本已拆分：computeHomeSettlement 负责公式与结算，
   * renderHomeSettlementText 负责 DTO → 文本投影。
   */
  async collectHomeOutput(userId: number): Promise<string> {
    const settlement = await this.computeHomeSettlement(userId, { settle: true });
    return renderHomeSettlementText(settlement);
  }

  /**
   * 只读家园总览（Web 面板数据源）。
   * 在深克隆上运行与结算完全相同的公式：不写观测时间/有电/每日产出/AI 标记，
   * 不触碰存放地与玩家档案——「看面板」永远不会偷走 QQ 端「产出」的结算。
   */
  async getHomeOverview(userId: number): Promise<HomeSettlement> {
    return this.computeHomeSettlement(userId, { settle: false });
  }

  private emptySettlement(playerName: string): HomeSettlement {
    return {
      playerName,
      hasPower: false,
      overloaded: false,
      elapsedSeconds: 0,
      effectiveElapsedSeconds: 0,
      remainingFuelSeconds: 0,
      powerGeneration: 0,
      directOutput: [],
      gains: [],
      dailyOutput: [],
      petBonusText: [],
      producers: [],
      storage: [],
    };
  }

  private deepCloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  /**
   * 家园结算纯计算核心（唯一真相源）。
   * settle=true：在活态对象上执行结算并持久化（观测时间/有电/每日产出/AI/存放地/玩家标记）；
   * settle=false：全部写入落在深克隆上，函数返回即丢弃，零持久化。
   */
  private async computeHomeSettlement(
    userId: number,
    options: { settle: boolean },
  ): Promise<HomeSettlement> {
    const settle = options.settle;
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const playerName = player.name || '冒险者';
    // player.markers 为 Player Json 列（对象/字符串兼容读取）；safeJsonParse 对对象会解析失败丢数据。
    // preview 模式在克隆上运行，绝不污染 Actor 活态。
    const liveMarkers = asJsonValue<any>(player.markers, {});
    const markers = settle ? liveMarkers : this.deepCloneJson(liveMarkers);
    const progress = this.playerService.getMarkerValue(markers, '家园进度');
    // 原版「家园产出」对未建成家园同样执行观测（观测地图不设进度门禁），
    // 但结算写入必须等建成——settle 保持拦截；preview 放宽以支撑「使魔家园」
    // 对进度1-3 院子的总览显示（空院子输出 0 值段，与原版一致）。
    if (progress < 4 && settle) return { ...this.emptySettlement(playerName), blocked: '家园尚未建成，无法产出' };
    if (!settle && !player.houseName) {
      // preview：未圈地时无家园地图可看（原版使魔家园 L2426 按房子名取图，取不到则无总览）
      return { ...this.emptySettlement(playerName), blocked: '还没有家园' };
    }
    if (!player.houseName && !player.mapId) {
      return { ...this.emptySettlement(playerName), blocked: '你还没有家园所在地图' };
    }

    const map = player.houseName
      ? await this.mapService.getMapByName(player.houseName).catch(() => null)
      : await this.mapService.getMapById(player.mapId);
    if (!map) return { ...this.emptySettlement(playerName), blocked: '家园所在的地图不存在' };

    const buildings = this.safeParseJSON<any[]>(map.buildings, []);
    const definitions = this.staticData.getAllBuildings();
    const producers = this.convertToProduction(buildings, definitions);
    // 原版地图.资源2中“产出2”非空的条目才是作物；作物不存于建筑列表。
    const cropResources = this.safeParseJSON<any[]>(map.resources2, []);
    const cropProducers: Producer[] = cropResources
      .filter((resource: any) => {
        const outputs = this.normalizeProduceItems(resource?.outputs2 ?? []);
        return outputs.length > 0;
      })
      .map((resource: any): Producer => ({
        name: resource.name ?? '',
        type: '作物',
        count: this.getResourceQuantityValue(resource),
        outputs: this.normalizeProduceItems(resource.outputs2 ?? []),
        priority: Number(resource.priority ?? resource.优先级 ?? 1),
      }))
      .filter((resource) => resource.count > 0 && resource.outputs.length > 0);
    // 原版“产出存放”就是地图.物品，不是玩家背包；普通地图拾取命令再把它移入背包。
    // preview 在克隆上运行全部公式，产出/消耗写入随克隆丢弃，不触碰活态。
    const liveStorage = this.safeParseJSON<any[]>(map.items, []);
    const storage = settle ? liveStorage : this.deepCloneJson(liveStorage);
    const summons = this.safeParseJSON<any[]>(map.summons, []);
    const alive = (pet: any): boolean => (pet?.hp ?? pet?.currentHp ?? 0) > 0;
    // 地图操作.ecode 的“是否有特殊宠物”默认不要求存活，只有兰音幼崽调用时显式传入真。
    const hasPet = (name: string, seq: number, requireAlive = false): boolean => summons.some((pet: any) => {
      const petSeq = pet?.vitality ?? pet?.specialSeq;
      const petName = this.getItemName(pet);
      return (petName === name || petSeq === seq) && (!requireAlive || alive(pet));
    });
    const petCount = summons.length;
    const countBuilding = (name: string): number => buildings
      .filter((b: any) => this.getItemName(b) === name)
      .reduce((sum: number, b: any) => sum + this.getItemQuantityValue(b), 0);

    const now = Date.now() / 1000;
    const liveMapMarkers = this.safeParseJSON<any>(map.markers, {});
    const mapMarkers = settle ? liveMapMarkers : this.deepCloneJson(liveMapMarkers);
    // 观测时间以地图标记为准；玩家标记仅作存量数据兜底。
    const lastOutput = this.readMarkerValue(mapMarkers, '观测时间')
      || this.readMarkerValue(mapMarkers, '读取时间')
      || this.readMarkerValue(mapMarkers, '家园产出时间')
      || this.readMarkerValue(markers, '家园产出时间');
    const timeDiff = lastOutput > 0 ? Math.max(0, now - lastOutput) : 60;
    const overloaded = this.readMarkerValue(mapMarkers, '生产模式') === 1;
    let buildingOutputRate = overloaded ? 1.25 : 1;
    const cropOutputRateBase = 1;
    let cropOutputRate = cropOutputRateBase;
    let powerConsumeRate = 1;
    let fuelConsumeRate = overloaded ? 1.5 : 1;
    let powerFuelOutputRate = 1;

    // 原版 L54：兰音幼崽令地图时间流逝速度×105%。
    if (hasPet('兰音幼崽', -30, true)) {
      // 原版效果作用于时间差本身，保留小数，不提前取整。
      (markers as any)['家园产出时间倍率'] = 1.05;
    }
    const effectiveTimeDiff = hasPet('兰音幼崽', -30, true) ? timeDiff * 1.05 : timeDiff;

    // 原版地图操作.ecode L58-L75：普通宠物与具现装置的产出先进入地图物品，
    // 同时把按分钟显示的统计项写入总产出。垃圾的固定“宠物数/1440”按原版字面保留。
    const ambientOutput: ProduceItem[] = [];
    if (petCount > 0) {
      const eggQuantity = effectiveTimeDiff / 86400 * petCount;
      const garbageQuantity = petCount / 1440;
      this.addItemToArray('蛋', eggQuantity, storage);
      this.addItemToArray('垃圾', garbageQuantity, storage);
      ambientOutput.push({ name: '垃圾', quantity: garbageQuantity });
      ambientOutput.push({ name: '蛋', quantity: eggQuantity });
    }
    const manifestationCount = countBuilding('具现装置');
    if (manifestationCount > 0) {
      const unknownQuantity = effectiveTimeDiff / 86400;
      this.addItemToArray('未知物品', unknownQuantity, storage);
      ambientOutput.push({ name: '未知物品', quantity: 1 / 1440 });
    }

    const irrigation = countBuilding('工业灌溉');
    if (irrigation > 0) {
      const cropCount = producers.filter((p) => p.priority === 1)
        .reduce((sum, p) => sum + p.count, 0);
      cropOutputRate += 0.2 + Math.min(irrigation, cropCount) / 100;
    }
    const controlCircuit = countBuilding('工业控制电路');
    if (controlCircuit > 0) powerFuelOutputRate *= 1 + controlCircuit / 100;
    if (hasPet('龙女仆', -6)) buildingOutputRate *= 1.05;
    if (hasPet('执行者', -3)) powerConsumeRate *= 0.95;
    if (hasPet('英招', -7)) cropOutputRate += 0.1;
    // 宠物加成文本（对齐原版"宠物加成文本"变量，在最终输出中拼接）
    const petBonusText: string[] = [];

    // 原版防御节点只改写世界模拟器的电力消耗，并影响核心训练概率。
    const hasDefenseNode = hasPet('防御节点', -28);
    if (hasDefenseNode) {
      const worldSimulator = producers.find((producer) => producer.name === '世界模拟器');
      const powerCost = worldSimulator?.outputs.find((output) =>
        output.name === '电力' && this.getProduceQuantity(output) < 0,
      );
      if (powerCost) powerCost.quantity = this.getProduceQuantity(powerCost) * 1.1;
    }

    // 原版作物上限：按玩家等级与凭证限制资源2/作物数量，并封顶作物倍率。
    const cropLimit = Math.ceil((player.level || 1) / 5) + this.readMarkerValue(markers, '凭证') * 5;
    let cropSeen = 0;
    const limitedCrops: Producer[] = [];
    for (const crop of cropProducers) {
      if (cropSeen >= cropLimit) break;
      const count = Math.min(crop.count, cropLimit - cropSeen);
      if (count <= 0) continue;
      limitedCrops.push({ ...crop, count });
      cropSeen += count;
    }
    if (cropLimit > 0) cropOutputRate = Math.min(cropOutputRate, 1 + cropLimit * 0.1 / 100);

    const buildingProducers = producers.filter((p) => p.priority !== 1);
    const tractorCount = countBuilding('工业牵引光束') + (hasPet('熔岩巨人', -19) ? 5 : 0);
    if (tractorCount > 0) {
      const tractorOutput = await this.industrialTractorBeamOutput(
        tractorCount,
        map,
        buildingOutputRate,
        powerFuelOutputRate,
        1,
      );
      for (const item of tractorOutput) {
        buildingProducers.push(this.createTempBuilding(item.name, this.getProduceQuantity(item), undefined, 1, 2));
      }
    }

    // 每只宠物每分钟消耗0.5生肉（地图操作.ecode L349）。
    if (petCount > 0) {
      buildingProducers.push(this.createTempBuilding('生肉', -petCount * 0.5, undefined, 1, 2));
    }

    // 原版 L215/L506：肥料只在本次观测期间临时加入存放地，计算完成后完整移除。
    const temporaryFertilizer = 0.15 * effectiveTimeDiff;
    this.addItemToArray('肥料', temporaryFertilizer, storage);

    // 原版人力计算：按摩椅每个额外提供1岗位并增加2%，其余岗位按建筑数量/6计算。
    const massageCount = countBuilding('按摩椅');
    const buildingCount = this.getBuildingCount(buildings, definitions);
    const productionBuildingCount = buildingProducers.length;
    let laborSupplyRate = 0;
    if (massageCount > 0) {
      const denominator = buildingCount / 6;
      laborSupplyRate = denominator > 0
        ? (petCount + massageCount) * (1 + massageCount / 50) / denominator
        : 0;
    } else {
      const denominator = productionBuildingCount / 6;
      laborSupplyRate = denominator > 0 ? petCount / denominator : 0;
    }
    laborSupplyRate = Math.min(1, Math.max(0, laborSupplyRate));

    // 朱雀：正合金产出增加，地热锻炉使用原版特殊数值312.5/375。
    const vermilion = summons.find((pet: any) => pet?.vitality === -21
      || this.getItemName(pet) === '朱雀');
    // 原版地图操作.ecode L161 未传入“存活才返回真”，按特殊序号命中即可。
    if (vermilion) {
      const factor = 1 + Number(vermilion.level || 1) / 100;
      for (const producer of buildingProducers) {
        for (const output of producer.outputs) {
          const quantity = this.getProduceQuantity(output);
          if (output.name === '合金' && quantity > 0) {
            output.quantity = quantity + (producer.name === '地热锻炉' ? 312.5 : 2.5) * factor;
          } else if (output.name === '铁矿' && quantity < 0) {
            output.quantity = quantity - (producer.name === '地热锻炉' ? 375 : 3) * factor;
          }
        }
      }
    }

    const baseAnalysis = this.getMapOutput(
      effectiveTimeDiff,
      buildingProducers,
      limitedCrops,
      storage,
      cropOutputRate,
      buildingOutputRate,
      powerConsumeRate,
      fuelConsumeRate,
      powerFuelOutputRate,
      1,
    );

    let worldSimulationText = '';
    let worldSimStats: { aiProgressPercent: number; alphaChance: number; betaChance: number } | null = null;
    const trainedCores: ProduceItem[] = [];
    const directOutput = ambientOutput.map((item) => ({ ...item }));
    // 原版地图操作.ecode L254-L320：世界模拟器只在建筑可运行且有电时训练。
    const worldSimulatorCount = countBuilding('世界模拟器');
    const buildingTime = baseAnalysis.remainingFuel;
    if (worldSimulatorCount > 0 && baseAnalysis.hasPower && buildingTime > 0) {
      const previousAi = this.readMarkerValue(mapMarkers, 'AI');
      let aiProgress = previousAi + buildingTime * worldSimulatorCount;
      const trainingCount = Math.floor(aiProgress / 86400);
      const alphaCoreCount = countBuilding('硅基核心阿尔法');
      const betaCoreCount = countBuilding('硅基核心贝塔');
      let alphaChance: number;
      let betaChance: number;

      if (alphaCoreCount >= worldSimulatorCount) {
        alphaChance = 35;
        betaChance = 50;
      } else if (alphaCoreCount > 0) {
        alphaChance = 35 * alphaCoreCount / worldSimulatorCount;
        betaChance = 50 * alphaCoreCount / worldSimulatorCount;
        if (betaCoreCount >= worldSimulatorCount - alphaCoreCount) {
          alphaChance += 15 * (worldSimulatorCount - alphaCoreCount) / worldSimulatorCount;
          betaChance += 55 * (worldSimulatorCount - alphaCoreCount) / worldSimulatorCount;
        } else {
          alphaChance += 15 * betaCoreCount / worldSimulatorCount;
          betaChance += 55 * betaCoreCount / worldSimulatorCount;
          alphaChance += 5 * (worldSimulatorCount - alphaCoreCount - betaCoreCount) / worldSimulatorCount;
          betaChance += 45 * (worldSimulatorCount - alphaCoreCount - betaCoreCount) / worldSimulatorCount;
        }
      } else if (betaCoreCount === 0) {
        alphaChance = 5;
        betaChance = 45;
      } else if (betaCoreCount >= worldSimulatorCount) {
        alphaChance = 15;
        betaChance = 55;
      } else {
        alphaChance = 15 * betaCoreCount / worldSimulatorCount;
        betaChance = 55 * betaCoreCount / worldSimulatorCount;
        alphaChance += 5 * (worldSimulatorCount - betaCoreCount) / worldSimulatorCount;
        betaChance += 45 * (worldSimulatorCount - betaCoreCount) / worldSimulatorCount;
      }

      if (hasDefenseNode) {
        alphaChance += 3;
        betaChance += 5;
      }

      if (trainingCount > 0) {
        aiProgress -= trainingCount * 86400;
        for (let i = 0; i < trainingCount; i++) {
          const roll = Math.floor(Math.random() * 9901) + 100;
          const generatedName = roll / 100 <= alphaChance
            ? '硅基核心阿尔法'
            : roll / 100 <= alphaChance + betaChance
              ? '硅基核心贝塔'
              : '废弃硅基核心';
          this.addItemToArray(generatedName, 1, storage, { data: 'a' });
          directOutput.push({ name: generatedName, quantity: 1 });
          trainedCores.push({ name: generatedName, quantity: 1 });
        }
      }
      this.writeMarkerValue(mapMarkers, 'AI', aiProgress);
      worldSimulationText = `正在训练硅基核心:${this.roundLikeOriginal(aiProgress / 864)}%(${this.roundLikeOriginal(alphaChance)}/${this.roundLikeOriginal(betaChance)}/${this.roundLikeOriginal(100 - alphaChance - betaChance)})`;
      worldSimStats = {
        aiProgressPercent: this.roundLikeOriginal(aiProgress / 864),
        alphaChance: this.roundLikeOriginal(alphaChance),
        betaChance: this.roundLikeOriginal(betaChance),
      };
    }

    // 特殊产出判断必须读取“当前已累计的总产出”，顺序与原版 L334-L499 一致。
    const specialTotal = baseAnalysis.totalOutput.map((item) => ({ ...item }));
    // 原版世界模拟器生成的核心只写入地图.物品，不加入总产出2；普通宠物/具现装置产出则属于总产出2。
    for (const item of ambientOutput) this.addToOutput(specialTotal, item);
    const addSpecial = (items: ProduceItem[], priority: number): void => {
      for (const item of items) {
        this.addToOutput(specialTotal, item);
      }
      // 原版使用“生成临时建筑_多产出”，同一特殊产出的正负物品共享最小生产时间。
      if (items.length > 0) buildingProducers.push(this.createTempBuildingMulti(items, 1, priority));
    };

    // 原版 L334：腐化南方巨兽龙移除全部生物质，并转换为水晶和生肉。
    if (hasPet('腐化南方巨兽龙', -29)) {
      const rawBiomass = Math.max(0, this.getItemQuantity('生物质', specialTotal));
      if (rawBiomass > 0) {
        addSpecial([
          { name: '水晶', quantity: rawBiomass * 500 },
          { name: '生肉', quantity: rawBiomass * 50 },
          { name: '生物质', quantity: -rawBiomass },
        ], 7);
      }
    }

    // 白兔子：家园蛋和奶的产量大于0时，每日生产3个奶油蛋糕。
    if (hasPet('白兔子', -17) && this.getItemQuantity('奶', specialTotal) > 0) {
      addSpecial([{ name: '奶油蛋糕', quantity: 0.002084 }], 2);
    }

    // 小雨下、小恶魔的固定产出数值按原版字面保留。
    if (hasPet('小雨下', -18)) {
      addSpecial([
        { name: '灵石', quantity: 0.004167 },
        { name: '生肉', quantity: -0.694445 },
      ], 7);
    }
    if (hasPet('小恶魔', -20)) {
      addSpecial([
        { name: '糖心巧克力', quantity: 0.0020833 },
        { name: '巧克力', quantity: -0.416667 },
      ], 7);
    }

    // 肉食植物：把多余生肉按地图“肉食比例”转换为绳子/果实/肥料。
    if (hasPet('肉食植物', -25)) {
      const rawMeat = Math.max(0, this.getItemQuantity('生肉', specialTotal));
      if (rawMeat > 0) {
        const ratio = (this.readMarkerValue(mapMarkers, '肉食比例') || 90) / 100;
        addSpecial([
          { name: '绳子', quantity: rawMeat * ratio * 3 },
          { name: '果实', quantity: rawMeat * ratio / 10 },
          { name: '肥料', quantity: rawMeat * ratio / 1000 },
          { name: '生肉', quantity: -rawMeat * ratio },
        ], 5);
      }
    }

    if (hasPet('螳螂', -26)) {
      const mantis = summons.find((pet: any) => pet?.vitality === -26
        || this.getItemName(pet) === '螳螂');
      const gather = Number(mantis?.采集 ?? mantis?.属性?.采集 ?? mantis?.gathering ?? 0);
      // 对齐原版 L427-428：采集属性<=0时提示"没有采集工具或装备"
      if (gather > 0) {
        addSpecial([{ name: '铁矿', quantity: cropLimit * gather / 1440 }], 2);
      } else {
        const mantisName = this.getItemName(mantis) || '螳螂';
        petBonusText.push(`${mantisName}:没有采集工具或装备`);
      }
    }

    // 兔子窝补充所有非电力负产出，金额按原版 a1=2000*兔子窝数量/负产出种类均分。
    const rabbitNestCount = countBuilding('兔子窝');
    const shortageNames = specialTotal
      .filter((item) => item.quantity < 0 && item.name !== '电力')
      .map((item) => item.name)
      .filter((name, index, names) => names.indexOf(name) === index);
    if (rabbitNestCount > 0 && shortageNames.length > 0) {
      const budgetPerItem = 2000 * rabbitNestCount / shortageNames.length;
      for (const shortageName of shortageNames) {
        const itemDef = this.staticData.getItemByName(shortageName);
        const value = Number(itemDef?.value ?? 0);
        const perMinute = value > 0
          ? budgetPerItem / value / 1440
          : budgetPerItem * Math.abs(value || 1) / 1440;
        addSpecial([{ name: shortageName, quantity: perMinute }], 7);
      }
    }

    // 心之守望在所有产出/消耗计算完成后，为每个每分钟产量>=1的非电力产物额外+1。
    if (hasPet('心之守望', -12)) {
      const heart = summons.find((pet: any) => pet?.vitality === -12
        || this.getItemName(pet) === '心之守望');
      const heartFactor = 1 + Number(heart?.level || 1) / 100;
      const heartItems = specialTotal
        .filter((item) => item.name !== '电力' && item.quantity >= 1)
        .map((item) => ({ name: item.name, quantity: heartFactor }));
      addSpecial(heartItems, 2);
    }

    const analysis = this.getMapOutput(
      effectiveTimeDiff,
      buildingProducers,
      limitedCrops,
      storage,
      cropOutputRate,
      buildingOutputRate,
      powerConsumeRate,
      fuelConsumeRate,
      powerFuelOutputRate,
      1,
    );

    this.writeMarkerValue(mapMarkers, '观测时间', now);
    // 原版地图操作会把供电状态写入地图标记，贸易和其他家园功能都依赖该状态。
    this.writeMarkerValue(mapMarkers, '有电', analysis.hasPower ? 1 : 0);
    markers['家园产出时间'] = now;
    // Player Json 列直接写对象（savePlayer 会整行写回，stringify 会双重编码）；preview 不落盘、不污染 Actor 活态
    if (settle) player.markers = markers;
    if (!analysis.hasPower) {
      this.removeItemQuantity('肥料', temporaryFertilizer, storage);
      this.writeMarkerValue(mapMarkers, '每日产出', []);
      if (settle) {
        await this.persistHomeMap(map, storage, mapMarkers);
        await this.playerService.savePlayer(player);
      }
      return {
        ...this.emptySettlement(playerName),
        hasPower: false,
        overloaded,
        elapsedSeconds: timeDiff,
        effectiveElapsedSeconds: effectiveTimeDiff,
        remainingFuelSeconds: analysis.remainingFuel,
        powerGeneration: analysis.powerGeneration,
        directOutput: directOutput.map((item) => ({ ...item })),
        producers: this.snapshotProducers(limitedCrops, buildingProducers),
        storage: this.snapshotStorage(storage),
        overview: this.homeOverviewOf({
          player,
          markers,
          cropProducers,
          cropLimit,
          buildingCount,
          petCount,
          massageCount,
          laborSupplyRate,
          analysis,
          storage,
        }),
      };
    }

    const duration = analysis.remainingFuel;
    const outputItems: ProduceItem[] = directOutput.map((item) => ({ ...item }));
    // 有序正产出：直接产出在前，优先级产出随后——文本渲染「获得XxY」行的唯一来源
    const gains: HomeSettlementItem[] = [];
    for (const item of directOutput) {
      if (item.quantity > 0) gains.push({ name: item.name, quantity: item.quantity });
    }
    for (let priority = 1; priority <= 7; priority++) {
      // 作物走实时累积玩法：产出按生长秒数累积在作物条目上（由「收获/领取」结算），
      // 不参与每分钟掉落结算，避免与收获时的累积量重复发放
      const cropOut: ProduceItem[] = [];
      const buildingOut = this.produceResources(
        buildingProducers.filter((p) => p.priority === priority),
        storage,
        duration,
        priority,
        2,
        buildingOutputRate,
        cropOutputRate,
        powerConsumeRate,
        fuelConsumeRate,
        powerFuelOutputRate,
        1,
      );
      for (const item of [...cropOut, ...buildingOut]) {
        this.addToOutput(outputItems, item);
        // 原版每次产出资源都会立即写回存放地，后续优先级可以继续使用前一优先级产出的物品。
        if (item.quantity > 0) {
          this.addItemToArray(item.name, item.quantity, storage);
          gains.push({ name: item.name, quantity: item.quantity });
        } else if (item.quantity < 0) {
          this.removeItemQuantity(item.name, Math.abs(item.quantity), storage);
        }
      }
    }

    this.removeItemQuantity('肥料', temporaryFertilizer, storage);

    // 保存本次观测得到的每日正产出，供家园贸易按原版“每日产出的2%”使用。
    const dailyOutput = new Map<string, number>();
    const elapsed = Math.max(1, effectiveTimeDiff);
    for (const item of outputItems) {
      if (item.name === '电力' || item.quantity <= 0) continue;
      dailyOutput.set(item.name, (dailyOutput.get(item.name) || 0) + item.quantity * 86400 / elapsed);
    }
    const dailyOutputItems = Array.from(dailyOutput.entries()).map(([name, quantity]) => ({ name, quantity }));
    this.writeMarkerValue(mapMarkers, '每日产出', dailyOutputItems);

    if (settle) {
      await this.persistHomeMap(map, storage, mapMarkers);
      await this.playerService.savePlayer(player);
    }

    const settlement: HomeSettlement = {
      ...this.emptySettlement(playerName),
      hasPower: true,
      overloaded,
      elapsedSeconds: timeDiff,
      effectiveElapsedSeconds: effectiveTimeDiff,
      remainingFuelSeconds: analysis.remainingFuel,
      powerGeneration: analysis.powerGeneration,
      directOutput: directOutput.map((item) => ({ ...item })),
      gains,
      dailyOutput: dailyOutputItems.map((item) => ({ ...item })),
      petBonusText: [...petBonusText],
      producers: this.snapshotProducers(limitedCrops, buildingProducers),
      storage: this.snapshotStorage(storage),
      overview: this.homeOverviewOf({
        player,
        markers,
        cropProducers,
        cropLimit,
        buildingCount,
        petCount,
        massageCount,
        laborSupplyRate,
        analysis,
        storage,
      }),
    };
    if (worldSimulationText && worldSimStats) {
      settlement.worldSimulation = {
        ...worldSimStats,
        text: worldSimulationText,
        cores: trainedCores.map((item) => ({ ...item })),
      };
    }
    return settlement;
  }

  /** 生产者快照：作物在前、建筑在后（与优先级结算顺序一致），outputs 深拷贝脱离计算对象 */
  private snapshotProducers(crops: Producer[], buildings: Producer[]): HomeProducerSnapshot[] {
    return [...crops, ...buildings].map((producer) => ({
      name: producer.name,
      type: producer.type,
      count: producer.count,
      priority: producer.priority,
      outputs: producer.outputs.map((output) => ({ ...output })),
    }));
  }

  /** 存放地快照：中英键名归一化为 name/quantity，供 Web 库存面板直接消费 */
  private snapshotStorage(storage: any[]): HomeSettlementItem[] {
    return storage.map((item: any) => ({
      name: this.getItemName(item),
      quantity: this.getItemQuantityValue(item),
    }));
  }

  /**
   * 组装家园总览段数据（原版 观测地图 L515-565）。
   * 传入的 storage 须已完成临时肥料移除（原版显示段同样在移除后读取库存）；
   * totalOutput 为每分钟净速率口径，本方法在其副本上追加基础肥沃度后再做燃料/肥料/每日产出判断。
   */
  /**
   * 家园总览快照（两处结算返回共用同一取数口径：无电力分支与正常结算分支）。
   * 新增展示字段只改这里，避免两个返回结构各写一份而慢慢对不上。
   */
  private homeOverviewOf(ctx: {
    player: any;
    markers: any;
    cropProducers: any[];
    cropLimit: number;
    buildingCount: number;
    petCount: number;
    massageCount: number;
    laborSupplyRate: number;
    analysis: any;
    storage: any[];
  }): HomeOverviewInfo {
    return this.buildHomeOverview({
      playerLevel: ctx.player.level || 1,
      vouchers: this.readMarkerValue(ctx.markers, '凭证'),
      cropCount: ctx.cropProducers.reduce((sum, crop) => sum + crop.count, 0),
      cropLimit: ctx.cropLimit,
      buildingCount: ctx.buildingCount,
      petCount: ctx.petCount,
      massageCount: ctx.massageCount,
      laborSupplyRate: ctx.laborSupplyRate,
      totalOutput: ctx.analysis.totalOutput,
      powerGeneration: ctx.analysis.powerGeneration,
      storage: ctx.storage,
    });
  }

  private buildHomeOverview(args: {
    playerLevel: number;
    vouchers: number;
    cropCount: number;
    cropLimit: number;
    buildingCount: number;
    petCount: number;
    massageCount: number;
    laborSupplyRate: number;
    totalOutput: ProduceItem[];
    powerGeneration: number;
    storage: any[];
  }): HomeOverviewInfo {
    // 副本上追加土壤基础肥沃度 0.15（原版 L553-555 获得物品 允许负数=真，无条件新增/累加）；
    // 只影响肥料速率判断与每日产出展示，不回写 analysis.totalOutput。
    const displayTotal: ProduceItem[] = args.totalOutput.map((item) => ({ ...item }));
    this.addToOutput(displayTotal, { name: '肥料', quantity: 0.15 });

    // 原版 a2 = 库存 / |速率×1440| × 86400 = 库存/|速率|×60（秒）；速率>0 即自给自足(∞)；
    // 速率=0 时易语言除零得 0 →「不到1秒」。
    const supportSeconds = (stock: number, ratePerMinute: number): number | null => {
      if (ratePerMinute > 0) return null;
      if (ratePerMinute === 0 || stock <= 0) return 0;
      return stock * 60 / Math.abs(ratePerMinute);
    };

    const fuelStock = this.getItemQuantity('燃料', args.storage);
    const fuelSeconds = supportSeconds(fuelStock, this.getItemQuantity('燃料', displayTotal));
    const fertilizerStock = this.getItemQuantity('肥料', args.storage);
    const fertilizerSeconds = supportSeconds(fertilizerStock, this.getItemQuantity('肥料', displayTotal));

    return {
      cropCount: args.cropCount,
      cropLimit: args.cropLimit,
      buildingCount: args.buildingCount,
      buildingLimit: Math.ceil(args.playerLevel / 20) + args.vouchers + 2,
      jobSupply: (args.petCount + args.massageCount) * (1 + args.massageCount / 50),
      jobDemand: Math.ceil(args.buildingCount / 6),
      laborShortage: args.laborSupplyRate < 1,
      powerNet: Math.trunc(this.getItemQuantity('电力', args.totalOutput)),
      powerGeneration: Math.trunc(args.powerGeneration),
      fuelStock,
      fuelSeconds,
      fuelShortage: fuelSeconds !== null && fuelSeconds < 21600,
      fertilizerStock,
      fertilizerSeconds,
      fertilizerShortage: fertilizerSeconds !== null && fertilizerSeconds < 21600,
      dailyDisplay: displayTotal
        .filter((item) => item.name !== '电力')
        .map((item) => ({ name: item.name, quantity: item.quantity * 1440 })),
    };
  }

  /** 写出标记（统一走标记写入唯一口径，数组写 { name, value }、字典按键赋值）。 */
  private writeMarkerValue(target: any, name: string, value: any): void {
    writeMarkerValue(target, name, value);
  }

  private async persistHomeMap(map: any, storage: any[], mapMarkers: any): Promise<void> {
    // GameMap items/markers 为 Json 列，直接写对象/数组（stringify 会双重编码）
    const items = storage;
    const markers = mapMarkers;
    map.items = items;
    map.markers = markers;
    // 统一走地图动态字段收口（updateDynamicFields 会失效 map Actor 缓存，
    // 避免陈旧整行回写覆盖本次落库）。
    await this.mapService.updateDynamicFields(map.id, { items, markers });
  }
}

/**
 * 家园结算文本渲染器（纯函数，无副作用）。
 * 输出为 QQ bot 文本出口的对外格式（消费方依赖，改动需同步）：
 * 标题行 → 有电短路行 / 「获得XxY」有序产出 → 世界模拟器状态 → 宠物提示 → 空产出兜底。
 */
export function renderHomeSettlementText(settlement: HomeSettlement): string {
  if (settlement.blocked) return settlement.blocked;
  const lines = [`${settlement.playerName}的家园产出`];
  if (!settlement.hasPower) return `${lines[0]}\n电力不足，建筑生产停止`;
  for (const item of settlement.gains) {
    lines.push(`获得${item.name}x${item.quantity}`);
  }
  if (settlement.worldSimulation?.text) lines.push(settlement.worldSimulation.text);
  if (settlement.petBonusText.length > 0) lines.push(settlement.petBonusText.join('、'));
  if (lines.length === 1) lines.push('本次没有产出任何物品');
  return lines.join('\n');
}

/** 总览数值格式化：两位小数封顶（项目数值红线），String 自动去尾零 */
function formatOverviewNumber(value: number): string {
  return String(Math.round((Number(value) || 0) * 100) / 100);
}

/** 秒数 → 时长文本（原版 数字到时间；不足1秒显示「不到1秒」，零段省略） */
function secondsToTimeText(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 1) return '不到1秒';
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`;
  if (hours > 0) return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`;
  if (minutes > 0) return `${minutes}分钟`;
  return `${total}秒`;
}

/**
 * 家园总览文本渲染器（纯函数，无副作用）。
 * 原版 观测地图 L515-565 投影：「使魔家园」标题行之后追加的总览段。
 * 布局对齐原版宏：作物与建筑同行（#z9=制表符）、岗位与模式同行，
 * 电力/燃料/肥料/每日产出各占一行；供应量不足提示独立成行、位于对应行之前。
 */
export function renderHomeOverviewText(settlement: HomeSettlement): string {
  const overview = settlement.overview;
  if (!overview) return '';
  const lines: string[] = [];
  lines.push(`作物:${overview.cropCount}/${overview.cropLimit}\t建筑:${overview.buildingCount}/${overview.buildingLimit}`);
  if (overview.laborShortage) lines.push('(人力不足以胜任岗位,多抓几只宠物吧)');
  lines.push(`岗位:${formatOverviewNumber(overview.jobSupply)}/${overview.jobDemand}\t模式:${settlement.overloaded ? '超载' : '正常'}`);
  lines.push(`电力:${overview.powerNet}/${overview.powerGeneration}${overview.powerNet <= 0 ? '(电力不足,建筑生产停止)' : ''}`);
  if (overview.fuelShortage) lines.push('(燃料供应量不足！)');
  lines.push(`燃料:${formatOverviewNumber(overview.fuelStock)}(${overview.fuelSeconds === null ? '∞' : secondsToTimeText(overview.fuelSeconds)})`);
  if (overview.fertilizerShortage) lines.push('(肥料供应量不足！)');
  lines.push(`肥料:${formatOverviewNumber(overview.fertilizerStock)}(${overview.fertilizerSeconds === null ? '∞' : secondsToTimeText(overview.fertilizerSeconds)})`);
  const daily = overview.dailyDisplay
    .map((item) => `${item.name}x${formatOverviewNumber(item.quantity)}`)
    .join('、');
  lines.push(`每日产出:${daily}`);
  return lines.join('\n');
}
