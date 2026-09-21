/**
 * 竞技场 Web 只读接口（与指令侧同一批数据，供网页天梯页展示）。
 *
 * 项目约定：写操作（提交镜像 / 挑战）零新增接口，一律发与 QQ 端逐字相同的指令，
 * 保证「机器人 / 网页 / API」三条入口共用同一条写路径与同一套门槛。
 */
import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ArenaService } from './arena.service';
import { ArenaSeasonService } from './arena-season.service';

@ApiTags('使魔竞技场')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('game/arena')
export class ArenaController {
  constructor(
    private readonly arena: ArenaService,
    private readonly seasons: ArenaSeasonService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: '赛季与竞技场概况 + 我的天梯状态（面板首屏，只读）' })
  async overview(@Req() req) {
    const userId = Number(req.user?.userId);
    return { success: true, data: await this.arena.getOverview(userId) };
  }

  @Get('ladder')
  @ApiOperation({ summary: '天梯榜分页：?page=2' })
  async ladder(@Query('page') page?: string) {
    const { season } = await this.arena.ensureActiveSeason();
    const cfg = await this.arena.getConfig();
    const pageIndex = Number(page) > 1 ? Math.floor(Number(page)) : 1;
    return { success: true, data: await this.arena.ladderRows(season.id, pageIndex, cfg.pageSize) };
  }

  @Get('matches')
  @ApiOperation({ summary: '我的战绩分页（结构化，前端不做文本解析）' })
  async matches(@Req() req, @Query('page') page?: string) {
    const userId = Number(req.user?.userId);
    const pageIndex = Number(page) > 1 ? Math.floor(Number(page)) : 1;
    return { success: true, data: await this.arena.matchesForUser(userId, pageIndex) };
  }

  @Get('report/:id')
  @ApiOperation({ summary: '单份完整战报（仅参战双方可读）' })
  async report(@Req() req, @Param('id') id: string) {
    const userId = Number(req.user?.userId);
    return { success: true, data: await this.arena.reportForUser(Number(id), userId) };
  }

  @Get('frames')
  @ApiOperation({ summary: '我的头像框与佩戴状态、当前生效特权' })
  async frames(@Req() req) {
    const userId = Number(req.user?.userId);
    return { success: true, data: await this.arena.entitlementsForUser(userId) };
  }

  @Get('season-rewards')
  @ApiOperation({ summary: '当前赛季奖励配置（名次档/称号/头像框/特权，公示用）' })
  async seasonRewards() {
    return { success: true, data: await this.seasons.getRewardsConfig() };
  }
}
