/**
 * 家园前线面板视图装配服务（只读）。
 *
 * 面向 Web 端「前线」独立页面：把家园前线地图（玩家.房子名称+"前线"）上的
 * 防御建筑、前线召唤物火力通道、地精敌人波次、活动增益与背包可安装的防御建筑
 * 投影成一块一块的模块卡数据，供玩家直接在网页上布防与开战。
 *
 * 设计约定（与 home-yard.service.ts 一致）：
 * 1. **只读**：本服务不写任何数据、不推进任何战斗回合、不领取产出。所有变更
 *    （安装 / 拆卸 / 开始战斗 / 前往前线）依旧由 QQ / 网页统一的指令通道执行，
 *    杜绝出现第二条写路径造成结算双轨。
 * 2. **数据来源**：防御建筑与火力通道读 GameMap 聚合字段（buildings/summons/
 *    vehicles/markers2），敌人波次读 GameMonster 表，前线等级读玩家标记「前线」，
 *    全部与 QQ 端「家园前线」「开始战斗」「安装/拆卸」读取的口径一致。
 */

import { Injectable, Logger } from '@nestjs/common';
import { PlayerService } from './player.service';
import { MapService } from './map.service';
import { StaticDataService } from './static-data.service';
import { asJsonValue } from '../../common/utils/json-value.util';
import { FRONTLINE_VIEW_CONFIG } from './frontline-view.config';

// ==================== DTO ====================

/** 前线地图上已安装的防御建筑（聚合条目） */
export interface FrontlineBuilding {
  name: string;
  count: number;
}

/** 火力通道中的一把武器（来自前线召唤物 武器 数组） */
export interface FrontlineWeapon {
  name: string;
  /** 伤害百分比（原版显示 属性.物） */
  damagePct: number;
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
  /** 地精敌人波次（存活怪物） */
  enemies: FrontlineEnemy[];
  /** 特殊宠物（如前线地图上驻守的特殊召唤物） */
  specialPets: FrontlineSpecialPet[];
  /** 活动增益（开始战斗后 120 秒倒计时） */
  active: FrontlineActive;
  /** 背包里可安装的防御建筑库存 */
  stock: FrontlineStock[];
  /** 是否可以开始战斗（房子建成 且 前线无敌人） */
  canBattle: boolean;
  /** 前线召唤物（怪物前线+qq+sg）是否已生成（决定火力通道是否有内容） */
  frontlineExists: boolean;
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
   * @param userId 当前登录用户 ID
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
      enemies: extra.enemies ?? [],
      specialPets: extra.specialPets ?? [],
      active: extra.active ?? { active: false, remainSeconds: 0 },
      stock: extra.stock ?? [],
      canBattle: extra.canBattle ?? false,
      frontlineExists: extra.frontlineExists ?? false,
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

    const frontLevel = Number(this.playerService.getMarkerValue(markers, '前线') ?? 0) || 0;

    // 玩家当前是否站在前线地图上（布防/拆卸的指令门禁与 QQ 端一致）
    const currentMap = await this.mapService.getMapById(player.mapId).catch(() => null);
    const atFrontline = !!currentMap && String(currentMap.name ?? '') === `${houseName}前线`;

    // ---- 防御阵地：前线地图 buildings 聚合条目 ----
    const mapBuildings = asJsonValue<any[]>(frontlineMap.buildings, []);
    const defenseBuildings: FrontlineBuilding[] = [];
    let defenseUsed = 0;
    for (const entry of mapBuildings) {
      const name = String(entry?.name ?? entry?.名称 ?? '');
      if (!name) continue;
      const count = Math.max(1, Math.round(Number(entry?.count ?? entry?.数量 ?? 1)) || 1);
      defenseUsed += count;
      defenseBuildings.push({ name, count });
    }
    const defenseLimit = frontLevel + 3;

    // ---- 前线召唤物：火力通道（武器 属性.物 = 伤害%）----
    const summons = asJsonValue<any[]>(frontlineMap.summons, []);
    const qq = String((player as any).qqNumber || (player as any).externalId || player.userId || userId);
    const frontlineQQ = `怪物前线${qq}sg`;
    const frontline = summons.find((s: any) => (s.QQ || s.qq) === frontlineQQ);
    const firepower: FrontlineWeapon[] = [];
    for (const weapon of frontline?.武器 || frontline?.weapons || []) {
      firepower.push({
        name: String(weapon.名称 ?? weapon.name ?? ''),
        damagePct: Number(weapon.属性?.物 ?? weapon.attributes?.physical ?? 0) || 0,
      });
    }

    // ---- 特殊宠物（特殊序号>0 且存活）----
    const specialPets: FrontlineSpecialPet[] = [];
    for (const s of summons) {
      const specialSeq = Number(s.specialSeq ?? s.特殊序号 ?? 0);
      const hp = Number(s.hp ?? s.当前生命 ?? 0) || 0;
      if (specialSeq > 0 && hp > 0) {
        specialPets.push({ name: String(s.name ?? s.名称 ?? ''), hp });
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
    const activity = markers2.find((g: any) => String(g.名称 ?? g.name ?? '') === '活动');
    const expireMs = Number(activity?.有效期至 ?? activity?.expireAt ?? 0) || 0;
    const remainMs = expireMs - Date.now();
    const active: FrontlineActive = {
      active: remainMs > 0,
      remainSeconds: remainMs > 0 ? Math.max(1, Math.ceil(remainMs / 1000)) : 0,
    };

    // ---- 背包库存：加成.攻击 != 0 的防御建筑（可安装到前线）----
    const backpack = this.playerService.getBackpackItems(player);
    const stock: FrontlineStock[] = [];
    for (const item of backpack) {
      const name = String(item?.name ?? item?.名称 ?? '');
      if (!name) continue;
      const quantity = Math.floor(Number(item?.quantity ?? item?.count ?? item?.数量 ?? 0)) || 0;
      if (quantity <= 0) continue;
      const def = this.staticData.getBuildingByName(name);
      if (!def) continue;
      const bonus = asJsonValue<any>(def?.bonus ?? def?.加成 ?? {}, {});
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
      enemies,
      specialPets,
      active,
      stock,
      canBattle: enemies.length === 0,
      frontlineExists: !!frontline,
    };
  }
}
