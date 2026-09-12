/**
 * 家园/建造指令域服务（game 模块化重构 P3-2 抽出）
 *
 * 职责：家园入口、建造房屋/地基、圈地、安装（部件/燃料/全部）、拆卸（部件/全部）、
 * 家园产出/作物/建筑/家园查看、信号枪、货舱召唤延时结算（completeCargoSummon/
 * applyCargoSummon）、updateMapBuildings 地图建筑写口。
 * 依赖方向：依赖 Player、Map、FamiliarSystemService、Prisma、StaticData、
 * DelayedTaskService、HomeService、Task、CombatState 与支撑层；跨域直接注入
 * 兄弟子服务 ShopTrade、MovementVehicle（互调边，forwardRef 断环）、GatherPanel。
 * 单一真相源：地图建筑写入统一 updateMapBuildings（mapService.updateDynamicFields 闭环）；
 * 背包合并统一支撑层 addItemToCollection/mergeBackpackItem。
 * 对口原版：_主程序.ecode 家园/建造/货舱召唤分支。
 */import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlayerService } from '.././player.service';
import { MapService } from '.././map.service';
import { HomeService } from '.././home.service';
import { FamiliarSystemService } from '.././familiar-system.service';
import { StaticDataService } from '.././static-data.service';
import { TaskService } from '.././task.service';
import { CombatStateService } from '.././combat-state.service';
import { DelayedTaskService } from '.././delayed-task.service';
import { GameSupportService } from '.././game-support.service';
import { ShopTradeService } from './shop-trade.service';
import { GatherPanelService } from './gather-panel.service';
import { MovementVehicleService } from './movement-vehicle.service';

@Injectable()
export class HomeBuildService {
  private readonly logger = new Logger(HomeBuildService.name);

  constructor(
    private readonly support: GameSupportService,
    private readonly shopTradeService: ShopTradeService,
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly mapService: MapService,
    private readonly homeService: HomeService,
    private readonly familiarSystemService: FamiliarSystemService,
    private readonly staticData: StaticDataService,
    private readonly taskService: TaskService,
    private readonly combatState: CombatStateService,
    // 跨域兄弟直连（P4 清理：原过渡期经门面引用）。home↔movement 互调边用 forwardRef 断环；
    // panel 处于模块循环导入 SCC（gather↔movement↔home↔rescue）内，同样必须 forwardRef。
    @Inject(forwardRef(() => MovementVehicleService))
    private readonly movement: MovementVehicleService,
    @Inject(forwardRef(() => GatherPanelService))
    private readonly panel: GatherPanelService,
    @Optional() private readonly delayedTaskService?: DelayedTaskService,
  ) {}

  async handleHome(userId: number, subCommand: string, ...args: string[]): Promise<string> {
    const normalized = (subCommand || '').trim();
    if (!normalized) {
      return this.familiarSystemService.handleHome(userId, '');
    }

    // 旧的 HomeHandler 会把“命名 新名称”作为一个字符串传入；按原版命令
    // 的首个词识别子命令，其余文本作为参数交给家园系统。
    const parts = normalized.split(/\s+/);
    const command = parts.shift() || '';
    return this.familiarSystemService.handleHome(userId, command, ...parts, ...args);
  }

  /**
   * 探测当前地图
   * 显示当前地图的资源、怪物、可交互物品等详细信息
   */

  async handleFamiliarHome(userId: number): Promise<string> {
    // 委托到 FamiliarSystemService 的家园查看操作
    return this.familiarSystemService.handleHome(userId, '查看');
  }

  /**
   * 处理建造房子命令
   * 在家园中建造房子，委托到 FamiliarSystemService 的家园建造房子操作
   * 对应原版：建造房子 命令
   */

  async handleBuildHouse(userId: number): Promise<string> {
    // 委托到 FamiliarSystemService 的家园建造房子操作
    return this.familiarSystemService.handleHome(userId, '建造房子');
  }

  /**
   * 处理开挖地基命令
   * 开挖家园地基，委托到 FamiliarSystemService 的家园开挖地基操作
   * 对应原版：开挖地基 命令
   */

  async handleDigFoundation(userId: number): Promise<string> {
    // 委托到 FamiliarSystemService 的家园开挖地基操作
    return this.familiarSystemService.handleHome(userId, '开挖地基');
  }

  /**
   * 处理建造地基命令
   * 建造家园地基，委托到 FamiliarSystemService 的家园建造地基操作
   * 对应原版：建造地基 命令
   */

  async handleBuildFoundation(userId: number): Promise<string> {
    // 委托到 FamiliarSystemService 的家园建造地基操作
    return this.familiarSystemService.handleHome(userId, '建造地基');
  }

  /**
   * 处理圈地命令
   * 圈地扩充家园范围，委托到 FamiliarSystemService 的家园圈地操作
   * 对应原版：圈地 命令
   */

  async handleClaimLand(userId: number): Promise<string> {
    // 委托到 FamiliarSystemService 的家园圈地操作
    return this.familiarSystemService.handleHome(userId, '圈地');
  }

  /**
   * 处理生产命令
   * 在家园中生产资源，委托到 FamiliarSystemService 的家园产出操作
   * 对应原版：产出 命令
   */

  async handleInstall(userId: number, rawName: string): Promise<string> {
    const input = String(rawName || '').trim();
    if (!input) return '请指定要安装的建筑或部件名称';
    const match = input.match(/^(.*?)(\d+)$/);
    const name = (match?.[1] || input).trim();
    const count = Math.max(1, Number(match?.[2] || 1));

    // 原版把燃料作为特殊的“家园建筑”处理：燃料必须放到自己的院子，
    // 之后家园产出会从院子建筑/物品存放中消耗它，而不是安装到载具。
    if (name === '燃料') {
      return this.handleInstallHomeFuel(userId, count);
    }

    const building = this.staticData.getBuildingByName(name);

    if (!building) return this.handleInstallPart(userId, name, count);

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上';
    const houseName = String(player.houseName || '').trim();
    if (!houseName) return '你还没有家园';

    const materials = asJsonValue<any[]>(building.materials, []);
    const isProductionBuilding = materials.some((item: any) =>
      Number(item?.quantity ?? item?.count ?? item?.数量 ?? 0) !== 0,
    );
    const isYard = map.name === houseName;
    const isIndoor = map.name === `${houseName}屋内`;
    if (isProductionBuilding && !isYard) {
      return `${player.name}生产类建筑只能安装在自己的院子里`;
    }
    if (!isProductionBuilding && !isIndoor && !player.vehicle) {
      return `${player.name}功能类建筑只能安装在自己屋子里或载具里`;
    }

    // 建筑在屋内时写入地图；载具内的功能建筑走组装入口。
    if (!isProductionBuilding && !isIndoor && player.vehicle) {
      return this.handleAssembleBuilding(userId, name, count);
    }

    const backpack = this.playerService.getBackpackItems(player);
    const result = this.homeService.installBuilding(map, name, backpack, count);
    if (!result.success) return result.message;
    await this.mapService.updateDynamicFields(map.id, { buildings: map.buildings });
    player.backpack = backpack; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    return result.message;
  }

  /** 把背包燃料放入自己的家园院子，兼容原版“安装燃料N”快捷操作。 */

  async handleInstallHomeFuel(userId: number, requestedCount: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${player.name || '冒险者'}不在服务区`;
    if (!player.houseName || map.name !== player.houseName) {
      return `${player.name || '冒险者'}燃料只能放院子里`;
    }

    const backpack = this.playerService.getBackpackItems(player);
    const available = Math.floor(this.support.itemQuantity(
      backpack.find((item: any) => (item?.name ?? item?.名称) === '燃料'),
    ));
    const count = Math.min(Math.max(1, Math.floor(requestedCount)), available);
    if (count <= 0) return `${player.name || '冒险者'}你没有燃料`;

    this.support.deductBackpackItem(backpack, '燃料', count);
    const items = asJsonValue<any[]>(map.items, []);
    this.support.addItemToCollection(items, { name: '燃料', type: '资源', quantity: count });
    await this.mapService.updateDynamicFields(map.id, { items });
    player.backpack = backpack; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    return `${player.name || '冒险者'}把${count}个燃料放到了${map.name}里`;
  }

  /** 把床等功能建筑放入当前载具的零件/物品数组。 */

  async handleAssembleBuilding(userId: number, buildingName: string, count = 1): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const vehicleId = Number(player.vehicle);
    if (!Number.isInteger(vehicleId) || vehicleId <= 0) return '载具数据异常';
    const vehicle = await this.prisma.gameVehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle) return '载具数据不存在';

    const available = this.playerService.getBackpackItems(player)
      .filter((item: any) => item.name === buildingName)
      .reduce((sum: number, item: any) => sum + Number(item.count ?? item.quantity ?? 0), 0);
    const assembled = Math.min(Math.max(1, Math.floor(count)), Math.floor(available));
    if (assembled <= 0) return `背包中没有【${buildingName}】`;
    if (!await this.playerService.removeFromBackpack(userId, buildingName, assembled)) {
      return '从背包移除建筑失败';
    }

    const parts = asJsonValue<any[]>(vehicle.parts, []);
    const existing = parts.find((part: any) => part.name === buildingName);
    if (existing) {
      const next = Number(existing.quantity ?? existing.count ?? 0) + assembled;
      existing.quantity = next;
      existing.count = next;
    } else {
      parts.push({ name: buildingName, type: '资源', quantity: assembled, count: assembled, partType: -1 });
    }
    await this.prisma.gameVehicle.update({
      where: { id: vehicle.id },
      data: { parts },
    });
    return `把${assembled}个${buildingName}组装到了载具【${vehicle.name}】里`;
  }

  /**
   * 安装载具部件
   * 将背包中的部件安装到当前驾驶的载具上
   * @param userId 用户ID
   * @param partName 部件名称
   */

  async handleInstallPart(userId: number, partName: string, count = 1): Promise<string> {
    const requestedCount = Math.max(1, Math.floor(Number(count) || 1));
    // 1. 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    // 2. 检查玩家是否有载具（player.vehicle 字段存储载具ID）
    if (!player.vehicle) {
      return '你还没有驾驶载具，无法安装部件';
    }
    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) {
      return '载具数据异常';
    }

    // 从数据库查询载具定义
    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      return '载具数据不存在';
    }

    // 3. 从背包中查找部件
    const backpackItem = backpack.find((item: any) => item.name === partName);
    if (!backpackItem) {
      return `背包中没有【${partName}】`;
    }

    // 4. 通过载具部件配置验证是否为有效部件（静态配置 JSON 单一来源）
    const partDef = this.staticData.getVehiclePartByName(partName);
    if (!partDef) {
      return `【${partName}】不是有效的载具部件`;
    }

    // 5. 检查部件类型和插槽限制
    const parts = asJsonValue<any[]>(vehicle.parts, []);
    const partType = partDef.partType; // 0核心 1防御 2行走 3武器 4功能

    // 统计已安装的同类型部件数量，并按背包数量和插槽上限计算实际安装数。
    const typeCount = parts.filter((p: any) => Number(p.partType) === partType).length;

    // 获取插槽限制
    const slotLimit = this.movement.getSlotLimit(vehicle, partType);

    const available = Math.max(0, Math.floor(this.support.itemQuantity(backpackItem)));
    const installCount = Math.min(requestedCount, available, Math.max(0, slotLimit.max - typeCount));
    if (installCount <= 0 && available <= 0) {
      return `背包中没有【${partName}】`;
    }

    // 检查是否达到硬上限
    if (installCount <= 0) {
      return `【${slotLimit.name}】插槽已达上限（${typeCount}/${slotLimit.max}），无法安装更多【${slotLimit.name}】部件`;
    }

    // 如果超过建议插槽数但未达上限，给出提示
    const overSuggested = typeCount + installCount > slotLimit.slots && slotLimit.slots < slotLimit.max;

    // 6. 从背包移除部件
    const removed = await this.playerService.removeFromBackpack(userId, partName, installCount);
    if (!removed) {
      return '从背包移除部件失败';
    }

    // 7. 将部件添加到载具的 parts 字段
    // 解析部件加成属性
    const partBonus = asJsonValue<any>(partDef.bonus, {});
    const newPart = {
      name: partName,
      partType: partType,
      bonus: partBonus,
      description: partDef.description || '',
    };
    for (let i = 0; i < installCount; i++) parts.push({ ...newPart });

    // 8. 更新载具加成（重新计算总加成）
    const totalBonus = this.movement.calcVehicleTotalBonus({
      ...vehicle,
      parts, // calcVehicleTotalBonus 内部用 asJsonValue 读取，直接传数组
    });

    // 9. 保存载具数据
    await this.prisma.gameVehicle.update({
      where: { id: vehicleId },
      data: {
        parts,
        bonus: totalBonus,
      },
    });

    this.logger.log(`玩家 ${userId} 安装了部件 ${partName} 到载具 ${vehicle.name}`);

    // 始终返回实际安装数量，命令层据此推进任务，避免库存不足时使用请求数量。
    const quantityText = `×${installCount}`;
    let result = `✅ 成功将【${partName}】${quantityText}安装到载具【${vehicle.name}】上\n类型: ${slotLimit.name}`;
    if (overSuggested) {
      result += `\n⚠️ 警告：该类型插槽建议数量为 ${slotLimit.slots}，当前已安装 ${typeCount + installCount} 个`;
    }
    return result;
  }

  /**
   * 拆卸载具部件
   * 从载具上拆卸部件放回背包
   * @param userId 用户ID
   * @param partName 部件名称
   */

  async handleUninstallPart(userId: number, partName: string, count = 1): Promise<string> {
    const requestedCount = Math.max(1, Math.floor(Number(count) || 1));
    // 1. 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 原版“拆卸”先按当前地图处理家园建筑，再按载具部件处理。
    // 保留同一个公开入口，避免家园菜单快捷指令被误判成载具操作。
    const currentMap = await this.mapService.getMapById(player.mapId);
    const homeBuildingResult = await this.tryUninstallHomeBuilding(
      userId,
      player,
      currentMap,
      partName,
      requestedCount,
    );
    if (homeBuildingResult !== null) return homeBuildingResult;

    // 2. 检查玩家是否有载具
    if (!player.vehicle) {
      return '你还没有驾驶载具，无法拆卸部件';
    }
    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) {
      return '载具数据异常';
    }

    // 查询载具定义
    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      return '载具数据不存在';
    }

    // 3. 从载具的 parts 字段查找部件；普通部件按条目存储，建筑/资源部件可能带数量。
    const parts = asJsonValue<any[]>(vehicle.parts, []);
    const matching = parts.filter((part: any) => part.name === partName);
    if (matching.length === 0) {
      return `载具【${vehicle.name}】上没有安装【${partName}】`;
    }

    const available = matching.reduce((sum: number, part: any) => {
      const quantity = Number(part.quantity ?? part.count ?? 1);
      return sum + (Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0);
    }, 0);
    if (available <= 0) return `载具【${vehicle.name}】上没有安装【${partName}】`;
    const removeCount = Math.min(requestedCount, available);
    const removedPart = matching[0];

    // 4. 从载具移除实际数量
    let remaining = removeCount;
    const remainingParts: any[] = [];
    for (const part of parts) {
      if (part.name !== partName || remaining <= 0) {
        remainingParts.push(part);
        continue;
      }
      const quantity = Number(part.quantity ?? part.count ?? 1);
      const storedQuantity = Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0;
      const take = Math.min(storedQuantity, remaining);
      remaining -= take;
      if (take < storedQuantity) {
        const next = { ...part };
        if (next.quantity !== undefined) next.quantity = storedQuantity - take;
        else if (next.count !== undefined) next.count = storedQuantity - take;
        else next.count = storedQuantity - take;
        remainingParts.push(next);
      }
    }

    // 5. 将部件放回背包
    const added = await this.playerService.addToBackpack(userId, partName, removeCount);
    if (!added) {
      return '将部件放回背包失败';
    }

    // 6. 更新载具加成（重新计算总加成）
    const totalBonus = this.movement.calcVehicleTotalBonus({
      ...vehicle,
      parts: remainingParts, // calcVehicleTotalBonus 内部用 asJsonValue 读取，直接传数组
    });

    // 更新载具数据
    await this.prisma.gameVehicle.update({
      where: { id: vehicleId },
      data: {
        parts: remainingParts,
        bonus: totalBonus,
      },
    });

    this.logger.log(`玩家 ${userId} 从载具 ${vehicle.name} 拆卸了部件 ${partName}`);

    const partTypeName = this.support.PART_TYPE_NAMES[Number(removedPart.partType)] || '未知';
    const quantityText = removeCount > 1 ? `×${removeCount}` : '';
    return `✅ 成功从载具【${vehicle.name}】拆卸了【${partName}】${quantityText}(${partTypeName})\n部件已放回背包`;
  }

  /**
   * 尝试拆卸当前家园地图上的建筑/燃料。
   * 返回 null 表示当前地图不是玩家家园，调用方继续走载具部件分支。
   */

  async tryUninstallHomeBuilding(
    userId: number,
    player: any,
    map: any,
    buildingName: string,
    requestedCount: number,
  ): Promise<string | null> {
    if (!map || !player.houseName) return null;
    const allowed = map.name === player.houseName
      || map.name === `${player.houseName}屋内`
      || map.name === `${player.houseName}前线`;
    if (!allowed) return null;

    const name = String(buildingName || '').trim();
    if (!name) return `${player.name || '冒险者'}请指定要拆卸的建筑`;

    const buildings = asJsonValue<any[]>(map.buildings, []);
    const items = asJsonValue<any[]>(map.items, []);
    let collection = buildings;
    let index = collection.findIndex((item: any) =>
      (item?.name ?? item?.名称) === name,
    );
    // 燃料是原版“院子地面物品”，允许用拆卸快捷指令将其收回背包。
    if (index < 0 && name === '燃料') {
      collection = items;
      index = collection.findIndex((item: any) =>
        (item?.name ?? item?.名称) === name,
      );
    }
    if (index < 0) return `${player.name || '冒险者'}的${map.name}没有${name}`;

    const source = collection[index];
    const available = Math.floor(this.support.itemQuantity(source));
    const removeCount = Math.min(Math.max(1, Math.floor(requestedCount)), available);
    if (removeCount <= 0) return `${player.name || '冒险者'}的${map.name}没有${name}`;

    if (removeCount >= available) {
      collection.splice(index, 1);
    } else if (source.quantity !== undefined) {
      source.quantity = available - removeCount;
    } else {
      source.count = available - removeCount;
    }

    const backpack = this.playerService.getBackpackItems(player);
    this.support.addItemToCollection(backpack, {
      ...source,
      name,
      type: source.type ?? source.类型 ?? '资源',
      quantity: removeCount,
      count: removeCount,
    });
    await this.mapService.updateDynamicFields(map.id, {
      buildings,
      items,
    });
    player.backpack = backpack; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    return `${player.name || '冒险者'}把${map.name}的${removeCount}个${name}拆卸装箱了（×${removeCount}）`;
  }

  /**
   * 查看载具状态
   * 显示当前驾驶的载具信息
   * @param userId 用户ID
   */

  async handleInstallAll(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${player.name || '冒险者'}不在服务区`;
    if (map.name !== player.houseName) {
      return `${player.name || '冒险者'}你没在自己的院子里。`;
    }

    const backpack = this.playerService.getBackpackItems(player);
    const buildings: any[] = asJsonValue<any[]>(map.buildings, []);
    const installed: any[] = [];
    for (let i = backpack.length - 1; i >= 0; i--) {
      const item = backpack[i];
      const name = item?.name ?? item?.名称 ?? '';
      const type = item?.type ?? item?.类型 ?? '';
      const definition = this.staticData.getBuildingByName(name);
      const noPosition = Boolean(definition?.noOccupy ?? definition?.不占 ??
        (typeof definition?.description === 'string' && definition.description.includes('不占用建筑位置')));
      if (type !== '资源' || name.includes('硅基') || !definition || !noPosition) continue;
      const amount = Math.trunc(this.support.itemQuantity(item));
      if (amount <= 0) continue;
      installed.push({ name, type: '资源', quantity: amount });
      this.support.deductBackpackItem(backpack, name, amount);
    }

    if (installed.length === 0) {
      return `${player.name || '冒险者'}你背包里面没有不占位置的建筑了。`;
    }
    for (const item of installed) this.support.addItemToCollection(buildings, item);
    player.backpack = backpack; // Json 列直接写数组
    await this.mapService.updateDynamicFields(map.id, { buildings });
    await this.playerService.savePlayer(player);
    // 原版安装全部仍按每个建筑的实际数量写入安装类任务成就；
    // 硅基核心已在上面的筛选中排除，不会被一键安装或推进任务。
    for (const item of installed) {
      const count = Math.max(1, Math.trunc(Number(item.quantity) || 0));
      await this.support.advanceTask(userId, '安装', count);
      await this.support.advanceTask(userId, `安装${item.name}`, count);
    }
    return `${player.name || '冒险者'}把${this.shopTradeService.formatMerchantItems(installed)}放到了${map.name}里`;
  }

  /**
   * 拆卸当前家园地图上的全部建筑。
   * 对应原版 _主程序.ecode L2054-2060。
   */

  async handleUninstallAll(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${player.name || '冒险者'}不在服务区`;
    const allowed = map.name === player.houseName
      || map.name === `${player.houseName}屋内`
      || map.name === `${player.houseName}前线`;
    if (!allowed) {
      return `${player.name || '冒险者'}只能拆卸自己家里的东西`;
    }

    const buildings: any[] = asJsonValue<any[]>(map.buildings, []);
    const backpack = this.playerService.getBackpackItems(player);
    const packed = buildings.map((item: any) => ({ ...item }));
    for (const item of packed) this.support.addItemToCollection(backpack, item);
    player.backpack = backpack; // Json 列直接写数组
    await this.mapService.updateDynamicFields(map.id, { buildings: [] });
    await this.playerService.savePlayer(player);
    for (const item of packed) {
      const count = Math.max(1, Math.floor(this.support.itemQuantity(item)));
      const name = item?.name ?? item?.名称 ?? '';
      await this.support.advanceTask(userId, '拆卸', count);
      if (name) await this.support.advanceTask(userId, `拆卸${name}`, count);
    }
    return `${player.name || '冒险者'}把${map.name}的${this.shopTradeService.formatMerchantItems(packed)}拆卸装箱了`;
  }

  /**
   * 背包操作说明
   * 对应原版：背包操作 命令
   */

  async handleViewCrops(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    const resources2 = asJsonValue<any[]>(map.resources2, []);
    // 原版只列出有"产出2"的作物（取数组成员数(产出2) != 0）
    const crops = resources2.filter((r: any) => {
      const prod2 = this.panel.parseResourceOutputs(r.outputs2 ?? r.产出2 ?? r.production2 ?? r.output2);
      return prod2.length > 0;
    });

    const lines: string[] = [`🌾 【${map.name}】的作物:`, `━━━━━━━━━━━━━━━`];
    const options: { label: string; cmd: string }[] = [];

    if (crops.length === 0) {
      lines.push('  (当前地图没有可产出的作物)');
    } else {
      crops.forEach((r: any) => {
        const name = r.name || '未知作物';
        const count = r.数量 ?? r.quantity ?? r.次数 ?? r.count ?? r.times ?? r.amount ?? '';
        lines.push(`  ${name}${count !== '' ? ` ×${count}` : ''}`);
        options.push({ label: name, cmd: `查看 ${name}` });
      });
    }

    if (options.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      const menu = await this.support.buildNumberedMenu(userId, options, '💡 发送编号数字即可查看详情');
      lines.push(...menu);
    }
    return lines.join('\n');
  }

  /**
   * 处理查看建筑命令（对应原版 _主程序.ecode L5478）
   * 列出当前地图的建筑，并提示安装/拆卸建筑的相关指令。
   */

  async handleViewBuildings(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    const buildings = asJsonValue<any[]>(map.buildings, []);
    const lines: string[] = [`🏠 【${map.name}】的建筑:`, `━━━━━━━━━━━━━━━`];

    if (buildings.length === 0) {
      lines.push('  (当前地图没有建筑)');
    } else {
      buildings.forEach((b: any) => {
        lines.push(`  ${b.name || '未知建筑'}`);
      });
    }

    // 对应原版：提示安装/拆卸建筑相关指令
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`💡 使用「安装 燃料」安装建筑或放入燃料`);
    lines.push(`💡 使用「拆卸」或「拆卸全部」收起建筑`);
    lines.push(`💡 使用「安装全部」安装全部不占用建筑位置的建筑`);
    return lines.join('\n');
  }

  /**
   * 处理查看家园命令（对应原版 _主程序.ecode L5480）
   * 列出当前地图可前往的"开拓地"（玩家家园），并生成"前往<名称>"快捷。
   */

  async handleViewHomes(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    const connections = asJsonValue<any[]>(map.connections, []);
    // 原版只列出"开拓地"类型（isFrontier / 开拓地 标记）
    const frontiers = connections.filter((c: any) => c.isFrontier === true || c.开拓地 === true || c.type === '开拓地');

    const lines: string[] = [`🏡 附近的玩家家园:`, `━━━━━━━━━━━━━━━`];
    const options: { label: string; cmd: string }[] = [];

    if (frontiers.length === 0) {
      lines.push('  附近没有玩家的家园');
    } else {
      frontiers.forEach((c: any) => {
        const name = c.name || '未知家园';
        lines.push(`  ${name}`);
        options.push({ label: name, cmd: `前往 ${name}` });
      });
    }

    if (options.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      const menu = await this.support.buildNumberedMenu(userId, options, '💡 发送编号数字即可前往该家园');
      lines.push(...menu);
    }
    return lines.join('\n');
  }

  /**
   * 处理查看成就命令（对应原版 _主程序.ecode L5551）
   * 复用 achievementService.getAchievementsDisplay 输出成就列表。
   */

  async handleViewFamiliar(userId: number): Promise<string> {
    const base = await this.familiarSystemService.viewFamiliarData(userId, false);
    // 原版 L5548：查看使魔 末尾仅追加「1、更多」，再进入 更多 子菜单（使魔数据/查看技能/查看使魔详细/被动效果）。
    // 全局「更多」已被全局帮助占用，故此处映射到专用令牌「使魔更多」。
    const menu = await this.support.buildNumberedMenu(
      userId,
      [{ label: '更多', cmd: '使魔更多' }],
      '💡 发送编号数字即可查看对应内容',
    );
    return [base, ...menu].filter(Boolean).join('\n');
  }

  /**
   * 处理使魔数据命令（基础数据展示，无子菜单）
   * 对齐原版 _主程序.ecode L6464 使魔数据 子程序：单独展示使魔基础数据，
   * 作为「更多」子菜单的第 1 项，与「查看使魔」共用同一份基础数据视图（但不带「更多」）。
   */

  async handleFamiliarData(userId: number): Promise<string> {
    return this.familiarSystemService.viewFamiliarData(userId, false);
  }

  /**
   * 处理「查看使魔 → 更多」子菜单
   * 对齐原版 _主程序.ecode L4107-4113：
   *   1、使魔数据  2、查看技能  3、查看使魔详细  4、被动效果
   */

  async handleFamiliarMore(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const menu = await this.support.buildNumberedMenu(
      userId,
      [
        { label: '使魔数据', cmd: '使魔数据' },
        { label: '查看技能', cmd: '查看技能' },
        { label: '查看使魔详细', cmd: '查看使魔详细' },
        { label: '被动效果', cmd: '被动效果' },
      ],
      '💡 发送编号数字即可查看对应内容',
    );
    return [`${player.name || '冒险者'}`, ...menu].filter(Boolean).join('\n');
  }

  /**
   * 处理查看技能命令（对应原版 _主程序.ecode L5549）
   * 生成技能导航编号菜单：通用技能/使魔技能/查看成就/查看标记/查看标记2。
   */

  async handleSignalGun(userId: number, countArg = ''): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = player.name || '冒险者';
    const count = Math.trunc(Number(String(countArg).trim() || 0)) || 0;
    if (count <= 0) {
      return `${name}“发射信号枪2”来使用2把信号枪`;
    }

    const backpack = asJsonValue<any[]>(player.backpack, []);
    const hasSignalGun = backpack.some((item: any) => String(item?.name ?? item?.名称 ?? '') === '信号枪' && this.support.itemQuantity(item) > 0);
    if (!hasSignalGun) return `${name}背包中需要有信号枪`;

    const markers2 = Array.isArray(playerData.markers2)
      ? playerData.markers2
      : this.support.parseJsonArray(player.markers2);
    const cooldownText = { value: '' };
    const now = Date.now();
    if (this.combatState.timeIntervalRequire('信号枪', 10, markers2, now, cooldownText, now)) {
      player.markers2 = markers2; // Json 列直接写数组
      await this.playerService.savePlayer(player);
      return `${name}${cooldownText.value}`;
    }

    // 成就"召唤货舱"+1（原版 L6293）+ 活跃度+1（L6294）
    await this.taskService.advance(userId, '召唤货舱');
    const freshPlayer = (await this.playerService.getPlayerData(userId)).player;
    const markers = asJsonValue<Record<string, any>>(freshPlayer.markers, {});
    this.support.incrementMarker(markers, '活跃度', 1);
    freshPlayer.markers = markers;
    await this.playerService.savePlayer(freshPlayer);

    // 6 秒延时结算「召h货1藏」（原版 L6295）
    if (!this.delayedTaskService) return `${name}发射了信号枪……（延时服务不可用，货舱未排程）`;
    await this.delayedTaskService.schedule({
      type: 'cargo',
      userId,
      runAt: Date.now() + 6 * 1000,
      payload: { count },
    });
    return `${name}发射了信号枪……`;
  }

  /**
   * 召唤货舱延时结算（原版 _主程序.ecode L6298-6333「召h货1藏」）。
   * 从背包扣除至多 count 把信号枪（c=实际扣除数）；c==0 →“你没有信号枪了”；
   * 否则当前地图货舱资源 次数 += 3×c（无货舱则按静态资源模板新增）。
   * 支柱二：dts tick 直调无外层锁，入口自串行（指令路径重入放行）。
   */

  async completeCargoSummon(userId: number, count: number): Promise<void> {
    await this.playerService.enqueueUserWrite(userId, () =>
      this.applyCargoSummon(userId, count));
  }


  async applyCargoSummon(userId: number, count: number): Promise<void> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = player.name || '冒险者';

    // 扣除至多 count 把信号枪（原版 L6301-6312 逐个删除成员）
    const backpack = asJsonValue<any[]>(player.backpack, []);
    const owned = backpack
      .filter((item: any) => String(item?.name ?? item?.名称 ?? '') === '信号枪')
      .reduce((sum, item: any) => sum + this.support.itemQuantity(item), 0);
    const removed = Math.min(owned, count);
    if (removed > 0) this.support.deductBackpackItem(backpack, '信号枪', removed);
    player.backpack = backpack; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    if (removed === 0) {
      this.logger.log(`玩家 ${userId} 货舱延时结算：没有信号枪了`);
      return;
    }

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return;
    // 货舱落入地图资源（原版写 资源2；新版数据已合并进 resources 字段）
    await this.mapService.mutateMapFields(map.id, ['resources'], (f) => {
      const resources = f.resources as any[];
      if (!Array.isArray(resources)) return false;
      const existing = resources.find((r: any) => String(r?.name ?? r?.名称 ?? '') === '货舱');
      if (existing) {
        const times = Number(existing.times ?? existing.次数 ?? 0) + 3 * removed;
        existing.times = times;
        if (existing.次数 !== undefined) existing.次数 = times;
        return true;
      }
      const template = this.staticData.getAllResources().find((r: any) => String(r?.name ?? '') === '货舱');
      const cargo = template
        ? JSON.parse(JSON.stringify(template))
        : { name: '货舱', type: '资源', times: 0, outputs: [] };
      cargo.times = 3 * removed;
      if (cargo.次数 !== undefined) cargo.次数 = 3 * removed;
      resources.push(cargo);
      return true;
    });
    this.logger.log(`玩家 ${userId} 货舱延时结算：投下 ${3 * removed} 个货舱（${name}）`);
  }

  // ========== 家园命令 ==========

  /**
   * 处理使魔家园命令
   * 进入家园系统，委托到 FamiliarSystemService 的家园子系统
   * 对应原版：家园 命令
   */

  async updateMapBuildings(mapId: number, buildingsJson: string, resources2Json?: string): Promise<void> {
    const fields: Record<string, string> = { buildings: buildingsJson };
    if (resources2Json !== undefined) fields.resources2 = resources2Json;
    await this.mapService.updateDynamicFields(mapId, fields);
  }

  /**
   * 扶起倒地的玩家
   * 对应原版：扶 命令
   */
}
