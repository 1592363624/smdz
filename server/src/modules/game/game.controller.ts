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
import { StatsService } from './stats.service';

@ApiTags('游戏')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('game')
export class GameController {
  constructor(
    private readonly playerService: PlayerService,
    private readonly mapService: MapService,
    private readonly gameService: GameService,
    private readonly statsService: StatsService,
  ) {}

  /**
   * 获取当前登录玩家的完整信息
   * 返回等级、HP、位置、经验等核心数据，前端用于展示玩家信息面板。
   */
  @Get('player/info')
  @ApiOperation({ summary: '获取当前玩家信息（等级、HP、位置等）' })
  async getPlayerInfo(@Req() req) {
    const userId = req.user.userId;
    const playerData = await this.playerService.getPlayerData(userId);
    const { player } = playerData;
    return {
      success: true,
      data: {
        id: player.id,
        userId: player.userId,
        level: player.level,
        exp: player.exp,
        upgradeExp: player.upgradeExp,
        name: player.name,
        type: player.type,
        hp: player.hp,
        maxHp: player.maxHp,
        shield: player.shield,
        maxShield: player.maxShield,
        armor: player.armor,
        maxArmor: player.maxArmor,
        attack: player.attack,
        defense: player.defense,
        speed: player.speed,
        dodge: player.dodge,
        hit: player.hit,
        crit: player.crit,
        critDmg: player.critDmg,
        mapId: player.mapId,
        location: player.location,
        affinity: player.affinity,
      },
    };
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
      case 'attack':
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

    return { success: true, data: { result } };
  }
}