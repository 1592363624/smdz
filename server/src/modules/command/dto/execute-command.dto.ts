/**
 * 指令引擎 DTO
 * 定义执行指令接口的入参。
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/// 执行指令请求体
export class ExecuteCommandDto {
  @ApiProperty({ description: '指令文本', example: 'info' })
  @IsString()
  @MaxLength(500)
  command: string;

  @ApiProperty({ description: '频道ID(可选，默认1=世界频道)', required: false, example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  channelId?: number;
}
