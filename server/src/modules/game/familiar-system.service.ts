/**
 * 使魔/宠物子系统
 * 对应原版：使魔技能.ecode + 使魔家园.ecode + _主程序.ecode 中宠物相关命令
 * 完整实现：使魔选择/召唤/命名/技能/家园 + 宠物改名/转让/驾驶/喂食/嗅探/捕捉
 */

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { BonusService, BonusData } from './bonus.service';

/**
 * 召唤物/宠物实例（与现有 FamiliarService 中的 SummonUnit 一致）
 */
export interface SummonUnit {
  specialSeq: number;
  name: string;
  affinity?: number;
  level?: number;
  id?: string;
  /** 归属者QQ */
  ownerQQ?: string;
  /** 当前地图上的召唤物标识 */
  qq?: string;
  /** 类型 */
  type?: string;
  /** 当前生命值 */
  hp?: number;
  /** 战斗力 */
  combatPower?: number;
}

/**
 * 商店物品定义
 */
export interface ShopItem {
  name: string;
  cost: number;
  costType: 'diamond' | 'activity' | 'dataCore';
  description?: string;
}

/**
 * 家园状态
 */
export interface HomeStatus {
  progress: number;       // 0=未开始 1=清空地面 2=开挖地基 3=建造房子 4=完成
  name: string;
  mapId: number;
  music?: string;
}

/**
 * 生产者（资源1类型），用于产出计算
 * 对应原版 ecode 资源1 数据类型
 */
export interface Producer {
  name: string;
  /** 产出物品列表 */
  outputs: OutputItem[];
  /** 优先级：1=作物 2=建筑 3=特殊 */
  priority: number;
  /** 数量（建筑/作物数量） */
  count: number;
  /** 是否不占建筑数量上限 */
  noOccupancy?: boolean;
}

/**
 * 产出物品
 */
export interface OutputItem {
  name: string;
  count: number;
}

@Injectable()
export class FamiliarSystemService {
  private readonly logger = new Logger(FamiliarSystemService.name);

  /** 使魔商店物品列表 */
  private readonly familiarShopItems: ShopItem[] = [
    { name: '召唤券', cost: 100, costType: 'diamond', description: '召唤券' },
    { name: '优秀武器补给箱', cost: 300, costType: 'diamond', description: '优秀武器补给箱' },
    { name: '糖心巧克力', cost: 50, costType: 'diamond', description: '提高宠物好感' },
    { name: '觉醒丹', cost: 200, costType: 'diamond', description: '宠物觉醒' },
    { name: '饲料', cost: 10, costType: 'diamond', description: '捕捉宠物用' },
    { name: '生肉', cost: 5, costType: 'diamond', description: '宠物嗅探消耗' },
  ];

  /** 活跃度商店物品列表 */
  private readonly activityShopItems: ShopItem[] = [
    { name: '优秀武器补给箱', cost: 50, costType: 'activity', description: '优秀武器补给箱' },
    { name: '召唤券', cost: 100, costType: 'activity', description: '召唤券' },
    { name: '糖心巧克力', cost: 30, costType: 'activity', description: '提高宠物好感' },
  ];

  /** 数据商店物品列表 */
  private readonly dataShopItems: ShopItem[] = [
    { name: '召唤券', cost: 10, costType: 'dataCore', description: '召唤券' },
    { name: '觉醒丹', cost: 50, costType: 'dataCore', description: '宠物觉醒' },
  ];

  /** 狩猎宠物类型列表 */
  private readonly huntingPetTypes = ['常春藤', '狼', '虎', '巨齿鲨'];

  /** 禁止改名的名字 */
  private readonly forbiddenNames = ['白', '行商', '花园宝宝', '小白狐'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly bonusService: BonusService,
  ) {}

  // ==================== 使魔基础操作 ====================

  /**
   * 选择/更换使魔
   * 对应原版：选择使魔/更换使魔()
   * 更换玩家的使魔类型，需要已拥有该使魔（好感度 > 0）
   * @param userId 用户ID
   * @param familiarName 使魔名称
   * @returns 操作结果文本
   */
  async selectFamiliar(userId: number, familiarName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 查找使魔定义
    const familiar = await this.prisma.gameFamiliar.findUnique({
      where: { name: familiarName },
    });
    if (!familiar) {
      return `不存在的使魔：${familiarName}`;
    }

    // 检查是否已拥有该使魔（好感度>0）
    const affinityKey = `${familiarName}好感`;
    const currentAffinity = this.playerService.getMarkerValue(markers, affinityKey);
    if (currentAffinity <= 0) {
      return `${player.name || '冒险者'} 你尚未获得该使魔「${familiarName}」\n请使用「召唤使魔」来获取新使魔`;
    }

    // 检查是否炮击模式
    if (player.attackMode === 1) {
      return `${player.name || '冒险者'} 炮击模式下不可以更换使魔`;
    }

    // 计算更换冷却时间（根据称号）
    const titles = this.playerService.safeJsonParse<any[]>(player.titles, []);
    const multiHandIV = titles.find((t: any) => t.name === '多面手IV');
    let cooldown = 900; // 默认15分钟
    if (multiHandIV) {
      cooldown = 300; // 多面手IV: 5分钟
    } else {
      const multiHandIII = titles.find((t: any) => t.name === '多面手III');
      const multiHandII = titles.find((t: any) => t.name === '多面手II');
      const multiHandI = titles.find((t: any) => t.name === '多面手I');
      if (multiHandIII) cooldown = 450;
      else if (multiHandII) cooldown = 600;
      else if (multiHandI) cooldown = 750;
    }

    // 检查是否为同一使魔
    if (player.type === familiarName) {
      return `${player.name || '冒险者'} 你上次换成${familiarName}还是上次`;
    }

    // 检查冷却
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const cooldownMarker = markers2.find((m: any) => m.name === '更换使魔');
    const now = Date.now() / 1000;
    if (cooldownMarker && cooldownMarker.expireAt > now) {
      const remaining = Math.ceil(cooldownMarker.expireAt - now);
      return `${player.name || '冒险者'} 更换使魔冷却中，剩余${remaining}秒`;
    }

    // 如果是兰音，确保好感度至少20
    if (familiar.specialSeq === -1) {
      // 兰音特殊序号通常为-1或其他值，需要特殊处理
      if (currentAffinity < 20) {
        // 自动补足到20
        markers[affinityKey] = 20;
      }
    }

    // 执行更换
    player.type = familiarName;
    player.specialSeq = familiar.specialSeq;
    player.uniqueSkill = familiar.uniqueSkill || '';

    // 设置冷却标记
    const newMarkers2 = markers2.filter((m: any) => m.name !== '更换使魔');
    newMarkers2.push({
      name: '更换使魔',
      expireAt: now + cooldown,
    });
    player.markers2 = JSON.stringify(newMarkers2);

    // 记录更换使魔成就
    const tasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
    const taskExist = tasks.find((t: any) => t.name === '更换使魔');
    if (taskExist) {
      taskExist.count = (taskExist.count || 0) + 1;
    } else {
      tasks.push({ name: '更换使魔', count: 1 });
    }
    player.tasks = JSON.stringify(tasks);

    // 增加活跃度
    const activity = this.playerService.getMarkerValue(markers, '活跃度');
    markers['活跃度'] = activity + 1;
    player.markers = JSON.stringify(markers);

    await this.playerService.savePlayer(player);

    return `${player.name || '冒险者'} 从${player.type}更换为${familiarName}（冷却${Math.ceil(cooldown / 60)}分钟）`;
  }

  /**
   * 召唤使魔
   * 对应原版：召唤使魔()
   * 消耗召唤券随机获取新使魔
   * @param userId 用户ID
   * @param count 召唤次数
   * @returns 召唤结果文本
   */
  async summonFamiliar(userId: number, count: number = 1): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (count < 1) {
      count = 1;
    }

    // 检查召唤券数量
    const backpack = this.playerService.getBackpackItems(player);
    const ticketItem = backpack.find((item: any) => item.name === '召唤券');
    const ticketCount = ticketItem ? (ticketItem.count || 1) : 0;

    if (ticketCount < count) {
      return `${player.name || '冒险者'} 你的召唤券只有${ticketCount}，无法召唤${count}次\n你可以在商店兑换召唤券`;
    }

    // 获取所有可召唤的使魔
    const allFamiliars = await this.prisma.gameFamiliar.findMany({
      where: { noSummon: false },
    });

    if (allFamiliars.length === 0) {
      return '没有可召唤的使魔';
    }

    // 执行召唤
    const summonedItems: string[] = [];

    for (let i = 0; i < count; i++) {
      // 随机选择一个使魔
      const randomIndex = Math.floor(Math.random() * allFamiliars.length);
      const chosenFamiliar = allFamiliars[randomIndex];

      // 增加该使魔的好感度
      const affinityKey = `${chosenFamiliar.name}好感`;
      const currentAffinity = this.playerService.getMarkerValue(markers, affinityKey);
      markers[affinityKey] = currentAffinity + 1;

      summonedItems.push(chosenFamiliar.name);
    }

    // 扣除召唤券
    const newTicketCount = ticketCount - count;
    if (newTicketCount <= 0) {
      // 移除召唤券
      const idx = backpack.findIndex((item: any) => item.name === '召唤券');
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      ticketItem!.count = newTicketCount;
    }

    player.markers = JSON.stringify(markers);
    player.backpack = JSON.stringify(backpack);

    // 记录召唤使魔成就
    const tasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
    const summonTask = tasks.find((t: any) => t.name === '召唤使魔');
    if (summonTask) {
      summonTask.count = (summonTask.count || 0) + 1;
    } else {
      tasks.push({ name: '召唤使魔', count: 1 });
    }
    player.tasks = JSON.stringify(tasks);

    // 检查召唤冷却
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const cooldownMarker = markers2.find((m: any) => m.name === '召唤冷却');
    const now = Date.now() / 1000;
    if (!cooldownMarker || cooldownMarker.expireAt <= now) {
      // 活跃度+1
      const activity = this.playerService.getMarkerValue(markers, '活跃度');
      markers['活跃度'] = activity + 1;
      player.markers = JSON.stringify(markers);

      // 设置冷却
      const newMarkers2 = markers2.filter((m: any) => m.name !== '召唤冷却');
      newMarkers2.push({
        name: '召唤冷却',
        expireAt: now + 10,
      });
      player.markers2 = JSON.stringify(newMarkers2);
    }

    await this.playerService.savePlayer(player);

    return `${player.name || '冒险者'} 使用了${count}张召唤券，召唤出了${summonedItems.join('、')}\n重复召唤出的使魔会转化为对应使魔的好感`;
  }

  /**
   * 命名使魔
   * 对应原版：命名使魔()
   * 修改玩家的使魔显示名称
   * @param userId 用户ID
   * @param name 新名称
   * @returns 操作结果文本
   */
  async nameFamiliar(userId: number, name: string): Promise<string> {
    if (!name) {
      return '请指定新名称，例如：命名使魔新名称';
    }

    // 名称长度检查（最多16字符，中文占2字符）
    const byteLength = name.replace(/[^\x00-\xff]/g, 'xx').length;
    if (byteLength > 16) {
      return '名称太长，最多16字符，中文占2字符';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 修改名称
    player.name = name;

    await this.playerService.savePlayer(player);

    return `${player.name || '冒险者'} 把名字修改为${name}`;
  }

  /**
   * 查看使魔数据
   * 对应原版：使魔数据()
   * 查看玩家当前使魔的详细数据
   * @param userId 用户ID
   * @returns 使魔数据文本
   */
  async viewFamiliarData(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.type) {
      return '你还没有选择使魔，请先发送「选择使魔」来选择';
    }

    // 获取使魔定义
    const familiar = await this.prisma.gameFamiliar.findUnique({
      where: { name: player.type },
    });

    if (!familiar) {
      return `未知的使魔类型: ${player.type}`;
    }

    // 获取好感度
    const affinityKey = `${player.type}好感`;
    const affinity = this.playerService.getMarkerValue(markers, affinityKey);

    // 获取技能等级
    const skillKey = `${player.type}技能熟练度`;
    const skillExp = this.playerService.getMarkerValue(markers, skillKey);
    const skillLevel = Math.floor(skillExp / 100) + 1;

    // 获取好感度描述
    let affinityDesc = '陌生';
    const affinityLevels = [0, 25, 50, 75, 100];
    const affinityTexts = ['陌生', '熟悉', '友好', '亲密', '挚爱'];
    for (let i = affinityLevels.length - 1; i >= 0; i--) {
      if (affinity >= affinityLevels[i]) {
        affinityDesc = affinityTexts[i];
        break;
      }
    }

    const lines = [
      `【${familiar.name}】Lv.${player.level}`,
      `━━━━━━━━━━━━━━━`,
      `类型: ${player.type}`,
      `特有技能: ${familiar.uniqueSkill || '无'}`,
      `技能等级: ${skillLevel}（经验: ${Math.round(skillExp)}）`,
      `好感度: ${Math.round(affinity)}（${affinityDesc}）`,
      `━━━━━━━━━━━━━━━`,
      `${familiar.description || ''}`,
    ];

    return lines.filter(Boolean).join('\n');
  }

  /**
   * 查看使魔详细
   * 对应原版：查看使魔详细()
   * 查看指定使魔的详细信息
   * @param userId 用户ID
   * @param familiarName 使魔名称
   * @returns 使魔详细信息文本
   */
  async viewFamiliarDetail(userId: number, familiarName: string): Promise<string> {
    if (!familiarName) {
      return '请指定使魔名称';
    }

    const familiar = await this.prisma.gameFamiliar.findUnique({
      where: { name: familiarName },
    });

    if (!familiar) {
      return `不存在的使魔：${familiarName}`;
    }

    // 获取玩家对该使魔的好感度
    const playerData = await this.playerService.getPlayerData(userId);
    const { markers } = playerData;
    const affinityKey = `${familiarName}好感`;
    const affinity = this.playerService.getMarkerValue(markers, affinityKey);

    // 获取技能等级
    const skillKey = `${familiarName}技能熟练度`;
    const skillExp = this.playerService.getMarkerValue(markers, skillKey);
    const skillLevel = Math.floor(skillExp / 100) + 1;

    const lines = [
      `【${familiar.name}】`,
      `━━━━━━━━━━━━━━━`,
      `${familiar.description2 || familiar.description || ''}`,
      `━━━━━━━━━━━━━━━`,
      `特有技能: ${familiar.uniqueSkill || '无'}`,
      `技能说明: ${familiar.skillDesc || '无'}`,
      `━━━━━━━━━━━━━━━`,
      `你的好感度: ${Math.round(affinity)}`,
      `技能等级: ${skillLevel}`,
      familiar.noSummon ? '⚠️ 不可召唤' : '✅ 可召唤',
    ];

    return lines.filter(Boolean).join('\n');
  }

  // ==================== 使魔商店 ====================

  /**
   * 使魔商店
   * 对应原版：使魔商店()
   * 显示商店列表，支持子商店：活跃度商店、钻石商店、数据商店
   * @param userId 用户ID
   * @param shopType 子商店类型（activity/diamond/dataCore）
   * @returns 商店内容文本
   */
  async familiarShop(userId: number, shopType?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 获取钻石数量
    const backpack = this.playerService.getBackpackItems(player);
    const diamondItem = backpack.find((item: any) => item.name === '钻石');
    const diamondCount = diamondItem ? (diamondItem.count || 0) : 0;

    // 获取数据核心数量
    const dataCoreItem = backpack.find((item: any) => item.name === '数据核心');
    const dataCoreCount = dataCoreItem ? (dataCoreItem.count || 0) : 0;

    // 获取活跃度
    const activity = this.playerService.getMarkerValue(markers, '活跃度');

    let result = '';

    if (!shopType || shopType === 'diamond') {
      result += `💎 钻石商店（你有${Math.round(diamondCount)}钻石）\n`;
      this.diamondShopItems.forEach((item, index) => {
        result += `${index + 1}、${item.name}（${item.cost}钻石）\n`;
      });
      result += `━━━━━━━━━━━━━━━\n`;
    }

    if (!shopType || shopType === 'activity') {
      result += `⭐ 活跃度商店（你有${Math.round(activity)}活跃度）\n`;
      this.activityShopItems.forEach((item, index) => {
        result += `${index + 1}、${item.name}（${item.cost}活跃度）\n`;
      });
      result += `━━━━━━━━━━━━━━━\n`;
    }

    if (!shopType || shopType === 'dataCore') {
      result += `💠 数据商店（你有${Math.round(dataCoreCount)}数据核心）\n`;
      this.dataShopItems.forEach((item, index) => {
        result += `${index + 1}、${item.name}（${item.cost}数据核心）\n`;
      });
    }

    return result || '请选择商店类型：活跃度商店、钻石商店、数据商店';
  }

  /** 钻石商店物品 */
  private readonly diamondShopItems: ShopItem[] = [
    { name: '召唤券', cost: 100, costType: 'diamond' },
    { name: '优秀武器补给箱', cost: 300, costType: 'diamond' },
    { name: '糖心巧克力', cost: 50, costType: 'diamond' },
    { name: '觉醒丹', cost: 200, costType: 'diamond' },
    { name: '饲料', cost: 10, costType: 'diamond' },
    { name: '生肉', cost: 5, costType: 'diamond' },
  ];

  /**
   * 兑换
   * 对应原版：兑换()
   * 从商店兑换物品
   * @param userId 用户ID
   * @param itemName 物品名称
   * @param count 兑换数量
   * @returns 兑换结果文本
   */
  async exchange(userId: number, itemName: string, count: number = 1): Promise<string> {
    if (!itemName) {
      return '请指定要兑换的物品名称';
    }

    if (count < 1) {
      count = 1;
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 查找物品在哪个商店
    const allShops = [
      ...this.diamondShopItems.map(item => ({ ...item, source: 'diamond' as const })),
      ...this.activityShopItems.map(item => ({ ...item, source: 'activity' as const })),
      ...this.dataShopItems.map(item => ({ ...item, source: 'dataCore' as const })),
    ];

    const shopItem = allShops.find(item => item.name === itemName);
    if (!shopItem) {
      return `商店中没有「${itemName}」`;
    }

    // 检查并扣除货币
    if (shopItem.source === 'diamond') {
      const backpack = this.playerService.getBackpackItems(player);
      const diamondItem = backpack.find((item: any) => item.name === '钻石');
      const diamondCount = diamondItem ? (diamondItem.count || 0) : 0;
      const totalCost = shopItem.cost * count;

      if (diamondCount < totalCost) {
        return `需要${totalCost}钻石，你只有${Math.round(diamondCount)}`;
      }

      // 扣除钻石
      if (diamondCount === totalCost) {
        const idx = backpack.findIndex((item: any) => item.name === '钻石');
        if (idx !== -1) backpack.splice(idx, 1);
      } else {
        diamondItem!.count = diamondCount - totalCost;
      }
      player.backpack = JSON.stringify(backpack);
    } else if (shopItem.source === 'activity') {
      const activity = this.playerService.getMarkerValue(markers, '活跃度');
      const totalCost = shopItem.cost * count;

      if (activity < totalCost) {
        return `需要${totalCost}活跃度，你只有${Math.round(activity)}`;
      }

      markers['活跃度'] = activity - totalCost;
      player.markers = JSON.stringify(markers);
    } else if (shopItem.source === 'dataCore') {
      const backpack = this.playerService.getBackpackItems(player);
      const dataCoreItem = backpack.find((item: any) => item.name === '数据核心');
      const dataCoreCount = dataCoreItem ? (dataCoreItem.count || 0) : 0;
      const totalCost = shopItem.cost * count;

      if (dataCoreCount < totalCost) {
        return `需要${totalCost}数据核心，你只有${Math.round(dataCoreCount)}`;
      }

      // 扣除数据核心
      if (dataCoreCount === totalCost) {
        const idx = backpack.findIndex((item: any) => item.name === '数据核心');
        if (idx !== -1) backpack.splice(idx, 1);
      } else {
        dataCoreItem!.count = dataCoreCount - totalCost;
      }
      player.backpack = JSON.stringify(backpack);
    }

    // 发放物品
    await this.playerService.addToBackpack(userId, itemName, count);

    // 记录兑换成就
    const tasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
    const exchangeTask = tasks.find((t: any) => t.name === '兑换');
    if (exchangeTask) {
      exchangeTask.count = (exchangeTask.count || 0) + count;
    } else {
      tasks.push({ name: '兑换', count });
    }
    player.tasks = JSON.stringify(tasks);

    await this.playerService.savePlayer(player);

    const currencyName = shopItem.source === 'diamond' ? '钻石'
      : shopItem.source === 'activity' ? '活跃度' : '数据核心';

    return `${player.name || '冒险者'} 用${shopItem.cost * count}${currencyName}兑换了${itemName}x${count}`;
  }

  // ==================== 家园系统 ====================

  /**
   * 家园操作
   * 对应原版：家园/家园音乐/家园搬迁/家园命名()
   * 完全实现家园系统
   * @param userId 用户ID
   * @param subCommand 子命令
   * @param args 额外参数
   * @returns 操作结果文本
   */
  async handleHome(userId: number, subCommand: string, ...args: string[]): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!subCommand) {
      return this.getHomeStatus(player, markers);
    }

    switch (subCommand) {
      case 'music':
        return this.handleHomeMusic(userId, args[0]);
      case '搬迁':
        return this.handleHomeRelocate(userId, args[0]);
      case '命名':
        return this.handleHomeRename(userId, args[0]);
      case '产出':
        return this.handleHomeOutput(userId);
      case '前线':
        return this.handleHomeFrontline(userId);
      case '圈地':
        return this.handleHomeClaim(userId, player, markers);
      case '开挖地基':
        return this.handleHomeDig(userId, player, markers);
      case '建造地基':
        return this.handleHomeFoundation(userId, player, markers);
      case '建造房子':
        return this.handleHomeConstruct(userId, player, markers);
      case '查看':
        return this.getHomeStatus(player, markers);
      default:
        return `未知的家园操作：${subCommand}\n可用操作：music、搬迁、命名、产出、前线、圈地、开挖地基、建造地基、建造房子、查看`;
    }
  }

  /**
   * 获取家园状态
   * 显示家园进度、建筑数量、产出预览等信息
   */
  private async getHomeStatus(player: any, markers: any): Promise<string> {
    const progress = this.playerService.getMarkerValue(markers, '家园进度');

    // 获取家园所在地图
    let mapName = player.houseName || '未设置';
    let mapBuildings: any[] = [];
    if (player.mapId) {
      try {
        const map = await this.prisma.gameMap.findUnique({
          where: { id: player.mapId },
          select: { name: true, buildings: true },
        });
        if (map) {
          mapName = map.name;
          mapBuildings = this.playerService.safeJsonParse<any[]>(map.buildings, []);
        }
      } catch {
        // 忽略
      }
    }

    const lines = [
      `🏠 家园 - ${mapName}`,
      `━━━━━━━━━━━━━━━`,
    ];

    if (progress === 0) {
      lines.push('去到你中意的地点，然后「圈地」来开始建造你的家园');
      lines.push('地点不需要太纠结，能搬家');
      lines.push('当前进度: 未开始');
    } else if (progress === 1) {
      lines.push('当前进度: 清空地面');
      lines.push('清理掉土堆和杂草后「开挖地基」');
    } else if (progress === 2) {
      lines.push('当前进度: 开挖地基');
      lines.push('清理掉土堆后「建造地基」');
      lines.push('建造地基需要消耗80木头、120石头、40铁矿和40绳子');
    } else if (progress === 3) {
      lines.push('当前进度: 建造房子');
      lines.push('「建造房子」来建造，需要消耗300木头、500石头、160铁矿和120绳子');
    } else if (progress >= 4) {
      lines.push('家园已建成！');
      lines.push('你可以在家园里面休息、种地、安装生产设备、放置愿意跟随你的怪物和NPC');

      // 显示已在家园中的建筑
      if (mapBuildings.length > 0) {
        lines.push('━━━━━━━━━━━━━━━');
        lines.push(`📦 建筑 (${mapBuildings.length}种):`);
        for (const b of mapBuildings) {
          lines.push(`  ${b.name} x${b.count || 1}`);
        }
      }
    }

    // 家园名称
    if (player.houseName && player.houseName !== mapName) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`家园名称: ${player.houseName}`);
    }

    // 背景音乐
    if (player.houseMusic) {
      lines.push(`🎵 背景音乐: ${player.houseMusic}`);
    }

    return lines.join('\n');
  }

  /**
   * 家园音乐
   */
  private async handleHomeMusic(userId: number, musicName?: string): Promise<string> {
    if (!musicName) {
      return '请指定音乐名称，例如：家园音乐月光';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 更新家园音乐
    player.houseMusic = musicName;
    await this.playerService.savePlayer(player);

    return `已将家园背景音乐更换为：${musicName}`;
  }

  /**
   * 家园搬迁
   */
  private async handleHomeRelocate(userId: number, targetMap?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    const progress = this.playerService.getMarkerValue(markers, '家园进度');
    if (progress === 0) {
      return '去到你中意的地点，然后「圈地」来开始建造你的家园';
    }

    if (!targetMap) {
      return '请指定搬迁目标地图，例如：家园搬迁森林出口';
    }

    // 检查目标地图是否存在
    const map = await this.prisma.gameMap.findUnique({
      where: { name: targetMap },
    });

    if (!map) {
      return `地图「${targetMap}」不存在`;
    }

    // 检查是否可搬迁
    if (map.noMove) {
      return `「${targetMap}」不可搬迁至此`;
    }

    // 执行搬迁
    player.houseName = targetMap;
    player.mapId = map.id;
    player.location = map.name;

    // 记录家园搬迁成就
    const tasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
    const relocateTask = tasks.find((t: any) => t.name === '家园搬迁');
    if (relocateTask) {
      relocateTask.count = (relocateTask.count || 0) + 1;
    } else {
      tasks.push({ name: '家园搬迁', count: 1 });
    }
    player.tasks = JSON.stringify(tasks);

    await this.playerService.savePlayer(player);

    return `家园已搬迁至「${targetMap}」`;
  }

  /**
   * 家园命名
   */
  private async handleHomeRename(userId: number, newName?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    const progress = this.playerService.getMarkerValue(markers, '家园进度');
    if (progress === 0) {
      return '去到你中意的地点，然后「圈地」来开始建造你的家园';
    }

    if (!newName) {
      return `请指定新名称，例如：家园命名陨落之地`;
    }

    // 检查名称是否已被其他玩家使用
    const existingPlayers = await this.prisma.player.findMany({
      where: { houseName: newName },
    });
    if (existingPlayers.length > 0 && existingPlayers.some(p => p.userId !== userId)) {
      return `与其他家园同名：${newName}`;
    }

    player.houseName = newName;

    // 记录家园命名成就
    const tasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
    const nameTask = tasks.find((t: any) => t.name === '家园命名');
    if (nameTask) {
      nameTask.count = (nameTask.count || 0) + 1;
    } else {
      tasks.push({ name: '家园命名', count: 1 });
    }
    player.tasks = JSON.stringify(tasks);

    await this.playerService.savePlayer(player);

    return `家园已命名为「${newName}」`;
  }

  // ==================== 家园建造流程 ====================

  /**
   * 圈地 - 开始建造家园
   * 对应原版：圈地()
   * 设置家园进度=1，表示开始清空地面
   */
  private async handleHomeClaim(userId: number, player: any, markers: any): Promise<string> {
    const progress = this.playerService.getMarkerValue(markers, '家园进度');

    if (progress > 0) {
      return `你的家园已经开始建造了（当前进度: ${this.getProgressText(progress)}）`;
    }

    // 设置家园进度为1
    markers['家园进度'] = 1;
    player.markers = JSON.stringify(markers);

    await this.playerService.savePlayer(player);

    return `${player.name || '冒险者'} 你圈了一块地，准备开始建造家园\n清理掉土堆和杂草后「开挖地基」`;
  }

  /**
   * 开挖地基 - 进度1→2
   * 需要 80木头+120石头+40铁矿+40绳子
   */
  private async handleHomeDig(userId: number, player: any, markers: any): Promise<string> {
    const progress = this.playerService.getMarkerValue(markers, '家园进度');

    if (progress !== 1) {
      if (progress === 0) return '请先「圈地」来开始建造你的家园';
      if (progress >= 2) return '已经完成了开挖地基，继续「建造地基」吧';
      return `当前进度: ${this.getProgressText(progress)}，无法开挖地基`;
    }

    // 检查所需材料
    const required = [
      { name: '木头', count: 80 },
      { name: '石头', count: 120 },
      { name: '铁矿', count: 40 },
      { name: '绳子', count: 40 },
    ];

    // 检查背包
    const backpack = this.playerService.getBackpackItems(player);

    for (const req of required) {
      const item = backpack.find((i: any) => i.name === req.name);
      const hasCount = item ? (item.count || 1) : 0;
      if (hasCount < req.count) {
        return `材料不足：需要${req.name}x${req.count}，你只有${Math.round(hasCount)}`;
      }
    }

    // 扣除材料
    for (const req of required) {
      const item = backpack.find((i: any) => i.name === req.name);
      const itemCount = item.count || 1;
      if (itemCount === req.count) {
        const idx = backpack.findIndex((i: any) => i.name === req.name);
        if (idx !== -1) backpack.splice(idx, 1);
      } else {
        item.count = itemCount - req.count;
      }
    }

    // 更新进度
    markers['家园进度'] = 2;
    player.markers = JSON.stringify(markers);
    player.backpack = JSON.stringify(backpack);

    // 记录成就
    const tasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
    const digTask = tasks.find((t: any) => t.name === '开挖地基');
    if (digTask) {
      digTask.count = (digTask.count || 0) + 1;
    } else {
      tasks.push({ name: '开挖地基', count: 1 });
    }
    player.tasks = JSON.stringify(tasks);

    await this.playerService.savePlayer(player);

    return `${player.name || '冒险者'} 消耗了80木头、120石头、40铁矿和40绳子\n地基已经挖好，接下来「建造地基」`;
  }

  /**
   * 建造地基 - 进度2→3
   * 需要 80木头+120石头+40铁矿+40绳子
   */
  private async handleHomeFoundation(userId: number, player: any, markers: any): Promise<string> {
    const progress = this.playerService.getMarkerValue(markers, '家园进度');

    if (progress !== 2) {
      if (progress === 0) return '请先「圈地」来开始建造你的家园';
      if (progress < 2) return '请先「开挖地基」';
      if (progress >= 3) return '已经完成了建造地基，继续「建造房子」吧';
      return `当前进度: ${this.getProgressText(progress)}，无法建造地基`;
    }

    // 检查所需材料
    const required = [
      { name: '木头', count: 80 },
      { name: '石头', count: 120 },
      { name: '铁矿', count: 40 },
      { name: '绳子', count: 40 },
    ];

    const backpack = this.playerService.getBackpackItems(player);

    for (const req of required) {
      const item = backpack.find((i: any) => i.name === req.name);
      const hasCount = item ? (item.count || 1) : 0;
      if (hasCount < req.count) {
        return `材料不足：需要${req.name}x${req.count}，你只有${Math.round(hasCount)}`;
      }
    }

    // 扣除材料
    for (const req of required) {
      const item = backpack.find((i: any) => i.name === req.name);
      const itemCount = item.count || 1;
      if (itemCount === req.count) {
        const idx = backpack.findIndex((i: any) => i.name === req.name);
        if (idx !== -1) backpack.splice(idx, 1);
      } else {
        item.count = itemCount - req.count;
      }
    }

    // 更新进度
    markers['家园进度'] = 3;
    player.markers = JSON.stringify(markers);
    player.backpack = JSON.stringify(backpack);

    // 记录成就
    const tasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
    const foundationTask = tasks.find((t: any) => t.name === '建造地基');
    if (foundationTask) {
      foundationTask.count = (foundationTask.count || 0) + 1;
    } else {
      tasks.push({ name: '建造地基', count: 1 });
    }
    player.tasks = JSON.stringify(tasks);

    await this.playerService.savePlayer(player);

    return `${player.name || '冒险者'} 消耗了80木头、120石头、40铁矿和40绳子\n地基已经建造好了，接下来「建造房子」`;
  }

  /**
   * 建造房子 - 进度3→4
   * 需要 300木头+500石头+160铁矿+120绳子
   */
  private async handleHomeConstruct(userId: number, player: any, markers: any): Promise<string> {
    const progress = this.playerService.getMarkerValue(markers, '家园进度');

    if (progress !== 3) {
      if (progress === 0) return '请先「圈地」来开始建造你的家园';
      if (progress < 3) return '请先完成「建造地基」';
      if (progress >= 4) return '你的家园已经建好了！';
      return `当前进度: ${this.getProgressText(progress)}，无法建造房子`;
    }

    // 检查所需材料
    const required = [
      { name: '木头', count: 300 },
      { name: '石头', count: 500 },
      { name: '铁矿', count: 160 },
      { name: '绳子', count: 120 },
    ];

    const backpack = this.playerService.getBackpackItems(player);

    for (const req of required) {
      const item = backpack.find((i: any) => i.name === req.name);
      const hasCount = item ? (item.count || 1) : 0;
      if (hasCount < req.count) {
        return `材料不足：需要${req.name}x${req.count}，你只有${Math.round(hasCount)}`;
      }
    }

    // 扣除材料
    for (const req of required) {
      const item = backpack.find((i: any) => i.name === req.name);
      const itemCount = item.count || 1;
      if (itemCount === req.count) {
        const idx = backpack.findIndex((i: any) => i.name === req.name);
        if (idx !== -1) backpack.splice(idx, 1);
      } else {
        item.count = itemCount - req.count;
      }
    }

    // 更新进度
    markers['家园进度'] = 4;
    player.markers = JSON.stringify(markers);
    player.backpack = JSON.stringify(backpack);

    // 记录成就
    const tasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
    const constructTask = tasks.find((t: any) => t.name === '建造房子');
    if (constructTask) {
      constructTask.count = (constructTask.count || 0) + 1;
    } else {
      tasks.push({ name: '建造房子', count: 1 });
    }
    player.tasks = JSON.stringify(tasks);

    await this.playerService.savePlayer(player);

    return `${player.name || '冒险者'} 消耗了300木头、500石头、160铁矿和120绳子\n🏠 家园建好了！\n你可以开始在家园里面安装生产设备、放置怪物和NPC了`;
  }

  /**
   * 获取进度文本描述
   */
  private getProgressText(progress: number): string {
    const texts: Record<number, string> = {
      0: '未开始',
      1: '清空地面',
      2: '开挖地基',
      3: '建造房子',
      4: '已完成',
    };
    return texts[progress] || '未知';
  }

  // ==================== 家园产出计算 ====================

  /**
   * 家园产出
   * 对应原版：家园产出() / 取地图产出() / 产出资源()
   * 计算家园中所有建筑和作物的产出，并将产出物品添加到玩家背包
   */
  private async handleHomeOutput(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    const progress = this.playerService.getMarkerValue(markers, '家园进度');
    if (progress < 4) {
      return '家园尚未建成，无法产出';
    }

    // 获取家园所在地图
    if (!player.mapId) {
      return '你还没有家园所在地图';
    }

    const map = await this.prisma.gameMap.findUnique({
      where: { id: player.mapId },
    });

    if (!map) {
      return '家园所在的地图不存在';
    }

    // 解析地图上的建筑列表
    const mapBuildings = this.playerService.safeJsonParse<any[]>(map.buildings, []);
    if (mapBuildings.length === 0) {
      return '家园中没有建筑，无法产出';
    }

    // 获取建筑定义
    const buildingNames = mapBuildings.map((b: any) => b.name);
    const buildingDefs = await this.prisma.gameBuilding.findMany({
      where: { name: { in: buildingNames } },
    });

    // 构建建筑定义映射
    const buildingDefMap = new Map<string, any>();
    for (const def of buildingDefs) {
      buildingDefMap.set(def.name, def);
    }

    // 转为生产：将地图上的建筑转换为生产者
    const producers: Producer[] = [];
    for (const b of mapBuildings) {
      const def = buildingDefMap.get(b.name);
      if (!def) continue;

      // 解析建筑定义的产出（materials 字段存储的是产出物品列表）
      const outputs = this.playerService.safeJsonParse<any[]>(def.materials, []);
      if (outputs.length === 0) continue;

      // 构建生产者
      const producer: Producer = {
        name: b.name,
        outputs: outputs.map((o: any) => ({ name: o.name, count: o.count || 0 })),
        priority: 2, // 建筑默认优先级2
        count: b.count || 1,
      };
      producers.push(producer);
    }

    if (producers.length === 0) {
      return '家园中的建筑没有产出配置';
    }

    // 获取玩家背包作为存放地
    const backpack = this.playerService.getBackpackItems(player);

    // 计算时间差：距离上次产出过去了多少秒
    const now = Date.now() / 1000;
    const lastOutput = this.playerService.getMarkerValue(markers, '家园产出时间');
    let timeDiff = 60; // 默认60秒（最少产出间隔）
    if (lastOutput > 0) {
      timeDiff = Math.min(3600, Math.max(60, now - lastOutput)); // 最多1小时，最少1分钟
    }

    // 产出倍率（可配置，默认1.0）
    const buildingOutputRate = 1.0;    // 建筑产出倍率
    const powerConsumeRate = 1.0;      // 电力消耗倍率
    const fuelConsumeRate = 1.0;       // 燃料消耗倍率
    const powerFuelOutputRate = 1.0;   // 燃电产出倍率
    const laborSupplyRate = 1.0;       // 人力供应倍率

    // 执行产出计算（按优先级分组）
    const outputItems: any[] = [];
    const priorities = [...new Set(producers.map(p => p.priority))].sort();

    for (const pri of priorities) {
      // 筛选当前优先级的建筑
      const priorityProducers = producers.filter(p => p.priority === pri);

      // 计算每个生产者的产出
      for (const producer of priorityProducers) {
        // 计算最小产出时间（受消耗品影响）
        const minTime = this.calcMinOutputTime(producer, timeDiff, backpack);

        for (const output of producer.outputs) {
          let quantity = output.count * producer.count * minTime / 60;

          // 应用倍率
          if (output.count > 0) {
            // 正产出
            quantity = quantity * buildingOutputRate;
            if (output.name === '电力' || output.name === '燃料') {
              quantity = quantity * powerFuelOutputRate;
            }
          } else {
            // 负产出（消耗品）
            if (output.name === '电力') {
              quantity = quantity * powerConsumeRate;
            } else if (output.name === '燃料') {
              quantity = quantity * fuelConsumeRate;
            }
          }

          // 跳过电力消耗（电力消耗在整体计算中处理）
          if (output.name === '电力' && output.count < 0) continue;

          // 添加到产出列表
          const existing = outputItems.find((o: any) => o.name === output.name);
          if (existing) {
            existing.count += quantity;
          } else {
            outputItems.push({ name: output.name, count: quantity });
          }
        }
      }
    }

    // 处理电力总体平衡
    const powerOutput = outputItems.find((o: any) => o.name === '电力');
    if (powerOutput && powerOutput.count < 0) {
      // 电力不足，所有产出减半
      for (const item of outputItems) {
        if (item.name !== '电力') {
          item.count = Math.floor(item.count * 0.5);
        }
      }
      powerOutput.count = 0;
    }

    // 将产出添加到玩家背包
    const resultLines: string[] = [];
    resultLines.push(`🏠 家园产出（${timeDiff < 60 ? '1' : Math.round(timeDiff / 60)}分钟）`);
    resultLines.push(`━━━━━━━━━━━━━━━`);

    let hasOutput = false;
    for (const item of outputItems) {
      const count = Math.round(item.count);
      if (count === 0) continue;

      if (count > 0) {
        // 正产出 - 添加到背包
        await this.playerService.addToBackpack(userId, item.name, Math.abs(count));
        resultLines.push(`✅ +${count} ${item.name}`);
        hasOutput = true;
      } else {
        // 消耗品不足时显示
        resultLines.push(`⚠️ 消耗了${Math.abs(count)} ${item.name}`);
      }
    }

    if (!hasOutput) {
      resultLines.push('本次没有产出任何物品');
    }

    // 更新上次产出时间
    markers['家园产出时间'] = now;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return resultLines.join('\n');
  }

  /**
   * 计算最小产出时间
   * 对应原版：取最小产出时间()
   * 受消耗品（负产出）限制，计算可供消耗的时间
   */
  private calcMinOutputTime(producer: Producer, timeDiff: number, backpack: any[]): number {
    // 检查是否有消耗品（负产出）
    const consumables = producer.outputs.filter(o => o.count < 0 && o.name !== '电力');
    if (consumables.length === 0) {
      return timeDiff;
    }

    // 计算各消耗品能支撑的时间
    const times: number[] = [];
    for (const cons of consumables) {
      const item = backpack.find((i: any) => i.name === cons.name);
      const available = item ? (item.count || 1) : 0;

      // 消耗品数量 / (消耗率 / 60) = 可支撑秒数
      const consumeRate = Math.abs(cons.count) / 60;
      if (consumeRate > 0) {
        const supportTime = available / consumeRate;
        times.push(supportTime);
      }
    }

    if (times.length === 0) {
      return timeDiff;
    }

    // 取最小可支撑时间
    times.sort((a, b) => a - b);
    const minTime = times[0];

    return Math.min(timeDiff, minTime);
  }

  /**
   * 取建筑数量
   * 对应原版：取建筑数量()
   * 统计地图上不占建筑数量上限的建筑总数
   */
  private async countBuildings(map: any): Promise<number> {
    const buildings = this.playerService.safeJsonParse<any[]>(map.buildings, []);
    const buildingNames = buildings.map((b: any) => b.name);
    const buildingDefs = await this.prisma.gameBuilding.findMany({
      where: { name: { in: buildingNames } },
      select: { name: true, type: true },
    });

    // 构建不占位建筑集合
    const noOccupancyNames = new Set<string>();
    for (const def of buildingDefs) {
      // 如果建筑类型为"天花板"、"墙壁"等结构类，不占数量上限
      if (['天花板', '墙壁', '地板', '门', '窗户'].includes(def.type)) {
        noOccupancyNames.add(def.name);
      }
    }

    let total = 0;
    for (const b of buildings) {
      if (!noOccupancyNames.has(b.name)) {
        total += b.count || 1;
      }
    }
    return total;
  }

  // ==================== 家园前线 ====================

  /**
   * 家园前线
   * 对应原版：家园前线() / 是否有特殊宠物()
   * 显示家园前线状态，检查是否有特殊宠物等
   */
  private async handleHomeFrontline(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    const progress = this.playerService.getMarkerValue(markers, '家园进度');
    if (progress < 4) {
      return '家园尚未建成，无法查看前线';
    }

    // 获取家园所在地图
    if (!player.mapId) {
      return '你还没有家园所在地图';
    }

    const map = await this.prisma.gameMap.findUnique({
      where: { id: player.mapId },
    });

    if (!map) {
      return '家园所在的地图不存在';
    }

    // 解析地图上的召唤物
    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);

    // 检查是否有特殊宠物（特殊序号 > 0 的宠物）
    const specialPets = summons.filter((s: any) => {
      const specialSeq = s.specialSeq || 0;
      return specialSeq > 0 && s.hp > 0;
    });

    // 获取建筑数量
    const totalBuildings = await this.countBuildings(map);

    // 获取地图上的建筑列表
    const mapBuildings = this.playerService.safeJsonParse<any[]>(map.buildings, []);

    const lines = [
      `🏠 家园前线 - ${player.houseName || map.name}`,
      `━━━━━━━━━━━━━━━`,
      `📍 地点: ${map.name}`,
      `📦 建筑数量: ${totalBuildings} (${mapBuildings.length}种)`,
      `👥 召唤物数量: ${summons.length}`,
    ];

    // 显示特殊宠物
    if (specialPets.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`⭐ 特殊存在:`);
      for (const pet of specialPets) {
        lines.push(`  ${pet.name} (HP: ${pet.hp})`);
      }
    }

    // 显示建筑列表
    if (mapBuildings.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`📋 建筑列表:`);
      for (const b of mapBuildings) {
        lines.push(`  ${b.name} x${b.count || 1}`);
      }
    }

    // 检查是否有工业牵引光束
    const hasTractorBeam = mapBuildings.some((b: any) => b.name === '工业牵引光束');
    if (hasTractorBeam) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`🔦 工业牵引光束已激活`);
    }

    return lines.join('\n');
  }

  // ==================== 宠物系统 ====================

  /**
   * 宠物操作
   * 对应原版：宠物()
   * 宠物操作的总入口
   * @param userId 用户ID
   * @param subCommand 子命令
   * @returns 操作结果文本
   */
  async handlePet(userId: number, subCommand: string): Promise<string> {
    switch (subCommand) {
      case '操作':
        return this.getPetOperationsHelp(userId);
      default:
        return this.getPetOperationsHelp(userId);
    }
  }

  /**
   * 获取宠物操作帮助
   */
  private async getPetOperationsHelp(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const lines = [
      `${player.name || '冒险者'} 的宠物操作`,
      `━━━━━━━━━━━━━━━`,
      `1. 宠物改名 - 修改宠物名称`,
      `2. 宠物转让 - 转让宠物给他人`,
      `3. 全部跟随 - 让宠物跟随`,
      `4. 全部停下 - 让宠物停下`,
      `5. 全部被动 - 被动模式`,
      `6. 全部主动 - 主动攻击`,
      `7. 大召唤术 - 召唤所有宠物`,
      `8. 救助全部 - 救助宠物`,
      `9. 全部挤奶 - 采集宠物产出`,
      `10. 宠物驾驶 - 让宠物驾驶载具`,
      `11. 呼叫 - 呼叫宠物`,
      `12. 宠物装备 - 管理宠物装备`,
      `13. 宠物觉醒 - 觉醒宠物`,
      `14. 宠物前往 - 让宠物前往某地`,
      `15. 宠物攻击 - 宠物主动攻击`,
      `16. 宠物喂食 - 喂食提高好感`,
      `17. 宠物嗅探 - 寻找怪物`,
      `━━━━━━━━━━━━━━━`,
      `跟随: 跟着玩家移动`,
      `主动: 主动攻击`,
      `被动: 挨打也不会反击`,
      `输入宠物名称即可，不用输入宠物的称号`,
    ];

    return lines.join('\n');
  }

  /**
   * 宠物改名
   * 对应原版：宠物改名()
   * @param userId 用户ID
   * @param oldName 宠物原名
   * @param newName 新名称
   * @returns 操作结果文本
   */
  async renamePet(userId: number, oldName: string, newName: string): Promise<string> {
    if (!oldName || !newName) {
      return '请指定格式：宠物改名原名 新名';
    }

    // 检查禁用名称
    if (this.forbiddenNames.includes(oldName) || this.forbiddenNames.includes(newName)) {
      return '不能改这个名字';
    }

    // 名称长度检查
    const byteLength = newName.replace(/[^\x00-\xff]/g, 'xx').length;
    if (byteLength > 16) {
      return '最多16字符，中文占2字符';
    }

    // 获取当前地图上的召唤物
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 这里需要从地图的召唤物列表中查找并修改
    // 由于地图数据在 GameMap 模型的 summons JSON 字段中
    const map = await this.prisma.gameMap.findUnique({
      where: { id: player.mapId },
    });

    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);

    // 查找属于玩家的宠物
    const petIndex = summons.findIndex(
      (s: any) => (s.name === oldName || s.image === oldName) && s.ownerQQ === player.userId.toString(),
    );

    if (petIndex === -1) {
      return `当前地图没有名为「${oldName}」并且属于你的NPC或宠物`;
    }

    // 执行改名
    summons[petIndex].image = newName;
    summons[petIndex].name = newName;

    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { summons: JSON.stringify(summons) },
    });

    return `把${oldName}改名为${newName}`;
  }

  /**
   * 宠物转让
   * 对应原版：宠物转让()
   * @param userId 用户ID
   * @param targetQQ 目标QQ号
   * @param petName 宠物名称
   * @returns 操作结果文本
   */
  async transferPet(userId: number, targetQQ: string, petName: string): Promise<string> {
    if (!targetQQ || !petName) {
      return '请指定格式：宠物转让@QQ 宠物名';
    }

    // 检查禁用名称
    if (this.forbiddenNames.includes(petName)) {
      return '不能转让这个';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.prisma.gameMap.findUnique({
      where: { id: player.mapId },
    });

    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);

    // 查找属于玩家的宠物
    const petIndex = summons.findIndex(
      (s: any) => (s.name === petName || s.image === petName) && s.ownerQQ === player.userId.toString(),
    );

    if (petIndex === -1) {
      return `当前地图没有名为「${petName}」并且属于你的NPC`;
    }

    // 检查是否为宝宝
    const markers = summons[petIndex].markers || {};
    if (markers['幼崽']) {
      return '宝宝不能转让';
    }

    // 目标玩家是否存在
    const targetPlayer = await this.prisma.player.findFirst({
      where: { masterQQ: targetQQ },
    });

    if (!targetPlayer) {
      return `QQ ${targetQQ} 在玩家列表不存在`;
    }

    // 检查是否防御阵地
    if (markers['阵地']) {
      return '防御阵地不能转让';
    }

    // 执行转让
    summons[petIndex].ownerQQ = targetQQ;
    // 清空标记并重置好感
    summons[petIndex].markers = { [`好感${targetQQ}`]: 100 };

    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { summons: JSON.stringify(summons) },
    });

    return `把${petName}转让给了${targetQQ}`;
  }

  /**
   * 宠物驾驶
   * 对应原版：宠物驾驶()
   * @param userId 用户ID
   * @param petName 宠物名称
   * @param vehicleName 载具名称（或"原"表示使用宠物自带载具）
   * @returns 操作结果文本
   */
  async petDrive(userId: number, petName: string, vehicleName: string): Promise<string> {
    if (!petName || !vehicleName) {
      return '请指定格式：宠物驾驶宠物名 载具名\n如果是自带有载具的宠物，可以「宠物驾驶宠物名 原」让她驾驶自己原来的载具';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.prisma.gameMap.findUnique({
      where: { id: player.mapId },
    });

    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);

    // 查找属于玩家的宠物
    const petIndex = summons.findIndex(
      (s: any) => (s.name === petName || s.image === petName) && s.ownerQQ === player.userId.toString(),
    );

    if (petIndex === -1) {
      return `当前地图没有名为「${petName}」并且属于你的宠物`;
    }

    const pet = summons[petIndex];

    if (pet.hp === 0) {
      return `${petName} 没有属性，不能战斗`;
    }

    // 查找载具
    const vehicles = this.playerService.safeJsonParse<any[]>(map.vehicles, []);

    if (vehicleName === '原') {
      // 使用宠物自带载具
      const petVehicle = vehicles.find((v: any) => v.id === petName);
      if (petVehicle) {
        petVehicle.driver = petName;
        // 载具找到
        return `${petName} 进入了${petVehicle.name}的驾驶舱`;
      } else {
        return `${petName} 并不是自带载具的宠物`;
      }
    }

    // 查找指定载具
    const vehicleIndex = vehicles.findIndex((v: any) => v.name === vehicleName);
    if (vehicleIndex === -1) {
      return `附近没有载具「${vehicleName}」`;
    }

    const vehicle = vehicles[vehicleIndex];

    // 检查归属
    if (vehicle.owner !== player.userId.toString() && vehicle.owner !== petName) {
      return `这不是你的或者不是${petName}的${vehicle.name}`;
    }

    // 执行驾驶
    // 踢出当前驾驶员
    const currentDriver = vehicle.driver;
    if (currentDriver) {
      // 查找驾驶员并清除其载具引用
      const driverPet = summons.find((s: any) => s.qq === currentDriver);
      if (driverPet) {
        driverPet.vehicle = '';
      }
    }

    vehicle.driver = pet.qq || petName;
    pet.vehicle = vehicle.id || vehicleName;

    summons[petIndex] = pet;
    vehicles[vehicleIndex] = vehicle;

    // 更新地图数据
    map.summons = JSON.stringify(summons);
    map.vehicles = JSON.stringify(vehicles);

    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { summons: JSON.stringify(summons), vehicles: JSON.stringify(vehicles) },
    });

    return `${petName} 进入了${vehicle.name}的驾驶舱`;
  }

  /**
   * 宠物喂食
   * 对应原版：宠物喂食()
   * 消耗糖心巧克力提高宠物好感
   * @param userId 用户ID
   * @param petName 宠物名称
   * @param count 消耗数量
   * @returns 操作结果文本
   */
  async petFeed(userId: number, petName: string, count: number = 1): Promise<string> {
    if (!petName || count <= 0) {
      return '请指定格式：宠物喂食宠物名 数量\n消耗糖心巧克力来提高宠物的好感';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查背包是否有糖心巧克力
    const backpack = this.playerService.getBackpackItems(player);
    const chocolateItem = backpack.find((item: any) => item.name === '糖心巧克力');
    const chocolateCount = chocolateItem ? (chocolateItem.count || 0) : 0;

    if (chocolateCount < count) {
      return `需要${count}个糖心巧克力，你只有${chocolateCount}`;
    }

    // 获取当前地图
    const map = await this.prisma.gameMap.findUnique({
      where: { id: player.mapId },
    });

    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);

    // 查找属于玩家的宠物
    const petIndex = summons.findIndex(
      (s: any) => (s.name === petName || s.image === petName) && s.ownerQQ === player.userId.toString(),
    );

    if (petIndex === -1) {
      return `当前地图没有名为「${petName}」并且属于你的宠物`;
    }

    const pet = summons[petIndex];

    // 检查是否为临时宠物
    if (pet.qq && pet.qq.includes('x')) {
      return '临时宠物不能喂食';
    }

    // 扣除糖心巧克力
    if (chocolateCount === count) {
      const idx = backpack.findIndex((item: any) => item.name === '糖心巧克力');
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      chocolateItem!.count = chocolateCount - count;
    }
    player.backpack = JSON.stringify(backpack);

    // 增加好感
    const affinityKey = `好感${player.userId}`;
    if (!pet.markers) pet.markers = {};
    const currentAffinity = pet.markers[affinityKey] || 0;
    pet.markers[affinityKey] = currentAffinity + count * 10;

    // 记录喂食成就
    const tasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
    const feedTask = tasks.find((t: any) => t.name === '宠物喂食');
    if (feedTask) {
      feedTask.count = (feedTask.count || 0) + count;
    } else {
      tasks.push({ name: '宠物喂食', count });
    }
    player.tasks = JSON.stringify(tasks);

    summons[petIndex] = pet;

    // 更新地图和玩家数据
    map.summons = JSON.stringify(summons);
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { summons: JSON.stringify(summons) },
    });

    await this.playerService.savePlayer(player);

    const newAffinity = pet.markers[affinityKey] || 0;
    return `${petName} 对你的好感提高了${count * 10}（当前${Math.round(newAffinity)}）`;
  }

  /**
   * 宠物嗅探
   * 对应原版：宠物嗅探()
   * 让狩猎宠物寻找当前地图的怪物
   * @param userId 用户ID
   * @param petName 宠物名称
   * @param monsterName 要寻找的怪物名称
   * @returns 操作结果文本
   */
  async petSniff(userId: number, petName: string, monsterName: string): Promise<string> {
    if (!petName || !monsterName) {
      return '请指定格式：宠物嗅探宠物名 怪物名\n消耗宠物等级的生肉，让宠物尝试寻找当前地图存在的怪物，冷却10分钟';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 获取当前地图
    const map = await this.prisma.gameMap.findUnique({
      where: { id: player.mapId },
    });

    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);

    // 查找属于玩家的宠物
    const petIndex = summons.findIndex(
      (s: any) => (s.name === petName || s.image === petName) && s.ownerQQ === player.userId.toString(),
    );

    if (petIndex === -1) {
      return `当前地图没有名为「${petName}」并且属于你的宠物`;
    }

    const pet = summons[petIndex];

    // 检查是否为狩猎宠物
    const isHunter = this.huntingPetTypes.some(type => (pet.type || '').includes(type));
    if (!isHunter) {
      return `${petName} 不是狩猎宠物，当前的狩猎类宠物有常春藤、各种狼、各种虎、巨齿鲨`;
    }

    // 检查冷却
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const cooldownMarker = markers2.find((m: any) => m.name === '宠物嗅探');
    const now = Date.now() / 1000;
    if (cooldownMarker && cooldownMarker.expireAt > now) {
      const remaining = Math.ceil(cooldownMarker.expireAt - now);
      return `宠物嗅探冷却中，剩余${remaining}秒`;
    }

    // 检查生肉数量
    const backpack = this.playerService.getBackpackItems(player);
    const meatItem = backpack.find((item: any) => item.name === '生肉');
    const meatCount = meatItem ? (meatItem.count || 0) : 0;
    const petLevel = pet.level || 1;

    if (meatCount < petLevel) {
      return `需要消耗${petLevel}的生肉，你只有${meatCount}`;
    }

    // 检查怪物是否在当前地图存在
    const monsters = this.playerService.safeJsonParse<any[]>(map.monsters, []);
    const monsterExists = monsters.some((m: any) => m.name === monsterName || m === monsterName);

    if (!monsterExists) {
      return `在${map.name}无法找到「${monsterName}」这种怪物`;
    }

    // 扣除生肉
    if (meatCount === petLevel) {
      const idx = backpack.findIndex((item: any) => item.name === '生肉');
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      meatItem!.count = meatCount - petLevel;
    }
    player.backpack = JSON.stringify(backpack);

    // 设置冷却
    const newMarkers2 = markers2.filter((m: any) => m.name !== '宠物嗅探');
    newMarkers2.push({
      name: '宠物嗅探',
      expireAt: now + 600,
    });
    player.markers2 = JSON.stringify(newMarkers2);

    // 计算成功率：宠物战斗力 ÷ 怪物战斗力 × 2500%
    const petCombatPower = this.bonusService.calcCombatPower({
      attack: pet.attack || 0,
      hp: pet.hp || 0,
      armor: pet.defense || 0,
      speed: pet.speed || 100,
    });

    // 从怪物定义获取战斗力
    const monsterDef = await this.prisma.gameMonster.findUnique({
      where: { name: monsterName },
    });

    const monsterCombatPower = monsterDef
      ? this.bonusService.calcCombatPower({
          attack: monsterDef.attack || 0,
          hp: monsterDef.hp || 0,
          armor: monsterDef.defense || 0,
          speed: monsterDef.speed || 100,
        })
      : 100;

    const successRate = Math.min(100, (petCombatPower / Math.max(1, monsterCombatPower)) * 2500);
    const isSuccess = Math.random() * 100 < successRate;

    if (isSuccess) {
      // 成功找到怪物
      const spawnMonsters = this.playerService.safeJsonParse<any[]>(map.spawnMonsters, []);
      const newMonster = monsterDef
        ? {
            name: monsterDef.name,
            type: monsterDef.type,
            level: monsterDef.level,
            hp: monsterDef.hp,
            attack: monsterDef.attack,
            defense: monsterDef.defense,
            speed: monsterDef.speed,
          }
        : { name: monsterName, level: 1, hp: 100, attack: 10, defense: 5, speed: 100 };

      spawnMonsters.push(newMonster);

      // 添加嗅探标记到地图标记3
      const mapMarkers3 = this.playerService.safeJsonParse<any[]>(map.markers || '[]', []);
      mapMarkers3.push({
        name: `嗅探${monsterName}`,
        expireAt: now + 120,
      });

      map.spawnMonsters = JSON.stringify(spawnMonsters);
      map.markers = JSON.stringify(mapMarkers3);

      await this.prisma.gameMap.update({
        where: { id: map.id },
        data: {
          spawnMonsters: JSON.stringify(spawnMonsters),
          markers: JSON.stringify(mapMarkers3),
        },
      });

      await this.playerService.savePlayer(player);

      return `${petName} 吃掉了${petLevel}的生肉\n找到了一只${monsterName}（成功率${Math.round(successRate)}%）\n2分钟内扫荡时出现${monsterName}的几率更高`;
    } else {
      await this.playerService.savePlayer(player);

      return `${petName} 吃掉了${petLevel}的生肉\n但是没有找到${monsterName}的踪迹……（成功率${Math.round(successRate)}%）`;
    }
  }

  /**
   * 宠物觉醒
   * 对应原版：宠物觉醒()
   * 消耗觉醒丹觉醒宠物，每觉醒一次宠物全属性+0.5%
   * 觉醒到99的倍数时需要花费(觉醒次数+1)÷10的觉醒丹来突破；次数为-1时返还所有觉醒丹
   * @param userId 用户ID
   * @param petName 宠物名称
   * @param countStr 觉醒次数（负数表示返还觉醒丹）
   * @returns 操作结果文本
   */
  async petAwaken(userId: number, petName: string, countStr: string): Promise<string> {
    if (!petName || !countStr) {
      return `「宠物觉醒史莱姆 3」消耗3个觉醒丹来觉醒名为【史莱姆】的宠物3次。
「宠物觉醒史莱姆 -1」来返回名为【史莱姆】的宠物消耗的觉醒丹。
每觉醒到99时，需要花费(觉醒次数+1)÷10的觉醒丹来突破
◆每觉醒一次宠物全属性+0.5%，并获得以下效果：
◆觉醒≥1：神识初醒 - 每击杀或助攻1次，基础护盾、装甲、生命+8，闪避、命中、攻击+1
◆觉醒≥100：炼精化气 - 攻击优先级高于觉醒小于100的宠物，命中和闪避+10%，攻击+20%
◆觉醒≥200：逆转阴阳 - 贯穿+10%，攻击+50%
◆觉醒≥300：天地同辉 - 宠物驾驶载具时，攻击+20%，载具被命中时33%几率载具受到的伤害减半
◆觉醒≥400：羽化升仙 - 攻击、护盾、装甲、生命、命中、闪避、护盾回复、装甲修复、生命恢复+50%，可以使用指令「宠物攻击」
◆觉醒≥500：天神降世 - 命中目标造成目标状态上限3%的额外伤害，攻击时释放技能「天神降世」`;
    }

    const count = parseInt(countStr, 10);
    if (isNaN(count) || count === 0) {
      return `「宠物觉醒史莱姆 3」消耗3个觉醒丹来觉醒名为【史莱姆】的宠物3次。`;
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.prisma.gameMap.findUnique({
      where: { id: player.mapId },
    });
    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
    const petIndex = summons.findIndex(
      (s: any) => (s.name === petName || s.image === petName) && s.ownerQQ === player.userId.toString(),
    );
    if (petIndex === -1) {
      return `当前地图没有名为「${petName}」并且属于你的宠物`;
    }

    const pet = summons[petIndex];

    // 临时召唤物不能觉醒
    if (pet.qq && pet.qq.includes('x')) {
      return '召唤物不能觉醒';
    }
    if ((pet.hp || 0) <= 0) {
      return `${petName} 没有属性，不能觉醒`;
    }

    if (!pet.markers) pet.markers = {};
    const currentAwaken = pet.markers['觉醒'] || 0;

    // 返回觉醒丹：计算历史消耗并重置
    if (count < 0) {
      let totalSpent = 0;
      let d = 0;
      for (let i = 0; i < currentAwaken; i++) {
        totalSpent += d % 100 === 99 ? (d + 1) / 10 : 1;
        d++;
      }
      pet.markers['觉醒'] = 0;
      summons[petIndex] = pet;
      await this.prisma.gameMap.update({
        where: { id: map.id },
        data: { summons: JSON.stringify(summons) },
      });

      // 返还觉醒丹到背包
      const backpack = this.playerService.getBackpackItems(player);
      const pillItem = backpack.find((item: any) => item.name === '觉醒丹');
      if (pillItem) {
        pillItem.count = (pillItem.count || 0) + totalSpent;
      } else {
        backpack.push({ name: '觉醒丹', type: '资源', count: totalSpent });
      }
      player.backpack = JSON.stringify(backpack);
      await this.playerService.savePlayer(player);

      return `还原了${petName}的${currentAwaken}次觉醒，得到了觉醒丹x${totalSpent}`;
    }

    // 正向觉醒
    const backpack = this.playerService.getBackpackItems(player);
    const pillItem = backpack.find((item: any) => item.name === '觉醒丹');
    let available = pillItem ? (pillItem.count || 0) : 0;

    let d = currentAwaken;
    let used = 0;
    let done = 0;
    for (let i = 0; i < count; i++) {
      const cost = d % 100 === 99 ? (d + 1) / 10 : 1;
      if (available < cost) break;
      available -= cost;
      used += cost;
      d++;
      done++;
    }

    if (done === 0) {
      const nextCost = d % 100 === 99 ? (d + 1) / 10 : 1;
      return `${petName}，突破「${this.getAwakenStageName(d)}」需要${nextCost}颗觉醒丹，你只有${pillItem ? pillItem.count : 0}`;
    }

    // 扣除觉醒丹
    if (pillItem && used > 0) {
      if (pillItem.count === used) {
        backpack.splice(backpack.indexOf(pillItem), 1);
      } else {
        pillItem.count -= used;
      }
    }
    player.backpack = JSON.stringify(backpack);

    // 记录觉醒次数
    pet.markers['觉醒'] = d;
    // 属性加成：每觉醒一次全属性+0.5%（基于初始属性）
    if (!pet.baseStats) {
      pet.baseStats = {
        hp: pet.hp || 0,
        attack: pet.attack || 0,
        defense: pet.defense || 0,
        speed: pet.speed || 100,
      };
    }
    const bonus = 1 + d * 0.005;
    pet.hp = Math.round((pet.baseStats.hp || 0) * bonus);
    pet.attack = Math.round((pet.baseStats.attack || 0) * bonus);
    pet.defense = Math.round((pet.baseStats.defense || 0) * bonus);
    pet.speed = Math.round((pet.baseStats.speed || 100) * bonus);

    summons[petIndex] = pet;
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { summons: JSON.stringify(summons) },
    });
    await this.playerService.savePlayer(player);

    return `消耗${used}颗觉醒丹让${petName}觉醒了${done}次，突破到了
${this.getAwakenStageName(d)}(${d})`;
  }

  /**
   * 获取觉醒阶段名称
   * @param awaken 觉醒次数
   */
  private getAwakenStageName(awaken: number): string {
    if (awaken < 100) return `神识初醒(${awaken})`;
    if (awaken < 200) return `炼精化气(${awaken - 100})(${awaken})`;
    if (awaken < 300) return `逆转阴阳(${awaken - 200})(${awaken})`;
    if (awaken < 400) return `天地同辉(${awaken - 300})(${awaken})`;
    if (awaken < 500) return `羽化升仙(${awaken - 400})(${awaken})`;
    return `天神降世(${awaken - 500})(${awaken})`;
  }

  /**
   * 宠物攻击
   * 对应原版：宠物攻击()
   * 远程操作放在指定地图、觉醒≥400、生命大于0的宠物对怪物发起攻击（冷却30秒）
   * @param userId 用户ID
   * @param mapName 目标地图名称
   * @returns 操作结果文本
   */
  async petAttack(userId: number, mapName: string): Promise<string> {
    if (!mapName) {
      return `「宠物攻击森林出口」来远程操作，让你放在森林出口的宠物对怪物发起攻击`;
    }

    const map = await this.prisma.gameMap.findFirst({ where: { name: mapName } });
    if (!map) {
      return `${mapName} 在地图列表不存在`;
    }

    // 查找该地图上属于玩家、存活、觉醒≥400的宠物
    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
    const qualifiedPet = summons.find(
      (s: any) =>
        s.ownerQQ === userId.toString() &&
        (s.hp || 0) > 0 &&
        ((s.markers && s.markers['觉醒']) || 0) >= 400,
    );

    if (!qualifiedPet) {
      return `${mapName} 没有属于你、当前生命大于0、觉醒阶段至少为【羽化升仙】的宠物`;
    }

    // 检查地图上的目标怪物（临时生成的怪物）
    const spawnMonsters = this.playerService.safeJsonParse<any[]>(map.spawnMonsters || '[]', []);
    if (spawnMonsters.length === 0) {
      return `${map.name} 没有目标了`;
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 冷却30秒
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const now = Date.now() / 1000;
    const cooldownKey = `宠物攻击${map.name}`;
    const cd = markers2.find((m: any) => m.name === cooldownKey);
    if (cd && cd.expireAt > now) {
      return `宠物攻击冷却中，剩余${Math.ceil(cd.expireAt - now)}秒`;
    }

    // 宠物对第一个怪物发起攻击（简化战斗：直接结算伤害）
    const monster = spawnMonsters[0];
    const petCombat = this.bonusService.calcCombatPower({
      attack: qualifiedPet.attack || 0,
      hp: qualifiedPet.hp || 0,
      armor: qualifiedPet.defense || 0,
      speed: qualifiedPet.speed || 100,
    });
    const monsterCombat = this.bonusService.calcCombatPower({
      attack: monster.attack || 0,
      hp: monster.hp || 0,
      armor: monster.defense || 0,
      speed: monster.speed || 100,
    });

    // 简单胜率判定
    const winRate = petCombat / Math.max(1, petCombat + monsterCombat);
    const isWin = Math.random() < winRate;

    let resultText: string;
    if (isWin) {
      spawnMonsters.shift();
      resultText = `${qualifiedPet.name} 击败了${monster.name || '怪物'}！`;
    } else {
      const hpLoss = Math.max(1, Math.round((monster.attack || 0) * 0.3));
      qualifiedPet.hp = Math.max(1, (qualifiedPet.hp || 0) - hpLoss);
      resultText = `${qualifiedPet.name} 未能击败${monster.name || '怪物'}，受到了${hpLoss}点伤害`;
    }

    // 设置冷却和活动标记
    const newMarkers2 = markers2.filter((m: any) => m.name !== cooldownKey);
    newMarkers2.push({ name: cooldownKey, expireAt: now + 30 });
    player.markers2 = JSON.stringify(newMarkers2);

    // 更新地图与玩家
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: {
        summons: JSON.stringify(summons),
        spawnMonsters: JSON.stringify(spawnMonsters),
      },
    });
    await this.playerService.savePlayer(player);

    return resultText;
  }

  /**
   * 宠物前往
   * 对应原版：宠物前往()
   * 让当前地图上属于玩家的宠物移动到指定地图
   * @param userId 用户ID
   * @param petName 宠物名称
   * @param mapName 目标地图名称
   * @returns 操作结果文本
   */
  async petGoto(userId: number, petName: string, mapName: string): Promise<string> {
    if (!petName || !mapName) {
      return `「宠物前往史莱姆 森林出口」来让名为史莱姆的宠物前往你指定的地点`;
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const map = await this.prisma.gameMap.findUnique({ where: { id: player.mapId } });
    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
    const petIndex = summons.findIndex(
      (s: any) => (s.name === petName || s.image === petName) && s.ownerQQ === player.userId.toString(),
    );
    if (petIndex === -1) {
      return `${map.name} 这里没有属于你的、名为「${petName}」的宠物或NPC`;
    }

    const targetMap = await this.prisma.gameMap.findFirst({ where: { name: mapName } });
    if (!targetMap) {
      return `${mapName} 在地图列表不存在`;
    }

    const pet = summons[petIndex];
    summons.splice(petIndex, 1);

    // 处理载具描述
    const vehicles = this.playerService.safeJsonParse<any[]>(map.vehicles || '[]', []);
    const vehicle = vehicles.find((v: any) => v.id === pet.vehicle || v.driver === pet.qq || v.driver === petName);
    let moveText: string;
    if (vehicle && vehicle.walkMode === 0) {
      moveText = `拖着${vehicle.name}跑到了`;
    } else if (vehicle && vehicle.walkMode === 1) {
      moveText = `驾驶${vehicle.name}一路疾驰来到了`;
    } else if (vehicle && vehicle.walkMode === 2) {
      moveText = `操纵${vehicle.name}飞到了`;
    } else if (vehicle && vehicle.walkMode === 4) {
      moveText = `的${vehicle.name}安装了无法移动的组件，${pet.name}丢下${vehicle.name}跑到了`;
    } else if (vehicle) {
      moveText = `操纵${vehicle.name}跃迁到了`;
    } else {
      moveText = '跑到了';
    }

    // 添加到目标地图
    const targetSummons = this.playerService.safeJsonParse<any[]>(targetMap.summons, []);
    targetSummons.push(pet);
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { summons: JSON.stringify(summons) },
    });
    await this.prisma.gameMap.update({
      where: { id: targetMap.id },
      data: { summons: JSON.stringify(targetSummons) },
    });

    return `${pet.name}${moveText}${targetMap.name}`;
  }

  /**
   * 宠物装备
   * 对应原版：宠物装备()
   * 让宠物额外使用背包里的武器/装备/法宝（必须是宝宝，螳螂除外），或把装备还给你
   * @param userId 用户ID
   * @param petName 宠物名称
   * @param itemArg 物品序号（给装备）或物品名称（还装备）
   * @returns 操作结果文本
   */
  async petEquip(userId: number, petName: string, itemArg: string): Promise<string> {
    if (!petName || !itemArg) {
      return `「宠物装备史莱姆 17」来让名为【史莱姆】的宠物额外使用你背包里的第17个物品(这个物品必须是武器，或者装备，或者法宝)
这件物品会被宠物拿过去装备在身上
必须是使用床补魔生下的宝宝才能使用这个功能
一个宠物最多额外装备一件武器、一件装备、一件法宝
「宠物装备史莱姆 火神机枪」来让宠物把它装备的物品(或者背包里的物品)还给你`;
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const map = await this.prisma.gameMap.findUnique({ where: { id: player.mapId } });
    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
    const petIndex = summons.findIndex(
      (s: any) => (s.name === petName || s.image === petName) && s.ownerQQ === player.userId.toString(),
    );
    if (petIndex === -1) {
      return `${map.name} 这里没有属于你的、名为${petName}的宠物`;
    }

    const pet = summons[petIndex];

    // 必须是宝宝（补魔生下）或螳螂
    const isBaby = pet.markers && pet.markers['宝宝'];
    const isMantis = (pet.type || '').includes('螳螂');
    if (!isBaby && !isMantis) {
      return `${map.name} 这里没有属于你的、名为${petName}、是补魔生下来的宝宝的宠物`;
    }
    if (pet.qq && pet.qq.includes('x')) {
      return '召唤物不能执行此操作';
    }

    // 宠物额外装备列表：装备预设[2].装备
    if (!pet.equipmentPresets) pet.equipmentPresets = [{}, { equipment: [] }];
    const extraEquip: any[] = pet.equipmentPresets[2]?.equipment || [];

    // 背包物品
    const backpack = this.playerService.getBackpackItems(player);
    const isIndex = /^\d+$/.test(itemArg);

    if (isIndex) {
      // 给宠物上装备
      let idx = parseInt(itemArg, 10);
      if (idx < 1 || idx > backpack.length) {
        return `背包中没有第${idx}个物品`;
      }
      // 原版中背包数组从1开始
      const item = backpack[idx - 1];

      // 判断物品类型
      const itemType = item.type || '';
      const isWeaponType = itemType === '武器';
      const isEquipType = itemType === '装备';
      const isMagic = itemType === '法宝';

      if (!isWeaponType && !isEquipType && !isMagic) {
        return `${item.name}不是装备，也不是武器或者法宝`;
      }

      // 检查是否已装备同名物品
      const sameName = extraEquip.some((e: any) => e.name === item.name);
      if (sameName) {
        return `${petName} 已经在使用${item.name}这件物品了`;
      }

      // 检查同类型数量限制
      const hasWeapon = extraEquip.some((e: any) => (e.type || '') === '武器');
      const hasEquip = extraEquip.some((e: any) => (e.type || '') === '装备');
      const hasMagic = extraEquip.some((e: any) => (e.type || '') === '法宝');

      if (isWeaponType && hasWeapon) {
        return `${petName} 已经在使用额外的武器了，不能装备多件`;
      }
      if (isEquipType && hasEquip) {
        return `${petName} 已经在使用额外的装备了，不能装备多件`;
      }
      if (isMagic && hasMagic) {
        return `${petName} 已经在使用法宝了，不能装备多件`;
      }

      // 装备给宠物并从玩家背包移除
      extraEquip.push(item);
      backpack.splice(idx - 1, 1);
      player.backpack = JSON.stringify(backpack);

      pet.equipmentPresets[2].equipment = extraEquip;
      summons[petIndex] = pet;

      await this.prisma.gameMap.update({
        where: { id: map.id },
        data: { summons: JSON.stringify(summons) },
      });
      await this.playerService.savePlayer(player);

      const typeText = isWeaponType ? '接过了' : isEquipType ? '穿上了' : '佩戴上了';
      return `${petName}${typeText}${player.name || '你'}递过来的${item.name}`;
    }

    // 还装备：按名称在宠物额外装备中查找
    const equipIdx = extraEquip.findIndex((e: any) => e.name === itemArg);
    if (equipIdx === -1) {
      return `${petName} 没装备有${itemArg}`;
    }

    const returned = extraEquip[equipIdx];
    extraEquip.splice(equipIdx, 1);
    backpack.push(returned);
    player.backpack = JSON.stringify(backpack);

    pet.equipmentPresets[2].equipment = extraEquip;
    summons[petIndex] = pet;

    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { summons: JSON.stringify(summons) },
    });
    await this.playerService.savePlayer(player);

    return `${petName}把${returned.name}还给了${player.name || '你'}`;
  }


  /**
   * 捕捉宠物
   * 对应原版：捕捉/开始捕捉/停止捕捉()
   * @param userId 用户ID
   * @param action 动作：capture/start/stop
   * @param target 目标名称
   * @returns 操作结果文本
   */
  async capturePet(userId: number, action: string, target?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 获取当前地图
    const map = await this.prisma.gameMap.findUnique({
      where: { id: player.mapId },
    });

    if (!map) {
      return '你不在任何地图上';
    }

    const monsters = this.playerService.safeJsonParse<any[]>(map.monsters, []);

    if (action === 'start') {
      // 开始捕捉
      if (!target) {
        return '请指定目标：开始捕捉史莱姆';
      }

      const monsterIndex = monsters.findIndex((m: any) => m.name === target || m === target);
      if (monsterIndex === -1) {
        return `附近没有${target}`;
      }

      const monster = monsters[monsterIndex];
      const monsterData = typeof monster === 'string' ? { name: monster } : monster;

      // 检查是否可以麻醉捕捉
      if (monsterData.anesthesia === undefined && !monsterData.description?.includes('【特殊驯服方式】')) {
        return `${target} 不是可以捕捉的对象，或者不能通过正常麻醉的方式捕捉`;
      }

      // 设置捕捉模式（10分钟免疫生命伤害）
      const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
      const now = Date.now() / 1000;
      const newMarkers2 = markers2.filter((m: any) => m.name !== '麻醉');
      newMarkers2.push({
        name: '麻醉',
        expireAt: now + 600,
      });
      player.markers2 = JSON.stringify(newMarkers2);

      await this.playerService.savePlayer(player);

      return `${target} 被设置为捕捉模式\n「停止捕捉${target}」来取消`;
    }

    if (action === 'stop') {
      // 停止捕捉
      if (!target) {
        return '请指定目标：停止捕捉史莱姆';
      }

      const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
      const newMarkers2 = markers2.filter((m: any) => m.name !== '麻醉');
      player.markers2 = JSON.stringify(newMarkers2);

      await this.playerService.savePlayer(player);

      return `${target} 被取消了捕捉模式`;
    }

    // 捕捉
    if (action === 'capture') {
      if (!target) {
        return '请指定目标：捕捉史莱姆';
      }

      // 检查是否为特殊宠物（花园宝宝、小白狐）
      if (target === '花园宝宝' || target === '小白狐') {
        return this.captureSpecialPet(userId, target, map, player, markers);
      }

      // 普通怪物捕捉
      const monsterIndex = monsters.findIndex((m: any) => {
        if (typeof m === 'string') return m === target;
        return m.name === target;
      });

      if (monsterIndex === -1) {
        return `附近没有${target}`;
      }

      const monster = monsters[monsterIndex];
      const monsterData = typeof monster === 'string' ? { name: monster, anesthesia: 100 } : monster;

      // 检查麻醉值
      const anestReq = Math.abs(monsterData.anesthesia || 100);
      const feedRequired = Math.ceil(anestReq / 150);

      // 检查饲料
      const backpack = this.playerService.getBackpackItems(player);
      const feedItem = backpack.find((item: any) => item.name === '饲料');
      const feedCount = feedItem ? (feedItem.count || 0) : 0;

      if (feedCount < feedRequired) {
        return `捕捉${target}需要${feedRequired}的饲料，你只有${feedCount}`;
      }

      // 扣除饲料
      if (feedCount === feedRequired) {
        const idx = backpack.findIndex((item: any) => item.name === '饲料');
        if (idx !== -1) backpack.splice(idx, 1);
      } else {
        feedItem!.count = feedCount - feedRequired;
      }
      player.backpack = JSON.stringify(backpack);

      // 创建宠物
      const newPet = {
        name: target,
        type: monsterData.name || target,
        specialSeq: -2,
        ownerQQ: player.userId.toString(),
        qq: `${player.userId}_pet_${target}`,
        hp: monsterData.hp || 100,
        attack: monsterData.attack || 10,
        defense: monsterData.defense || 5,
        speed: monsterData.speed || 100,
        level: monsterData.level || 1,
        markers: { [`好感${player.userId}`]: 100 },
        vehicle: '',
      };

      // 添加到地图召唤物
      const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
      summons.push(newPet);

      // 从怪物列表中移除
      monsters.splice(monsterIndex, 1);

      // 更新地图
      map.monsters = JSON.stringify(monsters);
      map.summons = JSON.stringify(summons);

      await this.prisma.gameMap.update({
        where: { id: map.id },
        data: {
          monsters: JSON.stringify(monsters),
          summons: JSON.stringify(summons),
        },
      });

      // 记录捕捉成就
      const tasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
      const captureTask = tasks.find((t: any) => t.name === '捕捉');
      if (captureTask) {
        captureTask.count = (captureTask.count || 0) + 1;
      } else {
        tasks.push({ name: '捕捉', count: 1 });
      }
      const captureTargetTask = tasks.find((t: any) => t.name === `捕捉${target}`);
      if (captureTargetTask) {
        captureTargetTask.count = (captureTargetTask.count || 0) + 1;
      } else {
        tasks.push({ name: `捕捉${target}`, count: 1 });
      }
      player.tasks = JSON.stringify(tasks);

      await this.playerService.savePlayer(player);

      return `驯养了一只${target}\n${target} 对你的好感度为100`;
    }

    return '未知的捕捉操作';
  }

  /**
   * 捕捉特殊宠物（花园宝宝、小白狐）
   */
  private async captureSpecialPet(
    userId: number,
    target: string,
    map: any,
    player: any,
    markers: any,
  ): Promise<string> {
    // 统计全地图中该宠物的数量
    const allMaps = await this.prisma.gameMap.findMany();
    let totalCount = 0;

    for (const m of allMaps) {
      const summons = this.playerService.safeJsonParse<any[]>(m.summons, []);
      totalCount += summons.filter((s: any) => s.name === target).length;
    }

    // 检查冷却（全地图数量<10时有冷却）
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const cooldownMarker = markers2.find((m: any) => m.name === `${target}冷却`);
    const now = Date.now() / 1000;

    if (totalCount < 10 && cooldownMarker && cooldownMarker.expireAt > now) {
      const remaining = Math.ceil(cooldownMarker.expireAt - now);
      return `你近期已经抓到过${target}了，冷却${remaining}秒`;
    }

    // 检查饲料
    const backpack = this.playerService.getBackpackItems(player);
    const feedItem = backpack.find((item: any) => item.name === '饲料');
    const feedCount = feedItem ? (feedItem.count || 0) : 0;

    if (feedCount < 100) {
      return '需要100饲料';
    }

    // 扣除饲料
    if (feedCount === 100) {
      const idx = backpack.findIndex((item: any) => item.name === '饲料');
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      feedItem!.count = feedCount - 100;
    }
    player.backpack = JSON.stringify(backpack);

    // 40%成功率
    const isSuccess = Math.random() < 0.4;

    // 当前地图中找到该宠物
    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
    const petIndex = summons.findIndex((s: any) => s.name === target);

    if (petIndex === -1) {
      return `附近没有${target}`;
    }

    let result = `拿100饲料引诱${target}`;

    if (isSuccess) {
      // 捕捉成功
      result += `\n${target} 吃掉饲料后，紧紧跟着你`;

      // 添加到背包
      await this.playerService.addToBackpack(userId, target, 1);

      // 设置冷却
      const newMarkers2 = markers2.filter((m: any) => m.name !== `${target}冷却`);
      newMarkers2.push({
        name: `${target}冷却`,
        expireAt: now + 1800,
      });
      player.markers2 = JSON.stringify(newMarkers2);

      // 从地图移除
      summons.splice(petIndex, 1);
    } else {
      // 捕捉失败
      result += `\n${target} 吃掉饲料后逃走了……`;
      summons.splice(petIndex, 1);
    }

    // 额外奖励物品
    const rewardItems = ['木头', '石头', '铁矿', '绳子'];
    const rewardName = rewardItems[Math.floor(Math.random() * rewardItems.length)];
    const rewardCount = Math.floor(Math.random() * 5) + 1;
    await this.playerService.addToBackpack(userId, rewardName, rewardCount);
    result += `\n得到了${rewardName}x${rewardCount}`;

    // 记录成就
    const tasks = this.playerService.safeJsonParse<any[]>(player.tasks, []);
    const captureTask = tasks.find((t: any) => t.name === `捕捉${target}`);
    if (captureTask) {
      captureTask.count = (captureTask.count || 0) + 1;
    } else {
      tasks.push({ name: `捕捉${target}`, count: 1 });
    }
    player.tasks = JSON.stringify(tasks);

    // 更新地图
    map.summons = JSON.stringify(summons);
    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { summons: JSON.stringify(summons) },
    });

    await this.playerService.savePlayer(player);

    return result;
  }

  // ==================== 使魔技能 ====================

  /**
   * 安乐天使技能
   * 对应原版：安乐天使()
   * 给自己、其他玩家或召唤物施加行星护盾（20秒伤害免疫）
   * @param userId 用户ID
   * @param targetName 目标名称（可选，为空则对自己使用）
   * @returns 操作结果文本
   */
  async safetyAngel(userId: number, targetName?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查是否有安乐天使装备
    const backpack = this.playerService.getBackpackItems(player);
    const hasAngel = backpack.some((item: any) => item.name === '安乐天使');
    if (!hasAngel) {
      return '需要安乐天使';
    }

    // 检查冷却
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const cooldownMarker = markers2.find((m: any) => m.name === '安乐');
    const now = Date.now() / 1000;
    if (cooldownMarker && cooldownMarker.expireAt > now) {
      const remaining = Math.ceil(cooldownMarker.expireAt - now);
      return `冷却中，剩余${remaining}秒`;
    }

    // 设置冷却（300秒 = 5分钟）
    const newMarkers2 = markers2.filter((m: any) => m.name !== '安乐');
    newMarkers2.push({
      name: '安乐',
      expireAt: now + 300,
    });
    player.markers2 = JSON.stringify(newMarkers2);

    if (!targetName) {
      // 对自己使用
      const buffs = this.playerService.safeJsonParse<any[]>(player.buffs, []);
      const newBuffs = buffs.filter((b: any) => b.name !== '安乐天使');
      newBuffs.push({
        name: '安乐天使',
        expireAt: now + 20,
      });
      player.buffs = JSON.stringify(newBuffs);
      await this.playerService.savePlayer(player);
      return `给自己套上了行星护盾`;
    }

    // 尝试查找目标（先查召唤物，再查玩家）
    const map = await this.prisma.gameMap.findUnique({
      where: { id: player.mapId },
    });

    if (map) {
      const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
      const summonTarget = summons.find((s: any) => s.name === targetName);

      if (summonTarget) {
        if (!summonTarget.buffs) summonTarget.buffs = [];
        const newBuffs = summonTarget.buffs.filter((b: any) => b.name !== '安乐天使');
        newBuffs.push({
          name: '安乐天使',
          expireAt: now + 20,
        });
        summonTarget.buffs = newBuffs;

        map.summons = JSON.stringify(summons);
        await this.prisma.gameMap.update({
          where: { id: map.id },
          data: { summons: JSON.stringify(summons) },
        });

        await this.playerService.savePlayer(player);
        return `给${targetName}套上了行星护盾`;
      }
    }

    // 对玩家使用
    const targetPlayer = await this.prisma.player.findFirst({
      where: { masterQQ: targetName },
    });

    if (targetPlayer) {
      const targetBuffs = this.playerService.safeJsonParse<any[]>(targetPlayer.buffs, []);
      const newBuffs = targetBuffs.filter((b: any) => b.name !== '安乐天使');
      newBuffs.push({
        name: '安乐天使',
        expireAt: now + 20,
      });
      targetPlayer.buffs = JSON.stringify(newBuffs);

      await this.prisma.player.update({
        where: { id: targetPlayer.id },
        data: { buffs: JSON.stringify(newBuffs) },
      });

      await this.playerService.savePlayer(player);
      return `给${targetName}套上了行星护盾`;
    }

    await this.playerService.savePlayer(player);
    return `给自己套上了行星护盾`;
  }

  /**
   * 福音书技能
   * 对应原版：福音书()
   * 给自己或目标施加福音书增益（300秒属性加成）
   * @param userId 用户ID
   * @param targetName 目标名称（可选，为空则对自己使用）
   * @returns 操作结果文本
   */
  async gospelBook(userId: number, targetName?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查是否有福音书装备
    const backpack = this.playerService.getBackpackItems(player);
    const hasGospel = backpack.some((item: any) => item.name === '福音书');
    if (!hasGospel) {
      return '需要福音书';
    }

    // 检查是否每天只能使用一次
    const gospelUsage = this.playerService.getMarkerValue(markers, '福音书');
    if (gospelUsage !== 0) {
      return '一天只能使用一次';
    }

    // 记录使用
    markers['福音书'] = 1;
    player.markers = JSON.stringify(markers);

    const now = Date.now() / 1000;

    if (!targetName) {
      // 对自己使用
      const buffs = this.playerService.safeJsonParse<any[]>(player.buffs, []);
      const newBuffs = buffs.filter((b: any) => b.name !== '福音书');
      newBuffs.push({
        name: '福音书',
        expireAt: now + 300,
        strength: 10,
      });
      player.buffs = JSON.stringify(newBuffs);
      await this.playerService.savePlayer(player);
      return `给自己使用了福音书`;
    }

    // 尝试查找目标
    const map = await this.prisma.gameMap.findUnique({
      where: { id: player.mapId },
    });

    if (map) {
      const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);
      const summonTarget = summons.find((s: any) => s.name === targetName);

      if (summonTarget) {
        if (!summonTarget.buffs) summonTarget.buffs = [];
        const newBuffs = summonTarget.buffs.filter((b: any) => b.name !== '福音书');
        newBuffs.push({
          name: '福音书',
          expireAt: now + 300,
          strength: 10,
        });
        summonTarget.buffs = newBuffs;

        map.summons = JSON.stringify(summons);
        await this.prisma.gameMap.update({
          where: { id: map.id },
          data: { summons: JSON.stringify(summons) },
        });

        await this.playerService.savePlayer(player);
        return `给${targetName}使用了福音书`;
      }
    }

    // 对玩家使用
    const targetPlayer = await this.prisma.player.findFirst({
      where: { masterQQ: targetName },
    });

    if (targetPlayer) {
      const targetBuffs = this.playerService.safeJsonParse<any[]>(targetPlayer.buffs, []);
      const newBuffs = targetBuffs.filter((b: any) => b.name !== '福音书');
      newBuffs.push({
        name: '福音书',
        expireAt: now + 300,
        strength: 10,
      });
      targetPlayer.buffs = JSON.stringify(newBuffs);

      await this.prisma.player.update({
        where: { id: targetPlayer.id },
        data: { buffs: JSON.stringify(newBuffs) },
      });

      await this.playerService.savePlayer(player);
      return `给${targetName}使用了福音书`;
    }

    await this.playerService.savePlayer(player);
    return `给自己使用了福音书`;
  }

  /**
   * 设置跟随
   * 对应原版：设置跟随()
   * 设置宠物跟随或停止跟随玩家
   * @param userId 用户ID
   * @param targetName 宠物名称或QQ
   * @param isFollow 是否跟随
   * @returns 操作结果文本
   */
  async setFollow(userId: number, targetName: string, isFollow: boolean): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.prisma.gameMap.findUnique({
      where: { id: player.mapId },
    });

    if (!map) {
      return '你不在任何地图上';
    }

    const summons = this.playerService.safeJsonParse<any[]>(map.summons, []);

    // 查找宠物
    const petIndex = summons.findIndex(
      (s: any) => (s.name === targetName || s.qq === targetName) && s.ownerQQ === player.userId.toString(),
    );

    if (petIndex === -1) {
      return `当前地图没有名为「${targetName}」并且属于你的宠物`;
    }

    const pet = summons[petIndex];

    if (isFollow) {
      pet.follow = true;
      pet.mode = 'follow';
    } else {
      pet.follow = false;
      pet.mode = 'idle';
    }

    summons[petIndex] = pet;
    map.summons = JSON.stringify(summons);

    await this.prisma.gameMap.update({
      where: { id: map.id },
      data: { summons: JSON.stringify(summons) },
    });

    return isFollow
      ? `${pet.name} 开始跟随你`
      : `${pet.name} 停止跟随`;
  }

  /**
   * 获取使魔技能效果
   * 根据好感度计算技能效果倍率
   * 好感度越高，技能效果越强
   * @param affinity 当前好感度数值
   * @returns 效果倍率（1.0 为基准）
   */
  getSkillEffect(affinity: number): number {
    // 基础效果为 1.0（100%）
    // 好感度每增加 1000，效果提升 5%，最高提升至 200%
    const bonus = Math.min(1.0, Math.floor(affinity / 1000) * 0.05);
    return Math.min(2.0, 1.0 + bonus);
  }

  // ==================== 好感度系统 ====================

  /**
   * 好感度等级配置
   * 1-5级，每级对应不同的好感度阈值和效果描述
   */
  private readonly affinityLevels = [
    { level: 1, minAffinity: 0, name: '陌生', effect: '基础效果' },
    { level: 2, minAffinity: 25, name: '熟悉', effect: '解锁部分专属对话' },
    { level: 3, minAffinity: 50, name: '友好', effect: '技能效果提升10%' },
    { level: 4, minAffinity: 75, name: '亲密', effect: '技能效果提升20%，解锁特殊互动' },
    { level: 5, minAffinity: 100, name: '挚爱', effect: '技能效果提升30%，解锁专属剧情' },
  ];

  /**
   * 增加好感度
   * 好感度增加：战斗/对话/赠礼等增加好感
   * @param userId 用户ID
   * @param amount 增加的好感度数值
   * @returns 操作结果文本
   */
  async increaseAffinity(userId: number, amount: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.type) {
      return '你还没有选择使魔';
    }

    // 获取当前使魔的好感度
    const affinityKey = `${player.type}好感`;
    const currentAffinity = this.playerService.getMarkerValue(markers, affinityKey);
    const newAffinity = currentAffinity + amount;

    // 更新好感度
    markers[affinityKey] = newAffinity;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    // 获取之前的等级和新的等级
    const oldLevel = this.getAffinityLevelByValue(currentAffinity);
    const newLevel = this.getAffinityLevelByValue(newAffinity);

    let result = `${player.type} 的好感度增加了 ${amount} 点（当前: ${Math.round(newAffinity)}）`;

    // 如果等级提升，显示解锁效果
    if (newLevel > oldLevel) {
      const levelConfig = this.affinityLevels.find(l => l.level === newLevel);
      if (levelConfig) {
        result += `\n好感度等级提升至 Lv.${newLevel}「${levelConfig.name}」！\n${levelConfig.effect}`;
      }
    }

    return result;
  }

  /**
   * 根据好感度数值获取等级
   * @param affinity 好感度数值
   * @returns 好感度等级（1-5）
   */
  private getAffinityLevelByValue(affinity: number): number {
    let level = 1;
    for (const l of this.affinityLevels) {
      if (affinity >= l.minAffinity) {
        level = l.level;
      }
    }
    return level;
  }

  /**
   * 获取好感度等级
   * @param userId 用户ID
   * @returns 好感度等级（1-5）
   */
  async getAffinityLevel(userId: number): Promise<number> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.type) {
      return 0;
    }

    const affinityKey = `${player.type}好感`;
    const affinity = this.playerService.getMarkerValue(markers, affinityKey);
    return this.getAffinityLevelByValue(affinity);
  }

  /**
   * 应用好感度效果
   * 根据好感度等级给玩家添加对应的属性加成
   * @param userId 用户ID
   * @param bonus 加成数据对象
   */
  async applyAffinityEffects(userId: number, bonus: BonusData): Promise<void> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.type) {
      return;
    }

    // 获取好感度等级
    const affinityKey = `${player.type}好感`;
    const affinity = this.playerService.getMarkerValue(markers, affinityKey);
    const level = this.getAffinityLevelByValue(affinity);

    // 根据等级应用加成
    // 等级越高，加成越多
    const affinityBonus = (level - 1) * 0.1; // 每级10%加成

    // 根据使魔类型应用不同的加成效果
    switch (player.type) {
      case '龙姬':
        bonus.attack = (bonus.attack || 0) + Math.floor(10 * affinityBonus);
        break;
      case '军姬':
      case '军姬2':
        bonus.speed = (bonus.speed || 0) + Math.floor(10 * affinityBonus);
        break;
      case 'Saber':
        bonus.attack = (bonus.attack || 0) + Math.floor(15 * affinityBonus);
        bonus.defense = (bonus.defense || 0) + Math.floor(5 * affinityBonus);
        break;
      case '冥鱼':
        bonus.crit = (bonus.crit || 0) + Math.floor(5 * affinityBonus);
        break;
      case '伊卡洛斯':
        bonus.attack = (bonus.attack || 0) + Math.floor(20 * affinityBonus);
        break;
      case '兰音':
        bonus.allResist = (bonus.allResist || 0) + Math.floor(10 * affinityBonus);
        break;
      default:
        // 通用加成
        bonus.attack = (bonus.attack || 0) + Math.floor(5 * affinityBonus);
        bonus.defense = (bonus.defense || 0) + Math.floor(5 * affinityBonus);
        break;
    }
  }

  // ==================== 使魔排行 ====================

  /**
   * 获取使魔排行
   * 按使魔战力/等级排序，显示前10名
   * @param userId 用户ID
   * @returns 排行文本
   */
  async getFamiliarRanking(userId: number): Promise<string> {
    // 获取所有玩家数据，按使魔等级和战力排序
    const allPlayers = await this.prisma.player.findMany({
      where: {
        type: { not: '' },
        level: { gt: 0 },
      },
      orderBy: [
        { level: 'desc' },
      ],
      take: 10,
    });

    if (allPlayers.length === 0) {
      return '目前还没有使魔排行数据';
    }

    const lines = [
      '🏆【使魔战力排行】🏆',
      '━━━━━━━━━━━━━━━',
    ];

    // 排行称号
    const rankTitles = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

    for (let i = 0; i < allPlayers.length; i++) {
      const p = allPlayers[i];
      const rank = rankTitles[i] || `${i + 1}.`;
      const name = p.name || '未知冒险者';
      const level = p.level || 0;
      const type = p.type || '未知';
      lines.push(`${rank} ${name} | Lv.${level} | ${type}`);
    }

    // 获取当前玩家的排名
    const currentPlayer = allPlayers.find(p => p.userId === userId);
    if (currentPlayer) {
      const currentRank = allPlayers.indexOf(currentPlayer) + 1;
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`你的排名: 第${currentRank}名`);
    } else {
      // 获取当前玩家信息
      const playerData = await this.playerService.getPlayerData(userId);
      const { player } = playerData;
      if (player.type) {
        // 计算当前玩家在所有玩家中的排名
        const allCount = await this.prisma.player.count({
          where: { type: { not: '' } },
        });
        const betterCount = await this.prisma.player.count({
          where: {
            type: { not: '' },
            level: { gt: player.level || 0 },
          },
        });
        lines.push(`━━━━━━━━━━━━━━━`);
        lines.push(`你的排名: 第${betterCount + 1}/${allCount}名`);
      }
    }

    return lines.join('\n');
  }

  // ==================== 使魔称号 ====================

  /** 称号配置列表 */
  private readonly titleConfigs = [
    { name: '使魔新手', condition: '拥有1个使魔好感度≥25', check: (affinities: Record<string, number>) => Object.values(affinities).filter(a => a >= 25).length >= 1, bonus: '攻击+5' },
    { name: '使魔收藏家', condition: '拥有3个使魔好感度≥25', check: (affinities: Record<string, number>) => Object.values(affinities).filter(a => a >= 25).length >= 3, bonus: '攻击+10，防御+5' },
    { name: '使魔大师', condition: '拥有5个使魔好感度≥25', check: (affinities: Record<string, number>) => Object.values(affinities).filter(a => a >= 25).length >= 5, bonus: '攻击+20，防御+10，速度+5' },
    { name: '挚爱之人', condition: '任意使魔好感度达到100', check: (affinities: Record<string, number>) => Object.values(affinities).some(a => a >= 100), bonus: '全属性+15' },
    { name: '驯服者', condition: '拥有使魔总数≥10', check: (affinities: Record<string, number>) => Object.keys(affinities).length >= 10, bonus: '攻击+10' },
    { name: '百战勇士', condition: '使魔等级达到100级', check: async (prisma: PrismaService, userId: number) => {
      const player = await prisma.player.findUnique({ where: { userId } });
      return player ? (player.level || 0) >= 100 : false;
    }, bonus: '攻击+30，防御+20' },
    { name: '资深驯兽师', condition: '拥有使魔总数≥20', check: (affinities: Record<string, number>) => Object.keys(affinities).length >= 20, bonus: '全属性+25' },
  ];

  /**
   * 领取称号
   * 完成特定条件获得称号
   * @param userId 用户ID
   * @param titleName 称号名称
   * @returns 操作结果文本
   */
  async claimTitle(userId: number, titleName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 查找称号配置
    const titleConfig = this.titleConfigs.find(t => t.name === titleName);
    if (!titleConfig) {
      return `不存在的称号：${titleName}\n可用称号：${this.titleConfigs.map(t => t.name).join('、')}`;
    }

    // 检查是否已拥有该称号
    const titles = this.playerService.safeJsonParse<any[]>(player.titles, []);
    if (titles.some((t: any) => t.name === titleName)) {
      return `你已经拥有称号「${titleName}」了`;
    }

    // 检查条件
    // 收集所有使魔好感度
    const allFamiliars = await this.prisma.gameFamiliar.findMany();
    const affinities: Record<string, number> = {};
    for (const familiar of allFamiliars) {
      const affinityKey = `${familiar.name}好感`;
      const affinity = this.playerService.getMarkerValue(markers, affinityKey);
      if (affinity > 0) {
        affinities[familiar.name] = affinity;
      }
    }

    // 检查条件是否满足
    let conditionMet = false;
    if (typeof titleConfig.check === 'function') {
      // 如果是异步函数（需要prisma参数）
      if (titleConfig.check.length > 1) {
        conditionMet = await (titleConfig.check as any)(this.prisma, userId);
      } else {
        conditionMet = (titleConfig.check as any)(affinities);
      }
    }

    if (!conditionMet) {
      return `条件不满足：${titleConfig.condition}`;
    }

    // 领取称号
    titles.push({ name: titleName, equipped: false });
    player.titles = JSON.stringify(titles);
    await this.playerService.savePlayer(player);

    return `恭喜你获得了称号「${titleName}」！\n效果：${titleConfig.bonus}`;
  }

  /**
   * 佩戴称号
   * 选择当前使用的称号
   * @param userId 用户ID
   * @param titleName 称号名称
   * @returns 操作结果文本
   */
  async equipTitle(userId: number, titleName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const titles = this.playerService.safeJsonParse<any[]>(player.titles, []);

    // 查找称号
    const title = titles.find((t: any) => t.name === titleName);
    if (!title) {
      return `你还没有获得称号「${titleName}」\n请先使用「领取称号」来获取`;
    }

    // 取消所有称号的佩戴状态
    for (const t of titles) {
      t.equipped = false;
    }

    // 佩戴指定称号
    title.equipped = true;
    player.titles = JSON.stringify(titles);
    await this.playerService.savePlayer(player);

    return `已佩戴称号「${titleName}」`;
  }

  /**
   * 查看称号列表
   * 显示所有已获得的称号
   * @param userId 用户ID
   * @returns 称号列表文本
   */
  async viewTitles(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const titles = this.playerService.safeJsonParse<any[]>(player.titles, []);

    if (titles.length === 0) {
      return '你还没有获得任何称号\n使用「查看可领取称号」查看所有可领取的称号';
    }

    const lines = [
      `${player.name || '冒险者'} 的称号列表`,
      `━━━━━━━━━━━━━━━`,
    ];

    for (const title of titles) {
      const equippedMark = title.equipped ? '✅' : '  ';
      const titleConfig = this.titleConfigs.find(t => t.name === title.name);
      const bonus = titleConfig ? titleConfig.bonus : '';
      lines.push(`${equippedMark} ${title.name}${bonus ? `（${bonus}）` : ''}`);
    }

    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`使用「佩戴称号 称号名」来佩戴称号`);

    return lines.join('\n');
  }

  /**
   * 查看可领取的称号
   * @param userId 用户ID
   * @returns 可领取称号列表
   */
  async viewAvailableTitles(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    const ownedTitles = this.playerService.safeJsonParse<any[]>(player.titles, []);
    const ownedNames = new Set(ownedTitles.map((t: any) => t.name));

    // 收集所有使魔好感度
    const allFamiliars = await this.prisma.gameFamiliar.findMany();
    const affinities: Record<string, number> = {};
    for (const familiar of allFamiliars) {
      const affinityKey = `${familiar.name}好感`;
      const affinity = this.playerService.getMarkerValue(markers, affinityKey);
      if (affinity > 0) {
        affinities[familiar.name] = affinity;
      }
    }

    const lines = [
      '📜 可领取的称号',
      `━━━━━━━━━━━━━━━`,
    ];

    for (const config of this.titleConfigs) {
      const owned = ownedNames.has(config.name);
      const status = owned ? '✅ 已领取' : '⏳ 可领取';
      lines.push(`${config.name}${owned ? '' : '（' + config.condition + '）'}`);
      lines.push(`  效果: ${config.bonus} | ${status}`);
    }

    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`使用「领取称号 称号名」来领取称号`);

    return lines.join('\n');
  }

  // ==================== 使魔等级/技能等级 ====================

  /**
   * 使魔升级
   * 获得经验时使魔也获得经验
   * @param userId 用户ID
   * @param exp 获得的经验值
   * @returns 操作结果文本
   */
  async addFamiliarExp(userId: number, exp: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.type) {
      return '你还没有选择使魔';
    }

    // 使魔获得经验（玩家经验的50%）
    const familiarExp = Math.floor(exp * 0.5);

    // 使用技能熟练度标记来存储使魔经验
    const expKey = `${player.type}技能熟练度`;
    const currentExp = this.playerService.getMarkerValue(markers, expKey);
    const newExp = currentExp + familiarExp;

    // 计算等级变化
    const oldLevel = Math.floor(currentExp / 100) + 1;
    const newLevel = Math.floor(newExp / 100) + 1;

    markers[expKey] = newExp;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    let result = `${player.type} 获得了 ${familiarExp} 点经验`;

    if (newLevel > oldLevel) {
      result += `\n🎉 ${player.type} 升级了！Lv.${oldLevel} → Lv.${newLevel}`;
    }

    return result;
  }

  /**
   * 提升技能等级
   * 使用技能提升技能等级，技能等级影响效果
   * @param userId 用户ID
   * @param skillName 技能名称
   * @returns 操作结果文本
   */
  async increaseSkillLevel(userId: number, skillName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.type) {
      return '你还没有选择使魔';
    }

    // 使用技能熟练度标记
    const skillKey = `${player.type}技能熟练度`;
    const currentExp = this.playerService.getMarkerValue(markers, skillKey);
    const currentLevel = Math.floor(currentExp / 100) + 1;

    // 每次使用技能增加10点熟练度
    const newExp = currentExp + 10;
    const newLevel = Math.floor(newExp / 100) + 1;

    markers[skillKey] = newExp;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    let result = `技能「${skillName}」熟练度+10`;

    if (newLevel > currentLevel) {
      result += `\n🎉 技能等级提升！Lv.${currentLevel} → Lv.${newLevel}`;
    }

    // 技能等级影响效果：每级提升2%效果
    result += `\n当前技能等级: Lv.${newLevel}（效果加成: ${(newLevel - 1) * 2}%）`;

    return result;
  }

  // ==================== 使魔专属效果 ====================

  /**
   * 军姬X传送判断
   * 军姬2好感≥20时传送无需消耗
   * 对应原版：军姬X传送判断()
   * @param userId 用户ID
   * @returns 是否可以免费传送
   */
  async canFreeTeleport(userId: number): Promise<boolean> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔是否为军姬2
    if (player.type !== '军姬2') {
      return false;
    }

    // 检查好感度是否≥20
    const affinityKey = '军姬2好感';
    const affinity = this.playerService.getMarkerValue(markers, affinityKey);
    return affinity >= 20;
  }

  /**
   * 普拉娜幼崽剪毛
   * 装备剪刀时自动剪毛
   * 对应原版：普拉娜幼崽剪毛()
   * @param userId 用户ID
   * @returns 操作结果文本
   */
  async shearPlana(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查是否装备了剪刀
    const backpack = this.playerService.getBackpackItems(player);
    const hasScissors = backpack.some((item: any) => item.name === '剪刀');
    if (!hasScissors) {
      return '需要装备「剪刀」才能剪毛';
    }

    // 检查使魔是否为普拉娜幼崽
    if (player.type !== '普拉娜幼崽') {
      return '需要普拉娜幼崽才能剪毛';
    }

    // 检查冷却（每天一次）
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const now = Date.now() / 1000;
    const cooldownMarker = markers2.find((m: any) => m.name === '剪毛');
    if (cooldownMarker && cooldownMarker.expireAt > now) {
      return '剪毛冷却中，每天只能剪一次';
    }

    // 设置冷却
    const newMarkers2 = markers2.filter((m: any) => m.name !== '剪毛');
    newMarkers2.push({
      name: '剪毛',
      expireAt: this.getEndOfDay(now),
    });
    player.markers2 = JSON.stringify(newMarkers2);
    await this.playerService.savePlayer(player);

    // 获得毛发物品
    await this.playerService.addToBackpack(userId, '毛发', 1);

    return '普拉娜幼崽的毛被剪下来了！获得了毛发x1';
  }

  /**
   * 获取当天结束的时间戳
   * @param now 当前时间戳
   * @returns 当天23:59:59的时间戳
   */
  private getEndOfDay(now: number): number {
    const date = new Date(now * 1000);
    date.setHours(23, 59, 59, 999);
    return date.getTime() / 1000;
  }

  /**
   * 纯白之翼自动技能
   * 自动释放使魔技能
   * 对应原版：纯白之翼()
   * @param userId 用户ID
   * @returns 是否自动释放了技能
   */
  async autoCastSkill(userId: number): Promise<boolean> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查是否装备了纯白之翼
    const backpack = this.playerService.getBackpackItems(player);
    if (!backpack.some((item: any) => item.name === '纯白之翼')) {
      return false;
    }

    // 检查技能冷却
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const now = Date.now() / 1000;
    const skillCooldown = markers2.find((m: any) => m.name === `${player.type}技能冷却`);
    if (skillCooldown && skillCooldown.expireAt > now) {
      return false; // 技能冷却中
    }

    // 检查自动训练冷却（5秒间隔）
    const autoTrain = markers2.find((m: any) => m.name === '自动训练');
    if (autoTrain && autoTrain.expireAt > now) {
      return false;
    }

    // 设置自动训练冷却
    const newMarkers2 = markers2.filter((m: any) => m.name !== '自动训练');
    newMarkers2.push({
      name: '自动训练',
      expireAt: now + 5,
    });
    player.markers2 = JSON.stringify(newMarkers2);

    // 自动释放使魔技能
    if (player.uniqueSkill) {
      // 设置技能冷却
      const skillMarkers = newMarkers2.filter((m: any) => m.name !== `${player.type}技能冷却`);
      skillMarkers.push({
        name: `${player.type}技能冷却`,
        expireAt: now + 60,
      });
      player.markers2 = JSON.stringify(skillMarkers);

      // 增加活跃度
      markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
      player.markers = JSON.stringify(markers);
      await this.playerService.savePlayer(player);
    }

    return true;
  }

  /**
   * 兰音技能冷却
   * 冷却核心-10cd，技能等级减cd
   * 对应原版：兰音冷却处理()
   * @param userId 用户ID
   * @param baseCooldown 基础冷却时间（秒）
   * @returns 实际冷却时间（秒）
   */
  async lanyinCooldown(userId: number, baseCooldown: number): Promise<number> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (player.type !== '兰音') {
      return baseCooldown;
    }

    let cooldown = baseCooldown;

    // 检查是否装备了冷却核心（-10秒冷却）
    const backpack = this.playerService.getBackpackItems(player);
    if (backpack.some((item: any) => item.name === '冷却核心')) {
      cooldown -= 10;
    }

    // 技能等级减cd（每级-0.5秒）
    const skillKey = '兰音技能熟练度';
    const skillExp = this.playerService.getMarkerValue(markers, skillKey);
    const skillLevel = Math.floor(skillExp / 100) + 1;
    const levelReduction = Math.floor(skillLevel * 0.5);
    cooldown -= levelReduction;

    // 最低冷却为5秒
    return Math.max(5, cooldown);
  }

  /**
   * 兰音自动释放形神合一
   * 公共冷却为0时自动释放
   * 对应原版：兰音自动释放处理()
   * @param userId 用户ID
   * @returns 是否自动释放了技能
   */
  async autoCastLanyinSkill(userId: number): Promise<boolean> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (player.type !== '兰音') {
      return false;
    }

    // 计算公共冷却
    const skillKey = '兰音技能熟练度';
    const skillExp = this.playerService.getMarkerValue(markers, skillKey);
    const skillLevel = Math.floor(skillExp / 100) + 1;

    // 检查是否装备冷却核心
    const backpack = this.playerService.getBackpackItems(player);
    const hasCoolCore = backpack.some((item: any) => item.name === '冷却核心');

    // 公共冷却判断：有冷却核心时技能等级≥40则冷却为0，否则技能等级≥60则冷却为0
    let canAutoCast = false;
    if (hasCoolCore && skillLevel >= 40) {
      canAutoCast = true;
    } else if (!hasCoolCore && skillLevel >= 60) {
      canAutoCast = true;
    }

    if (!canAutoCast) {
      return false;
    }

    // 自动释放形神合一
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const now = Date.now() / 1000;
    const cooldownMarker = markers2.find((m: any) => m.name === '形神合一');
    if (cooldownMarker && cooldownMarker.expireAt > now) {
      return false; // 形神合一冷却中
    }

    // 设置形神合一冷却
    const newMarkers2 = markers2.filter((m: any) => m.name !== '形神合一');
    newMarkers2.push({
      name: '形神合一',
      expireAt: now + 60,
    });
    player.markers2 = JSON.stringify(newMarkers2);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return true;
  }

  /**
   * 战斗女仆技能
   * RPG/机枪/震撼弹/云爆弹
   * 对应原版：战斗女仆武器技能()
   * @param userId 用户ID
   * @param weaponType 武器类型（rpg/machinegun/flashbang/thermobaric）
   * @returns 操作结果文本
   */
  async battleMaidSkill(userId: number, weaponType: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (player.type !== '战斗女仆') {
      return '需要战斗女仆才能使用此技能';
    }

    // 检查冷却
    const cooldownName = `战斗女仆_${weaponType}`;
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const now = Date.now() / 1000;
    const cooldownMarker = markers2.find((m: any) => m.name === cooldownName);
    if (cooldownMarker && cooldownMarker.expireAt > now) {
      const remaining = Math.ceil(cooldownMarker.expireAt - now);
      return `技能冷却中，剩余${remaining}秒`;
    }

    // 获取好感度
    const affinity = this.playerService.getMarkerValue(markers, '战斗女仆好感');
    const effect = this.getSkillEffect(affinity);

    let result = '';
    let cooldown = 120;
    let damage = 0;

    switch (weaponType) {
      case 'rpg':
        cooldown = 180;
        damage = Math.floor(300 + affinity * 2 * effect);
        result = `战斗女仆发射RPG！\n对目标造成 ${damage} 点爆炸伤害（冷却3分钟）`;
        break;
      case 'machinegun':
        cooldown = 60;
        damage = Math.floor(80 + affinity * 0.5 * effect);
        result = `战斗女仆端起机枪扫射！\n对目标造成 ${damage} 点伤害（冷却1分钟）`;
        break;
      case 'flashbang':
        cooldown = 120;
        const stunDuration = Math.floor(3 + 2 * effect);
        result = `战斗女仆投出震撼弹！\n目标被眩晕 ${stunDuration} 秒（冷却2分钟）`;
        break;
      case 'thermobaric':
        cooldown = 300;
        damage = Math.floor(500 + affinity * 3 * effect);
        result = `战斗女仆释放云爆弹！\n对全体敌人造成 ${damage} 点巨额伤害（冷却5分钟）`;
        break;
      default:
        return `未知武器类型：${weaponType}，可用类型：rpg、machinegun、flashbang、thermobaric`;
    }

    // 设置冷却
    const newMarkers2 = markers2.filter((m: any) => m.name !== cooldownName);
    newMarkers2.push({
      name: cooldownName,
      expireAt: now + cooldown,
    });
    player.markers2 = JSON.stringify(newMarkers2);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return result;
  }

  /**
   * 恶毒好感度效果
   * 好感≥60全体攻击变溅射
   * 对应原版：恶毒溅射判断()
   * @param userId 用户ID
   * @returns 是否触发溅射效果
   */
  async venomSplash(userId: number): Promise<boolean> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (player.type !== '恶毒') {
      return false;
    }

    // 检查好感度是否≥60
    const affinityKey = '恶毒好感';
    const affinity = this.playerService.getMarkerValue(markers, affinityKey);
    if (affinity < 60) {
      return false;
    }

    // 好感≥60时全体攻击变溅射
    return true;
  }

  /**
   * 伊卡洛斯歼灭模式
   * 额外攻击+3
   * 对应原版：伊卡洛斯额外攻击()
   * @param userId 用户ID
   * @returns 额外攻击次数
   */
  async icalusExtraAttack(userId: number): Promise<number> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (player.type !== '伊卡洛斯') {
      return 0;
    }

    // 检查是否处于歼灭模式
    const buffs = this.playerService.safeJsonParse<any[]>(player.buffs, []);
    const inAnnihilationMode = buffs.some((b: any) => b.name === '歼灭模式');
    if (!inAnnihilationMode) {
      return 0;
    }

    // 额外攻击+3
    return 3;
  }

  /**
   * 普拉娜武器显示
   * 攻击时显示武器名
   * 对应原版：普拉娜武器显示()
   * @param userId 用户ID
   * @returns 武器名称文本
   */
  async planaWeaponDisplay(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (player.type !== '普拉娜') {
      return '';
    }

    // 获取当前武器
    const backpack = this.playerService.getBackpackItems(player);
    const weapons = backpack.filter((item: any) => item.type === '武器' || item.name.includes('枪') || item.name.includes('炮'));

    if (weapons.length === 0) {
      return '';
    }

    // 随机选择一个武器显示
    const weapon = weapons[Math.floor(Math.random() * weapons.length)];
    return `（${weapon.name}）`;
  }
}