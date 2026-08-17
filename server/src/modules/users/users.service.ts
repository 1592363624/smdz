/**
 * 用户服务
 * 封装用户账号的创建、查询、密码校验、QQ绑定等数据访问逻辑。
 */

import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 创建用户
   * @param username 用户名
   * @param password 明文密码（内部做 bcrypt 哈希）
   * @param nickname 昵称
   */
  async createUser(username: string, password: string, nickname?: string) {
    // 用户名唯一性校验
    const exists = await this.prisma.user.findUnique({ where: { username } });
    if (exists) {
      throw new ConflictException('用户名已被注册');
    }
    // 密码加盐哈希（bcrypt 自动生成 salt，cost 默认10）
    const hashed = await bcrypt.hash(password, 10);
    return this.prisma.user.create({
      data: {
        username,
        password: hashed,
        nickname: nickname || username,
      },
      select: { id: true, username: true, nickname: true, role: true, createdAt: true },
    });
  }

  /**
   * 按用户名查询（含密码，用于登录校验）
   */
  findByUsername(username: string) {
    return this.prisma.user.findUnique({ where: { username } });
  }

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
   * 校验密码
   * @param userPassword 数据库中的哈希
   * @param plainPassword 用户输入的明文
   */
  async validatePassword(userPassword: string, plainPassword: string): Promise<boolean> {
    return bcrypt.compare(plainPassword, userPassword);
  }

  /**
   * 绑定 QQ 号到当前用户
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
