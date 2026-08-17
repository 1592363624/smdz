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
import { GameService } from '../game/game.service';
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
    private readonly gameService: GameService,
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

      // 1.5 新玩家选使魔门禁（统一层，覆盖 网页/AstrBot/API 所有渠道）
      //     对应原版 _主程序.ecode L798：非老玩家(未选使魔)发任何指令都被拦截，
      //     仅"选择使魔/更换使魔"放行，否则返回"选择第一个使魔"菜单。
      if (ctx.userId) {
        const gateAllowed = ['选择使魔', '更换使魔', 'select', 'familiar'].some(
          (allowed) => commandName === allowed || (commandName.length > allowed.length && commandName.startsWith(allowed)),
        );
        if (!gateAllowed) {
          const gate = await this.gameService.getFirstFamiliarGate(ctx.userId);
          if (gate) {
            return {
              success: false,
              content: gate,
              broadcast: false,
              durationMs: Date.now() - start,
            };
          }
        }
      }

      if (!commandName) {
        return {
          success: false,
          content: '请输入指令，输入"帮助"查看可用指令',
          broadcast: false,
          durationMs: Date.now() - start,
        };
      }

      // 2. 从数据库指令表查找指令定义
      //    匹配顺序对齐原版"前缀路由"语义（原版无独立指令表，是字符前缀截取）：
      //    a. name 完全相等（最精确）
      //    b. alias 逗号拆分后词精确匹配（禁止子串 contains，避免 `查看` 误命中 alias 含 `查看背包` 的 `背包`）
      //    c. 前缀匹配回退（对应原版"两字/三字/四字命令"前缀路由，如 `选择使魔伊卡洛斯`）
      let cmdDef = await this.prisma.command.findFirst({
        where: { enabled: true, name: { equals: commandName } },
      });

      if (!cmdDef) {
        // 加载全部指令在内存中做 alias 精确 + 前缀匹配（指令表很小，失败时多一次查询可接受）
        const allCmds = await this.prisma.command.findMany({
          where: { enabled: true },
          select: { name: true, alias: true },
        });

        // 2.1 alias 词精确匹配（逗号拆分后完全相等）
        const exactAlias = allCmds.find((c) =>
          (c.alias || '')
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
            .includes(commandName),
        );
        if (exactAlias) {
          cmdDef = await this.prisma.command.findFirst({
            where: { name: { equals: exactAlias.name }, enabled: true },
          });
          // 改写 rawMessage 为标准指令名 + 参数，让 handler 用标准名路由
          // （否则 handler switch 收到的是玩家原词如 `claim-land`，无法命中 `case '圈地'`）
          ctx.rawMessage = args.length ? `${exactAlias.name} ${args.join(' ')}` : exactAlias.name;
        }

        // 2.2 前缀匹配回退（对应原版前缀路由语义）
        //     玩家无空格输入如 `选择使魔伊卡洛斯` 时，首词是整个字符串，精确匹配会失败。
        //     若存在某指令名/别名是该输入的前缀，则匹配该指令，并把剩余部分作为参数。
        if (!cmdDef) {
          // 展开候选：指令名 + 各别名，均作为"前缀候选"（带来源指令名）
          const candidates: { key: string; name: string }[] = [];
          for (const c of allCmds) {
            candidates.push({ key: c.name, name: c.name });
            for (const alias of (c.alias || '').split(',').map((s: string) => s.trim()).filter(Boolean)) {
              candidates.push({ key: alias, name: c.name });
            }
          }
          // 按前缀长度降序，优先匹配更长（更精确）的前缀
          const prefixMatch = candidates
            .filter((c) => commandName.length > c.key.length && commandName.startsWith(c.key))
            .sort((a, b) => b.key.length - a.key.length)[0];
          if (prefixMatch) {
            cmdDef = await this.prisma.command.findFirst({
              where: { name: { equals: prefixMatch.name }, enabled: true },
            });
            // 把剩余部分作为第一个参数（如 `选择使魔伊卡洛斯` → 指令`选择使魔` + 参数`伊卡洛斯`）
            const remain = commandName.substring(prefixMatch.key.length).trim();
            if (remain) {
              args.unshift(remain);
            }
            // 同步改写 rawMessage 为标准指令名 + 参数（用 cmdDef.name 而非 prefixMatch.key，
            // 因为 key 可能是别名，handler 的 switch 只认标准中文指令名）
            if (cmdDef) {
              ctx.rawMessage = args.length ? `${cmdDef.name} ${args.join(' ')}` : cmdDef.name;
            }
          }
        }
      }

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
    // 1) name 精确匹配
    const found = await this.prisma.command.findFirst({
      where: { enabled: true, name: { equals: name } },
      select: { id: true },
    });
    if (found) return true;

    // 2) alias 词精确匹配（逗号拆分后完全相等，避免子串误匹配）
    //    与 dispatch 保持一致：禁止 contains 子串匹配
    const allCmds = await this.prisma.command.findMany({
      where: { enabled: true },
      select: { name: true, alias: true },
    });
    const aliasExact = allCmds.some((c: any) =>
      (c.alias || '')
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean)
        .includes(name),
    );
    if (aliasExact) return true;

    // 3) 前缀匹配回退：无空格输入（如 `选择使魔伊卡洛斯`）时，检查是否以某指令名/别名为前缀
    //    对应原版"两字/三字/四字命令"的前缀路由语义，与 dispatch 的前缀回退保持一致
    return allCmds.some((c: any) => {
      if (name.length > c.name.length && name.startsWith(c.name)) return true;
      return (c.alias || '').split(',').map((s: string) => s.trim()).filter(Boolean)
        .some((alias: string) => name.length > alias.length && name.startsWith(alias));
    });
  }
}