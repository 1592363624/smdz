/**
 * 游戏控制器
 * 提供 HTTP API 供前端获取玩家信息、地图连接、执行快捷操作等。
 * 所有接口需要 JWT 登录认证。
 */

import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlayerService } from './player.service';
import { MapService } from './map.service';
import { GameService } from './game.service';
import { CombatSystemService } from './combat-system.service';
import { StatsService } from './stats.service';
import { AdminService } from '../admin/admin.service';

@ApiTags('游戏')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('game')
export class GameController {
  constructor(
    private readonly playerService: PlayerService,
    private readonly mapService: MapService,
    private readonly gameService: GameService,
    private readonly combatSystem: CombatSystemService,
    private readonly statsService: StatsService,
    private readonly adminService: AdminService,
  ) {}

  /**
   * 获取当前登录玩家的完整信息
   * 返回等级、HP、位置、经验等核心数据，前端用于展示玩家信息面板。
   */
  @Get('player/info')
  @ApiOperation({ summary: '获取当前玩家信息（等级、HP、位置等）' })
  async getPlayerInfo(@Req() req) {
    const userId = req.user.userId;
    // 复用 gameService 的玩家状态摘要构建（与 socket 实时推送 player:update 使用同一数据源，保证一致）
    const data = await this.gameService.buildPlayerInfo(userId);
    return { success: true, data };
  }

  /**
   * 获取地图总览：当前所在地图详情 + 可前往子区域 + 全部地图列表
   * 供网页左上角地图面板使用
   */
  @Get('map/overview')
  @ApiOperation({ summary: '获取地图总览（当前区域+全部地图）' })
  async getMapOverview(@Req() req) {
    const overview = await this.gameService.getMapOverview(req.user.userId);
    if (!overview) {
      return { success: false, message: '地图数据不存在' };
    }
    return { success: true, data: overview };
  }

  /**
   * 获取当前玩家所在地图的地图连接（可前往的地图列表）
   */
  @Get('map/connections')
  @ApiOperation({ summary: '获取当前玩家所在地图的可前往连接列表' })
  async getMapConnections(@Req() req) {
    const userId = req.user.userId;
    const { mapId } = await this.playerService.getPlayerLocation(userId);
    const map = await this.mapService.getMapById(mapId);
    const connections = this.mapService.getConnections(map);
    return {
      success: true,
      data: connections.map((c) => ({
        name: c.name,
        distance: c.distance || 0,
        current: false,
      })),
    };
  }

  /**
   * 获取当前玩家所在区域的附近玩家列表（同一地图，含在线状态）
   * 供网页右侧面板展示，支持与其他玩家交互（私聊等）
   */
  @Get('map/nearby-players')
  @ApiOperation({ summary: '获取当前区域附近的玩家列表（同一地图，含在线状态）' })
  async getNearbyPlayers(@Req() req) {
    const userId = req.user.userId;
    const nearbyPlayers = await this.gameService.getNearbyPlayers(userId);
    return { success: true, data: nearbyPlayers };
  }

  /**
   * 获取服务器在线统计（总玩家数、在线人数）
   * 前端左下角展示用
   */
  @Get('stats')
  @ApiOperation({ summary: '获取服务器在线统计（总玩家数、在线人数）' })
  async getStats() {
    const stats = await this.statsService.getStats();
    return { success: true, data: stats };
  }

  @Post('player/action')
  @ApiOperation({ summary: '快捷操作：执行游戏内动作' })
  async quickAction(@Req() req, @Body() body: { action: string }) {
    const userId = req.user.userId;
    const action = body.action?.toLowerCase() || '';

    let result: string;
    switch (action) {
      case 'info':
      case '信息':
        result = await this.gameService.handleInfo(userId);
        break;
      case '攻击':
      case '攻击':
        result = await this.gameService.handleAttack(userId);
        break;
      case '背包':
      case 'bag':
        result = await this.gameService.handleInventory(userId);
        break;
      case '地图':
      case 'map':
        result = await this.gameService.handleMap(userId);
        break;
      default:
        // 尝试处理 "go 地名" 或 "移动 地名"
        if (action.startsWith('go ') || action.startsWith('前往 ')) {
          const target = action.replace(/^(go |前往 )/i, '').trim();
          result = await this.gameService.handleMove(userId, target);
        } else {
          result = `未知快捷操作「${action}」，支持：info/info、攻击/attack、背包/bag、地图/map`;
        }
    }

    // 执行动作后实时推送玩家/地图状态到前端 socket，保证快捷按钮操作即时刷新页面
    await this.gameService.pushPlayerUpdate(userId);
    await this.gameService.pushMapUpdate(userId);

    return { success: true, data: { result } };
  }

  /**
   * 玩家自助清除自己的游戏数据（重置为未开始游玩，保留账号）
   * 与管理员后台「清空游戏数据」走同一实现（AdminService.resetPlayerData），
   * 目标固定为当前登录账号（无任何目标参数），普通玩家无法清除他人数据。
   */
  @Post('player/reset-data')
  @ApiOperation({ summary: '清除自己的游戏数据(重置为未开始游玩，保留账号)' })
  async resetMyData(@Req() req) {
    const message = await this.adminService.resetPlayerData(req.user.userId);
    return { success: true, message };
  }
}