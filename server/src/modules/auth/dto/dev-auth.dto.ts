/**
 * 开发模拟登录 DTO
 * 仅用于本地开发环境跳过 QQ 互联授权流程，生产环境（未开启 DEV_LOGIN_ENABLED）不可用。
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/// 模拟登录请求体：按用户名查找或创建测试账号并直接签发 JWT
export class DevLoginDto {
  @ApiProperty({ description: '测试用户名（本地开发用）', example: 'tester' })
  @IsString()
  @Matches(/^[a-zA-Z0-9_\u4e00-\u9fa5]{1,20}$/, {
    message: '用户名仅支持1-20位中文、字母、数字或下划线',
  })
  username: string;
}
