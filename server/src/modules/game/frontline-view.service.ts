/**
 * 家园前线面板视图装配服务（只读）。
 *
 * 面向 Web 端「前线」独立页面，把防御建筑、火力通道、敌人波次、活动增益与背包库存
 * 投影成模块卡数据，供玩家直接在网页上布防与开战。
 *
 * 设计约定（与 home-yard.service.ts 一致）：
 * 1. **只读**：本服务不写任何数据、不推进战斗回合、不领取产出。所有变更
 *    （安装 / 拆卸 / 开始战斗 / 前往前线）依旧由 QQ / 网页统一的指令通道执行，
 *    杜绝出现第二条写路径造成结算双轨。
 * 2. **数据来源**与 QQ 端「家园前线」「开始战斗」「安装/拆卸」读取口径一致：
 *    建筑与火力读 GameMap 聚合字段，敌人波次读 GameMonster 表，前线等级读玩家标记「前线」。
 */

import { Injectable, Logger } from '@nestjs/common';
import { PlayerService } from './player.service';
import { MapService } from './map.service';
import { StaticDataService } from './static-data.service';
import { asJsonValue } from '../../common/utils/json-value.util';
import { FRONTLINE_VIEW_CONFIG, buildFrontlineWave } from './frontline-view.config';

// ==================== DTO ====================

/** 前线地图上已安装的防御建筑（聚合条目） */
export interface FrontlineBuilding {
  name: string;
  /** 已安装数量（规范键 quantity，与背包/地图条目同口径） */
  quantity: number;
}

/** 火力通道中的一把武器（来自前线召唤物 武器 数组） */
export interface FrontlineWeapon {
  name: string;
  /** 伤害百分比（原版显示 属性.物） */
  damagePct: number;
  /** 冷却秒数（原版 武器.冷却，前线阵地武器固定 10） */
  cooldownSec: number;
  /** 该武器当前剩余冷却秒数（0 = 可开火） */
  cooldownRemainSec: number;
}

/** 防御阵地本体（原版 生成前线 造出的「前线」召唤物 + 「阵地」载具） */
export interface FrontlinePosition {
  /** 阵地召唤物是否在场上 */
  exists: boolean;
  /** 阵地召唤物当前生命（原版置 1，一击必杀线） */
  hp: number;
  /** 阵地载具当前/上限耐久（被地精打掉后要靠「修好」恢复） */
  vehicleHp: number;
  vehicleMaxHp: number;
  /** 载具是否已损坏（currentHp <= 0） */
  broken: boolean;
}

/** 本波前线战报（原版把每次击杀文本发群，网页端必须有个可回看的落点） */
export interface FrontlineReport {
  startedAt: number;
  finishedAt: number;
  /** '' 进行中 / 'victory' 本波已清空 / 'stalled' 活动到期仍有残留 */
  result: string;
  level: number;
  wave: string[];
  kills: number;
  byName: Record<string, number>;
  exp: number;
  wreckage: number;
  proficiency: number;
  drops: string;
}

/** 前线地图上的地精敌人（GameMonster，存活 hp>0） */
export interface FrontlineEnemy {
  name: string;
  hp: number;
  maxHp: number;
  shield: number;
  level: number;
}

/** 前线地图上的特殊宠物（特殊序号>0 且存活） */
export interface FrontlineSpecialPet {
  name: string;
  hp: number;
}

/** 背包里可安装的防御建筑（加成.攻击 != 0） */
export interface FrontlineStock {
  name: string;
  quantity: number;
  description: string;
}

/** 前线活动增益状态（开始战斗后 120 秒，怪物自动回合） */
export interface FrontlineActive {
  active: boolean;
  remainSeconds: number;
}

/** 家园前线全量视图 */
export interface FrontlineViewInfo {
  /** 早退原因（无家园/房子未建成/前线地图丢失）；存在时其余字段为空投影 */
  blocked?: string;
  houseName: string;
  /** 家园建造进度（4=已建成，前线玩法要求 4） */
  progress: number;
  /** 前线等级（玩家标记「前线」，决定波次强度与防御上限） */
  frontLevel: number;
  /** 玩家当前是否站在自己的前线地图上（布防/拆卸要求人在前线） */
  atFrontline: boolean;
  /** 防御阵地：已装防御数 / 上限（前线等级+3）/ 建筑列表 */
  defense: {
    used: number;
    limit: number;
    buildings: FrontlineBuilding[];
  };
  /** 火力通道（前线召唤物的武器列表；未生成前线时为空） */
  firepower: FrontlineWeapon[];
  /** 防御阵地本体状态 */
  position: FrontlinePosition;
  /** 地精敌人波次（存活怪物） */
  enemies: FrontlineEnemy[];
  /** 特殊宠物（如前线地图上驻守的特殊召唤物） */
  specialPets: FrontlineSpecialPet[];
  /** 活动增益（开始战斗后 120 秒自动回合） */
  active: FrontlineActive;
  /** 背包里可安装的防御建筑库存 */
  stock: FrontlineStock[];
  /** 是否可以开始战斗（前线已清空，或阵地已失联可重整战线） */
  canBattle: boolean;
  /** 阵地是否已丢失/被打爆：此时「开始战斗」会清残留并重建 */
  positionLost: boolean;
  /** 前线召唤物（怪物前线+qq+sg）是否已生成（决定火力通道是否有内容） */
  frontlineExists: boolean;
  /** 前线熟练度（等级的唯一来源）与升级进度 */
  proficiency: {
    value: number;
    currentLevelBase: number;
    nextLevelAt: number;
    toNext: number;
  };
  /** 地图上累计的载具残骸次数（可「收集残骸」分解） */
  wreckage: number;
  /** 本波前线战报（无波次时为空对象） */
  report: Partial<FrontlineReport> | null;
  /** 下一波地精构成（按当前前线等级预测） */
  nextWave: string[];
}

@Injectable()
export class FrontlineViewService {
  private readonly logger = new Logger(FrontlineViewService.name);

  constructor(
    private readonly playerService: PlayerService,
    private readonly mapService: MapService,
    private readonly staticData: StaticDataService,
  ) {}

  /**
   * 装配家园前线面板视图（只读，不结算、不写库）。
   *
   * @returns 前线视图 DTO；家园缺失/未建成时返回 blocked
   */
  async getFrontlineView(userId: number): Promise<FrontlineViewInfo> {
    const empty = (blocked: string, extra: Partial<FrontlineViewInfo> = {}): FrontlineViewInfo => ({
      blocked,
      houseName: extra.houseName ?? '',
      progress: extra.progress ?? 0,
      frontLevel: extra.frontLevel ?? 0,
      atFrontline: extra.atFrontline ?? false,
      defense: extra.defense ?? { used: 0, limit: 3, buildings: [] },
      firepower: extra.firepower ?? [],
      position: extra.position ?? { exists: false, hp: 0, vehicleHp: 0, vehicleMaxHp: 0, broken: false },
      enemies: extra.enemies ?? [],
      specialPets: extra.specialPets ?? [],
      active: extra.active ?? { active: false, remainSeconds: 0 },
      stock: extra.stock ?? [],
      canBattle: extra.canBattle ?? false,
      positionLost: extra.positionLost ?? false,
      frontlineExists: extra.frontlineExists ?? false,
      proficiency: extra.proficiency ?? { value: 0, currentLevelBase: 0, nextLevelAt: 1, toNext: 1 },
      wreckage: extra.wreckage ?? 0,
      report: extra.report ?? null,
      nextWave: extra.nextWave ?? ['地精', '地精'],
    });

    const playerData = await this.playerService.getPlayerData(userId);
    const { player, markers } = playerData;
    if (!player) return empty('玩家档案不存在');

    const houseName = String(player.houseName ?? '').trim();
    const progress = Number(this.playerService.getMarkerValue(markers, '家园进度') ?? 0) || 0;
    if (!houseName) return empty('还没有家园，先发送「圈地」选一块地吧', { progress });
    if (progress < 4) {
      return empty('需要先完成房子的建造，才能开启前线', { houseName, progress });
    }

    // 与 QQ 端「家园前线」同口径：ensureHouseMaps 保证前线地图存在
    const stats = asJsonValue<Record<string, any>>(player.stats, {});
    const baseMapId = Number(stats['家园原地图ID'] || stats.houseBaseMapId || player.mapId || 0);
    const houseMaps = await this.mapService.ensureHouseMaps(houseName, baseMapId, progress);
    const frontlineMap = houseMaps?.frontline;
    if (!frontlineMap) {
      return empty('一个错误发生了:家园前线地图编号为0', { houseName, progress });
    }

    const frontLevel = this.playerService.getFrontlineLevel(markers);

    // 玩家当前是否站在前线地图上（布防/拆卸的指令门禁与 QQ 端一致）
    const currentMap = await this.mapService.getMapById(player.mapId).catch(() => null);
    const atFrontline = !!currentMap && String(currentMap.name ?? '') === `${houseName}前线`;

    // ---- 防御阵地：前线地图 buildings 聚合条目 ----
    const mapBuildings = asJsonValue<any[]>(frontlineMap.buildings, []);
    const defenseBuildings: FrontlineBuilding[] = [];
    let defenseUsed = 0;
    for (const entry of mapBuildings) {
      const name = String(entry?.name ?? '');
      if (!name) continue;
      const quantity = Math.max(1, Math.round(Number(entry?.quantity ?? 1)) || 1);
      defenseUsed += quantity;
      defenseBuildings.push({ name, quantity });
    }
    const defenseLimit = frontLevel + 3;

    // ---- 前线召唤物：火力通道（武器 属性.物 = 伤害%）----
    const summons = asJsonValue<any[]>(frontlineMap.summons, []);
    const qq = String((player as any).qqNumber || (player as any).externalId || player.userId || userId);
    const frontlineQQ = `怪物前线${qq}sg`;
    const frontline = summons.find((s: any) => (s.QQ || s.qq) === frontlineQQ);
    // 阵地武器冷却标记（与玩家/召唤物同一套 markers2「<武器名>冷却」口径）
    const positionCooldowns = asJsonValue<any[]>(frontline?.markers2, []);
    const firepower: FrontlineWeapon[] = [];
    for (const weapon of frontline?.weapons || []) {
      const weaponName = String(weapon.name ?? '');
      const cdEntry = positionCooldowns.find(
        (g: any) => String(g?.name ?? '') === `${weaponName}冷却`,
      );
      const rawExpire = Number(cdEntry?.expireAt ?? 0) || 0;
      // 冷却标记历史上秒/毫秒两种形态并存，统一按毫秒比较
      const expireMs = rawExpire > 0 && rawExpire < 1e12 ? rawExpire * 1000 : rawExpire;
      firepower.push({
        name: weaponName,
        damagePct: Number(weapon.属性?.物 ?? weapon.attributes?.physical ?? 0) || 0,
        cooldownSec: Number(weapon.冷却 ?? weapon.cooldown ?? 0) || 0,
        cooldownRemainSec: expireMs > Date.now() ? Math.ceil((expireMs - Date.now()) / 1000) : 0,
      });
    }

    // ---- 阵地本体：召唤物在不在、载具被打掉多少 ----
    const vehicles = asJsonValue<any[]>(frontlineMap.vehicles, []);
    const positionVehicle = vehicles.find((v: any) => String(v?.vehicleId ?? v?.id ?? '') === frontlineQQ);
    const vehicleHp = Number(positionVehicle?.currentHp ?? 0) || 0;
    const vehicleMaxHp = Number(
      positionVehicle?.maxHp ?? positionVehicle?.bonus?.生命 ?? 0,
    ) || 0;
    const position: FrontlinePosition = {
      exists: !!frontline,
      hp: Number(frontline?.hp ?? 0) || 0,
      vehicleHp,
      vehicleMaxHp,
      broken: !!positionVehicle && vehicleHp <= 0,
    };
    // 阵地丢失 = 召唤物不在场或已被打空。此时残留地精是打不动的，
    // 「开始战斗」会清场重建（见 DungeonChallengeService.handleStartBattle），
    // 面板必须把这条路告诉玩家，否则界面永远停在「战斗进行中」这一颗按不动的按钮上。
    const positionLost = !frontline || (Number(frontline?.hp ?? 0) || 0) <= 0;

    // ---- 特殊宠物（特殊序号>0 且存活）----
    const specialPets: FrontlineSpecialPet[] = [];
    for (const s of summons) {
      const specialSeq = Number(s.specialSeq ?? 0);
      const hp = Number(s.hp ?? 0) || 0;
      if (specialSeq > 0 && hp > 0) {
        specialPets.push({ name: String(s.name ?? ''), hp });
      }
    }

    // ---- 地精敌人波次：GameMonster 表（与「开始战斗」的怪物2 判定同源）----
    const monsters = await this.mapService.getMapMonsters(frontlineMap);
    const enemies: FrontlineEnemy[] = [];
    for (const m of monsters) {
      const hp = Number(m.hp ?? 0) || 0;
      if (hp <= 0) continue; // 只展示存活的敌人
      enemies.push({
        name: String(m.name ?? ''),
        hp,
        maxHp: Number(m.maxHp ?? hp) || hp,
        shield: Number(m.shield ?? 0) || 0,
        level: Number(m.level ?? 0) || 0,
      });
    }

    // ---- 活动增益（开始战斗后 120 秒自动回合）----
    const markers2 = asJsonValue<any[]>(frontlineMap.markers2, []);
    const activity = markers2.find((g: any) => String(g.name ?? '') === '活动');
    const rawActivityExpire = Number(activity?.expireAt ?? 0) || 0;
    const expireMs = rawActivityExpire > 0 && rawActivityExpire < 1e12
      ? rawActivityExpire * 1000
      : rawActivityExpire;
    const remainMs = expireMs - Date.now();
    const active: FrontlineActive = {
      active: remainMs > 0,
      remainSeconds: remainMs > 0 ? Math.max(1, Math.ceil(remainMs / 1000)) : 0,
    };

    // ---- 前线熟练度 / 载具残骸 / 本波战报 ----
    const proficiencyProgress = this.playerService.getFrontlineLevelProgress(markers);
    const wreckage = asJsonValue<any[]>(frontlineMap.resources2, [])
      .reduce(
        (sum: number, r: any) => sum + (String(r?.name ?? '') === '载具残骸' ? Number(r?.times ?? 0) || 0 : 0),
        0,
      );
    const mapMarkers = asJsonValue<Record<string, any>>(frontlineMap.markers, {});
    const rawReport = mapMarkers && !Array.isArray(mapMarkers) ? mapMarkers['前线战报'] : null;
    const report: FrontlineReport | null = rawReport && typeof rawReport === 'object'
      ? {
        startedAt: Number(rawReport.startedAt ?? 0) || 0,
        finishedAt: Number(rawReport.finishedAt ?? 0) || 0,
        result: String(rawReport.result ?? ''),
        level: Number(rawReport.level ?? 0) || 0,
        wave: asJsonValue<string[]>(rawReport.wave, []),
        kills: Number(rawReport.kills ?? 0) || 0,
        byName: asJsonValue<Record<string, number>>(rawReport.byName, {}),
        exp: Number(rawReport.exp ?? 0) || 0,
        wreckage: Number(rawReport.wreckage ?? 0) || 0,
        proficiency: Number(rawReport.proficiency ?? 0) || 0,
        drops: String(rawReport.drops ?? ''),
      }
      : null;

    // ---- 背包库存：加成.攻击 != 0 的防御建筑（可安装到前线）----
    const backpack = this.playerService.getBackpackItems(player);
    const stock: FrontlineStock[] = [];
    for (const item of backpack) {
      const name = String(item?.name ?? '');
      if (!name) continue;
      const quantity = Math.floor(Number(item?.quantity ?? 0)) || 0;
      if (quantity <= 0) continue;
      const def = this.staticData.getBuildingByName(name);
      if (!def) continue;
      const bonus = asJsonValue<any>(def?.bonus ?? {}, {});
      if (Number(bonus.攻击 ?? 0) === 0) continue; // 只列防御建筑
      stock.push({
        name,
        quantity,
        description: String(def?.description ?? ''),
      });
      if (stock.length >= FRONTLINE_VIEW_CONFIG.stockDisplayLimit) break;
    }

    return {
      houseName,
      progress,
      frontLevel,
      atFrontline,
      defense: { used: defenseUsed, limit: defenseLimit, buildings: defenseBuildings },
      firepower,
      position,
      enemies,
      specialPets,
      active,
      stock,
      canBattle: enemies.length === 0 || positionLost,
      positionLost,
      frontlineExists: !!frontline,
      proficiency: {
        value: proficiencyProgress.proficiency,
        currentLevelBase: proficiencyProgress.currentLevelBase,
        nextLevelAt: proficiencyProgress.nextLevelAt,
        toNext: proficiencyProgress.need,
      },
      wreckage,
      report,
      nextWave: buildFrontlineWave(frontLevel),
    };
  }
}
