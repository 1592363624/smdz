/**
 * 使魔竞技场（镜像天梯）指令处理器（独立 handlerKey = 'arena'）。
 *
 * 与 worldEvent handler 同一手法：全部指令归本 handler，靠 rawMessage 首段
 * （引擎按 name/别名命中后改写为「标准指令名 + 参数」）分支，服务内部自鉴权。
 *
 *   竞技场            → 面板 + 天梯榜（带参数：「竞技场 页2」翻页 /「竞技场 5」看第 5 名镜像详情）
 *   提交镜像          → 用当前配置冻结一版角斗镜像（上榜 / 换榜）
 *   挑战镜像 <序号|玩家名> → 自动战斗跑完整结算并出战报
 *   竞技场战绩 [页]   → 我攻出去的和别人打我的
 *   战报 <编号>       → 完整回合正文（仅参战双方可读）
 *   头像框 [佩戴 x]   → 查看 / 切换已获得竞技场装扮
 *   竞技场管理 …      → 管理员：结算 / 开季 / 改期 / 榜 / 预览 / 授特权 / 撤特权 / 持权
 */
import { Inject } from '@nestjs/common';
import { ArenaService } from '../../game/arena/arena.service';
import { ArenaSeasonService } from '../../game/arena/arena-season.service';
import { ARENA_COMMANDS } from '../../../config/arena.config';
import { CommandContext, CommandHandler, CommandResult } from '../interfaces/command.interface';
import { failCommand, okCommand } from '../command-result.util';

export class ArenaHandler implements CommandHandler {
  key = 'arena';
  module = 'game';

  constructor(
    // 显式 @Inject：本类不加 @Injectable()，构造参数上的装饰器才是 emitDecoratorMetadata
    // 产出 design:paramtypes 的前提（与 WorldEventHandler 同写法）。
    @Inject(ArenaService) private readonly arena: ArenaService,
    @Inject(ArenaSeasonService) private readonly seasons: ArenaSeasonService,
  ) {}

  async handle(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    if (!ctx.userId) {
      return failCommand('未登录');
    }
    const userId = Number(ctx.userId);
    const first = ctx.rawMessage.replace(/^[\/！!]/, '').trim().split(/\s+/)[0] || '';
    const rest = args.join(' ').trim();

    let content: string;
    if (first === ARENA_COMMANDS.admin || first === 'arena-admin') {
      content = await this.seasons.adminCommand(userId, args);
    } else if (first === ARENA_COMMANDS.submit || first === 'arena-submit') {
      content = await this.arena.submitMirror(userId);
    } else if (first === ARENA_COMMANDS.challenge || first === 'arena-challenge') {
      content = await this.arena.challengeMirror(userId, rest);
    } else if (first === ARENA_COMMANDS.history || first === 'arena-history') {
      content = await this.arena.viewHistory(userId, rest);
    } else if (first === ARENA_COMMANDS.report || first === 'arena-report') {
      content = /^\d+$/.test(rest)
        ? await this.arena.viewReport(userId, Number(rest))
        : '用法：战报 <编号>（编号见「竞技场战绩」）。';
    } else if (first === ARENA_COMMANDS.frames || first === 'arena-frames') {
      content = await this.arena.viewFrames(userId, rest);
    } else {
      // 竞技场 / arena / jjc / 天梯
      content = await this.arena.viewPanel(userId, rest);
    }
    // 战报与面板只发给本人有意义，统一按私密结果回传发送者
    return okCommand(content);
  }
}
