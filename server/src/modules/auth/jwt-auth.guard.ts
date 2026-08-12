/**
 * JWT 鉴权守卫
 * 用于保护需要登录才能访问的接口。
 */

import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
