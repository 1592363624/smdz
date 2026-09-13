/**
 * 成就/称号系统服务
 * 对应原版：数据分析.ecode 中的成就相关子程序
 * 负责成就的添加、查询、触发称号等
 * 成就数据存储在 Player.markers 字段（JSON 字符串，格式 {"成就名": 数值}）
 * 称号数据存储在 Player.titles 字段（JSON 数组，格式 [{name, equipped}]，
 * 字符串条目为历史形状，读取时自动归一为对象）
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';
import { StaticDataService } from './static-data.service';
import { GameHighlightService } from './highlight.service';
import { asJsonValue } from '../../common/utils/json-value.util';

@Injectable()
export class AchievementService {
  private readonly logger = new Logger(AchievementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly staticData: StaticDataService,
    /**
     * 高光时刻推送（可选依赖）。存量测试桩手工 new AchievementService 时不会传入，
     * 拿不到则跳过推送，称号判定与发放逻辑完全不变。
     */
    @Optional() private readonly highlight?: GameHighlightService,
  ) {}

  /**
   * 添加成就熟练度
   * 对应原版：添加成就(名称, 数值, 成就数组, 任务数组)
   * 给指定成就增加数值，负数则减少；数值<=0时删除该成就
   * @param player 玩家对象（含 Prisma 数据，会修改并保存）
   * @param name 成就名称
   * @param value 要增加的数值（负数则减少）
   * @param checkTitle 是否检查称号触发，默认true
   */
  async addAchievement(player: any, name: string, value: number, checkTitle = true): Promise<void> {
    // 增量重放式保存：本方法只改 markers（计数器语义），与调用方的其它字段
    // 无耦合。若快照过期（并发写入了 hp/backpack 等无关字段），把同一增量
    // 重放到最新状态上重试，而不是让整条业务链报错。
    const apply = async (attempt: number): Promise<void> => {
      if (attempt > 2) {
        throw new Error('玩家数据并发冲突，请重试');
      }
      // 1. 解析 player.markers 为对象（兼容字符串或已为对象的场景，避免连续调用时对象/字符串混用丢失成就）
      const markers = typeof player.markers === 'object' && player.markers !== null
        ? { ...player.markers }
        : asJsonValue<Record<string, number>>(player.markers, {});

      // 2. 如果成就名存在，累加数值；如果数值<=0，删除成就
      if (markers[name] !== undefined) {
        markers[name] = (markers[name] || 0) + value;
        if (markers[name] <= 0) {
          delete markers[name];
        }
      } else {
        // 3. 如果成就名不存在，添加新成就
        // 原版“添加成就”声明为“不保存负数”：不存在的成就收到负数/0时直接忽略，
        // 只有正数才创建初始记录。
        if (value <= 0) return;
        markers[name] = value;
      }

      // 4. 更新 markers 字段到 player 对象
      player.markers = markers;

      // 5. 如果 checkTitle，调用 checkTitles
      if (checkTitle) {
        await this.checkTitles(player);
      }

      // 6. 保存玩家；快照过期则重读最新行、同步到本快照后重放同一增量
      try {
        await this.playerService.savePlayer(player);
      } catch (error: any) {
        if (error?.message?.includes('并发冲突') && player.userId) {
          const latest = await this.prisma.player.findUnique({ where: { userId: player.userId } });
          if (latest) {
            for (const key of Object.keys(latest)) {
              if (key !== 'version') (player as any)[key] = (latest as any)[key];
            }
            player.version = latest.version;
            return apply(attempt + 1);
          }
        }
        throw error;
      }
    };

    await apply(1);
  }

  /**
   * 获取成就熟练度
   * 对应原版：取成就熟练度(成就数组, 名称)
   * @param markers 玩家标记对象或JSON字符串
   * @param name 成就名称
   * @returns 成就数值，不存在返回0
   */
  getAchievement(markers: any, name: string): number {
    const parsed = typeof markers === 'string'
      ? asJsonValue<Record<string, number>>(markers, {})
      : (markers || {});
    return parsed[name] || 0;
  }

  /**
   * 设置成就熟练度（直接设置，不检查称号）
   * 对应原版：置成就熟练度(名称, 成就数组, 熟练度)
   * 用于在批量操作中直接修改 markers 对象，需调用方自行保存
   * @param markers 玩家标记对象（会被直接修改）
   * @param name 成就名称
   * @param value 要设置的数值（<=0 时删除该成就）
   */
  setAchievement(markers: Record<string, number>, name: string, value: number): void {
    if (value <= 0) {
      delete markers[name];
    } else {
      markers[name] = value;
    }
  }

  /**
   * 检查称号触发（已停用自动发放）
   * 对齐原版：称号只能通过「领取称号」手动领取（原版 _主程序.ecode L10577-10620，
   * 条件满足时同时发放资源奖励）。自动发放会导致玩家跳过领取环节、错失奖励，
   * 因此本方法仅保留签名兼容（addAchievement / item-system 的既有调用点），恒返回空数组。
   * @param player 玩家对象（不再修改）
   * @returns 恒为空数组
   */
  async checkTitles(player: any): Promise<string[]> {
    void player;
    return [];
  }

  /**
   * 获取玩家所有成就列表（格式化文本）
   * @param player 玩家对象
   * @returns 格式化后的成就列表文本
   */
  getAchievementsDisplay(player: any): string {
    const markers = asJsonValue<Record<string, number>>(player.markers, {});
    const lines: string[] = ['🏆 成就列表'];

    // 过滤掉内部标记（以下划线开头或"指引"等系统标记）
    const entries = Object.entries(markers).filter(
      ([key]) => !key.startsWith('_') && key !== '指引' && !key.startsWith('dungeon_'),
    );
    if (entries.length === 0) {
      lines.push('  (暂无成就)');
    } else {
      for (const [name, value] of entries) {
        lines.push(`  ${name}: ${value}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 获取玩家所有称号列表（格式化文本）
   * @param player 玩家对象
   * @returns 格式化后的称号列表文本
   */
  getTitlesDisplay(player: any): string {
    const rawTitles = asJsonValue<any[]>(player.titles, []);
    const titles = Array.isArray(rawTitles)
      ? rawTitles.filter((t: any) => t)
        .map((t: any) => (typeof t === 'string' ? t : t.name))
      : [];
    const lines: string[] = ['🎖️ 称号列表'];

    if (titles.length === 0) {
      lines.push('  (暂无称号)');
    } else {
      for (const title of titles) {
        lines.push(`  ${title}`);
      }
    }

    return lines.join('\n');
  }
}
