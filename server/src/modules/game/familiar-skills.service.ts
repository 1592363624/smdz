/**
 * 使魔技能服务
 * 对应原版易语言：使魔技能.ecode
 * 完整实现所有使魔专属技能、通用技能和装备技能
 *
 * 技能列表：
 * 使魔专属技能 - 绑定特定使魔，需要当前使魔类型匹配
 * 通用/装备技能 - 需要特定装备或条件触发
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { BonusService, BonusData } from './bonus.service';
import { CombatService } from './combat.service';
import { CombatSystemService } from './combat-system.service';
import { ItemService } from './item.service';
import { ItemSystemService } from './item-system.service';
import { MapService } from './map.service';
import { FamiliarSystemService } from './familiar-system.service';

@Injectable()
export class FamiliarSkillsService {
  private readonly logger = new Logger(FamiliarSkillsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly bonusService: BonusService,
    private readonly combatService: CombatService,
    private readonly combatSystem: CombatSystemService,
    private readonly itemService: ItemService,
    private readonly itemSystem: ItemSystemService,
    private readonly mapService: MapService,
    private readonly familiarSystem: FamiliarSystemService,
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

    switch (skillName) {
      // 使魔专属技能
      case '六道轮回': return this.sixPaths(userId);
      case '怒吼': return this.roar(userId);
      case '万象': return this.myriadVisions(userId);
      case '誓约胜利之剑': return this.excalibur(userId);
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

      // 通用/装备技能
      case '洗脑': return this.brainwash(userId, target);
      case '砸瓦鲁多': return this.zaWarudo(userId);
      case '训练': return this.train(userId);
      case '掌控时间': return this.timeControl(userId);
      case '召唤': return this.summon(userId, target);
      case '力量模式': return this.nanoMode(userId, 'power');
      case '速度模式': return this.nanoMode(userId, 'speed');
      case '装甲模式': return this.nanoMode(userId, 'armor');
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
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const cooldownMarker = markers2.find((m: any) => m.name === cooldownName);
    const now = Date.now() / 1000;
    if (cooldownMarker && cooldownMarker.expireAt > now) {
      const remaining = Math.ceil(cooldownMarker.expireAt - now);
      return { isOnCooldown: true, text: `技能冷却中，剩余${remaining}秒` };
    }
    return { isOnCooldown: false, text: '' };
  }

  /**
   * 设置技能冷却
   * @param player 玩家对象
   * @param cooldownName 冷却标记名称
   * @param duration 冷却持续时间（秒）
   */
  private setCooldown(player: any, cooldownName: string, duration: number): void {
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const now = Date.now() / 1000;
    const newMarkers2 = markers2.filter((m: any) => m.name !== cooldownName);
    newMarkers2.push({
      name: cooldownName,
      expireAt: now + duration,
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
   * 检查背包中是否有指定物品
   * @param player 玩家对象
   * @param itemName 物品名称
   * @returns 是否有该物品
   */
  private hasItem(player: any, itemName: string): boolean {
    const backpack = this.playerService.getBackpackItems(player);
    return backpack.some((item: any) => item.name === itemName);
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

    // 添加增益（攻击提升）
    this.addBuff(player, '怒吼·攻', 30, { attack: attackBonus });
    // 添加减益（防御降低，用负值增益表示）
    this.addBuff(player, '怒吼·防', 30, { defense: -defensePenalty });

    // 设置冷却
    this.setCooldown(player, '怒吼', 60);

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

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '万象', 180);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, player.type);
    const effect = this.getSkillEffect(affinity);

    // 万象效果：随机传送到连接的地图或施加特殊效果
    const effects = [
      '空间扭曲，周围的一切变得模糊不清',
      '万象之力涌出，将敌人拉入异次元',
      '万象轮回，短暂提升全属性',
      '空间割裂，对周围造成伤害',
    ];

    const chosenEffect = effects[Math.floor(Math.random() * effects.length)];

    // 添加全属性增益
    const statBonus = Math.floor(20 * effect);
    this.addBuff(player, '万象·全属性', 60, {
      attack: statBonus,
      defense: statBonus,
      speed: statBonus,
      dodge: statBonus,
      hit: statBonus,
    });

    // 设置冷却
    this.setCooldown(player, '万象', 180);

    // 记录技能熟练度
    const skillKey = `${player.type}技能熟练度`;
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
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
    if (!this.checkFamiliarType(player, 'Saber')) {
      return '需要Saber才能使出誓约胜利之剑';
    }

    // 检查是否装备了圣剑
    if (!this.hasItem(player, '圣剑')) {
      return '需要装备「圣剑」才能使用誓约胜利之剑';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '誓约胜利之剑', 300);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, 'Saber');
    const effect = this.getSkillEffect(affinity);

    // 高伤害：基础伤害 + 好感度加成
    const baseDamage = 500 + Math.floor(affinity * 2);
    const finalDamage = Math.floor(baseDamage * effect);

    // 设置冷却
    this.setCooldown(player, '誓约胜利之剑', 300);

    // 记录技能熟练度
    const skillKey = 'Saber技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `Excalibur——誓约胜利之剑！！\n圣剑绽放出耀眼的光芒，对目标造成 ${finalDamage} 点巨额伤害\n好感度加成: ${Math.round(effect * 100)}%`;
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

    this.addBuff(player, '鹰眼·命中', 30, { hit: hitBonus });
    this.addBuff(player, '鹰眼·闪避', 30, { dodge: -dodgePenalty });

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

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '歼灭', 90);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '阿尔缇娜');
    const effect = this.getSkillEffect(affinity);

    // 冰系伤害
    const baseDamage = 200 + Math.floor(affinity * 1);
    const finalDamage = Math.floor(baseDamage * effect);

    // 冻结效果（减速）
    this.addBuff(player, '冰霜之力', 15, { iceDmg: Math.floor(30 * effect) });

    // 设置冷却
    this.setCooldown(player, '歼灭', 90);

    // 记录技能熟练度
    const skillKey = '阿尔缇娜技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `阿尔缇娜释放冰霜之力——歼灭！\n极寒的冰霜将目标冻结，造成 ${finalDamage} 点冰系伤害\n好感度加成: ${Math.round(effect * 100)}%`;
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

    this.addBuff(player, '歼灭模式', 45, {
      attack: attackBonus,
      crit: critBonus,
      critDmg: Math.floor(30 * effect),
    });

    // 设置冷却
    this.setCooldown(player, '歼灭模式', 180);

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

    this.addBuff(player, '绝对守护', shieldDuration, { invincible: true });

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

    this.addBuff(player, '斗转星移', 30, { reflectDmg: reflectPercent });

    // 设置冷却
    this.setCooldown(player, '斗转星移', 120);

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

    this.addBuff(player, '火力全开', 30, { attack: attackBonus });

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
    this.setCooldown(player, '啾啾猫猫', 60);

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

    this.addBuff(player, '银龙附体', 60, {
      attack: statBonus,
      defense: statBonus,
      speed: statBonus,
      dodge: statBonus,
      hit: statBonus,
      crit: Math.floor(10 * effect),
      critDmg: Math.floor(20 * effect),
    });

    // 设置冷却
    this.setCooldown(player, '银龙附体', 150);

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

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '斩', 30);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '剑圣');
    const effect = this.getSkillEffect(affinity);

    // 高伤害单体攻击
    const baseDamage = 150 + Math.floor(affinity * 1.5);
    const finalDamage = Math.floor(baseDamage * effect);

    // 设置冷却
    this.setCooldown(player, '斩', 30);

    // 记录技能熟练度
    const skillKey = '剑圣技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `剑圣拔刀——斩！\n一刀斩下，对目标造成 ${finalDamage} 点伤害\n好感度加成: ${Math.round(effect * 100)}%`;
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

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '会心一击', 60);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '剑圣');
    const effect = this.getSkillEffect(affinity);

    // 暴击攻击：必定暴击，高倍率
    const baseDamage = 100 + Math.floor(affinity * 1);
    const critMultiplier = 2.5 + effect * 0.5; // 2.5~3.0倍暴击
    const finalDamage = Math.floor(baseDamage * critMultiplier);

    // 设置冷却
    this.setCooldown(player, '会心一击', 60);

    // 记录技能熟练度
    const skillKey = '剑圣技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `剑圣凝聚全身力量——会心一击！！\n【暴击】对目标造成 ${finalDamage} 点巨额伤害（暴击倍率: ${critMultiplier.toFixed(1)}x）\n好感度加成: ${Math.round(effect * 100)}%`;
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

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '全弹发射', 120);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '长萌');
    const effect = this.getSkillEffect(affinity);

    // 范围攻击：对所有敌人造成伤害
    const baseDamage = 80 + Math.floor(affinity * 0.8);
    const finalDamage = Math.floor(baseDamage * effect);

    // 设置冷却
    this.setCooldown(player, '全弹发射', 120);

    // 记录技能熟练度
    const skillKey = '长萌技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `长萌全弹发射！所有炮门开启！\n对全体敌人造成 ${finalDamage} 点范围伤害\n好感度加成: ${Math.round(effect * 100)}%`;
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

    this.addBuff(player, '光翼', 30, {
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

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '炮冠', 45);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '绝灭天使');
    const effect = this.getSkillEffect(affinity);

    // 远程攻击
    const baseDamage = 120 + Math.floor(affinity * 1.2);
    const finalDamage = Math.floor(baseDamage * effect);

    // 设置冷却
    this.setCooldown(player, '炮冠', 45);

    // 记录技能熟练度
    const skillKey = '绝灭天使技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `绝灭天使炮冠发射！\n远程炮击命中目标，造成 ${finalDamage} 点伤害\n好感度加成: ${Math.round(effect * 100)}%`;
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

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '日轮', 150);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '绝灭天使');
    const effect = this.getSkillEffect(affinity);

    // 持续伤害光环
    const tickDamage = Math.floor(20 + affinity * 0.2 * effect);
    const duration = Math.floor(15 + 5 * effect); // 持续15~20秒

    this.addBuff(player, '日轮·光环', duration, {
      splash: tickDamage,
      splashCount: 1,
    });

    // 设置冷却
    this.setCooldown(player, '日轮', 150);

    // 记录技能熟练度
    const skillKey = '绝灭天使技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `绝灭天使展开日轮光环！\n周围被炽热的光环笼罩，每秒造成 ${tickDamage} 点持续伤害（持续${duration}秒）\n好感度加成: ${Math.round(effect * 100)}%`;
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
    this.addBuff(player, '安宝加油', 30, { defense: defenseBonus });

    // 设置冷却
    this.setCooldown(player, '安宝加油', 90);

    // 记录技能熟练度
    const skillKey = '安克雷奇技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `安克雷奇：安宝加油！加油！\n回复 ${healAmount} 点生命值，防御力提升 ${defenseBonus} 点（持续30秒）\n好感度加成: ${Math.round(effect * 100)}%`;
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

    // 检查使魔类型
    if (!this.checkFamiliarType(player, '伊芙利特')) {
      return '需要伊芙利特才能使出灼烂歼鬼';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '灼烂歼鬼', 90);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '伊芙利特');
    const effect = this.getSkillEffect(affinity);

    // 火焰伤害 + 灼烧效果
    const baseDamage = 180 + Math.floor(affinity * 1.2);
    const finalDamage = Math.floor(baseDamage * effect);
    const burnDamage = Math.floor(15 * effect);

    this.addBuff(player, '灼烂歼鬼·灼烧', 15, { fireDmg: burnDamage });

    // 设置冷却
    this.setCooldown(player, '灼烂歼鬼', 90);

    // 记录技能熟练度
    const skillKey = '伊芙利特技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `伊芙利特释放灼烂歼鬼！\n烈焰吞噬目标，造成 ${finalDamage} 点火焰伤害\n附加灼烧效果，每秒 ${burnDamage} 点持续伤害（持续15秒）\n好感度加成: ${Math.round(effect * 100)}%`;
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

    this.addBuff(player, '冻结傀儡·冰冻', freezeDuration, { speed: -50 });

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

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '形神合一', 60);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '兰音');
    const effect = this.getSkillEffect(affinity);

    // 高伤害
    const baseDamage = 200 + Math.floor(affinity * 1.5);
    const finalDamage = Math.floor(baseDamage * effect);

    // 设置冷却
    this.setCooldown(player, '形神合一', 60);

    // 记录技能熟练度
    const skillKey = '兰音技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `兰音形神合一！身与意合，意与神合！\n对目标造成 ${finalDamage} 点伤害\n好感度加成: ${Math.round(effect * 100)}%`;
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

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '风月入墨', 90);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '兰音');
    const effect = this.getSkillEffect(affinity);

    // 持续伤害
    const tickDamage = Math.floor(25 + affinity * 0.3 * effect);
    const duration = Math.floor(10 + 5 * effect);

    this.addBuff(player, '风月入墨·墨染', duration, {
      physDmg: tickDamage,
    });

    // 设置冷却
    this.setCooldown(player, '风月入墨', 90);

    // 记录技能熟练度
    const skillKey = '兰音技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `兰音挥毫泼墨，风月入墨！\n墨色渗入目标，每秒造成 ${tickDamage} 点持续伤害（持续${duration}秒）\n好感度加成: ${Math.round(effect * 100)}%`;
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

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '心无所扰', 120);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '兰音');
    const effect = this.getSkillEffect(affinity);

    // 清除负面状态：过滤掉所有减益效果
    const buffs = this.playerService.safeJsonParse<any[]>(player.buffs, []);
    const now = Date.now() / 1000;
    // 保留增益效果（加成值>0的），移除减益效果（加成值<0或明确标记为debuff的）
    const cleanBuffs = buffs.filter((b: any) => {
      if (b.expireAt <= now) return false;
      // 如果buff有negative标记或所有数值加成都是负数，视为debuff
      if (b.negative) return false;
      // 检查是否有任何正数加成
      const hasPositiveBonus = Object.entries(b).some(([key, val]) =>
        !['name', 'expireAt', 'negative'].includes(key) && typeof val === 'number' && val > 0,
      );
      return hasPositiveBonus;
    });
    player.buffs = JSON.stringify(cleanBuffs);

    // 额外回复生命
    const healAmount = Math.floor(50 + affinity * 0.3 * effect);
    player.hp = Math.min((player.hp || 0) + healAmount, player.maxHp || 100);

    // 设置冷却
    this.setCooldown(player, '心无所扰', 120);

    // 记录技能熟练度
    const skillKey = '兰音技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 10;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `兰音心无所扰，明镜止水！\n清除了所有负面状态，回复 ${healAmount} 点生命\n好感度加成: ${Math.round(effect * 100)}%`;
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

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '梦倾天下', 180);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '兰音');
    const effect = this.getSkillEffect(affinity);

    // 范围伤害
    const baseDamage = 150 + Math.floor(affinity * 1);
    const finalDamage = Math.floor(baseDamage * effect);

    // 设置冷却
    this.setCooldown(player, '梦倾天下', 180);

    // 记录技能熟练度
    const skillKey = '兰音技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 15;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `兰音梦倾天下！\n梦境的力量笼罩全场，对全体敌人造成 ${finalDamage} 点范围伤害\n好感度加成: ${Math.round(effect * 100)}%`;
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

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '反转童话', 240);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = this.getAffinity(markers, '兰音');
    const effect = this.getSkillEffect(affinity);

    // 反转属性：将负面的反转成正面的
    // 效果：攻击和防御互换比例，速度转换为闪避
    const attackConvert = Math.floor((player.attack || 0) * 0.3 * effect);
    const defenseConvert = Math.floor((player.defense || 0) * 0.3 * effect);
    const speedConvert = Math.floor((player.speed || 0) * 0.2 * effect);

    this.addBuff(player, '反转童话', 45, {
      attack: defenseConvert,
      defense: attackConvert,
      dodge: speedConvert,
    });

    // 设置冷却
    this.setCooldown(player, '反转童话', 240);

    // 记录技能熟练度
    const skillKey = '兰音技能熟练度';
    markers[skillKey] = (this.playerService.getMarkerValue(markers, skillKey) || 0) + 15;

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `兰音反转童话！\n世界被颠倒了过来！\n将防御的 ${defenseConvert} 点转化为攻击\n将攻击的 ${attackConvert} 点转化为防御\n将速度的 ${speedConvert} 点转化为闪避\n（持续45秒）\n好感度加成: ${Math.round(effect * 100)}%`;
  }

  // ==================== 通用/装备技能 ====================

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
      return '需要「洗脑装置」才能使用洗脑技能';
    }

    if (!target) {
      return '请指定要洗脑的目标';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '洗脑', 600);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 设置冷却
    this.setCooldown(player, '洗脑', 600);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `对「${target}」使用了洗脑装置！\n目标陷入了混乱状态（冷却10分钟）`;
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

    // 设置冷却
    this.setCooldown(player, '召唤', 120);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `使用次元手环召唤「${target}」！\n次元之门打开，召唤物降临！（冷却2分钟）`;
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
        buffData = { attack: Math.floor(80 * effect), crit: Math.floor(15 * effect) };
        modeText = '力量模式';
        break;
      case 'speed':
        buffName = '纳米·速度模式';
        buffData = { speed: Math.floor(80 * effect), dodge: Math.floor(30 * effect) };
        modeText = '速度模式';
        break;
      case 'armor':
        buffName = '纳米·装甲模式';
        buffData = { defense: Math.floor(80 * effect), armor: Math.floor(50 * effect) };
        modeText = '装甲模式';
        break;
      case 'stealth':
        buffName = '纳米·隐匿模式';
        buffData = { dodge: Math.floor(50 * effect), hit: Math.floor(30 * effect) };
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
    this.addBuff(player, '安乐天使·护盾', 20, { invincible: true, shield: Math.floor(500 * effect) });

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
      return '需要「启示录」装备才能使用此技能';
    }

    // 检查冷却
    const cooldownCheck = this.checkCooldown(player, '启示录', 600);
    if (cooldownCheck.isOnCooldown) return cooldownCheck.text;

    // 获取好感度
    const affinity = player.type ? this.getAffinity(markers, player.type) : 0;
    const effect = this.getSkillEffect(affinity);

    // 攻击/暴击大幅提升（持续30秒）
    const attackBonus = Math.floor(150 * effect);
    const critBonus = Math.floor(30 * effect);
    const critDmgBonus = Math.floor(50 * effect);

    this.addBuff(player, '启示录·狂暴', 30, {
      attack: attackBonus,
      crit: critBonus,
      critDmg: critDmgBonus,
    });

    // 设置冷却（10分钟）
    this.setCooldown(player, '启示录', 600);

    // 添加虚弱标记（狂暴结束后进入虚弱，持续60秒）
    // 使用 markers2 记录启示录结束时间，用于后续虚弱检测
    const markers2 = this.playerService.safeJsonParse<any[]>(player.markers2, []);
    const now = Date.now() / 1000;
    const newMarkers2 = markers2.filter((m: any) => m.name !== '启示录·虚弱');
    newMarkers2.push({
      name: '启示录·虚弱',
      expireAt: now + 30 + 60, // 狂暴持续30秒+虚弱60秒
    });
    player.markers2 = JSON.stringify(newMarkers2);

    // 增加活跃度
    markers['活跃度'] = (this.playerService.getMarkerValue(markers, '活跃度') || 0) + 1;

    player.markers = JSON.stringify(markers);
    await this.playerService.savePlayer(player);

    return `【启示录】末日审判！\n攻击力提升 ${attackBonus} 点，暴击率提升 ${critBonus}%，暴击伤害提升 ${critDmgBonus}%（持续30秒）\n⚠️ 结束后将进入虚弱状态（持续60秒）\n好感度加成: ${Math.round(effect * 100)}%`;
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
        buffData = { attack: Math.floor(100 * effect), crit: Math.floor(20 * effect), defense: -Math.floor(30 * effect) };
        modeText = '攻击模式';
        break;
      case '防御模式':
        buffName = '模式·防御';
        buffData = { defense: Math.floor(100 * effect), armor: Math.floor(60 * effect), attack: -Math.floor(30 * effect) };
        modeText = '防御模式';
        break;
      case '速度模式':
        buffName = '模式·速度';
        buffData = { speed: Math.floor(100 * effect), dodge: Math.floor(30 * effect), attack: -Math.floor(20 * effect) };
        modeText = '速度模式';
        break;
      case '平衡模式':
        buffName = '模式·平衡';
        buffData = { attack: Math.floor(40 * effect), defense: Math.floor(40 * effect), speed: Math.floor(40 * effect) };
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

    // 获取所有可召唤的使魔
    const allFamiliars = await this.prisma.gameFamiliar.findMany({
      where: { noSummon: false },
    });

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