/**
 * 移动/载具指令域服务（game 模块化重构 P3-6a 内核聚类 A，策略 B）
 *
 * 职责：移动/传送/飞行（延时到达排程与到达触发链：经验/事件/狐狸突袭/幼崽剪切/
 * 资产迁移）、载具全生命周期（生产/组装/驾驶/脱出/接管/命名/维修/架炮/呼叫/
 * 查看/部件安装与超限）、移动载具联动（开采、载具部件采集）。
 * 聚类依据（§3.4 策略 B）：movement↔vehicle 双向边最强，合并后依赖图无环。
 * 依赖方向：依赖 Player、Map、Prisma、CombatState、CombatSystem、Shortcut、
 * Achievement、Task、DelayedTaskService、StaticData、Chat、SystemConfig、
 * FamiliarSystemService 与支撑层；跨簇调用（panel/rescue/shop/home）直接注入兄弟
 * 子服务——movement↔panel、movement↔home、movement↔rescue 为真实互调，用
 * forwardRef 断 DI 环（残余环兜底，§4 原则 4）。
 * 单一真相源：载具运行态/存储态互转 toRuntimeVehicle/toStoredVehicle；
 * 到达结算唯一入口 performArrival（dts settle，自串行）。
 * 对口原版：_主程序.ecode 移动/载具分支。
 */import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { formatSecondsDurationText, roundItemQuantity } from '../../../common/utils/game-text.util';
import { tagMarkerKind } from '.././expire-time.util';
import { normalizeVehicleEntry, readMarkerValue } from '.././field-contract.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlayerService } from '.././player.service';
import { CombatSystemService } from '.././combat-system.service';
import { MapService } from '.././map.service';
import { AchievementService } from '.././achievement.service';
import { FamiliarSystemService } from '.././familiar-system.service';
import { StaticDataService } from '.././static-data.service';
import { ItemService } from '../item.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { ChatService } from '../../chat/chat.service';
import { TaskService } from '.././task.service';
import { ShortcutService } from '.././shortcut.service';
import { CombatStateService } from '.././combat-state.service';
import { DelayedTaskService } from '.././delayed-task.service';
import { GameSupportService } from '.././game-support.service';
import { GatherPanelService } from './gather-panel.service';
import { HomeBuildService } from './home-build.service';
import { RescueWhiteService } from './rescue-white.service';
import { ShopTradeService } from './shop-trade.service';

@Injectable()
export class MovementVehicleService {
  private readonly logger = new Logger(MovementVehicleService.name);

  constructor(
    private readonly support: GameSupportService,
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly combatSystem: CombatSystemService,
    private readonly mapService: MapService,
    private readonly achievementService: AchievementService,
    private readonly familiarSystemService: FamiliarSystemService,
    private readonly staticData: StaticDataService,
    private readonly itemService: ItemService,
    private readonly systemConfigService: SystemConfigService,
    private readonly chatService: ChatService,
    private readonly taskService: TaskService,
    private readonly shortcutService: ShortcutService,
    private readonly combatState: CombatStateService,
    // 跨域兄弟直连（P4 清理：原过渡期经门面引用）。三对互调边用 forwardRef 断环。
    @Inject(forwardRef(() => GatherPanelService))
    private readonly panel: GatherPanelService,
    @Inject(forwardRef(() => HomeBuildService))
    private readonly homeBuild: HomeBuildService,
    @Inject(forwardRef(() => RescueWhiteService))
    private readonly rescue: RescueWhiteService,
    private readonly shop: ShopTradeService,
    @Optional() private readonly delayedTaskService?: DelayedTaskService,
  ) {}

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
        : this.support.parseJsonArray(player.markers2);
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
          await this.support.advanceTask(userId, '移动', 3);
          return arrival;
        }

        await this.scheduleArrival(userId, dest.id, dest.name, exitSeconds);
        // 原版 L6574 添加标记("移动", b, 玩家.标记2)——行动无限制的移动锁数据源
        const exitMarkers2 = asJsonValue<any[]>(player.markers2, []);
        this.support.normalizeMarkers2(exitMarkers2);
        this.combatState.addMarker('移动', exitSeconds, exitMarkers2, Date.now());
        player.markers2 = exitMarkers2; // Json 列直接写数组
        await this.playerService.savePlayer(player);
        // 原版 L6573：路径节点数 = 当前图/空间乱流/目的地 共 3 个
        await this.support.advanceTask(userId, '移动', 3);
        const exitFollow = await this.panel.summonFollowDisplay(currentMap, userId, { requireFollow: true });
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
      // 再去掉“(副本)”解析真实地图并按传送路径移动；
      // 解析不到时原版输出「#错误：副本不存在"XXX(副本)"」（L6603-6604），不落通用分支。
      if (!dungeonEntry) return `${player.name}#错误：副本不存在"${requestedName}"`;
      // 入口带有效期倒计时（跨重启），已到期视为不存在（清扫任务每 5 分钟兜底删除）
      const entryExpireAt = Number(dungeonEntry.expireAt || 0);
      if (entryExpireAt > 0 && entryExpireAt <= Date.now()) {
        return `${player.name}#错误：副本不存在"${requestedName}"`;
      }
      const baseName = requestedName.slice(0, -4);
      // 入口由统一生成逻辑写入时带 mapId，优先按 ID 解析（副本名与地图名不一致也能进）；
      // 历史入口没有 mapId，回退按名称解析。
      const byEntryId = Number(dungeonEntry.mapId || 0) > 0
        ? await this.mapService.getMapById(Number(dungeonEntry.mapId)).catch(() => null)
        : null;
      targetMap = byEntryId || await this.mapService.getMapByName(baseName).catch(() => null);
      if (!targetMap) return `${player.name}#错误：副本不存在"${requestedName}"`;
    } else {
      targetMap = await this.mapService.getMapByName(requestedName).catch(() => null);
    }

    if (!currentMap || !targetMap) {
      return `地图不存在，请检查名称`;
    }

    // 对齐原版 _主程序.ecode L6610-6618：新手（未触发「召唤白」剧情）自动导航锁——
    // 目的地图编号 >2（医疗室/走廊之外）时拦截，并预置临时输入 1→观察附近。
    // 副本入口在原版分支中早于该锁，不受限。
    // 补充出生区作用域（当前地图 ≤2 才生效）：原版世界结构上不存在「人在外地且无召唤白」
    // 的玩家（新号出生医疗室，外出本身被此锁挡住）；但本项目存在迁移存量老玩家
    // （如人在地图66、标记无召唤白），无作用域时锁退化为全图禁行——走回出生区途经的
    // 每张图 id>2 同样被拦，且引导的「观察附近→打开休眠仓」只在医疗室存在，形成死循环
    // （2026-09-09 玩家无法移动事故）。
    if (!isDungeonEntry
      && Number(currentMap.id) <= 2
      && (Number(this.playerService.getMarkerValue(asJsonValue(player.markers, {}), '召唤白')) || 0) < 1
      && Number(targetMap.id) > 2) {
      if (this.shortcutService?.setTempInput) {
        await this.shortcutService.setTempInput(userId, '1@观察附近');
      }
      return `${player.name || '冒险者'}你现在还不能使用自动导航\n1、观察附近`;
    }

    // 对齐原版 _主程序.ecode L6626-6630：载具行走方式 0(未安装行走机构)/4(无法移动) 时不能"前往"
    const travelVehicle = await this.findTravelVehicle(player, currentMap);
    if (travelVehicle) {
      const walkMode = Number(travelVehicle?.moveType ?? travelVehicle?.walkMode ?? 0);
      if (walkMode === 0) {
        return `${player.name}当前驾驶的载具${travelVehicle?.name || ''}未安装行走机构或有的部件超过了上限`;
      }
      if (walkMode === 4) {
        return `${player.name}当前驾驶的载具${travelVehicle?.name || ''}安装了无法移动的组件`;
      }
    }

    // 对齐原版 _主程序.ecode L6622-6632：先「取最短路径」，距离为 0 时按“没有路径”拦截——
    // 含脚下地图与图间不连通两种情形（如血族城堡/战舰坟场这类只连「出口」的孤岛地图），
    // 并给出「飞到」临时输入；只有存在路径才进入 L6634 的前往需求判定。
    // 副本入口按传送处理，不受此限制。
    if (!isDungeonEntry) {
      const pathExists = await this.hasTravelPath(currentMap, targetMap);
      if (!pathExists) {
        if (this.shortcutService?.setTempInput) {
          await this.shortcutService.setTempInput(userId, `1@飞到${targetMap.name}`);
        }
        return `${player.name}所在地"${currentMap.name}"没有前往"${targetMap.name}"的路径`
          + `\n1、飞到${targetMap.name}`;
      }
    }

    // 检查是否可以前往（原版 L6634：前往需求查出发地图；L6648：标记要求查目的地图）
    const check = isDungeonEntry
      ? { canTravel: true }
      : this.mapService.checkCanTravel(currentMap, targetMap, player, { mode: 'move', vehicle: travelVehicle });
    if (!check.canTravel) {
      return `无法前往：${check.reason}`;
    }

    // 计算移动所需耗时（秒）。
    // 副本入口按原版 _主程序.ecode L6592-6601 的“传送”路径处理：耗时=50/速度（整数截断、
    // 下限3秒），移动任务按 出发/传送/目的地 共3个节点推进，与入口连接距离无关。
    let movementTaskCount: number;
    let travelTime: number;
    if (isDungeonEntry) {
      movementTaskCount = 3;
      travelTime = this.mapService.calcTravelTime(50, player.speed || 100, 3);
    } else {
      // 原版 L6638-6644：b = 取最短路径沿途累计距离/速度（整数截断）；b < 路径节点数 → b=节点数；
      // b < 1 → b=1。距离按 取最短路径 逐段累加（地图操作.ecode L1429），跨图移动按全程计费，
      // 不再只按直连一段（或非直连兜底50）计。
      const path = await this.getMovementPath(currentMap, targetMap);
      movementTaskCount = path.nodeCount;
      travelTime = this.mapService.calcTravelTime(path.distance, player.speed || 100, movementTaskCount);
    }

    // 若关闭了移动耗时开关，则即时到达
    if (!moveTimeEnabled) {
      const result = await this.performArrival(userId, targetMap.id, targetMap.name);
      if (!/不存在|已经在/.test(result)) {
        await this.support.advanceTask(userId, '移动', movementTaskCount);
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
    this.support.normalizeMarkers2(moveMarkers2);
    this.combatState.addMarker('移动', travelTime, moveMarkers2, Date.now());
    player.markers2 = moveMarkers2; // Json 列直接写数组
    await this.playerService.savePlayer(player);

    // 3. 启动到达定时器，到点后真正落地（更新位置 + 广播到达）
    await this.scheduleArrival(userId, targetMap.id, targetMap.name, travelTime);
    await this.support.advanceTask(userId, '移动', movementTaskCount);

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
    { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

    const markers2 = Array.isArray(playerData.markers2)
      ? playerData.markers2
      : this.support.parseJsonArray(player.markers2);
    const restriction = this.combatSystem.actionUnrestricted(player);
    if (restriction.restricted) return restriction.text;

    const currentMap = await this.mapService.getMapById(player.mapId);
    if (!currentMap) return '地图不存在，请检查名称';

    // 载具行走方式四态门禁（原版 L1684-1695）：有载具按行走方式拦截，
    // 无载具才检查天蓝吊坠/军姬免费传送。
    const vehicle = await this.findTravelVehicle(player, currentMap);
    if (vehicle) {
      const walkMode = Number(vehicle?.moveType ?? vehicle?.walkMode ?? 0);
      const vehicleName = vehicle?.name || '';
      if (walkMode === 1) return `${name}当前驾驶的载具${vehicleName}只能使用“前往”来移动`;
      if (walkMode === 2) return `${name}当前驾驶的载具${vehicleName}只能使用“前往”或者“飞到”来移动`;
      if (walkMode === 4) return `${name}当前驾驶的载具${vehicleName}安装了无法移动的组件`;
      if (walkMode === 0) return `${name}当前驾驶的载具${vehicleName}未安装行走机构或有的部件超过了上限`;
    } else {
      const equipment = playerData.equipment || asJsonValue<any[]>(player.equipment, []);
      const hasPendant = equipment.some((item: any) => String(item?.name ?? '') === '天蓝吊坠');
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
    // 刚写入的「传送冷却」补类型标签（方案B：面板据此显示「传送 · 冷却中」而非兜底的「武器冷却中」）
    tagMarkerKind(markers2, '传送冷却', 'act-cd');
    // 原版 L1744：传送查目的地图的前往需求（动态能力判定：vehicle 为 null=徒步持天蓝吊坠）
    const travelCheck = this.mapService.checkCanTravel(currentMap, targetMap, player, { mode: 'teleport', vehicle });
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
    this.support.incrementMarker(activeMarkers, '活跃度', 1);
    player.markers = activeMarkers;
    await this.playerService.savePlayer(player);

    // 代发言触发（原版 L1761-1777）：地图“代发言”字段当前数据未配置（已知遗留），
    // 字段存在时按原版语义执行——载具损毁看隐形披风，其余看载具隐形模块。
    const autoBroadcast = String((targetMap as any).proxySpeak ?? (targetMap as any).autoBroadcast ?? '');
    if (autoBroadcast) {
      if (autoBroadcast === '触发攻击') {
        const vehicleHp = Number(vehicle?.currentHp ?? 0);
        let shouldTrigger = false;
        if (vehicle && vehicleHp < 0) {
          const freshEquip = asJsonValue<any[]>((await this.playerService.getPlayerData(userId)).player.equipment, []);
          const hasCloak = freshEquip.some((item: any) => String(item?.name ?? '') === '隐形披风');
          shouldTrigger = !hasCloak;
        } else {
          const partNames = vehicle ? this.panel.collectVehiclePartNames(vehicle) : [];
          shouldTrigger = !partNames.includes('隐形模块');
        }
        if (shouldTrigger) {
          // 原版 L1757-1771：此分支仅豁免隐形披风/隐形模块，不豁免隐匿模式
          await this.combatSystem.triggerMapBattleLoop(userId, 5, { player, map: targetMap }, { ignoreStealth: true });
        }
      }
      // 其余代发言文本为原版内部延时指令（0 秒新建延时），当前无对应映射，暂略。
    }

    // 观察附近 + 编号临时输入替换（原版 L1758 w4=观察附近 + 临时输入替换）
    let lookText = '';
    try {
      lookText = await this.panel.handleLookAround(userId);
    } catch (e: any) {
      this.logger.warn(`传送生成观察附近失败: ${e.message}`);
    }

    const follow = await this.panel.summonFollowDisplay(targetMap, userId, { requireFollow: true });
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
      const partNames = this.panel.collectVehiclePartNames(vehicle);
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
        this.support.incrementMarker(jumpMarkers, '活跃度', 1);
        player.markers = jumpMarkers;
        player.markers2 = markers2; // Json 列直接写数组
        await this.playerService.savePlayer(player);
        // 原版 L1789：旗舰跃迁引怪无隐匿豁免
        await this.combatSystem.triggerMapBattleLoop(userId, 5, { player, map: targetMap }, { ignoreStealth: true });
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
      : this.support.parseJsonArray(player.markers2);

      { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

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
    // 刚写入的「飞行冷却」补类型标签（方案B：面板据此显示「飞行 · 冷却中」，并与「移动中」读条去重）
    tagMarkerKind(markers2, '飞行冷却', 'act-cd');

    // 原版 L1620：飞到查目的地图的前往需求（动态能力判定）
    const vehicle = await this.findTravelVehicle(player, currentMap);
    if (typeof this.mapService.checkCanTravel === 'function') {
      const check = this.mapService.checkCanTravel(currentMap, targetMap, player, { mode: 'fly', vehicle });
      if (!check.canTravel) return `${playerName}${check.reason || '无法前往该地图'}`;
    }

    const moveType = Number(vehicle?.moveType ?? vehicle?.walkMode ?? 0);
    if (vehicle && moveType === 0) {
      return `${playerName}当前驾驶的载具${vehicle.name}未安装行走机构或有的部件超过了上限`;
    }
    if (vehicle && moveType === 1) {
      return `${playerName}当前驾驶的载具${vehicle.name}只能使用“前往”来移动`;
    }
    if (vehicle && moveType === 4) {
      return `${playerName}当前驾驶的载具${vehicle.name}安装了无法移动的组件`;
    }

    const hasFox = [...(playerData.equipment || []), ...(playerData.weapons || [])]
      .some((item: any) => String(item?.name ?? '') === '狐');
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

  async findTravelVehicle(player: any, currentMap: any): Promise<any | null> {
    const sets = this.parseVehicleValue<any>(player?.sets, {});
    const key = String(player?.vehicle || sets?.takeVehicle || sets?.接管载具 || '');
    if (!key) return null;
    const vehicles = this.parseVehicleValue<any[]>(currentMap?.vehicles, []);
    const keys = (value: any): string[] => [
      value?.vehicleId, value?.id, value?.name,
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

  async scheduleArrival(userId: number, targetMapId: number, targetMapName: string, travelTime: number): Promise<void> {
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
   * 更新玩家位置、应用地图增益、记录探索成就，并向世界频道广播到达消息。
   * @param userId 用户ID
   * @param targetMapId 目标地图ID
   * @param targetMapName 目标地图名
   */
  /** 跨子服务 API（§10.2）：QuestDialogue/RescueWhite 经 DI 直连调用；dts 到达结算唯一入口（自串行）。 */

  async performArrival(
    userId: number,
    targetMapId: number,
    targetMapName: string,
  ): Promise<string> {
    // 支柱二·自串行：延时任务 tick 直调本方法时无任何外层锁；指令路径已在
    // mutate/邮箱内（enqueueUserWrite 重入放行）。统一过用户级串行邮箱，
    // 保证「读档→到达结算→写回」全程独占该玩家状态，不依赖调用方记得持锁。
    return this.playerService.enqueueUserWrite(userId, () =>
      this.applyPerformArrival(userId, targetMapId, targetMapName));
  }

  /** 移动到达结算的数据库读改写段（performArrival 已持用户级串行邮箱）。 */

  async applyPerformArrival(
    userId: number,
    targetMapId: number,
    targetMapName: string,
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

    // 同步清除 markers2 的「移动」镜像锁标记（handleMove 写入的行动门禁，有效期至=原到达时刻）。
    // 不清的话：提前到达（管理员⚡完成/到期补偿结算）后，残留标记会被 行动无限制
    // 判成"移动中"继续拦截移动指令，且面板把它渲染成一条读条直到原到期时刻才消失。
    const lockMarkers2 = Array.isArray(playerData.markers2)
      ? playerData.markers2
      : asJsonValue<any[]>(player.markers2, []);
    const kept2 = lockMarkers2.filter((m: any) => String(m?.name ?? '') !== '移动');
    if (kept2.length !== lockMarkers2.length) {
      player.markers2 = kept2; // Json 列直接写数组
    }

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

    // 到达不再"懒刷新"怪物（对齐原版）：原版 IS 不在地图到达处刷新怪物
    // （`刷新地图` 仅在服务器读档 接口1.ecode L1374 与副本刷新 后台运作 L1066 调用）。
    // 怪物补充完全由「刷新怪物」标记驱动：击杀登记 120 秒标记 → 到期后后台补 1 只
    // （`MapService.refillResidentMonstersByMarker` / `ScheduleService.respawnMonsters`）。
    // 旧实现「0 怪即整批满刷」会跳过原版的空窗期，并可能把其他玩家正在打的怪一并替换。

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
      lookText = await this.panel.handleLookAround(userId);
    } catch (e: any) {
      this.logger.warn(`到达生成观察附近失败: ${e.message}`);
    }

    // 对齐原版 来倒目的 L6762-6776：狐自动攻击——装备#狐 且“狐”60秒冷却通过
    // 且本图有怪时，立即以 50% 倍率必中全体攻击并拉起怪物回合。
    let foxText = '';
    try {
      foxText = await this.applyFoxAutoAttack(userId, targetMap);
    } catch (e: any) {
      this.logger.warn(`到达狐自动攻击失败: ${e.message}`);
    }

    const isGateMap = Boolean((targetMap as any).isInstance || (targetMap as any).关卡);
    let text = `${player.name || '冒险者'}来到了${targetMap.name}`;
    if (isGateMap && targetMap.description) text += `\n${targetMap.description}`;
    if (triggerText) text += `\n${triggerText}`;
    if (lookText) text += `\n${lookText}`;
    if (foxText) text += `\n${foxText}`;
    if (arrivalTaskNotice) text = `${arrivalTaskNotice}\n————————\n${text}`;

    // 注：原版到达拉起怪物攻击（_主程序.ecode L1755-1795）仅限地图"代发言=触发攻击"
    // 且载具损毁/无隐形模块的场景；本框架地图表未配置"代发言"字段，普通到达不惊动怪物，
    // 怪物回合仍由攻击/采集等动作触发（triggerMapBattleLoop）。

    // 向世界频道广播到达消息（持久化 + 实时推送）
    await this.chatService.broadcastSystem('世界频道', text, userId);

    // 定向刷新该玩家的地图总览面板
    try {
      const overview = await this.panel.getMapOverview(userId);
      this.chatService.emitToUser(userId, 'map:update', { overview });
      // 玩家面板无需手动刷新：上方 savePlayer 已由 Prisma 拦截器自动触发 player:update
    } catch (e: any) {
      this.logger.warn(`刷新玩家 ${userId} 地图面板失败: ${e.message}`);
    }

    return text;
  }

  /**
   * 到达触发狐自动攻击（原版 _主程序.ecode L6762-6776 来倒目的）。
   * 装备#狐（特殊序号27，非持握）且“狐”60秒冷却通过且本图有怪时：
   * 以当前武器对全体怪物 50% 倍率必中攻击（attackText “狐a”），随后
   * 新建延时“覅攻击pd”5秒（triggerMapBattleLoop，含玩家活跃）+ 活跃度+1。
   * 击杀奖励由 weaponAttack 内部结算（对应原版 发放奖励）。
   * @returns 攻击结果文本（未触发时为空串）
   */

  async applyFoxAutoAttack(userId: number, map: any): Promise<string> {
    const fresh = await this.playerService.getPlayerData(userId);
    const freshPlayer = fresh.player;
    const equipments = fresh.equipment || asJsonValue<any[]>(freshPlayer.equipment, []);
    const weapons = fresh.weapons || asJsonValue<any[]>(freshPlayer.weapons, []);
    if (!this.combatState.equipRequire(equipments, weapons, Number(freshPlayer.currentWeapon ?? 0), 27, '狐', false)) {
      return '';
    }

    const markers2 = Array.isArray(fresh.markers2)
      ? fresh.markers2
      : this.support.parseJsonArray(freshPlayer.markers2);
    const foxText = { value: '' };
    const foxBlocked = this.combatState.timeIntervalRequire('狐', 60, markers2, Date.now(), foxText, Date.now());

    let monsters: any[] = [];
    if (!foxBlocked) {
      try {
        monsters = await this.mapService.getMapMonsters(map);
      } catch {
        monsters = [];
      }
    }

    let attackResult = '';
    if (!foxBlocked && monsters.length > 0) {
      const attack = await this.combatSystem.weaponAttack(userId, Number(freshPlayer.currentWeapon ?? 0), {
        damageMultiplier: 50,
        mustHit: true,
        allAttack: true,
        attackText: '狐a',
      });
      attackResult = attack?.result || '';
    }

    // 落库：狐冷却标记 + 活跃度+1（攻击后重载快照，避免覆盖 weaponAttack 的击杀/掉落写入）
    const afterPlayer = (await this.playerService.getPlayerData(userId)).player;
    const afterMarkers = asJsonValue<Record<string, any>>(afterPlayer.markers, {});
    if (attackResult) this.support.incrementMarker(afterMarkers, '活跃度', 1);
    afterPlayer.markers = afterMarkers;
    afterPlayer.markers2 = markers2; // Json 列直接写数组
    await this.playerService.savePlayer(afterPlayer);

    if (attackResult) {
      // 原版 L6767-6771：覅攻击pd 5秒 + 玩家活跃（triggerMapBattleLoop 内处理）；
      // 狐分支无隐匿豁免（ignoreStealth）
      await this.combatSystem.triggerMapBattleLoop(userId, 5, { player: afterPlayer, map }, { ignoreStealth: true });
    }
    return attackResult;
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

  async applyArrivalTriggers(player: any, targetMap: any): Promise<string> {
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
          const found = items.find((it: any) => it && it.name === name);
          if (found) {
            // 数量累加统一过 roundItemQuantity 三道闸（比例产出会累出浮点长尾）
            found.quantity = roundItemQuantity(readNum(found.quantity) + qty);
          } else {
            items.push({ name, quantity: roundItemQuantity(qty) });
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
          (b: any) => b && String(b.name ?? '') === '具现装置' && readNum(b.quantity ?? 1) > 0,
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

  async shearPranaCubsOnArrival(map: any, arrivingPlayer: any): Promise<string> {
    const readNum = (v: any): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const summons = asJsonValue<any[]>(map.summons, []);
    if (!summons.length) return '';
    const isPranaCub = (s: any): boolean =>
      !!s && (Number(s.vitality ?? 0) === -31 || String(s.type ?? '') === '普拉娜幼崽');
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
      const rawWeapons = cub.weapons;
      const weapons = Array.isArray(rawWeapons)
        ? rawWeapons
        : asJsonValue<any[]>(String(rawWeapons ?? '[]'), []);
      const hasScissors = weapons.some(
        (w: any) => w && (String(w.name ?? '') === '剪刀' || Number(w.specialSeq ?? 0) === -40),
      );
      if (!hasScissors) continue;

      // 归属者解析（原版 L36-41）：归属 != 当前玩家 → 取玩家(归属)，否则用当前玩家
      const ownerKey = String(cub.ownerQQ ?? cub.owner ?? '');
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
      const rawPresets = cub.equipmentPresets;
      const presets = Array.isArray(rawPresets)
        ? rawPresets
        : asJsonValue<any[]>(String(rawPresets ?? '[]'), []);
      if (presets.length <= 1) continue;
      if (!presets[1]) presets[1] = { name: '宠物背包', equipment: [] };
      const rawBag = presets[1].equipment;
      const bag = Array.isArray(rawBag)
        ? rawBag
        : asJsonValue<any[]>(String(rawBag ?? '[]'), []);

      const markers2 = asJsonValue<any[]>(owner.markers2, []);
      let totalHair = 0;
      for (const animal of summons) {
        if (!animal || animal === cub) continue;
        const typeName = String(animal.type ?? animal.name ?? '').trim();
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
        const hairName = String(hairRaw?.name ?? '毛发') || '毛发';
        const hairQty = Math.max(1, Math.round(readNum(hairRaw?.quantity ?? 1)));
        const found = bag.find((it: any) => it && it.name === hairName);
        if (found) {
          found.quantity = (Number(found.quantity) || 0) + hairQty;
        } else {
          bag.push({ name: hairName, quantity: hairQty });
        }
        totalHair += hairQty;
      }

      if (totalHair > 0) {
        presets[1].equipment = bag;
        cub.equipmentPresets = presets;
        owner.markers2 = markers2; // Json 列直接写数组
        // 地图聚合串行化写入口：锁内重读最新 summons，把「装备预设」写回其中的幼崽
        // （幼崽可能被并发路径迁移/移除，找不到时跳过，绝不复活已删除单位）。
        const cubQQ = String(cub?.qq ?? cub?.QQ ?? '');
        const cubName = String(cub?.name ?? '');
        const isSameCub = (s: any): boolean =>
          !!s && String(s?.qq ?? s?.QQ ?? '') === cubQQ
            && (cubQQ ? true : String(s?.name ?? '') === cubName);
        await this.mapService.mutateSummons(map.id, (fresh) => {
          const freshCub = fresh.find(isSameCub);
          if (freshCub) freshCub.equipmentPresets = presets;
        });
        if (owner.userId) {
          await this.playerService.savePlayer(owner);
          await this.achievementService.addAchievement(owner, '剪毛', totalHair, false);
          await this.achievementService.addAchievement(owner, '采集', totalHair, false);
        }
        return `${cub.name ?? '普拉娜幼崽'} 为地图上的动物剪了毛，获得了毛发x${totalHair}`;
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

  async migratePlayerAssetsOnMove(
    fromMapId: number,
    toMapId: number,
    player: any,
  ): Promise<void> {
    if (!fromMapId || Number(fromMapId) === Number(toMapId)) return;

    const playerQQ = String(player.userId ?? player.qq ?? '');
    if (!playerQQ) return;

    try {
      const vehicleKey = (v: any) => String(v?.id ?? v?.vehicleId ?? '');
      const summonOwner = (s: any) => String(s?.ownerQQ ?? s?.owner ?? s?.qq ?? '');

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
            const sVehicle = String(summon?.vehicle ?? '');
            if (!sVehicle) continue;

            // 检查"跟随"熟练度<1（原版 取成就熟练度(标记,"跟随")<1）
            const summonMarkers = asJsonValue<any[]>(summon?.markers, []);
            const followSkill = summonMarkers['跟随'] ?? 0;
            if (Number(followSkill) >= 1) continue; // 熟练度>=1 不迁移（非跟随状态）

            const vIdx = fromVehicles.findIndex((v: any) => vehicleKey(v) === sVehicle);
            if (vIdx < 0) continue;

            const sv = fromVehicles[vIdx];
            const walkMode = Number(sv?.moveType ?? sv?.walkMode ?? 0);
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
            const sMarkers = asJsonValue<any[]>(s?.markers, []);
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
      const keptBuffs = buffs.filter((b: any) => String(b?.name ?? '') !== '风月入墨');
      if (keptBuffs.length !== beforeLen) {
        player.buffs = keptBuffs; // Json 列直接写数组
      }
    } catch (e: any) {
      this.logger.warn(`迁移玩家载具/召唤物失败: ${e?.message}`);
    }
  }

  /**
   * 判断两张地图之间是否存在通行路径（原版 _主程序.ecode L6622「取最短路径」的存在性部分）。
   *
   * 原版判定：取最短路径 距离为 0（即无路径）时 → 「所在地"X"没有前往"Y"的路径」
   * （L6631-6632），且不会进入前往需求判定（L6634）。典型场景：血族城堡/战舰坟场
   * 这类「可前往」中只有「出口」的孤岛地图，无法直接前往其它任何地图。
   *
   * 实现要点：
   * - 图搜索按**无向**处理：家园/开拓地/副本入口等动态地图的连接由运行时单侧追加，
   *   双向遍历可避免把「回家」误判为无路径（比原版有向图更保守，宁可放行不可误拦）；
   * - 连接名不是真实地图时忽略（「出口」空间乱流、`XX(副本)` 临时入口等）；
   * - 起点=终点（原版距离 0 的一种）视为无路径，由调用方提示「飞到」；
   * - 地图数据缺失或查询异常时返回 true（保守放行，避免误拦正常移动）。
   */
  private async hasTravelPath(startMap: any, targetMap: any): Promise<boolean> {
    const startName = String(startMap?.name || '');
    const targetName = String(targetMap?.name || '');
    // 名称缺失时无法判定：保守放行，交由后续门槛/落地逻辑兜底
    if (!startName || !targetName) return true;
    // 原版「取最短路径(自己, 自己)」距离为 0：脚下地图按无路径处理
    if (startName === targetName) return false;

    try {
      const getAllMaps = (this.mapService as any)?.getAllMaps;
      const getConnections = (this.mapService as any)?.getConnections;
      // 测试桩/精简注入缺少地图查询能力时不拦（与 getMovementPathLength 同口径）
      if (typeof getAllMaps !== 'function' || typeof getConnections !== 'function') return true;

      const maps = (await getAllMaps.call(this.mapService)) || [];
      const mapByName = new Map<string, any>();
      for (const map of maps) {
        const name = String(map?.name || '');
        if (name) mapByName.set(name, map);
      }
      mapByName.set(startName, startMap);
      mapByName.set(targetName, targetMap);

      // 构建无向邻接表：仅当连接名确实是地图时才建边（特殊连接名不参与图搜索）
      const adjacency = new Map<string, Set<string>>();
      const link = (a: string, b: string) => {
        if (!a || !b || a === b) return;
        if (!adjacency.has(a)) adjacency.set(a, new Set());
        if (!adjacency.has(b)) adjacency.set(b, new Set());
        adjacency.get(a)!.add(b);
        adjacency.get(b)!.add(a);
      };
      for (const map of mapByName.values()) {
        const name = String(map?.name || '');
        if (!name) continue;
        for (const connection of getConnections.call(this.mapService, map) || []) {
          const nextName = String(connection?.name || '');
          if (!nextName || !mapByName.has(nextName)) continue;
          link(name, nextName);
        }
      }

      // BFS 判断起点与终点是否连通
      const seen = new Set<string>([startName]);
      const queue: string[] = [startName];
      while (queue.length > 0) {
        const current = queue.shift() as string;
        for (const next of adjacency.get(current) || []) {
          if (next === targetName) return true;
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return false;
    } catch (error: any) {
      this.logger.warn(`计算地图连通性失败，按放行处理: ${error?.message || error}`);
      return true;
    }
  }

  /** 计算移动路径节点数（含起点与终点；原版「移动」成就按此推进）。 */
  async getMovementPathLength(startMap: any, targetMap: any): Promise<number> {
    return (await this.getMovementPath(startMap, targetMap)).nodeCount;
  }

  /**
   * 按原版 取最短路径（地图操作.ecode L1393-1445）计算移动路径：返回路径节点数（含起点，
   * 「移动」成就按此推进）与沿途逐段累加的距离（L1429 l2.距离 = l2.距离 + 段距离），
   * 移动耗时按该累计距离/速度计（_主程序.ecode L6638），跨图移动按全程计费。
   * 与 hasTravelPath 同口径按无向图遍历（家园/开拓地等动态连接由运行时单侧追加，补反向边，
   * 距离沿用该连接的登记值），连接名不是真实地图时忽略（出口/XX(副本) 等特殊连接不参与）。
   * 找不到路径时返回 distance=0（对应原版空路径 距离=0），耗时由 calcTravelTime 下限兜底。
   */
  async getMovementPath(startMap: any, targetMap: any): Promise<{ nodeCount: number; distance: number }> {
    const startName = String(startMap?.name || '');
    const targetName = String(targetMap?.name || '');
    if (!startName || !targetName || startName === targetName) return { nodeCount: 1, distance: 0 };

    try {
      const getAllMaps = (this.mapService as any)?.getAllMaps;
      const getConnections = (this.mapService as any)?.getConnections;
      if (typeof getAllMaps !== 'function' || typeof getConnections !== 'function') {
        return { nodeCount: 1, distance: 0 };
      }

      const maps = await getAllMaps.call(this.mapService);
      const mapByName = new Map<string, any>(
        (maps || []).map((map: any) => [String(map?.name || ''), map] as [string, any]),
      );
      mapByName.set(startName, startMap);
      mapByName.set(targetName, targetMap);

      // 出边沿用出发侧声明的距离（缺失按 50 兜底）；反向补边只在没有自带连接时生效，
      // 双向都登记的连接保持各自方向的距离（与原版按出发侧取 可前往.距离 一致）。
      const adjacency = new Map<string, Map<string, number>>();
      const link = (from: string, to: string, distance: number) => {
        if (!from || !to || from === to) return;
        if (!adjacency.has(from)) adjacency.set(from, new Map());
        const edges = adjacency.get(from)!;
        if (!edges.has(to)) edges.set(to, distance);
      };
      const hopDistance = (connection: any): number => {
        const declared = Number(connection?.distance);
        return Number.isFinite(declared) && declared > 0 ? declared : 50;
      };
      for (const map of mapByName.values()) {
        const name = String(map?.name || '');
        if (!name) continue;
        for (const connection of getConnections.call(this.mapService, map) || []) {
          const to = String(connection?.name || '');
          if (!to || !mapByName.has(to)) continue;
          link(name, to, hopDistance(connection));
        }
      }
      for (const map of mapByName.values()) {
        const name = String(map?.name || '');
        if (!name) continue;
        for (const connection of getConnections.call(this.mapService, map) || []) {
          const to = String(connection?.name || '');
          if (!to || !mapByName.has(to)) continue;
          link(to, name, hopDistance(connection));
        }
      }

      // BFS 按跳数取最短（与原版遍历口径一致），沿途累加每段距离
      const queue: Array<{ name: string; nodeCount: number; distance: number }> = [
        { name: startName, nodeCount: 1, distance: 0 },
      ];
      const visited = new Set<string>([startName]);
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const [nextName, hop] of adjacency.get(current.name) || []) {
          if (visited.has(nextName)) continue;
          const next = {
            name: nextName,
            nodeCount: current.nodeCount + 1,
            distance: current.distance + hop,
          };
          if (nextName === targetName) return { nodeCount: next.nodeCount, distance: next.distance };
          visited.add(nextName);
          queue.push(next);
        }
      }
    } catch (error: any) {
      this.logger.warn(`计算移动路径失败: ${error?.message || error}`);
    }
    return { nodeCount: 1, distance: 0 };
  }

  /**
   * 处理查看信息命令
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
        `“组装燃料100”把材料塞进当前驾驶的载具；“组装燃料-100”从载具取出。`,
        `载具生命为0时也可以生产，但是有部件超出容许安装限制时无法生产。`,
        `生产所需的配方可以发送“配方”来获取。`,
        `载具的核心不是生产类载具的核心时，生产力降低75%。`,
        `排在上面的配方优先结算。`,
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
    const production = await this.settleVehicleProduction(
      userId,
      player,
      source,
      runtime,
      map,
      playerData.markers,
    );
    const timestamp = Date.now();
    const productionMap = source.kind === 'map'
      ? source.map
      : (Number(source.db?.mapIndex || 0) > 0
        ? await this.mapService.getMapById(Number(source.db.mapIndex))
        : map);
    const productionOptions = this.vehicleProductionOptions(productionMap || map, runtime);

    const playerName = player.name || '冒险者';
    if (Number(runtime.bonus?.生产 || 0) === 0) {
      return `${playerName},${runtime.name}没有生产力，你可以组装生产线，或者使用专门的生产类载具。专门的生产类载具效率更高`;
    }
    if (runtime.slotStatus > 1) {
      return `${playerName},${runtime.name}有部件超出了容许安装限制，无法正常运作`;
    }

    if (command === '0') {
      if (runtime.recipes.length < 2) {
        return `${playerName}你尚未对${runtime.name}输入配方\n“生产生肉分解1 5.2”来为当前驾驶的载具输入[生肉分解1]这个配方，并且把5.2的生产力分配给这个配方。`;
      }
      const recipeLines = runtime.recipes.slice(1).map((recipe: any, index: number) => {
        const def = this.staticData.getVehicleRecipeByName(recipe.name);
        const level = Number(def?.level ?? 0);
        return `${index + 1}、${recipe.name}(${level}级) ${this.support.round2Text(Number(recipe.value || 0))}生产力`;
      });
      const speedPercent = production.consumedProductivity > Number(runtime.bonus.生产 || 0)
        ? production.productionSpeed * production.efficiency * 100
        : production.productionSpeed * 100;
      const lines = [
        `${playerName},${runtime.name}的生产线:`,
        ...recipeLines,
        `◆生产力${this.support.round2Text(production.consumedProductivity)}/${this.support.round2Text(Number(runtime.bonus.生产 || 0))},可生产${this.formatVehicleTime(production.availableTime)}`,
        `◆生产速度${this.support.round2Text(speedPercent)}%${production.byproductMultiplier !== 1 ? `,副产物+${this.support.round2Text((production.byproductMultiplier - 1) * 100)}%` : ''}${production.consumptionMultiplier !== 1 ? `,消耗-${this.support.round2Text((1 - production.consumptionMultiplier) * 100)}%` : ''}`,
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
          this.support.itemQuantity((runtime.parts || []).find((part: any) => part.name === item.name)) <= 0)
        .length > 0;
      if (missing) lines.push('【缺少部分物品导致无法生产，你可以手动把物品组装到载具上】');
      await this.persistRuntimeVehicle(source, runtime);
      return lines.join('\n');
    }

    if (command === '1') {
      const sets = this.parseVehicleValue<any>(player.sets, {});
      const scientist = Number(sets?.scientist ?? sets?.科学家 ?? 0);
      if (scientist < 4) return `${playerName}需要装备科学家外套/裙子/手套以及白色丝袜`;
      if (runtime.recipes.length < 2) return `${playerName}${runtime.name}未输入配方`;
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
      runtime.recipes[0].value = Number(runtime.recipes[0].value || timestamp) - 3600 * 1000;
      await this.persistRuntimeVehicle(source, runtime);
      await this.playerService.savePlayer(player);
      return `${playerName},${runtime.name}的时间加速流逝了一小时`;
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
      const parts = runtime.parts || [];
      const existingIndex = parts.findIndex((part: any) => part.name === limitName);
      if (existingIndex >= 0) {
        if (limit === 0) {
          parts.splice(existingIndex, 1);
          await this.persistRuntimeVehicle(source, runtime);
          return `${playerName},移除了${productName}的生产限制`;
        }
        parts[existingIndex].name = limitName;
        parts[existingIndex].quantity = limit;
      } else if (limit > 0) {
        parts.push({ name: limitName, type: '资源', quantity: limit, durability: 100 });
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
        const actualIndex = runtime.recipes.findIndex((recipe: any, index: number) => index > 0 && recipe.name === payload);
        recipeNumber = actualIndex > 0 ? actualIndex : 0;
      }
      const recipeCount = Math.max(0, runtime.recipes.length - 1);
      if (!recipeNumber) return `${playerName}“生产配平5”或者“生产配平木头分解1”来配平`;
      if (recipeNumber < 1 || recipeNumber > recipeCount) {
        return `${playerName},${runtime.name}只有${recipeCount}个配方，输入的值超范围或者小于1:${recipeNumber}`;
      }
      const target = runtime.recipes[recipeNumber];
      const targetDef = this.staticData.getVehicleRecipeByName(target.name);
      const targetInputs = this.parseVehicleValue<any[]>(targetDef?.inputs, []);
      const productionView = this.combatSystem.calculateVehicleProduction(runtime, timestamp, productionOptions);
      const messages: string[] = [`${runtime.name}\n配方${target.name}x${this.support.round2Text(Number(target.value || 0))}`];
      for (const input of targetInputs) {
        const inputName = input?.name ?? '';
        const inputQty = Number(input?.quantity ?? 0);
        const inputDurability = Number(input?.durability ?? 100) / 100;
        const need = inputQty * inputDurability * Number(target.value || 0)
          * productionView.consumptionMultiplier * productionView.efficiency * productionView.productionSpeed;
        let matched = false;
        for (let index = 1; index < runtime.recipes.length; index++) {
          if (index === recipeNumber) continue;
          const other = runtime.recipes[index];
          const otherDef = this.staticData.getVehicleRecipeByName(other.name);
          const outputs = this.parseVehicleValue<any[]>(otherDef?.outputs, []);
          const output = outputs.find((item: any) => item?.name === inputName);
          if (!output) continue;
          const outputQty = Number(output.quantity ?? 0);
          const outputDurability = Number(output.durability ?? 100) / 100;
          const perProduction = outputQty * (outputDurability < 1 ? outputDurability * productionView.byproductMultiplier : 1)
            * productionView.efficiency * productionView.productionSpeed;
          if (perProduction <= 0) continue;
          other.value = need / perProduction;
          messages.push(`配方${other.name}产出${inputName}，生产力调整为${this.support.round2Text(other.value)}`);
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
      const recipeCount = Math.max(0, runtime.recipes.length - 1);
      if (insertMatch) {
        const from = Number(insertMatch[1]);
        const to = Number(insertMatch[2]);
        if (from < 1 || from > recipeCount || to < 1 || to > recipeCount || from === to) {
          return `${playerName},${runtime.name}只有${recipeCount}个配方，或者你输入的值不符合规范(小于1或者相等)\n${from} ${to}`;
        }
        const moved = runtime.recipes.splice(from, 1)[0];
        runtime.recipes.splice(to, 0, moved);
        await this.persistRuntimeVehicle(source, runtime);
        await this.taskService.advance(userId, '生产排序');
        return `${playerName},${runtime.name}的配方[${moved.name}]移动到了${to}号`;
      }
      if (swapMatch) {
        const first = Number(swapMatch[1]);
        const second = Number(swapMatch[2]);
        if (first < 1 || second < 1 || first > recipeCount || second > recipeCount || first === second) {
          return `${playerName},${runtime.name}只有${recipeCount}个配方，或者你输入的值不符合规范(小于1或者相等)\n${first} ${second}`;
        }
        const temp = runtime.recipes[first];
        runtime.recipes[first] = runtime.recipes[second];
        runtime.recipes[second] = temp;
        await this.persistRuntimeVehicle(source, runtime);
        await this.taskService.advance(userId, '生产排序');
        return `${playerName},${runtime.name}的配方[${runtime.recipes[second].name}]和[${runtime.recipes[first].name}]交换了位置`;
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
      ? unlocked.map((recipe: any) => String(recipe?.name ?? recipe))
      : Object.keys(unlocked || {}).filter((key) => Number(unlocked[key]) !== 0);
    if (!unlockedNames.includes(recipeName) || !this.staticData.getVehicleRecipeByName(recipeName)) {
      return `${playerName}你尚未解锁这个配方，或者输入的配方不存在：${recipeName}`;
    }
    if (!Number.isFinite(allocation)) {
      return `${playerName}你输入的数据不正确，请检查：${command}`;
    }
    if (runtime.recipes.length === 0) runtime.recipes.push({ name: '1', value: timestamp });
    this.combatState.addAchievement(recipeName, allocation, runtime.recipes as any);
    const current = runtime.recipes.find((recipe: any) => recipe.name === recipeName);
    const currentValue = Number(current?.value || 0);
    const view = this.combatSystem.calculateVehicleProduction(runtime, timestamp, productionOptions);
    await this.persistRuntimeVehicle(source, runtime);
    await this.taskService.advance(userId, '设置生产配方');
    const currentOutput = view.combinedPerMinute.filter((item) => Number(item.quantity || 0) !== 0);
    return `${playerName}为${runtime.name}设置了${recipeName}\n它当前占用的生产力为${this.support.round2Text(currentValue)}\n${runtime.name}当前产出:${this.formatVehicleItems(currentOutput)}`;
  }

  /**
   * 原版“安装”统一入口：生产建筑放院子，功能建筑放屋内；非建筑则安装到载具。
   */

  getSlotLimit(vehicle: any, partType: number): { slots: number; max: number; name: string } {
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
  /** 跨子服务 API（§10.2）：HomeBuild 经 DI 直连调用。 */

  calcVehicleTotalBonus(vehicle: any): any {
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

  /**
   * 载具运行时对象工厂（载具域唯一入口）。
   *
   * 全链路口径：DB 载具行 / 地图 vehicles 条目 / 静态模板一律先过这里，
   * 由 field-contract.util 的载具域映射把历史中文键（零件/配方/加成/当前生命/上限…）
   * 一次性收敛为英文规范键；此后各业务模块只读写英文规范键，禁止再做中文兜底。
   */
  toRuntimeVehicle(raw: any): any {
    if (!raw || typeof raw !== 'object') return raw;
    // 字段名先在副本上收敛，避免污染调用方传入的原始对象
    const src: any = { ...raw };
    normalizeVehicleEntry(src);

    const normalizeItem = (item: any): any => {
      const quantity = Number(item?.quantity ?? 1);
      const durability = Number(item?.durability ?? 100);
      return {
        ...(item || {}),
        name: String(item?.name ?? ''),
        type: item?.type ?? '资源',
        quantity: Number.isFinite(quantity) ? quantity : 0,
        durability: Number.isFinite(durability) ? durability : 100,
      };
    };
    const normalizeRecipe = (recipe: any): any => {
      const value = Number(recipe?.value ?? 0);
      return {
        ...(recipe || {}),
        name: String(recipe?.name ?? ''),
        value: Number.isFinite(value) ? value : 0,
      };
    };
    const parts = this.parseVehicleValue<any[]>(src.parts, []);
    const recipes = this.parseVehicleValue<any[]>(src.recipes, []);
    const bonus = this.parseVehicleValue<any>(src.bonus, {});
    const markers = this.parseVehicleValue<any>(src.markers, {});
    const markers2 = this.parseVehicleValue<any[]>(src.markers2, []);
    const currentHp = Number(src.currentHp ?? 0);
    const maxHp = Number(src.maxHp ?? 0);
    const slotStatus = Number(src.slotStatus ?? 0);
    const moveType = Number(src.moveType ?? 0);
    return {
      ...src,
      name: String(src.name ?? ''),
      type: String(src.type ?? ''),
      vehicleId: String(src.vehicleId ?? src.id ?? ''),
      owner: String(src.owner ?? ''),
      driver: String(src.driver ?? ''),
      currentHp: Number.isFinite(currentHp) ? currentHp : 0,
      maxHp: Number.isFinite(maxHp) ? maxHp : 0,
      slotStatus: Number.isFinite(slotStatus) ? slotStatus : 0,
      moveType: Number.isFinite(moveType) ? moveType : 0,
      parts: Array.isArray(parts) ? parts.map(normalizeItem) : [],
      recipes: Array.isArray(recipes) ? recipes.map(normalizeRecipe) : [],
      bonus: bonus && typeof bonus === 'object' ? bonus : {},
      markers: markers && typeof markers === 'object' && !Array.isArray(markers) ? markers : {},
      markers2: Array.isArray(markers2) ? markers2 : [],
      reverseField: Boolean(src.reverseField),
      hair: Boolean(src.hair),
      coating: Number(src.coating ?? 0) || 0,
    };
  }

  /**
   * 落库 / 写回地图用的载具对象（载具域规范键）。
   * 与 toRuntimeVehicle 同口径：只产出英文规范键，不再写中英双份镜像。
   * 跨子服务 API（§10.2）：DungeonChallenge 经 DI 直连调用。
   */
  toStoredVehicle(runtime: any): any {
    const parts = ((runtime?.parts as any[]) || []).map((item: any) => ({
      ...(item || {}),
      name: String(item?.name ?? ''),
      type: item?.type ?? '资源',
      quantity: Number(item?.quantity ?? 0),
      durability: Number(item?.durability ?? 100),
    }));
    const recipes = ((runtime?.recipes as any[]) || []).map((recipe: any) => ({
      ...(recipe || {}),
      name: String(recipe?.name ?? ''),
      value: Number(recipe?.value ?? 0),
    }));
    return {
      ...(runtime || {}),
      name: runtime?.name ?? '',
      vehicleId: runtime?.vehicleId ?? runtime?.id ?? '',
      type: runtime?.type ?? '',
      owner: runtime?.owner ?? '',
      driver: runtime?.driver ?? '',
      currentHp: Number(runtime?.currentHp ?? 0),
      maxHp: Number(runtime?.maxHp ?? 0),
      slotStatus: Number(runtime?.slotStatus ?? 0),
      moveType: Number(runtime?.moveType ?? 0),
      parts,
      recipes,
      bonus: runtime?.bonus && typeof runtime.bonus === 'object' ? runtime.bonus : {},
      markers: runtime?.markers && typeof runtime.markers === 'object' ? runtime.markers : {},
      markers2: Array.isArray(runtime?.markers2) ? runtime.markers2 : [],
      reverseField: Boolean(runtime?.reverseField),
      hair: Boolean(runtime?.hair),
      coating: Number(runtime?.coating ?? 0) || 0,
    };
  }


  vehicleDbData(runtime: any): Record<string, any> {
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
      markers: stored.markers || {},
      markers2: stored.markers2 || [],
      recipes: stored.recipes || [],
      reverseField: Boolean(stored.reverseField),
      coating: Number(stored.coating || 0),
    };
  }

  /**
   * 按时间戳结算载具生产并持久化（原版 计算载具(..., 计算产出=真) 的统一入口）。
   * 查看自己载具与「生产」命令共用，保证挂机后打开详情也会补产。
   */
  private async settleVehicleProduction(
    userId: number,
    player: any,
    source: any,
    runtime: any,
    map: any,
    playerMarkers?: any,
  ): Promise<any> {
    const productionBonus = this.achievementService.getAchievement(
      playerMarkers ?? asJsonValue<any>(player?.markers, {}),
      '生产',
    );
    // 接管载具可能来自其他地图；兰音幼崽/咏星状态应从载具所在地图读取。
    const productionMap = source.kind === 'map'
      ? source.map
      : (Number(source.db?.mapIndex || 0) > 0
        ? await this.mapService.getMapById(Number(source.db.mapIndex))
        : map);
    const productionOptions = this.vehicleProductionOptions(productionMap || map, runtime);
    const production = this.combatSystem.produceVehicle(
      runtime,
      Date.now(),
      productionBonus,
      map.id,
      productionOptions,
    );

    // 生产结算必须先持久化，后续生产限制/排序/配方设置才不会覆盖已结算的时间戳。
    await this.persistRuntimeVehicle(source, runtime);

    // 原版实际产出同时推进「生产」成就和按物品拆分的任务要求。
    const producedByName = new Map<string, number>();
    for (const item of production.produced || []) {
      const anyItem = item as any;
      const name = String(anyItem.name || '');
      const quantity = Number(anyItem.quantity ?? 0);
      if (name && quantity > 0) producedByName.set(name, (producedByName.get(name) || 0) + quantity);
    }
    if (producedByName.size > 0) {
      const markers = playerMarkers ?? asJsonValue<any>(player?.markers, {});
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
    return production;
  }

  /** 持久化生产结算后的载具；地图 JSON 和 GameVehicle 共用同一运行时结构。 */

  async persistRuntimeVehicle(source: any, runtime: any): Promise<void> {
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

  async findProductionVehicle(userId: number, player: any, currentMap: any): Promise<any | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const ownerIds = new Set([
      String(userId), String(player?.userId ?? ''), String(user?.qqNumber ?? ''),
      String(user?.externalId ?? ''), String(player?.masterQQ ?? ''),
    ].filter(Boolean));
    const sets = this.parseVehicleValue<any>(player?.sets, {});
    const takeover = String(sets?.takeVehicle ?? sets?.接管载具 ?? '');
    const requested = takeover || String(player?.vehicle ?? '');

    const matchUnit = (unit: any, key: string): boolean => {
      const ids = [unit?.vehicleId, unit?.id, unit?.name]
        .filter((value) => value !== undefined && value !== null)
        .map(String);
      if (key && ids.includes(key)) return true;
      const driver = String(unit?.driver ?? '');
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


  vehicleProductionOptions(map: any, vehicle: any): { yongxing: number; lannBaby: boolean } {
    const summons = this.parseVehicleValue<any[]>(map?.summons, []);
    const driver = String(vehicle?.driver ?? '');
    const driverSummon = summons.find((summon: any) =>
      [summon?.QQ, summon?.qq, summon?.id].filter(Boolean).map(String).includes(driver),
    );
    const seq = (summon: any): number => Number(
      summon?.vitality ?? summon?.specialSeq ?? 0,
    );
    return {
      // 原版常量：咏星特殊序号=-27，兰音幼崽特殊序号=-30。
      yongxing: driverSummon && seq(driverSummon) === -27 ? 0.15 : 0,
      lannBaby: summons.some((summon: any) => seq(summon) === -30),
    };
  }


  formatVehicleItems(items: any[]): string {
    const values = (items || []).filter((item: any) => Number(item?.quantity ?? 0) !== 0);
    if (values.length === 0) return '无';
    return values.map((item: any) => {
      const name = item?.name ?? '';
      const quantity = Number(item?.quantity ?? 0);
      return `${name}x${this.support.round2Text(quantity)}`;
    }).join('、');
  }


  formatVehicleTime(seconds: number): string {
    if (seconds === 86400.12345678) return '时间无限，显示一天的产量';
    return formatSecondsDurationText(seconds, 'fullUnits');
  }

  /**
   * 载具生产命令。
   * 对应原版 _主程序.ecode L10929-11222，以及物品操作.ecode L2612-2954。
   */

  async handleVehicleStatus(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    if (!player.vehicle) {
      return '你当前没有驾驶任何载具';
    }

    // 地图 JSON 与 GameVehicle 双存储统一走 findTravelVehicle（对齐查看载具/维修口径）
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${player.name || '冒险者'}不在服务区`;
    const vehicle = await this.findTravelVehicle(player, map);
    if (!vehicle) {
      const key = String(player.vehicle);
      player.vehicle = '';
      await this.playerService.savePlayer(player);
      return `#错误：附近没有载具${key},已弹射`;
    }

    this.combatSystem.recalculateVehicle(vehicle, Date.now());
    return this.formatVehicleDetail(vehicle);
  }

  // ========== 基础战斗命令 ==========

  /**
   * 处理开始战斗命令
   * 对应原版 _主程序.ecode L2077-2163：在家园前线生成一轮地精攻势，
   * 写入 GameMonster，生成/刷新前线防御召唤物，并开启前线活动状态。
   */

  async handleAssembleVehicle(userId: number, partName: string, count = 1, newVehicleName?: string): Promise<string> {
    if (!partName) {
      return '请指定要组装的部件名称，格式：组装 部件名 [数量/新名称]';
    }
    // 原版 _主程序.ecode L10096-10269：数量可为负（从载具取出）；
    // count===0 且带 newVehicleName 表示「组装核心 新名称」建车。
    const rawCount = Number(count);
    const requestedCount = Number.isFinite(rawCount) ? Math.trunc(rawCount) : 1;

    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userQQ = String(user?.qqNumber || user?.externalId || userId);
    const backpack = this.playerService.getBackpackItems(player);
    const playerName = player.name || '冒险者';

    // 床等功能建筑也可以组装到载具，原版任务使用“组装床”而不是“安装床”。
    if (this.staticData.getBuildingByName(partName) && requestedCount > 0) {
      return this.homeBuild.handleAssembleBuilding(userId, partName, requestedCount);
    }

    const partDef = this.staticData.getVehiclePartByName(partName);
    // 原版 L10252：取文本右边(名称,4)=="核心" 即视为核心，卸下时整车散架。
    // 不依赖 vehicles.json 模板命中——废弃空间站核心等 wreck 核心只在 vehicle-parts.json，
    // 用模板查会漏判导致只拆核心不散架。
    const isCore = partName.endsWith('核心') || (!!partDef && Number(partDef.partType) === 0);

    // 组装核心 新名称 → 以此核心创建命名新载具（原版 L10119-L10164）
    if (isCore && newVehicleName) {
      if (this.playerService.getCurrencyAmount(player, partName, backpack) < 1) {
        return `${playerName}你背包里的${partName}数量不足1`;
      }
      if (player.vehicle) {
        return `${playerName}你已经有一辆载具了，无法创建新的载具`;
      }
      const map = await this.mapService.getMapById(player.mapId);
      if (!map) return `${playerName}不在服务区`;
      if (await this.hasOwnedProductionVehicle(userQQ, partDef)) {
        return `${playerName}一个玩家只能同时存在一个生产类载具，你可以在普通载具上组装生产线，一样有生产的效果。`;
      }
      const vehicleName = newVehicleName === '原' ? '默认' : newVehicleName;
      this.playerService.setCurrencyAmount(player, partName, this.playerService.getCurrencyAmount(player, partName, backpack) - 1, backpack);
      player.backpack = backpack;
      const runtime = this.toRuntimeVehicle({
        name: vehicleName,
        vehicleId: Math.random().toString(36).substring(2, 10).toUpperCase(),
        owner: userQQ,
        driver: userQQ,
        parts: [{ name: partName, type: '资源', quantity: 1, durability: 100 }],
        recipes: [],
        bonus: {},
        markers2: [],
      });
      this.combatSystem.recalculateVehicle(runtime, Date.now());
      if (runtime.recipes.length === 0) runtime.recipes.push({ name: '1', value: Date.now() });
      runtime.currentHp = Number(runtime.bonus?.生命 ?? runtime.maxHp ?? 0);
      const vehicles = this.parseVehicleValue<any[]>(map.vehicles, []);
      vehicles.push(this.toStoredVehicle(runtime));
      await this.mapService.updateDynamicFields(map.id, { vehicles });
      player.vehicle = String(runtime.vehicleId);
      await this.playerService.savePlayer(player);
      this.achievementService.setAchievement(markers, '组装载具', this.achievementService.getAchievement(markers, '组装载具') + 1);
      player.markers = markers;
      await this.playerService.savePlayer(player);
      return `${playerName}组装了一个载具：${vehicleName}`;
    }

    // 驾驶/接管后才能对载具做零件进出（原版 L10166+）
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${playerName}不在服务区`;
    const source = await this.findProductionVehicle(userId, player, map);
    if (!source) {
      const sets = this.parseVehicleValue<any>(player.sets, {});
      if (sets?.takeVehicle ?? sets?.接管载具) {
        sets.takeVehicle = '';
        sets.接管载具 = '';
        player.sets = sets;
        await this.playerService.savePlayer(player);
        return `${playerName}由于你之前接管的载具不在世界上，已自动停止接管\n必须“驾驶”或者“接管”载具之后才能执行此操作`;
      }
      if (isCore) {
        return `${playerName}必须“驾驶”或者“接管”载具之后才能执行此操作，如果你想用核心组装一个新的载具，你可以发送\n“组装${partName} 新名称”`;
      }
      return `${playerName}必须“驾驶”或者“接管”载具之后才能执行此操作`;
    }

    const runtime = source.runtime;
    const parts = runtime.parts || (runtime.parts = []);

    // 驾驶中替换核心（原版 L10209-L10221：右侧为“核心”时直接换核）
    if (isCore && requestedCount > 0) {
      if (await this.hasOwnedProductionVehicle(userQQ, partDef)) {
        return `${playerName}一个玩家只能同时存在一个生产类载具，你可以在普通载具上组装生产线，一样有生产的效果。`;
      }
      if (this.playerService.getCurrencyAmount(player, partName, backpack) < 1) {
        return `${playerName}你的背包里面没有${partName}`;
      }
      const oldCore = parts[0] ? { ...parts[0] } : null;
      parts[0] = {
        name: partName,
        type: '资源',
        quantity: Number(parts[0]?.quantity ?? 1) || 1,
        durability: 100,
      };
      if (oldCore?.name) {
        this.addBackpackItem(player, backpack, String(oldCore.name), Number(oldCore.quantity ?? 1) || 1);
      }
      this.playerService.setCurrencyAmount(player, partName, this.playerService.getCurrencyAmount(player, partName, backpack) - 1, backpack);
      player.backpack = backpack;
      await this.settleVehicleProduction(userId, player, source, runtime, map, markers);
      return `${playerName}把${runtime.name}的${oldCore?.name || '核心'}更换成了${partName}`;
    }

    // 负数量：从载具零件取出（原版 L10241-L10269）
    if (requestedCount < 0) {
      if (partName.includes('生产限制')) {
        return `${playerName}${runtime.name}上没有${partName}`;
      }
      const take = Math.abs(requestedCount);
      const held = parts.reduce((sum: number, p: any) =>
        sum + (p?.name === partName ? Number(p?.quantity ?? 0) : 0), 0);
      const actual = Math.min(take, held);
      if (actual <= 0) {
        return `${playerName}${runtime.name}上没有${partName}`;
      }
      this.mergeVehiclePartQuantity(parts, partName, -actual);
      this.addBackpackItem(player, backpack, partName, actual);
      player.backpack = backpack;
      // 卸核心时整车散架（原版 L10252-L10262）
      if (isCore) {
        await this.settleVehicleProduction(userId, player, source, runtime, map, markers);
        const lootLines: string[] = [];
        for (const p of parts) {
          const n = String(p?.name ?? '');
          if (!n || n.includes('生产限制')) continue;
          const q = Number(p?.quantity ?? 0);
          if (q <= 0) continue;
          this.addBackpackItem(player, backpack, n, q);
          lootLines.push(`${n}x${this.support.round2Text(q)}`);
        }
        player.backpack = backpack;
        player.vehicle = '';
        // 散架后清掉指向本车的接管残留，否则 findTravelVehicle 仍会命中已销毁载具挡住移动
        const setsAfterScrap = this.parseVehicleValue<any>(player.sets, {});
        const scrapKeys = new Set([
          String(runtime?.vehicleId ?? ''), String(runtime?.id ?? ''),
        ].filter(Boolean));
        if (scrapKeys.has(String(setsAfterScrap?.takeVehicle ?? '')) || scrapKeys.has(String(setsAfterScrap?.接管载具 ?? ''))) {
          setsAfterScrap.takeVehicle = '';
          setsAfterScrap.接管载具 = '';
          player.sets = setsAfterScrap;
        }
        await this.playerService.savePlayer(player);
        if (source.kind === 'map') {
          const vehicles = this.parseVehicleValue<any[]>(source.map?.vehicles, []);
          vehicles.splice(source.index, 1);
          await this.mapService.updateDynamicFields(source.map.id, { vehicles });
        }
        return `${playerName}拆掉了${runtime.name}的核心，${runtime.name}散架了\n载具内容物收入了背包：${lootLines.join('、') || '无'}`;
      }
      await this.settleVehicleProduction(userId, player, source, runtime, map, markers);
      const isPart = !!partDef;
      return `${playerName}把${partName}x${actual}从${runtime.name}上${isPart ? '拆了下来' : '取了出来'}`;
    }

    // 正数量：背包 → 载具零件（原版 L10203-L10239）。部件与资源一视同仁。
    let want = Math.max(1, requestedCount);
    const available = this.playerService.getCurrencyAmount(player, partName, backpack);
    if (available < want) want = available;
    if (want < 1) {
      return `${playerName}你的背包里面没有${partName}`;
    }
    this.mergeVehiclePartQuantity(parts, partName, want);
    this.playerService.setCurrencyAmount(player, partName, available - want, backpack);
    player.backpack = backpack;
    await this.settleVehicleProduction(userId, player, source, runtime, map, markers);
    const isPart = !!partDef;
    return `${playerName}把${partName}x${want}${isPart ? '装到了' : '塞到了'}${runtime.name}${isPart ? '上' : '里面'}`;
  }

  /** 背包条目增减（双字段 + 工作数组）。 */
  private addBackpackItem(player: any, backpack: any[], name: string, delta: number): void {
    if (!name || !Number.isFinite(delta) || delta === 0) return;
    const next = this.playerService.getCurrencyAmount(player, name, backpack) + delta;
    this.playerService.setCurrencyAmount(player, name, next, backpack);
  }

  /** 载具零件数量增减（原版 获得物品 对 载具.零件 的合并语义）。 */
  private mergeVehiclePartQuantity(parts: any[], name: string, delta: number): void {
    const idx = parts.findIndex((p: any) => p?.name === name);
    if (idx >= 0) {
      const next = Number(parts[idx]?.quantity ?? 0) + delta;
      if (next <= 0) {
        parts.splice(idx, 1);
        return;
      }
      parts[idx].quantity = next;
      return;
    }
    if (delta > 0) {
      parts.push({
        name,
        type: '资源',
        quantity: delta,
        durability: 100,
      });
    }
  }

  /** 解析封印态 requireLevel：优先运行时戳，存量残骸按名回查 wrecks.json。 */
  private async resolveWreckSealInfo(runtime: any): Promise<{
    requireLevel: number;
    guardWaves: number;
    vouchers: number;
    vitality: number;
    sealed: boolean;
  } | null> {
    const name = String(runtime?.name ?? '').trim();
    if (!name) return null;
    const stampedLevel = Number(runtime?.requireLevel ?? 0) || 0;
    const stampedWaves = Number(runtime?.guardWaves ?? 0) || 0;
    const stampedVouchers = Number(runtime?.sacrificeVouchers ?? 0) || 0;
    const stampedVitality = Number(runtime?.sacrificeVitality ?? 0) || 0;
    const sealedFlag = runtime?.sealed;
    if (stampedLevel > 0) {
      return {
        requireLevel: stampedLevel,
        guardWaves: Math.max(1, stampedWaves || 1),
        vouchers: Math.max(1, stampedVouchers || 1),
        vitality: Math.max(2, stampedVitality || 2),
        sealed: sealedFlag === true || sealedFlag === 1 || sealedFlag === 'true',
      };
    }
    const wrecks = this.staticData.loadRaw('wrecks') as any[];
    if (!Array.isArray(wrecks)) return null;
    const def = wrecks.find((row: any) => String(row?.name ?? '') === name);
    if (!def || !(Number(def.requireLevel) > 0)) return null;
    const sealCost = def.sealCost && typeof def.sealCost === 'object' ? def.sealCost : {};
    return {
      requireLevel: Math.max(1, Math.trunc(Number(def.requireLevel)) || 1),
      guardWaves: Math.max(1, Math.trunc(Number(def.guardWaves ?? 1)) || 1),
      vouchers: Math.max(1, Math.trunc(Number(sealCost.vouchers ?? 1)) || 1),
      vitality: Math.max(2, Math.trunc(Number(sealCost.vitality ?? 2)) || 2),
      sealed: true,
    };
  }

  /** 读取唤醒/封印全局开关。 */
  private async getWreckSealFlags(): Promise<{ levelGate: boolean; sealEnabled: boolean; costFactor: number }> {
    const [levelGate, sealEnabled, costFactor] = await Promise.all([
      this.systemConfigService.get<boolean>('game.wreckClaimLevelGate', true),
      this.systemConfigService.get<boolean>('game.wreckSealEnabled', true),
      this.systemConfigService.get<number>('game.wreckSealCostFactor', 100),
    ]);
    const factor = Number(costFactor);
    return {
      levelGate: levelGate !== false,
      sealEnabled: sealEnabled !== false,
      costFactor: Number.isFinite(factor) && factor > 0 ? factor : 100,
    };
  }

  /** 管理员（ADMIN/SUPER_ADMIN）在认领/唤醒链路可绕过等级门槛。 */
  private async isAdminUser(userId: number): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';
  }

  /** 统计背包内某物品数量。 */
  private countBackpackItem(player: any, itemName: string): number {
    const backpack = this.playerService.getBackpackItems(player);
    let total = 0;
    for (const item of backpack) {
      if (String(item?.name ?? '') !== itemName) continue;
      total += Number(item?.quantity ?? 0) || 0;
    }
    return total;
  }

  /** 调整献祭系数后的凭证/活力消耗（凭证≥1、活力≥2）。 */
  private scaleSealCost(base: { vouchers: number; vitality: number }, factorPct: number) {
    const factor = (Number(factorPct) || 100) / 100;
    return {
      vouchers: Math.max(1, Math.round(base.vouchers * factor)),
      vitality: Math.max(2, Math.round(base.vitality * factor)),
    };
  }

  /** 在残骸所在地图生成一波遗迹守卫（GameMonster isTemp，温和成长）。 */
  private async spawnWreckGuardWave(
    mapId: number,
    vehicleId: string,
    wave: number,
    level: number,
  ): Promise<number> {
    const guardLevel = Math.max(1, Math.trunc(level) || 1);
    const guard = await this.mapService.spawnSealGuard(mapId, {
      vehicleId,
      wave,
      level: guardLevel,
    });
    this.logger.log(`遗迹守卫生成 map=${mapId} vehicle=${vehicleId} wave=${wave} lv=${guardLevel} hp=${guard.hp}`);
    return 1;
  }

  /** 统计地图上仍存活、归属该载具的遗迹守卫数量。 */
  private async countSealGuards(mapId: number, vehicleId: string): Promise<number> {
    const monsters = await this.mapService.getMapMonsters(mapId);
    return monsters.filter((m: any) =>
      (Number(m?.hp ?? 0) > 0)
      && String(m?.qq ?? '').startsWith(`sealguard_${vehicleId}_`),
    ).length;
  }

  /** 击杀守卫后推进：清空下一波或解封并授予唤醒者归属。 */
  async advanceWreckSealAfterKill(mapId: number): Promise<string> {
    const map = await this.mapService.getMapById(mapId);
    if (!map) return '';
    const vehicles = this.parseVehicleValue<any[]>(map.vehicles, []);
    let changed = false;
    const lines: string[] = [];
    for (let i = 0; i < vehicles.length; i++) {
      const runtime = this.toRuntimeVehicle(vehicles[i]);
      const sealed = runtime.sealed === true;
      const sealWave = Number(runtime.sealWave ?? 0) || 0;
      const waker = String(runtime.sealWaker ?? '');
      if (!sealed || sealWave <= 0 || !waker) continue;
      if ((await this.countSealGuards(map.id, String(runtime.vehicleId || ''))) > 0) continue;
      const totalWaves = Math.max(1, Number(runtime.guardWaves ?? 1) || 1);
      const playerName = await this.resolvePlayerName(waker);
      if (sealWave < totalWaves) {
        const nextWave = sealWave + 1;
        runtime.sealWave = nextWave;
        vehicles[i] = this.toStoredVehicle(runtime);
        changed = true;
        await this.spawnWreckGuardWave(
          map.id,
          String(runtime.vehicleId || ''),
          nextWave,
          Number(runtime.requireLevel ?? 100),
        );
        lines.push(`${playerName}击破了守卫！第${nextWave}波守卫从遗迹中苏醒……`);
      } else {
        // 全波击破：解除封印，唤醒者直接获得归属
        delete runtime.sealed;
        delete runtime.sealWave;
        delete runtime.sealWaker;
        runtime.sealed = false;
        runtime.owner = waker;
        vehicles[i] = this.toStoredVehicle(runtime);
        changed = true;
        lines.push(`${playerName}击破了全部守卫，${runtime.name}的封印解除了！`);
        const wakerData = await this.playerService.getPlayerData(Number(waker)).catch(() => null);
        if (wakerData?.player) {
          await this.achievementService.addAchievement(wakerData.player, '遗迹征服者', 1);
        }
      }
    }
    if (changed) {
      await this.mapService.updateDynamicFields(map.id, { vehicles });
    }
    return lines.join('\n');
  }

  /**
   * 处理「唤醒 载具名」：
   * 首次 → 展示确认（战斗对象 + 消耗），编号 1 或「确认唤醒 …」进入下一步；
   * 确认 → 资格校验 → 献祭(凭证+活力) → 刷守卫 → 自动开打。
   */
  async handleWakeWreck(userId: number, vehicleName: string, options: { confirmed?: boolean } = {}): Promise<string> {
    const rawName = String(vehicleName ?? '').trim();
    let name = rawName;
    let confirmed = options.confirmed === true;
    // 「确认唤醒 载具名」 / 指令里带确认前缀
    if (/^确认/.test(name)) {
      confirmed = true;
      name = name.replace(/^确认/, '').trim();
    }
    if (!name) {
      return '请指定载具名称，格式：唤醒 载具名';
    }
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';
    const playerName = player.name || '冒险者';

    const vehicles = this.parseVehicleValue<any[]>(map.vehicles, []);
    const keys = (v: any): string[] =>
      [v?.vehicleId, v?.id, v?.name]
        .filter((k) => k !== undefined && k !== null && String(k) !== '')
        .map(String);
    const index = vehicles.findIndex((v: any) => keys(v).includes(String(name)));
    if (index < 0) return `${playerName}附近没有${name}`;

    const runtime = this.toRuntimeVehicle(vehicles[index]);
    const owner = String(runtime.owner ?? '');
    if (owner !== '无主') {
      return `${playerName}${runtime.name}已有归属，无需唤醒`;
    }

    const flags = await this.getWreckSealFlags();
    const isAdmin = await this.isAdminUser(userId);
    let sealInfo = await this.resolveWreckSealInfo(runtime);
    if (sealInfo && !sealInfo.sealed) {
      return `${playerName}${runtime.name}的封印已解除，可直接「驾驶」认领`;
    }
    // 存量未盖戳且总开关关闭：按普通无主处理
    if (!sealInfo && !flags.sealEnabled) {
      return `${playerName}${runtime.name}不是被封印的远古遗迹`;
    }
    if (!sealInfo) {
      // 无配置可回查：允许管理员按最低门槛唤醒，普通玩家不拦
      if (!isAdmin) {
        return `${playerName}${runtime.name}的封印状态未知，无法唤醒`;
      }
      sealInfo = { requireLevel: 1, guardWaves: 1, vouchers: 1, vitality: 2, sealed: true };
    }

    const currentWave = Number(runtime.sealWave ?? 0) || 0;
    const waker = String(runtime.sealWaker ?? '');
    // 守卫仍在：提示继续战斗，不重复献祭
    if (currentWave > 0 && waker) {
      const remaining = await this.countSealGuards(map.id, String(runtime.vehicleId || ''));
      if (remaining > 0) {
        return `${playerName}${runtime.name}的守卫仍在（第${currentWave}/${sealInfo.guardWaves}波），请先「攻击 遗迹守卫」`;
      }
      // 守卫已清但未推进（例如上次击杀钩子未触发）：本地推进
      const progress = await this.advanceWreckSealAfterKill(map.id);
      if (progress) return `${playerName}收到了遗迹回响：\n${progress}`;
    }

    if (flags.levelGate && !isAdmin && Number(player.level || 0) < sealInfo.requireLevel) {
      return `${playerName}无法唤醒${runtime.name}：需要等级 Lv.${sealInfo.requireLevel}（当前 Lv.${player.level || 1}）`;
    }

    const cost = this.scaleSealCost(
      { vouchers: sealInfo.vouchers, vitality: sealInfo.vitality },
      flags.costFactor,
    );
    const ownedVouchers = this.countBackpackItem(player, '凭证');
    if (ownedVouchers < cost.vouchers) {
      return `${playerName}唤醒${runtime.name}缺少贡品：凭证x${cost.vouchers - ownedVouchers}`;
    }
    const ownedVitality = Number(player.vitality || 0);
    if (ownedVitality < cost.vitality) {
      return `${playerName}唤醒${runtime.name}活力不足：需要${cost.vitality}点活力（当前${ownedVitality}）`;
    }

    const vehicleId = String(runtime.vehicleId || `V${index}`);
    // ========== 首次唤醒：只展示确认，不扣材料、不刷怪 ==========
    if (!confirmed) {
      const menu = await this.support.buildNumberedMenu(
        userId,
        [
          {
            label: '确认唤醒',
            cmd: `确认唤醒 ${vehicleId}`,
          },
        ],
        '💡 发送编号数字 1 确认唤醒（取消可忽略）',
        [`确认唤醒@确认唤醒${vehicleId}`],
      );
      return [
        `${playerName}即将唤醒远古遗迹「${runtime.name}」（Lv.${sealInfo.requireLevel}），请确认：`,
        `◆战斗：第1/${sealInfo.guardWaves}波遗迹守卫将从遗迹中苏醒（等级≈Lv.${sealInfo.requireLevel}），唤醒后自动进入战斗`,
        `◆消耗：凭证x${cost.vouchers}、活力${cost.vitality}点（失败不返还）`,
        `◆当前持有：凭证x${ownedVouchers}、活力${Math.floor(ownedVitality)}点`,
        ...menu,
      ].join('\n');
    }

    const removed = await this.playerService.removeFromBackpack(userId, '凭证', cost.vouchers);
    if (!removed) {
      return `${playerName}唤醒${runtime.name}缺少贡品：凭证x${cost.vouchers}`;
    }
    player.vitality = Math.max(0, ownedVitality - cost.vitality);
    await this.playerService.savePlayer(player);

    runtime.sealWave = 1;
    runtime.sealWaker = String(userId);
    vehicles[index] = this.toStoredVehicle(runtime);
    await this.mapService.updateDynamicFields(map.id, { vehicles });
    await this.spawnWreckGuardWave(map.id, vehicleId, 1, sealInfo.requireLevel);

    // 唤醒即开打：自动对遗迹守卫发起一次攻击
    let autoBattle = '第1波守卫从遗迹中苏醒……';
    try {
      const weaponIndex = Number(player.currentWeapon ?? 0) > 0 ? Number(player.currentWeapon) : 0;
      const attack = await this.combatSystem.weaponAttack(userId, weaponIndex, {
        targetName: '遗迹守卫',
      });
      autoBattle = attack?.result
        ? `第1波守卫从遗迹中苏醒……\n${attack.result}`
        : autoBattle;
    } catch (e: any) {
      this.logger.warn(`唤醒自动攻击失败: ${e?.message ?? e}`);
      autoBattle += '\n（自动攻击未触发，可手动发送「攻击 遗迹守卫」）';
    }

    return `${playerName}开始唤醒${runtime.name}！献祭了凭证x${cost.vouchers}与${cost.vitality}点活力。\n${autoBattle}`;
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
      value?.vehicleId, value?.id, value?.name,
    ].filter((key) => key !== undefined && key !== null && String(key) !== '').map(String);
    const matchesVehicle = (value: any): boolean => vehicleKeys(value).includes(String(vehicleName));
    const ownerOf = (value: any): string => String(value?.owner ?? '');
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
      return `${playerName}这是别人的${source.runtime.name}，你不能驾驶`;
    }

    const runtime = source.runtime;
    const targetKeys = new Set(vehicleKeys(runtime));
    if (source.kind === 'db') targetKeys.add(String(source.db.id));
    const oldVehicleKey = String(player.vehicle || '');
    const targetWasUnowned = ownerOf(runtime) === '无主';
    // 远古遗迹封印：首次认领无主残骸前拦截（管理员绕过）
    if (targetWasUnowned) {
      const flags = await this.getWreckSealFlags();
      const isAdmin = await this.isAdminUser(userId);
      const sealInfo = await this.resolveWreckSealInfo(runtime);
      if (!isAdmin && sealInfo) {
        if (flags.sealEnabled && sealInfo.sealed) {
          if (flags.levelGate && Number(player.level || 0) < sealInfo.requireLevel) {
            return `${playerName}被远古禁制弹开：需要等级 Lv.${sealInfo.requireLevel}才能唤醒${runtime.name}（当前 Lv.${player.level || 1}）`;
          }
          return `${playerName}被远古禁制弹开：${runtime.name}被远古禁制封印，请先发送「唤醒 ${runtime.name}」`;
        }
        if (flags.levelGate && Number(player.level || 0) < sealInfo.requireLevel) {
          return `${playerName}被远古禁制弹开：需要等级 Lv.${sealInfo.requireLevel}才能唤醒${runtime.name}（当前 Lv.${player.level || 1}）`;
        }
      }
    }
    let mapChanged = false;
    const summons = this.parseVehicleValue<any[]>(map?.summons, []);
    const dbUpdates: Promise<any>[] = [];

    // 原版 L10328-L10340：先让原驾驶员离开目标载具；玩家和召唤物分别清除自己的载具字段。
    const previousDriver = String(runtime.driver ?? '');
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
          unit?.QQ, unit?.qq, unit?.id,
        ].filter(Boolean).map(String).includes(previousDriver));
        if (summon) {
          summon.vehicle = '';
          mapChanged = true;
        }
      }
    }

    // 原版 L10346-L10350：驾驶新载具时清除玩家原来载具的驾驶员。
    if (oldVehicleKey && !targetKeys.has(oldVehicleKey)) {
      const oldMapIndex = mapVehicles.findIndex((unit: any) => vehicleKeys(unit).includes(oldVehicleKey));
      if (oldMapIndex >= 0) {
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

    runtime.driver = driverId;
    if (targetWasUnowned) {
      runtime.owner = driverId;
      // 管理员直接认领时顺带清封印态，避免残留 sealed 字段干扰后续判读
      if (runtime.sealed === true) {
        runtime.sealed = false;
        runtime.sealWave = 0;
        delete runtime.sealWaker;
      }
    }
    if (source.kind === 'map') {
      mapVehicles[source.index] = this.toStoredVehicle(runtime);
      mapChanged = true;
    } else {
      dbUpdates.push(this.prisma.gameVehicle.update({
        where: { id: source.db.id },
        data: {
          owner: String(runtime.owner || ''),
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
      : String(runtime.vehicleId || runtime.id || '');
    const sets = this.parseVehicleValue<any>(player.sets, {});
    // 原版 L10314：驾驶成功后立即终止接管状态。
    sets.takeVehicle = '';
    sets.接管载具 = '';
    player.sets = sets;
    await this.playerService.savePlayer(player);

    if (targetWasUnowned) {
      await this.achievementService.addAchievement(player, '拾取载具', 1);
      await this.taskService.advance(userId, '拾取载具' + runtime.name);
    }
    await this.achievementService.addAchievement(player, '驾驶载具', 1);
    await this.taskService.advance(userId, '驾驶' + runtime.type);

    const vehicleText = `${runtime.name}(${runtime.type})`;
    const result = targetWasUnowned
      ? `${playerName}获取了${runtime.name}的权限,然后进入了${vehicleText}的驾驶舱,"脱出"来离开`
      : `${playerName}进入了${vehicleText}的驾驶舱,"脱出"来离开`;
    this.logger.log(`玩家 ${userId} 驾驶了载具 ${runtime.name}`);
    return result;
  }

  /** 解析“核心1 轻型足2”式载具模拟参数；首个零件固定需要1个，其余取尾部数字。 */

  parseVehicleAssemblyParts(parts: string[]): any[] {
    return parts.map((rawPart, index) => {
      const value = String(rawPart || '').trim();
      const name = index === 0 ? value.replace(/\d+/g, '') : value.replace(/\d+(?=\s*$)/, '').trim();
      const quantity = index === 0 ? 1 : Math.trunc(Number(value.match(/(\d+)\s*$/)?.[1] || 0));
      return { name, type: '资源', quantity };
    }).filter((part) => part.name && Number.isFinite(part.quantity) && part.quantity > 0);
  }


  async craftVehiclePart(
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
      return rows.map((row: any) => {
        const name = row?.name;
        // Issue #11：产出/需求缺 type 时对齐静态物品定义（经验胶囊=物品），
        // 防止默认“资源”与 item-system 路径（determineItemType=物品）分叉，
        // 造成同名不同 type 的背包条目永不合并。
        const staticType = name
          ? (this.staticData.getEquipmentByName(name) ? '装备' : this.staticData.getItemByName(name)?.type)
          : undefined;
        const type = row?.type ?? staticType ?? '资源';
        return {
          ...row,
          name,
          type,
          // 数量只读规范键 quantity（count 为历史遗留同义键，静态数据已统一为 quantity）
          quantity: Number(row?.quantity ?? 0),
        };
      }).filter((row: any) => row.name && Number.isFinite(row.quantity));
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
      const owned = await this.panel.backpackQuantity(backpack, requirement.name);
      if (owned < required) insufficient.push(`需要${requirement.name} ×${required}，你只有${owned}`);
    }
    if (insufficient.length > 0) return { success: false, text: insufficient.join('\n') };
    if (dryRun) return { success: true, text: '' };

    for (const requirement of requirements) {
      let remaining = requirement.quantity * count;
      for (let index = backpack.length - 1; index >= 0 && remaining > 0; index--) {
        const item = backpack[index];
        if (item?.name !== requirement.name) continue;
        const current = Number(item.quantity ?? 0);
        const removed = Math.min(current, remaining);
        remaining -= removed;
        if (current - removed <= 0) backpack.splice(index, 1);
        else {
          item.quantity = current - removed;
        }
      }
    }

    const producedTexts: string[] = [];
    for (const output of outputs) {
      const outputQuantity = output.quantity * count;
      const outputItem = {
        ...output,
        quantity: outputQuantity,
      };
      await this.panel.addBackpackItem(backpack, outputItem);
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
    const coreSpec = this.staticData.getVehiclePartSpecByName(requiredParts[0].name);
    if (!coreSpec || !String(requiredParts[0].name).replace(/\d+$/, '').endsWith('核心')) {
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
      // 与其他指令同源：走 deathGateText（含 卷土重来免死 / 军姬·死亡行者·石中剑 半血复活
      // 级联），不再硬编码死亡文案 —— 否则这些复活机制在载具组装指令上失效。
      const deathText = await this.playerService.deathGateText(player);
      if (deathText) return deathText;
    }

    if (await this.hasOwnedProductionVehicle(ownerQQ, coreSpec)) {
      return `${playerName}一个玩家只能同时存在一个生产类载具，你可以在普通载具上组装生产线，一样有生产的效果。`;
    }

    const backpack = this.playerService.getBackpackItems(player);
    const temporaryBackpack = JSON.parse(JSON.stringify(backpack));
    const missingParts: any[] = [];
    for (const part of requiredParts) {
      const owned = await this.panel.backpackQuantity(temporaryBackpack, part.name);
      if (owned >= part.quantity) continue;
      const stillMissing = part.quantity - owned;
      missingParts.push({ ...part, quantity: stillMissing });
    }

    let aborted = false;
    let failureText = '';
    for (const part of missingParts) {
      const dryRun = await this.craftVehiclePart(player, temporaryBackpack, markers, part.name, part.quantity, true);
      if (!dryRun.success) {
        failureText += failureText
          ? `、${part.name}x${part.quantity}`
          : `\n缺少这些物品，并且背包里面的数量不够/背包里面的资源不足以制造缺少的数量：${part.name}x${part.quantity}`;
        aborted = true;
      }
    }
    if (aborted) return `${playerName}${failureText}`;

    const craftTexts: string[] = [];
    for (const part of missingParts) {
      const crafted = await this.craftVehiclePart(player, backpack, markers, part.name, part.quantity, false);
      if (crafted.text) craftTexts.push(crafted.text);
    }

    const timestamp = Date.now();
    const runtime = this.toRuntimeVehicle({});
    runtime.parts = requiredParts.map((part) => ({ ...part }));
    runtime.recipes = [{ name: '1', value: timestamp }];
    runtime.vehicleId = `V${timestamp.toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    runtime.owner = ownerQQ;
    this.combatSystem.recalculateVehicle(runtime, timestamp);
    const calculatedHp = Number(runtime.bonus?.生命 || 0);
    runtime.currentHp = calculatedHp;
    runtime.maxHp = calculatedHp;
    runtime.name = `${playerName}的${String(requiredParts[0].name).replace('核心', '')}`;

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${playerName}不在任何地图上`;
    const vehicles = this.parseVehicleValue<any[]>(map.vehicles, []);
    vehicles.push(this.toStoredVehicle(runtime));
    await this.mapService.updateDynamicFields(map.id, { vehicles });

    for (const part of requiredParts) {
      let remaining = part.quantity;
      for (let index = backpack.length - 1; index >= 0 && remaining > 0; index--) {
        const item = backpack[index];
        if (item?.name !== part.name) continue;
        const current = Number(item.quantity ?? 0);
        const removed = Math.min(current, remaining);
        remaining -= removed;
        if (current - removed <= 0) backpack.splice(index, 1);
        else {
          item.quantity = current - removed;
        }
      }
    }
    player.backpack = backpack; // Json 列直接写数组
    player.markers = markers; // Json 列直接写对象
    await this.playerService.savePlayer(player);

    await this.achievementService.addAchievement(player, '组装载具', 1);
    await this.taskService.advance(userId, `组装${requiredParts[0].name}`, 1);

    return [`${playerName}组装了一个载具：${runtime.name}`, ...craftTexts].filter(Boolean).join('\n');
  }


  async hasOwnedProductionVehicle(ownerQQ: string, coreSpec: any): Promise<boolean> {
    if (!(Number(coreSpec?.partType) === 0 && Number(coreSpec?.bonus?.生产 || 0) !== 0)) return false;
    const maps = await this.mapService.getAllMaps();
    return maps.some((map: any) => this.parseVehicleValue<any[]>(map?.vehicles, []).some((vehicleRaw: any) => {
      if (String(vehicleRaw?.owner ?? '') !== ownerQQ) return false;
      const vehicle = this.toRuntimeVehicle(vehicleRaw);
      return Number(vehicle.bonus?.生产 || 0) !== 0 || (vehicle.parts || []).some((part: any) => {
        const spec = this.staticData.getVehiclePartSpecByName(part.name);
        return Number(spec?.partType) === 0 && Number(spec?.bonus?.生产 || 0) !== 0;
      });
    }));
  }

  /**
   * 处理载具命名命令
   * 给当前驾驶的载具命名
   * 对应原版：载具命名 命令
   */

  async handleNameVehicle(userId: number, argument: string): Promise<string> {
    // 原版 L10355-10381：「载具命名 旧名 新名」——按当前地图归属匹配，不依赖驾驶状态。
    const tokens = String(argument || '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) {
      return `请发送“载具命名骑士 坦克”来把名为【骑士】的载具名称修改为【坦克】`;
    }
    const oldName = tokens[0];
    const newName = tokens[1];
    if (!newName) return '名字不能为空';
    if (newName === '原') return '不能改成这个';

    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const ownerIds = new Set(
      [String(userId), String(user?.qqNumber || ''), String(user?.externalId || ''), String(player.masterQQ || '')]
        .filter(Boolean),
    );
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${player.name || '冒险者'}不在服务区`;

    const vehicles = this.parseVehicleValue<any[]>(map.vehicles, []);
    const index = vehicles.findIndex((item: any) => {
      const name = String(item?.name ?? '');
      const owner = String(item?.owner ?? '');
      return name === oldName && ownerIds.has(owner);
    });
    if (index < 0) {
      return `${player.name || '冒险者'},${map.name || '当前地图'}没有名为【${oldName}】的载具`;
    }

    const runtime = this.toRuntimeVehicle(vehicles[index]);
    runtime.name = newName;
    vehicles[index] = this.toStoredVehicle(runtime);
    await this.mapService.updateDynamicFields(map.id, { vehicles });

    // 若该载具正在被驾驶，同步 player.vehicle 键（编号不变，通常无需改）
    this.logger.log(`玩家 ${userId} 将载具 ${oldName} 更名为 ${newName}`);
    return `${player.name || '冒险者'},${oldName}名称修改为${newName}`;
  }

  /**
   * 处理载具模拟命令
   * 模拟载具装配后的性能表现
   * 对应原版：载具模拟 命令
   */

  async handleSimulateVehicle(userId: number, targetName: string): Promise<string> {
    // 原版 _主程序.ecode L10385-10395 + 数据分析.ecode L114-156 载具模拟：
    // 「载具模拟 巡洋舰核心1 中型推进器1 平定者1」按部件清单模拟整备性能，
    // 核心必须在最前；并输出 制造成本（消耗材料）。无参时给出原版提示。
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const playerName = player.name || '冒险者';
    const payload = String(targetName || '').trim().replace(/[,，]/g, ' ').trim();
    if (!payload) {
      return `${playerName}\n“载具模拟巡洋舰核心1 中型推进器1 平定者1”来模拟，注意核心必须在最前`;
    }

    await this.taskService.advance(userId, '载具模拟');

    // 解析「部件名 数量」列表（原版 去数字/取数字）
    const tokens = payload.split(/\s+/).filter(Boolean);
    const simParts: { name: string; type: string; quantity: number; durability: number }[] = [];
    const invalidParts: string[] = [];
    for (const token of tokens) {
      const m = token.match(/^(.*?)(\d+)$/);
      const name = (m ? m[1] : token).trim();
      const qty = m ? Number(m[2]) : 1;
      if (!name || qty < 1) continue;
      if (!this.staticData.getVehiclePartByName(name)) {
        invalidParts.push(`【${name}不是载具部件】`);
        continue;
      }
      const exist = simParts.find((p) => p.name === name);
      if (exist) exist.quantity += qty;
      else simParts.push({
        name,
        type: '资源',
        quantity: qty,
        durability: 100,
      });
    }
    if (simParts.length === 0) {
      return `${playerName}“载具模拟巡洋舰核心1 中型推进器1 平定者1”来模拟，注意核心必须在最前`;
    }
    if (!String(simParts[0].name).endsWith('核心')) {
      return `${playerName}核心必须在最前面`;
    }

    const productionBonus = this.achievementService.getAchievement(
      asJsonValue<any>(player.markers, {}),
      '生产',
    );
    const runtime = this.toRuntimeVehicle({
      name: '模拟载具',
      vehicleId: 'SIM',
      parts: simParts,
      recipes: [],
      bonus: {},
      markers2: [],
    });
    this.combatSystem.recalculateVehicle(runtime, 0, productionBonus);
    const cost = this.calcManufactureCost(simParts.map((p) => ({ name: p.name, quantity: p.quantity })));
    const costText = cost.length > 0
      ? cost.map((c) => `${c.name}x${this.support.round2Text(c.quantity)}`).join('、')
      : '无';
    const detail = await this.formatVehicleDetail(runtime);
    // 模拟结果可直接落地：临时输入 1 → 组装（原版多零件组装路径）
    if (this.shortcutService?.setTempInput) {
      await this.shortcutService.setTempInput(userId, `1@组装 ${payload}#组装 ${payload}`);
    }
    return [
      detail,
      `消耗材料:${costText}`,
      ...invalidParts,
      '💡 发送 1 或“组装”+相同部件清单，用背包材料直接组装该载具（缺件会自动制造）',
    ].filter(Boolean).join('\n');
  }

  /** 取制造成本：零件按 craftings 需求折算（原版 数据分析.ecode L157-179）。 */
  private calcManufactureCost(parts: Array<{ name: string; quantity: number }>): Array<{ name: string; quantity: number }> {
    const craftings = this.staticData.getAllCraftings();
    const acc = new Map<string, number>();
    for (const p of parts) {
      const recipe = craftings.find((c: any) => c.name === p.name);
      if (!recipe) continue;
      const reqs = asJsonValue<any[]>(recipe.requirements, []);
      for (const req of reqs) {
        const reqName = String(req?.name ?? '');
        // 需求数量只读规范键 quantity（count 为历史遗留同义键）
        const reqQuantity = Number(req?.quantity ?? 0);
        if (!reqName || !Number.isFinite(reqQuantity)) continue;
        acc.set(reqName, (acc.get(reqName) ?? 0) + reqQuantity * Number(p.quantity || 1));
      }
    }
    return Array.from(acc, ([name, quantity]) => ({ name, quantity }))
      .sort((a, b) => b.quantity - a.quantity);
  }

  /**
   * 处理牵引命令（原版 _主程序.ecode L7722-L7808）。
   * 需驾驶且载具有生命；大型牵引光束/牵引光束决定档位与次数预算；
   * 6 秒冷却后对世界中的「货舱」或「能量元素」连续采集。
   */
  async handleTractorBeam(userId: number, target: string = ''): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers2 } = playerData;
    const playerName = player.name || '冒险者';
    const kind = String(target || '').trim();

    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return `${playerName}不在任何地图上`;
    const vehicle = await this.findTravelVehicle(player, map);
    if (!vehicle) return `${playerName}需要驾驶载具`;
    const vehicleName = String(vehicle.name ?? '载具');
    if (Number(vehicle.currentHp ?? 0) <= 0) {
      return `${playerName}载具需要“维修”`;
    }
    this.combatSystem.recalculateVehicle(vehicle, Date.now());

    // 行动无限制（理由5=躺下豁免，原版 L7730）
    const restrict = this.combatSystem.actionUnrestricted(player, { ignoreReason: 5, cannonOk: true });
    if (restrict.restricted) return restrict.text;

    // 部件档位：大型牵引光束=2/24次，牵引光束=1/6次（含内置）
    const partNames = this.panel.collectVehiclePartNames(vehicle);
    let tier = 0;
    let budget = 0;
    if (partNames.includes('大型牵引光束')) {
      tier = 2;
      budget = 24;
    } else if (partNames.includes('牵引光束')) {
      tier = 1;
      budget = 6;
    }
    if (tier === 0) {
      if (this.shortcutService?.setTempInput) {
        await this.shortcutService.setTempInput(userId, '1@制造牵引光束#2@制造大型牵引光束');
      }
      return `${playerName}${vehicleName}需要安装牵引光束或大型牵引光束\n(输入 1 前往制造牵引光束)`;
    }

    // 6 秒冷却（原版 L7745）
    const cdText = { value: '' };
    if (this.combatState.timeIntervalRequire('牵引', 6, markers2, Date.now(), cdText, Date.now())) {
      player.markers2 = markers2;
      await this.playerService.savePlayer(player);
      const beamName = tier === 1 ? '牵引光束' : '大型牵引光束';
      return `${playerName}${vehicleName}的${beamName}正在散热,${cdText.value}`;
    }
    player.markers2 = markers2;

    // 货舱 / 能量（原版 L7753-L7758）
    let gatherCmd = '';
    let resourceName = '';
    if (kind === '货舱') {
      gatherCmd = '打开货舱';
      resourceName = '货舱';
    } else if (kind === '能量') {
      gatherCmd = '收集能量';
      resourceName = '能量元素';
    } else {
      await this.playerService.savePlayer(player);
      return `${playerName}“牵引货舱”或“牵引能量”来牵引世界中的补给`;
    }

    // 大型光束每次可拉走更多（原版 L7788-L7796：g2=min(5, d/4)）
    const pullBudget = tier === 2 ? Math.min(5, Math.floor(budget / 4)) || 1 : 1;
    const lines: string[] = [];
    let pulls = 0;
    let remain = budget;
    const maps = await this.mapService.getAllMaps();
    while (remain > 0) {
      // 原版遍历地图找 资源2 中的 w4；跳过非开拓地之外的家园相关图
      const targetMap = maps.find((m: any) => {
        if (!m) return false;
        const isPioneer = Boolean(m.开拓地 ?? m.isPioneer ?? false);
        if (isPioneer) {
          const home = String(player.houseName || '');
          const n = String(m.name || '');
          if (home && (n === home || n === `${home}屋内` || n === `${home}前线`)) return false;
        }
        const resources = this.getTractorResources(m);
        return resources.some((r: any) => {
          const name = String(r?.name ?? '');
          const times = Number(r?.times ?? r?.amount ?? 0);
          return name === resourceName && times !== 0;
        });
      });
      if (!targetMap) {
        lines.push(`${playerName}没有可以牵引的${resourceName}了`);
        break;
      }
      const pulled = await this.pullTractorResource(
        userId,
        player,
        targetMap,
        resourceName,
        gatherCmd,
        Math.min(pullBudget, remain),
      );
      if (pulled.count <= 0) {
        lines.push(`${playerName}没有可以牵引的${resourceName}了`);
        break;
      }
      remain -= pulled.count;
      pulls += pulled.count;
      lines.push(pulled.text);
    }

    await this.playerService.savePlayer(player);
    if (pulls <= 0 && lines.length === 0) {
      return `${playerName}没有可以牵引的${resourceName}了`;
    }
    return lines.join('\n') || `${playerName}牵引失败`;
  }

  /** 地图上可被牵引的目标资源（统一 resources / resources2）。 */
  private getTractorResources(map: any): any[] {
    const a = asJsonValue<any[]>(map?.resources, []);
    const b = asJsonValue<any[]>(map?.resources2, []);
    return [...a, ...b];
  }

  /**
   * 对指定地图上的资源做一次即时牵引采集（原版 采集资源 的同步简化）。
   * 大型牵引光束一次可多次结算；产出进背包并扣减地图次数。
   */
  private async pullTractorResource(
    userId: number,
    player: any,
    map: any,
    resourceName: string,
    gatherCmd: string,
    times: number,
  ): Promise<{ count: number; text: string }> {
    const resourcesKey: 'resources' | 'resources2' = ((): 'resources' | 'resources2' => {
      const inRes = asJsonValue<any[]>(map.resources, []).some((r: any) => String(r?.name ?? '') === resourceName);
      return inRes ? 'resources' : 'resources2';
    })();
    const backpack = this.playerService.getBackpackItems(player);
    let pulled = 0;
    const got = new Map<string, number>();

    const mutateKey = resourcesKey;
    await this.mapService.mutateMapFields(map.id, [mutateKey], (f) => {
      const list = f[mutateKey] as any[];
      const idx = list.findIndex((r: any) => String(r?.name ?? '') === resourceName);
      if (idx < 0) return false;
      const r = list[idx];
      const outputs = asJsonValue<any[]>(r?.outputs, []);
      let budget = Math.max(1, Math.floor(times));
      let changed = false;
      while (budget > 0) {
        const timesLeft = Number(r?.times ?? r?.amount ?? 0);
        // 次数耗尽；-1=无限资源（野外木石），仍受单次预算与牵引冷却限制，不会无冷却刷
        if (timesLeft === 0) break;
        for (const out of outputs) {
          const name = String(out?.name ?? '');
          // 产出数量只读规范键 quantity（count 为历史遗留同义键）
          const qty = Number(out?.quantity ?? 0);
          const chance = Number(out?.chance ?? 100);
          if (!name || qty <= 0) continue;
          if (Math.random() * 100 >= chance) continue;
          this.addBackpackItem(player, backpack, name, qty);
          got.set(name, (got.get(name) || 0) + qty);
        }
        // 次数-1（-1=无限）
        if (timesLeft > 0) {
          const next = timesLeft - 1;
          r.times = next;
          r.amount = next;
          if (next <= 0) {
            list.splice(idx, 1);
          }
        }
        budget -= 1;
        pulled += 1;
        changed = true;
      }
      return changed;
    });

    if (pulled <= 0) return { count: 0, text: '' };
    player.backpack = backpack;
    await this.achievementService.addAchievement(player, '牵引', pulled);
    await this.taskService.advance(userId, gatherCmd === '打开货舱' ? '打开货舱' : '牵引' + resourceName, pulled);
    const loot = [...got.entries()].map(([n, q]) => `${n}x${this.support.round2Text(q)}`).join('、') || '无';
    return {
      count: pulled,
      text: `${player.name || '冒险者'}从${map.name}牵引了${resourceName}x${pulled}，获得:${loot}`,
    };
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

    { const __dt = await this.playerService.deathGateText(player); if (__dt) return __dt; }

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
      return `${name}，${vehicle.name}安装的${overLimit}超过了上限，无法维修`;
    }

    const fullHp = Number(vehicle.bonus?.生命 || 0) || this.rescue.rescueVehicleMaxHp(vehicle);
    if (fullHp > 0 && Number(vehicle.currentHp ?? 0) === fullHp) {
      return `${name}还不需要修`;
    }

    // 耗时：基础 20 秒；小雫/小凰/小蓝/小粉 各 -5 秒（原版 L10431-10443）
    const partNames = this.panel.collectVehiclePartNames(vehicle);
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
    return `${name}正在维修${vehicle.name},大概需要${seconds}秒`;
  }

  /**
   * 维修延时结算（原版「维修wcc1」L10462-10489）：
   * 延时到期后重发「维修 wcc1」——仍需驾驶载具（弹射/超上限拦截同入口），
   * 通过后用0载具零件把载具修好（计算载具重算加成 → 满血 → 成就维修载具）。
   * 结算文本经世界频道广播（延时路径无指令收尾）。
   * 支柱二：dts tick 直调无外层锁，入口自串行（指令路径重入放行）。
   */

  async completeVehicleRepair(userId: number): Promise<string> {
    return this.playerService.enqueueUserWrite(userId, () =>
      this.applyCompleteVehicleRepair(userId));
  }


  async applyCompleteVehicleRepair(userId: number): Promise<string> {
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
      return `${name}，${vehicle.name}安装的${overLimit}超过了上限，无法维修`;
    }
    return this.applyVehicleRepair(userId, player, map, vehicle);
  }

  /**
   * 维修生效（原版 L10444-10445 / L10484-10488）：计算载具重算加成 → 当前生命=加成.生命
   * → 成就维修载具+1 → 回复“用0载具零件修好了X（类型）”。
   * 载具优先写回地图 vehicles JSON，DB 载具兜底直更 currentHp/maxHp。
   */

  async applyVehicleRepair(userId: number, player: any, map: any, vehicle: any): Promise<string> {
    this.combatSystem.recalculateVehicle(vehicle, Date.now());
    const fullHp = Number(vehicle.bonus?.生命 || 0) || this.rescue.rescueVehicleMaxHp(vehicle);
    vehicle.currentHp = fullHp;
    if (fullHp > 0) {
      vehicle.maxHp = fullHp;
    }

    const vehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
    const key = String(vehicle.vehicleId ?? vehicle.id ?? vehicle.name ?? '');
    const matches = (value: any): boolean => [
      value?.vehicleId, value?.id, value?.name,
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

    await this.support.advanceTask(userId, '维修载具');
    const vehicleType = String(vehicle.type ?? '');
    const typeText = vehicleType ? `（${vehicleType}）` : '';
    return `${player.name || '冒险者'}用0载具零件修好了${vehicle.name}${typeText}`;
  }

  /** 原版 L10419-10427 四类部件超上限拦截：按 功能→武器→行走→防御 顺序返回超限类别名。 */

  findVehicleOverLimitPart(vehicle: any): string {
    const parts = Array.isArray(vehicle?.parts)
      ? vehicle.parts
      : asJsonValue<any[]>(vehicle?.parts, []);
    // 安装写入的是 partType（0核心/1防御/2行走/3武器/4功能）；type 多为「资源/装备」标签，不能当槽位类型。
    const partTypeOf = (part: any): number => {
      const fromPartType = Number(part?.partType ?? part?.部件类型);
      if (Number.isFinite(fromPartType) && fromPartType > 0) return fromPartType;
      // 地图 JSON 中文部件可回落 静态规格
      const spec = this.staticData?.getVehiclePartSpecByName?.(String(part?.name ?? ''));
      return Number(spec?.partType ?? -1);
    };
    const count = (type: number): number =>
      parts.filter((part: any) => partTypeOf(part) === type).length;
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
      // 驾驶字段已空但接管状态残留时，顺带清掉，避免 findTravelVehicle 仍按接管载具拦移动
      const sets = this.parseVehicleValue<any>(player.sets, {});
      if (sets?.takeVehicle || sets?.接管载具) {
        sets.takeVehicle = '';
        sets.接管载具 = '';
        player.sets = sets;
        await this.playerService.savePlayer(player);
        return '你当前没有驾驶任何载具（已清理失效的接管状态）';
      }
      return '你当前没有驾驶任何载具';
    }

    const vehicleKey = String(player.vehicle);
    const map = await this.mapService.getMapById(player.mapId);
    const mapVehicles = this.parseVehicleValue<any[]>(map?.vehicles, []);
    const vehicleKeys = (value: any): string[] => [
      value?.vehicleId, value?.id,
    ].filter((key) => key !== undefined && key !== null && String(key) !== '').map(String);
    const index = mapVehicles.findIndex((value: any) => vehicleKeys(value).includes(vehicleKey));

    if (index >= 0) {
      const runtime = this.toRuntimeVehicle(mapVehicles[index]);
      runtime.driver = '';
      mapVehicles[index] = this.toStoredVehicle(runtime);
      await this.mapService.updateDynamicFields(map.id, { vehicles: mapVehicles });
      player.vehicle = '';
      await this.playerService.savePlayer(player);
      await this.achievementService.addAchievement(player, '脱出', 1);
      this.logger.log(`玩家 ${userId} 从载具 ${runtime.name} 中脱出`);
      return `${player.name}离开了${runtime.name}(${runtime.type})`;
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
      const identifiers = [item?.name, item?.vehicleId, item?.id]
        .filter((value) => value !== undefined && value !== null).map(String);
      const owner = String(item?.owner ?? '');
      return identifiers.includes(String(targetName)) && ownerIds.has(owner);
    };
    let vehicle: any = vehicles.find(match);
    let vehicleId = vehicle ? String(vehicle.vehicleId ?? vehicle.id ?? '') : '';

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

    const vehicleName = vehicle.name ?? targetName;
    this.logger.log(`玩家 ${userId} 接管了载具 ${vehicleName}`);
    return `${player.name || '冒险者'}已对${vehicleName}进行接管，现在无需驾驶即可拆装部件、设置生产\n“接管停止”可停止接管\n“驾驶”也可以中止接管`;
  }

  /**
   * 处理架炮命令
   * 架设载具火炮
   * 对应原版：架炮 命令
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
      [item?.vehicleId, item?.id].filter((value) => value !== undefined && value !== null).map(String).includes(takeover),
    );
    if (vehicle) vehicleName = vehicle.name ?? takeover;
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

  async handleDeployCannon(_userId: number, _targetName?: string): Promise<string> {
    // 原版 _主程序.ecode L9796-L9808：架炮=恶毒专属，切换 套装.攻击模式 0/1。
    // 不是“选载具武器架设”；炮击指令本身按攻击模式/舰炮判定。
    const playerData = await this.playerService.getPlayerData(_userId);
    const { player, markers2 } = playerData;
    const name = player.name || '冒险者';

    const isVenom = String(player.type || '') === '恶毒'
      || Number(player.specialSeq ?? player?.vitality ?? 0) === 6;
    if (!isVenom) {
      return `${name}这是恶毒的技能`;
    }

    const sets = this.parseVehicleValue<any>(player.sets, {}) || {};
    const current = Number(player.attackMode ?? sets.attackMode ?? sets.攻击模式 ?? 0);
    const next = current === 1 ? 0 : 1;
    sets.attackMode = next;
    sets.攻击模式 = next;
    player.sets = sets;
    player.attackMode = next;
    await this.playerService.savePlayer(player);

    // 架炮/收炮时解除炮击相关行动门禁（若存在「攻击模式」限时标记则清掉）
    if (Array.isArray(markers2)) {
      const kept = markers2.filter((m: any) => m && m.name !== '攻击模式');
      if (kept.length !== markers2.length) {
        player.markers2 = kept;
        await this.playerService.savePlayer(player);
      }
    }

    if (next === 1) {
      return `${name}架好了炮击阵地，“炮击森林出口”来指定攻击的区域`;
    }
    return `${name}收好了炮击阵地`;
  }

  /**
   * 处理模式转换命令
   * 载具模式转换（如战斗模式、移动模式等）
   * 对应原版：模式转换 命令
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
      String(vehicle?.id ?? vehicle?.vehicleId ?? '') === String(player.vehicle || ''),
    );
    const currentVehicleParts = asJsonValue<any[]>(currentVehicle?.parts, []);
    const hasCommunication = currentBuildings.some((building: any) =>
      building?.name === '通讯台',
    ) || currentVehicleParts.some((part: any) =>
      part?.name === '通讯台',
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
      unit?.ownerQQ ?? unit?.owner ?? '',
    ));
    const markerValue = (unit: any, markerName: string): number => {
      const raw = unit?.markers ?? {};
      const parsed = typeof raw === 'string' ? asJsonValue<any>(raw, {}) : raw;
      // 标记读取唯一口径（数组 [{name,value}] / 字典 {标记名:数值}），见 field-contract.util.ts
      return readMarkerValue(parsed, markerName);
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
        const label = candidate.unit.name ?? candidate.unit.type ?? '未命名';
        lines.push(`${(hasCommunication ? 2 : 0) + index + 1}、${label}(${candidate.map.name})`);
      });
      return lines.join('\n');
    }

    // 原版使用“宠物QQ/载具编号”快捷前缀；名称本身也可能以“宠物”开头，
    // 因此先保留完整名称命中，再解析快捷前缀，避免“宠物甲”被截成“甲”。
    const exactRawTarget = candidates.some((candidate) => {
      const unit = candidate.unit;
      return String(unit.qq ?? unit.QQ ?? unit.id ?? '') === rawTarget
        || (unit.name ?? '') === rawTarget
        || (unit.image ?? '') === rawTarget;
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
        const name = marker?.name;
        const rawExpire = Number(marker?.expireAt ?? 0);
        const expireSec = rawExpire > 100000000000 ? rawExpire / 1000 : rawExpire;
        return name === slot.name && expireSec > nowSec;
      });
      const markers2 = existingSlotMarkers.filter((marker: any) => {
        const name = marker?.name;
        if (name !== slot.name) return true;
        const rawExpire = Number(marker?.expireAt ?? 0);
        const expireSec = rawExpire > 100000000000 ? rawExpire / 1000 : rawExpire;
        return expireSec > nowSec;
      });
      const backpack = this.playerService.getBackpackItems(player);
      let merchantLevel = 0;
      let extraText = '';
      if (hadFreeCall) {
        const band = backpack.find((item: any) => item?.name === '发带');
        const bandCount = this.support.itemQuantity(band);
        if (bandCount < 1) return `${player.name || '冒险者'}${slot.message}`;
        const affinity = (10 + this.achievementService.getAchievement(markers, '购物') / 100) / 2;
        const maxLevel = 3 + Math.floor(affinity / 5);
        merchantLevel = bandCount >= maxLevel ? maxLevel : Math.trunc(bandCount);
        this.support.deductBackpackItem(backpack, '发带', merchantLevel);
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
          if (!triggerText) triggerText = `,并带来了更多物品。[行商好感触发,${this.support.round2Text(affinityChance)}%]`;
        }
      }
      const homeSummons = asJsonValue<any[]>(homeMap.summons, [])
        .filter((summon: any) => summon?.name !== '行商');
      const inventory = await this.shop.generateMerchantInventory(merchantLevel, extraCount);
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
        await this.support.advanceTask(userId, '呼叫行商', merchantLevel);
        await this.support.advanceTask(userId, '呼叫', merchantLevel);
      }
      return `行商来到了${homeMap.name}院子里${extraText}${triggerText}`;
    }

    if (target === '神之工匠') {
      const nowMs = Date.now();
      const nowSec = nowMs / 1000;
      const markers2 = jsonArray(player.markers2).filter((marker: any) => {
        const name = marker?.name;
        const rawExpire = Number(marker?.expireAt ?? 0);
        const expireSec = rawExpire > 100000000000 ? rawExpire / 1000 : rawExpire;
        return name !== '通讯4' || expireSec <= nowSec;
      });
      const hasCooldown = jsonArray(player.markers2).some((marker: any) => {
        const name = marker?.name;
        const rawExpire = Number(marker?.expireAt ?? 0);
        const expireSec = rawExpire > 100000000000 ? rawExpire / 1000 : rawExpire;
        return name === '通讯4' && expireSec > nowSec;
      });
      const backpack = this.playerService.getBackpackItems(player);
      if (hasCooldown) {
        const spirit = backpack.find((item: any) => item?.name === '灵石');
        if (this.support.itemQuantity(spirit) < 10) return `${player.name || '冒险者'}明天才能再次使用`;
        this.support.deductBackpackItem(backpack, '灵石', 10);
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
      return String(unit.qq ?? unit.QQ ?? unit.id ?? '') === target
        || (unit.name ?? '') === target
        || (unit.image ?? unit.type ?? '') === target;
    });
    if (!matched) return `${player.name || '冒险者'}你呼叫的对象${rawTarget}不在服务区`;

    if (matched.kind === 'pet') {
      // 对齐原版 L6045：先调用 计算幼崽 更新成长计时，再检查标记
      this.familiarSystemService.checkAndUpdateGrowth(matched.unit);
      if (markerValue(matched.unit, '阵地') !== 0) {
        return `${player.name || '冒险者'}\n${matched.unit.name}防御阵地不能移动`;
      }
      if (markerValue(matched.unit, '幼崽') !== 0) {
        return `${player.name || '冒险者'}\n${matched.unit.name}还是宝宝，不能离开家`;
      }
    } else if (Number(matched.unit.moveType ?? 0) === 4) {
      return `${player.name || '冒险者'}${matched.unit.name}安装了无法移动的组件`;
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
      const petVehicleId = matched.unit.vehicle ?? '';
      if (petVehicleId) {
        const vehicleIndex = sourceVehicles.findIndex((v: any) =>
          String(v.id ?? v.vehicleId ?? '') === String(petVehicleId),
        );
        if (vehicleIndex >= 0) {
          carriedVehicle = sourceVehicles[vehicleIndex];
          const carriedMoveType = Number(carriedVehicle.moveType ?? 0);
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
    const label = matched.unit.name ?? '对象';
    let result: string;
    if (matched.kind === 'pet') {
      const moveType = Number(carriedVehicle?.moveType ?? 0);
      const vehicleLabel = carriedVehicle?.name ?? '载具';
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
      const moveType = Number(matched.unit.moveType ?? 0);
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
    await this.support.advanceTask(userId, '呼叫');
    return result;
  }

  /**
   * 安装全部不占用位置的建筑。
   * 对应原版 _主程序.ecode L1859-1931；这里的“部件”是原版建筑资源，
   * 与「安装」命令的载具部件分支不同。
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
        options.push({ label: name, cmd: `查看载具 ${name}` });
      });
    }

    if (options.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━`);
      const menu = await this.support.buildNumberedMenu(userId, options, '💡 发送编号数字即可查看详情');
      lines.push(...menu);
    }
    return lines.join('\n');
  }

  /**
   * 我的载具：跨地图列出名下所有载具，并提供呼叫快捷指令。
   * 对应原版 呼叫 无参时的全图归属扫描（_主程序.ecode L5846-5859），但只列载具、不混宠物。
   */
  async handleMyVehicles(userId: number): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const ownerIds = new Set([
      String(userId),
      String(user?.qqNumber || ''),
      String(user?.externalId || ''),
      String(player.masterQQ || ''),
    ].filter(Boolean));
    const ownerOf = (unit: any): boolean => ownerIds.has(String(
      unit?.ownerQQ ?? unit?.owner ?? '',
    ));
    const currentKey = String(player.vehicle || '');

    const allMaps = await this.mapService.getAllMaps();
    const owned: Array<{ name: string; mapName: string; key: string; driving: boolean; moveType: number }> = [];
    for (const map of allMaps) {
      const vehicles = asJsonValue<any[]>(map.vehicles, []);
      for (const v of vehicles) {
        if (!ownerOf(v)) continue;
        const name = String(v?.name ?? '未命名');
        const key = String(v?.vehicleId ?? v?.id ?? name);
        const moveType = Number(v?.moveType ?? 0);
        const driving = currentKey !== '' && (currentKey === key || currentKey === String(v?.id ?? ''));
        owned.push({ name, mapName: String(map?.name ?? ''), key, driving, moveType });
      }
    }

    if (owned.length === 0) {
      return `${player.name || '冒险者'}你名下没有任何载具`;
    }

    const lines: string[] = [`🚗 ${player.name || '冒险者'}名下共 ${owned.length} 辆载具:`, '━━━━━━━━━━━━━━━'];
    const options: { label: string; cmd: string }[] = [];
    owned.forEach((v, index) => {
      const moveTag = v.moveType === 0 || v.moveType === 4 ? '坐地' : v.moveType === 2 ? '飞行' : v.moveType === 3 ? '跃迁' : '陆地';
      const statusTag = v.driving ? ' [驾驶中]' : '';
      lines.push(`  ${index + 1}. ${v.name} @${v.mapName} (${moveTag})${statusTag}`);
      options.push({ label: `${v.name}(${v.mapName})`, cmd: `呼叫载具${v.key}` });
    });
    lines.push('━━━━━━━━━━━━━━━');
    const menu = await this.support.buildNumberedMenu(userId, options, '💡 发送编号数字可呼叫该载具到身边');
    lines.push(...menu);
    return lines.join('\n');
  }

  /**
   * 查看载具详情（「查看 载具名」，「查看载具」编号菜单的落地指令）
   * 对应原版：地图链接 @查看+编号 → 显示载具（数据显示.ecode L2430-L2510）
   * 在当前地图载具中按 名称/编号 匹配（含无主废弃载具）；找不到时提示。
   */
  async handleViewVehicle(userId: number, vehicleName: string): Promise<string> {
    if (!vehicleName) {
      return '请指定载具名称，格式：查看 载具名（可先发送「查看载具」获取列表）';
    }
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    const map = await this.mapService.getMapById(player.mapId);
    if (!map) return '你不在任何地图上！';

    // 与 handleDriveVehicle 相同的键匹配口径：编号/vehicleId/名称 皆可命中
    const vehicles = this.parseVehicleValue<any[]>(map.vehicles, []);
    const keys = (v: any): string[] =>
      [v?.vehicleId, v?.id, v?.name]
        .filter((k) => k !== undefined && k !== null && String(k) !== '')
        .map(String);
    const index = vehicles.findIndex((v: any) => keys(v).includes(String(vehicleName)));
    if (index < 0) {
      return `${player.name || '冒险者'}附近没有${vehicleName}`;
    }
    const runtime = this.toRuntimeVehicle(vehicles[index]);
    // 归属判定口径与 handleDriveVehicle 一致（userId/qqNumber/externalId/masterQQ 皆算自己）
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const ownerIds = new Set(
      [String(userId), String(user?.qqNumber || ''), String(user?.externalId || ''), String(player.masterQQ || '')]
        .filter(Boolean),
    );
    const owner = String(runtime?.owner ?? '');
    const isOwn = ownerIds.has(owner);
    if (isOwn) {
      // 原版 L5765-5766：自己的载具 计算载具(..., 计算产出=真) 并写回地图；
      // 无主/他人载具仅临时重算不落库。
      await this.settleVehicleProduction(
        userId,
        player,
        { kind: 'map', map, index, raw: vehicles[index], runtime },
        runtime,
        map,
        asJsonValue<any>(player.markers, {}),
      );
    } else {
      this.combatSystem.recalculateVehicle(runtime, Date.now());
    }

    const detail = await this.formatVehicleDetail(runtime);
    // 原版查看载具尾部菜单（_主程序.ecode L5770-L5781）：
    // 自己的载具 → 1、载具操作（加成.生产>0 时追加 2、生产）；
    // 无主载具 → 1、获取权限（临时输入 1@驾驶+编号 / 获取权限@驾驶+编号）
    if (isOwn) {
      const options: { label: string; cmd: string }[] = [{ label: '载具操作', cmd: '载具操作' }];
      if (Number(runtime?.bonus?.生产 ?? 0) > 0) options.push({ label: '生产', cmd: '生产' });
      const menu = await this.support.buildNumberedMenu(userId, options, '💡 发送编号数字即可操作');
      return `${detail}\n${menu.join('\n')}`;
    }
    if (owner === '无主') {
      const vid = String(runtime?.vehicleId ?? vehicleName);
      const flags = await this.getWreckSealFlags();
      const sealInfo = await this.resolveWreckSealInfo(runtime);
      const isAdmin = await this.isAdminUser(userId);
      const sealed = flags.sealEnabled && !!sealInfo?.sealed;
      if (sealed) {
        const sealWave = Number(runtime?.sealWave ?? 0) || 0;
        const totalWaves = sealInfo?.guardWaves ?? 1;
        const statusLine = sealWave > 0
          ? `当前唤醒进度：第${sealWave}/${totalWaves}波守卫`
          : `需要「唤醒」后才能认领（凭证x${sealInfo?.vouchers ?? 1}、活力${sealInfo?.vitality ?? 2}点）`;
        const costNote = sealWave === 0
          ? `\n远古遗迹・被封印 Lv.${sealInfo?.requireLevel ?? '?'}\n${statusLine}`
          : `\n远古遗迹・守卫战中 Lv.${sealInfo?.requireLevel ?? '?'}\n${statusLine}`;
        const wakeMenu = await this.support.buildNumberedMenu(
          userId,
          [{ label: '唤醒遗迹', cmd: `唤醒 ${vid}` }],
          '💡 发送编号数字查看唤醒确认',
          ['唤醒@唤醒' + vid],
        );
        return `${detail}${costNote}\n${wakeMenu.join('\n')}`;
      }
      const menu = await this.support.buildNumberedMenu(
        userId,
        [{ label: '获取权限', cmd: `驾驶 ${vid}` }],
        '💡 发送编号数字即可获取权限',
        ['获取权限@驾驶' + vid], // 原版同时映射文字别名 获取权限@驾驶+编号（L5781）
      );
      return `${detail}\n${menu.join('\n')}`;
    }
    return detail;
  }

  /**
   * 原版 取玩家名称：数字归属（userId）解析为玩家名称，解析不到原样返回。
   * 对应原版 数据显示.ecode L2449「主人:」+ 取玩家名称(载具.归属)。
   */
  private async resolvePlayerName(idOrName: string): Promise<string> {
    if (!/^\d+$/.test(idOrName)) return idOrName;
    const numeric = Number(idOrName);
    if (!Number.isInteger(numeric) || numeric <= 0) return idOrName;
    const player = await this.prisma.player.findUnique({
      where: { userId: numeric },
      select: { name: true },
    });
    return String(player?.name || idOrName);
  }

  /**
   * 载具详情文本（原版 数据显示.ecode 显示载具 L2430-L2510 的网页版呈现）
   * 生命/主人/驾驶员/四槽位/移动方式/ID/零件清单；无主载具主人显示"无主"。
   */
  private async formatVehicleDetail(runtime: any): Promise<string> {
    const name = String(runtime?.name ?? '未知载具');
    // 原版：类型 = 零件[1].名称 去掉"核心"（计算载具同款推导），类型为空时回退现算
    let type = String(runtime?.type ?? '');
    const parts = Array.isArray(runtime?.parts) ? runtime.parts : [];
    if (!type && parts.length > 0) {
      type = String(parts[0]?.name ?? '').replace(/核心/g, '');
    }
    const currentHp = Number(runtime?.currentHp ?? 0);
    const maxHp = Number(runtime?.maxHp ?? 0);
    const owner = String(runtime?.owner ?? '');
    const driver = String(runtime?.driver ?? '');
    const num = (v: any) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0);

    const lines: string[] = [];
    lines.push(type ? `${name}(${type})` : name);
    // 显示层钳0：损坏件超上限的载具按原版公式会算出负血（如 -996），
    // 计算口径保持原样，仅显示时夹回 0 避免负数观感
    lines.push(`生命: ${num(Math.max(0, currentHp))}/${num(Math.max(0, maxHp))}`);
    // 原版 归属三态（L2446-L2457）：无主 → "无主"；数字归属 → 取玩家名称；其余（召唤物持有）原样
    if (owner === '无主') {
      lines.push('主人: 无主');
      const sealedFlag = runtime?.sealed;
      if (sealedFlag === true || sealedFlag === 1 || sealedFlag === 'true') {
        const sealLv = Number(runtime?.requireLevel ?? runtime?.sealLevel ?? 0) || 0;
        lines.push(sealLv > 0
          ? `远古遗迹・被封印 Lv.${sealLv}`
          : '远古遗迹・被封印');
      }
    } else if (owner === '') {
      lines.push('主人: 无');
    } else {
      lines.push(`主人: ${await this.resolvePlayerName(owner)}`);
    }
    // 驾驶员同口径（L2458-L2466）：数字 → 取玩家名称，空 → 无
    lines.push(`驾驶员: ${driver ? await this.resolvePlayerName(driver) : '无'}`);
    lines.push(
      `武器: ${num(runtime?.weaponSlots)}/${num(runtime?.maxWeapon)}  防御: ${num(runtime?.defenseSlots)}/${num(runtime?.maxDefense)}` +
      `  功能: ${num(runtime?.functionSlots)}/${num(runtime?.maxFunction)}  行走: ${num(runtime?.moveSlots)}/${num(runtime?.maxMove)}`,
    );
    // 移动方式（原版 L2468-L2476）：1=陆地、2=飞行、3=跃迁；0/4 → 「坐地(无法移动)」无"移动方式"前缀
    const moveType = Number(runtime?.moveType ?? 0);
    const idText = String(runtime?.vehicleId ?? '');
    if (moveType === 0 || moveType === 4) {
      lines.push(`坐地(无法移动)  ID: ${idText}`);
    } else {
      const moveText = moveType === 1 ? '陆地' : moveType === 2 ? '飞行' : '跃迁';
      lines.push(`移动方式: ${moveText}  ID: ${idText}`);
    }

    // 零件分组（原版 数据显示.ecode L2477-L2512）：部件/内置/杂物/生产限制
    this.appendVehiclePartLines(lines, parts);

    // 原版 L2513-2516：生产线可运行 + 驾驶员加成
    const productionPower = Number(runtime?.bonus?.生产 ?? 0);
    if (productionPower > 0) {
      const marks = asJsonValue<Record<string, number>>(runtime?.markers, {});
      const availableSec = Number(marks?.['生产时间'] ?? 0) || 0;
      lines.push(`生产线可运行:${this.formatVehicleTime(availableSec)}`);
    }
    lines.push(`驾驶员加成:${this.renderVehicleBonus(runtime?.bonus)}`);

    // 原版 L2517-2528：逆转力场 / 白的发丝 / 超限状态
    if (runtime?.reverseField) {
      lines.push('【载具不会受到伤害也不能抵挡伤害】');
    }
    if (runtime?.hair) {
      lines.push('掉落率+222%  掉落数量+444%');
    }
    const slotStatus = Number(runtime?.slotStatus ?? 0);
    if (slotStatus === 1) {
      lines.push('有部件超过了建议安装数量，超过的部分的效果减半。');
    } else if (slotStatus === 2) {
      lines.push('有部件超过了可安装上限，载具无法正常运作。');
    } else if (slotStatus === 3) {
      lines.push('有部件超过了建议安装数量，超过的部分的效果减半。');
      lines.push('有部件超过了可安装上限，载具无法正常运作。');
    }

    return lines.join('\n');
  }

  /**
   * 原版 显示加成（数据显示.ecode L456+）的网页版精简版：
   * 按固定字段序输出非零项，格式 `生命+100、攻击+5%`。
   */
  private renderVehicleBonus(bonus: any): string {
    if (!bonus || typeof bonus !== 'object') return '';
    const fields: [string, string, number, string][] = [
      // [key, label, divide, suffix]
      ['护盾', '护盾', 1, ''],
      ['装甲', '装甲', 1, ''],
      ['生命', '生命', 1, ''],
      ['护盾全抗', '护盾全抗', 1, '%'],
      ['装甲全抗', '装甲全抗', 1, '%'],
      ['生命全抗', '生命全抗', 1, '%'],
      ['物伤', '物攻', 1, ''],
      ['电伤', '电攻', 1, ''],
      ['火伤', '火攻', 1, ''],
      ['冰伤', '冰攻', 1, ''],
      ['攻击', '攻击', 1, ''],
      ['魅力', '魅力', 1, ''],
      ['冷却', '攻击冷却', 1, ''],
      ['暴击', '暴击', 1, '%'],
      ['生命物抗', '生命物抗', 1, '%'],
      ['生命火抗', '生命火抗', 1, '%'],
      ['生命冰抗', '生命冰抗', 1, '%'],
      ['生命电抗', '生命电抗', 1, '%'],
      ['装甲物抗', '装甲物抗', 1, '%'],
      ['装甲火抗', '装甲火抗', 1, '%'],
      ['装甲冰抗', '装甲冰抗', 1, '%'],
      ['装甲电抗', '装甲电抗', 1, '%'],
      ['护盾物抗', '护盾物抗', 1, '%'],
      ['护盾火抗', '护盾火抗', 1, '%'],
      ['护盾冰抗', '护盾冰抗', 1, '%'],
      ['护盾电抗', '护盾电抗', 1, '%'],
      ['速度', '速度', 1, ''],
      ['命中', '命中', 1, ''],
      ['闪避', '闪避', 1, ''],
      ['掉落率', '掉落率', 1, '%'],
      ['掉落品质', '掉落数量', 1, '%'],
      ['采集', '采集', 1, '%'],
      ['护盾回复', '护盾回复', 10, ''],
      ['装甲回复', '装甲修复', 10, ''],
      ['生命回复', '生命恢复', 10, ''],
      ['攻击2', '攻击', 1, '%'],
      ['速度2', '速度', 1, '%'],
      ['命中2', '命中', 1, '%'],
      ['闪避2', '闪避', 1, '%'],
      ['贯穿', '贯穿几率', 1, '%'],
      ['抗贯穿', '被贯穿几率', -1, '%'],
      ['韧性', '韧性', 1, '%'],
      ['生产', '生产', 1, ''],
    ];
    const parts: string[] = [];
    for (const [key, label, divide, suffix] of fields) {
      const raw = Number(bonus[key]);
      if (!Number.isFinite(raw) || raw === 0) continue;
      const value = raw / divide;
      const sign = value > 0 ? '+' : '';
      const rounded = this.support.round2Text(value);
      parts.push(`${label}${sign}${rounded}${suffix}`);
    }
    return parts.join('、');
  }

  /**
   * 原版 显示载具 的零件分组渲染（数据显示.ecode L2477-L2512 + 显示物品 L1847-L1957）：
   * - 部件：部件列表（vehicle-parts.json）命中 或 建筑命中（是否部件/取建筑）
   * - 生产限制：名称以"生产限制"开头 → 剥离前缀归入该组（L2480-L2483）
   * - 杂物：其余物品（原版「其他物品」）
   * - 内置：已安装部件规格的 内置零件 展开，同名合并数量（L2493-L2502 获得物品）
   * - 资源渲染 名称x数量；装备渲染 名称+品质大写+特效名（显示物品 L1879-L1951）
   */
  private appendVehiclePartLines(lines: string[], parts: any[]): void {
    if (!Array.isArray(parts) || parts.length === 0) {
      lines.push('部件: 无');
      return;
    }
    const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
    // 资源类同名合并（qty 累加），装备类为独立实例逐条渲染（equips）
    type Bucket = { qty: number; equips: string[] };
    const partMap = new Map<string, Bucket>();
    const miscMap = new Map<string, Bucket>();
    const builtinMap = new Map<string, number>();
    const limitMap = new Map<string, number>();
    const touch = (m: Map<string, Bucket>, key: string): Bucket => {
      let b = m.get(key);
      if (!b) { b = { qty: 0, equips: [] }; m.set(key, b); }
      return b;
    };

    for (const p of parts) {
      const pname = String(p?.name ?? '').trim();
      if (!pname) continue; // 原版 L1870：空名跳过
      const qty = Number(p?.quantity ?? 1) || 0;
      const isEquip = String(p?.type ?? '') === '装备';
      const spec = this.staticData.getVehiclePartSpecByName(pname);
      const isBuilding = !!this.staticData.getBuildingByName(pname);
      if (spec || isBuilding) {
        // 部件组：资源按 名称x数量 合并，装备按实例渲染（显示物品 装备分支）
        const bucket = touch(partMap, pname);
        if (isEquip) {
          bucket.equips.push(
            this.itemService.formatEquipmentInventoryDisplay({
              name: pname, type: '装备', quantity: 1, durability: 0,
              data: String(p?.data ?? ''),
            } as any),
          );
        } else {
          bucket.qty += qty;
        }
        // 内置零件展开（L2493-L2502）：对全部已安装部件按规格展开，与实例是否装备无关
        if (spec && Array.isArray(spec.builtinParts)) {
          for (const inner of spec.builtinParts) {
            const inName = String(inner?.name ?? '').trim();
            if (!inName) continue;
            const inQty = Number(inner?.quantity ?? 1) || 1;
            builtinMap.set(inName, (builtinMap.get(inName) ?? 0) + inQty);
          }
        }
      } else if (pname.startsWith('生产限制')) {
        // 生产限制组：剥离前缀（L2480-L2483）
        const key = pname.replace('生产限制', '');
        limitMap.set(key, (limitMap.get(key) ?? 0) + qty);
      } else {
        // 杂物组（原版 其他物品）
        const bucket = touch(miscMap, pname);
        if (isEquip) {
          bucket.equips.push(
            this.itemService.formatEquipmentInventoryDisplay({
              name: pname, type: '装备', quantity: 1, durability: 0,
              data: String(p?.data ?? ''),
            } as any),
          );
        } else {
          bucket.qty += qty;
        }
      }
    }

    const render = (m: Map<string, Bucket>): string =>
      [...m.entries()]
        .map(([bName, b]) => {
          const segs: string[] = [];
          if (b.qty > 0 || b.equips.length === 0) segs.push(`${bName}x${fmtQty(b.qty)}`);
          segs.push(...b.equips);
          return segs.join('、');
        })
        .join('、');

    // 原版 L2503 部件: 恒有；内置/杂物/生产限制 仅在非空时输出（L2504-L2512）
    lines.push(`部件: ${render(partMap) || '无'}`);
    if (builtinMap.size > 0) {
      lines.push(`内置: ${[...builtinMap.entries()].map(([bName, q]) => `${bName}x${fmtQty(q)}`).join('、')}`);
    }
    if (miscMap.size > 0) lines.push(`杂物: ${render(miscMap)}`);
    if (limitMap.size > 0) {
      lines.push(`生产限制: ${[...limitMap.entries()].map(([bName, q]) => `${bName}x${fmtQty(q)}`).join('、')}`);
    }
  }

  /**
   * 处理查看作物命令（对应原版 _主程序.ecode L5466）
   * 列出当前地图资源2中可产出（产出2非空）的作物，并生成编号快捷。
   */

  async handleVehicleOps(userId: number): Promise<string> {
    // 原版 _主程序.ecode L10875-10886 载具操作帮助
    return [
      `“组装轻型装甲2”安装2块轻型装甲`,
      `“组装轻型装甲-2”拆下2块轻型装甲`,
      `“驾驶骑士”驾驶名为【骑士】的载具`,
      `“呼叫骑士”让名为【骑士】的载具传送到你当前所在地`,
      `“维修”修理载具`,
      `“脱出”离开载具`,
      `“宠物驾驶史莱姆 骑士”让名为【史莱姆】的宠物驾驶名为【骑士】的载具`,
      `“载具命名骑士 坦克”把名为【骑士】的载具名称修改为【坦克】`,
      `“生产”了解和设置设置载具生产相关`,
      `“接管骑士”可以无需驾驶对载具进行拆装部件、设置生产等操作`,
      `你可以从一个载具上直接驾驶另一个载具，无须脱出再驾驶`,
      `床等家具也可以安装在载具里`,
      `想拆掉载具直接把核心拆掉即可，载具里面的东西会回到背包`,
    ].join('\n');
  }

  /**
   * 处理增幅器说明命令
   * 查看增幅器使用说明，展示增幅器系统的功能与用法
   * 对应原版：增幅器 命令
   */

  parseVehicleValue<T>(value: any, fallback: T): T {
    if (Array.isArray(value) || (value && typeof value === 'object')) return value as T;
    if (typeof value !== 'string' || !value.trim()) return fallback;
    return asJsonValue<T>(value, fallback);
  }

  /** 将 DB/地图载具转换为原版中文字段运行时结构。 */
  /** 跨子服务 API（§10.2）：DungeonChallenge 经 DI 直连调用。 */
}
