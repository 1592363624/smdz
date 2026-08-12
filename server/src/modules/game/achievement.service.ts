/**
 * 成就/称号系统服务
 * 对应原版：数据分析.ecode 中的成就相关子程序
 * 负责成就的添加、查询、触发称号等
 * 成就数据存储在 Player.markers 字段（JSON 字符串，格式 {"成就名": 数值}）
 * 称号数据存储在 Player.titles 字段（JSON 字符串数组，格式 ["称号1", "称号2"]）
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from './player.service';

@Injectable()
export class AchievementService {
  private readonly logger = new Logger(AchievementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
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
    // 1. 解析 player.markers 为对象
    const markers = this.playerService.safeJsonParse<Record<string, number>>(player.markers, {});

    // 2. 如果成就名存在，累加数值；如果数值<=0，删除成就
    if (markers[name] !== undefined) {
      markers[name] = (markers[name] || 0) + value;
      if (markers[name] <= 0) {
        delete markers[name];
      }
    } else {
      // 3. 如果成就名不存在，添加新成就
      markers[name] = value;
    }

    // 4. 更新 markers 字段到 player 对象
    player.markers = markers;

    // 5. 如果 checkTitle，调用 checkTitles
    if (checkTitle) {
      await this.checkTitles(player);
    }

    // 6. 保存玩家
    await this.playerService.savePlayer(player);
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
      ? this.playerService.safeJsonParse<Record<string, number>>(markers, {})
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
   * 检查称号触发
   * 根据玩家各种成就数据判断是否获得新称号
   * 称号数据从 GameTitle 表读取，每个称号的 requirements 字段为 JSON 条件数组
   * 支持的条件类型：achievement（成就数值）、level（等级）、affinity（好感度）
   * @param player 玩家对象（会修改并保存 titles）
   * @returns 新获得的称号名称列表
   */
  async checkTitles(player: any): Promise<string[]> {
    const newTitles: string[] = [];

    // 1. 解析玩家称号列表和标记
    const playerTitles: string[] = this.playerService.safeJsonParse<string[]>(player.titles, []);
    const markers = this.playerService.safeJsonParse<Record<string, number>>(player.markers, {});

    // 2. 从 GameTitle 表读取所有称号
    const allTitles = await this.prisma.gameTitle.findMany();

    // 3. 检查每个称号的触发条件
    for (const title of allTitles) {
      // 跳过已获得的称号
      if (playerTitles.includes(title.name)) continue;

      // 解析触发条件
      const requirements: Array<{ type?: string; name?: string; value?: number }> =
        this.playerService.safeJsonParse(title.requirements, []);
      if (requirements.length === 0) continue;

      // 检查所有条件是否满足
      let allMet = true;
      for (const req of requirements) {
        const type = req.type || 'achievement';
        const reqName = req.name || '';
        const reqValue = req.value || 0;

        if (type === 'achievement') {
          // 成就数值条件：检查 markers 中对应成就的数值
          const currentVal = markers[reqName] || 0;
          if (currentVal < reqValue) {
            allMet = false;
            break;
          }
        } else if (type === 'level') {
          // 等级条件
          if ((player.level || 0) < reqValue) {
            allMet = false;
            break;
          }
        } else if (type === 'affinity') {
          // 好感度条件
          if ((player.affinity || 0) < reqValue) {
            allMet = false;
            break;
          }
        }
      }

      // 4. 如果满足条件且玩家尚未获得，发放称号
      if (allMet) {
        playerTitles.push(title.name);
        newTitles.push(title.name);
        this.logger.log(`玩家 ${player.userId || player.id} 获得称号: ${title.name}`);
      }
    }

    // 更新玩家称号列表
    if (newTitles.length > 0) {
      player.titles = playerTitles;
    }

    // 5. 返回新获得的称号名称列表
    return newTitles;
  }

  /**
   * 获取玩家所有成就列表（格式化文本）
   * @param player 玩家对象
   * @returns 格式化后的成就列表文本
   */
  getAchievementsDisplay(player: any): string {
    const markers = this.playerService.safeJsonParse<Record<string, number>>(player.markers, {});
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
    const titles: string[] = this.playerService.safeJsonParse<string[]>(player.titles, []);
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