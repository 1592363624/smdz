/** 反馈系统模块：工单提交/回复/状态管理、附件上传与实时通知。 */
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
