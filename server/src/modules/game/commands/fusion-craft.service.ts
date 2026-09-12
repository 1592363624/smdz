/**
 * 合成/融合/培育指令域服务（game 模块化重构 P2-3 抽出）
 *
 * 职责：锻造、融合（融合23 系列：王伤害/选定特效）、培育、炼金，
 *       以及融合词条/特效数据读写（rewriteFusionData/getFusionEffects 等）。
 * 依赖方向：依赖 Player、Map、StaticData、ItemSystem、Item、Shortcut 与支撑层
 *       （itemQuantity/deductBackpackItem 背包出口、round2Text 展示）；不依赖其他指令域子服务。
 * 单一真相源：背包扣减统一支撑层 deductBackpackItem；数量读取统一 itemQuantity；
 *       数值展示统一 game-text.util.formatDisplayNumber（round2Text）。
 * 对口原版：_主程序.ecode 融合/炼金/培育分支。
 */import { Injectable, Logger } from '@nestjs/common';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { PlayerService } from '.././player.service';
import { ItemService } from '.././item.service';
import { MapService } from '.././map.service';
import { ItemSystemService } from '.././item-system.service';
import { StaticDataService } from '.././static-data.service';
import { ShortcutService } from '.././shortcut.service';
import { GameSupportService } from '.././game-support.service';

@Injectable()
export class FusionCraftService {
  private readonly logger = new Logger(FusionCraftService.name);

  constructor(
    private readonly support: GameSupportService,
    private readonly playerService: PlayerService,
    private readonly itemService: ItemService,
    private readonly mapService: MapService,
    private readonly itemSystemService: ItemSystemService,
    private readonly staticData: StaticDataService,
    private readonly shortcutService: ShortcutService,
  ) {}

  async handleForge(userId: number, itemName: string, count = 1): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 如果没有指定物品名，显示所有锻造配方（静态配置 JSON 单一来源）
    if (!itemName) {
      const recipes = this.staticData.getAllCraftings();
      const forgeRecipes = recipes.filter((r: any) =>
        r.name.includes('剑') || r.name.includes('甲') || r.name.includes('盔') ||
        r.name.includes('盾') || r.name.includes('装备') || r.name.includes('武器'),
      );

      if (forgeRecipes.length === 0) {
        return '当前没有可用的锻造配方';
      }

      const lines = ['🔨 锻造配方:', `━━━━━━━━━━━━━━━`];
      for (const recipe of forgeRecipes) {
        const reqs = asJsonValue<any[]>(recipe.requirements, []);
        const outputs = asJsonValue<any[]>(recipe.outputs, []);
        const reqText = reqs.map((r: any) => `${r.name}×${r.count || r.quantity || 1}`).join(', ');
        const outText = outputs.map((o: any) => `${o.name}×${o.count || o.quantity || 1}`).join(', ');
        lines.push(`【${recipe.name}】`);
        lines.push(`  需求: ${reqText}`);
        lines.push(`  产出: ${outText}`);
        if (recipe.level > 1) lines.push(`  等级要求: ${recipe.level}`);
      }
      lines.push(``);
      lines.push(`使用「锻造 配方名」进行锻造`);
      return lines.join('\n');
    }

    return this.itemSystemService.craftItem(userId, itemName, count);
  }

  /**
   * 处理育种命令
   * 消耗种子培育新品种（简化版：消耗种子，产出作物）
   */

  async handleMerge(userId: number, targetName: string, fusionArgs: string[] = []): Promise<string> {
    const normalizedTarget = String(targetName || '').trim();

    // 原版 L8606-8613：无参数显示融合23 帮助文案。
    if (!normalizedTarget) {
      return this.fusionHelpText(userId);
    }

    // 原版 L8615：到整数(wa[1])，非数字解析为 0 → 编号校验统一失败。
    if (!/^-?\d+$/.test(normalizedTarget)) {
      return this.handleFusion23(userId, 0, fusionArgs);
    }
    return this.handleFusion23(userId, Number(normalizedTarget), fusionArgs);
  }

  /** 原版 _主程序.ecode L8607-8613：融合23 帮助文案（#融合 无参数）。 */

  async fusionHelpText(userId: number): Promise<string> {
    const { player } = await this.playerService.getPlayerData(userId);
    const playerName = player?.name || '冒险者';
    return [
      `${playerName}\n◆“融合23 0”来清除掉装备上的特效，无消耗。`,
      `◆“融合23 42”来为前面的装备添加汪酱的暴击伤害属性，后面那个装备必须是汪酱\n会覆盖原来已经融合的暴击伤害。每次消耗3凭证`,
      `◆当前地图没有【神之工匠】存在时：\n“融合23”来强行激活装备的特效，重复激活会覆盖。每次消耗1凭证、1灵石。`,
      `——————\n◆当前地图存在【神之工匠】时：\n“融合23 -1”来强行激活装备的特效，重复激活会覆盖。无消耗`,
      `“融合23”来把一件装备的品质从【传说】提升为【神迹】。如果这件装备除暴击伤害之外的属性数量为4，则还会额外添加一个属性。消耗3灵石。成功率10%(未成功时，如果这件装备没有特效，则激活特效)。`,
      `“融合23 自选”来手动选择一个特效添加给装备指定的装备，消耗的灵石为武器/装备特效总数的三分之一(四舍五入)`,
      `“融合23 修正”来手动选择一个除去暴击伤害之外的属性少于常规数量的装备，为其修正`,
    ].join('\n');
  }

  /**
   * 原版 _主程序.ecode L8603-L8992：融合23。
   * 参数为背包编号，第二参数对应 0/-1/42/自选/修正 等分支。
   */

  async handleFusion23(userId: number, backpackNumber: number, args: string[]): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;
    const playerName = player.name || '冒险者';
    const index = backpackNumber - 1;

    if (!Number.isInteger(backpackNumber) || backpackNumber < 1 || index >= backpack.length) {
      return `${playerName}你背包里面没有这么多东西或者输入了0`;
    }

    const item = backpack[index];
    const modeText = (args || []).join(' ').trim();
    const mode = modeText.replace(/\s+/g, ' ');

    // 融合23 0：无消耗移除装备特效。
    if (mode === '0') {
      if (item.type !== '装备') return `${playerName}，${item.name}不是装备`;
      if (!this.fusionHasEffect(item)) return `${playerName}这个装备没有特效`;
      item.data = this.rewriteFusionData(item, undefined, 0);
      player.backpack = backpack; // Json 列直接写数组
      await this.playerService.savePlayer(player);
      return `${playerName}移除了${item.name}的特效`;
    }

    // 融合23 修正：补齐少于常规数量的属性，不消耗材料。
    if (mode === '修正') {
      if (item.type !== '装备' || this.isFusionAmplifier(item)) {
        return `${playerName}需要指定正常装备`;
      }
      const changed = this.correctFusionAttributes(item);
      if (changed) {
        player.backpack = backpack; // Json 列直接写数组
        await this.playerService.savePlayer(player);
        return `${playerName}这件装备不太正常，不过不用担心，我已经帮你修好了！`;
      }
      return `${playerName}这件装备很正常，不需要修正哦`;
    }

    // 融合23 自选[特效编号]：神之工匠处指定覆盖一个特效。
    if (mode === '自选' || /^自选\s*-?\d+$/.test(mode)) {
      return this.handleFusion23SelectedEffect(userId, player, backpack, index, item, mode);
    }

    // 融合23 42：把第二件“汪酱”的暴击伤害覆盖到第一件装备上。
    if (/^-?\d+$/.test(mode) && Number(mode) !== 0 && Number(mode) !== -1) {
      return this.handleFusion23WangDamage(player, backpack, index, Number(mode));
    }

    if (mode === '-1') {
      if (item.type !== '装备') return `${playerName}，${item.name}不是装备`;
      if (this.isFusionAmplifier(item)) {
        return `${playerName}，增幅器的话……我可不敢随便对它动刀啊！`;
      }
      const map = await this.mapService.getMapById(player.mapId);
      if (!this.hasFusionArtisan(map)) {
        return `${playerName}你想让神之工匠帮你激活装备特效，可是她早已经离开了此处。`;
      }
      item.data = this.rewriteFusionData(item, undefined, this.randomFusionEffectId(item));
      player.backpack = backpack; // Json 列直接写数组
      await this.playerService.savePlayer(player);
      return `${playerName}激活了${item.name}的特效`;
    }

    // 无第二参数：有神之工匠时尝试造神；没有神之工匠时按原版低成本激活特效。
    const map = await this.mapService.getMapById(player.mapId);
    if (!this.hasFusionArtisan(map)) {
      return this.activateFusionEffectWithoutArtisan(player, backpack, item);
    }

    if (item.type !== '装备') {
      return `${playerName}，你给我的这玩意连装备都不是啊！`;
    }
    if (this.isFusionAmplifier(item)) {
      return `${playerName}，增幅器的话……我可不敢随便对它动刀啊！`;
    }
    const qualityPrefix = String(item.data || '').charAt(0);
    if (qualityPrefix !== 's') {
      return `${playerName}，你这件装备${item.name}不是传说品质的哦，换一件吧。`;
    }

    const spirit = backpack.find((entry: any) => (entry?.name ?? entry?.名称) === '灵石');
    const spiritCount = this.support.itemQuantity(spirit);
    if (spiritCount < 3) {
      return `${playerName}，嗯你这样让我很为难啊……(必要的强化材料为3个灵石，你只有${this.support.round2Text(spiritCount)})`;
    }

    this.support.deductBackpackItem(backpack, '灵石', 3);
    if (Math.random() < 0.1) {
      item.data = this.upgradeFusionData(item);
      player.backpack = backpack; // Json 列直接写数组
      await this.playerService.savePlayer(player);
      return `${playerName}造神成功！${item.name}升级为了【神迹】。`;
    }

    // 原版失败时只有没有特效的装备才获得补偿特效，已经有特效则保持原样。
    const hadEffect = this.fusionHasEffect(item);
    if (!hadEffect) {
      item.data = this.rewriteFusionData(item, undefined, this.randomFusionEffectId(item));
    }
    player.backpack = backpack; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    return hadEffect
      ? `${playerName}，非常抱歉，好像失败了……`
      : `${playerName}，非常抱歉，好像失败了……\n我给你弄了个别的作为补偿。`;
  }


  async activateFusionEffectWithoutArtisan(player: any, backpack: any[], item: any): Promise<string> {
    const playerName = player.name || '冒险者';
    if (item.type !== '装备') return `${playerName}，${item.name}不是装备`;
    if (this.isFusionAmplifier(item)) {
      return `${playerName}，增幅器的话……我可不敢随便对它动刀啊！`;
    }
    const spirit = backpack.find((entry: any) => (entry?.name ?? entry?.名称) === '灵石');
    const certificate = backpack.find((entry: any) => (entry?.name ?? entry?.名称) === '凭证');
    const spiritCount = this.support.itemQuantity(spirit);
    const certificateCount = this.support.itemQuantity(certificate);
    if (spiritCount < 1 || certificateCount < 1) {
      return `${playerName}激活装备特效需要1个灵石和1个凭证，你只有灵石${this.support.round2Text(spiritCount)}、凭证${this.support.round2Text(certificateCount)}`;
    }
    this.support.deductBackpackItem(backpack, '灵石', 1);
    this.support.deductBackpackItem(backpack, '凭证', 1);
    item.data = this.rewriteFusionData(item, undefined, this.randomFusionEffectId(item));
    player.backpack = backpack; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    return `${playerName}激活了${item.name}的特效`;
  }


  async handleFusion23WangDamage(player: any, backpack: any[], sourceIndex: number, wangNumber: number): Promise<string> {
    const playerName = player.name || '冒险者';
    const wangIndex = wangNumber - 1;
    if (sourceIndex === wangIndex) return `${playerName}不能指定同一个`;
    if (wangNumber < 1 || wangIndex >= backpack.length) {
      return `${playerName}指定的编号不正确，小于1或者大于背包物品总数`;
    }
    const source = backpack[sourceIndex];
    const wang = backpack[wangIndex];
    if (source.type !== '装备' || wang.name !== '汪酱') {
      return `${playerName}${source.name}不是装备或者${wang.name}不是汪酱`;
    }
    if (this.isFusionAmplifier(source)) return `${playerName}增幅器不可以。`;
    const certificate = backpack.find((entry: any) => (entry?.name ?? entry?.名称) === '凭证');
    if (this.support.itemQuantity(certificate) < 3) return `${playerName}每次需要消耗3凭证`;

    const wangBonus = this.itemService.parseEquipment(wang).bonus?.['暴击伤害'] || 0;
    source.data = this.setFusionBonus(source, 'bw', wangBonus);
    backpack.splice(wangIndex, 1);
    this.support.deductBackpackItem(backpack, '凭证', 3);
    player.backpack = backpack; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    return `${playerName},${source.name}获得了${this.support.round2Text(wangBonus)}%暴击伤害`;
  }


  async handleFusion23SelectedEffect(
    userId: number,
    player: any,
    backpack: any[],
    index: number,
    item: any,
    mode: string,
  ): Promise<string> {
    const playerName = player.name || '冒险者';
    if (item.type !== '装备') return `${playerName}${item.name}不是装备`;
    const map = await this.mapService.getMapById(player.mapId);
    if (!this.hasFusionArtisan(map)) return `${playerName}周围没有神之工匠`;
    const effects = this.getFusionEffects(item);
    const numberMatch = mode.match(/^自选\s*(-?\d+)$/);
    const selected = numberMatch ? Number(numberMatch[1]) : 0;
    if (selected <= 0) {
      if (effects.length === 0) return `${playerName}当前没有可用的装备特效`;
      const shortcuts = effects.map((effect) => `${effect.id}@融合${index + 1} 自选${effect.id}`).join('#');
      if (this.shortcutService?.setTempInput) await this.shortcutService.setTempInput(userId, shortcuts);
      return `${playerName}选择要附加在${item.name}上的特效(需消耗${Math.round(effects.length / 3)}灵石):\n` +
        effects.map((effect) => `${effect.id}、${effect.row.name}`).join('\n');
    }
    const effect = effects.find((candidate) => candidate.id === selected);
    if (!effect) return `${playerName}指定的编号超过装备特效数量`;
    if (this.itemService.parseEquipment(item).specialEffect === selected) {
      return `${playerName}${item.name}已经是这个特效了`;
    }
    const cost = Math.round(effects.length / 3);
    const spirit = backpack.find((entry: any) => (entry?.name ?? entry?.名称) === '灵石');
    if (this.support.itemQuantity(spirit) < cost) {
      return `${playerName}需要${cost}个灵石，你只有${this.support.round2Text(this.support.itemQuantity(spirit))}`;
    }
    this.support.deductBackpackItem(backpack, '灵石', cost);
    item.data = this.rewriteFusionData(item, undefined, selected);
    player.backpack = backpack; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    return `${playerName}激活了${item.name}的特效【${effect.row.name}】`;
  }


  hasFusionArtisan(map: any): boolean {
    if (!map) return false;
    const parse = (value: any): any[] => Array.isArray(value)
      ? value
      : asJsonValue<any[]>(value, []);
    return [...parse(map.summons), ...parse(map.npcs)].some((unit: any) =>
      (unit?.name ?? unit?.名称) === '神之工匠'
      || (unit?.qq ?? unit?.QQ) === 'npc1g'
      || (unit?.type ?? unit?.类型) === '神之工匠',
    );
  }


  isFusionAmplifier(item: any): boolean {
    return String(item?.name ?? item?.名称 ?? '').startsWith('增幅器')
      || String(item?.name ?? item?.名称 ?? '').includes('增幅器');
  }


  fusionHasEffect(item: any): boolean {
    return String(item?.data || '').split('!').some((segment) =>
      /^bx\d+$/.test(segment) && Number(segment.substring(2)) > 0,
    );
  }


  isFusionWeapon(item: any): boolean {
    const definition = this.staticData.getEquipmentByName(item?.name || '');
    if (!definition) return false;
    if (typeof this.staticData.isWeapon === 'function') return this.staticData.isWeapon(definition);
    return String(definition.equipType || '').endsWith('武器');
  }


  getFusionEffects(item: any): Array<{ id: number; row: any }> {
    const weapon = this.isFusionWeapon(item);
    const effects = weapon
      ? (typeof (this.staticData as any).getWeaponEffects === 'function'
        ? (this.staticData as any).getWeaponEffects()
        : this.staticData.getAllEffects().filter((row: any) => !row?.limit || row.limit === '武器'))
      : (typeof (this.staticData as any).getEquipmentEffects === 'function'
        ? (this.staticData as any).getEquipmentEffects()
        : this.staticData.getAllEffects().filter((row: any) => !row?.limit || row.limit === '装备'));
    return effects.map((row: any, index: number) => ({ id: index + 1, row }));
  }


  randomFusionEffectId(item: any): number {
    const effects = this.getFusionEffects(item);
    if (effects.length === 0) return 0;
    return effects[Math.floor(Math.random() * effects.length)].id;
  }


  fusionDataParts(item: any): { prefix: string; segments: string[] } {
    const parts = String(item?.data || '').split('!');
    return { prefix: parts.shift() || 'e', segments: parts.filter(Boolean) };
  }


  rewriteFusionData(item: any, prefix?: string, effect?: number): string {
    const parts = this.fusionDataParts(item);
    const nextSegments = parts.segments.filter((segment) => !segment.startsWith('bx'));
    if (effect && effect > 0) nextSegments.push(`bx${effect}`);
    return `${prefix || parts.prefix}${nextSegments.length ? '!' + nextSegments.join('!') : ''}`;
  }


  setFusionBonus(item: any, code: string, value: number): string {
    const parts = this.fusionDataParts(item);
    const segments = parts.segments.filter((segment) => !segment.startsWith(code));
    if (value) segments.push(`${code}${value}`);
    return `${parts.prefix}${segments.length ? '!' + segments.join('!') : ''}`;
  }


  upgradeFusionData(item: any): string {
    const parts = this.fusionDataParts(item);
    const effectSegments = parts.segments.filter((segment) => segment.startsWith('bx'));
    const segments = parts.segments.filter((segment) => !segment.startsWith('bx'));
    const propertyCount = () => segments.filter((segment) => {
      const code = segment.substring(0, 2);
      return code !== 'bw' && code !== '@@' && code !== 'bx';
    }).length;
    if (propertyCount() <= 4) {
      const additions: Array<[string, number]> = [
        ['aw', 10], ['by', 9], ['bu', 10], ['az', 4], ['bd', 4],
      ];
      const addition = additions.find(([code]) => !segments.some((segment) => segment.startsWith(code)));
      if (addition) segments.unshift(`${addition[0]}${addition[1]}`);
    }
    const finalSegments = [...segments, ...effectSegments];
    return `x${finalSegments.length ? '!' + finalSegments.join('!') : ''}`;
  }


  correctFusionAttributes(item: any): boolean {
    const parts = this.fusionDataParts(item);
    const segments = parts.segments;
    const propertyCount = () => segments.filter((segment) => {
      const code = segment.substring(0, 2);
      return code !== 'bw' && code !== '@@' && code !== 'bx';
    }).length;
    const limit = parts.prefix === 'x' ? 5 : 4;
    if (propertyCount() >= limit) return false;
    const additions: Array<[string, number]> = [
      ['aw', 4], ['by', 4], ['bu', 4], ['bd', 4], ['az', 4],
    ];
    const addition = additions.find(([code]) => !segments.some((segment) => segment.startsWith(code)));
    const changed = Boolean(addition && propertyCount() < limit);
    if (changed && addition) segments.unshift(`${addition[0]}${addition[1]}`);
    if (changed) item.data = `${parts.prefix}${segments.length ? '!' + segments.join('!') : ''}`;
    return changed;
  }

  /**
   * 处理锻造命令
   * 消耗材料锻造装备，从制造配方中查找锻造配方
   */

  async handleBreed(userId: number, targetName: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    // 如果没有指定目标，显示背包中的种子
    if (!targetName) {
      const seeds = backpack.filter((item: any) =>
        item.name.includes('种子') || item.type === '种子',
      );
      if (seeds.length === 0) {
        return '背包中没有种子，无法育种\n可以尝试从商店购买或在地图上采集';
      }
      const lines = ['🌱 可育种的种子:', `━━━━━━━━━━━━━━━`];
      for (const seed of seeds) {
        lines.push(`  ${seed.name} ×${seed.count || 1}`);
      }
      lines.push(``);
      lines.push(`使用「育种 种子名」进行育种`);
      return lines.join('\n');
    }

    // 检查背包中是否有该种子
    const seedItem = backpack.find((item: any) => item.name === targetName);
    if (!seedItem) {
      return `背包中没有【${targetName}】`;
    }

    // 消耗种子
    const count = seedItem.count || 1;
    if (count <= 1) {
      const idx = backpack.indexOf(seedItem);
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      seedItem.count = count - 1;
    }

    // 根据种子名称推断产出作物
    const cropName = targetName.replace('种子', '');
    const productName = cropName || `${targetName}产物`;
    await this.playerService.addToBackpack(userId, productName, 2);

    // 保存背包
    player.backpack = backpack;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 育种了 ${targetName} → ${productName}×2`);
    return `🌱 育种成功！\n消耗 1 个【${targetName}】\n获得 2 个【${productName}】`;
  }

  // ========== 使魔系统命令 ==========

  /**
   * 处理使魔技能命令
   * 显示当前使魔的技能等级、特性、主动技能说明和好感度解锁效果
   * 对应原版：_主程序.ecode L4086-L4106 + 数据显示.ecode L1770-L1846 显示使魔技能()
   */

  async handleAlchemy(userId: number, recipeName: string, count = 1): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 如果没有指定配方名，显示所有炼丹配方（静态配置 JSON 单一来源）
    if (!recipeName) {
      const recipes = this.staticData.getAllCraftings();
      const alchemyRecipes = recipes.filter((r: any) =>
        r.name.includes('丹') || r.name.includes('药') || r.name.includes('丸'),
      );

      if (alchemyRecipes.length === 0) {
        return '当前没有可用的炼丹配方';
      }

      const lines = ['🔥 炼丹配方:', `━━━━━━━━━━━━━━━`];
      for (const recipe of alchemyRecipes) {
        const reqs = asJsonValue<any[]>(recipe.requirements, []);
        const outputs = asJsonValue<any[]>(recipe.outputs, []);
        const reqText = reqs.map((r: any) => `${r.name}×${r.count || r.quantity || 1}`).join(', ');
        const outText = outputs.map((o: any) => `${o.name}×${o.count || o.quantity || 1}`).join(', ');
        lines.push(`【${recipe.name}】`);
        lines.push(`  需求: ${reqText}`);
        lines.push(`  产出: ${outText}`);
        if (recipe.level > 1) lines.push(`  等级要求: ${recipe.level}`);
      }
      lines.push(``);
      lines.push(`使用「炼丹 配方名」进行炼制`);
      return lines.join('\n');
    }

    // 炼丹与普通制造共用完整物品系统，保持 count/quantity 双格式兼容。
    return this.itemSystemService.craftItem(userId, recipeName, count);
  }

  /**
   * 处理融合命令
   * 原版 _主程序.ecode L8603-9001：「融合」即融合23 体系，仅对装备生效，
   * 参数必须是背包 1-based 编号；数字编号分发到 handleFusion23。
   * 原版对非数字参数（如物品名）按 到整数=0 处理，统一落到 L8617
   * 「你背包里面没有这么多东西或者输入了0」报错。
   * 历史版本曾在此实现「2个同名物品→1个名称+物品」的自创融合；
   * 该玩法不存在于原版，且带+产物在物品表中无定义（无法使用、无任何效果，
   * 仅白白消耗材料），已按对齐原版原则移除。
   */
}
