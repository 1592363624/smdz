/**
 * 认证控制器
 * 暴露注册、登录接口，并生成 OpenAPI 文档。
 */

import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { LoginDto, RegisterDto } from '../users/dto/user.dto';
import { AuthService } from './auth.service';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * 用户注册
   */
  @Post('register')
  @ApiOperation({ summary: '用户注册' })
  async register(@Body() dto: RegisterDto) {
    const user = await this.authService.register(dto.username, dto.password, dto.nickname);
    return { success: true, data: user };
  }

  /**
   * 用户登录，返回 JWT 访问令牌
   */
  @Post('login')
  @ApiOperation({ summary: '用户登录，返回JWT令牌' })
  async login(@Body() dto: LoginDto) {
    const data = await this.authService.login(dto.username, dto.password);
    return { success: true, data };
  }
}
