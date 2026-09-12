/**
 * 商店/交易/逆向指令域服务（game 模块化重构 P2-8 抽出）
 *
 * 职责：交易（含家园交易，withTradeLock 读改写窗口串行化）、商店/活跃商店/
 * 钻石商店/数据商店/自动购物、赠予、行商（呼叫/购买门槛/库存生成）、
 * 配方与配方解锁、逆向（查询/单项/全部/结算展示）。
 * 依赖方向：依赖 Player、Prisma、Task、StaticData、Map、FamiliarSystemService、
 * Achievement、Item、ItemSystem、Home、支撑层（getCurrentMap/round2Text/
 * itemName/itemType/itemQuantity/deductBackpackItem 等）；过渡期经门面引用
 * 触达 fusion 域的 isFusionWeapon（已拆出 FusionCraftService，可后续直改注入）。
 * 单一真相源：库存生成统一 buildMerchantInventory（schedule.service 同源调用）；
 * 背包扣减/累加统一支撑层出口；货币读写统一 PlayerService 入口。
 * 对口原版：_主程序.ecode 商店/行商/逆向分支。
 *
 * 状态字段（§4.1 归属表，随本批迁出）：tradeLocks（交易串行化锁）。
 */import { Injectable, Logger } from '@nestjs/common';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { lookupFromStaticData, mergeBackpackItem } from '.././item-normalize.util';
import { toExpireMs } from '.././expire-time.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlayerService } from '.././player.service';
import { ItemService } from '.././item.service';
import { MapService } from '.././map.service';
import { AchievementService } from '.././achievement.service';
import { ItemSystemService } from '.././item-system.service';
import { HomeService } from '.././home.service';
import { FamiliarSystemService } from '.././familiar-system.service';
import { StaticDataService } from '.././static-data.service';
import { TaskService } from '.././task.service';
import { GameSupportService } from '.././game-support.service';
import { GameService } from '.././game.service';

@Injectable()
export class ShopTradeService {
  private readonly logger = new Logger(ShopTradeService.name);

  /**
   * 过渡期门面引用：仅用于触达尚未迁出的跨域方法（对应组拆出后改为直接注入）。
   * 由 GameService.onModuleInit 注入（构造后赋值，不构成 DI 环）。
   */
  private facade?: GameService;

  /** GameService.onModuleInit 注入门面引用。 */
  attachFacade(facade: GameService): void {
    this.facade = facade;
  }

  constructor(
    private readonly support: GameSupportService,
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly itemService: ItemService,
    private readonly mapService: MapService,
    private readonly achievementService: AchievementService,
    private readonly itemSystemService: ItemSystemService,
    private readonly homeService: HomeService,
    private readonly familiarSystemService: FamiliarSystemService,
    private readonly staticData: StaticDataService,
    private readonly taskService: TaskService,
  ) {}

  async withTradeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tradeLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tradeLocks.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tradeLocks.get(key) === tail) this.tradeLocks.delete(key);
    }
  }

  /**
   * 执行原版家园贸易：在他人家园院子中消耗10活力，双方获得对方家园每日正产出的2%。
   * 电力不参与贸易；“银”在被贸易家园中时会把小于1的正产出提升到1。
   */

  async handleTrade(userId: number, action: string, args: string[]): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 原版“贸易”在玩家家园院子中是家园贸易；市场功能保留为普通地图上的贸易子命令。
    // 支持显式“贸易 交易”，无参数在他人家园院子中也直接执行原版贸易。
    const homeTradeRequested = ['交易', 'home', 'home-trade'].includes(String(action || '').trim().toLowerCase());
    if (!action || homeTradeRequested) {
      const currentMap = await this.support.getCurrentMap(userId).catch(() => null);
      const restrictedHomeMap = Boolean(
        currentMap?.isInstance || /(?:屋内|前线)$/.test(String(currentMap?.name || '')),
      );
      const owner = currentMap?.name
        ? await this.prisma.player.findFirst({ where: { houseName: currentMap.name } })
        : null;
      if (homeTradeRequested || owner || restrictedHomeMap) {
        if (!owner || owner.userId === userId || restrictedHomeMap) {
          return `${player.name || '冒险者'}去到别人家院子里，再次发送“贸易”即可与对方贸易\n每次消耗10活力，每个玩家你一天只能与对方贸易一次`;
        }
        return this.handleHomeTrade(userId, owner.userId, currentMap.name);
      }
    }

    // 获取用户QQ号
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userQQ = user?.qqNumber || '';

    // 如果没有指定操作，显示市场列表
    if (!action) {
      // 查询所有在售商品（未过期的）
      const now = new Date();
      const listings = await this.prisma.gameShopItem.findMany({
        where: { expireAt: { gte: now } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      if (listings.length === 0) {
        return '📊 贸易市场\n━━━━━━━━━━━━━━━\n当前没有在售的商品\n\n上架物品：贸易 上架 物品名 价格\n下架物品：贸易 下架 编号\n购买物品：贸易 购买 编号';
      }

      const lines = [
        `📊 贸易市场 (${listings.length}件商品)`,
        `━━━━━━━━━━━━━━━`,
      ];
      for (let i = 0; i < listings.length; i++) {
        const item = listings[i];
        lines.push(`  ${i + 1}. ${item.itemName} ×${item.itemCount}`);
        lines.push(`     价格: ${item.price} | 卖家: ${item.sellerQQ}`);
      }
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`上架物品：贸易 上架 物品名 价格`);
      lines.push(`下架物品：贸易 下架 编号`);
      lines.push(`购买物品：贸易 购买 编号`);

      return lines.join('\n');
    }

    // 处理各操作
    switch (action) {
      case '上架':
      case 'sell': {
        if (args.length < 2) {
          return '请指定物品名称和价格，格式：贸易 上架 物品名 价格';
        }
        const itemName = args[0];
        const price = parseFloat(args[1]);
        if (isNaN(price) || price <= 0) {
          return '价格必须为正数';
        }

        // 检查背包中是否有该物品
        const backpack = this.playerService.getBackpackItems(player);
        const item = backpack.find((i: any) => i.name === itemName);
        if (!item) {
          return `背包中没有【${itemName}】`;
        }

        const count = item.count || item.quantity || 1;

        // 从背包移除物品
        const removed = await this.playerService.removeFromBackpack(userId, itemName, 1);
        if (!removed) {
          return '上架失败，请重试';
        }

        // 创建商品记录（7天后过期）
        const expireAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await this.prisma.gameShopItem.create({
          data: {
            itemName,
            itemType: 'trade',
            itemCount: 1,
            sellerQQ: userQQ,
            price,
            expireAt,
          },
        });

        this.logger.log(`玩家 ${userId} 上架了 ${itemName}，价格 ${price}`);
        await this.taskService.advance(userId, '贸易');
        return `✅ 成功上架 ${itemName}\n价格: ${price}\n商品将在7天后自动下架`;
      }

      case '下架':
      case 'cancel':
      case 'remove': {
        if (args.length < 1) {
          return '请指定要下架的商品编号，格式：贸易 下架 编号';
        }
        const index = parseInt(args[0], 10) - 1;
        if (isNaN(index) || index < 0) {
          return '请指定有效的商品编号';
        }

        // 查询当前玩家的在售商品
        const now = new Date();
        const myListings = await this.prisma.gameShopItem.findMany({
          where: {
            sellerQQ: userQQ,
            expireAt: { gte: now },
          },
          orderBy: { createdAt: 'desc' },
        });

        if (index >= myListings.length) {
          return '商品编号无效';
        }

        const targetItem = myListings[index];

        // 将物品归还背包
        await this.playerService.addToBackpack(userId, targetItem.itemName, targetItem.itemCount);

        // 删除商品记录
        await this.prisma.gameShopItem.delete({
          where: { id: targetItem.id },
        });

        this.logger.log(`玩家 ${userId} 下架了 ${targetItem.itemName}`);
        await this.taskService.advance(userId, '贸易');
        return `✅ 已下架 ${targetItem.itemName}，物品已归还背包`;
      }

      case '购买':
      case 'buy': {
        if (args.length < 1) {
          return '请指定要购买的商品编号，格式：贸易 购买 编号';
        }
        const buyIdx = parseInt(args[0], 10) - 1;
        if (isNaN(buyIdx) || buyIdx < 0) {
          return '请指定有效的商品编号';
        }

        // 查询所有在售商品
        const now2 = new Date();
        const allListings = await this.prisma.gameShopItem.findMany({
          where: { expireAt: { gte: now2 } },
          orderBy: { createdAt: 'desc' },
        });

        if (buyIdx >= allListings.length) {
          return '商品编号无效';
        }

        const buyItem = allListings[buyIdx];

        // 不能购买自己的商品
        if (buyItem.sellerQQ === userQQ) {
          return '不能购买自己的商品';
        }

        // 将物品添加到买家背包
        await this.playerService.addToBackpack(userId, buyItem.itemName, buyItem.itemCount);

        // 删除商品记录
        await this.prisma.gameShopItem.delete({
          where: { id: buyItem.id },
        });

        // 通知卖家（通过记录日志）
        this.logger.log(`玩家 ${userId} 购买了 ${buyItem.itemName}（卖家: ${buyItem.sellerQQ}）`);

        await this.taskService.advance(userId, '贸易');
        return `✅ 购买成功！\n获得了 ${buyItem.itemName} ×${buyItem.itemCount}\n花费: ${buyItem.price}`;
      }

      default:
        return `未知操作「${action}」，可用操作：上架、下架、购买`;
    }
  }

  /** 串行化同一对玩家的家园贸易，避免并发指令重复消耗活力或发奖。 */

  async handleHomeTrade(
    userId: number,
    targetUserId: number,
    targetMapName: string,
  ): Promise<string> {
    const lockKey = [userId, targetUserId].sort((a, b) => a - b).join(':');
    return this.withTradeLock(`home-trade:${lockKey}`, async () => {
      const actorData = await this.playerService.getPlayerData(userId);
      const actor = actorData.player;
      const actorMap = await this.mapService.getMapById(actor.mapId);
      const target = await this.prisma.player.findUnique({ where: { userId: targetUserId } });
      if (!target) return '贸易对象不存在';
      if (!actorMap || actorMap.name !== targetMapName || actorMap.name !== target.houseName) {
        return '请先去到对方家园院子里再进行贸易';
      }
      if (actorMap.isInstance || /(?:屋内|前线)$/.test(String(actorMap.name || ''))) {
        return '屋内或家园前线不能进行贸易，请回到对方家园院子';
      }
      if (targetUserId === userId) return '不能和自己的家园贸易';
        { const __dt = await this.playerService.deathGateText(actor); if (__dt) return __dt; }
      if (Number(actor.vitality || 0) < 10) return `${actor.name || '冒险者'}你的剩余活力不足10`;

      // 先观测目标家园，刷新电力状态和每日产出缓存；被贸易者不会减少产出物。
      await this.homeService.collectHomeOutput(targetUserId);
      const observedMap = await this.mapService.getMapByName(targetMapName).catch(() => null);
      if (!observedMap) return `家园地图「${targetMapName}」不存在`;

      const mapMarkers = asJsonValue<any>(observedMap.markers, {});
      const readMarker = (name: string): any => {
        if (Array.isArray(mapMarkers)) {
          const marker = mapMarkers.find((item: any) => (item?.name ?? item?.名称) === name);
          return marker?.value ?? marker?.数值 ?? marker?.count ?? 0;
        }
        return mapMarkers?.[name];
      };
      if (Number(readMarker('有电') || 0) !== 1) {
        return `${actor.name || '冒险者'},${targetMapName}断电啦！没法再与你贸易了。`;
      }

      const targetUser = await this.prisma.user.findUnique({ where: { id: targetUserId } });
      const targetIdentity = String(targetUser?.qqNumber || targetUser?.externalId || targetUserId);
      const tradeKey = `贸易${targetIdentity}`;
      const nowMs = Date.now();
      const nowSec = nowMs / 1000;
      const markers2 = asJsonValue<any[]>(actor.markers2, []);
      let activeCooldown = 0;
      const validMarkers = markers2.filter((marker: any) => {
        const markerName = marker?.name ?? marker?.名称 ?? marker?.key;
        const rawExpire = Number(marker?.expireAt ?? marker?.有效期至 ?? 0);
        const expireSec = rawExpire > 1e12 ? rawExpire / 1000 : rawExpire;
        if (markerName === tradeKey && expireSec > nowSec) activeCooldown = expireSec;
        return !markerName || markerName !== tradeKey || expireSec <= nowSec;
      });
      if (activeCooldown > nowSec) {
        return `${actor.name || '冒险者'}今天已经和${target.name || '对方'}贸易过了，明天才能再次贸易`;
      }

      const rawOutput = readMarker('每日产出');
      const outputItems = Array.isArray(rawOutput)
        ? rawOutput
        : rawOutput && typeof rawOutput === 'object'
          ? Object.entries(rawOutput).map(([name, quantity]) => ({ name, quantity }))
          : [];
      const summons = this.support.parseJsonArray(observedMap.summons);
      const hasSilver = summons.some((unit: any) =>
        (unit?.name ?? unit?.名称 ?? unit?.type ?? unit?.类型) === '银',
      );
      const tradeItems = new Map<string, number>();
      for (const item of outputItems) {
        const name = String(item?.name ?? item?.名称 ?? '');
        const dailyQuantity = Number(item?.quantity ?? item?.count ?? item?.数量 ?? 0);
        if (!name || name === '电力' || !Number.isFinite(dailyQuantity) || dailyQuantity <= 0) continue;
        let amount = dailyQuantity * 0.02;
        if (hasSilver && amount > 0 && amount < 1) amount = 1;
        tradeItems.set(name, (tradeItems.get(name) || 0) + amount);
      }

      const targetData = await this.playerService.getPlayerData(targetUserId);
      const addItem = (backpack: any[], name: string, amount: number): void => {
        // 入包走唯一出口（按名合并 / type 以静态定义为唯一真源 / 两位小数收敛）
        mergeBackpackItem(
          backpack,
          { name, count: amount, quantity: amount },
          lookupFromStaticData(this.staticData),
        );
      };
      for (const [name, amount] of tradeItems) {
        addItem(actorData.backpack, name, amount);
        addItem(targetData.backpack, name, amount);
      }

      const tomorrow = new Date(nowMs);
      tomorrow.setHours(24, 0, 0, 0);
      validMarkers.push({ name: tradeKey, expireAt: tomorrow.getTime() / 1000 });
      actor.vitality = Number(actor.vitality || 0) - 10;
      actor.markers2 = validMarkers; // Json 列直接写数组
      actor.backpack = actorData.backpack;
      targetData.player.backpack = targetData.backpack;
      await Promise.all([
        this.playerService.savePlayer(actor),
        this.playerService.savePlayer(targetData.player),
      ]);

      await this.taskService.advance(userId, '消耗活力', 10);
      await this.taskService.advance(userId, '贸易');
      await this.taskService.advance(targetUserId, '贸易');

      const itemText = Array.from(tradeItems.entries())
        .map(([name, amount]) => `${name}x${this.support.round2Text(amount)}`)
        .join('、');
      const silverText = hasSilver ? '\n银：贸易所得中小于1的正产出已提升到1' : '';
      return `${actor.name || '冒险者'}和${target.name || '对方'}都得到了${itemText || '对方家园的正产出（本次为0）'}${silverText}`;
    });
  }

  /**
   * 处理购物命令
   * 对应原版：_主程序.ecode L9892-10088。
   * 行商是地图召唤物，不是静态 NPC；价格和赠品概率逐字沿用原版公式。
   */

  async handleShop(userId: number, action: string, args: string[]): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    const map = await this.support.getCurrentMap(userId);
    const merchantInfo = this.findMerchantInSummons(map);
    if (!merchantInfo) {
      return `${player.name}附近没有“行商”，无法购物`;
    }

    const { summons, index: merchantIndex } = merchantInfo;
    const merchant = summons[merchantIndex];
    const merchantBackpack = this.support.parseJsonArray(merchant.backpack);
    const requested = [action || '', ...(args || [])].join(' ').trim();
    const numeric = requested.match(/\d+/);
    const requestedNumber = numeric ? Number(numeric[0]) : 0;
    const isDetail = /^(查看|detail|info)/i.test(requested);
    const isPurchase = /^(购买|buy)/i.test(requested);
    const indexByName = !numeric && (isPurchase || isDetail)
      ? merchantBackpack.findIndex((item: any) => (item?.name || item?.名称) === requested.replace(/^(购买|查看|buy|detail|info)\s*/i, '').trim()) + 1
      : 0;
    const itemIndex = indexByName || requestedNumber;
    const numericPurchase = !isDetail && !isPurchase && requestedNumber > 0;

    // 原版 a<1 或超出库存时显示列表；行商为空时显示原版售罄文案。
    if (isDetail && itemIndex >= 1 && itemIndex <= merchantBackpack.length) {
      const item = merchantBackpack[itemIndex - 1];
      return `${player.name}#换行${this.formatMerchantItem(item)}#换行1、购买#z9#z92、返回`;
    }
    if ((isPurchase || numericPurchase) && itemIndex >= 1 && itemIndex <= merchantBackpack.length) {
      const houseMap = player.houseName ? await this.mapService.getMapByName(player.houseName) : null;
      const purchaseGate = this.checkMerchantPurchaseGate(player, map, houseMap);
      if (purchaseGate.blocked) {
        return `${player.name}${purchaseGate.message}`;
      }
      if (purchaseGate.markers2Changed) {
        player.markers2 = purchaseGate.markers2; // Json 列直接写数组
        await this.playerService.savePlayer(player);
      }
      return this.purchaseMerchantItem(userId, player, markers, map, summons, merchantIndex, merchantBackpack, itemIndex - 1);
    }

    if (merchantBackpack.length === 0) {
      return `行商#换行我的东西都卖完了，请下个整点再来吧。`;
    }

    const shopSkill = this.achievementService.getAchievement(markers, '购物');
    const affinity = 10 + shopSkill / 100;
    const priceRate = 1 - affinity / (100 + affinity);
    const levelFactor = (player.level || 1) / 10 + 1;
    const lines = [
      `行商#换行${player.name}有你喜欢的吗？`,
      `好感${affinity}(优惠${this.support.round2Text(affinity / (100 + affinity) * 100)}%)`,
      `◆购买需要${this.support.round2Text(priceRate * levelFactor * 50)}木头、${this.support.round2Text(priceRate * levelFactor * 40)}石头、${this.support.round2Text(priceRate * levelFactor * 30)}铁矿、${this.support.round2Text(priceRate * levelFactor * 30)}绳子`,
    ];
    merchantBackpack.forEach((item: any, itemNumber: number) => {
      lines.push(`${itemNumber + 1}、${this.formatMerchantItem(item, true)}`);
    });
    return lines.join('\n');
  }

  /**
   * 处理求助命令
   * 求助系统，向世界频道发送求助信息
   * 对应原版：求助 命令
   */

  async handleActivityShop(userId: number, itemName: string): Promise<string> {
    return itemName
      ? this.familiarSystemService.exchange(userId, itemName)
      : this.familiarSystemService.familiarShop(userId, 'activity');
  }

  /**
   * 钻石商店
   * 对应原版：钻石商店 命令
   */

  async handleDiamondShop(userId: number, itemName: string): Promise<string> {
    return itemName
      ? this.familiarSystemService.exchange(userId, itemName)
      : this.familiarSystemService.familiarShop(userId, 'diamond');
  }

  /**
   * 数据商店
   * 对应原版：数据商店 命令
   */

  async handleDataShop(userId: number, itemName: string): Promise<string> {
    return itemName
      ? this.familiarSystemService.exchange(userId, itemName)
      : this.familiarSystemService.familiarShop(userId, 'dataCore');
  }

  /**
   * 探测雷达
   * 对应原版：探测雷达（_主程序.ecode L3013-L3274）
   * 根据探测雷达等级扫描副本入口、货舱、能量元素等地图信息
   */

  async handleAutoShop(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    const map = await this.support.getCurrentMap(userId);
    const merchantInfo = this.findMerchantInSummons(map);
    if (!merchantInfo) {
      return `${player.name}附近没有“行商”，无法购物`;
    }

    const keywordStr = (markers['自动购物'] !== undefined && typeof markers['自动购物'] === 'string')
      ? markers['自动购物']
      : '';
    if (!keywordStr) {
      return `${player.name}你未设置自动购物的对象`;
    }

    const keywords = keywordStr.split('、').map((k: string) => k.trim()).filter(Boolean);
    const houseMap = player.houseName ? await this.mapService.getMapByName(player.houseName) : null;
    if (!houseMap || houseMap.id !== map.id) {
      return `${player.name}只能在自己院子里使用这个功能`;
    }

    const { summons, index: merchantIdx } = merchantInfo;
    const merchant = summons[merchantIdx];
    const merchantBackpack = this.support.parseJsonArray(merchant.backpack);

    const backpack = this.playerService.getBackpackItems(player);
    const boughtItems: any[] = [];
    const paidItems: any[] = [];
    const gifts: any[] = [];
    let matched = false;
    let resourceShortage = false;
    const shopSkill = this.achievementService.getAchievement(markers, '购物') || 0;
    const a2 = 10 + shopSkill / 100;
    const priceRate = 1 - a2 / (100 + a2);
    const levelFactor = (player.level || 1) / 10 + 1;
    const costs = [
      { name: '木头', quantity: 50 * priceRate * levelFactor },
      { name: '石头', quantity: 40 * priceRate * levelFactor },
      { name: '绳子', quantity: 30 * priceRate * levelFactor },
      { name: '铁矿', quantity: 30 * priceRate * levelFactor },
    ];

    // 原版从背包尾部向前检查，资源不足时停止后续购买。
    for (let d = merchantBackpack.length - 1; d >= 0; d--) {
      const mItem = merchantBackpack[d];
      const displayName = this.formatMerchantItem(mItem, true);
      if (!keywords.some((keyword) => displayName.includes(keyword))) continue;
      matched = true;

      if (!this.hasEnoughResources(backpack, costs)) {
        resourceShortage = true;
        break;
      }
      for (const cost of costs) {
        this.support.deductBackpackItem(backpack, cost.name, cost.quantity);
        this.support.addItemToCollection(paidItems, { ...cost, type: '资源' });
      }

      const bought = { ...mItem };
      merchantBackpack.splice(d, 1);
      this.support.addItemToCollection(backpack, bought);
      boughtItems.push(bought);

      const giftChance = Math.min(a2 / 4, 15);
      if (Math.random() * 100 < giftChance) {
        const gift = this.generateMerchantResource();
        this.support.addItemToCollection(backpack, gift);
        this.support.addItemToCollection(gifts, gift);
      }
    }

    // 原版以“实际购买的物品数组”是否为空决定“没有匹配的物品”；
    // 首件匹配但资源不足时也走这个分支，而不是输出空的购买清单。
    if (!matched || boughtItems.length === 0) {
      return `${player.name}没有匹配的物品`;
    }

    const purchasedCount = boughtItems.length;
    if (purchasedCount > 0) {
      this.achievementService.setAchievement(markers, '购物', shopSkill + purchasedCount);
      player.markers = markers;
    }
    player.backpack = backpack; // Json 列直接写数组
    merchant.backpack = merchantBackpack; // Json 列直接写数组
    summons[merchantIdx] = merchant;
    await this.mapService.updateDynamicFields(map.id, { summons });
    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, '购物', purchasedCount);

    const paidDesc = this.formatMerchantItems(paidItems);
    let result = `${player.name}花费${paidDesc}购买了${this.formatMerchantItems(boughtItems)}`;
    if (gifts.length > 0) {
      result += `#换行行商额外赠送了${this.formatMerchantItems(gifts)}`;
    }
    if (resourceShortage) {
      result += '#换行有资源不足以购买全部匹配的物品';
    }
    return result;
  }

  /** 读取行商召唤物；原版购物不会读取地图 npcs。 */

  async handleGive(userId: number, targetQQ: string, itemName: string, count: number): Promise<string> {
    if (!targetQQ || !itemName) {
      return '请指定目标QQ和物品名称，格式：赠予 QQ号 物品名 [数量]';
    }

    // 查找目标用户
    const targetUser = await this.prisma.user.findUnique({
      where: { qqNumber: targetQQ },
    });
    if (!targetUser) {
      return `未找到QQ号为 ${targetQQ} 的用户`;
    }

    // 不能赠送给自己
    if (targetUser.id === userId) {
      return '不能赠送物品给自己';
    }

    // 查找目标玩家
    const targetPlayer = await this.prisma.player.findUnique({
      where: { userId: targetUser.id },
    });
    if (!targetPlayer) {
      return `目标玩家 ${targetQQ} 还未创建角色`;
    }

    // 检查发送者是否有足够物品
    const senderData = await this.playerService.getPlayerData(userId);
    const { player } = senderData;
    const senderItems = this.playerService.getBackpackItems(player);

    const senderItem = senderItems.find((item: any) => item.name === itemName);
    if (!senderItem) {
      return `你的背包中没有【${itemName}】`;
    }

    const actualCount = Math.min(count, senderItem.count || senderItem.quantity || 1);
    if (actualCount <= 0) {
      return `数量无效`;
    }

    // 从发送者背包移除
    const removed = await this.playerService.removeFromBackpack(userId, itemName, actualCount);
    if (!removed) {
      return `移除物品失败`;
    }

    // 添加到目标背包
    const added = await this.playerService.addToBackpack(targetUser.id, itemName, actualCount);
    if (!added) {
      // 回滚：将物品加回发送者背包
      await this.playerService.addToBackpack(userId, itemName, actualCount);
      return `赠送失败，请重试`;
    }

    this.logger.log(`玩家 ${userId} 赠送了 ${itemName} ×${actualCount} 给 ${targetQQ}`);

    return `成功将 ${itemName} ×${actualCount} 赠予给 ${targetUser.nickname || targetQQ}`;
  }

  /**
   * 处理私聊指令（指令通道）
   * 格式：私聊 用户名/昵称/ID 消息内容
   * 将消息持久化到 PrivateMessage 并通过 Socket 实时推送给对方
   * 对应原版：私聊 命令
   */

  findMerchantInSummons(map: any): { summons: any[]; index: number } | null {
    if (!map) return null;
    const summons = this.support.parseJsonArray(map.summons);
    const index = summons.findIndex((summon: any) =>
      (summon?.name ?? summon?.名称) === '行商',
    );
    return index < 0 ? null : { summons, index };
  }


  checkMerchantPurchaseGate(
    player: any,
    map: any,
    houseMap: any,
  ): { blocked: boolean; message: string; markers2: any[]; markers2Changed: boolean } {
    const markers2 = this.support.parseJsonArray(player.markers2);
    const ownHouse = Boolean(houseMap && houseMap.id === map.id);
    const hasAnotherHome = Boolean(map?.isFrontier && player.houseName && houseMap && !ownHouse);
    if (hasAnotherHome) {
      return {
        blocked: true,
        message: '她现在不卖东西给你(别人家里)',
        markers2,
        markers2Changed: false,
      };
    }

    if (ownHouse) {
      return { blocked: false, message: '', markers2, markers2Changed: false };
    }

    const now = Date.now();
    let changed = false;
    let activeExpire = 0;
    for (let i = markers2.length - 1; i >= 0; i--) {
      const marker = markers2[i];
      const name = marker?.名称 ?? marker?.name ?? '';
      const expireMs = toExpireMs(marker);
      if (expireMs <= now && !String(name).startsWith('刷新')) {
        markers2.splice(i, 1);
        changed = true;
        continue;
      }
      if (name === '购买冷却' && expireMs > now) {
        activeExpire = Math.max(activeExpire, expireMs);
      }
    }

    if (activeExpire > now) {
      const remaining = Math.max(1, Math.ceil((activeExpire - now) / 1000));
      return {
        blocked: true,
        message: `还需要${remaining}秒`,
        markers2,
        markers2Changed: changed,
      };
    }

    markers2.push({ name: '购买冷却', expireAt: now + 10 * 1000 });
    return { blocked: false, message: '', markers2, markers2Changed: true };
  }


  formatMerchantItem(item: any, includeQuantity = false, includeEffect = true): string {
    const name = item?.name ?? item?.名称 ?? '';
    let effect = '';
    if ((item?.type ?? item?.类型) === '装备' && item?.data) {
      const parsed = this.itemService.parseEquipment(item as any);
      if (parsed.specialEffect > 0) {
        const weapon = this.facade!.isFusionWeapon(item);
        const effectRow = typeof (this.staticData as any).getEffectById === 'function'
          ? (this.staticData as any).getEffectById(parsed.specialEffect, weapon)
          : (weapon
            ? this.staticData.getAllEffects().filter((row: any) => !row?.limit || row.limit === '武器')
            : this.staticData.getAllEffects().filter((row: any) => !row?.limit || row.limit === '装备'))[parsed.specialEffect - 1];
        effect = effectRow?.name || effectRow?.description || `特效${parsed.specialEffect}`;
      }
    }
    if ((item?.type ?? item?.类型) === '装备') {
      return `${name}${includeEffect && effect ? `【${effect}】` : ''}`;
    }
    return `${name}${includeQuantity ? `x${this.support.round2Text(this.support.itemQuantity(item))}` : ''}`;
  }


  formatMerchantItems(items: any[]): string {
    return (items || []).map((item) => this.formatMerchantItem(item, true)).join('、');
  }


  hasEnoughResources(backpack: any[], costs: any[]): boolean {
    return costs.every((cost) => {
      const item = backpack.find((entry: any) => (entry?.name ?? entry?.名称) === cost.name);
      // 原版按双精度数值比较；容忍 JS 二进制浮点在 50*10/11*1.1 等边界上的极小误差。
      const epsilon = Math.max(1e-9, Math.abs(cost.quantity) * 1e-12);
      return item && this.support.itemQuantity(item) + epsilon >= cost.quantity;
    });
  }


  generateMerchantResource(): any {
    const config = this.staticData.getMerchantConfig();
    const candidates = String(config.itemText || '').split(/[，,]/).map((value) => value.trim()).filter(Boolean);
    const raw = candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : '';
    const match = raw.match(/\d+(?:\.\d+)?/);
    const quantity = match ? Math.trunc(Number(match[0])) || 1 : 1;
    const name = raw.replace(/\d/g, '').trim() || raw;
    return { name, type: '资源', quantity, durability: 0, data: '' };
  }


  async generateMerchantInventory(level: number, extra: number): Promise<any[]> {
    const config = this.staticData.getMerchantConfig();
    const equipmentPool = String(config.equipmentText || '').split(/[，,]/).map((value) => value.trim()).filter(Boolean);
    const inventory: any[] = [];
    const times = Math.max(1, Math.trunc(level || 0));
    for (let i = 0; i < 3 * times; i++) {
      const name = equipmentPool.length > 0
        ? equipmentPool[Math.floor(Math.random() * equipmentPool.length)]
        : '';
      if (!name) continue;
      inventory.push(await this.itemSystemService.generateMerchantEquipment(name, name === '汪酱'));
    }
    for (let i = 0; i < Math.max(0, 3 * times + Math.trunc(extra || 0)); i++) {
      inventory.push(this.generateMerchantResource());
    }
    return inventory;
  }

  /**
   * 公开接口：为行商生成物品库存（装备+资源），供 ScheduleService 调用。
   * 对齐原版 后台运作.ecode L1228 生成行商物品(g.背包)。
   * @param level 行商等级（默认1），决定装备/资源数量
   * @param extra 资源额外数量（默认0）
   * @returns 物品数组
   */

  async buildMerchantInventory(level = 1, extra = 0): Promise<any[]> {
    return this.generateMerchantInventory(level, extra);
  }


  async purchaseMerchantItem(
    userId: number,
    player: any,
    markers: any,
    map: any,
    summons: any[],
    merchantIndex: number,
    merchantBackpack: any[],
    itemIndex: number,
  ): Promise<string> {
    const shopSkill = this.achievementService.getAchievement(markers, '购物');
    const affinity = 10 + shopSkill / 100;
    const priceRate = 1 - affinity / (100 + affinity);
    const levelFactor = (player.level || 1) / 10 + 1;
    const costs = [
      { name: '木头', quantity: 50 * priceRate * levelFactor },
      { name: '石头', quantity: 40 * priceRate * levelFactor },
      { name: '绳子', quantity: 30 * priceRate * levelFactor },
      { name: '铁矿', quantity: 30 * priceRate * levelFactor },
    ];
    const backpack = this.playerService.getBackpackItems(player);
    if (!this.hasEnoughResources(backpack, costs)) {
      const missing = costs
        .filter((cost) => {
          const item = backpack.find((entry: any) => (entry?.name ?? entry?.名称) === cost.name);
          return !item || this.support.itemQuantity(item) < cost.quantity;
        })
        .map((cost) => {
          const item = backpack.find((entry: any) => (entry?.name ?? entry?.名称) === cost.name);
          return `#换行需要${cost.name}x${this.support.round2Text(cost.quantity)}，你只有${this.support.round2Text(this.support.itemQuantity(item))}`;
        }).join('');
      return `${player.name}${missing}`;
    }

    const item = merchantBackpack[itemIndex];
    const paidText = this.formatMerchantItems(costs);
    for (const cost of costs) this.support.deductBackpackItem(backpack, cost.name, cost.quantity);
    this.support.addItemToCollection(backpack, item);
    merchantBackpack.splice(itemIndex, 1);

    const giftChance = Math.min(affinity / 4, 15);
    let result = `${player.name}用${paidText}从行商处购买了${this.formatMerchantItem(item, true, false)}`;
    if (Math.random() * 100 < giftChance) {
      const gift = this.generateMerchantResource();
      this.support.addItemToCollection(backpack, gift);
      result += `#换行行商把${gift.name}x${gift.quantity}送给了${player.name}(${this.support.round2Text(giftChance)}%)`;
    }

    this.achievementService.setAchievement(markers, '购物', shopSkill + 1);
    player.markers = markers;
    player.backpack = backpack; // Json 列直接写数组
    summons[merchantIndex].backpack = merchantBackpack; // Json 列直接写数组
    await this.mapService.updateDynamicFields(map.id, { summons });
    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, '购物');
    return result;
  }

  /**
   * 从背包数组扣除指定数量物品（按 count 字段，不足则清零移除）
   * 对应原版：获得物品() 的消耗逻辑
   */

  async handleRecipe(userId: number, recipeName: string): Promise<string> {
    // 从静态配置查询所有配方（JSON 单一来源）
    const allRecipes = this.staticData
      .getAllCraftings()
      .slice()
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (allRecipes.length === 0) {
      return '📜 当前没有任何可用的制造配方';
    }

    // 如果有指定配方名，查看该配方的详细信息
    if (recipeName) {
      const recipe = allRecipes.find((r) => r.name === recipeName);
      if (!recipe) {
        return `没有找到名为【${recipeName}】的配方`;
      }

      const reqs = asJsonValue<any[]>(recipe.requirements, []);
      const outputs = asJsonValue<any[]>(recipe.outputs, []);
      const lines = [
        `📜 【${recipe.name}】配方详情`,
        `━━━━━━━━━━━━━━━`,
      ];
      if (recipe.description) lines.push(`📖 ${recipe.description}`);
      lines.push(`等级要求: ${recipe.level}`);
      lines.push(``);
      lines.push(`📥 需求材料:`);
      for (const req of reqs) {
        lines.push(`  ${req.name} ×${req.count || req.quantity || 1}`);
      }
      lines.push(``);
      lines.push(`📤 产出物品:`);
      for (const out of outputs) {
        lines.push(`  ${out.name} ×${out.count || out.quantity || 1}`);
      }
      if (recipe.expGain > 0) lines.push(`\n经验奖励: ${recipe.expGain}`);
      return lines.join('\n');
    }

    // 按类型分类显示所有配方
    const categorized: Record<string, any[]> = {};
    for (const recipe of allRecipes) {
      // 根据名称推断类型
      let type = '其他';
      if (recipe.name.includes('丹') || recipe.name.includes('药') || recipe.name.includes('丸')) type = '丹药';
      else if (recipe.name.includes('剑') || recipe.name.includes('甲') || recipe.name.includes('盔') ||
               recipe.name.includes('盾') || recipe.name.includes('武器')) type = '装备';
      else if (recipe.name.includes('食物') || recipe.name.includes('面包') || recipe.name.includes('汤')) type = '食物';
      else if (recipe.name.includes('子弹') || recipe.name.includes('弹')) type = '弹药';
      if (!categorized[type]) categorized[type] = [];
      categorized[type].push(recipe);
    }

    const lines = ['📜 制造配方总览:', `━━━━━━━━━━━━━━━`];
    for (const [type, recipes] of Object.entries(categorized)) {
      lines.push(`【${type}】(${recipes.length}个)`);
      for (const recipe of recipes as any[]) {
        const outputs = asJsonValue<any[]>(recipe.outputs, []);
        const outText = outputs.map((o: any) => o.name).join(', ');
        lines.push(`  ${recipe.name} → ${outText}`);
      }
      lines.push('');
    }
    lines.push(`使用「配方 配方名」查看详细配方信息`);
    lines.push(`共 ${allRecipes.length} 个配方`);

    return lines.join('\n');
  }

  /**
   * 处理逆向命令
   * 对应原版 _主程序.ecode L9459-L9560 与物品操作.ecode L2158-L2179。
   * 逆向不是分解，也不读取制造配方：它消耗装备本身，按装备数据品质首字符
   * 增加同名逆向熟练度，熟练度上限为20。
   */

  async handleRecipeUnlock(userId: number, recipeName = ''): Promise<string> {
    return this.taskService.acceptRecipeUnlockTask(userId, recipeName);
  }

  /**
   * 确认求助
   * 对应原版：求助确认 命令
   */

  async handleReverse(userId: number, targetName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;
    const reverse = this.readReverseProficiencies(player);
    const name = player.name || '冒险者';
    const rawTarget = (targetName || '').trim();

    // 原版「逆向」显示已完成项目；「逆向0」显示仍在进行的项目。
    if (!rawTarget) {
      return this.formatReverseMenu(name, reverse, false);
    }
    if (/^0+$/.test(rawTarget)) {
      return this.formatReverseMenu(name, reverse, true);
    }

    if (rawTarget === '全部') {
      const result = this.reverseAllEligible(name, backpack, reverse);
      if (result.count === 0) return `${name}没有可以逆向的装备了`;
      await this.saveReverseResult(userId, player, backpack, reverse, result.count);
      return this.formatReverseBatchResult(name, result.count, result.items);
    }

    // 纯数字参数是背包 1-based 序号；名称参数按原版逆向全部分支的精确名称匹配。
    if (/^\d+$/.test(rawTarget)) {
      const index = Number(rawTarget);
      if (index > backpack.length) {
        return `${name}“逆向1”来逆向背包的第1个物品\n“逆向火焰披风”来逆向对应名称的装备`;
      }
      if (index <= 0) return this.formatReverseMenu(name, reverse, true);
      const item = backpack[index - 1];
      const failure = this.reverseItemFailure(name, item, reverse);
      if (failure) return failure;
      const result = this.reverseOne(item, reverse);
      backpack.splice(index - 1, 1);
      await this.saveReverseResult(userId, player, backpack, reverse, 1);
      return this.formatReverseSingleResult(name, item, result, reverse);
    }

    // 原版名称模式只处理同名装备，不按配方、数量或模糊名称匹配。
    const targetIndex = backpack.findIndex((item: any) =>
      this.support.itemName(item) === rawTarget && !this.reverseItemFailure('', item, reverse),
    );
    if (targetIndex < 0) {
      return this.formatReverseMenu(name, reverse, true);
    }
    const item = backpack[targetIndex];
    const result = this.reverseOne(item, reverse);
    backpack.splice(targetIndex, 1);
    await this.saveReverseResult(userId, player, backpack, reverse, 1);
    return this.formatReverseSingleResult(name, item, result, reverse);
  }

  /** 解析玩家.reverse；条目结构对齐原版 技能={名称,数值}。 */

  readReverseProficiencies(player: any): Array<{ name: string; value: number }> {
    const raw = typeof player.reverse === 'string'
      ? asJsonValue<any[]>(player.reverse, [])
      : (Array.isArray(player.reverse) ? player.reverse : []);
    return raw
      .filter((entry: any) => entry && (entry.name ?? entry.名称))
      .map((entry: any) => ({
        name: String(entry.name ?? entry.名称),
        value: Number(entry.value ?? entry.数值 ?? 0),
      }));
  }


  reverseProficiency(reverse: Array<{ name: string; value: number }>, itemName: string): number {
    return reverse.find((entry) => entry.name === itemName)?.value || 0;
  }


  setReverseProficiency(
    reverse: Array<{ name: string; value: number }>,
    itemName: string,
    amount: number,
  ): number {
    const existing = reverse.find((entry) => entry.name === itemName);
    if (existing) {
      existing.value += amount;
      return existing.value;
    }
    reverse.push({ name: itemName, value: amount });
    return amount;
  }


  reverseValue(item: any): number {
    const prefix = String(item?.data ?? item?.数据 ?? '').charAt(0);
    if (prefix === 'x') return 1;
    if (prefix === 's') return 0.2;
    if (prefix === 'a') return 0.1;
    if (prefix === 'b') return 0.05;
    if (prefix === 'c') return 0.025;
    if (prefix === 'd') return 0.0125;
    return 0.00625;
  }


  reverseItemFailure(
    playerName: string,
    item: any,
    reverse: Array<{ name: string; value: number }>,
  ): string {
    const itemName = this.support.itemName(item);
    const prefix = itemName.substring(0, 6);
    if (Number(item?.durability ?? item?.耐久 ?? 0) === 1) {
      return playerName ? `${playerName}这个装备被锁定` : 'locked';
    }
    if (prefix === '植入体') return playerName ? `${playerName}植入体不可以` : 'implant';
    if (prefix === '增幅器') return playerName ? `${playerName}增幅器不可以` : 'amplifier';
    if (this.support.itemType(item) !== '装备') {
      return playerName ? `${playerName}${itemName}不是装备` : 'not-equipment';
    }
    if (this.reverseProficiency(reverse, itemName) >= 20) {
      return playerName ? `${playerName}${itemName}这个已经不需要逆向了` : 'complete';
    }
    return '';
  }


  reverseOne(item: any, reverse: Array<{ name: string; value: number }>): number {
    return this.setReverseProficiency(reverse, this.support.itemName(item), this.reverseValue(item));
  }


  reverseAllEligible(
    playerName: string,
    backpack: any[],
    reverse: Array<{ name: string; value: number }>,
  ): { count: number; items: Array<{ name: string; value: number }> } {
    const results = new Map<string, number>();
    let count = 0;
    // 原版从背包尾部向前遍历；删除时用倒序保持同样的命中顺序。
    for (let i = backpack.length - 1; i >= 0; i--) {
      const item = backpack[i];
      if (this.support.itemType(item) !== '装备') continue;
      if (this.reverseItemFailure('', item, reverse)) continue;
      const itemName = this.support.itemName(item);
      const value = this.reverseOne(item, reverse);
      results.set(itemName, (results.get(itemName) || 0) + value);
      backpack.splice(i, 1);
      count++;
    }
    return {
      count,
      items: Array.from(results, ([name, value]) => ({ name, value })),
    };
  }


  formatReverseMenu(
    playerName: string,
    reverse: Array<{ name: string; value: number }>,
    inProgress: boolean,
  ): string {
    const lines = [
      playerName,
      '“逆向3”来逆向背包的第3个物品，“逆向动力上衣”来逆向名为动力上衣的装备，“逆向全部”来全部逆向',
      '逆向将消耗掉用来逆向的装备',
      '逆向完成后装备的基础属性将提高25%',
      inProgress ? '正在逆向的项目：' : '已完成逆向的项目：',
    ];
    let count = 0;
    for (const entry of reverse) {
      const matches = inProgress ? entry.value < 20 : entry.value >= 20;
      if (!matches) continue;
      count++;
      lines.push(`${count}、${entry.name}${inProgress ? this.support.formatReverseNumber(entry.value * 5) + '%' : ''}`);
    }
    if (!inProgress) lines.push('1、查看逆向中的项目');
    return lines.join('\n');
  }


  formatReverseBatchResult(
    playerName: string,
    count: number,
    items: Array<{ name: string; value: number }>,
  ): string {
    const lines = [`${playerName}逆向了${count}件装备`];
    for (const item of items) {
      lines.push(`${item.name}+${this.support.formatReverseNumber(item.value * 5)}%(${this.support.formatReverseNumber(item.value * 5)}%)`);
    }
    return lines.join('\n');
  }


  formatReverseSingleResult(
    playerName: string,
    item: any,
    value: number,
    reverse: Array<{ name: string; value: number }>,
  ): string {
    const parsed = this.itemService.parseEquipment(item);
    const quality = this.itemService.getEquipmentQuality(parsed);
    const current = this.reverseProficiency(reverse, this.support.itemName(item));
    return `${playerName}逆向了${this.support.itemName(item)}[${quality}]\n` +
      `${this.support.itemName(item)}+${this.support.formatReverseNumber(value * 5)}%(${this.support.formatReverseNumber(current * 5)}%)`;
  }


  async saveReverseResult(
    userId: number,
    player: any,
    backpack: any[],
    reverse: Array<{ name: string; value: number }>,
    count: number,
  ): Promise<void> {
    const markers = asJsonValue<Record<string, number>>(player.markers, {});
    markers['逆向'] = (markers['逆向'] || 0) + count;
    player.markers = markers;
    player.backpack = backpack;
    player.reverse = reverse;
    await this.playerService.savePlayer(player);
    // 原版把“逆向”作为任务成就写入；放在玩家存档之后，避免 taskService 的独立保存被旧 player.tasks 覆盖。
    await this.taskService.advance(userId, '逆向', count);
    this.logger.log(`玩家 ${userId} 逆向了${count}件装备`);
  }

  /**
   * 处理预设切换命令
   * 切换装备/技能预设方案
   */

  private readonly tradeLocks = new Map<string, Promise<void>>();
}
