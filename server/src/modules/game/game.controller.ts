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
import { HomeService } from './home.service';
import { HomeYardService } from './home-yard.service';
import { FrontlineViewService } from './frontline-view.service';
import { FamiliarSystemService } from './familiar-system.service';
import { StaticDataService } from './static-data.service';
import { LotteryService } from './lottery.service';

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
    private readonly homeService: HomeService,
    private readonly homeYardService: HomeYardService,
    private readonly frontlineViewService: FrontlineViewService,
    private readonly familiarSystem: FamiliarSystemService,
    private readonly staticData: StaticDataService,
    private readonly lotteryService: LotteryService,
  ) {}

  /**
   * 获取增益定义清单（前端悬浮提示用）
   * 数据源：buffs.json（原版静态增益，含描述/时长/加成）+ buff-docs.json（人工维护的
   * 技能/装备类增益描述）。同名条目以 buff-docs 为准（描述更面向玩家、含实际数值）。
   */
  @Get('buff-definitions')
  @ApiOperation({ summary: '获取增益定义清单（名称/描述/时长/属性加成，悬浮提示用）' })
  getBuffDefinitions() {
    // 静态增益：跳过「增益模板」行（仅作转换工具的格式样板，不是真实增益）
    const staticBuffs = this.staticData
      .getAllBuffs()
      .filter((b: any) => b && b.name && b.name !== '增益模板')
      .map((b: any) => ({
        name: b.name,
        description: b.description || '',
        duration: Number(b.duration) || 0,
        bonus: b.bonus || {},
      }));
    // 人工描述：按名称建索引，覆盖同名静态条目
    const docMap = new Map<string, any>();
    for (const d of this.staticData.getAllBuffDocs()) {
      if (d && d.name) docMap.set(d.name, { name: d.name, description: d.description || '', duration: 0, bonus: {} });
    }
    for (const b of staticBuffs) {
      if (!docMap.has(b.name)) docMap.set(b.name, b);
    }
    return { success: true, data: Array.from(docMap.values()) };
  }

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
   * 使魔契约引导页数据（全屏选择页用，只读）。
   *
   * 与文本门禁（未选使魔时拦截指令返回的两列菜单）同源：可选集合与展示顺序
   * 均取自静态使魔定义 `!noSummon` 过滤后的原始序，保证 Web 与 QQ/AstrBot 一致。
   * `needsSelection=false` 表示玩家已开局，前端据此直接回主界面。
   */
  @Get('familiar/gate')
  @ApiOperation({ summary: '使魔契约引导页数据（可选使魔全量清单 + 是否需要选择）' })
  async getFamiliarGate(@Req() req) {
    const data = await this.familiarSystem.getFirstFamiliarGateDetail(req.user.userId);
    return { success: true, data };
  }

  /**
   * 建立使魔契约：等价于文本渠道发送「选择使魔确认<名称>」。
   *
   * 复用指令侧的首次选择实现（清空初始数据、写入角色、领教程任务、升级提示），
   * 不新增第二条落库路径；返回 `success=false` 时为可预期业务拒绝（名称非法/已开局）。
   */
  @Post('familiar/choose')
  @ApiOperation({ summary: '建立使魔契约（首次选择使魔，等价于「选择使魔确认<名称>」）' })
  async chooseFamiliar(@Req() req, @Body() body: { name: string }) {
    const result = await this.familiarSystem.chooseFirstFamiliar(req.user.userId, body?.name);
    return { success: result.ok, message: result.message };
  }

  /**
   * 获取家园总览（只读预览，结构化 DTO）。
   * 在深克隆上运行与家园结算完全相同的公式：不推进观测时间、不领取产出、
   * 不写任何标记——网页面板随便看，QQ 端「产出」的结算不受影响。
   */
  @Get('home/overview')
  @ApiOperation({ summary: '获取家园总览（只读预览：电力/燃料/产出速率/存放地/设备快照）' })
  async getHomeOverview(@Req() req) {
    const data = await this.homeService.getHomeOverview(req.user.userId);
    return { success: true, data };
  }

  /**
   * 获取家园院子格子视图（QQ 农场式地块总览，只读）。
   *
   * 把院子地图上的建筑 / 作物 / 地面障碍投影成一格一格的地块数组，并附带背包里
   * 可种植的种子与可安装的建筑，供网页端在格子上直接点选操作。
   *
   * 与 home/overview 同为只读：不推进观测时间、不领取产出、不写任何标记；
   * 一切变更仍走 QQ 与网页统一的指令通道（种植 / 收获 / 安装 / 拆除 / 产出），
   * 不存在第二条写路径。
   */
  @Get('home/yard')
  @ApiOperation({ summary: '获取家园院子格子视图（地块/仓库/障碍/存放地，只读不结算）' })
  async getHomeYard(@Req() req) {
    const data = await this.homeYardService.getHomeYard(req.user.userId);
    return { success: true, data };
  }

  /**
   * 获取家园前线面板视图（防御阵地/火力通道/敌人波次/活动状态/可安装防御建筑，只读）。
   *
   * 与 home/yard 同为只读：不推进战斗回合、不写任何标记；
   * 安装 / 拆卸 / 开始战斗 / 前往前线 仍走 QQ 与网页统一的指令通道。
   */
  @Get('home/frontline')
  @ApiOperation({ summary: '获取家园前线面板（防御/火力/敌人/库存，只读不结算）' })
  async getHomeFrontline(@Req() req) {
    const data = await this.frontlineViewService.getFrontlineView(req.user.userId);
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
   * 获取服务器在线统计（总玩家数、在线人数、在线玩家名单）
   * 前端左下角展示用：鼠标悬停「在线」数字时展示名单（条数上限由
   * GlobalConfig.presence.onlineListLimit 控制，默认 10）
   */
  @Get('stats')
  @ApiOperation({ summary: '获取服务器在线统计（总玩家数、在线人数、在线玩家名单）' })
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

  /**
   * 超管特权：立即完成自己进行中的延时读条（采集/移动/救援等）。
   * Web 读条「⚡完成」按钮的专用静默通道——指令与回包都不进公屏聊天流。
   * 结构化返回（success/message/completed），前端按 success 弹 Toast；
   * 权限校验在 finishNowForUser 内（ADMIN/SUPER_ADMIN，ok=false 时 success=false）。
   */
  @Post('admin/finish-now')
  @ApiOperation({ summary: '超管特权：立即完成自己的延时读条（静默，不进聊天流）' })
  async finishNow(@Req() req) {
    const result = await this.gameService.finishNowForUser(req.user.userId);
    return { success: result.ok, message: result.message, completed: result.completed };
  }

  /**
   * 家园清障排队（挖土/割草连点）：写入玩家 markers['清障队列']，跨刷新/重启不丢。
   * 空闲时自动开第一发；进行中只入队，采集结算后服务端自动接龙。
   */
  @Post('home/enqueue-clear')
  @ApiOperation({ summary: '家园清障排队（挖土/割草，服务端持久队列）' })
  async enqueueHomeClear(@Req() req, @Body() body: { cmd?: string; count?: number }) {
    const result = await this.gameService.enqueueHomeClear(
      req.user.userId,
      String(body?.cmd || ''),
      Number(body?.count) || 1,
    );
    return {
      success: result.ok,
      message: result.message,
      queueCount: result.queueCount ?? 0,
      added: result.added ?? 0,
    };
  }

  /**
   * 超管：跳过整条家园清障队列（进行中 + 已排队全部立即结算），不进聊天流。
   */
  @Post('home/finish-clear')
  @ApiOperation({ summary: '超管：跳过整条家园清障队列（静默）' })
  async finishHomeClear(@Req() req) {
    const result = await this.gameService.finishAllHomeClear(req.user.userId);
    return {
      success: result.ok,
      message: result.message,
      completed: result.completed,
    };
  }

  /**
   * 清障队列空转救援：有队列但无「采集中」读条时（刷新后/结算间隙）主动接龙开挖。
   */
  @Post('home/drain-clear')
  @ApiOperation({ summary: '家园清障队列接龙（队列有货且无读条时开挖下一条）' })
  async drainHomeClear(@Req() req) {
    await this.gameService.drainHomeClearQueue(req.user.userId);
    return { success: true };
  }

  /**
   * 写模型诊断（可观测性）：旧快照拦截 / 乐观锁冲突计数。
   *
   * 这两类事件都是**静默丢写**信号——strict 模式下调用方拿不到异常，玩家只会看到
   * 「操作了但状态没生效」。此前只能靠玩家反馈 + 翻日志堆栈人肉定位；现在可直接读
   * 本端点：`staleWriteBlocked > 0` 即代表仍有写路径没走 mutate 管道，
   * `staleWriteCaller` 给出最近一次的调用方栈首帧，配合日志堆栈即可定位到方法。
   */
  @Get('admin/write-model')
  @ApiOperation({ summary: '写模型诊断：旧快照拦截 / 乐观锁冲突计数' })
  getWriteModelDiagnostics() {
    return { success: true, data: this.playerService.getWriteModelDiagnostics() };
  }

  /**
   * 抽奖状态：今日剩余次数、凭证持有、奖池规模与预览（前端滚动动画用）。
   */
  @Get('lottery/status')
  @ApiOperation({ summary: '每日抽奖状态（剩余次数/凭证/奖池预览）' })
  async getLotteryStatus(@Req() req) {
    const data = await this.lotteryService.getStatus(req.user.userId);
    return { success: true, data };
  }

  /**
   * 执行一次抽奖：消耗凭证，从奖池随机发一件资源或武器入包。
   * 每天 0 点重置次数；结果供前端播放道具名跳动动画后展示。
   */
  @Post('lottery/draw')
  @ApiOperation({ summary: '每日抽奖（消耗凭证，中奖自动入包）' })
  async drawLottery(@Req() req) {
    const result = await this.lotteryService.drawOnce(req.user.userId);
    // 执行后推送玩家状态，前端背包/资源即时刷新
    if (result.ok) {
      await this.gameService.pushPlayerUpdate(req.user.userId);
    }
    return {
      success: result.ok,
      message: result.message,
      reward: result.reward ?? null,
      dailyLimitHit: !!result.dailyLimitHit,
      noTicket: !!result.noTicket,
    };
  }
}