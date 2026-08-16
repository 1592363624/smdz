/**
 * 反馈系统 DTO
 * 定义创建反馈、回复消息、更新状态等接口的请求/响应数据结构。
 * 配合全局 ValidationPipe(class-validator) 做参数校验。
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** 反馈分类可选值 */
export const FEEDBACK_CATEGORIES = ['general', 'bug', 'suggestion', 'other'] as const;

/** 反馈状态可选值 */
export const FEEDBACK_STATUSES = ['OPEN', 'PROCESSING', 'CLOSED'] as const;

/**
 * 创建反馈请求体
 * 用户提交一个新的反馈工单（含标题、分类、首条描述与可选附件）。
 */
export class CreateFeedbackDto {
  @ApiProperty({ description: '反馈标题', example: '游戏地图卡顿' })
  @IsString()
  @IsNotEmpty({ message: '标题不能为空' })
  @MaxLength(60, { message: '标题最长 60 字' })
  title: string;

  @ApiPropertyOptional({
    description: '反馈分类',
    enum: FEEDBACK_CATEGORIES,
    default: 'general',
  })
  @IsOptional()
  @IsIn(FEEDBACK_CATEGORIES as unknown as string[], { message: '无效的反馈分类' })
  category: string = 'general';

  @ApiProperty({ description: '反馈内容描述', example: '进入第三张地图后帧率明显下降' })
  @IsString()
  @IsNotEmpty({ message: '反馈内容不能为空' })
  @MaxLength(2000, { message: '反馈内容最长 2000 字' })
  content: string;

  @ApiPropertyOptional({ description: '附件访问地址列表（先经上传接口得到，再随工单提交）', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments: string[] = [];
}

/**
 * 回复反馈消息请求体
 * 用户或管理员在既有工单下追加一条消息，可携带附件。
 */
export class CreateFeedbackMessageDto {
  @ApiProperty({ description: '消息内容', example: '已补充截图，请查看' })
  @IsString()
  @IsNotEmpty({ message: '消息内容不能为空' })
  @MaxLength(2000, { message: '消息最长 2000 字' })
  content: string;

  @ApiPropertyOptional({ description: '附件访问地址列表', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments: string[] = [];
}

/**
 * 更新反馈状态请求体（仅管理员）
 */
export class UpdateFeedbackStatusDto {
  @ApiProperty({ description: '目标状态', enum: FEEDBACK_STATUSES, example: 'PROCESSING' })
  @IsIn(FEEDBACK_STATUSES as unknown as string[], { message: '无效的状态' })
  status: string;
}
