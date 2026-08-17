/**
 * QQ OAuth 认证控制器
 * 提供 QQ 登录入口和回调处理接口，并生成 OpenAPI 文档。
 *
 * 路由：
 * - GET /auth/qq/login   → 跳转 QQ 授权页
 * - GET /auth/qq/callback → QQ 授权回调，完成后重定向到前端
 * - GET /auth/qq/status   → 检查 QQ 登录是否已配置
 */

import { Controller, Get, HttpStatus, Logger, Query, Redirect, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { QQAuthService } from './qq-auth.service';

@ApiTags('QQ 登录')
@Controller('auth/qq')
export class QQAuthController {
  private readonly logger = new Logger(QQAuthController.name);

  constructor(private readonly qqAuthService: QQAuthService) {}

  /**
   * 检查 QQ 登录是否已配置（前端用来决定是否显示 QQ 登录按钮）
   */
  @Get('status')
  @ApiOperation({ summary: '检查 QQ 登录是否已配置' })
  async checkStatus() {
    const configured = await this.qqAuthService.isConfigured();
    return { success: true, data: { configured } };
  }

  /**
   * QQ 登录入口：跳转到 QQ 授权页面
   */
  @Get('login')
  @ApiOperation({ summary: '跳转到 QQ 授权页面' })
  @Redirect()
  async qqLogin() {
    const url = await this.qqAuthService.getAuthorizationUrl();
    return { url, statusCode: HttpStatus.FOUND };
  }

  /**
   * QQ 授权回调地址
   * 处理 QQ 返回的授权码，完成登录或注册，然后重定向到前端聊天页
   */
  @Get('callback')
  @ApiOperation({ summary: 'QQ 授权回调处理' })
  async qqCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    if (!code) {
      return res.redirect('/login?error=qq_auth_failed');
    }

    try {
      const result = await this.qqAuthService.handleCallback(code);

      // 将 token 和用户信息作为 URL 参数传递到前端
      // 前端登录页会解析这些参数并完成登录
      // qq_new=1 表示本次为首次注册，前端引导用户设置游戏昵称后再进入
      const userData = encodeURIComponent(JSON.stringify(result.user));
      const redirectUrl = `/login?qq_token=${result.access_token}&qq_user=${userData}&qq_new=${result.isNewUser ? '1' : '0'}`;
      return res.redirect(redirectUrl);
    } catch (err: any) {
      this.logger.error(`QQ 登录回调处理失败: ${err.message}`);
      return res.redirect('/login?error=qq_auth_failed');
    }
  }
}