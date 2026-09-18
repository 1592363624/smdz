/**
 * 全服世界事件只读接口。
 *
 * 项目约定：写操作（领取 / 管理）零新增接口，一律发与 QQ 端逐字相同的指令，保证单写路径。
 * 因此本控制器只提供一个首屏只读 GET；实时进度由 Socket 事件 `worldEvent:progress` 增量刷新。
 */
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WorldEventService } from './world-event.service';

@ApiTags('世界事件')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('game/world-event')
export class WorldEventController {
  constructor(private readonly worldEvent: WorldEventService) {}

  @Get('current')
  @ApiOperation({ summary: '当前世界事件周期 + 进度 + 里程碑 + 本人可领状态（只读）' })
  async getCurrent(@Req() req) {
    const userId = req.user?.userId;
    const data = await this.worldEvent.getCurrentView(Number(userId));
    return { success: true, data };
  }
}
