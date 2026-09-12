/**
 * 管理员指令域服务（game 模块化重构 P2-2 抽出）
 *
 * 职责：全部管理员指令——状态查看、公告、世界等级、发放物品、玩家列表/封禁/
 * 重置/改档、定时消息、广播，以及 finishNowForUser（跳过延时任务倒计时，
 * 冷却类任务除外）与 interval message 管理。
 * 依赖方向：依赖 AdminService（管理鉴权与后台配置）、Prisma、延时任务服务、
 * 支撑层（formatUptime 时长文本）；不依赖任何指令域子服务。
 * 单一真相源：管理员时长展示统一支撑层 formatUptime（秒→文本 fullUnits 口径）。
 * 对口原版：_主程序.ecode 管理员指令分支。
 */import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AdminService } from '../../admin/admin.service';
import { DelayedTaskService } from '.././delayed-task.service';
import { GameSupportService } from '.././game-support.service';

@Injectable()
export class AdminCommandService {
  private readonly logger = new Logger(AdminCommandService.name);

  constructor(
    private readonly support: GameSupportService,
    private readonly prisma: PrismaService,
    private readonly adminService: AdminService,
    @Optional() private readonly delayedTaskService?: DelayedTaskService,
  ) {}

  async finishNowForUser(userId: number): Promise<{ ok: boolean; completed: number; message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { ok: false, completed: 0, message: '用户不存在' };
    if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
      return { ok: false, completed: 0, message: '权限不足，需要管理员权限（ADMIN 或 SUPER_ADMIN）' };
    }
    if (!this.delayedTaskService) return { ok: false, completed: 0, message: '延时任务服务不可用' };
    const n = await this.delayedTaskService.completeNowForUser(userId);
    return n > 0
      ? { ok: true, completed: n, message: `⚡ 管理员特权：${n} 个进行中的延时操作已立即完成` }
      : { ok: true, completed: 0, message: '当前没有进行中的延时操作' };
  }

  /**
   * 超管特权「立即完成」：把自己身上所有进行中的延时操作（采集/移动/救援/装填/
   * 开采/补魔/货舱/维修等读条）立即结算，跳过剩余倒计时。
   * 实现只提前 DelayedTask.runAt，结算语义完全复用既有 handler 链路；
   * QQ 指令与前端读条按钮共用 finishNowForUser，本方法只做文本呈现。
   */

  async handleAdminFinishNow(userId: number): Promise<string> {
    const result = await this.finishNowForUser(userId);
    return result.message;
  }

  /**
   * GM命令入口
   * 执行管理员GM命令，需要管理员权限
   * @param userId 调用者用户ID
   * @param args 子命令及参数数组
   */

  async handleAdminCommand(userId: number, args: string[]): Promise<string> {
    // 1. 获取调用者用户信息
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return '用户不存在';

    // 2. 检查是否是 ADMIN 角色（ADMIN 或 SUPER_ADMIN）
    if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
      return '权限不足，需要管理员权限（ADMIN 或 SUPER_ADMIN）';
    }

    // 3. 如果没有子命令，显示帮助信息
    if (args.length === 0 || !args[0]) {
      return this.getAdminHelpText();
    }

    const subCmd = args[0];
    const subArgs = args.slice(1);

    try {
      switch (subCmd) {
        case '状态':
        case 'status':
          return await this.handleAdminStatus();

        case '公告':
        case 'announce':
          return await this.handleAdminAnnounce(subArgs);

        case '世界等级':
        case 'world-level':
          return await this.handleAdminSetWorldLevel(subArgs);

        case '完成':
        case 'finish':
          return await this.handleAdminFinishNow(userId);

        case '给物品':
        case 'give-item':
          return await this.handleAdminGiveItem(subArgs);

        case '玩家列表':
        case 'player-list':
          return await this.handleAdminPlayerList(subArgs);

        case '封禁':
        case 'ban':
          return await this.handleAdminToggleBan(subArgs, true);

        case '解封':
        case 'unban':
          return await this.handleAdminToggleBan(subArgs, false);

        case '封禁QQ':
        case 'ban-qq':
          return await this.handleAdminBanByQQ(userId, subArgs);

        case '重置玩家':
        case 'reset-player':
          return await this.handleAdminResetPlayer(userId, subArgs);

        case '修改玩家':
        case 'modify-player':
          return await this.handleAdminModifyPlayer(userId, subArgs);

        case '间隔消息':
        case 'interval-msg':
          return await this.handleAdminIntervalMessage(userId, subArgs);

        case '公告':
        case 'broadcast':
          return await this.handleAdminBroadcast(userId, subArgs);

        case '更新配置':
        case 'update-config':
          return await this.handleAdminUpdateConfig(subArgs);

        case '用户列表':
        case 'user-list':
          return await this.handleAdminUserList(subArgs);

        case '帮助':
        case 'help':
          return this.getAdminHelpText();

        default:
          return `未知GM子命令「${subCmd}」，使用「gm 帮助」查看可用命令`;
      }
    } catch (err: any) {
      this.logger.error(`GM命令执行错误 userId=${userId} cmd=${subCmd}`, err);
      return `GM命令执行错误: ${err.message}`;
    }
  }

  /**
   * 获取GM命令帮助文本
   */

  getAdminHelpText(): string {
    return [
      `📋 GM 管理员命令帮助`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `gm 状态 / admin status - 获取服务器状态`,
      `gm 公告 内容 - 发送系统公告`,
      `gm 世界等级 数字 - 设置世界等级`,
      `gm 给物品 用户ID 物品名 数量 - 给玩家发送物品`,
      `gm 玩家列表 [页码] - 获取玩家列表`,
      `gm 封禁 用户ID - 封禁玩家（按用户ID）`,
      `gm 解封 用户ID - 解封玩家`,
      `gm 封禁QQ QQ号 - 封禁玩家（按QQ号）`,
      `gm 重置玩家 QQ号 - 重置玩家数据到初始状态`,
      `gm 修改玩家 QQ号/用户名/ID 字段名 值 - 修改玩家数据`,
      `gm 间隔消息 内容 次数 间隔秒 - 设置间隔消息`,
      `gm 更新配置 键 值 - 更新系统配置`,
      `gm 用户列表 [关键词] - 搜索用户列表`,
      `gm 帮助 - 显示本帮助`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `别名：gm / 管理 / admin / 管理员`,
    ].join('\n');
  }

  /**
   * 处理服务器状态查询
   */

  async handleAdminStatus(): Promise<string> {
    const status = await this.adminService.getServerStatus();
    const uptimeStr = this.support.formatUptime(status.uptime);
    return [
      `📊 服务器状态`,
      `━━━━━━━━━━━━━━━`,
      `👥 用户总数: ${status.totalUsers}`,
      `🎮 玩家总数: ${status.totalPlayers}`,
      `🟢 在线玩家: ${status.onlinePlayers}`,
      `🗺️ 地图总数: ${status.totalMaps}`,
      `📝 指令总数: ${status.totalCommands}`,
      `⏱️ 运行时长: ${uptimeStr}`,
    ].join('\n');
  }

  /**
   * 处理发送系统公告
   */

  async handleAdminAnnounce(args: string[]): Promise<string> {
    if (args.length === 0) {
      return '请指定公告内容，格式：gm 公告 内容';
    }
    const content = args.join(' ');
    await this.adminService.sendAnnouncement(content);
    return `✅ 系统公告已发送：${content}`;
  }

  /**
   * 处理设置世界等级
   */

  async handleAdminSetWorldLevel(args: string[]): Promise<string> {
    if (args.length === 0) {
      return '请指定世界等级，格式：gm 世界等级 数字';
    }
    const level = parseInt(args[0], 10);
    if (isNaN(level) || level < 1) {
      return '世界等级必须为正整数';
    }
    return await this.adminService.setWorldLevel(level);
  }

  /**
   * 处理GM给物品
   */

  async handleAdminGiveItem(args: string[]): Promise<string> {
    if (args.length < 3) {
      return '请指定目标用户ID、物品名称和数量，格式：gm 给物品 用户ID 物品名 数量';
    }
    const targetUserId = parseInt(args[0], 10);
    if (isNaN(targetUserId)) {
      return '用户ID必须为数字';
    }
    const itemName = args[1];
    const count = parseInt(args[2], 10);
    if (isNaN(count) || count < 1) {
      return '数量必须为正整数';
    }
    return await this.adminService.gmGiveItem(targetUserId, itemName, count);
  }

  /**
   * 处理玩家列表查询
   */

  async handleAdminPlayerList(args: string[]): Promise<string> {
    const page = parseInt(args[0], 10) || 1;
    const pageSize = 20;
    const result = await this.adminService.getPlayersList(page, pageSize);
    const lines = [
      `🎮 玩家列表 (第${page}页，共${result.total}人)`,
      `━━━━━━━━━━━━━━━`,
    ];
    for (const p of result.players) {
      const userInfo = p.user ? `${p.user.nickname || p.user.username}(${p.user.id})` : `ID:${p.userId}`;
      lines.push(`  ${userInfo} | Lv.${p.level || 1} | HP:${Math.round(p.hp || 0)}/${Math.round(p.maxHp || 100)}`);
    }
    if (result.players.length === 0) {
      lines.push(`  暂无玩家数据`);
    }
    lines.push(`━━━━━━━━━━━━━━━`);
    lines.push(`共 ${result.total} 人，当前显示第 ${page} 页`);
    return lines.join('\n');
  }

  /**
   * 处理封禁/解封用户
   * @param args 参数数组，[0]为用户ID
   * @param isBan true=封禁, false=解封
   */

  async handleAdminToggleBan(args: string[], isBan: boolean): Promise<string> {
    if (args.length === 0) {
      const action = isBan ? '封禁' : '解封';
      return `请指定用户ID，格式：gm ${action} 用户ID`;
    }
    const targetUserId = parseInt(args[0], 10);
    if (isNaN(targetUserId)) {
      return '用户ID必须为数字';
    }
    const result = await this.adminService.toggleUserBan(targetUserId);
    // toggleUserBan 会自动切换状态，所以无论封禁/解封都调用同一个方法
    // 返回结果包含操作描述，直接返回即可
    return result;
  }

  /**
   * 处理更新系统配置
   */

  async handleAdminUpdateConfig(args: string[]): Promise<string> {
    if (args.length < 2) {
      return '请指定配置键和值，格式：gm 更新配置 键 值';
    }
    const key = args[0];
    const value = args.slice(1).join(' ');
    return await this.adminService.updateSystemConfig(key, value);
  }

  /**
   * 处理用户列表查询
   */

  async handleAdminUserList(args: string[]): Promise<string> {
    const keyword = args[0] || undefined;
    const page = 1;
    const pageSize = 20;
    const result = await this.adminService.listUsers(page, pageSize, keyword);
    const lines = [
      `👥 用户列表${keyword ? `(关键词: ${keyword})` : ''} (第${page}页，共${result.total}人)`,
      `━━━━━━━━━━━━━━━━━━━━━━`,
    ];
    for (const u of result.list) {
      const roleTag = u.role === 'SUPER_ADMIN' ? '🛡️' : u.role === 'ADMIN' ? '⚔️' : '👤';
      const statusTag = u.status === 'BANNED' ? '🔒' : '';
      lines.push(`  ${roleTag}${statusTag} ${u.nickname || u.username}(${u.id}) 角色:${u.role} ${u.qqNumber ? `QQ:${u.qqNumber}` : ''}`);
    }
    if (result.list.length === 0) {
      lines.push(`  暂无匹配的用户`);
    }
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`共 ${result.total} 人，当前显示第 ${page} 页`);
    return lines.join('\n');
  }

  /**
   * 处理按QQ号封禁玩家
   * @param userId 操作者用户ID
   * @param args 参数列表
   */

  async handleAdminBanByQQ(userId: number, args: string[]): Promise<string> {
    if (args.length === 0) {
      return '请指定目标QQ号，格式：gm 封禁QQ QQ号';
    }
    const targetQQ = args[0];
    return await this.adminService.banPlayer(userId, targetQQ);
  }

  /**
   * 处理重置玩家数据
   * @param userId 操作者用户ID
   * @param args 参数列表
   */

  async handleAdminResetPlayer(userId: number, args: string[]): Promise<string> {
    if (args.length === 0) {
      return '请指定目标QQ号，格式：gm 重置玩家 QQ号';
    }
    const targetQQ = args[0];
    return await this.adminService.resetPlayer(userId, targetQQ);
  }

  /**
   * 处理修改玩家数据
   * @param userId 操作者用户ID
   * @param args 参数列表
   */

  async handleAdminModifyPlayer(userId: number, args: string[]): Promise<string> {
    if (args.length < 3) {
      return '请指定目标(QQ号/用户名/ID)、字段名和值，格式：gm 修改玩家 目标 字段名 值';
    }
    const targetQQ = args[0];
    const field = args[1];
    const value = args.slice(2).join(' ');
    return await this.adminService.modifyPlayer(userId, targetQQ, field, value);
  }

  /**
   * 处理设置间隔消息
   * @param userId 操作者用户ID
   * @param args 参数列表
   */

  async handleAdminIntervalMessage(userId: number, args: string[]): Promise<string> {
    if (args.length < 3) {
      return '请指定消息内容、次数和间隔时间，格式：gm 间隔消息 内容 次数 间隔秒';
    }
    // 内容可能包含空格，通过次数和间隔时间位置来分割
    const countIdx = args.length - 2;
    const intervalIdx = args.length - 1;
    const count = parseInt(args[countIdx], 10);
    const interval = parseInt(args[intervalIdx], 10);
    const content = args.slice(0, countIdx).join(' ');

    if (isNaN(count) || count < 1) {
      return '次数必须为正整数';
    }
    if (isNaN(interval) || interval < 1) {
      return '间隔时间必须为正整数（秒）';
    }

    return await this.adminService.setIntervalMessage(userId, content, interval, count);
  }

  /**
   * 处理发送全服公告
   * @param userId 操作者用户ID
   * @param args 参数列表
   */

  async handleAdminBroadcast(userId: number, args: string[]): Promise<string> {
    if (args.length === 0) {
      return '请指定公告内容，格式：gm 公告 内容';
    }
    const message = args.join(' ');
    return await this.adminService.broadcast(userId, message);
  }

  /**
   * 格式化运行时长（秒 → 可读文本）
   */
}
