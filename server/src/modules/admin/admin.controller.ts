/**
 * 管理员控制器
 * 提供用户管理、系统配置管理、游戏管理等后台管理接口，仅 ADMIN 及以上角色可访问。
 * 所有接口均生成 OpenAPI 文档。
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { GlobalConfig } from '../../config/global.config';
import { SystemConfigService } from '../system-config/system-config.service';
import { AdminService } from './admin.service';
import {
  AnnouncementDto,
  DeleteUserDto,
  EditPlayerDataDto,
  GiveItemDto,
  ModifyPlayerDto,
  ResetUserDataDto,
  SetWorldLevelDto,
  UpdateConfigDto,
  UpdateUserDto,
  UserDetailDto,
} from './dto/admin.dto';

@ApiTags('管理员')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard) // 先登录，再校验角色
@Roles('ADMIN', 'SUPER_ADMIN') // 整个控制器要求管理员及以上
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  /// ===== 用户管理 =====

  @Get('users')
  @ApiOperation({ summary: '分页查询用户列表' })
  async listUsers(
    @Query('page') page = 1,
    @Query('pageSize') pageSize = 20,
    @Query('keyword') keyword?: string,
  ) {
    const data = await this.adminService.listUsers(Number(page), Number(pageSize), keyword);
    return { success: true, data };
  }

  @Post('users/update')
  @ApiOperation({ summary: '更新用户角色/状态/昵称/QQ号' })
  async updateUser(@Body() dto: UpdateUserDto) {
    const user = await this.adminService.updateUser(dto.id, {
      role: dto.role,
      status: dto.status,
      nickname: dto.nickname,
      qqNumber: dto.qqNumber,
    });
    return { success: true, data: user };
  }

  @Post('users/detail')
  @ApiOperation({ summary: '获取用户详细信息(含玩家档案、在线状态、累计在线时长等)' })
  async getUserDetail(@Body() dto: UserDetailDto) {
    const data = await this.adminService.getUserDetail(dto.id);
    return { success: true, data };
  }

  @Post('players/edit')
  @ApiOperation({ summary: '批量编辑玩家游戏数据(字段白名单，数值自动校验)' })
  async editPlayerData(@Body() dto: EditPlayerDataDto, @Req() req) {
    const message = await this.adminService.editPlayerData(
      req.user.userId,
      dto.id,
      dto.data,
    );
    return { success: true, message };
  }

  @Post('users/delete')
  @ApiOperation({ summary: '删除用户(级联删除其玩家档案，不可删除自己/超级管理员)' })
  async deleteUser(@Body() dto: DeleteUserDto, @Req() req) {
    const message = await this.adminService.deleteUser(req.user.userId, dto.id);
    return { success: true, message };
  }

  @Post('users/reset-data')
  @ApiOperation({ summary: '清理用户游戏数据(重置为未开始游玩，保留账号)' })
  async resetUserData(@Body() dto: ResetUserDataDto) {
    const message = await this.adminService.resetPlayerData(dto.id);
    return { success: true, message };
  }

  /// ===== 系统配置中心 =====

  @Get('config')
  @ApiOperation({ summary: '获取所有系统配置项' })
  async listConfig() {
    const data = await this.systemConfigService.findAll();
    return { success: true, data };
  }

  @Get('config/:key')
  @ApiOperation({ summary: '获取单个配置项' })
  async getConfig(@Param('key') key: string) {
    const data = await this.systemConfigService.findByKey(key);
    return { success: true, data };
  }

  @Post('config/update')
  @ApiOperation({ summary: '更新系统配置项(在线生效)' })
  async updateConfig(@Body() dto: UpdateConfigDto) {
    const data = await this.systemConfigService.set(dto.key, dto.value);
    return { success: true, data };
  }

  /// ===== 游戏管理 =====

  @Get('status')
  @ApiOperation({ summary: '获取服务器状态（用户数、在线玩家、地图数等）' })
  async getServerStatus() {
    const data = await this.adminService.getServerStatus();
    return { success: true, data };
  }

  /** 前端兼容：/admin/dashboard 映射到 /admin/status */
  @Get('dashboard')
  @ApiOperation({ summary: '获取服务器仪表盘数据（同 status）' })
  async getDashboard() {
    const data = await this.adminService.getServerStatus();
    return { success: true, data };
  }

  @Post('announcement')
  @ApiOperation({ summary: '发送系统公告（广播给所有在线玩家，兼容 content/message 字段）' })
  async sendAnnouncement(@Body() dto: AnnouncementDto) {
    const content = dto.content ?? dto.message;
    if (!content || !content.trim()) {
      throw new BadRequestException('公告内容不能为空');
    }
    await this.adminService.sendAnnouncement(content);
    return { success: true, message: '公告已发送' };
  }

  /** 前端兼容：/admin/gm/announcement 映射到 /admin/announcement */
  @Post('gm/announcement')
  @ApiOperation({ summary: '发送系统公告（GM 兼容路径）' })
  async sendGmAnnouncement(@Body() dto: AnnouncementDto) {
    const content = dto.content ?? dto.message;
    if (!content || !content.trim()) {
      throw new BadRequestException('公告内容不能为空');
    }
    await this.adminService.sendAnnouncement(content);
    return { success: true, message: '公告已发送' };
  }

  /**
   * 公告配图上传（仅图片）
   * 存储到 {uploadDir}/announcement/，返回可嵌入公告正文的相对 URL，
   * GM 编辑器以 Markdown 图片语法 ![描述](url) 插入正文。
   */
  @Post('announcement/upload')
  @ApiOperation({ summary: '上传公告配图（仅图片），返回可访问 URL 列表' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string', format: 'binary' } } } },
  })
  @UseInterceptors(
    FilesInterceptor('files', 5, {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          // 上传目录：{uploadDir}/announcement，不存在则创建
          const dir = join(process.cwd(), GlobalConfig.getInstance().uploadDir, 'announcement');
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
        fileSize: GlobalConfig.getInstance().uploadMaxSize,
        files: 5,
      },
      fileFilter: (_req, file, cb) => {
        // 仅允许图片类型
        if (file.mimetype && file.mimetype.startsWith('image/')) {
          cb(null, true);
        } else {
          cb(new BadRequestException('公告配图仅支持图片文件'), false);
        }
      },
    }),
  )
  async uploadAnnouncementImages(@UploadedFiles() files: Express.Multer.File[]) {
    if (!files || files.length === 0) {
      return { success: false, message: '未收到文件' };
    }
    const prefix = GlobalConfig.getInstance().uploadUrlPrefix;
    // 返回相对访问路径，如 /uploads/announcement/xxx.png
    const urls = files.map((f) => `${prefix}/announcement/${f.filename}`);
    return { success: true, data: urls };
  }

  @Post('world-level')
  @ApiOperation({ summary: '设置世界等级（影响怪物强度和掉落）' })
  async setWorldLevel(@Body() dto: SetWorldLevelDto) {
    const message = await this.adminService.setWorldLevel(dto.level);
    return { success: true, message };
  }

  /** 前端兼容：获取世界等级 */
  @Get('gm/world-level')
  @ApiOperation({ summary: '获取当前世界等级' })
  async getWorldLevel() {
    const level = await this.systemConfigService.get<number>('game.worldLevel', 1);
    return { success: true, data: { level } };
  }

  /** 前端兼容：/admin/gm/world-level 映射到 /admin/world-level */
  @Post('gm/world-level')
  @ApiOperation({ summary: '设置世界等级（GM 兼容路径）' })
  async setGmWorldLevel(@Body() dto: SetWorldLevelDto) {
    const message = await this.adminService.setWorldLevel(dto.level);
    return { success: true, message };
  }

  @Get('configs')
  @ApiOperation({ summary: '获取系统配置列表（可按分组筛选）' })
  async getConfigs(@Query('group') group?: string) {
    const data = await this.adminService.getSystemConfigs(group);
    return { success: true, data };
  }

  @Put('configs')
  @ApiOperation({ summary: '更新系统配置' })
  async updateAdminConfig(@Body() dto: UpdateConfigDto) {
    const message = await this.adminService.updateSystemConfig(dto.key, dto.value);
    return { success: true, message };
  }

  @Get('players')
  @ApiOperation({ summary: '获取玩家列表（管理员用，分页）' })
  async getPlayers(
    @Query('page') page = 1,
    @Query('pageSize') pageSize = 20,
  ) {
    const data = await this.adminService.getPlayersList(Number(page), Number(pageSize));
    return { success: true, data };
  }

  @Post('players/:id/ban')
  @ApiOperation({ summary: '封禁/解封用户（切换 ACTIVE ↔ BANNED）' })
  async toggleBan(@Param('id', ParseIntPipe) id: number) {
    const message = await this.adminService.toggleUserBan(id);
    return { success: true, message };
  }

  /**
   * GM 给玩家发送物品
   * 兼容两种指定方式：userId 或 target(用户名/昵称/QQ号/ID)；数量兼容 count/quantity
   */
  @Post('give-item')
  @ApiOperation({ summary: 'GM 给玩家发送物品(支持用户名/ID定位)' })
  async giveItem(@Body() dto: GiveItemDto) {
    const message = await this.resolveGiveTarget(dto, dto.itemName);
    return { success: true, message };
  }

  /** 前端兼容：/admin/gm/give-item 映射到 /admin/give-item */
  @Post('gm/give-item')
  @ApiOperation({ summary: 'GM 给玩家发送物品（兼容路径）' })
  async giveGmItem(@Body() dto: GiveItemDto) {
    const message = await this.resolveGiveTarget(dto, dto.itemName);
    return { success: true, message };
  }

  @Post('gm/modify-player')
  @ApiOperation({ summary: 'GM 修改玩家属性(白名单字段，支持用户名/ID定位)' })
  async modifyPlayer(@Body() dto: ModifyPlayerDto, @Req() req) {
    // 优先使用 userId，否则按 target(用户名/昵称/QQ号/ID) 解析
    const targetUser: any = dto.userId
      ? { id: dto.userId }
      : await this.adminService.resolveUserTarget(dto.target ?? '');
    const message = await this.adminService.gmModifyPlayer(
      req.user.userId,
      targetUser.id,
      dto.field,
      dto.value,
    );
    return { success: true, message };
  }

  /** 解析发放物品请求的目标与数量，并执行发放 */
  private resolveGiveTarget(dto: GiveItemDto, itemName: string) {
    const count = dto.count ?? dto.quantity ?? 1;
    if (dto.userId) {
      return this.adminService.gmGiveItem(dto.userId, itemName, count);
    }
    return this.adminService.gmGiveItemToTarget(dto.target ?? '', itemName, count);
  }
}