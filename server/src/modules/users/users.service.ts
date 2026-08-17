/**
 * 用户服务
 * 封装用户账号的查询、QQ绑定、昵称修改、玩家档案创建等数据访问逻辑。
 * 注：登录仅通过 QQ 互联完成，不再提供用户名+密码的自注册/自登录。
 */

import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

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
   * 设置/修改游戏昵称
   * 供 QQ 互联首次注册后引导设置昵称，以及用户主动修改昵称使用。
   * @param userId 用户ID
   * @param nickname 游戏昵称（1-20字符）
   */
  async updateNickname(userId: number, nickname: string) {
    const exists = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!exists) {
      throw new NotFoundException('用户不存在');
    }
    return this.prisma.user.update({
      where: { id: userId },
      data: { nickname },
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
}
