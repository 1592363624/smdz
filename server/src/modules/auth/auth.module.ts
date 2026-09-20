/**
 * 认证模块：QQ 互联 OAuth2 登录（唯一登录入口，无用户名+密码自注册）+ 全局 JWT 鉴权守卫。
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { GlobalConfig } from '../../config/global.config';
import { UsersModule } from '../users/users.module';
import { QQAuthService } from './qq-auth.service';
import { QQAuthController } from './qq-auth.controller';
import { DevAuthController } from './dev-auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.registerAsync({
      useFactory: () => {
        const cfg = GlobalConfig.getInstance();
        return {
          secret: cfg.jwtSecret,
          signOptions: { expiresIn: cfg.jwtExpiresIn },
        };
      },
    }),
  ],
  providers: [QQAuthService, JwtStrategy, JwtAuthGuard],
  controllers: [QQAuthController, DevAuthController],
  exports: [JwtAuthGuard, QQAuthService],
})
export class AuthModule {}
