import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

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
