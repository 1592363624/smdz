/** 保护需登录接口的 JWT 鉴权守卫（passport 策略名 jwt）。 */

import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
