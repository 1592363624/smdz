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
import { PrismaService } from '../../../prisma/prisma.service';
import { PlayerService } from '.././player.service';
import { CombatSystemService } from '.././combat-system.service';
import { MapService } from '.././map.service';
import { AchievementService } from '.././achievement.service';
import { FamiliarSystemService } from '.././familiar-system.service';
import { StaticDataService } from '.././static-data.service';
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
      const walkMode = Number(travelVehicle?.行走方式 ?? travelVehicle?.walkMode ?? travelVehicle?.moveType ?? 0);
      if (walkMode === 0) {
        return `${player.name}当前驾驶的载具${travelVehicle?.名称 || travelVehicle?.name || ''}未安装行走机构或有的部件超过了上限`;
      }
      if (walkMode === 4) {
        return `${player.name}当前驾驶的载具${travelVehicle?.名称 || travelVehicle?.name || ''}安装了无法移动的组件`;
      }
    }

    // 对齐原版 _主程序.ecode 前往分支：目的地为当前位置时 取最短路径 距离为0，
    // 按“没有路径”拦截，不允许反复前往脚下地图；副本入口按传送处理不受此限制。
    if (!isDungeonEntry && Number(targetMap.id) === Number(currentMap.id)) {
      return `${player.name}所在地"${currentMap.name}"没有前往"${targetMap.name}"的路径`;
    }

    // 检查是否可以前往（原版 L6634：前往需求查出发地图；L6648：标记要求查目的地图）
    const check = isDungeonEntry
      ? { canTravel: true }
      : this.mapService.checkCanTravel(currentMap, targetMap, player, { mode: 'move', vehicle: travelVehicle });
    if (!check.canTravel) {
      return `无法前往：${check.reason}`;
    }

    // 计算移动所需耗时（秒）
    const travelDistance = isDungeonEntry
      ? Number(dungeonEntry?.distance || 100)
      : this.panel.getDistance(currentMap, targetMap);
    // 原版 _主程序.ecode L6574/L6601/L6664：移动任务按最短路径节点数推进，
    // 不是按耗时或距离推进；路径长度至少按一次移动处理。
    const movementTaskCount = await this.getMovementPathLength(currentMap, targetMap);
    // 原版 L6638-6644：b = 距离/速度（整数截断）；b < 路径节点数 → b=路径节点数；b < 1 → b=1
    const travelTime = this.mapService.calcTravelTime(
      travelDistance,
      player.speed || 100,
      movementTaskCount,
    );

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

    // 原版 L1620：飞到查目的地图的前往需求（动态能力判定）
    const vehicle = await this.findTravelVehicle(player, currentMap);
    if (typeof this.mapService.checkCanTravel === 'function') {
      const check = this.mapService.checkCanTravel(currentMap, targetMap, player, { mode: 'fly', vehicle });
      if (!check.canTravel) return `${playerName}${check.reason || '无法前往该地图'}`;
    }

    const moveType = Number(vehicle?.行走方式 ?? vehicle?.walkMode ?? vehicle?.moveType ?? 0);
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

  async findTravelVehicle(player: any, currentMap: any): Promise<any | null> {
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
          const found = items.find((it: any) => it && (it.name ?? it.名称) === name);
          if (found) {
            // 数量累加统一过 roundItemQuantity 三道闸（比例产出会累出浮点长尾）
            found.quantity = roundItemQuantity(readNum(found.quantity ?? found.count ?? found.数量) + qty);
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

  async shearPranaCubsOnArrival(map: any, arrivingPlayer: any): Promise<string> {
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

  async migratePlayerAssetsOnMove(
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

  async getMovementPathLength(startMap: any, targetMap: any): Promise<number> {
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
        return `${index + 1}、${recipe.名称}(${level}级) ${this.support.round2Text(Number(recipe.数值 || 0))}生产力`;
      });
      const speedPercent = production.consumedProductivity > Number(runtime.加成.生产 || 0)
        ? production.productionSpeed * production.efficiency * 100
        : production.productionSpeed * 100;
      const lines = [
        `${playerName},${runtime.名称}的生产线:`,
        ...recipeLines,
        `◆生产力${this.support.round2Text(production.consumedProductivity)}/${this.support.round2Text(Number(runtime.加成.生产 || 0))},可生产${this.formatVehicleTime(production.availableTime)}`,
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
          this.support.itemQuantity((runtime.零件 || []).find((part: any) => (part.名称 ?? part.name) === item.name)) <= 0)
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
      const messages: string[] = [`${runtime.名称}\n配方${target.名称}x${this.support.round2Text(Number(target.数值 || 0))}`];
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
          messages.push(`配方${other.名称}产出${inputName}，生产力调整为${this.support.round2Text(other.数值)}`);
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
    return `${playerName}为${runtime.名称}设置了${recipeName}\n它当前占用的生产力为${this.support.round2Text(currentValue)}\n${runtime.名称}当前产出:${this.formatVehicleItems(currentOutput)}`;
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

  /** 解析载具运行时 JSON，兼容 DB 字符串和地图 JSON 对象。 */

  toRuntimeVehicle(raw: any): any {
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
  /** 跨子服务 API（§10.2）：DungeonChallenge 经 DI 直连调用。 */

  toStoredVehicle(runtime: any): any {
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
      markers2: stored.markers2 || [],
      recipes: stored.recipes || [],
    };
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


  vehicleProductionOptions(map: any, vehicle: any): { yongxing: number; lannBaby: boolean } {
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


  formatVehicleItems(items: any[]): string {
    const values = (items || []).filter((item: any) => Number(item?.quantity ?? item?.数量 ?? 0) !== 0);
    if (values.length === 0) return '无';
    return values.map((item: any) => {
      const name = item?.name ?? item?.名称 ?? '';
      const quantity = Number(item?.quantity ?? item?.数量 ?? 0);
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
        const typeName = this.support.PART_TYPE_NAMES[part.partType] || '未知';
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
      return this.homeBuild.handleAssembleBuilding(userId, partName, requestedCount);
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
    return await this.homeBuild.handleInstallPart(userId, partName, requestedCount);
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

  parseVehicleAssemblyParts(parts: string[]): any[] {
    return parts.map((rawPart, index) => {
      const value = String(rawPart || '').trim();
      const name = index === 0 ? value.replace(/\d+/g, '') : value.replace(/\d+(?=\s*$)/, '').trim();
      const quantity = index === 0 ? 1 : Math.trunc(Number(value.match(/(\d+)\s*$/)?.[1] || 0));
      return { 名称: name, name, 类型: '资源', type: '资源', 数量: quantity, quantity };
    }).filter((part) => part.名称 && Number.isFinite(part.数量) && part.数量 > 0);
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
        const name = row?.name ?? row?.名称;
        // Issue #11：产出/需求缺 type 时对齐静态物品定义（经验胶囊=物品），
        // 防止默认“资源”与 item-system 路径（determineItemType=物品）分叉，
        // 造成同名不同 type 的背包条目永不合并。
        const staticType = name
          ? (this.staticData.getEquipmentByName(name) ? '装备' : this.staticData.getItemByName(name)?.type)
          : undefined;
        const type = row?.type ?? row?.类型 ?? staticType ?? '资源';
        return {
          ...row,
          name,
          名称: row?.名称 ?? row?.name,
          type,
          类型: row?.类型 ?? type,
          quantity: Number(row?.quantity ?? row?.count ?? row?.数量 ?? 0),
          数量: Number(row?.quantity ?? row?.count ?? row?.数量 ?? 0),
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
      const owned = await this.panel.backpackQuantity(temporaryBackpack, part.名称);
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


  async hasOwnedProductionVehicle(ownerQQ: string, coreSpec: any): Promise<boolean> {
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
        `类型: ${this.support.PART_TYPE_NAMES[partDef.partType] || '未知'}`,
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
      return `${name}，${vehicle.名称 || vehicle.name}安装的${overLimit}超过了上限，无法维修`;
    }

    const fullHp = Number(vehicle.加成?.生命 || 0) || this.rescue.rescueVehicleMaxHp(vehicle);
    if (fullHp > 0 && Number(vehicle.currentHp ?? vehicle.当前生命 ?? 0) === fullHp) {
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
    return `${name}正在维修${vehicle.名称 || vehicle.name},大概需要${seconds}秒`;
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
      return `${name}，${vehicle.名称 || vehicle.name}安装的${overLimit}超过了上限，无法维修`;
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
    const fullHp = Number(vehicle.加成?.生命 || 0) || this.rescue.rescueVehicleMaxHp(vehicle);
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

    await this.support.advanceTask(userId, '维修载具');
    const vehicleType = String(vehicle.类型 ?? vehicle.type ?? '');
    const typeText = vehicleType ? `（${vehicleType}）` : '';
    return `${player.name || '冒险者'}用0载具零件修好了${vehicle.名称 || vehicle.name}${typeText}`;
  }

  /** 原版 L10419-10427 四类部件超上限拦截：按 功能→武器→行走→防御 顺序返回超限类别名。 */

  findVehicleOverLimitPart(vehicle: any): string {
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
        .filter((summon: any) => (summon?.name ?? summon?.名称) !== '行商');
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
        options.push({ label: name, cmd: `查看 ${name}` });
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
   * 处理查看作物命令（对应原版 _主程序.ecode L5466）
   * 列出当前地图资源2中可产出（产出2非空）的作物，并生成编号快捷。
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

  parseVehicleValue<T>(value: any, fallback: T): T {
    if (Array.isArray(value) || (value && typeof value === 'object')) return value as T;
    if (typeof value !== 'string' || !value.trim()) return fallback;
    return asJsonValue<T>(value, fallback);
  }

  /** 将 DB/地图载具转换为原版中文字段运行时结构。 */
  /** 跨子服务 API（§10.2）：DungeonChallenge 经 DI 直连调用。 */
}
