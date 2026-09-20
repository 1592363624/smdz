/** AstrBot 对接服务：机器人指令执行与玩家绑定查询。 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CommandService } from '../command/command.service';
import { CommandContext, CommandSource } from '../command/interfaces/command.interface';
import { ShortcutService } from '../game/shortcut.service';

/// AstrBot 传入指令的请求体结构
export interface BotCommandPayload {
  /** 机器人身份标识(如QQ号) */
  botIdentity: string;
  message: string;
  /** 可选：频道名(默认世界频道) */
  channelName?: string;
}

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commandService: CommandService,
    private readonly shortcutService: ShortcutService,
  ) {}

  /** 执行来自 AstrBot 的指令，返回结果文本供机器人回复。 */
  async handleBotCommand(payload: BotCommandPayload) {
    const { botIdentity, message } = payload;

    // 根据 QQ号 找到绑定的用户（优先），找不到则匿名执行
    const binding = await this.prisma.user.findFirst({
      where: { qqNumber: botIdentity },
      select: { id: true, username: true },
    });

    const channel = await this.prisma.channel.findFirst({ where: { name: '世界频道' } });

    this.logger.log(`[AstrBot] 收到指令: ${message} (来自 ${botIdentity})`);
    // 快捷输入预处理（快捷键/输入替换/临时输入替换，编号菜单"发数字触发指令"依赖此步）。
    // 与网页公屏入口(chat.gateway)保持一致：未绑定用户时无 userId，跳过直接分发。
    let finalMessage = message;
    if (binding?.id) {
      try {
        finalMessage = await this.shortcutService.processShortcut(message, binding.id);
      } catch (e: any) {
        this.logger.warn(`[AstrBot] 快捷输入预处理失败: ${e.message}`);
      }
    }
    const ctx: CommandContext = {
      userId: binding?.id,
      username: binding?.username || botIdentity,
      botIdentity,
      channelId: channel?.id || 1,
      channelName: channel?.name || '世界频道',
      rawMessage: finalMessage,
      source: CommandSource.ASTRBOT,
    };
    const result = await this.commandService.dispatch(ctx);
    // UI 同步说明：指令内部落库后由 Prisma 拦截器自动触发网页面板刷新，
    // 此处无需手动推送（与网页端 chat.gateway 行为一致）。
    return result;
  }
}
