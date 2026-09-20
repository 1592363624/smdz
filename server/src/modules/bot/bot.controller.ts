/**
 * AstrBot 对接控制器：机器人调用指令的 HTTP 入口。
 * AstrBot 插件侧调用 POST {服务地址}/api/bot/command，
 * Header x-bot-token: <配置的访问令牌>，
 * Body { "botIdentity": "QQ号", "message": "指令内容" }，
 * 返回 { "success": true, "data": { "content": "指令结果文本", ... } }。
 */

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { GlobalConfig } from '../../config/global.config';
import { BotService } from './bot.service';
import { UsersService } from '../users/users.service';

@ApiTags('AstrBot机器人对接')
@Controller('bot')
export class BotController {
  constructor(
    private readonly botService: BotService,
    private readonly usersService: UsersService,
  ) {}

  @Post('command')
  @HttpCode(HttpStatus.OK) // 成功执行指令返回 200，而非 NestJS 默认的 201，便于机器人插件识别
  @ApiOperation({ summary: '机器人发送指令(供AstrBot调用)' })
  @ApiHeader({
    name: 'x-bot-token',
    description: '机器人访问令牌(与BOT_ACCESS_TOKEN一致)',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description:
      '指令执行结果。data.visibility="private" 表示私密结果（如探测雷达），' +
      '插件应仅将 data.content 私聊回传给发起者，群内展示 data.placeholder 占位文本',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: {
          type: 'object',
          properties: {
            success: { type: 'boolean', description: '指令是否执行成功' },
            content: { type: 'string', description: '指令结果文本（私密结果即为真实内容）' },
            broadcast: { type: 'boolean', description: '是否对所有人公屏可见' },
            visibility: {
              type: 'string',
              enum: ['public', 'private'],
              description: '可见范围：public=公开；private=仅发起者可见',
            },
            placeholder: {
              type: 'string',
              description: '私密结果对其他玩家展示的占位文本（visibility=private 时返回）',
            },
            durationMs: { type: 'number', description: '执行耗时(ms)' },
          },
        },
      },
    },
  })
  async command(
    @Headers('x-bot-token') token: string,
    @Body() body: { botIdentity: string; message: string; channelName?: string },
  ) {
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

  /**
   * 用户在 QQ 群中发送"使魔大战绑定QQ <OpenID>"，插件携带 OpenID 调用本接口完成绑定；
   * QQ 号取自 AstrBot 事件，避免网页端手动填写他人 QQ 号。
   */
  @Post('bind-qq')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '插件端通过 OpenID 绑定用户真实QQ号' })
  @ApiHeader({
    name: 'x-bot-token',
    description: '机器人访问令牌(与BOT_ACCESS_TOKEN一致)',
    required: true,
  })
  async bindQQ(
    @Headers('x-bot-token') token: string,
    @Body() body: { externalId: string; qqNumber: string },
  ) {
    if (token !== GlobalConfig.getInstance().botAccessToken) {
      throw new HttpException('访问令牌无效', HttpStatus.UNAUTHORIZED);
    }
    const user = await this.usersService.bindQQByExternalId(body.externalId, body.qqNumber);
    return { success: true, data: user };
  }
}
