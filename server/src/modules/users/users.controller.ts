/**
 * 用户控制器：绑定 QQ、设置昵称、查看个人信息等 HTTP API。
 * 登录仅通过 QQ 互联完成，本控制器不提供自注册/自登录接口。
 */

import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiOkResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UpdateNicknameDto, SetFavoriteCommandsDto } from './dto/user.dto';
import { UsersService } from './users.service';

@ApiTags('用户')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /** QQ 互联首次注册后前端引导用户设置昵称，也可用于后续修改。 */
  @Post('nickname')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '设置游戏昵称' })
  async updateNickname(@Req() req, @Body() dto: UpdateNicknameDto) {
    const user = await this.usersService.updateNickname(req.user.userId, dto.nickname);
    return { success: true, data: user };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取当前登录用户信息' })
  async me(@Req() req) {
    const user = await this.usersService.findById(req.user.userId);
    return { success: true, data: user };
  }

  /** 前端指令面板把这份列表置顶展示。 */
  @Get('favorite-commands')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取我的常用指令' })
  @ApiOkResponse({ description: '返回常用指令字符串数组', type: [String] })
  async getFavoriteCommands(@Req() req) {
    const list = await this.usersService.getFavoriteCommands(req.user.userId);
    return { success: true, data: list };
  }

  /** 全量覆盖当前用户的常用指令列表。 */
  @Post('favorite-commands')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '设置我的常用指令' })
  async setFavoriteCommands(@Req() req, @Body() dto: SetFavoriteCommandsDto) {
    const list = await this.usersService.setFavoriteCommands(req.user.userId, dto.commands);
    return { success: true, data: list };
  }
}
