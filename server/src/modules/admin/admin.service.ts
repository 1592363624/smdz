/**
 * 管理员服务
 * 封装用户管理(角色/封禁)、系统配置管理以及游戏管理(公告/世界等级/GM指令)的数据访问逻辑。
 * 对应原版易语言：管理操作.ecode
 */

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlayerService } from '../game/player.service';
import { ChatService } from '../chat/chat.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { StaticDataService } from '../game/static-data.service';
import { StatsService } from '../game/stats.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  /** 服务器启动时间戳，用于计算 uptime */
  private readonly startTime: number = Date.now();

  /** GM 编辑弹窗允许修改的玩家字段白名单（基础属性 + 战斗属性 + 位置） */
  private static readonly EDIT_ALLOWED_FIELDS = [
    'name', 'type', 'level', 'exp', 'upgradeExp',
    'hp', 'maxHp', 'shield', 'maxShield', 'armor', 'maxArmor',
    'attack', 'defense', 'speed', 'dodge', 'hit', 'crit', 'critDmg',
    'regenHp', 'regenShield', 'regenArmor',
    'mapId', 'location', 'houseName', 'affinity', 'vitality', 'masterQQ',
  ];

  /** 白名单中的数值型字段 */
  private static readonly EDIT_NUMERIC_FIELDS = [
    'level', 'exp', 'upgradeExp',
    'hp', 'maxHp', 'shield', 'maxShield', 'armor', 'maxArmor',
    'attack', 'defense', 'speed', 'dodge', 'hit', 'crit', 'critDmg',
    'regenHp', 'regenShield', 'regenArmor',
    'mapId', 'affinity', 'vitality',
  ];

  /** 白名单中以 JSON 字符串存储的结构化字段（编辑时需传对象/数组） */
  private static readonly EDIT_JSON_FIELDS: string[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerService: PlayerService,
    private readonly chatService: ChatService,
    private readonly systemConfigService: SystemConfigService,
    private readonly staticData: StaticDataService,
    private readonly statsService: StatsService,
  ) {}

  /**
   * 分页查询用户列表
   * 关联玩家档案，附带等级/角色名/位置/在线状态/在线时长/最后登录等扩展信息
   * 支持按指定字段排序与自定义分页大小。
   *
   * @param page 当前页码（从1开始）
   * @param pageSize 每页条数
   * @param keyword 搜索关键词（用户名/昵称/QQ）
   * @param sortField 排序字段（白名单内）
   * @param sortOrder 排序方向：asc 或 desc
   */
  async listUsers(
    page = 1,
    pageSize = 20,
    keyword?: string,
    sortField?: string,
    sortOrder: Prisma.SortOrder = 'asc',
  ) {
    // 分页大小限制在合理范围，防止恶意大查询拖慢服务
    const safePageSize = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
    const where = keyword
      ? {
          OR: [
            { username: { contains: keyword } },
            { nickname: { contains: keyword } },
            { qqNumber: { contains: keyword } },
          ],
        }
      : {};

    // 允许的排序字段白名单，避免 Prisma orderBy 注入
    const orderBy = this.buildUserListOrderBy(sortField, sortOrder);

    const [total, list] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          nickname: true,
          qqNumber: true,
          externalId: true,
          role: true,
          status: true,
          avatar: true,
          createdAt: true,
          lastLoginAt: true,
          loginCount: true,
          player: {
            select: {
              level: true,
              name: true,
              type: true,
              hp: true,
              maxHp: true,
              mapId: true,
              location: true,
              affinity: true,
              playTime: true,
              lastOpTime: true,
            },
          },
        },
        orderBy,
        skip: (page - 1) * safePageSize,
        take: safePageSize,
      }),
    ]);

    // 在线判定与聊天页侧栏一致：以 StatsService 的 WebSocket 在线集合为准。
    // 原按 updatedAt 近5分钟估算会把后台自动保存等写库误判为在线。
    const now = Date.now();
    const enriched = list.map((u) => {
      const p = u.player as any;
      return {
        ...u,
        online: this.statsService.isOnline(u.id),
        // BigInt 不能直接 JSON 序列化，统一转数值秒
        playTimeSeconds: p?.playTime != null ? Number(p.playTime) : 0,
        player: p
          ? {
              ...p,
              playTime: undefined,
              lastOpTime: p.lastOpTime != null ? Number(p.lastOpTime) : 0,
            }
          : null,
        _now: now,
      };
    });
    return { total, list: enriched, page, pageSize: safePageSize };
  }

  /**
   * 构造用户列表的 orderBy 条件
   * 仅允许白名单内的字段，防止通过 sortField 注入非法 Prisma 查询。
   * 玩家相关字段通过关联表排序。
   */
  private buildUserListOrderBy(
    sortField?: string,
    sortOrder: Prisma.SortOrder = 'asc',
  ): Prisma.UserOrderByWithRelationInput {
    const order = sortOrder === 'desc' ? 'desc' : 'asc';
    const field = sortField || 'id';

    const map: Record<string, Prisma.UserOrderByWithRelationInput> = {
      id: { id: order },
      username: { username: order },
      nickname: { nickname: order },
      role: { role: order },
      status: { status: order },
      createdAt: { createdAt: order },
      lastLoginAt: { lastLoginAt: order },
      loginCount: { loginCount: order },
      level: { player: { level: order } },
      playerName: { player: { name: order } },
      location: { player: { location: order } },
      affinity: { player: { affinity: order } },
    };

    return map[field] ?? { id: 'asc' };
  }

  /**
   * 获取单个用户的详细信息（含完整玩家档案摘要）
   * GM 用户管理的"详情/编辑"弹窗使用
   */
  async getUserDetail(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        nickname: true,
        qqNumber: true,
        externalId: true,
        role: true,
        status: true,
        avatar: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
        loginCount: true,
        player: true,
      },
    });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    // 在线判定与聊天页侧栏一致：以 StatsService 的 WebSocket 在线集合为准
    const p = user.player as any;
    const detail: any = { ...user, online: this.statsService.isOnline(user.id) };
    if (p) {
      // JSON 字符串字段解析为结构化数据（解析失败保留原样），BigInt 转数值
      for (const key of ['backpack', 'equipment', 'weapons', 'tasks', 'titles', 'skills', 'buffs']) {
        try {
          p[key] = JSON.parse(p[key] ?? 'null');
        } catch {
          /* 保持原字符串 */
        }
      }
      p.playTimeSeconds = p.playTime != null ? Number(p.playTime) : 0;
      p.playTime = undefined;
      p.lastOpTime = p.lastOpTime != null ? Number(p.lastOpTime) : 0;
      p.readTime = p.readTime != null ? Number(p.readTime) : 0;
    }
    return detail;
  }

  /**
   * 批量编辑玩家游戏数据（GM 用户管理"编辑"弹窗）
   * 仅更新传入的字段；数值字段校验，JSON 结构字段需传对象/数组。
   * @param operatorId 操作者ID（仅日志）
   * @param userId 目标用户ID
   * @param data 待更新字段
   */
  async editPlayerData(operatorId: number, userId: number, data: Record<string, any>): Promise<string> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new BadRequestException('请提供要修改的字段');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');

    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) throw new NotFoundException('该用户还没有创建游戏角色');

    const updateData: any = {};
    for (const [field, rawValue] of Object.entries(data)) {
      if (!AdminService.EDIT_ALLOWED_FIELDS.includes(field)) {
        throw new BadRequestException(`不允许修改字段「${field}」`);
      }
      if (AdminService.EDIT_JSON_FIELDS.includes(field)) {
        // 结构化字段：序列化存储，非法 JSON 直接拒绝
        try {
          updateData[field] = JSON.stringify(rawValue);
        } catch {
          throw new BadRequestException(`字段「${field}」不是合法的结构化数据`);
        }
      } else if (AdminService.EDIT_NUMERIC_FIELDS.includes(field)) {
        const num = parseFloat(rawValue);
        if (isNaN(num)) throw new BadRequestException(`字段「${field}」需要数值类型`);
        updateData[field] = num;
      } else {
        updateData[field] = String(rawValue ?? '');
      }
    }
    if (Object.keys(updateData).length === 0) {
      throw new BadRequestException('没有可更新的字段');
    }
    // GM 改名：写入改名基础名 baseName（原版 玩家.图片）。显示名 name 是
    // baseName+[佩戴称号] 的派生结果，直接改 name 会在下次保存时被派生覆盖。
    if (updateData.name !== undefined) {
      updateData.baseName = updateData.name;
      delete updateData.name;
    }

    await this.playerService.enqueueUserWrite(player.userId, async () => {
      const _pd = await this.playerService.getPlayerData(player.userId);
      Object.assign(_pd.player, updateData);
      await this.playerService.savePlayer(_pd.player);
    });
    this.logger.log(
      `管理员 ${operatorId} 编辑了用户 ${userId}(${user.username}) 的玩家数据: ${Object.keys(updateData).join(', ')}`,
    );
    // UI 同步：上方 update 落库后由 Prisma 拦截器自动推送该玩家面板（GM 改动即时生效）
    return `已保存对玩家 ${player.name || user.username} 的修改（${Object.keys(updateData).length} 个字段）`;
  }

  /**
   * 更新用户角色/状态/昵称/QQ号
   * @param id 用户ID
   * @param data 待更新字段（仅更新传入的字段）
   */
  async updateUser(
    id: number,
    data: { role?: string; status?: string; nickname?: string; qqNumber?: string },
  ) {
    const exists = await this.prisma.user.findUnique({ where: { id } });
    if (!exists) {
      throw new NotFoundException('用户不存在');
    }

    // 组装更新字段：仅更新显式传入的字段，避免误覆盖
    const updateData: any = {};
    if (data.role !== undefined) updateData.role = data.role;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.nickname !== undefined) {
      const trimmed = String(data.nickname).trim();
      updateData.nickname = trimmed;
      // 昵称全局唯一（排除自己）：非空昵称不能与其他玩家重复
      if (trimmed) {
        const conflict = await this.prisma.user.findFirst({
          where: { nickname: trimmed, id: { not: id } },
          select: { id: true },
        });
        if (conflict) {
          throw new BadRequestException('该昵称已被其他玩家使用');
        }
      }
    }
    if (data.qqNumber !== undefined) {
      // 空字符串表示解绑 QQ
      updateData.qqNumber = data.qqNumber === '' ? null : data.qqNumber;
      // 兼容旧版绑定：原 qqNumber 是 openid（非5-12位纯数字）时，迁移到 externalId，
      // 避免后续 QQ 登录识别不到原账号
      if (updateData.qqNumber !== null && exists.qqNumber && !/^\d{5,12}$/.test(exists.qqNumber)) {
        if (!exists.externalId) {
          updateData.externalId = exists.qqNumber;
        }
      }
    }

    // QQ 号唯一性检查（修改时可能与其他账号冲突）
    if (updateData.qqNumber !== undefined && updateData.qqNumber !== null) {
      const conflict = await this.prisma.user.findUnique({
        where: { qqNumber: updateData.qqNumber },
      });
      if (conflict && conflict.id !== id) {
        throw new BadRequestException('该QQ号已被其他账号绑定');
      }
    }

    return this.prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        username: true,
        nickname: true,
        role: true,
        status: true,
        qqNumber: true,
      },
    });
  }

  /**
   * 删除用户（级联删除其玩家档案、绑定关系；聊天记录发送人置空）
   * 出于安全考虑，不允许删除自己，也不允许删除 SUPER_ADMIN。
   * @param operatorId 操作者用户ID
   * @param targetId 目标用户ID
   */
  async deleteUser(operatorId: number, targetId: number): Promise<string> {
    if (operatorId === targetId) {
      throw new BadRequestException('不能删除当前登录的管理员账号');
    }
    const exists = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!exists) {
      throw new NotFoundException('用户不存在');
    }
    if (exists.role === 'SUPER_ADMIN') {
      throw new BadRequestException('不能删除超级管理员账号');
    }
    // 级联删除：Player / UserBinding 为 onDelete: Cascade，ChatMessage 发送人置空
    await this.prisma.user.delete({ where: { id: targetId } });
    this.logger.log(`管理员 ${operatorId} 删除了用户 ${targetId} (${exists.username})`);
    return `已删除用户 ${exists.username}`;
  }

  /**
   * 批量删除用户账号（级联删除其玩家档案、绑定关系）
   * 与 deleteUser 相同的安全规则：跳过操作者自己和超级管理员，单个失败不影响其余。
   * @param operatorId 操作者用户ID
   * @param ids 目标用户ID列表
   * @returns 操作结果文本（含成功/跳过/失败明细）
   */
  async batchDeleteUsers(operatorId: number, ids: number[]): Promise<string> {
    const idList = [...new Set((ids ?? []).map(Number).filter((id) => Number.isFinite(id)))];
    if (idList.length === 0) {
      throw new BadRequestException('请至少选择一个用户');
    }

    const ok: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    for (const id of idList) {
      try {
        ok.push(await this.deleteUser(operatorId, id));
      } catch (e) {
        // 自己/超管等保护性拦截与真实失败都要如实反馈
        const msg = e?.response?.message ?? e?.message ?? String(e);
        const isProtected = e instanceof BadRequestException;
        (isProtected ? skipped : failed).push(`用户 ${id}：${msg}`);
      }
    }

    const lines = [`批量删除完成：成功 ${ok.length}/${idList.length}`];
    if (skipped.length) lines.push(`跳过：\n${skipped.join('\n')}`);
    if (failed.length) lines.push(`失败：\n${failed.join('\n')}`);
    this.logger.log(`管理员 ${operatorId} 批量删除用户：成功 ${ok.length}，跳过 ${skipped.length}，失败 ${failed.length}`);
    return lines.join('\n');
  }

  /**
   * 批量清空用户游戏数据（保留账号）
   * 复用 resetPlayerData，单个失败不影响其余。
   * @param ids 目标用户ID列表
   * @returns 操作结果文本（含成功/失败明细）
   */
  async batchResetPlayerData(ids: number[]): Promise<string> {
    const idList = [...new Set((ids ?? []).map(Number).filter((id) => Number.isFinite(id)))];
    if (idList.length === 0) {
      throw new BadRequestException('请至少选择一个用户');
    }

    const ok: string[] = [];
    const failed: string[] = [];
    for (const id of idList) {
      try {
        ok.push(await this.resetPlayerData(id));
      } catch (e) {
        const msg = e?.response?.message ?? e?.message ?? String(e);
        failed.push(`用户 ${id}：${msg}`);
      }
    }

    const lines = [`批量清空完成：成功 ${ok.length}/${idList.length}`];
    if (failed.length) lines.push(`失败：\n${failed.join('\n')}`);
    this.logger.log(`批量清空玩家数据：成功 ${ok.length}，失败 ${failed.length}`);
    return lines.join('\n');
  }

  /**
   * 一键清空全部玩家的游戏数据（保留所有账号）
   * 遍历 Player 表全部记录，逐个走 resetPlayerData（含 per-user 串行邮箱写入）。
   * @returns 操作结果文本
   */
  async resetAllPlayerData(): Promise<string> {
    const players = await this.prisma.player.findMany({ select: { userId: true } });
    if (players.length === 0) {
      return '当前没有任何玩家记录，无需清理';
    }

    const ok: string[] = [];
    const failed: string[] = [];
    for (const { userId } of players) {
      try {
        ok.push(await this.resetPlayerData(userId));
      } catch (e) {
        const msg = e?.response?.message ?? e?.message ?? String(e);
        failed.push(`用户 ${userId}：${msg}`);
      }
    }

    const lines = [
      `已清空全部玩家数据：成功 ${ok.length}/${players.length}（所有账号均已保留）`,
    ];
    if (failed.length) lines.push(`失败：\n${failed.join('\n')}`);
    this.logger.log(`一键清空全部玩家数据：成功 ${ok.length}/${players.length}，失败 ${failed.length}`);
    return lines.join('\n');
  }

  /**
   * 清理（重置）指定用户的游戏数据，但保留账号
   * 将玩家所有游戏进度重置为"未开始游玩"的初始状态（等同新建玩家首次进入），
   * 与 PlayerService.getOrCreatePlayer 的初始化逻辑保持一致。
   * 不删除 user，仅重置 Player 行的游戏字段。
   * @returns 操作结果文本
   */
  async resetPlayerData(userId: number): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) {
      return `账号 ${user.username} 尚无玩家记录，无需清理`;
    }

    // 初始背包（与新玩家一致，全部为原版道具：布装备+石制工具）
    const initialBackpack = [
      { name: '石制工具', type: '装备', quantity: 1, durability: 0, data: 'e' },
      { name: '布帽', type: '装备', quantity: 1, durability: 0, data: 'e' },
      { name: '布衣', type: '装备', quantity: 1, durability: 0, data: 'e' },
    ];
    const initialWeapons = [{ name: '石制工具', type: '武器', slot: 1, quantity: 1, durability: 0, data: 'e' }];
    const initialEquipment = [{ name: '布衣', type: '装备', slot: '身体', quantity: 1, durability: 0, data: 'e' }];

    // 初始任务：新手教程（从静态数据读取，避免硬编码，与 getOrCreatePlayer 一致）
    let initialTasks: Array<{ name: string; requirements: Array<{ name: string; count: number }> }> = [];
    const tutorialTask = this.staticData.getTaskByName('新手教程');
    if (tutorialTask) {
      const reqs = this.playerService.safeJsonParse<Array<{ name: string; count: number }>>(
        tutorialTask.requirements, [],
      );
      if (reqs.length > 0) {
        initialTasks.push({ name: '新手教程', requirements: JSON.parse(JSON.stringify(reqs)) });
      }
    }

    // 起始地图（第一个可用地图）
    const startMap = await this.prisma.gameMap.findFirst({ orderBy: { mapIndex: 'asc' } });
    const startMapId = startMap?.id ?? 1;
    const startMapName = startMap?.name ?? '';

    // 重置所有游戏进度字段（保留 id / userId / 账号）
    await this.playerService.enqueueUserWrite(player.userId, async () => {
      const _pd = await this.playerService.getPlayerData(player.userId);
      Object.assign(_pd.player, {
        level: 1,
        exp: 0,
        upgradeExp: 100,
        name: '冒险者',
        type: '',
        specialSeq: 0,
        hp: 100,
        maxHp: 100,
        shield: 0,
        maxShield: 0,
        armor: 0,
        maxArmor: 0,
        attack: 10,
        defense: 0,
        speed: 100,
        dodge: 0,
        hit: 100,
        crit: 5,
        critDmg: 150,
        regenHp: 0,
        regenShield: 0,
        regenArmor: 0,
        mapId: startMapId,
        location: startMapName,
        houseName: '',
        backpack: JSON.stringify(initialBackpack),
        equipment: JSON.stringify(initialEquipment),
        weapons: JSON.stringify(initialWeapons),
        currentWeapon: 0,
        markers: JSON.stringify({ '指引': 0, '活力2': 100, '使用活力': 0 }),
        markers2: '[]',
        buffs: '[]',
        tasks: JSON.stringify(initialTasks),
        titles: JSON.stringify([{ name: '新人', equipped: false }]),
        skills: '{}',
        sets: '{}',
        bonus: '{}',
        baseBonus: '{}',
        vehicle: '',
        safeBox: '[]',
        equipmentPresets: '[]',
        reverse: '[]',
        recipes: '[]',
        stats: '{}',
        affinity: 0,
        masterQQ: '',
        vitality: 0,
        lastOpTime: BigInt(0),
        readTime: BigInt(0),
        playTime: BigInt(0),
      });
      await this.playerService.savePlayer(_pd.player);
    });

    this.logger.log(`管理员清空了用户 ${userId} (${user.username}) 的游戏数据`);
    return `已清空账号 ${user.username} 的游戏数据，可重新登录后重新选择使魔开始` ;
  }

  /**
   * 获取服务器状态
   * 统计用户数、玩家数、在线玩家数（暂取有活跃标记的玩家）、地图数、指令数、
   * 怪物种类数、物品种类数及运行时长
   */
  async getServerStatus(): Promise<{
    totalUsers: number;
    totalPlayers: number;
    onlinePlayers: number;
    totalMaps: number;
    totalCommands: number;
    totalMonsters: number;
    totalItems: number;
    uptime: number;
  }> {
    const [totalUsers, totalPlayers, totalMaps, totalCommands] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.player.count(),
      this.prisma.gameMap.count(),
      this.prisma.command.count(),
    ]);
    // 怪物/物品种类数：从静态配置 JSON 统计（固定配置已 JSON 化，以 JSON 为单一来源）
    const totalMonsters = this.staticData.getAllMonsters().length;
    const totalItems = this.staticData.getAllItems().length;

    // 在线玩家：与聊天页侧栏统计(/game/stats)共用 StatsService 的 WebSocket 在线集合，
    // 保证两处数字一致。原实现按 player.updatedAt 近5分钟有更新估算，
    // 但后台自动保存/活力恢复等任何写库都会刷新 updatedAt，导致离线玩家被误判在线。
    const onlinePlayers = this.statsService.getOnlineCount();

    return {
      totalUsers,
      totalPlayers,
      onlinePlayers,
      totalMaps,
      totalCommands,
      totalMonsters,
      totalItems,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  /**
   * 发送系统公告
   * 向世界频道写入一条系统消息（持久化留档），
   * 并实时推送 announcement:new 事件，所有在线玩家客户端弹出公告弹窗
   */
  async sendAnnouncement(content: string): Promise<void> {
    const channel = await this.chatService.ensureDefaultChannel();
    const msg = await this.chatService.saveMessage({
      channelId: channel.id,
      type: 'system',
      content: `【系统公告】${content}`,
    });
    // 实时推送公告弹窗事件（前端强制展示 5 秒、手动点 X 关闭后才算已读）
    this.chatService.emitToChannel(channel.name, 'announcement:new', {
      id: msg.id,
      content,
      createdAt: msg.createdAt,
    });
    this.logger.log(`系统公告已发送: ${content}`);
  }

  /**
   * 设置世界等级
   * 写入系统配置 game.worldLevel，影响怪物强度和掉落
   * @returns 更新后的世界等级文本
   */
  async setWorldLevel(level: number): Promise<string> {
    await this.systemConfigService.set('game.worldLevel', level);
    this.logger.log(`世界等级已设置为 ${level}`);
    return `世界等级已设置为 ${level}`;
  }

  /**
   * 获取系统配置列表
   * @param group 按分组筛选，不传则返回所有
   */
  async getSystemConfigs(group?: string): Promise<any[]> {
    const where = group ? { group } : {};
    return this.prisma.systemConfig.findMany({
      where,
      orderBy: { id: 'asc' },
    });
  }

  /**
   * 更新系统配置
   * @returns 操作结果文本
   */
  async updateSystemConfig(key: string, value: string): Promise<string> {
    await this.systemConfigService.set(key, value);
    this.logger.log(`系统配置已更新: ${key}=${value}`);
    return `配置项 ${key} 已更新`;
  }

  /**
   * 获取玩家列表（管理员用）
   * 关联用户信息，分页返回
   */
  async getPlayersList(
    page: number,
    pageSize: number,
  ): Promise<{ total: number; players: any[] }> {
    const [total, players] = await Promise.all([
      this.prisma.player.count(),
      this.prisma.player.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { id: 'asc' },
        include: {
          user: {
            select: { id: true, username: true, nickname: true, qqNumber: true },
          },
        },
      }),
    ]);
    return { total, players };
  }

  /**
   * 封禁/解封用户
   * 切换用户 status 字段：ACTIVE ↔ BANNED
   * @returns 操作结果文本
   */
  async toggleUserBan(userId: number): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    const newStatus = user.status === 'BANNED' ? 'ACTIVE' : 'BANNED';
    await this.prisma.user.update({
      where: { id: userId },
      data: { status: newStatus },
    });
    this.logger.log(`用户 ${userId} 状态已切换为 ${newStatus}`);
    return newStatus === 'BANNED' ? `用户 ${user.username} 已封禁` : `用户 ${user.username} 已解封`;
  }

  /**
   * 解析 GM 操作的目标用户
   * 兼容三种指定方式：数字用户ID / 用户名 / QQ号
   * @param target 用户ID(数字或纯数字字符串)、用户名或QQ号
   * @returns 用户记录
   */
  async resolveUserTarget(target: string | number) {
    if (target === undefined || target === null || `${target}`.trim() === '') {
      throw new BadRequestException('请指定目标玩家');
    }
    const raw = `${target}`.trim();
    let user: any = null;
    if (/^\d{1,10}$/.test(raw)) {
      // 纯数字优先按用户ID查找，其次按QQ号
      user =
        (await this.prisma.user.findUnique({ where: { id: Number(raw) } })) ||
        (await this.prisma.user.findUnique({ where: { qqNumber: raw } }));
    } else {
      user = await this.prisma.user.findFirst({
        where: { OR: [{ username: raw }, { nickname: raw }] },
      });
    }
    if (!user) {
      throw new NotFoundException(`未找到玩家「${raw}」`);
    }
    return user;
  }

  /**
   * 给玩家发送物品（GM命令）
   * 调用 PlayerService 向玩家背包中添加物品
   * @param operatorId 操作者用户ID（可选；提供时发放成功后向目标玩家私聊推送本次操作与物品明细）
   * @returns 操作结果文本
   */
  async gmGiveItem(
    userId: number,
    itemName: string,
    count: number,
    operatorId?: number,
  ): Promise<string> {
    const success = await this.playerService.addToBackpack(userId, itemName, count);
    if (!success) {
      throw new Error('物品发送失败，请检查用户ID和物品名称');
    }
    this.logger.log(`GM 给用户 ${userId} 发放了 ${count} 个 ${itemName}`);
    // 发放成功后给目标玩家私聊推送本次发放信息
    await this.sendGrantNotice(operatorId, userId, [{ itemName, count }]);
    return `已向用户 ${userId} 发放 ${count} 个 ${itemName}`;
  }

  /**
   * GM 按目标标识发放物品（后台网页用）
   * @param target 用户名/昵称/QQ号/用户ID
   * @param operatorId 操作者用户ID（可选，用于发放后的私聊通知）
   */
  async gmGiveItemToTarget(
    target: string | number,
    itemName: string,
    count: number,
    operatorId?: number,
  ): Promise<string> {
    const user = await this.resolveUserTarget(target);
    return this.gmGiveItem(user.id, itemName, count, operatorId);
  }

  /**
   * 读取指定玩家的背包物品列表（解析 JSON 数组）
   * 供 GM 后台"背包管理"使用：把背包里所有物品完整解析出来，供前端编辑/增删。
   * @param userId 目标用户ID
   * @returns 背包物品数组（每条含 name/count/quantity/type/durability/data 等原始字段）
   */
  async gmGetBackpack(userId: number): Promise<any[]> {
    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) {
      throw new NotFoundException('该用户还没有创建游戏角色');
    }
    return this.playerService.getBackpackItems(player);
  }

  /**
   * 整体保存玩家背包（GM 后台"背包管理"）
   * 前端把编辑/增/删后的完整物品数组传回，服务端做名称与数量校验后整体写回。
   * 相同名称条目自动合并数量；数量为 0 的条目视为删除。
   * 写入走 per-user 串行邮箱，与玩家自身操作无并发冲突。
   * @param userId 目标用户ID
   * @param items 背包物品数组（{ name, quantity/count, type?, durability?, data? }）
   * @returns 操作结果文本
   */
  async gmSaveBackpack(
    userId: number,
    items: any[],
  ): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');

    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) throw new NotFoundException('该用户还没有创建游戏角色');

    if (!Array.isArray(items)) {
      throw new BadRequestException('背包数据必须是数组');
    }

    // 归一化：① 同名合并数量 ② 统一写入 count、清理量歧义字段 quantity
    // ③ 保留首次出现的 type/durability/data 等原字段 ④ 数量<=0 视为删除
    const merged = new Map<string, any>();
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const name = String(raw.name ?? '').trim();
      if (!name) continue;
      // 数量允许小数（掉落经 rewardMultiplier 放大后可能产生小数），不做取整以免改数值
      const qty = Number(raw.quantity ?? raw.count ?? 1);
      if (!Number.isFinite(qty) || qty < 0) {
        throw new BadRequestException(`物品「${name}」的数量必须是非负数字`);
      }
      const existed = merged.get(name);
      if (existed) {
        existed.count = Number(existed.count ?? 0) + qty;
      } else {
        // 构造标准条目：去 quantity 歧义字段，保留其余投影白名单字段与额外字段
        const item: any = { name, count: qty };
        for (const k of ['type', 'durability', 'data', 'slot']) {
          if (raw[k] !== undefined && raw[k] !== null) item[k] = raw[k];
        }
        // 保留自定义/未知字段（如装备附魔等前端可能透传的字段）
        for (const [k, v] of Object.entries(raw)) {
          if (!(k in item) && k !== 'quantity') item[k] = v;
        }
        merged.set(name, item);
      }
    }
    // 删除数量<=0 的条目（即前端删除操作的结果）
    const backpack = [...merged.values()].filter((i) => (i.count ?? 0) > 0);

    // 写入走用户串行邮箱，避免与玩家其他写操作并发覆盖
    await this.playerService.enqueueUserWrite(userId, async () => {
      const _pd = await this.playerService.getPlayerData(userId);
      Object.assign(_pd.player, { backpack: JSON.stringify(backpack) });
      await this.playerService.savePlayer(_pd.player);
    });
    this.logger.log(`GM 保存了用户 ${userId} (${user.username}) 的背包：${backpack.length} 种物品`);

    // UI 同步：上方 update 落库后由 Prisma 拦截器自动推送该玩家面板（GM 改动即时生效）
    return `已保存 ${user.username} 的背包（${backpack.length} 种物品）`;
  }

  /**
   * GM 可发放物品目录：items.json(物品) + equipments.json(装备)，按名称去重。
   * 供后台"发放物品"选择器与名称校验使用，保证发放名称一定存在于游戏物品库。
   */
  getGmItemCatalog(): Array<{ name: string; category: string }> {
    const catalog: Array<{ name: string; category: string }> = [];
    const seen = new Set<string>();
    for (const [rows, category] of [
      [this.staticData.getAllItems(), '物品'],
      [this.staticData.getAllEquipments(), '装备'],
    ] as const) {
      for (const row of rows as any[]) {
        const name = String(row?.name ?? '').trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        catalog.push({ name, category });
      }
    }
    return catalog;
  }

  /**
   * GM 批量给玩家发放多种物品（后台网页用，按用户ID定位）
   * 名称先按目录校验，防止手输错误名称产生无效物品。
   * @param userId 目标用户ID
   * @param items 物品列表 [{ itemName, count }]
   * @param operatorId 操作者用户ID（可选；提供时发放成功后向目标玩家私聊推送本次操作与物品明细）
   */
  async gmGiveItemBatch(
    userId: number,
    items: Array<{ itemName: string; count?: number }>,
    operatorId?: number,
  ): Promise<string> {
    const validNames = new Set(this.getGmItemCatalog().map((i) => i.name));
    const invalid = items
      .map((i) => String(i?.itemName ?? '').trim())
      .filter((name) => name && !validNames.has(name));
    if (invalid.length) {
      throw new BadRequestException(`以下物品不存在，请从列表中选择：${invalid.join('、')}`);
    }

    const granted: string[] = [];
    for (const item of items) {
      const name = String(item.itemName).trim();
      const count = Math.max(1, Math.floor(Number(item.count) || 1));
      const ok = await this.playerService.addToBackpack(userId, name, count);
      if (!ok) {
        throw new Error(`物品「${name}」发放失败`);
      }
      granted.push(`${name}×${count}`);
    }
    this.logger.log(`GM 给用户 ${userId} 批量发放：${granted.join(', ')}`);
    // 发放成功后给目标玩家私聊推送本次发放信息
    await this.sendGrantNotice(operatorId, userId, items);
    return `已向用户 ${userId} 发放 ${granted.join('、')}`;
  }

  /**
   * GM 发放成功后向目标玩家私聊推送本次操作与详细物品信息
   * 发送者=操作者(GM)，接收者=目标玩家；仅当有操作者且非发放给自己时发送。
   * 私聊推送失败不影响发放主链路（发放已成功落库）。
   * @param operatorId 操作者用户ID（无则跳过）
   * @param targetUserId 目标玩家用户ID
   * @param granted 本次发放的物品列表 [{ itemName, count }]
   */
  private async sendGrantNotice(
    operatorId: number | undefined,
    targetUserId: number,
    granted: Array<{ itemName: string; count?: number }>,
  ): Promise<void> {
    // 非 HTTP 调用（如游戏内指令）没有操作者，或发放给操作者自己时不发私聊
    if (!operatorId || operatorId === targetUserId || !granted?.length) return;
    try {
      const lines: string[] = [];
      for (const g of granted) {
        const name = String(g?.itemName ?? '').trim();
        const count = Math.max(1, Math.floor(Number(g?.count) || 1));
        if (!name) continue;
        // 取详细信息（物品/装备），拼装"名称 ×数量（类型）+ 描述"
        const detail =
          this.staticData.getItemByName(name) || this.staticData.getEquipmentByName(name);
        const type = String(detail?.type ?? detail?.equipType ?? '物品');
        const desc = String(detail?.description ?? '').trim();
        lines.push(`· ${name} ×${count}（${type}）${desc ? `#换行　${desc}` : ''}`);
      }
      if (!lines.length) return;
      const content = [
        '📦【GM 发放通知】',
        `运营团队已向你的背包发放 ${lines.length} 种物品：`,
        ...lines,
        '请注意查收！',
      ].join('#换行');
      // 发送者为操作者(账号即表现为 GM)，接收者为目标玩家
      await this.chatService.sendPrivateMessage(operatorId, targetUserId, content);
      this.logger.log(`GM(${operatorId}) 向用户 ${targetUserId} 私聊推送发放通知`);
    } catch (e: any) {
      // 私聊通知失败（如收发方异常）不影响发放主链路，仅记录日志
      this.logger.warn(`GM 发放私聊通知失败: ${e?.message}`);
    }
  }

  /** GM 可修改的玩家字段白名单 */
  private static readonly MODIFY_ALLOWED_FIELDS = [
    'level', 'exp', 'name', 'hp', 'maxHp', 'shield', 'maxShield',
    'armor', 'maxArmor', 'attack', 'defense', 'speed', 'dodge',
    'hit', 'crit', 'critDmg', 'affinity', 'mapId', 'location',
  ];

  /** 数值型可修改字段（其余白名单字段按字符串写入） */
  private static readonly MODIFY_NUMERIC_FIELDS = [
    'level', 'exp', 'hp', 'maxHp', 'shield', 'maxShield',
    'armor', 'maxArmor', 'attack', 'defense', 'speed', 'dodge',
    'hit', 'crit', 'critDmg', 'affinity', 'mapId',
  ];

  /**
   * GM 修改玩家属性（后台网页用，按用户ID定位）
   * @param operatorId 操作者用户ID（仅日志）
   * @param userId 目标用户ID
   * @param field 属性字段（白名单内）
   * @param value 新值（数值字段自动转换并校验）
   */
  async gmModifyPlayer(operatorId: number, userId: number, field: string, value: string): Promise<string> {
    if (!AdminService.MODIFY_ALLOWED_FIELDS.includes(field)) {
      throw new BadRequestException(
        `不允许修改字段「${field}」，可修改字段: ${AdminService.MODIFY_ALLOWED_FIELDS.join(', ')}`,
      );
    }

    const player = await this.prisma.player.findUnique({ where: { userId } });
    if (!player) {
      throw new NotFoundException('该用户还没有创建游戏角色');
    }

    let parsedValue: any = value;
    if (AdminService.MODIFY_NUMERIC_FIELDS.includes(field)) {
      parsedValue = parseFloat(value);
      if (isNaN(parsedValue)) {
        throw new BadRequestException(`字段「${field}」需要数值类型`);
      }
    }

    await this.playerService.enqueueUserWrite(player.userId, async () => {
      const _pd = await this.playerService.getPlayerData(player.userId);
      Object.assign(_pd.player, { [field]: parsedValue });
      await this.playerService.savePlayer(_pd.player);
    });

    this.logger.log(`管理员 ${operatorId} 修改了用户 ${userId} 的 ${field}=${parsedValue}`);
    return `✅ 已将用户 ${userId}(${player.name}) 的 ${field} 修改为 ${parsedValue}`;
  }

  // ========== 新增管理命令 ==========

  /**
   * 设置间隔消息
   * 定时向频道发送消息，支持设置消息内容、间隔时间（秒）、发送次数
   * 数据存储在 SystemConfig 中，key: "admin.intervalMessage"
   * 对应原版：间隔消息()
   * @param userId 操作者用户ID
   * @param content 消息内容
   * @param interval 间隔时间（秒）
   * @param count 发送次数
   */
  async setIntervalMessage(userId: number, content: string, interval: number, count: number): Promise<string> {
    // 参数校验
    if (!content) {
      throw new BadRequestException('消息内容不能为空');
    }
    if (interval < 1) {
      throw new BadRequestException('间隔时间必须大于0秒');
    }
    if (count < 1 || count > 100) {
      throw new BadRequestException('发送次数必须在1-100之间');
    }

    // 存储间隔消息配置到 SystemConfig
    const configValue = JSON.stringify({
      content,
      interval,
      count,
      creator: userId,
      createdAt: Date.now(),
    });
    await this.systemConfigService.set('admin.intervalMessage', configValue);

    this.logger.log(`管理员 ${userId} 设置了间隔消息: 内容="${content}", 间隔=${interval}秒, 次数=${count}`);

    return `✅ 间隔消息已设置\n━━━━━━━━━━━━━━━\n内容: ${content}\n间隔: ${interval}秒\n次数: ${count}次\n\n消息将自动发送到世界频道，请确保机器人有发送权限。`;
  }

  /**
   * 封禁玩家（按QQ号）
   * 封禁指定QQ的玩家，禁止登录和游戏操作
   * 对应原版：封禁操作
   * @param userId 操作者用户ID
   * @param targetQQ 目标QQ号
   */
  async banPlayer(userId: number, targetQQ: string): Promise<string> {
    // 查找目标用户
    const targetUser = await this.prisma.user.findUnique({
      where: { qqNumber: targetQQ },
    });
    if (!targetUser) {
      throw new NotFoundException(`未找到QQ号为 ${targetQQ} 的用户`);
    }

    // 检查是否已封禁
    if (targetUser.status === 'BANNED') {
      return `玩家 ${targetUser.nickname || targetUser.username}(${targetQQ}) 已被封禁`;
    }

    // 执行封禁
    await this.prisma.user.update({
      where: { id: targetUser.id },
      data: { status: 'BANNED' },
    });

    this.logger.log(`管理员 ${userId} 封禁了玩家 ${targetQQ} (${targetUser.username})`);

    return `✅ 已封禁玩家 ${targetUser.nickname || targetUser.username}(${targetQQ})`;
  }

  /**
   * 重置玩家数据
   * 将玩家数据重置到初始状态，保留用户账号
   * 对应原版：重置玩家
   * @param userId 操作者用户ID
   * @param targetQQ 目标QQ号
   */
  async resetPlayer(userId: number, targetQQ: string): Promise<string> {
    // 查找目标用户
    const targetUser = await this.prisma.user.findUnique({
      where: { qqNumber: targetQQ },
    });
    if (!targetUser) {
      throw new NotFoundException(`未找到QQ号为 ${targetQQ} 的用户`);
    }

    // 查找玩家档案
    const player = await this.prisma.player.findUnique({
      where: { userId: targetUser.id },
    });
    if (!player) {
      throw new NotFoundException(`玩家 ${targetQQ} 还没有创建角色`);
    }

    // 重置玩家数据到初始状态（全部为原版道具：布装备+石制工具）
    const initialBackpack = JSON.stringify([
      { name: '石制工具', type: '装备', quantity: 1, durability: 0, data: 'e' },
      { name: '布帽', type: '装备', quantity: 1, durability: 0, data: 'e' },
      { name: '布衣', type: '装备', quantity: 1, durability: 0, data: 'e' },
    ]);
    const initialMarkers = JSON.stringify({ '指引': 0 });
    const initialTitles = JSON.stringify([{ name: '新人', equipped: false }]);

    await this.playerService.enqueueUserWrite(player.userId, async () => {
      const _pd = await this.playerService.getPlayerData(player.userId);
      Object.assign(_pd.player, {
        level: 1,
        exp: 0,
        upgradeExp: this.playerService.calcUpgradeExp(1),
        name: '冒险者',
        type: '',
        hp: 100,
        maxHp: 100,
        shield: 0,
        maxShield: 0,
        armor: 0,
        maxArmor: 0,
        attack: 10,
        defense: 0,
        speed: 100,
        dodge: 0,
        hit: 100,
        crit: 5,
        critDmg: 150,
        vitality: 100,
        mapId: 1,
        location: '新手村',
        backpack: initialBackpack,
        equipment: JSON.stringify([
          { name: '布衣', type: '装备', slot: '身体', quantity: 1, durability: 0, data: 'e' },
        ]),
        weapons: JSON.stringify([
          { name: '石制工具', type: '武器', slot: 1, quantity: 1, durability: 0, data: 'e' },
        ]),
        markers: initialMarkers,
        titles: initialTitles,
        affinity: 0,
        vehicle: '',
        playTime: BigInt(0),
      });
      await this.playerService.savePlayer(_pd.player);
    });

    this.logger.log(`管理员 ${userId} 重置了玩家 ${targetQQ} 的数据`);

    return `✅ 已重置玩家 ${targetUser.nickname || targetUser.username}(${targetQQ}) 的数据到初始状态`;
  }

  /**
   * 修改玩家数据
   * 修改玩家指定字段（如等级、经验、属性等）
   * 对应原版：修改玩家数据
   * @param userId 操作者用户ID
   * @param targetQQ 目标QQ号
   * @param field 要修改的字段名
   * @param value 新的值
   */
  async modifyPlayer(userId: number, targetQQ: string, field: string, value: string): Promise<string> {
    // 可修改的字段白名单（防止随意修改敏感字段）
    const allowedFields = [
      'level', 'exp', 'name', 'hp', 'maxHp', 'shield', 'maxShield',
      'armor', 'maxArmor', 'attack', 'defense', 'speed', 'dodge',
      'hit', 'crit', 'critDmg', 'affinity', 'mapId', 'location',
    ];

    if (!allowedFields.includes(field)) {
      throw new BadRequestException(`不允许修改字段「${field}」，可修改字段: ${allowedFields.join(', ')}`);
    }

    // 查找目标用户
    const targetUser = await this.prisma.user.findUnique({
      where: { qqNumber: targetQQ },
    });
    if (!targetUser) {
      throw new NotFoundException(`未找到QQ号为 ${targetQQ} 的用户`);
    }

    // 查找玩家档案
    const player = await this.prisma.player.findUnique({
      where: { userId: targetUser.id },
    });
    if (!player) {
      throw new NotFoundException(`玩家 ${targetQQ} 还没有创建角色`);
    }

    // 解析并验证值
    let parsedValue: any = value;
    const numericFields = [
      'level', 'exp', 'hp', 'maxHp', 'shield', 'maxShield',
      'armor', 'maxArmor', 'attack', 'defense', 'speed', 'dodge',
      'hit', 'crit', 'critDmg', 'affinity', 'mapId',
    ];
    if (numericFields.includes(field)) {
      parsedValue = parseFloat(value);
      if (isNaN(parsedValue)) {
        throw new BadRequestException(`字段「${field}」需要数值类型`);
      }
    }

    // 执行修改
    await this.playerService.enqueueUserWrite(player.userId, async () => {
      const _pd = await this.playerService.getPlayerData(player.userId);
      Object.assign(_pd.player, { [field]: parsedValue });
      await this.playerService.savePlayer(_pd.player);
    });

    this.logger.log(`管理员 ${userId} 修改了玩家 ${targetQQ} 的 ${field}=${parsedValue}`);

    return `✅ 已修改 ${targetUser.nickname || targetUser.username}(${targetQQ}) 的 ${field} 为 ${parsedValue}`;
  }

  /**
   * 发送全服公告
   * 向世界频道发送系统公告，广播给所有在线玩家
   * 对应原版：发送公告
   * @param userId 操作者用户ID
   * @param message 公告内容
   */
  async broadcast(userId: number, message: string): Promise<string> {
    if (!message) {
      throw new BadRequestException('公告内容不能为空');
    }

    // 使用 sendAnnouncement 发送公告
    await this.sendAnnouncement(message);

    this.logger.log(`管理员 ${userId} 发送了全服公告: ${message}`);

    return `✅ 全服公告已发送\n━━━━━━━━━━━━━━━\n${message}`;
  }
}