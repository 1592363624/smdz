/**
 * 排行榜指令域服务（game 模块化重构 P2-1 抽出）
 *
 * 职责：全部排行榜指令——战力/等级/理论伤害/最大伤害/击杀/在线时长/使魔/财富/
 *       载具价值排行与调度入口 handleRanking，以及排行数据源随指令结算
 *       （recordRankingStats：在线时间累计 + 战力历史记录）。
 * 依赖方向：依赖支撑层（GameSupportService）、Prisma、Player、CombatSystem、
 *       CombatState、Bonus、Item；不依赖任何指令域子服务。
 * 单一真相源：排行文本统一 formatRankingText；在线时长文本统一走
 *       game-text.util.formatSecondsDurationText（支撑层 secondsToTimeText）。
 * 对口原版：_主程序.ecode 排行榜显示（L9718-9745 等）。
 *
 * 状态字段（§4.1 归属表，随本批迁出）：lastCalcAtByUser（在线时间结算基准）、
 * RANKING_SUB_TYPES（排行子类型定义，static）。
 */import { Injectable, Logger } from '@nestjs/common';
import { asJsonValue } from '../../../common/utils/json-value.util';
import { formatDamageText } from '../../../common/utils/game-text.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { PlayerService } from '.././player.service';
import { BonusService } from '.././bonus.service';
import { CombatSystemService } from '.././combat-system.service';
import { ItemService } from '.././item.service';
import { CombatStateService } from '.././combat-state.service';
import { GameSupportService } from '.././game-support.service';

@Injectable()
export class RankingCommandService {
  private readonly logger = new Logger(RankingCommandService.name);

  constructor(
    private readonly support: GameSupportService,
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly bonusService: BonusService,
    private readonly combatSystem: CombatSystemService,
    private readonly itemService: ItemService,
    private readonly combatState: CombatStateService,
  ) {}

  async handleFamiliarRank(userId: number, subtype = ''): Promise<string> {
    const requester = await this.prisma.player.findUnique({ where: { userId } });
    const requesterName = requester?.name || '冒险者';
    const normalized = (subtype || '').trim();

    // 无参：十项编号菜单（原版 L9565「1@使魔排行战斗力#2@使魔排行等级#...」）
    if (!normalized) {
      const lines = await this.support.buildNumberedMenu(
        userId,
        RankingCommandService.RANKING_SUB_TYPES.map((t) => ({ label: `使魔排行${t}`, cmd: `使魔排行${t}` })),
        '💡 发送编号数字或「使魔排行+子榜名」(如 使魔排行战斗力) 查看对应排行',
      );
      return [`${requesterName}`, ...lines].join('\n');
    }

    // 英文别名归一（排行 财富/载具 复用同分支）
    const type = normalized === 'wealth' ? '财富' : normalized === 'vehicle' ? '载具' : normalized;
    if (!(RankingCommandService.RANKING_SUB_TYPES as readonly string[]).includes(type)) {
      return `${requesterName}不是可以查看的排行榜`; // 原版 L9731
    }
    switch (type) {
      case '战斗力': return this.handleCombatPowerRanking(requesterName);
      case '等级': return this.handleLevelRanking(requesterName);
      case '理论输出': return this.handleTheoreticalDamageRanking(requesterName);
      case '最高伤害': return this.handleMaxDamageRanking(requesterName);
      case '击杀': return this.handleKillCountRanking(requesterName);
      case '在线时间': return this.handleOnlineTimeRanking(requesterName);
      case '财富': return this.handleWealthRanking(requesterName);
      case '宠物战斗力': return this.handlePetRanking(requesterName, '战斗力');
      case '宠物最高伤害': return this.handlePetRanking(requesterName, '最高伤害');
      default: return this.handleVehicleValueRanking(requesterName); // 载具
    }
  }

  /** 原版排行玩家过滤（_主程序.ecode L9571 等）：老玩家(已选使魔)且等级>10 */

  isRankablePlayer(p: any): boolean {
    return String(p?.type || '') !== '' && Number(p?.level || 0) > 10;
  }

  /** 玩家成就类子榜通用收集：从 Player.markers 读成就键（原版 取成就熟练度） */

  async collectPlayerMarkerEntries(
    key: string,
    options: { excludeZero?: boolean } = {},
  ): Promise<Array<{ name: string; value: number }>> {
    const players = await this.prisma.player.findMany();
    const entries: Array<{ name: string; value: number }> = [];
    for (const p of players) {
      if (!this.isRankablePlayer(p)) continue;
      const markers = asJsonValue<Record<string, number>>(p.markers, {});
      const value = this.combatState.getAchievementProficiency(markers, key);
      // 原版 L9601/L9616：最高伤害/杀敌数量为 0 不入榜
      if (options.excludeZero && value === 0) continue;
      entries.push({ name: String(p.name || '冒险者'), value });
    }
    return entries;
  }

  /** 曾经达到的最高战斗力排行（原版 L9569-9578） */

  handleCombatPowerRanking(requesterName: string): Promise<string> {
    return this.collectPlayerMarkerEntries('战斗力').then((entries) =>
      this.formatRankingText(requesterName, '曾经达到的最高战斗力排行', entries),
    );
  }

  /** 等级排行（原版 L9579-9588） */

  async handleLevelRanking(requesterName: string): Promise<string> {
    const players = await this.prisma.player.findMany();
    const entries = players
      .filter((p) => this.isRankablePlayer(p))
      .map((p) => ({ name: String(p.name || '冒险者'), value: Number(p.level || 0) }));
    return this.formatRankingText(requesterName, '等级排行', entries);
  }

  /**
   * 理论输出排行（原版 L9589-9598）：
   * 四系伤害之和 ×(1 + 暴击/100 ×(暴伤-100)/100)，按计算后属性现算
   */

  async handleTheoreticalDamageRanking(requesterName: string): Promise<string> {
    const players = await this.prisma.player.findMany();
    const entries: Array<{ name: string; value: number }> = [];
    for (const p of players) {
      if (!this.isRankablePlayer(p)) continue;
      try {
        const playerData = await this.playerService.getPlayerData(p.userId);
        const b = this.combatSystem.buildAttackerBonus(p, playerData);
        const element =
          (Number(b.物伤) || 0) + (Number(b.冰伤) || 0) +
          (Number(b.电伤) || 0) + (Number(b.火伤) || 0);
        const value =
          element + element * ((Number(b.暴击) || 0) / 100) * (((Number(b.暴击伤害) || 100)) - 100) / 100;
        entries.push({ name: String(p.name || '冒险者'), value });
      } catch {
        // 单个玩家属性异常时跳过
      }
    }
    return this.formatRankingText(requesterName, '理论输出排行', entries);
  }

  /** 曾经造成的最高伤害排行（原版 L9599-9611） */

  handleMaxDamageRanking(requesterName: string): Promise<string> {
    return this.collectPlayerMarkerEntries('最高伤害', { excludeZero: true }).then((entries) =>
      this.formatRankingText(requesterName, '曾经造成的最高伤害排行', entries),
    );
  }

  /** 杀敌数量排行（原版 L9612-9624） */

  handleKillCountRanking(requesterName: string): Promise<string> {
    return this.collectPlayerMarkerEntries('击败怪物', { excludeZero: true }).then((entries) =>
      this.formatRankingText(requesterName, '杀敌数量排行', entries),
    );
  }

  /** 在线时间排行（原版 L9625-9634；输出用 数字到时间 格式） */

  handleOnlineTimeRanking(requesterName: string): Promise<string> {
    return this.collectPlayerMarkerEntries('在线时间').then((entries) =>
      this.formatRankingText(requesterName, '在线时间排行', entries, (v) => this.support.secondsToTimeText(v)),
    );
  }

  /**
   * 宠物排行榜（原版 L9679-9712）：全地图存活召唤物，按召唤物标记去重（屏蔽复制品）
   * @param kind '战斗力' | '最高伤害'
   */

  async handlePetRanking(requesterName: string, kind: '战斗力' | '最高伤害'): Promise<string> {
    const players = await this.prisma.player.findMany();
    const nameByOwner = new Map<string, string>();
    for (const p of players) {
      const name = String(p.name || '冒险者');
      nameByOwner.set(String(p.userId), name);
      const qq = String((p as any).qq || '');
      if (qq) nameByOwner.set(qq, name);
    }

    const maps = await this.prisma.gameMap.findMany();
    const entries: Array<{ name: string; value: number }> = [];
    const seen = new Set<string>(); // 屏蔽复制品（原版 L9684 寻找文本去重）
    for (const map of maps) {
      for (const pet of asJsonValue<any[]>(map.summons, [])) {
        // 原版 L9681：属性.生命>0 才入榜
        if (Number(pet?.hp ?? pet?.当前生命 ?? 0) <= 0) continue;
        const petKey = String(pet?.qq ?? pet?.QQ ?? '');
        if (!petKey || seen.has(petKey)) continue;
        seen.add(petKey);
        const markers = asJsonValue<Record<string, number>>(pet?.markers ?? pet?.标记 ?? {}, {});
        const value = this.combatState.getAchievementProficiency(markers, kind);
        // 原版 L9704：宠物最高伤害为 0 不入榜
        if (kind === '最高伤害' && value === 0) continue;
        const ownerName =
          nameByOwner.get(String(pet?.ownerId ?? pet?.归属 ?? pet?.ownerQQ ?? '')) || '未知';
        entries.push({ name: `${String(pet?.name ?? pet?.名称 ?? '使魔')}(${ownerName})`, value });
      }
    }
    return this.formatRankingText(
      requesterName,
      kind === '战斗力' ? '宠物曾经达到的最高战斗力排行' : '宠物曾经达到的最高伤害排行',
      entries,
    );
  }

  /** 秒数 → 时间文本（对应原版 数字到时间；在线时间可能跨天，补 天/小时 段） */

  async recordRankingStats(userId: number): Promise<void> {
    const now = Date.now();
    const last = this.lastCalcAtByUser.get(userId) || 0;
    this.lastCalcAtByUser.set(userId, now);
    let onlineDelta = 0;
    if (last > 0) {
      const diffSec = Math.floor((now - last) / 1000);
      onlineDelta = diffSec > 180 ? 180 : diffSec;
    }
    await this.support.mutatePlayer(userId, (ctx) => {
      const markers = asJsonValue<Record<string, number>>(ctx.player.markers, {});
      try {
        const calcBonus = this.combatSystem.buildAttackerBonus(ctx.player, ctx);
        const power = this.bonusService.calcCombatPower(calcBonus);
        const rounded = Math.round((Number(power) || 0) * 100) / 100;
        if (rounded > (Number(markers['战斗力']) || 0)) {
          markers['战斗力'] = rounded;
        }
      } catch {
        // 属性计算异常时跳过战斗力记录，在线时间照常累计
      }
      if (onlineDelta > 0) {
        // 原版 添加成就（累加语义）
        markers['在线时间'] = (Number(markers['在线时间']) || 0) + onlineDelta;
      }
      ctx.player.markers = markers;
    });
  }

  /**
   * 排行榜（排行 财富/载具）：独立命令入口，复用 使魔排行 的同名子榜实现。
   * 完整十子榜见 handleFamiliarRank（原版 _主程序.ecode L9562-9745）。
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

  async handleWealthRanking(requesterName: string): Promise<string> {
    const players = await this.prisma.player.findMany();
    const maps = await this.prisma.gameMap.findMany();
    const entries: Array<{ name: string; value: number }> = [];

    for (const p of players) {
      // 原版 L9638：老玩家(已选使魔)且等级>10 才入榜
      if (!this.isRankablePlayer(p)) continue;
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
              this.support.pushVehicleParts(items, v);
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
            this.support.pushVehicleParts(items, v);
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

  formatRankingText(
    requesterName: string,
    title: string,
    entries: Array<{ name: string; value: number }>,
    valueText?: (value: number) => string,
  ): string {
    const fmt = valueText ?? ((v: number) => formatDamageText(v));
    const sorted = [...entries].sort((a, b) => b.value - a.value).slice(0, 30);
    if (sorted.length === 0) {
      return `${requesterName}不是可以查看的排行榜`;
    }
    let text = `${requesterName}\n${title}`;
    sorted.forEach((entry, idx) => {
      text += `\n${idx + 1}、${entry.name}(${fmt(entry.value)})`;
    });
    return text;
  }


  /**
   * 处理大召唤术命令
   * 批量召唤使魔
   * 委托到 FamiliarSkillsService.executeSkill 执行大召唤术技能
   */

  async handleVehicleValueRanking(requesterName: string): Promise<string> {
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
        this.support.pushVehicleParts(parts, v);
        const value = await this.itemService.calculateValue(parts as any);
        entries.push({ name: `${String(v.name ?? v.名称 ?? '载具')}(${nameByOwner.get(owner)})`, value });
      }
    }

    return this.formatRankingText(requesterName, '最有价值的载具排行', entries);
  }

  /** 取制造成本：把载具零件展开为可估值的物品数组（原版 取制造成本） */

  /** 使魔排行十子榜（原版 _主程序.ecode L9565 菜单顺序） */
  private static readonly RANKING_SUB_TYPES = [
    '战斗力', '等级', '理论输出', '最高伤害', '击杀', '在线时间',
    '财富', '宠物战斗力', '宠物最高伤害', '载具',
  ] as const;

  /** 每用户上次指令时间（毫秒），用于在线时间累计（对应原版 玩家.读取时间/时间差） */
  private readonly lastCalcAtByUser = new Map<number, number>();
}
