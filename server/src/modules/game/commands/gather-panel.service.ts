/**
 * 场景资源/面板指令域服务（game 模块化重构 P3-6b 内核聚类 B，策略 B）
 *
 * 职责：玩家/地图面板渲染与推送（pushPlayerUpdate/pushMapUpdate 及 300ms 防抖、
 * rev 单调计数——推送子系统整簇随本服务迁移，C7）、信息/状态/环视/查看玩家、
 * 采集/开采/探测/拾取/自动开采全链路、资源解析与展示、背包/仓库/物品使用/
 * 标记查看。panel↔gather↔inventory 双向边最强，合并后依赖图无环。
 * 依赖方向：依赖 Player、Map、Prisma、CombatState、CombatSystem、StaticData、
 * Bonus、Item、ItemSystem、Vitality、Stats、Task、Shortcut、Achievement、Chat、
 * FamiliarService、FamiliarSystemService、AutoMineService、DelayedTaskService
 * 与支撑层；跨簇调用（movement-vehicle 域 findTravelVehicle、rescue 域
 * materializeWhiteSummon）直接注入兄弟子服务——movement↔panel 为真实互调，
 * forwardRef 断 DI 环（§4 原则 4）。
 * 单一真相源：推送版本统一 nextRev 单调计数；增益标记统一 normalizeMarkers2；
 * 采集指令解析统一 resolveGatherCmd（支撑层）。
 * 对口原版：_主程序.ecode 面板/采集/背包分支。
 *
 * 状态字段（§4.1 归属表，随本批迁出，G8 白名单自此清空）：
 * gatherStartInflight（采集并发去重）、playerUpdateTimers/mapUpdateTimers（推送防抖）、
 * revCounters（推送版本单调计数）。
 */import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { formatDisplayNumber, normalizeGameText, roundItemQuantity } from '../../../common/utils/game-text.util';
import { lookupFromStaticData, mergeBackpackItem } from '.././item-normalize.util';
import { equipmentQualityLabel } from '.././equipment-ref.util';
import { filterActive, formatRemain, remainSeconds, toExpireMs } from '.././expire-time.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlayerService } from '.././player.service';
import { BonusData, BonusService } from '.././bonus.service';
import { CombatSystemService } from '.././combat-system.service';
import { ItemService } from '.././item.service';
import { MapService } from '.././map.service';
import { FamiliarService } from '.././familiar.service';
import { AchievementService } from '.././achievement.service';
import { ItemSystemService } from '.././item-system.service';
import { HomeService } from '.././home.service';
import { FamiliarSystemService } from '.././familiar-system.service';
import { StaticDataService } from '.././static-data.service';
import { ChatService } from '../../chat/chat.service';
import { TaskService } from '.././task.service';
import { ShortcutService } from '.././shortcut.service';
import { StatsService } from '.././stats.service';
import { CombatStateService } from '.././combat-state.service';
import { AutoMineService } from '.././auto-mine.service';
import { VitalityService } from '.././vitality.service';
import { DelayedTaskService } from '.././delayed-task.service';
import { GameSupportService } from '.././game-support.service';
import { MovementVehicleService } from './movement-vehicle.service';
import { RescueWhiteService } from './rescue-white.service';

@Injectable()
export class GatherPanelService {
  private readonly logger = new Logger(GatherPanelService.name);

  constructor(
    private readonly support: GameSupportService,
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly bonusService: BonusService,
    private readonly combatSystem: CombatSystemService,
    private readonly itemService: ItemService,
    private readonly mapService: MapService,
    private readonly familiarService: FamiliarService,
    private readonly achievementService: AchievementService,
    private readonly itemSystemService: ItemSystemService,
    private readonly homeService: HomeService,
    private readonly familiarSystemService: FamiliarSystemService,
    private readonly staticData: StaticDataService,
    private readonly chatService: ChatService,
    private readonly taskService: TaskService,
    private readonly shortcutService: ShortcutService,
    private readonly statsService: StatsService,
    private readonly combatState: CombatStateService,
    // 跨域兄弟直连（P4 清理：原过渡期经门面引用）。movement↔panel 互调边用 forwardRef 断环；
    // rescue 处于模块循环导入 SCC（gather↔movement↔home↔rescue）内，同样必须 forwardRef。
    @Inject(forwardRef(() => MovementVehicleService))
    private readonly movement: MovementVehicleService,
    @Inject(forwardRef(() => RescueWhiteService))
    private readonly rescue: RescueWhiteService,
    @Optional() private readonly autoMineService?: AutoMineService,
    @Optional() private readonly vitalityService?: VitalityService,
    @Optional() private readonly delayedTaskService?: DelayedTaskService,
  ) {}

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
      pendingActions: this.buildPendingActions(player, markers, playerData.markers2, playerData.buffs),
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
   *   - 卷土重来：buffs 中 name=卷土重来（倒地免死保护，到期即真死）
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
   * @param buffs 已解析的增益数组（卷土重来免死保护倒计时）
   * @returns 进行中操作列表（按结束时间升序，通常只有 1 条）
   */

  buildPendingActions(
    player: any,
    markers: any,
    markers2: any,
    buffs?: any,
  ): Array<{ key: string; kind: string; label: string; detail: string; icon: string; startedAt: number; endAt: number; totalMs: number }> {
    const now = Date.now();
    const list: Array<any> = [];

    /** 历史数据里 expireAt 有秒/毫秒两种口径：统一走 expire-time.util 归一（秒/毫秒启发式单一真相源）。 */
    const toEndMs = (raw: any): number => toExpireMs({ expireAt: raw });

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
      } else if (name === '攻击冷却') {
        // 公共攻击冷却（原版 战斗相关.ecode L93-107 / L4601-4605 检查）：期间所有武器都无法出手
        push({ key: 'attack-cd', kind: 'cooldown', label: '攻击冷却', detail: '无法攻击', icon: '⚔️', endAt: endMs, startedAt: markStart, totalMs: markTotal });
      } else if (name.endsWith('冷却')) {
        // 单武器冷却（原版 _主程序.ecode L904 `${武器名}冷却`）：标注是哪把武器在转CD。
        // 这些标记只挂在攻击者自己的 markers2 上（被击方的「被寒风冷却」等在对方身上），天然不会串人。
        push({ key: `cd:${name}`, kind: 'cooldown', label: name.replace(/冷却$/, ''), detail: '武器冷却中', icon: '⚔️', endAt: endMs, startedAt: markStart, totalMs: markTotal });
      } else if (name === '麻痹') {
        push({ key: 'paralysis', kind: 'debuff', label: '麻痹中', detail: '无法行动', icon: '⚡', endAt: endMs, startedAt: markStart, totalMs: markTotal });
      }
    }

    // ===== 4) buffs 增益：卷土重来（倒地免死保护，到期即真死）=====
    // 写入处：怪物反击 / 反伤致死的死亡级联（combat-system），以及原版 获得增益("卷土重来")。
    // 存量格式两套并存：英文 { name, expireAt=秒 } 与归一化中文 { 名称, 有效期至=毫秒 }，
    // 与全文件 toEndMs 口径一致地兼容读取。同名多条时只保留结束时间最晚的一条，避免前端 key 冲突。
    const buffList = Array.isArray(buffs)
      ? buffs
      : asJsonValue<any[]>(player?.buffs, []);
    let comebackEndMs = 0;
    for (const b of buffList) {
      if (!b || typeof b !== 'object') continue;
      if (String(b?.name ?? b?.名称 ?? '') !== '卷土重来') continue;
      const endMs = toEndMs(b?.expireAt ?? b?.有效期至);
      if (endMs > comebackEndMs) comebackEndMs = endMs;
    }
    if (comebackEndMs > 0) {
      push({
        key: 'comeback',
        kind: 'comeback',
        label: '卷土重来',
        detail: '免死保护中，倒地仍可行动',
        icon: '🔄',
        endAt: comebackEndMs,
        // 增益落盘不带 startedAt/时长，totalMs=0 → 前端按首次观测剩余时间起算（与麻痹同策略）
      });
    }

    return list.sort((a: any, b: any) => a.endAt - b.endAt);
  }

  /**
   * 当前任务快照（网页「我的」面板用）：仅保留未完成任务的名字与进度计数，
   * 结构对齐 handleInfo 文本面板的任务段（字符串条目 / name|title 对象均兼容）。
   */

  buildActiveTasks(rawTasks: any): Array<{ name: string; count?: number }> {
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

  buildEquipmentSnapshot(player: any, markers: any): Array<{
    slot: string; name: string | null; quality: string; effect: number; enhance: number; enhanceRate: number; attrs: string; no: number | null;
    weapons?: Array<{ slot: string; name: string; quality: string; effect: number; enhance: number; enhanceRate: number; attrs: string; no: number | null }>;
  }> {
    // 品质展示标签：大写品质码（S/A/B…），与背包显示名同口径，单一实现见 equipment-ref.util。
    // 2026-09-10 用户约定：装备栏评级不再显示中文品质名（传说/史诗…），
    // 玩家可直接和背包里的「冰雹S」对照，不必再脑内换算 S 是不是传说。
    const equipmentList = asJsonValue<any[]>(player.equipment, []);
    const weaponList = asJsonValue<any[]>(player.weapons, []);
    const currentWeaponIdx = Number(player.currentWeapon ?? 0);
    // 已装备序号（卸下编号口径单一实现）：每格带 no，前端武器列表「卸下」按钮直接发「卸下 no」，
    // 与「信息」文本面板 / unequipItem 纯数字分支三处同源，禁各自重算。
    const equipped = this.itemService.buildEquippedList(player);
    const noOf = (kind: 'equip' | 'weapon', slot: string, arrIndex: number): number | null =>
      equipped.find((e) => e.kind === kind && e.slot === slot && (kind === 'weapon' ? e.weaponIndex === arrIndex : e.equipIndex === arrIndex))?.no ?? null;

    const entryOf = (slot: string, item: any, enhanceKey: string, no: number | null = null) => {
      const enhanceLv = this.combatState.getAchievementProficiency(markers, enhanceKey);
      if (!item) return { slot, name: null, quality: '', effect: 0, enhance: enhanceLv, enhanceRate: 0, attrs: '', no: null };
      const rawData = String(item.data || item.数据 || '');
      let effectNum = Number(item.effect || item.特效 || 0);
      if (!effectNum && rawData) {
        const bxMatch = rawData.match(/!bx(\d+)/);
        if (bxMatch) effectNum = parseInt(bxMatch[1], 10) || 0;
      }
      // 逐件属性（**强化后**口径 + 行尾 `(+x.xx)` 增量标注）：单一实现
      // itemSystemService.formatReinforcedEquipAttrs（与战斗链 calcEquipReinforce 同源）。
      // 2026-09-10 修复：此前只读 parseEquipment 原始值，从不强化 → 玩家「强化武器」后
      // 武器详情属性行完全不变，误判强化未生效（实测 +0 / +2 两组属性一模一样）。
      let attrs = '';
      let enhanceRate = 0;
      if (rawData) {
        const shown = this.itemSystemService.formatReinforcedEquipAttrs(item, markers);
        attrs = shown.text;
        enhanceRate = shown.coefficient;
      }
      return {
        slot,
        name: String(item.name || item.名称 || '未知'),
        quality: equipmentQualityLabel(rawData),
        effect: effectNum,
        enhance: enhanceLv,
        // 强化系数百分比（系数 a1 × 100，两位小数）：面板「强化 +2（系数 +1%）」用，
        // 等级取整后增益不可见时，玩家仍能读出实际收益
        enhanceRate: Math.round(enhanceRate * 10000) / 100,
        attrs,
        no,
      };
    };

    const getEquipType = (item: any): string => {
      const def = this.staticData.getEquipmentByName(item.name);
      return String(def?.equipType ?? def?.type ?? def?.类型 ?? item.type ?? item.类型 ?? '');
    };
    const slotNames = ['头部', '饰品', '肩膀', '上身', '背部', '手臂', '手掌', '腰部', '下身', '腿环', '腿部', '脚部'];
    const result = slotNames.map((slotName) => {
      const eqIdx = equipmentList.findIndex((e: any) => getEquipType(e) === slotName);
      return entryOf(
        slotName,
        eqIdx >= 0 ? equipmentList[eqIdx] : null,
        slotName + '强化',
        eqIdx >= 0 ? noOf('equip', slotName, eqIdx) : null,
      );
    });
    // 武器格（15 格之一：手持那把，空手回拳头占位；位置保持原顺序在植入之前）
    const heldIdx = currentWeaponIdx - 1;
    const weaponCell = entryOf('武器', heldIdx >= 0 && weaponList[heldIdx] ? weaponList[heldIdx] : null, '武器强化',
      heldIdx >= 0 && weaponList[heldIdx] ? noOf('weapon', '武器', heldIdx) : null);
    result.push(weaponCell);
    // 植入体 / 增幅器
    // 强化等级存放于 markers['植入体等级'] / markers['增幅器等级']（写入侧：item-system.service.ts upgradeImplant/upgradeAmplifier）
    const implantIdx = equipmentList.findIndex((e: any) => {
      const def = this.staticData.getEquipmentByName(e.name);
      return def?.equipType === '植入体' || def?.type === '植入体';
    });
    result.push(entryOf('植入', implantIdx >= 0 ? equipmentList[implantIdx] : null, '植入体等级',
      implantIdx >= 0 ? noOf('equip', '植入', implantIdx) : null));
    const ampIdx = equipmentList.findIndex((e: any) => {
      const def = this.staticData.getEquipmentByName(e.name);
      return def?.equipType === '增幅器' || def?.type === '增幅器';
    });
    result.push(entryOf('增幅', ampIdx >= 0 ? equipmentList[ampIdx] : null, '增幅器等级',
      ampIdx >= 0 ? noOf('equip', '增幅', ampIdx) : null));
    // 全部武器详情（手持 + 背上备用），挂「武器」格 weapons 子字段：
    // 2026-09-09 用户约定：左栏装备栏**固定 15 格不变**（背上武器不展开为独立格），
    // 前端单击「武器」格时展开该列表逐件展示详情 + 卸下按钮（按序号发「卸下 no」，
    // no 与「信息」文本面板 / unequipItem 编号分支三处同源）。列表顺序：手持在前，其余按 weapons[] 序。
    const weaponDetails: Array<{ slot: string; name: string; quality: string; effect: number; enhance: number; enhanceRate: number; attrs: string; no: number | null }> = [];
    const weaponDetailOf = (slot: string, item: any, no: number | null) => {
      const cell = entryOf(slot, item, '武器强化', no);
      weaponDetails.push({ slot, name: cell.name ?? '', quality: cell.quality, effect: cell.effect, enhance: cell.enhance, enhanceRate: cell.enhanceRate, attrs: cell.attrs, no });
    };
    // 背上武器按 weapons[] 序；手持插到最前（列表顺序约定：手持在前）
    for (let i = 0; i < weaponList.length; i++) {
      if (!weaponList[i] || i + 1 === currentWeaponIdx) continue;
      weaponDetailOf('背上', weaponList[i], noOf('weapon', '背上', i));
    }
    if (heldIdx >= 0 && weaponList[heldIdx]) {
      const no = noOf('weapon', '武器', heldIdx);
      const cell = entryOf('武器', weaponList[heldIdx], '武器强化', no);
      weaponDetails.unshift({ slot: '武器', name: cell.name ?? '', quality: cell.quality, effect: cell.effect, enhance: cell.enhance, enhanceRate: cell.enhanceRate, attrs: cell.attrs, no });
    }
    (weaponCell as any).weapons = weaponDetails;
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

  formatBuffList(rawBuffs: any): string[] {
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

  buildActiveBuffs(rawBuffs: any): Array<{ name: string; expireAt: number }> {
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


  async doPushPlayerUpdate(userId: number): Promise<void> {
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


  async doPushMapUpdate(userId: number): Promise<void> {
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

  nextRev(key: string): number {
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

    // 已装备列表（卸下编号口径单一实现 itemService.buildEquippedList）：已装备行渲染「N.」前缀，
    // 与「卸下 N」指令序号对号；空槽位不入列不占号（玩家看到的每个序号都对应一件可操作装备）。
    // 网页快照 buildEquipmentSnapshot 同源锚定本列表（每格带 no），三处口径禁各自重算。
    const equipped = this.itemService.buildEquippedList(player);
    const noOf = (kind: 'equip' | 'weapon', slot: string, arrIndex: number): number =>
      equipped.find((e) => e.kind === kind && e.slot === slot && (kind === 'weapon' ? e.weaponIndex === arrIndex : e.equipIndex === arrIndex))?.no ?? 0;

    // 品质标签 = 大写品质码（S/A/B…，equipment-ref.util 单一实现），与网页快照同口径。
    // 2026-09-10 用户约定：装备栏评级显示品质码字母，直接对应背包显示名「冰雹S」。
    // 此处曾内联一份中文品质 map（与 buildEquipmentSnapshot 各抄一份 = 双重表示），已收敛。
    // 有码才加「S 」前缀；裸条目装备（无 data）不加前缀，避免拼出「  防弹头盔」双空格。
    const withQuality = (label: string, name: string): string => (label ? `${label} ${name}` : name);

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
        const qName = equipmentQualityLabel(eq.data || eq.数据 || '');
        const fx = eq.effect || eq.特效 || 0;
        const fxStr = fx > 0 ? `[特效${fx}]` : '';
        const enhanceLv = this.combatState.getAchievementProficiency(markers, slotName + '强化');
        const no = noOf('equip', slotName, eqIdx);
        lines.push(`  ${no}.${slotName}: ${withQuality(qName, `${eq.name || eq.名称 || '未知'}${fxStr}`)}(+${enhanceLv})`);
      } else {
        const enhanceLv = this.combatState.getAchievementProficiency(markers, slotName + '强化');
        lines.push(`  ${slotName}: 无(+${enhanceLv})`);
      }
    }

    // 武器栏（L2160-2168）
    if (currentWeaponIdx > 0 && weaponList[currentWeaponIdx - 1]) {
      const w = weaponList[currentWeaponIdx - 1];
      const qName = equipmentQualityLabel(w.data || w.数据 || '');
      const fx = w.effect || w.特效 || 0;
      const fxStr = fx > 0 ? `[特效${fx}]` : '';
      const enhanceLv = this.combatState.getAchievementProficiency(markers, '武器强化');
      const no = noOf('weapon', '武器', currentWeaponIdx - 1);
      lines.push(`  ${no}.武器: ${withQuality(qName, `${w.name || w.名称 || '拳头'}${fxStr}`)}(+${enhanceLv})`);
    } else {
      // 空手占位：拳头不是一件有品质的装备，不带品质码前缀（前端以「拳头」判定为未装备）
      const enhanceLv = this.combatState.getAchievementProficiency(markers, '武器强化');
      lines.push(`  武器: 拳头(+${enhanceLv})`);
    }

    // 植入体（L2170-2179）
    // 强化等级：markers['植入体等级']（写入侧 item-system.service.ts upgradeImplant）。
    // 原版此处不显示等级，为与网页左面板 buildEquipmentSnapshot 同口径，统一补上 (+N)。
    const implantIdx = equipmentList.findIndex((e: any) => getEquipType(e) === '植入体');
    const implantLv = this.combatState.getAchievementProficiency(markers, '植入体等级');
    if (implantIdx >= 0) {
      const im = equipmentList[implantIdx];
      const qName = equipmentQualityLabel(im.data || im.数据 || '');
      const no = noOf('equip', '植入', implantIdx);
      lines.push(`  ${no}.植入: ${withQuality(qName, im.name || im.名称 || '未知')}(+${implantLv})`);
    } else {
      lines.push(`  植入: 无(+${implantLv})`);
    }

    // 增幅器（L2180-2189）
    // 强化等级：markers['增幅器等级']（写入侧 item-system.service.ts upgradeAmplifier），同上统一口径。
    const ampIdx = equipmentList.findIndex((e: any) => getEquipType(e) === '增幅器');
    const ampLv = this.combatState.getAchievementProficiency(markers, '增幅器等级');
    if (ampIdx >= 0) {
      const am = equipmentList[ampIdx];
      const qName = equipmentQualityLabel(am.data || am.数据 || '');
      const no = noOf('equip', '增幅', ampIdx);
      lines.push(`  ${no}.增幅: ${withQuality(qName, am.name || am.名称 || '未知')}(+${ampLv})`);
    } else {
      lines.push(`  增幅: 无(+${ampLv})`);
    }

    // 背上备用武器（L2190-2209）；每件带序号，与「卸下 N」对号（同名武器也能精确卸到指定那把）
    let backupIdx = 0;
    for (let i = 0; i < weaponList.length; i++) {
      if (i + 1 !== currentWeaponIdx) {
        const w = weaponList[i];
        const qName = equipmentQualityLabel(w.data || w.数据 || '');
        const fx = w.effect || w.特效 || 0;
        const fxStr = fx > 0 ? `[特效${fx}]` : '';
        const no = noOf('weapon', '背上', i);
        const label = withQuality(qName, `${w.name || w.名称 || '未知'}${fxStr}`);
        if (backupIdx === 0) {
          lines.push(`  ${no}.背上: ${label}`);
        } else {
          lines.push(`  ${no}.      ${label}`);
        }
        backupIdx++;
      }
    }

    // 卸下编号用法提示（有已装备项时才显示）
    if (equipped.length > 0) {
      lines.push(`💡 「卸下 序号」可精确卸下对应装备（如 卸下 ${equipped[0].no}）`);
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
   * 「背包」列表展示顺序（用户约定 2026-09-09）：资源/材料/消耗品在前、装备在后，
   * 组内保持背包原始顺序（稳定分区）。数字类指令（装备 N / 背包 N）的编号必须
   * 与本列表序号同源——单一实现，禁止散弹复制。
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
    // 兑现「开挖地基/建造地基」提示的承诺（观察附近可查看剩余次数）：
    // times>0 的资源标注剩余可采次数；times<0（无限，如医疗箱）不标。
    const timesLabel = (r: any): string => {
      const times = this.getResourceTimes(r);
      return times > 0 ? `(剩${times}次)` : '';
    };
    for (const r of resources) {
      const amount = r.amount ? ` ×${formatDisplayNumber(r.amount)}` : '';
      quickOptions.push({ label: `${r.name || '未知'}${amount}${timesLabel(r)}`, cmd: this.resolveGatherCmd(r) });
    }

    // 运行时资源2（对应原版 地图操作.ecode L862-893：观察附近列出产出2为空的地上资源——
    // 掉落货舱、家园院子的土堆/杂草等；作物/建筑产出2非空，走「查看作物」「查看建筑」）。
    // 教程文案（使魔大战.txt L3975）即要求玩家观察附近来发现院子里的杂草和土堆。
    const gatherPool = this.getGatherResources(map);
    // getGatherResources 在 map.resources 为空时回退到 resources2——此时采集可见集与
    // groundResources 同源，同源去重会把院子土堆/杂草全部误删（2026-09-09 巅峰阁事故）。
    // 去重仅在 resources 非空（采集可见集与 resources2 异源）时生效。
    const hasStaticResources = asJsonValue<any[]>(map.resources, []).length > 0;
    const groundResources = asJsonValue<any[]>(map.resources2, [])
      .filter((r: any) => !this.hasOutputs2(r)
        && this.getResourceTimes(r) !== 0
        && this.isGatherResourceAvailable(r, playerMarkers))
      // 采集链路（getGatherResources）在 resources 非空时只读 resources。
      // resources2 中与采集可见集同名的条目不再重复编号，避免出现
      //「列表里有、点下去采不到」的僵尸条目（2026-09-06 货舱/能量元素事故）。
      .filter((r: any) => !hasStaticResources || !gatherPool.some((g: any) =>
        String(g?.name ?? g?.名称 ?? '').trim() === String(r?.name ?? r?.名称 ?? '').trim()));
    for (const r of groundResources) {
      const amount = r.amount ? ` ×${formatDisplayNumber(r.amount)}` : '';
      quickOptions.push({ label: `${r.name || '未知'}${amount}${timesLabel(r)}`, cmd: this.resolveGatherCmd(r) });
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
      const menuLines = await this.support.buildNumberedMenu(userId, quickOptions, '💡 发送编号数字(如 1)即可前往/采集/对话');
      lines.push(...menuLines);
    }


    // ===== 对齐原版 地图操作.ecode L867-968：编号项之后的四个信息段 =====

    // 自动采集资源文本（原版 L867-919 自动采集分支：附近资源 + 每分钟自动产出预估）
    if (Number(playerMarkers['自动采集'] ?? 0) !== 0) {
      const autoTargets = asJsonValue<any[]>(map.resources, []).filter((r: any) =>
        this.getResourceTimes(r) > 0
        && (String(r?.marker ?? r?.标记 ?? '') === ''
          || Number(playerMarkers[String(r?.marker ?? r?.标记 ?? '')] ?? 0) < 1));
      if (autoTargets.length > 0) {
        let gatherBonus = 0;
        try {
          const bonus = this.combatSystem.buildAttackerBonus(player, playerData, map) as any;
          gatherBonus = Number(bonus?.采集 ?? 0);
        } catch { /* 加成缺失按0处理 */ }
        const perMinute = new Map<string, number>();
        for (const r of autoTargets) {
          for (const out of asJsonValue<any[]>(r?.outputs ?? r?.产出, [])) {
            const outName = String(out?.name ?? out?.名称 ?? '');
            const qty = Number(out?.count ?? out?.数量 ?? 0);
            const chance = Number(out?.chance ?? out?.几率 ?? 100);
            if (!outName || !(qty > 0)) continue;
            // 原版 L876-878：产出数量 × 属性.采集/2000 × 几率/100
            perMinute.set(outName, (perMinute.get(outName) || 0) + qty * gatherBonus / 2000 * chance / 100);
          }
        }
        const yieldText = [...perMinute.entries()]
          .map(([itemName, qty]) => `${itemName}x${formatDisplayNumber(qty)}`)
          .join('、');
        lines.push(`附近资源:${autoTargets.map((r: any) => String(r.name ?? r.名称 ?? '')).join('、')},自动采集每分钟:${yieldText}`);
      }
    }

    // 附近玩家（原版 L929-941：地图玩家列表 → “附近的玩家:”名称列表）
    try {
      const nearbyRows = await this.prisma.player.findMany({
        where: { mapId: player.mapId },
        select: { name: true, user: { select: { username: true, nickname: true } } },
      });
      const nearbyNames = nearbyRows
        .map((row: any) => String(row?.name || row?.user?.nickname || row?.user?.username || ''))
        .filter(Boolean);
      if (nearbyNames.length > 0) {
        lines.push(`附近的玩家:${nearbyNames.join('、')}`);
      }
    } catch { /* 玩家列表查询失败不影响观察附近 */ }

    // 当前地图增益（原版 L942-949：地图标记3 → “当前地图增益:名称(剩余时间)”）
    {
      const lookMarkers2 = asJsonValue<any[]>(map.markers2, []);
      const lookNow = Date.now();
      const buffTexts = lookMarkers2
        .map((entry: any) => ({
          name: String(entry?.name ?? entry?.名称 ?? ''),
          expireAt: Number(entry?.expireAt ?? entry?.有效期至 ?? 0),
        }))
        .filter((entry) => entry.name && !entry.name.startsWith('刷新资源') && entry.expireAt > lookNow)
        .map((entry) => `${entry.name}（${this.support.millisecondsToText(entry.expireAt - lookNow)}）`);
      if (buffTexts.length > 0) {
        lines.push(`当前地图增益:${buffTexts.join('、')}`);
      }
    }

    // 躺下经验（原版 L950-960：躺下中显示每秒经验明细，与躺下起床显示同口径）
    if (Number(playerMarkers['躺下'] ?? 0) === 1) {
      const lieDisplay = await this.summonFollowDisplay(map, userId, { requireFollow: false, countLimit: 2 });
      const lieCount = lieDisplay.count;
      const lieSummons = asJsonValue<any[]>(map.summons, []);
      const luo = lieSummons.find((s: any) => (s?.specialSeq ?? s?.special_seq ?? s?.seq) === -4);
      const expBonus = Number(player.expBonus ?? 0);
      const level = Number(player.level ?? 1);
      const lieLines = [
        `${lieCount > 0 ? `正在和${lieDisplay.names.join('、')}` : '正'}躺在床上`,
        `每秒获得经验:${this.support.round2Text(level / 100)}`,
        `你的经验加成:${this.support.round2Text(expBonus)}%`,
        `陪睡NPC/宠物:${lieCount}/2（+${lieCount * 50}%）`,
      ];
      if (luo) lieLines.push(`${luo.name ?? luo.名称 ?? '洛'}:+10%`);
      const finalPerSec = (1 + lieCount * 0.5) * level * (1 + expBonus / 100) / 100 * (1 + (luo ? 1 : 0) / 10);
      lieLines.push(`最终每秒获得:${this.support.round2Text(finalPerSec)}`);
      lines.push(...lieLines);
    }

    // 自动开采显示（原版 L961-968：自动开采/自动开采2 开始时间戳 → “已自动开采:时长”）
    for (const mineMode of ['自动开采', '自动开采2']) {
      const startedAt = Number(playerMarkers[mineMode] ?? 0);
      if (startedAt > 0) {
        const elapsedMs = Date.now() - startedAt * 1000;
        if (elapsedMs > 0) lines.push(`已自动开采:${this.support.millisecondsToText(elapsedMs)}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 处理查看宠物命令（对应原版 _主程序.ecode L5442）
   * 列出当前地图的召唤物/宠物/NPC，并按编号生成"查看<名称>"快捷，玩家发编号查看详情。
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
   * 超管特权「立即完成」共享实现：QQ 指令与 Web REST 静默端点（读条按钮）双入口，
   * 单一实现（统一调用约定）。结构化返回，调用方自行决定呈现——
   * QQ 取 message 作文本回包，Web 按 ok/message 弹 Toast。
   */

  getDistance(map1: any, map2: any): number {
    const connections1 = this.mapService.getConnections(map1);
    const conn = connections1.find((c: any) => c.name === map2.name);
    return conn ? (conn.distance || 50) : 50;
  }

  /** 计算原版“移动”成就使用的最短路径节点数（含起点和终点）。 */

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

  async handleLieDown(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const name = player.name || '冒险者';

    // 检查是否死亡
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

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
    text += `\n每秒获得经验:${this.support.round2Text(level / 100)}`;
    text += `\n你的经验加成:${this.support.round2Text(expBonus)}%`;
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
   *
   * 改造：
   * - 移除随机数、背景音乐、自动购物（已脱离用户可设置范围）
   * - 使用活力、自动采集改为管理员全局设置，用户侧只读展示
   * - 新手指引永远开启（用户侧不允许关闭）
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

  async mineByVehicle(userId: number): Promise<string> {
    return this.support.mutatePlayer(userId, async (ctx) => {
      const { player } = ctx;
        { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }
      const map = await this.mapService.getMapById(player.mapId);
      if (!map) return '你不在任何地图上！';

      // 取载具（原版 L7494-7499）
      const vehicle = await this.movement.findTravelVehicle(player, map);
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
      this.support.normalizeMarkers2(markers2);
      this.combatState.addMarker('工作', 60, markers2, Date.now());

      // 玩家活跃（原版 L7530 玩家活跃：地图活动窗口120秒 + 玩家战斗标记15秒）
      // 无隐形模块时先延时5秒引怪（原版 L7527-7529 新建延时"覅攻击pd"+地图, 5秒）。
      const hasStealthModule = partNames.includes('隐形模块');
      if (!hasStealthModule) {
        // 原版 L7527-7529：工作分支仅豁免隐形模块，不豁免隐匿模式
        await (this.combatSystem as any).triggerMapBattleLoop(userId, 5, { player, map }, { ignoreStealth: true });
      } else {
        const mapMarkers2 = asJsonValue<any[]>(map.markers2, []);
        this.combatState.gainBuff(mapMarkers2, '活动', 120, false, Date.now());
        map.markers2 = mapMarkers2; // 内存对象保持一致
        // 落库走按名合并（锁内重读）：本命令期间可能已有击杀登记「刷新怪物」标记，
        // 整组回写会把新标记抹掉 → 怪不再补。
        await this.mapService.mergeMapMarkers2(map.id, mapMarkers2);
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

  async mineResourcePoint(userId: number, resourceName: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers, markers2 } = playerData;

    // 检查是否死亡
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

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
      const expireMs = toExpireMs(cooldownEntry);
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
    this.support.addItemToCollection(backpack, { name: resourceDisplayName, type: '资源', quantity: amount });
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
    await this.support.advanceTask(userId, '开采');
    await this.support.advanceTask(userId, '采集资源', amount);
    const gatherCommand = targetResource.gatherCmd ?? targetResource.采集指令 ?? '';
    if (resourceName === '货舱' || gatherCommand === '打开货舱') {
      await this.support.advanceTask(userId, '打开货舱');
    } else {
      await this.support.advanceTask(userId, `采集${resourceDisplayName}`, amount);
    }

    // 原版“采集资源”在有跟随者协助时会把实际采集次数减一记为“奴役”。
    // 当前资源点一次结算的 amount 就是实际采集次数，保留首轮为0的原版边界。
    const enslaved = Math.max(0, Math.floor(amount) - 1);
    if (enslaved > 0) await this.support.advanceTask(userId, '奴役', enslaved);

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

  async settleManualMine(userId: number): Promise<void> {
    const text = await this.playerService.enqueueUserWrite(userId, async () => {
      const playerData = await this.playerService.getPlayerData(userId);
      const { player } = playerData;
      const map = await this.mapService.getMapById(player.mapId);
      if (!map) return '';

      // 载具/采集器重取（结算文本用；中途换载具时以当前载具为准）
      const vehicle = await this.movement.findTravelVehicle(player, map);
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
      // 装备单独记账：装备在上方循环里已按 generateRewardEquipment 生成入包（带词条），
      // 不得再进 awarded 走 addItemToCollection——那会再推一份无 data 的裸条目（重复发放）。
      const awardedEquipment = new Map<string, number>();
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
              amount *= 1 + this.support.randomInt(2500, 5000) / 10000; // 原版 L7562 行星解裂器随机增幅
            }
            if (amount <= 0) continue;
            const itemType = this.staticData.getEquipmentByName(out.name) ? '装备' : '资源';
            if (itemType === '装备') {
              const equipment = await this.itemSystemService.generateRewardEquipment(out.name, out.quality || '');
              this.addBackpackItem(backpack, { ...equipment, type: '装备', quantity: 1, count: 1 });
              awardedEquipment.set(out.name, (awardedEquipment.get(out.name) || 0) + 1);
            } else {
              awarded.set(out.name, (awarded.get(out.name) || 0) + amount);
            }
          }
        }
        // 次数-6（原版 L7571-7575；次数 -1 = 无限）
        const times = Number(resource?.times ?? resource?.次数 ?? -1);
        if (times !== -1 && times > 0) emptied.push(resource.name ?? resource.名称);
      }

      // 背包写回（数值过 roundItemQuantity 三道闸）；awarded 现只含资源，装备已在生成时入包
      for (const [itemName, amount] of awarded) {
        this.support.addItemToCollection(backpack, { name: itemName, type: '资源', quantity: amount });
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

      // 成就与任务（原版 L7549/L7602-7605）；装备沿用历史口径计入采集任务
      const totalAmount = [...awarded.values(), ...awardedEquipment.values()].reduce((sum, value) => sum + value, 0);
      await this.support.advanceTask(userId, '开采');
      await this.support.advanceTask(userId, '采集资源', totalAmount);
      for (const [itemName, amount] of awarded) {
        await this.support.advanceTask(userId, `采集${itemName}`, amount);
      }
      for (const [itemName, amount] of awardedEquipment) {
        await this.support.advanceTask(userId, `采集${itemName}`, amount);
      }
      const markers = asJsonValue<Record<string, any>>(player.markers, {});
      markers['采集熟练度'] = Number(markers['采集熟练度'] ?? 0) + 2 * followerFactor;
      player.markers = markers; // Json 列直接写对象
      await this.playerService.savePlayer(player);

      // 结算文本（原版 L7535-7542/L7595-7599）
      // 结算文本（原版 L7535-7542/L7595-7599）；装备按 件 计入（与手动采集块一致）
      const gainedText = [
        ...[...awarded.entries()].map(([name, amount]) => `${name}×${formatDisplayNumber(amount)}`),
        ...[...awardedEquipment.entries()].map(([name, amount]) => `${name}×${amount}`),
      ].join('、');
      const followText = display.count > 0 ? `带着${display.names.join('、')}一起` : '';
      let resultText = `${player.name ?? '冒险者'}${followText}用${collectorText}${gainedText || ''}`;
      if (!gainedText) resultText = `${player.name ?? '冒险者'}${map.name}的资源已经枯竭了`;
      // 无隐形模块时结算后再次引怪（原版 L7606-7608，仅隐形模块豁免，不豁免隐匿模式）
      if (!partNames.includes('隐形模块')) {
        try {
          await (this.combatSystem as any).triggerMapBattleLoop(userId, 5, { player, map }, { ignoreStealth: true });
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
  /** 跨子服务 API（§10.2）：MovementVehicle 经 DI 直连调用。 */

  collectVehiclePartNames(vehicle: any): string[] {
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
  /** 跨子服务 API（§10.2）：MovementVehicle/DelayedSettle 经 DI 直连调用。 */

  async summonFollowDisplay(
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
      const expireAt = toExpireMs(entry);
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

    // 超管特权「野外批量采集」：指令带数字后缀时实时查库 role（不信前端传值）；
    // 无数字后缀不发起查询，普通采集零额外开销。mutate 外查好传入闭包。
    const preParsed = this.parseGatherCommand(cmdName);
    const preCount = Math.max(1, Math.floor(Number.isFinite(requestedCount) ? requestedCount as number : preParsed.count));
    let userRole = '';
    if (preCount > 1) {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      userRole = user?.role ?? '';
    }

    // 采集开始是「读快照→改→写回」型操作，必须在用户级锁内完成，
    // 否则与定时器的采集结算并发会互相覆盖玩家数据（实测会偶发「并发冲突」）。
    // 走 mutate 收口：锁内单快照、统一落库（详见 docs/player-state-architecture.md）。
    return this.support.mutatePlayer(userId, async (ctx) => {
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
    // 超管特权扩展（2026-09-10）：ADMIN/SUPER_ADMIN 在任何地图批量后缀同样生效；
    // 耗时与产出线性同比放大（矿炮 30 秒封顶只封时长不封次数）。
    // 原版公式：a1 = 取随机数(3000×倍率, 6000×倍率) × d / 1000（毫秒→秒）
    const isOwnYard = player.houseName === map.name;
    const isAdmin = userRole === 'ADMIN' || userRole === 'SUPER_ADMIN';
    const extraMultiplier = (isOwnYard || isAdmin) ? Math.max(1, Math.floor(count)) : 1;
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
      count: extraMultiplier, adminBatch: !isOwnYard && isAdmin,
      startedAt: now, settleAt: now + cappedSeconds * 1000 };
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

  async applySettleGatherResource(userId: number): Promise<string> {
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
        await this.rescue.materializeWhiteSummon(player, map, markers);
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
    // e=跟随宠物数+1，再乘以额外次数；受资源剩余次数上限约束。
    // 有限资源(times>0)夹到剩余次数（共享世界态，超管特权同样受限）；
    // 无限资源(times<0)默认单次动作上限=|times|——超管野外批量（adminBatch）放开该上限。
    const followPetCount = await this.countFollowingSummons(map, userId);
    let actualGatherCount = (followPetCount + 1) * extraMultiplier;
    const resourceTimes = this.getResourceTimes(target);
    actualGatherCount = resourceTimes > 0
      ? Math.min(actualGatherCount, resourceTimes)
      : (gatherState.adminBatch
        ? actualGatherCount
        : Math.min(actualGatherCount, Math.abs(resourceTimes)));

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
        // 类型三分类（原版 地图操作.ecode L1583-1590）：装备生成词条；资源乘采集加成；
        // 其余（箱子等可使用功能物品，items.json 中带 useEffects 的条目）不乘加成——
        // 否则"良好装备补给箱×1.47"这类小数数量会入库（Issue #12-3）。
        const staticItem = typeof (this.staticData as any)?.getItemByName === 'function'
          ? (this.staticData as any).getItemByName(parsed.name)
          : undefined;
        const itemUseEffects = staticItem?.useEffects;
        const isUsableItem = Array.isArray(itemUseEffects)
          ? itemUseEffects.length > 0
          : Boolean(itemUseEffects);
        const itemType = this.staticData.getEquipmentByName(parsed.name)
          ? '装备'
          : isUsableItem
            ? '物品'
            : '资源';
        if (itemType === '装备') {
          const quality = parsed.quality || '';
          const equipment = await this.itemSystemService.generateRewardEquipment(parsed.name, quality);
          this.addBackpackItem(backpack, { ...equipment, type: '装备', quantity: 1, count: 1 });
          awardedEquipment.set(parsed.name, (awardedEquipment.get(parsed.name) || 0) + 1);
        } else {
          const amount = parsed.count > 0
            ? (itemType === '资源' ? parsed.count * this.getGatherMultiplier(playerData) : parsed.count)
            : Math.abs(parsed.count);
          if (amount > 0) awarded.set(parsed.name, (awarded.get(parsed.name) || 0) + amount);
        }
      }
    }
    for (const [itemName, amount] of awarded) {
      // 统一规范化合并（type 以静态定义为准，非装备按名合并，Issue #11）
      mergeBackpackItem(backpack, { name: itemName, type: '资源', count: amount, quantity: amount },
        lookupFromStaticData(this.staticData));
      gained.push(`${itemName}×${this.support.formatGatherNumber(amount)}`);
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

    // 代发言播报（原版 地图操作.ecode L1620-1621：代发言非空 → 新建延时(代发言+复活点, 2秒)）。
    // 代发言是资源配置的内部延时指令名：触发攻击已在上方激怒怪物路径处理，
    // 召唤1白1 已在采集入口内联召唤，其余（覅本清/覅下一层）按 2 秒延时排程执行并广播。
    {
      const proxySpeak = String(target.proxySpeak ?? target.代发言 ?? '');
      if (proxySpeak && proxySpeak !== '触发攻击' && proxySpeak !== '召唤1白1') {
        if (this.delayedTaskService) {
          await this.delayedTaskService.schedule({
            type: 'proxySpeak',
            userId,
            dedupeKey: `${userId}:${proxySpeak}`,
            runAt: Date.now() + 2 * 1000,
            payload: { command: proxySpeak },
          });
        }
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

  takePendingGather(
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

  clearStaleGatherLock(player: any, userId: number): void {
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

  async countFollowingSummons(map: any, userId: number): Promise<number> {
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

  getGatherExpBonus(playerData: any): number {
    try {
      const bonus = this.combatSystem.buildAttackerBonus(playerData.player, playerData) as any;
      return 1 + Math.max(0, Number(bonus?.经验 ?? 0)) / 100;
    } catch {
      return 1;
    }
  }

  /** 兼容新格式与早期错误导出的 resources JSON。 */
  /** 跨子服务 API（§10.2）：HomeBuild 经 DI 直连调用。 */

  parseResourceOutputs(value: any): any[] {
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

  /**
   * 解析资源的采集指令：条目自带 gatherCmd 优先，缺失时回退到全局资源列表的同名定义。
   *
   * 事故背景（2026-09-06）：定时任务掉落货舱/能量元素时只写入了 {name,type,amount}
   * 字面量，缺 gatherCmd；观察附近照样给它编了号，但 cmd 为空 → 编号不注册 →
   * 玩家发送编号后完全没有反应（连"未知指令"提示都没有）。
   * 这里做兜底：只要资源名能在全局资源表里找到，编号就一定点得动。
   */

  resolveGatherCmd(resource: any): string {
    return this.support.resolveGatherCmd(resource);
  }


  getGatherResources(map: any): any[] {
    const resources = asJsonValue<any[]>(map?.resources, []);
    if (resources.length > 0) return resources;
    return asJsonValue<any[]>(map?.resources2, []);
  }


  getGatherResourceField(map: any): 'resources' | 'resources2' {
    const resources = asJsonValue<any[]>(map?.resources, []);
    return resources.length > 0 ? 'resources' : 'resources2';
  }


  isGatherResourceAvailable(resource: any, markers: Record<string, any>): boolean {
    const marker = String(resource?.marker ?? resource?.标记 ?? '').trim();
    if (!marker) return true;
    return Number(markers[marker] ?? 0) < 1;
  }

  /** 获取玩家永久标记(markers)对象，用于资源采集门禁的"每人一次"判断。 */

  async getPlayerMarkers(userId: number): Promise<Record<string, any>> {
    try {
      const { player } = await this.playerService.getPlayerData(userId);
      return asJsonValue<Record<string, any>>(player?.markers, {});
    } catch {
      return {};
    }
  }

  /** 产出2（作物/建筑的生产产出）是否非空；产出2为空的资源2条目即地上的野生资源。 */

  hasOutputs2(resource: any): boolean {
    const raw = resource?.outputs2 ?? resource?.['产出2'];
    if (Array.isArray(raw)) return raw.length > 0;
    if (raw == null || raw === '') return false;
    const parsed = asJsonValue<any[]>(raw, []);
    return Array.isArray(parsed) && parsed.length > 0;
  }


  parseResourceOutputName(rawName: any, rawCount: number): { name: string; count: number; quality: string } {
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


  getResourceTimes(resource: any): number {
    const value = Number(resource?.times ?? resource?.次数 ?? -1);
    return Number.isFinite(value) ? value : -1;
  }


  parseGatherCommand(value: string): { name: string; count: number } {
    const input = String(value || '').trim();
    const match = input.match(/^(.*?)(\d+)$/);
    if (!match) return { name: input, count: 1 };
    return { name: match[1].trim(), count: Math.max(1, Number(match[2])) };
  }


  getGatherMultiplier(playerData: any): number {
    const bonus = this.combatSystem.buildAttackerBonus(playerData.player, playerData);
    return Math.max(0, Number(bonus.采集 || 100) / 100);
  }


  getGatherDropRate(playerData: any): number {
    const bonus = this.combatSystem.buildAttackerBonus(playerData.player, playerData);
    return Math.max(0, 1 + Number(bonus.掉落率 || 0) / 100);
  }


  async handleProbe(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查是否死亡
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

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
        lines.push(`  ${item.name} ×${formatDisplayNumber(count)}`);
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

  async handleProbeRadar(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

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

    // 原版 雷达扫描共十类目标（_主程序.ecode L3044-L3273）：
    // 副本入口/行商/神之工匠/露娜/小恶魔/废弃载具/花园宝宝/小白狐/货舱/能量元素。
    // 显示精度随雷达等级变化；获得物品() 按显示名合并数量，
    // 花园宝宝/小白狐/货舱/能量元素超过3条时只显示前三名+总数。
    const near = (map: any) => `${map.respawnPoint || map.name}附近`;
    const mergeEntries = (list: Array<{ name: string; count: number }>): [string, number][] => {
      const merged = new Map<string, number>();
      for (const e of list) merged.set(e.name, (merged.get(e.name) || 0) + e.count);
      return [...merged.entries()];
    };
    const formatEntries = (entries: [string, number][], topN = 0): string => {
      const sorted = [...entries].sort((a, b) => b[1] - a[1]);
      const shown = topN > 0 && sorted.length > topN ? sorted.slice(0, topN) : sorted;
      const body = shown.map(([n, c]) => `${n}x${c}`).join('、');
      if (topN > 0 && sorted.length > topN) {
        const total = sorted.reduce((s, [, c]) => s + c, 0);
        return `${body}…等共${total}`;
      }
      return body;
    };

    // ◆行商/花园宝宝/小白狐/露娜：召唤物（原版 L3065-L3079、L3136-L3203）
    const merchantEntries: Array<{ name: string; count: number }> = [];
    const gardenBabyEntries: Array<{ name: string; count: number }> = [];
    const whiteFoxEntries: Array<{ name: string; count: number }> = [];
    const lunaEntries: Array<{ name: string; count: number }> = [];
    // ◆神之工匠：NPC（原版 L3083-L3093，QQ=npc1g）
    const artisanEntries: Array<{ name: string; count: number }> = [];
    for (const map of maps) {
      const summons = asJsonValue<any[]>(map.summons, []);
      for (const s of summons) {
        const sName = String(s?.name ?? s?.名称 ?? '');
        if (sName === '行商') {
          merchantEntries.push({ name: level >= 5 ? map.name : near(map), count: 1 });
        } else if (sName === '花园宝宝') {
          gardenBabyEntries.push({ name: level >= 6 ? map.name : near(map), count: 1 });
        } else if (sName === '小白狐') {
          whiteFoxEntries.push({ name: level >= 6 ? map.name : near(map), count: 1 });
        } else if (sName === '露娜' || s?.qq === '怪物露娜1g') {
          lunaEntries.push({ name: near(map), count: 1 });
        }
      }
      const npcs = asJsonValue<any[]>(map.npcs, []);
      for (const n of npcs) {
        if (String(n?.name ?? n?.名称 ?? '') === '神之工匠' || n?.qq === 'npc1g') {
          artisanEntries.push({ name: near(map), count: 1 });
        }
      }
    }
    if (merchantEntries.length > 0) {
      w += `\n◆行商: ${formatEntries(mergeEntries(merchantEntries))}`;
    }
    if (artisanEntries.length > 0) {
      w += `\n◆神之工匠: ${formatEntries(mergeEntries(artisanEntries))}`;
    }
    if (lunaEntries.length > 0) {
      w += `\n◆露娜: ${formatEntries(mergeEntries(lunaEntries))}`;
    }

    // ◆小恶魔：临时怪物表（原版 怪物2，QQ=怪物小恶魔1，恒显示复活点附近）
    const demonEntries: Array<{ name: string; count: number }> = [];
    try {
      const demons = await this.prisma.gameMonster.findMany({
        where: { qq: '怪物小恶魔1', hp: { gt: 0 } },
        select: { mapId: true },
      });
      const mapById = new Map<number, any>((maps as any[]).map((m: any) => [Number(m.id), m]));
      const demonCountByMap = new Map<number, number>();
      for (const d of demons) {
        demonCountByMap.set(d.mapId, (demonCountByMap.get(d.mapId) || 0) + 1);
      }
      for (const [mapId, count] of demonCountByMap) {
        const map = mapById.get(mapId);
        if (map) demonEntries.push({ name: near(map), count });
      }
    } catch {
      // 临时怪物表不可用时跳过小恶魔扫描，不影响其他雷达目标
    }
    if (demonEntries.length > 0) {
      w += `\n◆小恶魔: ${formatEntries(mergeEntries(demonEntries))}`;
    }

    // ◆废弃载具：无主载具（原版 L3122-L3133，恒显示复活点附近）
    const wreckEntries: Array<{ name: string; count: number }> = [];
    for (const map of maps) {
      const vehicles = asJsonValue<any[]>(map.vehicles, []);
      const wreckCount = vehicles.filter(
        (v: any) => String(v?.owner ?? v?.归属 ?? '') === '无主',
      ).length;
      if (wreckCount > 0) wreckEntries.push({ name: near(map), count: wreckCount });
    }
    if (wreckEntries.length > 0) {
      w += `\n◆废弃载具: ${formatEntries(mergeEntries(wreckEntries))}`;
    }

    if (gardenBabyEntries.length > 0) {
      w += `\n◆花园宝宝: ${formatEntries(mergeEntries(gardenBabyEntries), 3)}`;
    }
    if (whiteFoxEntries.length > 0) {
      w += `\n◆小白狐: ${formatEntries(mergeEntries(whiteFoxEntries), 3)}`;
    }

    // ◆货舱 / ◆能量元素：扫描所有地图资源中名称匹配的资源（对应原版 L3205-L3251）
    const cargoEntries: Array<{ name: string; count: number }> = [];
    const energyEntries: Array<{ name: string; count: number }> = [];
    for (const map of maps) {
      const resources = asJsonValue<any[]>(map.resources, []);
      for (const res of resources) {
        const resName = res?.name || '';
        if (resName.includes('货舱')) {
          cargoEntries.push({ name: level === 0 ? near(map) : map.name, count: Number(res.times) || 1 });
        } else if (resName.includes('能量元素')) {
          energyEntries.push({ name: level <= 1 ? near(map) : map.name, count: Number(res.times) || 1 });
        }
      }
    }
    if (cargoEntries.length > 0) {
      w += `\n◆货舱: ${formatEntries(mergeEntries(cargoEntries), 3)}`;
    }
    if (energyEntries.length > 0) {
      w += `\n◆能量元素: ${formatEntries(mergeEntries(energyEntries), 3)}`;
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
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

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
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

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
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

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

  async hasBuildingOnMap(userId: number, buildingName: string): Promise<boolean> {
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

  formatMapResourceYield(mapName: string): string {
    // 直接从调用方传入的地图名无法取到地图对象，改为在调用处已提前解析
    return `${mapName}`;
  }

  /**
   * 宠物操作菜单
   * 对应原版：宠物操作 命令
   */

  async handlePickup(userId: number, itemName?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    // 检查是否死亡
      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

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
        return `  ${item.name || '未知'}${count === 1 ? '' : ` ×${formatDisplayNumber(count)}`}`;
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
      return `${item.name || item.名称} ×${formatDisplayNumber(count)}`;
    }).join('、');

    // 原版拾取顺序：先记录资源产出，再记录拾取条目数。
    // 资源数量是任务进度；“拾取”按地面条目数，不按堆叠数量计算。
    for (const item of pickedUp) {
      const type = item.type ?? item.类型 ?? '资源';
      const itemNameValue = item.name || item.名称 || '';
      const count = Number(item.count ?? item.quantity ?? 1);
      if (type !== '装备' && item.data !== 'a' && itemNameValue && count > 0) {
        await this.support.advanceTask(userId, '采集资源', count);
        await this.support.advanceTask(userId, `采集${itemNameValue}`, count);
      }
    }
    await this.support.advanceTask(userId, '拾取', pickedUp.length);

    // 活跃度+1（原版 L3766/L3810）
    const freshPlayer = (await this.playerService.getPlayerData(userId)).player;
    const freshMarkers = asJsonValue<Record<string, any>>(freshPlayer.markers, {});
    this.support.incrementMarker(freshMarkers, '活跃度', 1);
    freshPlayer.markers = freshMarkers;
    await this.playerService.savePlayer(freshPlayer);

    // 地图标记“全部拾取/拾取”时间戳（原版 L3767-3771/L3811-3815：取成就熟练度(地图.标记)）
    const stampKey = pickAll ? '全部拾取' : '拾取';
    let lastStampText = '';
    await this.mapService.mutateMapFields(map.id, ['markers'], (f) => {
      const mapMarkers = f.markers as Record<string, any>;
      const last = Number(mapMarkers[stampKey] ?? 0);
      if (last > 0) {
        lastStampText = `${map.name}上次被${pickAll ? '全部拾取' : '单项拾取'}是在${this.support.millisecondsToText(Date.now() - last)}之前`;
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

  async handleAutoMine(userId: number): Promise<string> {
    return this.autoMineService
      ? this.autoMineService.start(userId)
      : `${this.support.getPlayerName(userId)}自动开采服务尚未加载`;
  }

  /**
   * 停止开采
   * 对应原版：开采停止 命令
   */

  async handleStopMine(userId: number): Promise<string> {
    return this.autoMineService
      ? this.autoMineService.stop(userId)
      : `${this.support.getPlayerName(userId)}自动开采服务尚未加载`;
  }

  /**
   * 配方解锁
   * 对应原版：配方解锁 命令
   */

  async handleInventory(userId: number, arg?: string): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const items = this.playerService.getBackpackItems(player);
    const displayItems = this.support.getBackpackDisplayItems(items);

    if (displayItems.length === 0) {
      return '🎒 你的背包空空如也';
    }

    // 查看单项详情（对应原版 物品操作.ecode L815~L818：背包 序号/名称 查看物品详情）
    if (arg) {
      // 序号=展示列表编号（与「背包」输出同源）；名称仍查全背包
      const idxNum = parseInt(arg, 10);
      let item;
      if (!isNaN(idxNum) && idxNum >= 1 && idxNum <= displayItems.length) {
        item = displayItems[idxNum - 1];
      } else {
        item = items.find((i: any) => (i.name || i.名称) === arg);
      }
      if (!item) {
        return `背包中没有找到【${arg}】\n使用「背包」查看物品列表`;
      }
      if ((item.type || item.类型) === '装备') {
        // 传 markers：详情自带属性块按「装备强化及自带」强化后口径输出（单一实现）
        return this.itemSystemService.analyzeEquipmentItem(item, '背包', playerData.markers);
      }
      const itemName = item.name || item.名称 || '未知物品';
      const count = Math.round(this.support.itemQuantity(item) * 100) / 100;
      const type = item.type || item.类型 ? `\n类型: ${item.type || item.类型}` : '';
      const desc = item.description || item.说明 ? `\n${item.description || item.说明}` : '';
      return `🎒【${itemName}】×${count}${type}${desc}`;
    }

    // 文本契约（RVW04 P2-8）：以下行格式被 web/src/components/RichSystemCard.vue
    // parseLayout 背包分支的正则解析——普通物品行「N. 名称 ×数量」匹配
    // /^(\d+)\.\s*(.+?)\s*×\s*([\d.]+)\s*$/，装备行「N. 名称」匹配 /^(\d+)\.\s*(.+)$/；
    // 标题行「🎒 背包(N种)」匹配 /^🎒\s*(?:资源)?背包\s*\(\d+(?:种)?\)/。
    // 排序与行格式另由 server/test/inventory-display.spec.ts 契约测试
    // （'背包展示排序（资源在前、装备在后）'）锁定。改动此处输出必须同步前端正则与契约测试。
    const lines = displayItems.map((item: any, index: number) => {
      if ((item.type || item.类型) === '装备') {
        return `${index + 1}. ${this.itemService.formatEquipmentInventoryDisplay(item)}`;
      }
      const itemName = item.name || item.名称 || '未知物品';
      const count = Math.round(this.support.itemQuantity(item) * 100) / 100;
      return `${index + 1}. ${itemName} ×${count}`;
    });

    return `🎒 背包 (${displayItems.length}种):\n${lines.join('\n')}`;
  }

  /**
   * 处理查看地图命令
   */

  async handleResourceBag(userId: number): Promise<string> {
    // 获取玩家数据
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const items = this.playerService.getBackpackItems(player);

    // 筛选非装备类的物品（资源、物品、材料、消耗品等——type 已由静态定义规范化，
    // 材料类在 items.json 中的规范 type 为「物品」，Issue #11）
    const resourceItems = items.filter((item: any) => {
      const type = (item.type || '').toLowerCase();
      return type === '资源' || type === '物品' || type === '材料' || type === '消耗品' || type === '弹药' || type === '素材';
    });

    if (resourceItems.length === 0) {
      return '📦 你的资源背包是空的，当前没有资源、材料或消耗品';
    }

    // 输出格式与「背包」列表完全同构（🎒 标题 + 「N. 名字 ×数量」行）：
    // 前端 RichSystemCard 的背包网格解析与 ChatView isRichCardContent 按同一文本约定复用，
    // 资源背包不设第二套解析分支（统一调用约定，禁止双重表示）。
    // 数量口径与 handleInventory 一致走 itemQuantity（quantity/count 双字段兜底），
    // 禁用旧的 count||quantity 读取（addToBackpack 历史路径只写 count 并 delete quantity）。
    // 文本契约（RVW04 P2-8）：标题 `🎒 资源背包 (N种):` 与物品行 `N. 名字 ×数量` 的解析正则
    // 定义在 web/src/components/RichSystemCard.vue parseLayout 背包分支
    //（/^🎒\s*(?:资源)?背包\s*\(\d+(?:种)?\)/ 与 /^(\d+)\.\s*(.+?)\s*×\s*([\d.]+)\s*$/），
    // server/test/inventory-display.spec.ts 契约测试同步锁定；改动须服务端、前端正则、契约测试三处一起改。
    const lines = resourceItems.map((item: any, index: number) => {
      const itemName = item.name || item.名称 || '未知物品';
      const count = Math.round(this.support.itemQuantity(item) * 100) / 100;
      return `${index + 1}. ${itemName} ×${count}`;
    });

    return `🎒 资源背包 (${resourceItems.length}种):\n${lines.join('\n')}`;
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
        // 数量读取必须走 quantity/count 双字段兜底（与 背包 列表的 itemQuantity 同口径）：
        // addToBackpack 历史路径只写 count 并 delete quantity，直接读 item.quantity 会
        // 得到 undefined → 显示 ×0（实证：能量块 ×486.55 搜索显示 ×0）
        lines.push(`  ${item.name} ×${formatDisplayNumber(this.support.itemQuantity(item))} [${item.type || '资源'}]`);
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
        // 同 背包搜索：quantity/count 双字段兜底，防 addToBackpack 单 count 存量显示 ×0
        lines.push(`  ${item.name} ×${formatDisplayNumber(this.support.itemQuantity(item))} [${item.type || '资源'}]`);
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

  getSeedCropName(itemName: string): string {
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


  async handleUseSeed(
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

  async backpackQuantity(backpack: any[], name: string): Promise<number> {
    let total = 0;
    for (const item of backpack) {
      if ((item?.name ?? item?.名称) === name && item?.type !== '装备') {
        total += Number(item.quantity ?? item.count ?? 0);
      }
    }
    return total;
  }

  /** 跨子服务 API（§10.2）：MovementVehicle 经 DI 直连调用。 */

  addBackpackItem(backpack: any[], item: any): void {
    // 统一走 item-normalize 规范化合并：type 以静态定义为唯一真源（Issue #11）
    mergeBackpackItem(backpack, item, lookupFromStaticData(this.staticData));
  }

  /** 对应原版 制造()：dryRun 只校验，正式执行才消耗资源并产出物品。 */

  /** 采集开始阶段的进程内去重时间戳：key=userId（防同刻连发双开任务）。 */
  private readonly gatherStartInflight = new Map<number, number>();

  /** 玩家面板推送防抖定时器：同一玩家短时间内的多次状态变化合并为一次推送 */
  private readonly playerUpdateTimers = new Map<number, NodeJS.Timeout>();

  /** 地图面板推送防抖定时器：作用同上，避免自动战斗/怪物反击期间的 socket 风暴 */
  private readonly mapUpdateTimers = new Map<number, NodeJS.Timeout>();

  /** 推送版本号计数器（player:{uid} / map:{uid} → 单调递增 rev，供前端丢弃乱序旧包） */
  private readonly revCounters = new Map<string, number>();
}
