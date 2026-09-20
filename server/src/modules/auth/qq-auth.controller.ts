/** QQ OAuth 认证控制器：QQ 登录入口、授权回调、配置状态检查。 */

import { Controller, Get, HttpStatus, Logger, Query, Redirect, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { QQAuthService } from './qq-auth.service';

@ApiTags('QQ 登录')
@Controller('auth/qq')
export class QQAuthController {
  private readonly logger = new Logger(QQAuthController.name);

  constructor(private readonly qqAuthService: QQAuthService) {}

  /** 前端据此决定是否显示 QQ 登录按钮。 */
  @Get('status')
  @ApiOperation({ summary: '检查 QQ 登录是否已配置' })
  async checkStatus() {
    const configured = await this.qqAuthService.isConfigured();
    return { success: true, data: { configured } };
  }

  @Get('login')
  @ApiOperation({ summary: '跳转到 QQ 授权页面' })
  @Redirect()
  async qqLogin() {
    const url = await this.qqAuthService.getAuthorizationUrl();
    return { url, statusCode: HttpStatus.FOUND };
  }

  /** 处理 QQ 返回的授权码，完成登录或注册后重定向到前端。 */
  @Get('callback')
  @ApiOperation({ summary: 'QQ 授权回调处理' })
  async qqCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    if (!code) {
      return res.redirect('/login?error=qq_auth_failed');
    }

    try {
      const result = await this.qqAuthService.handleCallback(code);

      // token 与用户信息经 URL 参数传给前端登录页解析；
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