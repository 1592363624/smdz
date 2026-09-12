/**
 * 装备/强化/植入/增幅器指令域服务（game 模块化重构 P2-6 抽出）
 *
 * 职责：装备/卸下/切换武器、装备强化与词条、装备预设（保存/删除/切换）、
 * 武器维修、植入体（查看/切换/重置）、增幅器（查看/切换/强化/重置）、
 * 被动效果、查看装备/对比/仓库。
 * 依赖方向：依赖 ItemSystemService（强化唯一入口 applyEquipReinforce）、
 * ItemService、Player、CombatState、StaticData、支撑层（hasEquippedSpecial、
 * getBackpackDisplayItems、incrementMarker、mutatePlayer、hasEquip 等）；不依赖其他指令域子服务。
 * 单一真相源：强化计算唯一入口 ItemSystemService.applyEquipReinforce；
 * 强化展示统一 formatReinforcedEquipAttrs；品质展示统一 equipmentQualityLabel；
 * 背包展示顺序统一支撑层 getBackpackDisplayItems。
 * 对口原版：_主程序.ecode 装备/强化/植入/增幅器分支。
 */import { Injectable, Logger } from '@nestjs/common';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { lookupFromStaticData, mergeBackpackItem } from '.././item-normalize.util';
import { filterActive, remainSeconds } from '.././expire-time.util';
import { resolveEquipmentRefIndex } from '.././equipment-ref.util';
import { PlayerService } from '.././player.service';
import { ItemService } from '.././item.service';
import { ItemSystemService } from '.././item-system.service';
import { StaticDataService } from '.././static-data.service';
import { CombatStateService } from '.././combat-state.service';
import { GameSupportService } from '.././game-support.service';

@Injectable()
export class EquipCommandService {
  private readonly logger = new Logger(EquipCommandService.name);

  constructor(
    private readonly support: GameSupportService,
    private readonly playerService: PlayerService,
    private readonly itemService: ItemService,
    private readonly itemSystemService: ItemSystemService,
    private readonly staticData: StaticDataService,
    private readonly combatState: CombatStateService,
  ) {}

  async handleEquip(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const items = this.playerService.getBackpackItems(player);

    const normalizedName = String(itemName || '').trim();
    if (!normalizedName) return '请指定要装备的物品名称';

    // 数字入参：「背包」列表=资源在前、装备在后（getBackpackDisplayItems），
    // N = 展示列表序号（与 handleInventory 输出同源；equipItem 需要 1-based 全背包编号，此处做映射）
    if (/^\d+$/.test(normalizedName)) {
      const displayItems = this.support.getBackpackDisplayItems(items);
      const idx = Number(normalizedName) - 1;
      if (idx < 0 || idx >= displayItems.length) return `背包中没有【${itemName}】`;
      return this.itemService.equipItem(userId, items.indexOf(displayItems[idx]) + 1);
    }

    // 名称定位统一走 equipment-ref.util 单一实现（与「锁定装备/解锁」同源）：
    //   整名精确 → 基础名+品质码（带品质码不降级为任意品质，2026-09-06 品质错配事故）
    //   → 剥掉·特效后缀的基础名 → 背包显示全名（冰雹S·绝对零度）。
    // 2026-09-10：此前本方法内联了一份「末尾字母品质码」正则，锁定/解锁各写一套，
    // 属双重表示；现三处共用同一解析器，后续修品质口径只需改一处。
    const index = resolveEquipmentRefIndex(items, normalizedName, {
      displayName: (item: any) => this.itemService.formatEquipmentInventoryDisplay(item),
    });
    if (index < 0) return `背包中没有【${itemName}】`;

    // ItemService 使用 1-based 背包编号；这里的数组下标是 0-based。
    return this.itemService.equipItem(userId, index + 1);
  }

  /**
   * 处理卸下装备命令
   */

  async handleUnequip(userId: number, slot: string): Promise<string> {
    return this.itemService.unequipItem(userId, slot);
  }

  /**
   * 处理查看技能命令
   */

  async handleSwitchWeapon(userId: number, weaponName: string): Promise<string> {
    return this.itemSystemService.switchWeapon(userId, weaponName || '');
  }

  /**
   * 处理强化植入体命令
   * 对应原版：物品操作.ecode 强化植入体()，参数格式"属性名+次数"（如"攻击3"/"3"）
   */

  async handleEquipEnhance(userId: number, arg: string): Promise<string> {
    // 读改写整体进用户写队列、基于活态执行（见 mutatePlayer 注释）。
    // 旧实现在锁外裸读档 → 末尾把 markers/backpack 整列用旧快照覆盖：读到的是
    // 「上一次落库时的行」，同一指令内/并发写入活态但尚未落库的改动（好感、使用计数…
    // ）会被整体抹掉。正式库实证：7960 剑圣 13:53-13:54 连续执行「强化武器100/强化脚部100」
    // 后，markers 里的「使用巧克力」计数与「剑圣好感」被抹回更早的旧值。
    return this.support.mutatePlayer(userId, async (ctx: any) => {
    const { player } = ctx;
    const markers: Record<string, number> = ctx.markers
      ?? asJsonValue<Record<string, number>>(player.markers, {});

    // 无参数：显示强化说明（含祥瑞气息各等级消耗）
    if (!arg) {
      return `${player.name || '冒险者'}，「强化头部」消耗合金来强化对应使魔装备位置\n「强化30」来强化背包中的法宝：\n0-2级时，升级需要2祥瑞气息\n3-5级时，升级需要3祥瑞气息\n6-8级时，升级需要5祥瑞气息\n9级时，升级需要10祥瑞气息`;
    }

    const items = this.playerService.getBackpackItems(player);
    const numMatch = arg.match(/\d+/);
    const num = numMatch ? parseInt(numMatch[0], 10) : 0;
    const part = arg.replace(/\d+/g, '').trim();

    // 只输入了数字：强化法宝（耐久+1，最高9级）
    if (!part) {
      if (num < 1 || num > items.length) {
        return `${player.name || '冒险者'}你的背包没有第${num}个物品`;
      }
      const item = items[num - 1];
      if ((item.type || '') !== '法宝') {
        return `${player.name || '冒险者'}，${item.name}不是法宝`;
      }
      let level = item.durability ?? item.level ?? 0;
      if (level > 9) {
        return `${player.name || '冒险者'}已经强化到了顶级`;
      }
      // 按当前等级确定所需祥瑞气息数量
      const cost = level < 3 ? 2 : level < 6 ? 3 : level < 9 ? 5 : 10;
      const auraItem = items.find((it: any) => it.name === '祥瑞气息');
      const auraCount = auraItem ? (auraItem.count || 0) : 0;
      if (auraCount < cost) {
        return `${player.name || '冒险者'}需要${cost}祥瑞气息来强化${item.name}，你只有${auraCount}`;
      }
      // 扣除祥瑞气息
      if (auraCount === cost) {
        items.splice(items.indexOf(auraItem), 1);
      } else {
        auraItem.count = auraCount - cost;
      }
      item.durability = level + 1;
      player.backpack = items; // Json 列直接写数组
      await this.playerService.savePlayer(player);
      return `${player.name || '冒险者'}消耗${cost}祥瑞气息强化了${item.name}（+${level + 1}）`;
    }

    // 输入了部位名：强化装备部位基础属性（消耗合金，每次消耗当前强化等级数量）
    const validParts = ['头部', '饰品', '肩膀', '上身', '手臂', '手掌', '腰部', '背部', '下身', '腿部', '腿环', '脚部', '武器'];
    if (!validParts.includes(part)) {
      // 原版文案是「玩家名+不是可以强化的部位。」（称呼前缀风格，缺逗号易歧义读成
      // 「玩家名这个部位」）；主语改为用户输入的名称，语义直指非法强化目标。
      // 2026-09-09 用户实测「强化动力头盔」回「剑圣不是可以强化的部位」确认歧义。
      return `${part}不是可以强化的部位。`;
    }
    const current = this.playerService.getMarkerValue(markers, `${part}强化`);
    if (num === 0) {
      return `${player.name || '冒险者'}「强化${part}10」来强化`;
    }
    const alloyItem = items.find((it: any) => it.name === '合金');
    let alloyCount = alloyItem ? (alloyItem.count || 0) : 0;
    let used = 0;
    let done = 0;
    let level = current;
    // 逐次强化：第1次消耗0合金（level=0时足够），随后每次消耗当前等级数
    for (let i = 0; i < num; i++) {
      if (alloyCount >= level) {
        alloyCount -= level;
        used += level;
        level++;
        done++;
      } else {
        break;
      }
    }
    if (done === 0) {
      return `${player.name || '冒险者'}强化${part}需要${level}合金，你只有${alloyCount}`;
    }
    // 扣除合金
    if (alloyItem && used > 0) {
      if (alloyItem.count === used) {
        items.splice(items.indexOf(alloyItem), 1);
      } else {
        alloyItem.count -= used;
      }
    }
    markers[`${part}强化`] = level;
    player.backpack = items; // Json 列直接写数组
    player.markers = markers; // Json 列直接写对象
    await this.playerService.savePlayer(player);
    return `${player.name || '冒险者'}用${used}合金强化了${part}${done}次，升到了${level}级`;
    });
  }

  /**
   * 装备加成
   * 对应原版：装备加成（_主程序.ecode L4210-L4220）
   * 汇总当前已装备装备（含当前武器）提供的全部属性加成
   * @param userId 用户ID
   * @param itemName 参数（兼容保留，不影响查询）
   * @returns 加成汇总文本
   */

  async handleEquipBonus(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const equipment = asJsonValue<any[]>(player.equipment, []);
    const weapons = asJsonValue<any[]>(player.weapons, []);

    // 累加装备的加成/自带属性到总加成
    const total: Record<string, number> = {};
    const addBonus = (src: any) => {
      if (!src || typeof src !== 'object') return;
      for (const key of Object.keys(src)) {
        const v = Number(src[key]);
        if (isFinite(v) && v !== 0) {
          total[key] = (total[key] || 0) + v;
        }
      }
    };

    // 原始数据串（name/data）不含加成结构，必须经 parseEquipment 解析：
    // 附加加成编码在 data 串、自带加成来自静态定义、特效加成由 data 串 bx 段叠加。
    const addParsed = (raw: any) => {
      addBonus(raw?.bonus);
      addBonus(raw?.baseBonus);
      addBonus(raw?.self);
      try {
        const parsed = this.itemService.parseEquipment(raw);
        addBonus(parsed.bonus);
        addBonus(parsed.baseBonus);
      } catch {
        // 解析失败（非装备物品）时仅按原始字段累加
      }
    };

    for (const eq of equipment) {
      addParsed(eq);
    }
    const currentWeapon = player.currentWeapon || 0;
    if (currentWeapon > 0 && weapons[currentWeapon - 1]) {
      addParsed(weapons[currentWeapon - 1]);
    }

    // 展示常用加成字段
    const fieldLabels: [string, string][] = [
      ['攻击', '攻击'], ['生命', '生命'], ['装甲', '装甲'], ['护盾', '护盾'],
      ['速度', '速度'], ['闪避', '闪避'], ['命中', '命中'], ['暴击', '暴击'],
      ['暴击伤害', '暴击伤害'], ['生命回复', '生命回复'], ['护盾回复', '护盾回复'],
      ['装甲回复', '装甲回复'], ['掉落率', '掉落率'], ['掉落品质', '掉落品质'],
      ['减益', '减益'], ['魅力', '魅力'], ['韧性', '韧性'],
    ];

    const lines = [`${player.name || '冒险者'}来自装备的属性:`];
    let hasAny = false;
    for (const [key, label] of fieldLabels) {
      if (total[key]) {
        lines.push(`${label}: +${Math.round(total[key])}`);
        hasAny = true;
      }
    }
    if (!hasAny) {
      lines.push('（当前没有装备提供属性加成）');
    }
    return lines.join('\n');
  }

  /**
   * 装备预设管理
   * 对应原版：装备预设（_主程序.ecode L4156-L4206）
   * 支持：无参数查看列表、新建预设、删除预设（装备回背包）、数字查看预设详情
   * @param userId 用户ID
   * @param action 操作参数（空=列表 / 新建名称 / 删除序号 / 序号）
   * @param args 附加参数
   * @returns 操作结果文本
   */

  async handleEquipPreset(userId: number, action: string, args: string[]): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const presets = asJsonValue<any[]>(player.equipmentPresets, []);

    // 删除预设：装备回到背包
    if (action.startsWith('删除')) {
      const idx = parseInt(action.replace('删除', '').trim(), 10);
      if (isNaN(idx) || idx < 1 || idx > presets.length) {
        return `${player.name || '冒险者'}「装备预设删除1」来删除第1个装备预设，里面的装备会回到背包`;
      }
      const target = presets[idx - 1];
      presets.splice(idx - 1, 1);
      const backpack = this.playerService.getBackpackItems(player);
      for (const eq of target.equipment || []) mergeBackpackItem(backpack, eq, lookupFromStaticData(this.staticData));
      player.equipmentPresets = presets; // Json 列直接写数组
      player.backpack = backpack; // Json 列直接写数组
      await this.playerService.savePlayer(player);
      return `${player.name || '冒险者'}删除了装备预设「${target.name}」，装备回到了背包`;
    }

    // 新建预设
    if (action.startsWith('新建')) {
      const name = action.replace('新建', '').trim();
      if (!name) {
        return `${player.name || '冒险者'}「装备预设新建生命套」来新建一个名为生命套的装备预设`;
      }
      if (name.length > 12) {
        return '预设名称过长（最多12个字符）';
      }
      if (presets.some((p: any) => p.name === name)) {
        return `已存在名为「${name}」的装备预设`;
      }
      presets.push({ name, equipment: [] });
      player.equipmentPresets = presets; // Json 列直接写数组
      await this.playerService.savePlayer(player);
      return `${player.name || '冒险者'}新建了一个装备预设：${name}，「切换预设${name}」来切换`;
    }

    // 数字：查看指定预设的详情（含装备强化后的总加成）
    const idx = parseInt(action, 10);
    if (!isNaN(idx) && action.trim() !== '') {
      if (idx < 1 || idx > presets.length) {
        return this.listEquipPresets(player, presets);
      }
      const preset = presets[idx - 1];
      const total = await this.calcPresetBonus(player, preset);
      const bonusText = this.formatBonusText(total);
      const eqText = (preset.equipment || [])
        .map((e: any) => `  ${e.name}`)
        .join('\n');
      return `${player.name || '冒险者'}，装备预设「${preset.name}」\n装备：\n${eqText || '（空）'}\n总加成：\n${bonusText || '（无加成）'}`;
    }

    // 无操作：显示预设列表
    return this.listEquipPresets(player, presets);
  }

  /**
   * 显示装备预设列表
   * @param player 玩家对象
   * @param presets 预设数组
   */

  listEquipPresets(player: any, presets: any[]): string {
    if (presets.length === 0) {
      return `${player.name || '冒险者'}，你可以把装备放到[装备预设]里面，可以快速一键批量换装\n「装备预设新建生命套」来新建一个名为生命套的装备预设`;
    }
    const lines = [`${player.name || '冒险者'}，你可以把装备放到[装备预设]里面，可以快速一键批量换装`];
    presets.forEach((p: any, i: number) => {
      lines.push(`${i + 1}、${p.name}（${(p.equipment || []).length}件）`);
    });
    lines.push(`「切换预设预设名」来切换`);
    lines.push(`「装备预设新建名称」新建、「装备预设删除序号」删除`);
    return lines.join('\n');
  }

  /**
   * 计算预设装备的总加成（含装备强化效果）
   * 对应原版：解析装备 + 计算装备强化 + 叠加加成
   * @param player 玩家对象
   * @param preset 预设
   */

  async calcPresetBonus(player: any, preset: any): Promise<Record<string, number>> {
    const markers = asJsonValue<any>(player.markers, {});
    const total: Record<string, number> = {};
    const addBonus = (src: any) => {
      if (!src || typeof src !== 'object') return;
      for (const key of Object.keys(src)) {
        const v = Number(src[key]);
        if (isFinite(v) && v !== 0) {
          total[key] = (total[key] || 0) + v;
        }
      }
    };

    for (const item of preset.equipment || []) {
      try {
        // 强化唯一实现（熟练度键映射 / 增幅器排除 / 系数出口全在 itemSystemService）：
        // 与装备栏展示链、战斗结算链同源，禁在此重拼 `xxx强化` 键；verbose=true 保留逐件诊断日志
        const eq = this.itemService.parseEquipment(item);
        this.itemSystemService.applyEquipReinforce(
          { type: eq.type, name: eq.name, self: eq.baseBonus, bonus: eq.bonus },
          markers,
          eq.type === '武器',
          true,
        );
        addBonus(eq.baseBonus);
        addBonus(eq.bonus);
      } catch {
        // 解析失败跳过该装备
      }
    }
    return total;
  }

  /**
   * 格式化加成对象为可读文本
   * @param bonus 加成对象
   */

  formatBonusText(bonus: Record<string, number>): string {
    const fieldLabels: [string, string][] = [
      ['攻击', '攻击'], ['生命', '生命'], ['装甲', '装甲'], ['护盾', '护盾'],
      ['速度', '速度'], ['闪避', '闪避'], ['命中', '命中'], ['暴击', '暴击'],
      ['暴击伤害', '暴击伤害'], ['生命回复', '生命回复'], ['护盾回复', '护盾回复'],
      ['装甲回复', '装甲回复'], ['掉落率', '掉落率'], ['掉落品质', '掉落品质'],
      ['减益', '减益'], ['魅力', '魅力'], ['韧性', '韧性'],
    ];
    const lines: string[] = [];
    for (const [key, label] of fieldLabels) {
      if (bonus[key]) {
        lines.push(`${label}: +${Math.round(bonus[key])}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * 活跃度商店
   * 对应原版：活跃度商店 命令
   */

  async handlePresetSwitch(userId: number, presetName: string): Promise<string> {
    // 尝试先作为保存操作处理（格式：save:预设名）
    if (presetName.startsWith('save:') || presetName.startsWith('保存:')) {
      const name = presetName.replace(/^(save:|保存:)/, '');
      return this.itemSystemService.savePreset(userId, name);
    }
    // 尝试保存为预设
    return this.itemSystemService.switchPreset(userId, presetName);
  }

  /**
   * 处理回充命令
   * 对应原版 _主程序.ecode L7001-L7010：装备护盾回充器后启动10秒回充增益，
   * 共用90秒「回充冷却」，不消耗背包物品。
   */

  async handleRepairItem(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, markers2 } = playerData;
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }
    if (!this.support.hasEquippedSpecial(playerData, '纳米注喷器', 13)) {
      return `${player.name}需要纳米注喷器`;
    }
    const remaining = { value: '' };
    const now = Date.now();
    const cooling = this.combatState.timeIntervalRequire(
      '回充冷却', 90, markers2, now, remaining, now,
    );
    if (cooling) {
      player.markers2 = markers2;
      await this.playerService.savePlayer(player);
      return `${player.name}装甲修理冷却${remaining.value}`;
    }
    this.support.incrementMarker(markers, '活跃度', 1);
    this.combatState.addMarker('修理', 10, markers2, now);
    player.markers = markers;
    player.markers2 = markers2;
    await this.playerService.savePlayer(player);
    return `${player.name}启动了纳米注喷器`;
  }

  /**
   * 处理装填命令
   * 对应原版 _主程序.ecode L7410-L7489：普拉娜超装填或管风琴装填，
   * 通过「工作」标记和延时事件完成，不消耗背包弹药。
   */

  async handleEnhanceImplant(userId: number, target: string): Promise<string> {
    return this.itemSystemService.upgradeImplant(userId, target || '');
  }

  /**
   * 处理查看植入体命令
   * 查看已安装的植入体列表
   */

  async handleViewImplant(userId: number): Promise<string> {
    return this.itemSystemService.viewImplant(userId);
  }

  /**
   * 处理切换植入体命令
   * 切换当前激活的植入体
   */

  async handleSwitchImplant(userId: number, implantName: string): Promise<string> {
    return this.itemSystemService.switchImplant(userId, implantName);
  }

  /**
   * 处理还原植入体命令
   * 还原/重置所有植入体
   */

  async handleResetImplant(userId: number): Promise<string> {
    return this.itemSystemService.resetImplant(userId);
  }

  /**
   * 处理查看增幅器命令
   * 查看已安装的增幅器列表
   */

  async handleConfirmResetImplant(userId: number): Promise<string> {
    return `✅ 已确认还原植入体等级。`;
  }

  /**
   * 确认还原增幅器等级
   * 对应原版：确认还原增幅器等级 命令
   */

  async handleViewAmplifier(userId: number): Promise<string> {
    return this.itemSystemService.viewAmplifier(userId);
  }

  /**
   * 处理切换增幅器命令
   * 切换当前激活的增幅器
   */

  async handleSwitchAmplifier(userId: number, amplifierName: string): Promise<string> {
    return this.itemSystemService.switchAmplifier(userId, amplifierName);
  }

  /**
   * 处理强化增幅器命令
   * 对应原版：物品操作.ecode 强化增幅器()，参数格式"属性名+次数"（如"攻击3"/"3"）
   */

  async handleEnhanceAmplifier(userId: number, target: string): Promise<string> {
    return this.itemSystemService.upgradeAmplifier(userId, target || '');
  }

  /**
   * 处理还原增幅器命令
   * 还原/重置所有增幅器
   */

  async handleResetAmplifier(userId: number): Promise<string> {
    return this.itemSystemService.resetAmplifier(userId);
  }

  /**
   * 处理炼丹命令
   * 消耗材料炼制丹药，从制造配方中查找炼丹配方
   */

  async handleConfirmResetAmplifier(userId: number): Promise<string> {
    return `✅ 已确认还原增幅器等级。`;
  }

  /**
   * 获取玩家名称的辅助方法
   */

  async handlePassiveEffects(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, equipment, weapons, sets } = playerData;

    const lines: string[] = [
      // 原版 _主程序.ecode L11247：「<名称>当前拥有的被动效果」；下按来源分层展示装备/武器被动
      `【${player.name || '冒险者'}】当前拥有的被动效果`,
      `━━━━━━━━━━━━━━━`,
    ];

    // 解析装备列表
    const equipList = equipment.length > 0 ? equipment : asJsonValue<any[]>(player.equipment, []);
    const weaponList = weapons.length > 0 ? weapons : asJsonValue<any[]>(player.weapons, []);

    // 显示装备被动效果
    const equipEffects: string[] = [];
    for (const eq of equipList) {
      if (eq.bonus) {
        const bonus = typeof eq.bonus === 'string' ? asJsonValue<any>(eq.bonus, {}) : eq.bonus;
        const effects = Object.entries(bonus)
          .filter(([, v]) => typeof v === 'number' && v > 0)
          .map(([k, v]) => `${k}: +${v}`);
        if (effects.length > 0) {
          equipEffects.push(`  ${eq.name}: ${effects.join(', ')}`);
        }
      }
    }
    if (equipEffects.length > 0) {
      lines.push(`◆来自装备的被动效果:`);
      lines.push(...equipEffects);
    } else {
      lines.push(`◆来自装备的被动效果: 无`);
    }

    // 显示武器特殊效果
    // 原版 数据显示.ecode L102-105：玩家只显示当前手持武器的被动效果（当前武器≠0 时才读对应武器序号）；
    // 非玩家（怪物/召唤物）才遍历全部武器。此处 client 恒为玩家，故只读当前武器。
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`◆来自武器的被动效果:`);
    const currentWeaponIdx = Number(player.currentWeapon ?? 0) - 1; // 1-based 索引转 0-based
    const currentWeap = currentWeaponIdx >= 0 ? weaponList[currentWeaponIdx] : undefined;
    if (!currentWeap) {
      // 未装备任何武器
      lines.push(`  未装备武器`);
    } else if (currentWeap.specialSeq) {
      // 当前武器带特殊被动（特殊序号≠0）才展示其效果
      const spEffect = currentWeap.specialEffect || currentWeap.description || '无特殊效果';
      lines.push(`  ${currentWeap.name}: ${spEffect}`);
    } else {
      // 已装备武器但本身不带特殊被动
      lines.push(`  ${currentWeap.name}: 无特殊被动效果`);
    }

    // 显示套装效果
    const setData = sets || asJsonValue<any>(player.sets, {});
    const setEntries = Object.entries(setData).filter(([, v]) => v && (v as number) > 0);
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`🎯 套装效果:`);
    if (setEntries.length > 0) {
      const setNames: Record<string, string> = {
        blackWedding: '黑花嫁', whiteWedding: '白花嫁', nanoSuit: '纳米生化装',
        lifeBless: '生命祝福', maid: '女仆', crown: '皇冠',
        ranger: '游骑兵', wanderer: '游侠', power: '动力',
        antiExplosion: '防爆', fearless: '无畏', assault: '强袭',
        scientist: '科学家', sleepover: '陪睡', amplifier: '增幅器',
        implant: '植入体', onePunch: '一拳', coil: '线圈',
        eveningGown: '晚礼服', reverseBunny: '逆兔女郎',
      };
      for (const [key, val] of setEntries) {
        const name = setNames[key] || key;
        lines.push(`  ${name}: 等级 ${val}`);
      }
    } else {
      lines.push(`  无套装效果`);
    }

    // 显示召唤物信息
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`👾 召唤物:`);
    const buffs = asJsonValue<any[]>(player.buffs, []);
    // 只显示仍在有效期内的召唤物，剩余时间按统一口径计算
    const summons = filterActive(buffs).filter((b: any) => b.type === 'summon' || b.name?.includes('召唤'));
    if (summons.length > 0) {
      const nowSummon = Date.now();
      for (const s of summons) {
        lines.push(`  ${s.name || '未知召唤物'} (剩余: ${remainSeconds(s, nowSummon)}秒)`);
      }
    } else {
      lines.push(`  无活跃召唤物`);
    }

    return lines.join('\n');
  }

  /**
   * 处理图鉴命令（对应原版 数据显示.ecode L2632 子程序 使魔图鉴）
   * 完整 20 分类复刻已迁移到 HandbookService，本方法仅作入口与上下文桥接。
   *
   * 用法：
   *   图鉴                → 20 分类两列菜单 + 统计串（原版 L2654）
   *   图鉴<分类名>        → 类目列表
   *   图鉴<地点>附近      → 附近地图分组
   *   图鉴<完整名称>      → 精确匹配，直达详情
   *   图鉴<关键词>        → 跨分类模糊搜索
   *   图鉴载具            → 二级入口
   *   图鉴<怪物名>详细    → 怪物详细数据（属性/装备/掉落/麻醉值，原版 L3170-3245）
   */

  async handleViewEquip(userId: number, arg: string, kind: '武器' | '装备'): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const list = kind === '武器'
      ? asJsonValue<any[]>(player.weapons, [])
      : asJsonValue<any[]>(player.equipment, []);

    // 无参数：列出已装备清单（原版无参数时提示用法，网页版直接给列表更方便）
    if (!arg) {
      if (list.length === 0) {
        return `${player.name}，你身上还没有装备任何${kind}。\n使用「背包」查看背包里的物品`;
      }
      const lines = list.map((eq: any, i: number) => {
        const cur = kind === '武器' && i === (player.currentWeapon || 0) - 1 ? ' (当前)' : '';
        return `${i + 1}. ${eq.name || '未知'}${cur}`;
      });
      return `${player.name} 身上的${kind}(${list.length}件):\n${lines.join('\n')}\n\n发送「查看${kind} 序号/名称」查看详情`;
    }

    // 带参数：按序号或名称定位装备
    const idxNum = parseInt(arg, 10);
    let item;
    if (!isNaN(idxNum) && idxNum >= 1 && idxNum <= list.length) {
      item = list[idxNum - 1];
    } else {
      item = list.find((eq: any) => eq.name === arg);
    }
    if (!item) {
      return `${player.name}，你身上未装备名称为【${arg}】的${kind}。`;
    }
    return this.itemSystemService.analyzeEquipment(userId, item.name);
  }

  /**
   * 查看保险柜内容（对应原版 _主程序.ecode L5435 `查看保险柜`）
   * 原版需要建筑【次元保险柜】才可查看，网页版暂不强制建筑要求，直接列出保险柜物品。
   * 支持带参数（序号或名称）查看单项详情。
   * @param userId 玩家ID
   * @param arg 参数（空=列表，否则为序号或物品名）
   * @returns 查看结果文本
   */

  async handleCompareEquip(userId: number, targetName: string, compareName: string): Promise<string> {
    if (!targetName || !compareName) {
      return '请指定两件要比较的装备名称，例如：比较装备 剑 盾';
    }
    return this.itemSystemService.compareEquipment(userId, targetName, compareName);
  }

  /**
   * 处理被动效果命令
   * 显示当前装备的被动效果、套装效果、武器特殊效果和召唤物信息
   * 对应原版：被动效果 命令
   */

  async handleViewSafe(userId: number, arg: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, safeBox } = playerData;
    if (!safeBox || safeBox.length === 0) {
      return `${player.name}，你的保险柜空空如也。`;
    }

    // 带参数：按序号或名称定位物品
    if (arg) {
      const idxNum = parseInt(arg, 10);
      let item;
      if (!isNaN(idxNum) && idxNum >= 1 && idxNum <= safeBox.length) {
        item = safeBox[idxNum - 1];
      } else {
        item = safeBox.find((sb: any) => sb.name === arg);
      }
      if (!item) {
        return `保险柜中没有找到【${arg}】`;
      }
      if (item.type === '装备') {
        return this.itemSystemService.analyzeEquipment(userId, item.name);
      }
      const count = item.quantity ?? item.count ?? 1;
      return `【${item.name}】×${count}${item.description ? `\n${item.description}` : ''}`;
    }

    const lines = safeBox.map((item: any, index: number) => {
      if (item.type === '装备') {
        return `${index + 1}. ${item.name} [装备]`;
      }
      const count = item.quantity ?? item.count ?? 1;
      return `${index + 1}. ${item.name} ×${count} [${item.type || '资源'}]`;
    });
    return `🔒 保险柜 (${safeBox.length}种):\n${lines.join('\n')}`;
  }

  /**
   * 处理比较装备命令
   * 比较两件装备的属性
   */
}
