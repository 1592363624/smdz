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
  async handleCallback(code: string): Promise<{ access_token: string; user: any; isNewUser: boolean }> {
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
    // 身份标识：优先用 externalId（新逻辑，QQ互联 openid 存于此字段）；
    // 若查不到，兼容存量用户（早期版本把 openid 直接写入了 qqNumber 字段）。
    // 存量用户保持 qqNumber=openid 不动，仅补录 externalId，便于后续换绑真实QQ号。
    // isNewUser 标记是否为本次首次注册（前端据此引导设置游戏昵称）。
    let isNewUser = false;
    let user = await this.prisma.user.findUnique({ where: { externalId: openid } });

    if (!user) {
      // 兼容存量：旧版本把 openid 存到了 qqNumber，查 qqNumber 找到则补录 externalId
      const legacyUser = await this.prisma.user.findUnique({ where: { qqNumber: openid } });
      if (legacyUser) {
        user = await this.prisma.user.update({
          where: { id: legacyUser.id },
          data: { externalId: openid },
        });
        this.logger.log(`存量 QQ 用户 ${openid} 已补录 externalId，ID=${user.id}`);
      }
    }

    if (!user) {
      // 创建新用户（新逻辑：openid 存 externalId，qqNumber 留空待玩家绑定真实QQ号）
      // username 使用完整 QQ 互联 OpenID（32位hex），保证全局唯一，避免只取前几位导致他人注册冲突。
      // 仍保留查重回退：极端情况下若已存在同 username，追加随机后缀兜底（理论上不会发生）。
      isNewUser = true;
      let safeUsername = `qq_${openid}`;
      while (await this.prisma.user.findUnique({ where: { username: safeUsername } })) {
        safeUsername = `qq_${openid}_${Math.random().toString(36).slice(2, 6)}`;
      }
      const randomPassword = Math.random().toString(36).slice(2, 18);
      user = await this.prisma.user.create({
        data: {
          username: safeUsername,
          password: randomPassword, // 随机密码，用户只能通过 QQ 登录
          nickname: qqNickname || `QQ用户${openid.slice(0, 6)}`,
          externalId: openid,
          avatar: qqAvatar,
        },
      });

      // 创建玩家档案
      await this.usersService.ensurePlayer(user.id);

      this.logger.log(`QQ 用户 ${openid} 已创建本地账号（externalId），ID=${user.id}`);
    } else {
      // 老用户：更新 QQ 昵称/头像（可能已变更）。
      // 注意：仅当用户未主动设置过游戏昵称时才回填 QQ 昵称，
      // 避免 QQ 昵称改动把用户自定义的游戏昵称覆盖掉。
      const updateData: any = {};
      if (qqNickname && !user.nickname) updateData.nickname = qqNickname;
      if (qqAvatar) updateData.avatar = qqAvatar;
      if (Object.keys(updateData).length > 0) {
        user = await this.prisma.user.update({
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
    };
  }
}