/**
 * 帮助指令处理器
 * 展示清晰的玩法指引 + 常用指令分组，帮助新手快速上手。
 * 对应原版：帮助 / 全部指令 命令。
 * 设计要点：
 * - 不把几百条指令全部平铺（管理/内部指令太多会让人眼花），而是按"新手该做什么"分组呈现。
 * - 每个分组只展示最常用的核心指令，配合使用说明。
 * - 如需完整指令列表，可引导查看「使魔大战」主菜单。
 */

import { Inject } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/**
 * 帮助指令处理器
 * 展示新手起步指引 + 常用指令分组（按功能模块）。
 */
export class HelpHandler implements CommandHandler {
  key = 'help';
  module = 'basic';

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    // 从数据库读取指令，仅用于校验哪些指令真实存在，避免引导玩家点不存在的指令
    const all = await this.prisma.command.findMany({
      where: { enabled: true, minRole: 'USER' },
      select: { name: true },
    });
    const exist = new Set(all.map((c) => c.name));

    const lines: string[] = [];
    lines.push(`🎮 使魔大战 - 新手引导`);
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`【快速上手】`);
    lines.push(`  1. 发送「信息」查看自己的角色属性`);
    lines.push(`  2. 发送「观察附近」查看当前地图的怪物、资源、NPC`);
    lines.push(`  3. 发送「攻击」攻击当前地图的怪物，获取经验和掉落`);
    lines.push(`  4. 发送「背包」查看背包物品，发送「装备 物品名」穿戴装备`);
    lines.push(`  5. 发送「移动 地图名」前往其他地图（如「移动 走廊」）`);
    lines.push(`  6. 发送「使魔大战」打开游戏主菜单`);
    lines.push(``);
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`【常用指令】`);
    lines.push(``);

    // 按功能分组展示，仅列出确定存在的指令
    const groups: { title: string; cmds: string[] }[] = [
      { title: '🎒 背包与装备', cmds: ['背包', '使用', '装备', '卸下', '资源背包', '背包搜索', '装备强化', '装备预设', '丢弃'] },
      { title: '⚔️ 战斗', cmds: ['攻击', '技能', '扫荡', '闪避', '切换武器', '捕捉', '使魔挑战'] },
      { title: '🗺️ 地图与探索', cmds: ['移动', '飞到', '传送', '地图', '观察附近', '探测', '探测雷达', '拾取', '开采'] },
      { title: '👹 使魔', cmds: ['召唤使魔', '使魔数据', '选择使魔', '命名使魔', '使魔技能', '复活使魔', '使魔排行', '使魔称号'] },
      { title: '🏠 家园', cmds: ['使魔家园', '圈地', '建造', '种植', '收获', '家园操作'] },
      { title: '📜 任务', cmds: ['查看任务', '领取任务', '提交任务', '放弃任务'] },
      { title: '🏪 商店与制造', cmds: ['使魔商店', '活跃度商店', '钻石商店', '数据商店', '制造', '配方', '逆向', '分解'] },
      { title: '🔧 载具', cmds: ['载具模拟', '制造', '维修', '召唤货舱'] },
      { title: '⚙️ 其他', cmds: ['设置', '图鉴', '游戏解释', '更新历史', '兑换'] },
    ];

    for (const g of groups) {
      // 只保留确实存在的指令
      const valid = g.cmds.filter((c) => exist.has(c));
      if (valid.length > 0) {
        lines.push(`【${g.title}】`);
        lines.push(`  ${valid.join('、')}`);
        lines.push('');
      }
    }

    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`💡 提示：发送「使魔大战」打开主菜单，或发送「游戏解释 词条」查看术语说明。`);
    lines.push(`   采集资源：在「观察附近」中看到资源后，发送编号数字或采集指令即可采集。`);

    return {
      success: true,
      content: lines.join('\n'),
      broadcast: false,
      durationMs: 0,
    };
  }
}
