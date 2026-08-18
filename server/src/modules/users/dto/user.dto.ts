/**
 * 用户模块 DTO（数据传输对象）
 * 定义接口入参，配合 class-validator 做校验，并生成 OpenAPI 文档。
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength, IsArray, ArrayMaxSize } from 'class-validator';

/// 设置游戏昵称请求体（QQ首次注册引导设置）
export class UpdateNicknameDto {
  @ApiProperty({ description: '游戏昵称', example: '冒险者小张' })
  @IsString()
  @MinLength(1, { message: '昵称不能为空' })
  @MaxLength(20, { message: '昵称最多20个字符' })
  nickname: string;
}

/// 设置常用指令请求体（全量覆盖用户常用指令列表）
/// 每条元素可为字符串（视为 cmd=label），或 { cmd, label } 对象；cmd 为实际发送内容，label 为面板展示文字
export class SetFavoriteCommandsDto {
  @ApiProperty({
    description:
      '常用指令列表（全量覆盖）。每条可为字符串（如 "攻击"）或对象 { cmd:"攻击 史莱姆", label:"攻击史莱姆" }；cmd 为实际发送内容（可为任意文本，不一定是指令），label 为按钮展示文字。服务端按 cmd 去重、最多保留20条',
    example: ['攻击', '背包', { cmd: '攻击 史莱姆', label: '攻击史莱姆' }],
    type: 'array',
    items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { cmd: { type: 'string' }, label: { type: 'string' } } }] },
  })
  @IsArray()
  @ArrayMaxSize(20, { message: '常用指令最多20条' })
  commands: (string | { cmd: string; label?: string })[];
}
