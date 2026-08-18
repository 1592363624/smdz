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

// ==================== 类型定义 ====================

/**
 * 生产物品接口
 * 对应原版易语言的"产出"数据类型
 * 表示单个产出物品的名称、数量和几率
 */
export interface ProduceItem {
  name: string;
  quantity: number;
  /** 静态配置和历史存档使用 count；进入计算前会归一化为 quantity */
  count?: number;
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
   * 生成临时建筑 - 多产出
   * 对应原版：生成临时建筑_多产出()
   * 创建一个临时建筑资源，产出多个指定物品
   * 用于生产建筑、种植等场景中的临时资源生成
   * @param items 产出物品数组
   * @param buildingCount 建筑数量（不指定则默认为1）
   * @param specifiedPriority 指定优先级（不指定则默认为1）
   * @returns 生产者对象
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
   * 生成临时建筑 - 单产出
   * 对应原版：生成临时建筑()
   * 创建一个临时建筑资源，生产指定物品
   * 支持从建筑列表中查找已有建筑定义
   * @param outputName 产出名称
   * @param outputQuantity 产出数量
   * @param specifiedName 指定名称（不为空时会从建筑列表查找）
   * @param buildingCount 建筑数量（不指定则默认为1）
   * @param specifiedPriority 指定优先级（不指定且查不到建筑时默认为2）
   * @param buildingList 建筑列表（用于按名称查找建筑定义）
   * @returns 生产者对象
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
   * 是否有特殊宠物
   * 对应原版：是否有特殊宠物()
   * 检查地图上是否存在指定特殊序号的宠物
   * 特殊宠物会影响生产加成（如龙女仆、英招、执行者等）
   * @param specialSeq 特殊序号
   * @param units 地图上的单位数组（召唤物/宠物）
   * @param requireAlive 是否要求存活（生命值大于0）
   * @returns 找到的单元下标，未找到返回-1
   */
  hasSpecialPet(
    specialSeq: number,
    units: any[],
    requireAlive?: boolean,
  ): number {
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      // 检查特殊序号（原版用"活力"字段存特殊序号）
      const unitSpecialSeq = unit.specialSeq || unit.vitality || 0;
      if (unitSpecialSeq === specialSeq) {
        if (requireAlive) {
          // 需要存活才返回
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
   * @param producers 生产者数组（建筑/作物）
   * @param storage 存放地（物品数组，用于消耗品检查）
   * @param timeDiff 时间差（秒，距离上次观测流逝了多少秒）
   * @param priority 优先级（只计算指定优先级的产出）
   * @param productionType 生产类型（1=作物，2=建筑）
   * @param buildingOutputRate 建筑产出倍率
   * @param cropOutputRate 作物产出倍率
   * @param powerConsumeRate 电力消耗倍率
   * @param fuelConsumeRate 燃料消耗倍率
   * @param powerFuelOutputRate 燃电产出倍率
   * @param laborSupplyRate 人力供应倍率
   * @param noConsume 是否无视消耗（为true时无视消耗也能产出）
   * @returns 产出物品数组
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

    // 遍历所有生产者，只计算指定优先级的
    for (const producer of producers) {
      if (producer.priority !== priority) continue;

      // 计算单个建筑的最小产出时间（受消耗品供应量影响）
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

      // 遍历该生产者的所有产出
      for (const output of producer.outputs) {
        const outputQuantity = this.getProduceQuantity(output);
        // 计算基础产出量
        // 公式：数量 × 人力供应倍率 × 次数 × 生产时间 / 60
        let quantity = outputQuantity * laborSupplyRate * producer.count * productionTime / 60;

        if (productionType === 1) {
          // 作物类型：作物相同时间产出是建筑的10%
          if (outputQuantity > 0) {
            quantity = quantity * cropOutputRate * 0.1;
          } else {
            quantity = quantity * 0.1;
          }
        } else {
          // 建筑类型
          if (outputQuantity > 0) {
            // 正产出：应用建筑产出倍率
            quantity = quantity * buildingOutputRate;
            // 电力/燃料有独立倍率
            if (output.name === '电力' || output.name === '燃料') {
              quantity = quantity * powerFuelOutputRate;
            }
          } else {
            // 负产出（消耗品）：应用消耗倍率
            if (output.name === '电力') {
              quantity = quantity * powerConsumeRate;
            } else if (output.name === '燃料') {
              quantity = quantity * fuelConsumeRate;
            }
          }
        }

        // 原版产出资源 L116：电力只参与总平衡，不写入家园存放地。
        if (output.name === '电力') continue;

        // 添加到产出列表
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
   * @param producer 生产者
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
   * @param buildings 建筑物品数组
   * @param buildingDefs 建筑定义列表（从数据库GameBuilding表加载）
   * @returns 生产者数组
   */
  convertToProduction(
    buildings: BuildingItem[],
    buildingDefs: any[],
  ): Producer[] {
    const producers: Producer[] = [];

    for (const building of buildings) {
      // 在建筑定义列表中查找匹配项
      const def = buildingDefs.find(d => d.name === building.name);
      if (!def) continue;

      const producer: Producer = {
        name: def.name,
        type: def.type || '',
        count: this.getItemQuantityValue(building),
        // 从建筑定义的 materials 字段解析产出（原版中建筑产出存储在产出2，这里统一用 outputs）
        outputs: this.normalizeProduceItems(this.safeParseJSON<any[]>(def.materials, [])),
        priority: def.priority ?? ((building.type || def.type) === '作物' ? 1 : 2),
        notOccupy: Boolean(def.notOccupy ?? def['不占']),
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
   * @returns 地图产出分析结果
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

    // ----- 计算作物总产出 -----
    for (const crop of crops) {
      for (const output of crop.outputs) {
        const outputQuantity = this.getProduceQuantity(output);
        tempItem.name = output.name;
        // 作物的产出/10=建筑相同时间产出
        tempItem.quantity = outputQuantity * crop.count / 10;

        if (output.name === '电力' && outputQuantity > 0) {
          powerGeneration += tempItem.quantity;
        }

        tempItem.quantity = tempItem.quantity * cropOutputRate * laborSupplyRate;

        this.addToOutput(cropOutput, { ...tempItem });
        this.addToOutput(totalOutput, { ...tempItem });

        if (tempItem.quantity < 0) {
          this.addToOutput(totalConsumption, { ...tempItem });
        }
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
   * @param map 当前地图对象
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
        const resourceOutputs: ProduceItem[] = (resource as any).outputs || (resource as any)['产出'] || [];
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
   * @param buildings 建筑物品数组
   * @param buildingDefs 建筑定义列表
   * @returns 有效建筑数量
   */
  getBuildingCount(
    buildings: BuildingItem[],
    buildingDefs: any[],
  ): number {
    let total = 0;

    for (const building of buildings) {
      // 在建筑定义列表中查找
      const def = buildingDefs.find(d => d.name === building.name);
      if (def) {
        // 检查是否"不占"类型（不占建筑位置）
        const notOccupy = def.notOccupy || false;
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
   * @param map 地图对象
   * @param buildingName 建筑名称
   * @param buildingDefs 建筑定义列表
   * @param backpack 玩家背包（会从中扣除材料）
   * @returns 建造结果对象
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
      mapBuildings.push({ name: buildingName, quantity: 1, count: 1, type: def.type || '' });
    }

    // 更新地图建筑数据
    map.buildings = JSON.stringify(mapBuildings);

    return { success: true, message: `成功建造了「${buildingName}」` };
  }

  /**
   * 建筑拆除
   * 对应原版：拆除建筑相关逻辑
   * 拆除地图上的建筑，返还部分材料（50%）
   * 
   * @param map 地图对象
   * @param buildingName 建筑名称
   * @param buildingDefs 建筑定义列表
   * @param backpack 玩家背包（返还材料会加入）
   * @returns 拆除结果对象
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

    // 减少数量
    const buildingQuantity = this.getItemQuantityValue(building);
    if (buildingQuantity > 1) {
      this.setItemQuantity(building, buildingQuantity - 1);
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

    // 更新地图建筑数据
    map.buildings = JSON.stringify(mapBuildings);

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
   * @param map 地图对象
   * @param seedName 种子名称
   * @param backpack 玩家背包
   * @param buildingDefs 建筑定义列表（用于查找作物定义）
   * @returns 种植结果
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

    // 查找作物定义（从建筑定义中查找）
    // 种子名称通常以"种子"结尾，对应的作物名称去掉"种子"后缀
    let cropName = seedName;
    if (seedName.endsWith('种子')) {
      cropName = seedName.substring(0, seedName.length - 2);
    }

    const def = buildingDefs.find(d => d.name === cropName);
    if (!def) {
      return { success: false, message: `找不到「${cropName}」的作物定义` };
    }

    // 消耗种子
    const seedItem = backpack[seedIndex];
    const seedQuantity = this.getItemQuantityValue(seedItem);
    if (seedQuantity > 1) {
      this.setItemQuantity(seedItem, seedQuantity - 1);
    } else {
      backpack.splice(seedIndex, 1);
    }

    // 将作物添加到地图建筑列表（作为作物类型）
    const mapBuildings = this.safeParseJSON<any[]>(map.buildings, []);
    const existingCrop = mapBuildings.find((b: any) => b.name === cropName);
    if (existingCrop) {
      this.setItemQuantity(existingCrop, this.getItemQuantityValue(existingCrop) + 1);
    } else {
      mapBuildings.push({ name: cropName, quantity: 1, count: 1, type: '作物' });
    }

    map.buildings = JSON.stringify(mapBuildings);

    return { success: true, message: `成功种植了「${cropName}」` };
  }

  /**
   * 收获作物
   * 收获指定作物，将产出加入背包，移除作物
   * 
   * @param map 地图对象
   * @param cropName 作物名称
   * @param buildingDefs 建筑定义列表
   * @param backpack 玩家背包
   * @returns 收获结果
   */
  async harvestCrop(
    map: any,
    cropName: string,
    buildingDefs: any[],
    backpack: any[],
  ): Promise<{ success: boolean; message: string }> {
    const mapBuildings = this.safeParseJSON<any[]>(map.buildings, []);
    const cropIndex = mapBuildings.findIndex((b: any) => b.name === cropName);
    if (cropIndex === -1) {
      return { success: false, message: `地图上没有「${cropName}」` };
    }

    const def = buildingDefs.find(d => d.name === cropName);
    if (!def) {
      return { success: false, message: `找不到「${cropName}」的定义` };
    }

    // 获取产出
    const outputs = this.normalizeProduceItems(this.safeParseJSON<any[]>(def.materials, []));
    const crop = mapBuildings[cropIndex];
    const cropCount = this.getItemQuantityValue(crop);

    // 移除作物
    mapBuildings.splice(cropIndex, 1);
    map.buildings = JSON.stringify(mapBuildings);

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
      message: `收获了「${cropName}」×${cropCount}，获得：${harvested.join('、')}`,
    };
  }

  /**
   * 宠物生产
   * 对应原版：宠物自动产出（如执行者的蛋产出、英招的羽毛产出等）
   * 计算地图上特殊宠物的额外产出
   * 
   * @param map 地图对象
   * @param specialSeq 特殊序号
   * @param outputName 产出物品名称
   * @param outputQuantity 每个宠物的产出量
   * @param timeDiff 时间差（秒）
   * @returns 产出物品数组
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
      if (item.name === name) {
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
      if (item.name === name) {
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
  private addItemToArray(name: string, quantity: number, items: any[]): void {
    const existing = items.find((item: any) => item.name === name);
    if (existing) {
      this.setItemQuantity(existing, this.getItemQuantityValue(existing) + quantity);
    } else {
      items.push({ name, quantity, count: quantity, type: '资源' });
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

  private normalizeProduceItems(items: any[]): ProduceItem[] {
    return (Array.isArray(items) ? items : [])
      .filter((item) => item && item.name)
      .map((item) => ({
        ...item,
        name: String(item.name),
        quantity: Number(item.quantity ?? item.count ?? 0),
      }));
  }

  private getProduceQuantity(item: any): number {
    return Number(item?.quantity ?? item?.count ?? 0);
  }

  private getItemQuantityValue(item: any): number {
    return Number(item?.quantity ?? item?.count ?? 1);
  }

  private setItemQuantity(item: any, value: number): void {
    if (Object.prototype.hasOwnProperty.call(item, 'count') && !Object.prototype.hasOwnProperty.call(item, 'quantity')) {
      item.count = value;
    } else {
      item.quantity = value;
    }
  }

  /**
   * 安全解析 JSON 字符串
   */
  private safeParseJSON<T>(jsonStr: string, defaultValue: T): T {
    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      return defaultValue;
    }
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
   * @param markers 玩家标记
   * @returns 产出倍率（默认1.0）
   */
  getBuildingOutputRate(markers: Record<string, number>): number {
    return markers['产出倍率'] || 1.0;
  }

  /**
   * 观测并领取家园产出。
   * 对应地图操作.ecode L53-540：先计算电力/燃料可支撑时间，再按优先级执行产出。
   * 该入口集中所有家园公式，避免旧使魔服务维护另一套简化实现。
   */
  async collectHomeOutput(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const markers = this.playerService.safeJsonParse<any>(player.markers, {});
    const progress = this.playerService.getMarkerValue(markers, '家园进度');
    if (progress < 4) return '家园尚未建成，无法产出';
    if (!player.houseName && !player.mapId) return '你还没有家园所在地图';

    const map = player.houseName
      ? await this.mapService.getMapByName(player.houseName).catch(() => null)
      : await this.mapService.getMapById(player.mapId);
    if (!map) return '家园所在的地图不存在';

    const buildings = this.safeParseJSON<any[]>(map.buildings, []);
    const definitions = this.staticData.getAllBuildings();
    const producers = this.convertToProduction(buildings, definitions);
    // 原版地图.资源2中“产出2”非空的条目才是作物；作物不存于建筑列表。
    const cropResources = this.safeParseJSON<any[]>(map.resources2, []);
    const cropProducers: Producer[] = cropResources
      .filter((resource: any) => {
        const outputs = resource?.outputs2 ?? resource?.产出2 ?? [];
        return Array.isArray(outputs) && outputs.length > 0;
      })
      .map((resource: any): Producer => ({
        name: resource.name ?? resource.名称 ?? '',
        type: '作物',
        count: Number(resource.count ?? resource.times ?? resource.次数 ?? 0),
        outputs: this.normalizeProduceItems(resource.outputs2 ?? resource.产出2 ?? []),
        priority: Number(resource.priority ?? resource.优先级 ?? 1),
      }))
      .filter((resource) => resource.count > 0 && resource.outputs.length > 0);
    const storage = this.playerService.getBackpackItems(player);
    const summons = this.safeParseJSON<any[]>(map.summons, []);
    const alive = (pet: any): boolean => (pet?.hp ?? pet?.当前生命 ?? 0) > 0;
    const hasPet = (name: string, seq: number, requireAlive = true): boolean => summons.some((pet: any) => {
      const petSeq = pet?.vitality ?? pet?.活力 ?? pet?.specialSeq;
      return (pet?.name === name || pet?.名称 === name || petSeq === seq) && (!requireAlive || alive(pet));
    });
    const petCount = summons.length;
    const countBuilding = (name: string): number => buildings
      .filter((b: any) => b?.name === name)
      .reduce((sum: number, b: any) => sum + this.getItemQuantityValue(b), 0);
    const markerValue = (source: any, name: string): number => {
      if (Array.isArray(source)) {
        const item = source.find((x: any) => (x?.名称 ?? x?.name) === name);
        return Number(item?.数值 ?? item?.value ?? item?.count ?? 0);
      }
      return Number(source?.[name] ?? 0);
    };

    const now = Date.now() / 1000;
    const lastOutput = markerValue(markers, '家园产出时间');
    const timeDiff = lastOutput > 0 ? Math.max(0, now - lastOutput) : 60;
    const mapMarkers = this.safeParseJSON<any>(map.markers, {});
    const overloaded = markerValue(mapMarkers, '生产模式') === 1;
    let buildingOutputRate = overloaded ? 1.25 : 1;
    const cropOutputRateBase = 1;
    let cropOutputRate = cropOutputRateBase;
    let powerConsumeRate = 1;
    let fuelConsumeRate = overloaded ? 1.5 : 1;
    let powerFuelOutputRate = 1;

    // 原版 L54：兰音幼崽令地图时间流逝速度×105%。
    if (hasPet('兰音幼崽', -30)) {
      // 原版效果作用于时间差本身，保留小数，不提前取整。
      (markers as any)['家园产出时间倍率'] = 1.05;
    }
    const effectiveTimeDiff = hasPet('兰音幼崽', -30) ? timeDiff * 1.05 : timeDiff;

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
    const cropLimit = Math.ceil((player.level || 1) / 5) + markerValue(markers, '凭证') * 5;
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
    const vermilion = summons.find((pet: any) => (pet?.vitality ?? pet?.活力 ?? pet?.specialSeq) === -21
      || pet?.name === '朱雀' || pet?.名称 === '朱雀');
    if (vermilion && alive(vermilion)) {
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

    // 原版 L334：腐化南方巨兽龙移除全部生物质，并转换为水晶和生肉。
    if (hasPet('腐化南方巨兽龙', -29)) {
      const rawBiomass = Math.max(0, this.getItemQuantity('生物质', baseAnalysis.totalOutput));
      if (rawBiomass > 0) {
        buildingProducers.push(this.createTempBuildingMulti([
          { name: '水晶', quantity: rawBiomass * 500 },
          { name: '生肉', quantity: rawBiomass * 50 },
          { name: '生物质', quantity: -rawBiomass },
        ], 1, 7));
      }
    }

    // 肉食植物：把基础产出的90%生肉按原版比例转换为绳子/果实/肥料。
    if (hasPet('肉食植物', -25)) {
      const rawMeat = Math.max(0, this.getItemQuantity('生肉', baseAnalysis.totalOutput));
      if (rawMeat > 0) {
        const ratio = (markerValue(mapMarkers, '肉食比例') || 90) / 100;
        buildingProducers.push(this.createTempBuildingMulti([
          { name: '绳子', quantity: rawMeat * ratio * 3 },
          { name: '果实', quantity: rawMeat * ratio / 10 },
          { name: '肥料', quantity: rawMeat * ratio / 1000 },
          { name: '生肉', quantity: -rawMeat * ratio },
        ], 1, 5));
      }
    }

    // 小雨下/小恶魔/白兔子/腐化南方巨兽龙的固定家园产出，均按“每日数量/1440”转为每分钟资源。
    if (hasPet('小雨下', -18)) {
      buildingProducers.push(this.createTempBuildingMulti([
        { name: '灵石', quantity: 6 / 1440 },
        { name: '生肉', quantity: -1000 / 1440 },
      ], 1, 7));
    }
    if (hasPet('小恶魔', -20)) {
      buildingProducers.push(this.createTempBuildingMulti([
        { name: '糖心巧克力', quantity: 3 / 1440 },
        { name: '巧克力', quantity: -600 / 1440 },
      ], 1, 7));
    }
    if (hasPet('白兔子', -17) && this.getItemQuantity('奶', baseAnalysis.totalOutput) > 0) {
      buildingProducers.push(this.createTempBuilding('奶油蛋糕', 0.002084, undefined, 1, 2));
    }

    if (hasPet('螳螂', -26)) {
      const mantis = summons.find((pet: any) => (pet?.vitality ?? pet?.活力 ?? pet?.specialSeq) === -26
        || pet?.name === '螳螂' || pet?.名称 === '螳螂');
      const gather = Number(mantis?.采集 ?? mantis?.属性?.采集 ?? mantis?.gathering ?? 0);
      if (gather > 0) {
        buildingProducers.push(this.createTempBuilding('铁矿', cropLimit * gather / 1440, undefined, 1, 2));
      }
    }

    // 心之守望在完成总览计算后，为每个每分钟产量>=1的非电力产物额外+1。
    if (hasPet('心之守望', -12)) {
      const heart = summons.find((pet: any) => (pet?.vitality ?? pet?.活力 ?? pet?.specialSeq) === -12
        || pet?.name === '心之守望' || pet?.名称 === '心之守望');
      const heartFactor = 1 + Number(heart?.level || 1) / 100;
      for (const item of baseAnalysis.totalOutput) {
        if (item.name !== '电力' && item.quantity >= 1) {
          buildingProducers.push(this.createTempBuilding(item.name, heartFactor, undefined, 1, 2));
        }
      }
    }

    // 兔子窝补充所有非电力负产出。金额按原版 a1=2000*兔子窝数量/负产出种类均分。
    const rabbitNestCount = countBuilding('兔子窝');
    const shortages = baseAnalysis.totalOutput
      .filter((item) => item.quantity < 0 && item.name !== '电力')
      .map((item) => item.name)
      .filter((name, index, names) => names.indexOf(name) === index);
    if (rabbitNestCount > 0 && shortages.length > 0) {
      const budgetPerItem = 2000 * rabbitNestCount / shortages.length;
      for (const shortageName of shortages) {
        const itemDef = this.staticData.getItemByName(shortageName);
        const value = Number(itemDef?.value ?? 0);
        const perMinute = value > 0
          ? budgetPerItem / value / 1440
          : budgetPerItem * Math.abs(value || 1) / 1440;
        buildingProducers.push(this.createTempBuilding(shortageName, perMinute, undefined, 1, 7));
      }
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

    markers['家园产出时间'] = now;
    player.markers = JSON.stringify(markers);
    const resultLines = [`${player.name || '冒险者'}的家园产出`];
    if (!analysis.hasPower) {
      this.removeItemQuantity('肥料', temporaryFertilizer, storage);
      await this.playerService.savePlayer(player);
      return `${resultLines[0]}\n电力不足，建筑生产停止`;
    }

    const duration = analysis.remainingFuel;
    const outputItems: ProduceItem[] = [];
    for (let priority = 1; priority <= 7; priority++) {
      const cropOut = this.produceResources(
        limitedCrops.filter((p) => p.priority === priority),
        storage,
        duration,
        priority,
        1,
        buildingOutputRate,
        cropOutputRate,
        1,
        1,
        1,
        1,
      );
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
          resultLines.push(`获得${item.name}x${item.quantity}`);
        } else if (item.quantity < 0) {
          this.removeItemQuantity(item.name, Math.abs(item.quantity), storage);
        }
      }
    }

    this.removeItemQuantity('肥料', temporaryFertilizer, storage);

    player.backpack = JSON.stringify(storage);
    await this.playerService.savePlayer(player);
    if (resultLines.length === 1) resultLines.push('本次没有产出任何物品');
    return resultLines.join('\n');
  }
}
