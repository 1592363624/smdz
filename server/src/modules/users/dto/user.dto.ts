/**
 * 用户模块 DTO（数据传输对象）
 * 定义接口入参，配合 class-validator 做校验，并生成 OpenAPI 文档。
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/// 设置游戏昵称请求体（QQ首次注册引导设置）
export class UpdateNicknameDto {
  @ApiProperty({ description: '游戏昵称', example: '冒险者小张' })
  @IsString()
  @MinLength(1, { message: '昵称不能为空' })
  @MaxLength(20, { message: '昵称最多20个字符' })
  nickname: string;
}
