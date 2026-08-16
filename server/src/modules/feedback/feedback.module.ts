/**
 * 反馈系统模块
 * 提供反馈工单的提交、回复、状态管理、附件上传及实时通知能力。
 */
import { Module } from '@nestjs/common';
import { FeedbackController } from './feedback.controller';
import { FeedbackGateway } from './feedback.gateway';
import { FeedbackService } from './feedback.service';

@Module({
  controllers: [FeedbackController],
  providers: [FeedbackService, FeedbackGateway],
  exports: [FeedbackService],
})
export class FeedbackModule {}
