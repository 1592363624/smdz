/**
 * 帮助指令处理器
 * 展示当前所有可用指令，按模块分组。
 */

import { Inject } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';

/** 基础指令列表（无数据库记录时兜底展示） */
const BASIC_COMMANDS = ['help', 'info', 'status'];
/** 游戏指令列表 */
const GAME_COMMANDS = ['attack', 'move', 'inventory', 'map', 'equip', 'unequip', 'use', 'skill'];

/**
 * 帮助指令处理器
 * 从数据库查询可用指令并按模块分组展示。
 */
export class HelpHandler implements CommandHandler {
  key = 'help';
  module = 'basic';

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async handle(ctx: CommandContext): Promise<CommandResult> {
    const commands = await this.prisma.command.findMany({
      where: { enabled: true },
      orderBy: { sortOrder: 'asc' },
      select: { name: true, alias: true, description: true, minRole: true, handlerKey: true },
    });

    // 按 handlerKey 将指令归入基础/游戏模块
    const basicCmds = commands.filter((c) => BASIC_COMMANDS.includes(c.handlerKey));
    const gameCmds = commands.filter((c) => GAME_COMMANDS.includes(c.handlerKey));
    // 未匹配到分组的归入其他
    const otherCmds = commands.filter(
      (c) => !BASIC_COMMANDS.includes(c.handlerKey) && !GAME_COMMANDS.includes(c.handlerKey),
    );

    const lines: string[] = ['📖 可用指令列表：\n'];

    if (basicCmds.length > 0) {
      lines.push('【基础指令】');
      for (const c of basicCmds) {
        lines.push(`  ${c.name}${c.alias ? `(${c.alias})` : ''}：${c.description || ''}`);
      }
      lines.push('');
    }

    if (gameCmds.length > 0) {
      lines.push('【游戏指令】');
      for (const c of gameCmds) {
        lines.push(`  ${c.name}${c.alias ? `(${c.alias})` : ''}：${c.description || ''}`);
      }
      lines.push('');
    }

    if (otherCmds.length > 0) {
      lines.push('【其他指令】');
      for (const c of otherCmds) {
        lines.push(`  ${c.name}${c.alias ? `(${c.alias})` : ''}：${c.description || ''}`);
      }
      lines.push('');
    }

    lines.push('在输入框输入指令即可执行，结果会显示在公屏。');

    return {
      success: true,
      content: lines.join('\n'),
      broadcast: false,
      durationMs: 0,
    };
  }
}