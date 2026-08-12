/**
 * 角色装饰器
 * 标记接口所需的最低角色权限。
 * 用法：@Roles('ADMIN') 或 @Roles('SUPER_ADMIN')
 */
import { SetMetadata } from '@nestjs/common';

/** 注入 key：读取接口所需的角色 */
export const ROLES_KEY = 'roles';

/** 允许的角色（字符串数组） */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
