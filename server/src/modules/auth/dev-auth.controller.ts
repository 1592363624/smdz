/**
 * 开发环境模拟登录控制器
 * 用于本地开发时绕过 QQ 互联 OAuth 流程（QQ 互联回调地址必须与后台登记域名一致，
 * localhost 无法通过校验，本地收不到授权回调）。
 *
 * 安全约束：仅当环境变量 DEV_LOGIN_ENABLED=1 时启用；
 * 生产部署不配置该开关，接口一律返回 403，前端也不展示入口。
 *
 * 路由：
 * - GET  /auth/dev/status → 查询模拟登录是否启用（前端据此决定是否显示入口）
 * - POST /auth/dev/login  → 按用户名查找或创建测试账号，直接签发 JWT
 */

import { Body, Controller, ForbiddenException, Get, Logger, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { DevLoginDto } from './dto/dev-auth.dto';

@ApiTags('开发调试')
@Controller('auth/dev')
export class DevAuthController {
  private readonly logger = new Logger(DevAuthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  /** 是否启用模拟登录（需显式设置 DEV_LOGIN_ENABLED=1） */
  private isEnabled(): boolean {
    return process.env.DEV_LOGIN_ENABLED === '1';
  }

  /**
   * 查询模拟登录是否启用
   */
  @Get('status')
  @ApiOperation({ summary: '[仅开发] 查询模拟登录是否启用' })
  checkStatus() {
    return { success: true, data: { enabled: this.isEnabled() } };
  }

  /**
   * 模拟登录：按用户名查找或创建测试账号并签发 JWT
   * 返回结构与 QQ 回调签发的登录态一致，前端处理逻辑可复用。
   */
  @Post('login')
  @ApiOperation({ summary: '[仅开发] 模拟登录：按用户名直接签发 JWT' })
  async devLogin(@Body() dto: DevLoginDto) {
    if (!this.isEnabled()) {
      throw new ForbiddenException('模拟登录未启用（需在服务端设置 DEV_LOGIN_ENABLED=1）');
    }

    let isNewUser = false;
    let user = await this.prisma.user.findUnique({ where: { username: dto.username } });

    if (!user) {
      isNewUser = true;
      const randomPassword = Math.random().toString(36).slice(2, 18);
      user = await this.prisma.user.create({
        data: {
          username: dto.username,
          password: randomPassword,
          nickname: await this.usersService.uniquifyNickname(dto.username),
        },
      });
      await this.usersService.ensurePlayer(user.id);
      this.logger.log(`[DEV] 已创建测试账号 ${dto.username}，ID=${user.id}`);
    }

    // 与 QQ 登录一致：记录登录时间与次数（GM 后台用户管理展示用）
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), loginCount: { increment: 1 } },
    });

    const token = this.jwtService.sign({
      userId: user.id,
      username: user.username,
    });

    return {
      success: true,
      data: {
        access_token: token,
        isNewUser,
        user: {
          id: user.id,
          username: user.username,
          nickname: user.nickname,
          role: user.role,
          avatar: user.avatar,
          qqNumber: user.qqNumber,
          externalId: user.externalId,
        },
      },
    };
  }
}
