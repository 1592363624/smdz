/**
 * 指令引擎服务 - 核心分发器
 * 对应原版易语言"处理群/处理私聊"函数，但做成了统一、可配置、多来源的引擎。
 *
 * 设计要点：
 * - 指令注册表存数据库(Command表)，新增/修改指令不用改代码重编译
 * - 每个具体逻辑通过 CommandHandler 注册，key 与数据库 handlerKey 对应
 * - 支持多种来源(网页/AstrBot/API)统一进入 dispatch
 * - 冷却采用"原版 per-action 模式"：引擎层不做任何指令级统一冷却，
 *   所有冷却由具体动作逻辑(战斗/闪避/传送等)写入玩家 markers2 持久化标记控制。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CommandContext,
  CommandHandler,
  CommandResult,
  CommandSource,
} from './interfaces/command.interface';
import { COMMAND_HANDLER_MAP } from './command-handler-map.provider';

@Injectable()
export class CommandService {
  private readonly logger = new Logger(CommandService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(COMMAND_HANDLER_MAP)
    private readonly handlerMap: Record<string, CommandHandler>,
  ) {}

  /**
   * 指令分发总入口
   * 所有来源(网页/机器人/API)的指令都汇聚到这里。
   */
  async dispatch(ctx: CommandContext): Promise<CommandResult> {
    const start = Date.now();
    try {
      // 1. 解析指令名：取第一个空格前的单词作为指令名
      //    兼容 /指令、！指令、! 指令 以及无前缀的直接输入
      const rawTrimmed = ctx.rawMessage.trim();
      const [rawName, ...args] = rawTrimmed.split(/\s+/);
      // 去除前缀字符（/！!），若去除后为空则保留原词（用于无前缀模式）
      const commandName = (rawName || '').replace(/^[\/！!]+/, '') || rawName || '';

      if (!commandName) {
        return {
          success: false,
          content: '请输入指令，输入"帮助"查看可用指令',
          broadcast: false,
          durationMs: Date.now() - start,
        };
      }

      // 2. 从数据库指令表查找指令定义
      //    使用 equals 匹配 name，contains 匹配 alias（避免部分匹配问题）
      const cmdDef = await this.prisma.command.findFirst({
        where: {
          enabled: true,
          OR: [
            { name: { equals: commandName } },
            { alias: { contains: commandName } },
          ],
        },
      });

      if (!cmdDef) {
        // 对齐原版设计：指令表未命中时，兜底尝试"地图资源采集"。
        // 原版（_主程序.ecode）所有指令匹配失败后进入采集分支，按当前地图资源2的"采集指令"匹配，
        // 因此采集指令不需要预注册到指令表，而是运行时匹配当前地图资源（如 打开箱子/打开休眠仓/收集木头/捡垃圾）。
        // 若当前地图无匹配资源，GatherHandler 返回 success=false，此处再退化为未知指令提示。
        const gatherHandler: CommandHandler | undefined = this.handlerMap['gather'];
        if (gatherHandler) {
          try {
            const gatherResult = await gatherHandler.handle(ctx, [commandName]);
            if (gatherResult && gatherResult.success) {
              gatherResult.durationMs = Date.now() - start;
              await this.recordLog(ctx, commandName, gatherResult);
              return gatherResult;
            }
          } catch (e) {
            // 采集兜底失败时忽略，走未知指令提示
            this.logger.warn(`采集兜底失败: ${e.message}`);
          }
        }
        return {
          success: false,
          content: `未找到指令「${commandName}」，输入"帮助"查看可用指令`,
          broadcast: false,
          durationMs: Date.now() - start,
        };
      }

      // 3. 校验权限（当前先简化，管理员指令需 ADMIN 以上）
      if (cmdDef.minRole !== 'USER' && ctx.source === CommandSource.WEB) {
        // TODO: 接入用户角色判断，此处预留
      }

      // 4. 冷却检查（严格对齐原版 per-action 模式）：
      //    引擎层不做任何"指令级统一冷却"。所有冷却由具体动作逻辑（战斗/闪避/传送等）
      //    各自写入玩家 markers2 持久化标记控制。此处直接分发。
      //    （历史遗留的内存 Map 冷却已移除，避免与"原版绑定玩家标记"冲突。）

      // 5. 找到对应的处理器并执行
      const handler: CommandHandler | undefined = this.handlerMap[cmdDef.handlerKey];
      if (!handler) {
        return {
          success: false,
          content: `指令「${commandName}」的处理器未注册(handlerKey=${cmdDef.handlerKey})`,
          broadcast: false,
          durationMs: Date.now() - start,
        };
      }

      const result = await handler.handle(ctx, args);
      result.durationMs = Date.now() - start;

      // 7. 记录指令执行日志
      await this.recordLog(ctx, commandName, result);

      return result;
    } catch (err: any) {
      this.logger.error(`指令执行出错: ${err.message}`, err.stack);
      return {
        success: false,
        content: `指令执行发生错误：${err.message}`,
        broadcast: false,
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * 记录指令执行日志
   */
  private async recordLog(ctx: CommandContext, command: string, result: CommandResult) {
    try {
      await this.prisma.commandLog.create({
        data: {
          channelId: ctx.channelId,
          senderId: ctx.userId ?? 0,
          command,
          result: result.content,
          durationMs: result.durationMs,
          source: ctx.source,
        },
      });
    } catch (e) {
      this.logger.warn(`指令日志写入失败: ${e.message}`);
    }
  }

  /**
   * 获取所有已注册的可执行指令列表（用于"帮助"指令）
   */
  async listCommands() {
    return this.prisma.command.findMany({
      where: { enabled: true },
      orderBy: { sortOrder: 'asc' },
      select: { name: true, alias: true, description: true, minRole: true },
    });
  }

  /**
   * 判断一段文本是否命中已注册指令（指令名或别名精确匹配）
   * 用于"无强制前缀"模式下，区分指令与普通聊天。
   */
  async matchCommandName(text: string): Promise<boolean> {
    const clean = text.trim().replace(/^[\/！!]+/, '');
    if (!clean) return false;
    // 取第一个单词
    const name = clean.split(/\s+/)[0];
    if (!name) return false;
    const found = await this.prisma.command.findFirst({
      where: {
        enabled: true,
        OR: [
          { name: { equals: name } },
          { alias: { contains: name } },
        ],
      },
      select: { id: true },
    });
    return !!found;
  }
}