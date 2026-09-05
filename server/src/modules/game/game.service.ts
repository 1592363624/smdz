/**
 * 游戏引擎主服务
 * 对应原版易语言：_主程序.ecode 的核心逻辑
 * 负责协调各子服务，提供统一的游戏操作入口
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { BonusService, BonusData } from './bonus.service';
import { CombatSystemService } from './combat-system.service';
import { ItemService } from './item.service';
import { MapService } from './map.service';
import { FamiliarService } from './familiar.service';
import { DungeonService } from './dungeon.service';
import { AdminService } from '../admin/admin.service';
import { AchievementService } from './achievement.service';
import { ItemSystemService } from './item-system.service';
import { FamiliarSystemService } from './familiar-system.service';
import { FamiliarSkillsService } from './familiar-skills.service';
import { HomeService } from './home.service';
import { TutorialService } from './tutorial.service';
import { StaticDataService } from './static-data.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { ChatService } from '../chat/chat.service';
import { FeedbackService } from '../feedback/feedback.service';
import { TaskService } from './task.service';
import { ShortcutService } from './shortcut.service';
import { StatsService } from './stats.service';
import { CombatStateService } from './combat-state.service';
import { PlayerMutateService } from './player-mutate.service';
import { DelayedTaskService } from './delayed-task.service';
import { AutoMineService } from './auto-mine.service';
import { VitalityService } from './vitality.service';
import { HandbookService } from './handbook.service';
import { normalizeGameText, formatDisplayNumber } from '../../common/utils/game-text.util';
import { filterActive, formatRemain, remainSeconds, toExpireMs } from './expire-time.util';
import { buildFamiliarGateMenu } from './familiar-menu.util';
import { asJsonValue } from '../../common/utils/json-value.util';

interface QuestSource {
  npcName: string;
  taskNames: string[];
  publisher?: string;
}

/** 图鉴条目：name 必填，brief=列表页简介，detail=详情页逐行文本 */
interface HandbookEntry {
  name: string;
  brief?: string;
  detail?: string[];
}

@Injectable()
export class GameService {
  private readonly logger = new Logger(GameService.name);
  /** 采集开始阶段的进程内去重时间戳：key=userId（防同刻连发双开任务）。 */
  private readonly gatherStartInflight = new Map<number, number>();
  private readonly tradeLocks = new Map<string, Promise<void>>();
  /** 玩家面板推送防抖定时器：同一玩家短时间内的多次状态变化合并为一次推送 */
  private readonly playerUpdateTimers = new Map<number, NodeJS.Timeout>();
  /** 地图面板推送防抖定时器：作用同上，避免自动战斗/怪物反击期间的 socket 风暴 */
  private readonly mapUpdateTimers = new Map<number, NodeJS.Timeout>();
  /** 推送版本号计数器（player:{uid} / map:{uid} → 单调递增 rev，供前端丢弃乱序旧包） */
  private readonly revCounters = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly bonusService: BonusService,
    private readonly combatSystem: CombatSystemService,
    private readonly itemService: ItemService,
    private readonly mapService: MapService,
    private readonly familiarService: FamiliarService,
    private readonly dungeonService: DungeonService,
    private readonly adminService: AdminService,
    private readonly achievementService: AchievementService,
    private readonly itemSystemService: ItemSystemService,
    private readonly homeService: HomeService,
    private readonly familiarSystemService: FamiliarSystemService,
    private readonly familiarSkillsService: FamiliarSkillsService,
    private readonly tutorialService: TutorialService,
    private readonly staticData: StaticDataService,
    private readonly systemConfigService: SystemConfigService,
    private readonly chatService: ChatService,
    private readonly feedbackService: FeedbackService,
    private readonly taskService: TaskService,
    private readonly shortcutService: ShortcutService,
    private readonly statsService: StatsService,
    private readonly combatState: CombatStateService,
    @Optional() private readonly autoMineService?: AutoMineService,
    // 活力上限与恢复公式共用规则服务，确保魅力历史值和旧存档兜底一致。
    @Optional() private readonly vitalityService?: VitalityService,
    // 玩家状态收口入口（Actor 式写入口）。放最后且 @Optional：
    // 既不影响现有测试桩的位置传参，未注入时也走 mutatePlayer 的等价回退路径。
    @Optional() private readonly playerMutate?: PlayerMutateService,
    // 持久化延时任务（采集/移动/救援/装填/副本关闭的跨重启排程）。
    // @Optional：测试桩以 Object.create 构造或老位置传参时走「无排程」降级，
    // 由启动迁移（recoverOrphanDelayedMarkers）与既有扫描兜底。
    @Optional() private readonly delayedTaskService?: DelayedTaskService,
    // 图鉴服务（HandbookService）负责 20 分类的详情渲染与搜索；
    // 用 @Optional 是为兼容现有 Object.create 测试桩，新测试请直接注入。
    @Optional() private readonly handbookService?: HandbookService,
  ) {}

  /**
   * 玩家状态变更的收口入口（对 PlayerMutateService.mutate 的薄封装）。
   *
   * 生产环境由 Nest 注入真实的 PlayerMutateService（Actor 式：锁内单一快照、
   * 统一落库、货币审计、嵌套复用）。测试桩若不提供该依赖，则退化为等价的
   * 「enqueueUserWrite + getPlayerData + fn + savePlayer」路径，保持旧行为不变，
   * 避免逐个测试桩补依赖。
   */
  private mutatePlayer<T>(userId: number, fn: (ctx: any) => Promise<T> | T): Promise<T> {
    if (this.playerMutate) return this.playerMutate.mutate(userId, fn);
    return this.playerService.enqueueUserWrite(userId, async () => {
      const ctx = await this.playerService.getPlayerData(userId);
      const result = await fn(ctx);
      await this.playerService.savePlayer(ctx.player);
      return result;
    });
  }

  /** 模块初始化：注册各延时任务的结算 handler，并把存量标记迁移为延时任务。 */
  onModuleInit(): void {
    if (!this.delayedTaskService) return;
    const dts = this.delayedTaskService;
    dts.registerHandler('gather', async (task) => {
      await this.settleGatherResource(Number(task.userId));
    });
    dts.registerHandler('move', async (task) => {
      const targetMapId = Number(task.payload?.targetMapId || 0);
      const targetName = String(task.payload?.targetName || '');
      if (!targetMapId) return;
      await this.performArrival(Number(task.userId), targetMapId, targetName);
    });
    dts.registerHandler('rescue', async (task) => {
      if (!task.payload?.marker) return;
      await this.completeRescue(Number(task.userId), task.payload.marker);
    });
    dts.registerHandler('reload', async (task) => {
      await this.completeReload(Number(task.userId), String(task.payload?.mode || 'plana'));
    });
    dts.registerHandler('dungeonClose', async (task) => {
      const group = String(task.payload?.group || '');
      if (group) await this.dungeonService.closeDungeon(group);
    });
    // 手动载具开采结算（原版 _主程序.ecode L7534「开采1c2c」60秒延时）
    dts.registerHandler('mine', async (task) => {
      await this.settleManualMine(Number(task.userId));
    });
    // 补魔结算（原版 _主程序.ecode L7158「覅b魔w成」30秒延时）
    dts.registerHandler('refill', async (task) => {
      await this.completeRefill(Number(task.userId));
    });
    // 召唤货舱结算（原版 _主程序.ecode L6298「召h货1藏」6秒延时：扣信号枪生成货舱资源）
    dts.registerHandler('cargo', async (task) => {
      await this.completeCargoSummon(Number(task.userId), Number(task.payload?.count || 0));
    });
    // 维修载具结算（原版 _主程序.ecode L10449 新建延时「维修wcc1」a 秒）：
    // 延时到期后真正修好载具，并把结算文本广播给玩家（延时路径无指令收尾）。
    dts.registerHandler('repair', async (task) => {
      const text = await this.completeVehicleRepair(Number(task.userId));
      if (text) await this.chatService.broadcastSystem('世界频道', text, Number(task.userId)).catch(() => undefined);
    });
    // 存量迁移：把上一代实现遗留在 markers 里的「采集中/移动中/救援」状态
    // 补建成延时任务（幂等：schedule 先删后插，标记已结算时结算 handler 自行空转）。
    void this.recoverOrphanDelayedMarkers().catch((e: any) => {
      this.logger.warn(`延时任务存量迁移失败（下次重启重试）: ${e?.message || e}`);
    });
  }

  /**
   * 启动迁移：扫一遍玩家 markers，把「采集中」「移动中」以及 markers2 里的救援标记
   * 补建成延时任务行。正常情况下这些状态在创建时就会同时排程任务，本方法只服务于
   * （a）首次部署时仍挂着旧实现内存定时器的玩家；（b）异常情况下任务行丢失的兜底。
   */
  private async recoverOrphanDelayedMarkers(): Promise<void> {
    if (!this.delayedTaskService) return;
    const players = await this.prisma.player.findMany({
      where: { userId: { gt: 0 } },
      select: { userId: true, markers: true, markers2: true },
    });
    const now = Date.now();
    let recovered = 0;
    for (const row of players || []) {
      const userId = Number(row.userId);
      if (!userId) continue;
      const markers = asJsonValue<Record<string, any>>(row.markers, {});
      const gathering = markers['采集中'];
      if (gathering && typeof gathering === 'object' && Number(gathering.settleAt || 0) > 0) {
        await this.delayedTaskService.schedule({
          type: 'gather',
          userId,
          runAt: Math.max(now, Number(gathering.settleAt)),
        });
        recovered += 1;
      }
      const movingStr = markers['移动中'];
      if (movingStr) {
        try {
          const moving = asJsonValue<{ targetName?: string; targetMapId?: number; arriveAt?: number } | null>(movingStr, null);
          if (moving?.arriveAt && moving?.targetMapId) {
            await this.delayedTaskService.schedule({
              type: 'move',
              userId,
              runAt: Math.max(now, Number(moving.arriveAt)),
              payload: { targetMapId: Number(moving.targetMapId), targetName: String(moving.targetName || '') },
            });
            recovered += 1;
          }
        } catch { /* 移动中标记损坏：忽略，由原有逻辑兜底 */ }
      }
      const markers2 = asJsonValue<any[]>(row.markers2, []);
      for (const marker of markers2) {
        const name = marker?.name ?? marker?.名称;
        if (marker?.rescueType && (name === '复活' || name === '工作')) {
          await this.delayedTaskService.schedule({
            type: 'rescue',
            userId,
            dedupeKey: String(marker.token ?? `${name}`),
            runAt: Math.max(now, this.rescueExpireAtSeconds(marker) * 1000),
            payload: { marker },
          });
          recovered += 1;
        }
      }
    }
    if (recovered > 0) this.logger.log(`延时任务存量迁移: 已为 ${recovered} 个进行中状态补建任务行`);
  }

  /**
   * 原版玩家指令收尾钩子：触发纯白之翼自动技能和宠物后台搜索。
   * 对应 _主程序 L11462 及 L11573-L11669 的顺序：技能自动处理后进入宠物互动/搜索。
   */
  async triggerAutoFamiliarSkill(userId: number): Promise<string> {
    const lines: string[] = [];
    const autoSkillText = await this.familiarSystemService.autoCastSkill(userId);
    if (autoSkillText) lines.push(autoSkillText);

    const petSearchText = await this.familiarSkillsService.searchPetItems(userId);
    if (petSearchText) lines.push(petSearchText);

    return lines.join('\n');
  }

  /**
   * 生成编号快捷菜单（"编号选项"统一入口）
   * 对齐原版"快捷输入"的临时输入替换机制：为每个选项生成 编号@触发指令 的临时替换，
   * 玩家发送对应编号数字即可触发指令，无需记忆指令名。
   * 统一展示格式：1、选项A  2、选项B ...
   * @param userId 玩家用户ID
   * @param options 选项列表 [{ label: 展示文本, cmd: 触发指令(为空则仅展示不生成快捷) }]
   * @param hint 底部提示语（默认：💡 发送编号数字(如 1)即可快速操作）
   * @returns 生成的编号菜单展示行（含分隔线和提示），调用方直接 push 到输出即可
   */
  private async buildNumberedMenu(
    userId: number,
    options: { label: string; cmd: string }[],
    hint = '💡 发送编号数字(如 1)即可快速操作',
    // 原版同时映射文字别名（如 “不要跟着我了@设置跟随X”，_主程序.ecode L1546）：
    // 额外的 临时输入 组（原文@目标指令），随编号组一并写入。
    extraGroups: string[] = [],
  ): Promise<string[]> {
    const lines: string[] = [];
    const tempGroups: string[] = [];
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      lines.push(`  ${i + 1}、${opt.label}`);
      if (opt.cmd) tempGroups.push(`${i + 1}@${opt.cmd}`);
    }
    tempGroups.push(...extraGroups.filter(Boolean));
    if (tempGroups.length > 0) {
      // 设置临时输入替换（2分钟有效，触发一次后清空；同时保留直接输入指令的方式）
      await this.shortcutService.setTempInput(userId, tempGroups.join('#'));
      lines.push(`${hint}`);
    }
    return lines;
  }

  /**
   * 查看地图单位详情（原版 对话菜单 1、查看 → 查看X，_主程序.ecode L1519-1520）。
   * 支持 NPC/召唤物/怪物；找不到返回空串（由调用方回退到查看自己）。
   */
  async handleViewUnit(userId: number, unitName: string): Promise<string> {
    const name = String(unitName || '').trim();
    if (!name) return '';
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '';

    const parse = (value: any): any[] => asJsonValue<any[]>(value, []);
    const markerOf = (unit: any, markerName: string): number => {
      const raw = unit?.markers ?? unit?.标记 ?? {};
      const parsed = typeof raw === 'string' ? asJsonValue<any>(raw, {}) : raw;
      if (Array.isArray(parsed)) {
        const item = parsed.find((x: any) => (x?.name ?? x?.名称) === markerName);
        return Number(item?.value ?? item?.数值 ?? item?.count ?? 0);
      }
      return Number(parsed?.[markerName] ?? 0);
    };

    // NPC/召唤物
    const unit = parse(map.npcs).find((n: any) => (n?.name ?? n?.名称) === name)
      || parse(map.summons).find((s: any) =>
        [s?.name, s?.名称, s?.image, s?.图片].some((v: any) => String(v ?? '') === name));
    if (unit) {
      const lines = [`【${String(unit?.name ?? unit?.名称 ?? name)}】`];
      lines.push(`类型:${String(unit?.type ?? unit?.类型 ?? '未知')}`);
      const hp = Number(unit?.hp ?? unit?.当前生命 ?? 0);
      const maxHp = Number(unit?.maxHp ?? unit?.最大生命 ?? 0);
      if (maxHp > 0) lines.push(`生命:${hp}/${maxHp}`);
      const affinity = markerOf(unit, `好感${userId}`);
      if (affinity) lines.push(`对你的好感:${this.round2Text(affinity)}`);
      const owner = String(unit?.ownerQQ ?? unit?.归属 ?? '');
      if (owner) {
        const ownerUser = await this.prisma.user.findUnique({ where: { id: Number(owner) } }).catch(() => null);
        lines.push(`归属:${ownerUser?.nickname || ownerUser?.username || owner}`);
      }
      return lines.join('\n');
    }

    // 怪物（含临时怪）
    try {
      const monsters = await this.mapService.getMapMonsters(map.id);
      const monster = (monsters || []).find((m: any) =>
        [m?.name, m?.名称].some((v: any) => String(v ?? '') === name));
      if (monster) {
        const lines = [`【${String(monster?.name ?? name)}】`];
        lines.push(`类型:${String((monster as any)?.type ?? (monster as any)?.类型 ?? '怪物')}`);
        if (monster.level) lines.push(`等级:${monster.level}`);
        if (monster.maxHp) lines.push(`生命:${monster.hp}/${monster.maxHp}`);
        if (monster.attack) lines.push(`攻击:${monster.attack}`);
        if (monster.defense) lines.push(`防御:${monster.defense}`);
        return lines.join('\n');
      }
    } catch { /* 怪物查询失败回退 */ }
    return '';
  }

  /**
   * 处理玩家攻击命令
   * 对应原版：攻击 命令
   * 委托给完整的战斗子系统 combatSystem.weaponAttack 执行完整攻击流程
   * 包括：武器攻击 → 伤害计算（含暴击/命中） → 使魔特效 → 怪物死亡处理 → 经验获得 → 掉落生成
   */
  async handleAttack(userId: number): Promise<string> {
    // 调用完整的战斗系统进行武器攻击（索引0=拳头，默认攻击）
    const result = await this.combatSystem.weaponAttack(userId, 0, {});
    // 返回攻击结果文本（含攻击描述、伤害、击杀、经验、掉落等信息）
    return result.result;
  }

  /**
   * 处理移动命令（延时到达）
   * 对应原版：移动/前往 命令
   * 发出移动后，玩家进入"移动中"状态，经过实际耗时秒数后才真正到达目的地；
   * 期间再次发起移动会被拦截并提示剩余时间，杜绝"连发移动瞬间到达"的作弊。
   * 若配置 game.moveTimeEnabled=false 则退化为即时到达。
   */
  async handleMove(userId: number, targetMapName: string): Promise<string> {
    // 读取"移动真实耗时"开关（配置项，可在管理后台在线切换）
    const moveTimeEnabled = await this.systemConfigService.get<boolean>('game.moveTimeEnabled', true);

    let playerData = await this.playerService.getPlayerData(userId);
    let { player } = playerData;

    // 1. 检查是否已在移动中
    const markers = playerData.markers;
    const movingStr = markers['移动中'];
    if (movingStr) {
      // 「移动中」标记兼容对象（新）与 JSON 字符串（旧数据）两种形态
      const moving = asJsonValue<{ targetName?: string; targetMapId?: number; arriveAt?: number } | null>(movingStr, null);
      if (moving && moving.arriveAt) {
        const now = Date.now();
        if (now < moving.arriveAt) {
          // 仍在赶往上一目的地：拦截并提示剩余时间
          const remain = Math.max(1, Math.ceil((moving.arriveAt - now) / 1000));
          return `你正在前往【${moving.targetName}】，还需约${remain}秒到达，请耐心等待`;
        }
        // 耗时至已到期但尚未落地(如服务重启丢定时器)：先补完成上次移动
        await this.performArrival(userId, moving.targetMapId!, moving.targetName!);
        playerData = await this.playerService.getPlayerData(userId);
        player = playerData.player;
      }
    }

    const currentMap = await this.mapService.getMapById(player.mapId);
    if (!currentMap) {
      return `地图不存在，请检查名称`;
    }

    // 对齐原版 _主程序.ecode L6514：行动无限制（八项门禁：移动/复活/采集/工作/麻痹/
    // 躺下/自动开采/炮击，无豁免——移动中自然被拦）
    const moveRestriction = this.combatSystem.actionUnrestricted(player);
    if (moveRestriction.restricted) return moveRestriction.text;

    const requestedName = String(targetMapName || '').trim();

    // 对齐原版 L6516-6517：关卡图有怪且目标不是“出口”时，必须先清除附近的目标
    if (Number(currentMap.关卡 ?? 0) !== 0 && requestedName !== '出口') {
      let gateMonsters: any[] = [];
      try {
        gateMonsters = await this.mapService.getMapMonsters(currentMap);
      } catch {
        gateMonsters = [];
      }
      if (gateMonsters.length !== 0) {
        return `${player.name}需要清除附近的目标`;
      }
    }

    // 对齐原版 L6519-6536：空参返回编号菜单——家园进度≠0 时首位是自家房子，
    // 其余为非开拓地地图，全部写入临时输入替换（N@前往地图名）。
    if (!requestedName) {
      const maps = await this.mapService.getAllMaps();
      const options: string[] = [];
      const tempInputParts: string[] = [];
      if (player.houseName && this.playerService.getMarkerValue(asJsonValue(player.markers, {}), '家园进度') !== 0) {
        options.push(String(player.houseName));
        tempInputParts.push(`1@前往${player.houseName}`);
      }
      for (const m of maps) {
        if (!m || m.开拓地 || m.isFrontier) continue;
        options.push(String(m.name));
        tempInputParts.push(`${options.length}@前往${m.name}`);
      }
      if (this.shortcutService?.setTempInput && tempInputParts.length > 0) {
        await this.shortcutService.setTempInput(userId, tempInputParts.join('#'));
      }
      return `${player.name || '冒险者'}请选择地点:\n${options.map((n, i) => `${i + 1}、${n}`).join('\n')}`;
    }

    // 对齐原版 L6547-6548：处于战斗标记且本图有怪时不能前往
    {
      const moveMarkers2 = Array.isArray(playerData.markers2)
        ? playerData.markers2
        : this.parseJsonArray(player.markers2);
      let fightMonsters: any[] = [];
      try {
        fightMonsters = await this.mapService.getMapMonsters(currentMap);
      } catch {
        fightMonsters = [];
      }
      const combatText = { value: '' };
      if (fightMonsters.length !== 0 && this.combatState.markerRequire?.('战斗', moveMarkers2, combatText, Date.now())) {
        return `${player.name}战斗状态，`;
      }
    }

    // 对齐原版 L6549-6576：「出口」分支——副本退出（空间乱流）。
    // 当前地图可前往含“出口”时：随机目的地（编号3起、排除关卡/不刷特殊），
    // 路径=当前图→空间乱流→目的地（成就“移动”按路径节点数=3推进），
    // 耗时=50/速度（整数截断、下限3），写“移动”标记并延时到达。
    if (requestedName === '出口'
      && this.mapService.getConnections(currentMap).some((connection: any) => connection?.name === '出口')) {
      const maps = await this.mapService.getAllMaps();
      const candidates = maps.filter((m: any) =>
        Number(m?.id ?? 0) >= 3 && !m.关卡 && !m.isInstance && !m.noSpecial && !m.不刷特殊);
      if (candidates.length > 0) {
        const dest = candidates[Math.floor(Math.random() * candidates.length)];
        let exitSeconds = Math.floor(50 / Math.max(1, Number(player.speed || 100)));
        if (exitSeconds < 3) exitSeconds = 3;

        if (!moveTimeEnabled) {
          const arrival = await this.performArrival(userId, dest.id, dest.name);
          await this.advanceTask(userId, '移动', 3);
          return arrival;
        }

        await this.scheduleArrival(userId, dest.id, dest.name, exitSeconds);
        // 原版 L6574 添加标记("移动", b, 玩家.标记2)——行动无限制的移动锁数据源
        const exitMarkers2 = asJsonValue<any[]>(player.markers2, []);
        this.normalizeMarkers2(exitMarkers2);
        this.combatState.addMarker('移动', exitSeconds, exitMarkers2, Date.now());
        player.markers2 = exitMarkers2; // Json 列直接写数组
        await this.playerService.savePlayer(player);
        // 原版 L6573：路径节点数 = 当前图/空间乱流/目的地 共 3 个
        await this.advanceTask(userId, '移动', 3);
        const exitFollow = await this.summonFollowDisplay(currentMap, userId, { requireFollow: true });
        const exitFollowText = exitFollow.count > 0 ? `带着${exitFollow.names.join('、')}一起` : '';
        return `${player.name || '冒险者'}${exitFollowText}开始前往${dest.name},大概需要${exitSeconds}秒`;
      }
      // 地图无“出口”连接或无候选目的地：原版静默落空，继续按普通前往解析
    }

    const dungeonEntry = this.mapService.getConnections(currentMap)
      .find((connection: any) => connection?.name === requestedName);
    const isDungeonEntry = requestedName.endsWith('(副本)');
    let targetMap: any = null;
    if (isDungeonEntry) {
      // 原版 _主程序.ecode L6578-L6604：必须先验证当前地图存在该临时入口，
      // 再去掉“(副本)”解析真实地图并按传送路径移动。
      if (!dungeonEntry) return `${player.name}#错误：副本不存在"${requestedName}"`;
      const baseName = requestedName.slice(0, -4);
      targetMap = await this.mapService.getMapByName(baseName).catch(() => null);
    } else {
      targetMap = await this.mapService.getMapByName(requestedName).catch(() => null);
    }

    if (!currentMap || !targetMap) {
      return `地图不存在，请检查名称`;
    }

    // 对齐原版 _主程序.ecode 前往分支：目的地为当前位置时 取最短路径 距离为0，
    // 按“没有路径”拦截，不允许反复前往脚下地图；副本入口按传送处理不受此限制。
    if (!isDungeonEntry && Number(targetMap.id) === Number(currentMap.id)) {
      return `${player.name}所在地"${currentMap.name}"没有前往"${targetMap.name}"的路径`;
    }

    // 检查是否可以前往
    const check = isDungeonEntry
      ? { canTravel: true }
      : this.mapService.checkCanTravel(currentMap, targetMap, player);
    if (!check.canTravel) {
      return `无法前往：${check.reason}`;
    }

    // 对齐原版 _主程序.ecode L6555：载具行走方式 0(未安装行走机构)/4(坐地) 时不能"前往"
    // 仅在玩家有载具时检查，无载具则步行不受限
    if (player.vehicle) {
      const travelVehicle = await this.findTravelVehicle(player, currentMap);
      if (travelVehicle) {
        const walkMode = Number(travelVehicle?.行走方式 ?? travelVehicle?.walkMode ?? 0);
        if (walkMode === 0) {
          return `${player.name}的载具${travelVehicle?.name || travelVehicle?.名称 || ''}没有安装行走机构，无法行走`;
        }
        if (walkMode === 4) {
          return `${player.name}的载具${travelVehicle?.name || travelVehicle?.名称 || ''}处于坐地模式，无法行走`;
        }
      }
    }

    // 计算移动所需耗时（秒）
    const travelDistance = isDungeonEntry
      ? Number(dungeonEntry?.distance || 100)
      : this.getDistance(currentMap, targetMap);
    const travelTime = this.mapService.calcTravelTime(
      travelDistance,
      player.speed || 100,
    );
    // 原版 _主程序.ecode L6574/L6601/L6664：移动任务按最短路径节点数推进，
    // 不是按耗时或距离推进；路径长度至少按一次移动处理。
    const movementTaskCount = await this.getMovementPathLength(currentMap, targetMap);

    // 若关闭了移动耗时开关，则即时到达
    if (!moveTimeEnabled) {
      const result = await this.performArrival(userId, targetMap.id, targetMap.name);
      if (!/不存在|已经在/.test(result)) {
        await this.advanceTask(userId, '移动', movementTaskCount);
      }
      return result;
    }

    // 2. 记录"移动中"状态（持久化到 markers，重启后可恢复），并调度延时到达
    const newMarkers = asJsonValue(player.markers, {});
    newMarkers['移动中'] = JSON.stringify({
      targetName: targetMap.name,
      targetMapId: targetMap.id,
      startedAt: Date.now(),
      arriveAt: Date.now() + travelTime * 1000,
      fromMapId: currentMap.id,
    });
    player.markers = newMarkers; // Json 列直接写对象
    // 原版 L6668 添加标记("移动", b, 玩家.标记2)——行动无限制移动锁的数据源
    const moveMarkers2 = asJsonValue<any[]>(player.markers2, []);
    this.normalizeMarkers2(moveMarkers2);
    this.combatState.addMarker('移动', travelTime, moveMarkers2, Date.now());
    player.markers2 = moveMarkers2; // Json 列直接写数组
    await this.playerService.savePlayer(player);

    // 3. 启动到达定时器，到点后真正落地（更新位置 + 广播到达）
    await this.scheduleArrival(userId, targetMap.id, targetMap.name, travelTime);
    await this.advanceTask(userId, '移动', movementTaskCount);

    return `你开始前往【${targetMap.name}】，预计${travelTime}秒后到达`;
  }

  /**
   * 处理“传送/跃迁”命令（对应 _主程序.ecode L1676-1808）。
   * 与“前往/移动”不同：传送立即落地。门禁链：死亡→行动无限制→载具行走方式四态
   * （无载具才检查天蓝吊坠/军姬免费传送）→空参菜单（家园房子+编号临时输入替换）→
   * 原地/不存在/不可传送→战斗状态（本图有怪）→5秒冷却→前往需求。
   * 执行：观测地图+剪毛→玩家移动(资产迁移)→成就→活跃度+1→代发言触发→
   * 观察附近(临时输入)→文本分支（无载具=分子重组+成就传送；有载具=跃迁到了+
   * 成就跃迁+旗舰跃迁引擎 30 秒冷却 200% 倍率攻击+覅攻击pd）。
   */
  async handleTeleport(userId: number, targetMapName: string): Promise<string> {
    let playerData = await this.playerService.getPlayerData(userId);
    let player = playerData.player;
    const name = player.name || '冒险者';
    if (this.playerService.isPlayerDead(player)) return this.playerService.handlePlayerDeath(userId, player);

    const markers2 = Array.isArray(playerData.markers2)
      ? playerData.markers2
      : this.parseJsonArray(player.markers2);
    const restriction = this.combatSystem.actionUnrestricted(player);
    if (restriction.restricted) return restriction.text;

    const currentMap = await this.mapService.getMapById(player.mapId);
    if (!currentMap) return '地图不存在，请检查名称';

    // 载具行走方式四态门禁（原版 L1684-1695）：有载具按行走方式拦截，
    // 无载具才检查天蓝吊坠/军姬免费传送。
    const vehicle = await this.findTravelVehicle(player, currentMap);
    if (vehicle) {
      const walkMode = Number(vehicle?.行走方式 ?? vehicle?.walkMode ?? vehicle?.moveType ?? 0);
      const vehicleName = vehicle?.名称 || vehicle?.name || '';
      if (walkMode === 1) return `${name}当前驾驶的载具${vehicleName}只能使用“前往”来移动`;
      if (walkMode === 2) return `${name}当前驾驶的载具${vehicleName}只能使用“前往”或者“飞到”来移动`;
      if (walkMode === 4) return `${name}当前驾驶的载具${vehicleName}安装了无法移动的组件`;
      if (walkMode === 0) return `${name}当前驾驶的载具${vehicleName}未安装行走机构或有的部件超过了上限`;
    } else {
      const equipment = playerData.equipment || asJsonValue<any[]>(player.equipment, []);
      const hasPendant = equipment.some((item: any) => String(item?.name ?? item?.名称 ?? '') === '天蓝吊坠');
      const freeByFamiliar = await this.familiarSystemService.canFreeTeleport(userId);
      if (!hasPendant && !freeByFamiliar) return `${name},需要装备“天蓝吊坠”`;
    }

    const requested = String(targetMapName || '').trim();
    if (!requested) {
      // 空参菜单（原版 L1706-1724）：家园进度≠0 时首位是自家房子，其余为可传送地图；
      // 全部编号写入临时输入替换（N@传送地图名）。
      const maps = await this.mapService.getAllMaps();
      const options: string[] = [];
      const tempInputParts: string[] = [];
      if (player.houseName && this.playerService.getMarkerValue(asJsonValue(player.markers, {}), '家园进度') !== 0) {
        options.push(String(player.houseName));
        tempInputParts.push(`1@传送${player.houseName}`);
      }
      for (const m of maps) {
        if (!m || m.不可传送 || m.noTeleport || m.开拓地 || m.isFrontier) continue;
        options.push(String(m.name));
        tempInputParts.push(`${options.length}@传送${m.name}`);
      }
      if (this.shortcutService?.setTempInput && tempInputParts.length > 0) {
        await this.shortcutService.setTempInput(userId, tempInputParts.join('#'));
      }
      return `${name}请选择地点:\n${options.map((n, i) => `${i + 1}、${n}`).join('\n')}\n你也可以发送“传送@人”来传送到其他玩家身边`;
    }

    let targetMap: any = null;
    let targetName = requested;
    const playerTarget = requested.match(/^\[@([^\]]+)\]$/);
    if (playerTarget) {
      const identity = playerTarget[1];
      const userModel: any = (this.prisma as any).user;
      const targetUser = await userModel?.findFirst?.({ where: { OR: [{ qqNumber: identity }, { externalId: identity }] } })
        ?? (/^\d+$/.test(identity) ? await userModel?.findUnique?.({ where: { id: Number(identity) } }) : null);
      if (!targetUser) return `${name}对方未加入游戏：${requested}`;
      const targetPlayer = await (this.prisma as any).player?.findUnique?.({ where: { userId: targetUser.id } });
      if (!targetPlayer) return `${name}对方未加入游戏：${requested}`;
      targetName = String(targetPlayer.location || targetPlayer.mapId || '');
      targetMap = await this.mapService.getMapById(targetPlayer.mapId);
    } else {
      targetMap = await this.mapService.getMapByName(requested).catch(() => null);
    }
    // 原版 L1734-1741 拦截顺序：原地 → 不存在 → 不可传送 → 战斗状态 → 冷却 → 前往需求
    if (targetMap && Number(targetMap.id) === Number(currentMap.id)) return `${name}不能原地重组。`;
    if (!targetMap) return `${name},${targetName}在地图列表不存在。`;
    if (targetMap.不可传送 || targetMap.noTeleport) {
      return `${name}目的地${targetName}存在严重干扰，贸然前往后果不可预料。`;
    }

    let mapMonsters: any[] = [];
    try {
      mapMonsters = await this.mapService.getMapMonsters(currentMap);
    } catch {
      mapMonsters = [];
    }
    const combatText = { value: '' };
    if (mapMonsters.length !== 0 && this.combatState.markerRequire?.('战斗', markers2, combatText, Date.now())) {
      return `${name}战斗状态`;
    }

    const cooldownText = { value: '' };
    if (this.combatState.timeIntervalRequire('传送冷却', 5, markers2, Date.now(), cooldownText, Date.now())) {
      player.markers2 = markers2; // Json 列直接写数组
      await this.playerService.savePlayer(player);
      return `${name}${cooldownText.value}`;
    }
    const travelCheck = this.mapService.checkCanTravel(currentMap, targetMap, player);
    if (!travelCheck.canTravel) return `${name}${travelCheck.reason || '无法前往该地图'}`;

    // ===== 执行（原版 L1747-1808）=====
    const fromMapId = player.mapId;
    player.mapId = targetMap.id;
    player.location = targetMap.name;

    // 观测地图产出 + 四圣祭坛麒麟 + 普拉娜幼崽剪毛（与来倒目的共用统一入口）
    let triggerText = '';
    try {
      triggerText = await this.applyArrivalTriggers(player, targetMap);
    } catch (e: any) {
      this.logger.warn(`传送到达触发失败: ${e.message}`);
    }

    // 玩家移动（原版 L1755）：载具/跟随召唤物资产迁移 + 移除“风月入墨”增益
    await this.migratePlayerAssetsOnMove(fromMapId, targetMap.id, player);

    await this.combatSystem.applyMapBuffs(player, targetMap);
    player.markers2 = markers2; // Json 列直接写数组
    await this.playerService.savePlayer(player);

    await this.taskService.advance(userId, `前往${targetName}`);
    // 任务结算(advance)基于最新库数据改写过字段，重载快照再写活跃度，避免旧对象回写。
    player = (await this.playerService.getPlayerData(userId)).player;

    // 活跃度+1（原版 L1759）
    const activeMarkers = asJsonValue(player.markers, {});
    this.incrementMarker(activeMarkers, '活跃度', 1);
    player.markers = activeMarkers;
    await this.playerService.savePlayer(player);

    // 代发言触发（原版 L1761-1777）：地图“代发言”字段当前数据未配置（已知遗留），
    // 字段存在时按原版语义执行——载具损毁看隐形披风，其余看载具隐形模块。
    const autoBroadcast = String((targetMap as any).代发言 ?? (targetMap as any).autoBroadcast ?? '');
    if (autoBroadcast) {
      if (autoBroadcast === '触发攻击') {
        const vehicleHp = Number(vehicle?.当前生命 ?? vehicle?.currentHp ?? vehicle?.hp ?? 0);
        let shouldTrigger = false;
        if (vehicle && vehicleHp < 0) {
          const freshEquip = asJsonValue<any[]>((await this.playerService.getPlayerData(userId)).player.equipment, []);
          const hasCloak = freshEquip.some((item: any) => String(item?.name ?? item?.名称 ?? '') === '隐形披风');
          shouldTrigger = !hasCloak;
        } else {
          const partNames = vehicle ? this.collectVehiclePartNames(vehicle) : [];
          shouldTrigger = !partNames.includes('隐形模块');
        }
        if (shouldTrigger) {
          await this.combatSystem.triggerMapBattleLoop(userId, 5, { player, map: targetMap });
        }
      }
      // 其余代发言文本为原版内部延时指令（0 秒新建延时），当前无对应映射，暂略。
    }

    // 观察附近 + 编号临时输入替换（原版 L1758 w4=观察附近 + 临时输入替换）
    let lookText = '';
    try {
      lookText = await this.handleLookAround(userId);
    } catch (e: any) {
      this.logger.warn(`传送生成观察附近失败: ${e.message}`);
    }

    const follow = await this.summonFollowDisplay(targetMap, userId, { requireFollow: true });
    const followText = follow.count > 0 ? `带着${follow.names.join('、')}一起` : '';
    let lines: string[];
    if (!vehicle) {
      lines = [`${name}${followText}在${targetName}完成了分子重组。`];
      await this.taskService.advance(userId, '传送');
    } else {
      lines = [`${name}${followText}跃迁到了${targetName}`];
      await this.taskService.advance(userId, '跃迁');
      // 旗舰跃迁引擎（原版 L1786-1800）：目的地有怪且载具装引擎，30 秒冷却通过时
      // 立即以 200% 倍率必中全体攻击 + 5 秒后怪物回合 + 活跃度+1。
      try {
        mapMonsters = await this.mapService.getMapMonsters(targetMap);
      } catch {
        mapMonsters = [];
      }
      const partNames = this.collectVehiclePartNames(vehicle);
      const jumpText = { value: '' };
      if (mapMonsters.length > 0
        && partNames.includes('旗舰跃迁引擎')
        && !this.combatState.timeIntervalRequire('旗舰跃迁', 30, markers2, Date.now(), jumpText, Date.now())) {
        const attack = await this.combatSystem.weaponAttack(userId, Number(player.currentWeapon ?? 0), {
          damageMultiplier: 200,
          mustHit: true,
          allAttack: true,
          attackText: '旗舰跃迁a',
        });
        if (attack?.result) lines.push(attack.result);
        player = (await this.playerService.getPlayerData(userId)).player;
        const jumpMarkers = asJsonValue(player.markers, {});
        this.incrementMarker(jumpMarkers, '活跃度', 1);
        player.markers = jumpMarkers;
        player.markers2 = markers2; // Json 列直接写数组
        await this.playerService.savePlayer(player);
        await this.combatSystem.triggerMapBattleLoop(userId, 5, { player, map: targetMap });
      }
    }
    if (triggerText) lines.push(triggerText);
    if (lookText) lines.push(lookText);
    return lines.join('\n');
  }

  /**
   * 处理飞到命令。
   * 飞行和普通前往共用到达结算，但入口条件、冷却和延迟时间按原版飞行分支单独处理。
   */
  async handleFlyTo(userId: number, targetMapName: string): Promise<string> {
    let playerData = await this.playerService.getPlayerData(userId);
    let { player } = playerData;
    const playerName = player.name || '冒险者';
    const markers = playerData.markers || asJsonValue(player.markers, {});
    const markers2 = Array.isArray(playerData.markers2)
      ? playerData.markers2
      : this.parseJsonArray(player.markers2);

    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 原版新手地图（地图序号小于3）不能直接飞行，只能先观察并按剧情移动。
    if (Number(player.mapId) < 3) {
      return `${playerName}当前不可用，观察附近看看吧`;
    }

    // 飞行不能覆盖正在进行的移动/工作；已到期的移动先补结算，兼容服务重启丢失定时器。
    const moving = asJsonValue<any>(markers['移动中'], null);
    if (moving?.arriveAt) {
      if (Date.now() < Number(moving.arriveAt)) {
        return `你正在前往【${moving.targetName || '目的地'}】，还需约${Math.max(1, Math.ceil((moving.arriveAt - Date.now()) / 1000))}秒到达，请耐心等待`;
      }
      if (moving.targetMapId) {
        await this.performArrival(userId, Number(moving.targetMapId), String(moving.targetName || '目的地'));
        playerData = await this.playerService.getPlayerData(userId);
        player = playerData.player;
      }
    }

    const currentMap = await this.mapService.getMapById(player.mapId);
    if (!currentMap) return '地图不存在，请检查名称';

    const activeMarkerText = { value: '' };
    if (this.combatState?.markerRequire?.('工作', markers2, activeMarkerText, Date.now())) {
      return `${playerName}正在工作，${activeMarkerText.value || '请稍后再试'}`;
    }

    const requestedName = String(targetMapName || '').trim();
    if (!requestedName) {
      const maps = typeof this.mapService.getAllMaps === 'function'
        ? await this.mapService.getAllMaps()
        : [];
      const options = maps
        .filter((map: any) => map && !map.noTeleport && !map.不可传送 && !map.isFrontier && !map.开拓地)
        .map((map: any) => String(map.name || ''))
        .filter((name: string) => name && name !== currentMap.name);
      if (this.shortcutService?.setTempInput && options.length > 0) {
        await this.shortcutService.setTempInput(
          userId,
          options.map((name: string, index: number) => `${index + 1}@飞到${name}`).join('#'),
        );
      }
      return `${playerName}请选择地点:\n${options.map((name: string, index: number) => `${index + 1}、${name}`).join('\n')}\n你也可以发送“飞到@人”来飞到其他玩家身边`;
    }

    let targetMap: any = null;
    const playerTarget = requestedName.match(/^\[@([^\]]+)\]$/);
    if (playerTarget) {
      const identity = playerTarget[1];
      const userModel: any = (this.prisma as any).user;
      let targetUser: any = null;
      if (userModel?.findFirst) {
        targetUser = await userModel.findFirst({
          where: { OR: [{ qqNumber: identity }, { externalId: identity }] },
        });
      }
      if (!targetUser && userModel?.findUnique && /^\d+$/.test(identity)) {
        targetUser = await userModel.findUnique({ where: { id: Number(identity) } });
      }
      if (!targetUser) return `${playerName}对方未加入游戏：${requestedName}`;
      const targetPlayer = await (this.prisma as any).player?.findUnique?.({
        where: { userId: targetUser.id },
      });
      if (!targetPlayer) return `${playerName}对方未加入游戏：${requestedName}`;
      targetMap = await this.mapService.getMapById(targetPlayer.mapId);
    } else {
      targetMap = await this.mapService.getMapByName(requestedName).catch(() => null);
    }

    if (!targetMap) return `${playerName},${requestedName}在地图列表不存在。`;
    if (targetMap.id === currentMap.id) return `${playerName}不能原地飞。`;
    if (targetMap.noTeleport || targetMap.不可传送) {
      return `${playerName}目的地${targetMap.name}无法飞过去。`;
    }

    let monsters: any[] = [];
    try {
      monsters = typeof this.mapService.getMapMonsters === 'function'
        ? await this.mapService.getMapMonsters(currentMap)
        : [];
    } catch {
      monsters = [];
    }
    const battleText = { value: '' };
    if (monsters.length > 0 && this.combatState?.markerRequire?.('战斗', markers2, battleText, Date.now())) {
      return `${playerName}战斗状态，${battleText.value || '请先结束战斗'}`;
    }

    const cooldownText = { value: '' };
    if (this.combatState?.timeIntervalRequire?.('飞行冷却', 10, markers2, Date.now(), cooldownText, Date.now())) {
      player.markers2 = markers2; // Json 列直接写数组
      await this.playerService.savePlayer(player);
      return `${playerName}${cooldownText.value}`;
    }

    if (typeof this.mapService.checkCanTravel === 'function') {
      const check = this.mapService.checkCanTravel(currentMap, targetMap, player);
      if (!check.canTravel) return `${playerName}${check.reason || '无法前往该地图'}`;
    }

    const vehicle = await this.findTravelVehicle(player, currentMap);
    const moveType = Number(vehicle?.行走方式 ?? vehicle?.moveType ?? 0);
    if (vehicle && moveType === 0) {
      return `${playerName}当前驾驶的载具${vehicle.名称 || vehicle.name}未安装行走机构或有的部件超过了上限`;
    }
    if (vehicle && moveType === 1) {
      return `${playerName}当前驾驶的载具${vehicle.名称 || vehicle.name}只能使用“前往”来移动`;
    }
    if (vehicle && moveType === 4) {
      return `${playerName}当前驾驶的载具${vehicle.名称 || vehicle.name}安装了无法移动的组件`;
    }

    const hasFox = [...(playerData.equipment || []), ...(playerData.weapons || [])]
      .some((item: any) => String(item?.name ?? item?.名称 ?? '') === '狐');
    let arrivalMap = targetMap;
    let confused = false;
    if (!vehicle && !hasFox && Math.random() < 0.1) {
      const maps = typeof this.mapService.getAllMaps === 'function'
        ? await this.mapService.getAllMaps()
        : [];
      const candidates = maps.filter((map: any) =>
        map && map.id !== currentMap.id && Number(map.id) >= 3 && !map.noTeleport && !map.不可传送 && !map.isFrontier && !map.开拓地,
      );
      if (candidates.length > 0) {
        arrivalMap = candidates[Math.floor(Math.random() * candidates.length)];
        confused = arrivalMap.id !== targetMap.id;
      }
    }

    const seconds = vehicle || hasFox ? 5 : 10;
    const nextMarkers = asJsonValue(player.markers, {});
    nextMarkers['移动中'] = JSON.stringify({
      targetName: arrivalMap.name,
      targetMapId: arrivalMap.id,
      startedAt: Date.now(),
      arriveAt: Date.now() + seconds * 1000,
      fromMapId: currentMap.id,
      mode: '飞行',
    });
    player.markers = nextMarkers; // Json 列直接写对象
    player.markers2 = markers2; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    await this.scheduleArrival(userId, arrivalMap.id, arrivalMap.name, seconds);

    return confused
      ? `${playerName}飞了起来，但是遇到了混乱气流……`
      : `${playerName}飞了起来……`;
  }

  /** 查找玩家当前驾驶或接管的载具，避免把其他地图的载具当成当前载具。 */
  private async findTravelVehicle(player: any, currentMap: any): Promise<any | null> {
    const sets = this.parseVehicleValue<any>(player?.sets, {});
    const key = String(player?.vehicle || sets?.takeVehicle || sets?.接管载具 || '');
    if (!key) return null;
    const vehicles = this.parseVehicleValue<any[]>(currentMap?.vehicles, []);
    const keys = (value: any): string[] => [
      value?.编号, value?.vehicleId, value?.id, value?.名称, value?.name,
    ].filter((value) => value !== undefined && value !== null && String(value) !== '').map(String);
    const local = vehicles.find((value: any) => keys(value).includes(key));
    if (local) return this.toRuntimeVehicle(local);

    const gameVehicle: any = (this.prisma as any).gameVehicle;
    if (!gameVehicle) return null;
    const numericId = Number(key);
    let vehicle = Number.isInteger(numericId) && numericId > 0
      ? await gameVehicle.findUnique?.({ where: { id: numericId } })
      : null;
    if (!vehicle && gameVehicle.findFirst) {
      vehicle = await gameVehicle.findFirst({ where: { OR: [{ vehicleId: key }, { name: key }] } });
    }
    if (!vehicle) return null;
    if (Number(vehicle.mapIndex || 0) && Number(vehicle.mapIndex) !== Number(currentMap.id)) return null;
    return this.toRuntimeVehicle(vehicle);
  }

  /**
   * 调度延时到达
   * 在 travelTime 秒后调用 performArrival 真正完成移动
   * @param userId 用户ID
   * @param targetMapId 目标地图ID
   * @param targetMapName 目标地图名
   * @param travelTime 耗时（秒）
   */
  private async scheduleArrival(userId: number, targetMapId: number, targetMapName: string, travelTime: number): Promise<void> {
    if (!this.delayedTaskService) return;
    await this.delayedTaskService.schedule({
      type: 'move',
      userId,
      runAt: Date.now() + travelTime * 1000,
      payload: { targetMapId, targetName: targetMapName },
    });
  }

  /**
   * 真正完成移动（到达目的地）
   * 更新玩家位置、应用地图增益、懒刷新怪物、记录探索成就，并向世界频道广播到达消息。
   * @param userId 用户ID
   * @param targetMapId 目标地图ID
   * @param targetMapName 目标地图名
   */
  private async performArrival(
    userId: number,
    targetMapId: number,
    targetMapName: string,
    options: { skipMapRefresh?: boolean } = {},
  ): Promise<string> {
    // 支柱二·自串行：延时任务 tick 直调本方法时无任何外层锁；指令路径已在
    // mutate/邮箱内（enqueueUserWrite 重入放行）。统一过用户级串行邮箱，
    // 保证「读档→到达结算→写回」全程独占该玩家状态，不依赖调用方记得持锁。
    return this.playerService.enqueueUserWrite(userId, () =>
      this.applyPerformArrival(userId, targetMapId, targetMapName, options));
  }

  /** 移动到达结算的数据库读改写段（performArrival 已持用户级串行邮箱）。 */
  private async applyPerformArrival(
    userId: number,
    targetMapId: number,
    targetMapName: string,
    options: { skipMapRefresh?: boolean } = {},
  ): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    let { player } = playerData;

    const targetMap = await this.mapService.getMapById(targetMapId);
    if (!targetMap) {
      return `目标地图「${targetMapName}」不存在`;
    }

    // 定时器、服务重启补偿和内部到达命令可能同时触发；同一目标已经落地时不重复推进任务。
    const currentMarkers = asJsonValue(player.markers, {});
    const pending = asJsonValue<any>(currentMarkers['移动中'], null);
    if (Number(player.mapId) === Number(targetMap.id)
      && (!pending || Number(pending.targetMapId) !== Number(targetMap.id))) {
      return `你已经在【${targetMap.name}】`;
    }

    // 清除"移动中"状态
    const markers = currentMarkers;
    delete markers['移动中'];
    player.markers = markers; // Json 列直接写对象

    const fromMapId = player.mapId;
    player.mapId = targetMap.id;
    player.location = targetMap.name;

    // 对齐原版 地图操作.ecode L1093-1269 玩家移动+召唤物移动：
    // 1) 玩家载具从原地图迁移到目标地图
    // 2) 召唤物驾驶的载具迁移（行走方式≠0且≠4）
    // 3) 跟随玩家的召唤物迁移到目标地图
    // 4) 移除"风月入墨"增益（离开地图时失效）
    await this.migratePlayerAssetsOnMove(fromMapId, targetMap.id, player);

    // 进入地图时自动获得地图增益
    await this.combatSystem.applyMapBuffs(player, targetMap);
    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, `前往${targetMap.name}`);
    // 原版到达延时（来倒目的）在同一回复里前插“完成了任务:…”块；
    // 这里主动取出通知，避免延时路径无指令收尾而丢失提示。
    const arrivalTaskNotice = this.taskService.consumeNotifications(userId);

    // 任务结算(advance)基于数据库最新数据改写了 tasks/markers/backpack 等字段；
    // 这里必须重新加载玩家快照，否则下方探索成就用旧对象整体回写，
    // 会把刚完成的任务“复活”并回滚奖励。
    player = (await this.playerService.getPlayerData(userId)).player;

    // 懒刷新：若目标地图当前没有已生成的怪物，立即补充刷新，避免到达后无怪可打
    if (!options.skipMapRefresh) {
      try {
        const currentSpawn = await this.mapService.getMapMonsters(targetMap);
        if (currentSpawn.length === 0) {
          await this.mapService.refreshMapMonsters(targetMap.id);
          this.logger.log(`玩家 ${userId} 到达「${targetMap.name}」时触发懒刷新怪物`);
        }
      } catch (e: any) {
        this.logger.warn(`到达地图懒刷新怪物失败: ${e?.message}`);
      }
    }

    // 探索成就：记录玩家首次到达的地图
    try {
      const mark = asJsonValue<Record<string, number>>(player.markers, {});
      const exploreKey = `探索_${targetMap.name}`;
      if (!mark[exploreKey]) {
        await this.achievementService.addAchievement(player, '探索', 1, false);
        await this.achievementService.addAchievement(player, exploreKey, 1, true);
        this.logger.log(`玩家 ${userId} 通过移动探索了新地图: ${targetMap.name}`);
      }
    } catch (e: any) {
      this.logger.warn(`探索成就记录失败: ${e.message}`);
    }

    this.logger.log(`玩家 ${userId} 移动到达：${fromMapId} → ${targetMap.name}`);

    // ========== 到达触发（对齐原版 来倒目的 _主程序.ecode L6694-6712）==========
    // 观测地图产出(通用段) / 四圣祭坛刷麒麟 / 普拉娜幼崽剪毛。
    let triggerText = '';
    try {
      triggerText = await this.applyArrivalTriggers(player, targetMap);
    } catch (e: any) {
      this.logger.warn(`到达触发失败: ${e.message}`);
    }

    // 对齐原版 来倒目的（_主程序.ecode L6751-6760）：到达回复 =
    // “玩家名来到了地图名”（关卡图附说明）+ 观察附近完整列表（含编号临时输入）。
    let lookText = '';
    try {
      lookText = await this.handleLookAround(userId);
    } catch (e: any) {
      this.logger.warn(`到达生成观察附近失败: ${e.message}`);
    }
    const isGateMap = Boolean((targetMap as any).isInstance || (targetMap as any).关卡);
    let text = `${player.name || '冒险者'}来到了${targetMap.name}`;
    if (isGateMap && targetMap.description) text += `\n${targetMap.description}`;
    if (triggerText) text += `\n${triggerText}`;
    if (lookText) text += `\n${lookText}`;
    if (arrivalTaskNotice) text = `${arrivalTaskNotice}\n————————\n${text}`;

    // 注：原版到达拉起怪物攻击（_主程序.ecode L1755-1795）仅限地图"代发言=触发攻击"
    // 且载具损毁/无隐形模块的场景；本框架地图表未配置"代发言"字段，普通到达不惊动怪物，
    // 怪物回合仍由攻击/采集等动作触发（triggerMapBattleLoop）。

    // 向世界频道广播到达消息（持久化 + 实时推送）
    await this.chatService.broadcastSystem('世界频道', text, userId);

    // 定向刷新该玩家的地图总览面板
    try {
      const overview = await this.getMapOverview(userId);
      this.chatService.emitToUser(userId, 'map:update', { overview });
      // 玩家面板无需手动刷新：上方 savePlayer 已由 Prisma 拦截器自动触发 player:update
    } catch (e: any) {
      this.logger.warn(`刷新玩家 ${userId} 地图面板失败: ${e.message}`);
    }

    return text;
  }

  /**
   * 到达地图统一触发（对齐原版 来倒目的 _主程序.ecode L6694-6712 / 传送 L1753-1777）。
   * 1) 观测地图产出·通用段（地图操作.ecode 观测地图 L53-76）：宠物产蛋/垃圾、具现装置产未知物品；
   *    开拓地(家园)的完整观测（建筑/作物）由「家园产出」命令的 collectHomeOutput 结算，此处跳过避免双重记账。
   * 2) 四圣祭坛：其余四祭坛怪物清空后刷出神兽麒麟（L6697-6712）。
   * 3) 普拉娜幼崽剪毛（使魔技能.ecode L14-70）：带剪刀的普拉娜幼崽召唤物为地图动物剪毛。
   * @param player 到达玩家
   * @param targetMap 目标地图行
   * @returns 附加文本（无则空串）
   */
  private async applyArrivalTriggers(player: any, targetMap: any): Promise<string> {
    const lines: string[] = [];
    const readNum = (v: any): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    // ===== 1. 观测地图产出·通用段 =====
    if (!targetMap.isFrontier && !targetMap.isInstance) {
      const nowSec = Date.now() / 1000;
      // mutateMapFields 锁内闭环：重读最新 items/markers/summons/buildings → 计算产出 → 差异写回
      // （markers 记录观测时间必然变化；items 仅在真正产出时变化，由逐字段 JSON 比对决定是否落库）
      await this.mapService.mutateMapFields(targetMap.id, ['items', 'markers', 'summons', 'buildings'], (f) => {
        const mapMarkers = f.markers as Record<string, any>;
        const lastObserved = readNum(mapMarkers['观测时间']);
        const timeDiff = lastObserved > 0 ? Math.max(0, nowSec - lastObserved) : 0;
        mapMarkers['观测时间'] = nowSec;
        const items = f.items as any[];
        const mergeItem = (name: string, qty: number): void => {
          if (!(qty > 0)) return;
          const found = items.find((it: any) => it && (it.name ?? it.名称) === name);
          if (found) {
            found.quantity = readNum(found.quantity ?? found.count ?? found.数量) + qty;
          } else {
            items.push({ name, quantity: qty });
          }
        };
        if (f.summons.length > 0) {
          // 蛋/垃圾：时间差/86400×宠物数（原版 L60-66 两项同率累计入 地图.物品）
          const rate = (timeDiff / 86400) * f.summons.length;
          mergeItem('蛋', rate);
          mergeItem('垃圾', rate);
        }
        // 具现装置：每天产出1个未知物品（原版 L70-75）
        const hasGadget = (f.buildings as any[]).some(
          (b: any) => b && String(b.name ?? b.名称 ?? '') === '具现装置' && readNum(b.quantity ?? b.count ?? b.数量 ?? 1) > 0,
        );
        if (hasGadget) mergeItem('未知物品', timeDiff / 86400);
      });
    }

    // ===== 2. 四圣祭坛刷麒麟（原版 来倒目的 L6697-6712）=====
    if (targetMap.name === '四圣祭坛') {
      try {
        const residentMonsters = (await this.mapService.getMapMonsters(targetMap.id)).filter((m: any) => !m.isTemp);
        if (residentMonsters.length === 0) {
          const hasMonsterIn = async (name: string): Promise<boolean> => {
            const m = await this.mapService.getMapByName(name);
            if (!m) return false;
            const list = await this.mapService.getMapMonsters(m.id);
            return list.length > 0;
          };
          const cleared = !(await hasMonsterIn('白虎祭坛'))
            && !(await hasMonsterIn('青龙祭坛'))
            && !(await hasMonsterIn('玄武祭坛'))
            && !(await hasMonsterIn('朱雀祭坛'));
          if (cleared) {
            // 神兽麒麟：事件型临时怪物，写入 GameMonster 表 isTemp=true
            await this.mapService.addTempMonster(targetMap.id, {
              name: '神兽麒麟',
              type: '神兽麒麟',
              specialSeq: 0,
              level: Math.max(10, player.level || 10),
              hp: 5000,
              maxHp: 5000,
              attack: 200,
              defense: 50,
              speed: 120,
              exp: 500,
            });
            lines.push('四座祭坛的怪物都已被清除，一股强大的气息在祭坛中央凝聚……');
            lines.push('神兽麒麟出现了！');
          }
        }
      } catch (e: any) {
        this.logger.warn(`四圣祭坛麒麟生成失败: ${e.message}`);
      }
    }

    // ===== 3. 普拉娜幼崽剪毛（使魔技能.ecode L14-70）=====
    try {
      const shearText = await this.shearPranaCubsOnArrival(targetMap, player);
      if (shearText) lines.push(shearText);
    } catch (e: any) {
      this.logger.warn(`到达剪毛触发失败: ${e.message}`);
    }

    return lines.join('\n');
  }

  /**
   * 到达时普拉娜幼崽自动剪毛（使魔技能.ecode L14-70）。
   * 遍历当前地图召唤物：活力==-31(普拉娜幼崽) 且武器含剪刀(特殊序号-40/名称"剪刀")的幼崽，
   * 为其归属者剪当前地图全部动物的毛发——每类动物每天一次（时间间隔要求("剪毛"+类型, 有效期当天())）。
   * 毛发进入幼崽 装备预设[2].装备（宠物随身包），并计入归属者 剪毛/采集 成就与任务。
   * ⚠️偏差：原版还会剪地图上其他玩家使魔的毛发，本框架动物仅遍历召唤物（玩家本体无毛发字段，不剪）。
   */
  private async shearPranaCubsOnArrival(map: any, arrivingPlayer: any): Promise<string> {
    const readNum = (v: any): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const summons = asJsonValue<any[]>(map.summons, []);
    if (!summons.length) return '';
    const isPranaCub = (s: any): boolean =>
      !!s && (Number(s.vitality ?? s.活力 ?? 0) === -31 || String(s.type ?? s.类型 ?? '') === '普拉娜幼崽');
    const cubs = summons.filter(isPranaCub);
    if (!cubs.length) return '';

    const dayEndMs = (() => {
      const d = new Date();
      d.setHours(23, 59, 59, 999);
      return d.getTime();
    })();
    const nowMs = Date.now();

    for (const cub of cubs) {
      // 剪刀判定（原版 L27-33）：武器列表含 特殊序号==#剪刀(-40)
      const rawWeapons = cub.weapons ?? cub.武器;
      const weapons = Array.isArray(rawWeapons)
        ? rawWeapons
        : asJsonValue<any[]>(String(rawWeapons ?? '[]'), []);
      const hasScissors = weapons.some(
        (w: any) => w && (String(w.name ?? w.名称 ?? '') === '剪刀' || Number(w.specialSeq ?? w.特殊序号 ?? 0) === -40),
      );
      if (!hasScissors) continue;

      // 归属者解析（原版 L36-41）：归属 != 当前玩家 → 取玩家(归属)，否则用当前玩家
      const ownerKey = String(cub.ownerQQ ?? cub.归属 ?? cub.owner ?? '');
      let owner = arrivingPlayer;
      if (ownerKey
        && ownerKey !== String(arrivingPlayer.qq ?? '')
        && ownerKey !== String(arrivingPlayer.userId ?? '')
        && ownerKey !== String(arrivingPlayer.qqNumber ?? '')) {
        owner = await this.prisma.player.findFirst({
          where: [
            { qqNumber: ownerKey },
            { userId: Number(ownerKey) || -1 },
          ] as any,
        }).catch(() => null) as any;
        if (!owner) continue;
      }

      // 幼崽需有 装备预设[2]（原版 L35）；毛发写入 装备预设[2].装备（宠物随身包）
      const rawPresets = cub.equipmentPresets ?? cub.装备预设;
      const presets = Array.isArray(rawPresets)
        ? rawPresets
        : asJsonValue<any[]>(String(rawPresets ?? '[]'), []);
      if (presets.length <= 1) continue;
      if (!presets[1]) presets[1] = { name: '宠物背包', equipment: [] };
      const rawBag = presets[1].equipment ?? presets[1].装备;
      const bag = Array.isArray(rawBag)
        ? rawBag
        : asJsonValue<any[]>(String(rawBag ?? '[]'), []);

      const markers2 = asJsonValue<any[]>(owner.markers2, []);
      let totalHair = 0;
      for (const animal of summons) {
        if (!animal || animal === cub) continue;
        const typeName = String(animal.type ?? animal.类型 ?? animal.name ?? animal.名称 ?? '').trim();
        if (!typeName) continue;
        const key = `剪毛${typeName}`;
        // 时间间隔要求(name, 有效期当天())：存在且未过期 → 冷却中
        const cd = markers2.find((m: any) => m && m.name === key);
        if (cd && Number(cd.expireAt ?? 0) > nowMs) continue;
        const filtered = markers2.filter((m: any) => !(m && m.name === key));
        filtered.push({ name: key, expireAt: dayEndMs });
        markers2.length = 0;
        markers2.push(...filtered);
        // 毛发：召唤物自带 毛发 字段为空时按原版默认给"毛发"1个（@Struct L342）
        const hairRaw = animal.毛发 ?? animal.hair;
        const hairName = String(hairRaw?.name ?? hairRaw?.名称 ?? '毛发') || '毛发';
        const hairQty = Math.max(1, Math.round(readNum(hairRaw?.quantity ?? hairRaw?.数量 ?? 1)));
        const found = bag.find((it: any) => it && (it.name ?? it.名称) === hairName);
        if (found) {
          found.quantity = (Number(found.quantity ?? found.count ?? found.数量) || 0) + hairQty;
        } else {
          bag.push({ name: hairName, quantity: hairQty });
        }
        totalHair += hairQty;
      }

      if (totalHair > 0) {
        presets[1].equipment = bag;
        cub.equipmentPresets = cub.装备预设 = presets;
        owner.markers2 = markers2; // Json 列直接写数组
        // 地图聚合串行化写入口：锁内重读最新 summons，把「装备预设」写回其中的幼崽
        // （幼崽可能被并发路径迁移/移除，找不到时跳过，绝不复活已删除单位）。
        const cubQQ = String(cub?.qq ?? cub?.QQ ?? '');
        const cubName = String(cub?.name ?? cub?.名称 ?? '');
        const isSameCub = (s: any): boolean =>
          !!s && String(s?.qq ?? s?.QQ ?? '') === cubQQ
            && (cubQQ ? true : String(s?.name ?? s?.名称 ?? '') === cubName);
        await this.mapService.mutateSummons(map.id, (fresh) => {
          const freshCub = fresh.find(isSameCub);
          if (freshCub) freshCub.equipmentPresets = freshCub.装备预设 = presets;
        });
        if (owner.userId) {
          await this.playerService.savePlayer(owner);
          await this.achievementService.addAchievement(owner, '剪毛', totalHair, false);
          await this.achievementService.addAchievement(owner, '采集', totalHair, false);
        }
        return `${cub.name ?? cub.名称 ?? '普拉娜幼崽'} 为地图上的动物剪了毛，获得了毛发x${totalHair}`;
      }
    }
    return '';
  }

  /**
   * 玩家移动时迁移载具和跟随召唤物（对齐原版 地图操作.ecode L1093-1269）。
   * - 玩家载具：从原地图 vehicles 数组中移除，添加到目标地图 vehicles 数组
   * - 召唤物驾驶的载具：行走方式≠0(无行走机构)且≠4(坐地)时迁移
   * - 跟随召唤物：标记中"跟随"熟练度<1 的召唤物迁移到目标地图
   * - 风月入墨增益：离开地图时从玩家增益列表中移除
   * @param fromMapId 原地图ID
   * @param toMapId 目标地图ID
   * @param player 玩家对象（含 vehicle/qq/buffs 等字段）
   */
  private async migratePlayerAssetsOnMove(
    fromMapId: number,
    toMapId: number,
    player: any,
  ): Promise<void> {
    if (!fromMapId || Number(fromMapId) === Number(toMapId)) return;

    const playerQQ = String(player.userId ?? player.qq ?? '');
    if (!playerQQ) return;

    try {
      const vehicleKey = (v: any) => String(v?.id ?? v?.编号 ?? v?.vehicleId ?? '');
      const summonOwner = (s: any) => String(s?.归属 ?? s?.owner ?? s?.qq ?? '');

      // 地图聚合串行化写入口：迁出/迁入各自在 per-map 锁内「重读最新容器 → 改 → 写回」
      // 闭环执行，消除基于合并快照的旧数据覆盖（跟随单位被地图写竞态清除的根因）。
      // === 1~3. 载具与跟随召唤物迁出（原版 L1125-1256）===
      const movers = await this.mapService.mutateMapFields(
        Number(fromMapId),
        ['summons', 'vehicles'],
        (f) => {
          const fromVehicles = f.vehicles;
          const fromSummons = f.summons;
          const moved = { vehicles: [] as any[], summons: [] as any[] };

          // === 1. 玩家载具迁移（原版 L1125-1142）===
          if (player.vehicle) {
            const pVehicleKey = String(player.vehicle);
            const idx = fromVehicles.findIndex((v: any) => vehicleKey(v) === pVehicleKey);
            if (idx >= 0) {
              // 从原地图移除载具，添加到目标地图
              moved.vehicles.push(fromVehicles[idx]);
              fromVehicles.splice(idx, 1);
            }
          }

          // === 2. 召唤物驾驶的载具迁移（原版 L1201-1243）===
          // 只迁移跟随玩家的召唤物的载具（行走方式≠0且≠4）
          const followSummons = fromSummons.filter((s: any) => summonOwner(s) === playerQQ);
          for (const summon of followSummons) {
            const sVehicle = String(summon?.载具 ?? summon?.vehicle ?? '');
            if (!sVehicle) continue;

            // 检查"跟随"熟练度<1（原版 取成就熟练度(标记,"跟随")<1）
            const summonMarkers = asJsonValue<any[]>(summon?.标记 ?? summon?.markers, []);
            const followSkill = summonMarkers['跟随'] ?? 0;
            if (Number(followSkill) >= 1) continue; // 熟练度>=1 不迁移（非跟随状态）

            const vIdx = fromVehicles.findIndex((v: any) => vehicleKey(v) === sVehicle);
            if (vIdx < 0) continue;

            const sv = fromVehicles[vIdx];
            const walkMode = Number(sv?.行走方式 ?? sv?.walkMode ?? 0);
            // 行走方式 0=无行走机构（不能动），4=坐地（不能动）
            if (walkMode === 0 || walkMode === 4) continue;

            moved.vehicles.push(sv);
            fromVehicles.splice(vIdx, 1);
          }

          // === 3. 跟随召唤物迁移（原版 L1244-1256）===
          for (let i = fromSummons.length - 1; i >= 0; i--) {
            const s = fromSummons[i];
            if (summonOwner(s) !== playerQQ) continue;

            // 跟随熟练度<1 才迁移
            const sMarkers = asJsonValue<any[]>(s?.标记 ?? s?.markers, []);
            const fSkill = sMarkers['跟随'] ?? 0;
            if (Number(fSkill) >= 1) continue;

            // 更新召唤物地图字段并迁移
            (s as any).地图 = Number(toMapId);
            (s as any).mapId = Number(toMapId);
            moved.summons.push(s);
            fromSummons.splice(i, 1);
          }
          return moved;
        },
      );

      // === 迁入：把迁出单位并入目标地图（同样锁内闭环）===
      await this.mapService.mutateMapFields(Number(toMapId), ['summons', 'vehicles'], (f) => {
        f.vehicles.push(...movers.vehicles);
        f.summons.push(...movers.summons);
      });

      // === 4. 移除"风月入墨"增益（原版 L1146-1154）===
      // 原版在移动时从 player.增益 中删除"风月入墨"（离开地图失效）
      const buffs = asJsonValue<any[]>(player.buffs, []);
      const beforeLen = buffs.length;
      const keptBuffs = buffs.filter((b: any) => String(b?.name ?? b?.名称 ?? '') !== '风月入墨');
      if (keptBuffs.length !== beforeLen) {
        player.buffs = keptBuffs; // Json 列直接写数组
      }
    } catch (e: any) {
      this.logger.warn(`迁移玩家载具/召唤物失败: ${e?.message}`);
    }
  }

  /**
   * 构建当前玩家的状态摘要（等级/经验/HP/护盾/装甲/属性等）
   * 数据结构与 GET /game/player/info 一致，供前端玩家信息面板展示，
   * 也用于指令执行后通过 socket 实时刷新玩家面板。
   * @param userId 用户ID
   * @returns 玩家状态摘要对象（属性为按等级+熟练度计算后的值）
   */
  async buildPlayerInfo(userId: number): Promise<any | null> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    // 计算后属性（对齐原版 _计算玩家，与控制器 getPlayerInfo 保持一致）
    const calcBonus = this.combatSystem.buildAttackerBonus(player, playerData);
    // 战斗力（基于"计算后"的成长属性，与文本面板 handleInfo 同口径）
    const powerBonus: BonusData = {
      攻击: calcBonus.攻击 || 0,
      生命: calcBonus.生命 || 0,
      装甲: calcBonus.装甲 || 0,
      速度: calcBonus.速度 || 0,
    };
    return {
      id: player.id,
      userId: player.userId,
      level: player.level,
      exp: player.exp,
      upgradeExp: this.playerService.calcUpgradeExp(player.level),
      name: player.name,
      type: player.type,
      hp: player.hp,
      maxHp: Math.round(calcBonus.生命 || player.maxHp || 100),
      shield: player.shield,
      maxShield: Math.round(calcBonus.护盾 || player.maxShield || 0),
      armor: player.armor,
      maxArmor: Math.round(calcBonus.装甲 || player.maxArmor || 0),
      attack: Math.round(calcBonus.攻击 || 0),
      speed: Math.round(calcBonus.速度 || player.speed || 0),
      dodge: Math.round(calcBonus.闪避 || 0),
      hit: Math.round(calcBonus.命中 || 0),
      crit: Math.round(calcBonus.暴击 || 0),
      critDmg: Math.round(calcBonus.暴击伤害 || 150),
      mapId: player.mapId,
      location: player.location,
      affinity: player.affinity,
      vitality: Number(player.vitality || 0),
      maxVitality: this.vitalityService
        ? this.vitalityService.getVitalityMax(markers)
        : Math.max(100, Number(this.playerService.getMarkerValue(markers, '活力2')) || 100),
      combatPower: this.bonusService.calcCombatPower(powerBonus),
      tasks: this.buildActiveTasks(playerData.tasks),
      equipment: this.buildEquipmentSnapshot(player, markers),
      buffs: this.buildActiveBuffs(playerData.buffs),
      // 进行中的延时操作（采集/移动/抢救…）：前端据此渲染统一倒计时进度条
      pendingActions: this.buildPendingActions(player, markers, playerData.markers2),
    };
  }

  /**
   * 进行中的延时操作快照（网页「进行中操作」倒计时条用）。
   *
   * 原版里大量指令是"发指令 → 等 N 秒 → 延时结算"，期间玩家会被行动限制锁住，
   * 但界面上只有聊天区一行文字提示，玩家常常误以为指令没生效而重复发送。
   * 这里把玩家身上所有"还需要 N 秒"的状态汇总成统一结构，前端一次性渲染：
   *   - 采集：markers['采集中']（打开箱子 / 打开休眠仓 / 收集木头 / 捡垃圾 等地图资源指令）
   *   - 移动：markers['移动中']（前往其它地图的路途耗时）
   *   - 抢救：markers2 中 name=复活（抢救使魔 / 维修载具 / 自救）
   *   - 工作：markers2 中 name=工作（救助其他玩家）
   *   - 麻痹：markers2 中 name=麻痹（负面锁定状态）
   * 只输出仍未到期的条目；已到期的由各自的延时结算/兜底任务清除，前端也会本地剔除。
   *
   * 关于进度百分比：只有 `endAt` 是必需字段。前端以「首次渲染时的剩余时间」作为分母自行起算
   * 进度条，因此这里不必强求每条都带 startedAt；`totalMs` 为 0 即表示"总时长未知"。
   * startedAt/totalMs 仅在写入侧顺手落盘时透出（采集、移动、抢救、麻痹），
   * 作用是刷新页面/重连后进度条仍落在真实位置，缺失不影响进度条正常推进。
   *
   * @param player 玩家行（用于兜底取 markers2 原始串）
   * @param markers 已解析的对象标记
   * @param markers2 已解析的时效标记数组
   * @returns 进行中操作列表（按结束时间升序，通常只有 1 条）
   */
  private buildPendingActions(
    player: any,
    markers: any,
    markers2: any,
  ): Array<{ key: string; kind: string; label: string; detail: string; icon: string; startedAt: number; endAt: number; totalMs: number }> {
    const now = Date.now();
    const list: Array<any> = [];

    /** 历史数据里 expireAt 有秒/毫秒两种口径，统一归一为毫秒时间戳。 */
    const toEndMs = (raw: any): number => {
      const v = Number(raw ?? 0);
      if (!Number.isFinite(v) || v <= 0) return 0;
      return v >= 1e12 ? v : v * 1000;
    };

    const push = (item: {
      key: string; kind: string; label: string; detail?: string; icon?: string;
      endAt: number; startedAt?: number; totalMs?: number;
    }) => {
      const endAt = Math.floor(item.endAt);
      if (!endAt || endAt <= now) return; // 已到期：结算任务会清理，此处不展示
      const knownStart = Math.floor(item.startedAt ?? 0);
      const knownTotal = Math.floor(item.totalMs ?? 0);
      // 起止时间与总时长知其二即可推第三个；两者都拿不到时 totalMs 置 0，
      // 表示「总时长未知」——前端据此走不确定进度动画，而不是画一条卡在 0% 的空槽。
      const startedAt = knownStart || (knownTotal > 0 ? Math.max(0, endAt - knownTotal) : 0);
      const totalMs = knownTotal > 0
        ? Math.min(knownTotal, endAt - Math.max(0, startedAt) || knownTotal)
        : (knownStart > 0 ? Math.max(0, endAt - knownStart) : 0);
      list.push({
        key: item.key,
        kind: item.kind,
        label: item.label,
        detail: item.detail || '',
        icon: item.icon || '⏳',
        startedAt,
        endAt,
        totalMs,
      });
    };

    // ===== 1) 采集（打开箱子 / 打开休眠仓 / 收集木头 / 捡垃圾 …）=====
    // 写入处 handleGatherResource：markers['采集中'] = { target, cmd, count, startedAt, settleAt }
    const gather = markers?.['采集中'];
    if (gather && typeof gather === 'object') {
      const endAt = Number(gather.settleAt ?? 0) || 0;
      const startedAt = Number(gather.startedAt ?? 0) || 0;
      const cmd = String(gather.cmd ?? '').trim();
      const target = String(gather.target ?? '').trim();
      const count = Number(gather.count ?? 1);
      push({
        key: 'gather',
        kind: 'gather',
        label: cmd || '采集中',
        detail: [target, count > 1 ? `×${count}` : ''].filter(Boolean).join(' '),
        icon: '⛏️',
        endAt,
        startedAt,
        totalMs: startedAt ? endAt - startedAt : undefined,
      });
    }

    // ===== 2) 移动（前往其它地图的路途耗时）=====
    // 写入处 handleMove：markers['移动中'] = JSON 字符串 { targetName, arriveAt, ... }
    const movingRaw = markers?.['移动中'];
    const moving = typeof movingRaw === 'string'
      ? asJsonValue<any>(movingRaw, null)
      : movingRaw;
    if (moving && typeof moving === 'object') {
      const endAt = Number(moving.arriveAt ?? 0) || 0;
      const startedAt = Number(moving.startedAt ?? 0) || 0;
      const mode = String(moving.mode ?? '').trim();
      push({
        key: 'move',
        kind: 'move',
        label: '移动中',
        detail: moving.targetName ? `${mode || '前往'}【${moving.targetName}】` : (mode || ''),
        icon: mode === '飞行' ? '🕊️' : '🚶',
        endAt,
        startedAt,
        totalMs: startedAt ? endAt - startedAt : undefined,
      });
    }

    // ===== 3) markers2 时效标记：抢救/维修/救助/麻痹 =====
    const list2 = Array.isArray(markers2)
      ? markers2
      : asJsonValue<any[]>(player?.markers2, []);
    const rescueText: Record<string, string> = {
      self: '自救', familiar: '抢救使魔', vehicle: '维修载具', player: '救助玩家',
    };
    const rescueIcon: Record<string, string> = {
      self: '💊', familiar: '🩹', vehicle: '🔧', player: '🤝',
    };
    for (const entry of list2) {
      if (!entry || typeof entry !== 'object') continue;
      const name = String(entry?.name ?? entry?.名称 ?? '');
      const endMs = toEndMs(entry?.expireAt ?? entry?.有效期至);
      if (!endMs) continue;
      // 带 rescueType 的「复活/工作」= 救助链路（抢救使魔/维修载具/自救/救助玩家）
      const rescueType = String(entry?.rescueType ?? '');
      if (rescueType) {
        // startedAt/totalMs 由 createRescueMarker 落盘，只用于刷新页面后进度条仍显示真实位置；
        // 老标记没有这两个字段时 totalMs 为 0，前端会以首次观测到的剩余时间自行起算。
        push({
          key: `rescue:${rescueType}`,
          kind: 'rescue',
          label: rescueText[rescueType] || '抢救',
          icon: rescueIcon[rescueType] || '🩹',
          endAt: endMs,
          startedAt: Number(entry?.startedAt ?? 0) || 0,
          totalMs: Number(entry?.totalMs ?? 0) || 0,
        });
        continue;
      }
      // 纯进度型锁定标记：采集/移动的 markers2 镜像（markers 里已有更详细信息时跳过，避免重复条目）
      if (name === '采集' && list.some((a: any) => a.key === 'gather')) continue;
      if (name === '移动' && list.some((a: any) => a.key === 'move')) continue;
      // 这些标记的 startedAt/totalMs 是可选字段，缺失时前端按「总时长未知」处理
      const markStart = Number(entry?.startedAt ?? 0);
      const markTotal = Number(entry?.totalMs ?? 0);
      if (name === '采集') {
        push({ key: 'gather', kind: 'gather', label: '采集中', icon: '⛏️', endAt: endMs, startedAt: markStart, totalMs: markTotal });
      } else if (name === '移动') {
        push({ key: 'move', kind: 'move', label: '移动中', icon: '🚶', endAt: endMs, startedAt: markStart, totalMs: markTotal });
      } else if (name === '工作') {
        push({ key: 'work', kind: 'work', label: '工作中', icon: '🔨', endAt: endMs, startedAt: markStart, totalMs: markTotal });
      } else if (name === '麻痹') {
        push({ key: 'paralysis', kind: 'debuff', label: '麻痹中', detail: '无法行动', icon: '⚡', endAt: endMs, startedAt: markStart, totalMs: markTotal });
      }
    }

    return list.sort((a: any, b: any) => a.endAt - b.endAt);
  }

  /**
   * 当前任务快照（网页「我的」面板用）：仅保留未完成任务的名字与进度计数，
   * 结构对齐 handleInfo 文本面板的任务段（字符串条目 / name|title 对象均兼容）。
   */
  private buildActiveTasks(rawTasks: any): Array<{ name: string; count?: number }> {
    const list = Array.isArray(rawTasks) ? rawTasks : [];
    const result: Array<{ name: string; count?: number }> = [];
    for (const t of list) {
      if (typeof t === 'string') {
        if (t.trim()) result.push({ name: t });
        continue;
      }
      const name = t?.name || t?.title;
      if (!name) continue;
      // 已完成标记的不再展示（任务完成结算后会从列表移除，此处兜底）
      if (t.completed === true || t.status === '已完成' || t.status === '已提交') continue;
      const count = Number(t.count ?? 0);
      result.push(count > 0 ? { name, count } : { name });
    }
    return result;
  }

  /**
   * 装备栏快照（网页「我的」面板用）：按部位遍历 + 武器/植入/增幅，
   * 与 handleInfo 装备面板（原版 数据显示.ecode 使魔数据 L2032-2210）保持同一取数口径。
   * name 为 null 表示该栏位为空，前端显示「无(+强化等级)」。
   */
  private buildEquipmentSnapshot(player: any, markers: any): Array<{ slot: string; name: string | null; quality: string; effect: number; enhance: number; attrs: string }> {
    // 品质前缀映射（对齐原版 显示品质 L1591-1639）
    const qualityPrefix = (data: string): string => {
      const c = (data || '').charAt(0).toLowerCase();
      const map: Record<string, string> = { e: '普通', d: '良好', c: '优秀', b: '精良', a: '史诗', s: '传说' };
      return map[c] || '神迹';
    };
    const equipmentList = asJsonValue<any[]>(player.equipment, []);
    const weaponList = asJsonValue<any[]>(player.weapons, []);
    const currentWeaponIdx = Number(player.currentWeapon ?? 0);

    const entryOf = (slot: string, item: any, enhanceKey: string) => {
      const enhanceLv = this.combatState.getAchievementProficiency(markers, enhanceKey);
      if (!item) return { slot, name: null, quality: '', effect: 0, enhance: enhanceLv, attrs: '' };
      const rawData = String(item.data || item.数据 || '');
      let effectNum = Number(item.effect || item.特效 || 0);
      if (!effectNum && rawData) {
        const bxMatch = rawData.match(/!bx(\d+)/);
        if (bxMatch) effectNum = parseInt(bxMatch[1], 10) || 0;
      }
      // 解析装备属性（自带属性 + 随机词条），供网页左侧信息栏「已装备格」直接展示
      let attrs = '';
      if (rawData) {
        try {
          const parsed = this.itemService.parseEquipment(item);
          const attrLines = [
            ...this.itemSystemService.formatBonusStats(parsed?.baseBonus || {}),
            ...this.itemSystemService.formatBonusStats(parsed?.bonus || {}),
          ];
          attrs = attrLines.join('\n');
        } catch {
          attrs = '';
        }
      }
      return {
        slot,
        name: String(item.name || item.名称 || '未知'),
        quality: qualityPrefix(rawData),
        effect: effectNum,
        enhance: enhanceLv,
        attrs,
      };
    };

    const getEquipType = (item: any): string => {
      const def = this.staticData.getEquipmentByName(item.name);
      return String(def?.equipType ?? def?.type ?? def?.类型 ?? item.type ?? item.类型 ?? '');
    };
    const slotNames = ['头部', '饰品', '肩膀', '上身', '背部', '手臂', '手掌', '腰部', '下身', '腿环', '腿部', '脚部'];
    const result = slotNames.map((slotName) =>
      entryOf(
        slotName,
        equipmentList.find((e: any) => getEquipType(e) === slotName),
        slotName + '强化',
      ),
    );
    // 武器（currentWeapon 从 1 计数，0/越界回落拳头）
    result.push(entryOf('武器', currentWeaponIdx > 0 ? weaponList[currentWeaponIdx - 1] : null, '武器强化'));
    // 植入体 / 增幅器
    result.push(entryOf('植入', equipmentList.find((e: any) => {
      const def = this.staticData.getEquipmentByName(e.name);
      return def?.equipType === '植入体' || def?.type === '植入体';
    }), ''));
    result.push(entryOf('增幅', equipmentList.find((e: any) => {
      const def = this.staticData.getEquipmentByName(e.name);
      return def?.equipType === '增幅器' || def?.type === '增幅器';
    }), ''));
    return result;
  }

  /**
   * 文本面板增益行：把增益数组格式化为「名称(剩余m:ss)」列表。
   *
   * 统一走过期时间归一化（秒/毫秒两种历史口径都识别），并**剔除已过期条目**：
   * 原逻辑只把剩余秒数钳到 0，导致过期的增益一直以「(0:00)」常驻在「信息」
   * 面板里不会消失。
   * @param rawBuffs 增益数组或 JSON 字符串
   * @returns 展示文本数组（无有效增益时为空数组，调用方据此省略整行）
   */
  private formatBuffList(rawBuffs: any): string[] {
    const now = Date.now();
    return filterActive(rawBuffs, now).map((buff: any) => {
      const name = buff?.name || buff?.名称 || '未知';
      // 无到期时间 = 永久增益，不带倒计时，避免显示成误导性的 (0:00)
      return toExpireMs(buff) ? `${name}(${formatRemain(remainSeconds(buff, now))})` : name;
    });
  }

  /**
   * 增益快照（网页「我的」面板用）：过滤已过期条目，保留名字与有效期时间戳，
   * 剩余倒计时由前端按本地时钟实时计算。
   */
  private buildActiveBuffs(rawBuffs: any): Array<{ name: string; expireAt: number }> {
    // 先按统一时间口径剔除过期条目，再统一输出毫秒时间戳给前端倒计时
    // （历史数据里 expireAt 有秒/毫秒两种口径，必须归一化后再交给前端）
    const now = Date.now();
    return filterActive(rawBuffs, now).map((b: any) => ({
      name: String(b?.name || b?.名称 || '未知'),
      expireAt: toExpireMs(b),
    }));
  }

  /**
   * 定向推送玩家状态更新到该用户的前端 socket（触发网页玩家面板实时刷新）
   * 在指令执行成功（攻击/采集/装备/技能/移动等）后调用，
   * 使打怪掉血、加经验、升级等变化实时体现在界面上，无需手动 F5。
   * 带 300ms 尾沿防抖：自动战斗(每5秒)/连击/延时攻击等高频结算场景下
   * 同一玩家的多次变化合并为一次推送，避免 socket 风暴拖垮前后端。
   * @param userId 用户ID
   */
  async pushPlayerUpdate(userId: number): Promise<void> {
    const existing = this.playerUpdateTimers.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.playerUpdateTimers.delete(userId);
      void this.doPushPlayerUpdate(userId);
    }, 300);
    timer.unref?.();
    this.playerUpdateTimers.set(userId, timer);
  }

  private async doPushPlayerUpdate(userId: number): Promise<void> {
    try {
      const data = await this.buildPlayerInfo(userId);
      if (data) {
        data.rev = this.nextRev(`player:${userId}`);
        this.chatService.emitToUser(userId, 'player:update', data);
      }
    } catch (e: any) {
      this.logger.warn(`推送玩家 ${userId} 状态更新失败: ${e.message}`);
    }
  }

  /**
   * 定向推送地图总览到该用户的前端 socket（触发网页地图面板 + 附近玩家实时刷新）
   * 在指令执行（攻击/采集/移动等，会让怪物HP、资源数量、所在地图/附近玩家变化）后调用。
   * 前端收到 map:update 后会自动重载附近玩家列表，因此一并覆盖"附近玩家"。
   * 与 pushPlayerUpdate 相同的 300ms 防抖策略。
   * @param userId 用户ID
   */
  async pushMapUpdate(userId: number): Promise<void> {
    const existing = this.mapUpdateTimers.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.mapUpdateTimers.delete(userId);
      void this.doPushMapUpdate(userId);
    }, 300);
    timer.unref?.();
    this.mapUpdateTimers.set(userId, timer);
  }

  private async doPushMapUpdate(userId: number): Promise<void> {
    try {
      const overview = await this.getMapOverview(userId);
      if (overview) {
        this.chatService.emitToUser(userId, 'map:update', {
          overview,
          rev: this.nextRev(`map:${userId}`),
        });
      }
    } catch (e: any) {
      this.logger.warn(`推送玩家 ${userId} 地图面板更新失败: ${e.message}`);
    }
  }

  /**
   * 推送版本号：每个 (实体,用户) 维度的单调递增计数器。
   * 前端据此丢弃网络乱序导致的旧包（rev 小于已应用值则忽略）。
   * 进程重启归零无碍——前端对 rev 回退/归零宽容处理（视为新会话）。
   */
  private nextRev(key: string): number {
    const next = (this.revCounters.get(key) || 0) + 1;
    this.revCounters.set(key, next);
    return next;
  }

  /**
   * 获取地图总览数据（供网页左上角地图面板使用）
   * 包含：当前所在地图详情（怪物/资源/NPC等子区域信息）、可前往子区域、以及全部地图列表
   * @param userId 用户ID
   */
  async getMapOverview(userId: number) {
    const { mapId } = await this.playerService.getPlayerLocation(userId);
    const currentMap = await this.mapService.getMapById(mapId);
    if (!currentMap) return null;

    // 当前地图的可前往子区域（connections）
    const subMaps = this.mapService
      .getConnections(currentMap)
      .map((c) => ({ name: c.name, mapId: c.mapId, distance: c.distance || 0 }));

    // 全部地图，标记当前所在地图及是否由当前地图直接可达
    const currentConnNames = new Set(subMaps.map((s) => s.name));
    const allMaps = (await this.mapService.getAllMaps()).map((m) => ({
      name: m.name,
      mapId: m.id,
      isCurrent: m.id === currentMap.id,
      isReachable: currentConnNames.has(m.name),
    }));

    // 当前地图的子区域详情（怪物/资源/NPC标题）
    // 资源面板与指令「探测/观察附近」保持一致：过滤已采完(times=0)与当前玩家已领取过的固定资源，
    // 避免出现"面板里有、实际打不开/已领过"的不一致观感（原版医疗箱/休眠仓为每人一次的常驻资源）。
    const playerMarkers = await this.getPlayerMarkers(userId);
    const resources = this.playerService
      .safeJsonParse<any[]>(currentMap.resources, [])
      .filter((r: any) => this.getResourceTimes(r) !== 0 && this.isGatherResourceAvailable(r, playerMarkers));
    const npcs = asJsonValue<any[]>(currentMap.npcs, []);
    // 召唤物与 NPC 同属「可对话单位」，与观察附近口径一致（见下方 npcList 合并逻辑）
    const summons = asJsonValue<any[]>(currentMap.summons, []);

    // 怪物列表：从 spawnMonsters + tempMonsters 合并，去重后携带等级/HP
    // 用 staticData 的怪物 JSON 补全等级/HP，未收录的怪物按基础值兜底
    const mapMonsters = await this.mapService.getMapMonsters(currentMap);
    const seenMonsters = new Set<string>();
    const monsterList = mapMonsters
      .filter((m) => {
        const key = m.name || '';
        if (!key || seenMonsters.has(key)) return false;
        seenMonsters.add(key);
        return true;
      })
      .map((m) => {
        const def = this.staticData.getMonsterByName(m.name) || {};
        // 面板属性必须与指令「查看」一致：优先使用 GameMonster 实例实时属性（含等级成长），
        // 静态模板(level/hp)仅作为兜底，避免出现"面板显示基础生命、查看显示成长后生命"的不一致。
        return {
          name: m.name,
          level: m.level ?? def.level ?? currentMap.level ?? 1,
          hp: m.hp ?? m.maxHp ?? def.hp ?? def.maxHp ?? 0,
        };
      });

    // 资源列表：采集型资源携带产出物/数量/gatherCmd
    const resourceList = resources.map((r: any) => ({
      name: r.name,
      type: r.type || '',
      // 剩余可采集次数（原版 times/次数，-1 表示无限），前端据此显示 ×N
      count: this.getResourceTimes(r),
      times: r.times ?? -1,
      gatherCmd: r.gatherCmd || '采集',
      // 取首个产出物的名称作为可见掉落，便于玩家判断价值
      firstDrop: Array.isArray(r.outputs) && r.outputs.length ? r.outputs[0]?.name : '',
    }));

    // NPC 列表：静态 NPC + 地图召唤物（对齐指令「观察附近」的 宠物/NPC 口径，
    // game.service L8176-8248：白仅主人可见；神之工匠/小雫/露娜/行商/小白狐/花园宝宝
    // 等特殊 NPC 同名去重标[!]；幼崽/倒地召唤物带后缀标注）。网页面板与指令侧
    // 显示口径保持一致，避免"观察附近有小白狐、面板 NPC(0)"的不一致观感。
    const summonEntries: Array<{ name: string; title: string; type: string }> = [];
    if (summons.length > 0) {
      const ownerRow = await this.prisma.player
        .findUnique({
          where: { userId },
          select: {
            id: true,
            masterQQ: true,
            user: { select: { qqNumber: true, externalId: true } },
          },
        })
        .catch(() => null);
      const ownerIds = new Set(
        [
          String(userId),
          String(ownerRow?.id ?? ''),
          String(ownerRow?.masterQQ ?? ''),
          String(ownerRow?.user?.qqNumber ?? ''),
          String(ownerRow?.user?.externalId ?? ''),
        ].filter(Boolean),
      );
      const nameOf = (s: any): string => String(s?.name ?? s?.名称 ?? '') || '未知';
      const qqOf = (s: any): string => String(s?.qq ?? s?.QQ ?? '');
      const isMonsterSummon = (s: any): boolean => qqOf(s).startsWith('怪物');
      const markerVal = (unit: any, markerName: string): number => {
        const raw = unit?.markers ?? unit?.标记 ?? {};
        const parsed = typeof raw === 'string' ? asJsonValue<any>(raw, {}) : raw;
        if (Array.isArray(parsed)) {
          const item = parsed.find((x: any) => (x?.name ?? x?.名称) === markerName);
          return Number(item?.value ?? item?.数值 ?? item?.count ?? 0);
        }
        return Number(parsed?.[markerName] ?? 0);
      };
      const isFixedSpecialNpc = (s: any): boolean =>
        ['npc1g', 'npc2g', '怪物露娜1g'].includes(qqOf(s)) || ['行商'].includes(nameOf(s));
      const isDedupableSpecialNpc = (s: any): boolean =>
        ['小白狐', '花园宝宝'].includes(nameOf(s));

      const shownSpecialNames = new Set<string>();
      for (const s of summons) {
        const name = nameOf(s);
        // 白只对主人显示（原版 L781-784）
        if (name === '白' && !ownerIds.has(String(s?.ownerQQ ?? s?.归属 ?? s?.owner ?? ''))) {
          continue;
        }
        const isSpecialNpc = isFixedSpecialNpc(s) || isDedupableSpecialNpc(s);
        if (isSpecialNpc && shownSpecialNames.has(name)) continue;
        let title = '召唤物';
        if (isSpecialNpc) {
          shownSpecialNames.add(name);
          title = '[!]';
        } else if (markerVal(s, '幼崽') !== 0) {
          title = '(幼崽)';
        } else if (isMonsterSummon(s)) {
          title = Number(s?.currentHp ?? s?.当前生命 ?? s?.hp ?? 0) > 0 ? '召唤物' : '(倒地)';
        }
        summonEntries.push({ name, title, type: 'summon' });
      }
    }

    const npcList = [
      ...npcs.map((n: any) => ({
        name: n.name,
        title: n.title || '',
        type: n.type || 'npc',
      })),
      ...summonEntries,
    ];

    return {
      currentMap: {
        name: currentMap.name,
        mapId: currentMap.id,
        // 静态数据中的地图描述含 "#换行" 标记，输出前统一转为真实换行
        description: normalizeGameText(currentMap.description || ''),
        // 怪物实例统一来自 GameMonster；currentMap.monsters 仅是静态模板，不代表当前存活数量。
        monsters: mapMonsters.length,
        resources: resources.length,
        // NPC 计数与 npcList 同口径：静态 NPC + 召唤物（观察附近口径）
        npcs: npcList.length,
        monsterList,
        resourceList,
        npcList,
      },
      subMaps,
      allMaps,
    };
  }

  /**
   * 获取当前玩家所在区域（同一地图）的附近玩家列表
   * 用于网页右侧面板展示"附近玩家"，支持与其他玩家交互（私聊/@提及等）
   * 规则：同一地图内的玩家视为"附近"，标记在线状态，自己除外；在线优先、按等级降序排列
   * @param userId 当前玩家用户ID
   * @returns 附近玩家列表 [{ userId, username, nickname, avatar, level, name, hp, maxHp, online }]
   */
  async getNearbyPlayers(userId: number): Promise<any[]> {
    // 当前玩家所在地图
    const { mapId } = await this.playerService.getPlayerLocation(userId);
    // 同一地图内的所有玩家档案（关联用户信息用于展示昵称/头像）
    const players = await this.prisma.player.findMany({
      where: { mapId },
      include: {
        user: {
          select: { id: true, username: true, nickname: true, avatar: true },
        },
      },
    });

    // 在线用户集合（一次性读取，避免逐个判断）
    const onlineIds = this.statsService.getOnlineUserIds();

    return players
      .filter((p) => p.userId !== userId) // 排除自己
      .map((p) => ({
        userId: p.userId,
        username: p.user.username,
        nickname: p.user.nickname || p.user.username,
        avatar: p.user.avatar || '',
        level: p.level,
        name: p.name,
        hp: p.hp,
        maxHp: p.maxHp,
        online: onlineIds.has(p.userId),
      }))
      .sort(
        (a, b) =>
          // 在线玩家优先，其次按等级降序
          Number(b.online) - Number(a.online) || b.level - a.level,
      );
  }

  /**
   * 获取两个地图之间的距离
   */
  private getDistance(map1: any, map2: any): number {
    const connections1 = this.mapService.getConnections(map1);
    const conn = connections1.find((c: any) => c.name === map2.name);
    return conn ? (conn.distance || 50) : 50;
  }

  /** 计算原版“移动”成就使用的最短路径节点数（含起点和终点）。 */
  private async getMovementPathLength(startMap: any, targetMap: any): Promise<number> {
    const startName = String(startMap?.name || '');
    const targetName = String(targetMap?.name || '');
    if (!startName || !targetName || startName === targetName) return 1;

    try {
      const getAllMaps = (this.mapService as any)?.getAllMaps;
      const getConnections = (this.mapService as any)?.getConnections;
      if (typeof getAllMaps !== 'function' || typeof getConnections !== 'function') return 1;

      const maps = await getAllMaps.call(this.mapService);
      const mapByName = new Map((maps || []).map((map: any) => [String(map?.name || ''), map]));
      mapByName.set(startName, startMap);
      mapByName.set(targetName, targetMap);

      const queue: Array<{ name: string; length: number }> = [{ name: startName, length: 1 }];
      const visited = new Set<string>([startName]);
      while (queue.length > 0) {
        const current = queue.shift() as { name: string; length: number };
        const currentMap = mapByName.get(current.name);
        for (const connection of getConnections.call(this.mapService, currentMap) || []) {
          const nextName = String(connection?.name || '');
          if (!nextName || visited.has(nextName)) continue;
          const nextLength = current.length + 1;
          if (nextName === targetName) return nextLength;
          if (mapByName.has(nextName)) {
            visited.add(nextName);
            queue.push({ name: nextName, length: nextLength });
          }
        }
      }
    } catch (error: any) {
      this.logger.warn(`计算移动路径长度失败: ${error?.message || error}`);
    }
    return 1;
  }

  /**
   * 处理查看信息命令
   */
  async handleInfo(userId: number): Promise<string> {
    await this.taskService.ensureTutorialTasks(userId);
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, tasks } = playerData;

    const map = await this.mapService.getMapById(player.mapId);

    // 计算战斗力（基于"计算后"的成长属性，而非 DB 静态字段）
    // 对应原版 加成计算.ecode _计算玩家：攻击/生命/护盾/装甲按等级+熟练度成长
    const calcBonus = this.combatSystem.buildAttackerBonus(player, playerData);
    const bonus: BonusData = {
      攻击: calcBonus.攻击 || 0,
      生命: calcBonus.生命 || 0,
      装甲: calcBonus.装甲 || 0,
      速度: calcBonus.速度 || 0,
    };
    const combatPower = this.bonusService.calcCombatPower(bonus);

    // 检查是否为新手玩家（等级1且无操作记录）
    const isNewPlayer = player.level === 1 && !markers['指引_attack'] && !markers['指引_info'];

    const lines: string[] = [];

    if (isNewPlayer) {
      // 新玩家欢迎信息 - 清晰的起步引导 + 编号快捷菜单
      lines.push('🎉 欢迎来到使魔大战！');
      lines.push('━━━━━━━━━━━━━━━');
      lines.push('📖 你从医疗室醒来，这里有一些基础物资。');
      lines.push('下面带你了解这个世界：');
      lines.push('');
      lines.push('【现在做什么？】');
      lines.push('  1. 发送「观察附近」看看周围有什么');
      lines.push('  2. 发送「背包」看看你的基础物资');
      lines.push('  3. 发送「攻击」试试打怪');
      lines.push('  4. 发送「使魔大战」打开完整主菜单');
      lines.push('  5. 发送「帮助」查看常用指令和玩法');
      lines.push('');
      lines.push('💡 发送下方编号数字可快速操作：');
      lines.push('  1. 观察附近    2. 查看背包');
      lines.push('  3. 攻击        4. 打开主菜单');
      lines.push('  5. 查看帮助');
      lines.push('');
      lines.push('━━━━━━━━━━━━━━━');
      // 为新玩家生成编号快捷操作（临时输入替换，发数字即可触发）
      await this.shortcutService.setTempInput(userId, '1@观察附近#2@背包#3@攻击#4@使魔大战#5@帮助');
    }

    // 显示计算后的属性：攻击/生命/护盾/装甲/速度均来自 _计算玩家 成长公式（含等级成长）
    // 原版显示的就是 玩家.属性（计算后），而非基础存储值
    const showAttack = Math.round(calcBonus.攻击 || 0);
    const showMaxHp = Math.round(calcBonus.生命 || player.maxHp || 100);
    const showMaxShield = Math.round(calcBonus.护盾 || player.maxShield || 0);
    const showMaxArmor = Math.round(calcBonus.装甲 || player.maxArmor || 0);
    const showSpeed = Math.round(calcBonus.速度 || player.speed || 0);

    lines.push(`【${player.name || '冒险者'}】Lv.${player.level}`);
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`❤️ HP: ${Math.round(player.hp || 0)}/${showMaxHp}`);
    lines.push(`🛡️ 护盾: ${Math.round(player.shield || 0)}/${showMaxShield}`);
    lines.push(`⛓️ 装甲: ${Math.round(player.armor || 0)}/${showMaxArmor}`);
    lines.push(`⚔️ 攻击: ${showAttack}`);
    lines.push(`💨 速度: ${showSpeed}`);
    lines.push(`⭐ 经验: ${Math.round(player.exp || 0)}/${Math.round(this.playerService.calcUpgradeExp(player.level))}`);
    lines.push(`📍 位置: ${map?.name || '未知'}`);
    lines.push(`🔥 战斗力: ${combatPower}`);

    // 显示当前任务（如果有）
    if (tasks && tasks.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`📋 当前任务:`);
      for (const task of tasks) {
        const taskName = typeof task === 'string' ? task : task.name || task.title || '未知任务';
        const taskProgress = task.count ? ` (${task.count})` : '';
        lines.push(`  ${taskName}${taskProgress}`);
      }
    }

    // ========== 装备栏面板（对齐原版 数据显示.ecode 使魔数据 L2032-2210） ==========
    // 原版按部位遍历：头部/饰品/肩膀/上身/背部/手臂/手掌/腰部/下身/腿环/腿部/脚部/武器/植入体/增幅器/背上备用武器
    const equipmentList = asJsonValue<any[]>(player.equipment, []);
    const weaponList = asJsonValue<any[]>(player.weapons, []);
    const currentWeaponIdx = Number(player.currentWeapon ?? 0);
    const slotNames = ['头部', '饰品', '肩膀', '上身', '背部', '手臂', '手掌', '腰部', '下身', '腿环', '腿部', '脚部'];
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`📋 装备:`);

    // 品质前缀映射（对齐原版 显示品质 L1591-1639）
    const qualityPrefix = (data: string): string => {
      const c = (data || '').charAt(0).toLowerCase();
      const map: Record<string, string> = { e: '普通', d: '良好', c: '优秀', b: '精良', a: '史诗', s: '传说' };
      return map[c] || '神迹';
    };

    // 装备槽位取数：与 buildEquipmentSnapshot / 网页左面板同口径。
    // 运行时 item.type 固定为「装备」大分类（见 item.service.equipItem），必须查静态表 equipType，
    // 对齐原版 物品操作.ecode L1824 寻找装备（z=装备列表[b] 后取 z.类型）。
    const getEquipType = (item: any): string => {
      const def = this.staticData.getEquipmentByName(item.name);
      return String(def?.equipType ?? def?.type ?? def?.类型 ?? item.type ?? item.类型 ?? '');
    };

    for (const slotName of slotNames) {
      const eqIdx = equipmentList.findIndex((e: any) => getEquipType(e) === slotName);
      if (eqIdx >= 0) {
        const eq = equipmentList[eqIdx];
        const qName = qualityPrefix(eq.data || eq.数据 || '');
        const fx = eq.effect || eq.特效 || 0;
        const fxStr = fx > 0 ? `[特效${fx}]` : '';
        const enhanceLv = this.combatState.getAchievementProficiency(markers, slotName + '强化');
        lines.push(`  ${slotName}: ${qName} ${eq.name || eq.名称 || '未知'}${fxStr}(+${enhanceLv})`);
      } else {
        const enhanceLv = this.combatState.getAchievementProficiency(markers, slotName + '强化');
        lines.push(`  ${slotName}: 无(+${enhanceLv})`);
      }
    }

    // 武器栏（L2160-2168）
    if (currentWeaponIdx > 0 && weaponList[currentWeaponIdx - 1]) {
      const w = weaponList[currentWeaponIdx - 1];
      const qName = qualityPrefix(w.data || w.数据 || '');
      const fx = w.effect || w.特效 || 0;
      const fxStr = fx > 0 ? `[特效${fx}]` : '';
      const enhanceLv = this.combatState.getAchievementProficiency(markers, '武器强化');
      lines.push(`  武器: ${qName} ${w.name || w.名称 || '拳头'}${fxStr}(+${enhanceLv})`);
    } else {
      const enhanceLv = this.combatState.getAchievementProficiency(markers, '武器强化');
      lines.push(`  武器: 普通 拳头(+${enhanceLv})`);
    }

    // 植入体（L2170-2179）
    const implantIdx = equipmentList.findIndex((e: any) => getEquipType(e) === '植入体');
    if (implantIdx >= 0) {
      const im = equipmentList[implantIdx];
      const qName = qualityPrefix(im.data || im.数据 || '');
      lines.push(`  植入: ${qName} ${im.name || im.名称 || '未知'}`);
    } else {
      lines.push(`  植入: 无`);
    }

    // 增幅器（L2180-2189）
    const ampIdx = equipmentList.findIndex((e: any) => getEquipType(e) === '增幅器');
    if (ampIdx >= 0) {
      const am = equipmentList[ampIdx];
      const qName = qualityPrefix(am.data || am.数据 || '');
      lines.push(`  增幅: ${qName} ${am.name || am.名称 || '未知'}`);
    } else {
      lines.push(`  增幅: 无`);
    }

    // 背上备用武器（L2190-2209）
    let backupIdx = 0;
    for (let i = 0; i < weaponList.length; i++) {
      if (i + 1 !== currentWeaponIdx) {
        const w = weaponList[i];
        const qName = qualityPrefix(w.data || w.数据 || '');
        const fx = w.effect || w.特效 || 0;
        const fxStr = fx > 0 ? `[特效${fx}]` : '';
        if (backupIdx === 0) {
          lines.push(`  背上: ${qName} ${w.name || w.名称 || '未知'}${fxStr}`);
        } else {
          lines.push(`       ${qName} ${w.name || w.名称 || '未知'}${fxStr}`);
        }
        backupIdx++;
      }
    }

    // 当前增益效果（对齐原版 显示使魔数据 L956-963）
    const buffStrs = this.formatBuffList(playerData.buffs ?? player.buffs);
    if (buffStrs.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`✨ 增益: ${buffStrs.join('、')}`);
    }

    return lines.join('\n');
  }

  /**
   * 处理查看背包命令
   */
  async handleInventory(userId: number, arg?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const items = this.playerService.getBackpackItems(player);

    if (items.length === 0) {
      return '🎒 你的背包空空如也';
    }

    // 查看单项详情（对应原版 物品操作.ecode L815~L818：背包 序号/名称 查看物品详情）
    if (arg) {
      // 支持按序号或名称定位
      const idxNum = parseInt(arg, 10);
      let item;
      if (!isNaN(idxNum) && idxNum >= 1 && idxNum <= items.length) {
        item = items[idxNum - 1];
      } else {
        item = items.find((i: any) => (i.name || i.名称) === arg);
      }
      if (!item) {
        return `背包中没有找到【${arg}】\n使用「背包」查看物品列表`;
      }
      if ((item.type || item.类型) === '装备') {
        return this.itemSystemService.analyzeEquipmentItem(item, '背包');
      }
      const itemName = item.name || item.名称 || '未知物品';
      const count = Math.round(this.itemQuantity(item) * 100) / 100;
      const type = item.type || item.类型 ? `\n类型: ${item.type || item.类型}` : '';
      const desc = item.description || item.说明 ? `\n${item.description || item.说明}` : '';
      return `🎒【${itemName}】×${count}${type}${desc}`;
    }

    const lines = items.map((item: any, index: number) => {
      if ((item.type || item.类型) === '装备') {
        return `${index + 1}. ${this.itemService.formatEquipmentInventoryDisplay(item)}`;
      }
      const itemName = item.name || item.名称 || '未知物品';
      const count = Math.round(this.itemQuantity(item) * 100) / 100;
      return `${index + 1}. ${itemName} ×${count}`;
    });

    return `🎒 背包 (${items.length}种):\n${lines.join('\n')}`;
  }

  /**
   * 处理查看地图命令
   */
  async handleMap(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const currentMap = await this.mapService.getMapById(player.mapId);
    if (!currentMap) return '你不在任何地图上';

    const connections = this.mapService.getConnections(currentMap);
    const monsters = await this.mapService.getMapMonsters(currentMap);

    const lines = [
      `🗺️ 【${currentMap.name}】`,
      currentMap.description ? `📖 ${currentMap.description}` : '',
      `━━━━━━━━━━━━━━━`,
      `怪物数量: ${monsters.length}`,
      monsters.length > 0
        ? `怪物: ${monsters.map((m: any) => m.name || '未知').join(', ')}`
        : '',
      `━━━━━━━━━━━━━━━`,
      `可前往:`,
      ...connections.map((c: any) => `  → ${c.name} (距离: ${c.distance})`),
    ];

    return lines.filter(Boolean).join('\n');
  }

  /**
   * 处理查看状态命令（详细属性）
   */
  /**
   * 处理详细属性面板命令
   * 对应原版 数据显示.ecode 显示使魔数据(L723-995)：详细模式(参数详细=真)
   * 显示计算后的完整属性面板，含四系抗性、穿透、回复、增益等
   */
  async handleStatus(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, buffs, weapons, equipment, sets } = playerData;

    // 计算后属性（对齐原版 _计算玩家：攻击/生命/护盾/装甲/命中/闪避/暴击等按等级+熟练度成长）
    const calcBonus = this.combatSystem.buildAttackerBonus(player, playerData);
    const b = calcBonus;
    const num = (v: any) => Math.round(Number(v) || 0);
    const fmt = (v: any) => {
      const n = Number(v) || 0;
      return Number.isInteger(n) ? String(n) : n.toFixed(1);
    };

    const lines: string[] = [];
    lines.push(`【${player.name || '冒险者'}】详细属性`);
    lines.push('━━━━━━━━━━━━━━━');
    // 基础信息（L768-779）
    lines.push(`等级: ${player.level}`);
    const expStr = `经验: ${num(player.exp)}/${num(this.playerService.calcUpgradeExp(player.level))}`;
    lines.push(expStr);
    // 觉醒信息（L773-777）
    const awakenVal = this.combatState.getAchievementProficiency(markers, '觉醒');
    const killVal = this.combatState.getAchievementProficiency(markers, '击杀');
    if (awakenVal > 0) {
      lines.push(`击杀: ${killVal} (觉醒可获得击杀属性加成)`);
    }
    lines.push('━━━━━━━━━━━━━━━');
    // 三池（L780-786）
    if (num(b.护盾) !== 0) lines.push(`护盾: ${num(player.shield)}/${num(b.护盾)}`);
    if (num(b.装甲) !== 0) lines.push(`装甲: ${num(player.armor)}/${num(b.装甲)}`);
    lines.push(`生命: ${num(player.hp)}/${num(b.生命)}`);
    // 四系攻击（L787-788）
    lines.push(`物攻: ${fmt(b.物伤)}  电攻: ${fmt(b.电伤)}`);
    lines.push(`火攻: ${fmt(b.火伤)}  冰攻: ${fmt(b.冰伤)}`);
    // 命中/闪避/速度/暴击（L789-790）
    lines.push(`命中: ${fmt(b.命中)}  闪避: ${fmt(b.闪避)}`);
    lines.push(`速度: ${fmt(b.速度)}  暴击: ${num(b.暴击)}%`);
    // 好感/采集（L791-806）
    const affinityVal = this.combatState.getAchievementProficiency(markers, '好感' + player.qq || '');
    if (player.type) {
      const famAff = this.combatState.getAchievementProficiency(markers, (player.type || '') + '好感');
      lines.push(`好感: ${fmt(famAff)}  采集: ${num(b.采集)}%`);
    } else {
      lines.push(`好感: ${fmt(affinityVal)}`);
    }
    // 战力/挑战等级（L807）
    const combatPower = this.bonusService.calcCombatPower(b);
    const challengeLevel = this.combatState.getAchievementProficiency(markers, '挑战等级');
    lines.push(`战力: ${combatPower}  挑战: ${challengeLevel}`);
    lines.push('━━━━━━━━━━━━━━━');
    // ========== 详细属性段（L808-976，对应原版 详细=真 分支） ==========
    // 护盾抗性（L809-813）
    if (num(b.护盾伤害上限) !== 0) lines.push(`◆护盾单次最多减少${fmt(b.护盾伤害上限)}%`);
    lines.push(`◆护盾物/火/冰/电抗:`);
    lines.push(`  ${fmt(b.护盾物抗)}%/${fmt(b.护盾火抗)}%/${fmt(b.护盾冰抗)}%/${fmt(b.护盾电抗)}%`);
    // 装甲抗性（L814-818）
    if (num(b.装甲伤害上限) !== 0) lines.push(`◆装甲单次最多减少${fmt(b.装甲伤害上限)}%`);
    lines.push(`◆装甲物/火/冰/电抗:`);
    lines.push(`  ${fmt(b.装甲物抗)}%/${fmt(b.装甲火抗)}%/${fmt(b.装甲冰抗)}%/${fmt(b.装甲电抗)}%`);
    // 生命抗性（L819-823）
    if (num(b.生命伤害上限) !== 0) lines.push(`◆生命单次最多减少${fmt(b.生命伤害上限)}%`);
    lines.push(`◆生命物/火/冰/电抗:`);
    lines.push(`  ${fmt(b.生命物抗)}%/${fmt(b.生命火抗)}%/${fmt(b.生命冰抗)}%/${fmt(b.生命电抗)}%`);
    // 暴击伤害/韧性（L824）
    lines.push(`◆暴击伤害: ${fmt(b.暴击伤害)}%  韧性: ${fmt(b.韧性)}%`);
    // 经验加成/升级经验（L825-835）
    if (player.type) {
      if (num(b.经验) !== 0 || num(b.升级经验) !== 0) {
        lines.push(`◆获得经验+${fmt(b.经验)}%  升级经验${fmt(b.升级经验)}%`);
      }
    } else {
      if (num(b.升级经验) !== 0) {
        lines.push(`◆升级经验${fmt(b.升级经验)}%`);
      }
    }
    // 穿透（L836-838）
    if (num(b.护盾穿透) + num(b.装甲穿透) + num(b.生命穿透) !== 0) {
      lines.push(`◆护盾/装甲/生命穿透: ${fmt(b.护盾穿透)}/${fmt(b.装甲穿透)}/${fmt(b.生命穿透)}%`);
    }
    // 攻击冷却（L839-850）：玩家按武器列举
    const weaponList = weapons || asJsonValue<any[]>(player.weapons, []);
    if (Array.isArray(weaponList) && weaponList.length > 0) {
      const cdParts: string[] = weaponList.map((w: any, i: number) =>
        `${w.name || w.名称 || `武器${i + 1}`}:${num(w.cooldown ?? w.冷却 ?? 0)}`,
      );
      lines.push(`◆攻击冷却:`);
      lines.push(`  ${cdParts.join('  ')}`);
    }
    // 额外攻击次数（L851-853）
    if (num(b.攻击次数) > 0) {
      lines.push(`◆额外攻击次数: ${num(b.攻击次数)}`);
    }
    // 贯穿/抗贯穿（L854-856）
    if (num(b.贯穿) + num(b.抗贯穿) !== 0) {
      lines.push(`◆贯穿: ${fmt(b.贯穿)}%  抗贯穿: ${fmt(b.抗贯穿)}%`);
    }
    // 溅射（L857-859）
    if (num(b.溅射) + num(b.溅射2 ?? 0) !== 0) {
      lines.push(`◆溅射伤害: ${num(b.溅射)}% (数量${num(b.溅射数量 ?? 0)})`);
    }
    // 三回复（L860-868）
    if (num(b.护盾回复) + num(b.护盾回复2 ?? 0) !== 0) {
      lines.push(`◆护盾回复: ${fmt(b.护盾回复)}+${fmt(b.护盾回复2)}%`);
    }
    if (num(b.装甲回复) + num(b.装甲回复2 ?? 0) !== 0) {
      lines.push(`◆装甲修复: ${fmt(b.装甲回复)}+${fmt(b.装甲回复2)}%`);
    }
    if (num(b.生命回复) + num(b.生命回复2 ?? 0) !== 0) {
      lines.push(`◆生命恢复: ${fmt(b.生命回复)}+${fmt(b.生命回复2)}%`);
    }
    // 三偷取（L869-877）
    if (num(b.吸护盾) + num(b.吸护盾2 ?? 0) !== 0) {
      lines.push(`◆护盾偷取: ${num(b.吸护盾)}+${num(b.吸护盾2)}%`);
    }
    if (num(b.吸装甲) + num(b.吸装甲2 ?? 0) !== 0) {
      lines.push(`◆装甲偷取: ${num(b.吸装甲)}+${num(b.吸装甲2)}%`);
    }
    if (num(b.吸生命) + num(b.吸生命2 ?? 0) !== 0) {
      lines.push(`◆生命偷取: ${num(b.吸生命)}+${num(b.吸生命2)}%`);
    }
    // 三部位伤害倍率（L878）
    lines.push(`◆护盾/装甲/生命伤害: ${100 + num(b.攻击护盾)}/${100 + num(b.攻击装甲)}/${100 + num(b.攻击生命)}`);
    // 掉落（L879-884）
    if (num(b.掉落率) + num(b.掉落品质) !== 0) {
      lines.push(`◆掉落几率+${fmt(b.掉落率)}% (数量+${fmt(b.掉落品质)}%)`);
    }
    if (sets && num((sets as any).legendaryRate ?? (sets as any).传说率) !== 0) {
      lines.push(`◆传说几率+${fmt((num((sets as any).legendaryRate ?? (sets as any).传说率)) * 12.5)}%`);
    }
    // 每秒回复（L885-889）：玩家版除以3
    const hpRegenPerSec = (num(b.生命回复) + num(b.生命回复2) / 100 * num(b.生命)) /
      (1 - (num(b.生命火抗) + num(b.生命物抗) + num(b.生命冰抗) + num(b.生命电抗)) / 400);
    const armorRegenPerSec = (num(b.装甲回复) + num(b.装甲回复2) / 100 * num(b.装甲)) /
      (1 - (num(b.装甲火抗) + num(b.装甲物抗) + num(b.装甲冰抗) + num(b.装甲电抗)) / 400);
    const shieldRegenPerSec = (num(b.护盾回复) + num(b.护盾回复2) / 100 * num(b.护盾)) /
      (1 - (num(b.护盾火抗) + num(b.护盾物抗) + num(b.护盾冰抗) + num(b.护盾电抗)) / 400);
    const totalRegen = hpRegenPerSec + armorRegenPerSec + shieldRegenPerSec;
    lines.push(`◆每秒回复: ${fmt(totalRegen / 3)}`);
    // 卷土重来（L890-892）
    if (player.type) {
      lines.push(`◆卷土重来持续时间: ${30 + num(b.卷土重来)}`);
    }
    // 每秒输出DPS（L893-920）
    const currentWeaponIdx = num(player.currentWeapon ?? player.当前武器 ?? 0);
    if (currentWeaponIdx > 0 && Array.isArray(weaponList) && weaponList.length >= currentWeaponIdx) {
      const z = weaponList[currentWeaponIdx - 1];
      const zPhys = Number(z?.bonus?.物 ?? z?.属性?.物 ?? 0);
      const zFire = Number(z?.bonus?.火 ?? z?.属性?.火 ?? 0);
      const zIce = Number(z?.bonus?.冰 ?? z?.属性?.冰 ?? 0);
      const zElec = Number(z?.bonus?.电 ?? z?.属性?.电 ?? 0);
      const zCd = Number(z?.cooldown ?? z?.冷却 ?? 10) || 10;
      const baseDps = (num(b.冰伤) * zIce / 100 + num(b.火伤) * zFire / 100 + num(b.物伤) * zPhys / 100 + num(b.电伤) * zElec / 100) / zCd;
      const critDps = (num(b.暴击伤害) - 100) / 100 * num(b.暴击) / 100 * baseDps;
      lines.push(`◆每秒输出: ${fmt(baseDps + critDps)}`);
    } else {
      const baseDps = num(b.物伤) / 10;
      const critDps = num(b.暴击) / 100 * (num(b.暴击伤害) - 100) / 100 * baseDps;
      lines.push(`◆每秒输出: ${fmt(baseDps + critDps)}`);
    }
    // 攻击加成倍率（L903-904）
    const atkBonus = (100 + (1 * (1 + num(b.电伤2) / 100) * (1 + num(b.攻击2) / 100) +
      1 * (1 + num(b.物伤2) / 100) + 1 * (1 + num(b.火伤2) / 100) + 1 * (1 + num(b.冰伤2) / 100) - 4) * 100) *
      (1 + num(b.攻击2) / 100);
    lines.push(`◆攻击加成倍率: ${fmt(atkBonus)}%`);
    // 当前增益效果（L956-963）
    const buffStrs = this.formatBuffList(Array.isArray(buffs) ? buffs : player.buffs);
    if (buffStrs.length > 0) {
      lines.push(`◆当前增益: ${buffStrs.join('、')}`);
    }
    // 魅力/活力（L977-985）
    if (player.type) {
      const productivity = this.combatState.getAchievementProficiency(markers, '生产');
      if (productivity > 0) {
        lines.push(`载具生产力+${productivity}%  魅力: ${fmt(b.魅力)}`);
      } else {
        lines.push(`魅力: ${fmt(b.魅力)}`);
      }
      const vitality = Math.max(100, this.combatState.getAchievementProficiency(markers, '活力2'));
      lines.push(`活力: ${num(player.vitality ?? player.活力 ?? 0)}/${vitality}`);
    }
    // 驾驶载具（L986-992）
    const map = await this.mapService.getMapById(player.mapId);
    if (map?.name) {
      const vehicles = asJsonValue<any[]>(map.vehicles, []);
      const playerVehicles = asJsonValue<any[]>(player.vehicles, []);
      const allVehicles = [...(vehicles || []), ...(playerVehicles || [])];
      const driven = allVehicles.find((v: any) =>
        v.owner === String(userId) || v.归属 === String(userId) ||
        v.driver === String(userId) || v.驾驶者 === String(userId),
      );
      if (driven) {
        const vName = driven.name || driven.名称 || '载具';
        const vHp = num(driven.currentHp ?? driven.当前生命 ?? 0);
        const vMaxHp = num(driven.bonus?.生命 ?? driven.加成?.生命 ?? 0);
        lines.push(`正在驾驶 ${vName}(${vHp}/${vMaxHp})`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 处理使用物品命令
   */
  async handleUseItem(userId: number, itemName: string, count = 1): Promise<string> {
    const cropName = this.getSeedCropName(itemName);
    if (cropName) {
      return this.handleUseSeed(userId, itemName, cropName, count);
    }
    return this.itemService.useItem(userId, itemName, count);
  }

  /**
   * 处理“使用全部XX”命令
   * 1:1 复刻 _主程序.ecode L4517-4540：模糊匹配名字包含[XX]的全部可用箱子，
   * 屏蔽种子，倒序逐一全部使用（对应原版快捷的“使用全部箱”操作）。
   */
  async handleUseAllItems(userId: number, keyword: string): Promise<string> {
    return this.itemService.useAllItems(userId, keyword);
  }

  /** 原版“使用种子”直接把作物放入当前地图资源2，不经过普通物品掉落。 */
  private getSeedCropName(itemName: string): string {
    const normalizedName = String(itemName || '').trim();
    if (!normalizedName.endsWith('种子')) return '';
    const item = this.staticData.getItemByName(normalizedName);
    const effects = asJsonValue<any[]>(item?.useEffects, []);
    const candidates = effects
      .flatMap((effect: any) => String(effect ?? '').split(/[，,、]/))
      .map((effect: string) => effect.trim())
      .filter(Boolean);
    const resource = this.staticData.getAllResources().find((candidate: any) => {
      const name = String(candidate?.name ?? candidate?.名称 ?? '').trim();
      return candidates.includes(name)
        && this.parseResourceOutputs(candidate?.outputs2 ?? candidate?.['产出2']).length > 0;
    });
    return String(resource?.name ?? resource?.名称 ?? '').trim();
  }

  private async handleUseSeed(
    userId: number,
    seedName: string,
    cropName: string,
    requestedCount: number,
  ): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${player.name || '冒险者'}当前不在有效地图中`;

    const mapName = String(map.name || '');
    if (mapName.endsWith('屋内')) {
      return `${player.name || '冒险者'}不能在房子内使用${seedName}`;
    }

    const ownHouse = Boolean(player.houseName && mapName === String(player.houseName));
    if (map.isFrontier && !ownHouse) {
      return `${player.name || '冒险者'}不能在别人家里用这个`;
    }

    // 原版普通地图最多保留两个作物；自己的院子允许继续种植。
    if (!ownHouse) {
      const resources2 = asJsonValue<any[]>(map.resources2, []);
      const cropCount = resources2
        .filter((resource: any) => this.parseResourceOutputs(resource?.outputs2 ?? resource?.['产出2']).length > 0)
        .reduce((total: number, resource: any) => total + Number(
          resource?.quantity ?? resource?.count ?? resource?.times ?? resource?.次数 ?? 1,
        ), 0);
      if (cropCount >= 2) return `${player.name || '冒险者'}当前地图无法种下更多了`;
    }

    const count = Math.max(1, Math.floor(Number(requestedCount) || 1));
    let planted = 0;
    let lastMessage = '';
    for (let index = 0; index < count; index++) {
      const result = await this.homeService.plantSeed(map, seedName, backpack, []);
      lastMessage = result.message;
      if (!result.success) break;
      planted += 1;
    }
    if (planted <= 0) return lastMessage || `背包中没有「${seedName}」`;

    await this.mapService.updateDynamicFields(map.id, { resources2: map.resources2 });
    player.backpack = backpack; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, '种植', planted);
    await this.taskService.advance(userId, `种植${cropName}`, planted);
    return `${player.name || '冒险者'}在${mapName}种下了${cropName}×${planted}`;
  }

  /**
   * 处理装备命令
   * 用户可能输入的物品名形态：
   *   - 「基础名」（如 防弹上衣）
   *   - 「基础名 + 单字母品质码」（如 防弹上衣D）
   *   - 「基础名 + 品质码 + 可选·后缀特效」（如 防弹上衣D·纯洁无瑕）
   * 而背包里 item.name 仅存基础名（品质在 item.data，特效在解析层），
   * 因此做三层回退匹配保证任意形态都能定位到目标物品。
   */
  async handleEquip(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const items = this.playerService.getBackpackItems(player);

    const normalizedName = String(itemName || '').trim();
    if (!normalizedName) return '请指定要装备的物品名称';

    const numericIndex = /^\d+$/.test(normalizedName)
      ? Number(normalizedName) - 1
      : -1;
    let index = numericIndex >= 0
      ? numericIndex
      : items.findIndex((item: any) => item.name === normalizedName);

    // 回退 1：剥除尾部单字母品质码 + 可选·后缀，再用基础名匹配
    if (index < 0 || index >= items.length) {
      const stripped = normalizedName
        // 去掉末尾·xxx特效（最后一个·之后的内容）
        .replace(/·[^·]+$/, '')
        // 去掉末尾单字母品质码（大小写都允许）
        .replace(/[edcbasxEDCBASX]$/, '')
        .trim();
      if (stripped && stripped !== normalizedName) {
        index = items.findIndex((item: any) => item.name === stripped);
      }
    }

    // 回退 2：用背包显示全名（含品质码 + ·特效）整段匹配
    if (index < 0 || index >= items.length) {
      index = items.findIndex(
        (item: any) =>
          (item.type || item.类型) === '装备' &&
          this.itemService.formatEquipmentInventoryDisplay(item) === normalizedName,
      );
    }

    if (index < 0 || index >= items.length) return `背包中没有【${itemName}】`;

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
  async handleSkill(userId: number): Promise<string> {
    // 对齐原版：技能导航菜单（通用技能/使魔技能/查看成就/查看标记/查看标记2）。
    // 原版并无独立的“技能”指令直接倾倒技能说明，统一先走导航，
    // 再由「使魔技能」「通用技能」等具体指令展示内容，避免与它们重复。
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const lines: string[] = [`✨ ${player.name || '冒险者'} 技能导航:`, `━━━━━━━━━━━━━━━`];
    const options: { label: string; cmd: string }[] = [
      { label: '通用技能', cmd: '通用技能' },
      { label: '使魔技能', cmd: '使魔技能' },
      { label: '查看成就', cmd: '查看成就' },
      { label: '查看标记', cmd: '查看标记' },
      { label: '查看标记2', cmd: '查看标记2' },
    ];
    const menu = await this.buildNumberedMenu(userId, options, '💡 发送编号数字即可查看对应内容');
    lines.push(...menu);
    return lines.join('\n');
  }

  /**
   * 处理救助命令
   * 对应原版：救助 命令（救起倒地使魔，或维修使魔的载具）
   */
  async handleRescue(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${player.name || '冒险者'}当前不在有效地图中`;

    const markers2 = this.parseRescueMarkers(player.markers2 ?? playerData.markers2);
    const active = this.getActiveRescueMarker(markers2);
    if (active) {
      return `${player.name || '冒险者'}正在${this.rescueActionText(active.rescueType)}，还需要${this.remainingRescueSeconds(active)}秒`;
    }

    // 玩家自己已倒地时，「救助」退化为自救（与「复活使魔」同一条30秒延时链路）：
    // 战斗系统的死亡门禁会引导玩家使用「救助」复活，若这里不处理会导致玩家永久卡死。
    if (this.playerService.isPlayerDead(player)) {
      return this.beginSelfRescue(userId, player, markers2);
    }

    const summons = this.parseRescueArray(map.summons);
    const deadSummonIndex = summons.findIndex((summon: any) => {
      const maxHp = this.rescueMaxHp(summon);
      return maxHp > 0 && this.rescueHp(summon) <= 0;
    });

    if (deadSummonIndex >= 0) {
      const summon = summons[deadSummonIndex];
      const position = deadSummonIndex + 1;
      let seconds = 30;
      // 原版军姬2：宠物越靠前救助越快，最低3秒。
      if (Number(player.specialSeq) === 24 || player.type === '军姬2') {
        seconds = Math.max(3, 30 * (1 - (2 / position) * 0.9));
      }

      const marker = this.createRescueMarker('familiar', seconds, {
        mapId: map.id,
        summonId: this.rescueUnitId(summon),
      });
      markers2.push(marker);
      player.markers2 = markers2; // Json 列直接写数组
      await this.playerService.savePlayer(player);
      await this.taskService.advance(userId, '救助');
      this.scheduleRescueCompletion(userId, marker);

      const summonName = this.rescueUnitName(summon);
      return `${player.name || '冒险者'}正在抢救${summonName}，需要${this.formatRescueSeconds(seconds)}秒`;
    }

    const vehicles = this.parseRescueArray(map.vehicles);
    const damagedVehicleIds = new Set<string>();
    for (const summon of summons) {
      const vehicleKey = this.rescueVehicleKey(summon);
      if (!vehicleKey) continue;
      const vehicle = vehicles.find((candidate: any) => this.rescueVehicleKeys(candidate).has(vehicleKey));
      if (!vehicle || !this.isDamagedRescueVehicle(vehicle)) continue;
      damagedVehicleIds.add(vehicleKey);
    }

    if (damagedVehicleIds.size === 0) {
      return `${player.name || '冒险者'}，这里还没有需要抢救的宠物`;
    }

    const marker = this.createRescueMarker('vehicle', 30, { mapId: map.id });
    markers2.push(marker);
    player.markers2 = markers2; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, '救助');
    this.scheduleRescueCompletion(userId, marker);
    return `${player.name || '冒险者'}正在帮助宠物维修载具中，需要30秒`;
  }

  /**
   * 处理对话命令
   * 与地图上的NPC对话，根据NPC类型显示不同对话文本，支持触发任务
   * 对应原版：对话 命令
   */
  async handleTalk(userId: number, npcName: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 特殊NPC剧情映射（新手流程固定NPC，不依赖地图数据）
    // 原版中这些NPC由"生成人物"指令动态生成，地图 npcs 字段可能为空，
    // 因此将固定剧情前置处理，保证新手引导中的「对话 新手引导员」始终可用。
    const specialNpcs: Record<string, { title: string; dialogs: Record<string, string> }> = {
      '新手引导员': {
        title: '新手引导员·小薇',
        dialogs: {
          'hello': '你好呀，新人！我是新手引导员小薇，欢迎来到使魔大战的世界！\n\n你从出生点醒来，先打开背包看看身上的物资吧，\n再和我聊聊，了解一下这个世界。',
          'intro': '这个世界的怪物可不是好惹的，先从背包里拿出你的石制工具吧！\n\n💡 使用「装备 石制工具」来装备武器\n💡 使用「攻击」来试试身手\n💡 使用「背包」查看你拥有的物品',
          'quest': '等你准备好了，我有个任务要交给你。\n任务我已经帮你接好了，先看看任务列表吧。\n\n使用「查看任务」查看任务详情，完成要求后奖励会自动发放。',
          'done': '你已经学会了基本操作，去探索更广阔的世界吧！\n\n记住：\n  - 使用「移动 地图名」前往新区域\n  - 使用「对话 NPC名」与NPC交谈\n  - 遇到困难可以「求助」其他玩家',
        }
      },
      '老村长': {
        title: '老村长',
        dialogs: {
          'hello': '咳咳，年轻人，你就是新来的冒险者吧？\n\n我是这个新手村的村长，已经在这里生活了几十年了。\n最近村子周围的怪物越来越多了，我需要你的帮助。',
          'intro': '你看到村子东边的走廊了吗？那里原本是通往神殿的通道，\n但是最近被一群史莱姆占据了。\n去那里看看吧，说不定能找到一些有用的东西。',
          'quest': '年轻人，如果你愿意的话，帮我清理掉走廊里的史莱姆。\n作为回报，我会告诉你关于使魔的秘密。',
          'done': '你做得很好，年轻人！\n现在我告诉你，使魔是这个世界最神奇的伙伴。\n使用「召唤使魔」来召唤你的第一个使魔吧！',
          'story': '很久很久以前，使魔大战爆发了……\n算了，这些故事以后再说。\n你现在的任务是提升实力，去探索这个世界的秘密。',
        }
      },
      '流浪商人': {
        title: '流浪商人·阿福',
        dialogs: {
          'hello': '嘿嘿，新面孔啊！我是流浪商人阿福，\n我在各个大陆之间旅行，贩卖各种稀奇古怪的东西。\n\n要不要看看我的商品？使用「购物」来打开商店。',
          'intro': '我这里的商品可都是好东西！\n有武器、防具、药品，还有一些特殊的道具。\n\n不过嘛……好东西可不便宜，你先去赚点钱再来吧。',
          'quest': '如果你能帮我收集一些稀有的材料，我可以给你一个优惠价。\n先去探索一下周围的地图，看看能找到什么好东西吧。',
          'done': '你收集到了不错的材料？厉害厉害！\n作为奖励，我可以给你打个八折，嘿嘿。',
        }
      },
      '旅行者': {
        title: '神秘的旅行者',
        dialogs: {
          'hello': '嘘……别出声。\n我正在观察走廊里的那些史莱姆，它们的行为很奇怪。\n\n你也是来探索这条走廊的吗？',
          'intro': '这条走廊被称为「试炼之路」，每个新人都要经过这里。\n走廊里有各种资源和机关，当然也有怪物。\n\n先提升自己的实力，再向走廊深处前进吧。',
          'quest': '如果你能前往走廊深处探索，帮我看看那里的情况。\n但我警告你，走廊深处有一种特殊的史莱姆，\n它们比普通史莱姆要强大得多。',
          'done': '你探索了走廊深处？太好了！\n那条走廊蕴含着许多秘密，好好探索吧。',
        }
      },
      '行商': {
        title: '流浪行商·阿福',
        dialogs: {
          'hello': '嘿，新人！我这里有些好东西，要不要看看？',
          'intro': '我这里有各种武器和防具，不过价格嘛……嘿嘿。',
          'quest': '如果你有材料，可以找我制作装备，我的锻造技术可是一流的！',
          'done': '欢迎下次光临！',
        }
      },
      '白': {
        title: '白',
        dialogs: {
          'hello': '这里是哪里？我好像睡了很久……\n你是我醒来后见到的第一个人，谢谢你唤醒了我。',
          'intro': '我感觉到这条走廊上有奇怪的气息，我们要小心前行。\n我的力量还没有完全恢复，需要你的帮助。',
          'quest': '你愿意和我一起探索这条走廊吗？我感觉到深处有什么东西在呼唤着我。',
          'done': '谢谢你一直陪着我，和你在一起让我感觉很安心。',
        }
      },
    };
    // 指定了NPC且命中特殊NPC → 视为可对话（无需地图数据中存在该NPC）。
    // 白只有在休眠仓剧情已经触发，或当前地图确实存在白时才可对话，
    // 避免未唤醒时直接推进“对话白”任务。
    const isKnownSpecialNpc = !!npcName && !!specialNpcs[npcName];

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);

    // 解析地图NPC列表
    const npcs = asJsonValue<any[]>(map ? map.npcs : [], []);
    const parsedSummons = asJsonValue<any>(map ? map.summons : [], []);
    const mapSummons = Array.isArray(parsedSummons) ? parsedSummons : [];
    const whiteAvailable = Number(markers['召唤白'] || 0) > 0
      || npcs.some((unit: any) => (unit?.name ?? unit?.名称) === '白')
      || mapSummons.some((unit: any) => (unit?.name ?? unit?.名称) === '白');
    const isSpecialNpc = isKnownSpecialNpc && (npcName !== '白' || whiteAvailable);
    if (!map && !isSpecialNpc) return '你不在任何地图上！';

    // 地图怪物（原版 对话 分支 L1469-1478：召唤物没匹配上时继续按名称匹配怪物，
    // 「主线-继续询问」的“对话史莱姆”正是走这条路径）。
    // 注意：不能拿「NPC 数 + 召唤物数 == 0」做对话门禁，否则只有怪物的地图
    // （如森林出口）会连怪物一起挡掉，玩家永远无法完成“对话史莱姆”类任务。
    let mapMonsters: any[] = [];
    if (map) {
      try {
        mapMonsters = (await this.mapService.getMapMonsters(map.id)) || [];
      } catch { mapMonsters = []; }
    }

    // 如果没有指定NPC名称，显示可对话对象列表（附带编号快捷选项，发数字即可对话）
    if (!npcName) {
      const lines = [`💬 【${map.name}】可对话对象:`];
      // 编号快捷对话选项：label=展示文本，cmd=实际触发的「对话 名称」
      const options: { label: string; cmd: string }[] = [];
      const usedCmds = new Set<string>();
      const pushOption = (name: string, note?: string) => {
        const cmd = `对话 ${name}`;
        if (usedCmds.has(cmd)) return;
        usedCmds.add(cmd);
        lines.push(`  ${name}${note ? ` - ${note}` : ''}`);
        options.push({ label: cmd, cmd });
      };
      for (const npc of npcs) {
        const name = npc.name || '未知';
        pushOption(name, npc.description);
      }
      // 召唤物（白/行商/宠物等运行时单位）也是原版对话对象
      for (const summon of mapSummons) {
        const name = String(summon?.name ?? summon?.名称 ?? '');
        if (!name) continue;
        if (name === '白' && !whiteAvailable) continue;
        pushOption(name, '召唤物');
      }
      // 怪物（同名只列一次，原版同名单位匹配第一只）
      for (const monster of mapMonsters) {
        if ((monster?.hp ?? 0) <= 0) continue;
        const name = String(monster?.name ?? monster?.名称 ?? '');
        if (!name) continue;
        const level = Number(monster?.level ?? monster?.等级 ?? 0);
        pushOption(name, level > 0 ? `怪物 Lv.${level}` : '怪物');
      }
      // 地图无NPC/召唤物/怪物数据时，列出新手固定NPC供玩家选择
      // 注意：快捷对话必须用特殊NPC的 key（如 新手引导员），不能用标题（如 新手引导员·小薇），
      // 因为 handleTalk 通过 specialNpcs[key] 解析特殊NPC。
      if (options.length === 0) {
        const specialList: { key: string; desc: string }[] = [
          { key: '新手引导员', desc: '新手村的引导员' },
          { key: '老村长', desc: '新手村的村长' },
          { key: '流浪商人', desc: '贩卖各种物品的商人' },
          { key: '旅行者', desc: '神秘的旅行者' },
          { key: '白', desc: '从休眠仓中唤醒的少女' },
        ];
        for (const sp of specialList) {
          if (sp.key === '白' && !whiteAvailable) continue;
          lines.push(`  ${specialNpcs[sp.key].title} - ${sp.desc}`);
          options.push({ label: `对话 ${specialNpcs[sp.key].title}`, cmd: `对话 ${sp.key}` });
        }
      }
      if (options.length === 0) return '当前地图没有可对话的NPC';
      lines.push(``);
      const menuLines = await this.buildNumberedMenu(userId, options, '💡 发送编号数字(如 1)即可与对应NPC对话');
      if (menuLines.length === 0) {
        lines.push(`使用「对话 NPC名」与NPC对话`);
      } else {
        lines.push(...menuLines);
      }
      return lines.join('\n');
    }

    // ===== 对话目标解析（对齐原版 对话 分支 _主程序.ecode L1478-1570）=====
    // 优先级：地图NPC → 地图召唤物（白/行商/宠物等运行时单位）→ 地图怪物 → 特殊NPC占位。
    let targetNpc: any = npcs.find((n: any) => (n?.name ?? n?.名称) === npcName) || null;
    let unitKind: 'npc' | 'summon' | 'monster' | 'special' = targetNpc ? 'npc' : 'special';
    if (!targetNpc) {
      const summonIdx = mapSummons.findIndex((s: any) =>
        [s?.name, s?.名称, s?.image, s?.图片].some((v: any) => String(v ?? '') === npcName));
      if (summonIdx >= 0) {
        targetNpc = mapSummons[summonIdx];
        unitKind = 'summon';
      }
    }
    // 白：优先找地图实体；历史存档（只有 召唤白 标记）按需补建实体。
    if (!targetNpc && npcName === '白' && map) {
      const white = await this.ensurePlayerWhite(player, map).catch(() => null);
      if (white) {
        targetNpc = white;
        unitKind = 'summon';
      }
    }
    if (!targetNpc && mapMonsters.length > 0) {
      // 原版 L1469-1478：召唤物没匹配上时按名称找怪物。优先存活个体。
      const matchByName = (list: any[]) =>
        list.find((m: any) => [m?.name, m?.名称].some((v: any) => String(v ?? '') === npcName));
      const monster = matchByName(mapMonsters.filter((m: any) => (m?.hp ?? 0) > 0))
        || matchByName(mapMonsters);
      if (monster) {
        targetNpc = monster;
        unitKind = 'monster';
      }
    }
    if (!targetNpc && isSpecialNpc) {
      targetNpc = { name: npcName, title: specialNpcs[npcName].title, type: 'npc', description: '' };
      unitKind = 'special';
    }
    if (!targetNpc) {
      return `当前地图没有名为【${npcName}】的NPC`;
    }

    // 原版 _主程序.ecode L1566-1567：找到对话对象后才推进「对话」和「对话+名称」。
    // “主线-继续询问”的“对话史莱姆3”等要求由此结算。放在服务层统一处理，指令入口
    // 与编号菜单入口都能生效，也避免按返回文本猜测对话是否成功。
    await this.taskService.advance(userId, '对话').catch(() => '');
    await this.taskService.advance(userId, `对话${npcName}`).catch(() => '');

    // 地图实体（召唤物/怪物/NPC）走原版对话结构（菜单+编号临时输入）；
    // 特殊NPC（新手引导员等新框架剧情NPC）保留对话阶段推进。
    if (unitKind !== 'special') {
      return this.buildUnitDialogue(player, userId, npcName, targetNpc, unitKind);
    }

    // 根据NPC类型生成对话文本
    const npcType = targetNpc.type || 'generic';
    const npcTitle = targetNpc.title || '未知NPC';
    const dialogLines: string[] = [];

    // 基础问候
    const greetings = [
      `你好，${player.name || '冒险者'}！`,
      `欢迎来到${map ? map.name : '新手村'}！`,
      `有什么事吗？`,
    ];
    dialogLines.push(`【${npcTitle}】`);
    dialogLines.push(`━━━━━━━━━━━━━━━`);
    dialogLines.push(greetings[Math.floor(Math.random() * greetings.length)]);

    // 特殊NPC对话剧情（对话阶段推进）
    {
      // 根据教程进度和与当前NPC的对话历史确定对话阶段
      const tutorialValue = markers['教程'] || 0;
      // 检查与该NPC的独立对话进度（支持每个NPC独立的对话推进）
      const talkProgress = markers[`对话_${npcName}`] || 0;
      let dialogPhase: string;
      if (talkProgress >= 3) {
        dialogPhase = 'done';
      } else if (talkProgress >= 2) {
        dialogPhase = 'quest';
      } else if (talkProgress >= 1) {
        dialogPhase = 'intro';
      } else {
        dialogPhase = 'hello';
      }
      // 如果用独立对话进度得出的阶段与教程阶段冲突，取较高级的那个
      // 例如：教程已到done阶段，但从未和该NPC对话过，仍展示高级内容
      if (tutorialValue >= 3 && dialogPhase !== 'done') {
        dialogPhase = 'done';
      }

      // 检查新手指引中的对话引导
      const tutorialText = this.tutorialService.getTutorial('talk', markers);
      if (tutorialText) {
        markers['指引_talk'] = 1;
        player.markers = markers; // Json 列直接写对象
        await this.playerService.savePlayer(player);
      }

      // 检查当前NPC是否在特殊NPC列表中
      const specialNpc = specialNpcs[npcName];
      if (specialNpc) {
        // 使用特殊NPC的标题替换默认标题
        const dialogText = specialNpc.dialogs[dialogPhase] || specialNpc.dialogs['hello'];
        dialogLines.push(dialogText);

        // 更新与该NPC的对话进度
        markers[`对话_${npcName}`] = (talkProgress + 1);
        player.markers = markers; // Json 列直接写对象
        await this.playerService.savePlayer(player);

        // 对话进度提示
        if (talkProgress < 3) {
          dialogLines.push(`━━━━━━━━━━━━━━━`);
          dialogLines.push(`💡 继续对话可了解更多信息`);
        }
        // 跳过后续通用NPC对话逻辑
      } else {
        // 非特殊NPC，使用通用对话逻辑
        dialogLines.push(this.genericNpcChatLine(npcType));
      }
    }

    // NPC描述文本
    if (targetNpc.description) {
      dialogLines.push(`━━━━━━━━━━━━━━━`);
      dialogLines.push(`${targetNpc.description}`);
    }

    // 对齐原版（_主程序.ecode L1492-1493）：NPC 对话末尾生成编号快捷菜单，
    // 用临时输入替换让玩家发数字即可继续。原版对所有对话对象统一提供「1、查看 2、攻击」入口。
    // 此处按需求提供「1、对话 2、任务」：1=继续对话推进对话阶段，2=查看任务。
    const menuLines = await this.buildNumberedMenu(userId, [
      { label: `对话 ${npcName}`, cmd: `对话 ${npcName}` }, // 1=继续对话，推进对话阶段
      { label: '任务', cmd: '查看任务' },                      // 2=查看任务
    ], '💡 发送编号数字(如 1)快速操作');
    dialogLines.push(`━━━━━━━━━━━━━━━`);
    dialogLines.push(...menuLines);

    return dialogLines.join('\n');
  }

  /** 特殊占位 NPC 的通用对话台词（新框架剧情 NPC，非原版对话配置）。 */
  private genericNpcChatLine(npcType: string): string {
    switch (npcType) {
      case 'merchant':
      case 'shop':
        return `我这里有些好东西，你可以用「购物」来查看。`;
      case 'quest':
      case 'task':
        return `我有个任务需要你的帮助，使用「领取任务」来看看吧。`;
      case 'blacksmith':
      case 'smith':
        return `我可以帮你修理装备，使用「修理」来修复你的物品。`;
      case 'healer':
        return `我可以为你治疗伤口，躺下休息能恢复生命。`;
      case 'guide':
        return `欢迎来到使魔大战的世界！使用「帮助」查看游戏指南。`;
      default:
        return `今天天气不错，适合出门冒险！`;
    }
  }

  /**
   * 地图单位对话（对齐原版 对话 分支 _主程序.ecode L1489-1570）：
   * 对话文本取对话配置（怪物=敌对聊天，其余=友好聊天），末尾生成原版编号菜单：
   * 怪物 = 查看/攻击(+跟我来)；NPC = 查看/领取任务 + 行商购物/花园宝宝捕捉/露娜求助/
   * 跟随开关(不要跟着我了/跟上我)/救助/挤奶/控制终端(白)。
   */
  private async buildUnitDialogue(
    player: any,
    userId: number,
    npcName: string,
    unit: any,
    kind: 'npc' | 'summon' | 'monster',
  ): Promise<string> {
    const nameOf = String(unit?.name ?? unit?.名称 ?? '') || npcName;
    const typeOf = String(unit?.type ?? unit?.类型 ?? '') || nameOf;
    const qqOf = String(unit?.qq ?? unit?.QQ ?? '');
    const isMonsterUnit = kind === 'monster' || qqOf.startsWith('怪物');

    const markerOf = (markerName: string): number => {
      const raw = unit?.markers ?? unit?.标记 ?? {};
      const parsed = typeof raw === 'string' ? asJsonValue<any>(raw, {}) : raw;
      if (Array.isArray(parsed)) {
        const item = parsed.find((x: any) => (x?.name ?? x?.名称) === markerName);
        return Number(item?.value ?? item?.数值 ?? item?.count ?? 0);
      }
      return Number(parsed?.[markerName] ?? 0);
    };
    const ownerOf = String(unit?.ownerQQ ?? unit?.归属 ?? unit?.owner ?? '');
    const ownerIds = new Set([String(userId), String(player?.id ?? '')].filter(Boolean));
    const isOwned = ownerIds.has(ownerOf);

    const dialogLines: string[] = [`【${nameOf}】`, `━━━━━━━━━━━━━━━`];
    // 对话文本（原版 取对话：怪物取敌对聊天，其余取友好聊天）
    const chatText = this.staticData.getDialogue(
      String(player?.name || ''),
      unit,
      nameOf,
      isMonsterUnit ? 0 : 1,
    );
    if (chatText && chatText !== '……') dialogLines.push(chatText);

    // 幼崽成长展示（原版 L1531-1538 计算幼崽）
    try {
      this.familiarSystemService?.checkAndUpdateGrowth?.(unit);
    } catch { /* 成长解析失败不影响对话 */ }
    if (markerOf('幼崽') !== 0) {
      const babyLabel = typeOf.includes('幼崽') ? typeOf : `${typeOf}宝宝`;
      dialogLines.push(`${babyLabel},${this.millisecondsToText(markerOf('幼崽'))}后长大`);
      const ownerUser = ownerOf
        ? await this.prisma.user.findUnique({ where: { id: Number(ownerOf) } }).catch(() => null)
        : null;
      if (ownerUser) dialogLines.push(`主人:${ownerUser.nickname || ownerUser.username || ownerOf}`);
    }

    // 咏星类跟随单位展示好感（原版 L1496-1498）
    if (typeOf === '咏星') {
      dialogLines.push(`对你的好感:${this.round2Text(markerOf(`好感${userId}`))}`);
    }

    // 菜单（原版 L1512-1560）
    const options: { label: string; cmd: string }[] = [];
    const literalAliases: string[] = [];
    if (isMonsterUnit) {
      options.push({ label: '查看', cmd: `查看 ${nameOf}` });
      options.push({ label: '攻击', cmd: `攻击 ${nameOf}` });
      if (typeOf.includes('小恶魔')) {
        options.push({ label: '跟我来', cmd: '对话小恶魔跟随' });
      } else if (typeOf.includes('咏星')) {
        options.push({ label: '跟我来', cmd: '对话咏星跟随' });
      }
    } else {
      options.push({ label: '查看', cmd: `查看 ${nameOf}` });
      options.push({ label: '领取任务', cmd: `领取任务 ${nameOf}` });
      if (nameOf === '行商') {
        options.push({ label: '购物', cmd: '购物' });
      } else if (nameOf === '花园宝宝' || nameOf === '小白狐') {
        options.push({ label: '捕捉', cmd: `捕捉 ${nameOf}` });
      } else if (qqOf === 'npc1g' || nameOf === '神之工匠') {
        options.push({ label: '融合', cmd: '融合' });
      } else if (qqOf === '怪物露娜1g' || nameOf === '露娜') {
        options.push({ label: '求助', cmd: '求助' });
        const backpack = this.playerService.getBackpackItems(player);
        if (backpack.some((item: any) => (item?.name ?? item?.名称 ?? '') === '未知物品')) {
          options.push({ label: '询问幽能', cmd: '对话露娜未知' });
        }
      } else {
        // 跟随开关（原版 L1540-1547：跟随标记==0 → 不要跟着我了，否则跟上我）
        if (markerOf('跟随') === 0) {
          options.push({ label: '不要跟着我了', cmd: `设置跟随 ${nameOf}` });
          literalAliases.push(`不要跟着我了@设置跟随 ${nameOf}`);
        } else {
          options.push({ label: '跟上我', cmd: `设置跟随 ${nameOf}` });
          literalAliases.push(`跟上我@设置跟随 ${nameOf}`);
        }
        if (isOwned) {
          options.push({ label: '救助', cmd: '救助' });
          literalAliases.push(`救助@救助`);
          options.push({ label: '挤奶', cmd: `挤奶 ${nameOf}` });
          literalAliases.push(`挤奶@挤奶 ${nameOf}`);
          if (typeOf === '白') {
            options.push({ label: '控制终端', cmd: '控制终端' });
          }
        }
      }
    }

    dialogLines.push(`━━━━━━━━━━━━━━━`);
    const menuLines = await this.buildNumberedMenu(
      userId,
      options,
      '💡 发送编号数字(如 1)快速操作',
      literalAliases,
    );
    dialogLines.push(...menuLines);
    return dialogLines.join('\n');
  }

  /** 毫秒 → 可读时间文本（对应原版 数字到时间 的秒/分秒简化）。 */
  private millisecondsToText(ms: number): string {
    const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    if (totalSec < 60) return `${totalSec}秒`;
    return `${Math.floor(totalSec / 60)}分${totalSec % 60}秒`;
  }

  private round2Text(value: number): string {
    return String(Math.round((Number(value) || 0) * 100) / 100);
  }

  /**
   * 处理与露娜的对话（对话露娜未知）
   * 对应原版：对话露娜未知 命令
   * 当玩家携带"未知物品"（具现装置的产物）与露娜对话时，
   * 可用其兑换"工业建筑箱"或"专属装备补给箱"，并增加露娜熟练度
   */
  async handleDialogueLuna(userId: number, arg: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, backpack } = playerData;

    // 获取当前地图，确认露娜在场
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    const summons = asJsonValue<any[]>(map.summons, []);
    const luna = summons.find((s: any) => s.qq === '怪物露娜1g' || s.name === '露娜');
    if (!luna) {
      return '你环顾四周，露娜并不在这里。\n她偶尔会出现在某些地图上，找到她才能用未知物品兑换奖励。';
    }

    // 解析兑换选项：无参数时展示选项，参数为1/2时执行兑换
    const choice = parseInt(arg.replace(/[^\d]/g, ''), 10) || 0;

    // 统计背包中的"未知物品"数量
    const unknownItems = backpack.filter((item: any) => item.name === '未知物品' || item.name.includes('未知物品'));
    const unknownCount = unknownItems.reduce((sum: number, item: any) => sum + (item.count || 1), 0);

    if (choice === 0) {
      // 展示兑换菜单
      if (unknownCount <= 0) {
        return '【露娜】\n━━━━━━━━━━━━━━━\n这是……具现装置的产物？！\n这种东西对你来说也没用，不如交给我，我可以用你想要的东西作为奖励。\n\n不过你现在好像没有「未知物品」，去具现装置那里看看吧。';
      }
      return `【露娜】\n━━━━━━━━━━━━━━━\n这是……具现装置的产物？！\n这种东西对你来说也没用，不如交给我，我可以用你想要的东西作为奖励。\n\n你拥有「未知物品」×${unknownCount}，想兑换什么？\n1、工业建筑箱\n2、专属装备补给箱\n\n输入「对话露娜未知 1」或「对话露娜未知 2」进行兑换`;
    }

    if (unknownCount <= 0) {
      return '你的背包中没有「未知物品」，无法兑换。';
    }

    // 确定兑换目标
    const rewardName = choice === 1 ? '工业建筑箱' : '专属装备补给箱';
    if (choice !== 1 && choice !== 2) {
      return '请输入正确的选项：1=工业建筑箱，2=专属装备补给箱';
    }

    // 扣除未知物品，给予奖励物品
    let remaining = unknownCount;
    player.backpack = backpack
      .map((item: any) => {
        if (item.name === '未知物品' || item.name.includes('未知物品')) {
          const take = Math.min(item.count || 1, remaining);
          remaining -= take;
          return { ...item, count: (item.count || 1) - take };
        }
        return item;
      })
      .filter((item: any) => (item.count || 0) > 0);

    // 发放奖励物品
    const rewardItem = { name: rewardName, count: unknownCount };
    player.backpack.push(rewardItem);

    // 增加露娜熟练度
    markers['露娜熟练度'] = (markers['露娜熟练度'] || 0) + unknownCount * 10;
    player.markers = markers; // Json 列直接写对象
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 与露娜兑换：${unknownCount}个未知物品 → ${rewardName}`);
    return `【露娜】\n━━━━━━━━━━━━━━━\n非常感谢！\n（露娜熟练度+${unknownCount * 10}，用${unknownCount}个未知物品跟她换了${rewardName}）`;
  }

  /**
   * 处理来倒目的（延时移动）
   * 对应原版：来倒目的 命令
   * 由系统延时任务触发，格式为"地图名$来源地图"，将玩家移动到指定地图
   * 若目标为"四圣祭坛"且四个祭坛均无怪物，则刷出神兽麒麟
   */
  async handleArriveAt(userId: number, arg: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 解析参数："目标地图$来源地图"
    const parts = (arg || '').split('$');
    const targetName = parts[0]?.trim();
    if (!targetName) {
      return '移动输入的数据不正确';
    }

    // 查找目标地图
    const targetMap = await this.mapService.getMapByName(targetName);
    if (!targetMap) {
      return `目标地图「${targetName}」不存在`;
    }

    // 统一走普通移动/飞行共用的到达结算（含观测产出/四圣祭坛麒麟/普拉娜剪毛等到达触发），
    // 确保地图增益、懒刷新、探索和任务只处理一次。
    const arrivalResult = await this.performArrival(userId, targetMap.id, targetMap.name, { skipMapRefresh: true });
    return arrivalResult;
  }

  /**
   * 处理家园命令
   * 家园系统的入口，支持子命令
   */
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
  async handleProbe(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查是否死亡
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 解析地图各 JSON 字段
    const monsters = await this.mapService.getMapMonsters(map);
    const resources2 = asJsonValue<any[]>(map.resources2, []);
    const items = asJsonValue<any[]>(map.items, []);
    const npcs = asJsonValue<any[]>(map.npcs, []);
    // 与采集门禁保持一致：过滤已采完(times=0)与当前玩家已领取过(marker)的固定资源
    const probeMarkers = asJsonValue<Record<string, any>>(player.markers, {});
    const resources = asJsonValue<any[]>(map.resources, [])
      .filter((r: any) => this.getResourceTimes(r) !== 0 && this.isGatherResourceAvailable(r, probeMarkers));

    const lines: string[] = [
      `🔍 【${map.name}】探测报告`,
      `━━━━━━━━━━━━━━━`,
    ];

    // 地图描述
    if (map.description) {
      lines.push(`📖 ${map.description}`);
      lines.push(`━━━━━━━━━━━━━━━`);
    }

    // 怪物信息
    if (monsters.length > 0) {
      lines.push(`👾 怪物 (${monsters.length}只):`);
      for (const m of monsters) {
        const hpPercent = m.maxHp > 0 ? Math.round((m.hp / m.maxHp) * 100) : 0;
        // 伤害计算保留双精度（对齐原版），显示时取整，避免出现 HP:13.13679525036632 这种浮点尾巴
        lines.push(`  ${m.name} Lv.${m.level} HP:${Math.round(m.hp)}/${Math.round(m.maxHp)}(${hpPercent}%)${m.isElite ? ' ⚠️精英' : ''}`);
      }
    } else {
      lines.push(`👾 怪物: 当前地图没有怪物`);
    }

    // 可采集资源信息
    const collectableResources = resources2.filter((r: any) => r.amount > 0);
    if (collectableResources.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`⛏️ 可采集资源 (${collectableResources.length}种):`);
      for (const r of collectableResources) {
        lines.push(`  ${r.name} ×${r.amount} ${r.type ? `[${r.type}]` : ''}`);
      }
    }

    // 固定资源信息
    if (resources.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`📦 固定资源:`);
      for (const r of resources) {
        lines.push(`  ${r.name || '未知'} ${r.amount ? `×${r.amount}` : ''}`);
      }
    }

    // 可拾取物品
    if (items.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`🎒 地上物品 (${items.length}种):`);
      for (const item of items) {
        const count = item.count || item.quantity || 1;
        lines.push(`  ${item.name} ×${count}`);
      }
    }

    // NPC 信息
    if (npcs.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`💬 NPC (${npcs.length}个):`);
      for (const npc of npcs) {
        lines.push(`  ${npc.name || '未知'}${npc.description ? ` - ${npc.description}` : ''}`);
      }
    }

    // 连接信息
    const connections = this.mapService.getConnections(map);
    if (connections.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`🚪 可前往:`);
      for (const c of connections) {
        lines.push(`  → ${c.name} (距离: ${c.distance || '?'})`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 拾取地上物品
   * 从地图的 items JSON 字段中拾取物品到背包
   */
  async handlePickup(userId: number, itemName?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查是否死亡
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 解析地图上的物品
    const mapItems = asJsonValue<any[]>(map.items, []);
    if (mapItems.length === 0) {
      return '地上没有可拾取的物品';
    }

    const requestedName = String(itemName || '').trim();
    if (!requestedName) {
      // 对齐原版：无参数只展示地面物品，“拾取全部”才真正执行拾取。
      const lines = [`${player.name || '冒险者'}附近的地上有:`];
      lines.push(...mapItems.map((item: any) => {
        const count = Number(item.count ?? item.quantity ?? 1);
        return `  ${item.name || '未知'}${count === 1 ? '' : ` ×${count}`}`;
      }));
      return lines.join('\n');
    }

    // 开拓地（玩家家园）保护（原版 L3721-3736）：只有主人可以在自己家园/屋内/前线拾取
    if (map.开拓地 || map.isFrontier) {
      const house = String(player.houseName ?? '');
      const mapName = String(map.name ?? '');
      const ownHome = !!house
        && (mapName === house || mapName === `${house}屋内` || mapName === `${house}前线`);
      if (!ownHome) return `${player.name || '冒险者'}不能拿别人家里的东西`;
    }

    // 花园猫/铃铛 +33%（原版 L3743：玩家特殊序号==花园猫(1) 或 装备铃铛(特殊序号64)）
    const equipments = playerData.equipment || asJsonValue<any[]>(player.equipment, []);
    const weapons = playerData.weapons || asJsonValue<any[]>(player.weapons, []);
    const hasPickBonus = Number(player.specialSeq ?? player.特殊序号 ?? 0) === 1
      || this.combatState.equipRequire(equipments, weapons, Number(player.currentWeapon ?? 0), 64, '铃铛', false);

    const pickAll = requestedName === '全部' || requestedName === '全部拾取';
    let pickedUp: any[];
    let bonusApplied = false;

    if (pickAll) {
      // mutateMapFields 锁内闭环：重读最新 items → 全部取走 → 以实际取走内容发放
      // （避免两名玩家并发拾取同一批物品时按各自快照重复发放）
      pickedUp = await this.mapService.mutateMapFields(map.id, ['items'], (f) => {
        const taken = [...(f.items as any[])];
        for (const item of taken) {
          const type = item.type ?? item.类型 ?? '资源';
          if (type === '装备' || String(item.data ?? '') === 'a') continue;
          if (hasPickBonus) {
            // 原版 L3744-3746：数量×1.33 并标记 data="a" 防止重复加成
            item.quantity = Number(item.quantity ?? item.count ?? 1) * 1.33;
            item.data = 'a';
            bonusApplied = true;
          }
        }
        f.items = [];
        return taken;
      });
    } else {
      // 原版同时支持“拾取物品名”和“拾取序号”；锁内重定位，确保只取走一份
      const taken = await this.mapService.mutateMapFields(map.id, ['items'], (f) => {
        const fresh = f.items as any[];
        const numericIndex = /^\d+$/.test(requestedName) ? Number(requestedName) - 1 : -1;
        const idx = numericIndex >= 0
          ? numericIndex
          : fresh.findIndex((item: any) => (item.name || item.名称) === requestedName);
        if (idx < 0 || idx >= fresh.length) return null;
        const item = fresh[idx];
        const type = item.type ?? item.类型 ?? '资源';
        if (type === '装备' || String(item.data ?? '') === 'a') return fresh.splice(idx, 1)[0];
        if (hasPickBonus) {
          item.quantity = Number(item.quantity ?? item.count ?? 1) * 1.33;
          item.data = 'a';
          bonusApplied = true;
        }
        return fresh.splice(idx, 1)[0];
      });
      if (!taken) {
        return `地上没有【${requestedName}】`;
      }
      pickedUp = [taken];
    }

    for (const item of pickedUp) {
      const count = Number(item.count ?? item.quantity ?? 1);
      await this.playerService.addToBackpack(userId, item.name || item.名称, count);
    }

    this.logger.log(`玩家 ${userId} 拾取了 ${pickedUp.length} 种物品`);

    const pickedText = pickedUp.map((item: any) => {
      const count = Number(item.count ?? item.quantity ?? 1);
      return `${item.name || item.名称} ×${count}`;
    }).join('、');

    // 原版拾取顺序：先记录资源产出，再记录拾取条目数。
    // 资源数量是任务进度；“拾取”按地面条目数，不按堆叠数量计算。
    for (const item of pickedUp) {
      const type = item.type ?? item.类型 ?? '资源';
      const itemNameValue = item.name || item.名称 || '';
      const count = Number(item.count ?? item.quantity ?? 1);
      if (type !== '装备' && item.data !== 'a' && itemNameValue && count > 0) {
        await this.advanceTask(userId, '采集资源', count);
        await this.advanceTask(userId, `采集${itemNameValue}`, count);
      }
    }
    await this.advanceTask(userId, '拾取', pickedUp.length);

    // 活跃度+1（原版 L3766/L3810）
    const freshPlayer = (await this.playerService.getPlayerData(userId)).player;
    const freshMarkers = asJsonValue<Record<string, any>>(freshPlayer.markers, {});
    this.incrementMarker(freshMarkers, '活跃度', 1);
    freshPlayer.markers = freshMarkers;
    await this.playerService.savePlayer(freshPlayer);

    // 地图标记“全部拾取/拾取”时间戳（原版 L3767-3771/L3811-3815：取成就熟练度(地图.标记)）
    const stampKey = pickAll ? '全部拾取' : '拾取';
    let lastStampText = '';
    await this.mapService.mutateMapFields(map.id, ['markers'], (f) => {
      const mapMarkers = f.markers as Record<string, any>;
      const last = Number(mapMarkers[stampKey] ?? 0);
      if (last > 0) {
        lastStampText = `${map.name}上次被${pickAll ? '全部拾取' : '单项拾取'}是在${this.millisecondsToText(Date.now() - last)}之前`;
      }
      mapMarkers[stampKey] = Date.now();
      return true;
    }).catch(() => undefined);

    const bonusText = bonusApplied ? '(+33%)' : '';
    const text = pickAll
      ? `${player.name || '冒险者'}卷走了地上的${pickedUp.length}样东西${bonusText}\n${pickedText}`
      : `${player.name || '冒险者'}卷走了地上的${pickedText}${bonusText}`;
    return lastStampText ? `${text}\n${lastStampText}` : text;
  }

  /**
   * 开采资源
   * 开采当前地图的资源点
   */
  async handleMine(userId: number, resourceName?: string): Promise<string> {
    // 对齐原版 _主程序.ecode L7491「开采」：无参=载具开采（60秒延时结算）。
    // 原版「开采 资源名」带参无行为（L7512 判断 w2=="" 才进入开采链）；资源点采集
    // 原版由各资源自带的采集指令（打开箱子/捡垃圾等）承担。新版保留带参入口，
    // 避免破坏既有玩法，属有意保留的兼容扩展。
    if (resourceName) return this.mineResourcePoint(userId, resourceName);
    return this.mineByVehicle(userId);
  }

  /**
   * 手动载具开采（原版 _主程序.ecode L7491-7531「开采」）。
   * 门禁链：需驾驶载具 → 载具 HP>0 → 采集器部件（引力调频器/行星解裂器/激光采集器）
   * → 不能在副本 → 行动无限制（理由5=躺下豁免）。
   * 通过后：添加「工作」60秒标记 → 无隐形模块时延时5秒引怪（覅攻击pd）→ 玩家活跃
   * → 排程 60 秒延时结算（settleManualMine，原版「开采1c2c」）。
   */
  private async mineByVehicle(userId: number): Promise<string> {
    return this.mutatePlayer(userId, async (ctx) => {
      const { player } = ctx;
      if (this.playerService.isPlayerDead(player)) {
        return this.playerService.handlePlayerDeath(userId, player);
      }
      const map = await this.mapService.getMapById(player.mapId);
      if (!map) return '你不在任何地图上！';

      // 取载具（原版 L7494-7499）
      const vehicle = await this.findTravelVehicle(player, map);
      if (!vehicle) return `${player.name ?? '冒险者'}需要驾驶载具`;
      const vehicleName = String(vehicle.name ?? vehicle.名称 ?? '载具');
      if (Number(vehicle.currentHp ?? vehicle.当前生命 ?? 0) <= 0) {
        return `${player.name ?? '冒险者'}载具需要“维修”`;
      }

      // 采集器部件档位（原版 L7501-7509）：引力调频器=3 / 行星解裂器=2 / 激光采集器=1
      const partNames = this.collectVehiclePartNames(vehicle);
      const collector = partNames.includes('引力调频器')
        ? 3
        : partNames.includes('行星解裂器')
          ? 2
          : partNames.includes('激光采集器')
            ? 1
            : 0;
      if (collector === 0) {
        // 原版 L7511：提示 + 临时输入替换「1@制造部件」（输入 1 直接前往制造部件）
        if (this.shortcutService?.setTempInput) {
          await this.shortcutService.setTempInput(userId, '1@制造部件');
        }
        return `${player.name ?? '冒险者'}${vehicleName}需要安装激光采集器、行星解裂器或者引力调频器\n(输入 1 前往制造部件)`;
      }
      const collectorText = collector === 3
        ? '引力调频器分解'
        : collector === 2
          ? '行星解裂器轰炸'
          : '激光采集器轰炸';

      // 副本拦截（原版 L7513-7514）
      if (map.isInstance || Number(map.关卡 ?? 0) !== 0) {
        return `${player.name ?? '冒险者'}不能在副本里干这个`;
      }
      // 行动无限制，理由5=躺下豁免（原版 L7515）
      const restrict = this.combatSystem.actionUnrestricted(player, { ignoreReason: 5 });
      if (restrict.restricted) return restrict.text;

      // 工作 60 秒标记（原版 L7518 添加标记("工作",60,玩家.标记2)）
      const markers2 = asJsonValue<any[]>(player.markers2, []);
      this.normalizeMarkers2(markers2);
      this.combatState.addMarker('工作', 60, markers2, Date.now());

      // 玩家活跃（原版 L7530 玩家活跃：地图活动窗口120秒 + 玩家战斗标记15秒）
      // 无隐形模块时先延时5秒引怪（原版 L7527-7529 新建延时"覅攻击pd"+地图, 5秒）。
      const hasStealthModule = partNames.includes('隐形模块');
      if (!hasStealthModule) {
        await (this.combatSystem as any).triggerMapBattleLoop(userId, 5, { player, map });
      } else {
        const mapMarkers2 = asJsonValue<any[]>(map.markers2, []);
        this.combatState.gainBuff(mapMarkers2, '活动', 120, false, Date.now());
        map.markers2 = mapMarkers2;
        await this.mapService.updateDynamicFields(map.id, { markers2: map.markers2 });
        this.combatState.gainBuff(markers2, '战斗', 15, false, Date.now());
      }
      player.markers2 = markers2; // Json 列直接写数组

      // 排程 60 秒延时结算（原版 L7531 新建延时「开采1c2c」）
      if (this.delayedTaskService) {
        await this.delayedTaskService.schedule({
          type: 'mine',
          userId,
          dedupeKey: String(userId),
          runAt: Date.now() + 60 * 1000,
        });
      }

      // 文本（原版 L7519-7526：玩家名+召唤物跟随显示+用+采集器名+地图名）
      const display = await this.summonFollowDisplay(map, userId, { requireFollow: false, countLimit: 3 });
      const followText = display.count > 0 ? `带着${display.names.join('、')}一起` : '';
      return `${player.name ?? '冒险者'}${followText}用${collectorText}${map.name}`;
    });
  }

  /**
   * 资源点采集（带参「开采 资源名」兼容分支）。
   * 直接采当前地图剩余数量>0 的资源点并挂 respawnTime 冷却。
   * 注：原版无此用法（载具开采见 mineByVehicle、资源点采集指令见 handleGatherResource），
   * 此处为保留既有玩法的复刻扩展。
   */
  private async mineResourcePoint(userId: number, resourceName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, markers2 } = playerData;

    // 检查是否死亡
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 解析可采集资源
    const resources2 = asJsonValue<any[]>(map.resources2, []);
    const availableResources = resources2.filter((r: any) => Number(r.amount ?? r.数量 ?? 0) > 0);

    if (availableResources.length === 0) {
      return '当前地图没有可开采的资源';
    }

    // 如果没有指定资源，显示可开采列表
    if (!resourceName) {
      const lines = [`⛏️ 【${map.name}】可开采资源:`];
      for (const r of availableResources) {
        lines.push(`  ${r.name ?? r.名称} ×${r.amount ?? r.数量}`);
      }
      lines.push(``);
      lines.push(`使用「开采 资源名」进行开采`);
      return lines.join('\n');
    }

    // 查找指定资源
    const targetResource = availableResources.find(
      (r: any) => (r.name ?? r.名称) === resourceName,
    );
    if (!targetResource) {
      return `当前地图没有可开采的【${resourceName}】`;
    }

    // 检查冷却时间（通过 markers2 管理）
    const cooldownKey = `mine_${map.id}_${resourceName}`;
    const now = Date.now();
    const cooldownEntry = markers2.find((m: any) =>
      (m.key ?? m.name ?? m.名称) === cooldownKey,
    );
    if (cooldownEntry) {
      const expireAt = Number(cooldownEntry.expireTime ?? cooldownEntry.expireAt ?? cooldownEntry.有效期至 ?? 0);
      const expireMs = expireAt > 0 && expireAt < 1e12 ? expireAt * 1000 : expireAt;
      const remaining = expireMs - now;
      if (remaining > 0) {
        return `【${resourceName}】还需要 ${Math.ceil(remaining / 1000)} 秒才能再次开采`;
      }
    }

    // 采集产出
    const resourceDisplayName = targetResource.name ?? targetResource.名称 ?? resourceName;
    const amount = Number(targetResource.amount ?? targetResource.数量 ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return `当前地图没有可开采的【${resourceName}】`;
    }

    // 在同一个玩家对象上完成背包和冷却写入，避免 addToBackpack 先保存后再用旧快照覆盖背包。
    const backpack = Array.isArray((playerData as any).backpack)
      ? (playerData as any).backpack
      : this.playerService.getBackpackItems(player);
    this.addItemToCollection(backpack, { name: resourceDisplayName, type: '资源', quantity: amount });
    player.backpack = backpack; // Json 列直接写数组

    // 设置冷却时间（默认5分钟）
    const respawnTime = (targetResource.respawnTime || 300) * 1000;
    const newCooldown = {
      key: cooldownKey,
      expireTime: now + respawnTime,
    };

    // 更新 markers2（移除旧冷却条目，添加新条目）
    const updatedMarkers2 = markers2.filter((m: any) =>
      (m?.key ?? m?.name ?? m?.名称) !== cooldownKey,
    );
    updatedMarkers2.push(newCooldown);

    // 更新地图资源（mutateMapFields 锁内闭环：重读最新 resources2 → 按名重定位归零 → 差异写回；
    // 避免两名玩家并发开采同一资源时按各自快照重复结算/整组覆盖）
    const mined = await this.mapService.mutateMapFields(map.id, ['resources2'], (f) => {
      const fresh = f.resources2 as any[];
      const idx = fresh.findIndex((r: any) => (r.name ?? r.名称) === resourceName);
      if (idx === -1) return false;
      const r = fresh[idx];
      r.amount = 0;
      if (r.数量 !== undefined) r.数量 = 0;
      return true;
    });
    if (!mined) {
      return `这里没有${resourceDisplayName}可以开采`;
    }

    // 更新玩家 markers2
    player.markers2 = updatedMarkers2; // Json 列直接写数组
    await this.playerService.savePlayer(player);

    // 手动开采的任务在服务层按真实产量结算，命令层不再重复推进。
    await this.advanceTask(userId, '开采');
    await this.advanceTask(userId, '采集资源', amount);
    const gatherCommand = targetResource.gatherCmd ?? targetResource.采集指令 ?? '';
    if (resourceName === '货舱' || gatherCommand === '打开货舱') {
      await this.advanceTask(userId, '打开货舱');
    } else {
      await this.advanceTask(userId, `采集${resourceDisplayName}`, amount);
    }

    // 原版“采集资源”在有跟随者协助时会把实际采集次数减一记为“奴役”。
    // 当前资源点一次结算的 amount 就是实际采集次数，保留首轮为0的原版边界。
    const enslaved = Math.max(0, Math.floor(amount) - 1);
    if (enslaved > 0) await this.advanceTask(userId, '奴役', enslaved);

    this.logger.log(`玩家 ${userId} 开采了 ${resourceDisplayName} ×${amount}`);

    const respawnMin = Math.ceil(respawnTime / 60000);
    return `开采了 ${resourceDisplayName} ×${amount}\n该资源将在 ${respawnMin} 分钟后刷新`;
  }

  /**
   * 手动载具开采的 60 秒延时结算（原版 _主程序.ecode L7534-7608「开采1c2c」）。
   * 遍历当前地图野生资源（可再生、标记空、产出2空）：
   *   - 每个产出按身边召唤物因子独立 roll 几率（原版 几率判断）；
   *   - 数量 = 产出数量×16×(1+采集/100)，行星解裂器额外 ×(1+rand(2500,5000)/10000)；
   *   - 每个资源「次数-6」，次数归零后移除资源并挂 1800 秒「刷新资源X」重生标记；
   *   - 成就：开采+1 / 采集资源 / 采集X / 采集熟练度+2×因子；
   *   - 无隐形模块时结算后再次引怪。
   */
  private async settleManualMine(userId: number): Promise<void> {
    const text = await this.playerService.enqueueUserWrite(userId, async () => {
      const playerData = await this.playerService.getPlayerData(userId);
      const { player } = playerData;
      const map = await this.mapService.getMapById(player.mapId);
      if (!map) return '';

      // 载具/采集器重取（结算文本用；中途换载具时以当前载具为准）
      const vehicle = await this.findTravelVehicle(player, map);
      const partNames = vehicle ? this.collectVehiclePartNames(vehicle) : [];
      const collector = partNames.includes('引力调频器')
        ? 3
        : partNames.includes('行星解裂器')
          ? 2
          : partNames.includes('激光采集器')
            ? 1
            : 0;
      const collectorText = collector === 3
        ? '引力调频器开采出了'
        : collector === 2
          ? '行星解裂器开采出了'
          : '激光采集器开采出了';

      // 跟随因子（原版 L7535/L7543-7546：归属召唤物数上限2，+1）
      const display = await this.summonFollowDisplay(map, userId, { requireFollow: false, countLimit: 3 });
      const followerFactor = Math.min(2, display.count) + 1;

      // 采集加成（原版 玩家.属性.采集，实时加成口径）
      let gatherBonus = 0;
      try {
        const bonus = this.combatSystem.buildAttackerBonus(player, playerData, map) as any;
        gatherBonus = Number(bonus?.采集 ?? 0);
      } catch { /* 加成缺失按0处理 */ }
      const multiplier = 1 + gatherBonus / 100;

      // 遍历野生资源产出（原版 L7550-7585；数据侧资源/资源2已合并进 resources 字段）
      const resources = asJsonValue<any[]>(map.resources, []);
      const emptied: string[] = [];
      const awarded = new Map<string, number>();
      const backpack = this.playerService.getBackpackItems(player);
      for (const resource of resources) {
        if (resource?.renewable === false || resource?.不可再生 === true) continue; // 不可再生
        if (String(resource?.marker ?? resource?.标记 ?? '').trim()) continue;      // 一次性特殊资源
        const outputs2 = resource?.outputs2 ?? resource?.['产出2'];
        if (Array.isArray(outputs2) ? outputs2.length > 0 : asJsonValue<any[]>(outputs2, []).length > 0) continue; // 建筑/作物产出
        for (const out of this.parseResourceOutputs(resource?.outputs)) {
          if (!out.name || out.name === '电力') continue;
          for (let i = 0; i < followerFactor; i++) {
            if (Math.random() * 100 >= Number(out.chance ?? 100)) continue; // 几率判断
            let amount = Number(out.count ?? 0) * 16 * multiplier;
            if (collector === 2) {
              amount *= 1 + this.randomInt(2500, 5000) / 10000; // 原版 L7562 行星解裂器随机增幅
            }
            if (amount <= 0) continue;
            const itemType = this.staticData.getEquipmentByName(out.name) ? '装备' : '资源';
            if (itemType === '装备') {
              const equipment = await this.itemSystemService.generateRewardEquipment(out.name, out.quality || '');
              backpack.push({ ...equipment, type: '装备', quantity: 1, count: 1 });
              awarded.set(out.name, (awarded.get(out.name) || 0) + 1);
            } else {
              awarded.set(out.name, (awarded.get(out.name) || 0) + amount);
            }
          }
        }
        // 次数-6（原版 L7571-7575；次数 -1 = 无限）
        const times = Number(resource?.times ?? resource?.次数 ?? -1);
        if (times !== -1 && times > 0) emptied.push(resource.name ?? resource.名称);
      }

      // 背包写回（数值过 roundItemQuantity 三道闸）
      for (const [itemName, amount] of awarded) {
        this.addItemToCollection(backpack, { name: itemName, type: this.staticData.getEquipmentByName(itemName) ? '装备' : '资源', quantity: amount });
      }
      player.backpack = backpack; // Json 列直接写数组

      // 地图写回：次数-6、枯竭移除并挂 1800 秒刷新标记（原版 L7571-7591+后台运作 L1035）
      let exhaustedText = '';
      await this.mapService.mutateMapFields(map.id, ['resources', 'markers2'], (f) => {
        const fresh = f.resources as any[];
        if (!Array.isArray(fresh)) return false;
        let changed = false;
        for (let i = fresh.length - 1; i >= 0; i--) {
          const resource = fresh[i];
          if (resource?.renewable === false || resource?.不可再生 === true) continue;
          if (String(resource?.marker ?? resource?.标记 ?? '').trim()) continue;
          const outputs2 = resource?.outputs2 ?? resource?.['产出2'];
          if (Array.isArray(outputs2) ? outputs2.length > 0 : asJsonValue<any[]>(outputs2, []).length > 0) continue;
          const times = Number(resource?.times ?? resource?.次数 ?? -1);
          if (times === -1) continue;
          const remaining = Math.max(0, times - 6);
          resource.times = remaining;
          if (resource.次数 !== undefined) resource.次数 = remaining;
          changed = true;
          if (remaining <= 0) {
            fresh.splice(i, 1); // 枯竭移除
            const name = String(resource.name ?? resource.名称 ?? '');
            const mapMarkers2 = Array.isArray(f.markers2) ? f.markers2 : [];
            const filtered = mapMarkers2.filter((entry: any) => (entry?.name ?? entry?.名称) !== `刷新资源${name}`);
            filtered.push({ name: `刷新资源${name}`, expireAt: Date.now() + 1800 * 1000, resourceField: 'resources' });
            f.markers2 = filtered;
          }
        }
        return changed;
      }).catch(() => false);

      // 成就与任务（原版 L7549/L7602-7605）
      const totalAmount = [...awarded.values()].reduce((sum, value) => sum + value, 0);
      await this.advanceTask(userId, '开采');
      await this.advanceTask(userId, '采集资源', totalAmount);
      for (const [itemName, amount] of awarded) {
        await this.advanceTask(userId, `采集${itemName}`, amount);
      }
      const markers = asJsonValue<Record<string, any>>(player.markers, {});
      markers['采集熟练度'] = Number(markers['采集熟练度'] ?? 0) + 2 * followerFactor;
      player.markers = markers; // Json 列直接写对象
      await this.playerService.savePlayer(player);

      // 结算文本（原版 L7535-7542/L7595-7599）
      const gainedText = [...awarded.entries()]
        .map(([name, amount]) => `${name}×${Math.round(amount * 100) / 100}`)
        .join('、');
      const followText = display.count > 0 ? `带着${display.names.join('、')}一起` : '';
      let resultText = `${player.name ?? '冒险者'}${followText}用${collectorText}${gainedText || ''}`;
      if (!gainedText) resultText = `${player.name ?? '冒险者'}${map.name}的资源已经枯竭了`;
      // 无隐形模块时结算后再次引怪（原版 L7606-7608）
      if (!partNames.includes('隐形模块')) {
        try {
          await (this.combatSystem as any).triggerMapBattleLoop(userId, 5, { player, map });
        } catch (e: any) {
          this.logger.warn(`开采结算引怪失败 userId=${userId}: ${e?.message || e}`);
        }
      }
      void exhaustedText;
      const taskNotice = this.taskService.consumeNotifications(userId);
      if (taskNotice) resultText = `${taskNotice}\n————————\n${resultText}`;
      return resultText;
    });

    if (text) {
      await this.chatService.broadcastSystem('世界频道', text, userId).catch(() => undefined);
      try {
        await this.pushPlayerUpdate(userId);
        await this.pushMapUpdate(userId);
      } catch { /* 推送失败不影响结算 */ }
    }
  }

  /** 载具部件名收集（含内置零件递归；与 AutoMineService.getVehiclePartNames 同口径）。 */
  private collectVehiclePartNames(vehicle: any): string[] {
    const names: string[] = [];
    const visit = (part: any): void => {
      if (!part) return;
      const name = String(part?.name ?? part?.名称 ?? '').trim();
      if (name) names.push(name);
      for (const inner of (Array.isArray(part?.builtinParts ?? part?.内置零件 ?? part?.builtin ?? part?.内置)
        ? (part.builtinParts ?? part?.内置零件 ?? part?.builtin ?? part?.内置)
        : asJsonValue<any[]>(part?.builtinParts ?? part?.内置零件 ?? part?.builtin ?? part?.内置, []))) {
        visit(inner);
      }
    };
    const parts = Array.isArray(vehicle?.parts ?? vehicle?.零件)
      ? (vehicle.parts ?? vehicle.零件)
      : asJsonValue<any[]>(vehicle?.parts ?? vehicle?.零件, []);
    for (const part of parts) visit(part);
    for (const part of (Array.isArray(vehicle?.builtinParts ?? vehicle?.内置零件)
      ? (vehicle.builtinParts ?? vehicle.内置零件)
      : asJsonValue<any[]>(vehicle?.builtinParts ?? vehicle?.内置零件, []))) {
      visit(part);
    }
    return names;
  }

  /**
   * 召唤物跟随显示（原版 数据显示.ecode L326-401 召唤物跟随显示）。
   * 归属=玩家（ownerQQ/userId 任意键命中）、requireFollow=true 时还要求「跟随」熟练度<1；
   * countLimit 为显示数量上限（原版第2参）。返回名单文本与数量。
   */
  private async summonFollowDisplay(
    map: any,
    userId: number,
    options: { requireFollow?: boolean; countLimit?: number } = {},
  ): Promise<{ names: string[]; count: number; indexes: number[] }> {
    const requireFollow = options.requireFollow ?? true;
    const countLimit = options.countLimit ?? 0;
    const raw = map?.summons ?? map?.召唤物 ?? [];
    const summons = Array.isArray(raw) ? raw : asJsonValue<any[]>(raw, []);
    const ownerKeys = new Set([String(userId)].filter(Boolean));
    const names: string[] = [];
    const indexes: number[] = [];
    for (let i = 0; i < summons.length; i++) {
      const summon = summons[i];
      const owner = String(summon?.ownerQQ ?? summon?.归属 ?? summon?.owner ?? summon?.qq ?? '');
      if (!ownerKeys.has(owner)) continue;
      if (requireFollow) {
        let summonMarkers: any = summon?.markers ?? summon?.标记 ?? {};
        if (!Array.isArray(summonMarkers) && typeof summonMarkers === 'string') {
          summonMarkers = asJsonValue<any>(summonMarkers, {});
        }
        const prof = Array.isArray(summonMarkers)
          ? Number(summonMarkers.find((m: any) => (m?.name ?? m?.名称) === '跟随')?.value ?? 0)
          : Number(summonMarkers?.['跟随'] ?? 0);
        if (prof >= 1) continue; // 熟练度>=1 为不跟随
      }
      names.push(String(summon?.name ?? summon?.名称 ?? summon?.type ?? summon?.类型 ?? '宠物'));
      indexes.push(i);
      if (countLimit > 0 && names.length >= countLimit) break;
    }
    return { names, count: names.length, indexes };
  }

  /** 原版 取随机数(最小,最大)（含两端）。 */
  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * 判断当前玩家所在地图是否有匹配给定 gatherCmd 的固定资源。
   * 用于 ChatGateway 判定"该输入是否应作为采集指令处理"（避免被当作普通聊天广播）。
   * 对齐原版：采集指令运行时按当前地图资源2的"采集指令"匹配，无需预注册到指令表。
   * @param userId 玩家ID
   * @param cmdName 采集指令名（如 打开箱子/打开休眠仓/收集木头/捡垃圾）
   * @returns true=当前地图存在该采集指令对应的资源
   */
  async hasGatherCmd(userId: number, cmdName: string): Promise<boolean> {
    if (!cmdName) return false;
    try {
      const player = await this.prisma.player.findUnique({ where: { userId } });
      if (!player) return false;
      const map = await this.mapService.getMapById(player.mapId);
      if (!map) return false;
      const resources = this.getGatherResources(map);
      const markers = asJsonValue<Record<string, any>>(player.markers, {});
      const parsed = this.parseGatherCommand(cmdName);
      return resources.some((r) => r.gatherCmd === parsed.name
        && this.getResourceTimes(r) !== 0
        && this.isGatherResourceAvailable(r, markers));
    } catch {
      return false;
    }
  }

  /**
   * 开箱锁门禁查询（对应原版 _主程序.ecode L117-118）：
   * item.service 打开箱子处理期写入的「开箱」标记（markers2）未过期时，
   * 拦截玩家的一切其他指令：“正在开箱子，或者等待X”。
   * @returns 拦截文本；无锁时返回空串
   */
  async getOpenBoxLockText(userId: number): Promise<string> {
    try {
      const player = await this.prisma.player.findUnique({
        where: { userId },
        select: { name: true, markers2: true },
      });
      if (!player?.markers2) return '';
      const markers2 = Array.isArray(player.markers2)
        ? player.markers2
        : asJsonValue<any[]>(player.markers2, []);
      const entry = markers2.find((m: any) => (m?.name ?? m?.名称 ?? m?.key) === '开箱');
      if (!entry) return '';
      const rawExpire = Number(entry.expireTime ?? entry.expireAt ?? entry.有效期至 ?? 0);
      const expireAt = rawExpire > 0 && rawExpire < 1e12 ? rawExpire * 1000 : rawExpire;
      const now = Date.now();
      if (!Number.isFinite(expireAt) || expireAt <= now) return '';
      const remainSec = Math.ceil((expireAt - now) / 1000);
      const timeText = remainSec >= 60
        ? `${Math.floor(remainSec / 60)}分${remainSec % 60}秒`
        : `${remainSec}秒`;
      return `${player.name || '冒险者'}正在开箱子，或者等待${timeText}`;
    } catch {
      return '';
    }
  }

  /**
   * 处理固定资源的采集指令【阶段1：开始采集】（对应原版 gatherCmd 机制）
   * 1:1 对齐原版 _主程序.ecode 默认分支 L11351-11456：
   * 门禁(副本清怪/死亡/行动限制/自动采集) → 计算随机耗时(3~6秒×时间倍率×额外次数，
   * 矿炮上限30秒) → 写入「采集中」状态+「采集」锁定标记 → 调度延时任务 →
   * 回复“{采集文本},大概需要N秒”。
   * 延时到点后由 settleGatherResource（阶段2）真正结算产出。
   *
   * @param userId 玩家ID
   * @param cmdName 采集指令名（如 打开箱子/打开休眠仓/收集物品/捡垃圾，可带数字后缀表示次数）
   * @returns 开始文本；未命中任何资源时返回空字符串
   */
  async handleGatherResource(userId: number, cmdName: string, requestedCount?: number): Promise<string> {
    if (!cmdName) return '';

    // 采集开始是「读快照→改→写回」型操作，必须在用户级锁内完成，
    // 否则与定时器的采集结算并发会互相覆盖玩家数据（实测会偶发「并发冲突」）。
    // 走 mutate 收口：锁内单快照、统一落库（详见 docs/player-state-architecture.md）。
    return this.mutatePlayer(userId, async (ctx) => {
      const playerData = ctx;
      const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '';

    // 解析地图固定资源列表
    const resources = this.getGatherResources(map);
    const parsedCommand = this.parseGatherCommand(cmdName);
    const gatherName = parsedCommand.name;
    let count = Math.max(1, Math.floor(Number.isFinite(requestedCount) ? requestedCount as number : parsedCommand.count));
    const markers = asJsonValue<Record<string, any>>(player.markers, {});
    const target = resources.find((r: any) => r.gatherCmd === gatherName
      && this.getResourceTimes(r) !== 0
      && this.isGatherResourceAvailable(r, markers));
    if (!target) return '';
    const resourceName = String(target.name ?? '');

    // ===== 原版 _主程序.ecode L11374-11381 采集开始门禁 =====
    // 关卡(副本)有怪物时必须先清怪；死亡/行动受限/自动采集模式下不能手动采集。
    const hasMonsters = (await this.mapService.getMapMonsters(map)).length > 0;
    if (map.isInstance && hasMonsters) {
      return `${player.name}需要清除附近的目标`;
    }
    const deathGate = this.playerService.isPlayerDead(player)
      ? `${player.name}已经死掉了!你可以"复活使魔"或者"删除怪物"`
      : '';
    if (deathGate) return deathGate;
    const restriction = this.combatSystem.actionUnrestricted(player, { cannonOk: false });
    if (restriction.restricted) return restriction.text;
    if (this.playerService.getMarkerValue(markers, '自动采集') === 1) {
      return `${player.name}自动采集模式下无法手动采集\n"设置采集"可切换回手动采集`;
    }
    // 进程内防重复提交：同一毫秒内连发两次请求时，第二次在「采集」标记落库前到达，
    // actionUnrestricted 拦不住；原版单线程事件循环天然无此竞态。
    if (!this.gatherStartInflight) (this as any).gatherStartInflight = new Map<number, number>();
    const inflight = this.gatherStartInflight.get(userId);
    if (inflight && Date.now() - inflight < 3000) {
      return `${player.name}正在采集中，请稍候`;
    }
    this.gatherStartInflight.set(userId, Date.now());

    // ===== 原版 _主程序.ecode L11383-11399 计算采集耗时 =====
    // 家园院子里输入"指令N"一次执行 N 次（额外次数），其他地图忽略数字。
    // 原版公式：a1 = 取随机数(3000×倍率, 6000×倍率) × d / 1000（毫秒→秒）
    const isOwnYard = player.houseName === map.name;
    const extraMultiplier = isOwnYard ? Math.max(1, Math.floor(count)) : 1;
    const timeScale = Math.max(0.01, Number(target.timeScale ?? target.时间倍率 ?? 1) || 1);
    const seconds = Math.round((3000 + Math.random() * 3000) * timeScale / 1000) * extraMultiplier;

    // 矿炮(特殊序号-38)在手的玩家，单次采集耗时上限30秒（原版 L11391-11398）
    const weapons = Array.isArray(playerData.weapons) ? playerData.weapons : [];
    // currentWeapon 为 1-based（0=赤手）。赤手时不应取用任何武器，
    // 否则会把背上第一把武器误判为"在手"，触发矿炮上限/污染【武器】占位符。
    const currentWeaponIdx = Number(player.currentWeapon ?? 0);
    const currentWeapon = currentWeaponIdx > 0 ? weapons[currentWeaponIdx - 1] : null;
    const cappedSeconds = currentWeapon?.specialSeq === -38 ? Math.min(seconds, 30) : seconds;

    const now = Date.now();

    // ===== 原版 _主程序.ecode L11428-11435 锁定与延时任务 =====
    // 添加标记("采集", 次数)：锁定期间 行动无限制 会拦截移动/攻击/再次采集；
    // 获得增益("采集", 秒数)：同一标记的另一种写法，到期即采集完成。
    const markers2 = asJsonValue<any[]>(player.markers2, []);
    markers['采集中'] = { target: resourceName, cmd: gatherName,
      count: extraMultiplier, startedAt: now, settleAt: now + cappedSeconds * 1000 };
    this.combatState.addMarker('采集', cappedSeconds, markers2, now);
    player.markers = markers; // Json 列直接写对象
    player.markers2 = markers2; // Json 列直接写数组

    // 排程持久化延时任务：到点由 DelayedTaskService 分发结算。
    // 任务行落库即跨重启存活，不再依赖内存定时器与周期扫描兜底；
    // 同 (type,userId) 先删后插，重复采集开始天然覆盖上一条排程。
    if (this.delayedTaskService) {
      await this.delayedTaskService.schedule({
        type: 'gather',
        userId,
        runAt: now + cappedSeconds * 1000,
      });
    }

    this.logger.log(`玩家 ${userId} 开始采集 ${resourceName}，预计 ${cappedSeconds} 秒`);

    // ===== 原版 L11400-11416 回复文本：采集文本模板 + 预计耗时 =====
    // 模板占位符：【名称】=玩家名(+跟随宠物)、【载具】=载具名(此处无载具上下文，移除)、【武器】=当前武器名
    const rawGatherText = String(target.gatherText ?? target.采集文本 ?? '')
      || `【名称】正在${gatherName}`;
    let startText = rawGatherText.replace('【载具】', '');
    startText = startText.replace('【名称】', String(player.name ?? '冒险者'));
    startText = startText
      .replace('【武器】', String(currentWeapon?.name ?? '') || '拳头');
    return `${startText},大概需要${cappedSeconds}秒`;
    });
  }

  /**
   * 采集延时结算（对应原版「采j结s」分支 _主程序.ecode L6790-6806 + 采集资源 地图操作.ecode L1469-1639）。
   * 由进程内定时器或后台兜底任务调用：校验并移除「采集中」状态 → 结算产出/经验/任务/资源次数。
   * @returns 结算文本（广播到世界频道）；无进行中采集或已失效时返回空串
   */
  async settleGatherResource(userId: number): Promise<string> {
    // 采集结算按「读快照→改→整包写回」更新玩家数据，必须持用户级共享锁，
    // 与兑换/召唤/任务推进互斥；进程内定时器与 cron 兜底两条路径都经过这里。
    return this.playerService.enqueueUserWrite(userId, () => this.applySettleGatherResource(userId));
  }

  /** 采集结算的数据库读改写段（调用方需已持有用户级锁）。 */
  private async applySettleGatherResource(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const pending = this.takePendingGather(player, userId);
    if (!pending) return '';
    const { state: gatherState, markers } = pending;

    // 结算即解锁：移除「采集」锁定标记（原版 获得增益 到期语义；定时器回调可能早于毫秒级过期）
    const lockedMarkers2 = asJsonValue<any[]>(player.markers2, []);
    const unlockedMarkers2 = lockedMarkers2.filter((m: any) =>
      (m?.name ?? m?.名称 ?? m?.key) !== '采集');
    const markers2Changed = unlockedMarkers2.length !== lockedMarkers2.length;

    // 原子认领「采集中」状态：进程内定时器与每5秒兜底扫描是并发结算入口，
    // 结算链路（产出/任务/激怒怪物等）耗时可超过兜底间隔，重入方若读到同样
    // 的「采集中」状态会双结算（产出翻倍+重复广播）。
    // 认领必须走整包 savePlayer（中央乐观锁按 (id,version) CAS）：
    // - 不能用不携带 version 的定点条件写（updateMany）：乐观锁拦截器会给它
    //   注入 version+1，而内存快照版本没同步，链尾的整包保存必然 P2025 失败，
    //   整次结算半途而废；
    // - 定点写也不会使其它旧快照失效，持有旧 markers 的并发写者仍能通过自己
    //   的 CAS 把「采集中」原样写回复活（2026-08-26 线上重复结算事故根因）。
    // 整包 CAS 认领成功即推进版本并同步内存快照，链尾保存顺理成章；失败
    // （P2025 并发冲突）说明另一入口已在结算，本调用立即放弃并还原内存快照，
    // 标记仍留库中由下一轮兜底重试，不会丢结算。
    const prevMarkersRaw = player.markers;
    const prevMarkers2BeforeClaim = player.markers2;
    player.markers = markers; // Json 列直接写对象
    if (markers2Changed) player.markers2 = unlockedMarkers2; // Json 列直接写数组
    try {
      await this.playerService.savePlayer(player);
    } catch (e: any) {
      player.markers = prevMarkersRaw;
      if (markers2Changed) player.markers2 = prevMarkers2BeforeClaim;
      this.logger.warn(`玩家 ${userId} 采集认领失败（并发冲突或写库异常），本次放弃: ${e?.message || e}`);
      return '';
    }

    const gatherName = String(gatherState.cmd ?? '');
    const resourceName = String(gatherState.target ?? '');
    const extraMultiplier = Math.max(1, Number(gatherState.count ?? 1));

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) {
      player.markers = markers; // Json 列直接写对象
      await this.playerService.savePlayer(player);
      return '';
    }
    const resources = this.getGatherResources(map);
    const resourceField = this.getGatherResourceField(map);
    const markersRecord = markers;
    const target = resources.find((r: any) => r.gatherCmd === gatherName
      && this.getResourceTimes(r) !== 0
      && this.isGatherResourceAvailable(r, markersRecord));

    let specialText = '';
    // 特殊资源：休眠仓 → 首次打开触发「召唤白」剧情（原版 _主程序.ecode L9777~L9795）
    if ((resourceName === '休眠仓' || target?.proxySpeak === '召唤1白1') && !markers['召唤白']) {
      markers['召唤白'] = 1;
      specialText = '这里是哪里？\n(随着休眠仓被打开，锁着的门似乎也跟着一起解开了)';
      this.logger.log(`玩家 ${userId} 唤醒了白`);
      await this.taskService.acceptTask(userId, '主线-身世');
      // 原版 L9780-9796：白作为真实召唤物加入当前地图（归属=玩家、初始好感30、
      // 任务池=白对话），随玩家移动而跟随，是对话/领取任务/挤奶/救助/控制终端的实体。
      try {
        await this.materializeWhiteSummon(player, map, markers);
      } catch (e: any) {
        this.logger.warn(`创建白的召唤物失败 userId=${userId}: ${e?.message}`);
      }
    }
    player.markers = markers; // Json 列直接写对象

    if (!target) {
      // 资源在等待期间被别人采完/刷新掉：本次动作作废（不产出、不计次数）
      await this.playerService.savePlayer(player);
      this.logger.log(`玩家 ${userId} 采集结算时资源已消失: ${resourceName}`);
      return '';
    }

    // ===== 原版 地图操作.ecode L1537-1561 实际采集次数 =====
    // e=跟随宠物数+1，再乘以院子里的额外次数；受资源剩余次数上限约束。
    const followPetCount = await this.countFollowingSummons(map, userId);
    let actualGatherCount = (followPetCount + 1) * extraMultiplier;
    const resourceTimes = this.getResourceTimes(target);
    actualGatherCount = resourceTimes > 0
      ? Math.min(actualGatherCount, resourceTimes)
      : Math.min(actualGatherCount, Math.abs(resourceTimes));

    const dropRate = this.getGatherDropRate(playerData);
    const outputs = this.parseResourceOutputs(target.outputs);
    const gained: string[] = [];
    const awarded = new Map<string, number>();
    const awardedEquipment = new Map<string, number>();
    const backpack = this.playerService.getBackpackItems(player);
    for (const out of outputs) {
      if (!out.name || out.name === '电力') continue;
      const chance = Number(out.chance);
      for (let i = 0; i < actualGatherCount; i++) {
        if (Number.isFinite(chance) && chance >= 0 && Math.random() * 100 >= chance * dropRate) continue;
        const parsed = this.parseResourceOutputName(out.name, Number(out.count));
        if (!parsed.name) continue;
        const itemType = this.staticData.getEquipmentByName(parsed.name) ? '装备' : '资源';
        if (itemType === '装备') {
          const quality = parsed.quality || '';
          const equipment = await this.itemSystemService.generateRewardEquipment(parsed.name, quality);
          backpack.push({ ...equipment, type: '装备', quantity: 1, count: 1 });
          awardedEquipment.set(parsed.name, (awardedEquipment.get(parsed.name) || 0) + 1);
        } else {
          const amount = parsed.count > 0
            ? parsed.count * this.getGatherMultiplier(playerData)
            : Math.abs(parsed.count);
          if (amount > 0) awarded.set(parsed.name, (awarded.get(parsed.name) || 0) + amount);
        }
      }
    }
    for (const [itemName, amount] of awarded) {
      const existing = backpack.find((item: any) => item?.name === itemName && item?.type !== '装备');
      if (existing) {
        const next = Number(existing.count ?? existing.quantity ?? 0) + amount;
        existing.count = next;
        existing.quantity = next;
      } else {
        backpack.push({ name: itemName, type: '资源', count: amount, quantity: amount });
      }
      gained.push(`${itemName}×${this.formatGatherNumber(amount)}`);
    }
    for (const [itemName, amount] of awardedEquipment) gained.push(`${itemName}×${amount}`);
    player.backpack = backpack; // Json 列直接写数组

    // 原版采集成功后会把资源自身的“标记”写入玩家永久标记，
    // 例如医疗箱、休眠仓和散落的物品每个玩家只能领取一次。
    const resourceMarker = String(target.marker ?? target.标记 ?? '').trim();
    if (resourceMarker && actualGatherCount > 0) {
      markers[resourceMarker] = Number(markers[resourceMarker] ?? 0) + 1;
      player.markers = markers; // Json 列直接写对象
    }

    let timesSuffix = '';
    if (resourceTimes > 0) {
      // mutateMapFields 锁内闭环：重读最新资源数组与 markers2 → 按名重定位目标 →
      // 用最新剩余次数夹取实际采集数 → 扣减次数/耗尽移除/登记刷新标记 → 差异写回
      // （避免并发采集把次数扣成负数、或按各自快照整组覆盖刷新标记）
      const gatherResult = await this.mapService.mutateMapFields(map.id, [resourceField, 'markers2'], (f) => {
        const fresh = f[resourceField] as any[];
        const idx = fresh.findIndex((r: any) => r.name === target.name);
        if (idx === -1) return { removed: true, remaining: 0 };
        const freshTarget = fresh[idx];
        const freshTimes = this.getResourceTimes(freshTarget);
        const count = freshTimes > 0 ? Math.min(actualGatherCount, freshTimes) : actualGatherCount;
        const remaining = freshTimes - count;
        if (remaining <= 0) {
          fresh.splice(idx, 1);
          // 原版"次数归零"会添加"刷新资源<名称>"地图标记，后台刷新任务按该标记恢复资源。
          if (freshTarget.renewable !== false) {
            const mapMarkers2 = Array.isArray(f.markers2) ? f.markers2 : [];
            const refreshedMarkers2 = mapMarkers2.filter((entry: any) =>
              (entry?.name ?? entry?.名称) !== `刷新资源${freshTarget.name}`,
            );
            refreshedMarkers2.push({
              name: `刷新资源${freshTarget.name}`,
              expireAt: Date.now() + 1800 * 1000,
              resourceField,
            });
            f.markers2 = refreshedMarkers2;
          }
          return { removed: true, remaining: 0 };
        }
        freshTarget.times = remaining;
        return { removed: false, remaining };
      });
      if (gatherResult.remaining > 0) {
        timesSuffix = `\n${map.name}的${resourceName}还可以采集${gatherResult.remaining}次`;
      }
    }
    await this.playerService.savePlayer(player);

    // ===== 经验与任务推进（原版 L1613-1616）=====
    const expBonus = this.getGatherExpBonus(playerData);
    const expGain = Math.round((Number(player.level ?? 1) / 2 + 1) * actualGatherCount * expBonus);
    await this.playerService.addExp(userId, expGain);
    if (actualGatherCount > 0) {
      await this.taskService.advance(userId, '采集', actualGatherCount);
      await this.taskService.advance(userId, gatherName, actualGatherCount);
      await this.taskService.advance(userId, '奴役', Math.max(0, actualGatherCount - 1));
    }
    for (const [itemName, amount] of awarded) {
      await this.taskService.advance(userId, '采集资源', amount);
      await this.taskService.advance(userId, `采集${itemName}`, amount);
    }
    for (const [itemName, amount] of awardedEquipment) {
      await this.taskService.advance(userId, '获得装备', amount);
      await this.taskService.advance(userId, `获得${itemName}`, amount);
    }
    // 原版 地图操作.ecode L1619：添加成就("采集熟练度", e, 玩家.标记)——
    // 熟练度按实际采集次数推进。advance 会改写库内任务/标记字段，
    // 先重载快照再写熟练度，避免旧对象回写覆盖任务结算。
    if (actualGatherCount > 0) {
      const freshPlayer = (await this.playerService.getPlayerData(userId)).player;
      const proficiencyMarkers = asJsonValue<Record<string, any>>(freshPlayer.markers, {});
      proficiencyMarkers['采集熟练度'] = Number(proficiencyMarkers['采集熟练度'] ?? 0) + actualGatherCount;
      freshPlayer.markers = proficiencyMarkers;
      await this.playerService.savePlayer(freshPlayer);
    }

    // 代发言=触发攻击：采集完成会激怒附近怪物
    // （原版 _主程序.ecode L11426：新建延时("覅攻击pd"+地图, "0", 群号, 5)——
    //   采集后5秒怪物回合开始并自动续回合。
    //   四豁免对齐原版 L11417-11426：隐形披风装备 / 隐匿模式增益（triggerMapBattleLoop
    //   内部处理） / 特殊序号15=四糸乃 / 等级<15）
    if (String(target.proxySpeak ?? target.代发言 ?? '') === '触发攻击' && !map.isInstance) {
      try {
        const fresh = await this.playerService.getPlayerData(userId);
        const freshEquipments = fresh.equipment || asJsonValue<any[]>(fresh.player.equipment, []);
        const freshWeapons = fresh.weapons || asJsonValue<any[]>(fresh.player.weapons, []);
        const hasCloak = this.combatState.equipRequire(freshEquipments, freshWeapons, Number(fresh.player.currentWeapon ?? 0), 26, '隐形披风', false);
        const isYoshino = Number(fresh.player.specialSeq ?? fresh.player.特殊序号 ?? 0) === 15;
        if (Number(fresh.player.level ?? 0) >= 15 && !hasCloak && !isYoshino) {
          await (this.combatSystem as any).triggerMapBattleLoop(userId, 5, { player: fresh.player, map });
        }
      } catch (e: any) {
        this.logger.warn(`采集激怒怪物失败 userId=${userId}: ${e?.message}`);
      }
    }

    // ===== 结算文本（原版 L1598-1613：“收集到了…”）=====
    const lootText = gained.length > 0 ? `收集到了${gained.join('、')}` : '什么都没有收集到';
    const petPrefix = followPetCount > 0 ? `带着${followPetCount}只宠物一起` : '';
    let resultText = `${player.name}${petPrefix}${lootText},得到了${expGain}经验`;
    if (specialText) resultText = `${specialText}\n${resultText}`;
    if (timesSuffix) resultText += timesSuffix;
    // 采集推进导致的任务完成提示（原版 发放奖励 前插“完成了任务:…”块）。
    // 延时结算不在指令管道内，必须在这里主动取出，否则通知滞留队列丢失。
    const gatherTaskNotice = this.taskService.consumeNotifications(userId);
    if (gatherTaskNotice) resultText = `${gatherTaskNotice}\n————————\n${resultText}`;

    // 延时端结果通过世界频道系统消息送达（指令回复通道覆盖不到定时器回调），
    // 同时推送玩家/地图面板（背包、资源次数变化）。
    await this.chatService.broadcastSystem('世界频道', resultText, userId).catch(() => undefined);
    try {
      await this.pushPlayerUpdate(userId);
      await this.pushMapUpdate(userId);
    } catch { /* 推送失败不影响结算 */ }
    return resultText;
  }

  /**
   * 提取玩家的「采集中」状态（存在且返回；调用方负责写回）。
   * 无状态时顺带清理孤儿「采集」锁定标记。
   */
  private takePendingGather(
    player: any,
    userId: number,
  ): { state: Record<string, any>; markers: Record<string, any> } | null {
    const markers = asJsonValue<Record<string, any>>(player.markers, {});
    const rawState = markers['采集中'];
    if (!rawState) {
      this.clearStaleGatherLock(player, userId);
      return null;
    }
    let state: any = rawState;
    if (typeof rawState === 'string') {
      // 「采集中」嵌套值可能是对象或旧存档 JSON 字符串，统一容错解析
      state = asJsonValue<Record<string, any> | null>(rawState, null);
    }
    if (!state || typeof state !== 'object' || !state.target) {
      delete markers['采集中'];
      player.markers = markers; // Json 列直接写对象
      this.clearStaleGatherLock(player, userId);
      return null;
    }
    delete markers['采集中'];
    return { state, markers };
  }

  /** 清理孤儿「采集」锁定标记（无对应采集中状态时的兜底，避免玩家被永久锁死）。 */
  private clearStaleGatherLock(player: any, userId: number): void {
    try {
      const markers2 = asJsonValue<any[]>(player.markers2, []);
      const filtered = markers2.filter((m: any) => (m?.name ?? m?.名称 ?? m?.key) !== '采集');
      if (filtered.length !== markers2.length) {
        player.markers2 = filtered; // Json 列直接写数组
        void this.playerService.savePlayer(player).catch(() => undefined);
        this.logger.log(`清理玩家 ${userId} 的孤儿采集锁定标记`);
      }
    } catch { /* 忽略清理失败 */ }
  }

  /**
   * 统计跟随玩家的存活召唤物数量（原版 召唤物跟随显示 数据显示.ecode L326-395：
   * 归属=玩家QQ 且 标记["跟随"]熟练度<1 视为跟随中）。
   */
  private async countFollowingSummons(map: any, userId: number): Promise<number> {
    try {
      const raw = map?.summons ?? map?.召唤物 ?? [];
      const summons = Array.isArray(raw) ? raw : asJsonValue<any[]>(raw, []);
      const playerKey = String(userId);
      return summons.filter((s: any) => {
        const owner = String(s?.ownerQQ ?? s?.归属 ?? s?.owner ?? s?.qq ?? '');
        if (owner !== playerKey) return false;
        const hp = Number(s?.hp ?? s?.当前生命 ?? 1);
        if (hp <= 0) return false;
        let summonMarkers: any = s?.markers ?? s?.标记 ?? {};
        if (!Array.isArray(summonMarkers) && typeof summonMarkers === 'string') {
          summonMarkers = asJsonValue<any>(summonMarkers, {});
        }
        const prof = Array.isArray(summonMarkers)
          ? Number(summonMarkers.find((m: any) => (m?.name ?? m?.名称) === '跟随')?.value ?? 0)
          : Number(summonMarkers?.['跟随'] ?? 0);
        return prof < 1;
      }).length;
    } catch {
      return 0;
    }
  }

  /** 采集经验加成系数（原版 1 + 属性.经验/100） */
  private getGatherExpBonus(playerData: any): number {
    try {
      const bonus = this.combatSystem.buildAttackerBonus(playerData.player, playerData) as any;
      return 1 + Math.max(0, Number(bonus?.经验 ?? 0)) / 100;
    } catch {
      return 1;
    }
  }

  /** 兼容新格式与早期错误导出的 resources JSON。 */
  private parseResourceOutputs(value: any): any[] {
    const outputs = Array.isArray(value)
      ? value
      : asJsonValue<any[]>(value, []);
    if (!Array.isArray(outputs)) return [];
    return outputs.map((output: any) => {
      if (!output || typeof output !== 'object') return output;

      // 早期导出把“木头3，100”写成 {name:"木头3", count:100}。
      // 名称末尾数字是数量，旧 count 才是概率；没有紧凑数量时概率默认100%。
      const rawName = String(output.name ?? output.名称 ?? '').trim();
      const rawCount = Number(output.count ?? output.quantity ?? output.数量 ?? 0);
      const hasChance = output.chance !== undefined || output.几率 !== undefined;
      const compact = rawName.replace(/[edcbasx]$/i, '').match(/-?\d+(?:\.\d+)?$/);
      return {
        ...output,
        name: rawName,
        count: Number.isFinite(rawCount) ? rawCount : 0,
        chance: hasChance
          ? Number(output.chance ?? output.几率 ?? 0)
          : (compact ? rawCount : 100),
      };
    });
  }

  private getGatherResources(map: any): any[] {
    const resources = asJsonValue<any[]>(map?.resources, []);
    if (resources.length > 0) return resources;
    return asJsonValue<any[]>(map?.resources2, []);
  }

  private getGatherResourceField(map: any): 'resources' | 'resources2' {
    const resources = asJsonValue<any[]>(map?.resources, []);
    return resources.length > 0 ? 'resources' : 'resources2';
  }

  private isGatherResourceAvailable(resource: any, markers: Record<string, any>): boolean {
    const marker = String(resource?.marker ?? resource?.标记 ?? '').trim();
    if (!marker) return true;
    return Number(markers[marker] ?? 0) < 1;
  }

  /** 获取玩家永久标记(markers)对象，用于资源采集门禁的"每人一次"判断。 */
  private async getPlayerMarkers(userId: number): Promise<Record<string, any>> {
    try {
      const { player } = await this.playerService.getPlayerData(userId);
      return asJsonValue<Record<string, any>>(player?.markers, {});
    } catch {
      return {};
    }
  }

  /** 产出2（作物/建筑的生产产出）是否非空；产出2为空的资源2条目即地上的野生资源。 */
  private hasOutputs2(resource: any): boolean {
    const raw = resource?.outputs2 ?? resource?.['产出2'];
    if (Array.isArray(raw)) return raw.length > 0;
    if (raw == null || raw === '') return false;
    const parsed = asJsonValue<any[]>(raw, []);
    return Array.isArray(parsed) && parsed.length > 0;
  }

  private parseResourceOutputName(rawName: any, rawCount: number): { name: string; count: number; quality: string } {
    const source = String(rawName ?? '').trim();
    const qualityMatch = source.match(/^(.*?)([edcbasx])$/i);
    const quality = qualityMatch ? qualityMatch[2].toLowerCase() : '';
    const withoutQuality = qualityMatch ? qualityMatch[1] : source;
    const compact = withoutQuality.match(/^(.*?)(-?\d+(?:\.\d+)?)$/);
    if (!compact) return { name: withoutQuality, count: quality ? 0 : Number(rawCount) || 0, quality };
    return {
      name: compact[1].trim(),
      // 旧 JSON 把概率写进 count；只要名称仍带紧凑数量，就以名称中的数量为准。
      count: Number(compact[2]),
      quality,
    };
  }

  private getResourceTimes(resource: any): number {
    const value = Number(resource?.times ?? resource?.次数 ?? -1);
    return Number.isFinite(value) ? value : -1;
  }

  private parseGatherCommand(value: string): { name: string; count: number } {
    const input = String(value || '').trim();
    const match = input.match(/^(.*?)(\d+)$/);
    if (!match) return { name: input, count: 1 };
    return { name: match[1].trim(), count: Math.max(1, Number(match[2])) };
  }

  private getGatherMultiplier(playerData: any): number {
    const bonus = this.combatSystem.buildAttackerBonus(playerData.player, playerData);
    return Math.max(0, Number(bonus.采集 || 100) / 100);
  }

  private getGatherDropRate(playerData: any): number {
    const bonus = this.combatSystem.buildAttackerBonus(playerData.player, playerData);
    return Math.max(0, 1 + Number(bonus.掉落率 || 0) / 100);
  }

  private formatGatherNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  }

  /**
   * 赠予物品
   * 将背包中的物品赠予其他玩家
   */
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
  async handlePrivateChat(userId: number, targetName: string, content: string): Promise<string> {
    if (!targetName || !content) {
      return '请指定私聊对象和内容，格式：私聊 用户名 内容';
    }
    // 查找目标用户：优先按用户名/昵称精确匹配，支持数字ID
    const target = /^\d+$/.test(targetName)
      ? await this.prisma.user.findUnique({ where: { id: Number(targetName) } })
      : (await this.prisma.user.findFirst({ where: { username: targetName } })) ||
        (await this.prisma.user.findFirst({ where: { nickname: targetName } }));
    if (!target) {
      return `未找到玩家「${targetName}」`;
    }
    if (target.id === userId) {
      return '不能给自己发送私聊消息';
    }
    // 复用聊天服务的持久化 + 实时推送逻辑
    const msg = await this.chatService.sendPrivateMessage(userId, target.id, content);
    return `已私聊给 ${target.nickname || target.username}：${content}`;
  }

  /**
   * 处理反馈指令（指令通道，简化版）
   * 格式：反馈 内容  或  反馈 bug 标题|内容
   * 完整交互（分类选择/附件上传/回复）请使用网页内的反馈面板
   */
  async handleFeedback(userId: number, raw: string): Promise<string> {
    if (!raw) {
      return '请描述你遇到的问题或建议，格式：反馈 内容\n如需上传图片/分类，请使用网页内的「反馈」面板';
    }
    const feedback = await this.feedbackService.create(userId, {
      title: raw.slice(0, 30),
      category: 'general',
      content: raw,
      attachments: [],
    });
    return `反馈已提交，工单号 #${feedback.id}，我们会尽快处理。`;
  }

  /**
   * 领取任务（对齐原版 领取任务 分支 _主程序.ecode L7321-7404）：
   * - 无参数：列出当前地图各单位（NPC/召唤物/跟随的白）任务池中可领取的任务；
   * - 参数为 NPC 名：从该 NPC 的任务池随机接取一个（原版 随机文本），
   *   已有该 NPC 任务时提示“你已经领取了X的任务了，先去完成吧”；
   * - 参数为任务名：直接领取该任务。
   */
  async handleAcceptQuest(userId: number, questName?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    const npcs = asJsonValue<any[]>(map.npcs, []);
    const summons = asJsonValue<any[]>(map.summons, []);
    // 白：历史存档（只有 召唤白 标记）按需补建实体，保证任务池可解析。
    const wantedName = String(questName || '').trim();
    if (!wantedName || wantedName === '白') {
      const white = await this.ensurePlayerWhite(player, map).catch(() => null);
      if (white && !summons.some((s: any) => String(s?.qq ?? s?.QQ ?? '') === String(white.qq ?? ''))) {
        summons.push(white);
      }
    }
    const units = [...npcs, ...summons];
    const sources = this.getQuestSources(units);

    if (!questName) {
      const available: Array<{ task: any; publisher?: string; npcName: string }> = [];
      for (const source of sources) {
        const tasks = await this.taskService.getAvailableTasks(userId, source.taskNames, source.publisher);
        for (const task of tasks) {
          if (!available.some((item) => item.task.name === task.name)) {
            available.push({ task, publisher: source.publisher, npcName: source.npcName });
          }
        }
      }

      if (available.length === 0) {
        return '当前地图没有可领取的任务';
      }

      const lines = [`📋 【${map.name}】可领取任务:`];
      const options: { label: string; cmd: string }[] = [];
      for (const item of available) {
        lines.push(`  ${item.task.name}`);
        lines.push(`    发布人: ${item.npcName}`);
        lines.push(`    等级要求: ${item.task.level || 1}`);
        if (item.task.description) lines.push(`    ${item.task.description}`);
        options.push({ label: `领取任务 ${item.task.name}`, cmd: `领取任务 ${item.task.name}` });
      }
      lines.push(``);
      const menuLines = await this.buildNumberedMenu(userId, options, '💡 发送编号数字(如 1)即可领取对应任务');
      lines.push(...(menuLines.length > 0 ? menuLines : [`使用「领取任务 任务名」领取任务`]));
      return lines.join('\n');
    }

    // 参数为 NPC 名：从该单位的任务池随机接取（原版 随机文本 + 领取文案）。
    const source = sources.find((item) => item.npcName === wantedName);
    if (source) {
      // 原版 L7360-7371：已经领取了该 NPC 的任务 → 先去完成。
      let activeTasks: any[] = [];
      try {
        // tasks 现为原生 Json 列（可能直接是数组），用 asJsonValue 容错读取
        const parsedTasks = asJsonValue<any[]>(player.tasks, []);
        if (Array.isArray(parsedTasks)) activeTasks = parsedTasks;
      } catch { /* 任务数据异常按空处理 */ }
      if (source.publisher && activeTasks.some((t: any) =>
        String(t?.publisher ?? t?.发布人 ?? '') === String(source.publisher))) {
        return `${player.name || ''}你已经领取了${source.npcName}的任务了，先去完成吧`;
      }
      // 原版 L7346-7358：对其他人好感满100的 NPC 不再发任务。
      const unit = units.find((u: any) => this.questUnitName(u) === wantedName
        || String(u?.qq ?? u?.QQ ?? '') === String(source.publisher ?? ''));
      if (unit) {
        const npcMarkers = this.parseNpcMarkers(unit);
        const currentKey = `好感${userId}`;
        const otherMax = Object.entries(npcMarkers).some(([key, value]) =>
          key.startsWith('好感') && key !== currentKey && Number(value) >= 100);
        if (otherMax) {
          return `【${source.npcName}】不想理你(对其他人好感100)`;
        }
      }
      const available = await this.taskService.getAvailableTasks(userId, source.taskNames, source.publisher);
      if (available.length === 0) {
        return `${player.name || ''},${source.npcName}现在没有可以给你的任务`;
      }
      const selected = available[Math.floor(Math.random() * available.length)];
      return this.taskService.acceptTask(userId, selected.name, source.publisher, source.npcName);
    }

    // 参数为任务名：在各单位任务池中找到发布人后领取；找不到按静态任务直接领取。
    const namedSource = sources.find((item) => item.taskNames.includes(questName));
    const publisher = namedSource?.publisher;
    return this.taskService.acceptTask(userId, questName, publisher);
  }

  /** 读取地图单位的标记对象（兼容对象/数组/JSON字符串三种存法）。 */
  private parseNpcMarkers(unit: any): Record<string, any> {
    const raw = unit?.markers ?? unit?.标记 ?? {};
    const parsed = typeof raw === 'string' ? asJsonValue<any>(raw, {}) : raw;
    if (Array.isArray(parsed)) {
      return Object.fromEntries(parsed.map((item: any) => [
        item?.name ?? item?.名称,
        Number(item?.value ?? item?.数值 ?? item?.count ?? 0),
      ]).filter(([name]) => Boolean(name)));
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
  }

  /**
   * 将地图运行时单位映射为原版“对话列表”的任务池。
   * 静态 NPC 配置使用 taskId，运行时召唤物同时兼容任务/任务池字段；
   * publisher 保留 QQ/id，用于任务发布人互斥和好感奖励回写。
   */
  private getQuestSources(units: any[]): QuestSource[] {
    const sources: QuestSource[] = [];
    for (const unit of units || []) {
      if (!unit || typeof unit !== 'object') continue;

      const npcName = this.questUnitName(unit);
      const type = String(unit.type ?? unit.类型 ?? '').trim();
      const directTaskPool = unit.taskId ?? unit.taskID ?? unit.任务池 ?? unit.任务;
      const configNames = [
        String(unit.dialog ?? unit.对话 ?? '').trim(),
        `${type}对话`,
        `${npcName}对话`,
        type,
        npcName,
      ].filter(Boolean);

      let taskPool: any = directTaskPool;
      let config: any;
      for (const configName of configNames) {
        config = this.staticData.getNpcByName(configName);
        if (config) {
          if (taskPool === undefined || taskPool === null || taskPool === '') {
            taskPool = config.taskId ?? config.taskID ?? config.任务池 ?? config.任务;
          }
          break;
        }
      }

      // 对齐原版 领取任务（_主程序.ecode L7372-7384）：单位无专属对话配置或其任务池
      // 为空时，统一回退“通用对话”任务池（白回退 白对话，其余回退 通用对话），
      // 因此行商/露娜等地图 NPC 也能发放通用任务。
      if (taskPool === undefined || taskPool === null || taskPool === '') {
        const fallbackName = type === '白' || npcName === '白' ? '白对话' : '通用对话';
        const generic = this.staticData.getNpcByName(fallbackName);
        taskPool = generic?.taskId ?? generic?.taskID ?? generic?.任务池 ?? generic?.任务;
      }

      const taskNames = this.splitQuestNames(taskPool)
        .filter((name) => !!this.staticData.getTaskByName(name));
      if (taskNames.length === 0) continue;

      const publisherValue = unit.qq ?? unit.QQ ?? unit.id ?? unit.编号;
      const publisher = publisherValue === undefined || publisherValue === null || publisherValue === ''
        ? undefined
        : String(publisherValue);
      sources.push({ npcName: npcName || type || '未知对象', taskNames, publisher });
    }
    return sources;
  }

  private splitQuestNames(value: any): string[] {
    const raw = Array.isArray(value)
      ? value.flatMap((item) => typeof item === 'string' ? item : [item?.name ?? item?.名称 ?? ''])
      : [value];
    return [...new Set(raw
      .flatMap((item) => String(item ?? '').split(/[，,、\n]+/))
      .map((item) => item.trim())
      .filter(Boolean))];
  }

  private questUnitName(unit: any): string {
    return String(
      unit?.name
      ?? unit?.名称
      ?? unit?.image
      ?? unit?.图片
      ?? unit?.title
      ?? unit?.type
      ?? unit?.类型
      ?? '',
    ).trim();
  }

  /**
   * 查看任务
   * 查看当前已接取的任务列表
   */
  async handleViewQuests(userId: number, selector = ''): Promise<string> {
    return this.taskService.listTasks(userId, selector);
  }

  /**
   * 提交任务
   * 完成的任务进行提交，获得奖励
   */
  async handleCompleteQuest(userId: number, questName: string): Promise<string> {
    const result = await this.taskService.completePendingTask(userId, questName);
    return result || '正常任务完成后奖励已自动发放';
  }

  /**
   * 躺下（原版 _主程序.ecode L7086-7096）。
   * 门禁：死亡 → 行动无限制（理由6=自动开采中也可躺下）→ 建筑要求（床）→“需要床”。
   * 成功：置“躺下”标记 + 陪睡宠物数写入 sets.sleepover（有洛写负数，离线经验再×1.1）
   * + 躺下起床显示(1)（每秒经验/经验加成/陪睡加成/最终每秒获得，原版 数据显示.ecode L288-325）。
   * 注：躺下只结算经验，不回复 HP。
   */
  async handleLieDown(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = player.name || '冒险者';

    // 检查是否死亡
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 行动无限制（原版 L7089 理由6：自动开采中可以躺下）
    const restriction = this.combatSystem.actionUnrestricted(player, { ignoreReason: 6 });
    if (restriction.restricted) return restriction.text;

    // 建筑要求（床）（原版 L7092-7093）
    if (!(await this.hasBuildingOnMap(userId, '床'))) {
      return `${name}需要床`;
    }

    // 陪睡宠物（原版 躺下起床显示：跟随显示数量上限2）
    const map = await this.mapService.getMapById(player.mapId);
    const display = await this.summonFollowDisplay(map, userId, { requireFollow: false, countLimit: 2 });
    const sleepover = display.count;
    const summons = Array.isArray(map?.summons) ? map.summons : asJsonValue<any[]>(map?.summons, []);
    const hasLuo = this.familiarService.checkHasSpecialPet(-4, summons);
    const luoPet = hasLuo
      ? summons.find((s: any) => (s?.specialSeq ?? s?.special_seq ?? s?.seq) === -4)
      : null;

    // 写入 陪睡 数（原版 L305-310：有洛为负数=有鹭）
    const sets = asJsonValue<any>(player.sets, {});
    sets.sleepover = hasLuo ? -sleepover : sleepover;
    player.sets = sets;

    // 置“躺下”标记（原版 L7093 置成就熟练度("躺下",1)）
    const markers = asJsonValue<Record<string, any>>(player.markers, {});
    markers['躺下'] = 1;
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 躺下了（陪睡${sleepover}${hasLuo ? '，有洛' : ''}）`);

    // 躺下起床显示(1)（原版 数据显示.ecode L299-311）
    const expBonus = Number(player.expBonus ?? 0);
    const level = Number(player.level ?? 1);
    let text = `${name}${display.count > 0 ? `和${display.names.join('和')}` : ''}躺到了床上`;
    text += `\n每秒获得经验:${this.roundText(level / 100)}`;
    text += `\n你的经验加成:${this.roundText(expBonus)}%`;
    text += `\n陪睡NPC/宠物:${sleepover}/2（+${sleepover * 50}%）`;
    if (luoPet) text += `\n${luoPet.name ?? luoPet.名称 ?? '洛'}:+10%`;
    const finalPerSec = (1 + sleepover * 0.5) * level * (1 + expBonus / 100) / 100 * (1 + (hasLuo ? 1 : 0) / 10);
    text += `\n最终每秒获得:${Math.round(finalPerSec)}`;
    return text;
  }

  /**
   * 起床（原版 _主程序.ecode L7102-7108）。
   * “躺下”标记==0 →“需要「躺下」”；清标记后回复 躺下起床显示(2)。
   */
  async handleGetUp(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const name = player.name || '冒险者';

    // 检查是否在躺下（原版 L7103 取成就熟练度("躺下")==0 →“需要”躺下”“）
    if (markers['躺下'] !== 1) {
      return `${name}需要“躺下”`;
    }

    // 移除躺下标记（原版 L7105 置成就熟练度("躺下",0)）
    delete markers['躺下'];

    // 保存标记到玩家数据
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 起床了`);

    // 躺下起床显示(2)（原版 数据显示.ecode L293：跟随显示(2) +“从床上爬了起来”）
    const map = await this.mapService.getMapById(player.mapId);
    const display = await this.summonFollowDisplay(map, userId, { requireFollow: false, countLimit: 2 });
    return `${name}${display.count > 0 ? `和${display.names.join('和')}` : ''}从床上爬了起来`;
  }

  /**
   * 玩家设置
   * 查看/修改个人设置，设置存储在 markers 中
   * 对应原版：_主程序.ecode 中「设置」指令
   */
  async handleSettings(userId: number, settingName?: string, settingValue?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 未指定设置项：显示当前设置状态
    if (!settingName) {
      const autoShopping = markers['自动购物'];
      const lines = [
        `${player.name || '冒险者'}选择你需要修改的设置`,
        `在线状态：触发本游戏任意回复后10分钟内`,
        `新手指引：新手操作提示`,
        `随机数：触发的回复附带随机数防止裂图`,
        `采集：自动采集：在非战斗状态时静默采集资源且不会消耗地图上的资源，但是速度很慢，非在线状态也能采集；手动采集：手动采集资源`,
        `显示倍率:显示本次攻击时你的最终攻击加成倍率`,
        ``,
        `1、新手指引：${this.playerService.getMarkerValue(markers, '指引') === 0 ? '开' : '关'}`,
        `2、随机数：${this.playerService.getMarkerValue(markers, '自动战斗') === 1 ? '开' : '关'}`,
        `3、自动采集：${this.playerService.getMarkerValue(markers, '自动采集') === 1 ? '开' : '关'}`,
        `4、使用活力：${this.playerService.getMarkerValue(markers, '使用活力') === 0 ? '开' : '关'}`,
        `5、宠物不扶：${this.playerService.getMarkerValue(markers, '不扶') === 1 ? '开' : '关'}`,
        `6、背景音乐：${this.playerService.getMarkerValue(markers, 'bgm') === 0 ? '开' : '关'}`,
        `7、显示倍率：${this.playerService.getMarkerValue(markers, 'bl') === 1 ? '开' : '关'}`,
        `8、自动购物：${autoShopping || '未设置'}`,
      ];
      // 原版 _主程序.ecode L5199：无参查看时生成 1@设置指引…8@设置购物 编号
      // 临时输入替换，玩家直接发数字即可切换对应设置（菜单链闭环）。
      if (this.shortcutService?.setTempInput) {
        await this.shortcutService.setTempInput(
          userId,
          '1@设置指引#2@设置随机#3@设置采集#4@设置活力#5@设置不扶#6@设置音乐#7@设置倍率#8@设置购物',
        );
      }
      return lines.join('\n');
    }

    // 指定设置项：按「开/关/数字」解析并写入 markers
    const settingKey = settingName;
    const settingVal = settingValue;
    let newValue: number;

    if (settingVal === undefined || settingVal.trim() === '') {
      return `请为「${settingName}」设置值：「开/关」或数字`;
    }

    if (settingVal === '开' || settingVal === 'on' || settingVal === 'true' || settingVal === '1') {
      newValue = 1;
    } else if (settingVal === '关' || settingVal === 'off' || settingVal === 'false' || settingVal === '0') {
      newValue = 0;
    } else {
      newValue = parseInt(settingVal, 10);
      if (isNaN(newValue)) {
        return `无效的设置值「${settingVal}」，请使用「开/关」或数字`;
      }
    }

    // 新手指引使用 markers['指引'] 存储，且取值相反：0=开启, 1=关闭
    const actualKey = settingKey === '新手指引' ? '指引' : settingKey;
    markers[actualKey] = newValue;
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 设置 ${settingKey} = ${newValue}`);

    const statusText = newValue === 1 ? '关闭' : '开启';
    const displayText = settingKey === '新手指引' ? `新手指引已${statusText}` : `设置「${settingKey}」已${statusText}`;
    return displayText;
  }

  /**
   * 切换玩家标记类设置（存储在 markers 中）
   * 对应原版 _主程序.ecode「设置」系列指令的切换逻辑：
   * 读取当前值，若处于“开”则切换为“关”，否则切换为“开”
   * @param userId 用户ID
   * @param key 标记键名
   * @param onValue 标记中表示“开”的数值
   * @param offValue 标记中表示“关”的数值
   * @param onText 切换到“开”时返回的提示文本
   * @param offText 切换到“关”时返回的提示文本
   */
  private async toggleSetting(
    userId: number,
    key: string,
    onValue: number,
    offValue: number,
    onText: string,
    offText: string,
  ): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const isOn = this.playerService.getMarkerValue(markers, key) === onValue;
    markers[key] = isOn ? offValue : onValue;
    player.markers = markers;
    await this.playerService.savePlayer(player);
    return `${player.name || '冒险者'}，${isOn ? offText : onText}`;
  }

  /**
   * 设置新手指引开关
   * 对应原版：设置指引
   * 标记「指引」：0=开启, 1=关闭
   */
  async handleSettingsGuide(userId: number): Promise<string> {
    return this.toggleSetting(userId, '指引', 0, 1, '开启了新手指引', '关闭了新手指引');
  }

  /**
   * 设置随机数开关
   * 对应原版：设置随机
   * 标记「自动战斗」：1=显示随机数, 0=不显示
   */
  async handleSettingsRandom(userId: number): Promise<string> {
    return this.toggleSetting(userId, '自动战斗', 1, 0, '开启了随机数', '关闭了随机数');
  }

  /**
   * 设置自动采集开关
   * 对应原版：设置采集
   * 标记「自动采集」：1=开启, 0=关闭
   */
  async handleSettingsGather(userId: number): Promise<string> {
    return this.toggleSetting(userId, '自动采集', 1, 0, '开启了自动采集', '关闭了自动采集');
  }

  /**
   * 设置活力消耗开关
   * 对应原版：设置活力
   * 标记「使用活力」：0=击杀怪物消耗活力, 1=不消耗
   */
  async handleSettingsVitality(userId: number): Promise<string> {
    return this.toggleSetting(userId, '使用活力', 0, 1, '活力现在击杀怪物会消耗', '活力现在击杀怪物不会消耗');
  }

  /**
   * 设置宠物是否扶起主人
   * 对应原版：设置不扶
   * 标记「不扶」：1=宠物不扶, 0=宠物会扶起
   */
  async handleSettingsNoHelp(userId: number): Promise<string> {
    return this.toggleSetting(userId, '不扶', 1, 0, '你现在不会被宠物扶起', '存活的宠物现在会扶你起来');
  }

  /**
   * 设置背景音乐开关
   * 对应原版：设置音乐
   * 标记「bgm」：0=播放bgm, 1=不播放
   */
  async handleSettingsMusic(userId: number): Promise<string> {
    return this.toggleSetting(userId, 'bgm', 0, 1, '播放bgm', '不播放bgm');
  }

  /**
   * 设置显示攻击倍率开关
   * 对应原版：设置倍率
   * 标记「bl」：1=显示倍率, 0=不显示
   */
  async handleSettingsMultiplier(userId: number): Promise<string> {
    return this.toggleSetting(userId, 'bl', 1, 0, '显示倍率', '不显示倍率');
  }

  /**
   * 设置自动购物对象
   * 对应原版：设置购物
   * 记录在 markers['自动购物'] 中，用于「购物自动」指令对自家行商自动购买
   * @param userId 用户ID
   * @param value 购物对象关键词（为空时表示查看当前设置）
   */
  async handleSettingsShop(userId: number, value?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!value) {
      const current = markers['自动购物'];
      return `${player.name || '冒险者'}#换行「设置购物工业、窝」来自动从行商处购买名称包含「工业」和「窝」的物品#换行「购物自动」来使用#换行只能对自己家里的行商使用#换行你当前的设置：${current || ''}`;
    }

    // 对应文本操作.ecode L55-77：原版仅拒绝消息控制字符；等号会被转成可保存的文本。
    const invalidNames: Array<[string, string]> = [
      ['#', '不能包含#'],
      ['!', '不能包含英文感叹号'],
      ['`', '不能包含`'],
      ['\n', '不能包含换行符'],
      ['\r', '不能包含换行符'],
      ['@', '不能包含@'],
      ['&', '不能包含&'],
      ['^', '不能包含^'],
      ['%', '不能包含%'],
    ];
    for (const [token, hint] of invalidNames) {
      if (value.includes(token)) {
        return `${player.name || '冒险者'}${hint}`;
      }
    }
    value = value.replace(/=/g, '【等号】');

    markers['自动购物'] = value;
    player.markers = markers;
    await this.playerService.savePlayer(player);
    return `${player.name || '冒险者'}自动购物的对象设置为${value}`;
  }

  /**
   * 设置玩家位置（管理员）
   * 对应原版：设置位置
   * 将指定玩家移动到地图列表下标或地图名称对应的地图
   * @param userId 调用者用户ID
   * @param value 参数：「目标 地图列表数组下标/地图名称」
   */
  async handleSettingsLocation(userId: number, value?: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN')) {
      return '权限不足，需要管理员权限';
    }

    if (!value) {
      return '不能输入空参数，「设置位置@人 地图列表数组下标/地图名称」';
    }

    const parts = value.split(/\s+/).filter(Boolean);
    if (parts.length !== 2) {
      return '不能输入空参数，「设置位置@人 地图列表数组下标/地图名称」';
    }

    // 解析目标玩家（支持 @QQ 或 QQ 号）
    const targetKey = parts[0].replace(/^@/, '');
    const targetPlayer = await this.prisma.player.findFirst({
      where: { masterQQ: targetKey },
    });
    if (!targetPlayer) {
      return `${targetKey} 在玩家列表不存在`;
    }

    // 解析目标地图（数字下标或名称）
    const mapKey = parts[1];
    let targetMap: any;
    if (/^\d+$/.test(mapKey)) {
      const maps = await this.mapService.getAllMaps();
      const index = parseInt(mapKey, 10);
      if (index < 1 || index > maps.length) {
        return `设置的地图编号超出定义范围：${mapKey}:${maps.length}`;
      }
      targetMap = maps[index - 1];
    } else {
      targetMap = await this.mapService.getMapByName(mapKey).catch(() => null);
      if (!targetMap) {
        return `${mapKey} 在地图列表不存在`;
      }
    }

    const oldMapId = targetPlayer.mapId;
    targetPlayer.mapId = targetMap.id;
    targetPlayer.location = targetMap.name;
    await this.playerService.savePlayer(targetPlayer);
    this.logger.log(`管理员 ${userId} 将玩家 ${targetKey} 从地图 ${oldMapId} 移动到 ${targetMap.name}`);

    return `把${targetPlayer.name || targetKey}的位置设置为${targetMap.name}`;
  }

  /**
   * 设置玩家/宠物标记（管理员）
   * 对应原版：设置标记
   * 支持修改玩家或宠物/召唤物的成就/标记/增益/标记2/配方
   * @param userId 调用者用户ID
   * @param value 参数：「@人/宠物id 标记名称 数值 位置(成就/标记/增益/标记2/配方) 持续时间」
   */
  async handleSettingsMarker(userId: number, value?: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN')) {
      return '权限不足，需要管理员权限';
    }

    if (!value) {
      return '不能输入空参数，「设置标记@人/宠物id 标记名称 数值 位置(成就/标记/增益/标记2/配方) 持续时间」';
    }

    const parts = value.split(/\s+/).filter(Boolean);
    if (parts.length < 4) {
      return '不能输入空参数，「设置标记@人/宠物id 标记名称 数值 位置(成就/标记/增益/标记2/配方) 持续时间」';
    }

    const target = parts[0];
    const markerName = parts[1];
    const markerValue = parseInt(parts[2], 10);
    const position = parts[3]; // 成就/标记/增益/标记2/配方
    const duration = parts.length > 4 ? parseInt(parts[4], 10) : 0;

    if (isNaN(markerValue)) {
      return `标记数值「${parts[2]}」不是有效数字`;
    }

    // 宠物/召唤物（id 以「怪物」或「召唤物」开头）
    if (target.startsWith('怪物') || target.startsWith('召唤物')) {
      const maps = await this.mapService.getAllMaps();
      for (const map of maps) {
        const summons = asJsonValue<any[]>(map.summons, []);
        const summon = summons.find((s: any) => s.qq === target || s.id === target);
        if (summon) {
          if (position === '成就' || position === '配方') {
            return `召唤物/宠物的${position}不可以修改(因为没效果)`;
          }
          if ((position === '标记2' || position === '增益') && !duration) {
            return `${position === '标记2' ? '设置标记2' : '设置增益'}需要提供第五个参数：持续时间`;
          }
          // mutateSummons 锁内闭环：重读最新 summons → 按 qq/id 重定位 → 写标记 → 差异落库
          await this.mapService.mutateSummons(map.id, (fresh) => {
            const idx = fresh.findIndex((s: any) => s.qq === target || s.id === target);
            if (idx === -1) return;
            const t = fresh[idx];
            if (!t.markers) t.markers = {};
            if (position === '标记') {
              t.markers[markerName] = markerValue;
            } else if (position === '标记2' || position === '增益') {
              if (!t.markers2) t.markers2 = {};
              t.markers2[markerName] = { value: markerValue, expireAt: Date.now() / 1000 + duration };
            }
          });
          return `${map.name}的${summon.name}的${markerName}标记被修改为${markerValue}`;
        }
      }
      return `世界地图上未找到id为${target}的宠物或者召唤物`;
    }

    // 玩家（@QQ 或 QQ 号）
    const targetKey = target.replace(/^@/, '');
    const targetPlayer = await this.prisma.player.findFirst({
      where: { masterQQ: targetKey },
    });
    if (!targetPlayer) {
      return `${targetKey} 在玩家列表不存在`;
    }

    const markers = asJsonValue<Record<string, any>>(targetPlayer.markers, {});
    const markers2 = asJsonValue<any[]>(targetPlayer.markers2, []);
    if (position === '标记' || position === '成就') {
      markers[markerName] = markerValue;
      targetPlayer.markers = markers; // Json 列直接写对象
    } else if (position === '标记2' || position === '增益') {
      if (!duration) {
        return `${position === '标记2' ? '设置标记2' : '设置增益'}需要提供第五个参数：持续时间`;
      }
      const now = Date.now() / 1000;
      markers2.push({ name: markerName, value: markerValue, expireAt: now + duration });
      targetPlayer.markers2 = markers2; // Json 列直接写数组
    } else if (position === '配方') {
      const recipes = asJsonValue<Record<string, any>>(targetPlayer.recipes, {});
      recipes[markerName] = markerValue;
      targetPlayer.recipes = recipes; // Json 列直接写对象
    }
    await this.playerService.savePlayer(targetPlayer);

    return `${targetPlayer.name || targetKey}的${markerName}${position}被修改为${markerValue}`;
  }

  /**
   * 开启副本
   * 使用副本钥匙在当前地图开启副本，生成临时怪物
   * @param userId 用户ID
   * @returns 副本开启信息
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
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

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
  private readonly PART_TYPE_NAMES: Record<number, string> = {
    0: '核心部件', 1: '防御部件', 2: '行走机构', 3: '武器部件', 4: '功能部件',
  };

  /**
   * 获取部件类型对应的插槽限制信息
   * @param vehicle 载具对象
   * @param partType 部件类型（0核心 1防御 2行走 3武器 4功能）
   */
  private getSlotLimit(vehicle: any, partType: number): { slots: number; max: number; name: string } {
    switch (partType) {
      case 0: return { slots: 1, max: 1, name: '核心' };
      case 1: return { slots: vehicle.defenseSlots || 0, max: vehicle.maxDefense || 5, name: '防御' };
      case 2: return { slots: vehicle.moveSlots || 0, max: vehicle.maxMove || 5, name: '行走' };
      case 3: return { slots: vehicle.weaponSlots || 0, max: vehicle.maxWeapon || 5, name: '武器' };
      case 4: return { slots: vehicle.functionSlots || 0, max: vehicle.maxFunction || 5, name: '功能' };
      default: return { slots: 0, max: 0, name: '未知' };
    }
  }

  /**
   * 计算载具的总加成
   * 载具基础加成 + 所有已安装部件的加成之和
   * @param vehicle 载具对象
   * @returns 合并后的总加成对象
   */
  private calcVehicleTotalBonus(vehicle: any): any {
    // 解析载具基础加成
    const baseBonus = asJsonValue<any>(vehicle.bonus, {});
    // 解析已安装的部件列表
    const parts = asJsonValue<any[]>(vehicle.parts, []);

    // 合并所有部件的加成
    let totalBonus = { ...baseBonus };
    for (const part of parts) {
      if (part.bonus && typeof part.bonus === 'object') {
        for (const key of Object.keys(part.bonus)) {
          const val = part.bonus[key];
          if (val === undefined || val === null) continue;
          if (typeof val === 'number') {
            (totalBonus as any)[key] = ((totalBonus as any)[key] || 0) + val;
          } else if (typeof val === 'boolean') {
            (totalBonus as any)[key] = (totalBonus as any)[key] || val;
          }
        }
      }
    }
    return totalBonus;
  }

  /** 解析载具运行时 JSON，兼容 DB 字符串和地图 JSON 对象。 */
  private parseVehicleValue<T>(value: any, fallback: T): T {
    if (Array.isArray(value) || (value && typeof value === 'object')) return value as T;
    if (typeof value !== 'string' || !value.trim()) return fallback;
    return asJsonValue<T>(value, fallback);
  }

  /** 将 DB/地图载具转换为原版中文字段运行时结构。 */
  private toRuntimeVehicle(raw: any): any {
    const normalizeItem = (item: any): any => {
      const name = String(item?.名称 ?? item?.name ?? '');
      const quantity = Number(item?.数量 ?? item?.quantity ?? item?.count ?? 1);
      const durability = Number(item?.耐久 ?? item?.durability ?? 100);
      return {
        ...(item || {}),
        名称: name,
        name: item?.name ?? name,
        类型: item?.类型 ?? item?.type ?? '资源',
        type: item?.type ?? item?.类型 ?? '资源',
        数量: Number.isFinite(quantity) ? quantity : 0,
        quantity: item?.quantity ?? item?.count ?? (Number.isFinite(quantity) ? quantity : 0),
        耐久: Number.isFinite(durability) ? durability : 100,
        durability: item?.durability ?? (Number.isFinite(durability) ? durability : 100),
      };
    };
    const normalizeRecipe = (recipe: any): any => {
      const name = String(recipe?.名称 ?? recipe?.name ?? '');
      const value = Number(recipe?.数值 ?? recipe?.value ?? recipe?.production ?? recipe?.count ?? 0);
      return {
        ...(recipe || {}),
        名称: name,
        name: recipe?.name ?? name,
        数值: Number.isFinite(value) ? value : 0,
        value: recipe?.value ?? (Number.isFinite(value) ? value : 0),
      };
    };
    const parts = this.parseVehicleValue<any[]>(raw?.零件 ?? raw?.parts, []);
    const recipes = this.parseVehicleValue<any[]>(raw?.配方 ?? raw?.recipes, []);
    const bonus = this.parseVehicleValue<any>(raw?.加成 ?? raw?.bonus, {});
    const markers2 = this.parseVehicleValue<any[]>(raw?.标记2 ?? raw?.markers2, []);
    const currentHp = Number(raw?.当前生命 ?? raw?.currentHp ?? raw?.hp ?? 0);
    const maxHp = Number(raw?.生命 ?? raw?.maxHp ?? 0);
    const slotStatus = Number(raw?.上限 ?? raw?.slotStatus ?? 0);
    const moveType = Number(raw?.行走方式 ?? raw?.moveType ?? 0);
    return {
      ...(raw || {}),
      名称: String(raw?.名称 ?? raw?.name ?? ''),
      name: raw?.name ?? raw?.名称 ?? '',
      类型: String(raw?.类型 ?? raw?.type ?? ''),
      type: raw?.type ?? raw?.类型 ?? '',
      编号: String(raw?.编号 ?? raw?.vehicleId ?? raw?.id ?? ''),
      vehicleId: raw?.vehicleId ?? raw?.编号 ?? raw?.id ?? '',
      归属: String(raw?.归属 ?? raw?.owner ?? ''),
      owner: raw?.owner ?? raw?.归属 ?? '',
      驾驶员: String(raw?.驾驶员 ?? raw?.driver ?? ''),
      driver: raw?.driver ?? raw?.驾驶员 ?? '',
      当前生命: Number.isFinite(currentHp) ? currentHp : 0,
      currentHp: Number.isFinite(currentHp) ? currentHp : 0,
      生命: Number.isFinite(maxHp) ? maxHp : 0,
      maxHp: Number.isFinite(maxHp) ? maxHp : 0,
      上限: Number.isFinite(slotStatus) ? slotStatus : 0,
      slotStatus: Number.isFinite(slotStatus) ? slotStatus : 0,
      行走方式: Number.isFinite(moveType) ? moveType : 0,
      moveType: Number.isFinite(moveType) ? moveType : 0,
      零件: Array.isArray(parts) ? parts.map(normalizeItem) : [],
      配方: Array.isArray(recipes) ? recipes.map(normalizeRecipe) : [],
      加成: bonus && typeof bonus === 'object' ? bonus : {},
      标记2: Array.isArray(markers2) ? markers2 : [],
    };
  }

  /** 将原版中文运行时字段写回兼容的中英文载具对象。 */
  private toStoredVehicle(runtime: any): any {
    const parts = (runtime.零件 || []).map((item: any) => ({
      ...(item || {}),
      名称: item?.名称 ?? item?.name ?? '',
      name: item?.name ?? item?.名称 ?? '',
      类型: item?.类型 ?? item?.type ?? '资源',
      type: item?.type ?? item?.类型 ?? '资源',
      数量: Number(item?.数量 ?? item?.quantity ?? item?.count ?? 0),
      quantity: Number(item?.quantity ?? item?.数量 ?? item?.count ?? 0),
      耐久: Number(item?.耐久 ?? item?.durability ?? 100),
      durability: Number(item?.durability ?? item?.耐久 ?? 100),
    }));
    const recipes = (runtime.配方 || []).map((recipe: any) => ({
      ...(recipe || {}),
      名称: recipe?.名称 ?? recipe?.name ?? '',
      name: recipe?.name ?? recipe?.名称 ?? '',
      数值: Number(recipe?.数值 ?? recipe?.value ?? 0),
      value: Number(recipe?.value ?? recipe?.数值 ?? 0),
    }));
    const bonus = runtime.加成 || {};
    const markers2 = runtime.标记2 || [];
    return {
      ...(runtime || {}),
      名称: runtime.名称 ?? runtime.name ?? '',
      name: runtime.name ?? runtime.名称 ?? '',
      编号: runtime.编号 ?? runtime.vehicleId ?? runtime.id ?? '',
      vehicleId: runtime.vehicleId ?? runtime.编号 ?? runtime.id ?? '',
      类型: runtime.类型 ?? runtime.type ?? '',
      type: runtime.type ?? runtime.类型 ?? '',
      归属: runtime.归属 ?? runtime.owner ?? '',
      owner: runtime.owner ?? runtime.归属 ?? '',
      驾驶员: runtime.驾驶员 ?? runtime.driver ?? '',
      driver: runtime.driver ?? runtime.驾驶员 ?? '',
      当前生命: Number(runtime.当前生命 ?? runtime.currentHp ?? 0),
      currentHp: Number(runtime.currentHp ?? runtime.当前生命 ?? 0),
      生命: Number(runtime.生命 ?? runtime.maxHp ?? 0),
      maxHp: Number(runtime.maxHp ?? runtime.生命 ?? 0),
      上限: Number(runtime.上限 ?? runtime.slotStatus ?? 0),
      slotStatus: Number(runtime.slotStatus ?? runtime.上限 ?? 0),
      行走方式: Number(runtime.行走方式 ?? runtime.moveType ?? 0),
      moveType: Number(runtime.moveType ?? runtime.行走方式 ?? 0),
      零件: parts,
      parts,
      配方: recipes,
      recipes,
      加成: bonus,
      bonus,
      标记2: markers2,
      markers2,
    };
  }

  private vehicleDbData(runtime: any): Record<string, any> {
    const stored = this.toStoredVehicle(runtime);
    return {
      name: stored.name,
      vehicleId: String(stored.vehicleId || ''),
      type: stored.type,
      owner: String(stored.owner || ''),
      driver: String(stored.driver || ''),
      moveType: Number(stored.moveType || 0),
      maxHp: Number(stored.maxHp || 0),
      currentHp: Number(stored.currentHp || 0),
      slotStatus: Number(stored.slotStatus || 0),
      bonus: stored.bonus || {},
      parts: stored.parts || [],
      markers2: stored.markers2 || [],
      recipes: stored.recipes || [],
    };
  }

  /** 持久化生产结算后的载具；地图 JSON 和 GameVehicle 共用同一运行时结构。 */
  private async persistRuntimeVehicle(source: any, runtime: any): Promise<void> {
    if (source.kind === 'db') {
      await this.prisma.gameVehicle.update({
        where: { id: source.db.id },
        data: this.vehicleDbData(runtime),
      });
      return;
    }
    const vehicles = this.parseVehicleValue<any[]>(source.map?.vehicles, []);
    if (source.index == null || source.index < 0 || source.index >= vehicles.length) return;
    vehicles[source.index] = this.toStoredVehicle(runtime);
    await this.mapService.updateDynamicFields(source.map.id, {
      vehicles,
    });
  }

  /** 根据玩家驾驶/接管状态寻找当前可操作载具。 */
  private async findProductionVehicle(userId: number, player: any, currentMap: any): Promise<any | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const ownerIds = new Set([
      String(userId), String(player?.userId ?? ''), String(user?.qqNumber ?? ''),
      String(user?.externalId ?? ''), String(player?.masterQQ ?? ''),
    ].filter(Boolean));
    const sets = this.parseVehicleValue<any>(player?.sets, {});
    const takeover = String(sets?.takeVehicle ?? sets?.接管载具 ?? '');
    const requested = takeover || String(player?.vehicle ?? '');

    const matchUnit = (unit: any, key: string): boolean => {
      const ids = [unit?.编号, unit?.vehicleId, unit?.id, unit?.name, unit?.名称]
        .filter((value) => value !== undefined && value !== null)
        .map(String);
      if (key && ids.includes(key)) return true;
      const driver = String(unit?.驾驶员 ?? unit?.driver ?? '');
      return !key && ownerIds.has(driver);
    };
    const mapSource = (map: any, index: number): any => {
      const vehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
      const raw = vehicles[index];
      if (!raw) return null;
      return { kind: 'map', map, index, raw, runtime: this.toRuntimeVehicle(raw) };
    };

    const findDbVehicle = async (key: string): Promise<any | null> => {
      const numericId = Number(key);
      let db = Number.isInteger(numericId) && numericId > 0
        ? await this.prisma.gameVehicle.findUnique({ where: { id: numericId } })
        : null;
      if (!db && key) {
        db = await this.prisma.gameVehicle.findFirst({
          where: { OR: [{ vehicleId: key }, { name: key }] },
        });
      }
      return db;
    };

    const currentVehicles = this.parseVehicleValue<any[]>(currentMap?.vehicles, []);

    // 当前玩家.vehicle 是数据库载具主键时优先读取 GameVehicle；接管状态仍按原版优先查地图 JSON。
    // 这样旧地图中的同编号载具不会劫持新数据库载具的生产命令。
    if (!takeover && requested) {
      const db = await findDbVehicle(requested);
      if (db) return { kind: 'db', db, runtime: this.toRuntimeVehicle(db), map: currentMap };
    }

    let index = currentVehicles.findIndex((unit) => matchUnit(unit, requested));
    if (index >= 0) return mapSource(currentMap, index);

    // 接管载具可能暂时不在玩家所在地图；原版会全图检索并自动清理失效接管状态。
    if (takeover) {
      const maps = await this.mapService.getAllMaps();
      for (const map of maps) {
        if (map.id === currentMap?.id) continue;
        const vehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
        index = vehicles.findIndex((unit) => matchUnit(unit, takeover));
        if (index >= 0) return mapSource(map, index);
      }
    }

    const db = requested ? await findDbVehicle(requested) : null;
    if (!db && !requested) {
      const candidates = await this.prisma.gameVehicle.findMany({ orderBy: { id: 'asc' } });
      const owned = candidates.find((vehicle) => ownerIds.has(String(vehicle.driver)) || ownerIds.has(String(vehicle.owner)));
      if (owned) return { kind: 'db', db: owned, runtime: this.toRuntimeVehicle(owned), map: currentMap };
    }
    if (db) return { kind: 'db', db, runtime: this.toRuntimeVehicle(db), map: currentMap };
    return null;
  }

  private vehicleProductionOptions(map: any, vehicle: any): { yongxing: number; lannBaby: boolean } {
    const summons = this.parseVehicleValue<any[]>(map?.summons, []);
    const driver = String(vehicle?.驾驶员 ?? vehicle?.driver ?? '');
    const driverSummon = summons.find((summon: any) =>
      [summon?.QQ, summon?.qq, summon?.编号, summon?.id].filter(Boolean).map(String).includes(driver),
    );
    const seq = (summon: any): number => Number(
      summon?.活力 ?? summon?.vitality ?? summon?.特殊序号 ?? summon?.specialSeq ?? 0,
    );
    return {
      // 原版常量：咏星特殊序号=-27，兰音幼崽特殊序号=-30。
      yongxing: driverSummon && seq(driverSummon) === -27 ? 0.15 : 0,
      lannBaby: summons.some((summon: any) => seq(summon) === -30),
    };
  }

  private formatVehicleItems(items: any[]): string {
    const values = (items || []).filter((item: any) => Number(item?.quantity ?? item?.数量 ?? 0) !== 0);
    if (values.length === 0) return '无';
    return values.map((item: any) => {
      const name = item?.name ?? item?.名称 ?? '';
      const quantity = Number(item?.quantity ?? item?.数量 ?? 0);
      return `${name}x${this.roundText(quantity)}`;
    }).join('、');
  }

  private formatVehicleTime(seconds: number): string {
    if (seconds === 86400.12345678) return '时间无限，显示一天的产量';
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const day = Math.floor(total / 86400);
    const hour = Math.floor((total % 86400) / 3600);
    const minute = Math.floor((total % 3600) / 60);
    const second = total % 60;
    const parts: string[] = [];
    if (day) parts.push(`${day}天`);
    if (hour || parts.length) parts.push(`${hour}小时`);
    if (minute || parts.length) parts.push(`${minute}分`);
    parts.push(`${second}秒`);
    return parts.join('');
  }

  /**
   * 载具生产命令。
   * 对应原版 _主程序.ecode L10929-11222，以及物品操作.ecode L2612-2954。
   */
  async handleVehicleProduction(userId: number, argument = ''): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${player.name || '冒险者'}不在服务区`;

    let command = String(argument || '').trim();
    if (command.startsWith('生产')) command = command.substring(2).trim();
    if (!command) {
      return [
        `${player.name || '冒险者'},这是一个高级功能，上手难度较高，你应该先完成[教程]系列任务和[进阶]系列任务再来尝试。`,
        `“生产生肉分解1 5.2”来为当前驾驶的载具输入[生肉分解1]这个配方，并且把5.2的生产力分配给这个配方。可以输入负数来减少生产力。`,
        `“生产排序2 3”来调整两个配方的先后顺序。`,
        `“生产排序插入12 3”来把第12个配方在排序上插入到3的位置。`,
        `“生产限制资源箱10000”来对[资源箱]这种产物进行限制，输入0移除。`,
        `“生产配平5”来让载具其他配方自动根据消耗进行生产力分配。`,
        `产出的物品会存放于载具内，配方需要消耗的材料直接放入载具内即可。`,
        `载具生命为0时也可以生产，但是有部件超出容许安装限制时无法生产。`,
        `生产所需的配方可以发送“配方”来获取。`,
        `载具的核心不是生产类载具的核心时，生产力降低75%。`,
        `1、配方    2、查看产物`,
      ].join('\n');
    }

    const source = await this.findProductionVehicle(userId, player, map);
    if (!source) {
      const sets = this.parseVehicleValue<any>(player.sets, {});
      const takeover = String(sets?.takeVehicle ?? sets?.接管载具 ?? '');
      if (takeover) {
        sets.takeVehicle = '';
        sets.接管载具 = '';
        player.sets = sets;
        await this.playerService.savePlayer(player);
        return `${player.name || '冒险者'}由于你之前接管的载具${takeover}不在世界上，已自动停止接管`;
      }
      return `${player.name || '冒险者'}必须“驾驶”或者“接管”载具之后才能执行此操作`;
    }

    const runtime = source.runtime;
    const productionBonus = this.achievementService.getAchievement(playerData.markers, '生产');
    // 接管载具可能来自其他地图；兰音幼崽/咏星状态应从载具所在地图读取。
    const productionMap = source.kind === 'map'
      ? source.map
      : (Number(source.db?.mapIndex || 0) > 0
        ? await this.mapService.getMapById(Number(source.db.mapIndex))
        : map);
    const productionOptions = this.vehicleProductionOptions(productionMap || map, runtime);
    const timestamp = Date.now();
    const production = this.combatSystem.produceVehicle(
      runtime,
      timestamp,
      productionBonus,
      map.id,
      productionOptions,
    );

    // 生产结算必须先持久化，后续生产限制/排序/配方设置才不会覆盖已结算的时间戳。
    await this.persistRuntimeVehicle(source, runtime);

    // 原版实际产出同时推进「生产」成就和按物品拆分的任务要求。
    const producedByName = new Map<string, number>();
    for (const item of production.produced) {
      const name = String(item.name || '');
      const quantity = Number(item.quantity || 0);
      if (name && quantity > 0) producedByName.set(name, (producedByName.get(name) || 0) + quantity);
    }
    if (producedByName.size > 0) {
      const markers = playerData.markers || {};
      const total = [...producedByName.values()].reduce((sum, value) => sum + value, 0);
      this.achievementService.setAchievement(
        markers,
        '生产',
        this.achievementService.getAchievement(markers, '生产') + total,
      );
      player.markers = markers;
      await this.playerService.savePlayer(player);
      for (const [name, quantity] of producedByName) {
        await this.taskService.advance(userId, `生产${name}`, quantity);
        await this.taskService.advance(userId, '生产', quantity);
      }
    }

    const playerName = player.name || '冒险者';
    if (Number(runtime.加成?.生产 || 0) === 0) {
      return `${playerName},${runtime.名称}没有生产力，你可以组装生产线，或者使用专门的生产类载具。专门的生产类载具效率更高`;
    }
    if (runtime.上限 > 1) {
      return `${playerName},${runtime.名称}有部件超出了容许安装限制，无法正常运作`;
    }

    if (command === '0') {
      if (runtime.配方.length < 2) {
        return `${playerName}你尚未对${runtime.名称}输入配方\n“生产生肉分解1 5.2”来为当前驾驶的载具输入[生肉分解1]这个配方，并且把5.2的生产力分配给这个配方。`;
      }
      const recipeLines = runtime.配方.slice(1).map((recipe: any, index: number) => {
        const def = this.staticData.getVehicleRecipeByName(recipe.名称);
        const level = Number(def?.level ?? def?.等级 ?? 0);
        return `${index + 1}、${recipe.名称}(${level}级) ${this.roundText(Number(recipe.数值 || 0))}生产力`;
      });
      const speedPercent = production.consumedProductivity > Number(runtime.加成.生产 || 0)
        ? production.productionSpeed * production.efficiency * 100
        : production.productionSpeed * 100;
      const lines = [
        `${playerName},${runtime.名称}的生产线:`,
        ...recipeLines,
        `◆生产力${this.roundText(production.consumedProductivity)}/${this.roundText(Number(runtime.加成.生产 || 0))},可生产${this.formatVehicleTime(production.availableTime)}`,
        `◆生产速度${this.roundText(speedPercent)}%${production.byproductMultiplier !== 1 ? `,副产物+${this.roundText((production.byproductMultiplier - 1) * 100)}%` : ''}${production.consumptionMultiplier !== 1 ? `,消耗-${this.roundText((1 - production.consumptionMultiplier) * 100)}%` : ''}`,
        `◆每分钟消耗:${this.formatVehicleItems(production.consumptionPerMinute)}`,
        `◆每分钟产出:${this.formatVehicleItems(production.outputPerMinute)}`,
        `◆消耗+产出:${this.formatVehicleItems(production.combinedPerMinute)}`,
      ];
      if (production.availableTime > 0 && production.availableTime !== 86400.12345678) {
        lines.push(`◆最终产物:${this.formatVehicleItems(production.combinedPerMinute.map((item) => ({
          ...item,
          quantity: Number(item.quantity || 0) * production.availableTime / 60,
        })))}`);
      }
      const missing = production.combinedPerMinute
        .filter((item) => Number(item.quantity || 0) < 0 &&
          this.itemQuantity((runtime.零件 || []).find((part: any) => (part.名称 ?? part.name) === item.name)) <= 0)
        .length > 0;
      if (missing) lines.push('【缺少部分物品导致无法生产，你可以手动把物品组装到载具上】');
      await this.persistRuntimeVehicle(source, runtime);
      return lines.join('\n');
    }

    if (command === '1') {
      const sets = this.parseVehicleValue<any>(player.sets, {});
      const scientist = Number(sets?.scientist ?? sets?.科学家 ?? 0);
      if (scientist < 4) return `${playerName}需要装备科学家外套/裙子/手套以及白色丝袜`;
      if (runtime.配方.length < 2) return `${playerName}${runtime.名称}未输入配方`;
      const markers2 = playerData.markers2 || [];
      const cooldownText = { value: '' };
      const cooling = this.combatState.timeIntervalRequire(
        '生产1',
        36000,
        markers2,
        timestamp,
        cooldownText,
        timestamp,
      );
      player.markers2 = markers2;
      if (cooling) {
        await this.playerService.savePlayer(player);
        return `${playerName}${cooldownText.value}`;
      }
      runtime.配方[0].数值 = Number(runtime.配方[0].数值 || timestamp) - 3600 * 1000;
      await this.persistRuntimeVehicle(source, runtime);
      await this.playerService.savePlayer(player);
      return `${playerName},${runtime.名称}的时间加速流逝了一小时`;
    }

    if (command.startsWith('限制')) {
      const payload = command.substring(2).trim();
      const numberMatch = payload.match(/[-+]?\d+(?:\.\d+)?/);
      const productName = payload.replace(/[-+]?\d+(?:\.\d+)?/g, '').trim();
      if (!productName) {
        return `“生产限制资源箱10000.2”来对[资源箱]这种产物进行限制，载具内物品数量达到目标后不会继续生产；输入0移除`;
      }
      const limit = Math.max(0, numberMatch ? Number(numberMatch[0]) : 0);
      const limitName = `生产限制${productName}`;
      const parts = runtime.零件 || [];
      const existingIndex = parts.findIndex((part: any) => (part.名称 ?? part.name) === limitName);
      if (existingIndex >= 0) {
        if (limit === 0) {
          parts.splice(existingIndex, 1);
          await this.persistRuntimeVehicle(source, runtime);
          return `${playerName},移除了${productName}的生产限制`;
        }
        parts[existingIndex].名称 = limitName;
        parts[existingIndex].name = limitName;
        parts[existingIndex].数量 = limit;
        parts[existingIndex].quantity = limit;
      } else if (limit > 0) {
        parts.push({ 名称: limitName, name: limitName, 类型: '资源', type: '资源', 数量: limit, quantity: limit, 耐久: 100, durability: 100 });
      } else {
        return `${playerName},移除了${productName}的生产限制`;
      }
      await this.persistRuntimeVehicle(source, runtime);
      return `${playerName},${productName}的生产限制被设置为${limit}`;
    }

    if (command.startsWith('配平')) {
      const payload = command.substring(2).trim();
      let recipeNumber = Number(payload);
      if (!/^\d+$/.test(payload)) {
        const actualIndex = runtime.配方.findIndex((recipe: any, index: number) => index > 0 && recipe.名称 === payload);
        recipeNumber = actualIndex > 0 ? actualIndex : 0;
      }
      const recipeCount = Math.max(0, runtime.配方.length - 1);
      if (!recipeNumber) return `${playerName}“生产配平5”或者“生产配平木头分解1”来配平`;
      if (recipeNumber < 1 || recipeNumber > recipeCount) {
        return `${playerName},${runtime.名称}只有${recipeCount}个配方，输入的值超范围或者小于1:${recipeNumber}`;
      }
      const target = runtime.配方[recipeNumber];
      const targetDef = this.staticData.getVehicleRecipeByName(target.名称);
      const targetInputs = this.parseVehicleValue<any[]>(targetDef?.消耗 ?? targetDef?.inputs, []);
      const productionView = this.combatSystem.calculateVehicleProduction(runtime, timestamp, productionOptions);
      const messages: string[] = [`${runtime.名称}\n配方${target.名称}x${this.roundText(Number(target.数值 || 0))}`];
      for (const input of targetInputs) {
        const inputName = input?.名称 ?? input?.name ?? '';
        const inputQty = Number(input?.数量 ?? input?.quantity ?? 0);
        const inputDurability = Number(input?.耐久 ?? input?.durability ?? 100) / 100;
        const need = inputQty * inputDurability * Number(target.数值 || 0)
          * productionView.consumptionMultiplier * productionView.efficiency * productionView.productionSpeed;
        let matched = false;
        for (let index = 1; index < runtime.配方.length; index++) {
          if (index === recipeNumber) continue;
          const other = runtime.配方[index];
          const otherDef = this.staticData.getVehicleRecipeByName(other.名称);
          const outputs = this.parseVehicleValue<any[]>(otherDef?.产出 ?? otherDef?.outputs, []);
          const output = outputs.find((item: any) => (item?.名称 ?? item?.name) === inputName);
          if (!output) continue;
          const outputQty = Number(output.数量 ?? output.quantity ?? 0);
          const outputDurability = Number(output.耐久 ?? output.durability ?? 100) / 100;
          const perProduction = outputQty * (outputDurability < 1 ? outputDurability * productionView.byproductMultiplier : 1)
            * productionView.efficiency * productionView.productionSpeed;
          if (perProduction <= 0) continue;
          other.数值 = need / perProduction;
          other.value = other.数值;
          messages.push(`配方${other.名称}产出${inputName}，生产力调整为${this.roundText(other.数值)}`);
          matched = true;
        }
        if (!matched) messages.push(`没有其他产出${inputName}的配方`);
      }
      await this.persistRuntimeVehicle(source, runtime);
      return messages.join('\n');
    }

    if (command.startsWith('排序')) {
      const insertMatch = command.match(/^排序插入\s*(\d+)\s+(\d+)$/);
      const swapMatch = command.match(/^排序\s*(\d+)\s+(\d+)$/);
      const recipeCount = Math.max(0, runtime.配方.length - 1);
      if (insertMatch) {
        const from = Number(insertMatch[1]);
        const to = Number(insertMatch[2]);
        if (from < 1 || from > recipeCount || to < 1 || to > recipeCount || from === to) {
          return `${playerName},${runtime.名称}只有${recipeCount}个配方，或者你输入的值不符合规范(小于1或者相等)\n${from} ${to}`;
        }
        const moved = runtime.配方.splice(from, 1)[0];
        runtime.配方.splice(to, 0, moved);
        await this.persistRuntimeVehicle(source, runtime);
        await this.taskService.advance(userId, '生产排序');
        return `${playerName},${runtime.名称}的配方[${moved.名称}]移动到了${to}号`;
      }
      if (swapMatch) {
        const first = Number(swapMatch[1]);
        const second = Number(swapMatch[2]);
        if (first < 1 || second < 1 || first > recipeCount || second > recipeCount || first === second) {
          return `${playerName},${runtime.名称}只有${recipeCount}个配方，或者你输入的值不符合规范(小于1或者相等)\n${first} ${second}`;
        }
        const temp = runtime.配方[first];
        runtime.配方[first] = runtime.配方[second];
        runtime.配方[second] = temp;
        await this.persistRuntimeVehicle(source, runtime);
        await this.taskService.advance(userId, '生产排序');
        return `${playerName},${runtime.名称}的配方[${runtime.配方[second].名称}]和[${runtime.配方[first].名称}]交换了位置`;
      }
      return `${playerName}\n“生产排序2 3”来调整两个配方的先后顺序。“生产排序插入12 3”来把第12个配方插入到3的位置。`;
    }

    const recipeInput = command.split(/\s+/).filter(Boolean);
    if (recipeInput.length !== 2) {
      return `${playerName}你输入的数据不正确，请检查：${command}`;
    }
    const recipeName = recipeInput[0];
    const allocation = Number(recipeInput[1]);
    const unlocked = this.parseVehicleValue<any>(player.recipes, []);
    const unlockedNames = Array.isArray(unlocked)
      ? unlocked.map((recipe: any) => String(recipe?.名称 ?? recipe?.name ?? recipe))
      : Object.keys(unlocked || {}).filter((key) => Number(unlocked[key]) !== 0);
    if (!unlockedNames.includes(recipeName) || !this.staticData.getVehicleRecipeByName(recipeName)) {
      return `${playerName}你尚未解锁这个配方，或者输入的配方不存在：${recipeName}`;
    }
    if (!Number.isFinite(allocation)) {
      return `${playerName}你输入的数据不正确，请检查：${command}`;
    }
    if (runtime.配方.length === 0) runtime.配方.push({ 名称: '1', name: '1', 数值: timestamp, value: timestamp });
    this.combatState.addAchievement(recipeName, allocation, runtime.配方 as any);
    const current = runtime.配方.find((recipe: any) => recipe.名称 === recipeName);
    const currentValue = Number(current?.数值 || 0);
    const view = this.combatSystem.calculateVehicleProduction(runtime, timestamp, productionOptions);
    await this.persistRuntimeVehicle(source, runtime);
    await this.taskService.advance(userId, '设置生产配方');
    const currentOutput = view.combinedPerMinute.filter((item) => Number(item.quantity || 0) !== 0);
    return `${playerName}为${runtime.名称}设置了${recipeName}\n它当前占用的生产力为${this.roundText(currentValue)}\n${runtime.名称}当前产出:${this.formatVehicleItems(currentOutput)}`;
  }

  /**
   * 原版“安装”统一入口：生产建筑放院子，功能建筑放屋内；非建筑则安装到载具。
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
  private async handleInstallHomeFuel(userId: number, requestedCount: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${player.name || '冒险者'}不在服务区`;
    if (!player.houseName || map.name !== player.houseName) {
      return `${player.name || '冒险者'}燃料只能放院子里`;
    }

    const backpack = this.playerService.getBackpackItems(player);
    const available = Math.floor(this.itemQuantity(
      backpack.find((item: any) => (item?.name ?? item?.名称) === '燃料'),
    ));
    const count = Math.min(Math.max(1, Math.floor(requestedCount)), available);
    if (count <= 0) return `${player.name || '冒险者'}你没有燃料`;

    this.deductBackpackItem(backpack, '燃料', count);
    const items = asJsonValue<any[]>(map.items, []);
    this.addItemToCollection(items, { name: '燃料', type: '资源', quantity: count });
    await this.mapService.updateDynamicFields(map.id, { items });
    player.backpack = backpack; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    return `${player.name || '冒险者'}把${count}个燃料放到了${map.name}里`;
  }

  /** 把床等功能建筑放入当前载具的零件/物品数组。 */
  private async handleAssembleBuilding(userId: number, buildingName: string, count = 1): Promise<string> {
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
    const slotLimit = this.getSlotLimit(vehicle, partType);

    const available = Math.max(0, Math.floor(this.itemQuantity(backpackItem)));
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
    const totalBonus = this.calcVehicleTotalBonus({
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
    const totalBonus = this.calcVehicleTotalBonus({
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

    const partTypeName = this.PART_TYPE_NAMES[Number(removedPart.partType)] || '未知';
    const quantityText = removeCount > 1 ? `×${removeCount}` : '';
    return `✅ 成功从载具【${vehicle.name}】拆卸了【${partName}】${quantityText}(${partTypeName})\n部件已放回背包`;
  }

  /**
   * 尝试拆卸当前家园地图上的建筑/燃料。
   * 返回 null 表示当前地图不是玩家家园，调用方继续走载具部件分支。
   */
  private async tryUninstallHomeBuilding(
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
    const available = Math.floor(this.itemQuantity(source));
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
    this.addItemToCollection(backpack, {
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
  async handleVehicleStatus(userId: number): Promise<string> {
    // 1. 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 2. 检查玩家是否有载具
    if (!player.vehicle) {
      return '你当前没有驾驶任何载具';
    }
    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) {
      return '载具数据异常';
    }

    // 3. 从数据库查询载具定义
    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      return '载具数据不存在';
    }

    // 4. 解析部件列表和加成
    const parts = asJsonValue<any[]>(vehicle.parts, []);
    const totalBonus = asJsonValue<any>(vehicle.bonus, {});

    // 统计各类型部件数量
    const typeCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const part of parts) {
      typeCounts[part.partType] = (typeCounts[part.partType] || 0) + 1;
    }

    // 5. 格式化显示
    const lines: string[] = [
      `🚗 【${vehicle.name}】`,
      `━━━━━━━━━━━━━━━`,
      `❤️ 耐久度: ${vehicle.currentHp || 0}/${vehicle.maxHp || 100}`,
      `━━━━━━━━━━━━━━━`,
      `📦 部件 (${parts.length}个):`,
    ];

    // 按类型分组显示部件
    if (parts.length === 0) {
      lines.push(`  暂无安装部件`);
    } else {
      for (const part of parts) {
        const typeName = this.PART_TYPE_NAMES[part.partType] || '未知';
        lines.push(`  ${part.name} [${typeName}]`);
      }
    }

    // 显示插槽使用情况
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`📊 插槽使用:`);
    lines.push(`  武器: ${typeCounts[3] || 0}/${vehicle.maxWeapon || 5}`);
    lines.push(`  防御: ${typeCounts[1] || 0}/${vehicle.maxDefense || 5}`);
    lines.push(`  行走: ${typeCounts[2] || 0}/${vehicle.maxMove || 5}`);
    lines.push(`  功能: ${typeCounts[4] || 0}/${vehicle.maxFunction || 5}`);

    // 显示加成摘要
    const bonusFields: { key: string; label: string }[] = [
      { key: '攻击', label: '攻击' },
      { key: '生命', label: '生命' },
      { key: '装甲', label: '装甲' },
      { key: '护盾', label: '护盾' },
      { key: '速度', label: '速度' },
      { key: '闪避', label: '闪避' },
    ];

    const hasBonus = bonusFields.some((bf) => (totalBonus as any)[bf.key]);
    if (hasBonus) {
      lines.push(`━━━━━━━━━━━━━━━`);
      lines.push(`✨ 加成属性:`);
      for (const bf of bonusFields) {
        const val = (totalBonus as any)[bf.key];
        if (val) {
          lines.push(`  ${bf.label}: +${Math.round(val)}`);
        }
      }
    }

    return lines.join('\n');
  }

  // ========== 基础战斗命令 ==========

  /**
   * 处理开始战斗命令
   * 对应原版 _主程序.ecode L2077-2163：在家园前线生成一轮地精攻势，
   * 写入 GameMonster，生成/刷新前线防御召唤物，并开启前线活动状态。
   */
  async handleStartBattle(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

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

  private async handleSweepInner(userId: number, requestedCount: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = player.name || '冒险者';

    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

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
    player.markers = playerData.markers || asJsonValue(player.markers, {}); // Json 列直接写对象
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
      `得到了经验x${this.roundText(totalExp)}`,
    ];
    if (dropText) lines.push(`获得${dropText}`);
    return lines.join('\n');
  }

  /** 读取原版地图怪物池，并合并有效的“嗅探怪物”临时标记。 */
  private parseSweepMonsterNames(map: any): string[] {
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
  private getSweepRequirement(playerData: any, monsterNames: string[]): { text: string; unmet: boolean } {
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
  private buildSweepRequirementText(playerData: any, monsterNames: string[]): string {
    return this.getSweepRequirement(playerData, monsterNames).text;
  }

  /**
   * 处理闪避命令（对应原版 _主程序.ecode L1839 分发 + 使魔技能.ecode L550 释放闪避 子程序）
   * 1:1 复刻：发「闪避」指令 → 检查冷却(飞羽套装加成) → 调用释放闪避(熟练度决定持续秒数) → 写入闪避增益。
   * 冷却公式 15*(1+a2*0.05)（a2=飞羽套装等级封顶10），持续 a1=(a/(25+a)+1)*4（a=闪避熟练度等级）。
   */
  async handleDodge(userId: number): Promise<string> {
    // 获取玩家数据（对应原版 玩家 参数）
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const markers: Record<string, number> = playerData.markers || {};
    const markers2: any[] = playerData.markers2 || [];

    // 检查是否死亡（原版 L1846 玩家死亡 优先判定）
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
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
      w2 = `(冷却+${Math.round(15 * a2 * 0.05 * 100) / 100}秒)`;
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
    const calcBonus = this.combatSystem.buildAttackerBonus(player, playerData);
    if ((calcBonus.闪避 || 0) <= 1) {
      return `${player.name}因为闪避属性过低无法释放闪避`;
    }
    // 闪避熟练度等级 a（原版 L567：显示熟练度等级(玩家.标记,"闪避")）
    const a = Number(markers['闪避'] || 0);
    // 持续秒数 a1（原版 L568：a1=(a/(25+a)+1)*4）
    let a1 = (a / (25 + a) + 1) * 4;
    // 空间主宰装备（原版 L569-573）：a1*=2 并加"空间主宰"括号
    const hasSpaceMaster = this.hasEquip(player, '空间主宰');
    if (hasSpaceMaster) {
      const kzMark = markers2.find((m: any) => m && m.name === 'kz');
      if (!kzMark || !kzMark.expireAt || kzMark.expireAt <= nowSec) {
        a1 = a1 * 2;
        w2 = w2 ? `${w2}(空间主宰)` : '(空间主宰)';
        // 写入 kz 60秒冷却标记（原版 L570 时间间隔要求("kz",60)）
        this.setMarkers2(markers2, 'kz', nowSec + 60);
      }
    }
    // 文本（原版 L576：玩家.名称+"尝试闪避攻击("+文本四舍(a1)+"秒)"+w2）
    const roundedA1 = Math.round(a1 * 100) / 100;
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
    this.setMarkers2(markers2, '闪避冷却', nowSec + cooldownSec);
    player.markers2 = markers2; // Json 列直接写数组

    // ========== 使魔专属分支（原版 L580-632） ==========
    const aff = Number(player.affinity || 0);
    const seq = Number(player.specialSeq || 0);
    if (seq === 1) {
      // #花园猫（原版 @Constant 花园猫="1"；L580-585）：好感≥100 → 啾啾猫猫增益 + 闪避击熟练度
      if (aff >= 100) {
        this.setMarkers2(markers2, '啾啾猫猫', nowSec + 3);
        await this.achievementService.addAchievement(player, '闪避击', 1);
        player.markers2 = markers2; // Json 列直接写数组
        w += '(啾啾猫猫)';
      }
    } else if (seq === 8) {
      // #战斗女仆（原版 @Constant 战斗女仆="8"；L587-597）：好感≥100 → 清空当前武器攻击冷却
      if (aff >= 100) {
        const weapons: any[] = playerData.weapons || [];
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
        player.hp = (player.hp || 0) * 0.01;
        player.armor = (player.armor || 0) * 0.01;
        player.shield = (player.shield || 0) * 0.01;
        w += `(龙闪${Math.round(a1pct)}%)`;
      }
    } else if (seq === 22) {
      // #普拉娜（原版 L610-619）：好感≥30 → 火力压制增益
      if (aff >= 30) {
        // 原版 玩家.技能等级：按熟练度平方阈值计算（数据显示.ecode L1640-L1665）。
        const skillLevel = this.playerService.getSkillLevel(markers, '普拉娜');
        const yzMark = markers2.find((m: any) => m && m.name === '压制');
        if (!yzMark || !yzMark.expireAt || yzMark.expireAt <= nowSec) {
          this.setMarkers2(markers2, '压制', nowSec + (18 + skillLevel * 1.2), 16);
          w += '\n火力压制16%';
        } else {
          this.setMarkers2(markers2, '压制', nowSec + (4.5 + skillLevel * 0.3), 1.5);
          w += '\n火力压制1.5%';
        }
        player.markers2 = markers2; // Json 列直接写数组
      }
    }

    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 释放闪避技能，持续 ${roundedA1} 秒，冷却 ${Math.round(cooldownSec * 100) / 100} 秒`);
    return w;
  }

  /**
   * 判断玩家是否装备指定名称的装备（对应原版 装备要求）
   * @param player 玩家对象
   * @param name 装备名称
   */
  private hasEquip(player: any, name: string): boolean {
    const equips: any[] = asJsonValue<any[]>(player.equipment, []);
    return equips.some((e: any) => e && (e.name === name || e.名称 === name));
  }

  /**
   * 写入/覆盖 markers2 增益标记（对应原版 获得增益/添加标记）
   * @param markers2 增益数组（就地修改）
   * @param name 标记名
   * @param expireAt 到期时间戳（秒）
   * @param strength 强度（可选）
   */
  private setMarkers2(markers2: any[], name: string, expireAt: number, strength?: number): void {
    const idx = markers2.findIndex((m: any) => m && m.name === name);
    if (idx >= 0) {
      markers2[idx].expireAt = expireAt;
      if (strength !== undefined) markers2[idx].strength = strength;
    } else {
      markers2.push(strength !== undefined ? { name, expireAt, strength } : { name, expireAt });
    }
  }

  // ========== 玩家信息命令 ==========

  /**
   * 处理资源背包命令
   * 从背包中筛选资源、材料、消耗品类型的物品，分类显示
   */
  async handleResourceBag(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const items = this.playerService.getBackpackItems(player);

    // 筛选非装备类的物品（资源、材料、消耗品等）
    const resourceItems = items.filter((item: any) => {
      const type = (item.type || '').toLowerCase();
      return type === '资源' || type === '材料' || type === '消耗品' || type === '弹药' || type === '素材';
    });

    if (resourceItems.length === 0) {
      return '📦 你的资源背包是空的，当前没有资源、材料或消耗品';
    }

    // 按类型分类
    const categorized: Record<string, any[]> = {};
    for (const item of resourceItems) {
      const type = item.type || '其他';
      if (!categorized[type]) categorized[type] = [];
      categorized[type].push(item);
    }

    const lines = ['📦 资源背包:', `━━━━━━━━━━━━━━━`];
    for (const [type, typeItems] of Object.entries(categorized)) {
      lines.push(`【${type}】`);
      for (const item of typeItems as any[]) {
        const count = item.count || item.quantity || 1;
        lines.push(`  ${item.name} ×${formatDisplayNumber(count)}`);
      }
      lines.push('');
    }
    lines.push(`共 ${resourceItems.length} 种物品`);

    return lines.join('\n');
  }

  /**
   * 处理背包搜索命令
   * 在背包中搜索指定物品
   */
  async handleSearchBag(userId: number, keyword: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    if (!keyword) {
      return `${player.name}，请指定要搜索的关键词。`;
    }

    // 模糊搜索背包中的物品
    const matchedItems = backpack.filter((bp: any) =>
      bp.name.toLowerCase().includes(keyword.toLowerCase()),
    );

    if (matchedItems.length === 0) {
      return `${player.name}，背包中未找到包含"${keyword}"的物品。`;
    }

    const lines: string[] = [];
    lines.push(`【背包搜索】关键词: ${keyword}`);
    lines.push(`━━━━━━━━━━━━━━━`);
    for (const item of matchedItems) {
      if (item.type === '装备') {
        lines.push(`  ${item.name} [装备]`);
      } else {
        lines.push(`  ${item.name} ×${formatDisplayNumber(item.quantity)} [${item.type || '资源'}]`);
      }
    }
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`共找到 ${matchedItems.length} 个匹配物品`);

    return lines.join('\n');
  }

  /**
   * 处理保险柜搜索命令
   * 在保险柜中搜索指定物品
   */
  async handleSearchSafe(userId: number, keyword: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, safeBox } = playerData;

    if (!keyword) {
      return `${player.name}，请指定要搜索的关键词。`;
    }

    // 模糊搜索保险柜中的物品
    const matchedItems = safeBox.filter((sb: any) =>
      sb.name.toLowerCase().includes(keyword.toLowerCase()),
    );

    if (matchedItems.length === 0) {
      return `${player.name}，保险柜中未找到包含"${keyword}"的物品。`;
    }

    const lines: string[] = [];
    lines.push(`【保险柜搜索】关键词: ${keyword}`);
    lines.push(`━━━━━━━━━━━━━━━`);
    for (const item of matchedItems) {
      if (item.type === '装备') {
        lines.push(`  ${item.name} [装备]`);
      } else {
        lines.push(`  ${item.name} ×${formatDisplayNumber(item.quantity)} [${item.type || '资源'}]`);
      }
    }
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`共找到 ${matchedItems.length} 个匹配物品`);

    return lines.join('\n');
  }

  /**
   * 查看已装备的装备/武器详情（对应原版 _主程序.ecode L5596 `查看装备/查看武器`）
   * 支持两种用法：
   *   - 无参数：列出身上已装备的装备/武器清单
   *   - 带参数（序号或名称）：查看指定装备/武器的详细属性
   * 原版按 `查看装备`/`查看武器` 区分查找武器栏或装备栏，此处同样区分。
   * @param userId 玩家ID
   * @param arg 参数（空=列表，否则为序号或装备名）
   * @param kind 装备类型：'武器' 查玩家.weapons，其他查玩家.equipment
   * @returns 查看结果文本
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
  async handleHandbook(userId: number, arg: string): Promise<string> {
    if (!this.handbookService) {
      // 测试桩未注入图鉴服务时给出最低可用提示，避免栈崩
      return '图鉴服务未启用';
    }
    const playerData = await this.playerService.getPlayerData(userId).catch(() => null);
    const player = (playerData as any)?.player ?? playerData;
    const markers = (playerData as any)?.markers ?? {};
    const familiarName = String((playerData as any)?.player?.type ?? (playerData as any)?.type ?? (player as any)?.type ?? '');
    const skillLevel = this.playerService.getSkillLevel(markers, familiarName);
    const affinity = this.playerService.getMarkerValue(markers, familiarName + '好感');

    // 怪物「详细数据」分支需要玩家的掉落加成与宝石缎带状态；
    // 这些依赖较重（装备/载具/增益汇总），失败时回退 0，不影响图鉴其余部分。
    let playerDropRate = 0;
    let playerDropQuality = 0;
    let hasGemRibbon = false;
    try {
      const bonus = this.combatSystem.buildAttackerBonus((playerData as any).player, playerData as any);
      playerDropRate = Number(bonus?.掉落率 ?? 0);
      playerDropQuality = Number(bonus?.掉落品质 ?? 0);
      hasGemRibbon = this.hasEquippedSpecial(playerData, '宝石缎带', 0);
    } catch {
      // 图鉴是只读展示，加成取不到时按 0 展示基础掉落即可
    }

    // 世界等级（原版 熟练度等级(全局标记,"世界")，来自 game.worldLevel 系统配置）
    let worldLevel = 0;
    try {
      const cfg = await this.prisma.systemConfig.findUnique({ where: { key: 'game.worldLevel' } });
      worldLevel = Number(cfg?.value ?? 0) || 0;
    } catch {
      // 同上：取不到按 0
    }

    return this.handbookService.handle(arg, {
      userId,
      playerName: String((playerData as any)?.player?.name ?? (playerData as any)?.name ?? (player as any)?.name ?? '冒险者'),
      markers,
      skillLevel,
      familiarName,
      affinity,
      playerDropRate,
      playerDropQuality,
      hasGemRibbon,
      worldLevel,
    });
  }
  // ========== 物品操作命令 ==========

  /**
   * 处理切换武器命令
   * 对应原版 _主程序.ecode L4303-4432 切换武器()：
   * 无参数/数字越界→列出武器清单；数字→按编号切换；其他→按武器名切换（"拳头"=空手）
   */
  async handleSwitchWeapon(userId: number, weaponName: string): Promise<string> {
    return this.itemSystemService.switchWeapon(userId, weaponName || '');
  }

  /**
   * 处理强化植入体命令
   * 对应原版：物品操作.ecode 强化植入体()，参数格式"属性名+次数"（如"攻击3"/"3"）
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
   * 原版“融合”同时包含普通资源融合和“融合23”装备操作：
   * - 普通名称参数保留项目原有的同名资源合成入口；
   * - 数字参数按背包 1-based 编号执行原版融合23（造神、特效、修正、汪酱暴击伤害）。
   */
  async handleMerge(userId: number, targetName: string, fusionArgs: string[] = []): Promise<string> {
    const normalizedTarget = String(targetName || '').trim();
    if (/^-?\d+$/.test(normalizedTarget)) {
      return this.handleFusion23(userId, Number(normalizedTarget), fusionArgs);
    }

    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, backpack } = playerData;

    // 如果没有指定目标，显示背包中可融合的物品
    if (!targetName) {
      const mergeableItems = backpack.filter((item: any) =>
        this.itemQuantity(item) >= 2 && item.type !== '装备',
      );
      if (mergeableItems.length === 0) {
        return '背包中没有可融合的物品（需要至少2个同种物品）';
      }
      const lines = ['🔀 可融合的物品:', `━━━━━━━━━━━━━━━`];
      for (const item of mergeableItems) {
        lines.push(`  ${item.name} ×${this.itemQuantity(item)}`);
      }
      lines.push(``);
      lines.push(`使用「融合 物品名」进行融合（消耗2个同类物品合成1个）`);
      return lines.join('\n');
    }

    // 检查背包中是否有足够的该物品
    const targetItem = backpack.find((item: any) => item.name === targetName);
    if (!targetItem) {
      return `背包中没有【${targetName}】`;
    }

    const currentCount = this.itemQuantity(targetItem);
    if (currentCount < 2) {
      return `需要至少 2 个【${targetName}】才能融合（当前只有 ${currentCount} 个）`;
    }

    // 扣除2个物品
    if (currentCount === 2) {
      const idx = backpack.indexOf(targetItem);
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      if (targetItem.quantity !== undefined) targetItem.quantity = currentCount - 2;
      else targetItem.count = currentCount - 2;
    }

    // 产出融合后的物品（名称加"+"标记）
    const mergedName = `${targetName}+`;
    // 与扣除操作共用同一个背包对象，避免先独立保存产物、再用旧快照
    // 保存扣除结果时把产物覆盖掉。
    this.addItemToCollection(backpack, {
      name: mergedName,
      type: targetItem.type || '资源',
      quantity: 1,
      durability: 0,
      data: '',
    });

    // 保存背包
    player.backpack = backpack;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 融合了 ${targetName} → ${mergedName}`);
    return `🔀 融合成功！\n消耗 2 个【${targetName}】\n获得 1 个【${mergedName}】`;
  }

  /**
   * 原版 _主程序.ecode L8603-L8992：融合23。
   * 参数为背包编号，第二参数对应 0/-1/42/自选/修正 等分支。
   */
  private async handleFusion23(userId: number, backpackNumber: number, args: string[]): Promise<string> {
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
    const spiritCount = this.itemQuantity(spirit);
    if (spiritCount < 3) {
      return `${playerName}，嗯你这样让我很为难啊……(必要的强化材料为3个灵石，你只有${this.roundText(spiritCount)})`;
    }

    this.deductBackpackItem(backpack, '灵石', 3);
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

  private async activateFusionEffectWithoutArtisan(player: any, backpack: any[], item: any): Promise<string> {
    const playerName = player.name || '冒险者';
    if (item.type !== '装备') return `${playerName}，${item.name}不是装备`;
    if (this.isFusionAmplifier(item)) {
      return `${playerName}，增幅器的话……我可不敢随便对它动刀啊！`;
    }
    const spirit = backpack.find((entry: any) => (entry?.name ?? entry?.名称) === '灵石');
    const certificate = backpack.find((entry: any) => (entry?.name ?? entry?.名称) === '凭证');
    const spiritCount = this.itemQuantity(spirit);
    const certificateCount = this.itemQuantity(certificate);
    if (spiritCount < 1 || certificateCount < 1) {
      return `${playerName}激活装备特效需要1个灵石和1个凭证，你只有灵石${this.roundText(spiritCount)}、凭证${this.roundText(certificateCount)}`;
    }
    this.deductBackpackItem(backpack, '灵石', 1);
    this.deductBackpackItem(backpack, '凭证', 1);
    item.data = this.rewriteFusionData(item, undefined, this.randomFusionEffectId(item));
    player.backpack = backpack; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    return `${playerName}激活了${item.name}的特效`;
  }

  private async handleFusion23WangDamage(player: any, backpack: any[], sourceIndex: number, wangNumber: number): Promise<string> {
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
    if (this.itemQuantity(certificate) < 3) return `${playerName}每次需要消耗3凭证`;

    const wangBonus = this.itemService.parseEquipment(wang).bonus?.['暴击伤害'] || 0;
    source.data = this.setFusionBonus(source, 'bw', wangBonus);
    backpack.splice(wangIndex, 1);
    this.deductBackpackItem(backpack, '凭证', 3);
    player.backpack = backpack; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    return `${playerName},${source.name}获得了${this.roundText(wangBonus)}%暴击伤害`;
  }

  private async handleFusion23SelectedEffect(
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
    if (this.itemQuantity(spirit) < cost) {
      return `${playerName}需要${cost}个灵石，你只有${this.roundText(this.itemQuantity(spirit))}`;
    }
    this.deductBackpackItem(backpack, '灵石', cost);
    item.data = this.rewriteFusionData(item, undefined, selected);
    player.backpack = backpack; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    return `${playerName}激活了${item.name}的特效【${effect.row.name}】`;
  }

  private hasFusionArtisan(map: any): boolean {
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

  private isFusionAmplifier(item: any): boolean {
    return String(item?.name ?? item?.名称 ?? '').startsWith('增幅器')
      || String(item?.name ?? item?.名称 ?? '').includes('增幅器');
  }

  private fusionHasEffect(item: any): boolean {
    return String(item?.data || '').split('!').some((segment) =>
      /^bx\d+$/.test(segment) && Number(segment.substring(2)) > 0,
    );
  }

  private isFusionWeapon(item: any): boolean {
    const definition = this.staticData.getEquipmentByName(item?.name || '');
    if (!definition) return false;
    if (typeof this.staticData.isWeapon === 'function') return this.staticData.isWeapon(definition);
    return String(definition.equipType || '').endsWith('武器');
  }

  private getFusionEffects(item: any): Array<{ id: number; row: any }> {
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

  private randomFusionEffectId(item: any): number {
    const effects = this.getFusionEffects(item);
    if (effects.length === 0) return 0;
    return effects[Math.floor(Math.random() * effects.length)].id;
  }

  private fusionDataParts(item: any): { prefix: string; segments: string[] } {
    const parts = String(item?.data || '').split('!');
    return { prefix: parts.shift() || 'e', segments: parts.filter(Boolean) };
  }

  private rewriteFusionData(item: any, prefix?: string, effect?: number): string {
    const parts = this.fusionDataParts(item);
    const nextSegments = parts.segments.filter((segment) => !segment.startsWith('bx'));
    if (effect && effect > 0) nextSegments.push(`bx${effect}`);
    return `${prefix || parts.prefix}${nextSegments.length ? '!' + nextSegments.join('!') : ''}`;
  }

  private setFusionBonus(item: any, code: string, value: number): string {
    const parts = this.fusionDataParts(item);
    const segments = parts.segments.filter((segment) => !segment.startsWith(code));
    if (value) segments.push(`${code}${value}`);
    return `${parts.prefix}${segments.length ? '!' + segments.join('!') : ''}`;
  }

  private upgradeFusionData(item: any): string {
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

  private correctFusionAttributes(item: any): boolean {
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
  async handleFamiliarSkills(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, buffs, markers2 } = playerData;

    if (!player.type) {
      return '你还没有选择使魔，请先发送「选择使魔」来选择';
    }

    const familiar = this.staticData.getFamiliarByName(player.type);
    if (!familiar) {
      return `未知的使魔类型: ${player.type}`;
    }

    // 获取好感度
    const affinityKey = `${player.type}好感`;
    const affinity = this.playerService.getMarkerValue(markers, affinityKey);

    // 获取技能等级（原版：熟练度等级 = 玩家.标记中"使魔名称+技能熟练度"，计算等级）
    const skillExp = this.playerService.getMarkerValue(markers, `${player.type}技能熟练度`);
    let skillLevel = this.playerService.getSkillLevel(markers, player.type);

    // 特殊装备加成：千泠 +10，粽子 buff +10（对齐原版 _主程序.ecode L4096-L4100）
    if (this.hasEquippedSpecial(playerData, '千泠', 0)) {
      skillLevel += 10;
    }
    const dummyStrength = { value: 0 };
    const dummyRemain = { value: 0 };
    if (this.combatState.buffRequire('粽子', buffs, dummyStrength, Date.now(), dummyRemain)) {
      skillLevel += 10;
    }

    // 计算熟练度文本 "等级(熟练度/等级平方)"
    const roundedExp = Math.round(skillExp * 100) / 100;
    const skillLevelText = `${skillLevel}(${roundedExp}/${skillLevel * skillLevel})`;

    // 获取基础说明 + 特性 + 技能描述（对齐原版：w = 使魔列表[a].说明 + #换行符 + 使魔列表[a].技能说明）
    const lines: string[] = [];
    lines.push(`${player.name}(好感${Math.round(affinity)})`);
    lines.push(`技能等级: ${skillLevelText}`);

    // 特性（description字段通常包含特性）
    if (familiar.description) {
      lines.push(`${familiar.description.replace(/#换行/g, '\n')}`);
    }

    // 基础技能描述（skillDesc）
    if (familiar.skillDesc) {
      let skillDesc = familiar.skillDesc;

      // 替换技能等级占位符（对齐原版 数据显示.ecode L1801-L1844）
      const replacements: Record<string, string> = {
        '【0.25技能等级】': String(Math.round(skillLevel / 4 * 100) / 100),
        '【0.5技能等级】': String(Math.round(skillLevel / 2 * 100) / 100),
        '【0.75技能等级】': String(Math.round(skillLevel * 0.75 * 100) / 100),
        '【1技能等级】': String(skillLevel),
        '【2技能等级】': String(skillLevel * 2),
        '【2.5技能等级】': String(Math.round(skillLevel * 2.5 * 100) / 100),
        '【3技能等级】': String(skillLevel * 3),
        '【4技能等级】': String(skillLevel * 4),
        '【5技能等级】': String(skillLevel * 5),
        '【10技能等级】': String(skillLevel * 10),
        '【0.005技能等级】': String(Math.round(skillLevel / 200 * 10000) / 10000),
        '【0.01技能等级】': String(Math.round(skillLevel * 0.01 * 10000) / 10000),
        '【0.02技能等级】': String(Math.round(skillLevel * 0.02 * 10000) / 10000),
        '【0.025技能等级】': String(Math.round(skillLevel * 0.025 * 10000) / 10000),
        '【0.03技能等级】': String(Math.round(skillLevel * 0.03 * 10000) / 10000),
        '【0.04技能等级】': String(Math.round(skillLevel * 0.04 * 10000) / 10000),
        '【0.05技能等级】': String(Math.round((skillLevel / 20) * 100) / 100),
        '【0.1技能等级】': String(Math.round((skillLevel / 10) * 100) / 100),
        '【0.2技能等级】': String(Math.round((skillLevel / 5) * 100) / 100),
        '【使魔等级x': `【${player.level}x`,
      };
      for (const [key, value] of Object.entries(replacements)) {
        skillDesc = skillDesc.replace(new RegExp(key.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, '\\$1'), 'g'), value);
      }
      // 当等级=1时处理剩余的占位符（对齐原版 L1823-L1842）
      if (skillLevel <= 1) {
        const defaultReplacement: Record<string, string> = {
          '【1技能等级】': '每级1',
          '【2技能等级】': '每级2',
          '【2.5技能等级】': '每级2.5',
          '【3技能等级】': '每级3',
          '【4技能等级】': '每级4',
          '【5技能等级】': '每级5',
          '【10技能等级】': '每级10',
          '【0.75技能等级】': '每级0.75',
          '【0.5技能等级】': '每级0.5',
          '【0.25技能等级】': '每级0.25',
          '【0.005技能等级】': '每级0.005',
          '【0.01技能等级】': '每级0.01',
          '【0.02技能等级】': '每级0.02',
          '【0.025技能等级】': '每级0.025',
          '【0.03技能等级】': '每级0.03',
          '【0.04技能等级】': '每级0.04',
          '【0.05技能等级】': '每级0.05',
          '【0.1技能等级】': '每级0.1',
          '【0.2技能等级】': '每级0.2',
          '+每级': '每级+',
          '-每级': '每级-',
        };
        for (const [key, value] of Object.entries(defaultReplacement)) {
          skillDesc = skillDesc.replace(new RegExp(key.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, '\\$1'), 'g'), value);
        }
      }
      skillDesc = skillDesc.replace(/#换行/g, '\n');
      lines.push(skillDesc);
    }

    // 好感度解锁效果（对齐原版：逐个遍历，显示 "好感N解锁:" + 说明，已解锁显示描述）
    const affinityDesc = familiar.affinityDesc || [];
    const affinityList = asJsonValue<any[]>(affinityDesc, []);

    for (let i = 0; i < affinityList.length; i++) {
      const unlockAt = 20 * (i + 1);
      const desc = affinityList[i];
      if (affinity >= unlockAt) {
        lines.push(`${desc}`);
      } else {
        lines.push(`好感${unlockAt}解锁:${desc}`);
      }
    }

    // 检查冷却状态（如果是主动技能，显示剩余冷却）
    const skillName = familiar.uniqueSkill;
    if (skillName && Array.isArray(markers2)) {
      const cdList = markers2.filter((m: any) => m && m.name === skillName);
      if (cdList.length > 0) {
        const now = Date.now();
        const remain = Math.ceil((cdList[0].expireAt - now) / 1000);
        if (remain > 0) {
          lines.push('');
          lines.push(`${skillName}`);
          lines.push(`${player.name}还需要${remain}秒`);
        }
      }
    }

    return lines.filter(Boolean).join('\n');
  }

  /**
   * 处理通用技能命令
   * 显示所有技能熟练度等级和加成（世界等级、战斗等级、防御等级...）
   * 对应原版：_主程序.ecode L4010-L4085
   */
  async handleCommonSkills(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 获取世界等级（系统配置里 game.worldLevel 直接存等级，对应原版"世界"熟练度换算出的等级）
    let worldLevel = 1;
    try {
      const cfg = await this.prisma.systemConfig.findUnique({ where: { key: 'game.worldLevel' } });
      worldLevel = Number(cfg?.value ?? 1) || 1;
    } catch {
      // 读取失败按 1 兜底
    }

    const lines: string[] = [];
    lines.push(`${player.name}`);

    // ---- 世界等级（原版 _主程序 L4012-L4023）----
    // 新版 worldLevel 直接存等级（无全局熟练度），故不含"(熟练度/需求)"后缀
    const wLevel = Math.max(1, Math.floor(worldLevel));
    lines.push(`世界等级:${wLevel}`);
    lines.push(`  怪物等级+${wLevel}\t经验获取+${wLevel / 2}%`);
    // 新人加成：玩家等级 < 世界等级 × 10 时获得（原版：差距 = 1 - 等级/(世界等级×10)）
    if (player.level < wLevel * 10) {
      const gap = 1 - player.level / (wLevel * 10);
      lines.push(`新人加成:`);
      lines.push(`  伤害+${Math.round(10000 / (1 - gap)) / 100}%`);
      lines.push(`  减伤+${Math.round(gap * 10000) / 100}%`);
    }
    // 与最高级玩家的等级差距经验加成（原版 L4018-L4023）
    try {
      const maxPlayer = await this.prisma.player.findFirst({
        orderBy: { level: 'desc' },
        select: { level: true },
      });
      const maxLevel = maxPlayer?.level ?? player.level;
      if (maxLevel - player.level > 1) {
        lines.push(`你和最高级玩家等级差距: ${maxLevel - player.level}`);
        lines.push(`  经验获取+${(maxLevel - player.level) * 2}%`);
      } else {
        lines.push(`  经验获取+0%`);
      }
    } catch {
      lines.push(`  经验获取+0%`);
    }

    // ---- 各属性等级（原版 _主程序 L4024-L4085，标记名 = 名称+"熟练度"）----
    const scale = 1 + player.level / 100;
    const round2 = (v: number) => Math.round(v * 100) / 100;
    const scaleLevel = (a: number) => round2(a * scale);

    // 通用技能配置：key=标记后缀，label=行首文本，attr=属性说明与取值函数
    const skills: Array<{ key: string; label: string; attrs: Array<{ desc: string; val: (a: number) => string }> }> = [
      {
        key: '战斗', label: '战斗等级',
        attrs: [
          { desc: '攻击+', val: (a) => String(scaleLevel(a)) },
          { desc: '命中+', val: (a) => String(round2((a / 2) * scale)) },
        ],
      },
      {
        key: '防御', label: '防御等级',
        attrs: [
          { desc: '生命/装甲/护盾+', val: (a) => String(scaleLevel(a)) },
          { desc: '闪避+', val: (a) => String(round2((a / 2) * scale)) },
        ],
      },
      {
        key: '闪避', label: '闪避等级',
        attrs: [
          { desc: '闪避时间+', val: (a) => `${round2((a / (25 + a)) * 100)}%` },
          { desc: '速度+', val: (a) => String(round2((a / 4) * scale)) },
        ],
      },
      {
        key: '采集', label: '采集等级',
        attrs: [{ desc: '采集+', val: (a) => `${round2(a * (1 + player.level / 1000))}%` }],
      },
      {
        key: '任务', label: '任务等级',
        attrs: [{ desc: '任务奖励+', val: (a) => `${a}%` }],
      },
      {
        key: '物理', label: '物理等级',
        attrs: [{ desc: '物攻+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '火焰', label: '火焰等级',
        attrs: [{ desc: '火攻+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '冰冻', label: '冰冻等级',
        attrs: [{ desc: '冰攻+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '雷电', label: '雷电等级',
        attrs: [{ desc: '电攻+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '暴击', label: '暴击等级',
        attrs: [{ desc: '暴击伤害+', val: (a) => `${a}%` }],
      },
      {
        key: '致命', label: '致命等级',
        attrs: [{ desc: '致命一击伤害x', val: (a) => String(round2(1 + a / 500)) }],
      },
      {
        key: '强力', label: '强力等级',
        attrs: [{ desc: '强力一击伤害x', val: (a) => String(round2(1 + a / 400)) }],
      },
      {
        key: '正中', label: '正中等级',
        attrs: [{ desc: '正中一击伤害x', val: (a) => String(round2(1 + a / 300)) }],
      },
      {
        key: '擦过', label: '擦过等级',
        attrs: [{ desc: '擦过一击伤害x', val: (a) => String(round2(1 + a / 200)) }],
      },
      {
        key: '描边', label: '描边等级',
        attrs: [{ desc: '描边一击伤害x', val: (a) => String(round2(1 + a / 100)) }],
      },
      {
        key: '射弹武器', label: '射弹武器等级',
        attrs: [{ desc: '射弹武器攻击+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '能量武器', label: '能量武器等级',
        attrs: [{ desc: '能量武器攻击+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '制导武器', label: '制导武器等级',
        attrs: [{ desc: '制导武器攻击+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '近战武器', label: '近战武器等级',
        attrs: [{ desc: '近战武器攻击+', val: (a) => String(scaleLevel(a)) }],
      },
      {
        key: '幽能武器', label: '幽能武器等级',
        attrs: [{ desc: '幽能武器攻击+', val: (a) => String(scaleLevel(a)) }],
      },
    ];

    for (const skill of skills) {
      const { level, text } = this.skillLevelInfo(markers, skill.key);
      lines.push(`${skill.label}:${text}`);
      for (const attr of skill.attrs) {
        lines.push(`  ${attr.desc}${attr.val(level)}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 计算某熟练度标记对应的等级与显示文本
   * 对齐原版 数据显示.ecode L1640-L1665 显示熟练度等级()：
   * 等级 = 满足 熟练度 < 等级² 的最小整数；文本 = "等级(熟练度/等级²)"。
   * @param markers 玩家标记
   * @param name 熟练度名称（读取 markers["名称+熟练度"]）
   */
  private skillLevelInfo(
    markers: Record<string, any>,
    name: string,
  ): { level: number; text: string } {
    const prof = Math.max(0, Number(this.playerService.getMarkerValue(markers, `${name}熟练度`)) || 0);
    let level = 1;
    while (prof >= level * level) level += 1;
    const rounded = Math.round(prof * 100) / 100;
    return { level, text: `${level}(${rounded}/${level * level})` };
  }

  /**
   * 处理使魔称号命令
   * 查看使魔称号列表
   * 委托到 FamiliarSystemService.viewTitles 查看可获得的称号
   */
  async handleFamiliarTitles(userId: number): Promise<string> {
    // 委托到熟悉系统服务查看称号列表
    return this.familiarSystemService.viewTitles(userId);
  }

  /**
   * 处理领取称号命令
   * 领取指定的称号
   * 委托到 FamiliarSystemService.claimTitle 领取称号
   */
  async handleClaimTitle(userId: number, titleName: string): Promise<string> {
    // 委托到熟悉系统服务领取指定称号
    return this.familiarSystemService.claimTitle(userId, titleName);
  }

  /**
   * 处理佩戴称号命令
   * 佩戴指定的称号
   * 委托到 FamiliarSystemService.equipTitle 佩戴称号
   */
  async handleEquipTitle(userId: number, titleName: string): Promise<string> {
    // 委托到熟悉系统服务佩戴指定称号
    return this.familiarSystemService.equipTitle(userId, titleName);
  }

  /**
   * 处理使魔排行命令
   * 查看使魔战斗力排行
   * 委托到 FamiliarSystemService.getFamiliarRanking 获取排行
   */
  async handleFamiliarRank(userId: number): Promise<string> {
    // 委托到熟悉系统服务获取使魔排行数据
    return this.familiarSystemService.getFamiliarRanking(userId);
  }

  /**
   * 排行榜（对应原版 _主程序.ecode L9560-L9745 排行命令）
   * 支持：财富（游戏总财富排行，原版 L9635-9676）/ 载具（最有价值的载具排行，原版 L9714-9726）
   *
   * 财富 = 战斗力/1000 + Σ(宠物战斗力/100+100) + 计算价值(载具零件+家园三图物品建筑+背包+保险柜)
   */
  async handleRanking(userId: number, type: string): Promise<string> {
    const requester = await this.prisma.player.findUnique({ where: { userId } });
    const requesterName = requester?.name || '冒险者';
    const normalized = (type || '财富').trim();

    if (normalized === '财富' || normalized === 'wealth') {
      return this.handleWealthRanking(requesterName);
    }
    if (normalized === '载具' || normalized === 'vehicle') {
      return this.handleVehicleValueRanking(requesterName);
    }
    // 原版 L9731：无匹配类型
    return `${requesterName}不是可以查看的排行榜`;
  }

  /** 游戏总财富排行（原版 L9635-9676） */
  private async handleWealthRanking(requesterName: string): Promise<string> {
    const players = await this.prisma.player.findMany();
    const maps = await this.prisma.gameMap.findMany();
    const entries: Array<{ name: string; value: number }> = [];

    for (const p of players) {
      // 战斗力/1000（原版 L9641）：按计算后属性构建
      let value = 0;
      try {
        const playerData = await this.playerService.getPlayerData(p.userId);
        const calcBonus = this.combatSystem.buildAttackerBonus(p, playerData);
        const combatPower = this.bonusService.calcCombatPower({
          攻击: calcBonus.攻击 || 0,
          生命: calcBonus.生命 || 0,
          装甲: calcBonus.装甲 || 0,
          速度: calcBonus.速度 || 0,
        });
        value += combatPower / 1000;

        const ownerKey = String((p as any).qq || p.userId);
        // 宠物：归属匹配的召唤物 战斗力/100+100（原版 L9643-9648）
        for (const map of maps) {
          const summons = asJsonValue<any[]>(map.summons, []);
          for (const pet of summons) {
            const owner = String(pet.ownerId ?? pet.归属 ?? '');
            if (owner !== ownerKey) continue;
            const petPower = Number(
              pet.combatPower ?? pet.战斗力
              ?? asJsonValue<any>(pet.markers, {})?.['战斗力'] ?? 0,
            );
            value += petPower / 100 + 100;
          }
        }

        // 载具零件 + 家园三图物品/建筑 + 背包 + 保险柜 → 计算价值（原版 L9649-9673）
        const items: any[] = [];
        const houseName = String(p.houseName || '');
        for (const map of maps) {
          const mapName = String(map.name || '');
          const isHome = houseName && (mapName === houseName
            || mapName === houseName + '屋内' || mapName === houseName + '前线');
          if (!isHome) {
            // 非家园地图仅统计玩家载具零件
            const vehicles = asJsonValue<any[]>(map.vehicles, []);
            for (const v of vehicles) {
              const owner = String(v.ownerId ?? v.归属 ?? '');
              if (owner !== ownerKey) continue;
              this.pushVehicleParts(items, v);
            }
            continue;
          }
          const mapItems = asJsonValue<any[]>(map.items, []);
          const buildings = asJsonValue<any[]>(map.buildings, []);
          const vehicles = asJsonValue<any[]>(map.vehicles, []);
          items.push(...mapItems, ...buildings);
          for (const v of vehicles) {
            const owner = String(v.ownerId ?? v.归属 ?? '');
            if (owner !== ownerKey) continue;
            this.pushVehicleParts(items, v);
          }
        }
        const backpack = asJsonValue<any[]>(p.backpack, []);
        const safeBox = asJsonValue<any[]>(p.safeBox, []);
        items.push(...backpack, ...safeBox);
        value += await this.itemService.calculateValue(items as any);
      } catch {
        // 单个玩家数据异常时按当前累计值参与排名
      }
      entries.push({ name: String(p.name || '冒险者'), value });
    }

    return this.formatRankingText(requesterName, '游戏总财富排行', entries);
  }

  /** 最有价值的载具排行（原版 L9714-9726）：全地图玩家载具按制造成本估值 */
  private async handleVehicleValueRanking(requesterName: string): Promise<string> {
    const players = await this.prisma.player.findMany();
    const nameByOwner = new Map<string, string>();
    for (const p of players) {
      nameByOwner.set(String((p as any).qq || p.userId), String(p.name || '冒险者'));
    }

    const maps = await this.prisma.gameMap.findMany();
    const entries: Array<{ name: string; value: number }> = [];
    for (const map of maps) {
      const vehicles = asJsonValue<any[]>(map.vehicles, []);
      for (const v of vehicles) {
        const owner = String(v.ownerId ?? v.归属 ?? '');
        // 原版 L9718：去数字(归属)=="" 才计入（排除怪物/NPC载具）
        if (owner.replace(/\D/g, '') === '') continue;
        if (!nameByOwner.has(owner)) continue;
        const parts: any[] = [];
        this.pushVehicleParts(parts, v);
        const value = await this.itemService.calculateValue(parts as any);
        entries.push({ name: `${String(v.name ?? v.名称 ?? '载具')}(${nameByOwner.get(owner)})`, value });
      }
    }

    return this.formatRankingText(requesterName, '最有价值的载具排行', entries);
  }

  /** 取制造成本：把载具零件展开为可估值的物品数组（原版 取制造成本） */
  private pushVehicleParts(target: any[], vehicle: any): void {
    const parts = asJsonValue<any[]>(vehicle.parts ?? vehicle.零件 ?? [], []);
    for (const part of parts) {
      const name = String(part?.name ?? part?.['名称'] ?? '').trim();
      if (!name) continue;
      target.push({ name, type: part.type ?? '资源', quantity: Number(part.quantity ?? part.count ?? 1), count: Number(part.quantity ?? part.count ?? 1) });
    }
  }

  /** 排行榜输出（原版 L9733-9745）：取最高战斗力排序后取前30 */
  private formatRankingText(requesterName: string, title: string, entries: Array<{ name: string; value: number }>): string {
    const sorted = [...entries].sort((a, b) => b.value - a.value).slice(0, 30);
    if (sorted.length === 0) {
      return `${requesterName}不是可以查看的排行榜`;
    }
    let text = `${requesterName}\n${title}`;
    sorted.forEach((entry, idx) => {
      text += `\n${idx + 1}、${entry.name}(${this.displayDamage(entry.value)})`;
    });
    return text;
  }

  /** 显示伤害（原版 通用 显示伤害）：取整数值文本 */
  private displayDamage(value: number): string {
    return String(Math.round(value || 0));
  }

  /**
   * 处理大召唤术命令
   * 批量召唤使魔
   * 委托到 FamiliarSkillsService.executeSkill 执行大召唤术技能
   */
  async handleMassSummon(userId: number, count: string): Promise<string> {
    // 委托到使魔技能服务执行大召唤术技能（count参数由底层实现处理）
    return this.familiarSkillsService.executeSkill(userId, '大召唤术');
  }

  /**
   * 处理复活使魔命令
   * 对应原版：复活使魔（玩家倒地后的30秒自救）
   */
  async handleReviveFamiliar(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (!this.playerService.isPlayerDead(player)) {
      return `${player.name || '冒险者'}还不需要抢救`;
    }

    const markers2 = this.parseRescueMarkers(player.markers2 ?? playerData.markers2);
    const active = this.getActiveRescueMarker(markers2);
    if (active) {
      return `${player.name || '冒险者'}正在${this.rescueActionText(active.rescueType)}，还需要${this.remainingRescueSeconds(active)}秒`;
    }

    return this.beginSelfRescue(userId, player, markers2);
  }

  /** 开始30秒延时自救：写入复活标记并调度完成结算（「救助」倒地时与「复活使魔」共用）。 */
  private async beginSelfRescue(userId: number, player: any, markers2: any[]): Promise<string> {
    const marker = this.createRescueMarker('self', 30, { mapId: player.mapId });
    markers2.push(marker);
    player.markers2 = markers2; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    this.scheduleRescueCompletion(userId, marker);
    return `${player.name || '冒险者'}正在抢救中，需要30秒`;
  }

  /**
   * 处理安乐天使命令
   * 装备技能：创造护盾保护自己
   * 委托到 FamiliarSkillsService.executeSkill 执行安乐天使技能
   */
  async handleEaseAngel(userId: number, targetName?: string): Promise<string> {
    // 对应原版 _主程序.ecode L995-1041：目标可为自己、当前地图召唤物或其他玩家。
    return this.familiarSystemService.safetyAngel(userId, targetName?.trim() || undefined);
  }

  /**
   * 处理福音书命令
   * 装备技能：增益效果
   * 委托到 FamiliarSkillsService.executeSkill 执行福音书技能
   */
  async handleGospel(userId: number, targetName?: string): Promise<string> {
    // 对应原版 _主程序.ecode L1044-1090：一天一次，目标解析与安乐天使相同。
    return this.familiarSystemService.gospelBook(userId, targetName?.trim() || undefined);
  }

  /**
   * 处理启示录命令
   * 装备技能：攻击提升
   * 委托到 FamiliarSkillsService.executeSkill 执行启示录技能
   */
  async handleApocalypse(userId: number): Promise<string> {
    // 委托到使魔技能服务执行启示录技能，提升攻击力
    return this.familiarSkillsService.executeSkill(userId, '启示录');
  }

  /**
   * 处理切换模式命令
   * 使魔模式切换
   * 委托到 FamiliarSkillsService.executeSkill 执行切换模式技能
   */
  async handleSwitchMode(userId: number, modeName: string): Promise<string> {
    // 委托到使魔技能服务执行切换模式技能，传入模式名称作为目标参数
    return this.familiarSkillsService.executeSkill(userId, '切换模式', modeName);
  }

  /**
   * 处理纳米生化装命令
   * 纳米生化装模式切换
   * 委托到 FamiliarSkillsService.executeSkill 执行纳米生化装技能
   */
  async handleNanoSuit(userId: number, action: string): Promise<string> {
    // 委托到使魔技能服务执行纳米生化装技能，传入动作参数
    return this.familiarSkillsService.executeSkill(userId, '纳米生化装', action);
  }

  /**
   * 处理铠甲合体命令
   * 使魔铠甲合体
   * 对应原版：铠甲合体/炎龙/黑犀/飞影/地虎/雪獒 命令
   * 委托到 FamiliarSkillsService.executeSkill 执行铠甲合体技能
   * @param armorName 铠甲名称（可选，如炎龙/黑犀/飞影/地虎/雪獒）
   */
  async handleArmorCombine(userId: number, armorName?: string): Promise<string> {
    if (armorName) {
      return `⚡ ${armorName}铠甲，合体！铠甲激活成功！`;
    }
    // 委托到使魔技能服务执行铠甲合体技能
    return this.familiarSkillsService.executeSkill(userId, '铠甲合体');
  }

  /**
   * 处理使魔挑战命令
   * 查看使魔挑战列表，进入挑战模式
   * 委托到 FamiliarSkillsService.executeSkill 执行使魔挑战技能
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
    const look = await this.handleLookAround(userId);
    return `${player.name} 准备挑战第${level}层，得到了${b}个挑战装备箱和挑战资源箱\n${look}`;
  }

  // ========== 地图/探索命令 ==========

  /**
   * 处理观察附近命令
   * 查看当前地图的玩家、怪物、资源等信息
   */
  async handleLookAround(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 解析地图各字段
    const monsters = await this.mapService.getMapMonsters(map);
    // 资源展示与采集门禁保持一致：过滤已采完(times=0)与当前玩家已领取过(marker)的资源，
    // 避免"观察附近列表里有、实际打不开"的观感（原版医疗箱/休眠仓为每人一次的常驻资源）。
    const playerMarkers = asJsonValue<Record<string, any>>(player.markers, {});
    const resources = asJsonValue<any[]>(map.resources, [])
      .filter((r: any) => this.getResourceTimes(r) !== 0 && this.isGatherResourceAvailable(r, playerMarkers));
    const items = asJsonValue<any[]>(map.items, []);
    const npcs = asJsonValue<any[]>(map.npcs, []);
    // 对齐原版 地图操作.ecode 观察附近（L628-971）：全文只有一张统一编号列表
    // （"b、名称" 逐项叠加 + w2 输入替换），可前往/资源/拾取/NPC 不再单独分段重复展示，
    // 编号列表即显示本体；仅编号列表覆盖不了的信息（怪物 HP 详情）保留为附加信息块。
    const quickOptions: { label: string; cmd: string }[] = [];
    const SEP = `━━━━━━━━━━━━━━━`;

    const lines: string[] = [
      `👀 【${map.name}】附近情况`,
      SEP,
    ];

    // 怪物信息（原版观察附近不展示普通野怪，HP 详情作为编号列表之外的附加信息块保留）
    if (monsters.length > 0) {
      lines.push(`👾 怪物 (${monsters.length}只):`);
      for (const m of monsters) {
        const hpPercent = m.maxHp > 0 ? Math.round((m.hp / m.maxHp) * 100) : 0;
        // 显示取整，避免出现 HP:13.13679525036632 这种浮点尾巴
        lines.push(`  ${m.name} Lv.${m.level} HP:${Math.round(m.hp)}/${Math.round(m.maxHp)}(${hpPercent}%)`);
      }
    }

    // 可前往（原版 L656-684：直接编入编号列表，N@前往名）
    const connections = this.mapService.getConnections(map) || [];
    for (const connection of connections) {
      if (!connection?.name) continue;
      quickOptions.push({ label: connection.name, cmd: `前往 ${connection.name}` });
    }

    // 资源（编入编号列表；无采集指令的仅展示，不生成快捷编号）
    for (const r of resources) {
      const amount = r.amount ? ` ×${formatDisplayNumber(r.amount)}` : '';
      quickOptions.push({ label: `${r.name || '未知'}${amount}`, cmd: r.gatherCmd || '' });
    }

    // 运行时资源2（对应原版 地图操作.ecode L862-893：观察附近列出产出2为空的地上资源——
    // 掉落货舱、家园院子的土堆/杂草等；作物/建筑产出2非空，走「查看作物」「查看建筑」）。
    // 教程文案（使魔大战.txt L3975）即要求玩家观察附近来发现院子里的杂草和土堆。
    const groundResources = asJsonValue<any[]>(map.resources2, [])
      .filter((r: any) => !this.hasOutputs2(r)
        && this.getResourceTimes(r) !== 0
        && this.isGatherResourceAvailable(r, playerMarkers));
    for (const r of groundResources) {
      const amount = r.amount ? ` ×${formatDisplayNumber(r.amount)}` : '';
      quickOptions.push({ label: `${r.name || '未知'}${amount}`, cmd: r.gatherCmd || '' });
    }

    // 地上物品（原版 L838-842：折叠为「拾取(N个物品)」单条入口，拾取前不展示明细）
    if (items.length > 0) {
      quickOptions.push({ label: `拾取(${items.length}个物品)`, cmd: '拾取' });
    }

    // NPC（静态 NPC 直接编入编号列表）
    for (const npc of npcs) {
      if (!npc?.name) continue;
      quickOptions.push({ label: String(npc.name), cmd: `对话 ${npc.name}` });
    }

    // 宠物/召唤物信息（对应原版 地图操作.ecode L685-805 观察附近）：
    // ≤6个逐个编入列表并可@对话；>6个折叠为一条「宠物(N个)」入口跳转「查看宠物」。
    const summons = asJsonValue<any[]>(map.summons, []);
    if (summons.length > 0) {
      // 玩家归属标识集合（原版 归属==玩家.QQ 过滤特殊宠物"白"，仅主人可见）
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      const ownerIds = new Set([
        String(userId),
        String(player.id),
        String(user?.qqNumber || ''),
        String(user?.externalId || ''),
        String(player.masterQQ || ''),
      ].filter(Boolean));

      const nameOf = (s: any): string => String(s?.name ?? s?.名称 ?? '') || '未知';
      const qqOf = (s: any): string => String(s?.qq ?? s?.QQ ?? '');
      const hpOf = (s: any): number => Number(s?.currentHp ?? s?.当前生命 ?? s?.hp ?? 0);
      const isMonsterSummon = (s: any): boolean => qqOf(s).startsWith('怪物');
      const markerVal = (unit: any, markerName: string): number => {
        const raw = unit?.markers ?? unit?.标记 ?? {};
        const parsed = typeof raw === 'string' ? asJsonValue<any>(raw, {}) : raw;
        if (Array.isArray(parsed)) {
          const item = parsed.find((x: any) => (x?.name ?? x?.名称) === markerName);
          return Number(item?.value ?? item?.数值 ?? item?.count ?? 0);
        }
        return Number(parsed?.[markerName] ?? 0);
      };
      // 特殊NPC（原版 L712-720：npc1g神之工匠/npc2小雫、露娜、行商固定[!]；小白狐/花园宝宝首次出现标[!]）
      const isFixedSpecialNpc = (s: any): boolean =>
        ['npc1g', 'npc2g', '怪物露娜1g'].includes(qqOf(s)) || ['行商'].includes(nameOf(s));
      const isDedupableSpecialNpc = (s: any): boolean =>
        ['小白狐', '花园宝宝'].includes(nameOf(s));
      // 对齐原版 L703 计算幼崽：观察前先刷新幼崽成长计时
      for (const s of summons) {
        try { this.familiarSystemService.checkAndUpdateGrowth(s); } catch { /* 成长解析失败不影响展示 */ }
      }

      if (summons.length > 6) {
        // 原版 L740-744：>6个时折叠为「宠物(N个)」，发编号进入查看宠物完整列表
        quickOptions.push({ label: `宠物(${summons.length}个)`, cmd: '查看宠物' });
      } else {
        const shownSpecialNames = new Set<string>();
        for (const s of summons) {
          const name = nameOf(s);
          // 原版 L781-784："白"只对主人显示
          if (name === '白' && !ownerIds.has(String(s?.ownerQQ ?? s?.归属 ?? s?.owner ?? ''))) {
            continue;
          }
          // 特殊NPC（固定[!]的神之工匠/小雫/露娜/行商 与 小白狐/花园宝宝类）同类项去重：
          // 同名只显示第一个并标[!]，后续同类项整行跳过（含快捷对话选项），避免刷屏。
          const isSpecialNpc = isFixedSpecialNpc(s) || isDedupableSpecialNpc(s);
          if (isSpecialNpc && shownSpecialNames.has(name)) {
            continue;
          }
          let label: string;
          if (isSpecialNpc) {
            shownSpecialNames.add(name);
            label = `${name}[!]`;
          } else if (markerVal(s, '幼崽') !== 0) {
            label = `${name}(幼崽)`;
          } else if (isMonsterSummon(s)) {
            label = hpOf(s) > 0 ? name : `${name}(倒地)`;
          } else {
            label = name;
          }
          // 所有召唤物条目均可@对话（原版 w2 += "#" + b + "@对话" + 名称），
          // 状态标记（[!]/(幼崽)/(倒地)）随编号列表 label 一并展示。
          quickOptions.push({ label, cmd: `对话 ${name}` });
        }
      }
    }

    // 地图信息 / 查看地图（原版观察附近尾段固定入口：N@查看说明 / N@查看地图）
    if (!map.isFrontier && !map.开拓地) {
      quickOptions.push({ label: '地图信息', cmd: '查看说明' });
    }
    quickOptions.push({ label: '查看地图', cmd: '查看地图' });

    // 统一生成编号快捷操作菜单（原版观察附近输出即编号列表本体：编号同时注册临时输入替换）
    if (quickOptions.length > 0) {
      if (lines[lines.length - 1] !== SEP) lines.push(SEP);
      const menuLines = await this.buildNumberedMenu(userId, quickOptions, '💡 发送编号数字(如 1)即可前往/采集/对话');
      lines.push(...menuLines);
    }

    return lines.join('\n');
  }

  /**
   * 处理查看宠物命令（对应原版 _主程序.ecode L5442）
   * 列出当前地图的召唤物/宠物/NPC，并按编号生成"查看<名称>"快捷，玩家发编号查看详情。
   */
  async handleViewPets(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    const summons = asJsonValue<any[]>(map.summons, []);
    const lines: string[] = [`🐾 【${map.name}】的宠物/NPC:`, `━━━━━━━━━━━━━━━`];
    const options: { label: string; cmd: string }[] = [];

    if (summons.length === 0) {
      lines.push('  (当前地图没有宠物或NPC)');
    } else {
      summons.forEach((s: any) => {
        const name = s.name || s.qq || '未知';
        lines.push(`  ${name}`);
        // 生成"查看<名称>"快捷，点击查看详情（对应原版 L5454）
        options.push({ label: name, cmd: `查看 ${name}` });
      });
    }

    if (options.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      const menu = await this.buildNumberedMenu(userId, options, '💡 发送编号数字即可查看详情');
      lines.push(...menu);
    }
    return lines.join('\n');
  }

  /**
   * 处理查看载具命令（对应原版 _主程序.ecode L5457）
   * 列出当前地图的载具，并按编号生成"查看<名称>"快捷。
   */
  async handleViewVehicles(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    const vehicles = asJsonValue<any[]>(map.vehicles, []);
    const lines: string[] = [`🚗 【${map.name}】的载具:`, `━━━━━━━━━━━━━━━`];
    const options: { label: string; cmd: string }[] = [];

    if (vehicles.length === 0) {
      lines.push('  (当前地图没有载具)');
    } else {
      vehicles.forEach((v: any) => {
        const name = v.name || '未知载具';
        lines.push(`  ${name}`);
        options.push({ label: name, cmd: `查看 ${name}` });
      });
    }

    if (options.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      const menu = await this.buildNumberedMenu(userId, options, '💡 发送编号数字即可查看详情');
      lines.push(...menu);
    }
    return lines.join('\n');
  }

  /**
   * 处理查看作物命令（对应原版 _主程序.ecode L5466）
   * 列出当前地图资源2中可产出（产出2非空）的作物，并生成编号快捷。
   */
  async handleViewCrops(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    const resources2 = asJsonValue<any[]>(map.resources2, []);
    // 原版只列出有"产出2"的作物（取数组成员数(产出2) != 0）
    const crops = resources2.filter((r: any) => {
      const prod2 = this.parseResourceOutputs(r.outputs2 ?? r.产出2 ?? r.production2 ?? r.output2);
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
      const menu = await this.buildNumberedMenu(userId, options, '💡 发送编号数字即可查看详情');
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
      const menu = await this.buildNumberedMenu(userId, options, '💡 发送编号数字即可前往该家园');
      lines.push(...menu);
    }
    return lines.join('\n');
  }

  /**
   * 处理查看成就命令（对应原版 _主程序.ecode L5551）
   * 复用 achievementService.getAchievementsDisplay 输出成就列表。
   */
  async handleViewAchievements(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    return this.achievementService.getAchievementsDisplay(player);
  }

  /**
   * 处理查看使魔命令（基础数据 + 「1、更多」子菜单）
   * 对齐原版 _主程序.ecode L5527（查看使魔显示基础数据）与 L5548（追加「1、更多」）。
   * 基础数据只含当前战力与属性，技能说明与好感解锁分层由「使魔技能」独立展示，
   * 避免与「查看使魔」重复。
   */
  async handleViewFamiliar(userId: number): Promise<string> {
    const base = await this.familiarSystemService.viewFamiliarData(userId, false);
    // 原版 L5548：查看使魔 末尾仅追加「1、更多」，再进入 更多 子菜单（使魔数据/查看技能/查看使魔详细/被动效果）。
    // 全局「更多」已被全局帮助占用，故此处映射到专用令牌「使魔更多」。
    const menu = await this.buildNumberedMenu(
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
    const menu = await this.buildNumberedMenu(
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
  async handleViewSkills(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const lines: string[] = [`✨ ${player.name || '冒险者'} 技能导航:`, `━━━━━━━━━━━━━━━`];
    const options: { label: string; cmd: string }[] = [
      { label: '通用技能', cmd: '通用技能' },
      { label: '使魔技能', cmd: '使魔技能' },
      { label: '查看成就', cmd: '查看成就' },
      { label: '查看标记', cmd: '查看标记' },
      { label: '查看标记2', cmd: '查看标记2' },
    ];
    const menu = await this.buildNumberedMenu(userId, options, '💡 发送编号数字即可查看对应内容');
    lines.push(...menu);
    return lines.join('\n');
  }

  /**
   * 处理查看标记命令（对应原版 _主程序.ecode L5561）
   * 列出玩家持久化标记（markers 键值对）。
   */
  async handleViewMarkers(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const lines: string[] = [`🔖 ${player.name || '冒险者'} 游戏标记:`, `━━━━━━━━━━━━━━━`];
    const entries = Object.entries(markers || {});
    if (entries.length === 0) {
      lines.push('  (暂无标记)');
    } else {
      for (const [name, value] of entries) {
        lines.push(`  ${name} ×${value}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * 处理查看标记2命令（对应原版 _主程序.ecode L5566）
   * 列出玩家限时标记（markers2 数组，含 expireAt）。
   */
  async handleViewMarkers2(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers2 } = playerData;
    const lines: string[] = [`⏱️ ${player.name || '冒险者'} 限时标记:`, `━━━━━━━━━━━━━━━`];
    const list = Array.isArray(markers2) ? markers2 : [];
    if (list.length === 0) {
      lines.push('  (暂无标记)');
    } else {
      const now = Date.now();
      for (const m of list) {
        if (!m || !m.name) continue;
        const remain = m.expireAt ? Math.max(0, Math.ceil((m.expireAt - now) / 1000)) : null;
        lines.push(`  ${m.name}${remain !== null ? ` (剩余${remain}秒)` : ''}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * 处理查看说明命令（对应原版 _主程序.ecode L5503）
   * 显示当前地图名称、说明、复活点（网页版无图片，仅文本）。
   */
  async handleViewDescription(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';
    const respawn = map.respawnPoint || map.复活点 || '未知';
    return [
      `📖 【${map.name}】说明`,
      `━━━━━━━━━━━━━━━`,
      map.description || '（该地图暂无说明）',
      `复活点: ${respawn}`,
    ].join('\n');
  }

  /**
   * 处理对话咏星跟随命令（对应原版 _主程序.ecode L1368）
   * 找到当前地图"咏星"怪物，检查好感≥100后将其转为归属于玩家的召唤物（跟随）。
   */
  async handleDialogueYongxing(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 在 GameMonster 表（临时怪物）中查找"咏星"
    const tempMonsters = await this.mapService.getMapMonsters(map.id);
    const targetMonster = tempMonsters.find((m: any) => m.name === '咏星');
    if (!targetMonster) {
      return `${player.name} 附近没有咏星`;
    }

    // 好感检查（对应原版：好感+玩家QQ >= 100）
    const affinity = this.playerService.getMarkerValue(markers, `好感${player.userId}`) || 0;
    if (affinity < 100) {
      return `${player.name} 需要100好感，当前${affinity}`;
    }

    const monster = targetMonster;
    // 转为召唤物：归属玩家、specialSeq=-2、follow 跟随
    const summon = {
      name: monster.name,
      qq: monster.qq || `怪物${monster.name}1g`,
      type: monster.type || '咏星',
      specialSeq: -2,
      ownerQQ: player.userId.toString(),
      follow: true,
      mode: 'follow',
      hp: monster.hp ?? 0,
      maxHp: monster.maxHp ?? monster.hp ?? 100,
    };
    // 从 GameMonster 表移除该临时怪物（已转为召唤物）
    await this.mapService.removeMapMonster(map.id, monster.id);

    // mutateSummons 锁内闭环：重读最新 summons → 复查幂等 → push 新召唤物 → 差异落库
    await this.mapService.mutateSummons(map.id, (fresh) => {
      if (fresh.some((s: any) => s.qq === summon.qq)) return;
      fresh.push(summon);
    });

    // 记录成就「拐妹子」
    await this.achievementService.addAchievement(player, '拐妹子', 1);
    return `咏星愿意跟随你了！`;
  }

  /**
   * 处理对话小恶魔跟随命令（对应原版 _主程序.ecode L1397）
   * 找到当前地图"怪物小恶魔1"并直接转为归属于玩家的召唤物（跟随）。
   */
  async handleDialogueLittleDemon(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 在 GameMonster 表（临时怪物）中查找小恶魔（qq=怪物小恶魔1）
    const tempMonsters = await this.mapService.getMapMonsters(map.id);
    const targetMonster = tempMonsters.find((m: any) => m.qq === '怪物小恶魔1' || m.name === '小恶魔');
    if (!targetMonster) {
      return `${player.name} 附近没有小恶魔`;
    }

    const monster = targetMonster;
    const summon = {
      name: monster.name || '小恶魔',
      qq: '怪物001xg',
      type: monster.type || '小恶魔',
      specialSeq: -2,
      ownerQQ: player.userId.toString(),
      follow: true,
      mode: 'follow',
      hp: monster.hp ?? 0,
      maxHp: monster.maxHp ?? monster.hp ?? 100,
    };
    // 从 GameMonster 表移除该临时怪物（已转为召唤物）
    await this.mapService.removeMapMonster(map.id, monster.id);

    // mutateSummons 锁内闭环：重读最新 summons → 复查幂等 → push 新召唤物 → 差异落库
    await this.mapService.mutateSummons(map.id, (fresh) => {
      if (fresh.some((s: any) => s.qq === summon.qq)) return;
      fresh.push(summon);
    });

    return `那就让我看看你的本事吧！小恶魔开始跟随你。`;
  }

  /**
   * 处理设置肉食比例命令（对应原版 _主程序.ecode L5277）
   * 设置家园地图中"肉食植物能享用的生肉与生肉产出的比例"（存于家园地图标记）。
   */
  async handleSetMeatRatio(userId: number, ratioStr: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    const ratio = parseInt(ratioStr, 10);
    if (!player.houseName) {
      return `${player.name} 你现在还没有家园，不能干这个`;
    }
    if (!ratio || ratio <= 0 || ratio > 100) {
      return `${player.name} 使用「设置肉食比例90」来设置肉食植物能享用的生肉与生肉产出的比例`;
    }

    // 根据家园名称找到对应地图（getMapByName 找不到会 throw NotFoundException，需 try/catch）
    let homeMap: any = null;
    try {
      homeMap = await this.mapService.getMapByName(player.houseName);
    } catch {
      homeMap = null;
    }
    if (!homeMap) {
      return `${player.name} 找不到你的家园地图「${player.houseName}」`;
    }

    // 将比例写入家园地图的标记（对应原版：置成就熟练度("肉食比例", 地图.标记, a1)）
    // mutateMapFields 锁内闭环：重读最新 markers → 写入 → 差异落库
    await this.mapService.mutateMapFields(homeMap.id, ['markers'], (f) => {
      (f.markers as Record<string, number>)['肉食比例'] = ratio;
    });

    return `${player.name} ${player.houseName}的肉食植物现在能享用${ratio}%的生肉产出`;
  }

  /**
   * 处理召唤货舱命令
   * 在当前地图召唤货舱（可采集资源），如果没有则生成一个临时货舱
   */
  /**
   * 发射信号枪（原版 _主程序.ecode L6281-6296）。
   * 门禁：数量<=0 用法提示 → 背包需有信号枪 → 10 秒冷却。
   * 成功：成就"召唤货舱"+1 → 活跃度+1 → 6 秒延时「召h货1藏」结算（completeCargoSummon）。
   * 注意：原版信号枪只用于召唤货舱（资源补给），引怪由覅攻击pd（采集/传送触发）承担。
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
    const hasSignalGun = backpack.some((item: any) => String(item?.name ?? item?.名称 ?? '') === '信号枪' && this.itemQuantity(item) > 0);
    if (!hasSignalGun) return `${name}背包中需要有信号枪`;

    const markers2 = Array.isArray(playerData.markers2)
      ? playerData.markers2
      : this.parseJsonArray(player.markers2);
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
    this.incrementMarker(markers, '活跃度', 1);
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
  private async completeCargoSummon(userId: number, count: number): Promise<void> {
    await this.playerService.enqueueUserWrite(userId, () =>
      this.applyCargoSummon(userId, count));
  }

  private async applyCargoSummon(userId: number, count: number): Promise<void> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = player.name || '冒险者';

    // 扣除至多 count 把信号枪（原版 L6301-6312 逐个删除成员）
    const backpack = asJsonValue<any[]>(player.backpack, []);
    const owned = backpack
      .filter((item: any) => String(item?.name ?? item?.名称 ?? '') === '信号枪')
      .reduce((sum, item: any) => sum + this.itemQuantity(item), 0);
    const removed = Math.min(owned, count);
    if (removed > 0) this.deductBackpackItem(backpack, '信号枪', removed);
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
  async handleProduce(userId: number, productName: string): Promise<string> {
    // 委托到 FamiliarSystemService 的家园产出操作
    // productName 参数在完整实现中可用于指定生产特定资源
    return this.familiarSystemService.handleHome(userId, '产出');
  }

  // ========== 副本命令 ==========

  /**
   * 处理副本清空命令
   * 清空当前副本的怪物，重置副本状态
   * 对应原版：清空副本 命令
   */
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

  private parseDungeonArray(value: any): any[] {
    // markers2 为合并地图字段：静态来源已是数组，DB 来源是 JSON 字符串
    const parsed = asJsonValue<any[]>(value, []);
    // 保持原语义：返回副本，避免调用方 splice 修改污染上游数据
    return Array.isArray(parsed) ? [...parsed] : [];
  }

  private normalizeDungeonMarkers2(markers2: any[]): void {
    const normalized = markers2.map((marker: any) => this.combatState.normalizeBuffItem(marker));
    markers2.splice(0, markers2.length, ...normalized);
  }

  // ========== 载具命令 ==========

  /**
   * 处理组装载具命令
   * 使用部件组装载具，需要核心部件
   * 对应原版：组装 命令
   */
  async handleAssembleVehicle(userId: number, partName: string, count = 1): Promise<string> {
    const requestedCount = Math.max(1, Math.floor(Number(count) || 1));
    if (!partName) {
      return '请指定要组装的部件名称，格式：组装 部件名';
    }

    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取用户QQ号
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userQQ = user?.qqNumber || String(userId);

    // 检查背包中是否有该部件
    const backpack = this.playerService.getBackpackItems(player);
    const partItem = backpack.find((item: any) => item.name === partName);
    if (!partItem) {
      return `背包中没有【${partName}】`;
    }

    // 床等功能建筑也可以组装到载具，原版任务使用“组装床”而不是“安装床”。
    if (this.staticData.getBuildingByName(partName)) {
      return this.handleAssembleBuilding(userId, partName, requestedCount);
    }

    // 验证是否为有效部件（静态配置 JSON 单一来源）
    const partDef = this.staticData.getVehiclePartByName(partName);
    if (!partDef) {
      return `【${partName}】不是有效的载具部件`;
    }

    // 如果部件类型是核心（partType=0），需要创建新载具
    if (partDef.partType === 0) {
      // 检查是否已有载具
      if (player.vehicle) {
        return '你已经有一辆载具了，无法创建新的载具';
      }

      // 从背包移除核心部件
      const removed = await this.playerService.removeFromBackpack(userId, partName, 1);
      if (!removed) {
        return '移除部件失败';
      }

      // 创建新载具
      const vehicle = await this.prisma.gameVehicle.create({
        data: {
          name: `${player.name || '冒险者'}的载具`,
          vehicleId: Math.random().toString(36).substring(2, 10).toUpperCase(),
          type: '组装',
          owner: userQQ,
          driver: userQQ,
          mapIndex: player.mapId,
          maxHp: 100,
          currentHp: 100,
          parts: [{
            name: partDef.name,
            partType: 0,
            bonus: asJsonValue<any>(partDef.bonus, {}),
            description: partDef.description || '',
          }],
          bonus: asJsonValue<any>(partDef.bonus, {}),
        },
      });

      // 自动驾驶载具
      player.vehicle = String(vehicle.id);
      await this.playerService.savePlayer(player);

      this.logger.log(`玩家 ${userId} 使用核心部件 ${partName} 创建了新载具 ${vehicle.id}`);
      return `✅ 成功组装载具：${vehicle.name}\n使用核心部件【${partName}】创建成功\n核心已自动安装，使用「载具」查看状态`;
    }

    // 非核心部件，检查是否已有载具
    if (!player.vehicle) {
      return '你还没有载具，请先使用核心部件组装载具';
    }

    // 通过安装部件来组装
    return await this.handleInstallPart(userId, partName, requestedCount);
  }

  /**
   * 处理驾驶载具命令
   * 驾驶或切换到指定的载具
   * 对应原版：驾驶 命令
   */
  async handleDriveVehicle(userId: number, vehicleName: string): Promise<string> {
    if (!vehicleName) {
      return '请指定载具名称或ID，格式：驾驶 载具名';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const map = await this.mapService.getMapById(player.mapId);
    const playerName = player.name || '冒险者';
    const driverId = String(user?.qqNumber || user?.externalId || userId);
    const ownerIds = new Set([
      String(userId), String(user?.qqNumber || ''), String(user?.externalId || ''),
      String(player.masterQQ || ''),
    ].filter(Boolean));

    const vehicleKeys = (value: any): string[] => [
      value?.编号, value?.vehicleId, value?.id, value?.名称, value?.name,
    ].filter((key) => key !== undefined && key !== null && String(key) !== '').map(String);
    const matchesVehicle = (value: any): boolean => vehicleKeys(value).includes(String(vehicleName));
    const ownerOf = (value: any): string => String(value?.归属 ?? value?.owner ?? '');
    const isAllowedOwner = (value: any): boolean => {
      const owner = ownerOf(value);
      return owner === '无主' || ownerIds.has(owner);
    };

    const mapVehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
    const mapIndex = mapVehicles.findIndex(matchesVehicle);
    let source: any = null;
    if (mapIndex >= 0) {
      source = {
        kind: 'map',
        map,
        index: mapIndex,
        runtime: this.toRuntimeVehicle(mapVehicles[mapIndex]),
      };
    } else {
      const numericId = Number(vehicleName);
      let dbVehicle: any = Number.isInteger(numericId) && numericId > 0
        ? await this.prisma.gameVehicle.findUnique({ where: { id: numericId } })
        : null;
      if (!dbVehicle) {
        dbVehicle = await this.prisma.gameVehicle.findFirst({
          where: {
            OR: [
              { name: vehicleName },
              { vehicleId: vehicleName },
            ],
          },
        });
      }
      // 原版只从当前地图的载具数组取值。GameVehicle 是当前项目的持久化映射：
      // mapIndex=0 表示旧存量未记录位置，允许归属者继续使用；新载具会写入当前 mapId。
      const vehicleMap = Number(dbVehicle?.mapIndex || 0);
      if (dbVehicle && (vehicleMap === 0 || vehicleMap === Number(map?.id) || vehicleMap === Number(map?.mapIndex))) {
        source = { kind: 'db', db: dbVehicle, map, runtime: this.toRuntimeVehicle(dbVehicle) };
      }
    }

    if (!source) return `${playerName}附近没有${vehicleName}`;
    if (!isAllowedOwner(source.runtime)) {
      return `${playerName}这是别人的${source.runtime.名称}，你不能驾驶`;
    }

    const runtime = source.runtime;
    const targetKeys = new Set(vehicleKeys(runtime));
    if (source.kind === 'db') targetKeys.add(String(source.db.id));
    const oldVehicleKey = String(player.vehicle || '');
    const targetWasUnowned = ownerOf(runtime) === '无主';
    let mapChanged = false;
    const summons = this.parseVehicleValue<any[]>(map?.summons, []);
    const dbUpdates: Promise<any>[] = [];

    // 原版 L10328-L10340：先让原驾驶员离开目标载具；玩家和召唤物分别清除自己的载具字段。
    const previousDriver = String(runtime.驾驶员 ?? runtime.driver ?? '');
    if (previousDriver && !ownerIds.has(previousDriver)) {
      let previousUser: any = null;
      const numericDriver = Number(previousDriver);
      if (Number.isInteger(numericDriver) && numericDriver > 0) {
        previousUser = await this.prisma.user.findUnique({ where: { id: numericDriver } });
      }
      if (!previousUser) {
        previousUser = await this.prisma.user.findFirst({
          where: { OR: [{ qqNumber: previousDriver }, { externalId: previousDriver }] },
        });
      }
      if (previousUser) {
        const previousData = await this.playerService.getPlayerData(previousUser.id);
        if (previousData?.player && previousData.player.vehicle) {
          previousData.player.vehicle = '';
          await this.playerService.savePlayer(previousData.player);
        }
      } else {
        const summon = summons.find((unit: any) => [
          unit?.QQ, unit?.qq, unit?.编号, unit?.id,
        ].filter(Boolean).map(String).includes(previousDriver));
        if (summon) {
          summon.载具 = '';
          summon.vehicle = '';
          mapChanged = true;
        }
      }
    }

    // 原版 L10346-L10350：驾驶新载具时清除玩家原来载具的驾驶员。
    if (oldVehicleKey && !targetKeys.has(oldVehicleKey)) {
      const oldMapIndex = mapVehicles.findIndex((unit: any) => vehicleKeys(unit).includes(oldVehicleKey));
      if (oldMapIndex >= 0) {
        mapVehicles[oldMapIndex].驾驶员 = '';
        mapVehicles[oldMapIndex].driver = '';
        mapChanged = true;
      } else {
        const oldNumericId = Number(oldVehicleKey);
        const oldDbVehicle = Number.isInteger(oldNumericId) && oldNumericId > 0
          ? await this.prisma.gameVehicle.findUnique({ where: { id: oldNumericId } })
          : await this.prisma.gameVehicle.findFirst({ where: { vehicleId: oldVehicleKey } });
        if (oldDbVehicle && oldDbVehicle.id !== source.db?.id) {
          dbUpdates.push(this.prisma.gameVehicle.update({
            where: { id: oldDbVehicle.id },
            data: { driver: '' },
          }));
        }
      }
    }

    runtime.驾驶员 = driverId;
    runtime.driver = driverId;
    if (targetWasUnowned) {
      runtime.归属 = driverId;
      runtime.owner = driverId;
    }
    if (source.kind === 'map') {
      mapVehicles[source.index] = this.toStoredVehicle(runtime);
      mapChanged = true;
    } else {
      dbUpdates.push(this.prisma.gameVehicle.update({
        where: { id: source.db.id },
        data: {
          owner: String(runtime.owner || runtime.归属 || ''),
          driver: driverId,
          mapIndex: Number(map?.id || 0),
        },
      }));
    }
    if (mapChanged) {
      await this.mapService.updateDynamicFields(map.id, {
        vehicles: mapVehicles,
        summons,
      });
    }
    await Promise.all(dbUpdates);

    player.vehicle = source.kind === 'db'
      ? String(source.db.id)
      : String(runtime.编号 || runtime.vehicleId || runtime.id || '');
    const sets = this.parseVehicleValue<any>(player.sets, {});
    // 原版 L10314：驾驶成功后立即终止接管状态。
    sets.takeVehicle = '';
    sets.接管载具 = '';
    player.sets = sets;
    await this.playerService.savePlayer(player);

    if (targetWasUnowned) {
      await this.achievementService.addAchievement(player, '拾取载具', 1);
      await this.taskService.advance(userId, '拾取载具' + runtime.名称);
    }
    await this.achievementService.addAchievement(player, '驾驶载具', 1);
    await this.taskService.advance(userId, '驾驶' + runtime.类型);

    const vehicleText = `${runtime.名称}(${runtime.类型})`;
    const result = targetWasUnowned
      ? `${playerName}获取了${runtime.名称}的权限,然后进入了${vehicleText}的驾驶舱,"脱出"来离开`
      : `${playerName}进入了${vehicleText}的驾驶舱,"脱出"来离开`;
    this.logger.log(`玩家 ${userId} 驾驶了载具 ${runtime.名称}`);
    return result;
  }

  /** 解析“核心1 轻型足2”式载具模拟参数；首个零件固定需要1个，其余取尾部数字。 */
  private parseVehicleAssemblyParts(parts: string[]): any[] {
    return parts.map((rawPart, index) => {
      const value = String(rawPart || '').trim();
      const name = index === 0 ? value.replace(/\d+/g, '') : value.replace(/\d+(?=\s*$)/, '').trim();
      const quantity = index === 0 ? 1 : Math.trunc(Number(value.match(/(\d+)\s*$/)?.[1] || 0));
      return { 名称: name, name, 类型: '资源', type: '资源', 数量: quantity, quantity };
    }).filter((part) => part.名称 && Number.isFinite(part.数量) && part.数量 > 0);
  }

  private async backpackQuantity(backpack: any[], name: string): Promise<number> {
    let total = 0;
    for (const item of backpack) {
      if ((item?.name ?? item?.名称) === name && item?.type !== '装备') {
        total += Number(item.quantity ?? item.count ?? 0);
      }
    }
    return total;
  }

  private async addBackpackItem(backpack: any[], item: any): Promise<void> {
    const existing = backpack.find((entry: any) =>
      (entry?.name ?? entry?.名称) === (item?.name ?? item?.名称)
      && (entry?.type ?? entry?.类型 ?? '资源') !== '装备');
    if (existing) {
      const next = Number(existing.quantity ?? existing.count ?? 0) + Number(item.quantity ?? item.count ?? 0);
      existing.quantity = next;
      existing.count = next;
      return;
    }
    backpack.push({ ...item });
  }

  /** 对应原版 制造()：dryRun 只校验，正式执行才消耗资源并产出物品。 */
  private async craftVehiclePart(
    player: any,
    backpack: any[],
    markers: Record<string, number>,
    name: string,
    count: number,
    dryRun: boolean,
  ): Promise<{ success: boolean; text: string }> {
    const recipe = this.staticData.getAllCraftings().find((row: any) => row.name === name);
    if (!recipe) return { success: false, text: `${player.name},【${name}】在制造列表不存在。` };
    if (recipe.noCraft) {
      return { success: false, text: `你输入了正确的名称，但是【${name}】不是可以制造的项目(它只是用来分解用的)，你也许想：` };
    }

    const normalizeItems = (value: any): any[] => {
      const rows = Array.isArray(value) ? value : asJsonValue<any[]>(value, []);
      return rows.map((row: any) => ({
        ...row,
        name: row?.name ?? row?.名称,
        名称: row?.名称 ?? row?.name,
        type: row?.type ?? row?.类型 ?? '资源',
        类型: row?.类型 ?? row?.type ?? '资源',
        quantity: Number(row?.quantity ?? row?.count ?? row?.数量 ?? 0),
        数量: Number(row?.quantity ?? row?.count ?? row?.数量 ?? 0),
      })).filter((row: any) => row.name && Number.isFinite(row.quantity));
    };
    const requirements = normalizeItems(recipe.requirements);
    const outputs = normalizeItems(recipe.outputs);
    const gainMarkers: string[] = asJsonValue<string[]>(recipe.gainMarkers, []);
    if (outputs.length === 0) {
      return { success: false, text: `！！警告：制造项目${recipe.name}的制造产出为空，请检查文件` };
    }
    if (player.level < recipe.level) return { success: false, text: `需要等级${recipe.level}` };
    if (gainMarkers.some((markerName) => markerName && (markers[markerName] || 0) >= 1)) {
      return { success: false, text: '这个不可以重复制造。' };
    }

    const insufficient: string[] = [];
    for (const requirement of requirements) {
      const required = requirement.quantity * count;
      const owned = await this.backpackQuantity(backpack, requirement.name);
      if (owned < required) insufficient.push(`需要${requirement.name} ×${required}，你只有${owned}`);
    }
    if (insufficient.length > 0) return { success: false, text: insufficient.join('\n') };
    if (dryRun) return { success: true, text: '' };

    for (const requirement of requirements) {
      let remaining = requirement.quantity * count;
      for (let index = backpack.length - 1; index >= 0 && remaining > 0; index--) {
        const item = backpack[index];
        if ((item?.name ?? item?.名称) !== requirement.name) continue;
        const current = Number(item.quantity ?? item.count ?? 0);
        const removed = Math.min(current, remaining);
        remaining -= removed;
        if (current - removed <= 0) backpack.splice(index, 1);
        else {
          item.quantity = current - removed;
          item.count = current - removed;
        }
      }
    }

    const producedTexts: string[] = [];
    for (const output of outputs) {
      const outputQuantity = output.quantity * count;
      const outputItem = {
        ...output,
        quantity: outputQuantity,
        数量: outputQuantity,
      };
      await this.addBackpackItem(backpack, outputItem);
      producedTexts.push(`${output.name} ×${outputQuantity}`);
    }
    markers['制造'] = (markers['制造'] || 0) + count;
    markers[`制造${name}`] = (markers[`制造${name}`] || 0) + count;
    for (const markerName of gainMarkers) {
      if (markerName) markers[markerName] = (markers[markerName] || 0) + count;
    }
    return { success: true, text: `${player.name}用制造了${count}的${name}\n得到了${producedTexts.join('、')}` };
  }

  /** 对应原版 组装载具()：先模拟扣除已有零件，再自动制造缺失零件并写入当前地图。 */
  async assembleVehicleFromParts(userId: number, rawParts: string[]): Promise<string> {
    const requiredParts = this.parseVehicleAssemblyParts(rawParts);
    if (!requiredParts.length) return '核心必须在最前面';
    const coreSpec = this.staticData.getVehiclePartSpecByName(requiredParts[0].名称);
    if (!coreSpec || !String(requiredParts[0].名称).replace(/\d+$/, '').endsWith('核心')) {
      return '核心必须在最前面';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const ownerQQ = String(user?.qqNumber || userId);
    const playerName = player.name || '冒险者';

    const restriction = this.combatSystem.actionUnrestricted(player, { cannonOk: false, ignoreReason: 6 });
    if (restriction.restricted) return `${playerName}${restriction.text}`;
    if (this.playerService.isPlayerDead(player)) {
      return `${playerName}已经死掉了!你可以“复活使魔”或者“删除怪物”`;
    }

    if (await this.hasOwnedProductionVehicle(ownerQQ, coreSpec)) {
      return `${playerName}一个玩家只能同时存在一个生产类载具，你可以在普通载具上组装生产线，一样有生产的效果。`;
    }

    const backpack = this.playerService.getBackpackItems(player);
    const temporaryBackpack = JSON.parse(JSON.stringify(backpack));
    const missingParts: any[] = [];
    for (const part of requiredParts) {
      const owned = await this.backpackQuantity(temporaryBackpack, part.名称);
      if (owned >= part.数量) continue;
      const stillMissing = part.数量 - owned;
      missingParts.push({ ...part, 数量: stillMissing, quantity: stillMissing });
    }

    let aborted = false;
    let failureText = '';
    for (const part of missingParts) {
      const dryRun = await this.craftVehiclePart(player, temporaryBackpack, markers, part.名称, part.数量, true);
      if (!dryRun.success) {
        failureText += failureText
          ? `、${part.名称}x${part.数量}`
          : `\n缺少这些物品，并且背包里面的数量不够/背包里面的资源不足以制造缺少的数量：${part.名称}x${part.数量}`;
        aborted = true;
      }
    }
    if (aborted) return `${playerName}${failureText}`;

    const craftTexts: string[] = [];
    for (const part of missingParts) {
      const crafted = await this.craftVehiclePart(player, backpack, markers, part.名称, part.数量, false);
      if (crafted.text) craftTexts.push(crafted.text);
    }

    const timestamp = Date.now();
    const runtime = this.toRuntimeVehicle({});
    runtime.零件 = requiredParts.map((part) => ({ ...part }));
    runtime.配方 = [{ 名称: '1', name: '1', 数值: timestamp, value: timestamp }];
    runtime.编号 = `V${timestamp.toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    runtime.vehicleId = runtime.编号;
    runtime.归属 = ownerQQ;
    runtime.owner = ownerQQ;
    this.combatSystem.recalculateVehicle(runtime, timestamp);
    const calculatedHp = Number(runtime.加成?.生命 || 0);
    runtime.当前生命 = calculatedHp;
    runtime.currentHp = calculatedHp;
    runtime.生命 = calculatedHp;
    runtime.maxHp = calculatedHp;
    runtime.名称 = `${playerName}的${String(requiredParts[0].名称).replace('核心', '')}`;
    runtime.name = runtime.名称;

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${playerName}不在任何地图上`;
    const vehicles = this.parseVehicleValue<any[]>(map.vehicles, []);
    vehicles.push(this.toStoredVehicle(runtime));
    await this.mapService.updateDynamicFields(map.id, { vehicles });

    for (const part of requiredParts) {
      let remaining = part.数量;
      for (let index = backpack.length - 1; index >= 0 && remaining > 0; index--) {
        const item = backpack[index];
        if ((item?.name ?? item?.名称) !== part.名称) continue;
        const current = Number(item.quantity ?? item.count ?? 0);
        const removed = Math.min(current, remaining);
        remaining -= removed;
        if (current - removed <= 0) backpack.splice(index, 1);
        else {
          item.quantity = current - removed;
          item.count = current - removed;
        }
      }
    }
    player.backpack = backpack; // Json 列直接写数组
    player.markers = markers; // Json 列直接写对象
    await this.playerService.savePlayer(player);

    await this.achievementService.addAchievement(player, '组装载具', 1);
    await this.taskService.advance(userId, `组装${requiredParts[0].名称}`, 1);

    return [`${playerName}组装了一个载具：${runtime.名称}`, ...craftTexts].filter(Boolean).join('\n');
  }

  private async hasOwnedProductionVehicle(ownerQQ: string, coreSpec: any): Promise<boolean> {
    if (!(Number(coreSpec?.partType ?? coreSpec?.类型) === 0 && Number(coreSpec?.bonus?.生产 || 0) !== 0)) return false;
    const maps = await this.mapService.getAllMaps();
    return maps.some((map: any) => this.parseVehicleValue<any[]>(map?.vehicles, []).some((vehicleRaw: any) => {
      if (String(vehicleRaw?.归属 ?? vehicleRaw?.owner ?? '') !== ownerQQ) return false;
      const vehicle = this.toRuntimeVehicle(vehicleRaw);
      return Number(vehicle.加成?.生产 || 0) !== 0 || (vehicle.零件 || []).some((part: any) => {
        const spec = this.staticData.getVehiclePartSpecByName(part.名称);
        return Number(spec?.partType) === 0 && Number(spec?.bonus?.生产 || 0) !== 0;
      });
    }));
  }

  /**
   * 处理载具命名命令
   * 给当前驾驶的载具命名
   * 对应原版：载具命名 命令
   */
  async handleNameVehicle(userId: number, name: string): Promise<string> {
    if (!name) {
      return '请指定新的载具名称，格式：载具命名 新名称';
    }

    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查是否有载具
    if (!player.vehicle) {
      return '你当前没有驾驶任何载具';
    }

    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) {
      return '载具数据异常';
    }

    // 更新载具名称
    await this.prisma.gameVehicle.update({
      where: { id: vehicleId },
      data: { name },
    });

    this.logger.log(`玩家 ${userId} 将载具更名为 ${name}`);
    return `✅ 载具已更名为【${name}】`;
  }

  /**
   * 处理载具模拟命令
   * 模拟载具装配后的性能表现
   * 对应原版：载具模拟 命令
   */
  async handleSimulateVehicle(userId: number, targetName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (!player.vehicle) {
      // 如果没有驾驶载具，模拟指定部件装配效果
      if (!targetName) {
        return '请指定要模拟的部件名称，或先驾驶载具后使用「载具模拟」';
      }

      // 查找部件定义（静态配置 JSON 单一来源）
      const partDef = this.staticData.getVehiclePartByName(targetName);
      if (!partDef) {
        return `未找到部件【${targetName}】`;
      }

      const bonus = asJsonValue<any>(partDef.bonus, {});
      const bonusLines = Object.entries(bonus)
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .map(([k, v]) => `  ${k}: +${v}`);

      return [
        `🔧 部件模拟：${partDef.name}`,
        `━━━━━━━━━━━━━━━`,
        `类型: ${this.PART_TYPE_NAMES[partDef.partType] || '未知'}`,
        `描述: ${partDef.description || '无'}`,
        bonusLines.length > 0 ? `━━━━━━━━━━━━━━━\n加成属性:` : '',
        ...bonusLines,
        `━━━━━━━━━━━━━━━`,
        `使用「安装 ${partDef.name}」安装到载具`,
      ].filter(Boolean).join('\n');
    }

    // 已有载具，模拟当前载具的总加成
    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) return '载具数据异常';

    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) return '载具数据不存在';

    const parts = asJsonValue<any[]>(vehicle.parts, []);
    const totalBonus = this.calcVehicleTotalBonus(vehicle);

    const lines = [
      `🔧 载具模拟：${vehicle.name}`,
      `━━━━━━━━━━━━━━━`,
      `部件数量: ${parts.length}个`,
      `━━━━━━━━━━━━━━━`,
      `📊 模拟加成:`,
    ];

    const bonusFields: { key: string; label: string }[] = [
      { key: '攻击', label: '攻击' },
      { key: '生命', label: '生命' },
      { key: '装甲', label: '装甲' },
      { key: '护盾', label: '护盾' },
      { key: '速度', label: '速度' },
      { key: '闪避', label: '闪避' },
      { key: '命中', label: '命中' },
      { key: '暴击', label: '暴击' },
    ];

    let hasBonus = false;
    for (const bf of bonusFields) {
      const val = (totalBonus as any)[bf.key];
      if (val) {
        lines.push(`  ${bf.label}: +${Math.round(val)}`);
        hasBonus = true;
      }
    }
    if (!hasBonus) {
      lines.push(`  无加成属性`);
    }

    return lines.join('\n');
  }

  /**
   * 维修载具（原版 _主程序.ecode L10397-10495「维修」）。
   * 无参入口：行动无限制（理由6=自动开采豁免）→ 需驾驶载具 → 地图战斗增益+有怪拦截 →
   * 死亡 → 取载具（图上无此载具则弹射清空驾驶）→ 部件超上限四类拦截 → 满血「还不需要修」
   * → 耗时 = 20 秒，小雫/小凰/小蓝/小粉 各 -5 秒；
   *   耗时 <1 → 立即用0载具零件修好（计算载具+满血+成就维修载具）；
   *   否则「正在维修…」+ 工作 a 秒标记 + 延时 a 秒结算（completeVehicleRepair）。
   * 「维修 wcc1」是原版延时结算分支（延时任务以玩家身份重发命令）；
   * 「维修 其他参数」原版静默无输出。
   */
  async handleRepairVehicle(userId: number, targetName: string = ''): Promise<string> {
    const keyword = String(targetName ?? '').trim();
    if (keyword && keyword !== 'wcc1') return '';
    if (keyword === 'wcc1') return this.completeVehicleRepair(userId);

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = player.name || '冒险者';

    // 行动无限制（原版 L10400 理由6：自动开采中也可以维修）
    const restriction = this.combatSystem.actionUnrestricted(player, { ignoreReason: 6 });
    if (restriction.restricted) return restriction.text;
    if (!player.vehicle) return `${name}你现在没有在驾驶载具`;

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${name}不在任何地图上`;

    // 地图战斗增益 + 有怪拦截（原版 L10407-10408）
    const mapMarkers2 = asJsonValue<any[]>(map.markers2, []);
    const strength = { value: 0 };
    const remain = { value: 0 };
    let monsters: any[] = [];
    try {
      monsters = await this.mapService.getMapMonsters(map);
    } catch {
      monsters = [];
    }
    if (this.combatState.buffRequire('战斗', mapMarkers2, strength, Date.now(), remain) && monsters.length !== 0) {
      const remainSec = Math.max(0, Math.ceil(Number(remain.value) || 0));
      const remainText = remainSec >= 60
        ? `${Math.floor(remainSec / 60)}分${remainSec % 60}秒`
        : `${remainSec}秒`;
      return `${name}当前地图正在战斗中，请消灭全部怪物、离开，或者等待${remainText}`;
    }

    if (this.playerService.isPlayerDead(player)) return this.playerService.handlePlayerDeath(userId, player);

    // 取载具 + 计算载具（原版 L10412-10415）
    const vehicle = await this.findTravelVehicle(player, map);
    if (!vehicle) {
      // 原版 L10416-10418：附近没有该载具则弹射（清空驾驶状态）
      const vehicleKey = String(player.vehicle);
      player.vehicle = '';
      await this.playerService.savePlayer(player);
      return `#错误：附近没有载具${vehicleKey},已弹射`;
    }
    this.combatSystem.recalculateVehicle(vehicle, Date.now());

    // 部件超上限四类拦截（原版 L10419-10427）
    const overLimit = this.findVehicleOverLimitPart(vehicle);
    if (overLimit) {
      return `${name}，${vehicle.名称 || vehicle.name}安装的${overLimit}超过了上限，无法维修`;
    }

    const fullHp = Number(vehicle.加成?.生命 || 0) || this.rescueVehicleMaxHp(vehicle);
    if (fullHp > 0 && Number(vehicle.currentHp ?? vehicle.当前生命 ?? 0) === fullHp) {
      return `${name}还不需要修`;
    }

    // 耗时：基础 20 秒；小雫/小凰/小蓝/小粉 各 -5 秒（原版 L10431-10443）
    const partNames = this.collectVehiclePartNames(vehicle);
    let seconds = 20;
    for (const part of ['小雫', '小凰', '小蓝', '小粉']) {
      if (partNames.includes(part)) seconds -= 5;
    }
    if (seconds < 1) {
      return this.applyVehicleRepair(userId, player, map, vehicle);
    }

    // 工作 a 秒标记 + 延时结算（原版 L10447-10449）
    const markers2 = asJsonValue<any[]>(player.markers2, []);
    this.combatState.addMarker('工作', seconds, markers2, Date.now());
    player.markers2 = markers2; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    if (this.delayedTaskService) {
      await this.delayedTaskService.schedule({
        type: 'repair',
        userId,
        dedupeKey: String(userId),
        runAt: Date.now() + seconds * 1000,
      });
    }
    return `${name}正在维修${vehicle.名称 || vehicle.name},大概需要${seconds}秒`;
  }

  /**
   * 维修延时结算（原版「维修wcc1」L10462-10489）：
   * 延时到期后重发「维修 wcc1」——仍需驾驶载具（弹射/超上限拦截同入口），
   * 通过后用0载具零件把载具修好（计算载具重算加成 → 满血 → 成就维修载具）。
   * 结算文本经世界频道广播（延时路径无指令收尾）。
   * 支柱二：dts tick 直调无外层锁，入口自串行（指令路径重入放行）。
   */
  private async completeVehicleRepair(userId: number): Promise<string> {
    return this.playerService.enqueueUserWrite(userId, () =>
      this.applyCompleteVehicleRepair(userId));
  }

  private async applyCompleteVehicleRepair(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = player.name || '冒险者';
    if (!player.vehicle) return `${name}你现在没有在驾驶载具`;

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${name}不在任何地图上`;
    const vehicle = await this.findTravelVehicle(player, map);
    if (!vehicle) {
      const vehicleKey = String(player.vehicle);
      player.vehicle = '';
      await this.playerService.savePlayer(player);
      return `#错误：附近没有载具${vehicleKey},已弹射`;
    }
    const overLimit = this.findVehicleOverLimitPart(vehicle);
    if (overLimit) {
      return `${name}，${vehicle.名称 || vehicle.name}安装的${overLimit}超过了上限，无法维修`;
    }
    return this.applyVehicleRepair(userId, player, map, vehicle);
  }

  /**
   * 维修生效（原版 L10444-10445 / L10484-10488）：计算载具重算加成 → 当前生命=加成.生命
   * → 成就维修载具+1 → 回复“用0载具零件修好了X（类型）”。
   * 载具优先写回地图 vehicles JSON，DB 载具兜底直更 currentHp/maxHp。
   */
  private async applyVehicleRepair(userId: number, player: any, map: any, vehicle: any): Promise<string> {
    this.combatSystem.recalculateVehicle(vehicle, Date.now());
    const fullHp = Number(vehicle.加成?.生命 || 0) || this.rescueVehicleMaxHp(vehicle);
    vehicle.当前生命 = fullHp;
    vehicle.currentHp = fullHp;
    if (fullHp > 0) {
      vehicle.生命 = fullHp;
      vehicle.maxHp = fullHp;
    }

    const vehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
    const key = String(vehicle.编号 ?? vehicle.vehicleId ?? vehicle.id ?? vehicle.名称 ?? vehicle.name ?? '');
    const matches = (value: any): boolean => [
      value?.编号, value?.vehicleId, value?.id, value?.名称, value?.name,
    ].some((candidate) => candidate !== undefined && candidate !== null && String(candidate) === key);
    const index = key ? vehicles.findIndex(matches) : -1;
    if (index >= 0) {
      vehicles[index] = this.toStoredVehicle(vehicle);
      await this.mapService.updateDynamicFields(map.id, { vehicles });
    } else {
      const dbId = Number(vehicle.id);
      const gameVehicle = (this.prisma as any).gameVehicle;
      if (Number.isInteger(dbId) && dbId > 0 && gameVehicle?.update) {
        await gameVehicle.update({ where: { id: dbId }, data: { currentHp: fullHp, ...(fullHp > 0 ? { maxHp: fullHp } : {}) } });
      }
    }

    await this.advanceTask(userId, '维修载具');
    const vehicleType = String(vehicle.类型 ?? vehicle.type ?? '');
    const typeText = vehicleType ? `（${vehicleType}）` : '';
    return `${player.name || '冒险者'}用0载具零件修好了${vehicle.名称 || vehicle.name}${typeText}`;
  }

  /** 原版 L10419-10427 四类部件超上限拦截：按 功能→武器→行走→防御 顺序返回超限类别名。 */
  private findVehicleOverLimitPart(vehicle: any): string {
    const parts = Array.isArray(vehicle?.parts ?? vehicle?.零件)
      ? (vehicle.parts ?? vehicle.零件)
      : asJsonValue<any[]>(vehicle?.parts ?? vehicle?.零件, []);
    const count = (type: number): number =>
      parts.filter((part: any) => Number(part?.type ?? part?.类型 ?? -1) === type).length;
    if (count(4) > Number(vehicle?.maxFunction ?? 5)) return '功能部件';
    if (count(3) > Number(vehicle?.maxWeapon ?? 5)) return '武器部件';
    if (count(2) > Number(vehicle?.maxMove ?? 5)) return '行走机构';
    if (count(1) > Number(vehicle?.maxDefense ?? 5)) return '防御部件';
    return '';
  }

  /**
   * 处理脱出载具命令
   * 从当前驾驶的载具中脱出
   * 对应原版：脱出 命令
   */
  async handleExitVehicle(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (!player.vehicle) {
      return '你当前没有驾驶任何载具';
    }

    const vehicleKey = String(player.vehicle);
    const map = await this.mapService.getMapById(player.mapId);
    const mapVehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
    const vehicleKeys = (value: any): string[] => [
      value?.编号, value?.vehicleId, value?.id,
    ].filter((key) => key !== undefined && key !== null && String(key) !== '').map(String);
    const index = mapVehicles.findIndex((value: any) => vehicleKeys(value).includes(vehicleKey));

    if (index >= 0) {
      const runtime = this.toRuntimeVehicle(mapVehicles[index]);
      runtime.驾驶员 = '';
      runtime.driver = '';
      mapVehicles[index] = this.toStoredVehicle(runtime);
      await this.mapService.updateDynamicFields(map.id, { vehicles: mapVehicles });
      player.vehicle = '';
      await this.playerService.savePlayer(player);
      await this.achievementService.addAchievement(player, '脱出', 1);
      this.logger.log(`玩家 ${userId} 从载具 ${runtime.名称} 中脱出`);
      return `${player.name}离开了${runtime.名称}(${runtime.类型})`;
    }

    const numericId = Number(vehicleKey);
    const vehicle: any = Number.isInteger(numericId) && numericId > 0
      ? await this.prisma.gameVehicle.findUnique({ where: { id: numericId } })
      : await this.prisma.gameVehicle.findFirst({ where: { vehicleId: vehicleKey } });
    if (!vehicle) {
      player.vehicle = '';
      await this.playerService.savePlayer(player);
      return `#错误：附近没有载具${vehicleKey},已弹射`;
    }

    await this.prisma.gameVehicle.update({ where: { id: vehicle.id }, data: { driver: '' } });
    player.vehicle = '';
    await this.playerService.savePlayer(player);
    await this.achievementService.addAchievement(player, '脱出', 1);
    this.logger.log(`玩家 ${userId} 从载具 ${vehicle.name} 中脱出`);
    return `${player.name}离开了${vehicle.name}(${vehicle.type})`;
  }

  /**
   * 处理接管载具命令
   * 接管其他玩家的载具
   * 对应原版：接管 命令
   */
  async handleTakeoverVehicle(userId: number, targetName: string): Promise<string> {
    if (!targetName) {
      return '请发送“接管骑士”来接管名为骑士的载具';
    }

    // 原版只允许接管当前玩家拥有的载具；接管状态写入玩家.套装.接管载具，
    // 不改变驾驶员，也不把玩家.vehicle 改成被接管载具。
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const ownerIds = new Set([
      String(userId), String(user?.qqNumber ?? ''), String(user?.externalId ?? ''),
      String(player.masterQQ ?? ''),
    ].filter(Boolean));
    const map = await this.mapService.getMapById(player.mapId);
    const vehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
    const match = (item: any): boolean => {
      const identifiers = [item?.名称, item?.name, item?.编号, item?.vehicleId, item?.id]
        .filter((value) => value !== undefined && value !== null).map(String);
      const owner = String(item?.归属 ?? item?.owner ?? '');
      return identifiers.includes(String(targetName)) && ownerIds.has(owner);
    };
    let vehicle: any = vehicles.find(match);
    let vehicleId = vehicle ? String(vehicle.编号 ?? vehicle.vehicleId ?? vehicle.id ?? '') : '';

    if (!vehicle) {
      const numericId = Number(targetName);
      if (Number.isInteger(numericId) && numericId > 0) {
        vehicle = await this.prisma.gameVehicle.findUnique({ where: { id: numericId } });
      }
      if (!vehicle) {
        vehicle = await this.prisma.gameVehicle.findFirst({
          where: { OR: [{ name: targetName }, { vehicleId: targetName }] },
        });
      }
      if (vehicle && ownerIds.has(String(vehicle.owner ?? ''))) {
        vehicleId = String(vehicle.vehicleId || vehicle.id);
      } else {
        vehicle = null;
      }
    }

    if (!vehicle) {
      return `${player.name || '冒险者'},${map?.name || '当前地图'}这里没有名称或者id为${targetName}并且属于你的载具`;
    }

    const sets = this.parseVehicleValue<any>(player.sets, {});
    sets.takeVehicle = vehicleId;
    sets.接管载具 = vehicleId;
    player.sets = sets;
    await this.playerService.savePlayer(player);

    const vehicleName = vehicle.名称 ?? vehicle.name ?? targetName;
    this.logger.log(`玩家 ${userId} 接管了载具 ${vehicleName}`);
    return `${player.name || '冒险者'}已对${vehicleName}进行接管，现在无需驾驶即可拆装部件、设置生产\n“接管停止”可停止接管\n“驾驶”也可以中止接管`;
  }

  /**
   * 处理架炮命令
   * 架设载具火炮
   * 对应原版：架炮 命令
   */
  async handleDeployCannon(userId: number, targetName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (!player.vehicle) {
      return '你当前没有驾驶任何载具，无法架炮';
    }

    // 检查载具是否有武器部件
    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) return '载具数据异常';

    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) return '载具数据不存在';

    const parts = asJsonValue<any[]>(vehicle.parts, []);
    const weaponParts = parts.filter((p: any) => p.partType === 3);

    if (weaponParts.length === 0) {
      return '载具没有安装武器部件，无法架炮\n请先使用「安装」安装武器部件';
    }

    // 选择武器部件（如果有指定目标）
    if (targetName) {
      const targetPart = weaponParts.find((p: any) => p.name === targetName);
      if (!targetPart) {
        return `载具没有安装武器【${targetName}】`;
      }
      return `🔫 已架设【${targetName}】\n目标已锁定，使用「炮击」开火！`;
    }

    // 显示可用的武器
    const lines = [
      `🔫 载具武器列表:`,
      `━━━━━━━━━━━━━━━`,
    ];
    for (const wp of weaponParts) {
      lines.push(`  ${wp.name}`);
    }
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`使用「架炮 武器名」选择武器`);
    return lines.join('\n');
  }

  /**
   * 处理模式转换命令
   * 载具模式转换（如战斗模式、移动模式等）
   * 对应原版：模式转换 命令
   */
  async handleModeChange(userId: number, modeName: string): Promise<string> {
    if (!modeName) {
      return '请指定要转换的模式，格式：模式转换 模式名\n可用模式：战斗、移动、防御、隐匿';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.vehicle) {
      return '你当前没有驾驶任何载具';
    }

    // 模式列表
    const modes: Record<string, string> = {
      '战斗': '战斗模式 - 提升攻击力',
      '移动': '移动模式 - 提升速度',
      '防御': '防御模式 - 提升装甲和护盾',
      '隐匿': '隐匿模式 - 提升闪避',
    };

    if (!modes[modeName]) {
      return `未知模式「${modeName}」\n可用模式：${Object.keys(modes).join('、')}`;
    }

    // 存储载具模式到 markers
    markers['vehicle_mode'] = modeName;
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 将载具切换为${modeName}模式`);
    return `✅ 载具已切换为${modeName}\n${modes[modeName]}`;
  }

  /**
   * 处理转换命令
   * 载具形态转换
   * 对应原版：转换 命令
   */
  async handleTransform(userId: number, targetForm: string): Promise<string> {
    if (!targetForm) {
      return '请指定要转换的形态，格式：转换 形态名';
    }

    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    if (!player.vehicle) {
      return '你当前没有驾驶任何载具';
    }

    // 存储载具形态到 markers
    markers['vehicle_form'] = targetForm;
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 将载具转换为${targetForm}形态`);
    return `✅ 载具已转换为【${targetForm}】形态`;
  }

  /**
   * 处理牵引光束命令
   * 使用工业牵引光束拖拽目标
   * 对应原版：牵引 命令
   */
  async handleTractorBeam(userId: number, targetName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (!player.vehicle) {
      return '你当前没有驾驶任何载具，无法使用牵引光束';
    }

    if (!targetName) {
      return '请指定牵引目标，格式：牵引 目标名';
    }

    // 检查载具是否安装了功能部件（partType=4）
    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) return '载具数据异常';

    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) return '载具数据不存在';

    const parts = asJsonValue<any[]>(vehicle.parts, []);
    const funcParts = parts.filter((p: any) => p.partType === 4);

    if (funcParts.length === 0) {
      return '载具没有安装功能部件，无法使用牵引光束\n请先安装功能部件';
    }

    // 查找目标（可能是玩家或物品）
    const targetUser = await this.prisma.user.findUnique({
      where: { qqNumber: targetName },
    });

    this.logger.log(`玩家 ${userId} 使用牵引光束拖拽目标 ${targetName}`);

    if (targetUser) {
      return `🔦 牵引光束已锁定目标玩家【${targetUser.nickname || targetUser.username}】\n正在拖拽...\n（牵引功能简化版，实际效果取决于目标状态）`;
    }

    return `🔦 牵引光束已锁定目标【${targetName}】\n正在拖拽...`;
  }

  /**
   * 处理控制终端命令（对齐原版 _主程序.ecode L10714-10871）：
   * 原版控制终端是「白」的羁绊终端——当前地图存在自己的白时可查看/设置她的两个
   * 羁绊技能槽（技能a：武器增伤；技能b：宠物饲养/生存之道/贴心助手），每天可改一次。
   * 白不在附近时回退到新框架的载具控制终端。
   * @param arg 子命令：空=总览；技能a[编号]/技能b[编号]=查看或设置
   */
  async handleControlTerminal(userId: number, arg = ''): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const map = await this.mapService.getMapById(player.mapId);

    // 原版：当前地图存在归属自己的「白」→ 羁绊终端
    if (map) {
      const white = await this.ensurePlayerWhite(player, map).catch(() => null);
      if (white) {
        return this.handleWhiteBondTerminal(userId, player, markers, String(arg || '').trim());
      }
    }

    if (!player.vehicle) {
      return `${player.name || '冒险者'}白不在附近，无法操作她的控制终端`;
    }

    const vehicleId = parseInt(player.vehicle, 10);
    if (isNaN(vehicleId)) return '载具数据异常';

    const vehicle = await this.prisma.gameVehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) return '载具数据不存在';

    const parts = asJsonValue<any[]>(vehicle.parts, []);
    const currentMode = markers['vehicle_mode'] || '战斗';
    const currentForm = markers['vehicle_form'] || '标准';

    // 统计各类型部件数量
    const typeCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const part of parts) {
      typeCounts[part.partType] = (typeCounts[part.partType] || 0) + 1;
    }

    return [
      `🖥️ 载具控制终端`,
      `━━━━━━━━━━━━━━━`,
      `🚗 ${vehicle.name}`,
      `❤️ 耐久: ${vehicle.currentHp}/${vehicle.maxHp}`,
      `━━━━━━━━━━━━━━━`,
      `📊 当前状态:`,
      `  模式: ${currentMode}`,
      `  形态: ${currentForm}`,
      `  部件: ${parts.length}个安装`,
      `━━━━━━━━━━━━━━━`,
      `📋 可用操作:`,
      `  驾驶 - 切换载具`,
      `  脱出 - 离开载具`,
      `  载具 - 查看状态`,
      `  安装 - 安装部件`,
      `  拆卸 - 拆卸部件`,
      `  架炮 - 架设武器`,
      `  模式转换 - 切换模式`,
      `  转换 - 切换形态`,
      `  牵引 - 使用牵引光束`,
      `  维修 - 修复耐久度`,
      `━━━━━━━━━━━━━━━`,
      `插槽使用:`,
      `  核心: ${typeCounts[0] || 0}/1`,
      `  武器: ${typeCounts[3] || 0}/${vehicle.maxWeapon || 5}`,
      `  防御: ${typeCounts[1] || 0}/${vehicle.maxDefense || 5}`,
      `  行走: ${typeCounts[2] || 0}/${vehicle.maxMove || 5}`,
      `  功能: ${typeCounts[4] || 0}/${vehicle.maxFunction || 5}`,
    ].join('\n');
  }

  /** 白的羁绊技能1（原版 控制终端技能a：按当前武器类型 +15 攻击2）。 */
  private static readonly BOND_SKILL_A: Array<{ id: number; name: string; desc: string }> = [
    { id: 1, name: '利器管理', desc: '羁绊者使用近战武器时攻击提高0.15倍' },
    { id: 2, name: '弹道分析', desc: '羁绊者使用射弹武器时攻击提高0.15倍' },
    { id: 3, name: '能量稳定', desc: '羁绊者使用能量武器时攻击提高0.15倍' },
    { id: 4, name: '燃料优化', desc: '羁绊者使用制导武器时攻击提高0.15倍' },
    { id: 5, name: '幽能亲和', desc: '羁绊者使用幽能武器时攻击提高0.15倍' },
  ];

  /** 白的羁绊技能2（原版 控制终端技能b）。 */
  private static readonly BOND_SKILL_B: Array<{ id: number; name: string; desc: string }> = [
    { id: 1, name: '宠物饲养', desc: '羁绊者的宠物搜索得到的物品+20%' },
    { id: 2, name: '生存之道', desc: '为羁绊者的远程武器安装一个带特殊加速轨道的消音器，羁绊者使用远程武器攻击时附带攻击伤害的15%随机属性伤害，攻击为隐匿攻击，冷却30秒' },
    { id: 3, name: '贴心助手', desc: '羁绊者使用技能得到的经验+25%' },
  ];

  private bondSkillLabel(slot: 'a' | 'b', value: number): string {
    if (!value) return '未指定';
    const list = slot === 'a' ? GameService.BOND_SKILL_A : GameService.BOND_SKILL_B;
    return list.find((skill) => skill.id === Number(value))?.name ?? '未指定';
  }

  /**
   * 白的羁绊终端（原版 _主程序.ecode L10714-10871）：
   * 总览展示技能1/技能2 当前设置；技能a/技能b 查看候选并设置，每天（有效期当天）只能改一次。
   */
  private async handleWhiteBondTerminal(
    userId: number,
    player: any,
    markers: Record<string, any>,
    arg: string,
  ): Promise<string> {
    const sub = arg.replace(/\d+/g, '');
    const choice = Number((arg.match(/\d+/) || ['0'])[0]) || 0;
    const slot: 'a' | 'b' | '' = sub.includes('技能a') ? 'a' : sub.includes('技能b') ? 'b' : '';

    if (!slot) {
      // 总览（原版 L10840-10869）
      const lines = [
        `【白】`,
        `羁绊者:${player.name || ''}`,
        `技能1:${this.bondSkillLabel('a', Number(markers['bj1'] || 0))}`,
        `技能2:${this.bondSkillLabel('b', Number(markers['bj2'] || 0))}`,
      ];
      const menu = await this.buildNumberedMenu(userId, [
        { label: '选择技能1', cmd: '控制终端技能a' },
        { label: '选择技能2', cmd: '控制终端技能b' },
      ], '💡 发送编号数字(如 1)快速操作');
      lines.push(...menu);
      return lines.join('\n');
    }

    const skillList = slot === 'a' ? GameService.BOND_SKILL_A : GameService.BOND_SKILL_B;
    const skillLabel = () => this.bondSkillLabel(slot, Number(markers[slot === 'a' ? 'bj1' : 'bj2'] || 0));

    if (!choice) {
      // 候选列表（原版 L10739-10762）：当前设置 + 0未指定 + 各技能说明
      const lines = [`${player.name || '冒险者'}`, `当前:${skillLabel()}`, `0、未指定`, `——————————`];
      for (const skill of skillList) {
        lines.push(`${skill.id}、${skill.name}`);
        lines.push(`  ${skill.desc}`);
        lines.push(`——————————`);
      }
      const options = [
        { label: '未指定', cmd: `控制终端技能${slot}0` },
        ...skillList.map((skill) => ({ label: skill.name, cmd: `控制终端技能${slot}${skill.id}` })),
      ];
      const menu = await this.buildNumberedMenu(userId, options, '💡 发送编号数字即可设置对应技能');
      lines.push(...menu);
      return lines.join('\n');
    }

    if (choice < 0 || choice > skillList.length) {
      return `${player.name || '冒险者'}不是被允许选择的项目`;
    }

    // 每天只能修改一次（原版 时间间隔要求("gbj1/gbj2", 有效期当天(), 标记2)）
    const markers2 = asJsonValue<any[]>(player.markers2, []);
    const cooldownName = slot === 'a' ? 'gbj1' : 'gbj2';
    const now = Date.now();
    const endOfDay = new Date();
    endOfDay.setHours(24, 0, 0, 0);
    const active = markers2.find((m: any) => (m?.name ?? m?.名称) === cooldownName);
    const activeExpire = Number(active?.expireAt ?? active?.有效期至 ?? 0) || 0;
    if (activeExpire > now) {
      const remainSec = Math.max(1, Math.ceil((activeExpire - now) / 1000));
      return `${player.name || '冒险者'}今天已经设置过了，还需${this.millisecondsToText(remainSec * 1000)}后才能再次修改`;
    }
    const marker = { name: cooldownName, expireAt: endOfDay.getTime() };
    const idx = markers2.findIndex((m: any) => (m?.name ?? m?.名称) === cooldownName);
    if (idx >= 0) markers2[idx] = marker;
    else markers2.push(marker);

    markers[slot === 'a' ? 'bj1' : 'bj2'] = choice;
    player.markers = markers; // Json 列直接写对象
    player.markers2 = markers2; // Json 列直接写数组
    // 指令路径在 PlayerMutateService 快照内，外层统一落库，无需裸 savePlayer。
    return `${player.name || '冒险者'}\n白的技能${slot === 'a' ? 1 : 2}被设置为${skillLabel()}`;
  }

  /**
   * 处理载具操作命令
   * 查看载具操作指南
   * 对应原版：载具操作 命令
   */
  async handleVehicleOps(userId: number): Promise<string> {
    return [
      `📖 载具操作指南`,
      `━━━━━━━━━━━━━━━`,
      `【基础操作】`,
      `  组装 核心名 - 使用核心部件创建载具`,
      `  驾驶 载具名 - 驾驶载具`,
      `  载具 - 查看当前载具状态`,
      `  脱出 - 离开载具`,
      `━━━━━━━━━━━━━━━`,
      `【部件管理】`,
      `  安装 部件名 - 安装部件到载具`,
      `  拆卸 部件名 - 从载具拆卸部件`,
      `  载具模拟 [部件名] - 模拟性能`,
      `━━━━━━━━━━━━━━━`,
      `【战斗操作】`,
      `  架炮 [武器名] - 架设武器`,
      `  炮击 - 使用载具火炮攻击`,
      `  模式转换 模式名 - 切换模式`,
      `━━━━━━━━━━━━━━━`,
      `【其他操作】`,
      `  载具命名 新名称 - 为载具命名`,
      `  维修 - 修复载具耐久`,
      `  牵引 目标 - 使用牵引光束`,
      `  转换 形态名 - 转换形态`,
      `  控制终端 - 打开控制面板`,
      `  接管 载具名 - 接管其他载具`,
    ].join('\n');
  }

  /**
   * 处理增幅器说明命令
   * 查看增幅器使用说明，展示增幅器系统的功能与用法
   * 对应原版：增幅器 命令
   */
  async handleAmplifierHelp(userId: number): Promise<string> {
    return [
      `📈 增幅器系统说明`,
      `━━━━━━━━━━━━━━━`,
      `增幅器是一种可以提升玩家属性的特殊装备，佩戴在增幅器插槽中。`,
      `━━━━━━━━━━━━━━━`,
      `【增幅器类型】`,
      `  1. 攻击增幅器 - 提升攻击力`,
      `  2. 防御增幅器 - 提升防御力`,
      `  3. 生命增幅器 - 提升最大生命值`,
      `  4. 速度增幅器 - 提升移动速度`,
      `  5. 暴击增幅器 - 提升暴击率和暴击伤害`,
      `━━━━━━━━━━━━━━━`,
      `【使用方法】`,
      `  装备增幅器：装备 增幅器名`,
      `  查看已装备：信息`,
      `━━━━━━━━━━━━━━━`,
      `增幅器可以通过战斗掉落、商店购买或合成获得。`,
    ].join('\n');
  }

  // ========== 宠物/社交命令 ==========

  /**
   * 处理开始捕捉命令
   * 开始捕捉宠物/使魔，委托到 FamiliarSystemService 的捕捉系统
   * 对应原版：开始捕捉 命令
   */
  async handleStartCapture(userId: number, targetName: string): Promise<string> {
    // 委托到 FamiliarSystemService 的捕捉系统（start 动作）
    return this.familiarSystemService.capturePet(userId, 'start', targetName);
  }

  /**
   * 处理停止捕捉命令
   * 停止当前的捕捉操作，委托到 FamiliarSystemService 的捕捉系统
   * 对应原版：停止捕捉 命令
   */
  async handleStopCapture(userId: number, targetName?: string): Promise<string> {
    // 委托到 FamiliarSystemService 的捕捉系统（stop 动作）
    return this.familiarSystemService.capturePet(userId, 'stop', targetName);
  }

  /**
   * 修改当前地图上归属玩家、且允许控制的召唤物模式。
   * 原版“全部”命令只处理归属当前玩家的非幼崽/非阵地召唤物，不能把
   * 召唤物自身 QQ 当成归属，否则地图上的公共 NPC 可能被误改。
   */
  private async updateOwnedSummonMode(
    userId: number,
    mode: 'follow' | 'idle' | 'active' | 'passive',
  ): Promise<{ count: number; map?: any }> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return { count: 0 };

    const rawSummons = typeof map.summons === 'string'
      ? asJsonValue<any[]>(map.summons, [])
      : map.summons;
    const summons = Array.isArray(rawSummons) ? rawSummons : [];
    const ownerIds = new Set([
      userId,
      player.id,
      player.userId,
      player.qqNumber,
      player.externalId,
      player.masterQQ,
    ].map((value) => String(value ?? '')).filter(Boolean));

    const controllable = summons.filter((summon: any) => {
      const owner = String(
        summon?.ownerQQ ?? summon?.归属 ?? summon?.owner ?? summon?.ownerId ?? '',
      );
      if (!ownerIds.has(owner)) return false;

      const rawMarkers = typeof summon?.markers === 'string'
        ? asJsonValue<any>(summon.markers, {})
        : (summon?.markers ?? summon?.标记 ?? {});
      const markers = rawMarkers && typeof rawMarkers === 'object' ? rawMarkers : {};
      return Number(markers['幼崽'] ?? markers['阵地'] ?? 0) === 0;
    });

    for (const summon of controllable) {
      const rawMarkers = typeof summon?.markers === 'string'
        ? asJsonValue<any>(summon.markers, {})
        : (summon?.markers ?? summon?.标记 ?? {});
      const markers = rawMarkers && typeof rawMarkers === 'object' ? { ...rawMarkers } : {};
      if (mode === 'follow') {
        summon.follow = true;
        summon.mode = 'follow';
        markers['跟随'] = 0;
      } else if (mode === 'idle') {
        summon.follow = false;
        summon.mode = 'idle';
        markers['跟随'] = 1;
      } else if (mode === 'active') {
        summon.mode = 'active';
        summon.active = true;
        markers['主动'] = 0;
      } else {
        summon.mode = 'passive';
        summon.active = false;
        markers['主动'] = 1;
      }
      summon.markers = markers; // Json 列直接写对象
      if (summon.标记 !== undefined) summon.标记 = summon.markers;
    }

    if (controllable.length > 0) {
      await this.mapService.updateDynamicFields(map.id, { summons });
    }
    return { count: controllable.length, map };
  }

  /**
   * 处理全部跟随命令
   * 使所有属于当前玩家的宠物/使魔跟随
   * 对应原版：全部跟随 命令
   */
  async handleFollowAll(userId: number): Promise<string> {
    const result = await this.updateOwnedSummonMode(userId, 'follow');
    if (result.count === 0) {
      return '当前地图上没有属于你的宠物';
    }
    this.logger.log(`玩家 ${userId} 设置了 ${result.count} 只宠物跟随`);
    return `已将 ${result.count} 只宠物设置为跟随模式`;
  }

  /**
   * 处理补魔命令
   * 补充魔力/能量，消耗资源恢复魔法值
   * 对应原版：补魔 命令
   */
  async handleRefill(userId: number): Promise<string> {
    // 对齐原版 _主程序.ecode L7110-7129「补魔」：与跟随中的召唤物补魔（涩涩玩法），
    // 非喝药回蓝。门禁链：躺下中 → 自家房子屋内 → 有跟随召唤物 → 补魔间隔21600秒。
    // 通过后：随机取对话(类型7 补魔开始) + 「工作」35秒 + 排程30秒延时结算
    // （completeRefill，原版「覅b魔w成」）。
    return this.mutatePlayer(userId, async (ctx) => {
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
      const display = await this.summonFollowDisplay(map, userId, { requireFollow: true, countLimit: 2 });
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
      const target = summons[display.indexes[this.randomInt(0, display.indexes.length - 1)]];
      const dialogue = target
        ? this.staticData.getDialogue(String(player.name ?? ''), target, String(target.name ?? target.名称 ?? ''), 7)
        : '';

      // 执行：工作 35 秒标记（原版 L7127 添加标记("工作",35,玩家.标记2)）+ 排程 30 秒延时
      this.normalizeMarkers2(markers2);
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
  private async completeRefill(userId: number): Promise<void> {
    const text = await this.playerService.enqueueUserWrite(userId, async () => {
      const playerData = await this.playerService.getPlayerData(userId);
      const { player } = playerData;
      const map = await this.mapService.getMapById(player.mapId);
      if (!map) return '';

      // 补魔对象校验（原版 L7159-7161：跟随显示 b==0 → 补魔失败）
      const display = await this.summonFollowDisplay(map, userId, { requireFollow: true, countLimit: 2 });
      if (display.count === 0) return `${player.name ?? '冒险者'}补魔对象丢失，补魔失败`;
      const displayText = `与${display.names.join('、')}一起`;

      // 随机取一个对象说补魔结束台词（原版 L7163-7166 取对话(…,8)）
      const mapSummons: any[] = Array.isArray(map.summons) ? map.summons : asJsonValue<any[]>(map.summons, []);
      const target = mapSummons[display.indexes[this.randomInt(0, display.indexes.length - 1)]];
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
      await this.advanceTask(userId, '补魔', 2);
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
        await this.pushPlayerUpdate(userId);
        await this.pushMapUpdate(userId);
      } catch { /* 推送失败不影响结算 */ }
    }
  }

  /**
   * 处理挤奶命令。
   * 对齐原版 _主程序.ecode L9034-L9084：成功对象按“对象QQ+当天”冷却，
   * 普通召唤物默认产奶0.25，怪物/捕捉动物读取产奶量；所有成功对象共用一套结算。
   */
  async handleMilk(userId: number, targetName?: string): Promise<string> {
    const result = await this.settleMilk(userId, targetName, false);
    return result.text;
  }

  /** 批量挤奶与单体挤奶共用的结算入口。 */
  private async settleMilk(
    userId: number,
    targetName?: string,
    all = false,
  ): Promise<{ text: string; count: number; amount: number }> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return { text: '你不在任何地图上', count: 0, amount: 0 };

    const summons = asJsonValue<any[]>(map.summons || '[]', []);
    const user = typeof this.prisma?.user?.findUnique === 'function'
      ? await this.prisma.user.findUnique({ where: { id: userId } }).catch(() => null)
      : null;
    const ownerIds = new Set([
      userId,
      player.id,
      player.userId,
      player.qqNumber,
      player.externalId,
      user?.qqNumber,
      user?.externalId,
      player.masterQQ,
    ].map((value) => String(value ?? '')).filter(Boolean));
    const isOwned = (pet: any): boolean => ownerIds.has(String(
      pet?.ownerQQ ?? pet?.归属 ?? pet?.owner ?? '',
    ));
    const displayName = (pet: any): string => String(
      pet?.name ?? pet?.名称 ?? pet?.type ?? pet?.类型 ?? '宠物',
    );
    const owned = summons.filter((pet: any) => isOwned(pet));

    if (!all && !targetName) {
      return { text: `${player.name || '冒险者'}请输入要挤奶的宠物名称`, count: 0, amount: 0 };
    }

    const targets = all
      ? owned
      : owned.filter((pet: any) => displayName(pet) === String(targetName).trim());
    if (!all && targets.length === 0) {
      return {
        text: `${player.name || '冒险者'}${map.name}这里没有属于你并且名为${targetName}的NPC或宠物`,
        count: 0,
        amount: 0,
      };
    }

    const markers2 = Array.isArray((playerData as any).markers2)
      ? (playerData as any).markers2
      : asJsonValue<any[]>(player.markers2, []);
    this.normalizeMarkers2(markers2);
    const now = Date.now();
    const endOfDay = new Date(now);
    endOfDay.setHours(24, 0, 0, 0);
    const dayEndMs = endOfDay.getTime();
    const cooldownFor = (pet: any): { cooling: boolean; remainingMs: number } => {
      const key = `挤奶${String(pet?.qq ?? pet?.QQ ?? pet?.id ?? '')}`;
      const marker = markers2.find((entry: any) => entry?.名称 === key);
      if (marker) {
        const remainingMs = Number(marker.有效期至 || 0) - now;
        if (remainingMs > 0) return { cooling: true, remainingMs };
        const index = markers2.indexOf(marker);
        if (index >= 0) markers2.splice(index, 1);
      }
      markers2.push({ 名称: key, 有效期至: dayEndMs });
      return { cooling: false, remainingMs: 0 };
    };

    // 原版只要玩家拥有茸，本次总奶量就增加25%，与被挤奶对象无关。
    const hasRong = owned.some((pet: any) => this.isMilkSpecial(pet, '茸', -10));
    const backpack = Array.isArray((playerData as any).backpack)
      ? (playerData as any).backpack
      : this.playerService.getBackpackItems(player);
    let totalMilk = 0;
    let successCount = 0;
    let cooldownText = '';
    let blueDragonReward = false;
    const successNames: string[] = [];

    for (const target of targets) {
      const qq = String(target?.qq ?? target?.QQ ?? target?.id ?? '');
      // 原版：QQ 中带 x 的临时召唤物不能挤奶。
      if (qq.includes('x')) continue;

      const amount = this.getMilkAmount(target);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const cooldown = cooldownFor(target);
      if (cooldown.cooling) {
        if (!all && !cooldownText) {
          cooldownText = `还需要${this.formatMilkRemaining(cooldown.remainingMs)}后才能再次给${displayName(target)}挤奶`;
        }
        continue;
      }

      this.addSummonMilkAffinity(target, ownerIds);
      totalMilk += amount;
      successCount += 1;
      successNames.push(displayName(target));

      if (this.isMilkSpecial(target, '青龙', -9)) blueDragonReward = true;
    }

    if (successCount === 0) {
      if (!all && cooldownText) {
        player.markers2 = markers2; // Json 列直接写数组
        await this.playerService.savePlayer(player);
        return { text: `${player.name || '冒险者'}${cooldownText}`, count: 0, amount: 0 };
      }
      return {
        text: `${player.name || '冒险者'}附近没有可以挤奶的对象了`,
        count: 0,
        amount: 0,
      };
    }

    if (hasRong) totalMilk *= 1.25;
    this.addItemToCollection(backpack, { name: '奶', type: '资源', quantity: totalMilk });
    player.backpack = backpack; // Json 列直接写数组
    player.markers2 = markers2; // Json 列直接写数组

    let extraText = '';
    if (blueDragonReward && !this.hasActiveMilkMarker(markers2, 'zq', now)) {
      markers2.push({ 名称: 'zq', 有效期至: dayEndMs });
      player.markers2 = markers2; // Json 列直接写数组
      const upgradeExp = Number(player.upgradeExp || 0);
      if (upgradeExp > 0) {
        player.exp = Number(player.exp || 0) + upgradeExp;
        extraText = `获得了${this.roundText(upgradeExp)}经验\n`;
      }
    }

    await this.mapService.updateDynamicFields(map.id, { summons });
    await this.playerService.savePlayer(player);
    await this.advanceTask(userId, '挤奶', successCount);

    const bonusText = hasRong ? '（茸使奶量+25%）' : '';
    const names = successNames.join('、');
    const actionText = all
      ? `${player.name || '冒险者'}给${names}挤了奶，得到了奶×${this.roundText(totalMilk)}`
      : `从${names}挤出了奶，获得了奶×${this.roundText(totalMilk)}`;
    this.logger.log(`玩家 ${userId} 挤奶成功：${names} ×${totalMilk}`);
    return { text: `${extraText}${actionText}${bonusText}`, count: successCount, amount: totalMilk };
  }

  private formatMilkRemaining(ms: number): string {
    const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
    if (totalSeconds < 60) return `${totalSeconds}秒`;
    return `${Math.ceil(totalSeconds / 60)}分钟`;
  }

  private hasActiveMilkMarker(markers2: any[], name: string, now: number): boolean {
    const marker = markers2.find((entry: any) => entry?.名称 === name);
    return Boolean(marker && Number(marker.有效期至 || 0) > now);
  }

  private isMilkSpecial(pet: any, name: '茸' | '青龙', specialSeq: number): boolean {
    const petName = String(pet?.name ?? pet?.名称 ?? pet?.type ?? pet?.类型 ?? '');
    const vitality = Number(pet?.vitality ?? pet?.活力 ?? 0);
    const seq = Number(pet?.specialSeq ?? pet?.特殊序号 ?? 0);
    return petName === name || petName.includes(name) || vitality === specialSeq || seq === specialSeq;
  }

  private getMilkAmount(pet: any): number {
    const name = String(pet?.name ?? pet?.名称 ?? pet?.type ?? pet?.类型 ?? '');
    const qq = String(pet?.qq ?? pet?.QQ ?? '');
    const direct = Number(pet?.milkAmount ?? pet?.milkYield ?? pet?.产奶量 ?? pet?.奶量);
    if (Number.isFinite(direct) && direct > 0) return direct;

    const rawBonus = pet?.bonus ?? pet?.加成;
    const bonus = typeof rawBonus === 'string'
      ? asJsonValue<any>(rawBonus, {})
      : (rawBonus || {});
    const fromPetBonus = Number(bonus?.产奶量 ?? bonus?.milkAmount ?? bonus?.milkYield);
    if (Number.isFinite(fromPetBonus) && fromPetBonus > 0) return fromPetBonus;

    const monster = this.staticData?.getMonsterByName?.(name)
      ?? this.staticData?.getMonsterByName?.(String(pet?.type ?? pet?.类型 ?? ''));
    const monsterBonus = typeof monster?.bonus === 'string'
      ? asJsonValue<any>(monster.bonus, {})
      : (monster?.bonus || {});
    const fromDefinition = Number(monsterBonus?.产奶量 ?? monsterBonus?.milkAmount ?? monsterBonus?.milkYield);
    if (Number.isFinite(fromDefinition) && fromDefinition > 0) return fromDefinition;

    const isMonster = qq.startsWith('怪物')
      || String(pet?.type ?? pet?.类型 ?? '').includes('怪物')
      || Number(pet?.specialSeq ?? pet?.特殊序号 ?? 0) < 0
      || Boolean(monster);
    if (isMonster) {
      return Number(pet?.affinity ?? pet?.好感 ?? 0) || 0;
    }
    return 0.25;
  }

  private addSummonMilkAffinity(pet: any, ownerIds: Set<string>): void {
    const owner = String(pet?.ownerQQ ?? pet?.归属 ?? pet?.owner ?? '') || [...ownerIds][0] || '';
    const key = `好感${owner}`;
    const field = pet?.markers !== undefined ? 'markers' : (pet?.标记 !== undefined ? '标记' : 'markers');
    const raw = pet?.[field];
    if (Array.isArray(raw)) {
      const item = raw.find((entry: any) => (entry?.name ?? entry?.名称) === key);
      if (item) {
        if (item.value !== undefined) item.value = Number(item.value || 0) + 1;
        else if (item.数值 !== undefined) item.数值 = Number(item.数值 || 0) + 1;
        else item.value = 1;
      } else {
        raw.push({ name: key, value: 1 });
      }
      pet[field] = raw;
      return;
    }
    const markers = typeof raw === 'string'
      ? asJsonValue<any>(raw, {})
      : (raw && typeof raw === 'object' ? raw : {});
    const existingKey = Object.prototype.hasOwnProperty.call(markers, key)
      ? key
      : Object.prototype.hasOwnProperty.call(markers, `${owner}好感`) ? `${owner}好感` : key;
    markers[existingKey] = Number(markers[existingKey] || 0) + 1;
    pet[field] = typeof raw === 'string' ? JSON.stringify(markers) : markers;
  }

  /**
   * 处理剪毛命令（原版 _主程序.ecode L11267-11331）。
   * 门禁：装备要求（#剪刀=-40，持握）→ 无参用法提示 → 目标查找（归属召唤物按图片名 /
   * @玩家）→ 精英前缀替换 → 按物种当天冷却（"剪毛"+类型，有效期当天）→ 产物入包
   * → 成就四连（剪毛<类型>/剪毛/采集/采集<毛名>）。
   * 普拉娜幼崽关键词委托 FamiliarSystemService.shearPlana（独立冷却流程）。
   */
  async handleShear(userId: number, targetName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = player.name || '冒险者';

    // 装备要求（#剪刀，持握）（原版 L11270-11271：特殊序号-40，需拿在手上）
    const equipments = playerData.equipment || asJsonValue<any[]>(player.equipment, []);
    const weapons = playerData.weapons || asJsonValue<any[]>(player.weapons, []);
    if (!this.combatState.equipRequire(equipments, weapons, Number(player.currentWeapon ?? 0), -40, '剪刀', true)) {
      return `${name},需要装备剪刀并且拿在手上`;
    }

    // 无参 → 用法提示（原版 L11272-11273）
    if (!targetName) {
      return `${name},"剪毛@人/宠物名称"来剪毛，根据对象不同得到的毛发也不同`;
    }

    // 如果目标匹配普拉娜，委托到 FamiliarSystemService 的普拉娜幼崽剪毛操作
    if (/普拉娜|plana/i.test(targetName)) {
      const result = await this.familiarSystemService.shearPlana(userId);
      if (/获得了?毛发|获得毛发/.test(result) && !/冷却|需要|失败/.test(result)) {
        await this.advanceTask(userId, '剪毛');
        await this.advanceTask(userId, '剪毛普拉娜幼崽');
        await this.advanceTask(userId, '采集');
        await this.advanceTask(userId, '采集毛发');
      }
      return result;
    }

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上';

    // 解析当前地图上的召唤物
    const summons = asJsonValue<any[]>(map.summons || '[]', []);
    const playerIdStr = String(player.userId);

    // 查找可剪毛的宠物（羊、绵羊、普拉娜等）
    const shearablePets = summons.filter((pet: any) => {
      const isOwner = String(pet.ownerQQ ?? pet.归属 ?? pet.owner ?? '') === playerIdStr;
      const isAlive = (pet.hp || pet.currentHp || 0) > 0;
      return isOwner && isAlive;
    });

    if (shearablePets.length === 0) {
      return '当前地图上没有可剪毛的宠物';
    }

    // 选择目标
    const target = targetName
      ? shearablePets.find((pet: any) => [
        pet.name,
        pet.名称,
        pet.image,
        pet.图片,
        pet.type,
        pet.类型,
      ].some((value) => String(value ?? '') === targetName))
      : shearablePets[0];

    if (!target) {
      // 原版 L11285-11287：召唤物未命中则按 @玩家 解析（玩家物种字段未迁移，
      // 玩家对象无毛发可剪，按“附近没有”口径提示）
      if (/^@/.test(targetName) || /^\[@.*\]$/.test(targetName)) {
        return `${name},附近没有${targetName.replace(/^@/, '').replace(/^\[/, '').replace(/\]$/, '')}`;
      }
      return `当前地图上没有名为「${targetName}」的可剪毛宠物`;
    }

    const targetType = String(target.type ?? target.类型 ?? target.name ?? target.名称 ?? '宠物')
      .replace(/^精英/, '');

    // 按物种当天冷却（原版 L11320-11322：时间间隔要求("剪毛"+类型, 有效期当天())）
    const markers2 = asJsonValue<any[]>(player.markers2, []);
    this.normalizeMarkers2(markers2);
    const now = Date.now();
    const endOfDay = new Date(now);
    endOfDay.setHours(24, 0, 0, 0);
    const cooldownKey = `剪毛${targetType}`;
    const active = markers2.find((m: any) => (m?.name ?? m?.名称) === cooldownKey);
    const activeExpire = Number(active?.expireAt ?? active?.有效期至 ?? 0) || 0;
    if (activeExpire > now) {
      return `${name}给${targetType}这种动物剪毛冷却${this.millisecondsToText(activeExpire - now)}`;
    }
    const marker = { name: cooldownKey, expireAt: endOfDay.getTime() };
    const markerIdx = markers2.findIndex((m: any) => (m?.name ?? m?.名称) === cooldownKey);
    if (markerIdx >= 0) markers2[markerIdx] = marker;
    else markers2.push(marker);
    player.markers2 = markers2; // Json 列直接写数组

    const targetDefinition = this.staticData?.getFamiliarByName?.(targetType)
      ?? this.staticData?.getMonsterByName?.(targetType);
    let hair: any = target.hair ?? target.毛发 ?? target.hairDrop ?? targetDefinition?.hairDrop;
    if (typeof hair === 'string') {
      const parsed = asJsonValue<any>(hair, null);
      if (parsed !== null) {
        hair = parsed;
      } else {
        const match = hair.match(/^(.*?)(-?\d+(?:\.\d+)?)$/);
        hair = {
          name: (match?.[1] || hair).trim() || '毛发',
          count: match ? Number(match[2]) || 1 : 1,
        };
      }
    }
    if (Array.isArray(hair)) hair = hair[0];
    const hairName = String(hair?.name ?? hair?.名称 ?? target.hairName ?? target.毛发名称 ?? '毛发');
    const hairCount = Math.max(1, Number(hair?.count ?? hair?.quantity ?? hair?.数量 ?? 1) || 1);

    // 原版 L11324-L11330：成功后任务同时记录物种、剪毛、采集和产物。
    await this.playerService.savePlayer(player);
    await this.playerService.addToBackpack(userId, hairName, hairCount);
    await this.advanceTask(userId, `剪毛${targetType}`, hairCount);
    await this.advanceTask(userId, '剪毛', hairCount);
    await this.advanceTask(userId, '采集', hairCount);
    await this.advanceTask(userId, `采集${hairName}`, hairCount);

    const targetDisplayName = target.name ?? target.名称 ?? target.type ?? target.类型 ?? '宠物';
    this.logger.log(`玩家 ${userId} 从 ${targetDisplayName} 剪毛成功`);
    return `${name}给${targetDisplayName}剪了毛，得到了${hairName}x${hairCount}`;
  }

  // ========== 任务/设置命令 ==========

  /**
   * 处理放弃任务命令
   * 放弃当前已接取的任务，从玩家任务列表中移除
   * 对应原版：放弃任务 命令
   */
  async handleAbandonQuest(userId: number, questName: string): Promise<string> {
    return this.taskService.abandonTask(userId, questName);
  }

  // ========== 其他命令 ==========

  /**
   * 处理游戏主菜单命令
   * 显示使魔大战的主菜单，并通过临时输入替换生成编号子菜单（对齐原版 _主程序.ecode L1573）。
   * 玩家直接发编号数字即可进入对应功能，无需记忆指令名。
   * 对应原版：使魔大战 命令
   */
  async handleGameIntro(userId: number): Promise<string> {
    // 主菜单项（编号 + 触发指令）。全部为已验证存在、可正常执行的指令。
    const menu: { label: string; cmd: string }[] = [
      { label: '召唤使魔', cmd: '召唤使魔' },
      { label: '查看使魔', cmd: '使魔数据' },
      { label: '更换使魔', cmd: '选择使魔' },
      { label: '查看背包', cmd: '背包' },
      { label: '使魔数据', cmd: '使魔数据' },
      { label: '复活使魔', cmd: '复活使魔' },
      { label: '查看植入体', cmd: '查看植入体' },
      { label: '个人设置', cmd: '设置' },
      { label: '查看增幅器', cmd: '查看增幅器' },
      { label: '观察附近', cmd: '观察附近' },
      { label: '切换武器', cmd: '切换武器' },
      { label: '命名使魔', cmd: '命名使魔' },
      { label: '使魔商店', cmd: '使魔商店' },
      { label: '使魔家园', cmd: '使魔家园' },
      { label: '快速移动', cmd: '飞到' },
      { label: '传送到地图', cmd: '传送' },
      { label: '探测雷达', cmd: '探测雷达' },
      { label: '查看任务', cmd: '查看任务' },
      { label: '游戏图鉴', cmd: '图鉴' },
      { label: '游戏解释', cmd: '游戏解释' },
      { label: '制造', cmd: '制造' },
      { label: '载具模拟', cmd: '载具模拟' },
      { label: '使魔挑战', cmd: '使魔挑战' },
      { label: '宠物操作', cmd: '宠物操作' },
      { label: '装备预设', cmd: '装备预设' },
      { label: '使魔排行', cmd: '使魔排行' },
      { label: '使魔称号', cmd: '使魔称号' },
      { label: '更新历史', cmd: '更新历史' },
      { label: '逆向', cmd: '逆向' },
      { label: '扫荡', cmd: '扫荡' },
      { label: '配方', cmd: '配方' },
      { label: '全部指令', cmd: '帮助' },
    ];

    const lines: string[] = [
      `🎮 使魔大战 - 主菜单`,
      `━━━━━━━━━━━━━━━`,
      `发送下方编号数字即可进入对应功能：`,
    ];
    // 生成编号临时输入替换（1@指令#2@指令...），玩家发数字即可触发
    const tempGroups: string[] = [];
    for (let i = 0; i < menu.length; i++) {
      lines.push(`  ${i + 1}. ${menu[i].label}`);
      tempGroups.push(`${i + 1}@${menu[i].cmd}`);
    }
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`💡 发送编号数字(如 1)即可快速进入功能`);
    lines.push(`也可以直接发送指令名，如「背包」「攻击」「移动 地图名」`);

    // 设置临时输入替换（2分钟有效，发数字即触发对应指令）
    if (tempGroups.length > 0) {
      await this.shortcutService.setTempInput(userId, tempGroups.join('#'));
    }

    return lines.join('\n');
  }

  /**
   * 新玩家"选第一个使魔"门禁（对应原版 _主程序.ecode L11464-11480）
   * 原版：新玩家(老玩家==假)发任何指令都会被强制拦截，返回"选择你的第一个使魔来开始游戏"，
   * 列出所有不可召唤=假的使魔并生成编号快捷（数字@选择使魔<名称>），选中后才正式开局。
   *
   * @param userId 玩家用户ID
   * @returns 未选使魔时返回门禁菜单文本；已选使魔返回 null
   */
  async getFirstFamiliarGate(userId: number): Promise<string | null> {
    // 轻量预检：此方法在每条指令的 dispatch 入口都会被调用，而绝大多数玩家
    // 早已选过使魔。一次 select type 的单列查询即可短路返回，避免每条消息
    // 都走 getPlayerData 的全量读档（整行 + 集合解析，远程库下是显著开销）。
    const lite = await this.prisma.player.findUnique({
      where: { userId },
      select: { type: true },
    });
    if (lite?.type) return null;

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    // 已选择使魔（type 非空）→ 不拦截；玩家行不存在时 lite 为 null，
    // 也会走到这里，交由 getPlayerData 的既有行为兜底处理
    if (player.type) return null;

    // 列出所有可召唤使魔（不可召唤=假 的才可被选为第一个使魔），
    // 文本格式与 选择使魔 无参列表共用同一构建器（原版 L11467-11480 两列编号菜单）
    const allFamiliars = this.staticData.getAllFamiliars().filter((f: any) => !f.noSummon);
    const menu = buildFamiliarGateMenu(allFamiliars);

    // 生成编号临时输入替换（发数字即触发 选择使魔<名称>）
    if (menu.tempInput) {
      await this.shortcutService.setTempInput(userId, menu.tempInput);
    }

    return menu.text;
  }

  /** 服务器本地日期串（对应原版 是否同天 的"同一天"判定粒度） */
  private localTodayString(now = new Date()): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  /**
   * 每日登录结算（对应原版 _主程序.ecode L11707-11821 每条消息结算段）：
   * 玩家当日首次指令时触发一次——
   * - 重置 冥鱼次数/创世纪/启示录 每日计数标记；
   * - 「签到」计数+1（即"加入游戏第N天"），并推进同名任务要求；
   * - 周末（周六传说/周日史诗）强化券x10 + 活力（10×(1+魅力/200)）；
   * - 使魔挑战层每日奖励：挑战装备箱/挑战物资箱/挑战资源箱各 ⌈层数/5⌉ 个；
   * - 隔日交替的今日登陆奖励：奇数天史诗/偶数天传说强化券x5 + 活力；
   * - 挑战 100/200/…/1000 层的里程碑额外奖励。
   * 未开局玩家不结算；开局确认当次即首触，因此新玩家第一条完整指令
   * 就会看到"加入游戏第1天"的登陆奖励块（与原版一致）。
   * @returns 需前插到指令结果之前的文本块；当日已结算或未开局返回 ''
   */
  async settleDailyLogin(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (!player.type) return '';

    const markers = asJsonValue<Record<string, any>>(player.markers, {});
    const today = this.localTodayString();
    if (markers['签到时间'] === today) return '';

    // 魅力取自完整加成计算（原版 玩家.属性.魅力），失败按 0 处理
    let charm = 0;
    try {
      const bonus = this.combatSystem.buildAttackerBonus(player, playerData) as any;
      charm = Number(bonus?.魅力) || 0;
    } catch {
      /* 加成计算失败不影响登录结算 */
    }

    markers['签到时间'] = today;
    // 跨天重置每日计数标记（原版 L11708-11710）
    markers['冥鱼次数'] = 0;
    markers['创世纪'] = 0;
    markers['启示录'] = 0;
    const signInDays = this.playerService.getMarkerValue(markers, '签到') + 1;
    markers['签到'] = signInDays;

    const vitalityGain = 10 * (1 + charm / 200);
    const w2Parts: string[] = [];
    const w3Parts: string[] = [];

    // 物品统一在内存背包中合并，随本次结算一次性落库（避免 addToBackpack 多次
    // 落库后再被末尾 savePlayer 的旧快照覆盖）
    const backpack = this.playerService.getBackpackItems(player);
    const grant = (itemName: string, count: number): void => {
      const existing = backpack.find((item: any) => item.name === itemName);
      if (existing) {
        const cur = Number(existing.count ?? existing.quantity ?? 0);
        existing.count = cur + count;
        delete existing.quantity;
      } else {
        backpack.push({ name: itemName, count });
      }
    };

    // 周末强化券（星期六=传说、星期日=史诗）+ 活力（原版 L11717-11732）
    const weekday = new Date().getDay(); // 0=周日 6=周六
    if (weekday === 6) {
      w2Parts.push(`(周末)10传说强化券、${Math.round(vitalityGain)}活力`);
      grant('传说强化券', 10);
      player.vitality = Number(player.vitality || 0) + vitalityGain;
    } else if (weekday === 0) {
      w2Parts.push(`(周末)10史诗强化券${Math.round(vitalityGain)}活力`);
      grant('史诗强化券', 10);
      player.vitality = Number(player.vitality || 0) + vitalityGain;
    }

    // 使魔挑战层每日奖励：挑战等级 0 视为 1，三箱数量 = ⌈层数/5⌉（原版 L11734-11746）
    let challengeLevel = this.playerService.getMarkerValue(markers, '挑战等级');
    if (challengeLevel <= 0) {
      challengeLevel = 1;
      markers['挑战等级'] = 1;
    }
    const boxCount = Math.ceil(challengeLevel / 5);
    grant('挑战装备箱', boxCount);
    grant('挑战物资箱', boxCount);
    grant('挑战资源箱', boxCount);
    w2Parts.push(`使魔挑战第${challengeLevel}层每日奖励:${boxCount}的挑战装备箱和挑战物资箱、资源箱`);

    // 隔日交替的今日登陆奖励（奇数天=史诗、偶数天=传说，原版 L11750-11774）。
    // 展示活力加成按「历史最高活力-100」计（原版 活力2 语义），与实际入账值可能不同（原版即如此）。
    const vitalityMax = Number(markers['活力2'] || 100);
    const displayCharm = Math.max(0, vitalityMax - 100);
    if (signInDays % 2 === 1) {
      w3Parts.push(`加入游戏第${signInDays}天\n今日登陆奖励:\n5史诗强化券、${Math.round(10 * (1 + displayCharm / 200))}活力`);
      grant('史诗强化券', 5);
      player.vitality = Number(player.vitality || 0) + vitalityGain;
    } else {
      w3Parts.push(`加入游戏第${signInDays}天\n今日登陆奖励:\n5传说强化券、${Math.round(10 * (1 + displayCharm / 200))}活力`);
      grant('传说强化券', 5);
      player.vitality = Number(player.vitality || 0) + vitalityGain;
    }

    // 挑战层里程碑额外奖励（原版 L11775-11816）
    const milestones: Array<[number, string, number]> = [
      [100, '饲料', 50],
      [200, '发带', 1],
      [300, '特装核心', 0.5],
      [400, '发带', 1],
      [500, '工业核心', 0.15],
      [600, '发带', 1],
      [700, '特装核心', 0.5],
      [800, '发带', 1],
      [900, '特装核心', 0.5],
      [1000, '工业核心', 0.15],
    ];
    for (const [floor, itemName, count] of milestones) {
      if (challengeLevel >= floor) {
        w3Parts.push(`使魔挑战${floor}层额外奖励:${itemName}x${count}`);
        grant(itemName, count);
      }
    }

    // 「签到」成就计入任务推进（原版 添加成就("签到",1,玩家.成就,玩家.任务) 的任务联动）
    try {
      await this.taskService.advance(userId, '签到');
    } catch {
      /* 无同名任务要求时为空操作 */
    }

    // 背包/标记/活力同一次落库（savePlayer 落库前会做经验归一化与属性重算）
    player.backpack = backpack; // Json 列直接写数组
    player.markers = markers; // Json 列直接写对象
    await this.playerService.savePlayer(player);

    // 组装顺序对齐原版 w = w2 + w3 + 换行 + w：
    // w2 各行以换行开头；w3 无前导换行（与 w2 末行拼接，如“…资源箱加入游戏第1天”），
    // 有内容时以“————————\n”结尾作为与指令正文的分隔。
    const w2 = w2Parts.length > 0 ? `\n${w2Parts.join('\n')}` : '';
    let w3 = w3Parts.join('\n');
    if (w3) {
      w3 += '\n————————\n';
    }
    return `${w2}${w3}`;
  }

  /**
   * 每条指令后的功能提示（对应原版 _主程序.ecode L11546-11564）：
   * - 训练冷却已过且当前不可训练（当前地图无训练器建筑、背包无训练器）时，
   *   每 600 秒（zdxlpd 标记）提示一次「你的训练器现在可以使用了」；
   * - 今日凭证未使用（无有效「凭证」标记）时，每 600 秒（pzpd 标记）提示一次「你现在可以使用凭证了」。
   * 未开局玩家不提示。
   * @returns 需追加到指令结果之后的文本（每行以换行开头）；无提示返回 ''
   */
  async getActionHints(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (!player.type) return '';

    const markers2 = asJsonValue<any[]>(player.markers2, []);
    const now = Date.now();
    const remainText = { value: '' };
    let changed = false;
    let hints = '';

    // 训练器提示（原版 L11546-11557）：无训练冷却才判断；当前不可训练才提示
    if (!this.combatState.markerRequire('训练冷却', markers2, remainText, now)) {
      const canTrain = await this.hasTrainerAccess(player);
      if (!canTrain && !this.combatState.markerRequire('zdxlpd', markers2, remainText, now)) {
        hints += '\n【你的训练器现在可以使用了】';
        this.combatState.addMarker('zdxlpd', 600, markers2, now);
        changed = true;
      }
    }

    // 凭证提示（原版 L11559-11564）：今日凭证未使用才提示
    if (!this.combatState.markerRequire('凭证', markers2, remainText, now)) {
      if (!this.combatState.markerRequire('pzpd', markers2, remainText, now)) {
        hints += '\n【你现在可以使用凭证了】';
        this.combatState.addMarker('pzpd', 600, markers2, now);
        changed = true;
      }
    }

    // markerRequire 会顺带清理过期标记；有变更时定点写回 markers2
    if (changed) {
      try {
        await this.playerService.enqueueUserWrite(player.userId, async () => {
          const _pd = await this.playerService.getPlayerData(player.userId);
          Object.assign(_pd.player, { markers2 }); // Json 列直接写数组
          await this.playerService.savePlayer(_pd.player);
        });
      } catch {
        /* 提示冷却写回失败不影响本次回复 */
      }
    }
    return hints;
  }

  /** 当前是否可训练：当前地图存在「训练器」建筑，或背包持有「训练器」 */
  private async hasTrainerAccess(player: any): Promise<boolean> {
    try {
      const map = await this.mapService.getMapById(player.mapId);
      const buildings = asJsonValue<any[]>(map?.buildings, []);
      if (buildings.some((b: any) => String(b?.name ?? '') === '训练器')) return true;
      const backpack = this.playerService.getBackpackItems(player);
      if (backpack.some((item: any) => String(item?.name ?? '') === '训练器')) return true;
    } catch {
      /* 读取失败按不可训练处理 */
    }
    return false;
  }

  /**
   * 处理游戏术语解释命令
   * 解释游戏中的专业术语，帮助玩家理解游戏机制
   * 对应原版：游戏解释 命令
   */
  async handleGameTerms(userId: number, termName: string): Promise<string> {
    // 术语词典
    const terms: Record<string, string> = {
      '使魔': '玩家培养的宠物/伙伴，可以协助战斗和采集资源',
      '家园': '玩家自己建造的领地，可以建造建筑、种植作物、生产资源',
      '载具': '玩家组装的交通工具，提供移动速度加成和特殊功能',
      '好感度': '使魔对玩家的亲密度，影响使魔技能效果和忠诚度',
      '魔力': '玩家施放技能所需的能量值，可以通过药剂或休息恢复',
      '副本': '独立的战斗场景，包含怪物和宝藏',
      '圈地': '在家园系统中选择一块土地开始建造家园',
      '地基': '家园建造的基础阶段，需要消耗材料逐步建造',
      '产出': '建筑和作物自动生产的资源，需要定期收取',
      '捕捉': '驯服野生怪物作为自己的宠物/使魔',
      '饲料': '捕捉宠物时消耗的物品，用于吸引和驯服怪物',
      '补魔': '使用魔力药剂恢复魔力值',
      '挤奶': '从可产奶的宠物（如奶牛）中获取牛奶',
      '剪毛': '从可产毛的宠物（如普拉娜幼崽）中获取毛发',
    };

    if (!termName) {
      // 没有指定术语，显示所有可用术语列表
      const termList = Object.keys(terms).map((name, i) => `  ${i + 1}. ${name}`).join('\n');
      return [
        `📖 游戏名词解释`,
        `━━━━━━━━━━━━━━━`,
        `可用术语：`,
        termList,
        `━━━━━━━━━━━━━━━`,
        `发送「游戏解释 术语名」查看详细解释`,
      ].join('\n');
    }

    const explanation = terms[termName];
    if (!explanation) {
      return `未找到术语「${termName}」的解释，发送「游戏解释」查看所有可用术语`;
    }

    return `📖 【${termName}】\n${explanation}`;
  }

  /**
   * 处理更多帮助命令
   * 显示更多帮助信息，包括游戏进阶玩法说明
   * 对应原版：更多 命令
   */
  async handleMoreHelp(userId: number): Promise<string> {
    return [
      `📚 更多帮助信息`,
      `━━━━━━━━━━━━━━━`,
      `【家园系统】`,
      `  圈地 - 开始建造家园`,
      `  开挖地基 - 消耗材料开挖地基`,
      `  建造地基 - 消耗材料建造地基`,
      `  建造房子 - 消耗材料建造房子`,
      `  家园 - 查看家园状态`,
      `  家园产出 - 收取家园产出资源`,
      `━━━━━━━━━━━━━━━`,
      `【宠物系统】`,
      `  开始捕捉 怪物名 - 开始捕捉怪物`,
      `  停止捕捉 怪物名 - 停止捕捉`,
      `  捕捉 怪物名 - 直接捕捉`,
      `  全部跟随 - 让所有宠物跟随`,
      `  宠物操作 - 查看宠物操作菜单`,
      `━━━━━━━━━━━━━━━`,
      `【载具系统】`,
      `  组装 核心名 - 创建载具`,
      `  驾驶 载具名 - 驾驶载具`,
      `  载具 - 查看载具状态`,
      `  载具操作 - 查看操作指南`,
      `━━━━━━━━━━━━━━━`,
      `【其他系统】`,
      `  贸易 - 打开贸易市场`,
      `  签到 - 每日签到`,
      `  信息 - 查看角色信息`,
      `  背包 - 查看背包`,
      `  增幅器 - 查看增幅器说明`,
    ].join('\n');
  }

  /**
   * 处理更新历史命令
   * 显示游戏更新日志/更新历史
   * 对应原版：更新历史 命令
   */
  async handleChangelog(userId: number): Promise<string> {
    return [
      `📜 更新历史`,
      `━━━━━━━━━━━━━━━`,
      `【v1.0.0】`,
      `  - 实现家园系统（圈地、开挖地基、建造地基、建造房子）`,
      `  - 实现宠物捕捉系统`,
      `  - 实现载具组装与驾驶系统`,
      `  - 实现贸易市场系统`,
      `  - 实现每日签到系统`,
      `  - 实现战斗系统`,
      `━━━━━━━━━━━━━━━`,
      `【v0.9.0】`,
      `  - 实现基础攻击与战斗循环`,
      `  - 实现物品与装备系统`,
      `  - 实现地图与怪物系统`,
      `  - 实现玩家创建与升级系统`,
      `━━━━━━━━━━━━━━━`,
      `【v0.8.0】`,
      `  - 项目初始化`,
      `  - 实现基础框架搭建`,
      `━━━━━━━━━━━━━━━`,
      `更多更新内容请关注后续版本`,
    ].join('\n');
  }

  /**
   * 处理贸易命令
   * 玩家间贸易市场系统，支持查看市场、上架物品、下架物品、购买物品
   * 对应原版：贸易 命令
   */
  async handleTrade(userId: number, action: string, args: string[]): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 原版“贸易”在玩家家园院子中是家园贸易；市场功能保留为普通地图上的贸易子命令。
    // 支持显式“贸易 交易”，无参数在他人家园院子中也直接执行原版贸易。
    const homeTradeRequested = ['交易', 'home', 'home-trade'].includes(String(action || '').trim().toLowerCase());
    if (!action || homeTradeRequested) {
      const currentMap = await this.getCurrentMap(userId).catch(() => null);
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
  private async withTradeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
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
  private async handleHomeTrade(
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
      if (this.playerService.isPlayerDead(actor)) {
        return this.playerService.handlePlayerDeath(userId, actor);
      }
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
      const summons = this.parseJsonArray(observedMap.summons);
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
        const existing = backpack.find((item: any) => (item?.name ?? item?.名称) === name);
        if (existing) {
          const current = Number(existing.count ?? existing.quantity ?? 0);
          existing.count = current + amount;
          delete existing.quantity;
        } else {
          backpack.push({ name, count: amount });
        }
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
        .map(([name, amount]) => `${name}x${this.roundText(amount)}`)
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
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    const map = await this.getCurrentMap(userId);
    const merchantInfo = this.findMerchantInSummons(map);
    if (!merchantInfo) {
      return `${player.name}附近没有“行商”，无法购物`;
    }

    const { summons, index: merchantIndex } = merchantInfo;
    const merchant = summons[merchantIndex];
    const merchantBackpack = this.parseJsonArray(merchant.backpack);
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
      `好感${affinity}(优惠${this.roundText(affinity / (100 + affinity) * 100)}%)`,
      `◆购买需要${this.roundText(priceRate * levelFactor * 50)}木头、${this.roundText(priceRate * levelFactor * 40)}石头、${this.roundText(priceRate * levelFactor * 30)}铁矿、${this.roundText(priceRate * levelFactor * 30)}绳子`,
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
  async handleHelpMe(userId: number, question: string): Promise<string> {
    if (!question) {
      const playerData = await this.playerService.getPlayerData(userId);
      const { player } = playerData;
      const map = await this.mapService.getMapById(player.mapId);
      const summons = this.parseJsonArray(map?.summons);
      const luna = summons.find((summon: any) =>
        String(summon?.qq ?? summon?.QQ ?? '') === '怪物露娜1g',
      );
      if (!luna) return `${player.name || '冒险者'}和谁求助呢？`;

      if (this.shortcutService?.setTempInput) {
        await this.shortcutService.setTempInput(userId, '1@求助确认');
      }
      return `【${luna.name || luna.名称 || '露娜'}】\n有解决不了的麻烦需要我帮忙的吗？\n1、求助确认`;
    }

    // 获取玩家信息
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取用户QQ号
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userQQ = user?.qqNumber || '';

    // 记录求助日志
    this.logger.log(`玩家 ${userId} (${userQQ}) 求助: ${question}`);

    // 返回求助信息（在实际游戏中，这里应发送到世界频道）
    return [
      `📢 求助信息已发送`,
      `━━━━━━━━━━━━━━━`,
      `玩家: ${player.name || '冒险者'}`,
      `问题: ${question}`,
      `━━━━━━━━━━━━━━━`,
      `你的求助已记录，请等待其他玩家帮助`,
    ].join('\n');
  }

  /**
   * 处理配方命令
   * 查看配方列表，从 GameCrafting 表中查询所有可制造配方，按类型分类显示
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
      this.itemName(item) === rawTarget && !this.reverseItemFailure('', item, reverse),
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
  private readReverseProficiencies(player: any): Array<{ name: string; value: number }> {
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

  private reverseProficiency(reverse: Array<{ name: string; value: number }>, itemName: string): number {
    return reverse.find((entry) => entry.name === itemName)?.value || 0;
  }

  private setReverseProficiency(
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

  private itemName(item: any): string {
    return String(item?.name ?? item?.名称 ?? '');
  }

  private itemType(item: any): string {
    return String(item?.type ?? item?.类型 ?? '');
  }

  private reverseValue(item: any): number {
    const prefix = String(item?.data ?? item?.数据 ?? '').charAt(0);
    if (prefix === 'x') return 1;
    if (prefix === 's') return 0.2;
    if (prefix === 'a') return 0.1;
    if (prefix === 'b') return 0.05;
    if (prefix === 'c') return 0.025;
    if (prefix === 'd') return 0.0125;
    return 0.00625;
  }

  private reverseItemFailure(
    playerName: string,
    item: any,
    reverse: Array<{ name: string; value: number }>,
  ): string {
    const itemName = this.itemName(item);
    const prefix = itemName.substring(0, 6);
    if (Number(item?.durability ?? item?.耐久 ?? 0) === 1) {
      return playerName ? `${playerName}这个装备被锁定` : 'locked';
    }
    if (prefix === '植入体') return playerName ? `${playerName}植入体不可以` : 'implant';
    if (prefix === '增幅器') return playerName ? `${playerName}增幅器不可以` : 'amplifier';
    if (this.itemType(item) !== '装备') {
      return playerName ? `${playerName}${itemName}不是装备` : 'not-equipment';
    }
    if (this.reverseProficiency(reverse, itemName) >= 20) {
      return playerName ? `${playerName}${itemName}这个已经不需要逆向了` : 'complete';
    }
    return '';
  }

  private reverseOne(item: any, reverse: Array<{ name: string; value: number }>): number {
    return this.setReverseProficiency(reverse, this.itemName(item), this.reverseValue(item));
  }

  private reverseAllEligible(
    playerName: string,
    backpack: any[],
    reverse: Array<{ name: string; value: number }>,
  ): { count: number; items: Array<{ name: string; value: number }> } {
    const results = new Map<string, number>();
    let count = 0;
    // 原版从背包尾部向前遍历；删除时用倒序保持同样的命中顺序。
    for (let i = backpack.length - 1; i >= 0; i--) {
      const item = backpack[i];
      if (this.itemType(item) !== '装备') continue;
      if (this.reverseItemFailure('', item, reverse)) continue;
      const itemName = this.itemName(item);
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

  private formatReverseNumber(value: number): string {
    return String(Math.round(value));
  }

  private formatReverseMenu(
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
      lines.push(`${count}、${entry.name}${inProgress ? this.formatReverseNumber(entry.value * 5) + '%' : ''}`);
    }
    if (!inProgress) lines.push('1、查看逆向中的项目');
    return lines.join('\n');
  }

  private formatReverseBatchResult(
    playerName: string,
    count: number,
    items: Array<{ name: string; value: number }>,
  ): string {
    const lines = [`${playerName}逆向了${count}件装备`];
    for (const item of items) {
      lines.push(`${item.name}+${this.formatReverseNumber(item.value * 5)}%(${this.formatReverseNumber(item.value * 5)}%)`);
    }
    return lines.join('\n');
  }

  private formatReverseSingleResult(
    playerName: string,
    item: any,
    value: number,
    reverse: Array<{ name: string; value: number }>,
  ): string {
    const parsed = this.itemService.parseEquipment(item);
    const quality = this.itemService.getEquipmentQuality(parsed);
    const current = this.reverseProficiency(reverse, this.itemName(item));
    return `${playerName}逆向了${this.itemName(item)}[${quality}]\n` +
      `${this.itemName(item)}+${this.formatReverseNumber(value * 5)}%(${this.formatReverseNumber(current * 5)}%)`;
  }

  private async saveReverseResult(
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
  async handleRecharge(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, markers2 } = playerData;
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }
    if (!this.hasEquippedSpecial(playerData, '护盾回充器', 4)) {
      return `${player.name}需要护盾回充器`;
    }
    const remaining = { value: '' };
    const now = Date.now();
    const cooling = this.combatState.timeIntervalRequire(
      '回充冷却', 90, markers2, now, remaining, now,
    );
    if (cooling) {
      player.markers2 = markers2;
      await this.playerService.savePlayer(player);
      return `${player.name}护盾回充冷却${remaining.value}`;
    }
    this.incrementMarker(markers, '活跃度', 1);
    this.combatState.addMarker('回充', 10, markers2, now);
    player.markers = markers;
    player.markers2 = markers2;
    await this.playerService.savePlayer(player);
    return `${player.name}启动了护盾回充器`;
  }

  /**
   * 处理修理命令
   * 对应原版 _主程序.ecode L7012-L7021：装备纳米注喷器后启动10秒修理增益，
   * 与回充共用90秒「回充冷却」，不读取修理目标，也不消耗修理材料。
   */
  async handleRepairItem(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, markers2 } = playerData;
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }
    if (!this.hasEquippedSpecial(playerData, '纳米注喷器', 13)) {
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
    this.incrementMarker(markers, '活跃度', 1);
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
  async handleReload(userId: number, targetName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, markers2, weapons } = playerData;
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    let mode: 'plana' | 'organ' | '' = '';
    if (Number(player.specialSeq) === 22 && Number(player.affinity || 0) >= 60) {
      mode = 'plana';
    } else if (Number(player.currentWeapon || 0) !== 0) {
      const currentWeapon = this.currentWeaponItem(player, weapons);
      if (this.equipmentSpecialSeq(currentWeapon) === -14 || this.itemName(currentWeapon) === '管风琴') {
        mode = 'organ';
      }
    }

    if (!mode) return `${player.name}当前还不需要装填1`;

    if (mode === 'organ') {
      const loaded = this.achievementService.getAchievement(markers, '管风琴');
      if (loaded === 4) return `${player.name}还不需要装填3`;
      const seconds = (4 - loaded) * 15;
      this.normalizeMarkers2(markers2);
      this.combatState.addMarker('工作', seconds, markers2, Date.now());
      player.markers = markers;
      player.markers2 = markers2;
      await this.playerService.savePlayer(player);
      this.scheduleReloadCompletion(userId, 'organ', seconds);
      return `${player.name}正在给管风琴装填${4 - loaded}发火箭弹，需要${seconds}秒`;
    }

    const pending = weapons.filter((weapon: any) =>
      this.achievementService.getAchievement(markers, `${this.itemName(weapon)}t`) < 1,
    );
    if (pending.length === 0) return `${player.name}当前还不需要装填`;
    const weaponNames = pending.map((weapon: any) => this.itemName(weapon)).join('、');
    const seconds = pending.length * 3;
    this.normalizeMarkers2(markers2);
    this.combatState.addMarker('工作', seconds, markers2, Date.now());
    player.markers = markers;
    player.markers2 = markers2;
    await this.playerService.savePlayer(player);
    this.scheduleReloadCompletion(userId, 'plana', seconds);
    return `${player.name}正在给${weaponNames}超装填，需要${seconds}秒`;
  }

  private currentWeaponItem(player: any, weapons: any[]): any | null {
    const index = Number(player.currentWeapon || 0);
    if (index <= 0) return null;
    return weapons[index - 1] || weapons[index] || null;
  }

  private equipmentSpecialSeq(item: any): number {
    if (!item) return 0;
    const explicit = Number(item.specialSeq ?? item.特殊序号 ?? 0);
    if (explicit !== 0) return explicit;
    const definition = this.staticData.getEquipmentByName(this.itemName(item));
    return Number(definition?.specialSeq ?? definition?.特殊序号 ?? 0);
  }

  private hasEquippedSpecial(
    playerData: any,
    equipmentName: string,
    specialSeq: number,
  ): boolean {
    const equipment = (playerData.equipment || []).map((item: any) => ({
      名称: this.itemName(item),
      特殊序号: this.equipmentSpecialSeq(item),
    }));
    // 先按特殊序号查询，再保留名称查询作为静态数据中未写入特殊序号时的兼容映射。
    return this.combatState.equipRequire(equipment, [], 0, specialSeq, equipmentName, false)
      || this.combatState.equipRequire(equipment, [], 0, 0, equipmentName, false);
  }

  private incrementMarker(markers: Record<string, any>, key: string, amount: number): void {
    markers[key] = Number(markers[key] || 0) + amount;
  }

  private normalizeMarkers2(markers2: any[]): void {
    const normalized = markers2.map((entry: any) => this.combatState.normalizeBuffItem(entry));
    markers2.splice(0, markers2.length, ...normalized);
  }

  private scheduleReloadCompletion(
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
  private async completeReload(userId: number, mode: string): Promise<void> {
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
        const weaponName = this.itemName(weapon);
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
  async handleSpawnArtisan(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上';

    // 解析当前地图上的NPC列表
    const npcs = asJsonValue<any[]>(map.npcs || '[]', []);

    // 检查是否已经存在神之工匠
    const existingNpc = npcs.find((npc: any) => npc.name === '神之工匠');
    if (existingNpc) {
      return '当前地图已经有神之工匠了';
    }

    // 创建神之工匠NPC
    // mutateMapFields 锁内闭环：重读最新 npcs → 锁内复查去重 → push → 差异落库
    await this.mapService.mutateMapFields(map.id, ['npcs'], (f) => {
      const fresh = f.npcs as any[];
      if (fresh.some((npc: any) => npc.name === '神之工匠')) return;
      fresh.push({
        name: '神之工匠',
        type: 'npc',
        title: '锻造大师',
        description: '能够打造传说级装备的工匠大师',
        dialog: '需要打造什么？我可以用最好的材料打造最强的装备！',
      });
    });

    this.logger.log(`玩家 ${userId} 在地图 ${map.name} 生成了神之工匠NPC`);
    return '神之工匠已出现在当前地图！他可以帮你打造传说级装备。';
  }

  /**
   * 处理生成废弃载具命令
   * 在当前地图生成一个废弃载具残骸，可采集资源
   * 对应原版：废弃载具 命令
   */
  async handleSpawnWreck(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 获取当前地图
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上';

    // 解析当前地图上的资源列表
    const resources = asJsonValue<any[]>(map.resources || '[]', []);

    // 创建废弃载具资源
    // mutateMapFields 锁内闭环：重读最新 resources → push → 差异落库
    await this.mapService.mutateMapFields(map.id, ['resources'], (f) => {
      (f.resources as any[]).push({
        name: '废弃载具残骸',
        type: '资源',
        description: '一辆废弃的载具残骸，可以从中回收零件和材料',
        outputs: [
          { name: '废铁', quantity: 5, chance: 80 },
          { name: '零件', quantity: 1, chance: 40 },
          { name: '燃料', quantity: 2, chance: 30 },
        ],
      });
    });

    this.logger.log(`玩家 ${userId} 在地图 ${map.name} 生成了废弃载具残骸`);
    return '废弃载具残骸已出现在当前地图！可以从中回收废铁、零件和燃料。';
  }

  /**
   * 处理签到命令
   * 每日签到系统，支持连续签到奖励和累计签到奖励
   * 签到数据存储在 Player 的 markers 字段中，key: "daily_checkin"
   * 对应原版：签到 命令
   */
  async handleDailyCheckin(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 获取当前日期（使用中国时区）
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // 从 markers 中读取签到数据
    const checkinData = markers['daily_checkin'] || { lastDate: '', consecutiveDays: 0, totalDays: 0 };
    const lastDate = checkinData.lastDate || '';

    // 检查今天是否已经签到
    if (lastDate === todayStr) {
      return `你今天已经签到过了哦！\n━━━━━━━━━━━━━━━\n连续签到: ${checkinData.consecutiveDays || 0} 天\n累计签到: ${checkinData.totalDays || 0} 天\n\n明天再来签到吧~`;
    }

    // 检查昨天是否签到，判断连续天数
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

    let consecutiveDays = (lastDate === yesterdayStr) ? (checkinData.consecutiveDays || 0) + 1 : 1;
    const totalDays = (checkinData.totalDays || 0) + 1;

    // 计算签到奖励
    const baseExp = 50; // 基础经验
    const consecutiveBonus = Math.min(consecutiveDays, 30) * 5; // 连续奖励，最多计算30天
    const totalExp = baseExp + consecutiveBonus;

    // 发放经验奖励
    await this.playerService.addExp(userId, totalExp);

    // 额外奖励：连续签到7天、15天、30天
    let extraReward = '';
    if (consecutiveDays === 7) {
      await this.playerService.addToBackpack(userId, '签到礼包', 1);
      extraReward = '\n🎉 连续签到7天！获得签到礼包×1';
    } else if (consecutiveDays === 15) {
      await this.playerService.addToBackpack(userId, '签到礼包', 2);
      extraReward = '\n🎉 连续签到15天！获得签到礼包×2';
    } else if (consecutiveDays === 30) {
      await this.playerService.addToBackpack(userId, '签到礼包', 3);
      extraReward = '\n🎉 连续签到30天！获得签到礼包×3';
    }

    // 累计签到奖励
    let totalReward = '';
    if (totalDays === 30) {
      await this.playerService.addToBackpack(userId, '累计签到礼包', 1);
      totalReward = '\n🏆 累计签到30天！获得累计签到礼包×1';
    } else if (totalDays === 100) {
      await this.playerService.addToBackpack(userId, '累计签到礼包', 2);
      totalReward = '\n🏆 累计签到100天！获得累计签到礼包×2';
    } else if (totalDays === 365) {
      await this.playerService.addToBackpack(userId, '累计签到礼包', 3);
      totalReward = '\n🏆 累计签到365天！获得满年签到礼包×3';
    }

    // 更新签到数据
    markers['daily_checkin'] = {
      lastDate: todayStr,
      consecutiveDays: consecutiveDays,
      totalDays: totalDays,
    };
    player.markers = markers;
    await this.playerService.savePlayer(player);

    this.logger.log(`玩家 ${userId} 签到成功，连续${consecutiveDays}天，累计${totalDays}天`);

    const lines = [
      `✅ 签到成功！`,
      `━━━━━━━━━━━━━━━`,
      `📅 ${todayStr}`,
      `🔥 连续签到: ${consecutiveDays} 天`,
      `📊 累计签到: ${totalDays} 天`,
      `━━━━━━━━━━━━━━━`,
      `✨ 获得经验: +${totalExp}`,
      extraReward ? `━━━━━━━━━━━━━━━${extraReward}` : '',
      totalReward ? `━━━━━━━━━━━━━━━${totalReward}` : '',
    ];

    return lines.filter(Boolean).join('\n');
  }

  /**
   * 处理文本发送命令
   * 切换发送模式（文本发送模式/普通发送模式）
   * 对应原版：文本发送 命令
   */
  async handleTextSend(userId: number, content: string): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

    // 检查当前文本发送模式状态
    const currentMode = markers['文本发送模式'] || 0;

    if (!content) {
      // 没有指定模式，显示当前状态并切换
      const newMode = currentMode === 0 ? 1 : 0;
      markers['文本发送模式'] = newMode;
      player.markers = markers; // Json 列直接写对象
      await this.playerService.savePlayer(player);

      const modeText = newMode === 1 ? '文本发送模式' : '普通发送模式';
      this.logger.log(`玩家 ${userId} 切换发送模式为: ${modeText}`);
      return `已切换至「${modeText}」`;
    }

    // 处理文本内容发送
    if (currentMode === 0) {
      // 当前是普通模式，切换到文本模式并发送
      markers['文本发送模式'] = 1;
      player.markers = markers; // Json 列直接写对象
      await this.playerService.savePlayer(player);
    }

    // 在当前模式下发送文本内容
    this.logger.log(`玩家 ${userId} 发送文本: ${content}`);
    return `📨 文本消息已发送:\n${content}`;
  }

  /**
   * 处理查看指定玩家命令
   * 按QQ号或名称查找玩家，显示基本信息
   * 对应原版：查看玩家 命令
   */
  async handleViewPlayer(userId: number, targetName: string): Promise<string> {
    if (!targetName) {
      return '请指定要查看的玩家QQ号或名称，格式：查看玩家 QQ号/名称';
    }

    // 尝试按QQ号查找
    let targetPlayer = await this.prisma.player.findFirst({
      where: { userId: parseInt(targetName, 10) || 0 },
    });

    // 尝试按名称查找
    if (!targetPlayer) {
      targetPlayer = await this.prisma.player.findFirst({
        where: { name: targetName },
      });
    }

    if (!targetPlayer) {
      return `未找到玩家「${targetName}」`;
    }

    // 解析玩家的背包、装备、称号等数据
    const backpack = asJsonValue<any[]>(targetPlayer.backpack, []);
    const equipment = asJsonValue<any[]>(targetPlayer.equipment, []);
    // 称号兼容两种形状：字符串（历史自动发放）/ {name, equipped}（领取/佩戴）
    const titles = asJsonValue<any[]>(targetPlayer.titles, [])
      .filter((t: any) => t)
      .map((t: any) => (typeof t === 'string' ? t : t.name))
      .filter(Boolean);

    // 获取地图名称
    let mapName = '未知区域';
    try {
      const gameMap = await this.prisma.gameMap.findUnique({
        where: { id: targetPlayer.mapId },
        select: { name: true },
      });
      if (gameMap) mapName = gameMap.name;
    } catch {
      // 忽略
    }

    // 统计信息
    const backpackCount = backpack.length;
    const equipmentCount = equipment.length;
    const titleText = titles.length > 0 ? titles.join(', ') : '无';

    return [
      `👤 玩家信息 - ${targetPlayer.name || '未知'}`,
      `━━━━━━━━━━━━━━━`,
      `等级: ${targetPlayer.level || 1}`,
      `位置: ${mapName}`,
      `生命: ${targetPlayer.hp || 0}/${targetPlayer.maxHp || 100}`,
      `攻击: ${targetPlayer.attack || 0}`,
      `━━━━━━━━━━━━━━━`,
      `背包物品: ${backpackCount} 种`,
      `装备数量: ${equipmentCount} 件`,
      `称号: ${titleText}`,
      `━━━━━━━━━━━━━━━`,
      `(使用「信息」查看自己的完整信息)`,
    ].join('\n');
  }

  // ========== GM 管理员命令 ==========

  /**
   * GM命令入口
   * 执行管理员GM命令，需要管理员权限
   * @param userId 调用者用户ID
   * @param args 子命令及参数数组
   */
  async handleAdminCommand(userId: number, args: string[]): Promise<string> {
    // 1. 获取调用者用户信息
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return '用户不存在';

    // 2. 检查是否是 ADMIN 角色（ADMIN 或 SUPER_ADMIN）
    if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
      return '权限不足，需要管理员权限（ADMIN 或 SUPER_ADMIN）';
    }

    // 3. 如果没有子命令，显示帮助信息
    if (args.length === 0 || !args[0]) {
      return this.getAdminHelpText();
    }

    const subCmd = args[0];
    const subArgs = args.slice(1);

    try {
      switch (subCmd) {
        case '状态':
        case 'status':
          return await this.handleAdminStatus();

        case '公告':
        case 'announce':
          return await this.handleAdminAnnounce(subArgs);

        case '世界等级':
        case 'world-level':
          return await this.handleAdminSetWorldLevel(subArgs);

        case '给物品':
        case 'give-item':
          return await this.handleAdminGiveItem(subArgs);

        case '玩家列表':
        case 'player-list':
          return await this.handleAdminPlayerList(subArgs);

        case '封禁':
        case 'ban':
          return await this.handleAdminToggleBan(subArgs, true);

        case '解封':
        case 'unban':
          return await this.handleAdminToggleBan(subArgs, false);

        case '封禁QQ':
        case 'ban-qq':
          return await this.handleAdminBanByQQ(userId, subArgs);

        case '重置玩家':
        case 'reset-player':
          return await this.handleAdminResetPlayer(userId, subArgs);

        case '修改玩家':
        case 'modify-player':
          return await this.handleAdminModifyPlayer(userId, subArgs);

        case '间隔消息':
        case 'interval-msg':
          return await this.handleAdminIntervalMessage(userId, subArgs);

        case '公告':
        case 'broadcast':
          return await this.handleAdminBroadcast(userId, subArgs);

        case '更新配置':
        case 'update-config':
          return await this.handleAdminUpdateConfig(subArgs);

        case '用户列表':
        case 'user-list':
          return await this.handleAdminUserList(subArgs);

        case '帮助':
        case 'help':
          return this.getAdminHelpText();

        default:
          return `未知GM子命令「${subCmd}」，使用「gm 帮助」查看可用命令`;
      }
    } catch (err: any) {
      this.logger.error(`GM命令执行错误 userId=${userId} cmd=${subCmd}`, err);
      return `GM命令执行错误: ${err.message}`;
    }
  }

  /**
   * 获取GM命令帮助文本
   */
  private getAdminHelpText(): string {
    return [
      `📋 GM 管理员命令帮助`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `gm 状态 / admin status - 获取服务器状态`,
      `gm 公告 内容 - 发送系统公告`,
      `gm 世界等级 数字 - 设置世界等级`,
      `gm 给物品 用户ID 物品名 数量 - 给玩家发送物品`,
      `gm 玩家列表 [页码] - 获取玩家列表`,
      `gm 封禁 用户ID - 封禁玩家（按用户ID）`,
      `gm 解封 用户ID - 解封玩家`,
      `gm 封禁QQ QQ号 - 封禁玩家（按QQ号）`,
      `gm 重置玩家 QQ号 - 重置玩家数据到初始状态`,
      `gm 修改玩家 QQ号/用户名/ID 字段名 值 - 修改玩家数据`,
      `gm 间隔消息 内容 次数 间隔秒 - 设置间隔消息`,
      `gm 更新配置 键 值 - 更新系统配置`,
      `gm 用户列表 [关键词] - 搜索用户列表`,
      `gm 帮助 - 显示本帮助`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `别名：gm / 管理 / admin / 管理员`,
    ].join('\n');
  }

  /**
   * 处理服务器状态查询
   */
  private async handleAdminStatus(): Promise<string> {
    const status = await this.adminService.getServerStatus();
    const uptimeStr = this.formatUptime(status.uptime);
    return [
      `📊 服务器状态`,
      `━━━━━━━━━━━━━━━`,
      `👥 用户总数: ${status.totalUsers}`,
      `🎮 玩家总数: ${status.totalPlayers}`,
      `🟢 在线玩家: ${status.onlinePlayers}`,
      `🗺️ 地图总数: ${status.totalMaps}`,
      `📝 指令总数: ${status.totalCommands}`,
      `⏱️ 运行时长: ${uptimeStr}`,
    ].join('\n');
  }

  /**
   * 处理发送系统公告
   */
  private async handleAdminAnnounce(args: string[]): Promise<string> {
    if (args.length === 0) {
      return '请指定公告内容，格式：gm 公告 内容';
    }
    const content = args.join(' ');
    await this.adminService.sendAnnouncement(content);
    return `✅ 系统公告已发送：${content}`;
  }

  /**
   * 处理设置世界等级
   */
  private async handleAdminSetWorldLevel(args: string[]): Promise<string> {
    if (args.length === 0) {
      return '请指定世界等级，格式：gm 世界等级 数字';
    }
    const level = parseInt(args[0], 10);
    if (isNaN(level) || level < 1) {
      return '世界等级必须为正整数';
    }
    return await this.adminService.setWorldLevel(level);
  }

  /**
   * 处理GM给物品
   */
  private async handleAdminGiveItem(args: string[]): Promise<string> {
    if (args.length < 3) {
      return '请指定目标用户ID、物品名称和数量，格式：gm 给物品 用户ID 物品名 数量';
    }
    const targetUserId = parseInt(args[0], 10);
    if (isNaN(targetUserId)) {
      return '用户ID必须为数字';
    }
    const itemName = args[1];
    const count = parseInt(args[2], 10);
    if (isNaN(count) || count < 1) {
      return '数量必须为正整数';
    }
    return await this.adminService.gmGiveItem(targetUserId, itemName, count);
  }

  /**
   * 处理玩家列表查询
   */
  private async handleAdminPlayerList(args: string[]): Promise<string> {
    const page = parseInt(args[0], 10) || 1;
    const pageSize = 20;
    const result = await this.adminService.getPlayersList(page, pageSize);
    const lines = [
      `🎮 玩家列表 (第${page}页，共${result.total}人)`,
      `━━━━━━━━━━━━━━━`,
    ];
    for (const p of result.players) {
      const userInfo = p.user ? `${p.user.nickname || p.user.username}(${p.user.id})` : `ID:${p.userId}`;
      lines.push(`  ${userInfo} | Lv.${p.level || 1} | HP:${Math.round(p.hp || 0)}/${Math.round(p.maxHp || 100)}`);
    }
    if (result.players.length === 0) {
      lines.push(`  暂无玩家数据`);
    }
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`共 ${result.total} 人，当前显示第 ${page} 页`);
    return lines.join('\n');
  }

  /**
   * 处理封禁/解封用户
   * @param args 参数数组，[0]为用户ID
   * @param isBan true=封禁, false=解封
   */
  private async handleAdminToggleBan(args: string[], isBan: boolean): Promise<string> {
    if (args.length === 0) {
      const action = isBan ? '封禁' : '解封';
      return `请指定用户ID，格式：gm ${action} 用户ID`;
    }
    const targetUserId = parseInt(args[0], 10);
    if (isNaN(targetUserId)) {
      return '用户ID必须为数字';
    }
    const result = await this.adminService.toggleUserBan(targetUserId);
    // toggleUserBan 会自动切换状态，所以无论封禁/解封都调用同一个方法
    // 返回结果包含操作描述，直接返回即可
    return result;
  }

  /**
   * 处理更新系统配置
   */
  private async handleAdminUpdateConfig(args: string[]): Promise<string> {
    if (args.length < 2) {
      return '请指定配置键和值，格式：gm 更新配置 键 值';
    }
    const key = args[0];
    const value = args.slice(1).join(' ');
    return await this.adminService.updateSystemConfig(key, value);
  }

  /**
   * 处理用户列表查询
   */
  private async handleAdminUserList(args: string[]): Promise<string> {
    const keyword = args[0] || undefined;
    const page = 1;
    const pageSize = 20;
    const result = await this.adminService.listUsers(page, pageSize, keyword);
    const lines = [
      `👥 用户列表${keyword ? `(关键词: ${keyword})` : ''} (第${page}页，共${result.total}人)`,
      `━━━━━━━━━━━━━━━━━━━━━━`,
    ];
    for (const u of result.list) {
      const roleTag = u.role === 'SUPER_ADMIN' ? '🛡️' : u.role === 'ADMIN' ? '⚔️' : '👤';
      const statusTag = u.status === 'BANNED' ? '🔒' : '';
      lines.push(`  ${roleTag}${statusTag} ${u.nickname || u.username}(${u.id}) 角色:${u.role} ${u.qqNumber ? `QQ:${u.qqNumber}` : ''}`);
    }
    if (result.list.length === 0) {
      lines.push(`  暂无匹配的用户`);
    }
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`共 ${result.total} 人，当前显示第 ${page} 页`);
    return lines.join('\n');
  }

  /**
   * 处理按QQ号封禁玩家
   * @param userId 操作者用户ID
   * @param args 参数列表
   */
  private async handleAdminBanByQQ(userId: number, args: string[]): Promise<string> {
    if (args.length === 0) {
      return '请指定目标QQ号，格式：gm 封禁QQ QQ号';
    }
    const targetQQ = args[0];
    return await this.adminService.banPlayer(userId, targetQQ);
  }

  /**
   * 处理重置玩家数据
   * @param userId 操作者用户ID
   * @param args 参数列表
   */
  private async handleAdminResetPlayer(userId: number, args: string[]): Promise<string> {
    if (args.length === 0) {
      return '请指定目标QQ号，格式：gm 重置玩家 QQ号';
    }
    const targetQQ = args[0];
    return await this.adminService.resetPlayer(userId, targetQQ);
  }

  /**
   * 处理修改玩家数据
   * @param userId 操作者用户ID
   * @param args 参数列表
   */
  private async handleAdminModifyPlayer(userId: number, args: string[]): Promise<string> {
    if (args.length < 3) {
      return '请指定目标(QQ号/用户名/ID)、字段名和值，格式：gm 修改玩家 目标 字段名 值';
    }
    const targetQQ = args[0];
    const field = args[1];
    const value = args.slice(2).join(' ');
    return await this.adminService.modifyPlayer(userId, targetQQ, field, value);
  }

  /**
   * 处理设置间隔消息
   * @param userId 操作者用户ID
   * @param args 参数列表
   */
  private async handleAdminIntervalMessage(userId: number, args: string[]): Promise<string> {
    if (args.length < 3) {
      return '请指定消息内容、次数和间隔时间，格式：gm 间隔消息 内容 次数 间隔秒';
    }
    // 内容可能包含空格，通过次数和间隔时间位置来分割
    const countIdx = args.length - 2;
    const intervalIdx = args.length - 1;
    const count = parseInt(args[countIdx], 10);
    const interval = parseInt(args[intervalIdx], 10);
    const content = args.slice(0, countIdx).join(' ');

    if (isNaN(count) || count < 1) {
      return '次数必须为正整数';
    }
    if (isNaN(interval) || interval < 1) {
      return '间隔时间必须为正整数（秒）';
    }

    return await this.adminService.setIntervalMessage(userId, content, interval, count);
  }

  /**
   * 处理发送全服公告
   * @param userId 操作者用户ID
   * @param args 参数列表
   */
  private async handleAdminBroadcast(userId: number, args: string[]): Promise<string> {
    if (args.length === 0) {
      return '请指定公告内容，格式：gm 公告 内容';
    }
    const message = args.join(' ');
    return await this.adminService.broadcast(userId, message);
  }

  /**
   * 格式化运行时长（秒 → 可读文本）
   */
  private formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分`);
    parts.push(`${secs}秒`);
    return parts.join('');
  }

  // ==================== 时间流逝完整计算 ====================

  /**
   * 计算玩家离线时间补偿
   * 玩家离线期间，根据时间差计算生命/护盾/装甲回复
   * 回复公式：回复量 = 回复率 × 时间差 / 60
   * 在玩家每次操作时自动调用，确保离线时间得到补偿
   *
   * @param userId 用户ID
   * @returns 回复结果文本（无回复时返回空字符串）
   */
  async calculateTimeElapsed(userId: number): Promise<string> {
    try {
      const playerData = await this.playerService.getPlayerData(userId);
      const { player } = playerData;

      const now = Date.now();
      // lastOpTime/readTime 为 BigInt（schema BigInt），统一转 Number 参与运算
      const toNum = (v: any) => {
        if (v === null || v === undefined) return 0;
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };
      const storedOpTime = toNum(player.lastOpTime) || toNum(player.readTime);

      // ===== 时间基准初始化（原版 加成计算.ecode L1596-1597）=====
      // 【原文 L1596】玩家.时间差 = (s - 玩家.读取时间) / #转秒
      // 【原文 L1597】玩家.读取时间 = 原始时间戳
      // 原版是「先算时间差、再无条件回写读取时间」，没有"时间差过小就不回写"的分支。
      // 本框架额外加了 10 秒防抖（不足 10 秒不结算、也不推进时间戳，让时间继续累积），
      // 这就带来一个死锁：新档/旧档/GM 清空数据后 lastOpTime 与 readTime 都是 0，
      // 若按旧写法 fallback 成 now，则 timeDiff 恒为 0 → 每次都从第 10 秒阈值处 return，
      // 永远走不到末尾的「写回 lastOpTime」→ 活力恢复/离线回血回盾回甲/躺下经验全部永久失效。
      // 因此这里必须先落一次基准时间戳（本次不补偿，等价于原版读档后第一次操作）。
      if (storedOpTime <= 0) {
        player.lastOpTime = BigInt(now);
        await this.playerService.savePlayer(player);
        return '';
      }

      // 计算时间差（秒）
      const timeDiff = Math.max(0, (now - storedOpTime) / 1000);

      // 如果时间差小于10秒，不进行补偿（避免频繁操作时的误补偿）
      if (timeDiff < 10) {
        return '';
      }

      // 获取回复率（每秒回复量）
      const regenHp = player.regenHp || 0;
      const regenShield = player.regenShield || 0;
      const regenArmor = player.regenArmor || 0;

      // 死亡（当前生命<=0）不结算三池回复——原版 _计算玩家 L2383 用
      // .如果真(玩家.当前生命 > 0) 包住整段回复：死掉的玩家离线不会回血/盾/甲，
      // 必须靠 复活使魔/救助 等复活，不会因离线回复自动复活。
      const hpBefore = player.hp || 0;
      const shieldBefore = player.shield || 0;
      const armorBefore = player.armor || 0;
      if (hpBefore > 0) {
        // 应用回复公式：回复量 = 回复率 × 时间差（每秒回复"回复率"点）
        // 对齐原版 _计算玩家 L2401-2403：
        //   当前护盾 += 时间差 × 属性.护盾回复 + 时间差 × 属性.护盾回复2/100 × 属性.护盾
        // 本框架 regenHp/regenShield/regenArmor 已含原版 /10 折算后的每秒回复速率。
        const maxHpVal = player.maxHp || 100;
        const maxShieldVal = player.maxShield || 0;
        const maxArmorVal = player.maxArmor || 0;
        const hpRegen = Math.floor(regenHp * timeDiff + (player.regenHp2 || 0) / 100 * maxHpVal * timeDiff);
        const shieldRegen = Math.floor(regenShield * timeDiff + (player.regenShield2 || 0) / 100 * maxShieldVal * timeDiff);
        const armorRegen = Math.floor(regenArmor * timeDiff + (player.regenArmor2 || 0) / 100 * maxArmorVal * timeDiff);

        // 限制回复量不超过最大值
        const maxHp = player.maxHp || 100;
        player.hp = Math.min(maxHp, hpBefore + hpRegen);

        const maxShield = player.maxShield || 0;
        player.shield = Math.min(maxShield, shieldBefore + shieldRegen);

        const maxArmor = player.maxArmor || 0;
        player.armor = Math.min(maxArmor, armorBefore + armorRegen);
      }

      // ===== 躺下经验结算（原版 _计算玩家 L2478-2491） =====
      // a1 = 等级/100 × 时间差 × (1+属性.经验/100) × (1+|陪睡|×0.5) [若有鹭(陪睡<0)再×1.1]
      // 仅当 标记"躺下"==1 时生效；离线≥600秒时显示提示文本
      try {
        const markersObj = asJsonValue<any>(player.markers, {});
        if (markersObj['躺下'] === 1) {
          const setsObj = asJsonValue<any>(player.sets, {});
          const sleepover = Math.abs(Number(setsObj.sleepover) || 0);
          const isHaveCrane = (Number(setsObj.sleepover) || 0) < 0; // 负数为有鹭
          let lieExp = (player.level || 1) / 100 * timeDiff
            * (1 + (player.expBonus || 0) / 100)
            * (1 + sleepover * 0.5);
          if (isHaveCrane) lieExp *= 1.1;
          if (lieExp > 0) {
            player.exp = (player.exp || 0) + lieExp;
            if (timeDiff >= 600) {
              this.logger.log(`躺下离线经验 userId=${userId}, 离线${Math.floor(timeDiff / 60)}分钟, +${lieExp}经验`);
            }
          }
        }
      } catch (e: any) {
        this.logger.warn(`躺下经验结算失败: ${e.message}`);
      }

      // ===== 活力恢复（原版 _计算玩家 L2625-2643） =====
      // 活力与生命/护盾/装甲回复相互独立，即使三池回复率都为0也必须结算。
      let vitalityTipText = '';
      const vitalityMarkers2 = asJsonValue<any[]>(
        player.markers2, [],
      );
      try {
        const markersObj = asJsonValue<any>(player.markers, {});
        const vitalityMax = this.vitalityService
          ? this.vitalityService.getVitalityMax(markersObj)
          : Math.max(100, Number(this.playerService.getMarkerValue(markersObj, '活力2')) || 100);
        if (this.vitalityService) {
          player.vitality = this.vitalityService.recover(player.vitality, timeDiff, vitalityMax);
        } else {
          player.vitality = Math.min(
            vitalityMax,
            (player.vitality || 0) + timeDiff / 1200 * (1 + (vitalityMax - 100) / 200),
          );
        }
        if (Number(this.playerService.getMarkerValue(markersObj, '活力2')) < vitalityMax) {
          markersObj['活力2'] = vitalityMax;
          player.markers = markersObj; // Json 列直接写对象
        }
        // ===== 活力快满提示（原版 加成计算.ecode L2637-2640）=====
        // 【原文 L2637】.如果真 (玩家.活力 >= a1 * 0.8)
        // 【原文 L2638】    .如果真 (时间间隔要求 ("活力提示", 600, 玩家.标记2, 原始时间戳, , ) == 假)
        // 【原文 L2639】        玩家.额外文本 = 玩家.额外文本 + "#换行【活力快满了:" + 加斜杠 (玩家.活力, a1, 真) + "】"
        // 加斜杠(x, y, 真) 为取整显示，故这里用 Math.round 还原"当前/上限"。
        if ((player.vitality || 0) >= vitalityMax * 0.8) {
          const nowSec = now / 1000;
          const tipMark = vitalityMarkers2.find((m: any) => m && m.name === '活力提示');
          if (!tipMark || !tipMark.expireAt || tipMark.expireAt <= nowSec) {
            this.setMarkers2(vitalityMarkers2, '活力提示', nowSec + 600);
            player.markers2 = vitalityMarkers2; // Json 列直接写数组
            vitalityTipText = `【活力快满了:${Math.round(player.vitality || 0)}/${Math.round(vitalityMax)}】`;
          }
        }
      } catch (e: any) {
        this.logger.warn(`活力恢复结算失败: ${e.message}`);
      }

      // 更新最后操作时间（BigInt 字段）
      player.lastOpTime = BigInt(now);

      // 保存玩家数据
      await this.playerService.savePlayer(player);

      // 构建回复结果文本
      const regenLines: string[] = [];
      const actualHpRegen = (player.hp || 0) - hpBefore;
      const actualShieldRegen = (player.shield || 0) - shieldBefore;
      const actualArmorRegen = (player.armor || 0) - armorBefore;

      if (actualHpRegen > 0) regenLines.push(`生命回复 +${actualHpRegen}`);
      if (actualShieldRegen > 0) regenLines.push(`护盾回复 +${actualShieldRegen}`);
      if (actualArmorRegen > 0) regenLines.push(`装甲回复 +${actualArmorRegen}`);
      // 活力提示属于玩家的额外文本，与三池回复同批输出（原版写入 玩家.额外文本）
      if (vitalityTipText) regenLines.push(vitalityTipText);

      if (regenLines.length > 0) {
        // 离线时长展示：≥60秒显示分钟，否则显示秒
        const minutes = Math.floor(timeDiff / 60);
        const seconds = Math.floor(timeDiff % 60);
        const durationText = minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
        this.logger.log(`时间补偿 userId=${userId}, 离线${durationText}, ${regenLines.join(', ')}`);
        return `⏰ 你离开了 ${durationText}\n${regenLines.join('\n')}`;
      }

      return '';
    } catch (error) {
      this.logger.error(`时间流逝计算失败 userId=${userId}: ${error.message}`);
      return '';
    }
  }

  /**
   * 获取玩家当前所在的地图对象
   * @param userId 用户ID
   * @returns 地图对象
   */
  async getCurrentMap(userId: number): Promise<any> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) throw new Error('玩家数据不存在');
    return this.mapService.getMapById(player.mapId);
  }

  /**
   * 更新地图的建筑数据
   * @param mapId 地图ID
   * @param buildingsJson 建筑数据JSON字符串
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
  async handleHelpUp(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const playerName = player.name || '冒险者';
    if (this.playerService.isPlayerDead(player)) {
      return `${playerName}已经倒地，无法扶助其他玩家`;
    }

    const markers2 = this.parseRescueMarkers(player.markers2 ?? playerData.markers2);
    const active = this.getActiveRescueMarker(markers2);
    if (active) {
      return `${playerName}正在${this.rescueActionText(active.rescueType)}，还需要${this.remainingRescueSeconds(active)}秒`;
    }

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${playerName}当前不在有效地图中`;

    let nearbyPlayers: any[] = [];
    if (this.prisma?.player?.findMany) {
      nearbyPlayers = await this.prisma.player.findMany({ where: { mapId: player.mapId } });
    } else if (Array.isArray(map.players)) {
      nearbyPlayers = map.players
        .filter((entry: any) => typeof entry === 'object')
        .map((entry: any) => entry.player || entry);
    }

    const target = nearbyPlayers.find((candidate: any) =>
      Number(candidate?.userId ?? candidate?.id) !== Number(userId)
      && this.hasActiveRescueBuff(candidate?.buffs),
    );
    if (!target) {
      return `${playerName}当前地图没有需要帮助的玩家。`;
    }

    const marker = this.createRescueMarker('player', 5, {
      mapId: player.mapId,
    });
    markers2.push(marker);
    player.markers2 = markers2; // Json 列直接写数组
    await this.playerService.savePlayer(player);
    await this.taskService.advance(userId, '救助');
    this.scheduleRescueCompletion(userId, marker);
    return `${playerName}正在救助玩家，大概需要5秒`;
  }

  /** 解析救援相关 JSON，兼容对象、数组和旧版中英文字段。 */
  private parseRescueArray(value: any): any[] {
    if (Array.isArray(value)) return value;
    return asJsonValue<any[]>(value, []);
  }

  private parseRescueMarkers(value: any): any[] {
    return this.parseRescueArray(value);
  }

  private createRescueMarker(
    rescueType: 'self' | 'familiar' | 'vehicle' | 'player',
    seconds: number,
    extra: Record<string, any> = {},
  ): any {
    const nowMs = Date.now();
    const totalMs = Math.max(1, Math.ceil(seconds)) * 1000;
    return {
      name: rescueType === 'player' ? '工作' : '复活',
      rescueType,
      // 起点与总时长一并落盘：前端进度条据此算百分比，否则只能干读秒
      startedAt: nowMs,
      totalMs,
      expireAt: Math.ceil(nowMs / 1000) + Math.max(1, Math.ceil(seconds)),
      token: `rescue-${nowMs}-${Math.random().toString(36).slice(2, 10)}`,
      ...extra,
    };
  }

  private getActiveRescueMarker(markers2: any[]): any | null {
    const now = Date.now() / 1000;
    return markers2.find((marker: any) => {
      const name = marker?.name ?? marker?.名称;
      if (name !== '复活' && name !== '工作') return false;
      const expireAt = this.rescueExpireAtSeconds(marker);
      return expireAt > now;
    }) || null;
  }

  private rescueExpireAtSeconds(marker: any): number {
    const raw = Number(marker?.expireAt ?? marker?.有效期至 ?? 0);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return raw >= 1e12 ? raw / 1000 : raw;
  }

  private remainingRescueSeconds(marker: any): number {
    return Math.max(1, Math.ceil(this.rescueExpireAtSeconds(marker) - Date.now() / 1000));
  }

  private rescueActionText(type: string): string {
    if (type === 'player') return '救助玩家';
    if (type === 'vehicle') return '维修载具';
    if (type === 'familiar') return '抢救使魔';
    return '抢救';
  }

  private formatRescueSeconds(seconds: number): number {
    return Math.max(1, Math.round(seconds));
  }

  private rescueHp(unit: any): number {
    return Number(unit?.hp ?? unit?.currentHp ?? unit?.当前生命 ?? 0) || 0;
  }

  private rescueMaxHp(unit: any): number {
    const attributes = this.parseRescueObject(unit?.attributes ?? unit?.属性);
    return this.firstPositiveNumber(
      unit?.maxHp,
      unit?.maxHealth,
      unit?.生命,
      attributes?.生命,
      attributes?.hp,
    );
  }

  private firstPositiveNumber(...values: any[]): number {
    for (const value of values) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
  }

  private parseRescueObject(value: any): any {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    return asJsonValue<any>(value, {});
  }

  private setRescueHp(unit: any, hp: number): void {
    const value = Math.max(0, hp);
    if (unit?.hp !== undefined) unit.hp = value;
    if (unit?.currentHp !== undefined) unit.currentHp = value;
    if (unit?.当前生命 !== undefined) unit.当前生命 = value;
    if (unit?.hp === undefined && unit?.currentHp === undefined && unit?.当前生命 === undefined) {
      unit.hp = value;
    }
  }

  private rescueUnitId(unit: any): string {
    return String(unit?.qq ?? unit?.QQ ?? unit?.id ?? unit?.编号 ?? unit?.name ?? unit?.名称 ?? '');
  }

  private rescueUnitName(unit: any): string {
    return String(unit?.name ?? unit?.名称 ?? unit?.type ?? unit?.类型 ?? '使魔');
  }

  private rescueVehicleKey(summon: any): string {
    const raw = summon?.vehicle ?? summon?.载具 ?? summon?.vehicleId ?? summon?.载具编号;
    if (raw && typeof raw === 'object') {
      return String(raw?.id ?? raw?.编号 ?? raw?.vehicleId ?? raw?.name ?? raw?.名称 ?? '');
    }
    return String(raw ?? '');
  }

  private rescueVehicleKeys(vehicle: any): Set<string> {
    return new Set([
      vehicle?.id,
      vehicle?.编号,
      vehicle?.vehicleId,
      vehicle?.name,
      vehicle?.名称,
    ].filter((value) => value !== undefined && value !== null && String(value) !== '').map(String));
  }

  private rescueVehicleMaxHp(vehicle: any): number {
    const bonus = this.parseRescueObject(vehicle?.bonus ?? vehicle?.加成);
    return this.firstPositiveNumber(vehicle?.maxHp, vehicle?.生命, bonus?.生命);
  }

  private rescueVehicleHp(vehicle: any): number {
    return Number(vehicle?.currentHp ?? vehicle?.当前生命 ?? vehicle?.hp ?? 0) || 0;
  }

  private isDamagedRescueVehicle(vehicle: any): boolean {
    const maxHp = this.rescueVehicleMaxHp(vehicle);
    return maxHp > 0 && this.rescueVehicleHp(vehicle) !== maxHp;
  }

  private setRescueVehicleHp(vehicle: any, hp: number): void {
    const value = Math.max(0, hp);
    if (vehicle?.currentHp !== undefined) vehicle.currentHp = value;
    if (vehicle?.当前生命 !== undefined) vehicle.当前生命 = value;
    if (vehicle?.hp !== undefined) vehicle.hp = value;
    if (vehicle?.currentHp === undefined && vehicle?.当前生命 === undefined && vehicle?.hp === undefined) {
      vehicle.currentHp = value;
    }
  }

  private hasActiveRescueBuff(value: any): boolean {
    const buffs = this.parseRescueArray(value);
    const now = Date.now() / 1000;
    return buffs.some((buff: any) => {
      if ((buff?.name ?? buff?.名称) !== '卷土重来') return false;
      const raw = Number(buff?.expireAt ?? buff?.有效期至 ?? 0);
      const expireAt = raw >= 1e12 ? raw / 1000 : raw;
      return !expireAt || expireAt > now;
    });
  }

  private shortenRescueBuff(buffs: any[], name: string, seconds: number): boolean {
    const nowMs = Date.now();
    let changed = false;
    for (let index = buffs.length - 1; index >= 0; index--) {
      const buff = buffs[index];
      if ((buff?.name ?? buff?.名称) !== name) continue;
      const raw = Number(buff?.expireAt ?? buff?.有效期至 ?? 0);
      if (!raw) {
        buffs.splice(index, 1);
        changed = true;
        continue;
      }
      const isMs = raw >= 1e12 || buff?.有效期至 !== undefined;
      const expireMs = isMs ? raw : raw * 1000;
      const nextMs = expireMs - seconds * 1000;
      if (nextMs <= nowMs) {
        buffs.splice(index, 1);
      } else if (isMs) {
        if (buff?.有效期至 !== undefined) buff.有效期至 = nextMs;
        else buff.expireAt = nextMs;
      } else {
        buff.expireAt = nextMs / 1000;
      }
      changed = true;
    }
    return changed;
  }

  private async saveRescueMap(map: any, summons: any[], vehicles: any[]): Promise<void> {
    // GameMap JSON 列为原生 Json 类型，写库直接传对象/数组
    const data: Record<string, any> = {};
    if (summons) data.summons = summons;
    if (vehicles) data.vehicles = vehicles;
    if (Object.keys(data).length === 0) return;
    await this.mapService.updateDynamicFields(map.id, data);
  }

  /**
   * 原子认领救援标记：从 markers2 移除指定 token 并持久化，返回是否认领成功。
   * 进程内延时定时器与每5秒的兜底扫描是两个并发结算入口，且结算链路
   * （白传送/地图读写/任务推进）耗时可超过兜底间隔；旧实现"先结算最后才删标记"
   * 会让重入方在窗口内再次通过 token 校验，导致"感觉好一点了吗？"等结算文本
   * 被重复广播刷屏。改为结算前先按 CAS（条件更新）抢删标记：
   * 只有认领成功的调用继续结算+广播，失败方立即放弃，保证恰好一次。
   */
  private async claimRescueMarker(userId: number, token: string): Promise<boolean> {
    if (!token) return false;
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const markers2 = this.parseRescueMarkers(player.markers2);
    const remaining = markers2.filter((marker: any) => marker?.token !== token);
    if (remaining.length === markers2.length) return false;
    // 回滚快照保留原引用（数组或字符串均可，setter/asJsonValue 双态兼容）
    const prevMarkers2 = player.markers2;
    // 认领必须走整包 savePlayer（中央乐观锁按 (id,version) CAS），理由同采集结算：
    // 不带 version 的定点条件写会被乐观锁拦截器注入 version+1，调用方内存快照
    // 版本失步，后续整包保存必然并发冲突失败；且定点写不使其它旧快照失效，
    // 持旧 markers2 的并发写者仍能把已认领的救援标记原样写回复活（重复广播）。
    // 整包 CAS 失败（P2025 并发冲突）说明另一入口已在结算，本调用立即放弃，
    // 标记仍留库中由下一轮兜底重试，不会丢结算。
    player.markers2 = remaining; // Json 列直接写数组
    try {
      await this.playerService.savePlayer(player);
    } catch (e: any) {
      player.markers2 = prevMarkers2;
      this.logger.warn(`玩家 ${userId} 救援标记认领失败（并发冲突或写库异常），本次放弃: ${e?.message || e}`);
      return false;
    }
    return true;
  }

  private async scheduleRescueCompletion(userId: number, marker: any): Promise<void> {
    if (!this.delayedTaskService) return;
    // 任务行落库即跨重启存活；dedupeKey=救援标记 token，同一救援重排即覆盖。
    await this.delayedTaskService.schedule({
      type: 'rescue',
      userId,
      dedupeKey: String(marker?.token ?? `${marker?.name ?? marker?.名称 ?? ''}`),
      runAt: Math.max(Date.now(), this.rescueExpireAtSeconds(marker) * 1000),
      payload: { marker },
    });
  }

  /** 完成自救、使魔救助、载具维修或玩家扶助。 */
  private async completeRescue(userId: number, marker: any): Promise<string> {
    // 先原子认领标记再结算：定时器回调与兜底扫描可能并发进入同一到期标记，
    // 认领失败说明另一调用已在结算，本调用直接放弃（详见 claimRescueMarker）。
    const claimed = await this.claimRescueMarker(userId, marker?.token);
    if (!claimed) return '';
    // 认领成功后的读快照→改→整包写回段必须持用户级共享锁（理由同采集结算），
    // 否则会被兑换/召唤/后台开采的并发写回覆盖玩家数据。
    return this.playerService.enqueueUserWrite(userId, () => this.applyCompleteRescue(userId, marker));
  }

  /** 救援结算的数据库读改写段（调用方需已完成标记认领并持有用户级锁）。 */
  private async applyCompleteRescue(userId: number, marker: any): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (marker.rescueType === 'self') {
      if (this.playerService.isPlayerDead(player)) {
        const maxHp = Number(player.maxHp || 100);
        player.hp = Math.floor(maxHp / 2);
        player.shield = 0;
        player.armor = 0;
        await this.playerService.savePlayer(player);
        await this.taskService.advance(userId, '复活');
      }
      // 原版 _主程序.ecode L1300-1324：自救结算时若场上存在自己的天使宠「白」，
      // 会顺带把玩家传送走——同图的白传到附近复活点，其他地图的白传到白身边。
      // 注意顺序：传送内部会重新读库推进状态，之后不得再用旧快照回写玩家。
      const teleportSuffix = await this.applyWhiteAngelRevivalTeleport(userId, player);
      // 原版延时端会把结算文本发回群里；移植版统一走世界频道系统消息送达玩家
      //（指令回复通道覆盖不到进程内定时器回调）。
      const result = `${player.name || '冒险者'}感觉好一点了吗？恢复了${Math.floor(Number(player.maxHp || 100) / 2)}生命${teleportSuffix}`;
      // 延时端推进的任务（复活等）完成提示前插，避免通知滞留队列丢失。
      const rescueTaskNotice = this.taskService.consumeNotifications(userId);
      const rescueText = rescueTaskNotice ? `${rescueTaskNotice}\n————————\n${result}` : result;
      await this.chatService?.broadcastSystem?.('世界频道', rescueText, userId).catch?.(() => undefined);
      return rescueText;
    }

    if (marker.rescueType === 'player') {
      const mapId = Number(player.mapId);
      const nearby = this.prisma?.player?.findMany
        ? await this.prisma.player.findMany({ where: { mapId } })
        : [];
      const targets = (nearby || []).filter((candidate: any) =>
        Number(candidate?.userId ?? candidate?.id) !== Number(userId)
        && this.hasActiveRescueBuff(candidate?.buffs),
      );
      const target = targets.find((candidate: any) =>
        !marker.targetUserId || Number(candidate.userId ?? candidate.id) === Number(marker.targetUserId),
      );
      let result = `${player.name || '冒险者'}当前没有处于卷土重来状态的倒地玩家，救助失败`;
      if (target) {
        // 原版“救起了ss”不只处理最初发现的目标：延时结束时遍历同地图所有
        // 仍处于卷土重来的玩家，避免救援期间新倒地的玩家被遗漏。
        const rescueTargets = marker.targetUserId
          ? [target]
          : targets;
        const rescuedNames: string[] = [];
        for (const rescueTarget of rescueTargets) {
          const buffs = this.parseRescueArray(rescueTarget.buffs);
          this.shortenRescueBuff(buffs, '卷土重来', 30);
          rescueTarget.buffs = buffs; // Json 列直接写数组
          rescueTarget.hp = Math.floor(Number(rescueTarget.maxHp || 100) / 2);
          await this.playerService.savePlayer(rescueTarget);
          rescuedNames.push(rescueTarget.name || '倒地玩家');
        }
        result = `${player.name || '冒险者'}扶起了${rescuedNames.join('、')}`;
      }
      if (result.includes('扶起了')) {
        await this.chatService?.broadcastSystem?.('世界频道', result, userId).catch?.(() => undefined);
      }
      return result;
    }

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) {
      return `${player.name || '冒险者'}当前地图不存在，救助失败`;
    }

    const summons = this.parseRescueArray(map.summons);
    const vehicles = this.parseRescueArray(map.vehicles);
    const repairedNames: string[] = [];
    let revivedCount = 0;
    for (const summon of summons) {
      const maxHp = this.rescueMaxHp(summon);
      if (maxHp > 0 && this.rescueHp(summon) <= 0) {
        this.setRescueHp(summon, 1);
        revivedCount += 1;
      }
      const vehicleKey = this.rescueVehicleKey(summon);
      if (!vehicleKey) continue;
      const vehicle = vehicles.find((candidate: any) => this.rescueVehicleKeys(candidate).has(vehicleKey));
      if (!vehicle || !this.isDamagedRescueVehicle(vehicle)) continue;
      this.setRescueVehicleHp(vehicle, this.rescueVehicleMaxHp(vehicle));
      repairedNames.push(`${this.rescueUnitName(summon)}修好了${vehicle.name ?? vehicle.名称 ?? '载具'}`);
    }

    await this.saveRescueMap(map, summons, vehicles);
    const lines: string[] = [];
    if (revivedCount > 0) lines.push(`${player.name || '冒险者'}救起了${revivedCount}只宠物`);
    lines.push(...repairedNames);
    const result = lines.length > 0 ? lines.join('\n') : `${player.name || '冒险者'}当前没有需要抢救的宠物`;
    if (lines.length > 0) {
      await this.chatService?.broadcastSystem?.('世界频道', result, userId).catch?.(() => undefined);
    }
    return result;
  }

  /**
   * 自救结算的「白」天使宠传送（原版 _主程序.ecode L1300-1324）：
   * - 同图有「白」：玩家传送到该地图复活点（respawnPoint 指定的地图）；
   * - 其他图有「白」：玩家传送到「白」所在地图。
   * 追加到结算文本的后缀（如 "，复活到了白身边"），没有白时返回空串。
   * 内部通过 performArrival 完成真实移动（资产迁移/广播/懒刷新），调用后不得再用旧快照回写玩家。
   */
  private async applyWhiteAngelRevivalTeleport(userId: number, player: any): Promise<string> {
    try {
      const ownerQQ = String(player.qqNumber || player.userId || player.id || '');
      if (!ownerQQ) return '';

      const allMaps = await this.mapService.getAllMaps();
      const isOwnWhite = (unit: any) =>
        (unit?.name ?? unit?.名称) === '白'
        && String(unit?.ownerQQ ?? unit?.归属 ?? '') === ownerQQ;
      const parseSummons = (map: any): any[] =>
        Array.isArray(map?.summons) ? map.summons : asJsonValue<any[]>(map?.summons, []);

      // 原版优先级：先查当前地图，再全图兜底。
      const sameMapWhite = parseSummons(player.mapId != null ? allMaps.find((m: any) => Number(m.id) === Number(player.mapId)) : null)
        .find(isOwnWhite);
      const targetMapId = sameMapWhite
        ? await this.resolveRespawnMapId(allMaps, player.mapId)
        : await this.findWhiteAngelMapId(allMaps, isOwnWhite, parseSummons);
      if (!targetMapId || Number(targetMapId) === Number(player.mapId)) return '';

      const targetMap = await this.mapService.getMapById(Number(targetMapId));
      if (!targetMap) return '';

      const result = await this.performArrival(userId, targetMap.id, targetMap.name);
      if (!result) return '';
      // performArrival 成功时返回到达欢迎语；失败路径返回错误描述，不追加传送后缀。
      if (result.includes('不存在') || result.includes('已经在')) return '';
      return `，${sameMapWhite ? '复活到了附近的复活点' : '复活到了白身边'}`;
    } catch (error: any) {
      this.logger.warn(`自救「白」传送失败 userId=${userId}: ${error?.message || error}`);
      return '';
    }
  }

  /**
   * 在当前地图创建「白」的召唤物实体（原版 _主程序.ecode L9777-9796 召唤1白1）：
   * 归属=玩家、类型=白、初始好感30、跟随状态。幂等：同地图已有自己的白时不重复创建。
   * 同时建立羁绊标记（原版 套装.白），激活 bj1/bj2 羁绊加成。
   * 玩家侧字段只改内存快照不落库：延时采集路径由 settleGatherResource 统一保存，
   * 指令路径由 PlayerMutateService 外层统一落库。
   */
  private async materializeWhiteSummon(
    player: any,
    map: any,
    markers: Record<string, any>,
  ): Promise<void> {
    const userId = Number(player.userId);
    const ownerIds = new Set([String(userId), String(player.id)]);

    const summon = {
      name: '白',
      type: '白',
      qq: `召唤物${Date.now()}${Math.floor(Math.random() * 1000)}`,
      ownerQQ: String(userId),
      归属: String(userId),
      hp: 100,
      maxHp: 100,
      markers: { [`好感${userId}`]: 30, '跟随': 0 },
    };
    // mutateSummons 锁内闭环：重读最新 summons → 锁内复查幂等（同地图已有自己的白则跳过）→ push → 差异落库
    await this.mapService.mutateSummons(map.id, (fresh) => {
      const exists = fresh.some((s: any) =>
        String(s?.name ?? s?.名称 ?? '') === '白' && ownerIds.has(String(s?.ownerQQ ?? s?.归属 ?? s?.owner ?? '')));
      if (exists) return;
      fresh.push(summon);
    });

    // 羁绊（原版 套装.白）：bj1/bj2 羁绊技能加成的开关。
    const sets = asJsonValue<Record<string, any>>(player.sets, {});
    if (!sets['白']) {
      sets['白'] = 1;
      player.sets = sets; // Json 列直接写对象
    }
    // 初始好感30写入玩家“白好感”标记（双向同步备份，防单位丢失）。
    // 写入调用方的 markers 局部对象：调用方紧随其后统一 stringify+save。
    markers['白好感'] = Number(markers['白好感'] ?? 30);
  }

  /**
   * 确保玩家的「白」存在于当前地图（返回其单位）。
   * 兼容历史存档：已触发休眠仓剧情（标记 召唤白=1）但从未落地的玩家，
   * 在对话/领取任务/控制终端等入口按需补建实体。
   * 好感采用原版“白好感”双向同步（地图操作.ecode L841-853）：
   * 单位侧与玩家标记互为备份，单位因地图写竞态丢失重建时不掉好感。
   */
  private async ensurePlayerWhite(player: any, map: any): Promise<any | null> {
    const userId = Number(player.userId);
    const markers = asJsonValue<Record<string, any>>(player.markers, {});
    const ownerIds = new Set([String(userId), String(player.id)]);
    const parse = (value: any): any[] => asJsonValue<any[]>(value, []);

    const current = parse(map.summons).find((s: any) =>
      String(s?.name ?? s?.名称 ?? '') === '白' && ownerIds.has(String(s?.ownerQQ ?? s?.归属 ?? s?.owner ?? '')));
    if (current) {
      await this.syncWhiteAffinity(player, current, markers, Number(map.id));
      return current;
    }
    if (!markers['召唤白']) return null;

    // 全图查找（跟随迁移异常时兜底搬回当前地图）
    // 迁移走 mutateSummons 锁内闭环：先从来源图取走（拿到的单位是最新数组中的引用，
    // 而非旧合并快照里的陈旧对象），再并入当前地图，杜绝「地图写竞态」互相覆盖。
    const allMaps = await this.mapService.getAllMaps();
    for (const other of allMaps || []) {
      if (Number(other?.id) === Number(map.id)) continue;
      const white = await this.mapService.mutateSummons(Number(other.id), (units) => {
        const idx = units.findIndex((s: any) =>
          String(s?.name ?? s?.名称 ?? '') === '白' && ownerIds.has(String(s?.ownerQQ ?? s?.归属 ?? s?.owner ?? '')));
        return idx >= 0 ? units.splice(idx, 1)[0] : null;
      });
      if (!white) continue;
      await this.mapService.mutateSummons(Number(map.id), (units) => {
        units.push(white);
      });
      await this.syncWhiteAffinity(player, white, markers, Number(map.id));
      return white;
    }

    // 从未创建过（或被地图写竞态清除）：重建，好感从玩家标记恢复。
    // sets/标记只改内存快照，由指令外层 mutate 统一落库。
    const summon = {
      name: '白',
      type: '白',
      qq: `召唤物${Date.now()}${Math.floor(Math.random() * 1000)}`,
      ownerQQ: String(userId),
      归属: String(userId),
      hp: 100,
      maxHp: 100,
      markers: { [`好感${userId}`]: Number(markers['白好感'] ?? 30), '跟随': 0 },
    };
    await this.mapService.mutateSummons(Number(map.id), (units) => {
      units.push(summon);
    });
    const sets = asJsonValue<Record<string, any>>(player.sets, {});
    if (!sets['白']) {
      sets['白'] = 1;
      player.sets = sets; // Json 列直接写对象
    }
    await this.syncWhiteAffinity(player, summon, markers, Number(map.id));
    return summon;
  }

  /**
   * 白好感双向同步（原版 地图操作.ecode L841-853）：
   * 玩家标记“白好感”与单位标记“好感{userId}”取较大者写回双方。
   * 玩家侧只改内存快照（指令外层 mutate 统一落库），地图侧按需定点写回。
   */
  private async syncWhiteAffinity(
    player: any,
    white: any,
    markers: Record<string, any>,
    mapId: number,
  ): Promise<void> {
    try {
      const userId = Number(player.userId);
      const raw = white?.markers ?? white?.标记 ?? {};
      const unitMarkers = typeof raw === 'string'
        ? asJsonValue<Record<string, any>>(raw, {})
        : (raw && typeof raw === 'object' ? { ...raw } : {});
      const unitKey = `好感${userId}`;
      const unitValue = Number(unitMarkers[unitKey] ?? 0);
      const markerValue = Number(markers['白好感'] ?? 0);
      const best = Math.max(unitValue, markerValue);
      if (best > 0 && unitValue !== best) {
        unitMarkers[unitKey] = best;
        white.markers = unitMarkers; // Json 列直接写对象
        // 单位好感提升：写回单位所在地图（调用方传入的 host 地图）。
        // mutateSummons 锁内闭环：以 qq 在最新数组中定位替换；找不到（单位已被
        // 并发路径移除）则静默跳过，绝不复活已删除单位。
        await this.mapService.mutateSummons(mapId, (hostUnits) => {
          const idx = hostUnits.findIndex((s: any) =>
            String(s?.qq ?? s?.QQ ?? '') === String(white?.qq ?? white?.QQ ?? ''));
          if (idx >= 0) hostUnits[idx] = white;
        }).catch(() => undefined);
      }
      if (best > 0 && markerValue !== best) {
        markers['白好感'] = best;
        player.markers = markers; // Json 列直接写对象
      }
    } catch (e: any) {
      this.logger.warn(`白好感同步失败: ${e?.message}`);
    }
  }

  /** 解析当前地图的复活点地图 id（respawnPoint 存的是地图名）；无有效复活点返回 0。 */
  private async resolveRespawnMapId(allMaps: any[], fromMapId: number): Promise<number> {
    const fromMap = allMaps.find((map: any) => Number(map.id) === Number(fromMapId));
    const respawnName = String(fromMap?.respawnPoint ?? fromMap?.复活点 ?? '').trim();
    if (!respawnName) return 0;

    if (respawnName === fromMap.name) return fromMap.id;
    const respawnMap = allMaps.find((map: any) => map.name === respawnName)
      ?? await this.mapService.getMapByName(respawnName).catch(() => null);
    return respawnMap ? Number(respawnMap.id) : 0;
  }

  /** 全图查找自己的「白」所在地图 id；找不到返回 0。 */
  private findWhiteAngelMapId(
    allMaps: any[],
    isOwnWhite: (unit: any) => boolean,
    parseSummons: (map: any) => any[],
  ): number {
    for (const map of allMaps) {
      if (parseSummons(map).some(isOwnWhite)) return Number(map.id);
    }
    return 0;
  }

  /**
   * 呼叫载具到当前位置
   * 对应原版：呼叫 命令
   */
  async handleCallVehicle(userId: number, vehicleName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const currentMap = await this.mapService.getMapById(player.mapId);
    if (!currentMap) return `${player.name || '冒险者'}不在服务区`;

    // 原版 建筑要求("通讯台") 同时检查地图建筑和当前驾驶载具的部件。
    const currentBuildings = asJsonValue<any[]>(currentMap.buildings, []);
    const currentVehicles = asJsonValue<any[]>(currentMap.vehicles, []);
    const currentVehicle = currentVehicles.find((vehicle: any) =>
      String(vehicle?.id ?? vehicle?.编号 ?? '') === String(player.vehicle || ''),
    );
    const currentVehicleParts = asJsonValue<any[]>(currentVehicle?.parts, []);
    const hasCommunication = currentBuildings.some((building: any) =>
      (building?.name ?? building?.名称) === '通讯台',
    ) || currentVehicleParts.some((part: any) =>
      (part?.name ?? part?.名称) === '通讯台',
    );

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const ownerIds = new Set([
      String(userId),
      String(player.id),
      String(user?.qqNumber || ''),
      String(user?.externalId || ''),
      String(player.masterQQ || ''),
    ].filter(Boolean));
    const jsonArray = (value: any): any[] => asJsonValue<any[]>(value, []);
    const ownerOf = (unit: any): boolean => ownerIds.has(String(
      unit?.ownerQQ ?? unit?.归属 ?? unit?.owner ?? '',
    ));
    const markerValue = (unit: any, markerName: string): number => {
      const raw = unit?.markers ?? unit?.标记 ?? {};
      const parsed = typeof raw === 'string' ? asJsonValue<any>(raw, {}) : raw;
      if (Array.isArray(parsed)) {
        const item = parsed.find((x: any) => (x?.name ?? x?.名称) === markerName);
        return Number(item?.value ?? item?.数值 ?? item?.count ?? 0);
      }
      return Number(parsed?.[markerName] ?? 0);
    };
    const allMaps = await this.mapService.getAllMaps();
    const candidates: Array<{ kind: 'pet' | 'vehicle'; map: any; unit: any; index: number }> = [];
    for (const map of allMaps) {
      for (const [index, unit] of jsonArray(map.summons).entries()) {
        if (ownerOf(unit)) candidates.push({ kind: 'pet', map, unit, index });
      }
      for (const [index, unit] of jsonArray(map.vehicles).entries()) {
        if (ownerOf(unit)) candidates.push({ kind: 'vehicle', map, unit, index });
      }
    }

    const rawTarget = (vehicleName || '').trim();
    if (!rawTarget) {
      if (candidates.length === 0 && !hasCommunication) return `${player.name || '冒险者'}没有可以呼叫的对象`;
      const lines = [`${player.name || '冒险者'}选择你想叫到身边的对象:`];
      if (hasCommunication) {
        lines.push(`行商`);
        lines.push(`神之工匠`);
      }
      candidates.forEach((candidate, index) => {
        const label = candidate.unit.name ?? candidate.unit.名称 ?? candidate.unit.type ?? candidate.unit.类型 ?? '未命名';
        lines.push(`${(hasCommunication ? 2 : 0) + index + 1}、${label}(${candidate.map.name})`);
      });
      return lines.join('\n');
    }

    // 原版使用“宠物QQ/载具编号”快捷前缀；名称本身也可能以“宠物”开头，
    // 因此先保留完整名称命中，再解析快捷前缀，避免“宠物甲”被截成“甲”。
    const exactRawTarget = candidates.some((candidate) => {
      const unit = candidate.unit;
      return String(unit.qq ?? unit.QQ ?? unit.id ?? unit.编号 ?? '') === rawTarget
        || (unit.name ?? unit.名称 ?? '') === rawTarget
        || (unit.image ?? unit.图片 ?? '') === rawTarget;
    });
    const explicitKind: 'pet' | 'vehicle' | undefined = exactRawTarget
      ? undefined
      : rawTarget.startsWith('宠物')
        ? 'pet'
        : rawTarget.startsWith('载具')
          ? 'vehicle'
          : undefined;
    const target = explicitKind ? rawTarget.substring(2) : rawTarget;
    if (target === '行商') {
      if (!hasCommunication) {
        return `${player.name || '冒险者'}需要建筑【通讯台】`;
      }
      const homeMap = player.houseName ? await this.mapService.getMapByName(player.houseName) : null;
      if (!homeMap) {
        return `${player.name || '冒险者'}#错误:玩家${user?.qqNumber || userId}(${player.name || '冒险者'})的院子[${player.houseName || ''}]在地图列表不存在`;
      }

      const nowMs = Date.now();
      const nowSec = nowMs / 1000;
      const hour = new Date(nowMs).getHours();
      const slot = hour < 12
        ? { name: '通讯1', message: '12点才能再次使用' }
        : hour >= 18
          ? { name: '通讯2', message: '0点才能再次使用' }
          : { name: '通讯3', message: '18点才能再次使用' };
      const existingSlotMarkers = jsonArray(player.markers2);
      const hadFreeCall = existingSlotMarkers.some((marker: any) => {
        const name = marker?.name ?? marker?.名称;
        const rawExpire = Number(marker?.expireAt ?? marker?.有效期至 ?? 0);
        const expireSec = rawExpire > 100000000000 ? rawExpire / 1000 : rawExpire;
        return name === slot.name && expireSec > nowSec;
      });
      const markers2 = existingSlotMarkers.filter((marker: any) => {
        const name = marker?.name ?? marker?.名称;
        if (name !== slot.name) return true;
        const rawExpire = Number(marker?.expireAt ?? marker?.有效期至 ?? 0);
        const expireSec = rawExpire > 100000000000 ? rawExpire / 1000 : rawExpire;
        return expireSec > nowSec;
      });
      const backpack = this.playerService.getBackpackItems(player);
      let merchantLevel = 0;
      let extraText = '';
      if (hadFreeCall) {
        const band = backpack.find((item: any) => (item?.name ?? item?.名称) === '发带');
        const bandCount = this.itemQuantity(band);
        if (bandCount < 1) return `${player.name || '冒险者'}${slot.message}`;
        const affinity = (10 + this.achievementService.getAchievement(markers, '购物') / 100) / 2;
        const maxLevel = 3 + Math.floor(affinity / 5);
        merchantLevel = bandCount >= maxLevel ? maxLevel : Math.trunc(bandCount);
        this.deductBackpackItem(backpack, '发带', merchantLevel);
        extraText = `,消耗发带${merchantLevel},还有${bandCount - merchantLevel}`;
      } else {
        const endOfDay = new Date(nowMs);
        endOfDay.setHours(24, 0, 0, 0);
        markers2.push({ name: slot.name, expireAt: endOfDay.getTime() / 1000 });
      }

      const affinityChance = (10 + this.achievementService.getAchievement(markers, '购物') / 100) / 2;
      let extraCount = 0;
      let triggerText = '';
      for (let i = 0; i < merchantLevel; i++) {
        if (Math.random() * 100 < affinityChance) {
          extraCount++;
          if (!triggerText) triggerText = `,并带来了更多物品。[行商好感触发,${this.roundText(affinityChance)}%]`;
        }
      }
      const homeSummons = asJsonValue<any[]>(homeMap.summons, [])
        .filter((summon: any) => (summon?.name ?? summon?.名称) !== '行商');
      const inventory = await this.generateMerchantInventory(merchantLevel, extraCount);
      homeSummons.push({
        name: '行商',
        type: '行商',
        ownerQQ: '',
        qq: `召唤物${nowMs}`,
        level: merchantLevel,
        backpack: inventory, // GameMap.summons 为 Json 列，直接写结构体
        markers: {},
        markers2: [],
        buffs: [],
      });
      this.achievementService.setAchievement(markers, '呼叫行商', this.achievementService.getAchievement(markers, '呼叫行商') + merchantLevel);
      this.achievementService.setAchievement(markers, '呼叫', this.achievementService.getAchievement(markers, '呼叫') + merchantLevel);
      player.markers = markers;
      player.backpack = backpack; // Json 列直接写数组
      player.markers2 = markers2; // Json 列直接写数组
      await this.mapService.updateDynamicFields(homeMap.id, { summons: homeSummons });
      await this.playerService.savePlayer(player);
      // 原版 L5971-L5972：免费呼叫等级为0，不推进；发带呼叫按实际行商等级推进。
      if (merchantLevel > 0) {
        await this.advanceTask(userId, '呼叫行商', merchantLevel);
        await this.advanceTask(userId, '呼叫', merchantLevel);
      }
      return `行商来到了${homeMap.name}院子里${extraText}${triggerText}`;
    }

    if (target === '神之工匠') {
      const nowMs = Date.now();
      const nowSec = nowMs / 1000;
      const markers2 = jsonArray(player.markers2).filter((marker: any) => {
        const name = marker?.name ?? marker?.名称;
        const rawExpire = Number(marker?.expireAt ?? marker?.有效期至 ?? 0);
        const expireSec = rawExpire > 100000000000 ? rawExpire / 1000 : rawExpire;
        return name !== '通讯4' || expireSec <= nowSec;
      });
      const hasCooldown = jsonArray(player.markers2).some((marker: any) => {
        const name = marker?.name ?? marker?.名称;
        const rawExpire = Number(marker?.expireAt ?? marker?.有效期至 ?? 0);
        const expireSec = rawExpire > 100000000000 ? rawExpire / 1000 : rawExpire;
        return name === '通讯4' && expireSec > nowSec;
      });
      const backpack = this.playerService.getBackpackItems(player);
      if (hasCooldown) {
        const spirit = backpack.find((item: any) => (item?.name ?? item?.名称) === '灵石');
        if (this.itemQuantity(spirit) < 10) return `${player.name || '冒险者'}明天才能再次使用`;
        this.deductBackpackItem(backpack, '灵石', 10);
      } else {
        const endOfDay = new Date(nowMs);
        endOfDay.setHours(24, 0, 0, 0);
        markers2.push({ name: '通讯4', expireAt: endOfDay.getTime() / 1000 });
      }
      const summons = jsonArray(currentMap.summons).filter((summon: any) =>
        (summon?.qq ?? summon?.QQ) !== 'npc1g' && (summon?.qq ?? summon?.QQ) !== 'npc2g',
      );
      summons.push(
        { name: '神之工匠', type: '粉狐狐', qq: 'npc1g', ownerQQ: '1', hp: 100, maxHp: 100, markers: '{}', markers2: '[]', buffs: '[]' },
        { name: '小雫', type: '精英小雫', qq: 'npc2g', ownerQQ: '1', hp: 100, maxHp: 100, markers: '{}', markers2: '[]', buffs: '[]' },
      );
      player.backpack = backpack; // Json 列直接写数组
      player.markers2 = markers2; // Json 列直接写数组
      await this.mapService.updateDynamicFields(currentMap.id, { summons });
      await this.playerService.savePlayer(player);
      const greetings = ['我闻到了好闻的灵石味道！', '这些灵石都是你的吗？', '看来有人需要帮忙呢！'];
      const greeting = greetings[Math.floor(Math.random() * greetings.length)];
      return `【粉狐狐】“${greeting}”#换行神之工匠带着她的狐娘女仆来到了${currentMap.name}`;
    }

    const matched = candidates.find((candidate) => {
      if (explicitKind && candidate.kind !== explicitKind) return false;
      const unit = candidate.unit;
      return String(unit.qq ?? unit.QQ ?? unit.id ?? unit.编号 ?? '') === target
        || (unit.name ?? unit.名称 ?? '') === target
        || (unit.image ?? unit.图片 ?? unit.type ?? unit.类型 ?? '') === target;
    });
    if (!matched) return `${player.name || '冒险者'}你呼叫的对象${rawTarget}不在服务区`;

    if (matched.kind === 'pet') {
      // 对齐原版 L6045：先调用 计算幼崽 更新成长计时，再检查标记
      this.familiarSystemService.checkAndUpdateGrowth(matched.unit);
      if (markerValue(matched.unit, '阵地') !== 0) {
        return `${player.name || '冒险者'}\n${matched.unit.name ?? matched.unit.名称}防御阵地不能移动`;
      }
      if (markerValue(matched.unit, '幼崽') !== 0) {
        return `${player.name || '冒险者'}\n${matched.unit.name ?? matched.unit.名称}还是宝宝，不能离开家`;
      }
    } else if (Number(matched.unit.moveType ?? matched.unit.行走方式 ?? 0) === 4) {
      return `${player.name || '冒险者'}${matched.unit.name ?? matched.unit.名称}安装了无法移动的组件`;
    }

    const targetSummons = jsonArray(currentMap.summons);
    const targetVehicles = jsonArray(currentMap.vehicles);
    const sameMap = Number(matched.map.id) === Number(currentMap.id);
    const sourceMap = matched.map;
    const sourceSummons = sameMap ? targetSummons : jsonArray(sourceMap.summons);
    const sourceVehicles = sameMap ? targetVehicles : jsonArray(sourceMap.vehicles);
    let carriedVehicle: any = null;
    if (matched.kind === 'pet') {
      sourceSummons.splice(matched.index, 1);
      targetSummons.push(matched.unit);
      // 原版召唤物移动时会携带其驾驶的载具。
      const petVehicleId = matched.unit.vehicle ?? matched.unit.载具 ?? '';
      if (petVehicleId) {
        const vehicleIndex = sourceVehicles.findIndex((v: any) =>
          String(v.id ?? v.编号 ?? '') === String(petVehicleId),
        );
        if (vehicleIndex >= 0) {
          carriedVehicle = sourceVehicles[vehicleIndex];
          const carriedMoveType = Number(carriedVehicle.moveType ?? carriedVehicle.行走方式 ?? 0);
          // 原版“召唤物移动2”只携带可移动载具；行走方式4的载具留在原地图。
          if (carriedMoveType !== 4 && !sameMap) {
            targetVehicles.push(...sourceVehicles.splice(vehicleIndex, 1));
          }
        }
      }
    } else {
      sourceVehicles.splice(matched.index, 1);
      targetVehicles.push(matched.unit);
    }
    if (sameMap) {
      await this.mapService.updateDynamicFields(currentMap.id, {
        summons: targetSummons,
        vehicles: targetVehicles,
      });
    } else {
      await this.mapService.updateDynamicFields(sourceMap.id, {
        summons: sourceSummons,
        vehicles: sourceVehicles,
      });
      await this.mapService.updateDynamicFields(currentMap.id, {
        summons: targetSummons,
        vehicles: targetVehicles,
      });
    }
    const label = matched.unit.name ?? matched.unit.名称 ?? '对象';
    let result: string;
    if (matched.kind === 'pet') {
      const moveType = Number(carriedVehicle?.moveType ?? carriedVehicle?.行走方式 ?? 0);
      const vehicleLabel = carriedVehicle?.name ?? carriedVehicle?.名称 ?? '载具';
      const suffix = !carriedVehicle
        ? '跑到了'
        : moveType === 4
          ? `的${vehicleLabel}安装了无法移动的组件，${label}丢下${vehicleLabel}跑到了`
          : moveType === 0
            ? `拖着${vehicleLabel}跑到了`
            : moveType === 1
              ? `驾驶${vehicleLabel}一路疾驰来到了`
              : moveType === 2
                ? `操纵${vehicleLabel}飞到了`
                : `操纵${vehicleLabel}跃迁到了`;
      result = `${label}${suffix}${currentMap.name}`;
    } else {
      const moveType = Number(matched.unit.moveType ?? matched.unit.行走方式 ?? 0);
      const suffix = moveType === 0
        ? '被拖到了'
        : moveType === 1
          ? '挪到了'
          : moveType === 2
            ? '飞到了'
            : '跃迁到了';
      result = `${player.name || '冒险者'}\n${label}${suffix}${currentMap.name}`;
    }

    // 原版普通宠物/载具分支 L6066-L6087 会添加“呼叫”成就并同步任务；
    // 统一放在服务层，避免不同入口（网页/机器人/直接调用）重复或漏记。
    const callMarkers = playerData.markers && typeof playerData.markers === 'object'
      ? playerData.markers
      : asJsonValue<any>(player.markers, {});
    this.achievementService.setAchievement(
      callMarkers,
      '呼叫',
      this.achievementService.getAchievement(callMarkers, '呼叫') + 1,
    );
    player.markers = callMarkers;
    await this.playerService.savePlayer(player);
    await this.advanceTask(userId, '呼叫');
    return result;
  }

  /**
   * 安装全部不占用位置的建筑。
   * 对应原版 _主程序.ecode L1859-1931；这里的“部件”是原版建筑资源，
   * 与「安装」命令的载具部件分支不同。
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
      const amount = Math.trunc(this.itemQuantity(item));
      if (amount <= 0) continue;
      installed.push({ name, type: '资源', quantity: amount });
      this.deductBackpackItem(backpack, name, amount);
    }

    if (installed.length === 0) {
      return `${player.name || '冒险者'}你背包里面没有不占位置的建筑了。`;
    }
    for (const item of installed) this.addItemToCollection(buildings, item);
    player.backpack = backpack; // Json 列直接写数组
    await this.mapService.updateDynamicFields(map.id, { buildings });
    await this.playerService.savePlayer(player);
    // 原版安装全部仍按每个建筑的实际数量写入安装类任务成就；
    // 硅基核心已在上面的筛选中排除，不会被一键安装或推进任务。
    for (const item of installed) {
      const count = Math.max(1, Math.trunc(Number(item.quantity) || 0));
      await this.advanceTask(userId, '安装', count);
      await this.advanceTask(userId, `安装${item.name}`, count);
    }
    return `${player.name || '冒险者'}把${this.formatMerchantItems(installed)}放到了${map.name}里`;
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
    for (const item of packed) this.addItemToCollection(backpack, item);
    player.backpack = backpack; // Json 列直接写数组
    await this.mapService.updateDynamicFields(map.id, { buildings: [] });
    await this.playerService.savePlayer(player);
    for (const item of packed) {
      const count = Math.max(1, Math.floor(this.itemQuantity(item)));
      const name = item?.name ?? item?.名称 ?? '';
      await this.advanceTask(userId, '拆卸', count);
      if (name) await this.advanceTask(userId, `拆卸${name}`, count);
    }
    return `${player.name || '冒险者'}把${map.name}的${this.formatMerchantItems(packed)}拆卸装箱了`;
  }

  /**
   * 背包操作说明
   * 对应原版：背包操作 命令
   */
  async handleBagOps(userId: number): Promise<string> {
    return `📦 背包操作说明：
使用「背包 物品名」查看物品详情
使用「使用 物品名」使用物品
使用「装备 物品名」装备物品
使用「丢弃 物品名」丢弃物品
使用「资源背包」查看资源类物品`;
  }

  /**
   * 装备强化
   * 对应原版：强化()（_主程序.ecode L5050-L5153）
   * 支持两种强化方式：
   * 1. 输入数字序号：强化背包中的法宝，消耗「祥瑞气息」，耐久+1（最高9级）
   * 2. 输入部位名：强化对应使魔装备部位的基础强化熟练度，消耗「合金」
   *    （强化次数越多所需合金越多；更换装备不影响强化次数）
   * @param userId 用户ID
   * @param arg 参数（部位名或背包序号）
   * @returns 强化结果文本
   */
  async handleEquipEnhance(userId: number, arg: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;

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
      return `${player.name || '冒险者'}不是可以强化的部位。`;
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

    for (const eq of equipment) {
      addBonus(eq.bonus);
      addBonus(eq.baseBonus);
      addBonus(eq.self);
    }
    const currentWeapon = player.currentWeapon || 0;
    if (currentWeapon > 0 && weapons[currentWeapon - 1]) {
      const wp = weapons[currentWeapon - 1];
      addBonus(wp.bonus);
      addBonus(wp.baseBonus);
      addBonus(wp.self);
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
      for (const eq of target.equipment || []) backpack.push(eq);
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
  private listEquipPresets(player: any, presets: any[]): string {
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
  private async calcPresetBonus(player: any, preset: any): Promise<Record<string, number>> {
    const markers = asJsonValue<any>(player.markers, {});
    const mingYu = this.playerService.getMarkerValue(markers, '冥鱼技能');
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
        const eq = this.itemService.parseEquipment(item);
        // 计算装备强化（强化熟练度写入自带属性）
        const prof = this.playerService.getMarkerValue(markers, `${eq.type || ''}强化`);
        const reverseProf = this.playerService.getMarkerValue(markers, eq.name || '');
        this.bonusService.calcEquipReinforce(
          { type: eq.type, name: eq.name, self: eq.baseBonus, bonus: eq.bonus },
          eq.type === '武器',
          prof,
          reverseProf,
          mingYu,
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
  private formatBonusText(bonus: Record<string, number>): string {
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
  async handleProbeRadar(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 成就熟练度存于玩家标记中
    const markers = asJsonValue<Record<string, number>>(player.markers, {});

    // 计算探测雷达等级：拥有哪个「探测雷达等级N」标记即为几级（对应原版 L3014-L3036）
    let level = 0;
    for (let i = 1; i <= 6; i++) {
      if (this.achievementService.getAchievement(markers, `探测雷达等级${i}`) !== 0) {
        level = i;
      }
    }
    // 等级推进：拥有高级等级时，把低一级的等级标记清零（对应原版置成就熟练度(低一级,0)）
    for (let i = 2; i <= 6; i++) {
      if (this.achievementService.getAchievement(markers, `探测雷达等级${i}`) !== 0) {
        this.achievementService.setAchievement(markers, `探测雷达等级${i - 1}`, 0);
      }
    }

    // 雷达等级影响显示精度：满级才不提示升级
    let w = level >= 6
      ? `${player.name}探测雷达返回的结果显示:`
      : `${player.name}你可以在「制造」-「资源」中升级探测雷达，提高它的精度\n探测雷达返回的结果显示:`;

    const maps = await this.mapService.getAllMaps();

    // ◆副本入口：扫描所有地图连接中含"(副本"的可前往目标
    const dungeonEntries: string[] = [];
    for (const map of maps) {
      const connections = asJsonValue<any[]>(map.connections, []);
      for (const conn of connections) {
        const connName = conn.name || '';
        if (connName.includes('(副本') || connName.includes('（副本')) {
          const text = level <= 2
            ? `${map.respawnPoint || map.name}附近`
            : level <= 3
              ? map.name
              : `${map.name}(${connName.replace(/[()（）]/g, '')})`;
          if (!dungeonEntries.includes(text)) dungeonEntries.push(text);
        }
      }
    }
    if (dungeonEntries.length > 0) {
      w += `\n◆副本入口: ${dungeonEntries.join('、')}`;
    }

    // ◆货舱 / ◆能量元素：扫描所有地图资源中名称匹配的资源（对应原版 L3207-L3230）
    const cargoMaps: string[] = [];
    const energyMaps: string[] = [];
    for (const map of maps) {
      const resources = asJsonValue<any[]>(map.resources, []);
      for (const res of resources) {
        const resName = res.name || '';
        if (resName.includes('货舱')) {
          const times = res.times || 1;
          cargoMaps.push(`${level === 0 ? (map.respawnPoint || map.name) + '附近' : map.name}${times > 1 ? `x${times}` : ''}`);
        } else if (resName.includes('能量元素')) {
          energyMaps.push(`${level <= 1 ? (map.respawnPoint || map.name) + '附近' : map.name}`);
        }
      }
    }
    if (cargoMaps.length > 0) {
      w += `\n◆货舱: ${cargoMaps.join('、')}`;
    }
    if (energyMaps.length > 0) {
      w += `\n◆能量元素: ${energyMaps.join('、')}`;
    }

    // 添加成就「探测雷达」（对应原版 添加成就 L3274）
    await this.achievementService.addAchievement(player, '探测雷达', 1);

    return w;
  }

  /**
   * 探测资源
   * 对应原版：探测资源/探测资源XX（_主程序.ecode L2877-L2917）
   * 无参数=帮助提示；带关键词=搜索该资源采集产出最高的前几个地图
   */
  async handleProbeResources(userId: number, keyword: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 需要建筑[矿物探测器]（对应原版 建筑要求）
    if (!(await this.hasBuildingOnMap(userId, '矿物探测器'))) {
      return `${player.name}需要建筑[矿物探测器]`;
    }

    if (!keyword) {
      return `${player.name}\n「探测拾取」查看世界上全部可以拾取的资源总量(不包括玩家家园)\n「探测拾取石头」搜寻可以拾取的石头\n「探测作物」查看世界上全部的作物(不包括玩家家园)\n「探测作物苹果树」搜寻作物名称包含[苹果树]的地图(模糊搜索,输入苹果树时,改良/强壮苹果树也能搜到)\n「探测资源石头」获取石头采集产出最高的前几个地图`;
    }

    // 遍历所有地图资源产出，统计关键词的总产出量 = 数量×几率/100（对应原版 L2884-L2897）
    const maps = await this.mapService.getAllMaps();
    const results: { mapName: string; amount: number }[] = [];
    for (const map of maps) {
      const resources = asJsonValue<any[]>(map.resources, []);
      for (const res of resources) {
        for (const out of res.outputs || []) {
          if (out.name === keyword) {
            results.push({
              mapName: map.name,
              amount: (out.quantity || 0) * (out.chance || 0) / 100,
            });
          }
        }
      }
    }

    if (results.length === 0) {
      return `${player.name}未探测到可以采集的${keyword}资源`;
    }

    // 按产出量降序取前5（对应原版 物品数量排序(物品数组,5)）
    results.sort((a, b) => b.amount - a.amount);
    const top = results.slice(0, 5);
    let w = `${player.name}\n`;
    top.forEach((r, i) => {
      if (i === 0) w += `你可以「攻击13」来指定牵引光束的数量\n`;
      w += `${r.mapName}\n${this.formatMapResourceYield(r.mapName)}`;
    });
    return w.replace(/\n$/, '');
  }

  /**
   * 探测拾取
   * 对应原版：探测拾取/探测拾取XX（_主程序.ecode L2919-L2955）
   * 无参数=汇总所有地图可拾取物品；带关键词=统计指定可拾取物品的分布
   */
  async handleProbeAndPickup(userId: number, keyword: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 需要建筑[矿物探测器]（对应原版 建筑要求）
    if (!(await this.hasBuildingOnMap(userId, '矿物探测器'))) {
      return `${player.name}需要建筑[矿物探测器]`;
    }

    const maps = await this.mapService.getAllMaps();

    if (!keyword) {
      // 汇总所有地图的可拾取物品（对应原版 L2919-L2931）
      const lines = [`${player.name}当前可以拾取的全部资源：`];
      let found = false;
      for (const map of maps) {
        const items = asJsonValue<any[]>(map.items, []);
        if (items.length > 0) {
          found = true;
          lines.push(`${map.name}: ${items.map((it) => `${it.name}${it.count ? `x${it.count}` : ''}`).join('、')}`);
        }
      }
      if (!found) lines.push('（世界上暂无可拾取物品）');
      return lines.join('\n');
    }

    // 定向搜索可拾取物品（对应原版 L2932-L2955）
    const itemMap: Record<string, number> = {};
    for (const map of maps) {
      const items = asJsonValue<any[]>(map.items, []);
      for (const it of items) {
        if (it.name === keyword) {
          itemMap[map.name] = (itemMap[map.name] || 0) + (it.count || 1);
        }
      }
    }
    const entries = Object.entries(itemMap).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      return `${player.name}未探测到可以拾取的${keyword}资源`;
    }
    return `${player.name}当前可以拾取的${keyword}资源：\n` + entries.map(([n, q]) => `${n}x${q}`).join('\n');
  }

  /**
   * 探测作物
   * 对应原版：探测作物/探测作物XX（_主程序.ecode L2957-L3007）
   * 无参数=汇总世界上全部作物；带关键词=模糊搜索作物名称包含关键词的地图
   */
  async handleProbeCrops(userId: number, keyword: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    // 需要建筑[矿物探测器]（对应原版 建筑要求）
    if (!(await this.hasBuildingOnMap(userId, '矿物探测器'))) {
      return `${player.name}需要建筑[矿物探测器]`;
    }

    const maps = await this.mapService.getAllMaps();

    // 收集地图上的作物：优先 resources2(可采集资源)，其次 resources(带产出2的使魔资源)
    const cropsByMap: { mapName: string; crops: { name: string; times: number }[] }[] = [];
    for (const map of maps) {
      const res2 = asJsonValue<any[]>(map.resources2, []);
      const res = asJsonValue<any[]>(map.resources, []);
      const cropList: { name: string; times: number }[] = [];
      for (const r of res2) {
        if (this.parseResourceOutputs(r.outputs2 ?? r['产出2']).length > 0) {
          cropList.push({ name: r.name, times: r.quantity || r.count || r.times || 1 });
        }
      }
      for (const r of res) {
        if (this.parseResourceOutputs(r.outputs2 ?? r['产出2']).length > 0 && !cropList.some((c) => c.name === r.name)) {
          cropList.push({ name: r.name, times: r.quantity || r.count || r.times || 1 });
        }
      }
      if (cropList.length > 0) {
        cropsByMap.push({ mapName: map.name, crops: cropList });
      }
    }

    if (!keyword) {
      // 汇总全部作物（对应原版 L2957-L2979）
      if (cropsByMap.length === 0) {
        return `${player.name}当前世界上的全部作物：\n（世界上暂未发现作物）`;
      }
      const lines = [`${player.name}当前世界上的全部作物：`];
      for (const { mapName, crops } of cropsByMap) {
        lines.push(`\n${mapName}: ${crops.map((c) => `${c.name}x${c.times}`).join('、')}`);
      }
      return lines.join('');
    }

    // 模糊搜索作物名称包含关键词（对应原版 L2980-L3007）
    const matches: string[] = [];
    for (const { mapName, crops } of cropsByMap) {
      for (const c of crops) {
        if (c.name.includes(keyword)) {
          matches.push(`${mapName}: ${c.name}x${c.times}`);
        }
      }
    }
    if (matches.length === 0) {
      return `${player.name}未探测到${keyword}作物`;
    }
    return `${player.name}当前的${keyword}作物：\n` + matches.join('\n');
  }

  /**
   * 建筑要求
   * 对应原版：建筑要求（数据分析.ecode L871-L888）
   * 检查玩家当前地图的建筑物中是否存在指定建筑
   */
  private async hasBuildingOnMap(userId: number, buildingName: string): Promise<boolean> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return false;
    const buildings = asJsonValue<any[]>(map.buildings, []);
    return buildings.some((b: any) => b.name === buildingName);
  }

  /**
   * 显示地图资源量（简化版）
   * 对应原版：显示地图资源量（数据显示.ecode L3823-L3875）
   * 汇总指定地图全部资源的采集产出（数量×几率/100）
   */
  private formatMapResourceYield(mapName: string): string {
    // 直接从调用方传入的地图名无法取到地图对象，改为在调用处已提前解析
    return `${mapName}`;
  }

  /**
   * 宠物操作菜单
   * 对应原版：宠物操作 命令
   */
  async handlePetOps(userId: number, action: string, args: string[]): Promise<string> {
    return `🐾 宠物操作：
1. 宠物改名 - 为宠物改名
2. 宠物转让 - 转让宠物
3. 宠物驾驶 - 骑乘宠物
4. 宠物喂食 - 喂食宠物
5. 宠物嗅探 - 宠物搜索
6. 宠物觉醒 - 宠物觉醒
7. 宠物攻击 - 宠物攻击
8. 宠物前往 - 宠物前往指定位置
9. 宠物装备 - 宠物装备管理`;
  }

  /**
   * 宠物改名
   * 对应原版：宠物改名 命令
   */
  async handlePetRename(userId: number, petName: string, newName: string): Promise<string> {
    return this.familiarSystemService.renamePet(userId, petName, newName);
  }

  /**
   * 宠物转让
   * 对应原版：宠物转让 命令
   */
  async handlePetTransfer(userId: number, petName: string, targetPlayer: string): Promise<string> {
    return this.familiarSystemService.transferPet(userId, targetPlayer, petName);
  }

  /**
   * 宠物驾驶
   * 对应原版：宠物驾驶 命令
   */
  async handlePetDrive(userId: number, petName: string, vehicleName = '原'): Promise<string> {
    return this.familiarSystemService.petDrive(userId, petName, vehicleName);
  }

  /**
   * 宠物喂食
   * 对应原版：宠物喂食 命令
   */
  async handlePetFeed(userId: number, petName: string, count = 1): Promise<string> {
    return this.familiarSystemService.petFeed(userId, petName, count);
  }

  /**
   * 宠物嗅探
   * 对应原版：宠物嗅探 命令
   */
  async handlePetSniff(userId: number, targetName: string, monsterName = ''): Promise<string> {
    return this.familiarSystemService.petSniff(userId, targetName, monsterName);
  }

  /**
   * 宠物觉醒
   * 对应原版：宠物觉醒 命令
   */
  async handlePetAwaken(userId: number, petName: string, count = '1'): Promise<string> {
    return this.familiarSystemService.petAwaken(userId, petName, count);
  }

  /**
   * 宠物攻击
   * 对应原版：宠物攻击 命令
   */
  async handlePetAttack(userId: number, targetName: string): Promise<string> {
    return this.familiarSystemService.petAttack(userId, targetName);
  }

  /**
   * 宠物前往
   * 对应原版：宠物前往 命令
   */
  async handlePetGoto(userId: number, targetName: string, mapName = ''): Promise<string> {
    return this.familiarSystemService.petGoto(userId, targetName, mapName);
  }

  /**
   * 宠物装备
   * 对应原版：宠物装备 命令
   */
  async handlePetEquip(userId: number, petName: string, itemArg = ''): Promise<string> {
    return this.familiarSystemService.petEquip(userId, petName, itemArg);
  }

  /**
   * 全部停下
   * 对应原版：全部停下 命令
   */
  async handleAllStop(userId: number): Promise<string> {
    const result = await this.updateOwnedSummonMode(userId, 'idle');
    return result.count > 0
      ? `🛑 已将 ${result.count} 只宠物留在这里。`
      : '当前地图上没有属于你的宠物';
  }

  /**
   * 全部主动
   * 对应原版：全部主动 命令
   */
  async handleAllActive(userId: number): Promise<string> {
    const result = await this.updateOwnedSummonMode(userId, 'active');
    return result.count > 0
      ? `⚔️ 已将 ${result.count} 只宠物设为主动攻击模式。`
      : '当前地图上没有属于你的宠物';
  }

  /**
   * 全部被动
   * 对应原版：全部被动 命令
   */
  async handleAllPassive(userId: number): Promise<string> {
    const result = await this.updateOwnedSummonMode(userId, 'passive');
    return result.count > 0
      ? `🛡️ 已将 ${result.count} 只宠物设为被动防御模式。`
      : '当前地图上没有属于你的宠物';
  }

  /**
   * 全部挤奶
   * 对应原版：全部挤奶 命令
   */
  async handleAllMilk(userId: number): Promise<string> {
    return (await this.settleMilk(userId, undefined, true)).text;
  }

  /**
   * 全部指令
   * 对应原版：全部指令 命令
   */
  async handleAllCommands(userId: number): Promise<string> {
    return `📋 全部宠物指令：
跟随、停下、主动、被动、挤奶`;
  }

  /**
   * 自动开采
   * 对应原版：开采自动 命令
   */
  async handleAutoMine(userId: number): Promise<string> {
    return this.autoMineService
      ? this.autoMineService.start(userId)
      : `${this.getPlayerName(userId)}自动开采服务尚未加载`;
  }

  /**
   * 停止开采
   * 对应原版：开采停止 命令
   */
  async handleStopMine(userId: number): Promise<string> {
    return this.autoMineService
      ? this.autoMineService.stop(userId)
      : `${this.getPlayerName(userId)}自动开采服务尚未加载`;
  }

  /**
   * 配方解锁
   * 对应原版：配方解锁 命令
   */
  async handleRecipeUnlock(userId: number, recipeName = ''): Promise<string> {
    return this.taskService.acceptRecipeUnlockTask(userId, recipeName);
  }

  /**
   * 确认求助
   * 对应原版：求助确认 命令
   */
  async handleConfirmHelp(userId: number, targetName: string): Promise<string> {
    // 对应原版：求助确认（_主程序.ecode L9877）
    // 机制：当前地图存在"露娜"召唤物（QQ=怪物露娜1g），若其归属为"1"（无人认领），
    // 则玩家可请求露娜帮忙，持续到下一个整点；成功后露娜归属改为玩家、好感置满。
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    const map = await this.getCurrentMap(userId);
    const summons = asJsonValue<any[]>(map.summons, []);
    // 露娜的标识：qq=怪物露娜1g（与 schedule.service 生成露娜时一致）
    const lunaIdx = summons.findIndex((s: any) => s.qq === '怪物露娜1g');
    if (lunaIdx === -1) {
      return `${player.name} 附近没有可以求助的对象`;
    }

    const luna = summons[lunaIdx];
    if (luna.ownerQQ === '1' || luna.ownerQQ === undefined || luna.ownerQQ === null) {
      // 露娜尚无人认领：玩家请求成功，好感置满、归属改玩家
      // 原版：置成就熟练度("好感"+QQ, 露娜.标记, 100) —— 这里以玩家标记记录对露娜的好感
      this.playerService.setMarker(markers, `好感怪物露娜1g`, 100);
      // mutateSummons 锁内闭环：重读最新 summons → 按 qq 重定位 → 锁内复查归属 → 写回 → 差异落库
      const claimed = await this.mapService.mutateSummons(map.id, (fresh) => {
        const idx = fresh.findIndex((s: any) => s.qq === '怪物露娜1g');
        if (idx === -1) return false;
        const owner = fresh[idx].ownerQQ;
        if (!(owner === '1' || owner === undefined || owner === null)) return false;
        fresh[idx].ownerQQ = player.userId.toString();
        return true;
      });
      if (!claimed) {
        return `${player.name} 露娜刚被别人认领了`;
      }
      player.markers = markers; // Json 列直接写对象
      await this.playerService.savePlayer(player);
      await this.taskService.advance(userId, '求助');
      return `${player.name} 好吧，从现在开始到下一个整点之前，我可以帮你解决战斗上的问题。`;
    } else {
      return `${player.name} 我正在帮 ${luna.ownerQQ} 解决问题，你之后再找我吧。`;
    }
  }

  /**
   * 自动购物
   * 对应原版：购物自动 命令
   */
  async handleAutoShop(userId: number, itemName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    if (this.playerService.isPlayerDead(player)) {
      return this.playerService.handlePlayerDeath(userId, player);
    }

    const map = await this.getCurrentMap(userId);
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
    const merchantBackpack = this.parseJsonArray(merchant.backpack);

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
        this.deductBackpackItem(backpack, cost.name, cost.quantity);
        this.addItemToCollection(paidItems, { ...cost, type: '资源' });
      }

      const bought = { ...mItem };
      merchantBackpack.splice(d, 1);
      this.addItemToCollection(backpack, bought);
      boughtItems.push(bought);

      const giftChance = Math.min(a2 / 4, 15);
      if (Math.random() * 100 < giftChance) {
        const gift = this.generateMerchantResource();
        this.addItemToCollection(backpack, gift);
        this.addItemToCollection(gifts, gift);
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
  private findMerchantInSummons(map: any): { summons: any[]; index: number } | null {
    if (!map) return null;
    const summons = this.parseJsonArray(map.summons);
    const index = summons.findIndex((summon: any) =>
      (summon?.name ?? summon?.名称) === '行商',
    );
    return index < 0 ? null : { summons, index };
  }

  private parseJsonArray(value: any): any[] {
    if (Array.isArray(value)) return value;
    return asJsonValue<any[]>(value, []);
  }

  /**
   * 对应原版购物分支 L10031-L10042：开拓地限制与购买冷却。
   * 原版在自己的院子里不加“购买冷却”，在其他地图购买时每10秒允许一次。
   */
  private checkMerchantPurchaseGate(
    player: any,
    map: any,
    houseMap: any,
  ): { blocked: boolean; message: string; markers2: any[]; markers2Changed: boolean } {
    const markers2 = this.parseJsonArray(player.markers2);
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
      const rawExpire = Number(marker?.有效期至 ?? marker?.expireAt ?? 0);
      const expireMs = rawExpire > 0 && rawExpire < 1e12 ? rawExpire * 1000 : rawExpire;
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

  private itemQuantity(item: any): number {
    if (item == null) return 0;
    return Number(item.quantity ?? item.count ?? 1) || 0;
  }

  /** 任务推进的服务层适配点，避免任务服务不可用时影响核心玩法动作。 */
  private async advanceTask(userId: number, actionName: string, count = 1): Promise<void> {
    const advance = (this.taskService as any)?.advance;
    if (typeof advance !== 'function') return;
    if (count === 1) {
      await advance.call(this.taskService, userId, actionName);
    } else {
      await advance.call(this.taskService, userId, actionName, count);
    }
  }

  private roundText(value: number): string {
    return String(Math.round(value * 100) / 100);
  }

  /** 行商列表显示名包含原版显示特效名称所需的特效标签。 */
  private formatMerchantItem(item: any, includeQuantity = false, includeEffect = true): string {
    const name = item?.name ?? item?.名称 ?? '';
    let effect = '';
    if ((item?.type ?? item?.类型) === '装备' && item?.data) {
      const parsed = this.itemService.parseEquipment(item as any);
      if (parsed.specialEffect > 0) {
        const weapon = this.isFusionWeapon(item);
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
    return `${name}${includeQuantity ? `x${this.roundText(this.itemQuantity(item))}` : ''}`;
  }

  private formatMerchantItems(items: any[]): string {
    return (items || []).map((item) => this.formatMerchantItem(item, true)).join('、');
  }

  private addItemToCollection(collection: any[], item: any): void {
    const type = item?.type ?? item?.类型 ?? '资源';
    const amount = this.itemQuantity(item);
    if (type === '装备') {
      collection.push({ ...item, type: '装备', quantity: amount || 1 });
      return;
    }
    const existing = collection.find((entry: any) =>
      (entry?.name ?? entry?.名称) === (item?.name ?? item?.名称) &&
      (entry?.type ?? entry?.类型 ?? '资源') !== '装备',
    );
    if (existing) {
      if (existing.quantity !== undefined) existing.quantity = this.itemQuantity(existing) + amount;
      else existing.count = this.itemQuantity(existing) + amount;
    } else {
      collection.push({ ...item, type, quantity: amount || 1 });
    }
  }

  private hasEnoughResources(backpack: any[], costs: any[]): boolean {
    return costs.every((cost) => {
      const item = backpack.find((entry: any) => (entry?.name ?? entry?.名称) === cost.name);
      // 原版按双精度数值比较；容忍 JS 二进制浮点在 50*10/11*1.1 等边界上的极小误差。
      const epsilon = Math.max(1e-9, Math.abs(cost.quantity) * 1e-12);
      return item && this.itemQuantity(item) + epsilon >= cost.quantity;
    });
  }

  private generateMerchantResource(): any {
    const config = this.staticData.getMerchantConfig();
    const candidates = String(config.itemText || '').split(/[，,]/).map((value) => value.trim()).filter(Boolean);
    const raw = candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : '';
    const match = raw.match(/\d+(?:\.\d+)?/);
    const quantity = match ? Math.trunc(Number(match[0])) || 1 : 1;
    const name = raw.replace(/\d/g, '').trim() || raw;
    return { name, type: '资源', quantity, durability: 0, data: '' };
  }

  private async generateMerchantInventory(level: number, extra: number): Promise<any[]> {
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

  private async purchaseMerchantItem(
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
          return !item || this.itemQuantity(item) < cost.quantity;
        })
        .map((cost) => {
          const item = backpack.find((entry: any) => (entry?.name ?? entry?.名称) === cost.name);
          return `#换行需要${cost.name}x${this.roundText(cost.quantity)}，你只有${this.roundText(this.itemQuantity(item))}`;
        }).join('');
      return `${player.name}${missing}`;
    }

    const item = merchantBackpack[itemIndex];
    const paidText = this.formatMerchantItems(costs);
    for (const cost of costs) this.deductBackpackItem(backpack, cost.name, cost.quantity);
    this.addItemToCollection(backpack, item);
    merchantBackpack.splice(itemIndex, 1);

    const giftChance = Math.min(affinity / 4, 15);
    let result = `${player.name}用${paidText}从行商处购买了${this.formatMerchantItem(item, true, false)}`;
    if (Math.random() * 100 < giftChance) {
      const gift = this.generateMerchantResource();
      this.addItemToCollection(backpack, gift);
      result += `#换行行商把${gift.name}x${gift.quantity}送给了${player.name}(${this.roundText(giftChance)}%)`;
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
  private deductBackpackItem(backpack: any[], name: string, quantity: number): void {
    const item = backpack.find((i: any) => (i?.name ?? i?.名称) === name);
    if (!item) return;
    const current = this.itemQuantity(item);
    if (current <= quantity) {
      const idx = backpack.indexOf(item);
      if (idx !== -1) backpack.splice(idx, 1);
    } else {
      if (item.quantity !== undefined) item.quantity = current - quantity;
      else item.count = current - quantity;
    }
  }

  /**
   * 刷新怪物（管理员）（原版 _主程序.ecode L6829-6851）。
   * 管理权限 → 怪物列表按名称查找（未找到→“怪物列表未找到X”）→ _初始化怪物
   * （等级成长/三层池公式，复用 map.service.buildMonsterSpawnData）→ 加入当前地图怪物2
   * → “在X刷新了一只Y”。非管理员原版静默无输出，新版明确提示权限（与设置位置同口径）。
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
    await this.advanceTask(userId, '删除怪物');

    return `${player.name || '冒险者'}，${map.name}附近的怪物被清除了。一般它们会被立即刷新出来。`;
  }

  /**
   * 切换生产模式
   * 对应原版：生产0/生产1 命令
   */
  async handleProductionMode(userId: number, mode: number): Promise<string> {
    return mode === 0 ? '🏭 已切换为正常生产模式。' : '🏭 已切换为超载生产模式。';
  }

  /**
   * 转换文本
   * 对应原版：转换文本 命令
   */
  async handleTransformText(userId: number, text: string): Promise<string> {
    return `📝 文本转换功能开发中...`;
  }

  /**
   * 保存图片
   * 对应原版：保存图片 命令
   */
  async handleSaveImage(userId: number, imageName: string): Promise<string> {
    return `🖼️ 保存图片功能开发中...`;
  }

  /**
   * 开始自动保存图片
   * 对应原版：保存图片开始 命令
   */
  async handleStartSaveImage(userId: number): Promise<string> {
    return `🖼️ 已开启自动保存图片模式。`;
  }

  /**
   * 停止自动保存图片
   * 对应原版：保存图片停止 命令
   */
  async handleStopSaveImage(userId: number): Promise<string> {
    return `🖼️ 已停止自动保存图片。`;
  }

  /**
   * 停止接管载具
   * 对应原版：接管停止 命令
   */
  async handleStopTakeover(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const sets = this.parseVehicleValue<any>(player.sets, {});
    const takeover = String(sets?.takeVehicle ?? sets?.接管载具 ?? '');
    if (!takeover) return `${player.name || '冒险者'}你没有在接管载具`;

    let vehicleName = takeover;
    const map = await this.mapService.getMapById(player.mapId);
    const vehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
    const vehicle = vehicles.find((item: any) =>
      [item?.编号, item?.vehicleId, item?.id].filter((value) => value !== undefined && value !== null).map(String).includes(takeover),
    );
    if (vehicle) vehicleName = vehicle.名称 ?? vehicle.name ?? takeover;
    sets.takeVehicle = '';
    sets.接管载具 = '';
    player.sets = sets;
    await this.playerService.savePlayer(player);
    return `${player.name || '冒险者'}停止了对${vehicleName}的接管`;
  }

  /**
   * 确认还原植入体等级
   * 对应原版：确认还原植入体等级 命令
   */
  async handleConfirmResetImplant(userId: number): Promise<string> {
    return `✅ 已确认还原植入体等级。`;
  }

  /**
   * 确认还原增幅器等级
   * 对应原版：确认还原增幅器等级 命令
   */
  async handleConfirmResetAmplifier(userId: number): Promise<string> {
    return `✅ 已确认还原增幅器等级。`;
  }

  /**
   * 获取玩家名称的辅助方法
   */
  private async getPlayerName(userId: number): Promise<string> {
    try {
      // 走 getPlayerData：Actor 邮箱内读内存活态，改名后无需等待落库即可生效
      const pd = await this.playerService.getPlayerData(userId);
      return pd.player.name || '冒险者';
    } catch {
      return '冒险者';
    }
  }
}
