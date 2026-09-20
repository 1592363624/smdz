/**
 * 后台定时任务服务
 * 对应原版易语言：后台运作.ecode
 * 负责自动保存、地图资源刷新、副本生成、行商判断、掉落货舱等定时任务
 *
 * 注意：与游戏逻辑相关的操作（生成 NPC/怪物/召唤物/资源/载具等）直接通过
 * PrismaService 操作数据库，只在行商判断处调用 GameService，以压缩循环依赖面。
 * 可配置项（副本名、宠物数量上限、几率等）统一从 SystemConfig 配置中心读取。
 */

import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { MapService } from './map.service';
import { AutoMineService } from './auto-mine.service';
import { GameService } from './game.service';
import { StaticDataService } from './static-data.service';
import { DungeonService, DUNGEON_ENTRY_SOURCE } from './dungeon.service';
import { DungeonChallengeService } from './commands/dungeon-challenge.service';
import { WorldEventService } from './world-event.service';
import { runSilent } from '../../game-sync/write-context';
import { filterActive } from './expire-time.util';
import { asJsonValue } from '../../common/utils/json-value.util';

/**
 * 副本名来源优先级（原版 后台运作.ecode L3-35 取 [商店]副本 / [商店]副本2）：
 *   1. 配置中心 game.instanceNames / game.instanceNames2（运维覆盖）
 *   2. 静态数据 shops.json 的 dungeons / dungeons2（原版「副本」/「副本2」配置的解析结果）
 *   3. DungeonService.getInstanceGroups() 的真实副本组名（兜底）
 * 三个来源都会按“地图表中是否真实存在”过滤：副本入口靠“去掉(副本)后的名称”解析目标地图，
 * 名字对不上地图时入口会永远进不去。
 */

/**
 * 名单字段容错：兼容数组、逗号/空白分隔的字符串。
 * 原版 [商店]副本 是逗号分隔文本，配置中心也可能存成字符串。
 */
function toNameArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}

@Injectable()
export class ScheduleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduleService.name);
  private autoSaveRunning = false;
  private lastAutoSaveTime = 0;
  /** 行商判断运行锁，防止上一次未结束时重复执行 */
  private merchantRunning = false;
  /** 废弃载具定时刷新运行锁 */
  private wreckSpawnRunning = false;
  /** 上次废弃载具刷新命中的「日期+HH:mm」槽位，防止同一分钟内重复触发 */
  private lastWreckSpawnSlot = '';
  /** 掉落货舱运行锁 */
  private cargoRunning = false;
  /** 生成副本运行锁 */
  private instanceRunning = false;
  /** 自动开采增量结算运行锁 */
  private autoMineRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly mapService: MapService,
    private readonly autoMineService: AutoMineService,
    private readonly gameService: GameService,
    private readonly staticData: StaticDataService,
    private readonly dungeonService: DungeonService,
    // 废弃载具生成与管理员指令共用同一实现（DungeonChallengeService 由全局 GameModule 导出）
    private readonly dungeonChallengeService: DungeonChallengeService,
    // 全服世界事件货舱 buff（额外整点货舱数）；@Optional 兼容手工测试桩
    @Optional() private readonly worldEvent?: WorldEventService,
  ) {}

  /**
   * 启动时补齐各地图常驻怪物（原版 接口1.ecode L1374：读档时对每张地图执行 `刷新地图`）。
   *
   * 这里是**只补不删**（`topUpResidentMonsters` → `spawnResidentMonsters`），不重建存活怪：
   * 原版 `刷新地图` 之所以是整批重建，是因为它的世界存档在启动时整体载入内存；
   * 本框架的怪物实例持久化在 GameMonster 表，重启不该抹掉怪物身上已有的状态。
   *
   * 作用：保证「刚部署/冷启动」后所有非关卡地图都有怪可打，因此到达与建档两条路径
   * 都不需要额外的"懒刷新"逻辑。
   */
  onApplicationBootstrap(): void {
    // 不阻塞启动收尾；失败只告警（DB 尚未就绪时下一分钟 cron 仍会补齐）
    void this.ensureResidentMonstersAtBoot();
    // 启动清扫：副本入口持久化倒计时，重启不清空；这里清掉无效入口与已到期入口
    void this.sweepDungeonEntriesAtBoot();
  }

  /**
   * 启动清扫副本入口（无效/过期，失败只告警不影响启动）。
   */
  private async sweepDungeonEntriesAtBoot(): Promise<void> {
    try {
      await this.dungeonService.sweepDungeonEntries();
    } catch (err: any) {
      this.logger.warn(`启动清扫副本入口失败: ${err?.message ?? err}`);
    }
  }

  /**
   * 副本入口到期清扫 - 每5分钟执行一次。
   * 入口从开启时刻起 game.dungeonEntryLifetimeHours（默认 24h）自动关闭；
   * 重启不清空，按入口上的 expireAt 继续倒计时。
   */
  @Cron('0 */5 * * * *')
  async sweepDungeonEntriesPeriodic() {
    try {
      await this.dungeonService.sweepDungeonEntries();
    } catch (err: any) {
      this.logger.warn(`副本入口定时清扫失败: ${err?.message ?? err}`);
    }
  }

  private async ensureResidentMonstersAtBoot(): Promise<void> {
    try {
      const allMaps = await this.mapService.getAllMaps();
      const maps = allMaps.filter((m: any) => this.isMonsterRespawnMap(m));
      let spawned = 0;
      for (const map of maps) {
        spawned += await this.mapService.topUpResidentMonsters(map.id, map);
      }
      if (spawned > 0) {
        this.logger.log(`启动补齐常驻怪物: ${spawned} 只`);
      }
    } catch (err: any) {
      this.logger.warn(`启动补齐常驻怪物失败: ${err?.message ?? err}`);
    }
  }

  /**
   * 自动开采每分钟结算一次已积累时间，保留玩家的进行中标记。
   * 这样服务重启或玩家长时间离线时，收益不会因为内存定时器丢失而消失。
   */
  @Cron('15 * * * * *')
  async processAutoMining() {
    if (this.autoMineRunning) return;
    this.autoMineRunning = true;
    try {
      const settled = await this.autoMineService.checkpointAll();
      if (settled > 0) this.logger.log(`自动开采结算: ${settled} 名玩家`);
    } catch (err: any) {
      this.logger.error(`自动开采结算失败: ${err?.message || err}`);
    } finally {
      this.autoMineRunning = false;
    }
  }

  /**
   * 自动保存 - 每3分钟执行一次
   * 对应原版：自动保存线程（原版为3分钟一次，同时将最高级玩家等级写入配置中心）。
   * 本实现不写这一行：面板的「与最高级玩家等级差距」经验加成直接查 Player 表取实时值，
   * 写进 SystemConfig 只会在管理后台「系统配置」里多出一个改了没用、每3分钟又被覆盖的输入框。
   */
  @Cron('0 */3 * * * *') // 每3分钟（秒 分 时 日 月 周）
  async autoSave() {
    if (this.autoSaveRunning) {
      this.logger.warn('自动保存仍在运行中，跳过本次');
      return;
    }
    this.autoSaveRunning = true;
    this.lastAutoSaveTime = Date.now();

    try {
      const players = await this.prisma.player.findMany({
        where: { userId: { gt: 0 } },
        select: { updatedAt: true },
      });

      let savedCount = 0;
      for (const p of players) {
        // 只保存最近30分钟内有更新的玩家
        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
        if (p.updatedAt > thirtyMinAgo) {
          // PlayerService.savePlayer 已经处理了持久化
          savedCount++;
        }
      }

      this.logger.log(`自动保存完成: ${savedCount} 个玩家`);
    } catch (err: any) {
      this.logger.error(`自动保存失败: ${err.message}`);
    } finally {
      this.autoSaveRunning = false;
    }
  }

  /**
   * 在线时长统计 - 每分钟执行一次
   * 把最近5分钟内有更新（视为在线）的玩家累计在线秒数 +60，
   * 用于 GM 后台用户管理展示"累计在线时长"。
   *
   * 可用环境变量 PLAYTIME_CRON=off 停用：本任务每分钟推进活跃玩家的 version，
   * 会与「锁外快照式 savePlayer」路径互相挤掉写入（stale-block 静默丢写 / CAS
   * 冲突）——集成测试环境必须停用，否则 e2e 断言偶发读到半套写入的结果。
   */
  @Cron('30 * * * * *')
  async accumulatePlayTime() {
    if (process.env.PLAYTIME_CRON === 'off') return;
    try {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      // 静默上下文：纯统计写入，不触发 UI 同步事件（避免每分钟全体在线玩家的事件风暴）
      const result = await runSilent('cron:playTime', async () => {
        const active = await this.prisma.player.findMany({
          where: { userId: { gt: 0 }, updatedAt: { gte: fiveMinAgo } },
          select: { userId: true },
        });
        for (const row of active) {
          const uid = Number(row.userId);
          await this.playerService.enqueueUserWrite(uid, async () => {
            const _pd = await this.playerService.getPlayerData(uid);
            _pd.player.playTime = (Number(_pd.player.playTime ?? 0)) + 60;
            await this.playerService.savePlayer(_pd.player);
          });
        }
        return { count: active.length };
      });
      if (result.count > 0) this.logger.log(`在线时长统计: ${result.count} 名玩家 +60s`);
    } catch (err: any) {
      this.logger.error(`在线时长统计失败: ${err?.message || err}`);
    }
  }

  /**
   * 地图资源刷新 - 每分钟检查一次已到期的单项刷新标记
   * 对应原版：后台运作中的“刷新资源<名称>”处理
   */
  @Cron('0 * * * * *') // 每分钟
  async refreshMapResources() {
    try {
      const maps = await this.mapService.getAllMaps();
      let restored = 0;
      for (const map of maps) {
        restored += await this.mapService.refreshExpiredMapResources(map.id);
      }
      this.logger.log(`地图资源刷新完成: 检查 ${maps.length} 个地图，恢复 ${restored} 个资源`);
    } catch (err: any) {
      this.logger.error(`地图资源刷新失败: ${err.message}`);
    }
  }

  /**
   * 怪物重生 - 每分钟消费地图上的「刷新怪物」标记并按标记补怪
   * 对应原版：后台运作.ecode L1626-1690（后台线程逐 tick 扫描地图「标记2」）。
   *
   * 原版链路（**勿改回「数量不足就整批重刷」**）：
   *   击杀怪物 → 发放奖励 L458-461 登记「刷新怪物」标记（+120 秒）
   *   → 标记到期 → L1663-1674 补 1 只随机模板怪（上限 `地图.怪物数量`）
   *   → L1682 删除该标记。
   * ⚠️ 补怪**只增不删**：绝不重建存活怪，否则会把玩家已打出的伤害清零，
   *    导致战斗永远无法收尾。
   */
  @Cron('0 * * * * *') // 每分钟
  async respawnMonsters() {
    try {
      const allMaps = await this.mapService.getAllMaps();
      // 仅处理「有怪物模板」的非关卡地图：空模板地图（如城镇出口）原版语义就是无常驻怪，
      // 提前过滤掉可避免每分钟对它们空跑一轮标记扫描
      const maps = allMaps.filter((m: any) => this.isMonsterRespawnMap(m));

      let spawned = 0;
      let mapsTouched = 0;
      for (const map of maps) {
        const added = await this.mapService.refillResidentMonstersByMarker(map.id);
        if (added > 0) {
          spawned += added;
          mapsTouched += 1;
        }
      }
      if (spawned > 0) {
        this.logger.log(`怪物重生: ${mapsTouched} 张地图补出 ${spawned} 只常驻怪物`);
      }
    } catch (err: any) {
      this.logger.error(`怪物重生失败: ${err.message}`);
    }
  }

  /** 该地图是否参与后台补怪（原版 L1628/L1632：非关卡 + 有怪物模板 + 怪物数量 > 0）。 */
  private isMonsterRespawnMap(map: any): boolean {
    if (!(Number(map?.monsterCount) > 0)) return false;
    if (map?.isInstance || map?.关卡) return false;
    const tpl = Array.isArray(map?.monsters)
      ? map.monsters
      : typeof map?.monsters === 'string'
        ? this.safeParseStringArray(map.monsters)
        : [];
    return tpl.length > 0;
  }

  /**
   * 解析可能为 JSON 字符串的怪物模板字段（容错历史行数据）
   * @returns 怪物名数组，解析失败返回空数组
   */
  private safeParseStringArray(raw: string): string[] {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }


  /**
   * 行商判断 - 每小时整点执行
   * 对应原版：行商判断()，生成行商、花园宝宝、小白狐、露娜、神之工匠、小雫、小恶魔、小蓝
   * （无主载具已拆到独立 cron wreckSpawnTick，支持多时间点/到分）
   * 通过运行锁 + 逐步 try-catch，保证单个步骤失败不影响其他步骤
   */
  @Cron('0 0 * * * *') // 每小时整点（秒=0，分=0）
  async merchantSpawn() {
    if (this.merchantRunning) {
      this.logger.warn('行商判断仍在运行中，跳过本次');
      return;
    }
    this.merchantRunning = true;

    try {
      // 获取可刷特殊的地图（排除开拓地/关卡/不刷特殊）
      const maps = await this.getSpawnableMaps();
      if (maps.length === 0) {
        this.logger.warn('行商判断: 没有可刷特殊的地图');
        return;
      }

      // 1. 清理上一小时生成的行商/露娜/神之工匠/小雫/小恶魔
      await this.clearOldMerchants(maps);

      // 2. 生成行商 NPC
      await this.spawnMerchant(maps);

      // 3. 生成特殊宠物（花园宝宝、小白狐）
      await this.spawnSpecialPet(maps, '花园宝宝');
      await this.spawnSpecialPet(maps, '小白狐');

      // 4. 生成露娜（特殊怪物）
      await this.spawnLuna(maps);

      // 5. 生成神之工匠、小雫（特殊 NPC）
      await this.spawnArtisanAndXiaonv(maps);

      // 6. 生成小恶魔（怪物2）
      // 对齐原版 L1358：小恶魔仅在开拓地生成（开拓地==假时重选）
      const frontierMaps = await this.mapService.getAllMaps();
      const frontierOnly = frontierMaps.filter((m: any) =>
        m.isFrontier && !m.isInstance && !m.noSpecial);
      if (frontierOnly.length > 0) {
        await this.spawnLittleDemon(frontierOnly);
      }

      // 7. 生成小蓝（5%几率生成特殊物品）
      await this.spawnBlueItem(maps);
      // 注：废弃载具改由独立的每分钟 cron（wreckSpawnTick）按 game.wreckSpawnHour 时间点表触发
    } catch (err: any) {
      this.logger.error(`行商判断失败: ${err.message}`);
    } finally {
      this.merchantRunning = false;
    }
  }

  /**
   * 清理上一小时生成的特殊 NPC 和怪物
   * 对应原版：行商判断 开头删除旧的 行商/露娜/npc1(神之工匠)/npc2(小雫)/小恶魔
   */
  private async clearOldMerchants(maps: any[]): Promise<void> {
    try {
      let cleaned = 0;
      for (const map of maps) {
        let changed = false;

        // 清理 GameMonster 表中的 小恶魔（临时怪物）——先做（独立表，与 Json 列无关）
        const tempMonsters = await this.mapService.getMapMonsters(map.id);
        const demonMonsters = tempMonsters.filter(
          (m: any) => (m.name || '') === '小恶魔' || (m.qq || '') === '怪物小恶魔1',
        );
        for (const dm of demonMonsters) {
          await this.mapService.removeMapMonster(map.id, dm.id);
        }
        if (demonMonsters.length > 0) changed = true;

        // npcs/summons 走 mutateMapFields 锁内闭环：重读最新数组 → 过滤 → 差异写回，
        // 消除「定时器整组写回覆盖玩家并发写入」的丢失更新。
        await this.mapService.mutateMapFields(map.id, ['npcs', 'summons'], (f) => {
          // 清理 npcs 中的 行商/神之工匠/小雫
          const keptNpcs = f.npcs.filter(
            (n: any) => !['行商', '神之工匠', '小雫'].includes(n.name),
          );
          // 清理 summons 中的 露娜 及历史遗留的 npc1*/npc2*/行商
          const keptSummons = f.summons.filter((s: any) => {
            const name = s.name || '';
            const qq = s.qq || '';
            if (['行商', '神之工匠', '小雫', '露娜'].includes(name)) return false;
            if (qq === '怪物露娜1g') return false;
            if (qq.startsWith('npc1') || qq.startsWith('npc2')) return false;
            return true;
          });
          if (keptNpcs.length !== f.npcs.length || keptSummons.length !== f.summons.length) {
            changed = true;
          }
          f.npcs = keptNpcs;
          f.summons = keptSummons;
        });

        if (changed) {
          cleaned++;
        }
      }
      if (cleaned > 0) this.logger.log(`行商判断: 清理了 ${cleaned} 个地图的旧 NPC`);
    } catch (err: any) {
      this.logger.error(`清理旧 NPC 失败: ${err.message}`);
    }
  }

  /**
   * 生成行商 NPC（随机地图，含物品库存）
   * 对齐原版 后台运作.ecode L1213-1231：生成行商时调用 生成行商物品(g.背包)
   */
  private async spawnMerchant(maps: any[]): Promise<void> {
    try {
      const map = this.pickRandomMap(maps);
      // 快照预检（仅省库存构建开销；权威判定在下方锁内复查）
      const snapshot = this.parseJsonArray<any>(map.summons);
      if (snapshot.some((n: any) => n?.name === '行商')) return;

      // 生成行商物品库存（对齐原版 L1228 生成行商物品(g.背包)）
      const inventory = await this.gameService.buildMerchantInventory(1, 0);

      // 行商作为召唤物加入地图（对齐原版 L1223-1231：归属="1"，类型=名称）
      // 库存写入 backpack 键（购物/查看等读取端统一用 backpack，原版"背包"仅作历史兼容迁移）
      // mutateSummons 锁内闭环：重读最新 summons → 已有行商则跳过 → push 差异写回，
      // 与玩家并发写（宠物召回等）互不覆盖。
      const merchantQQ = `召唤物${Date.now()}`;
      const added = await this.mapService.mutateSummons(map.id, (summons) => {
        // 若地图已有行商则跳过，避免重复（原版也按 name 判断）
        if (summons.some((n: any) => n?.name === '行商')) return false;
        summons.push({
          // 召唤物字段只写规范键：归属→ownerQQ、类型→type、标记→markers
          ownerQQ: '1',
          name: '行商',
          type: '行商',
          backpack: inventory,
          qq: merchantQQ,
          markers: {},
        });
        return true;
      });
      if (added) {
        this.logger.log(`行商判断: 在地图 ${map.name} 生成了行商（含${inventory.length}件物品）`);
      }
    } catch (err: any) {
      this.logger.error(`生成行商失败: ${err.message}`);
    }
  }

  /**
   * 生成特殊宠物（花园宝宝 / 小白狐）
   * 对应原版：先统计全地图已有数量，未达上限时在随机地图生成召唤物
   * @param petName 宠物名称（花园宝宝/小白狐）
   */
  private async spawnSpecialPet(maps: any[], petName: string): Promise<void> {
    try {
      // 读取数量上限配置（-1 表示上限=地图数量，与原版一致）
      const configKey = petName === '花园宝宝' ? 'game.petGardenBabyLimit' : 'game.petWhiteFoxLimit';
      let limit = await this.getConfigValue<number>(configKey, -1);
      if (limit === -1) limit = maps.length;

      // 统计全地图该宠物的已有数量
      const currentCount = await this.countSpecialPet(petName);
      if (currentCount >= limit) {
        this.logger.log(`行商判断: ${petName} 已达上限 ${currentCount}/${limit}，跳过生成`);
        return;
      }

      const map = this.pickRandomMap(maps);
      // mutateSummons 锁内闭环：重读最新 summons 后 push，与玩家并发写互不覆盖
      await this.mapService.mutateSummons(map.id, (summons) => {
        summons.push({
          name: petName,
          type: petName,
          specialSeq: -2,
          ownerQQ: '1',
          qq: `召唤物${this.genId()}`,
          hp: 100,
          maxHp: 100,
          attack: 10,
          defense: 5,
          speed: 100,
          level: 1,
          markers: {},
          vehicle: '',
        });
      });
      this.logger.log(`行商判断: 在地图 ${map.name} 生成了 ${petName}（现有 ${currentCount + 1}/${limit}）`);
    } catch (err: any) {
      this.logger.error(`生成特殊宠物 ${petName} 失败: ${err.message}`);
    }
  }

  /**
   * 统计全地图某特殊宠物的已有数量
   */
  private async countSpecialPet(petName: string): Promise<number> {
    const maps = await this.mapService.getAllMaps();
    const mapsWithSummons = maps.map((m: any) => ({ summons: m.summons }));
    let count = 0;
    for (const m of mapsWithSummons) {
      const summons = this.parseJsonArray<any>(m.summons);
      count += summons.filter((s: any) => s.name === petName).length;
    }
    return count;
  }

  /**
   * 生成露娜（特殊怪物，加入地图召唤物，QQ=怪物露娜1g，特殊序号=-2）
   */
  private async spawnLuna(maps: any[]): Promise<void> {
    try {
      const map = this.pickRandomMap(maps);
      // mutateSummons 锁内闭环：重读最新 summons → 查重 → push，与玩家并发写互不覆盖
      await this.mapService.mutateSummons(map.id, (summons) => {
        if (summons.some((s: any) => s.qq === '怪物露娜1g')) return;
        summons.push({
          name: '露娜',
          type: '露娜',
          ownerQQ: '1',
          qq: '怪物露娜1g',
          specialSeq: -2,
          hp: 500,
          maxHp: 500,
          attack: 50,
          defense: 20,
          speed: 120,
          level: 30,
          markers: {},
          vehicle: '',
        });
      });
      this.logger.log(`行商判断: 在地图 ${map.name} 生成了露娜`);
    } catch (err: any) {
      this.logger.error(`生成露娜失败: ${err.message}`);
    }
  }

  /**
   * 生成神之工匠、小雫（特殊 NPC，加入地图 npcs 字段）
   */
  private async spawnArtisanAndXiaonv(maps: any[]): Promise<void> {
    try {
      const map = this.pickRandomMap(maps);
      const npcs = this.parseJsonArray<any>(map.npcs);

      // 神之工匠（QQ=npc1g）
      if (!npcs.some((n: any) => n.name === '神之工匠' || n.qq === 'npc1g')) {
        npcs.push({
          name: '神之工匠',
          type: 'npc',
          title: '锻造大师',
          description: '能够打造传说级装备的工匠大师',
          qq: 'npc1g',
        });
      }
      // 小雫（QQ=npc2g）
      if (!npcs.some((n: any) => n.name === '小雫' || n.qq === 'npc2g')) {
        npcs.push({
          name: '小雫',
          type: 'npc',
          title: '精英小雫',
          description: '精英小雫',
          qq: 'npc2g',
        });
      }

      await this.mapService.updateDynamicFields(map.id, {
        npcs: npcs,
      });
      this.logger.log(`行商判断: 在地图 ${map.name} 生成了神之工匠、小雫`);
    } catch (err: any) {
      this.logger.error(`生成神之工匠/小雫失败: ${err.message}`);
    }
  }

  /**
   * 生成小恶魔（加入地图怪物2=tempMonsters，QQ=怪物小恶魔1）
   */
  private async spawnLittleDemon(maps: any[]): Promise<void> {
    try {
      const map = this.pickRandomMap(maps);
      const existing = await this.mapService.getMapMonsters(map.id);
      if (existing.some((m: any) => m.qq === '怪物小恶魔1')) return;

      // 小恶魔作为临时怪物写入 GameMonster 表
      await this.mapService.addTempMonster(map.id, {
        name: '小恶魔',
        type: '小恶魔',
        qq: '怪物小恶魔1',
        specialSeq: -2,
        level: 10,
        hp: 300,
        maxHp: 300,
        attack: 30,
        defense: 10,
        speed: 110,
        dodge: 5,
        hit: 85,
        exp: 50,
      });
      this.logger.log(`行商判断: 在地图 ${map.name} 生成了小恶魔`);
    } catch (err: any) {
      this.logger.error(`生成小恶魔失败: ${err.message}`);
    }
  }

  /**
   * 生成小蓝（5%几率在地图物品中添加特殊物品）
   */
  private async spawnBlueItem(maps: any[]): Promise<void> {
    try {
      const chance = await this.getConfigValue<number>('game.blueChance', 5);
      if (Math.random() * 100 >= chance) return;

      const map = this.pickRandomMap(maps);
      const items = this.parseJsonArray<any>(map.items);
      // 若地图已存在小蓝则跳过
      if (items.some((it: any) => it.name === '小蓝')) return;

      items.push({
        name: '小蓝',
        // 数量只写规范键 quantity（count 是同义旧键，写了就是镜像脏数据）
        quantity: 1,
        type: '资源',
        data: 'a',
      });
      await this.mapService.updateDynamicFields(map.id, {
        items: items,
      });
      this.logger.log(`行商判断: 在地图 ${map.name} 生成了特殊物品小蓝`);
    } catch (err: any) {
      this.logger.error(`生成小蓝失败: ${err.message}`);
    }
  }

  /**
   * 解析 game.wreckSpawnHour 配置 → 当天有效的 {hour,minute} 列表。
   *
   * 兼容格式（逗号/顿号/空白分隔，可混用）：
   *   - 「10」或「10:00」 → 10 点整
   *   - 「10,22」         → 10 点、22 点整（旧值兼容）
   *   - 「10:00,20:22」   → 10:00、20:22（精确到分）
   *   - 「-1」或空        → 关闭自动刷新（返回空数组）
   * 非法片段跳过；全部非法视同关闭。
   */
  private parseWreckSpawnTimes(raw: string): Array<{ hour: number; minute: number }> {
    const text = String(raw ?? '').trim();
    if (!text || text === '-1') return [];

    const times: Array<{ hour: number; minute: number }> = [];
    for (const part of text.split(/[,，;；\s]+/)) {
      if (!part) continue;
      const m = part.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
      if (!m) continue;
      const hour = Number(m[1]);
      const minute = m[2] !== undefined ? Number(m[2]) : 0;
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) continue;
      times.push({ hour, minute });
    }
    return times;
  }

  /**
   * 废弃载具定时刷新 - 每分钟整点秒触发，匹配 game.wreckSpawnHour 时间点表。
   *
   * 现行规则（配置中心可在线调整，实时生效）：
   *   1. game.wreckSpawnHour 支持多个时间点，可精确到分（默认 10 = 10:00）；
   *      -1 或空 = 关闭自动刷新。
   *   2. 全图无主载具总数达到 game.wreckMaxCount（默认 3）时跳过；0 = 不限制。
   *   3. 到点且未达上限则必刷一个（force=true）；同一分钟槽位只触发一次。
   * 生成与投放统一走 DungeonChallengeService.spawnWreckToRandomMap（与管理员指令同源，
   * 数据源 wrecks.json）。管理员「生成废弃载具」不受上限限制。
   */
  @Cron('0 * * * * *') // 每分钟第 0 秒（对齐 HH:mm 匹配粒度）
  async wreckSpawnTick() {
    if (this.wreckSpawnRunning) return;
    this.wreckSpawnRunning = true;
    try {
      await this.spawnRandomVehicle();
    } catch (err: any) {
      this.logger.error(`废弃载具定时刷新失败: ${err.message}`);
    } finally {
      this.wreckSpawnRunning = false;
    }
  }

  private async spawnRandomVehicle(): Promise<void> {
    try {
      const now = new Date();
      const hour = now.getHours();
      const minute = now.getMinutes();
      const raw = await this.getConfigValue<string>('game.wreckSpawnHour', '10');
      const spawnTimes = this.parseWreckSpawnTimes(raw);
      const maxCount = await this.getConfigValue<number>('game.wreckMaxCount', 3);

      // 未命中任一配置时间点：跳过
      if (!spawnTimes.some((t) => t.hour === hour && t.minute === minute)) return;

      // 同一分钟槽位只触发一次（cron 与配置变更边界防抖）
      const slot = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      if (this.lastWreckSpawnSlot === slot) return;
      this.lastWreckSpawnSlot = slot;

      // 统计全图无主载具数量（含开拓地/关卡等，与原版扫描口径一致）
      const allMaps = await this.mapService.getAllMaps();
      let ownerlessCount = 0;
      for (const map of allMaps) {
        const vehicles = asJsonValue<any[]>(map.vehicles, []);
        for (const v of vehicles) {
          // 无主判定：载具归属规范键为 owner（中文别名「归属」由持久化边界收敛删除）
          if (String(v?.owner ?? '') === '无主') {
            ownerlessCount++;
          }
        }
      }

      // 达到全图上限：不刷新
      if (maxCount > 0 && ownerlessCount >= maxCount) {
        this.logger.log(
          `废弃载具: 已达全图上限 ${ownerlessCount}/${maxCount}，跳过 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} 刷新`,
        );
        return;
      }

      const result = await this.dungeonChallengeService.spawnWreckToRandomMap(true);
      if (result.ok) {
        this.logger.log(
          `废弃载具: 在地图 ${result.mapName} 生成了无主载具「${result.wreckName}」（${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} 必刷）`,
        );
      }
    } catch (err: any) {
      this.logger.error(`生成随机载具失败: ${err.message}`);
    }
  }

  /**
   * 掉落货舱 - 每小时整点后5秒执行
   * 对应原版：掉落货舱()，生成3个货舱、5个能量元素，随机几率生成作物
   * 与行商判断错开5秒执行，避免同一秒内并发操作数据库
   */
  @Cron('5 0 * * * *') // 每小时整点后5秒（秒=5，分=0）
  async dropCargoPods() {
    if (this.cargoRunning) {
      this.logger.warn('掉落货舱仍在运行中，跳过本次');
      return;
    }
    this.cargoRunning = true;

    try {
      const maps = await this.getSpawnableMaps();
      if (maps.length === 0) {
        this.logger.warn('掉落货舱: 没有可刷特殊的地图');
        return;
      }

      // 1. 生成货舱：基础 3 个 + 世界事件全服 buff 额外增量（原版 L324-348：随机地图；已存在则 次数+1，不存在则追加完整资源定义）
      const extraPods = Math.max(0, Number(this.worldEvent?.getActiveBuffValues().cargoPods) || 0);
      const podCount = 3 + extraPods;
      for (let i = 0; i < podCount; i++) {
        const map = this.pickRandomMap(maps);
        await this.mapService.dropResourceToMap(map.id, '货舱', 1);
      }

      // 2. 生成5个能量元素（原版 L349-373，同上）
      for (let i = 0; i < 5; i++) {
        const map = this.pickRandomMap(maps);
        await this.mapService.dropResourceToMap(map.id, '能量元素', 1);
      }

      // 3. 随机几率生成作物（在已有作物的地图上添加一个作物）
      await this.spawnCrop(maps);

      this.logger.log(`掉落货舱完成: ${podCount}个货舱${extraPods > 0 ? `（含世界事件+${extraPods}）` : ''} + 5个能量元素`);
    } catch (err: any) {
      this.logger.error(`掉落货舱失败: ${err.message}`);
    } finally {
      this.cargoRunning = false;
    }
  }

  /**
   * 随机几率生成作物（默认5%）
   *
   * 对齐原版 后台运作.ecode L374-393：随机一张可刷特殊地图，从**全局资源列表**里
   * 挑一个「产出2 非空」的作物（原版判定：只有配置里产出2 非空且首个产出名称非空的
   * 才算作物），投放完整定义到该地图。
   * 注意：不是"复制地图上已有的作物"——那样在没有作物的地图上永远刷不出作物，
   * 而且复制的运行时副本同样落在采集链路读不到的字段里。
   *
   */
  private async spawnCrop(maps: any[]): Promise<void> {
    try {
      const cropChance = await this.getConfigValue<number>('game.cropChance', 5);
      if (Math.random() * 100 >= cropChance) return;

      const allResources = asJsonValue<any[]>(this.staticData.getAllResources(), []);
      // 原版 L380-388：产出2 非空且第一个产出名称不为空 = 作物
      const cropTemplates = allResources.filter((r: any) => {
        const outputs2 = r?.outputs2 ?? [];
        if (!Array.isArray(outputs2) || outputs2.length === 0) return false;
        return String(outputs2[0]?.name ?? '').trim() !== '';
      });
      if (cropTemplates.length === 0) return;

      const crop = cropTemplates[Math.floor(Math.random() * cropTemplates.length)];
      const map = this.pickRandomMap(maps);
      await this.mapService.dropResourceToMap(map.id, String(crop?.name ?? ''), 1);
      this.logger.log(`掉落货舱: 在地图 ${map.name} 生成了作物「${crop.name}」`);
    } catch (err: any) {
      this.logger.error(`生成作物失败: ${err.message}`);
    }
  }

  /**
   * 生成副本 - 0点/12点/18点整执行
   * 对应原版：生成副本()，在随机地图生成2个副本入口（副本名从配置读取）
   */
  @Cron('0 0 0,12,18 * * *') // 0点、12点、18点（秒=0，分=0）
  async spawnInstances() {
    if (this.instanceRunning) {
      this.logger.warn('生成副本仍在运行中，跳过本次');
      return;
    }
    this.instanceRunning = true;

    try {
      const maps = await this.getSpawnableMaps();
      if (maps.length === 0) {
        this.logger.warn('生成副本: 没有可刷特殊的地图');
        return;
      }

      const pools = await this.getInstanceNamePools();

      // 原版 后台运作.ecode L3-35：生成 2 个入口，第 1 个取「副本」名单、第 2 个取「副本2」名单
      for (let i = 0; i < 2; i++) {
        const names = i === 0 ? pools.primary : pools.secondary;
        if (names.length === 0) {
          this.logger.warn(`生成副本: 第 ${i + 1} 个入口没有可用的副本名`);
          continue;
        }
        const map = this.pickRandomMap(maps);
        const name = names[Math.floor(Math.random() * names.length)];
        // 与「开启副本」共用入口生成逻辑：入口带 mapId 指向真实副本地图。
        // 原版只加不删（后台运作.ecode L22/L35），入口累积到「刷新副本」关闭或重启重置。
        const result = await this.dungeonService.openDungeonEntry(
          Number(map.id),
          name,
          DUNGEON_ENTRY_SOURCE.SPAWN,
        );
        if (!result.ok) {
          this.logger.warn(`生成副本: 地图 ${map.name} 添加入口失败 - ${result.reason}`);
          continue;
        }
        this.logger.log(`生成副本: 地图 ${map.name} 添加了副本入口「${result.entryName}」→地图#${result.mapId}`);
      }
    } catch (err: any) {
      this.logger.error(`生成副本失败: ${err.message}`);
    } finally {
      this.instanceRunning = false;
    }
  }

  /**
   * 读取两个副本名池（原版 [商店]副本 / [商店]副本2）：
   * 配置中心可覆盖，任何来源的名字都按地图表过滤，只保留真实存在的副本名。
   */
  private async getInstanceNamePools(): Promise<{ primary: string[]; secondary: string[] }> {
    const shop = (this.staticData.getAllShops?.() || [])[0] || {};
    let primary = await this.resolveInstanceNames('game.instanceNames', toNameArray(shop?.dungeons));
    let secondary = await this.resolveInstanceNames('game.instanceNames2', toNameArray(shop?.dungeons2));

    // 兜底：配置与静态数据都不可用时退回真实副本组名，保证生成的入口一定进得去
    if (primary.length === 0 || secondary.length === 0) {
      const groupNames = (await this.dungeonService.getInstanceGroups()).map((group) => group.name);
      if (primary.length === 0) primary = groupNames;
      if (secondary.length === 0) secondary = groupNames;
    }
    return { primary, secondary };
  }

  /**
   * 解析单个副本名池：优先配置中心，回退静态数据；两者都按地图表过滤。
   */
  private async resolveInstanceNames(key: string, fallback: string[]): Promise<string[]> {
    const configured = await this.getConfigValue<string[]>(key, []);
    const candidates = Array.isArray(configured) && configured.length > 0 ? configured : fallback;
    const valid = await this.filterExistingMapNames(candidates);
    return valid.length > 0 ? valid : await this.filterExistingMapNames(fallback);
  }

  /**
   * 只保留地图表中真实存在的副本名。
   * 入口解析目标地图靠“去掉(副本)后的名称”，名字对不上地图的入口玩家永远进不去。
   */
  private async filterExistingMapNames(names: string[]): Promise<string[]> {
    const maps = await this.mapService.getAllMaps();
    const existing = new Set(
      maps.map((map: any) => String(map?.name || '').trim()).filter(Boolean),
    );
    return names.map((name) => String(name).trim()).filter((name) => existing.has(name));
  }

  /**
   * 清理过期标记和增益 - 每5分钟执行一次
   * 对应原版：标记清理 + 刷新标记(1怪物 2资源)的过期清理
   */
  @Cron('0 */5 * * * *') // 每5分钟
  async cleanupExpiredBuffs() {
    try {
      const nowMs = Date.now();
      // markers2 保留「秒级到期时间」的原清理口径：该容器里有两类语义混存——
      // ① 到期时刻（武器冷却 now+秒*1000 毫秒 / 技能冷却 nowSec+秒 秒级）；
      // ② 触发时刻（"被寒风冷却""光棱"等，expireAt 记的是上次触发时刻，
      //    由 `nowMs - expireAt > 间隔` 判断是否可再次触发）。
      // 若对 ② 用「到期时刻」口径过滤，会被当成已过期直接删除，冷却记录丢失。
      // 因此 markers2 只清理秒级到期时刻，buffs 才走统一归一化过滤。
      const nowSec = Math.floor(nowMs / 1000);

      // ----- 清理玩家过期标记和增益 -----
      const players = await this.prisma.player.findMany({
        select: { userId: true, markers2: true, buffs: true },
      });

      let cleanedCount = 0;
      for (const player of players) {
        let changed = false;

        // 清理过期 markers2（秒级到期时刻口径，见上方说明）
        const markers2 = asJsonValue<any[]>(player.markers2, []);
        const validMarkers2 = markers2.filter((m: any) => {
          if (!m?.expireAt) return true;
          const raw = Number(m.expireAt);
          const expireSec = raw >= 1e12 ? raw / 1000 : raw;
          return expireSec > nowSec;
        });
        if (validMarkers2.length !== markers2.length) {
          changed = true;
        }

        // 清理过期 buffs（秒/毫秒两种历史写法都识别；DB Json 字段容错读取）
        const buffs = asJsonValue<any[]>(player.buffs, []);
        const validBuffs = filterActive(buffs, nowMs);
        if (validBuffs.length !== buffs.length) {
          changed = true;
        }

        if (changed) {
          // 玩家写路径统一入队（per-user 串行邮箱），与游戏内写路径互斥，
          // 避免绕过邮箱的裸写造成 markers2/buffs 覆盖。
          await this.playerService.enqueueUserWrite(Number(player.userId), async () => {
            const data = await this.playerService.getPlayerData(Number(player.userId));
            const freshM2 = (data.markers2 || []).filter((m: any) => {
              if (!m?.expireAt) return true;
              const raw = Number(m.expireAt);
              const expireSec = raw >= 1e12 ? raw / 1000 : raw;
              return expireSec > nowSec;
            });
            const freshBuffs = filterActive(data.buffs || [], nowMs);
            data.player.markers2 = freshM2;
            data.player.buffs = freshBuffs;
            await this.playerService.savePlayer(data.player);
          });
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        this.logger.log(`清理了 ${cleanedCount} 个玩家的过期标记`);
      }

      // ----- 清理地图过期标记（对应原版 后台运作 L1682 的到期删除副作用） -----
      // ⚠️ 必须走 pruneExpiredMapMarkers2（锁内重读 → 只删已过期的一般标记）：
      //   - 不能用「循环外批量读取的快照」整组回写——遍历耗时期间其他写路径
      //     （击杀登记「刷新怪物」、采集登记「刷新资源X」）新增的标记会被抹掉；
      //   - 「刷新怪物」/「刷新资源X」**不清理**：它们必须由各自的专用消费者
      //     （respawnMonsters / refreshMapResources，均每分钟）消费掉，提前删除
      //     会让怪物/资源从此不再刷新。
      const allMapsForCleanup = await this.mapService.getAllMaps();

      let cleanedMaps = 0;
      for (const map of allMapsForCleanup) {
        // 快照为空只用于"跳过"（不可能有可清理项）；真正的判断在锁内重读后进行
        if (this.parseJsonArray<any>(map.markers2).length === 0) continue;
        const removed = await this.mapService.pruneExpiredMapMarkers2(map.id, nowMs);
        if (removed > 0) cleanedMaps++;
      }

      if (cleanedMaps > 0) {
        this.logger.log(`清理了 ${cleanedMaps} 个地图的过期标记`);
      }
    } catch (err: any) {
      this.logger.error(`清理过期标记失败: ${err.message}`);
    }
  }

  getAutoSaveStatus(): { lastSave: number; running: boolean } {
    return {
      lastSave: this.lastAutoSaveTime,
      running: this.autoSaveRunning,
    };
  }

  /**
   * 获取可刷特殊事件的地图列表（排除开拓地/关卡/不刷特殊）
   */
  private async getSpawnableMaps(): Promise<any[]> {
    const maps = await this.mapService.getAllMaps();
    return maps.filter((m: any) => !m.isFrontier && !m.isInstance && !m.noSpecial);
  }

  /** 从地图列表中随机选取一个地图 */
  private pickRandomMap(maps: any[]): any {
    return maps[Math.floor(Math.random() * maps.length)];
  }

  /**
   * 安全解析 JSON 数组，解析失败返回空数组
   * 兼容 JSON 字符串和已解析的数组（来自 mapService.getAllMaps 返回的合并数据）
   */
  private parseJsonArray<T>(jsonStr: unknown): T[] {
    // 已是数组：直接返回（Prisma Json 列 / 合并数据读取路径）
    if (Array.isArray(jsonStr)) return jsonStr as T[];
    // 其余（字符串/对象/null）走容错解析；非数组的合法 JSON（如对象）不算数组，返回空数组
    const parsed = asJsonValue<unknown>(jsonStr, []);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }

  /** 生成唯一编号（时间戳+随机数） */
  private genId(): string {
    return `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  }

  /** 从配置中心读取配置值（按类型自动解析），不存在或解析失败时返回默认值 */
  private async getConfigValue<T>(key: string, defaultValue: T): Promise<T> {
    try {
      const row = await this.prisma.systemConfig.findUnique({ where: { key } });
      if (!row || row.value === '') return defaultValue;

      switch (row.type) {
        case 'number': {
          const num = Number(row.value);
          return (Number.isNaN(num) ? defaultValue : num) as T;
        }
        case 'boolean':
          return (row.value === 'true') as T;
        case 'json':
        case 'string-array': {
          try {
            return JSON.parse(row.value) as T;
          } catch {
            // 兼容逗号分隔的文本
            return (row.value.split(',').map((s) => s.trim()).filter(Boolean) as unknown) as T;
          }
        }
        default:
          return (row.value ?? defaultValue) as T;
      }
    } catch {
      return defaultValue;
    }
  }
}
