/**
 * 用户服务
 * 封装用户账号的查询、QQ绑定、昵称修改、玩家档案创建等数据访问逻辑。
 * 注：登录仅通过 QQ 互联完成，不再提供用户名+密码的自注册/自登录。
 */

import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { asJsonValue } from '../../common/utils/json-value.util';

/// 常用指令项：cmd 为实际发送内容（可为任意文本，不一定是指令），label 为面板展示文字（缺省等于 cmd）
export interface FavoriteCommand {
  cmd: string;
  label: string;
}

/// 将任意常用指令元素归一化为 FavoriteCommand（兼容字符串与对象两种写法）
function normalizeFavoriteItem(item: unknown): FavoriteCommand | null {
  if (typeof item === 'string') {
    const cmd = item.trim();
    return cmd ? { cmd, label: cmd } : null;
  }
  if (item && typeof item === 'object') {
    const obj = item as Record<string, unknown>;
    const cmd = typeof obj.cmd === 'string' ? obj.cmd.trim() : '';
    if (!cmd) return null;
    const label = typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim() : cmd;
    return { cmd, label };
  }
  return null;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 按ID查询公开信息
   */
  findById(id: number) {
    return this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        nickname: true,
        role: true,
        qqNumber: true,
        externalId: true,
        avatar: true,
        createdAt: true,
      },
    });
  }

  /**
   * 绑定 QQ 号到当前用户（网页端手动绑定）
   * 兼容旧版绑定：若用户当前 qqNumber 存的是旧版 openid（非5-12位纯数字），
   * 换绑真实QQ号时先把 openid 迁移到 externalId，避免后续 QQ 登录识别不到原账号。
   */
  async bindQQ(userId: number, qqNumber: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    // 旧版绑定检测：qqNumber 非 5-12 位纯数字视为 openid
    const isLegacy = !!user.qqNumber && !/^\d{5,12}$/.test(user.qqNumber);
    // 待写入的 externalId：保留已有值；旧版绑定且无 externalId 时迁移旧 openid
    const externalId = user.externalId || (isLegacy ? user.qqNumber : null);

    // QQ 号唯一性检查
    const exists = await this.prisma.user.findUnique({ where: { qqNumber } });
    if (exists && exists.id !== userId) {
      throw new ConflictException('该QQ号已被其他账号绑定');
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        qqNumber,
        ...(externalId ? { externalId } : {}),
      },
      select: { id: true, username: true, nickname: true, qqNumber: true, externalId: true },
    });
  }

  /**
   * 通过插件绑定 QQ 号（QQ 端绑定）
   * 由 AstrBot 插件在 QQ 群中调用：用户发送"使魔大战绑定QQ <openid>"，
   * 插件从消息事件中获取发送者真实QQ号，将 (externalId=openid, qqNumber=发送者QQ) 提交到本接口。
   * 由于 QQ 号来自 AstrBot 事件本身，避免了用户手动填写他人 QQ 号的安全风险。
   *
   * @param externalId 用户在网页端复制的 OpenID（QQ 互联 openid）
   * @param qqNumber 消息来源 QQ 号（5-12位纯数字）
   */
  async bindQQByExternalId(externalId: string, qqNumber: string) {
    if (!externalId) {
      throw new NotFoundException('OpenID 不能为空');
    }
    if (!/^\d{5,12}$/.test(qqNumber)) {
      throw new ConflictException('QQ号格式不正确');
    }

    const user = await this.prisma.user.findUnique({ where: { externalId } });
    if (!user) {
      throw new NotFoundException('未找到该 OpenID 对应的账号，请确认已用 QQ 登录网页版并复制了正确的 OpenID');
    }

    // 该 QQ 号已被其他账号绑定 → 拒绝
    const exists = await this.prisma.user.findUnique({ where: { qqNumber } });
    if (exists && exists.id !== user.id) {
      throw new ConflictException('该QQ号已被其他账号绑定');
    }

    // 兼容旧版：原 qqNumber 是 openid 时迁移到 externalId（保留已有 externalId）
    const isLegacy = !!user.qqNumber && !/^\d{5,12}$/.test(user.qqNumber);
    const migratedExternalId = user.externalId || (isLegacy ? user.qqNumber : null);

    return this.prisma.user.update({
      where: { id: user.id },
      data: {
        qqNumber,
        ...(migratedExternalId ? { externalId: migratedExternalId } : {}),
      },
      select: { id: true, username: true, nickname: true, qqNumber: true, externalId: true },
    });
  }

  /**
   * 获取或创建玩家档案（登录/首次进入游戏时调用）
   */
  async ensurePlayer(userId: number) {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (player) return player;
    return this.prisma.player.create({ data: { userId } });
  }

  /**
   * 校验昵称全局唯一（排除指定用户）
   * 空昵称视为未设置，不参与唯一性校验（数据库默认 '' 允许多人未设置）
   */
  private async assertNicknameUnique(nickname: string, excludeUserId?: number): Promise<void> {
    const conflict = await this.prisma.user.findFirst({
      where: {
        nickname,
        ...(excludeUserId !== undefined ? { id: { not: excludeUserId } } : {}),
      },
      select: { id: true },
    });
    if (conflict) {
      throw new ConflictException('该昵称已被其他玩家使用，请换一个');
    }
  }

  /**
   * 生成全局唯一昵称：基名被占用时追加 #序号 后缀。
   * 供注册自动去重使用（QQ 昵称天然可重复，注册不能因此被拒绝）。
   */
  async uniquifyNickname(base: string): Promise<string> {
    let candidate = base;
    let seq = 2;
    while (
      await this.prisma.user.findFirst({
        where: { nickname: candidate },
        select: { id: true },
      })
    ) {
      candidate = `${base}#${seq}`;
      seq++;
    }
    return candidate;
  }

  /**
   * 设置/修改游戏昵称
   * 供 QQ 互联首次注册后引导设置昵称，以及用户主动修改昵称使用。
   * 昵称全局唯一（排除自己）：被他人占用时抛 ConflictException。
   * @param userId 用户ID
   * @param nickname 游戏昵称（1-20字符，前后空白会被清理）
   */
  async updateNickname(userId: number, nickname: string) {
    const trimmed = (nickname || '').trim();
    if (!trimmed) {
      throw new BadRequestException('昵称不能为空');
    }
    if (trimmed.length > 20) {
      throw new BadRequestException('昵称最多20个字符');
    }
    const exists = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!exists) {
      throw new NotFoundException('用户不存在');
    }
    await this.assertNicknameUnique(trimmed, userId);
    return this.prisma.user.update({
      where: { id: userId },
      data: { nickname: trimmed },
      select: {
        id: true,
        username: true,
        nickname: true,
        role: true,
        qqNumber: true,
        externalId: true,
        avatar: true,
        createdAt: true,
      },
    });
  }

  /**
   * 解析用户常用指令 JSON 字段为 FavoriteCommand 数组
   * 兼容字段缺失/非法 JSON/字符串元素/对象元素场景，保证返回数组不抛错。
   * （DB favoriteCommands 已是原生 Json 列：读取时直接返回数组，仅字符串形态需解析）
   * 元素去重（按 cmd 去重），保留顺序。
   * @param raw favoriteCommands 原始值（数组 / JSON 字符串 / null）
   */
  private parseFavoriteCommands(raw: unknown): FavoriteCommand[] {
    const arr = asJsonValue<unknown[]>(raw, []);
    const seen = new Set<string>();
    const result: FavoriteCommand[] = [];
    for (const item of arr) {
      const norm = normalizeFavoriteItem(item);
      if (!norm) continue;
      if (seen.has(norm.cmd)) continue;
      seen.add(norm.cmd);
      result.push(norm);
    }
    return result;
  }

  /**
   * 获取当前用户的常用指令列表（已归一化为 {cmd,label}，去重保序）
   * @param userId 用户ID
   * @returns FavoriteCommand 数组
   */
  async getFavoriteCommands(userId: number): Promise<FavoriteCommand[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { favoriteCommands: true },
    });
    if (!user) throw new NotFoundException('用户不存在');
    return this.parseFavoriteCommands(user.favoriteCommands);
  }

  /**
   * 设置（全量覆盖）当前用户的常用指令列表
   * - 元素可为字符串（视为 cmd=label）或 {cmd,label} 对象（兼容前端两种传法）
   * - 去重（按 cmd）、去空白（不限制数量）
   * @param userId 用户ID
   * @param commands 常用指令数组（字符串或对象混合）
   */
  async setFavoriteCommands(userId: number, commands: unknown[]): Promise<FavoriteCommand[]> {
    if (!Array.isArray(commands)) {
      throw new BadRequestException('常用指令必须为数组');
    }
    const seen = new Set<string>();
    const cleaned: FavoriteCommand[] = [];
    for (const item of commands) {
      const norm = normalizeFavoriteItem(item);
      if (!norm) continue;
      if (seen.has(norm.cmd)) continue;
      seen.add(norm.cmd);
      cleaned.push(norm);
    }
    await this.prisma.user.update({
      where: { id: userId },
      // favoriteCommands 为原生 Json 列，直接传对象数组（stringify 会双重编码）；
      // 展开为匿名对象类型以匹配 Prisma InputJsonValue 的索引签名要求
      data: { favoriteCommands: cleaned.map((c) => ({ ...c })) },
    });
    return cleaned;
  }
}
