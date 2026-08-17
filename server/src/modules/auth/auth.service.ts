/**
 * 认证服务
 * 负责登录校验、注册、JWT 令牌签发。
 */

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * 用户注册
   */
  async register(username: string, password: string, nickname?: string) {
    const user = await this.usersService.createUser(username, password, nickname);
    // 同时创建玩家档案
    await this.usersService.ensurePlayer(user.id);
    return user;
  }

  /**
   * 用户登录：校验账号密码，成功则返回 JWT
   */
  async login(username: string, password: string) {
    const user = await this.usersService.findByUsername(username);
    if (!user) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    const valid = await this.usersService.validatePassword(user.password, password);
    if (!valid) {
      throw new UnauthorizedException('用户名或密码错误');
    }
    // 签发 JWT，payload 中携带 userId
    const token = this.jwtService.sign({ userId: user.id, username: user.username });
    return {
      access_token: token,
      user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role, avatar: user.avatar, qqNumber: user.qqNumber, externalId: user.externalId },
    };
  }
}
