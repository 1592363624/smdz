/**
 * JWT 策略
 * 从请求 Authorization: Bearer <token> 中解析用户身份。
 */

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { GlobalConfig } from '../../config/global.config';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: GlobalConfig.getInstance().jwtSecret,
    });
  }

  /**
   * JWT 校验通过后，返回挂载到 req.user 上的信息
   * 从数据库查询最新角色与状态，支持封禁即时生效。
   */
  async validate(payload: any) {
    // 从数据库查询用户最新状态(角色可能被管理员修改、账号可能被封禁)
    const user = await this.prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, username: true, nickname: true, role: true, status: true },
    });
    if (!user) {
      throw new UnauthorizedException('账号不存在');
    }
    if (user.status === 'BANNED') {
      throw new UnauthorizedException('账号已被封禁');
    }
    return { userId: user.id, username: user.username, nickname: user.nickname, role: user.role };
  }
}

