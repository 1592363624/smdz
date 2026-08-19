/**
 * 使魔技能服务
 * 对应原版易语言：使魔技能.ecode
 * 完整实现所有使魔专属技能、通用技能和装备技能
 *
 * 技能列表：
 * 使魔专属技能 - 绑定特定使魔，需要当前使魔类型匹配
 * 通用/装备技能 - 需要特定装备或条件触发
 */

import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { BonusService, BonusData } from './bonus.service';
import { CombatSystemService } from './combat-system.service';
import { ItemService } from './item.service';
import { ItemSystemService } from './item-system.service';
import { MapService } from './map.service';
import { FamiliarSystemService } from './familiar-system.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { StaticDataService } from './static-data.service';
import { TaskService } from './task.service';

@Injectable()
export class FamiliarSkillsService {
  private readonly logger = new Logger(FamiliarSkillsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly bonusService: BonusService,
    private readonly combatSystem: CombatSystemService,
    private readonly itemService: ItemService,
    private readonly itemSystem: ItemSystemService,
    private readonly mapService: MapService,
    @Inject(forwardRef(() => FamiliarSystemService))
    private readonly familiarSystem: FamiliarSystemService,
    private readonly systemConfig: SystemConfigService,
    private readonly staticData: StaticDataService,
    private readonly taskService: TaskService,
  ) {}

  // ==================== 通用辅助方法 ====================

  /**
   * 技能执行入口
   * 根据技能名称路由到对应的方法
   * @param userId 用户ID
   * @param skillName 技能名称
   * @param target 可选目标参数
   * @returns 技能执行结果文本
   */
  async executeSkill(userId: number, skillName: string, target?: string): Promise<string> {
    // 先获取玩家数据，确保玩家存在
    await this.playerService.getPlayerData(userId);

    // 自动推进任务：使用技能（对应原版 使魔技能.ecode L1291 等：添加成就("使用技能",1,成就,任务)）
    await this.taskService.advance(userId, '使用技能');

    switch (skillName) {
      // 使魔专属技能
      case '六道轮回': return this.sixPaths(userId);
      case '怒吼': return this.roar(userId);
      case '万象': return this.myriadVisions(userId);
      case '誓约胜利之剑': return this.excalibur(userId);
      case 'ex': return this.excalibur(userId);
      case '鹰眼': return this.hawkEye(userId);
      case '歼灭': return this.annihilate(userId);
      case '歼灭模式': return this.annihilationMode(userId);
      case '绝对守护': return this.absoluteGuard(userId);
      case '斗转星移': return this.stellarShift(userId);
      case '火力全开': return this.fullFirepower(userId);
      case '啾啾猫猫': return this.meowAttack(userId);
      case '银龙附体': return this.silverDragonPossession(userId);
      case '斩': return this.slash(userId);
      case '会心一击': return this.criticalHit(userId);
      case '全弹发射': return this.fullSalvo(userId);
      case '光翼': return this.lightWings(userId);
      case '炮冠': return this.cannonCrown(userId);
      case '日轮': return this.solarWheel(userId);
      case '安宝加油': return this.anchorBoost(userId);
      case '灼烂歼鬼': return this.scorchedFinger(userId);
      case '冻结傀儡': return this.freezePuppet(userId);
      case '封印解除': return this.sealRelease(userId);
      case '召唤银龙': return this.summonSilverDragon(userId);
      case '形神合一': return this.spiritUnity(userId);
      case '风月入墨': return this.windMoonInk(userId);
      case '心无所扰': return this.heartUnperturbed(userId);
      case '梦倾天下': return this.dreamWorld(userId);
      case '反转童话': return this.reverseFairytale(userId);
      case '月落寸光': return this.moonlightInch(userId);

      // 通用/装备技能
      case '洗脑': return this.brainwash(userId, target);
      case '砸瓦鲁多': return this.zaWarudo(userId);
      case '训练': return this.train(userId);
      case '掌控时间': return this.timeControl(userId);
      case '召唤': return this.summon(userId, target);
      case '力量模式': return this.nanoMode(userId, 'power');
      case '速度模式': return this.nanoMode(userId, '速度');
      case '装甲模式': return this.nanoMode(userId, '装甲');
      case '隐匿模式': return this.nanoMode(userId, 'stealth');

      // 新增缺失技能
      case '安乐天使': return this.easeAngel(userId);
      case '福音书': return this.gospel(userId);
      case '启示录': return this.apocalypse(userId);
      case '铠甲合体': return this.armorCombine(userId);
      case '切换模式': return this.switchMode(userId, target);
      case '使魔挑战': return this.familiarChallenge(userId);
      case '开始挑战': return this.startChallenge(userId);
      case '复活使魔': return this.reviveFamiliar(userId);
      case '大召唤术': return this.massSummon(userId);

      default:
        return `未知技能「${skillName}」`;
    }
  }

  /**
   * 检查技能冷却
   * @param player 玩家对象
   * @param cooldownName 冷却标记名称
   * @param defaultCooldown 默认冷却时间（秒）
   * @returns 是否冷却中，以及剩余冷却文本
   */
  private checkCooldown(player: any, cooldownName: string, defaultCooldown: number): { isOnCooldown: boolean; text: string } {
    const parsedMarkers2 = this.playerService.safeJsonParse<any>(player.markers2, []);
    const markers2: any[] = Array.isArray(parsedMarkers2) ? parsedMarkers2 : [];
    const nowMs = Date.now();
    const cooldownMarker = markers2.find((m: any) => (m?.name ?? m?.名称) === cooldownName);
    const rawExpire = Number(cooldownMarker?.expireAt ?? cooldownMarker?.有效期至 ?? 0);
    const expireAtMs = rawExpire > 0 && rawExpire < 1e12 ? rawExpire * 1000 : rawExpire;
    if (cooldownMarker && expireAtMs > nowMs) {
      const remaining = Math.ceil((expireAtMs - nowMs) / 1000);
      return { isOnCooldown: true, text: `技能冷却中，剩余${remaining}秒` };
    }
    // defaultCooldown is retained for the source-compatible signature. The original
    // interval helper only checks state here; callers write the interval on success.
    void defaultCooldown;
    return { isOnCooldown: false, text: '' };
  }

  /**
   * 设置技能冷却
   * @param player 玩家对象
   * @param cooldownName 冷却标记名称
   * @param duration 冷却持续时间（秒）
   */
  private setCooldown(player: any, cooldownName: string, duration: number): void {
    const parsedMarkers2 = this.playerService.safeJsonParse<any>(player.markers2, []);
    const markers2: any[] = Array.isArray(parsedMarkers2) ? parsedMarkers2 : [];
    const now = Date.now();
    const newMarkers2 = markers2.filter((m: any) => (m?.name ?? m?.名称) !== cooldownName);
    newMarkers2.push({
      name: cooldownName,
      expireAt: now + duration * 1000,
    });
    player.markers2 = JSON.stringify(newMarkers2);
  }

  /**
   * 检查使魔类型是否匹配
   * @param player 玩家对象
   * @param expectedType 期望的使魔类型
   * @returns 是否匹配
   */
  private checkFamiliarType(player: any, expectedType: string): boolean {
    return player.type === expectedType;
  }

  /**
   * 检查已装备物品中是否有指定物品。
   * 原版「装备要求」只检查玩家当前装备；背包中的同名物品不能满足技能装备门禁。
   * @param player 玩家对象
   * @param itemName 物品名称
   * @returns 是否有该物品
   */
  private hasItem(player: any, itemName: string): boolean {
    const equipment = this.safeParse<any[]>(player.equipment, []);
    return equipment.some((item: any) =>
      String(item?.name ?? item?.名称 ?? '').trim() === itemName,
    );
  }

  /**
   * 获取好感度数值
   * @param player 玩家对象
   * @param markers 标记对象
   * @param familiarName 使魔名称
   * @returns 好感度数值
   */
  private getAffinity(markers: any, familiarName: string): number {
    return this.playerService.getMarkerValue(markers, `${familiarName}好感`);
  }

  /**
   * 添加增益效果到玩家
   * @param player 玩家对象
   * @param buffName 增益名称
   * @param duration 持续时间（秒）
   * @param extraData 额外数据
   */
  private addBuff(player: any, buffName: string, duration: number, extraData?: Record<string, any>): void {
    const buffs = this.playerService.safeJsonParse<any[]>(player.buffs, []);
    const now = Date.now() / 1000;
    const newBuffs = buffs.filter((b: any) => b.name !== buffName);
    newBuffs.push({
      name: buffName,
      expireAt: now + duration,
      ...(extraData || {}),
    });
    player.buffs = JSON.stringify(newBuffs);
  }

  /**
   * 获取技能效果倍率（基于好感度）
   * @param affinity 好感度
   * @returns 效果倍率
   */
  private getSkillEffect(affinity: number): number {
    return this.familiarSystem.getSkillEffect(affinity);
  }

  /**
   * 获取技能冷却时长（秒）
   * 对应原版：主动技能默认冷却=60秒，装备「冷却核心」时降为50秒（即 -10）。
   * 基准值与「冷却核心」削减量均从 SystemConfig 读取，便于在线调整（配置项）。
   * @param player 玩家对象（用于检测是否装备冷却核心）
   * @param base 原版基准冷却（默认60；个别技能如兰音用 60+a2、斩反向等由调用方传入已含修正的 base）
   * @returns 实际冷却秒数
   */
  private async getSkillCooldown(player: any, base: number): Promise<number> {
    const baseCd = await this.systemConfig.get<number>('game.skillCooldownBase', 60);
    const coreReduction = await this.systemConfig.get<number>('game.cooldownCoreReduction', 10);
    // 装备「冷却核心」时削减冷却（原版：a = 50 当 装备要求(玩家, #冷却核心)）
    const hasCore = this.hasItem(player, '冷却核心');
    return hasCore ? Math.max(1, baseCd - coreReduction) : baseCd;
  }

  /**
   * 好感度门槛检查
   * 对应原版多处「玩家.好感 < N → 需要N好感」拦截逻辑（斩<60、炮冠<80、兰音系<20/40/60/80/100）。
   * @param markers 玩家标记
   * @param familiarName 使魔名（用于读取「使魔名好感」）
   * @param required 所需最低好感度
   * @returns 是否达标
   */
  private checkAffinity(markers: any, familiarName: string, required: number): boolean {
    const affinity = this.getAffinity(markers, familiarName);
    return affinity >= required;
  }

  /**
   * 增益持续时间（含库洛牌+25%修正）
   * 对应原版使魔技能中统一的「a3 = 装备要求(玩家,#库洛牌) ? 1.25 : 1」逻辑：
   * 库洛牌使增益/标记时长放大25%。
   * @param player 玩家对象（用于检测是否装备库洛牌）
   * @param base 基础持续秒数
   * @returns 实际持续秒数（已含库洛牌放大）
   */
  private buffDur(player: any, base: number): number {
    return Math.floor(base * (this.hasItem(player, '库洛牌') ? 1.25 : 1));
  }

  /**
   * 获取技能等级。
   * 原版等级由“熟练度平方阈值”计算，而不是按固定经验区间折算。
   */
  private getSkillLevel(markers: any, familiarName: string): number {
    return this.playerService.getSkillLevel(markers, familiarName);
  }

  /**
   * 对应使魔技能.ecode L506-L537：计算一次技能实际获得的熟练度。
   */
  private gainSkillExperience(player: any, markers: any, extraMultiplier = 1): number {
    const familiarName = String(player.type || '');
    const currentLevel = this.getSkillLevel(markers, familiarName);
    const highestLevel = this.playerService.getMarkerValue(markers, '最高技能');
    const levelGap = Math.max(0, highestLevel - currentLevel);
    let multiplier = 1;

    const sets = this.playerService.safeJsonParse<any>(player.sets, {});
    const whiteSet = Boolean(sets.白 ?? sets.white ?? sets.whiteSet);
    if (whiteSet && this.playerService.getMarkerValue(markers, 'bj2') === 3) {
      multiplier *= 1.25;
    }

    const equipment = this.playerService.safeJsonParse<any[]>(player.equipment, []);
    if (equipment.some((item: any) => String(item?.name ?? item?.名称 ?? '').includes('创可贴'))) {
      multiplier *= 1.25;
    }

    let levelMultiplier = 1;
    const nydg = this.playerService.getMarkerValue(markers, 'nydg');
    if (nydg >= 1) {
      markers['nydg'] = nydg - 1;
      levelMultiplier = 2;
    }

    const gained = (1 + levelGap) * multiplier * levelMultiplier * extraMultiplier;
    const skillKey = `${familiarName}技能熟练度`;
    markers[skillKey] = this.playerService.getMarkerValue(markers, skillKey) + gained;
    if (familiarName !== '冥鱼') {
      const nextLevel = this.getSkillLevel(markers, familiarName);
      if (nextLevel > this.playerService.getMarkerValue(markers, '最高技能')) {
        markers['最高技能'] = nextLevel;
      }
    }
    return gained;
  }

  /** 对应使魔技能.ecode L539-L547：急救包恢复三层上限的10%。 */
  private applyFirstAid(player: any, resultLines: string[], equipmentOverride?: any[]): void {
    const equipment = equipmentOverride || this.safeParse<any[]>(player.equipment, []);
    if (!this.hasEquipped(equipment, '急救包')) return;

    const hp = Number(player.maxHp ?? player.生命 ?? 0) * 0.1;
    const shield = Number(player.maxShield ?? player.护盾 ?? 0) * 0.1;
    const armor = Number(player.maxArmor ?? player.装甲 ?? 0) * 0.1;
    player.hp = Number(player.hp ?? player.当前生命 ?? 0) + hp;
    player.shield = Number(player.shield ?? player.当前护盾 ?? 0) + shield;
    player.armor = Number(player.armor ?? player.当前装甲 ?? 0) + armor;
    resultLines.push(`恢复了${this.formatSkillNumber(shield)}护盾、${this.formatSkillNumber(armor)}装甲、${this.formatSkillNumber(hp)}生命`);
  }

  private hasEquipped(equipment: any[], itemName: string): boolean {
    return equipment.some((item: any) =>
      String(item?.name ?? item?.名称 ?? '').trim() === itemName
      || String(item?.name ?? item?.名称 ?? '').includes(itemName),
    );
  }

  /**
   * 伊芙利特技能使用的公共技能冷却，原版键名是“类型+技能冷却”，
   * 与技能名称冷却并不是同一个标记。兼容项目中秒/毫秒及中英文两套字段。
   */
  private requireFamiliarSkillCooldown(
    player: any,
    markers2: any[],
    duration: number,
    now = Date.now(),
  ): { isOnCooldown: boolean; text: string } {
    const name = `${player.type}技能冷却`;
    const normalized = markers2
      .map((marker: any) => {
        const rawExpire = Number(marker?.expireAt ?? marker?.有效期至 ?? 0);
        const expireAt = rawExpire > 0 && rawExpire < 1e12 ? rawExpire * 1000 : rawExpire;
        return { ...marker, name: marker?.name ?? marker?.名称 ?? '', expireAt };
      })
      .filter((marker: any) => marker.name && marker.expireAt > now);

    const active = normalized.find((marker: any) => marker.name === name);
    markers2.splice(0, markers2.length, ...normalized);
    if (active) {
      const seconds = Math.max(0, Math.floor((active.expireAt - now) / 1000));
      const text = seconds < 60
        ? `${seconds}秒`
        : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
      return { isOnCooldown: true, text: `${player.name}还需要${text}` };
    }

    normalized.push({ name, expireAt: now + duration * 1000 });
    markers2.splice(0, markers2.length, ...normalized);
    return { isOnCooldown: false, text: '' };
  }

  private formatSkillNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  /**
   * 读取使魔套装模式（兰音模式）
   * 对应原版 玩家.套装.兰音模式（1=标准, 2=友方召唤物同步增益）。
   * 后端将套装信息存于玩家 markers 的「套装_兰音模式」字段（无则默认1）。
   * @param markers 玩家标记
   * @param familiarName 使魔名
   * @returns 兰音模式值（1/2）
   */
  private getFamiliarSetMode(markers: any, familiarName: string): number {
    return this.playerService.getMarkerValue(markers, `套装_${familiarName}模式`) || 1;
  }

  /**
   * 给当前地图施加一个"地图增益"（对应原版 获得增益(地图列表[地图].标记3, ...)）。
   * 地图增益作用于该地图全部使魔/宠物，离开地图时由 applyMapBuffs 的 source 清理。
   * @param mapId 地图ID
   * @param buff 增益数据（name/value/duration/expireAt/source）
   */
  private async applyMapBuff(mapId: number, buff: Record<string, any>): Promise<void> {
    const map = await this.mapService.getMapById(mapId);
    if (!map) return;
    const mapBuffs: any[] = this.safeParse(map.mapBuffs, []);
    const filtered = mapBuffs.filter((b: any) => b.name !== buff.name);
    filtered.push({ ...buff, source: buff.source || 'familiarSkill', mapId });
    await this.mapService.updateDynamicFields(mapId, { mapBuffs: JSON.stringify(filtered) });
  }

  /**
   * 给当前地图的常驻怪物（spawnMonsters = 原版怪物2）施加麻醉。
   * 对应原版 形神合一/梦倾天下：把「等级*(10+技能等级)」累加到怪物当前麻醉，
   * 满麻醉上限则获得「麻醉」增益（一小时内可捕捉）。
   * @param mapId 地图ID
   * @param playerLevel 玩家等级
   * @param skillLevel 技能等级
   * @returns 逐怪物麻醉文本行
   */
  private async applyMapMonstersAnesthesia(
    mapId: number,
    playerLevel: number,
    skillLevel: number,
    anesthetistQQ?: string | number,
  ): Promise<string[]> {
    // 常驻怪物来自 GameMonster 表
    const monsters: any[] = await this.mapService.getMapMonsters(mapId);
    if (monsters.length === 0) return ['（当前地图没有可麻醉的常驻怪物）'];
    const add = playerLevel * (10 + skillLevel);
    const lines: string[] = [];
    for (const m of monsters) {
      // 原版当前麻醉属于「套装」运行时字段；bonus.当前麻醉是早期迁移留下的兼容字段。
      const setData: any = this.safeParse(m.set, {});
      const bonus: any = this.safeParse(m.bonus, {});
      const maxAnes = Number(bonus.麻醉上限 ?? bonus.maxAnesthesia ?? bonus.麻醉 ?? 0);
      const curAnes = Number(
        setData.当前麻醉
        ?? setData.currentAnesthesia
        ?? bonus.当前麻醉
        ?? bonus.currentAnesthesia
        ?? 0,
      );
      if (!maxAnes || curAnes >= maxAnes) continue; // 无麻醉上限或已满则跳过
      const next = curAnes + add;
      setData.当前麻醉 = next;
      setData.currentAnesthesia = next;
      m.set = JSON.stringify(setData);
      // 保留旧字段，兼容捕捉/存量代码直接读取 bonus.当前麻醉 的数据。
      bonus.当前麻醉 = next;
      bonus.currentAnesthesia = next;
      m.bonus = JSON.stringify(bonus);

      // 原版每次成功累加都记录麻醉者与攻击者，不只是在达到上限时记录。
      const monsterMarkers: any[] = Array.isArray(this.safeParse<any>(m.markers, []))
        ? this.safeParse<any[]>(m.markers, [])
        : Object.entries(this.safeParse<Record<string, any>>(m.markers, {}))
          .map(([name, value]) => ({ 名称: name, 数值: Number(value) || 0 }));
      const writeMarker = (name: string, value: number): void => {
        const marker = monsterMarkers.find((entry: any) => (entry?.名称 ?? entry?.name) === name);
        if (marker) {
          marker.数值 = Number(marker.数值 ?? marker.value ?? 0) + value;
        } else {
          monsterMarkers.push({ 名称: name, 数值: value });
        }
      };
      if (anesthetistQQ !== undefined) {
        writeMarker(`麻醉者${anesthetistQQ}`, 1);
        writeMarker(`攻击者${anesthetistQQ}`, 0.001);
      }
      m.markers = JSON.stringify(monsterMarkers);
      if (next >= maxAnes) {
        const markers2: any[] = Array.isArray(this.safeParse<any>(m.markers2, []))
          ? this.safeParse<any[]>(m.markers2, [])
          : [];
        const filteredMarkers2 = markers2.filter((entry: any) => (entry?.名称 ?? entry?.name) !== '麻醉');
        filteredMarkers2.push({ 名称: '麻醉', 强度: 0, 有效期至: Date.now() + 3600 * 1000 });
        m.markers2 = JSON.stringify(filteredMarkers2);
        lines.push(`${m.name}麻醉+${add}（已满，被麻醉了，一小时内可以捕捉）`);
      } else {
        lines.push(`${m.name}麻醉+${add}（${next}/${maxAnes}）`);
      }
      // 逐行写回 GameMonster 表（保留自增 id）
      await this.mapService.saveGameMonster(m);
    }
    return lines;
  }

  /**
   * 获取当前地图的友方召唤物名称列表（玩家归属的临时召唤物）。
   * 对应原版 地图列表[地图].召唤物（归属=玩家QQ，且基础生命>0）。
   * @param mapId 地图ID
   * @param ownerId 归属标识（玩家QQ或userId字符串）
   * @returns 友方召唤物名称数组
   */
  private async getAllySummons(mapId: number, ownerId: string): Promise<string[]> {
    const map = await this.mapService.getMapById(mapId);
    if (!map) return [];
    // 友方召唤物存于 GameMap.summons（tempMonsters 字段已废弃，怪物统一进 GameMonster 表）
    const summons: any[] = this.safeParse(map.summons, []);
    return summons
      .filter((s: any) => (s.归属 === ownerId || s.owner === ownerId) && (s.基础?.生命 || s.base?.hp || s.hp || 0) > 0)
      .map((s: any) => s.name);
  }

  /**
   * 给指定友方召唤物施加"下次攻击"标记（必中/穿透蓄势）。
   * 对应原版 兰音模式2 时友方召唤物也获得 心无所扰/月落寸光 效果。
   * 数据落在该召唤物的 buffs 中，由攻击引擎在下次攻击时消费。
   * @param mapId 地图ID
   * @param summonName 召唤物名称
   * @param next 下次攻击标记
   */
  private async applySummonNextAttack(mapId: number, summonName: string, next: Record<string, any>): Promise<void> {
    const map = await this.mapService.getMapById(mapId);
    if (!map) return;
    // 友方召唤物存于 GameMap.summons
    const summons: any[] = this.safeParse(map.summons, []);
    const found = summons.find((s: any) => s.name === summonName);
    if (!found) return;
    const sbuffs: any[] = this.safeParse(found.buffs, []);
    sbuffs.push({ name: '下次攻击·标记', expireAt: Math.floor(Date.now() / 1000) + 3600, ...next });
    found.buffs = JSON.stringify(sbuffs);
    await this.mapService.updateDynamicFields(mapId, { summons: JSON.stringify(summons) });
  }

  /**
   * 给玩家施加"下次攻击"型标记 buff（一次性消费）。
   * 对应原版 心无所扰(下次攻击必中)/月落寸光(下次攻击穿透蓄势)/反转童话(下次攻击反转属性)。
   * 这些不是持续增益，而是"下一次攻击生效"的标记；由战斗引擎 weaponAttack 在攻击时读取并消费清除。
   * @param player 玩家对象
   * @param name 标记名
   * @param data 标记数据（mustHitNext / nextPenetration / reverseResist 等）
   */
  private setNextAttackBuff(player: any, name: string, data: Record<string, any>): void {
    const buffs = this.playerService.safeJsonParse<any[]>(player.buffs, []);
    const now = Date.now() / 1000;
    const newBuffs = buffs.filter((b: any) => b.name !== name);
    newBuffs.push({
      name,
      expireAt: now + 3600, // 1小时内若未攻击则过期
      onceAttack: true,
      ...data,
    });
    player.buffs = JSON.stringify(newBuffs);
  }

  /**
   * 触发原版「宠物搜索物品」（使魔技能.ecode L394-L485）。
   *
   * 搜索不是一个玩家主动指令，而是玩家每次操作收尾时的后台效果：
   * 先让当前地图中属于玩家的麒麟尝试，再让高好感宠物尝试，最后遍历全部宠物。
   * @param userId 玩家 ID
   * @param timestamp 当前时间（毫秒），测试和后台补偿可传入固定值
   * @param random 随机源，保留原版数组重复项带来的权重
   */
  async searchPetItems(
    userId: number,
    timestamp = Date.now(),
    random: () => number = Math.random,
  ): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '';

    const summons = this.safeParse<any[]>(map.summons, []);
    const ownerIds = this.getPlayerOwnerIds(player, userId);
    const owned = summons.filter((summon: any) => this.summonBelongsTo(summon, ownerIds));
    if (owned.length === 0) return '';

    // 原版先单独尝试麒麟；一次成功后本轮不再让其他宠物搜索。
    for (const pet of owned) {
      if (!this.isKirinSummon(pet)) continue;
      const affinity = this.getSummonAffinity(pet, ownerIds, markers);
      // 原版 _主程序 L11576：传入“好感 - 100”，再由宠物搜索物品按 4 分之一计算几率。
      const recordedAffinity = Math.max(0, affinity - 100);
      const result = await this.searchPetItemsOnce(
        player,
        markers,
        map,
        pet,
        recordedAffinity / 4,
        true,
        timestamp,
        random,
      );
      if (result) return result;
    }

    // 原版先判断“记录好感 >= 100”，即原始好感达到 200。
    for (const pet of owned) {
      const affinity = this.getSummonAffinity(pet, ownerIds, markers);
      const recordedAffinity = Math.max(0, affinity - 100);
      if (recordedAffinity < 100) continue;
      const result = await this.searchPetItemsOnce(
        player,
        markers,
        map,
        pet,
        recordedAffinity / 4,
        false,
        timestamp,
        random,
      );
      if (result) return result;
    }

    // 普通遍历分支。原版的“白”宠物在此分支额外获得25点触发几率。
    for (const pet of owned) {
      const affinity = this.getSummonAffinity(pet, ownerIds, markers);
      const recordedAffinity = Math.max(0, affinity - 100);
      const chance = recordedAffinity / 4 + (this.summonName(pet) === '白' ? 25 : 0);
      const result = await this.searchPetItemsOnce(
        player,
        markers,
        map,
        pet,
        chance,
        false,
        timestamp,
        random,
      );
      if (result) return result;
    }

    return '';
  }

  /** 单次宠物搜索，返回空字符串表示未触发或仍在冷却。 */
  private async searchPetItemsOnce(
    player: any,
    markers: any,
    map: any,
    pet: any,
    chance: number,
    isKirin: boolean,
    timestamp: number,
    random: () => number,
  ): Promise<string> {
    if (chance <= 0 || random() * 100 >= chance) return '';

    const recordedCharm = Math.max(0, this.playerService.getMarkerValue(markers, '活力2') - 100);
    const cooldown = 600 / (1 + recordedCharm / 200);
    const nowSeconds = timestamp > 1e12 ? timestamp / 1000 : timestamp;
    const markers2 = this.safeParse<any[]>(player.markers2 ?? player.标记2, []);
    const activeCooldown = markers2.find((marker: any) => {
      if (this.markerName(marker) !== '宠搜') return false;
      return this.markerExpirySeconds(marker) > nowSeconds;
    });
    if (activeCooldown) return '';

    let quantityMultiplier = 1 + recordedCharm / 100;
    if (isKirin) {
      const roll = Math.floor(random() * 10) + 1;
      if (roll <= 3) quantityMultiplier *= 1;
      else if (roll <= 5) quantityMultiplier *= 5;
      else quantityMultiplier *= 2;
    }

    const sets = this.safeParse<any>(player.sets ?? player.套装, {});
    const isWhiteSet = Boolean(sets.白 ?? sets.white ?? sets.whiteSet);
    if (isWhiteSet && Number(this.playerService.getMarkerValue(markers, 'bj2')) === 1) {
      quantityMultiplier *= 1.2;
    }

    let searchCount = 1;
    if (this.summonHasEquipment(pet, '小挎包') && random() * 100 < 50) {
      searchCount += 1;
    }

    const backpack = this.playerService.getBackpackItems(player);
    const foundItems: any[] = [];
    while (searchCount > 0) {
      const item = this.generatePetSearchResource(random);
      if (!item.name) break;

      const building = this.staticData.getBuildingByName(item.name);
      if (building) {
        // 原版建筑固定为1件，并额外增加一次搜索次数。
        item.quantity = 1;
        searchCount += 1;
      } else {
        item.quantity = Math.max(1, item.quantity * quantityMultiplier);
      }

      this.addPetSearchItem(backpack, item);
      foundItems.push({ ...item });
      searchCount -= 1;
    }

    let foundEquipment: any | undefined;
    if (chance >= 25) {
      const config = this.staticData.getMerchantConfig();
      const equipmentPool = this.splitWeightedText(config.equipmentText);
      const equipmentName = equipmentPool.length > 0
        ? equipmentPool[Math.floor(random() * equipmentPool.length)]
        : '';
      if (equipmentName) {
        foundEquipment = await this.itemSystem.generateMerchantEquipment(
          equipmentName,
          equipmentName === '汪酱',
        );
        backpack.push(foundEquipment);
      }
    }

    const nextMarkers2 = markers2.filter((marker: any) => this.markerName(marker) !== '宠搜');
    nextMarkers2.push({ name: '宠搜', expireAt: nowSeconds + cooldown });
    player.markers2 = JSON.stringify(nextMarkers2);
    if (player.标记2 !== undefined) player.标记2 = player.markers2;
    player.backpack = JSON.stringify(backpack);
    if (player.背包 !== undefined) player.背包 = player.backpack;
    await this.playerService.savePlayer(player);

    const petName = this.summonName(pet) || String(pet.type || '宠物');
    const displayItems = foundItems.map((item: any) => `${item.name}x${this.formatSkillNumber(item.quantity)}`);
    if (foundEquipment) displayItems.push(`${foundEquipment.name}[装备]`);
    const location = this.randomSearchLocation(map, random);
    const percent = Math.round((quantityMultiplier - 1) * 10000) / 100;
    const cooldownText = this.formatSkillNumber(cooldown);
    return `${petName}发现了${displayItems.join('、')}，带回了${location}\n` +
      `(物品数量+${this.formatSkillNumber(percent)}%)(触发几率${this.formatSkillNumber(chance)}%)(冷却${cooldownText}秒)`;
  }

  private generatePetSearchResource(random: () => number): any {
    const config = this.staticData.getMerchantConfig();
    const extra = [
      '小粉1', '糖心巧克力1', '糖心巧克力2', '糖心巧克力3',
      '小粉1', '糖心巧克力1', '糖心巧克力2', '糖心巧克力3',
      ...this.staticData.getMerchantExtraItems(),
    ];
    const pool = [
      ...this.splitWeightedText(config.itemText),
      ...extra,
    ];
    if (pool.length === 0) return { name: '', type: '资源', quantity: 1, durability: 0, data: '' };

    const raw = pool[Math.floor(random() * pool.length)] || '';
    const digits = (raw.match(/\d+/g) || []).join('');
    const quantity = digits ? (parseInt(digits, 10) || 1) : 1;
    const name = raw.replace(/\d/g, '').trim();
    return { name, type: '资源', quantity, durability: 0, data: '' };
  }

  private splitWeightedText(value: any): string[] {
    return String(value || '')
      .split(/[，,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private addPetSearchItem(backpack: any[], item: any): void {
    const existing = backpack.find((entry: any) =>
      (entry?.name ?? entry?.名称) === item.name && (entry?.type ?? entry?.类型 ?? '资源') !== '装备',
    );
    if (!existing) {
      backpack.push({ ...item });
      return;
    }

    const current = Number(existing.quantity ?? existing.数量 ?? existing.count ?? 0);
    if (existing.quantity !== undefined) existing.quantity = current + item.quantity;
    else if (existing.数量 !== undefined) existing.数量 = current + item.quantity;
    else if (existing.count !== undefined) existing.count = current + item.quantity;
    else existing.quantity = current + item.quantity;
  }

  private getPlayerOwnerIds(player: any, userId: number): Set<string> {
    return new Set([
      userId,
      player?.userId,
      player?.qqNumber,
      player?.externalId,
      player?.masterQQ,
    ].filter((value) => value !== undefined && value !== null && String(value) !== '').map(String));
  }

  private summonBelongsTo(summon: any, ownerIds: Set<string>): boolean {
    const owner = summon?.归属 ?? summon?.ownerQQ ?? summon?.owner ?? summon?.masterQQ;
    return owner !== undefined && owner !== null && ownerIds.has(String(owner));
  }

  private getSummonAffinity(summon: any, ownerIds: Set<string>, playerMarkers: any): number {
    const summonMarkers = this.safeParse<any>(summon?.markers ?? summon?.标记, {});
    for (const ownerId of ownerIds) {
      const candidates = [`好感${ownerId}`, `${ownerId}好感`];
      for (const key of candidates) {
        const value = Number(summonMarkers?.[key]);
        if (Number.isFinite(value)) return value;
      }
    }

    const direct = Number(summon?.affinity ?? summon?.好感);
    if (Number.isFinite(direct) && direct !== 0) return direct;
    const name = this.summonName(summon);
    return name ? this.playerService.getMarkerValue(playerMarkers, `${name}好感`) : 0;
  }

  private summonName(summon: any): string {
    return String(summon?.name ?? summon?.名称 ?? summon?.image ?? summon?.类型 ?? '').trim();
  }

  private isKirinSummon(summon: any): boolean {
    const vitality = Number(summon?.vitality ?? summon?.活力 ?? summon?.specialSeq ?? summon?.特殊序号);
    return vitality === -13 || this.summonName(summon) === '麒麟' || this.summonName(summon) === '神兽麒麟';
  }

  private summonHasEquipment(summon: any, itemName: string): boolean {
    const sources = [summon?.equipment, summon?.装备, summon?.equipments];
    return sources.some((source) => {
      const list = Array.isArray(source) ? source : this.safeParse<any[]>(source, []);
      return list.some((item: any) => (item?.name ?? item?.名称) === itemName);
    });
  }

  private markerName(marker: any): string {
    return String(marker?.name ?? marker?.名称 ?? '').trim();
  }

  private markerExpirySeconds(marker: any): number {
    const value = Number(marker?.expireAt ?? marker?.有效期至 ?? 0);
    return value > 1e12 ? value / 1000 : value;
  }

  private randomSearchLocation(map: any, random: () => number): string {
    const locations = [`${map?.name || '当前地图'}这里`];
    for (const connection of this.mapService.getConnections(map)) {
      if (connection?.name && connection.name !== '出口') locations.push(`${connection.name}那边`);
    }
    return locations[Math.min(locations.length - 1, Math.floor(random() * locations.length))];
  }

  private safeParse<T>(v: any, def: T): T {
    try {
      if (typeof v !== 'string') return (v as T) ?? def;
      return JSON.parse(v) as T;
    } catch {
      return def;
    }
  }

  /**
   * 统一施放战斗类技能（真正造成怪物伤害）
   * 对应原版使魔技能调用「武器攻击(..., 倍率转换(玩家, 基础倍率), "攻击文本", ...)」的链路：
   * 后端 strength 为已修正的三层战斗引擎，技能只负责传入倍率与攻击文本，由引擎统一计算三层穿透伤害。
   * 封装：调用 weaponAttack 真正扣怪物三层血 + 设置冷却 + 记录熟练度/活跃度，返回伤害结果文本。
   * @param userId 用户ID
   * @param opts.cooldownName 冷却标记名
   * @param opts.baseCooldown 基础冷却秒（会经 getSkillCooldown 应用冷却核心-10）
   * @param opts.damageMultiplier 伤害倍率%（对普通攻击的百分比，对应原版 倍率转换 结果）
   * @param opts.attackText 攻击文本（对应原版 武器攻击 第9参数，用于切换特效/暴击逻辑）
   * @param opts.allAttack 是否全体攻击
   * @param opts.familiarType 使魔类型（用于记录熟练度）
   * @returns 战斗结果文本（已含伤害/击杀/经验/掉落）
   */
  private async castCombatSkill(
    userId: number,
    opts: {
      cooldownName: string;
      baseCooldown: number;
      damageMultiplier: number;
      attackText: string;
      allAttack?: boolean;
      familiarType: string;
    },
  ): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const resultLines: string[] = [];

    // 冷却检查
    const cooldownCheck = this.checkCooldown(player, opts.cooldownName, opts.baseCooldown);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    this.applyFirstAid(player, resultLines);

    // 真正调战斗引擎造成伤害（三层穿透 + 击杀 + 经验 + 掉落）
    const result = await this.combatSystem.weaponAttack(userId, 0, {
      damageMultiplier: opts.damageMultiplier,
      attackText: opts.attackText,
      allAttack: opts.allAttack ?? false,
      // 急救包等技能效果先写入当前玩家对象；沿用同一份 PlayerData，避免
      // weaponAttack 重新从数据库读取旧血量覆盖技能恢复结果。
      attackerDataOverride: playerData,
    });

    // 设置冷却（含冷却核心-10）
    this.setCooldown(player, opts.cooldownName, await this.getSkillCooldown(player, opts.baseCooldown));

    // 记录技能熟练度与活跃度
    const markers = this.playerService.safeJsonParse<any>(player.markers, {});
    const gainedExp = this.gainSkillExperience(player, markers, 1);
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return [...resultLines, result.result, `(技能经验+${this.formatSkillNumber(gainedExp)})`]
      .filter(Boolean)
      .join('\n');
  }

  // ==================== 使魔专属技能 ====================

  /**
   * 冥鱼 - 六道轮回
   * 六种不同的攻击效果，随机触发一种
   * 对应原版：六道轮回()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async sixPaths(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '冥鱼')) {
      return '需要冥鱼才能使出六道轮回';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '六道轮回', 120);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '冥鱼');
    const effect = this.getSkillEffect(affinity);

    // 六种轮回效果
    const sixPathsEffects = [
      { name: '天道', desc: '神威如狱', multiplier: 1.5 },
      { name: '人道', desc: '因果轮回', multiplier: 1.2 },
      { name: '修罗道', desc: '杀意波动', multiplier: 1.8 },
      { name: '畜生道', desc: '弱肉强食', multiplier: 1.0 },
      { name: '饿鬼道', desc: '吞噬万物', multiplier: 1.3 },
      { name: '地狱道', desc: '永堕轮回', multiplier: 2.0 },
    ];

    // 随机选择一种轮回
    const chosen = sixPathsEffects[Math.floor(Math.random() * sixPathsEffects.length)];
    const baseDamage = 100 + Math.floor(affinity * 0.5);
    const finalDamage = Math.floor(baseDamage * effect * chosen.multiplier);

    // 设置冷却
    this.setCooldown(player, '六道轮回', 120);

    // 记录技能熟练度
    const skillKey = '冥鱼技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `【六道轮回·${chosen.name}】${chosen.desc}\n对目标造成 ${finalDamage} 点伤害（好感度加成: ${Math.round(effect * 100)}%）`;
  }

  /**
   * 龙姬 - 怒吼
   * 提升攻击力，降低防御力
   * 对应原版：怒吼()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async roar(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '龙姬')) {
      return '需要龙姬才能使出怒吼';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '怒吼', 60);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '龙姬');
    const effect = this.getSkillEffect(affinity);

    // 计算效果：攻击力提升，防御力降低
    const attackBonus = Math.floor(50 * effect);
    const defensePenalty = Math.floor(30 * effect);

    // 添加增益（攻击提升，库洛牌+25%时长）
    this.addBuff(player, '怒吼·攻', this.buffDur(player, 30), { 攻击: attackBonus });
    // 添加减益（防御降低，用负值增益表示）
    this.addBuff(player, '怒吼·防', this.buffDur(player, 30), { 防御: -defensePenalty });

    // 设置冷却
    this.setCooldown(player, '怒吼', await this.getSkillCooldown(player, 60));

    // 记录技能熟练度
    const skillKey = '龙姬技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `龙姬发出震天怒吼！\n攻击力提升 ${attackBonus} 点（持续30秒）\n防御力降低 ${defensePenalty} 点（持续30秒）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 军姬/军姬2 - 万象
   * 传送/特殊效果
   * 对应原版：万象()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async myriadVisions(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '军姬') && !this.checkFamiliarType(player, '军姬2')) {
      return '需要军姬才能使出万象';
    }

    // 军姬2：原版万象造成真实全体伤害（攻击文本"万象a"，基础倍率 200+5*等级 或 死亡时 300+7.5*等级）
    if (this.checkFamiliarType(player, '军姬2')) {
      const skillLevel = this.getSkillLevel(markers, '军姬2');
      const isDead = (player.hp || 0) <= 0;
      const mult = isDead ? Math.floor(300 + 7.5 * skillLevel) : 200 + 5 * skillLevel;
      const result = await this.castCombatSkill(userId, {
        cooldownName: '万象',
        baseCooldown: 60,
        damageMultiplier: mult,
        attackText: '【万象】',
        allAttack: true,
        familiarType: '军姬2',
      });
      // 好感分层解锁：原版「玩家.好感 >= 60 → 回血50%」
      let extra = '';
      if (this.checkAffinity(markers, '军姬2', 60)) {
        const heal = Math.floor((player.maxHp || 100) * 0.5);
        player.hp = Math.min((player.hp || 0) + heal, player.maxHp || 100);
        await this.playerService.savePlayer(player);
        extra = `\n（好感≥60 解锁：恢复 ${heal} 点生命）`;
      }
      return `【万象】空间割裂，万象之力横扫全场！\n${result}${extra}`;
    }

    // 军姬（本体）：保留原版全属性增益语义
    const cooldownCheck = this.checkCooldown(player, '万象', 180);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    const affinity = this.getAffinity(markers, player.type);
    const effect = this.getSkillEffect(affinity);

    const effects = [
      '空间扭曲，周围的一切变得模糊不清',
      '万象之力涌出，将敌人拉入异次元',
      '万象轮回，短暂提升全属性',
      '空间割裂，对周围造成伤害',
    ];
    const chosenEffect = effects[Math.floor(Math.random() * effects.length)];

    const statBonus = Math.floor(20 * effect);
    this.addBuff(player, '万象·全属性', 60, {
      attack: statBonus, 防御: statBonus, 速度: statBonus, 闪避: statBonus, 命中: statBonus,
    });

    this.setCooldown(player, '万象', await this.getSkillCooldown(player, 60));

    const skillKey = `${player.type}技能熟练度`;
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `【万象】${chosenEffect}\n全属性提升 ${statBonus} 点（持续60秒）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * Saber - 誓约胜利之剑
   * 高伤害，需要装备圣剑
   * 对应原版：誓约胜利之剑()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async excalibur(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (player.type !== 'Saber' && player.type !== 'saber') {
      return '需要Saber才能使出誓约胜利之剑';
    }

    // 检查是否装备了圣剑（原版：装备要求(玩家, #圣剑)）
    if (!this.hasItem(player, '圣剑')) {
      return '需要装备「圣剑」才能使用誓约胜利之剑';
    }

    // 原版基础倍率公式：倍率转换(玩家, 300 + 3*技能等级)
    const skillLevel = this.getSkillLevel(markers, 'Saber');
    const mult = 300 + 3 * skillLevel;

    // 真正调用战斗引擎造成伤害（三层穿透 + 击杀 + 经验 + 掉落）
    const result = await this.castCombatSkill(userId, {
      cooldownName: '誓约胜利之剑',
      baseCooldown: 60,
      damageMultiplier: mult,
      attackText: '【誓约胜利之剑】',
      familiarType: 'Saber',
    });

    return `Excalibur——誓约胜利之剑！！\n圣剑绽放出耀眼的光芒！\n${result}`;
  }

  /**
   * 恶毒 - 鹰眼
   * 提升命中，降低闪避
   * 对应原版：鹰眼()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async hawkEye(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '恶毒')) {
      return '需要恶毒才能使出鹰眼';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '鹰眼', 45);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '恶毒');
    const effect = this.getSkillEffect(affinity);

    // 提升命中，降低闪避
    const hitBonus = Math.floor(40 * effect);
    const dodgePenalty = Math.floor(20 * effect);

    this.addBuff(player, '鹰眼·命中', this.buffDur(player, 30), { 命中: hitBonus });
    this.addBuff(player, '鹰眼·闪避', this.buffDur(player, 30), { 闪避: -dodgePenalty });

    // 设置冷却
    this.setCooldown(player, '鹰眼', 45);

    // 记录技能熟练度
    const skillKey = '恶毒技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `恶毒开启鹰眼模式！\n命中率提升 ${hitBonus}%（持续30秒）\n闪避率降低 ${dodgePenalty}%（持续30秒）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 阿尔缇娜 - 歼灭
   * 冰系伤害
   * 对应原版：歼灭()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async annihilate(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '阿尔缇娜')) {
      return '需要阿尔缇娜才能使出歼灭';
    }

    // 原版基础倍率：倍率转换(玩家, 100 + 5*技能等级)
    const skillLevel = this.getSkillLevel(markers, '阿尔缇娜');
    const mult = 100 + 5 * skillLevel;

    // 真正调用战斗引擎造成伤害（三层穿透 + 击杀 + 经验 + 掉落）
    const result = await this.castCombatSkill(userId, {
      cooldownName: '歼灭',
      baseCooldown: 60,
      damageMultiplier: mult,
      attackText: '【歼灭】',
      familiarType: '阿尔缇娜',
    });

    // 好感分层解锁：原版「玩家.好感 >= 20 → 获得增益 a技能2(减伤)」
    const affinity = this.getAffinity(markers, '阿尔缇娜');
    let extra = '';
    if (this.checkAffinity(markers, '阿尔缇娜', 20)) {
      this.addBuff(player, '歼灭·减伤', 30, { damageReduction: 20 });
      extra = '\n（好感≥20 解锁：获得20%减伤，持续30秒）';
      player.markers = JSON.stringify(markers);
      await this.playerService.savePlayer(player);
    }

    return `阿尔缇娜释放冰霜之力——歼灭！\n${result}${extra}`;
  }

  /**
   * 伊卡洛斯 - 歼灭模式
   * 高伤害模式
   * 对应原版：歼灭模式()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async annihilationMode(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '伊卡洛斯')) {
      return '需要伊卡洛斯才能使出歼灭模式';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '歼灭模式', 180);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '伊卡洛斯');
    const effect = this.getSkillEffect(affinity);

    // 高伤害模式：大幅提升攻击力和暴击
    const attackBonus = Math.floor(80 * effect);
    const critBonus = Math.floor(20 * effect);

    this.addBuff(player, '歼灭模式', this.buffDur(player, 45), {
      attack: attackBonus,
      crit: critBonus,
      critDmg: Math.floor(30 * effect),
    });

    // 设置冷却
    this.setCooldown(player, '歼灭模式', await this.getSkillCooldown(player, 60));

    // 记录技能熟练度
    const skillKey = '伊卡洛斯技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `伊卡洛斯进入歼灭模式！\n攻击力提升 ${attackBonus} 点，暴击率提升 ${critBonus}%（持续45秒）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 战斗女仆 - 绝对守护
   * 无敌护盾，类似安乐天使
   * 对应原版：绝对守护()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async absoluteGuard(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '战斗女仆')) {
      return '需要战斗女仆才能使出绝对守护';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '绝对守护', 300);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '战斗女仆');
    const effect = this.getSkillEffect(affinity);

    // 无敌护盾：免疫伤害，持续时间和效果与好感度相关
    const shieldDuration = Math.floor(10 + 10 * effect); // 10~20秒

    this.addBuff(player, '绝对守护', this.buffDur(player, shieldDuration), { invincible: true });

    // 设置冷却
    this.setCooldown(player, '绝对守护', 300);

    // 记录技能熟练度
    const skillKey = '战斗女仆技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `战斗女仆展开绝对守护！\n获得无敌护盾，免疫所有伤害 ${shieldDuration} 秒\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 星尘 - 斗转星移
   * 反弹伤害
   * 对应原版：斗转星移()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async stellarShift(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '星尘')) {
      return '需要星尘才能使出斗转星移';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '斗转星移', 120);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '星尘');
    const effect = this.getSkillEffect(affinity);

    // 反弹伤害：获得反弹增益
    const reflectPercent = Math.floor(30 + 20 * effect); // 30%~70%反弹

    this.addBuff(player, '斗转星移', this.buffDur(player, 30), { 反伤: reflectPercent });

    // 设置冷却
    this.setCooldown(player, '斗转星移', await this.getSkillCooldown(player, 60));

    // 记录技能熟练度
    const skillKey = '星尘技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `星尘发动斗转星移！\n获得 ${reflectPercent}% 伤害反弹（持续30秒）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 普拉娜 - 火力全开
   * 提升攻击力
   * 对应原版：火力全开()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async fullFirepower(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '普拉娜')) {
      return '需要普拉娜才能使出火力全开';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '火力全开', 60);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '普拉娜');
    const effect = this.getSkillEffect(affinity);

    // 提升攻击力
    const attackBonus = Math.floor(60 * effect);

    this.addBuff(player, '火力全开', this.buffDur(player, 30), { 攻击: attackBonus });

    // 设置冷却
    this.setCooldown(player, '火力全开', 60);

    // 记录技能熟练度
    const skillKey = '普拉娜技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `普拉娜火力全开！\n攻击力提升 ${attackBonus} 点（持续30秒）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 花园猫 - 啾啾猫猫
   * 猫爪攻击，多段伤害
   * 对应原版：啾啾猫猫()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async meowAttack(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '花园猫')) {
      return '需要花园猫才能使出啾啾猫猫';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '啾啾猫猫', 60);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '花园猫');
    const effect = this.getSkillEffect(affinity);

    // 多段伤害：3~5次攻击
    const hitCount = 3 + Math.floor(effect * 2); // 3~5次
    const baseDamage = 30 + Math.floor(affinity * 0.3);
    let totalDamage = 0;
    const hitTexts: string[] = [];

    for (let i = 0; i < hitCount; i++) {
      const damage = Math.floor(baseDamage * effect * (0.8 + Math.random() * 0.4));
      totalDamage += damage;
      hitTexts.push(`${damage}`);
    }

    // 设置冷却
    this.setCooldown(player, '啾啾猫猫', await this.getSkillCooldown(player, 60));

    // 记录技能熟练度
    const skillKey = '花园猫技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `花园猫使出啾啾猫猫！喵喵喵~！\n连续攻击 ${hitCount} 次！伤害：${hitTexts.join('、')}\n总伤害 ${totalDamage} 点\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 古月娜 - 银龙附体
   * 提升全属性
   * 对应原版：银龙附体()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async silverDragonPossession(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '古月娜')) {
      return '需要古月娜才能使出银龙附体';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '银龙附体', 150);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '古月娜');
    const effect = this.getSkillEffect(affinity);

    // 全属性提升
    const statBonus = Math.floor(40 * effect);

    this.addBuff(player, '银龙附体', this.buffDur(player, 60), {
      attack: statBonus,
      defense: statBonus,
      speed: statBonus,
      dodge: statBonus,
      hit: statBonus,
      crit: Math.floor(10 * effect),
      critDmg: Math.floor(20 * effect),
    });

    // 设置冷却
    this.setCooldown(player, '银龙附体', await this.getSkillCooldown(player, 60));

    // 记录技能熟练度
    const skillKey = '古月娜技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `古月娜银龙附体！银色龙鳞覆盖全身！\n全属性提升 ${statBonus} 点，暴击率提升 ${Math.floor(10 * effect)}%（持续60秒）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 剑圣 - 斩
   * 高伤害单体攻击
   * 对应原版：斩()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async slash(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '剑圣')) {
      return '需要剑圣才能使出斩';
    }

    // 好感门槛：原版「玩家.好感 < 60 → 需要60好感」
    if (!this.checkAffinity(markers, '剑圣', 60)) {
      return '斩需要剑圣好感达到60才能使用';
    }

    // 检查冷却（原版：斩！冷却核心时 a=60、否则 a=50，与其他技能相反）
    const cooldownCheck = this.checkCooldown(player, '斩', 50);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 原版斩！：回满生命与护盾装甲（治疗/强化类，非直接伤害）
    const healHp = player.maxHp || 100;
    const shieldVal = Math.floor((player.maxShield || 0) + 50);
    player.hp = healHp;
    player.shield = shieldVal;
    player.maxShield = Math.max(player.maxShield || 0, shieldVal);

    // 设置冷却（原版斩！冷却核心时反而更长 60s）
    const baseCd = this.hasItem(player, '冷却核心') ? 60 : 50;
    this.setCooldown(player, '斩', baseCd);

    // 记录技能熟练度
    const skillKey = '剑圣技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `剑圣拔刀——斩！\n血气回涌，生命与护盾全部恢复（护盾+${shieldVal}）！`;
  }

  /**
   * 剑圣 - 会心一击
   * 暴击攻击
   * 对应原版：会心一击()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async criticalHit(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '剑圣')) {
      return '需要剑圣才能使出会心一击';
    }

    // 原版基础倍率：倍率转换(玩家, 200 + 10*技能等级)（攻击文本"会心一击b"在原版触发被暴击率加成）
    const skillLevel = this.getSkillLevel(markers, '剑圣');
    const mult = 200 + 10 * skillLevel;

    // 真正调用战斗引擎造成伤害（高倍率对应原版会心一击的暴击特性）
    const result = await this.castCombatSkill(userId, {
      cooldownName: '会心一击',
      baseCooldown: 60,
      damageMultiplier: mult,
      attackText: '【会心一击】',
      familiarType: '剑圣',
    });

    return `剑圣凝聚全身力量——会心一击！！\n${result}`;
  }

  /**
   * 长萌 - 全弹发射
   * 范围攻击
   * 对应原版：全弹发射()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async fullSalvo(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '长萌')) {
      return '需要长萌才能使出全弹发射';
    }

    // 原版基础倍率：倍率转换(玩家, 100 + 5*技能等级)，全体攻击
    const skillLevel = this.getSkillLevel(markers, '长萌');
    const mult = 100 + 5 * skillLevel;

    // 真正调用战斗引擎（全体攻击）造成伤害
    const result = await this.castCombatSkill(userId, {
      cooldownName: '全弹发射',
      baseCooldown: 60,
      damageMultiplier: mult,
      attackText: '【全弹发射】',
      allAttack: true,
      familiarType: '长萌',
    });

    return `长萌全弹发射！所有炮门开启！\n${result}`;
  }

  /**
   * 绝灭天使 - 光翼
   * 提升速度和闪避
   * 对应原版：光翼()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async lightWings(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '绝灭天使')) {
      return '需要绝灭天使才能使出光翼';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '光翼', 60);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '绝灭天使');
    const effect = this.getSkillEffect(affinity);

    // 提升速度和闪避
    const speedBonus = Math.floor(50 * effect);
    const dodgeBonus = Math.floor(25 * effect);

    this.addBuff(player, '光翼', this.buffDur(player, 30), {
      speed: speedBonus,
      dodge: dodgeBonus,
    });

    // 设置冷却
    this.setCooldown(player, '光翼', 60);

    // 记录技能熟练度
    const skillKey = '绝灭天使技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `绝灭天使展开光翼！\n速度提升 ${speedBonus} 点，闪避率提升 ${dodgeBonus}%（持续30秒）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 绝灭天使 - 炮冠
   * 远程攻击
   * 对应原版：炮冠()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async cannonCrown(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '绝灭天使')) {
      return '需要绝灭天使才能使出炮冠';
    }

    // 好感门槛：原版「玩家.好感 < 80 → 需要好感达到80」
    if (!this.checkAffinity(markers, '绝灭天使', 80)) {
      return '炮冠需要绝灭天使好感达到80才能使用';
    }

    // 原版炮冠为远程攻击，基础倍率约 120 + 5*技能等级
    const skillLevel = this.getSkillLevel(markers, '绝灭天使');
    const mult = 120 + 5 * skillLevel;

    // 真正调用战斗引擎造成伤害
    const result = await this.castCombatSkill(userId, {
      cooldownName: '炮冠',
      baseCooldown: 45, // 原版炮冠基础冷却45s
      damageMultiplier: mult,
      attackText: '【炮冠】',
      familiarType: '绝灭天使',
    });

    return `绝灭天使炮冠发射！\n${result}`;
  }

  /**
   * 绝灭天使 - 日轮
   * 持续伤害光环
   * 对应原版：日轮()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async solarWheel(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '绝灭天使')) {
      return '需要绝灭天使才能使出日轮';
    }

    // 原版基础倍率：倍率转换(玩家, 100 + 技能等级)（全体分摊），攻击文本"日轮a"
    const skillLevel = this.getSkillLevel(markers, '绝灭天使');
    const mult = 100 + skillLevel;

    // 真正调用战斗引擎（全体攻击）造成日轮爆发伤害
    const result = await this.castCombatSkill(userId, {
      cooldownName: '日轮',
      baseCooldown: 60,
      damageMultiplier: mult,
      attackText: '【日轮】',
      allAttack: true,
      familiarType: '绝灭天使',
    });

    // 好感分层解锁：原版「玩家.好感 >= 40 → 增加穿透 5」
    let extra = '';
    if (this.checkAffinity(markers, '绝灭天使', 40)) {
      this.addBuff(player, '日轮·穿透', 30, { penetrationBonus: 5 });
      extra = '\n（好感≥40 解锁：穿透+5，持续30秒）';
      await this.playerService.savePlayer(player);
    }

    return `绝灭天使展开日轮！炽热光芒笼罩全场！\n${result}${extra}`;
  }

  /**
   * 安克雷奇 - 安宝加油
   * 辅助增益
   * 对应原版：安宝加油()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async anchorBoost(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '安克雷奇')) {
      return '需要安克雷奇才能使出安宝加油';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '安宝加油', 90);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '安克雷奇');
    const effect = this.getSkillEffect(affinity);

    // 辅助增益：回复生命+提升防御
    const healAmount = Math.floor(100 + affinity * 0.5 * effect);
    const defenseBonus = Math.floor(30 * effect);

    // 回复生命
    player.hp = Math.min((player.hp || 0) + healAmount, player.maxHp || 100);

    // 防御提升
    this.addBuff(player, '安宝加油', 30, { 防御: defenseBonus });

    // 好感分层解锁：原版「好感>=40 → 添加标记 安宝乖乖(增益)」「好感>=60 → 烟雾弹增益」
    let extra = '';
    const a3 = this.hasItem(player, '库洛牌') ? 1.25 : 1; // 库洛牌+25% 放大增益时长
    if (this.checkAffinity(markers, '安克雷奇', 40)) {
      this.addBuff(player, '安宝乖乖', Math.floor(30 * a3), { 攻击: Math.floor(20 * effect) });
      extra += '\n（好感≥40 解锁：攻击力提升）';
    }
    if (this.checkAffinity(markers, '安克雷奇', 60)) {
      this.addBuff(player, '烟雾弹', Math.floor(15 * a3), { 闪避: Math.floor(30 * effect) });
      extra += '\n（好感≥60 解锁：烟雾弹，闪避大幅提升）';
    }

    // 设置冷却
    this.setCooldown(player, '安宝加油', 90);

    // 记录技能熟练度
    const skillKey = '安克雷奇技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `安克雷奇：安宝加油！加油！\n回复 ${healAmount} 点生命值，防御力提升 ${defenseBonus} 点（持续30秒）${extra}\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 伊芙利特 - 灼烂歼鬼
   * 火焰伤害
   * 对应原版：灼烂歼鬼()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async scorchedFinger(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 原版按特殊序号判断；名称判断是网页运行时数据的兼容回退。
    if (Number(player.specialSeq) !== 11 && player.type !== '伊芙利特') {
      return '这是伊芙利特的技能';
    }

    const equipment = playerData.equipment || this.safeParse<any[]>(player.equipment, []);
    const cooldown = this.hasEquipped(equipment, '冷却核心') ? 50 : 60;
    const cooldownCheck = this.requireFamiliarSkillCooldown(player, playerData.markers2, cooldown);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    const resultLines: string[] = [];
    this.applyFirstAid(player, resultLines, equipment);

    // 原版急救包之后直接回满三层状态，再获得30秒（库洛牌为37.5秒）增益。
    player.hp = player.maxHp;
    player.shield = player.maxShield;
    player.armor = player.maxArmor;
    const buffDuration = this.hasEquipped(equipment, '库洛牌') ? 37.5 : 30;
    this.addBuff(player, '灼烂歼鬼', buffDuration);
    playerData.buffs = this.safeParse<any[]>(player.buffs, []);

    const gainedExp = this.gainSkillExperience(player, markers, 1);
    markers['使用技能'] = this.playerService.getMarkerValue(markers, '使用技能') + 1;
    markers['活跃度'] = this.playerService.getMarkerValue(markers, '活跃度') + 1;
    player.markers = JSON.stringify(markers);
    player.markers2 = JSON.stringify(playerData.markers2);

    resultLines.push(`${player.type}开始我们的约会吧(战斗)吧！`);

    const map = await this.mapService.getMapById(player.mapId);
    const monsters = map ? await this.mapService.getMapMonsters(map) : [];
    const affinity = Math.max(
      this.getAffinity(markers, '伊芙利特'),
      Number(player.affinity || 0),
    );
    if (affinity >= 100 && monsters.length > 0) {
      const attack = await this.combatSystem.weaponAttack(userId, Number(player.currentWeapon || 0), {
        noDelay: true,
        allAttack: true,
        attackText: '空间震a',
        originalTimestamp: Date.now(),
        attackerDataOverride: playerData,
      });
      resultLines.push(attack.result);
    }

    resultLines.push(`(技能经验+${this.formatSkillNumber(gainedExp)})`);
    await this.playerService.savePlayer(player);
    return resultLines.filter(Boolean).join('\n');
  }

  /**
   * 四糸乃 - 冻结傀儡
   * 冰冻控制
   * 对应原版：冻结傀儡()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async freezePuppet(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '四糸乃')) {
      return '需要四糸乃才能使出冻结傀儡';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '冻结傀儡', 120);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '四糸乃');
    const effect = this.getSkillEffect(affinity);

    // 冰冻控制：伤害+减速
    const baseDamage = 80 + Math.floor(affinity * 0.8);
    const finalDamage = Math.floor(baseDamage * effect);
    const freezeDuration = Math.floor(5 + 5 * effect); // 5~10秒

    this.addBuff(player, '冻结傀儡·冰冻', freezeDuration, { 速度: -50 });

    // 设置冷却
    this.setCooldown(player, '冻结傀儡', 120);

    // 记录技能熟练度
    const skillKey = '四糸乃技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `四糸乃召唤冻结傀儡！\n极寒的傀儡将目标冻结，造成 ${finalDamage} 点冰系伤害\n目标被冻结 ${freezeDuration} 秒，速度大幅降低\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 小樱 - 封印解除
   * 解除封印，全属性提升
   * 对应原版：封印解除()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async sealRelease(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '小樱')) {
      return '需要小樱才能使出封印解除';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '封印解除', 180);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '小樱');
    const effect = this.getSkillEffect(affinity);

    // 全属性大幅提升
    const statBonus = Math.floor(60 * effect);

    this.addBuff(player, '封印解除', 60, {
      attack: statBonus,
      defense: statBonus,
      speed: statBonus,
      dodge: statBonus,
      hit: statBonus,
      crit: Math.floor(15 * effect),
      critDmg: Math.floor(30 * effect),
      hpRegen: Math.floor(10 * effect),
    });

    // 设置冷却
    this.setCooldown(player, '封印解除', 180);

    // 记录技能熟练度
    const skillKey = '小樱技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `小樱：封印解除！\n隐藏的力量全部释放！全属性大幅提升 ${statBonus} 点（持续60秒）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 古月娜 - 召唤银龙
   * 召唤银龙协助战斗
   * 对应原版：召唤银龙()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async summonSilverDragon(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '古月娜')) {
      return '需要古月娜才能使出召唤银龙';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '召唤银龙', 300);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '古月娜');
    const effect = this.getSkillEffect(affinity);

    // 召唤银龙：根据好感度计算银龙属性
    const dragonAttack = Math.floor(200 + affinity * 1.5 * effect);
    const dragonHp = Math.floor(1000 + affinity * 3 * effect);
    const dragonDuration = Math.floor(30 + 30 * effect); // 30~60秒

    this.addBuff(player, '银龙之魂', dragonDuration, {
      attack: Math.floor(dragonAttack * 0.3),
      defense: Math.floor(dragonAttack * 0.2),
    });

    // 设置冷却
    this.setCooldown(player, '召唤银龙', 300);

    // 记录技能熟练度
    const skillKey = '古月娜技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 15;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `古月娜召唤银龙！\n一条银色的巨龙降临战场！\n银龙属性——攻击: ${dragonAttack}，生命: ${dragonHp}\n银龙将协助战斗 ${dragonDuration} 秒\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 兰音 - 形神合一
   * 高伤害
   * 对应原版：形神合一()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async spiritUnity(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '兰音')) {
      return '需要兰音才能使出形神合一';
    }

    // 原版公共冷却：30 - 技能等级*0.5 + a2（装备冷却核心时 a2=-10）
    const skillLevel = this.getSkillLevel(markers, '兰音');
    const a2 = this.hasItem(player, '冷却核心') ? -10 : 0;
    const publicCd = 30 - skillLevel * 0.5 + a2;
    const baseCd = publicCd > 0 ? Math.ceil(publicCd) : 0; // 公共cd为0时原版会自动释放形神合一（此处作为主动技能直接释放）
    const cooldownCheck = this.checkCooldown(player, '形神合一', baseCd || 1);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度与库洛牌时长放大
    const affinity = this.getAffinity(markers, '兰音');
    const a3 = this.buffDur(player, 600); // 风月入墨持续 600*库洛牌 秒

    // 形神合一效果：
    // 1) 给当前地图所有怪物(怪物2)施加麻醉（按 等级*(10+技能等级) 累积当前麻醉，满则获得「麻醉」增益可捕捉）
    // 2) 给当前地图(标记3)施加「风月入墨」增益：使魔/宠物升级经验 -15% 持续
    // 3) 兰音模式2 时，友方召唤物也获得 心无所扰/月落寸光 效果（同步友方召唤物增益）
    let lines: string[] = ['兰音：形神合一！'];

    // 风月入墨增益作用于地图（标记3）——经验-加成，离开地图失效
    const expReduce = 15 + skillLevel * 0.25;
    try {
      await this.applyMapBuff(player.mapId, {
        name: '风月入墨',
        value: -expReduce,
        duration: a3,
        expireAt: Math.floor(Date.now() / 1000) + a3,
        source: 'familiarSkill',
      });
      lines.push(`当前地图使魔和宠物升级所需经验-${expReduce.toFixed(2)}%（持续${Math.floor(a3 / 60)}分钟，离开地图失效）`);
    } catch (e) {
      lines.push('（地图增益施加失败，已跳过）');
    }

    // 给地图怪物施加麻醉
    try {
      const anes = await this.applyMapMonstersAnesthesia(player.mapId, player.level, skillLevel, player.qqNumber ?? userId);
      if (anes.length) lines.push(anes.join('\n'));
    } catch (e) {
      lines.push('（怪物麻醉失败，已跳过）');
    }

    // 兰音模式2：友方召唤物同步获得 心无所扰/月落寸光 效果
    const lannMode = this.getFamiliarSetMode(markers, '兰音');
    if (lannMode === 2) {
      const ally = await this.getAllySummons(player.mapId, player.qq || String(userId));
      if (ally.length) {
        lines.push(`${ally.join('、')}也得到了心无所扰和月落寸光的效果`);
        // 给友方召唤物施加「必中」与「穿透蓄势」下次攻击标记
        for (const s of ally) {
          await this.applySummonNextAttack(player.mapId, s, { mustHitNext: true, nextPenetration: 5 });
        }
      }
    }

    // 记录熟练度/活跃度
    const skillKey = '兰音技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
    player.markers = JSON.stringify(markers);

    // 设置公共冷却（兰音通用）
    this.setCooldown(player, '兰音通用', baseCd || 1);
    this.setCooldown(player, '形神合一', baseCd || 1);
    await this.playerService.savePlayer(player);

    return lines.join('\n') + `\n好感度加成: ${affinity}`;
  }

  /**
   * 兰音 - 风月入墨
   * 持续伤害
   * 对应原版：风月入墨()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async windMoonInk(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '兰音')) {
      return '需要兰音才能使出风月入墨';
    }

    // 好感门槛：原版「玩家.好感 < 20 → 需要20好感」
    if (!this.checkAffinity(markers, '兰音', 20)) {
      return '风月入墨需要兰音好感达到20才能使用';
    }

    // 原版公共冷却：30 - 技能等级*0.5 + a2（冷却核心-10），独立冷却 60+a2
    const skillLevel = this.getSkillLevel(markers, '兰音');
    const a2 = this.hasItem(player, '冷却核心') ? -10 : 0;
    const publicCd = 30 - skillLevel * 0.5 + a2;
    const baseCd = publicCd > 0 ? Math.ceil(publicCd) : 1;
    const cooldownCheck = this.checkCooldown(player, '风月入墨', 60 + a2);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 原版：给当前地图(标记3)施加「风月入墨」增益——使魔/宠物升级经验 -15%，持续 600*库洛牌 秒
    const a3 = this.buffDur(player, 600);
    const expReduce = 15 + skillLevel * 0.25;
    try {
      await this.applyMapBuff(player.mapId, {
        name: '风月入墨',
        value: -expReduce,
        duration: a3,
        expireAt: Math.floor(Date.now() / 1000) + a3,
        source: 'familiarSkill',
      });
    } catch (e) {
      return '风月入墨：地图增益施加失败';
    }

    // 记录技能熟练度/活跃度
    const skillKey = '兰音技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
    player.markers = JSON.stringify(markers);

    // 设置冷却（兰音通用 + 本技能）
    this.setCooldown(player, '兰音通用', baseCd);
    this.setCooldown(player, '风月入墨', 60 + a2);
    await this.playerService.savePlayer(player);

    return `兰音风月入墨！\n${player.mapId ? '当前地图' : '地图'}的使魔和宠物升级所需经验-${expReduce.toFixed(2)}%，持续${Math.floor(a3 / 60)}分钟，受益者离开当前地图时失效`;
  }

  /**
   * 兰音 - 心无所扰
   * 清除负面状态
   * 对应原版：心无所扰()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async heartUnperturbed(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '兰音')) {
      return '需要兰音才能使出心无所扰';
    }

    // 好感门槛：原版「玩家.好感 < 40 → 需要40好感」
    if (!this.checkAffinity(markers, '兰音', 40)) {
      return '心无所扰需要兰音好感达到40才能使用';
    }

    // 原版公共冷却：30 - 技能等级*0.5 + a2
    const skillLevel = this.getSkillLevel(markers, '兰音');
    const a2 = this.hasItem(player, '冷却核心') ? -10 : 0;
    const publicCd = 30 - skillLevel * 0.5 + a2;
    const baseCd = publicCd > 0 ? Math.ceil(publicCd) : 1;
    const cooldownCheck = this.checkCooldown(player, '心无所扰', baseCd);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 原版：下次攻击有 (15+技能等级/2)% 几率无视闪避和闪避状态必中
    const mustHitChance = 15 + skillLevel / 2;
    this.setNextAttackBuff(player, '心无所扰·蓄势', { mustHitNext: true, mustHitChance });

    // 兰音模式2：友方召唤物也获得必中效果
    const lannMode = this.getFamiliarSetMode(markers, '兰音');
    let allyLine = '';
    if (lannMode === 2) {
      const ally = await this.getAllySummons(player.mapId, player.qq || String(userId));
      if (ally.length) {
        allyLine = `\n${ally.join('、')}也得到了心无所扰的效果`;
        for (const s of ally) {
          await this.applySummonNextAttack(player.mapId, s, { mustHitNext: true, mustHitChance });
        }
      }
    }

    // 记录技能熟练度/活跃度
    const skillKey = '兰音技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
    player.markers = JSON.stringify(markers);

    // 设置冷却
    this.setCooldown(player, '兰音通用', baseCd);
    this.setCooldown(player, '心无所扰', baseCd);
    await this.playerService.savePlayer(player);

    return `兰音心无所扰！\n下次攻击有 ${mustHitChance.toFixed(1)}% 几率无视闪避和闪避状态必中${allyLine}`;
  }

  /**
   * 兰音 - 梦倾天下
   * 范围伤害
   * 对应原版：梦倾天下()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async dreamWorld(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '兰音')) {
      return '需要兰音才能使出梦倾天下';
    }

    // 好感门槛：原版「玩家.好感 < 60 → 需要60好感」
    if (!this.checkAffinity(markers, '兰音', 60)) {
      return '梦倾天下需要兰音好感达到60才能使用';
    }

    // 原版公共冷却：30 - 技能等级*0.5 + a2
    const skillLevel = this.getSkillLevel(markers, '兰音');
    const a2 = this.hasItem(player, '冷却核心') ? -10 : 0;
    const publicCd = Math.max(1, 30 - skillLevel * 0.5 + a2);
    const skillCd = Math.max(1, 60 + a2);
    // 原版「时间间隔要求2」同时检查兰音公共冷却和梦倾天下专属冷却。
    const publicCooldownCheck = this.checkCooldown(player, '兰音通用', publicCd);
    if (publicCooldownCheck.isOnCooldown) return publicCooldownCheck.text;
    const skillCooldownCheck = this.checkCooldown(player, '梦倾天下', skillCd);
    if (skillCooldownCheck.isOnCooldown) return skillCooldownCheck.text;

    // 原版：下次攻击命中的目标所有属性降低【(当前麻醉÷麻醉上限)x(15+技能等级)】%，持续600*库洛牌秒
    const firstAidLines: string[] = [];
    this.applyFirstAid(player, firstAidLines, playerData.equipment);
    const a3 = this.buffDur(player, 600);
    const reducePct = 15 + skillLevel;
    const lines = await this.applyMapMonstersAnesthesia(player.mapId, player.level || 1, skillLevel, player.qqNumber ?? userId);
    let text = [...firstAidLines, `兰音梦倾天下！\n下次攻击命中的目标所有属性降低【(当前麻醉÷麻醉上限)x${reducePct}】%，持续${Math.floor(a3 / 60)}分钟`]
      .join('\n');
    if (lines.length) text += '\n' + lines.join('\n');

    // 原版使用独立的 mqtx 标记记录技能已经成功释放；不是技能熟练度。
    markers.mqtx = 1;
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
    player.markers = JSON.stringify(markers);

    // 设置双冷却；原版专属冷却为 60+a2，与公共冷却不同。
    this.setCooldown(player, '兰音通用', publicCd);
    this.setCooldown(player, '梦倾天下', skillCd);
    await this.playerService.savePlayer(player);

    return text;
  }

  /**
   * 兰音 - 反转童话
   * 反转属性
   * 对应原版：反转童话()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async reverseFairytale(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '兰音')) {
      return '需要兰音才能使出反转童话';
    }

    // 好感门槛：原版「玩家.好感 < 80 → 需要80好感」
    if (!this.checkAffinity(markers, '兰音', 80)) {
      return '反转童话需要兰音好感达到80才能使用';
    }

    // 原版公共冷却：30 - 技能等级*0.5 + a2
    const skillLevel = this.getSkillLevel(markers, '兰音');
    const a2 = this.hasItem(player, '冷却核心') ? -10 : 0;
    const publicCd = 30 - skillLevel * 0.5 + a2;
    const baseCd = publicCd > 0 ? Math.ceil(publicCd) : 1;
    const cooldownCheck = this.checkCooldown(player, '反转童话', baseCd);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 原版：下次攻击无论是否命中，有 (50+技能等级/2)% 几率将目标某个属性正负符号反转，持续 600*库洛牌 秒
    const reverseChance = 50 + skillLevel / 2;
    const a3 = this.buffDur(player, 600);
    this.setNextAttackBuff(player, '反转童话·蓄势', {
      reverseResist: true,
      reverseChance,
      reverseDuration: a3,
    });

    // 记录技能熟练度/活跃度
    const skillKey = '兰音技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 15;
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
    player.markers = JSON.stringify(markers);

    // 设置冷却
    this.setCooldown(player, '兰音通用', baseCd);
    this.setCooldown(player, '反转童话', baseCd);
    await this.playerService.savePlayer(player);

    return `兰音反转童话！\n下次攻击无论是否命中，有 ${reverseChance.toFixed(1)}% 几率将目标的某个属性正负符号反转，持续${Math.floor(a3 / 60)}分钟`;
  }

  /**
   * 兰音 - 月落寸光
   * 下次攻击计算护盾/装甲/生命抗性时，根据目标对应状态的平均抗性获得穿透增益
   * 平均值越高增益越高【(2~20)x(1+技能等级/100)%】
   * 对应原版：月落寸光()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async moonlightInch(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '兰音')) {
      return '需要兰音才能使出月落寸光';
    }

    // 好感门槛：原版「玩家.好感 < 100 → 需要100好感」
    if (!this.checkAffinity(markers, '兰音', 100)) {
      return '月落寸光需要兰音好感达到100才能使用';
    }

    // 原版公共冷却：30 - 技能等级*0.5 + a2
    const skillLevel = this.getSkillLevel(markers, '兰音');
    const a2 = this.hasItem(player, '冷却核心') ? -10 : 0;
    const publicCd = 30 - skillLevel * 0.5 + a2;
    const baseCd = publicCd > 0 ? Math.ceil(publicCd) : 1;
    const cooldownCheck = this.checkCooldown(player, '月落寸光', baseCd);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 原版：下次攻击按目标平均抗性获得穿透增益(2~20)x(1+技能等级/100)%
    // 实际穿透值由攻击引擎在命中时按目标三层平均抗性计算（见 weaponAttack → consumeNextAttackBuffs）
    this.setNextAttackBuff(player, '月落寸光·蓄势', {
      nextPenetration: true,
      skillLevelForPen: skillLevel,
    });

    // 兰音模式2：友方召唤物也获得月落寸光效果
    const lannMode = this.getFamiliarSetMode(markers, '兰音');
    let allyLine = '';
    if (lannMode === 2) {
      const ally = await this.getAllySummons(player.mapId, player.qq || String(userId));
      if (ally.length) {
        allyLine = `\n${ally.join('、')}也得到了月落寸光的效果`;
        for (const s of ally) {
          await this.applySummonNextAttack(player.mapId, s, { nextPenetration: true, skillLevelForPen: skillLevel });
        }
      }
    }

    // 记录技能熟练度/活跃度
    const skillKey = '兰音技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 15;
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
    player.markers = JSON.stringify(markers);

    // 设置冷却
    this.setCooldown(player, '兰音通用', baseCd);
    this.setCooldown(player, '月落寸光', baseCd);
    await this.playerService.savePlayer(player);

    return `兰音月落寸光！\n下次攻击计算护盾/装甲/生命抗性时，根据目标对应状态的平均抗性获得穿透增益，平均值越高增益越高（2~20）×(1+${skillLevel}/100)%${allyLine}`;
  }

  // ==================== 通用/装备技能 ====================

  /**
   * 读取原版「战斗力」所需的最终属性。
   * 玩家和 GameMonster 共享 BonusService 的计算公式；旧数据没有完整 bonus
   * 时再退回当前运行时字段，避免洗脑因为存量数据缺字段而直接变成 0%。
   */
  private getCombatPower(actor: any, playerData?: any, map?: any): number {
    const combatSystem = this.combatSystem as any;
    let bonus: any;
    try {
      if (playerData && typeof combatSystem?.buildAttackerBonus === 'function') {
        bonus = combatSystem.buildAttackerBonus(actor, playerData, map);
      } else if (!playerData && typeof combatSystem?.buildMonsterBonus === 'function') {
        // buildMonsterBonus is private in TypeScript but is the same source-of-truth
        // runtime builder used by combat; invoking it here keeps the formula aligned.
        const restored = {
          ...actor,
          hp: actor.maxHp ?? actor.hp,
          shield: actor.maxShield ?? actor.shield,
          armor: actor.maxArmor ?? actor.armor,
        };
        bonus = combatSystem.buildMonsterBonus(restored);
      }
    } catch (error: any) {
      this.logger.warn(`计算战斗力失败，回退存量属性: ${error?.message ?? error}`);
    }

    if (!bonus) bonus = this.safeParse(actor.bonus, {});
    const calculator = (this.bonusService as any)?.calcCombatPower;
    if (typeof calculator === 'function') {
      const value = Number(calculator.call(this.bonusService, bonus));
      if (Number.isFinite(value) && value > 0) return value;
    }

    const life = Number(bonus.生命 ?? actor.maxHp ?? actor.hp ?? 0);
    const shield = Number(bonus.护盾 ?? actor.maxShield ?? actor.shield ?? 0);
    const armor = Number(bonus.装甲 ?? actor.maxArmor ?? actor.armor ?? 0);
    const attack = Number(bonus.攻击 ?? actor.attack ?? 0);
    const speed = Number(bonus.速度 ?? actor.speed ?? 0);
    const hit = Number(bonus.命中 ?? actor.hit ?? 0);
    const dodge = Number(bonus.闪避 ?? actor.dodge ?? 0);
    return Math.max(1, life + shield + armor + attack + speed + hit + dodge);
  }

  /** 原版失败后的新建延时(覅攻击pd地图, 5秒)。 */
  private scheduleMapAttack(userId: number, map: any): void {
    if (typeof (this.combatSystem as any)?.adminAttackMap !== 'function') return;
    const mapArg = String(map?.mapIndex ?? map?.列表编号 ?? map?.id ?? '');
    const timer = setTimeout(() => {
      void (this.combatSystem as any).adminAttackMap(userId, mapArg).catch((error: any) => {
        this.logger.warn(`洗脑失败后的延时攻击执行失败: ${error?.message ?? error}`);
      });
    }, 5_000);
    // A delayed game event must not keep a worker alive during shutdown/tests.
    const unref = (timer as any)?.unref;
    if (typeof unref === 'function') unref.call(timer);
  }

  /**
   * 洗脑 - 需要洗脑装置
   * 对应原版：洗脑()
   * @param userId 用户ID
   * @param target 目标名称
   * @returns 技能效果文本
   */
  async brainwash(userId: number, target?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查是否有洗脑装置
    if (!this.hasItem(player, '洗脑装置')) {
      return `${player.name}需要洗脑装置`;
    }

    const monsterName = String(target ?? '').trim();
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${player.name}附近没有${monsterName}`;
    const monsters: any[] = await this.mapService.getMapMonsters(map.id);
    const targetMonster = monsters.find((m: any) => (m.name ?? m.名称) === monsterName);
    if (!targetMonster) {
      return `${player.name}附近没有${monsterName}`;
    }

    // 原版时间间隔要求在找到目标后立即写入 3600 秒冷却，成功与失败都消耗冷却。
    const cooldownCheck = this.checkCooldown(player, '洗脑冷却', 3600);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;
    this.setCooldown(player, '洗脑冷却', 3600);

    const playerPower = this.getCombatPower(player, playerData, map);
    const monsterPower = this.getCombatPower(targetMonster);
    const successRate = (playerPower / (monsterPower * 4)) * 100;
    const roundedRate = Math.round(successRate);

    if (Math.random() * 100 >= successRate) {
      this.scheduleMapAttack(userId, map);
      player.markers = JSON.stringify(markers);
      await this.playerService.savePlayer(player);
      return `${player.name}尝试洗脑${monsterName}失败了……\n成功率：${roundedRate}%`;
    }

    // 原版成功分支：怪物不获得“混乱”增益，而是转为玩家的临时宠物。
    const owner = String(player.qqNumber ?? player.QQ ?? userId);
    const oldQQ = String(targetMonster.qq ?? targetMonster.QQ ?? `怪物${targetMonster.id}`);
    const { id: _removedId, ...summon } = targetMonster as any;
    summon.specialSeq = -2;
    summon.特殊序号 = -2;
    summon.ownerQQ = owner;
    summon.owner = owner;
    summon.归属 = owner;
    summon.isPet = true;
    summon.isTemp = true;
    summon.qq = `${oldQQ}xg`;
    summon.QQ = summon.qq;
    summon.mapId = map.id;

    await this.mapService.removeMapMonster(map.id, targetMonster.id);
    const summons: any[] = this.safeParse(map.summons, []);
    summons.push(summon);
    map.summons = JSON.stringify(summons);
    await this.mapService.updateDynamicFields(map.id, { summons: map.summons });

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);
    return `${player.name}洗脑${monsterName}成功了！\n成功率：${roundedRate}%`;
  }

  /**
   * 砸瓦鲁多 - 需要女仆套装4件以上
   * 对应原版：砸瓦鲁多()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async zaWarudo(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查女仆套装数量
    const backpack = this.playerService.getBackpackItems(player);
    const maidItems = backpack.filter((item: any) => item.name.includes('女仆'));
    if (maidItems.length < 4) {
      return '需要装备至少4件女仆套装才能使用砸瓦鲁多（当前只有' + maidItems.length + '件）';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '砸瓦鲁多', 300);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度（使用当前使魔的好感度）
    const affinity = player.type ? this.getAffinity(markers, player.type) : 0;
    const effect = this.getSkillEffect(affinity);

    // 时停效果：大幅提升速度和闪避
    const speedBonus = Math.floor(100 * effect);
    const dodgeBonus = Math.floor(50 * effect);

    this.addBuff(player, '砸瓦鲁多', 10, {
      speed: speedBonus,
      dodge: dodgeBonus,
      mustHit: true,
    });

    // 设置冷却
    this.setCooldown(player, '砸瓦鲁多', 300);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `ザ·ワールド！时停吧！\n速度提升 ${speedBonus} 点，闪避率提升 ${dodgeBonus}%（持续10秒）\n冷却时间5分钟`;
  }

  /**
   * 训练 - 需要建筑训练器
   * 对应原版：训练()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async train(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查是否有训练器
    if (!this.hasItem(player, '训练器')) {
      return '需要「训练器」才能进行训练';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '训练', 3600);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = player.type ? this.getAffinity(markers, player.type) : 0;
    const effect = this.getSkillEffect(affinity);

    // 训练效果：获得经验值
    const expGain = Math.floor(50 + 50 * effect);

    // 设置冷却（1小时）
    this.setCooldown(player, '训练', 3600);

    // 增加经验
    await this.playerService.addExp(userId, expGain);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `使用训练器进行训练！\n获得 ${expGain} 点经验值（冷却1小时）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 掌控时间 - 需要时间主宰装备
   * 对应原版：掌控时间()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async timeControl(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查是否有时间主宰装备
    if (!this.hasItem(player, '时间主宰')) {
      return '需要「时间主宰」装备才能掌控时间';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '掌控时间', 600);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = player.type ? this.getAffinity(markers, player.type) : 0;
    const effect = this.getSkillEffect(affinity);

    // 时间掌控效果：缩短冷却，提升属性
    const cooldownReduction = Math.floor(20 * effect); // 冷却缩减百分比
    const statBonus = Math.floor(30 * effect);

    this.addBuff(player, '时间主宰', 30, {
      attack: statBonus,
      speed: statBonus,
      cooldown: cooldownReduction,
    });

    // 设置冷却
    this.setCooldown(player, '掌控时间', 600);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `时间在你手中流转！\n冷却缩减 ${cooldownReduction}%，全属性提升 ${statBonus} 点（持续30秒）\n冷却时间10分钟`;
  }

  /**
   * 召唤 - 需要次元手环
   * 对应原版：召唤()
   * @param userId 用户ID
   * @param target 召唤目标
   * @returns 技能效果文本
   */
  async summon(userId: number, target?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查是否有次元手环
    if (!this.hasItem(player, '次元手环')) {
      return '需要「次元手环」才能使用召唤';
    }

    if (!target) {
      return '请指定要召唤的目标';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '召唤', 120);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 真实机制：在当前地图 summons 生成一个归属于玩家的召唤物
    // 原版次元手环可召唤指定名称的使魔/宠物，此处按名称生成通用召唤物模板
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上';
    const summons: any[] = this.safeParse(map.summons, []);
    const ownerId = player.qq || String(userId);
    const summonId = `summon_${ownerId}_${Date.now()}`;
    const level = Math.max(1, (player.level || 1));
    const baseHp = 200 + level * 20;
    summons.push({
      id: summonId,
      name: target,
      type: target,
      qq: `怪物${target}${ownerId}xg`,
      owner: ownerId,
      归属: ownerId,
      基础: { 生命: baseHp },
      base: { 生命: baseHp },
      level,
      hp: baseHp,
      maxHp: baseHp,
      attack: 20 + level * 2,
      defense: 10 + level,
      speed: 100,
      dodge: 5,
      hit: 85,
      exp: 10 + level * 2,
      isPlayerSummon: true,
      buffs: '[]',
      bonus: '{}',
    });
    await this.mapService.updateDynamicFields(player.mapId, { summons: JSON.stringify(summons) });

    // 设置冷却
    this.setCooldown(player, '召唤', 120);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `使用次元手环召唤「${target}」！\n次元之门打开，召唤物降临当前地图，归属于你（冷却2分钟）`;
  }

  /**
   * 纳米生化装模式 - 需要纳米生化装6件套
   * 对应原版：力量/速度/装甲/隐匿模式()
   * @param userId 用户ID
   * @param mode 模式名称（power/speed/armor/stealth）
   * @returns 技能效果文本
   */
  async nanoMode(userId: number, mode: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查纳米生化装数量
    const backpack = this.playerService.getBackpackItems(player);
    const nanoItems = backpack.filter((item: any) => item.name.includes('纳米'));
    if (nanoItems.length < 6) {
      return '需要装备至少6件纳米生化装才能启用模式（当前只有' + nanoItems.length + '件）';
    }

    // 检查冷却
    const cooldownName = `纳米模式_${mode}`;
    const cooldownCheck = this.checkCooldown(player, cooldownName, 120);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = player.type ? this.getAffinity(markers, player.type) : 0;
    const effect = this.getSkillEffect(affinity);

    // 不同模式不同效果
    let buffName = '';
    let buffData: Record<string, any> = {};
    let modeText = '';

    switch (mode) {
      case 'power':
        buffName = '纳米·力量模式';
        buffData = { 攻击: Math.floor(80 * effect), 暴击: Math.floor(15 * effect) };
        modeText = '力量模式';
        break;
      case '速度':
        buffName = '纳米·速度模式';
        buffData = { 速度: Math.floor(80 * effect), 闪避: Math.floor(30 * effect) };
        modeText = '速度模式';
        break;
      case '装甲':
        buffName = '纳米·装甲模式';
        buffData = { 防御: Math.floor(80 * effect), 装甲: Math.floor(50 * effect) };
        modeText = '装甲模式';
        break;
      case 'stealth':
        buffName = '纳米·隐匿模式';
        buffData = { 闪避: Math.floor(50 * effect), 命中: Math.floor(30 * effect) };
        modeText = '隐匿模式';
        break;
      default:
        return `未知的纳米模式：${mode}`;
    }

    this.addBuff(player, buffName, 30, buffData);

    // 设置冷却
    this.setCooldown(player, cooldownName, 120);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    const bonusText = Object.entries(buffData)
      .map(([key, val]) => `${key} +${val}`)
      .join('，');

    return `纳米生化装切换为${modeText}！\n${bonusText}（持续30秒，冷却2分钟）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  // ==================== 新增缺失技能 ====================

  /**
   * 安乐天使 - 装备技能
   * 创造护盾保护自己，回复全部生命
   * 对应原版：安乐天使()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async easeAngel(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查是否有安乐天使装备
    if (!this.hasItem(player, '安乐天使')) {
      return '需要「安乐天使」装备才能使用此技能';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '安乐天使', 300);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = player.type ? this.getAffinity(markers, player.type) : 0;
    const effect = this.getSkillEffect(affinity);

    // 回复全部生命
    const maxHp = player.maxHp || 100;
    player.hp = maxHp;

    // 创造护盾（持续20秒）
    this.addBuff(player, '安乐天使·护盾', 20, { invincible: true, 护盾: Math.floor(500 * effect) });

    // 设置冷却
    this.setCooldown(player, '安乐天使', 300);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `安乐天使展开光环！\n生命已全部恢复，获得护盾保护（持续20秒）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 福音书 - 装备技能
   * 增益效果，增加全属性抗性
   * 对应原版：福音书()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async gospel(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查是否有福音书装备
    if (!this.hasItem(player, '福音书')) {
      return '需要「福音书」装备才能使用此技能';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '福音书', 600);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = player.type ? this.getAffinity(markers, player.type) : 0;
    const effect = this.getSkillEffect(affinity);

    // 增加全属性抗性
    const resistBonus = Math.floor(30 * effect);

    this.addBuff(player, '福音书·加护', 300, {
      shieldResist: resistBonus,
      armorResist: resistBonus,
      hpResist: resistBonus,
      strength: Math.floor(10 * effect),
    });

    // 设置冷却
    this.setCooldown(player, '福音书', 600);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `福音书绽放出神圣的光芒！\n全属性抗性提升 ${resistBonus} 点，力量提升 ${Math.floor(10 * effect)} 点（持续300秒）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 启示录 - 装备技能
   * 攻击/暴击大幅提升，持续一定时间后进入虚弱状态
   * 对应原版：启示录()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async apocalypse(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查是否有启示录装备
    if (!this.hasItem(player, '启示录')) {
      return `${player.name}需要启示录`;
    }

    // 原版按永久成就熟练度限制为每日一次，并非普通技能冷却。
    if (this.playerService.getMarkerValue(markers, '启示录') !== 0) {
      return `${player.name}一天只能使用一次`;
    }

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${player.name}不在任何地图上`;

    const markers2Raw = this.safeParse<any>(map.markers2, []);
    const markers2: any[] = Array.isArray(markers2Raw) ? markers2Raw : [];
    // 原版逻辑 L1099 疑似笔误：启示录写入“福音书”，战斗 AI 同时兼容两种名称。
    const nextMarkers2 = markers2.filter((entry: any) =>
      (entry?.name ?? entry?.名称) !== '福音书'
      && (entry?.name ?? entry?.名称) !== '启示录',
    );
    nextMarkers2.push({ name: '福音书', expireAt: Date.now() + 120 * 1000 });
    map.markers2 = JSON.stringify(nextMarkers2);
    await this.mapService.updateDynamicFields(player.mapId, { markers2: map.markers2 });

    markers['启示录'] = 1;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `${player.name}在${map.name}使用了启示录`;
  }

  /**
   * 铠甲合体 - 通用技能
   * 召唤铠甲合体，大幅提升防御和攻击，持续一定时间
   * 对应原版：铠甲合体()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async armorCombine(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '铠甲合体', 300);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = player.type ? this.getAffinity(markers, player.type) : 0;
    const effect = this.getSkillEffect(affinity);

    // 大幅提升防御和攻击（持续60秒）
    const defenseBonus = Math.floor(100 * effect);
    const attackBonus = Math.floor(80 * effect);
    const duration = Math.floor(45 + 15 * effect); // 45~60秒

    this.addBuff(player, '铠甲合体', duration, {
      defense: defenseBonus,
      attack: attackBonus,
      armor: Math.floor(50 * effect),
    });

    // 设置冷却
    this.setCooldown(player, '铠甲合体', 300);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `铠甲合体！装甲覆盖全身！\n防御力提升 ${defenseBonus} 点，攻击力提升 ${attackBonus} 点，装甲强化 ${Math.floor(50 * effect)} 点（持续${duration}秒）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 切换模式 - 通用技能
   * 使魔模式切换（攻击/防御/速度等），不同模式提供不同加成
   * 对应原版：切换模式()
   * @param userId 用户ID
   * @param mode 模式名称（attack/defense/speed/balance）
   * @returns 技能效果文本
   */
  async switchMode(userId: number, mode?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!mode) {
      return '请指定模式：攻击模式、防御模式、速度模式、平衡模式';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '切换模式', 120);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = player.type ? this.getAffinity(markers, player.type) : 0;
    const effect = this.getSkillEffect(affinity);

    let buffName = '';
    let buffData: Record<string, any> = {};
    let modeText = '';

    switch (mode) {
      case '攻击模式':
        buffName = '模式·攻击';
        buffData = { 攻击: Math.floor(100 * effect), 暴击: Math.floor(20 * effect), 防御: -Math.floor(30 * effect) };
        modeText = '攻击模式';
        break;
      case '防御模式':
        buffName = '模式·防御';
        buffData = { 防御: Math.floor(100 * effect), 装甲: Math.floor(60 * effect), 攻击: -Math.floor(30 * effect) };
        modeText = '防御模式';
        break;
      case '速度模式':
        buffName = '模式·速度';
        buffData = { 速度: Math.floor(100 * effect), 闪避: Math.floor(30 * effect), 攻击: -Math.floor(20 * effect) };
        modeText = '速度模式';
        break;
      case '平衡模式':
        buffName = '模式·平衡';
        buffData = { 攻击: Math.floor(40 * effect), 防御: Math.floor(40 * effect), 速度: Math.floor(40 * effect) };
        modeText = '平衡模式';
        break;
      default:
        return `未知模式：${mode}，可用模式：攻击模式、防御模式、速度模式、平衡模式`;
    }

    this.addBuff(player, buffName, 60, buffData);

    // 设置冷却
    this.setCooldown(player, '切换模式', 120);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    const bonusText = Object.entries(buffData)
      .map(([key, val]) => `${key} ${val > 0 ? '+' : ''}${val}`)
      .join('，');

    return `切换为${modeText}！\n${bonusText}（持续60秒，冷却2分钟）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 使魔挑战 - 通用技能
   * 进入使魔挑战模式，连续战斗获得奖励
   * 对应原版：使魔挑战()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async familiarChallenge(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.type) {
      return '请先选择使魔才能进入挑战模式';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '使魔挑战', 600);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = player.type ? this.getAffinity(markers, player.type) : 0;
    const effect = this.getSkillEffect(affinity);

    // 设置使魔挑战模式标记
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const now = Date.now() / 1000;
    const newMarkers2 = markers2.filter((m: any) => m.name !== '使魔挑战');
    newMarkers2.push({
      name: '使魔挑战',
      expireAt: now + 3600, // 挑战模式持续1小时
      wave: 1,
      score: 0,
    });
    player.markers2 = JSON.stringify(newMarkers2);

    // 设置冷却
    this.setCooldown(player, '使魔挑战', 600);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    const maxWaves = 5 + Math.floor(effect * 5); // 5~10波

    return `【使魔挑战】${player.name || '冒险者'} 进入挑战模式！\n需要连续击败 ${maxWaves} 波敌人\n使用「开始挑战」来开始第一波战斗\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  /**
   * 开始挑战 - 通用技能
   * 开始使魔挑战，生成挑战怪物
   * 对应原版：开始挑战()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async startChallenge(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查是否在挑战模式中
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const challengeMarker = markers2.find((m: any) => m.name === '使魔挑战');
    const now = Date.now() / 1000;

    if (!challengeMarker || challengeMarker.expireAt <= now) {
      return '你不在挑战模式中，请先使用「使魔挑战」进入挑战模式';
    }

    // 获取当前波次
    const currentWave = challengeMarker.wave || 1;
    const maxWaves = 10;

    if (currentWave > maxWaves) {
      // 挑战完成，结算奖励
      const score = challengeMarker.score || 0;
      const rewardExp = Math.floor(50 + score * 2);

      // 清除挑战标记
      const newMarkers2 = markers2.filter((m: any) => m.name !== '使魔挑战');
      player.markers2 = JSON.stringify(newMarkers2);

      // 发放奖励
      await this.playerService.addExp(userId, rewardExp);

      // 增加活跃度
      markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
      player.markers = JSON.stringify(markers);
      await this.playerService.savePlayer(player);

      return `【挑战完成】你成功击败了全部 ${maxWaves} 波敌人！\n最终得分: ${score}\n获得经验: ${rewardExp}`;
    }

    // 生成挑战怪物（根据波次增加难度）
    const monsterLevel = currentWave * 5;
    const monsterHp = 100 + currentWave * 50;
    const monsterAttack = 10 + currentWave * 8;
    const monsterDefense = 5 + currentWave * 3;

    // 更新波次
    challengeMarker.wave = currentWave + 1;
    challengeMarker.score = (challengeMarker.score || 0) + currentWave * 10;
    const newMarkers2 = markers2.filter((m: any) => m.name !== '使魔挑战');
    newMarkers2.push(challengeMarker);
    player.markers2 = JSON.stringify(newMarkers2);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;
    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `【第 ${currentWave} 波】挑战开始！\n出现了一只 Lv.${monsterLevel} 的挑战怪物\nHP: ${monsterHp} | 攻击: ${monsterAttack} | 防御: ${monsterDefense}\n击败后进入下一波（剩余 ${maxWaves - currentWave} 波）`;
  }

  /**
   * 复活使魔 - 通用技能
   * 复活死亡的使魔，消耗一定资源
   * 对应原版：复活使魔()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async reviveFamiliar(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.type) {
      return '你还没有选择使魔';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '复活使魔', 86400);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 检查消耗资源（需要钻石或特殊物品）
    const backpack = this.playerService.getBackpackItems(player);
    const diamondItem = backpack.find((item: any) => item.name === '钻石');
    const diamondCount = diamondItem ? (diamondItem.count || 0) : 0;

    // 需要50钻石或1个觉醒丹
    const hasAwakenPill = backpack.some((item: any) => item.name === '觉醒丹');

    if (diamondCount < 50 && !hasAwakenPill) {
      return '复活使魔需要50钻石或1个觉醒丹';
    }

    // 扣除资源
    if (hasAwakenPill) {
      // 扣除觉醒丹
      const idx = backpack.findIndex((item: any) => item.name === '觉醒丹');
      if (idx !== -1) {
        const item = backpack[idx];
        if (item.count && item.count > 1) {
          item.count -= 1;
        } else {
          backpack.splice(idx, 1);
        }
      }
      player.backpack = JSON.stringify(backpack);
    } else {
      // 扣除钻石
      if (diamondCount === 50) {
        const idx = backpack.findIndex((item: any) => item.name === '钻石');
        if (idx !== -1) backpack.splice(idx, 1);
      } else {
        diamondItem!.count = diamondCount - 50;
      }
      player.backpack = JSON.stringify(backpack);
    }

    // 回复使魔生命
    player.hp = player.maxHp || 100;

    // 设置冷却（24小时）
    this.setCooldown(player, '复活使魔', 86400);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    const resourceText = hasAwakenPill ? '1个觉醒丹' : '50钻石';
    return `消耗了${resourceText}，${player.type} 已复活！\n生命已全部恢复（冷却24小时）`;
  }

  /**
   * 大召唤术 - 通用技能
   * 批量召唤使魔，消耗资源
   * 对应原版：大召唤术()
   * @param userId 用户ID
   * @returns 技能效果文本
   */
  async massSummon(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '大召唤术', 3600);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 检查消耗资源（需要10张召唤券）
    const backpack = this.playerService.getBackpackItems(player);
    const ticketItem = backpack.find((item: any) => item.name === '召唤券');
    const ticketCount = ticketItem ? (ticketItem.count || 0) : 0;

    if (ticketCount < 10) {
      return `大召唤术需要10张召唤券，你只有${ticketCount}张`;
    }

    // 获取所有可召唤的使魔（静态配置 JSON 单一来源）
    const allFamiliars = this.staticData.getAllFamiliars().filter((f) => !f.noSummon);

    if (allFamiliars.length === 0) {
      return '没有可召唤的使魔';
    }

    // 批量召唤：消耗10张召唤券，召唤5次
    const summonCount = 5;
    const summonedItems: string[] = [];

    for (let i = 0; i < summonCount; i++) {
      const randomIndex = Math.floor(Math.random() * allFamiliars.length);
      const chosenFamiliar = allFamiliars[randomIndex];
      const affinityKey = `${chosenFamiliar.name}好感`;
      const currentAffinity = this.playerService.getMarkerValue(markers, affinityKey);
      markers[affinityKey] = currentAffinity + 1;
      summonedItems.push(chosenFamiliar.name);
    }

    // 扣除召唤券
    const newTicketCount = ticketCount - 10;
    if (newTicketCount <= 0) {
      const idx = backpack.findIndex((item: any) => item.name === '召唤券');
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      ticketItem!.count = newTicketCount;
    }

    player.markers = JSON.stringify(markers);
    player.backpack = JSON.stringify(backpack);

    // 设置冷却（1小时）
    this.setCooldown(player, '大召唤术', 3600);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `【大召唤术】消耗了10张召唤券！\n召唤出了 ${summonedItems.join('、')}\n共 ${summonCount} 只使魔（冷却1小时）`;
  }
}
