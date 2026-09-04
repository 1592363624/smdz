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

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GameService } from '../game/game.service';
import { PlayerService } from '../game/player.service';
import { PlayerMutateService } from '../game/player-mutate.service';
import { TaskService } from '../game/task.service';
import {
  CommandContext,
  CommandHandler,
  CommandResult,
  CommandSource,
} from './interfaces/command.interface';
import { COMMAND_HANDLER_MAP } from './command-handler-map.provider';
import { normalizeGameText } from '../../common/utils/game-text.util';
import { buildTutorialClaimBlock } from '../game/familiar-menu.util';

@Injectable()
export class CommandService {
  private readonly logger = new Logger(CommandService.name);

  /**
   * 指令表内存缓存（5s TTL）。
   * 指令表极小且几乎不变，但一条消息的链路里 dispatch + matchCommandName（网关指令判定）
   * 会对它打 3~5 次库；远程库下这些往返直接叠加到玩家回复延迟。TTL 到期自然刷新，
   * 管理端改动最迟 5 秒生效。
   */
  private static readonly CMD_CACHE_TTL_MS = 5000;
  private cmdCache: { rows: Array<Record<string, any>>; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(COMMAND_HANDLER_MAP)
    private readonly handlerMap: Record<string, CommandHandler>,
    private readonly gameService: GameService,
    private readonly playerService: PlayerService,
    @Optional() private readonly taskService?: TaskService,
    // 玩家状态收口入口（Actor 式写入口）：把整条指令（含其下所有服务的读改写）
    // 在锁内复用唯一快照、统一落库。@Optional 兼容手工构造的测试桩（未注入时
    // 退化为指令直接执行，走各服务自身的 enqueueUserWrite 旧路径，行为不变）。
    @Optional() private readonly playerMutate?: PlayerMutateService,
  ) {}

  /**
   * 纯展示类只读指令：结果不改变玩家任何状态。
   * 跳过指令收尾的"仪式段"（纯白之翼自动技能/每日登录结算/状态推送），
   * 这些段每条都要额外打几次库——远程库下直接叠加到回复延迟。
   * 副作用（如登录奖励、自动技能充能）顺延到下一条非只读指令结算，游戏语义不变。
   */
  private static readonly READ_ONLY_COMMANDS = new Set(['帮助', '查看任务', '我的任务']);

  /**
   * 已启用指令全量行（带 TTL 缓存）。
   * dispatch 的 name 精确/alias 精确/前缀回退三级匹配全部改为在内存中完成，
   * 不再每次打库。
   */
  private async getEnabledCommands(): Promise<Array<Record<string, any>>> {
    const now = Date.now();
    if (this.cmdCache && now - this.cmdCache.at < CommandService.CMD_CACHE_TTL_MS) {
      return this.cmdCache.rows;
    }
    const rows = await this.prisma.command.findMany({ where: { enabled: true } });
    this.cmdCache = { rows, at: now };
    return rows;
  }

  /**
   * 指令分发总入口
   * 所有来源(网页/机器人/API)的指令都汇聚到这里。
   * 统一出口：将结果文本中的 "#换行" 标记(原版 #换行符)替换为真实换行，
   * 避免玩家在网页/QQ 看到字面标记。
   */
  async dispatch(ctx: CommandContext): Promise<CommandResult> {
    const result = await this.executeDispatch(ctx);
    if (result?.content) {
      result.content = normalizeGameText(result.content);
    }
    return result;
  }

  private async executeDispatch(ctx: CommandContext): Promise<CommandResult> {
    const start = Date.now();
    try {
      // 1. 解析指令名：取第一个空格前的单词作为指令名
      //    兼容 /指令、！指令、! 指令 以及无前缀的直接输入
      const rawTrimmed = ctx.rawMessage.trim();
      const sentText = rawTrimmed.replace(/^[\/！!]+/, '').trim();
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

      // 1.6 开箱锁门禁（对应原版 _主程序.ecode L117-118）：
      //     打开箱子处理期间「开箱」标记未过期 → 拦截一切其他指令。
      //     原版语义：开箱是同步动作、锁只是防重复提交，正常情况下玩家感知不到；
      //     只有处理卡顿/并发连发时才会看到“正在开箱子，或者等待X”。
      //     防御式调用：部分测试/轻量环境的 GameService 桩未实现该方法。
      if (ctx.userId && typeof (this.gameService as any).getOpenBoxLockText === 'function') {
        const openBoxLock = await this.gameService.getOpenBoxLockText(ctx.userId);
        if (openBoxLock) {
          return {
            success: false,
            content: openBoxLock,
            broadcast: false,
            durationMs: Date.now() - start,
          };
        }
      }

      // 1.7 教程任务领取（原版 _主程序.ecode L11686-11706 每条消息结算段）：
      //     教程标记不足时补发任务，本次实际领取到的任务名转成“领取了X”提示，
      //     前插到指令结果之前（原版按领取顺序逐条前插，最终进阶在上、新手在下）。
      let tutorialClaims = '';
      if (ctx.userId && this.taskService) {
        try {
          const added = await this.taskService.ensureTutorialTasks(ctx.userId);
          tutorialClaims = buildTutorialClaimBlock(added || []);
        } catch (e: any) {
          this.logger.warn(`教程任务领取失败: ${e.message}`);
        }
      }

      // 2. 从指令表（内存缓存）匹配指令定义
      //    匹配顺序对齐原版"前缀路由"语义（原版无独立指令表，是字符前缀截取）：
      //    a. name 完全相等（最精确）
      //    b. alias 逗号拆分后词精确匹配（禁止子串 contains，避免 `查看` 误命中 alias 含 `查看背包` 的 `背包`）
      //    c. 前缀匹配回退（对应原版"两字/三字/四字命令"前缀路由，如 `选择使魔伊卡洛斯`）
      const allCmds = await this.getEnabledCommands();
      let cmdDef = allCmds.find((c) => c.name === commandName) || null;

      if (!cmdDef) {
        // 2.1 alias 词精确匹配（逗号拆分后完全相等）
        const exactAlias = allCmds.find((c) =>
          (c.alias || '')
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
            .includes(commandName),
        );
        if (exactAlias) {
          cmdDef = allCmds.find((c) => c.name === exactAlias.name) || null;
          // 改写 rawMessage 为标准指令名 + 参数，让 handler 用标准名路由
          // （否则 handler switch 收到的是玩家原词如 `claim-land`，无法命中 `case '圈地'`）
          ctx.rawMessage = args.length ? `${exactAlias.name} ${args.join(' ')}` : exactAlias.name;
        }

        // 2.2 地图资源采集指令精确匹配（对齐原版 _主程序.ecode 默认兜底分支 L11351-11370）
        //     原版语义：指令表(两字/四字命令前缀)未命中后，落到"采集"默认分支，
        //     用消息全文精确匹配当前地图资源的"采集指令"(gatherCmd，如 打开箱子/收集木头/捡垃圾)。
        //     必须在"命令前缀回退"之前判定：否则 `打开箱子` 会被攻击指令的单字别名 `打` 前缀吞掉，
        //     导致采集被误判为攻击（=原版不会发生的错误）。
        if (!cmdDef && ctx.userId) {
          const isGather = await this.gameService.hasGatherCmd(ctx.userId, commandName);
          if (isGather) {
            // 命中地图采集指令 → 直接交由采集兜底处理器处理，不再做指令表前缀匹配
            const gatherHandler: CommandHandler | undefined = this.handlerMap['gather'];
            if (gatherHandler) {
              try {
                const gatherResult = await gatherHandler.handle(ctx, [commandName]);
                // 已命中当前地图采集指令时，即使动作因冷却/状态限制失败，也要
                // 返回处理器的原始提示；否则会被错误降级成“未知指令”。
                if (gatherResult) {
                  await this.finishCommandTasks(ctx, sentText, gatherResult);
                  gatherResult.durationMs = Date.now() - start;
                  await this.recordLog(ctx, commandName, gatherResult);
                  if (gatherResult.success) {
                    // 采集成功会改变玩家/地图状态，实时推送刷新网页面板
                    await this.pushState(ctx.userId);
                  }
                  return gatherResult;
                }
              } catch (e) {
                // 采集兜底失败时忽略，继续走指令表前缀匹配/未知指令提示
                this.logger.warn(`采集指令兜底失败: ${e.message}`);
              }
            }
          }
        }

        // 2.3 前缀匹配回退（对应原版前缀路由语义）
        //     玩家无空格输入如 `选择使魔伊卡洛斯` 时，首词是整个字符串，精确匹配会失败。
        //     若存在某指令名/别名是该输入的前缀，则匹配该指令，并把剩余部分作为参数。
        //     注意：仅跳过单字别名（如攻击别名 `打`），避免把 `打开箱子` 等采集指令误吞进攻击；
        //     单字别名仍需通过 name/alias 精确匹配（输入 `打` 或 `攻击`）正常触发。
        if (!cmdDef) {
          // 展开候选：指令名 + 各别名，均作为"前缀候选"（带来源指令名）
          const candidates: { key: string; name: string }[] = [];
          for (const c of allCmds) {
            candidates.push({ key: c.name, name: c.name });
            for (const alias of (c.alias || '').split(',').map((s: string) => s.trim()).filter(Boolean)) {
              candidates.push({ key: alias, name: c.name });
            }
          }
          // 按前缀长度降序，优先匹配更长（更精确）的前缀；跳过单字候选避免误吞采集指令
          const prefixMatch = candidates
            .filter((c) => c.key.length >= 2 && commandName.length > c.key.length && commandName.startsWith(c.key))
            .sort((a, b) => b.key.length - a.key.length)[0];
          if (prefixMatch) {
            cmdDef = allCmds.find((c) => c.name === prefixMatch.name) || null;
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
              await this.finishCommandTasks(ctx, sentText, gatherResult);
              gatherResult.durationMs = Date.now() - start;
              await this.recordLog(ctx, commandName, gatherResult);
              // 采集成功会改变玩家/地图状态，实时推送刷新网页面板
              await this.pushState(ctx.userId);
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
      const readOnly = CommandService.READ_ONLY_COMMANDS.has(cmdDef.name);
      if (!handler) {
        return {
          success: false,
          content: `指令「${commandName}」的处理器未注册(handlerKey=${cmdDef.handlerKey})`,
          broadcast: false,
          durationMs: Date.now() - start,
        };
      }

      // 5.1 行动前离线时间补偿（对应原版 _计算玩家 基于时间差的回复结算 L2383-2408）
      //     玩家距上次操作超过10秒时，按回复率自动回血/回盾/回甲；结果拼入回复文本。
      let offlineRegen = '';
      if (ctx.userId) {
        try {
          offlineRegen = await this.gameService.calculateTimeElapsed(ctx.userId);
        } catch (e: any) {
          this.logger.warn(`离线补偿失败: ${e.message}`);
        }
      }

      // 单玩家写入口收口：整条指令（含 GameService / 战斗 / 使魔 / 兑换等所有
      // 服务的读改写）在 Actor 式 mutate 内串行执行、复用唯一快照。这从基础设施层
      // 彻底消除"旧快照整包覆盖 / CAS 并发冲突（玩家数据并发冲突，请重试）"类事故——
      // 历史上反复的快照覆盖 bug 根因就是子流程自行重读档并落库，令外层快照过期。
      let result: CommandResult;
      if (ctx.userId && this.playerMutate) {
        result = await this.playerMutate.mutate(ctx.userId, async () => handler.handle(ctx, args));
      } else {
        result = await handler.handle(ctx, args);
      }
      result.durationMs = Date.now() - start;

      // 原版 _主程序.ecode L11462：玩家指令结束后触发纯白之翼自动技能。
      // 自动技能复用 FamiliarSkillsService 的正式入口，结果并入本次指令文本。
      // 只读指令不触发（无状态变化，技能顺延到下一条动作指令）。
      if (ctx.userId && !readOnly) {
        try {
          const autoSkillText = await this.gameService.triggerAutoFamiliarSkill(ctx.userId);
          if (autoSkillText) {
            result.content = result.content
              ? `${result.content}\n${autoSkillText}`
              : autoSkillText;
          }
        } catch (e: any) {
          this.logger.warn(`纯白之翼自动技能失败: ${e.message}`);
        }
      }

      // 5.2 若离线有回复，拼在指令结果之前（如 "生命回复 +12\n<指令结果>"）
      if (offlineRegen && result.content) {
        result.content = `${offlineRegen}\n━━━━━━━━━━━━━━━\n${result.content}`;
      }

      // 5.25 每日登录结算 + 教程领取提示（原版 _主程序.ecode L11686-11821 每条消息
      //      结算段的对位实现）。前插为“后执行者在顶部”，因此执行顺序：
      //      教程领取提示 → 登录奖励块，最终视觉顺序为 [登录奖励][领取提示][离线回复][指令正文]，
      //      与原版 w = 登录奖励 + 领取提示 + 指令输出 的拼接顺序一致。
      if (ctx.userId) {
        if (tutorialClaims) {
          result.content = `${tutorialClaims}${result.content || ''}`;
        }
        try {
          const loginBlock = readOnly ? '' : await this.gameService.settleDailyLogin(ctx.userId);
          if (loginBlock) {
            result.content = `${loginBlock}${result.content || ''}`;
          }
        } catch (e: any) {
          this.logger.warn(`每日登录结算失败: ${e.message}`);
        }
      }

      // 5.28 功能提示（原版 _主程序.ecode L11546-11564：训练器/凭证 每600秒提示），
      //      追加在指令正文之后、升级通知之前（原版提示段先于升级判定执行）。
      if (ctx.userId) {
        try {
          const hints = await this.gameService.getActionHints(ctx.userId);
          if (hints) {
            result.content = result.content ? `${result.content}${hints}` : hints;
          }
        } catch (e: any) {
          this.logger.warn(`功能提示生成失败: ${e.message}`);
        }
      }

      // 5.3 升级通知排水（原版 _主程序.ecode L12038-12046 指令收尾「判断玩家执行
      // 这次操作后是否升级了」的对位实现）：savePlayer 归一化在任意直写经验路径上
      // 触发的升级都会进入 PlayerService 通知队列，这里统一取出拼到结果末尾。
      if (ctx.userId && result.success) {
        const levelUpText = this.playerService?.takePendingLevelUpText(ctx.userId) || '';
        if (levelUpText) {
          result.content = result.content ? `${result.content}\n${levelUpText}` : levelUpText;
        }
      }

      // 任务结算必须与指令主链路共用同一份权威态。
      //
      // 此前 finishCommandTasks 在 mutate 之外执行，taskService.advance 会走
      // prisma.findUnique 重新读档：一旦本条指令内已有其它落库点（典型如开箱链路上
      // distributeLoot → addAchievement 触发的成就写入），库内就会先出现一个「加锁后、
      // 装备入包前」的中间态，advance 随后用这份旧档发奖，再经 saveTaskState 把
      // backpack 整列回写（白名单含 'backpack'），把指令后半段的产出（装备入包、
      // 数量扣减、使用计数、开箱锁解除）整体抹掉——表现为「回复说得到了装备，背包里
      // 却没有、数量也没扣」。该故障只在「同一条指令同时完成任务」时出现，故间歇复发。
      //
      // 包进同一个 mutate 后：advance 直接复用 ctx.player（权威态）读改写，且因
      // ctx 存在而跳过 saveTaskState 的整列回写，最终由 mutate 统一落库最终态。
      if (ctx.userId && this.playerMutate) {
        await this.playerMutate.mutate(ctx.userId, async () => {
          await this.finishCommandTasks(ctx, sentText, result);
        });
      } else {
        await this.finishCommandTasks(ctx, sentText, result);
      }

      // 7. 记录指令执行日志
      await this.recordLog(ctx, commandName, result);

      // 7.1 指令执行后实时推送玩家/地图状态到前端 socket（打怪掉血/加经验/升级/装备/移动采集等变化即时体现在网页面板）
      //     只读指令没有状态变化，跳过推送（省 player+map 两组读写）
      if (!readOnly) {
        await this.pushState(ctx.userId);
      }

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

  private async finishCommandTasks(
    ctx: CommandContext,
    sentText: string,
    result: CommandResult,
  ): Promise<void> {
    if (!ctx.userId || !this.taskService) return;
    if (result.success && sentText) {
      await this.taskService.advance(ctx.userId, '发送“' + sentText + '”');
      await this.taskService.advance(ctx.userId, '发送指令');
    }
    const taskNotice = this.taskService.consumeNotifications(ctx.userId);
    if (taskNotice) {
      // 对齐原版 _主程序.ecode L11960-11972：完成块前插到指令输出之前
      // （w = “完成了任务:…” + “————————” + w）。
      result.content = result.content
        ? `${taskNotice}\n————————\n${result.content}`
        : taskNotice;
    }
  }

  /**
   * 指令执行成功后，向该用户前端做一次全量状态推送
   * 同时刷新玩家面板(player:update) 和 地图面板+附近玩家(map:update)，
   * 使打怪/采集/移动等产生的数值变化立即体现在网页上，无需手动刷新。
   * @param userId 用户ID
   */
  private async pushState(userId?: number): Promise<void> {
    if (!userId) return;
    try {
      await this.gameService.pushPlayerUpdate(userId);
      await this.gameService.pushMapUpdate(userId);
    } catch (e: any) {
      this.logger.warn(`指令后推送玩家状态失败: ${e.message}`);
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
    const rows = await this.getEnabledCommands();
    return rows
      .slice()
      .sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((c: any) => ({
        name: c.name,
        alias: c.alias,
        description: c.description,
        minRole: c.minRole,
      }));
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
    const allCmds = await this.getEnabledCommands();

    // 1) name 精确匹配
    if (allCmds.some((c) => c.name === name)) return true;

    // 2) alias 词精确匹配（逗号拆分后完全相等，避免子串误匹配）
    //    与 dispatch 保持一致：禁止 contains 子串匹配
    const aliasExact = allCmds.some((c: any) =>
      (c.alias || '')
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean)
        .includes(name),
    );
    if (aliasExact) return true;

    // 3) 前缀匹配回退：无空格输入（如 `选择使魔伊卡洛斯`）时，检查是否以某指令名/别名为前缀
    //    对应原版"两字/三字/四字命令"的前缀路由语义，与 dispatch 的前缀回退保持一致。
    //    跳过单字候选（如攻击别名`打`），避免把 `打开箱子` 等地图采集指令误判为攻击指令。
    return allCmds.some((c: any) => {
      if (c.name.length >= 2 && name.length > c.name.length && name.startsWith(c.name)) return true;
      return (c.alias || '').split(',').map((s: string) => s.trim()).filter(Boolean)
        .some((alias: string) => alias.length >= 2 && name.length > alias.length && name.startsWith(alias));
    });
  }
}
