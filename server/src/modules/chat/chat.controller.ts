/**
 * 聊天控制器
 * 提供公屏历史消息查询、频道信息、可@玩家列表，以及世界红包相关 API。
 *
 * 说明：游戏内「私聊」功能已下线（原 private/* 接口随功能一并移除）。
 */

import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChatService } from './chat.service';
import { RedPacketItemInput, RedPacketService } from './red-packet.service';

@ApiTags('公屏聊天')
@Controller('chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly redPacketService: RedPacketService,
  ) {}

  /**
   * 获取频道历史消息（页面刷新时加载）
   * 需登录：以便识别查看者身份，对「私密消息」（如探测雷达结果）做脱敏——
   * 非本人发送的私密消息只返回占位文本，防止他人刷新页面后白嫖。
   */
  @Get('messages')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '获取频道历史消息',
    description:
      '需登录。对「私密消息」(visibility=private，如探测雷达) 做脱敏：' +
      '非本人发送的私密消息 content 返回占位文本，真实内容仅发送者本人可见。' +
      'type=redpacket 的消息带 refId（红包ID），前端据此渲染可领取的红包卡片。',
  })
  @ApiQuery({ name: 'channelId', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getMessages(@Req() req, @Query('channelId') channelId?: string, @Query('limit') limit?: string) {
    const channel = await this.chatService.ensureDefaultChannel();
    const cid = Number(channelId) || channel.id;
    const lmt = Math.min(Number(limit) || 50, 200);
    const data = await this.chatService.getMessages(cid, lmt, req.user?.userId);
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

  /// ===== 世界红包 =====

  /**
   * 发红包可选道具清单：读取当前玩家背包，过滤出可放入红包的道具
   * （默认排除装备类与硬通货，规则见系统配置 chat.redPacket）
   */
  @Get('redpacket/items')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '发红包可选道具清单（读当前玩家背包）',
    description: '返回 [{ name, type, quantity }]，仅含数量>0 且允许放入红包的道具（排除装备/硬通货）。',
  })
  async getRedPacketItems(@Req() req) {
    const data = await this.redPacketService.listSendableItems(req.user.userId);
    return { success: true, data };
  }

  /**
   * 查询红包状态：不传 ids 时返回时间窗内最近的红包（用于进频道时对齐卡片状态），
   * 传 ids 时按ID批量查询（历史消息里的红包卡片补状态）
   */
  @Get('redpackets')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '查询红包状态列表（可按ID批量）' })
  @ApiQuery({ name: 'ids', required: false, description: '红包ID，逗号分隔', type: String })
  async listRedPackets(@Req() req, @Query('ids') ids?: string) {
    const idList = String(ids || '')
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v > 0);
    const data = await this.redPacketService.listPackets(req.user.userId, idList);
    return { success: true, data };
  }

  /**
   * 发红包：发送时立即从背包扣除所选道具，并把红包广播到世界频道
   */
  @Post('redpacket')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '发送世界红包（扣除背包道具并广播）',
    description: 'body: { greeting?: string, items: [{ name, quantity }] }，成功后返回红包视图与公屏消息。',
  })
  async createRedPacket(@Req() req, @Body() body: { greeting?: string; items?: RedPacketItemInput[] }) {
    const data = await this.redPacketService.createPacket(req.user.userId, body || {});
    return { success: true, data };
  }

  /**
   * 领取红包：先到先得，每人每个红包限领 1 份，领到的道具直接进背包
   */
  @Post('redpacket/:id/claim')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '领取世界红包（先到先得，每人限领1次）' })
  @ApiParam({ name: 'id', required: true, description: '红包ID', type: Number })
  async claimRedPacket(@Req() req, @Param('id', ParseIntPipe) id: number) {
    const data = await this.redPacketService.claimPacket(req.user.userId, id);
    return { success: true, data };
  }
}
