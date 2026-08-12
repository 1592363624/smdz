/**
 * 管理员控制器
 * 提供用户管理、系统配置管理、游戏管理等后台管理接口，仅 ADMIN 及以上角色可访问。
 * 所有接口均生成 OpenAPI 文档。
 */

import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SystemConfigService } from '../system-config/system-config.service';
import { AdminService } from './admin.service';
import {
  AnnouncementDto,
  GiveItemDto,
  SetWorldLevelDto,
  UpdateConfigDto,
  UpdateUserDto,
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
  @ApiOperation({ summary: '更新用户角色/状态/昵称' })
  async updateUser(@Body() dto: UpdateUserDto) {
    const user = await this.adminService.updateUser(dto.id, {
      role: dto.role,
      status: dto.status,
      nickname: dto.nickname,
    });
    return { success: true, data: user };
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
  @ApiOperation({ summary: '发送系统公告（广播给所有在线玩家）' })
  async sendAnnouncement(@Body() dto: AnnouncementDto) {
    await this.adminService.sendAnnouncement(dto.content);
    return { success: true, message: '公告已发送' };
  }

  /** 前端兼容：/admin/gm/announcement 映射到 /admin/announcement */
  @Post('gm/announcement')
  @ApiOperation({ summary: '发送系统公告（GM 兼容路径）' })
  async sendGmAnnouncement(@Body() dto: AnnouncementDto) {
    await this.adminService.sendAnnouncement(dto.content);
    return { success: true, message: '公告已发送' };
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

  @Post('give-item')
  @ApiOperation({ summary: 'GM 给玩家发送物品' })
  async giveItem(@Body() dto: GiveItemDto) {
    const message = await this.adminService.gmGiveItem(dto.userId, dto.itemName, dto.count);
    return { success: true, message };
  }

  /** 前端兼容：/admin/gm/give-item 映射到 /admin/give-item */
  @Post('gm/give-item')
  @ApiOperation({ summary: 'GM 给玩家发送物品（兼容路径）' })
  async giveGmItem(@Body() dto: GiveItemDto) {
    const message = await this.adminService.gmGiveItem(dto.userId, dto.itemName, dto.count);
    return { success: true, message };
  }
}