/**
 * 认证模块
 * 提供 JWT 签发、登录、注册，以及全局 JWT 鉴权守卫。
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { GlobalConfig } from '../../config/global.config';
import { UsersModule } from '../users/users.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { QQAuthService } from './qq-auth.service';
import { QQAuthController } from './qq-auth.controller';
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
  providers: [AuthService, QQAuthService, JwtStrategy, JwtAuthGuard],
  controllers: [AuthController, QQAuthController],
  exports: [JwtAuthGuard, QQAuthService],
})
export class AuthModule {}
