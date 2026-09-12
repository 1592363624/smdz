/**
 * 延时任务/存图指令域服务（game 模块化重构 P3-3 抽出）
 *
 * 职责：装填（reload）与补给（refill）的排程与延时结算、保存图片（存图）系列。
 * 依赖方向：依赖 Player、DelayedTaskService（排程）、CombatState、Chat、
 * Achievement、Prisma、Map、FamiliarSystemService、StaticData、Dungeon、Task、
 * HomeService、SkillCommandService、ShopTradeService、QuestDialogueService、
 * HomeBuildService 与支撑层；内核域（gather/movement/rescue/vehicle/panel）的
 * 结算入口过渡期经门面引用触达（P3-6 合并后改为直接注入）。
 * 单一真相源：dts.registerHandler 注册块仍整体保留在 GameService.onModuleInit
 * （§4.2 C5：门面是唯一知道全部延时入口的地方，注册时序不可变，R9 冒烟测试锁定）。
 * 对口原版：_主程序.ecode 延时任务/装填/补给/存图分支。
 */import { Injectable, Logger, Optional } from '@nestjs/common';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlayerService } from '.././player.service';
import { MapService } from '.././map.service';
import { AchievementService } from '.././achievement.service';
import { HomeService } from '.././home.service';
import { StaticDataService } from '.././static-data.service';
import { ChatService } from '../../chat/chat.service';
import { TaskService } from '.././task.service';
import { CombatStateService } from '.././combat-state.service';
import { DelayedTaskService } from '.././delayed-task.service';
import { GameSupportService } from '.././game-support.service';
import { GameService } from '.././game.service';

@Injectable()
export class DelayedSettleService {
  private readonly logger = new Logger(DelayedSettleService.name);

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
    private readonly mapService: MapService,
    private readonly achievementService: AchievementService,
    private readonly homeService: HomeService,
    private readonly staticData: StaticDataService,
    private readonly chatService: ChatService,
    private readonly taskService: TaskService,
    private readonly combatState: CombatStateService,
    @Optional() private readonly delayedTaskService?: DelayedTaskService,
  ) {}

  async handleReload(userId: number, targetName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, markers2, weapons } = playerData;
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    let mode: 'plana' | 'organ' | '' = '';
    if (Number(player.specialSeq) === 22 && Number(player.affinity || 0) >= 60) {
      mode = 'plana';
    } else if (Number(player.currentWeapon || 0) !== 0) {
      const currentWeapon = this.support.currentWeaponItem(player, weapons);
      if (this.support.equipmentSpecialSeq(currentWeapon) === -14 || this.support.itemName(currentWeapon) === '管风琴') {
        mode = 'organ';
      }
    }

    if (!mode) return `${player.name}当前还不需要装填1`;

    if (mode === 'organ') {
      const loaded = this.achievementService.getAchievement(markers, '管风琴');
      if (loaded === 4) return `${player.name}还不需要装填3`;
      const seconds = (4 - loaded) * 15;
      this.support.normalizeMarkers2(markers2);
      this.combatState.addMarker('工作', seconds, markers2, Date.now());
      player.markers = markers;
      player.markers2 = markers2;
      await this.playerService.savePlayer(player);
      this.scheduleReloadCompletion(userId, 'organ', seconds);
      return `${player.name}正在给管风琴装填${4 - loaded}发火箭弹，需要${seconds}秒`;
    }

    const pending = weapons.filter((weapon: any) =>
      this.achievementService.getAchievement(markers, `${this.support.itemName(weapon)}t`) < 1,
    );
    if (pending.length === 0) return `${player.name}当前还不需要装填`;
    const weaponNames = pending.map((weapon: any) => this.support.itemName(weapon)).join('、');
    const seconds = pending.length * 3;
    this.support.normalizeMarkers2(markers2);
    this.combatState.addMarker('工作', seconds, markers2, Date.now());
    player.markers = markers;
    player.markers2 = markers2;
    await this.playerService.savePlayer(player);
    this.scheduleReloadCompletion(userId, 'plana', seconds);
    return `${player.name}正在给${weaponNames}超装填，需要${seconds}秒`;
  }


  scheduleReloadCompletion(
    userId: number,
    mode: 'plana' | 'organ',
    seconds: number,
  ): void {
    if (!this.delayedTaskService) return;
    // 任务行落库即跨重启存活：装填进度以任务行为准，不再依赖进程内定时器。
    // 同 (type,userId) 先删后插，重复装填天然覆盖上一条排程。
    void this.delayedTaskService.schedule({
      type: 'reload',
      userId,
      runAt: Date.now() + Math.max(0, seconds) * 1000,
      payload: { mode },
    });
  }

  /** 装填延时到期：写装填完成成就并广播。由 DelayedTaskService 分发。 */

  async completeReload(userId: number, mode: string): Promise<void> {
    // 支柱二·自串行：本方法由延时任务 tick 直调（无外层锁），读改写段必须
    // 在用户级串行邮箱内基于新鲜快照执行；指令路径调用时邮箱重入放行。
    await this.playerService.enqueueUserWrite(userId, async () => {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, weapons } = playerData;
    let result: string;
    if (mode === 'organ') {
      this.achievementService.setAchievement(markers, '管风琴', 4);
      result = `${player.name}的管风琴装填完毕了。`;
    } else {
      const completed: string[] = [];
      for (const weapon of weapons) {
        const weaponName = this.support.itemName(weapon);
        if (this.achievementService.getAchievement(markers, `${weaponName}t`) < 1) {
          this.achievementService.setAchievement(markers, `${weaponName}t`, 1);
          completed.push(weaponName);
        }
      }
      const skillLevel = Math.floor(
        this.playerService.getSkillLevel(markers, '普拉娜'),
      ) + 1;
      result = `${player.name}给${completed.join('、')}进行了超装填，它们下次命中的时候会造成${1.25 + skillLevel / 100}倍的伤害。`;
    }
    player.markers = markers;
    await this.playerService.savePlayer(player);
    // 支柱三：先落库后广播——回执/广播只在状态已持久化后发出
    await this.chatService.broadcastSystem('世界频道', result, userId);
    });
  }

  /**
   * 处理生成神之工匠命令
   * 在当前地图生成一个神之工匠NPC，用于高级装备制作
   * 对应原版：神之工匠 命令
   */

  async handleRefill(userId: number): Promise<string> {
    // 对齐原版 _主程序.ecode L7110-7129「补魔」：与跟随中的召唤物补魔（涩涩玩法），
    // 非喝药回蓝。门禁链：躺下中 → 自家房子屋内 → 有跟随召唤物 → 补魔间隔21600秒。
    // 通过后：随机取对话(类型7 补魔开始) + 「工作」35秒 + 排程30秒延时结算
    // （completeRefill，原版「覅b魔w成」）。
    return this.support.mutatePlayer(userId, async (ctx) => {
      const { player, markers, markers2 } = ctx;

      // 门禁1：需「躺下」成就状态（原版 L7111 取成就熟练度(玩家.标记,"躺下")==0 → 需要躺下；
      // 新版 handleLieDown 写 markers['躺下']=1、handleWakeUp 清除，语义等价）
      if (this.playerService.getMarkerValue(asJsonValue<Record<string, any>>(player.markers, {}), '躺下') !== 1) {
        return `${player.name ?? '冒险者'}需要“躺下”`;
      }

      // 门禁2：地图必须是自家房子「屋内」（原版 L7113 地图.名称 != 玩家.房子名称+"屋内"）
      const map = await this.mapService.getMapById(player.mapId);
      if (!map) return `${player.name ?? '冒险者'}不能野战`;
      const houseName = String((player as any).houseName ?? '');
      if (!houseName || String(map.name ?? '') !== `${houseName}屋内`) {
        return `${player.name ?? '冒险者'}不能野战`;
      }

      // 门禁3：有跟随中的召唤物（原版 L7116 召唤物跟随显示(玩家,2,...)，b==0 → 不能自己发电）
      const display = await this.facade!.summonFollowDisplay(map, userId, { requireFollow: true, countLimit: 2 });
      if (display.count === 0) return `${player.name ?? '冒险者'}不能自己发电`;
      const displayText = `正在和${display.names.join('、')}一起`;

      // 门禁4：补魔间隔 21600 秒冷却（原版 L7119 时间间隔要求("补魔间隔",21600,玩家.标记2)）
      const remaining = { value: '' };
      const now = Date.now();
      if (this.combatState.timeIntervalRequire('补魔间隔', 21600, markers2, now, remaining, now)) {
        return `${player.name ?? '冒险者'}太频繁了,${remaining.value}`;
      }

      // 随机取一个跟随对象说补魔开始台词（原版 L7122-7125 随机文本(w3) + 取对话(…,7)）
      const summons = Array.isArray(map.summons) ? map.summons : asJsonValue<any[]>(map.summons, []);
      const target = summons[display.indexes[this.support.randomInt(0, display.indexes.length - 1)]];
      const dialogue = target
        ? this.staticData.getDialogue(String(player.name ?? ''), target, String(target.name ?? target.名称 ?? ''), 7)
        : '';

      // 执行：工作 35 秒标记（原版 L7127 添加标记("工作",35,玩家.标记2)）+ 排程 30 秒延时
      this.support.normalizeMarkers2(markers2);
      this.combatState.addMarker('工作', 35, markers2, now);
      player.markers2 = markers2; // Json 列直接写数组
      if (this.delayedTaskService) {
        await this.delayedTaskService.schedule({
          type: 'refill',
          userId,
          dedupeKey: String(userId),
          runAt: now + 30 * 1000,
        });
      }
      // 文本（原版 L7126 w = w3 + 玩家.名称 + w2 + "补魔"）
      return `${dialogue}${player.name ?? '冒险者'}${displayText}补魔`;
    });
  }

  /**
   * 补魔的 30 秒延时结算（原版 _主程序.ecode L7158-7319「覅b魔w成」）。
   * 结算：校验补魔对象仍在 → 取对话(类型8 补魔结束) → 玩家与跟随召唤物获得
   * 「兴奋」增益（小恶魔在场 3600 秒、默认 600 秒）→ 召唤物好感+3 →
   * 成就/任务「补魔」推进。
   * 幼崽诞生分支（原版 L7226-7317）依赖活力常量表与怪物模板初始化，尚未迁移，
   * 待对应子系统落地后补齐。
   */

  async completeRefill(userId: number): Promise<void> {
    const text = await this.playerService.enqueueUserWrite(userId, async () => {
      const playerData = await this.playerService.getPlayerData(userId);
      const { player } = playerData;
      const map = await this.mapService.getMapById(player.mapId);
      if (!map) return '';

      // 补魔对象校验（原版 L7159-7161：跟随显示 b==0 → 补魔失败）
      const display = await this.facade!.summonFollowDisplay(map, userId, { requireFollow: true, countLimit: 2 });
      if (display.count === 0) return `${player.name ?? '冒险者'}补魔对象丢失，补魔失败`;
      const displayText = `与${display.names.join('、')}一起`;

      // 随机取一个对象说补魔结束台词（原版 L7163-7166 取对话(…,8)）
      const mapSummons: any[] = Array.isArray(map.summons) ? map.summons : asJsonValue<any[]>(map.summons, []);
      const target = mapSummons[display.indexes[this.support.randomInt(0, display.indexes.length - 1)]];
      const dialogue = target
        ? this.staticData.getDialogue(String(player.name ?? ''), target, String(target.name ?? target.名称 ?? ''), 8)
        : '';

      // 兴奋增益时长（原版 L7169-7183：有特殊宠物小恶魔(-20) → 3600 秒，否则 600 秒；
      // 套装「小樱命中+陪睡>3 → 7200」依赖召唤物套装字段，尚未迁移，暂按默认两档）
      let buffSeconds = 600;
      if (this.homeService.hasSpecialPet(-20, mapSummons) !== -1) buffSeconds = 3600;

      // 玩家获得「兴奋」（原版 L7184 获得增益(玩家.增益,"兴奋",a2)；
      // bonus.service 已按兴奋口径折算攻击+15%/双抗命中闪避暴击+20%/掉落率+50%等）
      const buffs = asJsonValue<any[]>(player.buffs, []);
      this.combatState.gainBuff(buffs, '兴奋', buffSeconds, false, Date.now());
      player.buffs = buffs; // Json 列直接写数组

      // 给跟随中的召唤物加「兴奋」+好感3（原版 L7185-7224：
      // 归属=玩家、跟随标记==0、非露娜、非临时召唤物（QQ含x）、
      // hp==0 的 NPC 不算（「白」例外））
      const ownerKey = String(userId);
      const boostedNames: string[] = [];
      const boostedIndexes: number[] = [];
      for (let i = 0; i < mapSummons.length; i++) {
        const summon = mapSummons[i];
        const owner = String(summon?.ownerQQ ?? summon?.归属 ?? summon?.owner ?? summon?.qq ?? '');
        if (owner !== ownerKey) continue;
        let summonMarkers: any = summon?.markers ?? summon?.标记 ?? {};
        if (!Array.isArray(summonMarkers) && typeof summonMarkers === 'string') {
          summonMarkers = asJsonValue<any>(summonMarkers, {});
        }
        const followProf = Array.isArray(summonMarkers)
          ? Number(summonMarkers.find((m: any) => (m?.name ?? m?.名称) === '跟随')?.value ?? 0)
          : Number(summonMarkers?.['跟随'] ?? 0);
        if (followProf >= 1) continue; // 只有设置为跟随的才跟玩家补魔
        const qq = String(summon?.qq ?? summon?.QQ ?? '');
        if (qq === '怪物露娜1g') continue; // 露娜是来帮忙的不是来上床的
        if (qq.includes('x')) continue;   // 临时召唤物不能补魔
        const hp = Number(summon?.hp ?? summon?.当前生命 ?? 1);
        const name = String(summon?.name ?? summon?.名称 ?? summon?.type ?? summon?.类型 ?? '宠物');
        if (hp <= 0 && name !== '白') continue; // 生命0的是npc不是宠物
        boostedNames.push(name);
        boostedIndexes.push(i);
      }
      if (boostedIndexes.length > 0) {
        await this.mapService.mutateSummons(map.id, (fresh: any[]) => {
          for (const i of boostedIndexes) {
            const summon = fresh[i];
            if (!summon) continue;
            const summonBuffs = asJsonValue<any[]>(summon.buffs ?? summon.增益, []);
            this.combatState.gainBuff(summonBuffs, '兴奋', buffSeconds, false, Date.now());
            summon.buffs = summonBuffs;
            const summonMarkers = asJsonValue<Record<string, any>>(summon.markers ?? summon.标记 ?? {}, {});
            const affinityKey = `好感${ownerKey}`;
            summonMarkers[affinityKey] = Number(summonMarkers[affinityKey] ?? 0) + 3;
            summon.markers = summonMarkers;
          }
          return true;
        }).catch(() => false);
      }

      // 任务推进（原版 L7318 添加成就("补魔", c, 玩家.成就, 玩家.任务)；
      // c 在原版循环中恒为 2）
      await this.support.advanceTask(userId, '补魔', 2);
      await this.playerService.savePlayer(player);

      // 文本（原版 L7167/L7225）
      const durationText = buffSeconds >= 3600
        ? `${buffSeconds / 3600}小时`
        : `${buffSeconds / 60}分钟`;
      let resultText = `${dialogue}${player.name ?? '冒险者'}${displayText}补魔结束，`
        + `${player.name ?? '冒险者'}、${boostedNames.join('、')}${durationText}内`
        + `攻击+15%、状态/回复/百分比回复/命中/闪避/暴击/抗性+20%、传说几率+25%、掉落率+50%、掉落数量/经验获取+100%`
        + `\n${boostedNames.join('、')}对${player.name ?? '冒险者'}好感+3`;
      const taskNotice = this.taskService.consumeNotifications(userId);
      if (taskNotice) resultText = `${taskNotice}\n————————\n${resultText}`;
      return resultText;
    });

    if (text) {
      await this.chatService.broadcastSystem('世界频道', text, userId).catch(() => undefined);
      try {
        await this.facade!.pushPlayerUpdate(userId);
        await this.facade!.pushMapUpdate(userId);
      } catch { /* 推送失败不影响结算 */ }
    }
  }

  /**
   * 处理挤奶命令。
   * 对齐原版 _主程序.ecode L9034-L9084：成功对象按“对象QQ+当天”冷却，
   * 普通召唤物默认产奶0.25，怪物/捕捉动物读取产奶量；所有成功对象共用一套结算。
   */

  async handleSaveImage(userId: number, imageName: string): Promise<string> {
    void imageName;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'SUPER_ADMIN') {
      return '权限不足，需要作者权限';
    }
    return '保存图片开始/保存图片停止用于开启/停止两分钟的图片接收窗口';
  }

  /**
   * 保存图片开始（原版 _主程序.ecode L10669-10672）。
   * 作者权限 → 获得“tk”增益 120 秒（标记2）→
   * “你在接下来两分钟内发送的图片都会被保存,”保存图片停止“来停止”。
   * Web 等价：tk 窗口内前端推送的图片消息按保存路径处理（图片本体由前端 URL 承载）。
   */

  async handleStartSaveImage(userId: number): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'SUPER_ADMIN') {
      return '权限不足，需要作者权限';
    }
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers2 } = playerData;
    this.combatState.gainBuff(markers2, 'tk', 120, false, Date.now());
    player.markers2 = markers2; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    return '你在接下来两分钟内发送的图片都会被保存,“保存图片停止”来停止';
  }

  /**
   * 保存图片停止（原版 _主程序.ecode L10674-10675）。
   * 获得增益(标记2,"tk",-120) 的负值语义 = 移除 tk 增益 → “已停止。”
   */

  async handleStopSaveImage(userId: number): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'SUPER_ADMIN') {
      return '权限不足，需要作者权限';
    }
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers2 } = playerData;
    const filtered = (Array.isArray(markers2) ? markers2 : []).filter(
      (entry: any) => (entry?.name ?? entry?.名称) !== 'tk',
    );
    player.markers2 = filtered; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    return '已停止。';
  }

  /**
   * 停止接管载具
   * 对应原版：接管停止 命令
   */
}
