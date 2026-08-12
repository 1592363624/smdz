/**
 * 用户控制器
 * 暴露用户相关的 HTTP API（注册、绑定QQ、查看个人信息），并生成 OpenAPI 文档。
 */

import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BindQQDto } from './dto/user.dto';
import { UsersService } from './users.service';

@ApiTags('用户')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * 绑定QQ号（需登录）
   */
  @Post('bind-qq')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '绑定QQ号到当前账号' })
  async bindQQ(@Req() req, @Body() dto: BindQQDto) {
    const user = await this.usersService.bindQQ(req.user.userId, dto.qqNumber);
    return { success: true, data: user };
  }

  /**
   * 查看个人信息（需登录）
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取当前登录用户信息' })
  async me(@Req() req) {
    const user = await this.usersService.findById(req.user.userId);
    return { success: true, data: user };
  }
}
