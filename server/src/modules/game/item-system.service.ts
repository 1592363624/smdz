/**
 * 物品装备子系统（完整实现）
 * 对应原版：物品操作.ecode + 加成计算.ecode(部分) + 数据分析.ecode(部分)
 * 完整实现：物品管理、装备系统、制造、强化、植入体、增幅器、锁定、保护等
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { BonusService } from './bonus.service';
import { ItemService, Item3, Equipment } from './item.service';
import { StaticDataService } from './static-data.service';
import { AchievementService } from './achievement.service';
import { QUALITY_VALUE_MAP, BONUS_CODE_MAP, IMPLANT_STATS, IMPLANT_STAT_MAP, AMPLIFIER_STAT_MAP } from './item.service';

// ========== 类型定义 ==========

/** 装备预设接口 */
export interface EquipmentPreset {
  name: string;
  equipment: Item3[];
}

/** 品质等级信息 */
export interface QualityInfo {
  level: number;
  name: string;
  color: string;
}

@Injectable()
export class ItemSystemService {
  private readonly logger = new Logger(ItemSystemService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly bonusService: BonusService,
    private readonly itemService: ItemService,
    private readonly achievementService: AchievementService,
    private readonly staticData: StaticDataService,
  ) {}

  // ===================================================================
  //  制造系统
  // ===================================================================

  /**
   * 制造物品
   * 对应原版：制造()
   * 检查材料→消耗材料→产出物品
   * @param userId 玩家ID
   * @param recipeName 配方名称
   * @param count 制造数量，<=0 时显示配方信息
   */
  async craftItem(userId: number, recipeName: string, count?: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack, markers } = playerData;
    const actualCount = count ?? 1;

    // 存量掉落使用 count，初始/任务物品使用 quantity；制造内部统一到 quantity，
    // 写回时同时保留 count，保证任务奖励和旧背包都能继续制造。
    for (const item of backpack) {
      if (item.type !== '装备') {
        const quantity = Number(item.quantity ?? item.count ?? 0);
        item.quantity = quantity;
        item.count = quantity;
      }
    }

    // 查找配方（静态配置 JSON 单一来源）
    const recipes = this.staticData.getAllCraftings();
    const normalizedName = String(recipeName || '').replace(/制造$/, '');
    const recipe = recipes.find(r => r.name === recipeName)
      || recipes.find(r => r.name === normalizedName)
      || recipes.find(r => r.name === `${normalizedName}制造`);
    if (!recipe) {
      return `${player.name}，【${recipeName}】在制造列表不存在。`;
    }
    if (recipe.noCraft) {
      return `你输入了正确的名称，但是【${recipeName}】不是可以制造的项目（仅用于分解）。`;
    }

    const normalizeRecipeItems = (value: any): Item3[] => {
      const raw = Array.isArray(value) ? value : this.playerService.safeJsonParse<any[]>(value, []);
      return raw.map((item: any) => ({
        ...item,
        name: item.name ?? item.名称,
        quantity: Number(item.quantity ?? item.count ?? item.数量 ?? 0),
      })).filter((item: Item3) => item.name && Number.isFinite(item.quantity));
    };
    const outputs = normalizeRecipeItems(recipe.outputs);
    const requirements = normalizeRecipeItems(recipe.requirements);
    const gainMarkers: string[] = JSON.parse(recipe.gainMarkers || '[]');

    if (outputs.length === 0) {
      return `警告：制造项目${recipe.name}的制造产出为空，请检查数据。`;
    }

    // 显示配方信息
    if (actualCount <= 0) {
      let info = `${player.name}，${recipeName}（等级需求${recipe.level}）\n`;
      if (recipe.description) info += `${recipe.description}\n`;
      info += '━━━━━━━━━━━━━━━\n制造需求:\n';
      for (const req of requirements) {
        info += `  ${req.name} ×${req.quantity}\n`;
      }
      info += '━━━━━━━━━━━━━━━\n产出:\n';
      for (const out of outputs) {
        info += `  ${out.name} ×${out.quantity}\n`;
      }
      return info;
    }

    // 检查等级
    if (player.level < recipe.level) {
      return `需要等级 ${recipe.level} 才能制造【${recipeName}】。`;
    }

    // 检查是否已获得（标记限制）
    for (const gm of gainMarkers) {
      if (gm && (markers[gm] ?? 0) >= 1) {
        return `这个不可以重复制造。`;
      }
    }

    // 限制制造数量
    const maxCount = Math.min(actualCount, 1000000);

    // 检查材料
    const insufficient: string[] = [];
    for (const req of requirements) {
      const totalNeeded = req.quantity * maxCount;
      const hasQty = this.getItemQuantity(req.name, backpack);
      if (hasQty < totalNeeded) {
        insufficient.push(`需要${req.name} ×${totalNeeded}，你只有${hasQty}`);
      }
    }
    if (insufficient.length > 0) {
      return insufficient.join('\n');
    }

    // 消耗材料
    const consumedList: Item3[] = [];
    for (const req of requirements) {
      const totalNeeded = req.quantity * maxCount;
      let remaining = totalNeeded;
      for (const bp of backpack) {
        if (bp.name === req.name && remaining > 0) {
          const consume = Math.min(bp.quantity, remaining);
          bp.quantity -= consume;
          remaining -= consume;
          consumedList.push({ ...bp, quantity: consume });
          if (bp.quantity <= 0) {
            // 将在后续清理
          }
        }
      }
    }

    // 清理背包中数量为0的非装备物品
    const cleanedBackpack = backpack.filter(
      (bp: Item3) => bp.quantity > 0 || bp.type === '装备',
    );

    // 产出物品
    const producedList: Item3[] = [];
    let isEquipment = false;
    for (const out of outputs) {
      const type = await this.determineItemType(out.name);
      if (type === '装备') { isEquipment = true; break; }
    }

    if (isEquipment) {
      // 装备产出：每个单独生成
      for (let i = 0; i < maxCount; i++) {
        for (const out of outputs) {
          const itemType = await this.determineItemType(out.name);
          if (itemType === '装备') {
            const generated = await this.generateEquipment(out.name, '', 0);
            this.addItemToBackpack(cleanedBackpack, generated);
            producedList.push(generated);
          } else {
            const item: Item3 = {
              name: out.name,
              type: itemType,
              quantity: out.quantity,
              durability: 0,
              data: '',
            };
            this.addItemToBackpack(cleanedBackpack, item);
            producedList.push(item);
          }
        }
      }
    } else {
      // 普通物品产出
      for (const out of outputs) {
        const item: Item3 = {
          name: out.name,
          type: await this.determineItemType(out.name),
          quantity: out.quantity * maxCount,
          durability: 0,
          data: '',
        };
        this.addItemToBackpack(cleanedBackpack, item);
        producedList.push(item);
      }
    }

    // 更新标记/成就 — 使用成就系统服务
    this.achievementService.setAchievement(markers, '制造', (markers['制造'] || 0) + maxCount);
    this.achievementService.setAchievement(markers, '制造' + recipe.name, (markers['制造' + recipe.name] || 0) + maxCount);

    for (const gm of gainMarkers) {
      if (gm) {
        this.achievementService.setAchievement(markers, gm, (markers[gm] || 0) + maxCount);
      }
    }

    // 保存
    await this.prisma.player.update({
      where: { userId },
      data: {
        backpack: JSON.stringify(cleanedBackpack),
        markers: JSON.stringify(markers),
      },
    });

    // 制造后检查称号触发
    try {
      player.markers = markers;
      await this.achievementService.checkTitles(player);
    } catch (e) {
      this.logger.warn(`制造后称号检查失败: ${e.message}`);
    }

    // 构建返回文本
    const consumedText = consumedList.map(c => `${c.name} ×${c.quantity}`).join('、');
    const producedText = producedList.map(p => `${p.name} ×${p.quantity}`).join('、');
    return `${player.name}用${consumedText}制造了${maxCount}个${recipeName}，得到了${producedText}`;
  }

  /**
   * 分解装备
   * 对应原版：分解装备()
   * 将装备分解为材料，按品质返还水晶和能量块
   */
  async deconstructItem(userId: number, itemName: string, count?: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack, markers } = playerData;

    // 查找物品
    const itemIndex = backpack.findIndex((bp: Item3) => bp.name === itemName);
    if (itemIndex === -1) {
      return `${player.name} 你的背包中没有${itemName}。`;
    }

    const item = backpack[itemIndex];
    const available = item.type === '装备'
      ? Math.max(1, Number(item.quantity ?? item.count ?? 1))
      : Number(item.quantity ?? item.count ?? 0);
    const requested = Number(count);
    const actualCount = count === undefined || requested < 0
      ? available
      : Math.min(Math.floor(requested), available);
    if (!Number.isFinite(actualCount) || actualCount <= 0) {
      return `${player.name} 你的背包中没有可分解的${itemName}。`;
    }

    if (item.type === '装备') {
      // 检查是否植入体或增幅器
      if (item.name.startsWith('植入体') || item.name.startsWith('增幅器')) {
        return '这个不是可以被分解的装备。';
      }
      // 检查是否锁定
      if (item.durability !== 0) {
        return '不能分解被锁定的装备。';
      }

      const equipment = this.parseEquipment(item);
      const quality = this.getEquipmentQuality(equipment);

      // 根据品质计算分解价值
      const qualityValue = QUALITY_VALUE_MAP[quality] || 15;
      const crystalAmount = Math.floor(qualityValue * 0.5 * actualCount);
      const energyAmount = Math.floor(qualityValue * 0.3 * actualCount);

      // 按实际分解数量扣除，避免“分解物品1”把整组堆叠物品全部删除。
      if (actualCount >= available) {
        backpack.splice(itemIndex, 1);
      } else {
        item.quantity = available - actualCount;
        item.count = item.quantity;
      }

      // 添加产物
      this.addItemToBackpack(backpack, {
        name: '水晶', type: '资源', quantity: crystalAmount, durability: 0, data: '',
      });
      this.addItemToBackpack(backpack, {
        name: '能量块', type: '资源', quantity: energyAmount, durability: 0, data: '',
      });

      // 更新成就
      this.achievementService.setAchievement(markers, '分解', (markers['分解'] || 0) + actualCount);

      await this.prisma.player.update({
        where: { userId },
        data: {
          backpack: JSON.stringify(backpack),
          markers: JSON.stringify(markers),
        },
      });

      return `${player.name}分解了${item.name}，得到了${crystalAmount}水晶和${energyAmount}能量块。`;
    } else {
      // 非装备分解：查找制造配方（静态配置 JSON 单一来源）
      const recipes = this.staticData.getAllCraftings();
      const recipe = recipes.find(r => r.name === item.name);
      if (!recipe) {
        return `${item.name}还无法分解。`;
      }

      const requirements: Item3[] = JSON.parse(recipe.requirements || '[]');
      const deconstructMul = recipe.deconstructMul || 5;

      if (actualCount >= available) {
        backpack.splice(itemIndex, 1);
      } else {
        item.quantity = available - actualCount;
        item.count = item.quantity;
      }

      // 返还材料（按分解倍率）
      const returnItems: Item3[] = [];
      for (const req of requirements) {
        const returnQty = Math.floor((req.quantity * actualCount) / deconstructMul);
        if (returnQty > 0) {
          this.addItemToBackpack(backpack, {
            name: req.name, type: '资源', quantity: returnQty, durability: 0, data: '',
          });
          returnItems.push({ name: req.name, type: '资源', quantity: returnQty, durability: 0, data: '' });
        }
      }

      await this.prisma.player.update({
        where: { userId },
        data: { backpack: JSON.stringify(backpack) },
      });

      const returnText = returnItems.map(r => `${r.name} ×${r.quantity}`).join('、');
      return `分解了${actualCount}个${item.name}，得到了${returnText}。`;
    }
  }

  // ===================================================================
  //  强化系统
  // ===================================================================

  /**
   * 强化装备
   * 对应原版：强化()
   * 消耗材料提升装备属性
   */
  async enhanceItem(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack, markers } = playerData;

    // 查找背包装备
    const itemIndex = backpack.findIndex(
      (bp: Item3) => bp.name === itemName && bp.type === '装备',
    );
    if (itemIndex === -1) {
      return `${player.name} 你的背包中没有【${itemName}】装备。`;
    }

    const item = backpack[itemIndex];
    const equipment = this.parseEquipment(item);

    // 检查是否已锁定
    if (item.durability !== 0) {
      return '不能强化被锁定的装备。';
    }

    // 计算需要的水晶数量
    const level = (markers['强化等级'] as number) || 0;
    const crystalCost = Math.max(1, level + 1);

    // 检查水晶
    const crystalQty = this.getItemQuantity('水晶', backpack);
    if (crystalQty < crystalCost) {
      return `需要${crystalCost}个水晶进行强化，你只有${crystalQty}个。`;
    }

    // 消耗水晶
    this.removeItemFromBackpack(backpack, '水晶', crystalCost);

    // 随机提升一个属性
    const bonusKeys = Object.keys(equipment.bonus);
    if (bonusKeys.length > 0) {
      const randomKey = bonusKeys[Math.floor(Math.random() * bonusKeys.length)];
      equipment.bonus[randomKey] = (equipment.bonus[randomKey] || 0) + 1;
    } else {
      // 无属性时随机增加一个
      const allKeys = Object.values(BONUS_CODE_MAP);
      const randomKey = allKeys[Math.floor(Math.random() * allKeys.length)];
      equipment.bonus[randomKey] = 1;
    }

    // 更新装备数据
    item.data = this.buildEquipmentData(equipment);

    if (!markers['强化等级']) markers['强化等级'] = 0;
    markers['强化等级'] += 1;
    if (!markers['强化']) markers['强化'] = 0;
    markers['强化'] += 1;

    await this.prisma.player.update({
      where: { userId },
      data: {
        backpack: JSON.stringify(backpack),
        markers: JSON.stringify(markers),
      },
    });

    // 强化后检查称号触发
    try {
      const playerRecord = await this.prisma.player.findUnique({ where: { userId } });
      if (playerRecord) {
        playerRecord.markers = JSON.stringify(markers);
        await this.achievementService.checkTitles(playerRecord);
      }
    } catch (e) {
      this.logger.warn(`强化后称号检查失败: ${e.message}`);
    }

    return `${player.name}消耗${crystalCost}个水晶强化了【${itemName}】，属性提升了！`;
  }

  /**
   * 强化植入体
   * 对应原版：强化植入体()
   * 消耗水晶（随机）或水晶+史诗强化券（指定属性）强化植入体
   */
  async upgradeImplant(userId: number, target = ''): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, equipment, backpack, markers, weapons } = playerData;

    // 原版参数是“属性名+次数”，不带参数时只展示帮助，不执行一次强化。
    const rawTarget = String(target || '').trim();
    if (!rawTarget) {
      return `${player.name}请输入“强化植入体3”随机强化，或输入“强化植入体攻击3”指定属性强化。`;
    }

    // 解析命令：target 可以是“3”“攻击3”或“攻击 3”。
    let count = 1;
    let statTarget = '';
    const numMatch = rawTarget.match(/(\d+)/);
    if (numMatch) {
      count = parseInt(numMatch[1], 10);
    }
    const textPart = rawTarget.replace(/\d+/g, '').trim();
    statTarget = textPart;

    // 查找植入体装备
    const implantIndex = this.findSpecialEquipmentIndex(equipment, 'implant');
    if (implantIndex === -1) {
      return `${player.name}你身上未装备植入体。`;
    }

    if (count <= 0) {
      return `${player.name} 输入"强化植入体3"来随机强化3次，"强化植入体攻击3"来消耗史诗强化券强化3次攻击。`;
    }

    // 检查目标属性是否有效
    if (statTarget !== '' && !IMPLANT_STATS.includes(statTarget)) {
      return `${player.name}，${statTarget}不是可以强化的植入体属性。`;
    }

    const implantItem = equipment[implantIndex];
    const implant = this.parseEquipment(implantItem);

    // 获取植入体等级
    let implantLevel = Number(markers['植入体等级'] ?? 0);
    if (!Number.isFinite(implantLevel) || implantLevel < 0) implantLevel = 0;

    // 计算材料
    let crystalQty = this.getItemQuantity('水晶', backpack);
    let couponQty = this.getItemQuantity('史诗强化券', backpack);

    let usedMaterial = 0;
    let upgradedCount = 0;
    const resultItems: Array<{ name: string }> = [];
    let failReason = '';

    for (let i = 0; i < count; i++) {
      const materialCost = implantLevel;
      if (crystalQty <= materialCost) {
        failReason = '水晶不足';
        break;
      }

      // 指定属性强化每次都必须同时消耗一张史诗强化券，不能先扣水晶再留下半次强化。
      if (statTarget !== '' && couponQty < 1) {
        failReason = '史诗强化券不足';
        break;
      }

      usedMaterial += materialCost;
      crystalQty -= materialCost;
      if (statTarget !== '') couponQty--;
      upgradedCount++;
      implantLevel++;

      if (statTarget === '') {
        // 随机强化
        const randomStat = IMPLANT_STATS[Math.floor(Math.random() * IMPLANT_STATS.length)];
        const statKey = IMPLANT_STAT_MAP[randomStat];
        if (statKey) {
          implant.bonus[statKey] = (implant.bonus[statKey] || 0) + 1;
          resultItems.push({ name: randomStat });
        }
      } else {
        // 指定属性强化
        const statKey = IMPLANT_STAT_MAP[statTarget];
        if (statKey) {
          implant.bonus[statKey] = (implant.bonus[statKey] || 0) + 1;
          resultItems.push({ name: statTarget });
        }
      }
    }

    if (usedMaterial === 0) {
      return `${player.name} 材料不足，无法强化植入体。${failReason ? '（' + failReason + '）' : ''}`;
    }

    // 消耗材料
    this.removeItemFromBackpack(backpack, '水晶', usedMaterial);
    if (statTarget !== '') {
      this.removeItemFromBackpack(backpack, '史诗强化券', upgradedCount);
    }

    // 更新植入体装备数据
    implantItem.data = this.buildEquipmentData(implant);
    equipment[implantIndex] = implantItem;

    // 更新标记 — 使用成就系统服务
    this.achievementService.setAchievement(markers, '植入体等级', implantLevel);
    this.achievementService.setAchievement(markers, '强化植入体', (markers['强化植入体'] as number || 0) + upgradedCount);

    // 保存
    const sets = this.itemService.recomputeSets(equipment, weapons, this.extractTreasures(player));
    await this.prisma.player.update({
      where: { userId },
      data: {
        equipment: JSON.stringify(equipment),
        backpack: JSON.stringify(backpack),
        markers: JSON.stringify(markers),
      },
    });

    const resultText = resultItems.map(r => r.name).join('、');
    if (statTarget === '') {
      return `${player.name}使用${usedMaterial}块水晶强化了${upgradedCount}次植入体：\n${resultText}${failReason ? '\n' + failReason : ''}`;
    } else {
      return `${player.name}使用${usedMaterial}块水晶和${upgradedCount}张史诗强化券强化了${upgradedCount}次植入体：\n${resultText}${failReason ? '\n' + failReason : ''}`;
    }
  }

  /**
   * 强化增幅器
   * 对应原版：强化增幅器()
   * 消耗能量块（随机）或能量块+传说强化券（指定属性）强化增幅器
   */
  async upgradeAmplifier(userId: number, target = ''): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, equipment, backpack, markers, weapons } = playerData;

    const rawTarget = String(target || '').trim();
    if (!rawTarget) {
      return `${player.name}请输入“强化增幅器3”随机强化，或输入“强化增幅器攻击3”指定属性强化。`;
    }

    // 解析命令：target 可以是“3”“攻击3”或“攻击 3”。
    let count = 1;
    let statTarget = '';
    const numMatch = rawTarget.match(/(\d+)/);
    if (numMatch) {
      count = parseInt(numMatch[1], 10);
    }
    const textPart = rawTarget.replace(/\d+/g, '').trim();
    statTarget = textPart;

    // 查找增幅器装备
    const ampIndex = this.findSpecialEquipmentIndex(equipment, 'amplifier');
    if (ampIndex === -1) {
      return `${player.name}你身上未装备增幅器。`;
    }

    if (count <= 0) {
      return `${player.name} 输入"强化增幅器3"来随机强化3次，"强化增幅器攻击3"来消耗传说强化券强化3次攻击。`;
    }

    if (statTarget !== '' && !IMPLANT_STATS.includes(statTarget)) {
      return `${player.name}，${statTarget}不是可以强化的增幅器属性。`;
    }

    const ampItem = equipment[ampIndex];
    const amp = this.parseEquipment(ampItem);

    let ampLevel = Number(markers['增幅器等级'] ?? 0);
    if (!Number.isFinite(ampLevel) || ampLevel < 0) ampLevel = 0;
    let energyQty = this.getItemQuantity('能量块', backpack);
    let couponQty = this.getItemQuantity('传说强化券', backpack);

    let usedMaterial = 0;
    let upgradedCount = 0;
    const resultItems: Array<{ name: string }> = [];
    let failReason = '';

    for (let i = 0; i < count; i++) {
      const materialCost = ampLevel;
      if (energyQty <= materialCost) {
        failReason = '能量块不足';
        break;
      }

      if (statTarget !== '' && couponQty < 1) {
        failReason = '传说强化券不足';
        break;
      }

      usedMaterial += materialCost;
      energyQty -= materialCost;
      if (statTarget !== '') couponQty--;
      upgradedCount++;
      ampLevel++;

      if (statTarget === '') {
        const randomStat = IMPLANT_STATS[Math.floor(Math.random() * IMPLANT_STATS.length)];
        const statKey = AMPLIFIER_STAT_MAP[randomStat];
        if (statKey) {
          amp.bonus[statKey] = (amp.bonus[statKey] || 0) + 1;
          resultItems.push({ name: randomStat });
        }
      } else {
        const statKey = AMPLIFIER_STAT_MAP[statTarget];
        if (statKey) {
          amp.bonus[statKey] = (amp.bonus[statKey] || 0) + 1;
          resultItems.push({ name: statTarget });
        }
      }
    }

    if (usedMaterial === 0) {
      return `${player.name} 材料不足，无法强化增幅器。${failReason ? '（' + failReason + '）' : ''}`;
    }

    this.removeItemFromBackpack(backpack, '能量块', usedMaterial);
    if (statTarget !== '') {
      this.removeItemFromBackpack(backpack, '传说强化券', upgradedCount);
    }

    ampItem.data = this.buildEquipmentData(amp);
    equipment[ampIndex] = ampItem;

    // 更新标记 — 使用成就系统服务
    this.achievementService.setAchievement(markers, '增幅器等级', ampLevel);
    this.achievementService.setAchievement(markers, '强化增幅器', (markers['强化增幅器'] as number || 0) + upgradedCount);

    await this.prisma.player.update({
      where: { userId },
      data: {
        equipment: JSON.stringify(equipment),
        backpack: JSON.stringify(backpack),
        markers: JSON.stringify(markers),
      },
    });

    const resultText = resultItems.map(r => r.name).join('、');
    if (statTarget === '') {
      return `${player.name}使用${usedMaterial}块能量块强化了${upgradedCount}次增幅器：\n${resultText}${failReason ? '\n' + failReason : ''}`;
    } else {
      return `${player.name}使用${usedMaterial}块能量块和${upgradedCount}张传说强化券强化了${upgradedCount}次增幅器：\n${resultText}${failReason ? '\n' + failReason : ''}`;
    }
  }

  // ===================================================================
  //  切换系统
  // ===================================================================

  /**
   * 装备植入体（从背包中装备一个植入体物品到装备栏）
   * 对应原版：切换植入体()
   * 从背包中装备一个植入体到植入体槽位
   */
  async equipImplantItem(userId: number, implantName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack, equipment, weapons } = playerData;

    // 在背包中查找植入体
    const bpIndex = backpack.findIndex(
      (bp: Item3) => bp.name === implantName && bp.type === '装备',
    );
    if (bpIndex === -1) {
      return `${player.name} 你的背包中没有【${implantName}】。`;
    }

    // 检查是否为植入体
    const equip = this.parseEquipment(backpack[bpIndex]);
    if (!implantName.startsWith('植入体') && !(equip.specialSeq > 75 && equip.specialSeq < 80)) {
      return `${implantName}不是植入体，无法切换。`;
    }

    // 卸下当前植入体
    const oldImplantIndex = equipment.findIndex(
      (eq: Item3) => eq.name.startsWith('植入体') || (this.parseEquipment(eq).specialSeq > 75 && this.parseEquipment(eq).specialSeq < 80),
    );
    if (oldImplantIndex !== -1) {
      backpack.push(equipment[oldImplantIndex]);
      equipment.splice(oldImplantIndex, 1);
    }

    // 装备新植入体
    const newImplant = backpack.splice(bpIndex, 1)[0];
    equipment.push(newImplant);

    // 重算套装判定（对应原版 _计算玩家 实时 套装判断 累加 玩家.套装）
    const sets = this.itemService.recomputeSets(equipment, weapons, this.extractTreasures(player));
    await this.prisma.player.update({
      where: { userId },
      data: {
        backpack: JSON.stringify(backpack),
        equipment: JSON.stringify(equipment),
        sets,
      },
    });

    return `${player.name}切换了植入体为【${implantName}】。`;
  }

  /**
   * 装备增幅器（从背包中装备一个增幅器物品到装备栏）
   * 对应原版：切换增幅器()
   * 从背包中装备一个增幅器到增幅器槽位
   */
  async equipAmplifierItem(userId: number, amplifierName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack, equipment, weapons } = playerData;

    const bpIndex = backpack.findIndex(
      (bp: Item3) => bp.name === amplifierName && bp.type === '装备',
    );
    if (bpIndex === -1) {
      return `${player.name} 你的背包中没有【${amplifierName}】。`;
    }

    const equip = this.parseEquipment(backpack[bpIndex]);
    if (!amplifierName.startsWith('增幅器') && !(equip.specialSeq > 70 && equip.specialSeq < 76)) {
      return `${amplifierName}不是增幅器，无法切换。`;
    }

    // 卸下当前增幅器
    const oldAmpIndex = equipment.findIndex(
      (eq: Item3) => eq.name.startsWith('增幅器') || (this.parseEquipment(eq).specialSeq > 70 && this.parseEquipment(eq).specialSeq < 76),
    );
    if (oldAmpIndex !== -1) {
      backpack.push(equipment[oldAmpIndex]);
      equipment.splice(oldAmpIndex, 1);
    }

    const newAmp = backpack.splice(bpIndex, 1)[0];
    equipment.push(newAmp);

    // 重算套装判定
    const sets = this.itemService.recomputeSets(equipment, weapons, this.extractTreasures(player));
    await this.prisma.player.update({
      where: { userId },
      data: {
        backpack: JSON.stringify(backpack),
        equipment: JSON.stringify(equipment),
        sets,
      },
    });

    return `${player.name}切换了增幅器为【${amplifierName}】。`;
  }

  // ===================================================================
  //  锁定/保护系统
  // ===================================================================

  /**
   * 锁定装备
   * 对应原版：锁定装备()
   * 设置装备的耐久标记为1（锁定），防止误分解
   */
  async lockEquipment(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    const item = backpack.find(
      (bp: Item3) => bp.name === itemName && bp.type === '装备',
    );
    if (!item) {
      return `${player.name} 你的背包中没有【${itemName}】装备。`;
    }

    if (item.durability !== 0) {
      return `${player.name}，【${itemName}】已经被锁定了。`;
    }

    item.durability = 1; // 锁定

    await this.prisma.player.update({
      where: { userId },
      data: { backpack: JSON.stringify(backpack) },
    });

    return `${player.name}锁定了【${itemName}】，该装备现在不会被误分解。`;
  }

  /**
   * 解锁装备
   * 对应原版：解锁()
   * 解除装备的锁定状态
   */
  async unlockEquipment(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    const item = backpack.find(
      (bp: Item3) => bp.name === itemName && bp.type === '装备',
    );
    if (!item) {
      return `${player.name} 你的背包中没有【${itemName}】装备。`;
    }

    if (item.durability === 0) {
      return `${player.name}，【${itemName}】没有被锁定。`;
    }

    item.durability = 0; // 解锁

    await this.prisma.player.update({
      where: { userId },
      data: { backpack: JSON.stringify(backpack) },
    });

    return `${player.name}解锁了【${itemName}】。`;
  }

  /**
   * 保护物品（放入保险柜）
   * 对应原版：保护()
   * 将物品从背包转移到保险柜
   */
  async protectItem(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack, safeBox } = playerData;

    // 查找物品
    const bpIndex = backpack.findIndex((bp: Item3) => bp.name === itemName);
    if (bpIndex === -1) {
      return `${player.name} 你的背包中没有【${itemName}】。`;
    }

    const item = backpack.splice(bpIndex, 1)[0];

    // 放入保险柜
    const existing = safeBox.find((sb: Item3) => sb.name === item.name && sb.type === item.type);
    if (existing && item.type !== '装备') {
      existing.quantity += item.quantity;
    } else {
      safeBox.push(item);
    }

    await this.prisma.player.update({
      where: { userId },
      data: {
        backpack: JSON.stringify(backpack),
        safeBox: JSON.stringify(safeBox),
      },
    });

    const displayName = item.type === '装备' ? item.name : `${item.name} ×${item.quantity}`;
    return `${player.name}将【${displayName}】保护到了保险柜。`;
  }

  /**
   * 从保险柜移除物品（取回背包）
   * 对应原版：移除()（_主程序.ecode L3310-3360）
   * 原版逻辑：检查玩家拥有"次元保险柜"建筑后，调用 背包操作(玩家.保险柜, 玩家, 消息数据, "保险柜", 4)
   * 其中第 5 参数 4 表示"从保险柜取出"模式。此处实现与 保护() 反向的搬运。
   * @param userId 用户ID
   * @param itemName 物品名称
   * @returns 结果文本
   */
  async removeFromVault(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack, safeBox } = playerData;

    // 原版 L3315：检查次元保险柜建筑，未拥有则提示无法取出
    if (safeBox.length === 0) {
      return `${player.name} 你没有次元保险柜或保险柜是空的，无法取出物品。`;
    }

    // 在保险柜中查找目标物品（按名称匹配）
    const sbIndex = safeBox.findIndex((sb: Item3) => sb.name === itemName);
    if (sbIndex === -1) {
      return `${player.name} 你的次元保险柜中没有【${itemName}】。`;
    }

    const item = safeBox.splice(sbIndex, 1)[0];

    // 取回背包（装备/消耗品按名称叠加，避免重复堆叠）
    const existing = backpack.find((bp: Item3) => bp.name === item.name);
    if (existing && item.type !== '装备') {
      existing.quantity = (existing.quantity || 0) + (item.quantity || 1);
    } else {
      backpack.push(item);
    }

    await this.prisma.player.update({
      where: { userId },
      data: {
        backpack: JSON.stringify(backpack),
        safeBox: JSON.stringify(safeBox),
      },
    });

    const displayName = item.type === '装备' ? item.name : `${item.name} ×${item.quantity || 1}`;
    return `${player.name}从次元保险柜中取出了【${displayName}】。`;
  }

  /**
   * 丢弃物品
   * 对应原版：丢弃()
   * 将背包中的物品丢弃（从数据中移除）
   */
  async discardItem(userId: number, itemName: string, count?: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    const bpIndex = backpack.findIndex((bp: Item3) => bp.name === itemName);
    if (bpIndex === -1) {
      return `${player.name} 你的背包中没有【${itemName}】。`;
    }

    const item = backpack[bpIndex];
    const actualCount = (count === undefined || count < 0) ? item.quantity : Math.min(count, item.quantity);

    // 检查是否可丢弃
    if (item.name.startsWith('植入体') || item.name.startsWith('增幅器')) {
      return `${player.name} 这个不能被丢弃。`;
    }

    if (item.type === '装备') {
      backpack.splice(bpIndex, 1);
    } else {
      item.quantity -= actualCount;
      if (item.quantity <= 0) {
        backpack.splice(bpIndex, 1);
      }
    }

    await this.prisma.player.update({
      where: { userId },
      data: { backpack: JSON.stringify(backpack) },
    });

    const displayText = item.type === '装备' ? item.name : `${item.name} ×${actualCount}`;
    return `${player.name}丢弃了${displayText}。`;
  }

  // ===================================================================
  //  解析/比较系统
  // ===================================================================

  /**
   * 解析装备
   * 对应原版：解析()
   * 显示装备的详细属性
   */
  async analyzeEquipment(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack, equipment, weapons } = playerData;

    // 先在背包中查找
    let item = backpack.find(
      (bp: Item3) => bp.name === itemName && bp.type === '装备',
    );
    let source = '背包';

    // 再在已装备中查找
    if (!item) {
      item = equipment.find((eq: Item3) => eq.name === itemName);
      source = '装备栏';
    }

    // 再在武器中查找
    if (!item) {
      item = weapons.find((w: Item3) => w.name === itemName);
      source = '武器栏';
    }

    if (!item) {
      return `${player.name} 未找到【${itemName}】。`;
    }

    const equip = this.parseEquipment(item);
    const quality = this.getEquipmentQuality(equip);
    const qualityInfo = this.getQuality(equip);

    const lines: string[] = [];
    lines.push(`【${equip.name}】`);
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`品质: ${qualityInfo.name}`);
    lines.push(`类型: ${equip.type || '未知'}`);
    lines.push(`来源: ${source}`);

    if (equip.specialSeq !== 0) {
      lines.push(`特殊序号: ${equip.specialSeq}`);
    }
    if (equip.specialEffect !== 0) {
      lines.push(`特效编号: ${equip.specialEffect}`);
    }
    if (equip.maker) {
      lines.push(`制造者: ${equip.maker}`);
    }
    if (item.durability !== 0) {
      lines.push(`状态: 🔒 已锁定`);
    }

    lines.push(`━━━━━━━━━━━━━━━`);

    // 显示加成属性
    const bonusLines = this.formatBonusStats(equip.bonus);
    if (bonusLines.length > 0) {
      lines.push('加成属性:');
      lines.push(...bonusLines);
    }

    // 显示基础属性
    if (equip.properties.phys || equip.properties.fire || equip.properties.ice || equip.properties.elec) {
      lines.push('━━━━━━━━━━━━━━━');
      lines.push(`伤害属性: 物理${equip.properties.phys}% / 火焰${equip.properties.fire}% / 冰霜${equip.properties.ice}% / 雷电${equip.properties.elec}%`);
    }

    if (equip.cooldown && equip.cooldown !== 5) {
      lines.push(`冷却: ${equip.cooldown}秒`);
    }

    return lines.join('\n');
  }

  /**
   * 比较装备
   * 对应原版：比较装备()
   * 对比两件装备的属性
   */
  async compareEquipment(userId: number, itemName1: string, itemName2: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const analyze1 = await this.findItemForCompare(playerData, itemName1);
    const analyze2 = await this.findItemForCompare(playerData, itemName2);

    if (!analyze1) return `${player.name} 未找到【${itemName1}】。`;
    if (!analyze2) return `${player.name} 未找到【${itemName2}】。`;

    const lines: string[] = [];
    lines.push(`🆚 装备对比`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`${this.padRight(analyze1.equip.name, 12)} vs ${analyze2.equip.name}`);
    lines.push(`品质: ${this.padRight(this.getQuality(analyze1.equip).name, 8)} ${this.getQuality(analyze2.equip).name}`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // 合并所有属性key
    const allKeys = new Set<string>();
    for (const key of Object.keys(analyze1.equip.bonus)) allKeys.add(key);
    for (const key of Object.keys(analyze2.equip.bonus)) allKeys.add(key);

    for (const key of allKeys) {
      const v1 = analyze1.equip.bonus[key] || 0;
      const v2 = analyze2.equip.bonus[key] || 0;
      const diff = v2 - v1;
      const diffText = diff > 0 ? ` (+${diff.toFixed(1)})` : diff < 0 ? ` (${diff.toFixed(1)})` : '';
      lines.push(`${this.padRight(key, 10)}: ${this.padRight(v1.toFixed(1), 8)} ${v2.toFixed(1)}${diffText}`);
    }

    if (analyze1.equip.specialEffect || analyze2.equip.specialEffect) {
      lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`特效: ${analyze1.equip.specialEffect || '无'} vs ${analyze2.equip.specialEffect || '无'}`);
    }

    return lines.join('\n');
  }

  // ===================================================================
  //  武器切换 / 装备预设
  // ===================================================================

  /**
   * 切换武器
   * 对应原版：切换武器()
   * 切换当前使用的武器
   */
  async switchWeapon(userId: number, weaponIndex: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, weapons } = playerData;

    if (weapons.length === 0) {
      return `${player.name} 你还没有任何武器。`;
    }

    if (weaponIndex < 1 || weaponIndex > weapons.length) {
      return `武器编号超出范围，当前有${weapons.length}把武器。`;
    }

    const currentWeapon = weaponIndex - 1; // 转为0-based

    await this.prisma.player.update({
      where: { userId },
      data: { currentWeapon },
    });

    const weapon = weapons[currentWeapon];
    return `${player.name}切换武器为【${weapon.name}】。`;
  }

  /**
   * 装备预设
   * 对应原版：装备预设()
   * 保存/切换装备预设方案
   */
  async equipmentPreset(userId: number, action: string, presetName?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, equipment, weapons, backpack } = playerData;

    const presets: EquipmentPreset[] = JSON.parse(player.equipmentPresets || '[]');

    if (action === 'save') {
      // 保存当前装备方案
      if (!presetName) {
        return '请指定预设名称，例如：装备预设 save 我的方案1';
      }
      // 检查是否已存在同名预设
      const existing = presets.findIndex(p => p.name === presetName);
      const newPreset: EquipmentPreset = {
        name: presetName,
        equipment: [...equipment, ...weapons],
      };
      if (existing !== -1) {
        presets[existing] = newPreset;
      } else {
        presets.push(newPreset);
      }

      await this.prisma.player.update({
        where: { userId },
        data: { equipmentPresets: JSON.stringify(presets) },
      });

      return `${player.name}保存了装备预设【${presetName}】。`;
    } else if (action === 'load') {
      // 加载预设
      if (!presetName) {
        // 列出所有预设
        if (presets.length === 0) {
          return `${player.name} 你还没有保存任何装备预设。`;
        }
        return `${player.name} 的装备预设:\n${presets.map((p, i) => `${i + 1}. ${p.name}（${p.equipment.length}件）`).join('\n')}`;
      }

      const preset = presets.find(p => p.name === presetName);
      if (!preset) {
        return `${player.name} 未找到名为【${presetName}】的装备预设。`;
      }

      // 将当前装备放回背包
      for (const eq of equipment) {
        backpack.push(eq);
      }
      for (const w of weapons) {
        backpack.push(w);
      }

      // 从预设加载装备（需要从背包中移除）
      const newEquipment: Item3[] = [];
      const newWeapons: Item3[] = [];
      for (const presetItem of preset.equipment) {
        const bpIndex = backpack.findIndex(
          (bp: Item3) => bp.name === presetItem.name && bp.type === '装备',
        );
        if (bpIndex !== -1) {
          const item = backpack.splice(bpIndex, 1)[0];
          // 判断是否为武器
          const eq = this.parseEquipment(item);
          if (this.isWeapon(eq)) {
            newWeapons.push(item);
          } else {
            newEquipment.push(item);
          }
        }
      }

      // 重算套装判定（对应原版 _计算玩家 实时 套装判断 累加 玩家.套装）
      const sets = this.itemService.recomputeSets(newEquipment, newWeapons, this.extractTreasures(player));
      await this.prisma.player.update({
        where: { userId },
        data: {
          equipment: JSON.stringify(newEquipment),
          weapons: JSON.stringify(newWeapons),
          backpack: JSON.stringify(backpack),
          currentWeapon: newWeapons.length > 0 ? 0 : 0,
          equipmentPresets: JSON.stringify(presets),
          sets,
        },
      });

      return `${player.name}加载了装备预设【${presetName}】（${newEquipment.length}件装备，${newWeapons.length}把武器）。`;
    } else if (action === 'list') {
      if (presets.length === 0) {
        return `${player.name} 你还没有保存任何装备预设。`;
      }
      return `${player.name} 的装备预设:\n${presets.map((p, i) => `${i + 1}. ${p.name}（${p.equipment.length}件）`).join('\n')}`;
    } else {
      return `未知操作：${action}，支持 save / load / list。`;
    }
  }

  // ===================================================================
  //  植入体系统（装备栏为唯一状态源）
  // ===================================================================

  private findSpecialEquipmentIndex(equipment: Item3[], kind: 'implant' | 'amplifier'): number {
    const [minSeq, maxSeq] = kind === 'implant' ? [76, 79] : [71, 75];
    const prefix = kind === 'implant' ? '植入体' : '增幅器';
    return (equipment || []).findIndex((item: Item3) => {
      const name = String(item?.name || '');
      if (name.startsWith(prefix)) return true;
      const definition = this.staticData.getEquipmentByName(name);
      const type = String(definition?.equipType ?? definition?.type ?? '');
      const seq = Number((item as any)?.specialSeq ?? definition?.specialSeq ?? 0);
      return type === prefix || seq === (kind === 'implant' ? 2 : 1) || (seq >= minSeq && seq <= maxSeq);
    });
  }

  private getSpecialLevel(markers: Record<string, any>, key: string): number {
    const raw = markers?.[key];
    const value = typeof raw === 'object' && raw !== null
      ? (raw.value ?? raw.数值 ?? raw.level ?? 0)
      : raw;
    const level = Number(value ?? 0);
    return Number.isFinite(level) && level > 0 ? Math.floor(level) : 0;
  }

  private getEnhancementRefund(level: number): number {
    const normalized = Math.max(0, Math.floor(Number(level) || 0));
    return normalized * (normalized + 1) / 2;
  }

  private clearSpecialEquipmentBonus(item: Item3): void {
    // 植入体/增幅器的静态基础加成为空，原版还原后将装备数据重置为 x。
    // 保留名称，使当前切换类型不受还原影响；下次切换仍只改名称。
    item.data = 'x';
  }

  /**
   * 查看植入体。
   * 原版从玩家装备中寻找“植入体”，等级仍记录在“植入体等级”熟练度，
   * 装备 data 中的加成则是实际生效的强化结果。
   */
  async viewImplant(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, equipment, markers } = playerData;
    const implantIndex = this.findSpecialEquipmentIndex(equipment, 'implant');
    if (implantIndex === -1) {
      return `${player.name}你身上未装备植入体`;
    }

    const implantItem = equipment[implantIndex];
    const implant = this.parseEquipment(implantItem);
    const level = this.getSpecialLevel(markers, '植入体等级');
    const bonusLines = this.formatBonusStats(implant.bonus);
    const lines = [
      `${player.name}的植入体（等级${level}）`,
      bonusLines.length > 0 ? bonusLines.join('\n') : '暂无强化加成',
      '“强化植入体”来强化植入体',
      '“还原植入体”来重置，还原无损耗',
      '“切换植入体”来消耗2张凭证来切换植入体的强化类型',
      `当前类型：${implantItem.name}`,
    ];
    return lines.join('\n');
  }

  /**
   * 切换植入体。
   * 原版切换只改变装备名称/特殊序号，不重置已有强化；费用为2个凭证。
   */
  async switchImplant(userId: number, type = ''): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, equipment, backpack, weapons } = playerData;
    const rawType = String(type || '').trim().replace(/^植入体[-:]?/, '');
    if (!rawType) {
      return [
        `${player.name}`,
        '◆1、植入体-强攻：最终物攻+25%，护盾/装甲/生命物理穿透+10%',
        '◆2、植入体-烈火：最终火攻+25%，护盾/装甲/生命火焰穿透+10%',
        '◆3、植入体-冰结：最终冰攻+25%，护盾/装甲/生命冰冻穿透+10%',
        '◆4、植入体-雷霆：最终电攻+25%，护盾/装甲/生命雷电穿透+10%',
        '◆6、植入体：无特殊效果',
      ].join('\n');
    }

    const options: Record<string, { name: string; seq: number }> = {
      强攻: { name: '植入体-强攻', seq: 76 },
      烈火: { name: '植入体-烈火', seq: 78 },
      冰结: { name: '植入体-冰结', seq: 79 },
      雷霆: { name: '植入体-雷霆', seq: 77 },
      无: { name: '植入体', seq: 2 },
    };
    const selected = options[rawType];
    if (!selected) {
      return `${player.name},“${rawType}”不是允许的类型`;
    }

    const implantIndex = this.findSpecialEquipmentIndex(equipment, 'implant');
    if (implantIndex === -1) {
      return `${player.name}你身上未装备植入体`;
    }

    const credentialCost = 2;
    const credentialQty = this.getItemQuantity('凭证', backpack);
    if (credentialQty < credentialCost) {
      return `${player.name}每次需要消耗2凭证`;
    }

    const implantItem = equipment[implantIndex];
    const oldName = implantItem.name;
    implantItem.name = selected.name;
    (implantItem as any).specialSeq = selected.seq;
    this.removeItemFromBackpack(backpack, '凭证', credentialCost);
    const sets = this.itemService.recomputeSets(equipment, weapons, this.extractTreasures(player));

    const sets = this.itemService.recomputeSets(equipment, weapons, this.extractTreasures(player));
    await this.prisma.player.update({
      where: { userId },
      data: {
        equipment: JSON.stringify(equipment),
        backpack: JSON.stringify(backpack),
        sets,
      },
    });

    return `${player.name}把植入体切换为${rawType}（${oldName}→${implantItem.name}）`;
  }

  /**
   * 强化植入体（基于 markers 存储）
   * 消耗水晶和强化券提升植入体等级，等级越高成功率越低
   * @param userId 玩家ID
   * @param couponType 强化券类型：''=普通(仅水晶), '史诗'=史诗强化券(100%成功率), '传说'=传说强化券(90%成功率)
   */
  async enhanceImplant(userId: number, couponType: string = ''): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack, markers } = playerData;

    // 读取植入体数据
    const implantData = markers['implant'];
    if (!implantData) {
      return `${player.name}，你还没有植入体，请先使用"切换植入体"选择一个类型。`;
    }

    const implant = typeof implantData === 'string' ? JSON.parse(implantData) : implantData;
    const level = implant.level || 1;
    const maxLevel = 20;

    // 检查是否已达最大等级
    if (level >= maxLevel) {
      return `${player.name}，植入体已达最高等级 Lv.${maxLevel}，无法继续强化。`;
    }

    // 计算消耗和成功率
    const crystalCost = level * 10;
    const baseSuccessRate = Math.max(10, 100 - level * 5);
    let successRate = baseSuccessRate;
    let needsCoupon = false;
    let couponName = '';

    if (couponType === '史诗') {
      // 史诗强化券：100% 成功率
      successRate = 100;
      needsCoupon = true;
      couponName = '史诗强化券';
    } else if (couponType === '传说') {
      // 传说强化券：90% 成功率
      successRate = 90;
      needsCoupon = true;
      couponName = '传说强化券';
    }

    // 检查水晶
    const crystalQty = this.getItemQuantity('水晶', backpack);
    if (crystalQty < crystalCost) {
      return `${player.name}，强化需要 ${crystalCost} 个水晶，你只有 ${crystalQty} 个。`;
    }

    // 检查强化券
    if (needsCoupon) {
      const couponQty = this.getItemQuantity(couponName, backpack);
      if (couponQty < 1) {
        return `${player.name}，强化需要 1 张${couponName}，你还没有。`;
      }
      this.removeItemFromBackpack(backpack, couponName, 1);
    }

    // 消耗水晶
    this.removeItemFromBackpack(backpack, '水晶', crystalCost);

    // 判定成功率
    const roll = Math.random() * 100;
    const success = roll < successRate;

    if (success) {
      implant.level = level + 1;
      markers['implant'] = implant;

      await this.prisma.player.update({
        where: { userId },
        data: {
          backpack: JSON.stringify(backpack),
          markers: JSON.stringify(markers),
        },
      });

      const couponText = needsCoupon ? `和 1 张${couponName}` : '';
      return `${player.name}消耗 ${crystalCost} 个水晶${couponText}强化植入体成功！\n植入体等级: Lv.${level} → Lv.${level + 1}（成功率 ${successRate}%）`;
    } else {
      // 强化失败，不升级
      await this.prisma.player.update({
        where: { userId },
        data: { backpack: JSON.stringify(backpack) },
      });

      const couponText = needsCoupon ? `和 1 张${couponName}` : '';
      return `${player.name}消耗 ${crystalCost} 个水晶${couponText}强化植入体失败...\n植入体等级仍为 Lv.${level}（成功率 ${successRate}%）`;
    }
  }

  /** 显示原版两步确认中的第一步，不修改玩家数据。 */
  async resetImplant(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, equipment, markers } = playerData;
    if (this.findSpecialEquipmentIndex(equipment, 'implant') === -1) {
      return `${player.name}你未装备植入体。`;
    }
    const level = this.getSpecialLevel(markers, '植入体等级');
    const refund = this.getEnhancementRefund(level);
    return `${player.name}确定要重置植入体的强化吗？将返还：${refund}的水晶，不返还史诗强化券\n发送“确认还原植入体等级”执行`;
  }

  /** 执行“确认还原植入体等级”，返还全部累计水晶且不返还强化券。 */
  async confirmResetImplant(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, equipment, backpack, markers, weapons } = playerData;
    const implantIndex = this.findSpecialEquipmentIndex(equipment, 'implant');
    if (implantIndex === -1) {
      return `${player.name}你未装备植入体。`;
    }

    const level = this.getSpecialLevel(markers, '植入体等级');
    const refund = this.getEnhancementRefund(level);
    this.achievementService.setAchievement(markers, '植入体等级', 0);
    delete markers.implant;
    this.clearSpecialEquipmentBonus(equipment[implantIndex]);
    if (refund > 0) {
      this.addItemToBackpack(backpack, {
        name: '水晶', type: '资源', quantity: refund, durability: 0, data: '',
      });
    }

    const sets = this.itemService.recomputeSets(equipment, weapons, this.extractTreasures(player));
    await this.prisma.player.update({
      where: { userId },
      data: {
        equipment: JSON.stringify(equipment),
        backpack: JSON.stringify(backpack),
        markers: JSON.stringify(markers),
        sets,
        sets,
        sets,
      },
    });
    return `${player.name}把植入体重置了，得到了${refund}的水晶`;
  }

  // ===================================================================
  //  增幅器系统（装备栏为唯一状态源）
  // ===================================================================

  /** 查看增幅器，实际加成从装备 data 解析。 */
  async viewAmplifier(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, equipment, markers } = playerData;
    const amplifierIndex = this.findSpecialEquipmentIndex(equipment, 'amplifier');
    if (amplifierIndex === -1) {
      return `${player.name}你身上未装备增幅器`;
    }

    const amplifierItem = equipment[amplifierIndex];
    const amplifier = this.parseEquipment(amplifierItem);
    const level = this.getSpecialLevel(markers, '增幅器等级');
    const bonusLines = this.formatBonusStats(amplifier.bonus);
    return [
      `${player.name}的增幅器（等级${level}）`,
      bonusLines.length > 0 ? bonusLines.join('\n') : '暂无强化加成',
      '“强化增幅器”来强化增幅器',
      '“还原增幅器”来重置，还原无损耗',
      '“切换增幅器”来消耗5张凭证来切换增幅器的强化类型',
      `当前类型：${amplifierItem.name}`,
    ].join('\n');
  }

  /** 切换增幅器，原版只修改名称/特殊序号并消耗5个凭证。 */
  async switchAmplifier(userId: number, type = ''): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, equipment, backpack, weapons } = playerData;
    const rawType = String(type || '').trim().replace(/^增幅器[-:]?/, '');
    if (!rawType) {
      return [
        `${player.name}`,
        '◆1、增幅器-速射：攻击伤害降低10%，攻击冷却降低10%，每攻击5次造成150%伤害并提高10%穿透',
        '◆2、增幅器-敏锐：被攻击时叠加层数，被命中时可抵挡一次攻击伤害',
        '◆3、增幅器-神枪：伤害随机数固定值+20%',
        '◆4、增幅器-坚毅：被命中时叠加层数，每层减少受到的10%伤害',
        '◆5、增幅器-侵彻：贯穿几率+10%，贯穿时追加目标三项上限伤害',
        '◆6、增幅器：无特殊效果',
      ].join('\n');
    }

    const options: Record<string, { name: string; seq: number }> = {
      速射: { name: '增幅器-速射', seq: 74 },
      敏锐: { name: '增幅器-敏锐', seq: 73 },
      神枪: { name: '增幅器-神枪', seq: 71 },
      坚毅: { name: '增幅器-坚毅', seq: 72 },
      侵彻: { name: '增幅器-侵彻', seq: 75 },
      无: { name: '增幅器', seq: 1 },
    };
    const selected = options[rawType];
    if (!selected) {
      return `${player.name},“${rawType}”不是允许的类型`;
    }

    const amplifierIndex = this.findSpecialEquipmentIndex(equipment, 'amplifier');
    if (amplifierIndex === -1) {
      return `${player.name}你身上未装备增幅器`;
    }

    const credentialCost = 5;
    if (this.getItemQuantity('凭证', backpack) < credentialCost) {
      return `${player.name}每次需要消耗5凭证`;
    }

    const amplifierItem = equipment[amplifierIndex];
    const oldName = amplifierItem.name;
    amplifierItem.name = selected.name;
    (amplifierItem as any).specialSeq = selected.seq;
    this.removeItemFromBackpack(backpack, '凭证', credentialCost);
    const sets = this.itemService.recomputeSets(equipment, weapons, this.extractTreasures(player));

    await this.prisma.player.update({
      where: { userId },
      data: {
        equipment: JSON.stringify(equipment),
        backpack: JSON.stringify(backpack),
        sets,
      },
    });
    return `${player.name}把增幅器切换为${rawType}（${oldName}→${amplifierItem.name}）`;
  }

  /**
   * 强化增幅器（基于 markers 存储）
   * 消耗能量块提升增幅器等级，等级越高消耗越大
   * @param userId 玩家ID
   */
  async enhanceAmplifier(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack, markers } = playerData;

    const ampData = markers['amplifier'];
    if (!ampData) {
      return `${player.name}，你还没有增幅器，请先使用"切换增幅器"选择一个类型。`;
    }

    const amp = typeof ampData === 'string' ? JSON.parse(ampData) : ampData;
    const level = amp.level || 1;
    const maxLevel = 20;

    if (level >= maxLevel) {
      return `${player.name}，增幅器已达最高等级 Lv.${maxLevel}，无法继续强化。`;
    }

    // 计算消耗
    const energyCost = level * 5;
    const energyQty = this.getItemQuantity('能量块', backpack);
    if (energyQty < energyCost) {
      return `${player.name}，强化需要 ${energyCost} 个能量块，你只有 ${energyQty} 个。`;
    }

    // 消耗能量块
    this.removeItemFromBackpack(backpack, '能量块', energyCost);

    // 提升等级
    amp.level = level + 1;
    markers['amplifier'] = amp;

    await this.prisma.player.update({
      where: { userId },
      data: {
        backpack: JSON.stringify(backpack),
        markers: JSON.stringify(markers),
      },
    });

    return `${player.name}消耗 ${energyCost} 个能量块强化增幅器成功！\n增幅器等级: Lv.${level} → Lv.${level + 1}`;
  }

  /** 显示原版两步确认中的第一步，不修改玩家数据。 */
  async resetAmplifier(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, equipment, markers } = playerData;
    if (this.findSpecialEquipmentIndex(equipment, 'amplifier') === -1) {
      return `${player.name}你未装备增幅器。`;
    }
    const level = this.getSpecialLevel(markers, '增幅器等级');
    const refund = this.getEnhancementRefund(level);
    return `${player.name}确定要重置增幅器的强化吗？将返还：${refund}的能量块，不返还传说强化券\n发送“确认还原增幅器等级”执行`;
  }

  /** 执行“确认还原增幅器等级”，返还全部累计能量块且不返还强化券。 */
  async confirmResetAmplifier(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, equipment, backpack, markers, weapons } = playerData;
    const amplifierIndex = this.findSpecialEquipmentIndex(equipment, 'amplifier');
    if (amplifierIndex === -1) {
      return `${player.name}你未装备增幅器。`;
    }

    const level = this.getSpecialLevel(markers, '增幅器等级');
    const refund = this.getEnhancementRefund(level);
    this.achievementService.setAchievement(markers, '增幅器等级', 0);
    delete markers.amplifier;
    this.clearSpecialEquipmentBonus(equipment[amplifierIndex]);
    if (refund > 0) {
      this.addItemToBackpack(backpack, {
        name: '能量块', type: '资源', quantity: refund, durability: 0, data: '',
      });
    }

    const sets = this.itemService.recomputeSets(equipment, weapons, this.extractTreasures(player));
    await this.prisma.player.update({
      where: { userId },
      data: {
        equipment: JSON.stringify(equipment),
        backpack: JSON.stringify(backpack),
        markers: JSON.stringify(markers),
        sets,
      },
    });
    return `${player.name}把增幅器重置了，得到了${refund}的能量块`;
  }

  // ===================================================================
  //  载具模拟系统
  // ===================================================================

  /**
   * 模拟载具装配效果
   * 计算各种部件组合的加成，不实际消耗部件
   * @param userId 玩家ID
   * @param partNames 部件名称数组
   */
  async simulateVehicle(userId: number, partNames: string[]): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (!partNames || partNames.length === 0) {
      return `${player.name}，请指定要模拟的载具部件，例如：模拟载具 [引擎,装甲,武器]`;
    }

    // 模拟部件加成数据
    const partBonuses: Record<string, { hp: number; shield: number; armor: number; attack: number; speed: number }> = {
      '引擎': { hp: 0, shield: 0, armor: 0, attack: 0, speed: 50 },
      '装甲': { hp: 200, shield: 0, armor: 100, attack: 0, speed: -10 },
      '武器': { hp: 0, shield: 0, armor: 0, attack: 100, speed: 0 },
      '护盾': { hp: 0, shield: 200, armor: 0, attack: 0, speed: 0 },
      '推进器': { hp: 0, shield: 0, armor: 0, attack: 20, speed: 80 },
      '雷达': { hp: 50, shield: 50, armor: 0, attack: 30, speed: 20 },
      '能量核心': { hp: 100, shield: 100, armor: 50, attack: 50, speed: 10 },
    };

    // 累加各部件的加成
    const totalBonus = { hp: 0, shield: 0, armor: 0, attack: 0, speed: 0 };
    const appliedParts: string[] = [];

    for (const partName of partNames) {
      const bonus = partBonuses[partName];
      if (bonus) {
        totalBonus.hp += bonus.hp;
        totalBonus.shield += bonus.shield;
        totalBonus.armor += bonus.armor;
        totalBonus.attack += bonus.attack;
        totalBonus.speed += bonus.speed;
        appliedParts.push(partName);
      }
    }

    if (appliedParts.length === 0) {
      return `${player.name}，未找到有效的载具部件。可用部件：${Object.keys(partBonuses).join('、')}`;
    }

    const lines: string[] = [];
    lines.push(`【载具模拟】`);
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`部件组合: ${appliedParts.join(' + ')}`);
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`模拟加成:`);
    lines.push(`  生命: +${totalBonus.hp}`);
    lines.push(`  护盾: +${totalBonus.shield}`);
    lines.push(`  装甲: +${totalBonus.armor}`);
    lines.push(`  攻击: +${totalBonus.attack}`);
    lines.push(`  速度: ${totalBonus.speed >= 0 ? '+' : ''}${totalBonus.speed}`);
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`注意: 此仅为模拟，不实际消耗部件。`);

    return lines.join('\n');
  }

  // ===================================================================
  //  装备预设快捷操作
  // ===================================================================

  /**
   * 保存装备预设
   * 保存当前装备组合为预设方案
   * @param userId 玩家ID
   * @param presetName 预设名称
   */
  async savePreset(userId: number, presetName: string): Promise<string> {
    return this.equipmentPreset(userId, 'save', presetName);
  }

  /**
   * 切换装备预设
   * 切换到指定名称的预设方案，一键换装
   * @param userId 玩家ID
   * @param presetName 预设名称
   */
  async switchPreset(userId: number, presetName: string): Promise<string> {
    return this.equipmentPreset(userId, 'load', presetName);
  }

  /**
   * 查看装备预设列表
   * 显示所有已保存的预设方案
   * @param userId 玩家ID
   */
  async viewPresets(userId: number): Promise<string> {
    return this.equipmentPreset(userId, 'list');
  }

  /**
   * 从玩家装备预设中提取"资源"类法宝（对应原版 装备预设[2] 的"资源"类型装备）
   * 原版 数据分析.ecode L907 扫描 玩家.装备预设[2].装备[a].类型=="资源"，本框架取预设数组索引2（第3个）。
   * @param player 玩家对象（含 equipmentPresets 字段）
   * @returns 法宝资源列表
   */
  private extractTreasures(player: any): Item3[] {
    try {
      const presets: any[] = JSON.parse(player?.equipmentPresets || '[]');
      const preset2 = presets[2];
      if (!preset2 || !Array.isArray(preset2.equipment)) return [];
      return (preset2.equipment as Item3[]).filter(
        (it: Item3) => it && (it.type === '资源' || it.type === 'resource'),
      ).map((it: Item3) => it);
    } catch {
      return [];
    }
  }

  // ===================================================================
  //  物品使用效果
  // ===================================================================

  /**
   * 使用物品效果
   * 使用物品时触发具体效果：回复生命/护盾/装甲、获得增益状态、获得标记
   * @param userId 玩家ID
   * @param itemName 物品名称
   */
  async useItemEffect(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack, markers } = playerData;

    // 查找背包中的物品
    const bpIndex = backpack.findIndex((bp: Item3) => bp.name === itemName);
    if (bpIndex === -1) {
      return `${player.name}，你的背包中没有【${itemName}】。`;
    }

    const item = backpack[bpIndex];

    // 定义物品使用效果表
    const itemEffects: Record<string, {
      type: 'recovery' | 'buff' | 'marker';
      target?: string;    // 恢复目标：hp/shield/armor
      value?: number;     // 恢复量
      buffName?: string;  // 增益名称
      buffDuration?: number; // 增益持续时间
      markerKey?: string; // 标记键名
      markerValue?: number; // 标记值
      description: string;  // 效果描述
    }> = {
      '面包': { type: 'recovery', target: '生命', value: 30, description: '恢复 30 点生命值' },
      '治疗药水': { type: 'recovery', target: '生命', value: 100, description: '恢复 100 点生命值' },
      '护盾药水': { type: 'recovery', target: '护盾', value: 80, description: '恢复 80 点护盾值' },
      '装甲修复剂': { type: 'recovery', target: '装甲', value: 60, description: '修复 60 点装甲值' },
      '新手补给': { type: 'marker', markerKey: '新手补给', markerValue: 1, description: '获得新手补给标记' },
    };

    const effect = itemEffects[itemName];
    if (!effect) {
      return `${player.name}，【${itemName}】没有可用的使用效果。`;
    }

    // 消耗物品
    const actualCount = 1;
    if (item.type === '装备') {
      backpack.splice(bpIndex, 1);
    } else {
      item.quantity -= actualCount;
      if (item.quantity <= 0) {
        backpack.splice(bpIndex, 1);
      }
    }

    // 应用效果
    let effectResult = '';

    if (effect.type === 'recovery') {
      // 回复类效果
      const targetField = effect.target || '生命';
      const maxField = 'max' + targetField.charAt(0).toUpperCase() + targetField.slice(1);

      // 获取当前值和最大值
      const currentValue = (player as any)[targetField] || 0;
      const maxValue = (player as any)[maxField] || currentValue;

      // 计算实际恢复量（不超过最大值）
      const actualHeal = Math.min(effect.value || 0, maxValue - currentValue);
      (player as any)[targetField] = currentValue + actualHeal;

      effectResult = `恢复了 ${actualHeal} 点${targetField === '生命' ? '生命' : targetField === '护盾' ? '护盾' : '装甲'}`;
    } else if (effect.type === 'buff') {
      // 增益类效果（简化版：记录到 markers）
      if (effect.buffName) {
        markers[`buff_${effect.buffName}`] = effect.buffDuration || 1;
      }
      effectResult = `获得了【${effect.buffName}】增益效果`;
    } else if (effect.type === 'marker') {
      // 标记类效果
      if (effect.markerKey) {
        markers[effect.markerKey] = (markers[effect.markerKey] || 0) + (effect.markerValue || 1);
      }
      effectResult = effect.description;
    }

    // 更新玩家数据
    await this.prisma.player.update({
      where: { userId },
      data: {
        backpack: JSON.stringify(backpack),
        markers: JSON.stringify(markers),
        hp: player.hp,
        shield: player.shield,
        armor: player.armor,
      },
    });

    return `${player.name}使用了【${itemName}】，${effectResult}。`;
  }

  // ===================================================================
  //  价值计算与品质系统
  // ===================================================================

  /**
   * 计算物品价值
   * 对应原版：计算价值()
   * 根据物品类型和品质计算总价值
   */
  async calculateValue(items: any[]): Promise<number> {
    return this.itemService.calculateValue(items as Item3[]);
  }

  /**
   * 获取装备品质信息
   * 品质等级: 普通(e) → 良好(d) → 优秀(c) → 精良(b) → 史诗(a) → 传说(s) → 神迹
   */
  getQuality(equipment: any): QualityInfo {
    const data = equipment.data || '';
    const prefix = data.charAt(0);

    const qualityMap: Record<string, QualityInfo> = {
      e: { level: 1, name: '普通', color: '#808080' },
      d: { level: 2, name: '良好', color: '#00AA00' },
      c: { level: 3, name: '优秀', color: '#0088FF' },
      b: { level: 4, name: '精良', color: '#AA00FF' },
      a: { level: 5, name: '史诗', color: '#FF8800' },
      s: { level: 6, name: '传说', color: '#FF4400' },
    };

    if (qualityMap[prefix]) {
      return qualityMap[prefix];
    }
    // 无前缀或无法识别 -> 神迹
    return { level: 7, name: '神迹', color: '#FF0000' };
  }

  /** 获取品质名称（向后兼容，委托给 ItemService） */
  getEquipmentQuality(equipment: any): string {
    return this.itemService.getEquipmentQuality(equipment as Equipment);
  }

  /**
   * 生成装备显示文本
   */
  formatEquipment(equipment: any, showDetails: boolean): string {
    const quality = this.getQuality(equipment);
    let text = `【${quality.name}】${equipment.name || '未知装备'}`;

    if (equipment.specialEffect && !showDetails) {
      text += ` [特效${equipment.specialEffect}]`;
    }

    if (showDetails) {
      const bonusText = Object.entries(equipment.bonus || {})
        .filter(([_, v]) => (v as number) !== 0)
        .map(([k, v]) => `${k}+${v}`)
        .join(' ');
      if (bonusText) {
        text += `\n${bonusText}`;
      }
      if (equipment.maker) {
        text += `\n制造者: ${equipment.maker}`;
      }
    }

    return text;
  }

  // ===================================================================
  //  内部工具方法
  // ===================================================================

  /**
   * 解析装备数据
   * 从 Item3.data 编码串中提取品质前缀、加成属性和特效编号
   * 委托给 ItemService.parseEquipment 实现
   */
  private parseEquipment(item: Item3): Equipment {
    return this.itemService.parseEquipment(item);
  }

  /**
   * 构建装备数据字符串
   * 将装备对象编码为 "品质前缀!aa值!...!bx特效!@@制造者" 格式
   */
  private buildEquipmentData(equipment: Equipment): string {
    const prefix = equipment.data ? equipment.data.charAt(0) : 'e';
    let data = prefix + this.bonusToDataString(equipment.bonus);
    if (equipment.specialEffect !== 0) {
      data += `!bx${equipment.specialEffect}`;
    }
    if (equipment.maker) {
      data += `!@@${equipment.maker}`;
    }
    return data;
  }

  /**
   * 加成数据转字符串
   * 委托给 ItemService.bonusToDataString 实现
   */
  private bonusToDataString(bonus: Record<string, number>): string {
    return this.itemService.bonusToDataString(bonus);
  }

  /**
   * 判断是否为武器
   */
  private isWeapon(equipment: Equipment): boolean {
    if (equipment.specialSeq < 0) return true;
    const weaponTypes = ['武器', '剑', '刀', '枪', '弓', '法杖', '杖', '盾', '斧', '锤', '工具'];
    for (const wt of weaponTypes) {
      if (equipment.type.includes(wt)) return true;
    }
    return equipment.specialSeq > 0 && equipment.specialSeq < 100;
  }

  /** 供指令层在装备成功后判断应推进“使用武器”还是“使用装备”。 */
  isWeaponItem(item: Item3): boolean {
    return item?.type === '装备' && this.isWeapon(this.parseEquipment(item));
  }

  /**
   * 判断物品类型（装备/资源/消耗品）
   * 通过查询数据库中的 GameEquipment 和 GameItem 表来确定
   */
  private async determineItemType(name: string): Promise<string> {
    // 先查装备配置（静态 JSON 单一来源）
    const gameEquip = this.staticData.getEquipmentByName(name);
    if (gameEquip) return '装备';
    // 再查物品配置
    const gameItem = this.staticData.getItemByName(name);
    if (gameItem) return gameItem.type || '资源';
    // 默认返回资源
    return '资源';
  }

  /**
   * 获取背包中某物品的总数量
   */
  private getItemQuantity(name: string, backpack: Item3[]): number {
    let total = 0;
    for (const bp of backpack) {
      if (bp.name === name) {
        total += bp.type !== '装备' ? Number(bp.quantity ?? bp.count ?? 0) : 1;
      }
    }
    return total;
  }

  /**
   * 从背包中移除指定数量的物品
   */
  private removeItemFromBackpack(backpack: Item3[], name: string, count: number): boolean {
    let remaining = count;
    for (let i = 0; i < backpack.length && remaining > 0; i++) {
      if (backpack[i].name === name) {
        if (backpack[i].type === '装备') {
          backpack.splice(i, 1);
          remaining--;
          i--;
        } else {
          const current = Number(backpack[i].quantity ?? backpack[i].count ?? 0);
          const remove = Math.min(current, remaining);
          backpack[i].quantity = current - remove;
          backpack[i].count = backpack[i].quantity;
          remaining -= remove;
          if (backpack[i].quantity <= 0) {
            backpack.splice(i, 1);
            i--;
          }
        }
      }
    }
    return remaining === 0;
  }

  /**
   * 添加物品到背包（自动合并同类物品）
   */
  private addItemToBackpack(backpack: Item3[], item: Item3): void {
    if (item.type === '装备') {
      backpack.push({ ...item });
      return;
    }
    const existing = backpack.find(
      (bp: Item3) => bp.name === item.name && bp.type === item.type,
    );
    if (existing) {
      const next = Number(existing.quantity ?? existing.count ?? 0) + Number(item.quantity ?? item.count ?? 0);
      existing.quantity = next;
      existing.count = next;
    } else {
      const quantity = Number(item.quantity ?? item.count ?? 0);
      backpack.push({ ...item, quantity, count: quantity });
    }
  }

  /**
   * 查找物品（跨背包/装备/武器）
   */
  private async findItemForCompare(
    playerData: any,
    itemName: string,
  ): Promise<{ equip: Equipment; item: Item3 } | null> {
    const { backpack, equipment, weapons } = playerData;

    let item = backpack.find((bp: Item3) => bp.name === itemName && bp.type === '装备');
    if (!item) item = equipment.find((eq: Item3) => eq.name === itemName);
    if (!item) item = weapons.find((w: Item3) => w.name === itemName);

    if (!item) return null;
    return { equip: this.parseEquipment(item), item };
  }

  /**
   * 格式化加成属性为显示文本
   */
  private formatBonusStats(bonus: Record<string, number>): string[] {
    const lines: string[] = [];
    const displayMap: Record<string, string> = {
      shield: '护盾', 装甲: '装甲', 生命: '生命', 攻击: '攻击',
      speed: '速度', 闪避: '闪避', 命中: '命中', 暴击: '暴击',
      critDmg: '暴击伤害', 物伤: '物伤', 电伤: '电伤',
      fireDmg: '火伤', 冰伤: '冰伤', 生命回复: '生命恢复',
      shieldRegen: '护盾回复', 装甲回复: '装甲修复',
      tenacity: '韧性', 采集: '采集', 掉落率: '掉落率',
      dropQuality: '掉落品质', 魅力: '魅力',
      hpAllRes: '生命全抗', 护盾全抗: '护盾全抗', 装甲全抗: '装甲全抗',
      hpPhysRes: '生命物抗', 生命火抗: '生命火抗', 生命冰抗: '生命冰抗', 生命电抗: '生命电抗',
      shieldPhysRes: '护盾物抗', 护盾火抗: '护盾火抗', 护盾冰抗: '护盾冰抗', 护盾电抗: '护盾电抗',
      armorPhysRes: '装甲物抗', 装甲火抗: '装甲火抗', 装甲冰抗: '装甲冰抗', 装甲电抗: '装甲电抗',
      shield2: '护盾II', 装甲2: '装甲II', 生命2: '生命II', 攻击2: '攻击II',
      speed2: '速度II', 闪避2: '闪避II', 命中2: '命中II',
      hpRegen2: '生命恢复II', 护盾回复2: '护盾回复II', 装甲回复2: '装甲修复II',
      physDmg2: '物伤II', 电伤2: '电伤II', 火伤2: '火伤II', 冰伤2: '冰伤II',
    };

    for (const [key, value] of Object.entries(bonus)) {
      if (value !== 0) {
        const displayName = displayMap[key] || key;
        lines.push(`  ${displayName}: ${value}`);
      }
    }
    return lines;
  }

  /**
   * 字符串右填充
   */
  private padRight(str: string, len: number): string {
    if (str.length >= len) return str.substring(0, len);
    return str + ' '.repeat(len - str.length);
  }

  /**
   * 中文词条名 → 英文 BonusData 键 映射
   * 对齐原版《词条转换》(物品操作.ecode L1849-1992) 的每个 case 写入的 z.加成.xxx 字段。
   * 原版用中文语义字段名(护盾/装甲/生命...)，运行时 BonusData 用英文键，此处做桥接。
   */
  private static readonly AFFIX_TO_BONUS: Record<string, string> = {
    护盾: '护盾', 装甲: '装甲', 生命: '生命',
    生命全抗: '生命全抗', 装甲全抗: '装甲全抗', 护盾全抗: '护盾全抗',
    物攻: '物伤', 电攻: '电伤', 火攻: '火伤', 冰攻: '冰伤', 攻击: '攻击',
    暴击: '暴击',
    生命物抗: '生命物抗', 生命火抗: '生命火抗', 生命冰抗: '生命冰抗', 生命电抗: '生命电抗',
    装甲物抗: '装甲物抗', 装甲火抗: '装甲火抗', 装甲冰抗: '装甲冰抗', 装甲电抗: '装甲电抗',
    护盾物抗: '护盾物抗', 护盾火抗: '护盾火抗', 护盾冰抗: '护盾冰抗', 护盾电抗: '护盾电抗',
    速度: '速度', 命中: '命中', 闪避: '闪避',
    掉落率: '掉落率', 掉落数量: '掉落品质', 采集: '采集',
    护盾回复: '护盾回复', 装甲修复: '装甲回复', 生命恢复: '生命回复',
    韧性: '韧性', 暴击伤害: '暴击伤害', 魅力: '魅力',
  };

  /**
   * 随机文本：从逗号分隔的候选串中随机取一个（对齐原版 随机文本()）
   */
  private randomText(candidates: string): string {
    // 原版候选串统一用半角逗号分隔（随机文本()/随机词条展开/affixCandidateFor 返回均为半角），
    // 故按半角逗号拆分；同时兼容全角逗号兜底。
    const arr = candidates.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (arr.length === 0) return '';
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /**
   * 词条转换（深度还原 物品操作.ecode L1838-1996）
   * 对应原版子程序 词条转换(z, 词条, 倍率, 下限增加, 上限增加)：
   * 按词条名随机出 [下限, 上限]×倍率 区间内的数值，写入 bonus 对应中文键（BonusData 字段）。
   * 下限增加/上限增加 入参为"百分比×100"（如品质下限0.1→传10），方法内 /100 还原。
   *
   * @param bonus 累加写入的加成对象（中文键 BonusData）
   * @param affix 中文词条名
   * @param mult 品质词条倍率（e=1/d=2/c=3/b=4/a=6/s=9/神迹=12）
   * @param lowerIncPct 下限增加（已×100），默认 10
   * @param upperIncPct 上限增加（已×100），默认 10
   */
  private rollAffix(
    bonus: Record<string, number>,
    affix: string,
    mult: number,
    lowerIncPct = 10,
    upperIncPct = 10,
  ): void {
    const lowerInc = lowerIncPct / 100;
    const upperInc = upperIncPct / 100;
    const key = ItemSystemService.AFFIX_TO_BONUS[affix];
    if (!key) {
      // 原版默认分支：记录错误（无法识别的装备词条）
      this.logger.warn(`无法识别的装备词条【${affix}】`);
      return;
    }
    // 原版公式统一形式：0.01 * 取随机数((baseLo + baseLo*下限增加)*倍率, (baseHi + baseHi*上限增加)*倍率)
    const roll = (baseLo: number, baseHi: number): number => {
      const lo = (baseLo + baseLo * lowerInc) * mult;
      const hi = (baseHi + baseHi * upperInc) * mult;
      // 取随机整数 [lo, hi] 并 /100（原版 0.01*取随机数）
      return (0.01 * Math.floor(lo + Math.random() * (hi - lo + 1)));
    };
    // 各词条区间严格对齐原版 L1849-1992
    switch (affix) {
      case '护盾': case '装甲': case '生命':
        bonus[key] = roll(500, 1000); break;
      case '生命全抗': bonus[key] = roll(50, 125); break;
      case '装甲全抗': bonus[key] = roll(50, 112.5); break;
      case '护盾全抗': bonus[key] = roll(50, 100); break;
      case '物攻': case '电攻': case '火攻': case '冰攻':
        bonus[key] = roll(400, 800); break;
      case '攻击': bonus[key] = roll(300, 600); break;
      case '暴击': bonus[key] = roll(50, 120); break;
      case '生命物抗': case '生命火抗': case '生命冰抗': case '生命电抗':
        bonus[key] = roll(200, 500); break;
      case '装甲物抗': case '装甲火抗': case '装甲冰抗': case '装甲电抗':
        bonus[key] = roll(200, 450); break;
      case '护盾物抗': case '护盾火抗': case '护盾冰抗': case '护盾电抗':
        bonus[key] = roll(200, 400); break;
      case '速度': case '命中': case '闪避': bonus[key] = roll(300, 600); break;
      case '掉落率': bonus[key] = roll(100, 200); break;
      case '掉落数量': bonus[key] = roll(200, 400); break; // 原版写入 掉落品质
      case '采集': bonus[key] = roll(400, 800); break;     // 原版写入 掉落率
      case '护盾回复': case '装甲修复': case '生命恢复': bonus[key] = roll(100, 800); break;
      case '韧性': bonus[key] = roll(50, 120); break;
      case '暴击伤害': bonus[key] = roll(100, 240); break;
      case '魅力': bonus[key] = roll(40, 100); break;
      default:
        this.logger.warn(`无法识别的装备词条【${affix}】`);
    }
  }

  /**
   * 生成装备（深度还原 物品操作.ecode L1128-1261）
   * 对应原版子程序 生成装备(名称, 品质, 传说率, 品质上限, 加成文本, 品质下限, 不生成特效)：
   * 1) 品质随机（传说率偏移）
   * 2) 从装备模板取基础加成(中文键→英文键) + 按词条数组逐条随机展开→词条转换
   * 3) 特效生成（武器/装备区分、必出特效/15%几率）
   * 4) 序列化：品质 + 加成转数据 + !bx特效
   *
   * @param name 装备名称
   * @param quality 品质(e/d/c/b/a/s)，空则随机
   * @param legendaryRate 传说率偏移(0~100)
   * @param qualityUpper 品质上限(0~1) 默认0.1
   * @param bonusText 加成文本(以@@开头则追加制造者)
   * @param qualityLower 品质下限(0~1) 默认0.1
   * @param noEffect 不生成特效
   */
  private async generateEquipment(
    name: string,
    quality?: string,
    legendaryRate?: number,
    qualityUpper = 0.1,
    bonusText?: string,
    qualityLower = 0.1,
    noEffect = false,
  ): Promise<Item3> {
    const gameEquip = this.staticData.getEquipmentByName(name);

    const item: Item3 = { name, type: '装备', quantity: 1, durability: 0, data: '' };

    // ---- 1) 品质随机（原版 L1144-1160）----
    let q = quality || '';
    if (q === '') {
      const a = Math.floor(Math.random() * 100) + 1; // 取随机数(1,100)
      const rate = legendaryRate || 0;
      if (a > 92 - rate) q = 's';
      else if (a >= 82 - rate) q = 'a';
      else if (a >= 72 - rate) q = 'b';
      else if (a >= 42 - rate) q = 'c';
      else if (a >= 18 - rate) q = 'd';
      else q = 'e';
    }

    // ---- 2) 基础加成：模板 bonus(中文键JSON) → BonusData 中文键（AFFIX_TO_BONUS 仅做词条名→属性字段的语义映射）----
    const bonus: Record<string, number> = {};
    if (gameEquip?.bonus) {
      try {
        const parsed = JSON.parse(gameEquip.bonus); // 中文键 JSON
        for (const [cnKey, val] of Object.entries(parsed)) {
          const enKey = ItemSystemService.AFFIX_TO_BONUS[cnKey] || cnKey;
          bonus[enKey] = Number(val) || 0;
        }
      } catch { /* ignore */ }
    }

    // 词条倍率（原版 L1174-1188）
    const qualityMult: Record<string, number> = { e: 1, d: 2, c: 3, b: 4, a: 6, s: 9 };
    let affixMult = qualityMult[q] || 1;
    const templateAffixes: string[] = [];
    if (gameEquip?.affixes) {
      try { templateAffixes.push(...JSON.parse(gameEquip.affixes)); } catch { /* ignore */ }
    }
    if (q === '' ) { // 神迹（默认分支，原版未指定字符时）
      affixMult = 12;
      if (templateAffixes.length < 5) templateAffixes.push('随机攻击');
    }

    // ---- 3) 词条循环：随机展开 + 去重 + 词条转换（原版 L1193-1227）----
    let usedAffixes = '';
    for (const rawAffix of templateAffixes) {
      if (!rawAffix || rawAffix.trim() === '') continue; // 删全部空 后为空则跳过
      let affix = rawAffix;
      // 随机词条展开（原版 L1197-1211）
      switch (affix) {
        case '随机护盾': affix = this.randomText('护盾,攻击,物攻,冰攻,火攻,电攻,护盾全抗,护盾物抗,护盾冰抗,护盾火抗,护盾电抗,护盾回复'); break;
        case '随机装甲': affix = this.randomText('装甲,攻击,物攻,冰攻,火攻,电攻,装甲全抗,装甲物抗,装甲冰抗,装甲火抗,装甲电抗,装甲修复'); break;
        case '随机生命': affix = this.randomText('生命,攻击,物攻,冰攻,火攻,电攻,生命全抗,生命物抗,生命冰抗,生命火抗,生命电抗,生命恢复'); break;
        case '随机攻击': affix = this.randomText('护盾,装甲,生命,攻击,物攻,冰攻,火攻,电攻,生命全抗,装甲全抗,护盾全抗,速度,命中,闪避'); break;
        case '随机防御': affix = this.randomText('护盾,装甲,生命,生命全抗,护盾全抗,装甲全抗,生命物抗,生命冰抗,生命火抗,生命电抗,装甲物抗,装甲冰抗,装甲火抗,装甲电抗,护盾物抗,护盾冰抗,护盾火抗,护盾电抗,闪避,护盾回复,装甲修复,生命恢复'); break;
        case '随机特殊': affix = this.randomText('暴击,速度,命中,闪避,掉落率,掉落数量,韧性,魅力'); break;
        default: affix = rawAffix; // 已是具体词条名
      }
      // 去重（原版 L1213-1225）：用 "1"+词条+"1" 拼接检查是否已存在
      if (usedAffixes !== '') {
        let guard = 0;
        while (usedAffixes.includes('1' + affix + '1') && guard < 1000) {
          affix = this.randomText(this.affixCandidateFor(rawAffix));
          guard++;
        }
      }
      usedAffixes += '1' + affix + '1';
      this.rollAffix(bonus, affix, affixMult, qualityLower * 100, qualityUpper * 100);
    }

    // ---- 4) 特效生成（原版 L1230-1253）----
    let effect = 0;
    if (!noEffect) {
      const isWeapon = typeof this.staticData.isWeapon === 'function'
        ? this.staticData.isWeapon(gameEquip)
        : (() => {
          const specialSeq = Number(gameEquip?.specialSeq ?? 0);
          if (specialSeq !== 0) return specialSeq < 0;
          const type = String(gameEquip?.equipType ?? gameEquip?.type ?? '');
          return type.endsWith('武器') || type === '工具';
        })();
      const forced = gameEquip?.forcedEffect === true || gameEquip?.forcedEffect === 'true';
      const effects = isWeapon
        ? (typeof (this.staticData as any).getWeaponEffects === 'function'
          ? (this.staticData as any).getWeaponEffects()
          : this.staticData.getAllEffects().filter((row: any) => !row?.limit || row.limit === '武器'))
        : (typeof (this.staticData as any).getEquipmentEffects === 'function'
          ? (this.staticData as any).getEquipmentEffects()
          : this.staticData.getAllEffects().filter((row: any) => !row?.limit || row.limit === '装备'));
      const effectCount = effects.length;
      if (isWeapon) {
        if (forced) effect = Math.floor(Math.random() * effectCount) + 1;
        else if (Math.random() < 0.15) effect = Math.floor(Math.random() * effectCount) + 1;
      } else {
        if (forced) effect = Math.floor(Math.random() * effectCount) + 1;
        else if (Math.random() < 0.15) effect = Math.floor(Math.random() * effectCount) + 1;
      }
    }

    // ---- 5) 序列化（原版 L1254-1259）----
    let data = q;
    if (bonusText && bonusText.startsWith('@@')) {
      data += '!' + bonusText + this.itemService.bonusToDataString(bonus) + '!bx' + effect;
    } else {
      data += this.itemService.bonusToDataString(bonus) + '!bx' + effect;
    }
    data = data.replace('!!', '!'); // 原版 子文本替换(!! → !)

    item.data = data;
    return item;
  }

  /**
   * 行商专用装备生成入口。
   * 原版 后台运作.ecode L1494-1497：品质固定为 s，品质上限1、下限0.6，
   * 并写入“@@行商出售”来源标记；汪酱保持原版的空品质分支。
   */
  async generateMerchantEquipment(name: string, isWangJiang = false): Promise<Item3> {
    return this.generateEquipment(
      name,
      isWangJiang ? undefined : 's',
      0,
      1,
      '@@行商出售',
      0.6,
    );
  }

  /**
   * 兑换/战利品装备入口。
   * 对应战斗相关.ecode L4913-4918：没有已有数据时按普通奖励品质生成装备。
   */
  async generateRewardEquipment(name: string, quality = ''): Promise<Item3> {
    return this.generateEquipment(name, quality, 0);
  }

  /**
   * 词条去重时重新随机的候选串（对齐原版 随机词条 展开映射，L1197-1208）
   */
  private affixCandidateFor(rawAffix: string): string {
    switch (rawAffix) {
      case '随机护盾': return '护盾,攻击,物攻,冰攻,火攻,电攻,护盾全抗,护盾物抗,护盾冰抗,护盾火抗,护盾电抗,护盾回复';
      case '随机装甲': return '装甲,攻击,物攻,冰攻,火攻,电攻,装甲全抗,装甲物抗,装甲冰抗,装甲火抗,装甲电抗,装甲修复';
      case '随机生命': return '生命,攻击,物攻,冰攻,火攻,电攻,生命全抗,生命物抗,生命冰抗,生命火抗,生命电抗,生命恢复';
      case '随机攻击': return '护盾,装甲,生命,攻击,物攻,冰攻,火攻,电攻,生命全抗,装甲全抗,护盾全抗,速度,命中,闪避';
      case '随机防御': return '护盾,装甲,生命,生命全抗,护盾全抗,装甲全抗,生命物抗,生命冰抗,生命火抗,生命电抗,装甲物抗,装甲冰抗,装甲火抗,装甲电抗,护盾物抗,护盾冰抗,护盾火抗,护盾电抗,闪避,护盾回复,装甲修复,生命恢复';
      case '随机特殊': return '暴击,速度,命中,闪避,掉落率,掉落数量,韧性,魅力';
      default: return rawAffix;
    }
  }

  // ==================== 战利品 ====================

  /**
   * 战利品（对应原版 战斗相关.ecode L4874-4946 子程序）
   *
   * 原版语义：处理怪物死亡后的掉落发放——遍历掉落物数组，按类型（装备/资源）分别处理：
   *   装备：数量<1→1；按数量循环，data 空则 生成装备(名, , 传说率)；加成就"获得装备"/"获得"+名；加入背包
   *   资源-好感：加成就(玩家.类型+"好感")/("好感")
   *   资源-经验：数量×(1+玩家.属性.经验/100) 加到玩家经验
   *   资源-默认：加成就"采集资源"/("采集"+名)；获得物品(背包)
   *   空名/电力 跳过；判断几率 模式按 几率 字段判定是否继续
   * 返回显示物品文本（掉落列表）。
   *
   * 1:1 还原各分支顺序与字面量。本框架：
   *   - 原版"判断物品2"在本框架无对应（仅校验物品结构），此处近似为「确保数量有效」；
   *   - 原版"显示物品"近似为 名字列表文本（掉落清单）；
   *   - 背包写入直接操作 playerData.player.backpack（与战斗结算"内存合并后统一save"一致）。
   *
   * @param playerData 玩家完整数据（含 player/成就/任务/标记/背包）
   * @param drops 掉落物数组（每项含 name/type/quantity/data/chance）
   * @param opts.judgeChance 是否按几率判定（原版 判断几率 参数）
   * @param opts.onTaskProgress 战利品实际入包后回传任务动作，避免物品系统反向依赖任务系统
   * @returns 掉落显示文本
   */
  async distributeLoot(
    playerData: any,
    drops: any[],
    opts?: {
      judgeChance?: boolean;
      onTaskProgress?: (actionName: string, count: number) => void;
    },
  ): Promise<string> {
    const player = playerData.player;
    const judgeChance = opts?.judgeChance ?? false;
    const backpack = this.playerService.getBackpackItems(player);
    const backpackOut: any[] = []; // 物品数组2（最终掉落清单）
    const legendRate = player.套装?.传说率 || player.legendRate || 0;

    for (const drop of (drops || [])) {
      const dropName = String(drop?.name ?? drop?.名称 ?? '').trim();
      if (!drop || dropName === '') continue; // 原版 L4889 空名跳过
      if (dropName === '电力') continue;       // 原版 L4892 电力跳过

      // 判断几率（原版 L4895-4903）
      if (judgeChance) {
        const chance = Number(drop.chance ?? drop.几率 ?? 0);
        if (Math.random() * 100 >= chance) continue;
      }

      const explicitType = String(drop.type ?? drop.类型 ?? '').trim().toLowerCase();
      const isEquipment = explicitType === '装备'
        || explicitType === 'equipment'
        || (!explicitType && typeof this.staticData?.getEquipmentByName === 'function'
          && !!this.staticData.getEquipmentByName(dropName));
      const rawQuantity = drop.quantity ?? drop.count ?? drop.数量;
      const parsedQuantity = rawQuantity === undefined || rawQuantity === null || rawQuantity === ''
        ? 1
        : Number(rawQuantity);
      if (!Number.isFinite(parsedQuantity)) continue;

      // 原版只有装备会把数量<1修正为1；资源的负数表示从背包扣除，
      // 例如载具零件-2、强化箱-1，不能统一改成1。
      const qty = isEquipment ? Math.max(1, Math.floor(parsedQuantity)) : parsedQuantity;

      // 本框架同时兼容中文/英文类型标记；没有标记时按静态装备表识别。
      const dropType = isEquipment ? '装备' : '资源';
      if (dropType === '装备') {
        // 原版 L4906-4921：按数量循环生成并加入背包
        for (let b = 0; b < qty; b++) {
          let item = { ...drop };
          if (!item.data) {
            // 原版 生成装备(名称, , 玩家.套装.传说率, , , , )
            item = await this.generateEquipment(dropName, '', legendRate);
          }
          await this.achievementService.addAchievement(player, '获得装备', 1, false);
          await this.achievementService.addAchievement(player, '获得' + item.name, qty, false);
          opts?.onTaskProgress?.('获得装备', 1);
          opts?.onTaskProgress?.('获得' + item.name, qty);
          backpack.push({
            ...item,
            name: item.name || dropName,
            type: '装备',
            quantity: 1,
            count: 1,
            data: item.data || '',
          });
          backpackOut.push({ name: item.name || dropName, count: 1, data: item.data || '' });
        }
      } else if (dropType === '资源') {
        // 原版 L4922-4938
        if (dropName === '好感') {
          await this.achievementService.addAchievement(player, (player.type || '') + '好感', qty, false);
          await this.achievementService.addAchievement(player, '好感', qty, false);
          if (qty > 0) opts?.onTaskProgress?.('好感', qty);
        } else if (dropName === '经验') {
          const adj = Math.floor(qty * (1 + (player.属性?.经验 || player.expBonus || 0) / 100));
          if (adj > 0) {
            player.exp = (player.exp || 0) + adj;
          }
        } else {
          await this.achievementService.addAchievement(player, '采集资源', qty, false);
          await this.achievementService.addAchievement(player, '采集' + dropName, qty, false);
          const changed = this.mergeLootResource(backpack, dropName, qty, drop);
          if (changed && qty > 0) {
            opts?.onTaskProgress?.('采集资源', qty);
            opts?.onTaskProgress?.('采集' + dropName, qty);
          }
          if (changed) backpackOut.push({ name: dropName, count: qty });
        }
      } else {
        // 默认（原版 L4939 空分支）：不处理
      }
    }

    player.backpack = JSON.stringify(backpack);
    // 显示物品（原版 L4946 返回 显示物品(物品数组2)）：近似为名字列表
    return backpackOut.map((i) => `${i.name}${i.count > 1 ? '×' + i.count : ''}`).join('、');
  }

  /**
   * 复刻“获得物品(背包, 物品)”的资源分支：正数叠加，负数扣除，
   * 数量归零时删除；不存在的负数资源不会凭空写入负库存。
   */
  private mergeLootResource(backpack: any[], name: string, quantity: number, source: any): boolean {
    if (!Number.isFinite(quantity) || quantity === 0) return false;

    const index = backpack.findIndex((item: any) => item?.name === name && item?.type !== '装备');
    if (index < 0) {
      if (quantity <= 0) return false;
      backpack.push({
        name,
        type: source?.type || source?.类型 || '资源',
        count: quantity,
        quantity,
      });
      return true;
    }

    const item = backpack[index];
    const current = Number(item.quantity ?? item.count ?? 0);
    const next = current + quantity;
    if (next <= 0) backpack.splice(index, 1);
    else {
      item.count = next;
      item.quantity = next;
    }
    return true;
  }

  /**
   * 物品要求（对应原版 物品操作.ecode L1784-1811 子程序 物品要求）
   *
   * 原版语义：在 物品数组 中查找指定名称 的物品；
   *  - 不提供 要求数量 时：只要存在该物品即返回真（参考参数写回数组下标）；
   *  - 提供 要求数量 时：物品.数量 >= 要求数量 才返回真（写回下标）；
   *    否则返回假，并把"需要X的NAME，你只有Y"写入 不满足时返回提示；
   *  - 遍历完未命中 → 返回假。
   *
   * 1:1 还原：遍历顺序、空数量分支、数量不足提示文本（含 文本四舍 近似为整数显示）、未命中返回假。
   * 返回值封装为 { found, index, hint } 等价原版 逻辑型 + 两个参考参数。
   *
   * @param name 物品名称
   * @param items 物品数组（每项含 名称/数量）
   * @param requireQty 要求数量（可空；空=存在即满足）
   * @returns { found: boolean; index: number; hint: string } found=是否满足，index=数组下标，hint=不满足提示
   */
  itemRequire(name: string, items: any[], requireQty?: number): { found: boolean; index: number; hint: string } {
    const result = { found: false, index: -1, hint: '' };
    if (!Array.isArray(items)) return result;
    for (let a = 0; a < items.length; a++) {
      if (items[a] && items[a].名称 === name) {
        if (requireQty == null) {
          // 原版 L1794-1796：未提供要求数量 → 存在即满足，写回下标返回真
          result.index = a;
          result.found = true;
          return result;
        } else {
          if ((items[a].数量 ?? 0) >= requireQty) {
            // 原版 L1798-1800：数量满足 → 写回下标返回真
            result.index = a;
            result.found = true;
            return result;
          } else {
            // 原版 L1802：数量不足 → 写回提示返回假（文本四舍 近似为整数）
            result.hint = '需要' + String(requireQty) + '的' + name + '，你只有' + Math.round(items[a].数量 ?? 0);
            result.found = false;
            return result;
          }
        }
      }
    }
    // 原版 L1810-1811：遍历完未命中 → 返回假
    return result;
  }
}
