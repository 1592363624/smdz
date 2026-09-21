/**
 * 竞技场管理接口（管理员专用）。
 *
 * 与玩家侧相反：管理动作（结算、改期、授予/撤销特权）是后台运维行为，走 HTTP 与走
 * 「竞技场管理」指令两条入口都收敛到 ArenaSeasonService 的同一批方法，逻辑单点。
 * 鉴权沿用 admin 口径：JwtAuthGuard + RolesGuard + @Roles('ADMIN','SUPER_ADMIN')。
 */
import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { ArenaService } from './arena.service';
import { ArenaSeasonService } from './arena-season.service';
import { EntitlementService } from '../entitlement.service';
import { ARENA_PRIVILEGE_DEFS, PRIVILEGE_BATCH_GATHER } from '../../../config/arena.config';

@ApiTags('管理员 · 竞技场')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/arena')
export class ArenaAdminController {
  constructor(
    private readonly arena: ArenaService,
    private readonly seasons: ArenaSeasonService,
    private readonly entitlement: EntitlementService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: '竞技场概况（赛季 / 镜像数 / 参战人数 / 场次数）' })
  async overview() {
    return { success: true, data: await this.arena.getOverview(0) };
  }

  @Get('ladder')
  @ApiOperation({ summary: '天梯榜（后台审计用，可放大页容量）' })
  async ladder(@Query('page') page?: string, @Query('size') size?: string) {
    const { season } = await this.arena.ensureActiveSeason();
    const pageSize = Math.max(1, Math.min(200, Number(size) || 50));
    const pageIndex = Number(page) > 1 ? Math.floor(Number(page)) : 1;
    return { success: true, data: await this.arena.ladderRows(season.id, pageIndex, pageSize) };
  }

  @Get('season-rewards')
  @ApiOperation({ summary: '当前赛季奖励配置（已归一化）' })
  async seasonRewards() {
    return { success: true, data: await this.seasons.getRewardsConfig() };
  }

  @Get('privileges')
  @ApiOperation({ summary: '某特权的在册持有者（默认批量采集）' })
  async holders(@Query('key') key?: string) {
    const privKey = String(key || PRIVILEGE_BATCH_GATHER).trim();
    return {
      success: true,
      data: {
        key: privKey,
        defs: ARENA_PRIVILEGE_DEFS,
        holders: await this.entitlement.listPrivilegeHolders(privKey, 200),
      },
    };
  }

  @Post('settle')
  @ApiOperation({ summary: '立即结算到期赛季（幂等：未到期的赛季不会被发奖）' })
  async settle() {
    return { success: true, data: { text: await this.seasons.settleExpiredSeasons() } };
  }

  @Post('season/extend')
  @ApiOperation({ summary: '调整本赛季截止时刻：body { days }' })
  async extend(@Body() body: { days?: number }) {
    const days = Number(body?.days);
    if (!Number.isFinite(days)) return { success: false, message: 'days 必须是数字' };
    const { season } = await this.arena.ensureActiveSeason();
    const endAt = new Date(Date.now() + Math.max(0, days) * 24 * 3600 * 1000);
    await this.seasons.setSeasonEndAt(season.id, endAt);
    return { success: true, data: { seasonId: season.id, endAt } };
  }

  @Post('privilege/grant')
  @ApiOperation({ summary: '授予特权：body { userId, key, days, reason }（days=0 表示永久）' })
  async grant(@Req() req, @Body() body: { userId?: number; key?: string; days?: number; reason?: string }) {
    const userId = Number(body?.userId);
    const key = String(body?.key || '').trim();
    if (!userId || !key) return { success: false, message: 'userId 与 key 必填' };
    const days = Number(body?.days);
    const result = await this.entitlement.grantPrivilege(userId, key, {
      source: 'admin',
      days: Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 30,
      permanent: Number(days) === 0,
      reason: String(body?.reason || `管理员授予（操作人 ${req.user?.userId ?? '-'}）`),
      grantedBy: Number(req.user?.userId) || undefined,
    });
    return { success: result.ok, data: result, message: result.ok ? '' : result.text };
  }

  @Post('privilege/revoke')
  @ApiOperation({ summary: '撤销特权：body { userId, key }' })
  async revoke(@Body() body: { userId?: number; key?: string }) {
    const userId = Number(body?.userId);
    const key = String(body?.key || '').trim();
    if (!userId || !key) return { success: false, message: 'userId 与 key 必填' };
    const count = await this.entitlement.revokePrivilege(userId, key);
    return { success: true, data: { revoked: count } };
  }
}
