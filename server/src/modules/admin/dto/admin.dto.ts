/**
 * 管理员模块 DTO
 * 定义管理员操作(用户管理、系统配置、游戏管理)的请求体结构。
 */

import { ApiProperty } from '@nestjs/swagger';
import { Allow, IsIn, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

/// 更新用户角色/状态
export class UpdateUserDto {
  @ApiProperty({ description: '用户ID', example: 1 })
  @IsInt()
  id: number;

  @ApiProperty({ description: '新角色', enum: ['USER', 'ADMIN', 'SUPER_ADMIN'], required: false })
  @IsOptional()
  @IsIn(['USER', 'ADMIN', 'SUPER_ADMIN'])
  role?: string;

  @ApiProperty({ description: '账号状态', enum: ['ACTIVE', 'BANNED'], required: false })
  @IsOptional()
  @IsIn(['ACTIVE', 'BANNED'])
  status?: string;

  @ApiProperty({ description: '昵称', required: false })
  @IsOptional()
  @IsString()
  nickname?: string;

  @ApiProperty({ description: 'QQ号(可修改，解绑传空字符串)', required: false, example: '123456789' })
  @IsOptional()
  @IsString()
  @Matches(/^(\d{5,12})?$/, { message: 'QQ号格式不正确' })
  qqNumber?: string;
}

/// 删除用户
export class DeleteUserDto {
  @ApiProperty({ description: '用户ID', example: 1 })
  @IsInt()
  id: number;
}

/// 获取用户详情（含玩家档案）
export class UserDetailDto {
  @ApiProperty({ description: '用户ID', example: 1 })
  @IsInt()
  id: number;
}

/// 批量编辑玩家游戏数据（GM 用户管理"编辑"弹窗）
export class EditPlayerDataDto {
  @ApiProperty({ description: '用户ID', example: 1 })
  @IsInt()
  id: number;

  @ApiProperty({
    description: '待修改字段(白名单: name/type/level/exp/hp/maxHp/attack/defense/mapId/location 等)',
    example: { level: 50, attack: 999 },
    type: Object,
    additionalProperties: true,
  })
  @Allow() // 任意结构，服务层按字段白名单逐一校验
  data: Record<string, any>;
}

/// 清理用户游戏数据（保留账号）
export class ResetUserDataDto {
  @ApiProperty({ description: '用户ID', example: 1 })
  @IsInt()
  id: number;
}

/// 更新系统配置项
export class UpdateConfigDto {
  @ApiProperty({ description: '配置键', example: 'command.prefixes' })
  @IsString()
  key: string;

  @ApiProperty({ description: '新配置值', example: '["/","!"]' })
  @Allow() // 任意类型，避免被 whitelist 过滤
  value: any;
}

/// 发送系统公告（兼容 content / message 两种字段名）
export class AnnouncementDto {
  @ApiProperty({ description: '公告内容', example: '服务器将于今晚 22:00 进行维护', required: false })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiProperty({ description: '公告内容(兼容字段)', required: false })
  @IsOptional()
  @IsString()
  message?: string;
}

/// 设置世界等级
export class SetWorldLevelDto {
  @ApiProperty({ description: '世界等级', example: 50, minimum: 1 })
  @IsInt()
  @Min(1)
  level: number;
}

/// GM 给玩家发送物品（兼容 target=用户名/ID 与 userId 两种指定方式，count/quantity 兼容）
export class GiveItemDto {
  @ApiProperty({ description: '目标用户ID', example: 1, required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  userId?: number;

  @ApiProperty({ description: '目标玩家(用户名或ID)', example: 'alice', required: false })
  @IsOptional()
  @IsString()
  target?: string;

  @ApiProperty({ description: '物品名称', example: '水晶' })
  @IsString()
  itemName: string;

  @ApiProperty({ description: '数量', example: 10, default: 1, required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  count?: number;

  @ApiProperty({ description: '数量(兼容字段)', example: 10, required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;
}

/// GM 修改玩家属性（兼容 target=用户名/昵称/QQ号/ID 与 userId）
export class ModifyPlayerDto {
  @ApiProperty({ description: '目标用户ID', example: 1, required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  userId?: number;

  @ApiProperty({ description: '目标玩家(用户名/昵称/QQ号/ID)', example: 'alice', required: false })
  @IsOptional()
  @IsString()
  target?: string;

  @ApiProperty({
    description: '要修改的属性字段',
    example: 'level',
    enum: [
      'level', 'exp', 'name', 'hp', 'maxHp', 'shield', 'maxShield',
      'armor', 'maxArmor', 'attack', 'defense', 'speed', 'dodge',
      'hit', 'crit', 'critDmg', 'affinity', 'mapId', 'location',
    ],
  })
  @IsString()
  field: string;

  @ApiProperty({ description: '新值(数值或字符串)', example: '10' })
  @IsString()
  value: string;
}