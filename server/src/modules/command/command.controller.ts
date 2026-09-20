/** 指令控制器：指令执行的 HTTP API（供外部/AstrBot 通过 REST 调用）。 */

import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CommandService } from './command.service';
import { ExecuteCommandDto } from './dto/execute-command.dto';
import { CommandContext, CommandSource } from './interfaces/command.interface';
import { ShortcutService } from '../game/shortcut.service';

@ApiTags('指令引擎')
@Controller('commands')
export class CommandController {
  constructor(
    private readonly commandService: CommandService,
    // 与 chat.gateway 同源：REST 路径同样做编号菜单的临时输入替换，
    // 否则网页/API 发「1」不会展开成「唤醒 载具ID」。
    private readonly shortcutService: ShortcutService,
  ) {}

  /** 与公屏聊天不同：这里是显式 REST 调用指令（需登录，来源记为 WEB）。 */
  @Post('execute')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '执行一条指令(登录用户)' })
  async execute(@Body() dto: ExecuteCommandDto, @Req() req) {
    // 先过快捷输入（临时编号 / 快捷键 / 输入替换），与 Socket 网关对齐
    const raw = await this.shortcutService.processShortcut(
      String(dto.command ?? ''),
      req.user.userId,
    );
    const ctx: CommandContext = {
      userId: req.user.userId,
      username: req.user.username,
      channelId: dto.channelId || 1,
      rawMessage: raw,
      source: CommandSource.WEB,
    };
    const result = await this.commandService.dispatch(ctx);
    return { success: true, data: result };
  }

  @Get('list')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取可用指令列表' })
  async list() {
    const data = await this.commandService.listCommands();
    return { success: true, data };
  }
}
