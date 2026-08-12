/**
 * 指令控制器
 * 暴露指令执行的 HTTP API（供外部/AstrBot 通过 REST 调用）。
 */

import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CommandService } from './command.service';
import { ExecuteCommandDto } from './dto/execute-command.dto';
import { CommandContext, CommandSource } from './interfaces/command.interface';

@ApiTags('指令引擎')
@Controller('commands')
export class CommandController {
  constructor(private readonly commandService: CommandService) {}

  /**
   * 执行指令（需登录，来自网页）
   * 与公屏聊天不同，这里是显式 REST 调用指令。
   */
  @Post('execute')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '执行一条指令(登录用户)' })
  async execute(@Body() dto: ExecuteCommandDto, @Req() req) {
    const ctx: CommandContext = {
      userId: req.user.userId,
      username: req.user.username,
      channelId: dto.channelId || 1,
      rawMessage: dto.command,
      source: CommandSource.WEB,
    };
    const result = await this.commandService.dispatch(ctx);
    return { success: true, data: result };
  }

  /**
   * 获取可用指令列表
   */
  @Get('list')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取可用指令列表' })
  async list() {
    const data = await this.commandService.listCommands();
    return { success: true, data };
  }
}
