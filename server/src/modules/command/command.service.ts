/**
 * 指令引擎服务 - 核心分发器
 * 对应原版易语言"处理群/处理私聊"函数，但做成了统一、可配置、多来源的引擎。
 *
 * 设计要点：
 * - 指令注册表存数据库(Command表)，新增/修改指令不用改代码重编译
 * - 每个具体逻辑通过 CommandHandler 注册，key 与数据库 handlerKey 对应
 * - 支持多种来源(网页/AstrBot/API)统一进入 dispatch
 * - 内置冷却机制，通过 SystemConfig 可在线调整冷却时间
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemConfigService } from '../system-config/system-config.service';
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

  /** 冷却映射表：userId -> (handlerKey -> 冷却结束时间戳) */
  private cooldowns: Map<number, Map<string, number>> = new Map();

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
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

      // 4. 冷却检查
      //    攻击指令默认5秒冷却，其他指令默认2秒冷却
      const isAttack = cmdDef.handlerKey === 'attack';
      // 从 SystemConfig 读取冷却配置，攻击指令用 game.attackCooldownSeconds，其他用 game.cooldownSeconds
      const cooldownKey = isAttack ? 'game.attackCooldownSeconds' : 'game.cooldownSeconds';
      const defaultCooldown = isAttack ? 5 : 2;
      const cooldownSeconds = await this.systemConfig.get<number>(cooldownKey, defaultCooldown);

      if (ctx.userId) {
        if (this.checkCooldown(ctx.userId, cmdDef.handlerKey, cooldownSeconds)) {
          const remaining = this.getCooldownRemaining(ctx.userId, cmdDef.handlerKey);
          return {
            success: false,
            content: `指令冷却中，请等待 ${Math.ceil(remaining)} 秒`,
            broadcast: false,
            durationMs: Date.now() - start,
          };
        }
      }

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

      // 6. 执行成功后设置冷却
      if (ctx.userId && result.success) {
        this.setCooldown(ctx.userId, cmdDef.handlerKey, cooldownSeconds);
      }

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
   * 检查指令是否处于冷却中
   * @param userId 用户ID
   * @param commandKey 指令handlerKey
   * @param cooldownSeconds 冷却秒数
   * @returns true=仍在冷却中
   */
  private checkCooldown(userId: number, commandKey: string, cooldownSeconds: number): boolean {
    if (cooldownSeconds <= 0) return false;
    const userCooldowns = this.cooldowns.get(userId);
    if (!userCooldowns) return false;
    const expiry = userCooldowns.get(commandKey);
    if (!expiry) return false;
    // 如果冷却已过期，清理并返回false
    if (Date.now() >= expiry) {
      userCooldowns.delete(commandKey);
      if (userCooldowns.size === 0) {
        this.cooldowns.delete(userId);
      }
      return false;
    }
    return true;
  }

  /**
   * 获取冷却剩余秒数
   */
  private getCooldownRemaining(userId: number, commandKey: string): number {
    const userCooldowns = this.cooldowns.get(userId);
    if (!userCooldowns) return 0;
    const expiry = userCooldowns.get(commandKey);
    if (!expiry) return 0;
    return Math.max(0, (expiry - Date.now()) / 1000);
  }

  /**
   * 设置指令冷却
   * @param userId 用户ID
   * @param commandKey 指令handlerKey
   * @param cooldownSeconds 冷却秒数（由 dispatch 从 SystemConfig 读取）
   */
  private setCooldown(userId: number, commandKey: string, cooldownSeconds: number): void {
    if (cooldownSeconds <= 0) return;
    if (!this.cooldowns.has(userId)) {
      this.cooldowns.set(userId, new Map());
    }
    const userCooldowns = this.cooldowns.get(userId)!;
    const expiry = Date.now() + cooldownSeconds * 1000;
    userCooldowns.set(commandKey, expiry);
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