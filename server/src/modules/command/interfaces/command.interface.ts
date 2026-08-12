/**
 * 指令引擎 - 类型定义
 * 定义指令处理的统一上下文结构，屏蔽"来自网页 / 来自AstrBot机器人 / 来自API"的差异。
 */

/// 指令来源类型
export enum CommandSource {
  WEB = 'web', // 网页公屏
  ASTRBOT = 'astrbot', // AstrBot 机器人
  API = 'api', // 外部 HTTP API
}

/**
 * 指令处理上下文
 * 包含执行一条指令所需的全部信息：谁发的、在哪个频道、原文、来源。
 */
export interface CommandContext {
  /** 发送者用户ID（网页用户） */
  userId?: number;
  /** 发送者用户名 */
  username?: string;
  /** 机器人身份标识（来自AstrBot时可能是QQ号） */
  botIdentity?: string;
  /** 频道ID（网页公屏频道） */
  channelId: number;
  /** 频道名 */
  channelName?: string;
  /** 原始指令文本 */
  rawMessage: string;
  /** 指令来源 */
  source: CommandSource;
}

/**
 * 指令处理结果
 * 统一返回结构，由调用方决定广播到公屏还是回传给机器人。
 */
export interface CommandResult {
  /** 是否成功执行 */
  success: boolean;
  /** 要广播/回传的文本内容 */
  content: string;
  /** 是否对所有人公屏可见（若为 false 仅回传给发送者） */
  broadcast: boolean;
  /** 执行耗时(ms) */
  durationMs: number;
}

/**
 * 指令处理器接口
 * 每个具体指令(如"背包""移动""战斗")实现该接口。
 */
export interface CommandHandler {
  /** 处理器键名，与数据库 Command.handlerKey 对应 */
  key: string;
  /** 所属模块分类（如 basic / game），用于 help 指令分组展示 */
  module: string;
  /**
   * 执行指令
   * @param ctx 指令上下文
   * @param args 解析后的参数列表
   */
  handle(ctx: CommandContext, args: string[]): Promise<CommandResult> | CommandResult;
}
