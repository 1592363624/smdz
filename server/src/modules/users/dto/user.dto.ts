/**
 * 用户模块 DTO（数据传输对象）
 * 定义接口入参，配合 class-validator 做校验，并生成 OpenAPI 文档。
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/// 绑定QQ号请求体
export class BindQQDto {
  @ApiProperty({ description: '要绑定的QQ号', example: '123456789' })
  @IsString()
  @Matches(/^\d{5,12}$/, { message: 'QQ号格式不正确' })
  qqNumber: string;
}

/// 设置游戏昵称请求体（QQ首次注册引导设置）
export class UpdateNicknameDto {
  @ApiProperty({ description: '游戏昵称', example: '冒险者小张' })
  @IsString()
  @MinLength(1, { message: '昵称不能为空' })
  @MaxLength(20, { message: '昵称最多20个字符' })
  nickname: string;
}

/// 注册请求体
export class RegisterDto {
  @ApiProperty({ description: '用户名', example: 'player1' })
  @IsString()
  @MinLength(3, { message: '用户名至少3个字符' })
  @MaxLength(20, { message: '用户名最多20个字符' })
  username: string;

  @ApiProperty({ description: '密码', example: '123456' })
  @IsString()
  @MinLength(6, { message: '密码至少6个字符' })
  password: string;

  @ApiProperty({ description: '昵称(可选)', required: false, example: '小明' })
  @IsString()
  @MaxLength(20)
  nickname?: string;
}

/// 登录请求体
export class LoginDto {
  @ApiProperty({ description: '用户名', example: 'player1' })
  @IsString()
  username: string;

  @ApiProperty({ description: '密码', example: '123456' })
  @IsString()
  password: string;
}
