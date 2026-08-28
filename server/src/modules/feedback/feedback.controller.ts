/**
 * 反馈系统控制器
 * 提供用户端（提交反馈/查看我的反馈/回复）REST 接口以及附件上传接口。
 * 所有接口均生成 OpenAPI 文档。
 *
 * 注意：固定路径（mine / upload）必须声明在参数路由(:id)之前，
 * 否则 /feedback/mine 会被当作 id="mine" 而误入 :id 路由。
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { extname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { GlobalConfig } from '../../config/global.config';
import { FeedbackService } from './feedback.service';
import {
  CreateFeedbackDto,
  CreateFeedbackMessageDto,
} from './dto/feedback.dto';

@ApiTags('反馈系统')
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  /**
   * 附件上传接口（通用：反馈工单/回复消息均可复用）
   * 通过 multipart/form-data 上传，字段名统一为 files，单次最多 maxAttachments 个文件。
   * 返回可访问的相对 URL 列表，前端拿到后再随工单/消息提交。
   */
  @Post('upload')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '上传反馈附件（图片/文件），返回可访问 URL 列表' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string', format: 'binary' } } } } })
  @UseInterceptors(
    FilesInterceptor('files', GlobalConfig.getInstance().maxAttachments, {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          // 上传目录：{uploadDir}/feedback，不存在则创建
          const dir = join(process.cwd(), GlobalConfig.getInstance().uploadDir, 'feedback');
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          // 文件名：时间戳 + 随机串 + 原始扩展名，避免中文/空格问题与重名
          const random = Math.random().toString(36).slice(2, 10);
          const ext = extname(file.originalname || '').toLowerCase();
          cb(null, `${Date.now()}_${random}${ext}`);
        },
      }),
      limits: {
        fileSize: GlobalConfig.getInstance().uploadMaxSize, // 单个文件大小上限（可配置）
        files: GlobalConfig.getInstance().maxAttachments, // 单次最多文件数（可配置）
      },
    }),
  )
  async uploadFiles(@UploadedFiles() files: Express.Multer.File[]) {
    if (!files || files.length === 0) {
      return { success: false, message: '未收到文件' };
    }
    const prefix = GlobalConfig.getInstance().uploadUrlPrefix;
    // 返回相对访问路径，如 /uploads/feedback/xxx.png
    const urls = files.map((f) => `${prefix}/feedback/${f.filename}`);
    return { success: true, data: urls };
  }

  /**
   * 用户提交一个新的反馈工单
   */
  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '提交反馈工单（标题/分类/内容/附件）' })
  async create(@Req() req, @Body() dto: CreateFeedbackDto) {
    const data = await this.feedbackService.create(req.user.userId, dto);
    return { success: true, data };
  }

  /**
   * 用户获取我的反馈工单列表
   */
  @Get('mine')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取我的反馈工单列表' })
  async getMine(@Req() req) {
    const data = await this.feedbackService.getUserFeedbacks(req.user.userId);
    return { success: true, data };
  }

  /// ===== 参数路由（放在固定路径之后） =====

  /**
   * 获取反馈工单详情（本人或管理员）
   */
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取反馈工单详情（含完整消息与附件）' })
  async getDetail(@Req() req, @Param('id', ParseIntPipe) id: number) {
    const data = await this.feedbackService.getFeedbackDetail(id, req.user.userId, req.user.role);
    return { success: true, data };
  }

  /**
   * 追加一条回复消息（用户或管理员，依据身份自动标记 senderType）
   */
  @Post(':id/messages')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '回复反馈工单（追加一条消息）' })
  async reply(@Req() req, @Param('id', ParseIntPipe) id: number, @Body() dto: CreateFeedbackMessageDto) {
    const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(req.user.role);
    const data = await this.feedbackService.addMessage(
      id,
      req.user.userId,
      isAdmin ? 'admin' : 'user',
      dto,
      req.user.role,
    );
    return { success: true, data };
  }
}
