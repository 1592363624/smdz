/**
 * 副本/挑战/刷怪指令域服务（game 模块化重构 P3-4 抽出）
 *
 * 职责：开战、扫荡（含需求文本与解析）、闪避、进入副本、刷新/清除副本、
 * 使魔挑战（逐层）、生成工匠/残骸/NPC、刷新怪物、删除怪物。
 * 依赖方向：依赖 Player、Map、CombatSystem、Achievement、Task、DungeonService、
 * Prisma、Vitality、CombatState、StaticData、Shortcut、DelayedTaskService、
 * FamiliarSkills、ItemSystem 与支撑层（setMarkers2/hasEquip/mutatePlayer 等）；
 * 过渡期经门面引用触达 panel 域 handleLookAround 与 vehicle 域
 * toRuntimeVehicle/toStoredVehicle（P3-6 内核合并后改为直接注入）。
 * 单一真相源：副本标记写入统一 normalizeDungeonMarkers2（combatState.normalizeBuffItem 同源）。
 * 对口原版：_主程序.ecode 副本/扫荡/挑战分支。
 */import { Injectable, Logger, Optional } from '@nestjs/common';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { formatDisplayNumber, roundItemQuantity } from '../../../common/utils/game-text.util';
import { normalizePoolValue } from '.././player-pool.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlayerService } from '.././player.service';
import { CombatSystemService } from '.././combat-system.service';
import { MapService } from '.././map.service';
import { DungeonService } from '.././dungeon.service';
import { AchievementService } from '.././achievement.service';
import { ItemSystemService } from '.././item-system.service';
import { FamiliarSkillsService } from '.././familiar-skills.service';
import { StaticDataService } from '.././static-data.service';
import { TaskService } from '.././task.service';
import { ShortcutService } from '.././shortcut.service';
import { CombatStateService } from '.././combat-state.service';
import { VitalityService } from '.././vitality.service';
import { DelayedTaskService } from '.././delayed-task.service';
import { GameSupportService } from '.././game-support.service';
import { GameService } from '.././game.service';

@Injectable()
export class DungeonChallengeService {
  private readonly logger = new Logger(DungeonChallengeService.name);

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
    private readonly combatSystem: CombatSystemService,
    private readonly mapService: MapService,
    private readonly dungeonService: DungeonService,
    private readonly achievementService: AchievementService,
    private readonly itemSystemService: ItemSystemService,
    private readonly familiarSkillsService: FamiliarSkillsService,
    private readonly staticData: StaticDataService,
    private readonly taskService: TaskService,
    private readonly shortcutService: ShortcutService,
    private readonly combatState: CombatStateService,
    @Optional() private readonly vitalityService?: VitalityService,
    @Optional() private readonly delayedTaskService?: DelayedTaskService,
  ) {}

  async handleStartBattle(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    const homeProgress = this.playerService.getMarkerValue(markers, '家园进度');
    if (homeProgress < 4 || !player.houseName) {
      return `${player.name || '冒险者'}需要先完成房子的建造`;
    }

    const stats = asJsonValue<Record<string, any>>(player.stats, {});
    const baseMapId = Number(stats['家园原地图ID'] || stats.houseBaseMapId || player.mapId || 0);
    const houseMaps = await this.mapService.ensureHouseMaps(player.houseName, baseMapId, 4);
    const frontlineMap = houseMaps.frontline;
    if (!frontlineMap) {
      return `${player.name || '冒险者'}#一个错误发生了:家园前线地图编号为0`;
    }

    const existingMonsters = await this.mapService.getMapMonsters(frontlineMap);
    if (existingMonsters.length !== 0) {
      return `${player.name || '冒险者'}还有需要解决的敌人`;
    }

    // 原版：活跃度+1、置成就熟练度("阵地", 玩家2.标记, 1)，然后按前线等级分支。
    markers['活跃度'] = this.playerService.getMarkerValue(markers, '活跃度') + 1;
    markers['阵地'] = 1;
    const frontlineLevel = this.playerService.getMarkerValue(markers, '前线');
    const wave: string[] = ['地精', '地精'];
    if (frontlineLevel >= 15 && frontlineLevel < 40) {
      wave.push('地精十夫长');
    } else if (frontlineLevel >= 40 && frontlineLevel < 60) {
      wave.push('地精十夫长', '地精百夫长');
    } else if (frontlineLevel >= 60) {
      wave.push('地精十夫长', '地精百夫长', '地精千夫长');
      if (frontlineLevel >= 80) wave.push('地精将军');
    }

    const ownerQQ = String((player as any).qqNumber || (player as any).externalId || player.userId || userId);
    for (const monsterName of wave) {
      const monster = await this.mapService.spawnMonsterByName(frontlineMap.id, monsterName, {
        level: frontlineLevel,
        isTemp: true,
        ownerQQ,
      });
      // 原版在加入怪物列表前为每只怪物写入当前玩家的掉落能力。
      const dropMarkers = this.combatSystem.setDrop(player, []);
      if (dropMarkers.length > 0) {
        await this.mapService.updateMonsterFields(frontlineMap.id, monster.id, {
          markers: dropMarkers,
        });
      }
    }

    const generated = this.combatSystem.generateFrontline(
      frontlineMap,
      ownerQQ,
      Date.now(),
      frontlineLevel,
    );
    await this.mapService.updateDynamicFields(frontlineMap.id, {
      summons: generated.summons,
      vehicles: generated.vehicles,
      markers2: [{ 名称: '活动', 强度: 0, 有效期至: Date.now() + 120000 }],
    });

    // 保留现有网页版的战斗模式标记，供自动攻击入口读取；前线波次才是本命令的实际效果。
    markers['battle_mode'] = true;
    player.markers = markers;
    await this.playerService.savePlayer(player);

    // 原版 _主程序.ecode L2167：地精攻势开始后 新建延时("覅攻击pd"+地图, "0", 群号, 3)，
    // 3秒后怪物回合开始并自动续回合（"活动"120秒标记已在上方写入）。
    try {
      (this.combatSystem as any).scheduleMapMonsterRound?.(Number(frontlineMap.id), 3);
    } catch (e: any) {
      this.logger.warn(`地精攻势拉起怪物攻击循环失败: ${e?.message}`);
    }

    this.logger.log(`玩家 ${userId} 进入战斗模式`);
    return `${player.name || '冒险者'}\n地精的攻势开始了`;
  }

  /**
   * 处理扫荡命令（对应原版 _主程序.ecode L9226-L9323）。
   *
   * 扫荡是独立的批量奖励路径：按次数消耗活力、只结算发起者、
   * 不调用普通攻击，因此不会触发怪物反击、召唤物协同、普通击杀双倍或重复经验。
   */

  async handleSweep(userId: number, requestedCount = 0): Promise<string> {
    const run = () => this.handleSweepInner(userId, requestedCount);
    if (typeof this.playerService.enqueueUserWrite === 'function') {
      return this.playerService.enqueueUserWrite(userId, run);
    }
    return run();
  }


  async handleSweepInner(userId: number, requestedCount: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = player.name || '冒险者';

      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    const liveMonsters: any[] = (await this.mapService.getMapMonsters(map))
      .filter((monster: any) => Number(monster?.hp ?? monster?.当前生命 ?? 0) > 0);
    const configuredNames = this.parseSweepMonsterNames(map);
    // 无静态模板的临时/存量地图保留兼容：从当前存活实例取得类型，
    // 正式地图仍严格以静态地图怪物列表为扫荡池。
    const monsterNames = configuredNames.length > 0
      ? configuredNames
      : liveMonsters.map((monster: any) => String(monster?.type ?? monster?.name ?? '').trim()).filter(Boolean);

    if (requestedCount <= 0) {
      const requirementText = this.buildSweepRequirementText(playerData, monsterNames);
      return `${name}\n"扫荡3"来扫荡当前地图3次，每次消耗1活力，不触发活力双倍奖励，只有自己有奖励\n扫荡奖励与你的掉落加成、经验加成有关${requirementText}`;
    }
    if (monsterNames.length === 0) {
      return `${name}${map.name || ''}没有自带的怪物，不能扫荡`;
    }

    const requirement = this.getSweepRequirement(playerData, monsterNames);
    if (requirement.unmet && configuredNames.length > 0) {
      return `${name}你需要亲自击杀(或你的宠物击杀)以下怪物对应次数才可以扫荡${requirement.text}`;
    }

    const actualCount = this.vitalityService
      ? this.vitalityService.getSweepCount(requestedCount, player.vitality)
      : Math.min(Math.max(0, Math.floor(Number(requestedCount) || 0)), Math.max(0, Math.floor(Number(player.vitality) || 0)));
    if (actualCount <= 0) {
      return `${name}活力不足，无法扫荡`;
    }

    // 原版扫荡开始前清空地图怪物实例；奖励对象在内存中逐次构造，不写回怪物表。
    if (typeof this.mapService.clearMapMonsters === 'function') {
      await this.mapService.clearMapMonsters(map.id);
    }

    const attackerBonus = typeof this.combatSystem.buildAttackerBonus === 'function'
      ? this.combatSystem.buildAttackerBonus(player, playerData, map)
      : {};
    const dropRateMultiplier = Math.max(0, 1 + Number(attackerBonus?.掉落率 || 0) / 100);
    const dropQualityMultiplier = 1 + Number(attackerBonus?.掉落品质 || 0) / 100;
    const allDrops: any[] = [];
    const defeatedByName = new Map<string, number>();
    let totalExp = 0;
    // 原版把一次“扫荡”定义为清空一轮地图，而不是击杀一只怪物：
    // 请求次数只消耗对应活力，实际奖励数量还要乘地图的怪物数量。
    const monstersPerSweep = String(map.name || '') === '四圣祭坛'
      ? 1
      : Math.max(1, Math.floor(Number(map.monsterCount ?? map.怪物数量 ?? 1) || 1));
    const totalMonsterCount = actualCount * monstersPerSweep;

    for (let i = 0; i < totalMonsterCount; i++) {
      const monsterName = monsterNames[Math.floor(Math.random() * monsterNames.length)];
      const definition = this.staticData.getMonsterByName(monsterName) || {};
      const liveFallback: any = liveMonsters.find((monster: any) =>
        String(monster?.type ?? monster?.name ?? '') === monsterName,
      ) || {};
      const definitionBonus = asJsonValue<any>(definition.bonus, {});
      const sweepMonster = {
        ...liveFallback,
        ...definition,
        name: monsterName,
        type: monsterName,
        level: definition.level ?? liveFallback.level ?? map.level ?? 1,
        exp: definition.exp ?? definition.baseExp ?? definitionBonus.经验 ?? liveFallback.exp ?? 10,
        bonus: definition.bonus ?? liveFallback.bonus ?? '{}',
      };
      const baseExp = typeof this.combatSystem.calcMonsterExp === 'function'
        ? this.combatSystem.calcMonsterExp(sweepMonster)
        : Number(sweepMonster.exp) || 10;
      totalExp += Math.min(10_000_000, Math.max(0, Number(baseExp) || 0));

      const drops = typeof this.combatSystem.generateDrops === 'function'
        ? this.combatSystem.generateDrops(sweepMonster, dropRateMultiplier)
        : [];
      for (const drop of drops || []) {
        const rawQuantity = Number(drop?.quantity ?? drop?.count ?? drop?.数量 ?? 0);
        if (!Number.isFinite(rawQuantity)) continue;
        const type = String(drop?.type ?? drop?.类型 ?? '').trim();
        const quantity = type === '装备' || type === 'equipment'
          ? Math.max(1, Math.floor(rawQuantity))
          : rawQuantity >= 0
            ? rawQuantity * dropQualityMultiplier
            : Math.abs(rawQuantity);
        allDrops.push({ ...drop, quantity });
      }
      defeatedByName.set(monsterName, (defeatedByName.get(monsterName) || 0) + 1);
    }

    const consumed = this.vitalityService
      ? this.vitalityService.applySweepCost(player, actualCount)
      : actualCount;
    const taskProgress: Array<{ actionName: string; count: number }> = [];
    let dropText = '';
    if (allDrops.length > 0) {
      dropText = await this.itemSystemService.distributeLoot(playerData, allDrops, {
        onTaskProgress: (actionName, count) => taskProgress.push({ actionName, count }),
      });
    }
    // 原版扫荡同样添加击败成就（L9314-L9315）：写入玩家标记，
    // 否则扫荡产出的击杀不累计「击败X」，扫荡需求无法推进（Issue #11）。
    const sweepMarkers = playerData.markers || asJsonValue<Record<string, number>>(player.markers, {});
    sweepMarkers['击败怪物'] = (Number(sweepMarkers['击败怪物']) || 0) + totalMonsterCount;
    for (const [monsterName, count] of defeatedByName) {
      sweepMarkers[`击败${monsterName}`] = (Number(sweepMarkers[`击败${monsterName}`]) || 0) + count;
    }
    player.markers = sweepMarkers; // Json 列直接写对象
    await this.playerService.savePlayer(player);

    // 经验只在批量奖励结束时写入一次，避免扫荡循环和 addExp 双重结算。
    if (totalExp > 0) {
      await this.playerService.addExp(userId, totalExp);
    }

    if (this.taskService && typeof this.taskService.advance === 'function') {
      await this.taskService.advance(userId, '击败怪物', totalMonsterCount);
      for (const [monsterName, count] of defeatedByName) {
        await this.taskService.advance(userId, `击败${monsterName}`, count);
      }
      await this.taskService.advance(userId, '消耗活力', consumed);
      for (const progress of taskProgress) {
        await this.taskService.advance(userId, progress.actionName, progress.count);
      }
    }

    const lines = [
      `${name}消耗${consumed}点活力扫荡了${map.name || '当前地图'}`,
      `击败了${totalMonsterCount}只怪物`,
      `得到了经验x${this.support.round2Text(totalExp)}`,
    ];
    if (dropText) lines.push(`获得${dropText}`);
    return lines.join('\n');
  }

  /** 读取原版地图怪物池，并合并有效的“嗅探怪物”临时标记。 */

  parseSweepMonsterNames(map: any): string[] {
    const raw = map?.monsters ?? map?.怪物 ?? [];
    const names = Array.isArray(raw)
      ? raw
      : asJsonValue<any[]>(raw, []);
    const result = names
      .map((value: any) => String(value?.name ?? value?.名称 ?? value ?? '').trim())
      .filter(Boolean);
    const rawMarkers = map?.markers3 ?? map?.标记3;
    const markers = Array.isArray(rawMarkers)
      ? rawMarkers
      : asJsonValue<any[]>(rawMarkers, []);
    for (const marker of markers) {
      const markerName = String(marker?.name ?? marker?.名称 ?? '').trim();
      if (markerName.startsWith('嗅探') && markerName.slice(2).trim()) {
        result.push(markerName.slice(2).trim());
      }
    }
    if (String(map?.name || '') === '四圣祭坛') return ['神兽麒麟'];
    return result;
  }

  /**
   * 生成原版扫荡需求：怪物在地图刷新池中的重复项就是权重，
   * 需求 = 四舍五入(权重/总权重*25)，并限制在1到5；显示满足和未满足项。
   */

  getSweepRequirement(playerData: any, monsterNames: string[]): { text: string; unmet: boolean } {
    const markers = playerData?.markers || {};
    const names = monsterNames.filter(Boolean);
    const totalWeight = names.length;
    if (totalWeight <= 0) return { text: '', unmet: true };
    const weightByName = new Map<string, number>();
    for (const name of names) weightByName.set(name, (weightByName.get(name) || 0) + 1);
    let unmet = false;
    const lines = [...weightByName.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([monsterName, weight]) => {
        let required = Math.round(weight / totalWeight * 25);
        required = Math.max(1, Math.min(5, required));
        const completed = typeof this.playerService.getMarkerValue === 'function'
          ? Number(this.playerService.getMarkerValue(markers, `击败${monsterName}`)) || 0
          : Number(markers?.[`击败${monsterName}`] || 0);
        if (completed < required) unmet = true;
        return `${monsterName}(${Math.min(completed, required)}/${required})`;
      });
    return { text: lines.length > 0 ? `\n${lines.join('\n')}` : '', unmet };
  }

  /** 兼容测试和旧调用方只需要文本的私有辅助。 */

  buildSweepRequirementText(playerData: any, monsterNames: string[]): string {
    return this.getSweepRequirement(playerData, monsterNames).text;
  }

  /**
   * 处理闪避命令（对应原版 _主程序.ecode L1839 分发 + 使魔技能.ecode L550 释放闪避 子程序）
   * 1:1 复刻：发「闪避」指令 → 检查冷却(飞羽套装加成) → 调用释放闪避(熟练度决定持续秒数) → 写入闪避增益。
   * 冷却公式 15*(1+a2*0.05)（a2=飞羽套装等级封顶10），持续 a1=(a/(25+a)+1)*4（a=闪避熟练度等级）。
   */

  async handleDodge(userId: number): Promise<string> {
    // 读改写整体进用户写队列、基于活态执行（见 mutatePlayer 注释）。
    // 原先「锁外裸读档 + 一条指令内连写 3 次 savePlayer（闪避击成就 / 闪避熟练度成就 /
    // buffs+markers2）」的形态，第 2 次起会被自己刚推进的 version 判成旧快照，strict
    // 模式下静默丢弃（实测：闪避冷却标记没写进去 → 冷却判定失效 → 可无限连发闪避；
    // 闪避增益与闪避熟练度成就一并丢失）。迁入 mutate 后全部改动合并进同一份 ctx 快照，
    // 由最外层统一落库、只推进一次版本；内层 savePlayer 退化为「合并 + 标脏」。
    return this.support.mutatePlayer(userId, async (ctx: any) => {
    const { player } = ctx;
    const markers: Record<string, number> = ctx.markers
      ?? asJsonValue<Record<string, number>>(player.markers, {});
    const markers2: any[] = ctx.markers2 ?? asJsonValue<any[]>(player.markers2, []);

    // 检查是否死亡（原版 L1846 玩家死亡 优先判定）
    // 卷土重来中：原版 返回假 → 闪避继续执行，不要 return 空/死亡文案
    {
      const deathText = await this.playerService.deathGateText(player);
      if (deathText) return deathText;
    }

    // ========== 飞羽套装加成（对应原版 _主程序.ecode L1840-1844） ==========
    // 增益要求("飞羽", 玩家.增益, a2) 取飞羽套装强度 a2，封顶 10
    let a2 = 0;
    for (const m of markers2) {
      if (m && (m.name === '飞羽')) a2 = Math.max(a2, Number(m.strength ?? m.强度 ?? 0));
    }
    if (a2 > 10) a2 = 10; // 原版 L1841-1842 封顶
    let w2 = '';
    if (a2 > 0) {
      // 原版 L1844：冷却+15*a2*0.05 秒
      w2 = `(冷却+${formatDisplayNumber(15 * a2 * 0.05)}秒)`;
    }

    // ========== 冷却判定（对应原版 _主程序.ecode L1848） ==========
    // 时间间隔要求("闪避冷却", 15*(1+a2*0.05), 玩家.标记2)
    const nowMs = Date.now();
    const nowSec = nowMs / 1000;
    const cooldownSec = 15 * (1 + a2 * 0.05);
    const cdMark = markers2.find((m: any) => m && m.name === '闪避冷却');
    if (cdMark && cdMark.expireAt && cdMark.expireAt > nowSec) {
      const remaining = Math.ceil(cdMark.expireAt - nowSec);
      // 原版 L1849：玩家.名称 + w + w2（w 来自玩家死亡/状态提示，这里仅回冷却）
      return `${player.name}闪避冷却中，剩余 ${remaining} 秒${w2}`;
    }

    // ========== 释放闪避 子程序（使魔技能.ecode L550-633） ==========
    // 麻醉标记（原版 L561-562）：静默返回（网页版无独立麻醉系统，保留判定骨架）
    if (markers2.some((m: any) => m && m.name === '麻醉')) {
      return '';
    }
    // 闪避属性过低无法释放（原版 L564-565：玩家.属性.闪避 <= 1）
    const calcBonus = this.combatSystem.buildAttackerBonus(player, ctx);
    if ((calcBonus.闪避 || 0) <= 1) {
      return `${player.name}因为闪避属性过低无法释放闪避`;
    }
    // 闪避熟练度等级 a（原版 L567：显示熟练度等级(玩家.标记,"闪避")）
    const a = Number(markers['闪避'] || 0);
    // 持续秒数 a1（原版 L568：a1=(a/(25+a)+1)*4）
    let a1 = (a / (25 + a) + 1) * 4;
    // 空间主宰装备（原版 L569-573）：a1*=2 并加"空间主宰"括号
    const hasSpaceMaster = this.support.hasEquip(player, '空间主宰');
    if (hasSpaceMaster) {
      const kzMark = markers2.find((m: any) => m && m.name === 'kz');
      if (!kzMark || !kzMark.expireAt || kzMark.expireAt <= nowSec) {
        a1 = a1 * 2;
        w2 = w2 ? `${w2}(空间主宰)` : '(空间主宰)';
        // 写入 kz 60秒冷却标记（原版 L570 时间间隔要求("kz",60)）
        this.support.setMarkers2(markers2, 'kz', nowSec + 60);
      }
    }
    // 文本（原版 L576：玩家.名称+"尝试闪避攻击("+文本四舍(a1)+"秒)"+w2）
    const roundedA1 = roundItemQuantity(a1);
    let w = `${player.name}尝试闪避攻击(${roundedA1}秒)${w2}`;
    // 添加成就（原版 L577-578）
    await this.achievementService.addAchievement(player, '闪避', 1);
    await this.achievementService.addAchievement(player, '闪避熟练度', 1);
    // 写入闪避增益（原版 L579：添加标记("闪避", a1, 玩家.增益)）→ 映射 player.buffs 供战斗命中判定读取
    const playerBuffs = asJsonValue<any[]>(player.buffs, []);
    const existingDodge = playerBuffs.find((b: any) => b && b.name === '闪避' && (!b.expireAt || b.expireAt > nowSec));
    if (existingDodge) {
      existingDodge.expireAt = nowSec + a1; // 原版延长至 a1 秒
    } else {
      playerBuffs.push({ name: '闪避', value: 100, expireAt: nowSec + a1, duration: a1 });
    }
    player.buffs = playerBuffs; // Json 列直接写数组
    // 写入冷却标记（原版 L1848：时间间隔要求 "闪避冷却" cooldownSec）
    this.support.setMarkers2(markers2, '闪避冷却', nowSec + cooldownSec);
    player.markers2 = markers2; // Json 列直接写数组

    // ========== 使魔专属分支（原版 L580-632） ==========
    const aff = Number(player.affinity || 0);
    const seq = Number(player.specialSeq || 0);
    if (seq === 1) {
      // #花园猫（原版 @Constant 花园猫="1"；L580-585）：好感≥100 → 啾啾猫猫增益 + 闪避击熟练度
      if (aff >= 100) {
        this.support.setMarkers2(markers2, '啾啾猫猫', nowSec + 3);
        await this.achievementService.addAchievement(player, '闪避击', 1);
        player.markers2 = markers2; // Json 列直接写数组
        w += '(啾啾猫猫)';
      }
    } else if (seq === 8) {
      // #战斗女仆（原版 @Constant 战斗女仆="8"；L587-597）：好感≥100 → 清空当前武器攻击冷却
      if (aff >= 100) {
        const weapons: any[] = ctx.weapons || [];
        const curIdx = Number(player.currentWeapon || 0);
        const wname = weapons[curIdx]?.name || '拳头';
        const wcdName = wname === '拳头' ? '拳头冷却' : `${wname}冷却`;
        const newM2 = markers2.filter((m: any) => !(m && m.name === wcdName));
        player.markers2 = newM2; // Json 列直接写数组
        w += `清空了${wname}的攻击冷却`;
      }
    } else if (seq === 12) {
      // #龙姬（原版 @Constant 龙姬="12"；L599-608）：好感≥60 → 龙闪（当前状态压缩到1%，差值折算百分比）
      if (aff >= 60) {
        const total = (calcBonus.护盾 || player.shield || 0) + (calcBonus.装甲 || player.armor || 0) + (calcBonus.生命 || player.maxHp || 0);
        const cur = (player.shield || 0) + (player.armor || 0) + (player.hp || 0);
        const a1pct = total > 0 ? (cur / total) * 100 : 0;
        await this.achievementService.addAchievement(player, '龙闪', Math.round(a1pct));
        // 出口归一化：×0.01 必产生浮点尾（例：71.98 → 0.7198…），统一两位小数后入库
        player.hp = normalizePoolValue((player.hp || 0) * 0.01);
        player.armor = normalizePoolValue((player.armor || 0) * 0.01);
        player.shield = normalizePoolValue((player.shield || 0) * 0.01);
        w += `(龙闪${Math.round(a1pct)}%)`;
      }
    } else if (seq === 22) {
      // #普拉娜（原版 L610-619）：好感≥30 → 火力压制增益
      if (aff >= 30) {
        // 原版 玩家.技能等级：按熟练度平方阈值计算（数据显示.ecode L1640-L1665）。
        const skillLevel = this.playerService.getSkillLevel(markers, '普拉娜');
        const yzMark = markers2.find((m: any) => m && m.name === '压制');
        if (!yzMark || !yzMark.expireAt || yzMark.expireAt <= nowSec) {
          this.support.setMarkers2(markers2, '压制', nowSec + (18 + skillLevel * 1.2), 16);
          w += '\n火力压制16%';
        } else {
          this.support.setMarkers2(markers2, '压制', nowSec + (4.5 + skillLevel * 0.3), 1.5);
          w += '\n火力压制1.5%';
        }
        player.markers2 = markers2; // Json 列直接写数组
      }
    }

    // ctx 路径下 savePlayer 只做「合并进当前快照 + 标脏」，实际落库由最外层 mutate 执行一次
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 释放闪避技能，持续 ${roundedA1} 秒，冷却 ${Math.round(cooldownSec * 100) / 100} 秒`);
    return w;
    });
  }

  /**
   * 判断玩家是否装备指定名称的装备（对应原版 装备要求）
   * @param player 玩家对象
   * @param name 装备名称
   */

  async handleStartDungeon(userId: number, dungeonName = ''): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = dungeonName.trim();

    // 原版 L3863-L3884：无参数时列出唯一的复活点，并保留“a、刷新副本”快捷入口。
    if (!name) {
      const groups = await this.dungeonService.getInstanceGroups();
      const lines = [`${player.name}选择你需要开启的副本`];
      const shortcuts: string[] = [];
      groups.forEach((group, index) => {
        lines.push(`${index + 1}、${group.name}`);
        shortcuts.push(`${index + 1}@开启副本 ${group.name}`);
      });
      lines.push('a、刷新副本');
      shortcuts.push('a@刷新副本');
      await this.shortcutService.setTempInput(userId, shortcuts.join('#'));
      return lines.join('\n');
    }

    const group = await this.dungeonService.findInstanceGroup(name);
    const anchor = group?.maps.find((map) => map.name === name && (map.respawnPoint || map.复活点) === name);
    if (!group || !anchor) return `${player.name},${name}不是副本`;
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    const currentMap = await this.mapService.getMapById(player.mapId);
    if (!currentMap) return `${player.name}不在任何地图上`;
    if (currentMap.isFrontier || currentMap.isInstance) {
      return `${player.name}不能在家园或者副本里开`;
    }

    const backpack = this.playerService.getBackpackItems(player);
    const ticket = backpack.find((item: any) => (item?.name || item?.名称) === '副本券');
    const ticketCount = Number(ticket?.count ?? ticket?.quantity ?? ticket?.数量 ?? 0);
    if (!ticket || ticketCount < 1) {
      return `${player.name}需要副本券，去活跃度商店看看吧`;
    }

    // 原版 L3909-L3917：先记录成就、消耗副本券、增加5点活跃度，再追加入口。
    this.achievementService.setAchievement(
      playerData.markers,
      '开启副本',
      this.achievementService.getAchievement(playerData.markers, '开启副本') + 1,
    );
    playerData.markers['活跃度'] = this.playerService.getMarkerValue(playerData.markers, '活跃度') + 5;
    const removed = await this.playerService.removeFromBackpack(userId, '副本券', 1);
    if (!removed) return `${player.name}需要副本券，去活跃度商店看看吧`;
    await this.playerService.patchPlayer(userId, { markers: playerData.markers }, 'dungeon-open');

    const target = anchor;
    await this.mapService.appendMapConnection(currentMap.id, {
      name: `${group.name}(副本)`,
      mapId: target?.id,
      distance: 100,
      isInstance: true,
    });
    return `${player.name}在“${currentMap.name}”开启了副本${group.name}`;
  }

  /**
   * 刷新副本怪物
   * 重新生成当前副本的怪物
   * @param userId 用户ID
   * @returns 刷新结果
   */

  async handleRefreshDungeon(userId: number, dungeonName = ''): Promise<string> {
    // 1. 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = dungeonName.trim();

    // 原版 L3924-L3948：无参数时列出副本复活点，参数由临时输入替换回填。
    if (!name) {
      const groups = await this.dungeonService.getInstanceGroups();
      const lines = [`${player.name}选择你需要刷新的副本`];
      const shortcuts: string[] = [];
      groups.forEach((group, index) => {
        lines.push(`${index + 1}、${group.name}`);
        shortcuts.push(`${index + 1}@刷新副本 ${group.name}`);
      });
      if (shortcuts.length > 0) await this.shortcutService.setTempInput(userId, shortcuts.join('#'));
      return lines.join('\n');
    }

    // 原版 L3959：刷新副本冷却 300 秒。
    const markers2 = playerData.markers2;
    const cooldownText = { value: '' };
    const now = Date.now();
    this.normalizeDungeonMarkers2(markers2);
    if (this.combatState.timeIntervalRequire('刷新副本冷却', 300, markers2, now, cooldownText, now)) {
      await this.playerService.patchPlayer(userId, { markers2 }, 'dungeon-refresh-cooldown');
      return `${player.name}${cooldownText.value}`;
    }
    await this.playerService.patchPlayer(userId, { markers2 }, 'dungeon-refresh');

    const group = await this.dungeonService.findInstanceGroup(name);
    if (!group) return `${player.name},${name}不是副本`;
    const result = await this.dungeonService.closeDungeon(group.name);
    return result.message;
  }

  // ========== 载具部件系统 ==========

  // 原版 部件类型转换 L2180-L2195：0核心部件、1防御部件、2行走机构、4功能部件，默认武器部件。

  /**
   * 获取部件类型对应的插槽限制信息
   * @param vehicle 载具对象
   * @param partType 部件类型（0核心 1防御 2行走 3武器 4功能）
   */
  /** 过渡期公开（P3-2 HomeBuildService 经门面引用调用） */

  async handleClearDungeon(userId: number, dungeonName = ''): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    let name = dungeonName.trim();
    if (!name) {
      const currentMap = await this.mapService.getMapById(player.mapId);
      name = String(currentMap?.respawnPoint || currentMap?.复活点 || '').trim();
    }
    const group = await this.dungeonService.findInstanceGroup(name);
    if (!group) return name ? `${name}不是副本` : `${player.name}不在副本中`;

    // 原版 L7396-L7404：同一副本刷新标记冷却120秒，通关后30秒执行关闭。
    const markerMap = group.maps.find((map) => map.name === group.name) || group.maps[0];
    const markers2 = this.parseDungeonArray(markerMap.markers2);
    const now = Date.now();
    this.normalizeDungeonMarkers2(markers2);
    const refreshMarker = markers2.find((marker: any) => marker?.名称 === `${group.name}刷新`);
    if (refreshMarker && refreshMarker.有效期至 > now) return `${group.name}刷新冷却中`;
    markers2.push({ 名称: `${group.name}刷新`, 有效期至: now + 120 * 1000 });
    await this.mapService.updateDynamicFields(markerMap.id, { markers2 });

    // 30 秒后关闭副本：持久化延时任务（dedupeKey=地图组名），重启不丢。
    if (this.delayedTaskService) {
      await this.delayedTaskService.schedule({
        type: 'dungeonClose',
        dedupeKey: group.name,
        runAt: Date.now() + 30 * 1000,
        payload: { group: group.name },
      });
    }

    return `${group.name}副本已通关，副本将在30秒后传送全部玩家离开。`;
  }


  parseDungeonArray(value: any): any[] {
    // markers2 为合并地图字段：静态来源已是数组，DB 来源是 JSON 字符串
    const parsed = asJsonValue<any[]>(value, []);
    // 保持原语义：返回副本，避免调用方 splice 修改污染上游数据
    return Array.isArray(parsed) ? [...parsed] : [];
  }


  normalizeDungeonMarkers2(markers2: any[]): void {
    const normalized = markers2.map((marker: any) => this.combatState.normalizeBuffItem(marker));
    markers2.splice(0, markers2.length, ...normalized);
  }

  // ========== 载具命令 ==========

  /**
   * 处理组装载具命令
   * 使用部件组装载具，需要核心部件
   * 对应原版：组装 命令
   */

  async handleFamiliarChallenge(userId: number): Promise<string> {
    // 委托到使魔技能服务执行使魔挑战技能，进入挑战模式
    return this.familiarSkillsService.executeSkill(userId, '使魔挑战');
  }

  /**
   * 处理开始挑战命令
   * 开始使魔挑战
   * 委托到 FamiliarSkillsService.executeSkill 执行开始挑战技能
   */

  async handleStartChallenge(userId: number): Promise<string> {
    // 委托到使魔技能服务执行开始挑战技能，开始挑战
    return this.familiarSkillsService.executeSkill(userId, '开始挑战');
  }

  /**
   * 使魔挑战进入下一层（对应原版 _主程序.ecode L6431-6463 覅下一层）
   * 1:1 还原分支逻辑：
   *   置成就熟练度("挑战a", 玩家.标记, 0)        // 重置本层挑战熟练度
   *   添加成就("挑战等级", 1, 玩家.成就, 玩家.任务) // 挑战层数 +1
   *   添加成就("挑战成功", 1, 玩家2.成就, 玩家.任务)
   *   a = 挑战等级; b = 向上取整(a/5)
   *   获得物品(玩家.背包, 挑战装备箱 x b); 获得物品(玩家.背包, 挑战资源箱)
   *   玩家2.类型 = 挑战怪物(a)
   *   等级分段：a<300→ceil(a/5); a<500→a-300+60; 默认→(a-500)*10+260
   *   _初始化怪物(玩家2, , 玩家.地图); 加入成员(地图.怪物2, 玩家2)
   *   观察附近 + 提示
   * 说明：原版"怪物2"对应本框架 tempMonsters（副本/挑战专用临时怪数组）。
   * @param userId 用户ID
   * @returns 结果文本
   */

  async familiarChallengeNextLayer(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 解析标记对象（原版 玩家.标记）
    const markers = asJsonValue<any>(player.markers, {});

    // 原版 L6432：重置"挑战a"熟练度
    this.playerService.setMarker(markers, '挑战a', 0);
    // 原版 L6433：挑战等级 +1
    const level = this.playerService.getMarkerValue(markers, '挑战等级') + 1;
    this.playerService.setMarker(markers, '挑战等级', level);
    // 原版 L6434：挑战成功 +1
    this.playerService.setMarker(markers, '挑战成功', this.playerService.getMarkerValue(markers, '挑战成功') + 1);

    // 原版 L6436：b = 向上取整(a/5)
    const b = Math.ceil(level / 5);

    // 原版 L6437-6442：发放挑战装备箱(b个) + 挑战资源箱(1个)
    await this.playerService.addToBackpack(userId, '挑战装备箱', b);
    await this.playerService.addToBackpack(userId, '挑战资源箱', 1);

    // 原版 L6443：玩家2.类型 = 挑战怪物(a)
    const monsterName = this.combatSystem.challengeMonsterName(level);

    // 原版 L6444-6450：等级分段
    let monsterLevel: number;
    if (level < 300) monsterLevel = Math.ceil(level / 5);
    else if (level < 500) monsterLevel = level - 300 + 60;
    else monsterLevel = (level - 500) * 10 + 260;

    // 原版 L6451：_初始化怪物 —— 读取怪物配置并构造实例
    const cfg = this.staticData.getMonsterByName(monsterName) || {};
    const baseHp = cfg.maxHp || cfg.hp || 100;
    const baseAtk = cfg.attack || cfg.攻击 || 30;
    const baseDef = cfg.defense || cfg.防御 || 10;
    const monster = {
      name: monsterName,
      type: monsterName,
      level: monsterLevel,
      hp: Math.round(baseHp * (1 + monsterLevel * 0.1)),
      maxHp: Math.round(baseHp * (1 + monsterLevel * 0.1)),
      attack: Math.round(baseAtk * (1 + monsterLevel * 0.1)),
      defense: Math.round(baseDef * (1 + monsterLevel * 0.1)),
      exp: cfg.exp || 50,
      // 原版 _初始化怪物 的 bonus 由 buildMonsterBonus 构建，本框架挑战怪复用配置
    };

    // 原版 L6452：加入地图怪物2（本框架 tempMonsters）
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) {
      return `${player.name} 你不在任何地图上，无法进入下一层。`;
    }
    const tempMonsters = asJsonValue<any[]>(map.tempMonsters, []);
    tempMonsters.push(monster);
    await this.mapService.updateDynamicFields(map.id, { tempMonsters });

    // 保存玩家标记（挑战等级/挑战成功/挑战a 写入）
    player.markers = markers; // Json 列直接写对象
    await this.playerService.savePlayer(player);

    // 原版 L6453-6455：观察附近 + 提示文本
    const look = await this.facade!.handleLookAround(userId);
    return `${player.name} 准备挑战第${level}层，得到了${b}个挑战装备箱和挑战资源箱\n${look}`;
  }

  // ========== 地图/探索命令 ==========

  /**
   * 处理观察附近命令
   * 查看当前地图的玩家、怪物、资源等信息
   */

  async handleSpawnArtisan(userId: number): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN')) {
      return '权限不足，需要管理员权限';
    }
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上';

    // 原版 _主程序.ecode L7133-7150：生成两个怪物型召唤物加入当前地图召唤物——
    //   神之工匠（类型=粉狐狐、QQ=npc1g、特殊序号=-2）
    //   小雫（类型=精英小雫、QQ=npc2g、特殊序号=-2）
    const artisanSpecs = [
      { name: '神之工匠', type: '粉狐狐', qq: 'npc1g' },
      { name: '小雫', type: '精英小雫', qq: 'npc2g' },
    ];
    for (const spec of artisanSpecs) {
      let summon: any;
      try {
        const data = await this.mapService.createMapSummonByName(player.mapId, spec.type, {
          ownerQQ: '1',
          qq: spec.qq,
        });
        summon = { ...data, name: spec.name };
        summon.qq = spec.qq;
        summon.QQ = spec.qq;
      } catch (e: any) {
        this.logger.warn(`生成神之工匠 ${spec.type} 无怪物定义，按基础实体生成: ${e?.message}`);
        summon = {
          specialSeq: -2, name: spec.name, type: spec.type, qq: spec.qq,
          ownerQQ: '1', hp: 100, maxHp: 100, 标记: [], buffs: [],
        };
      }
      summon.specialSeq = -2;
      summon.特殊序号 = -2;
      summon.归属 = '1';
      await this.mapService.mutateSummons(player.mapId, (fresh) => {
        fresh.push(summon);
      });
    }

    this.logger.log(`管理员 ${userId} 在地图 ${map.name} 生成神之工匠`);
    return `${player.name || '冒险者'}
神之工匠来到了${map.name}`;
  }

  /**
   * 处理生成废弃载具命令
   * 在当前地图生成一个废弃载具残骸，可采集资源
   * 对应原版：废弃载具 命令
   */

  async handleSpawnWreck(userId: number): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN')) {
      return '权限不足，需要管理员权限';
    }

    // 原版 _主程序.ecode L7152-7156 + 后台运作.ecode 生成随机载具(真,a)：
    // 按几率加权抽取随机载具定义（wrecks.json，含零件清单），归属=无主，
    // 随机生成地点=编号3起、排除开拓地/关卡/副本/不刷特殊地图，加入该地图载具列表。
    const wrecks = this.staticData.loadRaw('wrecks') as any[];
    if (!Array.isArray(wrecks) || wrecks.length === 0) {
      return '随机载具列表为空，无法生成废弃载具';
    }
    // 按几率加权抽取（原版几率判断循环的等价实现）
    const totalChance = wrecks.reduce((sum, w) => sum + Math.max(0, Number(w?.chance ?? 0)), 0);
    let roll = Math.random() * totalChance;
    let wreck = wrecks[0];
    for (const candidate of wrecks) {
      roll -= Math.max(0, Number(candidate?.chance ?? 0));
      if (roll <= 0) {
        wreck = candidate;
        break;
      }
    }

    const maps = await this.mapService.getAllMaps();
    const candidates = (maps as any[]).filter((m: any) =>
      Number(m?.id ?? 0) >= 3 && !m.开拓地 && !m.isFrontier && !m.关卡 && !m.isInstance && !m.noSpecial);
    if (candidates.length === 0) return '没有可生成废弃载具的地图';
    const targetMap = candidates[Math.floor(Math.random() * candidates.length)];

    const seq = `${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const runtime = this.facade!.toRuntimeVehicle({});
    runtime.名称 = String(wreck.name ?? '废弃载具').replace(/[0-9]/g, '');
    runtime.name = runtime.名称;
    runtime.编号 = `V${seq}`;
    runtime.vehicleId = runtime.编号;
    runtime.归属 = '无主';
    runtime.owner = '';
    runtime.驾驶员 = '';
    runtime.driver = '';
    // 随机载具零件清单（原版 零件=名称数量，装备类由生成装备生成——此处保留清单原样）
    runtime.零件 = (wreck.parts ?? []).map((part: any) => ({
      名称: String(part?.name ?? ''),
      name: String(part?.name ?? ''),
      类型: '资源',
      type: '资源',
      数量: Number(part?.count ?? 1) || 1,
      quantity: Number(part?.count ?? 1) || 1,
    }));
    this.combatSystem.recalculateVehicle(runtime, Date.now());
    const calculatedHp = Number(runtime.加成?.生命 || 0);
    runtime.当前生命 = calculatedHp;
    runtime.currentHp = calculatedHp;
    runtime.生命 = calculatedHp;
    runtime.maxHp = calculatedHp;

    await this.mapService.mutateMapFields(targetMap.id, ['vehicles'], (f) => {
      const vehicles = Array.isArray(f.vehicles) ? f.vehicles : [];
      vehicles.push(this.facade!.toStoredVehicle(runtime));
      f.vehicles = vehicles;
      return true;
    });

    this.logger.log(`管理员 ${userId} 在地图 ${targetMap.name} 生成废弃载具 ${runtime.名称}`);
    return `在${targetMap.name}生成了一个废弃载具`;
  }

  /**
   * 处理签到命令
   * 每日签到系统，支持连续签到奖励和累计签到奖励
   * 签到数据存储在 Player 的 markers 字段中，key: "daily_checkin"
   * 对应原版：签到 命令
   */

  async handleRefreshMonster(userId: number, monsterName = ''): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN')) {
      return '权限不足，需要管理员权限';
    }
    const name = String(monsterName ?? '').trim();
    if (!name) return '用法：「刷新怪物 怪物名」';

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${player.name || '冒险者'}不在任何地图上`;

    try {
      // 原版 _初始化怪物 + 加入 地图.怪物2：常驻怪物（isTemp=false，可被删除怪物/刷怪循环管理）
      await this.mapService.spawnMonsterByName(Number(player.mapId), name, { isTemp: false });
    } catch (e: any) {
      this.logger.warn(`刷新怪物 ${name} 失败: ${e?.message}`);
      return `怪物列表未找到"${name}"`;
    }
    this.logger.log(`管理员 ${userId} 在地图 ${map.name} 刷新了怪物 ${name}`);
    return `在${map.name}刷新了一只${name}`;
  }

  /**
   * 生成人物（管理员）（原版 _主程序.ecode L6853-6881）。
   * 用法：生成人物@人 名称 类型 类型2(npc或宠物) 好感 宝宝(1或者0)。
   * 归属=取数字(@参数)；好感写入召唤物标记「好感+归属QQ」；宝宝=1 追加「宝宝」标记。
   * 类型2=npc → QQ=“召唤物”+编号（纯剧情实体）；宠物 → QQ=“怪物”+编号+“g”
   * + _初始化怪物（createMapSummonByName，完整怪物初始化）。
   * 加入 地图列表[3].召唤物（原版固定地图3）。原版取图片(类型)前缀为 QQ 图片承载，新版省略。
   */

  async handleSpawnNpc(userId: number, argsString = ''): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN')) {
      return '权限不足，需要管理员权限';
    }
    const parts = String(argsString ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 6) {
      return '生成人物@人 名称 类型 类型2(npc或宠物) 好感 宝宝(1或者0)';
    }
    const [ownerArg, summonName, type, kind, affinityRaw, babyRaw] = parts;
    // 原版 取数字()：从“@123”中提取纯数字归属
    const ownerQQ = String(ownerArg).replace(/[^0-9]/g, '');
    const affinity = Math.trunc(Number(affinityRaw)) || 0;

    const owner = await this.prisma.player.findFirst({
      where: { masterQQ: ownerQQ },
    });
    if (!owner) return `归属玩家不存在：${ownerQQ}`;

    // 生成编号()：时间戳36进制+随机串，保证唯一且可读
    const seq = `${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    // 好感/宝宝写入召唤物标记（原版 添加成就("好感"+归属,…)/(“宝宝”,1, 玩家2.标记)）
    const summonMarkers: any[] = [{ 名称: `好感${ownerQQ}`, 数值: affinity }];
    if (String(babyRaw) === '1') summonMarkers.push({ 名称: '宝宝', 数值: 1 });

    let summon: any;
    if (kind !== 'npc') {
      // 宠物：QQ=“怪物”+编号+“g” + _初始化怪物（原版 L6870-6871，固定地图3 的等级成长）
      try {
        const data = await this.mapService.createMapSummonByName(3, type, {
          ownerQQ,
          qq: `怪物${seq}g`,
        });
        summon = {
          ...data,
          name: summonName,
          markers: [...(Array.isArray(data.markers) ? data.markers : []), ...summonMarkers],
          标记: [...(Array.isArray(data.标记) ? data.标记 : []), ...summonMarkers],
        };
      } catch (e: any) {
        this.logger.warn(`生成人物 宠物类型 ${type} 无怪物定义，按 npc 实体生成: ${e?.message}`);
      }
    }
    if (!summon) {
      // npc（或宠物无定义时的兜底）：纯剧情实体，结构与“白”一致（原版不做怪物初始化）
      summon = {
        specialSeq: 0,
        name: summonName,
        type,
        image: type,
        qq: `召唤物${seq}`,
        ownerQQ,
        affinity,
        好感: affinity,
        level: 1,
        hp: 100,
        maxHp: 100,
        combatPower: 0,
        成就: [],
        背包: [],
        增益: [],
        武器: [],
        装备: [],
        标记2: [],
        标记: summonMarkers,
        任务: [],
        装备预设: [],
      };
    }

    // 加入 地图列表[3].召唤物（原版 L6877 固定地图3）
    const map3 = await this.mapService.getMapById(3);
    if (!map3) return '地图3不存在，无法生成人物';
    await this.mapService.mutateSummons(3, (summons) => {
      summons.push(summon);
    });

    this.logger.log(`管理员 ${userId} 在地图3 生成了 ${summonName}（${type}/${kind}，归属 ${ownerQQ}）`);
    // 原版 L6878-6880：取图片(类型) + “在X生成了Y” + 加括号(“属于”+名称+","+QQ)
    return `在${map3.name}生成了${summonName}（属于${owner.name || '未知'},${ownerQQ}）`;
  }

  /**
   * 删除怪物（管理员）
   * 对应原版：删除怪物 命令
   */

  async handleDeleteMonster(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, markers2 } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${player.name || '冒险者'}不在任何地图上`;

    // 原版 L6811-L6812：副本地图禁止使用“删除怪物”。
    if (map.isInstance) return `${player.name || '冒险者'}副本不可以`;

    const battleText = { value: '' };
    // 兼容存量数据：地图标记2容器必须为数组
    const rawMapMarkers2 = asJsonValue<any>(map.markers2, []);
    const mapMarkers2 = Array.isArray(rawMapMarkers2) ? rawMapMarkers2 : [];
    const now = Date.now();
    if (this.combatState.markerRequire('战斗', mapMarkers2, battleText, now)) {
      return `${player.name || '冒险者'}当前地图处于战斗状态，请离开一段时间后再回来，还有${battleText.value}`;
    }

    // 原版 L6815：成功检查后才写入10分钟刷怪冷却。
    const cooldownText = { value: '' };
    if (this.combatState.timeIntervalRequire('刷怪冷却', 600, markers2, now, cooldownText, now)) {
      player.markers2 = markers2; // Json 列直接写数组
      await this.playerService.savePlayer(player);
      return `${player.name || '冒险者'}${cooldownText.value}`;
    }

    await this.mapService.clearMapMonsters(map.id);
    this.achievementService.setAchievement(
      markers,
      '删除怪物',
      this.achievementService.getAchievement(markers, '删除怪物') + 1,
    );
    player.markers = markers;
    player.markers2 = markers2;
    await this.playerService.savePlayer(player);
    await this.support.advanceTask(userId, '删除怪物');

    return `${player.name || '冒险者'}，${map.name}附近的怪物被清除了。一般它们会被立即刷新出来。`;
  }

  /**
   * 切换生产模式
   * 对应原版：生产0/生产1 命令
   */
}
