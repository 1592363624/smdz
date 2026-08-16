/**
 * 聊天控制器
 * 提供公屏历史消息查询、频道信息等 HTTP API。
 */

import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
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

  /**
   * 获取"可@提及"的玩家列表（前端聊天框 @ 下拉 / 消息右键 @ 使用）
   * 返回全部 ACTIVE 账号的简洁信息，并附加实时在线标记（在线优先排序）
   */
  @Get('players')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取可@提及的玩家列表（含在线状态）' })
  async getMentionablePlayers(@Req() req) {
    const data = await this.chatService.getMentionablePlayers(req.user.userId);
    return { success: true, data };
  }

  /**
   * 获取当前用户的私聊会话列表（含未读数与最后一条消息）
   */
  @Get('private/conversations')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取我的私聊会话列表' })
  async getPrivateConversations(@Req() req) {
    const data = await this.chatService.getPrivateConversations(req.user.userId);
    return { success: true, data };
  }

  /**
   * 获取与指定用户的私聊历史消息（按时间正序）
   */
  @Get('private/messages')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取与指定用户的私聊历史' })
  @ApiQuery({ name: 'withUserId', required: true, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getPrivateMessages(@Req() req, @Query('withUserId') withUserId: string, @Query('limit') limit?: string) {
    const data = await this.chatService.getPrivateMessages(req.user.userId, Number(withUserId), Number(limit) || 50);
    return { success: true, data };
  }

  /**
   * 标记与指定用户的私聊消息为已读
   */
  @Post('private/read')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '标记与指定用户的私聊为已读' })
  async markPrivateRead(@Req() req, @Body() body: { withUserId: number }) {
    const count = await this.chatService.markPrivateRead(req.user.userId, Number(body.withUserId));
    return { success: true, data: { updated: count } };
  }

  /**
   * 通过 HTTP 发送私聊消息（网页面板优先走 Socket；此接口供指令/机器人等场景复用）
   */
  @Post('private/send')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '发送私聊消息' })
  async sendPrivateMessage(@Req() req, @Body() body: { to: number; content: string }) {
    const msg = await this.chatService.sendPrivateMessage(req.user.userId, Number(body.to), String(body.content || ''));
    return { success: true, data: msg };
  }
}
