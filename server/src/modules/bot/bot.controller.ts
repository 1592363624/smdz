/**
 * AstrBot 对接控制器
 * 提供机器人调用指令的 HTTP 入口。
 *
 * AstrBot 插件侧调用：
 *   POST {服务地址}/api/bot/command
 *   Header:  x-bot-token: <配置的访问令牌>
 *   Body:    { "botIdentity": "QQ号", "message": "指令内容" }
 *   返回:    { "success": true, "data": { "content": "指令结果文本", ... } }
 */

import { Body, Controller, Headers, HttpException, HttpStatus, Post } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GlobalConfig } from '../../config/global.config';
import { BotService } from './bot.service';

@ApiTags('AstrBot机器人对接')
@Controller('bot')
export class BotController {
  constructor(private readonly botService: BotService) {}

  /**
   * 机器人指令入口
   * 供 AstrBot 插件通过 HTTP 调用，触发网页指令引擎，返回结果。
   */
  @Post('command')
  @ApiOperation({ summary: '机器人发送指令(供AstrBot调用)' })
  @ApiHeader({
    name: 'x-bot-token',
    description: '机器人访问令牌(与BOT_ACCESS_TOKEN一致)',
    required: true,
  })
  async command(
    @Headers('x-bot-token') token: string,
    @Body() body: { botIdentity: string; message: string; channelName?: string },
  ) {
    // 校验访问令牌，防止未授权调用
    if (token !== GlobalConfig.getInstance().botAccessToken) {
      throw new HttpException('访问令牌无效', HttpStatus.UNAUTHORIZED);
    }
    if (!body?.message) {
      throw new HttpException('缺少指令内容 message', HttpStatus.BAD_REQUEST);
    }
    const result = await this.botService.handleBotCommand({
      botIdentity: body.botIdentity || 'unknown',
      message: body.message,
      channelName: body.channelName,
    });
    return { success: true, data: result };
  }
}
