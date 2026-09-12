/**
 * 救援/白天使指令域服务（game 模块化重构 P3-5 抽出）
 *
 * 职责：救助/扶起/复活使魔、自救、救援标记（创建/领取/过期/善后）、绑定载具维修、
 * 白天使全家桶（召唤物落位/好感同步/复活传送/重生图解析/白的对话任务池与羁绊联动）。
 * 依赖方向：依赖 Player、Map、Task、Prisma、Chat、DelayedTaskService、CombatSystem、
 * 支撑层（firstPositiveNumber/mutatePlayer 等）；跨域直接注入兄弟子服务
 * MovementVehicle（movement↔rescue 互调边，forwardRef 断环）。
 * 单一真相源：救援标记秒口径统一 rescueExpireAtSeconds；地面单位出入统一
 * mutateSummons 锁内闭环（mapService）。
 * 对口原版：_主程序.ecode 救助/复活/白 召唤分支。
 */import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { capPoolValue } from '.././player-pool.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlayerService } from '.././player.service';
import { CombatSystemService } from '.././combat-system.service';
import { MapService } from '.././map.service';
import { ChatService } from '../../chat/chat.service';
import { TaskService } from '.././task.service';
import { DelayedTaskService } from '.././delayed-task.service';
import { GameSupportService } from '.././game-support.service';
import { MovementVehicleService } from './movement-vehicle.service';

@Injectable()
export class RescueWhiteService {
  private readonly logger = new Logger(RescueWhiteService.name);

  constructor(
    private readonly support: GameSupportService,
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly combatSystem: CombatSystemService,
    private readonly mapService: MapService,
    private readonly chatService: ChatService,
    private readonly taskService: TaskService,
    // 跨域兄弟直连（P4 清理：原过渡期经门面引用）。movement↔rescue 互调边用 forwardRef 断环。
    @Inject(forwardRef(() => MovementVehicleService))
    private readonly movement: MovementVehicleService,
    @Optional() private readonly delayedTaskService?: DelayedTaskService,
  ) {}

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

  async beginSelfRescue(userId: number, player: any, markers2: any[]): Promise<string> {
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

  parseRescueArray(value: any): any[] {
    if (Array.isArray(value)) return value;
    return asJsonValue<any[]>(value, []);
  }


  parseRescueMarkers(value: any): any[] {
    return this.parseRescueArray(value);
  }


  createRescueMarker(
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


  getActiveRescueMarker(markers2: any[]): any | null {
    const now = Date.now() / 1000;
    return markers2.find((marker: any) => {
      const name = marker?.name ?? marker?.名称;
      if (name !== '复活' && name !== '工作') return false;
      const expireAt = this.rescueExpireAtSeconds(marker);
      return expireAt > now;
    }) || null;
  }


  rescueExpireAtSeconds(marker: any): number {
    const raw = Number(marker?.expireAt ?? marker?.有效期至 ?? 0);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return raw >= 1e12 ? raw / 1000 : raw;
  }


  remainingRescueSeconds(marker: any): number {
    return Math.max(1, Math.ceil(this.rescueExpireAtSeconds(marker) - Date.now() / 1000));
  }


  rescueActionText(type: string): string {
    if (type === 'player') return '救助玩家';
    if (type === 'vehicle') return '维修载具';
    if (type === 'familiar') return '抢救使魔';
    return '抢救';
  }


  formatRescueSeconds(seconds: number): number {
    return Math.max(1, Math.round(seconds));
  }


  rescueHp(unit: any): number {
    return Number(unit?.hp ?? unit?.currentHp ?? unit?.当前生命 ?? 0) || 0;
  }


  rescueMaxHp(unit: any): number {
    const attributes = this.parseRescueObject(unit?.attributes ?? unit?.属性);
    return this.support.firstPositiveNumber(
      unit?.maxHp,
      unit?.maxHealth,
      unit?.生命,
      attributes?.生命,
      attributes?.hp,
    );
  }


  parseRescueObject(value: any): any {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    return asJsonValue<any>(value, {});
  }


  setRescueHp(unit: any, hp: number): void {
    const value = Math.max(0, hp);
    if (unit?.hp !== undefined) unit.hp = value;
    if (unit?.currentHp !== undefined) unit.currentHp = value;
    if (unit?.当前生命 !== undefined) unit.当前生命 = value;
    if (unit?.hp === undefined && unit?.currentHp === undefined && unit?.当前生命 === undefined) {
      unit.hp = value;
    }
  }


  rescueUnitId(unit: any): string {
    return String(unit?.qq ?? unit?.QQ ?? unit?.id ?? unit?.编号 ?? unit?.name ?? unit?.名称 ?? '');
  }


  rescueUnitName(unit: any): string {
    return String(unit?.name ?? unit?.名称 ?? unit?.type ?? unit?.类型 ?? '使魔');
  }


  rescueVehicleKey(summon: any): string {
    const raw = summon?.vehicle ?? summon?.载具 ?? summon?.vehicleId ?? summon?.载具编号;
    if (raw && typeof raw === 'object') {
      return String(raw?.id ?? raw?.编号 ?? raw?.vehicleId ?? raw?.name ?? raw?.名称 ?? '');
    }
    return String(raw ?? '');
  }


  rescueVehicleKeys(vehicle: any): Set<string> {
    return new Set([
      vehicle?.id,
      vehicle?.编号,
      vehicle?.vehicleId,
      vehicle?.name,
      vehicle?.名称,
    ].filter((value) => value !== undefined && value !== null && String(value) !== '').map(String));
  }


  rescueVehicleMaxHp(vehicle: any): number {
    const bonus = this.parseRescueObject(vehicle?.bonus ?? vehicle?.加成);
    return this.support.firstPositiveNumber(vehicle?.maxHp, vehicle?.生命, bonus?.生命);
  }


  rescueVehicleHp(vehicle: any): number {
    return Number(vehicle?.currentHp ?? vehicle?.当前生命 ?? vehicle?.hp ?? 0) || 0;
  }


  isDamagedRescueVehicle(vehicle: any): boolean {
    const maxHp = this.rescueVehicleMaxHp(vehicle);
    return maxHp > 0 && this.rescueVehicleHp(vehicle) !== maxHp;
  }


  setRescueVehicleHp(vehicle: any, hp: number): void {
    const value = Math.max(0, hp);
    if (vehicle?.currentHp !== undefined) vehicle.currentHp = value;
    if (vehicle?.当前生命 !== undefined) vehicle.当前生命 = value;
    if (vehicle?.hp !== undefined) vehicle.hp = value;
    if (vehicle?.currentHp === undefined && vehicle?.当前生命 === undefined && vehicle?.hp === undefined) {
      vehicle.currentHp = value;
    }
  }


  hasActiveRescueBuff(value: any): boolean {
    const buffs = this.parseRescueArray(value);
    const now = Date.now() / 1000;
    return buffs.some((buff: any) => {
      if ((buff?.name ?? buff?.名称) !== '卷土重来') return false;
      const raw = Number(buff?.expireAt ?? buff?.有效期至 ?? 0);
      const expireAt = raw >= 1e12 ? raw / 1000 : raw;
      return !expireAt || expireAt > now;
    });
  }


  shortenRescueBuff(buffs: any[], name: string, seconds: number): boolean {
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


  async saveRescueMap(map: any, summons: any[], vehicles: any[]): Promise<void> {
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

  async claimRescueMarker(userId: number, token: string): Promise<boolean> {
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


  async scheduleRescueCompletion(userId: number, marker: any): Promise<void> {
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

  async completeRescue(userId: number, marker: any): Promise<string> {
    // 先原子认领标记再结算：定时器回调与兜底扫描可能并发进入同一到期标记，
    // 认领失败说明另一调用已在结算，本调用直接放弃（详见 claimRescueMarker）。
    const claimed = await this.claimRescueMarker(userId, marker?.token);
    if (!claimed) return '';
    // 认领成功后的读快照→改→整包写回段必须持用户级共享锁（理由同采集结算），
    // 否则会被兑换/召唤/后台开采的并发写回覆盖玩家数据。
    return this.playerService.enqueueUserWrite(userId, () => this.applyCompleteRescue(userId, marker));
  }

  /** 救援结算的数据库读改写段（调用方需已完成标记认领并持有用户级锁）。 */

  async applyCompleteRescue(userId: number, marker: any): Promise<string> {
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;

    if (marker.rescueType === 'self') {
      // 原版 _主程序.ecode L1305/L1318：自救恢复 `玩家.属性.生命 / 2` ——「属性」是**计算上限**
      // （含装备/套装/增益，即面板分母），不是基础列 maxHp；与 PlayerService.resolvePlayerDeath
      // 的复活基数同口径。取不到计算上限时退回基础上限，保证行为不劣化。
      let rescueCapHp = Number(player.maxHp || 100);
      try {
        const rescueBonus = this.combatSystem.buildAttackerBonus(player, playerData) as any;
        if (Number(rescueBonus?.生命) > 0) rescueCapHp = Number(rescueBonus.生命);
      } catch { /* 计算上限取值失败 → 退回基础上限 */ }
      // 三池第四道闸：写入必走 capPoolValue（封顶 + 两位小数 + 残值归零）
      const rescueHp = capPoolValue(rescueCapHp / 2, rescueCapHp);

      if (this.playerService.isPlayerDead(player)) {
        player.hp = rescueHp;
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
      const result = `${player.name || '冒险者'}感觉好一点了吗？恢复了${Math.floor(rescueHp)}生命${teleportSuffix}`;
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

  async applyWhiteAngelRevivalTeleport(userId: number, player: any): Promise<string> {
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

      const result = await this.movement.performArrival(userId, targetMap.id, targetMap.name);
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

  async materializeWhiteSummon(
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

  async ensurePlayerWhite(player: any, map: any): Promise<any | null> {
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

  async syncWhiteAffinity(
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

  async resolveRespawnMapId(allMaps: any[], fromMapId: number): Promise<number> {
    const fromMap = allMaps.find((map: any) => Number(map.id) === Number(fromMapId));
    const respawnName = String(fromMap?.respawnPoint ?? fromMap?.复活点 ?? '').trim();
    if (!respawnName) return 0;

    if (respawnName === fromMap.name) return fromMap.id;
    const respawnMap = allMaps.find((map: any) => map.name === respawnName)
      ?? await this.mapService.getMapByName(respawnName).catch(() => null);
    return respawnMap ? Number(respawnMap.id) : 0;
  }

  /** 全图查找自己的「白」所在地图 id；找不到返回 0。 */

  findWhiteAngelMapId(
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
}
