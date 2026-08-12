/**
 * QQ OAuth2 认证服务
 * 处理 QQ 互联 OAuth2 登录流程：
 * 1. 生成授权 URL，跳转 QQ 登录页
 * 2. 接收回调，用 code 换取 access_token
 * 3. 获取用户 openid 和 QQ 昵称/头像
 * 4. 创建或绑定本地账号，签发 JWT
 *
 * 配置项（通过 .env 或系统配置）：
 * - QQ_APP_ID: QQ 互联应用 ID
 * - QQ_APP_KEY: QQ 互联应用密钥
 * - QQ_CALLBACK_URL: 授权回调地址（需与 QQ 互联后台配置一致）
 */

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { GlobalConfig } from '../../config/global.config';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../users/users.service';

/** QQ OAuth 配置 */
export interface QQOAuthConfig {
  appId: string;
  appKey: string;
  callbackUrl: string;
}

@Injectable()
export class QQAuthService {
  private readonly logger = new Logger(QQAuthService.name);
  /** QQ 开放 API 端点 */
  private readonly QQ_API = {
    authorize: 'https://graph.qq.com/oauth2.0/authorize',
    token: 'https://graph.qq.com/oauth2.0/token',
    me: 'https://graph.qq.com/oauth2.0/me',
    userInfo: 'https://graph.qq.com/user/get_user_info',
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * 获取 QQ OAuth 配置
   * 优先读取系统配置中心，否则回退到 .env 环境变量
   */
  private async getConfig(): Promise<QQOAuthConfig> {
    const cfg = GlobalConfig.getInstance();
    return {
      appId: process.env.QQ_APP_ID || '',
      appKey: process.env.QQ_APP_KEY || '',
      callbackUrl: process.env.QQ_CALLBACK_URL || 'http://localhost:3333/api/auth/qq/callback',
    };
  }

  /**
   * 检查 QQ 登录是否已配置
   */
  async isConfigured(): Promise<boolean> {
    const config = await this.getConfig();
    return !!(config.appId && config.appKey);
  }

  /**
   * 生成 QQ 登录授权 URL
   * 用户跳转到此 URL 进行 QQ 授权
   */
  async getAuthorizationUrl(): Promise<string> {
    const config = await this.getConfig();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.appId,
      redirect_uri: config.callbackUrl,
      state: Math.random().toString(36).slice(2, 10), // 简单防 CSRF
      scope: 'get_user_info',
    });
    return `${this.QQ_API.authorize}?${params.toString()}`;
  }

  /**
   * 处理 QQ OAuth 回调
   * 1. 用 code 换取 access_token
   * 2. 获取 openid
   * 3. 获取用户信息（昵称、头像）
   * 4. 创建或绑定用户，签发 JWT
   *
   * @param code QQ 授权回调返回的 code
   * @returns JWT 和用户信息
   */
  async handleCallback(code: string): Promise<{ access_token: string; user: any }> {
    const config = await this.getConfig();

    // 第一步：用 code 换取 access_token
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.appId,
      client_secret: config.appKey,
      code,
      redirect_uri: config.callbackUrl,
      fmt: 'json', // 要求返回 JSON 格式
    });

    let tokenResponse: any;
    try {
      const res = await fetch(`${this.QQ_API.token}?${tokenParams.toString()}`);
      tokenResponse = await res.json();
    } catch (err) {
      this.logger.error('获取 QQ access_token 失败', err);
      throw new UnauthorizedException('QQ 登录授权失败，无法获取 access_token');
    }

    if (!tokenResponse.access_token) {
      this.logger.error(`QQ 返回的 access_token 无效: ${JSON.stringify(tokenResponse)}`);
      throw new UnauthorizedException('QQ 登录授权失败，access_token 无效');
    }

    const accessToken = tokenResponse.access_token;

    // 第二步：获取 openid
    let openid: string;
    try {
      const meRes = await fetch(`${this.QQ_API.me}?access_token=${accessToken}&fmt=json`);
      const meData = await meRes.json();
      openid = meData.openid;
    } catch (err) {
      this.logger.error('获取 QQ openid 失败', err);
      throw new UnauthorizedException('QQ 登录授权失败，无法获取用户标识');
    }

    if (!openid) {
      throw new UnauthorizedException('QQ 登录授权失败，openid 无效');
    }

    // 第三步：获取用户信息（昵称、头像）
    let qqNickname = '';
    let qqAvatar = '';
    try {
      const userInfoRes = await fetch(
        `${this.QQ_API.userInfo}?access_token=${accessToken}&oauth_consumer_key=${config.appId}&openid=${openid}`,
      );
      const userInfo = await userInfoRes.json();
      if (userInfo.ret === 0) {
        qqNickname = userInfo.nickname || '';
        qqAvatar = userInfo.figureurl_qq_2 || userInfo.figureurl_qq_1 || '';
      }
    } catch (err) {
      this.logger.warn('获取 QQ 用户信息失败', err);
      // 即使获取用户信息失败，也不阻断登录流程
    }

    // 第四步：查找或创建用户
    // 使用 qqNumber 作为唯一标识（openid 作为 qqNumber 存储）
    let user = await this.prisma.user.findUnique({ where: { qqNumber: openid } });

    if (!user) {
      // 创建新用户（使用 QQ openid 作为用户名和 qqNumber）
      const safeUsername = `qq_${openid.slice(0, 8)}`;
      const randomPassword = Math.random().toString(36).slice(2, 18);
      user = await this.prisma.user.create({
        data: {
          username: safeUsername,
          password: randomPassword, // 随机密码，用户只能通过 QQ 登录
          nickname: qqNickname || `QQ用户${openid.slice(0, 6)}`,
          qqNumber: openid,
          avatar: qqAvatar,
        },
      });

      // 创建玩家档案
      await this.usersService.ensurePlayer(user.id);

      this.logger.log(`QQ 用户 ${openid} 已创建本地账号，ID=${user.id}`);
    } else {
      // 更新用户信息（昵称、头像可能已变更）
      const updateData: any = {};
      if (qqNickname) updateData.nickname = qqNickname;
      if (qqAvatar) updateData.avatar = qqAvatar;
      if (Object.keys(updateData).length > 0) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: updateData,
        });
      }
    }

    // 签发 JWT
    const token = this.jwtService.sign({
      userId: user.id,
      username: user.username,
    });

    return {
      access_token: token,
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        role: user.role,
        avatar: user.avatar,
        qqNumber: user.qqNumber,
      },
    };
  }
}