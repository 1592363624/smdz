/**
 * 角色权限守卫
 * 配合 @Roles() 装饰器使用，校验当前登录用户的角色是否满足接口要求。
 * 需与 JwtAuthGuard 搭配使用（先登录，再校验角色）。
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

/** 角色等级映射（用于比较权限大小） */
const ROLE_LEVEL: Record<string, number> = {
  USER: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // 读取接口上标注的角色要求
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // 未标注 @Roles 则放行
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }
    // 从请求中取用户(由 JwtAuthGuard 注入 req.user)
    const { user } = context.switchToHttp().getRequest();
    if (!user) {
      throw new ForbiddenException('未登录');
    }
    const userLevel = ROLE_LEVEL[user.role] || 0;
    const requiredLevel = Math.max(...requiredRoles.map((r) => ROLE_LEVEL[r] || 0));
    if (userLevel < requiredLevel) {
      throw new ForbiddenException('没有权限执行此操作');
    }
    return true;
  }
}
