/**
 * 聊天控制器
 * 提供公屏历史消息查询、频道信息等 HTTP API。
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ChatService } from './chat.service';

@ApiTags('公屏聊天')
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /**
   * 获取频道历史消息（页面刷新时加载）
   */
  @Get('messages')
  @ApiOperation({ summary: '获取频道历史消息' })
  @ApiQuery({ name: 'channelId', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getMessages(@Query('channelId') channelId?: string, @Query('limit') limit?: string) {
    const channel = await this.chatService.ensureDefaultChannel();
    const cid = Number(channelId) || channel.id;
    const lmt = Math.min(Number(limit) || 50, 200);
    const data = await this.chatService.getMessages(cid, lmt);
    return { success: true, data };
  }

  /**
   * 获取默认频道信息
   */
  @Get('channel')
  @ApiOperation({ summary: '获取默认频道信息' })
  async getChannel() {
    const data = await this.chatService.ensureDefaultChannel();
    return { success: true, data };
  }
}
